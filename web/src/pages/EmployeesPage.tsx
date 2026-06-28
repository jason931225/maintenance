import { Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ConsoleApiClient } from "../api/client";
import type {
  AttendanceSummaryPage,
  EmployeeDirectoryItem,
  EmployeeDirectoryPage,
  EmployeeImportSummary,
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
type UploadState = "idle" | "uploading" | "error";

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
  POST(
    path: "/api/v1/employees/import",
    options: {
      body: { file: string };
      bodySerializer: (body: { file: string }) => FormData;
    },
  ): Promise<{ data?: EmployeeImportSummary }>;
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
  const [total, setTotal] = useState<number>();
  const [company, setCompany] = useState("all");

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

    const [orgResponse, leaveResponse, attendanceResponse] = await Promise.all([
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
    ]);

    if (
      !orgResponse?.data ||
      !leaveResponse?.data ||
      !attendanceResponse?.data
    ) {
      setState("error");
      return;
    }

    setEmployees(items);
    setOrgChart(orgResponse.data);
    setLeaveBalances(leaveResponse.data);
    setAttendanceSummary(attendanceResponse.data);
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
            />
            <OrgChartPanel orgChart={orgChart} />
            <div className="grid gap-5 xl:grid-cols-2">
              <LeaveBalancePanel leaveBalances={leaveBalances} />
              <AttendanceSummaryPanel attendanceSummary={attendanceSummary} />
            </div>
            <EmployeeTable employees={visibleEmployees} />
          </>
        ) : null}

        {canImport ? (
          <EmployeeImportPanel
            api={employeeApi}
            onImported={() => {
              void loadEmployees();
            }}
          />
        ) : null}
      </div>
    </>
  );
}

function HrDashboard({
  orgChart,
  leaveBalances,
  attendanceSummary,
}: {
  orgChart?: HrOrgChartResponse;
  leaveBalances?: LeaveBalancePage;
  attendanceSummary?: AttendanceSummaryPage;
}) {
  const t = ko.employees.dashboard;
  const totals = summarizeOrgChart(orgChart);
  const cards: Array<[string, string | number | undefined]> = [
    [t.companies, totals.companies],
    [t.employees, totals.employees],
    [t.activeEmployees, totals.active],
    [t.leaveRemaining, leaveBalances?.summary.remaining],
    [t.attendanceUsers, attendanceSummary?.total],
  ];

  return (
    <Card className="grid gap-4">
      <div>
        <h2 className="text-lg font-semibold text-ink">{t.title}</h2>
        <p className="text-sm text-steel">{t.description}</p>
      </div>
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
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

function EmployeeTable({ employees }: { employees: EmployeeDirectoryItem[] }) {
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
            <th className="px-4 py-3">{t.columns.worksite}</th>
            <th className="px-4 py-3">{t.columns.job}</th>
            <th className="px-4 py-3">{t.columns.position}</th>
            <th className="px-4 py-3">{t.columns.hireDate}</th>
            <th className="px-4 py-3">{t.columns.exitDate}</th>
            <th className="px-4 py-3">{t.columns.status}</th>
            <th className="px-4 py-3">{t.columns.leaveRemaining}</th>
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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
  const [summary, setSummary] = useState<EmployeeImportSummary>();

  async function upload() {
    if (!file) {
      setState("error");
      return;
    }
    setState("uploading");
    setSummary(undefined);
    const response = await api
      .POST("/api/v1/employees/import", {
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
    setSummary(response.data);
    setState("idle");
    setFile(undefined);
    if (inputRef.current) inputRef.current.value = "";
    onImported();
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
          }}
        />
      </div>
      <div className="flex justify-end">
        <Button
          type="button"
          disabled={!file || state === "uploading"}
          onClick={() => {
            void upload();
          }}
        >
          <Upload aria-hidden="true" size={16} />
          {state === "uploading" ? t.uploading : t.submit}
        </Button>
      </div>
      {summary ? <ImportSummary summary={summary} /> : null}
    </Card>
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

function employeeName(employee: EmployeeDirectoryItem): string {
  return text(employee.name);
}

function companyName(employee: EmployeeDirectoryItem): string {
  return text(employee.company);
}

function text(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}
