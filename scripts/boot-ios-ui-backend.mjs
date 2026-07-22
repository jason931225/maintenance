#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function requiredAbsolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  return value;
}

function requiredPort(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,4}$/.test(value)) throw new Error("backend port must be a canonical decimal port");
  const port = Number(value);
  if (port > 65_535) throw new Error("backend port must be at most 65535");
  return value;
}

function requiredColdstartOtp(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error("MNT_IOS_COLDSTART_OTP must be a 32-byte lowercase hex value");
  return value;
}

export function buildIosBackendLaunch({ root, authDir, port, coldstartOtp, baseEnv = {} }) {
  const checkedRoot = requiredAbsolutePath(root, "repository root");
  const checkedAuthDir = requiredAbsolutePath(authDir, "authentication directory");
  const checkedPort = requiredPort(port);
  const checkedOtp = requiredColdstartOtp(coldstartOtp);
  const executable = resolve(checkedRoot, "e2e/harness/boot-backend.sh");
  const env = { ...baseEnv };
  delete env.MNT_IOS_COLDSTART_OTP;
  Object.assign(env, {
    E2E_AUTH_DIR: checkedAuthDir,
    E2E_HTTP_ADDR: `127.0.0.1:${checkedPort}`,
    E2E_PORT_CONFLICT_MODE: "fail",
    E2E_COLDSTART_OTP: checkedOtp,
    E2E_RP_ORIGIN: `http://localhost:${checkedPort}`,
    E2E_RP_ID: "localhost",
  });
  return { executable, env };
}

export function runIosBackend(argv = process.argv.slice(2), environment = process.env) {
  if (argv.length !== 3) throw new Error("usage: boot-ios-ui-backend.mjs <repository-root> <auth-directory> <backend-port>");
  const { executable, env } = buildIosBackendLaunch({
    root: argv[0],
    authDir: argv[1],
    port: argv[2],
    coldstartOtp: environment.MNT_IOS_COLDSTART_OTP,
    baseEnv: environment,
  });
  accessSync(executable, constants.X_OK);
  const result = spawnSync(executable, [], { env, shell: false, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`backend launcher terminated by ${result.signal}`);
  return result.status ?? 1;
}

function main() {
  try {
    process.exitCode = runIosBackend();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`boot-ios-ui-backend: ${message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
