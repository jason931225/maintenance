import { render, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createConsoleApiClient } from "../api/client";
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

const employees = [
  {
    id: "employee-1",
    company: "KNL",
    name: "김현장",
    employee_number: "A-001",
    org_unit: "정비1팀",
    position: "대리",
    hire_date: "2024-01-02",
    exit_date: null,
    status: "ACTIVE",
    leave_accrued: "15",
    leave_used: "4",
    leave_remaining: "11",
    identity_resolution_strategy: "employee_number",
    identity_resolution_confidence: "high",
    identity_review_required: false,
    identity_name_only_merge: false,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
  },
];

const leaveBalances = {
  items: [
    {
      id: "employee-1",
      company: "KNL",
      name: "김현장",
      employee_number: "A-001",
      org_unit: "정비1팀",
      position: "대리",
      leave_accrued: "15",
      leave_used: "4",
      leave_remaining: "11",
    },
  ],
  total: 1,
  limit: 1000,
  offset: 0,
  summary: { accrued: "15", used: "4", remaining: "11" },
};

const readinessSummary = {
  imports: {
    runs: 1,
    applied_runs: 1,
    input_rows: 1,
    candidate_rows: 1,
    preserved_rows: 0,
    ledger_rows: 1,
    latest_import_at: "2026-07-01T00:00:00Z",
  },
  payroll: {
    draft_runs: 1,
    blocked_runs: 0,
    calculation_enabled_runs: 1,
    draft_lines: 1,
    payroll_source_rows: 1,
    attendance_source_rows: 1,
    attendance_event_links: 1,
    attendance_material_refs: 1,
    gross_pay_source_lines: 1,
    net_pay_source_lines: 1,
    latest_status: "READY",
    latest_source_label: "2026-07",
    latest_period_start: "2026-07-01",
    latest_period_end: "2026-07-31",
    latest_updated_at: "2026-07-01T00:00:00Z",
  },
  annual_leave: {
    obligations: 1,
    usage_promotion_required: 1,
    payout_review_required: 0,
    needs_review: 1,
    remaining_days: "11",
  },
  attendance: {
    durable_events: 1,
    self_service_records: 1,
    payroll_material_refs: 1,
  },
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

function renderPage() {
  return render(
    <AuthContext.Provider value={makeAuthContext()}>
      <MemoryRouter>
        <LeaveManagementPage />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe("LeaveManagementPage", () => {
  it("renders annual leave balances with approval, attendance, and payroll links", async () => {
    server.use(
      http.get("*/api/v1/employees", () =>
        HttpResponse.json({ items: employees, total: 1, limit: 1000, offset: 0 }),
      ),
      http.get("*/api/v1/hr/leave-balances", () =>
        HttpResponse.json(leaveBalances),
      ),
      http.get("*/api/v1/hr/readiness-summary", () =>
        HttpResponse.json(readinessSummary),
      ),
    );

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
});
