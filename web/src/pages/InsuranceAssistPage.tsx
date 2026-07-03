import {
  AlertTriangle,
  CheckCircle2,
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
  AbsenceExitDashboardResponse,
  ConfirmEmployeeExitCaseRequest,
  EmployeeDirectoryItem,
  EmployeeDirectoryPage,
  EmployeeAbsenceAlert,
  EmployeeExitCase,
  HrReadinessSummary,
  ReportEmployeeExitCaseRequest,
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
import {
  exitCaseStatusLabel,
  exitCaseTone,
  exitWorkflowRoleLabel,
} from "../lib/hrExitWorkflow";
import type { Tone } from "../lib/semantic";
import { toneBadgeClass } from "../lib/semantic";
import { formatListCount } from "../lib/utils";

type LoadState = "loading" | "idle" | "error";
type ActionState = "idle" | "busy" | "error";
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
  GET(
    path: "/api/v1/hr/absence-exit-dashboard",
    options?: { params?: { query?: { limit?: number; offset?: number } } },
  ): Promise<{ data?: AbsenceExitDashboardResponse }>;
  POST(
    path: "/api/v1/hr/exit-cases",
    options: { body: ReportEmployeeExitCaseRequest },
  ): Promise<{ data?: EmployeeExitCase }>;
  POST(
    path: "/api/v1/hr/exit-cases/{id}/confirm",
    options: {
      params: { path: { id: string } };
      body: ConfirmEmployeeExitCaseRequest;
    },
  ): Promise<{ data?: EmployeeExitCase }>;
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
  const [absenceExitDashboard, setAbsenceExitDashboard] =
    useState<AbsenceExitDashboardResponse>();
  const [actionState, setActionState] = useState<ActionState>("idle");
  const [actionMessage, setActionMessage] = useState<string>();

  const loadInsurance = useCallback(async () => {
    setState("loading");
    const [employeesResponse, readinessResponse, absenceExitResponse] =
      await Promise.all([
        insuranceApi
          .GET("/api/v1/employees", {
            params: { query: { limit: 1000, offset: 0 } },
          })
          .catch(() => undefined),
        insuranceApi.GET("/api/v1/hr/readiness-summary").catch(() => undefined),
        insuranceApi
          .GET("/api/v1/hr/absence-exit-dashboard", {
            params: { query: { limit: 50, offset: 0 } },
          })
          .catch(() => undefined),
      ]);

    if (!employeesResponse?.data || !readinessResponse?.data) {
      setState("error");
      return;
    }

    setEmployees(employeesResponse.data.items);
    setReadinessSummary(readinessResponse.data);
    setAbsenceExitDashboard(absenceExitResponse?.data);
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

  const reportExitFromAlert = useCallback(
    async (alert: EmployeeAbsenceAlert) => {
      setActionState("busy");
      setActionMessage(undefined);
      try {
        await insuranceApi.POST("/api/v1/hr/exit-cases", {
          body: {
            employee_id: alert.employee_id,
            branch_id: alert.branch_id ?? undefined,
            absence_alert_id: alert.id,
            effective_exit_date: alert.work_date,
            site_manager_note: copy.exitWorkflow.reportNote(alert.work_date),
          },
        });
        setActionState("idle");
        setActionMessage(copy.exitWorkflow.reportCreated);
        await loadInsurance();
      } catch {
        setActionState("error");
        setActionMessage(copy.exitWorkflow.reportFailed);
      }
    },
    [insuranceApi, loadInsurance],
  );

  const confirmExitCase = useCallback(
    async (exitCase: EmployeeExitCase, hqConfirmation: boolean) => {
      setActionState("busy");
      setActionMessage(undefined);
      try {
        await insuranceApi.POST("/api/v1/hr/exit-cases/{id}/confirm", {
          params: { path: { id: exitCase.id } },
          body: {
            decision: "CONFIRM",
            hq_confirmation: hqConfirmation,
            note: hqConfirmation
              ? copy.exitWorkflow.hqConfirmNote
              : copy.exitWorkflow.hrConfirmNote,
          },
        });
        setActionState("idle");
        setActionMessage(copy.exitWorkflow.confirmDone);
        await loadInsurance();
      } catch {
        setActionState("error");
        setActionMessage(copy.exitWorkflow.confirmFailed);
      }
    },
    [insuranceApi, loadInsurance],
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
            {absenceExitDashboard ? (
              <AbsenceExitWorkflowPanel
                dashboard={absenceExitDashboard}
                busy={actionState === "busy"}
                onReportExit={(alert) => {
                  void reportExitFromAlert(alert);
                }}
                onConfirmExit={(exitCase, hqConfirmation) => {
                  void confirmExitCase(exitCase, hqConfirmation);
                }}
              />
            ) : null}
            {actionMessage ? (
              <p
                role={actionState === "error" ? "alert" : "status"}
                className={[
                  "text-sm font-semibold",
                  actionState === "error" ? "text-red-700" : "text-brand-teal",
                ].join(" ")}
              >
                {actionMessage}
              </p>
            ) : null}
            <InsuranceWorkflowPanel readinessSummary={readinessSummary} />
            <InsuranceRosterPanel rows={rows} />
          </>
        ) : null}
      </div>
    </>
  );
}

