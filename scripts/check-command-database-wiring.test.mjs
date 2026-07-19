#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("database-backed CI and release probes reconcile, migrate, and serve with separate identities", () => {
  for (const path of [".github/workflows/ci.yml", ".github/workflows/image-release.yml"]) {
    const source = read(path);
    assert.match(source, /postgres-reconcile-topology\.sh/);
    assert.match(source, /mnt_app:\$\{?(?:APP_PASSWORD|PROBE_OWNER)/);
    assert.match(source, /mnt_rt:\$\{?(?:RT_PASSWORD|PROBE_RUNTIME)/);
    assert.doesNotMatch(source, /MNT_APP_ROLE=migrate[^\n]*DATABASE_URL="postgres:\/\/postgres:/);
  }
});

test("contract and browser harnesses never alias command URLs to DATABASE_URL", () => {
  const contract = read("scripts/contract-roundtrip.ts");
  assert.match(contract, /provisionDatabaseTopology\(db, databaseUrl\)/);
  assert.match(contract, /DATABASE_URL: topology\.runtimeDatabaseUrl/);
  assert.match(contract, /LEAVE_COMMAND_DATABASE_URL: topology\.leaveCommandDatabaseUrl/);
  assert.match(contract, /ONTOLOGY_COMMAND_DATABASE_URL: topology\.ontologyCommandDatabaseUrl/);

  const e2e = read("e2e/harness/boot-backend.sh");
  assert.match(e2e, /DATABASE_URL="postgres:\/\/mnt_rt:/);
  assert.match(e2e, /LEAVE_COMMAND_DATABASE_URL="postgres:\/\/mnt_leave_cmd:/);
  assert.match(e2e, /ONTOLOGY_COMMAND_DATABASE_URL="postgres:\/\/mnt_ontology_cmd:/);
  assert.doesNotMatch(e2e, /(?:LEAVE|ONTOLOGY)_COMMAND_DATABASE_URL="\$\{DATABASE_URL\}"/);
});

test("CNPG reconciliation precedes Sync-wave migration and serving workloads", () => {
  const database = read("deploy/apps/maintenance/base/database.yaml");
  const topology = read("deploy/apps/maintenance/base/database-topology-job.yaml");
  const migrate = read("deploy/apps/maintenance/base/migrate-job.yaml");
  const backend = read("deploy/apps/maintenance/base/backend.yaml");
  const worker = read("deploy/apps/maintenance/base/worker.yaml");

  const managedNames = [...database.matchAll(/^\s+- name: (mnt_[a-z_]+)$/gm)].map((m) => m[1]);
  assert.deepEqual(managedNames, [
    "mnt_app", "mnt_rt", "mnt_leave_cmd", "mnt_ontology_cmd",
    "mnt_leave_definer", "mnt_ontology_writer",
  ]);
  assert.match(database, /name: mnt_app[\s\S]*?inRoles: \[mnt_leave_definer, mnt_ontology_writer\]/);
  assert.match(database, /name: mnt_app[\s\S]*?bypassrls: true/);
  assert.match(database, /enableSuperuserAccess: false/);
  for (const role of ["mnt_rt", "mnt_leave_cmd", "mnt_ontology_cmd", "mnt_leave_definer", "mnt_ontology_writer"]) {
    assert.match(database, new RegExp(`name: ${role}[\\s\\S]*?bypassrls: false`));
  }
  assert.match(topology, /expected_roles='mnt_app\|t\|f\|t\|t\|f\|f\|f/);
  assert.match(topology, /argocd\.argoproj\.io\/hook: Sync/);
  assert.match(topology, /argocd\.argoproj\.io\/sync-wave: "1"/);
  assert.match(topology, /membership\.admin_option/);
  assert.match(topology, /membership\.inherit_option/);
  assert.match(topology, /membership\.set_option/);
  assert.match(topology, /OR granted\.rolname IN/);
  assert.match(topology, /secretKeyRef: \{ name: mnt-db-app, key: username \}/);
  assert.doesNotMatch(topology, /mnt-db-superuser/);
  assert.match(migrate, /argocd\.argoproj\.io\/hook: Sync/);
  assert.match(migrate, /argocd\.argoproj\.io\/sync-wave: "2"/);
  assert.doesNotMatch(migrate, /argocd\.argoproj\.io\/hook: PreSync/);
  assert.match(backend, /argocd\.argoproj\.io\/sync-wave: "3"/);
  assert.match(worker, /argocd\.argoproj\.io\/sync-wave: "3"/);
});

test("authoritative operations docs forbid selective sync and recover both command credentials", () => {
  const deployReadme = read("deploy/README.md");
  const runbook = read("deploy/OPS-RUNBOOK.md");
  const cutover = read("ops/launch/multi-tenant-cutover-runbook.md");
  const vault = read("deploy/apps/secrets-management/README.md");

  for (const source of [deployReadme, runbook, cutover]) {
    assert.match(source, /(?:No selective sync|Never\s+selectively sync|Do not selectively sync)/i);
  }
  for (const source of [cutover, vault]) {
    assert.match(source, /mnt(?:[_-]db)?[_-]leave[_-](?:cmd|command)/);
    assert.match(source, /mnt(?:[_-]db)?[_-]ontology[_-](?:cmd|command)/);
  }

  const rebuildPrerequisites = runbook.match(
    /## 5\. The GitOps server[\s\S]*?(?=\n## 6\.)/,
  )?.[0];
  assert.ok(rebuildPrerequisites, "OPS runbook must retain a scoped GitOps rebuild section");
  for (const secret of [
    "mnt-db-rt",
    "mnt-db-leave-command",
    "mnt-db-ontology-command",
  ]) {
    assert.match(rebuildPrerequisites, new RegExp(secret));
  }
});

test("CNPG password projections use basic-auth Secrets with immediate reload metadata", () => {
  for (const path of [
    "deploy/apps/secrets-management/wiring/externalsecret-mnt-db-rt.yaml",
    "deploy/apps/secrets-management/wiring/externalsecret-mnt-db-leave-command.yaml",
    "deploy/apps/secrets-management/wiring/externalsecret-mnt-db-ontology-command.yaml",
  ]) {
    const source = read(path);
    assert.match(source, /type: kubernetes\.io\/basic-auth/);
    assert.match(source, /cnpg\.io\/reload: "true"/);
  }
});
