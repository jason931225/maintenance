import { FilePlus2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type {
  CreateInternalTicketRequest,
  SupportTicketCategory,
  SupportTicketDetail as SupportTicketDetailModel,
  SupportTicketOrigin,
  SupportTicketPriority,
  SupportTicketStatus,
  SupportTicketSummary,
} from "../api/types";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Select } from "../components/ui/select";
import { PageHeader } from "../components/shell/PageHeader";
import { hasAnyRole, ROLES } from "../components/shell/nav";
import { RefreshButton } from "../components/shell/RefreshButton";
import { PageEmpty } from "../components/states/PageEmpty";
import { PageError } from "../components/states/PageError";
import { useActiveBranchId, useAuth } from "../context/auth";
import { CreateTicketForm } from "../features/support/CreateTicketForm";
import { SupportTicketDetail } from "../features/support/SupportTicketDetail";
import { SupportTicketList } from "../features/support/SupportTicketList";
import {
  categoryLabel,
  originLabel,
  priorityLabel,
  statusLabel,
  SUPPORT_CATEGORIES,
  SUPPORT_ORIGINS,
  SUPPORT_PRIORITIES,
  SUPPORT_STATUSES,
} from "../features/support/support-format";
import { ko } from "../i18n/ko";

// Mirrors the server-side default list cap; a full page implies more rows.
const PAGE_SIZE = 50;

interface Filters {
  status: SupportTicketStatus | "";
  priority: SupportTicketPriority | "";
  category: SupportTicketCategory | "";
  origin: SupportTicketOrigin | "";
  includeUntriaged: boolean;
}

const emptyFilters: Filters = {
  status: "",
  priority: "",
  category: "",
  origin: "",
  includeUntriaged: true,
};

type ReadState = "idle" | "loading" | "error";

export function SupportPage() {
  const { api, session } = useAuth();
  const branchId = useActiveBranchId();
  const currentUserId = session?.user_id;
  // Ticket triage (assign/claim + status transitions) maps to the backend
  // AssigneeManage feature, which is ADMIN/SUPER_ADMIN only. Mechanics can read
  // and comment but never claim, so the triage controls are hidden from them.
  const canAssign = hasAnyRole(session?.roles, [ROLES.ADMIN, ROLES.SUPER_ADMIN]);
  // Posting a comment maps to the backend WorkOrderStart feature (Allow):
  // MECHANIC / ADMIN / SUPER_ADMIN. A receptionist (Limited) can read the thread
  // but the composer is hidden so it never 403s on submit.
  const canComment = hasAnyRole(session?.roles, [
    ROLES.MECHANIC,
    ROLES.ADMIN,
    ROLES.SUPER_ADMIN,
  ]);

  const [tickets, setTickets] = useState<SupportTicketSummary[]>([]);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [listState, setListState] = useState<ReadState>("loading");

  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [detail, setDetail] = useState<SupportTicketDetailModel | undefined>(
    undefined,
  );
  const [detailState, setDetailState] = useState<ReadState>("idle");
  // Wall-clock stamped each time the list loads, so SLA badges are computed
  // against a stable value rather than an impure call during render.
  const [nowMs, setNowMs] = useState(0);
  // A full page means there may be more rows behind the server-side cap.
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const queryFilters = useCallback(
    () => ({
      status: filters.status || undefined,
      priority: filters.priority || undefined,
      category: filters.category || undefined,
      origin: filters.origin || undefined,
      include_untriaged: filters.includeUntriaged,
      limit: PAGE_SIZE,
    }),
    [filters],
  );

  const loadTickets = useCallback(async () => {
    setListState("loading");
    const response = await api
      .GET("/api/v1/support/tickets", { params: { query: queryFilters() } })
      .catch(() => undefined);
    if (!response?.data) {
      setListState("error");
      return;
    }
    setTickets(response.data);
    setHasMore(response.data.length === PAGE_SIZE);
    setNowMs(Date.now());
    setListState("idle");
  }, [api, queryFilters]);

  // Append the next keyset page (cursor = the last loaded ticket id).
  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    const cursor = tickets.at(-1)?.id;
    const response = await api
      .GET("/api/v1/support/tickets", {
        params: { query: { ...queryFilters(), cursor } },
      })
      .catch(() => undefined);
    setLoadingMore(false);
    if (!response?.data) return;
    setTickets((prev) => [...prev, ...response.data]);
    setHasMore(response.data.length === PAGE_SIZE);
  }, [api, queryFilters, tickets]);

  useEffect(() => {
    void Promise.resolve().then(loadTickets);
  }, [loadTickets]);

  // Keep SLA (overdue / due-soon) badges honest on an always-open ops board by
  // re-stamping the clock periodically (the load-time stamp would go stale).
  useEffect(() => {
    const id = window.setInterval(() => {
      setNowMs(Date.now());
    }, 60_000);
    return () => {
      window.clearInterval(id);
    };
  }, []);

  const loadDetail = useCallback(
    async (id: string) => {
      setDetailState("loading");
      const response = await api
        .GET("/api/v1/support/tickets/{id}", {
          params: { path: { id } },
        })
        .catch(() => undefined);
      if (!response?.data) {
        setDetailState("error");
        return;
      }
      setDetail(response.data);
      setDetailState("idle");
    },
    [api],
  );

  useEffect(() => {
    // When nothing is selected the create form is shown instead, so any stale
    // detail is never rendered — no synchronous clearing needed here.
    if (!selectedId) {
      return;
    }
    void Promise.resolve().then(() => loadDetail(selectedId));
  }, [selectedId, loadDetail]);

  async function createTicket(
    request: CreateInternalTicketRequest,
  ): Promise<SupportTicketSummary> {
    const response = await api.POST("/api/v1/support/tickets", {
      body: request,
    });
    if (!response.data) {
      throw new Error("createTicket response missing data");
    }
    return response.data;
  }

  async function transitionTicket(to: SupportTicketStatus): Promise<void> {
    if (!selectedId) return;
    const response = await api.POST(
      "/api/v1/support/tickets/{id}/transition",
      { params: { path: { id: selectedId } }, body: { to_status: to } },
    );
    if (!response.data) {
      throw new Error("transition failed");
    }
    await Promise.all([loadDetail(selectedId), loadTickets()]);
  }

  async function addComment(
    body: string,
    isInternalNote: boolean,
  ): Promise<void> {
    if (!selectedId) return;
    const response = await api.POST(
      "/api/v1/support/tickets/{id}/comments",
      {
        params: { path: { id: selectedId } },
        body: { body, is_internal_note: isInternalNote },
      },
    );
    if (!response.data) {
      throw new Error("addComment failed");
    }
    await loadDetail(selectedId);
  }

  async function assignSelf(): Promise<void> {
    if (!selectedId || !currentUserId || !branchId) return;
    const response = await api.POST("/api/v1/support/tickets/{id}/assign", {
      params: { path: { id: selectedId } },
      body: { assignee_user_id: currentUserId, branch_id: branchId },
    });
    if (!response.data) {
      throw new Error("assign failed");
    }
    await Promise.all([loadDetail(selectedId), loadTickets()]);
  }

  return (
    <>
      <PageHeader
        title={ko.support.title}
        description={ko.support.description}
        actions={
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setSelectedId(undefined);
              }}
            >
              <FilePlus2 aria-hidden="true" size={18} />
              {ko.support.createTitle}
            </Button>
            <RefreshButton
              onClick={() => {
                void loadTickets();
              }}
              isLoading={listState === "loading"}
            />
          </div>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
        <div className="grid gap-4">
          <FilterBar filters={filters} onChange={setFilters} />
          {listState === "error" ? (
            <PageError onRetry={() => { void loadTickets(); }} />
          ) : null}
          <SupportTicketList
            tickets={tickets}
            selectedId={selectedId}
            isLoading={listState === "loading"}
            nowMs={nowMs}
            onSelect={setSelectedId}
            hasMore={hasMore}
            isLoadingMore={loadingMore}
            onLoadMore={() => {
              void loadMore();
            }}
          />
        </div>

        <div className="grid gap-4">
          {selectedId === undefined ? (
            branchId ? (
              <CreateTicketForm
                branchId={branchId}
                onCreate={createTicket}
                onCreated={(ticket) => {
                  void loadTickets();
                  setSelectedId(ticket.id);
                }}
              />
            ) : (
              <PageEmpty message={ko.common.noBranch} />
            )
          ) : detailState === "loading" ? (
            <Card>
              <p role="status" className="text-sm font-medium text-slate-700">
                {ko.common.loading}
              </p>
            </Card>
          ) : detailState === "error" || !detail ? (
            <PageError
              onRetry={() => {
                if (selectedId) void loadDetail(selectedId);
              }}
            />
          ) : (
            <SupportTicketDetail
              detail={detail}
              currentUserId={currentUserId}
              canAssign={canAssign}
              canComment={canComment}
              onTransition={transitionTicket}
              onAddComment={addComment}
              onAssignSelf={assignSelf}
            />
          )}
        </div>
      </div>
    </>
  );
}

