import type {
  SupportTicketCategory,
  SupportTicketOrigin,
  SupportTicketPriority,
  SupportTicketSummary,
  SupportTicketStatus,
} from "../../api/types";
import { ko } from "../../i18n/ko";
import { formatKoreanDateTime } from "../../lib/datetime";
import { toneBadgeClass } from "../../lib/semantic";
import { supportDeskStrings } from "./support-desk-strings";
import {
  sloDeadlineMs,
  sloPosture,
  type SloPosture,
  type SloRules,
} from "./slo-settings";

export const SUPPORT_STATUSES: SupportTicketStatus[] = [
  "OPEN",
  "IN_PROGRESS",
  "ON_HOLD",
  "RESOLVED",
  "CLOSED",
];

export const SUPPORT_PRIORITIES: SupportTicketPriority[] = [
  "URGENT",
  "HIGH",
  "MEDIUM",
  "LOW",
];

export const SUPPORT_CATEGORIES: SupportTicketCategory[] = [
  "SYSTEM_BUG",
  "ACCESS_REQUEST",
  "OPERATIONAL",
  "EQUIPMENT_INQUIRY",
  "COMPLAINT",
  "OTHER",
];

export const SUPPORT_ORIGINS: SupportTicketOrigin[] = ["INTERNAL", "CUSTOMER"];

export function isActionableSupportTicket(
  ticket: Pick<SupportTicketSummary, "status" | "resolved_at" | "closed_at">,
): boolean {
  return (
    (ticket.status === "OPEN" ||
      ticket.status === "IN_PROGRESS" ||
      ticket.status === "ON_HOLD") &&
    !ticket.resolved_at &&
    !ticket.closed_at
  );
}

export function statusLabel(status: SupportTicketStatus): string {
  return ko.support.ticketStatus[status];
}

export function priorityLabel(priority: SupportTicketPriority): string {
  return ko.support.ticketPriority[priority];
}

export function categoryLabel(category: SupportTicketCategory): string {
  return ko.support.ticketCategory[category];
}

export function originLabel(origin: SupportTicketOrigin): string {
  return ko.support.ticketOrigin[origin];
}

/** Tailwind classes for a status badge — tone communicates lifecycle position. */
export function statusBadgeClass(status: SupportTicketStatus): string {
  switch (status) {
    case "OPEN":
      return toneBadgeClass("info");
    case "IN_PROGRESS":
      return toneBadgeClass("accent");
    case "ON_HOLD":
      return toneBadgeClass("warning");
    case "RESOLVED":
      return toneBadgeClass("success");
    case "CLOSED":
      return toneBadgeClass("neutral");
  }
}

/** Tailwind classes for a priority badge — tone communicates urgency. */
export function priorityBadgeClass(priority: SupportTicketPriority): string {
  switch (priority) {
    case "URGENT":
      return toneBadgeClass("danger");
    case "HIGH":
      return toneBadgeClass("warning");
    case "MEDIUM":
    case "LOW":
      return toneBadgeClass("neutral");
  }
}

/**
 * Allowed status transitions, mirroring the backend FSM
 * (`SupportTicketStatus::can_transition_to`). Keep in lockstep with
 * `backend/crates/support/domain/src/lib.rs`.
 */
const TRANSITIONS: Record<SupportTicketStatus, SupportTicketStatus[]> = {
  OPEN: ["IN_PROGRESS"],
  IN_PROGRESS: ["ON_HOLD", "RESOLVED"],
  ON_HOLD: ["IN_PROGRESS"],
  RESOLVED: ["CLOSED", "IN_PROGRESS"],
  CLOSED: [],
};

export function allowedTransitions(
  status: SupportTicketStatus,
): SupportTicketStatus[] {
  return TRANSITIONS[status];
}

/**
 * Korean action label for a transition edge. Reopening (back to IN_PROGRESS
 * from a resolved or on-hold ticket) reads as "reopen" rather than "start".
 */
export function transitionActionLabel(
  from: SupportTicketStatus,
  to: SupportTicketStatus,
): string {
  if (to === "IN_PROGRESS" && (from === "RESOLVED" || from === "ON_HOLD")) {
    return ko.support.transition.reopen;
  }
  switch (to) {
    case "IN_PROGRESS":
      return ko.support.transition.to_IN_PROGRESS;
    case "ON_HOLD":
      return ko.support.transition.to_ON_HOLD;
    case "RESOLVED":
      return ko.support.transition.to_RESOLVED;
    case "CLOSED":
      return ko.support.transition.to_CLOSED;
    case "OPEN":
      return ko.support.ticketStatus.OPEN;
  }
}

/**
 * Tailwind classes for support SLO posture chips (internal ops target — the
 * posture itself derives from the ACTIVE SLO setting in `slo-settings.ts`;
 * §4-26 keeps these distinct from contractual SLA badges).
 */
export function sloPostureBadgeClass(
  state: Exclude<SloPosture, "ok" | "none">,
): string {
  switch (state) {
    case "overdue":
      return toneBadgeClass("danger");
    case "dueSoon":
      return toneBadgeClass("warning");
  }
}

/** Compact KST datetime (`YYYY-MM-DD HH:mm`); the not-set label when unset. */
export function formatDateTime(value: string | null): string {
  if (!value) return ko.common.notSet;
  return formatKoreanDateTime(value);
}

/**
 * SUP- object code derived from the ticket's API id (§4-25-⑥; same derivation
 * pattern as the leave console's JL- codes). Alnum-only so the code is safe in
 * the §4-20 drag-reference token grammar. Uses the id's TAIL, not its head:
 * seeded/sequential UUIDs zero-pad the leading bytes and carry the distinctive
 * suffix last (…5c0001/…5c0002/…5c0003), so a head slice collapses every row to
 * the same "SUP-0000" placeholder while the tail gives distinct real codes.
 */
export function ticketCode(id: string): string {
  const cleaned = id.replaceAll(/[^0-9A-Za-z]/gu, "");
  return `SUP-${cleaned.slice(-4).toUpperCase()}`;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * SLO timer chip for an actionable ticket: time to/past the deadline derived
 * from the ACTIVE setting (§4-25-⑥). Null for settled tickets or unparseable
 * dates — the chip is omitted rather than showing a dead timer.
 */
export function sloTimerChip(
  ticket: Pick<
    SupportTicketSummary,
    "category" | "status" | "created_at" | "due_at" | "resolved_at" | "closed_at"
  >,
  rules: SloRules,
  nowMs: number,
): { className: string; label: string } | null {
  if (!isActionableSupportTicket(ticket)) return null;
  const deadline = sloDeadlineMs(ticket, rules);
  if (Number.isNaN(deadline)) return null;
  const D = supportDeskStrings();
  const distance = Math.abs(deadline - nowMs);
  const time = D.duration(
    Math.floor(distance / HOUR_MS),
    Math.floor((distance % HOUR_MS) / 60_000),
  );
  const posture = sloPosture(ticket, rules, nowMs);
  if (posture === "overdue") {
    return { className: toneBadgeClass("danger"), label: D.sloOverdueBy(time) };
  }
  return {
    className: toneBadgeClass(posture === "dueSoon" ? "warning" : "neutral"),
    label: D.sloRemaining(time),
  };
}
