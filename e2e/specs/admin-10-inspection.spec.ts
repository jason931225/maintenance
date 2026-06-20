import { test, expect, sql, TENANT_ORG_ID } from "../fixtures/roles";

/**
 * ADMIN-10 — admin creates a recurring inspection schedule on /inspection.
 *
 * The create form takes the branch/equipment/mechanic ids as text inputs plus a
 * cycle, interval, and due date. We use the seeded E2E branch, equipment, and
 * mechanic ids. The created schedule is cleaned up before each run.
 */

const ORG_ID = TENANT_ORG_ID;
const BRANCH_ID = "00000000-0000-0000-0000-0000000000c1";
const EQUIPMENT_ID = "00000000-0000-0000-0000-000000ee0003";
// The inspection adapter requires an active 예방(PREVENTION) MECHANIC in the
// branch — seed-admin.sql seeds …d0007 (E2E Prevention, team='예방').
const MECH_ID = "00000000-0000-0000-0000-0000000d0007";

function clearSchedules() {
  sql(
    `BEGIN;
     SELECT set_config('app.current_org', '${ORG_ID}', true);
     DELETE FROM regular_inspection_schedules
     WHERE equipment_id = '${EQUIPMENT_ID}' AND note = 'E2E 정기 점검 일정';
     COMMIT;`,
  );
}

test.beforeEach(() => {
  clearSchedules();
});

test("ADMIN-10 admin creates a recurring inspection schedule", async ({
  page,
  loginAs,
}) => {
  await loginAs("ADMIN");
  await page.goto("/inspection");
  await expect(
    page.getByRole("heading", { name: /정기 예방정비/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  // Fill the create form (id-based fields).
  await page.locator("#ins-branch").fill(BRANCH_ID);
  await page.locator("#ins-equipment").fill(EQUIPMENT_ID);
  await page.locator("#ins-mechanic").fill(MECH_ID);
  await page.locator("#ins-cycle").selectOption("MONTHLY");

  // A due date 14 days out.
  const due = new Date();
  due.setDate(due.getDate() + 14);
  await page.locator("#ins-due-date").fill(due.toISOString().slice(0, 10));
  await page.locator("#ins-note").fill("E2E 정기 점검 일정");

  await page.getByRole("button", { name: "일정 등록" }).click();

  // Success status message.
  await expect(
    page.getByText(/정기 예방정비 일정을 등록했습니다\./),
  ).toBeVisible({ timeout: 10_000 });
});
