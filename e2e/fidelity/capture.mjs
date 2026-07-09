#!/usr/bin/env node
/**
 * Fidelity dual-capture rig (charter D2.1 / §3 P0.0).
 *
 * Produces a comparable screenshot pair for one console screen:
 *   (a) REFERENCE — the design-authority prototype `Oyatie Console.dc.html`
 *       rendered in headless Chromium (file://, self-contained ~698 KB React app);
 *   (b) BUILD — the built `/console` route at the same viewport.
 *
 * P0.0 acceptance is that the rig WORKS: it emits `<screen>.reference.png`,
 * `<screen>.build.png`, and a `manifest.json` under e2e/.artifacts/fidelity/
 * (gitignored) so the themed empty viewport background can be compared. Later
 * slices navigate the prototype to a target screen/state (via prototype-anatomy
 * selectors) and hand the pair to the `visual-verdict` skill — the rig already
 * takes a `--screen` parameter so that extension needs no structural change.
 *
 * The built `/console` sits behind ProtectedRoute; to reach the themed viewport
 * without standing up a backend, the rig stubs the ONE boot call
 * (`POST /api/v1/auth/token/refresh`) with a claims-only session token. This is
 * a visual-capture concern only — later real-screen slices swap this stub for a
 * real persona login on the real backend (the e2e/ harness), unchanged rig.
 *
 * Usage:
 *   node e2e/fidelity/capture.mjs                 # build + serve + capture overview
 *   node e2e/fidelity/capture.mjs --screen=appr   # a named screen
 *   E2E_BASE_URL=http://localhost:5173 node e2e/fidelity/capture.mjs --no-serve
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

// --- args --------------------------------------------------------------------
const args = process.argv.slice(2);
const argVal = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const screen = argVal("screen", "overview");
// Shell chrome states (P0.1). Each entry runs a build-side setup step before the
// capture so ConsoleShell's distinct states get their own visual-regression
// screenshot (the primitive is snapshotted, not just the 30 screens that
// compose it). `--state=<key>`; default = the resting expanded shell.
const SHELL_STATES = {
  expanded: null,
  collapsed: async (page) => {
    await page.click("[data-cshell-collapse]");
    await page.waitForTimeout(300); // sidebar width transition settles
  },
};
const state = argVal("state", "");
const stateSetup = state ? SHELL_STATES[state] : null;
if (state && !(state in SHELL_STATES)) {
  throw new Error(`unknown --state "${state}" (known: ${Object.keys(SHELL_STATES).join(", ")})`);
}
const outKey = state ? `${screen}-${state}` : screen;
const width = Number(argVal("viewport", "1440"));
const height = Number(argVal("height", "900"));
const serve = !args.includes("--no-serve");
const port = Number(process.env.E2E_WEB_PORT ?? 5173);
const baseUrl = process.env.E2E_BASE_URL ?? `http://localhost:${port}`;

const dcPath = join(repoRoot, "docs/design/oyatie-console/Oyatie Console.dc.html");
const outDir = join(repoRoot, "e2e/.artifacts/fidelity");
mkdirSync(outDir, { recursive: true });

// Claims-only session (unsigned; the web client only base64-decodes JWT claims
// for UI hints — it never verifies the signature). Grants ADMIN so
// hasGrantedConsoleAccess() passes and ProtectedRoute renders /console.
const b64url = (obj) =>
  Buffer.from(JSON.stringify(obj)).toString("base64url");
const FAKE_JWT = `${b64url({ alg: "none", typ: "JWT" })}.${b64url({
  sub: "fidelity-rig",
  org: "00000000-0000-0000-0000-000000000000",
  roles: ["ADMIN"],
})}.sig`;

// --- optional preview server -------------------------------------------------
function sh(cmd, cmdArgs, opts = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, cmdArgs, { cwd: repoRoot, stdio: "inherit", ...opts });
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

let preview;
async function startPreview() {
  await sh("npm", ["--prefix", "web", "run", "build"]);
  preview = spawn(
    "npm",
    ["--prefix", "web", "run", "preview", "--", "--host", "localhost", "--port", String(port), "--strictPort"],
    { cwd: repoRoot, stdio: "inherit" },
  );
  await waitForUrl(baseUrl, 60_000);
}

// --- captures ----------------------------------------------------------------
async function sampleBg(page, selector) {
  return page.evaluate((sel) => {
    const el = sel ? document.querySelector(sel) : document.body;
    return el ? getComputedStyle(el).backgroundColor : null;
  }, selector);
}

async function main() {
  if (serve) await startPreview();

  let browser;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
      colorScheme: "light", // deterministic pair: both sides render the light theme
      reducedMotion: "reduce",
    });

    const manifest = {
      screen,
      state: state || "expanded",
      screenNavigation:
        "screen labels the capture pair; shell chrome variants are selected with --state",
      viewport: { width, height },
      capturedAt: new Date().toISOString(),
      reference: {},
      build: {},
    };

    // (a) REFERENCE — the prototype.
    const ref = await context.newPage();
    await ref.goto(`file://${dcPath}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await ref.waitForSelector(".console", { timeout: 120_000 });
    await ref.waitForTimeout(2000); // fonts + layout settle (generous, per charter)
    const refPng = join(outDir, `${screen}.reference.png`);
    await ref.screenshot({ path: refPng, fullPage: false });
    manifest.reference = {
      png: `e2e/.artifacts/fidelity/${screen}.reference.png`,
      source: "docs/design/oyatie-console/Oyatie Console.dc.html",
      consoleBg: await sampleBg(ref, ".console"),
    };
    await ref.close();

    // (b) BUILD — the built /console behind a stubbed boot session.
    const build = await context.newPage();
    await build.route("**/api/v1/auth/token/refresh", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ access_token: FAKE_JWT, requires_passkey_setup: false }),
      }),
    );
    await build.goto(`${baseUrl}/console`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await build.waitForSelector("[data-console-root]", { timeout: 60_000 });
    await build.waitForTimeout(500);
    if (stateSetup) await stateSetup(build);
    const buildPng = join(outDir, `${outKey}.build.png`);
    await build.screenshot({ path: buildPng, fullPage: false });
    manifest.build = {
      png: `e2e/.artifacts/fidelity/${outKey}.build.png`,
      url: `${baseUrl}/console`,
      state: state || "expanded",
      consoleBg: await sampleBg(build, "[data-console-root]"),
    };
    await build.close();

    const bgMatch = manifest.reference.consoleBg === manifest.build.consoleBg;
    manifest.consoleBgMatch = bgMatch;

    // Per-state manifest so capturing multiple states does not clobber one file;
    // the state-less default keeps the P0.0 `manifest.json` name unchanged.
    const manifestName = state ? `${outKey}.manifest.json` : "manifest.json";
    const manifestPath = join(outDir, manifestName);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    console.log(`fidelity rig OK — screen "${screen}" state "${manifest.build.state}"`);
    console.log(`  reference: ${manifest.reference.png} (console bg ${manifest.reference.consoleBg})`);
    console.log(`  build:     ${manifest.build.png} (console bg ${manifest.build.consoleBg})`);
    console.log(`  manifest:  e2e/.artifacts/fidelity/${manifestName}`);
    if (!bgMatch) {
      console.error(
        `console background mismatch: reference=${manifest.reference.consoleBg} build=${manifest.build.consoleBg}`,
      );
      process.exitCode = 1;
      return;
    }
  } finally {
    if (browser) await browser.close();
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    if (preview) preview.kill();
  });
