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
import type { LaborCostLoadError } from "../../laborcost/LaborCostScreen";
import "../../tokens.css";

/**
 * 인건비 분석 screen body — composes LaborCostScreen into the console shell slot
 * (SCREEN_REGISTRY key "laborcost"). It owns the real payroll reads:
 * /api/v1/payroll/runs (per-period draft runs + status) and every rendered
 * run's /api/v1/payroll/runs/{id} pages (per-employee hour lines). It aggregates real
 * labor hours (정규/연장/야간/휴일) and projects the per-period total-hours trend
 * via POST /api/v1/analytics/projection. No fabricated data: ₩ cost is omitted
 * because payroll carries hours + readiness, not pay amounts.
 */

type PayrollLineSummary = components["schemas"]["PayrollLineSummary"];
type PayrollRunDetail = components["schemas"]["PayrollRunDetail"];

const bodyStyle: CSSProperties = {
  height: "100%",
  overflowY: "auto",
  padding: "var(--sp-6)",
  background: "var(--canvas)",
};

const RUNS_LIMIT = 12;
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

function validatePage(
  detail: PayrollRunDetail,
  runId: string,
  requestedOffset: number,
  expectedTotal: number | undefined,
) {
  const { lines, lines_limit: limit, lines_offset: offset, lines_total: total } = detail;
  if (
    detail.run.id !== runId ||
    !Number.isSafeInteger(total) ||
    total < 0 ||
    limit !== LINES_LIMIT ||
    offset !== requestedOffset ||
    lines.length > LINES_LIMIT ||
    requestedOffset > total ||
    requestedOffset + lines.length > total ||
    (expectedTotal !== undefined && total !== expectedTotal) ||
    (lines.length === 0 && requestedOffset < total)
  ) {
    throw new Error("Invalid payroll line page metadata");
  }
  return total;
}

async function loadAllRunLines(
  api: ReturnType<typeof useAuth>["api"],
  runId: string,
) {
  const lines: PayrollLineSummary[] = [];
  let offset = 0;
  let total: number | undefined;

  for (;;) {
    const response = await api.GET("/api/v1/payroll/runs/{id}", {
      params: { path: { id: runId }, query: { limit: LINES_LIMIT, offset } },
    });
    if (!response.data) throw new Error("Payroll run detail unavailable");

    total = validatePage(response.data, runId, offset, total);
    lines.push(...response.data.lines);
    offset += response.data.lines.length;
    if (offset === total) return lines;
  }
}

export function LaborCostBody() {
  const { api } = useAuth();
  const navigate = useNavigate();

  const [periods, setPeriods] = useState<readonly LaborCostPeriod[]>([]);
  const [hours, setHours] = useState<LaborHours>(ZERO_HOURS);
  const [trend, setTrend] = useState<readonly number[]>([]);
  const [projectionResult, setProjectionResult] = useState<BackendProjection>();
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<LaborCostLoadError | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  // Data load: runs strip + aggregated hours + the per-period total-hours
  // series. Cancellation guards prevent either list or detail results from
  // updating an unmounted or superseded screen.
  useEffect(() => {
    let cancelled = false;
    const isCancelled = () => cancelled;
    // Defer out of the synchronous effect body so the initial setIsLoading(true)
    // does not cascade a render (react-hooks/set-state-in-effect).
    void Promise.resolve().then(async () => {
      setIsLoading(true);
      setLoadError(null);
      setPeriods([]);
      setHours({ ...ZERO_HOURS });
      setTrend([]);
      setProjectionResult(undefined);

      let runs;
      try {
        const runsRes = await api.GET("/api/v1/payroll/runs", {
          params: { query: { limit: RUNS_LIMIT, offset: 0 } },
        });
        if (!runsRes.data) throw new Error("Payroll run list unavailable");
        runs = runsRes.data.items;
      } catch {
        if (!isCancelled()) {
          setLoadError("list");
          setIsLoading(false);
        }
        return;
      }
      if (isCancelled()) return;

      // Strip is newest-period first (most recent payroll run leads). A
      // successful list stays visible even if a required detail page fails.
      setPeriods(
        runs.map((run) => ({
          runId: run.id,
          periodLabel: run.period_start,
          status: run.status,
        })),
      );

      // Aggregate hours + build the per-period series from every rendered run,
      // ordered oldest-first so the projection reads the true time order.
      const orderedRuns = [...runs].sort((a, b) =>
        a.period_start < b.period_start ? -1 : 1,
      );
      let details: PayrollLineSummary[][];
      try {
        details = await Promise.all(
          orderedRuns.map((run) => loadAllRunLines(api, run.id)),
        );
      } catch {
        if (!isCancelled()) {
          setLoadError("detail");
          setIsLoading(false);
        }
        return;
      }
      if (isCancelled()) return;

      const agg: LaborHours = { ...ZERO_HOURS };
      const series: number[] = [];
      for (const lines of details) {
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
      setHours(agg);
      setTrend(series);
      setIsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [api, loadAttempt]);

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
        loadError={loadError}
        onRetry={() => {
          setLoadAttempt((attempt) => attempt + 1);
        }}
        onDrill={() => {
          void navigate("/payroll");
        }}
      />
    </div>
  );
}
