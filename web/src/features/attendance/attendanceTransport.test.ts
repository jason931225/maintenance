import { describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import { AttendanceTransportError, type Week52Row } from "./attendanceApi";
import {
  createAttendanceApiTransport,
  type AttendanceApiTransport,
} from "./attendanceTransport";

function response(data: unknown = {}): { data: unknown; response: Response } {
  return { data, response: new Response(null, { status: 200 }) };
}

function attendanceException(action = "CONFIRM") {
  return {
    id: "exception-a",
    code: "AT-0701-01",
    kind: "LATE",
    status: "RESOLVED",
    employee_id: "employee-a",
    employee_name: "Kim",
    work_date: "2026-07-01",
    occurred_at: "2026-07-01T00:00:00Z",
    detail: "Verified late arrival",
    evidence: [],
    links: [],
    resolution: {
      action,
      reason: "Approved evidence",
      actor: "manager-a",
      resolved_at: "2026-07-01T01:00:00Z",
    },
    created_at: "2026-07-01T00:00:00Z",
  };
}

function client(resolutionAction = "CONFIRM") {
  const exception = attendanceException(resolutionAction);
  return {
    GET: vi.fn((path: string) => Promise.resolve(response(
      path === "/api/v1/attendance/exceptions"
        ? { items: [exception], total: 1, limit: 50, offset: 0 }
        : path === "/api/v1/attendance/exceptions/{exception_id}"
          ? exception
          : {},
    ))),
    POST: vi.fn((path: string) => Promise.resolve(response(
      path === "/api/v1/attendance/exceptions"
        || path === "/api/v1/attendance/exceptions/{exception_id}/resolve"
        ? exception
        : path === "/api/v1/attendance/week52/acks"
        ? {
            employee_id: "employee-a",
            name: "Kim",
            week_start: "2026-06-29",
            current_hours: 42,
            projected_hours: 44,
            tone: "WARN",
            acked: true,
            acked_at: "2026-07-01T00:00:00Z",
          }
        : {},
    ))),
  } as unknown as ConsoleApiClient;
}

describe("createAttendanceApiTransport", () => {
  it("maps all 13 canonical Attendance operations with branch-scoped reads and strict bodies", async () => {
    const api = client();
    const uuid = vi.fn(() => "idem-1");
    vi.stubGlobal("crypto", { randomUUID: uuid });
    const transport = createAttendanceApiTransport(api, "branch-a");

    await transport.listExceptions({ month: "2026-07", limit: 50 });
    await transport.createException({
      kind: "LATE",
      employee_id: "employee-a",
      work_date: "2026-07-01",
      detail: "Verified late arrival",
    });
    await transport.getException("exception-a");
    await transport.resolveException("exception-a", {
      action: "CONFIRM",
      reason: "Approved evidence",
    });
    await transport.listSubstitutions({ from_date: "2026-07-01", to_date: "2026-07-31" });
    await transport.createSubstitution({
      site: "Seoul",
      role: "Operator",
      cover_date: "2026-07-01",
      from_minutes: 540,
      to_minutes: 1_080,
      covered_employee_id: "employee-a",
      reason_kind: "NO_SHOW",
      worker_name: "Park",
      worker_type: "part-time",
    });
    await transport.cancelSubstitution("substitution-a", "Shift no longer requires cover");
    await transport.listCloses("2026-07");
    await transport.preflightClose("2026-07", "stale-caller-branch");
    await transport.confirmClose("2026-07", "stale-caller-branch");
    await transport.addCloseAmendment("close-a", {
      reason: "Correct verified attendance",
      detail: "Corrected approved record",
      ref: "AT-0701-01",
    });
    await transport.listWeek52("2026-06-29");
    const acknowledged = await transport.ackWeek52("employee-a", "2026-06-29");

    expect(api.GET).toHaveBeenNthCalledWith(1, "/api/v1/attendance/exceptions", {
      params: { query: { month: "2026-07", limit: 50, branch_id: "branch-a" } }, signal: undefined,
    });
    expect(api.POST).toHaveBeenNthCalledWith(1, "/api/v1/attendance/exceptions", {
      body: {
        kind: "LATE", employee_id: "employee-a", branch_id: "branch-a",
        work_date: "2026-07-01", detail: "Verified late arrival",
      },
      params: { header: { "Idempotency-Key": "idem-1" } }, signal: undefined,
    });
    expect(api.GET).toHaveBeenNthCalledWith(2, "/api/v1/attendance/exceptions/{exception_id}", {
      params: { path: { exception_id: "exception-a" } }, signal: undefined,
    });
    expect(api.POST).toHaveBeenNthCalledWith(2, "/api/v1/attendance/exceptions/{exception_id}/resolve", {
      params: { path: { exception_id: "exception-a" } },
      body: { action: "CONFIRM", reason: "Approved evidence" }, signal: undefined,
    });
    expect(api.GET).toHaveBeenNthCalledWith(3, "/api/v1/attendance/substitutions", {
      params: { query: { from_date: "2026-07-01", to_date: "2026-07-31", branch_id: "branch-a" } }, signal: undefined,
    });
    expect(api.POST).toHaveBeenNthCalledWith(3, "/api/v1/attendance/substitutions", {
      body: {
        site: "Seoul", branch_id: "branch-a", role: "Operator", cover_date: "2026-07-01",
        from_minutes: 540, to_minutes: 1_080, covered_employee_id: "employee-a",
        reason_kind: "NO_SHOW", worker_name: "Park", worker_type: "part-time",
      },
      params: { header: { "Idempotency-Key": "idem-1" } }, signal: undefined,
    });
    expect(api.POST).toHaveBeenNthCalledWith(4, "/api/v1/attendance/substitutions/{substitution_id}/cancel", {
      params: { path: { substitution_id: "substitution-a" } },
      body: { reason: "Shift no longer requires cover" }, signal: undefined,
    });
    expect(api.GET).toHaveBeenNthCalledWith(4, "/api/v1/attendance/closes", {
      params: { query: { month: "2026-07", branch_id: "branch-a" } }, signal: undefined,
    });
    expect(api.POST).toHaveBeenNthCalledWith(5, "/api/v1/attendance/closes/preflight", {
      body: { month: "2026-07", branch_scope: "branch-a" }, signal: undefined,
    });
    expect(api.POST).toHaveBeenNthCalledWith(6, "/api/v1/attendance/closes", {
      body: { month: "2026-07", branch_scope: "branch-a", attest: true }, signal: undefined,
    });
    expect(api.POST).toHaveBeenNthCalledWith(7, "/api/v1/attendance/closes/{close_id}/amendments", {
      params: { path: { close_id: "close-a" }, header: { "Idempotency-Key": "idem-1" } },
      body: { reason: "Correct verified attendance", detail: "Corrected approved record", ref: "AT-0701-01" }, signal: undefined,
    });
    expect(api.GET).toHaveBeenNthCalledWith(5, "/api/v1/attendance/week52", {
      params: { query: { week_start: "2026-06-29", branch_id: "branch-a" } }, signal: undefined,
    });
    expect(api.POST).toHaveBeenNthCalledWith(8, "/api/v1/attendance/week52/acks", {
      body: { employee_id: "employee-a", week_start: "2026-06-29" }, signal: undefined,
    });
    expect(uuid).toHaveBeenCalledTimes(3);
    expect(acknowledged).toEqual(expect.objectContaining({
      employee_id: "employee-a", name: "Kim", acked: true, tone: "WARN",
    } satisfies Partial<Week52Row>));
  });

  it("rebinds close calls to the replacement active branch and ignores stale caller scope", async () => {
    const api = client();
    const beforeRebind = createAttendanceApiTransport(api, "branch-a");
    const afterRebind = createAttendanceApiTransport(api, "branch-b");

    await beforeRebind.preflightClose("2026-07", "branch-b");
    await beforeRebind.confirmClose("2026-07", "branch-b");
    await afterRebind.preflightClose("2026-08", "branch-a");
    await afterRebind.confirmClose("2026-08", "branch-a");

    expect(api.POST).toHaveBeenNthCalledWith(1, "/api/v1/attendance/closes/preflight", {
      body: { month: "2026-07", branch_scope: "branch-a" }, signal: undefined,
    });
    expect(api.POST).toHaveBeenNthCalledWith(2, "/api/v1/attendance/closes", {
      body: { month: "2026-07", branch_scope: "branch-a", attest: true }, signal: undefined,
    });
    expect(api.POST).toHaveBeenNthCalledWith(3, "/api/v1/attendance/closes/preflight", {
      body: { month: "2026-08", branch_scope: "branch-b" }, signal: undefined,
    });
    expect(api.POST).toHaveBeenNthCalledWith(4, "/api/v1/attendance/closes", {
      body: { month: "2026-08", branch_scope: "branch-b", attest: true }, signal: undefined,
    });
  });

  it("uses the active branch for the two pre-existing HR read models without an empty fallback", async () => {
    const api = client();
    const transport = createAttendanceApiTransport(api, "branch-a");

    await transport.listAttendanceRecords(20);
    await transport.listAttendanceSummary(10);

    expect(api.GET).toHaveBeenNthCalledWith(1, "/api/v1/hr/attendance-records", {
      params: { query: { limit: 20, branch_id: "branch-a" } }, signal: undefined,
    });
    expect(api.GET).toHaveBeenNthCalledWith(2, "/api/v1/hr/attendance-summary", {
      params: { query: { limit: 10, branch_id: "branch-a" } }, signal: undefined,
    });
  });

  it.each([
    {
      operation: "listExceptions",
      request: (transport: AttendanceApiTransport) =>
        transport.listExceptions({ month: "2026-07", limit: 50 }),
    },
    {
      operation: "createException",
      request: (transport: AttendanceApiTransport) =>
        transport.createException({
          kind: "LATE",
          employee_id: "employee-a",
          work_date: "2026-07-01",
          detail: "Verified late arrival",
        }),
    },
    {
      operation: "getException",
      request: (transport: AttendanceApiTransport) =>
        transport.getException("exception-a"),
    },
    {
      operation: "resolveException",
      request: (transport: AttendanceApiTransport) =>
        transport.resolveException("exception-a", {
          action: "CONFIRM",
          reason: "Approved evidence",
        }),
    },
  ])("$operation rejects resolution actions outside the attendance domain contract", async ({
    request,
  }) => {
    const transport = createAttendanceApiTransport(client("FUTURE_ACTION"), "branch-a");
    let error: unknown;

    try {
      await request(transport);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AttendanceTransportError);
    expect(error).toMatchObject({
      message: "Unexpected attendance resolution action: FUTURE_ACTION",
      status: 502,
      body: { action: "FUTURE_ACTION" },
    });
  });
});
