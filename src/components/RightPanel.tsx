import {
  ArrowUp,
  ChevronDown,
  Edit3,
  Hand,
  Maximize2,
  Paperclip,
  RefreshCw,
  Settings2,
  Sparkles,
  X,
} from "lucide-react";

type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
};

type RightPanelProps = {
  chatMessages: ChatMessage[];
  codexWidth: number;
  draftMessage: string;
  onDraftMessageChange: (message: string) => void;
  onOpenFilePicker: () => void;
  onSendMessage: () => void;
};

export function RightPanel({
  chatMessages,
  codexWidth,
  draftMessage,
  onDraftMessageChange,
  onOpenFilePicker,
  onSendMessage,
}: RightPanelProps) {
  return (
    <aside
      className={codexWidth === 0 ? "codex-pane collapsed" : "codex-pane"}
      aria-label="Codex 面板"
      aria-hidden={codexWidth === 0}
    >
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
        {chatMessages.length ? (
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
            onChange={(event) => onDraftMessageChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                onSendMessage();
              }
            }}
          />
          <div className="composer-actions">
            <button className="icon-button" type="button" title="添加上下文" onClick={onOpenFilePicker}>
              <Paperclip size={19} />
            </button>
            <button className="permission-button" type="button">
              <Hand size={16} />
              默认权限
              <ChevronDown size={15} />
            </button>
            <span className="model-select">5.5 高</span>
            <button className="send-button" type="button" onClick={onSendMessage} disabled={!draftMessage.trim()} title="发送">
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
  );
}
