import { render, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createConsoleApiClient } from "../api/client";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { AuthContext } from "../context/auth";
import { InsuranceAssistPage } from "./InsuranceAssistPage";

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
    name: "김신규",
    employee_number: "A-001",
    org_unit: "정비1팀",
    position: "기사",
    hire_date: new Date().toISOString().slice(0, 10),
    exit_date: null,
    status: "ACTIVE",
    identity_resolution_strategy: "employee_number",
    identity_resolution_confidence: "high",
    identity_review_required: false,
    identity_name_only_merge: false,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
  },
  {
    id: "employee-2",
    company: "KNL",
    name: "이퇴사",
    employee_number: "A-002",
    org_unit: "운영팀",
    position: "과장",
    hire_date: "2022-03-01",
    exit_date: "2026-07-01",
    status: "EXITED",
    identity_resolution_strategy: "employee_number",
    identity_resolution_confidence: "high",
    identity_review_required: false,
    identity_name_only_merge: false,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
  },
  {
    id: "employee-3",
    company: "KNL",
    name: "박보완",
    employee_number: null,
    org_unit: "관리팀",
    position: "사원",
    hire_date: null,
    exit_date: null,
    status: "ACTIVE",
    identity_resolution_strategy: "source_row_fingerprint",
    identity_resolution_confidence: "low",
    identity_review_required: true,
    identity_name_only_merge: false,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
  },
];

const readinessSummary = {
  imports: {
    runs: 1,
    applied_runs: 1,
    input_rows: 3,
    candidate_rows: 3,
    preserved_rows: 0,
    ledger_rows: 3,
    latest_import_at: "2026-07-01T00:00:00Z",
  },
  payroll: {
    draft_runs: 1,
    blocked_runs: 0,
    calculation_enabled_runs: 1,
    draft_lines: 3,
    payroll_source_rows: 3,
    attendance_source_rows: 2,
    attendance_event_links: 2,
    attendance_material_refs: 2,
    gross_pay_source_lines: 3,
    net_pay_source_lines: 3,
    latest_status: "READY",
    latest_source_label: "2026-07",
    latest_period_start: "2026-07-01",
    latest_period_end: "2026-07-31",
    latest_updated_at: "2026-07-01T00:00:00Z",
  },
  annual_leave: {
    obligations: 0,
    usage_promotion_required: 0,
    payout_review_required: 0,
    needs_review: 0,
    remaining_days: "0",
  },
  attendance: {
    durable_events: 2,
    self_service_records: 2,
    payroll_material_refs: 2,
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
        <InsuranceAssistPage />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe("InsuranceAssistPage", () => {
  it("renders acquisition, loss, and missing-field insurance filing assistance", async () => {
    server.use(
      http.get("*/api/v1/employees", () =>
        HttpResponse.json({ items: employees, total: 3, limit: 1000, offset: 0 }),
      ),
      http.get("*/api/v1/hr/readiness-summary", () =>
        HttpResponse.json(readinessSummary),
      ),
    );

    renderPage();

    expect(
      await screen.findByRole("heading", { name: "보험신고 지원", level: 1 }),
    ).toBeVisible();
    expect(screen.getByText("보험신고 준비 현황")).toBeVisible();
    expect(screen.getAllByText("취득신고 준비")[0]).toBeVisible();
    expect(screen.getAllByText("상실신고 준비")[0]).toBeVisible();
    expect(screen.getAllByText("정보 보완")[0]).toBeVisible();
    expect(screen.getByRole("link", { name: "안내 메일" })).toHaveAttribute(
      "href",
      "/mail?compose=insurance",
    );
  });
});
