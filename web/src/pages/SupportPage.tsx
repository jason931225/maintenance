import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  CreateInternalTicketRequest,
  SupportTicketCategory,
  SupportTicketOrigin,
  SupportTicketPriority,
  SupportTicketStatus,
  SupportTicketSummary,
} from "../api/types";
import { Badge } from "../components/ui/badge";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { PageHeader } from "../components/shell/PageHeader";
import { hasAnyRole, ROLES } from "../components/shell/nav";
import { RefreshButton } from "../components/shell/RefreshButton";
import { PageEmpty } from "../components/states/PageEmpty";
import { PageError } from "../components/states/PageError";
import { useOptionalWindowManager } from "../console/window";
import { useActiveBranchId, useAuth } from "../context/auth";
import { CreateTicketForm } from "../features/support/CreateTicketForm";
import {
  defaultSloSettings,
  sloPosture,
  type SloSettingState,
} from "../features/support/slo-settings";
import { SloSettingsCard } from "../features/support/SloSettingsCard";
import { supportDeskStrings } from "../features/support/support-desk-strings";
import { SupportTicketList } from "../features/support/SupportTicketList";
import { SupportTicketPin } from "../features/support/SupportTicketPin";
import {
  categoryLabel,
  originLabel,
  priorityLabel,
  sloPostureBadgeClass,
  statusLabel,
  SUPPORT_CATEGORIES,
  SUPPORT_ORIGINS,
  SUPPORT_PRIORITIES,
  SUPPORT_STATUSES,
  ticketCode,
} from "../features/support/support-format";
import { supportSloStrings } from "../features/support/supportslo-strings";
import { ko } from "../i18n/ko";

// Mirrors the server-side default list cap; a full page implies more rows.
const PAGE_SIZE = 50;

interface Filters {
  status: SupportTicketStatus | "";
  priority: SupportTicketPriority | "";
  category: SupportTicketCategory | "";
  origin: SupportTicketOrigin | "";
  search: string;
  includeUntriaged: boolean;
}

const emptyFilters: Filters = {
  status: "",
  priority: "",
  category: "",
  origin: "",
  search: "",
  includeUntriaged: true,
};

type ReadState = "idle" | "loading" | "error";

/**
 * Stat-strip drill keys (§4-11: every stat filters the list, never a dead
 * number). Exported for reuse by the console screen composition
 * (screens/support/SupportBody), which drives the same real ticket data
 * through console-pure JSX (§4-18: one data model, two presentation layers —
 * this page predates the carbon-copy console's shadcn ban).
 */
export type Drill = "open" | "urgent" | "unassigned" | "resolved";

/** Shared pill-chip classes for stat drills and filter segments (≥44px target). */
function chipClass(pressed: boolean): string {
  return `inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-medium text-ink transition-colors ${
    pressed ? "border-ink bg-muted-panel" : "border-line hover:bg-muted-panel"
  }`;
}

