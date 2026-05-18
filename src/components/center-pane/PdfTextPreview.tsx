import { invoke } from "@tauri-apps/api/core";
import { RefreshCw, XCircle } from "lucide-react";
import { type MutableRefObject, useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import type { PDFPageProxy, RenderTask } from "pdfjs-dist";
import type { DocumentIndexRequest, DocumentIndexResult, PdfPageBlock } from "../../types";
import { normalizeFilePath } from "../../utils/fileUtils";
import { createPdfTextSelectionGuard, publishPdfSelection } from "./pdfSelection";
import type { DocumentSelectionContext, PreviewFile, SearchNavigationTarget } from "./types";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type PdfTextPreviewProps = {
  activeFile: PreviewFile;
  searchNavigationTarget: SearchNavigationTarget | null;
  onSelectionContextChange: (context: DocumentSelectionContext | null) => void;
};

export function PdfTextPreview({ activeFile, searchNavigationTarget, onSelectionContextChange }: PdfTextPreviewProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const pagesRef = useRef<HTMLDivElement | null>(null);
  const selectionOverlayRef = useRef<HTMLDivElement | null>(null);
  const lastPublishedSelectionRef = useRef("");
  const lastIndexSignatureRef = useRef("");
  const [pdfState, setPdfState] = useState({
    isLoading: true,
    error: "",
  });

  const { file, filename, id } = activeFile;

  useEffect(() => {
    const pagesElement = pagesRef.current;
    if (!pagesElement) return;

    const targetPagesElement = pagesElement;
    let isCancelled = false;
    const renderTasks: RenderTask[] = [];
    const textLayers: pdfjsLib.TextLayer[] = [];
    const textSelectionGuard = createPdfTextSelectionGuard();
    let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | null = null;

    targetPagesElement.replaceChildren();
    selectionOverlayRef.current?.replaceChildren();
    lastPublishedSelectionRef.current = "";
    lastIndexSignatureRef.current = "";
    onSelectionContextChange(null);
    setPdfState({ isLoading: true, error: "" });

    async function renderPdf() {
      try {
        const fileData = new Uint8Array(await file.arrayBuffer());
        if (isCancelled) return;

        loadingTask = pdfjsLib.getDocument({
          data: fileData,
          isOffscreenCanvasSupported: false,
          useSystemFonts: true,
        });
        const pdfDocument = await loadingTask.promise;
        const indexBlocks: PdfPageBlock[] = [];

        for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
          if (isCancelled) return;

          const page = await pdfDocument.getPage(pageNumber);
          const viewport = getScaledViewport(page, targetPagesElement);
          const pageElement = document.createElement("article");
          const canvas = document.createElement("canvas");
          const textLayerElement = document.createElement("div");
          const outputScale = window.devicePixelRatio || 1;

          pageElement.className = "pdf-page";
          pageElement.setAttribute("aria-label", `Page ${pageNumber}`);
          pageElement.dataset.pageNumber = String(pageNumber);
          pageElement.style.width = `${viewport.width}px`;
          pageElement.style.height = `${viewport.height}px`;
          pageElement.style.setProperty("--pdf-scale-factor", String(viewport.scale));

          canvas.width = Math.floor(viewport.width * outputScale);
          canvas.height = Math.floor(viewport.height * outputScale);
          canvas.style.width = `${viewport.width}px`;
          canvas.style.height = `${viewport.height}px`;

          textLayerElement.className = "textLayer pdf-text-layer";
          textLayerElement.style.width = `${viewport.width}px`;
          textLayerElement.style.height = `${viewport.height}px`;

          pageElement.append(canvas, textLayerElement);
          targetPagesElement.append(pageElement);

          const canvasContext = canvas.getContext("2d");
          if (!canvasContext) {
            throw new Error("Canvas rendering is not available in this webview.");
          }

          const renderTask = page.render({
            canvas,
            canvasContext,
            transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
            viewport,
          });
          renderTasks.push(renderTask);

          const textContent = await page.getTextContent();
          const textSnapshot = buildPdfTextSnapshot(textContent.items);
          indexBlocks.push({
            id: `page-${pageNumber}`,
            type: "pdf_page",
            page_number: pageNumber,
            text: textSnapshot.text,
            paragraphs: textSnapshot.paragraphs,
          });

          const textLayer = new pdfjsLib.TextLayer({
            container: textLayerElement,
            textContentSource: textContent,
            viewport,
          });
          textLayers.push(textLayer);

          await Promise.all([renderTask.promise, textLayer.render()]);
          textSelectionGuard.register(textLayerElement);
        }

        if (!isCancelled) {
          await indexPdfStructure(activeFile, indexBlocks, lastIndexSignatureRef);
        }

        if (!isCancelled) {
          setPdfState({ isLoading: false, error: "" });
        }
      } catch (error) {
        if (isCancelled || isPdfRenderCancelled(error)) return;

        setPdfState({
          isLoading: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    renderPdf();

    return () => {
      isCancelled = true;
      renderTasks.forEach((task) => task.cancel());
      textLayers.forEach((textLayer) => textLayer.cancel());
      textSelectionGuard.destroy();
      void loadingTask?.destroy();
      targetPagesElement.replaceChildren();
      selectionOverlayRef.current?.replaceChildren();
    };
  }, [activeFile.diskPath, file, filename, id, onSelectionContextChange]);

  useEffect(() => {
    function handleSelectionChange() {
      publishPdfSelection(
        shellRef.current,
        selectionOverlayRef.current,
        activeFile,
        onSelectionContextChange,
        lastPublishedSelectionRef,
      );
    }

    document.addEventListener("selectionchange", handleSelectionChange);

    const resizeObserver = new ResizeObserver(() => {
      if (lastPublishedSelectionRef.current) {
        handleSelectionChange();
      }
    });

    if (shellRef.current) {
      resizeObserver.observe(shellRef.current);
    }

    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
      resizeObserver.disconnect();
    };
  }, [activeFile, file, filename, id, onSelectionContextChange]);

  useEffect(() => {
    if (!searchNavigationTarget || pdfState.isLoading || pdfState.error) return;

    const metadata = parseSearchMetadata(searchNavigationTarget.metadataJson);
    const pageNumber = getNumberField(metadata, "page_number") ?? parsePageNumber(searchNavigationTarget.title);
    const pageElement = pageNumber
      ? pagesRef.current?.querySelector<HTMLElement>(`.pdf-page[data-page-number="${pageNumber}"]`)
      : pagesRef.current?.querySelector<HTMLElement>(".pdf-page");
    if (!pageElement) return;

    pageElement.scrollIntoView({ block: "start", behavior: "smooth" });
    pageElement.classList.add("search-jump-highlight");
    const timeoutId = window.setTimeout(() => pageElement.classList.remove("search-jump-highlight"), 1600);

    return () => {
      window.clearTimeout(timeoutId);
      pageElement.classList.remove("search-jump-highlight");
    };
  }, [searchNavigationTarget?.id, pdfState.isLoading, pdfState.error]);

  return (
    <div className="editor-content pdf-preview">
      <div
        className="pdf-viewer-shell"
        ref={shellRef}
        onPointerDown={(event) => {
          if (event.target instanceof Element && event.target.closest(".pdf-selection-overlay")) return;
          if (!lastPublishedSelectionRef.current) return;

          lastPublishedSelectionRef.current = "";
          selectionOverlayRef.current?.replaceChildren();
          onSelectionContextChange(null);
        }}
        onKeyUp={() =>
          publishPdfSelection(
            shellRef.current,
            selectionOverlayRef.current,
            activeFile,
            onSelectionContextChange,
            lastPublishedSelectionRef,
          )
        }
        onMouseUp={() =>
          publishPdfSelection(
            shellRef.current,
            selectionOverlayRef.current,
            activeFile,
            onSelectionContextChange,
            lastPublishedSelectionRef,
          )
        }
      >
        <div className="pdf-pages" ref={pagesRef} />
        <div className="pdf-selection-overlay" ref={selectionOverlayRef} aria-hidden="true" />
        {pdfState.isLoading ? (
          <div className="pdf-preview-status preview-empty">
            <RefreshCw className="spin" size={26} />
            <span>正在打开 PDF...</span>
          </div>
        ) : null}
        {pdfState.error ? (
          <div className="pdf-preview-status preview-empty">
            <XCircle size={28} />
            <span>{pdfState.error}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function getScaledViewport(page: PDFPageProxy, container: HTMLElement) {
  const baseViewport = page.getViewport({ scale: 1 });
  const availableWidth = Math.max(360, container.clientWidth - 28);
  const scale = Math.min(1.65, Math.max(0.72, availableWidth / baseViewport.width));

  return page.getViewport({ scale });
}

function isPdfRenderCancelled(error: unknown) {
  return error instanceof Error && error.name === "RenderingCancelledException";
}

type PdfTextItemLike = {
  str?: string;
  transform?: unknown;
  hasEOL?: boolean;
};

type PdfLine = {
  text: string;
  y: number | null;
};

function buildPdfTextSnapshot(items: unknown[]) {
  const lines = buildPdfLines(items);
  const paragraphs = buildPdfParagraphs(lines);
  const text = paragraphs.join("\n\n");

  return { text, paragraphs };
}

function buildPdfLines(items: unknown[]): PdfLine[] {
  const lines: PdfLine[] = [];
  let currentText = "";
  let currentY: number | null = null;

  for (const item of items) {
    const textItem = item as PdfTextItemLike;
    const rawText = typeof textItem.str === "string" ? textItem.str : "";
    const text = rawText.trim();
    const y = getPdfItemY(textItem);
    const isNewLine = currentText && y !== null && currentY !== null && Math.abs(y - currentY) > 3;

    if (isNewLine) {
      pushPdfLine(lines, currentText, currentY);
      currentText = "";
    }

    if (text) {
      currentText = appendPdfInlineText(currentText, text);
      currentY = y ?? currentY;
    }

    if (textItem.hasEOL) {
      pushPdfLine(lines, currentText, currentY);
      currentText = "";
      currentY = null;
    } else if (currentY === null) {
      currentY = y;
    }
  }

  pushPdfLine(lines, currentText, currentY);
  return lines;
}

function buildPdfParagraphs(lines: PdfLine[]) {
  const nonEmptyLines = lines.filter((line) => line.text.trim());
  if (!nonEmptyLines.length) return [];

  const gaps = nonEmptyLines
    .slice(1)
    .map((line, index) => {
      const previousY = nonEmptyLines[index].y;
      if (previousY === null || line.y === null) return null;
      return Math.abs(previousY - line.y);
    })
    .filter((gap): gap is number => gap !== null && gap > 0.5)
    .sort((a, b) => a - b);
  const medianGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
  const paragraphGap = medianGap ? Math.max(12, medianGap * 1.75) : null;
  const paragraphs: string[] = [];
  let current = nonEmptyLines[0].text;

  for (let index = 1; index < nonEmptyLines.length; index += 1) {
    const previous = nonEmptyLines[index - 1];
    const line = nonEmptyLines[index];
    const gap =
      previous.y === null || line.y === null ? null : Math.abs(previous.y - line.y);
    const startsNewParagraph = paragraphGap !== null && gap !== null && gap > paragraphGap;

    if (startsNewParagraph) {
      paragraphs.push(normalizePdfText(current));
      current = line.text;
    } else {
      current = appendPdfInlineText(current, line.text);
    }
  }

  paragraphs.push(normalizePdfText(current));
  return paragraphs.filter(Boolean);
}

function pushPdfLine(lines: PdfLine[], text: string, y: number | null) {
  const normalized = normalizePdfText(text);
  if (normalized) {
    lines.push({ text: normalized, y });
  }
}

function appendPdfInlineText(current: string, next: string) {
  if (!current) return next;
  if (/[\s([{（《“‘]$/.test(current) || /^[,.;:!?，。；：！？、)\]}）】》”’]/.test(next)) {
    return `${current}${next}`;
  }
  return `${current} ${next}`;
}

function normalizePdfText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function getPdfItemY(item: PdfTextItemLike) {
  if (!Array.isArray(item.transform)) return null;
  const y = item.transform[5];
  return typeof y === "number" && Number.isFinite(y) ? y : null;
}

async function indexPdfStructure(
  activeFile: PreviewFile,
  blocks: PdfPageBlock[],
  lastIndexSignatureRef: MutableRefObject<string>,
) {
  const searchableBlocks = blocks.filter((block) => block.text.trim() || block.paragraphs.some((paragraph) => paragraph.trim()));
  if (!searchableBlocks.length) return;

  const signature = JSON.stringify(searchableBlocks);
  if (signature === lastIndexSignatureRef.current) return;

  const request: DocumentIndexRequest = {
    document_id: getDocumentIndexId(activeFile),
    filename: activeFile.filename,
    path: activeFile.diskPath,
    original_path: activeFile.diskPath,
    stored_path: activeFile.diskPath,
    extension: "pdf",
    file_type: "pdf",
    size_bytes: activeFile.file.size,
    parse_status: "parsed",
    index_status: "indexed",
    blocks: searchableBlocks,
  };

  await invoke<DocumentIndexResult>("index_document_structure", { request });
  lastIndexSignatureRef.current = signature;
}

function getDocumentIndexId(activeFile: PreviewFile) {
  return activeFile.diskPath ? `path:${normalizeFilePath(activeFile.diskPath).toLowerCase()}` : activeFile.id;
}

function parseSearchMetadata(metadataJson: string | undefined) {
  if (!metadataJson) return null;

  try {
    return JSON.parse(metadataJson) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getNumberField(metadata: Record<string, unknown> | null, key: string) {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parsePageNumber(title: string | null | undefined) {
  const match = title?.match(/page\s+(\d+)/i);
  if (!match) return null;

  const pageNumber = Number.parseInt(match[1], 10);
  return Number.isFinite(pageNumber) ? pageNumber : null;
}
