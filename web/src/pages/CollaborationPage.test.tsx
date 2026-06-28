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

const server = setupServer(
  http.get("*/api/v1/work-orders", ({ request }) => {
    const url = new URL(request.url);
    apiRequests.push(url);
    const statusFilter = url.searchParams
      .getAll("status")
      .flatMap((value) => value.split(","));
    const items = statusFilter.length
      ? weekWorkOrderItems.filter((workOrder) =>
          statusFilter.includes(workOrder.status),
        )
      : weekWorkOrderItems;
    return HttpResponse.json({ items, limit: 20, offset: 0, total: items.length });
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
    expect(screen.getByText("승인 대기 20260612-002")).toBeVisible();
    expect(screen.getByText("출고 일정 확인 요청")).toBeVisible();
    expect(screen.getByText("정비팀 공지")).toBeVisible();
    expect(screen.getByText("급여명세서 발송")).toBeVisible();
    expect(screen.getByText("발행은 백엔드 폴 엔진 준비 후 허용")).toBeVisible();
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
      expect(
        apiRequests.some(
          (url) =>
            url.pathname === "/api/v1/work-orders" &&
            url.search.includes("ADMIN_REVIEW"),
        ),
      ).toBe(true);
    });
  });

  it("keeps mechanics in the collaboration hub without leaking mail or approval queues", async () => {
    renderCollaboration(mechanicSession);

    expect(
      await screen.findByRole("heading", { name: "협업 허브", level: 1 }),
    ).toBeVisible();
    expect(screen.getByText("정비팀 공지")).toBeVisible();
    expect(screen.getAllByText("이 역할은 회사 메일함 사용 권한이 없습니다.")).toHaveLength(2);
    expect(screen.queryByText("급여명세서 발송")).not.toBeInTheDocument();
    expect(screen.queryByText("승인 대기 20260612-002")).not.toBeInTheDocument();

    await waitFor(() => {
      expect(
        apiRequests.some((url) => url.pathname === "/api/v1/mail/threads"),
      ).toBe(false);
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
