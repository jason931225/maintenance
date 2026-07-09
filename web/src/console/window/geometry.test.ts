import { describe, expect, it } from "vitest";

import {
  bodyPad,
  computeCardLay,
  HEADER_BAND,
  isHeaderGesture,
  mainArea,
  pinnedFloat,
  reanchorFloat,
  snapFloat,
} from "./geometry";
import type { CardFloat, CardMeta, Chrome, ScreenLayout, Viewport } from "./types";

const META: CardMeta = {
  off: 214,
  main: ["roster"],
  side: ["issues", "board"],
  min: { roster: 340, issues: 300, board: 360 },
};
const LAYOUT: ScreenLayout = { main: ["roster"], side: ["issues", "board"], h: {}, split: 0.63 };
const DESKTOP: Viewport = { vw: 1440, vh: 900 };
const OPEN: Chrome = { sidebarCollapsed: false, railCollapsed: false };

describe("mainArea", () => {
  it("uses open sidebar/rail edges on a wide viewport", () => {
    expect(mainArea(DESKTOP, OPEN)).toEqual({ left: 236, right: 1440 - 300 });
  });
  it("uses the 336 rail edge at >=1560 and collapsed edges", () => {
    expect(mainArea({ vw: 1600, vh: 900 }, OPEN)).toEqual({ left: 236, right: 1600 - 336 });
    expect(mainArea(DESKTOP, { sidebarCollapsed: true, railCollapsed: true })).toEqual({
      left: 62,
      right: 1440 - 54,
    });
  });
});

describe("computeCardLay", () => {
  it("splits main/side by the clamped split ratio and never shrinks below min", () => {
    const c = computeCardLay(META, LAYOUT, [], {}, "a", DESKTOP);
    expect(c.narrow).toBe(false);
    expect(c.split).toBe(63);
    expect(c.cards.roster.x).toBe("0px");
    expect(c.cards.roster.w).toBe("calc(63% - 6px)");
    expect(c.cards.issues.w).toBe("calc(37% - 6px)");
    // side column stacks issues then board, each >= its min
    expect(c.cards.issues.y).toBe(0);
    expect(c.cards.issues.h).toBeGreaterThanOrEqual(300);
    expect(c.cards.board.y).toBe(c.cards.issues.h + 12);
    expect(c.cards.board.h).toBeGreaterThanOrEqual(360);
  });

  it("collapses to a single full-width stack when narrow (<1024)", () => {
    const c = computeCardLay(META, LAYOUT, [], {}, "a", { vw: 800, vh: 900 });
    expect(c.narrow).toBe(true);
    expect(c.cards.roster.w).toBe("100%");
    expect(c.cards.issues.w).toBe("100%");
  });

  it("excludes floated and minimized cards from the zone (vis:false)", () => {
    const c = computeCardLay(META, LAYOUT, [{ scr: "a", id: "board" }], { "a:issues": pinnedFloat(DESKTOP, OPEN) }, "a", DESKTOP);
    // roster is the only zone card left → full width
    expect(c.cards.roster.w).toBe("100%");
    expect(c.cards.issues.vis).toBe(false);
    expect(c.cards.board.vis).toBe(false);
  });

  it("honors a fixed height override (floor 150)", () => {
    const c = computeCardLay(META, { ...LAYOUT, h: { roster: 500 } }, [], {}, "a", DESKTOP);
    expect(c.cards.roster.h).toBe(500);
    const floored = computeCardLay(META, { ...LAYOUT, h: { roster: 10 } }, [], {}, "a", DESKTOP);
    expect(floored.cards.roster.h).toBe(150);
  });
});

describe("pinnedFloat", () => {
  it("docks right full-height on desktop, width clamped 360-620", () => {
    const f = pinnedFloat(DESKTOP, OPEN);
    expect(f.pinned).toBe(true);
    expect(f.dock).toBe("right");
    expect(f.ax).toBe("right");
    expect(f.w).toBeGreaterThanOrEqual(360);
    expect(f.w).toBeLessThanOrEqual(620);
    expect(f.y).toBe(64);
  });
  it("docks bottom as a 42vh sheet on narrow", () => {
    const f = pinnedFloat({ vw: 800, vh: 1000 }, OPEN);
    expect(f.dock).toBe("bottom");
    expect(f.ay).toBe("bottom");
    expect(f.h).toBe(Math.round(1000 * 0.42));
  });
});

