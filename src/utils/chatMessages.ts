import { invoke } from "@tauri-apps/api/core";
import type {
  ChatMessage,
  DeepSeekApiMessage,
  DocumentSelectionContext,
  TextEditAgentRequest,
  TextEditOperation,
  TextSelectionIntentAction,
  TextSelectionIntentResult,
  WorkspaceFile,
} from "../types";
import { MAX_SELECTION_CONTEXT_CHARS } from "../constants";
import type { CompressedFileContext } from "./fileContext";
import { compressTextEditPayload } from "./textCompression";

// ─── DeepSeek message building ────────────────────────────────────────────────

export function buildDeepSeekMessages(
  chatMessages: ChatMessage[],
  documentSelection: DocumentSelectionContext | null,
  fileContext: CompressedFileContext | null = null,
): DeepSeekApiMessage[] {
  const messages = chatMessages.map((message) => ({
    role: message.role,
    content: message.text,
  }));

  if (!documentSelection?.text.trim()) {
    if (!fileContext?.content.trim()) {
      return messages;
    }

    const contextMessage: DeepSeekApiMessage = {
      role: "system",
      content: [
        "你是 OfficeAgent。用户正在针对当前打开的整个文件提问，但没有选中具体片段。",
        "请结合压缩后的文件内容和用户问题分析用户意图并回答；如果用户只是提问，不要建议修改文件。",
        "压缩规则：内容可能省略空白或超长部分；文本行号和 Excel 单元格地址用于定位原文件位置。",
        fileContext.isTruncated ? "注意：文件上下文已截断，回答时说明可能缺少后续内容。" : "",
        `文件名：${fileContext.filename}`,
        `文件类型：${getFileContextTypeLabel(fileContext.fileType)}`,
        "当前文件压缩上下文：",
        "<<<",
        fileContext.content,
        ">>>",
      ]
        .filter(Boolean)
        .join("\n"),
    };

    return [contextMessage, ...messages];
  }

  const rawSelectionText = documentSelection.text.trim();
  const selectionText = truncateSelectionContext(rawSelectionText);
  const isTruncated = rawSelectionText.length > MAX_SELECTION_CONTEXT_CHARS;
  const contextMessage: DeepSeekApiMessage = {
    role: "system",
    content: [
      "你是 OfficeAgent。用户在文件预览页中提供了选中文本作为上下文。",
      "请结合这个上下文回答；不要默认把选中文本理解为用户唯一关心或想要修改的对象。",
      `文件名：${documentSelection.filename}`,
      `文件类型：${getSelectionSourceTypeLabel(documentSelection.sourceType)}`,
      `选中片段${isTruncated ? "（已截断）" : ""}：`,
      selectionText,
    ].join("\n"),
  };

  return [contextMessage, ...messages];
}

export function truncateSelectionContext(text: string): string {
  const trimmedText = text.trim();
  const context = trimmedText.slice(0, MAX_SELECTION_CONTEXT_CHARS);
  return context.length < trimmedText.length ? `${context}\n...[selection truncated]` : context;
}

function getSelectionSourceTypeLabel(sourceType: DocumentSelectionContext["sourceType"]): string {
  if (sourceType === "docx") return "Word";
  if (sourceType === "pdf") return "PDF";
  if (sourceType === "spreadsheet") return "Excel";
  return "文本";
}

function getFileContextTypeLabel(sourceType: CompressedFileContext["fileType"]): string {
  if (sourceType === "docx") return "Word";
  if (sourceType === "pdf") return "PDF";
  if (sourceType === "spreadsheet") return "Excel";
  return "文本";
}

// ─── Text-edit intent classification ─────────────────────────────────────────

