import type { components } from "@maintenance/api-client-ts";

import type { ConsoleApiClient } from "../../api/client";
import {
  SelfServiceAttendanceTransportError,
  isValidOwnWeek52,
  type OwnAttendanceExceptionPage,
  type OwnAttendanceExceptionQuery,
  type OwnAttendanceWeek52,
  type SelfServiceAttendanceApi,
} from "./selfServiceAttendanceApi";

const NO_STORE = { "Cache-Control": "no-store" } as const;

type GeneratedWeek52 = components["schemas"]["OwnAttendanceWeek52Response"];

function serverMessage(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as Record<string, unknown>;
  const nested = candidate.error;
  if (nested && typeof nested === "object") {
    const message = (nested as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  for (const key of ["message", "detail", "error"]) {
    if (typeof candidate[key] === "string" && candidate[key].trim()) return candidate[key];
  }
  return undefined;
}

function requestError(status: number, error: unknown): SelfServiceAttendanceTransportError {
  return new SelfServiceAttendanceTransportError(
    serverMessage(error) ?? `Attendance self-service request failed (${status})`,
    status,
  );
}

/**
 * Principal-scoped attendance reads through the generated client.  The server,
 * not this transport, derives the employee linkage; consequently no identity,
 * branch, or manager selector is accepted or emitted here.
 */
export function createSelfServiceAttendanceTransport(api: ConsoleApiClient): SelfServiceAttendanceApi {
  return {
    async listOwnExceptions(query: OwnAttendanceExceptionQuery, signal?: AbortSignal): Promise<OwnAttendanceExceptionPage> {
      const { data, error, response } = await api.GET("/api/v1/attendance/me/exceptions", {
        params: {
          query: {
            month: query.month,
            status: query.status,
            limit: query.limit,
            offset: query.offset,
          },
        },
        headers: NO_STORE,
        signal,
      });
      if (!data) throw requestError(response.status, error);
      return data;
    },

    async getOwnWeek52(weekStart: string, signal?: AbortSignal): Promise<OwnAttendanceWeek52> {
      const { data, error, response } = await api.GET("/api/v1/attendance/me/week52", {
        params: { query: { week_start: weekStart } },
        headers: NO_STORE,
        signal,
      });
      if (!response.ok) throw requestError(response.status, error);
      if (!data) {
        throw new SelfServiceAttendanceTransportError("Attendance Week52 response violated its contract", 502);
      }
      const envelope: GeneratedWeek52 = data;
      if (!isValidOwnWeek52(envelope)) {
        throw new SelfServiceAttendanceTransportError("Attendance Week52 response violated its contract", 502);
      }
      return envelope;
    },
  };
}
