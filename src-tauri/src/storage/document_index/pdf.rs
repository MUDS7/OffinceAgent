use serde_json::{json, Value};

use super::{
    raw_block_id, scoped_stable_id, BuiltDocumentIndex, IndexedChunk, IndexedNode,
    MAX_CHUNK_CONTENT_CHARS,
};

// PDF 索引先归一化为“页面 + 页面内段落”，后续 node 和 chunk 都基于这个结构生成。
#[derive(Clone)]
struct PdfPageData {
    page_number: usize,
    raw_id: String,
    text: String,
    paragraphs: Vec<String>,
    metadata: Value,
}

pub(super) fn is_pdf_document(filename: &str, blocks: &[Value]) -> bool {
    // 文件扩展名和 block 类型任一命中即可走 PDF 专用路径，兼容不同解析器输出。
    filename
        .rsplit_once('.')
        .map(|(_, extension)| extension.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false)
        || blocks.iter().any(|block| {
            matches!(
                block.get("type").and_then(Value::as_str),
                Some("pdf_page") | Some("pdf_paragraph")
            )
        })
}

pub(super) fn build_pdf_index(
    document_id: &str,
    filename: &str,
    blocks: &[Value],
) -> BuiltDocumentIndex {
    // PDF 的层级比较固定：page node 下面挂 paragraph node，paragraph 同时生成检索 chunk。
    let pages = extract_pdf_pages(blocks);
    let mut index = BuiltDocumentIndex::default();
    let mut global_paragraph_index = 0usize;

    for (page_index, page) in pages.iter().enumerate() {
        let page_node_id = scoped_stable_id("node", document_id, &page.raw_id);
        let page_title = format!("Page {}", page.page_number);

        index.nodes.push(IndexedNode {
            id: page_node_id.clone(),
            parent_id: None,
            node_type: "pdf_page".to_string(),
            level: Some(1),
            title: Some(page_title.clone()),
            text: (!page.text.trim().is_empty()).then(|| page.text.clone()),
            order_index: page_index,
            metadata_json: page.metadata.to_string(),
        });

        for (page_paragraph_index, paragraph) in page.paragraphs.iter().enumerate() {
            // 段落全局序号用于跨页定位，页内序号用于回到具体页面位置。
            let trimmed = paragraph.trim();
            if trimmed.is_empty() {
                continue;
            }

            global_paragraph_index += 1;
            let paragraph_raw_id =
                format!("{}:paragraph:{}", page.raw_id, page_paragraph_index + 1);
            let paragraph_node_id = scoped_stable_id("node", document_id, &paragraph_raw_id);
            let metadata = json!({
                "type": "pdf_paragraph",
                "page_number": page.page_number,
                "page_paragraph_index": page_paragraph_index + 1,
                "paragraph_index": global_paragraph_index,
                "source_page_id": page.raw_id,
            });

            index.nodes.push(IndexedNode {
                id: paragraph_node_id,
                parent_id: Some(page_node_id.clone()),
                node_type: "pdf_paragraph".to_string(),
                level: None,
                title: Some(format!(
                    "Page {} Paragraph {}",
                    page.page_number,
                    page_paragraph_index + 1
                )),
                text: Some(trimmed.to_string()),
                order_index: page_index * 100_000 + page_paragraph_index + 1,
                metadata_json: metadata.to_string(),
            });

            emit_pdf_paragraph_chunks(
                document_id,
                filename,
                page.page_number,
                page_paragraph_index + 1,
                global_paragraph_index,
                trimmed,
                &mut index.chunks,
            );
        }
    }

    index
}

