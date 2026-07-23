import type { ReactNode } from "react";

import type { ConsoleApiClient } from "../../api/client";
import type { StatusChip } from "../components";
import type { PolicyResource } from "../policy";

export type ModuleChipTone = NonNullable<Parameters<typeof StatusChip>[0]["tone"]>;

export type ModuleEmptyMode = "live" | "blocked-until-backend";
export type ModuleStatValue = string | number;

export interface ModulePolicyConfig {
  read: string;
  create?: string;
  post?: string;
  link?: string;
  graph?: string;
  audit?: string;
  lifecycle?: string;
}

export interface ModuleDataEndpointConfig {
  list?: string;
  detail?: string;
  create?: string;
  update?: string;
  delete?: string;
  post?: string;
  reverse?: string;
  lifecycle?: string;
  timeline?: string;
  costLedger?: string;
  lifecycleCost?: string;
  manualCost?: string;
  actionCatalog?: string;
  actionExecute?: string;
  substitutions?: string;
  ownershipTransfers?: string;
  ownershipTransferDecision?: string;
  objectResolve?: string;
  graph?: string;
  links?: string;
}

export interface ModuleStatConfig {
  key: string;
  labelKey: string;
  tone: ModuleChipTone;
  source: string;
  value?: ModuleStatValue;
  requiresBackend?: boolean;
  policyAction?: string;
}

export interface ModuleSearchConfig {
  labelKey: string;
  placeholderKey: string;
  fields: string[];
  requiresRows?: boolean;
}

export type ModuleColumnVariant = "text" | "mono" | "status" | "source" | "linkChips" | "titleMeta";
export type ModuleDetailFieldVariant = "text" | "mono" | "timeline" | "graph" | "ledger" | "stepper" | "balanceCheck";

export interface ModuleColumnConfig {
  /** Registry property id — label/variant derive from ONT_TYPES when omitted. */
  key: string;
  /** Optional override; default = the bound type's property nameKey. */
  labelKey?: string;
  /** Optional override; default derives from the property's field type. */
  variant?: ModuleColumnVariant;
  align?: "start" | "end";
  /**
   * Free-text columns (voucher memo, description) opt into wrapping so a long
   * value grows the row instead of forcing the whole table wider than the
   * list track when a detail pin is open — every other column stays the
   * single-line default (identifier/code/date cells must not wrap to one
   * char per line; see GenericModuleScreen's `tableWrapStyle` overflowX:auto
   * for genuinely-overflowing content). Default false.
   */
  wrap?: boolean;
}

export interface ModuleStatusValue {
  labelKey: string;
  tone: ModuleChipTone;
}

export interface ModuleSourceValue {
  labelKey: string;
  tone: ModuleChipTone;
  kind: string;
  id: string;
  code?: string;
  policyAction: string;
  href?: string;
}

export interface ModuleLinkChipConfig {
  key: string;
  labelKey: string;
  policyAction: string;
  resourceKind: string;
}

export interface ModuleLinkChipValue {
  key: string;
  labelKey: string;
  tone?: ModuleChipTone;
  kind: string;
  id: string;
  code?: string;
  policyAction: string;
  href?: string;
}

export interface ModuleDetailFieldConfig {
  /** Registry property id — label/variant derive from ONT_TYPES when omitted. */
  key: string;
  labelKey?: string;
  variant?: ModuleDetailFieldVariant;
}

export interface ModuleActionConfig {
  key: string;
  labelKey: string;
  policyAction: string;
  resourceKind?: string;
  blockedUntil?: string;
  href?: string;
}

export interface ModuleTimelineEventValue {
  id: string;
  label: string;
  kind?: string;
  description?: string;
  occurredAt?: string;
  href?: string;
  tone?: ModuleChipTone;
}

export interface ModuleTimelineValue {
  events: ModuleTimelineEventValue[];
}

export interface ModuleGraphNodeValue {
  id: string;
  label: string;
  kind?: string;
  subtitle?: string;
  href?: string;
  current?: boolean;
}

export interface ModuleGraphEdgeValue {
  id: string;
  label: string;
}

export interface ModuleGraphValue {
  nodes: ModuleGraphNodeValue[];
  edges: ModuleGraphEdgeValue[];
}

export interface ModuleLedgerEntryValue {
  id: string;
  label: string;
  amount?: ModuleStatValue;
  meta?: string;
  sourceLabelKey?: string;
  href?: string;
  tone?: ModuleChipTone;
}

export interface ModuleLedgerValue {
  entries: ModuleLedgerEntryValue[];
  total?: ModuleStatValue;
}

/** §4.7-3 document-flow stepper (e.g. finance 기표→차대검증→승인→전기). */
export type ModuleStepperStepState = "done" | "current" | "blocked" | "pending";

