import { useEffect, useRef, useState } from "react";
import "./TopBar.css";

type AgentInfo = {
  name: string;
  version: string;
  runtime: string;
};

type ServiceStatus = {
  running: boolean;
  endpoint: string;
};

type FileMenuItem = {
  label: string;
  shortcut?: string;
  action?: "open-file" | "open-folder" | "add-folder-to-workspace" | "open-workspace";
};

type TopBarProps = {
  agentInfo: AgentInfo | null;
  serviceStatus: ServiceStatus | null;
  workspaceFileCount: number;
  onOpenFilePicker: () => void;
  onOpenFolderPicker: () => void;
  onAddFolderToWorkspacePicker: () => void;
  onOpenWorkspacePicker: () => void;
};

const fileMenuGroups: FileMenuItem[][] = [
  [
    { label: "打开文件...", shortcut: "Ctrl+O", action: "open-file" },
    { label: "打开文件夹...", shortcut: "Ctrl+K Ctrl+O", action: "open-folder" },
    { label: "从文件打开工作区...", action: "open-workspace" },
  ],
  [
    { label: "将文件夹添加到工作区...", action: "add-folder-to-workspace" },
  ],
];

export function TopBar({
  agentInfo,
  serviceStatus,
  workspaceFileCount,
  onOpenFilePicker,
  onOpenFolderPicker,
  onAddFolderToWorkspacePicker,
  onOpenWorkspacePicker,
}: TopBarProps) {
  const fileMenuRef = useRef<HTMLDivElement | null>(null);
  const [isFileMenuOpen, setIsFileMenuOpen] = useState(false);

  function handleFileMenuCommand(item: FileMenuItem) {
    if (item.action === "open-file") {
      setIsFileMenuOpen(false);
      onOpenFilePicker();
      return;
    }

    if (item.action === "open-folder") {
      setIsFileMenuOpen(false);
      onOpenFolderPicker();
      return;
    }

    if (item.action === "add-folder-to-workspace") {
      setIsFileMenuOpen(false);
      onAddFolderToWorkspacePicker();
      return;
    }

    if (item.action === "open-workspace") {
      setIsFileMenuOpen(false);
      onOpenWorkspacePicker();
      return;
    }
  }

  useEffect(() => {
    if (!isFileMenuOpen) return;

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && fileMenuRef.current?.contains(target)) return;
      setIsFileMenuOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsFileMenuOpen(false);
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isFileMenuOpen]);

  return (
    <header className="menu-bar" aria-label="应用菜单">
      <div className="app-mark">◆</div>
      <nav className="menu-items" aria-label="顶部菜单">
        <div className="menu-item-wrap" ref={fileMenuRef}>
          <button
            className={isFileMenuOpen ? "menu-trigger active" : "menu-trigger"}
            type="button"
            aria-haspopup="menu"
            aria-expanded={isFileMenuOpen}
            onClick={() => setIsFileMenuOpen((isOpen) => !isOpen)}
          >
            文件(F)
          </button>
          {isFileMenuOpen ? (
            <div className="file-menu-popover" role="menu" aria-label="文件菜单">
              {fileMenuGroups.map((group, groupIndex) => (
                <div className="file-menu-group" role="group" key={groupIndex}>
                  {group.map((item) => (
                    <button
                      className="file-menu-item"
                      type="button"
                      role="menuitem"
                      key={item.label}
                      onClick={() => handleFileMenuCommand(item)}
                    >
                      <span className="file-menu-label">{item.label}</span>
                      {item.shortcut ? <span className="file-menu-shortcut">{item.shortcut}</span> : null}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </nav>
      <div className="command-center">
        <span>{agentInfo?.name ?? "OfficeAgent"}</span>
      </div>
      <div className="menu-status">
        <span className={serviceStatus?.running ? "service-dot online" : "service-dot"} />
        <strong>{workspaceFileCount}</strong>
      </div>
    </header>
  );
}
