#!/usr/bin/env node
/**
 * Window/pin engine component-state captures (charter D1 "grammar = versioned
 * component library": Playwright component screenshots of a primitive's distinct
 * states — here the window engine's four: grid / pin-split / popout-float /
 * tray-minimize).
 *
 * Unlike the screen-level dual-capture rig (capture.mjs, which diffs a built
 * screen against the prototype `dc.html`), this captures the P0.2 primitive in
 * ISOLATION from its dev harness (/console-dev/window?state=…). Screen-level
 * prototype dual-capture for the window grammar happens later, when the hr/
 * review/att/pay screens that host it exist (D2). This script proves the four
 * states render and gives a per-state PNG a reviewer/CI can eyeball or diff.
 *
 * Reuses capture.mjs's mechanics verbatim: build+preview, stub the one boot
 * refresh call with a claims-only ADMIN token, screenshot at a fixed light-theme
 * viewport with animations disabled. Emits e2e/.artifacts/fidelity/window-<state>.png
 * (gitignored) + window-states.manifest.json.
 *
 * Usage:
 *   node e2e/fidelity/window-states.mjs                    # build + serve + capture all 4
 *   E2E_BASE_URL=http://localhost:5173 node e2e/fidelity/window-states.mjs --no-serve
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const serve = !args.includes("--no-serve");
const port = Number(process.env.E2E_WEB_PORT ?? 5173);
const baseUrl = process.env.E2E_BASE_URL ?? `http://localhost:${port}`;
const width = 1440;
const height = 900;

const STATES = ["grid", "pin-split", "popout-float", "tray-minimize"];
const outDir = join(repoRoot, "e2e/.artifacts/fidelity");
mkdirSync(outDir, { recursive: true });

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const FAKE_JWT = `${b64url({ alg: "none", typ: "JWT" })}.${b64url({
  sub: "fidelity-rig",
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

async function main() {
  if (serve) await startPreview();
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  const manifest = { primitive: "window-engine", viewport: { width, height }, capturedAt: new Date().toISOString(), states: {} };

  for (const state of STATES) {
    const page = await context.newPage();
    await page.route("**/api/v1/auth/token/refresh", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ access_token: FAKE_JWT, requires_passkey_setup: false }),
      }),
    );
    // The workspace GET is intentionally NOT stubbed — it 404s on the preview
    // server, the engine falls back to the in-memory default (saves disabled),
    // and the `?state=` param drives the target state deterministically.
    await page.goto(`${baseUrl}/console-dev/window?state=${state}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForSelector("[data-window-harness]", { timeout: 60_000 });
    await page.waitForTimeout(600);
    const png = join(outDir, `window-${state}.png`);
    await page.screenshot({ path: png, fullPage: false });
    manifest.states[state] = { png: `e2e/.artifacts/fidelity/window-${state}.png` };
    await page.close();
    console.log(`  captured ${state} -> ${manifest.states[state].png}`);
  }

  await browser.close();
  writeFileSync(join(outDir, "window-states.manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`window-engine states OK — ${STATES.length} captured`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    if (preview) preview.kill();
  });
