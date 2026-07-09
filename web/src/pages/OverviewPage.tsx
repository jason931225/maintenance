// UI-M3 Overview (통합 개요) — the unified action inbox replacing /work-hub.
// Aggregates REAL pending items (engine approval tasks awaiting me, P1
// dispatch offers, actionable support tickets, attendance exceptions), a
// compact 1-row KPI strip, and the Today/Plan panel (todos + punch status).
// Every row's primary action executes the real mutation for its kind; scope
// respects whatever the APIs return (deny-by-omission).

import { CalendarClock, CheckSquare, LifeBuoy, Siren } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import type {
  AttendanceSummaryItem,
  KpiReport,
  MyDispatchOffer,
  SupportTicketSummary,
  WorkflowTaskSummary,
} from "../api/types";
import {
  Chip,
  MonoRef,
  StatBar,
  type StatBarItem,
} from "../components/console/primitives";
import {
  CONSOLE_LIST_BODY_CLASS,
  useListNav,
} from "../components/console/list-grammar";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import { emitConsoleToast } from "../components/shell/useConsoleToast";
import { PinButton } from "../components/shell/workspace/PinButton";
import {
  FEATURES,
  hasAnyFeatureGrant,
  hasAnyRole,
  ROLES,
} from "../components/shell/nav";
import { PageEmpty } from "../components/states/PageEmpty";
import { PageError } from "../components/states/PageError";
import { SkeletonCards } from "../components/states/Skeleton";
import { useAuth } from "../context/auth";
import {
  buildApprovalItems,
  buildAttendanceItems,
  buildDispatchItems,
  buildSupportItems,
  countsByKind,
  filterByKind,
  OVERVIEW_KINDS,
  sortInboxItems,
  type OverviewAction,
  type OverviewItem,
  type OverviewKind,
  type OverviewSource,
} from "../features/overview/overview-data";
import { TodayPanel } from "../features/overview/TodayPanel";
import { hubRowToPin } from "../features/workspace/adapters";
import type { PinKind } from "../features/workspace/types";
import { ko } from "../i18n/ko";
import { cn } from "../lib/utils";

const HR_READ_ROLES = [ROLES.ADMIN, ROLES.EXECUTIVE, ROLES.SUPER_ADMIN] as const;
const HR_READ_FEATURES = [FEATURES.EMPLOYEE_DIRECTORY_READ] as const;
const KPI_ROLES = [ROLES.ADMIN, ROLES.EXECUTIVE, ROLES.SUPER_ADMIN] as const;

const KIND_ICON: Record<OverviewKind, typeof CheckSquare> = {
  approval: CheckSquare,
  dispatch: Siren,
  support: LifeBuoy,
  attendance: CalendarClock,
};

const KIND_PIN: Record<OverviewKind, PinKind> = {
  approval: "approval",
  dispatch: "workOrder",
  support: "support",
  attendance: "attendance",
};

type ReadState = "loading" | "idle" | "error";

interface OverviewData {
  tasks: WorkflowTaskSummary[];
  offers: MyDispatchOffer[];
  tickets: SupportTicketSummary[];
  attendance: AttendanceSummaryItem[];
}

const emptyData: OverviewData = {
  tasks: [],
  offers: [],
  tickets: [],
  attendance: [],
};

interface CapturedSource<T = unknown> {
  key: OverviewSource;
  data?: T;
  failed: boolean;
  skipped?: boolean;
}

async function capture<T>(
  key: OverviewSource,
  request: Promise<{ data?: T } | undefined>,
): Promise<CapturedSource<T>> {
  const response = await request.catch(() => undefined);
  return { key, data: response?.data, failed: !response?.data };
}

function skippedSource(key: OverviewSource): Promise<CapturedSource> {
  return Promise.resolve({ key, data: undefined, failed: false, skipped: true });
}

/** Inclusive-start / exclusive-end current-month period for the KPI strip. */
function currentMonthPeriod(now: Date): string {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const day = (d: Date) => d.toISOString().slice(0, 10);
  return `${day(start)}..${day(end)}`;
}

function bpsToPercent(bps: number | null | undefined): string {
  if (bps === null || bps === undefined) return ko.overview.kpi.unavailable;
  return `${(bps / 100).toFixed(1)}%`;
}

