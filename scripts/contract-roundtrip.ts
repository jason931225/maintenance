import {
  createSign,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import pg from "pg";

import { createMaintenanceApiClient } from "../clients/ts/src/index.js";

const { Client: PgClient } = pg;
const root = resolve(new URL("..", import.meta.url).pathname);
const databaseUrl = process.env.CONTRACT_DATABASE_URL;
const port = process.env.CONTRACT_APP_PORT
  ? Number(process.env.CONTRACT_APP_PORT)
  : await findOpenPort();
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error(
    `Invalid CONTRACT_APP_PORT: ${process.env.CONTRACT_APP_PORT}`,
  );
}
const baseUrl = `http://127.0.0.1:${port}`;
const issuer = "mnt-platform-auth";
const audience = "mnt-api";
// KNL is tenant #1, seeded by migration 0028 (OrgId::knl()). Every tenant-scoped
// row now carries org_id, so the contract seed stamps the same tenant. Declared
// at module top so the top-level seed IIFE can reference it (no TDZ).
const KNL_ORG_ID = "00000000-0000-0000-0000-0000000000a1";

if (!databaseUrl) {
  throw new Error(
    "CONTRACT_DATABASE_URL is required for the generated-client contract test",
  );
}

const { publicKey, privateKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
});
const publicKeyPem = publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const userId = randomUUID();
const branchId = randomUUID();

const db = new PgClient({ connectionString: databaseUrl });
await db.connect();

