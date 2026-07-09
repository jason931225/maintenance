import { describe, expect, it } from "vitest";

import {
  areasOverlap,
  computeSectionLayout,
  gridAreaOf,
  quadsOf,
  zoneFromPoint,
  zoneToArea,
} from "./layout";

const RECT = { left: 0, top: 0, width: 1000, height: 1000 };

describe("zoneFromPoint", () => {
  it("maps the four corners", () => {
    expect(zoneFromPoint(50, 50, RECT)).toBe("tl");
    expect(zoneFromPoint(950, 50, RECT)).toBe("tr");
    expect(zoneFromPoint(50, 950, RECT)).toBe("bl");
    expect(zoneFromPoint(950, 950, RECT)).toBe("br");
  });
  it("maps the four edges", () => {
    expect(zoneFromPoint(500, 50, RECT)).toBe("top");
    expect(zoneFromPoint(500, 950, RECT)).toBe("bottom");
    expect(zoneFromPoint(50, 500, RECT)).toBe("left");
    expect(zoneFromPoint(950, 500, RECT)).toBe("right");
  });
  it("maps the middle to center", () => {
    expect(zoneFromPoint(500, 500, RECT)).toBe("center");
  });
  it("guards a zero-size rect", () => {
    expect(zoneFromPoint(0, 0, { left: 0, top: 0, width: 0, height: 0 })).toBe("center");
  });
});

describe("zoneToArea", () => {
  it("maps corners and edges to the same-named area", () => {
    expect(zoneToArea("tl")).toBe("tl");
    expect(zoneToArea("right")).toBe("right");
  });
  it("returns null for center (no pin)", () => {
    expect(zoneToArea("center")).toBeNull();
  });
});

describe("quadsOf", () => {
  it("expands halves to two quadrants", () => {
    expect(quadsOf("right")).toEqual(["tr", "br"]);
    expect(quadsOf("top")).toEqual(["tl", "tr"]);
  });
  it("keeps a quadrant as itself", () => {
    expect(quadsOf("bl")).toEqual(["bl"]);
  });
});

describe("areasOverlap", () => {
  it("detects a quadrant inside a half", () => {
    expect(areasOverlap("tr", "right")).toBe(true);
    expect(areasOverlap("right", "tr")).toBe(true);
  });
  it("is false for disjoint areas", () => {
    expect(areasOverlap("left", "right")).toBe(false);
    expect(areasOverlap("tl", "br")).toBe(false);
  });
});

describe("computeSectionLayout", () => {
  it("gives the full grid to the section with no panels", () => {
    const layout = computeSectionLayout([]);
    expect(layout.sectionArea).toBe("1 / 1 / 3 / 3");
    expect(layout.placeholders).toEqual([]);
  });

  it("splits to the left half when a panel takes the right half", () => {
    const layout = computeSectionLayout(["right"]);
    expect(layout.sectionArea).toBe(gridAreaOf("left"));
    expect(layout.placeholders).toEqual([]);
  });

  it("keeps the section a clean half with a placeholder for a single corner pin", () => {
    // panel in tr: section should take the left half (never an L-shape), leaving
    // br as a dashed placeholder.
    const layout = computeSectionLayout(["tr"]);
    expect(layout.sectionArea).toBe(gridAreaOf("left"));
    expect(layout.placeholders).toEqual(["br"]);
  });

  it("hides the section when panels fill the whole grid", () => {
    const layout = computeSectionLayout(["left", "right"]);
    expect(layout.sectionArea).toBeNull();
    expect(layout.placeholders).toEqual([]);
  });
});
