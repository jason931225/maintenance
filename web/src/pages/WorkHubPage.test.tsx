import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createConsoleApiClient } from "../api/client";
import { AuthContext } from "../context/auth";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { branchId, primaryMechanicId, workOrderListItems } from "../test/fixtures";
import { WorkHubPage } from "./WorkHubPage";

const workOrderListRequests: URL[] = [];
const approvalItemRequests: URL[] = [];

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
  workOrderListRequests.length = 0;
  approvalItemRequests.length = 0;
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

function renderPage(session: AuthSession) {
  return render(
    <AuthContext.Provider value={makeAuthContext(session)}>
      <MemoryRouter>
        <WorkHubPage />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

const requestedPlanId = "44444444-4444-4444-8444-444444444444";
const targetChangeId = "66666666-6666-4666-8666-666666666666";
const testTenantId = "99999999-0000-4000-8000-999999999999";

function approvalContext(source: "WORK_ORDER" | "DAILY_PLAN" | "TARGET_CHANGE", sourceId: string) {
  const contexts = {
    WORK_ORDER: {
      workflow_key: "work_order.report_completion_review",
      action_key: "approve_work_order",
      required_features: ["completion_review"],
    },
    DAILY_PLAN: {
      workflow_key: "daily_plan.review",
      action_key: "review_daily_plan",
      required_features: ["daily_plan_review"],
    },
    TARGET_CHANGE: {
      workflow_key: "work_order.target_change_review",
      action_key: "review_target_change",
      required_features: ["target_manage"],
    },
  }[source];
  return {
    ontology: {
      object_type: source,
      object_id: sourceId,
      tenant_id: testTenantId,
      branch_id: branchId,
    },
    workflow: {
      workflow_key: contexts.workflow_key,
      action_key: contexts.action_key,
    },
    policy: {
      decision: "ALLOWED",
      enforcement: "server",
      required_features: contexts.required_features,
      scope_kind: "BRANCH",
      scope_id: branchId,
    },
  };
}

function federatedApprovalPayload() {
  const workOrder = workOrderListItems[1];
  return {
    items: [
      {
        id: `WORK_ORDER:${workOrder.id}`,
        source: "WORK_ORDER",
        source_id: workOrder.id,
        branch_id: workOrder.branch_id,
        status: workOrder.status,
        title: `${workOrder.request_no} 작업 보고 승인`,
        summary: workOrder.equipment.model,
        requested_at: workOrder.created_at,
        due_at: workOrder.target_due_at,
        href: `/approvals?source=work-order&focus=${workOrder.id}`,
        action_href: `/api/work-orders/${workOrder.id}/approve`,
        ...approvalContext("WORK_ORDER", workOrder.id),
        work_order: workOrder,
      },
      {
        id: `DAILY_PLAN:${requestedPlanId}`,
        source: "DAILY_PLAN",
        source_id: requestedPlanId,
        branch_id: branchId,
        status: "REQUESTED",
        title: "2026-06-29 계획업무 검토",
        summary: "계획업무 검토 요청",
        requested_at: "2026-06-28T01:00:00Z",
        due_at: "2026-06-29T00:00:00Z",
        href: `/daily-plan?planId=${requestedPlanId}`,
        action_href: `/api/daily-work-plans/${requestedPlanId}/review`,
        ...approvalContext("DAILY_PLAN", requestedPlanId),
        daily_plan: {
          id: requestedPlanId,
          branch_id: branchId,
          mechanic_id: primaryMechanicId,
          plan_date: "2026-06-29",
          status: "REQUESTED",
        },
      },
      {
        id: `TARGET_CHANGE:${targetChangeId}`,
        source: "TARGET_CHANGE",
        source_id: targetChangeId,
        branch_id: branchId,
        status: "REQUESTED",
        title: "일정 변경 요청",
        summary: "목표 완료 변경 검토",
        requested_at: "2026-06-28T02:00:00Z",
        due_at: "2026-07-05T00:00:00Z",
        href: `#target-change-${targetChangeId}`,
        action_href: `/api/target-change-requests/${targetChangeId}/review`,
        ...approvalContext("TARGET_CHANGE", targetChangeId),
        target_change: {
          id: targetChangeId,
          work_order_id: workOrder.id,
          branch_id: branchId,
          requested_target_due_at: "2026-07-05T00:00:00Z",
          status: "REQUESTED",
        },
      },
    ],
    sources: [
      { key: "workOrders", label: "작업 보고", status: "ok", count: 1 },
      { key: "dailyPlans", label: "계획업무", status: "ok", count: 1 },
      { key: "targetChanges", label: "일정 변경", status: "ok", count: 1 },
    ],
    limit: 50,
    offset: 0,
    total: 3,
  };
}

function installHappyHandlers() {
  server.use(
    http.get("*/api/v1/work-orders", ({ request }) => {
      const url = new URL(request.url);
      workOrderListRequests.push(url);
      const statusFilter = url.searchParams
        .getAll("status")
        .flatMap((value) => value.split(","));
      if (statusFilter.length > 0) {
        return HttpResponse.json(
          { error: "work hub approvals must use /api/approval-items" },
          { status: 500 },
        );
      }
      const items = statusFilter.length
        ? workOrderListItems.filter((item) => statusFilter.includes(item.status))
        : workOrderListItems.slice(0, 2);
      return HttpResponse.json({ items, limit: 50, offset: 0, total: items.length });
    }),
    http.get("*/api/approval-items", ({ request }) => {
      approvalItemRequests.push(new URL(request.url));
      return HttpResponse.json(federatedApprovalPayload());
    }),
    http.get("*/api/daily-work-plans", () =>
      HttpResponse.json({
        items: [
          {
            id: "44444444-4444-4444-8444-444444444444",
            branch_id: branchId,
            mechanic_id: primaryMechanicId,
            plan_date: "2026-06-28",
            status: "REQUESTED",
          },
        ],
      }),
    ),
    http.get("*/api/messenger/threads", () =>
      HttpResponse.json({
        items: [
          {
            id: "55555555-5555-4555-8555-555555555555",
            kind: "work_order",
            branch_id: branchId,
            title: "P1 현장 대화",
            work_order_id: workOrderListItems[0].id,
            last_message_id: "66666666-6666-4666-8666-666666666666",
            last_message_at: "2026-06-28T02:00:00Z",
            unread_count: 1,
            member_count: 4,
            created_at: "2026-06-28T01:00:00Z",
            updated_at: "2026-06-28T02:00:00Z",
          },
        ],
      }),
    ),
    http.get("*/api/v1/support/tickets", () =>
      HttpResponse.json({
        items: [
          {
            id: "77777777-7777-4777-8777-777777777777",
            branch_id: "11111111-1111-4111-8111-111111111111",
            origin: "INTERNAL",
            category: "OPERATIONAL",
            priority: "URGENT",
            status: "OPEN",
            title: "부품 입고 확인",
            requester_user_id: "88888888-8888-4888-8888-888888888888",
            requester_name: "김관리",
            assignee_user_id: "99999999-9999-4999-8999-999999999999",
            assignee_name: null,
            due_at: "2026-06-28T05:00:00Z",
            created_at: "2026-06-28T01:00:00Z",
            updated_at: "2026-06-28T01:30:00Z",
            resolved_at: null,
            closed_at: null,
          },
        ],
        next_cursor: null,
        total: 1,
      }),
    ),
  );
}

describe("WorkHubPage", () => {
  it("renders an actionable group-wide priority inbox without explanatory text walls", async () => {
    installHappyHandlers();

    renderPage({
      access_token: "admin-token",
      roles: ["ADMIN"],
      branches: [branchId],
    });

    expect(screen.getByText("업무 허브")).toBeVisible();
    expect(await screen.findByText("20260612-002 작업 보고 승인")).toBeVisible();
    const sourceSummary = document.querySelector<HTMLElement>('section[aria-label="업무 원천 요약"]');
    if (!sourceSummary) {
      throw new Error("업무 원천 요약 영역을 찾을 수 없습니다.");
    }
    expect(sourceSummary).toHaveClass("md:flex-row");
    expect(sourceSummary.querySelector(".min-h-36")).toBeNull();
    expect(sourceSummary.querySelector(".text-3xl")).toBeNull();
    expect(sourceSummary.querySelector(".truncate")).toBeNull();
    const workModuleLink = sourceSummary.querySelector<HTMLAnchorElement>('a[href="/dispatch"]');
    if (!workModuleLink) {
      throw new Error("업무·운영 모듈 링크를 찾을 수 없습니다.");
    }
    expect(workModuleLink).toHaveAttribute("aria-label", "업무·운영 2건 모듈 열기");
    const dashboard = screen.getByRole("region", { name: "업무 허브 요약 대시보드" });
    const dashboardWorkLink = dashboard.querySelector<HTMLAnchorElement>(
      'a[href="/work-orders/77777777-7777-4777-8777-777777777777"]',
    );
    if (!dashboardWorkLink) {
      throw new Error("요약 대시보드의 작업지시 링크를 찾을 수 없습니다.");
    }
    expect(dashboardWorkLink).toHaveTextContent("20260612-002");
    const workCodeLink = screen
      .queryAllByRole("link", { name: "20260612-002" })
      .find((link) => link.getAttribute("href") === "/work-orders/77777777-7777-4777-8777-777777777777");
    if (!workCodeLink) {
      throw new Error("작업지시 코드 링크 칩을 찾을 수 없습니다.");
    }
    const workObjectCard = workCodeLink.closest("section");
    if (!workObjectCard) {
      throw new Error("작업지시 개체 카드를 찾을 수 없습니다.");
    }
    const lifecycleChip = within(workObjectCard).getByText("관리자 검토").closest("span");
    const overdueChip = within(workObjectCard).getByText("지연").closest("span");
    if (!lifecycleChip || !overdueChip) {
      throw new Error("작업지시 생애주기/경고 칩을 찾을 수 없습니다.");
    }
    expect(lifecycleChip).toHaveClass("rounded");
    expect(overdueChip).toHaveClass("rounded");
    expect(within(workObjectCard).getByRole("link", { name: "호기·장비 D-30-305" })).toHaveAttribute(
      "href",
      "/equipment/88888888-8888-4888-8888-888888888888",
    );
    expect(within(workObjectCard).getByRole("link", { name: "고객사 Acme Corporation" })).toHaveAttribute(
      "href",
      "/dispatch?customer_id=99999999-9999-4999-8999-999999999999",
    );
    expect(within(workObjectCard).getByRole("link", { name: "사업장 인천센터" })).toHaveAttribute(
      "href",
      "/dispatch?site_id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    expect(within(workObjectCard).queryByText(/D-30-305 · 관리자 검토/)).not.toBeInTheDocument();
    expect(screen.getByText("2026-06-29 계획업무 검토")).toBeVisible();
    expect(screen.getAllByText("일정 변경 요청").length).toBeGreaterThan(0);
    expect(screen.queryByText("P1 현장 대화")).not.toBeInTheDocument();
    expect(screen.getAllByText("부품 입고 확인").length).toBeGreaterThan(0);
    expect(
      screen.queryByText("팀·그룹 범위의 업무, 승인, 계획, 티켓을 하나의 실행 큐로 묶어 보여줍니다."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("마감·지연·승인·지원 티켓을 우선순위 순서로 표시합니다."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("긴급·지연 3건을 포함해 바로 처리할 항목입니다."),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("작업 목표일과 계획업무 일정을 시간순으로 표시합니다.")).not.toBeInTheDocument();
    expect(screen.queryByText("현재 범위의 업무 2건을 compact하게 표시합니다.")).not.toBeInTheDocument();
    expect(screen.queryByText("먼저 처리")).not.toBeInTheDocument();
    expect(screen.queryByText("결정 필요")).not.toBeInTheDocument();
    expect(screen.queryByText("업무 객체 중심 실행 흐름")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/허브는 메신저·메일·티켓을 별도 데모로 분리하지 않고/),
    ).not.toBeInTheDocument();
    const priorityQueue = document.getElementById("work-hub-priority-title")?.closest("section");
    if (!priorityQueue) {
      throw new Error("우선순위 액션 큐 영역을 찾을 수 없습니다.");
    }
    expect(priorityQueue).not.toHaveClass("bg-ink");
    expect(priorityQueue).not.toHaveClass("text-white");
    expect(screen.getByText("팀·그룹 범위")).toBeVisible();
    const urgentButton = screen.getByText("지연·긴급").closest("button");
    const approvalButton = screen
      .getAllByText("승인·검토")
      .map((label) => label.closest("button"))
      .find((button): button is HTMLButtonElement => button !== null);
    if (!urgentButton || !approvalButton) {
      throw new Error("우선순위 필터 버튼을 찾을 수 없습니다.");
    }
    expect(urgentButton).toHaveAttribute("aria-label", "지연·긴급 3건 보기");
    expect(approvalButton).toHaveAttribute("aria-label", "승인·검토 3건 보기");
    expect(screen.queryByText("대화")).not.toBeInTheDocument();
    const approvalLinks = screen.getAllByText("승인센터에서 검토").map((link) => link.closest("a"));
    const approvalHrefs = approvalLinks.map((link) => link?.getAttribute("href"));
    expect(approvalHrefs).toContain(
      "/approvals?source=work-order&focus=77777777-7777-4777-8777-777777777777",
    );
    expect(approvalHrefs).toContain(
      `/approvals#target-change-${targetChangeId}`,
    );
    expect(
      screen
        .getAllByText("계획업무 열기")
        .some(
          (link) => link.closest("a")?.getAttribute("href") === `/daily-plan?planId=${requestedPlanId}`,
        ),
    ).toBe(true);
    const supportActionCard = screen.getByText("티켓 열기").closest("a")?.closest("section");
    if (!supportActionCard) {
      throw new Error("지원 티켓 액션 카드를 찾을 수 없습니다.");
    }
    expect(supportActionCard.className).not.toMatch(/\bborder-l/);
    expect(supportActionCard).toHaveClass("bg-red-50");

    fireEvent.click(urgentButton);

    expect(screen.getAllByText("Acme Corporation / 인천센터").length).toBeGreaterThan(0);
    expect(screen.getAllByText("부품 입고 확인").length).toBeGreaterThan(0);
    expect(screen.queryByText("P1 현장 대화")).not.toBeInTheDocument();
    expect(screen.queryByText("20260612-002 작업 보고 승인")).not.toBeInTheDocument();

    const approvalFilterButton = screen
      .getAllByText("승인")
      .map((label) => label.closest("button"))
      .find((button): button is HTMLButtonElement => button !== null);
    if (!approvalFilterButton) {
      throw new Error("승인 필터 버튼을 찾을 수 없습니다.");
    }
    fireEvent.click(approvalFilterButton);

    expect(screen.getByText("20260612-002 작업 보고 승인")).toBeVisible();
    expect(screen.getByText("2026-06-29 계획업무 검토")).toBeVisible();
    expect(screen.getAllByText("일정 변경 요청").length).toBeGreaterThan(0);
    const actionInbox = document.getElementById("work-hub-inbox-title")?.closest("section");
    if (!actionInbox) {
      throw new Error("액션 인박스 영역을 찾을 수 없습니다.");
    }
    expect(
      within(actionInbox).queryByText("부품 입고 확인"),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(approvalItemRequests).toHaveLength(1);
      expect(approvalItemRequests[0].searchParams.get("limit")).toBe("50");
      expect(approvalItemRequests[0].searchParams.get("offset")).toBe("0");
      expect(
        workOrderListRequests.some((url) => url.searchParams.has("status")),
      ).toBe(false);
    });
  }, 20_000);

  it("excludes terminal support tickets from the action inbox", async () => {
    installHappyHandlers();
    server.use(
      http.get("*/api/v1/support/tickets", () =>
        HttpResponse.json({
          items: [
            {
              id: "77777777-7777-4777-8777-777777777777",
              branch_id: "11111111-1111-4111-8111-111111111111",
              origin: "INTERNAL",
              category: "OPERATIONAL",
              priority: "URGENT",
              status: "OPEN",
              title: "부품 입고 확인",
              requester_user_id: "88888888-8888-4888-8888-888888888888",
              requester_name: "김관리",
              assignee_user_id: null,
              assignee_name: null,
              due_at: "2026-06-28T05:00:00Z",
              created_at: "2026-06-28T01:00:00Z",
              updated_at: "2026-06-28T01:30:00Z",
              resolved_at: null,
              closed_at: null,
            },
            {
              id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              branch_id: "11111111-1111-4111-8111-111111111111",
              origin: "INTERNAL",
              category: "OPERATIONAL",
              priority: "NORMAL",
              status: "CLOSED",
              title: "이미 닫힌 요청",
              requester_user_id: "88888888-8888-4888-8888-888888888888",
              requester_name: "김관리",
              assignee_user_id: null,
              assignee_name: null,
              due_at: null,
              created_at: "2026-06-27T01:00:00Z",
              updated_at: "2026-06-27T03:00:00Z",
              resolved_at: "2026-06-27T02:00:00Z",
              closed_at: "2026-06-27T03:00:00Z",
            },
            {
              id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              branch_id: "11111111-1111-4111-8111-111111111111",
              origin: "INTERNAL",
              category: "OPERATIONAL",
              priority: "NORMAL",
              status: "RESOLVED",
              title: "이미 해결된 요청",
              requester_user_id: "88888888-8888-4888-8888-888888888888",
              requester_name: "김관리",
              assignee_user_id: null,
              assignee_name: null,
              due_at: null,
              created_at: "2026-06-27T01:00:00Z",
              updated_at: "2026-06-27T02:00:00Z",
              resolved_at: "2026-06-27T02:00:00Z",
              closed_at: null,
            },
          ],
          next_cursor: null,
          total: 3,
        }),
      ),
    );

    renderPage({
      access_token: "admin-token",
      roles: ["ADMIN"],
      branches: [branchId],
    });

    await screen.findAllByText("부품 입고 확인");
    expect(screen.queryByText("이미 닫힌 요청")).not.toBeInTheDocument();
    expect(screen.queryByText("이미 해결된 요청")).not.toBeInTheDocument();
  });

  it("does not keep an already-read messenger thread in the action inbox", async () => {
    installHappyHandlers();
    server.use(
      http.get("*/api/messenger/threads", () =>
        HttpResponse.json({
          items: [
            {
              id: "55555555-5555-4555-8555-555555555555",
              kind: "dm",
              branch_id: branchId,
              title: "이운창 현장 확인",
              work_order_id: null,
              last_message_id: "66666666-6666-4666-8666-666666666666",
              last_message_at: "2026-06-28T02:00:00Z",
              unread_count: 0,
              member_count: 2,
              created_at: "2026-06-28T01:00:00Z",
              updated_at: "2026-06-28T02:00:00Z",
            },
          ],
        }),
      ),
    );

    renderPage({
      access_token: "admin-token",
      roles: ["ADMIN"],
      branches: [branchId],
    });

    expect(await screen.findByRole("heading", { name: "업무 허브", level: 1 })).toBeVisible();
    expect(screen.queryByRole("button", { name: /대화/ })).not.toBeInTheDocument();
    expect(screen.queryByText("이운창 현장 확인")).not.toBeInTheDocument();
  });

  it("surfaces unread non-work-order messenger threads as conversation actions", async () => {
    installHappyHandlers();
    server.use(
      http.get("*/api/messenger/threads", () =>
        HttpResponse.json({
          items: [
            {
              id: "99999999-9999-4999-8999-999999999999",
              kind: "dm",
              branch_id: branchId,
              title: "이운창 현장 확인",
              work_order_id: null,
              last_message_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              last_message_at: "2026-06-28T02:00:00Z",
              unread_count: 2,
              member_count: 2,
              created_at: "2026-06-28T01:00:00Z",
              updated_at: "2026-06-28T02:00:00Z",
            },
          ],
        }),
      ),
    );

    renderPage({
      access_token: "admin-token",
      roles: ["ADMIN"],
      branches: [branchId],
    });

    expect(await screen.findByText("이운창 현장 확인")).toBeVisible();
    expect(screen.getByText("읽지 않음 2건")).toBeVisible();
    expect(screen.getByRole("link", { name: "메신저 열기" })).toHaveAttribute(
      "href",
      "/messenger?thread=99999999-9999-4999-8999-999999999999",
    );
  }, 20_000);

  it("does not render protocol-relative approval links from server payloads", async () => {
    installHappyHandlers();
    server.use(
      http.get("*/api/approval-items", ({ request }) => {
        approvalItemRequests.push(new URL(request.url));
        const payload = federatedApprovalPayload();
        const unsafeDailyPlan = {
          ...payload.items[1],
          title: "외부 링크 시도",
          href: "//evil.example/phish",
        };
        return HttpResponse.json({
          ...payload,
          items: [unsafeDailyPlan],
          total: 1,
        });
      }),
    );

    renderPage({
      access_token: "admin-token",
      roles: ["ADMIN"],
      branches: [branchId],
    });

    const unsafeCard = (await screen.findAllByText("외부 링크 시도"))
      .map((element) => element.closest("section"))
      .find((section) => section?.querySelector('a[href="/daily-plan"]'));
    expect(unsafeCard).toBeDefined();
    expect(
      unsafeCard?.querySelector<HTMLAnchorElement>('a[href="//evil.example/phish"]'),
    ).toBeNull();
    expect(
      unsafeCard?.querySelector<HTMLAnchorElement>('a[href="/daily-plan"]'),
    ).not.toBeNull();
  });

  it("keeps a mechanic dashboard scoped to assigned work and hides admin-only modules", async () => {
    installHappyHandlers();

    renderPage({
      access_token: "mechanic-token",
      roles: ["MECHANIC"],
      branches: [branchId],
    });

    expect(await screen.findByRole("heading", { name: "업무 허브", level: 1 })).toBeVisible();
    expect(
      screen.queryByText("내 업무, 계획, 티켓을 하루·주간 실행 흐름으로 묶어 보여줍니다."),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "오늘의 중점사항" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "개인 업무 캘린더" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "개인별 업무 요약" })).toBeVisible();
    expect(screen.getAllByText(/20260612-001/).length).toBeGreaterThan(0);
    expect(screen.getByText("내 업무 범위")).toBeVisible();

    await waitFor(() => {
      expect(
        workOrderListRequests.some((url) => url.searchParams.get("assigned_to") === "me"),
      ).toBe(true);
    });
    expect(
      workOrderListRequests.some((url) => url.search.includes("REPORT_SUBMITTED")),
    ).toBe(false);
    expect(approvalItemRequests).toHaveLength(0);
    expect(screen.queryByText("현재 권한에서 표시되지 않는 영역입니다.")).not.toBeInTheDocument();
  });

  it("keeps loaded sources visible when one collaboration source fails", async () => {
    installHappyHandlers();
    server.use(
      http.get("*/api/v1/support/tickets", () =>
        HttpResponse.json({ error: "offline" }, { status: 503 }),
      ),
    );

    renderPage({
      access_token: "admin-token",
      roles: ["ADMIN"],
      branches: [branchId],
    });

    expect(await screen.findByText(/일부 원천을 불러오지 못했습니다/)).toBeVisible();
    expect(await screen.findByText("20260612-002 작업 보고 승인")).toBeVisible();
    expect(screen.queryByText("이 화면을 표시하지 못했습니다.")).not.toBeInTheDocument();
  });

  it("shows a full error when every requested source fails, ignoring hidden skipped modules", async () => {
    server.use(
      http.get("*/api/v1/work-orders", () =>
        HttpResponse.json({ error: "offline" }, { status: 503 }),
      ),
      http.get("*/api/messenger/threads", () =>
        HttpResponse.json({ error: "offline" }, { status: 503 }),
      ),
      http.get("*/api/v1/support/tickets", () =>
        HttpResponse.json({ error: "offline" }, { status: 503 }),
      ),
    );

    renderPage({
      access_token: "receptionist-token",
      roles: ["RECEPTIONIST"],
      branches: [branchId],
    });

    expect(await screen.findByText("데이터를 불러오지 못했습니다.")).toBeVisible();
  });
});
