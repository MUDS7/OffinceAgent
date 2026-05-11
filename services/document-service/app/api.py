from __future__ import annotations

from hashlib import sha256
from io import BytesIO
from pathlib import Path
from urllib.parse import quote

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from app.docx_commands import execute_docx_command, get_docx_commands
from app.docx_document import build_docx_bytes, extract_docx_blocks, get_docx_block_text, summarize_docx_blocks
from app.docx_models import (
    DocxCommandsResponse,
    DocxExecuteRequest,
    DocxExecuteResponse,
    DocxParseResponse,
    DocxRenderRequest,
)
from app.excel_commands import execute_excel_command, get_excel_commands
from app.excel_models import (
    ExcelCommandsResponse,
    ExcelExecuteRequest,
    ExcelExecuteResponse,
)
from app.schemas import AnalyzeResponse, HealthResponse
from app.text_extractors import extract_text


app = FastAPI(title="OfficeAgent Document Service", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    allow_private_network=True,
)


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
    try:
        content = build_docx_bytes(request.blocks)
    except Exception as exc:  # pragma: no cover - external document writer boundary
        raise HTTPException(
            status_code=500,
            detail=(
                f"DOCX 生成失败（文件：{Path(request.filename or 'document.docx').name}；"
                f"{summarize_docx_blocks(request.blocks)}）：{type(exc).__name__}: {exc}"
            ),
        ) from exc

    filename = Path(request.filename or "document.docx").name
    encoded_filename = quote(filename)
    return StreamingResponse(
        BytesIO(content),
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f"attachment; filename*=utf-8''{encoded_filename}"},
    )


@app.get("/docx/commands", response_model=DocxCommandsResponse)
def list_docx_commands() -> DocxCommandsResponse:
    return get_docx_commands()


@app.post("/docx/execute", response_model=DocxExecuteResponse)
def run_docx_command(request: DocxExecuteRequest) -> DocxExecuteResponse:
    return execute_docx_command(request)


@app.get("/excel/commands", response_model=ExcelCommandsResponse)
def list_excel_commands() -> ExcelCommandsResponse:
    return get_excel_commands()


@app.post("/excel/execute", response_model=ExcelExecuteResponse)
def run_excel_command(request: ExcelExecuteRequest) -> ExcelExecuteResponse:
    return execute_excel_command(request)

