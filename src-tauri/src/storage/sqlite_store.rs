use std::path::PathBuf;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Manager, State};

use super::{build_document_index, flatten_document_blocks, unix_timestamp_seconds, DocumentStore};

#[derive(Debug, Deserialize)]
pub(crate) struct DocumentIndexRequest {
    document_id: String,
    filename: String,
    path: Option<String>,
    original_path: Option<String>,
    stored_path: Option<String>,
    extension: Option<String>,
    file_type: Option<String>,
    size_bytes: Option<u64>,
    sha256: Option<String>,
    parse_status: Option<String>,
    index_status: Option<String>,
    blocks: Value,
}

#[derive(Debug, Serialize)]
pub(crate) struct DocumentIndexResult {
    document_id: String,
    blocks_indexed: usize,
    nodes_indexed: usize,
    chunks_indexed: usize,
    assets_indexed: usize,
    text_bytes_indexed: usize,
}

#[derive(Debug, Serialize)]
pub(crate) struct FullTextSearchHit {
    document_id: String,
    block_id: String,
    filename: String,
    path: Option<String>,
    text: String,
    rank: f64,
}

pub(super) fn sqlite_db_path(app: &tauri::App) -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("OFFICE_AGENT_SQLITE_PATH") {
        if !path.trim().is_empty() {
            return Ok(PathBuf::from(path));
        }
    }

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("cannot resolve app data directory: {error}"))?;

    Ok(data_dir.join("office-agent.sqlite3"))
}

pub(crate) fn index_document_structure(
    state: State<'_, DocumentStore>,
    request: DocumentIndexRequest,
) -> Result<DocumentIndexResult, String> {
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "SQLite store lock is poisoned".to_string())?;
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
            "DELETE FROM chunk_assets WHERE chunk_id IN (
                SELECT id FROM chunks WHERE document_id = ?1
             )",
            params![request.document_id],
        )
        .map_err(|error| format!("cannot clear old chunk asset links: {error}"))?;
    transaction
        .execute(
            "DELETE FROM chunk_fts WHERE document_id = ?1",
            params![request.document_id],
        )
        .map_err(|error| format!("cannot clear old chunk full-text rows: {error}"))?;
    transaction
        .execute(
            "DELETE FROM assets WHERE document_id = ?1",
            params![request.document_id],
        )
        .map_err(|error| format!("cannot clear old document assets: {error}"))?;
    transaction
        .execute(
            "DELETE FROM chunks WHERE document_id = ?1",
            params![request.document_id],
        )
        .map_err(|error| format!("cannot clear old chunks: {error}"))?;
    transaction
        .execute(
            "DELETE FROM doc_nodes WHERE document_id = ?1",
            params![request.document_id],
        )
        .map_err(|error| format!("cannot clear old document nodes: {error}"))?;
    transaction
        .execute(
            "DELETE FROM document_blocks WHERE document_id = ?1",
            params![request.document_id],
        )
        .map_err(|error| format!("cannot clear old document blocks: {error}"))?;
    transaction
        .execute(
            "DELETE FROM document_fts WHERE document_id = ?1",
            params![request.document_id],
        )
        .map_err(|error| format!("cannot clear old full-text rows: {error}"))?;

    let flattened = flatten_document_blocks(&request.blocks);
    let indexed = build_document_index(&request.document_id, &request.blocks);
    let mut text_bytes_indexed = 0usize;
    for block in &flattened {
        text_bytes_indexed += block.text.len();
        transaction
            .execute(
                "INSERT INTO document_blocks (
                    document_id, block_id, block_type, block_index, parent_id, text, metadata_json
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    request.document_id,
                    block.block_id,
                    block.block_type,
                    block.block_index as i64,
                    block.parent_id,
                    block.text,
                    block.metadata_json,
                ],
            )
            .map_err(|error| format!("cannot insert document block {}: {error}", block.block_id))?;

        if !block.text.trim().is_empty() {
            transaction
                .execute(
                    "INSERT INTO document_fts (document_id, block_id, filename, path, text)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        request.document_id,
                        block.block_id,
                        request.filename,
                        request.path,
                        block.text,
                    ],
                )
                .map_err(|error| {
                    format!("cannot insert full-text row {}: {error}", block.block_id)
                })?;
        }
    }

    for node in &indexed.nodes {
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
        text_bytes_indexed += chunk.content.len();
        transaction
            .execute(
                "INSERT INTO chunks (
                    id, document_id, node_ids_json, heading_path_json, chunk_type,
                    content, content_for_embedding, order_index, token_count, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    chunk.id,
                    request.document_id,
                    chunk.node_ids_json,
                    chunk.heading_path_json,
                    chunk.chunk_type,
                    chunk.content,
                    chunk.content_for_embedding,
                    chunk.order_index as i64,
                    chunk.token_count as i64,
                    now,
                ],
            )
            .map_err(|error| format!("cannot insert chunk {}: {error}", chunk.id))?;

        if !chunk.content.trim().is_empty() {
            transaction
                .execute(
                    "INSERT INTO chunk_fts (chunk_id, document_id, heading_path, content)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![
                        chunk.id,
                        request.document_id,
                        chunk.heading_path_text,
                        chunk.content,
                    ],
                )
                .map_err(|error| format!("cannot insert chunk FTS row {}: {error}", chunk.id))?;
        }
    }

    for asset in &indexed.assets {
        transaction
            .execute(
                "INSERT INTO assets (
                    id, document_id, node_id, asset_type, file_path, caption,
                    description, nearby_text, metadata_json, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    asset.id,
                    request.document_id,
                    asset.node_id,
                    asset.asset_type,
                    asset.file_path,
                    asset.caption,
                    asset.description,
                    asset.nearby_text,
                    asset.metadata_json,
                    now,
                ],
            )
            .map_err(|error| format!("cannot insert asset {}: {error}", asset.id))?;
    }

    for link in &indexed.chunk_assets {
        transaction
            .execute(
                "INSERT INTO chunk_assets (chunk_id, asset_id, relation_type)
                 VALUES (?1, ?2, ?3)",
                params![link.chunk_id, link.asset_id, link.relation_type],
            )
            .map_err(|error| {
                format!(
                    "cannot link chunk {} to asset {}: {error}",
                    link.chunk_id, link.asset_id
                )
            })?;
    }

    transaction
        .commit()
        .map_err(|error| format!("cannot commit SQLite document index: {error}"))?;

    Ok(DocumentIndexResult {
        document_id: request.document_id,
        blocks_indexed: flattened.len(),
        nodes_indexed: indexed.nodes.len(),
        chunks_indexed: indexed.chunks.len(),
        assets_indexed: indexed.assets.len(),
        text_bytes_indexed,
    })
}

