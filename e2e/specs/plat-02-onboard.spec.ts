import {
  test,
  expect,
  COLDSTART_OTP,
  redeemOtp,
  enrollPasskey,
} from "../fixtures/auth";
import { attachConsoleGuard, auditPage } from "../fixtures/ux";

/**
 * PLAT-02 — the PLATFORM admin onboards a NEW tenant and receives the one-time
 * SUPER_ADMIN OTP.
 *
 * This is the spec that proves the onboarding response-contract fix: the backend
 * now serializes `{ org, otp }` (was `{ organization, admin_otp }`), so the
 * console's OnboardResult actually surfaces the one-time code. With the old
 * field names the `<code>` rendered `undefined` — a code the new tenant could
 * never use. A real onboard against the live backend is the only thing that
 * catches this (the unit test mocks the response shape).
 *
 * Each run uses a unique slug so repeated/twice-green runs never collide on the
 * slug-unique constraint (a 409). The audit table forbids deletes, so we don't
 * clean up — `e2e/run.sh` drops + recreates the DB per run anyway.
 */

function uniqueSlug(): string {
  return `e2e-onboard-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

test("PLAT-02 platform admin onboards a tenant and sees the one-time OTP", async ({
  page,
}) => {
  const consoleGuard = attachConsoleGuard(page);

  await redeemOtp(page, COLDSTART_OTP);
  await enrollPasskey(page);
  await expect(page).toHaveURL(/\/platform/, { timeout: 15_000 });

  await page.goto("/platform/onboard");
  await expect(
    page.getByRole("heading", { name: /테넌트 등록/, level: 1 }),
  ).toBeVisible({ timeout: 8_000 });

  // Audit the empty form before filling it.
  await auditPage(page, { context: "/platform/onboard (form)", consoleGuard });

  const slug = uniqueSlug();
  await page.locator("#org-name").fill("E2E 새 테넌트");
  await page.locator("#org-slug").fill(slug);
  await page.getByRole("button", { name: /^테넌트 등록$/ }).click();

  // Success screen renders.
  await expect(
    page.getByRole("heading", { name: /테넌트가 등록되었습니다\./ }),
  ).toBeVisible({ timeout: 10_000 });

  // The one-time OTP heading + a non-empty code render. The code lives in a
  // <code> element; it must be a real, non-empty token (proving the `otp` field
  // mapped through — the old `admin_otp` field name produced an empty code).
  await expect(page.getByText(/일회용 코드 \(한 번만 표시됩니다\)/)).toBeVisible();
  const otpCode = page.locator("code");
  await expect(otpCode).toBeVisible();
  const otpText = (await otpCode.first().textContent())?.trim() ?? "";
  expect(otpText.length).toBeGreaterThan(0);
  expect(otpText).not.toBe("undefined");

  // The subtitle reflects the created org name/slug.
  await expect(page.getByText(new RegExp(slug))).toBeVisible();

  // The success screen renders no console errors and no leaked i18n keys (the OTP
  // <code> is excluded from the i18n probe so the code itself is not flagged).
  await auditPage(page, { context: "/platform/onboard (success + OTP)", consoleGuard });
});
