import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AppRouter } from "../AppRouter";
import { AuthContext } from "../context/auth";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { createConsoleApiClient } from "../api/client";
import type { InspectionScheduleSummary } from "../api/types";
import { branchId } from "../test/fixtures";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

const scheduleId = "77777777-7777-4777-8777-777777777777";
const equipmentId = "88888888-8888-4888-8888-888888888888";
const mechanicId = "99999999-9999-4999-8999-999999999999";

const overdueSchedule: InspectionScheduleSummary = {
  id: scheduleId,
  branch_id: branchId,
  equipment_id: equipmentId,
  mechanic_id: mechanicId,
  cycle: "MONTHLY",
  interval_days: 30,
  due_date: "2020-01-01",
  status: "SCHEDULED",
  completed_at: null,
  note: null,
  site_name: "본사현장",
  management_no: "290",
  model: "GTS25DE",
  created_at: "2026-06-01T00:00:00Z",
  updated_at: "2026-06-01T00:00:00Z",
};

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

function renderApp(ctx: AuthContextValue) {
  return render(
    <AuthContext.Provider value={ctx}>
      <MemoryRouter initialEntries={["/inspection"]}>
        <AppRouter />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

const adminSession: AuthSession = {
  access_token: "a",
  user_id: "admin-1",
  roles: ["ADMIN"],
  branches: [branchId],
};

describe("InspectionPage", () => {
  it("lists overdue schedules and creates a new recurring schedule", async () => {
    const user = userEvent.setup();
    const created = vi.fn();
    server.use(
      http.get("*/api/v1/inspections/schedules", () =>
        HttpResponse.json([overdueSchedule]),
      ),
      http.post("*/api/v1/inspections/schedules", async ({ request }) => {
        created(await request.json());
        return HttpResponse.json(
          { ...overdueSchedule, id: "new" },
          { status: 201 },
        );
      }),
    );

    renderApp(makeAuthContext(adminSession));

    // The overdue (past-due, SCHEDULED) row is flagged.
    expect(await screen.findByText("지연")).toBeVisible();
    expect(screen.getByText(/본사현장/)).toBeVisible();

    await user.type(screen.getByLabelText("지점 ID"), branchId);
    await user.type(screen.getByLabelText("장비 ID"), equipmentId);
    await user.type(screen.getByLabelText("담당 정비사 ID"), mechanicId);
    await user.click(screen.getByRole("button", { name: "일정 등록" }));

    await waitFor(() => {
      expect(created).toHaveBeenCalledWith(
        expect.objectContaining({
          branch_id: branchId,
          equipment_id: equipmentId,
          mechanic_id: mechanicId,
          cycle: "MONTHLY",
          interval_days: 30,
        }),
      );
    });
    expect(
      await screen.findByText("정기 예방정비 일정을 등록했습니다."),
    ).toBeVisible();
  });
});
