import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { evaluateAndroidE2eFailClosedChecks } from "./check-android-e2e-fail-closed.mjs";

const validWorkflow = `name: CI
jobs:
  android-instrumented:
    services:
      postgres:
        image: postgres:18.4
    steps:
      - uses: android-actions/setup-android@pinned
        env:
          ANDROID_HOME: \${{ runner.temp }}/android-sdk
          ANDROID_SDK_ROOT: \${{ runner.temp }}/android-sdk
      - run: |
          test "$(git rev-parse HEAD)" = "$GITHUB_SHA"
          cargo build --locked -p mnt-app
      - run: |
          bootstrap_otp=$(openssl rand -hex 24)
          otp_hash=$(printf '%s' "$bootstrap_otp" | sha256sum | awk '{print $1}')
          bash e2e/harness/db.sh
          psql -v otp_hash="$otp_hash" -f e2e/harness/seed-mobile-ci.sql
          E2E_AUTH_DIR="$RUNNER_TEMP/mobile-auth" bash e2e/harness/boot-backend.sh
          printf '%s' "$bootstrap_otp" | jq -Rsc '{otp:.}' | curl -fsS http://127.0.0.1:8080/api/v1/auth/otp/redeem --data-binary @-
          install -d -m 700 "$RUNNER_TEMP/android-e2e-session-assets"
          printf 'FIELD_E2E_ACCESS_TOKEN=x\\nFIELD_E2E_REFRESH_TOKEN=y\\n' > "$RUNNER_TEMP/android-e2e-session-assets/field-e2e-session.properties"
          chmod 600 "$RUNNER_TEMP/android-e2e-session-assets/field-e2e-session.properties"
      - run: ./gradlew fieldApi34DebugAndroidTest
      - run: |
          test -f android/app/build/test-results/connected/TEST-com.maintenance.field.WorkOrderFlowTest.xml
          grep -q 'WorkOrderFlowTest' android/app/build/test-results/connected/TEST-com.maintenance.field.WorkOrderFlowTest.xml
          if grep -Eq 'skipped|failures="[1-9]|errors="[1-9]' android/app/build/test-results/connected/TEST-com.maintenance.field.WorkOrderFlowTest.xml; then exit 1; fi
      - if: always()
        run: |
          rm -rf "$RUNNER_TEMP/android-e2e-session-assets"
          kill "\${MNT_E2E_BACKEND_PID:-}" || true
  ios-app:
    runs-on: macos-latest
`;

const validFiles = {
  ".github/workflows/ci.yml": validWorkflow,
  "android/app/src/debug/AndroidManifest.xml": '<application android:networkSecurityConfig="@xml/network_security_config" />',
  "android/app/src/debug/res/xml/network_security_config.xml": '<network-security-config><base-config cleartextTrafficPermitted="false"/><domain-config cleartextTrafficPermitted="true"><domain>10.0.2.2</domain></domain-config></network-security-config>',
  "android/app/src/main/AndroidManifest.xml": '<application />',
  "android/app/build.gradle.kts": 'debug { API_BASE_URL = "http://10.0.2.2:8080" } release { API_BASE_URL = "https://api.example.com" }',
  "android/app/src/androidTest/kotlin/com/maintenance/field/WorkOrderFlowTest.kt": `
    val fixture = "Required field-e2e-session.properties fixture is missing or unreadable."
    val id = "00000000-0000-0000-0000-000000f00003"
    apiGateway.listTodayWorkOrders()
    createAndroidComposeRule<MainActivity>()
    onNodeWithText("오늘 작업").assertIsDisplayed()
    onAllNodesWithText("패스키 로그인").assertCountEquals(0)
    waitUntil(timeoutMillis = UI_RENDER_TIMEOUT_MILLIS) {
      onNodeWithText(seededWorkOrder.requestNo).assertIsDisplayed()
    }
    onNodeWithText(seededWorkOrder.requestNo).assertIsDisplayed()
  `,
  "e2e/harness/gen-keys.sh": 'AUTH_DIR="${E2E_AUTH_DIR:-${E2E_DIR}/.auth}"\ninstall -d -m 700 "${AUTH_DIR}"',
  "e2e/harness/boot-backend.sh": 'AUTH_DIR="${E2E_AUTH_DIR:-${E2E_DIR}/.auth}"\nPID_FILE="${AUTH_DIR}/backend.pid"\ninstall -d -m 700 "${AUTH_DIR}"',
  "e2e/run.sh": 'AUTH_DIR="${E2E_AUTH_DIR:-${REPO_ROOT}/e2e/.auth}"\nPID_FILE="${AUTH_DIR}/backend.pid"',
  "e2e/harness/seed-mobile-ci.sql": `
    \\if :{?otp_hash}
    SELECT :'otp_hash' ~ '^[0-9a-f]{64}$';
    INSERT INTO auth_bootstrap_credentials (user_id, token_hash, expires_at)
    VALUES ('00000000-0000-0000-0000-0000000d0002', decode(:'otp_hash', 'hex'), now() + interval '15 minutes');
  `,
};

function evaluate(workflow = validWorkflow, overrides = {}) {
  return evaluateAndroidE2eFailClosedChecks({ ...validFiles, ...overrides, ".github/workflows/ci.yml": workflow });
}

function expectsFailure(result, fragment) {
  assert.ok(result.failures.some((failure) => failure.includes(fragment)), `Expected ${JSON.stringify(fragment)} in ${JSON.stringify(result.failures)}`);
}

