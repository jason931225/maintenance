#!/usr/bin/env node
// Local full-stack dev environment orchestrator. Node-only (no bashisms) so it
// runs the same on macOS/Linux/Windows.
//
// Reuses ops/compose.yml (pinned Postgres, SeaweedFS per ADR-0005) + the dev
// wiring in ops/compose.dev.yml via `-f` layering; ops/compose.dev-deps.yml
// adds only what those two files don't have yet (Mailpit, a published OTEL
// port, and the dev-only WAL archive retention helper). The one thing this
// script changes vs. ops/dev-up.sh: mnt-app runs ON
// THE HOST under bacon/cargo instead of in a container, so every docker-network
// hostname (postgres, seaweedfs, otel-collector) has to be rewritten to a
// published localhost port — that relocation is `buildAppEnv()` below.
//
// Subcommands:
//   doctor     per-OS environment checks with remediation; --cached replays
//              the last result instead of re-probing (fast path for hooks).
//   up         deps -> migrate -> bacon (backend) + vite (web), foreground,
//              live-reloading. Ctrl+C stops bacon/vite; deps stay up for a
//              fast restart. Run `down` separately to stop the deps.
//   bootstrap  deps -> migrate -> mnt-app in the background -> /readyz probe,
//              then exits. No watch loop — this is what CI's smoke job runs.
//   down       stops whatever `up`/`bootstrap` started (host process(es) via
//              the pid file, then the compose deps).
//
// Env flags:
//   MNT_DEV_OFFICE=1  also start the ONLYOFFICE DocumentServer dep (in-console
//                      office editor). Off by default — the image is ~2GB and
//                      most dev-up sessions never touch the office editor; the
//                      backend's office routes gracefully 503 without it.
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const BACKEND_DIR = path.join(REPO_ROOT, "backend");
const SECRETS_DIR = path.join(REPO_ROOT, "ops", ".dev-secrets");
const STATE_DIR = path.join(REPO_ROOT, ".omc", "state", "dev-up");
const PID_FILE = path.join(STATE_DIR, "pids.json");
const DOCTOR_CACHE_FILE = path.join(STATE_DIR, "doctor.json");

const COMPOSE_PROJECT = "mnt-dev";
const COMPOSE_FILES = [
  "ops/compose.yml",
  "ops/compose.dev.yml",
  "ops/compose.dev-deps.yml",
];
// Opt-in: the ONLYOFFICE DocumentServer image is ~2GB, so it stays out of the
// routine dev-up path unless explicitly requested.
const OFFICE_ENABLED = process.env.MNT_DEV_OFFICE === "1";
const DEPS_SERVICES = [
  "postgres",
  "postgres-wal-archive-pruner",
  "seaweedfs",
  "otel-collector",
  "mailpit",
  "mox",
  ...(OFFICE_ENABLED ? ["onlyoffice"] : []),
];

// Shared HS256 secret between the host and the DocumentServer container. Dev
// only; production injects a real per-deploy secret (docs/release/SECRETS.md).
const OFFICE_JWT_SECRET =
  process.env.MNT_OFFICE_JWT_SECRET ?? "office-dev-shared-secret";

// Deliberately NOT the compose files' own defaults (5432/8333/8080): a local
// dev tool cannot assume it owns the only Postgres/S3/8080 on the machine.
// ponytail: fixed port block rather than auto-picking free ports — simpler,
// and `doctor`'s port-free check gives an actionable override path already.
const PORTS = {
  postgres: Number(process.env.MNT_POSTGRES_PORT ?? 55432),
  s3: Number(process.env.MNT_S3_PORT ?? 58333),
  otel: Number(process.env.MNT_OTEL_PORT ?? 54317),
  mailpitSmtp: Number(process.env.MNT_MAILPIT_SMTP_PORT ?? 1025),
  mailpitUi: Number(process.env.MNT_MAILPIT_UI_PORT ?? 8025),
  moxWebapi: Number(process.env.MNT_MOX_WEBAPI_PORT ?? 1080),
  moxSubmission: Number(process.env.MNT_MOX_SUBMISSION_PORT ?? 1587),
  moxImap: Number(process.env.MNT_MOX_IMAP_PORT ?? 1143),
  office: Number(process.env.MNT_OFFICE_DOCSERVER_PORT ?? 8888),
  backend: Number(process.env.MNT_DEV_HTTP_PORT ?? 8090),
  vite: Number(process.env.E2E_WEB_PORT ?? process.env.MNT_DEV_VITE_PORT ?? 5173),
};

