import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, FileText, RefreshCw, XCircle } from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { DOCUMENT_SERVICE_URL } from "../../constants";
import { fetchDocumentService } from "../../utils/documentService";
import type { DocumentSelectionContext, PreviewFile, SaveFileProvider } from "./types";

type DocxPreviewProps = {
  activeFile: PreviewFile;
  onSaveFile: (fileId: string) => void;
  onRegisterSaveFileProvider: (fileId: string, provider: SaveFileProvider) => () => void;
  onSelectionContextChange: (context: DocumentSelectionContext | null) => void;
  onUpdateFile: (fileId: string, file: File) => void;
};

type DocxParagraphBlock = {
  id: string;
  type: "paragraph";
  text: string;
  style?: string | null;
  style_id?: string | null;
  alignment?: string | null;
};

type DocxTableCell = {
  id: string;
  text: string;
  alignment?: string | null;
};

type DocxTableBlock = {
  id: string;
  type: "table";
  rows: DocxTableCell[][];
};

type DocxImageBlock = {
  id: string;
  type: "image";
  filename: string;
  content_type: string;
  data_url: string;
  alt_text?: string | null;
  width_emu?: number | null;
  height_emu?: number | null;
  alignment?: string | null;
};

type DocxBlock = DocxParagraphBlock | DocxTableBlock | DocxImageBlock;

type DocxParseResponse = {
  filename: string;
  blocks: DocxBlock[];
  text_preview: string;
  warnings: string[];
};

type SelectedDocxTarget =
  | { blockId: string; kind: "paragraph" }
  | { blockId: string; cellId: string; kind: "cell" }
  | { blockId: string; kind: "image" };

type SelectedDocxTextTarget = Exclude<SelectedDocxTarget, { kind: "image" }>;

const RENDER_DEBOUNCE_MS = 450;
const EMU_PER_PIXEL = 9525;

