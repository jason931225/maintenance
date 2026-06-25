import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { test as base, type CDPSession, type Page, expect } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESET_SQL = resolve(HERE, "../harness/reset-coldstart.sql");
/** Backend log file the e2e harness writes (e2e/harness/boot-backend.sh). */
const BACKEND_LOG = resolve(HERE, "../.auth/backend.log");
const E2E_DB_URL =
  process.env.E2E_DATABASE_URL ??
  `postgres://${process.env.E2E_PG_SUPERUSER ?? process.env.USER ?? "postgres"}@${
    process.env.E2E_PG_HOST ?? "localhost"
  }:${process.env.E2E_PG_PORT ?? "5432"}/${process.env.E2E_DB_NAME ?? "mnt_e2e"}`;

/**
 * Restore the cold-start auth state (no enrolled passkey, one fresh bootstrap
 * OTP) so each AUTH spec starts from the same "first boot" point. Runs the fast
 * SQL reset against the dedicated e2e DB via psql.
 */
export function resetColdStart(): void {
  execFileSync("psql", [E2E_DB_URL, "-v", "ON_ERROR_STOP=1", "-q", "-f", RESET_SQL], {
    stdio: ["ignore", "ignore", "pipe"],
  });
}

/**
 * Auth fixtures for the browser-E2E suite.
 *
 * The forklift FSM enrolls discoverable (resident-key) passkeys and logs in with
 * an EMPTY allowCredentials list, so the CDP virtual authenticator MUST be a
 * CTAP2 internal authenticator with resident-key + user-verification support and
 * automatic presence/verification simulation — otherwise navigator.credentials
 * .create/get hang or reject (matches web/src/auth/webauthn.ts:210-241).
 *
 * Chromium-only: the virtual authenticator is attached over the Chrome DevTools
 * Protocol, which Playwright exposes via context.newCDPSession.
 */

/** Cold-start OTP seeded by the backend at boot (e2e/harness/boot-backend.sh). */
export const COLDSTART_OTP =
  process.env.E2E_COLDSTART_OTP ?? "e2e-coldstart-otp-000";

/**
 * Bootstrap OTP for the seeded TENANT ADMIN (KNL org). Used where a tenant-tier
 * session is required — the cold-start admin is platform-tier and is rejected by
 * tenant /api/* routes. Seeded by e2e/harness/seed.sql + reset-coldstart.sql.
 */
export const TENANT_ADMIN_OTP =
  process.env.E2E_TENANT_OTP ?? "e2e-tenant-otp-000";

export type WebAuthnAuthenticator = {
  cdp: CDPSession;
  authenticatorId: string;
};

/**
 * Attach a CTAP2 internal virtual authenticator to the page's context and return
 * a handle. The flags are the contract from the scoping notes: a platform
 * (internal) resident-key authenticator that auto-asserts user presence and
 * verification so ceremonies complete headlessly without a real security key.
 */
export async function attachVirtualAuthenticator(
  page: Page,
): Promise<WebAuthnAuthenticator> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

/** Tear an authenticator down (best-effort; ignores already-closed sessions). */
export async function removeVirtualAuthenticator(
  auth: WebAuthnAuthenticator,
): Promise<void> {
  try {
    await auth.cdp.send("WebAuthn.removeVirtualAuthenticator", {
      authenticatorId: auth.authenticatorId,
    });
  } catch {
    // session already detached on context close — nothing to do.
  }
}

/** Count resident credentials currently held by the virtual authenticator. */
export async function residentCredentialCount(
  auth: WebAuthnAuthenticator,
): Promise<number> {
  const { credentials } = await auth.cdp.send("WebAuthn.getCredentials", {
    authenticatorId: auth.authenticatorId,
  });
  return credentials.length;
}

/**
 * Drive the LoginPage OTP flow: open the one-time-code panel, type the code, and
 * submit. Selectors come from the rendered Korean strings (no test-ids exist).
 */
export async function redeemOtp(page: Page, code: string): Promise<void> {
  await page.goto("/login");
  // Reveal the OTP panel ("처음이신가요? 일회용 코드로 로그인").
  await page.getByRole("button", { name: /일회용 코드로 로그인/ }).click();
  await page.locator("#otp-code").fill(code);
  // Submit ("코드로 로그인").
  await page.getByRole("button", { name: /^코드로 로그인$/ }).click();
}

/**
 * Drive the LoginPage open-signup flow: reveal the email panel, type the address,
 * and submit. The backend creates a MEMBER account and "sends" a one-time code —
 * in e2e the stub email sender logs it instead, so the test reads it from the
 * backend log via {@link readSignupOtpFromLog}. Selectors come from the rendered
 * Korean strings (no test-ids exist).
 */
