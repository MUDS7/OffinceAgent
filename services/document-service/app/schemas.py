from __future__ import annotations

from pydantic import BaseModel
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

