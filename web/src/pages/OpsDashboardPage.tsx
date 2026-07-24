import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";

import type {
  ArrivalEvent,
  OpsSummary,
  WorkOrderFacetBucket,
  WorkOrderHistogramBucket,
  WorkOrderNamedBucket,
  WorkOrderObjectSetLens,
} from "../api/types";
import { useAuth } from "../context/auth";
import { LoadMoreButton } from "../components/shell/LoadMoreButton";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import { PageError } from "../components/states/PageError";
import { SkeletonCards } from "../components/states/Skeleton";
import { Badge } from "../components/ui/badge";
import { Card } from "../components/ui/card";
import { ko } from "../i18n/ko";
import { formatListCount } from "../lib/utils";

type ReadState = "idle" | "loading" | "error";

export function OpsDashboardPage() {
  const { api } = useAuth();
  const [summary, setSummary] = useState<OpsSummary>();
  const [lens, setLens] = useState<WorkOrderObjectSetLens>();
  const [readState, setReadState] = useState<ReadState>("loading");

  const loadData = useCallback(async () => {
    setReadState("loading");
    const [summaryResponse, lensResponse] = await Promise.all([
      api.GET("/api/v1/ops/summary", {}).catch(() => undefined),
      api
        .GET("/api/v1/work-orders", {
          params: { query: { limit: 1, offset: 0 } },
        })
        .catch(() => undefined),
    ]);
    if (!summaryResponse?.data) {
      setReadState("error");
      return;
    }
    setSummary(summaryResponse.data);
    setLens(lensResponse?.data?.lens);
    setReadState("idle");
  }, [api]);

  useEffect(() => {
    void Promise.resolve().then(loadData);
  }, [loadData]);

  return (
    <>
      <PageHeader
        title={ko.ops.title}
        description={ko.ops.description}
        actions={
          <RefreshButton
            onClick={() => {
              void loadData();
            }}
            isLoading={readState === "loading"}
          />
        }
      />
      <div className="grid gap-5">
        {readState === "error" ? (
          <PageError
            onRetry={() => {
              void loadData();
            }}
          />
        ) : null}
        {summary ? (
          <OpsContent summary={summary} lens={lens} />
        ) : readState === "loading" ? (
          <SkeletonCards count={2} lines={3} />
        ) : (
          <p className="rounded-md border border-dashed border-line p-4 text-sm text-steel">
            {ko.ops.empty}
          </p>
        )}
        <ArrivalEventsCard />
      </div>
    </>
  );
}

const ARRIVALS_PAGE_SIZE = 20;

