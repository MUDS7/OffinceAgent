import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ChevronDown, ChevronRight, Share2 } from "lucide-react";

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
  hasSubmenu?: boolean;
  disabled?: boolean;
  action?: "open-file" | "open-folder";
};

type TopBarProps = {
  agentInfo: AgentInfo | null;
  serviceStatus: ServiceStatus | null;
  workspaceFileCount: number;
  onOpenFilePicker: () => void;
  onOpenFolderPicker: () => void;
};

const fileMenuGroups: FileMenuItem[][] = [
  [
    { label: "新建文本文件", shortcut: "Ctrl+N" },
    { label: "新建文件...", shortcut: "Ctrl+Alt+Windows+N" },
    { label: "新建窗口", shortcut: "Ctrl+Shift+N" },
    { label: "使用配置文件新建窗口", hasSubmenu: true },
  ],
  [
    { label: "打开文件...", shortcut: "Ctrl+O", action: "open-file" },
    { label: "打开文件夹...", shortcut: "Ctrl+K Ctrl+O", action: "open-folder" },
    { label: "从文件打开工作区..." },
    { label: "打开最近的文件", hasSubmenu: true },
  ],
  [{ label: "将文件夹添加到工作区..." }, { label: "将工作区另存为..." }, { label: "复制工作区" }],
  [
    { label: "保存", shortcut: "Ctrl+S" },
    { label: "另存为...", shortcut: "Ctrl+Shift+S" },
    { label: "全部保存", shortcut: "Ctrl+K S", disabled: true },
  ],
  [{ label: "共享", hasSubmenu: true }],
  [{ label: "自动保存" }, { label: "首选项", hasSubmenu: true }],
  [
    { label: "还原文件" },
    { label: "关闭编辑器", shortcut: "Ctrl+F4" },
    { label: "关闭文件夹", shortcut: "Ctrl+K F" },
    { label: "关闭窗口", shortcut: "Alt+F4" },
  ],
  [{ label: "退出" }],
];

export function TopBar({
  agentInfo,
  serviceStatus,
  workspaceFileCount,
  onOpenFilePicker,
  onOpenFolderPicker,
}: TopBarProps) {
  const fileMenuRef = useRef<HTMLDivElement | null>(null);
  const [isFileMenuOpen, setIsFileMenuOpen] = useState(false);

  function handleFileMenuCommand(item: FileMenuItem) {
    if (item.disabled) return;

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

    if (!item.hasSubmenu) {
      setIsFileMenuOpen(false);
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
                      className={item.disabled ? "file-menu-item disabled" : "file-menu-item"}
                      type="button"
                      role="menuitem"
                      disabled={item.disabled}
                      key={item.label}
                      onClick={() => handleFileMenuCommand(item)}
                    >
                      <span className="file-menu-label">{item.label}</span>
                      {item.shortcut ? <span className="file-menu-shortcut">{item.shortcut}</span> : null}
                      {item.hasSubmenu ? <ChevronRight className="file-menu-arrow" size={20} /> : null}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <button type="button">编辑(E)</button>
        <button type="button">选择(S)</button>
        <button type="button">查看(V)</button>
        <button type="button">转到(G)</button>
        <button type="button">运行(R)</button>
        <button type="button">终端(T)</button>
        <button type="button">帮助(H)</button>
      </nav>
      <div className="command-center">
        <ArrowLeft size={16} />
        <ArrowRight size={16} />
        <span>{agentInfo?.name ?? "OfficeAgent"}</span>
      </div>
      <div className="menu-status">
        <span className={serviceStatus?.running ? "service-dot online" : "service-dot"} />
        <strong>{workspaceFileCount}</strong>
        <Share2 size={16} />
        <ChevronDown size={15} />
      </div>
    </header>
  );
}
