import {
  test,
  expect,
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
const EQUIPMENT_ID = "00000000-0000-0000-0000-000000ee0003";
const SCHEDULE_ID = "00000000-0000-0000-0000-0000000ab001";
const DENIED_SCHEDULE_NOTE = "E2E 정비사 일정 등록 권한 경계";

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
  // ADMIN-19 deliberately completes and reassigns this shared seeded schedule.
  // Restore the canonical mechanic story so this spec remains order-independent.
  sql(
    `BEGIN;
     SELECT set_config('app.current_org', '${TENANT_ORG_ID}', true);
     UPDATE users SET team = '예방' WHERE id = '${MECHANIC_ID}';
     DELETE FROM inspection_rounds WHERE schedule_id = '${SCHEDULE_ID}';
     UPDATE regular_inspection_schedules
       SET mechanic_id = '${MECHANIC_ID}', status = 'SCHEDULED',
           completed_at = NULL, completed_by = NULL,
           due_date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::date
       WHERE id = '${SCHEDULE_ID}';
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
    const assignedRound = workspace
      .getByRole("listitem")
      .filter({ hasText: "E2E-001" });
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
          equipment_id: EQUIPMENT_ID,
          mechanic_id: MECHANIC_ID,
          cycle: "MONTHLY",
          interval_days: 30,
          due_date: new Date().toISOString().slice(0, 10),
          note: DENIED_SCHEDULE_NOTE,
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
          `/api/v1/inspections/schedules/${SCHEDULE_ID}/rounds`
      );
    });
    await submit.click();
    expect((await completion).status()).toBe(201);
    await expect(
      assignedRound.getByText("완료", { exact: true }),
    ).toBeVisible();
  } finally {
    sql(
      `BEGIN;
       SELECT set_config('app.current_org', '${TENANT_ORG_ID}', true);
       DELETE FROM inspection_rounds WHERE schedule_id = '${SCHEDULE_ID}';
       DELETE FROM regular_inspection_schedules
         WHERE created_by = '${MECHANIC_ID}'
           AND note = '${DENIED_SCHEDULE_NOTE}';
       UPDATE regular_inspection_schedules
         SET mechanic_id = '${MECHANIC_ID}', status = 'SCHEDULED',
             completed_at = NULL, completed_by = NULL,
             due_date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::date
         WHERE id = '${SCHEDULE_ID}';
       UPDATE users SET team = NULL WHERE id = '${MECHANIC_ID}';
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
