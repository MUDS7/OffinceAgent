use std::collections::{BTreeMap, HashMap};

use serde_json::{json, Map, Value};

use super::{
    raw_block_id, scoped_stable_id, BuiltDocumentIndex, IndexedChunk, IndexedNode,
    XLSX_CHUNK_DATA_ROW_COUNT,
};

pub(super) fn build_excel_sheet_index(
    document_id: &str,
    block: &Value,
    order_index: usize,
    index: &mut BuiltDocumentIndex,
) {
    // 结构节点按 sheet -> row/range 建树，方便 UI 或检索结果回到表格位置。
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

    // 每个非空行生成一个 excel_cell_range node；chunk 由后面的行组逻辑单独负责。
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

// 解析后的工作表范围和内容。列索引用 0-based，行号保持 Excel 的 1-based。
#[derive(Clone)]
struct ExcelSheetData {
    name: String,
    range_label: String,
    row_start: usize,
    row_end: usize,
    col_start: usize,
    col_end: usize,
    rows: Vec<ExcelRowData>,
    merges: Vec<ExcelMergedRange>,
}

// 单行的稀疏单元格数据，只保存解析器明确给出的非空/有值单元格。
#[derive(Clone)]
struct ExcelRowData {
    row_index: usize,
    cells: BTreeMap<usize, String>,
}

// 合并单元格单独保存，读取空白格时可以继承合并区域左上角的值。
#[derive(Clone)]
struct ExcelMergedRange {
    range_label: String,
    start_row: usize,
    end_row: usize,
    start_col: usize,
    end_col: usize,
    value: String,
}

// 写入 chunk 的规整行数据，cells 顺序与 headers 一一对应。
#[derive(Clone)]
struct ExcelChunkRow {
    row_index: usize,
    cells: Vec<String>,
}

pub(super) fn build_xlsx_row_group_chunks(
    document_id: &str,
    filename: &str,
    blocks: &[Value],
    order_start: usize,
) -> Vec<IndexedChunk> {
    // XLSX chunk 以“表头 + 若干数据行”为单位，避免整张大表检索粒度过粗。
    let mut chunks = Vec::new();

    for (sheet_index, block) in blocks.iter().enumerate() {
        if block.get("type").and_then(Value::as_str) != Some("excel_sheet") {
            continue;
        }

        let Some(sheet) = parse_excel_sheet_data(block) else {
            continue;
        };
        let Some(header_row_index) = first_non_empty_excel_row(&sheet) else {
            continue;
        };
        // 默认第一行非空数据作为表头，后续非空行按固定行数分组。
        let columns = (sheet.col_start..=sheet.col_end).collect::<Vec<_>>();
        let headers = build_excel_headers(&sheet, header_row_index, &columns);
        let data_rows = sheet
            .rows
            .iter()
            .filter(|row| row.row_index > header_row_index)
            .filter(|row| excel_row_has_data(&sheet, row.row_index, &columns))
            .map(|row| ExcelChunkRow {
                row_index: row.row_index,
                cells: columns
                    .iter()
                    .map(|col| excel_cell_text(&sheet, row.row_index, *col))
                    .collect(),
            })
            .collect::<Vec<_>>();

        for (group_index, row_group) in data_rows.chunks(XLSX_CHUNK_DATA_ROW_COUNT).enumerate() {
            // 空分组理论上不会出现，保留防御性判断使逻辑更稳。
            let Some(first_row) = row_group.first() else {
                continue;
            };
            let Some(last_row) = row_group.last() else {
                continue;
            };
            let row_start = first_row.row_index;
            let row_end = last_row.row_index;
            let content = build_xlsx_chunk_text(
                filename,
                &sheet.name,
                row_start,
                row_end,
                &headers,
                row_group,
            );
            let chunk_id = scoped_stable_id(
                "chunk",
                document_id,
                &format!(
                    "xlsx-row-group:{sheet_index}:{group_index}:{}:{header_row_index}:{row_start}:{row_end}",
                    sheet.name
                ),
            );
            // metadata 保存结构化行数据，plain_text/content 则面向 embedding 和文本预览。
            let row_jsons = build_xlsx_chunk_rows_json(&headers, row_group);
            let merge_jsons = sheet
                .merges
                .iter()
                .map(|merge| {
                    json!({
                        "range": merge.range_label,
                        "row_start": merge.start_row,
                        "row_end": merge.end_row,
                        "col_start": excel_column_label(merge.start_col),
                        "col_end": excel_column_label(merge.end_col),
                        "value": merge.value,
                    })
                })
                .collect::<Vec<_>>();
            let metadata = json!({
                "chunk_id": chunk_id,
                "file_id": document_id,
                "file_name": filename,
                "sheet_name": sheet.name,
                "chunk_type": "xlsx_row_group",
                "header_row_index": header_row_index,
                "data_start_row": header_row_index + 1,
                "data_end_row": sheet.row_end,
                "row_start": row_start,
                "row_end": row_end,
                "headers": headers,
                "sheet_range": sheet.range_label,
                "merged_ranges": merge_jsons,
                "rows": row_jsons,
            });

            chunks.push(IndexedChunk {
                id: chunk_id,
                chunk_type: "xlsx_row_group".to_string(),
                title_level_1: Some(sheet.name.clone()),
                title_level_2: None,
                title_level_3: None,
                title_path: sheet.name.clone(),
                heading_level: Some(1),
                content: content.clone(),
                plain_text: content,
                images_json: Value::Array(Vec::new()).to_string(),
                tables_json: Value::Array(Vec::new()).to_string(),
                paragraph_start_index: None,
                paragraph_end_index: None,
                order_index: order_start + chunks.len(),
                metadata_json: metadata.to_string(),
            });
        }
    }

    chunks
}

fn parse_excel_sheet_data(block: &Value) -> Option<ExcelSheetData> {
    // 优先使用上游提供的 range；没有 range 时从实际行列推导工作表边界。
    let name = block
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Sheet")
        .to_string();
    let range_label = block
        .get("range")
        .and_then(Value::as_str)
        .unwrap_or("A1:A1")
        .to_string();
    let parsed_range = parse_excel_range(&range_label);
    let mut rows = parse_excel_rows(block, parsed_range.as_ref().map(|range| range.0));
    rows.sort_by_key(|row| row.row_index);

    let derived_range = derive_excel_range_from_rows(&rows);
    let (row_start, row_end, col_start, col_end) =
        parsed_range.or(derived_range).unwrap_or((1, 1, 0, 0));
    let mut sheet = ExcelSheetData {
        name,
        range_label,
        row_start,
        row_end,
        col_start,
        col_end,
        rows,
        merges: Vec::new(),
    };
    sheet.merges = parse_excel_merged_ranges(block, &sheet);
    // 补齐范围内缺失的空行，后续按行号访问时就不用再处理断档。
    ensure_excel_rows_cover_range(&mut sheet);

    Some(sheet)
}

fn parse_excel_rows(block: &Value, fallback_row_start: Option<usize>) -> Vec<ExcelRowData> {
    // 行号来源依次为 row_index、range、首个单元格地址、工作表起始行 + offset。
    let Some(rows) = block.get("rows").and_then(Value::as_array) else {
        return Vec::new();
    };

    rows.iter()
        .enumerate()
        .map(|(offset, row)| {
            let row_index = row
                .get("row_index")
                .and_then(Value::as_u64)
                .map(|value| value.max(1) as usize)
                .or_else(|| {
                    row.get("range")
                        .and_then(Value::as_str)
                        .and_then(parse_excel_range)
                        .map(|range| range.0)
                })
                .or_else(|| first_cell_address_in_row(row).map(|(row_index, _)| row_index))
                .unwrap_or_else(|| fallback_row_start.unwrap_or(1) + offset);
            let cells = row
                .get("cells")
                .and_then(Value::as_array)
                .map(|cells| {
                    cells
                        .iter()
                        .filter_map(|cell| {
                            let (_, col) = cell
                                .get("address")
                                .and_then(Value::as_str)
                                .and_then(parse_excel_cell_address)?;
                            Some((col, excel_cell_value(cell)))
                        })
                        .collect::<BTreeMap<_, _>>()
                })
                .unwrap_or_default();

            ExcelRowData { row_index, cells }
        })
        .collect()
}

fn parse_excel_merged_ranges(block: &Value, sheet: &ExcelSheetData) -> Vec<ExcelMergedRange> {
    // merge.value 缺失时，尝试用合并区域左上角单元格的实际文本补上。
    block
        .get("merges")
        .and_then(Value::as_array)
        .map(|merges| {
            merges
                .iter()
                .filter_map(|merge| {
                    let range_label = merge
                        .get("range")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let (start_row, end_row, start_col, end_col) = parse_excel_range(&range_label)?;
                    let value = merge
                        .get("value")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| {
                            excel_cell_text_without_merges(sheet, start_row, start_col)
                        });

                    Some(ExcelMergedRange {
                        range_label,
                        start_row,
                        end_row,
                        start_col,
                        end_col,
                        value,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn ensure_excel_rows_cover_range(sheet: &mut ExcelSheetData) {
    // 让 sheet.rows 覆盖 row_start..=row_end，便于合并单元格和空行判断统一处理。
    if sheet.rows.is_empty() {
        sheet.rows.push(ExcelRowData {
            row_index: sheet.row_start,
            cells: BTreeMap::new(),
        });
        return;
    }

    let existing = sheet
        .rows
        .iter()
        .map(|row| (row.row_index, row.clone()))
        .collect::<BTreeMap<_, _>>();
    sheet.rows = (sheet.row_start..=sheet.row_end)
        .map(|row_index| {
            existing
                .get(&row_index)
                .cloned()
                .unwrap_or_else(|| ExcelRowData {
                    row_index,
                    cells: BTreeMap::new(),
                })
        })
        .collect();
}

fn derive_excel_range_from_rows(rows: &[ExcelRowData]) -> Option<(usize, usize, usize, usize)> {
    // 从实际单元格坐标推导最小包围范围，作为缺失/无效 sheet range 的兜底。
    let row_start = rows.iter().map(|row| row.row_index).min()?;
    let row_end = rows.iter().map(|row| row.row_index).max()?;
    let col_start = rows
        .iter()
        .flat_map(|row| row.cells.keys().copied())
        .min()
        .unwrap_or(0);
    let col_end = rows
        .iter()
        .flat_map(|row| row.cells.keys().copied())
        .max()
        .unwrap_or(col_start);

    Some((row_start, row_end, col_start, col_end))
}

fn first_non_empty_excel_row(sheet: &ExcelSheetData) -> Option<usize> {
    // 当前策略把第一条含数据的行视为表头。
    let columns = (sheet.col_start..=sheet.col_end).collect::<Vec<_>>();
    sheet
        .rows
        .iter()
        .find(|row| excel_row_has_data(sheet, row.row_index, &columns))
        .map(|row| row.row_index)
}

fn build_excel_headers(
    sheet: &ExcelSheetData,
    header_row_index: usize,
    columns: &[usize],
) -> Vec<String> {
    // 空表头用列名兜底，重复表头追加 _2/_3，保证 JSON key 可区分。
    let mut counts: HashMap<String, usize> = HashMap::new();

    columns
        .iter()
        .map(|col| {
            let raw_header = excel_cell_text(sheet, header_row_index, *col);
            let base = if raw_header.trim().is_empty() {
                format!("{}列", excel_column_label(*col))
            } else {
                raw_header.trim().to_string()
            };
            let count = counts.entry(base.clone()).or_insert(0);
            *count += 1;
            if *count == 1 {
                base
            } else {
                format!("{base}_{count}")
            }
        })
        .collect()
}

fn excel_row_has_data(sheet: &ExcelSheetData, row_index: usize, columns: &[usize]) -> bool {
    // 判断数据行时也读取合并单元格值，避免合并区域内的行被误认为空行。
    columns
        .iter()
        .any(|col| !excel_cell_text(sheet, row_index, *col).trim().is_empty())
}

fn excel_cell_text(sheet: &ExcelSheetData, row_index: usize, col_index: usize) -> String {
    // 单元格自身为空时，尝试从所在合并区域继承显示值。
    let own_value = excel_cell_text_without_merges(sheet, row_index, col_index);
    if !own_value.trim().is_empty() {
        return own_value;
    }

    sheet
        .merges
        .iter()
        .find(|merge| {
            row_index >= merge.start_row
                && row_index <= merge.end_row
                && col_index >= merge.start_col
                && col_index <= merge.end_col
        })
        .map(|merge| merge.value.clone())
        .unwrap_or(own_value)
}

fn excel_cell_text_without_merges(
    sheet: &ExcelSheetData,
    row_index: usize,
    col_index: usize,
) -> String {
    sheet
        .rows
        .iter()
        .find(|row| row.row_index == row_index)
        .and_then(|row| row.cells.get(&col_index))
        .cloned()
        .unwrap_or_default()
}

fn build_xlsx_chunk_text(
    filename: &str,
    sheet_name: &str,
    row_start: usize,
    row_end: usize,
    headers: &[String],
    rows: &[ExcelChunkRow],
) -> String {
    // 生成适合 embedding 的可读文本：文件、sheet、行范围、表头和逐行键值。
    let mut lines = vec![
        format!("文档：{filename}"),
        format!("Sheet：{sheet_name}"),
        format!("行范围：{row_start}-{row_end}"),
        format!("表头字段：{}", headers.join("、")),
        String::new(),
        "数据：".to_string(),
    ];

    for row in rows {
        lines.push(format!("第{}行：", row.row_index));
        for (header, value) in headers.iter().zip(&row.cells) {
            lines.push(format!("{header}：{value}"));
        }
        lines.push(String::new());
    }

    lines
        .into_iter()
        .collect::<Vec<_>>()
        .join("\n")
        .trim_end()
        .to_string()
}

fn build_xlsx_chunk_rows_json(headers: &[String], rows: &[ExcelChunkRow]) -> Vec<Value> {
    // 把每行转成 {header: value}，供 metadata_json 保留结构化表格语义。
    rows.iter()
        .map(|row| {
            let mut cells = Map::new();
            for (header, value) in headers.iter().zip(&row.cells) {
                cells.insert(header.clone(), Value::String(value.clone()));
            }
            json!({
                "row_index": row.row_index,
                "cells": Value::Object(cells),
            })
        })
        .collect()
}

fn excel_cell_value(cell: &Value) -> String {
    // 兼容 text/value 两种上游字段，最终统一裁掉首尾空白。
    cell.get("text")
        .and_then(Value::as_str)
        .or_else(|| cell.get("value").and_then(Value::as_str))
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn first_cell_address_in_row(row: &Value) -> Option<(usize, usize)> {
    // 如果行级信息缺失，可用第一个单元格地址反推出行号。
    row.get("cells")
        .and_then(Value::as_array)
        .and_then(|cells| cells.first())
        .and_then(|cell| cell.get("address"))
        .and_then(Value::as_str)
        .and_then(parse_excel_cell_address)
}

fn parse_excel_range(range: &str) -> Option<(usize, usize, usize, usize)> {
    // 支持 A1 或 A1:C10 两种写法，并自动规整起止顺序。
    let (start, end) = range.split_once(':').unwrap_or((range, range));
    let (start_row, start_col) = parse_excel_cell_address(start)?;
    let (end_row, end_col) = parse_excel_cell_address(end)?;
    Some((
        start_row.min(end_row),
        start_row.max(end_row),
        start_col.min(end_col),
        start_col.max(end_col),
    ))
}

fn parse_excel_cell_address(address: &str) -> Option<(usize, usize)> {
    // 解析 Excel 地址为 (1-based row, 0-based column)，同时支持 $A$1 绝对引用。
    let trimmed = address.trim();
    if trimmed.is_empty() {
        return None;
    }

    let mut column = 0usize;
    let mut row = 0usize;
    let mut saw_column = false;
    let mut saw_row = false;
    for character in trimmed.chars() {
        if character == '$' {
            continue;
        }
        if character.is_ascii_alphabetic() {
            if saw_row {
                return None;
            }
            saw_column = true;
            column = column * 26 + (character.to_ascii_uppercase() as usize - 'A' as usize + 1);
        } else if character.is_ascii_digit() {
            saw_row = true;
            row = row * 10 + character.to_digit(10)? as usize;
        } else {
            return None;
        }
    }

    if !saw_column || !saw_row || row == 0 || column == 0 {
        return None;
    }

    Some((row, column - 1))
}

fn excel_column_label(mut col_index: usize) -> String {
    // 0-based 列序号转 Excel 列名：0 -> A, 25 -> Z, 26 -> AA。
    let mut label = String::new();
    loop {
        let remainder = col_index % 26;
        label.insert(0, (b'A' + remainder as u8) as char);
        if col_index < 26 {
            break;
        }
        col_index = col_index / 26 - 1;
    }
    label
}

pub(super) fn extract_excel_row_text(row: &Value) -> String {
    // 结构节点展示用文本保留单元格地址，方便从搜索命中定位到具体格子。
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
