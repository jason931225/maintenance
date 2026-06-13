import { useEffect, useMemo } from "react";

import type { KpiReport, WorkOrderListItem } from "../../api/types";
import { Badge } from "../../components/ui/badge";
import { ko } from "../../i18n/ko";
import { formatBps, formatCount, formatSeconds } from "./kpi-format";

interface WallBoardProps {
  report?: KpiReport;
  workOrders: WorkOrderListItem[];
  isLoading: boolean;
  refreshIntervalMs: number;
  onRefresh: () => void | Promise<void>;
  now?: Date;
}

const approvalStatuses: WorkOrderListItem["status"][] = [
  "REPORT_SUBMITTED",
  "ADMIN_REVIEW",
];
const openStatuses = new Set<WorkOrderListItem["status"]>([
  "RECEIVED",
  "UNASSIGNED",
  "ASSIGNED",
  "IN_PROGRESS",
  "REPORT_SUBMITTED",
  "ADMIN_REVIEW",
  "ON_HOLD",
  "DELAYED",
  "TEMPORARY_ACTION",
  "PART_WAITING",
  "EQUIPMENT_IN_USE",
  "REVISIT_REQUIRED",
]);

export function WallBoard({
  report,
  workOrders,
  isLoading,
  refreshIntervalMs,
  onRefresh,
  now = new Date(),
}: WallBoardProps) {
  useEffect(() => {
    const refresh = window.setInterval(() => {
      void onRefresh();
    }, refreshIntervalMs);

    return () => {
      window.clearInterval(refresh);
    };
  }, [onRefresh, refreshIntervalMs]);

  const exceptions = useMemo(
    () => countExceptions(workOrders, now),
    [now, workOrders],
  );
  const rollup =
    report?.rollups.find((item) => item.scope.kind === "company") ??
    report?.rollups[0];

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-6 text-white lg:px-10">
      <section className="mx-auto grid max-w-7xl gap-8">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-4xl font-bold leading-tight lg:text-6xl">
              {ko.wallboard.title}
            </h1>
            <p className="mt-3 text-lg text-slate-300">
              {ko.wallboard.updatedAt}: {formatWallboardTime(now)}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge className="min-h-10 border-slate-600 bg-slate-900 px-3 text-slate-100">
              {ko.wallboard.refresh}{" "}
              {String(Math.round(refreshIntervalMs / 1_000))}
              {ko.common.secondUnit}
            </Badge>
            {isLoading ? (
              <Badge role="status" className="min-h-10 border-slate-600 bg-slate-900 px-3 text-slate-100">
                {ko.common.loading}
              </Badge>
            ) : null}
          </div>
        </header>

        <section
          aria-labelledby="wallboard-exceptions"
          aria-live="polite"
          className="grid gap-4"
        >
          <h2 id="wallboard-exceptions" className="text-xl font-semibold text-slate-200">
            {ko.wallboard.exceptionStrip}
          </h2>
          <div className="grid gap-4 md:grid-cols-3">
            <ExceptionTile
              label={ko.wallboard.urgentUnassigned}
              value={exceptions.urgentUnassigned}
              tone="red"
            />
            <ExceptionTile
              label={ko.wallboard.awaitingApproval}
              value={exceptions.awaitingApproval}
              tone="amber"
            />
            <ExceptionTile
              label={ko.wallboard.overdue}
              value={exceptions.overdue}
              tone="sky"
            />
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-3">
          <MetricTile
            label={ko.wallboard.completedToday}
            value={rollup ? formatCount(rollup.completed_count) : ko.common.notSet}
          />
          <MetricTile
            label={ko.wallboard.responseSpeed}
            value={rollup ? formatSeconds(rollup.average_response_seconds) : ko.common.notSet}
          />
          <MetricTile
            label={ko.kpi.dueCompliance}
            value={rollup ? formatBps(rollup.target_due_compliance_bps) : ko.common.notSet}
          />
        </section>
      </section>
    </main>
  );
}

function ExceptionTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "red" | "amber" | "sky";
}) {
  return (
    <article className={`rounded-lg border p-5 ${exceptionToneClass(tone)}`}>
      <p className="text-xl font-semibold">{label}</p>
      <p className="mt-4 text-7xl font-bold leading-none">{value}</p>
    </article>
  );
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <article className="rounded-lg border border-slate-700 bg-slate-900 p-5">
      <p className="text-lg font-semibold text-slate-300">{label}</p>
      <p className="mt-4 text-5xl font-bold leading-none text-white">{value}</p>
    </article>
  );
}

function countExceptions(workOrders: WorkOrderListItem[], now: Date) {
  return {
    urgentUnassigned: workOrders.filter(
      (workOrder) =>
        workOrder.priority === "P1" &&
        (workOrder.status === "RECEIVED" || workOrder.status === "UNASSIGNED") &&
        workOrder.assignments.length === 0,
    ).length,
    awaitingApproval: workOrders.filter((workOrder) =>
      approvalStatuses.includes(workOrder.status),
    ).length,
    overdue: workOrders.filter((workOrder) => {
      if (!workOrder.target_due_at || !openStatuses.has(workOrder.status)) {
        return false;
      }
      return new Date(workOrder.target_due_at).getTime() < now.getTime();
    }).length,
  };
}

function exceptionToneClass(tone: "red" | "amber" | "sky") {
  switch (tone) {
    case "red":
      return "border-red-400 bg-red-950 text-red-50";
    case "amber":
      return "border-amber-300 bg-amber-950 text-amber-50";
    case "sky":
      return "border-sky-300 bg-sky-950 text-sky-50";
  }
}

function formatWallboardTime(value: Date) {
  return value.toISOString().slice(0, 16).replace("T", " ");
}
