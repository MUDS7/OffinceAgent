import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, MouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleUserRound,
  Code2,
  FilePlus2,
  FileText,
  Files,
  FolderOpen,
  FolderPlus,
  GitBranch,
  MoreHorizontal,
  RefreshCw,
  Search,
  Settings,
  SquareMinus,
  Table2,
  Trash2,
} from "lucide-react";
import type { FullTextSearchHit } from "../types";
import "./LeftPanel.css";

type WorkspaceFile = {
  id: string;
  file: File;
  relativePath?: string;
  metadataSaveStatus?: "pending" | "saved" | "error";
  analysis: unknown | null;
};

type WorkspaceTreeNodeRecord = {
  id: string;
  parent_id?: string | null;
  workspace_path: string;
  node_type: "root" | "folder" | "file";
  name: string;
  relative_path: string;
  document_id?: string | null;
  order_index: number;
  is_expanded: boolean;
};

type WorkspaceFolder = {
  id: string;
  name: string;
  afterFileId: string | null;
  parentFolderId: string | null;
};

type WorkspaceTreeFile = {
  kind: "file";
  id: string;
  name: string;
  fileItem: WorkspaceFile;
};

type WorkspaceTreeFolder = {
  kind: "folder";
  id: string;
  name: string;
  path: string;
  children: WorkspaceTreeNode[];
};

type WorkspaceTreeNode = WorkspaceTreeFile | WorkspaceTreeFolder;

type LeftPanelProps = {
  workspaceName: string;
  workspaceFiles: WorkspaceFile[];
  workspaceTreeNodes: WorkspaceTreeNodeRecord[];
  selectedFileId: string;
  explorerWidth: number;
  onSelectFile: (fileId: string) => void;
  onOpenSearchResult: (hit: FullTextSearchHit, query: string) => void;
  onCreateEmptyFile: (filename: string) => void;
  onOpenFilePicker: () => void;
  onOpenFolderPicker: () => void;
  onDeleteFiles: (fileIds: string[]) => void;
};

