import {
  ArrowUp,
  ChevronDown,
  Check,
  ChevronRight,
  Hand,
  Maximize2,
  Paperclip,
  Sparkles,
  Table2,
  Undo2,
  X,
} from "lucide-react";
import type { KeyboardEvent } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentFileChangeSet, ChatMessage, DocumentSelectionContext } from "../types";
import "./RightPanel.css";

type RightPanelProps = {
  chatMessages: ChatMessage[];
  codexWidth: number;
  documentSelection: DocumentSelectionContext | null;
  draftMessage: string;
  isSendingMessage: boolean;
  onClearChat: () => void;
  onDraftMessageChange: (message: string) => void;
  onOpenFilePicker: () => void;
  onUndoFileChanges: (messageId: string) => void;
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
  documentSelection,
  draftMessage,
  isSendingMessage,
  onClearChat,
  onDraftMessageChange,
  onOpenFilePicker,
  onUndoFileChanges,
  onSendMessage,
}: RightPanelProps) {
  const [selectedModel, setSelectedModel] = useState("deepseek-v4-flash");
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const selectedModelLabel = modelOptions.find((option) => option.id === selectedModel)?.label ?? modelOptions[0].label;

  useLayoutEffect(() => {
    resizeComposerTextarea();
  }, [draftMessage]);

  useEffect(() => {
    const historyElement = historyRef.current;
    if (!historyElement) return;

    historyElement.scrollTop = historyElement.scrollHeight;
  }, [chatMessages]);

  function resizeComposerTextarea() {
    const textarea = composerTextareaRef.current;
    if (!textarea) return;

    textarea.style.height = "auto";

    const maxHeight = Number.parseFloat(getComputedStyle(textarea).maxHeight);
    const nextHeight = Number.isFinite(maxHeight) ? Math.min(textarea.scrollHeight, maxHeight) : textarea.scrollHeight;

    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > nextHeight ? "auto" : "hidden";
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;

    if (event.altKey) {
      event.preventDefault();

      const textarea = event.currentTarget;
      const selectionStart = textarea.selectionStart;
      const selectionEnd = textarea.selectionEnd;
      const nextMessage = `${draftMessage.slice(0, selectionStart)}\n${draftMessage.slice(selectionEnd)}`;
      const nextCursorPosition = selectionStart + 1;

      onDraftMessageChange(nextMessage);
      requestAnimationFrame(() => {
        textarea.setSelectionRange(nextCursorPosition, nextCursorPosition);
      });
      return;
    }

    if (event.shiftKey) return;

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
            Agent
          </button>
        </div>
        <div className="codex-window-actions">
          <button
            className="new-chat-button"
            type="button"
            title="新建对话框"
            aria-label="新建对话框"
            onClick={onClearChat}
          >
            +
          </button>
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
                <ChatMessageContent message={message} onUndoFileChanges={onUndoFileChanges} />
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
        {documentSelection?.text.trim() ? (
          <div className="selection-context-pill" title={documentSelection.text}>
            <FileTextIcon sourceType={documentSelection.sourceType} />
            <span>
              {documentSelection.filename} · 已选中 {documentSelection.text.length} 字
            </span>
          </div>
        ) : null}
        <div className="chat-input">
          <textarea
            ref={composerTextareaRef}
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

function ChatMessageContent({
  message,
  onUndoFileChanges,
}: {
  message: ChatMessage;
  onUndoFileChanges: (messageId: string) => void;
}) {
  const isAssistant = message.role === "assistant";
  const hasReasoning = Boolean(message.reasoningText?.trim());
  const hasText = Boolean(message.text.trim());

  if (!isAssistant) {
    return <p>{message.text}</p>;
  }

  return (
    <div className="assistant-message-content">
      {hasReasoning ? <p className="assistant-reasoning">{message.reasoningText}</p> : null}
      {hasText ? <p className={message.contentTone === "file-edit" ? "assistant-file-edit" : undefined}>{message.text}</p> : null}
      {message.fileChangeSet ? (
        <AgentFileChangeTag
          changeSet={message.fileChangeSet}
          onUndo={() => onUndoFileChanges(message.id)}
        />
      ) : null}
      {!hasReasoning && !hasText ? <p className="assistant-placeholder" /> : null}
    </div>
  );
}

function AgentFileChangeTag({
  changeSet,
  onUndo,
}: {
  changeSet: AgentFileChangeSet;
  onUndo: () => void;
}) {
  const [isExpanded, setIsExpanded] = useState(true);
  const totals = changeSet.changes.reduce(
    (sum, change) => ({
      additions: sum.additions + change.additions,
      deletions: sum.deletions + change.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
  const isUndone = changeSet.status === "undone";

  return (
    <div className={isUndone ? "agent-file-change-card undone" : "agent-file-change-card"}>
      <div className="agent-file-change-summary">
        <button
          className={isExpanded ? "agent-file-change-toggle expanded" : "agent-file-change-toggle"}
          type="button"
          aria-label={isExpanded ? "收起文件改动" : "展开文件改动"}
          onClick={() => setIsExpanded((current) => !current)}
        >
          <ChevronRight size={17} />
        </button>
        <span className="agent-file-change-count">{changeSet.changes.length} 个文件已更改</span>
        {totals.additions ? <span className="agent-file-change-additions">+{totals.additions}</span> : null}
        {totals.deletions ? <span className="agent-file-change-deletions">-{totals.deletions}</span> : null}
        <button
          className="agent-file-change-undo"
          type="button"
          disabled={isUndone}
          onClick={onUndo}
          title={isUndone ? "已撤销" : "撤销本次文件改动"}
        >
          {isUndone ? "已撤销" : "撤销"} <Undo2 size={15} />
        </button>
      </div>

      {isExpanded ? (
        <div className="agent-file-change-files">
          {changeSet.changes.map((change) => (
            <div className="agent-file-change-file" key={change.id}>
              <span title={change.filePath || change.filename}>{change.filePath || change.filename}</span>
              {change.additions ? <span className="agent-file-change-additions">+{change.additions}</span> : null}
              {change.deletions ? <span className="agent-file-change-deletions">-{change.deletions}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FileTextIcon({ sourceType }: { sourceType: DocumentSelectionContext["sourceType"] }) {
  if (sourceType === "spreadsheet") return <Table2 size={15} />;

  return sourceType === "pdf" ? <Paperclip size={15} /> : <Sparkles size={15} />;
}
