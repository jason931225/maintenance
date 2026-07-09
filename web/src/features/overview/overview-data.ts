// UI-M3 Overview (통합 개요) — pure aggregation over the real pending-item
// sources: engine approval tasks awaiting me, P1 dispatch offers, actionable
// support tickets, and attendance exceptions. Builders are pure so the
// aggregation/count/filter logic is unit-testable without the network.

import type {
  AttendanceSummaryItem,
  MyDispatchOffer,
  SupportTicketStatus,
  SupportTicketSummary,
  WorkflowTaskSummary,
} from "../../api/types";
import { ko } from "../../i18n/ko";
import { formatKoreanDateTime } from "../../lib/datetime";
import { objectRegistry } from "../../lib/objectRegistry";
import { safeLabel } from "../../lib/utils";

export type OverviewKind = "approval" | "dispatch" | "support" | "attendance";

export const OVERVIEW_KINDS: OverviewKind[] = [
  "approval",
  "dispatch",
  "support",
  "attendance",
];

// The four inbox sources, keyed for partial-failure reporting.
export type OverviewSource = "approvals" | "dispatch" | "support" | "attendance";

/** The REAL mutation a row's primary action executes (or a plain navigation
 * for kinds whose resolution has no API — attendance exceptions). */
export type OverviewAction =
  | { type: "claim"; taskId: string }
  | { type: "approve"; taskId: string }
  | { type: "acceptDispatch"; dispatchId: string }
  | {
      type: "transitionTicket";
      ticketId: string;
      toStatus: SupportTicketStatus;
      /** When set, the success toast offers undo via this reverse transition. */
      undoStatus?: SupportTicketStatus;
    }
  | { type: "open"; href: string };

export interface OverviewItem {
  id: string;
  kind: OverviewKind;
  /** Human-readable object code for the pin panel / mono ref. */
  code: string;
  title: string;
  detail: string;
  dueLabel?: string;
  /** Secondary navigation target (row context), when one exists. */
  href?: string;
  actionLabel: string;
  action: OverviewAction;
  /** Epoch millis of the effective deadline; Infinity when none. */
  dueTime: number;
}

function dueTime(iso: string | null | undefined): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const value = new Date(iso).getTime();
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function dueLabelFor(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  return ko.overview.rows.due.replace("{time}", formatKoreanDateTime(iso));
}

export function buildApprovalItems(
  tasks: WorkflowTaskSummary[],
  myUserId: string | undefined,
): OverviewItem[] {
  return tasks
    .filter(
      (task) =>
        task.status === "OPEN" ||
        (task.status === "CLAIMED" && task.claimed_by === myUserId),
    )
    .map((task) => {
      const claimedByMe = task.status === "CLAIMED";
      return {
        id: `approval-${task.task_id}`,
        kind: "approval" as const,
        code: task.task_id,
        title: safeLabel(task.title),
        detail: claimedByMe
          ? ko.overview.rows.approvalClaimed
          : ko.overview.rows.approvalOpen,
        // Drill-in to the 전자결재 (UI-M4) run detail — no dead end. Route
        // authority is objectRegistry (keyed by the run id).
        href: objectRegistry.approval.route({ id: task.run_id }),
        dueLabel: dueLabelFor(task.due_at),
        actionLabel: claimedByMe
          ? ko.overview.actions.approve
          : ko.overview.actions.claim,
        action: claimedByMe
          ? { type: "approve" as const, taskId: task.task_id }
          : { type: "claim" as const, taskId: task.task_id },
        dueTime: dueTime(task.due_at),
      };
    });
}

export function buildDispatchItems(offers: MyDispatchOffer[]): OverviewItem[] {
  return offers.map((offer) => ({
    id: `dispatch-${offer.dispatch_id}`,
    kind: "dispatch" as const,
    code: offer.request_no,
    title: ko.overview.rows.dispatchTitle.replace(
      "{requestNo}",
      offer.request_no,
    ),
    detail: ko.overview.rows.dispatchDetail.replace(
      "{due}",
      formatKoreanDateTime(offer.accept_window_ends_at),
    ),
    dueLabel: dueLabelFor(offer.accept_window_ends_at),
    href: `/work-orders/${offer.work_order_id}`,
    actionLabel: ko.overview.actions.accept,
    action: { type: "acceptDispatch" as const, dispatchId: offer.dispatch_id },
    dueTime: dueTime(offer.accept_window_ends_at),
  }));
}

