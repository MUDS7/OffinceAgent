import { invoke } from "@tauri-apps/api/core";
import type { UploadedDocumentChunkHit } from "../types";

export const UPLOADED_DOCUMENT_REFERENCE_TRIGGER = "参考上传文档";
const MAX_REFERENCE_CHARS_PER_CHUNK = 2400;

export function shouldReferenceUploadedDocuments(instruction: string): boolean {
  return instruction.includes(UPLOADED_DOCUMENT_REFERENCE_TRIGGER);
}

export function buildUploadedDocumentReferenceInstruction(instruction: string): string {
  const trimmedInstruction = instruction.trim();
  if (shouldReferenceUploadedDocuments(trimmedInstruction)) {
    return trimmedInstruction;
  }

  return `${UPLOADED_DOCUMENT_REFERENCE_TRIGGER} ${trimmedInstruction}`;
}

export function buildUploadedDocumentReferenceQuery(instruction: string): string {
  const query = instruction
    .replace(new RegExp(UPLOADED_DOCUMENT_REFERENCE_TRIGGER, "g"), " ")
    .replace(/[，,。；;：:\s]+/g, " ")
    .trim();

  return query || instruction.trim();
}

export async function searchUploadedDocumentReference(
  instruction: string,
): Promise<UploadedDocumentChunkHit[]> {
  if (!shouldReferenceUploadedDocuments(instruction)) {
    return [];
  }

  return invoke<UploadedDocumentChunkHit[]>("search_uploaded_document_chunks", {
    query: buildUploadedDocumentReferenceQuery(instruction),
    limit: 5,
    minScore: 0.03,
  });
}

export function formatUploadedDocumentReferenceContext(
  hits: UploadedDocumentChunkHit[],
): string {
  return hits
    .map((hit, index) => {
      const content = truncateReferenceContent(hit.content || hit.plain_text);
      return [
        `[${index + 1}] Document: ${hit.document_name}`,
        hit.title_path ? `Heading: ${hit.title_path}` : "",
        `Chunk type: ${hit.chunk_type}`,
        `Score: ${hit.score.toFixed(4)}`,
        "Content:",
        content,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n---\n\n");
}

export function buildUploadedDocumentReferenceSystemMessage(
  context: string,
): string {
  if (!context.trim()) return "";

  return [
    "The user explicitly asked to reference uploaded documents.",
    "Use the following retrieved chunks as source material. If the user asks to supplement/add/fill content, prefer directly using the relevant retrieved content instead of merely summarizing that it exists.",
    "If the chunks are not relevant enough, say that no matching uploaded-document content was found.",
    "Retrieved uploaded-document chunks:",
    "<<<",
    context,
    ">>>",
  ].join("\n");
}

function truncateReferenceContent(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= MAX_REFERENCE_CHARS_PER_CHUNK) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_REFERENCE_CHARS_PER_CHUNK)}\n...[uploaded document chunk truncated]`;
}
