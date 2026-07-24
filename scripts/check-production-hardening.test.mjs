import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import {
  evaluateAndroidE2eFailClosedChecks,
  evaluateAndroidE2eTokenHandoffChecks,
  evaluateCnpgContextChecks,
  evaluateDeployAutomationChecks,
  evaluateExpandContractReleaseChecks,
  evaluateOnPremHaContextChecks,
  evaluateProdOverlayImageChecks,
  evaluateSmtpDeploymentChecks,
  evaluateWorkflowHardeningChecks,
} from "./check-production-hardening.mjs";

describe("production authority blocked observation static integration", () => {
  it("requires the explicit-SHA evaluator package wiring and focused hardening suite inclusion", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    assert.equal(
      pkg.scripts["check:production-authority-blocked"],
      "node scripts/check-production-authority-blocked.mjs",
    );
    assert.match(
      pkg.scripts["test:production-hardening"],
      /scripts\/check-production-authority-blocked\.test\.mjs/,
    );
    assert.ok(
      existsSync(
        new URL("./check-production-authority-blocked.mjs", import.meta.url),
      ),
    );
  });
});

const validFiles = {
  "deploy/apps/maintenance/base/database.yaml": `apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: mnt-db
spec:
  instances: 1 # single oci-guest node
  env:
    - name: AWS_REQUEST_CHECKSUM_CALCULATION
      value: when_required
    - name: AWS_RESPONSE_CHECKSUM_VALIDATION
      value: when_required
  storage:
    size: 5Gi
`,
  "deploy/apps/maintenance/overlays/prod/kustomization.yaml": `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
images: []
`,
  "deploy/apps/maintenance/overlays/on-prem/kustomization.yaml": `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
patches:
  - target:
      group: postgresql.cnpg.io
      version: v1
      kind: Cluster
      name: mnt-db
    path: cnpg-ha-patch.yaml
  - target: { kind: ObjectStore, name: mnt-backups }
    patch: |-
      - op: replace
        path: /spec/configuration/endpointURL
        value: http://mnt-object-store-s3.maintenance-object-store.svc.cluster.local:8333
`,
  "deploy/apps/maintenance/overlays/on-prem/cnpg-ha-patch.yaml": `- op: remove
  path: /spec/env
- op: replace
  path: /spec/instances
  value: 3
- op: add
  path: /spec/storage/storageClass
  value: mnt-pg-hot
- op: add
  path: /spec/postgresql/synchronous
  value:
    failoverQuorum: true
- op: add
  path: /spec/topologySpreadConstraints
  value:
    - topologyKey: kubernetes.io/hostname
`,
  "deploy/apps/storage/manifests/storageclass-mnt-pg-hot.yaml": `apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: mnt-pg-hot
provisioner: driver.longhorn.io
parameters:
  numberOfReplicas: "3"
reclaimPolicy: Retain
volumeBindingMode: WaitForFirstConsumer
`,
};

function evaluate(overrides = {}) {
  const files = { ...validFiles, ...overrides };
  return evaluateCnpgContextChecks((path) => files[path] ?? "");
}

function assertHasFailure(result, fragment) {
  assert.ok(
    result.failures.some((failure) => failure.includes(fragment)),
    `expected failure containing ${JSON.stringify(fragment)}; got ${JSON.stringify(result.failures)}`,
  );
}

function replaceLast(text, needle, replacement) {
  const index = text.lastIndexOf(needle);
  return index < 0
    ? text
    : `${text.slice(0, index)}${replacement}${text.slice(index + needle.length)}`;
}

const smtpConfigMapWithRelayFields = `apiVersion: v1
kind: ConfigMap
metadata:
  name: mnt-config
data:
  MNT_EMAIL_SMTP_HOST: "smtp.email.ap-chuncheon-1.oci.oraclecloud.com"
  MNT_EMAIL_SMTP_PORT: "587"
  MNT_EMAIL_FROM: "no-reply@knllogistic.com"
  MNT_EMAIL_FROM_NAME: "MNT 정비 콘솔"
`;

const smtpConfigMapForDevE2eStub = `apiVersion: v1
kind: ConfigMap
metadata:
  name: mnt-config
data:
  MNT_HTTP_ADDR: "0.0.0.0:8080"
  MNT_EMAIL_STUB_MODE: "e2e"
  # MNT_EMAIL_* intentionally omitted: dev/e2e uses the explicit stub sender path.
`;

const smtpConfigMapWithoutRelayOrStub = `apiVersion: v1
kind: ConfigMap
metadata:
  name: mnt-config
data:
  MNT_HTTP_ADDR: "0.0.0.0:8080"
`;

const workloadWithEnvFromOnly = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: mnt-app
spec:
  template:
    spec:
      containers:
        - name: mnt-app
          envFrom:
            - configMapRef: { name: mnt-config }
            - secretRef: { name: mnt-secrets }
`;

const workloadWithRequiredSmtpSecretRefs = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: mnt-app
spec:
  template:
    spec:
      containers:
        - name: mnt-app
          envFrom:
            - configMapRef: { name: mnt-config }
            - secretRef: { name: mnt-secrets }
          env:
            - name: MNT_EMAIL_SMTP_USERNAME
              valueFrom:
                secretKeyRef: { name: mnt-secrets, key: MNT_EMAIL_SMTP_USERNAME }
            - name: MNT_EMAIL_SMTP_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: mnt-secrets
                  key: MNT_EMAIL_SMTP_PASSWORD
`;

function evaluateSmtp(overrides = {}) {
  const files = {
    "deploy/apps/maintenance/base/configmap.yaml": smtpConfigMapWithRelayFields,
    "deploy/apps/maintenance/base/backend.yaml": workloadWithEnvFromOnly,
    "deploy/apps/maintenance/base/worker.yaml": workloadWithEnvFromOnly,
    ...overrides,
  };
  return evaluateSmtpDeploymentChecks((path) => files[path] ?? "");
}

describe("production hardening SMTP deployment config", () => {
  it("rejects production-like SMTP non-secret fields without explicit required credential refs", () => {
    const result = evaluateSmtp();

    assertHasFailure(
      result,
      "deploy/apps/maintenance/base/backend.yaml must explicitly require MNT_EMAIL_SMTP_USERNAME",
    );
    assertHasFailure(
      result,
      "deploy/apps/maintenance/base/backend.yaml must explicitly require MNT_EMAIL_SMTP_PASSWORD",
    );
    assertHasFailure(
      result,
      "deploy/apps/maintenance/base/worker.yaml must explicitly require MNT_EMAIL_SMTP_USERNAME",
    );
  });

  it("accepts complete SMTP config with required secret-backed credentials", () => {
    const result = evaluateSmtp({
      "deploy/apps/maintenance/base/backend.yaml":
        workloadWithRequiredSmtpSecretRefs,
      "deploy/apps/maintenance/base/worker.yaml":
        workloadWithRequiredSmtpSecretRefs,
    });

    assert.deepEqual(result.failures, []);
    assert.match(
      result.passes.join("\n"),
      /SMTP production credential refs: mnt-app, mnt-worker/,
    );
  });

  it("does not block explicit dev/e2e stub configs that omit SMTP relay fields", () => {
    const result = evaluateSmtp({
      "deploy/apps/maintenance/base/configmap.yaml": smtpConfigMapForDevE2eStub,
    });

    assert.deepEqual(result.failures, []);
    assert.match(
      result.passes.join("\n"),
      /SMTP relay disabled for explicit stub mode MNT_EMAIL_STUB_MODE=e2e/,
    );
  });

  it("rejects no-relay production-like configs without explicit stub mode", () => {
    const result = evaluateSmtp({
      "deploy/apps/maintenance/base/configmap.yaml":
        smtpConfigMapWithoutRelayOrStub,
    });

    assertHasFailure(
      result,
      "must either configure non-secret MNT_EMAIL_* SMTP relay fields or set MNT_EMAIL_STUB_MODE",
    );
  });
});

