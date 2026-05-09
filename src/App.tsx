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
import { BINARY_PREVIEW_EXTENSIONS, DOCUMENT_EXTENSIONS, DOCUMENT_SERVICE_URL } from "./constants";
import type {
  AgentInfo,
  AgentTextEditResult,
  AnalyzeResult,
  ChatMessage,
  DeepSeekStreamEvent,
  DocumentSelectionContext,
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

  function updateSpreadsheetFile(fileId: string, file: File) {
    setWorkspaceFiles((current) =>
      current.map((item) => (item.id === fileId ? { ...item, file, analysis: null } : item)),
    );
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
      isFullDocument?: boolean;
    } | null = null;
    let fileContext: CompressedFileContext | null = null;

    function applyAgentTextResult() {
      if (!textEditTarget || hasAppliedAgentText) return;
      const editText = extractAgentTextEditPayload(assistantText);
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
        fileId: textEditTarget.fileId,
        start: textEditTarget.start,
        end: textEditTarget.end,
        replacementText: editText,
        operation: textEditTarget.operation,
      });
    }

    try {
      if (!documentSelection?.text.trim()) {
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

      const textSelection = documentSelection ?? buildJsonFileCursorSelection(selectedWorkspaceFile);
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
              start: textEditRequest.start,
              end: textEditRequest.end,
              operation: textEditRequest.operation,
              isFullDocument: textEditRequest.isFullDocument,
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

  function buildJsonFileCursorSelection(file: WorkspaceFile | null): DocumentSelectionContext | null {
    if (!isJsonWorkspaceFile(file)) return null;

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
      "删除",
      "移除",
      "新增",
      "添加",
      "增加",
      "加",
      "modify",
      "edit",
      "update",
      "change",
      "fix",
      "format",
      "rewrite",
      "replace",
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
          onSendMessage={sendMessage}
        />
      </section>
    </main>
  );
}

export default App;
