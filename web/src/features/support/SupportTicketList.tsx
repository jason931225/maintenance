import type { SupportTicketSummary } from "../../api/types";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { ko } from "../../i18n/ko";
import {
  categoryLabel,
  formatDateTime,
  originLabel,
  priorityBadgeClass,
  priorityLabel,
  slaState,
  statusBadgeClass,
  statusLabel,
} from "./support-format";

interface SupportTicketListProps {
  tickets: SupportTicketSummary[];
  selectedId?: string;
  isLoading?: boolean;
  /** Epoch millis used to classify SLA posture; injected for deterministic tests. */
  nowMs: number;
  onSelect: (id: string) => void;
  /** True when a full page was returned, so more rows may exist behind the cap. */
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
}

export function SupportTicketList({
  tickets,
  selectedId,
  isLoading = false,
  nowMs,
  onSelect,
  hasMore = false,
  isLoadingMore = false,
  onLoadMore,
}: SupportTicketListProps) {
  return (
    <Card className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-slate-950">
          {ko.support.listTitle}
        </h2>
        <Badge>{tickets.length}</Badge>
      </div>

      {tickets.length === 0 ? (
        isLoading ? (
          <p role="status" className="text-sm font-medium text-slate-700">
            {ko.common.loading}
          </p>
        ) : (
          <p className="rounded-md border border-dashed border-slate-300 p-4 text-sm text-slate-600">
            {ko.support.empty}
          </p>
        )
      ) : (
        <ul className="grid gap-2">
          {tickets.map((ticket) => {
            const sla = slaState(ticket.due_at, ticket.status, nowMs);
            const selected = ticket.id === selectedId;
            return (
              <li key={ticket.id}>
                <button
                  type="button"
                  aria-current={selected ? "true" : undefined}
                  onClick={() => {
                    onSelect(ticket.id);
                  }}
                  className={`grid w-full gap-2 rounded-md border p-3 text-left transition-colors ${
                    selected
                      ? "border-slate-950 bg-slate-50"
                      : "border-slate-200 hover:bg-slate-50"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge className={priorityBadgeClass(ticket.priority)}>
                      {priorityLabel(ticket.priority)}
                    </Badge>
                    <Badge className={statusBadgeClass(ticket.status)}>
                      {statusLabel(ticket.status)}
                    </Badge>
                    <Badge>{originLabel(ticket.origin)}</Badge>
                    {sla === "overdue" ? (
                      <Badge className="border-red-300 bg-red-50 text-red-900">
                        {ko.support.overdue}
                      </Badge>
                    ) : sla === "dueSoon" ? (
                      <Badge className="border-amber-300 bg-amber-50 text-amber-900">
                        {ko.support.dueSoon}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="font-semibold text-slate-950">{ticket.title}</p>
                  <p className="text-sm text-slate-600">
                    {categoryLabel(ticket.category)}
                    {" · "}
                    {ko.support.createdAt} {formatDateTime(ticket.created_at)}
                  </p>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {hasMore && onLoadMore ? (
        <Button
          type="button"
          variant="secondary"
          className="justify-self-center"
          disabled={isLoadingMore}
          onClick={onLoadMore}
        >
          {isLoadingMore ? ko.support.loadingMore : ko.support.loadMore}
        </Button>
      ) : null}
    </Card>
  );
}
