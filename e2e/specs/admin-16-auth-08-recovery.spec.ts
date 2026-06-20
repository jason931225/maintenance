import { test as base, expect, type Page } from "@playwright/test";

import {
  attachVirtualAuthenticator,
  enrollPasskey,
  redeemOtp,
  removeVirtualAuthenticator,
  type WebAuthnAuthenticator,
} from "../fixtures/auth";
import {
  loginAs,
  resetRateLimits,
  seedRoleOtp,
  sql,
  ROLE_CONFIG,
  TENANT_ORG_ID,
} from "../fixtures/roles";

/**
 * ADMIN-16 + AUTH-08 — admin-driven account recovery (credential reset), end to
 * end in a real browser across two sessions.
 *
 * Story:
 *   1. The target user (seeded RECEPTIONIST) enrolls a passkey and can log in.
 *   2. The SUPER_ADMIN opens that user and runs
 *      "패스키 재설정 / 로그인 코드 재발급" → a one-time OTP is shown.
 *   3. The user's OLD passkey login now FAILS (the server credential was revoked).
 *   4. The user redeems the new OTP → forced onboarding → enrolls a NEW passkey
 *      via the virtual authenticator → lands back in the app.
 *
 * Two pages drive the two sessions; the recovered user owns its own virtual
 * authenticators (an old one, then a fresh one) so the old credential genuinely
 * stops working after the reset.
 */

const ORG_ID = TENANT_ORG_ID;
const RECEPTIONIST = ROLE_CONFIG.RECEPTIONIST;

/** A unique X-Device-Id so each ceremony gets its own auth rate-limit bucket. */
async function seedDeviceId(page: Page): Promise<void> {
  await page.addInitScript((id) => {
    try {
      window.localStorage.setItem("maintenance_console_device_id", id);
    } catch {
      /* storage unavailable — backend falls back to per-IP limiting. */
    }
  }, `e2e-recovery-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
}

/** Drive the LoginPage passkey-login button (usernameless/discoverable). */
async function passkeyLogin(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByRole("button", { name: /^패스키로 로그인$/ }).click();
}

/** Log the current user out via the cookie-transport logout endpoint. */
async function logout(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await fetch("/api/v1/auth/logout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Auth-Transport": "cookie",
      },
      credentials: "include",
      body: "{}",
    });
  });
}

base("ADMIN-16/AUTH-08 admin credential-reset recovers a locked-out user", async ({
  browser,
}) => {
  // This spec drives the most auth ceremonies of the suite (enroll, prove login,
  // admin reset, failed old login, re-enroll, re-login). Clear the shared global
  // rate-limit bucket up front so neither this spec nor the ones after it trip the
  // 100/min/endpoint global cap (see resetRateLimits in fixtures/roles).
  resetRateLimits();

  // Two isolated contexts: the recovered user and the admin.
  const userContext = await browser.newContext();
  const adminContext = await browser.newContext();
  const userPage = await userContext.newPage();
  const adminPage = await adminContext.newPage();

  // ── Step 1: the RECEPTIONIST enrolls a passkey (old authenticator A_old) ──────
  await seedDeviceId(userPage);
  seedRoleOtp("RECEPTIONIST");
  const oldAuth: WebAuthnAuthenticator =
    await attachVirtualAuthenticator(userPage);
  try {
    await redeemOtp(userPage, RECEPTIONIST.otp);
    await enrollPasskey(userPage);
    await expect(userPage).toHaveURL(/\/dispatch/, { timeout: 15_000 });

    // ── Step 1b: confirm the OLD passkey can log in BEFORE the reset ─────────────
    await logout(userPage);
    await passkeyLogin(userPage);
    await expect(userPage).toHaveURL(/\/dispatch/, { timeout: 15_000 });

    // ── Step 2: the SUPER_ADMIN resets the user's credentials ───────────────────
    await loginAs(adminPage, "SUPER_ADMIN");
    await adminPage.goto("/settings/users");
    await expect(
      adminPage.getByRole("heading", { name: /사용자 관리/, level: 1 }),
    ).toBeVisible({ timeout: 8_000 });

    const row = adminPage.getByRole("row", { name: /E2E Receptionist/ });
    await row
      .getByRole("button", { name: "패스키 재설정 / 로그인 코드 재발급" })
      .click();

    const dialog = adminPage.getByRole("dialog", {
      name: "패스키 재설정 / 로그인 코드 재발급",
    });
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    // The reset is destructive → confirm() must be accepted.
    adminPage.on("dialog", (d) => void d.accept());
    await dialog
      .getByRole("button", { name: "패스키 재설정 및 코드 발급" })
      .click();

    // The fresh one-time code is shown once.
    await expect(dialog.getByText(/발급된 코드/)).toBeVisible({
      timeout: 8_000,
    });
    const newOtp = (await dialog.locator("code").innerText()).trim();
    expect(newOtp.length).toBeGreaterThan(0);

    // ── Step 3: the OLD passkey login now FAILS (credential revoked) ────────────
    await logout(userPage);
    await passkeyLogin(userPage);
    // The server has no matching credential → the login fails (stays on /login
    // with the failure alert) rather than landing in the app.
    await expect(
      userPage.getByText(/패스키 로그인에 실패했습니다\./),
    ).toBeVisible({ timeout: 15_000 });
    await expect(userPage).toHaveURL(/\/login/);

    // ── Step 4: the user redeems the new OTP → onboarding → NEW passkey ─────────
    // A fresh authenticator: the old credential is gone, so the user re-enrolls.
    await removeVirtualAuthenticator(oldAuth);
    const newAuth = await attachVirtualAuthenticator(userPage);
    try {
      await redeemOtp(userPage, newOtp);
      await enrollPasskey(userPage);
      await expect(userPage).toHaveURL(/\/dispatch/, { timeout: 15_000 });

      // The recovered NEW passkey logs in cleanly.
      await logout(userPage);
      await passkeyLogin(userPage);
      await expect(userPage).toHaveURL(/\/dispatch/, { timeout: 15_000 });
    } finally {
      await removeVirtualAuthenticator(newAuth);
    }
  } finally {
    await removeVirtualAuthenticator(oldAuth).catch(() => {});
    await userContext.close();
    await adminContext.close();
  }
});