export interface ModuleStepperStep {
  key: string;
  labelKey: string;
  state: ModuleStepperStepState;
  occurredAt?: string;
  /** Why this step is blocked/pending — resolved via ko, not fabricated. */
  reasonKey?: string;
}

export interface ModuleStepperValue {
  steps: ModuleStepperStep[];
}

/** Balance-check callout (ok/blocked) — e.g. voucher debit=credit gate. */
export interface ModuleBalanceCheckValue {
  status: "ok" | "blocked";
  okLabelKey: string;
  blockedLabelKey: string;
  totalDebit?: ModuleStatValue;
  totalDebitLabelKey?: string;
  totalCredit?: ModuleStatValue;
  totalCreditLabelKey?: string;
  reasonKey?: string;
}

export type ModuleDetailValue =
  | string
  | number
  | ModuleTimelineValue
  | ModuleGraphValue
  | ModuleLedgerValue
  | ModuleStepperValue
  | ModuleBalanceCheckValue
  | undefined;

export interface ModuleRow {
  id: string;
  code: string;
  title?: string;
  status?: ModuleStatusValue;
  source?: ModuleSourceValue;
  cells: Record<string, string | number | undefined>;
  detail?: Record<string, ModuleDetailValue>;
  linkChips?: ModuleLinkChipValue[];
  actions?: ModuleActionConfig[];
  /** Authenticated source record retained by the data adapter for detail hydration.
   * It is never rendered directly; adapters must validate its shape before use. */
  sourceRecord?: unknown;
  statValues?: Record<string, ModuleStatValue | undefined>;
}

export interface ModuleListLoadResult {
  rows: ModuleRow[];
  stats?: Record<string, ModuleStatValue | undefined>;
  selectedRowId?: string;
}

export interface ModuleListLoadContext {
  api: ConsoleApiClient;
  query: string;
  hasPolicy: (action: string, resource?: PolicyResource) => boolean;
}

export interface ModuleDetailLoadResult {
  row?: ModuleRow;
  stats?: Record<string, ModuleStatValue | undefined>;
}

export interface ModuleDetailLoadContext {
  api: ConsoleApiClient;
  row: ModuleRow;
  hasPolicy: (action: string, resource?: PolicyResource) => boolean;
}

export interface ModuleComposeContext {
  api: ConsoleApiClient;
  onDone: (row?: ModuleRow) => void;
  onCancel: () => void;
}

export interface ModuleActionExecuteContext {
  api: ConsoleApiClient;
  row: ModuleRow;
  action: ModuleActionConfig;
}

export interface ModuleDataAdapter {
  loadRows?: (context: ModuleListLoadContext) => Promise<ModuleListLoadResult>;
  loadDetail?: (context: ModuleDetailLoadContext) => Promise<ModuleDetailLoadResult>;
  /** When set, the header primaryAction opens this in place of navigating an href. */
  renderCompose?: (context: ModuleComposeContext) => ReactNode;
  /** When set, a detail action with no href executes through here instead of
   * rendering inert (§4-12: no placeholder controls in final shape). Returning
   * a row patches it in place; returning nothing triggers a full detail reload. */
  executeAction?: (context: ModuleActionExecuteContext) => Promise<{ row?: ModuleRow } | undefined>;
}

export type ModuleListDisplay = "table" | "lanes";

export interface ModuleScreenConfig {
  id: string;
  screen: string;
  route: string;
  navLabelKey: string;
  titleKey: string;
  objectNameKey: string;
  objectKind: string;
  /** ONT_TYPES binding — field labels/variants/choices derive from the registry. */
  typeKey?: string;
  codePrefix: string;
  emptyMode?: ModuleEmptyMode;
  blockedChipKey?: string;
  /** Live mode, zero rows yet (e.g. no vouchers drafted) — reason + next action (§4-10). */
  emptyLiveHintKey?: string;
  policy: ModulePolicyConfig;
  data: ModuleDataEndpointConfig;
  dataAdapter?: ModuleDataAdapter;
  statbar: ModuleStatConfig[];
  search?: ModuleSearchConfig;
  list: {
    columns: ModuleColumnConfig[];
    sharedTrack: string;
    keyboard: string[];
    /** Initial display variant (§4-25 ⑧ table↔kanban alternates); default table. */
    display?: ModuleListDisplay;
    /** Choice-property id whose registry choices define the kanban lanes. */
    laneGroupBy?: string;
  };
  detail: {
    fields: ModuleDetailFieldConfig[];
    linkChips: ModuleLinkChipConfig[];
    actions: ModuleActionConfig[];
  };
  primaryAction?: ModuleActionConfig;
  rows: ModuleRow[];
}
