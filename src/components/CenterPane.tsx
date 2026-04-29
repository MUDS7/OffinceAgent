import {
  Bot,
  ChevronRight,
  Code2,
  Copy,
  FileText,
  Info,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  SplitSquareVertical,
  X,
  XCircle,
} from "lucide-react";

type AnalyzeResult = {
  filename: string;
  extension: string;
  size_bytes: number;
  sha256: string;
  text_preview: string;
  warnings: string[];
};

type WorkspaceFile = {
  id: string;
  file: File;
  analysis: AnalyzeResult | null;
};

type CenterPaneProps = {
  activeFilename: string;
  canAnalyze: boolean;
  editorLines: string[];
  editorText: string;
  errorMessage: string;
  isAnalyzing: boolean;
  isChecking: boolean;
  selectedAnalysis: AnalyzeResult | null;
  selectedWorkspaceFile: WorkspaceFile | null;
  onAnalyzeDocument: () => void;
  onRefreshStatus: () => void;
};

export function CenterPane({
  activeFilename,
  canAnalyze,
  editorLines,
  editorText,
  errorMessage,
  isAnalyzing,
  isChecking,
  selectedAnalysis,
  selectedWorkspaceFile,
  onAnalyzeDocument,
  onRefreshStatus,
}: CenterPaneProps) {
  return (
    <section className="preview-pane" aria-label="文件预览">
      <div className="editor-action-strip">
        <div className="editor-tabs">
          <div className="editor-tab active">
            <Info size={15} />
            <span>{activeFilename}</span>
            <X size={15} />
          </div>
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

      <div className="breadcrumbs">
        <Info size={15} />
        <span>{activeFilename}</span>
        {selectedAnalysis ? (
          <>
            <ChevronRight size={14} />
            <span>{selectedAnalysis.extension.toUpperCase()}</span>
          </>
        ) : null}
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

      <div className="editor-bottom">
        <button className="tool-text-button" type="button" onClick={onAnalyzeDocument} disabled={!canAnalyze}>
          {isAnalyzing ? <Loader2 className="spin" size={16} /> : <FileText size={16} />}
          解析预览
        </button>
        {selectedAnalysis ? (
          <span>
            {selectedAnalysis.extension.toUpperCase()} · {formatBytes(selectedAnalysis.size_bytes)}
          </span>
        ) : (
          <span>{selectedWorkspaceFile ? "未解析" : "空白"}</span>
        )}
      </div>
    </section>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
