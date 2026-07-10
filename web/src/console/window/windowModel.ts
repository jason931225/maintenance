// §4.7 catalog #2 — window model state + pinned-panel geometry. The object-drag
// reference-token grammar lives in ./objDrag (objDrag / parseObjectRef /
// useObjectDrop) — do NOT reimplement it here (§4-18 same shape drawn twice).
import type { ReactNode } from "react";

// Popout (팝아웃/free float) is intentionally NOT implemented this slice: a real
// header-band pointer-drag would ship a fourth state we cannot fully realize +
// test here, so per the no-dead-affordance gate only the three states we
// complete are exposed (기본·핀·최소화).
export type WindowState = "default" | "pinned" | "minimized";

export interface WindowEntry {
  /** Stable key, typically the object code (e.g. "WO-2643"). */
  id: string;
  /** Localized display title for the panel header + tray chip. */
  title: string;
  /** Object code carried in drag payloads; defaults to id. */
  code?: string;
  /** Panel body renderer — persists across screen changes, so keep it self-contained. */
  render: () => ReactNode;
}

// Pinned-panel size band (§4.7 desktop 360–620px / narrow ~42vh sheet).
export const PANEL_MIN_WIDTH = 360;
export const PANEL_MAX_WIDTH = 620;
export const PANEL_DEFAULT_WIDTH = 420;
export const NARROW_BREAKPOINT = 1024;
export const NARROW_PANEL_VH = 42;
export const QUADRANT_GAP = 2;
export const HEADER_BAND_MAX = 54;

export function clampPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return PANEL_DEFAULT_WIDTH;
  return Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, width));
}