const POSTGRES_DB = process.env.MNT_POSTGRES_DB ?? "mnt_dev";
const POSTGRES_USER = process.env.MNT_POSTGRES_USER ?? "mnt_app";
const POSTGRES_PASSWORD =
  process.env.MNT_POSTGRES_PASSWORD ?? "mnt-dev-local-change-me";

function log(msg) {
  console.log(`dev-up: ${msg}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function platformRemediation() {
  const plat = os.platform();
  if (plat === "darwin") {
    return "Install Docker Desktop (docker.com/products/docker-desktop), or `brew install colima docker docker-compose` then `colima start`.";
  }
  if (plat === "win32") {
    return "Install Docker Desktop with the WSL2 backend (docker.com/products/docker-desktop), or Podman Desktop as a fallback.";
  }
  return "Install Docker Engine (docs.docker.com/engine/install) or Podman + podman-compose.";
}

// `docker compose` (CLI plugin) is the modern form, but plenty of installs
// (this repo's own ops/dev-up.sh included) only have the standalone
// `docker-compose` binary — try both, then podman.
const COMPOSE_CANDIDATES = [
  { bin: "docker", prefix: ["compose"] },
  { bin: "docker-compose", prefix: [] },
  { bin: "podman", prefix: ["compose"] },
];

function detectCompose() {
  for (const candidate of COMPOSE_CANDIDATES) {
    const check = spawnSync(candidate.bin, [...candidate.prefix, "version"], {
      stdio: "ignore",
    });
    if (!check.error && check.status === 0) return candidate;
  }
  return null;
}

function composeArgs(compose, args) {
  const fileArgs = COMPOSE_FILES.flatMap((f) => ["-f", f]);
  return [...compose.prefix, "-p", COMPOSE_PROJECT, ...fileArgs, ...args];
}

function runCompose(compose, args, opts) {
  return spawnSync(compose.bin, composeArgs(compose, args), opts);
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

// Without this, a stale process already holding PORTS.backend makes /readyz
// probe THAT process (not the one we're about to spawn) and report a false
// green.
async function assertPortFree(port, label) {
  if (!(await portFree(port))) {
    throw new Error(
      `port ${port} (${label}) is already in use — a stale server may be holding it. ` +
        `Find it with \`lsof -i :${port}\` (macOS/Linux) and stop it, or override the port env var before running \`up\`/\`bootstrap\`.`,
    );
  }
}

// `detached: true` makes the child the leader of its own process group,
// so a plain SIGTERM to its pid can leave grandchildren (mnt-app/vite)
// orphaned. Signalling the group reaches the whole background stack.
function stopBackendProcess(proc) {
  if (!proc?.pid) return;
  try {
    if (proc.group || proc.mode === "cargo" || proc.mode === "npm") {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/T", "/F", "/PID", String(proc.pid)]);
      } else {
        process.kill(-proc.pid, "SIGTERM");
      }
    } else {
      process.kill(proc.pid, "SIGTERM");
    }
    log(`stopped pid ${proc.pid}`);
  } catch {
    // already gone
  }
}

function waitForHttp(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 400) {
          resolve();
        } else {
          retry();
        }
      });
      req.on("error", retry);
      req.setTimeout(2000, () => req.destroy());
    };
    const retry = () => {
      if (Date.now() > deadline) {
        reject(new Error(`timed out waiting for ${url}`));
        return;
      }
      setTimeout(attempt, 500);
    };
    attempt();
  });
}

