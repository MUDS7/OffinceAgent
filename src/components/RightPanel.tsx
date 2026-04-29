import {
  ArrowUp,
  ChevronDown,
  Check,
  Hand,
  Maximize2,
  Paperclip,
  Sparkles,
  X,
} from "lucide-react";
import type { KeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";

type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
};

type RightPanelProps = {
  chatMessages: ChatMessage[];
  codexWidth: number;
  draftMessage: string;
  isSendingMessage: boolean;
  onDraftMessageChange: (message: string) => void;
  onOpenFilePicker: () => void;
  onSendMessage: (model: string) => void;
};

const modelOptions = [
  { id: "deepseek-v3", label: "DeepSeek V3" },
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
];

export function RightPanel({
  chatMessages,
  codexWidth,
  draftMessage,
  isSendingMessage,
  onDraftMessageChange,
  onOpenFilePicker,
  onSendMessage,
}: RightPanelProps) {
  const [selectedModel, setSelectedModel] = useState("deepseek-v4-flash");
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const selectedModelLabel = modelOptions.find((option) => option.id === selectedModel)?.label ?? modelOptions[0].label;

  useEffect(() => {
    const historyElement = historyRef.current;
    if (!historyElement) return;

    historyElement.scrollTop = historyElement.scrollHeight;
  }, [chatMessages]);

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;

    event.preventDefault();
    onSendMessage(selectedModel);
  }

  return (
    <aside
      className={codexWidth === 0 ? "codex-pane collapsed" : "codex-pane"}
      aria-label="Codex panel"
      aria-hidden={codexWidth === 0}
    >
      <div className="codex-top">
        <div className="codex-tabs">
          <button className="active" type="button">
            Chat
          </button>
        </div>
        <div className="codex-window-actions">
          <Maximize2 size={17} />
          <X size={18} />
        </div>
      </div>

      <div className="task-list">
        <div className="task-title">Tasks</div>
      </div>

      <div className="codex-body">
        {chatMessages.length ? (
          <div className="floating-history" ref={historyRef}>
            {chatMessages.map((message) => (
              <article className={`chat-message ${message.role}`} key={message.id}>
                <p>{message.text}</p>
              </article>
            ))}
          </div>
        ) : (
          <div className="codex-empty-mark">
            <Sparkles size={36} />
          </div>
        )}
      </div>

      <div className="composer-wrap">
        <div className="chat-input">
          <textarea
            value={draftMessage}
            placeholder="Ask Agent anything. Type @ to mention files."
            rows={3}
            onChange={(event) => onDraftMessageChange(event.target.value)}
            onKeyDown={handleComposerKeyDown}
          />
          <div className="composer-actions">
            <button className="icon-button" type="button" title="Attach context" onClick={onOpenFilePicker}>
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
                <div className="permission-popover" role="listbox" aria-label="Model selection">
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
            <button
              className="send-button"
              type="button"
              onClick={() => onSendMessage(selectedModel)}
              disabled={!draftMessage.trim() || isSendingMessage}
              title="Send"
            >
              <ArrowUp size={22} />
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
