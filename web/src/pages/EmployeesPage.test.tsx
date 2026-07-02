import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AppRouter } from "../AppRouter";
import { createConsoleApiClient } from "../api/client";
import { AuthContext } from "../context/auth";
import type { AuthContextValue, AuthSession } from "../context/auth";
import { EmployeesPage } from "./EmployeesPage";

const employees = [
  {
    id: "e1",
    name: "김현장",
    company: "대한물류",
    employee_number: "A-001",
    org_unit: "물류팀",
    source_row: 12,
    worksite_name: "인천센터",
    job: "정비",
    position: "대리",
    hire_date: "2024-01-02",
    exit_date: null,
    status: "ACTIVE",
    leave_remaining: "7.5",
    identity_resolution_strategy: "employee_number",
    identity_resolution_confidence: "high",
    identity_review_required: false,
    identity_name_only_merge: false,
  },
  {
    id: "e2",
    name: "이퇴사",
    company: "한울로지스",
    employee_number: "B-002",
    org_unit: "관리팀",
    source_row: 13,
    worksite_name: "부산센터",
    job: "관리",
    position: "과장",
    hire_date: "2023-03-01",
    exit_date: "2026-01-31",
    status: "EXITED",
    leave_remaining: "0",
    identity_resolution_strategy: "source_row_fingerprint",
    identity_resolution_confidence: "low",
    identity_review_required: true,
    identity_name_only_merge: false,
  },
];

