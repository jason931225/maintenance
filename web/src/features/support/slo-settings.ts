// Support-ticket response targets are an SLO — an INTERNAL ops target whose
// breach raises an alert — never an SLA (contractual/external, breach = penalty;
// §4-26). The SLO policy is a configurable setting OBJECT: per ticket type a
// threshold / evaluation window / escalation target, edited no-code with
// §3.9.0 revision staging (active edits stage pendingRev v+1 behind 적용 승인
// four-eyes / 철회 — never a hot swap).
//
// wire-pending: Phase C — setting object per be-ontology-engine-arch.md:
// read  = GET  /api/v1/ontology/instances?type=support_slo_setting
// stage = POST /api/v1/ontology/actions/support_slo_setting.revise/execute
// decide= POST /api/v1/governance/approvals/{id}/decide (approver ≠ requester)

import type { ConsoleApiClient } from "../../api/client";
import { getObjectType, listInstances, type InstanceStateWire } from "../../api/ontology";
import { executeOntologyAction } from "../../api/ontologyActions";
import type {
  SupportTicketCategory,
  SupportTicketStatus,
  SupportTicketSummary,
} from "../../api/types";

/** Who an SLO breach escalates to (internal alert target, §4-26). */
export type SloEscalationTarget = "TEAM_LEAD" | "DEDICATED" | "ADMIN";

export const SLO_ESCALATION_TARGETS: readonly SloEscalationTarget[] = [
  "TEAM_LEAD",
  "DEDICATED",
  "ADMIN",
];

/** Per-ticket-type SLO rule: typed fields only (§4-19), edited no-code. */
export interface SloRule {
  /** First-response/handling target in hours; the derived deadline input. */
  thresholdHours: number;
  /** Rolling evaluation window (days) for the breach tally. */
  windowDays: number;
  escalationTarget: SloEscalationTarget;
}

export type SloRules = Record<SupportTicketCategory, SloRule>;

/** §3.9.0 pendingRev — an edit to the ACTIVE setting staged for four-eyes. */
export interface SloPendingRevision {
  version: number;
  rules: SloRules;
  stagedById: string;
  stagedByName: string;
}

export interface SloSettingState {
  version: number;
  /** The ACTIVE setting — ticket timers/derived states compute from this only. */
  active: SloRules;
  pending?: SloPendingRevision;
}

/**
 * wire-pending: Phase C — replace with the persisted setting object (endpoints
 * above); these defaults are the v1 seed the no-code editor revises.
 */
export function defaultSloSettings(): SloSettingState {
  return {
    version: 1,
    active: {
      SYSTEM_BUG: {
        thresholdHours: 8,
        windowDays: 7,
        escalationTarget: "DEDICATED",
      },
      ACCESS_REQUEST: {
        thresholdHours: 24,
        windowDays: 7,
        escalationTarget: "TEAM_LEAD",
      },
      OPERATIONAL: {
        thresholdHours: 24,
        windowDays: 7,
        escalationTarget: "TEAM_LEAD",
      },
      EQUIPMENT_INQUIRY: {
        thresholdHours: 24,
        windowDays: 7,
        escalationTarget: "TEAM_LEAD",
      },
      COMPLAINT: {
        thresholdHours: 4,
        windowDays: 7,
        escalationTarget: "ADMIN",
      },
      OTHER: {
        thresholdHours: 48,
        windowDays: 7,
        escalationTarget: "TEAM_LEAD",
      },
    },
  };
}

/** Editing the ACTIVE setting stages a v+1 revision; re-staging replaces it. */
export function stageSloEdit(
  state: SloSettingState,
  rules: SloRules,
  actor: { id: string; name: string },
): SloSettingState {
  return {
    ...state,
    pending: {
      version: state.version + 1,
      rules,
      stagedById: actor.id,
      stagedByName: actor.name,
    },
  };
}

/**
 * 적용 승인 — four-eyes: the stager can never approve their own revision
 * (approver ≠ requester, mirroring /governance/approvals/{id}/decide). A
 * same-actor approval is a no-op, and the UI omits the control entirely.
 */
