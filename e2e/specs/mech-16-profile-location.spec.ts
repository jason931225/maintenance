import { test, expect, sql } from "../fixtures/roles";

/**
 * MECH-16 — mechanic edits their profile and toggles the location-consent.
 *
 * Profile: update display name, save, assert "프로필을 저장했습니다."
 * Location: grant GPS consent, assert state transitions to "동의됨".
 */

const ORG_ID = "00000000-0000-0000-0000-0000000000a1";
const BRANCH_ID = "00000000-0000-0000-0000-0000000000c1";
const MECH_ID = "00000000-0000-0000-0000-0000000d0002";

/** Reset location consent so the grant button is enabled each run. */
function resetLocationConsent() {
  sql(
    `BEGIN;
     SELECT set_config('app.current_org', '${ORG_ID}', true);
     DELETE FROM location_consent_ledger
     WHERE consent_id IN (
       SELECT id FROM location_consents
       WHERE user_id = '${MECH_ID}'
     );
     DELETE FROM location_consents WHERE user_id = '${MECH_ID}';
     COMMIT;`,
  );
}

test.beforeEach(() => {
  resetLocationConsent();
});

test("MECH-16 profile edit saves display name", async ({ page, loginAs }) => {
  await loginAs("MECHANIC");
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });

  await page.goto("/settings/profile");
  await expect(
    page.getByRole("heading", { name: /내 프로필/ }),
  ).toBeVisible({ timeout: 8_000 });

  // Clear and re-fill the display name.
  const nameInput = page.locator("#profile-display-name");
  await expect(nameInput).toBeVisible();
  await nameInput.fill("");
  await nameInput.fill("E2E 정비사 수정");

  // Save.
  await page.getByRole("button", { name: /^저장$/ }).click();

  // Success message.
  await expect(
    page.getByText(/프로필을 저장했습니다\./).first(),
  ).toBeVisible({ timeout: 8_000 });
});

test("MECH-16 location consent toggle: grant GPS consent", async ({
  page,
  loginAs,
}) => {
  await loginAs("MECHANIC");
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });

  await page.goto("/settings/location");
  await expect(
    page.getByRole("heading", { name: /GPS 위치 동의/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  // With no existing consent (NO_RECORD), the "동의" button should be enabled.
  const grantBtn = page.getByRole("button", { name: /^동의$/ }).first();
  await expect(grantBtn).toBeEnabled({ timeout: 5_000 });
  await grantBtn.click();

  // After granting, the status badge should show "동의됨".
  await expect(page.getByText(/동의됨/).first()).toBeVisible({
    timeout: 8_000,
  });

  // The "GPS 끄기" button should now be enabled (can suspend).
  await expect(
    page.getByRole("button", { name: /GPS 끄기/ }).first(),
  ).toBeEnabled({ timeout: 5_000 });
});
