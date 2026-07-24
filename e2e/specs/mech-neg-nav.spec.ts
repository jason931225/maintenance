import {
  test,
  expect,
  querySql,
  sql,
  TENANT_BRANCH_ID,
  TENANT_ORG_ID,
} from "../fixtures/roles";

/**
 * MECHANIC NEGATIVE — admin-only nav items are hidden while the principal-bound
 * assigned-inspection workflow remains visible; direct visits to admin-only
 * routes redirect/403 back to the default authenticated landing (/overview).
 *
 * Expected visible nav for MECHANIC (from web/src/components/shell/nav.test.ts):
 *   dispatch, intake, daily-plan, inspection, messenger, support, reporting,
 *   equipment, financial, profile, location
 *
 * Expected HIDDEN (admin-only):
 *   approvals, kpi, ops, users, org, security
 */

const ADMIN_ONLY_ROUTES = ["/settings/users", "/approvals"] as const;
const MECHANIC_ID = "00000000-0000-0000-0000-0000000d0002";
const ADMIN_ID = "00000000-0000-0000-0000-0000000d0003";
const CUSTOMER_ID = "00000000-0000-0000-0000-000000ee0001";
const SITE_ID = "00000000-0000-0000-0000-000000ee0002";
const DENIED_EQUIPMENT_ID = "00000000-0000-4000-8000-0000000e4882";
const MECHANIC_INSPECTION_EQUIPMENT_ID =
  "00000000-0000-4000-8000-0000000e4883";
const MECHANIC_INSPECTION_MANAGEMENT_NO = "E2E-INS-4881";
const MECHANIC_INSPECTION_SCHEDULE_ID =
  "00000000-0000-4000-8000-0000000e4881";

function sqlLiteral(value: string | null): string {
  return value === null ? "NULL" : `'${value.replaceAll("'", "''")}'`;
}

const HIDDEN_NAV_LABELS = [
  "승인",        // approvals
  "KPI 대시보드", // kpi
  "운영 대시보드", // ops
  "사용자 관리",  // users
  "지역·지점 관리", // org
  "보안 설정",   // security
] as const;

const VISIBLE_NAV_LABELS = [
  "배차",        // dispatch
  "접수",        // intake
  "계획업무",    // daily-plan
  "정기 예방정비", // principal-bound assigned inspection rounds
  "메신저",      // messenger
  "고객지원",    // support
  "보고서 출력", // reporting
  "장비 조회",   // equipment
  "내 프로필",   // profile
  "GPS 위치 동의", // location
] as const;

test("MECH-NEG admin-only nav items are hidden for MECHANIC", async ({
  page,
  loginAs,
}) => {
  await loginAs("MECHANIC");
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });

  // Visible nav items should appear in the shell nav.
  for (const label of VISIBLE_NAV_LABELS) {
    await expect(page.getByRole("link", { name: label }).first()).toBeVisible({
      timeout: 5_000,
    });
  }

  // Admin-only nav items must NOT be present in the nav.
  for (const label of HIDDEN_NAV_LABELS) {
    await expect(
      page.getByRole("link", { name: label }).first(),
    ).not.toBeVisible();
  }
});

