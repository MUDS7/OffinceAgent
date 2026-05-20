import { invoke } from "@tauri-apps/api/core";
import {
  BooleanNumber,
  CellValueType,
  LocaleType,
  VerticalAlign,
  createUniver,
  defaultTheme,
} from "@univerjs/presets";
import type { ICellData, IRange, IWorkbookData, IWorksheetData } from "@univerjs/presets";
import { UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import zhCN from "@univerjs/preset-sheets-core/locales/zh-CN";
import sheetsWorkerUrl from "@univerjs/preset-sheets-core/lib/worker.js?url";
import "@univerjs/preset-sheets-core/lib/index.css";
import { RefreshCw, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type * as XLSXModule from "xlsx";
import type { DocumentIndexRequest, DocumentIndexResult } from "../../types";
import { normalizeFilePath } from "../../utils/fileUtils";
import type { DocumentSelectionContext, PreviewFile, SaveFileProvider, SearchNavigationTarget } from "./types";

type SpreadsheetPreviewProps = {
  activeFile: PreviewFile;
  searchNavigationTarget: SearchNavigationTarget | null;
  onSaveFile: (fileId: string) => void;
  onRegisterSaveFileProvider: (fileId: string, provider: SaveFileProvider) => () => void;
  onSelectionContextChange: (context: DocumentSelectionContext | null) => void;
  onUpdateSpreadsheetFile: (fileId: string, file: File) => void;
};

type SheetPreview = {
  cells: SpreadsheetCell[];
  name: string;
  rangeLabel: string;
};

type SpreadsheetCell = {
  address: string;
  col: number;
  row: number;
  value: string;
};

type SpreadsheetIndexBlock = {
  id: string;
  type: "excel_sheet";
  name: string;
  range: string;
  merges: {
    range: string;
    start_row: number;
    end_row: number;
    start_col: number;
    end_col: number;
    value: string;
  }[];
  rows: {
    row_index: number;
    range: string;
    cells: {
      address: string;
      text: string;
    }[];
  }[];
};

type UniverRuntime = ReturnType<typeof createUniver>;
type UniverApi = UniverRuntime["univerAPI"];
type UniverWorkbook = NonNullable<ReturnType<UniverApi["getActiveWorkbook"]>>;

const DEFAULT_COLUMN_WIDTH = 132;
const DEFAULT_ROW_HEIGHT = 28;
const DEFAULT_ROW_COUNT = 100;
const DEFAULT_COLUMN_COUNT = 26;
const TEXT_CELL_STYLE_ID = "office-agent-text-cell";
const MAX_SELECTION_CONTEXT_ROWS = 200;
const MAX_SELECTION_CONTEXT_COLUMNS = 80;
const SAVE_DEBOUNCE_MS = 600;
const SPREADSHEET_MUTATION_COMMAND_MARKERS = [
  "set",
  "insert",
  "delete",
  "remove",
  "clear",
  "paste",
  "cut",
  "move",
  "rename",
  "sheet.command",
  "sheet.mutation",
];
const UNIVER_POINTER_EVENT_NAMES = [
  "click",
  "contextmenu",
  "dblclick",
  "mousedown",
  "mousemove",
  "mouseup",
  "pointercancel",
  "pointerdown",
  "pointermove",
  "pointerup",
] as const;

export function SpreadsheetPreview({
  activeFile,
  searchNavigationTarget,
  onSaveFile,
  onRegisterSaveFileProvider,
  onSelectionContextChange,
  onUpdateSpreadsheetFile,
}: SpreadsheetPreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fWorkbookRef = useRef<UniverWorkbook | null>(null);
  const lastPublishedFileRef = useRef<File | null>(null);
  const loadedFileIdRef = useRef("");
  const lastIndexSignatureRef = useRef("");
  const saveTimerRef = useRef<number | null>(null);
  const runtimeDisposersRef = useRef<{ dispose: () => void }[]>([]);
  const univerRuntimeRef = useRef<UniverRuntime | null>(null);
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

  useEffect(() => {
    if (loadedFileIdRef.current === activeFile.id && lastPublishedFileRef.current === activeFile.file) {
      return;
    }

    const container = containerRef.current;
    if (!container) return;
    const univerContainer: HTMLElement = container;

    let isCancelled = false;
    loadedFileIdRef.current = activeFile.id;
    lastIndexSignatureRef.current = "";

    disposeUniverRuntime();
    setPreviewState({ error: "", isLoading: true, sheets: [], workbook: null, xlsx: null });
    onSelectionContextChange(null);

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

        if (!sheets.length) {
          throw new Error("Workbook does not contain visible sheets.");
        }

        await indexSpreadsheetWorkbook(activeFile, workbook, XLSX);
        if (isCancelled) return;

        const snapshot = buildUniverWorkbookData(activeFile, workbook, XLSX);
        const runtime = createUniver({
          theme: defaultTheme,
          locale: LocaleType.ZH_CN,
          locales: {
            [LocaleType.ZH_CN]: zhCN,
          },
          presets: [
            UniverSheetsCorePreset({
              container: univerContainer,
              workerURL: sheetsWorkerUrl,
              header: false,
              toolbar: true,
              formulaBar: true,
              disableAutoFocus: true,
              sheets: {
                disableForceStringAlert: true,
                disableForceStringMark: true,
              },
            }),
          ],
        });
        const fWorkbook = runtime.univerAPI.createWorkbook(snapshot);

        univerRuntimeRef.current = runtime;
        fWorkbookRef.current = fWorkbook;
        bindUniverEvents(runtime.univerAPI, fWorkbook, XLSX);

        setPreviewState({
          error: "",
          isLoading: false,
          sheets,
          workbook,
          xlsx: XLSX,
        });
      } catch (error) {
        if (isCancelled) return;

        disposeUniverRuntime();
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
    if (!searchNavigationTarget || previewState.isLoading || previewState.error) return;

    const target = findSpreadsheetSearchTarget(previewState.sheets, searchNavigationTarget);
    if (!target) return;

    const fWorkbook = fWorkbookRef.current;
    const fWorksheet = fWorkbook?.getSheetByName(target.sheetName);
    if (!fWorkbook || !fWorksheet) return;

    fWorkbook.setActiveSheet(fWorksheet);
    const range = fWorksheet.getRange(target.row, target.col);
    fWorksheet.setActiveSelection(range);
    if ("scrollToCell" in fWorksheet && typeof fWorksheet.scrollToCell === "function") {
      fWorksheet.scrollToCell(target.row, target.col);
    }
  }, [searchNavigationTarget?.id, previewState.error, previewState.isLoading, previewState.sheets]);

  useEffect(() => {
    return onRegisterSaveFileProvider(activeFile.id, () => {
      if (previewState.isLoading) {
        return lastPublishedFileRef.current ?? activeFile.file;
      }

      if (previewState.error) {
        throw new Error(`Excel 预览失败，无法保存（文件：${activeFile.filename}）：${previewState.error}`);
      }

      return publishCurrentUniverWorkbook() ?? lastPublishedFileRef.current ?? activeFile.file;
    });
  }, [
    activeFile.file,
    activeFile.filename,
    activeFile.id,
    onRegisterSaveFileProvider,
    previewState.error,
    previewState.isLoading,
    previewState.xlsx,
  ]);

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

  useEffect(() => {
    return () => {
      disposeUniverRuntime();
    };
  }, []);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;

    for (const eventName of UNIVER_POINTER_EVENT_NAMES) {
      host.addEventListener(eventName, patchUniverEventOffset, { capture: true });
    }

    return () => {
      for (const eventName of UNIVER_POINTER_EVENT_NAMES) {
        host.removeEventListener(eventName, patchUniverEventOffset, { capture: true });
      }
    };
  }, []);

  return (
    <div className="editor-content spreadsheet-preview">
      <div ref={containerRef} className="univer-spreadsheet-host" />

      {previewState.isLoading ? (
        <div className="spreadsheet-preview-overlay preview-empty">
          <RefreshCw className="spin" size={26} />
          <span>Opening spreadsheet...</span>
        </div>
      ) : null}

      {previewState.error ? (
        <div className="spreadsheet-preview-overlay preview-empty">
          <XCircle size={28} />
          <span>{previewState.error}</span>
        </div>
      ) : null}
    </div>
  );

  function bindUniverEvents(
    univerAPI: UniverApi,
    fWorkbook: UniverWorkbook,
    xlsx: typeof XLSXModule,
  ) {
    runtimeDisposersRef.current.push(
      univerAPI.addEvent(univerAPI.Event.SelectionChanged, ({ worksheet, selections }) => {
        const range = selections[0];
        if (!range) {
          onSelectionContextChange(null);
          return;
        }

        onSelectionContextChange({
          fileId: activeFile.id,
          filePath: activeFile.diskPath ?? activeFile.filename,
          filename: activeFile.filename,
          sourceType: "spreadsheet",
          text: getSelectionContextText(worksheet, range),
        });
      }),
    );

    runtimeDisposersRef.current.push(
      univerAPI.addEvent(univerAPI.Event.SheetEditEnded, ({ isConfirm }) => {
        if (isConfirm) schedulePublishUniverWorkbook(fWorkbook, xlsx);
      }),
    );

    runtimeDisposersRef.current.push(
      univerAPI.onCommandExecuted((commandInfo) => {
        const commandId = String(commandInfo.id ?? "").toLowerCase();
        if (commandId.includes("selection") || commandId.includes("scroll") || commandId.includes("focus")) return;
        if (!SPREADSHEET_MUTATION_COMMAND_MARKERS.some((marker) => commandId.includes(marker))) return;

        schedulePublishUniverWorkbook(fWorkbook, xlsx);
      }),
    );
  }

  function schedulePublishUniverWorkbook(fWorkbook: UniverWorkbook, xlsx: typeof XLSXModule) {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      publishUniverWorkbook(fWorkbook, xlsx);
    }, SAVE_DEBOUNCE_MS);
  }

  function publishCurrentUniverWorkbook(): File | null {
    const fWorkbook = fWorkbookRef.current;
    const xlsx = previewState.xlsx;
    if (!fWorkbook || !xlsx) return null;

    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    return publishUniverWorkbook(fWorkbook, xlsx);
  }

  function publishUniverWorkbook(fWorkbook: UniverWorkbook, xlsx: typeof XLSXModule): File {
    const workbook = buildSheetJsWorkbookFromUniver(fWorkbook.save(), xlsx);
    const bookType: XLSXModule.BookType = activeFile.filename.toLowerCase().endsWith(".xls") ? "xls" : "xlsx";
    const workbookBytes = xlsx.write(workbook, { bookType, type: "array" }) as ArrayBuffer;
    const nextFile = new File([workbookBytes], activeFile.filename, {
      type: activeFile.file.type,
      lastModified: Date.now(),
    });

    lastPublishedFileRef.current = nextFile;
    onUpdateSpreadsheetFile(activeFile.id, nextFile);

    const sheets = workbook.SheetNames.map((sheetName) => buildSheetPreview(sheetName, workbook.Sheets[sheetName], xlsx));
    setPreviewState((current) => ({
      ...current,
      sheets,
      workbook,
    }));
    void indexSpreadsheetWorkbook({ ...activeFile, file: nextFile }, workbook, xlsx).catch((error) => {
      console.warn("Failed to index spreadsheet structure:", error);
    });

    return nextFile;
  }

  function disposeUniverRuntime() {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    for (const disposer of runtimeDisposersRef.current) {
      disposer.dispose();
    }
    runtimeDisposersRef.current = [];

    fWorkbookRef.current = null;
    univerRuntimeRef.current?.univer.dispose();
    univerRuntimeRef.current = null;

    if (containerRef.current) {
      containerRef.current.replaceChildren();
    }
  }

  function patchUniverEventOffset(event: Event) {
    if (!(event instanceof MouseEvent)) return;

    const scale = getUiScale();
    if (Math.abs(scale - 1) < 0.001) return;

    const target = event.target instanceof Element ? event.target : containerRef.current;
    const targetRect = target?.getBoundingClientRect();
    if (!targetRect) return;

    const offsetX = (event.clientX - targetRect.left) / scale;
    const offsetY = (event.clientY - targetRect.top) / scale;

    try {
      Object.defineProperties(event, {
        offsetX: {
          configurable: true,
          get: () => offsetX,
        },
        offsetY: {
          configurable: true,
          get: () => offsetY,
        },
      });
    } catch {
      // Some embedded runtimes may make MouseEvent offsets non-configurable.
      // In that case Univer falls back to the browser-provided coordinates.
    }
  }

  async function indexSpreadsheetWorkbook(
    file: PreviewFile,
    workbook: XLSXModule.WorkBook,
    xlsx: typeof XLSXModule,
  ) {
    const blocks = buildSpreadsheetIndexBlocks(workbook, xlsx);
    const signature = JSON.stringify(blocks);
    if (!signature || signature === lastIndexSignatureRef.current) return;

    const request: DocumentIndexRequest = {
      document_id: getDocumentIndexId(file),
      filename: file.filename,
      path: file.diskPath,
      original_path: file.diskPath,
      stored_path: file.diskPath,
      extension: file.filename.split(".").pop()?.toLowerCase() ?? "xlsx",
      file_type: "spreadsheet",
      size_bytes: file.file.size,
      parse_status: "parsed",
      index_status: "indexed",
      blocks,
    };

    await invoke<DocumentIndexResult>("index_document_structure", { request });
    lastIndexSignatureRef.current = signature;
  }
}

