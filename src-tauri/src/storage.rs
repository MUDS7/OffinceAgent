use std::{
    cmp::Ordering,
    path::PathBuf,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{Manager, State};

const DEFAULT_QDRANT_COLLECTION: &str = "officeagent_documents";
const DEFAULT_QDRANT_DB_NAME: &str = "office-agent-qdrant.sqlite3";

pub(crate) struct DocumentStore {
    connection: Mutex<Connection>,
    qdrant_connection: Mutex<Connection>,
    qdrant_path: PathBuf,
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
    path: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct QdrantUpsertResult {
    collection: String,
    points_upserted: usize,
}

pub(crate) fn setup_storage(app: &mut tauri::App) -> Result<(), String> {
    let db_path = sqlite_db_path(app)?;
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
    migrate_sqlite(&connection)?;

    let qdrant_path = qdrant_db_path(app)?;
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
    migrate_qdrant(&qdrant_connection)?;

    app.manage(DocumentStore {
        connection: Mutex::new(connection),
        qdrant_connection: Mutex::new(qdrant_connection),
        qdrant_path,
    });
    Ok(())
}

fn sqlite_db_path(app: &tauri::App) -> Result<PathBuf, String> {
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

fn qdrant_db_path(app: &tauri::App) -> Result<PathBuf, String> {
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
pub(crate) async fn get_qdrant_status(
    state: State<'_, DocumentStore>,
) -> Result<QdrantStatus, String> {
    let config = QdrantConfig::from_store(&state, None);
    Ok(QdrantStatus {
        url: config.local_url(),
        collection: config.collection,
        reachable: true,
        path: config.path.display().to_string(),
    })
}

#[tauri::command]
pub(crate) async fn ensure_qdrant_collection(
    state: State<'_, DocumentStore>,
    request: QdrantCollectionRequest,
) -> Result<QdrantStatus, String> {
    let config = QdrantConfig::from_store(&state, request.collection);
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

#[tauri::command]
pub(crate) async fn upsert_qdrant_vectors(
    state: State<'_, DocumentStore>,
    request: QdrantUpsertRequest,
) -> Result<QdrantUpsertResult, String> {
    let config = QdrantConfig::from_store(&state, request.collection);
    let point_count = request.points.len();
    let mut connection = state
        .qdrant_connection
        .lock()
        .map_err(|_| "embedded Qdrant store lock is poisoned".to_string())?;

    let collection = get_or_create_collection(&connection, &config.collection, &request.points)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("cannot start embedded Qdrant transaction: {error}"))?;

    for point in request.points {
        if point.vector.len() as u64 != collection.vector_size {
            return Err(format!(
                "cannot upsert Qdrant vector {}: expected dimension {}, got {}",
                point.id,
                collection.vector_size,
                point.vector.len()
            ));
        }

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
        let point_id = stable_point_id(&point.id).to_string();
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
                    &config.collection,
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
        collection: config.collection,
        points_upserted: point_count,
    })
}

#[tauri::command]
pub(crate) async fn search_qdrant_vectors(
    state: State<'_, DocumentStore>,
    request: QdrantSearchRequest,
) -> Result<Value, String> {
    let config = QdrantConfig::from_store(&state, request.collection);
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

fn migrate_qdrant(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS qdrant_collections (
                name TEXT PRIMARY KEY,
                vector_size INTEGER NOT NULL,
                distance TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS qdrant_points (
                collection TEXT NOT NULL,
                point_id TEXT NOT NULL,
                external_id TEXT NOT NULL,
                vector_json TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (collection, point_id),
                FOREIGN KEY (collection) REFERENCES qdrant_collections(name) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_qdrant_points_collection
                ON qdrant_points(collection);
            ",
        )
        .map(|_| ())
        .map_err(|error| format!("cannot migrate embedded Qdrant store: {error}"))
}

#[derive(Clone)]
struct QdrantCollection {
    vector_size: u64,
    distance: String,
}

struct QdrantStoredPoint {
    point_id: String,
    external_id: String,
    vector_json: String,
    payload_json: String,
}

struct QdrantSearchHit {
    point_id: String,
    score: f64,
    payload: Value,
}

fn upsert_qdrant_collection(
    connection: &Connection,
    collection: &str,
    vector_size: u64,
    distance: &str,
) -> Result<(), String> {
    let now = unix_timestamp_seconds();
    connection
        .execute(
            "INSERT INTO qdrant_collections (name, vector_size, distance, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(name) DO UPDATE SET
                vector_size = excluded.vector_size,
                distance = excluded.distance,
                updated_at = excluded.updated_at",
            params![
                collection,
                vector_size as i64,
                normalize_distance(distance),
                now
            ],
        )
        .map(|_| ())
        .map_err(|error| format!("cannot create embedded Qdrant collection: {error}"))
}

fn get_or_create_collection(
    connection: &Connection,
    collection: &str,
    points: &[QdrantVectorPoint],
) -> Result<QdrantCollection, String> {
    if let Some(collection) = get_qdrant_collection(connection, collection)? {
        return Ok(collection);
    }

    let vector_size = points
        .first()
        .map(|point| point.vector.len() as u64)
        .unwrap_or(0);
    upsert_qdrant_collection(connection, collection, vector_size, "Cosine")?;
    Ok(QdrantCollection {
        vector_size,
        distance: "Cosine".to_string(),
    })
}

fn get_qdrant_collection(
    connection: &Connection,
    collection: &str,
) -> Result<Option<QdrantCollection>, String> {
    let mut statement = connection
        .prepare("SELECT vector_size, distance FROM qdrant_collections WHERE name = ?1")
        .map_err(|error| format!("cannot prepare embedded Qdrant collection lookup: {error}"))?;
    let mut rows = statement
        .query(params![collection])
        .map_err(|error| format!("cannot lookup embedded Qdrant collection: {error}"))?;
    let Some(row) = rows
        .next()
        .map_err(|error| format!("cannot read embedded Qdrant collection: {error}"))?
    else {
        return Ok(None);
    };

    let vector_size: i64 = row
        .get(0)
        .map_err(|error| format!("cannot read embedded Qdrant vector size: {error}"))?;
    let distance: String = row
        .get(1)
        .map_err(|error| format!("cannot read embedded Qdrant distance: {error}"))?;
    Ok(Some(QdrantCollection {
        vector_size: vector_size.max(0) as u64,
        distance,
    }))
}

fn normalize_distance(distance: &str) -> String {
    match distance.trim().to_ascii_lowercase().as_str() {
        "dot" => "Dot".to_string(),
        "euclid" | "euclidean" => "Euclid".to_string(),
        "manhattan" => "Manhattan".to_string(),
        _ => "Cosine".to_string(),
    }
}

fn score_vectors(query: &[f32], candidate: &[f32], distance: &str) -> f64 {
    match normalize_distance(distance).as_str() {
        "Dot" => query
            .iter()
            .zip(candidate)
            .map(|(left, right)| f64::from(*left) * f64::from(*right))
            .sum(),
        "Euclid" => query
            .iter()
            .zip(candidate)
            .map(|(left, right)| {
                let delta = f64::from(*left) - f64::from(*right);
                delta * delta
            })
            .sum::<f64>()
            .sqrt(),
        "Manhattan" => query
            .iter()
            .zip(candidate)
            .map(|(left, right)| (f64::from(*left) - f64::from(*right)).abs())
            .sum(),
        _ => cosine_similarity(query, candidate),
    }
}

fn cosine_similarity(query: &[f32], candidate: &[f32]) -> f64 {
    let mut dot = 0.0;
    let mut query_norm = 0.0;
    let mut candidate_norm = 0.0;
    for (left, right) in query.iter().zip(candidate) {
        let left = f64::from(*left);
        let right = f64::from(*right);
        dot += left * right;
        query_norm += left * left;
        candidate_norm += right * right;
    }

    if query_norm == 0.0 || candidate_norm == 0.0 {
        0.0
    } else {
        dot / (query_norm.sqrt() * candidate_norm.sqrt())
    }
}

fn sort_qdrant_hits(hits: &mut [QdrantSearchHit], distance: &str) {
    let normalized = normalize_distance(distance);
    hits.sort_by(|left, right| {
        let ordering = left
            .score
            .partial_cmp(&right.score)
            .unwrap_or(Ordering::Equal);
        if normalized == "Euclid" || normalized == "Manhattan" {
            ordering
        } else {
            ordering.reverse()
        }
    });
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
    path: PathBuf,
    collection: String,
}

impl QdrantConfig {
    fn from_store(store: &DocumentStore, collection: Option<String>) -> Self {
        let collection = collection
            .or_else(|| std::env::var("OFFICE_AGENT_QDRANT_COLLECTION").ok())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_QDRANT_COLLECTION.to_string());

        Self {
            path: store.qdrant_path.clone(),
            collection,
        }
    }

    fn local_url(&self) -> String {
        format!("embedded://{}", self.path.display())
    }
}

fn matches_qdrant_filter(
    payload: &Value,
    filter: &Value,
    point_id: &str,
    external_id: &str,
) -> bool {
    let Some(filter) = filter.as_object() else {
        return true;
    };

    if let Some(must) = filter.get("must") {
        if !filter_conditions(must)
            .iter()
            .all(|condition| matches_qdrant_condition(payload, condition, point_id, external_id))
        {
            return false;
        }
    }
    if let Some(should) = filter.get("should") {
        let conditions = filter_conditions(should);
        if !conditions.is_empty()
            && !conditions.iter().any(|condition| {
                matches_qdrant_condition(payload, condition, point_id, external_id)
            })
        {
            return false;
        }
    }
    if let Some(must_not) = filter.get("must_not") {
        if filter_conditions(must_not)
            .iter()
            .any(|condition| matches_qdrant_condition(payload, condition, point_id, external_id))
        {
            return false;
        }
    }

    if filter.contains_key("key") || filter.contains_key("has_id") {
        return matches_qdrant_condition(
            payload,
            &Value::Object(filter.clone()),
            point_id,
            external_id,
        );
    }

    true
}

fn filter_conditions(value: &Value) -> Vec<&Value> {
    value
        .as_array()
        .map(|items| items.iter().collect())
        .unwrap_or_else(|| vec![value])
}

fn matches_qdrant_condition(
    payload: &Value,
    condition: &Value,
    point_id: &str,
    external_id: &str,
) -> bool {
    let Some(condition) = condition.as_object() else {
        return true;
    };

    if condition.contains_key("must")
        || condition.contains_key("should")
        || condition.contains_key("must_not")
    {
        return matches_qdrant_filter(
            payload,
            &Value::Object(condition.clone()),
            point_id,
            external_id,
        );
    }

    if let Some(has_id) = condition.get("has_id") {
        return filter_conditions(has_id)
            .iter()
            .any(|id| id_matches(id, point_id) || id_matches(id, external_id));
    }

    let Some(key) = condition.get("key").and_then(Value::as_str) else {
        return true;
    };
    let Some(value) = payload_value(payload, key) else {
        return false;
    };

    if let Some(match_value) = condition.get("match") {
        return matches_qdrant_match(value, match_value);
    }
    if let Some(range) = condition.get("range") {
        return matches_qdrant_range(value, range);
    }
    true
}

fn id_matches(expected: &Value, id: &str) -> bool {
    match expected {
        Value::String(value) => value == id,
        Value::Number(value) => value.to_string() == id,
        _ => false,
    }
}

fn payload_value<'a>(payload: &'a Value, key: &str) -> Option<&'a Value> {
    let mut current = payload;
    for part in key.split('.') {
        current = current.get(part)?;
    }
    Some(current)
}

fn matches_qdrant_match(value: &Value, expected: &Value) -> bool {
    let Some(expected) = expected.as_object() else {
        return values_equal(value, expected);
    };
    if let Some(single) = expected.get("value") {
        return values_equal(value, single);
    }
    if let Some(text) = expected.get("text").and_then(Value::as_str) {
        return value
            .as_str()
            .map(|actual| actual.contains(text))
            .unwrap_or(false);
    }
    if let Some(any) = expected.get("any").and_then(Value::as_array) {
        return any.iter().any(|candidate| values_equal(value, candidate));
    }
    if let Some(except) = expected.get("except").and_then(Value::as_array) {
        return !except
            .iter()
            .any(|candidate| values_equal(value, candidate));
    }
    true
}

fn matches_qdrant_range(value: &Value, range: &Value) -> bool {
    let Some(actual) = value.as_f64() else {
        return false;
    };
    let Some(range) = range.as_object() else {
        return true;
    };
    if let Some(gt) = range.get("gt").and_then(Value::as_f64) {
        if actual <= gt {
            return false;
        }
    }
    if let Some(gte) = range.get("gte").and_then(Value::as_f64) {
        if actual < gte {
            return false;
        }
    }
    if let Some(lt) = range.get("lt").and_then(Value::as_f64) {
        if actual >= lt {
            return false;
        }
    }
    if let Some(lte) = range.get("lte").and_then(Value::as_f64) {
        if actual > lte {
            return false;
        }
    }
    true
}

fn values_equal(actual: &Value, expected: &Value) -> bool {
    actual == expected
        || actual
            .as_str()
            .zip(expected.as_str())
            .map(|(left, right)| left.eq_ignore_ascii_case(right))
            .unwrap_or(false)
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

    #[test]
    fn embedded_qdrant_sorts_cosine_hits() {
        let mut hits = vec![
            QdrantSearchHit {
                point_id: "1".to_string(),
                score: score_vectors(&[1.0, 0.0], &[0.0, 1.0], "Cosine"),
                payload: json!({}),
            },
            QdrantSearchHit {
                point_id: "2".to_string(),
                score: score_vectors(&[1.0, 0.0], &[1.0, 0.0], "Cosine"),
                payload: json!({}),
            },
        ];

        sort_qdrant_hits(&mut hits, "Cosine");

        assert_eq!(hits[0].point_id, "2");
        assert!((hits[0].score - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn embedded_qdrant_matches_basic_payload_filter() {
        let payload = json!({
            "document_id": "doc-1",
            "page": 3,
            "nested": { "kind": "paragraph" }
        });
        let filter = json!({
            "must": [
                { "key": "document_id", "match": { "value": "doc-1" } },
                { "key": "page", "range": { "gte": 2, "lte": 4 } },
                { "key": "nested.kind", "match": { "value": "paragraph" } }
            ]
        });

        assert!(matches_qdrant_filter(&payload, &filter, "42", "block-1"));
    }
}
