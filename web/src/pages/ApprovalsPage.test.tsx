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

const listRequests: URL[] = [];
const dailyRequests: URL[] = [];
const server = setupServer();

const requestedPlanId = "44444444-4444-4444-8444-444444444444";
const approvedPlanId = "55555555-5555-4555-8555-555555555555";

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
  listRequests.length = 0;
  dailyRequests.length = 0;
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
        : workOrderListItems;
      return HttpResponse.json({ items, limit: 100, offset: 0, total: items.length });
    }),
    http.get("*/api/daily-work-plans", ({ request }) => {
      dailyRequests.push(new URL(request.url));
      return HttpResponse.json({
        items: [
          {
            id: requestedPlanId,
            branch_id: branchId,
            mechanic_id: primaryMechanicId,
            plan_date: "2026-06-29",
            status: "REQUESTED",
          },
          {
            id: approvedPlanId,
            branch_id: branchId,
            mechanic_id: primaryMechanicId,
            plan_date: "2026-06-30",
            status: "APPROVED",
          },
        ],
      });
    }),
  );
}

describe("ApprovalsPage", () => {
  it("renders an approval command center across work reports, daily plans, and target-change review", async () => {
    installHappyHandlers();

    renderPage();

    expect(
      await screen.findByRole("heading", { name: "승인 대기", level: 1 }),
    ).toBeVisible();
    expect(await screen.findByText("승인 커맨드 센터")).toBeVisible();
    expect(screen.getByText("작업 보고 승인")).toBeVisible();
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

    await waitFor(() => {
      expect(
        listRequests.some(
          (url) =>
            url.search.includes("REPORT_SUBMITTED") &&
            url.search.includes("ADMIN_REVIEW"),
        ),
      ).toBe(true);
      expect(dailyRequests.length).toBe(1);
    });
  });

  it("keeps work-order approvals visible when the daily-plan source fails", async () => {
    installHappyHandlers();
    server.use(
      http.get("*/api/daily-work-plans", () =>
        HttpResponse.json({ error: "daily offline" }, { status: 503 }),
      ),
    );

    renderPage();

    expect(await screen.findByText("일부 승인 원천을 불러오지 못했습니다: 계획업무")).toBeVisible();
    expect(await screen.findByText("20260612-002")).toBeVisible();
    expect(screen.queryByText("이 화면을 표시하지 못했습니다.")).not.toBeInTheDocument();
  });

  it("focuses the work-order approval linked from the work hub", async () => {
    installHappyHandlers();

    renderPage([
      "/approvals?source=work-order&focus=77777777-7777-4777-8777-777777777777",
    ]);

    expect(await screen.findByText("업무 허브에서 연결된 승인 건을 강조했습니다.")).toBeVisible();
    const focusedApproval = screen.getByLabelText(/20260612-002 연결된 승인 건/);
    expect(focusedApproval).toHaveAttribute(
      "id",
      "approval-work-order-77777777-7777-4777-8777-777777777777",
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
