import { CalendarCheck, FileText, Mail, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import type { ConsoleApiClient } from "../api/client";
import type {
  EmployeeDirectoryItem,
  EmployeeDirectoryPage,
  HrReadinessSummary,
  LeaveBalancePage,
} from "../api/types";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import { PageError } from "../components/states/PageError";
import { SkeletonTable } from "../components/states/Skeleton";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { useAuth } from "../context/auth";
import { leaveManagementKo as copy } from "../i18n/hrWorkflows";
import type { Tone } from "../lib/semantic";
import { toneBadgeClass } from "../lib/semantic";
import { formatListCount } from "../lib/utils";

type LoadState = "loading" | "idle" | "error";
type LeaveBalanceItem = LeaveBalancePage["items"][number];

type LeaveManagementApi = ConsoleApiClient & {
  GET(
    path: "/api/v1/employees",
    options?: {
      params?: {
        query?: { limit?: number; offset?: number; company?: string };
      };
    },
  ): Promise<{ data?: EmployeeDirectoryPage }>;
  GET(
    path: "/api/v1/hr/leave-balances",
    options?: { params?: { query?: { limit?: number; offset?: number } } },
  ): Promise<{ data?: LeaveBalancePage }>;
  GET(path: "/api/v1/hr/readiness-summary"): Promise<{
    data?: HrReadinessSummary;
  }>;
};

interface LeaveRow {
  leave: LeaveBalanceItem;
  employee?: EmployeeDirectoryItem;
}

export function LeaveManagementPage() {
  const { api } = useAuth();
  const leaveApi = api as LeaveManagementApi;
  const [state, setState] = useState<LoadState>("loading");
  const [employees, setEmployees] = useState<EmployeeDirectoryItem[]>([]);
  const [leaveBalances, setLeaveBalances] = useState<LeaveBalancePage>();
  const [readinessSummary, setReadinessSummary] =
    useState<HrReadinessSummary>();

  const loadLeaveManagement = useCallback(async () => {
    setState("loading");
    const [employeesResponse, leaveResponse, readinessResponse] =
      await Promise.all([
        leaveApi
          .GET("/api/v1/employees", {
            params: { query: { limit: 1000, offset: 0 } },
          })
          .catch(() => undefined),
        leaveApi
          .GET("/api/v1/hr/leave-balances", {
            params: { query: { limit: 1000, offset: 0 } },
          })
          .catch(() => undefined),
        leaveApi.GET("/api/v1/hr/readiness-summary").catch(() => undefined),
      ]);

    if (
      !employeesResponse?.data ||
      !leaveResponse?.data ||
      !readinessResponse?.data
    ) {
      setState("error");
      return;
    }

    setEmployees(employeesResponse.data.items);
    setLeaveBalances(leaveResponse.data);
    setReadinessSummary(readinessResponse.data);
    setState("idle");
  }, [leaveApi]);

  useEffect(() => {
    void Promise.resolve().then(loadLeaveManagement);
  }, [loadLeaveManagement]);

  const employeeById = useMemo(
    () => new Map(employees.map((employee) => [employee.id, employee])),
    [employees],
  );
  const leaveRows = useMemo(
    () =>
      (leaveBalances?.items ?? []).map((leave) => ({
        leave,
        employee: employeeById.get(leave.id),
      })),
    [employeeById, leaveBalances],
  );
  const activeEmployees = useMemo(
    () => employees.filter(isActiveEmployee).length,
    [employees],
  );
  const planRequiredRows = useMemo(
    () =>
      leaveRows.filter(
        (row) =>
          isActiveEmployee(row.employee) &&
          parseDays(row.leave.leave_remaining) > 0,
      ),
    [leaveRows],
  );

  return (
    <>
      <PageHeader
        title={copy.title}
        description={copy.description}
        actions={
          <RefreshButton
            onClick={() => {
              void loadLeaveManagement();
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
              void loadLeaveManagement();
            }}
          />
        ) : null}
        {state === "idle" && leaveBalances && readinessSummary ? (
          <>
            <LeaveOverviewPanel
              leaveBalances={leaveBalances}
              readinessSummary={readinessSummary}
              activeEmployees={activeEmployees}
              planRequiredCount={planRequiredRows.length}
            />
            <LeaveLifecyclePanel readinessSummary={readinessSummary} />
            <LeaveEmployeePanel rows={leaveRows} />
            <LeaveNoticePanel
              planRequiredRows={planRequiredRows}
              readinessSummary={readinessSummary}
            />
          </>
        ) : null}
      </div>
    </>
  );
}

