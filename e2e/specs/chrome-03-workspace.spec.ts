import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * UI-M1b ConsoleShell window-grammar guard.
 *
 * Runs only under the `dev-auth` Playwright project (`MNT_DEV_AUTH_E2E=1`) — it
 * needs the authenticated ConsoleShell and a seeded backend with at least one
 * pinnable /work-hub row. The default preview-only `chromium` project ignores
 * this file. CI-only, like chrome-01/02.
 *
 * Proves the AC: pin a real object on /work-hub, switch to /attendance and back
 * (panel survives — mounted persistence, no reload), reload (layout restored
 * from the server profile), minimize to tray and restore, Esc closes; axe clean.
 */
async function loginWithDevRole(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: /역할 전환 로그인/ }).click();
  await page.getByRole("button", { name: "역할로 로그인" }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
  await expect(page.getByRole("navigation", { name: "메인 내비게이션" })).toBeVisible();
}

function nav(page: Page) {
  return page.getByRole("navigation", { name: "메인 내비게이션" });
}

test("window grammar: pin survives screen switch + reload, tray restore, Esc", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await loginWithDevRole(page);

  await page.goto("/work-hub");
  await expect(page.getByRole("heading", { name: "업무 허브", level: 1 })).toBeVisible();

  // Pin the first real row into a detail panel.
  const pinButtons = page.getByRole("button", { name: /상세 고정$/ });
  await expect(pinButtons.first()).toBeVisible({ timeout: 15_000 });
  const savePut = page.waitForResponse(
    (r) => r.url().includes("/api/v1/me/workspace") && r.request().method() === "PUT",
  );
  await pinButtons.first().click();
  await expect(page.getByRole("button", { name: "최소화" })).toBeVisible();
  await savePut; // debounced layout save reached the server before we reload

  // Switch to /attendance and back — the panel survives with no server round-trip.
  await nav(page).getByRole("link", { name: "근태 기록", exact: true }).click();
  await expect(page).toHaveURL(/\/attendance/);
  await nav(page).getByRole("link", { name: "업무 허브", exact: true }).click();
  await expect(page).toHaveURL(/\/work-hub/);
  await expect(page.getByRole("button", { name: "최소화" })).toBeVisible();

  // Reload — the layout is restored from the server profile.
  await page.reload();
  await expect(page.getByRole("button", { name: "최소화" })).toBeVisible({ timeout: 15_000 });

  // Minimize to the tray, then restore.
  await page.getByRole("button", { name: "최소화" }).click();
  const restore = page.getByRole("button", { name: /복원$/ });
  await expect(restore).toBeVisible();
  await expect(page.getByRole("button", { name: "최소화" })).toHaveCount(0);
  await restore.click();
  await expect(page.getByRole("button", { name: "최소화" })).toBeVisible();

  // Esc cascades the open panel to the tray.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "최소화" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /복원$/ })).toBeVisible();

  // Axe on the workspace with a pinned panel restored.
  await page.getByRole("button", { name: /복원$/ }).click();
  await expect(page.getByRole("button", { name: "최소화" })).toBeVisible();
  const results = await new AxeBuilder({ page })
    .include("#main-content")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    results.violations,
    results.violations.map((v) => `[${v.impact ?? "?"}] ${v.id}: ${v.help}`).join("\n"),
  ).toEqual([]);
});
