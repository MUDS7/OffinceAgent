use serde_json::Value;

#[derive(Default)]
pub(super) struct BuiltDocumentIndex {
    pub(super) nodes: Vec<IndexedNode>,
    pub(super) chunks: Vec<IndexedChunk>,
    pub(super) assets: Vec<IndexedAsset>,
    pub(super) chunk_assets: Vec<ChunkAssetLink>,
}

pub(super) struct IndexedNode {
    pub(super) id: String,
    pub(super) parent_id: Option<String>,
    pub(super) node_type: String,
    pub(super) level: Option<i32>,
    pub(super) title: Option<String>,
    pub(super) text: Option<String>,
    pub(super) order_index: usize,
    pub(super) metadata_json: String,
}

pub(super) struct IndexedChunk {
    pub(super) id: String,
    pub(super) node_ids_json: String,
    pub(super) heading_path_json: String,
    pub(super) heading_path_text: String,
    pub(super) chunk_type: String,
    pub(super) content: String,
    pub(super) content_for_embedding: String,
    pub(super) order_index: usize,
    pub(super) token_count: usize,
}

pub(super) struct IndexedAsset {
    pub(super) id: String,
    pub(super) node_id: Option<String>,
    pub(super) asset_type: String,
    pub(super) file_path: Option<String>,
    pub(super) caption: Option<String>,
    pub(super) description: Option<String>,
    pub(super) nearby_text: Option<String>,
    pub(super) metadata_json: String,
}

pub(super) struct ChunkAssetLink {
    pub(super) chunk_id: String,
    pub(super) asset_id: String,
    pub(super) relation_type: String,
}

#[derive(Clone)]
struct HeadingContext {
    node_id: String,
    level: i32,
    title: String,
}

pub(super) fn build_document_index(document_id: &str, blocks: &Value) -> BuiltDocumentIndex {
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
        if !(normalized.contains("heading") || value.contains("鏍囬")) {
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

pub(super) struct FlattenedBlock {
    pub(super) block_id: String,
    pub(super) block_type: String,
    pub(super) block_index: usize,
    pub(super) parent_id: Option<String>,
    pub(super) text: String,
    pub(super) metadata_json: String,
}

pub(super) fn flatten_document_blocks(blocks: &Value) -> Vec<FlattenedBlock> {
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
    use serde_json::json;

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
}