function getDocumentIndexId(activeFile: PreviewFile) {
  return activeFile.diskPath ? `path:${normalizeFilePath(activeFile.diskPath).toLowerCase()}` : activeFile.id;
}

function buildUniverWorkbookData(
  activeFile: PreviewFile,
  workbook: XLSXModule.WorkBook,
  xlsx: typeof XLSXModule,
): IWorkbookData {
  const sheetOrder = workbook.SheetNames.map((_, index) => `sheet-${index}`);
  const sheets = workbook.SheetNames.reduce<Record<string, Partial<IWorksheetData>>>((result, sheetName, index) => {
    const sheetId = sheetOrder[index];
    result[sheetId] = buildUniverWorksheetData(sheetId, sheetName, workbook.Sheets[sheetName], xlsx);
    return result;
  }, {});

  return {
    id: `workbook-${safeIdentifier(activeFile.id)}`,
    appVersion: "0.22.1",
    locale: LocaleType.ZH_CN,
    name: activeFile.filename,
    sheetOrder,
    sheets,
    styles: {
      [TEXT_CELL_STYLE_ID]: {
        n: {
          pattern: "@",
        },
      },
    },
    resources: [],
  };
}

function buildUniverWorksheetData(
  sheetId: string,
  sheetName: string,
  sheet: XLSXModule.WorkSheet | undefined,
  xlsx: typeof XLSXModule,
): Partial<IWorksheetData> {
  const fallbackRange = xlsx.utils.decode_range("A1:A1");
  const usedRange = sheet?.["!ref"] ? xlsx.utils.decode_range(sheet["!ref"]) : fallbackRange;
  const cellData: IWorksheetData["cellData"] = {};

  if (sheet) {
    for (const address of Object.keys(sheet)) {
      if (address.startsWith("!")) continue;

      const point = xlsx.utils.decode_cell(address);
      const cell = sheet[address] as XLSXModule.CellObject | undefined;
      const univerCell = cell ? toUniverCell(cell, xlsx) : null;
      if (!univerCell) continue;

      cellData[point.r] = cellData[point.r] ?? {};
      cellData[point.r][point.c] = univerCell;
    }
  }

  return {
    id: sheetId,
    name: sheetName,
    tabColor: "",
    hidden: BooleanNumber.FALSE,
    freeze: {
      xSplit: 0,
      ySplit: 0,
      startRow: 0,
      startColumn: 0,
    },
    rowCount: Math.max(usedRange.e.r + 1, DEFAULT_ROW_COUNT),
    columnCount: Math.max(usedRange.e.c + 1, DEFAULT_COLUMN_COUNT),
    zoomRatio: 1,
    scrollTop: 0,
    scrollLeft: 0,
    defaultColumnWidth: DEFAULT_COLUMN_WIDTH,
    defaultRowHeight: DEFAULT_ROW_HEIGHT,
    defaultStyle: {
      vt: VerticalAlign.TOP,
    },
    mergeData: ((sheet?.["!merges"] ?? []) as XLSXModule.Range[]).map((merge) => ({
      startRow: merge.s.r,
      endRow: merge.e.r,
      startColumn: merge.s.c,
      endColumn: merge.e.c,
    })),
    cellData,
    rowData: buildUniverRowData(sheet),
    columnData: buildUniverColumnData(sheet),
    rowHeader: {
      width: 54,
    },
    columnHeader: {
      height: 28,
    },
    showGridlines: BooleanNumber.TRUE,
    rightToLeft: BooleanNumber.FALSE,
  };
}

