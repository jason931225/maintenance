import { useEffect, useMemo, useState } from "react";

import type {
  KpiMetric,
  KpiReport,
  KpiRollup,
  UnavailableMetric,
} from "../../api/types";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { ko } from "../../i18n/ko";
import {
  formatBps,
  formatCount,
  formatPoints,
  formatSeconds,
  scopeKey,
} from "./kpi-format";

interface KpiDashboardProps {
  report?: KpiReport;
  period: string;
  isLoading: boolean;
  onPeriodChange: (period: string) => void;
}

interface MetricCard {
  metric: KpiMetric;
  value: string;
  detail: string;
  unavailable?: UnavailableMetric;
}

const periodPattern = /^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/;
const periodDebounceMs = 400;

const metricOrder: KpiMetric[] = [
  "completed_count",
  "average_response_speed",
  "completion_duration_and_due_compliance",
  "revisit_rate",
  "delay_rate_and_reason_distribution",
  "inspection_plan_completion_rate",
  "p1_acceptance_rate",
];

export function KpiDashboard({
  report,
  period,
  isLoading,
  onPeriodChange,
}: KpiDashboardProps) {
  const [selectedScopeKey, setSelectedScopeKey] = useState<string>();
  const [periodDraft, setPeriodDraft] = useState(period);
  const periodValid = periodPattern.test(periodDraft.trim());

  useEffect(() => {
    const trimmed = periodDraft.trim();
    if (trimmed === period || !periodPattern.test(trimmed)) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      onPeriodChange(trimmed);
    }, periodDebounceMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [onPeriodChange, period, periodDraft]);

  const defaultScopeKey = useMemo(() => {
    if (!report) {
      return "";
    }

    const requestedScopeKey = scopeKey(report.requested_scope);
    return report.rollups.some(
      (rollup) => scopeKey(rollup.scope) === requestedScopeKey,
    )
      ? requestedScopeKey
      : scopeKey(report.rollups[0]?.scope);
  }, [report]);
  const effectiveScopeKey =
    selectedScopeKey &&
    report?.rollups.some((rollup) => scopeKey(rollup.scope) === selectedScopeKey)
      ? selectedScopeKey
      : defaultScopeKey;
  const selectedRollup = useMemo(
    () =>
      report?.rollups.find(
        (rollup) => scopeKey(rollup.scope) === effectiveScopeKey,
      ) ?? report?.rollups[0],
    [effectiveScopeKey, report],
  );

  const metricCards = useMemo(() => {
    if (!selectedRollup || !report) {
      return [];
    }
    return buildMetricCards(selectedRollup, report.unavailable_metrics);
  }, [report, selectedRollup]);

  return (
    <section className="grid gap-4 rounded-lg border border-line bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">
            {ko.kpi.title}
          </h2>
          <p className="mt-1 text-sm text-steel">
            {selectedRollup
              ? `${ko.kpi.approvedReports} ${formatCount(selectedRollup.approved_report_count)} · ${ko.kpi.weightedPoints} ${formatPoints(selectedRollup.weighted_completed_points)}`
              : ko.kpi.noReport}
          </p>
        </div>
        {isLoading ? (
          <Badge role="status" className="bg-muted-panel">
            {ko.common.loading}
          </Badge>
        ) : null}
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(16rem,20rem)_1fr]">
        <label className="grid gap-2 text-sm font-medium text-steel">
          {ko.kpi.period}
          <Input
            aria-label={ko.kpi.period}
            placeholder={ko.kpi.periodPlaceholder}
            value={periodDraft}
            aria-invalid={!periodValid}
            aria-describedby={
              periodValid ? "kpi-period-hint" : "kpi-period-error"
            }
            onChange={(event) => {
              setPeriodDraft(event.currentTarget.value);
            }}
          />
          {periodValid ? (
            <span id="kpi-period-hint" className="text-xs font-normal text-steel">
              {ko.kpi.periodHint}
            </span>
          ) : (
            <span
              id="kpi-period-error"
              role="alert"
              className="text-xs font-medium text-red-700"
            >
              {ko.kpi.periodInvalid}
            </span>
          )}
        </label>
        {report ? (
          <div className="grid gap-2">
            <p className="text-sm font-medium text-steel">{ko.kpi.rollup}</p>
            <div
              role="group"
              aria-label={ko.kpi.rollupGroup}
              className="flex flex-wrap gap-2"
            >
              {report.rollups.map((rollup) => {
                const key = scopeKey(rollup.scope);
                const selected = key === scopeKey(selectedRollup?.scope);
                return (
                  <Button
                    key={key}
                    type="button"
                    variant={selected ? "default" : "secondary"}
                    onClick={() => {
                      setSelectedScopeKey(key);
                    }}
                    aria-pressed={selected}
                    aria-label={ko.kpi.scopeActions[rollup.scope.kind]}
                  >
                    {ko.kpi.scopes[rollup.scope.kind]}
                  </Button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>

      {metricCards.length === 0 ? (
        <p className="rounded-md border border-dashed border-line p-4 text-sm text-steel">
          {ko.kpi.noReport}
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {metricCards.map((card) => (
            <article
              key={card.metric}
              className="grid min-h-36 content-between gap-3 rounded-md border border-line bg-muted-panel p-3"
            >
              <div>
                <h3 className="text-sm font-semibold text-steel">
                  {ko.kpi.metrics[card.metric]}
                </h3>
                <p className="mt-3 text-2xl font-bold text-ink">
                  {card.value}
                </p>
              </div>
              <p className="text-sm leading-5 text-steel">{card.detail}</p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function buildMetricCards(
  rollup: KpiRollup,
  unavailableMetrics: UnavailableMetric[],
): MetricCard[] {
  const unavailableByMetric = new Map(
    unavailableMetrics.map((metric) => [metric.metric, metric]),
  );

  return metricOrder.map((metric) => {
    const unavailable = unavailableByMetric.get(metric);
    if (unavailable) {
      return {
        metric,
        value: ko.kpi.unavailable,
        detail: unavailable.reason,
        unavailable,
      };
    }

    switch (metric) {
      case "completed_count":
        return {
          metric,
          value: formatCount(rollup.completed_count),
          detail: `${ko.kpi.weightedPoints} ${formatPoints(rollup.weighted_completed_points)}`,
        };
      case "average_response_speed":
        return {
          metric,
          value: formatSeconds(rollup.average_response_seconds),
          detail: ko.kpi.metricDetails,
        };
      case "completion_duration_and_due_compliance":
        return {
          metric,
          value: formatSeconds(rollup.average_completion_seconds),
          detail: `${ko.kpi.dueCompliance}: ${formatBps(rollup.target_due_compliance_bps)}`,
        };
      case "revisit_rate":
        return {
          metric,
          value: formatBps(rollup.revisit_rate_bps),
          detail: ko.kpi.metricDetails,
        };
      case "delay_rate_and_reason_distribution":
        return {
          metric,
          value: formatBps(rollup.delay_rate_bps),
          detail: formatDelayReason(rollup.delay_reason_distribution),
        };
      case "inspection_plan_completion_rate":
        return {
          metric,
          value: formatBps(rollup.inspection_plan_completion_bps),
          detail: `${ko.kpi.inspectionPlanScheduled}: ${formatCount(
            rollup.inspection_schedule_completed_count,
          )}/${formatCount(rollup.inspection_schedule_due_count)}`,
        };
      case "p1_acceptance_rate":
        return {
          metric,
          value: formatBps(rollup.p1_acceptance_bps),
          detail: `${ko.kpi.p1Accepted}: ${formatCount(
            rollup.p1_accepted_count,
          )}/${formatCount(rollup.p1_dispatch_count)}`,
        };
    }
  });
}

function formatDelayReason(distribution: Record<string, number>) {
  const entries = Object.entries(distribution).sort(
    (left, right) => right[1] - left[1],
  );

  if (entries.length === 0) {
    return ko.kpi.noDelayReason;
  }

  const [reason, count] = entries[0];
  return `${ko.kpi.topDelayReason}: ${reason} ${formatCount(count)}`;
}
