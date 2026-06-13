import type { WorkOrderListItem } from "../../api/types";
import { Badge } from "../../components/ui/badge";
import { Card } from "../../components/ui/card";
import { ko } from "../../i18n/ko";

interface WorkOrderListProps {
  workOrders: WorkOrderListItem[];
  isLoading?: boolean;
}

export function WorkOrderList({
  workOrders,
  isLoading = false,
}: WorkOrderListProps) {
  return (
    <Card className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-slate-950">
          {ko.dispatch.listTitle}
        </h2>
        <Badge>{workOrders.length}</Badge>
      </div>
      {workOrders.length === 0 ? (
        isLoading ? (
          <p role="status" className="text-sm font-medium text-slate-700">
            {ko.common.loading}
          </p>
        ) : (
          <p className="rounded-md border border-dashed border-slate-300 p-4 text-sm text-slate-600">
            {ko.dispatch.empty}
          </p>
        )
      ) : (
        <div className="grid gap-2">
          {workOrders.map((workOrder) => (
            <article
              key={workOrder.id}
              className="grid gap-3 rounded-md border border-slate-200 p-3 md:grid-cols-[minmax(8rem,1fr)_minmax(10rem,1.2fr)_auto]"
            >
              <div>
                <p className="font-semibold text-slate-950">
                  {workOrder.request_no}
                </p>
                <p className="text-sm text-slate-600">
                  {ko.status[workOrder.status]}
                </p>
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-800">
                  {workOrder.equipment.model ?? ko.common.unknown}
                </p>
                <p className="text-sm text-slate-600">
                  {workOrder.customer.name} / {workOrder.site.name}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 md:justify-end">
                <Badge>{workOrder.priority}</Badge>
                <span className="text-sm text-slate-600">
                  {ko.dispatch.targetDueAt}:{" "}
                  {formatIsoDateTime(workOrder.target_due_at)}
                </span>
              </div>
            </article>
          ))}
        </div>
      )}
    </Card>
  );
}

function formatIsoDateTime(value: string | null) {
  if (!value) {
    return ko.common.notSet;
  }

  return value.slice(0, 16).replace("T", " ");
}
