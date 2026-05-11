import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, FileText, RefreshCw, XCircle } from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { DOCUMENT_SERVICE_URL } from "../../constants";
import { fetchDocumentService } from "../../utils/documentService";
import type {
  DocxBlock,
  DocxImageBlock,
  DocxParagraphBlock,
  DocxParseResponse,
  DocxTableBlock,
  DocumentSelectionContext,
} from "../../types";
import type { PreviewFile, SaveFileProvider } from "./types";

type DocxPreviewProps = {
  activeFile: PreviewFile;
  onSaveFile: (fileId: string) => void;
  onRegisterSaveFileProvider: (fileId: string, provider: SaveFileProvider) => () => void;
  onSelectionContextChange: (context: DocumentSelectionContext | null) => void;
  onUpdateFile: (fileId: string, file: File) => void;
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
  const blocksSourceFileRef = useRef<File | null>(null);
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
    if (lastPublishedFileRef.current !== activeFile.file) {
      lastPublishedFileRef.current = null;
    }
    blocksSourceFileRef.current = null;
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
        const signature = getBlocksSignature(result.blocks);
        lastRenderSignatureRef.current = signature;
        blocksSourceFileRef.current = activeFile.file;
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
      const currentActiveFile = latestActiveFileRef.current;

      if (state.isLoading) {
        if (blocksSourceFileRef.current !== currentActiveFile.file) {
          return currentActiveFile.file;
        }

        throw new Error(`DOCX 仍在解析，请稍后再保存（文件：${currentActiveFile.filename}）`);
      }

      if (state.error) {
        throw new Error(`DOCX 解析失败，无法保存（文件：${currentActiveFile.filename}）：${state.error}`);
      }

      const blocks = latestBlocksRef.current;
      const signature = getBlocksSignature(blocks);
      latestBlocksSignatureRef.current = signature;

      if (
        signature === lastRenderSignatureRef.current &&
        lastPublishedFileRef.current &&
        lastPublishedFileRef.current === currentActiveFile.file
      ) {
        return lastPublishedFileRef.current;
      }

      if (blocksSourceFileRef.current !== currentActiveFile.file) {
        return currentActiveFile.file;
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
            <p className="docx-empty-text">空文档</p>
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
        <p
          className="docx-paragraph-text"
          contentEditable
          suppressContentEditableWarning
          onFocus={() => setSelectedTarget({ blockId: block.id, kind: "paragraph" })}
          onInput={(event) => updateParagraphText(block.id, event.currentTarget.textContent ?? "")}
          onMouseUp={(event) => publishElementTextSelection(event.currentTarget, { blockId: block.id, kind: "paragraph" })}
        >
          {block.text}
        </p>
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
                      <div
                        className="docx-cell-text"
                        contentEditable
                        suppressContentEditableWarning
                        aria-label={`DOCX table cell ${rowIndex + 1}, ${cellIndex + 1}`}
                        onFocus={() => setSelectedTarget({ blockId: block.id, cellId: cell.id, kind: "cell" })}
                        onInput={(event) =>
                          updateTableCellText(block.id, cell.id, event.currentTarget.textContent ?? "")
                        }
                        onMouseUp={(event) =>
                          publishElementTextSelection(event.currentTarget, {
                            blockId: block.id,
                            cellId: cell.id,
                            kind: "cell",
                          })
                        }
                      >
                        {cell.text}
                      </div>
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

  function updateParagraphText(blockId: string, text: string) {
    updateDocxBlocks((blocks) =>
      blocks.map((block) =>
        block.type === "paragraph" && block.id === blockId
          ? {
              ...block,
              text,
            }
          : block,
      ),
    );
  }

  function updateTableCellText(blockId: string, cellId: string, text: string) {
    updateDocxBlocks((blocks) =>
      blocks.map((block) => {
        if (block.type !== "table" || block.id !== blockId) return block;

        return {
          ...block,
          rows: block.rows.map((row) =>
            row.map((cell) =>
              cell.id === cellId
                ? {
                    ...cell,
                    text,
                  }
                : cell,
            ),
          ),
        };
      }),
    );
  }

  function updateDocxBlocks(update: (blocks: DocxBlock[]) => DocxBlock[]) {
    setState((current) => {
      const nextBlocks = update(current.blocks);
      latestBlocksRef.current = nextBlocks;
      latestBlocksSignatureRef.current = getBlocksSignature(nextBlocks);
      return { ...current, blocks: nextBlocks, renderError: "" };
    });
  }

  function selectImage(block: DocxImageBlock) {
    setSelectedTarget({ blockId: block.id, kind: "image" });
    const text = getDocxImageText(block);
    const start = getBlockStartOffset(block.id);
    publishSelectionContext(text, start, start === undefined ? undefined : start + text.length);
  }

  function publishElementTextSelection(element: HTMLElement, target: SelectedDocxTextTarget) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      clearDocxSelectionContext();
      return;
    }

    const range = selection.getRangeAt(0);
    if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) {
      clearDocxSelectionContext();
      return;
    }

    const selectedText = selection.toString();
    if (!selectedText.trim()) {
      clearDocxSelectionContext();
      return;
    }

    const selectionStart = getTextOffsetWithinElement(element, range.startContainer, range.startOffset);
    const selectionEnd = getTextOffsetWithinElement(element, range.endContainer, range.endOffset);
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
      blocksSourceFileRef.current = nextFile;
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

function getTextOffsetWithinElement(element: HTMLElement, container: Node, offset: number) {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.setEnd(container, offset);
  const textOffset = range.toString().length;
  range.detach();
  return textOffset;
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
