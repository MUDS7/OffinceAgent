use rusqlite::params;
use serde_json::{json, Value};
use tauri::State;

use super::{
    collection::{
        get_qdrant_collection, score_vectors, sort_qdrant_hits, upsert_qdrant_collection,
    },
    config::QdrantConfig,
    filter::matches_qdrant_filter,
    model::{
        QdrantCollectionRequest, QdrantSearchHit, QdrantSearchRequest, QdrantStatus,
        QdrantStoredPoint,
    },
};
use crate::storage::DocumentStore;

pub(crate) async fn get_qdrant_status(
    state: State<'_, DocumentStore>,
) -> Result<QdrantStatus, String> {
    let config = QdrantConfig::from_store(&state, None)?;
    Ok(QdrantStatus {
        url: config.local_url(),
        collection: config.collection,
        reachable: true,
        path: config.path.display().to_string(),
    })
}

pub(crate) async fn ensure_qdrant_collection(
    state: State<'_, DocumentStore>,
    request: QdrantCollectionRequest,
) -> Result<QdrantStatus, String> {
    let config = QdrantConfig::from_store(&state, request.collection)?;
    let distance = request.distance.unwrap_or_else(|| "Cosine".to_string());
    let connection = state
        .qdrant_connection
        .lock()
        .map_err(|_| "embedded Qdrant store lock is poisoned".to_string())?;
    upsert_qdrant_collection(
        &connection,
        &config.collection,
        request.vector_size,
        &distance,
    )?;

    Ok(QdrantStatus {
        url: config.local_url(),
        collection: config.collection,
        reachable: true,
        path: config.path.display().to_string(),
    })
}

pub(crate) async fn search_qdrant_vectors(
    state: State<'_, DocumentStore>,
    request: QdrantSearchRequest,
) -> Result<Value, String> {
    let config = QdrantConfig::from_store(&state, request.collection)?;
    let connection = state
        .qdrant_connection
        .lock()
        .map_err(|_| "embedded Qdrant store lock is poisoned".to_string())?;
    let collection = get_qdrant_collection(&connection, &config.collection)?
        .ok_or_else(|| format!("Qdrant collection {} does not exist", config.collection))?;
    if request.vector.len() as u64 != collection.vector_size {
        return Err(format!(
            "cannot search Qdrant collection {}: expected dimension {}, got {}",
            config.collection,
            collection.vector_size,
            request.vector.len()
        ));
    }

    let mut statement = connection
        .prepare(
            "SELECT point_id, external_id, vector_json, payload_json
             FROM qdrant_points
             WHERE collection = ?1",
        )
        .map_err(|error| format!("cannot prepare embedded Qdrant search: {error}"))?;
    let rows = statement
        .query_map(params![config.collection], |row| {
            Ok(QdrantStoredPoint {
                point_id: row.get(0)?,
                external_id: row.get(1)?,
                vector_json: row.get(2)?,
                payload_json: row.get(3)?,
            })
        })
        .map_err(|error| format!("cannot scan embedded Qdrant points: {error}"))?;

    let mut hits = Vec::new();
    for row in rows {
        let point = row.map_err(|error| format!("cannot read embedded Qdrant point: {error}"))?;
        let vector = serde_json::from_str::<Vec<f32>>(&point.vector_json)
            .map_err(|error| format!("cannot parse embedded Qdrant vector: {error}"))?;
        let payload = serde_json::from_str::<Value>(&point.payload_json)
            .map_err(|error| format!("cannot parse embedded Qdrant payload: {error}"))?;
        if let Some(filter) = &request.filter {
            if !matches_qdrant_filter(&payload, filter, &point.point_id, &point.external_id) {
                continue;
            }
        }

        let score = score_vectors(&request.vector, &vector, &collection.distance);
        hits.push(QdrantSearchHit {
            point_id: point.point_id,
            score,
            payload,
        });
    }

    sort_qdrant_hits(&mut hits, &collection.distance);
    hits.truncate(request.limit.unwrap_or(10).min(100) as usize);

    let result = hits
        .into_iter()
        .map(|hit| {
            let id = hit
                .point_id
                .parse::<u64>()
                .map(Value::from)
                .unwrap_or_else(|_| Value::String(hit.point_id));
            json!({
                "id": id,
                "version": 0,
                "score": hit.score,
                "payload": hit.payload,
            })
        })
        .collect::<Vec<_>>();

    Ok(json!({
        "result": result,
        "status": "ok",
        "time": 0.0,
    }))
}
