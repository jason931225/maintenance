import type {
  SupportTicketCategory,
  SupportTicketOrigin,
  SupportTicketPriority,
  SupportTicketStatus,
} from "../../api/types";
import { ko } from "../../i18n/ko";
import { formatKoreanDateTime } from "../../lib/datetime";

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
      return "border-sky-300 bg-sky-50 text-sky-900";
    case "IN_PROGRESS":
      return "border-indigo-300 bg-indigo-50 text-indigo-900";
    case "ON_HOLD":
      return "border-amber-300 bg-amber-50 text-amber-900";
    case "RESOLVED":
      return "border-emerald-300 bg-emerald-50 text-emerald-900";
    case "CLOSED":
      return "border-line bg-muted-panel text-steel";
  }
}

/** Tailwind classes for a priority badge — tone communicates urgency. */
export function priorityBadgeClass(priority: SupportTicketPriority): string {
  switch (priority) {
    case "URGENT":
      return "border-red-300 bg-red-50 text-red-900";
    case "HIGH":
      return "border-orange-300 bg-orange-50 text-orange-900";
    case "MEDIUM":
      return "border-line bg-muted-panel text-steel";
    case "LOW":
      return "border-line bg-muted-panel text-steel";
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

export type SlaState = "overdue" | "dueSoon" | "ok" | "none";

/**
 * Classify a ticket's SLA posture from its due date. Terminal tickets
 * (RESOLVED/CLOSED) never show as overdue. `dueSoon` fires within `soonMs`
 * (default 4h) of the deadline.
 */
export function slaState(
  dueAt: string | null,
  status: SupportTicketStatus,
  nowMs: number,
  soonMs = 4 * 60 * 60 * 1000,
): SlaState {
  if (!dueAt) return "none";
  if (status === "RESOLVED" || status === "CLOSED") return "ok";
  const dueMs = Date.parse(dueAt);
  if (Number.isNaN(dueMs)) return "none";
  if (dueMs <= nowMs) return "overdue";
  if (dueMs - nowMs <= soonMs) return "dueSoon";
  return "ok";
}

/** Compact KST datetime (`YYYY-MM-DD HH:mm`); the not-set label when unset. */
export function formatDateTime(value: string | null): string {
  if (!value) return ko.common.notSet;
  return formatKoreanDateTime(value);
}