describe("production hardening CNPG context checks", () => {
  it("accepts the oci-guest single-instance base and the on-prem HA overlay", () => {
    const result = evaluate();

    assert.deepEqual(result.failures, []);
    assert.match(result.passes.join("\n"), /oci-guest CNPG base instances: 1/);
    assert.match(result.passes.join("\n"), /on-prem-ha CNPG HA instances: 3/);
    assert.match(result.passes.join("\n"), /on-prem-ha storage replicas: 3/);
  });

  it("rejects an HA overlay with fewer than three CNPG instances", () => {
    const result = evaluate({
      "deploy/apps/maintenance/overlays/on-prem/cnpg-ha-patch.yaml": `- op: replace
  path: /spec/instances
  value: 2
- op: add
  path: /spec/storage/storageClass
  value: mnt-pg-hot
`,
    });

    assert.ok(
      result.failures.some((failure) =>
        failure.includes("on-prem-ha CNPG HA instances"),
      ),
    );
  });

  it("rejects an HA overlay that points CNPG at local-path storage", () => {
    const result = evaluate({
      "deploy/apps/maintenance/overlays/on-prem/cnpg-ha-patch.yaml": `- op: replace
  path: /spec/instances
  value: 3
- op: add
  path: /spec/storage/storageClass
  value: local-path
`,
    });

    assert.ok(
      result.failures.some((failure) =>
        failure.includes("must not use local-path"),
      ),
    );
  });

  it("rejects an on-prem overlay that inherits the OCI-only checksum workaround", () => {
    const result = evaluate({
      "deploy/apps/maintenance/overlays/on-prem/cnpg-ha-patch.yaml": `- op: replace
  path: /spec/instances
  value: 3
- op: add
  path: /spec/storage/storageClass
  value: mnt-pg-hot
`,
    });

    assert.ok(
      result.failures.some((failure) => failure.includes("checksum behavior")),
    );
  });

  it("rejects removing /spec/env when the base env contains non-checksum entries", () => {
    const result = evaluate({
      "deploy/apps/maintenance/base/database.yaml": validFiles[
        "deploy/apps/maintenance/base/database.yaml"
      ].replace(
        "  storage:",
        `    - name: MNT_REQUIRED_CLUSTER_SETTING
      value: keep
  storage:`,
      ),
    });

    assertHasFailure(result, "may remove /spec/env only while");
    assertHasFailure(result, "MNT_REQUIRED_CLUSTER_SETTING");
  });

  it("rejects an oci-guest prod overlay that patches the CNPG instance shape", () => {
    const result = evaluate({
      "deploy/apps/maintenance/overlays/prod/kustomization.yaml": `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
patches:
  - target: { kind: Cluster, name: mnt-db }
    patch: |-
      - op: replace
        path: /spec/instances
        value: 3
`,
    });

    assert.ok(
      result.failures.some((failure) =>
        failure.includes("oci-guest prod overlay CNPG shape"),
      ),
    );
  });

  it("keeps the oci-guest/base CNPG posture single-instance", () => {
    const result = evaluate({
      "deploy/apps/maintenance/base/database.yaml": `apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: mnt-db
spec:
  instances: 3
`,
    });

    assert.ok(
      result.failures.some((failure) =>
        failure.includes("oci-guest CNPG base instances"),
      ),
    );
  });
});

describe("production hardening on-prem authority identity", () => {
  it("rejects an on-prem runbook that does not explicitly identify ADR-0024", () => {
    const files = {
      "deploy/OPS-RUNBOOK-baremetal.md": "# On-prem bare-metal operations\n",
    };

    const result = evaluateOnPremHaContextChecks((path) => files[path] ?? "");

    assertHasFailure(result, "on-prem-ha runbook identity: explicit ADR-0024");
  });
});

function evaluateProdOverlay(text) {
  return evaluateProdOverlayImageChecks((path) =>
    path === "deploy/apps/maintenance/overlays/prod/kustomization.yaml"
      ? text
      : "",
  );
}

describe("production hardening global image checks", () => {
  it("accepts immutable digest pins without mutable tags", () => {
    const digestA = "a".repeat(64);
    const digestB = "b".repeat(64);
    const result = evaluateProdOverlay(`images:
  - name: mnt-app
    digest: sha256:${digestA}
  - name: mnt-web
    digest: sha256:${digestB}
`);

    assert.deepEqual(result.failures, []);
    assert.match(result.passes.join("\n"), /prod overlay digest pins: 2/);
  });

  it("rejects missing digest pins and mutable image tags", () => {
    const result = evaluateProdOverlay(`images:
  - name: mnt-app
    newTag: latest
`);

    assert.ok(
      result.failures.some((failure) =>
        failure.includes("must pin at least mnt-app and mnt-web"),
      ),
    );
    assert.ok(
      result.failures.some((failure) =>
        failure.includes("must not use mutable newTag values"),
      ),
    );
  });

  it("rejects digest pins and mutable tags that appear only in comments", () => {
    const digestA = "a".repeat(64);
    const digestB = "b".repeat(64);
    const result = evaluateProdOverlay(`images:
  # - name: mnt-app
  #   digest: sha256:${digestA}
  # - name: mnt-web
  #   digest: sha256:${digestB}
  # newTag: latest
`);

    assert.ok(
      result.failures.some((failure) =>
        failure.includes("must pin at least mnt-app and mnt-web"),
      ),
    );
    assert.deepEqual(
      result.failures.filter((failure) =>
        failure.includes("must not use mutable newTag values"),
      ),
      [],
    );
  });
});

const pr473ManifestText = readFileSync(
  new URL("../docs/release/PR-473-EXPAND-CONTRACT.gate.json", import.meta.url),
  "utf8",
);
const pr473Directives = `<!-- PR473-MIGRATION-GATE: release_phase=expand -->
<!-- PR473-MIGRATION-GATE: deployment_authorized=false -->
<!-- PR473-MIGRATION-GATE: command_only_claim_authorized=false -->
<!-- PR473-MIGRATION-GATE: production_authority=production_cardinality,old_runtime_drain,rollback_floor_raise -->`;
const validPr473Files = {
  "docs/release/PR-473-EXPAND-CONTRACT.gate.json": pr473ManifestText,
  "docs/release/PR-473-ONTOLOGY-EXPAND-CONTRACT.md": `# PR 473 Ontology Expand Contract\n\n${pr473Directives}\n\n`,
  "docs/release/PR-473-EMPLOYEE-IMPORT-EXPAND-CONTRACT.md": `# PR 473 Employee-Import Expand Contract\n\n${pr473Directives}\n\n`,
  "package.json": JSON.stringify({
    scripts: {
      "check:pr473-migration-operational":
        "python3 scripts/check-pr473-migration-operational.py",
      "test:pr473-migration-operational":
        "python3 scripts/check-pr473-migration-operational.test.py",
    },
  }),
  ".github/workflows/ci.yml": `jobs:
  backend:
    steps:
      - name: Reconcile portable PostgreSQL role topology
        run: |
          APP_PASSWORD="$(openssl rand -hex 32)"
          RT_PASSWORD="$(openssl rand -hex 32)"
          LEAVE_COMMAND_PASSWORD="$(openssl rand -hex 32)"
          ONTOLOGY_COMMAND_PASSWORD="$(openssl rand -hex 32)"
          docker run --rm --network host \
            -v "$GITHUB_WORKSPACE/ops/postgres-reconcile-topology.sh:/usr/local/bin/postgres-reconcile-topology:ro" \
            -e POSTGRES_HOST=127.0.0.1 -e POSTGRES_DB=mnt_ci \
            -e POSTGRES_ADMIN_USER=postgres -e POSTGRES_ADMIN_PASSWORD=postgres \
            -e MNT_APP_POSTGRES_PASSWORD="$APP_PASSWORD" \
            -e MNT_RT_POSTGRES_PASSWORD="$RT_PASSWORD" \
            -e MNT_LEAVE_COMMAND_POSTGRES_PASSWORD="$LEAVE_COMMAND_PASSWORD" \
            -e MNT_ONTOLOGY_COMMAND_POSTGRES_PASSWORD="$ONTOLOGY_COMMAND_PASSWORD" \
            --entrypoint bash postgres:18.4@sha256:4aabea78cf39b90e834caf3af7d602a18565f6fe2508705c8d01aa63245c2e20 \
            /usr/local/bin/postgres-reconcile-topology

          docker run --rm --network host \
            -e PGPASSWORD=postgres \
            --entrypoint psql \
            postgres:18.4@sha256:4aabea78cf39b90e834caf3af7d602a18565f6fe2508705c8d01aa63245c2e20 \
            -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 \
            -c "DROP DATABASE IF EXISTS mnt_apalis_contract WITH (FORCE)" \
            -c "CREATE DATABASE mnt_apalis_contract OWNER mnt_app"

          echo "::add-mask::$APP_PASSWORD"
          echo "::add-mask::$RT_PASSWORD"
          {
            echo "MNT_APALIS_OWNER_DATABASE_URL=postgres://mnt_app:\${APP_PASSWORD}@localhost:5432/mnt_apalis_contract"
            echo "MNT_APALIS_RUNTIME_DATABASE_URL=postgres://mnt_rt:\${RT_PASSWORD}@localhost:5432/mnt_apalis_contract"
            echo "MNT_APALIS_ADMIN_DATABASE_URL=postgres://postgres:postgres@localhost:5432/mnt_apalis_contract"
          } >> "$GITHUB_ENV"
      - name: PR 473 migration operational gate
        working-directory: .
        run: npm run check:pr473-migration-operational
`,
};

function evaluatePr473(overrides = {}) {
  const files = { ...validPr473Files, ...overrides };
  return evaluateExpandContractReleaseChecks((path) => files[path] ?? "");
}