export function SupportPage() {
  const { api, session } = useAuth();
  const branchId = useActiveBranchId();
  const windowManager = useOptionalWindowManager();
  const currentUserId = session?.user_id;
  // Ticket triage (assign/claim + status transitions) maps to the backend
  // AssigneeManage feature, which is ADMIN/SUPER_ADMIN only. Mechanics can read
  // and comment but never claim, so the triage controls are hidden from them.
  // The same 관리자 tier manages the SLO setting object (§4-25-⑦): 본인/팀장 see
  // the active targets read-only, 관리자 stages revisions (deny-by-omission).
  const canAssign = hasAnyRole(session?.roles, [
    ROLES.ADMIN,
    ROLES.SUPER_ADMIN,
  ]);
  // Posting a comment maps to the backend WorkOrderStart feature (Allow):
  // MECHANIC / ADMIN / SUPER_ADMIN. A receptionist (Limited) can read the thread
  // but the composer is hidden so it never 403s on submit.
  const canComment = hasAnyRole(session?.roles, [
    ROLES.MECHANIC,
    ROLES.ADMIN,
    ROLES.SUPER_ADMIN,
  ]);
  // The SLO setting is a governed ontology object, and the ontology read/write
  // API is RoleManage-gated (SUPER_ADMIN only). Any principal below RoleManage
  // 403s on the card's mount fetch, so — deny-by-omission — only the RoleManage
  // tier renders the card at all rather than firing a request it cannot make.
  const canManageSlo = hasAnyRole(session?.roles, [ROLES.SUPER_ADMIN]);

  const [tickets, setTickets] = useState<SupportTicketSummary[]>([]);
  // The SLO policy setting object — the ACTIVE revision drives every derived
  // timer/chip/stat below; edits stage a pendingRev (§3.9.0).
  // wire-pending: Phase C — GET /api/v1/ontology/instances?type=support_slo_setting
  const [sloSettings] = useState<SloSettingState>(defaultSloSettings);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [drill, setDrill] = useState<Drill | null>(null);
  const [listState, setListState] = useState<ReadState>("loading");

  // Fallback selection when no window manager wraps the page (unit mounts):
  // the pin panel renders inline instead of as the right pin.
  const [selectedId, setSelectedId] = useState<string>();
  // Wall-clock stamped each time the list loads, so SLA badges are computed
  // against a stable value rather than an impure call during render.
  const [nowMs, setNowMs] = useState(0);
  // The keyset cursor for the next page, or null on the last page.
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  // Unpaged total matching the current filters, reported by the API.
  const [total, setTotal] = useState<number>();
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
    [
      filters.status,
      filters.priority,
      filters.category,
      filters.origin,
      filters.includeUntriaged,
    ],
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
    setTickets(response.data.items);
    setNextCursor(response.data.next_cursor);
    setTotal(response.data.total);
    setNowMs(Date.now());
    setListState("idle");
  }, [api, queryFilters]);

  // Append the next keyset page using the cursor the API reported.
  const loadMore = useCallback(async () => {
    if (nextCursor === null) return;
    setLoadingMore(true);
    const response = await api
      .GET("/api/v1/support/tickets", {
        params: { query: { ...queryFilters(), cursor: nextCursor } },
      })
      .catch(() => undefined);
    setLoadingMore(false);
    if (!response?.data) return;
    setTickets((prev) => [...prev, ...response.data.items]);
    setNextCursor(response.data.next_cursor);
    setTotal(response.data.total);
  }, [api, queryFilters, nextCursor]);

  useEffect(() => {
    void Promise.resolve().then(loadTickets);
  }, [loadTickets]);

  // Keep SLO (overdue / due-soon) chips honest on an always-open ops board by
  // re-stamping the clock periodically (the load-time stamp would go stale).
  useEffect(() => {
    const id = window.setInterval(() => {
      setNowMs(Date.now());
    }, 60_000);
    return () => {
      window.clearInterval(id);
    };
  }, []);

  // The pin's mutation callback must survive filter changes without going
  // stale, so it reads the latest loadTickets through a ref.
  const loadTicketsRef = useRef(loadTickets);
  useEffect(() => {
    loadTicketsRef.current = loadTickets;
  }, [loadTickets]);
  const refreshList = useCallback(() => {
    void loadTicketsRef.current();
  }, []);

  const openTicket = useCallback(
    (ticket: Pick<SupportTicketSummary, "id" | "title">) => {
      if (!windowManager) {
        setSelectedId(ticket.id);
        return;
      }
      const code = ticketCode(ticket.id);
      const rules = sloSettings.active;
      windowManager.open({
        id: ticket.id,
        code,
        title: ticket.title,
        // ponytail: ACTIVE SLO rules captured at open — an approved revision
        // refreshes the pinned timer on reopen, which matches §3.9.0 staging.
        render: () => (
          <SupportTicketPin
            api={api}
            ticketId={ticket.id}
            code={code}
            currentUserId={currentUserId}
            branchId={branchId}
            canAssign={canAssign}
            canComment={canComment}
            sloRules={rules}
            onMutated={refreshList}
          />
        ),
      });
    },
    [
      windowManager,
      sloSettings.active,
      api,
      currentUserId,
      branchId,
      canAssign,
      canComment,
      refreshList,
    ],
  );

  const openTicketById = useCallback(
    (id: string) => {
      const ticket = tickets.find((item) => item.id === id);
      if (ticket) openTicket(ticket);
    },
    [tickets, openTicket],
  );

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

  const searchTerm = filters.search.trim();
  const visibleTickets = useMemo(() => {
    const searched = filterTickets(tickets, searchTerm);
    if (!drill) return searched;
    return searched.filter((ticket) => {
      switch (drill) {
        case "open":
          return ticket.status !== "RESOLVED" && ticket.status !== "CLOSED";
        case "urgent":
          return (
            ticket.priority === "URGENT" ||
            sloPosture(ticket, sloSettings.active, nowMs) === "overdue"
          );
        case "unassigned":
          return !ticket.assignee_user_id;
        case "resolved":
          return ticket.status === "RESOLVED" || ticket.status === "CLOSED";
      }
    });
  }, [tickets, searchTerm, drill, sloSettings.active, nowMs]);
  const supportStats = useMemo(
    () => buildSupportStats(tickets, nowMs, sloSettings.active),
    [nowMs, tickets, sloSettings.active],
  );
  // SLO violation = internal alert (never a penalty): open tickets past the
  // ACTIVE target surface as alert rows that escalate per the setting.
  const breachedTickets = useMemo(
    () =>
      tickets.filter(
        (ticket) => sloPosture(ticket, sloSettings.active, nowMs) === "overdue",
      ),
    [nowMs, tickets, sloSettings.active],
  );

  const clientFiltered = searchTerm.length > 0 || drill !== null;

  return (
    <>
      <PageHeader
        title={ko.support.title}
        actions={
          <RefreshButton
            onClick={() => {
              void loadTickets();
            }}
            isLoading={listState === "loading"}
          />
        }
      />

      <SupportCommandCenter
        stats={supportStats}
        drill={drill}
        onDrill={(key) => {
          setDrill((current) => (current === key ? null : key));
        }}
      />

      {breachedTickets.length > 0 ? (
        <SloBreachAlerts
          tickets={breachedTickets}
          settings={sloSettings}
          onSelect={openTicketById}
        />
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <div className="grid gap-4">
          <FilterChips filters={filters} onChange={setFilters} />
          {listState === "error" ? (
            <PageError
              onRetry={() => {
                void loadTickets();
              }}
            />
          ) : null}
          <SupportTicketList
            tickets={visibleTickets}
            selectedId={windowManager?.pinnedId ?? selectedId}
            isLoading={listState === "loading"}
            nowMs={nowMs}
            sloRules={sloSettings.active}
            onSelect={openTicketById}
            hasMore={!clientFiltered && nextCursor !== null}
            isLoadingMore={loadingMore}
            total={clientFiltered ? visibleTickets.length : total}
            onLoadMore={() => {
              void loadMore();
            }}
          />
        </div>

        <div className="grid content-start gap-4">
          {!windowManager && selectedId ? (
            <SupportTicketPin
              key={selectedId}
              api={api}
              ticketId={selectedId}
              code={ticketCode(selectedId)}
              currentUserId={currentUserId}
              branchId={branchId}
              canAssign={canAssign}
              canComment={canComment}
              sloRules={sloSettings.active}
              onMutated={refreshList}
            />
          ) : null}
          {branchId ? (
            <CreateTicketForm
              branchId={branchId}
              onCreate={createTicket}
              onCreated={(ticket) => {
                void loadTickets();
                openTicket(ticket);
              }}
            />
          ) : (
            <PageEmpty message={ko.common.noBranch} />
          )}
          {canManageSlo ? (
            <SloSettingsCard
              api={api}
              canManage={canManageSlo}
              actor={{
                id: currentUserId ?? "",
                name: session?.display_name ?? "",
              }}
            />
          ) : null}
        </div>
      </div>
    </>
  );
}

/**
 * §4-11 compact stat strip: one row, every stat is a drill button that filters
 * the ticket list (aria-pressed marks the active drill). The KPI/보고 links
 * stay as real cross-screen drills.
 */
function SupportCommandCenter({
  stats,
  drill,
  onDrill,
}: {
  stats: SupportStats;
  drill: Drill | null;
  onDrill: (key: Drill) => void;
}) {
  const D = supportDeskStrings();
  const items: { key: Drill; label: string; value: number }[] = [
    { key: "open", label: ko.support.command.open, value: stats.open },
    {
      key: "urgent",
      label: supportSloStrings().urgentOrBreached,
      value: stats.urgentOrBreached,
    },
    {
      key: "unassigned",
      label: ko.support.command.unassigned,
      value: stats.unassigned,
    },
    {
      key: "resolved",
      label: ko.support.command.resolvedHistory,
      value: stats.resolvedHistory,
    },
  ];

  return (
    <Card className="mb-5">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold text-ink">
          {supportSloStrings().commandTitle}
        </h2>
        <div
          role="group"
          aria-label={D.statsAria}
          className="flex flex-wrap items-center gap-2"
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              aria-pressed={drill === item.key}
              aria-label={D.drill(item.label)}
              onClick={() => {
                onDrill(item.key);
              }}
              className={chipClass(drill === item.key)}
            >
              <span className="text-xs font-semibold text-steel">
                {item.label}
              </span>
              <span className="font-bold">{item.value}</span>
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap gap-2 text-sm">
          <a
            className="rounded-md border border-line px-3 py-2 font-medium text-ink hover:bg-muted-panel"
            href="/kpi?source=support"
          >
            {ko.support.command.links.kpi}
          </a>
          <a
            className="rounded-md border border-line px-3 py-2 font-medium text-ink hover:bg-muted-panel"
            href="/reporting?source=support"
          >
            {ko.support.command.links.reporting}
          </a>
        </div>
      </div>
    </Card>
  );
}

/**
 * Inline chip-segment filters (§4-12: no stacked labeled selects): one chip
 * group per enum facet + a single search input; 미배정 포함 is a toggle chip.
 * A chip toggles its value off when pressed again.
 */
function FilterChips({
  filters,
  onChange,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
}) {
  return (
    <Card className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-steel"
            size={16}
          />
          <Input
            id="support-filter-search"
            className="pl-9"
            aria-label={ko.support.searchAria}
            placeholder={ko.support.searchPlaceholder}
            value={filters.search}
            onChange={(event) => {
              onChange({ ...filters, search: event.currentTarget.value });
            }}
          />
        </div>
        <button
          type="button"
          aria-pressed={filters.includeUntriaged}
          onClick={() => {
            onChange({ ...filters, includeUntriaged: !filters.includeUntriaged });
          }}
          className={chipClass(filters.includeUntriaged)}
        >
          {ko.support.filters.includeUntriaged}
        </button>
      </div>
      <ChipGroup
        label={ko.support.filters.status}
        value={filters.status}
        options={SUPPORT_STATUSES.map((v) => ({
          value: v,
          label: statusLabel(v),
        }))}
        onChange={(value) => {
          onChange({ ...filters, status: value as Filters["status"] });
        }}
      />
      <ChipGroup
        label={ko.support.filters.priority}
        value={filters.priority}
        options={SUPPORT_PRIORITIES.map((v) => ({
          value: v,
          label: priorityLabel(v),
        }))}
        onChange={(value) => {
          onChange({ ...filters, priority: value as Filters["priority"] });
        }}
      />
      <ChipGroup
        label={ko.support.filters.category}
        value={filters.category}
        options={SUPPORT_CATEGORIES.map((v) => ({
          value: v,
          label: categoryLabel(v),
        }))}
        onChange={(value) => {
          onChange({ ...filters, category: value as Filters["category"] });
        }}
      />
      <ChipGroup
        label={ko.support.filters.origin}
        value={filters.origin}
        options={SUPPORT_ORIGINS.map((v) => ({
          value: v,
          label: originLabel(v),
        }))}
        onChange={(value) => {
          onChange({ ...filters, origin: value as Filters["origin"] });
        }}
      />
    </Card>
  );
}

function ChipGroup({
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
  return (
    <div
      role="group"
      aria-label={label}
      className="flex flex-wrap items-center gap-2"
    >
      <span className="min-w-14 text-xs font-semibold text-steel">{label}</span>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => {
            onChange(value === option.value ? "" : option.value);
          }}
          className={chipClass(value === option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export interface SupportStats {
  open: number;
  urgentOrBreached: number;
  unassigned: number;
  resolvedHistory: number;
}

function filterTickets(tickets: SupportTicketSummary[], searchTerm: string) {
  if (searchTerm.length === 0) {
    return tickets;
  }
  const needle = searchTerm.toLocaleLowerCase("ko-KR");
  return tickets.filter((ticket) => {
    const haystack = [
      ticket.title,
      ticket.requester_name,
      ticket.assignee_name,
      categoryLabel(ticket.category),
      originLabel(ticket.origin),
      priorityLabel(ticket.priority),
      statusLabel(ticket.status),
      ticket.due_at,
      ticket.created_at,
    ]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase("ko-KR");
    return haystack.includes(needle);
  });
}

// Pure data helper, reused (not duplicated) by the console screen's model.ts.
// eslint-disable-next-line react-refresh/only-export-components
export function buildSupportStats(
  tickets: SupportTicketSummary[],
  nowMs: number,
  sloRules: SloSettingState["active"],
): SupportStats {
  return tickets.reduce<SupportStats>(
    (stats, ticket) => {
      if (ticket.status !== "RESOLVED" && ticket.status !== "CLOSED") {
        stats.open += 1;
      } else {
        stats.resolvedHistory += 1;
      }
      if (
        ticket.priority === "URGENT" ||
        sloPosture(ticket, sloRules, nowMs) === "overdue"
      ) {
        stats.urgentOrBreached += 1;
      }
      if (!ticket.assignee_user_id) {
        stats.unassigned += 1;
      }
      return stats;
    },
    { open: 0, urgentOrBreached: 0, unassigned: 0, resolvedHistory: 0 },
  );
}

/**
 * SLO violation alert rows (§4-26: internal alert, never penalty copy) — each
 * row names the escalation target from the ACTIVE setting and opens the ticket.
 */
function SloBreachAlerts({
  tickets,
  settings,
  onSelect,
}: {
  tickets: SupportTicketSummary[];
  settings: SloSettingState;
  onSelect: (id: string) => void;
}) {
  const S = supportSloStrings();
  return (
    <Card className="mb-5 grid gap-3" role="alert" aria-label={S.alerts.title}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-ink">{S.alerts.title}</h2>
        <Badge className={sloPostureBadgeClass("overdue")}>
          {tickets.length}
        </Badge>
      </div>
      <ul className="grid gap-2">
        {tickets.map((ticket) => {
          const rule = settings.active[ticket.category];
          return (
            <li key={ticket.id}>
              <button
                type="button"
                aria-label={S.alerts.rowAria(ticket.title)}
                onClick={() => {
                  onSelect(ticket.id);
                }}
                className="flex min-h-11 w-full flex-wrap items-center gap-2 rounded-md border border-line p-3 text-left transition-colors hover:bg-muted-panel"
              >
                <Badge className={sloPostureBadgeClass("overdue")}>
                  {S.posture.overdue}
                </Badge>
                <span className="font-semibold text-ink">{ticket.title}</span>
                <span className="text-sm text-steel">
                  {categoryLabel(ticket.category)}
                </span>
                <Badge className="ml-auto">
                  {S.alerts.escalateTo(
                    S.settings.targets[rule.escalationTarget],
                  )}
                </Badge>
              </button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
