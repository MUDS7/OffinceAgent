use std::{
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Manager, State};

use super::{document_index::build_document_index, unix_timestamp_seconds, DocumentStore};

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
    nodes_indexed: usize,
    chunks_indexed: usize,
    text_bytes_indexed: usize,
}

#[derive(Debug, Serialize)]
pub(crate) struct FullTextSearchHit {
    document_id: String,
    filename: String,
    path: Option<String>,
    text: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct WorkspaceFileMetadataRequest {
    document_id: String,
    filename: String,
    path: String,
    relative_path: Option<String>,
    extension: Option<String>,
    file_type: Option<String>,
    size_bytes: Option<u64>,
    modified_at: Option<i64>,
}

#[derive(Debug, Serialize)]
pub(crate) struct WorkspaceFileMetadataResult {
    document_id: String,
    saved: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct WorkspaceFilesMetadataResult {
    files_indexed: usize,
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
    index_document_structure_with_connection(&mut connection, request)
}

fn index_document_structure_with_connection(
    connection: &mut Connection,
    request: DocumentIndexRequest,
) -> Result<DocumentIndexResult, String> {
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

    Ok(DocumentIndexResult {
        document_id: request.document_id,
        nodes_indexed: indexed.nodes.len(),
        chunks_indexed: indexed.chunks.len(),
        text_bytes_indexed,
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
                    n.text
             FROM doc_nodes n
             JOIN documents d ON d.id = n.document_id
             WHERE n.text LIKE ?1
             ORDER BY n.order_index
             LIMIT ?2",
        )
        .map_err(|error| format!("cannot prepare SQLite full-text search: {error}"))?;

    let like_query = format!("%{}%", trimmed.replace('%', "\\%").replace('_', "\\_"));
    let rows = statement
        .query_map(params![like_query, limit.unwrap_or(20).min(100)], |row| {
            Ok(FullTextSearchHit {
                document_id: row.get(0)?,
                filename: row.get(1)?,
                path: row.get(2)?,
                text: row.get(3)?,
            })
        })
        .map_err(|error| format!("cannot run SQLite full-text search: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("cannot read SQLite full-text results: {error}"))
}

pub(crate) fn save_workspace_file_metadata(
    state: State<'_, DocumentStore>,
    request: WorkspaceFileMetadataRequest,
) -> Result<WorkspaceFileMetadataResult, String> {
    let connection = state
        .connection
        .lock()
        .map_err(|_| "SQLite store lock is poisoned".to_string())?;
    save_workspace_file_metadata_with_connection(&connection, request)
}

pub(crate) fn index_workspace_files(
    state: State<'_, DocumentStore>,
    path: String,
) -> Result<WorkspaceFilesMetadataResult, String> {
    let workspace_path = normalize_workspace_scan_path(&path)?;
    let workspace_data_path = state
        .workspace_data_path
        .lock()
        .map_err(|_| "workspace data path lock is poisoned".to_string())?
        .clone();
    let mut connection = state
        .connection
        .lock()
        .map_err(|_| "SQLite store lock is poisoned".to_string())?;

    index_workspace_files_with_connection(&mut connection, &workspace_path, &workspace_data_path)
}

fn save_workspace_file_metadata_with_connection(
    connection: &Connection,
    request: WorkspaceFileMetadataRequest,
) -> Result<WorkspaceFileMetadataResult, String> {
    upsert_workspace_file_metadata(connection, &request)?;

    Ok(WorkspaceFileMetadataResult {
        document_id: request.document_id,
        saved: true,
    })
}

fn index_workspace_files_with_connection(
    connection: &mut Connection,
    workspace_path: &Path,
    workspace_data_path: &Path,
) -> Result<WorkspaceFilesMetadataResult, String> {
    let mut requests = Vec::new();
    collect_workspace_file_metadata(
        workspace_path,
        workspace_path,
        workspace_data_path,
        &mut requests,
    )?;

    let transaction = connection
        .transaction()
        .map_err(|error| format!("cannot start SQLite workspace metadata transaction: {error}"))?;
    for request in &requests {
        upsert_workspace_file_metadata(&transaction, request)?;
    }
    transaction
        .commit()
        .map_err(|error| format!("cannot commit SQLite workspace metadata: {error}"))?;

    Ok(WorkspaceFilesMetadataResult {
        files_indexed: requests.len(),
    })
}

fn upsert_workspace_file_metadata(
    connection: &Connection,
    request: &WorkspaceFileMetadataRequest,
) -> Result<(), String> {
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
    let disk_metadata = std::fs::metadata(&request.path).ok();
    let size_bytes = request
        .size_bytes
        .or_else(|| disk_metadata.as_ref().map(|metadata| metadata.len()));
    let modified_at = request.modified_at.or_else(|| {
        disk_metadata
            .as_ref()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs() as i64)
    });
    let now = unix_timestamp_seconds();

    connection
        .execute(
            "INSERT INTO documents (
                id, name, original_path, stored_path, file_type, size_bytes,
                parse_status, index_status, sha256, created_at, updated_at,
                path, filename, extension, indexed_at, relative_path, modified_at
             ) VALUES (?1, ?2, ?3, ?3, ?4, ?5, 'pending', 'pending', NULL, ?6, ?6, ?3, ?2, ?7, ?6, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                original_path = excluded.original_path,
                stored_path = excluded.stored_path,
                file_type = excluded.file_type,
                size_bytes = excluded.size_bytes,
                updated_at = excluded.updated_at,
                path = excluded.path,
                filename = excluded.filename,
                extension = excluded.extension,
                relative_path = excluded.relative_path,
                modified_at = excluded.modified_at",
            params![
                request.document_id,
                request.filename,
                request.path,
                file_type,
                size_bytes.map(|size| size as i64),
                now,
                extension,
                request.relative_path,
                modified_at,
            ],
        )
        .map_err(|error| format!("cannot save workspace file metadata: {error}"))?;

    Ok(())
}

fn collect_workspace_file_metadata(
    workspace_path: &Path,
    dir: &Path,
    workspace_data_path: &Path,
    requests: &mut Vec<WorkspaceFileMetadataRequest>,
) -> Result<(), String> {
    let entries = std::fs::read_dir(dir)
        .map_err(|error| format!("cannot scan workspace directory {}: {error}", dir.display()))?;

    for entry in entries {
        let entry = entry.map_err(|error| {
            format!(
                "cannot read workspace directory entry {}: {error}",
                dir.display()
            )
        })?;
        let path = entry.path();
        let file_type = entry.file_type().map_err(|error| {
            format!("cannot inspect workspace entry {}: {error}", path.display())
        })?;

        if file_type.is_dir() {
            if should_skip_workspace_dir(workspace_path, workspace_data_path, &path) {
                continue;
            }
            collect_workspace_file_metadata(workspace_path, &path, workspace_data_path, requests)?;
        } else if file_type.is_file() {
            requests.push(build_workspace_file_metadata_request(
                workspace_path,
                &path,
            )?);
        }
    }

    Ok(())
}

fn build_workspace_file_metadata_request(
    workspace_path: &Path,
    file_path: &Path,
) -> Result<WorkspaceFileMetadataRequest, String> {
    let metadata = std::fs::metadata(file_path)
        .map_err(|error| format!("cannot read file metadata {}: {error}", file_path.display()))?;
    let path = file_path.display().to_string();
    let filename = file_path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| path.clone());
    let extension = file_path
        .extension()
        .map(|extension| extension.to_string_lossy().to_lowercase())
        .filter(|extension| !extension.is_empty());
    let relative_path = build_workspace_relative_path(workspace_path, file_path);
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64);

    Ok(WorkspaceFileMetadataRequest {
        document_id: workspace_document_id(&path),
        filename,
        path,
        relative_path: Some(relative_path),
        extension: extension.clone(),
        file_type: extension.or_else(|| Some("unknown".to_string())),
        size_bytes: Some(metadata.len()),
        modified_at,
    })
}

fn build_workspace_relative_path(workspace_path: &Path, file_path: &Path) -> String {
    let root_name = workspace_path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "workspace".to_string());
    let relative_tail = file_path
        .strip_prefix(workspace_path)
        .ok()
        .map(|path| normalize_document_path(&path.display().to_string()))
        .filter(|path| !path.is_empty())
        .unwrap_or_else(|| {
            file_path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| file_path.display().to_string())
        });

