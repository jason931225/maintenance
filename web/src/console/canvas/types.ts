// Shared BlockCanvas grammar — the ONE no-code authoring surface reused by
// policy (Cedar P→R→A→Effect), workflow (Trigger→Condition→Branch→Action),
// Automate, and config rules. Generalizes workflows/CanvasBlock.tsx.
//
// Backend contract (be-ontology-engine-arch.md §2/§5) drives every shape so the
// Phase-C wiring is a swap, not a rewrite. See `stub.ts` for wire-pending data.

/** Node kinds, tokened via the existing `--canvas-block-{kind}-*` tokens. */
export type CanvasNodeKind = "trigger" | "condition" | "branch" | "action";

export const CANVAS_NODE_KINDS: readonly CanvasNodeKind[] = [
  "trigger",
  "condition",
  "branch",
  "action",
];

/** A labeled output port. Branch nodes MUST expose ≥2 (validateDoc enforces). */
export interface CanvasOutput {
  /** Stable port key, used as `edge.fromPort`. */
  port: string;
  label: string;
}

export interface CanvasNode {
  id: string;
  kind: CanvasNodeKind;
  title: string;
  detail?: string;
  chips?: string[];
  /** Branch nodes carry ≥2; other kinds may carry an implicit single output. */
  outputs?: CanvasOutput[];
  /** condition/branch predicates authored via the typed predicate editor. */
  predicate?: PredicateGroup;
  /** Layout position (grid units). Missing ⇒ auto-laid in a column. */
  x?: number;
  y?: number;
}

/** A 2px connector edge between an output port of `from` and node `to`. */
export interface CanvasEdge {
  id: string;
  from: string;
  /** Which output of `from` this edge leaves (branch nodes). */
  fromPort?: string;
  to: string;
}

// ── Typed field registry + predicate grammar (§5d / DESIGN §4-20) ───────────

/** Field value types. Maps to the ontology property-def discriminated union. */
export type FieldType = "number" | "enum" | "bool" | "date" | "text" | "code";

/** Operators: ≥ ≤ = ≠ ∈ (rendered via OPERATOR_SYMBOL). */
export type PredicateOperator = "gte" | "lte" | "eq" | "neq" | "in";

export interface FieldChoice {
  id: string;
  name: string;
}

/** One authorable field. `choices` required for `enum`. */
export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  choices?: FieldChoice[];
}

/** The typed field registry a consumer mounts the canvas with. */
export type FieldRegistry = readonly FieldDef[];

/** Typed predicate value — discriminated by field type so eval never coerces blind. */
export type PredicateValue =
  | { kind: "number"; value: number }
  | { kind: "bool"; value: boolean }
  | { kind: "date"; value: string }
  | { kind: "text"; value: string }
  | { kind: "enum"; value: string }
  | { kind: "enumSet"; value: string[] }
  | { kind: "code"; value: string };

/** field · operator · value — one row of the §4-20 술어 grammar. */
export interface Predicate {
  id: string;
  field: string;
  op: PredicateOperator;
  value: PredicateValue;
}

/** A conjoined/disjoined set of predicate rows. */
export interface PredicateGroup {
  join: "and" | "or";
  predicates: Predicate[];
}

/** A typed canvas variable (serialized with the doc). */
export interface CanvasVar {
  key: string;
  type: FieldType;
  label?: string;
}

/** The serializable canvas document — one per screen. Plain JSON. */
export interface CanvasDoc {
  version: 1;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  vars: CanvasVar[];
}

/** Operator symbols (non-textual glyphs — safe to inline, not UI copy). */
export const OPERATOR_SYMBOL: Record<PredicateOperator, string> = {
  gte: "≥",
  lte: "≤",
  eq: "=",
  neq: "≠",
  in: "∈",
};

/** Which operators each field type admits (§5d predicate grammar). */
export const OPERATORS_BY_TYPE: Record<FieldType, readonly PredicateOperator[]> = {
  number: ["gte", "lte", "eq", "neq"],
  date: ["gte", "lte", "eq", "neq"],
  enum: ["eq", "neq", "in"],
  bool: ["eq"],
  text: ["eq", "neq"],
  code: ["eq", "neq"],
};

/** A sample row the simulation panel evaluates the predicate set over. */
export type SampleRow = Record<string, unknown>;
