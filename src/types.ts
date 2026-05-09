// ─── Domain types ────────────────────────────────────────────────────────────

export type AgentInfo = {
  name: string;
  version: string;
  runtime: string;
};

export type ServiceStatus = {
  running: boolean;
  endpoint: string;
};

export type AnalyzeResult = {
  filename: string;
  extension: string;
  size_bytes: number;
  sha256: string;
  text_preview: string;
  warnings: string[];
};

export type WorkspaceFile = {
  id: string;
  file: File;
  relativePath?: string;
  diskPath?: string;
  analysis: AnalyzeResult | null;
};

export type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
  reasoningText?: string;
  contentTone?: "default" | "file-edit";
  fileChangeSet?: AgentFileChangeSet;
};

export type AgentFileChangeSet = {
  id: string;
  status: "active" | "undone";
  changes: AgentFileChange[];
};

export type AgentFileChange = {
  id: string;
  fileId: string;
  filePath?: string;
  filename: string;
  additions: number;
  deletions: number;
  beforeText: string;
  afterText: string;
  wasDirtyBefore: boolean;
};

export type DeepSeekApiMessage = {
  role: "assistant" | "system" | "user";
  content: string;
};

// ─── Excel Agent types ────────────────────────────────────────────────────────

export type ExcelCommandName =
  | "set_cell"
  | "set_range"
  | "insert_row"
  | "insert_column"
  | "delete_row"
  | "split_column"
  | "fill_empty_cells"
  | "summarize_by_column"
  | "generate_report";

export type ExcelCommandSpec = {
  command: ExcelCommandName;
  category: "basic" | "advanced";
  description: string;
  required_args: string[];
  optional_args: string[];
};

export type ExcelCommandsResponse = {
  basic: ExcelCommandSpec[];
  advanced: ExcelCommandSpec[];
};

export type ExcelAgentPlan = {
  action: "excel_execute" | "answer_only" | "ask_confirm";
  command?: ExcelCommandName;
  sheet?: string | null;
  output_path?: string | null;
  args?: Record<string, unknown>;
  message?: string;
};

export type ExcelExecuteResponse = {
  command: ExcelCommandName;
  category: "basic" | "advanced";
  file_path: string;
  output_path: string;
  workbook_base64?: string | null;
  saved_to_disk?: boolean;
  sheet?: string | null;
  rows_affected: number;
  cells_affected: number;
  summary: string;
  data?: Record<string, unknown>[] | null;
};

// ─── Document Selection & Text Edit types ────────────────────────────────────

export type DocumentSelectionContext = {
  fileId: string;
  filePath: string;
  filename: string;
  sourceType: "pdf" | "spreadsheet" | "text";
  start?: number;
  end?: number;
  text: string;
};

export type TextEditAgentRequest = {
  filePath: string;
  start: number;
  end: number;
  selectedText: string;
  fileContext?: string;
  isFullDocument?: boolean;
  contentEncoding?: "json_minified" | "text_whitespace_compacted";
  instruction: string;
  operation: TextEditOperation;
};

export type TextSelectionIntentAction =
  | "answer_only"
  | "replace_selection"
  | "insert_after_selection"
  | "ask_confirm";

export type TextEditOperation = Extract<
  TextSelectionIntentAction,
  "replace_selection" | "insert_after_selection"
>;

export type TextSelectionIntentResult = {
  intent: TextSelectionIntentAction;
};

export type AgentTextEditResult = {
  id: string;
  assistantMessageId: string;
  fileId: string;
  start: number;
  end: number;
  replacementText: string;
  operation: TextEditOperation;
};

export type DeepSeekStreamEvent = {
  stream_id: string;
  kind: "start" | "reasoning" | "delta" | "done" | "error";
  content?: string;
  error?: string;
};

// ─── Layout types ─────────────────────────────────────────────────────────────

export type ResizeTarget = "explorer" | "codex";

export type LayoutWidths = {
  explorer: number;
  codex: number;
};