/** Site arrival/departure feed (#13), fetched independently of the ops summary. */
function ArrivalEventsCard() {
  const { api } = useAuth();
  const [events, setEvents] = useState<ArrivalEvent[]>([]);
  const [total, setTotal] = useState<number | undefined>(undefined);
  const [state, setState] = useState<ReadState>("loading");
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async () => {
    setState("loading");
    const response = await api
      .GET("/api/v1/location/arrival-events", {
        params: { query: { limit: ARRIVALS_PAGE_SIZE, offset: 0 } },
      })
      .catch(() => undefined);
    if (!response?.data) {
      setState("error");
      return;
    }
    setEvents(response.data.items);
    setTotal(response.data.total);
    setState("idle");
  }, [api]);

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    const response = await api
      .GET("/api/v1/location/arrival-events", {
        params: { query: { limit: ARRIVALS_PAGE_SIZE, offset: events.length } },
      })
      .catch(() => undefined);
    if (response?.data) {
      setEvents((current) => [...current, ...response.data.items]);
      setTotal(response.data.total);
    }
    setLoadingMore(false);
  }, [api, events.length]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  return (
    <Card>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-steel">
          {ko.ops.arrivals.title}
        </h2>
        {state === "idle" && events.length > 0 ? (
          <Badge>{formatListCount(events.length, { total })}</Badge>
        ) : null}
      </div>
      {state === "loading" ? (
        <SkeletonCards count={3} lines={1} />
      ) : state === "error" ? (
        <p className="rounded-md border border-dashed border-red-300 p-3 text-sm text-red-700">
          {ko.ops.arrivals.error}
        </p>
      ) : events.length === 0 ? (
        <p className="rounded-md border border-dashed border-line p-3 text-sm text-steel">
          {ko.ops.arrivals.empty}
        </p>
      ) : (
        <ul className="grid gap-2">
          {events.map((event) => (
            <li
              key={event.id}
              className="flex items-center justify-between gap-2 rounded-md border border-line bg-muted-panel px-3 py-2"
            >
              <span className="truncate text-sm text-steel">
                <span
                  className={
                    event.kind === "ARRIVAL"
                      ? "font-semibold text-brand-teal"
                      : "font-semibold text-steel"
                  }
                >
                  {event.kind === "ARRIVAL"
                    ? ko.ops.arrivals.arrival
                    : ko.ops.arrivals.departure}
                </span>
                {" · "}
                {event.site_name} · {event.work_order_no}
              </span>
              <span className="ml-2 shrink-0 text-xs text-steel">
                {new Date(event.occurred_at).toLocaleString("ko-KR", {
                  dateStyle: "short",
                  timeStyle: "short",
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
      {state === "idle" && total !== undefined && events.length < total ? (
        <div className="mt-3">
          <LoadMoreButton
            onClick={() => {
              void loadMore();
            }}
            isLoading={loadingMore}
            loaded={events.length}
            total={total}
          />
        </div>
      ) : null}
    </Card>
  );
}

function OpsContent({
  summary,
  lens,
}: {
  summary: OpsSummary;
  lens?: WorkOrderObjectSetLens;
}) {
  const agingHint = ko.ops.alerts.agingHint.replace(
    "{hours}",
    String(summary.aging_hours),
  );
  return (
    <div className="grid gap-5">
      <FunnelCard summary={summary} />
      <AlertsCard summary={summary} agingHint={agingHint} />
      <ObjectSetLensCard lens={lens} />
      <div className="grid gap-5 lg:grid-cols-2">
        <EquipmentCard summary={summary} />
        <MechanicsCard summary={summary} />
      </div>
    </div>
  );
}

function ObjectSetLensCard({ lens }: { lens?: WorkOrderObjectSetLens }) {
  const t = ko.ops.lens;
  if (!lens) {
    return (
      <Card>
        <h2 className="mb-2 text-sm font-semibold text-steel">{t.title}</h2>
        <p className="rounded-md border border-dashed border-line p-3 text-sm text-steel">
          {t.empty}
        </p>
      </Card>
    );
  }

  const aggregateTiles = [
    {
      label: t.total,
      value: lens.aggregates.total_count,
      to: "/dispatch",
    },
    {
      label: t.p1,
      value: lens.aggregates.p1_count,
      to: routeWithLensFilters({ priority: "P1" }),
    },
    {
      label: t.overdueOpen,
      value: lens.aggregates.overdue_open_count,
    },
    {
      label: t.unassigned,
      value: lens.aggregates.unassigned_count,
    },
  ];

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-steel">{t.title}</h2>
          <p className="mt-1 text-sm text-steel">{t.description}</p>
        </div>
        <Badge>{t.objectSet}</Badge>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {aggregateTiles.map((tile) => (
          <LensTile
            key={tile.label}
            label={tile.label}
            value={tile.value}
            to={tile.to}
          />
        ))}
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-4">
        <FacetColumn
          title={t.statusFacet}
          buckets={lens.facets.status}
          labelFor={(value) =>
            (ko.status as Partial<Record<string, string>>)[value] ?? value
          }
        />
        <FacetColumn
          title={t.priorityFacet}
          buckets={lens.facets.priority}
          labelFor={(value) =>
            (ko.priority as Partial<Record<string, string>>)[value] ?? value
          }
        />
        <NamedBucketColumn
          title={t.customerListogram}
          buckets={lens.listograms.customers}
        />
        <NamedBucketColumn
          title={t.siteListogram}
          buckets={lens.listograms.sites}
        />
      </div>
      <HistogramRow buckets={lens.histograms.target_due_date} />
    </Card>
  );
}

function LensTile({
  label,
  value,
  to,
}: {
  label: string;
  value: number;
  to?: string;
}) {
  const content = (
    <>
      <p className="text-sm text-steel">{label}</p>
      <p className="text-2xl font-bold text-ink">{value}</p>
    </>
  );
  const className =
    "rounded-md border border-line bg-muted-panel p-3 transition hover:border-brand-teal hover:bg-brand-teal/5";
  return to ? (
    <Link
      to={to}
      className={className}
      aria-label={`${label} ${ko.ops.lens.open}`}
    >
      {content}
    </Link>
  ) : (
    <div className="rounded-md border border-line bg-muted-panel p-3">
      {content}
    </div>
  );
}

function FacetColumn({
  title,
  buckets,
  labelFor,
}: {
  title: string;
  buckets: WorkOrderFacetBucket[];
  labelFor: (value: string) => string;
}) {
  return (
    <LensBucketColumn
      title={title}
      buckets={buckets.map((bucket) => ({
        key: bucket.value,
        label: labelFor(bucket.value),
        count: bucket.count,
        to: routeWithLensFilters(bucket.filters),
      }))}
    />
  );
}

function NamedBucketColumn({
  title,
  buckets,
}: {
  title: string;
  buckets: WorkOrderNamedBucket[];
}) {
  return (
    <LensBucketColumn
      title={title}
      buckets={buckets.map((bucket) => ({
        key: bucket.id,
        label: bucket.name,
        count: bucket.count,
        to: routeWithLensFilters(bucket.filters),
      }))}
    />
  );
}

function HistogramRow({ buckets }: { buckets: WorkOrderHistogramBucket[] }) {
  const t = ko.ops.lens;
  return (
    <div className="mt-4">
      <h3 className="mb-2 text-sm font-semibold text-steel">
        {t.dueHistogram}
      </h3>
      {buckets.length === 0 ? (
        <p className="rounded-md border border-dashed border-line p-3 text-sm text-steel">
          {t.noBuckets}
        </p>
      ) : (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {buckets.map((bucket) => (
            <Link
              key={bucket.bucket}
              to={routeWithLensFilters(bucket.filters)}
              className="min-w-32 rounded-md border border-line bg-muted-panel px-3 py-2 text-sm hover:border-brand-teal hover:bg-brand-teal/5"
            >
              <span className="block font-medium text-ink">
                {bucket.bucket}
              </span>
              <span className="text-steel">
                {bucket.count}
                {ko.common.countUnit}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function LensBucketColumn({
  title,
  buckets,
}: {
  title: string;
  buckets: Array<{ key: string; label: string; count: number; to: string }>;
}) {
  const t = ko.ops.lens;
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold text-steel">{title}</h3>
      {buckets.length === 0 ? (
        <p className="rounded-md border border-dashed border-line p-3 text-sm text-steel">
          {t.noBuckets}
        </p>
      ) : (
        <ul className="grid gap-2">
          {buckets.slice(0, 6).map((bucket) => (
            <li key={bucket.key}>
              <Link
                to={bucket.to}
                className="flex items-center justify-between gap-2 rounded-md border border-line bg-muted-panel px-3 py-2 text-sm hover:border-brand-teal hover:bg-brand-teal/5"
              >
                <span className="truncate font-medium text-ink">
                  {bucket.label}
                </span>
                <span className="shrink-0 text-steel">
                  {bucket.count}
                  {ko.common.countUnit}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function routeWithLensFilters(filters: Record<string, string>): string {
  const params = new URLSearchParams();
  Object.entries(filters)
    .filter(([, value]) => value.trim() !== "")
    .forEach(([key, value]) => {
      params.set(key, value);
    });
  const query = params.toString();
  return query ? `/dispatch?${query}` : "/dispatch";
}

function FunnelCard({ summary }: { summary: OpsSummary }) {
  const stages: { labelKey: keyof typeof ko.ops.funnel; value: number }[] = [
    { labelKey: "received", value: summary.funnel.received },
    { labelKey: "assigned", value: summary.funnel.assigned },
    { labelKey: "in_progress", value: summary.funnel.in_progress },
    { labelKey: "completed", value: summary.funnel.completed },
  ];
  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold text-steel">
        {ko.ops.funnel.title}
      </h2>
      <div className="grid gap-3 sm:grid-cols-4">
        {stages.map((stage) => (
          <div
            key={stage.labelKey}
            className="rounded-md border border-line bg-muted-panel p-3"
          >
            <p className="text-sm text-steel">
              {ko.ops.funnel[stage.labelKey]}
            </p>
            <p className="text-2xl font-bold text-ink">
              {stage.value}
              <span className="ml-1 text-sm font-normal text-steel">
                {ko.common.countUnit}
              </span>
            </p>
          </div>
        ))}
      </div>
    </Card>
  );
}

function AlertsCard({
  summary,
  agingHint,
}: {
  summary: OpsSummary;
  agingHint: string;
}) {
  const alerts: {
    label: string;
    value: number;
    hint?: string;
    danger?: boolean;
  }[] = [
    {
      label: ko.ops.alerts.aging,
      value: summary.aging_work_orders,
      hint: agingHint,
      danger: summary.aging_work_orders > 0,
    },
    {
      label: ko.ops.alerts.slaBreached,
      value: summary.sla_breached,
      danger: summary.sla_breached > 0,
    },
    {
      label: ko.ops.alerts.slaAtRisk,
      value: summary.sla_at_risk,
      danger: summary.sla_at_risk > 0,
    },
    {
      label: ko.ops.alerts.pendingApprovals,
      value: summary.pending_approvals,
    },
    {
      label: ko.ops.alerts.activeSubstitutions,
      value: summary.active_substitutions,
    },
    {
      label: ko.ops.alerts.openSupport,
      value: summary.open_support_tickets,
    },
  ];
  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold text-steel">
        {ko.ops.alerts.title}
      </h2>
      <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {alerts.map((alert) => (
          <div
            key={alert.label}
            className={
              alert.danger
                ? "rounded-md border border-red-200 bg-red-50 p-3"
                : "rounded-md border border-line bg-muted-panel p-3"
            }
          >
            <p className="text-sm text-steel">{alert.label}</p>
            <p
              className={
                alert.danger
                  ? "text-2xl font-bold text-red-700"
                  : "text-2xl font-bold text-ink"
              }
            >
              {alert.value}
            </p>
            {alert.hint ? (
              <p className="mt-0.5 text-xs text-steel">{alert.hint}</p>
            ) : null}
          </div>
        ))}
      </div>
    </Card>
  );
}

function EquipmentCard({ summary }: { summary: OpsSummary }) {
  const rows: { labelKey: keyof typeof ko.ops.equipment; value: number }[] = [
    { labelKey: "rented", value: summary.equipment_status.rented },
    { labelKey: "spare", value: summary.equipment_status.spare },
    { labelKey: "replacement", value: summary.equipment_status.replacement },
    { labelKey: "scrapped", value: summary.equipment_status.scrapped },
    { labelKey: "sold", value: summary.equipment_status.sold },
  ];
  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold text-steel">
        {ko.ops.equipment.title}
      </h2>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {rows.map((row) => (
          <div
            key={row.labelKey}
            className="rounded-md border border-line bg-muted-panel p-3"
          >
            <dt className="text-sm text-steel">
              {ko.ops.equipment[row.labelKey]}
            </dt>
            <dd className="text-xl font-bold text-ink">{row.value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function MechanicsCard({ summary }: { summary: OpsSummary }) {
  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold text-steel">
        {ko.ops.mechanics.title}
      </h2>
      {summary.mechanic_load.length === 0 ? (
        <p className="rounded-md border border-dashed border-line p-3 text-sm text-steel">
          {ko.ops.mechanics.empty}
        </p>
      ) : (
        <ul className="grid gap-2">
          {summary.mechanic_load.map((mechanic) => (
            <li
              key={mechanic.mechanic_id}
              className="flex items-center justify-between rounded-md border border-line bg-muted-panel px-3 py-2"
            >
              <span className="truncate text-sm font-medium text-steel">
                {mechanic.display_name}
              </span>
              <span className="ml-2 shrink-0 text-sm text-steel">
                {mechanic.active_assignments}
                <span className="ml-1 text-xs text-steel">
                  {ko.ops.mechanics.activeAssignments}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
