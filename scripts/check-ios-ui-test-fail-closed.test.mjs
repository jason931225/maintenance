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
  "ios/Sources/MaintenanceFieldApp/Info.plist": "<plist><dict><key>CFBundleIdentifier</key></dict></plist>",
  "ios/Sources/MaintenanceFieldCore/PersistenceStores.swift": readFileSync(new URL("../ios/Sources/MaintenanceFieldCore/PersistenceStores.swift", import.meta.url), "utf8"),
  "ios/Sources/MaintenanceFieldApp/FieldAccessibilityID.swift": `public enum FieldAccessibilityID { public static let staticID = "static.id"; public static func dynamicID(_ id: String) -> String { "dynamic.\\(id)" } }`,
  "ios/Sources/MaintenanceFieldApp/FieldViews.swift": `ForEach(viewModel.messengerState.searchResults) { message in FieldAccessibilityID.messengerSearchResultRow(message.id) }\nForEach(messages) { message in FieldAccessibilityID.messengerMessageRow(message.id) }`,
  "ios/UITests/Support/FieldUITestCase.swift": `enum AID { static let staticID = "static.id"; static func dynamicID(_ id: String) -> String { "dynamic.\\(id)" } }\nstatic func requiredID(_ key: String) throws -> String { guard let value = ProcessInfo.processInfo.environment[key], UUID(uuidString: value) != nil else { throw Error.missing(key) }; return value }\ntry app.performAccessibilityAudit(for: .all)`,
  "ios/UITests/Support/RealSessionSeed.swift": readFileSync(new URL("../ios/UITests/Support/RealSessionSeed.swift", import.meta.url), "utf8"),
  "ios/Sources/MaintenanceFieldUITestSeeder/UITestSeederApp.swift": readFileSync(new URL("../ios/Sources/MaintenanceFieldUITestSeeder/UITestSeederApp.swift", import.meta.url), "utf8"),
  "ios/Config/App.xcconfig": readFileSync(new URL("../ios/Config/App.xcconfig", import.meta.url), "utf8"),
  "ios/Config/MaintenanceFieldApp.entitlements": readFileSync(new URL("../ios/Config/MaintenanceFieldApp.entitlements", import.meta.url), "utf8"),
  "ios/Config/MaintenanceFieldUITestSeeder.entitlements": readFileSync(new URL("../ios/Config/MaintenanceFieldUITestSeeder.entitlements", import.meta.url), "utf8"),
  "ios/project.yml": readFileSync(new URL("../ios/project.yml", import.meta.url), "utf8"),
  "ios/UITests/FieldCriticalPathUITests.swift": `startWork.tap()\nlet detailStatus = app.descendants(matching: .any)[AID.detailStatus]\nXCTAssertEqual(detailStatus.label, KO.inProgress)\ngrant.tap()\napp.terminate()\n// A fresh app launch must read the granted state back\nreloadedWithdraw.tap()\napp.terminate()\n// A fresh app launch must read the withdrawn terminal state back`,
  "ios/UITests/MessengerUITests.swift": `app.buttons[AID.messengerSendButton].tap()\napp.terminate()\ntry await openSeededThread()\nXCTAssertTrue(app.staticTexts[sentMessageBody].exists)`,
  "ios/UITests/CameraCaptureUITests.swift": `if previewIsUsable { reachedTerminalState = true }\ncancel.tap()`,
  "ios/UITests/LoginValidationUITests.swift": `XCTAssertEqual(loginError.label, KO.errorInvalidUserID)`,
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

