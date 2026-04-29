import type { MutableRefObject } from "react";
import type { DocumentSelectionContext, PreviewFile } from "./types";

export function publishPdfSelection(
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

export function paintPdfSelectionOverlay(
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

export function createPdfTextSelectionGuard() {
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
