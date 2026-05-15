use std::cmp::Ordering;

use rusqlite::{params, Connection};

use super::model::{QdrantCollection, QdrantSearchHit, QdrantVectorPoint};
use crate::storage::unix_timestamp_seconds;

pub(crate) fn migrate_qdrant(connection: &Connection) -> Result<(), String> {
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

pub(super) fn upsert_qdrant_collection(
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

pub(super) fn get_or_create_collection(
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

pub(super) fn get_qdrant_collection(
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

pub(super) fn normalize_distance(distance: &str) -> String {
    match distance.trim().to_ascii_lowercase().as_str() {
        "dot" => "Dot".to_string(),
        "euclid" | "euclidean" => "Euclid".to_string(),
        "manhattan" => "Manhattan".to_string(),
        _ => "Cosine".to_string(),
    }
}

pub(super) fn score_vectors(query: &[f32], candidate: &[f32], distance: &str) -> f64 {
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

pub(super) fn sort_qdrant_hits(hits: &mut [QdrantSearchHit], distance: &str) {
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
