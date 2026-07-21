#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const passes = [];

function pathOf(path) {
  return resolve(root, path);
}

function read(path) {
  const abs = pathOf(path);
  if (!existsSync(abs)) {
    failures.push(`${path}: missing`);
    return "";
  }
  return readFileSync(abs, "utf8");
}

function pass(label) {
  passes.push(label);
}

function assert(condition, passLabel, failureLabel) {
  if (condition) pass(passLabel);
  else failures.push(failureLabel);
}

function requireIncludes(text, needle, label, source = ".github/workflows/ci.yml") {
  assert(text.includes(needle), label, `${source} must include ${JSON.stringify(needle)}`);
}

function requireNotIncludes(text, needle, label, source = ".github/workflows/ci.yml") {
  assert(!text.includes(needle), label, `${source} must not include ${JSON.stringify(needle)}`);
}

function requireOrder(text, first, second, label, source = ".github/workflows/ci.yml") {
  const firstIndex = text.indexOf(first);
  const secondIndex = text.indexOf(second);
  assert(
    firstIndex !== -1 && secondIndex !== -1 && firstIndex < secondIndex,
    label,
    `${source} must place ${JSON.stringify(first)} before ${JSON.stringify(second)}`,
  );
}

function stripCommonIndent(block) {
  const lines = block.split(/\r?\n/);
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.match(/^\s*/)?.[0].length ?? 0);
  const indent = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(Math.min(indent, line.length))).join("\n");
}

function extractLineRange(text, startNeedle, endNeedle, label, source = ".github/workflows/ci.yml") {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes(startNeedle));
  const end = lines.findIndex((line, index) => index > start && line.includes(endNeedle));

  if (start === -1 || end === -1 || start >= end) {
    failures.push(`${source} must include ${label} from ${JSON.stringify(startNeedle)} before ${JSON.stringify(endNeedle)}`);
    return "";
  }

  pass(`${label} can be extracted for dry-run coverage`);
  return stripCommonIndent(lines.slice(start, end).join("\n"));
}

