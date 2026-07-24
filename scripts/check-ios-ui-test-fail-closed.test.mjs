import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { evaluateIosUiTestFailClosedChecks } from "./check-ios-ui-test-fail-closed.mjs";

const validLauncher = readFileSync(new URL("./boot-ios-ui-backend.mjs", import.meta.url), "utf8");
const validBoot = '          MNT_IOS_COLDSTART_OTP="$COLDSTART_OTP" "$MNT_IOS_NODE_BIN" "$ROOT/scripts/boot-ios-ui-backend.mjs" "$ROOT" "$AUTH_DIR" "$BP"';
const validWorkflow = readFileSync(new URL("../.github/workflows/ios-ui-tests.yml", import.meta.url), "utf8");
const validFiles = {
  ".github/workflows/ios-ui-tests.yml": validWorkflow,
  "scripts/boot-ios-ui-backend.mjs": validLauncher,
  "ios/Sources/MaintenanceFieldApp/Info.plist": readFileSync(new URL("../ios/Sources/MaintenanceFieldApp/Info.plist", import.meta.url), "utf8"),
  "ios/Sources/MaintenanceFieldApp/FieldApp.swift": readFileSync(new URL("../ios/Sources/MaintenanceFieldApp/FieldApp.swift", import.meta.url), "utf8"),
  "ios/Sources/MaintenanceFieldCore/PersistenceStores.swift": readFileSync(new URL("../ios/Sources/MaintenanceFieldCore/PersistenceStores.swift", import.meta.url), "utf8"),
  "ios/Sources/MaintenanceFieldApp/FieldAccessibilityID.swift": readFileSync(new URL("../ios/Sources/MaintenanceFieldApp/FieldAccessibilityID.swift", import.meta.url), "utf8"),
  "ios/Sources/MaintenanceFieldApp/FieldViews.swift": readFileSync(new URL("../ios/Sources/MaintenanceFieldApp/FieldViews.swift", import.meta.url), "utf8"),
  "ios/Sources/MaintenanceFieldApp/CameraCaptureView.swift": readFileSync(new URL("../ios/Sources/MaintenanceFieldApp/CameraCaptureView.swift", import.meta.url), "utf8"),
  "ios/UITests/Support/FieldUITestCase.swift": readFileSync(new URL("../ios/UITests/Support/FieldUITestCase.swift", import.meta.url), "utf8"),
  "ios/UITests/AccessibilityAuditUITests.swift": readFileSync(new URL("../ios/UITests/AccessibilityAuditUITests.swift", import.meta.url), "utf8"),
  "ios/UITests/DynamicTypeRuntimeUITests.swift": readFileSync(new URL("../ios/UITests/DynamicTypeRuntimeUITests.swift", import.meta.url), "utf8"),
  "ios/UITests/Support/RealSessionSeed.swift": readFileSync(new URL("../ios/UITests/Support/RealSessionSeed.swift", import.meta.url), "utf8"),
  "ios/Sources/MaintenanceFieldUITestSeeder/UITestSeederApp.swift": readFileSync(new URL("../ios/Sources/MaintenanceFieldUITestSeeder/UITestSeederApp.swift", import.meta.url), "utf8"),
  "ios/Config/App.xcconfig": readFileSync(new URL("../ios/Config/App.xcconfig", import.meta.url), "utf8"),
  "ios/Config/MaintenanceFieldApp.entitlements": readFileSync(new URL("../ios/Config/MaintenanceFieldApp.entitlements", import.meta.url), "utf8"),
  "ios/Config/MaintenanceFieldUITestSeeder.entitlements": readFileSync(new URL("../ios/Config/MaintenanceFieldUITestSeeder.entitlements", import.meta.url), "utf8"),
  "ios/project.yml": readFileSync(new URL("../ios/project.yml", import.meta.url), "utf8"),
  "ios/UITests/FieldCriticalPathUITests.swift": readFileSync(new URL("../ios/UITests/FieldCriticalPathUITests.swift", import.meta.url), "utf8"),
  "ios/UITests/MessengerUITests.swift": readFileSync(new URL("../ios/UITests/MessengerUITests.swift", import.meta.url), "utf8"),
  "ios/UITests/CameraCaptureUITests.swift": readFileSync(new URL("../ios/UITests/CameraCaptureUITests.swift", import.meta.url), "utf8"),
  "ios/UITests/PreflightUITests.swift": readFileSync(new URL("../ios/UITests/PreflightUITests.swift", import.meta.url), "utf8"),
  "ios/UITests/LoginValidationUITests.swift": readFileSync(new URL("../ios/UITests/LoginValidationUITests.swift", import.meta.url), "utf8"),
  "e2e/harness/seed-mobile-ci.sql": readFileSync(new URL("../e2e/harness/seed-mobile-ci.sql", import.meta.url), "utf8"),
};
const evaluate = (overrides = {}) => evaluateIosUiTestFailClosedChecks({ ...validFiles, ...overrides });
const expectsFailure = (result, fragment) => assert.ok(result.failures.some((failure) => failure.includes(fragment)), `Expected ${fragment}: ${result.failures}`);
const mutateWorkflow = (search, replacement) => {
  const mutated = validWorkflow.replace(search, replacement);
  assert.notEqual(mutated, validWorkflow, `Workflow mutation source was not found: ${String(search)}`);
  return mutated;
};
const mutateWorkflowAll = (search, replacement) => {
  const mutated = validWorkflow.replaceAll(search, replacement);
  assert.notEqual(mutated, validWorkflow, `Workflow mutation source was not found: ${String(search)}`);
  return mutated;
};
const mutateFile = (source, search, replacement) => {
  const mutated = source.replace(search, replacement);
  assert.notEqual(mutated, source, `File mutation source was not found: ${String(search)}`);
  return mutated;
};
const mutateFileAll = (source, search, replacement) => {
  const mutated = source.replaceAll(search, replacement);
  assert.notEqual(mutated, source, `File mutation source was not found: ${String(search)}`);
  return mutated;
};

