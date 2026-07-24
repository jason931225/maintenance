import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AppRouter } from "../AppRouter";
import { AuthContext } from "../context/auth";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { createConsoleApiClient } from "../api/client";
import {
  branchId,
  primaryMechanicId,
  userPage,
  workOrderListItems,
} from "../test/fixtures";

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

function pendingOffer(overrides: Record<string, unknown> = {}) {
  return {
    dispatch_id: DISPATCH_ID,
    work_order_id: workOrderListItems[0].id,
    branch_id: branchId,
    request_no: workOrderListItems[0].request_no,
    accept_window_started_at: "2026-06-12T09:00:00Z",
    accept_window_ends_at: "2026-06-12T09:05:00Z",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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

function renderApp(ctx: AuthContextValue, path = "/dispatch") {
  return render(
    <AuthContext.Provider value={ctx}>
      <MemoryRouter initialEntries={[path]}>
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
  it("sets non-urgent priority through the existing endpoint", async () => {
    const user = userEvent.setup();
    const patched = vi.fn();
    server.use(
      workOrdersHandler(),
      http.get("*/api/v1/users", () => HttpResponse.json(userPage(mechanics))),
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

  it("starts the urgent P1 dispatch broadcast when priority is set to 긴급", async () => {
    const user = userEvent.setup();
    const patched = vi.fn();
    const broadcast = vi.fn();
    server.use(
      workOrdersHandler(),
      http.get("*/api/v1/users", () => HttpResponse.json(userPage(mechanics))),
      http.patch("*/api/work-orders/:id/priority", async ({ request }) => {
        patched(await request.json());
        return HttpResponse.json({ ...workOrderListItems[0], priority: "P1" });
      }),
      http.post(
        "*/api/v1/work-orders/:id/p1-dispatch",
        async ({ request, params }) => {
          broadcast({
            id: params.id,
            body: await request.json(),
          });
          return HttpResponse.json(dispatchSummary);
        },
      ),
    );

    renderApp(makeAuthContext(adminSession));

    await user.click(
      await screen.findByRole("button", { name: "20260612-001 배차 제어" }),
    );

    await user.selectOptions(await screen.findByLabelText("중요도"), "P1");
    await user.click(screen.getByRole("button", { name: "중요도 변경" }));

    await waitFor(() => {
      expect(patched).toHaveBeenCalledWith({ priority: "P1" });
      expect(broadcast).toHaveBeenCalledWith({
        id: workOrderListItems[0].id,
        body: { include_region: false },
      });
    });
  });
  it("saves compact dispatch changes with the existing endpoints", async () => {
    const user = userEvent.setup();
    const patched = vi.fn();
    const scheduleRequested = vi.fn();
    const assigned = vi.fn();

    server.use(
      workOrdersHandler(),
      http.get("*/api/v1/users", () => HttpResponse.json(userPage(mechanics))),
      http.patch("*/api/work-orders/:id/priority", async ({ request }) => {
        patched(await request.json());
        return HttpResponse.json({ ...workOrderListItems[0], priority: "P2" });
      }),
      http.post(
        "*/api/work-orders/:id/target-change-requests",
        async ({ request }) => {
          scheduleRequested(await request.json());
          return HttpResponse.json({
            id: "target-change-1",
            work_order_id: workOrderListItems[0].id,
            requested_target_due_at: "2026-06-13T09:30:00.000Z",
            reason: "부품 도착 이후 방문",
            status: "REQUESTED",
          });
        },
      ),
      http.put("*/api/work-orders/:id/assignments", async ({ request }) => {
        assigned(await request.json());
        return HttpResponse.json(workOrderListItems[0]);
      }),
    );

    renderApp(makeAuthContext(adminSession));

    await user.click(
      await screen.findByRole("button", { name: "20260612-001 배차 제어" }),
    );

    const prioritySelect = await screen.findByLabelText("중요도");
    await user.selectOptions(prioritySelect, "P2");
    const scheduleInput = screen.getByLabelText("목표 일정");
    expect(scheduleInput).toHaveAttribute("type", "date");
    await user.type(scheduleInput, "2026-06-13");
    await user.type(
      screen.getByLabelText("일정변경 사유"),
      "부품 도착 이후 방문",
    );
    await user.click(await screen.findByRole("button", { name: "김정비 주" }));

    const saveAllButton = await screen.findByRole("button", {
      name: "전체 저장",
    });
    expect(saveAllButton).toHaveClass("min-h-8");
    expect(prioritySelect).toHaveClass("min-h-8");

    await user.click(saveAllButton);

    await waitFor(() => {
      expect(patched).toHaveBeenCalledWith({ priority: "P2" });
      expect(scheduleRequested).toHaveBeenCalledWith({
        requested_target_due_at: "2026-06-13T00:00:00.000Z",
        reason: "부품 도착 이후 방문",
      });
      expect(assigned).toHaveBeenCalledWith({
        assignments: [{ mechanic_id: primaryMechanicId, role: "PRIMARY" }],
      });
    });
  });

  it("assigns multiple mechanics and sends the full Vec", async () => {
    const user = userEvent.setup();
    const assigned = vi.fn();
    server.use(
      workOrdersHandler(),
      http.get("*/api/v1/users", () => HttpResponse.json(userPage(mechanics))),
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

  it("saves changed dispatch controls together from one compact action", async () => {
    const user = userEvent.setup();
    const patched = vi.fn();
    const assigned = vi.fn();
    const scheduleRequested = vi.fn();
    server.use(
      workOrdersHandler(),
      http.get("*/api/v1/users", () => HttpResponse.json(userPage(mechanics))),
      http.patch("*/api/work-orders/:id/priority", async ({ request }) => {
        patched(await request.json());
        return HttpResponse.json({ ...workOrderListItems[0], priority: "P2" });
      }),
      http.put("*/api/work-orders/:id/assignments", async ({ request }) => {
        assigned(await request.json());
        return HttpResponse.json(workOrderListItems[0]);
      }),
      http.post(
        "*/api/work-orders/:id/target-change-requests",
        async ({ request }) => {
          scheduleRequested(await request.json());
          return HttpResponse.json({ id: "target-change-1" });
        },
      ),
    );

    renderApp(makeAuthContext(adminSession));

    await user.click(
      await screen.findByRole("button", { name: "20260612-001 배차 제어" }),
    );

    await user.selectOptions(await screen.findByLabelText("중요도"), "P2");
    const scheduleInput = screen.getByLabelText("목표 일정");
    expect(scheduleInput).toHaveAttribute("type", "date");
    await user.type(scheduleInput, "2026-06-13");
    await user.type(screen.getByLabelText("일정변경 사유"), "고객 요청");
    await user.click(await screen.findByRole("button", { name: "김정비 주" }));
    await user.click(screen.getByRole("button", { name: "이정비 보조" }));

    await user.click(screen.getByRole("button", { name: "전체 저장" }));

    await waitFor(() => {
      expect(patched).toHaveBeenCalledWith({ priority: "P2" });
      expect(assigned).toHaveBeenCalledWith({
        assignments: [
          { mechanic_id: primaryMechanicId, role: "PRIMARY" },
          { mechanic_id: SECONDARY_MECHANIC, role: "SECONDARY" },
        ],
      });
      expect(scheduleRequested).toHaveBeenCalledWith({
        requested_target_due_at: "2026-06-13T00:00:00.000Z",
        reason: "고객 요청",
      });
    });
  });

  it("force-assigns a P1 dispatch behind a confirm dialog", async () => {
    const user = userEvent.setup();
    const forced = vi.fn();
    server.use(
      workOrdersHandler(),
      http.get("*/api/v1/users", () => HttpResponse.json(userPage(mechanics))),
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
    await user.type(await screen.findByLabelText("배차 코드"), DISPATCH_ID);
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

describe("DispatchPage search and deep-link", () => {
  it("filters the work-order list by the free-text query (client-side)", async () => {
    const user = userEvent.setup();
    server.use(workOrdersHandler());

    renderApp(makeAuthContext(adminSession));

    // All three fixture orders load initially (request_no shows in both the
    // searchable list and the grouped board, so there are multiple matches).
    expect((await screen.findAllByText("20260612-001")).length).toBeGreaterThan(
      0,
    );
    expect(screen.getAllByText("20260612-002").length).toBeGreaterThan(0);

    // Typing a request_no narrows both the list and the board to the match.
    await user.type(
      screen.getByLabelText("접수번호·고객사·호기 검색"),
      "20260612-002",
    );

    await waitFor(() => {
      expect(screen.queryByText("20260612-001")).not.toBeInTheDocument();
    });
    expect(screen.getAllByText("20260612-002").length).toBeGreaterThan(0);
  });

  it("redirects a /dispatch?wo={id} deep link to the detail view", async () => {
    server.use(
      workOrdersHandler(),
      http.get("*/api/v1/work-orders/:id", () =>
        HttpResponse.json({
          ...workOrderListItems[0],
          symptom: "유압 누유",
          customer_request: null,
          delay_reason: null,
          delay_note: null,
          diagnosis: null,
          action_taken: null,
          report_submitted_by: null,
          report_submitted_at: null,
          kpi_excluded: false,
          evidence_verified: false,
          approval_line: [],
          status_history: [],
          evidence: [],
        }),
      ),
    );

    renderApp(
      makeAuthContext(adminSession),
      `/dispatch?wo=${workOrderListItems[0].id}`,
    );

    // The deep link lands on the work-order detail page (its header), not the
    // dispatch board.
    expect(
      await screen.findByRole("heading", { name: "작업지시 상세" }),
    ).toBeVisible();
    expect(await screen.findByText("유압 누유")).toBeVisible();
  });
});

describe("DispatchPage mechanic accept/decline", () => {
  it("lists the authenticated mechanic's pending offer and accepts it without a pasted code", async () => {
    const user = userEvent.setup();
    const responded = vi.fn();
    server.use(
      workOrdersHandler(),
      http.get("*/api/v1/me/dispatch-offers", () =>
        HttpResponse.json({ items: [pendingOffer()] }),
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

    const offerQueue = await screen.findByRole("region", {
      name: "P1 배차 대기 목록",
    });
    expect(within(offerQueue).getByText(workOrderListItems[0].request_no)).toBeVisible();
    expect(
      within(offerQueue).getByRole("link", {
        name: workOrderListItems[0].request_no,
      }),
    ).toHaveAttribute("href", `/work-orders/${workOrderListItems[0].id}`);
    expect(screen.queryByLabelText("배차 코드")).not.toBeInTheDocument();

    await user.click(within(offerQueue).getByRole("button", { name: "수락" }));

    await waitFor(() => {
      expect(responded).toHaveBeenCalledWith({ response: "ACCEPT" });
    });
    expect(await screen.findByText("배차를 수락했습니다.")).toBeVisible();
    expect(
      within(offerQueue).queryByText(workOrderListItems[0].request_no),
    ).not.toBeInTheDocument();
  });

  it("hides manager controls from a mechanic", async () => {
    server.use(workOrdersHandler());
    renderApp(makeAuthContext(mechanicSession));

    await screen.findByText("P1 배차 수락");
    expect(
      screen.queryByRole("button", { name: "20260612-001 배차 제어" }),
    ).not.toBeInTheDocument();
  });

  it("renders an empty pending-offer queue", async () => {
    server.use(
      workOrdersHandler(),
      http.get("*/api/v1/me/dispatch-offers", () =>
        HttpResponse.json({ items: [] }),
      ),
    );

    renderApp(makeAuthContext(mechanicSession));

    expect(
      await screen.findByText("현재 수락 대기 중인 긴급 배차가 없습니다."),
    ).toBeVisible();
  });

  it("shows loading, then retries a transient offer-list failure", async () => {
    const user = userEvent.setup();
    let requests = 0;
    const firstResponse = deferred<undefined>();
    server.use(
      workOrdersHandler(),
      http.get("*/api/v1/me/dispatch-offers", async () => {
        requests += 1;
        if (requests === 1) {
          await firstResponse.promise;
          return HttpResponse.json({}, { status: 503 });
        }
        return HttpResponse.json({ items: [pendingOffer()] });
      }),
    );

    renderApp(makeAuthContext(mechanicSession));

    expect(
      await screen.findByText("수락 대기 배차를 불러오는 중입니다."),
    ).toBeVisible();
    firstResponse.resolve(undefined);

    expect(
      await screen.findByText("수락 대기 배차를 불러오지 못했습니다."),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "다시 시도" }));
    const offerQueue = await screen.findByRole("region", {
      name: "P1 배차 대기 목록",
    });
    expect(
      within(offerQueue).getByText(workOrderListItems[0].request_no),
    ).toBeVisible();
    expect(requests).toBe(2);
  });

  it("declines a pending offer and removes it from the queue", async () => {
    const user = userEvent.setup();
    const responded = vi.fn();
    server.use(
      workOrdersHandler(),
      http.get("*/api/v1/me/dispatch-offers", () =>
        HttpResponse.json({ items: [pendingOffer()] }),
      ),
      http.post(
        "*/api/v1/p1-dispatches/:id/responses",
        async ({ request }) => {
          responded(await request.json());
          return HttpResponse.json({ ...dispatchSummary, declined_count: 1 });
        },
      ),
    );

    renderApp(makeAuthContext(mechanicSession));

    const offerQueue = await screen.findByRole("region", {
      name: "P1 배차 대기 목록",
    });
    await user.click(within(offerQueue).getByRole("button", { name: "거절" }));

    await waitFor(() => {
      expect(responded).toHaveBeenCalledWith({ response: "DECLINE" });
    });
    expect(await screen.findByText("배차를 거절했습니다.")).toBeVisible();
    expect(
      within(offerQueue).queryByText(workOrderListItems[0].request_no),
    ).not.toBeInTheDocument();
  });

  it("keeps an offer visible when its response fails", async () => {
    const user = userEvent.setup();
    server.use(
      workOrdersHandler(),
      http.get("*/api/v1/me/dispatch-offers", () =>
        HttpResponse.json({ items: [pendingOffer()] }),
      ),
      http.post("*/api/v1/p1-dispatches/:id/responses", () =>
        HttpResponse.json({}, { status: 503 }),
      ),
    );

    renderApp(makeAuthContext(mechanicSession));

    const offerQueue = await screen.findByRole("region", {
      name: "P1 배차 대기 목록",
    });
    await user.click(within(offerQueue).getByRole("button", { name: "수락" }));

    expect(
      await screen.findByText("처리하지 못했습니다. 다시 시도하세요."),
    ).toBeVisible();
    expect(
      within(offerQueue).getByText(workOrderListItems[0].request_no),
    ).toBeVisible();
  });

  it("keeps pure managers on the read-only known-ID lookup without listing mechanic offers", async () => {
    const user = userEvent.setup();
    const offerListRequested = vi.fn();
    server.use(
      workOrdersHandler(),
      http.get("*/api/v1/users", () => HttpResponse.json(userPage(mechanics))),
      http.get("*/api/v1/me/dispatch-offers", () => {
        offerListRequested();
        return HttpResponse.json({ items: [pendingOffer()] });
      }),
      http.get("*/api/v1/p1-dispatches/:id", () =>
        HttpResponse.json(dispatchSummary),
      ),
    );

    renderApp(makeAuthContext(adminSession));

    const dispatchCode = await screen.findByLabelText("배차 코드");
    await user.type(dispatchCode, DISPATCH_ID);
    await user.click(screen.getByRole("button", { name: "조회" }));

    expect(await screen.findByText("수락 대기")).toBeVisible();
    expect(offerListRequested).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "수락" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "거절" })).not.toBeInTheDocument();
  });

  it("never renders a stale offer after the client session incarnation changes", async () => {
    const firstResponse = deferred<undefined>();
    const staleRequestNo = "WO-STALE-001";
    const freshRequestNo = "WO-FRESH-002";
    let requests = 0;
    server.use(
      workOrdersHandler(),
      http.get("*/api/v1/me/dispatch-offers", async () => {
        requests += 1;
        if (requests === 1) {
          await firstResponse.promise;
          return HttpResponse.json({
            items: [pendingOffer({ request_no: staleRequestNo })],
          });
        }
        return HttpResponse.json({
          items: [pendingOffer({ request_no: freshRequestNo })],
        });
      }),
    );

    const priorSession = {
      ...mechanicSession,
      client_session_incarnation: "dispatch-before",
    };
    const nextSession = {
      ...mechanicSession,
      client_session_incarnation: "dispatch-after",
    };
    const rendered = renderApp(makeAuthContext(priorSession));

    await waitFor(() => {
      expect(requests).toBe(1);
    });
    rendered.rerender(
      <AuthContext.Provider value={makeAuthContext(nextSession)}>
        <MemoryRouter initialEntries={["/dispatch"]}>
          <AppRouter />
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    expect(await screen.findByText(freshRequestNo)).toBeVisible();
    firstResponse.resolve(undefined);

    await waitFor(() => {
      expect(screen.queryByText(staleRequestNo)).not.toBeInTheDocument();
    });
    expect(screen.getByText(freshRequestNo)).toBeVisible();
  });
});
