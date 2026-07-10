// Carbon-copy window/pin engine — pure geometry (charter §3 P0.2).
//
// This is the least-discoverable, most error-prone part of the engine (the
// prototype-anatomy note calls it out): the budget-fill layout solver, the
// magnet/grid snap during drag, the anchor re-flow on chrome/viewport change,
// and the pin space-reservation math. All side-effect-free so it is unit-tested
// without React. Constants and formulas are VERBATIM from the prototype
// (`Oyatie Console.dc.html`: mainArea 3939, computeCardLay 4358, startFloatDrag
// 5097, componentDidUpdate re-anchor 3946, bodyPad renderVals 6145).

import type {
  CardBox,
  CardFloat,
  CardMeta,
  Chrome,
  ComputedLayout,
  ScreenLayout,
  Viewport,
} from "./types";
import { lookup } from "./types";

/** Drag-snap constants (prototype startFloatDrag). */
export const GRID = 16;
export const TICK = 6;
export const MAG = 12;
/** Header band height: drag/dblclick only fire within this px from card top. */
export const HEADER_BAND = 54;
/** Default popout window size. */
export const POPOUT_W = 468;
export const POPOUT_H = 412;
/** Viewport width below which there is no free-float: grab = pin-to-bottom. */
export const NARROW_MAX = 1024;
/** Drop a float below `vh - TRAY_GRAB` on release → minimize to tray. */
export const TRAY_GRAB = 42;

/**
 * The usable main-content band in px, derived from sidebar/rail collapse state
 * and viewport width. Prototype: sidebar left edge = 62 collapsed / 236 open;
 * rail right edge = 54 collapsed / (vw<1560 ? 300 : 336) open.
 */
export function mainArea(vp: Viewport, chrome: Chrome): { left: number; right: number } {
  const vw = vp.vw || 1400;
  const left = chrome.sidebarCollapsed ? 62 : 236;
  const right = vw - (chrome.railCollapsed ? 54 : vw < 1560 ? 300 : 336);
  return { left, right };
}

/**
 * The budget-fill layout solver (prototype computeCardLay, normal + narrow
 * branches — the max/modal/split cardMode branches are separate toolbar
 * affordances outside the P0.2 four-state grammar and are not modelled here).
 *
 * A card is "out" (excluded from the zone) when minimized or floated. Fixed-
 * height cards (`layout.h[id]`) are placed first; the remaining budget is
 * distributed across auto-height cards proportional to their `min` weight,
 * floor-clamped to `min` (never shrinks below it, hence a column can overflow —
 * `contH` reports the true content height for the scroll container).
 */
