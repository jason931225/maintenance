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
 */
const PORT = Number(process.env.E2E_WEB_PORT ?? 5173);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

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
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
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
