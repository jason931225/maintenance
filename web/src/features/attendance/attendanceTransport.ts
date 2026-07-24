import type { components } from "@maintenance/api-client-ts";

import type { ConsoleApiClient } from "../../api/client";

import {
  AttendanceTransportError,
  type AttendanceException,
  type AttendanceTransport,
  type CloseAmendment,
  type ClosePreflight,
  type CreateSubstitution,
  type MonthClose,
  type MonthCloseBoard,
  type Page,
  type Substitution,
  type SubstitutionQuery,
  type Week52Board,
  type Week52Row,
  type EmployeeAttendanceRecord,
  type AttendanceSummaryItem,
  type ResolutionAction,
} from "./attendanceApi";

/**
 * Additional Attendance operations that are part of the public 13-operation
 * REST surface but are not currently initiated by the reviewed console screen.
 * Keeping them in this generated-client adapter makes every path contract
 * testable without fabricating a second transport or a raw-fetch escape hatch.
 */
export interface AttendanceOperationTransport {
  createException(
    input: CreateAttendanceException,
    signal?: AbortSignal,
  ): Promise<AttendanceException>;
  getException(id: string, signal?: AbortSignal): Promise<AttendanceException>;
  addCloseAmendment(
    closeId: string,
    input: CloseAmendmentInput,
    signal?: AbortSignal,
  ): Promise<CloseAmendment>;
}

export interface CreateAttendanceException {
  kind: AttendanceException["kind"];
  employee_id: string;
  work_date: string;
  detail: string;
  evidence?: AttendanceException["evidence"];
}

export interface CloseAmendmentInput {
  reason: string;
  detail: string;
  ref?: string | null;
}

export type AttendanceApiTransport = AttendanceTransport & AttendanceOperationTransport;

type ApiResult<T> = {
  data?: T;
  error?: unknown;
  response: Response;
};

type AttendanceExceptionWire = components["schemas"]["AttendanceException"];
type AttendanceExceptionPageWire = components["schemas"]["AttendanceExceptionPage"];

function responseMessage(error: unknown, status: number): string {
  if (error && typeof error === "object" && "error" in error) {
    const envelope = error as { error?: { message?: unknown } };
    if (typeof envelope.error?.message === "string") return envelope.error.message;
  }
  return `Attendance request failed (${String(status)})`;
}

function requireData<T>(result: ApiResult<T>): T {
  if (result.data !== undefined) return result.data;
  throw new AttendanceTransportError(
    responseMessage(result.error, result.response.status),
    result.response.status,
    result.error,
  );
}

function idempotencyKey(): string {
  return crypto.randomUUID();
}

function requireResolutionAction(value: string): ResolutionAction {
  if (value === "CONFIRM" || value === "APPROVE_OVERTIME") return value;
  throw new AttendanceTransportError(
    `Unexpected attendance resolution action: ${value}`,
    502,
    { action: value },
  );
}

function mapAttendanceException(value: AttendanceExceptionWire): AttendanceException {
  return {
    ...value,
    resolution: value.resolution
      ? {
          ...value.resolution,
          action: requireResolutionAction(value.resolution.action),
        }
      : value.resolution,
  };
}

function mapAttendanceExceptionPage(
  value: AttendanceExceptionPageWire,
): Page<AttendanceException> {
  return {
    ...value,
    items: value.items.map(mapAttendanceException),
  };
}

/**
 * Authenticated generated-client binding for the Attendance REST surface.
 *
 * This calls the exact generated OpenAPI paths and remains checked against
 * their canonical path, body, and header contracts.
 */
