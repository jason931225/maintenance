import { Upload } from "lucide-react";
import type { SyntheticEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

import type { ConsoleApiClient } from "../api/client";
import type {
  AttendanceSummaryPage,
  AttendanceImportApplyReport,
  AttendanceImportDryRun,
  AttendanceImportPreview,
  CreateEmployeeLifecycleEventRequest,
  EmployeeImportDryRun,
  EmployeeLifecycleEvent,
  EmployeeLifecycleEventPage,
  EmployeeImportPreview,
  EmployeeDirectoryItem,
  EmployeeDirectoryPage,
  EmployeeImportSummary,
  HrReadinessSummary,
  HrOrgChartResponse,
  LeaveBalancePage,
} from "../api/types";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import { hasAnyRole, ROLES } from "../components/shell/nav";
import { PageEmpty } from "../components/states/PageEmpty";
import { PageError } from "../components/states/PageError";
import { SkeletonTable } from "../components/states/Skeleton";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Select } from "../components/ui/select";
import { useAuth } from "../context/auth";
import { ko } from "../i18n/ko";
import { formatListCount } from "../lib/utils";

const EMPLOYEE_IMPORT_ROLES = [ROLES.ADMIN, ROLES.SUPER_ADMIN] as const;

type ReadState = "loading" | "idle" | "error";
type UploadState =
  "idle" | "previewing" | "dryRunning" | "applying" | "exporting" | "error";
const LIFECYCLE_EVENT_TYPES = [
  "ONBOARD",
  "OFFBOARD",
  "TERMINATE",
  "TRANSFER",
] as const;
type EmployeeLifecycleEventType = (typeof LIFECYCLE_EVENT_TYPES)[number];

type EmployeeApi = ConsoleApiClient & {
  GET(
    path: "/api/v1/employees",
    options?: {
      params?: {
        query?: { limit?: number; offset?: number; company?: string };
      };
    },
  ): Promise<{ data?: EmployeeDirectoryPage }>;
  GET(path: "/api/v1/hr/org-chart"): Promise<{ data?: HrOrgChartResponse }>;
  GET(
    path: "/api/v1/hr/leave-balances",
    options?: { params?: { query?: { limit?: number; offset?: number } } },
  ): Promise<{ data?: LeaveBalancePage }>;
  GET(
    path: "/api/v1/hr/attendance-summary",
    options?: { params?: { query?: { limit?: number; offset?: number } } },
  ): Promise<{ data?: AttendanceSummaryPage }>;
  GET(path: "/api/v1/hr/readiness-summary"): Promise<{
    data?: HrReadinessSummary;
  }>;
  GET(
    path: "/api/v1/employees/{id}/lifecycle-events",
    options: { params: { path: { id: string } } },
  ): Promise<{ data?: EmployeeLifecycleEventPage }>;
  POST(
    path: "/api/v1/employees/import",
    options: {
      body: { file: string };
      bodySerializer: (body: { file: string }) => FormData;
    },
  ): Promise<{ data?: EmployeeImportSummary }>;
  POST(
    path: "/api/v1/employees/import/preview",
    options: {
      body: { file: string };
      bodySerializer: (body: { file: string }) => FormData;
    },
  ): Promise<{ data?: EmployeeImportPreview }>;
  POST(
    path: "/api/v1/employees/import/{run_id}/dry-run",
    options: { params: { path: { run_id: string } } },
  ): Promise<{ data?: EmployeeImportDryRun }>;
  POST(
    path: "/api/v1/employees/import/{run_id}/apply",
    options: { params: { path: { run_id: string } } },
  ): Promise<{ data?: EmployeeImportSummary }>;
  POST(
    path: "/api/v1/hr/attendance-import/preview",
    options: {
      body: { file: string };
      bodySerializer: (body: { file: string }) => FormData;
    },
  ): Promise<{ data?: AttendanceImportPreview }>;
  POST(
    path: "/api/v1/hr/attendance-import/{run_id}/dry-run",
    options: { params: { path: { run_id: string } } },
  ): Promise<{ data?: AttendanceImportDryRun }>;
  POST(
    path: "/api/v1/hr/attendance-import/{run_id}/apply",
    options: { params: { path: { run_id: string } } },
  ): Promise<{ data?: AttendanceImportApplyReport }>;
  POST(
    path: "/api/v1/employees/{id}/lifecycle-events",
    options: {
      params: { path: { id: string } };
      body: CreateEmployeeLifecycleEventRequest;
    },
  ): Promise<{ data?: EmployeeLifecycleEvent }>;
  GET(
    path: "/api/v1/employees/export.csv",
    options: { parseAs: "text" },
  ): Promise<{ data?: string }>;
};

