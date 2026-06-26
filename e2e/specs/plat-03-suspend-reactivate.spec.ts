import {
  test,
  expect,
  COLDSTART_OTP,
  redeemOtp,
  enrollPasskey,
} from "../fixtures/auth";
import { attachConsoleGuard, auditPage } from "../fixtures/ux";

/**
 * PLAT-03 — the PLATFORM admin suspends then reactivates a tenant.
 *
 * Onboards a fresh tenant in-spec (unique slug, order-independent), then drives
 * the consequential status-change flow through its confirm dialog:
 *   ACTIVE → (정지) SUSPENDED → (활성화) ACTIVE.
 * Each transition's badge update proves the PATCH /api/platform/orgs/{id} round-trips
 * and the list refreshes from the server.
 */

function uniqueSlug(): string {
  return `e2e-suspend-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

test("PLAT-03 platform admin suspends and reactivates a tenant", async ({
  page,
}) => {
  const consoleGuard = attachConsoleGuard(page);

  await redeemOtp(page, COLDSTART_OTP);
  await enrollPasskey(page);
  await expect(page).toHaveURL(/\/platform/, { timeout: 15_000 });

  // Onboard a fresh tenant to act on.
  await page.goto("/platform/onboard");
  const slug = uniqueSlug();
  await page.locator("#org-name").fill("E2E 정지대상 테넌트");
  await page.locator("#org-slug").fill(slug);
  await page.getByRole("button", { name: /^테넌시 등록$/ }).click();
  await expect(
    page.getByRole("heading", { name: /테넌시가 등록되었습니다\./ }),
  ).toBeVisible({ timeout: 10_000 });

  // Back to the tenant list.
  await page.getByRole("button", { name: /테넌시 목록으로/ }).click();
  await expect(
    page.getByRole("heading", { name: /테넌시 관리/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  // Scope to the new tenant's row.
  const slugCell = page.getByRole("cell", { name: slug });
  await expect(slugCell).toBeVisible({ timeout: 8_000 });
  const row = page.getByRole("row").filter({ has: slugCell });

  // ── Suspend ────────────────────────────────────────────────────────────────
  await row.getByRole("button", { name: /^정지$/ }).click();
  // The consequential change is confirmed in a dialog.
  const dialog = page.getByRole("dialog", { name: /테넌시 상태 변경/ });
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  await auditPage(page, { context: "/platform status-change dialog", consoleGuard });
  await dialog.getByRole("button", { name: /^변경$/ }).click();

  // The row's status badge flips to 정지 (SUSPENDED). `exact` so it matches only
  // the badge span — not the org name ("E2E 정지대상 테넌트") nor an action button.
  await expect(
    row.getByText("정지", { exact: true }),
  ).toBeVisible({ timeout: 8_000 });

  // ── Reactivate ───────────────────────────────────────────────────────────────
  await row.getByRole("button", { name: /^활성화$/ }).click();
  const dialog2 = page.getByRole("dialog", { name: /테넌시 상태 변경/ });
  await expect(dialog2).toBeVisible({ timeout: 5_000 });
  await dialog2.getByRole("button", { name: /^변경$/ }).click();

  // The badge returns to 활성 (ACTIVE). `exact` so it matches only the badge span,
  // not the 활성화 (reactivate) action button label.
  await expect(
    row.getByText("활성", { exact: true }),
  ).toBeVisible({ timeout: 8_000 });

  consoleGuard.assertClean();
});
