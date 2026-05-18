use std::path::PathBuf;

#[cfg(test)]
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Manager;

use super::document_index::IndexedChunk;
#[cfg(test)]
use super::unix_timestamp_seconds;

mod document;
mod migration;
mod workspace;

pub(crate) use document::{index_document_structure, search_document_full_text};
pub(super) use migration::migrate_sqlite;
pub(crate) use workspace::{
    index_workspace_files, load_workspace_snapshot, remove_workspace_documents,
    save_workspace_file_metadata,
};

#[cfg(test)]
use document::index_document_structure_with_connection;
#[cfg(test)]
use workspace::{
    index_workspace_files_with_connection, save_workspace_file_metadata_with_connection,
};

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
    qdrant_vectors_indexed: usize,
    text_bytes_indexed: usize,
}

struct PersistedDocumentIndex {
    result: DocumentIndexResult,
    document_id: String,
    filename: String,
    chunks: Vec<IndexedChunk>,
}

#[derive(Debug, Serialize)]
pub(crate) struct FullTextSearchHit {
    document_id: String,
    filename: String,
    path: Option<String>,
    node_id: String,
    node_type: String,
    title: Option<String>,
    text: String,
    order_index: i64,
    metadata_json: String,
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
pub(crate) struct WorkspaceDocumentsRemovalResult {
    pub(super) document_ids: Vec<String>,
    pub(super) documents_deleted: usize,
    pub(super) tree_nodes_deleted: usize,
    pub(super) document_nodes_deleted: usize,
    pub(super) chunks_deleted: usize,
    pub(super) empty_folders_pruned: usize,
}

#[derive(Debug, Serialize)]
pub(crate) struct WorkspaceFilesMetadataResult {
    files_indexed: usize,
}

#[derive(Debug, Serialize)]
pub(crate) struct WorkspaceFileMetadataRecord {
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
pub(crate) struct WorkspaceTreeNodeRecord {
    id: String,
    parent_id: Option<String>,
    workspace_path: String,
    node_type: String,
    name: String,
    relative_path: String,
    document_id: Option<String>,
    order_index: i64,
    is_expanded: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct WorkspaceSnapshotResult {
    workspace_path: Option<String>,
    workspace_name: String,
    files: Vec<WorkspaceFileMetadataRecord>,
    tree_nodes: Vec<WorkspaceTreeNodeRecord>,
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
        assert_eq!(table_count("workspace_tree_nodes"), 1);
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

        let persisted = index_document_structure_with_connection(
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
        let result = persisted.result;

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
        assert!(row.2.contains("Heading"));
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
        assert!(table_count(&connection, "workspace_tree_nodes") >= 4);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn removes_workspace_document_metadata_and_index_rows() {
        let mut connection = Connection::open_in_memory().expect("in-memory SQLite should open");
        migrate_sqlite(&connection).expect("schema should migrate");

        save_workspace_file_metadata_with_connection(
            &connection,
            WorkspaceFileMetadataRequest {
                document_id: "path:/tmp/workspace/readme.md".to_string(),
                filename: "readme.md".to_string(),
                path: "/tmp/workspace/readme.md".to_string(),
                relative_path: Some("workspace/docs/readme.md".to_string()),
                extension: Some("md".to_string()),
                file_type: Some("md".to_string()),
                size_bytes: Some(42),
                modified_at: Some(1_700_000_000),
            },
        )
        .expect("metadata should save");

        index_document_structure_with_connection(
            &mut connection,
            DocumentIndexRequest {
                document_id: "path:/tmp/workspace/readme.md".to_string(),
                filename: "readme.md".to_string(),
                path: Some("/tmp/workspace/readme.md".to_string()),
                original_path: None,
                stored_path: None,
                extension: Some("md".to_string()),
                file_type: Some("md".to_string()),
                size_bytes: Some(42),
                sha256: None,
                parse_status: None,
                index_status: None,
                blocks: json!([
                    {"id": "p1", "type": "paragraph", "text": "hello workspace"}
                ]),
            },
        )
        .expect("document should index");

        let result = workspace::remove_workspace_documents_with_connection(
            &mut connection,
            &["path:/tmp/workspace/readme.md".to_string()],
        )
        .expect("workspace document should remove");

        assert_eq!(result.documents_deleted, 1);
        assert_eq!(result.tree_nodes_deleted, 1);
        assert_eq!(table_count(&connection, "documents"), 0);
        assert_eq!(table_count(&connection, "doc_nodes"), 0);
        assert_eq!(table_count(&connection, "chunks"), 0);

        let file_tree_nodes: i64 = connection
            .query_row(
                "SELECT count(*) FROM workspace_tree_nodes WHERE node_type = 'file'",
                [],
                |row| row.get(0),
            )
            .expect("file tree node count should read");
        assert_eq!(file_tree_nodes, 0);
    }

    fn table_count(connection: &Connection, table: &str) -> i64 {
        connection
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .expect("table count should be readable")
    }
}
