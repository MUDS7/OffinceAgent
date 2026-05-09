import { RefreshCw, XCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { getFileExtension } from "./filePreviewUtils";
import type { AgentTextEditResult, DocumentSelectionContext, PreviewFile } from "./types";

type TextFilePreviewProps = {
  activeFile: PreviewFile;
  pendingAgentTextEdit: AgentTextEditResult | null;
  unsavedText?: string;
  onAgentTextEditApplied: () => void;
  onSelectionContextChange: (context: DocumentSelectionContext | null) => void;
  onUpdateTextFile: (fileId: string, text: string) => void;
  onSaveTextFile: (fileId: string) => void;
};

type TextSelectionHighlight = {
  start: number;
  end: number;
  text: string;
};

type JsonSyntaxPart = {
  text: string;
  className?: string;
};

type JsonFoldRange = {
  id: string;
  openIndex: number;
  closeIndex: number;
  openLine: number;
  closeLine: number;
};

type JsonFoldControl = {
  rangeId: string;
  lineIndex: number;
  isCollapsed: boolean;
};

type JsonFoldPlaceholder = {
  rangeId: string;
  start: number;
  end: number;
};

const JSON_FOLD_PLACEHOLDER = "...";

export function TextFilePreview({
  activeFile,
  pendingAgentTextEdit,
  unsavedText,
  onAgentTextEditApplied,
  onSelectionContextChange,
  onUpdateTextFile,
  onSaveTextFile,
}: TextFilePreviewProps) {
  const textEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const lastTextSelectionRef = useRef("");
  const lastAppliedAgentEditIdRef = useRef("");
  const [textPreview, setTextPreview] = useState({
    fileId: "",
    isLoading: false,
    text: "",
    error: "",
  });
  const [textScroll, setTextScroll] = useState({ left: 0, top: 0 });
  const [textSelectionHighlight, setTextSelectionHighlight] = useState<TextSelectionHighlight | null>(null);
  const [isTextEditorFocused, setIsTextEditorFocused] = useState(false);
  const [collapsedJsonFoldIds, setCollapsedJsonFoldIds] = useState<Set<string>>(() => new Set());
  const activeFileId = activeFile.id;
  const isJsonPreview = getFileExtension(activeFile.filename) === "json";
  const jsonFoldRanges = useMemo(
    () => (isJsonPreview ? getJsonFoldRanges(textPreview.text) : []),
    [isJsonPreview, textPreview.text],
  );
  const activeCollapsedJsonFoldIds = useMemo(() => {
    const validRangeIds = new Set(jsonFoldRanges.map((range) => range.id));
    return new Set([...collapsedJsonFoldIds].filter((rangeId) => validRangeIds.has(rangeId)));
  }, [collapsedJsonFoldIds, jsonFoldRanges]);
  const jsonFoldView = useMemo(
    () => (isJsonPreview ? buildJsonFoldView(textPreview.text, jsonFoldRanges, activeCollapsedJsonFoldIds) : null),
    [activeCollapsedJsonFoldIds, isJsonPreview, jsonFoldRanges, textPreview.text],
  );
  const displayText = jsonFoldView?.text ?? textPreview.text;
  const textLines = useMemo(
    () => (displayText ? displayText.split(/\r?\n/) : [""]),
    [displayText],
  );
  const jsonSyntaxParts = useMemo(
    () => (isJsonPreview ? getJsonSyntaxParts(displayText) : []),
    [displayText, isJsonPreview],
  );
  const jsonFoldControlsByLine = useMemo(() => {
    const controlsByLine = new Map<number, JsonFoldControl>();

    for (const control of jsonFoldView?.foldControls ?? []) {
      controlsByLine.set(control.lineIndex, control);
    }

    return controlsByLine;
  }, [jsonFoldView]);
  const hasCollapsedJsonFolds = activeCollapsedJsonFoldIds.size > 0;

  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const initialUnsavedTextRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    initialUnsavedTextRef.current = unsavedText;
  }, [activeFileId]);

  useEffect(() => {
    const fileToRead = activeFile;
    let isCancelled = false;

    setTextScroll({ left: 0, top: 0 });
    setCollapsedJsonFoldIds(new Set());

    const initialUnsaved = initialUnsavedTextRef.current;
    if (initialUnsaved !== undefined) {
      const normalizedText = normalizeEditorLineEndings(initialUnsaved);
      setTextPreview({ fileId: fileToRead.id, isLoading: false, text: normalizedText, error: "" });
      setHistory([normalizedText]);
      setHistoryIndex(0);
      return;
    }

    setTextPreview({ fileId: fileToRead.id, isLoading: true, text: "", error: "" });

    fileToRead.file
      .text()
      .then((text) => {
        if (isCancelled) return;
        const normalizedText = normalizeEditorLineEndings(text);
        setTextPreview({ fileId: fileToRead.id, isLoading: false, text: normalizedText, error: "" });
        setHistory([normalizedText]);
        setHistoryIndex(0);
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
  }, [activeFileId]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        setHistory((currHistory) => {
          if (historyIndex > 0) {
            const prevIndex = historyIndex - 1;
            const prevText = currHistory[prevIndex];
            setHistoryIndex(prevIndex);
            setCollapsedJsonFoldIds(new Set());
            setTextPreview((current) => ({
              ...current,
              text: prevText,
            }));
            onUpdateTextFile(activeFile.id, prevText);
          }
          return currHistory;
        });
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        onSaveTextFile(activeFile.id);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [historyIndex, activeFile.id, onUpdateTextFile, onSaveTextFile]);

  useEffect(() => {
    lastTextSelectionRef.current = "";
    setTextSelectionHighlight(null);
    setCollapsedJsonFoldIds(new Set());
    onSelectionContextChange(null);
  }, [activeFileId, onSelectionContextChange]);

  useEffect(() => {
    if (textPreview.isLoading || textPreview.error) return;
    textEditorRef.current?.focus();
  }, [activeFileId, textPreview.error, textPreview.isLoading]);

  useEffect(() => {
    window.requestAnimationFrame(() => {
      const editor = textEditorRef.current;
      if (!editor) return;

      setTextScroll({
        left: editor.scrollLeft,
        top: editor.scrollTop,
      });
    });
  }, [displayText]);

  useEffect(() => {
    if (!pendingAgentTextEdit || pendingAgentTextEdit.fileId !== activeFile.id) return;
    if (lastAppliedAgentEditIdRef.current === pendingAgentTextEdit.id) return;
    if (textPreview.isLoading || textPreview.error) return;

    lastAppliedAgentEditIdRef.current = pendingAgentTextEdit.id;
    const appliedEdit = applyAgentTextEdit(textPreview.text, pendingAgentTextEdit);
    setCollapsedJsonFoldIds(new Set());
    setTextPreview((current) => ({
      ...current,
      fileId: activeFile.id,
      isLoading: false,
      text: appliedEdit.text,
      error: "",
    }));

    const nextIndex = historyIndex + 1;
    setHistory((current) => {
      const nextHistory = current.slice(0, nextIndex);
      return [...nextHistory, appliedEdit.text];
    });
    setHistoryIndex(nextIndex);
    onUpdateTextFile(activeFile.id, appliedEdit.text);
    setTextSelectionHighlight(null);
    onSelectionContextChange(null);
    onAgentTextEditApplied();

    window.requestAnimationFrame(() => {
      const editor = textEditorRef.current;
      if (!editor) return;

      editor.focus();
      editor.setSelectionRange(appliedEdit.cursorPosition, appliedEdit.cursorPosition);
    });
  }, [pendingAgentTextEdit?.id]);

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
      <div
        className="text-editor-layout"
        onPointerDown={(event) => {
          if (event.target instanceof Element && event.target.closest(".preview-text-editor")) return;
          clearTextSelectionHighlight();
        }}
      >
        <div className="line-number-gutter">
          <div className="line-numbers" style={{ transform: `translateY(${-textScroll.top}px)` }}>
            {textLines.map((_, index) => {
              const foldControl = jsonFoldControlsByLine.get(index);

              return (
                <span className="line-number-row" key={index}>
                  {foldControl ? (
                    <button
                      className={foldControl.isCollapsed ? "json-fold-toggle collapsed" : "json-fold-toggle"}
                      type="button"
                      aria-label={foldControl.isCollapsed ? "Expand JSON block" : "Collapse JSON block"}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleJsonFold(foldControl.rangeId);
                      }}
                      onMouseDown={(event) => event.preventDefault()}
                      onPointerDown={(event) => event.stopPropagation()}
                    >
                      <span className="json-fold-chevron" />
                    </button>
                  ) : (
                    <span className="json-fold-spacer" aria-hidden="true" />
                  )}
                  <span className="line-number-text" aria-hidden="true">
                    {index + 1}
                  </span>
                </span>
              );
            })}
          </div>
        </div>
        <div
          className={[
            "text-editor-stack",
            isTextEditorFocused ? "focused" : "",
            isJsonPreview ? "json-preview-stack" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {isJsonPreview ? (
            <pre
              className="json-syntax-overlay"
              aria-hidden="true"
              style={{ transform: `translate(${-textScroll.left}px, ${-textScroll.top}px)` }}
            >
              {renderJsonSyntaxHighlight()}
            </pre>
          ) : null}
          <div className="text-selection-overlay" aria-hidden="true">
            <pre
              className="text-selection-mirror"
              style={{ transform: `translate(${-textScroll.left}px, ${-textScroll.top}px)` }}
            >
              {renderTextSelectionHighlight()}
            </pre>
          </div>
          <textarea
            ref={textEditorRef}
            className={isJsonPreview ? "preview-text-editor json-text-editor" : "preview-text-editor"}
            aria-label={`${activeFile.filename} text editor`}
            readOnly={hasCollapsedJsonFolds}
            spellCheck={false}
            value={displayText}
            onBlur={() => setIsTextEditorFocused(false)}
            onChange={(event) => updateTextPreview(event.target.value)}
            onClick={(event) => expandJsonFoldFromPlaceholderClick(event.currentTarget)}
            onFocus={(event) => {
              setIsTextEditorFocused(true);
              publishTextSelection(event.currentTarget);
            }}
            onKeyUp={(event) => publishTextSelection(event.currentTarget)}
            onMouseUp={(event) => publishTextSelection(event.currentTarget)}
            onScroll={(event) =>
              setTextScroll({
                left: event.currentTarget.scrollLeft,
                top: event.currentTarget.scrollTop,
              })
            }
            onSelect={(event) => publishTextSelection(event.currentTarget)}
          />
        </div>
        <div className="minimap" aria-hidden="true">
          {textLines.slice(0, 48).map((line, index) => (
            <span key={index} style={{ width: `${Math.max(12, Math.min(96, line.length * 1.8))}%` }} />
          ))}
        </div>
      </div>
    </div>
  );

  function updateTextPreview(nextText: string) {
    if (hasCollapsedJsonFolds) return;

    const normalizedText = normalizeEditorLineEndings(nextText);

    clearTextSelectionHighlight();
    setCollapsedJsonFoldIds(new Set());

    setTextPreview((current) => ({
      ...current,
      fileId: activeFile.id,
      isLoading: false,
      text: normalizedText,
      error: "",
    }));

    const nextIndex = historyIndex + 1;
    setHistory((current) => {
      const nextHistory = current.slice(0, nextIndex);
      return [...nextHistory, normalizedText];
    });
    setHistoryIndex(nextIndex);

    onUpdateTextFile(activeFile.id, normalizedText);
  }

  function toggleJsonFold(rangeId: string) {
    clearTextSelectionHighlight();
    setCollapsedJsonFoldIds((current) => {
      const next = new Set(current);

      if (next.has(rangeId)) {
        next.delete(rangeId);
      } else {
        next.add(rangeId);
      }

      return next;
    });
  }

  function expandJsonFoldFromPlaceholderClick(textarea: HTMLTextAreaElement) {
    if (!hasCollapsedJsonFolds || !jsonFoldView) return;

    const cursorPosition = textarea.selectionStart;
    const placeholder = jsonFoldView.foldPlaceholders.find(
      (item) => item.start <= cursorPosition && cursorPosition <= item.end,
    );

    if (!placeholder) return;

    clearTextSelectionHighlight();
    setCollapsedJsonFoldIds((current) => {
      const next = new Set(current);
      next.delete(placeholder.rangeId);
      return next;
    });
  }

  function publishTextSelection(textarea: HTMLTextAreaElement | null) {
    if (!textarea) return;
    if (hasCollapsedJsonFolds) {
      lastTextSelectionRef.current = "";
      setTextSelectionHighlight(null);
      onSelectionContextChange(null);
      return;
    }

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selectedText = textarea.value.slice(start, end);
    if (!selectedText.trim()) {
      lastTextSelectionRef.current = "";
      setTextSelectionHighlight(null);
      onSelectionContextChange({
        fileId: activeFile.id,
        filePath: activeFile.diskPath ?? activeFile.filename,
        filename: activeFile.filename,
        sourceType: "text",
        start,
        end,
        text: "",
      });
      return;
    }

    lastTextSelectionRef.current = selectedText;
    setTextSelectionHighlight({ start, end, text: selectedText });
    onSelectionContextChange({
      fileId: activeFile.id,
      filePath: activeFile.diskPath ?? activeFile.filename,
      filename: activeFile.filename,
      sourceType: "text",
      start,
      end,
      text: selectedText,
    });
  }

  function clearTextSelectionHighlight() {
    lastTextSelectionRef.current = "";
    setTextSelectionHighlight(null);
    onSelectionContextChange(null);
  }

  function renderTextSelectionHighlight() {
    if (!textSelectionHighlight?.text.trim()) {
      return null;
    }

    const start = clampTextOffset(textSelectionHighlight.start, displayText.length);
    const end = clampTextOffset(Math.max(textSelectionHighlight.end, start), displayText.length);

    return (
      <>
        {displayText.slice(0, start)}
        <mark>{displayText.slice(start, end)}</mark>
        {displayText.slice(end) || " "}
      </>
    );
  }

  function renderJsonSyntaxHighlight() {
    if (!jsonSyntaxParts.length) return " ";

    return jsonSyntaxParts.map((part, index) =>
      part.className ? (
        <span className={part.className} key={index}>
          {part.text}
        </span>
      ) : (
        part.text
      ),
    );
  }
}

