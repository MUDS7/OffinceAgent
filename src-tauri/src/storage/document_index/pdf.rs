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

#[derive(Clone)]
struct PdfParagraphData {
    page_number: usize,
    global_paragraph_index: usize,
    text: String,
}

#[derive(Clone)]
struct PdfHeadingCandidate {
    start: usize,
    end: usize,
    number: String,
    level: i32,
}

#[derive(Clone)]
struct PdfSectionSegment {
    level: i32,
    title: String,
    title_levels: Vec<String>,
    title_path: String,
    content: String,
    page_start: usize,
    page_end: usize,
    paragraph_start_index: usize,
    paragraph_end_index: usize,
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
    let mut indexed_paragraphs = Vec::new();

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
            indexed_paragraphs.push(PdfParagraphData {
                page_number: page.page_number,
                global_paragraph_index,
                text: trimmed.to_string(),
            });
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

    let section_chunks = build_pdf_section_chunks(
        document_id,
        filename,
        &indexed_paragraphs,
        index.chunks.len(),
    );
    index.chunks.extend(section_chunks);

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
                let paragraph_source =
                    extract_pdf_source_text(block).unwrap_or_else(|| text.clone());
                // 解析器若没有给 paragraphs，就从整页文本的空行中推断段落。
                let paragraphs = extract_pdf_paragraphs(block)
                    .or_else(|| Some(split_pdf_text_into_paragraphs(&paragraph_source)))
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

fn extract_pdf_source_text(block: &Value) -> Option<String> {
    for key in ["text", "page_text", "content"] {
        if let Some(text) = block.get(key).and_then(Value::as_str) {
            return Some(text.to_string());
        }
    }

    None
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

fn build_pdf_section_chunks(
    document_id: &str,
    filename: &str,
    paragraphs: &[PdfParagraphData],
    order_index_offset: usize,
) -> Vec<IndexedChunk> {
    let sections = build_pdf_numbered_sections(paragraphs);
    let mut chunks = Vec::new();

    for section_index in 0..sections.len() {
        let section = &sections[section_index];
        let descendant_end = sections[section_index + 1..]
            .iter()
            .position(|candidate| candidate.level <= section.level)
            .map(|offset| section_index + 1 + offset)
            .unwrap_or(sections.len());
        let section_family = &sections[section_index..descendant_end];
        let content = section_family
            .iter()
            .map(|segment| segment.content.trim())
            .filter(|content| !content.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");

        if content.trim().is_empty() {
            continue;
        }

        let page_end = section_family
            .iter()
            .map(|segment| segment.page_end)
            .max()
            .unwrap_or(section.page_end);
        let paragraph_end_index = section_family
            .iter()
            .map(|segment| segment.paragraph_end_index)
            .max()
            .unwrap_or(section.paragraph_end_index);

        emit_pdf_section_chunks(
            document_id,
            filename,
            order_index_offset,
            section_index,
            section,
            &content,
            section.page_start,
            page_end,
            section.paragraph_start_index,
            paragraph_end_index,
            &mut chunks,
        );
    }

    chunks
}

fn build_pdf_numbered_sections(paragraphs: &[PdfParagraphData]) -> Vec<PdfSectionSegment> {
    let mut segments: Vec<PdfSectionSegment> = Vec::new();

    for paragraph in paragraphs {
        let candidates = find_pdf_heading_candidates(&paragraph.text);
        if candidates.is_empty() {
            append_to_last_pdf_section(&mut segments, paragraph);
            continue;
        }

        if candidates[0].start > 0 {
            append_pdf_section_text(
                &mut segments,
                paragraph.text[..candidates[0].start].trim(),
                paragraph.page_number,
                paragraph.global_paragraph_index,
            );
        }

        for (candidate_index, candidate) in candidates.iter().enumerate() {
            let next_start = candidates
                .get(candidate_index + 1)
                .map(|next| next.start)
                .unwrap_or(paragraph.text.len());
            let content = paragraph.text[candidate.start..next_start].trim();
            if content.is_empty() {
                continue;
            }

            segments.push(PdfSectionSegment {
                level: candidate.level,
                title: pdf_heading_title(&candidate.number, content),
                title_levels: Vec::new(),
                title_path: String::new(),
                content: content.to_string(),
                page_start: paragraph.page_number,
                page_end: paragraph.page_number,
                paragraph_start_index: paragraph.global_paragraph_index,
                paragraph_end_index: paragraph.global_paragraph_index,
            });
        }
    }

    apply_pdf_section_title_paths(&mut segments);
    segments
}

fn append_to_last_pdf_section(segments: &mut [PdfSectionSegment], paragraph: &PdfParagraphData) {
    append_pdf_section_text(
        segments,
        &paragraph.text,
        paragraph.page_number,
        paragraph.global_paragraph_index,
    );
}

fn append_pdf_section_text(
    segments: &mut [PdfSectionSegment],
    text: &str,
    page_number: usize,
    paragraph_index: usize,
) {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return;
    }

    if let Some(section) = segments.last_mut() {
        if !section.content.trim().is_empty() {
            section.content.push_str("\n\n");
        }
        section.content.push_str(trimmed);
        section.page_end = page_number;
        section.paragraph_end_index = paragraph_index;
    }
}

fn apply_pdf_section_title_paths(segments: &mut [PdfSectionSegment]) {
    let mut stack: Vec<(i32, String)> = Vec::new();

    for segment in segments {
        while stack
            .last()
            .map(|(level, _)| *level >= segment.level)
            .unwrap_or(false)
        {
            stack.pop();
        }

        let mut title_levels = stack
            .iter()
            .map(|(_, title)| title.clone())
            .collect::<Vec<_>>();
        title_levels.push(segment.title.clone());
        segment.title_path = title_levels.join(" > ");
        segment.title_levels = title_levels;
        stack.push((segment.level, segment.title.clone()));
    }
}

fn find_pdf_heading_candidates(text: &str) -> Vec<PdfHeadingCandidate> {
    let mut candidates = Vec::new();
    let mut index = 0usize;

    while index < text.len() {
        let Some(character) = text[index..].chars().next() else {
            break;
        };

        if !character.is_ascii_digit() || !has_pdf_heading_left_boundary(text, index) {
            index += character.len_utf8();
            continue;
        }

        if let Some(candidate) = parse_pdf_heading_candidate(text, index) {
            index = candidate.end;
            candidates.push(candidate);
        } else {
            index += character.len_utf8();
        }
    }

    candidates
}

fn parse_pdf_heading_candidate(text: &str, start: usize) -> Option<PdfHeadingCandidate> {
    let mut end = start;
    let mut number = String::new();
    let mut component = String::new();
    let mut component_count = 0usize;
    let mut saw_dot = false;
    let mut previous_was_dot = false;

    for (offset, character) in text[start..].char_indices() {
        if character.is_ascii_digit() {
            component.push(character);
            number.push(character);
            previous_was_dot = false;
            end = start + offset + character.len_utf8();
            continue;
        }

        if character == '.' || character == '．' {
            if component.is_empty() {
                return None;
            }
            component_count += 1;
            if component_count > 6
                || !valid_pdf_heading_number_component(&component, component_count)
            {
                return None;
            }
            component.clear();
            number.push('.');
            saw_dot = true;
            previous_was_dot = true;
            end = start + offset + character.len_utf8();
            continue;
        }

        break;
    }

    if component.is_empty() || previous_was_dot {
        return None;
    }

    component_count += 1;
    if component_count > 6 || !valid_pdf_heading_number_component(&component, component_count) {
        return None;
    }

    let next = text[end..].chars().next();
    if !has_pdf_heading_right_boundary(next, saw_dot) {
        return None;
    }

    if !saw_dot && !looks_like_pdf_top_level_heading(text, start, end) {
        return None;
    }

    Some(PdfHeadingCandidate {
        start,
        end,
        number,
        level: component_count as i32,
    })
}

fn valid_pdf_heading_number_component(component: &str, component_index: usize) -> bool {
    if component.len() > 3 {
        return false;
    }

    let Ok(value) = component.parse::<usize>() else {
        return false;
    };

    if component_index == 1 {
        (1..=30).contains(&value) && component.len() <= 2
    } else {
        value > 0
    }
}

fn has_pdf_heading_left_boundary(text: &str, start: usize) -> bool {
    text[..start]
        .chars()
        .next_back()
        .map(|character| {
            character.is_whitespace()
                || matches!(
                    character,
                    '(' | '['
                        | '{'
                        | '<'
                        | '（'
                        | '【'
                        | '《'
                        | '。'
                        | '；'
                        | '，'
                        | '、'
                        | ':'
                        | '：'
                        | ';'
                        | ','
                )
        })
        .unwrap_or(true)
}

fn has_pdf_heading_right_boundary(next: Option<char>, saw_dot: bool) -> bool {
    match next {
        None => true,
        Some(character) if character.is_whitespace() => true,
        Some(character) if !saw_dot && is_pdf_top_level_heading_separator(character) => true,
        Some(character) if saw_dot && !character.is_ascii_alphanumeric() => true,
        _ => false,
    }
}

fn looks_like_pdf_top_level_heading(text: &str, start: usize, end: usize) -> bool {
    let Ok(chapter_number) = text[start..end].parse::<usize>() else {
        return false;
    };

    if !(1..=30).contains(&chapter_number) {
        return false;
    }

    let following_text = trim_pdf_top_level_heading_prefix(&text[end..]);
    let has_title_text = following_text
        .chars()
        .next()
        .map(|character| !character.is_ascii_digit() && !character.is_ascii_punctuation())
        .unwrap_or(false);
    if !has_title_text {
        return false;
    }

    let child_prefix = format!("{chapter_number}.");
    following_text.contains(&child_prefix)
        || (following_text.chars().count() <= 80
            && !following_text
                .chars()
                .any(|character| matches!(character, '。' | '；' | ';')))
}

fn trim_pdf_top_level_heading_prefix(text: &str) -> &str {
    text.trim_start_matches(|character: char| {
        character.is_whitespace() || is_pdf_top_level_heading_separator(character)
    })
}

fn is_pdf_top_level_heading_separator(character: char) -> bool {
    matches!(character, '\u{3001}' | '\u{ff1a}' | ':' | '-' | '\u{ff0d}')
}

fn pdf_heading_title(number: &str, content: &str) -> String {
    let rest = content
        .strip_prefix(number)
        .unwrap_or(content)
        .trim_start_matches(|character: char| {
            character.is_whitespace()
                || matches!(character, '.' | '．' | '\u{3001}' | '-' | '\u{ff0d}')
        })
        .trim();
    let title = rest
        .chars()
        .take_while(|character| !matches!(character, '。' | '；' | ';' | '\n' | '\r'))
        .take(80)
        .collect::<String>()
        .trim()
        .to_string();

    if title.is_empty() {
        number.to_string()
    } else {
        format!("{number} {title}")
    }
}

fn emit_pdf_section_chunks(
    document_id: &str,
    filename: &str,
    order_index_offset: usize,
    section_index: usize,
    section: &PdfSectionSegment,
    content: &str,
    page_start: usize,
    page_end: usize,
    paragraph_start_index: usize,
    paragraph_end_index: usize,
    chunks: &mut Vec<IndexedChunk>,
) {
    let pieces = split_long_text(content, MAX_CHUNK_CONTENT_CHARS);
    let piece_count = pieces.len();

    for (piece_index, piece) in pieces.into_iter().enumerate() {
        let chunk_index = order_index_offset + chunks.len();
        let chunk_id = scoped_stable_id(
            "chunk",
            document_id,
            &format!(
                "pdf-section:{section_index}:{}:{paragraph_start_index}:{paragraph_end_index}:{}",
                section.title_path,
                piece_index + 1
            ),
        );
        let plain_text = build_pdf_section_embedding_text(
            filename,
            &section.title_path,
            page_start,
            page_end,
            paragraph_start_index,
            paragraph_end_index,
            &piece,
        );
        let title_level_1 = section.title_levels.first().cloned();
        let title_level_2 = section.title_levels.get(1).cloned();
        let title_level_3 = section.title_levels.get(2).cloned();
        let metadata = json!({
            "chunk_id": chunk_id,
            "file_id": document_id,
            "file_name": filename,
            "chunk_type": "pdf_section",
            "title_level_1": title_level_1,
            "title_level_2": title_level_2,
            "title_level_3": title_level_3,
            "title_path": section.title_path,
            "heading_level": section.level,
            "page_start": page_start,
            "page_end": page_end,
            "paragraph_start_index": paragraph_start_index,
            "paragraph_end_index": paragraph_end_index,
            "section_piece_index": piece_index + 1,
            "section_piece_count": piece_count,
        });

        chunks.push(IndexedChunk {
            id: chunk_id,
            chunk_type: "pdf_section".to_string(),
            title_level_1,
            title_level_2,
            title_level_3,
            title_path: section.title_path.clone(),
            heading_level: Some(section.level),
            content: piece,
            plain_text,
            images_json: Value::Array(Vec::new()).to_string(),
            tables_json: Value::Array(Vec::new()).to_string(),
            paragraph_start_index: Some(paragraph_start_index),
            paragraph_end_index: Some(paragraph_end_index),
            order_index: chunk_index,
            metadata_json: metadata.to_string(),
        });
    }
}

fn build_pdf_section_embedding_text(
    filename: &str,
    title_path: &str,
    page_start: usize,
    page_end: usize,
    paragraph_start_index: usize,
    paragraph_end_index: usize,
    content: &str,
) -> String {
    [
        format!("Document: {filename}"),
        format!("Title path: {title_path}"),
        format!("Pages: {page_start}-{page_end}"),
        format!("Paragraphs: {paragraph_start_index}-{paragraph_end_index}"),
        String::new(),
        content.to_string(),
    ]
    .join("\n")
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
