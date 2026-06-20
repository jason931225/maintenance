import { test, expect, sql, TENANT_ORG_ID } from "../fixtures/roles";

/**
 * ADMIN-08 — admin reviews a submitted daily plan: approve one, reject another.
 *
 * MECH-09 already covers the mechanic create → request → admin approve+confirm
 * happy path. This spec exercises the admin review controls directly against a
 * REQUESTED plan seeded via SQL, covering BOTH the 승인 (approve) and 반려 (reject)
 * branches. The admin deep-links each plan by id (?planId=…) — admins hold
 * DailyPlanRequest so the by-id read is authorized.
 */

const ORG_ID = TENANT_ORG_ID;
const BRANCH_ID = "00000000-0000-0000-0000-0000000000c1";
const MECH_ID = "00000000-0000-0000-0000-0000000d0002";
const PLAN_APPROVE = "00000000-0000-0000-0000-000000d80001";
const PLAN_REJECT = "00000000-0000-0000-0000-000000d80002";

/** Seed two REQUESTED daily plans (distinct dates) each with one item. */
function seedRequestedPlans() {
  // plan_date is UNIQUE per mechanic, so use two far-future distinct dates.
  sql(
    `BEGIN;
     SELECT set_config('app.current_org', '${ORG_ID}', true);
     DELETE FROM daily_work_plan_items WHERE plan_id IN ('${PLAN_APPROVE}', '${PLAN_REJECT}');
     DELETE FROM daily_work_plans WHERE id IN ('${PLAN_APPROVE}', '${PLAN_REJECT}');
     INSERT INTO daily_work_plans (id, branch_id, mechanic_id, plan_date, status, requested_at, org_id)
     VALUES
       ('${PLAN_APPROVE}', '${BRANCH_ID}', '${MECH_ID}', CURRENT_DATE + 30, 'REQUESTED', now(), '${ORG_ID}'),
       ('${PLAN_REJECT}',  '${BRANCH_ID}', '${MECH_ID}', CURRENT_DATE + 31, 'REQUESTED', now(), '${ORG_ID}');
     INSERT INTO daily_work_plan_items (id, plan_id, sort_order, description, org_id)
     VALUES
       ('00000000-0000-0000-0000-000000d80011', '${PLAN_APPROVE}', 1, 'E2E 승인 대상 작업', '${ORG_ID}'),
       ('00000000-0000-0000-0000-000000d80012', '${PLAN_REJECT}',  1, 'E2E 반려 대상 작업', '${ORG_ID}');
     COMMIT;`,
  );
}

test.beforeEach(() => {
  seedRequestedPlans();
});

test("ADMIN-08 admin approves a requested daily plan", async ({
  page,
  loginAs,
}) => {
  await loginAs("ADMIN");
  await page.goto(`/daily-plan?planId=${PLAN_APPROVE}`);
  await expect(
    page.getByRole("heading", { name: /계획업무/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  // The loaded plan shows as REQUESTED (검토 요청됨).
  await expect(page.getByText(/검토 요청됨/).first()).toBeVisible({
    timeout: 8_000,
  });

  // Approve.
  await page.getByRole("button", { name: /^승인$/ }).click();
  await expect(page.getByText(/승인됨/).first()).toBeVisible({
    timeout: 8_000,
  });
});

test("ADMIN-08 admin rejects a requested daily plan with a memo", async ({
  page,
  loginAs,
}) => {
  await loginAs("ADMIN");
  await page.goto(`/daily-plan?planId=${PLAN_REJECT}`);
  await expect(
    page.getByRole("heading", { name: /계획업무/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  await expect(page.getByText(/검토 요청됨/).first()).toBeVisible({
    timeout: 8_000,
  });

  // Optional review memo, then reject (반려).
  await page.getByLabel("검토 메모").fill("E2E 반려: 계획을 보완하세요.");
  await page.getByRole("button", { name: /^반려$/ }).click();
  await expect(page.getByText(/반려됨/).first()).toBeVisible({
    timeout: 8_000,
  });
});