/** Primary transition per actionable ticket status (support FSM edges):
 * OPEN → IN_PROGRESS(접수), IN_PROGRESS → RESOLVED(해결, undo = reopen),
 * ON_HOLD → IN_PROGRESS(재개). */
function ticketPrimary(status: SupportTicketStatus): {
  label: string;
  toStatus: SupportTicketStatus;
  undoStatus?: SupportTicketStatus;
} | null {
  switch (status) {
    case "OPEN":
      return { label: ko.overview.actions.startTicket, toStatus: "IN_PROGRESS" };
    case "IN_PROGRESS":
      return {
        label: ko.overview.actions.resolveTicket,
        toStatus: "RESOLVED",
        undoStatus: "IN_PROGRESS",
      };
    case "ON_HOLD":
      return { label: ko.overview.actions.resumeTicket, toStatus: "IN_PROGRESS" };
    default:
      return null;
  }
}

export function buildSupportItems(
  tickets: SupportTicketSummary[],
): OverviewItem[] {
  return tickets.flatMap((ticket) => {
    const primary = ticketPrimary(ticket.status);
    if (!primary) return [];
    return [
      {
        id: `support-${ticket.id}`,
        kind: "support" as const,
        code: ticket.id,
        title: safeLabel(ticket.title),
        detail: ko.overview.rows.supportDetail
          .replace(
            "{status}",
            ko.support.ticketStatus[ticket.status],
          )
          .replace("{requester}", safeLabel(ticket.requester_name)),
        dueLabel: dueLabelFor(ticket.due_at),
        href: "/support",
        actionLabel: primary.label,
        action: {
          type: "transitionTicket" as const,
          ticketId: ticket.id,
          toStatus: primary.toStatus,
          undoStatus: primary.undoStatus,
        },
        dueTime: dueTime(ticket.due_at),
      },
    ];
  });
}

/** An attendance exception = unbalanced arrivals/departures in the summary
 * window (a likely missing clock-out). There is no resolution API, so the
 * primary action navigates to the HR attendance review surface. */
export function buildAttendanceItems(
  summaries: AttendanceSummaryItem[],
): OverviewItem[] {
  return summaries
    .filter((item) => item.arrivals !== item.departures)
    .map((item) => ({
      id: `attendance-${item.user_id}`,
      kind: "attendance" as const,
      code: item.user_id,
      title: ko.overview.rows.attendanceTitle.replace(
        "{name}",
        safeLabel(item.display_name),
      ),
      detail: ko.overview.rows.attendanceDetail
        .replace("{arrivals}", String(item.arrivals))
        .replace("{departures}", String(item.departures)),
      href: "/employees",
      actionLabel: ko.overview.actions.review,
      action: { type: "open" as const, href: "/employees" },
      dueTime: dueTime(item.last_event_at),
    }));
}

/** Deadline-first ordering: nearest due first, no-deadline items after,
 * stable within a source. */
export function sortInboxItems(items: OverviewItem[]): OverviewItem[] {
  return [...items].sort((a, b) => a.dueTime - b.dueTime);
}

export function countsByKind(
  items: OverviewItem[],
): Record<OverviewKind, number> {
  const counts: Record<OverviewKind, number> = {
    approval: 0,
    dispatch: 0,
    support: 0,
    attendance: 0,
  };
  for (const item of items) counts[item.kind] += 1;
  return counts;
}

export function filterByKind(
  items: OverviewItem[],
  kind: OverviewKind | "all",
): OverviewItem[] {
  if (kind === "all") return items;
  return items.filter((item) => item.kind === kind);
}
