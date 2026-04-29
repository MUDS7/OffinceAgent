import {
  ArrowUp,
  ChevronDown,
  Check,
  Edit3,
  Hand,
  Maximize2,
  Paperclip,
  RefreshCw,
  Settings2,
  Sparkles,
  X,
} from "lucide-react";
import { useState } from "react";

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

const modelOptions = [
  { id: "deepseek-v3", label: "deepseek v3" },
  { id: "deepseek-v4", label: "deepseek v4" },
];

export function RightPanel({
  chatMessages,
  codexWidth,
  draftMessage,
  onDraftMessageChange,
  onOpenFilePicker,
  onSendMessage,
}: RightPanelProps) {
  const [selectedModel, setSelectedModel] = useState("deepseek-v3");
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const selectedModelLabel = modelOptions.find((option) => option.id === selectedModel)?.label ?? modelOptions[0].label;

  return (
    <aside
      className={codexWidth === 0 ? "codex-pane collapsed" : "codex-pane"}
      aria-label="Codex 面板"
      aria-hidden={codexWidth === 0}
    >
      <div className="codex-top">
        <div className="codex-tabs">
          <button className="active" type="button">
            聊天
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
            placeholder="问 Agent 任何事。输入 @ 使用插件或提及文件"
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
            <div
              className="permission-menu"
              onBlur={(event) => {
                const nextTarget = event.relatedTarget;
                if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
                  setIsModelMenuOpen(false);
                }
              }}
            >
              <button
                className="permission-trigger"
                type="button"
                aria-haspopup="listbox"
                aria-expanded={isModelMenuOpen}
                onClick={() => setIsModelMenuOpen((isOpen) => !isOpen)}
              >
                <Hand size={16} />
                <span>{selectedModelLabel}</span>
                <ChevronDown className={isModelMenuOpen ? "chevron-open" : undefined} size={15} />
              </button>
              {isModelMenuOpen ? (
                <div className="permission-popover" role="listbox" aria-label="模型选择">
                  {modelOptions.map((option) => {
                    const isSelected = option.id === selectedModel;

                    return (
                      <button
                        className="permission-option"
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        key={option.id}
                        onClick={() => {
                          setSelectedModel(option.id);
                          setIsModelMenuOpen(false);
                        }}
                      >
                        <Hand size={17} />
                        <span>{option.label}</span>
                        {isSelected ? <Check size={18} /> : <span className="permission-check-spacer" />}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
            <button className="send-button" type="button" onClick={onSendMessage} disabled={!draftMessage.trim()} title="发送">
              <ArrowUp size={22} />
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
