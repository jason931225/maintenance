#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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

function requireIncludes(text, needle, label, source = ".github/workflows/ios-ui-tests.yml") {
  assert(text.includes(needle), label, `${source} must include ${JSON.stringify(needle)}`);
}

function requireOrder(text, first, second, label, source = ".github/workflows/ios-ui-tests.yml") {
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

function extractLineRange(text, startNeedle, endNeedle, label, source = ".github/workflows/ios-ui-tests.yml") {
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

function runWorkflowGateCase(name, shellBlock, env, expectation) {
  if (shellBlock.length === 0) return;

  const result = spawnSync(
    "/bin/bash",
    [
      "-e",
      "-o",
      "pipefail",
      "-c",
      `${shellBlock}\nprintf '__MNT_SKIP_COUNT=%s\\n' "\${#TEST_SELECTION_ARGS[@]}"\n`,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? root,
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        GITHUB_STEP_SUMMARY: "",
        MNT_UITEST_REQUIRE_REAL: "0",
        MNT_UITEST_BASE_URL: "",
        MNT_UITEST_REFRESH_TOKEN: "",
        MNT_UITEST_OTP: "",
        ...env,
      },
    },
  );

  if (result.error) {
    failures.push(`${name}: failed to start bash dry-run: ${result.error.message}`);
    return;
  }

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
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

  if (expectation.skipCount !== undefined) {
    const match = output.match(/__MNT_SKIP_COUNT=(\d+)/);
    const actual = match ? Number(match[1]) : null;
    assert(
      actual === expectation.skipCount,
      `${name}: skip count ${expectation.skipCount}`,
      `${name}: expected skip count ${expectation.skipCount}, got ${actual}; output:\n${output.trim()}`,
    );
  }
}

const workflowPath = ".github/workflows/ios-ui-tests.yml";
const workflow = read(workflowPath);
const packageJsonText = read("package.json");
const ci = read(".github/workflows/ci.yml");
let packageJson = {};
try {
  packageJson = JSON.parse(packageJsonText);
} catch (error) {
  failures.push(`package.json: invalid JSON: ${error.message}`);
}

const requireRealAssignment = workflow.match(/MNT_UITEST_REQUIRE_REAL:\s*\$\{\{([^\n]+)\}\}/);
assert(Boolean(requireRealAssignment), "MNT_UITEST_REQUIRE_REAL assignment present", `${workflowPath}: missing MNT_UITEST_REQUIRE_REAL assignment`);
const requireRealExpression = requireRealAssignment?.[1] ?? "";
assert(
  /github\.event_name\s*==\s*'push'/.test(requireRealExpression),
  "push runs require the real iOS UI-test gate",
  `${workflowPath}: MNT_UITEST_REQUIRE_REAL must be enabled for push runs`,
);
assert(
  /github\.ref_protected/.test(requireRealExpression),
  "protected refs require the real iOS UI-test gate",
  `${workflowPath}: MNT_UITEST_REQUIRE_REAL must account for github.ref_protected`,
);
assert(
  !/secrets\.MNT_UITEST_BASE_URL|secrets\.MNT_UITEST_REFRESH_TOKEN|secrets\.MNT_UITEST_OTP/.test(requireRealExpression),
  "required context does not depend on secret presence",
  `${workflowPath}: MNT_UITEST_REQUIRE_REAL must not be conditioned on secrets being present`,
);

requireIncludes(workflow, "HAS_REAL_SESSION_SOURCE", "workflow computes a real-session source boolean");
requireIncludes(workflow, "MNT_UITEST_REQUIRE_REAL:-0", "workflow checks the require-real flag in shell before applying skips");
requireIncludes(workflow, "::error title=Required iOS UI-test real-session inputs are missing::", "required missing inputs emit a GitHub Actions error");
requireIncludes(workflow, "exit 1", "required missing inputs fail the workflow before a false-green test pass");
requireIncludes(workflow, "::notice title=Optional iOS UI-test real-session gate skipped::", "optional missing inputs emit a truthful skip notice");
requireIncludes(workflow, "GITHUB_STEP_SUMMARY", "required/optional gate disposition is written to the job summary");
requireOrder(
  workflow,
  "::error title=Required iOS UI-test real-session inputs are missing::",
  "TEST_SELECTION_ARGS+=(",
  "required fail-closed guard runs before real-session skip selection",
);
requireOrder(
  workflow,
  "TEST_SELECTION_ARGS=()",
  "xcodebuild test-without-building",
  "test selection is decided before xcodebuild test execution",
);

const guardShellBlock = extractLineRange(
  workflow,
  "TEST_SELECTION_ARGS=()",
  "xcodebuild test-without-building",
  "real-session gate shell block",
);
runWorkflowGateCase(
  "protected/push required context with missing inputs fails closed",
  guardShellBlock,
  { MNT_UITEST_REQUIRE_REAL: "1" },
  {
    exitCode: 1,
    includes: ["::error title=Required iOS UI-test real-session inputs are missing::"],
    excludes: ["::notice title=Optional iOS UI-test real-session gate skipped::"],
  },
);
runWorkflowGateCase(
  "optional/fork PR context with missing inputs skips truthfully",
  guardShellBlock,
  { MNT_UITEST_REQUIRE_REAL: "0" },
  {
    exitCode: 0,
    includes: ["::notice title=Optional iOS UI-test real-session gate skipped::"],
    excludes: ["::error title=Required iOS UI-test real-session inputs are missing::"],
    skipCount: 5,
  },
);
runWorkflowGateCase(
  "protected/push required context with refresh-token inputs runs real-session tests",
  guardShellBlock,
  {
    MNT_UITEST_REQUIRE_REAL: "1",
    MNT_UITEST_BASE_URL: "https://maintenance.example.test",
    MNT_UITEST_REFRESH_TOKEN: "refresh-token",
  },
  {
    exitCode: 0,
    includes: ["Real UI-test session source configured; running session-dependent UI tests."],
    excludes: ["::error title=Required iOS UI-test real-session inputs are missing::", "::notice title=Optional iOS UI-test real-session gate skipped::"],
    skipCount: 0,
  },
);
runWorkflowGateCase(
  "protected/push required context with OTP inputs runs real-session tests",
  guardShellBlock,
  {
    MNT_UITEST_REQUIRE_REAL: "1",
    MNT_UITEST_BASE_URL: "https://maintenance.example.test",
    MNT_UITEST_OTP: "123456",
  },
  {
    exitCode: 0,
    includes: ["Real UI-test session source configured; running session-dependent UI tests."],
    excludes: ["::error title=Required iOS UI-test real-session inputs are missing::", "::notice title=Optional iOS UI-test real-session gate skipped::"],
    skipCount: 0,
  },
);

assert(
  packageJson.scripts?.["check:ios-ui-test-fail-closed"] === "node scripts/check-ios-ui-test-fail-closed.mjs",
  "package script check:ios-ui-test-fail-closed",
  "package.json must define check:ios-ui-test-fail-closed",
);
assert(
  ci.includes("npm run check:ios-ui-test-fail-closed"),
  "CI runs iOS UI-test fail-closed workflow guard",
  ".github/workflows/ci.yml must run npm run check:ios-ui-test-fail-closed",
);

for (const label of passes) {
  console.log(`PASS ${label}`);
}

if (failures.length > 0) {
  console.error("\niOS UI-test fail-closed workflow guard failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`\niOS UI-test fail-closed workflow guard passed (${passes.length} checks).`);
