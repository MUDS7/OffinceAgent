import {
  Atom,
  Bot,
  Braces,
  Code2,
  Copy,
  FileText,
  FileWarning,
  Hash,
  Info,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  SplitSquareVertical,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject, PointerEvent } from "react";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import type { PDFPageProxy, RenderTask } from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type PreviewTab = {
  id: string;
  filename: string;
  isActive: boolean;
};

type PreviewFile = {
  id: string;
  filename: string;
  file: File;
};

type DocumentSelectionContext = {
  fileId: string;
  filename: string;
  sourceType: "pdf" | "text";
  text: string;
};

type CenterPaneProps = {
  activeFilename: string;
  activeFile: PreviewFile | null;
  errorMessage: string;
  isChecking: boolean;
  previewTabs: PreviewTab[];
  onClosePreviewTab: (fileId: string) => void;
  onRefreshStatus: () => void;
  onSelectionContextChange: (context: DocumentSelectionContext | null) => void;
  onSelectPreviewTab: (fileId: string) => void;
  onUpdateTextFile: (fileId: string, text: string) => void;
};

export function CenterPane({
  activeFilename,
  activeFile,
  errorMessage,
  isChecking,
  previewTabs,
  onClosePreviewTab,
  onRefreshStatus,
  onSelectionContextChange,
  onSelectPreviewTab,
  onUpdateTextFile,
}: CenterPaneProps) {
  const textEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const lastTextSelectionRef = useRef("");
  const [textPreview, setTextPreview] = useState({
    fileId: "",
    isLoading: false,
    text: "",
    error: "",
  });
  const [textScrollTop, setTextScrollTop] = useState(0);
  const activeFileId = activeFile?.id ?? "";
  const activeExtension = getFileExtension(activeFile?.filename ?? "");
  const isTextPreview = isEditableTextFile(activeFile?.file, activeExtension);
  const isPdfPreview = activeExtension === "pdf";
  const textLines = useMemo(
    () => (textPreview.text ? textPreview.text.split(/\r?\n/) : [""]),
    [textPreview.text],
  );

  useEffect(() => {
    const fileToRead = activeFile;

    if (!fileToRead || !isTextPreview) {
      setTextPreview({ fileId: "", isLoading: false, text: "", error: "" });
      return;
    }

    let isCancelled = false;
    setTextScrollTop(0);
    setTextPreview({ fileId: fileToRead.id, isLoading: true, text: "", error: "" });

    fileToRead.file
      .text()
      .then((text) => {
        if (isCancelled) return;
        setTextPreview({ fileId: fileToRead.id, isLoading: false, text, error: "" });
      })
      .catch((error) => {
        if (isCancelled) return;
        setTextPreview({
          fileId: fileToRead.id,
          isLoading: false,
          text: "",
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      isCancelled = true;
    };
  }, [activeFileId, isTextPreview]);

  useEffect(() => {
    lastTextSelectionRef.current = "";
    onSelectionContextChange(null);
  }, [activeFileId, onSelectionContextChange]);

  useEffect(() => {
    if (!isTextPreview || textPreview.isLoading || textPreview.error) return;
    textEditorRef.current?.focus();
  }, [activeFileId, isTextPreview, textPreview.error, textPreview.isLoading]);

  return (
    <section className="preview-pane" aria-label="文件预览" onPointerDown={handlePreviewPanePointerDown}>
      <div className="editor-action-strip">
        <div className="editor-tabs" role="tablist" aria-label="已打开文件">
          {previewTabs.length ? (
            previewTabs.map((tab) => (
              <div
                key={tab.id}
                className={tab.isActive ? "editor-tab active" : "editor-tab"}
                role="tab"
                tabIndex={0}
                aria-selected={tab.isActive}
                onClick={() => onSelectPreviewTab(tab.id)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  onSelectPreviewTab(tab.id);
                }}
              >
                <EditorTabIcon filename={tab.filename} />
                <span>{tab.filename}</span>
                <button
                  className="editor-tab-close"
                  type="button"
                  aria-label={`关闭 ${tab.filename}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onClosePreviewTab(tab.id);
                  }}
                >
                  <X size={15} />
                </button>
              </div>
            ))
          ) : (
            <div className="editor-tab active placeholder-tab">
              <Info size={15} />
              <span>{activeFilename}</span>
            </div>
          )}
        </div>
        <div className="editor-actions">
          <Bot size={20} />
          <Copy size={19} />
          <RotateCcw size={19} />
          <RefreshCw className={isChecking ? "spin" : ""} size={19} onClick={onRefreshStatus} />
          <Code2 size={19} />
          <SplitSquareVertical size={19} />
          <MoreHorizontal size={19} />
        </div>
      </div>

      {errorMessage ? (
        <div className="error-line" role="alert">
          <XCircle size={16} />
          {errorMessage}
        </div>
      ) : null}

      {renderPreviewContent()}
    </section>
  );

  function renderPreviewContent() {
    if (!activeFile) {
      return (
        <div className="editor-content preview-empty">
          <Info size={28} />
          <span>选择一个 txt 或 pdf 文件进行预览</span>
        </div>
      );
    }

    if (isTextPreview) {
      if (textPreview.isLoading && textPreview.fileId === activeFile.id) {
        return (
          <div className="editor-content preview-empty">
            <RefreshCw className="spin" size={26} />
            <span>正在读取文本...</span>
          </div>
        );
      }

      if (textPreview.error) {
        return (
          <div className="editor-content preview-empty">
            <XCircle size={28} />
            <span>{textPreview.error}</span>
          </div>
        );
      }

      return (
        <div className="editor-content">
          <div className="text-editor-layout">
            <div className="line-number-gutter" aria-hidden="true">
              <div className="line-numbers" style={{ transform: `translateY(${-textScrollTop}px)` }}>
                {textLines.map((_, index) => (
                  <span key={index}>{index + 1}</span>
                ))}
              </div>
            </div>
            <textarea
              ref={textEditorRef}
              className="preview-text-editor"
              aria-label={`${activeFile.filename} text editor`}
              spellCheck={false}
              value={textPreview.text}
              onChange={(event) => updateTextPreview(event.target.value)}
              onKeyUp={(event) => publishTextSelection(event.currentTarget, true)}
              onMouseUp={(event) => publishTextSelection(event.currentTarget, true)}
              onScroll={(event) => setTextScrollTop(event.currentTarget.scrollTop)}
              onSelect={(event) => publishTextSelection(event.currentTarget, false)}
            />
            <div className="minimap" aria-hidden="true">
              {textLines.slice(0, 48).map((line, index) => (
                <span key={index} style={{ width: `${Math.max(12, Math.min(96, line.length * 1.8))}%` }} />
              ))}
            </div>
          </div>
        </div>
      );
    }

    if (isPdfPreview) {
      return <PdfTextPreview activeFile={activeFile} onSelectionContextChange={onSelectionContextChange} />;
    }

    return (
      <div className="editor-content preview-empty">
        <FileWarning size={30} />
        <span>暂不支持预览 {activeExtension || "该类型"} 文件</span>
      </div>
    );
  }

  function updateTextPreview(nextText: string) {
    if (!activeFile) return;

    setTextPreview((current) => ({
      ...current,
      fileId: activeFile.id,
      isLoading: false,
      text: nextText,
      error: "",
    }));
    onUpdateTextFile(activeFile.id, nextText);
  }

  function handlePreviewPanePointerDown(event: PointerEvent<HTMLElement>) {
    const target = event.target;

    if (!(target instanceof Element)) return;
    if (target.closest(".preview-text-editor, .pdf-viewer-shell")) return;

    lastTextSelectionRef.current = "";
    onSelectionContextChange(null);
  }

  function publishTextSelection(textarea: HTMLTextAreaElement | null, clearWhenEmpty: boolean) {
    if (!activeFile || !textarea) return;

    const selectedText = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd).trim();
    if (!selectedText) {
      if (clearWhenEmpty && lastTextSelectionRef.current) {
        lastTextSelectionRef.current = "";
        onSelectionContextChange(null);
      }
      return;
    }

    lastTextSelectionRef.current = selectedText;
    onSelectionContextChange({
      fileId: activeFile.id,
      filename: activeFile.filename,
      sourceType: "text",
      text: selectedText,
    });
  }
}

type PdfTextPreviewProps = {
  activeFile: PreviewFile;
  onSelectionContextChange: (context: DocumentSelectionContext | null) => void;
};

function PdfTextPreview({ activeFile, onSelectionContextChange }: PdfTextPreviewProps) {
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
  }, [file, filename, id, onSelectionContextChange]);

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

function publishPdfSelection(
  shellElement: HTMLDivElement | null,
  selectionOverlayElement: HTMLDivElement | null,
  activeFile: PreviewFile,
  onSelectionContextChange: (context: DocumentSelectionContext | null) => void,
  lastPublishedSelectionRef: MutableRefObject<string>,
) {
  if (!shellElement) return;

  const selection = window.getSelection();
  const selectedText = selection?.toString().trim() ?? "";

  if (!selection || selection.rangeCount === 0 || !selectedText) {
    return;
  }

  const range = selection.getRangeAt(0);
  const selectionBelongsToPdf =
    isPdfTextLayerNode(selection.anchorNode, shellElement) && isPdfTextLayerNode(selection.focusNode, shellElement);

  if (!selectionBelongsToPdf) return;

  lastPublishedSelectionRef.current = selectedText;
  paintPdfSelectionOverlay(shellElement, selectionOverlayElement, range);
  onSelectionContextChange({
    fileId: activeFile.id,
    filename: activeFile.filename,
    sourceType: "pdf",
    text: selectedText,
  });
}

function paintPdfSelectionOverlay(
  shellElement: HTMLDivElement,
  selectionOverlayElement: HTMLDivElement | null,
  range: Range,
) {
  if (!selectionOverlayElement) return;

  selectionOverlayElement.replaceChildren();

  const shellRect = shellElement.getBoundingClientRect();
  const coordinateScaleX = shellElement.offsetWidth > 0 ? shellRect.width / shellElement.offsetWidth : 1;
  const coordinateScaleY = shellElement.offsetHeight > 0 ? shellRect.height / shellElement.offsetHeight : 1;
  const scaleX = Number.isFinite(coordinateScaleX) && coordinateScaleX > 0 ? coordinateScaleX : 1;
  const scaleY = Number.isFinite(coordinateScaleY) && coordinateScaleY > 0 ? coordinateScaleY : 1;
  const markers = Array.from(range.getClientRects())
    .filter((rect) => rect.width > 0 && rect.height > 0 && rectIntersectsElement(rect, shellRect))
    .map((rect) => {
      const marker = document.createElement("span");

      marker.className = "pdf-selection-marker";
      marker.style.left = `${(rect.left - shellRect.left) / scaleX + shellElement.scrollLeft}px`;
      marker.style.top = `${(rect.top - shellRect.top) / scaleY + shellElement.scrollTop}px`;
      marker.style.width = `${rect.width / scaleX}px`;
      marker.style.height = `${rect.height / scaleY}px`;

      return marker;
    });

  selectionOverlayElement.append(...markers);
}

function createPdfTextSelectionGuard() {
  const textLayers = new Map<HTMLDivElement, HTMLDivElement>();
  const abortController = new AbortController();
  let isPointerDown = false;
  let previousRange: Range | null = null;

  function reset(endElement: HTMLDivElement, textLayerElement: HTMLDivElement) {
    textLayerElement.append(endElement);
    endElement.style.width = "";
    endElement.style.height = "";
    endElement.style.userSelect = "";
    textLayerElement.classList.remove("selecting");
  }

  document.addEventListener(
    "pointerdown",
    () => {
      isPointerDown = true;
    },
    { signal: abortController.signal },
  );
  document.addEventListener(
    "pointerup",
    () => {
      isPointerDown = false;
      textLayers.forEach(reset);
    },
    { signal: abortController.signal },
  );
  window.addEventListener(
    "blur",
    () => {
      isPointerDown = false;
      textLayers.forEach(reset);
    },
    { signal: abortController.signal },
  );
  document.addEventListener(
    "keyup",
    () => {
      if (!isPointerDown) {
        textLayers.forEach(reset);
      }
    },
    { signal: abortController.signal },
  );
  document.addEventListener(
    "selectionchange",
    () => {
      const selection = document.getSelection();

      if (!selection || selection.rangeCount === 0) {
        textLayers.forEach(reset);
        previousRange = null;
        return;
      }

      const activeTextLayers = new Set<HTMLDivElement>();

      for (let index = 0; index < selection.rangeCount; index += 1) {
        const range = selection.getRangeAt(index);

        for (const textLayerElement of textLayers.keys()) {
          if (!activeTextLayers.has(textLayerElement) && range.intersectsNode(textLayerElement)) {
            activeTextLayers.add(textLayerElement);
          }
        }
      }

      for (const [textLayerElement, endElement] of textLayers) {
        if (activeTextLayers.has(textLayerElement)) {
          textLayerElement.classList.add("selecting");
        } else {
          reset(endElement, textLayerElement);
        }
      }

      moveEndOfContent(selection, textLayers, previousRange);
      previousRange = selection.getRangeAt(0).cloneRange();
    },
    { signal: abortController.signal },
  );

  return {
    register(textLayerElement: HTMLDivElement) {
      const endElement = document.createElement("div");

      endElement.className = "endOfContent";
      textLayerElement.append(endElement);
      textLayerElement.addEventListener("mousedown", () => textLayerElement.classList.add("selecting"), {
        signal: abortController.signal,
      });
      textLayers.set(textLayerElement, endElement);
    },
    destroy() {
      abortController.abort();
      textLayers.clear();
    },
  };
}

function moveEndOfContent(
  selection: Selection,
  textLayers: Map<HTMLDivElement, HTMLDivElement>,
  previousRange: Range | null,
) {
  if (selection.rangeCount === 0 || textLayers.size === 0) return;

  const range = selection.getRangeAt(0);
  const modifiesStart =
    previousRange !== null &&
    (range.compareBoundaryPoints(Range.END_TO_END, previousRange) === 0 ||
      range.compareBoundaryPoints(Range.START_TO_END, previousRange) === 0);
  const anchor = normalizePdfSelectionAnchor(modifiesStart ? range.startContainer : range.endContainer, range, modifiesStart);

  if (!anchor) return;

  const closestTextLayer = anchor.parentElement?.closest(".pdf-text-layer");
  const parentTextLayer = closestTextLayer instanceof HTMLDivElement ? closestTextLayer : null;
  const endElement = parentTextLayer ? textLayers.get(parentTextLayer) : undefined;

  if (!endElement || !parentTextLayer) return;

  endElement.style.width = parentTextLayer.style.width;
  endElement.style.height = parentTextLayer.style.height;
  endElement.style.userSelect = "text";
  anchor.parentElement?.insertBefore(endElement, modifiesStart ? anchor : anchor.nextSibling);
}

function normalizePdfSelectionAnchor(node: Node, range: Range, modifiesStart: boolean) {
  let anchor: Node | null = node.nodeType === Node.TEXT_NODE ? node.parentNode : node;

  if (!(anchor instanceof Element)) return null;

  if (anchor.classList.contains("highlight")) {
    anchor = anchor.parentNode;
  }

  if (!modifiesStart && range.endOffset === 0) {
    while (anchor && !anchor.previousSibling) {
      anchor = anchor.parentNode;
      if (anchor instanceof Element && anchor.classList.contains("pdf-text-layer")) return null;
    }

    anchor = anchor?.previousSibling ?? null;

    while (anchor?.lastChild) {
      anchor = anchor.lastChild;
    }
  }

  return anchor instanceof Element ? anchor : anchor?.parentElement ?? null;
}

function isPdfTextLayerNode(node: Node | null, shellElement: HTMLElement) {
  if (!node) return false;

  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;

  return element instanceof Element && shellElement.contains(element) && Boolean(element.closest(".pdf-text-layer"));
}

function rectIntersectsElement(rect: DOMRect, elementRect: DOMRect) {
  return (
    rect.right >= elementRect.left &&
    rect.left <= elementRect.right &&
    rect.bottom >= elementRect.top &&
    rect.top <= elementRect.bottom
  );
}

function isPdfRenderCancelled(error: unknown) {
  return error instanceof Error && error.name === "RenderingCancelledException";
}

function EditorTabIcon({ filename }: { filename: string }) {
  const extension = getFileExtension(filename);

  if (extension === "css") return <Hash className="css-tab-icon" size={16} />;
  if (extension === "tsx" || extension === "jsx") return <Atom className="react-tab-icon" size={16} />;
  if (extension === "json") return <Braces className="json-tab-icon" size={16} />;
  if (extension === "ts" || extension === "js" || extension === "html") return <Code2 className="code-tab-icon" size={16} />;

  return <FileText className="file-tab-icon" size={16} />;
}

function getFileExtension(filename: string) {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

function isEditableTextFile(file: File | undefined, extension: string) {
  if (file?.type.startsWith("text/")) return true;

  return ["txt", "md", "csv", "json", "js", "jsx", "ts", "tsx", "html", "css", "xml", "yaml", "yml"].includes(
    extension,
  );
}
