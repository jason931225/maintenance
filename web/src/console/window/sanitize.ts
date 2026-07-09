// Carbon-copy window/pin engine — untrusted-state sanitizer (charter §3 P0.2:
// "sanitized on load").
//
// The layout comes back from GET /api/v1/me/workspace as an opaque JSON blob a
// previous (possibly older/newer/tampered) client wrote. A poisoned blob must
// never crash a render or resurrect a card that no longer exists in the
// registry, so every field is validated against the live `CardRegistry` and
// coerced/dropped rather than trusted. Unknown top-level keys in the workspace
// object are preserved by the persistence layer, not here — this only shapes the
// engine's own sub-object.

import type {
  CardFloat,
  CardMeta,
  CardRegistry,
  MinEntry,
  ScreenLayout,
  WindowState,
} from "./types";
import { floatKey } from "./types";

const ANCHORS = new Set(["left", "cx", "right"]);
const VANCHORS = new Set(["top", "cy", "bottom"]);
const DOCKS = new Set(["right", "bottom"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function finiteNum(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** The default (registry-derived) layout for one screen. */
function defaultScreenLayout(meta: CardMeta): ScreenLayout {
  return { main: [...meta.main], side: [...meta.side], h: {}, split: 0.63 };
}

/** Default full state: every registered screen at its registry layout. */
export function defaultWindowState(registry: CardRegistry): WindowState {
  const layout: Record<string, ScreenLayout> = {};
  for (const [scr, meta] of Object.entries(registry)) {
    layout[scr] = defaultScreenLayout(meta);
  }
  return { layout, min: [], float: {} };
}

/**
 * Sanitize a raw engine sub-object against the registry. Any card id not in the
 * screen's `main`/`side` registry is dropped; every screen's column order is
 * reconciled to the registry set (known ids in the persisted order, then any
 * registry cards the blob omitted, so a newer registry card still appears).
 */
export function sanitizeWindowState(raw: unknown, registry: CardRegistry): WindowState {
  const base = defaultWindowState(registry);
  if (!isRecord(raw)) return base;

  // --- layout ---------------------------------------------------------------
  const rawLayout: Record<string, unknown> = isRecord(raw.layout) ? raw.layout : {};
  const layout: Record<string, ScreenLayout> = {};
  for (const [scr, meta] of Object.entries(registry)) {
    const known = new Set([...meta.main, ...meta.side]);
    const r: Record<string, unknown> = isRecord(rawLayout[scr]) ? rawLayout[scr] : {};
    const cleanCol = (col: unknown): string[] =>
      Array.isArray(col) ? col.filter((id): id is string => typeof id === "string" && known.has(id)) : [];
    const placed = new Set<string>();
    const main = cleanCol(r.main);
    main.forEach((id) => placed.add(id));
    const side = cleanCol(r.side).filter((id) => !placed.has(id));
    side.forEach((id) => placed.add(id));
    // Any registry card the blob dropped rejoins its registry home column.
    for (const id of meta.main) {
      if (!placed.has(id)) {
        main.push(id);
        placed.add(id);
      }
    }
    for (const id of meta.side) {
      if (!placed.has(id)) {
        side.push(id);
        placed.add(id);
      }
    }

    const h: Record<string, number> = {};
    if (isRecord(r.h)) {
      for (const [id, v] of Object.entries(r.h)) {
        if (known.has(id) && typeof v === "number" && Number.isFinite(v)) h[id] = Math.max(150, v);
      }
    }
    const split = Math.min(0.78, Math.max(0.42, finiteNum(r.split, 0.63)));
    layout[scr] = { main, side, h, split };
  }

  // --- min tray -------------------------------------------------------------
  const min: MinEntry[] = [];
  const seenMin = new Set<string>();
  if (Array.isArray(raw.min)) {
    for (const e of raw.min) {
      if (!isRecord(e)) continue;
      const scr = e.scr;
      const id = e.id;
      if (typeof scr !== "string" || typeof id !== "string") continue;
      if (!Object.prototype.hasOwnProperty.call(registry, scr)) continue;
      const meta = registry[scr];
      if (!(meta.main.includes(id) || meta.side.includes(id))) continue;
      const k = floatKey(scr, id);
      if (seenMin.has(k)) continue;
      seenMin.add(k);
      min.push({ scr, id });
    }
  }

  // --- floats ---------------------------------------------------------------
  const float: Record<string, CardFloat> = {};
  if (isRecord(raw.float)) {
    for (const [key, v] of Object.entries(raw.float)) {
      if (!isRecord(v)) continue;
      const colon = key.indexOf(":");
      if (colon < 0) continue;
      const scr = key.slice(0, colon);
      const id = key.slice(colon + 1);
      if (!Object.prototype.hasOwnProperty.call(registry, scr)) continue;
      const meta = registry[scr];
      if (!(meta.main.includes(id) || meta.side.includes(id))) continue;
      // A card cannot be both minimized and floated (prototype invariant).
      if (seenMin.has(key)) continue;
      const ax = typeof v.ax === "string" && ANCHORS.has(v.ax) ? (v.ax as CardFloat["ax"]) : null;
      const ay = typeof v.ay === "string" && VANCHORS.has(v.ay) ? (v.ay as CardFloat["ay"]) : null;
      const pinned = v.pinned === true;
      const dock =
        typeof v.dock === "string" && DOCKS.has(v.dock) ? (v.dock as CardFloat["dock"]) : undefined;
      float[key] = {
        x: finiteNum(v.x, 96),
        y: finiteNum(v.y, 96),
        w: Math.max(220, finiteNum(v.w, 468)),
        h: Math.max(160, finiteNum(v.h, 412)),
        ax,
        ay,
        pinned,
        // A pinned float must carry a dock edge; default to right if missing.
        ...(pinned ? { dock: dock ?? "right" } : dock ? { dock } : {}),
      };
    }
  }

  return { layout, min, float };
}
