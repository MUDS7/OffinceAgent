import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { CenterPane } from "./components/CenterPane";
import { LeftPanel } from "./components/LeftPanel";
import { RightPanel } from "./components/RightPanel";
import { TopBar } from "./components/TopBar";

type AgentInfo = {
  name: string;
  version: string;
  runtime: string;
};

type ServiceStatus = {
  running: boolean;
  endpoint: string;
};

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
  relativePath?: string;
  diskPath?: string;
  analysis: AnalyzeResult | null;
};

type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
  reasoningText?: string;
  contentTone?: "default" | "file-edit";
};

type DeepSeekApiMessage = {
  role: "assistant" | "system" | "user";
  content: string;
};

type ExcelCommandName =
  | "set_cell"
  | "set_range"
  | "insert_row"
  | "insert_column"
  | "delete_row"
  | "split_column"
  | "fill_empty_cells"
  | "summarize_by_column"
  | "generate_report";

type ExcelCommandSpec = {
  command: ExcelCommandName;
  category: "basic" | "advanced";
  description: string;
  required_args: string[];
  optional_args: string[];
};

type ExcelCommandsResponse = {
  basic: ExcelCommandSpec[];
  advanced: ExcelCommandSpec[];
};

type ExcelAgentPlan = {
  action: "excel_execute" | "answer_only" | "ask_confirm";
  command?: ExcelCommandName;
  sheet?: string | null;
  output_path?: string | null;
  args?: Record<string, unknown>;
  message?: string;
};

