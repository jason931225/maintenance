import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  it("renders a workflow-first action inbox with approval, plan, message, and support links", async () => {
    const user = userEvent.setup();
    installHappyHandlers();

    renderPage({
      access_token: "admin-token",
      roles: ["ADMIN"],
      branches: [branchId],
    });

    expect(
      await screen.findByRole("heading", { name: "업무 허브", level: 1 }),
    ).toBeVisible();
    expect(screen.getByText("업무 객체 중심 실행 흐름")).toBeVisible();
    expect(await screen.findByText("20260612-002 작업 보고 승인")).toBeVisible();
    expect(screen.getByText("2026-06-29 계획업무 검토")).toBeVisible();
    expect(screen.getByText("일정 변경 요청")).toBeVisible();
    expect(screen.getByText("P1 현장 대화")).toBeVisible();
    expect(screen.getByText("부품 입고 확인")).toBeVisible();
    const workflowRail = screen.getByRole("region", {
      name: "업무 객체 중심 실행 흐름",
    });
    expect(workflowRail).toHaveClass("bg-brand-teal/5");
    expect(workflowRail).not.toHaveClass("bg-ink");
    expect(workflowRail).not.toHaveClass("text-white");
    const approvalLinks = screen.getAllByRole("link", { name: "승인센터에서 검토" });
    const approvalHrefs = approvalLinks.map((link) => link.getAttribute("href"));
    expect(approvalHrefs).toContain(
      "/approvals?source=work-order&focus=77777777-7777-4777-8777-777777777777",
    );
    expect(approvalHrefs).toContain(`/daily-plan?planId=${requestedPlanId}`);
    expect(approvalHrefs).toContain(
      `/approvals#target-change-${targetChangeId}`,
    );
    expect(screen.getByRole("link", { name: "작업·배차 모듈 열기" })).toHaveAttribute(
      "href",
      "/dispatch",
    );

    await user.click(screen.getByRole("button", { name: "승인" }));

    expect(screen.getByText("20260612-002 작업 보고 승인")).toBeVisible();
    expect(screen.getByText("2026-06-29 계획업무 검토")).toBeVisible();
    expect(screen.getByText("일정 변경 요청")).toBeVisible();
    expect(screen.queryByText("부품 입고 확인")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(approvalItemRequests).toHaveLength(1);
      expect(approvalItemRequests[0].searchParams.get("limit")).toBe("50");
      expect(approvalItemRequests[0].searchParams.get("offset")).toBe("0");
      expect(
        workOrderListRequests.some((url) => url.searchParams.has("status")),
      ).toBe(false);
    });
  });

  it("excludes closed support tickets from the action inbox", async () => {
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
          ],
          next_cursor: null,
          total: 2,
        }),
      ),
    );

    renderPage({
      access_token: "admin-token",
      roles: ["ADMIN"],
      branches: [branchId],
    });

    expect(await screen.findByText("부품 입고 확인")).toBeVisible();
    expect(screen.queryByText("이미 닫힌 요청")).not.toBeInTheDocument();
  });

  it("keeps a mechanic dashboard scoped to assigned work and hides admin-only modules", async () => {
    installHappyHandlers();

    renderPage({
      access_token: "mechanic-token",
      roles: ["MECHANIC"],
      branches: [branchId],
    });

    expect(await screen.findByText("내 작업, 계획업무, 대화, 티켓을 하루·주간 실행 흐름으로 묶어 보여줍니다.")).toBeVisible();

    await waitFor(() => {
      expect(
        workOrderListRequests.some((url) => url.searchParams.get("assigned_to") === "me"),
      ).toBe(true);
    });
    expect(
      workOrderListRequests.some((url) => url.search.includes("REPORT_SUBMITTED")),
    ).toBe(false);
    expect(approvalItemRequests).toHaveLength(0);
    expect(screen.getAllByText("현재 권한에서 표시되지 않는 영역입니다.").length).toBeGreaterThan(0);
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
