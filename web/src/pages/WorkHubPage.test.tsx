import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createConsoleApiClient } from "../api/client";
import { AuthContext } from "../context/auth";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { workOrderListItems } from "../test/fixtures";
import { WorkHubPage } from "./WorkHubPage";

const listRequests: URL[] = [];

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
  listRequests.length = 0;
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

function installHappyHandlers() {
  server.use(
    http.get("*/api/v1/work-orders", ({ request }) => {
      const url = new URL(request.url);
      listRequests.push(url);
      const statusFilter = url.searchParams
        .getAll("status")
        .flatMap((value) => value.split(","));
      const items = statusFilter.length
        ? workOrderListItems.filter((item) => statusFilter.includes(item.status))
        : workOrderListItems.slice(0, 2);
      return HttpResponse.json({ items, limit: 50, offset: 0, total: items.length });
    }),
    http.get("*/api/daily-work-plans", () =>
      HttpResponse.json({
        items: [
          {
            id: "44444444-4444-4444-8444-444444444444",
            branch_id: "11111111-1111-4111-8111-111111111111",
            mechanic_id: "22222222-2222-4222-8222-222222222222",
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
            branch_id: "11111111-1111-4111-8111-111111111111",
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
      branches: ["11111111-1111-4111-8111-111111111111"],
    });

    expect(
      await screen.findByRole("heading", { name: "업무 허브", level: 1 }),
    ).toBeVisible();
    expect(screen.getByText("업무 객체 중심 실행 흐름")).toBeVisible();
    expect(await screen.findByText("20260612-002 승인 검토")).toBeVisible();
    expect(screen.getByText("P1 현장 대화")).toBeVisible();
    expect(screen.getByText("부품 입고 확인")).toBeVisible();
    expect(screen.getByRole("link", { name: "승인센터에서 검토" })).toHaveAttribute(
      "href",
      "/approvals",
    );

    await user.click(screen.getByRole("button", { name: "승인" }));

    expect(screen.getByText("20260612-002 승인 검토")).toBeVisible();
    expect(screen.queryByText("부품 입고 확인")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(
        listRequests.some(
          (url) =>
            url.search.includes("REPORT_SUBMITTED") &&
            url.search.includes("ADMIN_REVIEW"),
        ),
      ).toBe(true);
    });
  });

  it("keeps a mechanic dashboard scoped to assigned work and hides admin-only modules", async () => {
    installHappyHandlers();

    renderPage({
      access_token: "mechanic-token",
      roles: ["MECHANIC"],
      branches: ["11111111-1111-4111-8111-111111111111"],
    });

    expect(await screen.findByText("내 작업, 계획업무, 대화, 티켓을 하루·주간 실행 흐름으로 묶어 보여줍니다.")).toBeVisible();

    await waitFor(() => {
      expect(
        listRequests.some((url) => url.searchParams.get("assigned_to") === "me"),
      ).toBe(true);
    });
    expect(
      listRequests.some((url) => url.search.includes("REPORT_SUBMITTED")),
    ).toBe(false);
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
      branches: ["11111111-1111-4111-8111-111111111111"],
    });

    expect(await screen.findByText(/일부 원천을 불러오지 못했습니다/)).toBeVisible();
    expect(await screen.findByText("20260612-002 승인 검토")).toBeVisible();
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
      branches: ["11111111-1111-4111-8111-111111111111"],
    });

    expect(await screen.findByText("데이터를 불러오지 못했습니다.")).toBeVisible();
  });
});
