import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

import {
  test as base,
  type BrowserContext,
  type Page,
  expect,
} from "@playwright/test";

import {
  attachVirtualAuthenticator,
  enrollPasskey,
  redeemOtp,
  removeVirtualAuthenticator,
  type WebAuthnAuthenticator,
} from "./auth";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(HERE, "../.auth/roles");

const E2E_DB_URL =
  process.env.E2E_DATABASE_URL ??
  `postgres://${process.env.E2E_PG_SUPERUSER ?? process.env.USER ?? "postgres"}@${
    process.env.E2E_PG_HOST ?? "localhost"
  }:${process.env.E2E_PG_PORT ?? "5432"}/${process.env.E2E_DB_NAME ?? "mnt_e2e"}`;

/** The five seeded tenant roles (e2e/harness/seed.sql). */
export type TenantRole =
  | "RECEPTIONIST"
  | "MECHANIC"
  | "ADMIN"
  | "EXECUTIVE"
  | "SUPER_ADMIN";

/** KNL tenant org id (migration 0028) + the seeded E2E branch (seed.sql). */
export const TENANT_ORG_ID = "00000000-0000-0000-0000-0000000000a1";
export const TENANT_BRANCH_ID = "00000000-0000-0000-0000-0000000000c1";

type RoleConfig = {
  userId: string;
  /** Plaintext OTP code seeded fresh before each ceremony (single-use). */
  otp: string;
  /** hex sha256(otp) — the column stores the digest, never the code. */
  otpHash: string;
};

/**
 * Per-role bootstrap-OTP config. The `userId`s match e2e/harness/seed.sql; the
 * `otpHash` is sha256 of the plaintext code (verified to match the column's
 * `token_hash` digest, the same scheme as the harness tenant-admin OTP).
 */
export const ROLE_CONFIG: Record<TenantRole, RoleConfig> = {
  RECEPTIONIST: {
    userId: "00000000-0000-0000-0000-0000000d0001",
    otp: "e2e-recp-otp-000",
    otpHash:
      "08d83fddd5b09bc01df38916b6dfb00982e260de90849ab4a497fc2c20398dc0",
  },
  MECHANIC: {
    userId: "00000000-0000-0000-0000-0000000d0002",
    otp: "e2e-mech-otp-000",
    otpHash:
      "0531fcf2a0cec8b4d33ef1a67f2feee5e8d95326dbffb7f831b51f3a7e07a6a1",
  },
  ADMIN: {
    userId: "00000000-0000-0000-0000-0000000d0003",
    otp: "e2e-admin-otp-000",
    otpHash:
      "c979bc742fff3610258ddb1f862b37d8f12d0286209dfadd9c9d98e63c24e8de",
  },
  EXECUTIVE: {
    userId: "00000000-0000-0000-0000-0000000d0004",
    otp: "e2e-exec-otp-000",
    otpHash:
      "0a3745ac9c317b184c65ae2b5bf663c3be430aae35c8b4babaa2151f116d2b0a",
  },
  SUPER_ADMIN: {
    userId: "00000000-0000-0000-0000-0000000d0005",
    otp: "e2e-sadmin-otp-000",
    otpHash:
      "7eea425300e98e3105930f843e4b35184826b8e565c3359ad830677c3039964a",
  },
};

/** Run a SQL statement against the e2e DB as the (BYPASSRLS) superuser. */
export function sql(statement: string): void {
  execFileSync("psql", [E2E_DB_URL, "-v", "ON_ERROR_STOP=1", "-q", "-c", statement], {
    stdio: ["ignore", "ignore", "pipe"],
  });
}

/**
 * Clear the fixed-window auth rate-limit counters before a role ceremony.
 *
 * In e2e every request shares one origin with NO X-Forwarded-For, so the per-IP
 * bucket is skipped and ALL auth traffic collapses onto the single `global`
 * bucket (cap 100/min/endpoint). A full suite drives dozens of redeem/refresh/
 * login ceremonies; within one wall-clock minute the `refresh`/`otp_redeem`
 * global counters can cross 100 and start returning 429 — surfacing in-browser as
 * a spurious "invalid/expired OTP" or an undefined refreshed access token. The
 * roles fixture deliberately does NOT run the cold-start reset (it would wipe
 * captured passkeys/refresh families), so we clear ONLY this global, RLS-free
 * counters table to keep each test's budget isolated and order-independent.
 * Production is unaffected: real clients have distinct IPs, so the per-IP cap
 * (not the global one) governs there.
 */
