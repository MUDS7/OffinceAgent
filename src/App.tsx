import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  MessageSquareText,
  PanelRight,
  RefreshCw,
  Send,
  UploadCloud,
  UserRound,
  XCircle,
} from "lucide-react";

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
  analysis: AnalyzeResult | null;
};

type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
};

const DOCUMENT_SERVICE_URL = "http://127.0.0.1:8765";

const initialMessages: ChatMessage[] = [
  {
    id: "welcome",
    role: "assistant",
    text: "把文档放到左侧工作区后，我会在中间预览内容。右侧可以记录你对当前文档的处理要求。",
  },
];

function App() {
  const [agentInfo, setAgentInfo] = useState<AgentInfo | null>(null);
  const [serviceStatus, setServiceStatus] = useState<ServiceStatus | null>(null);
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFile[]>([]);
  const [selectedFileId, setSelectedFileId] = useState("");
  const [isChecking, setIsChecking] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(initialMessages);
  const [draftMessage, setDraftMessage] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const selectedWorkspaceFile = useMemo(
    () => workspaceFiles.find((item) => item.id === selectedFileId) ?? null,
    [workspaceFiles, selectedFileId],
  );

  const selectedAnalysis = selectedWorkspaceFile?.analysis ?? null;

  const canAnalyze = Boolean(selectedWorkspaceFile && serviceStatus?.running && !isAnalyzing);

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
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsChecking(false);
    }
  }

  function openFilePicker() {
    fileInputRef.current?.click();
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
    setSelectedFileId(nextFiles[0].id);
    setErrorMessage("");
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
      setChatMessages((current) => [
        ...current,
        {
          id: `analysis-${Date.now()}`,
          role: "assistant",
          text: `已完成 ${result.filename} 的文本预览，识别到 ${result.extension.toUpperCase()} 文件，大小 ${formatBytes(
            result.size_bytes,
          )}。`,
        },
      ]);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsAnalyzing(false);
    }
  }

  function sendMessage() {
    const text = draftMessage.trim();
    if (!text) return;

    const filename = selectedWorkspaceFile?.file.name ?? "当前工作区";
    setChatMessages((current) => [
      ...current,
      { id: `user-${Date.now()}`, role: "user", text },
      {
        id: `assistant-${Date.now() + 1}`,
        role: "assistant",
        text: selectedAnalysis
          ? `已记录对 ${filename} 的要求。当前版本先完成本地预览和任务记录，后续可以接入真正的对话模型来执行总结、改写或抽取。`
          : `已记录。先解析 ${filename}，中间预览区会显示可用于处理的文本内容。`,
      },
    ]);
    setDraftMessage("");
  }

  useEffect(() => {
    refreshStatus();
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

      <header className="menu-bar" aria-label="应用菜单">
        <div className="window-title">OfficeAgent</div>
        <nav className="menu-items" aria-label="顶部菜单">
          <button type="button" onClick={openFilePicker}>
            文件
          </button>
          <button type="button">编辑</button>
          <button type="button">查看</button>
          <button type="button">运行</button>
          <button type="button">帮助</button>
        </nav>
        <div className="menu-status">
          <span className={serviceStatus?.running ? "service-dot online" : "service-dot"} />
          {serviceStatus?.running ? "文档服务已连接" : "文档服务未连接"}
        </div>
      </header>

      <section className="workbench">
        <aside className="activity-bar" aria-label="活动栏">
          <button className="activity-button active" type="button" title="资源管理器">
            <FileText size={22} />
          </button>
          <button className="activity-button" type="button" title="对话">
            <MessageSquareText size={22} />
          </button>
          <button className="activity-button" type="button" title="右侧面板">
            <PanelRight size={22} />
          </button>
        </aside>

        <aside className="explorer-panel" aria-label="文件目录">
          <div className="panel-heading">
            <span>资源管理器</span>
            <button className="tool-button" type="button" onClick={openFilePicker} title="添加文件">
              <FilePlus2 size={16} />
            </button>
          </div>

          <div className="tree-section">
            <div className="tree-root">
              <ChevronDown size={16} />
              <FolderOpen size={16} />
              <span>本地工作区</span>
            </div>

            {workspaceFiles.length ? (
              <div className="file-list">
                {workspaceFiles.map((item) => (
                  <button
                    key={item.id}
                    className={item.id === selectedFileId ? "file-row selected" : "file-row"}
                    type="button"
                    onClick={() => setSelectedFileId(item.id)}
                  >
                    <FileText size={15} />
                    <span>{item.file.name}</span>
                    {item.analysis ? <Check size={14} /> : <Circle size={10} />}
                  </button>
                ))}
              </div>
            ) : (
              <button className="empty-tree-action" type="button" onClick={openFilePicker}>
                <UploadCloud size={18} />
                打开本地文档
              </button>
            )}
          </div>

          <div className="tree-section compact">
            <div className="tree-root muted">
              <ChevronRight size={16} />
              <Folder size={16} />
              <span>最近使用</span>
            </div>
          </div>
        </aside>

        <section className="preview-pane" aria-label="文件预览">
          <div className="editor-tabs">
            <div className="editor-tab active">
              <FileText size={15} />
              <span>{selectedWorkspaceFile?.file.name ?? "欢迎"}</span>
            </div>
          </div>

          <div className="editor-toolbar">
            <div>
              <strong>{selectedWorkspaceFile?.file.name ?? "尚未打开文件"}</strong>
              <span>
                {selectedAnalysis
                  ? `${selectedAnalysis.extension.toUpperCase()} · ${formatBytes(selectedAnalysis.size_bytes)}`
                  : "TXT / Markdown / CSV / JSON / PDF / DOCX"}
              </span>
            </div>
            <div className="toolbar-actions">
              <button className="tool-button" type="button" onClick={refreshStatus} title="刷新服务状态">
                {isChecking ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
              </button>
              <button className="run-button" type="button" onClick={analyzeDocument} disabled={!canAnalyze}>
                {isAnalyzing ? <Loader2 className="spin" size={16} /> : <UploadCloud size={16} />}
                解析预览
              </button>
            </div>
          </div>

          {errorMessage ? (
            <div className="error-line" role="alert">
              <XCircle size={16} />
              {errorMessage}
            </div>
          ) : null}

          <div className="editor-content">
            {selectedAnalysis ? (
              <>
                <pre>{selectedAnalysis.text_preview || "文档服务未抽取到可预览文本。"}</pre>
                {selectedAnalysis.warnings.length ? (
                  <ul className="warning-list">
                    {selectedAnalysis.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : (
              <div className="empty-editor">
                <FileText size={44} />
                <h1>{selectedWorkspaceFile ? "点击解析预览" : "打开一个本地文档"}</h1>
                <p>
                  {selectedWorkspaceFile
                    ? "文档已加入左侧目录，解析后会在这里显示文本预览和基础信息。"
                    : "使用顶部“文件”菜单或左侧按钮选择本地文档。"}
                </p>
              </div>
            )}
          </div>

          <footer className="status-bar">
            <span>{agentInfo?.runtime ?? "Tauri + Rust"}</span>
            <span>{serviceStatus?.endpoint ?? DOCUMENT_SERVICE_URL}</span>
            <span>{agentInfo?.version ?? "0.1.0"}</span>
          </footer>
        </section>

        <aside className="chat-pane" aria-label="对话界面">
          <div className="panel-heading chat-heading">
            <span>对话</span>
            <span>{selectedWorkspaceFile?.file.name ?? "未选择文件"}</span>
          </div>

          <div className="chat-messages">
            {chatMessages.map((message) => (
              <article key={message.id} className={`chat-message ${message.role}`}>
                <div className="avatar">{message.role === "assistant" ? <Bot size={16} /> : <UserRound size={16} />}</div>
                <p>{message.text}</p>
              </article>
            ))}
          </div>

          <div className="chat-input">
            <textarea
              value={draftMessage}
              placeholder="输入对当前文档的处理要求"
              rows={3}
              onChange={(event) => setDraftMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                  sendMessage();
                }
              }}
            />
            <button className="send-button" type="button" onClick={sendMessage} disabled={!draftMessage.trim()}>
              <Send size={16} />
            </button>
          </div>
        </aside>
      </section>
    </main>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default App;
