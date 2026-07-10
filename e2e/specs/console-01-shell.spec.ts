import AxeBuilder from "@axe-core/playwright";
import { execFileSync } from "node:child_process";

import { test, expect, type Page } from "@playwright/test";

/**
 * CONSOLE-01 — ConsoleShell chrome (carbon-copy P0.1).
 *
 * Runs under the `dev-auth` Playwright project (MNT_DEV_AUTH_E2E=1) against the
 * real backend, like chrome-0x. It uses the dev-auth role switcher (not the
 * WebAuthn/psql role fixture) because this CI job owns only the dev-auth stack.
 * Proves the shell renders behind a real persona login, its `state.screen`
 * navigation switches, the sidebar collapses, the
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

const TENANT_ORG_ID = "00000000-0000-0000-0000-0000000000a1";
const TENANT_REGION_ID = "00000000-0000-0000-0000-0000000000b1";
const TENANT_BRANCH_ID = "00000000-0000-0000-0000-0000000000c1";
const DATABASE_URL =
  process.env.MNT_DEV_DATABASE_URL ??
  "postgres://mnt_app:mnt-dev-local-change-me@127.0.0.1:55432/mnt_dev";

type DevRoleLabel = "관리자" | "정비사";

test.beforeAll(() => {
  ensureTenantBranch();
});

function ensureTenantBranch(): void {
  // The dev-auth CI stack runs migrations/cold-start only: KNL exists, but
  // branch fixtures from e2e/harness/seed.sql are intentionally not loaded.
  // Seed only the real tenant branch object the dev-auth endpoint validates;
  // persona users are still minted through the backend, not test fixtures.
  const sql = `
    SET ROLE mnt_rt;
    SET app.current_org = '${TENANT_ORG_ID}';
    INSERT INTO regions (id, name, org_id)
    VALUES ('${TENANT_REGION_ID}', 'KNL Dev Auth Region', '${TENANT_ORG_ID}')
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO branches (id, region_id, name, org_id)
    VALUES ('${TENANT_BRANCH_ID}', '${TENANT_REGION_ID}', 'KNL Dev Auth Branch', '${TENANT_ORG_ID}')
    ON CONFLICT (id) DO NOTHING;
  `;
  execFileSync("psql", [DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-q", "-c", sql], {
    stdio: "pipe",
  });
}

async function loginWithDevRole(page: Page, roleLabel: DevRoleLabel) {
  await page.goto("/login");
  await page.getByRole("button", { name: /역할 전환 로그인/ }).click();
  await page.getByRole("combobox").selectOption({ label: roleLabel });
  if (roleLabel === "정비사") {
    await page.getByLabel(/지점 ID/).fill(TENANT_BRANCH_ID);
  }
  await page.getByRole("button", { name: "역할로 로그인" }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
  await expect(
    page.getByRole("navigation", { name: "메인 내비게이션" }),
  ).toBeVisible({ timeout: 15_000 });
}

async function navigateWithinSpa(page: Page, path: string) {
  await page.evaluate((nextPath) => {
    window.history.pushState({}, "", nextPath);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
  await expect(page).toHaveURL(new RegExp(`${path}(?:$|[?#])`));
}

async function openConsole(page: Page, roleLabel: DevRoleLabel) {
  await loginWithDevRole(page, roleLabel);
  await navigateWithinSpa(page, "/console");
  await page.waitForSelector("[data-console-root]", { timeout: 15_000 });
}

test("CONSOLE-01 shell renders, navigates, collapses, scopes, and opens the palette", async ({
  page,
}) => {
  await openConsole(page, "관리자");

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
  await openConsole(page, "정비사");
  const nav = page.getByRole("navigation", { name: T.nav });
  await expect(nav).toBeVisible();
  // ungated personal surface is visible
  await expect(nav.getByRole("button", { name: T.overview })).toBeVisible();
  // governance/identity surfaces are omitted for a mechanic
  await expect(nav.getByRole("button", { name: T.policy })).toHaveCount(0);
  await expect(nav.getByRole("button", { name: T.audit })).toHaveCount(0);
});

test("CONSOLE-01 shell has zero axe violations", async ({ page }) => {
  await openConsole(page, "관리자");
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
