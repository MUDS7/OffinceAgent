use std::{cmp::Ordering, collections::HashSet};

use rusqlite::{params, Connection};
use serde_json::Value;
use tauri::State;

use super::{
    collection::{get_qdrant_collection, normalize_distance, score_vectors},
    config::QdrantConfig,
    embedding::embed_chunk_text,
    model::{QdrantCollection, QdrantStoredPoint, UploadedDocumentChunkHit},
};
use crate::storage::DocumentStore;

pub(crate) fn search_uploaded_document_chunks(
    state: State<'_, DocumentStore>,
    query: String,
    limit: Option<u32>,
    min_score: Option<f64>,
) -> Result<Vec<UploadedDocumentChunkHit>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let config = QdrantConfig::from_store(&state, None)?;
    let query_vector = embed_chunk_text(query);
    if query_vector.iter().all(|value| *value == 0.0) {
        return Ok(Vec::new());
    }

    let lexical_terms = lexical_match_terms(query);
    let exact_chunk_ids = {
        let connection = state
            .connection
            .lock()
            .map_err(|_| "SQLite store lock is poisoned".to_string())?;
        exact_match_chunk_ids(&connection, &lexical_terms)?
    };
    let result_limit = limit.unwrap_or(5).min(20) as usize;
    let search_distance;
    let candidates = {
        let connection = state
            .qdrant_connection
            .lock()
            .map_err(|_| "embedded Qdrant store lock is poisoned".to_string())?;
        let Some(collection) = get_qdrant_collection(&connection, &config.collection)? else {
            return Ok(Vec::new());
        };
        if query_vector.len() as u64 != collection.vector_size {
            return Err(format!(
                "cannot search uploaded document chunks: expected vector dimension {}, got {}",
                collection.vector_size,
                query_vector.len()
            ));
        }
        search_distance = collection.distance.clone();

        search_chunk_candidates(
            &connection,
            &config.collection,
            &collection,
            &query_vector,
            min_score,
            &exact_chunk_ids,
        )?
    };

    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    let connection = state
        .connection
        .lock()
        .map_err(|_| "SQLite store lock is poisoned".to_string())?;
    let mut hits = hydrate_uploaded_document_hits(&connection, candidates)?;
    rerank_uploaded_document_hits(query, &search_distance, &mut hits);
    expand_docx_section_descendants(&connection, &mut hits)?;
    collapse_descendant_hits(&mut hits);
    prepend_docx_outline_hits(&connection, query, &mut hits)?;
    hits.truncate(result_limit.max(1));
    Ok(hits)
}

struct UploadedChunkCandidate {
    chunk_id: String,
    score: f64,
}

