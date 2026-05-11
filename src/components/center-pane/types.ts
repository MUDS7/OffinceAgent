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
  sourceType: "docx" | "pdf" | "spreadsheet" | "text";
  start?: number;
  end?: number;
  text: string;
};

export type AgentTextEditResult = {
  id: string;
  assistantMessageId: string;
  fileId: string;
  start: number;
  end: number;
  replacementText: string;
  operation: "replace_selection" | "insert_after_selection";
};

export type AppliedAgentTextEditChange = {
  assistantMessageId: string;
  editId: string;
  fileId: string;
  filePath?: string;
  filename: string;
  beforeText: string;
  afterText: string;
  wasDirtyBefore: boolean;
};

export type PendingTextRestore = {
  id: string;
  fileId: string;
  text: string;
};

export type CenterPaneProps = {
  activeFilename: string;
  activeFile: PreviewFile | null;
  errorMessage: string;
  isChecking: boolean;
  pendingAgentTextEdit: AgentTextEditResult | null;
  pendingTextRestore: PendingTextRestore | null;
  previewTabs: PreviewTab[];
  unsavedText?: string;
  onAgentTextEditApplied: (change: AppliedAgentTextEditChange) => void;
  onClosePreviewTab: (fileId: string) => void;
  onRefreshStatus: () => void;
  onSelectionContextChange: (context: DocumentSelectionContext | null) => void;
  onSelectPreviewTab: (fileId: string) => void;
  onUpdateSpreadsheetFile: (fileId: string, file: File) => void;
  onUpdateTextFile: (fileId: string, text: string) => void;
  onSaveTextFile: (fileId: string) => void;
};
