from __future__ import annotations

from hashlib import sha256
from io import BytesIO
from pathlib import Path

from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.excel_commands import (
    ExcelCommandsResponse,
    ExcelExecuteRequest,
    ExcelExecuteResponse,
    execute_excel_command,
    get_excel_commands,
)


app = FastAPI(title="OfficeAgent Document Service", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class HealthResponse(BaseModel):
    status: str
    service: str


class AnalyzeResponse(BaseModel):
    filename: str
    extension: str
    size_bytes: int
    sha256: str
    text_preview: str
    warnings: list[str]


class DocxParagraphBlock(BaseModel):
    id: str
    type: str = "paragraph"
    text: str
    style: str | None = None


class DocxTableCell(BaseModel):
    id: str
    text: str


class DocxTableBlock(BaseModel):
    id: str
    type: str = "table"
    rows: list[list[DocxTableCell]]


DocxBlock = DocxParagraphBlock | DocxTableBlock


class DocxParseResponse(BaseModel):
    filename: str
    blocks: list[DocxBlock]
    text_preview: str
    warnings: list[str]


class DocxRenderRequest(BaseModel):
    filename: str = "document.docx"
    blocks: list[DocxBlock]


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok", service="document-service")


@app.post("/documents/analyze", response_model=AnalyzeResponse)
async def analyze_document(file: UploadFile = File(...)) -> AnalyzeResponse:
    content = await file.read()
    filename = file.filename or "untitled"
    extension = Path(filename).suffix.lower()
    warnings: list[str] = []
    text = extract_text(filename, extension, content, warnings)

    return AnalyzeResponse(
        filename=filename,
        extension=extension.lstrip(".") or "unknown",
        size_bytes=len(content),
        sha256=sha256(content).hexdigest(),
        text_preview=text[:4000] if text else "",
        warnings=warnings,
    )


@app.post("/docx/parse", response_model=DocxParseResponse)
async def parse_docx(file: UploadFile = File(...)) -> DocxParseResponse:
    content = await file.read()
    filename = file.filename or "untitled.docx"
    warnings: list[str] = []
    blocks = extract_docx_blocks(content, warnings)
    text_preview = "\n".join(get_docx_block_text(block) for block in blocks).strip()

    return DocxParseResponse(
        filename=filename,
        blocks=blocks,
        text_preview=text_preview[:4000],
        warnings=warnings,
    )


@app.post("/docx/render")
def render_docx(request: DocxRenderRequest) -> StreamingResponse:
    content = build_docx_bytes(request.blocks)
    filename = Path(request.filename or "document.docx").name
    return StreamingResponse(
        BytesIO(content),
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/excel/commands", response_model=ExcelCommandsResponse)
def list_excel_commands() -> ExcelCommandsResponse:
    return get_excel_commands()


@app.post("/excel/execute", response_model=ExcelExecuteResponse)
def run_excel_command(request: ExcelExecuteRequest) -> ExcelExecuteResponse:
    return execute_excel_command(request)


def extract_text(filename: str, extension: str, content: bytes, warnings: list[str]) -> str:
    if extension in {".txt", ".md", ".csv", ".json"}:
        return decode_text(content, warnings)

    if extension == ".pdf":
        return extract_pdf_text(content, warnings)

    if extension == ".docx":
        return extract_docx_text(content, warnings)

    warnings.append(f"{filename} 的类型暂未配置文本抽取器")
    return ""


def decode_text(content: bytes, warnings: list[str]) -> str:
    for encoding in ("utf-8", "utf-8-sig", "gb18030"):
        try:
            return content.decode(encoding)
        except UnicodeDecodeError:
            continue

    warnings.append("无法按常见编码解码文本")
    return ""


def extract_pdf_text(content: bytes, warnings: list[str]) -> str:
    try:
        from pypdf import PdfReader

        reader = PdfReader(BytesIO(content))
        pages = [page.extract_text() or "" for page in reader.pages[:10]]
        if len(reader.pages) > 10:
            warnings.append("仅预览 PDF 前 10 页文本")
        return "\n\n".join(pages).strip()
    except Exception as exc:  # pragma: no cover - external parser boundary
        warnings.append(f"PDF 解析失败: {exc}")
        return ""


def extract_docx_text(content: bytes, warnings: list[str]) -> str:
    try:
        blocks = extract_docx_blocks(content, warnings)
        return "\n".join(get_docx_block_text(block) for block in blocks).strip()
    except Exception as exc:  # pragma: no cover - external parser boundary
        warnings.append(f"DOCX 解析失败: {exc}")
        return ""


def extract_docx_blocks(content: bytes, warnings: list[str]) -> list[DocxBlock]:
    try:
        from docx import Document
        from docx.oxml.table import CT_Tbl
        from docx.oxml.text.paragraph import CT_P
        from docx.table import Table
        from docx.text.paragraph import Paragraph

        document = Document(BytesIO(content))
        blocks: list[DocxBlock] = []
        paragraph_index = 0
        table_index = 0
        body = document._body

        for child in document.element.body.iterchildren():
            if isinstance(child, CT_P):
                paragraph = Paragraph(child, body)
                text = paragraph.text
                if not text.strip():
                    paragraph_index += 1
                    continue

                style = paragraph.style.name if paragraph.style else None
                blocks.append(
                    DocxParagraphBlock(
                        id=f"p-{paragraph_index}",
                        text=text,
                        style=style,
                    )
                )
                paragraph_index += 1
                continue

            if isinstance(child, CT_Tbl):
                table = Table(child, body)
                rows: list[list[DocxTableCell]] = []
                for row_index, row in enumerate(table.rows):
                    cells = [
                        DocxTableCell(
                            id=f"t-{table_index}-r-{row_index}-c-{cell_index}",
                            text=cell.text,
                        )
                        for cell_index, cell in enumerate(row.cells)
                    ]
                    rows.append(cells)

                if rows:
                    blocks.append(
                        DocxTableBlock(
                            id=f"t-{table_index}",
                            rows=rows,
                        )
                    )
                table_index += 1

        if not blocks:
            warnings.append("DOCX 中未提取到可显示文本")

        return blocks
    except Exception as exc:  # pragma: no cover - external parser boundary
        warnings.append(f"DOCX 解析失败: {exc}")
        return []


def build_docx_bytes(blocks: list[DocxBlock]) -> bytes:
    from docx import Document

    document = Document()
    has_content = False

    for block in blocks:
        if isinstance(block, DocxParagraphBlock):
            paragraph = document.add_paragraph(block.text)
            if block.style:
                try:
                    paragraph.style = block.style
                except Exception:
                    pass
            has_content = has_content or bool(block.text.strip())
            continue

        if isinstance(block, DocxTableBlock):
            row_count = len(block.rows)
            col_count = max((len(row) for row in block.rows), default=0)
            if row_count == 0 or col_count == 0:
                continue

            table = document.add_table(rows=row_count, cols=col_count)
            try:
                table.style = "Table Grid"
            except Exception:
                pass
            for row_index, row in enumerate(block.rows):
                for col_index, cell in enumerate(row):
                    table.cell(row_index, col_index).text = cell.text
                    has_content = has_content or bool(cell.text.strip())

    if not has_content:
        document.add_paragraph("")

    output = BytesIO()
    document.save(output)
    return output.getvalue()


def get_docx_block_text(block: DocxBlock) -> str:
    if isinstance(block, DocxParagraphBlock):
        return block.text

    return "\n".join("\t".join(cell.text for cell in row) for row in block.rows)