export function computeCardLay(
  meta: CardMeta,
  layout: ScreenLayout,
  min: readonly { scr: string; id: string }[],
  float: Record<string, CardFloat>,
  scr: string,
  vp: Viewport,
): ComputedLayout {
  const gap = 12;
  const narrow = (vp.vw || 1400) < NARROW_MAX;
  const budget = Math.max(430, (vp.vh || 900) - meta.off);

  const isOut = (id: string) =>
    min.some((q) => q.scr === scr && q.id === id) || lookup(float, `${scr}:${id}`) !== undefined;
  const zMain = layout.main.filter((id) => !isOut(id));
  const zSide = layout.side.filter((id) => !isOut(id));
  const all = [...zMain, ...zSide];
  const minOf = (id: string) => lookup(meta.min, id) ?? 180;
  /** Explicit fixed-height override (floored to 150), or undefined = auto. */
  const fixedH = (id: string): number | undefined => {
    const v = lookup(layout.h, id);
    return typeof v === "number" ? Math.max(150, v) : undefined;
  };

  const cards: Record<string, CardBox> = {};
  const stackCol = (
    ids: string[],
    x: string,
    w: string,
    y0: number,
    colBudget: number,
  ): number => {
    if (!ids.length) return y0;
    const fixedSum = ids.reduce((a, id) => a + (fixedH(id) ?? 0), 0);
    const autos = ids.filter((id) => fixedH(id) === undefined);
    const rem = colBudget - gap * (ids.length - 1) - fixedSum;
    const minSum = autos.reduce((a, id) => a + minOf(id), 0) || 1;
    const scale = Math.max(1, rem / minSum);
    let y = y0;
    for (const id of ids) {
      const h = fixedH(id) ?? Math.floor(minOf(id) * scale);
      cards[id] = { x, w, y, h, vis: true };
      y += h + gap;
    }
    return y - gap;
  };

  const splitP =
    Math.round(
      (typeof layout.split === "number"
        ? Math.min(0.78, Math.max(0.42, layout.split))
        : 0.63) * 1000,
    ) / 10;
  const sideW = Math.round((100 - splitP) * 10) / 10;
  let MAINW = narrow ? "100%" : `calc(${String(splitP)}% - 6px)`;
  let SIDEX = narrow ? "0px" : `calc(${String(splitP)}% + 6px)`;
  let SIDEW = narrow ? "100%" : `calc(${String(sideW)}% - 6px)`;
  if (!narrow && zSide.length === 0) MAINW = "100%";
  if (!narrow && zMain.length === 0) {
    SIDEX = "0px";
    SIDEW = "100%";
  }

  let contH: number;
  if (narrow) {
    contH = stackCol(
      all,
      "0px",
      "100%",
      0,
      all.reduce((a, id) => a + minOf(id) * 1.2, 0) + gap * Math.max(0, all.length - 1),
    );
  } else {
    const b1 = stackCol(zMain, "0px", MAINW, 0, budget);
    const b2 = stackCol(zSide, SIDEX, SIDEW, 0, budget);
    contH = Math.max(b1, b2, 200);
  }

  // Out (floated/minimized) cards get a hidden placeholder box so callers can
  // still read a geometry for them without a null check.
  for (const id of [...layout.main, ...layout.side]) {
    if (!Object.prototype.hasOwnProperty.call(cards, id)) {
      cards[id] = { x: "0px", w: "100%", y: 0, h: 320, vis: false };
    }
  }

  return { cards, contH, narrow, split: splitP };
}

/**
 * Pin a card as a space-reserving panel (prototype cardPinRight). Desktop docks
 * right, full height, width = clamp(360, 44% of main area, 620). Narrow docks as
 * a bottom sheet, 42vh. Returns the float descriptor to store.
 */
export function pinnedFloat(vp: Viewport, chrome: Chrome): CardFloat {
  const area = mainArea(vp, chrome);
  const vh = vp.vh || 900;
  if ((vp.vw || 1400) < NARROW_MAX) {
    const h = Math.max(240, Math.round(vh * 0.42));
    const w = Math.max(260, area.right - area.left - 24);
    return { x: area.left + 12, y: vh - h - 46, w, h, ax: "left", ay: "bottom", pinned: true, dock: "bottom" };
  }
  const w = Math.max(360, Math.min(620, Math.round((area.right - area.left) * 0.44)));
  const h = Math.max(300, vh - 64 - 60);
  return { x: Math.round(area.right - w - 12), y: 64, w, h, ax: "right", ay: "top", pinned: true, dock: "right" };
}

/**
 * A fresh popout float under the cursor (prototype cardGrab drag path).
 * `cx`/`cy` = cursor position.
 */
export function popoutFloatAtCursor(cx: number, cy: number, vp: Viewport): CardFloat {
  const x = Math.max(8, Math.min(cx - 46, (vp.vw || 1400) - POPOUT_W - 12));
  const y = Math.max(52, cy - 14);
  return { x, y, w: POPOUT_W, h: POPOUT_H, ax: null, ay: null, pinned: false };
}

/**
 * Snap a candidate float position (prototype startFloatDrag inner loop): a 16px
 * grid tick (within TICK) then a 12px magnet to the 3 ax / 3 ay anchor targets,
 * then clamp into the viewport. Returns the snapped x/y and which anchor (if any)
 * was hit, so the caller records it on mouseup.
 */
