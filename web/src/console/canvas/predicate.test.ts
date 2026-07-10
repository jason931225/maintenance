import { describe, expect, it } from "vitest";

import { evalGroup, evalPredicate, runSimulation } from "./predicate";
import { STUB_FIELD_REGISTRY, STUB_SAMPLES } from "./stub";
import type { Predicate, PredicateGroup } from "./types";

const reg = STUB_FIELD_REGISTRY;

function p(partial: Omit<Predicate, "id">): Predicate {
  return { id: "t", ...partial };
}

describe("evalPredicate", () => {
  it("compares numbers by operator", () => {
    const sample = { absence_count: 3 };
    expect(evalPredicate(p({ field: "absence_count", op: "gte", value: { kind: "number", value: 3 } }), sample, reg)).toBe(true);
    expect(evalPredicate(p({ field: "absence_count", op: "lte", value: { kind: "number", value: 2 } }), sample, reg)).toBe(false);
    expect(evalPredicate(p({ field: "absence_count", op: "neq", value: { kind: "number", value: 4 } }), sample, reg)).toBe(true);
  });

  it("compares dates chronologically", () => {
    const sample = { opened_at: "2026-07-01" };
    expect(evalPredicate(p({ field: "opened_at", op: "gte", value: { kind: "date", value: "2026-06-01" } }), sample, reg)).toBe(true);
    expect(evalPredicate(p({ field: "opened_at", op: "lte", value: { kind: "date", value: "2026-06-01" } }), sample, reg)).toBe(false);
  });

  it("matches enum membership with ∈", () => {
    const sample = { priority: "high" };
    expect(evalPredicate(p({ field: "priority", op: "in", value: { kind: "enumSet", value: ["med", "high"] } }), sample, reg)).toBe(true);
    expect(evalPredicate(p({ field: "priority", op: "in", value: { kind: "enumSet", value: ["low"] } }), sample, reg)).toBe(false);
  });

  it("matches bool and code equality", () => {
    expect(evalPredicate(p({ field: "is_active", op: "eq", value: { kind: "bool", value: true } }), { is_active: true }, reg)).toBe(true);
    expect(evalPredicate(p({ field: "work_order", op: "eq", value: { kind: "code", value: "WO-2643" } }), { work_order: "WO-2643" }, reg)).toBe(true);
  });

  it("fails closed on unknown field or missing value", () => {
    expect(evalPredicate(p({ field: "nope", op: "eq", value: { kind: "number", value: 1 } }), { nope: 1 }, reg)).toBe(false);
    expect(evalPredicate(p({ field: "absence_count", op: "gte", value: { kind: "number", value: 1 } }), {}, reg)).toBe(false);
  });
});

describe("evalGroup", () => {
  const g = (join: "and" | "or"): PredicateGroup => ({
    join,
    predicates: [
      p({ field: "absence_count", op: "gte", value: { kind: "number", value: 3 } }),
      p({ field: "is_active", op: "eq", value: { kind: "bool", value: true } }),
    ],
  });

  it("empty group is vacuously true", () => {
    expect(evalGroup({ join: "and", predicates: [] }, {}, reg)).toBe(true);
  });

  it("respects and / or joins", () => {
    const sample = { absence_count: 3, is_active: false };
    expect(evalGroup(g("and"), sample, reg)).toBe(false);
    expect(evalGroup(g("or"), sample, reg)).toBe(true);
  });
});

describe("runSimulation", () => {
  it("returns real pass/total over the seed samples", () => {
    const group: PredicateGroup = {
      join: "and",
      predicates: [p({ field: "absence_count", op: "gte", value: { kind: "number", value: 3 } })],
    };
    // absence_count = 3, 1, 4 → two pass.
    expect(runSimulation(group, STUB_SAMPLES, reg)).toEqual({ pass: 2, total: 3 });
  });
});
