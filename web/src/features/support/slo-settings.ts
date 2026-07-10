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