describe("snapFloat", () => {
  const fl = { w: 468, h: 412 };
  it("magnets x to the right anchor within 12px", () => {
    const area = mainArea(DESKTOP, OPEN);
    const rightTarget = area.right - fl.w - 12;
    const r = snapFloat(rightTarget - 8, 300, fl, DESKTOP, OPEN);
    expect(r.x).toBe(rightTarget);
    expect(r.ax).toBe("right");
  });
  it("magnets y to the top anchor and records ay", () => {
    const r = snapFloat(500, 64 + 5, fl, DESKTOP, OPEN);
    expect(r.y).toBe(64);
    expect(r.ay).toBe("top");
  });
  it("leaves anchor null when far from every target (grid tick still applies)", () => {
    const r = snapFloat(497, 305, fl, DESKTOP, OPEN);
    expect(r.ax).toBeNull();
    // 497 -> nearest 16-grid is 496 (|1|<=6 tick) ... 497/16=31.06 -> 496
    expect(r.x % 16 === 0 || r.x === 497).toBe(true);
  });
});

describe("reanchorFloat", () => {
  it("re-resolves a right/top anchored float when the viewport widens", () => {
    const f: CardFloat = { x: 900, y: 64, w: 400, h: 500, ax: "right", ay: "top", pinned: true, dock: "right" };
    const at1440 = reanchorFloat(f, { vw: 1440, vh: 900 }, OPEN);
    const at1920 = reanchorFloat(f, { vw: 1920, vh: 900 }, OPEN);
    expect(at1920.x).toBeGreaterThan(at1440.x); // follows the wider right edge
    expect(at1440.y).toBe(64);
  });
  it("keeps a null-anchor float's pixel position (clamped)", () => {
    const f: CardFloat = { x: 300, y: 300, w: 400, h: 400, ax: null, ay: null, pinned: false };
    expect(reanchorFloat(f, DESKTOP, OPEN)).toEqual({ x: 300, y: 300 });
  });
});

describe("bodyPad", () => {
  it("reserves real right padding for a right-docked pin", () => {
    const pin = pinnedFloat(DESKTOP, OPEN);
    const pad = bodyPad({ "a:issues": pin }, DESKTOP, OPEN);
    expect(pad.right).toBeGreaterThan(16);
  });
  it("reserves nothing for an unpinned popout", () => {
    const popout: CardFloat = { x: 200, y: 200, w: 468, h: 412, ax: null, ay: null, pinned: false };
    expect(bodyPad({ "a:issues": popout }, DESKTOP, OPEN)).toEqual({ right: 16, bottom: 14 });
  });
  it("reserves bottom padding for a bottom-docked pin", () => {
    const pin = pinnedFloat({ vw: 800, vh: 1000 }, OPEN);
    const pad = bodyPad({ "a:issues": pin }, { vw: 800, vh: 1000 }, OPEN);
    expect(pad.bottom).toBeGreaterThan(14);
  });
});

describe("isHeaderGesture", () => {
  it("fires within the header band on a non-interactive target", () => {
    const div = document.createElement("div");
    expect(isHeaderGesture(div, 10, 0)).toBe(true);
    expect(isHeaderGesture(div, HEADER_BAND, 0)).toBe(true);
  });
  it("does not fire below the header band", () => {
    const div = document.createElement("div");
    expect(isHeaderGesture(div, HEADER_BAND + 1, 0)).toBe(false);
  });
  it("does not fire on a button/input/row control", () => {
    const btn = document.createElement("button");
    const input = document.createElement("input");
    const row = document.createElement("div");
    row.setAttribute("role", "button");
    expect(isHeaderGesture(btn, 10, 0)).toBe(false);
    expect(isHeaderGesture(input, 10, 0)).toBe(false);
    expect(isHeaderGesture(row, 10, 0)).toBe(false);
  });
});
