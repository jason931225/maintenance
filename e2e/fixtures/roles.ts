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
  `postgres://${process.env.USER ?? "postgres"}@${
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

/**
 * Drive the REAL ceremony for a seeded role on a page that already has a virtual
 * authenticator attached: redeem the role's fresh bootstrap OTP, get forced into
 * onboarding, enroll a discoverable passkey, and land in the tenant app
 * (/dispatch). The caller owns the authenticator lifecycle.
 */
export async function performRoleLogin(
  page: Page,
  role: TenantRole,
): Promise<void> {
  seedRoleOtp(role);
  await redeemOtp(page, ROLE_CONFIG[role].otp);
  await enrollPasskey(page);
  // Every seeded tenant role lands on the default tenant route after onboarding.
  await expect(page).toHaveURL(/\/dispatch/, { timeout: 15_000 });
}

/**
 * One-shot login for a role: seeds a unique device id, attaches a throwaway
 * virtual authenticator, runs the ceremony, then detaches it. Leaves the page
 * authenticated (in-memory access token + HttpOnly mnt_refresh cookie). Used
 * both directly by specs and to capture a reusable storageState.
 */
export async function loginAs(page: Page, role: TenantRole): Promise<void> {
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
    await use((role: TenantRole) => loginAs(page, role));
  },
});

export { expect } from "@playwright/test";