function getJsonFoldRanges(text: string): JsonFoldRange[] {
  const lineStarts = getLineStarts(text);
  const ranges: JsonFoldRange[] = [];
  const stack: Array<{ char: string; index: number; line: number }> = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (char === '"') {
      index = readJsonStringToken(text, index).end;
      continue;
    }

    if (char === "{" || char === "[") {
      stack.push({ char, index, line: getLineIndex(index, lineStarts) });
      index += 1;
      continue;
    }

    if (char === "}" || char === "]") {
      const matchingOpen = char === "}" ? "{" : "[";
      const matchingIndex = findLastMatchingOpenIndex(stack, matchingOpen);

      if (matchingIndex !== -1) {
        const open = stack.splice(matchingIndex, 1)[0];
        const closeLine = getLineIndex(index, lineStarts);

        if (closeLine > open.line) {
          ranges.push({
            id: `${open.index}:${index}`,
            openIndex: open.index,
            closeIndex: index,
            openLine: open.line,
            closeLine,
          });
        }
      }
    }

    index += 1;
  }

  return ranges.sort((left, right) => left.openIndex - right.openIndex || right.closeIndex - left.closeIndex);
}

function buildJsonFoldView(text: string, ranges: JsonFoldRange[], collapsedIds: Set<string>) {
  const collapsedRanges = getVisibleCollapsedJsonRanges(ranges, collapsedIds);
  const foldPlaceholders: JsonFoldPlaceholder[] = [];
  let foldedText = "";
  let lastIndex = 0;

  for (const range of collapsedRanges) {
    foldedText += text.slice(lastIndex, range.openIndex + 1);
    const placeholderStart = foldedText.length;
    foldedText += JSON_FOLD_PLACEHOLDER;
    foldPlaceholders.push({
      rangeId: range.id,
      start: placeholderStart,
      end: foldedText.length,
    });
    lastIndex = range.closeIndex;
  }

  foldedText += text.slice(lastIndex);

  const foldedLineStarts = getLineStarts(foldedText);
  const foldControls = ranges
    .filter((range) => !isRangeHiddenByCollapsedAncestor(range, collapsedRanges))
    .map((range) => ({
      rangeId: range.id,
      lineIndex: getLineIndex(mapOriginalOffsetToFoldedOffset(range.openIndex, collapsedRanges), foldedLineStarts),
      isCollapsed: collapsedIds.has(range.id),
    }));

  return {
    text: foldedText,
    foldControls,
    foldPlaceholders,
  };
}

