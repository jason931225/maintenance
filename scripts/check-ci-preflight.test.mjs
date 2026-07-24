import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { evaluateCiPreflight } from "./check-ci-preflight.mjs";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const cargoLockGate = "cargo metadata --manifest-path backend/Cargo.toml --locked --format-version=1 >/dev/null";
const preflightRustToolchainSetup = `      - name: Install Rust toolchain for Cargo.lock consistency
        uses: dtolnay/rust-toolchain@29eef336d9b2848a0b548edc03f92a220660cdb8 # stable
        with:
          toolchain: "1.96.0"

`;

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

  it("resolves the backend DotSlash bootstrap from its effective working directory", () => {
    expectFailure(
      workflow.replace(
        "        run: ../tools/buck/install_dotslash.sh",
        "        run: tools/buck/install_dotslash.sh",
      ),
      "backend must install pinned DotSlash from ../tools/buck/install_dotslash.sh",
    );
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
      "api-contract must contain only the approved ordered steps",
    );
    expectFailure(
      workflow.replace(
        "      - name: Employee import replay contract\n",
        "      - name: Override contract app\n        run: echo \"MNT_APP_BIN=${CARGO_TARGET_DIR}/debug/mnt-app\" >> \"$GITHUB_ENV\"\n\n      - name: Employee import replay contract\n",
      ),
      "api-contract may reference GITHUB_ENV only in the designated capture step",
    );
    expectFailure(
      workflow.replace(
        '          printf \'MNT_APP_BIN=%s\\n\' "${mnt_app_bin}" >> "${GITHUB_ENV}"\n',
        '          printf \'MNT_APP_BIN=%s\\n\' "${mnt_app_bin}" >> "${GITHUB_ENV}"\n          export MNT_APP_BIN=/tmp/other-mnt-app\n',
      ),
      "api-contract capture must use the designated verified command grammar",
    );
    expectFailure(
      workflow.replace(
        "      - name: Employee import replay contract\n",
        "      - name: Employee import replay contract\n        env:\n          MNT_APP_BIN: /tmp/other-mnt-app\n",
      ),
      "api-contract must not override the captured MNT_APP_BIN",
    );
  });

  it("accepts the designated verified Buck2 app handoff", () => {
    assert.match(workflow, /# check:openapi-app is the sole Buck2 producer for this handoff\./);
    assert.deepEqual(evaluateCiPreflight(workflow).failures, []);
  });

  it("rejects shell-spelling bypasses for API contract producers and environment writes", () => {
    expectFailure(
      workflow.replace(
        "      - name: Capture Buck2-built app for contract test\n",
        "      - name: Duplicate OpenAPI producer\n        run: |\n          # This still produces the Buck app.\n          CI=1 npm \\\n            run check:openapi-app; :\n\n      - name: Capture Buck2-built app for contract test\n",
      ),
      "api-contract must contain only the approved ordered steps",
    );
    expectFailure(
      workflow.replace(
        "      - name: Capture Buck2-built app for contract test\n",
        "      - name: Duplicate direct Buck2 app build\n        run: |\n          command ./tools/buck2 --isolation-dir .tmp \\\n            build --out .tmp/duplicate //backend/app:mnt-app # direct producer\n\n      - name: Capture Buck2-built app for contract test\n",
      ),
      "api-contract must contain only the approved ordered steps",
    );
    expectFailure(
      workflow.replace(
        "      - name: Employee import replay contract\n",
        "      - name: Late redirected override\n        run: |\n          echo \"MNT_APP_BIN=/tmp/other-mnt-app\" >> \"$GITHUB_ENV\" # still a write\n          :\n\n      - name: Employee import replay contract\n",
      ),
      "api-contract may reference GITHUB_ENV only in the designated capture step",
    );
    expectFailure(
      workflow.replace(
        "      - name: Employee import replay contract\n",
        "      - name: Late tee override\n        run: printf 'MNT_APP_BIN=/tmp/other-mnt-app\\n' | tee -a \"$GITHUB_ENV\"\n\n      - name: Employee import replay contract\n",
      ),
      "api-contract may reference GITHUB_ENV only in the designated capture step",
    );
  });

  it("fails closed on indirect producers and every non-capture GITHUB_ENV surface", () => {
    for (const command of [
      'bash -c "npm run check:openapi-app"',
      'sh -c "npm run check:openapi-app"',
      'zsh -c "npm run check:openapi-app"',
      'eval "npm run check:openapi-app"',
      '"$OPENAPI_PRODUCER"',
      'command "$OPENAPI_PRODUCER"',
      "node scripts/check-openapi-app.mjs",
    ]) {
      expectFailure(
        workflow.replace(
          "      - name: Capture Buck2-built app for contract test\n",
          `      - name: Indirect OpenAPI producer\n        run: ${command}\n\n      - name: Capture Buck2-built app for contract test\n`,
        ),
        "api-contract must contain only the approved ordered steps",
      );
    }

    expectFailure(
      workflow.replace(
        "      - name: Employee import replay contract\n",
        "      - name: Programmatic environment override\n        run: node -e 'require(\"node:fs\").appendFileSync(process.env.GITHUB_ENV, \"MNT_APP_BIN=/tmp/other\\n\")'\n\n      - name: Employee import replay contract\n",
      ),
      "api-contract may reference GITHUB_ENV only in the designated capture step",
    );
    expectFailure(
      workflow.replace(
        '          printf \'MNT_APP_BIN=%s\\n\' "${mnt_app_bin}" >> "${GITHUB_ENV}"',
        '          printf \'MNT_APP_BIN=%s\\n\' "${mnt_app_bin}" > "${GITHUB_ENV:?}"',
      ),
      "api-contract capture must use the designated verified command grammar",
    );
  });

  it("allows only the ordered API contract execution surface", () => {
    for (const command of [
      "$(printf ./tools/buck2) build //backend/app:mnt-app",
      "node ./scripts/check-openapi-app.mjs",
      "node --enable-source-maps scripts/check-openapi-app.mjs",
      "cargo build -p mnt-app",
      'env_name=GITHUB_$(printf ENV); key=MNT_APP_$(printf BIN); printf "$key=/tmp/other\\n" >> "${!env_name}"',
    ]) {
      expectFailure(
        workflow.replace(
          "      - name: Capture Buck2-built app for contract test\n",
          `      - name: Unexpected executable surface\n        run: ${command}\n\n      - name: Capture Buck2-built app for contract test\n`,
        ),
        "api-contract must contain only the approved ordered steps",
      );
    }
  });

  it("requires backend DotSlash bootstrap before any Buck or DotSlash invocation", () => {
    for (const command of ["tools/buck2 --version", "dotslash run //backend/app:mnt-app"]) {
      expectFailure(
        workflow.replace(
          "      - name: Install pinned DotSlash runtime\n        run: ../tools/buck/install_dotslash.sh\n",
          `      - name: First Buck invocation\n        run: ${command}\n\n      - name: Install pinned DotSlash runtime\n        run: ../tools/buck/install_dotslash.sh\n`,
        ),
        "backend must install pinned DotSlash before its first Buck invocation",
      );
    }
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

  it("requires the pinned Rust toolchain before Cargo-dependent preflight tests", () => {
    expectFailure(
      workflow.replace(preflightRustToolchainSetup, "").replace(
        "      - name: CI preflight contract tests\n        run: node --test scripts/check-ci-preflight.test.mjs",
        `      - name: CI preflight contract tests
        run: node --test scripts/check-ci-preflight.test.mjs

${preflightRustToolchainSetup.trimEnd()}`,
      ),
      "preflight must install the pinned Rust toolchain before node --test scripts/check-ci-preflight.test.mjs",
    );
  });

  it("rejects a preflight that does not run npm and Cargo lock consistency gates", () => {
    expectFailure(workflow.replace("npm run check:package-lock", "npm run check:root-workspaces"), "check:package-lock");
    expectFailure(
      workflow.replace(
        cargoLockGate,
        "cargo metadata --manifest-path backend/Cargo.toml --format-version=1 >/dev/null",
      ),
      cargoLockGate,
    );
  });

  it("rejects a dependency missing from Cargo.lock while the clean lock passes", () => {
    const root = mkdtempSync(join(tmpdir(), "maintenance-cargo-lock-"));
    const app = join(root, "app");
    const dependency = join(root, "dependency");
    const extra = join(root, "extra");
    try {
      for (const directory of [app, dependency, extra]) {
        mkdirSync(join(directory, "src"), { recursive: true });
      }
      writeFileSync(join(root, "Cargo.toml"), "[workspace]\nmembers = [\"app\", \"dependency\"]\nresolver = \"2\"\n");
      for (const [directory, name] of [[app, "fixture-app"], [dependency, "fixture-dependency"]]) {
        writeFileSync(join(directory, "Cargo.toml"), `[package]\nname = \"${name}\"\nversion = \"0.1.0\"\nedition = \"2024\"\n`);
        writeFileSync(join(directory, "src/lib.rs"), "pub fn fixture() {}\n");
      }
      writeFileSync(join(app, "Cargo.toml"), "[package]\nname = \"fixture-app\"\nversion = \"0.1.0\"\nedition = \"2024\"\n\n[dependencies]\nfixture-dependency = { path = \"../dependency\" }\n");
      assert.equal(spawnSync("cargo", ["generate-lockfile"], { cwd: root }).status, 0);
      assert.equal(spawnSync("cargo", ["metadata", "--manifest-path", join(app, "Cargo.toml"), "--locked", "--format-version=1"], { cwd: root }).status, 0);

      writeFileSync(join(extra, "Cargo.toml"), "[package]\nname = \"fixture-extra\"\nversion = \"0.1.0\"\nedition = \"2024\"\n");
      writeFileSync(join(extra, "src/lib.rs"), "pub fn extra() {}\n");
      writeFileSync(join(app, "Cargo.toml"), "[package]\nname = \"fixture-app\"\nversion = \"0.1.0\"\nedition = \"2024\"\n\n[dependencies]\nfixture-dependency = { path = \"../dependency\" }\nfixture-extra = { path = \"../extra\" }\n");
      assert.equal(spawnSync("cargo", ["metadata", "--manifest-path", join(app, "Cargo.toml"), "--locked", "--no-deps", "--format-version=1"], { cwd: root }).status, 0);
      assert.notEqual(spawnSync("cargo", ["metadata", "--manifest-path", join(app, "Cargo.toml"), "--locked", "--format-version=1"], { cwd: root }).status, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