function ensureBucket(port, bucket) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: `/${bucket}`, method: "PUT" },
      (res) => {
        res.resume();
        // 409 = already exists (the deps volume persists across `up` runs
        // unless `down` is given --volumes), which is the common case, not
        // an error.
        if ((res.statusCode && res.statusCode < 400) || res.statusCode === 409) {
          resolve();
        } else {
          reject(
            new Error(`bucket create ${bucket} failed: HTTP ${res.statusCode}`),
          );
        }
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// docker-compose (standalone) delegates to the `docker` daemon, so `inspect`
// always runs against the plain runtime binary, never the `-compose` suffix.
function runtimeBin(compose) {
  return compose.bin === "docker-compose" ? "docker" : compose.bin;
}

function composeServiceIds(compose, services, env) {
  const ps = runCompose(compose, ["ps", "-q", ...services], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
  });
  if (ps.status !== 0) throw new Error("docker compose ps (deps) failed");
  return ps.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function waitForContainersHealthy(compose, services, timeoutMs, env) {
  const bin = runtimeBin(compose);
  const deadline = Date.now() + timeoutMs;
  let pending = new Set();
  while (pending.size < services.length) {
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for compose containers: ${services.join(", ")}`,
      );
    }
    pending = new Set(composeServiceIds(compose, services, env));
    if (pending.size < services.length) await sleep(1000);
  }
  while (pending.size > 0) {
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for containers healthy: ${[...pending].join(", ")}`,
      );
    }
    for (const name of [...pending]) {
      const inspect = spawnSync(
        bin,
        ["inspect", "--format", "{{.State.Health.Status}}", name],
        { encoding: "utf8" },
      );
      const status = inspect.stdout?.trim();
      if (status === "healthy") {
        pending.delete(name);
      } else if (status === "unhealthy") {
        throw new Error(`container ${name} is unhealthy`);
      }
    }
    if (pending.size > 0) await sleep(1000);
  }
}

function ensureDevKeys() {
  mkdirSync(SECRETS_DIR, { recursive: true });
  const privPath = path.join(SECRETS_DIR, "jwt-private.pem");
  const pubPath = path.join(SECRETS_DIR, "jwt-public.pem");
  if (existsSync(privPath) && existsSync(pubPath)) {
    return {
      privateKeyPem: readFileSync(privPath, "utf8"),
      publicKeyPem: readFileSync(pubPath, "utf8"),
    };
  }
  // Windows-portable replacement for ops/dev-up.sh's `openssl genpkey`/`pkey`
  // calls (openssl is commonly absent on Windows). Same PKCS#8/SPKI PEM shapes
  // the backend's JWT verifier expects (see e2e/harness/gen-keys.sh).
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  writeFileSync(privPath, privateKey, { mode: 0o600 });
  writeFileSync(pubPath, publicKey, { mode: 0o600 });
  log(`generated dev ES256 keypair under ${path.relative(REPO_ROOT, SECRETS_DIR)}/`);
  return { privateKeyPem: privateKey, publicKeyPem: publicKey };
}

function readPinnedRustVersion() {
  try {
    const content = readFileSync(
      path.join(BACKEND_DIR, "rust-toolchain.toml"),
      "utf8",
    );
    return content.match(/channel\s*=\s*"([^"]+)"/)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function runDoctorChecks() {
  const checks = [];

  const compose = detectCompose();
  checks.push({
    name: "Container runtime (docker/podman)",
    ok: Boolean(compose),
    detail: compose
      ? `\`${[compose.bin, ...compose.prefix].join(" ")}\` reachable`
      : "none of `docker compose`, `docker-compose`, `podman compose` responded",
    remediation: compose ? null : platformRemediation(),
  });

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const nodeOk = nodeMajor >= 22;
  checks.push({
    name: "Node.js",
    ok: nodeOk,
    detail: `v${process.versions.node} (>=22 required, package.json engines)`,
    remediation: nodeOk ? null : "Install Node >=22 (nvm install 22, or nodejs.org).",
  });

  const cargoCheck = spawnSync("cargo", ["--version"], { encoding: "utf8" });
  const cargoOk = !cargoCheck.error && cargoCheck.status === 0;
  const pinned = readPinnedRustVersion();
  checks.push({
    name: "cargo",
    ok: cargoOk,
    detail: cargoOk ? cargoCheck.stdout.trim() : "not found on PATH",
    remediation: cargoOk
      ? null
      : "Install Rust via rustup.rs (backend/rust-toolchain.toml pins the exact version automatically).",
  });
  if (cargoOk && pinned) {
    checks.push({
      name: "cargo toolchain pin",
      ok: true,
      detail: `backend/rust-toolchain.toml pins ${pinned}; rustup selects it automatically inside backend/`,
      remediation: null,
    });
  }

  const npmInstalled = existsSync(path.join(REPO_ROOT, "node_modules", ".bin", "vite"));
  checks.push({
    name: "npm workspace dependencies",
    ok: npmInstalled,
    detail: npmInstalled ? "node_modules/.bin/vite present" : "not installed",
    remediation: npmInstalled ? null : "Run `npm install` at the repo root (fresh clone/worktree).",
  });

  const baconCheck = spawnSync("bacon", ["--version"], { encoding: "utf8" });
  const baconOk = !baconCheck.error && baconCheck.status === 0;
  checks.push({
    name: "bacon",
    ok: baconOk,
    detail: baconOk ? baconCheck.stdout.trim() : "not found on PATH",
    remediation: baconOk
      ? null
      : "cargo install bacon --locked  (macOS: brew install bacon)",
  });

  for (const [label, port] of Object.entries(PORTS)) {
    const free = await portFree(port);
    checks.push({
      name: `Port ${port} (${label})`,
      ok: free,
      detail: free ? "free" : "in use",
      remediation: free
        ? null
        : `Something is already listening on ${port}. Stop it, or override the matching env var (see scripts/dev-up.mjs PORTS) before running \`up\`/\`bootstrap\`.`,
    });
  }

  return {
    platform: `${os.platform()} ${os.release()} (${os.arch()})`,
    timestamp: new Date().toISOString(),
    checks,
  };
}

