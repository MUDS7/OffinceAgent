from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

import pandas as pd
from fastapi import HTTPException
from openpyxl import load_workbook
from openpyxl.utils import column_index_from_string, get_column_letter, range_boundaries
from pydantic import BaseModel, Field


BasicExcelCommand = Literal["set_cell", "set_range", "insert_row", "delete_row"]
AdvancedExcelCommand = Literal["fill_empty_cells", "summarize_by_column", "generate_report"]
ExcelCommandName = BasicExcelCommand | AdvancedExcelCommand
ExcelCommandCategory = Literal["basic", "advanced"]

BASIC_EXCEL_COMMANDS: tuple[BasicExcelCommand, ...] = (
    "set_cell",
    "set_range",
    "insert_row",
    "delete_row",
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
    args: dict[str, Any] = Field(default_factory=dict)


class ExcelExecuteResponse(BaseModel):
    command: ExcelCommandName
    category: ExcelCommandCategory
    file_path: str
    output_path: str
    sheet: str | None = None
    rows_affected: int = 0
    cells_affected: int = 0
    summary: str
    data: list[dict[str, Any]] | None = None


def get_excel_commands() -> ExcelCommandsResponse:
    return ExcelCommandsResponse(
        basic=[
            ExcelCommandSpec(
                command="set_cell",
                category="basic",
                description="Set one worksheet cell to a value.",
                required_args=["cell", "value"],
            ),
            ExcelCommandSpec(
                command="set_range",
                category="basic",
                description="Set a rectangular worksheet range from a two-dimensional values array.",
                required_args=["values"],
                optional_args=["start_cell", "range"],
            ),
            ExcelCommandSpec(
                command="insert_row",
                category="basic",
                description="Insert one or more rows and optionally write values into them.",
                required_args=["index"],
                optional_args=["amount", "values"],
            ),
            ExcelCommandSpec(
                command="delete_row",
                category="basic",
                description="Delete one or more rows from a worksheet.",
                required_args=["index"],
                optional_args=["amount"],
            ),
        ],
        advanced=[
            ExcelCommandSpec(
                command="fill_empty_cells",
                category="advanced",
                description="Fill blank cells in selected columns or the used range.",
                optional_args=["columns", "fill_value", "method"],
            ),
            ExcelCommandSpec(
                command="summarize_by_column",
                category="advanced",
                description="Group rows by one column and aggregate numeric columns.",
                required_args=["group_by"],
                optional_args=["aggregations", "output_sheet"],
            ),
            ExcelCommandSpec(
                command="generate_report",
                category="advanced",
                description="Generate a formatted summary workbook from an Excel sheet.",
                required_args=["group_by"],
                optional_args=["aggregations", "report_title"],
            ),
        ],
    )


def execute_excel_command(request: ExcelExecuteRequest) -> ExcelExecuteResponse:
    source_path = _resolve_source_path(request)
    output_path = _resolve_output_path(source_path, request.output_path)
    _ensure_xlsx(source_path)

    if request.command == "set_cell":
        return _set_cell(request, source_path, output_path)
    if request.command == "set_range":
        return _set_range(request, source_path, output_path)
    if request.command == "insert_row":
        return _insert_row(request, source_path, output_path)
    if request.command == "delete_row":
        return _delete_row(request, source_path, output_path)
    if request.command == "fill_empty_cells":
        return _fill_empty_cells(request, source_path, output_path)
    if request.command == "summarize_by_column":
        return _summarize_by_column(request, source_path, output_path)
    if request.command == "generate_report":
        return _generate_report(request, source_path, output_path)

    raise HTTPException(status_code=400, detail=f"Unsupported Excel command: {request.command}")


def _set_cell(request: ExcelExecuteRequest, source_path: Path, output_path: Path) -> ExcelExecuteResponse:
    cell = str(_required_arg(request.args, "cell")).upper()
    value = request.args.get("value")
    workbook = load_workbook(source_path)
    worksheet = _select_sheet(workbook, request.sheet)
    worksheet[cell] = value
    workbook.save(output_path)

    return _response(
        request,
        source_path,
        output_path,
        worksheet.title,
        cells_affected=1,
        summary=f"Set {worksheet.title}!{cell}.",
    )


def _set_range(request: ExcelExecuteRequest, source_path: Path, output_path: Path) -> ExcelExecuteResponse:
    values = _normalize_matrix(_required_arg(request.args, "values"))
    start_row, start_column = _range_start(request.args)
    workbook = load_workbook(source_path)
    worksheet = _select_sheet(workbook, request.sheet)

    cells_affected = 0
    for row_offset, row_values in enumerate(values):
        for column_offset, value in enumerate(row_values):
            worksheet.cell(row=start_row + row_offset, column=start_column + column_offset, value=value)
            cells_affected += 1

    workbook.save(output_path)
    end_cell = f"{get_column_letter(start_column + max(len(row) for row in values) - 1)}{start_row + len(values) - 1}"

    return _response(
        request,
        source_path,
        output_path,
        worksheet.title,
        cells_affected=cells_affected,
        summary=f"Set range {worksheet.title}!{get_column_letter(start_column)}{start_row}:{end_cell}.",
    )


def _insert_row(request: ExcelExecuteRequest, source_path: Path, output_path: Path) -> ExcelExecuteResponse:
    index = _positive_int(_required_arg(request.args, "index"), "index")
    amount = _positive_int(request.args.get("amount", 1), "amount")
    values = request.args.get("values")
    workbook = load_workbook(source_path)
    worksheet = _select_sheet(workbook, request.sheet)
    worksheet.insert_rows(index, amount)

    cells_affected = 0
    if values is not None:
        matrix = _normalize_matrix(values)
        for row_offset, row_values in enumerate(matrix[:amount]):
            for column_offset, value in enumerate(row_values):
                worksheet.cell(row=index + row_offset, column=1 + column_offset, value=value)
                cells_affected += 1

    workbook.save(output_path)
    return _response(
        request,
        source_path,
        output_path,
        worksheet.title,
        rows_affected=amount,
        cells_affected=cells_affected,
        summary=f"Inserted {amount} row(s) at {worksheet.title}!{index}.",
    )


def _delete_row(request: ExcelExecuteRequest, source_path: Path, output_path: Path) -> ExcelExecuteResponse:
    index = _positive_int(_required_arg(request.args, "index"), "index")
    amount = _positive_int(request.args.get("amount", 1), "amount")
    workbook = load_workbook(source_path)
    worksheet = _select_sheet(workbook, request.sheet)
    worksheet.delete_rows(index, amount)
    workbook.save(output_path)

    return _response(
        request,
        source_path,
        output_path,
        worksheet.title,
        rows_affected=amount,
        summary=f"Deleted {amount} row(s) at {worksheet.title}!{index}.",
    )


def _fill_empty_cells(request: ExcelExecuteRequest, source_path: Path, output_path: Path) -> ExcelExecuteResponse:
    workbook = load_workbook(source_path)
    worksheet = _select_sheet(workbook, request.sheet)
    method = str(request.args.get("method", "value")).lower()
    fill_value = request.args.get("fill_value", "")
    column_indexes = _selected_column_indexes(worksheet, request.args.get("columns"))
    cells_affected = 0

    for column_index in column_indexes:
        previous_value: Any = None
        pending_blank_cells = []
        for row_index in range(1, worksheet.max_row + 1):
            cell = worksheet.cell(row=row_index, column=column_index)
            if cell.value in (None, ""):
                if method == "value":
                    cell.value = fill_value
                    cells_affected += 1
                elif method == "forward":
                    if previous_value not in (None, ""):
                        cell.value = previous_value
                        cells_affected += 1
                elif method == "backward":
                    pending_blank_cells.append(cell)
                else:
                    raise HTTPException(status_code=400, detail="method must be value, forward, or backward")
            else:
                if method == "backward":
                    for blank_cell in pending_blank_cells:
                        blank_cell.value = cell.value
                        cells_affected += 1
                    pending_blank_cells = []
                previous_value = cell.value

    workbook.save(output_path)
    return _response(
        request,
        source_path,
        output_path,
        worksheet.title,
        cells_affected=cells_affected,
        summary=f"Filled {cells_affected} empty cell(s) in {worksheet.title}.",
    )


def _summarize_by_column(request: ExcelExecuteRequest, source_path: Path, output_path: Path) -> ExcelExecuteResponse:
    group_by = str(_required_arg(request.args, "group_by"))
    output_sheet = str(request.args.get("output_sheet", "Summary"))
    dataframe = _read_sheet_dataframe(source_path, request.sheet)
    summary = _build_summary_dataframe(dataframe, group_by, request.args.get("aggregations"))

    writer_kwargs: dict[str, Any] = {"engine": "openpyxl", "mode": "a" if output_path == source_path else "w"}
    if output_path == source_path:
        writer_kwargs["if_sheet_exists"] = "replace"

    with pd.ExcelWriter(output_path, **writer_kwargs) as writer:
        if output_path != source_path:
            dataframe.to_excel(writer, sheet_name=request.sheet or "Data", index=False)
        summary.to_excel(writer, sheet_name=output_sheet, index=False)

    return _response(
        request,
        source_path,
        output_path,
        output_sheet,
        rows_affected=len(summary),
        summary=f"Created summary sheet '{output_sheet}' grouped by '{group_by}'.",
        data=_json_records(summary),
    )


def _generate_report(request: ExcelExecuteRequest, source_path: Path, output_path: Path) -> ExcelExecuteResponse:
    if request.output_path is None:
        output_path = source_path.with_name(f"{source_path.stem}_report.xlsx")

    group_by = str(_required_arg(request.args, "group_by"))
    report_title = str(request.args.get("report_title", "Excel Summary Report"))
    dataframe = _read_sheet_dataframe(source_path, request.sheet)
    summary = _build_summary_dataframe(dataframe, group_by, request.args.get("aggregations"))

    with pd.ExcelWriter(output_path, engine="xlsxwriter") as writer:
        summary.to_excel(writer, sheet_name="Summary", startrow=2, index=False)
        workbook = writer.book
        worksheet = writer.sheets["Summary"]
        title_format = workbook.add_format({"bold": True, "font_size": 16})
        header_format = workbook.add_format({"bold": True, "bg_color": "#D9EAF7", "border": 1})
        number_format = workbook.add_format({"num_format": "#,##0.00"})

        worksheet.write(0, 0, report_title, title_format)
        for column_index, column_name in enumerate(summary.columns):
            worksheet.write(2, column_index, column_name, header_format)
            width = max(12, min(36, len(str(column_name)) + 4))
            worksheet.set_column(column_index, column_index, width, number_format if column_index > 0 else None)
        worksheet.freeze_panes(3, 0)
        worksheet.autofilter(2, 0, 2 + len(summary), max(len(summary.columns) - 1, 0))

    return _response(
        request,
        source_path,
        output_path,
        "Summary",
        rows_affected=len(summary),
        summary=f"Generated report workbook grouped by '{group_by}'.",
        data=_json_records(summary),
    )


def _resolve_source_path(request: ExcelExecuteRequest) -> Path:
    raw_path = request.file_path or request.path
    if not raw_path:
        raise HTTPException(status_code=400, detail="file_path is required")

    path = Path(raw_path).expanduser().resolve()
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Excel file not found: {path}")
    if not path.is_file():
        raise HTTPException(status_code=400, detail=f"Excel path is not a file: {path}")
    return path


def _resolve_output_path(source_path: Path, output_path: str | None) -> Path:
    if not output_path:
        return source_path

    resolved = Path(output_path).expanduser().resolve()
    resolved.parent.mkdir(parents=True, exist_ok=True)
    return resolved


def _ensure_xlsx(path: Path) -> None:
    if path.suffix.lower() != ".xlsx":
        raise HTTPException(status_code=400, detail="Only .xlsx files are supported for Excel commands")


def _select_sheet(workbook: Any, sheet_name: str | None) -> Any:
    if not sheet_name:
        return workbook.active
    if sheet_name not in workbook.sheetnames:
        raise HTTPException(status_code=404, detail=f"Worksheet not found: {sheet_name}")
    return workbook[sheet_name]


def _required_arg(args: dict[str, Any], name: str) -> Any:
    if name not in args or args[name] is None:
        raise HTTPException(status_code=400, detail=f"args.{name} is required")
    return args[name]


def _positive_int(value: Any, name: str) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"args.{name} must be an integer") from None
    if number < 1:
        raise HTTPException(status_code=400, detail=f"args.{name} must be greater than 0")
    return number


