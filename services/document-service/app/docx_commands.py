from __future__ import annotations

from base64 import b64encode
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from app.docx_document import build_docx_bytes, get_docx_block_text
from app.docx_models import (
    DocxBlock,
    DocxCommandCategory,
    DocxCommandName,
    DocxCommandSpec,
    DocxCommandsResponse,
    DocxExecuteRequest,
    DocxExecuteResponse,
    DocxParagraphBlock,
    DocxTableBlock,
    DocxTableCell,
)
def get_docx_commands() -> DocxCommandsResponse:
    return DocxCommandsResponse(
        basic=[
            DocxCommandSpec(
                command="replace_text",
                category="basic",
                description="Replace matching text in paragraphs and table cells.",
                required_args=["target_text", "replacement"],
                optional_args=["occurrence", "case_sensitive"],
            ),
            DocxCommandSpec(
                command="delete_text",
                category="basic",
                description="Delete matching text in paragraphs and table cells.",
                required_args=["target_text"],
                optional_args=["occurrence", "case_sensitive"],
            ),
            DocxCommandSpec(
                command="replace_paragraph",
                category="basic",
                description="Replace one paragraph by 1-based block_index or by matching target_text.",
                required_args=["text"],
                optional_args=["block_index", "target_text", "case_sensitive"],
            ),
            DocxCommandSpec(
                command="insert_paragraph",
                category="basic",
                description="Insert a paragraph before or after a 1-based block_index or a paragraph matching target_text.",
                required_args=["text"],
                optional_args=["block_index", "target_text", "position", "style", "alignment", "case_sensitive"],
            ),
            DocxCommandSpec(
                command="append_paragraph",
                category="basic",
                description="Append a paragraph to the end of the Word document.",
                required_args=["text"],
                optional_args=["style", "alignment"],
            ),
        ],
        advanced=[
            DocxCommandSpec(
                command="insert_table",
                category="advanced",
                description="Insert a table from a two-dimensional values array before, after, or at the end of the document.",
                required_args=["rows"],
                optional_args=["block_index", "target_text", "position", "case_sensitive"],
            )
        ],
    )


def execute_docx_command(request: DocxExecuteRequest) -> DocxExecuteResponse:
    blocks = clone_docx_blocks(request.blocks)

    if request.command == "replace_text":
        paragraphs_affected, tables_affected = replace_docx_text(
            blocks,
            str(required_arg(request.args, "target_text")),
            str(request.args.get("replacement", "")),
            request.args,
        )
        summary = f"Replaced text in {paragraphs_affected} paragraph(s) and {tables_affected} table cell(s)."
        return docx_response(request, blocks, paragraphs_affected, tables_affected, summary)

    if request.command == "delete_text":
        paragraphs_affected, tables_affected = replace_docx_text(
            blocks,
            str(required_arg(request.args, "target_text")),
            "",
            request.args,
        )
        summary = f"Deleted text in {paragraphs_affected} paragraph(s) and {tables_affected} table cell(s)."
        return docx_response(request, blocks, paragraphs_affected, tables_affected, summary)

    if request.command == "replace_paragraph":
        paragraphs_affected = replace_docx_paragraph(blocks, request.args)
        summary = f"Replaced {paragraphs_affected} paragraph(s)."
        return docx_response(request, blocks, paragraphs_affected, 0, summary)

    if request.command == "insert_paragraph":
        insert_docx_paragraph(blocks, request.args)
        summary = "Inserted 1 paragraph."
        return docx_response(request, blocks, 1, 0, summary)

    if request.command == "append_paragraph":
        blocks.append(make_docx_paragraph_block(blocks, request.args))
        summary = "Appended 1 paragraph."
        return docx_response(request, blocks, 1, 0, summary)

    if request.command == "insert_table":
        insert_docx_table(blocks, request.args)
        summary = "Inserted 1 table."
        return docx_response(request, blocks, 0, 1, summary)

    raise HTTPException(status_code=400, detail=f"Unsupported DOCX command: {request.command}")


def clone_docx_blocks(blocks: list[DocxBlock]) -> list[DocxBlock]:
    return [block.model_copy(deep=True) for block in blocks]


