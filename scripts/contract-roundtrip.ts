import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import pg from "pg";

import { createMaintenanceApiClient } from "../clients/ts/src/index.js";

const { Client: PgClient } = pg;
const root = resolve(new URL("..", import.meta.url).pathname);
const databaseUrl = process.env.CONTRACT_DATABASE_URL;
const port = Number(process.env.CONTRACT_APP_PORT ?? "18081");
const baseUrl = `http://127.0.0.1:${port}`;
const issuer = "mnt-platform-auth";
const audience = "mnt-api";

if (!databaseUrl) {
  throw new Error("CONTRACT_DATABASE_URL is required for the generated-client contract test");
}

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const userId = randomUUID();
const branchId = randomUUID();

const db = new PgClient({ connectionString: databaseUrl });
await db.connect();

try {
  await resetLocalContractDatabase(db, databaseUrl);
  await applyMigrations(db);
  await seedContractData(db, userId, branchId);

  const token = issueAccessToken(userId, branchId);
  const app = spawn("cargo", ["run", "-p", "mnt-app"], {
    cwd: resolve(root, "backend"),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      MNT_APP_ROLE: "api",
      MNT_HTTP_ADDR: `127.0.0.1:${port}`,
      MNT_JWT_ISSUER: issuer,
      MNT_JWT_AUDIENCE: audience,
      MNT_JWT_PUBLIC_KEY_PEM: publicKeyPem,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Drain BOTH stdout and stderr. Leaving the stdout pipe unread lets a chatty
  // boot (or a cold `cargo run` recompile) fill the OS pipe buffer and block the
  // app's write() before it ever serves /healthz — indistinguishable from a
  // readiness timeout. Echo live so CI logs show exactly what the app did.
  let appOutput = "";
  const capture = (chunk: Buffer) => {
    const text = chunk.toString();
    appOutput += text;
    process.stderr.write(text);
  };
  app.stdout.on("data", capture);
  app.stderr.on("data", capture);

  try {
    await waitForApp(app, () => appOutput);
    const health = await fetch(`${baseUrl}/healthz`);
    if (!health.ok) {
      throw new Error(`healthz returned ${health.status}`);
    }

    const client = createMaintenanceApiClient({ baseUrl, bearerToken: token });
    const { data, error, response } = await client.POST("/api/work-orders", {
      body: {
        branch_id: branchId,
        management_no: "#290",
        symptom: "Hydraulic oil leak",
      },
    });

    if (response.status !== 201 || error || !data) {
      throw new Error(
        `createWorkOrder failed: status=${response.status} body=${JSON.stringify(error)}`,
      );
    }
    if (data.branch_id !== branchId || data.status !== "RECEIVED") {
      throw new Error(`Unexpected WorkOrderSummary: ${JSON.stringify(data)}`);
    }
    if (!data.request_no.endsWith("-001")) {
      throw new Error(`Unexpected request_no: ${data.request_no}`);
    }
  } finally {
    app.kill("SIGTERM");
  }
} finally {
  await db.end();
}

async function applyMigrations(client: pg.Client) {
  const migrationDir = resolve(root, "backend/crates/platform/db/migrations");
  for (const file of readdirSync(migrationDir).filter((name) => name.endsWith(".sql")).sort()) {
    await client.query(readFileSync(resolve(migrationDir, file), "utf8"));
  }
}

async function resetLocalContractDatabase(client: pg.Client, connectionString: string) {
  const url = new URL(connectionString);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  const isLocal = localHosts.has(url.hostname);
  const isDisposable = /(contract|test|ci)/i.test(databaseName);

  if (!isLocal || !isDisposable) {
    throw new Error(
      `Refusing to reset non-local or non-disposable contract database: ${url.hostname}/${databaseName}`,
    );
  }

  await client.query("DROP SCHEMA IF EXISTS public CASCADE");
  await client.query("CREATE SCHEMA public");
}

async function seedContractData(client: pg.Client, actorId: string, scopedBranchId: string) {
  const regionId = randomUUID();
  const customerId = randomUUID();
  const siteId = randomUUID();

  await client.query("INSERT INTO regions (id, name) VALUES ($1, $2)", [
    regionId,
    "Contract Region",
  ]);
  await client.query("INSERT INTO branches (id, region_id, name) VALUES ($1, $2, $3)", [
    scopedBranchId,
    regionId,
    "Contract Branch",
  ]);
  await client.query("INSERT INTO users (id, display_name, roles) VALUES ($1, $2, $3)", [
    actorId,
    "Contract Admin",
    ["ADMIN"],
  ]);
  await client.query("INSERT INTO user_branches (user_id, branch_id) VALUES ($1, $2)", [
    actorId,
    scopedBranchId,
  ]);
  await client.query(
    "INSERT INTO registry_customers (id, branch_id, name) VALUES ($1, $2, $3)",
    [customerId, scopedBranchId, "Contract Customer"],
  );
  await client.query(
    "INSERT INTO registry_sites (id, branch_id, customer_id, name) VALUES ($1, $2, $3, $4)",
    [siteId, scopedBranchId, customerId, "Contract Site"],
  );
  await client.query(
    `INSERT INTO registry_equipment (
        branch_id, customer_id, site_id, equipment_no, management_no,
        manufacturer_code, kind_code, power_code, status,
        specification, ton_text, model, source_sheet, source_row
      )
      VALUES ($1, $2, $3, $4, $5, 'A', 'B', 'C', '임대', '좌식', '2.5', 'GTS25DE', 'contract', 1)`,
    [scopedBranchId, customerId, siteId, "ABC12-0290", "290"],
  );
}

function issueAccessToken(subject: string, scopedBranchId: string) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", typ: "JWT" };
  const payload = {
    iss: issuer,
    aud: audience,
    sub: subject,
    iat: now,
    nbf: now,
    exp: now + 15 * 60,
    jti: randomUUID(),
    roles: ["ADMIN"],
    branches: [scopedBranchId],
    alg: "ES256",
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = createSign("SHA256")
    .update(signingInput)
    .end()
    .sign({ key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${base64url(signature)}`;
}

function base64url(input: string | Buffer) {
  return Buffer.from(input)
    .toString("base64")
    .replaceAll("=", "")
    .replaceAll("+", "-")
    .replaceAll("/", "_");
}

async function waitForApp(app: ReturnType<typeof spawn>, getStderr: () => string) {
  // Generous: absorbs a cold `cargo run` compile on a cache-miss runner plus
  // boot. The early-exit check below fails fast if the app actually crashes.
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    if (app.exitCode !== null) {
      throw new Error(`mnt-app exited early with ${app.exitCode}\n${getStderr()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) {
        return;
      }
    } catch {
      // App is still starting.
    }
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 500));
  }
  throw new Error(`Timed out waiting for mnt-app\n${getStderr()}`);
}
