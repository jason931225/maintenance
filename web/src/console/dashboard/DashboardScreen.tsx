import { useMemo, useState, type CSSProperties } from "react";
import { Link, useNavigate } from "react-router";

import type {
  AttendanceSummaryItem,
  KpiMetric,
  KpiReport,
  KpiRollup,
  KpiRollupScope,
  MyPayrollLine,
  OpsSummary,
  UnavailableMetric,
} from "../../api/types";
import { HonestBar, ProjectionPanel, type ChartFormat } from "../charts";
import { StatusChip } from "../components";
import "../tokens.css";
import { ko } from "../../i18n/ko";
import { dashboardStrings } from "./strings";

/**
 * 대시보드 (design core surface) — the /kpi executive dashboard rebuilt on the
 * console grammar: PBAC-relative scope segments (the rollups the KPI API
 * authorizes for the caller, §4.5), typed month-period segments (§4-19), a
 * compact one-row stat strip where every stat drills to its source screen
 * (§4-11), and honest-scale charts (§4-24). Sections of the design that have
 * no backing API (인건비 추이, 계약 수익성, 인사이트 AN-*) are omitted, not
 * placeholdered (§4-12, §4-25-⑥).
 */

interface DashboardScreenProps {
  report?: KpiReport;
  opsSummary?: OpsSummary;
  period: string;
  isLoading: boolean;
  onPeriodChange: (period: string) => void;
  /**
   * Real month-over-month completed-count series (oldest→newest, current month
   * last) the body derived from trailing KPI reads. Fed to the §4-24 honest
   * projection panel; the current in-progress month is the projected step.
   */
  trend?: number[];
  /** Site attendance facts (사업장 커버리지) — additive, ops-authorized viewers. */
  coverage?: AttendanceSummaryItem[];
  /** Caller-scoped payroll readiness lines (내 지표) — honest, no ₩ fabricated. */
  myMetrics?: MyPayrollLine[];
}

const metricOrder: KpiMetric[] = [
  "completed_count",
  "average_response_speed",
  "completion_duration_and_due_compliance",
  "revisit_rate",
  "delay_rate_and_reason_distribution",
  "inspection_plan_completion_rate",
  "p1_acceptance_rate",
];

// ── formatting ───────────────────────────────────────────────────────────────
// ponytail: duplicated from features/kpi/kpi-format.ts — console purity forbids
// importing features/*; fold the two together if kpi-format ever moves here.

function trimDecimal(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function fmtCount(value: number) {
  return `${String(value)}${ko.common.countUnit}`;
}

function fmtPoints(value: number) {
  return `${String(value)}${ko.common.pointUnit}`;
}

function fmtBps(value: number | null) {
  if (value == null) {
    return ko.common.notSet;
  }
  return `${trimDecimal(value / 100)}%`;
}

function fmtSeconds(value: number | null) {
  if (value == null) {
    return ko.common.notSet;
  }
  if (value >= 3_600) {
    return `${trimDecimal(value / 3_600)}${ko.common.hourUnit}`;
  }
  if (value >= 60) {
    return `${trimDecimal(value / 60)}${ko.common.minuteUnit}`;
  }
  return `${String(value)}${ko.common.secondUnit}`;
}

// The completion trend is a count series, not money/percent — feed the honest
// projection panel a count formatter sourced from ko.common (no inline Hangul).
const trendFormat: ChartFormat = (value) => fmtCount(Math.round(value));

// ── typed month periods (§4-19: segments, never a raw date-format input) ─────

const monthFormat = new Intl.DateTimeFormat("ko-KR", {
  month: "long",
  timeZone: "UTC",
});

function isoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

interface PeriodSegment {
  period: string;
  label: string;
}

/** Current month (진행) plus the five closed months before it. */
function periodSegments(now: Date): PeriodSegment[] {
  const S = dashboardStrings();
  return Array.from({ length: 6 }, (_, index) => {
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - index, 1),
    );
    const end = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - index + 1, 1),
    );
    const month = monthFormat.format(start);
    return {
      period: `${isoDate(start)}..${isoDate(end)}`,
      label: index === 0 ? S.periodOngoing(month) : S.periodClosed(month),
    };
  });
}

// ── scopes ───────────────────────────────────────────────────────────────────

