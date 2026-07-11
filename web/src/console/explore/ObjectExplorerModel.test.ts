import { describe, expect, it } from "vitest";

import {
  buildObjectExplorerView,
  edgeLabelOccluded,
  layoutObjectExplorerNodes,
  type ObjectExplorerModel,
  type ObjectExplorerNodeLayout,
} from "./ObjectExplorerModel";

// A hub with `n` direct neighbours — the shape that made the graph overlap
// (verdict R10 "explore graph overlap"): 8 nodes packed on one ring.
function hub(n: number): ObjectExplorerModel {
  const nodes = [{ id: "hub", type: "t", code: "H", label: "hub" }];
  const object_links = [];
  for (let i = 0; i < n; i += 1) {
    nodes.push({ id: `n${String(i)}`, type: "t", code: `N${String(i)}`, label: `n${String(i)}` });
    object_links.push({ id: `l${String(i)}`, source_id: "hub", target_id: `n${String(i)}`, relation: "r" });
  }
  return { nodes, object_links };
}

describe("layoutObjectExplorerNodes", () => {
  it("keeps the focus centred and every node inside the 0–100 viewport", () => {
    const layout = layoutObjectExplorerNodes(buildObjectExplorerView(hub(8), "hub"));
    const focus = layout.find((l) => l.id === "hub");
    expect(focus).toMatchObject({ x: 50, y: 50, role: "focus" });
    for (const node of layout) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x).toBeLessThanOrEqual(100);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeLessThanOrEqual(100);
    }
  });

  it("spreads a crowded ring so adjacent neighbours do not collide", () => {
    const layout = layoutObjectExplorerNodes(buildObjectExplorerView(hub(8), "hub"));
    const ring = layout.filter((l) => l.id !== "hub");
    // Minimum pairwise distance across the ring must clear a tightened pill's
    // footprint (~14% viewport) — pills that overlap read as one blob.
    let min = Infinity;
    for (let i = 0; i < ring.length; i += 1) {
      for (let j = i + 1; j < ring.length; j += 1) {
        const d = Math.hypot(ring[i].x - ring[j].x, ring[i].y - ring[j].y);
        min = Math.min(min, d);
      }
    }
    expect(min).toBeGreaterThan(14);
  });

  it("clamps node coordinates well inside the canvas so edge labels never clip (verdict r13 explore left-edge clip)", () => {
    // A large ring pushes radius up to RING_MAX (47) with node angles spanning
    // the full circle, including near-cardinal points where a pre-clamp x/y
    // would land at ~3% or ~97% — a percent anchor nowhere near half a real
    // ~96–140px pill's pixel width, so the canvas's overflow:hidden clipped
    // the label (e.g. A0008/90002). The clamp keeps every anchor within a
    // real margin regardless of how wide the ring spreads.
    const layout = layoutObjectExplorerNodes(buildObjectExplorerView(hub(24), "hub"));
    for (const node of layout) {
      expect(node.x).toBeGreaterThanOrEqual(20);
      expect(node.x).toBeLessThanOrEqual(80);
      expect(node.y).toBeGreaterThanOrEqual(12);
      expect(node.y).toBeLessThanOrEqual(88);
    }
  });
});

describe("edgeLabelOccluded", () => {
  const node = (id: string, x: number, y: number): ObjectExplorerNodeLayout => ({
    id,
    node: { id, type: "t", code: id, label: id },
    x,
    y,
    role: "related",
  });

  it("flags a label a non-endpoint pill sits on top of", () => {
    const nodes = [node("a", 20, 50), node("b", 80, 50), node("c", 50, 50)];
    // edge a→b runs through the middle where c sits — c occludes the label.
    expect(edgeLabelOccluded({ x: 50, y: 50 }, nodes, ["a", "b"])).toBe(true);
  });

  it("ignores the edge's own endpoints and far-off pills", () => {
    const nodes = [node("a", 20, 50), node("b", 80, 50)];
    // only the endpoints are near the midpoint — never self-occlude.
    expect(edgeLabelOccluded({ x: 20, y: 50 }, nodes, ["a", "b"])).toBe(false);
    // a third pill well clear of the midpoint box does not occlude.
    expect(edgeLabelOccluded({ x: 50, y: 50 }, [...nodes, node("c", 50, 80)], ["a", "b"])).toBe(false);
  });
});
