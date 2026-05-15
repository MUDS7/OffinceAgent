use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
pub(crate) struct QdrantCollectionRequest {
    pub(crate) collection: Option<String>,
    pub(crate) vector_size: u64,
    pub(crate) distance: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct QdrantVectorPoint {
    pub(crate) id: String,
    pub(crate) vector: Vec<f32>,
    pub(crate) payload: Option<Value>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct QdrantUpsertRequest {
    pub(crate) collection: Option<String>,
    pub(crate) points: Vec<QdrantVectorPoint>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct QdrantChunkVectorPoint {
    pub(crate) id: Option<String>,
    pub(crate) chunk_id: String,
    pub(crate) vector: Vec<f32>,
    pub(crate) document_id: String,
    pub(crate) document_name: Option<String>,
    pub(crate) chunk_type: String,
    pub(crate) heading_path: Option<Value>,
    pub(crate) order_index: i64,
}

#[derive(Debug, Deserialize)]
pub(crate) struct QdrantChunkUpsertRequest {
    pub(crate) collection: Option<String>,
    pub(crate) points: Vec<QdrantChunkVectorPoint>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct QdrantSearchRequest {
    pub(crate) collection: Option<String>,
    pub(crate) vector: Vec<f32>,
    pub(crate) limit: Option<u64>,
    pub(crate) filter: Option<Value>,
}

#[derive(Debug, Serialize)]
pub(crate) struct QdrantStatus {
    pub(crate) url: String,
    pub(crate) collection: String,
    pub(crate) reachable: bool,
    pub(crate) path: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct QdrantUpsertResult {
    pub(crate) collection: String,
    pub(crate) points_upserted: usize,
}

#[derive(Debug, Serialize)]
pub(crate) struct UploadedDocumentChunkHit {
    pub(crate) chunk_id: String,
    pub(crate) document_id: String,
    pub(crate) document_name: String,
    pub(crate) chunk_type: String,
    pub(crate) title_path: String,
    pub(crate) score: f64,
    pub(crate) content: String,
    pub(crate) plain_text: String,
    pub(crate) images: Vec<Value>,
    pub(crate) order_index: i64,
}

#[derive(Clone)]
pub(super) struct QdrantCollection {
    pub(super) vector_size: u64,
    pub(super) distance: String,
}

pub(super) struct QdrantStoredPoint {
    pub(super) point_id: String,
    pub(super) external_id: String,
    pub(super) vector_json: String,
    pub(super) payload_json: String,
}

pub(super) struct QdrantSearchHit {
    pub(super) point_id: String,
    pub(super) score: f64,
    pub(super) payload: Value,
}
