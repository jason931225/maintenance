// Real predicate evaluation over a sample row (DESIGN §4-20 — the simulation
// panel runs THIS, it is not a decorative toast). Typed field·op·value grammar.

import {
  OPERATORS_BY_TYPE,
  type FieldDef,
  type FieldRegistry,
  type Predicate,
  type PredicateGroup,
  type PredicateOperator,
  type PredicateValue,
  type SampleRow,
} from "./types";

/** Default value for a freshly-picked field, matching its type. */
export function defaultValueForField(field: FieldDef): PredicateValue {
  switch (field.type) {
    case "number":
      return { kind: "number", value: 0 };
    case "bool":
      return { kind: "bool", value: true };
    case "date":
      return { kind: "date", value: "" };
    case "enum":
      return { kind: "enum", value: field.choices?.[0]?.id ?? "" };
    case "code":
      return { kind: "code", value: "" };
    case "text":
      return { kind: "text", value: "" };
  }
}

/** First operator admitted by a field type (used when a field is re-picked). */
export function defaultOperatorForField(field: FieldDef): PredicateOperator {
  return OPERATORS_BY_TYPE[field.type][0];
}

function findField(registry: FieldRegistry, key: string): FieldDef | undefined {
  return registry.find((f) => f.key === key);
}

function asNumber(raw: unknown): number | null {
  if (typeof raw === "number" && !Number.isNaN(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function asTime(raw: unknown): number | null {
  if (typeof raw !== "string" || raw === "") return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

function compareOrdered(op: PredicateOperator, actual: number, target: number): boolean {
  switch (op) {
    case "gte":
      return actual >= target;
    case "lte":
      return actual <= target;
    case "eq":
      return actual === target;
    case "neq":
      return actual !== target;
    case "in":
      return false;
  }
}

/**
 * Evaluate one predicate over a sample row. Fail-closed: an unknown field, a
 * missing value, or a type mismatch is `false`, never a silent pass (§5d).
 */
export function evalPredicate(
  pred: Predicate,
  sample: SampleRow,
  registry: FieldRegistry,
): boolean {
  const field = findField(registry, pred.field);
  if (!field) return false;
  const actual = sample[pred.field];
  const { op, value } = pred;

  switch (value.kind) {
    case "number": {
      const a = asNumber(actual);
      return a === null ? false : compareOrdered(op, a, value.value);
    }
    case "date": {
      const a = asTime(actual);
      const t = asTime(value.value);
      return a === null || t === null ? false : compareOrdered(op, a, t);
    }
    case "bool":
      return op === "eq" ? actual === value.value : actual !== value.value;
    case "text":
    case "enum":
    case "code": {
      const a = typeof actual === "string" ? actual : null;
      if (a === null) return false;
      return op === "neq" ? a !== value.value : a === value.value;
    }
    case "enumSet": {
      // `∈` membership: the sample value is one of the selected choices.
      const a = typeof actual === "string" ? actual : null;
      return a === null ? false : value.value.includes(a);
    }
  }
}

/** Evaluate a whole group (and/or) over one sample row. Empty group ⇒ true. */
export function evalGroup(
  group: PredicateGroup,
  sample: SampleRow,
  registry: FieldRegistry,
): boolean {
  if (group.predicates.length === 0) return true;
  const results = group.predicates.map((p) => evalPredicate(p, sample, registry));
  return group.join === "and" ? results.every(Boolean) : results.some(Boolean);
}

export interface SimulationResult {
  pass: number;
  total: number;
}

/** Run the predicate set over the seed samples → pass/total (real eval). */
export function runSimulation(
  group: PredicateGroup,
  samples: readonly SampleRow[],
  registry: FieldRegistry,
): SimulationResult {
  let pass = 0;
  for (const sample of samples) {
    if (evalGroup(group, sample, registry)) pass += 1;
  }
  return { pass, total: samples.length };
}
