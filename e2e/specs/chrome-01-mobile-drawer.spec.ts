import { expect, test } from "@playwright/test";

/**
 * UI-M1a chrome drawer guard.
 *
 * Runs under the `dev-auth` Playwright project (`MNT_DEV_AUTH_E2E=1`) because it
 * needs the authenticated AppShell but does not need the WebAuthn harness. The
 * default `chromium` project ignores this file so public preview-only runs stay
 * backend-free.
 */
test("320px authenticated drawer opens, traps focus, navigates, and closes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/login");

  await page.getByRole("button", { name: /역할 전환 로그인/ }).click();
  await page.getByRole("button", { name: "역할로 로그인" }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });

  await page.getByRole("button", { name: "메뉴 열기" }).click();
  const drawer = page.getByRole("dialog", { name: "콘솔" });
  await expect(drawer).toBeVisible();

  const nav = drawer.getByRole("navigation", { name: "메인 내비게이션" });
  const firstLink = nav.getByRole("link").first();
  const lastLink = nav.getByRole("link").last();
  await expect(firstLink).toBeFocused();

  await page.keyboard.press("Shift+Tab");
  await expect(lastLink).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(firstLink).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);

  await page.getByRole("button", { name: "메뉴 열기" }).click();
  await expect(drawer).toBeVisible();
  await nav.getByRole("link", { name: "배차", exact: true }).click();
  await expect(page).toHaveURL(/\/dispatch(?:$|[?#])/, { timeout: 15_000 });
  await expect(drawer).toHaveCount(0);
});