export function approveSloRevision(
  state: SloSettingState,
  approverId: string,
): SloSettingState {
  if (!state.pending || state.pending.stagedById === approverId) {
    return state;
  }
  return { version: state.pending.version, active: state.pending.rules };
}

/** 철회 — drop the staged revision; the ACTIVE setting stays as-is. */
export function withdrawSloRevision(state: SloSettingState): SloSettingState {
  return { version: state.version, active: state.active };
}

export type SloPosture = "overdue" | "dueSoon" | "ok" | "none";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DUE_SOON_MS = 4 * HOUR_MS;

type SloTicketFields = Pick<
  SupportTicketSummary,
  "category" | "status" | "created_at" | "due_at" | "resolved_at"
>;

/**
 * The SLO deadline for a ticket, derived from the ACTIVE setting (§4-25-⑥):
 * created_at + threshold for the ticket's type. An explicit per-ticket due_at
 * (operator-set, backend-provided) overrides the type default.
 */
export function sloDeadlineMs(
  ticket: Pick<SloTicketFields, "category" | "created_at" | "due_at">,
  rules: SloRules,
): number {
  if (ticket.due_at) {
    const explicit = Date.parse(ticket.due_at);
    if (!Number.isNaN(explicit)) return explicit;
  }
  const created = Date.parse(ticket.created_at);
  if (Number.isNaN(created)) return Number.NaN;
  return created + rules[ticket.category].thresholdHours * HOUR_MS;
}

/**
 * SLO posture from the ACTIVE setting. Terminal tickets (RESOLVED/CLOSED) are
 * settled, never overdue. `dueSoon` fires within 4h of the deadline.
 */
export function sloPosture(
  ticket: SloTicketFields,
  rules: SloRules,
  nowMs: number,
): SloPosture {
  const terminal: SupportTicketStatus[] = ["RESOLVED", "CLOSED"];
  if (terminal.includes(ticket.status)) return "ok";
  const deadline = sloDeadlineMs(ticket, rules);
  if (Number.isNaN(deadline)) return "none";
  if (deadline <= nowMs) return "overdue";
  if (deadline - nowMs <= DUE_SOON_MS) return "dueSoon";
  return "ok";
}

/**
 * Breach tally per ticket type over that type's evaluation window: tickets
 * created within the window that are past their SLO deadline while still open,
 * or were resolved after it. Feeds the settings card — state-derived, so an
 * approved revision recomputes it (§4-25-⑥).
 */
export function sloWindowBreaches(
  tickets: SloTicketFields[],
  rules: SloRules,
  nowMs: number,
): Record<SupportTicketCategory, number> {
  const counts = Object.fromEntries(
    Object.keys(rules).map((category) => [category, 0]),
  ) as Record<SupportTicketCategory, number>;
  for (const ticket of tickets) {
    const rule = rules[ticket.category];
    const created = Date.parse(ticket.created_at);
    if (Number.isNaN(created) || nowMs - created > rule.windowDays * DAY_MS) {
      continue;
    }
    const deadline = sloDeadlineMs(ticket, rules);
    if (Number.isNaN(deadline)) continue;
    const settledAt = ticket.resolved_at
      ? Date.parse(ticket.resolved_at)
      : undefined;
    const breached =
      settledAt !== undefined && !Number.isNaN(settledAt)
        ? settledAt > deadline
        : sloPosture(ticket, rules, nowMs) === "overdue";
    if (breached) counts[ticket.category] += 1;
  }
  return counts;
}

// ---- SLO settings card → real engine instances (be2-config-objects) ----
// The `support_slo_setting` object type is seeded through the ontology engine
// (backend/crates/ontology/adapter-postgres/src/seed.rs) with a fixed
// ticket_type choice (incident/request/change) — a coarser taxonomy than the
// SupportTicketCategory used for ticket-badge posture above. The settings
// CARD below wires to the real, persisted 3-bucket schema; ticket-badge
// posture keeps using the local SupportTicketCategory rules until a follow-up
// reconciles the two taxonomies (flagged in the lane report, not silently
// papered over — no fabricated per-category engine data).

