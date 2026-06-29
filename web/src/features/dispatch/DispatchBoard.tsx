import { Clock3, Send, UserRound } from "lucide-react";

import type { WorkOrderListItem } from "../../api/types";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { ko } from "../../i18n/ko";
import { formatKoreanDateTime } from "../../lib/datetime";
import { priorityClass, priorityLabel, safeLabel } from "../../lib/utils";
import { SlaBadge } from "./SlaBadge";

type WorkOrderStatus = WorkOrderListItem["status"];

interface DispatchBoardProps {
  workOrders: WorkOrderListItem[];
  /** The id submitted on assign — never rendered to the user. */
  selectedMechanicId: string;
  /**
   * The acting mechanic's human display name, shown in the board header. Falls
   * back to a generic label via `safeLabel`; the raw `selectedMechanicId` UUID
   * is never surfaced.
   */
  selectedMechanicName?: string;
  isLoading?: boolean;
  onAssignWorkOrder: (
    workOrderId: string,
    mechanicId: string,
  ) => Promise<boolean>;
  /** Manager-only: open the dispatch controls for a work order. */
  onSelectWorkOrder?: (workOrderId: string) => void;
  selectedWorkOrderId?: string;
}

const groups: {
  key: string;
  label: string;
  helper: string;
  statuses: WorkOrderStatus[];
}[] = [
  {
    key: "received",
    label: ko.dispatch.groups.received,
    helper: ko.dispatch.groupHints.received,
    statuses: ["RECEIVED", "UNASSIGNED"],
  },
  {
    key: "assigned",
    label: ko.dispatch.groups.assigned,
    helper: ko.dispatch.groupHints.assigned,
    statuses: ["ASSIGNED"],
  },
  {
    key: "active",
    label: ko.dispatch.groups.active,
    helper: ko.dispatch.groupHints.active,
    statuses: ["IN_PROGRESS", "TEMPORARY_ACTION"],
  },
  {
    key: "review",
    label: ko.dispatch.groups.review,
    helper: ko.dispatch.groupHints.review,
    statuses: ["REPORT_SUBMITTED", "ADMIN_REVIEW"],
  },
  {
    key: "blocked",
    label: ko.dispatch.groups.blocked,
    helper: ko.dispatch.groupHints.blocked,
    statuses: ["ON_HOLD", "DELAYED", "PART_WAITING", "EQUIPMENT_IN_USE", "REVISIT_REQUIRED"],
  },
  {
    key: "done",
    label: ko.dispatch.groups.done,
    helper: ko.dispatch.groupHints.done,
    statuses: ["FINAL_COMPLETED", "REJECTED", "ARCHIVED", "CANCELLED"],
  },
] as const;

function equipmentLabel(workOrder: WorkOrderListItem): string {
  return [
    workOrder.equipment.equipment_no,
    workOrder.equipment.management_no,
  ]
    .filter(Boolean)
    .join(" · ");
}

function assignmentLabel(workOrder: WorkOrderListItem): string {
  if (workOrder.assignments.length === 0) return ko.dispatch.unassigned;
  return workOrder.assignments
    .map((assignment) => assignment.mechanic_name)
    .join(", ");
}

function groupItems(workOrders: WorkOrderListItem[], statuses: WorkOrderStatus[]) {
  return workOrders.filter((workOrder) => statuses.includes(workOrder.status));
}

