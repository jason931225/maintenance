import { Link } from "react-router-dom";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";

import type { ConsoleApiClient } from "../api/client";
import type {
  AttendanceSummaryPage,
  EmployeeDirectoryItem,
  EmployeeDirectoryPage,
  HrReadinessSummary,
} from "../api/types";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import { isNavItemVisible } from "../components/shell/nav";
import { PageError } from "../components/states/PageError";
import { SkeletonTable } from "../components/states/Skeleton";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { useAuth } from "../context/auth";
import { ko } from "../i18n/ko";
import {
  devAttendanceSummaryPage,
  devEmployeeDirectoryPage,
  devHrReadinessSummary,
  isDevPreviewEnabled,
} from "../lib/dev-preview";
import { formatListCount } from "../lib/utils";

type LoadState = "loading" | "idle" | "error";

interface PayrollLedgerRow {
  id: string;
  company: string;
  employee: string;
  employeeNumber: string;
  worksite: string;
  attendanceEvents: number;
  workDays: number;
  regularHours: number;
  overtimeHours: number;
  leaveUsed: string;
  leaveRemaining: string;
  grossSource: string;
  netSource: string;
  status: string;
}

type PayrollApi = ConsoleApiClient & {
  GET(path: "/api/v1/hr/readiness-summary"): Promise<{
    data?: HrReadinessSummary;
  }>;
  GET(
    path: "/api/v1/hr/attendance-summary",
    options?: { params?: { query?: { limit?: number; offset?: number } } },
  ): Promise<{ data?: AttendanceSummaryPage }>;
  GET(
    path: "/api/v1/employees",
    options?: {
      params?: {
        query?: { limit?: number; offset?: number; company?: string };
      };
    },
  ): Promise<{ data?: EmployeeDirectoryPage }>;
};

const copy = ko.payroll;

export function PayrollPage() {
  const { api, session } = useAuth();
  const payrollApi = api as PayrollApi;
  const [state, setState] = useState<LoadState>("loading");
  const [readiness, setReadiness] = useState<HrReadinessSummary>();
  const [attendance, setAttendance] = useState<AttendanceSummaryPage>();
  const [employees, setEmployees] = useState<EmployeeDirectoryItem[]>([]);
  const [employeeTotal, setEmployeeTotal] = useState(0);

  const loadPayroll = useCallback(async () => {
    setState("loading");
    if (isDevPreviewEnabled()) {
      const devEmployees = devEmployeeDirectoryPage();
      setReadiness(devHrReadinessSummary());
      setAttendance(devAttendanceSummaryPage());
      setEmployees(devEmployees.items);
      setEmployeeTotal(devEmployees.total);
      setState("idle");
      return;
    }
    const [readinessResponse, attendanceResponse, employeesResponse] =
      await Promise.all([
        payrollApi.GET("/api/v1/hr/readiness-summary").catch(() => undefined),
        payrollApi
          .GET("/api/v1/hr/attendance-summary", {
            params: { query: { limit: 1000, offset: 0 } },
          })
          .catch(() => undefined),
        payrollApi
          .GET("/api/v1/employees", {
            params: { query: { limit: 1000, offset: 0 } },
          })
          .catch(() => undefined),
      ]);

    if (
      !readinessResponse?.data ||
      !attendanceResponse?.data ||
      !employeesResponse?.data
    ) {
      setState("error");
      return;
    }

    setReadiness(readinessResponse.data);
    setAttendance(attendanceResponse.data);
    setEmployees(employeesResponse.data.items);
    setEmployeeTotal(employeesResponse.data.total);
    setState("idle");
  }, [payrollApi]);

  useEffect(() => {
    void Promise.resolve().then(loadPayroll);
  }, [loadPayroll]);

  const activeEmployees = useMemo(
    () => employees.filter((employee) => employee.status === "ACTIVE").length,
    [employees],
  );
  const ledgerRows = useMemo(
    () =>
      readiness ? buildPayrollLedgerRows(employees, attendance, readiness) : [],
    [attendance, employees, readiness],
  );

  return (
    <>
      <PageHeader
        title={copy.title}
        description={copy.description}
        actions={
          <RefreshButton
            onClick={() => {
              void loadPayroll();
            }}
            isLoading={state === "loading"}
          />
        }
      />

      <div className="grid max-w-6xl gap-5">
        {state === "loading" ? <SkeletonTable rows={4} cols={6} /> : null}
        {state === "error" ? (
          <PageError
            message={copy.loadFailed}
            onRetry={() => {
              void loadPayroll();
            }}
          />
        ) : null}
        {state === "idle" && readiness ? (
          <>
            <PayrollReadinessPanel
              readiness={readiness}
              attendance={attendance}
              activeEmployees={activeEmployees}
              employeeTotal={employeeTotal}
            />
            <PayrollLedgerPanel rows={ledgerRows} readiness={readiness} />
            <PayrollFlowPanel
              readiness={readiness}
              attendance={attendance}
              roles={session?.roles}
              groupRoles={session?.group_roles}
              featureGrants={session?.feature_grants}
            />
            <PayrollPlanPanel
              roles={session?.roles}
              groupRoles={session?.group_roles}
              featureGrants={session?.feature_grants}
            />
          </>
        ) : null}
      </div>
    </>
  );
}

