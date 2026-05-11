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

mod sqlite_store;

pub(crate) struct DocumentStore {
    connection: Mutex<Connection>,
    qdrant_connection: Mutex<Connection>,
    qdrant_path: PathBuf,
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

#[derive(Default)]
struct BuiltDocumentIndex {
    nodes: Vec<IndexedNode>,
    chunks: Vec<IndexedChunk>,
    assets: Vec<IndexedAsset>,
    chunk_assets: Vec<ChunkAssetLink>,
}

struct IndexedNode {
    id: String,
    parent_id: Option<String>,
    node_type: String,
    level: Option<i32>,
    title: Option<String>,
    text: Option<String>,
    order_index: usize,
    metadata_json: String,
}

struct IndexedChunk {
    id: String,
    node_ids_json: String,
    heading_path_json: String,
    heading_path_text: String,
    chunk_type: String,
    content: String,
    content_for_embedding: String,
    order_index: usize,
    token_count: usize,
}

struct IndexedAsset {
    id: String,
    node_id: Option<String>,
    asset_type: String,
    file_path: Option<String>,
    caption: Option<String>,
    description: Option<String>,
    nearby_text: Option<String>,
    metadata_json: String,
}

struct ChunkAssetLink {
    chunk_id: String,
    asset_id: String,
    relation_type: String,
}

#[derive(Clone)]
struct HeadingContext {
    node_id: String,
    level: i32,
    title: String,
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

fn build_document_index(document_id: &str, blocks: &Value) -> BuiltDocumentIndex {
    let Some(blocks) = blocks.as_array() else {
        return BuiltDocumentIndex::default();
    };

    let mut index = BuiltDocumentIndex::default();
    let mut heading_stack: Vec<HeadingContext> = Vec::new();
    let mut last_chunk_id: Option<String> = None;
    let mut last_text = String::new();

    for (order_index, block) in blocks.iter().enumerate() {
        match block.get("type").and_then(Value::as_str) {
            Some("excel_sheet") => {
                build_excel_sheet_index(document_id, block, order_index, &mut index);
            }
            _ => {
                build_docx_like_block_index(
                    document_id,
                    block,
                    order_index,
                    &mut heading_stack,
                    &mut last_chunk_id,
                    &mut last_text,
                    &mut index,
                );
            }
        }
    }

    index
}

fn build_docx_like_block_index(
    document_id: &str,
    block: &Value,
    order_index: usize,
    heading_stack: &mut Vec<HeadingContext>,
    last_chunk_id: &mut Option<String>,
    last_text: &mut String,
    index: &mut BuiltDocumentIndex,
) {
    let raw_id = raw_block_id(block, order_index);
    let node_id = scoped_stable_id("node", document_id, &raw_id);
    let block_type = block
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let text = extract_block_text(block);

    if block_type == "paragraph" {
        if let Some(level) = heading_level(block) {
            while heading_stack
                .last()
                .map(|heading| heading.level >= level)
                .unwrap_or(false)
            {
                heading_stack.pop();
            }
            let parent_id = heading_stack.last().map(|heading| heading.node_id.clone());
            let title = text.trim().to_string();
            index.nodes.push(IndexedNode {
                id: node_id.clone(),
                parent_id,
                node_type: "heading".to_string(),
                level: Some(level),
                title: Some(title.clone()),
                text: (!title.is_empty()).then_some(title.clone()),
                order_index,
                metadata_json: block.to_string(),
            });
            heading_stack.push(HeadingContext {
                node_id,
                level,
                title,
            });
            return;
        }
    }

    let parent_id = heading_stack.last().map(|heading| heading.node_id.clone());
    let node_type = match block_type {
        "table" => "table",
        "image" => "image",
        "paragraph" => "paragraph",
        value => value,
    };
    let title = if node_type == "table" {
        Some(format!("Table {}", order_index + 1))
    } else if node_type == "image" {
        block
            .get("alt_text")
            .and_then(Value::as_str)
            .or_else(|| block.get("filename").and_then(Value::as_str))
            .map(str::to_string)
    } else {
        None
    };

    index.nodes.push(IndexedNode {
        id: node_id.clone(),
        parent_id,
        node_type: node_type.to_string(),
        level: None,
        title,
        text: (!text.trim().is_empty()).then_some(text.clone()),
        order_index,
        metadata_json: block.to_string(),
    });

    if node_type == "image" {
        let asset_id = scoped_stable_id("asset", document_id, &raw_id);
        let file_path = block
            .get("file_path")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                block
                    .get("filename")
                    .and_then(Value::as_str)
                    .map(|filename| format!("workspace/assets/{document_id}/images/{filename}"))
            });
        index.assets.push(IndexedAsset {
            id: asset_id.clone(),
            node_id: Some(node_id),
            asset_type: "image".to_string(),
            file_path,
            caption: block
                .get("caption")
                .and_then(Value::as_str)
                .or_else(|| block.get("alt_text").and_then(Value::as_str))
                .map(str::to_string),
            description: block
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_string),
            nearby_text: (!last_text.trim().is_empty()).then_some(last_text.clone()),
            metadata_json: block.to_string(),
        });
        if let Some(chunk_id) = last_chunk_id.clone() {
            index.chunk_assets.push(ChunkAssetLink {
                chunk_id,
                asset_id,
                relation_type: "nearby".to_string(),
            });
        }
        return;
    }

    if text.trim().is_empty() {
        return;
    }

    let heading_path = heading_stack
        .iter()
        .map(|heading| heading.title.clone())
        .collect::<Vec<_>>();
    let chunk = make_chunk(
        document_id,
        &format!("{raw_id}:chunk"),
        vec![node_id],
        heading_path,
        match node_type {
            "table" => "table_content",
            _ => "section_content",
        },
        text,
        order_index,
    );
    *last_text = chunk.content.clone();
    *last_chunk_id = Some(chunk.id.clone());
    index.chunks.push(chunk);
}

