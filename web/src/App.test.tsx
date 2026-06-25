import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse, ws } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AppRouter } from "./AppRouter";
import { AuthContext } from "./context/auth";
import type { AuthContextValue, AuthSession } from "./context/auth";
import { createConsoleApiClient } from "./api/client";
import { getDefaultKpiPeriod } from "./features/kpi/kpi-format";
import {
  equipmentLookup,
  kpiReport,
  tokenPair,
  workOrderListItems,
  workOrders,
} from "./test/fixtures";

// ── MSW handlers ──────────────────────────────────────────────────────────────

const listRequests: URL[] = [];
const kpiRequests: URL[] = [];
const autocompleteRequests: URL[] = [];
const lookupRequests: URL[] = [];
let rejectRequest: { url: URL; body: unknown } | undefined;

const messengerWs = ws.link("ws://localhost:3000/api/v1/ws*");

const server = setupServer(
  messengerWs.addEventListener("connection", () => {}),
  http.get("*/api/v1/work-orders", ({ request }) => {
    const url = new URL(request.url);
    listRequests.push(url);
    const statusFilter = url.searchParams
      .getAll("status")
      .flatMap((v) => v.split(","));
    const items =
      statusFilter.length > 0
        ? workOrderListItems.filter((wo) => statusFilter.includes(wo.status))
        : workOrderListItems;
    return HttpResponse.json({
      items,
      limit: Number(url.searchParams.get("limit") ?? 100),
      offset: Number(url.searchParams.get("offset") ?? 0),
      total: items.length,
    });
  }),
  http.get("*/api/v1/kpi", ({ request }) => {
    const url = new URL(request.url);
    kpiRequests.push(url);
    return HttpResponse.json(kpiReport);
  }),
  http.get("*/api/v1/ops/summary", () => HttpResponse.json(opsSummary)),
  http.get("*/api/v1/location/arrival-events", () =>
    HttpResponse.json({ items: [], limit: 20, offset: 0, total: 0 }),
  ),
  http.get("*/api/v1/location-consent/status", () =>
    HttpResponse.json({
      consent_id: "00000000-0000-4000-8000-000000000011",
      user_id: "00000000-0000-4000-8000-000000000002",
      branch_id: "00000000-0000-4000-8000-000000000001",
      state: "GRANTED",
      may_collect: true,
      granted_at: "2026-06-12T00:00:00Z",
      suspended_at: null,
      resumed_at: null,
      withdrawn_at: null,
      updated_at: "2026-06-12T00:00:00Z",
    }),
  ),
  http.get("*/api/v1/location-consents/ledger", () =>
    HttpResponse.json({ items: [], limit: 10, offset: 0, total: 0 }),
  ),
  http.get("*/api/v1/equipment", ({ request }) => {
    const url = new URL(request.url);
    autocompleteRequests.push(url);
    return HttpResponse.json({
      items: [equipmentLookup],
      limit: Number(url.searchParams.get("limit") ?? 5),
    });
  }),
  http.get("*/api/v1/equipment/lookup", ({ request }) => {
    const url = new URL(request.url);
    lookupRequests.push(url);
    return HttpResponse.json(equipmentLookup);
  }),
  http.get("*/api/messenger/threads", () =>
    HttpResponse.json({ items: [] }),
  ),
  http.post(
    "*/api/v1/work-orders/:workOrderId/reject",
    async ({ request }) => {
      rejectRequest = { url: new URL(request.url), body: await request.json() };
      return HttpResponse.json({ ...workOrders[1], status: "REJECTED" });
    },
  ),
);

