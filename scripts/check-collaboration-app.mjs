import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const backendDir = resolve(root, "backend");

const env = {
  ...process.env,
  CARGO_INCREMENTAL: process.env.CARGO_INCREMENTAL ?? "0",
  CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "1",
  SQLX_OFFLINE: process.env.SQLX_OFFLINE ?? "true",
};

await runCargoTest([
  "test",
  "-p",
  "mnt-app",
  "--lib",
  "collaboration::tests::",
  "--",
  "--nocapture",
]);
await runCargoTest([
  "test",
  "-p",
  "mnt-app",
  "--test",
  "openapi_drift",
  "openapi_yaml_covers_mounted_auth_routes",
  "--",
  "--nocapture",
]);

async function runCargoTest(args) {
  const code = await spawnChecked("cargo", args, {
    cwd: backendDir,
    env,
  });
  if (code !== 0) {
    process.exit(code ?? 1);
  }
}

async function spawnChecked(command, args, options) {
  const child = spawn(command, args, {
    ...options,
    stdio: "inherit",
  });
  child.on("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  return await new Promise((resolveCode) => child.on("close", resolveCode));
}