function toUniverCell(cell: XLSXModule.CellObject, xlsx: typeof XLSXModule): ICellData | null {
  const formula = typeof cell.f === "string" && cell.f.trim() ? ensureFormulaEquals(cell.f) : undefined;
  const formattedValue = xlsx.utils.format_cell(cell);
  const value = getCellRawValue(cell, formattedValue);
  const cellValue = value ?? formattedValue;

  if (value === null && !formula) return null;

  return {
    v: cellValue,
    t: getUniverCellValueType(cellValue),
    ...(!formula && typeof cellValue === "string" ? { s: TEXT_CELL_STYLE_ID } : {}),
    ...(formula ? { f: formula } : {}),
  };
}

function getCellRawValue(cell: XLSXModule.CellObject, formattedValue: string) {
  if (cell.v === undefined || cell.v === null) return formattedValue || null;
  if (cell.v instanceof Date) return formattedValue || cell.v.toISOString();
  if (typeof cell.v === "string" || typeof cell.v === "number" || typeof cell.v === "boolean") return cell.v;

  return formattedValue || String(cell.v);
}

function getUniverCellValueType(value: string | number | boolean) {
  if (typeof value === "number") return CellValueType.NUMBER;
  if (typeof value === "boolean") return CellValueType.BOOLEAN;
  return CellValueType.STRING;
}