pub(crate) fn search_document_full_text(
    state: State<'_, DocumentStore>,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<FullTextSearchHit>, String> {
    let query = build_safe_fts_query(&query).ok_or_else(|| "search query is empty".to_string())?;
    let connection = state
        .connection
        .lock()
        .map_err(|_| "SQLite store lock is poisoned".to_string())?;
    let mut statement = connection
        .prepare(
            "SELECT chunk_fts.document_id, chunk_fts.chunk_id,
                    COALESCE(documents.name, documents.filename, ''),
                    COALESCE(documents.stored_path, documents.path),
                    snippet(chunk_fts, 3, '[', ']', '...', 24), rank
             FROM chunk_fts
             JOIN documents ON documents.id = chunk_fts.document_id
             WHERE chunk_fts MATCH ?1
             ORDER BY rank
             LIMIT ?2",
        )
        .map_err(|error| format!("cannot prepare SQLite full-text search: {error}"))?;

    let rows = statement
        .query_map(params![query, limit.unwrap_or(20).min(100)], |row| {
            Ok(FullTextSearchHit {
                document_id: row.get(0)?,
                block_id: row.get(1)?,
                filename: row.get(2)?,
                path: row.get(3)?,
                text: row.get(4)?,
                rank: row.get(5)?,
            })
        })
        .map_err(|error| format!("cannot run SQLite full-text search: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("cannot read SQLite full-text results: {error}"))
}

pub(super) fn migrate_sqlite(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS documents (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                original_path TEXT,
                stored_path TEXT,
                file_type TEXT NOT NULL,
                size_bytes INTEGER,
                parse_status TEXT NOT NULL DEFAULT 'pending',
                index_status TEXT NOT NULL DEFAULT 'pending',
                sha256 TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                path TEXT,
                filename TEXT NOT NULL,
                extension TEXT NOT NULL,
                indexed_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS doc_nodes (
                id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL,
                parent_id TEXT,
                node_type TEXT NOT NULL,
                level INTEGER,
                title TEXT,
                text TEXT,
                order_index INTEGER NOT NULL,
                metadata_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
                FOREIGN KEY (parent_id) REFERENCES doc_nodes(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS chunks (
                id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL,
                node_ids_json TEXT NOT NULL,
                heading_path_json TEXT NOT NULL,
                chunk_type TEXT NOT NULL,
                content TEXT NOT NULL,
                content_for_embedding TEXT NOT NULL,
                order_index INTEGER NOT NULL,
                token_count INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS assets (
                id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL,
                node_id TEXT,
                asset_type TEXT NOT NULL,
                file_path TEXT,
                caption TEXT,
                description TEXT,
                nearby_text TEXT,
                metadata_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
                FOREIGN KEY (node_id) REFERENCES doc_nodes(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS chunk_assets (
                chunk_id TEXT NOT NULL,
                asset_id TEXT NOT NULL,
                relation_type TEXT NOT NULL,
                PRIMARY KEY (chunk_id, asset_id, relation_type),
                FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE,
                FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS document_blocks (
                document_id TEXT NOT NULL,
                block_id TEXT NOT NULL,
                block_type TEXT NOT NULL,
                block_index INTEGER NOT NULL,
                parent_id TEXT,
                text TEXT NOT NULL,
                metadata_json TEXT NOT NULL,
                PRIMARY KEY (document_id, block_id),
                FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS document_fts USING fts5(
                document_id UNINDEXED,
                block_id UNINDEXED,
                filename,
                path UNINDEXED,
                text,
                tokenize = 'trigram'
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
                chunk_id UNINDEXED,
                document_id UNINDEXED,
                heading_path,
                content,
                tokenize = 'trigram'
            );

            CREATE INDEX IF NOT EXISTS idx_doc_nodes_document
                ON doc_nodes(document_id, order_index);
            CREATE INDEX IF NOT EXISTS idx_doc_nodes_parent
                ON doc_nodes(document_id, parent_id);
            CREATE INDEX IF NOT EXISTS idx_chunks_document
                ON chunks(document_id, order_index);
            CREATE INDEX IF NOT EXISTS idx_assets_document
                ON assets(document_id);
            CREATE INDEX IF NOT EXISTS idx_document_blocks_document
                ON document_blocks(document_id, block_index);
            ",
        )
        .map_err(|error| format!("cannot migrate SQLite document store: {error}"))?;

    add_column_if_missing(connection, "documents", "name", "TEXT")?;
    add_column_if_missing(connection, "documents", "original_path", "TEXT")?;
    add_column_if_missing(connection, "documents", "stored_path", "TEXT")?;
    add_column_if_missing(connection, "documents", "file_type", "TEXT")?;
    add_column_if_missing(connection, "documents", "parse_status", "TEXT")?;
    add_column_if_missing(connection, "documents", "index_status", "TEXT")?;
    add_column_if_missing(connection, "documents", "created_at", "INTEGER")?;
    add_column_if_missing(connection, "documents", "updated_at", "INTEGER")?;
    let now = unix_timestamp_seconds();
    connection
        .execute(
            "UPDATE documents SET
                name = COALESCE(NULLIF(name, ''), filename),
                file_type = COALESCE(NULLIF(file_type, ''), extension),
                stored_path = COALESCE(stored_path, path),
                original_path = COALESCE(original_path, path),
                parse_status = COALESCE(NULLIF(parse_status, ''), 'parsed'),
                index_status = COALESCE(NULLIF(index_status, ''), 'indexed'),
                created_at = COALESCE(created_at, indexed_at, ?1),
                updated_at = COALESCE(updated_at, indexed_at, ?1)",
            params![now],
        )
        .map_err(|error| format!("cannot backfill document metadata columns: {error}"))?;

    Ok(())
}

fn add_column_if_missing(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| format!("cannot inspect table {table}: {error}"))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("cannot read table {table} columns: {error}"))?;

    for row in rows {
        let existing = row.map_err(|error| format!("cannot read table {table} column: {error}"))?;
        if existing == column {
            return Ok(());
        }
    }

    connection
        .execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
            [],
        )
        .map(|_| ())
        .map_err(|error| format!("cannot add column {table}.{column}: {error}"))
}

pub(super) fn build_safe_fts_query(query: &str) -> Option<String> {
    let terms = query
        .split_whitespace()
        .map(str::trim)
        .filter(|term| !term.is_empty())
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>();

    if terms.is_empty() {
        let trimmed = query.trim();
        if trimmed.is_empty() {
            return None;
        }
        return Some(format!("\"{}\"", trimmed.replace('"', "\"\"")));
    }

    Some(terms.join(" "))
}
