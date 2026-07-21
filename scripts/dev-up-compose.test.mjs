#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const compose = readFileSync(
  new URL("../ops/compose.dev-deps.yml", import.meta.url),
  "utf8",
);
const baseCompose = readFileSync(
  new URL("../ops/compose.yml", import.meta.url),
  "utf8",
);
const devUp = readFileSync(new URL("./dev-up.mjs", import.meta.url), "utf8");
const opsReadme = readFileSync(
  new URL("../ops/README.md", import.meta.url),
  "utf8",
);
const secretsDoc = readFileSync(
  new URL("../deploy/SECRETS.md", import.meta.url),
  "utf8",
);
const e2eDb = readFileSync(
  new URL("../e2e/harness/db.sh", import.meta.url),
  "utf8",
);
const devSeed = readFileSync(
  new URL("./dev-seed.sql", import.meta.url),
  "utf8",
);
const commandRoleInit = readFileSync(
  new URL("../ops/postgres-reconcile-topology.sh", import.meta.url),
  "utf8",
);

test("mox localserve creates its config below the named volume root", () => {
  assert.match(compose, /localserve/);

  const dataDir = compose.match(/-dir[",\s]+(?<dir>\/mox-data\/[^"\s]+)/)
    ?.groups?.dir;
  assert.ok(
    dataDir,
    "mox localserve command should pass a child -dir under /mox-data",
  );

  const volumeTarget = compose.match(/^\s*-\s*mox-data:(?<target>\/\S+)/m)
    ?.groups?.target;
  assert.ok(volumeTarget, "mox service should mount the mox-data volume");

  assert.notEqual(
    dataDir,
    volumeTarget,
    "mox localserve must not point -dir at the mounted volume root; Docker creates that directory before mox starts, so localserve tries to load a missing config instead of generating one",
  );
  assert.ok(
    dataDir.startsWith(`${volumeTarget}/`),
    `mox localserve data dir ${dataDir} should stay inside named volume ${volumeTarget}`,
  );
  assert.match(
    compose,
    new RegExp(`${dataDir.replaceAll("/", "\\/")}\\/mox\\.conf`),
    "mox localserve should branch on the generated config file before reusing a persistent named volume",
  );
  assert.match(
    compose,
    new RegExp(`localserve -dir ${dataDir.replaceAll("/", "\\/")}`),
    "restarts with an existing config must omit -ip because mox only accepts -ip while creating a new config",
  );
});

test("Compose migrates as mnt_app and serves as mnt_rt without owner/admin credentials", () => {
  const appBlock = baseCompose.match(/\n  app:\n(?<body>[\s\S]*?)\n  worker:\n/)
    ?.groups?.body;
  const workerBlock = baseCompose.match(
    /\n  worker:\n(?<body>[\s\S]*?)\nvolumes:\n/,
  )?.groups?.body;
  assert.ok(appBlock);
  assert.ok(workerBlock);

  assert.match(
    appBlock,
    /LEAVE_COMMAND_DATABASE_URL: postgresql:\/\/mnt_leave_cmd:/,
  );
  assert.match(
    appBlock,
    /ONTOLOGY_COMMAND_DATABASE_URL: postgresql:\/\/mnt_ontology_cmd:/,
  );
  assert.match(
    baseCompose,
    /x-app-env:[\s\S]*?DATABASE_URL: postgresql:\/\/mnt_rt:/,
  );
  assert.doesNotMatch(workerBlock, /(?:LEAVE|ONTOLOGY)_COMMAND_DATABASE_URL/);
  assert.doesNotMatch(
    `${appBlock}\n${workerBlock}`,
    /mnt_app:|MNT_POSTGRES_ADMIN/,
  );
  assert.match(
    baseCompose,
    /POSTGRES_USER: \$\{MNT_POSTGRES_ADMIN_USER:-mnt_cluster_admin\}/,
  );
  assert.match(
    baseCompose,
    /migrate:[\s\S]*?DATABASE_URL: postgresql:\/\/mnt_app:/,
  );
  assert.match(
    baseCompose,
    /migrate:[\s\S]*?postgres-topology:[\s\S]*?service_completed_successfully/,
  );
  assert.match(
    baseCompose,
    /MNT_LEAVE_COMMAND_POSTGRES_PASSWORD:\s+\$\{[^}]+:\?/,
  );
  assert.match(
    baseCompose,
    /MNT_ONTOLOGY_COMMAND_POSTGRES_PASSWORD:\s+\$\{[^}]+:\?/,
  );
  assert.match(baseCompose, /postgres-socket:\/var\/run\/postgresql/);
});

