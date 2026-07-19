#!/usr/bin/env node
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = new URL("./wait-for-protected-main-ci.sh", import.meta.url);

function runWith(runs) {
  const dir = mkdtempSync(join(tmpdir(), "protected-main-ci-gate-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const gh = join(bin, "gh");
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s' '${JSON.stringify(runs).replaceAll("'", "'\\''")}'
`,
  );
  chmodSync(gh, 0o755);
  return spawnSync("bash", [script.pathname], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      REPO: "example/repo",
      SHA: "a".repeat(40),
      CI_GATE_TIMEOUT_SECONDS: "30",
      CI_GATE_POLL_SECONDS: "0",
      CI_GATE_MAX_POLLS: "1",
    },
    encoding: "utf8",
  });
}

function run(overrides) {
  return {
    status: "completed",
    conclusion: "success",
    url: "https://example.invalid/run",
    event: "push",
    headBranch: "main",
    createdAt: "2026-07-19T12:00:00Z",
    databaseId: 1,
    ...overrides,
  };
}

test("accepts only a successful push CI run on main for the exact SHA", () => {
  const result = runWith([
    run({ event: "pull_request", headBranch: "feature", databaseId: 3 }),
    run({ databaseId: 2 }),
  ]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Protected-main push CI/);
});

test("does not let a successful PR run mask an in-progress protected-main run", () => {
  const result = runWith([
    run({ event: "pull_request", headBranch: "feature", databaseId: 3 }),
    run({ status: "in_progress", conclusion: "", databaseId: 2 }),
  ]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Timed out waiting/);
});

test("fails when protected-main push CI failed even if another same-SHA event passed", () => {
  const result = runWith([
    run({ event: "workflow_dispatch", headBranch: "main", databaseId: 4 }),
    run({ conclusion: "failure", databaseId: 3 }),
  ]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /did not pass.*failure/);
});
