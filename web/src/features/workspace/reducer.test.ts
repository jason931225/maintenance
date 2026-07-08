import { describe, expect, it } from "vitest";

import {
  clearScreen,
  closePanel,
  minimizePanel,
  moveFloat,
  pinObject,
  popoutPanel,
  restorePanel,
  snapToGrid,
} from "./reducer";
import type { PinnedObject } from "./types";

function obj(code: string): PinnedObject {
  return { kind: "workOrder", code, title: `title ${code}`, fields: [] };
}

describe("pinObject", () => {
  it("adds a pinned panel with a deterministic id", () => {
    const panels = pinObject([], "work-hub", obj("WO-1"), "right");
    expect(panels).toHaveLength(1);
    expect(panels[0]).toMatchObject({ id: "work-hub:WO-1", mode: "pinned", area: "right" });
  });

  it("dedupes: re-pinning the same object moves it, never duplicates", () => {
    let panels = pinObject([], "work-hub", obj("WO-1"), "right");
    panels = pinObject(panels, "work-hub", obj("WO-1"), "left");
    expect(panels).toHaveLength(1);
    expect(panels[0].area).toBe("left");
  });

  it("evicts an overlapping same-screen pinned panel to the tray", () => {
    let panels = pinObject([], "work-hub", obj("WO-1"), "tr");
    panels = pinObject(panels, "work-hub", obj("WO-2"), "right"); // right covers tr
    const wo1 = panels.find((p) => p.id === "work-hub:WO-1");
    const wo2 = panels.find((p) => p.id === "work-hub:WO-2");
    expect(wo1?.mode).toBe("minimized");
    expect(wo2?.mode).toBe("pinned");
  });

  it("does not evict a non-overlapping panel", () => {
    let panels = pinObject([], "work-hub", obj("WO-1"), "left");
    panels = pinObject(panels, "work-hub", obj("WO-2"), "right");
    expect(panels.every((p) => p.mode === "pinned")).toBe(true);
  });

  it("does not evict panels on another screen", () => {
    let panels = pinObject([], "attendance", obj("AT-1"), "right");
    panels = pinObject(panels, "work-hub", obj("WO-1"), "right");
    expect(panels.find((p) => p.screen === "attendance")?.mode).toBe("pinned");
  });
});

describe("minimize / restore / close", () => {
  it("minimize then restore returns to the last pinned area", () => {
    let panels = pinObject([], "work-hub", obj("WO-1"), "tr");
    panels = minimizePanel(panels, "work-hub:WO-1");
    expect(panels[0].mode).toBe("minimized");
    panels = restorePanel(panels, "work-hub:WO-1");
    expect(panels[0]).toMatchObject({ mode: "pinned", area: "tr" });
  });

  it("restore evicts an overlapping pinned panel", () => {
    let panels = pinObject([], "work-hub", obj("WO-1"), "right");
    panels = minimizePanel(panels, "work-hub:WO-1");
    panels = pinObject(panels, "work-hub", obj("WO-2"), "tr");
    panels = restorePanel(panels, "work-hub:WO-1"); // right overlaps tr
    expect(panels.find((p) => p.id === "work-hub:WO-2")?.mode).toBe("minimized");
    expect(panels.find((p) => p.id === "work-hub:WO-1")?.mode).toBe("pinned");
  });

  it("close removes the panel", () => {
    let panels = pinObject([], "work-hub", obj("WO-1"), "right");
    panels = closePanel(panels, "work-hub:WO-1");
    expect(panels).toHaveLength(0);
  });
});

describe("popout / float", () => {
  it("popout switches mode to float with a grid-snapped default rect", () => {
    let panels = pinObject([], "work-hub", obj("WO-1"), "right");
    panels = popoutPanel(panels, "work-hub:WO-1");
    expect(panels[0].mode).toBe("float");
    expect(panels[0].float).toBeDefined();
  });

  it("moveFloat snaps to the 16px grid", () => {
    let panels = pinObject([], "work-hub", obj("WO-1"), "right");
    panels = popoutPanel(panels, "work-hub:WO-1");
    panels = moveFloat(panels, "work-hub:WO-1", { x: 100, y: 105, w: 400, h: 300 });
    expect(panels[0].float).toEqual({ x: 96, y: 112, w: 400, h: 304 });
  });
});

describe("snapToGrid", () => {
  it("rounds each dimension to the nearest 16px", () => {
    expect(snapToGrid({ x: 7, y: 9, w: 23, h: 25 })).toEqual({ x: 0, y: 16, w: 16, h: 32 });
  });
});

describe("clearScreen", () => {
  it("drops only the target screen's panels", () => {
    let panels = pinObject([], "work-hub", obj("WO-1"), "right");
    panels = pinObject(panels, "attendance", obj("AT-1"), "right");
    panels = clearScreen(panels, "work-hub");
    expect(panels).toHaveLength(1);
    expect(panels[0].screen).toBe("attendance");
  });
});
