import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const backendDir = resolve(root, "backend");
const targetDir = process.env.CARGO_TARGET_DIR ?? resolve(root, ".tmp/cargo-target-g015");

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required for the dispatch-map geofence arrival integration test",
  );
}

const cargoEnv = {
  ...process.env,
  CARGO_INCREMENTAL: process.env.CARGO_INCREMENTAL ?? "0",
  CARGO_TARGET_DIR: targetDir,
  SQLX_OFFLINE: process.env.SQLX_OFFLINE ?? "true",
};

await runCommand(
  "cargo",
  [
    "clippy",
    "-p",
    "mnt-compliance-adapter-postgres",
    "--all-targets",
    "--",
    "-D",
    "warnings",
  ],
  {
    cwd: backendDir,
    env: cargoEnv,
    label:
      "cargo clippy -p mnt-compliance-adapter-postgres --all-targets -- -D warnings",
  },
);

await runCommand(
  "cargo",
  [
    "test",
    "-p",
    "mnt-compliance-adapter-postgres",
    "--test",
    "location_store",
    "geofence_arrival_departure_is_audited_and_survives_withdrawal",
    "--",
    "--exact",
  ],
  {
    cwd: backendDir,
    env: cargoEnv,
    label:
      "cargo test -p mnt-compliance-adapter-postgres --test location_store geofence_arrival_departure_is_audited_and_survives_withdrawal -- --exact",
  },
);

await runCommand(
  "npm",
  [
    "--workspace",
    "web",
    "run",
    "test",
    "--",
    "src/pages/DispatchMapPage.test.tsx",
    "src/features/location/location-consent-state.test.ts",
    "--run",
  ],
  {
    cwd: root,
    env: process.env,
    label:
      "npm --workspace web run test -- src/pages/DispatchMapPage.test.tsx src/features/location/location-consent-state.test.ts --run",
  },
);

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
