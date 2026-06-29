import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { components } from "@maintenance/api-client-ts";
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

const WORK_ORDER_ID = "33333333-3333-4333-8333-333333333333";

// A full WorkOrderDetail: the list item plus the detail-only fields (symptom,
// customer_request, status_history, evidence, ...).
const workOrderDetail: components["schemas"]["WorkOrderDetail"] = {
  ...workOrderListItems[0],
  status: "IN_PROGRESS",
  assignments: [
    {
      id: "12121212-1212-4212-8212-121212121212",
      mechanic_id: primaryMechanicId,
      mechanic_name: "김정비",
      role: "PRIMARY",
      assigned_at: "2026-06-12T08:30:00Z",
    },
  ],
  symptom: "주행 중 유압 누유가 발생합니다.",
  customer_request: "오전 중 방문 요청",
  delay_reason: null,
  delay_note: null,
  diagnosis: null,
  action_taken: null,
  report_submitted_by: null,
  report_submitted_at: null,
  kpi_excluded: false,
  evidence_verified: false,
  approval_line: [],
  status_history: [
    {
      id: "aaaa1111-1111-4111-8111-111111111111",
      actor: null,
      action: "RECEIVE",
      from_status: null,
      to_status: "RECEIVED",
      occurred_at: "2026-06-12T08:00:00Z",
    },
    {
      id: "aaaa2222-2222-4222-8222-222222222222",
      actor: primaryMechanicId,
      action: "START",
      from_status: "ASSIGNED",
      to_status: "IN_PROGRESS",
      occurred_at: "2026-06-12T09:00:00Z",
    },
  ],
  evidence: [
    {
      id: "ev111111-1111-4111-8111-111111111111",
      stage: "REQUEST",
      content_type: "image/jpeg",
      size_bytes: 102400,
      uploaded_by: primaryMechanicId,
      worm_replica_status: "PENDING",
      retry_count: 0,
      verified_at: null,
      created_at: "2026-06-12T08:10:00Z",
    },
  ],
};

