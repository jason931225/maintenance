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
import type { Tone } from "../lib/semantic";
import { toneBadgeClass } from "../lib/semantic";
import { formatListCount } from "../lib/utils";

type LoadState = "loading" | "idle" | "error";
type ActionState = "idle" | "busy" | "error";

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
  ): Promise<{ data?: EmployeeExitCase }>;
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
  const [absenceExitDashboard, setAbsenceExitDashboard] =
    useState<AbsenceExitDashboardResponse>();
  const [actionState, setActionState] = useState<ActionState>("idle");
  const [actionMessage, setActionMessage] = useState<string>();

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
      !employeesResponse?.data ||
      !absenceExitResponse?.data
    ) {
      setState("error");
      return;
    }

    setReadiness(readinessResponse.data);
    setAttendance(attendanceResponse.data);
    setEmployees(employeesResponse.data.items);
    setEmployeeTotal(employeesResponse.data.total);
    setAbsenceExitDashboard(absenceExitResponse.data);
    setState("idle");
  }, [payrollApi]);

  useEffect(() => {
    void Promise.resolve().then(loadPayroll);
  }, [loadPayroll]);

  const activeEmployees = useMemo(
    () => employees.filter((employee) => employee.status === "ACTIVE").length,
    [employees],
  );

  const submitExitApproval = useCallback(
    async (exitCase: EmployeeExitCase, settlementInput?: ExitSettlementInput) => {
      setActionState("busy");
      setActionMessage(undefined);
      try {
        await payrollApi.POST("/api/v1/hr/exit-cases/{id}/approval-draft", {
          params: { path: { id: exitCase.id } },
          body: {
            submit: true,
            note: "급여·4대보험 담당 검토 후 결제상신",
            settlement_input: settlementInput,
          },
        });
        setActionState("idle");
        setActionMessage("퇴직금 정산 및 4대보험 상실신고 결제상신을 반영했습니다.");
        await loadPayroll();
      } catch {
        setActionState("error");
        setActionMessage(
          "결제상신을 반영하지 못했습니다. 임금 원천과 권한을 확인해 주세요.",
        );
      }
    },
    [loadPayroll, payrollApi],
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
        {state === "idle" && readiness && absenceExitDashboard ? (
          <>
            <PayrollReadinessPanel
              readiness={readiness}
              attendance={attendance}
              activeEmployees={activeEmployees}
              employeeTotal={employeeTotal}
            />
            <ExitSettlementPanel
              dashboard={absenceExitDashboard}
              busy={actionState === "busy"}
              onSubmitApproval={(exitCase, settlementInput) => {
                void submitExitApproval(exitCase, settlementInput);
              }}
            />
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

interface SettlementDraftForm {
  average_wage_period_start: string;
  average_wage_period_end: string;
  average_wage_calendar_days: string;
  average_wage_total_won: string;
}

function ExitSettlementPanel({
  dashboard,
  busy,
  onSubmitApproval,
}: {
  dashboard: AbsenceExitDashboardResponse;
  busy: boolean;
  onSubmitApproval: (
    exitCase: EmployeeExitCase,
    settlementInput?: ExitSettlementInput,
  ) => void;
}) {
  const [forms, setForms] = useState<Record<string, SettlementDraftForm>>({});
  const cases = dashboard.exit_cases;
  const summary = [
    {
      label: "결근 경고",
      value: dashboard.summary.open_absence_alerts,
      tone: "warning" as Tone,
    },
    {
      label: "임금 원천 필요",
      value: dashboard.summary.settlement_needs_source,
      tone: "danger" as Tone,
    },
    {
      label: "상신 준비",
      value: dashboard.summary.settlement_ready,
      tone: "success" as Tone,
    },
    {
      label: "상신 완료",
      value: dashboard.summary.submitted,
      tone: "info" as Tone,
    },
  ];

  function formFor(exitCase: EmployeeExitCase): SettlementDraftForm {
    return forms[exitCase.id] ?? settlementFormFromCase(exitCase);
  }

  function updateForm(
    exitCase: EmployeeExitCase,
    key: keyof SettlementDraftForm,
    value: string,
  ) {
    setForms((prev) => ({
      ...prev,
      [exitCase.id]: {
        ...formFor(exitCase),
        [key]: value,
      },
    }));
  }

  return (
    <Card className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">
            퇴직금·상실신고 정산
          </h2>
          <p className="text-sm text-steel">
            HR 확인된 퇴사 케이스의 평균임금 원천을 반영하고 결제상신까지 연결합니다.
          </p>
        </div>
        <Button asChild size="sm" variant="secondary">
          <Link to="/hr/insurance">상실신고 보조</Link>
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

      {cases.length === 0 ? (
        <p className="rounded-lg border border-line bg-white p-4 text-sm text-steel">
          결근 경고에서 이어진 퇴사 정산 케이스가 없습니다.
        </p>
      ) : (
        <div className="grid gap-3">
          {cases.slice(0, 8).map((exitCase) => {
            const settlementPackage = exitCase.settlement_package;
            const form = formFor(exitCase);
            const settlementInput = settlementInputFromForm(form);
            const packageReady = isSettlementPackageReady(exitCase);
            const canSubmit = packageReady || settlementInput !== undefined;
            const insuranceForms = insuranceFormCount(exitCase);
            return (
              <section
                key={exitCase.id}
                className="grid gap-4 rounded-lg border border-line bg-white p-4"
              >
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
                    {exitCaseStatusLabel(exitCase.status)}
                  </Badge>
                </div>

                <dl className="grid gap-3 text-sm md:grid-cols-4">
                  <div className="rounded border border-line bg-muted-panel/40 p-3">
                    <dt className="font-semibold text-steel">근속일</dt>
                    <dd className="text-ink">
                      {display(settlementPackage?.service_days)}
                    </dd>
                  </div>
                  <div className="rounded border border-line bg-muted-panel/40 p-3">
                    <dt className="font-semibold text-steel">평균임금</dt>
                    <dd className="text-ink">
                      {formatAverageDailyWage(
                        settlementPackage?.average_daily_wage_milliwon,
                      )}
                    </dd>
                  </div>
                  <div className="rounded border border-line bg-muted-panel/40 p-3">
                    <dt className="font-semibold text-steel">퇴직금 산출액</dt>
                    <dd className="text-ink">
                      {formatWon(settlementPackage?.severance_pay_won)}
                    </dd>
                  </div>
                  <div className="rounded border border-line bg-muted-panel/40 p-3">
                    <dt className="font-semibold text-steel">상실신고 서식</dt>
                    <dd className="text-ink">
                      {insuranceForms > 0 ? `${insuranceForms}종` : "-"}
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

                {!packageReady ? (
                  <div className="grid gap-3 rounded border border-line p-3 md:grid-cols-4">
                    <label className="grid gap-1 text-sm font-medium text-steel">
                      평균임금 시작일
                      <Input
                        type="date"
                        value={form.average_wage_period_start}
                        onChange={(event) =>
                          updateForm(
                            exitCase,
                            "average_wage_period_start",
                            event.currentTarget.value,
                          )
                        }
                      />
                    </label>
                    <label className="grid gap-1 text-sm font-medium text-steel">
                      평균임금 종료일
                      <Input
                        type="date"
                        value={form.average_wage_period_end}
                        onChange={(event) =>
                          updateForm(
                            exitCase,
                            "average_wage_period_end",
                            event.currentTarget.value,
                          )
                        }
                      />
                    </label>
                    <label className="grid gap-1 text-sm font-medium text-steel">
                      산정 일수
                      <Input
                        inputMode="numeric"
                        value={form.average_wage_calendar_days}
                        onChange={(event) =>
                          updateForm(
                            exitCase,
                            "average_wage_calendar_days",
                            event.currentTarget.value,
                          )
                        }
                      />
                    </label>
                    <label className="grid gap-1 text-sm font-medium text-steel">
                      3개월 임금 합계
                      <Input
                        inputMode="numeric"
                        value={form.average_wage_total_won}
                        onChange={(event) =>
                          updateForm(
                            exitCase,
                            "average_wage_total_won",
                            event.currentTarget.value,
                          )
                        }
                      />
                    </label>
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    disabled={busy || !canSubmit}
                    onClick={() =>
                      onSubmitApproval(
                        exitCase,
                        packageReady ? undefined : settlementInput,
                      )
                    }
                  >
                    결제상신
                  </Button>
                  <Button asChild type="button" size="sm" variant="ghost">
                    <Link to={`/approvals?source=employee-exit&focus=${exitCase.id}`}>
                      전자결제 추적
                    </Link>
                  </Button>
                  {!canSubmit ? (
                    <span className="text-xs font-semibold text-amber-800">
                      평균임금 원천 4개 항목을 입력해야 상신할 수 있습니다.
                    </span>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      )}
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

function settlementFormFromCase(exitCase: EmployeeExitCase): SettlementDraftForm {
  const settlementPackage = exitCase.settlement_package;
  return {
    average_wage_period_start:
      settlementPackage?.average_wage_period_start ?? "",
    average_wage_period_end: settlementPackage?.average_wage_period_end ?? "",
    average_wage_calendar_days:
      settlementPackage?.average_wage_calendar_days?.toString() ?? "",
    average_wage_total_won:
      settlementPackage?.average_wage_total_won?.toString() ?? "",
  };
}

function settlementInputFromForm(
  form: SettlementDraftForm,
): ExitSettlementInput | undefined {
  const days = positiveInteger(form.average_wage_calendar_days);
  const totalWon = positiveInteger(form.average_wage_total_won);
  if (
    !form.average_wage_period_start ||
    !form.average_wage_period_end ||
    days === undefined ||
    totalWon === undefined
  ) {
    return undefined;
  }
  return {
    average_wage_period_start: form.average_wage_period_start,
    average_wage_period_end: form.average_wage_period_end,
    average_wage_calendar_days: days,
    average_wage_total_won: totalWon,
  };
}

function positiveInteger(value: string): number | undefined {
  const normalized = value.replaceAll(",", "").trim();
  if (!/^[1-9]\d*$/.test(normalized)) return undefined;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function isSettlementPackageReady(exitCase: EmployeeExitCase): boolean {
  const settlementPackage = exitCase.settlement_package;
  return Boolean(
    settlementPackage?.severance_pay_won &&
      settlementPackage.missing_source_fields.length === 0,
  );
}

function insuranceFormCount(exitCase: EmployeeExitCase): number {
  const forms = exitCase.settlement_package?.insurance_loss_payload.forms;
  return Array.isArray(forms) ? forms.length : 0;
}

function exitCaseStatusLabel(status: string): string {
  switch (status) {
    case "REPORTED":
      return "HR 확인 대기";
    case "HR_CONFIRMED":
      return "사업장 HR 확인";
    case "HQ_CONFIRMED":
      return "HQ HR 확인";
    case "SETTLEMENT_READY":
      return "정산 준비";
    case "APPROVAL_DRAFTED":
      return "결제 초안";
    case "SUBMITTED":
      return "결제 상신";
    case "REJECTED":
      return "반려";
    default:
      return status;
  }
}

function exitCaseTone(status: string): Tone {
  switch (status) {
    case "REPORTED":
      return "warning";
    case "HR_CONFIRMED":
    case "HQ_CONFIRMED":
    case "SETTLEMENT_READY":
      return "success";
    case "APPROVAL_DRAFTED":
    case "SUBMITTED":
      return "info";
    case "REJECTED":
      return "danger";
    default:
      return "neutral";
  }
}

function formatWon(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  return `${new Intl.NumberFormat("ko-KR").format(value)}원`;
}

function formatAverageDailyWage(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  return `${new Intl.NumberFormat("ko-KR", {
    maximumFractionDigits: 3,
  }).format(value / 1000)}원`;
}

function display(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}