function buildUniverRowData(sheet: XLSXModule.WorkSheet | undefined): IWorksheetData["rowData"] {
  return ((sheet?.["!rows"] ?? []) as XLSXModule.RowInfo[]).reduce<IWorksheetData["rowData"]>((result, row, index) => {
    if (!row) return result;

    const height = row.hpx ?? (row.hpt ? Math.round(row.hpt * 1.333) : undefined);
    if (height) result[index] = { h: height };
    return result;
  }, {});
}

function buildUniverColumnData(sheet: XLSXModule.WorkSheet | undefined): IWorksheetData["columnData"] {
  return ((sheet?.["!cols"] ?? []) as XLSXModule.ColInfo[]).reduce<IWorksheetData["columnData"]>((result, column, index) => {
    if (!column) return result;

    const width = column.wpx ?? (column.wch ? Math.round(column.wch * 8) : undefined);
    if (width) result[index] = { w: width };
    return result;
  }, {});
}

function buildSheetJsWorkbookFromUniver(
  snapshot: IWorkbookData,
  xlsx: typeof XLSXModule,
): XLSXModule.WorkBook {
  const workbook = xlsx.utils.book_new();

  for (const sheetId of snapshot.sheetOrder) {
    const sheet = snapshot.sheets[sheetId];
    if (!sheet) continue;

    const worksheet = buildSheetJsWorksheetFromUniver(sheet, xlsx);
    xlsx.utils.book_append_sheet(workbook, worksheet, sheet.name || "Sheet");
  }

  return workbook;
}

