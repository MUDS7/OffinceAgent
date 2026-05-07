export function isTauriUnavailable(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("tauri") || normalized.includes("__tauri");
}

export function canUseTauriEvents(): boolean {
  if (typeof window === "undefined") return false;
  return "__TAURI_INTERNALS__" in window || "__TAURI_IPC__" in window || "__TAURI__" in window;
}
