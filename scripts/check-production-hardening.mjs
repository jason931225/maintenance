#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function read(path) {
  const abs = resolve(root, path);
  return existsSync(abs) ? readFileSync(abs, "utf8") : "";
}

function createResult() {
  return { failures: [], passes: [] };
}

function appendResult(target, source) {
  target.passes.push(...source.passes);
  target.failures.push(...source.failures);
}

function requirement(result, ok, passMessage, failureMessage) {
  if (ok) {
    result.passes.push(passMessage);
  } else {
    result.failures.push(failureMessage);
  }
}

function requirePresentText(result, readText, path, label = path) {
  const text = readText(path);
  requirement(
    result,
    text.trim().length > 0,
    `${label}: present`,
    `${label}: missing or empty (${path})`,
  );
  return text;
}

function requireIncludesInText(result, path, text, needle, label) {
  requirement(
    result,
    text.includes(needle),
    label,
    `${label}: ${path} must include ${JSON.stringify(needle)}`,
  );
}

function requireRegexInText(
  result,
  path,
  text,
  regex,
  label,
  failureDetail = `must match ${regex}`,
) {
  requirement(
    result,
    regex.test(text),
    label,
    `${label}: ${path} ${failureDetail}`,
  );
}

function requireTextIncludes(result, readText, path, needle, label) {
  requireIncludesInText(result, path, readText(path), needle, label);
}

function requirePackageScript(result, readText, name) {
  const pkgText = readText("package.json");
  let pkg;
  try {
    pkg = JSON.parse(pkgText);
  } catch (error) {
    result.failures.push(
      `package script ${name}: package.json must be valid JSON (${error.message})`,
    );
    return;
  }

  requirement(
    result,
    Boolean(pkg.scripts?.[name]),
    `package script ${name}: ${pkg.scripts?.[name]}`,
    `package script ${name}: missing from package.json scripts`,
  );
}