describe("production hardening PR 473 typed operational gate", () => {
  it("accepts the canonical typed manifest, directives, alias, and ordered CI wrapper", () => {
    assert.deepEqual(evaluatePr473().failures, []);
  });

  it("rejects malformed and nondeploy-mutated manifests", () => {
    const malformed = evaluatePr473({
      "docs/release/PR-473-EXPAND-CONTRACT.gate.json": "{",
    });
    assertHasFailure(malformed, "must be valid JSON");

    const manifest = JSON.parse(pr473ManifestText);
    manifest.deployment_authorized = true;
    const mutated = evaluatePr473({
      "docs/release/PR-473-EXPAND-CONTRACT.gate.json": `${JSON.stringify(manifest, null, 2)}\n`,
    });
    assertHasFailure(mutated, "nondeploy must be exactly false");
  });

  it("rejects duplicate and substituted guarded test tuples", () => {
    const duplicate = JSON.parse(pr473ManifestText);
    duplicate.guarded_tests[10] = { ...duplicate.guarded_tests[0] };
    const duplicateResult = evaluatePr473({
      "docs/release/PR-473-EXPAND-CONTRACT.gate.json": `${JSON.stringify(duplicate, null, 2)}\n`,
    });
    assertHasFailure(duplicateResult, "11 unique tuples");
    assertHasFailure(
      duplicateResult,
      "exact expected 3 ontology and 8 leave tuples",
    );

    const substituted = JSON.parse(pr473ManifestText);
    substituted.guarded_tests[0].name = "invented_unique_test";
    const substitutedResult = evaluatePr473({
      "docs/release/PR-473-EXPAND-CONTRACT.gate.json": `${JSON.stringify(substituted, null, 2)}\n`,
    });
    assertHasFailure(
      substitutedResult,
      "exact expected 3 ontology and 8 leave tuples",
    );
  });

  it("rejects missing and duplicated canonical document directives", () => {
    const missing = evaluatePr473({
      "docs/release/PR-473-ONTOLOGY-EXPAND-CONTRACT.md":
        pr473Directives.replace(
          "<!-- PR473-MIGRATION-GATE: deployment_authorized=false -->",
          "",
        ),
    });
    assertHasFailure(missing, "deployment_authorized=false");

    const duplicated = evaluatePr473({
      "docs/release/PR-473-EMPLOYEE-IMPORT-EXPAND-CONTRACT.md": `${pr473Directives}\n${pr473Directives}`,
    });
    assertHasFailure(duplicated, "found 2");

    const nested = evaluatePr473({
      "docs/release/PR-473-ONTOLOGY-EXPAND-CONTRACT.md": `# PR 473 Ontology Expand Contract\n\n> ${pr473Directives.replaceAll("\n", "\n> ")}\n`,
    });
    assertHasFailure(nested, "canonical block immediately after");
  });

  it("rejects a commented-out or duplicated workflow invocation", () => {
    const commented = evaluatePr473({
      ".github/workflows/ci.yml": validPr473Files[
        ".github/workflows/ci.yml"
      ].replace(
        "        run: npm run check:pr473-migration-operational",
        "        # run: npm run check:pr473-migration-operational",
      ),
    });
    assertHasFailure(commented, "exactly one active");

    const duplicated = evaluatePr473({
      ".github/workflows/ci.yml": `${validPr473Files[".github/workflows/ci.yml"]}
      - name: duplicate
        run: npm run check:pr473-migration-operational
`,
    });
    assertHasFailure(duplicated, "found 2");

    for (const command of [
      "echo npm run check:pr473-migration-operational",
      "npm run check:pr473-migration-operational-evil",
    ]) {
      const spoofed = evaluatePr473({
        ".github/workflows/ci.yml": validPr473Files[
          ".github/workflows/ci.yml"
        ].replace("npm run check:pr473-migration-operational", command),
      });
      assertHasFailure(spoofed, "exactly one active");
    }

    const relocated = evaluatePr473({
      ".github/workflows/ci.yml": `${validPr473Files[
        ".github/workflows/ci.yml"
      ].replace("npm run check:pr473-migration-operational", "echo disabled")}
      - name: unrelated exact command
        run: npm run check:pr473-migration-operational
`,
    });
    assertHasFailure(relocated, "named CI wrapper step must run exactly");
  });

  it("rejects a wrapper step before topology and an inexact package alias", () => {
    const beforeTopology = evaluatePr473({
      ".github/workflows/ci.yml": `steps:
  - name: PR 473 migration operational gate
    working-directory: .
    run: npm run check:pr473-migration-operational
  - name: Reconcile portable PostgreSQL role topology
    run: ./ops/postgres-reconcile-topology.sh
`,
    });
    assertHasFailure(beforeTopology, "backend job must contain");

    const alias = evaluatePr473({
      "package.json": JSON.stringify({
        scripts: {
          "check:pr473-migration-operational":
            "python scripts/check-pr473-migration-operational.py",
        },
      }),
    });
    assertHasFailure(alias, "package alias must be exactly");
  });

  it("binds the exact topology command and wrapper ordering to the backend job", () => {
    const crossJob = evaluatePr473({
      ".github/workflows/ci.yml": validPr473Files[".github/workflows/ci.yml"]
        .replace(
          "  backend:\n    steps:\n      - name: Reconcile portable PostgreSQL role topology",
          "  topology-only:\n    steps:\n      - name: Reconcile portable PostgreSQL role topology",
        )
        .replace(
          "      - name: PR 473 migration operational gate",
          "  backend:\n    steps:\n      - name: PR 473 migration operational gate",
        ),
    });
    assertHasFailure(crossJob, "backend job must contain");

    const fakeTopology = evaluatePr473({
      ".github/workflows/ci.yml": validPr473Files[
        ".github/workflows/ci.yml"
      ].replace(
        "          /usr/local/bin/postgres-reconcile-topology",
        "          echo topology-disabled",
      ),
    });
    assertHasFailure(fakeTopology, "must invoke the exact reconcile command");
  });

  it("rejects shell-control topology command bypasses", () => {
    const command = '          APP_PASSWORD="$(openssl rand -hex 32)"';
    for (const replacement of [
      `          true || ${command.trim()}`,
      `${command} && true`,
    ]) {
      const result = evaluatePr473({
        ".github/workflows/ci.yml": validPr473Files[
          ".github/workflows/ci.yml"
        ].replace(command, replacement),
      });
      assertHasFailure(result, "must invoke the exact reconcile command");
    }
  });

  it("rejects an inexact Apalis contract database name", () => {
    const result = evaluatePr473({
      ".github/workflows/ci.yml": validPr473Files[
        ".github/workflows/ci.yml"
      ].replace(
        "CREATE DATABASE mnt_apalis_contract OWNER mnt_app",
        "CREATE DATABASE apalis_contract OWNER mnt_app",
      ),
    });

    assertHasFailure(result, "Apalis database provisioning command");
  });

  it("rejects an Apalis contract database not owned by mnt_app", () => {
    const result = evaluatePr473({
      ".github/workflows/ci.yml": validPr473Files[
        ".github/workflows/ci.yml"
      ].replace(
        "CREATE DATABASE mnt_apalis_contract OWNER mnt_app",
        "CREATE DATABASE mnt_apalis_contract OWNER postgres",
      ),
    });

    assertHasFailure(result, "Apalis database provisioning command");
  });

  it("rejects an unpinned PostgreSQL image for Apalis provisioning", () => {
    const pinnedImage =
      "postgres:18.4@sha256:4aabea78cf39b90e834caf3af7d602a18565f6fe2508705c8d01aa63245c2e20";
    const result = evaluatePr473({
      ".github/workflows/ci.yml": replaceLast(
        validPr473Files[".github/workflows/ci.yml"],
        pinnedImage,
        "postgres:18.4",
      ),
    });

    assertHasFailure(result, "pinned PostgreSQL image");
  });

  it("requires all three exact Apalis database URL exports", () => {
    for (const variable of [
      "MNT_APALIS_OWNER_DATABASE_URL",
      "MNT_APALIS_RUNTIME_DATABASE_URL",
      "MNT_APALIS_ADMIN_DATABASE_URL",
    ]) {
      const result = evaluatePr473({
        ".github/workflows/ci.yml": validPr473Files[
          ".github/workflows/ci.yml"
        ].replace(variable, `${variable}_RENAMED`),
      });

      assertHasFailure(result, "URL exports");
    }
  });

  it("requires both generated Apalis role passwords to be masked", () => {
    for (const password of ["APP_PASSWORD", "RT_PASSWORD"]) {
      const result = evaluatePr473({
        ".github/workflows/ci.yml": validPr473Files[
          ".github/workflows/ci.yml"
        ].replace(`          echo "::add-mask::$${password}"\n`, ""),
      });

      assertHasFailure(result, "masking");
    }
  });
});

