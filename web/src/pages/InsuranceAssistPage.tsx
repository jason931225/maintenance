import {
  ClipboardCheck,
  FileSpreadsheet,
  Mail,
  ShieldCheck,
  UserCheck,
  UserX,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import type { ConsoleApiClient } from "../api/client";
import type {
  EmployeeDirectoryItem,
  EmployeeDirectoryPage,
  HrReadinessSummary,
} from "../api/types";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import { PageError } from "../components/states/PageError";
import { SkeletonTable } from "../components/states/Skeleton";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { useAuth } from "../context/auth";
import { insuranceAssistKo as copy } from "../i18n/hrWorkflows";
import type { Tone } from "../lib/semantic";
import { toneBadgeClass } from "../lib/semantic";
import { formatListCount } from "../lib/utils";

type LoadState = "loading" | "idle" | "error";
type InsuranceReportKind =
  | "acquisition"
  | "loss"
  | "missing"
  | "identityReview"
  | "steady";

type InsuranceAssistApi = ConsoleApiClient & {
  GET(
    path: "/api/v1/employees",
    options?: {
      params?: {
        query?: { limit?: number; offset?: number; company?: string };
      };
    },
  ): Promise<{ data?: EmployeeDirectoryPage }>;
  GET(path: "/api/v1/hr/readiness-summary"): Promise<{
    data?: HrReadinessSummary;
  }>;
};

interface InsuranceRow {
  employee: EmployeeDirectoryItem;
  report: InsuranceReport;
  missingFields: string[];
}

interface InsuranceReport {
  kind: InsuranceReportKind;
  label: string;
  tone: Tone;
  Icon: LucideIcon;
}

export function InsuranceAssistPage() {
  const { api } = useAuth();
  const insuranceApi = api as InsuranceAssistApi;
  const [state, setState] = useState<LoadState>("loading");
  const [employees, setEmployees] = useState<EmployeeDirectoryItem[]>([]);
  const [readinessSummary, setReadinessSummary] =
    useState<HrReadinessSummary>();

  const loadInsurance = useCallback(async () => {
    setState("loading");
    const [employeesResponse, readinessResponse] = await Promise.all([
      insuranceApi
        .GET("/api/v1/employees", {
          params: { query: { limit: 1000, offset: 0 } },
        })
        .catch(() => undefined),
      insuranceApi.GET("/api/v1/hr/readiness-summary").catch(() => undefined),
    ]);

    if (!employeesResponse?.data || !readinessResponse?.data) {
      setState("error");
      return;
    }

    setEmployees(employeesResponse.data.items);
    setReadinessSummary(readinessResponse.data);
    setState("idle");
  }, [insuranceApi]);

  useEffect(() => {
    void Promise.resolve().then(loadInsurance);
  }, [loadInsurance]);

  const rows = useMemo(
    () =>
      employees.map((employee) => ({
        employee,
        report: insuranceReport(employee),
        missingFields: insuranceMissingFields(employee),
      })),
    [employees],
  );

  return (
    <>
      <PageHeader
        title={copy.title}
        description={copy.description}
        actions={
          <RefreshButton
            onClick={() => {
              void loadInsurance();
            }}
            isLoading={state === "loading"}
          />
        }
      />

      <div className="grid max-w-7xl gap-5">
        {state === "loading" ? <SkeletonTable rows={5} cols={6} /> : null}
        {state === "error" ? (
          <PageError
            message={copy.loadFailed}
            onRetry={() => {
              void loadInsurance();
            }}
          />
        ) : null}
        {state === "idle" && readinessSummary ? (
          <>
            <InsuranceOverviewPanel rows={rows} readinessSummary={readinessSummary} />
            <InsuranceWorkflowPanel readinessSummary={readinessSummary} />
            <InsuranceRosterPanel rows={rows} />
          </>
        ) : null}
      </div>
    </>
  );
}

function InsuranceOverviewPanel({
  rows,
  readinessSummary,
}: {
  rows: InsuranceRow[];
  readinessSummary: HrReadinessSummary;
}) {
  const active = rows.filter((row) => isActiveEmployee(row.employee)).length;
  const acquisition = rows.filter(
    (row) => row.report.kind === "acquisition",
  ).length;
  const loss = rows.filter((row) => row.report.kind === "loss").length;
  const missing = rows.filter((row) => row.missingFields.length > 0).length;
  const cards = [
    {
      label: copy.overview.activeEmployees,
      value: formatListCount(active),
      meta: copy.overview.activeMeta(formatListCount(rows.length)),
    },
    {
      label: copy.overview.acquisition,
      value: formatListCount(acquisition),
      meta: copy.overview.acquisitionMeta,
    },
    {
      label: copy.overview.loss,
      value: formatListCount(loss),
      meta: copy.overview.lossMeta,
    },
    {
      label: copy.overview.missing,
      value: formatListCount(missing),
      meta: copy.overview.missingMeta,
    },
    {
      label: copy.overview.payrollSource,
      value: formatListCount(readinessSummary.payroll.payroll_source_rows),
      meta: copy.overview.payrollSourceMeta(
        formatListCount(readinessSummary.payroll.draft_lines),
      ),
    },
    {
      label: copy.overview.attendance,
      value: formatListCount(readinessSummary.attendance.durable_events),
      meta: copy.overview.attendanceMeta(
        formatListCount(readinessSummary.payroll.attendance_event_links),
      ),
    },
  ];

  return (
    <Card className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">
            {copy.overview.title}
          </h2>
          <p className="text-sm text-steel">{copy.overview.description}</p>
        </div>
        <Badge className={toneBadgeClass("info")}>{copy.overview.badge}</Badge>
      </div>
      <dl className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {cards.map((card) => (
          <div
            key={card.label}
            className="rounded-lg border border-line bg-muted-panel/40 p-3"
          >
            <dt className="text-xs font-semibold text-steel">{card.label}</dt>
            <dd className="mt-1 text-2xl font-semibold text-ink">
              {card.value}
            </dd>
            <dd className="mt-1 text-xs text-steel">{card.meta}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function InsuranceWorkflowPanel({
  readinessSummary,
}: {
  readinessSummary: HrReadinessSummary;
}) {
  const tasks = [
    {
      content: copy.workflow.acquisition,
      Icon: UserCheck,
      href: "/settings/employees",
      tone: "success",
    },
    {
      content: copy.workflow.loss,
      Icon: UserX,
      href: "/settings/employees",
      tone: "warning",
    },
    {
      content: copy.workflow.change,
      Icon: ClipboardCheck,
      href: "/settings/workflows",
      tone: "accent",
    },
    {
      content: {
        title: copy.workflow.package.title,
        detail: copy.workflow.package.detail(
          formatListCount(readinessSummary.payroll.payroll_source_rows),
          formatListCount(readinessSummary.attendance.durable_events),
        ),
      },
      Icon: FileSpreadsheet,
      href: "/payroll",
      tone: "info",
    },
  ] as const;

  return (
    <Card className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">
            {copy.workflow.title}
          </h2>
          <p className="text-sm text-steel">{copy.workflow.description}</p>
        </div>
        <Button asChild size="sm" variant="secondary">
          <Link to="/mail?compose=insurance">
            <Mail size={16} aria-hidden="true" />
            {copy.workflow.mailAction}
          </Link>
        </Button>
      </div>
      <div className="grid gap-3 lg:grid-cols-4">
        {tasks.map(({ content, Icon, href, tone }) => (
          <article
            key={content.title}
            className="grid gap-3 rounded-lg border border-line bg-white p-4"
          >
            <span
              className={`inline-flex h-10 w-10 items-center justify-center rounded border ${toneBadgeClass(tone)}`}
            >
              <Icon size={18} aria-hidden="true" />
            </span>
            <div>
              <h3 className="font-semibold text-ink">{content.title}</h3>
              <p className="mt-1 text-sm text-steel">{content.detail}</p>
            </div>
            <Button
              asChild
              size="xs"
              variant="ghost"
              className="justify-self-start"
            >
              <Link to={href}>{copy.workflow.linkedScreen}</Link>
            </Button>
          </article>
        ))}
      </div>
    </Card>
  );
}

function InsuranceRosterPanel({ rows }: { rows: InsuranceRow[] }) {
  const visibleRows = rows.slice(0, 100);

  return (
    <Card className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">
            {copy.roster.title}
          </h2>
          <p className="text-sm text-steel">{copy.roster.description}</p>
        </div>
        <Badge>{formatListCount(visibleRows.length, { total: rows.length })}</Badge>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-line text-sm">
          <thead>
            <tr className="text-left text-xs font-semibold uppercase text-steel">
              <th className="px-3 py-2">{copy.roster.columns.employee}</th>
              <th className="px-3 py-2">{copy.roster.columns.dates}</th>
              <th className="px-3 py-2">{copy.roster.columns.department}</th>
              <th className="px-3 py-2">{copy.roster.columns.report}</th>
              <th className="px-3 py-2">{copy.roster.columns.missing}</th>
              <th className="px-3 py-2">{copy.roster.columns.link}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {visibleRows.map(({ employee, report, missingFields }) => {
              const Icon = report.Icon;
              return (
                <tr key={employee.id} className="align-top">
                  <td className="px-3 py-3">
                    <p className="font-semibold text-ink">{text(employee.name)}</p>
                    <p className="text-xs text-steel">
                      {text(employee.company)} / {text(employee.employee_number)}
                    </p>
                  </td>
                  <td className="px-3 py-3 text-steel">
                    <p>{copy.roster.hireDate(text(employee.hire_date))}</p>
                    <p className="text-xs">
                      {copy.roster.exitDate(text(employee.exit_date))}
                    </p>
                  </td>
                  <td className="px-3 py-3 text-steel">
                    {text(employee.org_unit)} / {text(employee.position)}
                  </td>
                  <td className="px-3 py-3">
                    <Badge className={toneBadgeClass(report.tone)}>
                      <Icon size={14} aria-hidden="true" />
                      {report.label}
                    </Badge>
                  </td>
                  <td className="px-3 py-3 text-steel">
                    {missingFields.length === 0 ? (
                      <Badge className={toneBadgeClass("success")}>
                        {copy.roster.dataReady}
                      </Badge>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {missingFields.map((field) => (
                          <Badge key={field} className={toneBadgeClass("warning")}>
                            {field}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <Button asChild size="xs" variant="ghost">
                      <Link to={`/settings/employees?focus=${employee.id}`}>
                        {copy.roster.employeeLedger}
                      </Link>
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function insuranceReport(employee: EmployeeDirectoryItem): InsuranceReport {
  if (employee.exit_date || employee.status === "EXITED") {
    return {
      kind: "loss",
      label: copy.reports.loss,
      tone: "warning",
      Icon: UserX,
    };
  }
  if (!employee.hire_date || !employee.employee_number) {
    return {
      kind: "missing",
      label: copy.reports.missing,
      tone: "danger",
      Icon: ShieldCheck,
    };
  }
  if (isRecentDate(employee.hire_date, 30)) {
    return {
      kind: "acquisition",
      label: copy.reports.acquisition,
      tone: "success",
      Icon: UserCheck,
    };
  }
  if (employee.identity_review_required) {
    return {
      kind: "identityReview",
      label: copy.reports.identityReview,
      tone: "warning",
      Icon: ShieldCheck,
    };
  }
  return {
    kind: "steady",
    label: copy.reports.steady,
    tone: "neutral",
    Icon: ClipboardCheck,
  };
}

function insuranceMissingFields(employee: EmployeeDirectoryItem): string[] {
  const fields: string[] = [];
  if (!employee.employee_number) fields.push(copy.fields.employeeNumber);
  if (!employee.hire_date) fields.push(copy.fields.hireDate);
  if (!employee.company) fields.push(copy.fields.company);
  if (!employee.name) fields.push(copy.fields.name);
  if ((employee.status === "EXITED" || employee.exit_date) && !employee.exit_date) {
    fields.push(copy.fields.exitDate);
  }
  if (employee.identity_review_required) fields.push(copy.fields.identity);
  return fields;
}

function isRecentDate(value: string | null | undefined, days: number): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const elapsed = Date.now() - parsed;
  return elapsed >= 0 && elapsed <= days * 24 * 60 * 60 * 1000;
}

function isActiveEmployee(employee: EmployeeDirectoryItem): boolean {
  return employee.status !== "EXITED" && employee.status !== "TERMINATED";
}

function text(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}
