import { Send } from "lucide-react";

import type { WorkOrderListItem } from "../../api/types";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { ko } from "../../i18n/ko";

type WorkOrderStatus = WorkOrderListItem["status"];

interface DispatchBoardProps {
  workOrders: WorkOrderListItem[];
  selectedMechanicId: string;
  onAssignWorkOrder: (workOrderId: string, mechanicId: string) => Promise<void>;
}

const groups: {
  key: string;
  label: string;
  statuses: WorkOrderStatus[];
}[] = [
  {
    key: "received",
    label: ko.dispatch.groups.received,
    statuses: ["RECEIVED", "UNASSIGNED"],
  },
  {
    key: "assigned",
    label: ko.dispatch.groups.assigned,
    statuses: ["ASSIGNED"],
  },
  {
    key: "active",
    label: ko.dispatch.groups.active,
    statuses: ["IN_PROGRESS", "TEMPORARY_ACTION"],
  },
  {
    key: "review",
    label: ko.dispatch.groups.review,
    statuses: ["REPORT_SUBMITTED", "ADMIN_REVIEW"],
  },
  {
    key: "blocked",
    label: ko.dispatch.groups.blocked,
    statuses: ["ON_HOLD", "DELAYED", "PART_WAITING", "EQUIPMENT_IN_USE", "REVISIT_REQUIRED"],
  },
  {
    key: "done",
    label: ko.dispatch.groups.done,
    statuses: ["FINAL_COMPLETED", "REJECTED", "ARCHIVED", "CANCELLED"],
  },
] as const;

export function DispatchBoard({
  workOrders,
  selectedMechanicId,
  onAssignWorkOrder,
}: DispatchBoardProps) {
  return (
    <Card className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-slate-950">{ko.dispatch.title}</h2>
        <p className="text-sm text-slate-600">
          {ko.dispatch.selectedMechanic}: {selectedMechanicId}
        </p>
      </div>
      {workOrders.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 p-4 text-sm text-slate-600">
          {ko.dispatch.empty}
        </p>
      ) : null}
      <div className="grid gap-3 lg:grid-cols-3 xl:grid-cols-6">
        {groups.map((group) => {
          const items = workOrders.filter((workOrder) =>
            group.statuses.includes(workOrder.status),
          );
          return (
            <section
              key={group.key}
              className="min-h-40 rounded-md border border-slate-200 bg-slate-50 p-3"
            >
              <h3 className="mb-3 text-sm font-semibold text-slate-800">
                {group.label}
              </h3>
              <div className="grid gap-2">
                {items.map((workOrder) => (
                  <article
                    key={workOrder.id}
                    draggable
                    className="rounded-md border border-slate-200 bg-white p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-semibold text-slate-950">
                        {workOrder.request_no}
                      </p>
                      <Badge className={priorityClass(workOrder.priority)}>
                        {workOrder.priority}
                      </Badge>
                    </div>
                    <p className="mt-2 text-sm text-slate-600">
                      {ko.status[workOrder.status]}
                    </p>
                    <p className="mt-1 text-sm text-slate-700">
                      {workOrder.equipment.model ?? ko.common.unknown} /{" "}
                      {workOrder.customer.name}
                    </p>
                    {workOrder.status === "RECEIVED" || workOrder.status === "UNASSIGNED" ? (
                      <Button
                        className="mt-3 w-full"
                        variant="secondary"
                        onClick={() => {
                          void onAssignWorkOrder(
                            workOrder.id,
                            selectedMechanicId,
                          );
                        }}
                      >
                        <Send aria-hidden="true" size={16} />
                        {workOrder.request_no} {ko.dispatch.assign}
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

function priorityClass(priority: WorkOrderListItem["priority"]) {
  switch (priority) {
    case "P1":
      return "border-red-300 bg-red-50 text-red-800";
    case "P2":
      return "border-amber-300 bg-amber-50 text-amber-900";
    case "P3":
      return "border-emerald-300 bg-emerald-50 text-emerald-800";
    case "OUTSOURCE":
      return "border-sky-300 bg-sky-50 text-sky-800";
    case "UNSET":
      return "border-slate-300 bg-slate-50 text-slate-700";
  }
}
