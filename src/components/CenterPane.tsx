import { FileWarning, Info, XCircle } from "lucide-react";
import type { PointerEvent } from "react";
import { PreviewHeader } from "./center-pane/PreviewHeader";
import { DocxPreview } from "./center-pane/DocxPreview";
import { PdfTextPreview } from "./center-pane/PdfTextPreview";
import { SpreadsheetPreview } from "./center-pane/SpreadsheetPreview";
import { TextFilePreview } from "./center-pane/TextFilePreview";
import type { CenterPaneProps } from "./center-pane/types";
import { getFileExtension, isDocxExtension, isEditableTextFile, isSpreadsheetExtension } from "./center-pane/filePreviewUtils";
import "./CenterPane.css";

export function CenterPane({
  activeFilename,
  activeFile,
  errorMessage,
  isChecking,
  pendingAgentTextEdit,
  pendingTextRestore,
  previewTabs,
  searchNavigationTarget,
  unsavedText,
  onAgentTextEditApplied,
  onClosePreviewTab,
  onRefreshStatus,
  onRegisterSaveFileProvider,
  onSelectionContextChange,
  onSelectPreviewTab,
  onUpdateSpreadsheetFile,
  onUpdateTextFile,
  onSaveTextFile,
}: CenterPaneProps) {
  const activeExtension = getFileExtension(activeFile?.filename ?? "");
  const isTextPreview = isEditableTextFile(activeFile?.file, activeExtension);
  const isPdfPreview = activeExtension === "pdf";
  const isSpreadsheetPreview = isSpreadsheetExtension(activeExtension);
  const isDocxPreview = isDocxExtension(activeExtension);

  return (
    <section className="preview-pane" aria-label="文件预览" onPointerDown={handlePreviewPanePointerDown}>
      <PreviewHeader
        activeFileId={activeFile?.id}
        activeFilename={activeFilename}
        isChecking={isChecking}
        previewTabs={previewTabs}
        onClosePreviewTab={onClosePreviewTab}
        onRefreshStatus={onRefreshStatus}
        onSaveActiveFile={onSaveTextFile}
        onSelectPreviewTab={onSelectPreviewTab}
      />

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
          <span>选择一个 txt、pdf、docx 或 Excel 文件进行预览</span>
        </div>
      );
    }

    if (isTextPreview) {
      return (
        <TextFilePreview
          activeFile={activeFile}
          pendingAgentTextEdit={pendingAgentTextEdit}
          pendingTextRestore={pendingTextRestore}
          searchNavigationTarget={searchNavigationTarget}
          unsavedText={unsavedText}
          onAgentTextEditApplied={onAgentTextEditApplied}
          onSelectionContextChange={onSelectionContextChange}
          onUpdateTextFile={onUpdateTextFile}
          onSaveTextFile={onSaveTextFile}
        />
      );
    }

    if (isPdfPreview) {
      return (
        <PdfTextPreview
          activeFile={activeFile}
          searchNavigationTarget={searchNavigationTarget}
          onSelectionContextChange={onSelectionContextChange}
        />
      );
    }

    if (isSpreadsheetPreview) {
      return (
        <SpreadsheetPreview
          activeFile={activeFile}
          searchNavigationTarget={searchNavigationTarget}
          onSaveFile={onSaveTextFile}
          onSelectionContextChange={onSelectionContextChange}
          onUpdateSpreadsheetFile={onUpdateSpreadsheetFile}
        />
      );
    }

    if (isDocxPreview) {
      return (
        <DocxPreview
          activeFile={activeFile}
          searchNavigationTarget={searchNavigationTarget}
          onSaveFile={onSaveTextFile}
          onRegisterSaveFileProvider={onRegisterSaveFileProvider}
          onSelectionContextChange={onSelectionContextChange}
          onUpdateFile={onUpdateSpreadsheetFile}
        />
      );
    }

    return (
      <div className="editor-content preview-empty">
        <FileWarning size={30} />
        <span>暂不支持预览 {activeExtension || "该类型"} 文件</span>
      </div>
    );
  }

  function handlePreviewPanePointerDown(event: PointerEvent<HTMLElement>) {
    const target = event.target;

    if (!(target instanceof Element)) return;
    if (target.closest(".preview-text-editor, .pdf-viewer-shell, .spreadsheet-preview, .docx-preview")) return;

    onSelectionContextChange(null);
  }
}