export function LeftPanel({
  workspaceName,
  workspaceFiles,
  workspaceTreeNodes,
  selectedFileId,
  explorerWidth,
  onSelectFile,
  onOpenSearchResult,
  onCreateEmptyFile,
  onOpenFilePicker,
  onOpenFolderPicker,
  onDeleteFiles,
}: LeftPanelProps) {
  const [activePanel, setActivePanel] = useState<"explorer" | "search">("explorer");
  const [workspaceFolders, setWorkspaceFolders] = useState<WorkspaceFolder[]>([]);
  const [isCreatingFile, setIsCreatingFile] = useState(false);
  const [draftFilename, setDraftFilename] = useState("");
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [draftFolderName, setDraftFolderName] = useState("");
  const [creatingFolderAfterFileId, setCreatingFolderAfterFileId] = useState<string | null>(null);
  const [creatingFolderParentId, setCreatingFolderParentId] = useState<string | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState("");
  const [collapsedFolderIds, setCollapsedFolderIds] = useState<Set<string>>(() => new Set());
  const [isWorkspaceRootCollapsed, setIsWorkspaceRootCollapsed] = useState(false);
  const [nodeToDelete, setNodeToDelete] = useState<{ id: string; name: string; kind: "file" | "folder" | "virtual_folder", fileIds?: string[] } | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<FullTextSearchHit[]>([]);
  const [searchError, setSearchError] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const newFileInputRef = useRef<HTMLInputElement | null>(null);
  const newFolderInputRef = useRef<HTMLInputElement | null>(null);
  const workspaceTree = useMemo(
    () => buildWorkspaceTree(workspaceFiles, workspaceName, workspaceTreeNodes),
    [workspaceFiles, workspaceName, workspaceTreeNodes],
  );

  useEffect(() => {
    if (!isCreatingFile) return;
    newFileInputRef.current?.focus();
  }, [isCreatingFile]);

  useEffect(() => {
    if (!isCreatingFolder) return;
    newFolderInputRef.current?.focus();
  }, [isCreatingFolder]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (!query) {
      setSearchResults([]);
      setSearchError("");
      setIsSearching(false);
      return;
    }

    let isCancelled = false;
    setIsSearching(true);
    setSearchError("");
    const timeoutId = window.setTimeout(() => {
      invoke<FullTextSearchHit[]>("search_document_full_text", { query, limit: 100 })
        .then((results) => {
          if (isCancelled) return;
          setSearchResults(results);
        })
        .catch((error) => {
          if (isCancelled) return;
          setSearchResults([]);
          setSearchError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          if (!isCancelled) setIsSearching(false);
        });
    }, 180);

    return () => {
      isCancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [searchQuery]);

  function startCreatingFile() {
    setDraftFilename("");
    setIsWorkspaceRootCollapsed(false);
    setIsCreatingFolder(false);
    setIsCreatingFile(true);
  }

  function startCreatingFolder() {
    setDraftFolderName("");
    setCreatingFolderAfterFileId(selectedFolderId ? null : selectedFileId || null);
    setCreatingFolderParentId(selectedFolderId || null);
    setIsWorkspaceRootCollapsed(false);
    if (selectedFolderId) {
      setCollapsedFolderIds((current) => {
        const next = new Set(current);
        next.delete(selectedFolderId);
        return next;
      });
    }
    setIsCreatingFile(false);
    setIsCreatingFolder(true);
  }

  function cancelCreatingFile() {
    setDraftFilename("");
    setIsCreatingFile(false);
  }

  function cancelCreatingFolder() {
    setDraftFolderName("");
    setIsCreatingFolder(false);
  }

  function commitCreatingFile() {
    const filename = draftFilename.trim();

    if (!filename) {
      cancelCreatingFile();
      return;
    }

    onCreateEmptyFile(filename);
    setSelectedFolderId("");
    setDraftFilename("");
    setIsCreatingFile(false);
  }

  function clearTreeSelection() {
    setSelectedFolderId("");
    onSelectFile("");
  }

  function commitCreatingFolder() {
    const folderName = draftFolderName.trim();

    if (!folderName) {
      cancelCreatingFolder();
      return;
    }

    const nextFolder = {
      id: `folder-${folderName}-${Date.now()}`,
      name: folderName,
      afterFileId: creatingFolderAfterFileId,
      parentFolderId: creatingFolderParentId,
    };

    setWorkspaceFolders((current) => [...current, nextFolder]);
    setSelectedFolderId(nextFolder.id);
    onSelectFile("");
    setDraftFolderName("");
    setIsCreatingFolder(false);
  }

  function toggleWorkspaceRoot() {
    setIsWorkspaceRootCollapsed((isCollapsed) => !isCollapsed);
  }

  function toggleFolder(folderId: string) {
    setCollapsedFolderIds((current) => {
      const next = new Set(current);

      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }

      return next;
    });
  }

  function collapseAllFolders(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    setIsWorkspaceRootCollapsed(false);
    setCollapsedFolderIds(new Set([...collectWorkspaceTreeFolderIds(workspaceTree), ...workspaceFolders.map((folder) => folder.id)]));
  }

  function handleStartCreatingFile(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    startCreatingFile();
  }

  function handleStartCreatingFolder(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    startCreatingFolder();
  }

  function handleOpenFolder(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    onOpenFolderPicker();
  }

  function handleConfirmDelete() {
    if (!nodeToDelete) return;
    
    if (nodeToDelete.kind === "file" || nodeToDelete.kind === "folder") {
      if (nodeToDelete.fileIds && nodeToDelete.fileIds.length > 0) {
        onDeleteFiles(nodeToDelete.fileIds);
      }
    } else if (nodeToDelete.kind === "virtual_folder") {
      setWorkspaceFolders((current) => current.filter(f => f.id !== nodeToDelete.id && f.parentFolderId !== nodeToDelete.id));
    }
    
    setNodeToDelete(null);
  }

  function stopTreeRootAction(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
  }

  function handleNewFileKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      commitCreatingFile();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      cancelCreatingFile();
    }
  }

  function handleNewFolderKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      commitCreatingFolder();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      cancelCreatingFolder();
    }
  }

  function getTreeRowStyle(depth: number): CSSProperties {
    return {
      paddingLeft: `${25 + depth * 18}px`,
    };
  }

  function renderCreatingFolderRow(depth = 0) {
    return (
      <div className="file-row creating-file-row" style={getTreeRowStyle(depth)}>
        <FolderOpen className="folder-icon" size={15} />
        <input
          ref={newFolderInputRef}
          aria-label="新建文件夹名"
          value={draftFolderName}
          onChange={(event) => setDraftFolderName(event.target.value)}
          onKeyDown={handleNewFolderKeyDown}
          onBlur={cancelCreatingFolder}
        />
      </div>
    );
  }

  function renderFolder(folder: WorkspaceFolder, depth = 0) {
    const childFolders = workspaceFolders.filter((item) => item.parentFolderId === folder.id);
    const isCollapsed = collapsedFolderIds.has(folder.id);
    const ChevronIcon = isCollapsed ? ChevronRight : ChevronDown;

    return (
      <Fragment key={folder.id}>
        <button
          className={folder.id === selectedFolderId ? "file-row folder-tree-row selected" : "file-row folder-tree-row"}
          style={getTreeRowStyle(depth)}
          type="button"
          aria-expanded={!isCollapsed}
          onClick={() => {
            setSelectedFolderId(folder.id);
            onSelectFile("");
            toggleFolder(folder.id);
          }}
        >
          <ChevronIcon className="tree-folder-chevron" size={14} />
          <FolderOpen className="folder-icon" size={15} />
          <span>{folder.name}</span>
          <div className="file-actions" onClick={(e) => {
            e.stopPropagation();
            setNodeToDelete({ id: folder.id, name: folder.name, kind: "virtual_folder" });
          }}>
            <Trash2 size={14} />
          </div>
        </button>
        {!isCollapsed && isCreatingFolder && creatingFolderParentId === folder.id ? renderCreatingFolderRow(depth + 1) : null}
        {!isCollapsed ? childFolders.map((childFolder) => renderFolder(childFolder, depth + 1)) : null}
      </Fragment>
    );
  }

  function renderTreeNode(node: WorkspaceTreeNode, depth = 0) {
    if (node.kind === "folder") {
      const isCollapsed = collapsedFolderIds.has(node.id);
      const ChevronIcon = isCollapsed ? ChevronRight : ChevronDown;

      return (
        <Fragment key={node.id}>
          <button
            className={node.id === selectedFolderId ? "file-row folder-tree-row selected" : "file-row folder-tree-row"}
            style={getTreeRowStyle(depth)}
            type="button"
            aria-expanded={!isCollapsed}
            onClick={() => {
              setSelectedFolderId(node.id);
              onSelectFile("");
              toggleFolder(node.id);
            }}
          >
            <ChevronIcon className="tree-folder-chevron" size={14} />
            <FolderOpen className="folder-icon" size={15} />
            <span>{node.name}</span>
            <div className="file-actions" onClick={(e) => {
              e.stopPropagation();
              const fileIds = collectWorkspaceTreeFileIds([node]);
              setNodeToDelete({ id: node.id, name: node.name, kind: "folder", fileIds });
            }}>
              <Trash2 size={14} />
            </div>
          </button>
          {!isCollapsed ? node.children.map((childNode) => renderTreeNode(childNode, depth + 1)) : null}
        </Fragment>
      );
    }

    return (
      <Fragment key={node.id}>
        <button
          className={node.fileItem.id === selectedFileId ? "file-row selected" : "file-row"}
          style={getTreeRowStyle(depth)}
          type="button"
          onClick={() => {
            setSelectedFolderId("");
            onSelectFile(node.fileItem.id);
          }}
        >
          <FileIcon filename={node.name} />
          <span>{node.name}</span>
          {node.fileItem.metadataSaveStatus === "pending" ? (
            <RefreshCw className="metadata-save-spinner spin" size={14} aria-label="保存文件数据中" />
          ) : node.fileItem.analysis ? (
            <Check size={14} />
          ) : (
            <Circle size={9} />
          )}
          <div className="file-actions" onClick={(e) => {
            e.stopPropagation();
            setNodeToDelete({ id: node.id, name: node.name, kind: "file", fileIds: [node.fileItem.id] });
          }}>
            <Trash2 size={14} />
          </div>
        </button>
        {isCreatingFolder && creatingFolderAfterFileId === node.fileItem.id ? renderCreatingFolderRow(depth) : null}
        {workspaceFolders
          .filter((folder) => folder.afterFileId === node.fileItem.id && !folder.parentFolderId)
          .map((folder) => renderFolder(folder, depth))}
      </Fragment>
    );
  }

  function renderSearchPanel() {
    const groupedResults = groupSearchResults(searchResults);
    const resultCount = searchResults.length;
    const fileCount = groupedResults.length;

    return (
      <>
        <div className="panel-heading search-heading">
          <span>搜索</span>
          <RefreshCw className={isSearching ? "spin" : ""} size={17} />
        </div>

        <div className="global-search-panel">
          <div className="search-input-row">
            <input
              aria-label="搜索"
              autoFocus
              placeholder="搜索"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
            <span className="search-option">Aa</span>
            <span className="search-option">ab</span>
          </div>
          <input className="replace-input" aria-label="替换" placeholder="替换" readOnly />

          {searchError ? <div className="search-message error">{searchError}</div> : null}
          {!searchQuery.trim() ? <div className="search-message">输入内容后搜索所有已上传文档</div> : null}
          {searchQuery.trim() && !isSearching && !searchError && !resultCount ? (
            <div className="search-message">没有结果</div>
          ) : null}
          {resultCount ? (
            <div className="search-summary">
              {fileCount} 文件中有 {resultCount} 个结果
            </div>
          ) : null}

          <div className="search-results">
            {groupedResults.map((group) => (
              <div className="search-result-group" key={group.documentId}>
                <div className="search-result-file">
                  <ChevronDown size={15} />
                  <FileIcon filename={group.filename} />
                  <span className="search-result-filename">{group.filename}</span>
                  {group.path ? <span className="search-result-path">{formatSearchPath(group.path)}</span> : null}
                  <span className="search-result-count">{group.results.length}</span>
                </div>
                {group.results.map((result) => (
                  <button
                    className="search-result-item"
                    type="button"
                    key={`${result.node_id}-${result.order_index}`}
                    onClick={() => onOpenSearchResult(result, searchQuery.trim())}
                  >
                    <span className="search-result-line">{formatSearchResultTitle(result)}</span>
                    <span className="search-result-snippet">{renderHighlightedSnippet(result.text, searchQuery)}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <aside className="activity-bar" aria-label="活动栏">
        <div className="activity-top">
          <button
            className={activePanel === "explorer" ? "activity-button active" : "activity-button"}
            type="button"
            title="资源管理器"
            onClick={() => setActivePanel("explorer")}
          >
            <Files size={26} />
          </button>
          <button
            className={activePanel === "search" ? "activity-button active" : "activity-button"}
            type="button"
            title="搜索"
            onClick={() => setActivePanel("search")}
          >
            <Search size={26} />
          </button>
        </div>
        <div className="activity-bottom">
          <button className="activity-button" type="button" title="账户">
            <CircleUserRound size={25} />
          </button>
          <button className="activity-button" type="button" title="管理">
            <Settings size={24} />
          </button>
        </div>
      </aside>

      <aside
        className={explorerWidth === 0 ? "explorer-panel collapsed" : "explorer-panel"}
        aria-label="文件目录"
        aria-hidden={explorerWidth === 0}
      >
        {activePanel === "search" ? (
          renderSearchPanel()
        ) : (
          <>
        <div className="panel-heading explorer-heading">
          <span>资源管理器</span>
          <MoreHorizontal size={17} />
        </div>

        <div
          className="tree-section"
          onClick={(event) => {
            if (event.target === event.currentTarget) clearTreeSelection();
          }}
        >
          <div className={isWorkspaceRootCollapsed ? "tree-root collapsed" : "tree-root"} onClick={toggleWorkspaceRoot}>
            {isWorkspaceRootCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
            <div className="tree-actions" aria-label="Workspace actions">
              <button className="tree-action-button" type="button" title="新建文件" onClick={handleStartCreatingFile}>
                <FilePlus2 size={18} strokeWidth={1.8} />
              </button>
              <button className="tree-action-button" type="button" title="新建文件夹" onClick={handleStartCreatingFolder}>
                <FolderPlus size={18} strokeWidth={1.8} />
              </button>
              <button className="tree-action-button" type="button" title="打开文件夹" onClick={handleOpenFolder}>
                <FolderOpen size={18} strokeWidth={1.8} />
              </button>
              <button className="tree-action-button" type="button" title="刷新资源管理器" onClick={stopTreeRootAction}>
                <RefreshCw size={18} strokeWidth={1.8} />
              </button>
              <button className="tree-action-button" type="button" title="折叠文件夹" onClick={collapseAllFolders}>
                <SquareMinus size={18} strokeWidth={1.8} />
              </button>
            </div>
            <span>{workspaceName || "工作区"}</span>
          </div>

          {!isWorkspaceRootCollapsed ? (
            <div
              className="file-list"
              onClick={(event) => {
                if (event.target === event.currentTarget) clearTreeSelection();
              }}
            >
              {isCreatingFile ? (
                <div className="file-row creating-file-row">
                  <FileIcon filename={draftFilename} />
                  <input
                    ref={newFileInputRef}
                    aria-label="新建文件名"
                    value={draftFilename}
                    onChange={(event) => setDraftFilename(event.target.value)}
                    onKeyDown={handleNewFileKeyDown}
                    onBlur={cancelCreatingFile}
                  />
                </div>
              ) : null}
              {isCreatingFolder && !creatingFolderAfterFileId && !creatingFolderParentId ? renderCreatingFolderRow() : null}
              {workspaceFolders
                .filter((folder) => !folder.afterFileId && !folder.parentFolderId)
                .map((folder) => renderFolder(folder))}
              {workspaceTree.map((node) => renderTreeNode(node))}
            </div>
          ) : null}
        </div>

        <button className="empty-tree-action" type="button" onClick={onOpenFilePicker}>
          <FilePlus2 size={16} />
          打开本地文档
        </button>

        <div className="explorer-spacer" onClick={clearTreeSelection} />
          </>
        )}
      </aside>

      {nodeToDelete && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              确认删除
            </div>
            <div className="modal-body">
              确定要删除 {nodeToDelete.kind === "file" ? "文件" : "文件夹"} "{nodeToDelete.name}" 吗？
            </div>
            <div className="modal-footer">
              <button className="modal-btn cancel-btn" onClick={() => setNodeToDelete(null)}>取消</button>
              <button className="modal-btn delete-btn" onClick={handleConfirmDelete}>删除</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function groupSearchResults(results: FullTextSearchHit[]) {
  const groups: Array<{
    documentId: string;
    filename: string;
    path?: string | null;
    results: FullTextSearchHit[];
  }> = [];
  const groupByDocument = new Map<string, (typeof groups)[number]>();

  for (const result of results) {
    let group = groupByDocument.get(result.document_id);
    if (!group) {
      group = {
        documentId: result.document_id,
        filename: result.filename,
        path: result.path,
        results: [],
      };
      groupByDocument.set(result.document_id, group);
      groups.push(group);
    }
    group.results.push(result);
  }

  return groups;
}

function formatSearchPath(path: string) {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
}

function formatSearchResultTitle(result: FullTextSearchHit) {
  if (result.title?.trim()) return result.title;
  if (result.node_type === "pdf_paragraph") return "PDF 段落";
  if (result.node_type === "excel_cell_range") return "表格行";
  if (result.node_type === "table") return "表格";
  if (result.node_type === "image") return "图片";
  return "文本";
}

function renderHighlightedSnippet(text: string, query: string) {
  const snippet = buildSearchSnippet(text, query);
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return snippet;

  const matchIndex = snippet.toLowerCase().indexOf(normalizedQuery);
  if (matchIndex === -1) return snippet;

  return (
    <>
      {snippet.slice(0, matchIndex)}
      <mark>{snippet.slice(matchIndex, matchIndex + query.trim().length)}</mark>
      {snippet.slice(matchIndex + query.trim().length)}
    </>
  );
}

function buildSearchSnippet(text: string, query: string) {
  const compactText = text.replace(/\s+/g, " ").trim();
  const normalizedQuery = query.trim().toLowerCase();
  const matchIndex = normalizedQuery ? compactText.toLowerCase().indexOf(normalizedQuery) : -1;
  const start = matchIndex === -1 ? 0 : Math.max(0, matchIndex - 28);
  const end = Math.min(compactText.length, start + 118);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < compactText.length ? "..." : "";

  return `${prefix}${compactText.slice(start, end)}${suffix}`;
}

function FileIcon({ filename }: { filename: string }) {
  if (filename.endsWith(".json")) return <Braces className="json-icon" size={15} />;
  if (filename.endsWith(".ts") || filename.endsWith(".tsx")) return <Code2 className="ts-icon" size={15} />;
  if (filename.endsWith(".html")) return <Code2 className="html-icon" size={15} />;
  if (filename.endsWith(".xlsx") || filename.endsWith(".xls")) return <Table2 className="spreadsheet-tab-icon" size={15} />;
  if (filename === ".gitignore") return <GitBranch className="git-icon" size={15} />;
  if (!filename) return <FolderOpen className="md-icon" size={15} />;
  return <FileText className="md-icon" size={15} />;
}

function collectWorkspaceTreeFolderIds(nodes: WorkspaceTreeNode[]) {
  const folderIds: string[] = [];

  for (const node of nodes) {
    if (node.kind !== "folder") continue;

    folderIds.push(node.id);
    folderIds.push(...collectWorkspaceTreeFolderIds(node.children));
  }

  return folderIds;
}

function collectWorkspaceTreeFileIds(nodes: WorkspaceTreeNode[]) {
  const fileIds: string[] = [];

  for (const node of nodes) {
    if (node.kind === "file") {
      fileIds.push(node.fileItem.id);
    } else {
      fileIds.push(...collectWorkspaceTreeFileIds(node.children));
    }
  }

  return fileIds;
}

function buildWorkspaceTree(
  workspaceFiles: WorkspaceFile[],
  workspaceName: string,
  workspaceTreeNodes: WorkspaceTreeNodeRecord[],
) {
  const rootNodes: WorkspaceTreeNode[] = [];
  const folderByPath = new Map<string, WorkspaceTreeFolder>();

  for (const treeNode of workspaceTreeNodes) {
    if (treeNode.node_type !== "folder") continue;
    ensureWorkspaceTreeFolder(rootNodes, folderByPath, getDisplayPathPartsFromPath(treeNode.relative_path, workspaceName));
  }

  for (const fileItem of workspaceFiles) {
    const parts = getDisplayPathParts(fileItem, workspaceName);
    const filename = parts[parts.length - 1] ?? fileItem.file.name;
    const siblings = ensureWorkspaceTreeFolder(rootNodes, folderByPath, parts.slice(0, -1));

    siblings.push({
      kind: "file",
      id: fileItem.id,
      name: filename,
      fileItem,
    });
  }

  sortWorkspaceNodes(rootNodes);
  return rootNodes;
}

function ensureWorkspaceTreeFolder(
  rootNodes: WorkspaceTreeNode[],
  folderByPath: Map<string, WorkspaceTreeFolder>,
  folderParts: string[],
) {
  let siblings = rootNodes;
  let currentPath = "";

  for (const folderName of folderParts) {
    currentPath = currentPath ? `${currentPath}/${folderName}` : folderName;
    let folder = folderByPath.get(currentPath);

    if (!folder) {
      folder = {
        kind: "folder",
        id: `tree-folder:${currentPath}`,
        name: folderName,
        path: currentPath,
        children: [],
      };
      folderByPath.set(currentPath, folder);
      siblings.push(folder);
    }

    siblings = folder.children;
  }

  return siblings;
}

function getDisplayPathParts(fileItem: WorkspaceFile, workspaceName: string) {
  const rawPath = fileItem.relativePath || fileItem.file.name;
  return getDisplayPathPartsFromPath(rawPath, workspaceName, fileItem.file.name);
}

function getDisplayPathPartsFromPath(rawPath: string, workspaceName: string, fallbackName = "") {
  const parts = rawPath.replace(/\\/g, "/").split("/").filter(Boolean);

  if (parts.length > 1 && parts[0] === workspaceName) {
    return parts.slice(1);
  }

  if (parts.length === 1 && parts[0] === workspaceName) {
    return [];
  }

  return parts.length ? parts : fallbackName ? [fallbackName] : [];
}

function sortWorkspaceNodes(nodes: WorkspaceTreeNode[]) {
  nodes.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "folder" ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true });
  });

  for (const node of nodes) {
    if (node.kind === "folder") {
      sortWorkspaceNodes(node.children);
    }
  }
}
