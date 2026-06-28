import type { WorkOrderListItem } from "../../api/types";
import { Badge } from "../../components/ui/badge";
import { ko } from "../../i18n/ko";
import { toneBadgeClass } from "../../lib/semantic";
import { slaStatus, type SlaStatus } from "./sla";

const STATUS_CLASS: Record<Exclude<SlaStatus, "none">, string> = {
  "on-track": toneBadgeClass("success"),
  "at-risk": toneBadgeClass("warning"),
  breached: toneBadgeClass("danger"),
};

const STATUS_LABEL: Record<Exclude<SlaStatus, "none">, string> = {
  "on-track": ko.dispatch.sla.onTrack,
  "at-risk": ko.dispatch.sla.atRisk,
  breached: ko.dispatch.sla.breached,
};

interface SlaBadgeProps {
  workOrder: Pick<WorkOrderListItem, "status" | "target_due_at">;
  /** Override the clock; injected by tests for deterministic classification. */
  now?: Date;
}

/**
 * SLA-standing badge (on-track / at-risk / breached) for a work order. Renders
 * nothing when the order has no applicable SLA (no target due, or already
 * closed out). Labels are localized via ko.dispatch.sla.
 */
export function SlaBadge({ workOrder, now }: SlaBadgeProps) {
  const status = slaStatus(workOrder, now);
  if (status === "none") {
    return null;
  }
  return (
    <Badge className={STATUS_CLASS[status]} aria-label={ko.dispatch.sla.label}>
      {STATUS_LABEL[status]}
    </Badge>
  );
}
