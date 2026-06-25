import { test, expect, sql, TENANT_ORG_ID, TENANT_BRANCH_ID } from "../fixtures/roles";

/**
 * MECH-09 — mechanic creates a daily plan → requests review → admin confirms.
 *
 * The spec drives two roles in sequence within one test:
 *   1. Login as MECHANIC → create plan → request review.
 *   2. Login as ADMIN   → confirm (결재) the approved plan.
 *
 * Since workers=1, we serialize: MECHANIC ceremony first, then ADMIN ceremony
 * in the same page context (re-login). A mid-spec re-login is safe because
 * each loginAs seeds a fresh OTP and attaches a new virtual authenticator.
 *
 * NOTE: The plan status flow is DRAFT → REQUESTED → APPROVED → FINAL_CONFIRMED.
 * The MECHANIC can request review; the ADMIN reviews (approve); the MECHANIC
 * (or ADMIN) confirms. This spec has the MECHANIC request review and then the
 * ADMIN approve + confirm to keep it to two role switches.
 */

const ORG_ID = TENANT_ORG_ID;
const BRANCH_ID = TENANT_BRANCH_ID;
const MECH_ID = "00000000-0000-0000-0000-0000000d0002";

/** Use a date 7 days in the future to avoid conflicts with today's plan. */
function planDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return d.toISOString().slice(0, 10);
}

/** Delete any existing daily plan for the mechanic on the plan date. */
function clearPlan(date: string) {
  sql(
    `BEGIN;
     SELECT set_config('app.current_org', '${ORG_ID}', true);
     DELETE FROM daily_work_plan_items
     WHERE plan_id IN (
       SELECT id FROM daily_work_plans
       WHERE mechanic_id = '${MECH_ID}' AND plan_date = '${date}'
     );
     DELETE FROM daily_work_plans
     WHERE mechanic_id = '${MECH_ID}' AND plan_date = '${date}';
     COMMIT;`,
  );
}

test("MECH-09 daily plan: create → request review → admin confirm", async ({
  page,
  loginAs,
}) => {
  const date = planDate();
  clearPlan(date);

  // ── Step 1: MECHANIC creates the plan ────────────────────────────────────
  await loginAs("MECHANIC");
  await page.goto("/daily-plan");
  await expect(
    page.getByRole("heading", { name: /계획업무/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  // Fill mechanic selector — the seeded mechanic should appear.
  const mechanicSelect = page.locator("#plan-mechanic");
  await expect(mechanicSelect).toBeVisible({ timeout: 5_000 });
  // Select the E2E Mechanic option (value = mechanic user id).
  await mechanicSelect.selectOption({ value: MECH_ID });

  // Set plan date.
  await page.locator("#plan-date").fill(date);

  // Fill the first item.
  await page
    .locator('input[placeholder="작업 내용을 입력하세요."]')
    .first()
    .fill("E2E 정기 점검 작업");

  // Create the plan, capturing the created plan id from the response so the
  // admin can deep-link to it after switching sessions (the page deep-links a
  // plan via ?planId=…; there is no mechanic+date search).
  const createResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/daily-work-plans") &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: /계획 생성/ }).click();
  const planId = (await (await createResponse).json()).id as string;
  expect(planId).toBeTruthy();

  // Plan is now in DRAFT status.
  await expect(page.getByText(/작성 중/).first()).toBeVisible({
    timeout: 8_000,
  });

  // Request review.
  await page.getByRole("button", { name: /검토 요청/ }).click();
  await expect(page.getByText(/검토 요청됨/).first()).toBeVisible({
    timeout: 8_000,
  });

  // ── Step 2: ADMIN approves and confirms ──────────────────────────────────
  // Logout current session and re-login as ADMIN.
  await page.evaluate(async () => {
    await fetch("/api/v1/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Transport": "cookie" },
      credentials: "include",
      body: "{}",
    });
  });

  await loginAs("ADMIN");
  // Deep-link to the mechanic's plan by id; the page fetches it (admins hold
  // DailyPlanRequest, so the by-id read is authorized) and hydrates the review
  // controls against real server state.
  await page.goto(`/daily-plan?planId=${planId}`);
  await expect(
    page.getByRole("heading", { name: /계획업무/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  // The loaded plan should show as REQUESTED.
  await expect(page.getByText(/검토 요청됨/).first()).toBeVisible({
    timeout: 8_000,
  });

  // Admin approves.
  await page.getByRole("button", { name: /^승인$/ }).click();
  await expect(page.getByText(/승인됨/).first()).toBeVisible({
    timeout: 8_000,
  });

  // Admin confirms (결재).
  await page.getByRole("button", { name: /^결재$/ }).click();
  await expect(page.getByText(/결재 완료/).first()).toBeVisible({
    timeout: 8_000,
  });
});
