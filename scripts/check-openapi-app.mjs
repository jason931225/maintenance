import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import { checkPlatformContractDrift } from "./check-platform-contract-drift.mjs";
import {
  observeChild,
  stopChild,
  waitForChildReady,
} from "./lib/app-process.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const appBinary = resolve(root, ".tmp/buck2/api-contract/mnt-app");
const port = process.env.OPENAPI_DRIFT_PORT
  ? Number(process.env.OPENAPI_DRIFT_PORT)
  : await findOpenPort();
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error(`Invalid OPENAPI_DRIFT_PORT: ${process.env.OPENAPI_DRIFT_PORT}`);
}
const baseUrl = `http://127.0.0.1:${port}`;
const expected = readFileSync(resolve(root, "backend/openapi/openapi.yaml"), "utf8");
const { backendOperations } = checkPlatformContractDrift();
console.error(
  `Platform contract drift gate covered ${backendOperations.size} backend operations.`,
);

await runCommand("tools/buck2", [
  "build",
  "--out",
  ".tmp/buck2/api-contract/mnt-app",
  "//backend/app:mnt-app",
], {
  cwd: root,
  label: "Buck2 build //backend/app:mnt-app",
});

const observed = observeChild(spawn(appBinary, [], {
  cwd: root,
  env: {
    MNT_HTTP_ADDR: `127.0.0.1:${port}`,
    MNT_APP_ROLE: "api",
  },
  stdio: ["ignore", "pipe", "pipe"],
}));
const { child } = observed;

// Drain both streams so a chatty boot cannot fill an OS pipe buffer before the
// app serves /healthz. Echo live so CI logs show exactly what the app did.
let appOutput = "";
const capture = (chunk) => {
  const text = chunk.toString();
  appOutput += text;
  process.stderr.write(text);
};
child.stdout.on("data", capture);
child.stderr.on("data", capture);

try {
  await waitForChildReady({
    observed,
    checkReady: async ({ signal }) =>
      (await fetch(`${baseUrl}/healthz`, { signal })).ok,
    getOutput: () => appOutput,
  });
  const response = await fetch(`${baseUrl}/openapi/openapi.yaml`);
  if (!response.ok) {
    throw new Error(`GET /openapi/openapi.yaml returned ${response.status}`);
  }
  const actual = await response.text();
  if (actual !== expected) {
    throw new Error("App-served OpenAPI YAML differs from backend/openapi/openapi.yaml");
  }
} finally {
  await stopChild(child);
}

async function runCommand(command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
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
