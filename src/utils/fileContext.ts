import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import type * as XLSXModule from "xlsx";
import { DOCUMENT_SERVICE_URL, MAX_FILE_CONTEXT_CHARS } from "../constants";
import type { WorkspaceFile } from "../types";
import { fetchDocumentService } from "./documentService";

export type CompressedFileContext = {
  content: string;
  filename: string;
  fileType: "docx" | "pdf" | "spreadsheet" | "text" | "unsupported";
  isTruncated: boolean;
};

const TEXT_FILE_EXTENSIONS = new Set(["txt", "md", "csv", "json"]);
const SPREADSHEET_FILE_EXTENSIONS = new Set(["xlsx", "xls"]);
const PDF_FILE_EXTENSIONS = new Set(["pdf"]);
const DOCX_FILE_EXTENSIONS = new Set(["docx"]);
const MAX_CELL_VALUE_CHARS = 160;
const MAX_TEXT_LINE_CHARS = 500;

export async function buildCompressedFileContext(
  workspaceFile: WorkspaceFile | null,
  unsavedText?: string,
): Promise<CompressedFileContext | null> {
  if (!workspaceFile) return null;

  const extension = getFileExtension(workspaceFile.file.name);
  if (SPREADSHEET_FILE_EXTENSIONS.has(extension)) {
    return buildSpreadsheetFileContext(workspaceFile.file);
  }

  if (PDF_FILE_EXTENSIONS.has(extension)) {
    return buildPdfFileContext(workspaceFile.file);
  }

  if (DOCX_FILE_EXTENSIONS.has(extension)) {
    return buildDocxFileContext(workspaceFile.file);
  }

  if (TEXT_FILE_EXTENSIONS.has(extension)) {
    const text = unsavedText ?? (await workspaceFile.file.text());
    return buildTextFileContext(workspaceFile.file.name, text);
  }

  return null;
}

async function buildDocxFileContext(file: File): Promise<CompressedFileContext> {
  const response = await fetchDocumentService(`${DOCUMENT_SERVICE_URL}/docx/parse`, () => {
    const body = new FormData();
    body.append("file", file);
    return {
      method: "POST",
      body,
    };
  });

  if (!response.ok) {
    throw new Error(`DOCX parse service returned ${response.status}`);
  }

  const result = (await response.json()) as { blocks: Array<Record<string, unknown>> };
  const output = createContextWriter();
  let emittedBlocks = 0;

  output.push("Compressed Word document context. Block numbers keep their parsed order.");

  for (const [index, block] of result.blocks.entries()) {
    if (block.type === "paragraph") {
      const text = compressTextValue(String(block.text ?? ""), MAX_TEXT_LINE_CHARS * 2);
      if (!text.trim()) continue;
      if (!output.push(`B${index + 1} paragraph: ${text}`)) break;
      emittedBlocks += 1;
      continue;
    }

    if (block.type === "table" && Array.isArray(block.rows)) {
      const rows = block.rows as Array<Array<{ text?: string }>>;
      const rowText = rows
        .map((row, rowIndex) =>
          `R${rowIndex + 1}: ${row.map((cell) => compressTextValue(String(cell.text ?? ""), MAX_CELL_VALUE_CHARS)).join(" | ")}`,
        )
        .join("\n");
      if (!rowText.trim()) continue;
      if (!output.push(`B${index + 1} table:\n${rowText}`)) break;
      emittedBlocks += 1;
    }
  }

  return {
    content: output.toString(emittedBlocks),
    filename: file.name,
    fileType: "docx",
    isTruncated: output.isTruncated,
  };
}

function buildTextFileContext(filename: string, text: string): CompressedFileContext {
  const normalizedText = text.replace(/\r\n?/g, "\n");
  const lines = normalizedText.split("\n");
  const output = createContextWriter();

  output.push(`Compressed text file context. Lines keep their original 1-based positions.`);
  output.push(`Total lines: ${lines.length}`);

  for (let index = 0; index < lines.length; index += 1) {
    const line = compressTextValue(lines[index], MAX_TEXT_LINE_CHARS);
    if (!output.push(`L${index + 1}: ${line}`)) break;
  }

  return {
    content: output.toString(lines.length),
    filename,
    fileType: "text",
    isTruncated: output.isTruncated,
  };
}

