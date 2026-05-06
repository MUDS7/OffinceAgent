import { RefreshCw, XCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DocumentSelectionContext, PreviewFile } from "./types";

type TextFilePreviewProps = {
  activeFile: PreviewFile;
  unsavedText?: string;
  onSelectionContextChange: (context: DocumentSelectionContext | null) => void;
  onUpdateTextFile: (fileId: string, text: string) => void;
  onSaveTextFile: (fileId: string) => void;
};

export function TextFilePreview({
  activeFile,
  unsavedText,
  onSelectionContextChange,
  onUpdateTextFile,
  onSaveTextFile,
}: TextFilePreviewProps) {
  const textEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const lastTextSelectionRef = useRef("");
  const [textPreview, setTextPreview] = useState({
    fileId: "",
    isLoading: false,
    text: "",
    error: "",
  });
  const [textScrollTop, setTextScrollTop] = useState(0);
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

    setTextScrollTop(0);

    const initialUnsaved = initialUnsavedTextRef.current;
    if (initialUnsaved !== undefined) {
      setTextPreview({ fileId: fileToRead.id, isLoading: false, text: initialUnsaved, error: "" });
      setHistory([initialUnsaved]);
      setHistoryIndex(0);
      return;
    }

    setTextPreview({ fileId: fileToRead.id, isLoading: true, text: "", error: "" });

    fileToRead.file
      .text()
      .then((text) => {
        if (isCancelled) return;
        setTextPreview({ fileId: fileToRead.id, isLoading: false, text, error: "" });
        setHistory([text]);
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
    onSelectionContextChange(null);
  }, [activeFileId, onSelectionContextChange]);

  useEffect(() => {
    if (textPreview.isLoading || textPreview.error) return;
    textEditorRef.current?.focus();
  }, [activeFileId, textPreview.error, textPreview.isLoading]);

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

  function updateTextPreview(nextText: string) {
    setTextPreview((current) => ({
      ...current,
      fileId: activeFile.id,
      isLoading: false,
      text: nextText,
      error: "",
    }));

    const nextIndex = historyIndex + 1;
    setHistory((current) => {
      const nextHistory = current.slice(0, nextIndex);
      return [...nextHistory, nextText];
    });
    setHistoryIndex(nextIndex);

    onUpdateTextFile(activeFile.id, nextText);
  }

  function publishTextSelection(textarea: HTMLTextAreaElement | null, clearWhenEmpty: boolean) {
    if (!textarea) return;

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
