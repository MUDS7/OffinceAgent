use std::{path::PathBuf, sync::Mutex};

use rusqlite::{params, Connection};
use serde_json::{json, Value};

use super::{
    collection::{score_vectors, sort_qdrant_hits},
    embedding::{embed_chunk_text, LOCAL_CHUNK_EMBEDDING_DIMENSIONS},
    filter::matches_qdrant_filter,
    model::{QdrantSearchHit, QdrantVectorPoint, UploadedDocumentChunkHit},
    payload::normalize_generic_qdrant_point,
    uploaded_chunks::{
        collapse_descendant_hits, expand_docx_section_descendants, lexical_match_terms,
        prepend_docx_outline_hits, rerank_uploaded_document_hits,
    },
    *,
};
use crate::storage::{document_index::IndexedChunk, DocumentStore};

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
            "document_name": "design.docx",
            "chunk_type": "section_content",
            "heading_path": ["3 Data design", "3.1 Metadata organization"],
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
            "document_name": "design.docx",
            "chunk_type": "section_content",
            "heading_path": "3 Data design > 3.1 Metadata organization",
            "order_index": 33
        })
    );
}

#[test]
fn uploaded_chunk_rerank_prefers_exact_title_match() {
    let mut hits = vec![
        test_uploaded_hit(
            "chunk_vector",
            "7.5.1 System architecture overview",
            0.25,
            8,
        ),
        test_uploaded_hit("chunk_exact", "7.1 Service plan", 0.16, 0),
    ];

    rerank_uploaded_document_hits("Service plan", "Cosine", &mut hits);

    assert_eq!(hits[0].chunk_id, "chunk_exact");
    assert_eq!(hits[0].title_path, "7.1 Service plan");
}

#[test]
fn uploaded_chunk_rerank_extracts_terms_from_instruction() {
    let mut hits = vec![
        test_uploaded_hit("chunk_vector", "7.3 Operations", 0.25, 5),
        test_uploaded_hit("chunk_exact", "7.1 Service plan", 0.16, 0),
    ];

    rerank_uploaded_document_hits("Write a service plan", "Cosine", &mut hits);

    assert_eq!(hits[0].chunk_id, "chunk_exact");
    assert!(lexical_match_terms("Write a service plan")
        .iter()
        .any(|term| term == "service"));
}

#[test]
fn expands_docx_parent_section_hits_with_descendants() {
    let connection = Connection::open_in_memory().expect("in-memory SQLite should open");
    connection
        .execute_batch(
            "
            CREATE TABLE chunks (
                document_id TEXT NOT NULL,
                chunk_type TEXT NOT NULL,
                title_path TEXT NOT NULL,
                content TEXT NOT NULL,
                plain_text TEXT NOT NULL,
                images_json TEXT NOT NULL,
                order_index INTEGER NOT NULL
            );
            ",
        )
        .expect("chunks table should be created");

    for (title_path, content, order_index) in [
        (
            "7.5.1 System architecture overview",
            "Parent overview paragraph.",
            1,
        ),
        (
            "7.5.1 System architecture overview > 7.5.1.1 Deployment view",
            "Deployment view content.",
            2,
        ),
        (
            "7.5.1 System architecture overview > 7.5.1.2 Data flow",
            "Data flow content.",
            3,
        ),
        ("7.5.2 Operations overview", "Sibling content.", 4),
    ] {
        connection
            .execute(
                "INSERT INTO chunks (
                    document_id, chunk_type, title_path, content, plain_text, images_json, order_index
                 ) VALUES ('doc_1', 'docx_section', ?1, ?2, ?2, '[]', ?3)",
                params![title_path, content, order_index],
            )
            .expect("chunk should insert");
    }

    let mut hits = vec![
        test_uploaded_hit("parent", "7.5.1 System architecture overview", 0.9, 1),
        test_uploaded_hit(
            "child",
            "7.5.1 System architecture overview > 7.5.1.1 Deployment view",
            0.8,
            2,
        ),
    ];
    hits[0].content = "Parent overview paragraph.".to_string();

    expand_docx_section_descendants(&connection, &mut hits).expect("descendants should expand");
    collapse_descendant_hits(&mut hits);

    assert_eq!(hits.len(), 1);
    assert!(hits[0].content.contains("Parent overview paragraph."));
    assert!(hits[0].content.contains("7.5.1.1 Deployment view"));
    assert!(hits[0].content.contains("Deployment view content."));
    assert!(hits[0].content.contains("7.5.1.2 Data flow"));
    assert!(hits[0].content.contains("Data flow content."));
    assert!(!hits[0].content.contains("Sibling content."));
}

