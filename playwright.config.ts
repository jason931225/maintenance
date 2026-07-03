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
 * spec proves the opposite build actually works). Set MNT_DEV_AUTH_E2E=1 and
 * bring up the real stack first — `MNT_DEV_AUTH_E2E=1 node scripts/dev-up.mjs
 * bootstrap` starts the backend WITH dev-auth and the Vite dev server in the
 * background; `node scripts/dev-up.mjs down` tears both down — then run this
 * config; a "dev-auth" project appears and the default "chromium" project
 * skips the spec. Unset (the default everywhere else, including the existing
 * "Browser E2E" CI job), this file behaves exactly as before.
 */
const PORT = Number(process.env.E2E_WEB_PORT ?? process.env.MNT_DEV_VITE_PORT ?? 5173);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;
const DEV_AUTH_SPEC = /auth-09-dev-role-switcher\.spec\.ts$/;
const DEV_AUTH_E2E = process.env.MNT_DEV_AUTH_E2E === "1";

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
  // above) — nothing for Playwright to manage. Every other run builds and
  // serves the production bundle itself, unchanged from before.
  webServer: DEV_AUTH_E2E
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
