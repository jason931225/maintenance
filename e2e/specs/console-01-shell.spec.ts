import { execFileSync } from "node:child_process";

import { test, expect, type Page } from "@playwright/test";

/**
 * CONSOLE-01 — fail-closed route exposure for the mounted carbon-copy console.
 *
 * Runs under the `dev-auth` Playwright project (MNT_DEV_AUTH_E2E=1) against the
 * real backend, like chrome-0x. It uses the dev-auth role switcher (not the
 * WebAuthn/psql role fixture) because this CI job owns only the dev-auth stack.
 * The production exposure manifest is intentionally empty. Proves `/console`
 * never mounts development inventory for either an administrator or mechanic,
 * returns to the working legacy overview, and does not consult server rollout
 * authority when the independent evidence manifest already denies exposure.
 */
const TENANT_ORG_ID = "00000000-0000-0000-0000-0000000000a1";
const TENANT_REGION_ID = "00000000-0000-0000-0000-0000000000b1";
const TENANT_BRANCH_ID = "00000000-0000-0000-0000-0000000000c1";
const DATABASE_URL =
  process.env.MNT_DEV_DATABASE_URL ??
  "postgres://mnt_rt:mnt-dev-runtime-change-me@127.0.0.1:55432/mnt_dev";

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
}

async function expectConsoleToRemainDark(page: Page, roleLabel: DevRoleLabel) {
  await loginWithDevRole(page, roleLabel);
  await navigateWithinSpa(page, "/console");
  await expect(page).toHaveURL(/\/overview(?:$|[?#])/, { timeout: 15_000 });
  await expect(page.locator("[data-console-root]")).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "메인 내비게이션" }),
  ).toBeVisible();
}

test("CONSOLE-01 empty evidence manifest keeps administrators on the legacy overview", async ({
  page,
}) => {
  await expectConsoleToRemainDark(page, "관리자");
});

test("CONSOLE-01 empty evidence manifest keeps mechanics on the legacy overview", async ({
  page,
}) => {
  await expectConsoleToRemainDark(page, "정비사");
});

test("CONSOLE-01 empty evidence manifest short-circuits rollout authority", async ({
  page,
}) => {
  const rolloutRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/console/rollout") {
      rolloutRequests.push(request.url());
    }
  });

  await expectConsoleToRemainDark(page, "관리자");
  expect(rolloutRequests).toEqual([]);
});