def _normalize_matrix(values: Any) -> list[list[Any]]:
    if not isinstance(values, list) or len(values) == 0:
        raise HTTPException(status_code=400, detail="args.values must be a non-empty list")
    if all(not isinstance(item, list) for item in values):
        return [values]
    if not all(isinstance(item, list) for item in values):
        raise HTTPException(status_code=400, detail="args.values must be a one- or two-dimensional list")
    if any(len(row) == 0 for row in values):
        raise HTTPException(status_code=400, detail="args.values rows cannot be empty")
    return values


def _range_start(args: dict[str, Any]) -> tuple[int, int]:
    range_address = args.get("range") or args.get("range_address")
    if range_address:
        min_col, min_row, _, _ = range_boundaries(str(range_address))
        return min_row, min_col

    start_cell = str(args.get("start_cell") or args.get("cell") or "A1")
    min_col, min_row, _, _ = range_boundaries(start_cell)
    return min_row, min_col


def _selected_column_indexes(worksheet: Any, columns: Any) -> list[int]:
    if columns in (None, []):
        return list(range(1, worksheet.max_column + 1))
    if not isinstance(columns, list):
        raise HTTPException(status_code=400, detail="args.columns must be a list")

    header_to_index = {
        str(worksheet.cell(row=1, column=column_index).value): column_index
        for column_index in range(1, worksheet.max_column + 1)
        if worksheet.cell(row=1, column=column_index).value not in (None, "")
    }
    indexes: list[int] = []
    for column in columns:
        if isinstance(column, int):
            indexes.append(_positive_int(column, "columns[]"))
        else:
            label = str(column)
            if label in header_to_index:
                indexes.append(header_to_index[label])
            else:
                try:
                    indexes.append(column_index_from_string(label.upper()))
                except ValueError:
                    raise HTTPException(status_code=400, detail=f"Unknown column: {label}") from None
    return indexes


