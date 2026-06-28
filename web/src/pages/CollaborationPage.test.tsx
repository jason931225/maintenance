import { render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createConsoleApiClient } from "../api/client";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { AuthContext } from "../context/auth";
import {
  branchId,
  primaryMechanicId,
  supportTicketPage,
  tokenPair,
  workOrderListItems,
} from "../test/fixtures";
import { todayInSeoul } from "../lib/utils";
import { CollaborationPage } from "./CollaborationPage";

const apiRequests: URL[] = [];
const approvalItemRequests: URL[] = [];
const currentPlanDate = todayInSeoul();
const weekWorkOrderItems = workOrderListItems.map((workOrder) =>
  workOrder.request_no === "20260612-001"
    ? { ...workOrder, target_due_at: `${currentPlanDate}T02:00:00Z` }
    : workOrder,
);

const messengerThreads = [
  {
    id: "11111111-aaaa-4aaa-8aaa-111111111111",
    kind: "team",
    branch_id: branchId,
    title: "정비팀 공지",
    work_order_id: null,
    last_message_id: null,
    last_message_at: null,
    member_count: 3,
    created_at: "2026-06-26T01:00:00Z",
    updated_at: "2026-06-26T01:00:00Z",
  },
] as const;

const mailThreads = [
  {
    id: "22222222-bbbb-4bbb-8bbb-222222222222",
    subject: "급여명세서 발송",
    last_message_at: "2026-06-26T02:00:00Z",
    message_count: 2,
    unread_count: 1,
    has_attachments: false,
    is_flagged: false,
  },
] as const;

const requestedPlanId = "33333333-cccc-4ccc-8ccc-333333333333";
const targetChangeId = "55555555-eeee-4eee-8eee-555555555555";
const testTenantId = "99999999-0000-4000-8000-999999999999";

function approvalContext(
  source: "WORK_ORDER" | "DAILY_PLAN" | "TARGET_CHANGE",
  sourceId: string,
) {
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
        summary: `${workOrder.customer.name} · ${workOrder.site.name}`,
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
        title: "계획업무 검토",
        summary: "정비사 일일 계획 승인",
        requested_at: "2026-06-28T01:00:00Z",
        due_at: `${currentPlanDate}T00:00:00Z`,
        href: `/daily-plan?planId=${requestedPlanId}`,
        action_href: `/api/daily-work-plans/${requestedPlanId}/review`,
        ...approvalContext("DAILY_PLAN", requestedPlanId),
        daily_plan: {
          id: requestedPlanId,
          branch_id: branchId,
          mechanic_id: primaryMechanicId,
          plan_date: currentPlanDate,
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
        due_at: `${currentPlanDate}T03:00:00Z`,
        href: `#target-change-${targetChangeId}`,
        action_href: `/api/target-change-requests/${targetChangeId}/review`,
        ...approvalContext("TARGET_CHANGE", targetChangeId),
        target_change: {
          id: targetChangeId,
          work_order_id: workOrder.id,
          branch_id: branchId,
          requested_target_due_at: `${currentPlanDate}T03:00:00Z`,
          status: "REQUESTED",
        },
      },
    ],
    sources: [
      { key: "workOrders", label: "작업 보고", status: "ok", count: 1 },
      { key: "dailyPlans", label: "계획업무", status: "ok", count: 1 },
      { key: "targetChanges", label: "일정 변경", status: "ok", count: 1 },
    ],
    limit: 20,
    offset: 0,
    total: 3,
  };
}

