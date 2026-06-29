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

const args = [
  "test",
  "-p",
  "mnt-registry-rest",
  "--test",
  "equipment_admin",
  "ownership_transfer_requires_ordered_legal_and_accounting_signoff",
  "--",
  "--nocapture",
];

const child = spawn("cargo", args, {
  cwd: backendDir,
  env,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

const code = await new Promise((resolveCode) => child.on("close", resolveCode));
process.exit(code ?? 1);