function getVisibleCollapsedJsonRanges(ranges: JsonFoldRange[], collapsedIds: Set<string>) {
  const visibleRanges: JsonFoldRange[] = [];

  for (const range of ranges) {
    if (!collapsedIds.has(range.id)) continue;
    if (isRangeHiddenByCollapsedAncestor(range, visibleRanges)) continue;

    visibleRanges.push(range);
  }

  return visibleRanges;
}

function isRangeHiddenByCollapsedAncestor(range: JsonFoldRange, collapsedRanges: JsonFoldRange[]) {
  return collapsedRanges.some(
    (collapsedRange) =>
      collapsedRange.openIndex < range.openIndex && range.closeIndex <= collapsedRange.closeIndex,
  );
}

function mapOriginalOffsetToFoldedOffset(offset: number, collapsedRanges: JsonFoldRange[]) {
  let characterOffsetDelta = 0;

  for (const range of collapsedRanges) {
    if (offset <= range.openIndex) {
      break;
    }

    if (offset < range.closeIndex) {
      return range.openIndex + 1 + JSON_FOLD_PLACEHOLDER.length + characterOffsetDelta;
    }

    characterOffsetDelta += JSON_FOLD_PLACEHOLDER.length - (range.closeIndex - range.openIndex - 1);
  }

  return offset + characterOffsetDelta;
}

