use serde_json::{json, Value};

const MAX_CHUNK_CONTENT_CHARS: usize = 6_000;

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

#[derive(Clone)]
struct HeadingContext {
    node_id: String,
    level: i32,
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
    let mut heading_stack: Vec<HeadingContext> = Vec::new();

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
                    &mut index,
                );
            }
        }
    }

    index.chunks = build_docx_section_chunks(document_id, filename, blocks);

    index
}

fn build_docx_like_block_index(
    document_id: &str,
    block: &Value,
    order_index: usize,
    heading_stack: &mut Vec<HeadingContext>,
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
            heading_stack.push(HeadingContext {
                node_id: node_id.clone(),
                level,
            });
            index.nodes.push(IndexedNode {
                id: node_id,
                parent_id,
                node_type: "heading".to_string(),
                level: Some(level),
                title: Some(title.clone()),
                text: (!title.is_empty()).then_some(title),
                order_index,
                metadata_json: block.to_string(),
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
        id: node_id,
        parent_id,
        node_type: node_type.to_string(),
        level: None,
        title,
        text: (!text.trim().is_empty()).then_some(text),
        order_index,
        metadata_json: block.to_string(),
    });
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
            id: row_node_id,
            parent_id: Some(sheet_node_id.clone()),
            node_type: "excel_cell_range".to_string(),
            level: None,
            title: row_range,
            text: Some(content),
            order_index: order_index * 100_000 + row_index + 1,
            metadata_json: row.to_string(),
        });
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
        if value.contains("标题") {
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

#[derive(Clone)]
struct ChunkPart {
    content: String,
    paragraph_index: Option<usize>,
    image: Option<Value>,
    table: Option<Value>,
}

#[derive(Clone)]
struct ChunkAccumulator {
    title_levels: Vec<Option<String>>,
    heading_level: Option<i32>,
    parts: Vec<ChunkPart>,
    paragraph_start_index: Option<usize>,
    paragraph_end_index: Option<usize>,
    paragraph_count: usize,
    content_len: usize,
}

impl ChunkAccumulator {
    fn new() -> Self {
        Self {
            title_levels: vec![None; 9],
            heading_level: None,
            parts: Vec::new(),
            paragraph_start_index: None,
            paragraph_end_index: None,
            paragraph_count: 0,
            content_len: 0,
        }
    }

    fn reset_content(&mut self) {
        self.parts.clear();
        self.paragraph_start_index = None;
        self.paragraph_end_index = None;
        self.paragraph_count = 0;
        self.content_len = 0;
    }

    fn has_content(&self) -> bool {
        self.parts.iter().any(|part| {
            !part.content.trim().is_empty() || part.image.is_some() || part.table.is_some()
        })
    }

    fn add_paragraph(&mut self, text: String, paragraph_index: usize) {
        if text.trim().is_empty() {
            return;
        }
        self.paragraph_count += 1;
        self.paragraph_start_index = Some(self.paragraph_start_index.unwrap_or(paragraph_index));
        self.paragraph_end_index = Some(paragraph_index);
        self.content_len += text.len() + 2;
        self.parts.push(ChunkPart {
            content: text,
            paragraph_index: Some(paragraph_index),
            image: None,
            table: None,
        });
    }

    fn add_image(&mut self, block: &Value, caption: Option<String>) {
        let filename = block
            .get("filename")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("image");
        let image_id = image_id_from_filename(filename).unwrap_or_else(|| {
            block
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("image")
                .to_string()
        });
        let position = if self.paragraph_count == 0 {
            "before_paragraph_1".to_string()
        } else {
            format!("after_paragraph_{}", self.paragraph_count)
        };
        let placeholder = format!("[IMAGE:{filename}]");
        let image = json!({
            "image_id": image_id,
            "block_id": block.get("id").and_then(Value::as_str).unwrap_or_default(),
            "filename": filename,
            "file_path": format!("images/{filename}"),
            "content_type": block.get("content_type").and_then(Value::as_str).unwrap_or("application/octet-stream"),
            "data_url": block.get("data_url").and_then(Value::as_str),
            "alt_text": block.get("alt_text").and_then(Value::as_str),
            "caption": caption,
            "position": position,
            "width_emu": block.get("width_emu").and_then(Value::as_i64),
            "height_emu": block.get("height_emu").and_then(Value::as_i64),
        });

        self.content_len += placeholder.len() + 2;
        self.parts.push(ChunkPart {
            content: placeholder,
            paragraph_index: None,
            image: Some(image),
            table: None,
        });
    }

    fn add_table(&mut self, block: &Value, caption: Option<String>) {
        let table_id = block
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("table")
            .to_string();
        let markdown = table_to_markdown(block);
        if markdown.trim().is_empty() {
            return;
        }
        let position = if self.paragraph_count == 0 {
            "before_paragraph_1".to_string()
        } else {
            format!("after_paragraph_{}", self.paragraph_count)
        };
        let table_label = caption
            .as_ref()
            .filter(|value| !value.trim().is_empty())
            .map(|value| format!("[表格：{value}]\n"))
            .unwrap_or_default();
        let content = format!("{table_label}{markdown}");
        let table = json!({
            "table_id": table_id,
            "caption": caption,
            "position": position,
            "markdown": markdown,
            "row_count": block.get("rows").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
        });

        self.content_len += content.len() + 2;
        self.parts.push(ChunkPart {
            content,
            paragraph_index: None,
            image: None,
            table: Some(table),
        });
    }
}

fn build_docx_section_chunks(
    document_id: &str,
    filename: &str,
    blocks: &[Value],
) -> Vec<IndexedChunk> {
    let mut chunks = Vec::new();
    let mut accumulator = ChunkAccumulator::new();
    let mut paragraph_index = 0usize;

    for (block_index, block) in blocks.iter().enumerate() {
        if block.get("type").and_then(Value::as_str) == Some("excel_sheet") {
            continue;
        }

        if block.get("type").and_then(Value::as_str) == Some("paragraph") {
            paragraph_index += 1;
            if let Some(level) = heading_level(block) {
                flush_docx_chunk(document_id, filename, &mut accumulator, &mut chunks);
                apply_heading_to_accumulator(&mut accumulator, level, extract_block_text(block));
                continue;
            }

            accumulator.add_paragraph(extract_block_text(block), paragraph_index);
            continue;
        }

        match block.get("type").and_then(Value::as_str) {
            Some("image") => {
                let caption = nearby_caption(blocks, block_index, CaptionKind::Image);
                accumulator.add_image(block, caption);
            }
            Some("table") => {
                let caption = nearby_caption(blocks, block_index, CaptionKind::Table);
                accumulator.add_table(block, caption);
            }
            _ => {}
        }
    }

    flush_docx_chunk(document_id, filename, &mut accumulator, &mut chunks);
    chunks
}

fn apply_heading_to_accumulator(accumulator: &mut ChunkAccumulator, level: i32, title: String) {
    let index = (level - 1).max(0) as usize;
    if accumulator.title_levels.len() <= index {
        accumulator.title_levels.resize(index + 1, None);
    }
    accumulator.title_levels[index] = Some(title.trim().to_string());
    for item in accumulator.title_levels.iter_mut().skip(index + 1) {
        *item = None;
    }
    accumulator.heading_level = Some(level);
}

fn flush_docx_chunk(
    document_id: &str,
    filename: &str,
    accumulator: &mut ChunkAccumulator,
    chunks: &mut Vec<IndexedChunk>,
) {
    if !accumulator.has_content() {
        accumulator.reset_content();
        return;
    }

    let title_levels = accumulator.title_levels.clone();
    let heading_level = accumulator.heading_level;
    let mut current_parts: Vec<ChunkPart> = Vec::new();
    let mut current_len = 0usize;

    for part in accumulator.parts.clone() {
        let next_len = if current_len == 0 {
            part.content.len()
        } else {
            current_len + 2 + part.content.len()
        };
        if !current_parts.is_empty() && next_len > MAX_CHUNK_CONTENT_CHARS {
            emit_docx_chunk(
                document_id,
                filename,
                chunks.len(),
                title_levels.clone(),
                heading_level,
                current_parts,
                chunks,
            );
            current_parts = Vec::new();
            current_len = 0;
        }

        current_len = if current_len == 0 {
            part.content.len()
        } else {
            current_len + 2 + part.content.len()
        };
        current_parts.push(part);
    }

    if !current_parts.is_empty() {
        emit_docx_chunk(
            document_id,
            filename,
            chunks.len(),
            title_levels,
            heading_level,
            current_parts,
            chunks,
        );
    }

    accumulator.reset_content();
}

fn emit_docx_chunk(
    document_id: &str,
    filename: &str,
    chunk_index: usize,
    title_levels: Vec<Option<String>>,
    heading_level: Option<i32>,
    parts: Vec<ChunkPart>,
    chunks: &mut Vec<IndexedChunk>,
) {
    let title_path = title_levels
        .iter()
        .filter_map(|item| item.as_deref())
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>()
        .join(" > ");
    let content = parts
        .iter()
        .map(|part| part.content.trim())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let paragraph_indexes = parts
        .iter()
        .filter_map(|part| part.paragraph_index)
        .collect::<Vec<_>>();
    let paragraph_start_index = paragraph_indexes.iter().min().copied();
    let paragraph_end_index = paragraph_indexes.iter().max().copied();
    let images = parts
        .iter()
        .filter_map(|part| part.image.clone())
        .map(|mut image| {
            if let Some(object) = image.as_object_mut() {
                object.insert("title_path".to_string(), Value::String(title_path.clone()));
            }
            image
        })
        .collect::<Vec<_>>();
    let tables = parts
        .iter()
        .filter_map(|part| part.table.clone())
        .map(|mut table| {
            if let Some(object) = table.as_object_mut() {
                object.insert("title_path".to_string(), Value::String(title_path.clone()));
            }
            table
        })
        .collect::<Vec<_>>();
    let plain_text = build_embedding_text(filename, &title_path, &content, &images, &tables);
    let chunk_id = scoped_stable_id(
        "chunk",
        document_id,
        &format!("docx-section:{chunk_index}:{title_path}:{paragraph_start_index:?}"),
    );
    let metadata = json!({
        "chunk_id": chunk_id,
        "file_id": document_id,
        "file_name": filename,
        "chunk_type": "docx_section",
        "title_level_1": title_levels.first().and_then(Clone::clone),
        "title_level_2": title_levels.get(1).and_then(Clone::clone),
        "title_level_3": title_levels.get(2).and_then(Clone::clone),
        "title_path": title_path,
        "heading_level": heading_level,
        "images": images,
        "tables": tables,
        "paragraph_start_index": paragraph_start_index,
        "paragraph_end_index": paragraph_end_index,
    });

    chunks.push(IndexedChunk {
        id: chunk_id,
        chunk_type: "docx_section".to_string(),
        title_level_1: title_levels.first().and_then(Clone::clone),
        title_level_2: title_levels.get(1).and_then(Clone::clone),
        title_level_3: title_levels.get(2).and_then(Clone::clone),
        title_path,
        heading_level,
        content,
        plain_text,
        images_json: Value::Array(images).to_string(),
        tables_json: Value::Array(tables).to_string(),
        paragraph_start_index,
        paragraph_end_index,
        order_index: chunk_index,
        metadata_json: metadata.to_string(),
    });
}

fn build_embedding_text(
    filename: &str,
    title_path: &str,
    content: &str,
    images: &[Value],
    tables: &[Value],
) -> String {
    let image_text = images
        .iter()
        .map(|image| {
            let filename = image
                .get("filename")
                .and_then(Value::as_str)
                .unwrap_or("image");
            let caption = image
                .get("caption")
                .and_then(Value::as_str)
                .or_else(|| image.get("alt_text").and_then(Value::as_str))
                .unwrap_or("");
            if caption.trim().is_empty() {
                format!("[IMAGE:{filename}]")
            } else {
                format!("[IMAGE:{filename}，说明：{caption}]")
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let table_text = tables
        .iter()
        .filter_map(|table| table.get("markdown").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n\n");

    [
        format!("文档：{filename}"),
        format!(
            "标题路径：{}",
            if title_path.trim().is_empty() {
                "无标题"
            } else {
                title_path
            }
        ),
        "\n正文：".to_string(),
        content.to_string(),
        if image_text.is_empty() {
            String::new()
        } else {
            format!("\n图片：\n{image_text}")
        },
        if table_text.is_empty() {
            String::new()
        } else {
            format!("\n表格：\n{table_text}")
        },
    ]
    .into_iter()
    .filter(|part| !part.trim().is_empty())
    .collect::<Vec<_>>()
    .join("\n")
}

enum CaptionKind {
    Image,
    Table,
}

fn nearby_caption(blocks: &[Value], block_index: usize, kind: CaptionKind) -> Option<String> {
    [block_index.checked_add(1), block_index.checked_sub(1)]
        .into_iter()
        .flatten()
        .filter_map(|index| blocks.get(index))
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("paragraph"))
        .map(extract_block_text)
        .map(|text| text.trim().to_string())
        .find(|text| is_caption_text(text, &kind))
}

fn is_caption_text(text: &str, kind: &CaptionKind) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.len() > 160 {
        return false;
    }

    let lower = trimmed.to_ascii_lowercase();
    match kind {
        CaptionKind::Image => {
            trimmed.starts_with('图')
                || trimmed.starts_with("图片")
                || lower.starts_with("fig.")
                || lower.starts_with("figure")
                || lower.starts_with("image")
        }
        CaptionKind::Table => trimmed.starts_with('表') || lower.starts_with("table"),
    }
}

fn table_to_markdown(block: &Value) -> String {
    let rows = block
        .get("rows")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if rows.is_empty() {
        return String::new();
    }

    let row_texts = rows
        .iter()
        .map(|row| {
            row.as_array()
                .map(|cells| {
                    cells
                        .iter()
                        .map(|cell| {
                            markdown_cell_text(
                                cell.get("text").and_then(Value::as_str).unwrap_or_default(),
                            )
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        })
        .collect::<Vec<_>>();
    let column_count = row_texts.iter().map(Vec::len).max().unwrap_or(0);
    if column_count == 0 {
        return String::new();
    }

    let mut lines = Vec::new();
    for (row_index, row) in row_texts.iter().enumerate() {
        let mut cells = row.clone();
        cells.resize(column_count, String::new());
        lines.push(format!("| {} |", cells.join(" | ")));
        if row_index == 0 {
            lines.push(format!(
                "|{}|",
                (0..column_count)
                    .map(|_| "---")
                    .collect::<Vec<_>>()
                    .join("|")
            ));
        }
    }

    lines.join("\n")
}

fn markdown_cell_text(text: &str) -> String {
    text.replace('|', "\\|")
        .replace('\n', "<br>")
        .trim()
        .to_string()
}

fn image_id_from_filename(filename: &str) -> Option<String> {
    let stem = filename
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(filename)
        .trim();
    (!stem.is_empty()).then(|| stem.to_string())
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
}