const validProductionEvidenceText = `${JSON.stringify(
  {
    schema_version: 1,
    target: "production",
    release_phase: "expand",
    candidate_source_sha: "0".repeat(40),
    observed_running_revision: "0".repeat(40),
    observed_database_topology: {
      cluster_name: "TEMPLATE_NOT_EVIDENCE",
      namespace: "TEMPLATE_NOT_EVIDENCE",
      writer_endpoint: "TEMPLATE_NOT_EVIDENCE",
      reader_endpoint: "TEMPLATE_NOT_EVIDENCE",
      instances: [],
    },
    capacity_headroom: {
      window_started_at: "TEMPLATE_NOT_EVIDENCE",
      window_ended_at: "TEMPLATE_NOT_EVIDENCE",
      cpu_peak_percent: 0,
      memory_peak_percent: 0,
      storage_used_percent: 0,
      connection_peak: 0,
      connection_limit: 0,
      minimum_headroom_percent: 0,
    },
    backup_restore_proof: {
      backup_id: "TEMPLATE_NOT_EVIDENCE",
      backup_completed_at: "TEMPLATE_NOT_EVIDENCE",
      isolated_restore_id: "TEMPLATE_NOT_EVIDENCE",
      isolated_restore_completed_at: "TEMPLATE_NOT_EVIDENCE",
      restored_revision: "0".repeat(40),
      validation_checks: [],
    },
    evidence_author: {
      github_login: "TEMPLATE_NOT_EVIDENCE",
      identity_provider_subject: "TEMPLATE_NOT_EVIDENCE",
    },
    independent_reviewer: {
      github_login: "TEMPLATE_NOT_EVIDENCE",
      identity_provider_subject: "TEMPLATE_NOT_EVIDENCE",
      team_id: 0,
    },
    charter: {
      charter_id: "TEMPLATE_NOT_EVIDENCE",
      trust_domain_id: "TEMPLATE_NOT_EVIDENCE",
    },
    observed_at: "TEMPLATE_NOT_EVIDENCE",
    prepared_at: "TEMPLATE_NOT_EVIDENCE",
    reviewed_at: "TEMPLATE_NOT_EVIDENCE",
  },
  null,
  2,
)}\n`;

const validWorkflowFiles = {
  "scripts/check-production-authority-blocked.mjs": "#!/usr/bin/env node\n",
  "package.json": JSON.stringify({
    scripts: {
      "test:production-hardening":
        "npm run test:pr473-migration-operational && python3 scripts/check-production-promotion-authority.test.py && node --test scripts/check-production-authority-blocked.test.mjs scripts/check-production-hardening.test.mjs",
      "check:production-authority-blocked":
        "node scripts/check-production-authority-blocked.mjs",
    },
  }),
  "docs/release/PR-473-PRODUCTION-CARDINALITY.evidence.json":
    validProductionEvidenceText,
  "docs/release/PR-473-PRODUCTION-PROMOTION.md":
    "This mechanism does **not** make mutable `main` a safe production desired-state authority. The `desired_state_authority_cutover` field is immutable `false`. Production activation remains **BLOCKED** pending a separate, higher-authority ADR. Evidence identities are self-asserted strings whose provenance is not authenticated; administrator bypass posture is unverified.\n",
  "docs/release/PR-473-PRODUCTION-PROMOTION.authorization.json": `${JSON.stringify(
    {
      schema_version: 2,
      pull_request: 473,
      target: "production",
      release_phase: "expand",
      rollback_floor: "f6ff236b9770c79301a3d07da6afb56be1e27bbf",
      desired_state_authority_cutover: false,
      deployment_authorized: false,
      command_only: false,
      production_cardinality_evidence: {
        path: "docs/release/PR-473-PRODUCTION-CARDINALITY.evidence.json",
        sha256: createHash("sha256")
          .update(validProductionEvidenceText)
          .digest("hex"),
        verified: false,
      },
      contract_authorities: {
        old_runtime_drain: false,
        rollback_floor_raise: false,
      },
    },
    null,
    2,
  )}\n`,
  ".github/workflows/ci.yml": `name: CI
jobs:
  backend:
    steps:
      - name: Production hardening contract
        run: npm run check:production-hardening
      - name: Kubernetes render and NetworkPolicy preflight
        run: npm run check:k8s
`,
  ".github/workflows/security.yml": `name: Security
jobs:
  iac:
    steps:
      - name: Render and scan production manifests
        run: |
          npm run check:production-hardening
          trivy config --severity HIGH,CRITICAL --exit-code 1 "$RUNNER_TEMP/rendered-k8s"
  filesystem:
    steps:
      - name: Trivy filesystem scan
        run: trivy fs --scanners vuln,secret --ignore-unfixed --severity HIGH,CRITICAL --exit-code 1 .
  rust-advisories:
    steps:
      - name: Run cargo audit
        run: cargo audit
  rust-supply-chain:
    steps:
      - name: Run cargo deny
        run: cargo deny --manifest-path backend/Cargo.toml check
  node-advisories:
    steps:
      - name: npm audit
        run: npm audit --audit-level=high
`,
  ".github/workflows/image-release.yml": `name: Image Release
on:
  workflow_dispatch:
    inputs:
      promote_production:
        description: Promote the signed digests to the production overlay
        required: true
        default: false
        type: boolean
jobs:
  release-probe:
    permissions:
      contents: read
      packages: read
    steps:
      - name: Checkout
        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7
        with:
          ref: \${{ needs.ci-admission.outputs.release_sha }}
          persist-credentials: false
      - name: Provision topology
        run: cat ops/postgres-reconcile-topology.sh
  production-promotion-preflight:
    if: github.run_attempt == 1
    permissions:
      contents: read
    steps:
      - name: Checkout authorization
        uses: actions/checkout@${"c".repeat(40)}
        with:
          ref: \${{ github.sha }}
          persist-credentials: false
      - run: python3 scripts/check-production-promotion-authority.py initial --expected-sha "$GITHUB_SHA" --expected-ref "$GITHUB_REF"
  images:
    steps:
      - name: Trivy scan (fail on HIGH/CRITICAL)
        run: trivy image --severity HIGH,CRITICAL --exit-code 1 "$IMAGE_NAME@$DIGEST"
      - name: Sign the image
        run: cosign sign --yes "$IMAGE_NAME@$DIGEST"
      - name: Attest build provenance
        uses: actions/attest-build-provenance@v4
  bump-digests:
    needs: [production-promotion-preflight]
    environment: production
    if: >-
      github.event_name == 'workflow_dispatch' &&
      github.ref == 'refs/heads/main' &&
      github.run_attempt == 1 &&
      inputs.promote_production == true
    permissions:
      contents: write
      actions: read
    steps:
      - name: Checkout exact authorization
        uses: actions/checkout@${"b".repeat(40)}
        with:
          ref: \${{ github.sha }}
          fetch-depth: 0
      - run: python3 scripts/check-production-promotion-authority.py initial --expected-sha "$GITHUB_SHA" --expected-ref "$GITHUB_REF"
      - name: Verify exact independent production reviewer team
        env:
          DISPATCHER: \${{ github.actor }}
          TRIGGERING_ACTOR: \${{ github.triggering_actor }}
          RUN_ATTEMPT: \${{ github.run_attempt }}
        run: |
          set -euo pipefail
          if [[ "\${RUN_ATTEMPT}" != "1" ]]; then
            echo "production promotion rejects workflow reruns"
            exit 1
          fi
          if [[ "\${DISPATCHER,,}" != "\${TRIGGERING_ACTOR,,}" ]]; then
            exit 1
          fi
          context="$(python3 scripts/check-production-promotion-authority.py reviewer-context --expected-sha "$GITHUB_SHA")"
          team_id="$(jq -er '.team_id' <<<"$context")"
          evidence_author_login="$(jq -er '.evidence_author_login' <<<"$context")"
          independent_reviewer_login="$(jq -er '.independent_reviewer_login' <<<"$context")"
          if [[ "\${DISPATCHER,,}" == "\${evidence_author_login,,}" || "\${DISPATCHER,,}" == "\${independent_reviewer_login,,}" ]]; then
            echo "production dispatcher must be distinct from the evidence author and independent evidence reviewer"
            exit 1
          fi
          environment="$(gh api "repos/\${REPO}/environments/production")"
          jq -e --argjson team_id "$team_id" '
            [.protection_rules[]? | select(.type == "required_reviewers")] as $rules
            | ($rules | length) == 1
              and $rules[0].prevent_self_review == true
              and ($rules[0].reviewers | length) == 1
              and $rules[0].reviewers[0].type == "Team"
              and $rules[0].reviewers[0].reviewer.id == $team_id
          ' <<<"$environment"
      - name: Bump prod overlay digests
        run: |
          bash scripts/bump-prod-digests.sh "$APP_DIGEST" "$WEB_DIGEST"
          python3 scripts/check-production-promotion-authority.py reset --expected-sha "$GITHUB_SHA"
      - name: Commit and push
        run: |
          git commit -m promote
          python3 scripts/check-production-promotion-authority.py pre-push --expected-sha "$GITHUB_SHA"
          git push origin "HEAD:main"
`,
  "scripts/check-production-promotion-authority.py": `
from pathlib import PurePosixPath
import hashlib
AUTHORIZATION_PATH = "docs/release/PR-473-PRODUCTION-PROMOTION.authorization.json"
CANONICAL_EVIDENCE_PATH = "docs/release/PR-473-PRODUCTION-CARDINALITY.evidence.json"
schema_version = 2
desired_state_authority_cutover = False
def verify_authorization_schema(record, *, authorized: bool): pass
def verify_evidence_schema(record, candidate_source_sha): pass
def canonical_false(record): pass
def commit_parent(commit, label): pass
hashlib.sha256(b"")
pull_request = 473
production_cardinality = old_runtime_drain = rollback_floor_raise = True
candidate_source_sha = independent_reviewer = team_id = True
raise RuntimeError("keys are not exact")
git("rev-parse", "HEAD")
run(["git", "show", f"{expected_sha}:{path}"])
git("status", "--porcelain", "--untracked-files=no")
git("fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main")
git("diff-tree")
raise RuntimeError("origin/main advanced after authorization")
raise RuntimeError("activation requires a separate accepted higher-authority ADR/cutover")
`,

};

