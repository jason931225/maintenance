import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AuthSession } from "../context/auth";
import {
  CONSOLE_TOAST_EVENT,
  type ConsoleToastDetail,
} from "../components/shell/useConsoleToast";
import { AuthTestProvider } from "../test/AuthTestProvider";
import { kpiReport } from "../test/fixtures";
import { OverviewPage } from "./OverviewPage";

const USER_ID = "00000000-0000-4000-8000-0000000000aa";
const OPEN_TASK_ID = "10000000-0000-4000-8000-000000000001";
const CLAIMED_TASK_ID = "10000000-0000-4000-8000-000000000002";
const DISPATCH_ID = "30000000-0000-4000-8000-000000000001";
const TICKET_ID = "60000000-0000-4000-8000-000000000001";

const adminSession: AuthSession = {
  access_token: "test-token",
  user_id: USER_ID,
  roles: ["SUPER_ADMIN"],
  branches: [],
};

const claimRequests: unknown[] = [];
const decideRequests: unknown[] = [];
const dispatchResponses: unknown[] = [];
const attendanceRequests: unknown[] = [];
const transitionRequests: { id: string; body: unknown }[] = [];

const tasks = {
  items: [
    {
      task_id: OPEN_TASK_ID,
      run_id: "20000000-0000-4000-8000-000000000001",
      waiting_key: "approval.review",
      title: "정비 완료 승인",
      status: "OPEN",
      form_payload: {},
      due_at: "2026-07-09T18:00:00Z",
    },
    {
      task_id: CLAIMED_TASK_ID,
      run_id: "20000000-0000-4000-8000-000000000002",
      waiting_key: "approval.review",
      title: "구매 승인",
      status: "CLAIMED",
      claimed_by: USER_ID,
      form_payload: {},
    },
  ],
};

const offers = {
  items: [
    {
      dispatch_id: DISPATCH_ID,
      work_order_id: "40000000-0000-4000-8000-000000000001",
      branch_id: "50000000-0000-4000-8000-000000000001",
      request_no: "20260709-001",
      accept_window_started_at: "2026-07-09T09:00:00Z",
      accept_window_ends_at: "2026-07-09T09:03:00Z",
    },
  ],
};

const tickets = {
  items: [
    {
      id: TICKET_ID,
      branch_id: "50000000-0000-4000-8000-000000000001",
      origin: "INTERNAL",
      category: "OPERATIONAL",
      priority: "HIGH",
      status: "IN_PROGRESS",
      title: "지게차 배터리 교체 요청",
      requester_user_id: "00000000-0000-4000-8000-0000000000bb",
      requester_name: "요청자",
      assignee_user_id: USER_ID,
      assignee_name: "담당자",
      due_at: null,
      created_at: "2026-07-09T08:00:00Z",
      updated_at: "2026-07-09T08:00:00Z",
      resolved_at: null,
      closed_at: null,
    },
  ],
  next_cursor: null,
  total: 1,
};

const attendanceSummary = {
  items: [
    {
      user_id: "70000000-0000-4000-8000-000000000001",
      display_name: "김정비",
      arrivals: 5,
      departures: 4,
      last_kind: "CLOCK_IN",
      last_event_at: "2026-07-08T09:00:00Z",
    },
    {
      user_id: "70000000-0000-4000-8000-000000000002",
      display_name: "박정비",
      arrivals: 3,
      departures: 3,
      last_kind: "CLOCK_OUT",
      last_event_at: "2026-07-08T18:00:00Z",
    },
  ],
  total: 2,
  limit: 1000,
  offset: 0,
};

