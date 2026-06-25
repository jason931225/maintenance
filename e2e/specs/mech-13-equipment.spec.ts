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

  await page.goto("/equipment/legacy");
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

  // seed-admin.sql seeds a compatible 예비(spare) unit (호기 E2E-SPARE, exact-ton
  // match), so the substitution read returns it as a candidate. The mechanic can
  // READ candidates (the 예비 추천 목록 + 정확 일치 badge render) but the assign
  // control is admin-only (EquipmentManage) and must stay hidden.
  await expect(
    page.getByRole("heading", { name: /예비 추천 목록/ }),
  ).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText("E2E-SPARE")).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText(/정확 일치/).first()).toBeVisible();

  // The assign mutation (대차 배정) is hidden from a mechanic (read-only access).
  await expect(
    page.getByRole("button", { name: /^대차 배정$/ }),
  ).toHaveCount(0);
});