function scopeKeyOf(scope: KpiRollupScope | undefined) {
  if (!scope) {
    return "";
  }
  return scope.id ? `${scope.kind}:${scope.id}` : scope.kind;
}

function scopeChipLabel(rollup: KpiRollup) {
  if (rollup.scope.kind === "company") {
    return dashboardStrings().scopeAll;
  }
  const name = rollup.scope_display_name?.trim();
  return `${ko.kpi.scopes[rollup.scope.kind]} · ${name && name !== "" ? name : ko.common.notSet}`;
}

// ── stat strip (§4-11: one compact row, every stat drills) ───────────────────

interface Stat {
  key: string;
  label: string;
  value: string;
  sub?: string;
  to: string;
  danger?: boolean;
  unavailable?: UnavailableMetric;
}

function kpiStats(rollup: KpiRollup, unavailableMetrics: UnavailableMetric[]) {
  const unavailableByMetric = new Map(
    unavailableMetrics.map((metric) => [metric.metric, metric]),
  );
  return metricOrder.map((metric): Stat => {
    const base = { key: metric, label: ko.kpi.metrics[metric] };
    const unavailable = unavailableByMetric.get(metric);
    if (unavailable) {
      return { ...base, value: ko.kpi.unavailable, to: "", unavailable };
    }
    switch (metric) {
      case "completed_count":
        return {
          ...base,
          value: fmtCount(rollup.completed_count),
          sub: `${ko.kpi.weightedPoints} ${fmtPoints(rollup.weighted_completed_points)} · ${ko.kpi.approvedReports} ${fmtCount(rollup.approved_report_count)}`,
          to: "/dispatch?status=COMPLETED",
        };
      case "average_response_speed":
        return {
          ...base,
          value: fmtSeconds(rollup.average_response_seconds),
          to: "/dispatch",
        };
      case "completion_duration_and_due_compliance":
        return {
          ...base,
          value: fmtSeconds(rollup.average_completion_seconds),
          sub: `${ko.kpi.dueCompliance}: ${fmtBps(rollup.target_due_compliance_bps)}`,
          to: "/dispatch",
        };
      case "revisit_rate":
        return { ...base, value: fmtBps(rollup.revisit_rate_bps), to: "/dispatch" };
      case "delay_rate_and_reason_distribution":
        return { ...base, value: fmtBps(rollup.delay_rate_bps), to: "/dispatch" };
      case "inspection_plan_completion_rate":
        return {
          ...base,
          value: fmtBps(rollup.inspection_plan_completion_bps),
          sub: `${ko.kpi.inspectionPlanScheduled}: ${fmtCount(rollup.inspection_schedule_completed_count)}/${fmtCount(rollup.inspection_schedule_due_count)}`,
          to: "/inspection",
        };
      case "p1_acceptance_rate":
        return {
          ...base,
          value: fmtBps(rollup.p1_acceptance_bps),
          sub: `${ko.kpi.p1Accepted}: ${fmtCount(rollup.p1_accepted_count)}/${fmtCount(rollup.p1_dispatch_count)}`,
          to: "/dispatch?priority=P1",
        };
    }
  });
}

function opsStats(summary: OpsSummary): Stat[] {
  return [
    {
      key: "sla_breached",
      label: ko.ops.alerts.slaBreached,
      value: fmtCount(summary.sla_breached),
      to: "/ops",
      danger: summary.sla_breached > 0,
    },
    {
      key: "sla_at_risk",
      label: ko.ops.alerts.slaAtRisk,
      value: fmtCount(summary.sla_at_risk),
      to: "/ops",
      danger: summary.sla_at_risk > 0,
    },
    {
      key: "pending_approvals",
      label: ko.ops.alerts.pendingApprovals,
      value: fmtCount(summary.pending_approvals),
      to: "/approvals",
    },
    {
      key: "open_support",
      label: ko.ops.alerts.openSupport,
      value: fmtCount(summary.open_support_tickets),
      to: "/support",
    },
  ];
}

// ── styles (console tokens only) ─────────────────────────────────────────────

const rootStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-5)",
  fontFamily: "var(--font-sans)",
  color: "var(--ink)",
};

const headerStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--sp-3)",
};

const chipGroupStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--sp-2)",
};