function getLineStarts(text: string) {
  const lineStarts = [0];

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      lineStarts.push(index + 1);
    }
  }

  return lineStarts;
}

function getLineIndex(offset: number, lineStarts: number[]) {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const lineStart = lineStarts[middle];
    const nextLineStart = lineStarts[middle + 1] ?? Number.POSITIVE_INFINITY;

    if (offset < lineStart) {
      high = middle - 1;
    } else if (offset >= nextLineStart) {
      low = middle + 1;
    } else {
      return middle;
    }
  }

  return Math.max(0, lineStarts.length - 1);
}

function findLastMatchingOpenIndex(stack: Array<{ char: string }>, matchingOpen: string) {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    if (stack[index].char === matchingOpen) {
      return index;
    }
  }

  return -1;
}

function getJsonSyntaxParts(text: string): JsonSyntaxPart[] {
  const parts: JsonSyntaxPart[] = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (/\s/.test(char)) {
      const start = index;
      index += 1;
      while (index < text.length && /\s/.test(text[index])) {
        index += 1;
      }
      parts.push({ text: text.slice(start, index) });
      continue;
    }

    if (char === '"') {
      const token = readJsonStringToken(text, index);
      const tokenText = text.slice(index, token.end);
      const className = isJsonKeyToken(text, token.end)
        ? `json-key json-key-${getJsonKeyColorIndex(tokenText)}`
        : "json-string";

      parts.push({ text: tokenText, className });
      index = token.end;
      continue;
    }

    if (text.startsWith(JSON_FOLD_PLACEHOLDER, index)) {
      parts.push({ text: JSON_FOLD_PLACEHOLDER, className: "json-fold-placeholder" });
      index += JSON_FOLD_PLACEHOLDER.length;
      continue;
    }

    const numberMatch = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (numberMatch) {
      parts.push({ text: numberMatch[0], className: "json-number" });
      index += numberMatch[0].length;
      continue;
    }

    if (text.startsWith("true", index) || text.startsWith("false", index)) {
      const literal = text.startsWith("true", index) ? "true" : "false";
      parts.push({ text: literal, className: "json-boolean" });
      index += literal.length;
      continue;
    }

    if (text.startsWith("null", index)) {
      parts.push({ text: "null", className: "json-null" });
      index += 4;
      continue;
    }

    if ("{}[],:".includes(char)) {
      parts.push({ text: char, className: "json-punctuation" });
      index += 1;
      continue;
    }

    parts.push({ text: char });
    index += 1;
  }

  return parts;
}

