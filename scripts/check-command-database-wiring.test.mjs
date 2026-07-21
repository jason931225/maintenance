#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

const run = (command, args) =>
  spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const render = (overlay) => {
  const result = run("kubectl", ["kustomize", overlay]);
  assert.equal(
    result.status,
    0,
    `kubectl kustomize ${overlay} failed:\n${result.stderr}`,
  );
  return result.stdout;
};

test("database-backed CI and release probes reconcile, migrate, and serve with separate identities", () => {
  for (const path of [
    ".github/workflows/ci.yml",
    ".github/workflows/image-release.yml",
  ]) {
    const source = read(path);
    assert.match(source, /postgres-reconcile-topology\.sh/);
    assert.match(source, /mnt_app:\$\{?(?:APP_PASSWORD|PROBE_OWNER)/);
    assert.match(source, /mnt_rt:\$\{?(?:RT_PASSWORD|PROBE_RUNTIME)/);
    assert.doesNotMatch(
      source,
      /MNT_APP_ROLE=migrate[^\n]*DATABASE_URL="postgres:\/\/postgres:/,
    );
  }
});

test("contract and browser harnesses never alias command URLs to DATABASE_URL", () => {
  const contract = read("scripts/contract-roundtrip.ts");
  assert.match(contract, /provisionDatabaseTopology\(db, databaseUrl\)/);
  assert.match(contract, /DATABASE_URL: topology\.runtimeDatabaseUrl/);
  assert.match(
    contract,
    /LEAVE_COMMAND_DATABASE_URL: topology\.leaveCommandDatabaseUrl/,
  );
  assert.match(
    contract,
    /ONTOLOGY_COMMAND_DATABASE_URL: topology\.ontologyCommandDatabaseUrl/,
  );
  assert.match(contract, /format\([\s\S]*?\$1::text, \$2::text\)/);
  assert.match(
    contract,
    /ALTER ROLE %I SET transaction_timeout = ''45s''/,
  );
  assert.match(
    contract,
    /ALTER ROLE %I IN DATABASE %I RESET %I/,
  );
  assert.match(contract, /current_setting\('transaction_timeout'\)/);

  const e2e = read("e2e/harness/boot-backend.sh");
  assert.match(e2e, /DATABASE_URL="postgres:\/\/mnt_rt:/);
  assert.match(e2e, /LEAVE_COMMAND_DATABASE_URL="postgres:\/\/mnt_leave_cmd:/);
  assert.match(
    e2e,
    /ONTOLOGY_COMMAND_DATABASE_URL="postgres:\/\/mnt_ontology_cmd:/,
  );
  assert.doesNotMatch(
    e2e,
    /(?:LEAVE|ONTOLOGY)_COMMAND_DATABASE_URL="\$\{DATABASE_URL\}"/,
  );
});

test("append-only migration 0167 declares serving-role bounds and nonclaims", () => {
  const path =
    "backend/crates/platform/db/migrations/0167_serving_role_transaction_timeouts.sql";
  assert.ok(existsSync(new URL(path, root)), `${path} must exist`);
  const migration = read(path);
  for (const role of ["mnt_rt", "mnt_leave_cmd", "mnt_ontology_cmd"]) {
    assert.match(migration, new RegExp(`'${role}'`));
  }
  assert.match(migration, /ALTER ROLE %I SET statement_timeout/);
  assert.match(migration, /ALTER ROLE %I SET idle_in_transaction_session_timeout/);
  assert.match(migration, /ALTER ROLE %I SET transaction_timeout/);
  assert.match(migration, /statement_timeout=30s/);
  assert.match(migration, /idle_in_transaction_session_timeout=30s/);
  assert.match(migration, /transaction_timeout=45s/);
  assert.match(migration, /owner[\s\S]*outside this reconciliation and[\s\S]*startup correctness backstop/);
  assert.match(migration, /quiescence\/coordination[\s\S]*xmin\/snapshot watermark/);
});

test("live Argo, base, prod, and secret wiring remain DARK-topology-free", () => {
  const argo = read("deploy/argocd/apps/maintenance.yaml");
  const prod = read("deploy/apps/maintenance/overlays/prod/kustomization.yaml");
  const base = read("deploy/apps/maintenance/base/kustomization.yaml");
  const database = read("deploy/apps/maintenance/base/database.yaml");
  const backend = read("deploy/apps/maintenance/base/backend.yaml");
  const secrets = read(
    "deploy/apps/secrets-management/wiring/kustomization.yaml",
  );

  assert.match(argo, /path: deploy\/apps\/maintenance\/overlays\/prod/);
  assert.match(argo, /targetRevision: main/);
  assert.match(prod, /resources:\s*\n\s+- \.\.\/\.\.\/base/);
  assert.doesNotMatch(prod, /components:|pr-473|governed-command-database/);
  assert.doesNotMatch(base, /database-topology-job|governed-command-database/);

  for (const source of [argo, prod, base, database, backend, secrets]) {
    assert.doesNotMatch(source, /pr-473-expand|governed-command-database/);
    assert.doesNotMatch(source, /mnt-db-(?:leave|ontology)-command/);
    assert.doesNotMatch(
      source,
      /(?:LEAVE|ONTOLOGY)_COMMAND_DATABASE_URL|mnt_(?:leave|ontology)_(?:cmd|definer|writer)/,
    );
  }

  const mainRef = run("git", ["rev-parse", "--verify", "origin/main^{commit}"]);
  assert.equal(
    mainRef.status,
    0,
    `origin/main is mandatory for the live GitOps identity gate:\n${mainRef.stderr}`,
  );
  const diff = run("git", [
    "diff",
    "--exit-code",
    "origin/main",
    "--",
    "deploy/argocd/apps/maintenance.yaml",
    "deploy/apps/maintenance/base",
    "deploy/apps/maintenance/overlays/prod",
    "deploy/apps/secrets-management/wiring",
  ]);
  assert.equal(
    diff.status,
    0,
    `live GitOps inputs differ from origin/main:\n${diff.stdout}${diff.stderr}`,
  );
});

test("DARK overlays opt into the portable governed command-database component", () => {
  const cases = [
    ["pr-473-expand-oci-guest", "../prod"],
    ["pr-473-expand-on-prem", "../on-prem"],
  ];

  for (const [overlay, base] of cases) {
    const source = read(
      `deploy/apps/maintenance/overlays/${overlay}/kustomization.yaml`,
    );
    assert.match(
      source,
      new RegExp(`resources:\\s*\\n\\s+- ${base.replaceAll(".", "\\.")}`),
    );
    assert.match(
      source,
      /components:\s*\n\s+- \.\.\/\.\.\/components\/governed-command-database/,
    );
  }
});

test("governed command-database component declares six roles, topology readback, ordering, and bounded Job networking", () => {
  const component = read(
    "deploy/apps/maintenance/components/governed-command-database/kustomization.yaml",
  );
  const topology = read(
    "deploy/apps/maintenance/components/governed-command-database/database-topology-job.yaml",
  );

  const managedNames = [
    ...component.matchAll(/^\s+- name: (mnt_[a-z_]+)$/gm),
  ].map((match) => match[1]);
  assert.deepEqual(managedNames, [
    "mnt_app",
    "mnt_rt",
    "mnt_leave_cmd",
    "mnt_ontology_cmd",
    "mnt_leave_definer",
    "mnt_ontology_writer",
  ]);
  assert.match(
    component,
    /name: mnt_app[\s\S]*?inRoles: \[mnt_leave_definer, mnt_ontology_writer\]/,
  );
  assert.match(component, /name: mnt_app[\s\S]*?bypassrls: true/);
  for (const role of managedNames.slice(1)) {
    assert.match(
      component,
      new RegExp(`name: ${role}[\\s\\S]*?bypassrls: false`),
    );
  }

  assert.match(component, /database-topology-job\.yaml/);
  assert.match(
    component,
    /path: \/spec\/enableSuperuserAccess[\s\S]*?value: false/,
  );
  assert.match(
    component,
    /path: \/spec\/postgresql\/parameters\/max_prepared_transactions[\s\S]*?value: "0"/,
  );
  assert.match(
    component,
    /name: mnt_app[\s\S]*?passwordSecret:\s*\n\s+name: mnt-db-app/,
  );
  assert.match(component, /name: LEAVE_COMMAND_DATABASE_URL/);
  assert.match(component, /name: ONTOLOGY_COMMAND_DATABASE_URL/);
  assert.match(component, /name: mnt-migrate[\s\S]*?value: Sync/);
  assert.match(
    component,
    /name: mnt-migrate[\s\S]*?sync-wave[\s\S]*?value: "2"/,
  );
  assert.match(
    component,
    /kind: Rollout, name: mnt-app[\s\S]*?argocd\.argoproj\.io\/sync-wave: "3"/,
  );
  assert.match(
    component,
    /kind: Deployment, name: mnt-worker[\s\S]*?argocd\.argoproj\.io\/sync-wave: "3"/,
  );
  for (const policy of [
    "allow-postgres-from-app",
    "default-deny-egress-app-tier",
    "allow-app-egress-dns",
    "allow-app-egress-postgres",
  ]) {
    assert.match(
      component,
      new RegExp(
        `kind: NetworkPolicy, name: ${policy}[\\s\\S]*?mnt-db-topology`,
      ),
    );
  }

  assert.match(topology, /expected_roles='mnt_app\|t\|f\|t\|t\|f\|f\|f/);
  assert.match(topology, /argocd\.argoproj\.io\/hook: Sync/);
  assert.match(topology, /argocd\.argoproj\.io\/sync-wave: "1"/);
  assert.match(topology, /membership\.admin_option/);
  assert.match(topology, /membership\.inherit_option/);
  assert.match(topology, /membership\.set_option/);
  assert.match(topology, /OR granted\.rolname IN/);
  assert.match(topology, /test "\$\{PGUSER\}" = mnt_app/);
  assert.match(topology, /secretKeyRef: \{ name: mnt-db-app, key: username \}/);
  assert.match(
    topology,
    /PGUSER="\$\{role\}" PGPASSWORD="\$\{password\}" psql[\s\S]*?BEGIN;[\s\S]*?ALTER ROLE %I SET statement_timeout[\s\S]*?ALTER ROLE %I SET idle_in_transaction_session_timeout[\s\S]*?ALTER ROLE %I SET transaction_timeout[\s\S]*?ALTER ROLE %I IN DATABASE %I RESET statement_timeout[\s\S]*?ALTER ROLE %I IN DATABASE %I RESET idle_in_transaction_session_timeout[\s\S]*?ALTER ROLE %I IN DATABASE %I RESET transaction_timeout[\s\S]*?COMMIT;/,
  );
  for (const [role, password] of [
    ["mnt_rt", "MNT_RT_PASSWORD"],
    ["mnt_leave_cmd", "MNT_LEAVE_COMMAND_PASSWORD"],
    ["mnt_ontology_cmd", "MNT_ONTOLOGY_COMMAND_PASSWORD"],
  ]) {
    assert.match(
      topology,
      new RegExp(
        `reconcile_serving_defaults ${role} "\\$\\{${password}\\}"`,
      ),
    );
    assert.match(
      topology,
      new RegExp(
        `assert_direct_serving_login ${role} "\\$\\{${password}\\}" '30s\\|30s\\|45s'`,
      ),
    );
  }
  assert.match(topology, /current_setting\('server_version_num'\)/);
  assert.match(topology, /current_setting\('max_prepared_transactions'\)/);
  assert.match(topology, /pg_prepared_xacts/);
  assert.match(topology, /pg_terminate_backend/);
  assert.match(topology, /pg_terminate_backend\(\$\{pid\}, 5000\)/);
  assert.match(topology, /captured_pid_output="\$\(PGOPTIONS=/);
  assert.doesNotMatch(topology, /mapfile -t captured_pids < <\(/);
  assert.match(topology, /pid = ANY \(ARRAY\[\$\{captured_pid_csv\}\]::integer\[\]\)/);
  assert.match(topology, /repair_pgoptions='-c statement_timeout=0 -c idle_in_transaction_session_timeout=0 -c transaction_timeout=0'/);
  assert.match(topology, /serving_defaults_need_repair\(\)/);
  assert.match(topology, /repair_mnt_rt="\$\(serving_defaults_need_repair mnt_rt/);
  assert.match(topology, /if \[\[ "\$\{repair_mnt_rt\}" == true \]\]; then[\s\S]*?reconcile_serving_defaults mnt_rt/);
  assert.match(topology, /if \[\[ "\$\{repair_mnt_rt\}" == true \]\]; then[\s\S]*?drain_serving_backends mnt_rt/);
  const preflightEnd = topology.indexOf(
    'preflight_serving_login mnt_ontology_cmd "${MNT_ONTOLOGY_COMMAND_PASSWORD}"',
  );
  const mutationStart = topology.indexOf(
    'reconcile_serving_defaults mnt_rt "${MNT_RT_PASSWORD}"',
  );
  const repairClassification = topology.indexOf(
    'repair_mnt_rt="$(serving_defaults_need_repair mnt_rt',
  );
  const mutationEnd = topology.indexOf(
    'reconcile_serving_defaults mnt_ontology_cmd "${MNT_ONTOLOGY_COMMAND_PASSWORD}"',
  );
  const drainStart = topology.indexOf(
    'drain_serving_backends mnt_rt "${MNT_RT_PASSWORD}"',
  );
  const freshReadback = topology.indexOf(
    'assert_direct_serving_login mnt_rt "${MNT_RT_PASSWORD}"',
  );
  assert.ok(preflightEnd > 0 && preflightEnd < repairClassification);
  assert.ok(repairClassification < mutationStart);
  assert.ok(mutationEnd < drainStart && drainStart < freshReadback);
  assert.match(
    topology,
    /passwords=\([\s\S]*?\$\{PGPASSWORD\}[\s\S]*?\$\{MNT_RT_PASSWORD\}[\s\S]*?\$\{MNT_LEAVE_COMMAND_PASSWORD\}[\s\S]*?\$\{MNT_ONTOLOGY_COMMAND_PASSWORD\}[\s\S]*?\)/,
  );
  assert.match(
    topology,
    /for \(\(i = 0; i < \$\{#passwords\[@\]\}; i\+\+\)\); do[\s\S]*?test -n "\$\{passwords\[i\]\}"[\s\S]*?for \(\(j = i \+ 1; j < \$\{#passwords\[@\]\}; j\+\+\)\); do[\s\S]*?test "\$\{passwords\[i\]\}" != "\$\{passwords\[j\]\}"/,
  );
  assert.match(
    topology,
    /SELECT session_user::text \|\| '\|' \|\| current_user::text"\)" = 'mnt_app\|mnt_app'/,
  );
  assert.match(
    topology,
    /expected_memberships='mnt_app\|mnt_leave_definer\|f\|t\|t\s+mnt_app\|mnt_ontology_writer\|f\|t\|t'/,
  );
  assert.match(
    topology,
    /test "\$\{actual_memberships\}" = "\$\{expected_memberships\}"/,
  );
  assert.match(
    topology,
    /membership\.member = authenticated\.oid\s+OR membership\.roleid = authenticated\.oid/,
  );
  assert.match(
    topology,
    /test "\$\{actual\}" = "\$\{role\}\|\$\{role\}\|t\|f\|f\|f\|f\|f\|f\|f\|\$\{expected_defaults\}"/,
  );
  for (const [secret, role] of [
    ["mnt-db-rt", "mnt_rt"],
    ["mnt-db-leave-command", "mnt_leave_cmd"],
    ["mnt-db-ontology-command", "mnt_ontology_cmd"],
  ]) {
    assert.match(topology, new RegExp(`name: ${secret}, key: username`));
    assert.match(topology, new RegExp(`assert_direct_serving_login ${role}`));
  }
  assert.doesNotMatch(topology, /mnt-db-superuser/);
  assert.match(component, /enableSuperuserAccess[\s\S]*?value: false/);
  assert.equal(
    component.match(/maintenance\.oyatie\.com\/database-role-defaults: "0167"/g)
      ?.length,
    2,
  );
});

test("DARK OCI and self-host renders include the governed topology without changing live prod", () => {
  const kubectl = run("kubectl", ["version", "--client=true"]);
  assert.equal(
    kubectl.status,
    0,
    `kubectl with the pinned kustomize renderer is mandatory:\n${kubectl.stderr}`,
  );
  const prod = render("deploy/apps/maintenance/overlays/prod");
  assert.doesNotMatch(prod, /name: mnt-db-topology/);
  assert.doesNotMatch(
    prod,
    /LEAVE_COMMAND_DATABASE_URL|ONTOLOGY_COMMAND_DATABASE_URL/,
  );

  for (const overlay of ["pr-473-expand-oci-guest", "pr-473-expand-on-prem"]) {
    const rendered = render(`deploy/apps/maintenance/overlays/${overlay}`);
    for (const role of [
      "mnt_app",
      "mnt_rt",
      "mnt_leave_cmd",
      "mnt_ontology_cmd",
      "mnt_leave_definer",
      "mnt_ontology_writer",
    ]) {
      assert.match(rendered, new RegExp(`name: ${role}`));
    }
    assert.match(
      rendered,
      /kind: Job\s+metadata:[\s\S]*?name: mnt-db-topology/,
    );
    assert.match(rendered, /name: LEAVE_COMMAND_DATABASE_URL/);
    assert.match(rendered, /name: ONTOLOGY_COMMAND_DATABASE_URL/);
    assert.match(rendered, /argocd\.argoproj\.io\/sync-wave: "?1"?/);
    assert.match(rendered, /argocd\.argoproj\.io\/sync-wave: "?2"?/);
    assert.match(rendered, /argocd\.argoproj\.io\/sync-wave: "?3"?/);
    assert.match(
      rendered,
      /kind: NetworkPolicy[\s\S]*?name: allow-postgres-from-app[\s\S]*?mnt-db-topology/,
    );
    assert.match(
      rendered,
      /kind: NetworkPolicy[\s\S]*?name: allow-app-egress-postgres[\s\S]*?mnt-db-topology/,
    );
  }
});

test("DARK operating contract locks whole-Application activation, credentials, rotation, and capacity", () => {
  const databaseDocs = read(
    "deploy/apps/maintenance/components/governed-command-database/README.md",
  );
  const secretDocs = read(
    "deploy/apps/secrets-management/components/governed-command-database/README.md",
  );
  const ociDocs = read(
    "deploy/apps/maintenance/overlays/pr-473-expand-oci-guest/README.md",
  );
  const onPremDocs = read(
    "deploy/apps/maintenance/overlays/pr-473-expand-on-prem/README.md",
  );
  const docs = [databaseDocs, secretDocs, ociDocs, onPremDocs].join("\n");

  assert.match(
    databaseDocs,
    /Never selectively sync[\s\S]*?Sync the\s+whole maintenance Application/,
  );
  assert.match(
    secretDocs,
    /sync the complete maintenance Application[\s\S]*?Do not selectively sync/,
  );
  assert.match(docs, /32-byte hexadecimal/);
  assert.match(docs, /percent-encode/);
  assert.match(docs, /kubernetes\.io\/basic-auth/);
  assert.match(docs, /cnpg\.io\/reload=true/);
  assert.match(docs, /restart every consumer deliberately/i);
  assert.match(docs, /Wait for rollout\/deployment readiness/);
  assert.match(docs, /retired password is rejected/);
  assert.match(docs, /Do not claim zero-downtime rotation/);
  assert.match(
    databaseDocs,
    /pool at 6 connections and each API command pool at 2/,
  );
  assert.match(databaseDocs, /4 x \(6 \+ 2 \+ 2\) = 40/);
  assert.match(databaseDocs, /2 x 6 = 12/);
  assert.match(
    databaseDocs,
    /total serving demand is 52, leaving 8 connections/,
  );
  assert.match(databaseDocs, /PostgreSQL is configured for 60 connections/);
  assert.match(docs, /pairwise distinct/);
  assert.match(docs, /session_user = current_user/);
  assert.match(docs, /expected role and membership rows/);
});

test("DARK secrets component contains exactly two typed ExternalSecrets and live wiring does not reference it", () => {
  const componentPath =
    "deploy/apps/secrets-management/components/governed-command-database";
  const kustomization = read(`${componentPath}/kustomization.yaml`);
  const expectedFiles = [
    "externalsecret-mnt-db-leave-command.yaml",
    "externalsecret-mnt-db-ontology-command.yaml",
  ];

  const resources = [
    ...kustomization.matchAll(/^\s+- (externalsecret-[^\s]+\.yaml)$/gm),
  ].map((match) => match[1]);
  assert.deepEqual(resources, expectedFiles);

  for (const file of expectedFiles) {
    assert.ok(existsSync(new URL(`${componentPath}/${file}`, root)));
    const source = read(`${componentPath}/${file}`);
    assert.match(source, /apiVersion: external-secrets\.io\/v1/);
    assert.match(source, /kind: ExternalSecret/);
    assert.match(source, /type: kubernetes\.io\/basic-auth/);
    assert.match(source, /cnpg\.io\/reload: "true"/);
    for (const key of ["username", "password", "uri"]) {
      assert.match(source, new RegExp(`secretKey: ${key}`));
    }
  }

  const liveWiring = read(
    "deploy/apps/secrets-management/wiring/kustomization.yaml",
  );
  assert.doesNotMatch(liveWiring, /governed-command-database/);
  assert.doesNotMatch(
    liveWiring,
    /externalsecret-mnt-db-(?:leave|ontology)-command/,
  );
});