function buildSheetJsWorksheetFromUniver(
  sheet: Partial<IWorksheetData>,
  xlsx: typeof XLSXModule,
): XLSXModule.WorkSheet {
  const worksheet: XLSXModule.WorkSheet = {};
  let maxRow = 0;
  let maxColumn = 0;

  for (const [rowKey, row] of Object.entries(sheet.cellData ?? {})) {
    const rowIndex = Number(rowKey);
    if (!Number.isFinite(rowIndex) || !row) continue;

    for (const [columnKey, cell] of Object.entries(row)) {
      const columnIndex = Number(columnKey);
      if (!Number.isFinite(columnIndex) || !cell) continue;

      const sheetCell = toSheetJsCell(cell);
      if (!sheetCell) continue;

      const address = xlsx.utils.encode_cell({ r: rowIndex, c: columnIndex });
      worksheet[address] = sheetCell;
      maxRow = Math.max(maxRow, rowIndex);
      maxColumn = Math.max(maxColumn, columnIndex);
    }
  }

  worksheet["!ref"] = xlsx.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: Math.max(maxRow, 0), c: Math.max(maxColumn, 0) },
  });

  if (sheet.mergeData?.length) {
    worksheet["!merges"] = sheet.mergeData.map((range) => ({
      s: { r: range.startRow, c: range.startColumn },
      e: { r: range.endRow, c: range.endColumn },
    }));
  }

  const rows = buildSheetJsRowInfo(sheet.rowData);
  if (rows.length) worksheet["!rows"] = rows;

  const columns = buildSheetJsColumnInfo(sheet.columnData);
  if (columns.length) worksheet["!cols"] = columns;

  return worksheet;
}

