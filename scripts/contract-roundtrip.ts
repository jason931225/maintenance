import {
  createSign,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import pg from "pg";

import { createMaintenanceApiClient } from "../clients/ts/src/index.js";
import {
  observeChild,
  stopChild,
  waitForChildReady,
} from "./lib/app-process.mjs";

const { Client: PgClient } = pg;
const root = resolve(new URL("..", import.meta.url).pathname);
const databaseUrl = process.env.CONTRACT_DATABASE_URL;
const appBinary = process.env.MNT_APP_BIN
  ? resolve(process.env.MNT_APP_BIN)
  : resolve(root, ".tmp/buck2/api-contract/mnt-app");
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
if (!existsSync(appBinary)) {
  throw new Error(
    `MNT_APP_BIN must name an already-built mnt-app binary (looked for ${appBinary})`,
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
  await runAppMigration(appBinary, topology.ownerDatabaseUrl);
  await assertRuntimePublicSchemaAccess(topology.runtimeDatabaseUrl);
  await seedContractData(db, userId, branchId);

  const token = issueAccessToken(userId, branchId);
  const appEnv = {
    DATABASE_URL: topology.runtimeDatabaseUrl,
    LEAVE_COMMAND_DATABASE_URL: topology.leaveCommandDatabaseUrl,
    ONTOLOGY_COMMAND_DATABASE_URL: topology.ontologyCommandDatabaseUrl,
    MNT_APP_ROLE: "api",
    MNT_HTTP_ADDR: `127.0.0.1:${port}`,
    MNT_JWT_ISSUER: issuer,
    MNT_JWT_AUDIENCE: audience,
    MNT_JWT_PUBLIC_KEY_PEM: publicKeyPem,
  };
  const observed = observeChild(spawn(appBinary, [], {
    cwd: root,
    env: appEnv,
    stdio: ["ignore", "pipe", "pipe"],
  }));
  const { child: app } = observed;

  // Drain both streams so a chatty boot cannot fill an OS pipe buffer before
  // the app serves /healthz. Echo live so CI logs show exactly what it did.
  let appOutput = "";
  const capture = (chunk: Buffer) => {
    const text = chunk.toString();
    appOutput += text;
    process.stderr.write(text);
  };
  if (!app.stdout || !app.stderr) {
    throw new Error("mnt-app must expose stdout and stderr pipes");
  }
  app.stdout.on("data", capture);
  app.stderr.on("data", capture);

  try {
    await waitForChildReady({
      observed,
      checkReady: async ({ signal }) =>
        (await fetch(`${baseUrl}/healthz`, { signal })).ok,
      getOutput: () => appOutput,
    });
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
    await stopChild(app);
  }
} finally {
  await db.end();
}

async function provisionDatabaseTopology(
  client: pg.Client,
  connectionString: string,
) {
  const currentUser = await client.query<{ current_user: string }>(
    "SELECT current_user",
  );
  if (currentUser.rows[0].current_user === "mnt_app") {
    throw new Error(
      "CONTRACT_DATABASE_URL must use a cluster administrator distinct from mnt_app",
    );
  }
  const timeoutPrerequisites = await client.query<{ ok: boolean }>(
    `SELECT current_setting('server_version_num')::integer >= 170000
            AND current_setting('max_prepared_transactions')::integer = 0
            AND NOT EXISTS (SELECT 1 FROM pg_prepared_xacts) AS ok`,
  );
  if (!timeoutPrerequisites.rows[0].ok) {
    throw new Error(
      "contract database requires PostgreSQL 17+ with prepared transactions disabled",
    );
  }

  const allocatedPasswords = new Set<string>();
  const distinctPassword = () => {
    let password: string;
    do {
      password = randomBytes(32).toString("hex");
    } while (allocatedPasswords.has(password));
    allocatedPasswords.add(password);
    return password;
  };
  const rolePasswords = {
    mnt_app: distinctPassword(),
    mnt_rt: distinctPassword(),
    mnt_leave_cmd: distinctPassword(),
    mnt_ontology_cmd: distinctPassword(),
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
         format('CREATE ROLE %I LOGIN NOSUPERUSER ${bypassRls} ${inherit} NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', $1::text, $2::text) AS create_ddl,
         format('ALTER ROLE %I LOGIN NOSUPERUSER ${bypassRls} ${inherit} NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', $1::text, $2::text) AS alter_ddl`,
        [role, password],
      );
      const exists = await client.query<{ exists: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=$1)",
        [role],
      );
      await client.query(
        exists.rows[0].exists ? ddl.rows[0].alter_ddl : ddl.rows[0].create_ddl,
      );
    }

    for (const role of ["mnt_rt", "mnt_leave_cmd", "mnt_ontology_cmd"]) {
      const defaults = await client.query<{
        statement_ddl: string;
        idle_ddl: string;
        transaction_ddl: string;
      }>(
        `SELECT
           format('ALTER ROLE %I SET statement_timeout = ''30s''', $1::text) AS statement_ddl,
           format('ALTER ROLE %I SET idle_in_transaction_session_timeout = ''30s''', $1::text) AS idle_ddl,
           format('ALTER ROLE %I SET transaction_timeout = ''45s''', $1::text) AS transaction_ddl`,
        [role],
      );
      await client.query(defaults.rows[0].statement_ddl);
      await client.query(defaults.rows[0].idle_ddl);
      await client.query(defaults.rows[0].transaction_ddl);

      const overrides = await client.query<{ ddl: string }>(
        `SELECT format('ALTER ROLE %I IN DATABASE %I RESET %I', role.rolname, database.datname, managed.key) AS ddl
           FROM pg_db_role_setting settings
           JOIN pg_roles role ON role.oid = settings.setrole
           JOIN pg_database database ON database.oid = settings.setdatabase
           CROSS JOIN (VALUES
             ('statement_timeout'),
             ('idle_in_transaction_session_timeout'),
             ('transaction_timeout')
           ) managed(key)
          WHERE role.rolname = $1
            AND EXISTS (
              SELECT 1 FROM unnest(settings.setconfig) setting
               WHERE split_part(setting, '=', 1) = managed.key
            )`,
        [role],
      );
      for (const { ddl } of overrides.rows) {
        await client.query(ddl);
      }
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
    const databaseOwnerDdl = await client.query<{ ddl: string }>(
      "SELECT format('ALTER DATABASE %I OWNER TO mnt_app', current_database()) AS ddl",
    );
    await client.query(databaseOwnerDdl.rows[0].ddl);

    const topology = await client.query<{
      roles: string;
      memberships: string;
      runtime_defaults_ok: boolean;
    }>(`
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
             )) AS memberships,
      current_setting('server_version_num')::integer >= 170000
        AND current_setting('max_prepared_transactions')::integer = 0
        AND NOT EXISTS (SELECT 1 FROM pg_prepared_xacts)
        AND NOT EXISTS (
          SELECT 1
          FROM (VALUES ('mnt_rt'), ('mnt_leave_cmd'), ('mnt_ontology_cmd')) expected(role_name)
          WHERE NOT EXISTS (
            SELECT 1
            FROM pg_db_role_setting settings
            JOIN pg_roles role ON role.oid = settings.setrole
            WHERE role.rolname = expected.role_name
              AND settings.setdatabase = 0
              AND settings.setconfig @> ARRAY[
                'statement_timeout=30s',
                'idle_in_transaction_session_timeout=30s',
                'transaction_timeout=45s'
              ]
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM pg_db_role_setting settings
          JOIN pg_roles role ON role.oid = settings.setrole
          CROSS JOIN LATERAL unnest(settings.setconfig) setting
          WHERE role.rolname IN ('mnt_rt', 'mnt_leave_cmd', 'mnt_ontology_cmd')
            AND settings.setdatabase <> 0
            AND split_part(setting, '=', 1) IN (
              'statement_timeout', 'idle_in_transaction_session_timeout', 'transaction_timeout'
            )
        ) AS runtime_defaults_ok
  `);
    if (
      topology.rows[0].roles !==
        "mnt_app:true:false:true:true,mnt_leave_cmd:true:false:false:false,mnt_leave_definer:false:false:false:false,mnt_ontology_cmd:true:false:false:false,mnt_ontology_writer:false:false:false:false,mnt_rt:true:false:false:false" ||
      topology.rows[0].memberships !==
        "mnt_app>mnt_leave_definer:false:true:true,mnt_app>mnt_ontology_writer:false:true:true" ||
      !topology.rows[0].runtime_defaults_ok
    ) {
      throw new Error(
        `contract database topology readback failed: ${JSON.stringify(topology.rows[0])}`,
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  const capturedBackends = await client.query<{ pid: number }>(
    `SELECT pid
       FROM pg_stat_activity
      WHERE usename IN ('mnt_rt', 'mnt_leave_cmd', 'mnt_ontology_cmd')
        AND pid <> pg_backend_pid()
      ORDER BY pid`,
  );
  for (const { pid } of capturedBackends.rows) {
    const terminated = await client.query<{ terminated: boolean }>(
      "SELECT pg_terminate_backend($1, 5000) AS terminated",
      [pid],
    );
    if (!terminated.rows[0].terminated) {
      throw new Error(`contract database failed to terminate backend ${pid}`);
    }
  }
  if (capturedBackends.rowCount) {
    const remaining = await client.query<{ count: string }>(
      "SELECT count(*) FROM pg_stat_activity WHERE pid = ANY($1::integer[])",
      [capturedBackends.rows.map(({ pid }) => pid)],
    );
    if (remaining.rows[0].count !== "0") {
      throw new Error("contract database serving-backend drain barrier failed");
    }
  }

  const roleUrl = (role: keyof typeof rolePasswords) => {
    const url = new URL(connectionString);
    url.username = role;
    url.password = rolePasswords[role];
    return url.toString();
  };
  const topology = {
    ownerDatabaseUrl: roleUrl("mnt_app"),
    runtimeDatabaseUrl: roleUrl("mnt_rt"),
    leaveCommandDatabaseUrl: roleUrl("mnt_leave_cmd"),
    ontologyCommandDatabaseUrl: roleUrl("mnt_ontology_cmd"),
  };
  await assertDirectDatabaseLogin(topology.ownerDatabaseUrl, "mnt_app", true);
  await assertDirectDatabaseLogin(topology.runtimeDatabaseUrl, "mnt_rt", false);
  await assertDirectDatabaseLogin(
    topology.leaveCommandDatabaseUrl,
    "mnt_leave_cmd",
    false,
  );
  await assertDirectDatabaseLogin(
    topology.ontologyCommandDatabaseUrl,
    "mnt_ontology_cmd",
    false,
  );
  return topology;
}

async function assertDirectDatabaseLogin(
  connectionString: string,
  expectedRole: string,
  migrationOwner: boolean,
) {
  const probe = new PgClient({ connectionString });
  await probe.connect();
  try {
    const result = await probe.query<{
      session_user: string;
      current_user: string;
      attributes_ok: boolean;
      membership_shape_ok: boolean;
      statement_timeout: string;
      idle_in_transaction_session_timeout: string;
      transaction_timeout: string;
    }>(
      `SELECT session_user::text,
              current_user::text,
              authenticated.rolcanlogin
                AND NOT authenticated.rolsuper
                AND authenticated.rolbypassrls = $2
                AND authenticated.rolinherit = $2
                AND NOT authenticated.rolcreatedb
                AND NOT authenticated.rolcreaterole
                AND NOT authenticated.rolreplication AS attributes_ok,
              CASE WHEN $2 THEN
                (SELECT count(*) = 2
                   FROM pg_auth_members membership
                  WHERE membership.member = authenticated.oid
                    AND membership.roleid IN (
                      to_regrole('mnt_leave_definer'), to_regrole('mnt_ontology_writer')
                    )
                    AND NOT membership.admin_option
                    AND membership.inherit_option
                    AND membership.set_option)
                AND NOT EXISTS (
                  SELECT 1 FROM pg_roles candidate
                  WHERE candidate.rolname <> session_user
                    AND candidate.rolname NOT IN (
                      'pg_database_owner', 'mnt_leave_definer', 'mnt_ontology_writer'
                    )
                    AND pg_has_role(session_user, candidate.oid, 'MEMBER')
                )
                AND NOT EXISTS (
                  SELECT 1 FROM pg_auth_members membership
                  WHERE membership.roleid = authenticated.oid
                )
              ELSE NOT EXISTS (
                SELECT 1 FROM pg_auth_members membership
                WHERE membership.member = authenticated.oid
                   OR membership.roleid = authenticated.oid
              ) END AS membership_shape_ok,
              current_setting('statement_timeout') AS statement_timeout,
              current_setting('idle_in_transaction_session_timeout') AS idle_in_transaction_session_timeout,
              current_setting('transaction_timeout') AS transaction_timeout
         FROM pg_roles authenticated
        WHERE authenticated.rolname = $1`,
      [expectedRole, migrationOwner],
    );
    const identity = result.rows[0];
    if (
      identity?.session_user !== expectedRole ||
      identity.current_user !== expectedRole ||
      !identity.attributes_ok ||
      !identity.membership_shape_ok ||
      (!migrationOwner &&
        (identity.statement_timeout !== "30s" ||
          identity.idle_in_transaction_session_timeout !== "30s" ||
          identity.transaction_timeout !== "45s"))
    ) {
      throw new Error(
        `contract database direct-login check failed for ${expectedRole}`,
      );
    }
  } finally {
    await probe.end();
  }
}

async function assertRuntimePublicSchemaAccess(runtimeDatabaseUrl: string) {
  const runtime = new PgClient({ connectionString: runtimeDatabaseUrl });
  await runtime.connect();
  try {
    const result = await runtime.query<{
      has_usage: boolean;
      has_create: boolean;
      visible_rows: string;
    }>(`
      SELECT has_schema_privilege(current_user, 'public', 'USAGE') AS has_usage,
             has_schema_privilege(current_user, 'public', 'CREATE') AS has_create,
             (SELECT count(*) FROM public.users WHERE false) AS visible_rows
    `);
    const access = result.rows[0];
    if (
      !access?.has_usage ||
      access.has_create ||
      access.visible_rows !== "0"
    ) {
      throw new Error(
        `contract database mnt_rt public schema ACL readback failed: ${JSON.stringify(access)}`,
      );
    }
  } finally {
    await runtime.end();
  }
}

async function runAppMigration(binary: string, ownerDatabaseUrl: string) {
  const migration = spawn(binary, [], {
    cwd: root,
    env: {
      DATABASE_URL: ownerDatabaseUrl,
      MNT_APP_ROLE: "migrate",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const capture = (chunk: Buffer) => {
    const text = chunk.toString();
    output += text;
    process.stderr.write(text);
  };
  migration.stdout.on("data", capture);
  migration.stderr.on("data", capture);

  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveExit, reject) => {
    migration.once("error", reject);
    migration.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  if (result.code !== 0) {
    throw new Error(
      `mnt-app migrate failed: code=${result.code} signal=${result.signal ?? "none"}\n${output}`,
    );
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

  await client.query("DROP SCHEMA IF EXISTS apalis CASCADE");
  await client.query("DROP SCHEMA IF EXISTS ontology_api CASCADE");
  await client.query("DROP SCHEMA IF EXISTS leave_api CASCADE");
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
