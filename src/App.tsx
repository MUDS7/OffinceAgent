import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Activity,
  BrainCircuit,
  CheckCircle2,
  FileText,
  Loader2,
  Play,
  RefreshCw,
  Server,
  UploadCloud,
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

const DOCUMENT_SERVICE_URL = "http://127.0.0.1:8765";

function App() {
  const [agentInfo, setAgentInfo] = useState<AgentInfo | null>(null);
  const [serviceStatus, setServiceStatus] = useState<ServiceStatus | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [analysis, setAnalysis] = useState<AnalyzeResult | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const canAnalyze = useMemo(
    () => Boolean(selectedFile && serviceStatus?.running && !isAnalyzing),
    [selectedFile, serviceStatus?.running, isAnalyzing],
  );

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

  async function analyzeDocument() {
    if (!selectedFile) return;

    setIsAnalyzing(true);
    setAnalysis(null);
    setErrorMessage("");

    const body = new FormData();
    body.append("file", selectedFile);

    try {
      const response = await fetch(`${DOCUMENT_SERVICE_URL}/documents/analyze`, {
        method: "POST",
        body,
      });

      if (!response.ok) {
        throw new Error(`文档服务返回 ${response.status}`);
      }

      setAnalysis((await response.json()) as AnalyzeResult);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsAnalyzing(false);
    }
  }

  useEffect(() => {
    refreshStatus();
  }, []);

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <BrainCircuit size={24} aria-hidden="true" />
          </div>
          <div>
            <h1>OfficeAgent</h1>
            <p>{agentInfo?.version ?? "0.1.0"}</p>
          </div>
        </div>

        <nav className="nav-list" aria-label="主导航">
          <button className="nav-item active" type="button">
            <FileText size={18} aria-hidden="true" />
            文档处理
          </button>
          <button className="nav-item" type="button">
            <Activity size={18} aria-hidden="true" />
            运行状态
          </button>
        </nav>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Agent Console</p>
            <h2>文档处理工作台</h2>
          </div>
          <button className="icon-button" type="button" onClick={refreshStatus} title="刷新状态">
            {isChecking ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
          </button>
        </header>

        <section className="status-row" aria-label="服务状态">
          <div className="metric">
            <Server size={20} aria-hidden="true" />
            <div>
              <span>Python 服务</span>
              <strong className={serviceStatus?.running ? "ok" : "warn"}>
                {serviceStatus?.running ? "运行中" : "未连接"}
              </strong>
            </div>
          </div>
          <div className="metric">
            <CheckCircle2 size={20} aria-hidden="true" />
            <div>
              <span>Rust 命令层</span>
              <strong>{agentInfo?.runtime ?? "Tauri"}</strong>
            </div>
          </div>
          <div className="metric wide">
            <Activity size={20} aria-hidden="true" />
            <div>
              <span>Endpoint</span>
              <strong>{serviceStatus?.endpoint ?? DOCUMENT_SERVICE_URL}</strong>
            </div>
          </div>
        </section>

        <section className="document-panel">
          <div className="upload-zone">
            <UploadCloud size={34} aria-hidden="true" />
            <label htmlFor="document-file">选择文档</label>
            <input
              id="document-file"
              type="file"
              accept=".txt,.md,.csv,.json,.pdf,.docx"
              onChange={(event) => {
                setSelectedFile(event.target.files?.[0] ?? null);
                setAnalysis(null);
              }}
            />
            <span>{selectedFile ? selectedFile.name : "TXT / Markdown / CSV / JSON / PDF / DOCX"}</span>
          </div>

          <button className="primary-action" type="button" onClick={analyzeDocument} disabled={!canAnalyze}>
            {isAnalyzing ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
            开始处理
          </button>
        </section>

        {errorMessage ? <p className="error-line">{errorMessage}</p> : null}

        <section className="result-layout" aria-label="处理结果">
          <div className="result-block">
            <h3>文件信息</h3>
            <dl>
              <div>
                <dt>文件名</dt>
                <dd>{analysis?.filename ?? "-"}</dd>
              </div>
              <div>
                <dt>类型</dt>
                <dd>{analysis?.extension || "-"}</dd>
              </div>
              <div>
                <dt>大小</dt>
                <dd>{analysis ? `${analysis.size_bytes.toLocaleString()} bytes` : "-"}</dd>
              </div>
              <div>
                <dt>SHA-256</dt>
                <dd className="hash">{analysis?.sha256 ?? "-"}</dd>
              </div>
            </dl>
          </div>

          <div className="result-block">
            <h3>文本预览</h3>
            <pre>{analysis?.text_preview || "等待处理结果"}</pre>
            {analysis?.warnings.length ? (
              <ul className="warning-list">
                {analysis.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </section>
      </section>
    </main>
  );
}

export default App;
