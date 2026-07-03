import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createConsoleApiClient } from "../api/client";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { AuthContext } from "../context/auth";
import { ko } from "../i18n/ko";
import { PayrollPage } from "./PayrollPage";

const copy = ko.payroll;

const server = setupServer();

const adminSession: AuthSession = {
  access_token: "admin-token",
  user_id: "admin-user",
  roles: ["ADMIN"],
  branches: [],
};

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

function makeExitCase(certificationStatus: "CERTIFIED" | "UNCERTIFIED_DRAFT") {
  return {
    id: "exit-case-1",
    employee_id: "employee-1",
    employee_name: "Exit Employee",
    employee_number: "A-002",
    company: "KNL",
    org_unit: "Operations",
    worksite_name: "Miryang",
    branch_id: "branch-1",
    branch_name: "Miryang",
    absence_alert_id: null,
    status: "SETTLEMENT_READY",
    effective_exit_date: "2026-06-30",
    site_manager_note: "Confirmed by site manager",
    reported_by: "site-manager",
    reported_at: "2026-06-30T00:00:00Z",
    hr_confirmed_by: "hr-manager",
    hr_confirmed_at: "2026-06-30T01:00:00Z",
    hq_confirmed_by: null,
    hq_confirmed_at: null,
    approval_submitted_by: null,
    approval_submitted_at: null,
    settlement_package: {
      id: "package-1",
      status: "READY_FOR_APPROVAL",
      service_days: 2374,
      average_wage_period_start: "2026-04-01",
      average_wage_period_end: "2026-06-30",
      average_wage_calendar_days: 91,
      average_wage_total_won: 9_000_000,
      average_daily_wage_milliwon: 98_901_099,
      severance_pay_won: 6_500_000,
      missing_source_fields: [],
      statutory_basis: {},
      insurance_loss_payload: { certification_status: certificationStatus },
      approval_payload: { certification_status: certificationStatus },
      certification_status: certificationStatus,
      generated_at: "2026-06-30T02:00:00Z",
      submitted_by: null,
      submitted_at: null,
    },
    next_actions: [],
  };
}

function makeDashboard(certificationStatus: "CERTIFIED" | "UNCERTIFIED_DRAFT") {
  return {
    summary: {
      open_absence_alerts: 0,
      exit_cases_pending_hr: 0,
      settlement_needs_source: 0,
      settlement_ready: 1,
      approval_drafts: 0,
      submitted: 0,
    },
    alerts: [],
    exit_cases: [makeExitCase(certificationStatus)],
  };
}

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
        <PayrollPage />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

function mockPayrollEndpoints(dashboard: unknown) {
  server.use(
    http.get("*/api/v1/hr/readiness-summary", () =>
      HttpResponse.json(readinessSummary),
    ),
    http.get("*/api/v1/hr/attendance-summary", () =>
      HttpResponse.json({ items: [], total: 0, limit: 1000, offset: 0 }),
    ),
    http.get("*/api/v1/employees", () =>
      HttpResponse.json({ items: [], total: 0, limit: 1000, offset: 0 }),
    ),
    http.get("*/api/v1/hr/absence-exit-dashboard", () =>
      HttpResponse.json(dashboard),
    ),
  );
}

