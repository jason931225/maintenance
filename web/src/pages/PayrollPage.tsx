import { Link } from "react-router-dom";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { ConsoleApiClient } from "../api/client";
import type {
  AbsenceExitDashboardResponse,
  AttendanceSummaryPage,
  DraftEmployeeExitApprovalRequest,
  EmployeeDirectoryItem,
  EmployeeDirectoryPage,
  EmployeeExitCase,
  ExitSettlementInput,
  HrReadinessSummary,
} from "../api/types";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import { isNavItemVisible } from "../components/shell/nav";
import { PageError } from "../components/states/PageError";
import { SkeletonTable } from "../components/states/Skeleton";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { useAuth } from "../context/auth";
import { ko } from "../i18n/ko";
import { exitCaseStatusLabel, exitCaseTone } from "../lib/hrExitWorkflow";
import type { Tone } from "../lib/semantic";
import { toneBadgeClass } from "../lib/semantic";
import { formatListCount } from "../lib/utils";

type LoadState = "loading" | "idle" | "error";

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
  GET(
    path: "/api/v1/hr/absence-exit-dashboard",
    options?: { params?: { query?: { limit?: number; offset?: number } } },
  ): Promise<{ data?: AbsenceExitDashboardResponse }>;
  POST(
    path: "/api/v1/hr/exit-cases/{id}/approval-draft",
    options: {
      params: { path: { id: string } };
      body: DraftEmployeeExitApprovalRequest;
    },
  ): Promise<{ data?: EmployeeExitCase; error?: unknown }>;
};

type SettlementActionState = "idle" | "busy" | "error";

const copy = ko.payroll;

