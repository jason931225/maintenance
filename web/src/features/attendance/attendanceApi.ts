// Attendance module transport. The new attendance crate (backend/crates/
// attendance, prefix /api/v1/attendance, openapi tag `attendance`) is built in
// a parallel lane; its routes are not yet in the generated client, so the
// contract DTOs below are typed locally and MUST match the shared scout
// contract exactly — at consolidation these aliases are replaced by
// components["schemas"] and any drift is a defect. Reuse reads (HR attendance
// records/summary) go through the generated typed client.
import type { components } from "@maintenance/api-client-ts";

import type { ConsoleApiClient } from "../../api/client";

export type EmployeeAttendanceRecord =
  components["schemas"]["EmployeeAttendanceRecord"];
export type AttendanceSummaryItem =
  components["schemas"]["AttendanceSummaryItem"];

export type ExceptionKind =
  "LATE" | "NO_SHOW" | "UNAPPROVED_OVERTIME" | "EARLY_LEAVE";
export type ExceptionStatus = "OPEN" | "RESOLVED";
export type ResolutionAction = "CONFIRM" | "APPROVE_OVERTIME";
export type SubstitutionReasonKind =
  "NO_SHOW" | "APPROVED_LEAVE" | "HALF_DAY" | "LONG_TERM" | "OTHER";
export type SubstitutionStatus = "ASSIGNED" | "CANCELLED";
export type Week52Tone = "OK" | "WARN" | "DANGER";

export interface AttendanceEvidence {
  name: string;
  size?: string | null;
}

export interface AttendanceObjectLink {
  kind: string;
  label: string;
  ref?: string | null;
}

export interface ExceptionResolution {
  action: ResolutionAction;
  reason: string;
  linked_work_ref?: string | null;
  ot_hours?: number | null;
  actor: string;
  resolved_at: string;
}

export interface AttendanceException {
  id: string;
  code: string;
  kind: ExceptionKind;
  status: ExceptionStatus;
  employee_id: string;
  employee_name: string;
  team?: string | null;
  branch_id?: string | null;
  work_date: string;
  occurred_at: string;
  detail: string;
  evidence: AttendanceEvidence[];
  links: AttendanceObjectLink[];
  resolution?: ExceptionResolution | null;
  created_at: string;
}

export interface Substitution {
  id: string;
  site: string;
  branch_id?: string | null;
  role: string;
  cover_date: string;
  from_minutes: number;
  to_minutes: number;
  covered_employee_id?: string | null;
  covered_name: string;
  reason_kind: SubstitutionReasonKind;
  reason_detail?: string | null;
  worker_employee_id?: string | null;
  worker_name: string;
  worker_type: string;
  worker_rate?: string | null;
  status: SubstitutionStatus;
  approval_ref?: string | null;
  contract_ref?: string | null;
  exception_id?: string | null;
  created_by: string;
  created_at: string;
}

export interface CreateSubstitution {
  site: string;
  branch_id?: string | null;
  role: string;
  cover_date: string;
  from_minutes: number;
  to_minutes: number;
  covered_employee_id?: string | null;
  covered_name: string;
  reason_kind: SubstitutionReasonKind;
  reason_detail?: string | null;
  worker_employee_id?: string | null;
  worker_name: string;
  worker_type: string;
  worker_rate?: string | null;
  exception_id?: string | null;
}

export interface CloseCheck {
  key: string;
  ok: boolean;
  warn?: boolean;
  note?: string | null;
}

export interface CloseAmendment {
  id: string;
  reason: string;
  actor: string;
  created_at: string;
}

export interface MonthClose {
  id: string;
  month: string;
  branch_scope: string;
  checks: CloseCheck[];
  attested_by: string;
  attested_at: string;
  period_lock_id?: string | null;
  closed_at: string;
  amendments: CloseAmendment[];
}

export interface MonthCloseItem {
  branch_scope: string;
  closed: boolean;
  close?: MonthClose | null;
  open_exceptions: number;
  pending_leave: number;
}

export interface MonthCloseBoard {
  month: string;
  items: MonthCloseItem[];
}

export interface ClosePreflight {
  month: string;
  branch_scope: string;
  checks: CloseCheck[];
  can_close: boolean;
}

export interface Week52Row {
  employee_id: string;
  name: string;
  team?: string | null;
  week_start: string;
  current_hours: number;
  projected_hours: number;
  tone: Week52Tone;
  acked: boolean;
  acked_at?: string | null;
}

export interface Week52Board {
  week_start: string;
  items: Week52Row[];
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export class AttendanceApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "AttendanceApiError";
  }
}

function errorMessage(error: unknown, status: number): string {
  if (error && typeof error === "object" && "error" in error) {
    const body = error as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string") return body.error.message;
  }
  return `Attendance request failed (${String(status)})`;
}

type Query = Record<string, string | number | undefined>;

interface RawResult {
  data?: unknown;
  error?: unknown;
  response: Response;
}

