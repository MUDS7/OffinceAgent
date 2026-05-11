import { AlertTriangle, FileText, RefreshCw, XCircle } from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { DOCUMENT_SERVICE_URL } from "../../constants";
import type { DocumentSelectionContext, PreviewFile } from "./types";

type DocxPreviewProps = {
  activeFile: PreviewFile;
  onSaveFile: (fileId: string) => void;
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

const RENDER_DEBOUNCE_MS = 450;
const EMU_PER_PIXEL = 9525;

export function DocxPreview({
  activeFile,
  onSaveFile,
  onSelectionContextChange,
  onUpdateFile,
}: DocxPreviewProps) {
  const loadedFileIdRef = useRef("");
  const lastPublishedFileRef = useRef<File | null>(null);
  const lastRenderSignatureRef = useRef("");
  const latestBlocksSignatureRef = useRef("");
  const [state, setState] = useState<{
    blocks: DocxBlock[];
    error: string;
    isLoading: boolean;
    warnings: string[];
  }>({
    blocks: [],
    error: "",
    isLoading: true,
    warnings: [],
  });
  const [selectedTarget, setSelectedTarget] = useState<SelectedDocxTarget | null>(null);
  const documentText = useMemo(() => getDocumentText(state.blocks), [state.blocks]);

  useEffect(() => {
    if (loadedFileIdRef.current === activeFile.id && lastPublishedFileRef.current === activeFile.file) {
      return;
    }

    let isCancelled = false;
    loadedFileIdRef.current = activeFile.id;
    lastRenderSignatureRef.current = "";
    latestBlocksSignatureRef.current = "";
    setState({ blocks: [], error: "", isLoading: true, warnings: [] });
    setSelectedTarget(null);
    onSelectionContextChange(null);

    async function parseDocx() {
      try {
        const body = new FormData();
        body.append("file", activeFile.file);

        const response = await fetch(`${DOCUMENT_SERVICE_URL}/docx/parse`, {
          method: "POST",
          body,
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
          warnings: result.warnings,
        });
        lastRenderSignatureRef.current = getBlocksSignature(result.blocks);
      } catch (error) {
        if (isCancelled) return;
        setState({
          blocks: [],
          error: error instanceof Error ? error.message : String(error),
          isLoading: false,
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
      void publishDocxFile(signature);
    }, RENDER_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [state.blocks, state.error, state.isLoading]);

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

      {state.warnings.length ? (
        <div className="docx-warning">
          <AlertTriangle size={15} />
          <span>{state.warnings.join("；")}</span>
        </div>
      ) : null}

      <div
        className="docx-page-shell"
        onPointerDown={(event) => {
          if (event.target instanceof Element && event.target.closest(".docx-block, .docx-cell")) return;
          setSelectedTarget(null);
          onSelectionContextChange(null);
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
      <section className={className} key={block.id} onPointerDown={() => selectParagraph(block)}>
        <textarea
          className="docx-paragraph-input"
          aria-label="DOCX paragraph"
          spellCheck={false}
          rows={getTextareaRows(block.text, 86)}
          value={block.text}
          onChange={(event) => updateParagraph(block.id, event.target.value, block.style)}
          onFocus={() => selectParagraph(block)}
          onSelect={(event) => publishTextSelection(event.currentTarget, block.text, block.id)}
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
                        onFocus={() => selectCell(block, cell, rowIndex, cellIndex)}
                        onPointerDown={() => selectCell(block, cell, rowIndex, cellIndex)}
                        onSelect={(event) => publishTextSelection(event.currentTarget, cell.text, block.id)}
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

  function selectParagraph(block: DocxParagraphBlock) {
    setSelectedTarget({ blockId: block.id, kind: "paragraph" });
    publishSelectionContext(block.text, block.id);
  }

  function selectImage(block: DocxImageBlock) {
    setSelectedTarget({ blockId: block.id, kind: "image" });
    publishSelectionContext(`图片：${block.alt_text || block.filename}`, block.id);
  }

  function selectCell(block: DocxTableBlock, cell: DocxTableCell, rowIndex: number, cellIndex: number) {
    setSelectedTarget({ blockId: block.id, cellId: cell.id, kind: "cell" });
    publishSelectionContext(`Table ${block.id}, R${rowIndex + 1}C${cellIndex + 1}\n${cell.text}`, block.id);
  }

  function publishTextSelection(textarea: HTMLTextAreaElement, fallbackText: string, blockId: string) {
    const selectedText = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
    publishSelectionContext(selectedText.trim() ? selectedText : fallbackText, blockId);
  }

  function publishSelectionContext(text: string, blockId: string) {
    const start = documentText.indexOf(text);
    onSelectionContextChange({
      fileId: activeFile.id,
      filePath: activeFile.diskPath ?? activeFile.filename,
      filename: activeFile.filename,
      sourceType: "docx",
      start: start >= 0 ? start : undefined,
      end: start >= 0 ? start + text.length : undefined,
      text,
    });
  }

  async function publishDocxFile(signature: string) {
    try {
      const response = await fetch(`${DOCUMENT_SERVICE_URL}/docx/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: activeFile.filename,
          blocks: state.blocks,
        }),
      });

      if (!response.ok) {
        throw new Error(`DOCX 生成服务返回 ${response.status}`);
      }

      const blob = await response.blob();
      if (latestBlocksSignatureRef.current !== signature) return;

      const nextFile = new File([blob], activeFile.filename, {
        type: activeFile.file.type || "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        lastModified: Date.now(),
      });

      lastPublishedFileRef.current = nextFile;
      lastRenderSignatureRef.current = signature;
      onUpdateFile(activeFile.id, nextFile);
    } catch (error) {
      setState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
}

function getBlocksSignature(blocks: DocxBlock[]) {
  return JSON.stringify(blocks);
}

function getDocumentText(blocks: DocxBlock[]) {
  return blocks
    .map((block) => {
      if (block.type === "paragraph") return block.text;
      if (block.type === "image") return `图片：${block.alt_text || block.filename}`;
      return block.rows.map((row) => row.map((cell) => cell.text).join("\t")).join("\n");
    })
    .join("\n");
}

function getSelectedTargetLabel(target: SelectedDocxTarget) {
  if (target.kind === "paragraph") return "段落已选中";
  if (target.kind === "image") return "图片已选中";
  return "表格单元格已选中";
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
