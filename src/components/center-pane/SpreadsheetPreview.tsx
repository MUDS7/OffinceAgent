import { AlertTriangle, RefreshCw, XCircle } from "lucide-react";
import type { CSSProperties } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type * as XLSXModule from "xlsx";
import type { DocumentSelectionContext, PreviewFile } from "./types";

type SpreadsheetPreviewProps = {
  activeFile: PreviewFile;
  onSaveFile: (fileId: string) => void;
  onSelectionContextChange: (context: DocumentSelectionContext | null) => void;
  onUpdateSpreadsheetFile: (fileId: string, file: File) => void;
};

type SpreadsheetCell = {
  address: string;
  col: number;
  row: number;
  value: string;
};

type SheetPreview = {
  columnIndexes: number[];
  columns: string[];
  isColumnLimited: boolean;
  isRowLimited: boolean;
  name: string;
  rangeLabel: string;
  rows: SpreadsheetCell[][];
  rowStart: number;
};

type SelectionRange = {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
};

type SizeMapBySheet = Record<string, Record<number, number>>;

const MAX_VISIBLE_ROWS = 800;
const MAX_VISIBLE_COLUMNS = 120;
const DEFAULT_COLUMN_WIDTH = 132;
const DEFAULT_ROW_HEIGHT = 28;
const MIN_COLUMN_WIDTH = 48;
const MAX_COLUMN_WIDTH = 520;
const MIN_ROW_HEIGHT = 22;
const MAX_ROW_HEIGHT = 180;
const UI_SCALE_FALLBACK = 0.8;

