import type { WorkOrderListItem } from "../../api/types";
import { Badge } from "../../components/ui/badge";
import { Card } from "../../components/ui/card";
import { ko } from "../../i18n/ko";
import { formatKoreanDateTime } from "../../lib/datetime";
import { priorityClass, priorityLabel } from "../../lib/utils";
import { SlaBadge } from "./SlaBadge";

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
        <h2 className="text-lg font-semibold text-ink">
          {ko.dispatch.listTitle}
        </h2>
        <Badge>{workOrders.length}</Badge>
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
      ) : (
        <div className="grid gap-2">
          {workOrders.map((workOrder) => (
            <article
              key={workOrder.id}
              className="grid gap-3 rounded-md border border-line p-3 md:grid-cols-[minmax(8rem,1fr)_minmax(10rem,1.2fr)_auto]"
            >
              <div>
                <p className="font-semibold text-ink">
                  {workOrder.request_no}
                </p>
                <p className="text-sm text-steel">
                  {ko.status[workOrder.status]}
                </p>
              </div>
              <div>
                <p className="text-sm font-semibold text-steel">
                  {workOrder.equipment.model ?? ko.common.unknown}
                </p>
                <p className="text-sm text-steel">
                  {workOrder.customer.name} / {workOrder.site.name}
                </p>
                {workOrder.site_contact ? (
                  <p className="text-sm text-steel">
                    {ko.dispatch.siteContact}:{" "}
                    {workOrder.site_contact.name ?? ""}
                    {workOrder.site_contact.phone ? (
                      <a
                        className="ml-1 text-steel underline-offset-2 hover:underline"
                        href={`tel:${workOrder.site_contact.phone}`}
                      >
                        {workOrder.site_contact.phone}
                      </a>
                    ) : null}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2 md:justify-end">
                <Badge className={priorityClass(workOrder.priority)}>
                  {priorityLabel(workOrder.priority)}
                </Badge>
                <SlaBadge workOrder={workOrder} />
                <span className="text-sm text-steel">
                  {ko.dispatch.targetDueAt}:{" "}
                  {workOrder.target_due_at
                    ? formatKoreanDateTime(workOrder.target_due_at)
                    : ko.common.notSet}
                </span>
              </div>
            </article>
          ))}
        </div>
      )}
    </Card>
  );
}
