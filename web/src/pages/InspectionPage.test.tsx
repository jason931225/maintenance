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
import { branchId, equipmentLookup } from "../test/fixtures";

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
// The equipment picker submits the chosen option's id (the autocomplete row's
// id), so the create request carries the fixture equipment's id.
const equipmentId = equipmentLookup.id;
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
      // Picker option sources for the create form.
      http.get("*/api/v1/branches", () =>
        HttpResponse.json([
          {
            id: branchId,
            region_id: "11111111-1111-4111-8111-111111111110",
            name: "창원지점",
            deactivated_at: null,
            created_at: "2026-06-01T00:00:00Z",
          },
        ]),
      ),
      http.get("*/api/v1/users", () =>
        HttpResponse.json([
          {
            id: mechanicId,
            display_name: "홍정비",
            phone: "010-1234-5678",
            team: "MAINTENANCE",
            roles: ["MECHANIC"],
            branch_ids: [branchId],
            is_active: true,
            has_passkey: true,
            account_status: "ACTIVE",
            created_at: "2026-06-01T00:00:00Z",
          },
        ]),
      ),
      http.get("*/api/v1/equipment", () =>
        HttpResponse.json({ items: [equipmentLookup], limit: 8 }),
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

    // Branch picker: type to filter, then pick the human-named option.
    await user.type(screen.getByLabelText("지점"), "창원");
    await user.click(await screen.findByRole("option", { name: /창원지점/ }));

    // Equipment picker: server typeahead, pick by management number / model.
    await user.type(screen.getByLabelText("장비 (호기 번호)"), "290");
    await user.click(await screen.findByRole("option", { name: /290/ }));

    // Mechanic picker: filter and select the assigned mechanic by name.
    await user.type(screen.getByLabelText("담당 정비사"), "홍정비");
    await user.click(await screen.findByRole("option", { name: /홍정비/ }));

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
