// §19 dashboard/console editor — config-as-governed-data. The whole dashboard
// is ONE serializable JSON document per screen (benchmark §3b: per-screen docs
// survive concurrent editing). Ont* shapes mirror be-ontology-engine-arch.md §2
// (ont_object_types / ont_property_defs / GET /ontology/instances?type=) so the
// Phase-C wiring is a stub→fetch swap, not a rewrite.

/** ont_property_defs.config.choices — IDed sub-entities referenced by id, rename-safe (benchmark §3c). */
export interface OntChoice {
  id: string;
  name: string;
  color?: string;
}

/** ont_property_defs row — discriminated union: `type` tag + type-specific `config`. */
export interface OntPropertyDef {
  id: string;
  key: string;
  title: string;
  /** Field-schema tag ("choice" | "date" | "currency" | …). Reader degrades on unknown, never crashes. */
  type: string;
  config?: { choices?: readonly OntChoice[] };
}

/** ont_action_types child row (dispatch: "projected_usecase" | "instance_revision"). */
export interface OntActionDef {
  id: string;
  /** stable_key (unique per object type). */
  key: string;
  title: string;
  dispatch: string;
}

/** ont_object_types row + property children (GET /api/v1/ontology/object-types/{key}). */
export interface OntObjectTypeDef {
  /** Object-type id (uuid) — the `?type=` key of GET /api/v1/ontology/instances. */
  id: string;
  /** stable_key */
  key: string;
  title: string;
  properties: readonly OntPropertyDef[];
  actions: readonly OntActionDef[];
}

/** One row of GET /api/v1/ontology/instances?type= — `attributes` mirrors the property schema. */
export interface OntInstanceRow {
  id: string;
  code: string;
  /** ont_object_types.stable_key */
  objectType: string;
  lifecycleState: "draft" | "active" | "locked" | "archived" | "disposed";
  /** Choice values are stored as choice ids (rename-safe), labels resolve via the registry. */
  attributes: Readonly<Record<string, string | number | null>>;
}

// ---- widget configs (design-delta 94+96: generic ontology-query bindings) ----
// Every widget is {kind, bind} over the same real rows/registry the editor
// already loads — no widget-specific fetch, no fabricated numbers.

/** count: one object type's instance count, optionally grouped per choice value. */
export interface CountBind {
  objectType: string;
  /** choice-property key; omitted ⇒ single total (§4-19: only typed choice fields group). */
  groupBy?: string;
}

/** trend: one instance's numeric-property value across its real revision history. */
export interface TrendBind {
  objectType: string;
  instanceId: string;
  /** numeric ont_property_defs key sampled per revision. */
  field: string;
}

/** dist: instance-state grouping (lifecycle_state) — top-4 chips. */
export interface DistBind {
  objectType: string;
}

export interface CountWidget {
  kind: "count";
  bind: CountBind;
}

export interface TrendWidget {
  kind: "trend";
  bind: TrendBind;
}

export interface DistWidget {
  kind: "dist";
  bind: DistBind;
}

export type WidgetConfig = CountWidget | TrendWidget | DistWidget;
export type WidgetKind = WidgetConfig["kind"];

export const WIDGET_KINDS: readonly WidgetKind[] = ["count", "trend", "dist"];

export interface DashboardSlot {
  id: string;
  widget: WidgetConfig | null;
}

/** The serializable dashboard config doc — 저장=personal view (§3.9.0-①) / 팀 배포=approval. */
export interface DashboardDoc {
  version: number;
  /** One doc per screen (benchmark §3b). */
  screen: string;
  /** Always exactly DASHBOARD_SLOT_COUNT entries. */
  slots: readonly DashboardSlot[];
}

export interface CountGroup {
  id: string;
  label: string;
  count: number;
}

export interface CountResult {
  total: number;
  groups: readonly CountGroup[];
}

/** Click-drill filter emitted by every widget number (§19: no non-clickable numbers). */
export interface DrillFilter {
  objectType: string;
  field?: string;
  choiceId?: string;
  /** dist widget drill: filter by instance lifecycle_state instead of a choice field. */
  lifecycleState?: OntInstanceRow["lifecycleState"];
}

// PBAC actions (deny-by-omission via PolicyGated — unauthorized controls are absent).
export const CONFIG_CONSOLE_ACTIONS = {
  configure: "configconsole.configure",
  saveView: "configconsole.view.save",
  deploy: "configconsole.layout.deploy",
} as const;

// ---- console_view persistence (§19 — governed ontology instance, not local-only state) ----

export type ConsoleViewScope = "personal" | "team";

/** One console_view instance: screen_key/config/scope properties (be2-config-objects). */
export interface ConsoleViewRecord {
  instanceId: string;
  screenKey: string;
  config: DashboardDoc;
  scope: ConsoleViewScope;
  version: number;
}

/** A loaded view's version is the mandatory compare-and-swap witness on edits. */
export interface ConsoleViewCommand {
  commandId: string;
  expectedRevision?: number;
}

/** A 팀 배포 request opened as a governance approval — pending until decided elsewhere. */
export interface DeployApprovalPending {
  approvalId: string;
  requestRef: string;
  createdAt: string;
}