function toSheetJsCell(cell: ICellData): XLSXModule.CellObject | null {
  const value = cell.v;
  const formula = typeof cell.f === "string" && cell.f.trim() ? cell.f.replace(/^=/, "") : undefined;

  if (value === null || value === undefined) {
    return formula ? ({ t: "n", f: formula } as XLSXModule.CellObject) : null;
  }

  if (cell.t === CellValueType.STRING || cell.t === CellValueType.FORCE_STRING) {
    return { t: "s", v: String(value), ...(formula ? { f: formula } : {}) };
  }

  if (typeof value === "number") return { t: "n", v: value, ...(formula ? { f: formula } : {}) };
  if (typeof value === "boolean") return { t: "b", v: value, ...(formula ? { f: formula } : {}) };

  return { t: "s", v: String(value), ...(formula ? { f: formula } : {}) };
}

function buildSheetJsRowInfo(rowData: Partial<IWorksheetData["rowData"]> | undefined): XLSXModule.RowInfo[] {
  const rows: XLSXModule.RowInfo[] = [];

  for (const [index, row] of Object.entries(rowData ?? {})) {
    const rowIndex = Number(index);
    if (!Number.isFinite(rowIndex) || !row?.h) continue;
    rows[rowIndex] = { hpx: row.h };
  }

  return rows;
}

function buildSheetJsColumnInfo(columnData: Partial<IWorksheetData["columnData"]> | undefined): XLSXModule.ColInfo[] {
  const columns: XLSXModule.ColInfo[] = [];

  for (const [index, column] of Object.entries(columnData ?? {})) {
    const columnIndex = Number(index);
    if (!Number.isFinite(columnIndex) || !column?.w) continue;
    columns[columnIndex] = { wpx: column.w };
  }

  return columns;
}

function buildSheetPreview(
  name: string,
  sheet: XLSXModule.WorkSheet | undefined,
  xlsx: typeof XLSXModule,
): SheetPreview {
  const fallbackRange = xlsx.utils.decode_range("A1:A1");
  const sheetRef = sheet?.["!ref"];
  const usedRange = sheetRef ? xlsx.utils.decode_range(sheetRef) : fallbackRange;
  const cells = Object.keys(sheet ?? {})
    .filter((address) => !address.startsWith("!"))
    .map((address) => {
      const point = xlsx.utils.decode_cell(address);
      const cell = sheet?.[address] as XLSXModule.CellObject | undefined;

      return {
        address,
        col: point.c,
        row: point.r,
        value: cell ? xlsx.utils.format_cell(cell) : "",
      };
    })
    .filter((cell) => cell.value.trim().length > 0);

  return {
    cells,
    name,
    rangeLabel: `${encodeCellAddress(usedRange.s.r, usedRange.s.c)}:${encodeCellAddress(usedRange.e.r, usedRange.e.c)}`,
  };
}

function buildSpreadsheetIndexBlocks(
  workbook: XLSXModule.WorkBook,
  xlsx: typeof XLSXModule,
): SpreadsheetIndexBlock[] {
  return workbook.SheetNames.map((sheetName, sheetIndex) => {
    const worksheet = workbook.Sheets[sheetName];
    const fallbackRange = xlsx.utils.decode_range("A1:A1");
    const usedRange = worksheet?.["!ref"] ? xlsx.utils.decode_range(worksheet["!ref"]) : fallbackRange;
    const rangeLabel = `${encodeCellAddress(usedRange.s.r, usedRange.s.c)}:${encodeCellAddress(usedRange.e.r, usedRange.e.c)}`;
    const merges = (((worksheet?.["!merges"] ?? []) as XLSXModule.Range[]) || []).map((merge) => {
      const topLeftAddress = encodeCellAddress(merge.s.r, merge.s.c);
      const topLeftCell = worksheet?.[topLeftAddress] as XLSXModule.CellObject | undefined;

      return {
        range: xlsx.utils.encode_range(merge),
        start_row: merge.s.r + 1,
        end_row: merge.e.r + 1,
        start_col: merge.s.c,
        end_col: merge.e.c,
        value: topLeftCell ? xlsx.utils.format_cell(topLeftCell) : "",
      };
    });

    return {
      id: `sheet-${sheetIndex}`,
      type: "excel_sheet",
      name: sheetName,
      range: rangeLabel,
      merges,
      rows: Array.from({ length: usedRange.e.r - usedRange.s.r + 1 }, (_, rowOffset) => {
        const row = usedRange.s.r + rowOffset;
        const nonEmptyCells = Array.from({ length: usedRange.e.c - usedRange.s.c + 1 }, (_, colOffset) => {
          const col = usedRange.s.c + colOffset;
          const address = encodeCellAddress(row, col);
          const cell = worksheet?.[address] as XLSXModule.CellObject | undefined;
          const text = cell ? xlsx.utils.format_cell(cell) : "";

          return text.trim()
            ? {
                address,
                text,
              }
            : null;
        }).filter((cell): cell is { address: string; text: string } => Boolean(cell));
        const firstAddress = encodeCellAddress(row, usedRange.s.c);
        const lastAddress = encodeCellAddress(row, usedRange.e.c);

        return {
          row_index: row + 1,
          range: `${firstAddress}:${lastAddress}`,
          cells: nonEmptyCells,
        };
      }),
    };
  });
}