function FilterBar({
  filters,
  onChange,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
}) {
  return (
    <Card className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <FilterSelect
          label={ko.support.filters.status}
          value={filters.status}
          onChange={(value) => {
            onChange({ ...filters, status: value as Filters["status"] });
          }}
          options={SUPPORT_STATUSES.map((v) => ({ value: v, label: statusLabel(v) }))}
        />
        <FilterSelect
          label={ko.support.filters.priority}
          value={filters.priority}
          onChange={(value) => {
            onChange({ ...filters, priority: value as Filters["priority"] });
          }}
          options={SUPPORT_PRIORITIES.map((v) => ({
            value: v,
            label: priorityLabel(v),
          }))}
        />
        <FilterSelect
          label={ko.support.filters.category}
          value={filters.category}
          onChange={(value) => {
            onChange({ ...filters, category: value as Filters["category"] });
          }}
          options={SUPPORT_CATEGORIES.map((v) => ({
            value: v,
            label: categoryLabel(v),
          }))}
        />
        <FilterSelect
          label={ko.support.filters.origin}
          value={filters.origin}
          onChange={(value) => {
            onChange({ ...filters, origin: value as Filters["origin"] });
          }}
          options={SUPPORT_ORIGINS.map((v) => ({ value: v, label: originLabel(v) }))}
        />
      </div>
      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          className="size-4 rounded border-slate-300"
          checked={filters.includeUntriaged}
          onChange={(event) => {
            onChange({ ...filters, includeUntriaged: event.currentTarget.checked });
          }}
        />
        {ko.support.filters.includeUntriaged}
      </label>
    </Card>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const id = `support-filter-${label}`;
  return (
    <div className="grid gap-1">
      <label className="text-xs font-semibold text-slate-600" htmlFor={id}>
        {label}
      </label>
      <Select
        id={id}
        value={value}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
      >
        <option value="">{ko.support.filters.all}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    </div>
  );
}