function LeaveOverviewPanel({
  leaveBalances,
  readinessSummary,
  activeEmployees,
  planRequiredCount,
}: {
  leaveBalances: LeaveBalancePage;
  readinessSummary: HrReadinessSummary;
  activeEmployees: number;
  planRequiredCount: number;
}) {
  const cards = [
    {
      label: copy.overview.activeEmployees,
      value: formatListCount(activeEmployees),
      meta: copy.overview.activeMeta(formatListCount(leaveBalances.total)),
    },
    {
      label: copy.overview.accrued,
      value: dayLabel(leaveBalances.summary.accrued),
      meta: copy.overview.accruedMeta,
    },
    {
      label: copy.overview.used,
      value: dayLabel(leaveBalances.summary.used),
      meta: copy.overview.usedMeta,
    },
    {
      label: copy.overview.remaining,
      value: dayLabel(leaveBalances.summary.remaining),
      meta: copy.overview.remainingMeta(formatListCount(planRequiredCount)),
    },
    {
      label: copy.overview.promotion,
      value: formatListCount(
        readinessSummary.annual_leave.usage_promotion_required,
      ),
      meta: copy.overview.promotionMeta(
        formatListCount(readinessSummary.annual_leave.needs_review),
      ),
    },
    {
      label: copy.overview.payrollReview,
      value: formatListCount(
        readinessSummary.annual_leave.payout_review_required,
      ),
      meta: copy.overview.payrollReviewMeta(
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

function LeaveLifecyclePanel({
  readinessSummary,
}: {
  readinessSummary: HrReadinessSummary;
}) {
  const steps = [
    {
      content: copy.lifecycle.accrual,
      Icon: CalendarCheck,
      tone: "info",
    },
    {
      content: copy.lifecycle.approval,
      Icon: FileText,
      tone: "success",
    },
    {
      content: {
        title: copy.lifecycle.promotion.title,
        detail: copy.lifecycle.promotion.detail(
          formatListCount(
            readinessSummary.annual_leave.usage_promotion_required,
          ),
        ),
      },
      Icon: Mail,
      tone: "warning",
    },
    {
      content: {
        title: copy.lifecycle.payroll.title,
        detail: copy.lifecycle.payroll.detail(
          formatListCount(readinessSummary.attendance.durable_events),
          formatListCount(readinessSummary.payroll.payroll_source_rows),
        ),
      },
      Icon: ShieldCheck,
      tone: "accent",
    },
  ] as const;

  return (
    <Card className="grid gap-4">
      <div>
        <h2 className="text-lg font-semibold text-ink">
          {copy.lifecycle.title}
        </h2>
        <p className="text-sm text-steel">{copy.lifecycle.description}</p>
      </div>
      <div className="grid gap-3 lg:grid-cols-4">
        {steps.map(({ content, Icon, tone }) => (
          <div
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
          </div>
        ))}
      </div>
    </Card>
  );
}

function LeaveEmployeePanel({ rows }: { rows: LeaveRow[] }) {
  const visibleRows = rows.slice(0, 80);

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
              <th className="px-3 py-2">{copy.roster.columns.department}</th>
              <th className="px-3 py-2">{copy.roster.columns.tenure}</th>
              <th className="px-3 py-2">{copy.roster.columns.accrued}</th>
              <th className="px-3 py-2">{copy.roster.columns.used}</th>
              <th className="px-3 py-2">{copy.roster.columns.remaining}</th>
              <th className="px-3 py-2">{copy.roster.columns.status}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {visibleRows.map((row) => {
              const status = leaveRowStatus(row);
              return (
                <tr key={row.leave.id} className="align-top">
                  <td className="px-3 py-3">
                    <p className="font-semibold text-ink">{text(row.leave.name)}</p>
                    <p className="text-xs text-steel">
                      {text(row.leave.company)} / {text(row.leave.employee_number)}
                    </p>
                  </td>
                  <td className="px-3 py-3 text-steel">
                    {text(row.leave.org_unit)} / {text(row.leave.position)}
                  </td>
                  <td className="px-3 py-3 text-steel">
                    <p>{tenureStage(row.employee?.hire_date)}</p>
                    <p className="text-xs">{text(row.employee?.hire_date)}</p>
                  </td>
                  <td className="px-3 py-3 font-medium text-ink">
                    {dayLabel(row.leave.leave_accrued)}
                  </td>
                  <td className="px-3 py-3 font-medium text-ink">
                    {dayLabel(row.leave.leave_used)}
                  </td>
                  <td className="px-3 py-3 font-medium text-ink">
                    {dayLabel(row.leave.leave_remaining)}
                  </td>
                  <td className="px-3 py-3">
                    <Badge className={toneBadgeClass(status.tone)}>
                      {status.label}
                    </Badge>
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

function LeaveNoticePanel({
  planRequiredRows,
  readinessSummary,
}: {
  planRequiredRows: LeaveRow[];
  readinessSummary: HrReadinessSummary;
}) {
  const topRows = planRequiredRows.slice(0, 8);

  return (
    <Card className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">
            {copy.notice.title}
          </h2>
          <p className="text-sm text-steel">{copy.notice.description}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="secondary">
            <Link to="/mail?compose=leave-plan">
              <Mail size={16} aria-hidden="true" />
              {copy.notice.mailAction}
            </Link>
          </Button>
          <Button asChild size="sm">
            <Link to="/approvals?template=annual-leave">
              <FileText size={16} aria-hidden="true" />
              {copy.notice.leaveRequestAction}
            </Link>
          </Button>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="grid gap-2">
          {topRows.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line p-4 text-sm text-steel">
              {copy.notice.empty}
            </p>
          ) : (
            topRows.map((row) => (
              <div
                key={row.leave.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-white p-3"
              >
                <div>
                  <p className="font-semibold text-ink">{text(row.leave.name)}</p>
                  <p className="text-sm text-steel">
                    {copy.notice.rowMeta(
                      dayLabel(row.leave.leave_remaining),
                      tenureStage(row.employee?.hire_date),
                    )}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge className={toneBadgeClass("warning")}>
                    {copy.notice.requestBadge}
                  </Badge>
                  <Button asChild size="xs" variant="ghost">
                    <Link to={`/mail?compose=leave-plan&employee=${row.leave.id}`}>
                      {copy.notice.notifyAction}
                    </Link>
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
        <div className="grid gap-3 rounded-lg border border-line bg-muted-panel/40 p-4">
          <SummaryLine
            label={copy.notice.summary.promotion}
            value={formatListCount(
              readinessSummary.annual_leave.usage_promotion_required,
            )}
          />
          <SummaryLine
            label={copy.notice.summary.planRequired}
            value={formatListCount(planRequiredRows.length)}
          />
          <SummaryLine
            label={copy.notice.summary.payoutReview}
            value={formatListCount(
              readinessSummary.annual_leave.payout_review_required,
            )}
          />
          <Button asChild variant="secondary" size="sm">
            <Link to="/payroll">
              <RefreshCw size={16} aria-hidden="true" />
              {copy.notice.payrollAction}
            </Link>
          </Button>
        </div>
      </div>
    </Card>
  );
}

function SummaryLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-steel">{label}</span>
      <span className="font-semibold text-ink">{value}</span>
    </div>
  );
}

function leaveRowStatus(row: LeaveRow): { label: string; tone: Tone } {
  const remaining = parseDays(row.leave.leave_remaining);
  if (!row.employee?.hire_date) {
    return { label: copy.status.hireDateMissing, tone: "warning" };
  }
  if (!isActiveEmployee(row.employee)) {
    return { label: copy.status.exited, tone: "neutral" };
  }
  if (remaining <= 0) {
    return { label: copy.status.exhausted, tone: "success" };
  }
  return { label: copy.status.promotion, tone: "warning" };
}

function tenureStage(hireDate: string | null | undefined): string {
  const years = tenureYears(hireDate);
  if (years === undefined) return copy.tenure.missing;
  if (years < 1) return copy.tenure.underOneYear;
  const yearLabel = String(Math.floor(years) + 1);
  if (years < 3) return copy.tenure.baseYear(yearLabel);
  return copy.tenure.additionalYear(yearLabel);
}

function tenureYears(hireDate: string | null | undefined): number | undefined {
  if (!hireDate) return undefined;
  const start = Date.parse(hireDate);
  if (!Number.isFinite(start)) return undefined;
  const elapsed = Date.now() - start;
  if (elapsed < 0) return 0;
  return elapsed / (365.2425 * 24 * 60 * 60 * 1000);
}

function isActiveEmployee(employee: EmployeeDirectoryItem | undefined): boolean {
  if (!employee) return false;
  return employee.status !== "EXITED" && employee.status !== "TERMINATED";
}

function dayLabel(value: string | number | null | undefined): string {
  return copy.units.days(
    new Intl.NumberFormat("ko-KR", {
      maximumFractionDigits: 1,
    }).format(parseDays(value)),
  );
}

function parseDays(value: string | number | null | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number.parseFloat((value ?? "0").replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}
