import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { BINARY_PREVIEW_EXTENSIONS, DOCUMENT_EXTENSIONS, DOCUMENT_SERVICE_URL } from "./constants";
import type {
  AgentInfo,
  AgentFileChange,
  AgentTextEditResult,
  AgentFileChangeSet,
  AnalyzeResult,
  ChatMessage,
  DeepSeekStreamEvent,
  DocumentSelectionContext,
  DocxCommandsResponse,
  DocxExecuteResponse,
  ExcelCommandsResponse,
  ExcelExecuteResponse,
  LayoutWidths,
  ResizeTarget,
  ServiceStatus,
  TextEditOperation,
  TextSelectionIntentAction,
  WorkspaceFile,
} from "./types";
import {
  buildExcelAgentMessages,
  buildExcelExecutionStatus,
  buildUnavailableExcelCommandMessage,
  executeExcelPlan,
  fetchExcelCommandSpecs,
  isExcelCommandAvailable,
  normalizeExcelCommandName,
  parseExcelAgentPlan,
  parseSpreadsheetSelectionSheet,
} from "./utils/excelAgent";
import {
  buildDocxAgentMessages,
  buildDocxExecutionStatus,
  buildUnavailableDocxCommandMessage,
  executeDocxPlan,
  fetchDocxCommandSpecs,
  isDocxCommandAvailable,
  normalizeDocxCommandName,
  parseDocxAgentPlan,
  shouldUseDocxAgent,
} from "./utils/docxAgent";
import {
  buildDeepSeekMessages,
  buildTextEditAgentRequest,
  classifyTextSelectionIntent,
  extractAgentTextEditPayload,
  getTextEditStatusMessage,
  shouldUseSpreadsheetAgent,
  stripMarkdownFence,
} from "./utils/chatMessages";
import { decodeBase64Bytes, getFileMimeType, getFileRelativePath, normalizeFilePath } from "./utils/fileUtils";
import { buildCompressedFileContext } from "./utils/fileContext";
import type { CompressedFileContext } from "./utils/fileContext";
import type { SaveFileProvider } from "./components/center-pane/types";
import { restoreTextEditPayload } from "./utils/textCompression";
import type { TextEditContentEncoding } from "./utils/textCompression";
import {
  getInitialLayoutWidths,
  getUiScale,
  MIN_CODEX_WIDTH,
  MIN_EXPLORER_WIDTH,
  normalizePanelWidth,
} from "./utils/layoutUtils";
import { canUseTauriEvents, isTauriUnavailable } from "./utils/tauriUtils";

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
  const [pendingTextRestore, setPendingTextRestore] = useState<{ id: string; fileId: string; text: string } | null>(
    null,
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const saveFileProvidersRef = useRef<Record<string, SaveFileProvider>>({});
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
      const supported = entries.filter(isSupportedPreviewPath);
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
          const relativePath = buildFolderRelativePath(folderPath, rootName, filePath);
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
      const knownPaths = new Map(
        workspaceFiles
          .filter((item) => item.diskPath)
          .map((item) => [normalizeFilePath(item.diskPath as string).toLowerCase(), item]),
      );
      const firstFileToOpen =
        nextFiles.find((item) => !knownPaths.has(normalizeFilePath(item.diskPath ?? "").toLowerCase())) ??
        knownPaths.get(normalizeFilePath(nextFiles[0].diskPath ?? "").toLowerCase()) ??
        nextFiles[0];

      setWorkspaceName((currentName) => (workspaceFiles.length ? currentName : rootName));
      setWorkspaceFiles((current) => {
        const currentPaths = new Set(
          current
            .map((item) => item.diskPath)
            .filter((path): path is string => Boolean(path))
            .map((path) => normalizeFilePath(path).toLowerCase()),
        );

        return [
          ...current,
          ...nextFiles.filter((item) => !currentPaths.has(normalizeFilePath(item.diskPath ?? "").toLowerCase())),
        ];
      });
      openWorkspaceFile(firstFileToOpen.id);
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

    const selectedFiles = Array.from(files).filter((file) => isSupportedPreviewPath(getFileRelativePath(file) || file.name));
    if (!selectedFiles.length) {
      setErrorMessage("该文件夹中没有支持预览的文件类型");
      return;
    }

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

    const knownKeys = new Map(workspaceFiles.map((item) => [getWorkspaceFileKey(item), item]));
    const firstFileToOpen =
      nextFiles.find((item) => !knownKeys.has(getWorkspaceFileKey(item))) ??
      knownKeys.get(getWorkspaceFileKey(nextFiles[0])) ??
      nextFiles[0];

    setWorkspaceName((currentName) => (workspaceFiles.length ? currentName : rootName));
    setWorkspaceFiles((current) => {
      const currentKeys = new Set(current.map(getWorkspaceFileKey));
      return [...current, ...nextFiles.filter((item) => !currentKeys.has(getWorkspaceFileKey(item)))];
    });
    openWorkspaceFile(firstFileToOpen.id);
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

  function updateSpreadsheetFile(fileId: string, file: File) {
    setWorkspaceFiles((current) =>
      current.map((item) => (item.id === fileId ? { ...item, file, analysis: null } : item)),
    );
    setDirtyFileIds((current) => {
      if (current.includes(fileId)) return current;
      return [...current, fileId];
    });
  }

  const registerSaveFileProvider = useCallback((fileId: string, provider: SaveFileProvider) => {
    saveFileProvidersRef.current[fileId] = provider;

    return () => {
      if (saveFileProvidersRef.current[fileId] === provider) {
        delete saveFileProvidersRef.current[fileId];
      }
    };
  }, []);

  async function saveWorkspaceFile(fileId: string, fileOverride?: File) {
    const currentItem = workspaceFiles.find((item) => item.id === fileId);
    if (!currentItem) return;

    let fileToSave = fileOverride;
    const saveFileProvider = saveFileProvidersRef.current[fileId];
    if (!fileToSave && saveFileProvider) {
      try {
        fileToSave = (await saveFileProvider()) ?? undefined;
      } catch (error) {
        setErrorMessage(`保存前生成文件失败（文件：${currentItem.file.name}）：${getErrorMessage(error)}`);
        return;
      }
    }

    const sourceFile = fileToSave ?? currentItem.file;
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
        setErrorMessage(`保存对话框打开失败（文件：${currentItem.file.name}）：${getErrorMessage(error)}`);
        return;
      }
    }

    if (!filePath) {
      setErrorMessage("无法确定保存路径，请在 Tauri 桌面端使用此功能");
      return;
    }

    let savedContent: BlobPart = sourceFile;
    try {
      if (isTextSave) {
        const textToSave = unsavedText ?? (await sourceFile.text());
        savedContent = textToSave;
        await invoke("save_file_to_disk", { path: filePath, content: textToSave });
      } else {
        const bytesToSave = Array.from(new Uint8Array(await sourceFile.arrayBuffer()));
        savedContent = new Uint8Array(bytesToSave);
        await invoke("save_file_bytes", { path: filePath, content: bytesToSave });
      }
    } catch (error) {
      setErrorMessage(
        `保存文件到磁盘失败（文件：${currentItem.file.name}；路径：${filePath}；` +
          `模式：${isTextSave ? "文本" : "二进制"}；大小：${formatFileSize(savedContent)}）：${getErrorMessage(error)}`,
      );
      return;
    }

    // Persist diskPath so subsequent Ctrl+S saves go straight to disk without a dialog.
    const resolvedDiskPath = filePath;

    setWorkspaceFiles((wsFiles) =>
      wsFiles.map((item) => {
        if (item.id !== fileId) return item;

        const file =
          fileToSave && !isTextSave
            ? fileToSave
            : new File([savedContent], item.file.name, {
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
    fileContext: CompressedFileContext | null,
  ) {
    const targetFile = selectedWorkspaceFile;
    if (!targetFile) return;

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
        fileContext,
        chatMessages: nextMessages,
      });

      unlisten = await listen<DeepSeekStreamEvent>("deepseek-chat-stream", (event) => {
        const payload = event.payload;
        if (payload.stream_id !== streamId) return;

        if (payload.kind === "reasoning" && payload.content) {
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

    if (!targetFile.file.name.toLowerCase().endsWith(".xlsx")) {
      updateAssistantMessage(assistantMessageId, "当前 Excel 命令执行器只支持 .xlsx 文件，请先另存为 .xlsx 后再操作。");
      return;
    }

    if (!targetFile.diskPath) {
      updateAssistantMessage(assistantMessageId, "需要先通过桌面端文件选择器打开这个 Excel 文件，才能拿到真实磁盘路径并执行写入。");
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

  async function handleDocxAgentCommand(
    model: string,
    instruction: string,
    nextMessages: ChatMessage[],
    assistantMessageId: string,
    streamId: string,
    fileContext: CompressedFileContext | null,
  ) {
    const targetFile = selectedWorkspaceFile;
    if (!targetFile) return;

    let unlisten: (() => void) | null = null;
    let assistantText = "";
    let streamError = "";
    const selectionText = documentSelection?.sourceType === "docx" ? documentSelection.text : "";
    let commandSpecs: DocxCommandsResponse | null = null;

    try {
      commandSpecs = await fetchDocxCommandSpecs();
      const messages = buildDocxAgentMessages({
        commandSpecs,
        filename: targetFile.file.name,
        instruction,
        selectionText,
        fileContext,
        chatMessages: nextMessages,
      });

      unlisten = await listen<DeepSeekStreamEvent>("deepseek-chat-stream", (event) => {
        const payload = event.payload;
        if (payload.stream_id !== streamId) return;

        if (payload.kind === "reasoning" && payload.content) {
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

    const plan = parseDocxAgentPlan(assistantText);
    if (plan.action === "answer_only" || plan.action === "ask_confirm") {
      updateAssistantMessage(assistantMessageId, plan.message || stripMarkdownFence(assistantText.trim()) || "需要你再补充一下要修改的位置或内容。");
      return;
    }

    const command = normalizeDocxCommandName(plan.command);
    if (!command) {
      updateAssistantMessage(assistantMessageId, "模型没有返回可执行的 DOCX 命令，我没有改动文件。");
      return;
    }

    if (commandSpecs && !isDocxCommandAvailable(command, commandSpecs)) {
      updateAssistantMessage(assistantMessageId, buildUnavailableDocxCommandMessage(command));
      return;
    }

    const executionResult = await executeDocxPlan({
      command,
      file: targetFile.file,
      plan,
    });
    refreshDocxWorkspaceFile(targetFile, executionResult);

    updateAssistantMessage(
      assistantMessageId,
      buildDocxExecutionStatus(plan, executionResult),
    );
  }

  function updateAssistantMessage(assistantMessageId: string, text: string) {
    setChatMessages((current) =>
      current.map((message) => (message.id === assistantMessageId ? { ...message, text } : message)),
    );
  }

  function attachAgentFileChange(change: {
    assistantMessageId: string;
    editId: string;
    fileId: string;
    filePath?: string;
    filename: string;
    beforeText: string;
    afterText: string;
    wasDirtyBefore: boolean;
  }) {
    const stats = calculateLineChangeStats(change.beforeText, change.afterText);
    const fileChange: AgentFileChange = {
      id: change.editId,
      fileId: change.fileId,
      filePath: change.filePath,
      filename: change.filename,
      beforeText: change.beforeText,
      afterText: change.afterText,
      wasDirtyBefore: change.wasDirtyBefore,
      additions: stats.additions,
      deletions: stats.deletions,
    };
    const fileChangeSet: AgentFileChangeSet = {
      id: `change-set-${change.editId}`,
      status: "active",
      changes: [fileChange],
    };

    setPendingAgentTextEdit(null);
    setChatMessages((current) =>
      current.map((message) =>
        message.id === change.assistantMessageId
          ? {
              ...message,
              fileChangeSet,
            }
          : message,
      ),
    );
  }

  async function undoAgentFileChanges(messageId: string) {
    const changeSet = chatMessages.find((message) => message.id === messageId)?.fileChangeSet;
    if (!changeSet || changeSet.status !== "active") return;

    setErrorMessage("");

    try {
      for (const change of changeSet.changes) {
        if (change.filePath && !change.wasDirtyBefore && canUseTauriEvents()) {
          await invoke("save_file_to_disk", { path: change.filePath, content: change.beforeText });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrorMessage(`撤销文件改动失败：${message}`);
      return;
    }

    setWorkspaceFiles((current) =>
      current.map((item) => {
        const change = changeSet.changes.find((candidate) => candidate.fileId === item.id);
        if (!change || change.wasDirtyBefore) return item;

        const file = new File([change.beforeText], item.file.name, {
          type: item.file.type || getFileMimeType(item.file.name),
          lastModified: Date.now(),
        });

        return { ...item, file, analysis: null };
      }),
    );

    setUnsavedContents((current) => {
      const next = { ...current };

      for (const change of changeSet.changes) {
        if (change.wasDirtyBefore) {
          next[change.fileId] = change.beforeText;
        } else {
          delete next[change.fileId];
        }
      }

      return next;
    });

    setDirtyFileIds((current) => {
      const next = new Set(current);

      for (const change of changeSet.changes) {
        if (change.wasDirtyBefore) {
          next.add(change.fileId);
        } else {
          next.delete(change.fileId);
        }
      }

      return [...next];
    });

    const visibleChange = changeSet.changes.find((change) => change.fileId === selectedFileId);
    if (visibleChange) {
      setPendingTextRestore({
        id: `text-restore-${Date.now()}`,
        fileId: visibleChange.fileId,
        text: visibleChange.beforeText,
      });
    }

    setChatMessages((current) =>
      current.map((message) =>
        message.id === messageId && message.fileChangeSet
          ? {
              ...message,
              fileChangeSet: {
                ...message.fileChangeSet,
                status: "undone",
              },
            }
          : message,
      ),
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

  function refreshDocxWorkspaceFile(targetFile: WorkspaceFile, result: DocxExecuteResponse) {
    const content = decodeBase64Bytes(result.document_base64);
    const refreshedFile = new File([content], result.filename || targetFile.file.name, {
      type: getFileMimeType(result.filename || targetFile.file.name),
      lastModified: Date.now(),
    });

    setWorkspaceFiles((current) =>
      current.map((item) => (item.id === targetFile.id ? { ...item, file: refreshedFile, analysis: null } : item)),
    );
    setDirtyFileIds((current) => {
      if (current.includes(targetFile.id)) return current;
      return [...current, targetFile.id];
    });
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
      filename: string;
      start: number;
      end: number;
      operation: TextEditOperation;
      isFullDocument?: boolean;
      originalText: string;
      contentEncoding?: TextEditContentEncoding;
    } | null = null;
    let fileContext: CompressedFileContext | null = null;

    function applyAgentTextResult() {
      if (!textEditTarget || hasAppliedAgentText) return;
      const rawEditText = extractAgentTextEditPayload(assistantText);
      const editText =
        textEditTarget.operation === "replace_selection"
          ? restoreTextEditPayload(
              textEditTarget.filename,
              rawEditText,
              textEditTarget.originalText,
              textEditTarget.contentEncoding,
            )
          : rawEditText;
      if (textEditTarget.operation === "insert_after_selection" && !editText.length) return;

      hasAppliedAgentText = true;
      const statusText = textEditTarget.isFullDocument
        ? "已更新当前 JSON 文件。"
        : getTextEditStatusMessage(textEditTarget.operation, editText);
      setChatMessages((current) =>
        current.map((message) =>
          message.id === assistantMessageId && !message.text ? { ...message, text: statusText } : message,
        ),
      );
      setPendingAgentTextEdit({
        id: `agent-edit-${now}`,
        assistantMessageId,
        fileId: textEditTarget.fileId,
        start: textEditTarget.start,
        end: textEditTarget.end,
        replacementText: editText,
        operation: textEditTarget.operation,
      });
    }

    try {
      const shouldBuildFileContext =
        shouldUseDocxAgent(selectedWorkspaceFile) ||
        !documentSelection?.text.trim() ||
        documentSelection.sourceType === "text";
      if (shouldBuildFileContext) {
        try {
          fileContext = await buildCompressedFileContext(
            selectedWorkspaceFile,
            selectedWorkspaceFile ? unsavedContents[selectedWorkspaceFile.id] : undefined,
          );
        } catch (error) {
          console.warn("Failed to build compressed file context.", error);
        }
      }

      if (shouldUseSpreadsheetAgent(selectedWorkspaceFile)) {
        await handleSpreadsheetAgentCommand(model, text, nextMessages, assistantMessageId, streamId, fileContext);
        return;
      }

      if (shouldUseDocxAgent(selectedWorkspaceFile)) {
        await handleDocxAgentCommand(model, text, nextMessages, assistantMessageId, streamId, fileContext);
        return;
      }

      const textSelection = documentSelection ?? buildTextFileCursorSelection(selectedWorkspaceFile);
      let fullDocumentText: string | undefined;
      let intent = await classifyTextSelectionIntent(model, text, textSelection, fileContext);
      if (shouldUseJsonFullDocumentEdit(selectedWorkspaceFile, textSelection, text, intent)) {
        fullDocumentText = await readWorkspaceText(selectedWorkspaceFile);
        intent = "replace_selection";
      }

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

      const textEditRequest = buildTextEditAgentRequest(text, textSelection, intent, fileContext, fullDocumentText);
      textEditTarget =
        textEditRequest && textSelection
          ? {
              fileId: textSelection.fileId,
              filename: textSelection.filename,
              start: textEditRequest.start,
              end: textEditRequest.end,
              operation: textEditRequest.operation,
              isFullDocument: textEditRequest.isFullDocument,
              originalText: textEditRequest.isFullDocument ? fullDocumentText ?? "" : textSelection.text,
              contentEncoding: textEditRequest.contentEncoding,
            }
          : null;
      const apiMessages = textEditRequest ? [] : buildDeepSeekMessages(nextMessages, textSelection, fileContext);
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

  function buildTextFileCursorSelection(file: WorkspaceFile | null): DocumentSelectionContext | null {
    if (!isTextWorkspaceFile(file)) return null;

    return {
      fileId: file.id,
      filePath: file.diskPath ?? file.file.name,
      filename: file.file.name,
      sourceType: "text",
      start: 0,
      end: 0,
      text: "",
    };
  }

  function shouldUseJsonFullDocumentEdit(
    file: WorkspaceFile | null,
    selection: DocumentSelectionContext | null,
    instruction: string,
    intent: TextSelectionIntentAction,
  ) {
    if (!isJsonWorkspaceFile(file)) return false;
    if (selection?.sourceType !== "text" || selection.text.trim()) return false;
    if (intent === "answer_only") return false;

    return intent !== "ask_confirm" || isLikelyJsonEditInstruction(instruction);
  }

  async function readWorkspaceText(file: WorkspaceFile | null) {
    if (!file) return "";

    return unsavedContents[file.id] ?? (await file.file.text());
  }

  function isJsonWorkspaceFile(file: WorkspaceFile | null): file is WorkspaceFile {
    return file?.file.name.toLowerCase().endsWith(".json") ?? false;
  }

  function isTextWorkspaceFile(file: WorkspaceFile | null): file is WorkspaceFile {
    if (!file) return false;

    const filename = file.file.name.toLowerCase();
    if (file.file.type.startsWith("text/")) return true;

    return [".txt", ".md", ".csv", ".json", ".js", ".jsx", ".ts", ".tsx", ".html", ".css", ".xml", ".yaml", ".yml"].some(
      (extension) => filename.endsWith(extension),
    );
  }

  function isLikelyJsonEditInstruction(instruction: string) {
    const normalized = instruction.toLowerCase();
    const editKeywords = [
      "修改",
      "改",
      "更新",
      "调整",
      "修复",
      "整理",
      "格式化",
      "重写",
      "替换",
      "换成",
      "换为",
      "改成",
      "改为",
      "设为",
      "设置",
      "配置",
      "删除",
      "移除",
      "新增",
      "添加",
      "增加",
      "加",
      "补充",
      "补上",
      "modify",
      "edit",
      "update",
      "change",
      "fix",
      "format",
      "rewrite",
      "replace",
      "set",
      "configure",
      "delete",
      "remove",
      "add",
      "insert",
      "append",
    ];

    return editKeywords.some((keyword) => normalized.includes(keyword));
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
          onOpenFolderPicker={openFolderPicker}
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
          pendingTextRestore={pendingTextRestore}
          previewTabs={openPreviewTabs}
          unsavedText={unsavedContents[selectedFileId]}
          onAgentTextEditApplied={attachAgentFileChange}
          onClosePreviewTab={closePreviewTab}
          onRefreshStatus={refreshStatus}
          onRegisterSaveFileProvider={registerSaveFileProvider}
          onSelectionContextChange={setDocumentSelection}
          onSelectPreviewTab={setSelectedFileId}
          onUpdateSpreadsheetFile={updateSpreadsheetFile}
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
          onClearChat={() => setChatMessages([])}
          onDraftMessageChange={setDraftMessage}
          onOpenFilePicker={openFilePicker}
          onUndoFileChanges={undoAgentFileChanges}
          onSendMessage={sendMessage}
        />
      </section>
    </main>
  );
}

function isSupportedPreviewPath(path: string) {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return DOCUMENT_EXTENSIONS.includes(extension);
}

function buildFolderRelativePath(folderPath: string, rootName: string, filePath: string) {
  const normalizedFolderPath = normalizeFilePath(folderPath).replace(/\/+$/, "");
  const normalizedFilePath = normalizeFilePath(filePath);

  if (normalizedFilePath.toLowerCase().startsWith(`${normalizedFolderPath.toLowerCase()}/`)) {
    return `${rootName}/${normalizedFilePath.slice(normalizedFolderPath.length + 1)}`;
  }

  return `${rootName}/${normalizedFilePath.split("/").pop() ?? normalizedFilePath}`;
}

function getWorkspaceFileKey(fileItem: WorkspaceFile) {
  if (fileItem.diskPath) return `disk:${normalizeFilePath(fileItem.diskPath).toLowerCase()}`;
  if (fileItem.relativePath) return `relative:${normalizeFilePath(fileItem.relativePath).toLowerCase()}`;
  return `file:${fileItem.file.name.toLowerCase()}:${fileItem.file.size}:${fileItem.file.lastModified}`;
}

function calculateLineChangeStats(beforeText: string, afterText: string) {
  const beforeLines = splitComparableLines(beforeText);
  const afterLines = splitComparableLines(afterText);
  let prefixLength = 0;

  while (
    prefixLength < beforeLines.length &&
    prefixLength < afterLines.length &&
    beforeLines[prefixLength] === afterLines[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < beforeLines.length - prefixLength &&
    suffixLength < afterLines.length - prefixLength &&
    beforeLines[beforeLines.length - 1 - suffixLength] === afterLines[afterLines.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  return {
    additions: Math.max(0, afterLines.length - prefixLength - suffixLength),
    deletions: Math.max(0, beforeLines.length - prefixLength - suffixLength),
  };
}

function splitComparableLines(text: string) {
  if (!text.length) return [];

  const normalizedText = text.replace(/\r\n?/g, "\n");
  const withoutFinalEmptyLine = normalizedText.endsWith("\n")
    ? normalizedText.slice(0, -1)
    : normalizedText;

  return withoutFinalEmptyLine.length ? withoutFinalEmptyLine.split("\n") : [];
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function formatFileSize(content: BlobPart) {
  if (typeof content === "string") {
    return `${new Blob([content]).size} bytes`;
  }

  if (content instanceof Blob) {
    return `${content.size} bytes`;
  }

  return `${content.byteLength} bytes`;
}

export default App;