#[test]
fn prepends_docx_outline_for_heading_queries() {
    let connection = Connection::open_in_memory().expect("in-memory SQLite should open");
    connection
        .execute_batch(
            "
            CREATE TABLE doc_nodes (
                document_id TEXT NOT NULL,
                node_type TEXT NOT NULL,
                level INTEGER,
                title TEXT,
                order_index INTEGER NOT NULL
            );
            ",
        )
        .expect("doc_nodes table should be created");

    for (title, level, order_index) in [
        ("7、响应方案", 1, 1),
        ("7.1 整体服务方案", 2, 2),
        ("7.5 采购需求中所需的全部内容", 2, 3),
        ("7.5.2编程语言、数据架构说明", 3, 4),
        ("7.6 供应商认为需加以说明的其他内容", 2, 5),
    ] {
        connection
            .execute(
                "INSERT INTO doc_nodes (document_id, node_type, level, title, order_index)
                 VALUES ('doc_1', 'heading', ?1, ?2, ?3)",
                params![level, title, order_index],
            )
            .expect("heading should insert");
    }

    let mut hits = vec![test_uploaded_hit(
        "chunk_1",
        "7、响应方案 > 7.5 采购需求中所需的全部内容",
        0.9,
        3,
    )];

    prepend_docx_outline_hits(&connection, "补充响应方案各级标题", &mut hits)
        .expect("outline should be prepended");

    assert_eq!(hits[0].chunk_type, "docx_outline");
    assert!(hits[0].content.contains("7.1 整体服务方案"));
    assert!(hits[0].content.contains("7.5.2编程语言、数据架构说明"));
    assert!(hits[0]
        .content
        .contains("7.6 供应商认为需加以说明的其他内容"));
    assert_eq!(hits[1].chunk_id, "chunk_1");
}

#[test]
fn chunk_embedding_is_stable_and_normalized() {
    let first = embed_chunk_text("Document: demo.pdf\nPage: 1\n\nhello vector world");
    let second = embed_chunk_text("Document: demo.pdf\nPage: 1\n\nhello vector world");

    assert_eq!(first, second);
    assert_eq!(first.len(), LOCAL_CHUNK_EMBEDDING_DIMENSIONS);

    let norm = first
        .iter()
        .map(|value| f64::from(*value) * f64::from(*value))
        .sum::<f64>()
        .sqrt();
    assert!((norm - 1.0).abs() < 0.000_001);
}

#[test]
fn upserting_document_chunk_embeddings_replaces_stale_points() {
    let store = test_store();

    let chunks = vec![
        test_indexed_chunk("chunk_1", "Page 1", 0),
        test_indexed_chunk("chunk_2", "Page 2", 1),
    ];
    let inserted = upsert_document_chunk_embeddings(&store, "doc_1", "demo.pdf", &chunks)
        .expect("chunks should upsert");
    assert_eq!(inserted, 2);

    let skipped = upsert_document_chunk_embeddings(&store, "doc_1", "demo.pdf", &chunks)
        .expect("unchanged chunks should be skipped");
    assert_eq!(skipped, 0);

    let replacement = vec![test_indexed_chunk("chunk_3", "Page 3", 0)];
    let inserted = upsert_document_chunk_embeddings(&store, "doc_1", "demo.pdf", &replacement)
        .expect("replacement chunks should upsert");
    assert_eq!(inserted, 1);

    let changed_replacement = vec![{
        let mut chunk = test_indexed_chunk("chunk_3", "Page 3", 0);
        chunk.plain_text.push_str("\nupdated content");
        chunk
    }];
    let inserted =
        upsert_document_chunk_embeddings(&store, "doc_1", "demo.pdf", &changed_replacement)
            .expect("changed chunks should upsert");
    assert_eq!(inserted, 1);

    let connection = store
        .qdrant_connection
        .lock()
        .expect("qdrant lock should open");
    let point_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM qdrant_points", [], |row| row.get(0))
        .expect("point count should read");
    let remaining_point_id: String = connection
        .query_row("SELECT point_id FROM qdrant_points", [], |row| row.get(0))
        .expect("point id should read");

    assert_eq!(point_count, 1);
    assert_eq!(remaining_point_id, "chunk_3");
}