export function snapFloat(
  nx: number,
  ny: number,
  fl: Pick<CardFloat, "w" | "h">,
  vp: Viewport,
  chrome: Chrome,
): { x: number; y: number; ax: CardFloat["ax"]; ay: CardFloat["ay"] } {
  const vw = vp.vw || 1400;
  const vh = vp.vh || 900;
  const area = mainArea(vp, chrome);

  const gx = Math.round(nx / GRID) * GRID;
  if (Math.abs(gx - nx) <= TICK) nx = gx;
  const gy = Math.round(ny / GRID) * GRID;
  if (Math.abs(gy - ny) <= TICK) ny = gy;

  const tX: { v: number; a: CardFloat["ax"] }[] = [
    { v: area.left + 12, a: "left" },
    { v: Math.round(area.left + (area.right - area.left - fl.w) / 2), a: "cx" },
    { v: area.right - fl.w - 12, a: "right" },
  ];
  let ax: CardFloat["ax"] = null;
  for (const t of tX) {
    if (Math.abs(nx - t.v) <= MAG) {
      nx = t.v;
      ax = t.a;
      break;
    }
  }
  const tY: { v: number; a: CardFloat["ay"] }[] = [
    { v: 64, a: "top" },
    { v: Math.round(64 + (vh - 40 - 64 - fl.h) / 2), a: "cy" },
    { v: vh - 40 - fl.h - 12, a: "bottom" },
  ];
  let ay: CardFloat["ay"] = null;
  for (const t of tY) {
    if (Math.abs(ny - t.v) <= MAG) {
      ny = t.v;
      ay = t.a;
      break;
    }
  }

  nx = Math.min(Math.max(nx, -(fl.w - 90)), vw - 90);
  ny = Math.min(Math.max(ny, 50), vh - 46);
  return { x: nx, y: ny, ax, ay };
}

/**
 * Re-resolve an anchored float's pixel position after the chrome/viewport
 * changed (prototype componentDidUpdate). Free (null-anchor) floats keep their
 * pixel position but are still clamped into bounds.
 */
export function reanchorFloat(fl: CardFloat, vp: Viewport, chrome: Chrome): { x: number; y: number } {
  const area = mainArea(vp, chrome);
  const vw = vp.vw || 1400;
  const vh = vp.vh || 900;
  let x = fl.x;
  let y = fl.y;
  if (fl.ax === "right") x = area.right - fl.w - 12;
  else if (fl.ax === "left") x = area.left + 12;
  else if (fl.ax === "cx") x = Math.round(area.left + (area.right - area.left - fl.w) / 2);
  if (fl.ay === "bottom") y = vh - 40 - fl.h - 12;
  else if (fl.ay === "top") y = 64;
  else if (fl.ay === "cy") y = Math.round(64 + (vh - 40 - 64 - fl.h) / 2);
  x = Math.min(Math.max(x, -(fl.w - 90)), vw - 90);
  y = Math.min(Math.max(y, 50), vh - 46);
  return { x, y };
}

/**
 * The real body padding a page reserves so content never sits under a PINNED
 * (space-reserving) float (prototype renderVals 6145). Popouts (pinned:false)
 * reserve nothing. Returns px padding for the right and bottom edges.
 */
export function bodyPad(
  float: Record<string, CardFloat>,
  vp: Viewport,
  chrome: Chrome,
): { right: number; bottom: number } {
  let right = 16;
  let bottom = 14;
  const pins = Object.values(float).filter((f) => f.pinned);
  const dockedR = pins.filter((f) => f.dock === "right");
  const dockedB = pins.filter((f) => f.dock === "bottom");
  const area = mainArea(vp, chrome);
  if (dockedR.length) {
    const minX = Math.min(...dockedR.map((f) => f.x));
    right = Math.max(16, area.right - minX + 12);
  }
  if (dockedB.length) {
    const minY = Math.min(...dockedB.map((f) => f.y));
    bottom = Math.max(14, (vp.vh || 900) - minY + 8);
  }
  return { right, bottom };
}

/** Is a mousedown/dblclick within the draggable header band and off any control? */
export function isHeaderGesture(target: EventTarget | null, clientY: number, cardTop: number): boolean {
  if (clientY - cardTop > HEADER_BAND) return false;
  if (
    target instanceof Element &&
    target.closest("button,input,textarea,select,a,[role=button],[role=listbox],[contenteditable]")
  ) {
    return false;
  }
  return true;
}
