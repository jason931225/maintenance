import { useEffect, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import type { components } from "@maintenance/api-client-ts";

import { useAuth } from "../../../context/auth";
import type { BackendProjection } from "../../charts";
import {
  LaborCostScreen,
  type LaborCostPeriod,
  type LaborHours,
} from "../../laborcost";
import "../../tokens.css";

/**
 * 인건비 분석 screen body — composes LaborCostScreen into the console shell slot
 * (SCREEN_REGISTRY key "laborcost"). It owns the real payroll reads:
 * /api/v1/payroll/runs (per-period draft runs + status) and, for the recent
 * runs, /api/v1/payroll/runs/{id} (per-employee hour lines). It aggregates real
 * labor hours (정규/연장/야간/휴일) and projects the per-period total-hours trend
 * via POST /api/v1/analytics/projection. No fabricated data: ₩ cost is omitted
 * because payroll carries hours + readiness, not pay amounts.
 */

type PayrollLineSummary = components["schemas"]["PayrollLineSummary"];

const bodyStyle: CSSProperties = {
  height: "100%",
  overflowY: "auto",
  padding: "var(--sp-6)",
  background: "var(--canvas)",
};

const RUNS_LIMIT = 12;
// Bound the per-run detail fan-out so the trend/composition load stays cheap.
const DETAIL_RUNS = 6;
const LINES_LIMIT = 500;

const ZERO_HOURS: LaborHours = { regular: 0, overtime: 0, night: 0, holiday: 0 };

function hoursOf(line: PayrollLineSummary): number {
  return (
    (line.regular_hours ?? 0) +
    (line.overtime_hours ?? 0) +
    (line.night_hours ?? 0) +
    (line.holiday_hours ?? 0)
  );
}

export function LaborCostBody() {
  const { api } = useAuth();
  const navigate = useNavigate();

  const [periods, setPeriods] = useState<readonly LaborCostPeriod[]>([]);
  const [hours, setHours] = useState<LaborHours>(ZERO_HOURS);
  const [trend, setTrend] = useState<readonly number[]>([]);
  const [projectionResult, setProjectionResult] = useState<BackendProjection>();
  const [isLoading, setIsLoading] = useState(true);

  // Data load: runs strip + aggregated hours + the per-period total-hours
  // series. Both awaits complete before the single cancel guard (one guard per
  // effect keeps TS narrowing sound; mirrors the DashboardBody idiom).
  useEffect(() => {
    let cancelled = false;
    // Defer out of the synchronous effect body so the initial setIsLoading(true)
    // does not cascade a render (react-hooks/set-state-in-effect).
    void Promise.resolve().then(async () => {
      setIsLoading(true);
      const runsRes = await api
        .GET("/api/v1/payroll/runs", { params: { query: { limit: RUNS_LIMIT, offset: 0 } } })
        .catch(() => undefined);
      const runs = runsRes?.data?.items ?? [];
      // Aggregate hours + build the per-period series from the recent runs,
      // ordered oldest-first so the projection reads the true time order.
      const recent = [...runs]
        .slice(0, DETAIL_RUNS)
        .sort((a, b) => (a.period_start < b.period_start ? -1 : 1));
      const details = await Promise.all(
        recent.map((run) =>
          api
            .GET("/api/v1/payroll/runs/{id}", {
              params: { path: { id: run.id }, query: { limit: LINES_LIMIT, offset: 0 } },
            })
            .catch(() => undefined),
        ),
      );
      if (cancelled) return;

      const agg: LaborHours = { ...ZERO_HOURS };
      const series: number[] = [];
      for (const detail of details) {
        const lines = detail?.data?.lines ?? [];
        let runTotal = 0;
        for (const line of lines) {
          agg.regular += line.regular_hours ?? 0;
          agg.overtime += line.overtime_hours ?? 0;
          agg.night += line.night_hours ?? 0;
          agg.holiday += line.holiday_hours ?? 0;
          runTotal += hoursOf(line);
        }
        series.push(runTotal);
      }
      // Strip is newest-period first (most recent payroll run leads).
      setPeriods(
        runs.map((run) => ({
          runId: run.id,
          periodLabel: run.period_start,
          status: run.status,
        })),
      );
      setHours(agg);
      setTrend(series);
      setIsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Backend labor-hours projection (percent kind) over the real per-period
  // totals. Needs ≥3 periods; below that the panel omits the projection.
  useEffect(() => {
    let cancelled = false;
    if (trend.length < 3) {
      void Promise.resolve().then(() => {
        if (!cancelled) setProjectionResult(undefined);
      });
      return () => {
        cancelled = true;
      };
    }
    void api
      .POST("/api/v1/analytics/projection", {
        body: { series: [...trend], horizon: trend.length, kind: "percent" },
      })
      .then((res) => {
        if (!cancelled) setProjectionResult(res.data);
      })
      .catch(() => {
        if (!cancelled) setProjectionResult(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [api, trend]);

  return (
    <div className="console" data-cshell-screen-body="laborcost" style={bodyStyle}>
      <LaborCostScreen
        periods={periods}
        hours={hours}
        trend={trend}
        projectionResult={projectionResult}
        isLoading={isLoading}
        onDrill={() => {
          void navigate("/payroll");
        }}
      />
    </div>
  );
}