function formatDoctorReport(result) {
  const lines = [
    `dev-up doctor — ${result.platform} — ${result.timestamp}`,
  ];
  for (const c of result.checks) {
    lines.push(`  [${c.ok ? "OK" : "FAIL"}] ${c.name}: ${c.detail}`);
    if (!c.ok && c.remediation) lines.push(`         -> ${c.remediation}`);
  }
  const failing = result.checks.filter((c) => !c.ok);
  if (failing.length > 0) {
    lines.push("");
    lines.push("=== IT handoff ===");
    lines.push("Share this block with IT/local admin if you cannot resolve it yourself:");
    for (const c of failing) {
      lines.push(`- ${c.name}: ${c.remediation ?? "see full doctor output above"}`);
    }
  }
  return lines.join("\n");
}

async function cmdDoctor(args) {
  mkdirSync(STATE_DIR, { recursive: true });
  if (args.includes("--cached")) {
    if (!existsSync(DOCTOR_CACHE_FILE)) {
      console.error("dev-up: no cached doctor result yet; run `dev-up.mjs doctor` first.");
      process.exitCode = 1;
      return;
    }
    console.log(formatDoctorReport(JSON.parse(readFileSync(DOCTOR_CACHE_FILE, "utf8"))));
    return;
  }
  const result = await runDoctorChecks();
  writeFileSync(DOCTOR_CACHE_FILE, JSON.stringify(result, null, 2));
  console.log(formatDoctorReport(result));
  process.exitCode = result.checks.some((c) => !c.ok) ? 1 : 0;
}

async function bringUpDeps() {
  const compose = detectCompose();
  if (!compose) {
    throw new Error(`no container runtime found. ${platformRemediation()}`);
  }

  const composeEnv = {
    ...process.env,
    MNT_POSTGRES_PORT: String(PORTS.postgres),
    MNT_POSTGRES_DB: POSTGRES_DB,
    MNT_POSTGRES_USER: POSTGRES_USER,
    MNT_POSTGRES_PASSWORD: POSTGRES_PASSWORD,
    MNT_S3_PORT: String(PORTS.s3),
    MNT_OTEL_PORT: String(PORTS.otel),
    MNT_MAILPIT_SMTP_PORT: String(PORTS.mailpitSmtp),
    MNT_MAILPIT_UI_PORT: String(PORTS.mailpitUi),
    MNT_OFFICE_DOCSERVER_PORT: String(PORTS.office),
    MNT_OFFICE_JWT_SECRET: OFFICE_JWT_SECRET,
  };

  if (!OFFICE_ENABLED) {
    log(
      "office editor (ONLYOFFICE DocumentServer, ~2GB) is disabled — set MNT_DEV_OFFICE=1 to enable",
    );
  }

  const up = runCompose(compose, ["up", "-d", ...DEPS_SERVICES], {
    cwd: REPO_ROOT,
    env: composeEnv,
    stdio: "inherit",
  });
  if (up.status !== 0) throw new Error("docker compose up (deps) failed");

  log("waiting for deps to report healthy...");
  await waitForContainersHealthy(compose, DEPS_SERVICES, 180_000, composeEnv);

  log("ensuring SeaweedFS evidence buckets exist...");
  await ensureBucket(PORTS.s3, "mnt-evidence");
  await ensureBucket(PORTS.s3, "mnt-evidence-replica");

  return compose;
}

