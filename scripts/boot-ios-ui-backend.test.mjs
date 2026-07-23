import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { buildIosBackendLaunch } from "./boot-ios-ui-backend.mjs";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "boot-ios-ui-backend.mjs");
const otp = "a".repeat(64);

describe("iOS UI backend launcher", () => {
  it("builds an exact loopback environment without forwarding the wrapper secret name", () => {
    const { executable, env } = buildIosBackendLaunch({
      root: "/repo",
      authDir: "/auth",
      port: "49183",
      coldstartOtp: otp,
      baseEnv: { MNT_IOS_COLDSTART_OTP: otp, E2E_RP_ID: "stale.example", KEEP: "yes" },
    });
    assert.equal(executable, "/repo/e2e/harness/boot-backend.sh");
    assert.equal(env.KEEP, "yes");
    assert.equal(env.MNT_IOS_COLDSTART_OTP, undefined);
    assert.deepEqual(
      Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith("E2E_"))),
      {
        E2E_AUTH_DIR: "/auth",
        E2E_HTTP_ADDR: "127.0.0.1:49183",
        E2E_PORT_CONFLICT_MODE: "fail",
        E2E_COLDSTART_OTP: otp,
        E2E_RP_ORIGIN: "http://localhost:49183",
        E2E_RP_ID: "localhost",
      },
    );
  });

  it("rejects ambiguous paths, ports, and bootstrap credentials", () => {
    const valid = { root: "/repo", authDir: "/auth", port: "49183", coldstartOtp: otp };
    assert.throws(() => buildIosBackendLaunch({ ...valid, root: "repo" }), /absolute path/);
    assert.throws(() => buildIosBackendLaunch({ ...valid, authDir: "auth" }), /absolute path/);
    for (const port of ["0", "01", "65536", "49183x"]) assert.throws(() => buildIosBackendLaunch({ ...valid, port }), /port/);
    for (const coldstartOtp of ["", "a".repeat(63), "A".repeat(64), "g".repeat(64)]) assert.throws(() => buildIosBackendLaunch({ ...valid, coldstartOtp }), /32-byte lowercase hex/);
  });

  it("executes the owned backend script with no credential argument and exact environment", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "mnt-ios-backend-launcher-"));
    try {
      const root = join(sandbox, "repo");
      const authDir = join(sandbox, "auth");
      const backend = join(root, "e2e/harness/boot-backend.sh");
      const capture = join(sandbox, "capture");
      mkdirSync(dirname(backend), { recursive: true });
      mkdirSync(authDir);
      writeFileSync(backend, `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' "$#" "$E2E_AUTH_DIR" "$E2E_HTTP_ADDR" "$E2E_PORT_CONFLICT_MODE" "$E2E_COLDSTART_OTP" "$E2E_RP_ORIGIN" "$E2E_RP_ID" "\${MNT_IOS_COLDSTART_OTP-unset}" > "$CAPTURE_FILE"\n`);
      chmodSync(backend, 0o700);
      execFileSync(process.execPath, [script, root, authDir, "49183"], {
        env: { ...process.env, CAPTURE_FILE: capture, MNT_IOS_COLDSTART_OTP: otp },
      });
      assert.deepEqual(readFileSync(capture, "utf8").trimEnd().split("\n"), [
        "0",
        authDir,
        "127.0.0.1:49183",
        "fail",
        otp,
        "http://localhost:49183",
        "localhost",
        "unset",
      ]);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("propagates the owned backend script exit status", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "mnt-ios-backend-launcher-exit-"));
    try {
      const root = join(sandbox, "repo");
      const authDir = join(sandbox, "auth");
      const backend = join(root, "e2e/harness/boot-backend.sh");
      mkdirSync(dirname(backend), { recursive: true });
      mkdirSync(authDir);
      writeFileSync(backend, "#!/usr/bin/env bash\nexit 23\n");
      chmodSync(backend, 0o700);
      const result = spawnSync(process.execPath, [script, root, authDir, "49183"], {
        env: { ...process.env, MNT_IOS_COLDSTART_OTP: otp },
      });
      assert.equal(result.status, 23);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
