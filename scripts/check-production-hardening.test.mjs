import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import {
  evaluateAndroidE2eFailClosedChecks,
  evaluateAndroidE2eTokenHandoffChecks,
  evaluateCnpgContextChecks,
  evaluateDeployAutomationChecks,
  evaluateOnPremHaContextChecks,
  evaluateProdOverlayImageChecks,
  evaluateSmtpDeploymentChecks,
  evaluateWorkflowHardeningChecks,
} from "./check-production-hardening.mjs";

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

    assertHasFailure(result, "deploy/apps/maintenance/base/backend.yaml must explicitly require MNT_EMAIL_SMTP_USERNAME");
    assertHasFailure(result, "deploy/apps/maintenance/base/backend.yaml must explicitly require MNT_EMAIL_SMTP_PASSWORD");
    assertHasFailure(result, "deploy/apps/maintenance/base/worker.yaml must explicitly require MNT_EMAIL_SMTP_USERNAME");
  });

  it("accepts complete SMTP config with required secret-backed credentials", () => {
    const result = evaluateSmtp({
      "deploy/apps/maintenance/base/backend.yaml": workloadWithRequiredSmtpSecretRefs,
      "deploy/apps/maintenance/base/worker.yaml": workloadWithRequiredSmtpSecretRefs,
    });

    assert.deepEqual(result.failures, []);
    assert.match(result.passes.join("\n"), /SMTP production credential refs: mnt-app, mnt-worker/);
  });

  it("does not block explicit dev/e2e stub configs that omit SMTP relay fields", () => {
    const result = evaluateSmtp({
      "deploy/apps/maintenance/base/configmap.yaml": smtpConfigMapForDevE2eStub,
    });

    assert.deepEqual(result.failures, []);
    assert.match(result.passes.join("\n"), /SMTP relay disabled for explicit stub mode MNT_EMAIL_STUB_MODE=e2e/);
  });

  it("rejects no-relay production-like configs without explicit stub mode", () => {
    const result = evaluateSmtp({
      "deploy/apps/maintenance/base/configmap.yaml": smtpConfigMapWithoutRelayOrStub,
    });

    assertHasFailure(result, "must either configure non-secret MNT_EMAIL_* SMTP relay fields or set MNT_EMAIL_STUB_MODE");
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

    assert.ok(result.failures.some((failure) => failure.includes("on-prem-ha CNPG HA instances")));
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

    assert.ok(result.failures.some((failure) => failure.includes("must not use local-path")));
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

    assert.ok(result.failures.some((failure) => failure.includes("checksum behavior")));
  });

  it("rejects removing /spec/env when the base env contains non-checksum entries", () => {
    const result = evaluate({
      "deploy/apps/maintenance/base/database.yaml": validFiles["deploy/apps/maintenance/base/database.yaml"].replace(
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

    assert.ok(result.failures.some((failure) => failure.includes("oci-guest prod overlay CNPG shape")));
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

    assert.ok(result.failures.some((failure) => failure.includes("oci-guest CNPG base instances")));
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
    path === "deploy/apps/maintenance/overlays/prod/kustomization.yaml" ? text : "",
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

    assert.ok(result.failures.some((failure) => failure.includes("must pin at least mnt-app and mnt-web")));
    assert.ok(result.failures.some((failure) => failure.includes("must not use mutable newTag values")));
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

    assert.ok(result.failures.some((failure) => failure.includes("must pin at least mnt-app and mnt-web")));
    assert.deepEqual(
      result.failures.filter((failure) => failure.includes("must not use mutable newTag values")),
      [],
    );
  });
});

const validWorkflowFiles = {
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
jobs:
  ci-gate:
    steps:
      - name: Wait for CI success
        run: bash scripts/wait-for-protected-main-ci.sh
  images:
    steps:
      - name: Trivy scan (fail on HIGH/CRITICAL)
        run: trivy image --severity HIGH,CRITICAL --exit-code 1 "$IMAGE_NAME@$DIGEST"
      - name: Sign the image
        run: cosign sign --yes "$IMAGE_NAME@$DIGEST"
      - name: Attest build provenance
        uses: actions/attest-build-provenance@v4
  bump-digests:
    steps:
      - name: Bump prod overlay digests
        run: bash scripts/bump-prod-digests.sh "$APP_DIGEST" "$WEB_DIGEST"
`,
  "scripts/wait-for-protected-main-ci.sh": `#!/usr/bin/env bash
set -euo pipefail
runs="$(gh run list --workflow ci.yml --commit "$SHA" --event push --branch main --json status,conclusion,url,event,headBranch)"
runs="$(jq '[.[] | select(.event == "push" and .headBranch == "main")]' <<<"$runs")"
conclusion="$(jq -r '.[0].conclusion // ""' <<<"$runs")"
if [[ "$conclusion" == "success" ]]; then exit 0; fi
exit 1
`,
};

function evaluateWorkflows(overrides = {}) {
  const files = { ...validWorkflowFiles, ...overrides };
  return evaluateWorkflowHardeningChecks((path) => files[path] ?? "");
}

describe("production hardening workflow gates", () => {
  it("accepts active CI, security, and image-release workflow gates", () => {
    assert.deepEqual(evaluateWorkflows().failures, []);
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
  UNUSED_RELEASE_TEXT: "Wait for CI success Trivy scan (fail on HIGH/CRITICAL) cosign sign --yes attest-build-provenance bump-prod-digests"
# - name: Wait for CI success
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

    assertHasFailure(result, "CI must run npm run check:production-hardening as an active step");
    assertHasFailure(result, "Security workflow must run npm run check:production-hardening as an active step");
    assertHasFailure(result, "security workflow must actively run trivy fs --scanners vuln,secret");
    assertHasFailure(result, "image-release must actively wait for successful protected-main push CI");
    assertHasFailure(result, "image-release must actively cosign sign");
  });
});

const validAndroidE2eTokenFiles = {
  ".github/workflows/ci.yml": `name: CI
jobs:
  android-instrumented:
    steps:
      - name: Mint a real backend session for the test user
        env:
          FIELD_E2E_BASE_URL: fake-url
          FIELD_E2E_SEED_REFRESH_TOKEN: fake-seed
        run: |
          if [ -z "$FIELD_E2E_BASE_URL" ] || [ -z "$FIELD_E2E_SEED_REFRESH_TOKEN" ]; then
            echo "No backend E2E secrets configured; instrumented test will self-skip."
            echo "FIELD_E2E_SESSION_ASSETS_DIR=" >> "$GITHUB_ENV"
            exit 0
          fi
          printf '::add-mask::%s\\n' "$FIELD_E2E_SEED_REFRESH_TOKEN"
          session_assets_dir="\${RUNNER_TEMP}/android-e2e-session-assets"
          session_file="\${session_assets_dir}/field-e2e-session.properties"
          rm -rf "$session_assets_dir"
          install -d -m 700 "$session_assets_dir"
          resp=$(curl -fsS -X POST "$FIELD_E2E_BASE_URL/api/v1/auth/refresh" \
            -H 'Content-Type: application/json' \
            -d "{\\"refresh_token\\":\\"$FIELD_E2E_SEED_REFRESH_TOKEN\\"}")
          access_token=$(printf '%s' "$resp" | jq -er '.access_token')
          refresh_token=$(printf '%s' "$resp" | jq -er '.refresh_token')
          printf '::add-mask::%s\\n' "$access_token"
          printf '::add-mask::%s\\n' "$refresh_token"
          umask 077
          {
            printf 'FIELD_E2E_ACCESS_TOKEN=%s\\n' "$access_token"
            printf 'FIELD_E2E_REFRESH_TOKEN=%s\\n' "$refresh_token"
          } > "$session_file"
          chmod 600 "$session_file"
          echo "FIELD_E2E_SESSION_ASSETS_DIR=$session_assets_dir" >> "$GITHUB_ENV"
      - name: Instrumented post-login E2E on Gradle Managed Device
        working-directory: android
        env:
          FIELD_E2E_SESSION_ASSETS_DIR: env.FIELD_E2E_SESSION_ASSETS_DIR
        run: |
          cleanup_session_fixture() {
            if [ -n "\${FIELD_E2E_SESSION_ASSETS_DIR:-}" ]; then
              rm -rf "$FIELD_E2E_SESSION_ASSETS_DIR"
              find app/build -type f -name 'field-e2e-session.properties' -delete 2>/dev/null || true
              find app/build -type f -name '*androidTest*.apk' -delete 2>/dev/null || true
            fi
          }
          trap cleanup_session_fixture EXIT
          ./gradlew fieldApi34DebugAndroidTest
`,
  "android/app/build.gradle.kts": `val fieldE2eSessionAssetsDir = providers.environmentVariable("FIELD_E2E_SESSION_ASSETS_DIR")
android {
    sourceSets {
        getByName("androidTest") {
            fieldE2eSessionAssetsDir.orNull
                ?.takeIf { it.isNotBlank() }
                ?.let { assets.srcDir(it) }
        }
    }
}
`,
  "android/app/src/androidTest/kotlin/com/maintenance/field/WorkOrderFlowTest.kt": `import androidx.test.platform.app.InstrumentationRegistry
import com.maintenance.field.data.session.SessionTokenStore
import java.util.Properties

class WorkOrderFlowTest {
    private val sessionStore = SessionTokenStore(ApplicationProvider.getApplicationContext())

    private fun loadE2eSessionTokens(): E2eSessionTokens? {
        val properties = Properties()
        InstrumentationRegistry.getInstrumentation()
            .context
            .assets
            .open("field-e2e-session.properties")
            .use { properties.load(it) }
        val access = properties.getProperty("FIELD_E2E_ACCESS_TOKEN")
        val refresh = properties.getProperty("FIELD_E2E_REFRESH_TOKEN")
        return E2eSessionTokens(access, refresh)
    }
}
`,
};

function evaluateAndroidE2eTokenHandoff(overrides = {}) {
  const files = { ...validAndroidE2eTokenFiles, ...overrides };
  return evaluateAndroidE2eTokenHandoffChecks((path) => files[path] ?? "");
}

describe("production hardening Android E2E token handoff", () => {
  it("accepts masked androidTest asset fixture handoff with no raw-token Gradle arguments", () => {
    const result = evaluateAndroidE2eTokenHandoff();

    assert.deepEqual(result.failures, []);
    assert.match(result.passes.join("\n"), /Android E2E session asset fixture is chmod-restricted/);
    assert.match(result.passes.join("\n"), /Android E2E Gradle invocation avoids raw token arguments/);
  });

  it("rejects the old GitHub-output and Gradle instrumentation-argument token handoff", () => {
    const result = evaluateAndroidE2eTokenHandoff({
      ".github/workflows/ci.yml": `name: CI
jobs:
  android-instrumented:
    steps:
      - name: Mint a real backend session for the test user
        id: session
        run: |
          resp=$(curl -fsS -X POST "$FIELD_E2E_BASE_URL/api/v1/auth/refresh" \
            -d "{\\"refresh_token\\":\\"$FIELD_E2E_SEED_REFRESH_TOKEN\\"}")
          echo "access=$(echo "$resp" | jq -r '.access_token')" >> "$GITHUB_OUTPUT"
          echo "refresh=$(echo "$resp" | jq -r '.refresh_token')" >> "$GITHUB_OUTPUT"
      - name: Instrumented post-login E2E on Gradle Managed Device
        run: |
          ./gradlew fieldApi34DebugAndroidTest \
            -Pandroid.testInstrumentationRunnerArguments.FIELD_E2E_ACCESS_TOKEN="steps.session.outputs.access" \
            -Pandroid.testInstrumentationRunnerArguments.FIELD_E2E_REFRESH_TOKEN="steps.session.outputs.refresh"
`,
      "android/app/build.gradle.kts": `android { }
`,
      "android/app/src/androidTest/kotlin/com/maintenance/field/WorkOrderFlowTest.kt": `class WorkOrderFlowTest {
    private val arguments = InstrumentationRegistry.getArguments()
    private val accessToken = arguments.getString("FIELD_E2E_ACCESS_TOKEN")
    private val refreshToken = arguments.getString("FIELD_E2E_REFRESH_TOKEN")
}
`,
    });

    assertHasFailure(result, "Android E2E token mint step must mask the seed token before refreshing");
    assertHasFailure(result, "Android E2E token handoff must not write access/refresh tokens to GITHUB_OUTPUT");
    assertHasFailure(result, "Android E2E Gradle invocation must not pass access/refresh tokens as instrumentation arguments");
    assertHasFailure(result, "Android Gradle must expose FIELD_E2E_SESSION_ASSETS_DIR as androidTest assets");
    assertHasFailure(result, "WorkOrderFlowTest must read FIELD_E2E tokens from the androidTest asset fixture");
  });

  it("keeps sentinel values out of captured dry-run logs and Gradle argv while writing the valid asset fixture", () => {
    const dir = mkdtempSync(join(tmpdir(), "maintenance-android-e2e-token-test-"));
    const accessToken = "sentinel-access-token-issue-361";
    const refreshToken = "sentinel-refresh-token-issue-361";
    const seedToken = "sentinel-seed-refresh-token-issue-361";
    const masks = [];
    const visibleLog = [];
    const addMask = (value) => masks.push(value);
    const emit = (line) => {
      visibleLog.push(masks.reduce((redacted, mask) => redacted.split(mask).join("***"), line));
    };

    addMask(seedToken);
    const sessionAssetsDir = join(dir, "android-e2e-session-assets");
    mkdirSync(sessionAssetsDir, { recursive: true, mode: 0o700 });
    const sessionFile = join(sessionAssetsDir, "field-e2e-session.properties");
    addMask(accessToken);
    addMask(refreshToken);
    writeFileSync(
      sessionFile,
      `FIELD_E2E_ACCESS_TOKEN=${accessToken}\nFIELD_E2E_REFRESH_TOKEN=${refreshToken}\n`,
      { mode: 0o600 },
    );
    chmodSync(sessionFile, 0o600);
    writeFileSync(join(dir, "github_env"), `FIELD_E2E_SESSION_ASSETS_DIR=${sessionAssetsDir}\n`, "utf8");

    const gradleArgv = ["./gradlew", "fieldApi34DebugAndroidTest"];
    writeFileSync(join(dir, "gradle-argv.log"), gradleArgv.join(" "), "utf8");
    emit("registered masks before exposing the androidTest asset fixture");
    emit(`gradle argv: ${gradleArgv.join(" ")}`);
    emit(`session fixture: ${sessionFile.split("/").pop()}`);
    const combined = visibleLog.join("\n");

    assert.doesNotMatch(combined, new RegExp(`${accessToken}|${refreshToken}|${seedToken}`));
    const gradleArgvText = readFileSync(join(dir, "gradle-argv.log"), "utf8");
    assert.doesNotMatch(gradleArgvText, new RegExp(`${accessToken}|${refreshToken}|${seedToken}`));
    assert.doesNotMatch(gradleArgvText, /android\.testInstrumentationRunnerArguments\.FIELD_E2E/);

    const fixture = readFileSync(sessionFile, "utf8");
    assert.match(fixture, new RegExp(`FIELD_E2E_ACCESS_TOKEN=${accessToken}`));
    assert.match(fixture, new RegExp(`FIELD_E2E_REFRESH_TOKEN=${refreshToken}`));
  });
});

const validAndroidE2eFailClosedFiles = {
  "package.json": JSON.stringify(
    {
      scripts: {
        "check:android-e2e-fail-closed": "node scripts/check-android-e2e-fail-closed.mjs",
      },
    },
    null,
    2,
  ),
  ".github/workflows/ci.yml": `name: CI
jobs:
  web:
    steps:
      - name: Android E2E fail-closed workflow guard
        run: npm run check:android-e2e-fail-closed
  android-instrumented:
    steps:
      - name: Mint a real backend session for the test user
        env:
          FIELD_E2E_BASE_URL: fake-url
          FIELD_E2E_SEED_REFRESH_TOKEN: fake-seed
          FIELD_E2E_REQUIRE_REAL_SESSION: \${{ github.event_name == 'push' && github.ref_type == 'branch' && github.ref_protected && '1' || '0' }}
        run: |
          set -euo pipefail
          if [ -z "\${FIELD_E2E_BASE_URL:-}" ] || [ -z "\${FIELD_E2E_SEED_REFRESH_TOKEN:-}" ]; then
            if [ "\${FIELD_E2E_REQUIRE_REAL_SESSION:-0}" = "1" ]; then
              echo "::error title=Required Android E2E real-session inputs are missing::Protected branch push runs require FIELD_E2E_BASE_URL and FIELD_E2E_SEED_REFRESH_TOKEN; refusing a false-green post-login gate."
              exit 1
            fi
            echo "::notice title=Optional Android E2E real-session gate skipped::FIELD_E2E_BASE_URL or FIELD_E2E_SEED_REFRESH_TOKEN is unavailable in this optional context."
            echo "FIELD_E2E_SESSION_ASSETS_DIR=" >> "$GITHUB_ENV"
            exit 0
          fi
          printf '::add-mask::%s\\n' "$FIELD_E2E_SEED_REFRESH_TOKEN"
          resp=$(curl -fsS -X POST "$FIELD_E2E_BASE_URL/api/v1/auth/refresh" \
            -H 'Content-Type: application/json' \
            -d "{\\"refresh_token\\":\\"$FIELD_E2E_SEED_REFRESH_TOKEN\\"}")
      - name: Instrumented post-login E2E on Gradle Managed Device
        run: ./gradlew fieldApi34DebugAndroidTest
`,
};

function evaluateAndroidE2eFailClosed(overrides = {}) {
  const files = { ...validAndroidE2eFailClosedFiles, ...overrides };
  return evaluateAndroidE2eFailClosedChecks((path) => files[path] ?? "");
}

describe("production hardening Android E2E fail-closed guard", () => {
  it("accepts a protected-branch fail-closed guard wired into CI", () => {
    const result = evaluateAndroidE2eFailClosed();

    assert.deepEqual(result.failures, []);
    assert.match(result.passes.join("\n"), /Android E2E required missing inputs fail closed before minting/);
    assert.match(result.passes.join("\n"), /Android E2E fail-closed guard runs before Gradle Managed Device execution/);
  });

  it("rejects the old missing-secret self-skip path that could false-green protected branches", () => {
    const result = evaluateAndroidE2eFailClosed({
      ".github/workflows/ci.yml": `name: CI
jobs:
  android-instrumented:
    steps:
      - name: Mint a real backend session for the test user
        run: |
          if [ -z "$FIELD_E2E_BASE_URL" ] || [ -z "$FIELD_E2E_SEED_REFRESH_TOKEN" ]; then
            echo "No backend E2E secrets configured; instrumented test will self-skip."
            echo "access=" >> "$GITHUB_OUTPUT"
            echo "refresh=" >> "$GITHUB_OUTPUT"
            exit 0
          fi
      - name: Instrumented post-login E2E on Gradle Managed Device
        run: ./gradlew fieldApi34DebugAndroidTest
`,
    });

    assertHasFailure(result, "must set FIELD_E2E_REQUIRE_REAL_SESSION from protected branch context");
    assertHasFailure(result, "must include an Android E2E missing-input guard");
    assertHasFailure(result, "must exit 1 for missing FIELD_E2E inputs");
    assertHasFailure(result, "must not use the old missing-secret path");
  });

  it("rejects require-real expressions that depend on secret presence", () => {
    const result = evaluateAndroidE2eFailClosed({
      ".github/workflows/ci.yml": validAndroidE2eFailClosedFiles[".github/workflows/ci.yml"].replace(
        "github.event_name == 'push' && github.ref_type == 'branch' && github.ref_protected && '1' || '0'",
        "github.event_name == 'push' && github.ref_protected && secrets.FIELD_E2E_BASE_URL && '1' || '0'",
      ),
    });

    assertHasFailure(result, "must not be conditioned on FIELD_E2E secret presence");
  });
});

function evaluateDeployScript(text) {
  return evaluateDeployAutomationChecks((path) => (path === "scripts/deploy.sh" ? text : ""));
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
    assertHasFailure(result, "must actively wait for both mnt-app and mnt-web rollouts");
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

    assertHasFailure(result, "digest-bump-only mode must not claim deployment, rollout, pod-image, or endpoint verification");
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
});

function writeExecutable(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}

function runDeployWithStubs({ deployArgs, kubectl } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "maintenance-deploy-test-"));
  const scriptsDir = join(dir, "scripts");
  const stubDir = join(dir, "bin");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(stubDir, { recursive: true });
  mkdirSync(join(dir, "deploy/apps/maintenance/overlays/prod"), { recursive: true });
  writeFileSync(join(scriptsDir, "deploy.sh"), readFileSync(new URL("./deploy.sh", import.meta.url), "utf8"));
  chmodSync(join(scriptsDir, "deploy.sh"), 0o755);
  writeExecutable(join(scriptsDir, "bump-prod-digests.sh"), `#!/usr/bin/env bash
set -euo pipefail
exit 0
`);
  writeFileSync(join(dir, "deploy/apps/maintenance/overlays/prod/kustomization.yaml"), "images: []\n");
  writeExecutable(join(stubDir, "git"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "diff" ]]; then exit 0; fi
if [[ "$1 $2" == "rev-parse --abbrev-ref" ]]; then echo main; exit 0; fi
if [[ "$1 $2" == "rev-parse HEAD" ]]; then echo ${"a".repeat(40)}; exit 0; fi
exit 0
`);
  writeExecutable(join(stubDir, "gh"), `#!/usr/bin/env bash
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
`);
  writeExecutable(join(stubDir, "curl"), `#!/usr/bin/env bash
set -euo pipefail
printf '200'
`);
  if (kubectl) {
    writeExecutable(join(stubDir, "kubectl"), kubectl);
  }

  const result = spawnSync("bash", [join(scriptsDir, "deploy.sh"), ...(deployArgs ?? ["b".repeat(40)])], {
    cwd: dir,
    env: { ...process.env, PATH: `${stubDir}:/usr/bin:/bin`, HOME: dir },
    encoding: "utf8",
    timeout: 10_000,
  });
  return { ...result, combined: `${result.stdout}\n${result.stderr}` };
}

describe("deploy.sh rollout verification fail-closed behavior", () => {
  it("fails instead of claiming deployment success when kubectl is missing", () => {
    const result = runDeployWithStubs();

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
      assert.match(result.combined, /deployment, rollout, pod-image, and endpoint verification were NOT run/);
      assert.doesNotMatch(result.combined, /deployed and verified/);
    }
  });
});
