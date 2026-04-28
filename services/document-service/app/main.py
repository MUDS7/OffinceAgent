from __future__ import annotations

from hashlib import sha256
from io import BytesIO
from pathlib import Path

from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel


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
        from docx import Document

        document = Document(BytesIO(content))
        paragraphs = [paragraph.text for paragraph in document.paragraphs if paragraph.text.strip()]
        return "\n".join(paragraphs)
    except Exception as exc:  # pragma: no cover - external parser boundary
        warnings.append(f"DOCX 解析失败: {exc}")
        return ""
