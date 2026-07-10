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

// ---- widget configs (discriminated union — the parser degrades unknown kinds to an empty slot) ----

/** Live count: one object type, optionally grouped per enum (choice) value. */
export interface LiveCountWidget {
  kind: "liveCount";
  objectType: string;
  /** choice-property key; omitted ⇒ single total (§4-19: only typed choice fields group). */
  groupBy?: string;
}

/** Stat bar: one total per selected object type. */
export interface StatBarWidget {
  kind: "statBar";
  objectTypes: readonly string[];
}

/** Bar chart: counts per enum value of one choice field. */
export interface ChartWidget {
  kind: "chart";
  objectType: string;
  field: string;
}

export type WidgetConfig = LiveCountWidget | StatBarWidget | ChartWidget;
export type WidgetKind = WidgetConfig["kind"];

export const WIDGET_KINDS: readonly WidgetKind[] = ["liveCount", "statBar", "chart"];

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
}

// PBAC actions (deny-by-omission via PolicyGated — unauthorized controls are absent).
export const CONFIG_CONSOLE_ACTIONS = {
  configure: "configconsole.configure",
  saveView: "configconsole.view.save",
  deploy: "configconsole.layout.deploy",
} as const;
