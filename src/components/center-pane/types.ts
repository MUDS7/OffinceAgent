export type PreviewTab = {
  id: string;
  filename: string;
  isActive: boolean;
  isDirty?: boolean;
};

export type PreviewFile = {
  id: string;
  filename: string;
  file: File;
  diskPath?: string;
};

export type DocumentSelectionContext = {
  fileId: string;
  filePath: string;
  filename: string;
  sourceType: "pdf" | "text";
  start?: number;
  end?: number;
  text: string;
};

export type AgentTextEditResult = {
  id: string;
  fileId: string;
  start: number;
  end: number;
  replacementText: string;
  operation: "replace_selection" | "insert_after_selection";
};

export type CenterPaneProps = {
  activeFilename: string;
  activeFile: PreviewFile | null;
  errorMessage: string;
  isChecking: boolean;
  pendingAgentTextEdit: AgentTextEditResult | null;
  previewTabs: PreviewTab[];
  unsavedText?: string;
  onAgentTextEditApplied: () => void;
  onClosePreviewTab: (fileId: string) => void;
  onRefreshStatus: () => void;
  onSelectionContextChange: (context: DocumentSelectionContext | null) => void;
  onSelectPreviewTab: (fileId: string) => void;
  onUpdateTextFile: (fileId: string, text: string) => void;
  onSaveTextFile: (fileId: string) => void;
};
