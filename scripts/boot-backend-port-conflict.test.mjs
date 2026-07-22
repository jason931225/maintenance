import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const bootBackend = path.join(repositoryRoot, "e2e/harness/boot-backend.sh");

async function startLoopbackListener() {
  const listener = spawn("python3", ["-u", "-c", String.raw`
import signal
import socket
import sys
import time

server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", 0))
server.listen()
print(server.getsockname()[1], flush=True)
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
while True:
    time.sleep(1)
`]);
  const [output] = await once(listener.stdout, "data");
  return { listener, port: Number(output.toString().trim()) };
}

async function createMarkerApp(directory, marker) {
  const app = path.join(directory, "mnt-app-marker");
  await writeFile(app, `#!/usr/bin/env sh\ntouch "${marker}"\n`, "utf8");
  await chmod(app, 0o700);
  return app;
}

async function reserveThenReleaseLoopbackPort() {
  const probe = spawnSync("python3", ["-c", String.raw`
import socket
server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.bind(("127.0.0.1", 0))
print(server.getsockname()[1])
`], { encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  return Number(probe.stdout.trim());
}

function boot(env) {
  return spawnSync("bash", [bootBackend], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 10_000,
  });
}

test("fail conflict mode refuses an already-owned loopback port without killing its listener", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "maintenance-boot-backend-"));
  const marker = path.join(directory, "backend-started");
  const { listener, port } = await startLoopbackListener();
  t.after(async () => {
    listener.kill("SIGTERM");
    await once(listener, "exit");
    await rm(directory, { recursive: true, force: true });
  });

  const result = boot({
    E2E_AUTH_DIR: path.join(directory, "auth"),
    E2E_HTTP_ADDR: `127.0.0.1:${port}`,
    E2E_PORT_CONFLICT_MODE: "fail",
    MNT_APP_BIN: await createMarkerApp(directory, marker),
  });

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, new RegExp(`port ${port} is already in use`));
  assert.equal(listener.exitCode, null, "the unrelated listener must remain alive");
  assert.equal(spawnSync("test", ["-e", marker]).status, 1, "backend startup must not run");
});

test("unknown port conflict modes fail before backend startup", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "maintenance-boot-backend-"));
  const marker = path.join(directory, "backend-started");
  t.after(() => rm(directory, { recursive: true, force: true }));

  const result = boot({
    E2E_AUTH_DIR: path.join(directory, "auth"),
    E2E_HTTP_ADDR: `127.0.0.1:${await reserveThenReleaseLoopbackPort()}`,
    E2E_PORT_CONFLICT_MODE: "unexpected",
    MNT_APP_BIN: await createMarkerApp(directory, marker),
  });

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /unknown E2E_PORT_CONFLICT_MODE "unexpected"/);
  assert.equal(spawnSync("test", ["-e", marker]).status, 1, "backend startup must not run");
});
