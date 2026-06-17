import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const backendDir = resolve(root, "backend");
const port = Number(process.env.OPENAPI_DRIFT_PORT ?? "18080");
const baseUrl = `http://127.0.0.1:${port}`;
const expected = readFileSync(resolve(root, "backend/openapi/openapi.yaml"), "utf8");

const child = spawn("cargo", ["run", "-p", "mnt-app", "--quiet"], {
  cwd: backendDir,
  env: {
    ...process.env,
    MNT_HTTP_ADDR: `127.0.0.1:${port}`,
    MNT_APP_ROLE: "api",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

// Drain BOTH stdout and stderr. Leaving the stdout pipe unread lets a chatty
// boot (or a cold `cargo run` recompile) fill the OS pipe buffer and block the
// app's write() before it ever serves /healthz — indistinguishable from a
// readiness timeout. Echo live so CI logs show exactly what the app did.
let appOutput = "";
const capture = (chunk) => {
  const text = chunk.toString();
  appOutput += text;
  process.stderr.write(text);
};
child.stdout.on("data", capture);
child.stderr.on("data", capture);

try {
  await waitForApp(baseUrl);
  const response = await fetch(`${baseUrl}/openapi/openapi.yaml`);
  if (!response.ok) {
    throw new Error(`GET /openapi/openapi.yaml returned ${response.status}`);
  }
  const actual = await response.text();
  if (actual !== expected) {
    throw new Error("App-served OpenAPI YAML differs from backend/openapi/openapi.yaml");
  }
} finally {
  child.kill("SIGTERM");
}

async function waitForApp(url) {
  // Generous: absorbs a cold `cargo run` compile on a cache-miss runner plus
  // boot. The early-exit check below fails fast if the app actually crashes.
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`mnt-app exited early with ${child.exitCode}\n${appOutput}`);
    }
    try {
      const response = await fetch(`${url}/healthz`);
      if (response.ok) {
        return;
      }
    } catch {
      // App is still starting.
    }
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 500));
  }
  throw new Error(`Timed out waiting for mnt-app\n${appOutput}`);
}
