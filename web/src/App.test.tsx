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
  supportTicketPage,
  tokenPair,
  workOrderLens,
  workOrderListItems,
  workOrders,
} from "./test/fixtures";

// ── MSW handlers ──────────────────────────────────────────────────────────────

const listRequests: URL[] = [];
const approvalRequests: URL[] = [];
const kpiRequests: URL[] = [];
const autocompleteRequests: URL[] = [];
const lookupRequests: URL[] = [];
const storefrontInquiryRequests: unknown[] = [];
let createWorkOrderRequest: unknown;
let rejectRequest: { url: URL; body: unknown } | undefined;
const activeBranchId = "00000000-0000-4000-8000-000000000001";
const publicListingId = "cccccccc-3333-4333-8333-cccccccccccc";
const publicListingModelName = "공개매물-E2E-전동지게차";
const homeDailyPlan = {
  id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
  branch_id: activeBranchId,
  mechanic_id: "00000000-0000-4000-8000-000000000099",
  plan_date: "2026-06-16",
  status: "REQUESTED",
};
const homeSupportTicket = {
  id: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
  branch_id: activeBranchId,
  origin: "CUSTOMER",
  category: "OPERATIONAL",
  priority: "URGENT",
  status: "OPEN",
  title: "출고 일정 확인 요청",
  requester_user_id: "00000000-0000-4000-8000-0000000000aa",
  requester_name: "고객사",
  assignee_user_id: "00000000-0000-4000-8000-0000000000bb",
  assignee_name: null,
  due_at: "2026-06-12T12:00:00Z",
  created_at: "2026-06-12T08:00:00Z",
  updated_at: "2026-06-12T08:00:00Z",
  resolved_at: null,
  closed_at: null,
} as const;

const messengerWs = ws.link("ws://localhost:3000/api/v1/ws*");

function approvalContext(source: "WORK_ORDER", objectId: string, branchId: string) {
  return {
    ontology: {
      object_type: source,
      object_id: objectId,
      tenant_id: "00000000-0000-4000-8000-000000000099",
      branch_id: branchId,
    },
    workflow: {
      workflow_key: "work_order.report_completion_review",
      action_key: "approve_work_order",
    },
    policy: {
      decision: "ALLOWED",
      enforcement: "server",
      required_features: ["completion_review"],
      scope_kind: "BRANCH",
      scope_id: branchId,
    },
  } as const;
}

function approvalItemsPage() {
  const workOrderApprovals = workOrderListItems.filter((workOrder) =>
    ["REPORT_SUBMITTED", "ADMIN_REVIEW"].includes(workOrder.status),
  );
  return {
    items: workOrderApprovals.map((workOrder) => ({
      id: `WORK_ORDER:${workOrder.id}`,
      source: "WORK_ORDER",
      source_id: workOrder.id,
      branch_id: workOrder.branch_id,
      status: workOrder.status,
      title: `${workOrder.request_no} 작업 보고 승인`,
      summary: workOrder.equipment.model ?? workOrder.equipment.equipment_no,
      requested_at: workOrder.created_at,
      due_at: workOrder.target_due_at,
      href: `/approvals?source=work-order&focus=${workOrder.id}`,
      action_href: `/api/work-orders/${workOrder.id}/approve`,
      ...approvalContext("WORK_ORDER", workOrder.id, workOrder.branch_id),
      work_order: workOrder,
    })),
    sources: [
      {
        key: "workOrders",
        label: "작업 보고",
        status: "ok",
        count: workOrderApprovals.length,
      },
    ],
    limit: 100,
    offset: 0,
    total: workOrderApprovals.length,
  };
}