/**
 * Untyped path escape hatch for the not-yet-regenerated attendance routes.
 * The ConsoleApiClient is an openapi-fetch client; its GET/POST accept any
 * path at runtime (auth/refresh middleware included) — only the compile-time
 * path map lags until the integrator regenerates clients/ts.
 */
interface RawAttendanceClient {
  GET(
    path: string,
    init?: { params?: { query?: Query }; signal?: AbortSignal },
  ): Promise<RawResult>;
  POST(
    path: string,
    init?: { params?: { query?: Query }; body?: unknown; signal?: AbortSignal },
  ): Promise<RawResult>;
}

function requireRaw(result: RawResult): unknown {
  if (result.data !== undefined) return result.data;
  throw new AttendanceApiError(
    errorMessage(result.error, result.response.status),
    result.response.status,
    result.error,
  );
}

function requireData<T>(response: {
  data?: T;
  error?: unknown;
  response: Response;
}): T {
  if (response.data !== undefined) return response.data;
  throw new AttendanceApiError(
    errorMessage(response.error, response.response.status),
    response.response.status,
    response.error,
  );
}

export interface ExceptionQuery {
  work_date?: string;
  month?: string;
  status?: ExceptionStatus;
  employee_id?: string;
  limit?: number;
  offset?: number;
}

export interface ResolveException {
  reason: string;
  linked_work_ref?: string;
  ot_hours?: number;
}

/** Attendance transport bound to the authenticated ConsoleApiClient. */
export function createAttendanceApi(api: ConsoleApiClient) {
  const raw = api as unknown as RawAttendanceClient;
  return {
    listExceptions: async (query: ExceptionQuery, signal?: AbortSignal) => {
      const result = await raw.GET("/api/v1/attendance/exceptions", {
        params: { query: { ...query } },
        signal,
      });
      return requireRaw(result) as Page<AttendanceException>;
    },
    resolveException: async (
      id: string,
      input: ResolveException,
      signal?: AbortSignal,
    ) => {
      const result = await raw.POST(
        `/api/v1/attendance/exceptions/${id}/resolve`,
        {
          body: input,
          signal,
        },
      );
      return requireRaw(result) as AttendanceException;
    },
    listSubstitutions: async (
      query: { cover_date?: string; site?: string },
      signal?: AbortSignal,
    ) => {
      const result = await raw.GET("/api/v1/attendance/substitutions", {
        params: { query: { ...query } },
        signal,
      });
      return requireRaw(result) as Page<Substitution>;
    },
    createSubstitution: async (
      input: CreateSubstitution,
      signal?: AbortSignal,
    ) => {
      const result = await raw.POST("/api/v1/attendance/substitutions", {
        body: input,
        signal,
      });
      return requireRaw(result) as Substitution;
    },
    cancelSubstitution: async (
      id: string,
      reason: string,
      signal?: AbortSignal,
    ) => {
      const result = await raw.POST(
        `/api/v1/attendance/substitutions/${id}/cancel`,
        {
          body: { reason },
          signal,
        },
      );
      return requireRaw(result) as Substitution;
    },
    listCloses: async (month: string, signal?: AbortSignal) => {
      const result = await raw.GET("/api/v1/attendance/closes", {
        params: { query: { month } },
        signal,
      });
      return requireRaw(result) as MonthCloseBoard;
    },
    preflightClose: async (
      month: string,
      branchScope: string,
      signal?: AbortSignal,
    ) => {
      const result = await raw.POST("/api/v1/attendance/closes/preflight", {
        body: { month, branch_scope: branchScope },
        signal,
      });
      return requireRaw(result) as ClosePreflight;
    },
    confirmClose: async (
      month: string,
      branchScope: string,
      signal?: AbortSignal,
    ) => {
      const result = await raw.POST("/api/v1/attendance/closes", {
        body: { month, branch_scope: branchScope, attest: true },
        signal,
      });
      return requireRaw(result) as MonthClose;
    },
    listWeek52: async (weekStart: string, signal?: AbortSignal) => {
      const result = await raw.GET("/api/v1/attendance/week52", {
        params: { query: { week_start: weekStart } },
        signal,
      });
      return requireRaw(result) as Week52Board;
    },
    ackWeek52: async (
      employeeId: string,
      weekStart: string,
      signal?: AbortSignal,
    ) => {
      const result = await raw.POST("/api/v1/attendance/week52/acks", {
        body: { employee_id: employeeId, week_start: weekStart },
        signal,
      });
      return requireRaw(result) as Week52Row;
    },
    // Reuse reads (already in the generated client).
    listAttendanceRecords: async (limit: number, signal?: AbortSignal) => {
      const response = await api.GET("/api/v1/hr/attendance-records", {
        params: { query: { limit } },
        signal,
      });
      return requireData(response);
    },
    listAttendanceSummary: async (limit: number, signal?: AbortSignal) => {
      const response = await api.GET("/api/v1/hr/attendance-summary", {
        params: { query: { limit } },
        signal,
      });
      return requireData(response);
    },
  };
}

export type AttendanceApi = ReturnType<typeof createAttendanceApi>;