function stripYamlScalar(value) {
  if (value === undefined) return undefined;
  const withoutComment = String(value)
    .replace(/\s+#.*$/, "")
    .trim();
  if (
    (withoutComment.startsWith('"') && withoutComment.endsWith('"')) ||
    (withoutComment.startsWith("'") && withoutComment.endsWith("'"))
  ) {
    return withoutComment.slice(1, -1);
  }
  return withoutComment;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractYamlScalar(text, key) {
  const match = text.match(
    new RegExp(`^\\s*${escapeRegExp(key)}:\\s*(.+?)\\s*$`, "m"),
  );
  return stripYamlScalar(match?.[1]);
}

function extractJson6902PatchScalar(text, pointer) {
  const lines = text.split(/\r?\n/);
  const pathMatcher = new RegExp(`^\\s*path:\\s*${escapeRegExp(pointer)}\\s*$`);
  for (let index = 0; index < lines.length; index += 1) {
    if (!pathMatcher.test(lines[index])) continue;
    for (
      let valueIndex = index + 1;
      valueIndex < lines.length;
      valueIndex += 1
    ) {
      if (/^\s*-\s*op\s*:/.test(lines[valueIndex])) break;
      const valueMatch = lines[valueIndex].match(/^\s*value:\s*(.*)$/);
      if (valueMatch) return stripYamlScalar(valueMatch[1]);
    }
  }
  return undefined;
}

function json6902PatchHasPath(text, pointer) {
  return new RegExp(`^\\s*path:\\s*${escapeRegExp(pointer)}\\s*$`, "m").test(
    text,
  );
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function formatScalar(value) {
  return value === undefined || value === ""
    ? "missing"
    : JSON.stringify(value);
}

const SMTP_NON_SECRET_KEYS = Object.freeze([
  "MNT_EMAIL_SMTP_HOST",
  "MNT_EMAIL_SMTP_PORT",
  "MNT_EMAIL_FROM",
  "MNT_EMAIL_FROM_NAME",
]);

const SMTP_SECRET_KEYS = Object.freeze([
  "MNT_EMAIL_SMTP_USERNAME",
  "MNT_EMAIL_SMTP_PASSWORD",
]);

const SMTP_STUB_MODE_KEY = "MNT_EMAIL_STUB_MODE";
const SMTP_ALLOWED_STUB_MODES = Object.freeze([
  "local",
  "dev",
  "development",
  "test",
  "e2e",
]);

const SMTP_WORKLOADS = Object.freeze([
  { label: "mnt-app", path: "deploy/apps/maintenance/base/backend.yaml" },
  { label: "mnt-worker", path: "deploy/apps/maintenance/base/worker.yaml" },
]);

const CNPG_OCI_CHECKSUM_ENV_NAMES = Object.freeze([
  "AWS_REQUEST_CHECKSUM_CALCULATION",
  "AWS_RESPONSE_CHECKSUM_VALIDATION",
]);

function stripInlineHashComment(line) {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "#" && (index === 0 || /\s/.test(line[index - 1]))) {
      return line.slice(0, index);
    }
  }
  return line;
}

function stripHashComments(text) {
  return text.split(/\r?\n/).map(stripInlineHashComment).join("\n");
}

function activeYamlScalarKeys(text, keys) {
  const stripped = stripHashComments(text);
  return keys.filter((key) => {
    const value = extractYamlScalar(stripped, key);
    return value !== undefined && value !== "";
  });
}

function extractYamlMappingBlock(text, key, keyIndent) {
  const lines = stripHashComments(text).split(/\r?\n/);
  const matcher = new RegExp(`^\\s{${keyIndent}}${escapeRegExp(key)}:\\s*$`);
  for (let index = 0; index < lines.length; index += 1) {
    if (!matcher.test(lines[index])) continue;
    const block = [lines[index]];
    for (
      let blockIndex = index + 1;
      blockIndex < lines.length;
      blockIndex += 1
    ) {
      const line = lines[blockIndex];
      if (line.trim() === "") {
        block.push(line);
        continue;
      }
      if (countLeadingSpaces(line) <= keyIndent) break;
      block.push(line);
    }
    return block.join("\n");
  }
  return "";
}

function countLeadingSpaces(line) {
  return line.match(/^\s*/)?.[0].length ?? 0;
}

function normalizeCommandText(text) {
  return text
    .replace(/\\\r?\n\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractGithubWorkflowRunBlocks(text) {
  const lines = stripHashComments(text).split(/\r?\n/);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const runMatch = lines[index].match(/^(\s*)(?:-\s*)?run:\s*(.*)$/);
    if (!runMatch) continue;
    const indent = runMatch[1].length;
    const scalar = runMatch[2].trim();
    if (/^[|>][+-]?$/.test(scalar)) {
      const blockLines = [];
      for (
        let blockIndex = index + 1;
        blockIndex < lines.length;
        blockIndex += 1
      ) {
        const line = lines[blockIndex];
        if (line.trim() === "") {
          blockLines.push("");
          continue;
        }
        if (countLeadingSpaces(line) <= indent) break;
        blockLines.push(line.slice(Math.min(line.length, indent + 2)));
      }
      blocks.push(blockLines.join("\n"));
    } else if (scalar.length > 0) {
      blocks.push(stripYamlScalar(scalar));
    }
  }
  return blocks.map(normalizeCommandText);
}

function workflowHasRun(text, predicates) {
  const blocks = extractGithubWorkflowRunBlocks(text);
  return blocks.some((block) =>
    predicates.every((predicate) => predicate.test(block)),
  );
}

function findWorkflowRunBlock(text, predicates) {
  const blocks = extractGithubWorkflowRunBlocks(text);
  return (
    blocks.find((block) =>
      predicates.every((predicate) => predicate.test(block)),
    ) ?? ""
  );
}

function extractNamedWorkflowStep(text, name) {
  const lines = stripHashComments(text).split(/\r?\n/);
  const matcher = new RegExp(`^(\\s*)-\\s+name:\\s*${escapeRegExp(name)}\\s*$`);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(matcher);
    if (!match) continue;
    const indent = match[1].length;
    const block = [lines[index]];
    for (
      let blockIndex = index + 1;
      blockIndex < lines.length;
      blockIndex += 1
    ) {
      const line = lines[blockIndex];
      if (line.trim() === "") {
        block.push(line);
        continue;
      }
      if (countLeadingSpaces(line) <= indent) break;
      block.push(line);
    }
    return block.join("\n");
  }
  return "";
}

function patternsAppearInOrder(text, patterns) {
  let cursor = 0;
  for (const pattern of patterns) {
    const match = pattern.exec(text.slice(cursor));
    if (!match) return false;
    cursor += match.index + match[0].length;
  }
  return true;
}

function workflowHasActiveUse(text, regex) {
  return regex.test(stripHashComments(text));
}

function parseKustomizeImageEntries(text) {
  const lines = stripHashComments(text).split(/\r?\n/);
  const entries = [];
  let current;
  for (const line of lines) {
    const nameMatch = line.match(/^\s*-\s*name:\s*(.+?)\s*$/);
    if (nameMatch) {
      current = {
        name: stripYamlScalar(nameMatch[1]),
        digest: undefined,
        newTag: undefined,
      };
      entries.push(current);
      continue;
    }
    if (!current) continue;
    const fieldMatch = line.match(/^\s*(digest|newTag):\s*(.+?)\s*$/);
    if (fieldMatch) current[fieldMatch[1]] = stripYamlScalar(fieldMatch[2]);
  }
  return entries;
}

function extractYamlSequenceItemNames(text, key, keyIndent = 2) {
  const lines = stripHashComments(text).split(/\r?\n/);
  const keyMatcher = new RegExp(`^\\s{${keyIndent}}${escapeRegExp(key)}:\\s*$`);
  for (let index = 0; index < lines.length; index += 1) {
    if (!keyMatcher.test(lines[index])) continue;
    const names = [];
    for (
      let blockIndex = index + 1;
      blockIndex < lines.length;
      blockIndex += 1
    ) {
      const line = lines[blockIndex];
      if (line.trim() === "") continue;
      if (countLeadingSpaces(line) <= keyIndent) break;
      const nameMatch = line.match(/^\s*-\s*name:\s*(.+?)\s*$/);
      if (nameMatch) names.push(stripYamlScalar(nameMatch[1]));
    }
    return names.filter(Boolean);
  }
  return [];
}

function extractEnvVarBlock(text, envName) {
  const lines = stripHashComments(text).split(/\r?\n/);
  const matcher = new RegExp(
    `^\\s*-\\s*name:\\s*${escapeRegExp(envName)}\\s*$`,
  );
  for (let index = 0; index < lines.length; index += 1) {
    if (!matcher.test(lines[index])) continue;
    const indent = countLeadingSpaces(lines[index]);
    const block = [lines[index]];
    for (
      let blockIndex = index + 1;
      blockIndex < lines.length;
      blockIndex += 1
    ) {
      const line = lines[blockIndex];
      if (/^---\s*$/.test(line)) break;
      if (line.trim() === "") {
        block.push(line);
        continue;
      }
      const lineIndent = countLeadingSpaces(line);
      if (lineIndent <= indent && /^\s*-\s*name\s*:/.test(line)) break;
      if (lineIndent < indent) break;
      block.push(line);
    }
    return block.join("\n");
  }
  return "";
}

function envVarRequiresSecretKeyRef(text, envName, secretName) {
  const block = extractEnvVarBlock(text, envName);
  if (!block || !/\bsecretKeyRef\s*:/.test(block)) return false;
  if (/^\s*optional\s*:\s*true\s*$/m.test(block)) return false;

  const quotedName = `["']?${escapeRegExp(secretName)}["']?`;
  const quotedKey = `["']?${escapeRegExp(envName)}["']?`;
  return (
    new RegExp(`\\bname:\\s*${quotedName}\\b`).test(block) &&
    new RegExp(`\\bkey:\\s*${quotedKey}\\b`).test(block)
  );
}

function braceDelta(line) {
  return (
    [...line].filter((char) => char === "{").length -
    [...line].filter((char) => char === "}").length
  );
}

function extractExecutableShellLines(text) {
  const lines = stripHashComments(text).split(/\r?\n/);
  const executable = [];
  let functionDepth = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (functionDepth > 0) {
      functionDepth = Math.max(0, functionDepth + braceDelta(line));
      continue;
    }
    if (
      /^(?:function\s+)?[A-Za-z_][A-Za-z0-9_]*\s*(?:\(\s*\))?\s*\{/.test(
        trimmed,
      )
    ) {
      functionDepth = Math.max(0, braceDelta(line));
      continue;
    }
    executable.push(line);
  }
  return executable;
}

function combineShellContinuations(lines) {
  const logical = [];
  let current = "";
  for (const line of lines) {
    const trimmedRight = line.trimEnd();
    if (trimmedRight.endsWith("\\")) {
      current += `${trimmedRight.slice(0, -1)} `;
      continue;
    }
    current += trimmedRight;
    if (current.trim()) logical.push(current.trim());
    current = "";
  }
  if (current.trim()) logical.push(current.trim());
  return logical;
}

function parseShellArray(logicalLines, name) {
  const match = logicalLines
    .join("\n")
    .match(new RegExp(`^\\s*${escapeRegExp(name)}\\s*=\\s*\\(([^)]*)\\)`, "m"));
  if (!match) return [];
  return [...match[1].matchAll(/"([^"]+)"|'([^']+)'|(\S+)/g)]
    .map((valueMatch) => valueMatch[1] ?? valueMatch[2] ?? valueMatch[3])
    .filter(Boolean);
}

function findFailOpenKubectlPrerequisiteBlocks(logicalLines) {
  const failures = [];
  for (let index = 0; index < logicalLines.length; index += 1) {
    const line = logicalLines[index];
    if (!/^if\s+!/.test(line) || !/\b(?:kubectl|have\s+kubectl)\b/.test(line))
      continue;
    let thenText = line
      .split(/\bthen\b/)
      .slice(1)
      .join("then");
    for (
      let blockIndex = index + 1;
      blockIndex < logicalLines.length;
      blockIndex += 1
    ) {
      const blockLine = logicalLines[blockIndex];
      if (/^(?:else|fi)\b/.test(blockLine)) break;
      thenText += `\n${blockLine}`;
    }
    if (!/\b(?:exit|return)\s+[1-9]\d*\b/.test(thenText)) failures.push(line);
  }
  return failures;
}

function findDigestBumpOnlyVerificationClaims(logicalLines) {
  return logicalLines.filter(
    (line) =>
      /\b(?:digest-bump-only|bump-only|digest bump only|desired prod digests updated only)\b/i.test(
        line,
      ) &&
      /\bdeployed and verified\b|\bdeployment\b.*\bverified\b|\brollout\b.*\bverified\b|\bendpoint\b.*\bverified\b/i.test(
        line,
      ),
  );
}

export function evaluateProdOverlayImageChecks(readText) {
  const result = createResult();
  const path = "deploy/apps/maintenance/overlays/prod/kustomization.yaml";
  const prodOverlay = requirePresentText(
    result,
    readText,
    path,
    "prod overlay kustomization",
  );
  const imageEntries = parseKustomizeImageEntries(prodOverlay);
  const requiredImages = ["mnt-app", "mnt-web"];
  const pinnedRequiredImages = requiredImages.filter((imageName) =>
    imageEntries.some(
      (entry) =>
        entry.name === imageName &&
        /^sha256:[0-9a-f]{64}$/.test(entry.digest ?? ""),
    ),
  );
  requirement(
    result,
    pinnedRequiredImages.length === requiredImages.length,
    `prod overlay digest pins: ${pinnedRequiredImages.length} (${pinnedRequiredImages.join(", ")})`,
    `${path} must pin at least mnt-app and mnt-web by immutable sha256 digest (found ${pinnedRequiredImages.length}); do not deploy mutable tags`,
  );

  const mutableTags = imageEntries.filter(
    (entry) => entry.newTag !== undefined,
  );
  requirement(
    result,
    mutableTags.length === 0,
    "prod overlay has no mutable newTag values",
    `${path} must not use mutable newTag values (found ${mutableTags
      .map((entry) => `${entry.name}:${entry.newTag}`)
      .map(JSON.stringify)
      .join(", ")})`,
  );
  return result;
}

const PR473_ROLLBACK_FLOOR = "f6ff236b9770c79301a3d07da6afb56be1e27bbf";
const PR473_MANIFEST_PATH = "docs/release/PR-473-EXPAND-CONTRACT.gate.json";
const PR473_WRAPPER_ALIAS =
  "python3 scripts/check-pr473-migration-operational.py";
const PR473_TEST_ALIAS =
  "python3 scripts/check-pr473-migration-operational.test.py";
const PR473_WRAPPER_COMMAND = "npm run check:pr473-migration-operational";
const PR473_TOPOLOGY_COMMAND = [
  'APP_PASSWORD="$(openssl rand -hex 32)"',
  'RT_PASSWORD="$(openssl rand -hex 32)"',
  'LEAVE_COMMAND_PASSWORD="$(openssl rand -hex 32)"',
  'ONTOLOGY_COMMAND_PASSWORD="$(openssl rand -hex 32)"',
  "docker run --rm --network host",
  '-v "$GITHUB_WORKSPACE/ops/postgres-reconcile-topology.sh:/usr/local/bin/postgres-reconcile-topology:ro"',
  "-e POSTGRES_HOST=127.0.0.1 -e POSTGRES_DB=mnt_ci",
  "-e POSTGRES_ADMIN_USER=postgres -e POSTGRES_ADMIN_PASSWORD=postgres",
  '-e MNT_APP_POSTGRES_PASSWORD="$APP_PASSWORD"',
  '-e MNT_RT_POSTGRES_PASSWORD="$RT_PASSWORD"',
  '-e MNT_LEAVE_COMMAND_POSTGRES_PASSWORD="$LEAVE_COMMAND_PASSWORD"',
  '-e MNT_ONTOLOGY_COMMAND_POSTGRES_PASSWORD="$ONTOLOGY_COMMAND_PASSWORD"',
  "--entrypoint bash postgres:18.4@sha256:4aabea78cf39b90e834caf3af7d602a18565f6fe2508705c8d01aa63245c2e20",
  "/usr/local/bin/postgres-reconcile-topology",
  "docker run --rm --network host",
  "-e PGPASSWORD=postgres",
  "--entrypoint psql",
  "postgres:18.4@sha256:4aabea78cf39b90e834caf3af7d602a18565f6fe2508705c8d01aa63245c2e20",
  "-h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1",
  '-c "DROP DATABASE IF EXISTS mnt_apalis_contract WITH (FORCE)"',
  '-c "CREATE DATABASE mnt_apalis_contract OWNER mnt_app"',
  'echo "::add-mask::$APP_PASSWORD"',
  'echo "::add-mask::$RT_PASSWORD"',
  "{",
  'echo "MNT_APALIS_OWNER_DATABASE_URL=postgres://mnt_app:${APP_PASSWORD}@localhost:5432/mnt_apalis_contract"',
  'echo "MNT_APALIS_RUNTIME_DATABASE_URL=postgres://mnt_rt:${RT_PASSWORD}@localhost:5432/mnt_apalis_contract"',
  'echo "MNT_APALIS_ADMIN_DATABASE_URL=postgres://postgres:postgres@localhost:5432/mnt_apalis_contract"',
  '} >> "$GITHUB_ENV"',
].join(" ");
const PR473_DOCUMENTS = [
  {
    path: "docs/release/PR-473-ONTOLOGY-EXPAND-CONTRACT.md",
    title: "# PR 473 Ontology Expand Contract",
  },
  {
    path: "docs/release/PR-473-EMPLOYEE-IMPORT-EXPAND-CONTRACT.md",
    title: "# PR 473 Employee-Import Expand Contract",
  },
];
const PR473_DIRECTIVES = [
  "<!-- PR473-MIGRATION-GATE: release_phase=expand -->",
  "<!-- PR473-MIGRATION-GATE: deployment_authorized=false -->",
  "<!-- PR473-MIGRATION-GATE: command_only_claim_authorized=false -->",
  "<!-- PR473-MIGRATION-GATE: production_authority=production_cardinality,old_runtime_drain,rollback_floor_raise -->",
];
const PR473_TESTS = [
  [
    "ontology",
    "mnt-ontology-adapter-postgres",
    "key_revision_migration_upgrade",
    "backend/crates/ontology/adapter-postgres/tests/key_revision_migration_upgrade.rs",
    "migration_0165_upgrades_legacy_sibling_versions_without_tenant_leakage",
  ],
  [
    "ontology",
    "mnt-ontology-adapter-postgres",
    "key_revision_migration_upgrade",
    "backend/crates/ontology/adapter-postgres/tests/key_revision_migration_upgrade.rs",
    "migration_0165_keeps_exact_old_binary_writes_audited_and_cas_consistent",
  ],
  [
    "ontology",
    "mnt-ontology-adapter-postgres",
    "key_revision_migration_upgrade",
    "backend/crates/ontology/adapter-postgres/tests/key_revision_migration_upgrade.rs",
    "migration_0165_rehearses_populated_expand_with_bounded_lock_and_statement_timeouts",
  ],
  [
    "leave",
    "mnt-leave-adapter-postgres",
    "leave_migration_expand_contract",
    "backend/crates/leave/adapter-postgres/tests/leave_migration_expand_contract.rs",
    "migration_0166_rehearses_populated_expand_with_bounded_lock_and_statement_timeouts",
  ],
  [
    "leave",
    "mnt-leave-adapter-postgres",
    "leave_migration_expand_contract",
    "backend/crates/leave/adapter-postgres/tests/leave_migration_expand_contract.rs",
    "exact_charge_create_accepts_resolved_and_review_required_shapes",
  ],
  [
    "leave",
    "mnt-leave-adapter-postgres",
    "leave_migration_expand_contract",
    "backend/crates/leave/adapter-postgres/tests/leave_migration_expand_contract.rs",
    "exact_charge_create_atomically_rejects_mismatched_reason_and_evidence_shapes",
  ],
  [
    "leave",
    "mnt-leave-adapter-postgres",
    "leave_migration_expand_contract",
    "backend/crates/leave/adapter-postgres/tests/leave_migration_expand_contract.rs",
    "immediate_f6ff_employee_import_remains_usable_after_0166",
  ],
  [
    "leave",
    "mnt-leave-adapter-postgres",
    "leave_migration_expand_contract",
    "backend/crates/leave/adapter-postgres/tests/leave_migration_expand_contract.rs",
    "staged_f6ff_employee_import_apply_remains_atomic_after_0166",
  ],
  [
    "leave",
    "mnt-leave-adapter-postgres",
    "leave_migration_expand_contract",
    "backend/crates/leave/adapter-postgres/tests/leave_migration_expand_contract.rs",
    "staged_f6ff_apply_rejects_missing_duplicate_or_forged_current_tx_audit",
  ],
  [
    "leave",
    "mnt-leave-adapter-postgres",
    "leave_migration_expand_contract",
    "backend/crates/leave/adapter-postgres/tests/leave_migration_expand_contract.rs",
    "legacy_leave_mutations_require_exactly_one_same_transaction_audit",
  ],
  [
    "leave",
    "mnt-leave-adapter-postgres",
    "leave_migration_expand_contract",
    "backend/crates/leave/adapter-postgres/tests/leave_migration_expand_contract.rs",
    "staged_employee_import_rejects_payload_not_equal_to_immutable_ledger",
  ],
];

export function evaluateExpandContractReleaseChecks(readText) {
  const result = createResult();
  const manifestText = requirePresentText(
    result,
    readText,
    PR473_MANIFEST_PATH,
    "PR 473 typed migration gate manifest",
  );
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    result.failures.push(
      `PR 473 typed migration gate manifest must be valid JSON (${error.message})`,
    );
    return result;
  }

  requirement(
    result,
    manifestText === `${JSON.stringify(manifest, null, 2)}\n`,
    "PR 473 typed migration gate manifest: canonical JSON",
    "PR 473 typed migration gate manifest must use canonical two-space JSON with one trailing newline",
  );
  const expectedKeys = [
    "schema_version",
    "pull_request",
    "rollback_floor",
    "release_phase",
    "deployment_authorized",
    "command_only_claim_authorized",
    "production_authority",
    "guarded_tests",
  ];
  requirement(
    result,
    manifest &&
      typeof manifest === "object" &&
      !Array.isArray(manifest) &&
      JSON.stringify(Object.keys(manifest)) === JSON.stringify(expectedKeys),
    "PR 473 typed migration gate manifest: exact schema keys",
    "PR 473 typed migration gate manifest must have only the canonical ordered schema keys",
  );
  for (const [label, actual, expected] of [
    ["schema version", manifest?.schema_version, 1],
    ["pull request", manifest?.pull_request, 473],
    ["rollback floor", manifest?.rollback_floor, PR473_ROLLBACK_FLOOR],
    ["expand phase", manifest?.release_phase, "expand"],
    ["nondeploy", manifest?.deployment_authorized, false],
    ["nonclaim", manifest?.command_only_claim_authorized, false],
  ]) {
    requirement(
      result,
      actual === expected && typeof actual === typeof expected,
      `PR 473 typed migration gate ${label}: ${JSON.stringify(expected)}`,
      `PR 473 typed migration gate ${label} must be exactly ${JSON.stringify(expected)}`,
    );
  }
  const expectedProductionAuthority = {
    production_cardinality: false,
    old_runtime_drain: false,
    rollback_floor_raise: false,
  };
  requirement(
    result,
    JSON.stringify(manifest?.production_authority) ===
      JSON.stringify(expectedProductionAuthority),
    "PR 473 production-authority fields: all false",
    "PR 473 production-authority fields must be exactly production_cardinality, old_runtime_drain, and rollback_floor_raise set to false",
  );

  const tests = Array.isArray(manifest?.guarded_tests)
    ? manifest.guarded_tests
    : [];
  const tuples = tests.map((test) => [
    test?.domain,
    test?.package,
    test?.target,
    test?.source,
    test?.name,
  ]);
  const uniqueTuples = new Set(tuples.map((tuple) => JSON.stringify(tuple)));
  const uniqueNames = new Set(tuples.map((tuple) => tuple[4]));
  requirement(
    result,
    tests.length === 11 && uniqueTuples.size === 11 && uniqueNames.size === 11,
    "PR 473 guarded tests: 11 unique tuples and names",
    "PR 473 guarded tests must contain 11 unique tuples with 11 unique names",
  );
  requirement(
    result,
    JSON.stringify(tuples) === JSON.stringify(PR473_TESTS),
    "PR 473 guarded tests: exact expected 3 ontology and 8 leave tuples",
    "PR 473 guarded tests must equal the exact expected 3 ontology and 8 leave tuples in canonical order",
  );

  for (const document of PR473_DOCUMENTS) {
    const text = requirePresentText(
      result,
      readText,
      document.path,
      `PR 473 gate document ${document.path}`,
    );
    const canonicalPrefix = `${document.title}\n\n${PR473_DIRECTIVES.join("\n")}\n\n`;
    requirement(
      result,
      text.startsWith(canonicalPrefix),
      `PR 473 document directives form canonical block: ${document.path}`,
      `PR 473 document directives must form the canonical block immediately after the title in ${document.path}`,
    );
    for (const directive of PR473_DIRECTIVES) {
      const count = text.split(directive).length - 1;
      requirement(
        result,
        count === 1,
        `PR 473 document directive occurs once: ${document.path} ${directive}`,
        `PR 473 document directive must occur exactly once in ${document.path}: ${directive} (found ${count})`,
      );
    }
  }

  let packageJson;
  try {
    packageJson = JSON.parse(readText("package.json"));
  } catch (error) {
    result.failures.push(
      `PR 473 package alias requires valid package.json (${error.message})`,
    );
  }
  requirement(
    result,
    packageJson?.scripts?.["check:pr473-migration-operational"] ===
      PR473_WRAPPER_ALIAS,
    "PR 473 package alias: exact wrapper command",
    `PR 473 package alias must be exactly ${JSON.stringify(PR473_WRAPPER_ALIAS)}`,
  );
  requirement(
    result,
    packageJson?.scripts?.["test:pr473-migration-operational"] ===
      PR473_TEST_ALIAS,
    "PR 473 unit-test package alias: exact test command",
    `PR 473 unit-test package alias must be exactly ${JSON.stringify(PR473_TEST_ALIAS)}`,
  );

  const ciText = readText(".github/workflows/ci.yml");
  const activeCi = stripHashComments(ciText);
  const backendJob = extractYamlMappingBlock(activeCi, "backend", 2);
  const topologyStep = extractNamedWorkflowStep(
    backendJob,
    "Reconcile portable PostgreSQL role topology",
  );
  const wrapperStep = extractNamedWorkflowStep(
    backendJob,
    "PR 473 migration operational gate",
  );
  const topologyIndex = backendJob.indexOf(topologyStep);
  const wrapperIndex = backendJob.indexOf(wrapperStep);
  const invocationCount = extractGithubWorkflowRunBlocks(activeCi).filter(
    (block) => block === PR473_WRAPPER_COMMAND,
  ).length;
  const topologyRuns = extractGithubWorkflowRunBlocks(topologyStep);
  const topologyCommand = topologyRuns[0] ?? "";
  requirement(
    result,
    invocationCount === 1,
    "PR 473 CI wrapper invocation: exactly one active command",
    `PR 473 CI must contain exactly one active ${PR473_WRAPPER_COMMAND} invocation (found ${invocationCount})`,
  );
  requirement(
    result,
    topologyStep !== "" &&
      wrapperStep !== "" &&
      topologyIndex >= 0 &&
      wrapperIndex > topologyIndex,
    "PR 473 CI wrapper runs after PostgreSQL role topology",
    "PR 473 backend job must contain the topology and wrapper steps in that order",
  );
  requirement(
    result,
    topologyRuns.length === 1 && topologyCommand === PR473_TOPOLOGY_COMMAND,
    "PR 473 backend topology step invokes the exact pinned reconcile and Apalis database provisioning commands",
    "PR 473 backend topology step must invoke the exact reconcile command and Apalis database provisioning command, credential setup, URL exports, and masking through the pinned PostgreSQL image",
  );
  requirement(
    result,
    JSON.stringify(extractGithubWorkflowRunBlocks(wrapperStep)) ===
      JSON.stringify([PR473_WRAPPER_COMMAND]),
    "PR 473 named CI wrapper step runs the exact command",
    `PR 473 named CI wrapper step must run exactly ${PR473_WRAPPER_COMMAND}`,
  );
  requirement(
    result,
    /^\s*working-directory:\s*\.\s*$/m.test(wrapperStep),
    "PR 473 CI wrapper runs from repository root",
    "PR 473 CI wrapper step must set working-directory to the repository root",
  );

  return result;
}

