from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class DocxParagraphBlock(BaseModel):
    id: str
    type: Literal["paragraph"] = "paragraph"
    text: str
    style: str | None = None
    style_id: str | None = None
    alignment: str | None = None


class DocxTableCell(BaseModel):
    id: str
    text: str
    alignment: str | None = None


class DocxTableBlock(BaseModel):
    id: str
    type: Literal["table"] = "table"
    rows: list[list[DocxTableCell]]


class DocxImageBlock(BaseModel):
    id: str
    type: Literal["image"] = "image"
    filename: str = "image"
    content_type: str = "application/octet-stream"
    data_url: str
    alt_text: str | None = None
    width_emu: int | None = None
    height_emu: int | None = None
    alignment: str | None = None


DocxBlock = DocxParagraphBlock | DocxTableBlock | DocxImageBlock


class DocxParseResponse(BaseModel):
    filename: str
    blocks: list[DocxBlock]
    text_preview: str
    warnings: list[str]


class DocxRenderRequest(BaseModel):
    filename: str = "document.docx"
    blocks: list[DocxBlock]


BasicDocxCommand = Literal["replace_text", "delete_text", "replace_paragraph", "insert_paragraph", "append_paragraph"]
AdvancedDocxCommand = Literal["insert_table"]
DocxCommandName = BasicDocxCommand | AdvancedDocxCommand
DocxCommandCategory = Literal["basic", "advanced"]


class DocxCommandSpec(BaseModel):
    command: DocxCommandName
    category: DocxCommandCategory
    description: str
    required_args: list[str] = Field(default_factory=list)
    optional_args: list[str] = Field(default_factory=list)


class DocxCommandsResponse(BaseModel):
    basic: list[DocxCommandSpec]
    advanced: list[DocxCommandSpec]


class DocxExecuteRequest(BaseModel):
    command: DocxCommandName
    filename: str = "document.docx"
    blocks: list[DocxBlock]
    args: dict[str, Any] = Field(default_factory=dict)


class DocxExecuteResponse(BaseModel):
    command: DocxCommandName
    category: DocxCommandCategory
    filename: str
    document_base64: str
    blocks: list[DocxBlock]
    paragraphs_affected: int = 0
    tables_affected: int = 0
    summary: str

