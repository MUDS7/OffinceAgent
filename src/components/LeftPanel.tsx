import { Fragment, useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import {
  Braces,
  Check,
  ChevronDown,
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
  Play,
  RefreshCw,
  Search,
  Settings,
  SquareMinus,
} from "lucide-react";

type WorkspaceFile = {
  id: string;
  file: File;
  analysis: unknown | null;
};

type WorkspaceFolder = {
  id: string;
  name: string;
  afterFileId: string | null;
  parentFolderId: string | null;
};

type LeftPanelProps = {
  workspaceFiles: WorkspaceFile[];
  selectedFileId: string;
  explorerWidth: number;
  onSelectFile: (fileId: string) => void;
  onCreateEmptyFile: (filename: string) => void;
  onOpenFilePicker: () => void;
};

export function LeftPanel({
  workspaceFiles,
  selectedFileId,
  explorerWidth,
  onSelectFile,
  onCreateEmptyFile,
  onOpenFilePicker,
}: LeftPanelProps) {
  const [workspaceFolders, setWorkspaceFolders] = useState<WorkspaceFolder[]>([]);
  const [isCreatingFile, setIsCreatingFile] = useState(false);
  const [draftFilename, setDraftFilename] = useState("");
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [draftFolderName, setDraftFolderName] = useState("");
  const [creatingFolderAfterFileId, setCreatingFolderAfterFileId] = useState<string | null>(null);
  const [creatingFolderParentId, setCreatingFolderParentId] = useState<string | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState("");
  const newFileInputRef = useRef<HTMLInputElement | null>(null);
  const newFolderInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!isCreatingFile) return;
    newFileInputRef.current?.focus();
  }, [isCreatingFile]);

  useEffect(() => {
    if (!isCreatingFolder) return;
    newFolderInputRef.current?.focus();
  }, [isCreatingFolder]);

  function startCreatingFile() {
    setDraftFilename("");
    setIsCreatingFolder(false);
    setIsCreatingFile(true);
  }

  function startCreatingFolder() {
    setDraftFolderName("");
    setCreatingFolderAfterFileId(selectedFolderId ? null : selectedFileId || null);
    setCreatingFolderParentId(selectedFolderId || null);
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

    return (
      <Fragment key={folder.id}>
        <button
          className={folder.id === selectedFolderId ? "file-row folder-tree-row selected" : "file-row folder-tree-row"}
          style={getTreeRowStyle(depth)}
          type="button"
          onClick={() => {
            setSelectedFolderId(folder.id);
            onSelectFile("");
          }}
        >
          <FolderOpen className="folder-icon" size={15} />
          <span>{folder.name}</span>
        </button>
        {isCreatingFolder && creatingFolderParentId === folder.id ? renderCreatingFolderRow(depth + 1) : null}
        {childFolders.map((childFolder) => renderFolder(childFolder, depth + 1))}
      </Fragment>
    );
  }

  return (
    <>
      <aside className="activity-bar" aria-label="活动栏">
        <div className="activity-top">
          <button className="activity-button active" type="button" title="资源管理器">
            <Files size={26} />
          </button>
          <button className="activity-button" type="button" title="搜索">
            <Search size={26} />
          </button>
          <button className="activity-button" type="button" title="源代码管理">
            <GitBranch size={25} />
          </button>
          <button className="activity-button" type="button" title="运行和调试">
            <Play size={25} />
          </button>
          <button className="activity-button" type="button" title="扩展">
            <Braces size={25} />
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
          <div className="tree-root">
            <ChevronDown size={16} />
            <div className="tree-actions" aria-label="Workspace actions">
              <button className="tree-action-button" type="button" title="新建文件" onClick={startCreatingFile}>
                <FilePlus2 size={18} strokeWidth={1.8} />
              </button>
              <button className="tree-action-button" type="button" title="新建文件夹" onClick={startCreatingFolder}>
                <FolderPlus size={18} strokeWidth={1.8} />
              </button>
              <button className="tree-action-button" type="button" title="刷新资源管理器">
                <RefreshCw size={18} strokeWidth={1.8} />
              </button>
              <button className="tree-action-button" type="button" title="折叠文件夹">
                <SquareMinus size={18} strokeWidth={1.8} />
              </button>
            </div>
            <span>工作区</span>
          </div>

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
            {workspaceFiles.map((item) => (
              <Fragment key={item.id}>
                <button
                  className={item.id === selectedFileId ? "file-row selected" : "file-row"}
                  type="button"
                  onClick={() => {
                    setSelectedFolderId("");
                    onSelectFile(item.id);
                  }}
                >
                  <FileIcon filename={item.file.name} />
                  <span>{item.file.name}</span>
                  {item.analysis ? <Check size={14} /> : <Circle size={9} />}
                </button>
                {isCreatingFolder && creatingFolderAfterFileId === item.id ? renderCreatingFolderRow() : null}
                {workspaceFolders
                  .filter((folder) => folder.afterFileId === item.id && !folder.parentFolderId)
                  .map((folder) => renderFolder(folder))}
              </Fragment>
            ))}
          </div>
        </div>

        <button className="empty-tree-action" type="button" onClick={onOpenFilePicker}>
          <FilePlus2 size={16} />
          打开本地文档
        </button>

        <div className="explorer-spacer" onClick={clearTreeSelection} />
      </aside>
    </>
  );
}

function FileIcon({ filename }: { filename: string }) {
  if (filename.endsWith(".json")) return <Braces className="json-icon" size={15} />;
  if (filename.endsWith(".ts") || filename.endsWith(".tsx")) return <Code2 className="ts-icon" size={15} />;
  if (filename.endsWith(".html")) return <Code2 className="html-icon" size={15} />;
  if (filename === ".gitignore") return <GitBranch className="git-icon" size={15} />;
  if (!filename) return <FolderOpen className="md-icon" size={15} />;
  return <FileText className="md-icon" size={15} />;
}