export function evaluateWorkflowHardeningChecks(readText) {
  const result = createResult();
  const productionHardeningTestCommand =
    "npm run test:pr473-migration-operational && python3 scripts/check-production-promotion-authority.test.py && node --test scripts/check-production-authority-blocked.test.mjs scripts/check-production-hardening.test.mjs scripts/wait-for-protected-main-ci.test.mjs";
  const ciPath = ".github/workflows/ci.yml";
  const securityPath = ".github/workflows/security.yml";
  const imageReleasePath = ".github/workflows/image-release.yml";
  const protectedMainCiGatePath = "scripts/wait-for-protected-main-ci.sh";
  const promotionAuthorityPath =
    "scripts/check-production-promotion-authority.py";
  const productionAuthorizationPath =
    "docs/release/PR-473-PRODUCTION-PROMOTION.authorization.json";
  const productionEvidencePath =
    "docs/release/PR-473-PRODUCTION-CARDINALITY.evidence.json";
  const productionPromotionContractPath =
    "docs/release/PR-473-PRODUCTION-PROMOTION.md";
  const ciWorkflow = requirePresentText(
    result,
    readText,
    ciPath,
    "CI workflow",
  );
  const securityWorkflow = requirePresentText(
    result,
    readText,
    securityPath,
    "Security workflow",
  );
  const imageReleaseWorkflow = requirePresentText(
    result,
    readText,
    imageReleasePath,
    "image-release workflow",
  );
  const protectedMainCiGate = requirePresentText(
    result,
    readText,
    protectedMainCiGatePath,
    "protected-main CI gate script",
  );
  const promotionAuthority = requirePresentText(
    result,
    readText,
    promotionAuthorityPath,
    "production promotion authority verifier",
  );
  const productionAuthorizationText = requirePresentText(
    result,
    readText,
    productionAuthorizationPath,
    "production promotion authorization record",
  );
  const productionEvidenceText = requirePresentText(
    result,
    readText,
    productionEvidencePath,
    "production cardinality evidence template",
  );
  const productionPromotionContract = requirePresentText(
    result,
    readText,
    productionPromotionContractPath,
    "production promotion contract",
  );
  let productionAuthorization;
  try {
    productionAuthorization = JSON.parse(productionAuthorizationText);
  } catch (error) {
    result.failures.push(
      `production promotion authorization record must be valid JSON (${error.message})`,
    );
  }
  const expectedAuthorizationKeys = [
    "schema_version",
    "pull_request",
    "target",
    "release_phase",
    "rollback_floor",
    "desired_state_authority_cutover",
    "deployment_authorized",
    "command_only",
    "production_cardinality_evidence",
    "contract_authorities",
  ];
  const cardinalityEvidence =
    productionAuthorization?.production_cardinality_evidence;
  const cardinalityEvidenceText =
    typeof cardinalityEvidence?.path === "string"
      ? readText(cardinalityEvidence.path)
      : "";
  const cardinalityEvidenceHash = createHash("sha256")
    .update(cardinalityEvidenceText)
    .digest("hex");
  let productionEvidence;
  try {
    productionEvidence = JSON.parse(productionEvidenceText);
  } catch (error) {
    result.failures.push(
      `production cardinality evidence template must be valid JSON (${error.message})`,
    );
  }
  const expectedEvidenceKeys = [
    "schema_version",
    "target",
    "release_phase",
    "candidate_source_sha",
    "observed_running_revision",
    "observed_database_topology",
    "capacity_headroom",
    "backup_restore_proof",
    "evidence_author",
    "independent_reviewer",
    "charter",
    "observed_at",
    "prepared_at",
    "reviewed_at",
  ];
  requirement(
    result,
    productionAuthorizationText ===
      `${JSON.stringify(productionAuthorization, null, 2)}\n` &&
      JSON.stringify(Object.keys(productionAuthorization ?? {})) ===
        JSON.stringify(expectedAuthorizationKeys) &&
      productionAuthorization?.schema_version === 2 &&
      productionAuthorization?.pull_request === 473 &&
      productionAuthorization?.target === "production" &&
      productionAuthorization?.release_phase === "expand" &&
      productionAuthorization?.rollback_floor === PR473_ROLLBACK_FLOOR &&
      productionAuthorization?.desired_state_authority_cutover === false &&
      productionAuthorization?.deployment_authorized === false &&
      productionAuthorization?.command_only === false &&
      JSON.stringify(Object.keys(cardinalityEvidence ?? {})) ===
        JSON.stringify(["path", "sha256", "verified"]) &&
      cardinalityEvidence?.path === productionEvidencePath &&
      /^[0-9a-f]{64}$/.test(cardinalityEvidence?.sha256 ?? "") &&
      cardinalityEvidence?.sha256 === cardinalityEvidenceHash &&
      cardinalityEvidence?.verified === false &&
      productionEvidenceText ===
        `${JSON.stringify(productionEvidence, null, 2)}\n` &&
      JSON.stringify(Object.keys(productionEvidence ?? {})) ===
        JSON.stringify(expectedEvidenceKeys) &&
      productionEvidence?.candidate_source_sha === "0".repeat(40) &&
      productionEvidence?.independent_reviewer?.team_id === 0 &&
      productionEvidence?.evidence_author?.github_login ===
        "TEMPLATE_NOT_EVIDENCE" &&
      JSON.stringify(productionAuthorization?.contract_authorities) ===
        JSON.stringify({
          old_runtime_drain: false,
          rollback_floor_raise: false,
        }),
    "production promotion authorization: canonical schema-v2 false record",
    "production promotion authorization must be the canonical schema-v2 false-by-default production expand record",
  );
  requirement(
    result,
    /mutable `main`/.test(productionPromotionContract) &&
      /`desired_state_authority_cutover` field is immutable `false`/.test(
        productionPromotionContract,
      ) &&
      /activation remains \*\*BLOCKED\*\*/.test(productionPromotionContract) &&
      /separate, higher-authority ADR/.test(productionPromotionContract) &&
      /self-asserted strings whose provenance is not authenticated/.test(
        productionPromotionContract,
      ) &&
      /administrator bypass posture/.test(productionPromotionContract) &&
      /does \*\*not\*\* make mutable `main` a safe production desired-state authority/.test(
        productionPromotionContract,
      ),
    "production promotion contract: mutable-main activation block is explicit",
    "production promotion contract must state that mutable-main activation remains blocked pending a separate accepted desired-state-authority ADR/cutover",
  );
  let packageJson;
  try {
    packageJson = JSON.parse(readText("package.json"));
  } catch (error) {
    result.failures.push(
      `production-hardening test command requires valid package.json (${error.message})`,
    );
  }
  requirement(
    result,
    packageJson?.scripts?.["test:production-hardening"] ===
      productionHardeningTestCommand,
    "production-hardening tests execute the production promotion authority suite",
    "test:production-hardening must execute the production promotion authority test suite in the canonical fail-closed command",
  );
  requirement(
    result,
    packageJson?.scripts?.["check:production-authority-blocked"] ===
      "node scripts/check-production-authority-blocked.mjs" &&
      readText("scripts/check-production-authority-blocked.mjs").trim().length >
        0,
    "production authority blocked evaluator: explicit-SHA CLI wiring present",
    "production authority blocked evaluator and exact package CLI wiring must be present",
  );

  requirement(
    result,
    workflowHasRun(ciWorkflow, [/\bnpm\s+run\s+check:production-hardening\b/]),
    "CI runs production-hardening contract as an active step",
    "CI must run npm run check:production-hardening as an active step",
  );
  requirement(
    result,
    workflowHasRun(securityWorkflow, [
      /\bnpm\s+run\s+check:production-hardening\b/,
    ]),
    "Security workflow runs production-hardening contract as an active step",
    "Security workflow must run npm run check:production-hardening as an active step",
  );

  requirement(
    result,
    workflowHasRun(imageReleaseWorkflow, [
      /\bbash\s+scripts\/wait-for-protected-main-ci\.sh\b/,
    ]) &&
      [
        /\bgh\s+run\s+list\b/,
        /--workflow\s+ci\.yml\b/,
        /--commit\b/,
        /--event\s+push\b/,
        /--branch\s+main\b/,
        /\.event\s*==\s*["']push["']/,
        /\.headBranch\s*==\s*["']main["']/,
        /\bconclusion\b/,
        /\bsuccess\b/,
        /\bexit\s+1\b/,
      ].every((pattern) => pattern.test(protectedMainCiGate)),
    "image-release portable gate: active CI success wait",
    "image-release must actively wait for successful protected-main push CI for the same SHA and fail non-success conclusions",
  );

  const activeImageRelease = stripHashComments(imageReleaseWorkflow);
  const workflowDispatch = extractYamlMappingBlock(
    activeImageRelease,
    "workflow_dispatch",
    2,
  );
  const productionPromotionInput = extractYamlMappingBlock(
    workflowDispatch,
    "promote_production",
    6,
  );
  requirement(
    result,
    extractYamlScalar(productionPromotionInput, "required") === "true" &&
      extractYamlScalar(productionPromotionInput, "default") === "false" &&
      extractYamlScalar(productionPromotionInput, "type") === "boolean",
    "image-release production promotion: explicit required false-by-default boolean dispatch input",
    "image-release workflow_dispatch must declare promote_production as a required false-by-default boolean",
  );

  const bumpDigestJob = extractYamlMappingBlock(
    activeImageRelease,
    "bump-digests",
    2,
  );
  const promotionPreflightJob = extractYamlMappingBlock(
    activeImageRelease,
    "production-promotion-preflight",
    2,
  );
  const bumpDigestSteps = bumpDigestJob.indexOf("\n    steps:");
  const bumpDigestJobHeader =
    bumpDigestSteps >= 0
      ? bumpDigestJob.slice(0, bumpDigestSteps)
      : bumpDigestJob;
  requirement(
    result,
    /github\.event_name\s*==\s*["']workflow_dispatch["']/.test(
      bumpDigestJobHeader,
    ) &&
      /github\.ref\s*==\s*["']refs\/heads\/main["']/.test(
        bumpDigestJobHeader,
      ) &&
      /inputs\.promote_production\s*==\s*true/.test(bumpDigestJobHeader) &&
      /github\.run_attempt\s*==\s*1/.test(bumpDigestJobHeader) &&
      !/github\.event_name\s*==\s*["']push["']/.test(bumpDigestJobHeader),
    "image-release production promotion: manual dispatch on main with explicit true input",
    "image-release bump-digests must run only for an explicit workflow_dispatch on refs/heads/main with inputs.promote_production == true; push events must never mutate production",
  );
  requirement(
    result,
    promotionPreflightJob !== "" &&
      !/^\s{4}environment:/m.test(promotionPreflightJob) &&
      /^\s{6}contents:\s*read\s*$/m.test(promotionPreflightJob) &&
      /persist-credentials:\s*false/.test(promotionPreflightJob) &&
      /python3 scripts\/check-production-promotion-authority\.py initial/.test(
        promotionPreflightJob,
      ) &&
      /github\.run_attempt\s*==\s*1/.test(promotionPreflightJob) &&
      /production-promotion-preflight/.test(bumpDigestJobHeader),
    "image-release production promotion: unprotected read-only authorization preflight",
    "image-release must reject invalid authorization in an unprotected read-only preflight before the protected mutation job",
  );
  requirement(
    result,
    /^\s{4}environment:\s*["']?production["']?\s*$/m.test(bumpDigestJobHeader),
    "image-release production promotion: mutation job bound to production environment",
    "image-release must bind the mutation job to the production environment",
  );
  const exactCheckoutIndex = bumpDigestJob.search(
    /uses:\s*actions\/checkout@[0-9a-f]{40}[\s\S]*?ref:\s*\$\{\{\s*github\.sha\s*\}\}/,
  );
  const initialAuthorityIndex = bumpDigestJob.indexOf(
    "python3 scripts/check-production-promotion-authority.py initial",
  );
  const mutationIndex = bumpDigestJob.indexOf("scripts/bump-prod-digests.sh");
  const resetAuthorityIndex = bumpDigestJob.indexOf(
    "python3 scripts/check-production-promotion-authority.py reset",
  );
  const commitIndex = bumpDigestJob.indexOf("git commit");
  const prePushAuthorityIndex = bumpDigestJob.indexOf(
    "python3 scripts/check-production-promotion-authority.py pre-push",
  );
  const pushMatches =
    bumpDigestJob.match(/\bgit\s+push\s+origin\s+["']?HEAD:main["']?/g) ?? [];
  const pushIndex = bumpDigestJob.search(
    /\bgit\s+push\s+origin\s+["']?HEAD:main["']?/,
  );
  requirement(
    result,
    exactCheckoutIndex >= 0 &&
      initialAuthorityIndex > exactCheckoutIndex &&
      mutationIndex > initialAuthorityIndex &&
      resetAuthorityIndex > mutationIndex &&
      commitIndex > resetAuthorityIndex,
    "image-release production promotion: exact-SHA authorization and consumption",
    "image-release bump-digests must re-check github.sha, bump digests, reset one-shot authorization, and then commit",
  );
  requirement(
    result,
    commitIndex >= 0 &&
      prePushAuthorityIndex > commitIndex &&
      pushIndex > prePushAuthorityIndex &&
      pushMatches.length === 1,
    "image-release production promotion: immutable-main recheck precedes one push",
    "image-release bump-digests must re-check origin/main after commit and immediately precede exactly one normal HEAD:main push",
  );
  requirement(
    result,
    !/\bgit\s+(?:pull|rebase)\b|\brebase\b|\bretr(?:y|ies|ied|ying)\b|\bfor\s+attempt\b/i.test(
      bumpDigestJob,
    ),
    "image-release production promotion: no rebase or retry path",
    "image-release bump-digests must not pull, rebase, retry, or loop after a racing main push",
  );
  requirement(
    result,
    [
      /AUTHORIZATION_PATH\s*=\s*["']docs\/release\/PR-473-PRODUCTION-PROMOTION\.authorization\.json["']/,
      /CANONICAL_EVIDENCE_PATH\s*=\s*["']docs\/release\/PR-473-PRODUCTION-CARDINALITY\.evidence\.json["']/,
      /schema_version/,
      /authorized:\s*bool/,
      /pull_request/,
      /production_cardinality/,
      /old_runtime_drain/,
      /rollback_floor_raise/,
      /desired_state_authority_cutover/,
      /activation requires a separate accepted higher-authority ADR\/cutover/,
      /hashlib\.sha256/,
      /PurePosixPath/,
      /canonical_false/,
      /verify_evidence_schema/,
      /candidate_source_sha/,
      /independent_reviewer/,
      /team_id/,
      /commit_parent/,
      /diff-tree/,
      /git\(["']fetch["'],\s*["']--no-tags["'],\s*["']origin["'],\s*["']\+refs\/heads\/main:refs\/remotes\/origin\/main["']\)/,
      /git\(["']rev-parse["'],\s*["']HEAD["']\)/,
      /["']git["'],\s*["']show["'],\s*f["']\{expected_sha\}:\{path\}["']/,
      /git\(["']status["'],\s*["']--porcelain["'],\s*["']--untracked-files=no["']\)/,
      /keys are not exact/,
      /origin\/main advanced after authorization/,
    ].every((pattern) => pattern.test(promotionAuthority)),
    "production promotion verifier: immutable typed authorization state machine",
    "production promotion authority verifier must fail closed on immutable git-show inputs, exact schema-v2 types, evidence hash, false-to-true authorization, reset commit shape, and origin/main races",
  );
  requirement(
    result,
    workflowHasRun(bumpDigestJob, [
      /\bset\s+-euo\s+pipefail\b/,
      /check-production-promotion-authority\.py\s+reviewer-context/,
      /\bgh\s+api\b.*repos\/\$\{REPO\}\/environments\/production/,
      /prevent_self_review\s*==\s*true/,
      /\brequired_reviewers\b/,
      /reviewers\s*\|\s*length\)\s*==\s*1/,
      /reviewers\[0\]\.type\s*==\s*["']Team["']/,
      /reviewers\[0\]\.reviewer\.id\s*==\s*\$team_id/,
      /\$\{DISPATCHER,,\}/,
      /\$\{TRIGGERING_ACTOR,,\}/,
      /\$\{RUN_ATTEMPT\}/,
      /production promotion rejects workflow reruns/,
      /evidence_author_login/,
      /independent_reviewer_login/,
      /dispatcher must be distinct from the evidence author and independent evidence reviewer/,
    ]) &&
      /DISPATCHER:\s*\$\{\{\s*github\.actor\s*\}\}/.test(bumpDigestJob) &&
      /TRIGGERING_ACTOR:\s*\$\{\{\s*github\.triggering_actor\s*\}\}/.test(
        bumpDigestJob,
      ) &&
      /RUN_ATTEMPT:\s*\$\{\{\s*github\.run_attempt\s*\}\}/.test(
        bumpDigestJob,
      ) &&
      /^\s{6}actions:\s*read\s*$/m.test(bumpDigestJobHeader),
    "image-release production promotion: exact independent Team reviewer contract",
    "image-release production promotion must grant actions: read and fail closed unless the dispatcher is independent, prevent_self_review is true, and the exact immutable evidence Team ID is required",
  );

  const releaseProbe = extractYamlMappingBlock(
    activeImageRelease,
    "release-probe",
    2,
  );
  const releaseProbeCheckout = releaseProbe.search(
    /^\s*uses:\s*actions\/checkout@[0-9a-f]{40}\s*$/m,
  );
  const releaseProbeTopologyUse = releaseProbe.indexOf(
    "ops/postgres-reconcile-topology.sh",
  );
  const releaseProbeSteps = releaseProbe.indexOf("\n    steps:");
  const releaseProbeJobHeader =
    releaseProbeSteps >= 0
      ? releaseProbe.slice(0, releaseProbeSteps)
      : releaseProbe;
  requirement(
    result,
    /^\s{6}contents:\s*read\s*$/m.test(releaseProbeJobHeader),
    "image-release release-probe: job-level contents read permission",
    "image-release release-probe permissions must explicitly grant contents: read for its checkout",
  );
  requirement(
    result,
    releaseProbeCheckout >= 0 &&
      releaseProbeTopologyUse > releaseProbeCheckout &&
      /persist-credentials:\s*false/.test(
        releaseProbe.slice(releaseProbeCheckout, releaseProbeTopologyUse),
      ),
    "image-release release-probe: pinned credential-free checkout precedes local topology script use",
    "image-release release-probe must perform a SHA-pinned actions/checkout with persist-credentials: false before using ops/postgres-reconcile-topology.sh",
  );
  requirement(
    result,
    workflowHasRun(imageReleaseWorkflow, [
      /\btrivy\s+image\b/,
      /--exit-code\s+1\b/,
      /--severity\s+HIGH,CRITICAL\b/,
    ]),
    "image-release portable gate: active Trivy image scan fails HIGH/CRITICAL",
    "image-release must actively run a Trivy image scan with --exit-code 1 and HIGH,CRITICAL severity",
  );
  requirement(
    result,
    workflowHasRun(imageReleaseWorkflow, [/\bcosign\s+sign\s+--yes\b/]),
    "image-release portable gate: active cosign signing",
    "image-release must actively cosign sign the immutable image digest",
  );
  requirement(
    result,
    workflowHasActiveUse(
      imageReleaseWorkflow,
      /^\s*uses:\s*actions\/attest-build-provenance@/m,
    ),
    "image-release portable gate: active provenance attestation",
    "image-release must actively use actions/attest-build-provenance",
  );
  requirement(
    result,
    workflowHasRun(imageReleaseWorkflow, [
      /\bscripts\/bump-prod-digests\.sh\b/,
    ]),
    "image-release portable gate: active bump-prod-digests",
    "image-release must actively run scripts/bump-prod-digests.sh",
  );

  requirement(
    result,
    workflowHasRun(securityWorkflow, [
      /\btrivy\s+fs\b/,
      /--scanners\s+vuln,secret\b/,
      /--exit-code\s+1\b/,
    ]),
    "security workflow portable gate: active Trivy filesystem vuln/secret scan",
    "security workflow must actively run trivy fs --scanners vuln,secret with --exit-code 1",
  );
  requirement(
    result,
    workflowHasRun(securityWorkflow, [
      /\btrivy\s+config\b/,
      /--severity\s+HIGH,CRITICAL\b/,
      /--exit-code\s+1\b/,
    ]),
    "security workflow portable gate: active Trivy config scan",
    "security workflow must actively run trivy config with HIGH,CRITICAL and --exit-code 1",
  );
  requirement(
    result,
    workflowHasRun(securityWorkflow, [/\bcargo\s+audit\b/]),
    "security workflow portable gate: active cargo audit",
    "security workflow must actively run cargo audit",
  );
  requirement(
    result,
    workflowHasRun(securityWorkflow, [
      /\bcargo\s+deny\b/,
      /--manifest-path\s+backend\/Cargo\.toml\b/,
      /\bcheck\b/,
    ]),
    "security workflow portable gate: active cargo deny",
    "security workflow must actively run cargo deny --manifest-path backend/Cargo.toml check",
  );
  requirement(
    result,
    workflowHasRun(securityWorkflow, [/\bnpm\s+audit\s+--audit-level=high\b/]),
    "security workflow portable gate: active npm audit",
    "security workflow must actively run npm audit --audit-level=high",
  );

  return result;
}

export function evaluateAndroidE2eTokenHandoffChecks(readText) {
  const result = createResult();
  const ciPath = ".github/workflows/ci.yml";
  const gradlePath = "android/app/build.gradle.kts";
  const testPath =
    "android/app/src/androidTest/kotlin/com/maintenance/field/WorkOrderFlowTest.kt";
  const ciWorkflow = requirePresentText(
    result,
    readText,
    ciPath,
    "CI workflow",
  );
  const gradleFile = requirePresentText(
    result,
    readText,
    gradlePath,
    "Android app Gradle file",
  );
  const workOrderFlowTest = requirePresentText(
    result,
    readText,
    testPath,
    "Android instrumented WorkOrderFlowTest",
  );
  const activeCiWorkflow = stripHashComments(ciWorkflow);

  const mintBlock = findWorkflowRunBlock(ciWorkflow, [
    /FIELD_E2E_SEED_REFRESH_TOKEN/,
    /FIELD_E2E_SESSION_ASSETS_DIR|field-e2e-session\.properties/,
  ]);
  const activeMintBlock = stripHashComments(mintBlock);
  const gradleBlock = findWorkflowRunBlock(ciWorkflow, [
    /\.\/gradlew\s+fieldApi34DebugAndroidTest/,
  ]);

  requirement(
    result,
    patternsAppearInOrder(activeMintBlock, [
      /::add-mask::.*?FIELD_E2E_SEED_REFRESH_TOKEN/,
      /\bcurl\b.*\/api\/v1\/auth\/token\/refresh/,
    ]),
    "Android E2E seed token is masked before backend refresh",
    "Android E2E token mint step must mask the seed token before refreshing",
  );
  requirement(
    result,
    patternsAppearInOrder(activeCiWorkflow, [
      /access_token=.*jq\s+-er\s+['"]\.access_token['"]/,
      /refresh_token=.*jq\s+-er\s+['"]\.refresh_token['"]/,
      /::add-mask::.*access_token/,
      /::add-mask::.*refresh_token/,
      /FIELD_E2E_ACCESS_TOKEN=.*access_token/,
      /FIELD_E2E_REFRESH_TOKEN=.*refresh_token/,
    ]),
    "Android E2E minted access/refresh tokens are masked before fixture write",
    "Android E2E token mint step must mask minted access/refresh tokens before any fixture/log path",
  );
  requirement(
    result,
    /install\s+-d\s+-m\s+700\s+"?\$session_assets_dir"?/.test(
      activeCiWorkflow,
    ) &&
      /\bumask\s+077\b/.test(activeCiWorkflow) &&
      /chmod\s+600\s+"?\$session_file"?/.test(activeCiWorkflow) &&
      /FIELD_E2E_SESSION_ASSETS_DIR=.*GITHUB_ENV/.test(activeCiWorkflow),
    "Android E2E session asset fixture is chmod-restricted and env-addressed",
    "Android E2E session asset fixture must be created under mode 700, written under umask 077/chmod 600, and exposed only via FIELD_E2E_SESSION_ASSETS_DIR",
  );
  requirement(
    result,
    !/\bGITHUB_OUTPUT\b/.test(activeCiWorkflow) &&
      !/steps\.session\.outputs\.(?:access|refresh)\b/.test(activeCiWorkflow),
    "Android E2E token handoff avoids GitHub step outputs",
    "Android E2E token handoff must not write access/refresh tokens to GITHUB_OUTPUT",
  );
  requirement(
    result,
    Boolean(gradleBlock) &&
      !/android\.testInstrumentationRunnerArguments\.FIELD_E2E_(?:ACCESS|REFRESH)_TOKEN/.test(
        gradleBlock,
      ) &&
      !/FIELD_E2E_(?:ACCESS|REFRESH)_TOKEN/.test(gradleBlock) &&
      !/steps\.session\.outputs\.(?:access|refresh)\b/.test(gradleBlock),
    "Android E2E Gradle invocation avoids raw token arguments",
    "Android E2E Gradle invocation must not pass access/refresh tokens as instrumentation arguments",
  );

  requirement(
    result,
    /providers\.environmentVariable\("FIELD_E2E_SESSION_ASSETS_DIR"\)/.test(
      gradleFile,
    ) &&
      /sourceSets\s*\{[\s\S]*getByName\("androidTest"\)[\s\S]*assets\.srcDir/.test(
        gradleFile,
      ),
    "Android Gradle exposes FIELD_E2E_SESSION_ASSETS_DIR as androidTest assets",
    "Android Gradle must expose FIELD_E2E_SESSION_ASSETS_DIR as androidTest assets",
  );

  requirement(
    result,
    /InstrumentationRegistry\.getInstrumentation\(\)[\s\S]*\.context[\s\S]*\.assets[\s\S]*\.open\("field-e2e-session\.properties"\)/.test(
      workOrderFlowTest,
    ) &&
      /\bProperties\s*\(\s*\)/.test(workOrderFlowTest) &&
      /FIELD_E2E_ACCESS_TOKEN/.test(workOrderFlowTest) &&
      /FIELD_E2E_REFRESH_TOKEN/.test(workOrderFlowTest) &&
      /SessionTokenStore/.test(workOrderFlowTest) &&
      !/getArguments\s*\(\s*\)/.test(workOrderFlowTest),
    "WorkOrderFlowTest reads real tokens from androidTest asset fixture before seeding SessionTokenStore",
    "WorkOrderFlowTest must read FIELD_E2E tokens from the androidTest asset fixture",
  );

  return result;
}

export function evaluateAndroidE2eFailClosedChecks(readText) {
  const result = createResult();
  const ciPath = ".github/workflows/ci.yml";
  const ciWorkflow = requirePresentText(
    result,
    readText,
    ciPath,
    "CI workflow",
  );
  const activeCiWorkflow = stripHashComments(ciWorkflow);

  requirePackageScript(result, readText, "check:android-e2e-fail-closed");
  requirement(
    result,
    workflowHasRun(ciWorkflow, [
      /\bnpm\s+run\s+check:android-e2e-fail-closed\b/,
    ]),
    "CI runs Android E2E fail-closed workflow guard",
    `${ciPath} must actively run npm run check:android-e2e-fail-closed`,
  );

  const requireRealAssignment = ciWorkflow.match(
    /FIELD_E2E_REQUIRE_REAL_SESSION:\s*\$\{\{([^\n]+)\}\}/,
  );
  const requireRealExpression = requireRealAssignment?.[1] ?? "";
  requirement(
    result,
    Boolean(requireRealAssignment),
    "Android E2E protected-context require-real assignment present",
    `${ciPath} must set FIELD_E2E_REQUIRE_REAL_SESSION from protected branch context`,
  );
  requirement(
    result,
    /github\.event_name\s*==\s*'push'/.test(requireRealExpression) &&
      /github\.ref_type\s*==\s*'branch'/.test(requireRealExpression) &&
      /github\.ref_protected/.test(requireRealExpression),
    "Android E2E required context is protected branch push",
    `${ciPath} FIELD_E2E_REQUIRE_REAL_SESSION must be enabled for protected branch pushes`,
  );
  requirement(
    result,
    !/secrets\.FIELD_E2E_BASE_URL|secrets\.FIELD_E2E_SEED_REFRESH_TOKEN/.test(
      requireRealExpression,
    ),
    "Android E2E required context is independent of secret presence",
    `${ciPath} FIELD_E2E_REQUIRE_REAL_SESSION must not be conditioned on FIELD_E2E secret presence`,
  );

  const guardBlock = findWorkflowRunBlock(ciWorkflow, [
    /FIELD_E2E_REQUIRE_REAL_SESSION/,
    /Required Android E2E real-session inputs are missing/,
  ]);
  requirement(
    result,
    Boolean(guardBlock),
    "Android E2E missing-input guard block present",
    `${ciPath} must include an Android E2E missing-input guard in the session mint step`,
  );
  requirement(
    result,
    patternsAppearInOrder(guardBlock, [
      /FIELD_E2E_REQUIRE_REAL_SESSION/,
      /::error title=Required Android E2E real-session inputs are missing::/,
      /exit\s+1/,
    ]),
    "Android E2E required missing inputs fail closed before minting",
    `${ciPath} must exit 1 for missing FIELD_E2E inputs when FIELD_E2E_REQUIRE_REAL_SESSION=1`,
  );
  requirement(
    result,
    /::notice title=Optional Android E2E real-session gate skipped::/.test(
      guardBlock,
    ) &&
      /FIELD_E2E_SESSION_ASSETS_DIR=.*GITHUB_ENV/.test(guardBlock) &&
      /exit\s+0/.test(guardBlock),
    "Android E2E optional missing inputs skip truthfully",
    `${ciPath} optional/fork Android E2E contexts must emit an optional-skip notice and clear FIELD_E2E_SESSION_ASSETS_DIR`,
  );
  requirement(
    result,
    patternsAppearInOrder(activeCiWorkflow, [
      /::error title=Required Android E2E real-session inputs are missing::/,
      /\.\/gradlew\s+fieldApi34DebugAndroidTest/,
    ]),
    "Android E2E fail-closed guard runs before Gradle Managed Device execution",
    `${ciPath} must run the missing-input fail-closed guard before ./gradlew fieldApi34DebugAndroidTest`,
  );
  requirement(
    result,
    !/No backend E2E secrets configured; instrumented test will self-skip\./.test(
      activeCiWorkflow,
    ),
    "Android E2E legacy empty-token self-skip message absent",
    `${ciPath} must not use the old missing-secret path that minted empty token outputs and continued`,
  );

  return result;
}

export function evaluateSmtpDeploymentChecks(readText) {
  const result = createResult();
  const configPath = "deploy/apps/maintenance/base/configmap.yaml";
  const configMap = requirePresentText(
    result,
    readText,
    configPath,
    "maintenance runtime ConfigMap",
  );
  const activeRelayFields = activeYamlScalarKeys(
    configMap,
    SMTP_NON_SECRET_KEYS,
  );
  if (activeRelayFields.length === 0) {
    const stubMode = extractYamlScalar(
      stripHashComments(configMap),
      SMTP_STUB_MODE_KEY,
    )
      ?.trim()
      .toLowerCase();
    if (stubMode && SMTP_ALLOWED_STUB_MODES.includes(stubMode)) {
      result.passes.push(
        `SMTP relay disabled for explicit stub mode ${SMTP_STUB_MODE_KEY}=${stubMode}`,
      );
    } else {
      result.failures.push(
        `${configPath} must either configure non-secret MNT_EMAIL_* SMTP relay fields or set ${SMTP_STUB_MODE_KEY}=local|dev|development|test|e2e for an explicit non-production stub email config`,
      );
    }
    return result;
  }

  const completeWorkloads = [];
  for (const workload of SMTP_WORKLOADS) {
    const text = requirePresentText(
      result,
      readText,
      workload.path,
      `${workload.label} workload manifest`,
    );
    const missingKeys = SMTP_SECRET_KEYS.filter(
      (key) => !envVarRequiresSecretKeyRef(text, key, "mnt-secrets"),
    );
    if (missingKeys.length === 0) {
      completeWorkloads.push(workload.label);
      continue;
    }
    for (const key of missingKeys) {
      result.failures.push(
        `${workload.path} must explicitly require ${key} from mnt-secrets via secretKeyRef when ${configPath} sets ${activeRelayFields.join(", ")}; envFrom alone does not fail on missing Secret keys before rollout`,
      );
    }
  }

  if (completeWorkloads.length === SMTP_WORKLOADS.length) {
    result.passes.push(
      `SMTP production credential refs: ${completeWorkloads.join(", ")}`,
    );
  }
  return result;
}

export function evaluateArgoTargetRevisionChecks(readText) {
  const result = createResult();
  for (const path of [
    "deploy/argocd/root.yaml",
    "deploy/argocd/apps/maintenance.yaml",
  ]) {
    const text = requirePresentText(result, readText, path, path);
    const targetRevision = extractYamlScalar(
      stripHashComments(text),
      "targetRevision",
    );
    requirement(
      result,
      targetRevision === "main",
      `${path} tracks main`,
      `${path} must actively set targetRevision: main (found ${formatScalar(targetRevision)})`,
    );
  }
  return result;
}

export function evaluateDeployAutomationChecks(readText) {
  const result = createResult();
  const path = "scripts/deploy.sh";
  const deployScript = requirePresentText(
    result,
    readText,
    path,
    "deploy automation script",
  );
  const logicalLines = combineShellContinuations(
    extractExecutableShellLines(deployScript),
  );
  const executableText = logicalLines.join("\n");
  const rollouts = parseShellArray(logicalLines, "ROLLOUTS");
  const requiredRollouts = ["mnt-app", "mnt-web"];
  const missingRollouts = requiredRollouts.filter(
    (rollout) => !rollouts.includes(rollout),
  );
  requirement(
    result,
    missingRollouts.length === 0,
    `deploy automation rollouts covered: ${requiredRollouts.join(", ")}`,
    `${path} must actively wait for both mnt-app and mnt-web rollouts; ROLLOUTS must list both before claiming deployment verification (missing ${missingRollouts.join(", ") || "none"})`,
  );

  const failOpenBlocks = findFailOpenKubectlPrerequisiteBlocks(logicalLines);
  const hasKubectlRequire = logicalLines.some((line) =>
    /^require\s+kubectl\b/.test(line),
  );
  const kubectlCommandPrefix = /\b(?:kubectl|kubectl_required)\b/;
  const hasClusterReachabilityCheck = logicalLines.some(
    (line) => kubectlCommandPrefix.test(line) && /\bversion\b/.test(line),
  );
  requirement(
    result,
    hasKubectlRequire &&
      hasClusterReachabilityCheck &&
      failOpenBlocks.length === 0,
    "deploy automation kubectl prerequisite: fail-closed",
    `${path} must fail closed before endpoint checks when kubectl or the target cluster is unavailable`,
  );

  const hasActiveSkipPath =
    /\bskipp\w*\b[^\n]*(?:rollout|in-cluster|cluster)|(?:rollout|in-cluster|cluster)[^\n]*\bskipp\w*\b/i.test(
      executableText,
    );
  requirement(
    result,
    !hasActiveSkipPath,
    "deploy automation rollout skip path absent",
    `${path} must not contain an active rollout-skip path that can continue to endpoint/final success`,
  );

  const hasDigestBumpOnlyMode =
    /--digest-bump-only/.test(executableText) &&
    /--bump-only/.test(executableText) &&
    /MODE=.*digest-bump-only|digest-bump-only.*MODE/.test(executableText);
  const hasDigestBumpOnlyTruthfulMessage =
    /desired prod digests updated only/.test(executableText) &&
    /deployment, rollout, pod-image, and endpoint verification were NOT run/.test(
      executableText,
    );
  const digestBumpOnlyVerificationClaims =
    findDigestBumpOnlyVerificationClaims(logicalLines);
  requirement(
    result,
    hasDigestBumpOnlyMode &&
      hasDigestBumpOnlyTruthfulMessage &&
      digestBumpOnlyVerificationClaims.length === 0,
    "deploy automation digest-bump-only mode: truthful non-verification",
    `${path} digest-bump-only mode must not claim deployment, rollout, pod-image, or endpoint verification`,
  );

  if (/scripts\/bump-prod-digests\.sh/.test(executableText)) {
    const initialAuthorityIndex = executableText.indexOf(
      'scripts/check-production-promotion-authority.py" initial',
    );
    const mutationIndex = executableText.indexOf(
      "scripts/bump-prod-digests.sh",
    );
    const resetAuthorityIndex = executableText.indexOf(
      'scripts/check-production-promotion-authority.py" reset',
    );
    const commitIndex = executableText.indexOf("git commit");
    const prePushAuthorityIndex = executableText.indexOf(
      'scripts/check-production-promotion-authority.py" pre-push',
    );
    const pushIndex = executableText.indexOf(
      'git push origin "HEAD:${BRANCH}"',
    );
    const pushMatches =
      executableText.match(/git push origin "HEAD:\$\{BRANCH\}"/g) ?? [];
    const remoteChecks =
      executableText.match(
        /scripts\/check-production-promotion-authority\.py" remote/g,
      ) ?? [];
    requirement(
      result,
      initialAuthorityIndex >= 0 &&
        mutationIndex > initialAuthorityIndex &&
        resetAuthorityIndex > mutationIndex &&
        commitIndex > resetAuthorityIndex,
      "deploy automation production authorization precedes mutation and is consumed",
      `${path} must verify authorization before mutation and reset the one-shot authorization before commit`,
    );
    requirement(
      result,
      commitIndex >= 0 &&
        prePushAuthorityIndex > commitIndex &&
        pushIndex > prePushAuthorityIndex &&
        pushMatches.length === 1,
      "deploy automation immutable-main recheck precedes push",
      `${path} must re-check origin/main after commit and before its production push`,
    );
    requirement(
      result,
      remoteChecks.length >= 3 &&
        /verify_argo_pre_refresh_revision\s+"\$\{SHA\}"\s+"\$\{SHA\}"/.test(
          executableText,
        ) &&
        /verify_argo_pre_refresh_revision\s+"\$\{SHA\}"\s+"\$\{DEPLOY_REVISION\}"/.test(
          executableText,
        ),
      "deploy automation remote and Argo revisions are rechecked around refresh",
      `${path} must re-check exact remote and Argo revisions before refresh and after rollout/endpoint verification`,
    );
    requirement(
      result,
      !/\bgit\s+(?:pull|rebase)\b|\bfor\s+attempt\b|\bretr(?:y|ies|ied|ying)\b.{0,80}\bgit\s+push\b|\bgit\s+push\b.{0,80}\bretr(?:y|ies|ied|ying)\b/is.test(
        executableText,
      ),
      "deploy automation has no rebase or retry path",
      `${path} must not pull, rebase, retry, or loop after a racing main push`,
    );
  }

  const hasArgoHardRefresh = logicalLines.some(
    (line) =>
      kubectlCommandPrefix.test(line) &&
      /\bannotate\b/.test(line) &&
      /argocd\.argoproj\.io\/refresh=hard/.test(line) &&
      /--overwrite\b/.test(line),
  );
  requirement(
    result,
    hasArgoHardRefresh,
    "deploy automation Argo hard refresh: active",
    `${path} must actively request an Argo hard refresh before rollout verification`,
  );

  const rolloutStatusLines = logicalLines.filter(
    (line) =>
      kubectlCommandPrefix.test(line) &&
      /\bargo\s+rollouts\s+status\b/.test(line),
  );
  requirement(
    result,
    rolloutStatusLines.length > 0,
    `deploy automation rollout status commands: ${rolloutStatusLines.length}`,
    `${path} must actively wait for kubectl argo rollouts status, not only mention it in comments or unused helpers`,
  );
  const swallowedRollouts = rolloutStatusLines.filter(
    (line) => /\|\|\s*(?:true|:)\b/.test(line) || /;\s*true\b/.test(line),
  );
  requirement(
    result,
    swallowedRollouts.length === 0 && !/\bset\s+\+e\b/.test(executableText),
    "deploy automation rollout failures are not swallowed",
    `${path} must not swallow rollout status failures with || true, :, or set +e`,
  );

  const rolloutIndex = logicalLines.findIndex(
    (line) =>
      kubectlCommandPrefix.test(line) &&
      /\bargo\s+rollouts\s+status\b/.test(line),
  );
  const endpointIndex = logicalLines.findIndex((line) => /\bcurl\b/.test(line));
  const finalSuccessIndex = logicalLines.findIndex((line) =>
    /deployed and verified/.test(line),
  );
  requirement(
    result,
    rolloutIndex >= 0 &&
      endpointIndex >= 0 &&
      finalSuccessIndex > rolloutIndex &&
      finalSuccessIndex > endpointIndex,
    "deploy automation final success follows rollout and endpoint checks",
    `${path} final deployed-and-verified message must occur after rollout and endpoint verification`,
  );

  return result;
}

export function evaluateGlobalHardeningChecks(readText) {
  const result = createResult();

  requirePackageScript(result, readText, "check:production-hardening");
  requirePackageScript(result, readText, "check:k8s");
  requirePackageScript(result, readText, "check:k8s:networkpolicy");
  appendResult(result, evaluateExpandContractReleaseChecks(readText));
  appendResult(result, evaluateWorkflowHardeningChecks(readText));
  appendResult(result, evaluateAndroidE2eTokenHandoffChecks(readText));
  appendResult(result, evaluateAndroidE2eFailClosedChecks(readText));
  requireTextIncludes(
    result,
    readText,
    ".github/workflows/ci.yml",
    "npm run check:k8s",
    "CI runs Kubernetes render/NetworkPolicy preflight contract",
  );

  requireTextIncludes(
    result,
    readText,
    "scripts/check-networkpolicy-enforcement.sh",
    "MNT_NETWORKPOLICY_PREFLIGHT",
    "NetworkPolicy preflight has warning/required modes",
  );
  requireTextIncludes(
    result,
    readText,
    "scripts/check-networkpolicy-enforcement.sh",
    "policy-capable CNI",
    "NetworkPolicy preflight distinguishes manifest render from CNI enforcement",
  );
  requireTextIncludes(
    result,
    readText,
    "docs/CI-GATES.md",
    "MNT_NETWORKPOLICY_PREFLIGHT=require npm run check:k8s:networkpolicy",
    "CI gates document required NetworkPolicy enforcement preflight",
  );
  requireTextIncludes(
    result,
    readText,
    "deploy/README.md",
    "MNT_NETWORKPOLICY_PREFLIGHT=require npm run check:k8s:networkpolicy",
    "deployment checklist requires live NetworkPolicy enforcement preflight",
  );

  requireTextIncludes(
    result,
    readText,
    ".github/workflows/release-please.yml",
    "RELEASE_PLEASE_TOKEN",
    "release-please PR/token path documented",
  );

  appendResult(result, evaluateSmtpDeploymentChecks(readText));
  appendResult(result, evaluateProdOverlayImageChecks(readText));
  appendResult(result, evaluateArgoTargetRevisionChecks(readText));
  appendResult(result, evaluateDeployAutomationChecks(readText));

  requirePresentText(
    result,
    readText,
    "deploy/apps/maintenance/components/admission-audit/kustomization.yaml",
    "admission-audit component",
  );
  requirePresentText(
    result,
    readText,
    "deploy/apps/maintenance/components/admission-audit/README.md",
    "admission-audit runbook",
  );
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
    requireTextIncludes(
      result,
      readText,
      "deploy/apps/maintenance/components/admission-audit/clusterimagepolicy.yaml",
      needle,
      `admission audit policy: ${needle}`,
    );
  }

  for (const needle of [
    "TimeoutLayer::with_status_code",
    "DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES)",
    "http_trace_layer()",
    "with_metrics(router, &state)",
    "http_route = %cardinality_safe_http_route(request)",
    "router_layer_tests",
    "default_request_timeout_is_thirty_seconds",
  ]) {
    requireTextIncludes(
      result,
      readText,
      "backend/app/src/lib.rs",
      needle,
      `backend request envelope: ${needle}`,
    );
  }
  requirePresentText(
    result,
    readText,
    "backend/app/slos/api-availability.openslo.yaml",
    "OpenSLO availability objective",
  );
  requirePresentText(
    result,
    readText,
    "backend/app/slos/api-latency.openslo.yaml",
    "OpenSLO latency objective",
  );
  requirePresentText(
    result,
    readText,
    "deploy/apps/maintenance/components/monitoring/servicemonitor.yaml",
    "Prometheus ServiceMonitor",
  );
  requirePresentText(
    result,
    readText,
    "deploy/apps/maintenance/components/monitoring/prometheusrule.yaml",
    "PrometheusRule SLO alerts",
  );
  for (const needle of [
    "/metrics",
    "MntApiAvailabilityBurn",
    "MntApiLatencyP99High",
    "Prometheus Operator",
  ]) {
    const file =
      needle === "/metrics"
        ? "deploy/apps/maintenance/components/monitoring/servicemonitor.yaml"
        : needle === "Prometheus Operator"
          ? "deploy/apps/maintenance/components/monitoring/README.md"
          : "deploy/apps/maintenance/components/monitoring/prometheusrule.yaml";
    requireTextIncludes(
      result,
      readText,
      file,
      needle,
      `monitoring portable contract: ${needle}`,
    );
  }

  // Dark mox mail stack: internal-only StatefulSet, wired to the app over the
  // in-cluster webhook, network-fenced, observable, and never exposing a public
  // mail/admin surface.
  for (const needle of [
    "kind: StatefulSet",
    "name: mnt-mox",
    "r.xmox.nl/mox@sha256",
    "WebAPIHTTP",
    "MetricsHTTP",
    "volumeClaimTemplates",
  ]) {
    requireTextIncludes(
      result,
      readText,
      "deploy/apps/maintenance/base/mox.yaml",
      needle,
      `mox dark stack: ${needle}`,
    );
  }
  for (const needle of [
    "MNT_MAIL_MOX_BASE_URL",
    "http://mnt-mox.maintenance.svc:1080",
  ]) {
    requireTextIncludes(
      result,
      readText,
      "deploy/apps/maintenance/base/configmap.yaml",
      needle,
      `mox app wiring: ${needle}`,
    );
  }
  for (const needle of [
    "allow-app-egress-mox",
    "allow-mox-ingress-internal",
    "default-deny-egress-mox",
    "allow-mox-egress-app-webhook",
  ]) {
    requireTextIncludes(
      result,
      readText,
      "deploy/apps/maintenance/base/networkpolicy.yaml",
      needle,
      `mox network policy: ${needle}`,
    );
  }
  for (const needle of [
    "name: mnt-mox",
    "port: metrics",
    "MntMoxDown",
    "MntMoxWebhookFailures",
    "MntMoxQueueBacklog",
    "MntMoxPvcSaturation",
  ]) {
    const file =
      needle === "port: metrics" || needle === "name: mnt-mox"
        ? "deploy/apps/maintenance/components/monitoring/servicemonitor.yaml"
        : "deploy/apps/maintenance/components/monitoring/prometheusrule.yaml";
    requireTextIncludes(
      result,
      readText,
      file,
      needle,
      `mox observability: ${needle}`,
    );
  }
  const moxManifest = readText("deploy/apps/maintenance/base/mox.yaml");
  for (const forbidden of [
    "NodePort",
    "LoadBalancer",
    "port: 25",
    "AdminHTTP",
    "Submission:",
    "Submissions:",
  ]) {
    requirement(
      result,
      !moxManifest.includes(forbidden),
      `mox dark stack excludes ${forbidden}`,
      `mox dark stack must not expose public mail/admin surface: found ${forbidden}`,
    );
  }

  return result;
}

export function evaluateOciGuestCnpgChecks(readText) {
  const result = createResult();
  const paths = {
    base: "deploy/apps/maintenance/base/database.yaml",
    prod: "deploy/apps/maintenance/overlays/prod/kustomization.yaml",
  };

  const baseDatabase = readText(paths.base);
  const baseClusterEnvNames = extractYamlSequenceItemNames(
    baseDatabase,
    "env",
    2,
  );
  const baseInstancesValue = extractYamlScalar(baseDatabase, "instances");
  const baseInstances = parsePositiveInteger(baseInstancesValue);
  requirement(
    result,
    baseInstances === 1,
    `oci-guest CNPG base instances: ${baseInstances}`,
    `oci-guest CNPG base instances: ${paths.base} must keep the live single-node context at spec.instances: 1 (found ${formatScalar(baseInstancesValue)})`,
  );
  requirement(
    result,
    !/^\s*storageClass\s*:/m.test(baseDatabase),
    "oci-guest CNPG base storage: default/local-path-compatible (no pinned storageClass)",
    `oci-guest CNPG base storage: ${paths.base} must not pin the on-prem replicated storageClass; keep storageClass selection context-specific`,
  );
  const hasOciChecksumEnvOverrides = CNPG_OCI_CHECKSUM_ENV_NAMES.every(
    (name) => {
      const block = extractEnvVarBlock(baseDatabase, name);
      return (
        baseClusterEnvNames.includes(name) &&
        /^\s*value:\s*when_required\s*$/m.test(block)
      );
    },
  );
  requirement(
    result,
    hasOciChecksumEnvOverrides,
    "oci-guest CNPG checksum workaround: retained for OCI Object Storage",
    `oci-guest CNPG checksum workaround: ${paths.base} must retain the OCI-only AWS checksum env overrides`,
  );

  const prodOverlay = readText(paths.prod);
  requirement(
    result,
    prodOverlay.includes("../../base"),
    "oci-guest prod overlay: inherits maintenance base",
    `oci-guest prod overlay: ${paths.prod} must inherit ../../base before applying live production patches`,
  );
  requirement(
    result,
    !prodOverlay.includes("cnpg-ha-patch.yaml") &&
      !prodOverlay.includes("mnt-pg-hot"),
    "oci-guest prod overlay: does not opt into on-prem HA storage patch",
    `oci-guest prod overlay: ${paths.prod} must not load cnpg-ha-patch.yaml or mnt-pg-hot; those belong to the on-prem-ha context`,
  );
  requirement(
    result,
    !/(\/spec\/instances|\/spec\/storage\/storageClass|^\s*instances:\s*(?:[2-9]|\d{2,})|^\s*storageClass\s*:)/m.test(
      prodOverlay,
    ),
    "oci-guest prod overlay CNPG shape: does not patch instances or storageClass",
    `oci-guest prod overlay CNPG shape: ${paths.prod} must leave CNPG instances/storage on the single-node base; use deploy/apps/maintenance/overlays/on-prem for HA`,
  );

  return result;
}

export function evaluateOnPremHaCnpgChecks(readText) {
  const result = createResult();
  const paths = {
    base: "deploy/apps/maintenance/base/database.yaml",
    onPrem: "deploy/apps/maintenance/overlays/on-prem/kustomization.yaml",
    onPremPatch: "deploy/apps/maintenance/overlays/on-prem/cnpg-ha-patch.yaml",
    storageClass: "deploy/apps/storage/manifests/storageclass-mnt-pg-hot.yaml",
  };

  const onPremOverlay = readText(paths.onPrem);
  requirement(
    result,
    onPremOverlay.includes("../../base") &&
      onPremOverlay.includes("cnpg-ha-patch.yaml"),
    "on-prem-ha CNPG overlay path: patches the base cluster",
    `on-prem-ha CNPG overlay path: ${paths.onPrem} must inherit ../../base and include cnpg-ha-patch.yaml`,
  );
  requirement(
    result,
    /kind:\s*Cluster/.test(onPremOverlay) &&
      /name:\s*mnt-db/.test(onPremOverlay),
    "on-prem-ha CNPG overlay target: Cluster/mnt-db",
    `on-prem-ha CNPG overlay target: ${paths.onPrem} must target Cluster/mnt-db`,
  );

  const onPremEndpoint = extractJson6902PatchScalar(
    onPremOverlay,
    "/spec/configuration/endpointURL",
  );
  requirement(
    result,
    Boolean(onPremEndpoint) &&
      !/objectstorage\..*oraclecloud\.com/.test(onPremEndpoint),
    `on-prem-ha CNPG object-store endpoint: ${onPremEndpoint}`,
    `on-prem-ha CNPG object-store endpoint: ${paths.onPrem} must patch /spec/configuration/endpointURL to a self-hosted S3 endpoint, not OCI Object Storage (found ${formatScalar(onPremEndpoint)})`,
  );

  const onPremPatch = readText(paths.onPremPatch);
  const baseDatabase = readText(paths.base);
  const baseClusterEnvNames = extractYamlSequenceItemNames(
    baseDatabase,
    "env",
    2,
  );
  const nonChecksumBaseEnvNames = baseClusterEnvNames.filter(
    (name) => !CNPG_OCI_CHECKSUM_ENV_NAMES.includes(name),
  );
  const removesSpecEnv = /-\s*op:\s*remove[\s\S]*?path:\s*\/spec\/env/.test(
    onPremPatch,
  );
  requirement(
    result,
    removesSpecEnv,
    "on-prem-ha CNPG checksum behavior: removes inherited OCI-only AWS checksum env overrides",
    `on-prem-ha CNPG checksum behavior: ${paths.onPremPatch} must remove /spec/env so self-hosted S3 does not inherit the OCI-only AWS checksum workaround`,
  );
  requirement(
    result,
    !removesSpecEnv || nonChecksumBaseEnvNames.length === 0,
    "on-prem-ha CNPG env removal scope: base env contains only OCI checksum overrides",
    `on-prem-ha CNPG env removal scope: ${paths.onPremPatch} may remove /spec/env only while ${paths.base} env contains only OCI checksum overrides; extra base env entries would be dropped: ${nonChecksumBaseEnvNames.join(", ")}`,
  );
  const haInstancesValue = extractJson6902PatchScalar(
    onPremPatch,
    "/spec/instances",
  );
  const haInstances = parsePositiveInteger(haInstancesValue);
  requirement(
    result,
    haInstances !== undefined && haInstances >= 3,
    `on-prem-ha CNPG HA instances: ${haInstances}`,
    `on-prem-ha CNPG HA instances: ${paths.onPremPatch} must set /spec/instances to >= 3 (found ${formatScalar(haInstancesValue)})`,
  );

  const haStorageClass = extractJson6902PatchScalar(
    onPremPatch,
    "/spec/storage/storageClass",
  );
  requirement(
    result,
    haStorageClass === "mnt-pg-hot",
    "on-prem-ha CNPG HA storageClass: mnt-pg-hot",
    `on-prem-ha CNPG HA storageClass: ${paths.onPremPatch} must use mnt-pg-hot and must not use local-path (found ${formatScalar(haStorageClass)})`,
  );
  requirement(
    result,
    json6902PatchHasPath(onPremPatch, "/spec/postgresql/synchronous") &&
      /failoverQuorum:\s*true/.test(onPremPatch),
    "on-prem-ha CNPG HA synchronous replication/failover posture: present",
    `on-prem-ha CNPG HA synchronous replication/failover posture: ${paths.onPremPatch} must add /spec/postgresql/synchronous with failoverQuorum before claiming HA`,
  );
  requirement(
    result,
    /topologyKey:\s*kubernetes\.io\/hostname/.test(onPremPatch) ||
      /nodeLabelsAntiAffinity:\s*\n\s*-\s*kubernetes\.io\/hostname/.test(
        onPremPatch,
      ),
    "on-prem-ha CNPG HA scheduling spread: hostname anti-affinity/topology spread present",
    `on-prem-ha CNPG HA scheduling spread: ${paths.onPremPatch} must include anti-affinity or topology spread by hostname or stronger failure-domain labels`,
  );

  const storageClass = readText(paths.storageClass);
  requirement(
    result,
    /kind:\s*StorageClass/.test(storageClass) &&
      /^\s*name:\s*mnt-pg-hot\s*$/m.test(storageClass),
    "on-prem-ha storage contract: StorageClass/mnt-pg-hot",
    `on-prem-ha storage contract: ${paths.storageClass} must define StorageClass/mnt-pg-hot`,
  );
  const provisioner = extractYamlScalar(storageClass, "provisioner");
  requirement(
    result,
    provisioner === "driver.longhorn.io",
    "on-prem-ha storage provisioner: driver.longhorn.io",
    `on-prem-ha storage provisioner: ${paths.storageClass} must use replicated Longhorn storage, not local-path (found ${formatScalar(provisioner)})`,
  );
  const replicaCountValue = extractYamlScalar(storageClass, "numberOfReplicas");
  const replicaCount = parsePositiveInteger(replicaCountValue);
  requirement(
    result,
    replicaCount !== undefined && replicaCount >= 3,
    `on-prem-ha storage replicas: ${replicaCount}`,
    `on-prem-ha storage replicas: ${paths.storageClass} must set numberOfReplicas to >= 3 (found ${formatScalar(replicaCountValue)})`,
  );
  requirement(
    result,
    /^\s*reclaimPolicy:\s*Retain\s*$/m.test(storageClass),
    "on-prem-ha storage reclaim policy: Retain",
    `on-prem-ha storage reclaim policy: ${paths.storageClass} must use Retain to avoid accidental PostgreSQL data loss`,
  );
  requirement(
    result,
    /^\s*volumeBindingMode:\s*WaitForFirstConsumer\s*$/m.test(storageClass),
    "on-prem-ha storage binding mode: WaitForFirstConsumer",
    `on-prem-ha storage binding mode: ${paths.storageClass} must use WaitForFirstConsumer for topology-aware replicated storage placement`,
  );

  return result;
}

export function evaluateCnpgContextChecks(readText) {
  const result = createResult();
  appendResult(result, evaluateOciGuestCnpgChecks(readText));
  appendResult(result, evaluateOnPremHaCnpgChecks(readText));
  return result;
}

export function evaluateOciGuestContextChecks(readText) {
  const result = createResult();
  appendResult(result, evaluateOciGuestCnpgChecks(readText));

  const runbookPath = "deploy/OPS-RUNBOOK.md";
  const runbook = requirePresentText(
    result,
    readText,
    runbookPath,
    "oci-guest runbook",
  );
  requireRegexInText(
    result,
    runbookPath,
    runbook,
    /`oci-guest` runbook|live OCI\/Talos cluster/i,
    "oci-guest runbook identity: explicit",
  );
  requireRegexInText(
    result,
    runbookPath,
    runbook,
    /OCI Vault.*(recover|secret|credential)|Everything needed to recover.*OCI Vault/is,
    "oci-guest secret recovery source: OCI Vault documented",
  );
  requireRegexInText(
    result,
    runbookPath,
    runbook,
    /Ampere A1|A1 node|free-tier\s+A1/i,
    "oci-guest topology: A1 single-node substrate documented",
  );
  requireRegexInText(
    result,
    runbookPath,
    runbook,
    /single control-plane node|one schedulable control-plane|control-plane node \(schedules workloads\)/i,
    "oci-guest topology: one schedulable control-plane documented",
  );
  requireRegexInText(
    result,
    runbookPath,
    runbook,
    /Reserved public IP|140\.245\.68\.253/,
    "oci-guest topology: reserved IP documented",
  );
  requireRegexInText(
    result,
    runbookPath,
    runbook,
    /second\s+A1|A1 allotment|Free-tier guardrails/i,
    "oci-guest free-tier guardrail: no accidental second A1",
  );

  const secretsPath = "deploy/SECRETS.md";
  const secrets = requirePresentText(
    result,
    readText,
    secretsPath,
    "oci-guest secrets runbook",
  );
  requireRegexInText(
    result,
    secretsPath,
    secrets,
    /OCI Vault/i,
    "oci-guest secrets source: OCI Vault/manual bootstrap documented",
  );
  requireRegexInText(
    result,
    secretsPath,
    secrets,
    /External\s+Secrets|Sealed\s+Secrets/i,
    "oci-guest secrets upgrade path: External Secrets or Sealed Secrets documented",
  );
  requireIncludesInText(
    result,
    secretsPath,
    secrets,
    "MNT_MAIL_MASTER_KEY",
    "oci-guest secrets runbook: mail KEK remains documented",
  );

  const databasePath = "deploy/apps/maintenance/base/database.yaml";
  const database = requirePresentText(
    result,
    readText,
    databasePath,
    "oci-guest database/ObjectStore manifest",
  );
  requireIncludesInText(
    result,
    databasePath,
    database,
    "kind: ObjectStore",
    "oci-guest CNPG backup object: ObjectStore present",
  );
  const destinationPath = extractYamlScalar(database, "destinationPath");
  requirement(
    result,
    destinationPath === "s3://mnt-db-backups/",
    "oci-guest CNPG backup bucket: s3://mnt-db-backups/",
    `oci-guest CNPG backup bucket: ${databasePath} must set destinationPath: s3://mnt-db-backups/ (found ${formatScalar(destinationPath)})`,
  );
  const endpointUrl = extractYamlScalar(database, "endpointURL");
  requirement(
    result,
    /compat\.objectstorage\..*oraclecloud\.com/.test(endpointUrl ?? ""),
    `oci-guest CNPG backup endpoint: ${endpointUrl}`,
    `oci-guest CNPG backup endpoint: ${databasePath} must use the OCI Object Storage S3-compatible endpoint for the oci-guest context (found ${formatScalar(endpointUrl)})`,
  );
  for (const needle of [
    "oci-objectstore-creds",
    "ACCESS_KEY_ID",
    "ACCESS_SECRET_KEY",
    "kind: ScheduledBackup",
  ]) {
    requireIncludesInText(
      result,
      databasePath,
      database,
      needle,
      `oci-guest CNPG backup credential/schedule: ${needle}`,
    );
  }
  requireRegexInText(
    result,
    databasePath,
    database,
    /retentionPolicy|Indefinite retention|never prunes|no retentionPolicy/i,
    "oci-guest CNPG backup retention posture: explicit",
  );
  requireRegexInText(
    result,
    databasePath,
    database,
    /AWS_REQUEST_CHECKSUM_CALCULATION[\s\S]*when_required[\s\S]*OCI Object Storage/i,
    "oci-guest OCI-specific Barman checksum workaround: labeled and scoped",
  );

  const enterprisePath = "docs/ENTERPRISE-READINESS.md";
  const enterprise = requirePresentText(
    result,
    readText,
    enterprisePath,
    "oci-guest enterprise readiness note",
  );
  requireRegexInText(
    result,
    enterprisePath,
    enterprise,
    /`oci-guest`[\s\S]*single(?:-|\s)node|single free-tier node/i,
    "oci-guest HA honesty: single-node posture documented",
  );
  requireRegexInText(
    result,
    enterprisePath,
    enterprise,
    /restore-from-backup event|not an automatic failover/i,
    "oci-guest HA honesty: restore-not-failover documented",
  );

  const imageReleasePath = ".github/workflows/image-release.yml";
  const imageRelease = requirePresentText(
    result,
    readText,
    imageReleasePath,
    "oci-guest image-release workflow",
  );
  requireRegexInText(
    result,
    imageReleasePath,
    imageRelease,
    /(?:target|platforms):\s*linux\/arm64/,
    "oci-guest image platform: current arm64 target explicit",
  );
  requireRegexInText(
    result,
    imageReleasePath,
    imageRelease,
    /A1 cluster|Ampere A1|Oracle Ampere/i,
    "oci-guest image platform: arm64 rationale scoped to OCI/A1",
  );

  const drPath = "ops/dr/DR-POLICY.md";
  const drPolicy = requirePresentText(
    result,
    readText,
    drPath,
    "oci-guest DR policy",
  );
  for (const needle of [
    "RPO: <= 5 minutes",
    "RTO: <= 1 hour",
    "pitr_drill_complete=ok",
  ]) {
    requireIncludesInText(
      result,
      drPath,
      drPolicy,
      needle,
      `oci-guest DR policy: ${needle}`,
    );
  }

  return result;
}

export function evaluateOnPremHaContextChecks(readText) {
  const result = createResult();
  appendResult(result, evaluateOnPremHaCnpgChecks(readText));

  const runbookPath = "deploy/OPS-RUNBOOK-baremetal.md";
  const runbook = requirePresentText(
    result,
    readText,
    runbookPath,
    "on-prem-ha runbook",
  );
  requireRegexInText(
    result,
    runbookPath,
    runbook,
    /\bADR-0024\b/,
    "on-prem-ha runbook identity: explicit ADR-0024",
  );
  requireRegexInText(
    result,
    runbookPath,
    runbook,
    /OpenBao[\s\S]*secret root|secret root[\s\S]*OpenBao/i,
    "on-prem-ha secret root: OpenBao documented",
  );
  requireRegexInText(
    result,
    runbookPath,
    runbook,
    /External Secrets Operator|External Secrets/i,
    "on-prem-ha secret projection: External Secrets documented",
  );
  requireRegexInText(
    result,
    runbookPath,
    runbook,
    /unseal[\s\S]*(audit|backup|snapshot)|audit[\s\S]*(backup|snapshot)/i,
    "on-prem-ha secret operations: unseal/audit/backup expectations documented",
  );
  requireRegexInText(
    result,
    runbookPath,
    runbook,
    /Do not paste|keep secret values out of git|out-of-band encrypted backup/i,
    "on-prem-ha secret handling: no committed/pasted unseal or root material",
  );

  requireRegexInText(
    result,
    runbookPath,
    runbook,
    /SeaweedFS/i,
    "on-prem-ha object store: accepted self-hosted S3 reference documented",
  );
  requireRegexInText(
    result,
    runbookPath,
    runbook,
    /CNPG Barman[\s\S]*(endpoint|S3 URL)|Barman[\s\S]*on-prem S3/i,
    "on-prem-ha object store: CNPG Barman endpoint requirements documented",
  );
  requireRegexInText(
    result,
    runbookPath,
    runbook,
    /credentials from OpenBao\/ESO|OpenBao\/ESO[\s\S]*bucket names|TLS CA material/i,
    "on-prem-ha object store: credentials/buckets/TLS from portable secret path documented",
  );
  requireRegexInText(
    result,
    runbookPath,
    runbook,
    /second physical site|independent failure domain/i,
    "on-prem-ha object store: independent retention/replication failure domain documented",
  );
  requireRegexInText(
    result,
    runbookPath,
    runbook,
    /not copy[\s\S]*AWS_\*_CHECKSUM|AWS_\*_CHECKSUM[\s\S]*blindly/i,
    "on-prem-ha object store: OCI checksum workaround not blindly copied",
  );

  requireRegexInText(
    result,
    runbookPath,
    runbook,
    /three (?:named )?control-plane|three control-plane\/etcd|three healthy etcd/i,
    "on-prem-ha topology: three control-plane/etcd members required",
  );
  requireRegexInText(
    result,
    runbookPath,
    runbook,
    /dedicated worker|worker\/storage nodes|failure domains/i,
    "on-prem-ha topology: worker/storage failure domains required",
  );
  requireRegexInText(
    result,
    runbookPath,
    runbook,
    /stable Kubernetes API endpoint|CONTROL_PLANE_VIP|VIP/i,
    "on-prem-ha topology: stable API endpoint/VIP required",
  );
  requireRegexInText(
    result,
    runbookPath,
    runbook,
    /Site NTP|site NTP|real fabric MTU|fabric MTU/i,
    "on-prem-ha topology: site NTP and real fabric MTU required",
  );
  requireRegexInText(
    result,
    runbookPath,
    runbook,
    /Never reuse the OCI public IP|no OCI IP|Do not copy OCI/i,
    "on-prem-ha topology: no OCI IP/hostPort assumptions",
  );
  requireRegexInText(
    result,
    runbookPath,
    runbook,
    /DARK|not wired|manual-sync|founder\/operator activation/i,
    "on-prem-ha DARK boundary: no live Argo cutover without operator activation",
  );
  requireRegexInText(
    result,
    runbookPath,
    runbook,
    /multi-arch images|x86_64|amd64|extend `platforms`/i,
    "on-prem-ha image platform: multi-arch/x86 readiness decision documented",
  );

  const enterprisePath = "docs/ENTERPRISE-READINESS.md";
  const enterprise = requirePresentText(
    result,
    readText,
    enterprisePath,
    "on-prem-ha enterprise readiness note",
  );
  requireRegexInText(
    result,
    enterprisePath,
    enterprise,
    /on-prem[\s\S]*three Talos control-plane nodes/i,
    "on-prem-ha readiness: three Talos control-plane nodes documented",
  );
  requireRegexInText(
    result,
    enterprisePath,
    enterprise,
    /CNPG `instances: 3`|replicated storage[\s\S]*CNPG/i,
    "on-prem-ha readiness: replicated storage and CNPG instances: 3 documented",
  );
  requireRegexInText(
    result,
    enterprisePath,
    enterprise,
    /DARK docs\/manifests are readiness inputs|DARK artifacts/i,
    "on-prem-ha readiness: DARK artifacts are not live HA evidence",
  );

  const storageReadmePath = "deploy/apps/storage/README.md";
  const storageReadme = requirePresentText(
    result,
    readText,
    storageReadmePath,
    "on-prem-ha storage runbook",
  );
  requireRegexInText(
    result,
    storageReadmePath,
    storageReadme,
    /not sync this app into the current `oci-guest`|live OCI guest/i,
    "on-prem-ha storage runbook: not synced into current OCI guest",
  );
  requireRegexInText(
    result,
    storageReadmePath,
    storageReadme,
    /three eligible Kubernetes worker\/storage nodes|failure domains/i,
    "on-prem-ha storage runbook: three storage failure domains before activation",
  );

  const observabilityPath = "deploy/apps/observability/README.md";
  const observability = requirePresentText(
    result,
    readText,
    observabilityPath,
    "on-prem-ha observability runbook",
  );
  requireRegexInText(
    result,
    observabilityPath,
    observability,
    /OpenTelemetry Collector|VictoriaMetrics|Loki|Tempo|Grafana/i,
    "on-prem-ha observability: self-hosted telemetry stack staged",
  );
  requireRegexInText(
    result,
    observabilityPath,
    observability,
    /Do not replace[\s\S]*components\/monitoring|ServiceMonitor\/mnt-app[\s\S]*\/metrics/i,
    "on-prem-ha observability: preserves portable /metrics and monitoring contract",
  );

  return result;
}

export const DEPLOYMENT_CONTEXTS = Object.freeze([
  {
    id: "oci-guest",
    status: "live/current production substrate",
    evaluate: evaluateOciGuestContextChecks,
  },
  {
    id: "on-prem-ha",
    status: "DARK/additive ADR-0024 HA target",
    evaluate: evaluateOnPremHaContextChecks,
  },
]);

function runCli() {
  const groups = [
    { id: "global", result: evaluateGlobalHardeningChecks(read) },
    ...DEPLOYMENT_CONTEXTS.map((context) => ({
      id: context.id,
      result: context.evaluate(read),
    })),
  ];
  const failureGroups = groups.filter(
    (group) => group.result.failures.length > 0,
  );
  if (failureGroups.length) {
    const lines = [];
    for (const group of failureGroups) {
      lines.push(`${group.id}:`);
      lines.push(...group.result.failures.map((failure) => `- ${failure}`));
    }
    console.error(`Production hardening check failed:\n${lines.join("\n")}`);
    process.exit(1);
  }

  const passCount = groups.reduce(
    (sum, group) => sum + group.result.passes.length,
    0,
  );
  console.log(
    `Production hardening check passed (${passCount} checks across ${groups.length} groups).`,
  );
  for (const group of groups) {
    console.log(`${group.id}:`);
    for (const pass of group.result.passes) {
      console.log(`- ${pass}`);
    }
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runCli();
}