function segmentStyle(selected: boolean): CSSProperties {
  return {
    minHeight: 44,
    padding: "0 var(--sp-5)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-sm)",
    background: selected ? "var(--ink)" : "var(--surface)",
    color: selected ? "var(--surface)" : "var(--steel)",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-body)",
    fontWeight: "var(--fw-medium)",
    cursor: "pointer",
  };
}

const stripStyle: CSSProperties = {
  display: "flex",
  overflowX: "auto",
  border: "var(--border-hairline)",
  borderRadius: "var(--radius-card)",
  background: "var(--surface)",
  boxShadow: "var(--shadow)",
};

const statStyle: CSSProperties = {
  display: "grid",
  alignContent: "center",
  gap: "var(--sp-1)",
  minHeight: 44,
  minWidth: "9rem",
  padding: "var(--sp-4) var(--sp-5)",
  borderRight: "1px solid var(--border-soft)",
  textDecoration: "none",
  color: "var(--ink)",
  whiteSpace: "nowrap",
};

const statLabelStyle: CSSProperties = {
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-body)",
  color: "var(--faint)",
  letterSpacing: "var(--tracking-label)",
};

const statSubStyle: CSSProperties = {
  fontSize: "var(--text-sm)",
  fontWeight: "var(--fw-body)",
  color: "var(--steel)",
  fontVariantNumeric: "tabular-nums",
};

const panelStyle: CSSProperties = {
  display: "grid",
  alignContent: "start",
  gap: "var(--sp-4)",
  padding: "var(--sp-card-y) var(--sp-6)",
  border: "var(--border-hairline)",
  borderRadius: "var(--radius-card)",
  background: "var(--surface)",
  boxShadow: "var(--shadow)",
};

const panelTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-card-title)",
  fontWeight: "var(--fw-strong)",
  letterSpacing: "var(--tracking-tight)",
};

const chartsGridStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-5)",
  gridTemplateColumns: "repeat(auto-fit, minmax(20rem, 1fr))",
};

const emptyActionStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: 44,
  width: "fit-content",
  padding: "0 var(--sp-5)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--muted)",
  color: "var(--ink)",
  fontSize: "var(--text-body)",
  fontWeight: "var(--fw-medium)",
  textDecoration: "none",
};

const cardsGridStyle: CSSProperties = {
  display: "grid",
  gap: "var(--sp-5)",
  gridTemplateColumns: "repeat(auto-fit, minmax(18rem, 1fr))",
};

// A drillable card that mirrors the stat-strip grammar: whole card is a link to
// its source screen (§4-11 drill), title + a compact fact list.
const cardLinkStyle: CSSProperties = {
  ...panelStyle,
  gap: "var(--sp-3)",
  textDecoration: "none",
  color: "var(--ink)",
};

const factRowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: "var(--sp-3)",
  minHeight: 32,
  alignItems: "center",
  fontSize: "var(--text-body)",
};

const factValueStyle: CSSProperties = {
  fontWeight: "var(--fw-strong)",
  fontVariantNumeric: "tabular-nums",
};

const pendingRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--sp-2)",
};

// ── screen ───────────────────────────────────────────────────────────────────

