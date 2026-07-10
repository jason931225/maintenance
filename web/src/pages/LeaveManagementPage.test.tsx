import { fireEvent, render, screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createConsoleApiClient } from "../api/client";
import { KO_CONSOLE_LEAVE as S } from "../console/leave";
import { WindowManagerProvider } from "../console/window";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { AuthContext } from "../context/auth";
import { LeaveManagementPage } from "./LeaveManagementPage";

const server = setupServer();

const adminSession: AuthSession = {
  access_token: "admin-token",
  user_id: "admin-user",
  roles: ["ADMIN"],
  branches: [],
};

function makeEmployee(overrides: Record<string, unknown>) {
  return {
    company: "KNL",
    org_unit: "정비1팀",
    position: "대리",
    hire_date: "2024-01-02",
    exit_date: null,
    status: "ACTIVE",
    identity_resolution_strategy: "employee_number",
    identity_resolution_confidence: "high",
    identity_review_required: false,
    identity_name_only_merge: false,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

const employees = [
  makeEmployee({
    id: "employee-1",
    name: "김현장",
    employee_number: "A-001",
    leave_accrued: "15",
    leave_used: "4",
    leave_remaining: "11",
  }),
  makeEmployee({
    id: "employee-2",
    name: "이정비",
    employee_number: "A-002",
    leave_accrued: "15",
    leave_used: "15",
    leave_remaining: "0",
  }),
  makeEmployee({
    id: "employee-3",
    name: "박기사",
    employee_number: "A-003",
    leave_accrued: "15",
    leave_used: "5",
    leave_remaining: "10",
  }),
];

const leaveBalances = {
  items: employees.map((employee) => ({
    id: employee.id,
    company: employee.company,
    name: employee.name,
    employee_number: employee.employee_number,
    org_unit: employee.org_unit,
    position: employee.position,
    leave_accrued: employee.leave_accrued,
    leave_used: employee.leave_used,
    leave_remaining: employee.leave_remaining,
  })),
  total: 3,
  limit: 1000,
  offset: 0,
  summary: { accrued: "45", used: "24", remaining: "21" },
};

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
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

function useHandlers() {
  server.use(
    http.get("*/api/v1/employees", () =>
      HttpResponse.json({ items: employees, total: 3, limit: 1000, offset: 0 }),
    ),
    http.get("*/api/v1/hr/leave-balances", () => HttpResponse.json(leaveBalances)),
  );
}

function renderPage() {
  return render(
    <AuthContext.Provider value={makeAuthContext()}>
      <MemoryRouter>
        <WindowManagerProvider>
          <LeaveManagementPage />
        </WindowManagerProvider>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe("LeaveManagementPage", () => {
  it("renders annual leave balances with approval, attendance, and payroll links", async () => {
    useHandlers();
    renderPage();

    expect(
      await screen.findByRole("heading", { name: "연차관리", level: 1 }),
    ).toBeVisible();
    expect(screen.getByText("연차 현황")).toBeVisible();
    expect(screen.getByText("인원별 연차 원장")).toBeVisible();
    expect(screen.getByText("사용촉진·사용계획서 알림")).toBeVisible();
    expect(screen.getByRole("link", { name: /연차신청서/ })).toHaveAttribute(
      "href",
      "/approvals?template=annual-leave",
    );
  });

  it("ledger rows are objDrag sources and open the ObjectCard right pin (§4.7-3)", async () => {
    useHandlers();
    renderPage();

    const code = await screen.findByRole("button", { name: S.openObject("JL-A001") });
    expect(code).toHaveAttribute("draggable", "true");

    fireEvent.click(code);
    const pin = screen.getByRole("region", { name: S.objects.ledgerTitle("김현장") });
    expect(within(pin).getByText("JL-A001")).toBeVisible();
  });

  it("every stat drills: 촉진 대상 filters the ledger (§4-11)", async () => {
    useHandlers();
    renderPage();

    const ledgerRegion = await screen.findByRole("region", { name: "인원별 연차 원장" });
    expect(within(ledgerRegion).getByText("이정비")).toBeVisible();

    const drill = screen.getByRole("button", {
      name: S.stats.drill(S.stats.promotionTargets),
    });
    fireEvent.click(drill);
    expect(drill).toHaveAttribute("aria-pressed", "true");
    // 이정비 has 0 remaining days → not a 촉진 대상 → filtered out.
    expect(within(ledgerRegion).queryByText("이정비")).toBeNull();
  });

  it("신청 생성 is fail-closed (§4-19) and adds a state-derived request (§4-22/§4-25-⑥)", async () => {
    useHandlers();
    renderPage();

    const selfRegion = await screen.findByRole("region", { name: S.self.title });
    const form = within(selfRegion).getByRole("form", { name: S.self.formAria });

    fireEvent.submit(form);
    expect(within(selfRegion).getByRole("alert")).toHaveTextContent(S.self.required);
    expect(within(selfRegion).queryByText("AP-1211")).toBeNull();

    fireEvent.change(within(selfRegion).getByLabelText(S.self.reasonLabel), {
      target: { value: "annual" },
    });
    fireEvent.change(within(selfRegion).getByLabelText(S.self.startLabel), {
      target: { value: "2026-07-20" },
    });
    fireEvent.change(within(selfRegion).getByLabelText(S.self.endLabel), {
      target: { value: "2026-07-21" },
    });
    fireEvent.submit(form);

    const myRequests = within(selfRegion).getByRole("list", { name: S.self.myRequests });
    expect(within(myRequests).getByText("AP-1211")).toBeVisible();
    expect(within(myRequests).getByText(S.requestState.submitted)).toBeVisible();
    expect(within(selfRegion).queryByRole("alert")).toBeNull();
  });
});
