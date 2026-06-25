import type { WorkOrderListItem } from "../../api/types";

/** SLA standing of a work order relative to its target due time. */
export type SlaStatus = "on-track" | "at-risk" | "breached" | "none";

/**
 * Lead time (minutes) before `target_due_at` at which a still-open work order is
 * flagged "at risk". Mirrors the backend ops summary's at-risk window concept;
 * the dashboard rollup (OpsSummary.sla_at_risk / sla_breached) is the org-wide
 * count, this is the per-work-order view of the same target_due_at datum.
 */
export const SLA_AT_RISK_MINUTES = 30;

/** Statuses past which an SLA no longer applies (terminal / closed-out). */
const TERMINAL_STATUSES: ReadonlySet<WorkOrderListItem["status"]> = new Set([
  "FINAL_COMPLETED",
  "REJECTED",
  "ARCHIVED",
  "CANCELLED",
]);

/**
 * Classify a work order's SLA standing from its `target_due_at` and current
 * status. Pure and deterministic given `now` so it is unit-testable:
 *  - no target, or a terminal status -> "none" (no badge meaning).
 *  - past the target -> "breached".
 *  - within SLA_AT_RISK_MINUTES of the target -> "at-risk".
 *  - otherwise -> "on-track".
 */
export function slaStatus(
  workOrder: Pick<WorkOrderListItem, "status" | "target_due_at">,
  now: Date = new Date(),
): SlaStatus {
  if (!workOrder.target_due_at || TERMINAL_STATUSES.has(workOrder.status)) {
    return "none";
  }
  const dueMs = Date.parse(workOrder.target_due_at);
  if (Number.isNaN(dueMs)) {
    return "none";
  }
  const remainingMs = dueMs - now.getTime();
  if (remainingMs < 0) {
    return "breached";
  }
  if (remainingMs <= SLA_AT_RISK_MINUTES * 60_000) {
    return "at-risk";
  }
  return "on-track";
}
