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

function obj(
  code: string,
  kind: PinnedObject["kind"] = "workOrder",
): PinnedObject {
  return { kind, code, title: `title ${code}`, fields: [] };
}

describe("pinObject", () => {
  it("adds a pinned panel with a deterministic id", () => {
    const panels = pinObject([], "overview", obj("WO-1"), "right");
    expect(panels).toHaveLength(1);
    expect(panels[0]).toMatchObject({
      id: "overview:workOrder:WO-1",
      mode: "pinned",
      area: "right",
    });
  });

  it("dedupes: re-pinning the same object moves it, never duplicates", () => {
    let panels = pinObject([], "overview", obj("WO-1"), "right");
    panels = pinObject(panels, "overview", obj("WO-1"), "left");
    expect(panels).toHaveLength(1);
    expect(panels[0].area).toBe("left");
  });

  it("keeps objects with the same code when their kinds differ", () => {
    let panels = pinObject([], "overview", obj("DUP-1", "workOrder"), "left");
    panels = pinObject(panels, "overview", obj("DUP-1", "support"), "right");
    expect(panels.map((panel) => panel.id)).toEqual([
      "overview:workOrder:DUP-1",
      "overview:support:DUP-1",
    ]);
  });

  it("evicts an overlapping same-screen pinned panel to the tray", () => {
    let panels = pinObject([], "overview", obj("WO-1"), "tr");
    panels = pinObject(panels, "overview", obj("WO-2"), "right"); // right covers tr
    const wo1 = panels.find((p) => p.id === "overview:workOrder:WO-1");
    const wo2 = panels.find((p) => p.id === "overview:workOrder:WO-2");
    expect(wo1?.mode).toBe("minimized");
    expect(wo2?.mode).toBe("pinned");
  });

  it("does not evict a non-overlapping panel", () => {
    let panels = pinObject([], "overview", obj("WO-1"), "left");
    panels = pinObject(panels, "overview", obj("WO-2"), "right");
    expect(panels.every((p) => p.mode === "pinned")).toBe(true);
  });

  it("does not evict panels on another screen", () => {
    let panels = pinObject([], "attendance", obj("AT-1"), "right");
    panels = pinObject(panels, "overview", obj("WO-1"), "right");
    expect(panels.find((p) => p.screen === "attendance")?.mode).toBe("pinned");
  });
});

describe("minimize / restore / close", () => {
  it("minimize then restore returns to the last pinned area", () => {
    let panels = pinObject([], "overview", obj("WO-1"), "tr");
    panels = minimizePanel(panels, "overview:workOrder:WO-1");
    expect(panels[0].mode).toBe("minimized");
    panels = restorePanel(panels, "overview:workOrder:WO-1");
    expect(panels[0]).toMatchObject({ mode: "pinned", area: "tr" });
  });

  it("restore evicts an overlapping pinned panel", () => {
    let panels = pinObject([], "overview", obj("WO-1"), "right");
    panels = minimizePanel(panels, "overview:workOrder:WO-1");
    panels = pinObject(panels, "overview", obj("WO-2"), "tr");
    panels = restorePanel(panels, "overview:workOrder:WO-1"); // right overlaps tr
    expect(panels.find((p) => p.id === "overview:workOrder:WO-2")?.mode).toBe(
      "minimized",
    );
    expect(panels.find((p) => p.id === "overview:workOrder:WO-1")?.mode).toBe(
      "pinned",
    );
  });

  it("close removes the panel", () => {
    let panels = pinObject([], "overview", obj("WO-1"), "right");
    panels = closePanel(panels, "overview:workOrder:WO-1");
    expect(panels).toHaveLength(0);
  });
});

describe("popout / float", () => {
  it("popout switches mode to float with a grid-snapped default rect", () => {
    let panels = pinObject([], "overview", obj("WO-1"), "right");
    panels = popoutPanel(panels, "overview:workOrder:WO-1");
    expect(panels[0].mode).toBe("float");
    expect(panels[0].float).toBeDefined();
  });

  it("moveFloat snaps to the 16px grid", () => {
    let panels = pinObject([], "overview", obj("WO-1"), "right");
    panels = popoutPanel(panels, "overview:workOrder:WO-1");
    panels = moveFloat(panels, "overview:workOrder:WO-1", {
      x: 100,
      y: 105,
      w: 400,
      h: 300,
    });
    expect(panels[0].float).toEqual({ x: 96, y: 112, w: 400, h: 304 });
  });
});

describe("snapToGrid", () => {
  it("rounds each dimension to the nearest 16px", () => {
    expect(snapToGrid({ x: 7, y: 9, w: 23, h: 25 })).toEqual({
      x: 0,
      y: 16,
      w: 16,
      h: 32,
    });
  });
});

describe("clearScreen", () => {
  it("drops only the target screen's panels", () => {
    let panels = pinObject([], "overview", obj("WO-1"), "right");
    panels = pinObject(panels, "attendance", obj("AT-1"), "right");
    panels = clearScreen(panels, "overview");
    expect(panels).toHaveLength(1);
    expect(panels[0].screen).toBe("attendance");
  });
});
