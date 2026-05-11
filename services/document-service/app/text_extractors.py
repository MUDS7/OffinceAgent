from __future__ import annotations

from io import BytesIO

from app.docx_document import extract_docx_text
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

