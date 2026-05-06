import { RefreshCw, XCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
  const activeFileId = activeFile.id;
  const textLines = useMemo(
    () => (textPreview.text ? textPreview.text.split(/\r?\n/) : [""]),
    [textPreview.text],
  );

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
    onSelectionContextChange(null);
  }, [activeFileId, onSelectionContextChange]);

  useEffect(() => {
    if (textPreview.isLoading || textPreview.error) return;
    textEditorRef.current?.focus();
  }, [activeFileId, textPreview.error, textPreview.isLoading]);

  useEffect(() => {
    if (!pendingAgentTextEdit || pendingAgentTextEdit.fileId !== activeFile.id) return;
    if (lastAppliedAgentEditIdRef.current === pendingAgentTextEdit.id) return;
    if (textPreview.isLoading || textPreview.error) return;

    lastAppliedAgentEditIdRef.current = pendingAgentTextEdit.id;
    const appliedEdit = applyAgentTextEdit(textPreview.text, pendingAgentTextEdit);
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
        <div className="line-number-gutter" aria-hidden="true">
          <div className="line-numbers" style={{ transform: `translateY(${-textScroll.top}px)` }}>
            {textLines.map((_, index) => (
              <span key={index}>{index + 1}</span>
            ))}
          </div>
        </div>
        <div className={isTextEditorFocused ? "text-editor-stack focused" : "text-editor-stack"}>
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
            className="preview-text-editor"
            aria-label={`${activeFile.filename} text editor`}
            spellCheck={false}
            value={textPreview.text}
            onBlur={() => setIsTextEditorFocused(false)}
            onChange={(event) => updateTextPreview(event.target.value)}
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
    const normalizedText = normalizeEditorLineEndings(nextText);

    clearTextSelectionHighlight();

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

  function publishTextSelection(textarea: HTMLTextAreaElement | null) {
    if (!textarea) return;

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

    const start = clampTextOffset(textSelectionHighlight.start, textPreview.text.length);
    const end = clampTextOffset(Math.max(textSelectionHighlight.end, start), textPreview.text.length);

    return (
      <>
        {textPreview.text.slice(0, start)}
        <mark>{textPreview.text.slice(start, end)}</mark>
        {textPreview.text.slice(end) || " "}
      </>
    );
  }
}

function applyAgentTextEdit(text: string, edit: AgentTextEditResult) {
  const normalizedReplacementText = normalizeEditorLineEndings(edit.replacementText);

  if (edit.insertOnNextLine) {
    const insertionIndex = getNextLineInsertionIndex(text, edit.start);
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
