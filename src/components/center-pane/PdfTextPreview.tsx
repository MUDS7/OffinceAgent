import { RefreshCw, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import type { PDFPageProxy, RenderTask } from "pdfjs-dist";
import { createPdfTextSelectionGuard, publishPdfSelection } from "./pdfSelection";
import type { DocumentSelectionContext, PreviewFile } from "./types";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type PdfTextPreviewProps = {
  activeFile: PreviewFile;
  onSelectionContextChange: (context: DocumentSelectionContext | null) => void;
};

export function PdfTextPreview({ activeFile, onSelectionContextChange }: PdfTextPreviewProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const pagesRef = useRef<HTMLDivElement | null>(null);
  const selectionOverlayRef = useRef<HTMLDivElement | null>(null);
  const lastPublishedSelectionRef = useRef("");
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
  }, [file, id, onSelectionContextChange]);

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

    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
    };
  }, [activeFile, file, filename, id, onSelectionContextChange]);

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