function runGuardCase(name, shellBlock, env, expectation) {
  if (shellBlock.length === 0) return;

  const tmp = mkdtempSync(join(tmpdir(), "mnt-android-e2e-guard-"));
  const githubEnv = join(tmp, "github-env");
  const stepSummary = join(tmp, "step-summary");

  try {
    const result = spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", shellBlock], {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? root,
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        GITHUB_ENV: githubEnv,
        GITHUB_STEP_SUMMARY: stepSummary,
        FIELD_E2E_REQUIRE_REAL_SESSION: "0",
        FIELD_E2E_BASE_URL: "",
        FIELD_E2E_SEED_REFRESH_TOKEN: "",
        ...env,
      },
    });

    if (result.error) {
      failures.push(`${name}: failed to start bash dry-run: ${result.error.message}`);
      return;
    }

    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const envOutput = existsSync(githubEnv) ? readFileSync(githubEnv, "utf8") : "";
    const summaryOutput = existsSync(stepSummary) ? readFileSync(stepSummary, "utf8") : "";

    if (result.status === expectation.exitCode) {
      pass(`${name}: exit ${expectation.exitCode}`);
    } else {
      failures.push(`${name}: expected exit ${expectation.exitCode}, got ${result.status}; output:\n${output.trim()}`);
    }

    for (const needle of expectation.includes ?? []) {
      assert(output.includes(needle), `${name}: output includes ${needle}`, `${name}: output must include ${JSON.stringify(needle)}; output:\n${output.trim()}`);
    }
    for (const needle of expectation.excludes ?? []) {
      assert(!output.includes(needle), `${name}: output excludes ${needle}`, `${name}: output must not include ${JSON.stringify(needle)}; output:\n${output.trim()}`);
    }
    for (const needle of expectation.envIncludes ?? []) {
      assert(envOutput.includes(needle), `${name}: GITHUB_ENV includes ${needle}`, `${name}: GITHUB_ENV must include ${JSON.stringify(needle)}; contents:\n${envOutput.trim()}`);
    }
    for (const needle of expectation.summaryIncludes ?? []) {
      assert(summaryOutput.includes(needle), `${name}: summary includes ${needle}`, `${name}: GITHUB_STEP_SUMMARY must include ${JSON.stringify(needle)}; contents:\n${summaryOutput.trim()}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const workflowPath = ".github/workflows/ci.yml";
const workflow = read(workflowPath);
const packageJsonText = read("package.json");
let packageJson = {};
try {
  packageJson = JSON.parse(packageJsonText);
} catch (error) {
  failures.push(`package.json: invalid JSON: ${error.message}`);
}

const requireRealAssignment = workflow.match(/FIELD_E2E_REQUIRE_REAL_SESSION:\s*\$\{\{([^\n]+)\}\}/);
assert(Boolean(requireRealAssignment), "FIELD_E2E_REQUIRE_REAL_SESSION assignment present", `${workflowPath}: missing FIELD_E2E_REQUIRE_REAL_SESSION assignment`);
const requireRealExpression = requireRealAssignment?.[1] ?? "";
assert(
  /github\.event_name\s*==\s*'push'/.test(requireRealExpression),
  "push runs can require the real Android E2E gate",
  `${workflowPath}: FIELD_E2E_REQUIRE_REAL_SESSION must be enabled for protected push runs`,
);
assert(
  /github\.ref_type\s*==\s*'branch'/.test(requireRealExpression),
  "branch refs are distinguished from tag/manual contexts",
  `${workflowPath}: FIELD_E2E_REQUIRE_REAL_SESSION must account for github.ref_type == 'branch'`,
);
assert(
  /github\.ref_protected/.test(requireRealExpression),
  "protected refs require the real Android E2E gate",
  `${workflowPath}: FIELD_E2E_REQUIRE_REAL_SESSION must account for github.ref_protected`,
);
assert(
  !/secrets\.FIELD_E2E_BASE_URL|secrets\.FIELD_E2E_SEED_REFRESH_TOKEN/.test(requireRealExpression),
  "required context does not depend on secret presence",
  `${workflowPath}: FIELD_E2E_REQUIRE_REAL_SESSION must not be conditioned on secrets being present`,
);

requireIncludes(workflow, "::error title=Required Android E2E real-session inputs are missing::", "required missing inputs emit a GitHub Actions error");
requireIncludes(workflow, "::notice title=Optional Android E2E real-session gate skipped::", "optional missing inputs emit a truthful skip notice");
requireIncludes(workflow, "GITHUB_STEP_SUMMARY", "required/optional gate disposition is written to the job summary");
requireIncludes(workflow, "FIELD_E2E_SESSION_ASSETS_DIR=", "optional skip clears the session fixture path");
requireIncludes(workflow, "./gradlew fieldApi34DebugAndroidTest", "workflow still runs the Android instrumented E2E command");
requireNotIncludes(workflow, "GITHUB_OUTPUT", "workflow avoids empty token step outputs");
requireNotIncludes(workflow, "steps.session.outputs", "workflow avoids session output token handoff");
requireNotIncludes(
  workflow,
  "android.testInstrumentationRunnerArguments.FIELD_E2E_",
  "workflow avoids raw token Gradle instrumentation arguments",
);
requireOrder(
  workflow,
  "::error title=Required Android E2E real-session inputs are missing::",
  "./gradlew fieldApi34DebugAndroidTest",
  "required fail-closed guard runs before Gradle Managed Device execution",
);
requireOrder(
  workflow,
  "::notice title=Optional Android E2E real-session gate skipped::",
  "./gradlew fieldApi34DebugAndroidTest",
  "optional skip decision is logged before Gradle Managed Device execution",
);

const guardShellBlock = extractLineRange(
  workflow,
  'if [ -z "${FIELD_E2E_BASE_URL:-}" ] || [ -z "${FIELD_E2E_SEED_REFRESH_TOKEN:-}" ]; then',
  "printf '::add-mask::%s\\n' \"$FIELD_E2E_SEED_REFRESH_TOKEN\"",
  "Android real-session missing-input guard shell block",
);
const mintShellBlock = extractLineRange(
  workflow,
  "printf '::add-mask::%s\\n' \"$FIELD_E2E_SEED_REFRESH_TOKEN\"",
  "if ! access_token=",
  "Android real-session mint shell block",
);
requireIncludes(
  mintShellBlock,
  "$FIELD_E2E_BASE_URL/api/v1/auth/token/refresh",
  "session mint uses the backend's canonical refresh route",
  "Android real-session mint shell block",
);
requireNotIncludes(
  mintShellBlock,
  "$FIELD_E2E_BASE_URL/api/v1/auth/refresh",
  "session mint does not call the removed non-canonical refresh route",
  "Android real-session mint shell block",
);

runGuardCase(
  "protected branch push context with missing inputs fails closed",
  guardShellBlock,
  { FIELD_E2E_REQUIRE_REAL_SESSION: "1" },
  {
    exitCode: 1,
    includes: ["::error title=Required Android E2E real-session inputs are missing::"],
    excludes: ["::notice title=Optional Android E2E real-session gate skipped::"],
    summaryIncludes: ["Result: failed closed before Gradle Managed Device execution"],
  },
);
runGuardCase(
  "optional/fork PR context with missing inputs skips truthfully",
  guardShellBlock,
  { FIELD_E2E_REQUIRE_REAL_SESSION: "0" },
  {
    exitCode: 0,
    includes: ["::notice title=Optional Android E2E real-session gate skipped::"],
    excludes: ["::error title=Required Android E2E real-session inputs are missing::"],
    envIncludes: ["FIELD_E2E_SESSION_ASSETS_DIR="],
    summaryIncludes: ["Gate: optional/skipped"],
  },
);
runGuardCase(
  "required context with both session inputs proceeds to minting",
  guardShellBlock,
  {
    FIELD_E2E_REQUIRE_REAL_SESSION: "1",
    FIELD_E2E_BASE_URL: "https://maintenance.example.test",
    FIELD_E2E_SEED_REFRESH_TOKEN: "seed-refresh-token",
  },
  {
    exitCode: 0,
    excludes: ["::error title=Required Android E2E real-session inputs are missing::", "::notice title=Optional Android E2E real-session gate skipped::"],
  },
);

assert(
  packageJson.scripts?.["check:android-e2e-fail-closed"] === "node scripts/check-android-e2e-fail-closed.mjs",
  "package script check:android-e2e-fail-closed",
  "package.json must define check:android-e2e-fail-closed",
);
assert(
  workflow.includes("npm run check:android-e2e-fail-closed"),
  "CI runs Android E2E fail-closed workflow guard",
  `${workflowPath} must run npm run check:android-e2e-fail-closed`,
);

for (const label of passes) {
  console.log(`PASS ${label}`);
}

if (failures.length > 0) {
  console.error("\nAndroid E2E fail-closed workflow guard failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`\nAndroid E2E fail-closed workflow guard passed (${passes.length} checks).`);
