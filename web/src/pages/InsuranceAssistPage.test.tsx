import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createConsoleApiClient } from "../api/client";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { AuthContext } from "../context/auth";
import { insuranceAssistKo as copy } from "../i18n/hrWorkflows";
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
    active_close_runs: 1,
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

function makeSettlementExitCase(
  status: string,
  certificationStatus: "CERTIFIED" | "UNCERTIFIED_DRAFT" | null,
) {
  return {
    id: "exit-case-9",
    employee_id: "employee-2",
    employee_name: "Exit Employee",
    employee_number: "A-002",
    company: "KNL",
    org_unit: "Operations",
    worksite_name: "Miryang",
    branch_id: "branch-1",
    branch_name: "Miryang",
    absence_alert_id: null,
    status,
    effective_exit_date: "2026-06-30",
    site_manager_note: "Confirmed by site manager",
    reported_by: "site-manager",
    reported_at: "2026-06-30T00:00:00Z",
    hr_confirmed_by: "hr-manager",
    hr_confirmed_at: "2026-06-30T01:00:00Z",
    hq_confirmed_by: "hq-exec",
    hq_confirmed_at: "2026-06-30T02:00:00Z",
    approval_submitted_by: null,
    approval_submitted_at: null,
    settlement_package: certificationStatus
      ? {
          id: "package-9",
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
        }
      : null,
    next_actions: [],
  };
}

function makeSettlementDashboard(
  exitCase: ReturnType<typeof makeSettlementExitCase>,
  overrides: Partial<{
    settlement_needs_source: number;
    settlement_ready: number;
    approval_drafts: number;
    submitted: number;
  }> = {},
) {
  return {
    summary: {
      open_absence_alerts: 0,
      exit_cases_pending_hr: 0,
      settlement_needs_source: 0,
      settlement_ready: 0,
      approval_drafts: 0,
      submitted: 0,
      ...overrides,
    },
    alerts: [],
    exit_cases: [exitCase],
  };
}

