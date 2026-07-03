import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AppRouter } from "../AppRouter";
import { createConsoleApiClient } from "../api/client";
import { AuthContext } from "../context/auth";
import type { AuthContextValue, AuthSession } from "../context/auth";

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

function makeAuthContext(session: AuthSession): AuthContextValue {
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
    api: createConsoleApiClient(session.access_token),
  };
}

function renderApp(path = "/attendance") {
  return render(
    <AuthContext.Provider
      value={makeAuthContext({
        access_token: "a",
        user_id: "user-1",
        roles: ["MECHANIC"],
      })}
    >
      <MemoryRouter initialEntries={[path]}>
        <AppRouter />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe("AttendancePage", () => {
  it("renders Korean self-service attendance controls and payroll material linkage", async () => {
    renderApp();

    expect(await screen.findByText("내 근태 기록")).toBeInTheDocument();
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
});