export function SpreadsheetPreview({
  activeFile,
  onSaveFile,
  onSelectionContextChange,
  onUpdateSpreadsheetFile,
}: SpreadsheetPreviewProps) {
  const lastPublishedFileRef = useRef<File | null>(null);
  const loadedFileIdRef = useRef("");
  const [previewState, setPreviewState] = useState<{
    error: string;
    isLoading: boolean;
    sheets: SheetPreview[];
    workbook: XLSXModule.WorkBook | null;
    xlsx: typeof XLSXModule | null;
  }>({
    error: "",
    isLoading: true,
    sheets: [],
    workbook: null,
    xlsx: null,
  });
  const [activeSheetIndex, setActiveSheetIndex] = useState(0);
  const [columnWidthsBySheet, setColumnWidthsBySheet] = useState<SizeMapBySheet>({});
  const [rowHeightsBySheet, setRowHeightsBySheet] = useState<SizeMapBySheet>({});
  const [selectionRange, setSelectionRange] = useState<SelectionRange | null>(null);
  const [dragAnchor, setDragAnchor] = useState<{ row: number; col: number } | null>(null);
  const [editingCell, setEditingCell] = useState<string | null>(null);
  const activeSheet = previewState.sheets[activeSheetIndex] ?? null;
  const activeSheetKey = activeSheet?.name ?? "";
  const activeColumnWidths = activeSheet ? columnWidthsBySheet[activeSheetKey] ?? {} : {};
  const activeRowHeights = activeSheet ? rowHeightsBySheet[activeSheetKey] ?? {} : {};
  const spreadsheetGridStyle = activeSheet
    ? ({
        width: getTableWidth(activeSheet),
      } satisfies CSSProperties)
    : undefined;

  useEffect(() => {
    if (loadedFileIdRef.current === activeFile.id && lastPublishedFileRef.current === activeFile.file) {
      return;
    }

    let isCancelled = false;
    loadedFileIdRef.current = activeFile.id;

    setPreviewState({ error: "", isLoading: true, sheets: [], workbook: null, xlsx: null });
    setActiveSheetIndex(0);
    setColumnWidthsBySheet({});
    setRowHeightsBySheet({});
    setSelectionRange(null);
    onSelectionContextChange(null);
    setEditingCell(null);

    async function loadWorkbook() {
      try {
        const XLSX = await import("xlsx");
        const workbook = XLSX.read(await activeFile.file.arrayBuffer(), {
          cellDates: true,
          type: "array",
        });
        const sheets = workbook.SheetNames.map((sheetName) =>
          buildSheetPreview(sheetName, workbook.Sheets[sheetName], XLSX),
        );

        if (isCancelled) return;

        setPreviewState({
          error: sheets.length ? "" : "Workbook does not contain visible sheets.",
          isLoading: false,
          sheets,
          workbook,
          xlsx: XLSX,
        });
      } catch (error) {
        if (isCancelled) return;

        setPreviewState({
          error: error instanceof Error ? error.message : String(error),
          isLoading: false,
          sheets: [],
          workbook: null,
          xlsx: null,
        });
      }
    }

    void loadWorkbook();

    return () => {
      isCancelled = true;
    };
  }, [activeFile.id, activeFile.file, onSelectionContextChange]);

  useEffect(() => {
    setSelectionRange(null);
    onSelectionContextChange(null);
    setEditingCell(null);
  }, [activeSheetIndex, onSelectionContextChange]);

  useEffect(() => {
    if (!selectionRange || !activeSheet) return;

    onSelectionContextChange({
      fileId: activeFile.id,
      filePath: activeFile.diskPath ?? activeFile.filename,
      filename: activeFile.filename,
      sourceType: "spreadsheet",
      text: getSelectionContextText(activeSheet, selectionRange),
    });
  }, [activeFile.diskPath, activeFile.filename, activeFile.id, activeSheet, onSelectionContextChange, selectionRange]);

  useEffect(() => {
    function stopDrag() {
      setDragAnchor(null);
    }

    window.addEventListener("pointerup", stopDrag);
    window.addEventListener("pointercancel", stopDrag);

    return () => {
      window.removeEventListener("pointerup", stopDrag);
      window.removeEventListener("pointercancel", stopDrag);
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        onSaveFile(activeFile.id);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [activeFile.id, onSaveFile]);

  const normalizedSelection = useMemo(
    () => (selectionRange ? normalizeSelectionRange(selectionRange) : null),
    [selectionRange],
  );

  if (previewState.isLoading) {
    return (
      <div className="editor-content preview-empty">
        <RefreshCw className="spin" size={26} />
        <span>Opening spreadsheet...</span>
      </div>
    );
  }

  if (previewState.error) {
    return (
      <div className="editor-content preview-empty">
        <XCircle size={28} />
        <span>{previewState.error}</span>
      </div>
    );
  }

  return (
    <div className="editor-content spreadsheet-preview">
      <div className="spreadsheet-toolbar" aria-label="Workbook sheets">
        <div className="spreadsheet-sheet-tabs" role="tablist" aria-label="Sheets">
          {previewState.sheets.map((sheet, index) => (
            <button
              className={index === activeSheetIndex ? "spreadsheet-sheet-tab active" : "spreadsheet-sheet-tab"}
              type="button"
              role="tab"
              aria-selected={index === activeSheetIndex}
              key={`${sheet.name}-${index}`}
              onClick={() => setActiveSheetIndex(index)}
            >
              {sheet.name}
            </button>
          ))}
        </div>
        {activeSheet ? (
          <div className="spreadsheet-range-summary">
            {normalizedSelection ? getRangeLabel(activeSheet, normalizedSelection) : activeSheet.rangeLabel}
          </div>
        ) : null}
      </div>

      {activeSheet?.isRowLimited || activeSheet?.isColumnLimited ? (
        <div className="spreadsheet-limit-note">
          <AlertTriangle size={15} />
          <span>
            Preview limited to {MAX_VISIBLE_ROWS} rows and {MAX_VISIBLE_COLUMNS} columns.
          </span>
        </div>
      ) : null}

      <div
        className="spreadsheet-grid-shell"
        onPointerDown={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest(".spreadsheet-cell, .spreadsheet-column-header, .spreadsheet-row-header")
          ) {
            return;
          }
          setSelectionRange(null);
          onSelectionContextChange(null);
          setEditingCell(null);
        }}
      >
        <table className="spreadsheet-grid" style={spreadsheetGridStyle}>
          <colgroup>
            <col className="spreadsheet-row-header-col" />
            {activeSheet?.columnIndexes.map((col) => (
              <col key={col} style={getColumnStyle(col)} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="spreadsheet-corner" scope="col" />
              {activeSheet?.columns.map((column, index) => (
                <th
                  className="spreadsheet-column-header"
                  scope="col"
                  key={column}
                  style={getColumnStyle(activeSheet.columnIndexes[index])}
                  onPointerDown={(event) => handleColumnHeaderPointerDown(index, event)}
                >
                  {column}
                  <span
                    className="spreadsheet-column-resizer"
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`Resize column ${column}`}
                    onPointerDown={(event) => startColumnResize(activeSheet.columnIndexes[index], event)}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {activeSheet?.rows.map((row, rowIndex) => (
              <tr key={activeSheet.rowStart + rowIndex}>
                <th
                  className="spreadsheet-row-header"
                  scope="row"
                  style={{ height: getRowHeight(activeSheet.rowStart + rowIndex) }}
                  onPointerDown={(event) => handleRowHeaderPointerDown(rowIndex, event)}
                >
                  {activeSheet.rowStart + rowIndex + 1}
                  <span
                    className="spreadsheet-row-resizer"
                    role="separator"
                    aria-orientation="horizontal"
                    aria-label={`Resize row ${activeSheet.rowStart + rowIndex + 1}`}
                    onPointerDown={(event) => startRowResize(activeSheet.rowStart + rowIndex, event)}
                  />
                </th>
                {row.map((cell) => (
                  <td
                    className={
                      normalizedSelection && isCellInSelection(cell, normalizedSelection)
                        ? "spreadsheet-cell selected"
                        : "spreadsheet-cell"
                    }
                    data-address={cell.address}
                    key={cell.address}
                    style={{
                      height: getRowHeight(cell.row),
                      ...getColumnStyle(cell.col),
                    }}
                    title={cell.value}
                    onPointerDown={(event) => {
                      if (event.target instanceof Element && event.target.closest(".spreadsheet-cell-input")) return;
                      event.preventDefault();
                      
                      const isAlreadySelected =
                        normalizedSelection &&
                        normalizedSelection.startRow === cell.row &&
                        normalizedSelection.startCol === cell.col &&
                        normalizedSelection.endRow === cell.row &&
                        normalizedSelection.endCol === cell.col;

                      if (isAlreadySelected) {
                        setEditingCell(cell.address);
                      } else {
                        setEditingCell(null);
                        const nextRange = {
                          startRow: cell.row,
                          startCol: cell.col,
                          endRow: cell.row,
                          endCol: cell.col,
                        };
                        setDragAnchor({ row: cell.row, col: cell.col });
                        setSelectionRange(nextRange);
                      }
                    }}
                    onPointerEnter={() => {
                      if (!dragAnchor) return;

                      setEditingCell(null);
                      setSelectionRange({
                        startRow: dragAnchor.row,
                        startCol: dragAnchor.col,
                        endRow: cell.row,
                        endCol: cell.col,
                      });
                    }}
                  >
                    <input
                      className="spreadsheet-cell-input"
                      aria-label={`${cell.address} cell value`}
                      spellCheck={false}
                      value={cell.value}
                      readOnly={editingCell !== cell.address}
                      tabIndex={-1}
                      style={{ pointerEvents: editingCell === cell.address ? "auto" : "none" }}
                      onChange={(event) => updateCellValue(cell, event.target.value)}
                      onBlur={() => {
                        if (editingCell === cell.address) {
                          setEditingCell(null);
                        }
                      }}
                      onPointerDown={(event) => event.stopPropagation()}
                      ref={(el) => {
                        if (editingCell === cell.address && el && document.activeElement !== el) {
                          el.focus();
                        }
                      }}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  function updateCellValue(cell: SpreadsheetCell, value: string) {
    if (!activeSheet || !previewState.workbook || !previewState.xlsx) return;

    const worksheet = previewState.workbook.Sheets[activeSheet.name];
    if (!worksheet) return;

    setWorksheetCellValue(worksheet, cell.address, value, previewState.xlsx);

    const nextSheets = previewState.sheets.map((sheet) => {
      if (sheet.name !== activeSheet.name) return sheet;

      return {
        ...sheet,
        rows: sheet.rows.map((row) =>
          row.map((item) => (item.address === cell.address ? { ...item, value } : item)),
        ),
      };
    });

    setPreviewState((current) => ({
      ...current,
      sheets: nextSheets,
    }));
    publishWorkbookFile(previewState.workbook, previewState.xlsx);
  }

  function publishWorkbookFile(workbook: XLSXModule.WorkBook, xlsx: typeof XLSXModule) {
    const bookType: XLSXModule.BookType = activeFile.filename.toLowerCase().endsWith(".xls") ? "xls" : "xlsx";
    const workbookBytes = xlsx.write(workbook, { bookType, type: "array" }) as ArrayBuffer;
    const nextFile = new File([workbookBytes], activeFile.filename, {
      type: activeFile.file.type,
      lastModified: Date.now(),
    });

    lastPublishedFileRef.current = nextFile;
    onUpdateSpreadsheetFile(activeFile.id, nextFile);
  }

  function getColumnWidth(col: number) {
    return activeColumnWidths[col] ?? DEFAULT_COLUMN_WIDTH;
  }

  function getColumnStyle(col: number): CSSProperties {
    const width = getColumnWidth(col);

    return {
      maxWidth: width,
      minWidth: width,
      width,
    };
  }

  function getTableWidth(sheet: SheetPreview) {
    return 54 + sheet.columnIndexes.reduce((total, col) => total + getColumnWidth(col), 0);
  }

  function getRowHeight(row: number) {
    return activeRowHeights[row] ?? DEFAULT_ROW_HEIGHT;
  }

  function startColumnResize(col: number, event: ReactPointerEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();

    if (!activeSheet) return;

    setDragAnchor(null);
    const startX = event.clientX;
    const startWidth = getColumnWidth(col);
    const sheetKey = activeSheet.name;

    startResize("col-resize", (moveEvent) => {
      const delta = (moveEvent.clientX - startX) / getUiScale();
      const nextWidth = clampSize(startWidth + delta, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH);

      setColumnWidthsBySheet((current) => ({
        ...current,
        [sheetKey]: {
          ...(current[sheetKey] ?? {}),
          [col]: nextWidth,
        },
      }));
    });
  }

  function handleColumnHeaderPointerDown(index: number, event: ReactPointerEvent<HTMLTableCellElement>) {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest(".spreadsheet-column-resizer")) return;

    const bounds = event.currentTarget.getBoundingClientRect();
    const edgeThreshold = 8;
    const isNearRightEdge = event.clientX >= bounds.right - edgeThreshold;
    const isNearLeftEdge = event.clientX <= bounds.left + edgeThreshold;

    if (isNearRightEdge) {
      startColumnResize(activeSheet.columnIndexes[index], event);
      return;
    }

    if (isNearLeftEdge && index > 0) {
      startColumnResize(activeSheet.columnIndexes[index - 1], event);
      return;
    }

    if (activeSheet) {
      const col = activeSheet.columnIndexes[index];
      setEditingCell(null);
      setDragAnchor(null);
      setSelectionRange({
        startRow: activeSheet.rowStart,
        startCol: col,
        endRow: activeSheet.rowStart + activeSheet.rows.length - 1,
        endCol: col,
      });
    }
  }

  function handleRowHeaderPointerDown(rowIndex: number, event: ReactPointerEvent<HTMLTableCellElement>) {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest(".spreadsheet-row-resizer")) return;

    if (!activeSheet) return;

    const bounds = event.currentTarget.getBoundingClientRect();
    const edgeThreshold = 8;
    const isNearBottomEdge = event.clientY >= bounds.bottom - edgeThreshold;
    const isNearTopEdge = event.clientY <= bounds.top + edgeThreshold;

    const actualRow = activeSheet.rowStart + rowIndex;

    if (isNearBottomEdge) {
      startRowResize(actualRow, event);
      return;
    }

    if (isNearTopEdge && rowIndex > 0) {
      startRowResize(actualRow - 1, event);
      return;
    }

    setEditingCell(null);
    setDragAnchor(null);
    const startCol = activeSheet.columnIndexes[0];
    const endCol = activeSheet.columnIndexes[activeSheet.columnIndexes.length - 1];

    setSelectionRange({
      startRow: actualRow,
      startCol: startCol,
      endRow: actualRow,
      endCol: endCol,
    });
  }

  function startRowResize(row: number, event: ReactPointerEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();

    if (!activeSheet) return;

    setDragAnchor(null);
    const startY = event.clientY;
    const startHeight = getRowHeight(row);
    const sheetKey = activeSheet.name;

    startResize("row-resize", (moveEvent) => {
      const delta = (moveEvent.clientY - startY) / getUiScale();
      const nextHeight = clampSize(startHeight + delta, MIN_ROW_HEIGHT, MAX_ROW_HEIGHT);

      setRowHeightsBySheet((current) => ({
        ...current,
        [sheetKey]: {
          ...(current[sheetKey] ?? {}),
          [row]: nextHeight,
        },
      }));
    });
  }
}

function buildSheetPreview(
  name: string,
  sheet: XLSXModule.WorkSheet | undefined,
  xlsx: typeof XLSXModule,
): SheetPreview {
  const fallbackRange = xlsx.utils.decode_range("A1:A1");
  const sheetRef = sheet?.["!ref"];
  const usedRange = sheetRef ? xlsx.utils.decode_range(sheetRef) : fallbackRange;
  const rowCount = usedRange.e.r - usedRange.s.r + 1;
  const columnCount = usedRange.e.c - usedRange.s.c + 1;
  const visibleRowCount = Math.min(rowCount, MAX_VISIBLE_ROWS);
  const visibleColumnCount = Math.min(columnCount, MAX_VISIBLE_COLUMNS);
  const columnIndexes = Array.from({ length: visibleColumnCount }, (_, index) => usedRange.s.c + index);
  const columns = Array.from({ length: visibleColumnCount }, (_, index) =>
    encodeColumnLabel(usedRange.s.c + index),
  );
  const rows = Array.from({ length: visibleRowCount }, (_, rowIndex) => {
    const row = usedRange.s.r + rowIndex;

    return Array.from({ length: visibleColumnCount }, (_, colIndex) => {
      const col = usedRange.s.c + colIndex;
      const address = encodeCellAddress(row, col);
      const cell = sheet?.[address] as XLSXModule.CellObject | undefined;

      return {
        address,
        col,
        row,
        value: cell ? xlsx.utils.format_cell(cell) : "",
      };
    });
  });

  return {
    columnIndexes,
    columns,
    isColumnLimited: columnCount > visibleColumnCount,
    isRowLimited: rowCount > visibleRowCount,
    name,
    rangeLabel: `${encodeCellAddress(usedRange.s.r, usedRange.s.c)}:${encodeCellAddress(usedRange.e.r, usedRange.e.c)}`,
    rows,
    rowStart: usedRange.s.r,
  };
}

function setWorksheetCellValue(
  sheet: XLSXModule.WorkSheet,
  address: string,
  value: string,
  xlsx: typeof XLSXModule,
) {
  const nextCell = createCellObject(value);

  if (nextCell) {
    sheet[address] = nextCell;
  } else {
    delete sheet[address];
  }

  const point = xlsx.utils.decode_cell(address);
  const currentRange = sheet["!ref"]
    ? xlsx.utils.decode_range(sheet["!ref"])
    : { s: { r: point.r, c: point.c }, e: { r: point.r, c: point.c } };

  sheet["!ref"] = xlsx.utils.encode_range({
    s: {
      r: Math.min(currentRange.s.r, point.r),
      c: Math.min(currentRange.s.c, point.c),
    },
    e: {
      r: Math.max(currentRange.e.r, point.r),
      c: Math.max(currentRange.e.c, point.c),
    },
  });
}

function createCellObject(value: string): XLSXModule.CellObject | null {
  if (!value.trim()) return null;

  const trimmedValue = value.trim();
  if (/^(true|false)$/i.test(trimmedValue)) {
    return { t: "b", v: /^true$/i.test(trimmedValue) };
  }

  if (/^[+-]?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?$/i.test(trimmedValue)) {
    const numericValue = Number(trimmedValue);
    if (Number.isFinite(numericValue)) {
      return { t: "n", v: numericValue };
    }
  }

  return { t: "s", v: value };
}

function startResize(cursorClass: "col-resize" | "row-resize", onMove: (event: PointerEvent) => void) {
  document.body.classList.add("is-resizing-spreadsheet", cursorClass);

  function handlePointerMove(event: PointerEvent) {
    onMove(event);
  }

  function stopResize() {
    document.body.classList.remove("is-resizing-spreadsheet", cursorClass);
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", stopResize);
    window.removeEventListener("pointercancel", stopResize);
  }

  window.addEventListener("pointermove", handlePointerMove);
  window.addEventListener("pointerup", stopResize);
  window.addEventListener("pointercancel", stopResize);
}

function clampSize(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;

  return Math.min(Math.max(Math.round(value), min), max);
}

function getUiScale() {
  const rawScale = getComputedStyle(document.documentElement).getPropertyValue("--ui-scale");
  const scale = Number.parseFloat(rawScale);

  return Number.isFinite(scale) && scale > 0 ? scale : UI_SCALE_FALLBACK;
}

function normalizeSelectionRange(range: SelectionRange): SelectionRange {
  return {
    startRow: Math.min(range.startRow, range.endRow),
    startCol: Math.min(range.startCol, range.endCol),
    endRow: Math.max(range.startRow, range.endRow),
    endCol: Math.max(range.startCol, range.endCol),
  };
}

function isCellInSelection(cell: SpreadsheetCell, range: SelectionRange) {
  return cell.row >= range.startRow && cell.row <= range.endRow && cell.col >= range.startCol && cell.col <= range.endCol;
}

function getSelectionContextText(sheet: SheetPreview, range: SelectionRange) {
  const normalizedRange = normalizeSelectionRange(range);
  const selectedRows = sheet.rows
    .map((row) =>
      row
        .filter((cell) => isCellInSelection(cell, normalizedRange))
        .map((cell) => cell.value)
        .join("\t"),
    )
    .filter((rowText, index) => {
      const absoluteRow = sheet.rowStart + index;
      return absoluteRow >= normalizedRange.startRow && absoluteRow <= normalizedRange.endRow && rowText.trim().length > 0;
    });

  return [
    `Sheet: ${sheet.name}`,
    `Range: ${getRangeLabel(sheet, normalizedRange)}`,
    "",
    selectedRows.join("\n"),
  ]
    .join("\n")
    .trim();
}

function getRangeLabel(sheet: SheetPreview, range: SelectionRange) {
  const start = encodeCellAddress(range.startRow, range.startCol);
  const end = encodeCellAddress(range.endRow, range.endCol);
  const address = start === end ? start : `${start}:${end}`;

  return `${sheet.name}!${address}`;
}

function encodeCellAddress(row: number, col: number) {
  return `${encodeColumnLabel(col)}${row + 1}`;
}

function encodeColumnLabel(col: number) {
  let label = "";
  let index = col + 1;

  while (index > 0) {
    const remainder = (index - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    index = Math.floor((index - 1) / 26);
  }

  return label;
}
