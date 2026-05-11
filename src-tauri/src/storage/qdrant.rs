use std::{cmp::Ordering, path::PathBuf};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{Manager, State};

use super::{unix_timestamp_seconds, DocumentStore};

const DEFAULT_QDRANT_COLLECTION: &str = "office_agent_chunks";
const DEFAULT_QDRANT_DB_NAME: &str = "office-agent-qdrant.sqlite3";

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
pub(crate) struct QdrantChunkVectorPoint {
    id: Option<String>,
    chunk_id: String,
    vector: Vec<f32>,
    document_id: String,
    document_name: Option<String>,
    chunk_type: String,
    heading_path: Option<Value>,
    order_index: i64,
}

#[derive(Debug, Deserialize)]
pub(crate) struct QdrantChunkUpsertRequest {
    collection: Option<String>,
    points: Vec<QdrantChunkVectorPoint>,
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

pub(super) fn qdrant_db_path(app: &tauri::App) -> Result<PathBuf, String> {
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

pub(crate) async fn upsert_qdrant_vectors(
    state: State<'_, DocumentStore>,
    request: QdrantUpsertRequest,
) -> Result<QdrantUpsertResult, String> {
    let points = request
        .points
        .into_iter()
        .map(normalize_generic_qdrant_point)
        .collect::<Result<Vec<_>, _>>()?;
    upsert_qdrant_points(&state, request.collection, points)
}

pub(crate) async fn upsert_qdrant_chunk_vectors(
    state: State<'_, DocumentStore>,
    request: QdrantChunkUpsertRequest,
) -> Result<QdrantUpsertResult, String> {
    let points = request
        .points
        .into_iter()
        .map(qdrant_chunk_point_to_vector_point)
        .collect::<Result<Vec<_>, _>>()?;
    upsert_qdrant_points(&state, request.collection, points)
}

fn upsert_qdrant_points(
    store: &DocumentStore,
    collection: Option<String>,
    points: Vec<QdrantVectorPoint>,
) -> Result<QdrantUpsertResult, String> {
    let config = QdrantConfig::from_store(store, collection)?;
    let point_count = points.len();
    let mut connection = store
        .qdrant_connection
        .lock()
        .map_err(|_| "embedded Qdrant store lock is poisoned".to_string())?;

    let collection = get_or_create_collection(&connection, &config.collection, &points)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("cannot start embedded Qdrant transaction: {error}"))?;

    for point in points {
        if point.vector.len() as u64 != collection.vector_size {
            return Err(format!(
                "cannot upsert Qdrant vector {}: expected dimension {}, got {}",
                point.id,
                collection.vector_size,
                point.vector.len()
            ));
        }

        if point.id.trim().is_empty() {
            return Err("cannot upsert Qdrant vector with empty id".to_string());
        }

        let payload = match point.payload {
            Some(Value::Object(map)) => map,
            _ => Map::new(),
        };
        let point_id = point.id.clone();
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

fn normalize_generic_qdrant_point(point: QdrantVectorPoint) -> Result<QdrantVectorPoint, String> {
    let QdrantVectorPoint {
        id,
        vector,
        payload,
    } = point;
    let payload = qdrant_chunk_payload_from_value(&id, payload)?;
    Ok(QdrantVectorPoint {
        id,
        vector,
        payload: Some(Value::Object(payload)),
    })
}

fn qdrant_chunk_point_to_vector_point(
    point: QdrantChunkVectorPoint,
) -> Result<QdrantVectorPoint, String> {
    let point_id = point.id.unwrap_or_else(|| point.chunk_id.clone());
    let payload = qdrant_chunk_payload(
        &point.chunk_id,
        &point.document_id,
        point.document_name.as_deref(),
        &point.chunk_type,
        point.heading_path.as_ref(),
        point.order_index,
    )?;

    Ok(QdrantVectorPoint {
        id: point_id,
        vector: point.vector,
        payload: Some(Value::Object(payload)),
    })
}

fn qdrant_chunk_payload_from_value(
    point_id: &str,
    payload: Option<Value>,
) -> Result<Map<String, Value>, String> {
    let object = match payload {
        Some(Value::Object(map)) => map,
        Some(_) => {
            return Err(format!(
                "Qdrant chunk point {point_id} payload must be an object"
            ))
        }
        None => Map::new(),
    };
    let chunk_id =
        optional_string_field(&object, "chunk_id").unwrap_or_else(|| point_id.trim().to_string());
    let document_id = required_string_field(&object, "document_id", point_id)?;
    let document_name = optional_string_field(&object, "document_name");
    let chunk_type = required_string_field(&object, "chunk_type", point_id)?;
    let order_index = required_i64_field(&object, "order_index", point_id)?;

    qdrant_chunk_payload(
        &chunk_id,
        &document_id,
        document_name.as_deref(),
        &chunk_type,
        object.get("heading_path"),
        order_index,
    )
}

fn qdrant_chunk_payload(
    chunk_id: &str,
    document_id: &str,
    document_name: Option<&str>,
    chunk_type: &str,
    heading_path: Option<&Value>,
    order_index: i64,
) -> Result<Map<String, Value>, String> {
    if chunk_id.trim().is_empty() {
        return Err("Qdrant chunk payload requires chunk_id".to_string());
    }
    if document_id.trim().is_empty() {
        return Err(format!(
            "Qdrant chunk {} payload requires document_id",
            chunk_id
        ));
    }
    if chunk_type.trim().is_empty() {
        return Err(format!(
            "Qdrant chunk {} payload requires chunk_type",
            chunk_id
        ));
    }

    let mut payload = Map::new();
    payload.insert(
        "chunk_id".to_string(),
        Value::String(chunk_id.trim().to_string()),
    );
    payload.insert(
        "document_id".to_string(),
        Value::String(document_id.trim().to_string()),
    );
    if let Some(document_name) = document_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        payload.insert(
            "document_name".to_string(),
            Value::String(document_name.to_string()),
        );
    }
    payload.insert(
        "chunk_type".to_string(),
        Value::String(chunk_type.trim().to_string()),
    );
    payload.insert(
        "heading_path".to_string(),
        Value::String(qdrant_heading_path_text(heading_path)),
    );
    payload.insert("order_index".to_string(), Value::from(order_index));
    Ok(payload)
}

fn qdrant_heading_path_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.trim().to_string(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .collect::<Vec<_>>()
            .join(" > "),
        Some(Value::Null) | None => String::new(),
        Some(value) => value.to_string(),
    }
}

fn required_string_field(
    object: &Map<String, Value>,
    field: &str,
    point_id: &str,
) -> Result<String, String> {
    optional_string_field(object, field).ok_or_else(|| {
        format!("Qdrant chunk point {point_id} payload requires string field {field}")
    })
}

fn optional_string_field(object: &Map<String, Value>, field: &str) -> Option<String> {
    object
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn required_i64_field(
    object: &Map<String, Value>,
    field: &str,
    point_id: &str,
) -> Result<i64, String> {
    object.get(field).and_then(Value::as_i64).ok_or_else(|| {
        format!("Qdrant chunk point {point_id} payload requires integer field {field}")
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

pub(super) fn migrate_qdrant(connection: &Connection) -> Result<(), String> {
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

struct QdrantConfig {
    path: PathBuf,
    collection: String,
}

impl QdrantConfig {
    fn from_store(store: &DocumentStore, collection: Option<String>) -> Result<Self, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn qdrant_chunk_payload_keeps_only_retrieval_fields() {
        let point = QdrantVectorPoint {
            id: "chunk_001".to_string(),
            vector: vec![0.1, 0.2, 0.3],
            payload: Some(json!({
                "chunk_id": "chunk_001",
                "document_id": "doc_001",
                "document_name": "数据管理方案.docx",
                "chunk_type": "section_content",
                "heading_path": ["3 数据管理方案设计", "3.1 元数据组织方式"],
                "order_index": 33,
                "content_for_embedding": "full text should stay in SQLite",
                "blocks": [{ "type": "paragraph", "text": "full structure should not be here" }]
            })),
        };

        let normalized = normalize_generic_qdrant_point(point).expect("payload should normalize");
        let payload = normalized
            .payload
            .expect("normalized point should include payload");

        assert_eq!(normalized.id, "chunk_001");
        assert_eq!(
            payload,
            json!({
                "chunk_id": "chunk_001",
                "document_id": "doc_001",
                "document_name": "数据管理方案.docx",
                "chunk_type": "section_content",
                "heading_path": "3 数据管理方案设计 > 3.1 元数据组织方式",
                "order_index": 33
            })
        );
    }
}