async function buildPdfFileContext(file: File): Promise<CompressedFileContext> {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    isOffscreenCanvasSupported: false,
    useSystemFonts: true,
  });
  const pdfDocument = await loadingTask.promise;
  const output = createContextWriter();
  let emittedPages = 0;

  try {
    output.push("Compressed PDF text context. Page numbers keep their original positions.");
    output.push(`Total pages: ${pdfDocument.numPages}`);

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ");
      const compressedPageText = compressTextValue(pageText, MAX_TEXT_LINE_CHARS * 3);

      if (!compressedPageText.trim()) continue;
      if (!output.push(`Page ${pageNumber}: ${compressedPageText}`)) break;
      emittedPages += 1;
    }

    return {
      content: output.toString(emittedPages),
      filename: file.name,
      fileType: "pdf",
      isTruncated: output.isTruncated,
    };
  } finally {
    void loadingTask.destroy();
  }
}

async function buildSpreadsheetFileContext(file: File): Promise<CompressedFileContext> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(await file.arrayBuffer(), {
    cellDates: true,
    type: "array",
  });
  const output = createContextWriter();
  let emittedCells = 0;

  output.push(
    "Compressed workbook context. Empty cells are omitted; every value keeps its worksheet and Excel cell address.",
  );
  output.push(`Sheets: ${workbook.SheetNames.join(", ") || "(none)"}`);

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const sheetRef = sheet?.["!ref"];

    if (!sheet || !sheetRef) {
      if (!output.push(`\nSheet: ${sheetName}`)) break;
      if (!output.push("UsedRange: empty")) break;
      continue;
    }

    const usedRange = XLSX.utils.decode_range(sheetRef);
    if (!output.push(`\nSheet: ${sheetName}`)) break;
    if (!output.push(`UsedRange: ${sheetRef}`)) break;

    for (let row = usedRange.s.r; row <= usedRange.e.r; row += 1) {
      const rowValues: string[] = [];

      for (let col = usedRange.s.c; col <= usedRange.e.c; col += 1) {
        const address = XLSX.utils.encode_cell({ r: row, c: col });
        const cell = sheet[address] as XLSXModule.CellObject | undefined;
        if (!cell) continue;

        const value = compressTextValue(XLSX.utils.format_cell(cell), MAX_CELL_VALUE_CHARS);
        if (!value.trim()) continue;

        rowValues.push(`${address}=${JSON.stringify(value)}`);
      }

      if (!rowValues.length) continue;
      if (!output.push(`R${row + 1}: ${rowValues.join(" | ")}`)) break;
      emittedCells += rowValues.length;
    }

    if (output.isTruncated) break;
  }

  return {
    content: output.toString(emittedCells),
    filename: file.name,
    fileType: "spreadsheet",
    isTruncated: output.isTruncated,
  };
}

function createContextWriter() {
  const parts: string[] = [];
  let length = 0;
  let isTruncated = false;

  return {
    get isTruncated() {
      return isTruncated;
    },
    push(line: string) {
      if (isTruncated) return false;

      const nextLine = parts.length ? `\n${line}` : line;
      if (length + nextLine.length > MAX_FILE_CONTEXT_CHARS) {
        isTruncated = true;
        return false;
      }

      parts.push(line);
      length += nextLine.length;
      return true;
    },
    toString(itemCount: number) {
      const footer = isTruncated
        ? `\n...[file context truncated at ${MAX_FILE_CONTEXT_CHARS} chars; emitted items before truncation: ${itemCount}]`
        : "";
      return `${parts.join("\n")}${footer}`.trim();
    },
  };
}

function compressTextValue(value: string, maxChars: number) {
  const compressed = value.replace(/\s+/g, " ").trim();
  if (compressed.length <= maxChars) return compressed;

  return `${compressed.slice(0, maxChars)}...[truncated]`;
}

function getFileExtension(filename: string) {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}
