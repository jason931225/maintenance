import { test, expect } from "../fixtures/roles";
import { attachConsoleGuard, auditPage } from "../fixtures/ux";

/**
 * EXEC-04 — executive creates a rental quote on /financial (임대 견적).
 * EXEC-05 — executive downloads a reporting export on /reporting.
 *
 * RentalQuoteManage is `[A, D, A, A, A]` → an executive may generate quotes.
 * ExcelDownload is `[A, A, A, A, A]` → every role, executive included, may
 * download the daily-status workbook. The seed-mech source equipment (호기
 * E2E-001) carries vehicle/residual value (seed-admin.sql) so the quote computes.
 */

const MANAGEMENT_NO = "E2E-001";

test("EXEC-04 executive creates a rental quote for an equipment", async ({
  page,
  loginAs,
}) => {
  const consoleGuard = attachConsoleGuard(page);

  await loginAs("EXECUTIVE");
  await page.goto("/financial");
  await expect(
    page.getByRole("heading", { name: /구매·정산/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  // Switch to the 임대 견적 tab.
  await page.getByRole("tab", { name: "임대 견적" }).click();
  await expect(
    page.getByRole("heading", { name: /임대 견적/ }).first(),
  ).toBeVisible({ timeout: 5_000 });

  // Resolve the equipment by 호기 번호 (the shared EquipmentSelector).
  await page.locator("#financial-equipment-lookup").fill(MANAGEMENT_NO);
  await page.getByRole("button", { name: /^호기 번호$/ }).click();
  await expect(page.getByText(/선택된 장비/).first()).toBeVisible({
    timeout: 8_000,
  });

  // Generate the quote.
  await page.getByRole("button", { name: /견적 생성/ }).click();
  await expect(page.getByText(/견적을 생성했습니다\./)).toBeVisible({
    timeout: 10_000,
  });
  await expect(
    page.getByRole("heading", { name: /월 임대료/ }),
  ).toBeVisible({ timeout: 8_000 });

  await auditPage(page, { context: "/financial 임대 견적 (executive)", consoleGuard });
});

test("EXEC-05 executive downloads a daily-status Excel export", async ({
  page,
  loginAs,
}) => {
  const consoleGuard = attachConsoleGuard(page);

  await loginAs("EXECUTIVE");
  await page.goto("/reporting");
  await expect(
    page.getByRole("heading", { name: /보고서 출력/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  const reportSelect = page.locator("#reporting-report");
  await expect(reportSelect).toBeVisible();
  await reportSelect.selectOption("daily-status");

  const today = new Date().toISOString().slice(0, 10);
  await page.locator("#reporting-date").fill(today);

  // Audit the settled page before the download dialog fires.
  await auditPage(page, { context: "/reporting (executive)", consoleGuard });

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
