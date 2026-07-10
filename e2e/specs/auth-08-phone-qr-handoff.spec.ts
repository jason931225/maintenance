import { type Page } from "@playwright/test";

import {
  acceptRequiredPrivacyConsent,
  attachVirtualAuthenticator,
  enrollPasskey,
  expect,
  redeemOtp,
  removeVirtualAuthenticator,
  residentCredentialCount,
  TENANT_ADMIN_OTP,
  test,
  type WebAuthnAuthenticator,
} from "../fixtures/auth";

/**
 * AUTH-08 — desktop onboarding QR -> phone enrollment -> desktop completion.
 *
 * Regression for the real report:
 *   PC OTP -> choose phone QR -> phone scans/opens link -> phone enrolls passkey
 *   -> PC must leave onboarding automatically WITHOUT a manual refresh.
 *
 * The desktop and phone run in separate browser contexts with separate virtual
 * authenticators, so this proves the app-level handoff, not a same-device passkey
 * shortcut. The final user-table assertion covers the visible "설정 대기" symptom:
 * once the phone-created credential exists, the admin account must render ACTIVE.
 */

async function seedDeviceId(page: Page): Promise<void> {
  await page.addInitScript((id) => {
    try {
      window.localStorage.setItem("maintenance_console_device_id", id);
    } catch {
      /* storage unavailable — backend falls back to per-IP limiting. */
    }
  }, `e2e-phone-qr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
}

test("AUTH-08 phone QR enrollment completes the waiting desktop and clears pending setup", async ({
  browser,
  page,
}) => {
  // Desktop: first-login OTP lands on passkey onboarding.
  await redeemOtp(page, TENANT_ADMIN_OTP);
  await expect(page).toHaveURL(/\/onboarding/, { timeout: 15_000 });
  await acceptRequiredPrivacyConsent(page);

  // Desktop: show the phone-QR handoff and capture the real, backend-minted link.
  await page.getByRole("button", { name: /휴대폰으로 등록 \(QR\)/ }).click();
  await expect(
    page.getByText(/휴대폰에서 등록을 완료하면 이 화면이 자동으로 이동합니다\./),
  ).toBeVisible({ timeout: 15_000 });
  const handoffHref = await page
    .getByRole("link", { name: /스캔이 어려우면 이 링크/ })
    .getAttribute("href");
  expect(handoffHref).toContain("/login#otp=");

  // Phone: a separate device opens the scanned link and enrolls its own passkey.
  const phoneContext = await browser.newContext();
  const phonePage = await phoneContext.newPage();
  await seedDeviceId(phonePage);
  const phoneAuth: WebAuthnAuthenticator =
    await attachVirtualAuthenticator(phonePage);

  try {
    await phonePage.goto(handoffHref!);
    await expect(phonePage.locator("#otp-code")).toHaveValue(/\S+/);
    await phonePage.getByRole("button", { name: /^코드로 로그인$/ }).click();
    await enrollPasskey(phonePage);
    await expect(phonePage).toHaveURL(/\/overview/, { timeout: 15_000 });
    await expect
      .poll(() => residentCredentialCount(phoneAuth), { timeout: 15_000 })
      .toBe(1);

    // Desktop: the waiting QR screen must observe completion and leave onboarding
    // on its own. This is the failed path from the bug report; no refresh allowed.
    await expect(page).toHaveURL(/\/overview/, { timeout: 20_000 });

    // The visible user-management status must no longer say "설정 대기".
    await page.goto("/settings/users");
    const adminRow = page.getByRole("row", { name: /E2E Admin/ });
    await expect(adminRow).toBeVisible({ timeout: 15_000 });
    await expect(adminRow.getByText("활성", { exact: true })).toBeVisible();
    await expect(adminRow.getByText("설정 대기", { exact: true })).toHaveCount(0);
  } finally {
    await removeVirtualAuthenticator(phoneAuth);
    await phoneContext.close();
  }
});