export function EmployeesPage() {
  const { api, session } = useAuth();
  const employeeApi = api as EmployeeApi;
  const t = ko.employees;
  const canImport = hasAnyRole(session?.roles, EMPLOYEE_IMPORT_ROLES);

  const [state, setState] = useState<ReadState>("loading");
  const [employees, setEmployees] = useState<EmployeeDirectoryItem[]>([]);
  const [orgChart, setOrgChart] = useState<HrOrgChartResponse>();
  const [leaveBalances, setLeaveBalances] = useState<LeaveBalancePage>();
  const [attendanceSummary, setAttendanceSummary] =
    useState<AttendanceSummaryPage>();
  const [readinessSummary, setReadinessSummary] =
    useState<HrReadinessSummary>();
  const [total, setTotal] = useState<number>();
  const [company, setCompany] = useState("all");
  const [lifecycleEmployee, setLifecycleEmployee] =
    useState<EmployeeDirectoryItem>();

  const loadEmployees = useCallback(async () => {
    setState("loading");
    const items: EmployeeDirectoryItem[] = [];
    let nextOffset = 0;
    let discoveredTotal = 0;

    for (let page = 0; page < 10; page += 1) {
      const response = await employeeApi
        .GET("/api/v1/employees", {
          params: { query: { limit: 1000, offset: nextOffset } },
        })
        .catch(() => undefined);
      const data = response?.data;
      if (!data) {
        setState("error");
        return;
      }

      items.push(...data.items);
      discoveredTotal = data.total;
      if (items.length >= data.total || data.items.length === 0) break;
      nextOffset += data.items.length;
    }

    const [orgResponse, leaveResponse, attendanceResponse, readinessResponse] =
      await Promise.all([
      employeeApi.GET("/api/v1/hr/org-chart").catch(() => undefined),
      employeeApi
        .GET("/api/v1/hr/leave-balances", {
          params: { query: { limit: 1000, offset: 0 } },
        })
        .catch(() => undefined),
      employeeApi
        .GET("/api/v1/hr/attendance-summary", {
          params: { query: { limit: 1000, offset: 0 } },
        })
        .catch(() => undefined),
      employeeApi.GET("/api/v1/hr/readiness-summary").catch(() => undefined),
    ]);

    if (
      !orgResponse?.data ||
      !leaveResponse?.data ||
      !attendanceResponse?.data ||
      !readinessResponse?.data
    ) {
      setState("error");
      return;
    }

    setEmployees(items);
    setOrgChart(orgResponse.data);
    setLeaveBalances(leaveResponse.data);
    setAttendanceSummary(attendanceResponse.data);
    setReadinessSummary(readinessResponse.data);
    setTotal(discoveredTotal || items.length);
    setState("idle");
  }, [employeeApi]);

  useEffect(() => {
    void Promise.resolve().then(loadEmployees);
  }, [loadEmployees]);

  const companies = useMemo(
    () =>
      Array.from(new Set(employees.map(companyName).filter(Boolean))).sort(),
    [employees],
  );
  const visibleEmployees = useMemo(
    () =>
      employees.filter(
        (employee) => company === "all" || companyName(employee) === company,
      ),
    [company, employees],
  );

  return (
    <>
      <PageHeader
        title={t.title}
        description={t.description}
        actions={
          <RefreshButton
            onClick={() => {
              void loadEmployees();
            }}
            isLoading={state === "loading"}
          />
        }
      />

      <div className="grid max-w-6xl gap-5">
        <Card className="grid gap-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="grid min-w-56 gap-2">
              <label
                className="text-sm font-medium text-steel"
                htmlFor="employee-company-filter"
              >
                {t.companyFilter}
              </label>
              <Select
                id="employee-company-filter"
                value={company}
                onChange={(event) => {
                  setCompany(event.currentTarget.value);
                }}
              >
                <option value="all">{t.allCompanies}</option>
                {companies.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
            </div>
            <p className="text-sm font-medium text-steel" aria-live="polite">
              {formatListCount(visibleEmployees.length)} /{" "}
              {formatListCount(total ?? employees.length)}
            </p>
          </div>
        </Card>

        {state === "loading" ? <SkeletonTable rows={5} cols={12} /> : null}
        {state === "error" ? (
          <PageError
            message={t.loadFailed}
            onRetry={() => {
              void loadEmployees();
            }}
          />
        ) : null}
        {state === "idle" ? (
          <>
            <HrDashboard
              orgChart={orgChart}
              leaveBalances={leaveBalances}
              attendanceSummary={attendanceSummary}
              readinessSummary={readinessSummary}
            />
            <ReadinessSummaryPanel readinessSummary={readinessSummary} />
            <PeopleOperationsPanel
              selectedCompany={company}
              companies={companies}
              employees={employees}
              visibleEmployees={visibleEmployees}
              canImport={canImport}
              onManageLifecycle={setLifecycleEmployee}
            />
            <OrgChartPanel orgChart={orgChart} />
            <div className="grid gap-5 xl:grid-cols-2">
              <LeaveBalancePanel leaveBalances={leaveBalances} />
              <AttendanceSummaryPanel attendanceSummary={attendanceSummary} />
            </div>
            <EmployeeTable
              employees={visibleEmployees}
              onManageLifecycle={setLifecycleEmployee}
            />
            {lifecycleEmployee ? (
              <EmployeeLifecyclePanel
                key={lifecycleEmployee.id}
                api={employeeApi}
                employee={lifecycleEmployee}
                onChanged={() => {
                  void loadEmployees();
                }}
              />
            ) : null}
          </>
        ) : null}

        {canImport ? (
          <div className="grid gap-5 xl:grid-cols-2">
            <EmployeeImportPanel
              api={employeeApi}
              onImported={() => {
                void loadEmployees();
              }}
            />
            <AttendanceImportPanel api={employeeApi} />
          </div>
        ) : null}
      </div>
    </>
  );
}

function HrDashboard({
  orgChart,
  leaveBalances,
  attendanceSummary,
  readinessSummary,
}: {
  orgChart?: HrOrgChartResponse;
  leaveBalances?: LeaveBalancePage;
  attendanceSummary?: AttendanceSummaryPage;
  readinessSummary?: HrReadinessSummary;
}) {
  const t = ko.employees.dashboard;
  const totals = summarizeOrgChart(orgChart);
  const cards: Array<[string, string | number | undefined]> = [
    [t.companies, totals.companies],
    [t.employees, totals.employees],
    [t.activeEmployees, totals.active],
    [t.leaveRemaining, leaveBalances?.summary.remaining],
    [t.attendanceUsers, attendanceSummary?.total],
    [t.importRows, readinessSummary?.imports.ledger_rows],
    [t.payrollDraftLines, readinessSummary?.payroll.draft_lines],
  ];

  return (
    <Card className="grid gap-4">
      <div>
        <h2 className="text-lg font-semibold text-ink">{t.title}</h2>
        <p className="text-sm text-steel">{t.description}</p>
      </div>
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map(([label, value]) => (
          <div
            key={label}
            className="rounded-lg border border-line bg-muted-panel p-3"
          >
            <dt className="text-xs font-semibold uppercase tracking-wide text-steel">
              {label}
            </dt>
            <dd className="mt-1 text-2xl font-semibold text-ink">
              {text(value)}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function ReadinessSummaryPanel({
  readinessSummary,
}: {
  readinessSummary?: HrReadinessSummary;
}) {
  const t = ko.employees.readiness;
  if (!readinessSummary) return null;

  const cards = [
    {
      label: t.importLedger,
      value: formatListCount(readinessSummary.imports.ledger_rows),
      meta: t.importLedgerMeta
        .replace("{runs}", formatListCount(readinessSummary.imports.runs))
        .replace(
          "{applied}",
          formatListCount(readinessSummary.imports.applied_runs),
        ),
    },
    {
      label: t.employeeCandidates,
      value: formatListCount(readinessSummary.imports.candidate_rows),
      meta: t.employeeCandidatesMeta.replace(
        "{preserved}",
        formatListCount(readinessSummary.imports.preserved_rows),
      ),
    },
    {
      label: t.durableAttendance,
      value: formatListCount(readinessSummary.attendance.durable_events),
      meta: t.durableAttendanceMeta,
    },
    {
      label: t.payrollDrafts,
      value: formatListCount(readinessSummary.payroll.draft_lines),
      meta: t.payrollDraftsMeta
        .replace(
          "{payrollRows}",
          formatListCount(readinessSummary.payroll.payroll_source_rows),
        )
        .replace(
          "{attendanceRows}",
          formatListCount(readinessSummary.payroll.attendance_source_rows),
        ),
    },
    {
      label: t.legalGate,
      value:
        readinessSummary.payroll.calculation_enabled_runs > 0
          ? t.enabled
          : t.blocked,
      meta: t.legalGateMeta.replace(
        "{blocked}",
        formatListCount(readinessSummary.payroll.blocked_runs),
      ),
    },
    {
      label: t.annualLeave,
      value: formatListCount(readinessSummary.annual_leave.obligations),
      meta: t.annualLeaveMeta
        .replace(
          "{promotion}",
          formatListCount(
            readinessSummary.annual_leave.usage_promotion_required,
          ),
        )
        .replace("{remaining}", readinessSummary.annual_leave.remaining_days),
    },
  ];
  const latestPeriod =
    readinessSummary.payroll.latest_period_start &&
    readinessSummary.payroll.latest_period_end
      ? `${readinessSummary.payroll.latest_period_start} - ${readinessSummary.payroll.latest_period_end}`
      : "-";

  return (
    <Card className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">{t.title}</h2>
          <p className="text-sm text-steel">{t.description}</p>
        </div>
        <span
          className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${readinessStatusClass(
            readinessSummary.payroll.latest_status,
            readinessSummary.payroll.calculation_enabled_runs,
          )}`}
        >
          {text(readinessSummary.payroll.latest_status ?? t.noPayrollRun)}
        </span>
      </div>
      <dl className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {cards.map((card) => (
          <div
            key={card.label}
            className="rounded-lg border border-line bg-white p-3"
          >
            <dt className="text-xs font-semibold uppercase tracking-wide text-steel">
              {card.label}
            </dt>
            <dd className="mt-1 text-xl font-semibold text-ink">
              {card.value}
            </dd>
            <dd className="mt-1 text-xs text-steel">{card.meta}</dd>
          </div>
        ))}
      </dl>
      <dl className="grid gap-3 rounded-lg border border-line bg-muted-panel/50 p-3 text-sm lg:grid-cols-4">
        <div>
          <dt className="font-semibold text-steel">{t.latestSource}</dt>
          <dd className="text-ink">
            {text(readinessSummary.payroll.latest_source_label)}
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-steel">{t.period}</dt>
          <dd className="text-ink">{latestPeriod}</dd>
        </div>
        <div>
          <dt className="font-semibold text-steel">{t.lastImport}</dt>
          <dd className="text-ink">
            {text(readinessSummary.imports.latest_import_at)}
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-steel">{t.lastPayrollUpdate}</dt>
          <dd className="text-ink">
            {text(readinessSummary.payroll.latest_updated_at)}
          </dd>
        </div>
      </dl>
    </Card>
  );
}

function PeopleOperationsPanel({
  selectedCompany,
  companies,
  employees,
  visibleEmployees,
  canImport,
  onManageLifecycle,
}: {
  selectedCompany: string;
  companies: string[];
  employees: EmployeeDirectoryItem[];
  visibleEmployees: EmployeeDirectoryItem[];
  canImport: boolean;
  onManageLifecycle: (employee: EmployeeDirectoryItem) => void;
}) {
  const t = ko.employees.operations;
  const statusCounts = countEmploymentStatuses(visibleEmployees);
  const identityCounts = countIdentityResolution(visibleEmployees);
  const scopeLabel =
    selectedCompany === "all"
      ? t.groupScope
      : `${selectedCompany} ${t.orgScope}`;
  const cards = [
    {
      title: t.scope.title,
      value: scopeLabel,
      meta: t.scope.meta
        .replace("{visible}", formatListCount(visibleEmployees.length))
        .replace("{total}", formatListCount(employees.length))
        .replace("{companies}", formatListCount(companies.length)),
    },
    {
      title: t.lifecycle.title,
      value: t.lifecycle.value
        .replace("{active}", formatListCount(statusCounts.active))
        .replace("{exited}", formatListCount(statusCounts.exited)),
      meta: t.lifecycle.meta,
    },
    {
      title: t.policy.title,
      value: t.policy.value,
      meta: t.policy.meta,
    },
    {
      title: t.identity.title,
      value: t.identity.value
        .replace("{review}", formatListCount(identityCounts.reviewRequired))
        .replace("{high}", formatListCount(identityCounts.highConfidence)),
      meta: t.identity.meta,
    },
    {
      title: t.importControls.title,
      value: canImport
        ? t.importControls.adminValue
        : t.importControls.readValue,
      meta: t.importControls.meta,
    },
  ];

  return (
    <Card className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">{t.title}</h2>
          <p className="text-sm text-steel">{t.description}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild type="button" variant="secondary" size="sm">
            <Link to="/settings/users">{t.actions.users}</Link>
          </Button>
          <Button asChild type="button" variant="secondary" size="sm">
            <Link to="/settings/policy">{t.actions.policy}</Link>
          </Button>
          <Button asChild type="button" variant="secondary" size="sm">
            <Link to="/settings/workflows">{t.actions.workflows}</Link>
          </Button>
        </div>
      </div>
      <dl className="grid gap-3 lg:grid-cols-5">
        {cards.map((card) => (
          <div
            key={card.title}
            className="rounded-lg border border-line bg-white p-3"
          >
            <dt className="text-xs font-semibold uppercase tracking-wide text-steel">
              {card.title}
            </dt>
            <dd className="mt-1 text-base font-semibold text-ink">
              {card.value}
            </dd>
            <dd className="mt-1 text-xs text-steel">{card.meta}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-muted-panel/50 p-3">
        <p className="text-sm text-steel">{t.lifecycleCta}</p>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={visibleEmployees.length === 0}
          onClick={() => {
            onManageLifecycle(visibleEmployees[0]);
          }}
        >
          {t.actions.lifecycle}
        </Button>
      </div>
    </Card>
  );
}

function OrgChartPanel({ orgChart }: { orgChart?: HrOrgChartResponse }) {
  const t = ko.employees.orgChart;
  const companies = orgChart?.companies ?? [];

  return (
    <Card className="grid gap-4">
      <div>
        <h2 className="text-lg font-semibold text-ink">{t.title}</h2>
        <p className="text-sm text-steel">{t.description}</p>
      </div>
      {companies.length === 0 ? <PageEmpty message={t.empty} /> : null}
      <div className="grid gap-3 lg:grid-cols-2">
        {companies.map((company) => (
          <section
            key={company.company}
            className="rounded-lg border border-line p-4"
          >
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-semibold text-ink">{company.company}</h3>
              <p className="text-sm text-steel">
                {formatListCount(company.active)} {t.active} /{" "}
                {formatListCount(company.total)} {t.people}
              </p>
            </div>
            <div className="mt-3 grid gap-3">
              {company.units.map((unit) => (
                <div key={unit.name} className="rounded-md bg-muted-panel p-3">
                  <p className="text-sm font-semibold text-ink">
                    {unit.name} · {formatListCount(unit.total)} {t.people}
                  </p>
                  <div className="mt-2 grid gap-2">
                    {unit.positions.map((position) => (
                      <div key={position.title} className="text-sm text-steel">
                        <span className="font-semibold text-ink">
                          {position.title}
                        </span>
                        <span>
                          {" "}
                          · {formatListCount(position.total)} {t.people}
                        </span>
                        <p className="mt-1 text-xs">
                          {position.employees
                            .map((employee) => employee.name)
                            .join(", ")}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </Card>
  );
}

function LeaveBalancePanel({
  leaveBalances,
}: {
  leaveBalances?: LeaveBalancePage;
}) {
  const t = ko.employees.leave;
  const items = leaveBalances?.items ?? [];

  return (
    <Card className="grid content-start gap-4">
      <div>
        <h2 className="text-lg font-semibold text-ink">{t.title}</h2>
        <p className="text-sm text-steel">{t.description}</p>
      </div>
      <dl className="grid grid-cols-3 gap-2 rounded-md border border-line bg-muted-panel p-3 text-sm">
        <div>
          <dt className="font-semibold text-steel">{t.accrued}</dt>
          <dd className="text-ink">{text(leaveBalances?.summary.accrued)}</dd>
        </div>
        <div>
          <dt className="font-semibold text-steel">{t.used}</dt>
          <dd className="text-ink">{text(leaveBalances?.summary.used)}</dd>
        </div>
        <div>
          <dt className="font-semibold text-steel">{t.remaining}</dt>
          <dd className="text-ink">{text(leaveBalances?.summary.remaining)}</dd>
        </div>
      </dl>
      {items.length === 0 ? <PageEmpty message={t.empty} /> : null}
      <div className="grid gap-2">
        {items.slice(0, 8).map((item) => (
          <div
            key={item.id}
            className="flex items-center justify-between gap-3 rounded-md border border-line p-3 text-sm"
          >
            <div>
              <p className="font-semibold text-ink">{item.name}</p>
              <p className="text-steel">
                {[item.company, item.org_unit, item.position]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            <p className="font-semibold text-ink">
              {text(item.leave_remaining)}
            </p>
          </div>
        ))}
      </div>
    </Card>
  );
}

function AttendanceSummaryPanel({
  attendanceSummary,
}: {
  attendanceSummary?: AttendanceSummaryPage;
}) {
  const t = ko.employees.attendance;
  const items = attendanceSummary?.items ?? [];

  return (
    <Card className="grid content-start gap-4">
      <div>
        <h2 className="text-lg font-semibold text-ink">{t.title}</h2>
        <p className="text-sm text-steel">{t.description}</p>
      </div>
      {items.length === 0 ? <PageEmpty message={t.empty} /> : null}
      <div className="grid gap-2">
        {items.slice(0, 8).map((item) => (
          <div
            key={item.user_id}
            className="rounded-md border border-line p-3 text-sm"
          >
            <div className="flex items-center justify-between gap-3">
              <p className="font-semibold text-ink">{item.display_name}</p>
              <p className="text-steel">{text(item.last_kind)}</p>
            </div>
            <dl className="mt-2 grid grid-cols-3 gap-2 text-xs text-steel">
              <div>
                <dt>{t.arrivals}</dt>
                <dd className="font-semibold text-ink">
                  {formatListCount(item.arrivals)}
                </dd>
              </div>
              <div>
                <dt>{t.departures}</dt>
                <dd className="font-semibold text-ink">
                  {formatListCount(item.departures)}
                </dd>
              </div>
              <div>
                <dt>{t.lastEvent}</dt>
                <dd className="font-semibold text-ink">
                  {text(item.last_event_at)}
                </dd>
              </div>
            </dl>
          </div>
        ))}
      </div>
    </Card>
  );
}

function EmployeeTable({
  employees,
  onManageLifecycle,
}: {
  employees: EmployeeDirectoryItem[];
  onManageLifecycle?: (employee: EmployeeDirectoryItem) => void;
}) {
  const t = ko.employees;
  if (employees.length === 0) return <PageEmpty message={t.empty} />;

  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-white">
      <table className="min-w-full divide-y divide-line text-sm">
        <thead className="bg-muted-panel/40 text-left text-xs font-semibold uppercase tracking-wide text-steel">
          <tr>
            <th className="px-4 py-3">{t.columns.name}</th>
            <th className="px-4 py-3">{t.columns.company}</th>
            <th className="px-4 py-3">{t.columns.employeeNumber}</th>
            <th className="px-4 py-3">{t.columns.orgUnit}</th>
            <th className="px-4 py-3">{t.columns.identity}</th>
            <th className="px-4 py-3">{t.columns.worksite}</th>
            <th className="px-4 py-3">{t.columns.job}</th>
            <th className="px-4 py-3">{t.columns.position}</th>
            <th className="px-4 py-3">{t.columns.hireDate}</th>
            <th className="px-4 py-3">{t.columns.exitDate}</th>
            <th className="px-4 py-3">{t.columns.status}</th>
            <th className="px-4 py-3">{t.columns.leaveRemaining}</th>
            <th className="px-4 py-3">{t.columns.actions}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {employees.map((employee) => (
            <tr key={employee.id}>
              <td className="px-4 py-3 font-medium text-ink">
                {employeeName(employee)}
              </td>
              <td className="px-4 py-3 text-steel">{companyName(employee)}</td>
              <td className="px-4 py-3 text-steel">
                {text(employee.employee_number)}
              </td>
              <td className="px-4 py-3 text-steel">
                {text(employee.org_unit)}
              </td>
              <td className="px-4 py-3">
                <IdentityResolutionBadge employee={employee} />
              </td>
              <td className="px-4 py-3 text-steel">
                {text(employee.worksite_name ?? employee.worksite)}
              </td>
              <td className="px-4 py-3 text-steel">{text(employee.job)}</td>
              <td className="px-4 py-3 text-steel">
                {text(employee.position)}
              </td>
              <td className="px-4 py-3 text-steel">
                {text(employee.hire_date)}
              </td>
              <td className="px-4 py-3 text-steel">
                {text(employee.exit_date)}
              </td>
              <td className="px-4 py-3 text-steel">{text(employee.status)}</td>
              <td className="px-4 py-3 text-steel">
                {text(employee.leave_remaining)}
              </td>
              <td className="px-4 py-3">
                <Button
                  type="button"
                  size="xs"
                  variant="secondary"
                  aria-label={`${employeeName(employee)} ${t.lifecycle.manage}`}
                  onClick={() => onManageLifecycle?.(employee)}
                >
                  {t.lifecycle.manage}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function IdentityResolutionBadge({
  employee,
}: {
  employee: EmployeeDirectoryItem;
}) {
  const t = ko.employees.identity;
  const reviewRequired = employee.identity_review_required;
  const confidence = employee.identity_resolution_confidence;
  const strategy = employee.identity_resolution_strategy;
  const confidenceLabel =
    confidence === "high"
      ? t.highConfidence
      : confidence === "medium"
        ? t.mediumConfidence
        : t.lowConfidence;
  const strategyLabel = t.strategies[strategy];

  return (
    <div className="flex min-w-32 flex-col gap-1">
      <span
        className={[
          "inline-flex w-fit rounded-full border px-2 py-0.5 text-xs font-semibold",
          reviewRequired
            ? "border-amber-300 bg-amber-50 text-amber-900"
            : "border-emerald-300 bg-emerald-50 text-emerald-800",
        ].join(" ")}
      >
        {reviewRequired ? t.reviewRequired : confidenceLabel}
      </span>
      <span className="text-xs text-steel">{strategyLabel}</span>
      {employee.identity_name_only_merge ? null : (
        <span className="text-xs text-steel">{t.nameOnlyBlocked}</span>
      )}
    </div>
  );
}

function EmployeeLifecyclePanel({
  api,
  employee,
  onChanged,
}: {
  api: EmployeeApi;
  employee: EmployeeDirectoryItem;
  onChanged: () => void;
}) {
  const t = ko.employees.lifecycle;
  const [events, setEvents] = useState<EmployeeLifecycleEvent[]>([]);
  const [state, setState] = useState<
    "loading" | "idle" | "submitting" | "error"
  >("loading");
  const [eventType, setEventType] =
    useState<EmployeeLifecycleEventType>("TRANSFER");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [comment, setComment] = useState("");
  const [toCompany, setToCompany] = useState("");
  const [toOrgUnit, setToOrgUnit] = useState("");
  const [toPosition, setToPosition] = useState("");
  const [signoffs, setSignoffs] = useState({
    privacy_notice_ack: false,
    korean_labor_law_ack: false,
    payroll_cutoff_ack: false,
    retirement_settlement_ack: false,
  });

  const loadEvents = useCallback(async () => {
    setState("loading");
    const response = await api
      .GET("/api/v1/employees/{id}/lifecycle-events", {
        params: { path: { id: employee.id } },
      })
      .catch(() => undefined);
    if (!response?.data) {
      setState("error");
      return;
    }
    setEvents(response.data.items);
    setState("idle");
  }, [api, employee.id]);

  useEffect(() => {
    void Promise.resolve().then(loadEvents);
  }, [employee.id, loadEvents]);

  async function submitLifecycleEvent(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setState("submitting");
    const body: CreateEmployeeLifecycleEventRequest = {
      event_type: eventType,
      to_status: lifecycleToStatus(eventType),
      effective_date: effectiveDate,
      comment,
      signoffs,
    };
    if (eventType === "TRANSFER") {
      body.to_company = trimmedOrNull(toCompany);
      body.to_org_unit = trimmedOrNull(toOrgUnit);
      body.to_position = trimmedOrNull(toPosition);
    }
    const response = await api
      .POST("/api/v1/employees/{id}/lifecycle-events", {
        params: { path: { id: employee.id } },
        body,
      })
      .catch(() => undefined);
    if (!response?.data) {
      setState("error");
      return;
    }
    const created = response.data;
    setEvents((current) => [created, ...current]);
    setComment("");
    setEffectiveDate("");
    setToCompany("");
    setToOrgUnit("");
    setToPosition("");
    setState("idle");
    onChanged();
  }

  function toggleSignoff(key: keyof typeof signoffs) {
    setSignoffs((current) => ({ ...current, [key]: !current[key] }));
  }

  return (
    <Card className="grid gap-4" aria-live="polite">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">{t.title}</h2>
          <p className="text-sm text-steel">
            {employeeName(employee)} · {companyName(employee)} ·{" "}
            {text(employee.status)}
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={state === "loading"}
          onClick={() => {
            void loadEvents();
          }}
        >
          {t.refresh}
        </Button>
      </div>

      {state === "error" ? (
        <p role="alert" className="text-sm font-semibold text-red-700">
          {t.failed}
        </p>
      ) : null}

      <form
        className="grid gap-3 rounded-lg border border-line bg-muted-panel/40 p-4"
        onSubmit={(event) => {
          void submitLifecycleEvent(event);
        }}
      >
        <div className="grid gap-3 md:grid-cols-3">
          <label className="grid gap-2 text-sm font-medium text-steel">
            {t.typeLabel}
            <Select
              value={eventType}
              onChange={(event) => {
                setEventType(
                  event.currentTarget.value as EmployeeLifecycleEventType,
                );
              }}
            >
              {LIFECYCLE_EVENT_TYPES.map((value) => (
                <option key={value} value={value}>
                  {t.eventTypes[value]}
                </option>
              ))}
            </Select>
          </label>
          <label className="grid gap-2 text-sm font-medium text-steel">
            {t.effectiveDate}
            <input
              className="min-h-12 rounded border border-line bg-white px-3 py-2 text-base text-ink outline-none transition focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
              type="date"
              value={effectiveDate}
              onChange={(event) => {
                setEffectiveDate(event.currentTarget.value);
              }}
              required
            />
          </label>
          <label className="grid gap-2 text-sm font-medium text-steel md:col-span-3">
            {t.comment}
            <textarea
              className="min-h-24 rounded border border-line bg-white px-3 py-2 text-base text-ink outline-none transition focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
              value={comment}
              onChange={(event) => {
                setComment(event.currentTarget.value);
              }}
              required
            />
          </label>
        </div>
        {eventType === "TRANSFER" ? (
          <fieldset className="grid gap-3 rounded-md border border-line bg-white p-3 md:grid-cols-3">
            <legend className="px-1 text-sm font-semibold text-ink">
              {t.transferTargetTitle}
            </legend>
            <label className="grid gap-2 text-sm font-medium text-steel">
              {t.toCompany}
              <input
                className="min-h-12 rounded border border-line bg-white px-3 py-2 text-base text-ink outline-none transition focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
                value={toCompany}
                onChange={(event) => {
                  setToCompany(event.currentTarget.value);
                }}
                required
              />
            </label>
            <label className="grid gap-2 text-sm font-medium text-steel">
              {t.toOrgUnit}
              <input
                className="min-h-12 rounded border border-line bg-white px-3 py-2 text-base text-ink outline-none transition focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
                value={toOrgUnit}
                onChange={(event) => {
                  setToOrgUnit(event.currentTarget.value);
                }}
                required
              />
            </label>
            <label className="grid gap-2 text-sm font-medium text-steel">
              {t.toPosition}
              <input
                className="min-h-12 rounded border border-line bg-white px-3 py-2 text-base text-ink outline-none transition focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
                value={toPosition}
                onChange={(event) => {
                  setToPosition(event.currentTarget.value);
                }}
                required
              />
            </label>
          </fieldset>
        ) : null}
        <fieldset className="grid gap-2 rounded-md border border-line bg-white p-3">
          <legend className="px-1 text-sm font-semibold text-ink">
            {t.signoffsTitle}
          </legend>
          {(
            [
              ["privacy_notice_ack", t.privacyNotice],
              ["korean_labor_law_ack", t.koreanLaborLaw],
              ["payroll_cutoff_ack", t.payrollCutoff],
              ["retirement_settlement_ack", t.retirementSettlement],
            ] as const
          ).map(([key, label]) => (
            <label
              key={key}
              className="flex items-center gap-2 text-sm font-medium text-steel"
            >
              <input
                type="checkbox"
                checked={signoffs[key]}
                onChange={() => {
                  toggleSignoff(key);
                }}
              />
              {label}
            </label>
          ))}
        </fieldset>
        <div className="flex justify-end">
          <Button
            type="submit"
            disabled={state === "submitting" || !effectiveDate || !comment}
          >
            {state === "submitting" ? t.submitting : t.submit}
          </Button>
        </div>
      </form>

      {state === "loading" ? <SkeletonTable rows={2} cols={4} /> : null}
      {state !== "loading" && events.length === 0 ? (
        <PageEmpty message={t.empty} />
      ) : null}
      {events.length > 0 ? (
        <ol className="grid gap-2">
          {events.map((event) => (
            <li
              key={event.id}
              className="rounded-md border border-line bg-white p-3 text-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold text-ink">
                  {t.eventTypes[event.event_type]}
                </p>
                <p className="text-steel">{event.effective_date}</p>
              </div>
              <p className="mt-1 text-steel">{event.comment}</p>
              <p className="mt-2 text-xs text-steel">
                {t.fromTo}: {text(event.from_status)} → {event.to_status}
              </p>
              {event.to_company || event.to_org_unit || event.to_position ? (
                <p className="mt-1 text-xs text-steel">
                  {t.transferTargetTitle}:{" "}
                  {[event.to_company, event.to_org_unit, event.to_position]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              ) : null}
              <dl className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {(
                  [
                    ["privacy_notice_ack", t.privacyNotice],
                    ["korean_labor_law_ack", t.koreanLaborLaw],
                    ["payroll_cutoff_ack", t.payrollCutoff],
                    ["retirement_settlement_ack", t.retirementSettlement],
                  ] as const
                ).map(([key, label]) => (
                  <div
                    key={key}
                    className="rounded border border-line bg-muted-panel/50 px-2 py-1"
                  >
                    <dt className="text-[11px] font-semibold text-steel">
                      {label}
                    </dt>
                    <dd className="text-xs font-semibold text-ink">
                      {event.signoffs[key] ? t.confirmed : t.notConfirmed}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="mt-2 text-xs text-steel">
                {t.recordedBy}: {text(event.created_by)} · {t.recordedAt}:{" "}
                {text(event.created_at)}
              </p>
            </li>
          ))}
        </ol>
      ) : null}
    </Card>
  );
}

function EmployeeImportPanel({
  api,
  onImported,
}: {
  api: EmployeeApi;
  onImported: () => void;
}) {
  const t = ko.employees.import;
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File>();
  const [state, setState] = useState<UploadState>("idle");
  const [preview, setPreview] = useState<EmployeeImportPreview>();
  const [dryRun, setDryRun] = useState<EmployeeImportDryRun>();
  const [summary, setSummary] = useState<EmployeeImportSummary>();

  async function previewFile() {
    if (!file) {
      setState("error");
      return;
    }
    setState("previewing");
    setPreview(undefined);
    setDryRun(undefined);
    setSummary(undefined);
    const response = await api
      .POST("/api/v1/employees/import/preview", {
        body: { file: file as unknown as string },
        bodySerializer(body: { file: string }) {
          const form = new FormData();
          form.append("file", body.file as unknown as File);
          return form;
        },
      })
      .catch(() => undefined);
    if (!response?.data) {
      setState("error");
      return;
    }
    setPreview(response.data);
    setState("idle");
  }

  async function dryRunImport() {
    if (!preview) return;
    setState("dryRunning");
    setDryRun(undefined);
    setSummary(undefined);
    const response = await api
      .POST("/api/v1/employees/import/{run_id}/dry-run", {
        params: { path: { run_id: preview.run_id } },
      })
      .catch(() => undefined);
    if (!response?.data) {
      setState("error");
      return;
    }
    setDryRun(response.data);
    setState("idle");
  }

  async function applyImport() {
    if (!preview || !dryRun) return;
    setState("applying");
    const response = await api
      .POST("/api/v1/employees/import/{run_id}/apply", {
        params: { path: { run_id: preview.run_id } },
      })
      .catch(() => undefined);
    if (!response?.data) {
      setState("error");
      return;
    }
    setSummary(response.data);
    setState("idle");
    setFile(undefined);
    setPreview(undefined);
    setDryRun(undefined);
    if (inputRef.current) inputRef.current.value = "";
    onImported();
  }

  async function exportCsv() {
    setState("exporting");
    const response = await api
      .GET("/api/v1/employees/export.csv", { parseAs: "text" })
      .catch(() => undefined);
    if (!response?.data) {
      setState("error");
      return;
    }
    downloadCsv(response.data, "employees-standard.csv");
    setState("idle");
  }

  return (
    <Card className="grid gap-4">
      <div>
        <h2 className="text-lg font-semibold text-ink">{t.title}</h2>
        <p className="text-sm text-steel">{t.description}</p>
      </div>
      {state === "error" ? (
        <p role="alert" className="text-sm font-semibold text-red-700">
          {file ? t.failed : t.noFile}
        </p>
      ) : null}
      <div className="grid gap-2">
        <label
          className="text-sm font-medium text-steel"
          htmlFor="employee-import-file"
        >
          {t.fileLabel}
        </label>
        <input
          ref={inputRef}
          id="employee-import-file"
          data-testid="excel-import-file"
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="text-sm text-steel"
          onChange={(event) => {
            setFile(event.currentTarget.files?.[0]);
            setState("idle");
            setPreview(undefined);
            setDryRun(undefined);
            setSummary(undefined);
          }}
        />
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="secondary"
          disabled={state === "exporting"}
          onClick={() => {
            void exportCsv();
          }}
        >
          {state === "exporting" ? t.exporting : t.exportCsv}
        </Button>
        <Button
          type="button"
          disabled={!file || state === "previewing"}
          onClick={() => {
            void previewFile();
          }}
        >
          <Upload aria-hidden="true" size={16} />
          {state === "previewing" ? t.previewing : t.preview}
        </Button>
      </div>
      {preview ? (
        <ImportPreview
          preview={preview}
          dryRun={dryRun}
          state={state}
          onDryRun={() => {
            void dryRunImport();
          }}
          onApply={() => {
            void applyImport();
          }}
        />
      ) : null}
      {dryRun ? <ImportDryRunSummary summary={dryRun} /> : null}
      {summary ? <ImportSummary summary={summary} /> : null}
    </Card>
  );
}

function AttendanceImportPanel({ api }: { api: EmployeeApi }) {
  const t = ko.employees.attendanceImport;
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File>();
  const [state, setState] = useState<UploadState>("idle");
  const [preview, setPreview] = useState<AttendanceImportPreview>();
  const [dryRun, setDryRun] = useState<AttendanceImportDryRun>();
  const [summary, setSummary] = useState<AttendanceImportApplyReport>();

  async function previewFile() {
    if (!file) {
      setState("error");
      return;
    }
    setState("previewing");
    setPreview(undefined);
    setDryRun(undefined);
    setSummary(undefined);
    const response = await api
      .POST("/api/v1/hr/attendance-import/preview", {
        body: { file: file as unknown as string },
        bodySerializer(body: { file: string }) {
          const form = new FormData();
          form.append("file", body.file as unknown as File);
          return form;
        },
      })
      .catch(() => undefined);
    if (!response?.data) {
      setState("error");
      return;
    }
    setPreview(response.data);
    setState("idle");
  }

  async function dryRunImport() {
    if (!preview) return;
    setState("dryRunning");
    setDryRun(undefined);
    setSummary(undefined);
    const response = await api
      .POST("/api/v1/hr/attendance-import/{run_id}/dry-run", {
        params: { path: { run_id: preview.run_id } },
      })
      .catch(() => undefined);
    if (!response?.data) {
      setState("error");
      return;
    }
    setDryRun(response.data);
    setState("idle");
  }

  async function applyImport() {
    if (!preview || !dryRun) return;
    setState("applying");
    const response = await api
      .POST("/api/v1/hr/attendance-import/{run_id}/apply", {
        params: { path: { run_id: preview.run_id } },
      })
      .catch(() => undefined);
    if (!response?.data) {
      setState("error");
      return;
    }
    setSummary(response.data);
    setState("idle");
    setFile(undefined);
    setPreview(undefined);
    setDryRun(undefined);
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <Card className="grid gap-4">
      <div>
        <h2 className="text-lg font-semibold text-ink">{t.title}</h2>
        <p className="text-sm text-steel">{t.description}</p>
      </div>
      {state === "error" ? (
        <p role="alert" className="text-sm font-semibold text-red-700">
          {file ? t.failed : t.noFile}
        </p>
      ) : null}
      <div className="grid gap-2">
        <label
          className="text-sm font-medium text-steel"
          htmlFor="attendance-import-file"
        >
          {t.fileLabel}
        </label>
        <input
          ref={inputRef}
          id="attendance-import-file"
          data-testid="attendance-import-file"
          type="file"
          accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
          className="text-sm text-steel"
          onChange={(event) => {
            setFile(event.currentTarget.files?.[0]);
            setState("idle");
            setPreview(undefined);
            setDryRun(undefined);
            setSummary(undefined);
          }}
        />
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          disabled={!file || state === "previewing"}
          onClick={() => {
            void previewFile();
          }}
        >
          <Upload aria-hidden="true" size={16} />
          {state === "previewing" ? t.previewing : t.preview}
        </Button>
      </div>
      {preview ? (
        <AttendanceImportPreviewPanel
          preview={preview}
          dryRun={dryRun}
          state={state}
          onDryRun={() => {
            void dryRunImport();
          }}
          onApply={() => {
            void applyImport();
          }}
        />
      ) : null}
      {dryRun ? <AttendanceImportDryRunSummaryView summary={dryRun} /> : null}
      {summary ? <AttendanceImportApplySummary summary={summary} /> : null}
    </Card>
  );
}

function AttendanceImportPreviewPanel({
  preview,
  dryRun,
  state,
  onDryRun,
  onApply,
}: {
  preview: AttendanceImportPreview;
  dryRun?: AttendanceImportDryRun;
  state: UploadState;
  onDryRun: () => void;
  onApply: () => void;
}) {
  const t = ko.employees.attendanceImport.previewPanel;
  const mappingCounts = attendanceImportMappingCounts(preview.columns);
  return (
    <section className="grid gap-3 rounded-lg border border-line bg-muted-panel/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-ink">{t.title}</h3>
          <p className="text-sm text-steel">
            {preview.source_filename} · {t.hash}{" "}
            <code className="font-mono text-xs">
              {preview.source_sha256.slice(0, 12)}
            </code>
          </p>
          <p className="mt-1 text-xs font-semibold text-emerald-800">
            {t.payrollLineageOnly}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={state === "dryRunning"}
            onClick={onDryRun}
          >
            {state === "dryRunning" ? t.dryRunning : t.dryRun}
          </Button>
          <Button
            type="button"
            disabled={!dryRun || dryRun.error_rows > 0 || state === "applying"}
            onClick={onApply}
          >
            {state === "applying" ? t.applying : t.apply}
          </Button>
        </div>
      </div>
      <dl
        aria-label={t.mappingSummary}
        className="grid gap-2 text-sm sm:grid-cols-3"
      >
        {(
          [
            [t.mappedColumns, mappingCounts.canonical, "bg-emerald-50 text-emerald-800"],
            [t.maskedColumns, mappingCounts.restricted, "bg-amber-50 text-amber-800"],
            [t.rawOnlyColumns, mappingCounts.retained, "bg-slate-100 text-slate-800"],
          ] as const
        ).map(([label, value, className]) => (
          <div key={label} className="rounded border border-line bg-white p-3">
            <dt className="text-xs font-semibold text-steel">{label}</dt>
            <dd
              className={`mt-1 inline-flex rounded-full px-2 py-1 text-xs font-semibold ${className}`}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <dl className="grid gap-2 text-sm sm:grid-cols-3">
        <div>
          <dt className="font-semibold text-steel">{t.inputRows}</dt>
          <dd className="text-ink">{preview.input_rows}</dd>
        </div>
        <div>
          <dt className="font-semibold text-steel">{t.candidateRows}</dt>
          <dd className="text-ink">{preview.candidate_rows}</dd>
        </div>
        <div>
          <dt className="font-semibold text-steel">{t.preservedRows}</dt>
          <dd className="text-ink">{preview.preserved_rows}</dd>
        </div>
      </dl>
      <div className="overflow-x-auto rounded-lg border border-line bg-white">
        <table className="min-w-full divide-y divide-line text-sm">
          <thead className="bg-muted-panel/60 text-left text-xs font-semibold uppercase tracking-wide text-steel">
            <tr>
              <th className="px-3 py-2">{t.sourceColumn}</th>
              <th className="px-3 py-2">{t.targetField}</th>
              <th className="px-3 py-2">{t.policy}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {preview.columns.map((column) => (
              <tr key={column.normalized_header}>
                <td className="px-3 py-2 font-medium text-ink">
                  {column.source_header || column.normalized_header}
                </td>
                <td className="px-3 py-2 text-steel">
                  <span className="font-medium text-ink">
                    {attendanceImportTargetLabel(column.target)}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <span
                    className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${attendanceImportPolicyClass(column.classification)}`}
                  >
                    {attendanceImportPolicyLabel(column.classification)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="overflow-x-auto rounded-lg border border-line bg-white">
        <table className="min-w-full divide-y divide-line text-sm">
          <thead className="bg-muted-panel/60 text-left text-xs font-semibold uppercase tracking-wide text-steel">
            <tr>
              <th className="px-3 py-2">{t.row}</th>
              <th className="px-3 py-2">{t.status}</th>
              {preview.columns.slice(0, 8).map((column) => (
                <th key={column.normalized_header} className="px-3 py-2">
                  {column.normalized_header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {preview.sample_rows.map((row) => (
              <tr key={`${row.source_sheet}-${String(row.source_row)}`}>
                <td className="px-3 py-2 font-medium text-ink">
                  {row.source_sheet} #{row.source_row}
                </td>
                <td className="px-3 py-2 text-steel">{row.row_status}</td>
                {preview.columns.slice(0, 8).map((column) => (
                  <td
                    key={column.normalized_header}
                    className="px-3 py-2 text-steel"
                  >
                    {textValue(row.values[column.normalized_header])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

type AttendanceImportColumn = AttendanceImportPreview["columns"][number];

function attendanceImportMappingCounts(columns: AttendanceImportColumn[]) {
  return columns.reduce(
    (counts, column) => {
      counts[column.classification] += 1;
      return counts;
    },
    { canonical: 0, restricted: 0, retained: 0 },
  );
}

function attendanceImportTargetLabel(
  target: AttendanceImportColumn["target"],
): string {
  if (!target) return ko.employees.attendanceImport.previewPanel.rawOnly;
  const { targetLabels } = ko.employees.attendanceImport.previewPanel;
  return targetLabels[target];
}

function attendanceImportPolicyLabel(classification: string): string {
  const t = ko.employees.attendanceImport.previewPanel;
  if (classification === "canonical") return t.previewAllowed;
  if (classification === "restricted") return t.masked;
  return t.rawOnly;
}

function attendanceImportPolicyClass(classification: string): string {
  if (classification === "canonical") return "bg-emerald-50 text-emerald-800";
  if (classification === "restricted") return "bg-amber-50 text-amber-800";
  return "bg-slate-100 text-slate-800";
}

function AttendanceImportDryRunSummaryView({
  summary,
}: {
  summary: AttendanceImportDryRun;
}) {
  const t = ko.employees.attendanceImport.dryRun;
  const rows: Array<[string, number]> = [
    [t.readyRows, summary.ready_rows],
    [t.errorRows, summary.error_rows],
    [t.duplicateRows, summary.duplicate_rows],
    [t.missingEmployeeRows, summary.missing_employee_rows],
    [t.ambiguousEmployeeRows, summary.ambiguous_employee_rows],
  ];
  return (
    <div className="grid gap-3 rounded-md border border-line bg-muted-panel p-3 text-sm">
      <dl className="grid gap-2 sm:grid-cols-5">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt className="font-semibold text-steel">{label}</dt>
            <dd className="text-ink">{String(value)}</dd>
          </div>
        ))}
      </dl>
      {summary.row_errors.length > 0 ? (
        <ul className="grid gap-1 text-xs text-red-700">
          {summary.row_errors.slice(0, 5).map((error) => (
            <li key={`${error.source_sheet}-${String(error.source_row)}-${error.code}`}>
              {error.source_sheet} #{error.source_row} · {error.code}:{" "}
              {error.message}
            </li>
          ))}
          {summary.row_errors.length > 5 ? (
            <li>{t.moreRowErrors(summary.row_errors.length - 5)}</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

function AttendanceImportApplySummary({
  summary,
}: {
  summary: AttendanceImportApplyReport;
}) {
  const t = ko.employees.attendanceImport.summary;
  const rows: Array<[string, number]> = [
    [t.inserted, summary.inserted],
    [t.skipped, summary.skipped],
    [t.errors, summary.error_rows],
  ];

  return (
    <dl className="grid gap-2 rounded-md border border-line bg-muted-panel p-3 text-sm sm:grid-cols-3">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt className="font-semibold text-steel">{label}</dt>
          <dd className="text-ink">{String(value)}</dd>
        </div>
      ))}
    </dl>
  );
}
function ImportPreview({
  preview,
  dryRun,
  state,
  onDryRun,
  onApply,
}: {
  preview: EmployeeImportPreview;
  dryRun?: EmployeeImportDryRun;
  state: UploadState;
  onDryRun: () => void;
  onApply: () => void;
}) {
  const t = ko.employees.import.previewPanel;
  const mappingCounts = employeeImportMappingCounts(preview.columns);
  return (
    <section className="grid gap-3 rounded-lg border border-line bg-muted-panel/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-ink">{t.title}</h3>
          <p className="text-sm text-steel">
            {preview.source_filename} · {t.hash}{" "}
            <code className="font-mono text-xs">
              {preview.source_sha256.slice(0, 12)}
            </code>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={state === "dryRunning"}
            onClick={onDryRun}
          >
            {state === "dryRunning" ? t.dryRunning : t.dryRun}
          </Button>
          <Button
            type="button"
            disabled={!dryRun || state === "applying"}
            onClick={onApply}
          >
            {state === "applying" ? t.applying : t.apply}
          </Button>
        </div>
      </div>
      <dl
        aria-label={t.mappingSummary}
        className="grid gap-2 text-sm sm:grid-cols-4"
      >
        {(
          [
            [
              t.mappedColumns,
              mappingCounts.canonical,
              "bg-emerald-50 text-emerald-800",
            ],
            [
              t.maskedColumns,
              mappingCounts.restricted,
              "bg-amber-50 text-amber-800",
            ],
            [
              t.locationColumns,
              mappingCounts.location,
              "bg-blue-50 text-blue-800",
            ],
            [
              t.rawOnlyColumns,
              mappingCounts.retained,
              "bg-slate-100 text-slate-800",
            ],
          ] as const
        ).map(([label, value, className]) => (
          <div key={label} className="rounded border border-line bg-white p-3">
            <dt className="text-xs font-semibold text-steel">{label}</dt>
            <dd
              className={`mt-1 inline-flex rounded-full px-2 py-1 text-xs font-semibold ${className}`}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <dl className="grid gap-2 text-sm sm:grid-cols-3">
        <div>
          <dt className="font-semibold text-steel">{t.inputRows}</dt>
          <dd className="text-ink">{preview.input_rows}</dd>
        </div>
        <div>
          <dt className="font-semibold text-steel">{t.candidateRows}</dt>
          <dd className="text-ink">{preview.candidate_rows}</dd>
        </div>
        <div>
          <dt className="font-semibold text-steel">{t.preservedRows}</dt>
          <dd className="text-ink">{preview.preserved_rows}</dd>
        </div>
      </dl>
      <div className="overflow-x-auto rounded-lg border border-line bg-white">
        <table className="min-w-full divide-y divide-line text-sm">
          <thead className="bg-muted-panel/60 text-left text-xs font-semibold uppercase tracking-wide text-steel">
            <tr>
              <th className="px-3 py-2">{t.sourceColumn}</th>
              <th className="px-3 py-2">{t.targetField}</th>
              <th className="px-3 py-2">{t.policy}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {preview.columns.map((column) => (
              <tr key={column.normalized_header}>
                <td className="px-3 py-2 font-medium text-ink">
                  {column.source_header || column.normalized_header}
                </td>
                <td className="px-3 py-2 text-steel">
                  <span className="font-medium text-ink">
                    {employeeImportTargetLabel(column.target)}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <span
                    className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${employeeImportPolicyClass(column.classification)}`}
                  >
                    {employeeImportPolicyLabel(column.classification)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="overflow-x-auto rounded-lg border border-line bg-white">
        <table className="min-w-full divide-y divide-line text-sm">
          <thead className="bg-muted-panel/60 text-left text-xs font-semibold uppercase tracking-wide text-steel">
            <tr>
              <th className="px-3 py-2">{t.row}</th>
              <th className="px-3 py-2">{t.status}</th>
              {preview.columns.slice(0, 8).map((column) => (
                <th key={column.normalized_header} className="px-3 py-2">
                  {column.normalized_header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {preview.sample_rows.map((row) => (
              <tr key={`${row.source_sheet}-${String(row.source_row)}`}>
                <td className="px-3 py-2 font-medium text-ink">
                  {row.source_sheet} #{row.source_row}
                </td>
                <td className="px-3 py-2 text-steel">{row.row_status}</td>
                {preview.columns.slice(0, 8).map((column) => (
                  <td
                    key={column.normalized_header}
                    className="px-3 py-2 text-steel"
                  >
                    {textValue(row.values[column.normalized_header])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

type EmployeeImportColumn = EmployeeImportPreview["columns"][number];

function employeeImportMappingCounts(columns: EmployeeImportColumn[]) {
  return columns.reduce(
    (counts, column) => {
      const { classification } = column;
      counts[classification] += 1;
      return counts;
    },
    { canonical: 0, restricted: 0, location: 0, retained: 0 },
  );
}

function employeeImportTargetLabel(
  target: EmployeeImportColumn["target"],
): string {
  if (!target) return ko.employees.import.previewPanel.rawOnly;
  const { targetLabels } = ko.employees.import.previewPanel;
  return targetLabels[target];
}

function employeeImportPolicyLabel(classification: string): string {
  const t = ko.employees.import.previewPanel;
  if (classification === "canonical") return t.previewAllowed;
  if (classification === "restricted") return t.masked;
  if (classification === "location") return t.locationMasked;
  return t.rawOnly;
}

function employeeImportPolicyClass(classification: string): string {
  if (classification === "canonical") return "bg-emerald-50 text-emerald-800";
  if (classification === "restricted") return "bg-amber-50 text-amber-800";
  if (classification === "location") return "bg-blue-50 text-blue-800";
  return "bg-slate-100 text-slate-800";
}

function ImportDryRunSummary({ summary }: { summary: EmployeeImportDryRun }) {
  const t = ko.employees.import.dryRun;
  const rows: Array<[string, number]> = [
    [t.insertCandidates, summary.insert_candidates],
    [t.updateCandidates, summary.update_candidates],
    [t.preservedRows, summary.preserved_rows],
  ];
  return (
    <dl className="grid gap-2 rounded-md border border-line bg-muted-panel p-3 text-sm sm:grid-cols-3">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt className="font-semibold text-steel">{label}</dt>
          <dd className="text-ink">{String(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function ImportSummary({ summary }: { summary: EmployeeImportSummary }) {
  const t = ko.employees.import.summary;
  const candidates: Array<[string, number | undefined]> = [
    [t.inputRows, summary.input_rows],
    [t.inserted, summary.inserted],
    [t.updated, summary.updated],
  ];
  const rows = candidates.filter(
    (row): row is [string, number] => row[1] !== undefined,
  );

  return (
    <dl className="grid gap-2 rounded-md border border-line bg-muted-panel p-3 text-sm sm:grid-cols-5">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt className="font-semibold text-steel">{label}</dt>
          <dd className="text-ink">{String(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function summarizeOrgChart(orgChart?: HrOrgChartResponse): {
  companies: number;
  employees: number;
  active: number;
} {
  const companies = orgChart?.companies ?? [];
  return {
    companies: companies.length,
    employees: companies.reduce((sum, company) => sum + company.total, 0),
    active: companies.reduce((sum, company) => sum + company.active, 0),
  };
}

function countEmploymentStatuses(employees: EmployeeDirectoryItem[]): {
  active: number;
  exited: number;
} {
  return employees.reduce(
    (counts, employee) => {
      if (String(employee.status).toUpperCase() === "EXITED") {
        counts.exited += 1;
      } else if (String(employee.status).toUpperCase() === "ACTIVE") {
        counts.active += 1;
      }
      return counts;
    },
    { active: 0, exited: 0 },
  );
}

function countIdentityResolution(employees: EmployeeDirectoryItem[]): {
  reviewRequired: number;
  highConfidence: number;
} {
  return employees.reduce(
    (counts, employee) => {
      if (employee.identity_review_required) {
        counts.reviewRequired += 1;
      }
      if (employee.identity_resolution_confidence === "high") {
        counts.highConfidence += 1;
      }
      return counts;
    },
    { reviewRequired: 0, highConfidence: 0 },
  );
}

function readinessStatusClass(
  status: string | null | undefined,
  calculationEnabledRuns: number,
): string {
  if (calculationEnabledRuns > 0) {
    return "bg-emerald-50 text-emerald-800";
  }
  if (status === "BLOCKED_LEGAL_GATE") {
    return "bg-amber-50 text-amber-800";
  }
  if (status) {
    return "bg-blue-50 text-blue-800";
  }
  return "bg-slate-100 text-slate-700";
}

function employeeName(employee: EmployeeDirectoryItem): string {
  return text(employee.name);
}

function companyName(employee: EmployeeDirectoryItem): string {
  return text(employee.company);
}

function lifecycleToStatus(
  eventType: EmployeeLifecycleEventType,
): "ACTIVE" | "EXITED" {
  return eventType === "OFFBOARD" || eventType === "TERMINATE"
    ? "EXITED"
    : "ACTIVE";
}

function textValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return JSON.stringify(value);
}

function text(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}

function trimmedOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function downloadCsv(csv: string, fileName: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
