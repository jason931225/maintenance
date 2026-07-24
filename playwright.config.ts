import { defineConfig, devices } from "@playwright/test";

/**
 * Browser-E2E config for the forklift FSM web console.
 *
 * The browser loads the Vite preview origin (http://localhost:5173) which proxies
 * /api -> the backend, so every WebAuthn ceremony runs same-origin (RP origin ==
 * browser origin). The backend is booted out-of-band by e2e/harness/boot-backend.sh
 * (and the DB by e2e/harness/db.sh) before `playwright test`; this config only owns
 * the web tier via `webServer`.
 *
 * Auth ceremonies hit a per-IP rate limit (10/min from 127.0.0.1), so workers are
 * capped at 1 to keep the shared-IP budget predictable.
 *
 * `auth-09-dev-role-switcher.spec.ts` needs the OPPOSITE build: DEV mode
 * (`import.meta.env.DEV`) with the backend compiled `--features dev-auth` — a
 * production build (this file's default project) can never render the
 * switcher, and weakening its DEV-only predicate to make it render there is
 * exactly the wrong fix (mnt-gate-dev-auth-absence + dev_auth_absence.rs
 * already prove the feature is compiled OUT of a default/release build; this
 * spec proves the opposite build actually works). Attendance coverage runs in
 * that same production-faithful Vite development build; it exercises the active
 * `/attendance` route, not the independently gated `/console/*` preview.
 * `MNT_DEV_AUTH_E2E=1 node scripts/dev-up.mjs bootstrap` starts the backend
 * WITH dev-auth, `MNT_DEV_AUTH_E2E=1 npx playwright test --project=dev-auth`
 * runs the suite, and `node scripts/dev-up.mjs down` tears the stack down.
 */
const PORT = Number(process.env.E2E_WEB_PORT ?? process.env.MNT_DEV_VITE_PORT ?? 5173);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;
const DEV_AUTH_SPEC =
  /(?:admin-29-console-window|auth-09-dev-role-switcher|chrome-0[123]-(?:mobile-drawer|axe|workspace)|console-01-shell|hr-30-absence-exit-settlement|attendance-31-console-live)\.spec\.ts$/;
const DEV_AUTH_E2E = process.env.MNT_DEV_AUTH_E2E === "1";
const STATIC_PREVIEW_FALLBACK = process.env.E2E_STATIC_PREVIEW_FALLBACK === "1";

export default defineConfig({
  testDir: "./e2e/specs",
  outputDir: "./e2e/.artifacts/test-results",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ["list"],
    ["html", { outputFolder: "./e2e/.artifacts/html-report", open: "never" }],
  ],
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    // Vite preview must serve the proxy; the browser stays on the Vite origin.
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: "chromium",
      testIgnore: DEV_AUTH_SPEC,
      use: { ...devices["Desktop Chrome"] },
    },
    // Only exists when explicitly requested — `npx playwright test` with no
    // env set (every other caller) never sees this project at all.
    ...(DEV_AUTH_E2E
      ? [
          {
            name: "dev-auth",
            testMatch: DEV_AUTH_SPEC,
            use: { ...devices["Desktop Chrome"] },
          },
        ]
      : []),
  ],
  // DEV_AUTH_E2E: both tiers are already running for real (see the module doc
  // above) — nothing for Playwright to manage. STATIC_PREVIEW_FALLBACK is for
  // public storefront visual specs in restricted local sandboxes where binding a
  // preview port is not allowed; the spec fulfills built assets through route
  // handlers instead. Every other run builds and serves the production bundle.
  webServer: DEV_AUTH_E2E || STATIC_PREVIEW_FALLBACK
    ? undefined
    : {
        // Build first, then serve the static build through Vite preview (which we
        // teach to proxy /api in web/vite.config.ts). Reusing an already-running
        // preview keeps local iteration fast.
        command: `npm --prefix web run build && npm --prefix web run preview -- --host localhost --port ${PORT} --strictPort`,
        url: BASE_URL,
        timeout: 180_000,
        reuseExistingServer: !process.env.CI,
        stdout: "pipe",
        stderr: "pipe",
      },
});