export async function classifyTextSelectionIntent(
  model: string,
  instruction: string,
  documentSelection: DocumentSelectionContext | null,
  fileContext: CompressedFileContext | null = null,
): Promise<TextSelectionIntentAction> {
  if (documentSelection?.sourceType !== "text") {
    return "answer_only";
  }

  let result: TextSelectionIntentResult;
  try {
    result = await invoke<TextSelectionIntentResult>("classify_text_selection_intent", {
      model,
      request: {
        filePath: documentSelection.filePath,
        filename: documentSelection.filename,
        selectedText: documentSelection.text,
        fileContext: fileContext?.content,
        instruction,
      },
    });
  } catch (error) {
    console.warn("Text selection intent classification failed; falling back to answer mode.", error);
    return "answer_only";
  }

  return normalizeTextSelectionIntent(result.intent);
}

function normalizeTextSelectionIntent(intent: string): TextSelectionIntentAction {
  if (
    intent === "replace_selection" ||
    intent === "insert_after_selection" ||
    intent === "ask_confirm" ||
    intent === "answer_only"
  ) {
    return intent;
  }
  return "answer_only";
}

// ─── Text-edit request building ───────────────────────────────────────────────

export function buildTextEditAgentRequest(
  instruction: string,
  documentSelection: DocumentSelectionContext | null,
  intent: TextSelectionIntentAction,
  fileContext: CompressedFileContext | null = null,
  fullDocumentText?: string,
): TextEditAgentRequest | null {
  if (
    (intent !== "replace_selection" && intent !== "insert_after_selection") ||
    documentSelection?.sourceType !== "text"
  ) {
    return null;
  }

  const shouldReplaceFullDocument =
    intent === "replace_selection" &&
    !documentSelection.text.trim() &&
    fullDocumentText !== undefined;
  const originalSelectedText = shouldReplaceFullDocument ? fullDocumentText : documentSelection.text;
  const compressedPayload = compressTextEditPayload(documentSelection.filename, originalSelectedText);
  const start = shouldReplaceFullDocument ? 0 : documentSelection.start ?? 0;
  const end = shouldReplaceFullDocument
    ? fullDocumentText.length
    : documentSelection.end ?? start + documentSelection.text.length;

  return {
    filePath: documentSelection.filePath,
    start,
    end,
    selectedText: compressedPayload.text,
    fileContext: shouldReplaceFullDocument || documentSelection.text.trim() ? undefined : fileContext?.content,
    isFullDocument: shouldReplaceFullDocument,
    contentEncoding: compressedPayload.encoding,
    instruction,
    operation: intent,
  };
}

// ─── Spreadsheet agent helpers ────────────────────────────────────────────────

export function shouldUseSpreadsheetAgent(selectedWorkspaceFile: WorkspaceFile | null): boolean {
  const filename = selectedWorkspaceFile?.file.name.toLowerCase() ?? "";
  return filename.endsWith(".xlsx") || filename.endsWith(".xls");
}

// ─── Agent text-edit result handling ─────────────────────────────────────────

export function getTextEditStatusMessage(
  operation: TextEditOperation,
  editText: string,
): string {
  if (operation === "insert_after_selection") {
    return "已在选区下方新增内容。";
  }
  if (!editText.length) {
    return "已删除选中文本。";
  }
  return "已替换选中文本。";
}

export function extractAgentTextEditPayload(text: string): string {
  const normalizedText = text.replace(/\r\n?/g, "\n");
  const lowerText = normalizedText.toLowerCase();
  const startTag = "<officeagent_edit>";
  const endTag = "</officeagent_edit>";
  const startIndex = lowerText.indexOf(startTag);

  if (startIndex >= 0) {
    const payloadStart = startIndex + startTag.length;
    const endIndex = lowerText.indexOf(endTag, payloadStart);
    const payload =
      endIndex >= 0
        ? normalizedText.slice(payloadStart, endIndex)
        : normalizedText.slice(payloadStart);
    return trimEditPayloadWrapperLineBreaks(payload);
  }

  return stripMarkdownFence(normalizedText.trim());
}

function trimEditPayloadWrapperLineBreaks(text: string): string {
  let payload = text;
  if (payload.startsWith("\n")) payload = payload.slice(1);
  if (payload.endsWith("\n")) payload = payload.slice(0, -1);
  return payload;
}

export function stripMarkdownFence(text: string): string {
  const fenceMatch = text.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  return fenceMatch ? fenceMatch[1] : text;
}