    format!("{root_name}/{relative_tail}")
}

fn should_skip_workspace_dir(
    workspace_path: &Path,
    workspace_data_path: &Path,
    candidate: &Path,
) -> bool {
    let is_root_data_dir = candidate.file_name().is_some_and(|name| name == ".data")
        && candidate.parent() == Some(workspace_path);
    is_root_data_dir || candidate == workspace_data_path
}

fn normalize_workspace_scan_path(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path.trim());
    if path.as_os_str().is_empty() {
        return Err("workspace path is empty".to_string());
    }

    let path = path
        .canonicalize()
        .map_err(|error| format!("cannot resolve workspace path {}: {error}", path.display()))?;
    if !path.is_dir() {
        return Err(format!(
            "workspace path is not a directory: {}",
            path.display()
        ));
    }
    Ok(path)
}

fn workspace_document_id(path: &str) -> String {
    format!("path:{}", normalize_document_path(path).to_lowercase())
}

fn normalize_document_path(path: &str) -> String {
    path.replace('\\', "/").trim_start_matches('/').to_string()
}

pub(super) fn migrate_sqlite(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;

            DROP TABLE IF EXISTS chunk_assets;
            DROP TABLE IF EXISTS assets;
            DROP TABLE IF EXISTS document_blocks;
            DROP TABLE IF EXISTS document_fts;
            DROP TABLE IF EXISTS chunk_fts;

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
                indexed_at INTEGER NOT NULL,
                relative_path TEXT,
                modified_at INTEGER
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

            CREATE INDEX IF NOT EXISTS idx_doc_nodes_document
                ON doc_nodes(document_id, order_index);
            CREATE INDEX IF NOT EXISTS idx_doc_nodes_parent
                ON doc_nodes(document_id, parent_id);

            CREATE TABLE IF NOT EXISTS chunks (
                id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL,
                file_id TEXT NOT NULL,
                file_name TEXT NOT NULL,
                chunk_type TEXT NOT NULL,
                title_level_1 TEXT,
                title_level_2 TEXT,
                title_level_3 TEXT,
                title_path TEXT NOT NULL,
                heading_level INTEGER,
                content TEXT NOT NULL,
                plain_text TEXT NOT NULL,
                images_json TEXT NOT NULL,
                tables_json TEXT NOT NULL,
                paragraph_start_index INTEGER,
                paragraph_end_index INTEGER,
                order_index INTEGER NOT NULL,
                metadata_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_chunks_document
                ON chunks(document_id, order_index);
            CREATE INDEX IF NOT EXISTS idx_chunks_title_path
                ON chunks(document_id, title_path);
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
    add_column_if_missing(connection, "documents", "relative_path", "TEXT")?;
    add_column_if_missing(connection, "documents", "modified_at", "INTEGER")?;
    add_column_if_missing(connection, "chunks", "file_id", "TEXT")?;
    add_column_if_missing(connection, "chunks", "file_name", "TEXT")?;
    add_column_if_missing(connection, "chunks", "chunk_type", "TEXT")?;
    add_column_if_missing(connection, "chunks", "title_level_1", "TEXT")?;
    add_column_if_missing(connection, "chunks", "title_level_2", "TEXT")?;
    add_column_if_missing(connection, "chunks", "title_level_3", "TEXT")?;
    add_column_if_missing(connection, "chunks", "title_path", "TEXT")?;
    add_column_if_missing(connection, "chunks", "heading_level", "INTEGER")?;
    add_column_if_missing(connection, "chunks", "content", "TEXT")?;
    add_column_if_missing(connection, "chunks", "plain_text", "TEXT")?;
    add_column_if_missing(connection, "chunks", "images_json", "TEXT")?;
    add_column_if_missing(connection, "chunks", "tables_json", "TEXT")?;
    add_column_if_missing(connection, "chunks", "paragraph_start_index", "INTEGER")?;
    add_column_if_missing(connection, "chunks", "paragraph_end_index", "INTEGER")?;
    add_column_if_missing(connection, "chunks", "order_index", "INTEGER")?;
    add_column_if_missing(connection, "chunks", "metadata_json", "TEXT")?;
    add_column_if_missing(connection, "chunks", "created_at", "INTEGER")?;
    add_column_if_missing(connection, "chunks", "updated_at", "INTEGER")?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn migrates_sqlite_schema() {
        let connection = Connection::open_in_memory().expect("in-memory SQLite should open");
        migrate_sqlite(&connection).expect("schema should migrate");

        let table_count = |name: &str| -> i64 {
            connection
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    params![name],
                    |row| row.get(0),
                )
                .unwrap_or(0)
        };

        assert_eq!(table_count("documents"), 1);
        assert_eq!(table_count("doc_nodes"), 1);
        assert_eq!(table_count("chunks"), 1);
        assert_eq!(table_count("chunk_fts"), 0);
        assert_eq!(table_count("assets"), 0);
        assert_eq!(table_count("chunk_assets"), 0);
        assert_eq!(table_count("document_blocks"), 0);
        assert_eq!(table_count("document_fts"), 0);
    }

    #[test]
    fn indexes_documents_nodes_and_docx_chunks() {
        let mut connection = Connection::open_in_memory().expect("in-memory SQLite should open");
        migrate_sqlite(&connection).expect("schema should migrate");

        let result = index_document_structure_with_connection(
            &mut connection,
            DocumentIndexRequest {
                document_id: "doc_001".to_string(),
                filename: "demo.docx".to_string(),
                path: Some("E:\\docs\\demo.docx".to_string()),
                original_path: None,
                stored_path: None,
                extension: Some("docx".to_string()),
                file_type: Some("docx".to_string()),
                size_bytes: Some(128),
                sha256: Some("abc123".to_string()),
                parse_status: None,
                index_status: None,
                blocks: json!([
                    {
                        "id": "h1",
                        "type": "paragraph",
                        "text": "Heading",
                        "style": "Heading 1"
                    },
                    {
                        "id": "p1",
                        "type": "paragraph",
                        "text": "Body text"
                    },
                    {
                        "id": "img1",
                        "type": "image",
                        "filename": "image_001.png",
                        "alt_text": "Diagram"
                    }
                ]),
            },
        )
        .expect("document structure should index");

        assert_eq!(result.nodes_indexed, 3);
        assert_eq!(result.chunks_indexed, 1);
        assert_eq!(table_count(&connection, "documents"), 1);
        assert_eq!(table_count(&connection, "doc_nodes"), 3);
        assert_eq!(table_count(&connection, "chunks"), 1);

        let row: (String, String, String) = connection
            .query_row(
                "SELECT title_path, content, plain_text FROM chunks WHERE document_id = ?1",
                params!["doc_001"],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("chunk row should exist");
        assert_eq!(row.0, "Heading");
        assert!(row.1.contains("Body text"));
        assert!(row.1.contains("[IMAGE:image_001.png]"));
        assert!(row.2.contains("标题路径：Heading"));
    }

    #[test]
    fn search_finds_nodes_by_text() {
        let mut connection = Connection::open_in_memory().expect("in-memory SQLite should open");
        migrate_sqlite(&connection).expect("schema should migrate");

        index_document_structure_with_connection(
            &mut connection,
            DocumentIndexRequest {
                document_id: "doc_search".to_string(),
                filename: "search.docx".to_string(),
                path: Some("/tmp/search.docx".to_string()),
                original_path: None,
                stored_path: None,
                extension: Some("docx".to_string()),
                file_type: Some("docx".to_string()),
                size_bytes: Some(100),
                sha256: None,
                parse_status: None,
                index_status: None,
                blocks: json!([
                    {"id": "b1", "type": "paragraph", "text": "hello world"},
                    {"id": "b2", "type": "paragraph", "text": "goodbye universe"},
                ]),
            },
        )
        .expect("should index");

        // We need to test search directly without State since we're in unit tests
        let query = "hello".to_string();
        let mut statement = connection
            .prepare(
                "SELECT d.id,
                        COALESCE(d.name, d.filename, ''),
                        COALESCE(d.stored_path, d.path),
                        n.text
                 FROM doc_nodes n
                 JOIN documents d ON d.id = n.document_id
                 WHERE n.text LIKE ?1
                 ORDER BY n.order_index
                 LIMIT 20",
            )
            .expect("should prepare");
        let hits: Vec<(String, String, Option<String>, String)> = statement
            .query_map(params![format!("%{}%", query)], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .expect("should query")
            .collect::<Result<Vec<_>, _>>()
            .expect("should collect");

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].3, "hello world");
    }

    #[test]
    fn saves_workspace_file_metadata() {
        let connection = Connection::open_in_memory().expect("in-memory SQLite should open");
        migrate_sqlite(&connection).expect("schema should migrate");

        let result = save_workspace_file_metadata_with_connection(
            &connection,
            WorkspaceFileMetadataRequest {
                document_id: "path:/tmp/readme.md".to_string(),
                filename: "readme.md".to_string(),
                path: "/tmp/readme.md".to_string(),
                relative_path: Some("workspace/readme.md".to_string()),
                extension: Some("md".to_string()),
                file_type: Some("md".to_string()),
                size_bytes: Some(42),
                modified_at: Some(1_700_000_000),
            },
        )
        .expect("metadata should save");

        assert!(result.saved);
        let row: (String, String, Option<String>, i64, Option<i64>) = connection
            .query_row(
                "SELECT filename, extension, relative_path, size_bytes, modified_at FROM documents WHERE id = ?1",
                params!["path:/tmp/readme.md"],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .expect("metadata row should exist");

        assert_eq!(row.0, "readme.md");
        assert_eq!(row.1, "md");
        assert_eq!(row.2.as_deref(), Some("workspace/readme.md"));
        assert_eq!(row.3, 42);
        assert_eq!(row.4, Some(1_700_000_000));
    }

    #[test]
    fn indexes_all_workspace_files_and_skips_workspace_data_dir() {
        let root = std::env::temp_dir().join(format!(
            "office_agent_workspace_index_test_{}_{}",
            std::process::id(),
            unix_timestamp_seconds()
        ));
        let nested = root.join("nested");
        let data_dir = root.join(".data");
        std::fs::create_dir_all(&nested).expect("nested test directory should be created");
        std::fs::create_dir_all(data_dir.join("sqlite")).expect("data directory should be created");
        std::fs::write(root.join("readme.md"), "hello").expect("supported file should be written");
        std::fs::write(nested.join("notes.tmp"), "temporary")
            .expect("unsupported file should be written");
        std::fs::write(data_dir.join("sqlite").join("office-agent.sqlite3"), "db")
            .expect("workspace data file should be written");

        let mut connection = Connection::open_in_memory().expect("in-memory SQLite should open");
        migrate_sqlite(&connection).expect("schema should migrate");
        let result = index_workspace_files_with_connection(&mut connection, &root, &data_dir)
            .expect("workspace files should index");

        assert_eq!(result.files_indexed, 2);
        assert_eq!(table_count(&connection, "documents"), 2);
        let unsupported_count: i64 = connection
            .query_row(
                "SELECT count(*) FROM documents WHERE filename = ?1 AND extension = ?2",
                params!["notes.tmp", "tmp"],
                |row| row.get(0),
            )
            .expect("unsupported file metadata should be readable");
        let data_count: i64 = connection
            .query_row(
                "SELECT count(*) FROM documents WHERE path LIKE ?1",
                params![format!("%{}%", ".data")],
                |row| row.get(0),
            )
            .expect("workspace data metadata count should be readable");

        assert_eq!(unsupported_count, 1);
        assert_eq!(data_count, 0);

        let _ = std::fs::remove_dir_all(root);
    }

    fn table_count(connection: &Connection, table: &str) -> i64 {
        connection
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .expect("table count should be readable")
    }
}