const workOrderWithApprovalLine: components["schemas"]["WorkOrderDetail"] = {
  ...workOrderDetail,
  approval_line: [
    {
      id: "ap111111-1111-4111-8111-111111111111",
      step_order: 1,
      role: "MECHANIC",
      approver_id: primaryMechanicId,
      approver_name: "고민서",
      status: "APPROVED",
      requested_at: "2026-06-12T14:00:00Z",
      approved_at: "2026-06-12T14:05:00Z",
      approved_by_id: primaryMechanicId,
      approved_by_name: "고민서",
      decision_comment: "정비 보고 제출",
    },
    {
      id: "ap222222-2222-4222-8222-222222222222",
      step_order: 2,
      role: "ADMIN",
      approver_id: null,
      approver_name: null,
      status: "PENDING",
      requested_at: "2026-06-12T14:10:00Z",
      approved_at: null,
      approved_by_id: null,
      approved_by_name: null,
      decision_comment: null,
    },
  ],
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

function renderApp(path: string, ctx: AuthContextValue) {
  return render(
    <AuthContext.Provider value={ctx}>
      <MemoryRouter initialEntries={[path]}>
        <AppRouter />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

function detailHandler() {
  return http.get("*/api/v1/work-orders/:id", ({ params }) => {
    if (params.id === WORK_ORDER_ID) {
      return HttpResponse.json(workOrderDetail);
    }
    return HttpResponse.json({ error: "not found" }, { status: 404 });
  });
}

// The detail view fetches each evidence's status for a thumbnail URL.
function evidenceStatusHandler() {
  return http.get("*/api/v1/evidence/:evidenceId/status", () =>
    HttpResponse.json({
      id: "ev111111-1111-4111-8111-111111111111",
      work_order_id: WORK_ORDER_ID,
      stage: "REQUEST",
      processing_status: "READY",
      content_type: "image/jpeg",
      thumbnail_url: "https://example.test/thumb.jpg",
    }),
  );
}

const receptionistSession: AuthSession = {
  access_token: "r",
  user_id: "reception-1",
  roles: ["RECEPTIONIST"],
  branches: [branchId],
};

const mechanicSession: AuthSession = {
  access_token: "m",
  user_id: primaryMechanicId,
  roles: ["MECHANIC"],
  branches: [branchId],
};

const adminSession: AuthSession = {
  access_token: "a",
  user_id: "manager-1",
  roles: ["ADMIN"],
  branches: [branchId],
};

describe("WorkOrderDetailPage", () => {
  it("renders the symptom, customer request, status history and evidence via a deep link", async () => {
    server.use(detailHandler(), evidenceStatusHandler());

    renderApp(
      `/work-orders/${WORK_ORDER_ID}`,
      makeAuthContext(receptionistSession),
    );

    // Reported symptom + customer request — the data the mechanic previously
    // never saw.
    expect(
      await screen.findByText("주행 중 유압 누유가 발생합니다."),
    ).toBeVisible();
    expect(screen.getByText("오전 중 방문 요청")).toBeVisible();
    // Assignee display name via safeLabel.
    expect(screen.getByText("김정비")).toBeVisible();

    // Status-history timeline (rendered in KST).
    expect(screen.getByText("진행 이력")).toBeVisible();
    expect(screen.getByText(/2026-06-12 17:00/)).toBeVisible();

    // Evidence list with the fetched thumbnail.
    const thumb = await screen.findByAltText("증거 미리보기");
    expect(thumb).toHaveAttribute("src", "https://example.test/thumb.jpg");
  });


  it("renders the approval line without leaking raw approver ids", async () => {
    server.use(
      http.get("*/api/v1/work-orders/:id", () =>
        HttpResponse.json(workOrderWithApprovalLine),
      ),
      evidenceStatusHandler(),
    );

    renderApp(
      `/work-orders/${WORK_ORDER_ID}`,
      makeAuthContext(receptionistSession),
    );

    expect(await screen.findByText("승인 라인")).toBeVisible();
    expect(screen.getByText("1. 정비사")).toBeVisible();
    expect(screen.getByText("2. 관리자")).toBeVisible();
    expect(screen.getByText("승인")).toBeVisible();
    expect(screen.getByText("대기")).toBeVisible();
    expect(screen.getByText(/처리자: 고민서/)).toBeVisible();
    expect(screen.getByText(/의견: 정비 보고 제출/)).toBeVisible();
    expect(screen.getByText(/지정 결재자: 미지정/)).toBeVisible();
    expect(screen.queryByText("MECHANIC")).not.toBeInTheDocument();
    expect(screen.queryByText("APPROVED")).not.toBeInTheDocument();
    expect(screen.queryByText(primaryMechanicId)).not.toBeInTheDocument();
  });

  it("is read-only for a non-mechanic reader (no start/report controls)", async () => {
    server.use(detailHandler(), evidenceStatusHandler());

    renderApp(
      `/work-orders/${WORK_ORDER_ID}`,
      makeAuthContext(receptionistSession),
    );

    await screen.findByText("주행 중 유압 누유가 발생합니다.");

    // The receptionist holds WorkOrderReadAll (read) but no write entitlement:
    // the start/report buttons and the evidence-upload affordance must not render.
    expect(
      screen.queryByRole("button", { name: "작업 보고" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "작업 시작" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("증거 사진·영상")).not.toBeInTheDocument();
  });

  it("shows the report control to the assigned mechanic", async () => {
    server.use(detailHandler(), evidenceStatusHandler());

    renderApp(
      `/work-orders/${WORK_ORDER_ID}`,
      makeAuthContext(mechanicSession),
    );

    await screen.findByText("주행 중 유압 누유가 발생합니다.");

    // The order is IN_PROGRESS and the mechanic is the primary assignee, so the
    // report control and the evidence-upload affordance render.
    expect(
      await screen.findByRole("button", { name: "작업 보고" }),
    ).toBeVisible();
    expect(screen.getByText("증거 사진·영상")).toBeVisible();
  });

  it("lets a manager control dispatch from the work-order detail page", async () => {
    const user = userEvent.setup();
    const patched = vi.fn();
    server.use(
      detailHandler(),
      evidenceStatusHandler(),
      http.get("*/api/v1/users", () =>
        HttpResponse.json({
          items: [
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
          ],
          total: 1,
          limit: 50,
          offset: 0,
        }),
      ),
      http.patch("*/api/work-orders/:id/priority", async ({ request }) => {
        patched(await request.json());
        return HttpResponse.json({ ...workOrderDetail, priority: "P2" });
      }),
    );

    renderApp(`/work-orders/${WORK_ORDER_ID}`, makeAuthContext(adminSession));

    expect(await screen.findByText("배차 제어 · 20260612-001")).toBeVisible();
    await user.selectOptions(await screen.findByLabelText("중요도"), "P2");
    await user.click(screen.getByRole("button", { name: "중요도 변경" }));

    await waitFor(() => {
      expect(patched).toHaveBeenCalledWith({ priority: "P2" });
    });
  });

  it("lets a manager edit intake text from the work-order detail page", async () => {
    const user = userEvent.setup();
    const patched = vi.fn();
    server.use(
      detailHandler(),
      evidenceStatusHandler(),
      http.get("*/api/v1/users", () =>
        HttpResponse.json({ items: [], total: 0, limit: 50, offset: 0 }),
      ),
      http.patch("*/api/work-orders/:id", async ({ request }) => {
        patched(await request.json());
        return HttpResponse.json({
          ...workOrderDetail,
          symptom: "작동 중 소음과 유압 누유",
          customer_request: "오후 방문 요청",
        });
      }),
    );

    renderApp(`/work-orders/${WORK_ORDER_ID}`, makeAuthContext(adminSession));

    await user.click(await screen.findByRole("button", { name: "작업지시 수정" }));
    await user.clear(screen.getByLabelText("고장내용"));
    await user.type(screen.getByLabelText("고장내용"), "작동 중 소음과 유압 누유");
    await user.clear(screen.getByLabelText("고객 요청사항"));
    await user.type(screen.getByLabelText("고객 요청사항"), "오후 방문 요청");
    await user.click(screen.getByRole("button", { name: "수정 저장" }));

    await waitFor(() => {
      expect(patched).toHaveBeenCalledWith({
        symptom: "작동 중 소음과 유압 누유",
        customer_request: "오후 방문 요청",
      });
    });
  });

  it("shows an edit failure when the intake update is rejected", async () => {
    const user = userEvent.setup();
    server.use(
      detailHandler(),
      evidenceStatusHandler(),
      http.get("*/api/v1/users", () =>
        HttpResponse.json({ items: [], total: 0, limit: 50, offset: 0 }),
      ),
      http.patch("*/api/work-orders/:id", () =>
        HttpResponse.json({ error: "forbidden" }, { status: 403 }),
      ),
    );

    renderApp(`/work-orders/${WORK_ORDER_ID}`, makeAuthContext(adminSession));

    await user.click(await screen.findByRole("button", { name: "작업지시 수정" }));
    await user.click(screen.getByRole("button", { name: "수정 저장" }));

    expect(
      await screen.findByText("작업지시를 수정하지 못했습니다. 다시 시도하세요."),
    ).toBeVisible();
  });

  it("shows a forbidden message on a 403 without offering a retry", async () => {
    server.use(
      http.get("*/api/v1/work-orders/:id", () =>
        HttpResponse.json({ error: "forbidden" }, { status: 403 }),
      ),
    );

    renderApp(
      `/work-orders/${WORK_ORDER_ID}`,
      makeAuthContext(receptionistSession),
    );

    expect(
      await screen.findByText("이 작업지시를 볼 권한이 없습니다."),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "다시 시도" }),
    ).not.toBeInTheDocument();
  });
});
