mod collection;
mod config;
mod embedding;
mod filter;
mod model;
mod payload;
mod points;
mod search;
mod uploaded_chunks;

pub(crate) use model::{
    QdrantChunkUpsertRequest, QdrantCollectionRequest, QdrantSearchRequest, QdrantStatus,
    QdrantUpsertRequest, QdrantUpsertResult, UploadedDocumentChunkHit,
};
pub(crate) use points::{upsert_qdrant_chunk_vectors, upsert_qdrant_vectors};
pub(crate) use search::{ensure_qdrant_collection, get_qdrant_status, search_qdrant_vectors};
pub(crate) use uploaded_chunks::search_uploaded_document_chunks;

pub(super) use collection::migrate_qdrant;
pub(super) use config::qdrant_db_path;
pub(super) use points::{delete_document_chunk_embeddings, upsert_document_chunk_embeddings};

#[cfg(test)]
mod tests;
