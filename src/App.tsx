import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bot,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleUserRound,
  Code2,
  Copy,
  Edit3,
  FilePlus2,
  FileText,
  Files,
  Folder,
  GitBranch,
  Hand,
  Info,
  Loader2,
  Maximize2,
  MoreHorizontal,
  Paperclip,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  Settings2,
  Share2,
  Sparkles,
  SplitSquareVertical,
  X,
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

const fallbackDocument = `# OfficeAgent

Tauri + React + Rust + Python 文档处理服务的桌面 Agent 项目骨架。

## 结构

\`\`\`text
.
|- src/                         # React + Vite 前端
|- src-tauri/                   # Tauri v2 Rust 本地命令层
|- services/document-service/   # Python FastAPI 文档处理服务
|- scripts/                     # Windows PowerShell 启动脚本
\`\`\`

## 初始化环境

\`\`\`powershell
.\\scripts\\setup.ps1
\`\`\`

如果当前机器的 Python 不能创建 venv，脚本会自动把依赖安装到
\`services/document-service/.packages\`，\`run.py\` 会在启动时加载这个目录。

等价手动命令：

\`\`\`powershell
npm install
python -m venv services/document-service/.venv
services/document-service/.venv/Scripts/python.exe -m pip install -r services/document-service/requirements.txt
\`\`\`

venv 不可用时：

\`\`\`powershell
python -m pip install --upgrade --target services/document-service/.packages -r services/document-service/requirements.txt
\`\`\`

## 开发启动

\`\`\`powershell
.\\scripts\\dev.ps1
\`\`\`
`;

