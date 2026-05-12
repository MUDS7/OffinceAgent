mod docx;
mod xlsx;

use serde_json::Value;

const MAX_CHUNK_CONTENT_CHARS: usize = 6_000;
const XLSX_CHUNK_DATA_ROW_COUNT: usize = 10;

#[derive(Default)]
pub(super) struct BuiltDocumentIndex {
    pub(super) nodes: Vec<IndexedNode>,
    pub(super) chunks: Vec<IndexedChunk>,
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
    pub(super) chunk_type: String,
    pub(super) title_level_1: Option<String>,
    pub(super) title_level_2: Option<String>,
    pub(super) title_level_3: Option<String>,
    pub(super) title_path: String,
    pub(super) heading_level: Option<i32>,
    pub(super) content: String,
    pub(super) plain_text: String,
    pub(super) images_json: String,
    pub(super) tables_json: String,
    pub(super) paragraph_start_index: Option<usize>,
    pub(super) paragraph_end_index: Option<usize>,
    pub(super) order_index: usize,
    pub(super) metadata_json: String,
}

pub(super) fn build_document_index(
    document_id: &str,
    filename: &str,
    blocks: &Value,
) -> BuiltDocumentIndex {
    let Some(blocks) = blocks.as_array() else {
        return BuiltDocumentIndex::default();
    };

    let mut index = BuiltDocumentIndex::default();
    let mut docx_indexer = docx::DocxBlockIndexer::default();

    for (order_index, block) in blocks.iter().enumerate() {
        match block.get("type").and_then(Value::as_str) {
            Some("excel_sheet") => {
                xlsx::build_excel_sheet_index(document_id, block, order_index, &mut index);
            }
            _ => {
                docx_indexer.build_block(document_id, block, order_index, &mut index);
            }
        }
    }

    index.chunks = docx::build_docx_section_chunks(document_id, filename, blocks);
    let xlsx_chunks =
        xlsx::build_xlsx_row_group_chunks(document_id, filename, blocks, index.chunks.len());
    index.chunks.extend(xlsx_chunks);

    index
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

fn stable_point_id(value: &str) -> u64 {
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;
    value.bytes().fold(FNV_OFFSET, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(FNV_PRIME)
    })
}

#[cfg(test)]
use docx::extract_block_text;

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
    fn builds_heading_nodes_and_paragraph_nodes() {
        let blocks = json!([
            { "id": "h1", "type": "paragraph", "text": "3 数据管理方案设计", "style": "Heading 1" },
            { "id": "h2", "type": "paragraph", "text": "3.1 元数据组织方式", "style_id": "Heading2" },
            { "id": "p1", "type": "paragraph", "text": "设备类元数据组织主要包括设备编码。" },
            { "id": "img1", "type": "image", "filename": "image_001.png", "alt_text": "系统总体架构图" }
        ]);

        let index = build_document_index("doc_001", "demo.docx", &blocks);

        assert_eq!(index.nodes.len(), 4);
        assert_eq!(index.nodes[0].node_type, "heading");
        assert_eq!(index.nodes[0].title.as_deref(), Some("3 数据管理方案设计"));
        assert_eq!(index.nodes[1].node_type, "heading");
        assert_eq!(index.nodes[2].node_type, "paragraph");
        assert_eq!(index.nodes[3].node_type, "image");
        assert_eq!(index.nodes[3].title.as_deref(), Some("系统总体架构图"));
    }

    #[test]
    fn builds_excel_sheet_and_cell_range_nodes() {
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

        let index = build_document_index("book_001", "book.xlsx", &blocks);

        assert_eq!(index.nodes.len(), 3);
        assert_eq!(index.nodes[0].node_type, "excel_sheet");
        assert_eq!(index.nodes[1].node_type, "excel_cell_range");
        assert_eq!(index.nodes[2].node_type, "excel_cell_range");
    }

    #[test]
    fn builds_xlsx_row_group_chunks_with_header_context() {
        let mut rows = vec![json!({
            "row_index": 1,
            "range": "A1:D1",
            "cells": [
                { "address": "A1", "text": "设备编号" },
                { "address": "B1", "text": "设备编号" },
                { "address": "D1", "text": "系统" }
            ]
        })];
        for row_index in 2..=13 {
            let mut cells = vec![
                json!({ "address": format!("A{row_index}"), "text": format!("E{:03}", row_index - 1) }),
                json!({ "address": format!("B{row_index}"), "text": format!("设备{}", row_index - 1) }),
            ];
            if row_index == 2 {
                cells.push(json!({ "address": "D2", "text": "系统一" }));
            }
            rows.push(json!({
                "row_index": row_index,
                "range": format!("A{row_index}:D{row_index}"),
                "cells": cells
            }));
        }
        let blocks = json!([{
            "id": "sheet-0",
            "type": "excel_sheet",
            "name": "设备信息",
            "range": "A1:D13",
            "merges": [
                { "range": "D2:D4", "value": "系统一" }
            ],
            "rows": rows
        }]);

        let index = build_document_index("book_001", "设备清单.xlsx", &blocks);

        assert_eq!(index.chunks.len(), 2);
        assert_eq!(index.chunks[0].chunk_type, "xlsx_row_group");
        assert!(index.chunks[0].plain_text.contains("文档：设备清单.xlsx"));
        assert!(index.chunks[0].plain_text.contains("Sheet：设备信息"));
        assert!(index.chunks[0].plain_text.contains("行范围：2-11"));
        assert!(index.chunks[0]
            .plain_text
            .contains("表头字段：设备编号、设备编号_2、C列、系统"));
        assert!(index.chunks[0].plain_text.contains("第3行："));
        assert!(index.chunks[0].plain_text.contains("系统：系统一"));
        assert!(index.chunks[0].plain_text.contains("C列："));
        assert!(index.chunks[1].plain_text.contains("行范围：12-13"));

        let metadata: Value =
            serde_json::from_str(&index.chunks[0].metadata_json).expect("metadata json");
        assert_eq!(metadata["header_row_index"], 1);
        assert_eq!(metadata["row_start"], 2);
        assert_eq!(metadata["row_end"], 11);
        assert_eq!(metadata["headers"][1], "设备编号_2");
        assert_eq!(metadata["rows"][1]["cells"]["系统"], "系统一");
    }
}
