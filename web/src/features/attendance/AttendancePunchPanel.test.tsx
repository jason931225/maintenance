import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createConsoleApiClient } from "../../api/client";
import { AuthContext } from "../../context/auth";
import type { AuthContextValue, AuthSession } from "../../context/auth";
import { AttendancePunchPanel } from "./AttendancePunchPanel";

const baseRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  employee_id: "22222222-2222-4222-8222-222222222222",
  employee_display_name: "김현장",
  kind: "CLOCK_IN",
  occurred_at: "2026-07-02T00:00:00Z",
  work_date: "2026-07-02",
  state_after: "CLOCKED_IN",
  note: null,
  payroll_material_ref_id: "33333333-3333-4333-8333-333333333333",
  payroll_link_status: "LINKED",
  duplicate: false,
};

let records = [baseRecord];
let lastPostBody: unknown;
let postBodies: unknown[] = [];

const server = setupServer(
  http.get("*/api/v1/hr/attendance-records/me", () =>
    HttpResponse.json({
      items: records,
      total: records.length,
      limit: 50,
      offset: 0,
    }),
  ),
  http.post("*/api/v1/hr/attendance-records/me", async ({ request }) => {
    lastPostBody = await request.json();
    postBodies.push(lastPostBody);
    records = [
      {
        ...baseRecord,
        id: "44444444-4444-4444-8444-444444444444",
        kind: "OUT_FOR_WORK",
        occurred_at: "2026-07-02T01:00:00Z",
        state_after: "OUT_FOR_WORK",
        note: "BESTEC 현장 출장",
        payroll_material_ref_id: "55555555-5555-4555-8555-555555555555",
      },
      ...records,
    ];
    return HttpResponse.json(records[0]);
  }),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
});
afterEach(() => {
  records = [baseRecord];
  lastPostBody = undefined;
  postBodies = [];
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

function makeAuthContext(session: AuthSession | undefined): AuthContextValue {
  return {
    session,
    restoring: false,
    login: async () => {},
    logout: async () => {},
    refresh: async () => {},
    acceptTokens: () => {},
    clearPasskeySetup: () => {},
    viewAs: undefined,
    enterViewAs: () => {},
    exitViewAs: () => undefined,
    api: createConsoleApiClient(session?.access_token ?? ""),
  };
}

function renderApp(session: AuthSession | undefined = {
  access_token: "a",
  user_id: "user-1",
  roles: ["MECHANIC"],
}) {
  return render(
    <AuthContext.Provider value={makeAuthContext(session)}>
      <AttendancePunchPanel />
    </AuthContext.Provider>,
  );
}

describe("AttendancePunchPanel", () => {
  it("renders Korean self-service attendance controls and payroll material linkage", async () => {
    renderApp();

    expect(await screen.findByRole("heading", { level: 3, name: "출퇴근 및 기록" })).toBeInTheDocument();
    expect((await screen.findAllByText("근무 중")).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "출근 기록" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "외출 기록" })).toBeInTheDocument();
    expect(screen.getByText("급여준비 원천 연결")).toBeInTheDocument();
    expect(screen.getByText("연결됨")).toBeInTheDocument();
  });

  it("posts an idempotent out-of-office record and refreshes history", async () => {
    const user = userEvent.setup();
    renderApp();

    expect(await screen.findByText("비고 없음")).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "외출 기록" }));

    await waitFor(() => {
      expect(lastPostBody).toMatchObject({ kind: "OUT_FOR_WORK" });
    });
    expect(
      (lastPostBody as { idempotency_key?: string }).idempotency_key,
    ).toContain("OUT_FOR_WORK");
    expect((await screen.findAllByText("외출 중")).length).toBeGreaterThan(0);
    expect(await screen.findByText("BESTEC 현장 출장")).toBeInTheDocument();
  });

  it("retries a failed record write with the same idempotency key", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    server.use(
      http.post("*/api/v1/hr/attendance-records/me", async ({ request }) => {
        const body = await request.json();
        postBodies.push(body);
        attempts += 1;
        if (attempts === 1) {
          return HttpResponse.json(
            { error: { code: "unavailable", message: "try again" } },
            { status: 503 },
          );
        }

        return HttpResponse.json({
          ...baseRecord,
          id: "66666666-6666-4666-8666-666666666666",
          kind: "OUT_FOR_WORK",
          occurred_at: "2026-07-02T01:00:00Z",
          state_after: "OUT_FOR_WORK",
          payroll_material_ref_id: "77777777-7777-4777-8777-777777777777",
          duplicate: true,
        });
      }),
    );
    renderApp();

    await user.click(await screen.findByRole("button", { name: "외출 기록" }));
    expect(
      await screen.findByText("외출 기록을 저장하지 못했습니다."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "외출 기록 다시 시도" }));

    await screen.findByText("이미 저장된 근태 기록을 다시 확인했습니다.");
    expect(postBodies).toHaveLength(2);
    expect(
      (postBodies[0] as { idempotency_key?: string }).idempotency_key,
    ).toBe((postBodies[1] as { idempotency_key?: string }).idempotency_key);
  });

  it("surfaces linked-employee permission failures without exposing other employee records", async () => {
    server.use(
      http.get("*/api/v1/hr/attendance-records/me", () =>
        HttpResponse.json(
          { error: { code: "forbidden", message: "linked employee required" } },
          { status: 403 },
        ),
      ),
    );

    renderApp();

    expect(
      await screen.findByText("근태 기록을 불러오지 못했습니다."),
    ).toBeInTheDocument();
    expect(screen.queryByText("김현장")).not.toBeInTheDocument();
  });

  it("fences deferred session-A reads and writes after session replacement or logout", async () => {
    const user = userEvent.setup();
    let resolveReadA!: (response: HttpResponse) => void;
    let resolvePostA!: (response: HttpResponse) => void;
    const readA = new Promise<HttpResponse>((resolve) => { resolveReadA = resolve; });
    const postA = new Promise<HttpResponse>((resolve) => { resolvePostA = resolve; });
    let reads = 0;
    server.use(
      http.get("*/api/v1/hr/attendance-records/me", () => {
        reads += 1;
        if (reads === 1) return readA;
        return HttpResponse.json({ items: [{ ...baseRecord, employee_display_name: "B 직원", payroll_material_ref_id: "B-PAYROLL" }] });
      }),
      http.post("*/api/v1/hr/attendance-records/me", () => postA),
    );
    const sessionA: AuthSession = {
      access_token: "a",
      client_session_incarnation: "same-incarnation",
      user_id: "user-a",
      roles: ["MECHANIC"],
    };
    const sessionB: AuthSession = {
      access_token: "b",
      client_session_incarnation: "same-incarnation",
      user_id: "user-b",
      roles: ["MECHANIC"],
    };
    const view = renderApp(sessionA);
    await screen.findByRole("button", { name: "출근 기록" });
    await user.click(screen.getByRole("button", { name: "출근 기록" }));
    view.rerender(<AuthContext.Provider value={makeAuthContext(sessionB)}><AttendancePunchPanel /></AuthContext.Provider>);
    expect(await screen.findByText("B-PAYROLL")).toBeInTheDocument();
    resolveReadA(HttpResponse.json({ items: [{ ...baseRecord, employee_display_name: "A 직원", payroll_material_ref_id: "A-PAYROLL" }] }));
    resolvePostA(HttpResponse.json(baseRecord));
    await Promise.resolve();
    expect(screen.queryByText("A-PAYROLL")).not.toBeInTheDocument();
    expect(reads).toBe(2);
    view.rerender(<AuthContext.Provider value={makeAuthContext(undefined)}><AttendancePunchPanel /></AuthContext.Provider>);
    expect(screen.queryByRole("heading", { name: "출퇴근 및 기록" })).not.toBeInTheDocument();
  });

  it("removes prior records synchronously while a same-incarnation refresh reloads", async () => {
    let resolveB!: (response: HttpResponse) => void;
    const responseB = new Promise<HttpResponse>((resolve) => { resolveB = resolve; });
    let reads = 0;
    server.use(
      http.get("*/api/v1/hr/attendance-records/me", () => {
        reads += 1;
        if (reads === 1) {
          return HttpResponse.json({
            items: [{ ...baseRecord, payroll_material_ref_id: "A-PAYROLL" }],
          });
        }
        return responseB;
      }),
    );
    const sessionA: AuthSession = {
      access_token: "a",
      client_session_incarnation: "same-incarnation",
      user_id: "user-a",
      roles: ["MECHANIC"],
    };
    const sessionB: AuthSession = {
      access_token: "b",
      client_session_incarnation: "same-incarnation",
      user_id: "user-b",
      roles: ["MECHANIC"],
    };
    const view = renderApp(sessionA);
    expect(await screen.findByText("A-PAYROLL")).toBeInTheDocument();

    view.rerender(
      <AuthContext.Provider value={makeAuthContext(sessionB)}>
        <AttendancePunchPanel />
      </AuthContext.Provider>,
    );

    expect(screen.queryByText("A-PAYROLL")).not.toBeInTheDocument();
    resolveB(HttpResponse.json({
      items: [{ ...baseRecord, payroll_material_ref_id: "B-PAYROLL" }],
    }));
    expect(await screen.findByText("B-PAYROLL")).toBeInTheDocument();
  });

  it("supersedes a deferred initial read with the post-write reload", async () => {
    const user = userEvent.setup();
    let resolveInitial!: (response: HttpResponse) => void;
    const initial = new Promise<HttpResponse>((resolve) => { resolveInitial = resolve; });
    let initialSignal: AbortSignal | undefined;
    let reads = 0;
    server.use(
      http.get("*/api/v1/hr/attendance-records/me", ({ request }) => {
        reads += 1;
        if (reads === 1) {
          initialSignal = request.signal;
          return initial;
        }
        return HttpResponse.json({ items: [{ ...baseRecord, payroll_material_ref_id: "NEW-PAYROLL" }] });
      }),
      http.post("*/api/v1/hr/attendance-records/me", () => HttpResponse.json(baseRecord)),
    );
    renderApp();
    await user.click(await screen.findByRole("button", { name: "출근 기록" }));
    expect(await screen.findByText("NEW-PAYROLL")).toBeInTheDocument();
    expect(initialSignal?.aborted).toBe(true);
    resolveInitial(HttpResponse.json({ items: [{ ...baseRecord, payroll_material_ref_id: "OLD-PAYROLL" }] }));
    await Promise.resolve();
    expect(screen.queryByText("OLD-PAYROLL")).not.toBeInTheDocument();
    expect(reads).toBe(2);
  });

  it("aborts deferred session-A reads and writes on direct logout", async () => {
    const user = userEvent.setup();
    let resolveRead!: (response: HttpResponse) => void;
    let resolvePost!: (response: HttpResponse) => void;
    const read = new Promise<HttpResponse>((resolve) => { resolveRead = resolve; });
    const post = new Promise<HttpResponse>((resolve) => { resolvePost = resolve; });
    let readSignal: AbortSignal | undefined;
    let postSignal: AbortSignal | undefined;
    let reads = 0;
    server.use(
      http.get("*/api/v1/hr/attendance-records/me", ({ request }) => {
        reads += 1;
        readSignal = request.signal;
        return read;
      }),
      http.post("*/api/v1/hr/attendance-records/me", ({ request }) => {
        postSignal = request.signal;
        return post;
      }),
    );
    const view = renderApp();
    await user.click(await screen.findByRole("button", { name: "출근 기록" }));
    await waitFor(() => {
      expect(postSignal).toBeDefined();
    });
    view.rerender(<AuthContext.Provider value={makeAuthContext(undefined)}><AttendancePunchPanel /></AuthContext.Provider>);
    expect(readSignal?.aborted).toBe(true);
    expect(postSignal?.aborted).toBe(true);
    resolveRead(HttpResponse.json({ items: [{ ...baseRecord, payroll_material_ref_id: "A-PAYROLL" }] }));
    resolvePost(HttpResponse.json(baseRecord));
    await Promise.resolve();
    expect(screen.queryByText("A-PAYROLL")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "출퇴근 및 기록" })).not.toBeInTheDocument();
    expect(reads).toBe(1);
  });
});