export function resetRateLimits(): void {
  sql("DELETE FROM auth_rate_limit");
}

/**
 * Seed (or re-issue) a single fresh, unexpired, single-use bootstrap OTP for the
 * given role's seeded user. Clears that user's prior bootstrap rows + passkeys so
 * the redeem forces the onboarding/enroll path every time. Order-independent:
 * each call restores the "needs passkey setup" precondition for one user without
 * disturbing the other roles. Mirrors how seed.sql seeds the tenant-admin OTP.
 */
export function seedRoleOtp(role: TenantRole): void {
  const cfg = ROLE_CONFIG[role];
  sql(
    `BEGIN;
     SELECT set_config('app.current_org', '${TENANT_ORG_ID}', true);
     DELETE FROM auth_webauthn_credentials WHERE user_id = '${cfg.userId}';
     DELETE FROM auth_bootstrap_credentials WHERE user_id = '${cfg.userId}';
     INSERT INTO auth_bootstrap_credentials
       (id, user_id, token_hash, issued_at, expires_at, org_id)
     VALUES
       (gen_random_uuid(), '${cfg.userId}',
        decode('${cfg.otpHash}', 'hex'),
        now(), now() + interval '1 hour', '${TENANT_ORG_ID}');
     COMMIT;`,
  );
}

