import { describe, expect, it } from "vitest";

import { connect, emptyDoc, parseDoc, serializeDoc, validateDoc } from "./doc";
import { stubCanvasDoc } from "./stub";
import type { CanvasDoc } from "./types";

describe("connect", () => {
  const base: CanvasDoc = {
    version: 1,
    nodes: [
      { id: "a", kind: "trigger", title: "a" },
      { id: "b", kind: "action", title: "b" },
    ],
    edges: [],
    vars: [],
  };

  it("adds an edge between two existing nodes", () => {
    const next = connect(base, "a", "b");
    expect(next.edges).toHaveLength(1);
    expect(next.edges[0]).toMatchObject({ from: "a", to: "b" });
    expect(base.edges).toHaveLength(0); // immutable
  });

  it("rejects self-loops, unknown nodes, and duplicates", () => {
    expect(connect(base, "a", "a").edges).toHaveLength(0);
    expect(connect(base, "a", "ghost").edges).toHaveLength(0);
    const once = connect(base, "a", "b");
    expect(connect(once, "a", "b").edges).toHaveLength(1);
  });

  it("rejects an unknown port", () => {
    expect(connect(base, "a", "b", "nonexistent").edges).toHaveLength(0);
  });
});

describe("validateDoc", () => {
  it("flags a branch with fewer than two outputs", () => {
    const doc: CanvasDoc = {
      version: 1,
      nodes: [{ id: "x", kind: "branch", title: "x", outputs: [{ port: "only", label: "only" }] }],
      edges: [],
      vars: [],
    };
    expect(validateDoc(doc)).toContain("branch-needs-two-outputs:x");
  });

  it("accepts the stub doc", () => {
    expect(validateDoc(stubCanvasDoc())).toEqual([]);
  });
});

describe("serialize / parse", () => {
  it("round-trips a doc", () => {
    const doc = stubCanvasDoc();
    expect(parseDoc(serializeDoc(doc))).toEqual(doc);
  });

  it("rejects a malformed blob", () => {
    expect(() => parseDoc(JSON.stringify({ version: 2 }))).toThrow();
    expect(() => parseDoc(JSON.stringify({ version: 1, nodes: {}, edges: [], vars: [] }))).toThrow();
  });

  it("emptyDoc is a valid empty version-1 doc", () => {
    expect(parseDoc(serializeDoc(emptyDoc()))).toEqual(emptyDoc());
  });
});
