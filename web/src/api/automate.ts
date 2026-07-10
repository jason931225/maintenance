// Automate hub ⇄ workflow-studio mapping. The hub drives the SAME
// /api/v1/workflow-studio/* REST WorkflowStudioPage does (§4-18: shared
// endpoints, shared generated response types — see that page for the call
// idiom). This module owns only what is hub-specific: the definition-JSON
// envelope the hub authors (BlockCanvas doc + typed predicate condition +
// scope + monitor trigger shape + studio-compatible schedule) and the run-log
// row mapping. Monitors ARE workflow definitions (Foundry Automate): the
// `automate.monitor` shape marks the object-set trigger, nothing else differs.
import { parseDoc, type CanvasDoc, type Predicate, type PredicateGroup } from "../console/canvas";
import { formatKoreanDateTime } from "../lib/datetime";
import type { WorkflowDefinitionResponse, WorkflowRunResponse } from "./types";

export const AUTOMATE_SCHEMA_VERSION = "workflow.definition.v1";

type JsonRecord = Record<string, unknown>;

export type AutomateScope = "org" | "personal";

/** §2 object-monitor trigger: an object-set condition over one object type → effect action. */
export interface AutomateMonitor {
  objectType: string;
  actionKey: string;
}

/** The hub-authored slice of the definition JSON (`definition.automate`). */
export interface AutomateEnvelope {
  scope: AutomateScope;
  doc: CanvasDoc | null;
  condition: PredicateGroup | null;
  monitor?: AutomateMonitor;
  /** 예약 → 규칙 link (schedule definitions only). */
  ruleId?: string;
}

