use std::{
    path::PathBuf,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::Connection;
use tauri::{Manager, State};

mod document_index;
mod qdrant;
mod sqlite_store;

pub(crate) struct DocumentStore {
    connection: Mutex<Connection>,
    qdrant_connection: Mutex<Connection>,
    qdrant_path: PathBuf,
}

pub(crate) fn setup_storage(app: &mut tauri::App) -> Result<(), String> {
    let db_path = sqlite_store::sqlite_db_path(app)?;
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!(
                "cannot create SQLite database directory {}: {error}",
                parent.display()
            )
        })?;
    }

    let connection = Connection::open(&db_path)
        .map_err(|error| format!("cannot open SQLite database {}: {error}", db_path.display()))?;
    sqlite_store::migrate_sqlite(&connection)?;

    let qdrant_path = qdrant::qdrant_db_path(app)?;
    if let Some(parent) = qdrant_path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!(
                "cannot create embedded Qdrant directory {}: {error}",
                parent.display()
            )
        })?;
    }
    let qdrant_connection = Connection::open(&qdrant_path).map_err(|error| {
        format!(
            "cannot open embedded Qdrant store {}: {error}",
            qdrant_path.display()
        )
    })?;
    qdrant::migrate_qdrant(&qdrant_connection)?;

    app.manage(DocumentStore {
        connection: Mutex::new(connection),
        qdrant_connection: Mutex::new(qdrant_connection),
        qdrant_path,
    });
    Ok(())
}

#[tauri::command]
pub(crate) fn index_document_structure(
    state: State<'_, DocumentStore>,
    request: sqlite_store::DocumentIndexRequest,
) -> Result<sqlite_store::DocumentIndexResult, String> {
    sqlite_store::index_document_structure(state, request)
}

#[tauri::command]
pub(crate) fn search_document_full_text(
    state: State<'_, DocumentStore>,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<sqlite_store::FullTextSearchHit>, String> {
    sqlite_store::search_document_full_text(state, query, limit)
}

#[tauri::command]
pub(crate) async fn get_qdrant_status(
    state: State<'_, DocumentStore>,
) -> Result<qdrant::QdrantStatus, String> {
    qdrant::get_qdrant_status(state).await
}

#[tauri::command]
pub(crate) async fn ensure_qdrant_collection(
    state: State<'_, DocumentStore>,
    request: qdrant::QdrantCollectionRequest,
) -> Result<qdrant::QdrantStatus, String> {
    qdrant::ensure_qdrant_collection(state, request).await
}

#[tauri::command]
pub(crate) async fn upsert_qdrant_vectors(
    state: State<'_, DocumentStore>,
    request: qdrant::QdrantUpsertRequest,
) -> Result<qdrant::QdrantUpsertResult, String> {
    qdrant::upsert_qdrant_vectors(state, request).await
}

#[tauri::command]
pub(crate) async fn upsert_qdrant_chunk_vectors(
    state: State<'_, DocumentStore>,
    request: qdrant::QdrantChunkUpsertRequest,
) -> Result<qdrant::QdrantUpsertResult, String> {
    qdrant::upsert_qdrant_chunk_vectors(state, request).await
}

#[tauri::command]
pub(crate) async fn search_qdrant_vectors(
    state: State<'_, DocumentStore>,
    request: qdrant::QdrantSearchRequest,
) -> Result<serde_json::Value, String> {
    qdrant::search_qdrant_vectors(state, request).await
}

pub(super) fn unix_timestamp_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}
