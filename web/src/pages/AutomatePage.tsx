import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";

import {
  automateEnvelopeOf,
  automationDefinitionJson,
  isScheduleDefinition,
  runEntryOf,
  runIdempotencyKey,
  scheduleOf,
  withAutomateEnvelope,
  withSchedule,
  type AutomateEnvelope,
  type AutomateRunEntry,
  type AutomateRunStatus,
  type AutomateSchedule,
} from "../api/automate";
import type { WorkflowDefinitionResponse, WorkflowRunResponse } from "../api/types";
import { assertPasskeyStepUp } from "../auth/webauthn";
import { PageHeader } from "../components/shell/PageHeader";
import { FeedbackBanner } from "../components/states/FeedbackBanner";
import { PageError } from "../components/states/PageError";
import { SkeletonTable } from "../components/states/Skeleton";
import {
  BlockCanvas,
  defaultOperatorForField,
  defaultValueForField,
  OPERATOR_SYMBOL,
  PredicateEditor,
  upsertNode,
  type CanvasDoc,
  type FieldDef,
  type FieldRegistry,
  type Predicate,
  type PredicateGroup,
} from "../console/canvas";
import { StatusChip } from "../console/components";
import { fetchOntObjectTypes, type OntObjectTypeDef } from "../console/configconsole";
import {
  BulkPolicyGateProvider,
  PolicyGated,
  usePolicyGate,
} from "../console/policy";
import { objDrag } from "../console/window";
import "../console/tokens.css";
import { useAuth } from "../context/auth";
import { ko } from "../i18n/ko";

/**
 * Automate hub (파운드리 › 자동화 허브) — 워크플로 | 예약 | 분석·감시, wired to
 * the REAL workflow-studio REST (the same /api/v1/workflow-studio/* layer
 * WorkflowStudioPage drives, §4-18):
 *
 *   rules      = GET/POST/PATCH /definitions{,/{id}} — the definition JSON
 *                carries the BlockCanvas doc + typed predicate condition in the
 *                `automate` envelope (api/automate.ts owns that mapping);
 *   run log    = GET .../{id}/run-log, run/retry = POST .../{id}/run;
 *   simulate   = POST .../{id}/simulate;
 *   lifecycle  = POST .../{id}/publish|pause|resume (passkey step-up);
 *   §3.9.0     = publish stages pending_version; approve/withdraw =
 *                POST .../revisions/{rev}/approve|withdraw;
 *   monitors   = workflow definitions with the `automate.monitor` object-set
 *                trigger shape (Foundry Automate: a monitor IS a workflow);
 *   registries = condition fields + effect action types from the ontology
 *                registry (GET /api/v1/ontology/object-types*).
 */

const S = ko.console.automate;
const E = ko.console.workflows.errors;
const W = ko.workflowStudio;

export type AutomateStrings = typeof S;

// ── PBAC actions (deny-by-omission via PolicyGated) ──────────────────────────

const ACT = {
  viewRulesTab: "console.automate.tab.rules.view",
  viewSchedulesTab: "console.automate.tab.schedules.view",
  viewMonitorsTab: "console.automate.tab.monitors.view",
  selectRule: "console.automate.rule.select",
  createRule: "console.automate.rule.create",
  editRule: "console.automate.rule.edit",
  toggleRule: "console.automate.rule.toggle",
  scopeRule: "console.automate.rule.scope",
  runRule: "console.automate.rule.run",
  simulateRule: "console.automate.rule.simulate",
  retryRun: "console.automate.run.retry",
  createSchedule: "console.automate.schedule.create",
  selectSchedule: "console.automate.schedule.select",
  toggleSchedule: "console.automate.schedule.toggle",
  runSchedule: "console.automate.schedule.run",
  editSchedule: "console.automate.schedule.edit",
  approveRevision: "console.automate.schedule.revision.approve",
  withdrawRevision: "console.automate.schedule.revision.withdraw",
  createMonitor: "console.automate.monitor.create",
  toggleMonitor: "console.automate.monitor.toggle",
  editMonitor: "console.automate.monitor.edit",
} as const;

// Deny-by-omission action set, resolved at mount via
// POST /api/v1/policy/authorize/bulk (arch §5c) — see BulkPolicyGateProvider.
// Exported for reuse by the console screen composition (AutomateBody), which
// wraps the same AutomateHub in its own BulkPolicyGateProvider (§4-18: one
// hub, two mount points — the legacy route and the console screen).
// eslint-disable-next-line react-refresh/only-export-components
export const AUTOMATE_GATE_ACTIONS: readonly string[] = Object.values(ACT);

// ── View models over the definition payloads ────────────────────────────────

type AutomateTab = "rules" | "schedules" | "monitors";
type RuleScope = "org" | "personal";
type CadenceKey = "hourly" | "daily" | "weekly" | "monthly";

/** Typed cadence (§4-19) — the cron expression is derived, never free-typed. */
const CADENCE_CRON: Record<CadenceKey, string> = {
  hourly: "0 * * * *",
  daily: "0 9 * * *",
  weekly: "0 9 * * 1",
  monthly: "0 9 1 * *",
};
const CADENCE_KEYS: readonly CadenceKey[] = ["hourly", "daily", "weekly", "monthly"];

