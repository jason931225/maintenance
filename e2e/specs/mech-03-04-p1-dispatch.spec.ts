import { test, expect, sql } from "../fixtures/roles";

/**
 * MECH-03 — mechanic accepts a P1 dispatch offer.
 * MECH-04 — mechanic declines a P1 dispatch offer.
 *
 * The seeded P1 dispatch (…d10001, BROADCASTING, work order …f00002) is reset
 * before each spec so both tests can use the same dispatch ID.
 */

const ORG_ID = "00000000-0000-0000-0000-0000000000a1";
const DISPATCH_ID = "00000000-0000-0000-0000-000000d10001";
const MECH_ID = "00000000-0000-0000-0000-0000000d0002";
const ADMIN_ID = "00000000-0000-0000-0000-0000000d0003";

/** Reset the P1 dispatch back to BROADCASTING and clear any existing response. */
function resetP1Dispatch() {
  sql(
    `BEGIN;
     SELECT set_config('app.current_org', '${ORG_ID}', true);
     UPDATE p1_dispatches
       SET status = 'BROADCASTING',
           auto_assigned_mechanic_id = NULL,
           accept_window_ends_at = now() + interval '2 hours',
           updated_at = now()
     WHERE id = '${DISPATCH_ID}';
     DELETE FROM p1_dispatch_responses
     WHERE dispatch_id = '${DISPATCH_ID}';
     COMMIT;`,
  );
}

test.beforeEach(() => {
  resetP1Dispatch();
});

test("MECH-03 mechanic accepts a P1 dispatch offer", async ({
  page,
  loginAs,
}) => {
  await loginAs("MECHANIC");
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });

  // The P1 배차 수락 panel is visible to mechanics.
  await expect(
    page.getByRole("heading", { name: /P1 배차 수락/ }),
  ).toBeVisible();

  // Enter the dispatch ID and look it up.
  await page.getByRole("textbox", { name: /배차 코드/ }).fill(DISPATCH_ID);
  await page.getByRole("button", { name: /^조회$/ }).click();

  // The dispatch status "수락 대기" should appear.
  await expect(page.getByText(/수락 대기/).first()).toBeVisible({
    timeout: 8_000,
  });

  // Click the accept button.
  await page.getByRole("button", { name: /^수락$/ }).click();

  // Success message.
  await expect(page.getByText(/배차를 수락했습니다\./).first()).toBeVisible({
    timeout: 8_000,
  });
});

test("MECH-04 mechanic declines a P1 dispatch offer", async ({
  page,
  loginAs,
}) => {
  await loginAs("MECHANIC");
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });

  await expect(
    page.getByRole("heading", { name: /P1 배차 수락/ }),
  ).toBeVisible();

  // Enter the dispatch ID and look it up.
  await page.getByRole("textbox", { name: /배차 코드/ }).fill(DISPATCH_ID);
  await page.getByRole("button", { name: /^조회$/ }).click();

  // The dispatch status "수락 대기" should appear.
  await expect(page.getByText(/수락 대기/).first()).toBeVisible({
    timeout: 8_000,
  });

  // Click the decline button.
  await page.getByRole("button", { name: /^거절$/ }).click();

  // Success message.
  await expect(page.getByText(/배차를 거절했습니다\./).first()).toBeVisible({
    timeout: 8_000,
  });
});
