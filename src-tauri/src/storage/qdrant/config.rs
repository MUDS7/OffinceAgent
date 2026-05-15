use std::path::PathBuf;

use tauri::Manager;

use crate::storage::DocumentStore;

const DEFAULT_QDRANT_COLLECTION: &str = "office_agent_chunks";
const DEFAULT_QDRANT_DB_NAME: &str = "office-agent-qdrant.sqlite3";

pub(crate) fn qdrant_db_path(app: &tauri::App) -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("OFFICE_AGENT_QDRANT_PATH") {
        if !path.trim().is_empty() {
            let path = PathBuf::from(path);
            return if path.extension().is_some() {
                Ok(path)
            } else {
                Ok(path.join(DEFAULT_QDRANT_DB_NAME))
            };
        }
    }

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("cannot resolve app data directory: {error}"))?;

    Ok(data_dir.join("qdrant").join(DEFAULT_QDRANT_DB_NAME))
}

pub(super) struct QdrantConfig {
    pub(super) path: PathBuf,
    pub(super) collection: String,
}

impl QdrantConfig {
    pub(super) fn from_store(
        store: &DocumentStore,
        collection: Option<String>,
    ) -> Result<Self, String> {
        let collection = collection
            .or_else(|| std::env::var("OFFICE_AGENT_QDRANT_COLLECTION").ok())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_QDRANT_COLLECTION.to_string());

        let path = store
            .qdrant_path
            .lock()
            .map_err(|_| "embedded Qdrant path lock is poisoned".to_string())?
            .clone();

        Ok(Self { path, collection })
    }

    pub(super) fn local_url(&self) -> String {
        format!("embedded://{}", self.path.display())
    }
}