fn build_excel_sheet_index(
    document_id: &str,
    block: &Value,
    order_index: usize,
    index: &mut BuiltDocumentIndex,
) {
    let raw_id = raw_block_id(block, order_index);
    let sheet_node_id = scoped_stable_id("node", document_id, &raw_id);
    let sheet_name = block
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Sheet")
        .to_string();
    let range_label = block
        .get("range")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let title = if range_label.is_empty() {
        sheet_name.clone()
    } else {
        format!("{sheet_name} {range_label}")
    };

    index.nodes.push(IndexedNode {
        id: sheet_node_id.clone(),
        parent_id: None,
        node_type: "excel_sheet".to_string(),
        level: Some(1),
        title: Some(title.clone()),
        text: None,
        order_index,
        metadata_json: block.to_string(),
    });

    let rows = block
        .get("rows")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for (row_index, row) in rows.iter().enumerate() {
        let content = extract_excel_row_text(row);
        if content.trim().is_empty() {
            continue;
        }

        let row_raw_id = format!("{raw_id}:row:{row_index}");
        let row_node_id = scoped_stable_id("node", document_id, &row_raw_id);
        let row_range = row.get("range").and_then(Value::as_str).map(str::to_string);
        index.nodes.push(IndexedNode {
            id: row_node_id.clone(),
            parent_id: Some(sheet_node_id.clone()),
            node_type: "excel_cell_range".to_string(),
            level: None,
            title: row_range,
            text: Some(content.clone()),
            order_index: order_index * 100_000 + row_index + 1,
            metadata_json: row.to_string(),
        });
        index.chunks.push(make_chunk(
            document_id,
            &format!("{row_raw_id}:chunk"),
            vec![sheet_node_id.clone(), row_node_id],
            vec![title.clone()],
            "excel_range_content",
            content,
            order_index * 100_000 + row_index + 1,
        ));
    }
}

fn make_chunk(
    document_id: &str,
    raw_id: &str,
    node_ids: Vec<String>,
    heading_path: Vec<String>,
    chunk_type: &str,
    content: String,
    order_index: usize,
) -> IndexedChunk {
    let heading_path_text = heading_path.join("\n");
    let content_for_embedding = if heading_path_text.trim().is_empty() {
        content.clone()
    } else {
        format!("{heading_path_text}\n\n{content}")
    };
    let node_ids_json = serde_json::to_string(&node_ids).unwrap_or_else(|_| "[]".to_string());
    let heading_path_json =
        serde_json::to_string(&heading_path).unwrap_or_else(|_| "[]".to_string());
    let token_count = estimate_token_count(&content_for_embedding);

    IndexedChunk {
        id: scoped_stable_id("chunk", document_id, raw_id),
        node_ids_json,
        heading_path_json,
        heading_path_text,
        chunk_type: chunk_type.to_string(),
        content,
        content_for_embedding,
        order_index,
        token_count,
    }
}

fn raw_block_id(block: &Value, index: usize) -> String {
    block
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("block-{index}"))
}

fn scoped_stable_id(prefix: &str, document_id: &str, raw_id: &str) -> String {
    format!(
        "{prefix}_{:016x}",
        stable_point_id(&format!("{document_id}:{raw_id}"))
    )
}