#[test]
fn deleting_document_chunk_embeddings_removes_only_matching_document_points() {
    let store = test_store();

    upsert_document_chunk_embeddings(
        &store,
        "doc_1",
        "first.pdf",
        &[test_indexed_chunk("doc_1_chunk_1", "Page 1", 0)],
    )
    .expect("first document chunks should upsert");
    upsert_document_chunk_embeddings(
        &store,
        "doc_2",
        "second.pdf",
        &[test_indexed_chunk("doc_2_chunk_1", "Page 1", 0)],
    )
    .expect("second document chunks should upsert");

    let deleted = delete_document_chunk_embeddings(&store, &["doc_1".to_string()])
        .expect("document embeddings should delete");

    let connection = store
        .qdrant_connection
        .lock()
        .expect("qdrant lock should open");
    let point_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM qdrant_points", [], |row| row.get(0))
        .expect("point count should read");
    let remaining_document_id: String = connection
        .query_row("SELECT payload_json FROM qdrant_points", [], |row| {
            let payload_json: String = row.get(0)?;
            let payload: Value = serde_json::from_str(&payload_json).expect("payload json");
            Ok(payload["document_id"]
                .as_str()
                .unwrap_or_default()
                .to_string())
        })
        .expect("payload should read");

    assert_eq!(deleted, 1);
    assert_eq!(point_count, 1);
    assert_eq!(remaining_document_id, "doc_2");
}

fn test_store() -> DocumentStore {
    let qdrant_connection = Connection::open_in_memory().expect("in-memory Qdrant should open");
    migrate_qdrant(&qdrant_connection).expect("qdrant schema should migrate");
    DocumentStore {
        connection: Mutex::new(Connection::open_in_memory().expect("sqlite should open")),
        sqlite_path: Mutex::new(PathBuf::from("office-agent.sqlite3")),
        qdrant_connection: Mutex::new(qdrant_connection),
        qdrant_path: Mutex::new(PathBuf::from(".data/qdrant/office-agent-qdrant.sqlite3")),
        workspace_path: Mutex::new(None),
        workspace_data_path: Mutex::new(PathBuf::from(".data")),
    }
}

fn test_indexed_chunk(id: &str, title_path: &str, order_index: usize) -> IndexedChunk {
    IndexedChunk {
        id: id.to_string(),
        chunk_type: "pdf_paragraph".to_string(),
        title_level_1: Some(title_path.to_string()),
        title_level_2: None,
        title_level_3: None,
        title_path: title_path.to_string(),
        heading_level: Some(1),
        content: format!("content for {id}"),
        plain_text: format!("Document: demo.pdf\n{title_path}\n\ncontent for {id}"),
        images_json: Value::Array(Vec::new()).to_string(),
        tables_json: Value::Array(Vec::new()).to_string(),
        paragraph_start_index: Some(order_index + 1),
        paragraph_end_index: Some(order_index + 1),
        order_index,
        metadata_json: json!({ "chunk_id": id }).to_string(),
    }
}

fn test_uploaded_hit(
    chunk_id: &str,
    title_path: &str,
    score: f64,
    order_index: i64,
) -> UploadedDocumentChunkHit {
    UploadedDocumentChunkHit {
        chunk_id: chunk_id.to_string(),
        document_id: "doc_1".to_string(),
        document_name: "response.docx".to_string(),
        chunk_type: "docx_section".to_string(),
        title_path: title_path.to_string(),
        score,
        content: "content".to_string(),
        plain_text: format!("Title path: {title_path}\n\nBody: content"),
        images: Vec::new(),
        order_index,
    }
}