beforeAll(() => { server.listen({ onUnhandledRequest: "error" }); });
afterEach(() => {
  server.resetHandlers();
  window.localStorage.removeItem("knl_cookie_notice_v1");
  listRequests.length = 0;
  kpiRequests.length = 0;
  autocompleteRequests.length = 0;
  lookupRequests.length = 0;
  rejectRequest = undefined;
});
afterAll(() => { server.close(); });

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeAuthContext(session: AuthSession | undefined): AuthContextValue {
  const api = createConsoleApiClient(session?.access_token);
  return {
    session,
    // Tests inject a settled context directly (no AuthProvider), so the boot
    // silent refresh has already resolved: restoring is false.
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

// A generic authenticated console user. Carries an operational role
// (MECHANIC): the app now default-denies a roleless / MEMBER-only session and
// routes it to /pending, so a "real" signed-in user must hold a granted role to
// reach the shared shell pages (dispatch / intake / messenger).
const authenticatedSession: AuthSession = {
  access_token: tokenPair.access_token,
  user_id: "00000000-0000-4000-8000-000000000002",
  roles: ["MECHANIC"],
  branches: ["00000000-0000-4000-8000-000000000001"],
};

const adminSession: AuthSession = {
  ...authenticatedSession,
  roles: ["ADMIN"],
};

const mechanicSession: AuthSession = {
  ...authenticatedSession,
  roles: ["MECHANIC"],
};

const opsSummary = {
  funnel: { received: 2, assigned: 1, in_progress: 3, completed: 5 },
  aging_hours: 24,
  aging_work_orders: 1,
  sla_breached: 0,
  sla_at_risk: 2,
  mechanic_load: [
    {
      mechanic_id: "00000000-0000-4000-8000-000000000099",
      display_name: "김정비",
      active_assignments: 3,
    },
  ],
  equipment_status: {
    rented: 10,
    spare: 4,
    scrapped: 1,
    replacement: 2,
    sold: 0,
  },
  active_substitutions: 1,
  pending_approvals: 2,
  open_support_tickets: 4,
};

function renderAt(path: string, session: AuthSession | undefined = authenticatedSession) {
  const ctx = makeAuthContext(session);
  return render(
    <AuthContext.Provider value={ctx}>
      <MemoryRouter initialEntries={[path]}>
        <AppRouter />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ProtectedRoute unit", () => {
  it("redirects to /login when unauthenticated", () => {
    const unauthCtx = makeAuthContext(undefined);
    render(
      <AuthContext.Provider value={unauthCtx}>
        <MemoryRouter initialEntries={["/dispatch"]}>
          <Routes>
            <Route path="/login" element={<div data-testid="login-page">login</div>} />
            <Route element={<ProtectedRoute />}>
              <Route path="/dispatch" element={<div data-testid="dispatch-page">dispatch</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    );
    expect(screen.getByTestId("login-page")).toBeVisible();
    expect(screen.queryByTestId("dispatch-page")).not.toBeInTheDocument();
  });

  it("renders protected content when authenticated", () => {
    const authCtx = makeAuthContext(authenticatedSession);
    render(
      <AuthContext.Provider value={authCtx}>
        <MemoryRouter initialEntries={["/dispatch"]}>
          <Routes>
            <Route path="/login" element={<div data-testid="login-page">login</div>} />
            <Route element={<ProtectedRoute />}>
              <Route path="/dispatch" element={<div data-testid="dispatch-page">dispatch</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    );
    expect(screen.getByTestId("dispatch-page")).toBeVisible();
    expect(screen.queryByTestId("login-page")).not.toBeInTheDocument();
  });
});

describe("AppRouter authenticated", () => {
  it("renders the protected dispatch page when authenticated", async () => {
    renderAt("/dispatch");
    expect(
      await screen.findByRole("heading", { name: "작업지시 목록", level: 2 }),
    ).toBeVisible();
  });
});

describe("routing", () => {
  it("renders the public KNL storefront home at /", async () => {
    // #6: `/` is now the unauthenticated KNL storefront home (PublicLayout),
    // replacing the previous `/`→`/dispatch` redirect. The header carries the
    // public nav; the page shows the tightened one-stop hero title.
    renderAt("/");
    expect(
      (await screen.findAllByText("지게차 렌탈·정비·운영을 하나로"))[0],
    ).toBeVisible();
    expect(screen.queryByText(/급한 경우/)).not.toBeInTheDocument();
  });

  it("shows the public cookie notice until acknowledged", async () => {
    const user = userEvent.setup();
    renderAt("/");

    const notice = await screen.findByRole("region", { name: "쿠키 안내" });
    expect(notice).toBeVisible();
    expect(
      within(notice).getByRole("link", { name: "자세히 보기" }),
    ).toHaveAttribute("href", "/privacy");

    await user.click(within(notice).getByRole("button", { name: "확인" }));

    await waitFor(() => {
      expect(
        screen.queryByRole("region", { name: "쿠키 안내" }),
      ).not.toBeInTheDocument();
    });
  });

  it("renders the public privacy notice page", async () => {
    renderAt("/privacy");
    expect(
      await screen.findByRole("heading", {
        name: "개인정보·쿠키 안내",
        level: 1,
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "초기 로그인 필수 동의", level: 2 }),
    ).toBeVisible();
  });

  it("renders footer legal/version text and family-site links", async () => {
    renderAt("/");

    expect(await screen.findByText(/© \d{4} KNL/)).toBeVisible();
    expect(screen.getByText(/버전 v\d+\.\d+\.\d+/)).toBeVisible();
    expect(screen.getByRole("link", { name: "COSS" })).toHaveAttribute(
      "href",
      "https://www.cossok.com/",
    );
    expect(
      screen.getByRole("link", { name: "Bestec Family Site" }),
    ).toHaveAttribute("href", "https://www.bestec-kr.com/");
  });

  it("renders the public /platform-fsm showcase", async () => {
    // The FSM-platform marketing page mounts inside PublicLayout at
    // /platform-fsm (the gated console owns /platform). Its hero reuses the
    // landing.* copy, so the landing hero title renders as the page H1.
    renderAt("/platform-fsm");
    expect(
      await screen.findByRole("heading", {
        name: "접수부터 배차·현장 정비·정산·KPI까지, 하나의 콘솔로",
        level: 1,
      }),
    ).toBeVisible();
  });

  it("renders /intake page", async () => {
    renderAt("/intake");
    expect(
      await screen.findByRole("heading", { name: "접수 입력", level: 1 }),
    ).toBeVisible();
  });

  it("renders /approvals page", async () => {
    // /approvals is admin-only (RequireAdminRoute) — render with an admin session.
    renderAt("/approvals", adminSession);
    expect(
      await screen.findByRole("heading", { name: "승인 대기", level: 1 }),
    ).toBeVisible();
  });

  it("renders /kpi page", async () => {
    // /kpi is KpiRead-gated (RequireKpiRoute) — render with a KpiRead role.
    renderAt("/kpi", adminSession);
    expect(
      await screen.findByRole("heading", { name: "임원 KPI 대시보드", level: 1 }),
    ).toBeVisible();
  });

  it("renders /messenger page", async () => {
    renderAt("/messenger");
    expect(
      await screen.findByRole("heading", { name: "메신저", level: 1 }),
    ).toBeVisible();
  });

  it("renders /wallboard outside the shell", async () => {
    renderAt("/wallboard");
    expect(
      await screen.findByRole("heading", { name: "일일현황 월보드" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "로그인" }),
    ).not.toBeInTheDocument();
  });

  it("redirects unknown paths to /dispatch", async () => {
    renderAt("/does-not-exist");
    expect(
      await screen.findByRole("heading", { name: "작업지시 목록" }),
    ).toBeVisible();
  });
});

describe("DispatchPage", () => {
  it("loads the work order list from the read API", async () => {
    renderAt("/dispatch");
    expect(
      (await screen.findAllByText("20260612-001"))[0],
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "작업지시 목록" }),
    ).toBeVisible();
    expect(screen.getAllByText(/Acme Corporation/)[0]).toBeVisible();

    await waitFor(() => {
      expect(
        listRequests.some(
          (url) =>
            url.pathname === "/api/v1/work-orders" &&
            !url.search.includes("status"),
        ),
      ).toBe(true);
    });
  });
});

describe("ApprovalsPage", () => {
  it("loads approval queue with status filter", async () => {
    renderAt("/approvals", adminSession);

    await waitFor(() => {
      expect(
        listRequests.some(
          (url) =>
            url.pathname === "/api/v1/work-orders" &&
            url.search.includes("REPORT_SUBMITTED") &&
            url.search.includes("ADMIN_REVIEW"),
        ),
      ).toBe(true);
    });
  });

  it("posts reject memo through the per-order reject dialog", async () => {
    const user = userEvent.setup();
    renderAt("/approvals", adminSession);

    expect((await screen.findAllByText("20260612-002"))[0]).toBeVisible();
    // The row's 반려 opens a dialog scoped to THAT order; the memo lives in the
    // dialog so it can never be applied to a different order.
    await user.click(
      screen.getByRole("button", { name: "20260612-002 반려" }),
    );
    const dialog = screen.getByRole("dialog");
    await user.type(
      within(dialog).getByLabelText("반려 메모"),
      "증빙 보완 필요",
    );
    await user.click(within(dialog).getByRole("button", { name: "반려" }));

    await waitFor(() => {
      expect(rejectRequest?.url.pathname).toBe(
        `/api/v1/work-orders/${workOrderListItems[1].id}/reject`,
      );
      expect(rejectRequest?.body).toEqual({ memo: "증빙 보완 필요" });
    });
  });
});

describe("KpiPage", () => {
  it("loads kpi report with the default period", async () => {
    // /kpi is KpiRead-gated (RequireKpiRoute) — render with a KpiRead role.
    renderAt("/kpi", adminSession);

    await waitFor(() => {
      expect(
        kpiRequests.some(
          (url) =>
            url.pathname === "/api/v1/kpi" &&
            url.searchParams.get("period") === getDefaultKpiPeriod(),
        ),
      ).toBe(true);
    });
  });
});

describe("OpsDashboardPage", () => {
  it("renders the ops summary for an admin session", async () => {
    renderAt("/ops", adminSession);

    expect(
      await screen.findByRole("heading", { name: "운영 대시보드", level: 1 }),
    ).toBeVisible();
    // Funnel value (completed = 5) and a mechanic-load row render.
    expect(await screen.findByText("김정비")).toBeVisible();
    // The aging-alert tile renders the configured hour threshold.
    expect(screen.getByText("24시간 초과 미해결")).toBeVisible();
  });

  it("redirects a mechanic away from /ops (role-gated)", async () => {
    renderAt("/ops", mechanicSession);

    // RequireAdminRoute bounces a non-admin to /dispatch.
    expect(
      await screen.findByRole("heading", { name: "작업지시 목록" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "운영 대시보드" }),
    ).not.toBeInTheDocument();
  });
});

describe("IntakePage", () => {
  it("uses equipment autocomplete and lookup when the intake 호기 changes", async () => {
    const user = userEvent.setup();
    renderAt("/intake");

    await user.type(screen.getByLabelText(/호기/), "#290");

    expect((await screen.findAllByText("GTS25DE"))[0]).toBeVisible();
    expect(await screen.findByText("케이앤엘")).toBeVisible();

    await waitFor(() => {
      expect(
        autocompleteRequests.some(
          (url) =>
            url.pathname === "/api/v1/equipment" &&
            url.searchParams.get("q") === "#290",
        ),
      ).toBe(true);
      expect(
        lookupRequests.some(
          (url) =>
            url.pathname === "/api/v1/equipment/lookup" &&
            url.searchParams.get("management_no") === "#290",
        ),
      ).toBe(true);
    });
  });
});