type ExcelExecuteResponse = {
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

type DocumentSelectionContext = {
  fileId: string;
  filePath: string;
  filename: string;
  sourceType: "pdf" | "spreadsheet" | "text";
  start?: number;
  end?: number;
  text: string;
};

type TextEditAgentRequest = {
  filePath: string;
  start: number;
  end: number;
  selectedText: string;
  instruction: string;
  operation: TextEditOperation;
};

type TextSelectionIntentAction =
  | "answer_only"
  | "replace_selection"
  | "insert_after_selection"
  | "ask_confirm";

type TextEditOperation = Extract<TextSelectionIntentAction, "replace_selection" | "insert_after_selection">;

type TextSelectionIntentResult = {
  intent: TextSelectionIntentAction;
};

type AgentTextEditResult = {
  id: string;
  fileId: string;
  start: number;
  end: number;
  replacementText: string;
  operation: TextEditOperation;
};

type DeepSeekStreamEvent = {
  stream_id: string;
  kind: "start" | "reasoning" | "delta" | "done" | "error";
  content?: string;
  error?: string;
};

const DOCUMENT_SERVICE_URL = "http://127.0.0.1:8765";
const UI_SCALE_FALLBACK = 0.8;
const MIN_EXPLORER_WIDTH = 240;
const MIN_CODEX_WIDTH = 340;
const HIDE_DRAG_DISTANCE = 48;
const MAX_SELECTION_CONTEXT_CHARS = 12000;
const DOCUMENT_EXTENSIONS = ["txt", "md", "csv", "json", "pdf", "xlsx", "xls"];
const BINARY_PREVIEW_EXTENSIONS = new Set(["pdf", "xlsx", "xls"]);
const EXCEL_AGENT_SYSTEM_PROMPT = [
  "You are OfficeAgent's Excel operation planner.",
  "The application will execute Excel operations locally after reading your JSON. You must not claim that you directly edited the file.",
  "Return only one JSON object. Do not wrap it in Markdown. Do not include explanations outside JSON.",
  "Required JSON shape:",
  "{",
  '  "action": "excel_execute" | "answer_only" | "ask_confirm",',
  '  "command": "set_cell" | "set_range" | "insert_row" | "insert_column" | "delete_row" | "split_column" | "fill_empty_cells" | "summarize_by_column" | "generate_report",',
  '  "sheet": "worksheet name or null",',
  '  "output_path": "optional output .xlsx path or null",',
  '  "args": { "command-specific arguments": "values" },',
  '  "message": "short user-facing Chinese message"',
  "}",
  "Use action=excel_execute only when the user's requested file change is clear and maps to one supported command.",
  "Use action=answer_only for questions, explanations, or analysis that should not modify the workbook.",
  "Use action=ask_confirm when the target sheet/range/value/action is ambiguous or unsafe.",
  "Do not invent file paths. The application supplies file_path separately.",
  "For set_cell use args.cell and args.value.",
  "For set_range use args.values plus args.start_cell or args.range.",
  "Row indexes are 1-based, matching the row numbers shown in Excel.",
  "For insert_row use args.index when the exact insertion row is known, or args.before_row / args.after_row when the user says before/after a row.",
  "For insert_row with a current selection, you may use args.range from the selection Range line plus args.position of before, after, or middle.",
  'For insert_row when the user says "在中间插入一行" or "insert a row in the middle" without an exact row, use args.position="middle" and args.amount=1.',
  "For insert_row optional args.amount defaults to 1; optional args.values writes values into the inserted rows.",
  "For insert_column use args.index or args.column when the exact insertion column is known. Column indexes may be 1-based numbers or letters like B.",
  "For insert_column use args.before_column / args.after_column when the user says before/after or left/right of a column.",
  "For insert_column with a current selection, you may use args.range from the selection Range line plus args.position of before, after, or middle.",
  'For insert_column when the user says "在中间插入一列" or "insert a column in the middle" without an exact column, use args.position="middle" and args.amount=1.',
  "For insert_column optional args.amount defaults to 1; optional args.values writes values into the inserted columns.",
  "For delete_row use args.index and optional args.amount.",
  "For split_column, split one source column into adjacent columns. Use args.range from the selected Range line when available, or args.source_column/args.column plus optional args.start_row and args.end_row.",
  "For split_column by separator, use args.delimiter such as space, comma, -, /, or a literal character. For splitting every character, use args.mode=\"characters\" and do not use delimiter.",
  "For split_column optional args.target_cell or args.target_column controls where output starts; default starts at the source column. Use args.insert_columns=true only when the user asks to insert columns instead of overwriting adjacent cells.",
  "For fill_empty_cells use optional args.columns, args.fill_value, args.method where method is value, forward, or backward.",
  "For summarize_by_column and generate_report use args.group_by and optional args.aggregations.",
].join("\n");
const SUPPORTED_EXCEL_COMMANDS = new Set<ExcelCommandName>([
  "set_cell",
  "set_range",
  "insert_row",
  "insert_column",
  "delete_row",
  "split_column",
  "fill_empty_cells",
  "summarize_by_column",
  "generate_report",
]);

type ResizeTarget = "explorer" | "codex";

type LayoutWidths = {
  explorer: number;
  codex: number;
};

function App() {
  const [agentInfo, setAgentInfo] = useState<AgentInfo | null>(null);
  const [serviceStatus, setServiceStatus] = useState<ServiceStatus | null>(null);
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFile[]>([]);
  const [workspaceName, setWorkspaceName] = useState("工作区");
  const [selectedFileId, setSelectedFileId] = useState("");
  const [openFileIds, setOpenFileIds] = useState<string[]>([]);
  const [isChecking, setIsChecking] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [draftMessage, setDraftMessage] = useState("");
  const [documentSelection, setDocumentSelection] = useState<DocumentSelectionContext | null>(null);
  const [pendingAgentTextEdit, setPendingAgentTextEdit] = useState<AgentTextEditResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const [unsavedContents, setUnsavedContents] = useState<Record<string, string>>({});
  const [dirtyFileIds, setDirtyFileIds] = useState<string[]>([]);
  const [layoutWidths, setLayoutWidths] = useState<LayoutWidths>(() => getInitialLayoutWidths());

  const selectedWorkspaceFile = useMemo(
    () => workspaceFiles.find((item) => item.id === selectedFileId) ?? null,
    [workspaceFiles, selectedFileId],
  );

  const activePreviewFile = useMemo(
    () =>
      selectedWorkspaceFile
        ? {
            id: selectedWorkspaceFile.id,
            filename: selectedWorkspaceFile.file.name,
            file: selectedWorkspaceFile.file,
            diskPath: selectedWorkspaceFile.diskPath,
          }
        : null,
    [selectedWorkspaceFile],
  );
  const openPreviewTabs = useMemo(
    () =>
      openFileIds
        .map((fileId) => workspaceFiles.find((item) => item.id === fileId))
        .filter((item): item is WorkspaceFile => Boolean(item))
        .map((item) => ({
          id: item.id,
          filename: item.file.name,
          isActive: item.id === selectedFileId,
          isDirty: dirtyFileIds.includes(item.id),
        })),
    [openFileIds, selectedFileId, workspaceFiles, dirtyFileIds],
  );
  const canAnalyze = Boolean(selectedWorkspaceFile && serviceStatus?.running && !isAnalyzing);
  const workbenchStyle = {
    "--explorer-width": `${layoutWidths.explorer}px`,
    "--codex-width": `${layoutWidths.codex}px`,
  } as CSSProperties;
  const activeFilename = selectedWorkspaceFile?.file.name ?? "未选择文件";

  async function refreshStatus() {
    setIsChecking(true);
    setErrorMessage("");

    try {
      const [info, status] = await Promise.all([
        invoke<AgentInfo>("get_agent_info"),
        invoke<ServiceStatus>("get_document_service_status"),
      ]);
      setAgentInfo(info);
      setServiceStatus(status);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isTauriUnavailable(message)) {
        setAgentInfo({ name: "OfficeAgent", version: "0.1.0", runtime: "React Preview" });
        setServiceStatus({ running: true, endpoint: DOCUMENT_SERVICE_URL });
        return;
      }
      setErrorMessage(message);
    } finally {
      setIsChecking(false);
    }
  }

  async function openFilePicker() {
    // In the Tauri desktop runtime, use the native dialog so we get the real
    // filesystem path back — the HTML <input type="file"> in Tauri v2 does NOT
    // expose file.path, so diskPath would never be set via that route.
    if (canUseTauriEvents()) {
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({
          multiple: true,
          filters: [{ name: "Documents", extensions: DOCUMENT_EXTENSIONS }],
        });
        if (!selected) return;
        const paths = Array.isArray(selected) ? selected : [selected];
        await openFilesByPath(paths);
      } catch (error) {
        setErrorMessage(`打开文件对话框失败: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    // Fallback: browser / web preview mode
    if (fileInputRef.current) fileInputRef.current.value = "";
    fileInputRef.current?.click();
  }

  async function openFolderPicker() {
    if (canUseTauriEvents()) {
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({ directory: true, multiple: false });
        if (!selected) return;
        const folderPath = Array.isArray(selected) ? selected[0] : selected;
        await openFolderByPath(folderPath);
      } catch (error) {
        setErrorMessage(`打开文件夹对话框失败: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    // Fallback: browser / web preview mode
    if (folderInputRef.current) folderInputRef.current.value = "";
    folderInputRef.current?.click();
  }

  async function openFilesByPath(filePaths: string[]) {
    const nextFiles: WorkspaceFile[] = [];
    for (const filePath of filePaths) {
      const filename = filePath.replace(/\\/g, "/").split("/").pop() ?? filePath;
      const extension = filename.split(".").pop()?.toLowerCase() ?? "";
      const isBinaryPreview = BINARY_PREVIEW_EXTENSIONS.has(extension);
      try {
        const content = isBinaryPreview
          ? new Uint8Array(await invoke<number[]>("read_file_bytes", { path: filePath }))
          : await invoke<string>("read_file_text", { path: filePath });
        const file = new File([content], filename, {
          type: getFileMimeType(filename),
          lastModified: Date.now(),
        });
        nextFiles.push({
          id: `${filePath}-${file.lastModified}`,
          file,
          diskPath: filePath,
          analysis: null,
        });
      } catch (error) {
        console.error(`Failed to open ${filePath}:`, error);
      }
    }
    if (!nextFiles.length) return;
    setWorkspaceFiles((current) => {
      const knownPaths = new Set(current.map((item) => item.diskPath).filter(Boolean));
      return [...current, ...nextFiles.filter((item) => !knownPaths.has(item.diskPath))];
    });
    openWorkspaceFile(nextFiles[0].id);
    setErrorMessage("");
  }

  async function openFolderByPath(folderPath: string) {
    try {
      const entries = await invoke<string[]>("list_dir_files", { path: folderPath });
      const rootName = folderPath.replace(/\\/g, "/").split("/").pop() ?? "工作区";
      const supported = entries.filter((p) => /\.(txt|md|csv|json|pdf|xlsx|xls)$/i.test(p));
      if (!supported.length) {
        setErrorMessage("该文件夹中没有支持的文件类型");
        return;
      }
      const nextFiles: WorkspaceFile[] = [];
      for (const filePath of supported) {
        const filename = filePath.replace(/\\/g, "/").split("/").pop() ?? filePath;
        const extension = filename.split(".").pop()?.toLowerCase() ?? "";
        const isBinaryPreview = BINARY_PREVIEW_EXTENSIONS.has(extension);
        try {
          const content = isBinaryPreview
            ? new Uint8Array(await invoke<number[]>("read_file_bytes", { path: filePath }))
            : await invoke<string>("read_file_text", { path: filePath });
          const relativePath = normalizeFilePath(filePath.replace(folderPath, rootName));
          const file = new File([content], filename, {
            type: getFileMimeType(filename),
            lastModified: Date.now(),
          });
          nextFiles.push({
            id: `${filePath}-${file.lastModified}`,
            file,
            relativePath,
            diskPath: filePath,
            analysis: null,
          });
        } catch {
          // Skip unreadable files silently
        }
      }
      if (!nextFiles.length) return;
      setWorkspaceName(rootName);
      setWorkspaceFiles(nextFiles);
      setSelectedFileId("");
      setOpenFileIds([]);
      setDocumentSelection(null);
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(`读取文件夹失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function handleFileSelection(files: FileList | null) {
    if (!files?.length) return;

    const nextFiles = Array.from(files).map((file) => ({
      id: `${file.name}-${file.size}-${file.lastModified}`,
      file,
      analysis: null as AnalyzeResult | null,
    }));

    setWorkspaceFiles((current) => {
      const knownIds = new Set(current.map((item) => item.id));
      return [...current, ...nextFiles.filter((item) => !knownIds.has(item.id))];
    });
    openWorkspaceFile(nextFiles[0].id);
    setErrorMessage("");
  }

  function handleFolderSelection(files: FileList | null) {
    if (!files?.length) return;

    const selectedFiles = Array.from(files);
    const firstRelativePath = normalizeFilePath(getFileRelativePath(selectedFiles[0]));
    const rootName = firstRelativePath.split("/")[0] || "工作区";
    const nextFiles = selectedFiles.map((file) => {
      const relativePath = normalizeFilePath(getFileRelativePath(file)) || file.name;
      const diskPath: string | undefined = (file as any).path || undefined;

      return {
        id: `${relativePath}-${file.size}-${file.lastModified}`,
        file,
        relativePath,
        diskPath,
        analysis: null,
      };
    });

    setWorkspaceName(rootName);
    setWorkspaceFiles(nextFiles);
    setSelectedFileId("");
    setOpenFileIds([]);
    setDocumentSelection(null);
    setErrorMessage("");
  }

  function createEmptyFile(filename: string) {
    const trimmedFilename = filename.trim();
    if (!trimmedFilename) return;

    if (workspaceFiles.some((item) => item.file.name === trimmedFilename)) {
      setErrorMessage(`文件已存在：${trimmedFilename}`);
      return;
    }

    const file = new File([""], trimmedFilename, {
      type: getFileMimeType(trimmedFilename),
      lastModified: Date.now(),
    });
    const nextFile = {
      id: `${file.name}-${file.size}-${file.lastModified}`,
      file,
      analysis: null,
    };

    setWorkspaceFiles((current) => [...current, nextFile]);
    openWorkspaceFile(nextFile.id);
    setErrorMessage("");
  }

  function updateTextFile(fileId: string, text: string) {
    setUnsavedContents((current) => ({
      ...current,
      [fileId]: text,
    }));
    setDirtyFileIds((current) => {
      if (current.includes(fileId)) return current;
      return [...current, fileId];
    });
  }

  async function saveWorkspaceFile(fileId: string) {
    const currentItem = workspaceFiles.find((item) => item.id === fileId);
    if (!currentItem) return;

    const unsavedText = unsavedContents[fileId];
    const fileExtension = currentItem.file.name.split(".").pop()?.toLowerCase() ?? "";
    const isTextSave = unsavedText !== undefined || !BINARY_PREVIEW_EXTENSIONS.has(fileExtension);

    // Prefer the persisted diskPath over the transient file.path property.
    let filePath: string | undefined = currentItem.diskPath;

    if (!filePath && canUseTauriEvents()) {
      try {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const defaultPath = currentItem.relativePath
          ? currentItem.relativePath.split("/").pop()
          : currentItem.file.name;

        const chosen = await save({ defaultPath });
        if (!chosen) return;
        filePath = chosen;
      } catch (error) {
        console.error("Save dialog error:", error);
        setErrorMessage("保存对话框打开失败");
        return;
      }
    }

    if (!filePath) {
      setErrorMessage("无法确定保存路径，请在 Tauri 桌面端使用此功能");
      return;
    }

    let savedContent: BlobPart = currentItem.file;
    try {
      if (isTextSave) {
        const textToSave = unsavedText ?? (await currentItem.file.text());
        savedContent = textToSave;
        await invoke("save_file_to_disk", { path: filePath, content: textToSave });
      } else {
        const bytesToSave = Array.from(new Uint8Array(await currentItem.file.arrayBuffer()));
        savedContent = new Uint8Array(bytesToSave);
        await invoke("save_file_bytes", { path: filePath, content: bytesToSave });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrorMessage(`保存文件到磁盘失败: ${message}`);
      return;
    }

    // Persist diskPath so subsequent Ctrl+S saves go straight to disk without a dialog.
    const resolvedDiskPath = filePath;

    setWorkspaceFiles((wsFiles) =>
      wsFiles.map((item) => {
        if (item.id !== fileId) return item;

        const file = new File([savedContent], item.file.name, {
          type: item.file.type || getFileMimeType(item.file.name),
          lastModified: Date.now(),
        });

        return { ...item, file, diskPath: resolvedDiskPath, analysis: null };
      }),
    );

    setUnsavedContents((current) => {
      const next = { ...current };
      delete next[fileId];
      return next;
    });

    setDirtyFileIds((current) => current.filter((id) => id !== fileId));
  }

  function openWorkspaceFile(fileId: string) {
    setSelectedFileId(fileId);
    setDocumentSelection(null);

    if (!fileId) return;

    setOpenFileIds((current) => [fileId, ...current.filter((id) => id !== fileId)]);
  }

  function closePreviewTab(fileId: string) {
    setOpenFileIds((current) => {
      const nextOpenFileIds = current.filter((id) => id !== fileId);

      if (fileId === selectedFileId) {
        setSelectedFileId(nextOpenFileIds[0] ?? "");
      }

      return nextOpenFileIds;
    });

    setDirtyFileIds((current) => current.filter((id) => id !== fileId));
    setUnsavedContents((current) => {
      const next = { ...current };
      delete next[fileId];
      return next;
    });
  }

  function deleteFiles(fileIds: string[]) {
    const idsSet = new Set(fileIds);
    setWorkspaceFiles((current) => current.filter((item) => !idsSet.has(item.id)));
    
    setOpenFileIds((current) => {
      const nextOpenFileIds = current.filter((id) => !idsSet.has(id));
      if (idsSet.has(selectedFileId)) {
        setSelectedFileId(nextOpenFileIds[0] ?? "");
      }
      return nextOpenFileIds;
    });
  }

  async function analyzeDocument() {
    if (!selectedWorkspaceFile) return;

    setIsAnalyzing(true);
    setErrorMessage("");

    const body = new FormData();
    body.append("file", selectedWorkspaceFile.file);

    try {
      const response = await fetch(`${DOCUMENT_SERVICE_URL}/documents/analyze`, {
        method: "POST",
        body,
      });

      if (!response.ok) {
        throw new Error(`文档服务返回 ${response.status}`);
      }

      const result = (await response.json()) as AnalyzeResult;
      setWorkspaceFiles((current) =>
        current.map((item) => (item.id === selectedWorkspaceFile.id ? { ...item, analysis: result } : item)),
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsAnalyzing(false);
    }
  }

  async function handleSpreadsheetAgentCommand(
    model: string,
    instruction: string,
    nextMessages: ChatMessage[],
    assistantMessageId: string,
    streamId: string,
  ) {
    const targetFile = selectedWorkspaceFile;
    if (!targetFile) return;

    if (!targetFile.diskPath) {
      updateAssistantMessage(assistantMessageId, "需要先通过桌面端文件选择器打开这个 Excel 文件，才能拿到真实磁盘路径并执行写入。");
      return;
    }

    if (!targetFile.file.name.toLowerCase().endsWith(".xlsx")) {
      updateAssistantMessage(assistantMessageId, "当前 Excel 命令执行器只支持 .xlsx 文件，请先另存为 .xlsx 后再操作。");
      return;
    }

    let unlisten: (() => void) | null = null;
    let assistantText = "";
    let streamError = "";
    const selectionText = documentSelection?.sourceType === "spreadsheet" ? documentSelection.text : "";
    const selectionSheetName = parseSpreadsheetSelectionSheet(selectionText);
    let commandSpecs: ExcelCommandsResponse | null = null;

    try {
      commandSpecs = await fetchExcelCommandSpecs();
      const messages = buildExcelAgentMessages({
        commandSpecs,
        filename: targetFile.file.name,
        instruction,
        selectionText,
        chatMessages: nextMessages,
      });

      unlisten = await listen<DeepSeekStreamEvent>("deepseek-chat-stream", (event) => {
        const payload = event.payload;
        if (payload.stream_id !== streamId) return;

        if (payload.kind === "delta" && payload.content) {
          assistantText += payload.content;
        }

        if (payload.kind === "error" && payload.error) {
          streamError = payload.error;
        }
      });

      await invoke("chat_with_deepseek", {
        model,
        streamId,
        messages,
        textEditRequest: null,
      });

      if (streamError) {
        throw new Error(streamError);
      }
    } finally {
      unlisten?.();
    }

    const plan = parseExcelAgentPlan(assistantText);
    if (!plan.sheet && selectionSheetName) {
      plan.sheet = selectionSheetName;
    }

    if (plan.action === "answer_only" || plan.action === "ask_confirm") {
      updateAssistantMessage(assistantMessageId, plan.message || stripMarkdownFence(assistantText.trim()) || "需要你再补充一下目标范围或操作内容。");
      return;
    }

    const command = normalizeExcelCommandName(plan.command);
    if (!command) {
      updateAssistantMessage(assistantMessageId, "模型没有返回可执行的 Excel 命令，我没有改动文件。");
      return;
    }

    if (commandSpecs && !isExcelCommandAvailable(command, commandSpecs)) {
      updateAssistantMessage(assistantMessageId, buildUnavailableExcelCommandMessage(command));
      return;
    }

    const executionResult = await executeExcelPlan({
      command,
      filePath: targetFile.diskPath,
      plan,
    });
    await refreshExcelWorkspaceFile(targetFile, executionResult);

    updateAssistantMessage(
      assistantMessageId,
      buildExcelExecutionStatus(plan, executionResult),
    );
  }

  function updateAssistantMessage(assistantMessageId: string, text: string) {
    setChatMessages((current) =>
      current.map((message) => (message.id === assistantMessageId ? { ...message, text } : message)),
    );
  }

  async function refreshExcelWorkspaceFile(targetFile: WorkspaceFile, result: ExcelExecuteResponse) {
    const outputPath = result.output_path;

    try {
      const content = result.workbook_base64
        ? decodeBase64Bytes(result.workbook_base64)
        : new Uint8Array(await invoke<number[]>("read_file_bytes", { path: outputPath }));
      const filename = outputPath.replace(/\\/g, "/").split("/").pop() ?? targetFile.file.name;
      const refreshedFile = new File([content], filename, {
        type: getFileMimeType(filename),
        lastModified: Date.now(),
      });
      const nextDiskPath = result.saved_to_disk || outputPath === targetFile.diskPath ? outputPath : undefined;
      const nextFileId = `${outputPath}-${refreshedFile.lastModified}`;
      const dirtyFileIdsToMark = new Set<string>([targetFile.id]);

      setWorkspaceFiles((current) => {
        const existingOutputFile = current.find((item) => item.diskPath === outputPath);
        if (existingOutputFile) {
          dirtyFileIdsToMark.add(existingOutputFile.id);
          return current.map((item) =>
            item.id === existingOutputFile.id ? { ...item, file: refreshedFile, analysis: null } : item,
          );
        }

        if (targetFile.diskPath === outputPath) {
          dirtyFileIdsToMark.add(targetFile.id);
          return current.map((item) =>
            item.id === targetFile.id ? { ...item, file: refreshedFile, analysis: null } : item,
          );
        }

        dirtyFileIdsToMark.add(nextFileId);
        const nextFile = {
          id: nextFileId,
          file: refreshedFile,
          diskPath: nextDiskPath,
          analysis: null,
        };
        return [...current, nextFile];
      });
      setDirtyFileIds((current) => {
        const next = new Set(current);
        dirtyFileIdsToMark.forEach((id) => next.add(id));
        return [...next];
      });
    } catch (error) {
      console.warn("Failed to refresh Excel preview after command execution.", error);
    }
  }

  async function sendMessage(model: string) {
    const text = draftMessage.trim();
    if (!text || isSendingMessage) return;

    if (!canUseTauriEvents()) {
      const message = "DeepSeek streaming requires the Tauri desktop runtime. Start the app with npm run tauri:dev.";
      setErrorMessage(message);
      setChatMessages((current) => [
        ...current,
        { id: `assistant-runtime-error-${Date.now()}`, role: "assistant", text: message },
      ]);
      return;
    }

    const now = Date.now();
    const streamId = `deepseek-${now}`;
    const assistantMessageId = `assistant-${now}`;
    const userMessage: ChatMessage = { id: `user-${now}`, role: "user", text };
    const assistantMessage: ChatMessage = { id: assistantMessageId, role: "assistant", text: "" };
    const nextMessages = [...chatMessages, userMessage];

    setChatMessages([...nextMessages, assistantMessage]);
    setDraftMessage("");
    setIsSendingMessage(true);
    setErrorMessage("");

    let unlisten: (() => void) | null = null;
    let assistantText = "";
    let hasAppliedAgentText = false;
    let textEditTarget: {
      fileId: string;
      start: number;
      end: number;
      operation: TextEditOperation;
    } | null = null;

    function applyAgentTextResult() {
      if (!textEditTarget || hasAppliedAgentText) return;
      const editText = extractAgentTextEditPayload(assistantText);
      if (textEditTarget.operation === "insert_after_selection" && !editText.length) return;

      hasAppliedAgentText = true;
      const statusText = getTextEditStatusMessage(textEditTarget.operation, editText);
      setChatMessages((current) =>
        current.map((message) =>
          message.id === assistantMessageId && !message.text ? { ...message, text: statusText } : message,
        ),
      );
      setPendingAgentTextEdit({
        id: `agent-edit-${now}`,
        fileId: textEditTarget.fileId,
        start: textEditTarget.start,
        end: textEditTarget.end,
        replacementText: editText,
        operation: textEditTarget.operation,
      });
    }

    try {
      if (shouldUseSpreadsheetAgent(selectedWorkspaceFile)) {
        await handleSpreadsheetAgentCommand(model, text, nextMessages, assistantMessageId, streamId);
        return;
      }

      const intent = await classifyTextSelectionIntent(model, text, documentSelection);
      if (intent === "ask_confirm") {
        setChatMessages((current) =>
          current.map((message) =>
            message.id === assistantMessageId
              ? {
                  ...message,
                  text: "需要先确认一下：你希望我替换当前选区、在选区后新增，还是删除某一段内容？确认后我再修改文件。",
                }
              : message,
          ),
        );
        return;
      }

      const textEditRequest = buildTextEditAgentRequest(text, documentSelection, intent);
      textEditTarget =
        textEditRequest && documentSelection
          ? {
              fileId: documentSelection.fileId,
              start: textEditRequest.start,
              end: textEditRequest.end,
              operation: textEditRequest.operation,
            }
          : null;
      const apiMessages = textEditRequest ? [] : buildDeepSeekMessages(nextMessages, documentSelection);
      const assistantContentTone = textEditRequest ? "file-edit" : "default";

      setChatMessages((current) =>
        current.map((message) =>
          message.id === assistantMessageId ? { ...message, contentTone: assistantContentTone } : message,
        ),
      );

      unlisten = await listen<DeepSeekStreamEvent>("deepseek-chat-stream", (event) => {
        const payload = event.payload;
        if (payload.stream_id !== streamId) return;

        if (payload.kind === "reasoning" && payload.content) {
          if (textEditTarget) return;

          setChatMessages((current) =>
            current.map((message) =>
              message.id === assistantMessageId
                ? { ...message, reasoningText: `${message.reasoningText ?? ""}${payload.content}` }
                : message,
            ),
          );
          return;
        }

        if (payload.kind === "delta" && payload.content) {
          assistantText += payload.content;
          if (textEditTarget) return;

          setChatMessages((current) =>
            current.map((message) =>
              message.id === assistantMessageId ? { ...message, text: message.text + payload.content } : message,
            ),
          );
          return;
        }

        if (payload.kind === "done") {
          applyAgentTextResult();
          return;
        }

        if (payload.kind === "error" && payload.error) {
          setErrorMessage(payload.error);
          setChatMessages((current) =>
            current.map((message) =>
              message.id === assistantMessageId
                ? { ...message, text: `DeepSeek request failed: ${payload.error}` }
                : message,
            ),
          );
        }
      });

      await invoke("chat_with_deepseek", {
        model,
        streamId,
        messages: apiMessages,
        textEditRequest,
      });

      applyAgentTextResult();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrorMessage(message);
      setChatMessages((current) =>
        current.map((chatMessage) =>
          chatMessage.id === assistantMessageId
            ? { ...chatMessage, text: `DeepSeek request failed: ${message}` }
            : chatMessage,
        ),
      );
    } finally {
      unlisten?.();
      setIsSendingMessage(false);
    }
  }

  function startLayoutResize(target: ResizeTarget, event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();

    const startX = event.clientX;
    const startWidth = layoutWidths[target];
    const scale = getUiScale();

    document.body.classList.add("is-resizing-layout");

    function handlePointerMove(moveEvent: PointerEvent) {
      const delta = (moveEvent.clientX - startX) / scale;

      setLayoutWidths((current) => {
        if (target === "explorer") {
          const nextWidth = startWidth + delta;

          return {
            ...current,
            explorer: normalizePanelWidth(nextWidth, MIN_EXPLORER_WIDTH),
          };
        }

        const nextWidth = startWidth - delta;

        return {
          ...current,
          codex: normalizePanelWidth(nextWidth, MIN_CODEX_WIDTH),
        };
      });
    }

    function stopLayoutResize() {
      document.body.classList.remove("is-resizing-layout");
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopLayoutResize);
      window.removeEventListener("pointercancel", stopLayoutResize);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopLayoutResize);
    window.addEventListener("pointercancel", stopLayoutResize);
  }

  function handleResizerKeyDown(target: ResizeTarget, event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;

    event.preventDefault();
    const step = event.shiftKey ? 40 : 16;
    const direction = event.key === "ArrowRight" ? 1 : -1;

    setLayoutWidths((current) => {
      if (target === "explorer") {
        const nextWidth = current.explorer + direction * step;
        const explorerWidth =
          current.explorer <= MIN_EXPLORER_WIDTH && nextWidth < MIN_EXPLORER_WIDTH
            ? 0
            : normalizePanelWidth(nextWidth, MIN_EXPLORER_WIDTH);

        return {
          ...current,
          explorer: explorerWidth,
        };
      }

      const nextWidth = current.codex - direction * step;
      const codexWidth =
        current.codex <= MIN_CODEX_WIDTH && nextWidth < MIN_CODEX_WIDTH
          ? 0
          : normalizePanelWidth(nextWidth, MIN_CODEX_WIDTH);

      return {
        ...current,
        codex: codexWidth,
      };
    });
  }

  useEffect(() => {
    refreshStatus();
  }, []);

  useEffect(() => {
    const folderInput = folderInputRef.current;
    if (!folderInput) return;

    folderInput.setAttribute("webkitdirectory", "");
    folderInput.setAttribute("directory", "");
  }, []);

  return (
    <main className="desktop-shell">
      <input
        ref={fileInputRef}
        className="hidden-file-input"
        type="file"
        multiple
        accept=".txt,.md,.csv,.json,.pdf,.xlsx,.xls,.docx"
        onChange={(event) => handleFileSelection(event.target.files)}
      />
      <input
        ref={folderInputRef}
        className="hidden-file-input"
        type="file"
        multiple
        onChange={(event) => handleFolderSelection(event.target.files)}
      />

      <TopBar
        agentInfo={agentInfo}
        serviceStatus={serviceStatus}
        workspaceFileCount={workspaceFiles.length}
        onOpenFilePicker={openFilePicker}
        onOpenFolderPicker={openFolderPicker}
      />

      <section className="workbench" style={workbenchStyle}>
        <LeftPanel
          workspaceName={workspaceName}
          workspaceFiles={workspaceFiles}
          selectedFileId={selectedFileId}
          explorerWidth={layoutWidths.explorer}
          onSelectFile={openWorkspaceFile}
          onCreateEmptyFile={createEmptyFile}
          onOpenFilePicker={openFilePicker}
          onDeleteFiles={deleteFiles}
        />

        <div
          className="layout-resizer"
          role="separator"
          aria-label="调整左侧面板宽度"
          aria-orientation="vertical"
          aria-valuemin={0}
          aria-valuenow={Math.round(layoutWidths.explorer)}
          tabIndex={0}
          onKeyDown={(event) => handleResizerKeyDown("explorer", event)}
          onPointerDown={(event) => startLayoutResize("explorer", event)}
        />

        <CenterPane
          activeFilename={activeFilename}
          activeFile={activePreviewFile}
          errorMessage={errorMessage}
          isChecking={isChecking}
          pendingAgentTextEdit={pendingAgentTextEdit}
          previewTabs={openPreviewTabs}
          unsavedText={unsavedContents[selectedFileId]}
          onAgentTextEditApplied={() => setPendingAgentTextEdit(null)}
          onClosePreviewTab={closePreviewTab}
          onRefreshStatus={refreshStatus}
          onSelectionContextChange={setDocumentSelection}
          onSelectPreviewTab={setSelectedFileId}
          onUpdateTextFile={updateTextFile}
          onSaveTextFile={saveWorkspaceFile}
        />

        <div
          className="layout-resizer"
          role="separator"
          aria-label="调整右侧面板宽度"
          aria-orientation="vertical"
          aria-valuemin={0}
          aria-valuenow={Math.round(layoutWidths.codex)}
          tabIndex={0}
          onKeyDown={(event) => handleResizerKeyDown("codex", event)}
          onPointerDown={(event) => startLayoutResize("codex", event)}
        />

        <RightPanel
          chatMessages={chatMessages}
          codexWidth={layoutWidths.codex}
          draftMessage={draftMessage}
          documentSelection={documentSelection}
          isSendingMessage={isSendingMessage}
          onDraftMessageChange={setDraftMessage}
          onOpenFilePicker={openFilePicker}
          onSendMessage={sendMessage}
        />
      </section>
    </main>
  );
}

function getInitialLayoutWidths(): LayoutWidths {
  if (typeof window === "undefined") {
    return { explorer: 361, codex: 520 };
  }

  if (window.innerWidth <= 1200) {
    return { explorer: 280, codex: 390 };
  }

  return {
    explorer: 361,
    codex: Math.max(420, window.innerWidth * 0.29),
  };
}

function getUiScale() {
  if (typeof window === "undefined") return UI_SCALE_FALLBACK;

  const rawScale = getComputedStyle(document.documentElement).getPropertyValue("--ui-scale");
  const scale = Number.parseFloat(rawScale);
  return Number.isFinite(scale) && scale > 0 ? scale : UI_SCALE_FALLBACK;
}

function normalizePanelWidth(width: number, minWidth: number) {
  if (width <= minWidth - HIDE_DRAG_DISTANCE) return 0;
  if (width === 0) return 0;
  return Math.max(minWidth, width);
}

function buildTextEditAgentRequest(
  instruction: string,
  documentSelection: DocumentSelectionContext | null,
  intent: TextSelectionIntentAction,
): TextEditAgentRequest | null {
  if (
    (intent !== "replace_selection" && intent !== "insert_after_selection") ||
    documentSelection?.sourceType !== "text"
  ) {
    return null;
  }

  const start = documentSelection.start ?? 0;
  const end = documentSelection.end ?? start + documentSelection.text.length;

  return {
    filePath: documentSelection.filePath,
    start,
    end,
    selectedText: documentSelection.text,
    instruction,
    operation: intent,
  };
}

async function classifyTextSelectionIntent(
  model: string,
  instruction: string,
  documentSelection: DocumentSelectionContext | null,
): Promise<TextSelectionIntentAction> {
  if (documentSelection?.sourceType !== "text") {
    return "answer_only";
  }

  let result: TextSelectionIntentResult;
  try {
    result = await invoke<TextSelectionIntentResult>("classify_text_selection_intent", {
      model,
      request: {
        filePath: documentSelection.filePath,
        filename: documentSelection.filename,
        selectedText: documentSelection.text,
        instruction,
      },
    });
  } catch (error) {
    console.warn("Text selection intent classification failed; falling back to answer mode.", error);
    return "answer_only";
  }

  return normalizeTextSelectionIntent(result.intent);
}

function normalizeTextSelectionIntent(intent: string): TextSelectionIntentAction {
  if (
    intent === "replace_selection" ||
    intent === "insert_after_selection" ||
    intent === "ask_confirm" ||
    intent === "answer_only"
  ) {
    return intent;
  }

  return "answer_only";
}

function shouldUseSpreadsheetAgent(selectedWorkspaceFile: WorkspaceFile | null) {
  const filename = selectedWorkspaceFile?.file.name.toLowerCase() ?? "";

  return filename.endsWith(".xlsx") || filename.endsWith(".xls");
}

async function fetchExcelCommandSpecs() {
  const response = await fetch(`${DOCUMENT_SERVICE_URL}/excel/commands`);
  if (!response.ok) {
    throw new Error(`Excel command service returned ${response.status}`);
  }

  return (await response.json()) as ExcelCommandsResponse;
}

function getExcelCommandNames(commandSpecs: ExcelCommandsResponse) {
  return new Set([...commandSpecs.basic, ...commandSpecs.advanced].map((spec) => spec.command));
}

function isExcelCommandAvailable(command: ExcelCommandName, commandSpecs: ExcelCommandsResponse) {
  return getExcelCommandNames(commandSpecs).has(command);
}

function buildUnavailableExcelCommandMessage(command: ExcelCommandName) {
  return [
    `当前文档服务还没有开放 ${command} 命令，我没有改动文件。`,
    "请重启 OfficeAgent 或文档服务后再试；如果是已打包版本，需要重新打包后使用新版服务。",
  ].join("\n");
}

function buildExcelAgentMessages({
  commandSpecs,
  filename,
  instruction,
  selectionText,
  chatMessages,
}: {
  commandSpecs: ExcelCommandsResponse;
  filename: string;
  instruction: string;
  selectionText: string;
  chatMessages: ChatMessage[];
}): DeepSeekApiMessage[] {
  const commandNames = [...getExcelCommandNames(commandSpecs)].join(", ");
  const commands = [...commandSpecs.basic, ...commandSpecs.advanced]
    .map((spec) => {
      const requiredArgs = spec.required_args.length ? spec.required_args.join(", ") : "none";
      const optionalArgs = spec.optional_args.length ? spec.optional_args.join(", ") : "none";

      return `- ${spec.command}: ${spec.description} Required args: ${requiredArgs}. Optional args: ${optionalArgs}.`;
    })
    .join("\n");
  const recentConversation = chatMessages
    .slice(-6)
    .map((message) => `${message.role}: ${message.text}`)
    .join("\n");

  return [
    {
      role: "system",
      content: [
        EXCEL_AGENT_SYSTEM_PROMPT,
        `Only choose one of these currently available commands for action=excel_execute: ${commandNames}.`,
        "If the user asks for an unavailable Excel operation, use action=ask_confirm and explain briefly in Chinese that the current document service needs to be restarted or updated.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Workbook filename: ${filename}`,
        "",
        "Supported commands:",
        commands,
        "",
        selectionText.trim()
          ? `Current spreadsheet selection:\n<<<\n${truncateSelectionContext(selectionText)}\n>>>`
          : "Current spreadsheet selection: none",
        "",
        "Recent conversation:",
        recentConversation,
        "",
        "User request:",
        `<<<\n${instruction}\n>>>`,
      ].join("\n"),
    },
  ];
}

function parseExcelAgentPlan(content: string): ExcelAgentPlan {
  const trimmedContent = stripMarkdownFence(content.trim());
  const directParse = tryParseExcelAgentPlan(trimmedContent);
  if (directParse) return directParse;

  const startIndex = trimmedContent.indexOf("{");
  const endIndex = trimmedContent.lastIndexOf("}");
  if (startIndex >= 0 && endIndex > startIndex) {
    const extracted = trimmedContent.slice(startIndex, endIndex + 1);
    const extractedParse = tryParseExcelAgentPlan(extracted);
    if (extractedParse) return extractedParse;
  }

  throw new Error("Excel agent did not return valid JSON.");
}

function tryParseExcelAgentPlan(content: string): ExcelAgentPlan | null {
  try {
    const value = JSON.parse(content) as Partial<ExcelAgentPlan>;
    if (
      value.action === "excel_execute" ||
      value.action === "answer_only" ||
      value.action === "ask_confirm"
    ) {
      return {
        action: value.action,
        command: normalizeExcelCommandName(value.command),
        sheet: typeof value.sheet === "string" ? value.sheet : null,
        output_path: typeof value.output_path === "string" ? value.output_path : null,
        args: isPlainObject(value.args) ? value.args : {},
        message: typeof value.message === "string" ? value.message : "",
      };
    }
  } catch {
    return null;
  }

  return null;
}

function normalizeExcelCommandName(command: unknown): ExcelCommandName | undefined {
  if (typeof command !== "string") return undefined;
  if (SUPPORTED_EXCEL_COMMANDS.has(command as ExcelCommandName)) return command as ExcelCommandName;

  return undefined;
}

function parseSpreadsheetSelectionSheet(selectionText: string) {
  const firstLine = selectionText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.toLowerCase().startsWith("sheet:"));

  return firstLine ? firstLine.slice("sheet:".length).trim() : "";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function executeExcelPlan({
  command,
  filePath,
  plan,
}: {
  command: ExcelCommandName;
  filePath: string;
  plan: ExcelAgentPlan;
}) {
  const response = await fetch(`${DOCUMENT_SERVICE_URL}/excel/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      command,
      file_path: filePath,
      sheet: plan.sheet || undefined,
      output_path: plan.output_path || undefined,
      save_to_disk: false,
      args: plan.args ?? {},
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Excel command failed (${response.status}): ${errorText}`);
  }

  return (await response.json()) as ExcelExecuteResponse;
}

function buildExcelExecutionStatus(plan: ExcelAgentPlan, result: ExcelExecuteResponse) {
  const details = [
    plan.message?.trim(),
    result.summary,
    result.saved_to_disk
      ? `已保存到：${result.output_path}`
      : "已更新预览，尚未保存；请按 Ctrl+S 或点击保存按钮写入磁盘。",
    `影响行数：${result.rows_affected}，影响单元格：${result.cells_affected}`,
    `输出文件：${result.output_path}`,
  ].filter(Boolean);

  return details.join("\n");
}

function getTextEditStatusMessage(operation: TextEditOperation, editText: string) {
  if (operation === "insert_after_selection") {
    return "\u5df2\u5728\u9009\u533a\u4e0b\u65b9\u65b0\u589e\u5185\u5bb9\u3002";
  }

  if (!editText.length) {
    return "\u5df2\u5220\u9664\u9009\u4e2d\u6587\u672c\u3002";
  }

  return "\u5df2\u66ff\u6362\u9009\u4e2d\u6587\u672c\u3002";
}

function extractAgentTextEditPayload(text: string) {
  const normalizedText = text.replace(/\r\n?/g, "\n");
  const lowerText = normalizedText.toLowerCase();
  const startTag = "<officeagent_edit>";
  const endTag = "</officeagent_edit>";
  const startIndex = lowerText.indexOf(startTag);

  if (startIndex >= 0) {
    const payloadStart = startIndex + startTag.length;
    const endIndex = lowerText.indexOf(endTag, payloadStart);
    const payload = endIndex >= 0 ? normalizedText.slice(payloadStart, endIndex) : normalizedText.slice(payloadStart);
    return trimEditPayloadWrapperLineBreaks(payload);
  }

  return stripMarkdownFence(normalizedText.trim());
}

function trimEditPayloadWrapperLineBreaks(text: string) {
  let payload = text;

  if (payload.startsWith("\n")) {
    payload = payload.slice(1);
  }

  if (payload.endsWith("\n")) {
    payload = payload.slice(0, -1);
  }

  return payload;
}

function stripMarkdownFence(text: string) {
  const fenceMatch = text.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  return fenceMatch ? fenceMatch[1] : text;
}

function isExplicitTextEditInstruction(instruction: string) {
  const normalizedInstruction = instruction.trim().toLowerCase();
  const compactInstruction = normalizedInstruction.replace(/\s+/g, "");

  if (!compactInstruction) {
    return false;
  }

  const explicitEditPatterns = [
    /^(帮我|请|麻烦|能否|可以)?(写|生成|新增|添加|插入|补充|改写|重写|修改|替换|删除|格式化)/,
    /^(帮我|请|麻烦|能否|可以)?(写一个|写一条|写一下)/,
    /把.+(改成|改为|替换成|删除|格式化|翻译成|转换成|转成)/,
    /(帮我写|请写|写一个|写一条|写一下|改成|改为|替换成|翻译成|转换成|转成)/,
  ];
  const commandContextKeywords = ["命令", "linux", "shell", "bash", "脚本", "cmd", "powershell"];

  if (explicitEditPatterns.some((pattern) => pattern.test(compactInstruction))) {
    return true;
  }

  return (
    commandContextKeywords.some((keyword) => compactInstruction.includes(keyword)) &&
    (compactInstruction.includes("同样功能") ||
      compactInstruction.includes("等价") ||
      compactInstruction.includes("一样功能"))
  );
}

function buildDeepSeekMessages(
  chatMessages: ChatMessage[],
  documentSelection: DocumentSelectionContext | null,
): DeepSeekApiMessage[] {
  const messages = chatMessages.map((message) => ({
    role: message.role,
    content: message.text,
  }));

  if (!documentSelection?.text.trim()) {
    return messages;
  }

  const rawSelectionText = documentSelection.text.trim();
  const selectionText = truncateSelectionContext(rawSelectionText);
  const isTruncated = rawSelectionText.length > MAX_SELECTION_CONTEXT_CHARS;
  const contextMessage: DeepSeekApiMessage = {
    role: "system",
    content: [
      "你是 OfficeAgent。用户正在针对文件预览页中选中的片段提问。",
      "请优先依据这个选中片段回答；如果问题需要片段以外的信息，请明确说明依据不足。",
      `文件名：${documentSelection.filename}`,
      `文件类型：${getSelectionSourceTypeLabel(documentSelection.sourceType)}`,
      `选中片段${isTruncated ? "（已截断）" : ""}：`,
      selectionText,
    ].join("\n"),
  };

  return [contextMessage, ...messages];
}

function truncateSelectionContext(text: string) {
  const trimmedText = text.trim();
  const context = trimmedText.slice(0, MAX_SELECTION_CONTEXT_CHARS);

  return context.length < trimmedText.length ? `${context}\n...[selection truncated]` : context;
}

function getSelectionSourceTypeLabel(sourceType: DocumentSelectionContext["sourceType"]) {
  if (sourceType === "pdf") return "PDF";
  if (sourceType === "spreadsheet") return "Excel";

  return "文本";
}

function getFileMimeType(filename: string) {
  const extension = filename.split(".").pop()?.toLowerCase();

  if (extension === "json") return "application/json";
  if (extension === "pdf") return "application/pdf";
  if (extension === "xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (extension === "xls") return "application/vnd.ms-excel";
  if (extension === "txt") return "text/plain";
  if (extension === "md") return "text/markdown";
  if (extension === "csv") return "text/csv";
  if (extension === "html") return "text/html";
  if (extension === "ts" || extension === "tsx") return "text/typescript";

  return "text/plain";
}

function decodeBase64Bytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function getFileRelativePath(file: File) {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
}

function normalizeFilePath(path: string) {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

function isTauriUnavailable(message: string) {
  const normalized = message.toLowerCase();
  return normalized.includes("tauri") || normalized.includes("__tauri");
}

function canUseTauriEvents() {
  if (typeof window === "undefined") return false;

  return "__TAURI_INTERNALS__" in window || "__TAURI_IPC__" in window || "__TAURI__" in window;
}

export default App;
