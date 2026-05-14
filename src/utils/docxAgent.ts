import type {
  ChatMessage,
  DocxAgentPlan,
  DocxBlock,
  DocxCommandName,
  DocxCommandsResponse,
  DocxExecuteResponse,
  DocxParseResponse,
  WorkspaceFile,
} from "../types";
import {
  DOCUMENT_SERVICE_URL,
  DOCX_AGENT_SYSTEM_PROMPT,
  SUPPORTED_DOCX_COMMANDS,
} from "../constants";
import { truncateSelectionContext } from "./chatMessages";
import { buildUploadedDocumentReferenceSystemMessage } from "./documentReference";
import { fetchDocumentService } from "./documentService";
import type { CompressedFileContext } from "./fileContext";

export async function fetchDocxCommandSpecs(): Promise<DocxCommandsResponse> {
  const response = await fetchDocumentService(`${DOCUMENT_SERVICE_URL}/docx/commands`);
  if (!response.ok) {
    throw new Error(`DOCX command service returned ${response.status}`);
  }
  return (await response.json()) as DocxCommandsResponse;
}

export function getDocxCommandNames(commandSpecs: DocxCommandsResponse): Set<DocxCommandName> {
  return new Set([...commandSpecs.basic, ...commandSpecs.advanced].map((spec) => spec.command));
}

export function isDocxCommandAvailable(
  command: DocxCommandName,
  commandSpecs: DocxCommandsResponse,
): boolean {
  return getDocxCommandNames(commandSpecs).has(command);
}

export function buildUnavailableDocxCommandMessage(command: DocxCommandName): string {
  return [
    `当前文档服务还没有开放 ${command} 命令，我没有改动文件。`,
    "请重启 OfficeAgent 或文档服务后再试；如果是已打包版本，需要重新打包后使用新版服务。",
  ].join("\n");
}

export function buildDocxAgentMessages({
  commandSpecs,
  filename,
  instruction,
  selectionText,
  fileContext,
  uploadedDocumentReferenceContext,
  chatMessages,
}: {
  commandSpecs: DocxCommandsResponse;
  filename: string;
  instruction: string;
  selectionText: string;
  fileContext?: CompressedFileContext | null;
  uploadedDocumentReferenceContext?: string;
  chatMessages: ChatMessage[];
}) {
  const commandNames = [...getDocxCommandNames(commandSpecs)].join(", ");
  const commands = [...commandSpecs.basic, ...commandSpecs.advanced]
    .map((spec) => {
      const requiredArgs = spec.required_args.length ? spec.required_args.join(", ") : "none";
      const optionalArgs = spec.optional_args.length ? spec.optional_args.join(", ") : "none";
      return `- ${spec.command}: ${spec.description} Required args: ${requiredArgs}. Optional args: ${optionalArgs}.`;
    })
    .join("\n");
  const recentConversation = chatMessages
    .slice(-6)
    .map((message) => `${message.role}: ${message.text}`)
    .join("\n");
  const uploadedDocumentReferenceMessage = buildUploadedDocumentReferenceSystemMessage(
    uploadedDocumentReferenceContext ?? "",
  );

  return [
    {
      role: "system" as const,
      content: [
        DOCX_AGENT_SYSTEM_PROMPT,
        `Only choose one of these currently available commands for action=docx_execute: ${commandNames}.`,
        "For multi-paragraph additions, still choose one command: insert_paragraph or append_paragraph with args.paragraphs as an ordered string array.",
        "If the user asks for an unavailable DOCX operation, use action=ask_confirm and explain briefly in Chinese that this operation is not supported yet.",
        uploadedDocumentReferenceMessage,
      ].join("\n"),
    },
    {
      role: "user" as const,
      content: [
        `Word filename: ${filename}`,
        "",
        "Supported commands:",
        commands,
        "",
        selectionText.trim()
          ? `Current DOCX selection:\n<<<\n${truncateSelectionContext(selectionText)}\n>>>`
          : "Current DOCX selection: none",
        "",
        fileContext?.content.trim()
          ? [
              "Compressed Word document context:",
              fileContext.isTruncated ? "The context is truncated." : "",
              "<<<",
              fileContext.content,
              ">>>",
            ]
              .filter(Boolean)
              .join("\n")
          : "Compressed Word document context: unavailable.",
        "",
        "Recent conversation:",
        recentConversation,
        "",
        "User request:",
        `<<<\n${instruction}\n>>>`,
      ].join("\n"),
    },
  ];
}

export function parseDocxAgentPlan(content: string): DocxAgentPlan {
  const trimmedContent = stripMarkdownFence(content.trim());
  const directParse = tryParseDocxAgentPlan(trimmedContent);
  if (directParse) return directParse;

  const startIndex = trimmedContent.indexOf("{");
  const endIndex = trimmedContent.lastIndexOf("}");
  if (startIndex >= 0 && endIndex > startIndex) {
    const extracted = trimmedContent.slice(startIndex, endIndex + 1);
    const extractedParse = tryParseDocxAgentPlan(extracted);
    if (extractedParse) return extractedParse;
  }

  throw new Error("DOCX agent did not return valid JSON.");
}

function tryParseDocxAgentPlan(content: string): DocxAgentPlan | null {
  try {
    const value = JSON.parse(content) as Partial<DocxAgentPlan>;
    if (
      value.action === "docx_execute" ||
      value.action === "answer_only" ||
      value.action === "ask_confirm"
    ) {
      return {
        action: value.action,
        command: normalizeDocxCommandName(value.command),
        args: isPlainObject(value.args) ? value.args : {},
        message: typeof value.message === "string" ? value.message : "",
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function normalizeDocxCommandName(command: unknown): DocxCommandName | undefined {
  if (typeof command !== "string") return undefined;
  if (SUPPORTED_DOCX_COMMANDS.has(command as DocxCommandName)) return command as DocxCommandName;
  return undefined;
}

export async function executeDocxPlan({
  command,
  file,
  plan,
}: {
  command: DocxCommandName;
  file: File;
  plan: DocxAgentPlan;
}): Promise<DocxExecuteResponse> {
  const blocks = await parseDocxBlocks(file);
  const response = await fetchDocumentService(`${DOCUMENT_SERVICE_URL}/docx/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      command,
      filename: file.name,
      blocks,
      args: plan.args ?? {},
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DOCX command failed (${response.status}): ${errorText}`);
  }

  return (await response.json()) as DocxExecuteResponse;
}

export async function parseDocxBlocks(file: File): Promise<DocxBlock[]> {
  const response = await fetchDocumentService(`${DOCUMENT_SERVICE_URL}/docx/parse`, () => {
    const body = new FormData();
    body.append("file", file);
    return {
      method: "POST",
      body,
    };
  });

  if (!response.ok) {
    throw new Error(`DOCX parse service returned ${response.status}`);
  }

  const result = (await response.json()) as DocxParseResponse;
  return result.blocks;
}

export function buildDocxExecutionStatus(
  plan: DocxAgentPlan,
  result: DocxExecuteResponse,
): string {
  return [
    plan.message?.trim(),
    result.summary,
    "已更新预览，尚未保存；请按 Ctrl+S 或点击保存按钮写入磁盘。",
    `影响段落：${result.paragraphs_affected}，影响表格：${result.tables_affected}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function shouldUseDocxAgent(selectedWorkspaceFile: WorkspaceFile | null): boolean {
  return selectedWorkspaceFile?.file.name.toLowerCase().endsWith(".docx") ?? false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripMarkdownFence(text: string): string {
  const fenceMatch = text.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  return fenceMatch ? fenceMatch[1] : text;
}