export function DispatchBoard({
  workOrders,
  selectedMechanicId,
  selectedMechanicName,
  isLoading = false,
  onAssignWorkOrder,
  onSelectWorkOrder,
  selectedWorkOrderId,
}: DispatchBoardProps) {
  const urgentCount = workOrders.filter((workOrder) => workOrder.priority === "P1").length;
  const unassignedCount = workOrders.filter(
    (workOrder) =>
      (workOrder.status === "RECEIVED" || workOrder.status === "UNASSIGNED") &&
      workOrder.assignments.length === 0,
  ).length;
  const reviewCount = groupItems(workOrders, ["REPORT_SUBMITTED", "ADMIN_REVIEW"]).length;

  return (
    <Card className="grid gap-4">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
        <div>
          <h2 className="text-lg font-semibold text-ink">
            {ko.dispatch.boardTitle}
          </h2>
          <p className="mt-1 text-sm text-steel">
            {ko.dispatch.boardDescription}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 lg:justify-end">
          <Badge className="border-tone-danger-border bg-tone-danger-bg text-tone-danger-text">
            {ko.dispatch.boardStats.urgent}: {urgentCount}
          </Badge>
          <Badge>
            {ko.dispatch.boardStats.unassigned}: {unassignedCount}
          </Badge>
          <Badge>
            {ko.dispatch.boardStats.review}: {reviewCount}
          </Badge>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-muted-panel px-3 py-2">
        <p className="text-sm font-medium text-ink">
          {ko.dispatch.selectedMechanic}: {safeLabel(selectedMechanicName)}
        </p>
        <p className="text-xs text-steel">{ko.dispatch.boardHint}</p>
      </div>
      {workOrders.length === 0 ? (
        isLoading ? (
          <p role="status" className="text-sm font-medium text-steel">
            {ko.common.loading}
          </p>
        ) : (
          <p className="rounded-md border border-dashed border-line p-4 text-sm text-steel">
            {ko.dispatch.empty}
          </p>
        )
      ) : null}
      <div
        className="flex gap-3 overflow-x-auto pb-2"
        role="list"
        aria-label={ko.dispatch.boardTitle}
      >
        {groups.map((group) => {
          const items = groupItems(workOrders, group.statuses);
          return (
            <section
              key={group.key}
              className="min-h-64 min-w-[18rem] max-w-[22rem] flex-[1_0_18rem] rounded-lg border border-line bg-muted-panel p-3"
              role="listitem"
            >
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-ink">
                    {group.label} {items.length}
                  </h3>
                  <p className="mt-1 text-xs text-steel">{group.helper}</p>
                </div>
                <Badge>{items.length}</Badge>
              </div>
              <div className="grid gap-2">
                {items.length === 0 ? (
                  <p className="rounded-md border border-dashed border-line bg-white/70 p-3 text-sm text-steel">
                    {ko.dispatch.groupEmpty}
                  </p>
                ) : null}
                {items.map((workOrder) => (
                  <article
                    key={workOrder.id}
                    className={`grid min-w-0 gap-3 overflow-hidden rounded-lg border bg-white p-3 shadow-sm ${
                      selectedWorkOrderId === workOrder.id
                        ? "border-brand-teal ring-2 ring-brand-teal/20"
                        : "border-line"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="min-w-0 break-all font-semibold tabular-nums text-ink">
                        {workOrder.request_no}
                      </p>
                      <Badge className={priorityClass(workOrder.priority)}>
                        {priorityLabel(workOrder.priority)}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge>
                        {ko.status[workOrder.status]}
                      </Badge>
                      <SlaBadge workOrder={workOrder} />
                    </div>
                    <div className="grid min-w-0 gap-1">
                      <p className="min-w-0 break-words text-sm font-semibold text-ink">
                        {equipmentLabel(workOrder)}
                      </p>
                      <p className="min-w-0 break-words text-sm text-steel">
                        {workOrder.customer.name} / {workOrder.site.name}
                      </p>
                      <p className="min-w-0 break-words text-sm text-steel">
                        {workOrder.equipment.model ?? ko.common.unknown}
                      </p>
                    </div>
                    <div className="grid gap-1 rounded-md bg-muted-panel px-3 py-2 text-xs text-steel">
                      <span className="inline-flex items-center gap-1">
                        <UserRound aria-hidden="true" size={14} />
                        {assignmentLabel(workOrder)}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Clock3 aria-hidden="true" size={14} />
                        {ko.dispatch.targetDueAt}:{" "}
                        {workOrder.target_due_at
                          ? formatKoreanDateTime(workOrder.target_due_at)
                          : ko.common.notSet}
                      </span>
                    </div>
                    {workOrder.status === "RECEIVED" || workOrder.status === "UNASSIGNED" ? (
                      <Button
                        className="w-full whitespace-normal text-center"
                        variant="secondary"
                        size="sm"
                        aria-label={`${workOrder.request_no} ${ko.dispatch.assign}`}
                        onClick={() => {
                          void onAssignWorkOrder(
                            workOrder.id,
                            selectedMechanicId,
                          );
                        }}
                      >
                        <Send aria-hidden="true" size={16} />
                        {ko.dispatch.assign}
                      </Button>
                    ) : null}
                    {onSelectWorkOrder ? (
                      <Button
                        className="w-full whitespace-normal text-center"
                        variant="ghost"
                        aria-label={`${workOrder.request_no} ${ko.dispatch.controls.title}`}
                        aria-pressed={selectedWorkOrderId === workOrder.id}
                        onClick={() => {
                          onSelectWorkOrder(workOrder.id);
                        }}
                      >
                        {ko.dispatch.controls.title}
                      </Button>
                    ) : null}
                  </article>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </Card>
  );
}
