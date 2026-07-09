// Pure quadrant-grid math for the workspace window engine (UI-M1b).
//
// The grid is 2 rows x 2 cols. CSS grid-area strings are `rowStart/colStart/
// rowEnd/colEnd` on that track set. Everything here is side-effect free so the
// snap/evict/section-fit logic can be unit-tested without React.

import type { PanelArea, Quadrant, SnapZone } from "./types";

const AREA_QUADS: Record<PanelArea, Quadrant[]> = {
  tl: ["tl"],
  tr: ["tr"],
  bl: ["bl"],
  br: ["br"],
  left: ["tl", "bl"],
  right: ["tr", "br"],
  top: ["tl", "tr"],
  bottom: ["bl", "br"],
};

const AREA_GRID: Record<PanelArea | "full", string> = {
  tl: "1 / 1 / 2 / 2",
  tr: "1 / 2 / 2 / 3",
  bl: "2 / 1 / 3 / 2",
  br: "2 / 2 / 3 / 3",
  left: "1 / 1 / 3 / 2",
  right: "1 / 2 / 3 / 3",
  top: "1 / 1 / 2 / 3",
  bottom: "2 / 1 / 3 / 3",
  full: "1 / 1 / 3 / 3",
};

const QUAD_GRID: Record<Quadrant, string> = {
  tl: AREA_GRID.tl,
  tr: AREA_GRID.tr,
  bl: AREA_GRID.bl,
  br: AREA_GRID.br,
};

// Candidate section rectangles, largest first. The section takes the first
// candidate whose quadrants are all free, so a single corner pin still leaves
// the section a clean half (never an L-shape) with a placeholder in the leftover
// quadrant.
const SECTION_CANDIDATES: (PanelArea | "full")[] = [
  "full",
  "left",
  "right",
  "top",
  "bottom",
  "tl",
  "tr",
  "bl",
  "br",
];

// Snap-zone hit bands as fractions of the workspace rect: a corner is the outer
// 28% x 32%, an edge is the remaining outer strip, the middle is center.
const EDGE_X = 0.28;
const EDGE_Y = 0.32;

/** Which snap zone a pointer at (px,py) falls in, given the workspace rect. */
export function zoneFromPoint(
  px: number,
  py: number,
  rect: { left: number; top: number; width: number; height: number },
): SnapZone {
  if (rect.width <= 0 || rect.height <= 0) return "center";
  const nx = (px - rect.left) / rect.width;
  const ny = (py - rect.top) / rect.height;
  const left = nx < EDGE_X;
  const right = nx > 1 - EDGE_X;
  const top = ny < EDGE_Y;
  const bottom = ny > 1 - EDGE_Y;
  if (top && left) return "tl";
  if (top && right) return "tr";
  if (bottom && left) return "bl";
  if (bottom && right) return "br";
  if (top) return "top";
  if (bottom) return "bottom";
  if (left) return "left";
  if (right) return "right";
  return "center";
}

export function quadsOf(area: PanelArea): Quadrant[] {
  return AREA_QUADS[area];
}

export function gridAreaOf(area: PanelArea): string {
  return AREA_GRID[area];
}

/** Drag zone -> panel area. Center means "do not pin". */
export function zoneToArea(zone: SnapZone): PanelArea | null {
  return zone === "center" ? null : zone;
}

export function areasOverlap(a: PanelArea, b: PanelArea): boolean {
  const bq = new Set(AREA_QUADS[b]);
  return AREA_QUADS[a].some((q) => bq.has(q));
}

export interface SectionLayout {
  /** grid-area for the page body <section>, or null when panels fill the grid. */
  sectionArea: string | null;
  /** empty quadrants to render as dashed "drag a detail here" placeholders. */
  placeholders: Quadrant[];
  /** grid-area per quadrant, for placeholder positioning. */
  quadGrid: Record<Quadrant, string>;
}

/**
 * Given the areas occupied by pinned panels, compute the section rectangle and
 * any leftover placeholder quadrants. Float/minimized panels are not on the
 * grid and must be excluded by the caller.
 */
export function computeSectionLayout(pinnedAreas: PanelArea[]): SectionLayout {
  const occupied = new Set<Quadrant>();
  for (const area of pinnedAreas) {
    for (const q of AREA_QUADS[area]) occupied.add(q);
  }

  const sectionKey = SECTION_CANDIDATES.find((candidate) => {
    const quads = candidate === "full" ? (["tl", "tr", "bl", "br"] as Quadrant[]) : AREA_QUADS[candidate];
    return quads.every((q) => !occupied.has(q));
  });

  const sectionQuads = new Set<Quadrant>(
    sectionKey
      ? sectionKey === "full"
        ? (["tl", "tr", "bl", "br"] as Quadrant[])
        : AREA_QUADS[sectionKey]
      : [],
  );

  const placeholders = (["tl", "tr", "bl", "br"] as Quadrant[]).filter(
    (q) => !occupied.has(q) && !sectionQuads.has(q),
  );

  return {
    sectionArea: sectionKey ? AREA_GRID[sectionKey] : null,
    placeholders,
    quadGrid: QUAD_GRID,
  };
}
