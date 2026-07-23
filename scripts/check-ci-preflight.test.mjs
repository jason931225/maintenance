import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { evaluateCiPreflight } from "./check-ci-preflight.mjs";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

function expectFailure(source, message) {
  const { failures } = evaluateCiPreflight(source);
  assert.ok(failures.some((failure) => failure.includes(message)), failures.join("\n"));
}

describe("CI preflight contract", () => {
  it("accepts the workflow's cheap preflight and protected expensive jobs", () => {
    assert.deepEqual(evaluateCiPreflight(workflow).failures, []);
  });

  it("rejects a preflight that does not run the lockfile and foundation gates", () => {
    expectFailure(workflow.replace("npm run check:package-lock", "npm run check:root-workspaces"), "check:package-lock");
  });

  it("rejects a preflight command that appears only in a comment", () => {
    expectFailure(
      workflow.replace(
        "      - name: Canonical npm lockfile\n        run: npm run check:package-lock",
        "      - name: Canonical npm lockfile\n        # npm run check:package-lock",
      ),
      "check:package-lock",
    );
  });

  it("rejects a required preflight step guarded by a condition", () => {
    expectFailure(
      workflow.replace(
        "      - name: Canonical npm lockfile\n        run: npm run check:package-lock",
        "      - name: Canonical npm lockfile\n        if: ${{ false }}\n        run: npm run check:package-lock",
      ),
      "unconditionally",
    );
  });

  it("rejects a required preflight step allowed to continue on error", () => {
    expectFailure(
      workflow.replace(
        "      - name: Canonical npm lockfile\n        run: npm run check:package-lock",
        "      - name: Canonical npm lockfile\n        continue-on-error: true\n        run: npm run check:package-lock",
      ),
      "unconditionally",
    );
  });

  it("rejects any expensive backend, mobile, or browser job without the preflight dependency", () => {
    expectFailure(workflow.replace("  backend:\n", "  backend:\n    needs: []\n"), "backend must need preflight");
    expectFailure(workflow.replace("    needs: [preflight, mobile-parity]\n", "    needs: []\n"), "android-app must need preflight");
    expectFailure(workflow.replace("  browser-e2e:\n", "  browser-e2e:\n    needs: []\n"), "browser-e2e must need preflight");
    expectFailure(workflow.replace("  kubernetes-manifests:\n", "  kubernetes-manifests:\n    needs: []\n"), "kubernetes-manifests must need preflight");
  });

  it("rejects failure-insensitive job-level conditions on protected jobs", () => {
    expectFailure(workflow.replace("  backend:\n", "  backend:\n    if: always()\n"), "backend must not define job-level if");
    expectFailure(workflow.replace("  browser-e2e:\n", "  browser-e2e:\n    if: ${{ !cancelled() }}\n"), "browser-e2e must not define job-level if");
  });
});