export function DashboardScreen({
  report,
  opsSummary,
  period,
  isLoading,
  onPeriodChange,
  trend,
  coverage,
  myMetrics,
}: DashboardScreenProps) {
  const S = dashboardStrings();
  const navigate = useNavigate();
  const [selectedScopeKey, setSelectedScopeKey] = useState<string>();
  const segments = useMemo(() => periodSegments(new Date()), []);

  const defaultScopeKey = useMemo(() => {
    if (!report) {
      return "";
    }
    const requested = scopeKeyOf(report.requested_scope);
    return report.rollups.some((rollup) => scopeKeyOf(rollup.scope) === requested)
      ? requested
      : scopeKeyOf(report.rollups[0]?.scope);
  }, [report]);
  const effectiveScopeKey =
    selectedScopeKey &&
    report?.rollups.some((rollup) => scopeKeyOf(rollup.scope) === selectedScopeKey)
      ? selectedScopeKey
      : defaultScopeKey;
  const selectedRollup = report?.rollups.find(
    (rollup) => scopeKeyOf(rollup.scope) === effectiveScopeKey,
  );

  const stats: Stat[] = [
    ...(report && selectedRollup
      ? kpiStats(selectedRollup, report.unavailable_metrics)
      : []),
    ...(opsSummary ? opsStats(opsSummary) : []),
  ];

  const scopeCompare =
    report && report.rollups.length > 1
      ? report.rollups.map((rollup) => ({
          id: scopeKeyOf(rollup.scope),
          label: scopeChipLabel(rollup),
          value: rollup.completed_count,
        }))
      : [];
  const delayReasons = Object.entries(
    selectedRollup?.delay_reason_distribution ?? {},
  )
    .sort((left, right) => right[1] - left[1])
    .map(([reason, count]) => ({
      id: reason,
      // Localize the delay_reason enum; unknown/retired variants fail closed to a
      // neutral label so a raw key (e.g. "ADDITIONAL_FAULT_FOUND") never surfaces.
      label: S.delayReasonLabels[reason] ?? S.delayReasonUnknown,
      value: count,
    }));

  // §4-24: an honest projection needs ≥3 real closed data points; below that the
  // panel would over-claim, so the trend is simply omitted (never faked).
  const trendSeries = (trend ?? []).filter((value) => Number.isFinite(value));
  const showTrend = trendSeries.length >= 3;

  // Coverage/my-metrics are additive cards: undefined = the viewer isn't
  // authorized (honest omission); [] = authorized but no rows (§4-10 empty).
  const latestPayLine = myMetrics?.[0];
  const payReady =
    latestPayLine?.calculation_status === "APPROVED" ||
    latestPayLine?.calculation_status === "ISSUED";

  const pendingAggregates = [
    S.pendingLaborCost,
    S.pendingContracts,
    S.pendingInsights,
  ];

  return (
    <div className="console" style={rootStyle}>
      <header style={headerStyle}>
        {report ? (
          <div role="group" aria-label={ko.kpi.rollupGroup} style={chipGroupStyle}>
            {report.rollups.map((rollup) => {
              const key = scopeKeyOf(rollup.scope);
              const selected = key === effectiveScopeKey;
              return (
                <button
                  key={key}
                  type="button"
                  data-window-control="true"
                  aria-pressed={selected}
                  aria-label={ko.kpi.scopeActions[rollup.scope.kind]}
                  style={segmentStyle(selected)}
                  onClick={() => {
                    setSelectedScopeKey(key);
                  }}
                >
                  {scopeChipLabel(rollup)}
                </button>
              );
            })}
          </div>
        ) : null}
        <div role="group" aria-label={ko.kpi.period} style={chipGroupStyle}>
          {segments.map((segment) => {
            const selected = segment.period === period;
            return (
              <button
                key={segment.period}
                type="button"
                data-window-control="true"
                aria-pressed={selected}
                style={segmentStyle(selected)}
                onClick={() => {
                  onPeriodChange(segment.period);
                }}
              >
                {segment.label}
              </button>
            );
          })}
        </div>
        {isLoading ? (
          <StatusChip role="status">{ko.common.loading}</StatusChip>
        ) : null}
      </header>

      {stats.length > 0 ? (
        <div style={stripStyle}>
          {stats.map((stat) =>
            stat.unavailable ? (
              <div key={stat.key} style={statStyle}>
                <span style={statLabelStyle}>{stat.label}</span>
                <StatusChip tone="warn" role="status">
                  {stat.value}
                </StatusChip>
                <span style={statSubStyle}>{stat.unavailable.reason}</span>
              </div>
            ) : (
              <Link
                key={stat.key}
                to={stat.to}
                data-window-control="true"
                aria-label={ko.console.charts.drill(stat.label, stat.value)}
                style={statStyle}
              >
                <span style={statLabelStyle}>{stat.label}</span>
                <span
                  style={{
                    fontSize: "var(--text-value-lg)",
                    fontWeight: "var(--fw-strong)",
                    fontVariantNumeric: "tabular-nums",
                    color: stat.danger ? "var(--danger-solid)" : "var(--ink)",
                  }}
                >
                  {stat.value}
                </span>
                {stat.sub ? <span style={statSubStyle}>{stat.sub}</span> : null}
              </Link>
            ),
          )}
        </div>
      ) : null}

      {report && !selectedRollup && !isLoading ? (
        <section style={panelStyle}>
          <p style={{ margin: 0, fontSize: "var(--text-body)", color: "var(--steel)" }}>
            {S.emptyReason}
          </p>
          <Link to="/dispatch" data-window-control="true" style={emptyActionStyle}>
            {S.emptyAction}
          </Link>
        </section>
      ) : null}

      {scopeCompare.length > 0 || delayReasons.length > 0 ? (
        <div style={chartsGridStyle}>
          {scopeCompare.length > 0 ? (
            <section style={panelStyle} aria-label={S.completionByScope}>
              <h2 style={panelTitleStyle}>{S.completionByScope}</h2>
              <HonestBar
                label={S.completionByScope}
                data={scopeCompare}
                format={fmtCount}
                onDrill={(id) => {
                  setSelectedScopeKey(id);
                }}
              />
            </section>
          ) : null}
          {delayReasons.length > 0 ? (
            <section style={panelStyle} aria-label={S.delayReasons}>
              <h2 style={panelTitleStyle}>{S.delayReasons}</h2>
              <HonestBar
                label={S.delayReasons}
                data={delayReasons}
                format={fmtCount}
                onDrill={() => {
                  void navigate("/dispatch");
                }}
              />
            </section>
          ) : null}
        </div>
      ) : null}

      {showTrend ? (
        <ProjectionPanel
          title={S.trendTitle}
          kind="percent"
          format={trendFormat}
          sample={trendSeries}
          onDrill={() => {
            void navigate("/dispatch?status=COMPLETED");
          }}
        />
      ) : null}

      {coverage !== undefined || myMetrics !== undefined ? (
        <div style={cardsGridStyle}>
          {coverage !== undefined ? (
            <Link
              to="/attendance"
              data-window-control="true"
              aria-label={S.coverageTitle}
              style={cardLinkStyle}
            >
              <h2 style={panelTitleStyle}>{S.coverageTitle}</h2>
              {coverage.length > 0 ? (
                coverage.slice(0, 5).map((item) => (
                  <div key={item.user_id} style={factRowStyle}>
                    <span style={{ color: "var(--steel)" }}>{item.display_name}</span>
                    <span style={factValueStyle}>
                      {`${S.coverageArrivals} ${fmtCount(item.arrivals)} · ${S.coverageDepartures} ${fmtCount(item.departures)}`}
                    </span>
                  </div>
                ))
              ) : (
                <p style={{ margin: 0, fontSize: "var(--text-body)", color: "var(--steel)" }}>
                  {S.coverageEmpty}
                </p>
              )}
            </Link>
          ) : null}

          {myMetrics !== undefined ? (
            <Link
              to="/payroll"
              data-window-control="true"
              aria-label={S.myMetricsTitle}
              style={cardLinkStyle}
            >
              <h2 style={panelTitleStyle}>{S.myMetricsTitle}</h2>
              {latestPayLine ? (
                <div style={factRowStyle}>
                  <span style={{ color: "var(--steel)" }}>
                    {`${S.myMetricsPeriod} ${latestPayLine.period_start}`}
                  </span>
                  <StatusChip tone={payReady ? "ok" : "warn"} role="status">
                    {payReady ? S.myMetricsReady : S.myMetricsPending}
                  </StatusChip>
                </div>
              ) : (
                <p style={{ margin: 0, fontSize: "var(--text-body)", color: "var(--steel)" }}>
                  {S.myMetricsEmpty}
                </p>
              )}
            </Link>
          ) : null}
        </div>
      ) : null}

      {/* §4-25-⑥ / task ladder LAST resort: aggregates with no backing server
          endpoint (labor-cost ₩, contract profitability, AN-insights) are named
          honestly as pending, never rendered with fabricated numbers. */}
      <section style={panelStyle} aria-label={S.pendingTitle}>
        <h2 style={panelTitleStyle}>{S.pendingTitle}</h2>
        <div style={pendingRowStyle}>
          {pendingAggregates.map((name) => (
            <StatusChip key={name} tone="warn" role="status">
              {name}
            </StatusChip>
          ))}
        </div>
        <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--steel)" }}>
          {S.pendingReason}
        </p>
      </section>
    </div>
  );
}