function readJsonStringToken(text: string, start: number) {
  let index = start + 1;
  let isEscaped = false;

  while (index < text.length) {
    const char = text[index];

    if (isEscaped) {
      isEscaped = false;
    } else if (char === "\\") {
      isEscaped = true;
    } else if (char === '"') {
      index += 1;
      break;
    }

    index += 1;
  }

  return { end: index };
}

function isJsonKeyToken(text: string, tokenEnd: number) {
  let index = tokenEnd;

  while (index < text.length && /\s/.test(text[index])) {
    index += 1;
  }

  return text[index] === ":";
}

function getJsonKeyColorIndex(keyToken: string) {
  let hash = 0;

  for (let index = 1; index < keyToken.length - 1; index += 1) {
    hash = (hash * 31 + keyToken.charCodeAt(index)) % 997;
  }

  return hash % 6;
}

function applyAgentTextEdit(text: string, edit: AgentTextEditResult) {
  const normalizedReplacementText = normalizeEditorLineEndings(edit.replacementText);

  if (edit.operation === "insert_after_selection") {
    const insertionIndex = getNextLineInsertionIndex(text, edit.end);
    const insertionText = formatNextLineInsertion(text, insertionIndex, normalizedReplacementText);
    const nextText = text.slice(0, insertionIndex) + insertionText + text.slice(insertionIndex);

    return {
      text: nextText,
      cursorPosition: insertionIndex + insertionText.length,
    };
  }

  const start = clampTextOffset(edit.start, text.length);
  const end = clampTextOffset(Math.max(edit.end, edit.start), text.length);
  const normalizedRange = getLineContentReplacementRange(text, start, end);
  const replacementText = trimReplacementLineBreakEdges(
    normalizedReplacementText,
    normalizedRange.preservedLeadingLineBreak,
    normalizedRange.preservedTrailingLineBreak,
  );
  const nextText = text.slice(0, normalizedRange.start) + replacementText + text.slice(normalizedRange.end);

  return {
    text: nextText,
    cursorPosition: normalizedRange.start + replacementText.length,
  };
}