export function DocxPreview({
  activeFile,
  onSaveFile,
  onRegisterSaveFileProvider,
  onSelectionContextChange,
  onUpdateFile,
}: DocxPreviewProps) {
  const loadedFileIdRef = useRef("");
  const lastPublishedFileRef = useRef<File | null>(null);
  const lastRenderSignatureRef = useRef("");
  const latestActiveFileRef = useRef(activeFile);
  const latestBlocksRef = useRef<DocxBlock[]>([]);
  const latestBlocksSignatureRef = useRef("");
  const [state, setState] = useState<{
    blocks: DocxBlock[];
    error: string;
    isLoading: boolean;
    renderError: string;
    warnings: string[];
  }>({
    blocks: [],
    error: "",
    isLoading: true,
    renderError: "",
    warnings: [],
  });
  const [selectedTarget, setSelectedTarget] = useState<SelectedDocxTarget | null>(null);
  const documentText = useMemo(() => getDocumentText(state.blocks), [state.blocks]);
  latestActiveFileRef.current = activeFile;
  latestBlocksRef.current = state.blocks;

  useEffect(() => {
    if (loadedFileIdRef.current === activeFile.id && lastPublishedFileRef.current === activeFile.file) {
      return;
    }

    let isCancelled = false;
    loadedFileIdRef.current = activeFile.id;
    lastRenderSignatureRef.current = "";
    latestBlocksSignatureRef.current = "";
    setState({ blocks: [], error: "", isLoading: true, renderError: "", warnings: [] });
    setSelectedTarget(null);
    onSelectionContextChange(null);

    async function parseDocx() {
      try {
        const response = await fetchDocumentService(`${DOCUMENT_SERVICE_URL}/docx/parse`, () => {
          const body = new FormData();
          body.append("file", activeFile.file);
          return {
            method: "POST",
            body,
          };
        });

        if (!response.ok) {
          throw new Error(`DOCX 解析服务返回 ${response.status}`);
        }

        const result = (await response.json()) as DocxParseResponse;
        if (isCancelled) return;

        setState({
          blocks: result.blocks,
          error: "",
          isLoading: false,
          renderError: "",
          warnings: result.warnings,
        });
        lastRenderSignatureRef.current = getBlocksSignature(result.blocks);
      } catch (error) {
        if (isCancelled) return;
        setState({
          blocks: [],
          error: error instanceof Error ? error.message : String(error),
          isLoading: false,
          renderError: "",
          warnings: [],
        });
      }
    }

    void parseDocx();

    return () => {
      isCancelled = true;
    };
  }, [activeFile.id, activeFile.file, onSelectionContextChange]);

  useEffect(() => {
    if (state.isLoading || state.error) return;

    const signature = getBlocksSignature(state.blocks);
    latestBlocksSignatureRef.current = signature;
    if (!signature || signature === lastRenderSignatureRef.current) return;

    const timeoutId = window.setTimeout(() => {
      void publishDocxFile(signature, state.blocks).catch(() => undefined);
    }, RENDER_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [state.blocks, state.error, state.isLoading]);

  useEffect(() => {
    return onRegisterSaveFileProvider(activeFile.id, async () => {
      if (state.isLoading) {
        throw new Error(`DOCX 仍在解析，请稍后再保存（文件：${activeFile.filename}）`);
      }

      if (state.error) {
        throw new Error(`DOCX 解析失败，无法保存（文件：${activeFile.filename}）：${state.error}`);
      }

      const blocks = latestBlocksRef.current;
      const signature = getBlocksSignature(blocks);
      latestBlocksSignatureRef.current = signature;

      if (signature === lastRenderSignatureRef.current && lastPublishedFileRef.current) {
        return lastPublishedFileRef.current;
      }

      return publishDocxFile(signature, blocks, { keepWhenNewer: true });
    });
  }, [activeFile.id, onRegisterSaveFileProvider, state.error, state.isLoading]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        onSaveFile(activeFile.id);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [activeFile.id, onSaveFile]);

  if (state.isLoading) {
    return (
      <div className="editor-content preview-empty">
        <RefreshCw className="spin" size={26} />
        <span>正在解析 DOCX...</span>
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="editor-content preview-empty">
        <XCircle size={28} />
        <span>{state.error}</span>
      </div>
    );
  }

  const warningMessages = state.renderError
    ? [...state.warnings, `DOCX 自动生成失败：${state.renderError}`]
    : state.warnings;

  return (
    <div className="editor-content docx-preview">
      <div className="docx-toolbar">
        <div className="docx-summary">
          <FileText size={16} />
          <span>{state.blocks.length} 个内容块</span>
        </div>
        <span className="docx-selection-summary">
          {selectedTarget ? getSelectedTargetLabel(selectedTarget) : "未选中"}
        </span>
      </div>

      {warningMessages.length ? (
        <div className="docx-warning">
          <AlertTriangle size={15} />
          <span>{warningMessages.join("；")}</span>
        </div>
      ) : null}

      <div
        className="docx-page-shell"
        onPointerDown={(event) => {
          if (event.target instanceof Element && event.target.closest(".docx-block, .docx-cell")) return;
          clearDocxSelectionContext();
        }}
      >
        <article className="docx-page" aria-label={`${activeFile.filename} docx editor`}>
          {state.blocks.length ? (
            state.blocks.map((block) => {
              if (block.type === "paragraph") return renderParagraph(block);
              if (block.type === "table") return renderTable(block);
              return renderImage(block);
            })
          ) : (
            <textarea
              className="docx-paragraph-input"
              aria-label="空 DOCX 段落"
              value=""
              placeholder="空文档"
              rows={1}
              onChange={(event) => {
                updateParagraph("p-0", event.target.value, "Normal");
              }}
            />
          )}
        </article>
      </div>
    </div>
  );

  function renderParagraph(block: DocxParagraphBlock) {
    const isSelected = selectedTarget?.kind === "paragraph" && selectedTarget.blockId === block.id;
    const className = [
      "docx-block",
      "docx-paragraph",
      getParagraphStyleClass(block.style, block.style_id),
      getAlignmentClass(block.alignment),
      isSelected ? "selected" : "",
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <section className={className} key={block.id}>
        <textarea
          className="docx-paragraph-input"
          aria-label="DOCX paragraph"
          spellCheck={false}
          rows={getTextareaRows(block.text, 86)}
          value={block.text}
          onChange={(event) => updateParagraph(block.id, event.target.value, block.style)}
          onFocus={(event) => publishTextSelection(event.currentTarget, { blockId: block.id, kind: "paragraph" })}
          onKeyUp={(event) => publishTextSelection(event.currentTarget, { blockId: block.id, kind: "paragraph" })}
          onMouseUp={(event) => publishTextSelection(event.currentTarget, { blockId: block.id, kind: "paragraph" })}
          onSelect={(event) => publishTextSelection(event.currentTarget, { blockId: block.id, kind: "paragraph" })}
        />
      </section>
    );
  }

  function renderImage(block: DocxImageBlock) {
    const isSelected = selectedTarget?.kind === "image" && selectedTarget.blockId === block.id;
    const className = [
      "docx-block",
      "docx-image",
      getAlignmentClass(block.alignment),
      isSelected ? "selected" : "",
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <figure className={className} key={block.id} onPointerDown={() => selectImage(block)}>
        <img src={block.data_url} alt={block.alt_text || block.filename} style={getImageStyle(block)} />
      </figure>
    );
  }

  function renderTable(block: DocxTableBlock) {
    return (
      <div className="docx-block docx-table-wrap" key={block.id}>
        <table className="docx-table">
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={`${block.id}-row-${rowIndex}`}>
                {row.map((cell, cellIndex) => {
                  const isSelected =
                    selectedTarget?.kind === "cell" &&
                    selectedTarget.blockId === block.id &&
                    selectedTarget.cellId === cell.id;
                  const className = ["docx-cell", getAlignmentClass(cell.alignment), isSelected ? "selected" : ""]
                    .filter(Boolean)
                    .join(" ");

                  return (
                    <td className={className} key={cell.id}>
                      <textarea
                        className="docx-cell-input"
                        aria-label={`DOCX table cell ${rowIndex + 1}, ${cellIndex + 1}`}
                        spellCheck={false}
                        rows={getTextareaRows(cell.text, 28)}
                        value={cell.text}
                        onChange={(event) => updateTableCell(block.id, cell.id, event.target.value)}
                        onFocus={(event) =>
                          publishTextSelection(event.currentTarget, {
                            blockId: block.id,
                            cellId: cell.id,
                            kind: "cell",
                          })
                        }
                        onKeyUp={(event) =>
                          publishTextSelection(event.currentTarget, {
                            blockId: block.id,
                            cellId: cell.id,
                            kind: "cell",
                          })
                        }
                        onMouseUp={(event) =>
                          publishTextSelection(event.currentTarget, {
                            blockId: block.id,
                            cellId: cell.id,
                            kind: "cell",
                          })
                        }
                        onSelect={(event) =>
                          publishTextSelection(event.currentTarget, {
                            blockId: block.id,
                            cellId: cell.id,
                            kind: "cell",
                          })
                        }
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  function updateParagraph(blockId: string, text: string, style?: string | null) {
    setState((current) => {
      const hasExistingBlock = current.blocks.some((block) => block.id === blockId);
      const blocks = hasExistingBlock
        ? current.blocks.map((block) =>
            block.type === "paragraph" && block.id === blockId ? { ...block, text } : block,
          )
        : [{ id: blockId, type: "paragraph" as const, text, style: style ?? "Normal" }];

      return {
        ...current,
        blocks,
      };
    });
  }

  function updateTableCell(blockId: string, cellId: string, text: string) {
    setState((current) => ({
      ...current,
      blocks: current.blocks.map((block) => {
        if (block.type !== "table" || block.id !== blockId) return block;

        return {
          ...block,
          rows: block.rows.map((row) =>
            row.map((cell) => (cell.id === cellId ? { ...cell, text } : cell)),
          ),
        };
      }),
    }));
  }

  function selectImage(block: DocxImageBlock) {
    setSelectedTarget({ blockId: block.id, kind: "image" });
    const text = getDocxImageText(block);
    const start = getBlockStartOffset(block.id);
    publishSelectionContext(text, start, start === undefined ? undefined : start + text.length);
  }

  function publishTextSelection(textarea: HTMLTextAreaElement, target: SelectedDocxTextTarget) {
    const selectionStart = textarea.selectionStart;
    const selectionEnd = textarea.selectionEnd;
    const selectedText = textarea.value.slice(selectionStart, selectionEnd);
    if (!selectedText.trim() || selectionStart === selectionEnd) {
      clearDocxSelectionContext();
      return;
    }

    setSelectedTarget(target);
    publishSelectionContext(
      selectedText,
      getTextTargetOffset(target, selectionStart),
      getTextTargetOffset(target, selectionEnd),
    );
  }

  function clearDocxSelectionContext() {
    setSelectedTarget(null);
    onSelectionContextChange(null);
  }

  function publishSelectionContext(text: string, start?: number, end?: number) {
    const fallbackStart = start === undefined ? documentText.indexOf(text) : -1;
    const resolvedStart = start ?? (fallbackStart >= 0 ? fallbackStart : undefined);
    onSelectionContextChange({
      fileId: activeFile.id,
      filePath: activeFile.diskPath ?? activeFile.filename,
      filename: activeFile.filename,
      sourceType: "docx",
      start: resolvedStart,
      end: end ?? (resolvedStart === undefined ? undefined : resolvedStart + text.length),
      text,
    });
  }

  function getBlockStartOffset(blockId: string) {
    let offset = 0;

    for (const [blockIndex, block] of state.blocks.entries()) {
      if (block.id === blockId) return offset;

      offset += getDocxBlockText(block).length;
      if (blockIndex < state.blocks.length - 1) offset += 1;
    }

    return undefined;
  }

  function getTextTargetOffset(target: SelectedDocxTextTarget, localOffset: number) {
    let offset = 0;

    for (const [blockIndex, block] of state.blocks.entries()) {
      if (block.type === "paragraph") {
        if (target.kind === "paragraph" && block.id === target.blockId) {
          return offset + clampTextOffset(localOffset, block.text.length);
        }

        offset += block.text.length;
      } else if (block.type === "image") {
        offset += getDocxImageText(block).length;
      } else {
        for (const [rowIndex, row] of block.rows.entries()) {
          for (const [cellIndex, cell] of row.entries()) {
            if (target.kind === "cell" && block.id === target.blockId && cell.id === target.cellId) {
              return offset + clampTextOffset(localOffset, cell.text.length);
            }

            offset += cell.text.length;
            if (cellIndex < row.length - 1) offset += 1;
          }

          if (rowIndex < block.rows.length - 1) offset += 1;
        }
      }

      if (blockIndex < state.blocks.length - 1) offset += 1;
    }

    return undefined;
  }

  async function publishDocxFile(
    signature: string,
    blocks: DocxBlock[],
    options: { keepWhenNewer?: boolean } = {},
  ) {
    const currentActiveFile = latestActiveFileRef.current;
    try {
      const blob = await renderDocxBlob(currentActiveFile.filename, blocks);
      if (!options.keepWhenNewer && latestBlocksSignatureRef.current !== signature) return null;

      const nextFile = new File([blob], currentActiveFile.filename, {
        type: currentActiveFile.file.type || "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        lastModified: Date.now(),
      });

      lastPublishedFileRef.current = nextFile;
      lastRenderSignatureRef.current = signature;
      setState((current) => ({ ...current, renderError: "" }));
      onUpdateFile(currentActiveFile.id, nextFile);
      return nextFile;
    } catch (error) {
      const message = buildDocxRenderErrorMessage(currentActiveFile.filename, blocks, error);
      setState((current) => ({
        ...current,
        renderError: message,
      }));
      throw new Error(message);
    }
  }
}

function getBlocksSignature(blocks: DocxBlock[]) {
  return JSON.stringify(blocks);
}

function getDocumentText(blocks: DocxBlock[]) {
  return blocks.map((block) => getDocxBlockText(block)).join("\n");
}

function getDocxBlockText(block: DocxBlock) {
  if (block.type === "paragraph") return block.text;
  if (block.type === "image") return getDocxImageText(block);
  return block.rows.map((row) => row.map((cell) => cell.text).join("\t")).join("\n");
}

function getDocxImageText(block: DocxImageBlock) {
  return `图片：${block.alt_text || block.filename}`;
}

function clampTextOffset(offset: number, textLength: number) {
  if (!Number.isFinite(offset)) return 0;
  return Math.min(Math.max(Math.trunc(offset), 0), textLength);
}

function getSelectedTargetLabel(target: SelectedDocxTarget) {
  if (target.kind === "paragraph") return "文本已选中";
  if (target.kind === "image") return "图片已选中";
  return "单元格文本已选中";
}

function getParagraphStyleClass(style?: string | null, styleId?: string | null) {
  const normalized = `${style ?? ""} ${styleId ?? ""}`.toLowerCase();
  if (/heading\s*1|heading1|标题\s*1/.test(normalized)) return "heading-one";
  if (/heading\s*2|heading2|标题\s*2/.test(normalized)) return "heading-two";
  if (/heading\s*3|heading3|标题\s*3/.test(normalized)) return "heading-three";
  if (/subtitle|副标题/.test(normalized)) return "subtitle";
  if (/title|标题/.test(normalized)) return "title";
  return "";
}

function getAlignmentClass(alignment?: string | null) {
  const normalized = alignment?.toLowerCase().replace("_", "-") ?? "";
  if (normalized.includes("center")) return "align-center";
  if (normalized.includes("right")) return "align-right";
  if (normalized.includes("justify") || normalized.includes("distribute")) return "align-justify";
  return "";
}

function getTextareaRows(text: string, approximateCharsPerLine: number) {
  const rows = text.split(/\r?\n/).reduce((total, line) => {
    return total + Math.max(1, Math.ceil(line.length / approximateCharsPerLine));
  }, 0);

  return Math.min(Math.max(rows, 1), 18);
}

function getImageStyle(block: DocxImageBlock): CSSProperties {
  const width = block.width_emu ? Math.round(block.width_emu / EMU_PER_PIXEL) : undefined;
  const height = block.height_emu ? Math.round(block.height_emu / EMU_PER_PIXEL) : undefined;
  return {
    width: width ? `${width}px` : undefined,
    height: height ? `${height}px` : undefined,
    maxWidth: "100%",
  };
}

async function getServiceErrorMessage(response: Response, fallback: string) {
  try {
    const text = await response.text();
    if (!text.trim()) return fallback;
    return `${fallback} ${response.statusText ? `(${response.statusText})` : ""}：${extractServiceErrorDetail(text)}`;
  } catch {
    return fallback;
  }
}

async function renderDocxBlob(filename: string, blocks: DocxBlock[]) {
  const renderSummary = summarizeDocxBlocks(blocks);
  try {
    const response = await fetchDocumentService(`${DOCUMENT_SERVICE_URL}/docx/render`, () => ({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename,
        blocks,
      }),
    }));

    if (!response.ok) {
      throw new Error(
        await getServiceErrorMessage(
          response,
          `DOCX 生成服务返回 ${response.status}（文件：${filename}；${renderSummary}）`,
        ),
      );
    }

    return response.blob();
  } catch (fetchError) {
    try {
      const bytes = await invoke<number[]>("render_docx_document", { filename, blocks });
      return new Blob([new Uint8Array(bytes)], {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
    } catch (invokeError) {
      throw new Error(
        `HTTP 生成失败：${getErrorMessage(fetchError)}；` +
          `Tauri 代理生成也失败（文件：${filename}；${renderSummary}）：${getErrorMessage(invokeError)}`,
      );
    }
  }
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function extractServiceErrorDetail(text: string) {
  try {
    const payload = JSON.parse(text) as { detail?: unknown };
    if (payload.detail) {
      return typeof payload.detail === "string" ? payload.detail : JSON.stringify(payload.detail);
    }
  } catch {
    // Fall back to the raw response body below.
  }

  return text.trim().slice(0, 500);
}

function summarizeDocxBlocks(blocks: DocxBlock[]) {
  const counts = blocks.reduce(
    (result, block) => {
      result[block.type] += 1;
      return result;
    },
    { image: 0, paragraph: 0, table: 0 },
  );

  return `内容块 ${blocks.length} 个，段落 ${counts.paragraph} 个，表格 ${counts.table} 个，图片 ${counts.image} 个`;
}

function buildDocxRenderErrorMessage(filename: string, blocks: DocxBlock[], error: unknown) {
  return `DOCX 保存前生成失败（文件：${filename}；${summarizeDocxBlocks(blocks)}）：${getErrorMessage(error)}`;
}