export async function submitSignup(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  // Reveal the signup panel ("계정이 없으신가요? 이메일로 가입").
  await page.getByRole("button", { name: /이메일로 가입/ }).click();
  await page.locator("#signup-email").fill(email);
  // Submit ("가입하고 코드 받기").
  await page.getByRole("button", { name: /가입하고 코드 받기/ }).click();
  // The page confirms the code was sent and reveals the OTP panel.
  await expect(page.getByText(/인증 코드를 이메일로 보냈습니다/)).toBeVisible({
    timeout: 15_000,
  });
}

/**
 * Read the one-time signup code the StubEmailSender logged for `email`.
 *
 * MNT_EMAIL_* is unset in the e2e harness, so the app uses the stub sender, which
 * logs `[DEV] OTP for {email}: {code} (ttl ...)` at info on target `mnt::email`
 * (see backend/crates/platform/email/src/lib.rs). The harness pipes all backend
 * output to e2e/.auth/backend.log, so the test scrapes the LAST matching line for
 * this address — the real OTP-delivery path, exercised end-to-end via the stub.
 */
export function readSignupOtpFromLog(email: string): string {
  const log = readFileSync(BACKEND_LOG, "utf8");
  const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`OTP for ${escaped}: (\\S+) \\(ttl`, "g");
  let code: string | undefined;
  for (const match of log.matchAll(pattern)) {
    code = match[1];
  }
  if (!code) {
    throw new Error(`no stub OTP logged for ${email} in ${BACKEND_LOG}`);
  }
  return code;
}

/**
 * Accept the first-login privacy/terms gate when onboarding requires it. CI role
 * login ceremonies start from a fresh OTP every time, so they must satisfy the
 * same required-consent gate a real user sees before passkey enrollment.
 */
export async function acceptRequiredPrivacyConsent(page: Page): Promise<void> {
  const desktopMethod = page.getByRole("button", {
    name: /이 기기|이 데스크톱/,
  });
  const submitConsent = page.getByRole("button", {
    name: /필수 동의 후 계속/,
  });

  const readyState = await Promise.race([
    desktopMethod
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => "desktop" as const)
      .catch(() => undefined),
    submitConsent
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => "consent" as const)
      .catch(() => undefined),
  ]);

  if (readyState === "desktop") {
    return;
  }

  if (readyState !== "consent") {
    await expect(
      page.getByText(/패스키 등록|필수 개인정보 수집·이용/),
    ).toBeVisible({ timeout: 1 });
  }

  await expect(submitConsent).toBeVisible({ timeout: 15_000 });
  await page.getByLabel(/개인정보 수집·이용 안내/).check();
  await page.getByLabel(/서비스 이용약관/).check();
  await expect(submitConsent).toBeEnabled();
  await submitConsent.click();
  await expect(desktopMethod).toBeVisible({ timeout: 15_000 });
}

/**
 * Enroll a passkey from the OnboardingPage by choosing the desktop (platform)
 * authenticator. The virtual authenticator answers navigator.credentials.create
 * automatically. Returns once enrollment has navigated away from /onboarding.
 */
export async function enrollPasskey(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/onboarding/);
  await acceptRequiredPrivacyConsent(page);
  // "이 기기" desktop / platform-authenticator enrollment.
  await page.getByRole("button", { name: /이 기기|이 데스크톱/ }).click();
  await expect(page).not.toHaveURL(/\/onboarding/, { timeout: 15_000 });
}

type AuthFixtures = {
  authenticator: WebAuthnAuthenticator;
};

/**
 * `test` with a per-test virtual authenticator already attached, plus a unique
 * X-Device-Id seeded into localStorage so each test gets its own per-device auth
 * rate-limit bucket (the backend caps 10 auth attempts/min/device).
 */
export const test = base.extend<AuthFixtures>({
  // `auto` so the virtual authenticator + cold-start reset are ALWAYS applied,
  // even for tests that do not destructure `authenticator` — otherwise a passkey
  // ceremony would run with no authenticator attached and fail.
  authenticator: [async ({ page }, use) => {
    // Reset cold-start state so every test starts from the same first-boot point
    // (no enrolled passkey + one fresh bootstrap OTP). Keeps the suite order-
    // independent despite the single shared backend + cold-start admin.
    resetColdStart();

    // Seed a unique device id BEFORE the app reads it, so the per-device rate
    // limit bucket is isolated per test.
    const deviceId = `e2e-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;
    await page.addInitScript((id) => {
      try {
        window.localStorage.setItem("maintenance_console_device_id", id);
      } catch {
        // storage unavailable — backend falls back to per-IP limiting.
      }
    }, deviceId);

    const authenticator = await attachVirtualAuthenticator(page);
    await use(authenticator);
    await removeVirtualAuthenticator(authenticator);
  }, { auto: true }],
});

export { expect } from "@playwright/test";
