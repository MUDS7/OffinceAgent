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
  analysis: AnalyzeResult | null;
};

type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
};

type DeepSeekApiMessage = {
  role: "assistant" | "system" | "user";
  content: string;
};

type DocumentSelectionContext = {
  fileId: string;
  filename: string;
  sourceType: "pdf" | "text";
  text: string;
};

type DeepSeekStreamEvent = {
  stream_id: string;
  kind: "start" | "delta" | "done" | "error";
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
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
        })),
    [openFileIds, selectedFileId, workspaceFiles],
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

  function openFilePicker() {
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }

    fileInputRef.current?.click();
  }

  function openFolderPicker() {
    if (folderInputRef.current) {
      folderInputRef.current.value = "";
    }

    folderInputRef.current?.click();
  }

  function handleFileSelection(files: FileList | null) {
    if (!files?.length) return;

    const nextFiles = Array.from(files).map((file) => ({
      id: `${file.name}-${file.size}-${file.lastModified}`,
      file,
      analysis: null,
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

      return {
        id: `${relativePath}-${file.size}-${file.lastModified}`,
        file,
        relativePath,
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
    setWorkspaceFiles((current) =>
      current.map((item) => {
        if (item.id !== fileId) return item;

        const file = new File([text], item.file.name, {
          type: item.file.type || getFileMimeType(item.file.name),
          lastModified: Date.now(),
        });

        return { ...item, file, analysis: null };
      }),
    );
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
    const apiMessages = buildDeepSeekMessages(nextMessages, documentSelection);

    setChatMessages([...nextMessages, assistantMessage]);
    setDraftMessage("");
    setIsSendingMessage(true);
    setErrorMessage("");

    let unlisten: (() => void) | null = null;

    try {
      unlisten = await listen<DeepSeekStreamEvent>("deepseek-chat-stream", (event) => {
        const payload = event.payload;
        if (payload.stream_id !== streamId) return;

        if (payload.kind === "delta" && payload.content) {
          setChatMessages((current) =>
            current.map((message) =>
              message.id === assistantMessageId ? { ...message, text: message.text + payload.content } : message,
            ),
          );
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
      });
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
          previewTabs={openPreviewTabs}
          onClosePreviewTab={closePreviewTab}
          onRefreshStatus={refreshStatus}
          onSelectionContextChange={setDocumentSelection}
          onSelectPreviewTab={setSelectedFileId}
          onUpdateTextFile={updateTextFile}
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

  const tauriWindow = window as Window & {
    __TAURI_INTERNALS__?: {
      transformCallback?: unknown;
    };
  };

  return typeof tauriWindow.__TAURI_INTERNALS__?.transformCallback === "function";
}

export default App;