/** Unique X-Device-Id so each ceremony gets its own auth rate-limit bucket. */
function freshDeviceId(): string {
  return `e2e-role-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

async function seedDeviceId(page: Page): Promise<void> {
  await page.addInitScript((id) => {
    try {
      window.localStorage.setItem("maintenance_console_device_id", id);
    } catch {
      /* storage unavailable — backend falls back to per-IP limiting. */
    }
  }, freshDeviceId());
}

/** The HttpOnly refresh cookie the backend sets in the web transport. */
const REFRESH_COOKIE_NAME = "mnt_refresh";

/**
 * Block until the freshly-enrolled session is fully established and durable, so a
 * spec that immediately navigates away does not race the still-settling session.
 *
 * The race being closed: after enrollment the OnboardingPage does a CLIENT-side
 * `navigate("/work-hub")` (web/src/pages/OnboardingPage.tsx) the instant the
 * passkey is registered. The URL flips to /work-hub immediately, but at that
 * point the session lives in an in-memory access token plus an HttpOnly
 * `mnt_refresh` cookie the redeem/enroll exchange is still committing. A spec
 * that returns here and then `page.goto(...)` (a FULL document reload) drops the
 * in-memory token and forces AuthProvider's boot silent-refresh
 * (web/src/context/auth.tsx) to rebuild the session from that cookie — so the
 * cookie MUST already be committed before we return.
 *
 * Readiness is gated on the AUTHENTICATED SHELL, not on the /work-hub page's own
 * data render. The shell's main nav (메인 내비게이션) paints for any authenticated
 * tenant session once `restoring` settles and a valid session clears
 * ProtectedRoute — i.e. we are in the app, not bounced to /login. We deliberately
 * do NOT wait on the dispatch board's work-order content: that couples every
 * login to DispatchPage's render, so a transient page-level render error (caught
 * by the route error boundary, from which a spec would normally just navigate
 * away) would otherwise turn into a hard login failure for unrelated specs.
 */
export async function waitForSessionReady(page: Page): Promise<void> {
  // (1) Authenticated shell painted (we are in the app, not redirected to
  //     /login). The main-nav landmark renders for every tenant session and is
  //     independent of the active page's own data load succeeding.
  await expect(
    page.getByRole("navigation", { name: /메인 내비게이션/ }),
  ).toBeVisible({ timeout: 15_000 });
  // (2) The HttpOnly refresh cookie has landed, so a later page.goto reload's
  //     boot silent-refresh can deterministically restore the session.
  await expect
    .poll(
      async () => {
        const cookies = await page.context().cookies();
        return cookies.some((cookie) => cookie.name === REFRESH_COOKIE_NAME);
      },
      { timeout: 15_000 },
    )
    .toBe(true);
}

/**
 * Drive the REAL ceremony for a seeded role on a page that already has a virtual
 * authenticator attached: redeem the role's fresh bootstrap OTP, get forced into
 * onboarding, enroll a discoverable passkey, and land in the tenant app
 * (/work-hub). The caller owns the authenticator lifecycle.
 */
export async function performRoleLogin(
  page: Page,
  role: TenantRole,
): Promise<void> {
  seedRoleOtp(role);
  await redeemOtp(page, ROLE_CONFIG[role].otp);
  await enrollPasskey(page);
  // Every seeded tenant role lands on the default tenant work hub after
  // onboarding. Dispatch-specific specs may navigate to /dispatch explicitly
  // after this helper has proven the real first screen.
  await expect(page).toHaveURL(/\/work-hub/, { timeout: 15_000 });
  // Do not return until the session is fully established AND durable — otherwise
  // a spec that immediately reloads via page.goto() races the still-committing
  // refresh cookie and gets bounced to /login. Gates ALL loginAs callers.
  await waitForSessionReady(page);
}

/**
 * One-shot login for a role: seeds a unique device id, attaches a throwaway
 * virtual authenticator, runs the ceremony, then detaches it. Leaves the page
 * authenticated (in-memory access token + HttpOnly mnt_refresh cookie). Used
 * both directly by specs and to capture a reusable storageState.
 */
export async function loginAs(page: Page, role: TenantRole): Promise<void> {
  await loginAsLanding(page, role);
  // Keep existing dispatch-oriented e2e specs stable while the product landing
  // moves to /work-hub. Specs that need to assert the actual first screen use
  // loginAsLanding directly.
  await page.goto("/dispatch");
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });
}

/** Login and leave the page on the real authenticated landing route (/work-hub). */
export async function loginAsLanding(page: Page, role: TenantRole): Promise<void> {
  await seedDeviceId(page);
  const authenticator = await attachVirtualAuthenticator(page);
  try {
    await performRoleLogin(page, role);
  } finally {
    await removeVirtualAuthenticator(authenticator);
  }
}

/**
 * Capture a Playwright storageState for a role by running the real ceremony once
 * in a throwaway context, then persisting the cookies (the HttpOnly mnt_refresh
 * cookie is what the app's boot silent-refresh restores the session from). The
 * path is cached per worker; specs that load it skip the ceremony entirely and
 * the app re-hydrates the session on first navigation.
 */
export async function captureRoleStorageState(
  context: BrowserContext,
  role: TenantRole,
): Promise<string> {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  const statePath = resolve(STATE_DIR, `${role.toLowerCase()}.json`);
  const page = await context.newPage();
  try {
    await loginAs(page, role);
    await context.storageState({ path: statePath });
  } finally {
    await page.close();
  }
  return statePath;
}

type RoleFixtures = {
  /**
   * Log the current `page` in as a role via the real OTP→onboard→enroll ceremony.
   * Order-independent: re-seeds its own single-use OTP and a fresh device-id
   * bucket on every call, so specs do not depend on run order.
   */
  loginAs: (role: TenantRole) => Promise<void>;
};

/**
 * `test` for role-authenticated specs. It does NOT run the cold-start reset from
 * fixtures/auth.ts (which would wipe captured passkeys/refresh families); instead
 * each spec calls `loginAs(role)` to drive a fresh, self-contained ceremony.
 */
export const test = base.extend<RoleFixtures>({
  loginAs: async ({ page }, use) => {
    // Isolate this test's auth rate-limit budget so a busy suite cannot bleed the
    // shared `global` bucket across tests (see resetRateLimits). Order-independent.
    resetRateLimits();
    await use((role: TenantRole) => loginAs(page, role));
  },
});

export { expect } from "@playwright/test";
