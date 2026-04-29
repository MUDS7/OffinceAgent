import { Atom, Braces, Code2, FileText, Hash } from "lucide-react";

export function EditorTabIcon({ filename }: { filename: string }) {
  const extension = getFileExtension(filename);

  if (extension === "css") return <Hash className="css-tab-icon" size={16} />;
  if (extension === "tsx" || extension === "jsx") return <Atom className="react-tab-icon" size={16} />;
  if (extension === "json") return <Braces className="json-tab-icon" size={16} />;
  if (extension === "ts" || extension === "js" || extension === "html") return <Code2 className="code-tab-icon" size={16} />;

  return <FileText className="file-tab-icon" size={16} />;
}

export function getFileExtension(filename: string) {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

export function isEditableTextFile(file: File | undefined, extension: string) {
  if (file?.type.startsWith("text/")) return true;

  return ["txt", "md", "csv", "json", "js", "jsx", "ts", "tsx", "html", "css", "xml", "yaml", "yml"].includes(
    extension,
  );
}
