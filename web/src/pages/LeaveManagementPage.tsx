import { useCallback, useEffect, useMemo, useState } from "react";

import type { ConsoleApiClient } from "../api/client";
import type {
  EmployeeDirectoryItem,
  EmployeeDirectoryPage,
  LeaveBalancePage,
} from "../api/types";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import { PageError } from "../components/states/PageError";
import { SkeletonTable } from "../components/states/Skeleton";
import { LeaveConsole, LEAVE_RUNTIME_GATE, type LeaveLedgerRow } from "../console/leave";
import { PolicyGateProvider } from "../console/policy";
import { useAuth } from "../context/auth";
import { leaveManagementKo as copy } from "../i18n/hrWorkflows";

type LoadState = "loading" | "idle" | "error";

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
};

export function LeaveManagementPage() {
  const { api } = useAuth();
  const leaveApi = api as LeaveManagementApi;
  const [state, setState] = useState<LoadState>("loading");
  const [employees, setEmployees] = useState<EmployeeDirectoryItem[]>([]);
  const [leaveBalances, setLeaveBalances] = useState<LeaveBalancePage>();
  const [loadCount, setLoadCount] = useState(0);

  const loadLeaveManagement = useCallback(async () => {
    setState("loading");
    const [employeesResponse, leaveResponse] = await Promise.all([
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
    ]);

    if (!employeesResponse?.data || !leaveResponse?.data) {
      setState("error");
      return;
    }

    setEmployees(employeesResponse.data.items);
    setLeaveBalances(leaveResponse.data);
    // Re-key the console so its interactive state reseeds from the fresh ledger.
    setLoadCount((count) => count + 1);
    setState("idle");
  }, [leaveApi]);

  useEffect(() => {
    void Promise.resolve().then(loadLeaveManagement);
  }, [loadLeaveManagement]);

  const employeeById = useMemo(
    () => new Map(employees.map((employee) => [employee.id, employee])),
    [employees],
  );

  const ledger: LeaveLedgerRow[] = useMemo(
    () =>
      (leaveBalances?.items ?? []).map((leave, index) => {
        const employee = employeeById.get(leave.id);
        return {
          id: leave.id,
          code: `JL-${codeSuffix(leave.employee_number, index)}`,
          name: text(leave.name),
          company: text(leave.company),
          employeeNumber: text(leave.employee_number),
          orgUnit: text(leave.org_unit),
          position: text(leave.position),
          hireDate: employee?.hire_date ?? undefined,
          accrued: parseDays(leave.leave_accrued),
          used: parseDays(leave.leave_used),
          remaining: parseDays(leave.leave_remaining),
          active: isActiveEmployee(employee),
        };
      }),
    [employeeById, leaveBalances],
  );

  return (
    <>
      <PageHeader
        title={copy.title}
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
        {state === "idle" ? (
          <PolicyGateProvider gate={LEAVE_RUNTIME_GATE}>
            <LeaveConsole key={loadCount} ledger={ledger} />
          </PolicyGateProvider>
        ) : null}
      </div>
    </>
  );
}

/** JL- object-code suffix from the employee number (drag-grammar safe: alnum only). */
function codeSuffix(employeeNumber: string | null | undefined, index: number): string {
  const cleaned = (employeeNumber ?? "").replaceAll(/[^A-Za-z0-9]/gu, "");
  return cleaned === "" ? String(101 + index) : cleaned;
}

function isActiveEmployee(employee: EmployeeDirectoryItem | undefined): boolean {
  if (!employee) return false;
  return employee.status !== "EXITED" && employee.status !== "TERMINATED";
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
