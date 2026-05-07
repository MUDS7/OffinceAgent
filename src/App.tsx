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

type DocumentSelectionContext = {
  fileId: string;
  filePath: string;
  filename: string;
  sourceType: "pdf" | "text";
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
};

type TextSelectionIntentResult = {
  intent: "answer" | "edit";
};

type AgentTextEditResult = {
  id: string;
  fileId: string;
  start: number;
  end: number;
  replacementText: string;
  insertOnNextLine: boolean;
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
          filters: [{ name: "Documents", extensions: ["txt", "md", "csv", "json", "pdf"] }],
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
      const isPdf = extension === "pdf";
      try {
        const content = isPdf ? "" : await invoke<string>("read_file_text", { path: filePath });
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
      const supported = entries.filter((p) => /\.(txt|md|csv|json|pdf)$/i.test(p));
      if (!supported.length) {
        setErrorMessage("该文件夹中没有支持的文件类型");
        return;
      }
      const nextFiles: WorkspaceFile[] = [];
      for (const filePath of supported) {
        const filename = filePath.replace(/\\/g, "/").split("/").pop() ?? filePath;
        const extension = filename.split(".").pop()?.toLowerCase() ?? "";
        const isPdf = extension === "pdf";
        try {
          const content = isPdf ? "" : await invoke<string>("read_file_text", { path: filePath });
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

  async function saveTextFile(fileId: string) {
    const currentItem = workspaceFiles.find((item) => item.id === fileId);
    if (!currentItem) return;

    // Use unsaved (dirty) content if available; otherwise read the file's current content
    // so that Ctrl+S works even on unmodified files.
    const unsavedText = unsavedContents[fileId];
    let textToSave: string;
    if (unsavedText !== undefined) {
      textToSave = unsavedText;
    } else {
      try {
        textToSave = await currentItem.file.text();
      } catch {
        return;
      }
    }

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

    try {
      await invoke("save_file_to_disk", { path: filePath, content: textToSave });
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

        const file = new File([textToSave], item.file.name, {
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
      insertOnNextLine: boolean;
    } | null = null;

    function applyAgentTextResult() {
      if (!textEditTarget || hasAppliedAgentText || !assistantText.trim()) return;

      hasAppliedAgentText = true;
      setPendingAgentTextEdit({
        id: `agent-edit-${now}`,
        fileId: textEditTarget.fileId,
        start: textEditTarget.start,
        end: textEditTarget.end,
        replacementText: assistantText,
        insertOnNextLine: textEditTarget.insertOnNextLine,
      });
    }

    try {
      const intent = await classifyTextSelectionIntent(model, text, documentSelection);
      const textEditRequest = buildTextEditAgentRequest(text, documentSelection, intent);
      textEditTarget =
        textEditRequest && documentSelection
          ? {
              fileId: documentSelection.fileId,
              start: textEditRequest.start,
              end: textEditRequest.end,
              insertOnNextLine: !textEditRequest.selectedText.trim(),
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
        accept=".txt,.md,.csv,.json,.pdf,.docx"
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
          onSaveTextFile={saveTextFile}
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
  intent: TextSelectionIntentResult["intent"],
): TextEditAgentRequest | null {
  if (intent !== "edit" || documentSelection?.sourceType !== "text") {
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
  };
}

async function classifyTextSelectionIntent(
  model: string,
  instruction: string,
  documentSelection: DocumentSelectionContext | null,
): Promise<TextSelectionIntentResult["intent"]> {
  if (documentSelection?.sourceType !== "text") {
    return "answer";
  }

  if (isExplicitTextEditInstruction(instruction)) {
    return "edit";
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
    return "answer";
  }

  return result.intent === "edit" ? "edit" : "answer";
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
      `文件类型：${documentSelection.sourceType === "pdf" ? "PDF" : "文本"}`,
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

function getFileMimeType(filename: string) {
  const extension = filename.split(".").pop()?.toLowerCase();

  if (extension === "json") return "application/json";
  if (extension === "pdf") return "application/pdf";
  if (extension === "txt") return "text/plain";
  if (extension === "md") return "text/markdown";
  if (extension === "csv") return "text/csv";
  if (extension === "html") return "text/html";
  if (extension === "ts" || extension === "tsx") return "text/typescript";

  return "text/plain";
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
