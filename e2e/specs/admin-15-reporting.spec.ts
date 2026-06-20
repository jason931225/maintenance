import { test, expect } from "../fixtures/roles";

/**
 * ADMIN-15 — admin downloads a reporting export (일일업무진행현황) on /reporting.
 *
 * Mirrors MECH-14 but as an admin and for the daily-status report. The download
 * is triggered via the anchor-click blob mechanism; we assert a download with an
 * xlsx filename was initiated plus the success status message.
 */

test("ADMIN-15 admin downloads a daily-status Excel export", async ({
  page,
  loginAs,
}) => {
  await loginAs("ADMIN");
  await page.goto("/reporting");
  await expect(
    page.getByRole("heading", { name: /보고서 출력/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  // Select the 일일업무진행현황 (daily-status) report type.
  const reportSelect = page.locator("#reporting-report");
  await expect(reportSelect).toBeVisible();
  await reportSelect.selectOption("daily-status");

  // Set a date (today).
  const today = new Date().toISOString().slice(0, 10);
  await page.locator("#reporting-date").fill(today);

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 15_000 }),
    page.getByRole("button", { name: /엑셀 내려받기/ }).click(),
  ]);

  expect(download.suggestedFilename()).toMatch(/\.xlsx$/i);

  await expect(
    page.getByText(/보고서를 내려받았습니다\./).first(),
  ).toBeVisible({ timeout: 10_000 });
});