const server = setupServer(
  http.get("*/api/v1/work-orders", ({ request }) => {
    const url = new URL(request.url);
    apiRequests.push(url);
    const statusFilter = url.searchParams
      .getAll("status")
      .flatMap((value) => value.split(","));
    if (
      statusFilter.some(
        (status) => status === "REPORT_SUBMITTED" || status === "ADMIN_REVIEW",
      )
    ) {
      return HttpResponse.json(
        { error: "collaboration approvals must use /api/approval-items" },
        { status: 500 },
      );
    }
    const items = statusFilter.length
      ? weekWorkOrderItems.filter((workOrder) =>
          statusFilter.includes(workOrder.status),
        )
      : weekWorkOrderItems;
    return HttpResponse.json({
      items,
      limit: 20,
      offset: 0,
      total: items.length,
    });
  }),
  http.get("*/api/approval-items", ({ request }) => {
    const url = new URL(request.url);
    apiRequests.push(url);
    approvalItemRequests.push(url);
    return HttpResponse.json(federatedApprovalPayload());
  }),
  http.get("*/api/daily-work-plans", ({ request }) => {
    apiRequests.push(new URL(request.url));
    return HttpResponse.json({
      items: [
        {
          id: "33333333-cccc-4ccc-8ccc-333333333333",
          branch_id: branchId,
          mechanic_id: primaryMechanicId,
          plan_date: currentPlanDate,
          status: "REQUESTED",
        },
      ],
    });
  }),
  http.get("*/api/v1/support/tickets", ({ request }) => {
    apiRequests.push(new URL(request.url));
    return HttpResponse.json(
      supportTicketPage([
        {
          id: "44444444-dddd-4ddd-8ddd-444444444444",
          branch_id: branchId,
          origin: "CUSTOMER",
          category: "OPERATIONAL",
          priority: "URGENT",
          status: "OPEN",
          title: "출고 일정 확인 요청",
          requester_user_id: "00000000-0000-4000-8000-0000000000aa",
          requester_name: "고객사",
          assignee_user_id: "00000000-0000-4000-8000-0000000000bb",
          assignee_name: null,
          due_at: "2026-06-16T08:00:00Z",
          created_at: "2026-06-15T09:00:00Z",
          updated_at: "2026-06-15T09:00:00Z",
          resolved_at: null,
          closed_at: null,
        },
      ]),
    );
  }),
  http.get("*/api/messenger/threads", ({ request }) => {
    apiRequests.push(new URL(request.url));
    return HttpResponse.json({ items: messengerThreads });
  }),
  http.get("*/api/v1/mail/threads", ({ request }) => {
    apiRequests.push(new URL(request.url));
    return HttpResponse.json(mailThreads);
  }),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
  apiRequests.length = 0;
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

function renderCollaboration(session: AuthSession) {
  return render(
    <AuthContext.Provider value={makeAuthContext(session)}>
      <MemoryRouter initialEntries={["/collaboration"]}>
        <CollaborationPage />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

const baseSession: AuthSession = {
  access_token: tokenPair.access_token,
  user_id: "00000000-0000-4000-8000-000000000002",
  roles: ["MECHANIC"],
  branches: [branchId],
};
const adminSession: AuthSession = { ...baseSession, roles: ["ADMIN"] };
const mechanicSession: AuthSession = { ...baseSession, roles: ["MECHANIC"] };

describe("CollaborationPage", () => {
  it("surfaces messenger, mail, calendar, support, approval, and poll governance for administrators", async () => {
    renderCollaboration(adminSession);

    expect(
      await screen.findByRole("heading", { name: "협업 허브", level: 1 }),
    ).toBeVisible();
    expect(await screen.findByText("20260612-001")).toBeVisible();
    expect(
      screen.getByText("승인 대기 20260612-002 작업 보고 승인"),
    ).toBeVisible();
    expect(screen.getByText("작업 보고 · Acme Corporation · 인천센터")).toBeVisible();
    expect(screen.getByText("승인 대기 일정 변경 요청")).toBeVisible();
    expect(screen.getByText("출고 일정 확인 요청")).toBeVisible();
    expect(screen.getByText("정비팀 공지")).toBeVisible();
    expect(screen.getByText("급여명세서 발송")).toBeVisible();
    expect(
      screen.getByText("발행은 백엔드 폴 엔진 준비 후 허용"),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "메신저 열기" })).toHaveAttribute(
      "href",
      "/messenger",
    );
    expect(screen.getByRole("link", { name: "메일함 열기" })).toHaveAttribute(
      "href",
      "/mail",
    );

    const calendar = screen.getByRole("list", { name: "이번 주 협업 일정" });
    expect(within(calendar).getByText(currentPlanDate)).toBeVisible();

    await waitFor(() => {
      expect(
        apiRequests.some((url) => url.pathname === "/api/v1/mail/threads"),
      ).toBe(true);
      expect(approvalItemRequests).toHaveLength(1);
      expect(approvalItemRequests[0].pathname).toBe("/api/approval-items");
      expect(approvalItemRequests[0].searchParams.get("limit")).toBe("20");
      expect(
        apiRequests.some(
          (url) =>
            url.pathname === "/api/v1/work-orders" &&
            url.search.includes("ADMIN_REVIEW"),
        ),
      ).toBe(false);
    });
  });

  it("keeps federated approval calendar links inside the app", async () => {
    server.use(
      http.get("*/api/approval-items", ({ request }) => {
        const url = new URL(request.url);
        apiRequests.push(url);
        approvalItemRequests.push(url);
        const payload = federatedApprovalPayload();
        return HttpResponse.json({
          ...payload,
          items: payload.items.map((item) =>
            item.source === "DAILY_PLAN"
              ? { ...item, title: "외부 링크 차단 검토", href: "//evil.example/phish" }
              : item,
          ),
        });
      }),
    );

    renderCollaboration(adminSession);

    const maliciousTitle = await screen.findByText("승인 대기 외부 링크 차단 검토");
    const maliciousLink = maliciousTitle.closest("a");

    expect(maliciousLink).toHaveAttribute("href", "/daily-plan");
    expect(maliciousLink).not.toHaveAttribute("href", "//evil.example/phish");
  });

  it("keeps mechanics in the collaboration hub without leaking mail or approval queues", async () => {
    renderCollaboration(mechanicSession);

    expect(
      await screen.findByRole("heading", { name: "협업 허브", level: 1 }),
    ).toBeVisible();
    expect(screen.getByText("정비팀 공지")).toBeVisible();
    expect(
      screen.getAllByText("이 역할은 회사 메일함 사용 권한이 없습니다."),
    ).toHaveLength(2);
    expect(screen.queryByText("급여명세서 발송")).not.toBeInTheDocument();
    expect(
      screen.queryByText("승인 대기 20260612-002"),
    ).not.toBeInTheDocument();

    await waitFor(() => {
      expect(
        apiRequests.some((url) => url.pathname === "/api/v1/mail/threads"),
      ).toBe(false);
      expect(approvalItemRequests).toHaveLength(0);
      expect(
        apiRequests.some(
          (url) =>
            url.pathname === "/api/v1/work-orders" &&
            url.search.includes("ADMIN_REVIEW"),
        ),
      ).toBe(false);
    });
  });
});
