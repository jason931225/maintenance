import { describe, expect, it } from "vitest";

import { defaultWindowState, sanitizeWindowState } from "./sanitize";
import type { CardRegistry } from "./types";

const REGISTRY: CardRegistry = {
  a: { off: 214, main: ["roster"], side: ["issues", "board"], min: {} },
  b: { off: 176, main: ["teams"], side: ["tasks"], min: {} },
};

describe("sanitizeWindowState", () => {
  it("returns registry defaults for non-object / empty input", () => {
    expect(sanitizeWindowState(undefined, REGISTRY)).toEqual(defaultWindowState(REGISTRY));
    expect(sanitizeWindowState(42, REGISTRY)).toEqual(defaultWindowState(REGISTRY));
    expect(sanitizeWindowState({}, REGISTRY)).toEqual(defaultWindowState(REGISTRY));
  });

  it("drops card ids absent from the registry", () => {
    const out = sanitizeWindowState(
      { layout: { a: { main: ["roster", "ghost"], side: ["issues"] } } },
      REGISTRY,
    );
    expect(out.layout.a.main).toEqual(["roster"]);
    // board was omitted from the blob → rejoins its registry home column
    expect(out.layout.a.side).toEqual(["issues", "board"]);
  });

  it("clamps the split ratio into 0.42-0.78", () => {
    expect(sanitizeWindowState({ layout: { a: { split: 0.9 } } }, REGISTRY).layout.a.split).toBe(0.78);
    expect(sanitizeWindowState({ layout: { a: { split: 0.1 } } }, REGISTRY).layout.a.split).toBe(0.42);
    expect(sanitizeWindowState({ layout: { a: { split: "x" } } }, REGISTRY).layout.a.split).toBe(0.63);
  });

  it("keeps only valid tray entries and dedupes them", () => {
    const out = sanitizeWindowState(
      {
        min: [
          { scr: "a", id: "issues" },
          { scr: "a", id: "issues" }, // dup
          { scr: "a", id: "ghost" }, // unknown id
          { scr: "z", id: "roster" }, // unknown screen
          "garbage",
        ],
      },
      REGISTRY,
    );
    expect(out.min).toEqual([{ scr: "a", id: "issues" }]);
  });

  it("coerces float numbers, validates anchors, and defaults a pin's dock", () => {
    const out = sanitizeWindowState(
      {
        float: {
          "a:roster": { x: 10, y: 20, w: 5, h: 5, ax: "right", ay: "bogus", pinned: true },
          "b:tasks": { x: "nope", y: 30, w: 400, h: 300, ax: "left", ay: "top", pinned: false },
          "z:ghost": { x: 0, y: 0, w: 1, h: 1 }, // unknown → dropped
        },
      },
      REGISTRY,
    );
    expect(out.float["a:roster"].w).toBeGreaterThanOrEqual(220); // floored
    expect(out.float["a:roster"].ay).toBeNull(); // invalid anchor dropped
    expect(out.float["a:roster"].dock).toBe("right"); // pin needs a dock
    expect(out.float["b:tasks"].x).toBe(96); // non-finite coerced to default
    expect(out.float["z:ghost"]).toBeUndefined();
  });

  it("never leaves a card both minimized and floated", () => {
    const out = sanitizeWindowState(
      {
        min: [{ scr: "a", id: "roster" }],
        float: { "a:roster": { x: 0, y: 0, w: 400, h: 300, pinned: false } },
      },
      REGISTRY,
    );
    expect(out.min).toEqual([{ scr: "a", id: "roster" }]);
    expect(out.float["a:roster"]).toBeUndefined();
  });
});