// The acceptance fixture is the checked-in release contract. Negative cases below
// mutate it; this prevents a toy workflow from drifting away from the real gate.
validWorkflowFiles["package.json"] = readFileSync(
  new URL("../package.json", import.meta.url),
  "utf8",
);
validWorkflowFiles[".github/workflows/image-release.yml"] = readFileSync(
  new URL("../.github/workflows/image-release.yml", import.meta.url),
  "utf8",
);

function evaluateWorkflows(overrides = {}) {
  const files = { ...validWorkflowFiles, ...overrides };
  return evaluateWorkflowHardeningChecks((path) => files[path] ?? "");
}

const documentedEnvironmentReviewerFilter = `
  [.protection_rules[]? | select(.type == "required_reviewers")] as $rules
  | ($rules | length) == 1
    and $rules[0].prevent_self_review == true
    and ($rules[0].reviewers | length) == 1
    and $rules[0].reviewers[0].type == "Team"
    and $rules[0].reviewers[0].reviewer.id == $team_id
`;

function evaluateDocumentedEnvironmentReviewers(environment) {
  return spawnSync(
    "jq",
    [
      "-e",
      "--argjson",
      "team_id",
      "424242",
      documentedEnvironmentReviewerFilter,
    ],
    { input: JSON.stringify(environment), encoding: "utf8" },
  );
}

describe("production hardening workflow gates", () => {
  it("rejects missing blocked-observation evaluator wiring, alias, and focused suite", () => {
    assertHasFailure(
      evaluateWorkflows({
        "scripts/check-production-authority-blocked.mjs": "",
      }),
      "blocked evaluator and exact package CLI wiring",
    );
    const withoutAlias = JSON.parse(validWorkflowFiles["package.json"]);
    delete withoutAlias.scripts["check:production-authority-blocked"];
    assertHasFailure(
      evaluateWorkflows({ "package.json": JSON.stringify(withoutAlias) }),
      "blocked evaluator and exact package CLI wiring",
    );
    const withoutFocusedTest = JSON.parse(validWorkflowFiles["package.json"]);
    withoutFocusedTest.scripts["test:production-hardening"] =
      "npm run test:pr473-migration-operational && python3 scripts/check-production-promotion-authority.test.py";
    assertHasFailure(
      evaluateWorkflows({ "package.json": JSON.stringify(withoutFocusedTest) }),
      "canonical fail-closed command",
    );
  });
  it("accepts active CI, security, and image-release workflow gates", () => {
    assert.deepEqual(evaluateWorkflows().failures, []);
  });

  it("binds the documented GitHub environment Team response shape exactly", () => {
    const rule = {
      type: "required_reviewers",
      prevent_self_review: true,
      reviewers: [
        {
          type: "Team",
          reviewer: { id: 424242, slug: "production-reviewers" },
        },
      ],
    };
    assert.equal(
      evaluateDocumentedEnvironmentReviewers({ protection_rules: [rule] })
        .status,
      0,
    );
    assert.notEqual(
      evaluateDocumentedEnvironmentReviewers({
        protection_rules: [
          {
            ...rule,
            reviewers: [
              ...rule.reviewers,
              { type: "User", reviewer: { id: 7 } },
            ],
          },
        ],
      }).status,
      0,
    );
    assert.notEqual(
      evaluateDocumentedEnvironmentReviewers({
        protection_rules: [
          {
            ...rule,
            reviewers: [{ type: "Team", id: 424242, reviewer: { id: 7 } }],
          },
        ],
      }).status,
      0,
    );
  });

  it("rejects removing the canonical Python promotion suite", () => {
    const pkg = JSON.parse(validWorkflowFiles["package.json"]);
    pkg.scripts["test:production-hardening"] =
      "node --test scripts/check-production-hardening.test.mjs";
    assertHasFailure(
      evaluateWorkflows({ "package.json": JSON.stringify(pkg) }),
      "canonical fail-closed command",
    );
  });

  it("rejects a non-false production authorization or missing unprotected preflight", () => {
    const authorization = JSON.parse(
      validWorkflowFiles[
        "docs/release/PR-473-PRODUCTION-PROMOTION.authorization.json"
      ],
    );
    authorization.deployment_authorized = true;
    assertHasFailure(
      evaluateWorkflows({
        "docs/release/PR-473-PRODUCTION-PROMOTION.authorization.json": `${JSON.stringify(authorization, null, 2)}\n`,
      }),
      "canonical schema-v2 false-by-default",
    );
    assertHasFailure(
      evaluateWorkflows({
        ".github/workflows/image-release.yml": validWorkflowFiles[
          ".github/workflows/image-release.yml"
        ].replace("  production-promotion-preflight:", "  renamed-preflight:"),
      }),
      "unprotected read-only preflight",
    );

    authorization.deployment_authorized = false;
    authorization.desired_state_authority_cutover = true;
    assertHasFailure(
      evaluateWorkflows({
        "docs/release/PR-473-PRODUCTION-PROMOTION.authorization.json": `${JSON.stringify(authorization, null, 2)}\n`,
      }),
      "canonical schema-v2 false-by-default",
    );
  });

  it("rejects missing one-shot reset, immutable verifier inputs, or rebase behavior", () => {
    const workflow = validWorkflowFiles[".github/workflows/image-release.yml"];
    assertHasFailure(
      evaluateWorkflows({
        ".github/workflows/image-release.yml": workflow.replace(
          "check-production-promotion-authority.py reset",
          "renamed-authority.py reset",
        ),
      }),
      "reset one-shot authorization",
    );
    assertHasFailure(
      evaluateWorkflows({
        "scripts/check-production-promotion-authority.py": validWorkflowFiles[
          "scripts/check-production-promotion-authority.py"
        ].replace('["git", "show", f"{expected_sha}:{path}"]', '["cat", path]'),
      }),
      "immutable git-show inputs",
    );
    assertHasFailure(
      evaluateWorkflows({
        ".github/workflows/image-release.yml": workflow.replace(
          'git push origin "HEAD:main"',
          'git pull --rebase origin main\n          git push origin "HEAD:main"',
        ),
      }),
      "must not pull, rebase, retry, or loop",
    );
  });

  it("rejects recovery without an exact required candidate SHA", () => {
    const releaseWorkflow =
      validWorkflowFiles[".github/workflows/image-release.yml"];
    const result = evaluateWorkflows({
      ".github/workflows/image-release.yml": releaseWorkflow.replace(
        `      candidate_sha:
        description: Exact current-main SHA whose successful push CI authorizes recovery
        required: true
        type: string
`,
        "",
      ),
    });

    assertHasFailure(
      result,
      "workflow_dispatch recovery must require a lowercase 40-character candidate_sha",
    );
  });

  it("rejects production digest promotion without an explicit required false-by-default dispatch input", () => {
    const releaseWorkflow =
      validWorkflowFiles[".github/workflows/image-release.yml"];
    const result = evaluateWorkflows({
      ".github/workflows/image-release.yml": releaseWorkflow.replace(
        `      promote_production:
        description: Promote the signed digests to the production overlay
        required: true
        default: false
        type: boolean
`,
        "",
      ),
    });

    assertHasFailure(
      result,
      "must declare promote_production as a required false-by-default boolean",
    );
  });

  it("rejects production digest promotion on push or outside main", () => {
    const releaseWorkflow =
      validWorkflowFiles[".github/workflows/image-release.yml"];
    const result = evaluateWorkflows({
      ".github/workflows/image-release.yml": releaseWorkflow
        .replaceAll(
          "github.event_name == 'workflow_dispatch'",
          "github.event_name == 'push'",
        )
        .replaceAll(
          "github.ref == 'refs/heads/main'",
          "startsWith(github.ref, 'refs/heads/')",
        ),
    });

    assertHasFailure(
      result,
      "must run only for an explicit workflow_dispatch on refs/heads/main",
    );
  });

  it("rejects production digest promotion without the production environment", () => {
    const releaseWorkflow =
      validWorkflowFiles[".github/workflows/image-release.yml"];
    const result = evaluateWorkflows({
      ".github/workflows/image-release.yml": releaseWorkflow.replace(
        "    environment: production\n",
        "",
      ),
    });

    assertHasFailure(
      result,
      "must bind the mutation job to the production environment",
    );
  });

  it("rejects production promotion without exact independent Team reviewer enforcement", () => {
    const releaseWorkflow =
      validWorkflowFiles[".github/workflows/image-release.yml"];
    for (const mutated of [
      releaseWorkflow.replace(
        "prevent_self_review == true",
        "prevent_self_review == false",
      ),
      releaseWorkflow.replace(
        '.reviewers[0].type == "Team"',
        '.reviewers[0].type == "User"',
      ),
      releaseWorkflow.replace(
        "($rules[0].reviewers | length) == 1",
        "($rules[0].reviewers | length) > 0",
      ),
      releaseWorkflow.replace(".reviewer.id == $team_id", ".id == $team_id"),
      releaseWorkflow.replace("reviewer-context", "removed-reviewer-context"),
      releaseWorkflow.replace(
        "          DISPATCHER: \${{ github.actor }}\n",
        "",
      ),
      releaseWorkflow.replace(
        "          TRIGGERING_ACTOR: \${{ github.triggering_actor }}\n",
        "",
      ),
      releaseWorkflow.replaceAll(
        "evidence_author_login",
        "removed_first_party",
      ),
      releaseWorkflow.replace(
        "production dispatcher must be distinct from the evidence author and independent evidence reviewer",
        "dispatcher independence disabled",
      ),
    ]) {
      assertHasFailure(
        evaluateWorkflows({ ".github/workflows/image-release.yml": mutated }),
        "exact immutable evidence Team ID",
      );
    }
  });

  it("rejects workflow reruns in both preflight and protected promotion jobs", () => {
    const releaseWorkflow =
      validWorkflowFiles[".github/workflows/image-release.yml"];
    assertHasFailure(
      evaluateWorkflows({
        ".github/workflows/image-release.yml": releaseWorkflow.replaceAll(
          "github.run_attempt == 1",
          "github.run_attempt >= 1",
        ),
      }),
      "explicit workflow_dispatch on refs/heads/main",
    );
  });

  it("rejects release-probe checkout without explicit job-level contents read", () => {
    const releaseWorkflow =
      validWorkflowFiles[".github/workflows/image-release.yml"];
    const result = evaluateWorkflows({
      ".github/workflows/image-release.yml": releaseWorkflow.replaceAll(
        "      contents: read\n",
        "",
      ),
    });

    assertHasFailure(
      result,
      "release-probe permissions must explicitly grant contents: read for its checkout",
    );
  });

  it("rejects a mutable release-probe checkout reference", () => {
    const releaseWorkflow =
      validWorkflowFiles[".github/workflows/image-release.yml"];
    const result = evaluateWorkflows({
      ".github/workflows/image-release.yml": releaseWorkflow.replaceAll(
        `actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0`,
        "actions/checkout@v7",
      ),
    });

    assertHasFailure(
      result,
      "release-probe must perform a SHA-pinned actions/checkout",
    );
  });

  it("rejects release-probe topology use before checkout", () => {
    const releaseWorkflow =
      validWorkflowFiles[".github/workflows/image-release.yml"];
    const result = evaluateWorkflows({
      ".github/workflows/image-release.yml": releaseWorkflow.replaceAll(
        "ops/postgres-reconcile-topology.sh",
        "removed-topology-script.sh",
      ),
    });

    assertHasFailure(result, "before using ops/postgres-reconcile-topology.sh");
  });

  it("rejects persisted release-probe checkout credentials", () => {
    const releaseWorkflow =
      validWorkflowFiles[".github/workflows/image-release.yml"];
    const result = evaluateWorkflows({
      ".github/workflows/image-release.yml": releaseWorkflow.replaceAll(
        "          persist-credentials: false\n",
        "          persist-credentials: true\n",
      ),
    });

    assertHasFailure(result, "persist-credentials: false");
  });

  it("does not let the following preflight job satisfy release-probe checks", () => {
    const releaseWorkflow =
      validWorkflowFiles[".github/workflows/image-release.yml"];
    const releaseProbeWithoutGuards = releaseWorkflow
      .replace(
        `      contents: read
      packages: read
`,
        `      packages: read
`,
      )
      .replaceAll(
        "ops/postgres-reconcile-topology.sh",
        "removed-topology-script.sh",
      )
      .replace(
        "  production-promotion-preflight:\n",
        `  production-promotion-preflight:
    # These strings must not leak backward into release-probe validation.
    # contents: read; actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0; persist-credentials: false
    # ops/postgres-reconcile-topology.sh
`,
      );
    const result = evaluateWorkflows({
      ".github/workflows/image-release.yml": releaseProbeWithoutGuards,
    });
    assertHasFailure(
      result,
      "release-probe permissions must explicitly grant contents: read",
    );
    assertHasFailure(result, "before using ops/postgres-reconcile-topology.sh");
  });

  it("rejects workflow gates that only appear in comments or unused literals", () => {
    const result = evaluateWorkflows({
      ".github/workflows/ci.yml": `name: CI
env:
  UNUSED_GATE_TEXT: "npm run check:production-hardening npm run check:k8s"
# npm run check:production-hardening
# npm run check:k8s
jobs:
  backend:
    steps:
      - run: echo "CI has no active production hardening gate"
`,
      ".github/workflows/security.yml": `name: Security
env:
  UNUSED_SECURITY_TEXT: "npm run check:production-hardening trivy fs --scanners vuln,secret trivy config --severity HIGH,CRITICAL --exit-code 1 cargo audit cargo deny --manifest-path backend/Cargo.toml check npm audit --audit-level=high"
jobs:
  iac:
    steps:
      - run: echo "security gates are absent"
`,
      ".github/workflows/image-release.yml": `name: Image Release
env:
  UNUSED_RELEASE_TEXT: "completed CI admission Trivy scan (fail on HIGH/CRITICAL) cosign sign --yes attest-build-provenance bump-prod-digests"
# - name: completed CI admission
# - name: Trivy scan (fail on HIGH/CRITICAL)
# - run: cosign sign --yes "$IMAGE"
# - uses: actions/attest-build-provenance@v4
# - run: bash scripts/bump-prod-digests.sh "$APP" "$WEB"
jobs:
  images:
    steps:
      - run: echo "image release has no active gates"
`,
    });

    assertHasFailure(
      result,
      "CI must run npm run check:production-hardening as an active step",
    );
    assertHasFailure(
      result,
      "Security workflow must run npm run check:production-hardening as an active step",
    );
    assertHasFailure(
      result,
      "security workflow must actively run trivy fs --scanners vuln,secret",
    );
    assertHasFailure(
      result,
      "image-release must trigger only from completed CI",
    );
    assertHasFailure(result, "image-release must actively cosign sign");
  });
});

