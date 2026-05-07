import type {
  ChatMessage,
  ExcelAgentPlan,
  ExcelCommandName,
  ExcelCommandsResponse,
  ExcelExecuteResponse,
} from "../types";
import {
  DOCUMENT_SERVICE_URL,
  EXCEL_AGENT_SYSTEM_PROMPT,
  SUPPORTED_EXCEL_COMMANDS,
} from "../constants";
import { truncateSelectionContext } from "./chatMessages";

// ─── Command spec fetching ────────────────────────────────────────────────────

export async function fetchExcelCommandSpecs(): Promise<ExcelCommandsResponse> {
  const response = await fetch(`${DOCUMENT_SERVICE_URL}/excel/commands`);
  if (!response.ok) {
    throw new Error(`Excel command service returned ${response.status}`);
  }
  return (await response.json()) as ExcelCommandsResponse;
}

export function getExcelCommandNames(commandSpecs: ExcelCommandsResponse): Set<ExcelCommandName> {
  return new Set([...commandSpecs.basic, ...commandSpecs.advanced].map((spec) => spec.command));
}

export function isExcelCommandAvailable(
  command: ExcelCommandName,
  commandSpecs: ExcelCommandsResponse,
): boolean {
  return getExcelCommandNames(commandSpecs).has(command);
}

export function buildUnavailableExcelCommandMessage(command: ExcelCommandName): string {
  return [
    `当前文档服务还没有开放 ${command} 命令，我没有改动文件。`,
    "请重启 OfficeAgent 或文档服务后再试；如果是已打包版本，需要重新打包后使用新版服务。",
  ].join("\n");
}

// ─── Message building ─────────────────────────────────────────────────────────

export function buildExcelAgentMessages({
  commandSpecs,
  filename,
  instruction,
  selectionText,
  chatMessages,
}: {
  commandSpecs: ExcelCommandsResponse;
  filename: string;
  instruction: string;
  selectionText: string;
  chatMessages: ChatMessage[];
}) {
  const commandNames = [...getExcelCommandNames(commandSpecs)].join(", ");
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

  return [
    {
      role: "system" as const,
      content: [
        EXCEL_AGENT_SYSTEM_PROMPT,
        `Only choose one of these currently available commands for action=excel_execute: ${commandNames}.`,
        "If the user asks for an unavailable Excel operation, use action=ask_confirm and explain briefly in Chinese that the current document service needs to be restarted or updated.",
      ].join("\n"),
    },
    {
      role: "user" as const,
      content: [
        `Workbook filename: ${filename}`,
        "",
        "Supported commands:",
        commands,
        "",
        selectionText.trim()
          ? `Current spreadsheet selection:\n<<<\n${truncateSelectionContext(selectionText)}\n>>>`
          : "Current spreadsheet selection: none",
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

// ─── Plan parsing ─────────────────────────────────────────────────────────────

export function parseExcelAgentPlan(content: string): ExcelAgentPlan {
  const trimmedContent = stripMarkdownFence(content.trim());
  const directParse = tryParseExcelAgentPlan(trimmedContent);
  if (directParse) return directParse;

  const startIndex = trimmedContent.indexOf("{");
  const endIndex = trimmedContent.lastIndexOf("}");
  if (startIndex >= 0 && endIndex > startIndex) {
    const extracted = trimmedContent.slice(startIndex, endIndex + 1);
    const extractedParse = tryParseExcelAgentPlan(extracted);
    if (extractedParse) return extractedParse;
  }

  throw new Error("Excel agent did not return valid JSON.");
}

function tryParseExcelAgentPlan(content: string): ExcelAgentPlan | null {
  try {
    const value = JSON.parse(content) as Partial<ExcelAgentPlan>;
    if (
      value.action === "excel_execute" ||
      value.action === "answer_only" ||
      value.action === "ask_confirm"
    ) {
      return {
        action: value.action,
        command: normalizeExcelCommandName(value.command),
        sheet: typeof value.sheet === "string" ? value.sheet : null,
        output_path: typeof value.output_path === "string" ? value.output_path : null,
        args: isPlainObject(value.args) ? value.args : {},
        message: typeof value.message === "string" ? value.message : "",
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function normalizeExcelCommandName(command: unknown): ExcelCommandName | undefined {
  if (typeof command !== "string") return undefined;
  if (SUPPORTED_EXCEL_COMMANDS.has(command as ExcelCommandName)) return command as ExcelCommandName;
  return undefined;
}

export function parseSpreadsheetSelectionSheet(selectionText: string): string {
  const firstLine = selectionText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.toLowerCase().startsWith("sheet:"));
  return firstLine ? firstLine.slice("sheet:".length).trim() : "";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ─── Execution ────────────────────────────────────────────────────────────────

export async function executeExcelPlan({
  command,
  filePath,
  plan,
}: {
  command: ExcelCommandName;
  filePath: string;
  plan: ExcelAgentPlan;
}): Promise<ExcelExecuteResponse> {
  const response = await fetch(`${DOCUMENT_SERVICE_URL}/excel/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      command,
      file_path: filePath,
      sheet: plan.sheet || undefined,
      output_path: plan.output_path || undefined,
      save_to_disk: false,
      args: plan.args ?? {},
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Excel command failed (${response.status}): ${errorText}`);
  }

  return (await response.json()) as ExcelExecuteResponse;
}

export function buildExcelExecutionStatus(
  plan: ExcelAgentPlan,
  result: ExcelExecuteResponse,
): string {
  const details = [
    plan.message?.trim(),
    result.summary,
    result.saved_to_disk
      ? `已保存到：${result.output_path}`
      : "已更新预览，尚未保存；请按 Ctrl+S 或点击保存按钮写入磁盘。",
    `影响行数：${result.rows_affected}，影响单元格：${result.cells_affected}`,
    `输出文件：${result.output_path}`,
  ].filter(Boolean);

  return details.join("\n");
}

// ─── Internal helper (shared with chatMessages) ───────────────────────────────

function stripMarkdownFence(text: string): string {
  const fenceMatch = text.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  return fenceMatch ? fenceMatch[1] : text;
}