function AbsenceExitWorkflowPanel({
  dashboard,
  busy,
  onReportExit,
  onConfirmExit,
}: {
  dashboard: AbsenceExitDashboardResponse;
  busy: boolean;
  onReportExit: (alert: EmployeeAbsenceAlert) => void;
  onConfirmExit: (exitCase: EmployeeExitCase, hqConfirmation: boolean) => void;
}) {
  const summary = [
    {
      label: copy.exitWorkflow.summary.absenceWarnings,
      value: dashboard.summary.open_absence_alerts,
      tone: "warning" as Tone,
    },
    {
      label: copy.exitWorkflow.summary.pendingHr,
      value: dashboard.summary.exit_cases_pending_hr,
      tone: "info" as Tone,
    },
    {
      label: copy.exitWorkflow.summary.sourceNeeded,
      value: dashboard.summary.settlement_needs_source,
      tone: "danger" as Tone,
    },
    {
      label: copy.exitWorkflow.summary.approvalReady,
      value: dashboard.summary.settlement_ready,
      tone: "success" as Tone,
    },
  ];

  return (
    <Card className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">
            {copy.exitWorkflow.title}
          </h2>
          <p className="text-sm text-steel">{copy.exitWorkflow.description}</p>
        </div>
        <Button asChild size="sm" variant="secondary">
          <Link to="/payroll?workflow=exit-settlement">
            <FileSpreadsheet size={16} aria-hidden="true" />
            {copy.exitWorkflow.payrollLink}
          </Link>
        </Button>
      </div>

      <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {summary.map((item) => (
          <div
            key={item.label}
            className="rounded-lg border border-line bg-muted-panel/40 p-3"
          >
            <dt className="text-xs font-semibold text-steel">{item.label}</dt>
            <dd className="mt-1 flex items-center gap-2 text-2xl font-semibold text-ink">
              <Badge className={toneBadgeClass(item.tone)}>
                {formatListCount(item.value)}
              </Badge>
            </dd>
          </div>
        ))}
      </dl>

      <div className="grid gap-3 xl:grid-cols-2">
        <section className="grid gap-3 rounded-lg border border-line bg-white p-4">
          <div className="flex items-center gap-2">
            <AlertTriangle size={18} className="text-amber-700" aria-hidden="true" />
            <h3 className="font-semibold text-ink">
              {copy.exitWorkflow.absenceTitle}
            </h3>
          </div>
          {dashboard.alerts.length === 0 ? (
            <p className="text-sm text-steel">
              {copy.exitWorkflow.absenceEmpty}
            </p>
          ) : (
            <ul className="grid gap-3">
              {dashboard.alerts.slice(0, 5).map((alert) => (
                <li key={alert.id} className="grid gap-2 rounded border border-line p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold text-ink">
                        {alert.employee_name} · {alert.work_date}
                      </p>
                      <p className="text-xs text-steel">
                        {display(alert.company)} / {display(alert.branch_name ?? alert.worksite_name)}
                      </p>
                    </div>
                    <Badge className={toneBadgeClass("warning")}>
                      {alert.severity}
                    </Badge>
                  </div>
                  <p className="text-sm text-steel">{alert.notification_message}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {alert.audience_roles.map((role) => (
                      <Badge key={role} className={toneBadgeClass("info")}>
                        {roleLabel(role)}
                      </Badge>
                    ))}
                  </div>
                  {alert.exit_case_id ? (
                    <Button asChild size="xs" variant="ghost" className="justify-self-start">
                      <Link to={`/payroll?exitCase=${alert.exit_case_id}`}>
                        {copy.exitWorkflow.settlementCase}
                      </Link>
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="xs"
                      variant="secondary"
                      className="justify-self-start"
                      disabled={busy}
                      onClick={() => {
                        onReportExit(alert);
                      }}
                    >
                      <UserX size={14} aria-hidden="true" />
                      {copy.exitWorkflow.createExitCase}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="grid gap-3 rounded-lg border border-line bg-white p-4">
          <div className="flex items-center gap-2">
            <CheckCircle2 size={18} className="text-emerald-700" aria-hidden="true" />
            <h3 className="font-semibold text-ink">
              {copy.exitWorkflow.confirmationTitle}
            </h3>
          </div>
          {dashboard.exit_cases.length === 0 ? (
            <p className="text-sm text-steel">
              {copy.exitWorkflow.confirmationEmpty}
            </p>
          ) : (
            <ul className="grid gap-3">
              {dashboard.exit_cases.slice(0, 5).map((exitCase) => (
                <li
                  key={exitCase.id}
                  className="grid gap-2 rounded border border-line p-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold text-ink">
                        {exitCase.employee_name} · {exitCase.effective_exit_date}
                      </p>
                      <p className="text-xs text-steel">
                        {display(exitCase.company)} / {display(exitCase.branch_name ?? exitCase.worksite_name)}
                      </p>
                    </div>
                    <Badge className={toneBadgeClass(exitCaseTone(exitCase.status))}>
                      {exitStatusLabel(exitCase.status)}
                    </Badge>
                  </div>
                  <p className="text-sm text-steel">{exitCase.site_manager_note}</p>
                  <div className="flex flex-wrap gap-2">
                    {exitCase.status === "REPORTED" ? (
                      <>
                        <Button
                          type="button"
                          size="xs"
                          disabled={busy}
                          onClick={() => {
                            onConfirmExit(exitCase, false);
                          }}
                        >
                          {copy.exitWorkflow.hrConfirm}
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="secondary"
                          disabled={busy}
                          onClick={() => {
                            onConfirmExit(exitCase, true);
                          }}
                        >
                          {copy.exitWorkflow.hqConfirm}
                        </Button>
                      </>
                    ) : null}
                    <Button asChild type="button" size="xs" variant="ghost">
                      <Link to={`/payroll?exitCase=${exitCase.id}`}>
                        {copy.exitWorkflow.settlementMaterial}
                      </Link>
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Card>
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

function roleLabel(role: string): string {
  return exitWorkflowRoleLabel(role, copy.exitWorkflow.roles);
}

function exitStatusLabel(status: EmployeeExitCase["status"]): string {
  return exitCaseStatusLabel(status, copy.exitWorkflow.status);
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

function display(value: string | number | null | undefined): string {
  return text(value);
}
