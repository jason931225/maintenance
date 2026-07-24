import { describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import { SelfServiceAttendanceTransportError } from "./selfServiceAttendanceApi";
import { createSelfServiceAttendanceTransport } from "./selfServiceAttendanceTransport";

const page = {
  items: [{
    id: "00000000-0000-0000-0000-000000000001", code: "AT-31", kind: "LATE", status: "OPEN",
    work_date: "2026-07-20", occurred_at: "2026-07-20T09:01:00+09:00", detail: "출근 기록 확인 필요",
    evidence: [{ name: "출입기록", size: "24KB" }], created_at: "2026-07-20T09:02:00+09:00",
  }], total: 1, limit: 50, offset: 0,
};
const available = {
  status: "available",
  projection: { week_start: "2026-07-20", current_hours: 38, projected_hours: 46, tone: "WARN", acknowledged_at: null },
};
const unavailable = { status: "not_available" };

function result(data: unknown, status = 200, error?: unknown) {
  return { data, error, response: new Response(null, { status }) };
}

function client(get = vi.fn()): ConsoleApiClient {
  return { GET: get } as unknown as ConsoleApiClient;
}

describe("createSelfServiceAttendanceTransport", () => {
  it("uses exact generated own-resource paths, query names, no-store, and cancellation", async () => {
    const GET = vi.fn()
      .mockResolvedValueOnce(result(page))
      .mockResolvedValueOnce(result(available));
    const controller = new AbortController();
    const transport = createSelfServiceAttendanceTransport(client(GET));

    await expect(transport.listOwnExceptions({ month: "2026-07", status: "OPEN", limit: 50, offset: 0 }, controller.signal)).resolves.toEqual(page);
    await expect(transport.getOwnWeek52("2026-07-20", controller.signal)).resolves.toEqual(available);

    expect(GET).toHaveBeenNthCalledWith(1, "/api/v1/attendance/me/exceptions", {
      params: { query: { month: "2026-07", status: "OPEN", limit: 50, offset: 0 } },
      headers: { "Cache-Control": "no-store" }, signal: controller.signal,
    });
    expect(GET).toHaveBeenNthCalledWith(2, "/api/v1/attendance/me/week52", {
      params: { query: { week_start: "2026-07-20" } },
      headers: { "Cache-Control": "no-store" }, signal: controller.signal,
    });
    for (const call of GET.mock.calls) {
      const query = call[1].params.query as Record<string, unknown>;
      for (const forbidden of ["branch_id", "employee_id", "actor_id", "org_id", "manager_id"]) {
        expect(query).not.toHaveProperty(forbidden);
      }
    }
  });

  it("passes through the generated exception page unchanged", async () => {
    const GET = vi.fn().mockResolvedValue(result(page));
    await expect(createSelfServiceAttendanceTransport(client(GET)).listOwnExceptions({ month: "2026-07", status: "OPEN", limit: 50, offset: 0 })).resolves.toBe(page);
  });

  it("accepts both valid Week52 availability states", async () => {
    const GET = vi.fn().mockResolvedValueOnce(result(available)).mockResolvedValueOnce(result(unavailable));
    const transport = createSelfServiceAttendanceTransport(client(GET));
    await expect(transport.getOwnWeek52("2026-07-20")).resolves.toEqual(available);
    await expect(transport.getOwnWeek52("2026-07-20")).resolves.toEqual(unavailable);
  });

  it.each([
    { status: "available" },
    { status: "not_available", projection: available.projection },
    { status: "mystery", projection: available.projection },
    { status: "available", projection: { ...available.projection, tone: "MYSTERY" } },
    { status: "available", projection: null },
    { status: "available", projection: { ...available.projection, week_start: "2026-02-30" } },
    { status: "available", projection: { ...available.projection, week_start: "2026-07-21" } },
    { status: "available", projection: { ...available.projection, acknowledged_at: "2026-02-30T09:00:00Z" } },
    { status: "available", projection: { ...available.projection, acknowledged_at: "2026-07-20 09:00:00Z" } },
    { status: "available", projection: { ...available.projection, current_hours: -1 } },
    { status: "available", projection: { ...available.projection, projected_hours: Number.POSITIVE_INFINITY } },
    { status: "available", projection: { ...available.projection, projected_hours: Number.NaN } },
  ])("fails closed with 502 for malformed Week52 %#", async (malformed) => {
    const GET = vi.fn().mockResolvedValue(result(malformed));
    await expect(createSelfServiceAttendanceTransport(client(GET)).getOwnWeek52("2026-07-20")).rejects.toMatchObject({
      name: "SelfServiceAttendanceTransportError", status: 502,
    } satisfies Partial<SelfServiceAttendanceTransportError>);
  });

  it.each([
    ["week52", 401, { error: { code: "UNAUTHENTICATED", message: "token expired" } }, "token expired"],
    ["week52", 422, { detail: "week_start must be Monday" }, "week_start must be Monday"],
    ["exceptions", 401, { message: "token expired" }, "token expired"],
    ["exceptions", 422, { error: { code: "INVALID_MONTH", message: "month is invalid" } }, "month is invalid"],
    ["exceptions", 403, { error: "forbidden" }, "forbidden"],
  ] as const)("preserves generated server status and message for %s %i", async (endpoint, status, error, message) => {
    const GET = vi.fn().mockResolvedValue(result(undefined, status, error));
    const transport = createSelfServiceAttendanceTransport(client(GET));
    const pending = endpoint === "week52"
      ? transport.getOwnWeek52("2026-07-20")
      : transport.listOwnExceptions({ month: "2026-07", status: "OPEN", limit: 50, offset: 0 });
    await expect(pending).rejects.toMatchObject({
      name: "SelfServiceAttendanceTransportError", status, message,
    });
  });
});
