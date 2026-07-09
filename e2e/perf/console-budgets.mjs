#!/usr/bin/env node
/**
 * Console CWV budget gate (charter D1 hyperscaler layer: "CWV budgets per
 * console screen asserted in the E2E rig; error budget before any ramp-up").
 *
 * Reads `e2e/perf/budgets.json`, loads each screen's route in headless Chromium,
 * measures LCP / CLS / INP via `PerformanceObserver`, and exits non-zero if any
 * measured value breaches its budget. The single source of truth for thresholds
 * is `budgets.json` — the app-side RUM (`web/src/console/rum/rum.ts`) reports the
 * same metrics from real users.
 *
 * Reaching `/console` reuses the fidelity rig's one-call stub (the boot refresh)
 * so no backend is required for a synthetic budget check; swap for a real
 * persona login when a screen needs backend data.
 *
 * Usage:
 *   node e2e/perf/console-budgets.mjs                 # build + serve + check all screens
 *   node e2e/perf/console-budgets.mjs --self-test     # prove the checker fails on breach, passes clean
 *   E2E_BASE_URL=http://localhost:5173 node e2e/perf/console-budgets.mjs --no-serve
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const budgets = JSON.parse(readFileSync(join(repoRoot, "e2e/perf/budgets.json"), "utf8"));

/**
 * Pure budget check: returns a breach string per exceeded metric ([] = pass).
 * `measured` values may be null when the metric was not observed (treated as 0
 * — no interaction means no INP, which is a pass, not a failure).
 */
export function checkBudget(screen, budget, measured) {
  const breaches = [];
  for (const metric of ["lcp", "inp", "cls"]) {
    const limit = budget[metric];
    if (typeof limit !== "number") continue;
    const value = measured[metric] ?? 0;
    if (value > limit) {
      breaches.push(`${screen}.${metric}: ${value} > ${limit}`);
    }
  }
  return breaches;
}

// --- self-test: proves the gate fails on a forced breach, passes clean --------
function selfTest() {
  const budget = { lcp: 2500, inp: 200, cls: 0.1 };
  const breached = checkBudget("shell", budget, { lcp: 4000, inp: 50, cls: 0.05 });
  const clean = checkBudget("shell", budget, { lcp: 1800, inp: 120, cls: 0.02 });
  const assert = (cond, msg) => {
    if (!cond) {
      console.error(`self-test FAILED: ${msg}`);
      process.exit(1);
    }
  };
  assert(breached.length === 1 && breached[0].startsWith("shell.lcp"), "forced LCP breach must be flagged");
  assert(clean.length === 0, "clean measurements must pass");
  console.log("console-budgets self-test OK (forced breach flagged, clean passes)");
}

// --- args --------------------------------------------------------------------
const args = process.argv.slice(2);
const serve = !args.includes("--no-serve");
const port = Number(process.env.E2E_WEB_PORT ?? 5173);
const baseUrl = process.env.E2E_BASE_URL ?? `http://localhost:${port}`;

if (args.includes("--self-test")) {
  selfTest();
  process.exit(0);
}

// Claims-only session so ProtectedRoute renders /console (mirrors capture.mjs).
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const FAKE_JWT = `${b64url({ alg: "none", typ: "JWT" })}.${b64url({
  sub: "perf-rig",
  org: "00000000-0000-0000-0000-000000000000",
  roles: ["ADMIN"],
})}.sig`;

function sh(cmd, cmdArgs) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, cmdArgs, { cwd: repoRoot, stdio: "inherit" });
    p.on("exit", (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited ${code}`))));
    p.on("error", rej);
  });
}

async function waitForUrl(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`preview server did not come up at ${url}`);
}

// In-page CWV collection: LCP (last entry startTime), CLS (sum without recent
// input), INP (worst event duration) — the same shapes rum.ts observes.
function collectCwvInPage() {
  return new Promise((resolvePage) => {
    const state = { lcp: 0, cls: 0, inp: 0 };
    const push = (type, fn, options = {}) => {
      try {
        new PerformanceObserver((l) => l.getEntries().forEach(fn)).observe({ type, buffered: true, ...options });
      } catch {
        /* unsupported */
      }
    };
    push("largest-contentful-paint", (e) => {
      state.lcp = Math.round(e.startTime);
    });
    push("layout-shift", (e) => {
      if (!e.hadRecentInput) state.cls += e.value;
    });
    push("event", (e) => {
      if (e.duration > state.inp) state.inp = e.duration;
    }, { durationThreshold: 0 });
    setTimeout(() => {
      resolvePage({ lcp: state.lcp, cls: Math.round(state.cls * 1000) / 1000, inp: Math.round(state.inp) });
    }, 2500);
  });
}

async function main() {
  const { chromium } = await import("playwright");
  let preview;
  if (serve) {
    await sh("npm", ["--prefix", "web", "run", "build"]);
    preview = spawn(
      "npm",
      ["--prefix", "web", "run", "preview", "--", "--host", "localhost", "--port", String(port), "--strictPort"],
      { cwd: repoRoot, stdio: "inherit", detached: true },
    );
    await waitForUrl(baseUrl, 60_000);
  }

  const browser = await chromium.launch();
  const allBreaches = [];
  try {
    for (const [screen, budget] of Object.entries(budgets.screens)) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      await page.route("**/api/v1/auth/token/refresh", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ access_token: FAKE_JWT, requires_passkey_setup: false }),
        }),
      );
      await page.goto(`${baseUrl}${budget.route}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector("[data-console-root]", { timeout: 60_000 });
      const cwv = page.evaluate(collectCwvInPage);
      const interactionTarget = page.getByRole("button", { name: /감사 로그|통합 개요/ }).first();
      await interactionTarget.click({ timeout: 10_000 });
      const measured = await cwv;
      const breaches = checkBudget(screen, budget, measured);
      console.log(`  ${screen} (${budget.route}): lcp=${measured.lcp}ms cls=${measured.cls} inp=${measured.inp}ms`);
      allBreaches.push(...breaches);
      await context.close();
    }
  } finally {
    await browser.close();
    if (preview?.pid) {
      try {
        process.kill(-preview.pid, "SIGTERM");
      } catch {
        preview.kill();
      }
    }
  }

  if (allBreaches.length > 0) {
    console.error(`console CWV budget breach:\n${allBreaches.map((b) => `  - ${b}`).join("\n")}`);
    process.exit(1);
  }
  console.log("console CWV budgets OK");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
