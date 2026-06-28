import { render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createConsoleApiClient } from "../api/client";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { AuthContext } from "../context/auth";
import { branchId, primaryMechanicId, workOrderListItems } from "../test/fixtures";
import { ApprovalsPage } from "./ApprovalsPage";

const federatedRequests: URL[] = [];
const legacyListRequests: URL[] = [];
const legacyDailyRequests: URL[] = [];
const server = setupServer();

const requestedPlanId = "44444444-4444-4444-8444-444444444444";
const testTenantId = "99999999-0000-4000-8000-999999999999";

const adminSession: AuthSession = {
  access_token: "admin-token",
  user_id: "admin-user",
  roles: ["ADMIN"],
  branches: [branchId],
};

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
  federatedRequests.length = 0;
  legacyListRequests.length = 0;
  legacyDailyRequests.length = 0;
});

afterAll(() => {
  server.close();
});

function makeAuthContext(): AuthContextValue {
  return {
    session: adminSession,
    restoring: false,
    login: async () => {},
    logout: async () => {},
    refresh: async () => {},
    acceptTokens: () => {},
    clearPasskeySetup: () => {},
    viewAs: undefined,
    enterViewAs: () => {},
    exitViewAs: () => undefined,
    api: createConsoleApiClient(adminSession.access_token),
  };
}

function renderPage(initialEntries = ["/approvals"]) {
  return render(
    <AuthContext.Provider value={makeAuthContext()}>
      <MemoryRouter initialEntries={initialEntries}>
        <ApprovalsPage />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

const targetChangeId = "66666666-6666-4666-8666-666666666666";

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
  const workOrder =
    workOrderListItems.find((item) => item.status === "REPORT_SUBMITTED") ??
    workOrderListItems.find((item) => item.status === "ADMIN_REVIEW") ??
    workOrderListItems[0];
  return {
    items: [
      {
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
    limit: 100,
    offset: 0,
    total: 3,
  };
}

function installHappyHandlers() {
  server.use(
    http.get("*/api/approval-items", ({ request }) => {
      federatedRequests.push(new URL(request.url));
      return HttpResponse.json(federatedApprovalPayload());
    }),
    http.get("*/api/v1/work-orders", ({ request }) => {
      legacyListRequests.push(new URL(request.url));
      return HttpResponse.json({ error: "legacy work-order approval list should not be called" }, { status: 500 });
    }),
    http.get("*/api/daily-work-plans", ({ request }) => {
      legacyDailyRequests.push(new URL(request.url));
      return HttpResponse.json({ error: "legacy daily-plan approval list should not be called" }, { status: 500 });
    }),
  );
}

describe("ApprovalsPage", () => {
  it("renders an actionable approval queue with source object, policy, and priority context", async () => {
    installHappyHandlers();

    renderPage();

    expect(
      await screen.findByRole("heading", { name: "승인 대기", level: 1 }),
    ).toBeVisible();
    expect(screen.queryByText("Workflow + Approval")).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "작업 보고, 계획업무, 일정 변경 요청을 원천 업무 객체와 연결해 감사 가능한 승인 흐름으로 처리합니다.",
      ),
    ).not.toBeInTheDocument();
    expect(await screen.findByText("승인 액션 큐")).toBeVisible();
    const commandCenter = screen.getByRole("region", {
      name: "승인 액션 큐",
    });
    expect(commandCenter).toHaveClass("bg-brand-teal/5");
    expect(commandCenter).not.toHaveClass("bg-ink");
    expect(commandCenter).not.toHaveClass("text-white");
    expect(screen.getByText("다음 결정")).toBeVisible();
    expect(screen.getAllByText("범위: 지점 범위")[0]).toBeVisible();
    expect(screen.getByText("액션: 작업 승인")).toBeVisible();
    expect(screen.queryByText("approve_work_order")).not.toBeInTheDocument();
    expect(screen.getAllByText("정책: 서버 재검사")[0]).toBeVisible();
    expect(screen.getByRole("link", { name: /20260612-002 작업 보고 승인 결정하기/ })).toHaveAttribute(
      "href",
      expect.stringContaining("/approvals?source=work-order&focus="),
    );
    expect(screen.getByRole("link", { name: "작업 승인 큐로 이동" })).toBeVisible();
    expect(screen.getByText("계획업무 검토")).toBeVisible();
    expect(screen.getByText("일정 변경 검토")).toBeVisible();

    const requestedPlanLink = screen.getByRole("link", {
      name: "2026-06-29 계획업무 검토 열기",
    });
    expect(requestedPlanLink).toHaveAttribute(
      "href",
      `/daily-plan?planId=${requestedPlanId}`,
    );
    expect(screen.queryByRole("link", { name: /2026-06-30 계획업무/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "일정 변경 요청 검토", level: 2 })).toBeVisible();
    expect(screen.getByText("2026-07-05 09:00")).toBeVisible();

    await waitFor(() => {
      expect(federatedRequests.length).toBe(1);
      expect(federatedRequests[0].searchParams.get("limit")).toBe("100");
      expect(legacyListRequests).toHaveLength(0);
      expect(legacyDailyRequests).toHaveLength(0);
    });
  });

  it("shows a full retryable error when the federated approval API fails", async () => {
    installHappyHandlers();
    server.use(
      http.get("*/api/approval-items", () =>
        HttpResponse.json({ error: "approval federation offline" }, { status: 503 }),
      ),
    );

    renderPage();

    expect(await screen.findByText("데이터를 불러오지 못했습니다.")).toBeVisible();
    expect(screen.queryByText("20260612-002")).not.toBeInTheDocument();
  });

  it("focuses the work-order approval linked from the work hub", async () => {
    installHappyHandlers();

    const focusedWorkOrder = federatedApprovalPayload().items.find(
      (item) => item.source === "WORK_ORDER",
    );
    if (!focusedWorkOrder) throw new Error("fixture missing work-order approval item");

    renderPage([
      `/approvals?source=work-order&focus=${focusedWorkOrder.source_id}`,
    ]);

    expect(await screen.findByText("업무 허브에서 연결된 승인 건을 강조했습니다.")).toBeVisible();
    const focusedApproval = screen.getByLabelText(/20260612-002 연결된 승인 건/);
    expect(focusedApproval).toHaveAttribute(
      "id",
      `approval-work-order-${focusedWorkOrder.source_id}`,
    );
    expect(focusedApproval).toHaveAttribute("aria-current", "true");
  });

  it("explains stale work-order approval deep links instead of focusing the wrong row", async () => {
    installHappyHandlers();

    renderPage([
      "/approvals?source=work-order&focus=00000000-0000-4000-8000-000000000000",
    ]);

    expect(
      await screen.findByText(
        "연결된 승인 건이 현재 승인 대기 목록에 없습니다. 이미 처리되었거나 권한 범위 밖일 수 있습니다.",
      ),
    ).toBeVisible();
    expect(screen.queryByLabelText(/20260612-002 연결된 승인 건/)).not.toBeInTheDocument();
  });
});