describe("iOS hermetic UI CI contract", () => {
  it("accepts the hosted, sharded hermetic workflow", () => assert.deepEqual(evaluate().failures, []));
  it("rejects public self-hosted or configurable runner exposure", () => {
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("runs-on: macos-15", "runs-on: ${{ vars.MNT_IOS_CI_RUNNER }}") }), "untrusted PR code");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("runs-on: macos-15", "runs-on: [self-hosted, macos]") }), "untrusted PR code");
  });
  it("rejects toolchain and job-root drift", () => {
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("Build version 16F6", "Build version drift") }), "pin Xcode 16.4");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("iOS-18-5", "iOS-18-4") }), "pin Xcode 16.4");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflowAll("SimDeviceType.iPhone-16", "SimDeviceType.iPhone-15") }), "pin Xcode 16.4");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("CARGO_TARGET_DIR=$D/cargo-target", "CARGO_TARGET_DIR=/tmp/cargo") }), "pin Xcode 16.4");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(
      "      DEVELOPER_DIR: /Applications/Xcode_16.4.app/Contents/Developer",
      "      DEVELOPER_DIR: /Applications/Xcode_16.4.app/Contents/Developer\n      RUNNER_TOOL_CACHE: ${{ github.workspace }}/shadow-cache",
    ) }), "bind Node");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow(
      '        env: {CARGO_INCREMENTAL: "0", SQLX_OFFLINE: "true"}',
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
        '        env: {CARGO_INCREMENTAL: "0", SQLX_OFFLINE: "true"}',
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
  it("rejects mutable XcodeGen and unsafe PGDATA", () => {
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("4d9e34b62172d645eed6457cac13fc222569974098ef4ee9c3368bedf0196806", "dynamic") }), "checksum-pinned XcodeGen");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow('install -d -m 700 "$D" "$AUTH_DIR" "$PGDATA" "$ARTIFACTS"', 'mkdir -p /tmp/pg') }), "mode-0700 job-root PGDATA");
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
  it("rejects missing per-shard session controls and fixtures", () => {
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow('for test_class in "\${TEST_CLASSES[@]}"; do mint_class_session', 'for test_class in "\${TEST_CLASSES[@]}"; do true') }), "mint and mask");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("sleep 720", "sleep 900") }), "mint and mask");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("00000000-0000-0000-0000-000000c20001", "c20001") }), "mint and mask");
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
        "            kSecAttrAccount as String: uniqueProbeAccount,",
        "            kSecAttrAccount as String: uniqueProbeAccount,\n            kSecAttrAccessGroup as String: suffix,",
      ),
    }), "system-granted default group");
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
  it("rejects xctestrun, ATS, and xcresult regression", () => {
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow('chmod 600 "$XCTESTRUN"', "") }), "mode-0600");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow('CI_PLIST="$D/Info.ci.plist"', 'CI_PLIST="$RUNNER_TEMP/Info.plist"') }), "CI-only job-root");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow('VERIFY_ARGS+=(--summary "$summary" --tests "$tests")', "") }), "aggregate repeated");
  });
  it("rejects raw artifact session material and cleanup proof regression", () => {
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("id: artifact-scan\n        if: always()", "id: artifact-scan") }), "raw OTP");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("[[ -s \"$SECRETS_FILE\" ]] ||", "true ||") }), "raw OTP");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflowAll("test artifact contains raw session material", "ignored") }), "raw OTP");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("- name: Scan result artifacts for raw session material", "- name: Upload test results\n        if: always() && steps.artifact-scan.outcome == 'success'\n        uses: actions/upload-artifact@pinned\n      - name: Scan result artifacts for raw session material") }), "upload before final");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("steps.artifact-scan.outcome == 'success'", "true") }), "upload before final");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("actions/upload-artifact", "actions/not-upload-artifact") }), "upload before final");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflow("${{ runner.temp }}/ios-ui-${{ github.run_id }}-${{ github.run_attempt }}/artifacts", "${{ env.MNT_IOS_JOB_ROOT }}/artifacts") }), "upload before final");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": mutateWorkflowAll("backend PID identity changed; refusing cross-process cleanup", "backend cleanup ignored identity") }), "identity-aware backend");
  });
  it("rejects fail-open support and accessibility parity drift", () => {
    expectsFailure(evaluate({ "ios/UITests/Support/FieldUITestCase.swift": "throw XCTSkip()" }), "must not include skip-testing");
    expectsFailure(evaluate({ "ios/Sources/MaintenanceFieldApp/FieldAccessibilityID.swift": `public enum FieldAccessibilityID { public static let onlyProduction = "x" }` }), "mirror every FieldAccessibilityID");
  });
  it("rejects messenger rows that share a cross-section message identifier", () => {
    expectsFailure(evaluate({ "ios/Sources/MaintenanceFieldApp/FieldViews.swift": validFiles["ios/Sources/MaintenanceFieldApp/FieldViews.swift"].replace("messengerSearchResultRow", "messengerMessageRow") }), "section-scoped dynamic accessibility IDs");
    expectsFailure(evaluate({ "ios/Sources/MaintenanceFieldApp/FieldViews.swift": validFiles["ios/Sources/MaintenanceFieldApp/FieldViews.swift"].replace("messengerMessageRow", "messengerSearchResultRow") }), "section-scoped dynamic accessibility IDs");
  });
  it("rejects local-state-only critical-path evidence", () => {
    expectsFailure(evaluate({ "ios/UITests/FieldCriticalPathUITests.swift": validFiles["ios/UITests/FieldCriticalPathUITests.swift"].replace("AID.detailStatus", "KO.inProgress") }), "scoped mutations");
    expectsFailure(evaluate({ "ios/UITests/FieldCriticalPathUITests.swift": validFiles["ios/UITests/FieldCriticalPathUITests.swift"].replaceAll("app.terminate()", "") }), "scoped mutations");
    expectsFailure(evaluate({ "ios/UITests/MessengerUITests.swift": validFiles["ios/UITests/MessengerUITests.swift"].replace("app.terminate()", "") }), "scoped mutations");
    expectsFailure(evaluate({ "ios/UITests/CameraCaptureUITests.swift": "if previewIsUsable { return }\ncancel.tap()" }), "scoped mutations");
    expectsFailure(evaluate({ "ios/UITests/LoginValidationUITests.swift": "XCTAssertTrue(loginError.exists)" }), "scoped mutations");
  });
});
