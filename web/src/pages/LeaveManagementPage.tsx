import { useCallback, useEffect, useState } from "react";

import type { EmployeeDirectoryItem, LeaveRequestView } from "../api/types";
import { PageHeader } from "../components/shell/PageHeader";
import { RefreshButton } from "../components/shell/RefreshButton";
import { PageError } from "../components/states/PageError";
import { SkeletonTable } from "../components/states/Skeleton";
import {
  LeaveConsole,
  LEAVE_ACTIONS,
  type LeaveDecideOutcome,
  type LeaveLedgerRow,
  type LeavePromotionOutcome,
} from "../console/leave";
import { BulkPolicyGateProvider } from "../console/policy";
import { useActiveBranchId, useAuth } from "../context/auth";
import { leaveManagementKo as copy } from "../i18n/hrWorkflows";

type LoadState = "loading" | "idle" | "error";

// Deny-by-omission action set, resolved at mount via
// POST /api/v1/policy/authorize/bulk (arch §5c) — see BulkPolicyGateProvider.
const LEAVE_GATE_ACTIONS: readonly string[] = Object.values(LEAVE_ACTIONS);

export function LeaveManagementPage() {
  const { api, session } = useAuth();
  const branchId = useActiveBranchId();
  const [state, setState] = useState<LoadState>("loading");
  const [roster, setRoster] = useState<LeaveLedgerRow[]>([]);
  const [requests, setRequests] = useState<LeaveRequestView[]>([]);

  const loadLeaveManagement = useCallback(async () => {
    setState("loading");
    const [employeesResponse, balancesResponse, requestsResponse] = await Promise.all([
      api
        .GET("/api/v1/employees", { params: { query: { limit: 1000, offset: 0 } } })
        .catch(() => undefined),
      api.GET("/api/v1/leave/balances").catch(() => undefined),
      api.GET("/api/v1/leave/requests", { params: { query: { limit: 200 } } }).catch(() => undefined),
    ]);

    if (!employeesResponse?.data || !balancesResponse?.data || !requestsResponse?.data) {
      setState("error");
      return;
    }

    const employeeById = new Map(
      employeesResponse.data.items.map((employee) => [employee.id, employee]),
    );
    setRoster(
      balancesResponse.data.items.map((entry, index) => {
        const employee = employeeById.get(entry.employee_id);
        return {
          id: entry.employee_id,
          code: `JL-${codeSuffix(employee?.employee_number, index)}`,
          name: entry.name,
          company: text(employee?.company),
          employeeNumber: text(employee?.employee_number),
          orgUnit: text(employee?.org_unit ?? entry.team),
          position: text(employee?.position),
          hireDate: employee?.hire_date ?? undefined,
          accrued: entry.grant,
          used: entry.used,
          remaining: entry.left,
          tone: entry.tone,
          active: isActiveEmployee(employee),
        };
      }),
    );
    setRequests(requestsResponse.data.items);
    setState("idle");
  }, [api]);

  useEffect(() => {
    void Promise.resolve().then(loadLeaveManagement);
  }, [loadLeaveManagement]);

  const decide = useCallback(
    async (requestId: string, decision: "approve" | "return" | "reject", comment?: string): Promise<LeaveDecideOutcome> => {
      const response = await api.POST("/api/v1/leave/requests/{id}/decide", {
        params: { path: { id: requestId } },
        body: { decision, comment },
      });
      if (response.error) return { ok: false, error: response.error };
      // APPROVE writes the leave ledger in the same transaction — refetch both.
      await loadLeaveManagement();
      return { ok: true };
    },
    [api, loadLeaveManagement],
  );

  const pushPromotion = useCallback(
    async (payload: {
      targetUserId: string;
      targetEmployeeId: string;
      targetName: string;
      round: 1 | 2;
      unusedDays: number;
    }): Promise<LeavePromotionOutcome> => {
      if (branchId === undefined) {
        return { ok: false, error: { error: { code: "no_branch", message: copy.loadFailed } } };
      }
      const response = await api.POST("/api/v1/leave/promotions", {
        body: {
          branch_id: branchId,
          target_user_id: payload.targetUserId,
          target_employee_id: payload.targetEmployeeId,
          target_name: payload.targetName,
          round: payload.round,
          unused_days: payload.unusedDays,
        },
      });
      if (!response.data) return { ok: false, error: response.error };
      return { ok: true, push: response.data };
    },
    [api, branchId],
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
          <BulkPolicyGateProvider actions={LEAVE_GATE_ACTIONS}>
            <LeaveConsole
              ledger={roster}
              requests={requests}
              selfUserId={session?.user_id}
              decide={decide}
              pushPromotion={pushPromotion}
            />
          </BulkPolicyGateProvider>
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

function text(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}