describe("PayrollPage exit settlement panel", () => {
  it("renders the uncertified-draft label when the settlement package is UNCERTIFIED_DRAFT", async () => {
    mockPayrollEndpoints(makeDashboard("UNCERTIFIED_DRAFT"));

    renderPage();

    expect(
      await screen.findByText(copy.exitSettlement.fields.severancePay),
    ).toBeVisible();
    expect(
      screen.getByText(copy.exitSettlement.fields.uncertifiedDraftLabel),
    ).toBeVisible();
  });

  it("does not render the uncertified-draft label when the settlement package is CERTIFIED", async () => {
    mockPayrollEndpoints(makeDashboard("CERTIFIED"));

    renderPage();

    expect(
      await screen.findByText(copy.exitSettlement.fields.severancePay),
    ).toBeVisible();
    expect(
      screen.queryByText(copy.exitSettlement.fields.uncertifiedDraftLabel),
    ).not.toBeInTheDocument();
  });

  it("enters wage source, drafts the settlement, and surfaces the severance figure with the draft label", async () => {
    const user = userEvent.setup();
    const draftBodies: Array<{ id: string; body: unknown }> = [];
    const wage = copy.exitSettlement.wageSource;

    // A confirmed case (HQ_CONFIRMED by a distinct actor) that still needs its
    // average-wage source before a severance figure exists.
    const confirmedNoPackage = {
      ...makeExitCase("UNCERTIFIED_DRAFT"),
      id: "exit-case-9",
      status: "HQ_CONFIRMED",
      hq_confirmed_by: "hq-exec",
      hq_confirmed_at: "2026-06-30T02:00:00Z",
      settlement_package: null,
    };
    const beforeDraft = {
      summary: {
        open_absence_alerts: 0,
        exit_cases_pending_hr: 0,
        settlement_needs_source: 1,
        settlement_ready: 0,
        approval_drafts: 0,
        submitted: 0,
      },
      alerts: [],
      exit_cases: [confirmedNoPackage],
    };
    const afterDraft = {
      ...beforeDraft,
      summary: { ...beforeDraft.summary, settlement_needs_source: 0, approval_drafts: 1 },
      exit_cases: [
        { ...makeExitCase("UNCERTIFIED_DRAFT"), id: "exit-case-9", status: "APPROVAL_DRAFTED" },
      ],
    };
    let drafted = false;

    server.use(
      http.get("*/api/v1/hr/readiness-summary", () =>
        HttpResponse.json(readinessSummary),
      ),
      http.get("*/api/v1/hr/attendance-summary", () =>
        HttpResponse.json({ items: [], total: 0, limit: 1000, offset: 0 }),
      ),
      http.get("*/api/v1/employees", () =>
        HttpResponse.json({ items: [], total: 0, limit: 1000, offset: 0 }),
      ),
      http.get("*/api/v1/hr/absence-exit-dashboard", () =>
        HttpResponse.json(drafted ? afterDraft : beforeDraft),
      ),
      http.post(
        "*/api/v1/hr/exit-cases/:id/approval-draft",
        async ({ params, request }) => {
          draftBodies.push({ id: String(params.id), body: await request.json() });
          drafted = true;
          return HttpResponse.json(afterDraft.exit_cases[0]);
        },
      ),
    );

    renderPage();

    expect(await screen.findByText(wage.title)).toBeVisible();

    fireEvent.change(screen.getByLabelText(wage.periodStart), {
      target: { value: "2026-04-01" },
    });
    fireEvent.change(screen.getByLabelText(wage.periodEnd), {
      target: { value: "2026-06-30" },
    });
    fireEvent.change(screen.getByLabelText(wage.calendarDays), {
      target: { value: "91" },
    });
    fireEvent.change(screen.getByLabelText(wage.totalWon), {
      target: { value: "9000000" },
    });
    fireEvent.change(screen.getByLabelText(wage.monthlyOrdinaryWage), {
      target: { value: "3000000" },
    });

    await user.click(screen.getByRole("button", { name: wage.generateDraft }));

    await waitFor(() => {
      expect(draftBodies).toHaveLength(1);
    });
    expect(draftBodies[0]).toEqual({
      id: "exit-case-9",
      body: {
        submit: false,
        settlement_input: {
          average_wage_period_start: "2026-04-01",
          average_wage_period_end: "2026-06-30",
          average_wage_calendar_days: 91,
          average_wage_total_won: 9_000_000,
          monthly_ordinary_wage_won: 3_000_000,
        },
      },
    });

    expect(await screen.findByText(wage.draftCreated)).toBeVisible();
    expect(
      screen.getByText(copy.exitSettlement.fields.uncertifiedDraftLabel),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: wage.submit })).toBeVisible();
  });

  it("submits the ready settlement package for approval", async () => {
    const user = userEvent.setup();
    const submitBodies: Array<{ id: string; body: unknown }> = [];
    const wage = copy.exitSettlement.wageSource;

    const submitted = {
      ...makeDashboard("UNCERTIFIED_DRAFT"),
      summary: {
        open_absence_alerts: 0,
        exit_cases_pending_hr: 0,
        settlement_needs_source: 0,
        settlement_ready: 0,
        approval_drafts: 0,
        submitted: 1,
      },
      exit_cases: [{ ...makeExitCase("UNCERTIFIED_DRAFT"), status: "SUBMITTED" }],
    };
    let done = false;

    server.use(
      http.get("*/api/v1/hr/readiness-summary", () =>
        HttpResponse.json(readinessSummary),
      ),
      http.get("*/api/v1/hr/attendance-summary", () =>
        HttpResponse.json({ items: [], total: 0, limit: 1000, offset: 0 }),
      ),
      http.get("*/api/v1/employees", () =>
        HttpResponse.json({ items: [], total: 0, limit: 1000, offset: 0 }),
      ),
      http.get("*/api/v1/hr/absence-exit-dashboard", () =>
        HttpResponse.json(done ? submitted : makeDashboard("UNCERTIFIED_DRAFT")),
      ),
      http.post(
        "*/api/v1/hr/exit-cases/:id/approval-draft",
        async ({ params, request }) => {
          submitBodies.push({ id: String(params.id), body: await request.json() });
          done = true;
          return HttpResponse.json(submitted.exit_cases[0]);
        },
      ),
    );

    renderPage();

    await user.click(await screen.findByRole("button", { name: wage.submit }));

    await waitFor(() => {
      expect(submitBodies).toHaveLength(1);
    });
    expect(submitBodies[0]).toEqual({ id: "exit-case-1", body: { submit: true } });
    expect(await screen.findByText(wage.submitDone)).toBeVisible();
  });
});