const validAndroidE2eFiles = {
  "package.json": JSON.stringify({ scripts: { "check:android-e2e-fail-closed": "node scripts/check-android-e2e-fail-closed.mjs" } }),
  ".github/workflows/ci.yml": `name: CI
jobs:
  web:
    steps:
      - run: npm run check:android-e2e-fail-closed
  android-instrumented:
    env:
      E2E_HTTP_ADDR: 127.0.0.1:8080
    services:
      postgres:
        image: postgres:18.4
    steps:
      - run: |
          test "$(git rev-parse HEAD)" = "$GITHUB_SHA"
          cargo build --release --bin mnt-app
      - name: Bootstrap hermetic backend and session fixture
        run: |
          set -euo pipefail
          session_assets_dir="\${RUNNER_TEMP}/android-e2e-session-assets"
          session_file="$session_assets_dir/field-e2e-session.properties"
          bootstrap_otp="$(openssl rand -hex 32)"
          otp_hash="$(printf '%s' "$bootstrap_otp" | sha256sum | awk '{print $1}')"
          printf '::add-mask::%s\\n' "$bootstrap_otp"
          E2E_PG_HOST=127.0.0.1 e2e/harness/db.sh
          psql -v otp_hash="$otp_hash" -v fixture_profile=full -f e2e/harness/seed-mobile-ci.sql
          e2e/harness/boot-backend.sh
          backend_url="http://127.0.0.1:8080"
          response="$(printf '%s' "$bootstrap_otp" | jq -Rsc '{otp:.}' | curl -fsS -X POST "$backend_url/api/v1/auth/otp/redeem" --data-binary @-)"
          access_token="$(printf '%s' "$response" | jq -er '.access_token')"
          refresh_token="$(printf '%s' "$response" | jq -er '.refresh_token')"
          printf '::add-mask::%s\\n' "$access_token"
          printf '::add-mask::%s\\n' "$refresh_token"
          install -d -m 700 "$session_assets_dir"
          umask 077
          printf 'FIELD_E2E_ACCESS_TOKEN=%s\\nFIELD_E2E_REFRESH_TOKEN=%s\\n' "$access_token" "$refresh_token" > "$session_file"
          chmod 600 "$session_file"
          export FIELD_E2E_SESSION_ASSETS_DIR="$session_assets_dir"
          (
            cd android
            ./gradlew fieldApi34DebugAndroidTest
          )
          python3 - <<'PY'
          import pathlib
          import xml.etree.ElementTree as ET
          cases = []
          for result_file in pathlib.Path("android/app/build").rglob("TEST-*.xml"):
              root = ET.parse(result_file).getroot()
              for case in root.iter("testcase"):
                  if case.attrib.get("classname", "").endswith(".WorkOrderFlowTest"):
                      cases.append(case)
          if not cases:
              raise SystemExit("WorkOrderFlowTest is missing")
          for case in cases:
              if case.find("skipped") is not None:
                  raise SystemExit("WorkOrderFlowTest was skipped")
              if case.find("failure") is not None or case.find("error") is not None:
                  raise SystemExit("WorkOrderFlowTest failed")
          PY
      - name: Cleanup hermetic Android E2E
        if: always()
        run: |
          rm -rf "\${RUNNER_TEMP}/android-e2e-session-assets"
          kill "$(cat "\${RUNNER_TEMP}/android-e2e-auth/backend.pid")" || true
`,
  "android/app/build.gradle.kts": `val fieldE2eSessionAssetsDir = providers.environmentVariable("FIELD_E2E_SESSION_ASSETS_DIR")
android {
  buildTypes { release { buildConfigField("String", "API_BASE_URL", "\\"https://api.example.test\\"") } }
  sourceSets { getByName("androidTest") { fieldE2eSessionAssetsDir.orNull?.let { assets.srcDir(it) } } }
}`,
  "android/app/src/androidTest/kotlin/com/maintenance/field/WorkOrderFlowTest.kt": `class WorkOrderFlowTest {
  fun fixture() {
    InstrumentationRegistry.getInstrumentation().context.assets.open("field-e2e-session.properties")
    val access = "FIELD_E2E_ACCESS_TOKEN"
    val refresh = "FIELD_E2E_REFRESH_TOKEN"
    SessionTokenStore(ApplicationProvider.getApplicationContext())
  }
}`,
  "android/app/src/debug/AndroidManifest.xml": `<manifest><application android:networkSecurityConfig="@xml/network_security_config" /></manifest>`,
  "android/app/src/debug/res/xml/network_security_config.xml": `<network-security-config><base-config cleartextTrafficPermitted="false"/><domain-config cleartextTrafficPermitted="true"><domain>10.0.2.2</domain></domain-config></network-security-config>`,
};