const server = setupServer(
  messengerWs.addEventListener("connection", () => {}),
  http.get("*/api/approval-items", ({ request }) => {
    const url = new URL(request.url);
    approvalRequests.push(url);
    return HttpResponse.json(approvalItemsPage());
  }),
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
      lens: workOrderLens,
    });
  }),
  http.get("*/api/v1/kpi", ({ request }) => {
    const url = new URL(request.url);
    kpiRequests.push(url);
    return HttpResponse.json(kpiReport);
  }),
  http.get("*/api/v1/ops/summary", () => HttpResponse.json(opsSummary)),
  http.get("*/api/daily-work-plans", () =>
    HttpResponse.json({ items: [homeDailyPlan] }),
  ),
  http.get("*/api/v1/support/tickets", () =>
    HttpResponse.json(supportTicketPage([homeSupportTicket])),
  ),
  http.get("*/api/v1/storefront/listings", () =>
    HttpResponse.json({
      items: [
        {
          id: publicListingId,
          equipment_id: null,
          kind: "ELECTRIC",
          condition: "USED",
          model_name: publicListingModelName,
          capacity_milli: 2500,
          model_year: 2024,
          usage_hours: 120,
          price_won: 18500000,
          badge: "즉시 출고",
          usage_label: "검수 완료",
          condition_label: "중고",
          availability: "상담 가능",
          location: "창원",
          description: "공개 매물 테스트",
          listing_type: "SALE",
          status: "PUBLISHED",
          sort_weight: 10,
          created_at: "2026-06-12T00:00:00Z",
          updated_at: "2026-06-12T00:00:00Z",
          media: [],
        },
      ],
      limit: 24,
      offset: 0,
      total: 1,
    }),
  ),
  http.post("*/api/v1/storefront/inquiries", async ({ request }) => {
    storefrontInquiryRequests.push(await request.json());
    return HttpResponse.json({ status: "accepted" }, { status: 201 });
  }),
  http.get("*/api/v1/branches", () =>
    HttpResponse.json([
      { id: activeBranchId, name: "본사" },
      { id: equipmentLookup.branch_id, name: "지점 B" },
    ]),
  ),
  http.get("*/api/v1/users", () =>
    HttpResponse.json({ items: [], limit: 200, offset: 0, total: 0 }),
  ),
  http.get("*/api/v1/employees", () =>
    HttpResponse.json({
      items: [
        {
          id: "employee-1",
          name: "김현장",
          company: "베스텍",
          employee_number: "B-001",
          org_unit: "물류팀",
          worksite_name: "인천센터",
          job: "정비",
          position: "대리",
          hire_date: "2024-01-02",
          exit_date: null,
          status: "ACTIVE",
          leave_remaining: "7.5",
          identity_resolution_strategy: "employee_number",
          identity_resolution_confidence: "high",
          identity_review_required: false,
          identity_name_only_merge: false,
        },
      ],
      limit: 1000,
      offset: 0,
      total: 1,
    }),
  ),
  http.get("*/api/v1/hr/attendance-summary", () =>
    HttpResponse.json({
      items: [
        {
          user_id: "user-1",
          display_name: "김현장",
          arrivals: 3,
          departures: 2,
          last_kind: "ARRIVAL",
          last_event_at: "2026-07-01T08:00:00Z",
        },
      ],
      limit: 1000,
      offset: 0,
      total: 1,
    }),
  ),
  http.get("*/api/v1/hr/readiness-summary", () =>
    HttpResponse.json(hrReadinessSummary),
  ),
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
  http.post("*/api/work-orders", async ({ request }) => {
    createWorkOrderRequest = await request.json();
    return HttpResponse.json(workOrders[0], { status: 201 });
  }),
  http.get("*/api/messenger/threads", () => HttpResponse.json({ items: [] })),
  http.get("*/api/v1/mail/folders", () => HttpResponse.json([])),
  http.get("*/api/v1/mail/threads", () => HttpResponse.json([])),
  http.get("*/api/v1/me/notifications", () =>
    HttpResponse.json({ items: [], next_cursor: null }),
  ),
  http.get("*/api/v1/me/notifications/unread-count", () =>
    HttpResponse.json({ unread: 0 }),
  ),
  http.post("*/api/v1/work-orders/:workOrderId/reject", async ({ request }) => {
    rejectRequest = { url: new URL(request.url), body: await request.json() };
    return HttpResponse.json({ ...workOrders[1], status: "REJECTED" });
  }),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
  window.localStorage.removeItem("knl_cookie_notice_v1");
  window.localStorage.removeItem("knl_cookie_notice_v2");
  listRequests.length = 0;
  approvalRequests.length = 0;
  kpiRequests.length = 0;
  autocompleteRequests.length = 0;
  lookupRequests.length = 0;
  storefrontInquiryRequests.length = 0;
  createWorkOrderRequest = undefined;
  rejectRequest = undefined;
});
afterAll(() => {
  server.close();
});

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
  branches: [activeBranchId, equipmentLookup.branch_id],
};