/** Studio-compatible `definition.schedule` (same keys scheduleDefinitionPatch writes). */
export interface AutomateSchedule {
  name: string;
  active: boolean;
  cron: string;
  cronLabel: string;
  nextRun?: string;
  lastRun?: string;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function str(record: JsonRecord | undefined, field: string): string | undefined {
  const value = record?.[field];
  return typeof value === "string" && value !== "" ? value : undefined;
}

const PREDICATE_OPS = new Set(["gte", "lte", "eq", "neq", "in"]);
const PREDICATE_VALUE_KINDS = new Set([
  "number",
  "bool",
  "date",
  "text",
  "enum",
  "enumSet",
  "code",
]);

function predicateOf(value: unknown): Predicate | undefined {
  const record = asRecord(value);
  const id = str(record, "id");
  const field = str(record, "field");
  const op = str(record, "op");
  const predicateValue = asRecord(record?.value);
  const kind = str(predicateValue, "kind");
  if (!id || !field || !op || !PREDICATE_OPS.has(op) || !kind) return undefined;
  if (!PREDICATE_VALUE_KINDS.has(kind) || predicateValue?.value === undefined) return undefined;
  return {
    id,
    field,
    op: op as Predicate["op"],
    value: { kind, value: predicateValue.value } as Predicate["value"],
  };
}

/** Rehydrate a persisted predicate condition; malformed payloads read as null, never crash. */
export function predicateGroupOf(value: unknown): PredicateGroup | null {
  const record = asRecord(value);
  const join = record?.join;
  if ((join !== "and" && join !== "or") || !Array.isArray(record?.predicates)) return null;
  const predicates = record.predicates.flatMap((entry) => {
    const predicate = predicateOf(entry);
    return predicate ? [predicate] : [];
  });
  return { join, predicates };
}

function canvasDocOf(value: unknown): CanvasDoc | null {
  if (!value) return null;
  try {
    return parseDoc(JSON.stringify(value));
  } catch {
    return null;
  }
}

/** Read the hub envelope out of a definition's JSON. */
export function automateEnvelopeOf(definition: WorkflowDefinitionResponse): AutomateEnvelope {
  const automate = asRecord(definition.definition.automate);
  const monitorRecord = asRecord(automate?.monitor);
  const monitorObjectType = str(monitorRecord, "object_type");
  const monitorActionKey = str(monitorRecord, "action_key");
  return {
    scope: automate?.scope === "personal" ? "personal" : "org",
    doc: canvasDocOf(automate?.doc),
    condition: predicateGroupOf(automate?.condition),
    ...(monitorObjectType && monitorActionKey
      ? { monitor: { objectType: monitorObjectType, actionKey: monitorActionKey } }
      : {}),
    ...(str(automate, "rule_id") !== undefined ? { ruleId: str(automate, "rule_id") } : {}),
  };
}

/** Read the studio-compatible schedule block; absent/cron-less ⇒ not a schedule. */
export function scheduleOf(definition: WorkflowDefinitionResponse): AutomateSchedule | undefined {
  const schedule = asRecord(definition.definition.schedule);
  const cron = str(schedule, "cron");
  if (!schedule || !cron) return undefined;
  const nextRun = str(schedule, "next_run_at");
  const lastRun = str(schedule, "last_run_at");
  return {
    name: str(schedule, "name") ?? definition.display_name,
    active: schedule.active === true,
    cron,
    cronLabel: str(schedule, "cron_label") ?? cron,
    ...(nextRun !== undefined ? { nextRun } : {}),
    ...(lastRun !== undefined ? { lastRun } : {}),
  };
}

export function isScheduleDefinition(definition: WorkflowDefinitionResponse): boolean {
  return scheduleOf(definition) !== undefined;
}

function automateJson(envelope: AutomateEnvelope): JsonRecord {
  return {
    scope: envelope.scope,
    doc: envelope.doc,
    condition: envelope.condition,
    ...(envelope.monitor
      ? {
          monitor: {
            object_type: envelope.monitor.objectType,
            action_key: envelope.monitor.actionKey,
          },
        }
      : {}),
    ...(envelope.ruleId !== undefined ? { rule_id: envelope.ruleId } : {}),
  };
}

/** Fresh definition JSON for POST /workflow-studio/definitions. */
export function automationDefinitionJson(
  envelope: AutomateEnvelope,
  schedule?: Pick<AutomateSchedule, "name" | "active" | "cron" | "cronLabel">,
): JsonRecord {
  return {
    schema_version: AUTOMATE_SCHEMA_VERSION,
    trigger: envelope.monitor
      ? `${envelope.monitor.objectType}.monitor`
      : "automate.object_change",
    steps: [],
    automate: automateJson(envelope),
    ...(schedule
      ? {
          schedule: {
            name: schedule.name,
            active: schedule.active,
            cron: schedule.cron,
            cron_label: schedule.cronLabel,
          },
        }
      : {}),
  };
}

/** Existing definition JSON with the hub envelope replaced (foreign keys preserved). */
export function withAutomateEnvelope(
  definition: WorkflowDefinitionResponse,
  envelope: AutomateEnvelope,
): JsonRecord {
  return { ...definition.definition, automate: automateJson(envelope) };
}

/** Existing definition JSON with the schedule block updated (mirrors the studio's patch). */
export function withSchedule(
  definition: WorkflowDefinitionResponse,
  schedule: Pick<AutomateSchedule, "name" | "active" | "cron" | "cronLabel">,
): JsonRecord {
  const existing = asRecord(definition.definition.schedule) ?? {};
  return {
    ...definition.definition,
    schedule: {
      ...existing,
      name: schedule.name,
      active: schedule.active,
      cron: schedule.cron,
      cron_label: schedule.cronLabel,
    },
  };
}

// ── Run log (GET /workflow-studio/definitions/{id}/run-log rows) ─────────────

export type AutomateRunStatus = "succeeded" | "failed" | "running";

export interface AutomateRunEntry {
  id: string;
  at: string;
  status: AutomateRunStatus;
  label: string;
  /** started_at → completed/failed_at; null when the run is still in flight. */
  durationMs: number | null;
  /** Generated object codes (the run payload carries codes only). */
  objects: { code: string; title: string }[];
  retryable?: boolean;
}

function runStatusOf(status: WorkflowRunResponse["status"]): AutomateRunStatus {
  if (status === "SUCCEEDED") return "succeeded";
  if (status === "FAILED" || status === "CANCELLED") return "failed";
  return "running";
}

function runDurationMs(run: WorkflowRunResponse): number | null {
  const endIso = run.completed_at ?? run.failed_at;
  if (!endIso) return null;
  const start = Date.parse(run.started_at);
  const end = Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return end - start;
}

export function runEntryOf(run: WorkflowRunResponse): AutomateRunEntry {
  return {
    id: run.id,
    at: formatKoreanDateTime(run.completed_at ?? run.failed_at ?? run.updated_at),
    status: runStatusOf(run.status),
    label: run.error_message ? `${run.summary} · ${run.error_message}` : run.summary,
    durationMs: runDurationMs(run),
    objects: run.generated_objects.map((code) => ({ code, title: code })),
    retryable: run.status === "FAILED",
  };
}

export function runIdempotencyKey(
  definitionId: string,
  triggerType: "MANUAL" | "SCHEDULE",
): string {
  return `automate:${definitionId}:${triggerType}:${Date.now().toString(36)}`;
}
