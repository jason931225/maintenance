import { describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import { AttendanceApiError, createAttendanceApi } from "./attendanceApi";

function ok<T>(data: T) {
  return { data, response: new Response(null, { status: 200 }) };
}

function fail(
  status: number,
  message: string,
  extra: Record<string, unknown> = {},
) {
  return {
    error: { error: { message, ...extra } },
    response: new Response(null, { status }),
  };
}

function client() {
  return { GET: vi.fn(), POST: vi.fn() } as unknown as ConsoleApiClient;
}

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

describe("createAttendanceApi", () => {
  it("targets the attendance contract paths exactly", async () => {
    const api = client();
    asMock(api.GET).mockResolvedValue(
      ok({ items: [], total: 0, limit: 200, offset: 0 }),
    );
    asMock(api.POST).mockResolvedValue(ok({ id: "x" }));
    const transport = createAttendanceApi(api);

    await transport.listExceptions({ month: "2026-07", limit: 200 });
    await transport.listSubstitutions({ cover_date: "2026-07-23" });
    await transport.listCloses("2026-07");
    await transport.listWeek52("2026-07-20");
    await transport.listAttendanceRecords(200);
    expect(asMock(api.GET).mock.calls.map((call) => call[0] as string)).toEqual(
      [
        "/api/v1/attendance/exceptions",
        "/api/v1/attendance/substitutions",
        "/api/v1/attendance/closes",
        "/api/v1/attendance/week52",
        "/api/v1/hr/attendance-records",
      ],
    );

    await transport.resolveException("ex-1", { reason: "확인" });
    await transport.confirmClose("2026-07", "코스");
    await transport.ackWeek52("emp-1", "2026-07-20");
    const posts = asMock(api.POST).mock.calls;
    expect(posts[0][0]).toBe("/api/v1/attendance/exceptions/ex-1/resolve");
    expect(posts[0][1]).toMatchObject({ body: { reason: "확인" } });
    expect(posts[1][0]).toBe("/api/v1/attendance/closes");
    expect(posts[1][1]).toMatchObject({
      body: { month: "2026-07", branch_scope: "코스", attest: true },
    });
    expect(posts[2][0]).toBe("/api/v1/attendance/week52/acks");
  });

  it("maps the canonical error envelope onto AttendanceApiError with status and body", async () => {
    const api = client();
    asMock(api.POST).mockResolvedValue(fail(422, "처리 사유를 입력하세요"));
    const transport = createAttendanceApi(api);
    const attempt = transport.resolveException("ex-1", { reason: "" });
    await expect(attempt).rejects.toBeInstanceOf(AttendanceApiError);
    await transport
      .resolveException("ex-1", { reason: "" })
      .catch((cause: unknown) => {
        const error = cause as AttendanceApiError;
        expect(error.status).toBe(422);
        expect(error.message).toBe("처리 사유를 입력하세요");
        expect(error.body).toMatchObject({
          error: { message: "처리 사유를 입력하세요" },
        });
      });
  });

  it("falls back to a status-coded message when the envelope is absent", async () => {
    const api = client();
    asMock(api.GET).mockResolvedValue({
      error: undefined,
      response: new Response(null, { status: 500 }),
    });
    const transport = createAttendanceApi(api);
    await expect(transport.listCloses("2026-07")).rejects.toThrow(
      "Attendance request failed (500)",
    );
  });
});