try {
  await resetLocalContractDatabase(db, databaseUrl);
  const topology = await provisionDatabaseTopology(db, databaseUrl);
  const migrationDb = new PgClient({ connectionString: topology.ownerDatabaseUrl });
  await migrationDb.connect();
  try {
    await applyMigrations(migrationDb);
  } finally {
    await migrationDb.end();
  }
  await seedContractData(db, userId, branchId);

  const token = issueAccessToken(userId, branchId);
  const appEnv = {
    ...process.env,
    DATABASE_URL: topology.runtimeDatabaseUrl,
    LEAVE_COMMAND_DATABASE_URL: topology.leaveCommandDatabaseUrl,
    ONTOLOGY_COMMAND_DATABASE_URL: topology.ontologyCommandDatabaseUrl,
    MNT_APP_ROLE: "api",
    MNT_HTTP_ADDR: `127.0.0.1:${port}`,
    MNT_JWT_ISSUER: issuer,
    MNT_JWT_AUDIENCE: audience,
    MNT_JWT_PUBLIC_KEY_PEM: publicKeyPem,
  };
  const app = process.env.MNT_APP_BIN
    ? spawn(process.env.MNT_APP_BIN, [], {
        cwd: root,
        env: appEnv,
        stdio: ["ignore", "pipe", "pipe"],
      })
    : spawn("cargo", ["run", "-p", "mnt-app"], {
        cwd: resolve(root, "backend"),
        env: appEnv,
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

async function provisionDatabaseTopology(
  client: pg.Client,
  connectionString: string,
) {
  const currentUser = await client.query<{ current_user: string }>("SELECT current_user");
  if (currentUser.rows[0].current_user === "mnt_app") {
    throw new Error("CONTRACT_DATABASE_URL must use a cluster administrator distinct from mnt_app");
  }

  const rolePasswords = {
    mnt_app: randomBytes(32).toString("hex"),
    mnt_rt: randomBytes(32).toString("hex"),
    mnt_leave_cmd: randomBytes(32).toString("hex"),
    mnt_ontology_cmd: randomBytes(32).toString("hex"),
  } as const;

  // ALTER ROLE has no parameterized password protocol. Suppress statement and
  // error-statement logging in the privileged transaction before sending any
  // generated password DDL, so even a failed statement cannot reach DB logs.
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL log_statement = 'none'");
    await client.query("SET LOCAL log_min_error_statement = 'panic'");
    await client.query(`
    DO $block$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mnt_leave_definer') THEN
        CREATE ROLE mnt_leave_definer NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mnt_ontology_writer') THEN
        CREATE ROLE mnt_ontology_writer NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
      END IF;
    END
    $block$;
    ALTER ROLE mnt_leave_definer NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
    ALTER ROLE mnt_ontology_writer NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
  `);

    for (const [role, password] of Object.entries(rolePasswords)) {
      const inherit = role === "mnt_app" ? "INHERIT" : "NOINHERIT";
      const bypassRls = role === "mnt_app" ? "BYPASSRLS" : "NOBYPASSRLS";
      const ddl = await client.query<{ create_ddl: string; alter_ddl: string }>(
        `SELECT
         format('CREATE ROLE %I LOGIN NOSUPERUSER ${bypassRls} ${inherit} NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', $1, $2) AS create_ddl,
         format('ALTER ROLE %I LOGIN NOSUPERUSER ${bypassRls} ${inherit} NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', $1, $2) AS alter_ddl`,
        [role, password],
      );
      const exists = await client.query<{ exists: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=$1)",
        [role],
      );
      await client.query(exists.rows[0].exists ? ddl.rows[0].alter_ddl : ddl.rows[0].create_ddl);
    }

    await client.query(`
    DO $block$
    DECLARE edge RECORD;
    BEGIN
      FOR edge IN
        SELECT member.rolname AS member_name, granted.rolname AS granted_name
        FROM pg_auth_members membership
        JOIN pg_roles member ON member.oid=membership.member
        JOIN pg_roles granted ON granted.oid=membership.roleid
        WHERE member.rolname IN (
                'mnt_app','mnt_rt','mnt_leave_cmd','mnt_ontology_cmd',
                'mnt_leave_definer','mnt_ontology_writer'
              )
           OR granted.rolname IN (
                'mnt_app','mnt_rt','mnt_leave_cmd','mnt_ontology_cmd',
                'mnt_leave_definer','mnt_ontology_writer'
              )
      LOOP
        EXECUTE format('REVOKE %I FROM %I', edge.granted_name, edge.member_name);
      END LOOP;
    END
    $block$;
    GRANT mnt_leave_definer, mnt_ontology_writer TO mnt_app
      WITH ADMIN FALSE, INHERIT TRUE, SET TRUE;
    ALTER SCHEMA public OWNER TO mnt_app;
  `);

    const topology = await client.query<{ roles: string; memberships: string }>(`
    SELECT
      (SELECT string_agg(
         rolname || ':' || rolcanlogin || ':' || rolsuper || ':' || rolbypassrls || ':' || rolinherit,
         ',' ORDER BY rolname)
       FROM pg_roles
       WHERE rolname IN (
         'mnt_app','mnt_rt','mnt_leave_cmd','mnt_ontology_cmd',
         'mnt_leave_definer','mnt_ontology_writer'
       )) AS roles,
      (SELECT string_agg(
         member.rolname || '>' || granted.rolname || ':' ||
         membership.admin_option || ':' || membership.inherit_option || ':' || membership.set_option,
         ',' ORDER BY granted.rolname)
       FROM pg_auth_members membership
       JOIN pg_roles member ON member.oid=membership.member
       JOIN pg_roles granted ON granted.oid=membership.roleid
       WHERE member.rolname IN (
               'mnt_app','mnt_rt','mnt_leave_cmd','mnt_ontology_cmd',
               'mnt_leave_definer','mnt_ontology_writer'
             )
          OR granted.rolname IN (
               'mnt_app','mnt_rt','mnt_leave_cmd','mnt_ontology_cmd',
               'mnt_leave_definer','mnt_ontology_writer'
             )) AS memberships
  `);
    if (
      topology.rows[0].roles !==
        "mnt_app:true:false:true:true,mnt_leave_cmd:true:false:false:false,mnt_leave_definer:false:false:false:false,mnt_ontology_cmd:true:false:false:false,mnt_ontology_writer:false:false:false:false,mnt_rt:true:false:false:false" ||
      topology.rows[0].memberships !==
        "mnt_app>mnt_leave_definer:false:true:true,mnt_app>mnt_ontology_writer:false:true:true"
    ) {
      throw new Error(`contract database topology readback failed: ${JSON.stringify(topology.rows[0])}`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  const roleUrl = (role: keyof typeof rolePasswords) => {
    const url = new URL(connectionString);
    url.username = role;
    url.password = rolePasswords[role];
    return url.toString();
  };
  return {
    ownerDatabaseUrl: roleUrl("mnt_app"),
    runtimeDatabaseUrl: roleUrl("mnt_rt"),
    leaveCommandDatabaseUrl: roleUrl("mnt_leave_cmd"),
    ontologyCommandDatabaseUrl: roleUrl("mnt_ontology_cmd"),
  };
}

async function applyMigrations(client: pg.Client) {
  const migrationDir = resolve(root, "backend/crates/platform/db/migrations");
  for (const file of readdirSync(migrationDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    await client.query(readFileSync(resolve(migrationDir, file), "utf8"));
  }
}

async function resetLocalContractDatabase(
  client: pg.Client,
  connectionString: string,
) {
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

async function seedContractData(
  client: pg.Client,
  actorId: string,
  scopedBranchId: string,
) {
  const regionId = randomUUID();
  const customerId = randomUUID();
  const siteId = randomUUID();

  await client.query(
    "INSERT INTO regions (id, name, org_id) VALUES ($1, $2, $3)",
    [regionId, "Contract Region", KNL_ORG_ID],
  );
  await client.query(
    "INSERT INTO branches (id, region_id, name, org_id) VALUES ($1, $2, $3, $4)",
    [scopedBranchId, regionId, "Contract Branch", KNL_ORG_ID],
  );
  await client.query(
    "INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)",
    [actorId, "Contract Admin", ["ADMIN"], KNL_ORG_ID],
  );
  await client.query(
    "INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)",
    [actorId, scopedBranchId, KNL_ORG_ID],
  );
  await client.query(
    "INSERT INTO registry_customers (id, branch_id, name, org_id) VALUES ($1, $2, $3, $4)",
    [customerId, scopedBranchId, "Contract Customer", KNL_ORG_ID],
  );
  await client.query(
    "INSERT INTO registry_sites (id, branch_id, customer_id, name, org_id) VALUES ($1, $2, $3, $4, $5)",
    [siteId, scopedBranchId, customerId, "Contract Site", KNL_ORG_ID],
  );
  await client.query(
    `INSERT INTO registry_equipment (
        branch_id, customer_id, site_id, equipment_no, management_no,
        manufacturer_code, kind_code, power_code, status,
        specification, ton_text, model, source_sheet, source_row, org_id
      )
      VALUES ($1, $2, $3, $4, $5, 'A', 'B', 'C', '임대', '좌식', '2.5', 'GTS25DE', 'contract', 1, $6)`,
    [scopedBranchId, customerId, siteId, "ABC12-0290", "290", KNL_ORG_ID],
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
    org: KNL_ORG_ID,
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

async function waitForApp(
  app: ReturnType<typeof spawn>,
  getStderr: () => string,
) {
  // Generous: absorbs a cold `cargo run` compile on a cache-miss runner plus
  // boot. The early-exit check below fails fast if the app actually crashes.
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    if (app.exitCode !== null) {
      throw new Error(
        `mnt-app exited early with ${app.exitCode}\n${getStderr()}`,
      );
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

async function findOpenPort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const portNumber =
        typeof address === "object" && address ? address.port : 0;
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