function evaluateAndroidE2eTokenHandoff(overrides = {}) {
  const files = { ...validAndroidE2eFiles, ...overrides };
  return evaluateAndroidE2eTokenHandoffChecks((path) => files[path] ?? "");
}
function evaluateAndroidE2eFailClosed(overrides = {}) {
  const files = { ...validAndroidE2eFiles, ...overrides };
  return evaluateAndroidE2eFailClosedChecks((path) => files[path] ?? "");
}

describe("production hardening Android hermetic E2E", () => {
  it("accepts a self-hosted PostgreSQL 18.4 candidate-SHA session harness", () => {
    const result = evaluateAndroidE2eFailClosed();
    assert.deepEqual(result.failures, []);
    assert.match(result.passes.join("\\n"), /local PostgreSQL 18.4/);
    assert.match(result.passes.join("\\n"), /exact candidate SHA/);
  });

  it("accepts a masked runner-temp asset handoff without token outputs or Gradle args", () => {
    const result = evaluateAndroidE2eTokenHandoff();
    assert.deepEqual(result.failures, []);
    assert.match(result.passes.join("\\n"), /runner-temp chmod-restricted/);
  });

  it("rejects external backend secrets and optional protected-context self-skipping", () => {
    const result = evaluateAndroidE2eFailClosed({
      ".github/workflows/ci.yml": validAndroidE2eFiles[".github/workflows/ci.yml"].replace(
        "services:",
        "env:\\n  FIELD_E2E_BASE_URL: ${{ secrets.FIELD_E2E_BASE_URL }}\\n  FIELD_E2E_REQUIRE_REAL_SESSION: '0'\\n    services:",
      ),
    });
    assertHasFailure(result, "must not depend on FIELD_E2E external backend/session secrets");
  });

  it("rejects a non-hermetic database version, build without exact SHA, and non-local OTP exchange", () => {
    const result = evaluateAndroidE2eFailClosed({
      ".github/workflows/ci.yml": validAndroidE2eFiles[".github/workflows/ci.yml"]
        .replace("postgres:18.4", "postgres:17")
        .replace('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"\n          ', "")
        .replace('$backend_url/api/v1/auth/otp/redeem', 'https://external.example/api/v1/auth/token/refresh'),
    });
    assertHasFailure(result, "must start PostgreSQL 18.4 locally");
    assertHasFailure(result, "must verify git HEAD against GITHUB_SHA");
    assertHasFailure(result, "must migrate/seed local PostgreSQL");
  });

  it("rejects raw or malformed OTP JSON instead of jq-encoding the bootstrap credential", () => {
    const result = evaluateAndroidE2eFailClosed({
      ".github/workflows/ci.yml": validAndroidE2eFiles[".github/workflows/ci.yml"]
        .replace("jq -Rsc '{otp:.}' | ", "")
        .replace("--data-binary @-", '-d "{\\"otp\\":\\"$bootstrap_otp\\"}"'),
    });
    assertHasFailure(result, "must migrate/seed local PostgreSQL, SHA256-hash a random mechanic OTP");
  });

  it("rejects credential leaks, unverified JUnit evidence, missing cleanup, and release cleartext", () => {
    const overrides = {
      ".github/workflows/ci.yml": validAndroidE2eFiles[".github/workflows/ci.yml"]
        .replace('export FIELD_E2E_SESSION_ASSETS_DIR="$session_assets_dir"', 'echo "access=$access_token" >> "$GITHUB_OUTPUT"')
        .replace('case.find("skipped")', 'case.find("not-skipped")')
        .replace('if: always()', 'if: success()')
        .replace('kill "$(cat "\${RUNNER_TEMP}/android-e2e-auth/backend.pid")" || true', 'true'),
      "android/app/src/debug/AndroidManifest.xml": `<manifest><application android:usesCleartextTraffic="true" /></manifest>`,
    };
    const result = evaluateAndroidE2eFailClosed(overrides);
    const tokenResult = evaluateAndroidE2eTokenHandoff(overrides);
    assertHasFailure(tokenResult, "must not be written to GITHUB_OUTPUT");
    assertHasFailure(result, "must parse WorkOrderFlowTest JUnit XML");
    assertHasFailure(result, "must run an always cleanup step");
    assertHasFailure(result, "must permit cleartext only through the debug 10.0.2.2");
  });

  it("rejects token Gradle arguments and a WorkOrderFlowTest that reads instrumentation arguments", () => {
    const result = evaluateAndroidE2eTokenHandoff({
      ".github/workflows/ci.yml": validAndroidE2eFiles[".github/workflows/ci.yml"].replace(
        "./gradlew fieldApi34DebugAndroidTest",
        "./gradlew fieldApi34DebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.FIELD_E2E_ACCESS_TOKEN=$access_token",
      ),
      "android/app/src/androidTest/kotlin/com/maintenance/field/WorkOrderFlowTest.kt": `class WorkOrderFlowTest { fun fixture() = InstrumentationRegistry.getArguments() }`,
    });
    assertHasFailure(result, "must not be written to GITHUB_OUTPUT or passed as Gradle instrumentation arguments");
    assertHasFailure(result, "must load the session tokens from the androidTest asset fixture");
  });
});

function evaluateDeployScript(text) {
  return evaluateDeployAutomationChecks((path) =>
    path === "scripts/deploy.sh" ? text : "",
  );
}