export function PayrollPage() {
  const { api, session } = useAuth();
  const payrollApi = api as PayrollApi;
  const [state, setState] = useState<LoadState>("loading");
  const [readiness, setReadiness] = useState<HrReadinessSummary>();
  const [attendance, setAttendance] = useState<AttendanceSummaryPage>();
  const [employees, setEmployees] = useState<EmployeeDirectoryItem[]>([]);
  const [employeeTotal, setEmployeeTotal] = useState(0);
  const [absenceExitDashboard, setAbsenceExitDashboard] =
    useState<AbsenceExitDashboardResponse>();
  const [settlementAction, setSettlementAction] =
    useState<SettlementActionState>("idle");
  const [settlementMessage, setSettlementMessage] = useState<string>();

  const loadPayroll = useCallback(async () => {
    setState("loading");
    const [
      readinessResponse,
      attendanceResponse,
      employeesResponse,
      absenceExitResponse,
    ] =
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
        payrollApi
          .GET("/api/v1/hr/absence-exit-dashboard", {
            params: { query: { limit: 50, offset: 0 } },
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
    setAbsenceExitDashboard(absenceExitResponse?.data);
    setState("idle");
  }, [payrollApi]);

  useEffect(() => {
    void Promise.resolve().then(loadPayroll);
  }, [loadPayroll]);

  const draftSettlement = useCallback(
    async (caseId: string, input: ExitSettlementInput) => {
      setSettlementAction("busy");
      setSettlementMessage(undefined);
      try {
        const { error } = await payrollApi.POST(
          "/api/v1/hr/exit-cases/{id}/approval-draft",
          {
            params: { path: { id: caseId } },
            body: { submit: false, settlement_input: input },
          },
        );
        if (error) {
          setSettlementAction("error");
          setSettlementMessage(copy.exitSettlement.wageSource.draftFailed);
          return;
        }
        setSettlementAction("idle");
        setSettlementMessage(copy.exitSettlement.wageSource.draftCreated);
        await loadPayroll();
      } catch {
        setSettlementAction("error");
        setSettlementMessage(copy.exitSettlement.wageSource.draftFailed);
      }
    },
    [payrollApi, loadPayroll],
  );

  const submitSettlement = useCallback(
    async (caseId: string) => {
      setSettlementAction("busy");
      setSettlementMessage(undefined);
      try {
        const { error } = await payrollApi.POST(
          "/api/v1/hr/exit-cases/{id}/approval-draft",
          {
            params: { path: { id: caseId } },
            body: { submit: true },
          },
        );
        if (error) {
          setSettlementAction("error");
          setSettlementMessage(copy.exitSettlement.wageSource.submitFailed);
          return;
        }
        setSettlementAction("idle");
        setSettlementMessage(copy.exitSettlement.wageSource.submitDone);
        await loadPayroll();
      } catch {
        setSettlementAction("error");
        setSettlementMessage(copy.exitSettlement.wageSource.submitFailed);
      }
    },
    [payrollApi, loadPayroll],
  );

  const activeEmployees = useMemo(
    () => employees.filter((employee) => employee.status === "ACTIVE").length,
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
            {absenceExitDashboard ? (
              <ExitSettlementPanel
                dashboard={absenceExitDashboard}
                actionState={settlementAction}
                actionMessage={settlementMessage}
                onDraft={(caseId, input) => {
                  void draftSettlement(caseId, input);
                }}
                onSubmit={(caseId) => {
                  void submitSettlement(caseId);
                }}
              />
            ) : null}
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

function ExitSettlementPanel({
  dashboard,
  actionState,
  actionMessage,
  onDraft,
  onSubmit,
}: {
  dashboard: AbsenceExitDashboardResponse;
  actionState: SettlementActionState;
  actionMessage?: string;
  onDraft: (caseId: string, input: ExitSettlementInput) => void;
  onSubmit: (caseId: string) => void;
}) {
  const cases = dashboard.exit_cases;
  const busy = actionState === "busy";
  const summary = [
    {
      label: copy.exitSettlement.summary.absenceWarnings,
      value: dashboard.summary.open_absence_alerts,
      tone: "warning" as Tone,
    },
    {
      label: copy.exitSettlement.summary.sourceNeeded,
      value: dashboard.summary.settlement_needs_source,
      tone: "danger" as Tone,
    },
    {
      label: copy.exitSettlement.summary.ready,
      value: dashboard.summary.settlement_ready,
      tone: "success" as Tone,
    },
    {
      label: copy.exitSettlement.summary.submitted,
      value: dashboard.summary.submitted,
      tone: "info" as Tone,
    },
  ];

  return (
    <Card className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">
            {copy.exitSettlement.title}
          </h2>
          <p className="text-sm text-steel">{copy.exitSettlement.description}</p>
        </div>
        <Button asChild size="sm" variant="secondary">
          <Link to="/hr/insurance">{copy.exitSettlement.insuranceLink}</Link>
        </Button>
      </div>

      <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {summary.map((item) => (
          <div
            key={item.label}
            className="rounded-lg border border-line bg-muted-panel/40 p-3"
          >
            <dt className="text-xs font-semibold text-steel">{item.label}</dt>
            <dd className="mt-1">
              <Badge className={toneBadgeClass(item.tone)}>
                {formatListCount(item.value)}
              </Badge>
            </dd>
          </div>
        ))}
      </dl>

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

      {cases.length === 0 ? (
        <p className="rounded-lg border border-line bg-white p-4 text-sm text-steel">
          {copy.exitSettlement.empty}
        </p>
      ) : (
        <div className="grid gap-3">
          {cases.slice(0, 8).map((exitCase) => (
            <ExitSettlementCaseCard
              key={exitCase.id}
              exitCase={exitCase}
              busy={busy}
              onDraft={onDraft}
              onSubmit={onSubmit}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

/** Statuses at which the exit settlement (wage source + approval) can be worked. */
const SETTLEMENT_WORKABLE_STATUSES = new Set([
  "HR_CONFIRMED",
  "HQ_CONFIRMED",
  "SETTLEMENT_READY",
  "APPROVAL_DRAFTED",
]);

function ExitSettlementCaseCard({
  exitCase,
  busy,
  onDraft,
  onSubmit,
}: {
  exitCase: EmployeeExitCase;
  busy: boolean;
  onDraft: (caseId: string, input: ExitSettlementInput) => void;
  onSubmit: (caseId: string) => void;
}) {
  const settlementPackage = exitCase.settlement_package;
  const insuranceForms = insuranceFormCount(exitCase);
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [calendarDays, setCalendarDays] = useState("");
  const [totalWon, setTotalWon] = useState("");
  const [ordinaryWage, setOrdinaryWage] = useState("");

  const workable = SETTLEMENT_WORKABLE_STATUSES.has(exitCase.status);
  const packageReady =
    settlementPackage?.severance_pay_won != null &&
    settlementPackage.missing_source_fields.length === 0;
  const submitted = exitCase.status === "SUBMITTED";
  const wageCopy = copy.exitSettlement.wageSource;

  const handleDraft = () => {
    onDraft(exitCase.id, {
      average_wage_period_start: periodStart,
      average_wage_period_end: periodEnd,
      average_wage_calendar_days: Number(calendarDays),
      average_wage_total_won: Number(totalWon),
      monthly_ordinary_wage_won: Number(ordinaryWage),
    });
  };

  const draftReady =
    periodStart !== "" &&
    periodEnd !== "" &&
    calendarDays !== "" &&
    totalWon !== "" &&
    ordinaryWage !== "";

  return (
    <section className="grid gap-4 rounded-lg border border-line bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-ink">
            {exitCase.employee_name} · {exitCase.effective_exit_date}
          </h3>
          <p className="text-xs text-steel">
            {display(exitCase.company)} /{" "}
            {display(exitCase.branch_name ?? exitCase.worksite_name)}
          </p>
        </div>
        <Badge className={toneBadgeClass(exitCaseTone(exitCase.status))}>
          {exitCaseStatusLabel(exitCase.status, copy.exitSettlement.status)}
        </Badge>
      </div>

      <dl className="grid gap-3 text-sm md:grid-cols-4">
        <div className="rounded border border-line bg-muted-panel/40 p-3">
          <dt className="font-semibold text-steel">
            {copy.exitSettlement.fields.serviceDays}
          </dt>
          <dd className="text-ink">{display(settlementPackage?.service_days)}</dd>
        </div>
        <div className="rounded border border-line bg-muted-panel/40 p-3">
          <dt className="font-semibold text-steel">
            {copy.exitSettlement.fields.averageWage}
          </dt>
          <dd className="text-ink">
            {formatAverageDailyWage(
              settlementPackage?.average_daily_wage_milliwon,
            )}
          </dd>
          {settlementPackage?.ordinary_daily_wage_won != null ? (
            <dd className="mt-1 text-xs text-steel">
              {copy.exitSettlement.fields.ordinaryDailyWage}:{" "}
              {formatWon(settlementPackage.ordinary_daily_wage_won)}
            </dd>
          ) : null}
        </div>
        <div className="rounded border border-line bg-muted-panel/40 p-3">
          <dt className="font-semibold text-steel">
            {copy.exitSettlement.fields.severancePay}
          </dt>
          <dd className="text-ink">
            {formatWon(settlementPackage?.severance_pay_won)}
          </dd>
          {settlementPackage?.certification_status === "UNCERTIFIED_DRAFT" ? (
            <dd className="mt-1">
              <Badge className={toneBadgeClass("warning")}>
                {copy.exitSettlement.fields.uncertifiedDraftLabel}
              </Badge>
            </dd>
          ) : null}
        </div>
        <div className="rounded border border-line bg-muted-panel/40 p-3">
          <dt className="font-semibold text-steel">
            {copy.exitSettlement.fields.insuranceForms}
          </dt>
          <dd className="text-ink">
            {insuranceForms > 0
              ? copy.exitSettlement.formCount(insuranceForms)
              : "-"}
          </dd>
        </div>
      </dl>

      {settlementPackage?.missing_source_fields.length ? (
        <div className="flex flex-wrap gap-1.5">
          {settlementPackage.missing_source_fields.map((field) => (
            <Badge key={field} className={toneBadgeClass("warning")}>
              {field}
            </Badge>
          ))}
        </div>
      ) : null}

      {submitted ? null : workable ? (
        <form
          className="grid gap-3 rounded-lg border border-line bg-muted-panel/30 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            handleDraft();
          }}
        >
          <div>
            <h4 className="font-semibold text-ink">{wageCopy.title}</h4>
            <p className="text-xs text-steel">{wageCopy.description}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <label className="grid gap-1 text-sm font-medium text-steel">
              {wageCopy.periodStart}
              <Input
                type="date"
                value={periodStart}
                onChange={(event) => {
                  setPeriodStart(event.currentTarget.value);
                }}
              />
            </label>
            <label className="grid gap-1 text-sm font-medium text-steel">
              {wageCopy.periodEnd}
              <Input
                type="date"
                value={periodEnd}
                onChange={(event) => {
                  setPeriodEnd(event.currentTarget.value);
                }}
              />
            </label>
            <label className="grid gap-1 text-sm font-medium text-steel">
              {wageCopy.calendarDays}
              <Input
                type="number"
                min={1}
                inputMode="numeric"
                value={calendarDays}
                onChange={(event) => {
                  setCalendarDays(event.currentTarget.value);
                }}
              />
            </label>
            <label className="grid gap-1 text-sm font-medium text-steel">
              {wageCopy.totalWon}
              <Input
                type="number"
                min={0}
                inputMode="numeric"
                value={totalWon}
                onChange={(event) => {
                  setTotalWon(event.currentTarget.value);
                }}
              />
            </label>
            <label className="grid gap-1 text-sm font-medium text-steel">
              {wageCopy.monthlyOrdinaryWage}
              <Input
                type="number"
                min={0}
                inputMode="numeric"
                value={ordinaryWage}
                onChange={(event) => {
                  setOrdinaryWage(event.currentTarget.value);
                }}
              />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={busy || !draftReady}>
              {busy ? wageCopy.generating : wageCopy.generateDraft}
            </Button>
            {packageReady ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  onSubmit(exitCase.id);
                }}
              >
                {busy ? wageCopy.submitting : wageCopy.submit}
              </Button>
            ) : null}
          </div>
        </form>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button asChild type="button" size="sm" variant="secondary">
          <Link to={`/hr/insurance?exitCase=${exitCase.id}`}>
            {copy.exitSettlement.handleInInsurance}
          </Link>
        </Button>
        <Button asChild type="button" size="sm" variant="ghost">
          <Link to={`/approvals?source=employee-exit&focus=${exitCase.id}`}>
            {copy.exitSettlement.trackApproval}
          </Link>
        </Button>
      </div>
    </section>
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

function insuranceFormCount(exitCase: EmployeeExitCase): number {
  const forms = exitCase.settlement_package?.insurance_loss_payload.forms;
  return Array.isArray(forms) ? forms.length : 0;
}

function formatWon(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  return copy.exitSettlement.won(new Intl.NumberFormat("ko-KR").format(value));
}

function formatAverageDailyWage(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  return copy.exitSettlement.won(
    new Intl.NumberFormat("ko-KR", {
      maximumFractionDigits: 3,
    }).format(value / 1000),
  );
}

function display(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}
