import type { SupportTicketSummary } from "../../api/types";
import { Badge } from "../../components/ui/badge";
import { Card } from "../../components/ui/card";
import { LoadMoreButton } from "../../components/shell/LoadMoreButton";
import { objDrag } from "../../console/window";
import { ko } from "../../i18n/ko";
import { formatListCount, safeLabel } from "../../lib/utils";
import { sloPosture, type SloRules } from "./slo-settings";
import {
  categoryLabel,
  formatDateTime,
  originLabel,
  priorityBadgeClass,
  priorityLabel,
  sloPostureBadgeClass,
  statusBadgeClass,
  statusLabel,
  ticketCode,
} from "./support-format";
import { supportSloStrings } from "./supportslo-strings";

interface SupportTicketListProps {
  tickets: SupportTicketSummary[];
  selectedId?: string;
  isLoading?: boolean;
  /** Epoch millis used to classify SLO posture; injected for deterministic tests. */
  nowMs: number;
  /** ACTIVE SLO setting rules — chips/timers derive from these (§4-25-⑥). */
  sloRules: SloRules;
  onSelect: (id: string) => void;
  /** True when a full page was returned, so more rows may exist behind the cap. */
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
  /** Unpaged total matching the current filters, reported by the API. */
  total?: number;
}

export function SupportTicketList({
  tickets,
  selectedId,
  isLoading = false,
  nowMs,
  sloRules,
  onSelect,
  hasMore = false,
  isLoadingMore = false,
  onLoadMore,
  total,
}: SupportTicketListProps) {
  return (
    <Card className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-ink">
          {ko.support.listTitle}
        </h2>
        <Badge>
          {total !== undefined
            ? formatListCount(total)
            : formatListCount(tickets.length, { mayHaveMore: hasMore })}
        </Badge>
      </div>

      {tickets.length === 0 ? (
        isLoading ? (
          <p role="status" className="text-sm font-medium text-steel">
            {ko.common.loading}
          </p>
        ) : (
          <p className="rounded-md border border-dashed border-line p-4 text-sm text-steel">
            {ko.support.empty}
          </p>
        )
      ) : (
        <ul className="grid gap-2">
          {tickets.map((ticket) => {
            const slo = sloPosture(ticket, sloRules, nowMs);
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
                      ? "border-ink bg-muted-panel"
                      : "border-line hover:bg-muted-panel"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      className="bg-white font-mono"
                      title={ko.console.window.dragRefOf(ticket.title)}
                      {...objDrag(ticketCode(ticket.id), ticket.title)}
                    >
                      {ticketCode(ticket.id)}
                    </Badge>
                    <Badge className={priorityBadgeClass(ticket.priority)}>
                      {priorityLabel(ticket.priority)}
                    </Badge>
                    <Badge className={statusBadgeClass(ticket.status)}>
                      {statusLabel(ticket.status)}
                    </Badge>
                    <Badge>{originLabel(ticket.origin)}</Badge>
                    {slo === "overdue" || slo === "dueSoon" ? (
                      <Badge className={sloPostureBadgeClass(slo)}>
                        {supportSloStrings().posture[slo]}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="font-semibold text-ink">{ticket.title}</p>
                  <p className="text-sm text-steel">
                    {categoryLabel(ticket.category)}
                    {" · "}
                    {ko.support.assignee}:{" "}
                    {ticket.assignee_user_id
                      ? safeLabel(ticket.assignee_name)
                      : ko.support.unassigned}
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
        <LoadMoreButton
          onClick={onLoadMore}
          isLoading={isLoadingMore}
          loaded={tickets.length}
          total={total}
        />
      ) : null}
    </Card>
  );
}
