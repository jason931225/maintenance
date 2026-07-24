#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createTextGate } from "./lib/text-gate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const textGate = createTextGate({
  root,
  includeFailure: ({ path, needle, label }) => `${label}: ${path} must include ${JSON.stringify(needle)}`,
  notIncludeFailure: ({ path, needle, label }) => `${label}: ${path} must not include ${JSON.stringify(needle)}`,
});
const { checks: passes, read, requireIncludes, requireNotIncludes } = textGate;

// The drift-inventory checks below collect (rather than throw) so every drift is
// reported at once; they surface through this failures[] gate at the end. The
// shared text-gate helpers throw on the first failure — both paths exit non-zero.
const failures = [];

function requireFile(path, label = path) {
  if (existsSync(resolve(root, path))) {
    passes.push(`${label}: present`);
    return;
  }
  throw new Error(`${label}: missing (${path})`);
}

function requireIncludesAtLeast(path, needle, minimumCount, label) {
  const text = read(path);
  const count = text.split(needle).length - 1;
  if (count >= minimumCount) {
    passes.push(`${label}: ${count} occurrences`);
    return;
  }
  throw new Error(`${label}: ${path} must include ${JSON.stringify(needle)} at least ${minimumCount} times (found ${count})`);
}

function requireAny(path, needles, label) {
  const text = read(path);
  if (needles.some((needle) => text.includes(needle))) {
    passes.push(label);
    return;
  }
  throw new Error(`${label}: ${path} must include one of ${needles.map((needle) => JSON.stringify(needle)).join(", ")}`);
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function markdownCodeListUnderHeading(path, heading) {
  const lines = read(path).split(/\r?\n/);
  const headingLine = `### ${heading}`;
  const start = lines.findIndex((line) => line.trim() === headingLine);
  if (start === -1) {
    failures.push(`${path}: missing heading ${headingLine}`);
    return [];
  }

  const entries = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{2,3}\s+/.test(line)) {
      break;
    }
    const match = line.match(/^\s*-\s+`([^`]+)`/);
    if (match) {
      entries.push(match[1]);
    }
  }

  if (entries.length === 0) {
    failures.push(`${path}: ${headingLine} must contain a markdown bullet list of backticked entries`);
  }
  return uniqueSorted(entries);
}

function compareInventory(label, documented, actual, docsPath, sourcePath) {
  const missing = actual.filter((entry) => !documented.includes(entry));
  const stale = documented.filter((entry) => !actual.includes(entry));

  if (missing.length > 0 || stale.length > 0) {
    const details = [];
    if (missing.length > 0) {
      details.push(`missing from ${docsPath}: ${missing.join(", ")}`);
    }
    if (stale.length > 0) {
      details.push(`documented but not found in ${sourcePath}: ${stale.join(", ")}`);
    }
    failures.push(`${label} drift: ${details.join("; ")}`);
  } else {
    passes.push(`${label} inventory matches ${sourcePath}`);
  }
}

function extractCiBackendGatePackages(ciText) {
  return uniqueSorted(
    [...ciText.matchAll(/\bcargo\s+run(?:\s+-q)?\s+-p\s+(mnt-gate-[a-z0-9-]+)/g)].map(
      ([, gatePackage]) => gatePackage,
    ),
  );
}

function extractCiNpmRunInvocations(ciText) {
  const invocations = [];
  for (const line of ciText.split(/\r?\n/)) {
    for (const match of line.matchAll(/\bnpm\s+run\s+([^\s&|;]+)([^&|;]*)/g)) {
      invocations.push({
        script: match[1].replace(/^['"]|['"]$/g, ""),
        options: match[2] ?? "",
      });
    }
  }
  return invocations;
}

function requireNoMissingPackageScripts(label, scripts, packageJson, packagePath, displayName = (script) => script) {
  const missing = scripts.filter((script) => !Object.hasOwn(packageJson.scripts ?? {}, script));
  if (missing.length > 0) {
    failures.push(`${label}: ${packagePath} is missing scripts used by CI: ${missing.map(displayName).join(", ")}`);
  } else {
    passes.push(`${label}: all CI-run package scripts exist in ${packagePath}`);
  }
}

function requireCiGateDocsDriftInventory() {
  const docsPath = "docs/CI-GATES.md";
  const ciPath = ".github/workflows/ci.yml";
  const rootPackagePath = "package.json";
  const webPackagePath = "web/package.json";

  const docs = read(docsPath);
  const ci = read(ciPath);
  const rootPackage = JSON.parse(read(rootPackagePath));
  const webPackage = JSON.parse(read(webPackagePath));
  const npmInvocations = extractCiNpmRunInvocations(ci);

  const backendGatePackages = extractCiBackendGatePackages(ci);
  const rootScripts = uniqueSorted(
    npmInvocations
      .filter(({ options }) => !/\s--workspace\s+/.test(options))
      .map(({ script }) => script),
  );
  const webScripts = uniqueSorted(
    npmInvocations
      .filter(({ options }) => /\s--workspace\s+(?:web|@console\/web)\b/.test(options))
      .map(({ script }) => script),
  );
  const unknownWorkspaceInvocations = npmInvocations
    .filter(({ options }) => /\s--workspace\s+/.test(options))
    .filter(({ options }) => !/\s--workspace\s+(?:web|@console\/web)\b/.test(options));

  if (!docs.includes("check:foundation-gates") || !docs.includes(".github/workflows/ci.yml")) {
    failures.push(`${docsPath}: CI drift inventory must name check:foundation-gates and .github/workflows/ci.yml as the source of truth`);
  }
  if (unknownWorkspaceInvocations.length > 0) {
    failures.push(
      `${ciPath}: npm workspace scripts are not covered by docs/CI-GATES.md drift policy: ${unknownWorkspaceInvocations
        .map(({ script, options }) => `${script}${options.trim() ? ` ${options.trim()}` : ""}`)
        .join(", ")}`,
    );
  }

  requireNoMissingPackageScripts("root CI package scripts", rootScripts, rootPackage, rootPackagePath);
  requireNoMissingPackageScripts("web-console CI package scripts", webScripts, webPackage, webPackagePath, (script) => `web:${script}`);

  compareInventory(
    "docs/CI-GATES.md backend mnt-gate binaries run by CI",
    markdownCodeListUnderHeading(docsPath, "Backend mnt-gate binaries run by CI"),
    backendGatePackages,
    docsPath,
    ciPath,
  );
  compareInventory(
    "docs/CI-GATES.md root package scripts run by CI",
    markdownCodeListUnderHeading(docsPath, "Root package scripts run by CI"),
    rootScripts,
    docsPath,
    `${ciPath} + ${rootPackagePath}`,
  );
  compareInventory(
    "docs/CI-GATES.md web console package scripts run by CI",
    markdownCodeListUnderHeading(docsPath, "Web console package scripts run by CI"),
    webScripts.map((script) => `web:${script}`),
    docsPath,
    `${ciPath} + ${webPackagePath}`,
  );
}

// Canonical backlog and foundation-gate docs.
requireFile("docs/specs/backlog-clearance-ledger.md", "G001 backlog ledger");
requireIncludes("docs/specs/backlog-clearance-ledger.md", "## Lane taxonomy", "G001 lane ownership matrix");
requireIncludes("docs/specs/backlog-clearance-ledger.md", "## Generated-client and contract rules", "G001 generated-client rules");
requireIncludes("docs/specs/backlog-clearance-ledger.md", "## Evidence and signoff columns required", "G001 evidence/signoff columns");
requireFile("docs/specs/foundation-gates.md", "G002 foundation-gates contract");
requireIncludes("docs/specs/foundation-gates.md", "FOUNDATION-GATE-READY: true", "foundation gate readiness marker");
requireIncludes("docs/specs/foundation-gates.md", "G002-wave-1-shared-contracts-and-hard-gat", "current G002 goal id recorded");
requireIncludes("docs/specs/foundation-gates.md", "Domain goals G003-G009 must not claim completion", "downstream domain-lane block");
requireIncludes("docs/specs/foundation-gates.md", "## Gate B — workflow/approval/action lifecycle baseline", "workflow/action lifecycle gate recorded");
requireIncludes("docs/specs/foundation-gates.md", "## Gate C — ontology/import/export/object-lineage baseline", "ontology/import/export gate recorded");
requireIncludes("docs/specs/foundation-gates.md", "## Gate E — UI shell/design/i18n/a11y/no-text-wall baseline", "UI no-text-wall gate recorded");
requireIncludes("docs/specs/foundation-gates.md", "omx team 6:executor", "supported team launch path recorded");

for (const staleGoal of ["G011", "G012", "G013", "G014", "G015", "G016", "G017", "G018", "G019", "G020", "G021", "G022", "G023", "G024", "G025", "G026", "G027", "G028", "G029", "G030", "W1A-W1H"]) {
  requireNotIncludes("docs/specs/foundation-gates.md", staleGoal, `foundation gate has no stale ${staleGoal} plan reference`);
}

// Policy/audit/passkey baseline. Explicit required gates plus any additional
// mnt-gate binary CI runs, so a newly wired gate cannot ship without its crate.
for (const gate of [
  "layer-boundary",
  "audit-coverage",
  "migration-safety",
  "tenant-isolation",
  "pii-no-logs",
  "rls-arming",
]) {
  requireFile(`backend/ci/gates/${gate}/Cargo.toml`, `backend ${gate} gate`);
}
for (const gatePackage of extractCiBackendGatePackages(read(".github/workflows/ci.yml"))) {
  const gate = gatePackage.replace(/^mnt-gate-/, "");
  requireFile(`backend/ci/gates/${gate}/Cargo.toml`, `backend ${gate} gate (CI-run)`);
}
requireIncludes("backend/openapi/openapi.yaml", "Sensitive actions require a fresh passkey step-up assertion", "object action passkey step-up contract");
requireIncludes("backend/openapi/openapi.yaml", "tenant RLS, feature authorization, and branch scope", "approval feed authz/RLS contract");
requireIncludes("backend/openapi/openapi.yaml", "Both required agreements must be accepted", "initial-login agreement acceptance contract");
requireIncludes("backend/openapi/openapi.yaml", "status update is a sensitive passkey step-up action", "account lifecycle passkey step-up contract");
requireIncludes("backend/openapi/openapi.yaml", "Append-only Policy Studio audit evidence", "policy audit evidence contract");

// CI/CD/security/release baseline.
requireIncludes("package.json", "\"check:foundation-gates\": \"node scripts/check-foundation-gates.mjs\"", "package script check:foundation-gates");
requireIncludes("package.json", "\"test:text-gate\": \"node --test scripts/lib/text-gate.test.mjs\"", "package script test:text-gate");
requireIncludes(".github/workflows/ci.yml", "npm run check:foundation-gates", "CI runs foundation gate contract");
requireIncludes(".github/workflows/ci.yml", "npm run test:text-gate", "CI runs shared text-gate tests");
requireIncludes(".github/workflows/ci.yml", "docs/specs/**", "CI watches docs/specs gate inputs");
requireIncludesAtLeast(".github/workflows/ci.yml", '"docs/CI-GATES.md"', 2, "CI watches CI gate documentation for push and pull_request");
requireCiGateDocsDriftInventory();
for (const ciNeedle of [
  "cargo fmt --all -- --check",
  "cargo clippy --all-targets -- -D warnings",
  "SQLX_OFFLINE=true cargo test",
  "cargo run -p mnt-gate-audit-coverage",
  "cargo run -p mnt-gate-pii-no-logs",
  "cargo run -p mnt-gate-rls-arming",
  "git diff --exit-code -- clients/ts clients/kotlin",
  "npm run check:openapi-app",
  "npm run test:contract",
]) {
  requireIncludes(".github/workflows/ci.yml", ciNeedle, `CI gate: ${ciNeedle}`);
}
for (const securityNeedle of [
  "trivy fs --scanners vuln,secret",
  "trivy config --severity HIGH,CRITICAL --exit-code 1",
  "cargo audit",
  "cargo deny --manifest-path backend/Cargo.toml check",
  "npm audit --audit-level=high",
]) {
  requireIncludes(".github/workflows/security.yml", securityNeedle, `security workflow: ${securityNeedle}`);
}
for (const releaseNeedle of [
  "workflow_run:",
  "Admit exact successful CI candidate",
  "Trivy scan both arches (fail on HIGH/CRITICAL)",
  "target: linux/amd64",
  "target: linux/arm64",
  "docker buildx imagetools create",
  "cosign sign --yes",
  "attest-build-provenance",
  "Promote signed digests to production overlay",
]) {
  requireIncludes(".github/workflows/image-release.yml", releaseNeedle, `image release gate: ${releaseNeedle}`);
}
requireIncludes(".github/workflows/release-please.yml", "RELEASE_PLEASE_TOKEN", "release-please token fallback documented");
requireIncludes("backend/rust-toolchain.toml", "channel = \"1.96.0\"", "Rust toolchain pinned to 1.96.0");

// UI shell/design/i18n/a11y baseline.
requireFile("e2e/fixtures/ux.ts", "browser UX fixture");
for (const uxNeedle of [
  "assertNoAxeViolations",
  "assertNoRawI18nKeys",
  "attachConsoleGuard",
  "critical/serious axe",
]) {
  requireIncludes("e2e/fixtures/ux.ts", uxNeedle, `UX fixture: ${uxNeedle}`);
}
requireIncludes("scripts/check-i18n.mjs", "web/scripts/check-ui-strings.mjs", "cross-surface i18n check includes web");
requireIncludes("web/package.json", "check-ui-strings.mjs", "web lint includes UI-string gate");
requireIncludes("web/src/components/shell/nav.ts", "visibleNavItemsForRoles", "role-aware shell navigation seam");
requireIncludes("web/src/components/shell/Sidebar.tsx", "ko.shell.mainNav", "authenticated shell navigation label");
requireIncludes("docs/benchmarks/enterprise-parity-matrix.md", "SAP Fiori", "enterprise UX benchmark matrix");
requireIncludes("docs/benchmarks/enterprise-parity-matrix.md", "Palantir", "ontology/operations benchmark matrix");

// Team launch path is verified without starting a tmux team during this gate.
// CI runners do not have the developer-local OMX context or ~/.codex role files,
// so this gate must rely on repo-owned evidence rather than local home state.
const foundationGateText = read("docs/specs/foundation-gates.md");
if (
  foundationGateText.includes("omx team 6:executor")
  && foundationGateText.includes("omx team [N:agent-type]")
  && foundationGateText.includes("~/.codex/agents/executor.toml")
) {
  passes.push("omx team 6:executor launch syntax and executor role metadata recorded in repo-owned gate contract");
} else {
  failures.push("omx team launch path evidence missing from docs/specs/foundation-gates.md");
}

if (failures.length) {
  console.error("Foundation gate check failed:\n" + failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

console.log(`Foundation gate check passed (${passes.length} checks).`);
for (const pass of passes) {
  console.log(`- ${pass}`);
}
