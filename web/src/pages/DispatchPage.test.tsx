import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AppRouter } from "../AppRouter";
import { AuthContext } from "../context/auth";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { createConsoleApiClient } from "../api/client";
import { branchId, primaryMechanicId, workOrderListItems } from "../test/fixtures";

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

const SECONDARY_MECHANIC = "abcabcab-abca-4bca-8bca-abcabcabcabc";
const DISPATCH_ID = "deadbeef-dead-4bef-8bef-deadbeefdead";

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
  {
    id: SECONDARY_MECHANIC,
    display_name: "이정비",
    phone: null,
    team: "MAINTENANCE",
    roles: ["MECHANIC"],
    branch_ids: [branchId],
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
  },
];

const dispatchSummary = {
  id: DISPATCH_ID,
  work_order_id: workOrderListItems[0].id,
  branch_id: branchId,
  status: "BROADCASTING",
  accept_window_started_at: "2026-06-12T09:00:00Z",
  accept_window_ends_at: "2026-06-12T09:05:00Z",
  target_count: 3,
  accepted_count: 0,
  declined_count: 0,
  manual_call_required: false,
};

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
      <MemoryRouter initialEntries={["/dispatch"]}>
        <AppRouter />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

function workOrdersHandler() {
  return http.get("*/api/v1/work-orders", () =>
    HttpResponse.json({
      items: workOrderListItems,
      limit: 100,
      offset: 0,
      total: workOrderListItems.length,
    }),
  );
}

const adminSession: AuthSession = {
  access_token: "a",
  user_id: "manager-1",
  roles: ["ADMIN"],
  branches: [branchId],
};

const mechanicSession: AuthSession = {
  access_token: "m",
  user_id: primaryMechanicId,
  roles: ["MECHANIC"],
  branches: [branchId],
};

describe("DispatchPage manager controls", () => {
  it("sets priority through the existing endpoint", async () => {
    const user = userEvent.setup();
    const patched = vi.fn();
    server.use(
      workOrdersHandler(),
      http.get("*/api/v1/users", () => HttpResponse.json(mechanics)),
      http.patch("*/api/work-orders/:id/priority", async ({ request }) => {
        patched(await request.json());
        return HttpResponse.json({ ...workOrderListItems[0], priority: "P2" });
      }),
    );

    renderApp(makeAuthContext(adminSession));

    // Open the controls for the first received work order.
    const manageButton = await screen.findByRole("button", {
      name: "20260612-001 배차 제어",
    });
    await user.click(manageButton);

    const prioritySelect = await screen.findByLabelText("중요도");
    await user.selectOptions(prioritySelect, "P2");
    await user.click(screen.getByRole("button", { name: "중요도 변경" }));

    await waitFor(() => {
      expect(patched).toHaveBeenCalledWith({ priority: "P2" });
    });
  });

  it("assigns multiple mechanics and sends the full Vec", async () => {
    const user = userEvent.setup();
    const assigned = vi.fn();
    server.use(
      workOrdersHandler(),
      http.get("*/api/v1/users", () => HttpResponse.json(mechanics)),
      http.put("*/api/work-orders/:id/assignments", async ({ request }) => {
        assigned(await request.json());
        return HttpResponse.json(workOrderListItems[0]);
      }),
    );

    renderApp(makeAuthContext(adminSession));

    await user.click(
      await screen.findByRole("button", { name: "20260612-001 배차 제어" }),
    );

    // Pick one PRIMARY and one SECONDARY mechanic.
    await user.click(await screen.findByRole("button", { name: "김정비 주" }));
    await user.click(screen.getByRole("button", { name: "이정비 보조" }));
    await user.click(screen.getByRole("button", { name: "배정" }));

    await waitFor(() => {
      expect(assigned).toHaveBeenCalledWith({
        assignments: [
          { mechanic_id: primaryMechanicId, role: "PRIMARY" },
          { mechanic_id: SECONDARY_MECHANIC, role: "SECONDARY" },
        ],
      });
    });
  });

  it("force-assigns a P1 dispatch behind a confirm dialog", async () => {
    const user = userEvent.setup();
    const forced = vi.fn();
    server.use(
      workOrdersHandler(),
      http.get("*/api/v1/users", () => HttpResponse.json(mechanics)),
      http.get("*/api/v1/p1-dispatches/:id", () =>
        HttpResponse.json(dispatchSummary),
      ),
      http.post(
        "*/api/v1/p1-dispatches/:id/force-assign",
        async ({ request }) => {
          forced(await request.json());
          return HttpResponse.json({
            ...dispatchSummary,
            status: "AUTO_ASSIGNED",
          });
        },
      ),
    );

    renderApp(makeAuthContext(adminSession));

    // Look up the active dispatch via the offers panel so the manager controls
    // expose the force-assign action for that dispatch id.
    await user.type(await screen.findByLabelText("배차 ID"), DISPATCH_ID);
    await user.click(screen.getByRole("button", { name: "조회" }));
    await screen.findByText("수락 대기");

    await user.click(
      await screen.findByRole("button", { name: "20260612-001 배차 제어" }),
    );

    const forceSelect = await screen.findByLabelText("강제 배정");
    await user.selectOptions(forceSelect, primaryMechanicId);
    await user.click(screen.getByRole("button", { name: "강제 배정" }));

    // Confirm dialog appears; confirm fires the request.
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "강제 배정" }));

    await waitFor(() => {
      expect(forced).toHaveBeenCalledWith({ mechanic_id: primaryMechanicId });
    });
  });
});

describe("DispatchPage mechanic accept/decline", () => {
  it("looks up a dispatch and accepts it", async () => {
    const user = userEvent.setup();
    const responded = vi.fn();
    server.use(
      workOrdersHandler(),
      http.get("*/api/v1/p1-dispatches/:id", () =>
        HttpResponse.json(dispatchSummary),
      ),
      http.post(
        "*/api/v1/p1-dispatches/:id/responses",
        async ({ request }) => {
          responded(await request.json());
          return HttpResponse.json({
            ...dispatchSummary,
            accepted_count: 1,
          });
        },
      ),
    );

    renderApp(makeAuthContext(mechanicSession));

    await user.type(await screen.findByLabelText("배차 ID"), DISPATCH_ID);
    await user.click(screen.getByRole("button", { name: "조회" }));

    await user.click(await screen.findByRole("button", { name: "수락" }));

    await waitFor(() => {
      expect(responded).toHaveBeenCalledWith({ response: "ACCEPT" });
    });
    expect(await screen.findByText("배차를 수락했습니다.")).toBeVisible();
  });

  it("hides manager controls from a mechanic", async () => {
    server.use(workOrdersHandler());
    renderApp(makeAuthContext(mechanicSession));

    await screen.findByText("P1 배차 수락");
    expect(
      screen.queryByRole("button", { name: "20260612-001 배차 제어" }),
    ).not.toBeInTheDocument();
  });
});