def _read_sheet_dataframe(source_path: Path, sheet_name: str | None) -> pd.DataFrame:
    try:
        return pd.read_excel(source_path, sheet_name=sheet_name or 0)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None


def _build_summary_dataframe(
    dataframe: pd.DataFrame,
    group_by: str,
    aggregations: Any,
) -> pd.DataFrame:
    if group_by not in dataframe.columns:
        raise HTTPException(status_code=400, detail=f"group_by column not found: {group_by}")

    if aggregations is None:
        numeric_columns = [column for column in dataframe.select_dtypes(include="number").columns if column != group_by]
        if not numeric_columns:
            summary = dataframe.groupby(group_by, dropna=False).size().reset_index(name="count")
        else:
            summary = dataframe.groupby(group_by, dropna=False)[numeric_columns].sum().reset_index()
    else:
        if not isinstance(aggregations, dict):
            raise HTTPException(status_code=400, detail="args.aggregations must be an object")
        summary = dataframe.groupby(group_by, dropna=False).agg(aggregations).reset_index()
        summary.columns = [
            "_".join(str(part) for part in column if part)
            if isinstance(column, tuple)
            else str(column)
            for column in summary.columns
        ]

    return summary


def _json_records(dataframe: pd.DataFrame) -> list[dict[str, Any]]:
    return dataframe.where(pd.notnull(dataframe), None).to_dict(orient="records")


def _command_category(command: ExcelCommandName) -> ExcelCommandCategory:
    return "basic" if command in BASIC_EXCEL_COMMANDS else "advanced"


def _response(
    request: ExcelExecuteRequest,
    source_path: Path,
    output_path: Path,
    sheet: str | None,
    *,
    rows_affected: int = 0,
    cells_affected: int = 0,
    summary: str,
    data: list[dict[str, Any]] | None = None,
) -> ExcelExecuteResponse:
    return ExcelExecuteResponse(
        command=request.command,
        category=_command_category(request.command),
        file_path=str(source_path),
        output_path=str(output_path),
        sheet=sheet,
        rows_affected=rows_affected,
        cells_affected=cells_affected,
        summary=summary,
        data=data,
    )
