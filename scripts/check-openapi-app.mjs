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

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

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
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`mnt-app exited early with ${child.exitCode}\n${stderr}`);
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
  throw new Error(`Timed out waiting for mnt-app\n${stderr}`);
}
