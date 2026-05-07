export function getFileMimeType(filename: string): string {
  const extension = filename.split(".").pop()?.toLowerCase();

  if (extension === "json") return "application/json";
  if (extension === "pdf") return "application/pdf";
  if (extension === "xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (extension === "xls") return "application/vnd.ms-excel";
  if (extension === "txt") return "text/plain";
  if (extension === "md") return "text/markdown";
  if (extension === "csv") return "text/csv";
  if (extension === "html") return "text/html";
  if (extension === "ts" || extension === "tsx") return "text/typescript";

  return "text/plain";
}

export function decodeBase64Bytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function getFileRelativePath(file: File): string {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
}

export function normalizeFilePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}
