#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const passes = [];

function read(path) {
  const abs = resolve(root, path);
  if (!existsSync(abs)) {
    failures.push(`${path}: missing`);
    return "";
  }
  return readFileSync(abs, "utf8");
}

function requireFile(path, label = path) {
  if (existsSync(resolve(root, path))) {
    passes.push(`${label}: present`);
  } else {
    failures.push(`${label}: missing (${path})`);
  }
}

function requireIncludes(path, needle, label) {
  const text = read(path);
  if (text.includes(needle)) {
    passes.push(label);
  } else {
    failures.push(`${label}: ${path} must include ${JSON.stringify(needle)}`);
  }
}

function requireRegex(path, regex, label) {
  const text = read(path);
  if (regex.test(text)) {
    passes.push(label);
  } else {
    failures.push(`${label}: ${path} must match ${regex}`);
  }
}

function requireScript(name) {
  const pkg = JSON.parse(read("package.json"));
  if (pkg.scripts?.[name]) {
    passes.push(`package script ${name}: ${pkg.scripts[name]}`);
  } else {
    failures.push(`package script ${name}: missing`);
  }
}

// CI/CD and supply-chain release discipline.
requireScript("check:production-hardening");
requireIncludes(".github/workflows/ci.yml", "npm run check:production-hardening", "CI runs production-hardening contract");
requireIncludes(".github/workflows/security.yml", "npm run check:production-hardening", "Security workflow runs production-hardening contract");
for (const needle of [
  "Wait for CI success",
  "Trivy scan both arches (fail on HIGH/CRITICAL)",
  "docker buildx imagetools create",
  "cosign sign --yes",
  "attest-build-provenance",
  "bump-prod-digests",
  "ubuntu-24.04-arm",
  "target: linux/amd64",
  "target: linux/arm64",
]) {
  requireIncludes(".github/workflows/image-release.yml", needle, `image-release gate: ${needle}`);
}
for (const needle of [
  "trivy fs --scanners vuln,secret",
  "trivy config --severity HIGH,CRITICAL --exit-code 1",
  "cargo audit",
  "cargo deny --manifest-path backend/Cargo.toml check",
  "npm audit --audit-level=high",
]) {
  requireIncludes(".github/workflows/security.yml", needle, `security workflow gate: ${needle}`);
}
requireIncludes(".github/workflows/release-please.yml", "RELEASE_PLEASE_TOKEN", "release-please PR/token path documented");

// GitOps deploy must be immutable digest-based and Argo must follow main.
const prodOverlay = read("deploy/apps/maintenance/overlays/prod/kustomization.yaml");
const digestPins = [...prodOverlay.matchAll(/digest:\s*sha256:[0-9a-f]{64}/g)].length;
if (digestPins >= 2) {
  passes.push(`prod overlay digest pins: ${digestPins}`);
} else {
  failures.push("prod overlay must pin at least mnt-app and mnt-web by sha256 digest");
}
if (/^\s*newTag:/m.test(prodOverlay)) {
  failures.push("prod overlay must not use mutable newTag values");
} else {
  passes.push("prod overlay has no mutable newTag values");
}
for (const path of ["deploy/argocd/root.yaml", "deploy/argocd/apps/maintenance.yaml"]) {
  requireIncludes(path, "targetRevision: main", `${path} tracks main`);
}
for (const needle of ["argocd.argoproj.io/refresh=hard", "kubectl argo rollouts status", "console.knllogistic.com", "knllogistic.com"]) {
  requireIncludes("scripts/deploy.sh", needle, `deploy script gate: ${needle}`);
}

// Admission verification: real audit/warn policy exists, but remains opt-in
// until the sigstore policy-controller CRDs/controller are installed.
requireFile("deploy/apps/maintenance/components/admission-audit/kustomization.yaml", "admission-audit component");
requireFile("deploy/apps/maintenance/components/admission-audit/README.md", "admission-audit runbook");
for (const needle of [
  "kind: ClusterImagePolicy",
  "mode: warn",
  "ghcr.io/jason931225/mnt-app",
  "ghcr.io/jason931225/mnt-web",
  "https://token.actions.githubusercontent.com",
  "image-release\\.yml@refs/(heads/main|tags/v[0-9].*)",
  "https://fulcio.sigstore.dev",
  "https://rekor.sigstore.dev",
]) {
  requireIncludes("deploy/apps/maintenance/components/admission-audit/clusterimagepolicy.yaml", needle, `admission audit policy: ${needle}`);
}

