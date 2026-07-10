import { describe, expect, it } from "vitest";

import { UNION_SCOPE_ID, computeScopeOptions } from "./authz";

const ALL = "그룹 전체";

describe("computeScopeOptions — scope switcher lists only authorized entities", () => {
  it("prepends the union row spanning EXACTLY the authorized entities", () => {
    const opts = computeScopeOptions(
      [
        { id: "coss", label: "㈜코스" },
        { id: "knl", label: "KNL 물류" },
      ],
      ALL,
    );
    expect(opts[0].id).toBe(UNION_SCOPE_ID);
    expect(opts[0].isUnion).toBe(true);
    expect(opts[0].label).toBe(ALL);
    // union spans only the authorized ids — never a literal all-orgs escape hatch
    expect(opts[0].memberIds).toEqual(["coss", "knl"]);
    expect(opts.slice(1).map((o) => o.id)).toEqual(["coss", "knl"]);
    expect(opts.slice(1).every((o) => !o.isUnion)).toBe(true);
  });

  it("de-duplicates entities by id, preserving first-seen order", () => {
    const opts = computeScopeOptions(
      [
        { id: "knl", label: "KNL 물류" },
        { id: "knl", label: "KNL (dup)" },
        { id: "coss", label: "㈜코스" },
      ],
      ALL,
    );
    expect(opts.map((o) => o.id)).toEqual([UNION_SCOPE_ID, "knl", "coss"]);
    expect(opts[0].memberIds).toEqual(["knl", "coss"]);
  });

  it("a single authorized entity yields a union spanning just that one", () => {
    const opts = computeScopeOptions([{ id: "coss", label: "㈜코스" }], ALL);
    expect(opts.map((o) => o.id)).toEqual([UNION_SCOPE_ID, "coss"]);
    expect(opts[0].memberIds).toEqual(["coss"]);
  });

  it("no authorized entities → the union is empty, not all-orgs", () => {
    const opts = computeScopeOptions([], ALL);
    expect(opts).toHaveLength(1);
    expect(opts[0].id).toBe(UNION_SCOPE_ID);
    expect(opts[0].memberIds).toEqual([]);
  });
});