fn extract_pdf_pages(blocks: &[Value]) -> Vec<PdfPageData> {
    // 优先使用显式 pdf_page/page；如果只有散段落，则按 page_number 重新组装页面。
    let mut pages = Vec::new();
    let mut loose_paragraphs = Vec::new();

    for (block_index, block) in blocks.iter().enumerate() {
        match block.get("type").and_then(Value::as_str) {
            Some("pdf_page") | Some("page") => {
                let raw_id = raw_block_id(block, block_index);
                let page_number = extract_page_number(block).unwrap_or(pages.len() + 1);
                let text = extract_pdf_text(block);
                // 解析器若没有给 paragraphs，就从整页文本的空行中推断段落。
                let paragraphs = extract_pdf_paragraphs(block)
                    .or_else(|| Some(split_pdf_text_into_paragraphs(&text)))
                    .unwrap_or_default();

                pages.push(PdfPageData {
                    page_number,
                    raw_id,
                    text,
                    paragraphs,
                    metadata: block.clone(),
                });
            }
            Some("pdf_paragraph") | Some("paragraph") => {
                let text = extract_pdf_text(block);
                if text.trim().is_empty() {
                    continue;
                }
                let page_number = extract_page_number(block).unwrap_or(1);
                loose_paragraphs.push((page_number, text));
            }
            _ => {}
        }
    }

    if !pages.is_empty() {
        return pages;
    }

    let mut grouped_pages: Vec<PdfPageData> = Vec::new();
    for (page_number, paragraph) in loose_paragraphs {
        if let Some(page) = grouped_pages
            .iter_mut()
            .find(|page| page.page_number == page_number)
        {
            if !page.text.is_empty() {
                page.text.push('\n');
            }
            page.text.push_str(&paragraph);
            page.paragraphs.push(paragraph);
            continue;
        }

        grouped_pages.push(PdfPageData {
            page_number,
            raw_id: format!("page-{page_number}"),
            text: paragraph.clone(),
            paragraphs: vec![paragraph],
            metadata: json!({
                "type": "pdf_page",
                "page_number": page_number,
                "source": "loose_paragraphs",
            }),
        });
    }

    grouped_pages
}

fn extract_page_number(block: &Value) -> Option<usize> {
    // 只接受正数页码，缺失时由调用方按顺序兜底。
    block
        .get("page_number")
        .or_else(|| block.get("page"))
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .map(|value| value as usize)
}

fn extract_pdf_text(block: &Value) -> String {
    // 支持多种解析器字段名；items[].str 对应 pdf.js 一类的文本项输出。
    for key in ["text", "page_text", "content"] {
        if let Some(text) = block.get(key).and_then(Value::as_str) {
            return normalize_pdf_whitespace(text);
        }
    }

    block
        .get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("str").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(" ")
        })
        .map(|text| normalize_pdf_whitespace(&text))
        .unwrap_or_default()
}

fn extract_pdf_paragraphs(block: &Value) -> Option<Vec<String>> {
    // paragraphs 可以是字符串数组，也可以是带 text 字段的对象数组。
    let paragraphs = block.get("paragraphs")?.as_array()?;
    let values = paragraphs
        .iter()
        .filter_map(|paragraph| {
            paragraph
                .as_str()
                .or_else(|| paragraph.get("text").and_then(Value::as_str))
        })
        .map(normalize_pdf_whitespace)
        .filter(|text| !text.trim().is_empty())
        .collect::<Vec<_>>();

    (!values.is_empty()).then_some(values)
}

fn split_pdf_text_into_paragraphs(text: &str) -> Vec<String> {
    // 空行作为段落边界；没有空行时至少返回一段压缩后的整页文本。
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut paragraphs = Vec::new();
    let mut current = Vec::new();

    for line in normalized.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if !current.is_empty() {
                paragraphs.push(normalize_pdf_whitespace(&current.join(" ")));
                current.clear();
            }
            continue;
        }
        current.push(trimmed.to_string());
    }

    if !current.is_empty() {
        paragraphs.push(normalize_pdf_whitespace(&current.join(" ")));
    }

    if paragraphs.is_empty() {
        let compact = normalize_pdf_whitespace(text);
        if !compact.is_empty() {
            paragraphs.push(compact);
        }
    }

    paragraphs
}

