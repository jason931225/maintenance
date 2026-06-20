import { test, expect } from "../fixtures/roles";

/**
 * MECH-13 — mechanic looks up equipment by 호기 and views 대차 substitute candidates.
 *
 * Prerequisite: seed-mech.sql seeds registry_equipment with management_no '#E2E-001'
 * and model 'E2E모델-15T'.
 */

test("MECH-13 equipment lookup by 호기 and view 대차 substitute candidates", async ({
  page,
  loginAs,
}) => {
  await loginAs("MECHANIC");
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });

  await page.goto("/equipment");
  await expect(
    page.getByRole("heading", { name: /장비 조회/ }),
  ).toBeVisible({ timeout: 8_000 });

  // Search for the seeded equipment by its management_no.
  const searchInput = page.locator("#equipment-search");
  await expect(searchInput).toBeVisible();
  await searchInput.fill("#E2E-001");

  // After debounce (300ms), the equipment details panel should render.
  await expect(page.getByText(/E2E모델-15T/).first()).toBeVisible({
    timeout: 5_000,
  });
  await expect(page.getByText(/E2E고객사/).first()).toBeVisible();

  // Open the 대차 (substitution) panel.
  // The EquipmentPage renders SubstitutionPanel with a source equipment dropdown.
  const sourceDropdown = page.locator("#substitution-source");
  await expect(sourceDropdown).toBeVisible({ timeout: 5_000 });

  // Select the seeded equipment as the source for substitution lookup. The
  // option value is the equipment id (seed-mech.sql …ee0003); selecting by value
  // is unambiguous (Playwright's `label` matcher requires an exact string).
  await sourceDropdown.selectOption("00000000-0000-0000-0000-000000ee0003");

  // Click "대차 후보 조회" to find substitute candidates.
  await page.getByRole("button", { name: /대차 후보 조회/ }).click();

  // The seed has a single equipment, so the substitution read legitimately
  // returns no compatible candidates — the real, asserted outcome of the lookup
  // is the empty-state message (proves the read ran and the UI rendered it).
  await expect(
    page.getByText(/호환되는 대차 후보가 없습니다\./).first(),
  ).toBeVisible({ timeout: 8_000 });
});
