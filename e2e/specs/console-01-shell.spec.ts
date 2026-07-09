import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { test, expect, loginAsLanding } from "../fixtures/roles";

/**
 * CONSOLE-01 — ConsoleShell chrome (carbon-copy P0.1).
 *
 * Runs under the `dev-auth` Playwright project (MNT_DEV_AUTH_E2E=1) against the
 * real backend, like chrome-0x. Proves the shell renders behind a real persona
 * login, its `state.screen` navigation switches, the sidebar collapses, the
 * scope switcher lists only the union of the persona's authorized entities
 * (never a literal all-orgs option), ⌘K opens/closes an empty palette surface,
 * persona deny-by-omission hides privileged nav, and the shell has zero axe
 * violations.
 *
 * UI strings mirror web/src/i18n/ko.ts `console.shell` — e2e specs hardcode
 * rather than importing across packages.
 */
const T = {
  nav: "주 메뉴",
  overview: "통합 개요",
  audit: "감사 로그",
  policy: "권한·정책",
  collapse: "메뉴 접기",
  expand: "메뉴 펼치기",
  rail: "커뮤니케이션",
  body: "화면 본문",
  scope: "범위 선택",
  scopeList: "운영 범위",
  scopeAll: "그룹 전체",
  palette: "검색 팔레트",
  palettePlaceholder: "사람·업무·문서 검색",
} as const;

async function openConsole(page: Page, role: "ADMIN" | "MECHANIC") {
  await loginAsLanding(page, role);
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
  await page.goto("/console");
  await page.waitForSelector("[data-console-root]", { timeout: 15_000 });
}

test("CONSOLE-01 shell renders, navigates, collapses, scopes, and opens the palette", async ({
  page,
}) => {
  await openConsole(page, "ADMIN");

  // shell regions present
  const nav = page.getByRole("navigation", { name: T.nav });
  await expect(nav).toBeVisible();
  await expect(page.getByRole("complementary", { name: T.rail })).toBeVisible();
  await expect(page.getByLabel(T.body)).toBeVisible();

  // state.screen navigation
  const overview = nav.getByRole("button", { name: T.overview });
  await expect(overview).toHaveAttribute("aria-current", "true");
  await nav.getByRole("button", { name: T.audit }).click();
  await expect(nav.getByRole("button", { name: T.audit })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(page.getByLabel(T.body)).toHaveAttribute("data-cshell-screen", "audit");

  // collapse / expand
  const sidebar = page.locator("[data-cshell-sidebar]");
  await expect(sidebar).toHaveAttribute("data-collapsed", "false");
  await page.getByRole("button", { name: T.collapse }).click();
  await expect(sidebar).toHaveAttribute("data-collapsed", "true");
  await page.getByRole("button", { name: T.expand }).click();
  await expect(sidebar).toHaveAttribute("data-collapsed", "false");

  // scope switcher — union first, only authorized entities
  await page.getByRole("button", { name: T.scope }).click();
  const listbox = page.getByRole("listbox", { name: T.scopeList });
  await expect(listbox).toBeVisible();
  const options = listbox.getByRole("option");
  await expect(options.first()).toHaveText(new RegExp(T.scopeAll));
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(listbox).toBeHidden();

  // ⌘K palette open + Esc close
  await page.keyboard.press("Meta+k");
  const dialog = page.getByRole("dialog", { name: T.palette });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByPlaceholder(T.palettePlaceholder)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("CONSOLE-01 persona deny-by-omission hides privileged nav from a non-admin", async ({
  page,
}) => {
  await openConsole(page, "MECHANIC");
  const nav = page.getByRole("navigation", { name: T.nav });
  await expect(nav).toBeVisible();
  // ungated personal surface is visible
  await expect(nav.getByRole("button", { name: T.overview })).toBeVisible();
  // governance/identity surfaces are omitted for a mechanic
  await expect(nav.getByRole("button", { name: T.policy })).toHaveCount(0);
  await expect(nav.getByRole("button", { name: T.audit })).toHaveCount(0);
});

test("CONSOLE-01 shell has zero axe violations", async ({ page }) => {
  await openConsole(page, "ADMIN");
  const results = await new AxeBuilder({ page })
    .include("[data-console-root]")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    results.violations,
    `console shell axe violations:\n${results.violations
      .map((v) => `[${v.impact ?? "?"}] ${v.id}: ${v.help}`)
      .join("\n")}`,
  ).toEqual([]);
});
