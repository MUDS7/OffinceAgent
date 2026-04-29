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
  GitBranch,
  MoreHorizontal,
  Play,
  Search,
  Settings,
} from "lucide-react";

type WorkspaceFile = {
  id: string;
  file: File;
  analysis: unknown | null;
};

type LeftPanelProps = {
  workspaceFiles: WorkspaceFile[];
  selectedFileId: string;
  explorerWidth: number;
  onSelectFile: (fileId: string) => void;
  onOpenFilePicker: () => void;
};

export function LeftPanel({
  workspaceFiles,
  selectedFileId,
  explorerWidth,
  onSelectFile,
  onOpenFilePicker,
}: LeftPanelProps) {
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

        <div className="tree-section">
          <div className="tree-root">
            <ChevronDown size={16} />
            <span>工作区</span>
          </div>

          <div className="file-list">
            {workspaceFiles.map((item) => (
              <button
                key={item.id}
                className={item.id === selectedFileId ? "file-row selected" : "file-row"}
                type="button"
                onClick={() => onSelectFile(item.id)}
              >
                <FileIcon filename={item.file.name} />
                <span>{item.file.name}</span>
                {item.analysis ? <Check size={14} /> : <Circle size={9} />}
              </button>
            ))}
          </div>
        </div>

        <button className="empty-tree-action" type="button" onClick={onOpenFilePicker}>
          <FilePlus2 size={16} />
          打开本地文档
        </button>

        <div className="explorer-spacer" />
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