export function createAttendanceApiTransport(
  api: ConsoleApiClient,
  activeBranchId: string,
): AttendanceApiTransport {
  return {
    async listExceptions(query, signal) {
      const result = await api.GET("/api/v1/attendance/exceptions", {
        params: { query: { ...query, branch_id: activeBranchId } },
        signal,
      });
      return mapAttendanceExceptionPage(requireData(result));
    },

    async createException(input, signal) {
      const result = await api.POST("/api/v1/attendance/exceptions", {
        body: { ...input, branch_id: activeBranchId },
        params: { header: { "Idempotency-Key": idempotencyKey() } },
        signal,
      });
      return mapAttendanceException(requireData(result));
    },

    async getException(id, signal) {
      const result = await api.GET("/api/v1/attendance/exceptions/{exception_id}", {
        params: { path: { exception_id: id } },
        signal,
      });
      return mapAttendanceException(requireData(result));
    },

    async resolveException(id, input, signal) {
      const result = await api.POST("/api/v1/attendance/exceptions/{exception_id}/resolve", {
        params: { path: { exception_id: id } },
        body: input,
        signal,
      });
      return mapAttendanceException(requireData(result));
    },

    async listSubstitutions(query: SubstitutionQuery, signal) {
      const result = await api.GET("/api/v1/attendance/substitutions", {
        params: { query: { ...query, branch_id: activeBranchId } },
        signal,
      });
      return requireData<Page<Substitution>>(result);
    },

    async createSubstitution(input: CreateSubstitution, signal) {
      const result = await api.POST("/api/v1/attendance/substitutions", {
        body: { ...input, branch_id: activeBranchId },
        params: { header: { "Idempotency-Key": idempotencyKey() } },
        signal,
      });
      return requireData<Substitution>(result);
    },

    async cancelSubstitution(id, reason, signal) {
      const result = await api.POST("/api/v1/attendance/substitutions/{substitution_id}/cancel", {
        params: { path: { substitution_id: id } },
        body: { reason },
        signal,
      });
      return requireData<Substitution>(result);
    },

    async listCloses(month, signal) {
      const result = await api.GET("/api/v1/attendance/closes", {
        params: { query: { month, branch_id: activeBranchId } },
        signal,
      });
      return requireData<MonthCloseBoard>(result);
    },

    async preflightClose(month, _callerBranchScope, signal) {
      const result = await api.POST("/api/v1/attendance/closes/preflight", {
        body: { month, branch_scope: activeBranchId },
        signal,
      });
      return requireData<ClosePreflight>(result);
    },

    async confirmClose(month, _callerBranchScope, signal) {
      const result = await api.POST("/api/v1/attendance/closes", {
        body: {
          month,
          branch_scope: activeBranchId,
          attest: true,
        },
        signal,
      });
      return requireData<MonthClose>(result);
    },

    async addCloseAmendment(closeId, input, signal) {
      const result = await api.POST("/api/v1/attendance/closes/{close_id}/amendments", {
        params: {
          path: { close_id: closeId },
          header: { "Idempotency-Key": idempotencyKey() },
        },
        body: input,
        signal,
      });
      return requireData<CloseAmendment>(result);
    },

    async listWeek52(weekStart, signal) {
      const result = await api.GET("/api/v1/attendance/week52", {
        params: { query: { week_start: weekStart, branch_id: activeBranchId } },
        signal,
      });
      return requireData<Week52Board>(result);
    },

    async ackWeek52(employeeId, weekStart, signal) {
      const result = await api.POST("/api/v1/attendance/week52/acks", {
        body: { employee_id: employeeId, week_start: weekStart },
        signal,
      });
      return requireData<Week52Row>(result);
    },

    async listAttendanceRecords(limit, signal) {
      const result = await api.GET("/api/v1/hr/attendance-records", {
        params: { query: { limit, branch_id: activeBranchId } },
        signal,
      });
      return requireData<{ items: EmployeeAttendanceRecord[] }>(result);
    },

    async listAttendanceSummary(limit, signal) {
      const result = await api.GET("/api/v1/hr/attendance-summary", {
        params: { query: { limit, branch_id: activeBranchId } },
        signal,
      });
      return requireData<{ items: AttendanceSummaryItem[] }>(result);
    },
  };
}
