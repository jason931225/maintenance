import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const CONSOLE_TOAST_EVENT = "maintenance:console-toast";

async function loginWithDevRole(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: /역할 전환 로그인/ }).click();
  await page.getByRole("button", { name: "역할로 로그인" }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
  await expect(page.getByRole("navigation", { name: "메인 내비게이션" })).toBeVisible();
}

function violationSummary(violations: Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"]) {
  return violations
    .map(
      (violation) =>
        `[${violation.impact ?? "unknown"}] ${violation.id}: ${violation.help}\n` +
        violation.nodes
          .slice(0, 5)
          .map((node) => `  - ${node.target.join(" ")}`)
          .join("\n"),
    )
    .join("\n\n");
}

async function expectNoAxeViolations(
  page: Page,
  selector: string,
  context: string,
) {
  const results = await new AxeBuilder({ page })
    .include(selector)
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  expect(
    results.violations,
    `${context} has axe violations:\n${violationSummary(results.violations)}`,
  ).toEqual([]);
}

/**
 * UI-M1a authenticated chrome axe guard.
 *
 * Runs only under the `dev-auth` Playwright project (`MNT_DEV_AUTH_E2E=1`).
 * The default preview-only `chromium` project ignores this file so public-route
 * storefront checks remain runnable without the authenticated backend stack.
 */
test("authenticated sidebar, topbar, drawer, menus, command palette, and toast have zero axe violations", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await loginWithDevRole(page);

  await expectNoAxeViolations(page, "aside[aria-label='콘솔']", "desktop sidebar");
  await expectNoAxeViolations(page, "header", "topbar");

  await page.getByRole("button", { name: "개인 알림 열기" }).click();
  await expect(
    page.getByRole("dialog", { name: "개인별 실시간 알림" }),
  ).toBeVisible();
  await expectNoAxeViolations(
    page,
    "[role='dialog'][aria-label='개인별 실시간 알림']",
    "notification popover",
  );
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "사용자 메뉴" }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await expectNoAxeViolations(page, "[role='menu']", "user menu");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "명령 팔레트 열기" }).click();
  await expect(page.getByRole("dialog", { name: "명령 팔레트" })).toBeVisible();
  await expectNoAxeViolations(page, "[role='dialog'][aria-modal='true']", "command palette");
  await page.keyboard.press("Escape");

  await page.evaluate((eventName) => {
    window.dispatchEvent(
      new CustomEvent(eventName, {
        detail: { message: "AP-3124 상신 완료", durationMs: 30_000 },
      }),
    );
  }, CONSOLE_TOAST_EVENT);
  await expect(page.getByRole("status")).toContainText("AP-3124");
  // The toast mounts with its `toast-in` entrance animation (opacity 0 -> 1,
  // 0.18s) still running; scanning axe mid-fade reads a blended, partially
  // transparent background and reports a spurious color-contrast violation.
  // Wait for the animation to settle at its final opacity before scanning.
  await expect(page.getByRole("status")).toHaveCSS("opacity", "1");
  await expectNoAxeViolations(page, "[role='status']", "console toast");

  await page.setViewportSize({ width: 320, height: 720 });
  await page.getByRole("button", { name: "메뉴 열기" }).click();
  await expect(page.getByRole("dialog", { name: "콘솔" })).toBeVisible();
  await expectNoAxeViolations(page, "[role='dialog'][aria-label='콘솔']", "mobile drawer");
});
