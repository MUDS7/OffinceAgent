import { AlertTriangle, Check, RefreshCw, XCircle } from "lucide-react";
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
  const [contextMenu, setContextMenu] = useState<{ type: "col" | "row"; x: number; y: number; index: number } | null>(null);
  const [insertLeftAmount, setInsertLeftAmount] = useState(1);
  const [insertRightAmount, setInsertRightAmount] = useState(1);
  const [insertTopAmount, setInsertTopAmount] = useState(1);
  const [insertBottomAmount, setInsertBottomAmount] = useState(1);
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
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setContextMenu({
                      type: "col",
                      x: event.clientX / getUiScale(),
                      y: event.clientY / getUiScale(),
                      index: activeSheet.columnIndexes[index],
                    });
                  }}
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
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setContextMenu({
                      type: "row",
                      x: event.clientX / getUiScale(),
                      y: event.clientY / getUiScale(),
                      index: activeSheet.rowStart + rowIndex,
                    });
                  }}
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
      {contextMenu && (
        <>
          <div
            className="spreadsheet-context-menu-backdrop"
            style={{ position: "fixed", inset: 0, zIndex: 999 }}
            onPointerDown={() => setContextMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setContextMenu(null);
            }}
          />
          <div
            className="spreadsheet-context-menu"
            style={{
              position: "fixed",
              left: contextMenu.x + 10,
              top: contextMenu.y + 10,
              zIndex: 1000,
              backgroundColor: "var(--bg-surface, #ffffff)",
              border: "1px solid var(--border-color, #e5e7eb)",
              borderRadius: "8px",
              padding: "6px",
              boxShadow: "0 4px 16px rgba(0,0,0,0.1)",
              display: "flex",
              flexDirection: "column",
              gap: "4px",
              fontSize: "13px",
              color: "var(--text-primary, #374151)",
            }}
          >
            {contextMenu.type === "col" ? (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: "12px", padding: "6px 8px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", width: "120px" }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M14 4H18C18.5523 4 19 4.44772 19 5V19C19 19.5523 18.5523 20 18 20H14C13.4477 20 13 19.5523 13 19V5C13 4.44772 13.4477 4 14 4Z" stroke="currentColor" strokeWidth="1.5"/>
                      <path d="M16 4V20" stroke="currentColor" strokeWidth="1.5"/>
                      <path d="M6 4H10C10.5523 4 11 4.44772 11 5V9C11 9.5523 10.5523 10 10 10H6C5.4477 10 5 9.5523 5 9V5C5 4.44772 5.4477 4 6 4Z" stroke="currentColor" strokeWidth="1.5"/>
                      <path d="M8 12V20M8 20L5 17M8 20L11 17" stroke="#10b981" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    <span style={{ userSelect: "none" }}>在左侧插入列(I)</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={insertLeftAmount}
                      onChange={(e) => setInsertLeftAmount(Math.max(1, parseInt(e.target.value) || 1))}
                      style={{ width: "48px", height: "24px", borderRadius: "4px", border: "1px solid #d1d5db", textAlign: "center", outline: "none", color: "inherit", backgroundColor: "transparent" }}
                      onPointerDown={(e) => e.stopPropagation()}
                    />
                    <button
                      onClick={() => {
                        handleInsertColumns(contextMenu.index, insertLeftAmount, "left");
                        setContextMenu(null);
                      }}
                      style={{ background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", color: "#6b7280", padding: 0 }}
                    >
                      <Check size={18} strokeWidth={1.5} />
                    </button>
                  </div>
                </div>
                
                <div style={{ display: "flex", alignItems: "center", gap: "12px", padding: "6px 8px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", width: "120px" }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M6 4H10C10.5523 4 11 4.44772 11 5V19C11 19.5523 10.5523 20 10 20H6C5.4477 20 5 19.5523 5 19V5C5 4.44772 5.4477 4 6 4Z" stroke="currentColor" strokeWidth="1.5"/>
                      <path d="M8 4V20" stroke="currentColor" strokeWidth="1.5"/>
                      <path d="M14 4H18C18.5523 4 19 4.44772 19 5V9C19 9.5523 18.5523 10 18 10H14C13.4477 10 13 9.5523 13 9V5C13 4.44772 13.4477 4 14 4Z" stroke="currentColor" strokeWidth="1.5"/>
                      <path d="M16 12V20M16 20L13 17M16 20L19 17" stroke="#10b981" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    <span style={{ userSelect: "none" }}>在右侧插入列(R)</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={insertRightAmount}
                      onChange={(e) => setInsertRightAmount(Math.max(1, parseInt(e.target.value) || 1))}
                      style={{ width: "48px", height: "24px", borderRadius: "4px", border: "1px solid #d1d5db", textAlign: "center", outline: "none", color: "inherit", backgroundColor: "transparent" }}
                      onPointerDown={(e) => e.stopPropagation()}
                    />
                    <button
                      onClick={() => {
                        handleInsertColumns(contextMenu.index, insertRightAmount, "right");
                        setContextMenu(null);
                      }}
                      style={{ background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", color: "#6b7280", padding: 0 }}
                    >
                      <Check size={18} strokeWidth={1.5} />
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: "12px", padding: "6px 8px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", width: "120px" }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M4 14V18C4 18.5523 4.44772 19 5 19H19C19.5523 19 20 18.5523 20 18V14C20 13.4477 19.5523 13 19 13H5C4.44772 13 4 13.4477 4 14Z" stroke="currentColor" strokeWidth="1.5"/>
                      <path d="M4 16H20" stroke="currentColor" strokeWidth="1.5"/>
                      <path d="M4 6V10C4 10.5523 4.44772 11 5 11H9C9.5523 11 10 10.5523 10 10V6C10 5.4477 9.5523 5 9 5H5C4.44772 5 4 5.4477 4 6Z" stroke="currentColor" strokeWidth="1.5"/>
                      <path d="M12 8H20M20 8L17 5M20 8L17 11" stroke="#10b981" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    <span style={{ userSelect: "none" }}>在上方插入行(A)</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={insertTopAmount}
                      onChange={(e) => setInsertTopAmount(Math.max(1, parseInt(e.target.value) || 1))}
                      style={{ width: "48px", height: "24px", borderRadius: "4px", border: "1px solid #d1d5db", textAlign: "center", outline: "none", color: "inherit", backgroundColor: "transparent" }}
                      onPointerDown={(e) => e.stopPropagation()}
                    />
                    <button
                      onClick={() => {
                        handleInsertRows(contextMenu.index, insertTopAmount, "above");
                        setContextMenu(null);
                      }}
                      style={{ background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", color: "#6b7280", padding: 0 }}
                    >
                      <Check size={18} strokeWidth={1.5} />
                    </button>
                  </div>
                </div>
                
                <div style={{ display: "flex", alignItems: "center", gap: "12px", padding: "6px 8px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", width: "120px" }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M4 6V10C4 10.5523 4.44772 11 5 11H19C19.5523 11 20 10.5523 20 10V6C20 5.4477 19.5523 5 19 5H5C4.44772 5 4 5.4477 4 6Z" stroke="currentColor" strokeWidth="1.5"/>
                      <path d="M4 8H20" stroke="currentColor" strokeWidth="1.5"/>
                      <path d="M4 14V18C4 18.5523 4.44772 19 5 19H9C9.5523 19 10 18.5523 10 18V14C10 13.4477 9.5523 13 9 13H5C4.44772 13 4 13.4477 4 14Z" stroke="currentColor" strokeWidth="1.5"/>
                      <path d="M12 16H20M20 16L17 13M20 16L17 19" stroke="#10b981" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    <span style={{ userSelect: "none" }}>在下方插入行(B)</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={insertBottomAmount}
                      onChange={(e) => setInsertBottomAmount(Math.max(1, parseInt(e.target.value) || 1))}
                      style={{ width: "48px", height: "24px", borderRadius: "4px", border: "1px solid #d1d5db", textAlign: "center", outline: "none", color: "inherit", backgroundColor: "transparent" }}
                      onPointerDown={(e) => e.stopPropagation()}
                    />
                    <button
                      onClick={() => {
                        handleInsertRows(contextMenu.index, insertBottomAmount, "below");
                        setContextMenu(null);
                      }}
                      style={{ background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", color: "#6b7280", padding: 0 }}
                    >
                      <Check size={18} strokeWidth={1.5} />
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );

  function handleInsertColumns(targetColIndex: number, amount: number, direction: "left" | "right") {
    if (!activeSheet || !previewState.workbook || !previewState.xlsx) return;
    const worksheet = previewState.workbook.Sheets[activeSheet.name];
    if (!worksheet) return;

    const insertAtCol = direction === "left" ? targetColIndex : targetColIndex + 1;
    const newWorksheet: any = {};

    for (const key in worksheet) {
      if (key.startsWith("!")) {
        newWorksheet[key] = worksheet[key];
        continue;
      }
      const cellPos = previewState.xlsx.utils.decode_cell(key);
      let newCol = cellPos.c;
      if (cellPos.c >= insertAtCol) {
        newCol += amount;
      }
      const newKey = previewState.xlsx.utils.encode_cell({ c: newCol, r: cellPos.r });
      newWorksheet[newKey] = worksheet[key];
    }

    if (worksheet["!ref"]) {
      const range = previewState.xlsx.utils.decode_range(worksheet["!ref"]);
      const newRange = {
        s: { c: range.s.c, r: range.s.r },
        e: { c: range.e.c + amount, r: range.e.r },
      };
      newWorksheet["!ref"] = previewState.xlsx.utils.encode_range(newRange);
    }

    if (worksheet["!cols"]) {
      const newCols = [];
      for (let i = 0; i < worksheet["!cols"].length; i++) {
        if (worksheet["!cols"][i]) {
          if (i < insertAtCol) {
            newCols[i] = worksheet["!cols"][i];
          } else {
            newCols[i + amount] = worksheet["!cols"][i];
          }
        }
      }
      newWorksheet["!cols"] = newCols;
    }

    previewState.workbook.Sheets[activeSheet.name] = newWorksheet;
    const nextSheet = buildSheetPreview(activeSheet.name, newWorksheet, previewState.xlsx);

    setColumnWidthsBySheet((current) => {
      const sheetWidths = current[activeSheet.name] || {};
      const newSheetWidths: Record<number, number> = {};
      for (const colStr in sheetWidths) {
        const col = parseInt(colStr, 10);
        if (col < insertAtCol) {
          newSheetWidths[col] = sheetWidths[col];
        } else {
          newSheetWidths[col + amount] = sheetWidths[col];
        }
      }
      return {
        ...current,
        [activeSheet.name]: newSheetWidths,
      };
    });

    setPreviewState((current) => ({
      ...current,
      sheets: current.sheets.map((s) => (s.name === activeSheet.name ? nextSheet : s)),
    }));
    
    setSelectionRange(null);
    setEditingCell(null);
    publishWorkbookFile(previewState.workbook, previewState.xlsx);
  }

  function handleInsertRows(targetRowIndex: number, amount: number, direction: "above" | "below") {
    if (!activeSheet || !previewState.workbook || !previewState.xlsx) return;
    const worksheet = previewState.workbook.Sheets[activeSheet.name];
    if (!worksheet) return;

    const insertAtRow = direction === "above" ? targetRowIndex : targetRowIndex + 1;
    const newWorksheet: any = {};

    for (const key in worksheet) {
      if (key.startsWith("!")) {
        newWorksheet[key] = worksheet[key];
        continue;
      }
      const cellPos = previewState.xlsx.utils.decode_cell(key);
      let newRow = cellPos.r;
      if (cellPos.r >= insertAtRow) {
        newRow += amount;
      }
      const newKey = previewState.xlsx.utils.encode_cell({ c: cellPos.c, r: newRow });
      newWorksheet[newKey] = worksheet[key];
    }

    if (worksheet["!ref"]) {
      const range = previewState.xlsx.utils.decode_range(worksheet["!ref"]);
      const newRange = {
        s: { c: range.s.c, r: range.s.r },
        e: { c: range.e.c, r: range.e.r + amount },
      };
      newWorksheet["!ref"] = previewState.xlsx.utils.encode_range(newRange);
    }

    if (worksheet["!rows"]) {
      const newRows = [];
      for (let i = 0; i < worksheet["!rows"].length; i++) {
        if (worksheet["!rows"][i]) {
          if (i < insertAtRow) {
            newRows[i] = worksheet["!rows"][i];
          } else {
            newRows[i + amount] = worksheet["!rows"][i];
          }
        }
      }
      newWorksheet["!rows"] = newRows;
    }

    previewState.workbook.Sheets[activeSheet.name] = newWorksheet;
    const nextSheet = buildSheetPreview(activeSheet.name, newWorksheet, previewState.xlsx);

    setRowHeightsBySheet((current) => {
      const sheetHeights = current[activeSheet.name] || {};
      const newSheetHeights: Record<number, number> = {};
      for (const rowStr in sheetHeights) {
        const row = parseInt(rowStr, 10);
        if (row < insertAtRow) {
          newSheetHeights[row] = sheetHeights[row];
        } else {
          newSheetHeights[row + amount] = sheetHeights[row];
        }
      }
      return {
        ...current,
        [activeSheet.name]: newSheetHeights,
      };
    });

    setPreviewState((current) => ({
      ...current,
      sheets: current.sheets.map((s) => (s.name === activeSheet.name ? nextSheet : s)),
    }));
    
    setSelectionRange(null);
    setEditingCell(null);
    publishWorkbookFile(previewState.workbook, previewState.xlsx);
  }

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
    if (event.button !== 0) return;
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
    if (event.button !== 0) return;
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