fn search_chunk_candidates(
    connection: &Connection,
    collection_name: &str,
    collection: &QdrantCollection,
    query_vector: &[f32],
    min_score: Option<f64>,
    force_chunk_ids: &HashSet<String>,
) -> Result<Vec<UploadedChunkCandidate>, String> {
    let mut statement = connection
        .prepare(
            "SELECT point_id, external_id, vector_json, payload_json
             FROM qdrant_points
             WHERE collection = ?1",
        )
        .map_err(|error| format!("cannot prepare embedded Qdrant chunk search: {error}"))?;
    let rows = statement
        .query_map(params![collection_name], |row| {
            Ok(QdrantStoredPoint {
                point_id: row.get(0)?,
                external_id: row.get(1)?,
                vector_json: row.get(2)?,
                payload_json: row.get(3)?,
            })
        })
        .map_err(|error| format!("cannot scan embedded Qdrant chunk points: {error}"))?;

    let mut candidates = Vec::new();
    for row in rows {
        let point = row.map_err(|error| format!("cannot read embedded Qdrant point: {error}"))?;
        let vector = serde_json::from_str::<Vec<f32>>(&point.vector_json)
            .map_err(|error| format!("cannot parse embedded Qdrant vector: {error}"))?;
        let payload = serde_json::from_str::<Value>(&point.payload_json)
            .map_err(|error| format!("cannot parse embedded Qdrant payload: {error}"))?;
        let Some(chunk_id) = payload
            .get("chunk_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
        else {
            continue;
        };

        let score = score_vectors(query_vector, &vector, &collection.distance);
        if !passes_relevance_threshold(score, &collection.distance, min_score)
            && !force_chunk_ids.contains(&chunk_id)
        {
            continue;
        }

        candidates.push(UploadedChunkCandidate { chunk_id, score });
    }

    sort_uploaded_chunk_candidates(&mut candidates, &collection.distance);
    Ok(candidates)
}

fn passes_relevance_threshold(score: f64, distance: &str, min_score: Option<f64>) -> bool {
    let Some(min_score) = min_score else {
        return true;
    };
    match normalize_distance(distance).as_str() {
        "Euclid" | "Manhattan" => score <= min_score,
        _ => score >= min_score,
    }
}

fn sort_uploaded_chunk_candidates(candidates: &mut [UploadedChunkCandidate], distance: &str) {
    let normalized = normalize_distance(distance);
    candidates.sort_by(|left, right| {
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

fn exact_match_chunk_ids(
    connection: &Connection,
    terms: &[String],
) -> Result<HashSet<String>, String> {
    if terms.is_empty() {
        return Ok(HashSet::new());
    }

    let mut statement = connection
        .prepare(
            "SELECT id
             FROM chunks
             WHERE title_path LIKE ?1
                OR content LIKE ?1
                OR plain_text LIKE ?1",
        )
        .map_err(|error| format!("cannot prepare uploaded document exact chunk lookup: {error}"))?;
    let mut chunk_ids = HashSet::new();
    for term in terms {
        let like_query = format!("%{term}%");
        let rows = statement
            .query_map(params![like_query], |row| row.get::<_, String>(0))
            .map_err(|error| {
                format!("cannot scan uploaded document exact chunk matches: {error}")
            })?;

        for row in rows {
            chunk_ids.insert(row.map_err(|error| {
                format!("cannot read uploaded document exact chunk id: {error}")
            })?);
        }
    }
    Ok(chunk_ids)
}

pub(super) fn rerank_uploaded_document_hits(
    query: &str,
    distance: &str,
    hits: &mut [UploadedDocumentChunkHit],
) {
    let reverse_vector = !matches!(
        normalize_distance(distance).as_str(),
        "Euclid" | "Manhattan"
    );
    hits.sort_by(|left, right| {
        let left_lexical = lexical_relevance(query, left);
        let right_lexical = lexical_relevance(query, right);
        right_lexical
            .partial_cmp(&left_lexical)
            .unwrap_or(Ordering::Equal)
            .then_with(|| {
                if reverse_vector {
                    right
                        .score
                        .partial_cmp(&left.score)
                        .unwrap_or(Ordering::Equal)
                } else {
                    left.score
                        .partial_cmp(&right.score)
                        .unwrap_or(Ordering::Equal)
                }
            })
            .then_with(|| left.order_index.cmp(&right.order_index))
    });
}

fn lexical_relevance(query: &str, hit: &UploadedDocumentChunkHit) -> f64 {
    let compact_query = compact_match_text(query);
    if compact_query.is_empty() {
        return 0.0;
    }

    let title = compact_match_text(&hit.title_path);
    let content = compact_match_text(&hit.content);
    let plain_text = compact_match_text(&hit.plain_text);

    let mut relevance = 0.0;
    if title.contains(&compact_query) {
        relevance += 100.0;
    }
    if content.contains(&compact_query) {
        relevance += 40.0;
    } else if plain_text.contains(&compact_query) {
        relevance += 20.0;
    }

    for term in lexical_match_terms(query) {
        if term == compact_query {
            continue;
        }
        let length_bonus = term.chars().count() as f64;
        if title.contains(&term) {
            relevance += 30.0 + length_bonus * 2.0;
        } else if content.contains(&term) {
            relevance += 8.0 + length_bonus;
        } else if plain_text.contains(&term) {
            relevance += 4.0 + length_bonus;
        }
    }

    relevance
}

pub(super) fn lexical_match_terms(query: &str) -> Vec<String> {
    let mut terms = Vec::new();
    let mut seen = HashSet::new();
    let mut current = String::new();

    for character in query.chars() {
        if character.is_alphanumeric() {
            current.push(character);
        } else {
            push_lexical_terms_from_token(&current, &mut terms, &mut seen);
            current.clear();
        }
    }
    push_lexical_terms_from_token(&current, &mut terms, &mut seen);

    terms
}

fn push_lexical_terms_from_token(token: &str, terms: &mut Vec<String>, seen: &mut HashSet<String>) {
    let compact = compact_match_text(token);
    if compact.is_empty() {
        return;
    }

    push_unique_lexical_term(compact.clone(), terms, seen);

    if compact.is_ascii() {
        return;
    }

    let chars = compact.chars().collect::<Vec<_>>();
    if chars.len() < 4 {
        return;
    }

    for start in 1..chars.len().saturating_sub(3) {
        let term = chars[start..].iter().collect::<String>();
        push_unique_lexical_term(term, terms, seen);
    }

    for window_len in (4..=chars.len().min(12)).rev() {
        for start in 0..=chars.len() - window_len {
            let term = chars[start..start + window_len].iter().collect::<String>();
            push_unique_lexical_term(term, terms, seen);
        }
    }
}

fn push_unique_lexical_term(term: String, terms: &mut Vec<String>, seen: &mut HashSet<String>) {
    if term.chars().count() < 2 || !seen.insert(term.clone()) {
        return;
    }
    terms.push(term);
}

fn compact_match_text(value: &str) -> String {
    value.to_lowercase().split_whitespace().collect::<String>()
}

fn hydrate_uploaded_document_hits(
    connection: &Connection,
    candidates: Vec<UploadedChunkCandidate>,
) -> Result<Vec<UploadedDocumentChunkHit>, String> {
    let mut hits = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let mut statement = connection
            .prepare(
                "SELECT c.id,
                        c.document_id,
                        COALESCE(d.name, d.filename, c.file_name, ''),
                        c.chunk_type,
                        c.title_path,
                        c.content,
                        c.plain_text,
                        c.images_json,
                        c.order_index
                 FROM chunks c
                 JOIN documents d ON d.id = c.document_id
                 WHERE c.id = ?1",
            )
            .map_err(|error| format!("cannot prepare uploaded document chunk lookup: {error}"))?;
        let row = statement.query_row(params![candidate.chunk_id], |row| {
            Ok(UploadedDocumentChunkHit {
                chunk_id: row.get(0)?,
                document_id: row.get(1)?,
                document_name: row.get(2)?,
                chunk_type: row.get(3)?,
                title_path: row.get(4)?,
                score: candidate.score,
                content: row.get(5)?,
                plain_text: row.get(6)?,
                images: parse_chunk_images_json(&row.get::<_, String>(7)?),
                order_index: row.get(8)?,
            })
        });

        match row {
            Ok(hit) => hits.push(hit),
            Err(rusqlite::Error::QueryReturnedNoRows) => {}
            Err(error) => return Err(format!("cannot read uploaded document chunk: {error}")),
        }
    }
    Ok(hits)
}

fn parse_chunk_images_json(images_json: &str) -> Vec<Value> {
    serde_json::from_str::<Vec<Value>>(images_json).unwrap_or_default()
}

struct DocxSectionDescendant {
    title_path: String,
    content: String,
    plain_text: String,
    images: Vec<Value>,
}

pub(super) fn expand_docx_section_descendants(
    connection: &Connection,
    hits: &mut [UploadedDocumentChunkHit],
) -> Result<(), String> {
    for hit in hits {
        if hit.chunk_type != "docx_section" || hit.title_path.trim().is_empty() {
            continue;
        }

        let descendants =
            load_docx_section_descendants(connection, &hit.document_id, &hit.title_path)?;
        if descendants.is_empty() {
            continue;
        }

        hit.content = combined_docx_section_content(hit, &descendants);
        hit.plain_text = combined_docx_section_plain_text(hit, &descendants);
        hit.images.extend(
            descendants
                .iter()
                .flat_map(|descendant| descendant.images.iter().cloned()),
        );
    }

    Ok(())
}

fn load_docx_section_descendants(
    connection: &Connection,
    document_id: &str,
    title_path: &str,
) -> Result<Vec<DocxSectionDescendant>, String> {
    let descendant_prefix = format!("{} > %", escape_sql_like(title_path.trim()));
    let mut statement = connection
        .prepare(
            "SELECT title_path, content, plain_text, images_json
             FROM chunks
             WHERE document_id = ?1
               AND chunk_type = 'docx_section'
               AND title_path LIKE ?2 ESCAPE '\\'
             ORDER BY order_index",
        )
        .map_err(|error| format!("cannot prepare DOCX section descendant lookup: {error}"))?;
    let rows = statement
        .query_map(params![document_id, descendant_prefix], |row| {
            let images_json: String = row.get(3)?;
            Ok(DocxSectionDescendant {
                title_path: row.get(0)?,
                content: row.get(1)?,
                plain_text: row.get(2)?,
                images: parse_chunk_images_json(&images_json),
            })
        })
        .map_err(|error| format!("cannot scan DOCX section descendants: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("cannot read DOCX section descendant: {error}"))
}

fn escape_sql_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn combined_docx_section_content(
    hit: &UploadedDocumentChunkHit,
    descendants: &[DocxSectionDescendant],
) -> String {
    let mut sections = Vec::new();
    if !hit.content.trim().is_empty() {
        sections.push(hit.content.trim().to_string());
    }

    for descendant in descendants {
        let content = descendant.content.trim();
        if content.is_empty() {
            continue;
        }
        sections.push(format!("{}:\n{}", descendant.title_path.trim(), content));
    }

    sections.join("\n\n")
}

fn combined_docx_section_plain_text(
    hit: &UploadedDocumentChunkHit,
    descendants: &[DocxSectionDescendant],
) -> String {
    std::iter::once(hit.plain_text.trim())
        .chain(
            descendants
                .iter()
                .map(|descendant| descendant.plain_text.trim()),
        )
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub(super) fn collapse_descendant_hits(hits: &mut Vec<UploadedDocumentChunkHit>) {
    let ancestor_paths = hits
        .iter()
        .filter(|hit| hit.chunk_type == "docx_section" && !hit.title_path.trim().is_empty())
        .map(|hit| (hit.document_id.clone(), hit.title_path.trim().to_string()))
        .collect::<Vec<_>>();

    hits.retain(|hit| {
        !ancestor_paths.iter().any(|(document_id, ancestor_path)| {
            let descendant_prefix = format!("{ancestor_path} > ");
            hit.document_id == *document_id
                && hit.title_path != *ancestor_path
                && hit.title_path.starts_with(&descendant_prefix)
        })
    });
}

pub(super) fn prepend_docx_outline_hits(
    connection: &Connection,
    query: &str,
    hits: &mut Vec<UploadedDocumentChunkHit>,
) -> Result<(), String> {
    if !is_outline_query(query) || hits.is_empty() {
        return Ok(());
    }

    let mut seen_documents = HashSet::new();
    let mut outline_hits = Vec::new();
    for hit in hits.iter() {
        if !seen_documents.insert(hit.document_id.clone()) {
            continue;
        }
        if let Some(outline_hit) = load_docx_outline_hit(connection, hit)? {
            outline_hits.push(outline_hit);
        }
    }

    if outline_hits.is_empty() {
        return Ok(());
    }

    outline_hits.extend(std::mem::take(hits));
    *hits = outline_hits;
    Ok(())
}

fn is_outline_query(query: &str) -> bool {
    let compact = compact_match_text(query);
    [
        "标题", "章节", "目录", "提纲", "outline", "heading", "headings",
    ]
    .iter()
    .any(|term| compact.contains(term))
}

fn load_docx_outline_hit(
    connection: &Connection,
    source_hit: &UploadedDocumentChunkHit,
) -> Result<Option<UploadedDocumentChunkHit>, String> {
    let mut statement = connection
        .prepare(
            "SELECT title, level
             FROM doc_nodes
             WHERE document_id = ?1
               AND node_type = 'heading'
               AND COALESCE(title, '') <> ''
             ORDER BY order_index",
        )
        .map_err(|error| format!("cannot prepare DOCX outline lookup: {error}"))?;
    let rows = statement
        .query_map(params![source_hit.document_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<i32>>(1)?))
        })
        .map_err(|error| format!("cannot scan DOCX outline headings: {error}"))?;

    let mut lines = Vec::new();
    for row in rows {
        let (title, level) =
            row.map_err(|error| format!("cannot read DOCX outline heading: {error}"))?;
        let trimmed = title.trim();
        if trimmed.is_empty() {
            continue;
        }
        let indent = "  ".repeat(level.unwrap_or(1).saturating_sub(1) as usize);
        lines.push(format!("{indent}{trimmed}"));
    }

    if lines.is_empty() {
        return Ok(None);
    }

    let content = format!(
        "完整标题目录（来自上传文档，按原文顺序）：\n{}",
        lines.join("\n")
    );
    Ok(Some(UploadedDocumentChunkHit {
        chunk_id: format!("outline:{}", source_hit.document_id),
        document_id: source_hit.document_id.clone(),
        document_name: source_hit.document_name.clone(),
        chunk_type: "docx_outline".to_string(),
        title_path: "完整标题目录".to_string(),
        score: source_hit.score,
        content: content.clone(),
        plain_text: content,
        images: Vec::new(),
        order_index: source_hit.order_index.saturating_sub(1),
    }))
}
