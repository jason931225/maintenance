import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateIosUiTestFailClosedChecks } from "./check-ios-ui-test-fail-closed.mjs";

const candidateBuild = "car" + "go build --locked --release -p mnt-app";
const validWorkflow = `jobs:
  ios-ui-tests:
    runs-on: macos-15
    env:
      DEVELOPER_DIR: /Applications/Xcode_16.4.app/Contents/Developer
    steps:
      - run: |
          D="$RUNNER_TEMP/ios-ui"; printf '%s\\n' "MNT_IOS_JOB_ROOT=$D" "CARGO_HOME=$D/cargo-home" "RUSTUP_HOME=$D/rustup-home" "CARGO_TARGET_DIR=$D/cargo-target" >> "$GITHUB_ENV"
      - run: |
          test "$(xcodebuild -version)" = $'Xcode 16.4\\nBuild version 16F6'
          TOOLS="$MNT_IOS_JOB_ROOT/tools"; ZIP="$TOOLS/xcodegen.zip"; DIST="$TOOLS/xcodegen-dist"
          curl --output "$ZIP" https://github.com/yonaskolb/XcodeGen/releases/download/2.46.0/xcodegen.zip
          printf '%s  %s\\n' 4d9e34b62172d645eed6457cac13fc222569974098ef4ee9c3368bedf0196806 "$ZIP" | shasum -a 256 --check -
          ditto -x -k "$ZIP" "$DIST"; XCODEGEN_BIN="$DIST/xcodegen/bin/xcodegen"
          test -d "$DIST/xcodegen/share/xcodegen/SettingPresets"; test "$("$XCODEGEN_BIN" --version)" = 'Version: 2.46.0'
          printf '%s\\n' "$DIST/xcodegen/bin" >> "$GITHUB_PATH"
      - run: |
          D="$MNT_IOS_JOB_ROOT"; PGDATA="$D/postgres-data"; PG_PREFIX="$D/postgres"; DERIVED="$D/derived-data"; CI_PLIST="$D/Info.ci.plist"; CI_PROJECT_SPEC="$D/project.ci.yml"; ARTIFACTS="$D/artifacts"; AUTH_DIR="$D/auth"; BACKEND_PID_FILE="$AUTH_DIR/backend.pid"; BACKEND_COMMAND_FILE="$AUTH_DIR/backend.command"; UUID=abc
          install -d -m 700 "$D" "$PGDATA" "$ARTIFACTS" "$AUTH_DIR"
          test "$(git rev-parse HEAD)" = "$GITHUB_SHA"
          curl -fsSLO https://ftp.postgresql.org/pub/source/v18.4/postgresql-18.4.tar.bz2
          echo "81a81ec695fb0c7901407defaa1d2f7973617154cf27ba74e3a7ab8e64436094 postgresql-18.4.tar.bz2" | shasum -a 256 -c -
          OPENSSL_PREFIX="$(brew --prefix openssl@3)"; test -d "$OPENSSL_PREFIX/include"; test -d "$OPENSSL_PREFIX/lib"; export CPPFLAGS="-I$OPENSSL_PREFIX/include" LDFLAGS="-L$OPENSSL_PREFIX/lib" PKG_CONFIG_PATH="$OPENSSL_PREFIX/lib/pkgconfig"
          tar -xjf postgresql-18.4.tar.bz2 && ./configure --prefix="$PG_PREFIX" --with-ssl=openssl && make -j2 && make install && make -C contrib/pgcrypto -j2 && make -C contrib/pgcrypto install && make -C contrib/pg_trgm -j2 && make -C contrib/pg_trgm install
          port() { python3 -c "import socket; s=socket.socket(); s.bind(('127.0.0.1', 0)); print(s.getsockname()[1]); s.close()"; }
          PP="$(port)"; BP="$(port)"; while [[ "$PP" == "$BP" ]]; do BP="$(port)"; done
          "$PG_PREFIX/bin/initdb" -D "$PGDATA"; "$PG_PREFIX/bin/pg_ctl" -D "$PGDATA" -w start
          PGPASSWORD="$UP" "$PG_PREFIX/bin/psql" -h 127.0.0.1 -p "$PP" -U "$PG_SUPERUSER" -d postgres -v ON_ERROR_STOP=1 -c 'CREATE EXTENSION pgcrypto;' -c 'CREATE EXTENSION pg_trgm;' -c 'DROP EXTENSION pg_trgm;' -c 'DROP EXTENSION pgcrypto;'
          ${candidateBuild}
          URL="http://127.0.0.1:$BP"; export MNT_UITEST_BASE_URL="$URL"
          SIM_RUNTIME=com.apple.CoreSimulator.SimRuntime.iOS-18-5
          SIM_DEVICE_TYPE=com.apple.CoreSimulator.SimDeviceType.iPhone-16
          xcrun simctl list devicetypes -j | python3 -c 'import json,sys; target=sys.argv[1]; assert any(x.get("identifier") == target for x in json.load(sys.stdin)["devicetypes"])' "$SIM_DEVICE_TYPE"
          XCTESTRUN="$(find "$DERIVED/Build/Products" -name '*.xctestrun' -print -quit)"; chmod 600 "$XCTESTRUN"
          cp Sources/MaintenanceFieldApp/Info.plist "$CI_PLIST"
          /usr/libexec/PlistBuddy -c 'Add :NSAppTransportSecurity dict' "$CI_PLIST"
          /usr/libexec/PlistBuddy -c 'Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true' "$CI_PLIST"
          python3 - "$CI_PLIST" "$CI_PROJECT_SPEC" <<'PY'
          source = "x"
          needle = "INFOPLIST_FILE: Sources/MaintenanceFieldApp/Info.plist"
          if source.count(needle) != 1: pass
          source.replace(needle, f"INFOPLIST_FILE: {sys.argv[1]}")
          PY
          xcodegen generate --spec "$CI_PROJECT_SPEC"
          BUILT_PLIST="$(find "$DERIVED/Build/Products" -path '*MaintenanceFieldApp.app/Info.plist' -print -quit)"
          /usr/libexec/PlistBuddy -c 'Print :NSAppTransportSecurity:NSAllowsLocalNetworking' "$BUILT_PLIST" # production Info.plist must remain ATS-free
          secret() { openssl rand -hex 32; }
          mint_class_session() { local otp hash; otp="$(secret)"; echo "::add-mask::$otp"; hash="$(printf %s "$otp" | shasum -a 256)"; psql -f seed-mobile-ci.sql; curl --data-binary @- "$URL/api/v1/auth/otp/redeem"; MNT_UITEST_ACCESS_TOKEN=x; MNT_UITEST_REFRESH_TOKEN=y; export MNT_UITEST_ACCESS_TOKEN MNT_UITEST_REFRESH_TOKEN; echo "::add-mask::$MNT_UITEST_ACCESS_TOKEN"; echo "::add-mask::$MNT_UITEST_REFRESH_TOKEN"; python3 scripts/patch-ios-xctestrun.py "$XCTESTRUN" --env MNT_UITEST_ACCESS_TOKEN --env MNT_UITEST_REFRESH_TOKEN; }
          export MNT_UITEST_WORK_ORDER_ID_DETAIL=00000000-0000-0000-0000-000000f00004 MNT_UITEST_WORK_ORDER_ID_START=00000000-0000-0000-0000-000000f00003 MNT_UITEST_WORK_ORDER_ID_REPORT_SUCCESS=00000000-0000-0000-0000-000000f00005 MNT_UITEST_MESSENGER_THREAD_ID=00000000-0000-0000-0000-000000c10001 MNT_UITEST_MESSENGER_INITIAL_MESSAGE_ID=00000000-0000-0000-0000-000000c20001
          TEST_CLASSES=(PreflightUITests AccessibilityAuditUITests); VERIFY_ARGS=()
          for test_class in "\${TEST_CLASSES[@]}"; do mint_class_session; result="$ARTIFACTS/$test_class.xcresult"; (sleep 720; true) & xcodebuild test-without-building -only-testing:"MaintenanceFieldUITests/$test_class" -xctestrun "$XCTESTRUN"; summary="$ARTIFACTS/$test_class-summary.json"; tests="$ARTIFACTS/$test_class-tests.json"; xcrun xcresulttool get test-results summary --path "$result" --format json > "$summary"; xcrun xcresulttool get test-results tests --path "$result" --format json > "$tests"; VERIFY_ARGS+=(--summary "$summary" --tests "$tests"); done
          node scripts/verify-xcresult-test-results.mjs "\${VERIFY_ARGS[@]}" --swift-tests "$ROOT/ios/UITests"
          printf '%s\\n' token > "$AUTH_DIR/artifact-secret-values"; while IFS= read -r secret_value; do grep -R -a -F -q -- "$secret_value" "$ARTIFACTS" && echo 'test artifact contains raw session material'; done < "$AUTH_DIR/artifact-secret-values"
          BACKEND_PID=1; ps -p "$BACKEND_PID" -o command= > "$BACKEND_COMMAND_FILE"; echo 'backend PID identity changed; refusing cross-process cleanup'; kill -TERM "$BACKEND_PID"; kill -0 "$BACKEND_PID"; kill -KILL "$BACKEND_PID"; "$PG_PREFIX/bin/pg_ctl" -D "$PGDATA" -w stop; "$PG_PREFIX/bin/pg_ctl" -D "$PGDATA" status; xcrun simctl delete "$UUID"; xcrun simctl list devices -j; rm -rf "$CI_PLIST" "$CI_PROJECT_SPEC"
      - name: Scan result artifacts for raw session material
        id: artifact-scan
        if: always()
        run: |
          [[ -d "$ARTIFACTS" ]] || exit 0
          if find "$ARTIFACTS" -mindepth 1 -print -quit | grep -q .; then
            [[ -s "$SECRETS_FILE" ]] || { echo 'artifacts exist without the owned raw-session scan source'; exit 1; }
            while IFS= read -r secret_value; do
              [[ -n "$secret_value" ]] || continue
              grep -R -a -F -q -- "$secret_value" "$ARTIFACTS" && echo 'test artifact contains raw session material'
            done < "$SECRETS_FILE"
          fi
      - name: Upload test results
        if: always() && steps.artifact-scan.outcome == 'success'
        uses: actions/upload-artifact@pinned
        with: {path: "\${{ runner.temp }}/ios-ui-\${{ github.run_id }}-\${{ github.run_attempt }}/artifacts"}
      - name: Always prove cleanup of exact owned resources
        if: always()
        run: |
          D="$MNT_IOS_JOB_ROOT"; rm -rf "$D"; [[ ! -e "$D" ]]
`;
const validFiles = {
  ".github/workflows/ios-ui-tests.yml": validWorkflow,
  "ios/Sources/MaintenanceFieldApp/Info.plist": "<plist><dict><key>CFBundleIdentifier</key></dict></plist>",
  "ios/Sources/MaintenanceFieldApp/FieldAccessibilityID.swift": `public enum FieldAccessibilityID { public static let staticID = "static.id"; public static func dynamicID(_ id: String) -> String { "dynamic.\\(id)" } }`,
  "ios/Sources/MaintenanceFieldApp/FieldViews.swift": `ForEach(viewModel.messengerState.searchResults) { message in FieldAccessibilityID.messengerSearchResultRow(message.id) }\nForEach(messages) { message in FieldAccessibilityID.messengerMessageRow(message.id) }`,
  "ios/UITests/Support/FieldUITestCase.swift": `enum AID { static let staticID = "static.id"; static func dynamicID(_ id: String) -> String { "dynamic.\\(id)" } }\nstatic func requiredID(_ key: String) throws -> String { guard let value = ProcessInfo.processInfo.environment[key], UUID(uuidString: value) != nil else { throw Error.missing(key) }; return value }\ntry app.performAccessibilityAudit(for: .all)`,
  "ios/UITests/Support/RealSessionSeed.swift": "enum RealSessionSeed {}",
  "ios/UITests/FieldCriticalPathUITests.swift": `startWork.tap()\nlet detailStatus = app.descendants(matching: .any)[AID.detailStatus]\nXCTAssertEqual(detailStatus.label, KO.inProgress)\ngrant.tap()\napp.terminate()\n// A fresh app launch must read the granted state back\nreloadedWithdraw.tap()\napp.terminate()\n// A fresh app launch must read the withdrawn terminal state back`,
  "ios/UITests/MessengerUITests.swift": `app.buttons[AID.messengerSendButton].tap()\napp.terminate()\ntry await openSeededThread()\nXCTAssertTrue(app.staticTexts[sentMessageBody].exists)`,
  "ios/UITests/CameraCaptureUITests.swift": `if previewIsUsable { reachedTerminalState = true }\ncancel.tap()`,
  "ios/UITests/LoginValidationUITests.swift": `XCTAssertEqual(loginError.label, KO.errorInvalidUserID)`,
};
const evaluate = (overrides = {}) => evaluateIosUiTestFailClosedChecks({ ...validFiles, ...overrides });
const expectsFailure = (result, fragment) => assert.ok(result.failures.some((failure) => failure.includes(fragment)), `Expected ${fragment}: ${result.failures}`);