function getSelectionContextText(worksheet: { getSheetName: () => string; getRange: (...args: [number, number, number, number]) => { getDisplayValues: () => string[][] } }, range: IRange) {
  const normalizedRange = normalizeUniverRange(range);
  const rowCount = Math.min(normalizedRange.endRow - normalizedRange.startRow + 1, MAX_SELECTION_CONTEXT_ROWS);
  const columnCount = Math.min(normalizedRange.endColumn - normalizedRange.startColumn + 1, MAX_SELECTION_CONTEXT_COLUMNS);
  const values = worksheet
    .getRange(normalizedRange.startRow, normalizedRange.startColumn, rowCount, columnCount)
    .getDisplayValues();
  const selectedRows = values.map((row) => row.join("\t")).filter((rowText) => rowText.trim().length > 0);
  const rangeLabel = buildRangeLabel(worksheet.getSheetName(), normalizedRange);

  return [`Sheet: ${worksheet.getSheetName()}`, `Range: ${rangeLabel}`, "", selectedRows.join("\n")]
    .join("\n")
    .trim();
}

function normalizeUniverRange(range: IRange): Required<Pick<IRange, "startRow" | "startColumn" | "endRow" | "endColumn">> {
  return {
    startRow: Math.min(range.startRow, range.endRow),
    startColumn: Math.min(range.startColumn, range.endColumn),
    endRow: Math.max(range.startRow, range.endRow),
    endColumn: Math.max(range.startColumn, range.endColumn),
  };
}

function buildRangeLabel(sheetName: string, range: Required<Pick<IRange, "startRow" | "startColumn" | "endRow" | "endColumn">>) {
  const start = encodeCellAddress(range.startRow, range.startColumn);
  const end = encodeCellAddress(range.endRow, range.endColumn);
  const address = start === end ? start : `${start}:${end}`;

  return `${sheetName}!${address}`;
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

function findSpreadsheetSearchTarget(sheets: SheetPreview[], target: SearchNavigationTarget) {
  const metadata = parseSearchMetadata(target.metadataJson);
  const query = target.query.trim().toLowerCase();
  const addresses = getMetadataCellAddresses(metadata);

  for (const address of addresses) {
    const hit = findSpreadsheetAddress(sheets, address);
    if (hit) return hit;
  }

  for (const sheet of sheets) {
    for (const cell of sheet.cells) {
      if (query && cell.value.toLowerCase().includes(query)) {
        return { sheetName: sheet.name, row: cell.row, col: cell.col, address: cell.address };
      }
    }
  }

  return null;
}

function getMetadataCellAddresses(metadata: Record<string, unknown> | null) {
  const cells = metadata?.cells;
  if (!Array.isArray(cells)) return [];

  return cells
    .map((cell) => (cell && typeof cell === "object" ? (cell as Record<string, unknown>).address : null))
    .filter((address): address is string => typeof address === "string" && address.trim().length > 0);
}

function findSpreadsheetAddress(sheets: SheetPreview[], address: string) {
  for (const sheet of sheets) {
    const cell = sheet.cells.find((item) => item.address === address);
    if (cell) return { sheetName: sheet.name, row: cell.row, col: cell.col, address: cell.address };
  }

  return null;
}

function parseSearchMetadata(metadataJson: string | undefined) {
  if (!metadataJson) return null;

  try {
    return JSON.parse(metadataJson) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function ensureFormulaEquals(formula: string) {
  return formula.startsWith("=") ? formula : `=${formula}`;
}

function safeIdentifier(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-") || "workbook";
}

function getUiScale() {
  const rawScale = getComputedStyle(document.documentElement).getPropertyValue("--ui-scale");
  const scale = Number.parseFloat(rawScale);

  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}