function kpiStatItems(report: KpiReport): StatBarItem[] {
  if (report.rollups.length === 0) return [];
  const rollup =
    report.rollups.find((r) => r.scope.kind === "company") ?? report.rollups[0];
  return [
    {
      label: ko.overview.kpi.completed,
      value: String(rollup.completed_count),
    },
    {
      label: ko.overview.kpi.dueCompliance,
      value: bpsToPercent(rollup.target_due_compliance_bps),
    },
    {
      label: ko.overview.kpi.delayRate,
      value: bpsToPercent(rollup.delay_rate_bps),
    },
    {
      label: ko.overview.kpi.revisitRate,
      value: bpsToPercent(rollup.revisit_rate_bps),
    },
  ];
}

interface OverviewPageProps {
  active?: boolean;
}

export function OverviewPage({ active = true }: OverviewPageProps = {}) {
  const { api, session } = useAuth();
  const navigate = useNavigate();
  const mountedRef = useRef(false);
  const loadDataRequestRef = useRef(0);
  const [data, setData] = useState<OverviewData>(emptyData);
  const [failures, setFailures] = useState<OverviewSource[]>([]);
  const [readState, setReadState] = useState<ReadState>("loading");
  const [filter, setFilter] = useState<OverviewKind | "all">("all");
  const [kpi, setKpi] = useState<KpiReport | undefined>();
  const [busyItemId, setBusyItemId] = useState<string | undefined>();

  const canSeeHr =
    hasAnyRole(session?.roles, HR_READ_ROLES) ||
    hasAnyFeatureGrant(session?.feature_grants, HR_READ_FEATURES);
  const canSeeKpi = hasAnyRole(session?.roles, KPI_ROLES);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadData = useCallback(async () => {
    if (!mountedRef.current) return;
    const requestId = loadDataRequestRef.current + 1;
    loadDataRequestRef.current = requestId;
    const isCurrentRequest = () =>
      mountedRef.current && loadDataRequestRef.current === requestId;
    setReadState("loading");

    const results = await Promise.all([
      capture(
        "approvals",
        api.GET("/api/v1/workflow-tasks", {
          params: { query: { assignee: "me", status: "OPEN,CLAIMED" } },
        }),
      ),
      capture("dispatch", api.GET("/api/v1/me/dispatch-offers", {})),
      capture(
        "support",
        api.GET("/api/v1/support/tickets", {
          params: { query: { include_untriaged: true, limit: 20 } },
        }),
      ),
      canSeeHr
        ? capture(
            "attendance",
            api.GET("/api/v1/hr/attendance-summary", {
              params: { query: {} },
            }),
          )
        : skippedSource("attendance"),
    ]);

    if (canSeeKpi) {
      const kpiResponse = await api
        .GET("/api/v1/kpi", {
          params: { query: { period: currentMonthPeriod(new Date()) } },
        })
        .catch(() => undefined);
      if (isCurrentRequest()) setKpi(kpiResponse?.data);
    }

    const requested = results.filter((result) => !result.skipped);
    const nextFailures = requested
      .filter((result) => result.failed)
      .map((result) => result.key);

    const nextData: OverviewData = {
      tasks:
        (
          results.find((r) => r.key === "approvals")?.data as
            | { items?: WorkflowTaskSummary[] }
            | undefined
        )?.items ?? [],
      offers:
        (
          results.find((r) => r.key === "dispatch")?.data as
            | { items?: MyDispatchOffer[] }
            | undefined
        )?.items ?? [],
      tickets:
        (
          results.find((r) => r.key === "support")?.data as
            | { items?: SupportTicketSummary[] }
            | undefined
        )?.items ?? [],
      attendance:
        (
          results.find((r) => r.key === "attendance")?.data as
            | { items?: AttendanceSummaryItem[] }
            | undefined
        )?.items ?? [],
    };

    if (!isCurrentRequest()) return;
    setData(nextData);
    setFailures(nextFailures);
    setReadState(
      requested.length > 0 && requested.every((result) => result.failed)
        ? "error"
        : "idle",
    );
  }, [api, canSeeHr, canSeeKpi]);

  useEffect(() => {
    if (!active) return;
    void Promise.resolve().then(loadData);
  }, [active, loadData]);

  const inboxItems = useMemo(
    () =>
      sortInboxItems([
        ...buildApprovalItems(data.tasks, session?.user_id),
        ...buildDispatchItems(data.offers),
        ...buildSupportItems(data.tickets),
        ...buildAttendanceItems(data.attendance),
      ]),
    [data, session?.user_id],
  );
  const counts = useMemo(() => countsByKind(inboxItems), [inboxItems]);
  const visibleItems = useMemo(
    () => filterByKind(inboxItems, filter),
    [filter, inboxItems],
  );

  const transitionTicket = useCallback(
    async (ticketId: string, toStatus: SupportTicketSummary["status"]) => {
      const response = await api
        .POST("/api/v1/support/tickets/{id}/transition", {
          params: { path: { id: ticketId } },
          body: { to_status: toStatus },
        })
        .catch(() => undefined);
      return Boolean(response?.data);
    },
    [api],
  );

  const runAction = useCallback(
    async (item: OverviewItem) => {
      const action: OverviewAction = item.action;
      if (action.type === "open") {
        void navigate(action.href);
        return;
      }
      if (busyItemId) return;
      setBusyItemId(item.id);
      let message: string | undefined;
      let onUndo: (() => void) | undefined;

      try {
        switch (action.type) {
          case "claim": {
            const response = await api
              .POST("/api/v1/workflow-tasks/{task_id}/claim", {
                params: { path: { task_id: action.taskId } },
                body: { idempotency_key: crypto.randomUUID() },
              })
              .catch(() => undefined);
            if (response?.data) message = ko.overview.toasts.claimed;
            break;
          }
          case "approve": {
            const response = await api
              .POST("/api/v1/workflow-tasks/{task_id}/decide", {
                params: { path: { task_id: action.taskId } },
                body: {
                  decision: "approve",
                  idempotency_key: crypto.randomUUID(),
                },
              })
              .catch(() => undefined);
            if (response?.data) message = ko.overview.toasts.approved;
            break;
          }
          case "acceptDispatch": {
            const response = await api
              .POST("/api/v1/p1-dispatches/{dispatchId}/responses", {
                params: { path: { dispatchId: action.dispatchId } },
                body: { response: "ACCEPT" },
              })
              .catch(() => undefined);
            if (response?.data) message = ko.overview.toasts.accepted;
            break;
          }
          case "transitionTicket": {
            const ok = await transitionTicket(action.ticketId, action.toStatus);
            if (ok) {
              message =
                action.toStatus === "RESOLVED"
                  ? ko.overview.toasts.ticketResolved
                  : action.toStatus === "IN_PROGRESS" &&
                      action.undoStatus === undefined
                    ? ko.overview.toasts.ticketStarted
                    : ko.overview.toasts.ticketResumed;
              const undoStatus = action.undoStatus;
              if (undoStatus) {
                onUndo = () => {
                  void transitionTicket(action.ticketId, undoStatus).then(
                    (undone) => {
                      if (undone) {
                        emitConsoleToast({
                          message: ko.overview.toasts.ticketReopened,
                        });
                      }
                      void loadData();
                    },
                  );
                };
              }
            }
            break;
          }
        }
      } finally {
        if (mountedRef.current) setBusyItemId(undefined);
      }

      if (!mountedRef.current) return;
      if (message) {
        emitConsoleToast({ message, onUndo });
      } else {
        emitConsoleToast({ message: ko.overview.toasts.actionFailed });
      }
      await loadData();
    },
    [api, busyItemId, loadData, navigate, transitionTicket],
  );

  const listNav = useListNav({
    count: visibleItems.length,
    onOpen: (index) => {
      void runAction(visibleItems[index]);
    },
  });

  const filterChips: { key: OverviewKind | "all"; label: string; count: number }[] =
    useMemo(
      () => [
        {
          key: "all" as const,
          label: ko.overview.filters.all,
          count: inboxItems.length,
        },
        ...OVERVIEW_KINDS.map((kind) => ({
          key: kind,
          label: ko.overview.kinds[kind],
          count: counts[kind],
        })),
      ],
      [counts, inboxItems.length],
    );

  const kpiItems = kpi ? kpiStatItems(kpi) : [];

  return (
    <>
      <PageHeader
        title={ko.overview.title}
        description={ko.overview.description}
        actions={
          <RefreshButton
            onClick={() => {
              void loadData();
            }}
            isLoading={readState === "loading"}
          />
        }
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="grid content-start gap-4">
          {canSeeKpi && kpiItems.length > 0 ? (
            <section aria-label={ko.overview.kpi.label}>
              <StatBar items={kpiItems} />
            </section>
          ) : null}

          {failures.length > 0 && readState !== "error" ? (
            <PageError
              message={ko.overview.partialFailure.replace(
                "{sources}",
                failures
                  .map((source) => ko.overview.sources[source])
                  .join(", "),
              )}
              onRetry={() => {
                void loadData();
              }}
            />
          ) : null}

          <section aria-labelledby="overview-inbox-title" className="grid gap-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2
                  id="overview-inbox-title"
                  className="text-lg font-semibold text-console-ink"
                >
                  {ko.overview.sections.inbox}
                </h2>
              </div>
              <div
                className="flex flex-wrap gap-1.5"
                role="group"
                aria-label={ko.overview.filters.label}
              >
                {filterChips.map((chip) => (
                  <button
                    key={chip.key}
                    type="button"
                    aria-pressed={filter === chip.key}
                    aria-label={ko.overview.filters.chip
                      .replace("{label}", chip.label)
                      .replace("{count}", String(chip.count))}
                    onClick={() => {
                      setFilter(chip.key);
                    }}
                    className={cn(
                      "min-h-7 rounded-full border px-2.5 text-[12px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-console-signal",
                      filter === chip.key
                        ? "border-console-ink bg-console-ink text-console-surface"
                        : "border-console-border bg-console-surface text-console-steel hover:text-console-ink",
                    )}
                  >
                    {chip.label} {chip.count}
                  </button>
                ))}
              </div>
            </div>

            {readState === "loading" && inboxItems.length === 0 ? (
              <SkeletonCards count={4} lines={2} />
            ) : readState === "error" ? (
              <PageError
                onRetry={() => {
                  void loadData();
                }}
              />
            ) : visibleItems.length === 0 ? (
              <PageEmpty message={ko.overview.emptyInbox} />
            ) : (
              <div
                role="list"
                aria-label={ko.overview.listLabel}
                // Focusable so J/K/Enter work before any row holds focus.
                tabIndex={0}
                className={cn(
                  CONSOLE_LIST_BODY_CLASS,
                  "max-h-[60vh] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-console-signal",
                )}
                onKeyDown={listNav.onKeyDown}
              >
                {visibleItems.map((item, index) => {
                  const Icon = KIND_ICON[item.kind];
                  return (
                    <div
                      key={item.id}
                      role="listitem"
                      tabIndex={listNav.selectedIndex === index ? 0 : -1}
                      ref={listNav.getItemRef(index)}
                      className={cn(
                        "mb-1.5 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-[8px] border border-console-border bg-console-surface px-3 py-2",
                        listNav.selectedIndex === index &&
                          "ring-2 ring-inset ring-console-signal",
                      )}
                    >
                      <span className="hidden rounded-full border border-console-border bg-console-muted p-1.5 text-console-steel sm:inline-flex">
                        <Icon size={16} aria-hidden="true" />
                      </span>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Chip tone={item.kind === "dispatch" ? "danger" : "neutral"}>
                            {ko.overview.kinds[item.kind]}
                          </Chip>
                          <MonoRef value={item.code.slice(0, 12)} />
                        </div>
                        <p className="mt-1 truncate text-[13px] font-bold text-console-ink">
                          {item.href ? (
                            <Link
                              to={item.href}
                              className="hover:underline focus-visible:outline-2 focus-visible:outline-console-signal"
                            >
                              {item.title}
                            </Link>
                          ) : (
                            item.title
                          )}
                        </p>
                        <p className="truncate text-[12px] text-console-steel">
                          {item.detail}
                          {item.dueLabel ? ` · ${item.dueLabel}` : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <PinButton
                          object={hubRowToPin({
                            code: item.code,
                            kind: KIND_PIN[item.kind],
                            title: item.title,
                            eyebrow: ko.overview.kinds[item.kind],
                            detail: item.detail,
                            dueLabel: item.dueLabel,
                            href: item.href ?? "/overview",
                          })}
                        />
                        <button
                          type="button"
                          disabled={busyItemId !== undefined}
                          aria-label={`${item.title} ${item.actionLabel}`}
                          onClick={() => {
                            void runAction(item);
                          }}
                          className="min-h-8 rounded-[7px] border border-console-border bg-console-surface px-2.5 text-[12px] font-bold text-console-ink hover:bg-console-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-console-signal disabled:opacity-50"
                        >
                          {item.actionLabel}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        <TodayPanel active={active} />
      </div>
    </>
  );
}
