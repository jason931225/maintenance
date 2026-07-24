import type { ConsoleApiClient } from "../../api/client";

import {
  AttendanceTransportError,
  type AttendanceException,
  type AttendanceTransport,
  type CloseAmendment,
  type CloseAmendmentInput,
  type CreateAttendanceException,
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
} from "./attendanceApi";

/** Authenticated generated-client binding implements the full screen port. */
export type AttendanceApiTransport = AttendanceTransport;

type ApiResult<T> = {
  data?: T;
  error?: unknown;
  response: Response;
};

function responseMessage(error: unknown, status: number): string {
  if (error && typeof error === "object" && "error" in error) {
    const envelope = error as { error?: { message?: unknown } };
    if (typeof envelope.error?.message === "string")
      return envelope.error.message;
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

/**
 * Authenticated generated-client binding for the Attendance REST surface.
 *
 * This deliberately calls the exact generated OpenAPI paths. The candidate
 * base predates the parallel OpenAPI generation lane, so TypeScript currently
 * reports those paths as absent instead of silently accepting a stringly typed
 * fallback. Once that lane lands, this adapter becomes checked against the
 * canonical generated path/body/header contracts without source changes.
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
      return requireData<Page<AttendanceException>>(result);
    },

    async createException(input, signal) {
      const result = await api.POST("/api/v1/attendance/exceptions", {
        body: { ...input, branch_id: activeBranchId },
        params: { header: { "Idempotency-Key": idempotencyKey() } },
        signal,
      });
      return requireData<AttendanceException>(result);
    },

    async getException(id, signal) {
      const result = await api.GET(
        "/api/v1/attendance/exceptions/{exception_id}",
        {
          params: { path: { exception_id: id } },
          signal,
        },
      );
      return requireData<AttendanceException>(result);
    },

    async resolveException(id, input, signal) {
      const result = await api.POST(
        "/api/v1/attendance/exceptions/{exception_id}/resolve",
        {
          params: { path: { exception_id: id } },
          body: input,
          signal,
        },
      );
      return requireData<AttendanceException>(result);
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
      const result = await api.POST(
        "/api/v1/attendance/substitutions/{substitution_id}/cancel",
        {
          params: { path: { substitution_id: id } },
          body: { reason },
          signal,
        },
      );
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
      const result = await api.POST(
        "/api/v1/attendance/closes/{close_id}/amend",
        {
          params: {
            path: { close_id: closeId },
            header: { "Idempotency-Key": idempotencyKey() },
          },
          body: input,
          signal,
        },
      );
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
      const result = await api.POST("/api/v1/attendance/week52/ack", {
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
