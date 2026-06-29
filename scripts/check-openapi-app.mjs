import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createServer } from "node:net";

const root = resolve(new URL("..", import.meta.url).pathname);
const backendDir = resolve(root, "backend");
const port = process.env.OPENAPI_DRIFT_PORT
  ? Number(process.env.OPENAPI_DRIFT_PORT)
  : await findOpenPort();
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error(`Invalid OPENAPI_DRIFT_PORT: ${process.env.OPENAPI_DRIFT_PORT}`);
}
const baseUrl = `http://127.0.0.1:${port}`;
const expected = readFileSync(resolve(root, "backend/openapi/openapi.yaml"), "utf8");

await runCommand("cargo", ["build", "-p", "mnt-app"], {
  cwd: backendDir,
  env: process.env,
  label: "cargo build -p mnt-app",
});

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

async function runCommand(command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const capture = (chunk) => {
    const text = chunk.toString();
    output += text;
    process.stderr.write(text);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const code = await new Promise((resolveCode, reject) => {
    child.on("error", reject);
    child.on("close", resolveCode);
  });
  if (code !== 0) {
    throw new Error(`${options.label} exited with ${code}\n${output}`);
  }
}

async function findOpenPort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const portNumber = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolvePort(portNumber);
        }
      });
    });
  });
}