const adminSession: AuthSession = {
  ...authenticatedSession,
  roles: ["ADMIN"],
};

const mechanicSession: AuthSession = {
  ...authenticatedSession,
  roles: ["MECHANIC"],
};

const receptionistSession: AuthSession = {
  ...authenticatedSession,
  roles: ["RECEPTIONIST"],
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

const hrReadinessSummary = {
  imports: {
    runs: 2,
    applied_runs: 1,
    input_rows: 14,
    candidate_rows: 2,
    preserved_rows: 12,
    ledger_rows: 14,
    latest_import_at: "2026-07-01T12:00:00Z",
  },
  payroll: {
    draft_runs: 1,
    blocked_runs: 1,
    calculation_enabled_runs: 0,
    draft_lines: 2,
    payroll_source_rows: 8,
    attendance_source_rows: 4,
    attendance_event_links: 3,
    gross_pay_source_lines: 1,
    net_pay_source_lines: 1,
    latest_status: "BLOCKED_LEGAL_GATE",
    latest_source_label: "COSS Group 2026-06 payroll import",
    latest_period_start: "2026-06-01",
    latest_period_end: "2026-06-30",
    latest_updated_at: "2026-07-01T13:00:00Z",
  },
  annual_leave: {
    obligations: 2,
    usage_promotion_required: 1,
    payout_review_required: 0,
    needs_review: 1,
    remaining_days: "7.5",
  },
  attendance: {
    durable_events: 5,
  },
};

function renderAt(
  path: string,
  session: AuthSession | null = authenticatedSession,
) {
  const ctx = makeAuthContext(session ?? undefined);
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
            <Route
              path="/login"
              element={<div data-testid="login-page">login</div>}
            />
            <Route element={<ProtectedRoute />}>
              <Route
                path="/dispatch"
                element={<div data-testid="dispatch-page">dispatch</div>}
              />
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
            <Route
              path="/login"
              element={<div data-testid="login-page">login</div>}
            />
            <Route element={<ProtectedRoute />}>
              <Route
                path="/dispatch"
                element={<div data-testid="dispatch-page">dispatch</div>}
              />
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
  it("renders the protected overview page when authenticated", async () => {
    renderAt("/overview", adminSession);
    expect(
      await screen.findByRole("heading", { name: "통합 개요", level: 1 }),
    ).toBeVisible();
  });

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
      within(notice).getByRole("link", { name: "개인정보 처리방침 보기" }),
    ).toHaveAttribute("href", "/privacy");

    await user.click(
      within(notice).getByRole("button", { name: "확인했습니다" }),
    );

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
        name: "개인정보 처리방침 및 쿠키 정책",
        level: 1,
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "수집·이용 항목과 목적", level: 2 }),
    ).toBeVisible();
    expect(screen.getByText("광고·분석·맞춤형 광고 쿠키")).toBeVisible();
    expect(screen.queryByText(/정식 정책 게시 전/)).not.toBeInTheDocument();
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

  it("routes public used-asset inquiries to the sales inquiry form with listing context", async () => {
    renderAt("/used");

    expect(
      await screen.findByRole("heading", {
        name: publicListingModelName,
        level: 3,
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "상담 접수" }),
    ).toHaveAttribute(
      "href",
      `/contact?listing=${publicListingId}&topic=USED_SALES`,
    );
  });

  it("submits contact-page sales leads to the storefront inquiry queue with topic and listing id", async () => {
    const user = userEvent.setup();
    renderAt(`/contact?topic=USED_SALES&listing=${publicListingId}`);

    expect(
      await screen.findByRole("heading", {
        name: "온라인 견적 문의",
        level: 2,
      }),
    ).toBeVisible();
    expect(screen.getByLabelText("문의 유형")).toHaveValue("USED_SALES");
    expect(
      screen.getByText(
        `선택한 매물 ID ${publicListingId}가 문의와 함께 영업 관리함에 연결됩니다.`,
      ),
    ).toBeVisible();

    await user.type(screen.getByLabelText("이름"), "홍길동");
    await user.type(screen.getByLabelText("연락처"), "010-1111-2222");
    await user.type(screen.getByLabelText("문의 내용"), "매물 상태와 납기 문의");
    await user.click(screen.getByRole("button", { name: "문의 남기기" }));

    await waitFor(() => {
      expect(storefrontInquiryRequests).toHaveLength(1);
    });
    expect(storefrontInquiryRequests[0]).toMatchObject({
      name: "홍길동",
      phone: "010-1111-2222",
      topic: "USED_SALES",
      message: "매물 상태와 납기 문의",
      listing_id: publicListingId,
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "문의가 접수되었습니다.",
    );
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
      await screen.findByRole(
        "heading",
        { name: "전자결제시스템 대기", level: 1 },
        { timeout: 15000 },
      ),
    ).toBeVisible();
  });

  it("renders /kpi page", async () => {
    // /kpi is KpiRead-gated (RequireKpiRoute) — render with a KpiRead role.
    renderAt("/kpi", adminSession);
    expect(
      await screen.findByRole("heading", {
        name: "임원 KPI 대시보드",
        level: 1,
      }),
    ).toBeVisible();
  });

  it("renders /payroll page", async () => {
    renderAt("/payroll", adminSession);
    expect(
      await screen.findByRole("heading", { name: "급여 준비", level: 1 }),
    ).toBeVisible();
    expect(
      await screen.findByRole("heading", { name: "급여 산출 준비도" }),
    ).toBeVisible();
    expect(screen.getByText("COSS Group 2026-06 payroll import")).toBeVisible();
  });

  it("renders /messenger page", async () => {
    renderAt("/messenger");
    expect(
      await screen.findByRole("heading", { name: "메신저", level: 1 }),
    ).toBeVisible();
  });

  it("redirects unauthenticated /wallboard to login before protected data calls", async () => {
    renderAt("/wallboard", null);

    expect(
      await screen.findByRole("heading", { name: "로그인", level: 2 }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "일일현황 월보드" }),
    ).not.toBeInTheDocument();
    expect(listRequests).toHaveLength(0);
    expect(kpiRequests).toHaveLength(0);
  });

  it("renders /wallboard for authenticated users outside the app shell", async () => {
    renderAt("/wallboard", adminSession);
    expect(
      await screen.findByRole("heading", { name: "일일현황 월보드" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "로그인" }),
    ).not.toBeInTheDocument();

    await waitFor(() => {
      expect(listRequests).toHaveLength(1);
      expect(kpiRequests).toHaveLength(1);
    });
    expect(listRequests[0].searchParams.get("limit")).toBe("100");
    expect(kpiRequests[0].searchParams.get("period")).toBe(
      getDefaultKpiPeriod(),
    );
  });

  it("redirects unknown authenticated paths to /overview", async () => {
    renderAt("/does-not-exist", adminSession);
    expect(
      await screen.findByRole("heading", { name: "통합 개요", level: 1 }),
    ).toBeVisible();
  });
});