const absenceExitDashboard = {
  summary: {
    open_absence_alerts: 0,
    exit_cases_pending_hr: 0,
    settlement_needs_source: 0,
    settlement_ready: 0,
    approval_drafts: 0,
    submitted: 0,
  },
  alerts: [],
  exit_cases: [],
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
      http.get("*/api/v1/hr/absence-exit-dashboard", () =>
        HttpResponse.json(absenceExitDashboard),
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

  it("keeps the roster visible when the absence-exit dashboard is unavailable", async () => {
    server.use(
      http.get("*/api/v1/employees", () =>
        HttpResponse.json({ items: employees, total: 3, limit: 1000, offset: 0 }),
      ),
      http.get("*/api/v1/hr/readiness-summary", () =>
        HttpResponse.json(readinessSummary),
      ),
      http.get("*/api/v1/hr/absence-exit-dashboard", () =>
        HttpResponse.json({ error: "temporarily unavailable" }, { status: 503 }),
      ),
    );

    renderPage();

    expect(
      await screen.findByRole("heading", { name: copy.title, level: 1 }),
    ).toBeVisible();
    expect(screen.getByText(copy.overview.title)).toBeVisible();
    expect(screen.queryByText(copy.exitWorkflow.title)).not.toBeInTheDocument();
  });

  it("reports and confirms exit cases from the absence-exit workflow panel", async () => {
    const user = userEvent.setup();
    const reportBodies: unknown[] = [];
    const confirmBodies: Array<{ id: string; body: unknown }> = [];
    let dashboard = {
      summary: {
        open_absence_alerts: 1,
        exit_cases_pending_hr: 1,
        settlement_needs_source: 0,
        settlement_ready: 0,
        approval_drafts: 0,
        submitted: 0,
      },
      alerts: [
        {
          id: "alert-1",
          employee_id: "employee-1",
          employee_name: "Workflow Employee",
          employee_number: "A-001",
          company: "KNL",
          org_unit: "Operations",
          worksite_name: "Miryang",
          branch_id: "branch-1",
          branch_name: "Miryang",
          work_date: "2026-07-02",
          source: "attendance_direct_import",
          status: "OPEN",
          severity: "WARNING",
          audience_roles: ["site_manager", "payroll_manager"],
          signal_payload: {},
          notification_title: "Absence warning",
          notification_message: "No clock-in was recorded.",
          link_href: "/attendance",
          exit_case_id: null,
          detected_at: "2026-07-02T00:00:00Z",
        },
      ],
      exit_cases: [
        {
          id: "exit-case-1",
          employee_id: "employee-2",
          employee_name: "Exit Employee",
          employee_number: "A-002",
          company: "KNL",
          org_unit: "Operations",
          worksite_name: "Miryang",
          branch_id: "branch-1",
          branch_name: "Miryang",
          absence_alert_id: "alert-2",
          status: "REPORTED",
          effective_exit_date: "2026-07-01",
          site_manager_note: "Confirmed by site manager",
          reported_by: "site-manager",
          reported_at: "2026-07-02T00:00:00Z",
          hr_confirmed_by: null,
          hr_confirmed_at: null,
          hq_confirmed_by: null,
          hq_confirmed_at: null,
          approval_submitted_by: null,
          approval_submitted_at: null,
          settlement_package: null,
          next_actions: [],
        },
      ],
    };

    server.use(
      http.get("*/api/v1/employees", () =>
        HttpResponse.json({ items: employees, total: 3, limit: 1000, offset: 0 }),
      ),
      http.get("*/api/v1/hr/readiness-summary", () =>
        HttpResponse.json(readinessSummary),
      ),
      http.get("*/api/v1/hr/absence-exit-dashboard", () =>
        HttpResponse.json(dashboard),
      ),
      http.post("*/api/v1/hr/exit-cases", async ({ request }) => {
        reportBodies.push(await request.json());
        dashboard = {
          ...dashboard,
          alerts: dashboard.alerts.map((alert) => ({
            ...alert,
            exit_case_id: "exit-case-created",
          })),
        };
        return HttpResponse.json(dashboard.exit_cases[0]);
      }),
      http.post("*/api/v1/hr/exit-cases/:id/confirm", async ({ params, request }) => {
        confirmBodies.push({
          id: String(params.id),
          body: await request.json(),
        });
        dashboard = {
          ...dashboard,
          summary: {
            ...dashboard.summary,
            exit_cases_pending_hr: 0,
            settlement_ready: 1,
          },
          exit_cases: dashboard.exit_cases.map((exitCase) => ({
            ...exitCase,
            status: "SETTLEMENT_READY",
          })),
        };
        return HttpResponse.json(dashboard.exit_cases[0]);
      }),
    );

    renderPage();

    expect(await screen.findByText(copy.exitWorkflow.title)).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: copy.exitWorkflow.createExitCase }),
    );
    await waitFor(() => {
      expect(reportBodies).toHaveLength(1);
    });
    expect(reportBodies).toEqual([
      expect.objectContaining({
        employee_id: "employee-1",
        branch_id: "branch-1",
        absence_alert_id: "alert-1",
        effective_exit_date: "2026-07-02",
      }),
    ]);
    expect(await screen.findByText(copy.exitWorkflow.reportCreated)).toBeVisible();

    await user.click(screen.getByRole("button", { name: copy.exitWorkflow.hrConfirm }));
    await waitFor(() => {
      expect(confirmBodies).toHaveLength(1);
    });
    expect(confirmBodies).toEqual([
      expect.objectContaining({
        id: "exit-case-1",
        body: expect.objectContaining({
          decision: "CONFIRM",
          hq_confirmation: false,
        }),
      }),
    ]);
    expect(await screen.findByText(copy.exitWorkflow.confirmDone)).toBeVisible();
    expect(screen.getByText(copy.exitWorkflow.status.SETTLEMENT_READY)).toBeVisible();
  });

  it("offers HQ confirmation only after a distinct HR confirmation (HR_CONFIRMED)", async () => {
    const user = userEvent.setup();
    const confirmBodies: Array<{ id: string; body: unknown }> = [];
    const hrConfirmedCase = {
      id: "exit-case-2",
      employee_id: "employee-2",
      employee_name: "Exit Employee",
      employee_number: "A-002",
      company: "KNL",
      org_unit: "Operations",
      worksite_name: "Miryang",
      branch_id: "branch-1",
      branch_name: "Miryang",
      absence_alert_id: "alert-2",
      status: "HR_CONFIRMED",
      effective_exit_date: "2026-07-01",
      site_manager_note: "Confirmed by site manager",
      reported_by: "site-manager",
      reported_at: "2026-07-02T00:00:00Z",
      hr_confirmed_by: "hr-manager",
      hr_confirmed_at: "2026-07-02T01:00:00Z",
      hq_confirmed_by: null,
      hq_confirmed_at: null,
      approval_submitted_by: null,
      approval_submitted_at: null,
      settlement_package: null,
      next_actions: [],
    };
    const dashboard = {
      summary: {
        open_absence_alerts: 0,
        exit_cases_pending_hr: 1,
        settlement_needs_source: 0,
        settlement_ready: 0,
        approval_drafts: 0,
        submitted: 0,
      },
      alerts: [],
      exit_cases: [hrConfirmedCase],
    };

    server.use(
      http.get("*/api/v1/employees", () =>
        HttpResponse.json({ items: employees, total: 3, limit: 1000, offset: 0 }),
      ),
      http.get("*/api/v1/hr/readiness-summary", () =>
        HttpResponse.json(readinessSummary),
      ),
      http.get("*/api/v1/hr/absence-exit-dashboard", () =>
        HttpResponse.json(dashboard),
      ),
      http.post("*/api/v1/hr/exit-cases/:id/confirm", async ({ params, request }) => {
        confirmBodies.push({ id: String(params.id), body: await request.json() });
        return HttpResponse.json({ ...hrConfirmedCase, status: "HQ_CONFIRMED" });
      }),
    );

    renderPage();

    expect(await screen.findByText(copy.exitWorkflow.confirmationTitle)).toBeVisible();
    // The HR-confirm action is not offered again once HR has confirmed; only the
    // HQ tier remains, which the backend restricts to a DIFFERENT actor.
    expect(
      screen.queryByRole("button", { name: copy.exitWorkflow.hrConfirm }),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: copy.exitWorkflow.hqConfirm }),
    );
    await waitFor(() => {
      expect(confirmBodies).toHaveLength(1);
    });
    expect(confirmBodies[0]).toEqual({
      id: "exit-case-2",
      body: expect.objectContaining({ decision: "CONFIRM", hq_confirmation: true }),
    });
  });

  it("enters wage source and drafts the settlement from the insurance-assist mutation surface", async () => {
    const user = userEvent.setup();
    const draftBodies: Array<{ id: string; body: unknown }> = [];
    const wage = copy.exitWorkflow.wageSource;

    // A confirmed case (HQ_CONFIRMED by a distinct actor) that still needs its
    // average-wage source before a severance figure exists.
    const beforeDraft = makeSettlementExitCase("HQ_CONFIRMED", null);
    const afterDraft = makeSettlementExitCase("APPROVAL_DRAFTED", "UNCERTIFIED_DRAFT");
    let drafted = false;

    server.use(
      http.get("*/api/v1/employees", () =>
        HttpResponse.json({ items: employees, total: 3, limit: 1000, offset: 0 }),
      ),
      http.get("*/api/v1/hr/readiness-summary", () =>
        HttpResponse.json(readinessSummary),
      ),
      http.get("*/api/v1/hr/absence-exit-dashboard", () =>
        HttpResponse.json(
          makeSettlementDashboard(drafted ? afterDraft : beforeDraft, {
            settlement_needs_source: drafted ? 0 : 1,
            approval_drafts: drafted ? 1 : 0,
          }),
        ),
      ),
      http.post(
        "*/api/v1/hr/exit-cases/:id/approval-draft",
        async ({ params, request }) => {
          draftBodies.push({ id: String(params.id), body: await request.json() });
          drafted = true;
          return HttpResponse.json(afterDraft);
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
    expect(screen.getByRole("button", { name: wage.submit })).toBeVisible();
  });

  it("submits the ready settlement package for approval from the insurance-assist mutation surface", async () => {
    const user = userEvent.setup();
    const submitBodies: Array<{ id: string; body: unknown }> = [];
    const wage = copy.exitWorkflow.wageSource;

    const readyCase = makeSettlementExitCase("SETTLEMENT_READY", "UNCERTIFIED_DRAFT");
    const submittedCase = makeSettlementExitCase("SUBMITTED", "UNCERTIFIED_DRAFT");
    let done = false;

    server.use(
      http.get("*/api/v1/employees", () =>
        HttpResponse.json({ items: employees, total: 3, limit: 1000, offset: 0 }),
      ),
      http.get("*/api/v1/hr/readiness-summary", () =>
        HttpResponse.json(readinessSummary),
      ),
      http.get("*/api/v1/hr/absence-exit-dashboard", () =>
        HttpResponse.json(
          makeSettlementDashboard(done ? submittedCase : readyCase, {
            settlement_ready: done ? 0 : 1,
            submitted: done ? 1 : 0,
          }),
        ),
      ),
      http.post(
        "*/api/v1/hr/exit-cases/:id/approval-draft",
        async ({ params, request }) => {
          submitBodies.push({ id: String(params.id), body: await request.json() });
          done = true;
          return HttpResponse.json(submittedCase);
        },
      ),
    );

    renderPage();

    await user.click(await screen.findByRole("button", { name: wage.submit }));

    await waitFor(() => {
      expect(submitBodies).toHaveLength(1);
    });
    expect(submitBodies[0]).toEqual({ id: "exit-case-9", body: { submit: true } });
    expect(await screen.findByText(wage.submitDone)).toBeVisible();
  });
});
