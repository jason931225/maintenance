import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile, chmod, readFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const bootBackend = path.join(repositoryRoot, "e2e/harness/boot-backend.sh");

async function startLoopbackListener({ reuseAddress = true } = {}) {
  const listener = spawn("python3", ["-u", "-c", String.raw`
import signal
import socket
import sys
import time

server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
if ${reuseAddress ? "True" : "False"}:
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

async function createReadyMarkerApp(directory) {
  const app = path.join(directory, "mnt-app-ready-marker");
  await writeFile(app, `#!/usr/bin/env sh
touch "\${MNT_MARKER:?MNT_MARKER must be set}"
exec python3 -u -c '
import os
import socket

host, _, port = os.environ["MNT_HTTP_ADDR"].rpartition(":")
server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind((host, int(port)))
server.listen()
while True:
    connection, _ = server.accept()
    with connection:
        connection.recv(4096)
        connection.sendall(b"HTTP/1.1 200 OK\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n")
'
`, "utf8");
  await chmod(app, 0o700);
  return app;
}

async function createLsofStub(directory, stalePid, port) {
  const app = path.join(directory, "lsof");
  await writeFile(app, `#!/usr/bin/env sh
[ "$1" = "-ti" ] && [ "$2" = "-nP" ] && [ "$3" = "-iTCP:${port}" ] && [ "$4" = "-sTCP:LISTEN" ] || exit 64
printf '%s\\n' '${stalePid}'
`, "utf8");
  await chmod(app, 0o700);
  return path.dirname(app);
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

function portIsAvailable(port) {
  return spawnSync("python3", ["-c", String.raw`
import socket

server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", ${port}))
server.close()
`], { encoding: "utf8" });
}

async function waitForExit(child, timeoutMs = 2_000) {
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`process ${child.pid} did not exit within ${timeoutMs}ms`));
      }, timeoutMs);
      once(child, "exit").then(() => {
        clearTimeout(timeout);
        resolve();
      }, reject);
    });
  }
}

function terminate(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
}

async function readBackendPid(directory) {
  const pid = Number((await readFile(path.join(directory, "auth", "backend.pid"), "utf8")).trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "boot must record the marker app PID");
  return pid;
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

test("reclaim conflict mode kills a stale loopback listener and boots the marker app", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "maintenance-boot-backend-"));
  const marker = path.join(directory, "backend-started");
  const { listener, port } = await startLoopbackListener({ reuseAddress: false });
  const lsofDirectory = await createLsofStub(directory, listener.pid, port);
  let backendPid;
  t.after(async () => {
    if (!backendPid) {
      backendPid = await readBackendPid(directory).catch(() => undefined);
    }
    if (backendPid) {
      terminate(backendPid);
    }
    if (listener.exitCode === null && listener.signalCode === null) {
      listener.kill("SIGTERM");
    }
    await Promise.all([waitForExit(listener), rm(directory, { recursive: true, force: true })]);
  });

  const result = boot({
    E2E_AUTH_DIR: path.join(directory, "auth"),
    E2E_HTTP_ADDR: `127.0.0.1:${port}`,
    E2E_PORT_CONFLICT_MODE: "reclaim",
    MNT_APP_BIN: await createReadyMarkerApp(directory),
    MNT_MARKER: marker,
    PATH: `${lsofDirectory}:${process.env.PATH}`,
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, new RegExp(`freeing port ${port}`));
  await waitForExit(listener);
  assert.notEqual(listener.signalCode, null, "reclaim must terminate the stale listener");
  assert.equal(spawnSync("test", ["-e", marker]).status, 0, "marker app must have started");

  backendPid = await readBackendPid(directory);
  terminate(backendPid);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const availability = portIsAvailable(port);
    if (availability.status === 0) {
      backendPid = undefined;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(portIsAvailable(port).status, 0, "port must be available after marker app shutdown");
});
