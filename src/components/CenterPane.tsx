import {
  Atom,
  Bot,
  Braces,
  Code2,
  Copy,
  FileText,
  Hash,
  Info,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  SplitSquareVertical,
  X,
  XCircle,
} from "lucide-react";

type PreviewTab = {
  id: string;
  filename: string;
  isActive: boolean;
};

type CenterPaneProps = {
  activeFilename: string;
  editorLines: string[];
  editorText: string;
  errorMessage: string;
  isChecking: boolean;
  previewTabs: PreviewTab[];
  onClosePreviewTab: (fileId: string) => void;
  onRefreshStatus: () => void;
  onSelectPreviewTab: (fileId: string) => void;
};

export function CenterPane({
  activeFilename,
  editorLines,
  editorText,
  errorMessage,
  isChecking,
  previewTabs,
  onClosePreviewTab,
  onRefreshStatus,
  onSelectPreviewTab,
}: CenterPaneProps) {
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

      <div className="editor-content">
        <div className="editor-scroll">
          <div className="line-numbers" aria-hidden="true">
            {editorLines.map((_, index) => (
              <span key={index}>{index + 1}</span>
            ))}
          </div>
          <pre>{editorText}</pre>
          <div className="minimap" aria-hidden="true">
            {editorLines.slice(0, 48).map((line, index) => (
              <span key={index} style={{ width: `${Math.max(12, Math.min(96, line.length * 1.8))}%` }} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function EditorTabIcon({ filename }: { filename: string }) {
  const extension = filename.split(".").pop()?.toLowerCase();

  if (extension === "css") return <Hash className="css-tab-icon" size={16} />;
  if (extension === "tsx" || extension === "jsx") return <Atom className="react-tab-icon" size={16} />;
  if (extension === "json") return <Braces className="json-tab-icon" size={16} />;
  if (extension === "ts" || extension === "js" || extension === "html") return <Code2 className="code-tab-icon" size={16} />;

  return <FileText className="file-tab-icon" size={16} />;
}