function cadenceOfCron(cron: string): CadenceKey | undefined {
  return CADENCE_KEYS.find((key) => CADENCE_CRON[key] === cron);
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${String(seq)}-${Date.now().toString(36)}`;
}

/** Condition field registry from the ontology property defs (arch §2). */
function fieldRegistryOf(types: readonly OntObjectTypeDef[]): FieldDef[] {
  const fields = new Map<string, FieldDef>();
  for (const type of types) {
    for (const prop of type.properties) {
      if (fields.has(prop.key)) continue;
      if (prop.type === "choice") {
        fields.set(prop.key, {
          key: prop.key,
          label: prop.title,
          type: "enum",
          choices: (prop.config?.choices ?? []).map(({ id, name }) => ({ id, name })),
        });
      } else if (prop.type === "date" || prop.type === "datetime") {
        fields.set(prop.key, { key: prop.key, label: prop.title, type: "date" });
      } else if (prop.type === "number" || prop.type === "currency") {
        fields.set(prop.key, { key: prop.key, label: prop.title, type: "number" });
      } else if (prop.type === "code") {
        fields.set(prop.key, { key: prop.key, label: prop.title, type: "code" });
      } else if (prop.type === "text") {
        fields.set(prop.key, { key: prop.key, label: prop.title, type: "text" });
      }
      // unknown field-schema tags degrade by omission (never crash, §3c).
    }
  }
  return [...fields.values()];
}

/** Effect picker options — §2 ont_action_types (an Automate effect IS an ontology action). */
interface ActionOption {
  id: string;
  key: string;
  title: string;
  dispatch: string;
  objectTypeKey: string;
  objectTypeTitle: string;
}

function actionOptionsOf(types: readonly OntObjectTypeDef[]): ActionOption[] {
  return types.flatMap((type) =>
    type.actions.map((action) => ({
      id: action.id,
      key: action.key,
      title: action.title,
      dispatch: action.dispatch,
      objectTypeKey: type.key,
      objectTypeTitle: type.title,
    })),
  );
}

function dispatchLabel(dispatch: string): string {
  const labels = S.labels.dispatch as Record<string, string | undefined>;
  return labels[dispatch] ?? dispatch;
}

function choiceName(field: FieldDef | undefined, id: string): string {
  return field?.choices?.find((choice) => choice.id === id)?.name ?? id;
}

function predicateSummary(predicate: Predicate, fields: FieldRegistry): string {
  const field = fields.find((entry) => entry.key === predicate.field);
  const value =
    predicate.value.kind === "enumSet"
      ? predicate.value.value.map((id) => choiceName(field, id)).join("·")
      : predicate.value.kind === "enum"
        ? choiceName(field, predicate.value.value)
        : String(predicate.value.value);
  return `${field?.label ?? predicate.field} ${OPERATOR_SYMBOL[predicate.op]} ${value}`;
}

/** Trigger→Condition→Branch(→Action) doc for definitions that carry no canvas yet. */
function buildRuleDoc(
  condition: PredicateGroup,
  fields: FieldRegistry,
  action?: ActionOption,
): CanvasDoc {
  const trigger = nextId("n-trigger");
  const cond = nextId("n-condition");
  const branch = nextId("n-branch");
  const nodes: CanvasDoc["nodes"] = [
    { id: trigger, kind: "trigger", title: S.samples.trigger, x: 40, y: 32 },
    {
      id: cond,
      kind: "condition",
      title: ko.console.canvas.kindLabel.condition,
      chips: condition.predicates.map((predicate) => predicateSummary(predicate, fields)),
      predicate: condition,
      x: 40,
      y: 208,
    },
    {
      id: branch,
      kind: "branch",
      title: ko.console.canvas.kindLabel.branch,
      outputs: [
        { port: "met", label: S.labels.branchMet },
        { port: "unmet", label: S.labels.branchUnmet },
      ],
      x: 40,
      y: 384,
    },
  ];
  const edges: CanvasDoc["edges"] = [
    { id: nextId("e"), from: trigger, to: cond },
    { id: nextId("e"), from: cond, to: branch },
  ];
  if (action) {
    const act = nextId("n-action");
    nodes.push({
      id: act,
      kind: "action",
      title: action.title,
      chips: [action.objectTypeTitle, dispatchLabel(action.dispatch)],
      x: 360,
      y: 384,
    });
    edges.push({ id: nextId("e"), from: branch, fromPort: "met", to: act });
  }
  return { version: 1, nodes, edges, vars: [] };
}

function defaultCondition(fields: FieldRegistry): PredicateGroup {
  const field = fields.at(0);
  if (!field) return { join: "and", predicates: [] };
  return {
    join: "and",
    predicates: [
      {
        id: nextId("p"),
        field: field.key,
        op: defaultOperatorForField(field),
        value: defaultValueForField(field),
      },
    ],
  };
}

interface RuleVm {
  definition: WorkflowDefinitionResponse;
  id: string;
  name: string;
  scope: RuleScope;
  /** Chip status: ACTIVE ⇒ 활성, DRAFT/PAUSED ⇒ 초안 (real status drives the toggle). */
  active: boolean;
  editable: boolean;
  envelope: AutomateEnvelope;
  doc: CanvasDoc;
  condition: PredicateGroup;
}

function ruleVmOf(definition: WorkflowDefinitionResponse, fields: FieldRegistry): RuleVm {
  const envelope = automateEnvelopeOf(definition);
  const condition = envelope.condition ?? { join: "and", predicates: [] };
  return {
    definition,
    id: definition.id,
    name: definition.display_name,
    scope: envelope.scope,
    active: definition.status === "ACTIVE",
    editable: definition.status === "DRAFT",
    envelope,
    doc: envelope.doc ?? buildRuleDoc(condition, fields),
    condition,
  };
}

interface ScheduleVm {
  definition: WorkflowDefinitionResponse;
  id: string;
  schedule: AutomateSchedule;
  cadence: CadenceKey | undefined;
  version: number;
  pendingRev?: { version: number; stagedBy: string };
}

function scheduleVmOf(
  definition: WorkflowDefinitionResponse,
  schedule: AutomateSchedule,
): ScheduleVm {
  return {
    definition,
    id: definition.id,
    schedule,
    cadence: cadenceOfCron(schedule.cron),
    version: definition.latest_version,
    ...(typeof definition.pending_version === "number"
      ? {
          pendingRev: {
            version: definition.pending_version,
            stagedBy:
              definition.pending_staged_by ??
              ko.console.workflows.canvas.binding.actorFallback,
          },
        }
      : {}),
  };
}

interface MonitorVm {
  definition: WorkflowDefinitionResponse;
  id: string;
  name: string;
  objectTypeTitle: string;
  condition: PredicateGroup;
  actionTitle: string | undefined;
  active: boolean;
}

function monitorVmOf(
  definition: WorkflowDefinitionResponse,
  registry: readonly OntObjectTypeDef[],
  actions: readonly ActionOption[],
): MonitorVm | undefined {
  const envelope = automateEnvelopeOf(definition);
  if (!envelope.monitor) return undefined;
  const { objectType, actionKey } = envelope.monitor;
  return {
    definition,
    id: definition.id,
    name: definition.display_name,
    objectTypeTitle:
      registry.find((type) => type.key === objectType)?.title ?? objectType,
    condition: envelope.condition ?? { join: "and", predicates: [] },
    actionTitle: actions.find(
      (action) => action.key === actionKey && action.objectTypeKey === objectType,
    )?.title,
    active: definition.status === "ACTIVE",
  };
}

// ── Styles (tokens only) ─────────────────────────────────────────────────────

const hubStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-5)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
};

const tabRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--sp-2)",
};

const splitStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(300px, 340px) minmax(560px, 1fr)",
  gap: "var(--sp-5)",
  alignItems: "start",
};

const cardStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-4)",
  padding: "var(--sp-5)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  background: "var(--surface)",
  boxShadow: "var(--shadow)",
};

const listStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-2)",
  margin: 0,
  padding: 0,
  listStyle: "none",
};

const buttonStyle: CSSProperties = {
  minHeight: 44,
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0 var(--sp-4)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-strong)",
  cursor: "pointer",
};

const listButtonStyle: CSSProperties = {
  ...buttonStyle,
  width: "100%",
  minHeight: 52,
  display: "grid",
  justifyItems: "stretch",
  gap: "var(--sp-2)",
  padding: "var(--sp-3)",
  textAlign: "left",
};

const sectionHeaderStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--sp-2)",
};

const sectionTitleStyle: CSSProperties = {
  margin: 0,
  color: "var(--ink)",
  fontSize: "var(--text-card-title)",
  fontWeight: "var(--fw-strong)",
};

const chipRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--sp-2)",
};

const fieldStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-1)",
  color: "var(--steel)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-strong)",
};

const inputStyle: CSSProperties = {
  minHeight: 44,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--surface)",
  color: "var(--ink)",
  padding: "0 var(--sp-3)",
  fontSize: "var(--text-sm)",
};

const runItemStyle: CSSProperties = {
  position: "relative",
  display: "grid",
  gap: "var(--sp-2)",
  padding: "var(--sp-4)",
  paddingInlineStart: "calc(var(--sp-6) + var(--sp-3))",
  border: "1px solid var(--border-soft)",
  borderRadius: "var(--radius-md)",
  background: "var(--surface)",
};

const runDotStyle: CSSProperties = {
  position: "absolute",
  insetBlockStart: "var(--sp-4)",
  insetInlineStart: "var(--sp-4)",
  width: 10,
  height: 10,
  borderRadius: "var(--radius-pill)",
  border: "2px solid var(--timeline-dot-bd)",
  background: "var(--timeline-dot-bg)",
};

const runLabelStyle: CSSProperties = {
  margin: 0,
  color: "var(--ink)",
  fontSize: "var(--text-body)",
  fontWeight: "var(--fw-strong)",
};

const metaTextStyle: CSSProperties = {
  color: "var(--faint)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--fw-medium)",
};

const objectChipStyle: CSSProperties = {
  ...buttonStyle,
  minHeight: 44,
  padding: "0 var(--sp-2)",
  fontSize: "var(--text-xs)",
  borderRadius: "var(--radius-chip)",
  color: "var(--info-tx)",
  borderColor: "var(--info-bd)",
  background: "var(--info-bg)",
  cursor: "grab",
};

function tabButtonStyle(active: boolean): CSSProperties {
  return {
    ...buttonStyle,
    borderColor: active ? "var(--signal)" : "var(--border)",
    background: active ? "var(--accent-bg)" : "var(--surface)",
  };
}

function rowButtonStyle(selected: boolean): CSSProperties {
  return {
    ...listButtonStyle,
    borderColor: selected ? "var(--signal)" : "var(--border)",
    background: selected ? "var(--accent-bg)" : "var(--surface)",
  };
}

// ── Run log (real .../{id}/run-log rows; object chips are drag sources) ─────

function runTone(status: AutomateRunStatus): "ok" | "danger" | "accent" {
  if (status === "succeeded") return "ok";
  if (status === "failed") return "danger";
  return "accent";
}

function RunLog({
  entries,
  onRetry,
}: {
  entries: readonly AutomateRunEntry[];
  onRetry: (entry: AutomateRunEntry) => void;
}) {
  if (entries.length === 0) {
    return <StatusChip tone="neutral">{S.labels.emptyRunLog}</StatusChip>;
  }

  return (
    <ol aria-label={S.sections.runLog} style={listStyle}>
      {entries.map((entry) => (
        <li key={entry.id} style={runItemStyle}>
          <span aria-hidden="true" style={runDotStyle} />
          <div style={chipRowStyle}>
            <StatusChip
              tone={runTone(entry.status)}
              role={entry.status === "failed" ? "alert" : "status"}
            >
              {S.status[entry.status]}
            </StatusChip>
            {entry.durationMs !== null ? (
              <StatusChip tone="neutral">{S.labels.duration(entry.durationMs)}</StatusChip>
            ) : null}
            <span style={metaTextStyle}>{entry.at}</span>
          </div>
          <p style={runLabelStyle}>{entry.label}</p>
          {entry.objects.length > 0 ? (
            <div style={chipRowStyle}>
              {entry.objects.map((ref) => (
                // wire-pending: HANDOFF §4 — the run payload carries generated
                // object CODES only; opening the ObjectCard needs a code →
                // instance resolve endpoint. Until then the chip is the §4.7
                // drag source without a click-open.
                <span
                  key={ref.code}
                  {...objDrag(ref.code, ref.title)}
                  title={ko.console.window.dragRefOf(ref.title)}
                  style={objectChipStyle}
                >
                  {ref.code}
                </span>
              ))}
            </div>
          ) : null}
          {entry.retryable ? (
            <PolicyGated action={ACT.retryRun} resource={{ kind: "run", id: entry.id }}>
              <button
                type="button"
                onClick={() => {
                  onRetry(entry);
                }}
                style={{ ...buttonStyle, justifySelf: "start" }}
              >
                {S.actions.retry}
              </button>
            </PolicyGated>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

// ── 워크플로 tab ─────────────────────────────────────────────────────────────

type ScopeFilter = "all" | RuleScope;

function RuleBuilder({
  rule,
  fields,
  actionOptions,
  runLog,
  onRename,
  onEnvelopeChange,
  onToggle,
  onScopeToggle,
  onRun,
  onSimulate,
  onRetry,
}: {
  rule: RuleVm;
  fields: FieldRegistry;
  actionOptions: readonly ActionOption[];
  runLog: readonly AutomateRunEntry[];
  onRename: (name: string) => void;
  onEnvelopeChange: (envelope: AutomateEnvelope) => void;
  onToggle: () => void;
  onScopeToggle: () => void;
  onRun: () => void;
  onSimulate: () => void;
  onRetry: (entry: AutomateRunEntry) => void;
}) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [pickedActionId, setPickedActionId] = useState(actionOptions.at(0)?.id ?? "");
  const ruleResource = { kind: "automation_rule", id: rule.id };

  function addActionBlock(): void {
    const action = actionOptions.find((candidate) => candidate.id === pickedActionId);
    if (!action) return;
    const actionCount = rule.doc.nodes.filter((node) => node.kind === "action").length;
    onEnvelopeChange({
      ...rule.envelope,
      doc: upsertNode(rule.doc, {
        id: nextId("n-action"),
        kind: "action",
        title: action.title,
        chips: [action.objectTypeTitle, dispatchLabel(action.dispatch)],
        x: 360,
        y: 384 + actionCount * 176,
      }),
      condition: rule.condition,
    });
  }

  function setCondition(group: PredicateGroup): void {
    const conditionNode = rule.doc.nodes.find((node) => node.kind === "condition");
    onEnvelopeChange({
      ...rule.envelope,
      condition: group,
      doc: conditionNode
        ? upsertNode(rule.doc, {
            ...conditionNode,
            chips: group.predicates.map((predicate) => predicateSummary(predicate, fields)),
            predicate: group,
          })
        : rule.doc,
    });
  }

  return (
    <section aria-labelledby="automate-builder-title" style={cardStyle}>
      <div style={sectionHeaderStyle}>
        <h2 id="automate-builder-title" style={sectionTitleStyle}>
          {rule.name}
        </h2>
        <div style={chipRowStyle}>
          <StatusChip tone="neutral">{S.scope[rule.scope]}</StatusChip>
          <StatusChip tone={rule.active ? "ok" : "neutral"}>
            {rule.active ? S.status.active : S.status.draft}
          </StatusChip>
        </div>
      </div>

      <div style={chipRowStyle}>
        {rule.editable ? (
          <label style={fieldStyle}>
            {S.labels.ruleName}
            <input
              key={rule.id}
              aria-label={S.labels.ruleName}
              defaultValue={rule.name}
              onBlur={(event) => {
                const name = event.currentTarget.value.trim();
                if (name && name !== rule.name) onRename(name);
              }}
              style={inputStyle}
            />
          </label>
        ) : null}
        <PolicyGated action={ACT.toggleRule} resource={ruleResource}>
          <button type="button" onClick={onToggle} style={buttonStyle}>
            {rule.active ? S.actions.toDraft : S.actions.activate}
          </button>
        </PolicyGated>
        <PolicyGated action={ACT.scopeRule} resource={ruleResource}>
          <button type="button" onClick={onScopeToggle} style={buttonStyle}>
            {rule.scope === "org" ? S.actions.toPersonalScope : S.actions.toOrgScope}
          </button>
        </PolicyGated>
        <PolicyGated action={ACT.runRule} resource={ruleResource}>
          <button type="button" onClick={onRun} style={buttonStyle}>
            {S.actions.runNow}
          </button>
        </PolicyGated>
        <PolicyGated action={ACT.simulateRule} resource={ruleResource}>
          <button type="button" onClick={onSimulate} style={buttonStyle}>
            {W.simulate}
          </button>
        </PolicyGated>
      </div>

      <BlockCanvas
        doc={rule.doc}
        strings={ko.console.canvas}
        onChange={
          rule.editable
            ? (doc) => {
                onEnvelopeChange({ ...rule.envelope, doc, condition: rule.condition });
              }
            : undefined
        }
        selectedId={selectedNodeId}
        onSelectNode={setSelectedNodeId}
      />

      {rule.editable ? (
        <PolicyGated action={ACT.editRule} resource={ruleResource}>
          <div role="group" aria-label={S.sections.actionPicker} style={chipRowStyle}>
            <label style={fieldStyle}>
              {S.labels.actionType}
              <select
                aria-label={S.labels.actionType}
                value={pickedActionId}
                onChange={(event) => {
                  setPickedActionId(event.currentTarget.value);
                }}
                style={inputStyle}
              >
                {actionOptions.map((action) => (
                  <option key={action.id} value={action.id}>
                    {action.title}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={addActionBlock} style={buttonStyle}>
              {S.actions.addActionBlock}
            </button>
          </div>
          <PredicateEditor
            group={rule.condition}
            registry={fields}
            strings={ko.console.canvas}
            onChange={setCondition}
          />
        </PolicyGated>
      ) : null}

      <section
        aria-labelledby="automate-rule-runlog-title"
        style={{ display: "grid", gap: "var(--sp-3)" }}
      >
        <h3 id="automate-rule-runlog-title" style={sectionTitleStyle}>
          {S.sections.runLog}
        </h3>
        <RunLog entries={runLog} onRetry={onRetry} />
      </section>
    </section>
  );
}

// ── 예약 tab ─────────────────────────────────────────────────────────────────

interface ScheduleDraftForm {
  name: string;
  cadence: CadenceKey;
}

function CadenceSelect({
  value,
  onChange,
}: {
  value: CadenceKey;
  onChange: (cadence: CadenceKey) => void;
}) {
  return (
    <label style={fieldStyle}>
      {S.labels.cadence}
      <select
        aria-label={S.labels.cadence}
        value={value}
        onChange={(event) => {
          onChange(event.currentTarget.value as CadenceKey);
        }}
        style={inputStyle}
      >
        {CADENCE_KEYS.map((key) => (
          <option key={key} value={key}>
            {S.cadence[key]}
          </option>
        ))}
      </select>
    </label>
  );
}

function ScheduleDetail({
  schedule,
  runLog,
  onSave,
  onToggle,
  onRun,
  onApprove,
  onWithdraw,
  onRetry,
}: {
  schedule: ScheduleVm;
  runLog: readonly AutomateRunEntry[];
  onSave: (draft: ScheduleDraftForm) => void;
  onToggle: () => void;
  onRun: () => void;
  onApprove: (version: number) => void;
  onWithdraw: (version: number) => void;
  onRetry: (entry: AutomateRunEntry) => void;
}) {
  const [draft, setDraft] = useState<ScheduleDraftForm | null>(null);
  const resource = { kind: "schedule", id: schedule.id };
  const config = schedule.schedule;

  return (
    <section aria-labelledby="automate-schedule-detail-title" style={cardStyle}>
      <div style={sectionHeaderStyle}>
        <h2 id="automate-schedule-detail-title" style={sectionTitleStyle}>
          {config.name}
        </h2>
        <div style={chipRowStyle}>
          <StatusChip tone={config.active ? "ok" : "neutral"}>
            {config.active ? S.status.active : S.status.inactive}
          </StatusChip>
          <StatusChip tone="info">{S.labels.version(schedule.version)}</StatusChip>
        </div>
      </div>

      <div style={chipRowStyle}>
        <StatusChip tone="info">{S.labels.cron(config.cron)}</StatusChip>
        {schedule.cadence ? (
          <StatusChip tone="neutral">{S.cadence[schedule.cadence]}</StatusChip>
        ) : null}
        {config.nextRun !== undefined ? (
          <StatusChip tone="neutral">{S.labels.nextRun(config.nextRun)}</StatusChip>
        ) : null}
        {config.lastRun !== undefined ? (
          <StatusChip tone="neutral">{S.labels.lastRun(config.lastRun)}</StatusChip>
        ) : null}
        {schedule.pendingRev ? (
          <StatusChip tone="warn">
            {S.labels.pendingRevision(
              schedule.pendingRev.version,
              schedule.pendingRev.stagedBy,
            )}
          </StatusChip>
        ) : null}
      </div>

      {draft ? (
        <div style={{ display: "grid", gap: "var(--sp-3)" }}>
          <label style={fieldStyle}>
            {S.labels.scheduleName}
            <input
              aria-label={S.labels.scheduleName}
              value={draft.name}
              onChange={(event) => {
                setDraft({ ...draft, name: event.currentTarget.value });
              }}
              style={inputStyle}
            />
          </label>
          <CadenceSelect
            value={draft.cadence}
            onChange={(cadence) => {
              setDraft({ ...draft, cadence });
            }}
          />
        </div>
      ) : null}

      <div style={chipRowStyle}>
        <PolicyGated action={ACT.runSchedule} resource={resource}>
          <button type="button" onClick={onRun} style={buttonStyle}>
            {S.actions.runNow}
          </button>
        </PolicyGated>
        <PolicyGated action={ACT.toggleSchedule} resource={resource}>
          <button type="button" onClick={onToggle} style={buttonStyle}>
            {config.active ? S.actions.deactivate : S.actions.activate}
          </button>
        </PolicyGated>
        {draft ? (
          <>
            <PolicyGated action={ACT.editSchedule} resource={resource}>
              <button
                type="button"
                onClick={() => {
                  onSave(draft);
                  setDraft(null);
                }}
                style={buttonStyle}
              >
                {S.actions.save}
              </button>
            </PolicyGated>
            <button
              type="button"
              onClick={() => {
                setDraft(null);
              }}
              style={buttonStyle}
            >
              {S.actions.cancel}
            </button>
          </>
        ) : (
          <PolicyGated action={ACT.editSchedule} resource={resource}>
            <button
              type="button"
              onClick={() => {
                setDraft({
                  name: config.name,
                  cadence: schedule.cadence ?? "daily",
                });
              }}
              style={buttonStyle}
            >
              {S.actions.edit}
            </button>
          </PolicyGated>
        )}
        {schedule.pendingRev ? (
          <>
            <PolicyGated action={ACT.approveRevision} resource={resource}>
              <button
                type="button"
                onClick={() => {
                  if (schedule.pendingRev) onApprove(schedule.pendingRev.version);
                }}
                style={buttonStyle}
              >
                {S.actions.approveRevision}
              </button>
            </PolicyGated>
            <PolicyGated action={ACT.withdrawRevision} resource={resource}>
              <button
                type="button"
                onClick={() => {
                  if (schedule.pendingRev) onWithdraw(schedule.pendingRev.version);
                }}
                style={buttonStyle}
              >
                {S.actions.withdrawRevision}
              </button>
            </PolicyGated>
          </>
        ) : null}
      </div>

      <section
        aria-labelledby="automate-schedule-runlog-title"
        style={{ display: "grid", gap: "var(--sp-3)" }}
      >
        <h3 id="automate-schedule-runlog-title" style={sectionTitleStyle}>
          {S.sections.runLog}
        </h3>
        <RunLog entries={runLog} onRetry={onRetry} />
      </section>
    </section>
  );
}

// ── Hub ──────────────────────────────────────────────────────────────────────

type ReadState = "loading" | "idle" | "error";
type FeedbackKind = "success" | "error";

/** Exported for tests: mount under a custom PolicyGateProvider to exercise gating. */
export function AutomateHub() {
  const { api, session } = useAuth();
  const gate = usePolicyGate();

  const [readState, setReadState] = useState<ReadState>("loading");
  const [definitions, setDefinitions] = useState<WorkflowDefinitionResponse[]>([]);
  const [registry, setRegistry] = useState<readonly OntObjectTypeDef[]>([]);
  const [runLogById, setRunLogById] = useState<
    Partial<Record<string, WorkflowRunResponse[]>>
  >({});
  const [tab, setTab] = useState<AutomateTab>("rules");
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [ruleId, setRuleId] = useState<string | undefined>(undefined);
  const [scheduleId, setScheduleId] = useState<string | undefined>(undefined);
  const [feedback, setFeedback] = useState<string | undefined>(undefined);
  const [feedbackKind, setFeedbackKind] = useState<FeedbackKind>("success");
  const [scheduleForm, setScheduleForm] = useState<{
    name: string;
    cadence: CadenceKey;
    ruleId: string;
  }>({ name: "", cadence: "daily", ruleId: "" });

  const fields = useMemo(() => fieldRegistryOf(registry), [registry]);
  const actionOptions = useMemo(() => actionOptionsOf(registry), [registry]);

  const rules = useMemo(
    () =>
      definitions
        .filter((definition) => !isScheduleDefinition(definition))
        .map((definition) => ruleVmOf(definition, fields)),
    [definitions, fields],
  );
  const schedules = useMemo(
    () =>
      definitions.flatMap((definition) => {
        const schedule = scheduleOf(definition);
        return schedule ? [scheduleVmOf(definition, schedule)] : [];
      }),
    [definitions],
  );
  const monitors = useMemo(
    () =>
      definitions.flatMap((definition) => {
        const monitor = monitorVmOf(definition, registry, actionOptions);
        return monitor ? [monitor] : [];
      }),
    [definitions, registry, actionOptions],
  );

  const showError = useCallback((message: string) => {
    setFeedbackKind("error");
    setFeedback(message);
  }, []);

  function showSuccess(message: string) {
    setFeedbackKind("success");
    setFeedback(message);
  }

  const loadRunLog = useCallback(
    async (definitionId: string | undefined) => {
      if (!definitionId) return;
      const response = await api.GET(
        "/api/v1/workflow-studio/definitions/{id}/run-log",
        { params: { path: { id: definitionId } } },
      );
      if (!response.data) throw new Error("automate run log load failed");
      setRunLogById((current) => ({ ...current, [definitionId]: response.data.items }));
    },
    [api],
  );

  const load = useCallback(async () => {
    setReadState("loading");
    try {
      const [definitionsResponse, types] = await Promise.all([
        api.GET("/api/v1/workflow-studio/definitions"),
        fetchOntObjectTypes(api),
      ]);
      if (!definitionsResponse.data) throw new Error("automate definitions load failed");
      setDefinitions(definitionsResponse.data.items);
      setRegistry(types);
      setReadState("idle");
    } catch {
      setReadState("error");
    }
  }, [api]);

  useEffect(() => {
    const task = window.setTimeout(() => {
      void load();
    }, 0);
    return () => {
      window.clearTimeout(task);
    };
  }, [load]);

  const visibleRules =
    scopeFilter === "all" ? rules : rules.filter((rule) => rule.scope === scopeFilter);
  const selectedRule =
    rules.find((rule) => rule.id === ruleId) ?? visibleRules.at(0) ?? rules.at(0);
  const selectedSchedule =
    schedules.find((schedule) => schedule.id === scheduleId) ?? schedules.at(0);

  // Run log of whatever is on screen: the selected rule/schedule, and every
  // monitor when the 분석·감시 tab is open (hits = real run count).
  const selectedRuleId = selectedRule?.id;
  const selectedScheduleId = selectedSchedule?.id;
  const monitorIdsKey = monitors.map((monitor) => monitor.id).join(",");
  useEffect(() => {
    if (readState !== "idle") return;
    const task = window.setTimeout(() => {
      const wanted =
        tab === "rules"
          ? [selectedRuleId]
          : tab === "schedules"
            ? [selectedScheduleId]
            : monitorIdsKey.split(",").filter(Boolean);
      for (const id of wanted) {
        if (id && !(id in runLogById)) {
          void loadRunLog(id).catch(() => {
            showError(E.loadFailed);
          });
        }
      }
    }, 0);
    return () => {
      window.clearTimeout(task);
    };
  }, [
    readState,
    tab,
    selectedRuleId,
    selectedScheduleId,
    monitorIdsKey,
    runLogById,
    loadRunLog,
    showError,
  ]);

  function runEntriesFor(definitionId: string | undefined): AutomateRunEntry[] {
    if (!definitionId) return [];
    return (runLogById[definitionId] ?? []).map(runEntryOf);
  }

  function replaceDefinition(updated: WorkflowDefinitionResponse): void {
    setDefinitions((items) =>
      items.map((item) => (item.id === updated.id ? updated : item)),
    );
  }

  async function patchDefinition(
    definition: WorkflowDefinitionResponse,
    body: { display_name?: string; definition?: Record<string, unknown> },
    failMessage: string,
  ): Promise<WorkflowDefinitionResponse | undefined> {
    setFeedback(undefined);
    try {
      const response = await api.PATCH("/api/v1/workflow-studio/definitions/{id}", {
        params: { path: { id: definition.id } },
        body,
      });
      if (!response.data) throw new Error("automate definition patch failed");
      replaceDefinition(response.data);
      return response.data;
    } catch {
      showError(failMessage);
      return undefined;
    }
  }

  async function createDefinition(
    input: {
      workflowKey: string;
      displayName: string;
      objectType: string;
      definition: Record<string, unknown>;
    },
    failMessage: string,
  ): Promise<WorkflowDefinitionResponse | undefined> {
    setFeedback(undefined);
    try {
      const response = await api.POST("/api/v1/workflow-studio/definitions", {
        body: {
          workflow_key: input.workflowKey,
          display_name: input.displayName,
          object_type: input.objectType,
          definition: input.definition,
        },
      });
      if (!response.data) throw new Error("automate definition create failed");
      const created = response.data;
      setDefinitions((items) => [created, ...items]);
      return created;
    } catch {
      showError(failMessage);
      return undefined;
    }
  }

  /** DRAFT→publish, ACTIVE→pause, PAUSED→resume — passkey step-up on each (studio contract). */
  async function toggleDefinition(definition: WorkflowDefinitionResponse): Promise<void> {
    const path =
      definition.status === "ACTIVE"
        ? ("/api/v1/workflow-studio/definitions/{id}/pause" as const)
        : definition.status === "PAUSED"
          ? ("/api/v1/workflow-studio/definitions/{id}/resume" as const)
          : ("/api/v1/workflow-studio/definitions/{id}/publish" as const);
    setFeedback(undefined);
    try {
      const stepUp = await assertPasskeyStepUp(api);
      const response = await api.POST(path, {
        params: { path: { id: definition.id } },
        body: { step_up: stepUp },
      });
      if (!response.data) throw new Error("automate lifecycle failed");
      replaceDefinition(response.data);
      showSuccess(
        definition.status === "ACTIVE" ? W.success.pause : W.success.publish,
      );
    } catch {
      showError(E.toggleFailed);
    }
  }

  async function runDefinition(
    definitionId: string,
    triggerType: "MANUAL" | "SCHEDULE",
  ): Promise<void> {
    setFeedback(undefined);
    try {
      const response = await api.POST("/api/v1/workflow-studio/definitions/{id}/run", {
        params: { path: { id: definitionId } },
        body: {
          trigger_type: triggerType,
          idempotency_key: runIdempotencyKey(definitionId, triggerType),
        },
      });
      if (!response.data) throw new Error("automate run failed");
      await loadRunLog(definitionId);
      showSuccess(W.success.run);
    } catch {
      showError(E.runFailed);
    }
  }

  async function simulateDefinition(definitionId: string): Promise<void> {
    setFeedback(undefined);
    try {
      const response = await api.POST(
        "/api/v1/workflow-studio/definitions/{id}/simulate",
        { params: { path: { id: definitionId } }, body: {} },
      );
      if (!response.data) throw new Error("automate simulate failed");
      setFeedbackKind(response.data.decision === "ready" ? "success" : "error");
      setFeedback(
        response.data.decision === "ready"
          ? W.simulationReady
          : response.data.findings.map((finding) => finding.message).join(" · "),
      );
    } catch {
      showError(E.simulateFailed);
    }
  }

  async function saveSchedule(
    schedule: ScheduleVm,
    next: Pick<AutomateSchedule, "name" | "active" | "cron" | "cronLabel">,
  ): Promise<void> {
    const updated = await patchDefinition(
      schedule.definition,
      { definition: withSchedule(schedule.definition, next) },
      E.scheduleSaveFailed,
    );
    if (!updated) return;
    if (updated.status === "ACTIVE") {
      // §3.9.0: edits to an ACTIVE schedule stage a pendingRev, never a hot
      // swap — publish stages the revision for four-eyes approval.
      try {
        const stepUp = await assertPasskeyStepUp(api);
        const staged = await api.POST(
          "/api/v1/workflow-studio/definitions/{id}/publish",
          { params: { path: { id: updated.id } }, body: { step_up: stepUp } },
        );
        if (!staged.data) throw new Error("automate schedule stage failed");
        replaceDefinition(staged.data);
        showSuccess(W.success.stage);
      } catch {
        showError(E.publishStageFailed);
      }
      return;
    }
    showSuccess(W.success.scheduleSave);
  }

  async function approveScheduleRevision(
    schedule: ScheduleVm,
    version: number,
  ): Promise<void> {
    if (
      session?.user_id &&
      schedule.definition.pending_staged_by &&
      session.user_id.toLowerCase() ===
        schedule.definition.pending_staged_by.toLowerCase()
    ) {
      showError(ko.console.workflows.labels.selfApprovalBlocked);
      return;
    }
    setFeedback(undefined);
    try {
      const stepUp = await assertPasskeyStepUp(api);
      const response = await api.POST(
        "/api/v1/workflow-studio/definitions/{id}/revisions/{rev}/approve",
        {
          params: { path: { id: schedule.id, rev: version } },
          body: { step_up: stepUp },
        },
      );
      if (!response.data) throw new Error("automate revision approve failed");
      replaceDefinition(response.data);
      showSuccess(W.success.approve);
    } catch {
      showError(E.publishApproveFailed);
    }
  }

  async function withdrawScheduleRevision(
    schedule: ScheduleVm,
    version: number,
  ): Promise<void> {
    setFeedback(undefined);
    try {
      const response = await api.POST(
        "/api/v1/workflow-studio/definitions/{id}/revisions/{rev}/withdraw",
        { params: { path: { id: schedule.id, rev: version } } },
      );
      if (!response.data) throw new Error("automate revision withdraw failed");
      replaceDefinition(response.data);
      showSuccess(W.success.withdraw);
    } catch {
      showError(E.publishWithdrawFailed);
    }
  }

  async function addRule(): Promise<void> {
    const condition = defaultCondition(fields);
    const envelope: AutomateEnvelope = {
      scope: "personal",
      doc: buildRuleDoc(condition, fields, actionOptions.at(0)),
      condition,
    };
    const created = await createDefinition(
      {
        workflowKey: `automate.rule.${nextId("wf")}`,
        displayName: S.labels.newRuleName(rules.length + 1),
        objectType: actionOptions.at(0)?.objectTypeKey ?? registry.at(0)?.key ?? "object",
        definition: automationDefinitionJson(envelope),
      },
      W.createFailed,
    );
    if (created) {
      setRuleId(created.id);
      showSuccess(W.createSuccess);
    }
  }

  /** §4-22 add path: authoring a 감시 규칙 IS the builder — a monitor-shaped draft definition. */
  async function addMonitor(): Promise<void> {
    const action = actionOptions.at(0);
    const objectType = action?.objectTypeKey ?? registry.at(0)?.key;
    if (!objectType) return;
    const condition = defaultCondition(fields);
    const envelope: AutomateEnvelope = {
      scope: "org",
      doc: buildRuleDoc(condition, fields, action),
      condition,
      monitor: { objectType, actionKey: action?.key ?? "" },
    };
    const created = await createDefinition(
      {
        workflowKey: `automate.monitor.${nextId("wf")}`,
        displayName: S.labels.newRuleName(rules.length + 1),
        objectType,
        definition: automationDefinitionJson(envelope),
      },
      W.createFailed,
    );
    if (created) {
      setRuleId(created.id);
      setScopeFilter("all");
      setTab("rules");
      showSuccess(W.createSuccess);
    }
  }

  async function addSchedule(): Promise<void> {
    const name = scheduleForm.name.trim();
    if (!name) return;
    const linkedRule =
      rules.find((rule) => rule.id === scheduleForm.ruleId) ?? rules.at(0);
    const envelope: AutomateEnvelope = {
      scope: "org",
      doc: null,
      condition: null,
      ...(linkedRule ? { ruleId: linkedRule.id } : {}),
    };
    const created = await createDefinition(
      {
        workflowKey: `automate.schedule.${nextId("wf")}`,
        displayName: name,
        objectType:
          linkedRule?.definition.object_type ?? registry.at(0)?.key ?? "object",
        definition: automationDefinitionJson(envelope, {
          name,
          active: true,
          cron: CADENCE_CRON[scheduleForm.cadence],
          cronLabel: S.cadence[scheduleForm.cadence],
        }),
      },
      E.scheduleSaveFailed,
    );
    if (created) {
      setScheduleId(created.id);
      setScheduleForm({ name: "", cadence: "daily", ruleId: "" });
      showSuccess(W.success.scheduleSave);
    }
  }

  const tabVisible: Record<AutomateTab, boolean> = {
    rules: gate.can(ACT.viewRulesTab, { kind: "automate_tab", id: "rules" }),
    schedules: gate.can(ACT.viewSchedulesTab, { kind: "automate_tab", id: "schedules" }),
    monitors: gate.can(ACT.viewMonitorsTab, { kind: "automate_tab", id: "monitors" }),
  };
  const activeTab: AutomateTab | undefined = tabVisible[tab]
    ? tab
    : (["rules", "schedules", "monitors"] as const).find((key) => tabVisible[key]);

  const tabResource = (id: AutomateTab) => ({ kind: "automate_tab", id });

  if (readState === "error") {
    return (
      <PageError
        message={E.loadFailed}
        onRetry={() => {
          void load();
        }}
      />
    );
  }
  if (readState === "loading") {
    return <SkeletonTable rows={4} cols={3} />;
  }

  return (
    <div className="console" style={hubStyle}>
      <FeedbackBanner
        message={feedback}
        kind={feedbackKind}
        onDismiss={() => {
          setFeedback(undefined);
        }}
      />

      <div aria-label={S.tabs.label} role="tablist" style={tabRowStyle}>
        {(
          [
            ["rules", ACT.viewRulesTab, S.tabs.rules],
            ["schedules", ACT.viewSchedulesTab, S.tabs.schedules],
            ["monitors", ACT.viewMonitorsTab, S.tabs.monitors],
          ] as const
        ).map(([key, action, label]) => (
          <PolicyGated key={key} action={action} resource={tabResource(key)}>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === key}
              onClick={() => {
                setTab(key);
              }}
              style={tabButtonStyle(activeTab === key)}
            >
              {label}
            </button>
          </PolicyGated>
        ))}
      </div>

      {!activeTab ? <StatusChip tone="neutral">{S.labels.noAvailableTabs}</StatusChip> : null}

      {activeTab === "rules" ? (
        <div style={splitStyle}>
          <section aria-labelledby="automate-rule-list-title" style={cardStyle}>
            <div style={sectionHeaderStyle}>
              <h2 id="automate-rule-list-title" style={sectionTitleStyle}>
                {S.sections.rules}
              </h2>
              <StatusChip tone="neutral">{S.count(visibleRules.length)}</StatusChip>
            </div>
            <div role="group" aria-label={S.scopeFilterLabel} style={chipRowStyle}>
              {(["all", "org", "personal"] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={scopeFilter === key}
                  onClick={() => {
                    setScopeFilter(key);
                  }}
                  style={tabButtonStyle(scopeFilter === key)}
                >
                  {S.scope[key]}
                </button>
              ))}
            </div>
            <ol style={listStyle}>
              {visibleRules.map((rule) => (
                <li key={rule.id}>
                  <PolicyGated
                    action={ACT.selectRule}
                    resource={{ kind: "automation_rule", id: rule.id }}
                  >
                    <button
                      type="button"
                      aria-pressed={rule.id === selectedRule?.id}
                      aria-label={S.actions.selectRule(rule.name)}
                      onClick={() => {
                        setRuleId(rule.id);
                      }}
                      style={rowButtonStyle(rule.id === selectedRule?.id)}
                    >
                      <span>{rule.name}</span>
                      <span style={chipRowStyle}>
                        <StatusChip tone="neutral">{S.scope[rule.scope]}</StatusChip>
                        <StatusChip tone={rule.active ? "ok" : "neutral"}>
                          {rule.active ? S.status.active : S.status.draft}
                        </StatusChip>
                      </span>
                    </button>
                  </PolicyGated>
                </li>
              ))}
            </ol>
            <PolicyGated action={ACT.createRule} resource={{ kind: "automation_rule" }}>
              <button
                type="button"
                onClick={() => {
                  void addRule();
                }}
                style={buttonStyle}
              >
                {S.actions.addRule}
              </button>
            </PolicyGated>
          </section>

          {selectedRule ? (
            <RuleBuilder
              key={selectedRule.id}
              rule={selectedRule}
              fields={fields}
              actionOptions={actionOptions}
              runLog={runEntriesFor(selectedRule.id)}
              onRename={(name) => {
                void patchDefinition(
                  selectedRule.definition,
                  { display_name: name },
                  W.actionFailed,
                );
              }}
              onEnvelopeChange={(envelope) => {
                void patchDefinition(
                  selectedRule.definition,
                  { definition: withAutomateEnvelope(selectedRule.definition, envelope) },
                  W.actionFailed,
                );
              }}
              onToggle={() => {
                void toggleDefinition(selectedRule.definition);
              }}
              onScopeToggle={() => {
                void patchDefinition(
                  selectedRule.definition,
                  {
                    definition: withAutomateEnvelope(selectedRule.definition, {
                      ...selectedRule.envelope,
                      scope: selectedRule.scope === "org" ? "personal" : "org",
                    }),
                  },
                  W.actionFailed,
                );
              }}
              onRun={() => {
                void runDefinition(selectedRule.id, "MANUAL");
              }}
              onSimulate={() => {
                void simulateDefinition(selectedRule.id);
              }}
              onRetry={() => {
                void runDefinition(selectedRule.id, "MANUAL");
              }}
            />
          ) : (
            <StatusChip tone="neutral">{S.labels.noSelection}</StatusChip>
          )}
        </div>
      ) : null}

      {activeTab === "schedules" ? (
        <div style={splitStyle}>
          <section aria-labelledby="automate-schedule-list-title" style={cardStyle}>
            <div style={sectionHeaderStyle}>
              <h2 id="automate-schedule-list-title" style={sectionTitleStyle}>
                {S.sections.schedules}
              </h2>
              <StatusChip tone="neutral">{S.count(schedules.length)}</StatusChip>
            </div>
            <ol style={listStyle}>
              {schedules.map((schedule) => (
                <li key={schedule.id}>
                  <PolicyGated
                    action={ACT.selectSchedule}
                    resource={{ kind: "schedule", id: schedule.id }}
                  >
                    <button
                      type="button"
                      aria-pressed={schedule.id === selectedSchedule?.id}
                      aria-label={S.actions.selectSchedule(schedule.schedule.name)}
                      onClick={() => {
                        setScheduleId(schedule.id);
                      }}
                      style={rowButtonStyle(schedule.id === selectedSchedule?.id)}
                    >
                      <span>{schedule.schedule.name}</span>
                      <span style={chipRowStyle}>
                        <StatusChip tone={schedule.schedule.active ? "ok" : "neutral"}>
                          {schedule.schedule.active ? S.status.active : S.status.inactive}
                        </StatusChip>
                        <StatusChip tone="neutral">
                          {schedule.cadence
                            ? S.cadence[schedule.cadence]
                            : schedule.schedule.cronLabel}
                        </StatusChip>
                        {schedule.schedule.nextRun !== undefined ? (
                          <StatusChip tone="neutral">
                            {S.labels.nextRun(schedule.schedule.nextRun)}
                          </StatusChip>
                        ) : null}
                        {schedule.pendingRev ? (
                          <StatusChip tone="warn">
                            {S.labels.pendingRevision(
                              schedule.pendingRev.version,
                              schedule.pendingRev.stagedBy,
                            )}
                          </StatusChip>
                        ) : null}
                      </span>
                    </button>
                  </PolicyGated>
                </li>
              ))}
            </ol>
            <PolicyGated action={ACT.createSchedule} resource={{ kind: "schedule" }}>
              <form
                aria-label={S.sections.addSchedule}
                onSubmit={(event) => {
                  event.preventDefault();
                  void addSchedule();
                }}
                style={{ display: "grid", gap: "var(--sp-3)" }}
              >
                <label style={fieldStyle}>
                  {S.labels.scheduleName}
                  <input
                    aria-label={S.labels.scheduleName}
                    value={scheduleForm.name}
                    onChange={(event) => {
                      setScheduleForm({ ...scheduleForm, name: event.currentTarget.value });
                    }}
                    style={inputStyle}
                  />
                </label>
                <CadenceSelect
                  value={scheduleForm.cadence}
                  onChange={(cadence) => {
                    setScheduleForm({ ...scheduleForm, cadence });
                  }}
                />
                <label style={fieldStyle}>
                  {S.labels.rule}
                  <select
                    aria-label={S.labels.rule}
                    value={scheduleForm.ruleId}
                    onChange={(event) => {
                      setScheduleForm({ ...scheduleForm, ruleId: event.currentTarget.value });
                    }}
                    style={inputStyle}
                  >
                    {rules.map((rule) => (
                      <option key={rule.id} value={rule.id}>
                        {rule.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit" style={buttonStyle}>
                  {S.actions.addSchedule}
                </button>
              </form>
            </PolicyGated>
          </section>

          {selectedSchedule ? (
            <ScheduleDetail
              key={selectedSchedule.id}
              schedule={selectedSchedule}
              runLog={runEntriesFor(selectedSchedule.id)}
              onSave={(draft) => {
                void saveSchedule(selectedSchedule, {
                  name: draft.name.trim() || selectedSchedule.schedule.name,
                  active: selectedSchedule.schedule.active,
                  cron: CADENCE_CRON[draft.cadence],
                  cronLabel: S.cadence[draft.cadence],
                });
              }}
              onToggle={() => {
                void patchDefinition(
                  selectedSchedule.definition,
                  {
                    definition: withSchedule(selectedSchedule.definition, {
                      ...selectedSchedule.schedule,
                      active: !selectedSchedule.schedule.active,
                    }),
                  },
                  E.toggleFailed,
                );
              }}
              onRun={() => {
                void runDefinition(selectedSchedule.id, "SCHEDULE");
              }}
              onApprove={(version) => {
                void approveScheduleRevision(selectedSchedule, version);
              }}
              onWithdraw={(version) => {
                void withdrawScheduleRevision(selectedSchedule, version);
              }}
              onRetry={() => {
                void runDefinition(selectedSchedule.id, "SCHEDULE");
              }}
            />
          ) : (
            <StatusChip tone="neutral">{S.labels.noSelection}</StatusChip>
          )}
        </div>
      ) : null}

      {activeTab === "monitors" ? (
        <section aria-labelledby="automate-monitor-list-title" style={cardStyle}>
          <div style={sectionHeaderStyle}>
            <h2 id="automate-monitor-list-title" style={sectionTitleStyle}>
              {S.sections.monitors}
            </h2>
            <div style={chipRowStyle}>
              <StatusChip tone="neutral">{S.count(monitors.length)}</StatusChip>
              <PolicyGated action={ACT.createMonitor} resource={{ kind: "monitor_rule" }}>
                <button
                  type="button"
                  onClick={() => {
                    void addMonitor();
                  }}
                  style={buttonStyle}
                >
                  {S.actions.createMonitor}
                </button>
              </PolicyGated>
            </div>
          </div>
          <ol style={listStyle}>
            {monitors.map((monitor) => {
              const runLog = runLogById[monitor.id];
              return (
                <li key={monitor.id} style={{ ...runItemStyle, paddingInlineStart: "var(--sp-4)" }}>
                  <div style={sectionHeaderStyle}>
                    <p style={runLabelStyle}>{monitor.name}</p>
                    <div style={chipRowStyle}>
                      <StatusChip tone={monitor.active ? "ok" : "neutral"}>
                        {monitor.active ? S.status.active : S.status.inactive}
                      </StatusChip>
                      {runLog ? (
                        <StatusChip tone="neutral">{S.labels.hits(runLog.length)}</StatusChip>
                      ) : null}
                    </div>
                  </div>
                  <div style={chipRowStyle}>
                    <StatusChip tone="neutral">{monitor.objectTypeTitle}</StatusChip>
                    {monitor.condition.predicates.map((predicate) => (
                      <StatusChip key={predicate.id} tone="info">
                        {predicateSummary(predicate, fields)}
                      </StatusChip>
                    ))}
                    {monitor.actionTitle !== undefined ? (
                      <StatusChip tone="accent">{monitor.actionTitle}</StatusChip>
                    ) : null}
                  </div>
                  <div style={chipRowStyle}>
                    <PolicyGated
                      action={ACT.toggleMonitor}
                      resource={{ kind: "monitor_rule", id: monitor.id }}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          void toggleDefinition(monitor.definition);
                        }}
                        style={buttonStyle}
                      >
                        {monitor.active ? S.actions.deactivate : S.actions.activate}
                      </button>
                    </PolicyGated>
                    <PolicyGated
                      action={ACT.editMonitor}
                      resource={{ kind: "monitor_rule", id: monitor.id }}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          // §4-22: a monitor IS a workflow — open the same
                          // definition in the rules-tab builder.
                          setRuleId(monitor.id);
                          setScopeFilter("all");
                          setTab("rules");
                        }}
                        style={buttonStyle}
                      >
                        {S.actions.editInBuilder}
                      </button>
                    </PolicyGated>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}
    </div>
  );
}

export function AutomatePage() {
  return (
    <>
      <PageHeader title={ko.nav.automate} />
      <BulkPolicyGateProvider actions={AUTOMATE_GATE_ACTIONS}>
        <AutomateHub />
      </BulkPolicyGateProvider>
    </>
  );
}
