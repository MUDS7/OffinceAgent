use serde_json::{json, Value};

use super::{
    raw_block_id, scoped_stable_id, xlsx, BuiltDocumentIndex, IndexedChunk, IndexedNode,
    MAX_CHUNK_CONTENT_CHARS,
};

#[derive(Clone)]
struct HeadingContext {
    node_id: String,
    level: i32,
}

#[derive(Default)]
pub(super) struct DocxBlockIndexer {
    heading_stack: Vec<HeadingContext>,
}

impl DocxBlockIndexer {
    pub(super) fn build_block(
        &mut self,
        document_id: &str,
        block: &Value,
        order_index: usize,
        index: &mut BuiltDocumentIndex,
    ) {
        build_docx_like_block_index(
            document_id,
            block,
            order_index,
            &mut self.heading_stack,
            index,
        );
    }
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

pub(super) fn build_docx_section_chunks(
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

pub(super) fn extract_block_text(block: &Value) -> String {
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
                    .map(xlsx::extract_excel_row_text)
                    .filter(|row| !row.trim().is_empty())
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default(),
        _ => String::new(),
    }
}
