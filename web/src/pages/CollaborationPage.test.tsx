import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
    unread_count: 1,
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

const calendarEvents = [
  {
    id: "99999999-aaaa-4aaa-8aaa-999999999991",
    scope_type: "ORG",
    scope_ref: null,
    title: "전사 안전 교육",
    description: "",
    starts_at: `${currentPlanDate}T04:00:00Z`,
    ends_at: `${currentPlanDate}T05:00:00Z`,
    all_day: false,
    status: "ACTIVE",
    object_type: "work_order",
    object_id: workOrderListItems[0].id,
    created_by: "00000000-0000-4000-8000-000000000002",
    created_at: "2026-06-26T01:00:00Z",
    updated_at: "2026-06-26T01:00:00Z",
    policy: {
      enforcement: "server",
      scope_type: "ORG",
      scope_ref: null,
      visibility: "org_members",
    },
  },
] as const;

const pollId = "99999999-bbbb-4bbb-8bbb-999999999992";
const pollOptionApprove = "99999999-bbbb-4bbb-8bbb-999999999993";
const polls = [
  {
    id: pollId,
    target_scope_type: "TEAM",
    target_scope_ref: "maintenance",
    title: "야간 작업 일정 투표",
    question: "이번 주 야간 작업을 금요일에 진행할까요?",
    status: "OPEN",
    anonymity: "ANONYMOUS",
    allow_multiple: false,
    closes_at: null,
    object_type: "work_order",
    object_id: workOrderListItems[0].id,
    options: [
      {
        id: pollOptionApprove,
        label: "찬성",
        position: 0,
        vote_count: 1,
      },
      {
        id: "99999999-bbbb-4bbb-8bbb-999999999994",
        label: "반대",
        position: 1,
        vote_count: 0,
      },
    ],
    vote_count: 1,
    my_vote: {
      submitted: false,
      selected_option_ids: null,
    },
    created_by: "00000000-0000-4000-8000-000000000002",
    created_at: "2026-06-26T01:00:00Z",
    updated_at: "2026-06-26T01:00:00Z",
    policy: {
      enforcement: "server",
      scope_type: "TEAM",
      scope_ref: "maintenance",
      visibility: "team_target",
    },
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
  http.get("*/api/v1/collaboration/calendar/events", ({ request }) => {
    apiRequests.push(new URL(request.url));
    return HttpResponse.json({ items: calendarEvents });
  }),
  http.post("*/api/v1/collaboration/calendar/events", async ({ request }) => {
    apiRequests.push(new URL(request.url));
    const body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({
      ...calendarEvents[0],
      id: "99999999-aaaa-4aaa-8aaa-999999999995",
      scope_type: body.scope_type,
      title: body.title,
      starts_at: body.starts_at,
      ends_at: body.ends_at,
      object_type: body.object_type ?? null,
      object_id: body.object_id ?? null,
      policy: {
        enforcement: "server",
        scope_type: body.scope_type,
        scope_ref: null,
        visibility: body.scope_type === "PERSONAL" ? "creator_only" : "org_members",
      },
    });
  }),
  http.get("*/api/v1/collaboration/polls", ({ request }) => {
    apiRequests.push(new URL(request.url));
    return HttpResponse.json({ items: polls });
  }),
  http.post("*/api/v1/collaboration/polls", async ({ request }) => {
    apiRequests.push(new URL(request.url));
    const body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({
      ...polls[0],
      id: "99999999-bbbb-4bbb-8bbb-999999999996",
      target_scope_type: body.target_scope_type,
      title: body.title,
      question: body.question,
      anonymity: body.anonymity,
      options: [
        { id: "99999999-bbbb-4bbb-8bbb-999999999997", label: "A", position: 0, vote_count: 0 },
        { id: "99999999-bbbb-4bbb-8bbb-999999999998", label: "B", position: 1, vote_count: 0 },
      ],
      vote_count: 0,
      my_vote: { submitted: false, selected_option_ids: null },
      policy: {
        enforcement: "server",
        scope_type: body.target_scope_type,
        scope_ref: null,
        visibility: body.target_scope_type === "TEAM" ? "team_target" : "org_members",
      },
    });
  }),
  http.post("*/api/v1/collaboration/polls/:id/vote", async ({ params, request }) => {
    apiRequests.push(new URL(request.url));
    const body = (await request.json()) as { selected_option_ids: string[] };
    return HttpResponse.json({
      ...polls[0],
      id: params.id,
      options: polls[0].options.map((option) =>
        option.id === body.selected_option_ids[0]
          ? { ...option, vote_count: option.vote_count + 1 }
          : option,
      ),
      vote_count: 2,
      my_vote: { submitted: true, selected_option_ids: body.selected_option_ids },
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
    expect(screen.getByText("전사 안전 교육")).toBeVisible();
    expect(screen.getByText("야간 작업 일정 투표")).toBeVisible();
    expect(screen.getByText("서버 정책·감사 기반")).toBeVisible();
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
          (url) => url.pathname === "/api/v1/collaboration/calendar/events",
        ),
      ).toBe(true);
      expect(
        apiRequests.some(
          (url) => url.pathname === "/api/v1/collaboration/polls",
        ),
      ).toBe(true);
      expect(
        apiRequests.some(
          (url) =>
            url.pathname === "/api/v1/work-orders" &&
            url.search.includes("ADMIN_REVIEW"),
        ),
      ).toBe(false);
    });
  });

  it("creates scoped calendar events and polls, then submits a poll vote", async () => {
    const user = userEvent.setup();
    renderCollaboration(adminSession);

    await screen.findByText("전사 안전 교육");
    await user.type(
      screen.getByLabelText("일정 제목"),
      "정비팀 주간 회의",
    );
    await user.click(screen.getByRole("button", { name: "일정 추가" }));

    expect(await screen.findByText("일정을 추가했습니다.")).toBeVisible();
    expect(screen.getByText("정비팀 주간 회의")).toBeVisible();

    await user.clear(screen.getByLabelText("폴 제목"));
    await user.type(screen.getByLabelText("폴 제목"), "부품 재고 기준 투표");
    await user.type(
      screen.getByLabelText("질문"),
      "예비 부품 기준을 상향할까요?",
    );
    await user.clear(screen.getByLabelText("선택지 (한 줄에 하나)"));
    await user.type(screen.getByLabelText("선택지 (한 줄에 하나)"), "A\nB");
    await user.click(screen.getByRole("button", { name: "폴 발행" }));

    expect(await screen.findByText("폴을 발행했습니다.")).toBeVisible();
    expect(screen.getByText("부품 재고 기준 투표")).toBeVisible();

    await user.click(screen.getAllByText("찬성")[0]);

    expect(await screen.findByText("투표를 저장했습니다.")).toBeVisible();
    await waitFor(() => {
      expect(
        apiRequests.some(
          (url) =>
            url.pathname === `/api/v1/collaboration/polls/${pollId}/vote`,
        ),
      ).toBe(true);
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

  it("keeps resolved or closed support tickets out of collaboration actions", async () => {
    server.use(
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
            {
              id: "66666666-ffff-4fff-8fff-666666666666",
              branch_id: branchId,
              origin: "INTERNAL",
              category: "OPERATIONAL",
              priority: "NORMAL",
              status: "OPEN",
              title: "이미 처리된 열린 요청",
              requester_user_id: "00000000-0000-4000-8000-0000000000aa",
              requester_name: "운영팀",
              assignee_user_id: null,
              assignee_name: null,
              due_at: null,
              created_at: "2026-06-14T09:00:00Z",
              updated_at: "2026-06-14T10:00:00Z",
              resolved_at: "2026-06-14T10:00:00Z",
              closed_at: null,
            },
            {
              id: "77777777-ffff-4fff-8fff-777777777777",
              branch_id: branchId,
              origin: "INTERNAL",
              category: "OPERATIONAL",
              priority: "NORMAL",
              status: "RESOLVED",
              title: "이미 해결된 요청",
              requester_user_id: "00000000-0000-4000-8000-0000000000aa",
              requester_name: "운영팀",
              assignee_user_id: null,
              assignee_name: null,
              due_at: null,
              created_at: "2026-06-14T09:00:00Z",
              updated_at: "2026-06-14T10:00:00Z",
              resolved_at: "2026-06-14T10:00:00Z",
              closed_at: null,
            },
            {
              id: "88888888-ffff-4fff-8fff-888888888888",
              branch_id: branchId,
              origin: "INTERNAL",
              category: "OPERATIONAL",
              priority: "NORMAL",
              status: "CLOSED",
              title: "이미 닫힌 요청",
              requester_user_id: "00000000-0000-4000-8000-0000000000aa",
              requester_name: "운영팀",
              assignee_user_id: null,
              assignee_name: null,
              due_at: null,
              created_at: "2026-06-14T09:00:00Z",
              updated_at: "2026-06-14T11:00:00Z",
              resolved_at: "2026-06-14T10:00:00Z",
              closed_at: "2026-06-14T11:00:00Z",
            },
          ]),
        );
      }),
    );

    renderCollaboration(adminSession);

    expect(await screen.findByText("출고 일정 확인 요청")).toBeVisible();
    expect(screen.queryByText("이미 처리된 열린 요청")).not.toBeInTheDocument();
    expect(screen.queryByText("이미 해결된 요청")).not.toBeInTheDocument();
    expect(screen.queryByText("이미 닫힌 요청")).not.toBeInTheDocument();
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
