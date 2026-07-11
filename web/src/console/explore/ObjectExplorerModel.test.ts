import { describe, expect, it } from "vitest";

import {
  buildObjectExplorerView,
  layoutObjectExplorerNodes,
  type ObjectExplorerModel,
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
});
