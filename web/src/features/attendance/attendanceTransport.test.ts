import { describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import { createAttendanceApiTransport } from "./attendanceTransport";

function response(data: unknown = {}): { data: unknown; response: Response } {
  return { data, response: new Response(null, { status: 200 }) };
}

function client() {
  return {
    GET: vi.fn(() => Promise.resolve(response())),
    POST: vi.fn(() => Promise.resolve(response())),
  } as unknown as ConsoleApiClient;
}

describe("createAttendanceApiTransport", () => {
  it("maps every Attendance REST operation through the authenticated generated client", async () => {
    const api = client();
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "idem-1") });
    const transport = createAttendanceApiTransport(api, "branch-a");

    await transport.listExceptions({ month: "2026-07", limit: 50 });
    await transport.createException({
      kind: "LATE",
      employee_id: "employee-a",
      work_date: "2026-07-01",
      detail: "Verified late arrival",
    });
    await transport.getException("exception-a");
    await transport.resolveException("exception-a", { reason: "Approved evidence" });
    await transport.listSubstitutions({ from_date: "2026-07-01", to_date: "2026-07-31" });
    await transport.createSubstitution({
      site: "Seoul",
      role: "Operator",
      cover_date: "2026-07-01",
      from_minutes: 540,
      to_minutes: 1_080,
      covered_name: "Kim",
      reason_kind: "NO_SHOW",
      worker_name: "Park",
      worker_type: "part-time",
    });
    await transport.cancelSubstitution("substitution-a", "Shift no longer requires cover");
    await transport.listCloses("2026-07");
    await transport.preflightClose("2026-07", "branch-a");
    await transport.confirmClose("2026-07", "branch-a");
    await transport.addCloseAmendment("close-a", {
      reason: "Correct verified attendance",
      detail: "Corrected approved record",
      ref: "AT-0701-01",
    });
    await transport.listWeek52("2026-06-29");
    await transport.ackWeek52("employee-a", "2026-06-29");

    expect(api.GET).toHaveBeenNthCalledWith(1, "/api/v1/attendance/exceptions", {
      params: { query: { month: "2026-07", limit: 50 } }, signal: undefined,
    });
    expect(api.POST).toHaveBeenNthCalledWith(1, "/api/v1/attendance/exceptions", {
      body: expect.objectContaining({ branch_id: "branch-a", employee_id: "employee-a" }),
      params: { header: { "Idempotency-Key": "idem-1" } }, signal: undefined,
    });
    expect(api.GET).toHaveBeenNthCalledWith(2, "/api/v1/attendance/exceptions/{id}", {
      params: { path: { id: "exception-a" } }, signal: undefined,
    });
    expect(api.POST).toHaveBeenNthCalledWith(2, "/api/v1/attendance/exceptions/{id}/resolve", {
      params: { path: { id: "exception-a" }, header: { "Idempotency-Key": "idem-1" } },
      body: { reason: "Approved evidence" }, signal: undefined,
    });
    expect(api.GET).toHaveBeenNthCalledWith(3, "/api/v1/attendance/substitutions", {
      params: { query: { from_date: "2026-07-01", to_date: "2026-07-31" } }, signal: undefined,
    });
    expect(api.POST).toHaveBeenNthCalledWith(3, "/api/v1/attendance/substitutions", {
      body: expect.objectContaining({ branch_id: "branch-a", site: "Seoul" }),
      params: { header: { "Idempotency-Key": "idem-1" } }, signal: undefined,
    });
    expect(api.POST).toHaveBeenNthCalledWith(4, "/api/v1/attendance/substitutions/{id}/cancel", {
      params: { path: { id: "substitution-a" }, header: { "Idempotency-Key": "idem-1" } },
      body: { reason: "Shift no longer requires cover" }, signal: undefined,
    });
    expect(api.GET).toHaveBeenNthCalledWith(4, "/api/v1/attendance/closes", {
      params: { query: { month: "2026-07" } }, signal: undefined,
    });
    expect(api.POST).toHaveBeenNthCalledWith(5, "/api/v1/attendance/closes/preflight", {
      body: { month: "2026-07", branch_id: "branch-a" }, signal: undefined,
    });
    expect(api.POST).toHaveBeenNthCalledWith(6, "/api/v1/attendance/closes", {
      body: { month: "2026-07", branch_id: "branch-a", attest: true },
      params: { header: { "Idempotency-Key": "idem-1" } }, signal: undefined,
    });
    expect(api.POST).toHaveBeenNthCalledWith(7, "/api/v1/attendance/closes/{id}/amendments", {
      params: { path: { id: "close-a" }, header: { "Idempotency-Key": "idem-1" } },
      body: { reason: "Correct verified attendance", detail: "Corrected approved record", ref: "AT-0701-01" }, signal: undefined,
    });
    expect(api.GET).toHaveBeenNthCalledWith(5, "/api/v1/attendance/week52", {
      params: { query: { week_start: "2026-06-29" } }, signal: undefined,
    });
    expect(api.POST).toHaveBeenNthCalledWith(8, "/api/v1/attendance/week52/acks", {
      body: { employee_id: "employee-a", week_start: "2026-06-29" },
      params: { header: { "Idempotency-Key": "idem-1" } }, signal: undefined,
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
});