function databaseUrl() {
  return `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${PORTS.postgres}/${POSTGRES_DB}`;
}

// Each of `runMigrations`, `buildAppEnv`, and backend/bacon.toml's
// `env.SQLX_OFFLINE` sets SQLX_OFFLINE=true independently — they're three
// separate `cargo`/`bacon` invocations (migrate role, api role, bacon's own
// jobs) that don't share a process, so the flag can't be set once and
// inherited.
//
// Feature split (W3, not wired here yet — dev-auth doesn't exist on this
// branch): once available, `up`'s bacon-managed api role is meant to build
// with `--features dev-auth` for the interactive role-switcher, while
// `bootstrap` (and this CI smoke job) stays on the default feature set —
// the same build the release image ships, so the dev-auth absence gate is
// exercised by the thing that actually runs in CI, not a special case.
function runMigrations() {
  log("running migrations (MNT_APP_ROLE=migrate cargo run -p mnt-app)...");
  const env = {
    ...process.env,
    MNT_APP_ROLE: "migrate",
    DATABASE_URL: databaseUrl(),
    SQLX_OFFLINE: "true",
  };
  const result = spawnSync("cargo", ["run", "-q", "-p", "mnt-app"], {
    cwd: BACKEND_DIR,
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error("migration run failed (MNT_APP_ROLE=migrate)");
}

// Load the KNL tenant dev fixtures (scripts/dev-seed.sql) so every console
// screen shows real org-scoped rows instead of 0-counts. Idempotent
// (ON CONFLICT DO NOTHING) — safe to run on every up/bootstrap. Piped into the
// compose Postgres service's own psql, so no host psql is required.
function runSeed(compose) {
  const seedPath = path.join(REPO_ROOT, "scripts", "dev-seed.sql");
  if (!existsSync(seedPath)) return;
  log("seeding dev fixtures (scripts/dev-seed.sql)...");
  const result = spawnSync(
    compose.bin,
    composeArgs(compose, [
      "exec",
      "-T",
      "postgres",
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      POSTGRES_USER,
      "-d",
      POSTGRES_DB,
    ]),
    { input: readFileSync(seedPath), stdio: ["pipe", "ignore", "inherit"] },
  );
  if (result.status !== 0) throw new Error("dev seed failed (scripts/dev-seed.sql)");
}

// The env relocation is the essence of W2: everything ops/compose.dev.yml
// injects into the `app` *container* (JWT keys, WebAuthn RP, cookie flag,
// cold-start OTP) plus the docker-network hostnames the container-only
// x-app-env anchor uses (ops/compose.yml:10-13) — DATABASE_URL, the S3/
// SeaweedFS endpoint, and OTEL_EXPORTER_OTLP_ENDPOINT — rewritten to the
// published localhost ports for a host-launched process.
function buildAppEnv(role) {
  const { privateKeyPem, publicKeyPem } = ensureDevKeys();
  return {
    ...process.env,
    MNT_APP_ROLE: role,
    DATABASE_URL: databaseUrl(),
    MNT_HTTP_ADDR: `127.0.0.1:${PORTS.backend}`,
    // Local dev intentionally uses the OTP-logging stub unless a caller supplies
    // a complete SMTP relay config via MNT_EMAIL_*.
    MNT_EMAIL_STUB_MODE: process.env.MNT_EMAIL_STUB_MODE ?? "dev",
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${PORTS.otel}`,
    OTEL_SERVICE_NAME: "mnt-app-dev",
    MNT_S3_ENDPOINT_URL: `http://127.0.0.1:${PORTS.s3}`,
    MNT_S3_REGION: "us-east-1",
    MNT_S3_ACCESS_KEY_ID: "dev",
    MNT_S3_SECRET_ACCESS_KEY: "dev",
    MNT_S3_PRIMARY_BUCKET: "mnt-evidence",
    MNT_S3_REPLICA_BUCKET: "mnt-evidence-replica",
    MNT_S3_FORCE_PATH_STYLE: "true",
    MNT_JWT_PRIVATE_KEY_PEM: privateKeyPem,
    MNT_JWT_PUBLIC_KEY_PEM: publicKeyPem,
    MNT_JWT_ISSUER: "mnt-console-dev",
    MNT_JWT_AUDIENCE: "mnt-console",
    MNT_WEBAUTHN_RP_ID: "localhost",
    MNT_WEBAUTHN_RP_ORIGIN: `http://localhost:${PORTS.vite}`,
    MNT_WEBAUTHN_RP_NAME: "정비 콘솔 (dev)",
    MNT_COOKIE_SECURE: "false",
    MNT_COLDSTART_OTP: process.env.MNT_COLDSTART_OTP ?? "coss0000",
    // mox integration (slice 1): route the webmail send transport at the dev mox
    // server's webapi, and arm the delivery-webhook shared secret. The account's
    // mox login (mox@localhost / moxmoxmox) is set when a mailbox is configured
    // through the REST /account endpoint (see scripts/mox-e2e.mjs).
    MNT_MAIL_MOX_BASE_URL:
      process.env.MNT_MAIL_MOX_BASE_URL ?? `http://127.0.0.1:${PORTS.moxWebapi}`,
    MNT_MAIL_MOX_WEBHOOK_SECRET:
      process.env.MNT_MAIL_MOX_WEBHOOK_SECRET ?? "mox-dev-webhook-secret-change-me",
    // In-console office editor (ONLYOFFICE), only when MNT_DEV_OFFICE=1 started
    // the DocumentServer dep. Omitting all three MNT_OFFICE_* vars otherwise
    // leaves the office routes on their existing graceful-503 path (same as an
    // unconfigured prod deploy) instead of pointing at a container that was
    // never started. The shared JWT secret matches the DocumentServer
    // container's JWT_SECRET; DocumentServer reaches the host-run app back
    // over host.docker.internal at the backend port.
    ...(OFFICE_ENABLED
      ? {
          MNT_OFFICE_JWT_SECRET: OFFICE_JWT_SECRET,
          MNT_OFFICE_DOCSERVER_URL: `http://127.0.0.1:${PORTS.office}`,
          MNT_OFFICE_CALLBACK_BASE_URL: `http://host.docker.internal:${PORTS.backend}`,
        }
      : {}),
    RUST_LOG: process.env.RUST_LOG ?? "info,tower_http=info",
    SQLX_OFFLINE: "true",
  };
}

function writePidState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(PID_FILE, JSON.stringify(state, null, 2));
}

function readPidState() {
  if (!existsSync(PID_FILE)) return null;
  try {
    return JSON.parse(readFileSync(PID_FILE, "utf8"));
  } catch {
    return null;
  }
}

function printUrls() {
  console.log("");
  console.log("Local full-stack dev environment ready:");
  console.log(`  Backend:      http://127.0.0.1:${PORTS.backend}`);
  console.log(`  /readyz:      http://127.0.0.1:${PORTS.backend}/readyz`);
  console.log(`  Web console:  http://localhost:${PORTS.vite}`);
  console.log(`  Mailpit UI:   http://localhost:${PORTS.mailpitUi}`);
  console.log(`  mox webapi:   http://localhost:${PORTS.moxWebapi}/webapi/  (mox@localhost / moxmoxmox, admin moxadmin)`);
  console.log(`  mox IMAP:     127.0.0.1:${PORTS.moxImap}   submission 127.0.0.1:${PORTS.moxSubmission}`);
  console.log("");
  console.log(`First sign-in one-time code: ${process.env.MNT_COLDSTART_OTP ?? "coss0000"}`);
  console.log("");
}

async function cmdUp() {
  await assertPortFree(PORTS.backend, "backend");
  const compose = await bringUpDeps();
  runMigrations();
  runSeed(compose);

  const appEnv = buildAppEnv("api");
  log("launching bacon (backend) + vite (web)...");
  // bacon's interactive TUI needs a real controlling terminal (crossterm raw
  // mode); without one (nohup, CI, an agent-driven run) it fails immediately
  // with "Device not configured". `--headless` just runs the default job on
  // change with no TUI, which works either way — so use it whenever stdout
  // isn't a TTY, and keep the normal interactive UI for a real terminal.
  const baconArgs = process.stdout.isTTY ? ["run"] : ["run", "--headless"];
  const backend = spawn("bacon", baconArgs, {
    cwd: BACKEND_DIR,
    env: appEnv,
    stdio: "inherit",
  });
  const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
  const web = spawn(npmBin, ["run", "web:dev"], {
    cwd: REPO_ROOT,
    env: { ...appEnv, VITE_PROXY_TARGET: `http://127.0.0.1:${PORTS.backend}` },
    stdio: "inherit",
  });

  writePidState({
    startedBy: "up",
    backend: { pid: backend.pid, mode: "bacon" },
    web: { pid: web.pid, mode: "npm" },
  });

  let shuttingDown = false;
  const shutdown = (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("stopping bacon + vite (docker deps stay up — run `dev-up.mjs down` to stop them)...");
    for (const child of [backend, web]) {
      if (child.pid) {
        try {
          process.kill(child.pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
    }
    process.exit(exitCode);
  };
  process.once("SIGINT", () => shutdown(0));
  process.once("SIGTERM", () => shutdown(0));
  backend.on("error", (err) => {
    log(`ERROR: could not start bacon: ${err.message} (run \`dev-up.mjs doctor\`)`);
    shutdown(1);
  });
  web.on("error", (err) => {
    log(`ERROR: could not start npm/vite: ${err.message} (run \`dev-up.mjs doctor\`)`);
    shutdown(1);
  });
  backend.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      log(`bacon exited with code ${code}`);
      shutdown(1);
    }
  });
  web.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      log(`vite exited with code ${code}`);
      shutdown(1);
    }
  });

  // If the readyz wait itself fails (e.g. times out), bacon/vite are already
  // running — without this, main().catch() would just log and exit while
  // those two `stdio: "inherit"` children keep the event loop (and the
  // terminal) alive forever with no dev-up process left to manage them.
  try {
    log(`waiting for /readyz on http://127.0.0.1:${PORTS.backend}/readyz ...`);
    await waitForHttp(`http://127.0.0.1:${PORTS.backend}/readyz`, 180_000);
  } catch (err) {
    log(`ERROR: ${err.message}`);
    shutdown(1);
    return;
  }
  printUrls();

  await new Promise(() => {}); // stay foreground while bacon/vite run
}