function getLineContentReplacementRange(text: string, start: number, end: number) {
  let normalizedStart = start;
  let normalizedEnd = end;
  let preservedLeadingLineBreak = false;
  let preservedTrailingLineBreak = false;

  if (normalizedStart < normalizedEnd && text[normalizedStart] === "\n") {
    normalizedStart += 1;
    preservedLeadingLineBreak = true;
  }

  if (normalizedStart < normalizedEnd && text[normalizedEnd - 1] === "\n") {
    normalizedEnd -= 1;
    preservedTrailingLineBreak = true;
  }

  return {
    start: normalizedStart,
    end: normalizedEnd,
    preservedLeadingLineBreak,
    preservedTrailingLineBreak,
  };
}

function trimReplacementLineBreakEdges(
  replacementText: string,
  shouldTrimLeadingLineBreak: boolean,
  shouldTrimTrailingLineBreak: boolean,
) {
  let trimmedText = replacementText;

  if (shouldTrimLeadingLineBreak && trimmedText.startsWith("\n")) {
    trimmedText = trimmedText.slice(1);
  }

  if (shouldTrimTrailingLineBreak && trimmedText.endsWith("\n")) {
    trimmedText = trimmedText.slice(0, -1);
  }

  return trimmedText;
}

function getNextLineInsertionIndex(text: string, offset: number) {
  if (!text) return 0;

  const boundedOffset = clampTextOffset(offset, text.length);
  const nextLineBreak = text.indexOf("\n", boundedOffset);

  return nextLineBreak === -1 ? text.length : nextLineBreak + 1;
}

function formatNextLineInsertion(text: string, insertionIndex: number, replacementText: string) {
  const prefix = text.slice(0, insertionIndex);
  const suffix = text.slice(insertionIndex);
  const needsLeadingLineBreak = prefix.length > 0 && !prefix.endsWith("\n");
  const needsTrailingLineBreak = suffix.length > 0 && replacementText.length > 0 && !replacementText.endsWith("\n");

  return `${needsLeadingLineBreak ? "\n" : ""}${replacementText}${needsTrailingLineBreak ? "\n" : ""}`;
}

function clampTextOffset(offset: number, textLength: number) {
  if (!Number.isFinite(offset)) return 0;

  return Math.min(Math.max(Math.trunc(offset), 0), textLength);
}

function normalizeEditorLineEndings(text: string) {
  return text.replace(/\r\n?/g, "\n");
}
