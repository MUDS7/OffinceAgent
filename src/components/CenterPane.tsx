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
import { useEffect, useMemo, useState } from "react";

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

type CenterPaneProps = {
  activeFilename: string;
  activeFile: PreviewFile | null;
  errorMessage: string;
  isChecking: boolean;
  previewTabs: PreviewTab[];
  onClosePreviewTab: (fileId: string) => void;
  onRefreshStatus: () => void;
  onSelectPreviewTab: (fileId: string) => void;
};

export function CenterPane({
  activeFilename,
  activeFile,
  errorMessage,
  isChecking,
  previewTabs,
  onClosePreviewTab,
  onRefreshStatus,
  onSelectPreviewTab,
}: CenterPaneProps) {
  const [textPreview, setTextPreview] = useState({
    fileId: "",
    isLoading: false,
    text: "",
    error: "",
  });
  const [pdfUrl, setPdfUrl] = useState("");
  const activeExtension = getFileExtension(activeFile?.filename ?? "");
  const isTextPreview = activeExtension === "txt";
  const isPdfPreview = activeExtension === "pdf";
  const textLines = useMemo(
    () => (textPreview.text ? textPreview.text.split(/\r?\n/) : [""]),
    [textPreview.text],
  );

  useEffect(() => {
    if (!activeFile || !isTextPreview) {
      setTextPreview({ fileId: "", isLoading: false, text: "", error: "" });
      return;
    }

    let isCancelled = false;
    setTextPreview({ fileId: activeFile.id, isLoading: true, text: "", error: "" });

    activeFile.file
      .text()
      .then((text) => {
        if (isCancelled) return;
        setTextPreview({ fileId: activeFile.id, isLoading: false, text, error: "" });
      })
      .catch((error) => {
        if (isCancelled) return;
        setTextPreview({
          fileId: activeFile.id,
          isLoading: false,
          text: "",
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      isCancelled = true;
    };
  }, [activeFile, isTextPreview]);

  useEffect(() => {
    if (!activeFile || !isPdfPreview) {
      setPdfUrl("");
      return;
    }

    const nextPdfUrl = URL.createObjectURL(activeFile.file);
    setPdfUrl(nextPdfUrl);

    return () => {
      URL.revokeObjectURL(nextPdfUrl);
    };
  }, [activeFile, isPdfPreview]);

  return (
    <section className="preview-pane" aria-label="文件预览">
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
          <div className="editor-scroll">
            <div className="line-numbers" aria-hidden="true">
              {textLines.map((_, index) => (
                <span key={index}>{index + 1}</span>
              ))}
            </div>
            <pre>{textPreview.text}</pre>
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
      return (
        <div className="editor-content pdf-preview">
          {pdfUrl ? (
            <iframe className="pdf-preview-frame" src={pdfUrl} title={`${activeFile.filename} 预览`} />
          ) : (
            <div className="preview-empty">
              <RefreshCw className="spin" size={26} />
              <span>正在打开 PDF...</span>
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="editor-content preview-empty">
        <FileWarning size={30} />
        <span>暂不支持预览 {activeExtension || "该类型"} 文件</span>
      </div>
    );
  }
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
