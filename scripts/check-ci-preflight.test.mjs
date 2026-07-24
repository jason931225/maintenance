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

  it("rejects CI path filters that omit toolchain changes", () => {
    expectFailure(
      workflow.replace('      - "toolchains/**"\n', ""),
      "push must include toolchains/** in CI path filters",
    );
    const pullRequest = workflow.indexOf("  pull_request:\n");
    const pullWithoutToolchains = workflow.slice(0, pullRequest) + workflow.slice(pullRequest).replace(
      '      - "toolchains/**"\n',
      "",
    );
    expectFailure(pullWithoutToolchains, "pull_request must include toolchains/** in CI path filters");
  });

  it("rejects toolchain entries placed outside each trigger's paths mapping", () => {
    const pushWithoutToolchains = workflow.replace('      - "toolchains/**"\n', "");
    expectFailure(
      pushWithoutToolchains.replace(
        "  pull_request:\n",
        "    paths-ignore:\n      - \"toolchains/**\"\n  pull_request:\n",
      ),
      "push must include toolchains/** in CI path filters",
    );
    expectFailure(
      pushWithoutToolchains.replace(
        "    paths:\n",
        "    branches-ignore:\n      - \"toolchains/**\"\n    paths:\n",
      ),
      "push must include toolchains/** in CI path filters",
    );

    const pullRequest = workflow.indexOf("  pull_request:\n");
    const pullWithoutToolchains = workflow.slice(0, pullRequest) + workflow.slice(pullRequest).replace(
      '      - "toolchains/**"\n',
      "",
    );
    expectFailure(
      pullWithoutToolchains.replace(
        "  workflow_dispatch:\n",
        "    paths-ignore:\n      - \"toolchains/**\"\n  workflow_dispatch:\n",
      ),
      "pull_request must include toolchains/** in CI path filters",
    );
    expectFailure(
      pullWithoutToolchains.replace(
        "  workflow_dispatch:\n",
        "    branches-ignore:\n      - \"toolchains/**\"\n  workflow_dispatch:\n",
      ),
      "pull_request must include toolchains/** in CI path filters",
    );
  });

  it("rejects Buck2 jobs that do not bootstrap pinned DotSlash before invocation", () => {
    expectFailure(
      workflow.replace(
        "      - name: Install pinned DotSlash runtime\n        run: tools/buck/install_dotslash.sh\n",
        "",
      ),
      "preflight must install pinned DotSlash before Buck2",
    );
    const apiContract = workflow.indexOf("  api-contract:\n");
    const apiWithoutDotSlash = workflow.slice(0, apiContract) + workflow.slice(apiContract).replace(
      "      - name: Install pinned DotSlash runtime\n        run: tools/buck/install_dotslash.sh\n",
      "",
    );
    expectFailure(apiWithoutDotSlash, "api-contract must install pinned DotSlash before Buck2");
  });

  it("rejects API contract tests that point MNT_APP_BIN at a Cargo target", () => {
    for (const path of [
      "${{ github.workspace }}/backend/target/debug/mnt-app",
      "${CARGO_TARGET_DIR}/debug/mnt-app",
    ]) {
      expectFailure(
        workflow.replace(
          "      CONTRACT_DATABASE_URL: postgres://postgres:postgres@localhost:5432/mnt_contract\n",
          `      CONTRACT_DATABASE_URL: postgres://postgres:postgres@localhost:5432/mnt_contract\n      MNT_APP_BIN: ${path}\n`,
        ),
        "api-contract must not use a Cargo target path for MNT_APP_BIN",
      );
    }
  });

  it("rejects duplicate API contract app producers and later binary overrides", () => {
    expectFailure(
      workflow.replace(
        "      - name: Capture Buck2-built app for contract test\n",
        "      - name: Duplicate OpenAPI app-served drift gate\n        run: npm run check:openapi-app\n\n      - name: Capture Buck2-built app for contract test\n",
      ),
      "api-contract must run exactly one npm run check:openapi-app producer",
    );
    expectFailure(
      workflow.replace(
        "      - name: Capture Buck2-built app for contract test\n",
        "      - name: Duplicate direct Buck2 app build\n        run: tools/buck2 build //backend/app:mnt-app\n\n      - name: Capture Buck2-built app for contract test\n",
      ),
      "api-contract must not directly build //backend/app:mnt-app",
    );
    expectFailure(
      workflow.replace(
        "      - name: Employee import replay contract\n",
        "      - name: Override contract app\n        run: echo \"MNT_APP_BIN=${CARGO_TARGET_DIR}/debug/mnt-app\" >> \"$GITHUB_ENV\"\n\n      - name: Employee import replay contract\n",
      ),
      "api-contract must write MNT_APP_BIN to GITHUB_ENV exactly once",
    );
    expectFailure(
      workflow.replace(
        '          printf \'MNT_APP_BIN=%s\\n\' "${mnt_app_bin}" >> "${GITHUB_ENV}"\n',
        '          printf \'MNT_APP_BIN=%s\\n\' "${mnt_app_bin}" >> "${GITHUB_ENV}"\n          export MNT_APP_BIN=/tmp/other-mnt-app\n',
      ),
      "api-contract must not override the captured MNT_APP_BIN",
    );
    expectFailure(
      workflow.replace(
        "      - name: Employee import replay contract\n",
        "      - name: Employee import replay contract\n        env:\n          MNT_APP_BIN: /tmp/other-mnt-app\n",
      ),
      "api-contract must not override the captured MNT_APP_BIN",
    );
  });

  it("accepts equivalent safe shell syntax for the Buck2 app handoff", () => {
    const equivalentCapture = `      - name: Capture Buck2-built app for contract test
        if: \${{ !cancelled() }}
        shell: bash
        run: |
          set -euo pipefail
          mnt_app_bin="$GITHUB_WORKSPACE/.tmp/buck2/api-contract/mnt-app"
          [ -x "$mnt_app_bin" ]
          echo "MNT_APP_BIN=$mnt_app_bin" >> "$GITHUB_ENV"

`;
    const currentCapture = `      - name: Capture Buck2-built app for contract test
        if: \${{ !cancelled() }}
        shell: bash
        run: |
          set -euo pipefail
          mnt_app_bin="\${GITHUB_WORKSPACE}/.tmp/buck2/api-contract/mnt-app"
          test -x "\${mnt_app_bin}"
          printf 'MNT_APP_BIN=%s\\n' "\${mnt_app_bin}" >> "\${GITHUB_ENV}"

`;
    assert.deepEqual(evaluateCiPreflight(workflow.replace(currentCapture, equivalentCapture)).failures, []);
  });

  it("rejects a generated-face authority job without the complete closure", () => {
    expectFailure(
      workflow.replace(
        "tools/buck/preflight.sh --full-generated-faces",
        "tools/buck/preflight.sh --unexpected",
      ),
      "generated-face-authority must run the complete generated-face closure",
    );
  });

  it("requires the lock-sourced Reindeer toolchain before the full generated-face closure", () => {
    const toolchainSetup = `      - name: Install lock-pinned Reindeer Rust toolchain
        shell: bash
        run: |
          set -euo pipefail
          # shellcheck source=third-party/rust/reindeer/upstream.lock
          source third-party/rust/reindeer/upstream.lock
          rustup toolchain install "$REINDEER_TOOLCHAIN" --profile minimal

`;
    const fullGate = `      - name: Full generated-face closure
        run: tools/buck/preflight.sh --full-generated-faces
`;

    expectFailure(
      workflow.replace(toolchainSetup, ""),
      "must install the lock-pinned Reindeer Rust toolchain before full generated-face closure",
    );
    expectFailure(
      workflow.replace(
        "source third-party/rust/reindeer/upstream.lock",
        "REINDEER_TOOLCHAIN=hardcoded-not-lock-sourced",
      ),
      "must source third-party/rust/reindeer/upstream.lock",
    );
    expectFailure(
      workflow.replace(toolchainSetup, "").replace(fullGate, `${fullGate}${toolchainSetup}`),
      "must install the lock-pinned Reindeer Rust toolchain before full generated-face closure",
    );
    expectFailure(
      workflow.replace(
        "          set -euo pipefail\n          # shellcheck source=third-party/rust/reindeer/upstream.lock\n          source third-party/rust/reindeer/upstream.lock",
        "          source third-party/rust/reindeer/upstream.lock\n          set -euo pipefail",
      ),
      "must enable strict shell mode before sourcing third-party/rust/reindeer/upstream.lock",
    );
    expectFailure(
      workflow.replace(
        "          source third-party/rust/reindeer/upstream.lock\n          rustup toolchain install \"$REINDEER_TOOLCHAIN\" --profile minimal",
        "          rustup toolchain install \"$REINDEER_TOOLCHAIN\" --profile minimal\n          source third-party/rust/reindeer/upstream.lock",
      ),
      "must source third-party/rust/reindeer/upstream.lock before installing the Reindeer Rust toolchain",
    );
    expectFailure(
      workflow.replace(
        "          rustup toolchain install \"$REINDEER_TOOLCHAIN\" --profile minimal",
        "          export REINDEER_TOOLCHAIN=untrusted\n          rustup toolchain install \"$REINDEER_TOOLCHAIN\" --profile minimal",
      ),
      "must not override REINDEER_TOOLCHAIN after sourcing third-party/rust/reindeer/upstream.lock",
    );
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
