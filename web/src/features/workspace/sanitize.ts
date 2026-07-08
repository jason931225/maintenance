// Persisted-workspace sanitizer (UI-M1b).
//
// The server stores an opaque per-person JSON blob. On load we never trust it:
// unknown screens/kinds/areas from an older or newer client are dropped, float
// rects are clamped to finite numbers, and duplicate object pins collapse. This
// mirrors the prototype's mergeCardLayout pass (logic-inventory sec 7).

import { panelId } from "./format";
import {
  DEFAULT_FLOAT_RECT,
  PANEL_AREAS,
  PIN_KINDS,
  SCREEN_KEYS,
  WORKSPACE_SCHEMA_VERSION,
  type FloatRect,
  type Panel,
  type PanelArea,
  type PanelMode,
  type PinKind,
  type PinnedObject,
  type ScreenKey,
  type WorkspaceEnvelope,
} from "./types";

const PANEL_MODES: PanelMode[] = ["pinned", "float", "minimized"];
const MAX_PANELS_PER_SCREEN = 8;
const MIN_FLOAT_SIZE = 120;
const FALLBACK_VIEWPORT = { w: 1280, h: 800 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  return typeof value === "string" &&
    (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function sanitizeObject(value: unknown): PinnedObject | undefined {
  if (!isRecord(value)) return undefined;
  const kind = oneOf<PinKind>(value.kind, PIN_KINDS);
  const code = asString(value.code);
  if (!kind || !code) return undefined;
  return { kind, code, title: code, fields: [] };
}

function clampNum(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function viewportSize() {
  if (typeof window === "undefined") return FALLBACK_VIEWPORT;
  return {
    w: Number.isFinite(window.innerWidth) && window.innerWidth > 0
      ? window.innerWidth
      : FALLBACK_VIEWPORT.w,
    h: Number.isFinite(window.innerHeight) && window.innerHeight > 0
      ? window.innerHeight
      : FALLBACK_VIEWPORT.h,
  };
}

function sanitizeFloat(value: unknown): FloatRect | undefined {
  if (!isRecord(value)) return undefined;
  const viewport = viewportSize();
  const w = Math.min(
    Math.max(MIN_FLOAT_SIZE, clampNum(value.w, DEFAULT_FLOAT_RECT.w)),
    Math.max(MIN_FLOAT_SIZE, viewport.w),
  );
  const h = Math.min(
    Math.max(MIN_FLOAT_SIZE, clampNum(value.h, DEFAULT_FLOAT_RECT.h)),
    Math.max(MIN_FLOAT_SIZE, viewport.h),
  );
  const maxX = Math.max(0, viewport.w - w);
  const maxY = Math.max(0, viewport.h - h);
  return {
    x: Math.min(Math.max(0, clampNum(value.x, 0)), maxX),
    y: Math.min(Math.max(0, clampNum(value.y, 0)), maxY),
    w,
    h,
  };
}

function sanitizePanel(value: unknown): Panel | undefined {
  if (!isRecord(value)) return undefined;
  const screen = oneOf<ScreenKey>(value.screen, SCREEN_KEYS);
  const area = oneOf<PanelArea>(value.area, PANEL_AREAS);
  const mode = oneOf<PanelMode>(value.mode, PANEL_MODES);
  const object = sanitizeObject(value.object);
  if (!screen || !area || !mode || !object) return undefined;
  return {
    id: panelId(screen, object),
    screen,
    object,
    area,
    mode,
    float: mode === "float" ? sanitizeFloat(value.float) : undefined,
  };
}

/**
 * Parse an untrusted stored blob into a valid envelope. Always returns a usable
 * envelope (empty on any structural problem). Dedupes by panel id and caps the
 * panel count per screen.
 */
export function sanitizeEnvelope(raw: unknown): WorkspaceEnvelope {
  const empty: WorkspaceEnvelope = { v: WORKSPACE_SCHEMA_VERSION, panels: [] };
  if (!isRecord(raw) || !Array.isArray(raw.panels)) return empty;
  // Unknown/future schema version => start empty rather than misread a v2+ shape.
  // A future migration reads the old `v` here and upgrades instead of dropping.
  if (raw.v !== WORKSPACE_SCHEMA_VERSION) return empty;

  const seen = new Set<string>();
  const perScreen = new Map<ScreenKey, number>();
  const panels: Panel[] = [];

  for (const entry of raw.panels) {
    const panel = sanitizePanel(entry);
    if (!panel || seen.has(panel.id)) continue;
    const count = perScreen.get(panel.screen) ?? 0;
    if (count >= MAX_PANELS_PER_SCREEN) continue;
    seen.add(panel.id);
    perScreen.set(panel.screen, count + 1);
    panels.push(panel);
  }

  return { v: WORKSPACE_SCHEMA_VERSION, panels };
}
