// Pure panel-list reducers for the workspace store (UI-M1b).
//
// The store (store.ts) is a thin zustand wrapper over these functions so the
// snap / evict / dedupe / restore logic is unit-testable without React.

import { areasOverlap } from "./layout";
import type { FloatRect, Panel, PanelArea, PinnedObject, ScreenKey } from "./types";

export const FLOAT_GRID_PX = 16;
const DEFAULT_FLOAT: FloatRect = { x: 64, y: 96, w: 468, h: 412 };
const DEFAULT_PIN_AREA: PanelArea = "right";

/** Snap a float rect to the 16px magnet grid. */
export function snapToGrid(rect: FloatRect): FloatRect {
  const round = (n: number) => Math.round(n / FLOAT_GRID_PX) * FLOAT_GRID_PX;
  return { x: round(rect.x), y: round(rect.y), w: round(rect.w), h: round(rect.h) };
}

function panelId(screen: ScreenKey, code: string): string {
  return `${screen}:${code}`;
}

/**
 * Pin an object to an area on a screen.
 * - dedupe: an existing panel for the same object (screen + object.code) is
 *   re-pinned to the target area rather than duplicated.
 * - evict: pinned panels on the same screen whose area overlaps the target are
 *   sent to the tray (minimized) so panels never visually overlap.
 * Panels on other screens and non-pinned panels are untouched.
 */
export function pinObject(
  panels: Panel[],
  screen: ScreenKey,
  object: PinnedObject,
  area: PanelArea = DEFAULT_PIN_AREA,
): Panel[] {
  const id = panelId(screen, object.code);
  const next: Panel[] = [];
  let placed = false;

  for (const panel of panels) {
    if (panel.id === id) {
      // dedupe: move the existing panel to the target area, pin it.
      next.push({ ...panel, object, area, mode: "pinned", float: undefined });
      placed = true;
      continue;
    }
    // evict a same-screen pinned panel that would overlap the target.
    if (
      panel.screen === screen &&
      panel.mode === "pinned" &&
      areasOverlap(panel.area, area)
    ) {
      next.push({ ...panel, mode: "minimized" });
      continue;
    }
    next.push(panel);
  }

  if (!placed) {
    next.push({ id, screen, object, mode: "pinned", area });
  }
  return next;
}

export function minimizePanel(panels: Panel[], id: string): Panel[] {
  return panels.map((p) => (p.id === id ? { ...p, mode: "minimized", float: undefined } : p));
}

export function closePanel(panels: Panel[], id: string): Panel[] {
  return panels.filter((p) => p.id !== id);
}

/** Restore a minimized/float panel to its last pinned area, evicting overlaps. */
export function restorePanel(panels: Panel[], id: string): Panel[] {
  const target = panels.find((p) => p.id === id);
  if (!target) return panels;
  return panels.map((p) => {
    if (p.id === id) return { ...p, mode: "pinned", float: undefined };
    if (
      p.screen === target.screen &&
      p.mode === "pinned" &&
      areasOverlap(p.area, target.area)
    ) {
      return { ...p, mode: "minimized" };
    }
    return p;
  });
}

export function popoutPanel(panels: Panel[], id: string): Panel[] {
  return panels.map((p) =>
    p.id === id ? { ...p, mode: "float", float: p.float ?? snapToGrid(DEFAULT_FLOAT) } : p,
  );
}

export function moveFloat(panels: Panel[], id: string, rect: FloatRect): Panel[] {
  return panels.map((p) =>
    p.id === id && p.mode === "float" ? { ...p, float: snapToGrid(rect) } : p,
  );
}

export function clearScreen(panels: Panel[], screen: ScreenKey): Panel[] {
  return panels.filter((p) => p.screen !== screen);
}
