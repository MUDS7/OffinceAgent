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
  contentLoaded?: boolean;
  metadataSaveStatus?: "pending" | "saved" | "error";
  sizeBytes?: number;
  lastModifiedMs?: number;
  analysis: AnalyzeResult | null;
};

export type WorkspaceFileMetadataResult = {
  document_id: string;
  saved: boolean;
};

export type WorkspaceFilesMetadataResult = {
  files_indexed: number;
};

export type WorkspaceStorageInfo = {
  workspace_path: string;
  data_path: string;
  sqlite_path: string;
  qdrant_path: string;
  created_data_dir: boolean;
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

// ─── DOCX Agent types ────────────────────────────────────────────────────────

export type DocxParagraphBlock = {
  id: string;
  type: "paragraph";
  text: string;
  style?: string | null;
  style_id?: string | null;
  alignment?: string | null;
};

export type DocxTableCell = {
  id: string;
  text: string;
  alignment?: string | null;
};

export type DocxTableBlock = {
  id: string;
  type: "table";
  rows: DocxTableCell[][];
};

export type DocxImageBlock = {
  id: string;
  type: "image";
  filename: string;
  content_type: string;
  data_url: string;
  alt_text?: string | null;
  width_emu?: number | null;
  height_emu?: number | null;
  alignment?: string | null;
};

export type DocxBlock = DocxParagraphBlock | DocxTableBlock | DocxImageBlock;

export type PdfPageBlock = {
  id: string;
  type: "pdf_page";
  page_number: number;
  text: string;
  paragraphs: string[];
};

export type DocxParseResponse = {
  filename: string;
  blocks: DocxBlock[];
  text_preview: string;
  warnings: string[];
};

export type DocumentIndexRequest = {
  document_id: string;
  filename: string;
  path?: string;
  original_path?: string;
  stored_path?: string;
  extension?: string;
  file_type?: string;
  size_bytes?: number;
  sha256?: string;
  parse_status?: string;
  index_status?: string;
  blocks: unknown[];
};

export type DocumentIndexResult = {
  document_id: string;
  nodes_indexed: number;
  chunks_indexed: number;
  qdrant_vectors_indexed: number;
  text_bytes_indexed: number;
};

export type QdrantChunkVectorPoint = {
  id?: string;
  chunk_id: string;
  vector: number[];
  document_id: string;
  document_name?: string;
  chunk_type: string;
  heading_path?: string | string[];
  order_index: number;
};

export type QdrantChunkUpsertRequest = {
  collection?: string;
  points: QdrantChunkVectorPoint[];
};

export type QdrantUpsertResult = {
  collection: string;
  points_upserted: number;
};

export type DocxCommandName =
  | "replace_text"
  | "delete_text"
  | "replace_paragraph"
  | "insert_paragraph"
  | "append_paragraph"
  | "insert_table";

export type DocxCommandSpec = {
  command: DocxCommandName;
  category: "basic" | "advanced";
  description: string;
  required_args: string[];
  optional_args: string[];
};

export type DocxCommandsResponse = {
  basic: DocxCommandSpec[];
  advanced: DocxCommandSpec[];
};

export type DocxAgentPlan = {
  action: "docx_execute" | "answer_only" | "ask_confirm";
  command?: DocxCommandName;
  args?: Record<string, unknown>;
  message?: string;
};

export type DocxExecuteResponse = {
  command: DocxCommandName;
  category: "basic" | "advanced";
  filename: string;
  document_base64: string;
  blocks: DocxBlock[];
  paragraphs_affected: number;
  tables_affected: number;
  summary: string;
};

// ─── Document Selection & Text Edit types ────────────────────────────────────

export type DocumentSelectionContext = {
  fileId: string;
  filePath: string;
  filename: string;
  sourceType: "docx" | "pdf" | "spreadsheet" | "text";
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
