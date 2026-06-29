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
import { branchId, primaryMechanicId, userPage } from "../test/fixtures";

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

const planId = "abcdef01-abcd-4bcd-8bcd-abcdefabcdef";
const sourceWorkOrderId = "11111111-1111-4111-8111-111111111111";

const mechanics = [
  {
    id: primaryMechanicId,
    display_name: "김정비",
    phone: null,
    team: "MAINTENANCE",
    roles: ["MECHANIC"],
    branch_ids: [branchId],
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
  },
];

function makeAuthContext(session: AuthSession): AuthContextValue {
  const api = createConsoleApiClient(session.access_token);
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
    api,
  };
}

function renderApp(ctx: AuthContextValue) {
  return render(
    <AuthContext.Provider value={ctx}>
      <MemoryRouter initialEntries={["/daily-plan"]}>
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

const mechanicSession: AuthSession = {
  access_token: "m",
  user_id: primaryMechanicId,
  roles: ["MECHANIC"],
  branches: [branchId],
};

const executiveSession: AuthSession = {
  access_token: "e",
  user_id: "exec-1",
  roles: ["EXECUTIVE"],
  branches: [branchId],
};

function usersHandler() {
  return http.get("*/api/v1/users", () => HttpResponse.json(userPage(mechanics)));
}

function workOrdersHandler() {
  return http.get("*/api/v1/work-orders", () =>
    HttpResponse.json({
      items: [
        {
          id: sourceWorkOrderId,
          request_no: "20260629-001",
          branch_id: branchId,
          status: "RECEIVED",
          priority: "P2",
          result_type: "UNKNOWN",
          target_due_at: null,
          created_at: "2026-06-29T00:00:00Z",
          updated_at: "2026-06-29T00:00:00Z",
          equipment: {
            id: "22222222-2222-4222-8222-222222222222",
            equipment_no: "EXP30-0001",
            management_no: "001",
            model: "EX30",
            status: "임대",
            specification: "굴착기",
            ton_text: "3t",
          },
          customer: {
            id: "33333333-3333-4333-8333-333333333333",
            name: "항성",
          },
          site: {
            id: "44444444-4444-4444-8444-444444444444",
            name: "1공장",
          },
          site_contact: null,
          assignments: [],
        },
      ],
      limit: 100,
      offset: 0,
      total: 1,
    }),
  );
}

function dailyPlansHandler() {
  return http.get("*/api/daily-work-plans", () =>
    HttpResponse.json({ items: [] }),
  );
}

function planSummary(status: string) {
  return {
    id: planId,
    branch_id: branchId,
    mechanic_id: primaryMechanicId,
    plan_date: "2026-06-16",
    status,
    items: [
      {
        work_order_id: sourceWorkOrderId,
        request_no: "20260629-001",
        equipment_no: "EXP30-0001",
        management_no: "001",
        customer_name: "항성",
        site_name: "1공장",
        description: "오일 교환",
        sort_order: 1,
      },
    ],
  };
}

describe("DailyPlanPage", () => {
  it("runs create -> request-review -> approve -> confirm for an admin", async () => {
    const user = userEvent.setup();
    const created = vi.fn();
    const requested = vi.fn();
    const reviewed = vi.fn();
    const confirmed = vi.fn();

    server.use(
      dailyPlansHandler(),
      usersHandler(),
      workOrdersHandler(),
      http.post("*/api/daily-work-plans", async ({ request }) => {
        created(await request.json());
        return HttpResponse.json(planSummary("DRAFT"), { status: 201 });
      }),
      http.post("*/api/daily-work-plans/:planId/request-review", () => {
        requested();
        return HttpResponse.json(planSummary("REQUESTED"));
      }),
      http.post("*/api/daily-work-plans/:planId/review", async ({ request }) => {
        reviewed(await request.json());
        return HttpResponse.json(planSummary("APPROVED"));
      }),
      http.post("*/api/daily-work-plans/:planId/confirm", () => {
        confirmed();
        return HttpResponse.json(planSummary("FINAL_CONFIRMED"));
      }),
    );

    renderApp(makeAuthContext(adminSession));

    // Create
    await screen.findByRole("option", { name: "김정비" });
    expect(screen.queryByLabelText("담당 정비사")).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("정비사"), primaryMechanicId);
    const dateInput = screen.getByLabelText("계획 일자");
    await user.clear(dateInput);
    await user.type(dateInput, "2026-06-16");
    await user.selectOptions(
      await screen.findByLabelText("접수내용 1"),
      sourceWorkOrderId,
    );
    await user.type(screen.getByLabelText("작업 내용 1"), "오일 교환");
    await user.click(screen.getByRole("button", { name: "계획 생성" }));

    await waitFor(() => {
      expect(created).toHaveBeenCalledWith({
        branch_id: branchId,
        mechanic_id: primaryMechanicId,
        plan_date: "2026-06-16",
        items: [{ work_order_id: sourceWorkOrderId, description: "오일 교환" }],
      });
    });
    expect(await screen.findByText("작성 중")).toBeVisible();

    // Request review
    await user.click(await screen.findByRole("button", { name: "검토 요청" }));
    await waitFor(() => {
      expect(requested).toHaveBeenCalled();
    });
    expect(await screen.findByText("검토 요청됨")).toBeVisible();

    // Approve
    await user.click(await screen.findByRole("button", { name: "승인" }));
    await waitFor(() => {
      expect(reviewed).toHaveBeenCalledWith({ decision: "APPROVED" });
    });
    expect(await screen.findByText("승인됨")).toBeVisible();

    // Confirm (결재)
    await user.click(await screen.findByRole("button", { name: "결재" }));
    await waitFor(() => {
      expect(confirmed).toHaveBeenCalled();
    });
    expect(await screen.findByText("결재 완료")).toBeVisible();
  });

  it("lets a mechanic create and request review but not approve", async () => {
    const user = userEvent.setup();
    server.use(
      dailyPlansHandler(),
      usersHandler(),
      workOrdersHandler(),
      http.post("*/api/daily-work-plans", () =>
        HttpResponse.json(planSummary("DRAFT"), { status: 201 }),
      ),
      http.post("*/api/daily-work-plans/:planId/request-review", () =>
        HttpResponse.json(planSummary("REQUESTED")),
      ),
    );

    renderApp(makeAuthContext(mechanicSession));

    await screen.findByRole("option", { name: "김정비" });
    await user.selectOptions(
      screen.getByLabelText("담당 정비사"),
      primaryMechanicId,
    );
    await user.selectOptions(
      await screen.findByLabelText("접수내용 1"),
      sourceWorkOrderId,
    );
    await user.type(screen.getByLabelText("작업 내용 1"), "타이어 점검");
    await user.click(screen.getByRole("button", { name: "계획 생성" }));

    await user.click(await screen.findByRole("button", { name: "검토 요청" }));
    expect(await screen.findByText("검토 요청됨")).toBeVisible();

    // A mechanic is not a DailyPlanReview holder: no approve/reject controls.
    expect(
      screen.queryByRole("button", { name: "승인" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "반려" }),
    ).not.toBeInTheDocument();
  });

  it("bounces an executive off /daily-plan (no DailyPlanRequest)", async () => {
    // RequireDailyPlanRoute redirects a non-DailyPlanRequest role away, so the
    // page never renders for an executive — stronger than merely hiding the
    // create surface, and matching the hidden `daily-plan` nav gate.
    renderApp(makeAuthContext(executiveSession));

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "계획업무" }),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: "계획 생성" }),
    ).not.toBeInTheDocument();
  });
});