test("MECH-NEG mechanic completes only a principal-bound assigned inspection", async ({
  page,
  loginAs,
}) => {
  const mechanicRows = querySql<{ team: string | null }>(
    `SELECT team FROM users WHERE id = '${MECHANIC_ID}'`,
  );
  expect(mechanicRows).toHaveLength(1);
  const previousTeam = mechanicRows[0]!.team;

  // This story owns its schedule id and never repurposes another persona's row.
  sql(
    `BEGIN;
     SELECT set_config('app.current_org', '${TENANT_ORG_ID}', true);
     DELETE FROM inspection_rounds
       WHERE schedule_id = '${MECHANIC_INSPECTION_SCHEDULE_ID}';
     DELETE FROM regular_inspection_schedules
       WHERE id = '${MECHANIC_INSPECTION_SCHEDULE_ID}';
     DELETE FROM registry_equipment
       WHERE id = '${MECHANIC_INSPECTION_EQUIPMENT_ID}';
     UPDATE users SET team = '예방' WHERE id = '${MECHANIC_ID}';
     INSERT INTO registry_equipment (
       id, branch_id, customer_id, site_id, equipment_no, management_no, model,
       manufacturer_code, kind_code, power_code, status, specification,
       ton_text, ton_milli, source_sheet, source_row, org_id
     )
     VALUES (
       '${MECHANIC_INSPECTION_EQUIPMENT_ID}', '${TENANT_BRANCH_ID}',
       '${CUSTOMER_ID}', '${SITE_ID}', 'TSTIN-4881',
       '${MECHANIC_INSPECTION_MANAGEMENT_NO}', 'E2E 예방정비 전용 장비',
       'E2E-MAKER', 'FORK', 'ELEC', '임대', '15t/6m', '15t', 15000,
       'e2e-mechanic-inspection', 4881, '${TENANT_ORG_ID}'
     );
     INSERT INTO regular_inspection_schedules (
       id, branch_id, equipment_id, mechanic_id, cycle, interval_days,
       due_date, status, note, created_by, created_at, org_id
     )
     VALUES (
       '${MECHANIC_INSPECTION_SCHEDULE_ID}', '${TENANT_BRANCH_ID}',
       '${MECHANIC_INSPECTION_EQUIPMENT_ID}', '${MECHANIC_ID}', 'WEEKLY', 7,
       (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::date + 1,
       'SCHEDULED', 'E2E 정비사 전용 예방정비 라운드',
       '${ADMIN_ID}', now(), '${TENANT_ORG_ID}'
     );
     COMMIT;`,
  );

  try {
    await loginAs("MECHANIC");
    const assignedProjection = page.waitForResponse((response) => {
      const request = response.request();
      return (
        request.method() === "GET" &&
        new URL(response.url()).pathname ===
          "/api/v1/inspections/my-schedules"
      );
    });
    await page
      .getByRole("link", { name: "정기 예방정비", exact: true })
      .click();
    const projectionResponse = await assignedProjection;

    await expect(page).toHaveURL(/\/inspection$/, { timeout: 8_000 });
    expect(projectionResponse.ok()).toBe(true);
    expect(
      new URL(projectionResponse.url()).searchParams.has("mechanic_id"),
    ).toBe(false);

    const workspace = page.getByRole("region", { name: "정기 예방정비" });
    await expect(workspace).toBeVisible();
    const assignedRounds = workspace
      .getByRole("listitem")
      .filter({ hasText: MECHANIC_INSPECTION_MANAGEMENT_NO });
    await expect(assignedRounds).toHaveCount(1);
    const assignedRound = assignedRounds.first();
    await expect(assignedRound).toContainText("E2E사업장");
    await expect(
      assignedRound.getByRole("button", { name: "점검 완료" }),
    ).toBeVisible();

    // The mechanic surface exposes completion, never schedule management.
    await expect(
      page.getByRole("heading", { name: "정기 일정 등록" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "일정 등록", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByLabel("지점", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("정비사", { exact: true })).toHaveCount(0);

    // Visibility is not the authorization boundary: the same authenticated
    // mechanic token must be rejected by the schedule-management endpoint.
    const authorization = await projectionResponse
      .request()
      .headerValue("authorization");
    expect(authorization).toMatch(/^Bearer /);
    const denied = await page.request.post(
      `${new URL(projectionResponse.url()).origin}/api/v1/inspections/schedules`,
      {
        headers: { Authorization: authorization ?? "" },
        data: {
          branch_id: TENANT_BRANCH_ID,
          equipment_id: DENIED_EQUIPMENT_ID,
          mechanic_id: MECHANIC_ID,
          cycle: "YEARLY",
          interval_days: 365,
          due_date: new Date().toISOString().slice(0, 10),
          note: "E2E 정비사 일정 등록 권한 경계",
        },
      },
    );
    expect(denied.status()).toBe(403);

    await assignedRound
      .getByRole("button", { name: "점검 완료" })
      .click();
    const findings = assignedRound.getByLabel("점검 내용");
    const submit = assignedRound.getByRole("button", {
      name: "완료 처리",
      exact: true,
    });
    await expect(findings).toBeVisible();
    await expect(submit).toBeDisabled();
    await findings.fill("E2E 배터리와 제동 장치 정상");
    await expect(submit).toBeEnabled();

    const completion = page.waitForResponse((response) => {
      const request = response.request();
      return (
        request.method() === "POST" &&
        new URL(response.url()).pathname ===
          `/api/v1/inspections/schedules/${MECHANIC_INSPECTION_SCHEDULE_ID}/rounds`
      );
    });
    await submit.click();
    const completionResponse = await completion;
    expect(completionResponse.status()).toBe(201);
    expect(new URL(completionResponse.url()).pathname).toBe(
      `/api/v1/inspections/schedules/${MECHANIC_INSPECTION_SCHEDULE_ID}/rounds`,
    );
    const completedRound = (await completionResponse.json()) as {
      schedule_id?: string;
    };
    expect(completedRound.schedule_id).toBe(MECHANIC_INSPECTION_SCHEDULE_ID);
    await expect(
      assignedRound.getByText("완료", { exact: true }),
    ).toBeVisible();
  } finally {
    sql(
      `BEGIN;
       SELECT set_config('app.current_org', '${TENANT_ORG_ID}', true);
       DELETE FROM inspection_rounds
         WHERE schedule_id = '${MECHANIC_INSPECTION_SCHEDULE_ID}';
       DELETE FROM regular_inspection_schedules
         WHERE id = '${MECHANIC_INSPECTION_SCHEDULE_ID}';
       DELETE FROM registry_equipment
         WHERE id = '${MECHANIC_INSPECTION_EQUIPMENT_ID}';
       UPDATE users SET team = ${sqlLiteral(previousTeam)}
         WHERE id = '${MECHANIC_ID}';
       COMMIT;`,
    );
  }
});

test("MECH-NEG direct visit to /approvals redirects away from admin route", async ({
  page,
  loginAs,
}) => {
  await loginAs("MECHANIC");
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });

  // /approvals is gated by RequireAdminRoute → redirects to /overview.
  await page.goto("/approvals");
  // The app should NOT stay on /approvals; it redirects to /overview.
  await expect(page).not.toHaveURL(/\/approvals/, { timeout: 8_000 });
  await expect(page).toHaveURL(/\/overview/, { timeout: 8_000 });
});

test("MECH-NEG direct visit to /settings/users redirects away from admin route", async ({
  page,
  loginAs,
}) => {
  await loginAs("MECHANIC");
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });

  // /settings/users is gated by RequireAdminRoute → redirects to /overview.
  await page.goto("/settings/users");
  await expect(page).not.toHaveURL(/\/settings\/users/, { timeout: 8_000 });
  await expect(page).toHaveURL(/\/overview/, { timeout: 8_000 });
});
