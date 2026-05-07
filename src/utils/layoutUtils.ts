import type { LayoutWidths } from "../types";
import { UI_SCALE_FALLBACK, MIN_EXPLORER_WIDTH, MIN_CODEX_WIDTH, HIDE_DRAG_DISTANCE } from "../constants";

export function getInitialLayoutWidths(): LayoutWidths {
  if (typeof window === "undefined") {
    return { explorer: 361, codex: 520 };
  }

  if (window.innerWidth <= 1200) {
    return { explorer: 280, codex: 390 };
  }

  return {
    explorer: 361,
    codex: Math.max(420, window.innerWidth * 0.29),
  };
}

export function getUiScale(): number {
  if (typeof window === "undefined") return UI_SCALE_FALLBACK;

  const rawScale = getComputedStyle(document.documentElement).getPropertyValue("--ui-scale");
  const scale = Number.parseFloat(rawScale);
  return Number.isFinite(scale) && scale > 0 ? scale : UI_SCALE_FALLBACK;
}

export function normalizePanelWidth(width: number, minWidth: number): number {
  if (width <= minWidth - HIDE_DRAG_DISTANCE) return 0;
  if (width === 0) return 0;
  return Math.max(minWidth, width);
}

// Re-export constants so callers don't need a separate import
export { MIN_EXPLORER_WIDTH, MIN_CODEX_WIDTH };
