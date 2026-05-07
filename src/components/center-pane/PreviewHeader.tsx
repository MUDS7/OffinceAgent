import {
  Bot,
  Code2,
  Copy,
  Info,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  Save,
  SplitSquareVertical,
  X,
} from "lucide-react";
import { EditorTabIcon } from "./filePreviewUtils";
import type { PreviewTab } from "./types";

type PreviewHeaderProps = {
  activeFileId?: string;
  activeFilename: string;
  isChecking: boolean;
  previewTabs: PreviewTab[];
  onClosePreviewTab: (fileId: string) => void;
  onRefreshStatus: () => void;
  onSaveActiveFile: (fileId: string) => void;
  onSelectPreviewTab: (fileId: string) => void;
};

export function PreviewHeader({
  activeFileId,
  activeFilename,
  isChecking,
  previewTabs,
  onClosePreviewTab,
  onRefreshStatus,
  onSaveActiveFile,
  onSelectPreviewTab,
}: PreviewHeaderProps) {
  return (
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
              {tab.isDirty && (
                <span className="editor-tab-dirty-dot" aria-hidden="true" />
              )}
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
        <button
          className="editor-action-button"
          type="button"
          title="保存"
          disabled={!activeFileId}
          onClick={() => {
            if (activeFileId) onSaveActiveFile(activeFileId);
          }}
        >
          <Save size={18} />
        </button>
        <Copy size={19} />
        <RotateCcw size={19} />
        <RefreshCw className={isChecking ? "spin" : ""} size={19} onClick={onRefreshStatus} />
        <Code2 size={19} />
        <SplitSquareVertical size={19} />
        <MoreHorizontal size={19} />
      </div>
    </div>
  );
}