// Backend production request envelope and telemetry coverage.
for (const needle of [
  "TimeoutLayer::with_status_code",
  "DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES)",
  "http_trace_layer()",
  "with_metrics(router, &state)",
  "path = %request.uri().path()",
  "router_layer_tests",
  "default_request_timeout_is_thirty_seconds",
]) {
  requireIncludes("backend/app/src/lib.rs", needle, `backend cross-cutting layer: ${needle}`);
}
requireFile("backend/app/slos/api-availability.openslo.yaml", "OpenSLO availability objective");
requireFile("backend/app/slos/api-latency.openslo.yaml", "OpenSLO latency objective");
requireFile("deploy/apps/maintenance/components/monitoring/servicemonitor.yaml", "Prometheus ServiceMonitor");
requireFile("deploy/apps/maintenance/components/monitoring/prometheusrule.yaml", "PrometheusRule SLO alerts");
for (const needle of ["/metrics", "MntApiAvailabilityBurn", "MntApiLatencyP99High", "Prometheus Operator"]) {
  const file = needle === "/metrics" ? "deploy/apps/maintenance/components/monitoring/servicemonitor.yaml" : needle === "Prometheus Operator" ? "deploy/apps/maintenance/components/monitoring/README.md" : "deploy/apps/maintenance/components/monitoring/prometheusrule.yaml";
  requireIncludes(file, needle, `monitoring contract: ${needle}`);
}
for (const needle of ["kind: StatefulSet", "name: mnt-mox", "r.xmox.nl/mox@sha256", "WebAPIHTTP", "MetricsHTTP", "volumeClaimTemplates"]) {
  requireIncludes("deploy/apps/maintenance/base/mox.yaml", needle, `mox dark stack: ${needle}`);
}
for (const needle of ["MNT_MAIL_MOX_BASE_URL", "http://mnt-mox.maintenance.svc:1080"]) {
  requireIncludes("deploy/apps/maintenance/base/configmap.yaml", needle, `mox app wiring: ${needle}`);
}
for (const needle of ["allow-app-egress-mox", "allow-mox-ingress-internal", "default-deny-egress-mox", "allow-mox-egress-app-webhook"]) {
  requireIncludes("deploy/apps/maintenance/base/networkpolicy.yaml", needle, `mox network policy: ${needle}`);
}
for (const needle of ["name: mnt-mox", "port: metrics", "MntMoxDown", "MntMoxWebhookFailures", "MntMoxQueueBacklog", "MntMoxPvcSaturation"]) {
  const file = needle === "port: metrics" || needle === "name: mnt-mox" ? "deploy/apps/maintenance/components/monitoring/servicemonitor.yaml" : "deploy/apps/maintenance/components/monitoring/prometheusrule.yaml";
  requireIncludes(file, needle, `mox observability: ${needle}`);
}
for (const forbidden of ["NodePort", "LoadBalancer", "port: 25", "AdminHTTP", "Submission:", "Submissions:"]) {
  const moxManifest = read("deploy/apps/maintenance/base/mox.yaml");
  if (moxManifest.includes(forbidden)) {
    failures.push(`mox dark stack must not expose public mail/admin surface: found ${forbidden}`);
  } else {
    passes.push(`mox dark stack excludes ${forbidden}`);
  }
}

// Secrets, backup/restore, object store lifecycle, and no false HA claims.
for (const needle of ["OCI Vault", "Sealed Secrets", "Never", "MNT_MAIL_MASTER_KEY"]) {
  requireIncludes("deploy/SECRETS.md", needle, `secrets runbook: ${needle}`);
}
requireRegex("deploy/SECRETS.md", /External\s+Secrets/, "secrets runbook: External Secrets upgrade path");
for (const needle of ["VM.Standard.A1.Flex 4 OCPU/24 GB", "≤200 GB block", "≤20 GB object", "never run a second A1", "OCI Vault"]) {
  requireIncludes("deploy/OPS-RUNBOOK.md", needle, `OCI free-tier/runbook: ${needle}`);
}
for (const needle of ["instances: 1", "Barman", "destinationPath: s3://mnt-db-backups/", "retentionPolicy", "kind: ScheduledBackup"]) {
  requireIncludes("deploy/apps/maintenance/base/database.yaml", needle, `CNPG backup/object-store contract: ${needle}`);
}
for (const needle of ["RPO: <= 5 minutes", "RTO: <= 1 hour", "pitr_drill_complete=ok"]) {
  requireIncludes("ops/dr/DR-POLICY.md", needle, `DR policy: ${needle}`);
}
requireRegex("docs/ENTERPRISE-READINESS.md", /single\s+free-tier node/, "no false HA claim: single free-tier node");
for (const needle of ["not an automatic failover", "No code change moves past that"]) {
  requireIncludes("docs/ENTERPRISE-READINESS.md", needle, `no false HA claim: ${needle}`);
}

if (failures.length) {
  console.error("Production hardening check failed:\n" + failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

console.log(`Production hardening check passed (${passes.length} checks).`);
for (const pass of passes) {
  console.log(`- ${pass}`);
}