def replace_docx_text(
    blocks: list[DocxBlock],
    target_text: str,
    replacement: str,
    args: dict[str, Any],
) -> tuple[int, int]:
    target_text = target_text.strip()
    if not target_text:
        raise HTTPException(status_code=400, detail="target_text is required")

    remaining = parse_occurrence(args)
    paragraphs_affected = 0
    tables_affected = 0
    case_sensitive = parse_bool(args.get("case_sensitive"), default=True)

    for block in blocks:
        if remaining == 0:
            break

        if isinstance(block, DocxParagraphBlock):
            next_text, changed, remaining = replace_in_text(
                block.text,
                target_text,
                replacement,
                case_sensitive,
                remaining,
            )
            if changed:
                block.text = next_text
                paragraphs_affected += 1
            continue

        if isinstance(block, DocxTableBlock):
            for row in block.rows:
                for cell in row:
                    if remaining == 0:
                        break
                    next_text, changed, remaining = replace_in_text(
                        cell.text,
                        target_text,
                        replacement,
                        case_sensitive,
                        remaining,
                    )
                    if changed:
                        cell.text = next_text
                        tables_affected += 1

    if paragraphs_affected == 0 and tables_affected == 0:
        raise HTTPException(status_code=400, detail=f"Text not found: {target_text}")

    return paragraphs_affected, tables_affected


def replace_docx_paragraph(blocks: list[DocxBlock], args: dict[str, Any]) -> int:
    text = str(required_arg(args, "text"))
    block_index = resolve_docx_block_index(blocks, args, require_paragraph=True)
    block = blocks[block_index]
    if not isinstance(block, DocxParagraphBlock):
        raise HTTPException(status_code=400, detail="Target block is not a paragraph")

    block.text = text
    if "style" in args:
        block.style = str(args.get("style") or "")
    if "alignment" in args:
        block.alignment = normalize_docx_alignment(args.get("alignment"))
    return 1


def insert_docx_paragraph(blocks: list[DocxBlock], args: dict[str, Any]) -> None:
    block = make_docx_paragraph_block(blocks, args)
    position = str(args.get("position") or "after").lower()
    if position in {"end", "append", "at_end"}:
        blocks.append(block)
        return
    if position in {"start", "prepend", "at_start"}:
        blocks.insert(0, block)
        return

    target_index = resolve_docx_block_index(blocks, args, require_paragraph=False)
    insert_index = target_index if position == "before" else target_index + 1
    blocks.insert(insert_index, block)


def insert_docx_table(blocks: list[DocxBlock], args: dict[str, Any]) -> None:
    rows = normalize_table_rows(required_arg(args, "rows"))
    table = DocxTableBlock(
        id=next_docx_block_id(blocks, "t"),
        rows=[
            [
                DocxTableCell(
                    id=f"cell-{row_index}-{cell_index}",
                    text=cell,
                )
                for cell_index, cell in enumerate(row)
            ]
            for row_index, row in enumerate(rows)
        ],
    )

    position = str(args.get("position") or "end").lower()
    if position in {"end", "append", "at_end"}:
        blocks.append(table)
        return
    if position in {"start", "prepend", "at_start"}:
        blocks.insert(0, table)
        return

    target_index = resolve_docx_block_index(blocks, args, require_paragraph=False)
    insert_index = target_index if position == "before" else target_index + 1
    blocks.insert(insert_index, table)


def make_docx_paragraph_block(blocks: list[DocxBlock], args: dict[str, Any]) -> DocxParagraphBlock:
    return DocxParagraphBlock(
        id=next_docx_block_id(blocks, "p"),
        text=str(required_arg(args, "text")),
        style=str(args["style"]) if args.get("style") else None,
        alignment=normalize_docx_alignment(args.get("alignment")),
    )


def resolve_docx_block_index(
    blocks: list[DocxBlock],
    args: dict[str, Any],
    *,
    require_paragraph: bool,
) -> int:
    block_index_arg = args.get("block_index")
    if block_index_arg is not None:
        try:
            block_index = int(block_index_arg) - 1
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail="block_index must be a 1-based integer") from exc
        if block_index < 0 or block_index >= len(blocks):
            raise HTTPException(status_code=400, detail="block_index is out of range")
        return block_index

    target_text = str(args.get("target_text") or "").strip()
    if target_text:
        case_sensitive = parse_bool(args.get("case_sensitive"), default=True)
        for index, block in enumerate(blocks):
            if require_paragraph and not isinstance(block, DocxParagraphBlock):
                continue
            if text_contains(get_docx_block_text(block), target_text, case_sensitive):
                return index
        raise HTTPException(status_code=400, detail=f"Target text not found: {target_text}")

    if not blocks:
        raise HTTPException(status_code=400, detail="Document has no targetable blocks")
    raise HTTPException(status_code=400, detail="block_index or target_text is required")


