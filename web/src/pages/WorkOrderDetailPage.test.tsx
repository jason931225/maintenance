import { render, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

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