// MNT_DEV_AUTH_E2E=1 additionally builds the backend with --features dev-auth
// and starts the Vite dev server in the background too, so the dev-mode e2e
// project (playwright.config.ts, "dev-auth") has a real stack to run against.
// Plain `bootstrap` (the existing CI "dev-up-smoke" job) is unaffected.
async function cmdBootstrap() {
  await assertPortFree(PORTS.backend, "backend");
  const compose = await bringUpDeps();
  runMigrations();
  runSeed(compose);

  const devAuth = process.env.MNT_DEV_AUTH_E2E === "1";
  const appEnv = buildAppEnv("api");
  mkdirSync(STATE_DIR, { recursive: true });
  const logFile = path.join(STATE_DIR, "backend.log");
  const out = openSync(logFile, "a");
  const cargoArgs = devAuth
    ? ["run", "-q", "-p", "mnt-app", "--features", "dev-auth"]
    : ["run", "-q", "-p", "mnt-app"];
  log(
    `starting mnt-app (api${devAuth ? ", --features dev-auth" : ""}) in the background, logging to ${path.relative(REPO_ROOT, logFile)}...`,
  );
  const backend = spawn("cargo", cargoArgs, {
    cwd: BACKEND_DIR,
    env: appEnv,
    stdio: ["ignore", out, out],
    detached: process.platform !== "win32",
  });
  const backendState = {
    pid: backend.pid,
    mode: "cargo",
    logFile,
    group: process.platform !== "win32",
  };
  let ready = false;
  const backendStart = new Promise((_, reject) => {
    let settled = false;
    const failBeforeReady = (message) => {
      if (!settled) {
        settled = true;
        reject(new Error(message));
      }
    };
    const handleEnd = (event, code, signal) => {
      const detail =
        code === null ? `${event} by signal ${signal}` : `${event} with code ${code}`;
      if (ready) {
        log(`cargo ${detail} after readiness`);
      } else {
        failBeforeReady(`cargo ${detail} before /readyz`);
      }
    };
    backend.once("error", (err) => {
      if (ready) {
        log(`cargo process error after readiness: ${err.message}`);
      } else {
        failBeforeReady(`could not start cargo: ${err.message}`);
      }
    });
    backend.once("exit", (code, signal) => handleEnd("exited", code, signal));
    backend.once("close", (code, signal) => handleEnd("closed", code, signal));
  });
  backend.unref();
  writePidState({ startedBy: "bootstrap", backend: backendState, web: null });

  try {
    await Promise.race([
      waitForHttp(`http://127.0.0.1:${PORTS.backend}/readyz`, 180_000),
      backendStart,
    ]);
  } catch (err) {
    stopBackendProcess(backendState);
    throw err;
  }
  ready = true;
  log(`/readyz green at http://127.0.0.1:${PORTS.backend}/readyz`);

  let webState = null;
  if (devAuth) {
    const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
    const webLogFile = path.join(STATE_DIR, "web.log");
    const webOut = openSync(webLogFile, "a");
    log(`starting vite dev server in the background, logging to ${path.relative(REPO_ROOT, webLogFile)}...`);
    const web = spawn(npmBin, ["run", "web:dev"], {
      cwd: REPO_ROOT,
      env: { ...appEnv, VITE_PROXY_TARGET: `http://127.0.0.1:${PORTS.backend}` },
      stdio: ["ignore", webOut, webOut],
      detached: process.platform !== "win32",
    });
    webState = {
      pid: web.pid,
      mode: "npm",
      logFile: webLogFile,
      group: process.platform !== "win32",
    };
    writePidState({
      startedBy: "bootstrap",
      backend: backendState,
      web: webState,
    });
    const webStart = new Promise((_, reject) => {
      let settled = false;
      const fail = (message) => {
        if (!settled) {
          settled = true;
          reject(new Error(message));
        }
      };
      web.once("error", (err) => fail(`could not start vite: ${err.message}`));
      web.once("exit", (code, signal) => {
        fail(code === null ? `vite exited by signal ${signal}` : `vite exited with code ${code}`);
      });
      web.once("close", (code, signal) => {
        fail(code === null ? `vite closed by signal ${signal}` : `vite closed with code ${code}`);
      });
    });
    web.unref();
    try {
      await Promise.race([
        waitForHttp(`http://localhost:${PORTS.vite}/`, 60_000),
        webStart,
      ]);
    } catch (err) {
      stopBackendProcess(webState);
      stopBackendProcess(backendState);
      throw err;
    }
    log(`Vite dev server green at http://localhost:${PORTS.vite}/`);
  }

  writePidState({ startedBy: "bootstrap", backend: backendState, web: webState });
  printUrls();
}

async function cmdDown() {
  const state = readPidState();
  if (state) {
    for (const proc of [state.backend, state.web]) {
      if (proc?.pid) {
        stopBackendProcess(proc);
      }
    }
  }
  const compose = detectCompose();
  if (compose) {
    log("stopping docker deps...");
    runCompose(compose, ["down"], { cwd: REPO_ROOT, stdio: "inherit" });
  } else {
    log("no container runtime detected; skipping compose down");
  }
  if (existsSync(PID_FILE)) rmSync(PID_FILE);
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case "doctor":
      await cmdDoctor(rest);
      break;
    case "up":
      await cmdUp();
      break;
    case "bootstrap":
      await cmdBootstrap();
      break;
    case "down":
      await cmdDown();
      break;
    default:
      console.error("usage: dev-up.mjs <doctor|up|bootstrap|down> [--cached]");
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`dev-up: ERROR: ${err.message}`);
  process.exitCode = 1;
});