describe("DispatchPage", () => {
  it("loads the work order list from the read API", async () => {
    renderAt("/dispatch");
    expect((await screen.findAllByText("20260612-001"))[0]).toBeVisible();
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

  it("searches around a work order from the row action", async () => {
    const user = userEvent.setup();
    renderAt("/dispatch");

    expect((await screen.findAllByText("20260612-001"))[0]).toBeVisible();
    listRequests.length = 0;
    await user.click(screen.getAllByRole("link", { name: "주변 검색" })[0]);

    expect(
      screen.getByText("오브젝트 렌즈 필터가 적용되었습니다."),
    ).toBeVisible();
    await waitFor(() => {
      expect(
        listRequests.some(
          (url) =>
            url.pathname === "/api/v1/work-orders" &&
            url.searchParams.get("around_work_order_id") ===
              workOrderListItems[0].id,
        ),
      ).toBe(true);
    });
  });
});

describe("ApprovalsPage", () => {
  it("loads the server-federated approval queue", async () => {
    renderAt("/approvals", adminSession);

    await waitFor(() => {
      expect(
        approvalRequests.some(
          (url) =>
            url.pathname === "/api/approval-items" &&
            url.searchParams.get("limit") === "100" &&
            url.searchParams.get("offset") === "0",
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
    await user.click(screen.getByRole("button", { name: "20260612-002 반려" }));
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
    expect(
      await screen.findByRole("heading", {
        name: "작업지시 오브젝트 렌즈",
        level: 2,
      }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: /P1 긴급/ })).toHaveAttribute(
      "href",
      "/dispatch?priority=P1",
    );
    const receivedLensLink = screen
      .getAllByRole("link", { name: /접수/ })
      .find(
        (link) => link.getAttribute("href") === "/dispatch?status=RECEIVED",
      );
    if (!receivedLensLink) {
      throw new Error("received lens drill link was not rendered");
    }
    expect(receivedLensLink).toHaveAttribute(
      "href",
      "/dispatch?status=RECEIVED",
    );
  });

  it("drills from an object-set lens tile into the dispatch object set", async () => {
    const user = userEvent.setup();
    renderAt("/ops", adminSession);

    const p1Tile = await screen.findByRole("link", { name: /P1 긴급/ });
    listRequests.length = 0;
    await user.click(p1Tile);

    expect(
      await screen.findByRole("heading", { name: "작업지시 목록", level: 2 }),
    ).toBeVisible();
    expect(
      screen.getByText("오브젝트 렌즈 필터가 적용되었습니다."),
    ).toBeVisible();
    await waitFor(() => {
      expect(
        listRequests.some(
          (url) =>
            url.pathname === "/api/v1/work-orders" &&
            url.searchParams.get("priority") === "P1",
        ),
      ).toBe(true);
    });
  });

  it("redirects a mechanic away from /ops (role-gated)", async () => {
    renderAt("/ops", mechanicSession);

    // RequireAdminRoute bounces a non-admin to the authenticated overview.
    expect(
      await screen.findByRole("heading", { name: "통합 개요", level: 1 }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "운영 대시보드" }),
    ).not.toBeInTheDocument();
  });
});

describe("MailPage route guard", () => {
  it("allows MailUse roles to reach the mailbox", async () => {
    renderAt("/mail", receptionistSession);

    expect(
      await screen.findByRole("heading", { name: "메일함", level: 1 }),
    ).toBeVisible();
  });

  it("redirects mechanics away from /mail", async () => {
    renderAt("/mail", mechanicSession);

    expect(
      await screen.findByRole("heading", { name: "통합 개요", level: 1 }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "메일함" }),
    ).not.toBeInTheDocument();
  });
});

describe("IntakePage", () => {
  it("uses equipment autocomplete and lookup when the intake 호기 changes", async () => {
    const user = userEvent.setup();
    renderAt("/intake");

    await screen.findByRole("heading", { name: "접수 입력", level: 1 });
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

  it("submits the selected equipment 호기 with its resolved branch", async () => {
    const user = userEvent.setup();
    renderAt("/intake");

    await screen.findByRole("heading", { name: "접수 입력", level: 1 });
    await user.type(screen.getByLabelText(/호기/), "29");
    await user.click(
      await screen.findByRole("option", { name: /290.*GTS25DE/ }),
    );
    await user.type(screen.getByLabelText(/고장내용/), "시동 불량");
    await user.type(screen.getByLabelText(/정비문의/), "010-1234-5678");
    await user.click(screen.getByRole("button", { name: /접수 저장/ }));

    await waitFor(() => {
      expect(createWorkOrderRequest).toMatchObject({
        branch_id: equipmentLookup.branch_id,
        management_no: "290",
        symptom: "시동 불량",
      });
    });
    expect(
      await screen.findByText(/접수가 저장되었습니다\. 접수번호/),
    ).toBeVisible();
  });
});
