from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


BasicExcelCommand = Literal["set_cell", "set_range", "insert_row", "insert_column", "delete_row", "split_column"]
AdvancedExcelCommand = Literal["fill_empty_cells", "summarize_by_column", "generate_report"]
ExcelCommandName = BasicExcelCommand | AdvancedExcelCommand
ExcelCommandCategory = Literal["basic", "advanced"]

BASIC_EXCEL_COMMANDS: tuple[BasicExcelCommand, ...] = (
    "set_cell",
    "set_range",
    "insert_row",
    "insert_column",
    "delete_row",
    "split_column",
)
ADVANCED_EXCEL_COMMANDS: tuple[AdvancedExcelCommand, ...] = (
    "fill_empty_cells",
    "summarize_by_column",
    "generate_report",
)


class ExcelCommandSpec(BaseModel):
    command: ExcelCommandName
    category: ExcelCommandCategory
    description: str
    required_args: list[str] = Field(default_factory=list)
    optional_args: list[str] = Field(default_factory=list)


class ExcelCommandsResponse(BaseModel):
    basic: list[ExcelCommandSpec]
    advanced: list[ExcelCommandSpec]


class ExcelExecuteRequest(BaseModel):
    command: ExcelCommandName
    file_path: str | None = None
    path: str | None = None
    sheet: str | None = None
    output_path: str | None = None
    save_to_disk: bool = False
    args: dict[str, Any] = Field(default_factory=dict)


class ExcelExecuteResponse(BaseModel):
    command: ExcelCommandName
    category: ExcelCommandCategory
    file_path: str
    output_path: str
    workbook_base64: str | None = None
    saved_to_disk: bool = False
    sheet: str | None = None
    rows_affected: int = 0
    cells_affected: int = 0
    summary: str