export const SUPPORT_SLO_SETTING_KEY = "support_slo_setting";

export type EngineTicketType = "incident" | "request" | "change";
export const ENGINE_TICKET_TYPES: readonly EngineTicketType[] = [
  "incident",
  "request",
  "change",
];

export type EngineSloWindow = "business_hours" | "calendar";
export const ENGINE_SLO_WINDOWS: readonly EngineSloWindow[] = [
  "business_hours",
  "calendar",
];

/** One support_slo_setting instance — real ticket_type/threshold_minutes/window/escalation_target. */
export interface EngineSloRule {
  /** null = no instance created yet for this ticket_type (unsaved default). */
  instanceId: string | null;
  ticketType: EngineTicketType;
  thresholdMinutes: number;
  window: EngineSloWindow;
  escalationTarget: string;
  /** Real ont_instance_revisions.version — 0 until the first commit. */
  version: number;
}

export type EngineSloRules = Record<EngineTicketType, EngineSloRule>;

function emptyEngineRule(ticketType: EngineTicketType): EngineSloRule {
  return {
    instanceId: null,
    ticketType,
    thresholdMinutes: 60,
    window: "business_hours",
    escalationTarget: "",
    version: 0,
  };
}

function isEngineTicketType(value: unknown): value is EngineTicketType {
  return value === "incident" || value === "request" || value === "change";
}

function engineSloRuleOf(state: InstanceStateWire): EngineSloRule | null {
  const a = state.revision.attributes;
  if (!isEngineTicketType(a.ticket_type)) return null;
  return {
    instanceId: state.instance.id,
    ticketType: a.ticket_type,
    thresholdMinutes: typeof a.threshold_minutes === "number" ? a.threshold_minutes : 0,
    window: a.window === "calendar" ? "calendar" : "business_hours",
    escalationTarget: typeof a.escalation_target === "string" ? a.escalation_target : "",
    version: state.revision.version,
  };
}

/** list — GET /ontology/instances?type=support_slo_setting (RLS ∧ Cedar server-side). */
export async function fetchEngineSloRules(
  api: ConsoleApiClient,
): Promise<{ objectTypeId: string; rules: EngineSloRules }> {
  const detail = await getObjectType(api, SUPPORT_SLO_SETTING_KEY);
  const states = await listInstances(api, detail.object_type.id);
  const rules: EngineSloRules = {
    incident: emptyEngineRule("incident"),
    request: emptyEngineRule("request"),
    change: emptyEngineRule("change"),
  };
  for (const state of states) {
    const rule = engineSloRuleOf(state);
    if (rule) rules[rule.ticketType] = rule;
  }
  return { objectTypeId: detail.object_type.id, rules };
}

/**
 * create/stage — the single audited action path (POST
 * /ontology/actions/create/execute): creates the ticket-type's first instance
 * or stages its v+1 revision when `existing.instanceId` is set. The 적용
 * 승인 click in the card is what calls this — never a hot edit.
 */
export async function commitEngineSloRule(
  api: ConsoleApiClient,
  objectTypeId: string,
  existing: EngineSloRule,
): Promise<EngineSloRule> {
  const result = await executeOntologyAction(api, "create", {
    object_type_id: objectTypeId,
    ...(existing.instanceId ? { instance_id: existing.instanceId } : {}),
    params: {
      ticket_type: existing.ticketType,
      threshold_minutes: existing.thresholdMinutes,
      window: existing.window,
      escalation_target: existing.escalationTarget,
    },
  });
  return {
    instanceId: result.instance.instanceId,
    ticketType: existing.ticketType,
    thresholdMinutes: existing.thresholdMinutes,
    window: existing.window,
    escalationTarget: existing.escalationTarget,
    version: result.instance.version,
  };
}
