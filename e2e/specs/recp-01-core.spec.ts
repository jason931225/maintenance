import { test, expect } from "../fixtures/roles";
import { attachConsoleGuard, auditPage } from "../fixtures/ux";

/**
 * RECEPTIONIST core — the front-desk surfaces: equipment lookup, intake (접수증),
 * reporting export, and profile. WorkOrderCreate is `[A, L, A, L, A]` (receptionist
 * = Allow), so a receptionist creates work orders directly; ExcelDownload is
 * `[A, A, A, A, A]`. Each settled screen passes the UX baseline (axe + console +
 * i18n).
 *
 * Prereqs: seed-mech.sql seeds registry_equipment management_no '#E2E-001',
 * model 'E2E모델-15T', customer 'E2E고객사'.
 */

const MANAGEMENT_NO = "#E2E-001";

test("RECP equipment lookup by 호기", async ({ page, loginAs }) => {
  const consoleGuard = attachConsoleGuard(page);

  await loginAs("RECEPTIONIST");
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });

  await page.goto("/equipment");
  await expect(
    page.getByRole("heading", { name: /장비 조회/ }),
  ).toBeVisible({ timeout: 8_000 });

  const searchInput = page.locator("#equipment-search");
  await expect(searchInput).toBeVisible();
  await searchInput.fill(MANAGEMENT_NO);

  await expect(page.getByText(/E2E모델-15T/).first()).toBeVisible({
    timeout: 5_000,
  });
  await expect(page.getByText(/E2E고객사/).first()).toBeVisible();

  await auditPage(page, { context: "/equipment (receptionist)", consoleGuard });
});

test("RECP intake form: 호기 autopull then submit (접수증)", async ({
  page,
  loginAs,
}) => {
  const consoleGuard = attachConsoleGuard(page);

  await loginAs("RECEPTIONIST");
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });

  await page.goto("/intake");
  await expect(
    page.getByRole("heading", { name: /접수 입력/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  // Empty submit flags both required fields.
  await page.getByRole("button", { name: /접수 저장/ }).click();
  await expect(page.getByText(/호기를 입력하세요\./).first()).toBeVisible();
  await expect(page.getByText(/고장내용을 입력하세요\./).first()).toBeVisible();

  // 호기 autopull resolves the seeded equipment.
  await page.getByRole("textbox", { name: /호기/ }).fill(MANAGEMENT_NO);
  await expect(page.getByText(/E2E모델-15T/).first()).toBeVisible({
    timeout: 5_000,
  });
  await expect(page.getByText(/E2E고객사/).first()).toBeVisible();

  await page
    .getByRole("textbox", { name: /고장내용/ })
    .fill("접수 데스크 신고 — E2E 테스트");

  // Audit the filled form before submitting.
  await auditPage(page, { context: "/intake (receptionist)", consoleGuard });

  await page.getByRole("button", { name: /접수 저장/ }).click();
  await expect(
    page.getByText(/접수가 저장되었습니다\./).first(),
  ).toBeVisible({ timeout: 10_000 });

  consoleGuard.assertClean();
});

test("RECP downloads a daily-status Excel export", async ({ page, loginAs }) => {
  const consoleGuard = attachConsoleGuard(page);

  await loginAs("RECEPTIONIST");
  await page.goto("/reporting");
  await expect(
    page.getByRole("heading", { name: /보고서 출력/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  await page.locator("#reporting-report").selectOption("daily-status");
  const today = new Date().toISOString().slice(0, 10);
  await page.locator("#reporting-date").fill(today);

  await auditPage(page, { context: "/reporting (receptionist)", consoleGuard });

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 15_000 }),
    page.getByRole("button", { name: /엑셀 내려받기/ }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.xlsx$/i);
  await expect(
    page.getByText(/보고서를 내려받았습니다\./).first(),
  ).toBeVisible({ timeout: 10_000 });

  consoleGuard.assertClean();
});

test("RECP profile edit saves display name", async ({ page, loginAs }) => {
  const consoleGuard = attachConsoleGuard(page);

  await loginAs("RECEPTIONIST");
  await page.goto("/settings/profile");
  await expect(
    page.getByRole("heading", { name: /내 프로필/ }),
  ).toBeVisible({ timeout: 8_000 });

  const nameInput = page.locator("#profile-display-name");
  await expect(nameInput).toBeVisible();
  await nameInput.fill("");
  await nameInput.fill("E2E 접수 담당 수정");

  await auditPage(page, { context: "/settings/profile (receptionist)", consoleGuard });

  await page.getByRole("button", { name: /^저장$/ }).click();
  await expect(
    page.getByText(/프로필을 저장했습니다\./).first(),
  ).toBeVisible({ timeout: 8_000 });

  consoleGuard.assertClean();
});