const explorerFolders = ["dist", "node_modules", "scripts", "services", "src", "src-tauri"];
const explorerFiles = [".gitignore", "index.html", "package-lock.json", "package.json", "README.md", "tsconfig.json", "tsconfig.node.json", "vite.config.ts"];
const taskItems = [
  { title: "调整为 VSCode 布局", time: "14 小时" },
  { title: "创建 agent 项目结构", time: "15 小时" },
  { title: "创建 agent 项目结构与环境", time: "15 小时" },
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
  const editorText = selectedAnalysis?.text_preview || fallbackDocument;
  const editorLines = useMemo(() => editorText.split(/\r?\n/), [editorText]);
  const activeFilename = selectedWorkspaceFile?.file.name ?? "README.md";

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
          : `已记录。先解析 ${filename}，中间编辑区会显示可用于处理的文本内容。`,
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
        <div className="app-mark">◆</div>
        <nav className="menu-items" aria-label="顶部菜单">
          <button type="button" onClick={openFilePicker}>
            文件(F)
          </button>
          <button type="button">编辑(E)</button>
          <button type="button">选择(S)</button>
          <button type="button">查看(V)</button>
          <button type="button">转到(G)</button>
          <button type="button">运行(R)</button>
          <button type="button">终端(T)</button>
          <button type="button">帮助(H)</button>
        </nav>
        <div className="command-center">
          <ArrowLeft size={16} />
          <ArrowRight size={16} />
          <span>OfficeAgent</span>
        </div>
        <div className="menu-status">
          <span className={serviceStatus?.running ? "service-dot online" : "service-dot"} />
          <strong>14</strong>
          <Share2 size={16} />
          <ChevronDown size={15} />
        </div>
      </header>

      <section className="workbench">
        <aside className="activity-bar" aria-label="活动栏">
          <div className="activity-top">
            <button className="activity-button active" type="button" title="资源管理器">
              <Files size={26} />
            </button>
            <button className="activity-button" type="button" title="搜索">
              <Search size={26} />
            </button>
            <button className="activity-button" type="button" title="源代码管理">
              <GitBranch size={25} />
            </button>
            <button className="activity-button" type="button" title="运行和调试">
              <Play size={25} />
            </button>
            <button className="activity-button" type="button" title="扩展">
              <Braces size={25} />
            </button>
          </div>
          <div className="activity-bottom">
            <button className="activity-button" type="button" title="账户">
              <CircleUserRound size={25} />
            </button>
            <button className="activity-button" type="button" title="管理">
              <Settings size={24} />
            </button>
          </div>
        </aside>

        <aside className="explorer-panel" aria-label="文件目录">
          <div className="panel-heading explorer-heading">
            <span>资源管理器</span>
            <MoreHorizontal size={17} />
          </div>

          <div className="tree-section">
            <div className="tree-root">
              <ChevronDown size={16} />
              <span>OFFICEAGENT</span>
            </div>

            <div className="file-list">
              {explorerFolders.map((name) => (
                <button className="file-row folder-row" type="button" key={name}>
                  <ChevronRight size={15} />
                  <Folder size={16} />
                  <span>{name}</span>
                </button>
              ))}

              {explorerFiles.map((name) => (
                <button
                  className={name === "README.md" && !selectedWorkspaceFile ? "file-row selected" : "file-row"}
                  type="button"
                  key={name}
                  onClick={name === "README.md" ? () => setSelectedFileId("") : undefined}
                >
                  <FileIcon filename={name} />
                  <span>{name}</span>
                </button>
              ))}

              {workspaceFiles.map((item) => (
                <button
                  key={item.id}
                  className={item.id === selectedFileId ? "file-row selected" : "file-row"}
                  type="button"
                  onClick={() => setSelectedFileId(item.id)}
                >
                  <FileText size={15} />
                  <span>{item.file.name}</span>
                  {item.analysis ? <Check size={14} /> : <Circle size={9} />}
                </button>
              ))}
            </div>
          </div>

          <button className="empty-tree-action" type="button" onClick={openFilePicker}>
            <FilePlus2 size={16} />
            打开本地文档
          </button>

          <div className="explorer-spacer" />

          {["大纲", "时间线", "RUST DEPENDENCIES"].map((name) => (
            <button className="collapsed-section" type="button" key={name}>
              <ChevronRight size={16} />
              <span>{name}</span>
            </button>
          ))}
        </aside>

        <section className="preview-pane" aria-label="文件预览">
          <div className="editor-action-strip">
            <div className="editor-tabs">
              <div className="editor-tab active">
                <Info size={15} />
                <span>{activeFilename}</span>
                <X size={15} />
              </div>
            </div>
            <div className="editor-actions">
              <Bot size={20} />
              <Copy size={19} />
              <RotateCcw size={19} />
              <RefreshCw className={isChecking ? "spin" : ""} size={19} onClick={refreshStatus} />
              <Code2 size={19} />
              <SplitSquareVertical size={19} />
              <MoreHorizontal size={19} />
            </div>
          </div>

          <div className="breadcrumbs">
            <Info size={15} />
            <span>{activeFilename}</span>
            <ChevronRight size={14} />
            <span>abc</span>
            <span># OfficeAgent</span>
            <ChevronRight size={14} />
            <span>abc ## Python 文档服务 API</span>
          </div>

          {errorMessage ? (
            <div className="error-line" role="alert">
              <XCircle size={16} />
              {errorMessage}
            </div>
          ) : null}

          <div className="editor-content">
            <div className="editor-scroll">
              <div className="line-numbers" aria-hidden="true">
                {editorLines.map((_, index) => (
                  <span key={index}>{index + 1}</span>
                ))}
              </div>
              <pre>{editorText}</pre>
              <div className="minimap" aria-hidden="true">
                {editorLines.slice(0, 48).map((line, index) => (
                  <span key={index} style={{ width: `${Math.max(12, Math.min(96, line.length * 1.8))}%` }} />
                ))}
              </div>
            </div>
          </div>

          <div className="editor-bottom">
            <button className="tool-text-button" type="button" onClick={analyzeDocument} disabled={!canAnalyze}>
              {isAnalyzing ? <Loader2 className="spin" size={16} /> : <FileText size={16} />}
              解析预览
            </button>
            {selectedAnalysis ? (
              <span>
                {selectedAnalysis.extension.toUpperCase()} · {formatBytes(selectedAnalysis.size_bytes)}
              </span>
            ) : (
              <span>Markdown</span>
            )}
          </div>
        </section>

        <aside className="codex-pane" aria-label="Codex 面板">
          <div className="codex-top">
            <div className="codex-tabs">
              <button type="button">聊天</button>
              <button className="active" type="button">
                CODEX
              </button>
            </div>
            <div className="codex-window-actions">
              <Maximize2 size={17} />
              <X size={18} />
            </div>
          </div>

          <div className="task-list">
            <div className="task-title">任务</div>
            {taskItems.map((item) => (
              <button className="task-row" type="button" key={item.title}>
                <span>{item.title}</span>
                <span>{item.time}</span>
              </button>
            ))}
            <button className="task-more" type="button">
              查看全部（50 个）
            </button>
          </div>

          <div className="codex-tools">
            <RefreshCw size={16} />
            <Settings2 size={16} />
            <Edit3 size={16} />
          </div>

          <div className="codex-body">
            <div className="codex-empty-mark">
              <Sparkles size={36} />
            </div>
            {chatMessages.length > 1 ? (
              <div className="floating-history">
                {chatMessages.slice(-2).map((message) => (
                  <article className={`chat-message ${message.role}`} key={message.id}>
                    <p>{message.text}</p>
                  </article>
                ))}
              </div>
            ) : null}
          </div>

          <div className="composer-wrap">
            <div className="chat-input">
              <textarea
                value={draftMessage}
                placeholder="问 Codex 任何事。输入 @ 使用插件或提及文件"
                rows={3}
                onChange={(event) => setDraftMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                    sendMessage();
                  }
                }}
              />
              <div className="composer-actions">
                <button className="icon-button" type="button" title="添加上下文" onClick={openFilePicker}>
                  <Paperclip size={19} />
                </button>
                <button className="permission-button" type="button">
                  <Hand size={16} />
                  默认权限
                  <ChevronDown size={15} />
                </button>
                <span className="model-select">5.5 高</span>
                <button className="send-button" type="button" onClick={sendMessage} disabled={!draftMessage.trim()} title="发送">
                  <ArrowUp size={22} />
                </button>
              </div>
            </div>
            <button className="local-mode" type="button">
              <span />
              本地模式
              <ChevronDown size={14} />
            </button>
          </div>
        </aside>
      </section>

      <footer className="status-bar">
        <div>
          <GitBranch size={15} />
          <span>main</span>
          <RefreshCw size={14} />
          <span>Launchpad</span>
          <XCircle size={15} />
          <span>0</span>
          <Info size={15} />
          <span>0</span>
        </div>
        <div>
          <span>行 103，列 1</span>
          <span>空格: 4</span>
          <span>UTF-8</span>
          <span>CRLF</span>
          <Braces size={15} />
          <span>{agentInfo?.runtime ?? "Markdown"}</span>
        </div>
      </footer>
    </main>
  );
}

function FileIcon({ filename }: { filename: string }) {
  if (filename.endsWith(".json")) return <Braces className="json-icon" size={15} />;
  if (filename.endsWith(".ts") || filename.endsWith(".tsx")) return <Code2 className="ts-icon" size={15} />;
  if (filename.endsWith(".html")) return <Code2 className="html-icon" size={15} />;
  if (filename === ".gitignore") return <GitBranch className="git-icon" size={15} />;
  return <FileText className="md-icon" size={15} />;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isTauriUnavailable(message: string) {
  const normalized = message.toLowerCase();
  return normalized.includes("tauri") || normalized.includes("__tauri");
}

export default App;