const orgChart = {
  companies: [
    {
      company: "대한물류",
      total: 1,
      active: 1,
      units: [
        {
          name: "물류팀",
          total: 1,
          positions: [
            {
              title: "대리",
              total: 1,
              employees: [
                {
                  id: "e1",
                  name: "김현장",
                  employee_number: "A-001",
                  status: "ACTIVE",
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const leaveBalances = {
  items: [
    {
      id: "e1",
      company: "대한물류",
      name: "김현장",
      employee_number: "A-001",
      org_unit: "물류팀",
      position: "대리",
      leave_accrued: "15",
      leave_used: "7.5",
      leave_remaining: "7.5",
    },
  ],
  total: 1,
  limit: 1000,
  offset: 0,
  summary: { accrued: "15", used: "7.5", remaining: "7.5" },
};

const attendanceSummary = {
  items: [
    {
      user_id: "u1",
      display_name: "박근태",
      arrivals: 3,
      departures: 2,
      last_kind: "ARRIVAL",
      last_event_at: "2026-06-27T12:00:00Z",
    },
  ],
  total: 1,
  limit: 1000,
  offset: 0,
};

const readinessSummary = {
  imports: {
    runs: 2,
    applied_runs: 1,
    input_rows: 14,
    candidate_rows: 2,
    preserved_rows: 12,
    ledger_rows: 14,
    latest_import_at: "2026-07-01T12:00:00Z",
  },
  payroll: {
    draft_runs: 1,
    blocked_runs: 1,
    calculation_enabled_runs: 0,
    draft_lines: 2,
    payroll_source_rows: 8,
    attendance_source_rows: 4,
    attendance_event_links: 0,
    attendance_material_refs: 3,
    gross_pay_source_lines: 1,
    net_pay_source_lines: 1,
    latest_status: "BLOCKED_LEGAL_GATE",
    latest_source_label: "COSS Group 2026-05 live import",
    latest_period_start: "2026-05-01",
    latest_period_end: "2026-05-31",
    latest_updated_at: "2026-07-01T13:00:00Z",
  },
  annual_leave: {
    obligations: 2,
    usage_promotion_required: 1,
    payout_review_required: 0,
    needs_review: 1,
    remaining_days: "7.5",
  },
  attendance: {
    durable_events: 5,
    self_service_records: 3,
    payroll_material_refs: 3,
  },
};

const lifecycleEvents = {
  items: [
    {
      id: "ev-1",
      employee_id: "e1",
      event_type: "ONBOARD",
      from_status: null,
      to_status: "ACTIVE",
      effective_date: "2024-01-02",
      comment: "입사 원장 확인",
      signoffs: {
        privacy_notice_ack: true,
        korean_labor_law_ack: true,
        payroll_cutoff_ack: false,
        retirement_settlement_ack: false,
      },
      created_by: "admin-user",
      created_at: "2026-06-27T12:00:00Z",
    },
  ],
};

const server = setupServer(
  http.get("*/api/v1/employees", () =>
    HttpResponse.json({ items: employees, total: employees.length }),
  ),
  http.get("*/api/v1/hr/org-chart", () => HttpResponse.json(orgChart)),
  http.get("*/api/v1/hr/leave-balances", () =>
    HttpResponse.json(leaveBalances),
  ),
  http.get("*/api/v1/hr/attendance-summary", () =>
    HttpResponse.json(attendanceSummary),
  ),
  http.get("*/api/v1/hr/readiness-summary", () =>
    HttpResponse.json(readinessSummary),
  ),
  http.get("*/api/v1/employees/:id/lifecycle-events", () =>
    HttpResponse.json(lifecycleEvents),
  ),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
});
afterEach(() => {
  server.resetHandlers();
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

function renderEmployeesPage(roles: string[]) {
  return render(
    <AuthContext.Provider value={makeAuthContext({ access_token: "a", roles })}>
      <MemoryRouter>
        <EmployeesPage />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

function renderAppRoute(path: string, roles: string[]) {
  return render(
    <AuthContext.Provider value={makeAuthContext({ access_token: "a", roles })}>
      <MemoryRouter initialEntries={[path]}>
        <AppRouter />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe("EmployeesPage", () => {
  it("renders the HR setup dashboard, organization chart, leave, attendance, and directory", async () => {
    renderEmployeesPage(["EXECUTIVE"]);

    expect(
      await screen.findByRole("heading", { name: "인사·조직 관리" }),
    ).toBeVisible();
    expect(
      await screen.findByRole("heading", { name: "인사 설정 대시보드" }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "피플 운영 관제" }),
    ).toBeVisible();
    expect(screen.getByText("그룹 전체")).toBeVisible();
    expect(screen.getByText("신원 표준화")).toBeVisible();
    expect(screen.getByText("검토 1 · 고신뢰 1")).toBeVisible();
    expect(screen.getByRole("link", { name: "사용자 관리" })).toHaveAttribute(
      "href",
      "/settings/users",
    );
    expect(screen.getByRole("link", { name: "정책 관리" })).toHaveAttribute(
      "href",
      "/settings/policy",
    );
    expect(screen.getByRole("link", { name: "워크플로" })).toHaveAttribute(
      "href",
      "/settings/workflows",
    );
    expect(screen.getByRole("heading", { name: "조직도" })).toBeVisible();
    expect(screen.getAllByText("물류팀").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "연차 잔액" })).toBeVisible();
    expect(screen.getAllByText("7.5").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "근태 요약" })).toBeVisible();
    expect(screen.getByText("박근태")).toBeVisible();

    expect(
      screen.getByRole("heading", { name: "원장·급여준비 상태" }),
    ).toBeVisible();
    expect(screen.getByText("BLOCKED_LEGAL_GATE")).toBeVisible();
    expect(screen.getByText("COSS Group 2026-05 live import")).toBeVisible();
    expect(screen.getByText("2026-05-01 - 2026-05-31")).toBeVisible();
    expect(screen.getByText("급여 원천 8행 · 근태 원천 4행 · 직접 근태 연결 3건")).toBeVisible();

    const row = (await screen.findByText("A-001")).closest("tr");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("김현장")).toBeVisible();
    expect(within(row as HTMLElement).getByText("대한물류")).toBeVisible();
    expect(within(row as HTMLElement).getByText("물류팀")).toBeVisible();
    expect(
      screen.queryByRole("columnheader", { name: "원본 행" }),
    ).not.toBeInTheDocument();
    expect(
      within(row as HTMLElement).queryByText("12"),
    ).not.toBeInTheDocument();
    expect(within(row as HTMLElement).getByText("인천센터")).toBeVisible();
    expect(within(row as HTMLElement).getByText("고신뢰")).toBeVisible();
    expect(within(row as HTMLElement).getByText("사번")).toBeVisible();
    expect(within(row as HTMLElement).getByText("이름 병합 금지")).toBeVisible();
    expect(within(row as HTMLElement).getByText("정비")).toBeVisible();
    expect(within(row as HTMLElement).getByText("대리")).toBeVisible();
    expect(within(row as HTMLElement).getByText("2024-01-02")).toBeVisible();
    expect(within(row as HTMLElement).getByText("ACTIVE")).toBeVisible();

    await userEvent.selectOptions(
      screen.getByLabelText("회사 필터"),
      "한울로지스",
    );
    expect(screen.queryByText("A-001")).not.toBeInTheDocument();
    expect(screen.getByText("이퇴사")).toBeVisible();
    expect(screen.getByText("검토 필요")).toBeVisible();
    expect(screen.getByText("원천 행")).toBeVisible();
    expect(screen.queryByLabelText("근태 가져올 파일")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "근태 파일 검토 시작" }),
    ).not.toBeInTheDocument();
  });

  it("shows governed import controls only to admins and requires preview, dry-run, then apply", async () => {
    let sawPreview = false;
    let sawDryRun = false;
    let sawApply = false;
    server.use(
      http.post("*/api/v1/employees/import/preview", () => {
        // MSW/undici cannot reliably parse jsdom File/FormData across realms;
        // the browser E2E verifies the real multipart upload path.
        sawPreview = true;
        return HttpResponse.json({
          run_id: "11111111-1111-4111-8111-111111111111",
          entity_type: "employee_hr",
          source_filename: "employees.xlsx",
          source_sha256: "a".repeat(64),
          input_rows: 2,
          candidate_rows: 1,
          preserved_rows: 1,
          columns: [
            {
              source_header: "성명",
              normalized_header: "성명",
              target: "name",
              classification: "canonical",
              preview_allowed: true,
            },
            {
              source_header: "계좌번호",
              normalized_header: "계좌번호",
              target: null,
              classification: "restricted",
              preview_allowed: false,
            },
            {
              source_header: "기본시급",
              normalized_header: "기본시급",
              target: null,
              classification: "restricted",
              preview_allowed: false,
            },
            {
              source_header: "퇴직금 중간정산",
              normalized_header: "퇴직금중간정산",
              target: null,
              classification: "restricted",
              preview_allowed: false,
            },
          ],
          sample_rows: [
            {
              source_sheet: "코스",
              source_row: 2,
              row_status: "CANDIDATE",
              values: {
                성명: "홍길동",
                계좌번호: "••••",
                기본시급: "••••",
                퇴직금중간정산: "••••",
              },
            },
          ],
          mapping_profile: { entity_type: "employee_hr" },
        });
      }),
      http.post("*/api/v1/employees/import/:runId/dry-run", () => {
        sawDryRun = true;
        return HttpResponse.json({
          run_id: "11111111-1111-4111-8111-111111111111",
          input_rows: 2,
          candidate_rows: 1,
          preserved_rows: 1,
          insert_candidates: 1,
          update_candidates: 0,
          companies: [
            { company: "코스", input_rows: 1, inserted: 1, updated: 0 },
          ],
        });
      }),
      http.post("*/api/v1/employees/import/:runId/apply", () => {
        sawApply = true;
        return HttpResponse.json({
          input_rows: 1,
          inserted: 1,
          updated: 0,
          companies: [
            { company: "코스", input_rows: 1, inserted: 1, updated: 0 },
          ],
        });
      }),
    );

    renderEmployeesPage(["ADMIN"]);

    const input = await screen.findByLabelText("가져올 파일");
    await userEvent.upload(
      input,
      new File(["name"], "employees.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "미리보기 생성" }),
    );

    await waitFor(() => {
      expect(sawPreview).toBe(true);
    });
    expect(
      screen.getByRole("heading", { name: "가져오기 검토" }),
    ).toBeVisible();
    expect(screen.getAllByText("계좌번호").length).toBeGreaterThan(0);
    expect(screen.getAllByText("기본시급").length).toBeGreaterThan(0);
    expect(screen.getAllByText("퇴직금 중간정산").length).toBeGreaterThan(0);
    expect(screen.getAllByText("••••").length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByText("12345")).not.toBeInTheDocument();
    expect(screen.queryByText("2025-12-31")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "드라이런" }));
    await waitFor(() => {
      expect(sawDryRun).toBe(true);
    });
    expect(screen.getByText("추가 예정")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "검토 후 적용" }));
    await waitFor(() => {
      expect(sawApply).toBe(true);
    });
    expect(screen.getByText("입력 행")).toBeVisible();
  });
  it("supports governed direct attendance import preview, dry-run, and append-only apply", async () => {
    let sawPreview = false;
    let sawDryRun = false;
    let sawApply = false;
    server.use(
      http.post("*/api/v1/hr/attendance-import/preview", () => {
        sawPreview = true;
        return HttpResponse.json({
          run_id: "22222222-2222-4222-8222-222222222222",
          entity_type: "attendance_direct",
          source_filename: "attendance.csv",
          source_sha256: "b".repeat(64),
          input_rows: 1,
          candidate_rows: 1,
          preserved_rows: 0,
          columns: [
            {
              source_header: "사번",
              normalized_header: "사번",
              target: "employee_number",
              classification: "canonical",
              preview_allowed: true,
            },
            {
              source_header: "근무일",
              normalized_header: "근무일",
              target: "work_date",
              classification: "canonical",
              preview_allowed: true,
            },
            {
              source_header: "급여메모",
              normalized_header: "급여메모",
              target: null,
              classification: "restricted",
              preview_allowed: false,
            },
          ],
          sample_rows: [
            {
              source_sheet: "CSV",
              source_row: 2,
              row_status: "CANDIDATE",
              values: {
                사번: "A-001",
                근무일: "2026-07-01",
                급여메모: "••••",
              },
              validation: { status: "ok", errors: [], warnings: [] },
            },
          ],
          mapping_profile: {
            entity_type: "attendance_direct",
            policy: { payroll_effect: "lineage_only_not_payable" },
          },
        });
      }),
      http.post("*/api/v1/hr/attendance-import/:runId/dry-run", () => {
        sawDryRun = true;
        return HttpResponse.json({
          run_id: "22222222-2222-4222-8222-222222222222",
          input_rows: 1,
          candidate_rows: 1,
          preserved_rows: 0,
          ready_rows: 1,
          error_rows: 0,
          duplicate_rows: 0,
          missing_employee_rows: 0,
          ambiguous_employee_rows: 0,
          row_errors: [],
        });
      }),
      http.post("*/api/v1/hr/attendance-import/:runId/apply", () => {
        sawApply = true;
        return HttpResponse.json({
          run_id: "22222222-2222-4222-8222-222222222222",
          inserted: 1,
          skipped: 0,
          error_rows: 0,
        });
      }),
    );

    renderEmployeesPage(["ADMIN"]);

    const input = await screen.findByLabelText("근태 가져올 파일");
    await userEvent.upload(
      input,
      new File(["사번,근무일\nA-001,2026-07-01"], "attendance.csv", {
        type: "text/csv",
      }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "근태 파일 검토 시작" }),
    );

    await waitFor(() => {
      expect(sawPreview).toBe(true);
    });
    expect(
      screen.getByRole("heading", { name: "근태 가져오기 검토" }),
    ).toBeVisible();
    expect(
      screen.getByText(
        "급여 준비도에는 원천 계보로만 연결되며 지급 가능 급여가 생성되지 않습니다.",
      ),
    ).toBeVisible();
    expect(screen.getAllByText("급여메모").length).toBeGreaterThan(0);
    expect(screen.getByText("••••")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "근태 드라이런" }));
    await waitFor(() => {
      expect(sawDryRun).toBe(true);
    });
    expect(screen.getByText("적용 가능")).toBeVisible();

    await userEvent.click(
      screen.getByRole("button", { name: "근태 검토 후 적용" }),
    );
    await waitFor(() => {
      expect(sawApply).toBe(true);
    });
    expect(screen.getByText("건너뜀")).toBeVisible();
  });

  it("records audited Korean HR lifecycle signoffs before termination", async () => {
    let lifecycleBody: unknown;
    server.use(
      http.post(
        "*/api/v1/employees/:id/lifecycle-events",
        async ({ request }) => {
          lifecycleBody = await request.json();
          return HttpResponse.json({
            id: "ev-2",
            employee_id: "e1",
            event_type: "TERMINATE",
            from_status: "ACTIVE",
            to_status: "EXITED",
            effective_date: "2026-06-30",
            comment: "권고사직 협의 완료",
            signoffs: {
              privacy_notice_ack: true,
              korean_labor_law_ack: true,
              payroll_cutoff_ack: true,
              retirement_settlement_ack: true,
            },
            created_by: "admin-user",
            created_at: "2026-06-29T12:00:00Z",
          });
        },
      ),
    );

    renderEmployeesPage(["ADMIN"]);

    await userEvent.click(
      await screen.findByRole("button", { name: "김현장 생애주기 관리" }),
    );
    expect(
      await screen.findByRole("heading", { name: "근로 생애주기" }),
    ).toBeVisible();
    expect(screen.getByText("입사 원장 확인")).toBeVisible();

    await userEvent.selectOptions(
      screen.getByLabelText("전환 유형"),
      "TERMINATE",
    );
    await userEvent.type(screen.getByLabelText("효력일"), "2026-06-30");
    await userEvent.type(
      screen.getByLabelText("사유 및 근거"),
      "권고사직 협의 완료",
    );
    await userEvent.click(screen.getByLabelText("개인정보 처리 고지 확인"));
    await userEvent.click(screen.getByLabelText("근로기준법·취업규칙 확인"));
    await userEvent.click(screen.getByLabelText("급여 마감 영향 확인"));
    await userEvent.click(screen.getByLabelText("퇴직금 정산 필요성 확인"));
    await userEvent.click(
      screen.getByRole("button", { name: "생애주기 기록" }),
    );

    await waitFor(() => {
      expect(lifecycleBody).toMatchObject({
        event_type: "TERMINATE",
        to_status: "EXITED",
        effective_date: "2026-06-30",
        comment: "권고사직 협의 완료",
        signoffs: {
          privacy_notice_ack: true,
          korean_labor_law_ack: true,
          payroll_cutoff_ack: true,
          retirement_settlement_ack: true,
        },
      });
    });
    expect(await screen.findByText("권고사직 협의 완료")).toBeVisible();
    expect(
      screen.getByText("기록자: admin-user · 기록 시각: 2026-06-29T12:00:00Z"),
    ).toBeVisible();
    expect(screen.getAllByText("확인").length).toBeGreaterThanOrEqual(4);
  });

  it("captures transfer targets and shows signoff history for intra-group moves", async () => {
    let lifecycleBody: unknown;
    server.use(
      http.post(
        "*/api/v1/employees/:id/lifecycle-events",
        async ({ request }) => {
          lifecycleBody = await request.json();
          return HttpResponse.json({
            id: "ev-transfer",
            employee_id: "e1",
            event_type: "TRANSFER",
            from_status: "ACTIVE",
            to_status: "ACTIVE",
            from_company: "대한물류",
            to_company: "한울로지스",
            to_org_unit: "운영기획팀",
            to_position: "차장",
            effective_date: "2026-07-01",
            comment: "그룹 내 전보 및 인수인계 완료",
            signoffs: {
              privacy_notice_ack: true,
              korean_labor_law_ack: true,
              payroll_cutoff_ack: true,
              retirement_settlement_ack: true,
            },
            created_by: "hr-admin",
            created_at: "2026-06-29T12:30:00Z",
          });
        },
      ),
    );

    renderEmployeesPage(["ADMIN"]);

    await userEvent.click(
      await screen.findByRole("button", { name: "김현장 생애주기 관리" }),
    );

    await userEvent.type(screen.getByLabelText("효력일"), "2026-07-01");
    await userEvent.type(
      screen.getByLabelText("사유 및 근거"),
      "그룹 내 전보 및 인수인계 완료",
    );
    await userEvent.type(screen.getByLabelText("이동 회사"), "한울로지스");
    await userEvent.type(screen.getByLabelText("이동 부서/팀"), "운영기획팀");
    await userEvent.type(screen.getByLabelText("이동 직책"), "차장");
    await userEvent.click(screen.getByLabelText("개인정보 처리 고지 확인"));
    await userEvent.click(screen.getByLabelText("근로기준법·취업규칙 확인"));
    await userEvent.click(screen.getByLabelText("급여 마감 영향 확인"));
    await userEvent.click(screen.getByLabelText("퇴직금 정산 필요성 확인"));
    await userEvent.click(
      screen.getByRole("button", { name: "생애주기 기록" }),
    );

    await waitFor(() => {
      expect(lifecycleBody).toMatchObject({
        event_type: "TRANSFER",
        to_status: "ACTIVE",
        to_company: "한울로지스",
        to_org_unit: "운영기획팀",
        to_position: "차장",
        effective_date: "2026-07-01",
        comment: "그룹 내 전보 및 인수인계 완료",
        signoffs: {
          privacy_notice_ack: true,
          korean_labor_law_ack: true,
          payroll_cutoff_ack: true,
          retirement_settlement_ack: true,
        },
      });
    });
    expect(
      await screen.findByText("전보 대상: 한울로지스 · 운영기획팀 · 차장"),
    ).toBeVisible();
    expect(
      screen.getByText("기록자: hr-admin · 기록 시각: 2026-06-29T12:30:00Z"),
    ).toBeVisible();
  });

  it("allows admins through the routed HR directory guard", async () => {
    renderAppRoute("/settings/employees", ["ADMIN"]);

    expect(
      await screen.findByRole("heading", { name: "인사·조직 관리" }),
    ).toBeVisible();
  });

  it("redirects unsupported roles away from the HR directory", async () => {
    renderAppRoute("/settings/employees", ["MECHANIC"]);

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "인사·조직 관리" }),
      ).not.toBeInTheDocument();
    });
  });
});