describe("Android hermetic E2E CI contract", () => {
  it("accepts a local candidate-SHA PostgreSQL 18.4 Android E2E job", () => {
    assert.deepEqual(evaluate().failures, []);
  });

  it("rejects external backend and refresh-token secret dependencies", () => {
    expectsFailure(evaluate(validWorkflow.replace('services:', 'env:\n      FIELD_E2E_BASE_URL: ${{ secrets.FIELD_E2E_BASE_URL }}\n      FIELD_E2E_SEED_REFRESH_TOKEN: ${{ secrets.FIELD_E2E_SEED_REFRESH_TOKEN }}\n    services:')), "must not depend on external");
  });

  it("rejects a non-18.4 PostgreSQL service", () => {
    expectsFailure(evaluate(validWorkflow.replace('postgres:18.4', 'postgres:17')), "postgres:18.4");
  });

  it("rejects an Android SDK replacement outside runner temp", () => {
    expectsFailure(evaluate(validWorkflow
      .replace('          ANDROID_HOME: ${{ runner.temp }}/android-sdk\n', '')
      .replace('          ANDROID_SDK_ROOT: ${{ runner.temp }}/android-sdk\n', '')), "isolate its replacement Android SDK");
  });

  it("rejects a candidate backend build without exact-SHA verification", () => {
    expectsFailure(evaluate(validWorkflow.replace('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"\n          ', '')), "verify git rev-parse HEAD");
  });

  it("rejects a deterministic or unhashed mobile OTP seed", () => {
    expectsFailure(evaluate(validWorkflow.replace('bootstrap_otp=$(openssl rand -hex 24)\n          ', '').replace("otp_hash=$(printf '%s' \"$bootstrap_otp\" | sha256sum | awk '{print $1}')", 'bootstrap_otp=fixed')), "randomly generated SHA-256-backed");
  });

  it("rejects an OTP redeem body that bypasses the JSON encoder", () => {
    expectsFailure(evaluate(validWorkflow.replace("jq -Rsc '{otp:.}'", "cat")), "JSON-encode the OTP redeem body safely");
  });

  it("rejects credential handoff through GitHub environment files", () => {
    expectsFailure(evaluate(validWorkflow.replace('chmod 600', 'echo "FIELD_E2E_ACCESS_TOKEN=$access_token" >> "$GITHUB_ENV"\n          chmod 600')), "must not leak credentials");
  });

  it("rejects a required test result gate that permits skips", () => {
    expectsFailure(evaluate(validWorkflow.replace("if grep -Eq 'skipped|failures=\"[1-9]|errors=\"[1-9]'", "if grep -Eq 'failures=\"[1-9]|errors=\"[1-9]'")), "missing, skipped, or unsuccessful");
  });

  it("rejects an always cleanup step that does not terminate the backend", () => {
    expectsFailure(evaluate(validWorkflow.replace(
      '          kill "${MNT_E2E_BACKEND_PID:-}" || true',
      '          echo boot-backend',
    )), "always remove the session asset and stop the candidate backend");
  });

  it("rejects release cleartext enablement", () => {
    expectsFailure(evaluate(validWorkflow, {
      "android/app/src/main/AndroidManifest.xml": '<application android:usesCleartextTraffic="true" />',
    }), "cleartext access must be debug-only");
  });

  it("rejects a second debug cleartext destination", () => {
    expectsFailure(evaluate(validWorkflow, {
      "android/app/src/debug/res/xml/network_security_config.xml": '<network-security-config><base-config cleartextTrafficPermitted="false"/><domain-config cleartextTrafficPermitted="true"><domain>10.0.2.2</domain><domain>example.test</domain></domain-config></network-security-config>',
    }), "cleartext access must be debug-only");
  });

  it("rejects harness artifacts that cannot be isolated under runner temp", () => {
    expectsFailure(evaluate(validWorkflow, {
      "e2e/harness/boot-backend.sh": 'AUTH_DIR="${E2E_DIR}/.auth"\nPID_FILE="${AUTH_DIR}/backend.pid"',
    }), "E2E_AUTH_DIR seam");
  });

  it("rejects a mobile seed that embeds a plaintext or deterministic OTP", () => {
    expectsFailure(evaluate(validWorkflow, {
      "e2e/harness/seed-mobile-ci.sql": "bootstrap_otp = 'fixed-mobile-otp'",
    }), "caller-supplied SHA-256 mechanic OTP hash");
  });

  it("rejects a WorkOrderFlowTest that can skip or omits the protected API assertion", () => {
    expectsFailure(evaluate(validWorkflow, {
      "android/app/src/androidTest/kotlin/com/maintenance/field/WorkOrderFlowTest.kt": "Assume.assumeTrue(false)",
    }), "assert the seeded work order through a protected API call");
  });

  it("rejects a WorkOrderFlowTest that omits the authenticated Compose UI assertion", () => {
    expectsFailure(evaluate(validWorkflow, {
      "android/app/src/androidTest/kotlin/com/maintenance/field/WorkOrderFlowTest.kt": validFiles["android/app/src/androidTest/kotlin/com/maintenance/field/WorkOrderFlowTest.kt"]
        .replace('onNodeWithText(seededWorkOrder.requestNo).assertIsDisplayed()', ''),
    }), "render it in authenticated Compose UI");
  });

  it("rejects a WorkOrderFlowTest that does not prove the login UI is absent", () => {
    expectsFailure(evaluate(validWorkflow, {
      "android/app/src/androidTest/kotlin/com/maintenance/field/WorkOrderFlowTest.kt": validFiles["android/app/src/androidTest/kotlin/com/maintenance/field/WorkOrderFlowTest.kt"]
        .replace('onAllNodesWithText("패스키 로그인").assertCountEquals(0)', ''),
    }), "render it in authenticated Compose UI");
  });
});