describe("iOS hermetic UI CI contract", () => {
  it("accepts the hosted, sharded hermetic workflow", () => assert.deepEqual(evaluate().failures, []));
  it("rejects public self-hosted or configurable runner exposure", () => {
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": validWorkflow.replace("runs-on: macos-15", "runs-on: ${{ vars.MNT_IOS_CI_RUNNER }}") }), "untrusted PR code");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": validWorkflow.replace("runs-on: macos-15", "runs-on: [self-hosted, macos]") }), "untrusted PR code");
  });
  it("rejects toolchain and job-root drift", () => {
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": validWorkflow.replace("Build version 16F6", "Build version drift") }), "pin Xcode 16.4");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": validWorkflow.replace("iOS-18-5", "iOS-18-4") }), "pin Xcode 16.4");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": validWorkflow.replaceAll("SimDeviceType.iPhone-16", "SimDeviceType.iPhone-15") }), "pin Xcode 16.4");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": validWorkflow.replace("CARGO_TARGET_DIR=$D/cargo-target", "CARGO_TARGET_DIR=/tmp/cargo") }), "pin Xcode 16.4");
  });
  it("rejects mutable XcodeGen and unsafe PGDATA", () => {
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": validWorkflow.replace("4d9e34b62172d645eed6457cac13fc222569974098ef4ee9c3368bedf0196806", "dynamic") }), "checksum-pinned XcodeGen");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": validWorkflow.replace('install -d -m 700 "$D" "$PGDATA"', 'mkdir -p /tmp/pg') }), "mode-0700 job-root PGDATA");
  });
  it("rejects PostgreSQL builds that omit or cannot load the complete extension set", () => {
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": validWorkflow.replace(" --with-ssl=openssl", "") }), "pgcrypto");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": validWorkflow.replace("--with-ssl=openssl", "--without-ssl # --with-ssl=openssl") }), "pgcrypto");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": validWorkflow.replace(' export CPPFLAGS="-I$OPENSSL_PREFIX/include" LDFLAGS="-L$OPENSSL_PREFIX/lib" PKG_CONFIG_PATH="$OPENSSL_PREFIX/lib/pkgconfig"', "") }), "pgcrypto");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": validWorkflow.replace(" && make -C contrib/pgcrypto -j2", "") }), "pgcrypto");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": validWorkflow.replace(" && make -C contrib/pgcrypto install", "") }), "pgcrypto");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": validWorkflow.replace(" -c 'CREATE EXTENSION pgcrypto;'", "") }), "pgcrypto");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": validWorkflow.replace(" -c 'DROP EXTENSION pgcrypto;'", "") }), "pgcrypto");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": validWorkflow.replace(" && make -C contrib/pg_trgm -j2", "") }), "pg_trgm");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": validWorkflow.replace(" && make -C contrib/pg_trgm install", "") }), "pg_trgm");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": validWorkflow.replace(" -c 'CREATE EXTENSION pg_trgm;'", "") }), "pg_trgm");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": validWorkflow.replace(" -c 'DROP EXTENSION pg_trgm;'", "") }), "pg_trgm");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": validWorkflow.replace(" && make -C contrib/pgcrypto -j2 && make -C contrib/pgcrypto install", " # make -C contrib/pgcrypto -j2 && make -C contrib/pgcrypto install") }), "pgcrypto");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": validWorkflow.replace(" && make -C contrib/pg_trgm -j2 && make -C contrib/pg_trgm install", " # make -C contrib/pg_trgm -j2 && make -C contrib/pg_trgm install") }), "pg_trgm");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": validWorkflow.replace('          PGPASSWORD="$UP"', '          # PGPASSWORD="$UP"') }), "pg_trgm");
    const start = '          "$PG_PREFIX/bin/initdb" -D "$PGDATA"; "$PG_PREFIX/bin/pg_ctl" -D "$PGDATA" -w start';
    const load = '          PGPASSWORD="$UP" "$PG_PREFIX/bin/psql" -h 127.0.0.1 -p "$PP" -U "$PG_SUPERUSER" -d postgres -v ON_ERROR_STOP=1 -c \'CREATE EXTENSION pgcrypto;\' -c \'CREATE EXTENSION pg_trgm;\' -c \'DROP EXTENSION pg_trgm;\' -c \'DROP EXTENSION pgcrypto;\'';
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": validWorkflow.replace(`${start}\n${load}`, `${load}\n${start}`) }), "pg_trgm");
  });
  it("rejects missing per-shard session controls and fixtures", () => {
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": validWorkflow.replace('for test_class in "\${TEST_CLASSES[@]}"; do mint_class_session', 'for test_class in "\${TEST_CLASSES[@]}"; do true') }), "mint and mask");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": validWorkflow.replace("sleep 720", "sleep 900") }), "mint and mask");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": validWorkflow.replace("00000000-0000-0000-0000-000000c20001", "c20001") }), "mint and mask");
  });
  it("rejects xctestrun, ATS, and xcresult regression", () => {
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": validWorkflow.replace('chmod 600 "$XCTESTRUN"', "") }), "mode-0600");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": validWorkflow.replace('CI_PLIST="$D/Info.ci.plist"', 'CI_PLIST="$RUNNER_TEMP/Info.plist"') }), "CI-only job-root");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": validWorkflow.replace('VERIFY_ARGS+=(--summary "$summary" --tests "$tests")', "") }), "aggregate repeated");
  });
  it("rejects raw artifact session material and cleanup proof regression", () => {
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": validWorkflow.replace("id: artifact-scan\n        if: always()", "id: artifact-scan") }), "raw OTP");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": validWorkflow.replace("[[ -s \"$SECRETS_FILE\" ]] ||", "true ||") }), "raw OTP");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": validWorkflow.replaceAll("test artifact contains raw session material", "ignored") }), "raw OTP");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": validWorkflow.replace("- name: Scan result artifacts for raw session material", "- name: Upload test results\n        if: always() && steps.artifact-scan.outcome == 'success'\n        uses: actions/upload-artifact@pinned\n      - name: Scan result artifacts for raw session material") }), "upload before final");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": validWorkflow.replace("steps.artifact-scan.outcome == 'success'", "true") }), "upload before final");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": validWorkflow.replace("actions/upload-artifact", "actions/not-upload-artifact") }), "upload before final");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": validWorkflow.replace("${{ runner.temp }}/ios-ui-${{ github.run_id }}-${{ github.run_attempt }}/artifacts", "${{ env.MNT_IOS_JOB_ROOT }}/artifacts") }), "upload before final");
    expectsFailure(evaluate({ ".github/workflows/ios-ui-tests.yml": validWorkflow.replace('kill -KILL "$BACKEND_PID"', "") }), "identity-aware backend");
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
