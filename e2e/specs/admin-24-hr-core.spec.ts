import {
  test,
  expect,
  loginAsLanding,
  querySql,
  sql,
  TENANT_ORG_ID,
  TENANT_BRANCH_ID,
} from "../fixtures/roles";

const SOURCE_FILENAME = "e2e-hr-core.xlsx";
const ACTIVE_EMPLOYEE_ID = "00000000-0000-0000-0000-000000aa2403";
const EXITED_EMPLOYEE_ID = "00000000-0000-0000-0000-000000aa2404";
const MECHANIC_ID = "00000000-0000-0000-0000-0000000d0002";
const WORK_ORDER_ID = "00000000-0000-0000-0000-000000f00001";
const SITE_ID = "00000000-0000-0000-0000-000000ee0002";

test.beforeEach(() => {
  sql(`
    BEGIN;
    SELECT set_config('app.current_org', '${TENANT_ORG_ID}', true);
    DELETE FROM site_attendance_events
      WHERE id IN (
        '00000000-0000-0000-0000-000000aa2401',
        '00000000-0000-0000-0000-000000aa2402'
      );
    SELECT set_config('role', 'mnt_rt', true);
    INSERT INTO employees (
      id, org_id, company, name, source_filename, source_sheet, source_row,
      source_key, raw_row, source_metadata, employee_number, org_unit, job,
      position, worksite_name, worksite_address, hire_date, employment_status,
      leave_accrued, leave_used, leave_remaining
    ) VALUES
      (
        '${ACTIVE_EMPLOYEE_ID}', '${TENANT_ORG_ID}', '대한물류', '김현장', '${SOURCE_FILENAME}', '대한물류', 2,
        'e2e-hr-core|대한물류|2',
        jsonb_build_object('성명', '김현장', '사번', 'A-001', '부서명', '물류팀', '잔여연차', '7.5'),
        jsonb_build_object('filename', '${SOURCE_FILENAME}', 'sheet', '대한물류', 'row', 2),
        'A-001', '물류팀', '정비', '대리', '인천센터', '인천광역시', '2024-01-02', 'ACTIVE',
        15, 7.5, 7.5
      ),
      (
        '${EXITED_EMPLOYEE_ID}', '${TENANT_ORG_ID}', '한울로지스', '이퇴사', '${SOURCE_FILENAME}', '한울로지스', 3,
        'e2e-hr-core|한울로지스|3',
        jsonb_build_object('성명', '이퇴사', '사번', 'B-002', '부서명', '관리팀', '퇴사일', '2026-01-31'),
        jsonb_build_object('filename', '${SOURCE_FILENAME}', 'sheet', '한울로지스', 'row', 3),
        'B-002', '관리팀', '관리', '과장', '부산센터', '부산광역시', '2023-03-01', 'EXITED',
        10, 10, 0
      )
    ON CONFLICT (id) DO UPDATE SET
      employment_status = EXCLUDED.employment_status,
      leave_accrued = EXCLUDED.leave_accrued,
      leave_used = EXCLUDED.leave_used,
      leave_remaining = EXCLUDED.leave_remaining;
    RESET ROLE;
    INSERT INTO site_attendance_events (
      id, org_id, user_id, branch_id, work_order_id, site_id, kind, occurred_at
    ) VALUES
      ('00000000-0000-0000-0000-000000aa2401', '${TENANT_ORG_ID}', '${MECHANIC_ID}', '${TENANT_BRANCH_ID}', '${WORK_ORDER_ID}', '${SITE_ID}', 'ARRIVAL', now() - interval '1 hour'),
      ('00000000-0000-0000-0000-000000aa2402', '${TENANT_ORG_ID}', '${MECHANIC_ID}', '${TENANT_BRANCH_ID}', '${WORK_ORDER_ID}', '${SITE_ID}', 'DEPARTURE', now() - interval '30 minutes');
    COMMIT;
  `);
});

test("ADMIN-24 HR core renders imported employees, org chart, leave, and attendance in browser", async ({
  page,
}) => {
  await loginAsLanding(page, "SUPER_ADMIN");
  await page.goto("/settings/employees");

  await expect(
    page.getByRole("heading", { name: "인사·조직 관리", level: 1 }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByRole("heading", { name: "인사 설정 대시보드" }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("heading", { name: "조직도" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "대한물류" })).toBeVisible();
  await expect(page.getByText("물류팀 · 1 명")).toBeVisible();
  await expect(page.getByText("A-001")).toBeVisible();
  await expect(page.getByText("김현장").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "연차 잔액" })).toBeVisible();
  await expect(page.getByText("7.5").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "근태 요약" })).toBeVisible();
  await expect(page.getByText("E2E Mechanic")).toBeVisible();

  await page.getByRole("button", { name: "김현장 생애주기 관리" }).click();
  await expect(
    page.getByRole("heading", { name: "근로 생애주기" }),
  ).toBeVisible();
  await page.getByLabel("전환 유형").selectOption("TERMINATE");
  await page.getByLabel("효력일").fill("2026-06-30");
  await page.getByLabel("사유 및 근거").fill("권고사직 협의 완료");
  await page.getByLabel("개인정보 처리 고지 확인").check();
  await page.getByLabel("근로기준법·취업규칙 확인").check();
  await page.getByLabel("급여 마감 영향 확인").check();
  await page.getByLabel("퇴직금 정산 필요성 확인").check();
  await page.getByRole("button", { name: "생애주기 기록" }).click();
  await expect(
    page.getByRole("listitem").getByText("권고사직 협의 완료").first(),
  ).toBeVisible();

  await expect
    .poll(
      () =>
        querySql<{
          event_type: string;
          to_status: string;
          comment: string;
          payroll_cutoff_ack: boolean;
          retirement_settlement_ack: boolean;
          employee_status: string;
        }>(`
          SELECT
            le.event_type,
            le.to_status,
            le.comment,
            (le.signoffs->>'payroll_cutoff_ack')::boolean AS payroll_cutoff_ack,
            (le.signoffs->>'retirement_settlement_ack')::boolean AS retirement_settlement_ack,
            e.employment_status AS employee_status
          FROM employee_lifecycle_events le
          JOIN employees e ON e.id = le.employee_id
          WHERE le.org_id = '${TENANT_ORG_ID}'
            AND e.source_filename = '${SOURCE_FILENAME}'
            AND e.name = '김현장'
          ORDER BY le.created_at DESC
          LIMIT 1
        `)[0] ?? null,
      {
        message:
          "employee lifecycle write should commit before downstream HR views continue",
        timeout: 10_000,
      },
    )
    .toEqual({
      event_type: "TERMINATE",
      to_status: "EXITED",
      comment: "권고사직 협의 완료",
      payroll_cutoff_ack: true,
      retirement_settlement_ack: true,
      employee_status: "EXITED",
    });

  await page.getByLabel("회사 필터").selectOption("한울로지스");
  await expect(page.getByRole("cell", { name: "B-002" })).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "이퇴사", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("cell", { name: "A-001" })).toHaveCount(0);
});