describe("production hardening deploy automation checks", () => {
  it("accepts a deploy path that actively gates on kubectl, Argo refresh, both rollouts, and endpoints", () => {
    const result = evaluateDeployScript(`set -euo pipefail
MODE="deploy"
case "\${1:-}" in
  --digest-bump-only|--bump-only)
    MODE="digest-bump-only"
    shift
    ;;
esac
if [[ "\${MODE}" == "digest-bump-only" ]]; then
  log "done: \${SHORT_SHA} desired prod digests updated only (mnt-app=sha256:aaa, mnt-web=sha256:bbb); deployment, rollout, pod-image, and endpoint verification were NOT run."
  exit 0
fi
require kubectl
if ! kubectl version >/dev/null 2>&1; then
  echo "deploy: kubectl cannot reach the cluster" >&2
  exit 1
fi
kubectl -n "$ARGO_NS" annotate "application/$APP_NAME" "argocd.argoproj.io/refresh=hard" --overwrite
ROLLOUTS=(mnt-app mnt-web)
for rollout in "\${ROLLOUTS[@]}"; do
  kubectl argo rollouts status "$rollout" -n "$NAMESPACE" --timeout 600s
done
for url in "\${ENDPOINTS[@]}"; do
  code="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 10 "$url")"
  if [[ "$code" != "200" ]]; then exit 1; fi
done
log "done: \${SHORT_SHA} deployed and verified"
`);

    assert.deepEqual(result.failures, []);
  });

  it("rejects deploy scripts that skip rollout verification but keep claiming success", () => {
    const result = evaluateDeployScript(`set -euo pipefail
# argocd.argoproj.io/refresh=hard
# kubectl argo rollouts status
if ! have kubectl || ! kubectl version >/dev/null 2>&1; then
  log "kubectl/cluster unreachable; skipping the in-cluster refresh + rollout wait."
else
  log "would wait for rollouts"
fi
curl -fsS https://console.example.test
log "done: \${SHORT_SHA} deployed and verified"
`);

    assertHasFailure(result, "must fail closed before endpoint checks");
    assertHasFailure(result, "must actively request an Argo hard refresh");
    assertHasFailure(
      result,
      "must actively wait for both mnt-app and mnt-web rollouts",
    );
  });

  it("rejects digest-bump-only modes that claim verified rollout", () => {
    const result = evaluateDeployScript(`set -euo pipefail
MODE="deploy"
case "\${1:-}" in
  --digest-bump-only|--bump-only)
    MODE="digest-bump-only"
    shift
    ;;
esac
require kubectl
ROLLOUTS=(mnt-app mnt-web)
if [[ "\${MODE}" == "digest-bump-only" ]]; then
  log "done: \${SHORT_SHA} deployed and verified (digest bump only)"
  exit 0
fi
kubectl version >/dev/null
kubectl -n "$ARGO_NS" annotate "application/$APP_NAME" "argocd.argoproj.io/refresh=hard" --overwrite
for rollout in "\${ROLLOUTS[@]}"; do
  kubectl argo rollouts status "$rollout" -n "$NAMESPACE" --timeout 600s
done
for url in "\${ENDPOINTS[@]}"; do
  code="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 10 "$url")"
  if [[ "$code" != "200" ]]; then exit 1; fi
done
log "done: \${SHORT_SHA} deployed and verified"
`);

    assertHasFailure(
      result,
      "digest-bump-only mode must not claim deployment, rollout, pod-image, or endpoint verification",
    );
  });

  it("rejects deploy scripts that swallow rollout status failures", () => {
    const result = evaluateDeployScript(`set -euo pipefail
require kubectl
kubectl version >/dev/null
kubectl -n "$ARGO_NS" annotate "application/$APP_NAME" "argocd.argoproj.io/refresh=hard" --overwrite
ROLLOUTS=(mnt-app mnt-web)
for rollout in "\${ROLLOUTS[@]}"; do
  kubectl argo rollouts status "$rollout" -n "$NAMESPACE" --timeout 600s || true
done
log "done: \${SHORT_SHA} deployed and verified"
`);

    assertHasFailure(result, "must not swallow rollout status failures");
  });

  it("rejects removing one-shot, remote, or Argo revision guards from deploy automation", () => {
    const deploy = readFileSync(
      new URL("./deploy.sh", import.meta.url),
      "utf8",
    );
    assertHasFailure(
      evaluateDeployScript(
        deploy.replace(
          'scripts/check-production-promotion-authority.py" reset',
          'scripts/renamed-authority.py" reset',
        ),
      ),
      "reset the one-shot authorization",
    );
    assertHasFailure(
      evaluateDeployScript(
        deploy
          .replaceAll(
            'scripts/check-production-promotion-authority.py" remote',
            'scripts/renamed-authority.py" remote',
          )
          .replaceAll(
            "verify_argo_pre_refresh_revision",
            "renamed_argo_revision_check",
          ),
      ),
      "remote and Argo revisions before refresh",
    );
  });
});

function writeExecutable(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}

function runDeployWithStubs({
  deployArgs,
  kubectl,
  authority,
  hideKubectl = false,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "maintenance-deploy-test-"));
  const scriptsDir = join(dir, "scripts");
  const stubDir = join(dir, "bin");
  const bashEnv = join(dir, "bash-env");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(stubDir, { recursive: true });
  mkdirSync(join(dir, "deploy/apps/maintenance/overlays/prod"), {
    recursive: true,
  });
  writeFileSync(
    join(scriptsDir, "deploy.sh"),
    readFileSync(new URL("./deploy.sh", import.meta.url), "utf8"),
  );
  chmodSync(join(scriptsDir, "deploy.sh"), 0o755);
  writeExecutable(
    join(scriptsDir, "check-production-promotion-authority.py"),
    authority ??
      `#!/usr/bin/env python3
raise SystemExit(0)
`,
  );
  writeExecutable(
    join(scriptsDir, "bump-prod-digests.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
exit 0
`,
  );
  writeFileSync(
    join(dir, "deploy/apps/maintenance/overlays/prod/kustomization.yaml"),
    "images: []\n",
  );
  writeExecutable(
    join(stubDir, "git"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "diff" ]]; then exit 0; fi
if [[ "$1 $2" == "rev-parse --abbrev-ref" ]]; then echo main; exit 0; fi
if [[ "$1 $2" == "rev-parse HEAD" ]]; then echo ${"a".repeat(40)}; exit 0; fi
exit 0
`,
  );
  writeExecutable(
    join(stubDir, "gh"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" == "run list" ]]; then echo 12345; exit 0; fi
if [[ "$1 $2" == "run watch" ]]; then exit 0; fi
if [[ "$1 $2" == "run download" ]]; then
  name=""
  out=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --name) name="$2"; shift 2 ;;
      --dir) out="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  mkdir -p "$out"
  printf '%s' "sha256:${"c".repeat(64)}" > "$out/\${name}.txt"
  exit 0
fi
exit 0
`,
  );
  writeExecutable(
    join(stubDir, "curl"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '200'
`,
  );
  if (kubectl) {
    writeExecutable(join(stubDir, "kubectl"), kubectl);
  }
  if (hideKubectl) {
    writeFileSync(
      bashEnv,
      `command() {
  if [[ "\${1:-}" == "-v" && "\${2:-}" == "kubectl" ]]; then
    return 1
  fi
  builtin command "$@"
}
`,
      "utf8",
    );
  }

  const result = spawnSync(
    "bash",
    [join(scriptsDir, "deploy.sh"), ...(deployArgs ?? ["b".repeat(40)])],
    {
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${stubDir}:/usr/bin:/bin`,
        HOME: dir,
        ...(hideKubectl ? { BASH_ENV: bashEnv } : {}),
      },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  return { ...result, combined: `${result.stdout}\n${result.stderr}` };
}

describe("deploy.sh rollout verification fail-closed behavior", () => {
  it("fails instead of claiming deployment success when kubectl is missing", () => {
    const result = runDeployWithStubs({ hideKubectl: true });

    assert.notEqual(result.status, 0, result.combined);
    assert.match(result.combined, /kubectl/i);
    assert.doesNotMatch(result.combined, /deployed and verified/);
  });

  it("fails instead of claiming deployment success when the cluster is unavailable", () => {
    const result = runDeployWithStubs({
      kubectl: `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "version" ]]; then echo "cluster unreachable" >&2; exit 1; fi
exit 0
`,
    });

    assert.notEqual(result.status, 0, result.combined);
    assert.match(result.combined, /cluster|kubectl/i);
    assert.doesNotMatch(result.combined, /deployed and verified/);
  });

  it("exits successfully in explicit digest-bump-only modes without claiming verified rollout", () => {
    for (const flag of ["--digest-bump-only", "--bump-only"]) {
      const result = runDeployWithStubs({ deployArgs: [flag, "b".repeat(40)] });

      assert.equal(result.status, 0, `${flag}: ${result.combined}`);
      assert.match(result.combined, /desired prod digests updated only/);
      assert.match(
        result.combined,
        /deployment, rollout, pod-image, and endpoint verification were NOT run/,
      );
      assert.doesNotMatch(result.combined, /deployed and verified/);
    }
  });

  it("never reaches Argo refresh when main advances on the digest-no-op pre-refresh path", () => {
    const logPath = join(
      tmpdir(),
      `maintenance-deploy-kubectl-${process.pid}-${Date.now()}.log`,
    );
    const authority = `#!/usr/bin/env python3
import pathlib, sys
counter = pathlib.Path("remote-count")
mode = sys.argv[1]
if mode == "remote":
    count = int(counter.read_text() if counter.exists() else "0") + 1
    counter.write_text(str(count))
    if count >= 2:
        print("origin/main advanced before Argo refresh", file=sys.stderr)
        raise SystemExit(1)
raise SystemExit(0)
`;
    const kubectl = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$*" == *"jsonpath="* ]]; then echo ${"b".repeat(40)}; fi
exit 0
`;
    const result = runDeployWithStubs({ authority, kubectl });
    const calls = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    rmSync(logPath, { force: true });
    assert.notEqual(result.status, 0, result.combined);
    assert.match(result.combined, /advanced before Argo refresh/);
    assert.doesNotMatch(calls, /argocd\.argoproj\.io\/refresh=hard/);
    assert.doesNotMatch(result.combined, /deployed and verified/);
  });
});
