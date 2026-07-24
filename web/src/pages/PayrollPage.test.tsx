import { render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

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

const executiveSession: AuthSession = {
  ...adminSession,
  access_token: "executive-token",
  user_id: "executive-user",
  roles: ["EXECUTIVE"],
};

const customPayrollReaderSession: AuthSession = {
  ...adminSession,
  access_token: "custom-payroll-reader-token",
  user_id: "custom-payroll-reader",
  roles: ["ADMIN"],
  feature_grants: ["payroll_run_read"],
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

function makeAuthContext(
  session: AuthSession | null = adminSession,
  api = createConsoleApiClient(session?.access_token),
): AuthContextValue {
  return {
    session: session ?? undefined,
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

function payrollPageTree(
  session: AuthSession | null = adminSession,
  api = createConsoleApiClient(session?.access_token),
) {
  return (
    <AuthContext.Provider value={makeAuthContext(session, api)}>
      <MemoryRouter>
        <PayrollPage />
      </MemoryRouter>
    </AuthContext.Provider>
  );
}

function renderPage(
  session: AuthSession | null = adminSession,
  api = createConsoleApiClient(session?.access_token),
) {
  return render(payrollPageTree(session, api));
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function aggregateApi(readiness: unknown, onPayrollRuns?: () => void) {
  return {
    GET: vi.fn((path: string) => {
      switch (path) {
        case "/api/v1/hr/readiness-summary":
          return Promise.resolve({ data: readiness });
        case "/api/v1/hr/attendance-summary":
          return Promise.resolve({
            data: { items: [], total: 0, limit: 1000, offset: 0 },
          });
        case "/api/v1/employees":
          return Promise.resolve({
            data: { items: [], total: 0, limit: 1000, offset: 0 },
          });
        case "/api/v1/hr/absence-exit-dashboard":
          return Promise.resolve({ data: makeDashboard("CERTIFIED") });
        case "/api/v1/payroll/runs":
          onPayrollRuns?.();
          return Promise.resolve({
            data: { items: [], total: 0, limit: 50, offset: 0 },
          });
        default:
          throw new Error(`unexpected GET ${path}`);
      }
    }),
  } as unknown as ReturnType<typeof createConsoleApiClient>;
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
});

describe("PayrollPage audited close integration", () => {
  it("does not prefetch organization-wide payroll runs for an ADMIN-only session", async () => {
    let runRequests = 0;
    mockPayrollEndpoints(makeDashboard("CERTIFIED"));
    server.use(
      http.get("*/api/v1/payroll/runs", () => {
        runRequests += 1;
        return HttpResponse.json({ items: [], total: 0, limit: 50, offset: 0 });
      }),
    );

    renderPage();
    await screen.findByText(copy.exitSettlement.fields.severancePay);
    await waitFor(() => {
      expect(runRequests).toBe(0);
    });
  });

  it("does not issue a payroll-run request when readiness proves the close queue is empty", async () => {
    let runRequests = 0;
    const emptyReadiness = {
      ...readinessSummary,
      payroll: {
        ...readinessSummary.payroll,
        draft_runs: 0,
        blocked_runs: 0,
        calculation_enabled_runs: 0,
        active_close_runs: 0,
      },
    };
    mockPayrollEndpoints(makeDashboard("CERTIFIED"));
    server.use(
      http.get("*/api/v1/hr/readiness-summary", () =>
        HttpResponse.json(emptyReadiness),
      ),
      http.get("*/api/v1/payroll/runs", () => {
        runRequests += 1;
        return HttpResponse.json({ items: [], total: 0, limit: 50, offset: 0 });
      }),
    );

    renderPage(customPayrollReaderSession);
    await screen.findByRole("heading", { name: copy.title });
    await waitFor(() => {
      expect(runRequests).toBe(0);
    });
    expect(
      screen.queryByRole("heading", { name: "급여 마감 명부" }),
    ).not.toBeInTheDocument();
  });

  it("does not issue a payroll-run request for issued and void history only", async () => {
    let runRequests = 0;
    const terminalHistoryOnly = {
      ...readinessSummary,
      payroll: {
        ...readinessSummary.payroll,
        draft_runs: 2,
        calculation_enabled_runs: 1,
        active_close_runs: 0,
        latest_status: "ISSUED",
      },
    };
    mockPayrollEndpoints(makeDashboard("CERTIFIED"));
    server.use(
      http.get("*/api/v1/hr/readiness-summary", () =>
        HttpResponse.json(terminalHistoryOnly),
      ),
      http.get("*/api/v1/payroll/runs", () => {
        runRequests += 1;
        return HttpResponse.json({ items: [], total: 0, limit: 50, offset: 0 });
      }),
    );

    renderPage(customPayrollReaderSession);
    await screen.findByRole("heading", { name: copy.title });
    await waitFor(() => {
      expect(runRequests).toBe(0);
    });
    expect(
      screen.queryByRole("heading", { name: "급여 마감 명부" }),
    ).not.toBeInTheDocument();
  });

  it("renders the audited close workspace for a signed custom PayrollRunRead hint", async () => {
    let runRequests = 0;
    mockPayrollEndpoints(makeDashboard("CERTIFIED"));
    server.use(
      http.get("*/api/v1/payroll/runs", () => {
        runRequests += 1;
        return HttpResponse.json({ items: [], total: 0, limit: 50, offset: 0 });
      }),
    );

    renderPage(customPayrollReaderSession);
    expect(
      await screen.findByRole("heading", { name: "급여 마감 명부" }),
    ).toBeVisible();
    expect(runRequests).toBe(1);
  });

  it("renders the audited close workspace only for an org-wide payroll reader", async () => {
    mockPayrollEndpoints(makeDashboard("CERTIFIED"));
    server.use(
      http.get("*/api/v1/payroll/runs", () =>
        HttpResponse.json({ items: [], total: 0, limit: 50, offset: 0 }),
      ),
    );

    renderPage(executiveSession);
    expect(
      await screen.findByRole("heading", { name: "급여 마감 명부" }),
    ).toBeVisible();
    expect(
      await screen.findByText("현재 조회 가능한 급여 회차가 없습니다."),
    ).toBeVisible();
  });

  it("aborts and ignores a deferred previous-authority success after a session switch", async () => {
    const pendingA = deferred<{ data: unknown }>();
    const aSignals: AbortSignal[] = [];
    const apiA = {
      GET: vi.fn((_path: string, options?: { signal?: AbortSignal }) => {
        if (options?.signal) aSignals.push(options.signal);
        return pendingA.promise;
      }),
    } as unknown as ReturnType<typeof createConsoleApiClient>;
    const readinessB = {
      ...readinessSummary,
      payroll: {
        ...readinessSummary.payroll,
        latest_source_label: "B-current",
      },
    };
    let bRunRequests = 0;
    const apiB = aggregateApi(readinessB, () => {
      bRunRequests += 1;
    });
    const sessionA = {
      ...customPayrollReaderSession,
      access_token: "authority-a",
      client_session_incarnation: "authority-a",
    };
    const sessionB = {
      ...customPayrollReaderSession,
      access_token: "authority-b",
      client_session_incarnation: "authority-b",
    };
    const page = renderPage(sessionA, apiA);

    await waitFor(() => {
      expect(aSignals).toHaveLength(4);
    });
    page.rerender(payrollPageTree(sessionB, apiB));

    expect(
      await screen.findByRole("heading", { name: "급여 마감 명부" }),
    ).toBeVisible();
    expect(aSignals.every((signal) => signal.aborted)).toBe(true);

    pendingA.resolve({
      data: {
        ...readinessSummary,
        payroll: {
          ...readinessSummary.payroll,
          latest_source_label: "A-stale",
        },
      },
    });
    await waitFor(() => {
      expect(screen.queryByText("A-stale")).not.toBeInTheDocument();
      expect(bRunRequests).toBe(1);
    });
  });

  it("ignores a deferred previous-authority rejection after logout", async () => {
    const pendingA = deferred<{ data: unknown }>();
    const aSignals: AbortSignal[] = [];
    const apiA = {
      GET: vi.fn((_path: string, options?: { signal?: AbortSignal }) => {
        if (options?.signal) aSignals.push(options.signal);
        return pendingA.promise;
      }),
    } as unknown as ReturnType<typeof createConsoleApiClient>;
    const sessionA = {
      ...customPayrollReaderSession,
      access_token: "authority-a",
      client_session_incarnation: "authority-a",
    };
    const page = renderPage(sessionA, apiA);

    await waitFor(() => {
      expect(aSignals).toHaveLength(4);
    });
    page.rerender(payrollPageTree(null, aggregateApi(readinessSummary)));
    pendingA.reject(new Error("stale authority rejected"));

    await waitFor(() => {
      expect(aSignals.every((signal) => signal.aborted)).toBe(true);
      expect(
        screen.queryByRole("heading", { name: "급여 마감 명부" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(copy.loadFailed)).not.toBeInTheDocument();
    });
  });
});
