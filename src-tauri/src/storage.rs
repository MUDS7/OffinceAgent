use std::{
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use reqwest::{header, Client};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{Manager, State};

const DEFAULT_QDRANT_URL: &str = "http://127.0.0.1:6333";
const DEFAULT_QDRANT_COLLECTION: &str = "officeagent_documents";

pub(crate) struct DocumentStore {
    connection: Mutex<Connection>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct DocumentIndexRequest {
    document_id: String,
    filename: String,
    path: Option<String>,
    extension: Option<String>,
    size_bytes: Option<u64>,
    sha256: Option<String>,
    blocks: Value,
}

#[derive(Debug, Serialize)]
pub(crate) struct DocumentIndexResult {
    document_id: String,
    blocks_indexed: usize,
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

#[derive(Debug, Deserialize)]
pub(crate) struct QdrantCollectionRequest {
    collection: Option<String>,
    vector_size: u64,
    distance: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct QdrantVectorPoint {
    id: String,
    vector: Vec<f32>,
    payload: Option<Value>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct QdrantUpsertRequest {
    collection: Option<String>,
    points: Vec<QdrantVectorPoint>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct QdrantSearchRequest {
    collection: Option<String>,
    vector: Vec<f32>,
    limit: Option<u64>,
    filter: Option<Value>,
}

#[derive(Debug, Serialize)]
pub(crate) struct QdrantStatus {
    url: String,
    collection: String,
    reachable: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct QdrantUpsertResult {
    collection: String,
    points_upserted: usize,
}

pub(crate) fn setup_storage(app: &mut tauri::App) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("cannot resolve app data directory: {error}"))?;
    std::fs::create_dir_all(&data_dir).map_err(|error| {
        format!(
            "cannot create app data directory {}: {error}",
            data_dir.display()
        )
    })?;

    let db_path = data_dir.join("office-agent.sqlite3");
    let connection = Connection::open(&db_path)
        .map_err(|error| format!("cannot open SQLite database {}: {error}", db_path.display()))?;
    migrate_sqlite(&connection)?;
    app.manage(DocumentStore {
        connection: Mutex::new(connection),
    });
    Ok(())
}

#[tauri::command]
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
    let now = unix_timestamp_seconds();

    transaction
        .execute(
            "INSERT INTO documents (
                id, path, filename, extension, sha256, size_bytes, indexed_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET
                path = excluded.path,
                filename = excluded.filename,
                extension = excluded.extension,
                sha256 = excluded.sha256,
                size_bytes = excluded.size_bytes,
                indexed_at = excluded.indexed_at",
            params![
                request.document_id,
                request.path,
                request.filename,
                extension,
                request.sha256,
                request.size_bytes.map(|size| size as i64),
                now,
            ],
        )
        .map_err(|error| format!("cannot upsert document metadata: {error}"))?;

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

    transaction
        .commit()
        .map_err(|error| format!("cannot commit SQLite document index: {error}"))?;

    Ok(DocumentIndexResult {
        document_id: request.document_id,
        blocks_indexed: flattened.len(),
        text_bytes_indexed,
    })
}

#[tauri::command]
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
            "SELECT document_id, block_id, filename, path,
                    snippet(document_fts, 4, '[', ']', '...', 24), rank
             FROM document_fts
             WHERE document_fts MATCH ?1
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

#[tauri::command]
pub(crate) async fn get_qdrant_status() -> Result<QdrantStatus, String> {
    let config = QdrantConfig::from_env(None);
    let client = qdrant_http_client()?;
    let response = qdrant_request(client.get(format!("{}/collections", config.url)), &config)
        .send()
        .await;

    Ok(QdrantStatus {
        url: config.url,
        collection: config.collection,
        reachable: response
            .map(|value| value.status().is_success())
            .unwrap_or(false),
    })
}

#[tauri::command]
pub(crate) async fn ensure_qdrant_collection(
    request: QdrantCollectionRequest,
) -> Result<QdrantStatus, String> {
    let config = QdrantConfig::from_env(request.collection);
    let client = qdrant_http_client()?;
    let distance = request.distance.unwrap_or_else(|| "Cosine".to_string());
    let response = qdrant_request(
        client.put(format!("{}/collections/{}", config.url, config.collection)),
        &config,
    )
    .json(&json!({
        "vectors": {
            "size": request.vector_size,
            "distance": distance,
        },
    }))
    .send()
    .await
    .map_err(|error| format!("cannot connect to Qdrant: {error}"))?;

    if !response.status().is_success() {
        return Err(format_qdrant_error(response, "cannot create Qdrant collection").await);
    }

    Ok(QdrantStatus {
        url: config.url,
        collection: config.collection,
        reachable: true,
    })
}

#[tauri::command]
pub(crate) async fn upsert_qdrant_vectors(
    request: QdrantUpsertRequest,
) -> Result<QdrantUpsertResult, String> {
    let config = QdrantConfig::from_env(request.collection);
    let point_count = request.points.len();
    let points = request
        .points
        .into_iter()
        .map(|point| {
            let mut payload = match point.payload {
                Some(Value::Object(map)) => map,
                Some(value) => {
                    let mut map = Map::new();
                    map.insert("value".to_string(), value);
                    map
                }
                None => Map::new(),
            };
            payload.insert("external_id".to_string(), Value::String(point.id.clone()));
            json!({
                "id": stable_point_id(&point.id),
                "vector": point.vector,
                "payload": payload,
            })
        })
        .collect::<Vec<_>>();

    let client = qdrant_http_client()?;
    let response = qdrant_request(
        client.put(format!(
            "{}/collections/{}/points?wait=true",
            config.url, config.collection
        )),
        &config,
    )
    .json(&json!({ "points": points }))
    .send()
    .await
    .map_err(|error| format!("cannot connect to Qdrant: {error}"))?;

    if !response.status().is_success() {
        return Err(format_qdrant_error(response, "cannot upsert Qdrant vectors").await);
    }

    Ok(QdrantUpsertResult {
        collection: config.collection,
        points_upserted: point_count,
    })
}

#[tauri::command]
pub(crate) async fn search_qdrant_vectors(request: QdrantSearchRequest) -> Result<Value, String> {
    let config = QdrantConfig::from_env(request.collection);
    let mut body = json!({
        "vector": request.vector,
        "limit": request.limit.unwrap_or(10).min(100),
        "with_payload": true,
    });
    if let Some(filter) = request.filter {
        body["filter"] = filter;
    }

    let client = qdrant_http_client()?;
    let response = qdrant_request(
        client.post(format!(
            "{}/collections/{}/points/search",
            config.url, config.collection
        )),
        &config,
    )
    .json(&body)
    .send()
    .await
    .map_err(|error| format!("cannot connect to Qdrant: {error}"))?;

    if !response.status().is_success() {
        return Err(format_qdrant_error(response, "cannot search Qdrant vectors").await);
    }

    response
        .json::<Value>()
        .await
        .map_err(|error| format!("cannot parse Qdrant search response: {error}"))
}

fn migrate_sqlite(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS documents (
                id TEXT PRIMARY KEY,
                path TEXT,
                filename TEXT NOT NULL,
                extension TEXT NOT NULL,
                sha256 TEXT,
                size_bytes INTEGER,
                indexed_at INTEGER NOT NULL
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

            CREATE INDEX IF NOT EXISTS idx_document_blocks_document
                ON document_blocks(document_id, block_index);
            ",
        )
        .map(|_| ())
        .map_err(|error| format!("cannot migrate SQLite document store: {error}"))
}

struct FlattenedBlock {
    block_id: String,
    block_type: String,
    block_index: usize,
    parent_id: Option<String>,
    text: String,
    metadata_json: String,
}

fn flatten_document_blocks(blocks: &Value) -> Vec<FlattenedBlock> {
    let Some(blocks) = blocks.as_array() else {
        return Vec::new();
    };

    let mut flattened = Vec::new();
    for (index, block) in blocks.iter().enumerate() {
        let block_id = block
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("block-{index}"));
        let block_type = block
            .get("type")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| "unknown".to_string());
        let text = extract_block_text(block);
        flattened.push(FlattenedBlock {
            block_id,
            block_type,
            block_index: index,
            parent_id: None,
            text,
            metadata_json: block.to_string(),
        });
    }

    flattened
}

fn extract_block_text(block: &Value) -> String {
    match block.get("type").and_then(Value::as_str) {
        Some("paragraph") => block
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        Some("table") => block
            .get("rows")
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .map(|row| {
                        row.as_array()
                            .map(|cells| {
                                cells
                                    .iter()
                                    .map(|cell| {
                                        cell.get("text").and_then(Value::as_str).unwrap_or_default()
                                    })
                                    .collect::<Vec<_>>()
                                    .join("\t")
                            })
                            .unwrap_or_default()
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default(),
        Some("image") => block
            .get("alt_text")
            .and_then(Value::as_str)
            .or_else(|| block.get("filename").and_then(Value::as_str))
            .unwrap_or_default()
            .to_string(),
        _ => String::new(),
    }
}

fn build_safe_fts_query(query: &str) -> Option<String> {
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

fn unix_timestamp_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

struct QdrantConfig {
    url: String,
    collection: String,
    api_key: Option<String>,
}

impl QdrantConfig {
    fn from_env(collection: Option<String>) -> Self {
        let url = std::env::var("OFFICE_AGENT_QDRANT_URL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_QDRANT_URL.to_string())
            .trim_end_matches('/')
            .to_string();
        let collection = collection
            .or_else(|| std::env::var("OFFICE_AGENT_QDRANT_COLLECTION").ok())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_QDRANT_COLLECTION.to_string());
        let api_key = std::env::var("OFFICE_AGENT_QDRANT_API_KEY")
            .ok()
            .filter(|value| !value.trim().is_empty());

        Self {
            url,
            collection,
            api_key,
        }
    }
}

fn qdrant_http_client() -> Result<Client, String> {
    Client::builder()
        .build()
        .map_err(|error| format!("cannot create Qdrant HTTP client: {error}"))
}

fn qdrant_request(
    mut builder: reqwest::RequestBuilder,
    config: &QdrantConfig,
) -> reqwest::RequestBuilder {
    if let Some(api_key) = &config.api_key {
        builder = builder.header("api-key", api_key);
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {api_key}"));
    }
    builder
}

async fn format_qdrant_error(response: reqwest::Response, context: &str) -> String {
    let status = response.status();
    let detail = response.text().await.unwrap_or_default();
    if detail.trim().is_empty() {
        format!("{context}: Qdrant returned {status}")
    } else {
        format!("{context}: Qdrant returned {status}: {}", detail.trim())
    }
}

fn stable_point_id(value: &str) -> u64 {
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;
    value.bytes().fold(FNV_OFFSET, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(FNV_PRIME)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_docx_table_text() {
        let block = json!({
            "type": "table",
            "rows": [
                [{ "text": "A" }, { "text": "B" }],
                [{ "text": "C" }, { "text": "D" }]
            ]
        });

        assert_eq!(extract_block_text(&block), "A\tB\nC\tD");
    }

    #[test]
    fn builds_quoted_fts_query() {
        assert_eq!(
            build_safe_fts_query("alpha beta"),
            Some("\"alpha\" \"beta\"".to_string())
        );
    }

    #[test]
    fn migrates_sqlite_schema_with_fts() {
        let connection = Connection::open_in_memory().expect("in-memory SQLite should open");
        migrate_sqlite(&connection).expect("schema should migrate");

        connection
            .execute(
                "INSERT INTO document_fts (document_id, block_id, filename, path, text)
                 VALUES ('doc', 'block', 'demo.docx', NULL, 'alpha beta gamma')",
                [],
            )
            .expect("FTS row should insert");

        let count: i64 = connection
            .query_row(
                "SELECT count(*) FROM document_fts WHERE document_fts MATCH ?1",
                params![build_safe_fts_query("alpha").unwrap()],
                |row| row.get(0),
            )
            .expect("FTS query should run");
        assert_eq!(count, 1);
    }
}
