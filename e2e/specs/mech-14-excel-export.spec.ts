import { test, expect } from "../fixtures/roles";

/**
 * MECH-14 — mechanic triggers an Excel export (work-diary / daily-status).
 *
 * The download is triggered via the browser's anchor-click blob mechanism.
 * Playwright's `waitForEvent('download')` intercepts the programmatic download.
 * We only assert that a download was initiated with an xlsx filename — the
 * backend may return an empty workbook for a date with no data, which is fine.
 */

test("MECH-14 Excel export triggers a download", async ({ page, loginAs }) => {
  await loginAs("MECHANIC");
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });

  await page.goto("/reporting");
  await expect(
    page.getByRole("heading", { name: /보고서 출력/ }),
  ).toBeVisible({ timeout: 8_000 });

  // Select "업무일지" report type.
  const reportSelect = page.locator("#reporting-report");
  await expect(reportSelect).toBeVisible();
  await reportSelect.selectOption("work-diary");

  // Set a date (today).
  const today = new Date().toISOString().slice(0, 10);
  await page.locator("#reporting-date").fill(today);

  // Click the download button and wait for the download event.
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 15_000 }),
    page.getByRole("button", { name: /엑셀 내려받기/ }).click(),
  ]);

  // The download should have an xlsx extension.
  const filename = download.suggestedFilename();
  expect(filename).toMatch(/\.xlsx$/i);

  // The success message should appear.
  await expect(
    page.getByText(/보고서를 내려받았습니다\./).first(),
  ).toBeVisible({ timeout: 10_000 });
});