describe("iOS hermetic UI CI contract", () => {
  it("accepts the hosted, sharded hermetic workflow", () => assert.deepEqual(evaluate().failures, []));
  it("rejects public self-hosted or configurable runner exposure", () => {
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("runs-on: macos-26", "runs-on: ${{ vars.MNT_IOS_CI_RUNNER }}") }), "untrusted PR code");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("runs-on: macos-26", "runs-on: [self-hosted, macos]") }), "untrusted PR code");
  });
  it("rejects non-exact checkout or cross-batch resource and artifact collisions", () => {
    const isolationGate = "batch-unique job-root";
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("ref: ${{ github.sha }}", "ref: main") }), isolationGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(
      'D="$RUNNER_TEMP/ios-ui-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${MNT_IOS_BATCH_NAME}"',
      'D="$RUNNER_TEMP/ios-ui-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',
    ) }), isolationGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(
      '"Maintenance CI ${MNT_IOS_BATCH_NAME}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',
      '"Maintenance CI ${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',
    ) }), isolationGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow('name: "ios-ui-test-results-${{ matrix.batch }}"', "name: ios-ui-test-results") }), isolationGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(
      '${{ github.run_attempt }}-${{ matrix.batch }}/artifacts',
      '${{ github.run_attempt }}/artifacts',
    ) }), isolationGate);
  });
  it("rejects watchdog inflation, incomplete batches, or unbounded matrix fanout", () => {
    const matrixGate = "five bounded isolated shard batches";
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("timeout-minutes: 45", "timeout-minutes: 44") }), matrixGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("timeout-minutes: 45", "timeout-minutes: 90") }), matrixGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("fail-fast: false", "fail-fast: true") }), matrixGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("max-parallel: 5", "max-parallel: 15") }), matrixGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(
      `critical-path)
                SHARD_TIMEOUT_SECONDS=360`,
      `critical-path)
                SHARD_TIMEOUT_SECONDS=540`,
    ) }), matrixGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(
      'shards: "critical-path camera-capture"',
      'shards: "critical-path"',
    ) }), matrixGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(
      'shards: "critical-path camera-capture"',
      'shards: "critical-path camera-capture preflight"',
    ) }), matrixGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("-parallel-testing-enabled NO", "-parallel-testing-enabled YES") }), matrixGate);
  });
  it("rejects toolchain and job-root drift", () => {
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("Build version 17F113", "Build version drift") }), "pin Xcode 26.6");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("Apple Swift version 6.3.3", "Apple Swift version drift") }), "pin Xcode 26.6");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("iOS-26-5", "iOS-26-4") }), "pin Xcode 26.6");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflowAll("SimDeviceType.iPhone-17-Pro", "SimDeviceType.iPhone-16") }), "pin Xcode 26.6");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("CARGO_TARGET_DIR=$D/cargo-target", "CARGO_TARGET_DIR=/tmp/cargo") }), "pin Xcode 26.6");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(
      "      DEVELOPER_DIR: /Applications/Xcode_26.6.app/Contents/Developer",
      "      DEVELOPER_DIR: /Applications/Xcode_26.6.app/Contents/Developer\n      RUNNER_TOOL_CACHE: ${{ github.workspace }}/shadow-cache",
    ) }), "bind Node");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(
      '        env: {CARGO_INCREMENTAL: "0", CARGO_PROFILE_DEV_DEBUG: "0", SQLX_OFFLINE: "true"}',
      '        env: {CARGO_INCREMENTAL: "0", SQLX_OFFLINE: "true", RUNNER_ARCH: X64, RUNNER_TOOL_CACHE: ${{ github.workspace }}/shadow-cache}',
    ) }), "bind Node");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(
      "jobs:",
      "env:\n  RUNNER_TOOL_CACHE: ${{ github.workspace }}/shadow-cache\njobs:",
    ) }), "bind Node");
    for (const [name, value] of [
      ["BASH_ENV", "${{ github.workspace }}/scripts/bash-env-hook"],
      ["NODE_OPTIONS", "--require=${{ github.workspace }}/scripts/node-hook.cjs"],
    ]) {
      expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(
        '        env: {CARGO_INCREMENTAL: "0", CARGO_PROFILE_DEV_DEBUG: "0", SQLX_OFFLINE: "true"}',
        `        env: {CARGO_INCREMENTAL: "0", SQLX_OFFLINE: "true", ${name}: ${value}}`,
      ) }), "bind Node");
    }
    for (const shell of [
      `"bash -c 'source $GITHUB_WORKSPACE/scripts/evil; source {0}'"`,
      `"BASH_ENV=$GITHUB_WORKSPACE/scripts/evil bash {0}"`,
    ]) {
      expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(
        "        working-directory: ios\n        shell: bash",
        `        working-directory: ios\n        shell: ${shell}`,
      ) }), "bind Node");
    }
  });
  it("rejects any target or xcconfig that falls back from Swift 6 language mode", () => {
    expectsFailure(evaluate({ "ios/project.yml": mutateFile(
      validFiles["ios/project.yml"],
      '        GENERATE_INFOPLIST_FILE: "YES"\n        INFOPLIST_KEY_CFBundleDisplayName: "MaintenanceFieldUITests"',
      '        SWIFT_VERSION: "5.0"\n        GENERATE_INFOPLIST_FILE: "YES"\n        INFOPLIST_KEY_CFBundleDisplayName: "MaintenanceFieldUITests"',
    ) }), "Swift 6 language mode");
    expectsFailure(evaluate({ "ios/Config/App.xcconfig": mutateFile(
      validFiles["ios/Config/App.xcconfig"],
      "SWIFT_VERSION = 6.0",
      "SWIFT_VERSION = 5.0",
    ) }), "Swift 6 language mode");
  });
  it("rejects release-optimized or unstripped backend builds in behavioral E2E", () => {
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow('CARGO_PROFILE_DEV_DEBUG: "0", ', "") }), "stripped-debug mnt-app");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("cargo build --locked -p mnt-app", "cargo build --locked --release -p mnt-app") }), "stripped-debug mnt-app");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("$CARGO_TARGET_DIR/debug/mnt-app", "$CARGO_TARGET_DIR/release/mnt-app") }), "stripped-debug mnt-app");
  });
  it("rejects missing pipeline phase or shard timing evidence", () => {
    const timingGate = "durable phase and per-shard timings";
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow('TIMINGS="$ARTIFACTS/pipeline-timings.tsv"', 'TIMINGS="$ARTIFACTS/missing.tsv"') }), timingGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("timing_start rust-debug-build", "true # missing rust timing") }), timingGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow('TIMING_BUDGET_SECONDS="$SHARD_TIMEOUT_SECONDS"', 'TIMING_BUDGET_SECONDS="-"') }), timingGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow('timing_start "test:$shard_name"', 'timing_start "test:unknown"') }), timingGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("trap on_exit EXIT", "trap 'clean_runtime || true' EXIT") }), timingGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow('timing_finish "aborted(exit=$exit_status)"', "true # missing aborted timing") }), timingGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("status=124", "status=0 # missing timeout classification") }), timingGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("timing_finish timeout", "timing_finish failed") }), timingGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("### iOS UI pipeline timings", "### missing timings") }), timingGate);
  });
  it("rejects mutable XcodeGen and unsafe PGDATA", () => {
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("4d9e34b62172d645eed6457cac13fc222569974098ef4ee9c3368bedf0196806", "dynamic") }), "checksum-pinned XcodeGen");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow('install -d -m 700 "$D" "$AUTH_DIR" "$PGDATA" "$RAW_RESULTS" "$ARTIFACTS"', 'mkdir -p /tmp/pg') }), "mode-0700 job-root PGDATA");
  });
  it("rejects PostgreSQL builds that omit or cannot load the complete extension set", () => {
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(" --with-ssl=openssl", "") }), "pgcrypto");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("--with-ssl=openssl", "--without-ssl # --with-ssl=openssl") }), "pgcrypto");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(' export CPPFLAGS="-I$OPENSSL_PREFIX/include" LDFLAGS="-L$OPENSSL_PREFIX/lib" PKG_CONFIG_PATH="$OPENSSL_PREFIX/lib/pkgconfig"', "") }), "pgcrypto");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(' && make -C contrib/pgcrypto -j"$(sysctl -n hw.ncpu)"', "") }), "pgcrypto");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(" && make -C contrib/pgcrypto install", "") }), "pgcrypto");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(" -c 'CREATE EXTENSION pgcrypto;'", "") }), "pgcrypto");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(" -c 'DROP EXTENSION pgcrypto;'", "") }), "pgcrypto");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(' && make -C contrib/pg_trgm -j"$(sysctl -n hw.ncpu)"', "") }), "pg_trgm");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(" && make -C contrib/pg_trgm install", "") }), "pg_trgm");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(" -c 'CREATE EXTENSION pg_trgm;'", "") }), "pg_trgm");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(" -c 'DROP EXTENSION pg_trgm;'", "") }), "pg_trgm");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(' && make -C contrib/pgcrypto -j"$(sysctl -n hw.ncpu)" && make -C contrib/pgcrypto install', ' # make -C contrib/pgcrypto -j"$(sysctl -n hw.ncpu)" && make -C contrib/pgcrypto install') }), "pgcrypto");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(' && make -C contrib/pg_trgm -j"$(sysctl -n hw.ncpu)" && make -C contrib/pg_trgm install', ' # make -C contrib/pg_trgm -j"$(sysctl -n hw.ncpu)" && make -C contrib/pg_trgm install') }), "pg_trgm");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow('          PGPASSWORD="$UP"', '          # PGPASSWORD="$UP"') }), "pg_trgm");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow('"$PG_PREFIX/bin/pg_ctl" -D "$PGDATA" -o "-h 127.0.0.1 -p $PP" -w start', "true") }), "pg_trgm");
  });
  it("rejects invalid WebAuthn relying-party configuration", () => {
    expectsFailure(evaluate({ "scripts/boot-ios-ui-backend.mjs": validLauncher.replace("http://localhost:", "http://127.0.0.1:") }), "WebAuthn");
    expectsFailure(evaluate({ "scripts/boot-ios-ui-backend.mjs": validLauncher.replace('E2E_RP_ID: "localhost"', 'E2E_RP_ID: "localhost.evil"') }), "WebAuthn");
    expectsFailure(evaluate({ "scripts/boot-ios-ui-backend.mjs": validLauncher.replace("shell: false", "shell: true") }), "WebAuthn");
    expectsFailure(evaluate({ "scripts/boot-ios-ui-backend.mjs": validLauncher.replace("delete env.MNT_IOS_COLDSTART_OTP;", "") }), "WebAuthn");
    expectsFailure(evaluate({ "scripts/boot-ios-ui-backend.mjs": "" }), "WebAuthn");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(validBoot, `${validBoot}\n          ${validBoot.trim()}`) }), "WebAuthn");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(validBoot, '          MNT_IOS_COLDSTART_OTP="$COLDSTART_OTP" node "$ROOT/scripts/not-the-launcher.mjs" "$ROOT" "$AUTH_DIR" "$BP"') }), "WebAuthn");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(validBoot, '          E2E_AUTH_DIR="$AUTH_DIR" E2E_HTTP_ADDR="127.0.0.1:$BP" E2E_RP_ORIGIN="$URL" E2E_RP_ID=127.0.0.1 "$ROOT/e2e/harness/boot-backend.sh"') }), "WebAuthn");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(validBoot, `          cat <<'EOF'\n${validBoot}\n          EOF\n          E2E_AUTH_DIR="$AUTH_DIR" E2E_HTTP_ADDR="127.0.0.1:$BP" E2E_RP_ORIGIN="$URL" E2E_RP_ID=127.0.0.1 "$ROOT/e2e/harness/boot-backend.sh"`) }), "WebAuthn");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(validBoot, `          cat <<'EOF'\n${validBoot}\n          EOF`) }), "WebAuthn");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(validBoot, `          PAYLOAD='\n${validBoot}\n          '\n          node "$ROOT/scripts/alternate-backend-launcher.mjs"`) }), "WebAuthn");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(validBoot, `${validBoot}\n          node "$ROOT/scripts/alternate-backend-launcher.mjs"`) }), "WebAuthn");
    const shadowedNode = validWorkflow
      .replace(validBoot, validBoot.replace('"$MNT_IOS_NODE_BIN"', "node"))
      .replace('          "$ROOT/e2e/harness/db.sh"', `          node() { command node "$ROOT/scripts/alternate-backend-launcher.mjs"; }\n          "$ROOT/e2e/harness/db.sh"`);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": shadowedNode }), "WebAuthn");
    const pathShadowedNode = validWorkflow
      .replace(validBoot, validBoot.replace('"$MNT_IOS_NODE_BIN"', "/usr/bin/env node"))
      .replace('          "$ROOT/e2e/harness/db.sh"', `          PATH="$ROOT/scripts/shadow:$PATH"\n          "$ROOT/e2e/harness/db.sh"`);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": pathShadowedNode }), "WebAuthn");
    const reassignedTrustedNode = mutateWorkflow(
      '          readonly MNT_IOS_NODE_BIN="$RUNNER_TOOL_CACHE/node/24.16.0/$NODE_ARCH/bin/node"',
      '          readonly MNT_IOS_NODE_BIN="$RUNNER_TOOL_CACHE/node/24.16.0/$NODE_ARCH/bin/node"\n          MNT_IOS_NODE_BIN="$GITHUB_WORKSPACE/scripts/shadow-node"',
    );
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": reassignedTrustedNode }), "bind Node");
    const capturePathPoisonedNode = mutateWorkflow(
      "          set -euo pipefail\n          unset BASH_ENV",
      "          set -euo pipefail\n          PATH=\"$GITHUB_WORKSPACE/scripts/shadow:$PATH\"\n          unset BASH_ENV",
    );
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": capturePathPoisonedNode }), "bind Node");
    const githubEnvironmentPoisonedNode = mutateWorkflow(
      '"MNT_IOS_JOB_ROOT=$D" "CARGO_HOME=$D/cargo-home"',
      '"MNT_IOS_NODE_BIN=$GITHUB_WORKSPACE/scripts/shadow-node" "MNT_IOS_JOB_ROOT=$D" "CARGO_HOME=$D/cargo-home"',
    );
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": githubEnvironmentPoisonedNode }), "bind Node");
    const postPidAlternateLauncher = mutateWorkflow(
      '          BACKEND_PID="$(cat "$BACKEND_PID_FILE")"',
      '          BACKEND_PID="$(cat "$BACKEND_PID_FILE")"\n          "$MNT_IOS_NODE_BIN" "$ROOT/scripts/alternate-backend-launcher.mjs"',
    );
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": postPidAlternateLauncher }), "WebAuthn");
    const postPidAlternateShellLauncher = mutateWorkflow(
      '          BACKEND_PID="$(cat "$BACKEND_PID_FILE")"',
      '          BACKEND_PID="$(cat "$BACKEND_PID_FILE")"\n          "$ROOT/scripts/alternate-backend-launcher.sh"',
    );
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": postPidAlternateShellLauncher }), "WebAuthn");
  });
  it("rejects missing or FK-unsafe per-class fixture restoration", () => {
    const seed = validFiles["e2e/harness/seed-mobile-ci.sql"];
    expectsFailure(evaluate({
      "e2e/harness/seed-mobile-ci.sql": mutateFile(seed, "DELETE FROM location_consent_ledger", "-- missing consent ledger reset"),
    }), "exact mutable mobile fixture baseline");
    expectsFailure(evaluate({
      "e2e/harness/seed-mobile-ci.sql": mutateFile(seed, "DELETE FROM messenger_read_receipts", "DELETE FROM messenger_messages"),
    }), "exact mutable mobile fixture baseline");
    expectsFailure(evaluate({
      "e2e/harness/seed-mobile-ci.sql": mutateFile(seed, "ELSE 'IN_PROGRESS'", "ELSE 'REPORT_SUBMITTED'"),
    }), "exact mutable mobile fixture baseline");
    expectsFailure(evaluate({
      "e2e/harness/seed-mobile-ci.sql": mutateFile(seed, "DELETE FROM work_order_approval_steps", "DELETE FROM audit_events"),
    }), "exact mutable mobile fixture baseline");
    expectsFailure(evaluate({
      "e2e/harness/seed-mobile-ci.sql": mutateFile(seed, "00000000-0000-0000-0000-000000c20008", "00000000-0000-0000-0000-000000c20001"),
    }), "isolated one-row Today and Messenger fixture");
  });

  it("rejects accessibility fixture-profile cross-contamination", () => {
    const seed = validFiles["e2e/harness/seed-mobile-ci.sql"];
    const profileGate = "isolated one-row Today and Messenger fixture";
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(
      `audit-dynamic-today)
                SHARD_FIXTURE_PROFILE=accessibility-audit-one-row`,
      `audit-dynamic-today)
                SHARD_FIXTURE_PROFILE=full`,
    ) }), profileGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(
      `dynamic-type-ax5)
                SHARD_FIXTURE_PROFILE=accessibility-audit-one-row`,
      `dynamic-type-ax5)
                SHARD_FIXTURE_PROFILE=full`,
    ) }), profileGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("*) return 1 ;;", "*) SHARD_TIMEOUT_SECONDS=1 ;;") }), profileGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow('mint_shard_session "$SHARD_FIXTURE_PROFILE"', 'mint_shard_session full') }), profileGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(' -v "fixture_profile=$fixture_profile"', "") }), profileGate);
    expectsFailure(evaluate({ "e2e/harness/seed-mobile-ci.sql": mutateFile(seed, "\\if :{?fixture_profile}", "\\if false") }), profileGate);
    expectsFailure(evaluate({ "e2e/harness/seed-mobile-ci.sql": mutateFile(seed, "IN ('full', 'accessibility-audit-one-row')", "IN ('full', 'accessibility-audit-one-row', 'anything')") }), profileGate);
    expectsFailure(evaluate({ "e2e/harness/seed-mobile-ci.sql": mutateFile(seed, "COUNT(*) = 5", "COUNT(*) = 3") }), profileGate);
    expectsFailure(evaluate({ "e2e/harness/seed-mobile-ci.sql": mutateFile(seed, "COUNT(*) = 8", "COUNT(*) = 7") }), profileGate);
  });
  it("rejects missing, mismatched, or wrongly wired app/seeder keychain configuration", () => {
    expectsFailure(evaluate({
      "ios/Config/MaintenanceFieldUITestSeeder.entitlements": validFiles["ios/Config/MaintenanceFieldUITestSeeder.entitlements"].replace("com.maintenance.field.shared", "com.maintenance.field.wrong"),
    }), "identically signed default keychain access group");
    expectsFailure(evaluate({
      "ios/Config/MaintenanceFieldUITestSeeder.entitlements": validFiles["ios/Config/MaintenanceFieldUITestSeeder.entitlements"].replace("<key>keychain-access-groups</key>", "<key>missing-keychain-access-groups</key>"),
    }), "identically signed default keychain access group");
    expectsFailure(evaluate({
      "ios/project.yml": validFiles["ios/project.yml"].replace("Sources/MaintenanceFieldUITestSeeder", "Sources/MissingSeeder"),
    }), "identically signed default keychain access group");
    expectsFailure(evaluate({
      "ios/project.yml": validFiles["ios/project.yml"].replace("- target: MaintenanceFieldUITestSeeder", "- target: MissingSeeder"),
    }), "identically signed default keychain access group");
    expectsFailure(evaluate({
      "ios/project.yml": validFiles["ios/project.yml"].replace("CODE_SIGN_ENTITLEMENTS: Config/MaintenanceFieldUITestSeeder.entitlements", "CODE_SIGN_ENTITLEMENTS: Config/Missing.entitlements"),
    }), "identically signed default keychain access group");
    expectsFailure(evaluate({
      "ios/Config/App.xcconfig": validFiles["ios/Config/App.xcconfig"].replace("CODE_SIGNING_ALLOWED = YES", "CODE_SIGNING_ALLOWED = NO"),
    }), "identically signed default keychain access group");
  });
  it("rejects a UI-test Keychain implementation instead of the dedicated helper", () => {
    expectsFailure(evaluate({
      "ios/UITests/Support/RealSessionSeed.swift": `${validFiles["ios/UITests/Support/RealSessionSeed.swift"]}\nimport Security\nlet forbidden = kSecAttrAccessGroup`,
    }), "system-granted default group");
    expectsFailure(evaluate({
      "ios/Sources/MaintenanceFieldUITestSeeder/UITestSeederApp.swift": validFiles["ios/Sources/MaintenanceFieldUITestSeeder/UITestSeederApp.swift"].replace("KeychainAccessGroup.resolveShared", "MissingAccessGroup.resolveShared"),
    }), "system-granted default group");
    expectsFailure(evaluate({
      "ios/Sources/MaintenanceFieldCore/PersistenceStores.swift": validFiles["ios/Sources/MaintenanceFieldCore/PersistenceStores.swift"].replace(
        "        let add: [String: Any] = [\n            kSecClass as String: kSecClassGenericPassword,\n            kSecAttrService as String: service,\n            kSecAttrAccount as String: account,",
        "        let add: [String: Any] = [\n            kSecClass as String: kSecClassGenericPassword,\n            kSecAttrService as String: service,\n            kSecAttrAccount as String: account,\n            kSecAttrAccessGroup as String: \"forbidden\",",
      ),
    }), "system-granted default group");
    expectsFailure(evaluate({
      "ios/Sources/MaintenanceFieldCore/PersistenceStores.swift": validFiles["ios/Sources/MaintenanceFieldCore/PersistenceStores.swift"].replace(
        "guard let result = try? probe.addProbe",
        "guard let result = try! probe.addProbe",
      ),
    }), "system-granted default group");
    expectsFailure(evaluate({
      "ios/Sources/MaintenanceFieldCore/PersistenceStores.swift": mutateFile(
        validFiles["ios/Sources/MaintenanceFieldCore/PersistenceStores.swift"],
        "try probe.deleteProbe",
        "try! probe.deleteProbe",
      ),
    }), "system-granted default group");
  });
  it("rejects UI automation that can launch outside the main actor", () => {
    const fieldCase = validFiles["ios/UITests/Support/FieldUITestCase.swift"];
    const fakeFieldContract = `@MainActor
class FieldUITestCase: XCTestCase {
  override func setUpWithError() throws {
    try super.setUpWithError()
    try RealSessionSeed.seed(tokens)
  }
  override func tearDownWithError() throws {
    try RealSessionSeed.clear()
    try super.tearDownWithError()
  }
}`;
    expectsFailure(evaluate({
      "ios/UITests/Support/FieldUITestCase.swift": fieldCase.replace("@MainActor\nclass FieldUITestCase", "class FieldUITestCase"),
    }), "confine XCUIApplication");
    expectsFailure(evaluate({
      "ios/UITests/Support/FieldUITestCase.swift": fieldCase.replace("setUpWithError() throws", "setUp() async throws"),
    }), "confine XCUIApplication");
    expectsFailure(evaluate({
      "ios/UITests/Support/FieldUITestCase.swift": fieldCase.replace("tearDownWithError() throws", "tearDown() async throws"),
    }), "confine XCUIApplication");
    expectsFailure(evaluate({
      "ios/UITests/Support/RealSessionSeed.swift": validFiles["ios/UITests/Support/RealSessionSeed.swift"].replace("@MainActor\nenum RealSessionSeed", "enum RealSessionSeed"),
    }), "confine XCUIApplication");
    expectsFailure(evaluate({
      "ios/UITests/PreflightUITests.swift": validFiles["ios/UITests/PreflightUITests.swift"].replace("@MainActor\n", ""),
    }), "confine XCUIApplication");
    expectsFailure(evaluate({
      "ios/UITests/LoginValidationUITests.swift": validFiles["ios/UITests/LoginValidationUITests.swift"].replace("@MainActor\n", ""),
    }), "confine XCUIApplication");
    expectsFailure(evaluate({
      "ios/UITests/Support/FieldUITestCase.swift": `/* ${fakeFieldContract} */\n${fieldCase.replace("@MainActor\nclass FieldUITestCase", "class FieldUITestCase")}`,
    }), "confine XCUIApplication");
    expectsFailure(evaluate({
      "ios/UITests/Support/FieldUITestCase.swift": `let fake = """\n${fakeFieldContract}\n"""\n${fieldCase.replace("@MainActor\nclass FieldUITestCase", "class FieldUITestCase")}`,
    }), "confine XCUIApplication");
    expectsFailure(evaluate({
      "ios/UITests/Support/FieldUITestCase.swift": `let fake = """\n\\\"""\n${fakeFieldContract}\n"""\n${fieldCase.replace("@MainActor\nclass FieldUITestCase", "class FieldUITestCase")}`,
    }), "confine XCUIApplication");
    expectsFailure(evaluate({
      "ios/UITests/Support/FieldUITestCase.swift": `let fake = #"""\n\\#"""#\n${fakeFieldContract}\n"""#\n${fieldCase.replace("@MainActor\nclass FieldUITestCase", "class FieldUITestCase")}`,
    }), "confine XCUIApplication");
    expectsFailure(evaluate({
      "ios/UITests/Support/FieldUITestCase.swift": fieldCase.replace("@MainActor\nclass FieldUITestCase", "// @MainActor\nclass FieldUITestCase"),
    }), "confine XCUIApplication");
    expectsFailure(evaluate({
      "ios/UITests/Support/RealSessionSeed.swift": validFiles["ios/UITests/Support/RealSessionSeed.swift"].replace("@MainActor\nenum RealSessionSeed", "// @MainActor\nenum RealSessionSeed"),
    }), "confine XCUIApplication");
    expectsFailure(evaluate({
      "ios/UITests/PreflightUITests.swift": validFiles["ios/UITests/PreflightUITests.swift"].replace("@MainActor\n", "// @MainActor\n"),
    }), "confine XCUIApplication");
    expectsFailure(evaluate({
      "ios/UITests/LoginValidationUITests.swift": validFiles["ios/UITests/LoginValidationUITests.swift"].replace("@MainActor\n", "// @MainActor\n"),
    }), "confine XCUIApplication");
  });
  it("rejects Runner mutation, stale Runner environment injection, and incomplete Mach-O entitlement proof", () => {
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(
      '/usr/bin/codesign --verify --deep --strict "$SEEDER_APP"',
      "true",
    ) }), "preserve the Xcode-created Simulator Runner");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(
      '/usr/bin/codesign --verify --deep --strict "$UITEST_RUNNER_APP"',
      '/usr/bin/codesign --force --sign - "$UITEST_RUNNER_APP"',
    ) }), "preserve the Xcode-created Simulator Runner");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(
      'test "$APP_KEYCHAIN_GROUP" = "$SEEDER_KEYCHAIN_GROUP"',
      "true",
    ) }), "preserve the Xcode-created Simulator Runner");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(
      'APP_KEYCHAIN_GROUP="$(mach_o_keychain_group "$BUILT_APP/MaintenanceFieldApp")"',
      'APP_KEYCHAIN_GROUP="missing"',
    ) }), "preserve the Xcode-created Simulator Runner");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(
      '/usr/bin/lipo -archs "$executable"',
      'false # missing lipo architecture inspection',
    ) }), "preserve the Xcode-created Simulator Runner");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(
      '/bin/cp "$executable" "$thin"',
      '/usr/bin/lipo "$executable" -thin "$MACH_O_ARCH" -output "$thin"',
    ) }), "preserve the Xcode-created Simulator Runner");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(
      '_, _, segment, _, _, _, _, _, _, nsects, _ = struct.unpack_from("<II16sQQQQiiII", executable, offset)',
      '_, _, segment, _, _, _, _, _, nsects, _ = struct.unpack_from("<II16sQQQQiiII", executable, offset)',
    ) }), "preserve the Xcode-created Simulator Runner");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(
      "--env MNT_UITEST_BASE_URL",
      "--env MNT_IOS_KEYCHAIN_GROUP --env MNT_UITEST_BASE_URL",
    ) }), "preserve the Xcode-created Simulator Runner");
  });
  it("rejects xctestrun, ATS, and fail-slow xcresult regression", () => {
    const failSlow = "each iOS UI matrix worker";
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow('chmod 600 "$XCTESTRUN"', "") }), "mode-0600");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow('CI_PLIST="$D/Info.ci.plist"', 'CI_PLIST="$RUNNER_TEMP/Info.plist"') }), "CI-only job-root");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow('run_xcode_with_timeout "$shard_name" "$result" "$SHARD_TIMEOUT_SECONDS" "${SHARD_SELECTORS[@]}" || { shard_status=$?; TEST_STATUS=1; }', 'run_xcode_with_timeout "$shard_name" "$result" "$SHARD_TIMEOUT_SECONDS" "${SHARD_SELECTORS[@]}"') }), failSlow);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("os.setsid(); ", "") }), failSlow);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflowAll('kill -TERM -- "-$test_pid"', 'kill -TERM "$test_pid"') }), failSlow);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflowAll('kill -KILL -- "-$test_pid"', 'kill -KILL "$test_pid"') }), failSlow);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow('if ! configure_shard "$shard_name"; then', 'if configure_shard "$shard_name"; then') }), failSlow);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow('if ! set_simulator_presentation "$SHARD_APPEARANCE" "$SHARD_CONTENT_SIZE"; then', 'if set_simulator_presentation "$SHARD_APPEARANCE" "$SHARD_CONTENT_SIZE"; then') }), failSlow);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow('if ! mint_shard_session "$SHARD_FIXTURE_PROFILE"; then', 'if mint_shard_session "$SHARD_FIXTURE_PROFILE"; then') }), failSlow);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow('if [[ "$shard_name" == camera-capture ]] && ! xcrun simctl privacy "$UUID" reset camera; then', 'if [[ "$shard_name" == camera-capture ]] && xcrun simctl privacy "$UUID" reset camera; then') }), failSlow);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(`timing_finish setup-failed
              continue`, `timing_finish setup-failed
              :`) }), failSlow);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow('read -r -a SHARD_MANIFEST <<< "$MNT_IOS_SHARD_BATCH"', "SHARD_MANIFEST=(preflight)") }), failSlow);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow('printf \'%s\\n\' "$MNT_IOS_BATCH_NAME" > "$ARTIFACTS/batch-name.txt"', "true") }), failSlow);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow('if ! clean_runtime; then', 'if clean_runtime; then') }), failSlow);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow('exit "$TEST_STATUS"', 'exit 0') }), failSlow);
  });
  it("rejects incomplete or fail-open cross-worker result aggregation", () => {
    const aggregateGate = "exactly one structured summary and tests JSON";
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("needs: ios-ui-tests", "needs: []") }), aggregateGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(
      `ios-ui-results:
    name: iOS — aggregate structured results
    needs: ios-ui-tests
    if: always()`,
      `ios-ui-results:
    name: iOS — aggregate structured results
    needs: ios-ui-tests`,
    ) }), aggregateGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("pattern: ios-ui-test-results-*", "pattern: ios-ui-test-results-core") }), aggregateGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow('name: "ios-ui-test-results-${{ matrix.batch }}"', "name: ios-ui-test-results") }), aggregateGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("if-no-files-found: error", "if-no-files-found: warn") }), aggregateGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(
      "EXPECTED_BATCHES=(core critical messenger-dynamic audit-standard audit-adaptive)",
      "EXPECTED_BATCHES=(core critical messenger-dynamic audit-standard)",
    ) }), aggregateGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(
      "EXPECTED_SHARDS=(preflight login-validation accessibility-id-parity",
      "EXPECTED_SHARDS=(login-validation accessibility-id-parity",
    ) }), aggregateGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("((${#summaries[@]} == 1))", "true") }), aggregateGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow('node scripts/verify-xcresult-test-results.mjs "${VERIFY_ARGS[@]}" --swift-tests ios/UITests', "true") }), aggregateGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow('if [[ "$WORKER_RESULT" != success ]]; then', "if false; then") }), aggregateGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflowAll('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"', "true") }), aggregateGate);
  });
  it("rejects raw artifact session material and cleanup proof regression", () => {
    const artifactGate = "scan-clean derived diagnostics";
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(`id: artifact-scan
        if: always()`, "id: artifact-scan") }), artifactGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow('install -d -m 700 "$D" "$D/auth" "$D/raw-xcresults" "$D/artifacts"', 'install -d -m 700 "$D"') }), artifactGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(': > "$SESSION_MINTED_MARKER"', "true") }), artifactGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow('if [[ -e "$SESSION_MINTED_MARKER" ]]; then', "if true; then") }), artifactGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("raw-session scan source exists without its session-minted marker", "unmarked raw-session source accepted") }), artifactGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("[[ -s \"$SECRETS_FILE\" ]] ||", "true ||") }), artifactGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflowAll("test artifact contains raw session material", "ignored") }), artifactGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow('result="$RAW_RESULTS/$shard_name.xcresult"', 'result="$ARTIFACTS/$shard_name.xcresult"') }), artifactGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("raw xcresult bundle entered upload tree", "raw xcresult bundle allowed") }), artifactGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("symlink entered upload tree", "symlink allowed") }), artifactGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("steps.artifact-scan.outcome == 'success'", "true") }), "upload before final");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflowAll("backend PID identity changed; refusing cross-process cleanup", "backend cleanup ignored identity") }), "identity-aware backend");
  });
  it("rejects fail-open support and accessibility parity drift", () => {
    const fieldCase = validFiles["ios/UITests/Support/FieldUITestCase.swift"];
    const auditTests = validFiles["ios/UITests/AccessibilityAuditUITests.swift"];
    const runtimeTests = validFiles["ios/UITests/DynamicTypeRuntimeUITests.swift"];
    const strictGate = "strict accessibility auditing";
    const presentationGate = "precondition supported Simulator appearance";
    expectsFailure(evaluate({ "ios/UITests/Support/FieldUITestCase.swift": "throw XCTSkip()" }), "must not include skip-testing");
    expectsFailure(evaluate({ "ios/UITests/Support/FieldUITestCase.swift": mutateFile(fieldCase, "continueAfterFailure = true", "") }), strictGate);
    expectsFailure(evaluate({ "ios/UITests/Support/FieldUITestCase.swift": mutateFile(fieldCase, "issue.auditType == .dynamicType", "issue.auditType != .dynamicType") }), strictGate);
    expectsFailure(evaluate({ "ios/UITests/Support/FieldUITestCase.swift": mutateFile(fieldCase, "Dynamic Type font sizes are partially unsupported", "unexpected diagnostic") }), strictGate);
    expectsFailure(evaluate({ "ios/UITests/Support/FieldUITestCase.swift": mutateFile(fieldCase, "User will not be able to change the font size of this SwiftUI.AccessibilityNode", "unexpected detailed diagnostic") }), strictGate);
    expectsFailure(evaluate({ "ios/UITests/Support/FieldUITestCase.swift": mutateFile(fieldCase, "issue.auditType == .dynamicType,", "issue.auditType != .dynamicType,") }), strictGate);
    expectsFailure(evaluate({ "ios/UITests/Support/FieldUITestCase.swift": mutateFile(fieldCase, `XCTAssertEqual(
            observed.sorted(),
            expectedCompatibilityIssues.sorted(),`, "true") }), strictGate);
    expectsFailure(evaluate({ "ios/UITests/Support/FieldUITestCase.swift": mutateFile(fieldCase, "try app.performAccessibilityAudit(for: .all.subtracting(.dynamicType))", "try app.performAccessibilityAudit(for: .all)") }), strictGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow('xcrun simctl ui "$UUID" appearance "$expected_appearance"', "true") }), presentationGate);
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow('actual_content_size="$(xcrun simctl ui "$UUID" content_size)"', 'actual_content_size="$expected_content_size"') }), presentationGate);
    expectsFailure(evaluate({ "ios/UITests/Support/FieldUITestCase.swift": `${fieldCase}
app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryL"]` }), presentationGate);
    expectsFailure(evaluate({ "ios/UITests/Support/FieldUITestCase.swift": `${fieldCase}
XCUIDevice.shared.appearance = .dark` }), presentationGate);
    expectsFailure(evaluate({ "ios/UITests/AccessibilityAuditUITests.swift": mutateFile(auditTests, "testTodayScreenPassesDynamicTypeAudit", "testTodayScreenPassesNonDynamicAuditStandard") }), presentationGate);
    expectsFailure(evaluate({ "ios/UITests/AccessibilityAuditUITests.swift": mutateFile(auditTests, "AID.locationConsentGrantButton", "AID.todayRefreshButton") }), strictGate);
    expectsFailure(evaluate({ "ios/UITests/DynamicTypeRuntimeUITests.swift": mutateFile(runtimeTests, "sameHorizontalBand(body.frame, timestamp.frame)", "body.frame.intersects(timestamp.frame)") }), presentationGate);
    expectsFailure(evaluate({ "ios/UITests/DynamicTypeRuntimeUITests.swift": mutateFile(runtimeTests, "XCTAssertGreaterThan(timestamp.frame.minY, body.frame.maxY", "XCTAssertLessThan(timestamp.frame.minY, body.frame.maxY") }), presentationGate);
    expectsFailure(evaluate({ "ios/UITests/DynamicTypeRuntimeUITests.swift": mutateFile(runtimeTests, "XCTAssertGreaterThanOrEqual(app.buttons[AID.locationConsentGrantButton].frame.height, 44)", "XCTAssertGreaterThanOrEqual(app.buttons[AID.locationConsentGrantButton].frame.height, 1)") }), presentationGate);
    expectsFailure(evaluate({ "ios/Sources/MaintenanceFieldApp/FieldAccessibilityID.swift": `public enum FieldAccessibilityID { public static let onlyProduction = "x" }` }), "mirror every FieldAccessibilityID");
    const fieldViews = validFiles["ios/Sources/MaintenanceFieldApp/FieldViews.swift"];
    expectsFailure(evaluate({ "ios/Sources/MaintenanceFieldApp/FieldViews.swift": mutateFile(fieldViews, "if dynamicTypeSize.isAccessibilitySize == false", "if dynamicTypeSize.isAccessibilitySize") }), "Today must retain inline location consent outside accessibility Dynamic Type");
    expectsFailure(evaluate({ "ios/Sources/MaintenanceFieldApp/FieldViews.swift": mutateFile(fieldViews, "FieldAccessibilityID.todayLocationConsentButton", "FieldAccessibilityID.todayRefreshButton") }), "Today must retain inline location consent outside accessibility Dynamic Type");
    expectsFailure(evaluate({ "ios/Sources/MaintenanceFieldApp/FieldViews.swift": `${fieldViews}
Text("fixed").font(.system(size: 17))` }), presentationGate);
  });
  it("rejects a tab whose NavigationStack is not wrapped by the unobscured content host", () => {
    const fieldViews = validFiles["ios/Sources/MaintenanceFieldApp/FieldViews.swift"];
    expectsFailure(evaluate({ "ios/Sources/MaintenanceFieldApp/FieldViews.swift": mutateFile(fieldViews, `UnobscuredTabContent {
                NavigationStack {`, "NavigationStack {") }), "public content-layout-guide sensor/probe");
  });
  it("rejects tab content without formal UIHostingController containment", () => {
    const fieldViews = validFiles["ios/Sources/MaintenanceFieldApp/FieldViews.swift"];
    expectsFailure(evaluate({ "ios/Sources/MaintenanceFieldApp/FieldViews.swift": mutateFile(fieldViews, "UIViewControllerRepresentable", "UIViewRepresentable") }), "public content-layout-guide sensor/probe");
    expectsFailure(evaluate({ "ios/Sources/MaintenanceFieldApp/FieldViews.swift": `${fieldViews}
let forbiddenHost = UIHostingController(rootView: EmptyView())` }), "public content-layout-guide sensor/probe");
  });
  it("rejects a tab host without guide constraints, fallback, lifecycle rebind, or dismantle", () => {
    const fieldViews = validFiles["ios/Sources/MaintenanceFieldApp/FieldViews.swift"];
    const guideGate = "public content-layout-guide sensor/probe";
    expectsFailure(evaluate({ "ios/Sources/MaintenanceFieldApp/FieldViews.swift": mutateFile(fieldViews, "equalTo: tabBarController.contentLayoutGuide.bottomAnchor", "equalTo: tabBarController.view.bottomAnchor") }), guideGate);
    expectsFailure(evaluate({ "ios/Sources/MaintenanceFieldApp/FieldViews.swift": mutateFile(fieldViews, "await Task.yield()", "// yield removed") }), guideGate);
    expectsFailure(evaluate({ "ios/Sources/MaintenanceFieldApp/FieldViews.swift": mutateFile(fieldViews, "guard pendingMeasurementTask == nil else { return }", "// coalescing removed") }), guideGate);
    expectsFailure(evaluate({ "ios/Sources/MaintenanceFieldApp/FieldViews.swift": mutateFile(fieldViews, "tabBarController.view.window === window", "true") }), guideGate);
    expectsFailure(evaluate({ "ios/Sources/MaintenanceFieldApp/FieldViews.swift": mutateFile(fieldViews, "sensorSuperview.convert(sensor.frame, to: view)", "sensor.frame") }), guideGate);
    expectsFailure(evaluate({ "ios/Sources/MaintenanceFieldApp/FieldViews.swift": mutateFile(fieldViews, "layoutDirection == .rightToLeft ? right : left", "left") }), guideGate);
    expectsFailure(evaluate({ "ios/Sources/MaintenanceFieldApp/FieldViews.swift": mutateFile(fieldViews, "geometry.size.height - contentInsets.top - contentInsets.bottom", "geometry.size.height") }), guideGate);
    expectsFailure(evaluate({ "ios/Sources/MaintenanceFieldApp/FieldViews.swift": mutateFile(fieldViews, ".offset(x: contentInsets.leading, y: contentInsets.top)", ".offset(x: 0, y: 0)") }), guideGate);
    expectsFailure(evaluate({ "ios/Sources/MaintenanceFieldApp/FieldViews.swift": mutateFile(fieldViews, `if parent == nil {
            invalidate()`, `if parent == nil {
            requestMeasurement()`) }), guideGate);
    expectsFailure(evaluate({ "ios/Sources/MaintenanceFieldApp/FieldViews.swift": mutateFile(fieldViews, `removeContentLayoutSensor()
        onInsetsChange = nil`, "onInsetsChange = nil") }), guideGate);
  });
  it("rejects private tab hierarchy workarounds and fixed bottom clearance", () => {
    const fieldViews = validFiles["ios/Sources/MaintenanceFieldApp/FieldViews.swift"];
    for (const forbidden of [
      "tabBarController.selectedViewController = self",
      "let privateHierarchy = view.subviews",
      "view.setNeedsLayout()",
      "view.safeAreaInset(edge: .bottom) { EmptyView() }",
      "view.frame = CGRect(x: 0, y: 0, width: 1, height: 84)",
      "view.traitOverrides.horizontalSizeClass = .compact",
    ]) {
      expectsFailure(evaluate({ "ios/Sources/MaintenanceFieldApp/FieldViews.swift": `${fieldViews}
${forbidden}` }), "public content-layout-guide sensor/probe");
    }
  });
  it("rejects accessibility audit issue handlers", () => {
    expectsFailure(evaluate({
      "ios/UITests/AccessibilityAuditUITests.swift": `${validFiles["ios/UITests/AccessibilityAuditUITests.swift"]}\nlet issueHandler = { _ in }`,
    }), "strict accessibility auditing");
  });
  it("rejects a messenger messages section without a semantic scalable header", () => {
    const fieldViews = validFiles["ios/Sources/MaintenanceFieldApp/FieldViews.swift"];
    expectsFailure(evaluate({
      "ios/Sources/MaintenanceFieldApp/FieldViews.swift": mutateFile(fieldViews, ".accessibilityAddTraits(.isHeader)", ""),
    }), "scalable semantic header");
  });
  it("rejects translucent or implicit-foreground status capsules", () => {
    const fieldViews = validFiles["ios/Sources/MaintenanceFieldApp/FieldViews.swift"];
    const contrastGate = "contrast-stable adaptive backgrounds";
    expectsFailure(evaluate({
      "ios/Sources/MaintenanceFieldApp/FieldViews.swift": mutateFile(
        fieldViews,
        ".background(Color.primary.opacity(0.12), in: Capsule())",
        ".background(.thinMaterial, in: Capsule())",
      ),
    }), contrastGate);
    expectsFailure(evaluate({
      "ios/Sources/MaintenanceFieldApp/FieldViews.swift": mutateFile(
        fieldViews,
        `.font(.caption)
                    .foregroundStyle(.primary)
                    .padding(.horizontal, 8)`,
        `.font(.caption)
                    .padding(.horizontal, 8)`,
      ),
    }), contrastGate);
  });
  it("rejects a preflight that proves only an authenticated shell", () => {
    const fieldCase = validFiles["ios/UITests/Support/FieldUITestCase.swift"];
    expectsFailure(evaluate({
      "ios/UITests/PreflightUITests.swift": validFiles["ios/UITests/PreflightUITests.swift"].replace(
        "scrollToWorkOrderRow(in: restoredApp, id: detailWorkOrderID, timeout: 20) != nil",
        "restoredApp.buttons[AID.workOrderRow(detailWorkOrderID)].exists",
      ),
    }), "decodes and renders the exact deterministic Today work order");
    expectsFailure(evaluate({
      "ios/UITests/Support/FieldUITestCase.swift": fieldCase.replace("dragStart.press(forDuration: 0.1, thenDragTo: dragEnd)", ""),
    }), "decodes and renders the exact deterministic Today work order");
    expectsFailure(evaluate({
      "ios/UITests/Support/FieldUITestCase.swift": fieldCase.replace("let topSentinel = app.staticTexts[KO.locationConsentTitle]", "let topSentinel = app.staticTexts[KO.todayTitle]"),
    }), "decodes and renders the exact deterministic Today work order");
    expectsFailure(evaluate({
      "ios/UITests/Support/FieldUITestCase.swift": mutateFile(
        fieldCase,
        "if workOrderRowActivationPoint(in: app, row: row, list: list) != nil {\n            return row\n        }",
        "if row.waitForExistence(timeout: 0.5), row.isHittable {\n            return row\n        }",
      ),
    }), "decodes and renders the exact deterministic Today work order");
    expectsFailure(evaluate({
      "ios/UITests/Support/FieldUITestCase.swift": mutateFile(
        fieldCase,
        "if tabBar.exists {",
        "if false {",
      ),
    }), "decodes and renders the exact deterministic Today work order");
    expectsFailure(evaluate({
      "ios/UITests/Support/FieldUITestCase.swift": mutateFile(
        fieldCase,
        "let tabChromeTop = tabBar.frame.minY - tabBar.frame.height",
        "let tabChromeTop = tabBar.frame.minY",
      ),
    }), "decodes and renders the exact deterministic Today work order");
    expectsFailure(evaluate({
      "ios/UITests/Support/FieldUITestCase.swift": mutateFile(
        fieldCase,
        "guard viewport.contains(center) else { return nil }",
        "guard viewport.intersects(row.frame) else { return nil }",
      ),
    }), "decodes and renders the exact deterministic Today work order");
    expectsFailure(evaluate({
      "ios/UITests/Support/FieldUITestCase.swift": mutateFile(
        fieldCase,
        "withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)",
        "withNormalizedOffset: CGVector(dx: 0.5, dy: 0.28)",
      ),
    }), "decodes and renders the exact deterministic Today work order");
    expectsFailure(evaluate({
      "ios/UITests/Support/FieldUITestCase.swift": mutateFile(
        fieldCase,
        "timeout: TimeInterval = 60,\n    maxSwipes: Int = 48",
        "timeout: TimeInterval = 30,\n    maxSwipes: Int = 24",
      ),
    }), "decodes and renders the exact deterministic Today work order");
    expectsFailure(evaluate({
      "ios/UITests/Support/FieldUITestCase.swift": fieldCase.replace("back.isHittable", "detail.isHittable"),
    }), "actionable back control");
    expectsFailure(evaluate({
      "ios/UITests/Support/FieldUITestCase.swift": fieldCase.replace(
        "activationPoint.tap()",
        "row.tap()",
      ),
    }), "actionable back control");
    expectsFailure(evaluate({
      "ios/UITests/Support/FieldUITestCase.swift": mutateFile(
        fieldCase,
        "fixtureKey: String,\n        timeout: TimeInterval = 60",
        "fixtureKey: String,\n        timeout: TimeInterval = 30",
      ),
    }), "actionable back control");
  });
  it("rejects full-fixture Today traversal or tab-bar geometry drift", () => {
    const fieldCase = validFiles["ios/UITests/Support/FieldUITestCase.swift"];
    const criticalPath = validFiles["ios/UITests/FieldCriticalPathUITests.swift"];
    const geometryGate = "traverse all five deterministic Today rows";
    expectsFailure(evaluate({
      "ios/UITests/Support/FieldUITestCase.swift": mutateFile(fieldCase, "tabBar.frame.minY + 1", "list.frame.maxY + 1"),
    }), geometryGate);
    expectsFailure(evaluate({
      "ios/UITests/Support/FieldUITestCase.swift": mutateFile(fieldCase, "tabBar.frame.minY - 1", "tabBar.frame.minY - tabBar.frame.height"),
    }), geometryGate);
    expectsFailure(evaluate({
      "ios/UITests/FieldCriticalPathUITests.swift": mutateFile(criticalPath, "UITestFixture.reportSuccessWorkOrderID", "UITestFixture.reportWorkOrderID"),
    }), geometryGate);
    expectsFailure(evaluate({
      "ios/UITests/FieldCriticalPathUITests.swift": mutateFile(criticalPath, "UITestFixture.adminRejectWorkOrderID", "UITestFixture.adminApproveWorkOrderID"),
    }), geometryGate);
    expectsFailure(evaluate({
      "ios/UITests/FieldCriticalPathUITests.swift": mutateFile(criticalPath, "workOrderRowActivationPoint(in: app, row: row, list: list)", "row.isHittable"),
    }), geometryGate);
    expectsFailure(evaluate({
      "ios/UITests/Support/FieldUITestCase.swift": `${fieldCase}\nprint("TODAY_DIAGNOSTIC")`,
    }), geometryGate);
  });
  it("rejects lazy detail scrolling that can time out early or target the wrong surface", () => {
    const lazyScroll = "deadline-bounded exact-element scroll";
    const fieldCase = validFiles["ios/UITests/Support/FieldUITestCase.swift"];
    const fieldViews = validFiles["ios/Sources/MaintenanceFieldApp/FieldViews.swift"];
    const auditTests = validFiles["ios/UITests/AccessibilityAuditUITests.swift"];
    const messengerTests = validFiles["ios/UITests/MessengerUITests.swift"];
    expectsFailure(evaluate({
      "ios/UITests/Support/FieldUITestCase.swift": fieldCase.replaceAll("let deadline = Date().addingTimeInterval(timeout)", "let deadline = Date()"),
    }), lazyScroll);
    expectsFailure(evaluate({
      "ios/UITests/Support/FieldUITestCase.swift": fieldCase.replace("guard container.waitForExistence", "guard element.waitForExistence"),
    }), lazyScroll);
    expectsFailure(evaluate({
      "ios/UITests/Support/FieldUITestCase.swift": fieldCase.replace("container.swipeDown()", "container.swipeUp()"),
    }), lazyScroll);
    expectsFailure(evaluate({
      "ios/UITests/Support/FieldUITestCase.swift": fieldCase.replaceAll("dragStart.press(forDuration: 0.1, thenDragTo: dragEnd)", "container.swipeUp()"),
    }), lazyScroll);
    expectsFailure(evaluate({
      "ios/UITests/Support/FieldUITestCase.swift": fieldCase.replace(
        "let origin = container.coordinate(withNormalizedOffset: .zero)",
        "let origin = container.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))",
      ),
    }), lazyScroll);
    expectsFailure(evaluate({
      "ios/UITests/Support/FieldUITestCase.swift": fieldCase.replace(
        "CGVector(dx: trailingGutterX, dy: container.frame.height * 0.50)",
        "CGVector(dx: container.frame.width * 0.5, dy: container.frame.height * 0.50)",
      ),
    }), lazyScroll);
    expectsFailure(evaluate({
      "ios/UITests/Support/FieldUITestCase.swift": fieldCase.replace(
        "let trailingGutterX = max(container.frame.width * 0.9, 8)",
        "let trailingGutterX = max(container.frame.width - 8, 8)",
      ),
    }), lazyScroll);
    expectsFailure(evaluate({
      "ios/UITests/Support/FieldUITestCase.swift": fieldCase.replace(
        "let trailingGutterX = max(container.frame.width * 0.9, 8)",
        "let trailingGutterX = 8",
      ),
    }), lazyScroll);
    expectsFailure(evaluate({
      "ios/UITests/AccessibilityAuditUITests.swift": mutateFile(
        auditTests,
        "let trailingGutterX = max(container.frame.width * 0.9, 8)",
        "let trailingGutterX = max(container.frame.width - 8, 8)",
      ),
    }), lazyScroll);
    expectsFailure(evaluate({
      "ios/UITests/MessengerUITests.swift": mutateFile(
        messengerTests,
        "let trailingGutterX = max(list.frame.width * 0.9, 8)",
        "let trailingGutterX = max(list.frame.width - 8, 8)",
      ),
    }), lazyScroll);
    expectsFailure(evaluate({
      "ios/UITests/Support/FieldUITestCase.swift": mutateFile(
        fieldCase,
        "if element.exists, element.isHittable {\n            return element\n        }",
        "if element.waitForExistence(timeout: 0.5), element.isHittable {\n            return element\n        }",
      ),
    }), lazyScroll);
    expectsFailure(evaluate({
      "ios/Sources/MaintenanceFieldApp/FieldViews.swift": mutateFile(fieldViews, ".scrollDismissesKeyboard(.immediately)", ""),
    }), lazyScroll);
    expectsFailure(evaluate({
      "ios/UITests/Support/FieldUITestCase.swift": mutateFile(
        fieldCase,
        "in: app.descendants(matching: .any)[AID.detailView]",
        "in: app.collectionViews[AID.detailView]",
      ),
    }), lazyScroll);
    expectsFailure(evaluate({
      "ios/UITests/Support/FieldUITestCase.swift": fieldCase.replace(
        "topSentinel: app.buttons[AID.detailBackButton]",
        "topSentinel: app.staticTexts[KO.locationConsentTitle]",
      ),
    }), lazyScroll);
    expectsFailure(evaluate({
      "ios/UITests/FieldCriticalPathUITests.swift": validFiles["ios/UITests/FieldCriticalPathUITests.swift"].replace("scrollToDetailElement(app.buttons[AID.detailStartWorkButton])", "app.buttons[AID.detailStartWorkButton]"),
    }), lazyScroll);
    expectsFailure(evaluate({
      "ios/UITests/FieldCriticalPathUITests.swift": validFiles["ios/UITests/FieldCriticalPathUITests.swift"].replace("scrollToDetailElement(app.buttons[AID.detailSubmitReportButton])", "app.buttons[AID.detailSubmitReportButton]"),
    }), lazyScroll);
    expectsFailure(evaluate({
      "ios/UITests/CameraCaptureUITests.swift": validFiles["ios/UITests/CameraCaptureUITests.swift"].replace("scrollToDetailElement(app.buttons[AID.detailCaptureEvidenceButton])", "app.buttons[AID.detailCaptureEvidenceButton]"),
    }), lazyScroll);
  });
  it("rejects messenger rows that share a cross-section message identifier", () => {
    expectsFailure(evaluate({ "ios/Sources/MaintenanceFieldApp/FieldViews.swift": validFiles["ios/Sources/MaintenanceFieldApp/FieldViews.swift"].replace("messengerSearchResultRow", "messengerMessageRow") }), "section-scoped dynamic accessibility IDs");
    expectsFailure(evaluate({ "ios/Sources/MaintenanceFieldApp/FieldViews.swift": validFiles["ios/Sources/MaintenanceFieldApp/FieldViews.swift"].replace("messengerMessageRow", "messengerSearchResultRow") }), "section-scoped dynamic accessibility IDs");
  });
  it("rejects camera authorization state that cannot refresh after returning from Settings", () => {
    expectsFailure(evaluate({
      "ios/Sources/MaintenanceFieldApp/CameraCaptureView.swift": mutateFile(
        validFiles["ios/Sources/MaintenanceFieldApp/CameraCaptureView.swift"],
        "@Environment(\\.scenePhase) private var scenePhase",
        "",
      ),
    }), "refresh authorization when the app becomes active");
  });

  it("rejects local-state-only critical-path evidence", () => {
    expectsFailure(evaluate({ "ios/UITests/FieldCriticalPathUITests.swift": validFiles["ios/UITests/FieldCriticalPathUITests.swift"].replace("AID.detailStatus", "KO.inProgress") }), "scoped mutations");
    expectsFailure(evaluate({ "ios/UITests/FieldCriticalPathUITests.swift": validFiles["ios/UITests/FieldCriticalPathUITests.swift"].replaceAll("app.terminate()", "") }), "scoped mutations");
    expectsFailure(evaluate({ "ios/UITests/MessengerUITests.swift": validFiles["ios/UITests/MessengerUITests.swift"].replace("app.terminate()", "") }), "scoped mutations");
    expectsFailure(evaluate({ "ios/UITests/CameraCaptureUITests.swift": "if previewIsUsable { return }\ncancel.tap()" }), "scoped mutations");
    expectsFailure(evaluate({ "ios/UITests/LoginValidationUITests.swift": "XCTAssertTrue(loginError.exists)" }), "scoped mutations");
  });
});
