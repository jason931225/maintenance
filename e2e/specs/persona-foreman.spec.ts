import { randomUUID } from "node:crypto";

import { test, expect, loginAsLanding, querySql, resetRateLimits, sql, TENANT_ORG_ID } from "../fixtures/roles";
import { assertNoAxeViolations, assertNoRawI18nKeys, navigateByHref } from "../fixtures/ux";

/**
 * PERSONA-FOREMAN — 공장 반장, ROADMAP.md §8 row 4.
 *
 * Design mirror top workflow: 교대 편성→결원 감지(근태 타임라인)→대근 편성
 * (인력풀)→승인→일지.
 *
 * No dedicated "foreman" role exists in the seeded RBAC (RECEPTIONIST/
 * MECHANIC/ADMIN/EXECUTIVE/SUPER_ADMIN) — ROADMAP marks this same "전담
 * 페르소나 미분리" gap for the dispatcher/payroll rows, so this spec drives as
 * ADMIN like admin-08-daily-plan.spec.ts (the daily-plan review authority).
 *
 * Real-app coverage:
 *   (1) 교대 편성 review/승인 — /daily-plan?planId=… approve flow (admin-08's
 *       proven pattern), SQL-verified.
 *   (2) 결원 감지(근태 타임라인) — an OPEN absence alert surfaces read-only on
 *       /hr/insurance (the same G009 signal hr-30/persona-hr assert deeper on).
 *
 * Frictions recorded as test.fixme: 대근 편성(인력풀) has NO implementation
 * anywhere in the app (see fixme for grep evidence) — this is the persona's
 * CENTRAL promised action and it does not exist yet.
 */

const ORG_ID = TENANT_ORG_ID;
const BRANCH_ID = "00000000-0000-0000-0000-0000000000c1";
const MECH_ID = "00000000-0000-0000-0000-0000000d0002";
const PLAN_ID = "00000000-0000-0000-0000-000000d80101";

const alertId = randomUUID();
const vacancyEmployeeId = randomUUID();
const vacancyEmployeeName = `e2e 결원대상 ${vacancyEmployeeId.slice(0, 8)}`;

function seedRequestedPlan() {
  sql(
    `BEGIN;
     SELECT set_config('app.current_org', '${ORG_ID}', true);
     DELETE FROM daily_work_plan_items WHERE plan_id = '${PLAN_ID}';
     DELETE FROM daily_work_plans WHERE id = '${PLAN_ID}';
     INSERT INTO daily_work_plans (id, branch_id, mechanic_id, plan_date, status, requested_at, org_id)
     VALUES ('${PLAN_ID}', '${BRANCH_ID}', '${MECH_ID}', CURRENT_DATE + 40, 'REQUESTED', now(), '${ORG_ID}');
     INSERT INTO daily_work_plan_items (id, plan_id, sort_order, description, org_id)
     VALUES ('00000000-0000-0000-0000-000000d80111', '${PLAN_ID}', 1, 'E2E persona 반장 교대 편성 작업', '${ORG_ID}');
     COMMIT;`,
  );
}

function seedVacancyAlert() {
  sql(`
    BEGIN;
    SELECT set_config('app.current_org', '${ORG_ID}', true);
    DELETE FROM employee_absence_alerts WHERE id = '${alertId}';
    DELETE FROM employees WHERE id = '${vacancyEmployeeId}';
    INSERT INTO employees (
      id, org_id, company, name,
      source_filename, source_sheet, source_row, source_key,
      hire_date, employment_status, identity_review_required
    ) VALUES (
      '${vacancyEmployeeId}', '${ORG_ID}', 'KNL', '${vacancyEmployeeName}',
      'e2e-persona-foreman.xlsx', 'e2e', 1, 'e2e-persona-foreman-${vacancyEmployeeId}',
      '2020-01-02', 'ACTIVE', false
    );
    INSERT INTO employee_absence_alerts (
      id, org_id, employee_id, work_date, status, source, severity
    ) VALUES (
      '${alertId}', '${ORG_ID}', '${vacancyEmployeeId}', CURRENT_DATE - 1,
      'OPEN', 'manual', 'WARNING'
    );
    COMMIT;
  `);
}

test.beforeEach(() => {
  resetRateLimits();
  seedRequestedPlan();
  seedVacancyAlert();
});

test("PERSONA-FOREMAN 교대 편성 승인, SQL-verified", async ({ page }) => {
  await loginAsLanding(page, "ADMIN");

  // click 1: nav → daily plan (deep-linked by id, mirrors admin-08).
  await page.goto(`/daily-plan?planId=${PLAN_ID}`);
  await expect(
    page.getByRole("heading", { name: /계획업무/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText(/검토 요청됨/).first()).toBeVisible({
    timeout: 8_000,
  });
  await assertNoRawI18nKeys(page);
  await assertNoAxeViolations(page, { context: "daily plan (교대 편성 검토)" });

  // click 2: 승인 (교대 편성 승인).
  await page.getByRole("button", { name: /^승인$/ }).click();
  await expect(page.getByText(/승인됨/).first()).toBeVisible({ timeout: 8_000 });

  await expect
    .poll(
      () =>
        querySql<{ status: string }>(
          `SELECT status FROM daily_work_plans WHERE id = '${PLAN_ID}'`,
        )[0]?.status ?? null,
      { message: "shift approval should commit", timeout: 8_000 },
    )
    .toBe("APPROVED");
});

test("PERSONA-FOREMAN 결원 감지(근태 타임라인) — absence alert renders read-only", async ({
  page,
}) => {
  // /hr/insurance is RequireEmployeeDirectoryRoute-gated; the seeded ADMIN
  // test user does not hold employee_directory_read, SUPER_ADMIN does
  // (matches admin-24-hr-core.spec.ts / hr-30-absence-exit-settlement.spec.ts).
  await loginAsLanding(page, "SUPER_ADMIN");
  await navigateByHref(page, "/hr/insurance");
  await expect(
    page.getByRole("heading", { name: "보험신고 지원", level: 1 }),
  ).toBeVisible({ timeout: 10_000 });

  const alertItem = page.getByRole("listitem").filter({ hasText: vacancyEmployeeName });
  await expect(alertItem).toBeVisible({ timeout: 10_000 });
  await assertNoRawI18nKeys(page);
  await assertNoAxeViolations(page, { context: "insurance-assist (결원 감지)" });
});

test.fixme(
  // 2026-07-10 (W3 PERSONA-E2E lane A): 대근 편성(인력풀) has NO implementation
  // anywhere in the app — grep for "대근" across web/src (all extensions,
  // excluding tests) returns ZERO hits, 2026-07-10. This is the persona's
  // CENTRAL promised action per ROADMAP.md §8 row 4 ("결원 감지→대근 편성
  // (인력풀)→승인→일지") and per §2's WorkforcePool ontology entity. The
  // equipment-substitution feature (admin-14-substitution.spec.ts, 대차) is a
  // DIFFERENT domain (equipment stand-in, not staff stand-in) and does not
  // cover this. Fix lane: build the workforce-pool substitute-assignment
  // surface + its approval + shift-log entry.
  "PERSONA-FOREMAN 대근 편성(인력풀) → 승인 → 일지",
  async () => {},
);
