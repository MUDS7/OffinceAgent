use std::collections::HashMap;

use rusqlite::{params, Connection};
use serde_json::{Map, Value};
use tauri::State;

use super::{
    collection::{get_or_create_collection, get_qdrant_collection},
    config::QdrantConfig,
    embedding::{
        chunk_content_hash, embed_chunk_text, LOCAL_CHUNK_EMBEDDING_DIMENSIONS,
        LOCAL_CHUNK_EMBEDDING_MODEL,
    },
    model::{QdrantChunkUpsertRequest, QdrantUpsertRequest, QdrantUpsertResult, QdrantVectorPoint},
    payload::{
        normalize_generic_qdrant_point, qdrant_chunk_payload, qdrant_chunk_point_to_vector_point,
    },
};
use crate::storage::{document_index::IndexedChunk, unix_timestamp_seconds, DocumentStore};

pub(crate) async fn upsert_qdrant_vectors(
    state: State<'_, DocumentStore>,
    request: QdrantUpsertRequest,
) -> Result<QdrantUpsertResult, String> {
    let points = request
        .points
        .into_iter()
        .map(normalize_generic_qdrant_point)
        .collect::<Result<Vec<_>, _>>()?;
    upsert_qdrant_points(&state, request.collection, points)
}

pub(crate) async fn upsert_qdrant_chunk_vectors(
    state: State<'_, DocumentStore>,
    request: QdrantChunkUpsertRequest,
) -> Result<QdrantUpsertResult, String> {
    let points = request
        .points
        .into_iter()
        .map(qdrant_chunk_point_to_vector_point)
        .collect::<Result<Vec<_>, _>>()?;
    upsert_qdrant_points(&state, request.collection, points)
}

pub(crate) fn upsert_document_chunk_embeddings(
    store: &DocumentStore,
    document_id: &str,
    document_name: &str,
    chunks: &[IndexedChunk],
) -> Result<usize, String> {
    let config = QdrantConfig::from_store(store, None)?;
    let mut connection = store
        .qdrant_connection
        .lock()
        .map_err(|_| "embedded Qdrant store lock is poisoned".to_string())?;

    let embeddable_chunks = chunks
        .iter()
        .filter(|chunk| !chunk.plain_text.trim().is_empty())
        .collect::<Vec<_>>();
    let total = embeddable_chunks.len();
    if total == 0 {
        return Ok(0);
    }

    if document_chunk_vectors_are_current(
        &connection,
        &config.collection,
        document_id,
        &embeddable_chunks,
    )? {
        return Ok(0);
    }

    delete_qdrant_document_points(&connection, &config.collection, document_id)?;

    let mut points = Vec::with_capacity(total);
    for (index, chunk) in embeddable_chunks.into_iter().enumerate() {
        let current = index + 1;
        println!(
            "[qdrant] vectorizing chunk {current}/{total} ({:.1}%): document_id={document_id}, chunk_id={}, chunk_type={}, text_bytes={}",
            progress_percent(current, total),
            chunk.id,
            chunk.chunk_type,
            chunk.plain_text.len()
        );
        points.push(indexed_chunk_to_qdrant_point(
            document_id,
            document_name,
            chunk,
        )?);
    }

    let result = upsert_qdrant_points_with_connection(&mut connection, &config.collection, points)?;
    Ok(result.points_upserted)
}

pub(crate) fn delete_document_chunk_embeddings(
    store: &DocumentStore,
    document_ids: &[String],
) -> Result<usize, String> {
    let config = QdrantConfig::from_store(store, None)?;
    let connection = store
        .qdrant_connection
        .lock()
        .map_err(|_| "embedded Qdrant store lock is poisoned".to_string())?;

    let mut deleted = 0usize;
    for document_id in document_ids {
        deleted += delete_qdrant_document_points(&connection, &config.collection, document_id)?;
    }

    Ok(deleted)
}

fn upsert_qdrant_points(
    store: &DocumentStore,
    collection: Option<String>,
    points: Vec<QdrantVectorPoint>,
) -> Result<QdrantUpsertResult, String> {
    let config = QdrantConfig::from_store(store, collection)?;
    let mut connection = store
        .qdrant_connection
        .lock()
        .map_err(|_| "embedded Qdrant store lock is poisoned".to_string())?;

    upsert_qdrant_points_with_connection(&mut connection, &config.collection, points)
}

fn upsert_qdrant_points_with_connection(
    connection: &mut Connection,
    collection_name: &str,
    points: Vec<QdrantVectorPoint>,
) -> Result<QdrantUpsertResult, String> {
    let point_count = points.len();
    let collection = get_or_create_collection(connection, collection_name, &points)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("cannot start embedded Qdrant transaction: {error}"))?;

    for point in points {
        if point.vector.len() as u64 != collection.vector_size {
            return Err(format!(
                "cannot upsert Qdrant vector {}: expected dimension {}, got {}",
                point.id,
                collection.vector_size,
                point.vector.len()
            ));
        }

        if point.id.trim().is_empty() {
            return Err("cannot upsert Qdrant vector with empty id".to_string());
        }

        let payload = match point.payload {
            Some(Value::Object(map)) => map,
            _ => Map::new(),
        };
        let point_id = point.id.clone();
        let vector_json = serde_json::to_string(&point.vector)
            .map_err(|error| format!("cannot serialize Qdrant vector {}: {error}", point.id))?;
        let payload_json = Value::Object(payload).to_string();

        transaction
            .execute(
                "INSERT INTO qdrant_points (
                    collection, point_id, external_id, vector_json, payload_json, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(collection, point_id) DO UPDATE SET
                    external_id = excluded.external_id,
                    vector_json = excluded.vector_json,
                    payload_json = excluded.payload_json,
                    updated_at = excluded.updated_at",
                params![
                    collection_name,
                    &point_id,
                    &point.id,
                    &vector_json,
                    &payload_json,
                    unix_timestamp_seconds(),
                ],
            )
            .map_err(|error| format!("cannot upsert embedded Qdrant point: {error}"))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("cannot commit embedded Qdrant vectors: {error}"))?;

    Ok(QdrantUpsertResult {
        collection: collection_name.to_string(),
        points_upserted: point_count,
    })
}

