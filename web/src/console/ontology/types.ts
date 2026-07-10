// §18 Ontology Manager registry shapes — mirror be-ontology-engine-arch.md §2
// (ont_object_types / ont_property_defs / ont_link_types / ont_action_types /
// ont_analytics) + §3a schema lifecycle. Wired: wire.ts maps the
// GET/PUT /api/v1/ontology/object-types payloads (api/ontology.ts) onto these.
import type { ObjectCardActingChip, ObjectLifecycleState } from "../objectcard";

/** §3a schema lifecycle: draft → review_pending → published → superseded → retired. */
export type SchemaLifecycle =
  | "draft"
  | "review_pending"
  | "published"
  | "superseded"
  | "retired";

/** ont_property_defs.type — the field-schema union tags surfaced in the v1 editor. */
export const FIELD_KINDS = [
  "text",
  "number",
  "money",
  "date",
  "datetime",
  "boolean",
  "choice",
  "user",
  "object_ref",
  "attachment",
] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

/**
 * ont_link_types.cardinality plus the UI-only "many_one" direction sugar (kept
 * for display of legacy data; the add form and the staged-revision draft only
 * emit the DB CHECK's one_one | one_many | many_many).
 */
export const ONT_CARDINALITIES = ["one_one", "one_many", "many_one", "many_many"] as const;
export type OntCardinality = (typeof ONT_CARDINALITIES)[number];

/** ont_action_types.dispatch. */
export const ACTION_DISPATCHES = ["projected_usecase", "instance_revision"] as const;
export type ActionDispatch = (typeof ACTION_DISPATCHES)[number];

/** ont_property_defs row (editor projection). */
export interface OntPropertyDef {
  key: string;
  title: string;
  type: FieldKind;
  required: boolean;
  /** ≤1 property policy per prop (arch §5b) — deny ⇒ value nulled server-side. */
  inPropertyPolicy?: boolean;
}

/** ont_link_types row (from_object_type = the edited type). */
export interface OntLinkTypeDef {
  stableKey: string;
  title: string;
  /** ont_object_types.stable_key of the far end. */
  toTypeKey: string;
  cardinality: OntCardinality;
}

/** ont_action_types row (editor projection). */
export interface OntActionTypeDef {
  stableKey: string;
  title: string;
  dispatch: ActionDispatch;
}

/** ont_analytics row — derived property. */
export interface OntAnalyticDef {
  key: string;
  title: string;
  formula: string;
}

/** One instance row for the 인스턴스 subtab (GET /ontology/instances?type=). */
export interface OntInstanceRow {
  id: string;
  code: string;
  title: string;
  lifecycleState: ObjectLifecycleState;
}

/** ont_object_types row + its registry children (GET /ontology/object-types/{key}). */
export interface OntObjectTypeDef {
  id: string;
  stableKey: string;
  code: string;
  title: string;
  backingKind: "projected" | "instance";
  /** Projected-backing plumbing — round-tripped verbatim into staged revisions. */
  backingTable?: string | null;
  primaryKeyProperty?: string | null;
  titlePropertyKey?: string | null;
  schemaVersion: number;
  lifecycleState: SchemaLifecycle;
  properties: OntPropertyDef[];
  links: OntLinkTypeDef[];
  actions: OntActionTypeDef[];
  analytics: OntAnalyticDef[];
  instances: OntInstanceRow[];
  /** Acting automation/policy/series rules bound to the type (자동화 subtab). */
  acting: ObjectCardActingChip[];
}

/** Editor subtabs (design change-log 63). */
export const MANAGER_SUBTABS = [
  "properties",
  "links",
  "actions",
  "analytics",
  "instances",
  "automations",
] as const;
export type ManagerSubtab = (typeof MANAGER_SUBTABS)[number];

/** PBAC actions — deny-by-omission via PolicyGated (unauthorized ⇒ absent). */
export const ONTOLOGY_MANAGER_ACTIONS = {
  typeCreate: "ontology.schema.create",
  schemaEdit: "ontology.schema.edit",
  revisionApprove: "ontology.schema.approve",
  revisionDiscard: "ontology.schema.discard",
  instanceOpen: "ontology.instance.open",
} as const;
