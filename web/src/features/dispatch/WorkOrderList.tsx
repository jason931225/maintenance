import { Link } from "react-router";

import type { WorkOrderListItem } from "../../api/types";
import { Badge } from "../../components/ui/badge";
import { Card } from "../../components/ui/card";
import { LoadMoreButton } from "../../components/shell/LoadMoreButton";
import { ko } from "../../i18n/ko";
import { formatKoreanDateTime } from "../../lib/datetime";
import { setDraggedObject } from "../../lib/objectDrag";
import { workOrderCode } from "../../lib/objectRegistry";
import { formatListCount, priorityClass, priorityLabel, safeLabel } from "../../lib/utils";
import { SlaBadge } from "./SlaBadge";

interface WorkOrderListProps {
  workOrders: WorkOrderListItem[];
  isLoading?: boolean;
  /** Total work orders available; the badge shows loaded-of-total when set. */
  total?: number;
  /** Fetches and appends the next page (omitted when not paginated). */
  onLoadMore?: () => void;
  isLoadingMore?: boolean;
  /** Override for the empty state (e.g. "no search matches" vs "no orders"). */
  emptyMessage?: string;
}

export function WorkOrderList({
  workOrders,
  isLoading = false,
  total,
  onLoadMore,
  isLoadingMore = false,
  emptyMessage,
}: WorkOrderListProps) {
  const hasMore = total !== undefined && workOrders.length < total;
  return (
    <Card className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-ink">
          {ko.dispatch.listTitle}
        </h2>
        <Badge>{formatListCount(workOrders.length, { total })}</Badge>
      </div>
      {workOrders.length === 0 ? (
        isLoading ? (
          <p role="status" className="text-sm font-medium text-steel">
            {ko.common.loading}
          </p>
        ) : (
          <p className="rounded-md border border-dashed border-line p-4 text-sm text-steel">
            {emptyMessage ?? ko.dispatch.empty}
          </p>
        )
      ) : (
        <div className="grid gap-2">
          {workOrders.map((workOrder) => (
            <article
              key={workOrder.id}
              // Drag source for the token-grammar composer (UI-M2a): dropping a
              // row into a composer inserts a resolving !WO- chip. Inner links
              // keep their own click; a drag from a link is a browser link-drag
              // (no object MIME) — dragging the row body carries the object.
              draggable
              onDragStart={(event) => {
                setDraggedObject(event.dataTransfer, {
                  kind: "workOrder",
                  code: workOrderCode(workOrder.request_no),
                  id: workOrder.id,
                  label: `${safeLabel(workOrder.customer.name)} · ${safeLabel(workOrder.equipment.model, workOrder.equipment.equipment_no)}`,
                });
              }}
              className="grid gap-3 rounded-md border border-line p-3 md:grid-cols-[minmax(8rem,1fr)_minmax(10rem,1.2fr)_auto]"
            >
              <div>
                {/* Deep-link to the read-only detail view — reachable by any
                    WorkOrderReadAll holder (every role), not just managers. */}
                <Link
                  to={`/work-orders/${workOrder.id}`}
                  className="font-semibold text-ink underline-offset-2 hover:underline focus-visible:underline"
                >
                  {workOrder.request_no}
                </Link>
                <p className="text-sm text-steel">
                  {ko.status[workOrder.status]}
                </p>
                <Link
                  to={`/dispatch?around_work_order_id=${encodeURIComponent(workOrder.id)}`}
                  className="mt-1 inline-flex text-xs font-medium text-brand-teal underline-offset-2 hover:underline focus-visible:underline"
                >
                  {ko.dispatch.searchAround}
                </Link>
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
      {hasMore && onLoadMore ? (
        <LoadMoreButton
          onClick={onLoadMore}
          isLoading={isLoadingMore}
          loaded={workOrders.length}
          total={total}
        />
      ) : null}
    </Card>
  );
}