fn indexed_chunk_to_qdrant_point(
    document_id: &str,
    document_name: &str,
    chunk: &IndexedChunk,
) -> Result<QdrantVectorPoint, String> {
    let mut payload = qdrant_chunk_payload(
        &chunk.id,
        document_id,
        Some(document_name),
        &chunk.chunk_type,
        Some(&Value::String(chunk.title_path.clone())),
        chunk.order_index as i64,
    )?;
    payload.insert(
        "content_hash".to_string(),
        Value::String(chunk_content_hash(chunk)),
    );
    payload.insert(
        "embedding_model".to_string(),
        Value::String(LOCAL_CHUNK_EMBEDDING_MODEL.to_string()),
    );

    Ok(QdrantVectorPoint {
        id: chunk.id.clone(),
        vector: embed_chunk_text(&chunk.plain_text),
        payload: Some(Value::Object(payload)),
    })
}

fn progress_percent(current: usize, total: usize) -> f64 {
    if total == 0 {
        100.0
    } else {
        current as f64 * 100.0 / total as f64
    }
}

fn delete_qdrant_document_points(
    connection: &Connection,
    collection: &str,
    document_id: &str,
) -> Result<usize, String> {
    let mut stale_point_ids = Vec::new();
    {
        let mut statement = connection
            .prepare(
                "SELECT point_id, payload_json
                 FROM qdrant_points
                 WHERE collection = ?1",
            )
            .map_err(|error| format!("cannot prepare embedded Qdrant document cleanup: {error}"))?;
        let rows = statement
            .query_map(params![collection], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| format!("cannot scan embedded Qdrant document points: {error}"))?;

        for row in rows {
            let (point_id, payload_json) =
                row.map_err(|error| format!("cannot read embedded Qdrant point: {error}"))?;
            let payload = serde_json::from_str::<Value>(&payload_json)
                .map_err(|error| format!("cannot parse embedded Qdrant payload: {error}"))?;
            if payload
                .get("document_id")
                .and_then(Value::as_str)
                .map(|value| value == document_id)
                .unwrap_or(false)
            {
                stale_point_ids.push(point_id);
            }
        }
    }

    for point_id in &stale_point_ids {
        connection
            .execute(
                "DELETE FROM qdrant_points WHERE collection = ?1 AND point_id = ?2",
                params![collection, point_id],
            )
            .map_err(|error| format!("cannot delete stale embedded Qdrant point: {error}"))?;
    }

    Ok(stale_point_ids.len())
}

fn document_chunk_vectors_are_current(
    connection: &Connection,
    collection: &str,
    document_id: &str,
    chunks: &[&IndexedChunk],
) -> Result<bool, String> {
    let Some(collection_metadata) = get_qdrant_collection(connection, collection)? else {
        return Ok(false);
    };
    if collection_metadata.vector_size != LOCAL_CHUNK_EMBEDDING_DIMENSIONS as u64 {
        return Ok(false);
    }

    let mut existing = HashMap::new();
    let mut statement = connection
        .prepare(
            "SELECT point_id, vector_json, payload_json
             FROM qdrant_points
             WHERE collection = ?1",
        )
        .map_err(|error| format!("cannot prepare embedded Qdrant vector cache lookup: {error}"))?;
    let rows = statement
        .query_map(params![collection], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| format!("cannot scan embedded Qdrant vector cache: {error}"))?;

    for row in rows {
        let (point_id, vector_json, payload_json) =
            row.map_err(|error| format!("cannot read embedded Qdrant vector cache: {error}"))?;
        let payload = serde_json::from_str::<Value>(&payload_json).map_err(|error| {
            format!("cannot parse embedded Qdrant vector cache payload: {error}")
        })?;
        if !payload
            .get("document_id")
            .and_then(Value::as_str)
            .map(|value| value == document_id)
            .unwrap_or(false)
        {
            continue;
        }

        let Some(chunk_id) = payload.get("chunk_id").and_then(Value::as_str) else {
            return Ok(false);
        };
        let Some(content_hash) = payload.get("content_hash").and_then(Value::as_str) else {
            return Ok(false);
        };
        let Some(embedding_model) = payload.get("embedding_model").and_then(Value::as_str) else {
            return Ok(false);
        };
        if embedding_model != LOCAL_CHUNK_EMBEDDING_MODEL {
            return Ok(false);
        }

        let vector = serde_json::from_str::<Vec<f32>>(&vector_json)
            .map_err(|error| format!("cannot parse embedded Qdrant cached vector: {error}"))?;
        if vector.len() != LOCAL_CHUNK_EMBEDDING_DIMENSIONS {
            return Ok(false);
        }

        existing.insert(
            chunk_id.to_string(),
            ExistingChunkVector {
                point_id,
                content_hash: content_hash.to_string(),
            },
        );
    }

    if existing.len() != chunks.len() {
        return Ok(false);
    }

    Ok(chunks.iter().all(|chunk| {
        existing
            .get(&chunk.id)
            .map(|vector| {
                vector.point_id == chunk.id && vector.content_hash == chunk_content_hash(chunk)
            })
            .unwrap_or(false)
    }))
}

struct ExistingChunkVector {
    point_id: String,
    content_hash: String,
}