function PayrollLedgerPanel({
  rows,
  readiness,
}: {
  rows: PayrollLedgerRow[];
  readiness: HrReadinessSummary;
}) {
  return (
    <Card className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">
            {copy.sections.ledger}
          </h2>
          <p className="text-sm text-steel">{copy.sections.ledgerDescription}</p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            downloadPayrollLedger(rows, readiness);
          }}
          disabled={rows.length === 0}
        >
          <Download size={16} aria-hidden="true" />
          {copy.actions.downloadLedger}
        </Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[980px] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs font-semibold text-steel">
              <th className="px-3 py-2">{copy.ledgerColumns.company}</th>
              <th className="px-3 py-2">{copy.ledgerColumns.employee}</th>
              <th className="px-3 py-2">{copy.ledgerColumns.worksite}</th>
              <th className="px-3 py-2 text-right">
                {copy.ledgerColumns.attendanceEvents}
              </th>
              <th className="px-3 py-2 text-right">
                {copy.ledgerColumns.workDays}
              </th>
              <th className="px-3 py-2 text-right">
                {copy.ledgerColumns.regularHours}
              </th>
              <th className="px-3 py-2 text-right">
                {copy.ledgerColumns.overtimeHours}
              </th>
              <th className="px-3 py-2 text-right">
                {copy.ledgerColumns.leaveUsed}
              </th>
              <th className="px-3 py-2 text-right">
                {copy.ledgerColumns.leaveRemaining}
              </th>
              <th className="px-3 py-2">{copy.ledgerColumns.grossSource}</th>
              <th className="px-3 py-2">{copy.ledgerColumns.netSource}</th>
              <th className="px-3 py-2">{copy.ledgerColumns.status}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-line last:border-0">
                <td className="px-3 py-2">{row.company}</td>
                <td className="px-3 py-2">
                  <span className="font-medium text-ink">{row.employee}</span>
                  <span className="ml-2 text-xs text-steel">
                    {row.employeeNumber}
                  </span>
                </td>
                <td className="px-3 py-2">{row.worksite}</td>
                <td className="px-3 py-2 text-right">{row.attendanceEvents}</td>
                <td className="px-3 py-2 text-right">{row.workDays}</td>
                <td className="px-3 py-2 text-right">{row.regularHours}</td>
                <td className="px-3 py-2 text-right">{row.overtimeHours}</td>
                <td className="px-3 py-2 text-right">{row.leaveUsed}</td>
                <td className="px-3 py-2 text-right">{row.leaveRemaining}</td>
                <td className="px-3 py-2">{row.grossSource}</td>
                <td className="px-3 py-2">{row.netSource}</td>
                <td className="px-3 py-2">{row.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function PayrollReadinessPanel({
  readiness,
  attendance,
  activeEmployees,
  employeeTotal,
}: {
  readiness: HrReadinessSummary;
  attendance?: AttendanceSummaryPage;
  activeEmployees: number;
  employeeTotal: number;
}) {
  const statusEnabled = readiness.payroll.calculation_enabled_runs > 0;
  const statusLabel =
    readiness.payroll.latest_status ??
    (statusEnabled ? copy.status.enabled : copy.status.noRun);
  const latestPeriod =
    readiness.payroll.latest_period_start && readiness.payroll.latest_period_end
      ? `${readiness.payroll.latest_period_start} - ${readiness.payroll.latest_period_end}`
      : "-";
  const summaryCards = [
    {
      label: copy.summary.employees,
      value: formatListCount(employeeTotal),
      meta: `${copy.summary.activeEmployees} ${formatListCount(activeEmployees)}`,
    },
    {
      label: copy.summary.payrollDraftLines,
      value: formatListCount(readiness.payroll.draft_lines),
      meta: `${copy.fields.blockedRuns} ${formatListCount(readiness.payroll.blocked_runs)}`,
    },
    {
      label: copy.summary.payrollSourceRows,
      value: formatListCount(readiness.payroll.payroll_source_rows),
      meta: `${copy.fields.grossLines} ${formatListCount(readiness.payroll.gross_pay_source_lines)} / ${copy.fields.netLines} ${formatListCount(readiness.payroll.net_pay_source_lines)}`,
    },
    {
      label: copy.summary.attendanceRows,
      value: formatListCount(readiness.payroll.attendance_source_rows),
      meta: `${copy.fields.attendanceLinks} ${formatListCount(readiness.payroll.attendance_event_links)}`,
    },
    {
      label: copy.summary.durableAttendance,
      value: formatListCount(readiness.attendance.durable_events),
      meta: `${copy.fields.attendanceUsers} ${formatListCount(attendance?.total ?? 0)}`,
    },
    {
      label: copy.summary.annualLeave,
      value: formatListCount(readiness.annual_leave.obligations),
      meta: `${copy.summary.reviewNeeds} ${formatListCount(readiness.annual_leave.needs_review)}`,
    },
  ];

  return (
    <Card className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">
            {copy.sections.readiness}
          </h2>
          <p className="text-sm text-steel">
            {copy.sections.readinessDescription}
          </p>
        </div>
        <span
          className={[
            "inline-flex rounded-full px-3 py-1 text-xs font-semibold",
            statusEnabled
              ? "bg-emerald-100 text-emerald-800"
              : "bg-amber-100 text-amber-900",
          ].join(" ")}
        >
          {statusEnabled ? copy.status.enabled : copy.status.blocked}
        </span>
      </div>

      <dl className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {summaryCards.map((card) => (
          <div
            key={card.label}
            className="rounded-lg border border-line bg-muted-panel/50 p-3"
          >
            <dt className="text-xs font-semibold uppercase tracking-wide text-steel">
              {card.label}
            </dt>
            <dd className="mt-1 text-2xl font-semibold text-ink">
              {card.value}
            </dd>
            <dd className="mt-1 text-xs text-steel">{card.meta}</dd>
          </div>
        ))}
      </dl>

      <dl className="grid gap-3 rounded-lg border border-line bg-white p-3 text-sm lg:grid-cols-4">
        <div>
          <dt className="font-semibold text-steel">{copy.fields.latestSource}</dt>
          <dd className="text-ink">{display(readiness.payroll.latest_source_label)}</dd>
        </div>
        <div>
          <dt className="font-semibold text-steel">{copy.fields.period}</dt>
          <dd className="text-ink">{latestPeriod}</dd>
        </div>
        <div>
          <dt className="font-semibold text-steel">{copy.fields.latestImport}</dt>
          <dd className="text-ink">{display(readiness.imports.latest_import_at)}</dd>
        </div>
        <div>
          <dt className="font-semibold text-steel">
            {copy.fields.latestPayrollUpdate}
          </dt>
          <dd className="text-ink">
            {display(readiness.payroll.latest_updated_at ?? statusLabel)}
          </dd>
        </div>
      </dl>
    </Card>
  );
}

function PayrollFlowPanel({
  readiness,
  attendance,
  roles,
  groupRoles,
  featureGrants,
}: {
  readiness: HrReadinessSummary;
  attendance?: AttendanceSummaryPage;
  roles?: readonly string[];
  groupRoles?: readonly string[];
  featureGrants?: readonly string[];
}) {
  const flowItems = copy.flowItems;
  const flow = [
    {
      title: flowItems.employeeLedger.title,
      metric: `${formatListCount(readiness.imports.ledger_rows)}${copy.units.rows}`,
      description: flowItems.employeeLedger.description,
      href: "/settings/employees",
      navKey: "employees",
      action: copy.actions.employees,
    },
    {
      title: flowItems.attendanceCapture.title,
      metric: `${formatListCount(readiness.attendance.durable_events)}${copy.units.cases}`,
      description: flowItems.attendanceCapture.description,
    },
    {
      title: flowItems.approvalAdjustments.title,
      metric: `${formatListCount(readiness.annual_leave.obligations)}${copy.units.cases}`,
      description: flowItems.approvalAdjustments.description,
      href: "/approvals",
      navKey: "approvals",
      action: copy.actions.approvals,
    },
    {
      title: flowItems.calculationLock.title,
      metric: `${formatListCount(readiness.payroll.draft_lines)}${copy.units.lines}`,
      description: flowItems.calculationLock.description,
    },
    {
      title: flowItems.kpiFeedback.title,
      metric: `${formatListCount(attendance?.total ?? 0)}${copy.units.people}`,
      description: flowItems.kpiFeedback.description,
      href: "/kpi?source=payroll",
      navKey: "kpi",
      action: copy.actions.kpi,
    },
  ];

  return (
    <Card className="grid gap-4">
      <div>
        <h2 className="text-lg font-semibold text-ink">{copy.sections.flow}</h2>
        <p className="text-sm text-steel">{copy.sections.flowDescription}</p>
      </div>
      <div className="grid gap-3 lg:grid-cols-5">
        {flow.map((item) => (
          <section
            key={item.title}
            className="grid content-between gap-3 rounded-lg border border-line bg-white p-3"
          >
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-steel">
                {item.title}
              </p>
              <p className="mt-1 text-xl font-semibold text-ink">
                {item.metric}
              </p>
              <p className="mt-2 text-xs leading-5 text-steel">
                {item.description}
              </p>
            </div>
            {item.href && item.navKey ? (
              <GuardedActionLink
                href={item.href}
                navKey={item.navKey}
                label={item.action}
                roles={roles}
                groupRoles={groupRoles}
                featureGrants={featureGrants}
              />
            ) : null}
          </section>
        ))}
      </div>
    </Card>
  );
}

function GuardedActionLink({
  href,
  navKey,
  label,
  roles,
  groupRoles,
  featureGrants,
}: {
  href: string;
  navKey: string;
  label: string;
  roles?: readonly string[];
  groupRoles?: readonly string[];
  featureGrants?: readonly string[];
}) {
  const visible = isNavItemVisible(navKey, roles, groupRoles, featureGrants);
  if (!visible) {
    return (
      <span className="inline-flex min-h-8 items-center justify-center rounded border border-line bg-muted-panel px-2 py-1 text-xs font-semibold text-steel">
        {copy.actions.unavailable}
      </span>
    );
  }
  return (
    <Button asChild type="button" variant="secondary" size="xs">
      <Link to={href}>{label}</Link>
    </Button>
  );
}

function PayrollPlanPanel({
  roles,
  groupRoles,
  featureGrants,
}: {
  roles?: readonly string[];
  groupRoles?: readonly string[];
  featureGrants?: readonly string[];
}) {
  return (
    <Card className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">
            {copy.sections.plan}
          </h2>
          <p className="text-sm text-steel">{copy.sections.planDescription}</p>
        </div>
        <GuardedActionLink
          href="/settings/workflows"
          navKey="workflows"
          label={copy.actions.workflows}
          roles={roles}
          groupRoles={groupRoles}
          featureGrants={featureGrants}
        />
      </div>
      <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {copy.planItems.map((item, index) => (
          <li
            key={item.title}
            className="rounded-lg border border-line bg-muted-panel/50 p-3"
          >
            <p className="text-xs font-semibold uppercase tracking-wide text-steel">
              {String(index + 1).padStart(2, "0")}
            </p>
            <h3 className="mt-1 font-semibold text-ink">{item.title}</h3>
            <p className="mt-2 text-xs leading-5 text-steel">
              {item.description}
            </p>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function display(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}

function buildPayrollLedgerRows(
  employees: EmployeeDirectoryItem[],
  attendance: AttendanceSummaryPage | undefined,
  readiness: HrReadinessSummary,
): PayrollLedgerRow[] {
  const attendanceByName = new Map(
    (attendance?.items ?? []).map((item) => [item.display_name, item]),
  );
  return employees.map((employee, index) => {
    const attendanceItem = attendanceByName.get(employee.name);
    const attendanceEvents =
      (attendanceItem?.arrivals ?? 0) + (attendanceItem?.departures ?? 0);
    const workDays = Math.min(
      readiness.payroll.attendance_source_rows || 0,
      Math.floor(attendanceEvents / 2),
    );
    const payrollSourceConnected = index < readiness.payroll.payroll_source_rows;
    const regularHours = workDays * 8;
    const status =
      employee.status !== "ACTIVE"
        ? copy.ledgerStatus.exited
        : payrollSourceConnected && attendanceEvents > 0
          ? copy.ledgerStatus.review
          : copy.ledgerStatus.sourcePending;

    return {
      id: employee.id,
      company: employee.company,
      employee: employee.name,
      employeeNumber: employee.employee_number ?? "-",
      worksite: employee.worksite_name ?? employee.worksite ?? "-",
      attendanceEvents,
      workDays,
      regularHours,
      overtimeHours: 0,
      leaveUsed: employee.leave_used ?? "-",
      leaveRemaining: employee.leave_remaining ?? "-",
      grossSource: payrollSourceConnected
        ? copy.ledgerStatus.connected
        : copy.ledgerStatus.pending,
      netSource: payrollSourceConnected
        ? copy.ledgerStatus.connected
        : copy.ledgerStatus.pending,
      status,
    };
  });
}

function downloadPayrollLedger(
  rows: PayrollLedgerRow[],
  readiness: HrReadinessSummary,
): void {
  const headers = [
    copy.ledgerColumns.company,
    copy.ledgerColumns.employee,
    copy.ledgerColumns.worksite,
    copy.ledgerColumns.attendanceEvents,
    copy.ledgerColumns.workDays,
    copy.ledgerColumns.regularHours,
    copy.ledgerColumns.overtimeHours,
    copy.ledgerColumns.leaveUsed,
    copy.ledgerColumns.leaveRemaining,
    copy.ledgerColumns.grossSource,
    copy.ledgerColumns.netSource,
    copy.ledgerColumns.status,
  ];
  const csvRows = rows.map((row) => [
    row.company,
    `${row.employee} (${row.employeeNumber})`,
    row.worksite,
    row.attendanceEvents,
    row.workDays,
    row.regularHours,
    row.overtimeHours,
    row.leaveUsed,
    row.leaveRemaining,
    row.grossSource,
    row.netSource,
    row.status,
  ]);
  const csv = [headers, ...csvRows]
    .map((line) => line.map(csvCell).join(","))
    .join("\r\n");
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const period = [
    readiness.payroll.latest_period_start,
    readiness.payroll.latest_period_end,
  ]
    .filter(Boolean)
    .join("_");
  anchor.href = url;
  anchor.download = `payroll-ledger-${period || "draft"}.csv`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function csvCell(value: string | number): string {
  const raw = String(value);
  const safe = /^[=+\-@]/u.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}