def replace_in_text(
    text: str,
    target_text: str,
    replacement: str,
    case_sensitive: bool,
    remaining: int | None,
) -> tuple[str, bool, int | None]:
    if remaining == 0:
        return text, False, remaining

    if case_sensitive:
        count = -1 if remaining is None else remaining
        next_text = text.replace(target_text, replacement, count)
        replacements = text.count(target_text) if remaining is None else min(text.count(target_text), remaining)
        next_remaining = None if remaining is None else remaining - replacements
        return next_text, next_text != text, next_remaining

    lowered = text.lower()
    lowered_target = target_text.lower()
    parts: list[str] = []
    start = 0
    replacements = 0
    while True:
        if remaining is not None and replacements >= remaining:
            break
        index = lowered.find(lowered_target, start)
        if index < 0:
            break
        parts.append(text[start:index])
        parts.append(replacement)
        start = index + len(target_text)
        replacements += 1

    if replacements == 0:
        return text, False, remaining

    parts.append(text[start:])
    next_remaining = None if remaining is None else remaining - replacements
    return "".join(parts), True, next_remaining


def parse_occurrence(args: dict[str, Any]) -> int | None:
    occurrence = args.get("occurrence", "all")
    if occurrence is None or str(occurrence).lower() == "all":
        return None
    try:
        value = int(occurrence)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="occurrence must be a positive integer or 'all'") from exc
    if value < 1:
        raise HTTPException(status_code=400, detail="occurrence must be a positive integer or 'all'")
    return value


def parse_bool(value: Any, *, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes", "y"}:
            return True
        if normalized in {"false", "0", "no", "n"}:
            return False
    return bool(value)


def normalize_table_rows(rows: Any) -> list[list[str]]:
    if not isinstance(rows, list) or not rows:
        raise HTTPException(status_code=400, detail="rows must be a non-empty two-dimensional array")

    normalized_rows: list[list[str]] = []
    for row in rows:
        if not isinstance(row, list):
            raise HTTPException(status_code=400, detail="rows must be a two-dimensional array")
        normalized_rows.append(["" if cell is None else str(cell) for cell in row])

    max_columns = max((len(row) for row in normalized_rows), default=0)
    if max_columns == 0:
        raise HTTPException(status_code=400, detail="rows must include at least one cell")

    return [row + [""] * (max_columns - len(row)) for row in normalized_rows]


def normalize_docx_alignment(value: Any) -> str | None:
    if value is None:
        return None
    normalized = str(value).lower().replace("_", "-").strip()
    if normalized in {"left", "center", "right", "justify"}:
        return normalized
    return None


def text_contains(text: str, target_text: str, case_sensitive: bool) -> bool:
    if case_sensitive:
        return target_text in text
    return target_text.lower() in text.lower()


def next_docx_block_id(blocks: list[DocxBlock], prefix: str) -> str:
    existing_ids = {block.id for block in blocks}
    index = len(blocks)
    while f"{prefix}-{index}" in existing_ids:
        index += 1
    return f"{prefix}-{index}"


def required_arg(args: dict[str, Any], name: str) -> Any:
    value = args.get(name)
    if value is None or (isinstance(value, str) and not value.strip()):
        raise HTTPException(status_code=400, detail=f"{name} is required")
    return value


def docx_response(
    request: DocxExecuteRequest,
    blocks: list[DocxBlock],
    paragraphs_affected: int,
    tables_affected: int,
    summary: str,
) -> DocxExecuteResponse:
    content = build_docx_bytes(blocks)
    return DocxExecuteResponse(
        command=request.command,
        category=docx_command_category(request.command),
        filename=Path(request.filename or "document.docx").name,
        document_base64=b64encode(content).decode("ascii"),
        blocks=blocks,
        paragraphs_affected=paragraphs_affected,
        tables_affected=tables_affected,
        summary=summary,
    )


def docx_command_category(command: DocxCommandName) -> DocxCommandCategory:
    return "advanced" if command == "insert_table" else "basic"

