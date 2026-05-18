use rusqlite::{params, Connection};
use tauri::State;

use super::super::{
    document_index::build_document_index, qdrant, unix_timestamp_seconds, DocumentStore,
};
use super::{DocumentIndexRequest, DocumentIndexResult, FullTextSearchHit, PersistedDocumentIndex};
pub(crate) fn index_document_structure(
    state: State<'_, DocumentStore>,
    request: DocumentIndexRequest,
) -> Result<DocumentIndexResult, String> {
    let mut persisted = {
        let mut connection = state
            .connection
            .lock()
            .map_err(|_| "SQLite store lock is poisoned".to_string())?;
        index_document_structure_with_connection(&mut connection, request)?
    };

    persisted.result.qdrant_vectors_indexed = qdrant::upsert_document_chunk_embeddings(
        &state,
        &persisted.document_id,
        &persisted.filename,
        &persisted.chunks,
    )?;

    Ok(persisted.result)
}

pub(super) fn index_document_structure_with_connection(
    connection: &mut Connection,
    request: DocumentIndexRequest,
) -> Result<PersistedDocumentIndex, String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("cannot start SQLite transaction: {error}"))?;

    let extension = request
        .extension
        .clone()
        .or_else(|| {
            request
                .filename
                .rsplit_once('.')
                .map(|(_, ext)| ext.to_string())
        })
        .unwrap_or_else(|| "unknown".to_string());
    let file_type = request
        .file_type
        .clone()
        .unwrap_or_else(|| extension.clone());
    let original_path = request
        .original_path
        .clone()
        .or_else(|| request.path.clone());
    let stored_path = request.stored_path.clone().or_else(|| request.path.clone());
    let parse_status = request
        .parse_status
        .clone()
        .unwrap_or_else(|| "parsed".to_string());
    let index_status = request
        .index_status
        .clone()
        .unwrap_or_else(|| "indexed".to_string());
    let now = unix_timestamp_seconds();

    transaction
        .execute(
            "INSERT INTO documents (
                id, name, original_path, stored_path, file_type, size_bytes,
                parse_status, index_status, sha256, created_at, updated_at,
                path, filename, extension, indexed_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?4, ?2, ?5, ?10)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                original_path = excluded.original_path,
                stored_path = excluded.stored_path,
                file_type = excluded.file_type,
                size_bytes = excluded.size_bytes,
                parse_status = excluded.parse_status,
                index_status = excluded.index_status,
                sha256 = excluded.sha256,
                updated_at = excluded.updated_at,
                path = excluded.path,
                filename = excluded.filename,
                extension = excluded.extension,
                indexed_at = excluded.indexed_at",
            params![
                request.document_id,
                request.filename,
                original_path,
                stored_path,
                file_type,
                request.size_bytes.map(|size| size as i64),
                parse_status,
                index_status,
                request.sha256,
                now,
            ],
        )
        .map_err(|error| format!("cannot upsert document metadata: {error}"))?;

    transaction
        .execute(
            "DELETE FROM doc_nodes WHERE document_id = ?1",
            params![request.document_id],
        )
        .map_err(|error| format!("cannot clear old document nodes: {error}"))?;

    transaction
        .execute(
            "DELETE FROM chunks WHERE document_id = ?1",
            params![request.document_id],
        )
        .map_err(|error| format!("cannot clear old document chunks: {error}"))?;

    let indexed = build_document_index(&request.document_id, &request.filename, &request.blocks);
    let mut text_bytes_indexed = 0usize;
    for node in &indexed.nodes {
        if let Some(text) = &node.text {
            text_bytes_indexed += text.len();
        }
        transaction
            .execute(
                "INSERT INTO doc_nodes (
                    id, document_id, parent_id, node_type, level, title, text,
                    order_index, metadata_json, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
                params![
                    node.id,
                    request.document_id,
                    node.parent_id,
                    node.node_type,
                    node.level.map(i64::from),
                    node.title,
                    node.text,
                    node.order_index as i64,
                    node.metadata_json,
                    now,
                ],
            )
            .map_err(|error| format!("cannot insert document node {}: {error}", node.id))?;
    }

    for chunk in &indexed.chunks {
        if !chunk.plain_text.trim().is_empty() {
            text_bytes_indexed += chunk.plain_text.len();
        }
        transaction
            .execute(
                "INSERT INTO chunks (
                    id, document_id, file_id, file_name, chunk_type,
                    title_level_1, title_level_2, title_level_3, title_path,
                    heading_level, content, plain_text, images_json, tables_json,
                    paragraph_start_index, paragraph_end_index, order_index,
                    metadata_json, created_at, updated_at
                 ) VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?18)",
                params![
                    chunk.id,
                    request.document_id,
                    request.filename,
                    chunk.chunk_type,
                    chunk.title_level_1,
                    chunk.title_level_2,
                    chunk.title_level_3,
                    chunk.title_path,
                    chunk.heading_level.map(i64::from),
                    chunk.content,
                    chunk.plain_text,
                    chunk.images_json,
                    chunk.tables_json,
                    chunk.paragraph_start_index.map(|index| index as i64),
                    chunk.paragraph_end_index.map(|index| index as i64),
                    chunk.order_index as i64,
                    chunk.metadata_json,
                    now,
                ],
            )
            .map_err(|error| format!("cannot insert document chunk {}: {error}", chunk.id))?;
    }

    transaction
        .commit()
        .map_err(|error| format!("cannot commit SQLite document index: {error}"))?;

    Ok(PersistedDocumentIndex {
        result: DocumentIndexResult {
            document_id: request.document_id.clone(),
            nodes_indexed: indexed.nodes.len(),
            chunks_indexed: indexed.chunks.len(),
            qdrant_vectors_indexed: 0,
            text_bytes_indexed,
        },
        document_id: request.document_id,
        filename: request.filename,
        chunks: indexed.chunks,
    })
}

pub(crate) fn search_document_full_text(
    state: State<'_, DocumentStore>,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<FullTextSearchHit>, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Err("search query is empty".to_string());
    }
    let connection = state
        .connection
        .lock()
        .map_err(|_| "SQLite store lock is poisoned".to_string())?;
    let mut statement = connection
        .prepare(
            "SELECT d.id,
                    COALESCE(d.name, d.filename, ''),
                    COALESCE(d.stored_path, d.path),
                    n.id,
                    n.node_type,
                    n.title,
                    n.text,
                    n.order_index,
                    n.metadata_json
             FROM doc_nodes n
             JOIN documents d ON d.id = n.document_id
             WHERE n.text LIKE ?1 ESCAPE '\\'
             ORDER BY d.name, n.order_index
             LIMIT ?2",
        )
        .map_err(|error| format!("cannot prepare SQLite full-text search: {error}"))?;

    let like_query = format!("%{}%", escape_sql_like(trimmed));
    let rows = statement
        .query_map(params![like_query, limit.unwrap_or(20).min(100)], |row| {
            Ok(FullTextSearchHit {
                document_id: row.get(0)?,
                filename: row.get(1)?,
                path: row.get(2)?,
                node_id: row.get(3)?,
                node_type: row.get(4)?,
                title: row.get(5)?,
                text: row.get(6)?,
                order_index: row.get(7)?,
                metadata_json: row.get(8)?,
            })
        })
        .map_err(|error| format!("cannot run SQLite full-text search: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("cannot read SQLite full-text results: {error}"))
}

fn escape_sql_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}