test("fresh and existing databases reconcile the exact hardened six-role topology", () => {
  for (const role of [
    "mnt_app",
    "mnt_rt",
    "mnt_leave_cmd",
    "mnt_ontology_cmd",
  ]) {
    assert.match(commandRoleInit, new RegExp(`CREATE ROLE ${role} LOGIN`));
    assert.match(commandRoleInit, new RegExp(`ALTER ROLE ${role} LOGIN`));
  }
  for (const role of ["mnt_leave_definer", "mnt_ontology_writer"]) {
    assert.match(commandRoleInit, new RegExp(`CREATE ROLE ${role} NOLOGIN`));
    assert.match(commandRoleInit, new RegExp(`ALTER ROLE ${role} NOLOGIN`));
  }
  assert.match(
    commandRoleInit,
    /CREATE ROLE mnt_app LOGIN NOSUPERUSER BYPASSRLS INHERIT/,
  );
  assert.match(
    commandRoleInit,
    /ALTER ROLE mnt_app LOGIN NOSUPERUSER BYPASSRLS INHERIT/,
  );
  assert.match(
    commandRoleInit,
    /NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE/,
  );
  assert.match(commandRoleInit, /WITH ADMIN FALSE, INHERIT TRUE, SET TRUE/);
  assert.match(commandRoleInit, /topology\.legacy_mnt_app_superuser_refused/);
  assert.match(commandRoleInit, /topology\.legacy_identity_refused/);
  assert.match(commandRoleInit, /POSTGRES_LOCAL_SOCKET_DIR/);
  assert.match(commandRoleInit, /passwords must be pairwise distinct/);
  assert.match(commandRoleInit, /\\getenv leave_password/);
  assert.match(commandRoleInit, /\\getenv ontology_password/);
  assert.ok(
    commandRoleInit.indexOf("SET LOCAL log_statement = 'none'") <
      commandRoleInit.indexOf("\\getenv app_password"),
    "server logging must be disabled before psql expands a role password",
  );
  assert.match(commandRoleInit, /SET LOCAL log_min_error_statement = 'panic'/);
  assert.match(commandRoleInit, /OR granted\.rolname IN/);
  for (const role of ["mnt_rt", "mnt_leave_cmd", "mnt_ontology_cmd"]) {
    assert.match(
      commandRoleInit,
      new RegExp(`ALTER ROLE ${role} SET statement_timeout = '30s'`),
    );
    assert.match(
      commandRoleInit,
      new RegExp(
        `ALTER ROLE ${role} SET idle_in_transaction_session_timeout = '30s'`,
      ),
    );
    assert.match(
      commandRoleInit,
      new RegExp(`ALTER ROLE ${role} SET transaction_timeout = '45s'`),
    );
  }
  assert.match(
    commandRoleInit,
    /ALTER ROLE %I IN DATABASE %I RESET statement_timeout/,
  );
  assert.match(
    commandRoleInit,
    /ALTER ROLE %I IN DATABASE %I RESET idle_in_transaction_session_timeout/,
  );
  assert.match(
    commandRoleInit,
    /ALTER ROLE %I IN DATABASE %I RESET transaction_timeout/,
  );
  assert.match(commandRoleInit, /topology\.runtime_default_readback_failed/);
  assert.match(commandRoleInit, /topology\.transaction_timeout_prerequisite_failed/);
  assert.match(commandRoleInit, /pg_prepared_xacts/);
  assert.match(commandRoleInit, /pg_terminate_backend/);
  assert.match(commandRoleInit, /pg_terminate_backend\(\$\{pid\}, 5000\)/);
  assert.match(commandRoleInit, /serving_backend_pid_output="\$\(psql/);
  assert.doesNotMatch(commandRoleInit, /mapfile -t serving_backend_pids < <\(/);
  assert.match(commandRoleInit, /serving_backend_drain_barrier_failed/);
  assert.match(
    commandRoleInit,
    /legacy_default_acl_state[\s\S]*ALTER DEFAULT PRIVILEGES FOR ROLE mnt_app IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mnt_rt/,
  );
  assert.match(
    commandRoleInit,
    /topology\.legacy_default_acl_preflight_noncanonical/,
  );
  assert.match(commandRoleInit, /topology\.legacy_default_acl_noncanonical/);
  assert.match(
    commandRoleInit,
    /ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE/,
  );

  const topologyIntegration = readFileSync(
    new URL("../ops/postgres-topology.integration.test.sh", import.meta.url),
    "utf8",
  );
  assert.match(topologyIntegration, /query_as_direct_login mnt_app/);
  assert.match(topologyIntegration, /pg_database_owner/);
  assert.match(topologyIntegration, /session_user,current_user/);
  for (const role of ["mnt_rt", "mnt_leave_cmd", "mnt_ontology_cmd"]) {
    assert.match(topologyIntegration, new RegExp(`\\"${role}\\|`));
  }
  assert.match(
    topologyIntegration,
    /runtime password authenticated the leave command login/,
  );
  assert.match(topologyIntegration, /default_transaction_isolation/);
  assert.match(topologyIntegration, /preserve_database_runtime_guc/);
  assert.match(topologyIntegration, /current_setting\('statement_timeout'\)/);
  assert.match(topologyIntegration, /0112_mnt_rt_statement_timeout\.sql/);
  assert.match(topologyIntegration, /topology_stale_\$\{role\}/);
  assert.match(topologyIntegration, /cnpg_preflight_survivor/);
  assert.match(topologyIntegration, /postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777/);
  assert.match(topologyIntegration, /max_prepared_transactions=10/);

  assert.equal(
    devUp.match(/reconcileDatabaseTopology\(compose\);/g)?.length,
    2,
    "both dev:up and dev:bootstrap must reconcile topology before migrations",
  );
  assert.match(
    devUp,
    /function reconcileDatabaseTopology\(compose\)[\s\S]*?MNT_POSTGRES_PORT: String\(PORTS\.postgres\)/,
    "topology reconciliation must preserve the published PostgreSQL port used to start the dependency stack",
  );
  assert.match(
    devUp,
    /DATABASE_URL: role === "migrate" \? databaseUrl\(\) : runtimeDatabaseUrl\(\)/,
  );
  assert.match(devUp, /LEAVE_COMMAND_DATABASE_URL: commandDatabaseUrl/);
  assert.match(devUp, /ONTOLOGY_COMMAND_DATABASE_URL: commandDatabaseUrl/);
});

test("quickstart supplies all five distinct login passwords and Compose accepts it", (t) => {
  for (const variable of [
    "MNT_POSTGRES_ADMIN_PASSWORD",
    "MNT_APP_POSTGRES_PASSWORD",
    "MNT_RT_POSTGRES_PASSWORD",
    "MNT_LEAVE_COMMAND_POSTGRES_PASSWORD",
    "MNT_ONTOLOGY_COMMAND_POSTGRES_PASSWORD",
  ]) {
    assert.match(
      opsReadme,
      new RegExp(`export ${variable}=\"\\$\\(openssl rand -hex 32\\)\"`),
    );
  }
  assert.match(opsReadme, /docker compose -f ops\/compose\.yml config --quiet/);

  const candidates = [
    ["docker", ["compose"]],
    ["docker-compose", []],
  ];
  const compose = candidates.find(
    ([bin, prefix]) =>
      spawnSync(bin, [...prefix, "version"], { stdio: "ignore" }).status === 0,
  );
  if (!compose) {
    t.skip("docker compose is unavailable");
    return;
  }
  const [bin, prefix] = compose;
  const result = spawnSync(
    bin,
    [...prefix, "-f", "ops/compose.yml", "config", "--quiet"],
    {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        MNT_POSTGRES_ADMIN_PASSWORD: "admin-quickstart",
        MNT_APP_POSTGRES_PASSWORD: "app-quickstart",
        MNT_RT_POSTGRES_PASSWORD: "runtime-quickstart",
        MNT_LEAVE_COMMAND_POSTGRES_PASSWORD: "leave-quickstart",
        MNT_ONTOLOGY_COMMAND_POSTGRES_PASSWORD: "ontology-quickstart",
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("documented runtime URI uses its generated URL-safe password consistently", () => {
  assert.match(secretsDoc, /RT_PASSWORD="\$\(openssl rand -hex 32\)"/);
  assert.match(secretsDoc, /RT_URI="postgresql:\/\/mnt_rt:\$\{RT_PASSWORD\}@/);
  assert.doesNotMatch(secretsDoc, /RT_URI="postgresql:\/\/mnt_rt:\*\*\*@/);
});

test("e2e database harness never prints or passes the owner password on a psql command line", () => {
  assert.doesNotMatch(e2eDb, /echo[^\n]*DATABASE_URL/);
  assert.doesNotMatch(e2eDb, /psql\s+"\$\{DATABASE_URL\}"/);
  assert.match(e2eDb, /password redacted/);
  assert.match(e2eDb, /PGPASSWORD="\$\{MNT_APP_POSTGRES_PASSWORD\}" psql/);
});

test("dev seed uses the audited runtime compatibility boundary for ontology definitions", () => {
  const runSeed = devUp.match(
    /function runSeed\(compose\) \{(?<body>[\s\S]*?)\n\}/,
  )?.groups?.body;
  assert.ok(runSeed);
  assert.match(
    runSeed,
    /"-U",\s*POSTGRES_ADMIN_USER/,
    "the local-only BYPASSRLS seed must match its documented cluster-admin executor",
  );

  assert.doesNotMatch(
    devSeed,
    /INSERT INTO ont_object_type_key_revisions/,
    "the migration-0165 legacy trigger, not fixture SQL, must own key reservations",
  );

  const objectTypeInsert = devSeed.indexOf("INSERT INTO ont_object_types");
  const firstRuntimeBoundary = devSeed.indexOf("SET LOCAL ROLE mnt_rt");
  const protectedAuditInsert = devSeed.indexOf(
    "INSERT INTO audit_events (actor, action, target_type, target_id",
  );
  const finalRuntimeBoundary = devSeed.lastIndexOf(
    "SET LOCAL ROLE mnt_rt",
    protectedAuditInsert,
  );
  const finalReset = devSeed.indexOf("RESET ROLE", protectedAuditInsert);

  assert.ok(firstRuntimeBoundary >= 0);
  assert.ok(firstRuntimeBoundary < objectTypeInsert);
  assert.ok(finalRuntimeBoundary >= firstRuntimeBoundary);
  assert.ok(protectedAuditInsert > finalRuntimeBoundary);
  assert.ok(finalReset > protectedAuditInsert);
  assert.match(
    devSeed.slice(protectedAuditInsert, finalReset),
    /o\.xmin = pg_current_xact_id\(\)::xid/,
    "idempotent retries must audit only parents created by the current transaction",
  );
});