const server = setupServer(
  http.get("*/api/v1/workflow-tasks", () => HttpResponse.json(tasks)),
  http.get("*/api/v1/me/dispatch-offers", () => HttpResponse.json(offers)),
  http.get("*/api/v1/support/tickets", () => HttpResponse.json(tickets)),
  http.get("*/api/v1/hr/attendance-summary", ({ request }) => {
    attendanceRequests.push(request.url);
    return HttpResponse.json(attendanceSummary);
  }),
  http.get("*/api/v1/kpi", () => HttpResponse.json(kpiReport)),
  http.get("*/api/v1/me/todos", () => HttpResponse.json({ items: [] })),
  http.get("*/api/v1/hr/attendance-records/me", () =>
    HttpResponse.json({ items: [] }),
  ),
  http.post("*/api/v1/workflow-tasks/:taskId/claim", async ({ request, params }) => {
    claimRequests.push({ taskId: params.taskId, body: await request.json() });
    return HttpResponse.json({
      task: {
        task_id: OPEN_TASK_ID,
        run_id: "20000000-0000-4000-8000-000000000001",
        status: "CLAIMED",
        claimed_by: USER_ID,
      },
    });
  }),
  http.post(
    "*/api/v1/workflow-tasks/:taskId/decide",
    async ({ request, params }) => {
      decideRequests.push({
        taskId: params.taskId,
        body: await request.json(),
      });
      return HttpResponse.json({
        task: {
          task_id: CLAIMED_TASK_ID,
          run_id: "20000000-0000-4000-8000-000000000002",
          status: "COMPLETED",
          decision_payload: {},
        },
        run: {
          run_id: "20000000-0000-4000-8000-000000000002",
          status: "SUCCEEDED",
        },
      });
    },
  ),
  http.post(
    "*/api/v1/p1-dispatches/:dispatchId/responses",
    async ({ request, params }) => {
      dispatchResponses.push({
        dispatchId: params.dispatchId,
        body: await request.json(),
      });
      return HttpResponse.json({
        id: DISPATCH_ID,
        work_order_id: "40000000-0000-4000-8000-000000000001",
        branch_id: "50000000-0000-4000-8000-000000000001",
        status: "AUTO_ASSIGNED",
        accept_window_started_at: "2026-07-09T09:00:00Z",
        accept_window_ends_at: "2026-07-09T09:03:00Z",
        auto_assigned_mechanic_id: USER_ID,
        manager_force_pending_at: null,
        manual_call_required: false,
        manual_call_required_at: null,
        manual_call_cleared_at: null,
        incident_location: null,
        target_count: 1,
        accepted_count: 1,
        declined_count: 0,
      });
    },
  ),
  http.post(
    "*/api/v1/support/tickets/:id/transition",
    async ({ request, params }) => {
      const body = await request.json();
      transitionRequests.push({ id: String(params.id), body });
      return HttpResponse.json({
        ...tickets.items[0],
        status: (body as { to_status: string }).to_status,
      });
    },
  ),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
beforeEach(() => {
  claimRequests.length = 0;
  decideRequests.length = 0;
  dispatchResponses.length = 0;
  attendanceRequests.length = 0;
  transitionRequests.length = 0;
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

function renderPage(session: AuthSession = adminSession) {
  return render(
    <AuthTestProvider session={session}>
      <MemoryRouter>
        <OverviewPage />
      </MemoryRouter>
    </AuthTestProvider>,
  );
}

describe("OverviewPage", () => {
  it("aggregates all four sources with kind counts and the KPI strip", async () => {
    renderPage();

    // One row per pending item; the balanced attendance summary is NOT an
    // exception, so exactly 5 rows total.
    expect(await screen.findByText("정비 완료 승인")).toBeVisible();
    expect(screen.getByText("구매 승인")).toBeVisible();
    expect(screen.getByText("긴급 출동 요청 20260709-001")).toBeVisible();
    expect(screen.getByText("지게차 배터리 교체 요청")).toBeVisible();
    expect(screen.getByText("김정비 근태 확인 필요")).toBeVisible();
    expect(screen.queryByText("박정비 근태 확인 필요")).not.toBeInTheDocument();

    // Filter chips carry live counts.
    expect(
      screen.getByRole("button", { name: "전체 5건" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "전자결재시스템 2건" })).toBeVisible();
    expect(screen.getByRole("button", { name: "출동 1건" })).toBeVisible();
    expect(screen.getByRole("button", { name: "지원 1건" })).toBeVisible();
    expect(screen.getByRole("button", { name: "근태 예외 1건" })).toBeVisible();

    // Compact KPI strip renders from the reporting endpoint.
    expect(screen.getByText("완료 건수")).toBeVisible();
  });

  it("does not probe org-wide attendance summary for branch-scoped admins", async () => {
    renderPage({
      ...adminSession,
      roles: ["ADMIN"],
      branches: ["50000000-0000-4000-8000-000000000001"],
    });

    expect(await screen.findByText("정비 완료 승인")).toBeVisible();
    expect(screen.getByRole("button", { name: "전체 4건" })).toBeVisible();
    expect(screen.queryByText("김정비 근태 확인 필요")).not.toBeInTheDocument();
    expect(attendanceRequests).toHaveLength(0);
  });

  it("renders an actionable group-wide priority inbox without explanatory text walls", async () => {
    renderPage();
    await screen.findByText("정비 완료 승인");

    // Self-explanatory UI: a short title + one-line description, no
    // narrative captions or banned text-wall copy carried over from the
    // /work-hub predecessor this page replaces.
    expect(
      screen.getByRole("heading", { name: "통합 개요", level: 1 }),
    ).toBeVisible();
    expect(
      screen.getByText(
        "전자결재시스템·출동·지원·근태 액션과 오늘의 할 일을 한 화면에서 처리합니다.",
      ),
    ).toBeVisible();
    expect(screen.queryByText("업무 객체 중심 실행 흐름")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/허브는 메신저·메일·티켓을 별도 데모로 분리하지 않고/),
    ).not.toBeInTheDocument();

    // Every pending item is a real action, not a passive read: each row
    // exposes a primary-action button that fires the row's real mutation.
    expect(
      screen.getByRole("button", { name: "정비 완료 승인 담당하기" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "구매 승인 승인" })).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "긴급 출동 요청 20260709-001 출동 수락",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "지게차 배터리 교체 요청 해결" }),
    ).toBeVisible();
  });

  it("filters the list by kind chip", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("정비 완료 승인");

    await user.click(screen.getByRole("button", { name: "지원 1건" }));
    expect(screen.getByText("지게차 배터리 교체 요청")).toBeVisible();
    expect(screen.queryByText("정비 완료 승인")).not.toBeInTheDocument();
    expect(
      screen.queryByText("긴급 출동 요청 20260709-001"),
    ).not.toBeInTheDocument();
  });

  it("claims an OPEN approval task with an idempotency key", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("정비 완료 승인");

    await user.click(
      screen.getByRole("button", { name: "정비 완료 승인 담당하기" }),
    );
    await waitFor(() => {
      expect(claimRequests).toHaveLength(1);
    });
    expect(claimRequests[0]).toMatchObject({
      taskId: OPEN_TASK_ID,
      body: { idempotency_key: expect.any(String) },
    });
  });

  it("approves my CLAIMED task via decide", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("구매 승인");

    await user.click(screen.getByRole("button", { name: "구매 승인 승인" }));
    await waitFor(() => {
      expect(decideRequests).toHaveLength(1);
    });
    expect(decideRequests[0]).toMatchObject({
      taskId: CLAIMED_TASK_ID,
      body: { decision: "approve", idempotency_key: expect.any(String) },
    });
  });

  it("accepts a dispatch offer via the real responses endpoint", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("긴급 출동 요청 20260709-001");

    await user.click(
      screen.getByRole("button", {
        name: "긴급 출동 요청 20260709-001 출동 수락",
      }),
    );
    await waitFor(() => {
      expect(dispatchResponses).toHaveLength(1);
    });
    expect(dispatchResponses[0]).toMatchObject({
      dispatchId: DISPATCH_ID,
      body: { response: "ACCEPT" },
    });
  });

  it("resolves an in-progress ticket and undo reopens it", async () => {
    const user = userEvent.setup();
    let undo: (() => void) | undefined;
    function captureUndo(event: Event) {
      const detail = (event as CustomEvent<ConsoleToastDetail>).detail;
      undo = detail.onUndo;
    }
    window.addEventListener(CONSOLE_TOAST_EVENT, captureUndo);
    renderPage();
    await screen.findByText("지게차 배터리 교체 요청");

    try {
      await user.click(
        screen.getByRole("button", { name: "지게차 배터리 교체 요청 해결" }),
      );
      await waitFor(() => {
        expect(transitionRequests).toHaveLength(1);
      });
      expect(transitionRequests[0]).toEqual({
        id: TICKET_ID,
        body: { to_status: "RESOLVED" },
      });
      expect(undo).toEqual(expect.any(Function));

      undo?.();
      await waitFor(() => {
        expect(transitionRequests).toHaveLength(2);
      });
      expect(transitionRequests[1]).toEqual({
        id: TICKET_ID,
        body: { to_status: "IN_PROGRESS" },
      });
    } finally {
      window.removeEventListener(CONSOLE_TOAST_EVENT, captureUndo);
    }
  });

  it("keyboard: J moves selection and Enter runs the primary action", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("정비 완료 승인");

    const list = screen.getByRole("list", { name: "처리 대기 항목 목록" });
    list.focus();
    // Deadline-first order: the stale attendance exception sorts first, the
    // dispatch offer second. J twice lands on the dispatch row; Enter fires
    // its primary action — the real accept mutation.
    await user.keyboard("j");
    await user.keyboard("j");
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(dispatchResponses).toHaveLength(1);
    });
  });

  it("shows the empty state when every source returns no items", async () => {
    server.use(
      http.get("*/api/v1/workflow-tasks", () =>
        HttpResponse.json({ items: [] }),
      ),
      http.get("*/api/v1/me/dispatch-offers", () =>
        HttpResponse.json({ items: [] }),
      ),
      http.get("*/api/v1/support/tickets", () =>
        HttpResponse.json({ items: [], next_cursor: null, total: 0 }),
      ),
      http.get("*/api/v1/hr/attendance-summary", () =>
        HttpResponse.json({ items: [], total: 0, limit: 1000, offset: 0 }),
      ),
    );
    renderPage();
    expect(
      await screen.findByText("현재 처리할 항목이 없습니다."),
    ).toBeVisible();
  });

  it("reports partial source failures without dropping the healthy sections", async () => {
    server.use(
      http.get("*/api/v1/workflow-tasks", () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );
    renderPage();
    // Healthy sources still render…
    expect(await screen.findByText("지게차 배터리 교체 요청")).toBeVisible();
    // …and the failed one is named.
    expect(
      await screen.findByText("일부 원천을 불러오지 못했습니다: 전자결재시스템"),
    ).toBeVisible();
  });
});
