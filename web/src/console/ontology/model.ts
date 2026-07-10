// Pure revision-staging model (§3.9.0 / arch §3a): editing a non-draft type
// stages a v+1 copy (개정 대기 — 적용 승인 four-eyes / 철회); drafts edit direct.
// 적용 승인 is wired: the screen's onCommitRevision sends the staged copy as a
// PUT /api/v1/ontology/object-types/{key} draft (wire.ts stagedRevisionDraft)
// and the host reloads the registry from the server.
import type { StatusTone } from "../objectcard";
import type {
  OntActionTypeDef,
  OntAnalyticDef,
  OntLinkTypeDef,
  OntObjectTypeDef,
  OntPropertyDef,
  SchemaLifecycle,
} from "./types";

export interface RegistryState {
  /** Committed (published or draft-head) type definitions. */
  types: OntObjectTypeDef[];
  /** typeId → staged v+1 copy, present only while a revision is pending. */
  staged: Record<string, OntObjectTypeDef>;
}

export type SchemaEdit =
  | { kind: "property"; def: OntPropertyDef }
  | { kind: "link"; def: OntLinkTypeDef }
  | { kind: "action"; def: OntActionTypeDef }
  | { kind: "analytic"; def: OntAnalyticDef };

export function initialRegistryState(types: OntObjectTypeDef[]): RegistryState {
  return { types, staged: {} };
}

export function committedOf(state: RegistryState, typeId: string): OntObjectTypeDef | undefined {
  return state.types.find((type) => type.id === typeId);
}

/** What the editor shows: the staged copy when a revision is pending, else committed. */
export function viewOf(state: RegistryState, typeId: string): OntObjectTypeDef | undefined {
  return state.staged[typeId] ?? committedOf(state, typeId);
}

export function isStaged(state: RegistryState, typeId: string): boolean {
  return typeId in state.staged;
}

function withEdit(def: OntObjectTypeDef, edit: SchemaEdit): OntObjectTypeDef {
  switch (edit.kind) {
    case "property":
      return { ...def, properties: [...def.properties, edit.def] };
    case "link":
      return { ...def, links: [...def.links, edit.def] };
    case "action":
      return { ...def, actions: [...def.actions, edit.def] };
    case "analytic":
      return { ...def, analytics: [...def.analytics, edit.def] };
  }
}

/** Draft types edit direct; any non-draft edit accumulates on the staged v+1 copy. */
export function applySchemaEdit(
  state: RegistryState,
  typeId: string,
  edit: SchemaEdit,
): RegistryState {
  const committed = committedOf(state, typeId);
  if (!committed) return state;
  if (committed.lifecycleState === "draft") {
    return {
      ...state,
      types: state.types.map((type) => (type.id === typeId ? withEdit(type, edit) : type)),
    };
  }
  const base = state.staged[typeId] ?? committed;
  return { ...state, staged: { ...state.staged, [typeId]: withEdit(base, edit) } };
}

function withoutStaged(staged: Record<string, OntObjectTypeDef>, typeId: string) {
  return Object.fromEntries(Object.entries(staged).filter(([key]) => key !== typeId));
}

/** 적용 승인 (four-eyes): commit the staged copy as schema v+1. */
export function approveRevision(state: RegistryState, typeId: string): RegistryState {
  if (!(typeId in state.staged)) return state;
  const staged = state.staged[typeId];
  return {
    types: state.types.map((type) =>
      type.id === typeId ? { ...staged, schemaVersion: type.schemaVersion + 1 } : type,
    ),
    staged: withoutStaged(state.staged, typeId),
  };
}

/** 철회: drop the staged revision, committed definition untouched. */
export function discardRevision(state: RegistryState, typeId: string): RegistryState {
  if (!(typeId in state.staged)) return state;
  return { ...state, staged: withoutStaged(state.staged, typeId) };
}

/** 타입 추가 (§4-22): append a new draft type with the next free OT- code. */
export function createDraftType(
  state: RegistryState,
  title: string,
): { state: RegistryState; created: OntObjectTypeDef | null } {
  const trimmed = title.trim();
  if (trimmed.length === 0) return { state, created: null };
  const next =
    state.types.reduce((max, type) => {
      const match = /^OT-(\d+)$/.exec(type.code);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0) + 1;
  const created: OntObjectTypeDef = {
    id: `ot_${String(next)}`,
    stableKey: `ot_${String(next)}`,
    code: `OT-${String(next).padStart(2, "0")}`,
    title: trimmed,
    backingKind: "instance",
    schemaVersion: 1,
    lifecycleState: "draft",
    properties: [],
    links: [],
    actions: [],
    analytics: [],
    instances: [],
    acting: [],
  };
  return { state: { ...state, types: [...state.types, created] }, created };
}

export function schemaStageTone(stage: SchemaLifecycle): StatusTone {
  switch (stage) {
    case "draft":
      return "neutral";
    case "review_pending":
      return "warn";
    case "published":
      return "ok";
    case "superseded":
      return "info";
    case "retired":
      return "danger";
  }
}
