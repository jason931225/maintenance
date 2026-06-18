import { useCallback, useEffect, useState } from "react";

import type { OpsSummary } from "../api/types";
import { useAuth } from "../context/auth";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import { PageError } from "../components/states/PageError";
import { Card } from "../components/ui/card";
import { ko } from "../i18n/ko";

type ReadState = "idle" | "loading" | "error";

export function OpsDashboardPage() {
  const { api } = useAuth();
  const [summary, setSummary] = useState<OpsSummary>();
  const [readState, setReadState] = useState<ReadState>("loading");

  const loadData = useCallback(async () => {
    setReadState("loading");
    const response = await api
      .GET("/api/v1/ops/summary", {})
      .catch(() => undefined);
    if (!response?.data) {
      setReadState("error");
      return;
    }
    setSummary(response.data);
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
          <OpsContent summary={summary} />
        ) : readState === "loading" ? null : (
          <p className="rounded-md border border-dashed border-slate-300 p-4 text-sm text-slate-600">
            {ko.ops.empty}
          </p>
        )}
      </div>
    </>
  );
}

function OpsContent({ summary }: { summary: OpsSummary }) {
  const agingHint = ko.ops.alerts.agingHint.replace(
    "{hours}",
    String(summary.aging_hours),
  );
  return (
    <div className="grid gap-5">
      <FunnelCard summary={summary} />
      <AlertsCard summary={summary} agingHint={agingHint} />
      <div className="grid gap-5 lg:grid-cols-2">
        <EquipmentCard summary={summary} />
        <MechanicsCard summary={summary} />
      </div>
    </div>
  );
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
      <h2 className="mb-3 text-sm font-semibold text-slate-700">
        {ko.ops.funnel.title}
      </h2>
      <div className="grid gap-3 sm:grid-cols-4">
        {stages.map((stage) => (
          <div
            key={stage.labelKey}
            className="rounded-md border border-slate-200 bg-slate-50 p-3"
          >
            <p className="text-sm text-slate-600">
              {ko.ops.funnel[stage.labelKey]}
            </p>
            <p className="text-2xl font-bold text-slate-950">
              {stage.value}
              <span className="ml-1 text-sm font-normal text-slate-500">
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
  const alerts: { label: string; value: number; hint?: string; danger?: boolean }[] =
    [
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
      <h2 className="mb-3 text-sm font-semibold text-slate-700">
        {ko.ops.alerts.title}
      </h2>
      <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {alerts.map((alert) => (
          <div
            key={alert.label}
            className={
              alert.danger
                ? "rounded-md border border-red-200 bg-red-50 p-3"
                : "rounded-md border border-slate-200 bg-slate-50 p-3"
            }
          >
            <p className="text-sm text-slate-600">{alert.label}</p>
            <p
              className={
                alert.danger
                  ? "text-2xl font-bold text-red-700"
                  : "text-2xl font-bold text-slate-950"
              }
            >
              {alert.value}
            </p>
            {alert.hint ? (
              <p className="mt-0.5 text-xs text-slate-500">{alert.hint}</p>
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
      <h2 className="mb-3 text-sm font-semibold text-slate-700">
        {ko.ops.equipment.title}
      </h2>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {rows.map((row) => (
          <div
            key={row.labelKey}
            className="rounded-md border border-slate-200 bg-slate-50 p-3"
          >
            <dt className="text-sm text-slate-600">
              {ko.ops.equipment[row.labelKey]}
            </dt>
            <dd className="text-xl font-bold text-slate-950">{row.value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function MechanicsCard({ summary }: { summary: OpsSummary }) {
  return (
    <Card>
      <h2 className="mb-3 text-sm font-semibold text-slate-700">
        {ko.ops.mechanics.title}
      </h2>
      {summary.mechanic_load.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 p-3 text-sm text-slate-600">
          {ko.ops.mechanics.empty}
        </p>
      ) : (
        <ul className="grid gap-2">
          {summary.mechanic_load.map((mechanic) => (
            <li
              key={mechanic.mechanic_id}
              className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 px-3 py-2"
            >
              <span className="truncate text-sm font-medium text-slate-800">
                {mechanic.display_name}
              </span>
              <span className="ml-2 shrink-0 text-sm text-slate-600">
                {mechanic.active_assignments}
                <span className="ml-1 text-xs text-slate-500">
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