fn normalize_pdf_whitespace(text: &str) -> String {
    // PDF 提取文本常带有异常换行/多空格，这里统一压成单空格。
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn emit_pdf_paragraph_chunks(
    document_id: &str,
    filename: &str,
    page_number: usize,
    page_paragraph_index: usize,
    global_paragraph_index: usize,
    paragraph: &str,
    chunks: &mut Vec<IndexedChunk>,
) {
    // 单个 PDF 段落也可能很长，先按上限拆成多个 piece，再逐个写入 chunk。
    let pieces = split_long_text(paragraph, MAX_CHUNK_CONTENT_CHARS);
    let piece_count = pieces.len();

    for (piece_index, content) in pieces.into_iter().enumerate() {
        let chunk_index = chunks.len();
        let title_path = format!("Page {page_number}");
        let chunk_id = scoped_stable_id(
            "chunk",
            document_id,
            &format!(
                "pdf-paragraph:{page_number}:{global_paragraph_index}:{}",
                piece_index + 1
            ),
        );
        // plain_text 是送入 embedding 的文本，metadata_json 则保留页码和段落定位信息。
        let plain_text = build_pdf_embedding_text(
            filename,
            page_number,
            page_paragraph_index,
            global_paragraph_index,
            &content,
        );
        let metadata = json!({
            "chunk_id": chunk_id,
            "file_id": document_id,
            "file_name": filename,
            "chunk_type": "pdf_paragraph",
            "page_number": page_number,
            "page_paragraph_index": page_paragraph_index,
            "paragraph_index": global_paragraph_index,
            "paragraph_piece_index": piece_index + 1,
            "paragraph_piece_count": piece_count,
            "title_path": title_path,
        });

        chunks.push(IndexedChunk {
            id: chunk_id,
            chunk_type: "pdf_paragraph".to_string(),
            title_level_1: Some(title_path.clone()),
            title_level_2: None,
            title_level_3: None,
            title_path,
            heading_level: Some(1),
            content,
            plain_text,
            images_json: Value::Array(Vec::new()).to_string(),
            tables_json: Value::Array(Vec::new()).to_string(),
            paragraph_start_index: Some(global_paragraph_index),
            paragraph_end_index: Some(global_paragraph_index),
            order_index: chunk_index,
            metadata_json: metadata.to_string(),
        });
    }
}

fn build_pdf_embedding_text(
    filename: &str,
    page_number: usize,
    page_paragraph_index: usize,
    global_paragraph_index: usize,
    content: &str,
) -> String {
    // 将页码、全局段落序号和页内段落序号放进文本，提升检索结果可解释性。
    [
        format!("Document: {filename}"),
        format!("Page: {page_number}"),
        format!("Paragraph: {global_paragraph_index}"),
        format!("Page paragraph: {page_paragraph_index}"),
        String::new(),
        content.to_string(),
    ]
    .join("\n")
}

fn split_long_text(text: &str, max_chars: usize) -> Vec<String> {
    // 优先按词边界拆分；遇到超长连续字符串时再按字符强制切开。
    if text.chars().count() <= max_chars {
        return vec![text.to_string()];
    }

    let mut pieces = Vec::new();
    let mut current = String::new();

    for word in text.split_whitespace() {
        let separator_len = usize::from(!current.is_empty());
        if !current.is_empty()
            && current.chars().count() + separator_len + word.chars().count() > max_chars
        {
            pieces.push(current);
            current = String::new();
        }

        if word.chars().count() > max_chars {
            if !current.is_empty() {
                pieces.push(current);
                current = String::new();
            }
            pieces.extend(split_word_by_chars(word, max_chars));
            continue;
        }

        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(word);
    }

    if !current.is_empty() {
        pieces.push(current);
    }

    pieces
}

fn split_word_by_chars(word: &str, max_chars: usize) -> Vec<String> {
    // Rust 字符迭代按 Unicode scalar value 走，避免直接按字节切坏 UTF-8。
    let mut pieces = Vec::new();
    let mut current = String::new();

    for character in word.chars() {
        if current.chars().count() >= max_chars {
            pieces.push(current);
            current = String::new();
        }
        current.push(character);
    }

    if !current.is_empty() {
        pieces.push(current);
    }

    pieces
}
