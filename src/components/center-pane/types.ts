export type PreviewTab = {
  id: string;
  filename: string;
  isActive: boolean;
};

export type PreviewFile = {
  id: string;
  filename: string;
  file: File;
};

export type DocumentSelectionContext = {
  fileId: string;
  filename: string;
  sourceType: "pdf" | "text";
  text: string;
};

export type CenterPaneProps = {
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