fn heading_level(block: &Value) -> Option<i32> {
    if let Some(level) = block.get("level").and_then(Value::as_i64) {
        if (1..=9).contains(&level) {
            return Some(level as i32);
        }
    }

    for key in ["style_id", "style"] {
        let Some(value) = block.get(key).and_then(Value::as_str) else {
            continue;
        };
        let normalized = value.trim().to_ascii_lowercase();
        if !(normalized.contains("heading") || value.contains("标题")) {
            continue;
        }
        if let Some(level) = normalized
            .chars()
            .find(|character| character.is_ascii_digit())
            .and_then(|character| character.to_digit(10))
        {
            if (1..=9).contains(&level) {
                return Some(level as i32);
            }
        }
    }

    None
}

fn extract_excel_row_text(row: &Value) -> String {
    row.get("cells")
        .and_then(Value::as_array)
        .map(|cells| {
            cells
                .iter()
                .filter_map(|cell| {
                    let address = cell.get("address").and_then(Value::as_str).unwrap_or("");
                    let text = cell
                        .get("text")
                        .and_then(Value::as_str)
                        .or_else(|| cell.get("value").and_then(Value::as_str))
                        .unwrap_or("")
                        .trim();
                    (!text.is_empty()).then(|| {
                        if address.is_empty() {
                            text.to_string()
                        } else {
                            format!("{address}: {text}")
                        }
                    })
                })
                .collect::<Vec<_>>()
                .join("\t")
        })
        .unwrap_or_default()
}

fn estimate_token_count(text: &str) -> usize {
    let whitespace_count = text
        .split_whitespace()
        .filter(|term| !term.is_empty())
        .count();
    if whitespace_count > 1 {
        return whitespace_count;
    }

    (text.chars().count() / 4).max(1)
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
        Some("excel_sheet") => block
            .get("rows")
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .map(extract_excel_row_text)
                    .filter(|row| !row.trim().is_empty())
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default(),
        _ => String::new(),
    }
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
            sqlite_store::build_safe_fts_query("alpha beta"),
            Some("\"alpha\" \"beta\"".to_string())
        );
    }

    #[test]
    fn migrates_sqlite_schema_with_fts() {
        let connection = Connection::open_in_memory().expect("in-memory SQLite should open");
        sqlite_store::migrate_sqlite(&connection).expect("schema should migrate");

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
                params![sqlite_store::build_safe_fts_query("alpha").unwrap()],
                |row| row.get(0),
            )
            .expect("FTS query should run");
        assert_eq!(count, 1);
    }

    #[test]
    fn builds_heading_chunks_and_nearby_image_assets() {
        let blocks = json!([
            { "id": "h1", "type": "paragraph", "text": "3 数据管理方案设计", "style": "Heading 1" },
            { "id": "h2", "type": "paragraph", "text": "3.1 元数据组织方式", "style_id": "Heading2" },
            { "id": "p1", "type": "paragraph", "text": "设备类元数据组织主要包括设备编码。" },
            { "id": "img1", "type": "image", "filename": "image_001.png", "alt_text": "系统总体架构图" }
        ]);

        let index = build_document_index("doc_001", &blocks);

        assert_eq!(index.nodes.len(), 4);
        assert_eq!(index.chunks.len(), 1);
        assert_eq!(index.assets.len(), 1);
        assert_eq!(index.chunk_assets.len(), 1);
        assert_eq!(index.chunks[0].chunk_type, "section_content");
        assert!(index.chunks[0]
            .content_for_embedding
            .contains("3.1 元数据组织方式"));
        assert_eq!(index.assets[0].caption.as_deref(), Some("系统总体架构图"));
    }

    #[test]
    fn builds_excel_sheet_and_cell_range_chunks() {
        let blocks = json!([
            {
                "id": "sheet-0",
                "type": "excel_sheet",
                "name": "设备清单",
                "range": "A1:B2",
                "rows": [
                    {
                        "range": "A1:B1",
                        "cells": [
                            { "address": "A1", "text": "设备编码" },
                            { "address": "B1", "text": "设备名称" }
                        ]
                    },
                    {
                        "range": "A2:B2",
                        "cells": [
                            { "address": "A2", "text": "EQ-001" },
                            { "address": "B2", "text": "泵站" }
                        ]
                    }
                ]
            }
        ]);

        let index = build_document_index("book_001", &blocks);

        assert_eq!(index.nodes.len(), 3);
        assert_eq!(index.chunks.len(), 2);
        assert_eq!(index.nodes[0].node_type, "excel_sheet");
        assert_eq!(index.nodes[1].node_type, "excel_cell_range");
        assert_eq!(index.chunks[0].chunk_type, "excel_range_content");
        assert!(index.chunks[1].content.contains("A2: EQ-001"));
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
