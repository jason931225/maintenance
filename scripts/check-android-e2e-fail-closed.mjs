#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function jobBlock(workflow) {
  const match = workflow.match(/^[ ]{2}android-instrumented:\s*$(.*?)(?=^[ ]{2}[A-Za-z0-9_-]+:\s*$|(?![\s\S]))/ms);
  return match?.[0] ?? "";
}

function includes(text, needle) {
  return text.includes(needle);
}

function hasShaVerificationBeforeBuild(job) {
  const shaCheck = job.search(/git\s+rev-parse\s+HEAD[\s\S]{0,240}GITHUB_SHA|GITHUB_SHA[\s\S]{0,240}git\s+rev-parse\s+HEAD/);
  const build = job.search(/cargo\s+build\b[\s\S]{0,100}(?:-p|--package)\s+mnt-app/);
  return shaCheck !== -1 && build !== -1 && shaCheck < build;
}

function hasRandomOtp(job) {
  return /(?:openssl\s+rand|\/dev\/urandom|uuidgen)/.test(job)
    && /otp/i.test(job)
    && /sha256|sha-?256/i.test(job);
}

function hasSafeOtpRedeem(job) {
  return /jq\s+-Rsc\s+['"]\{otp:\.\}['"]/.test(job)
    && /auth\/otp\/redeem/.test(job)
    && /--data-binary\s+@-/.test(job);
}

function hasMode600RunnerTempAsset(job) {
  return /RUNNER_TEMP/.test(job)
    && /chmod\s+600\b/.test(job)
    && /field-e2e-session\.properties/.test(job);
}

function hasRequiredResultGate(job) {
  return /WorkOrderFlowTest/.test(job)
    && /(?:junit|test-results|results\.xml|TEST-.*\.xml)/i.test(job)
    && /(?:skipped|skip)/i.test(job)
    && /(?:fail|exit 1)/i.test(job);
}

function hasAlwaysCleanup(job) {
  return /if:\s*always\(\)/.test(job)
    && /(?:rm\s+-rf|rm\s+-f)/.test(job)
    && /(?:kill|pkill|boot-backend)/.test(job);
}

function hasDebugOnlyLoopbackCleartext(files) {
  const debugManifest = files["android/app/src/debug/AndroidManifest.xml"] ?? "";
  const debugNetworkConfig = files["android/app/src/debug/res/xml/network_security_config.xml"] ?? "";
  const mainManifest = files["android/app/src/main/AndroidManifest.xml"] ?? "";
  const gradle = files["android/app/build.gradle.kts"] ?? "";

  const allowedDomains = [...debugNetworkConfig.matchAll(/<domain\b[^>]*>([^<]+)<\/domain>/g)]
    .map((match) => match[1].trim());

  return includes(debugManifest, "networkSecurityConfig")
    && /<base-config\b[^>]*cleartextTrafficPermitted\s*=\s*["']false["']/.test(debugNetworkConfig)
    && allowedDomains.length === 1
    && allowedDomains[0] === "10.0.2.2"
    && /cleartextTrafficPermitted\s*=\s*["']true["']/.test(debugNetworkConfig)
    && !/usesCleartextTraffic\s*=\s*["']true["']/.test(debugManifest)
    && !/usesCleartextTraffic\s*=\s*["']true["']/.test(mainManifest)
    && /https:\/\//.test(gradle)
    && /10\.0\.2\.2/.test(gradle);
}

function hasRunnerTempAuthDirectorySeam(files) {
  const genKeys = files["e2e/harness/gen-keys.sh"] ?? "";
  const bootBackend = files["e2e/harness/boot-backend.sh"] ?? "";
  const runHarness = files["e2e/run.sh"] ?? "";
  return /AUTH_DIR=.*E2E_AUTH_DIR:-/.test(genKeys)
    && /AUTH_DIR=.*E2E_AUTH_DIR:-/.test(bootBackend)
    && /AUTH_DIR=.*E2E_AUTH_DIR:-/.test(runHarness)
    && /install\s+-d\s+-m\s+700\s+"?\$\{AUTH_DIR\}"?/.test(genKeys)
    && /install\s+-d\s+-m\s+700\s+"?\$\{AUTH_DIR\}"?/.test(bootBackend)
    && /PID_FILE=.*AUTH_DIR/.test(bootBackend)
    && /PID_FILE=.*AUTH_DIR/.test(runHarness);
}

function hasSafeMobileCredentialSeed(files) {
  const seed = files["e2e/harness/seed-mobile-ci.sql"] ?? "";
  return /:\{\?otp_hash\}/.test(seed)
    && /\^\[0-9a-f\]\{64\}\$/.test(seed)
    && /00000000-0000-0000-0000-0000000d0002/.test(seed)
    && /decode\(:'otp_hash',\s*'hex'\)/.test(seed)
    && /interval\s+'15 minutes'/.test(seed)
    && !/e2e-tenant-otp|bootstrap_otp\s*=\s*['"][^$]/.test(seed);
}

function hasFailClosedAuthenticatedUiAssertion(files) {
  const test = files["android/app/src/androidTest/kotlin/com/maintenance/field/WorkOrderFlowTest.kt"] ?? "";
  const seededWorkOrderUiAssertions = test.match(/onNodeWithText\(seededWorkOrder\.requestNo\)\.assertIsDisplayed\(\)/g) ?? [];
  return /listTodayWorkOrders\(\)/.test(test)
    && /00000000-0000-0000-0000-000000f00003/.test(test)
    && /field-e2e-session\.properties fixture is missing or unreadable/.test(test)
    && /createAndroidComposeRule<MainActivity>\(\)/.test(test)
    && /onNodeWithText\("오늘 작업"\)\.assertIsDisplayed\(\)/.test(test)
    && /onAllNodesWithText\("패스키 로그인"\)\.assertCountEquals\(0\)/.test(test)
    && /waitUntil\(timeoutMillis\s*=\s*UI_RENDER_TIMEOUT_MILLIS\)/.test(test)
    && seededWorkOrderUiAssertions.length >= 2
    && /onNodeWithText\(seededWorkOrder\.requestNo\)\.assertIsDisplayed\(\)/.test(test)
    && !/\bAssume\b|assumeTrue|assumeFalse/.test(test);
}

/**
 * Pure evaluator deliberately kept independent from filesystem I/O so mutation
 * coverage can prove each mobile-CI safety property fails independently.
 */
export function evaluateAndroidE2eFailClosedChecks(files) {
  const failures = [];
  const workflow = files[".github/workflows/ci.yml"] ?? "";
  const job = jobBlock(workflow);

  if (!job) {
    failures.push(".github/workflows/ci.yml must define android-instrumented job");
    return { failures, passes: [] };
  }

  const checks = [
    [
      !/FIELD_E2E_BASE_URL|FIELD_E2E_SEED_REFRESH_TOKEN/.test(job),
      "android-instrumented must not depend on external FIELD_E2E_BASE_URL or FIELD_E2E_SEED_REFRESH_TOKEN secrets",
    ],
    [
      /services:\s*[\s\S]{0,240}postgres:[\s\S]{0,240}image:\s*postgres:18\.4\b/.test(job),
      "android-instrumented must provision a local postgres:18.4 service",
    ],
    [
      hasShaVerificationBeforeBuild(job),
      "android-instrumented must verify git rev-parse HEAD against GITHUB_SHA before building candidate mnt-app",
    ],
    [
      /e2e\/harness\/db\.sh/.test(job) && hasRandomOtp(job),
      "android-instrumented must seed a randomly generated SHA-256-backed mechanic bootstrap OTP into the ephemeral database",
    ],
    [
      /e2e\/harness\/boot-backend\.sh/.test(job)
        && /(?:127\.0\.0\.1|localhost|10\.0\.2\.2)/.test(job)
        && hasSafeOtpRedeem(job),
      "android-instrumented must boot the candidate backend on loopback and JSON-encode the OTP redeem body safely",
    ],
    [
      hasMode600RunnerTempAsset(job),
      "android-instrumented must mint session tokens only into a mode-0600 RUNNER_TEMP field-e2e-session.properties asset",
    ],
    [
      !/GITHUB_(?:ENV|OUTPUT)[^\n]*(?:ACCESS_TOKEN|REFRESH_TOKEN|BOOTSTRAP_OTP)|(?:ACCESS_TOKEN|REFRESH_TOKEN|BOOTSTRAP_OTP)[^\n]*>>\s*"?\$GITHUB_(?:ENV|OUTPUT)/.test(job),
      "android-instrumented must not leak credentials through GITHUB_ENV or GITHUB_OUTPUT",
    ],
    [
      !/android\.testInstrumentationRunnerArguments\.FIELD_E2E_/.test(job),
      "android-instrumented must not pass raw credentials through Gradle instrumentation arguments",
    ],
    [
      /\.\/gradlew\s+fieldApi34DebugAndroidTest/.test(job),
      "android-instrumented must execute fieldApi34DebugAndroidTest",
    ],
    [
      hasRequiredResultGate(job),
      "android-instrumented must fail when WorkOrderFlowTest is missing, skipped, or unsuccessful in JUnit results",
    ],
    [
      hasAlwaysCleanup(job),
      "android-instrumented must always remove the session asset and stop the candidate backend",
    ],
    [
      hasRunnerTempAuthDirectorySeam(files),
      "E2E harness runtime keys, logs, and backend PID must honor the runner-temp E2E_AUTH_DIR seam",
    ],
    [
      hasSafeMobileCredentialSeed(files),
      "mobile CI seed must accept only a caller-supplied SHA-256 mechanic OTP hash with a short expiry",
    ],
    [
      hasFailClosedAuthenticatedUiAssertion(files),
      "WorkOrderFlowTest must fail without its fixture, assert the seeded work order through a protected API call, and render it in authenticated Compose UI",
    ],
    [
      hasDebugOnlyLoopbackCleartext(files),
      "Android cleartext access must be debug-only and limited to 10.0.2.2 while release retains HTTPS",
    ],
  ];

  const passes = [];
  for (const [condition, message] of checks) {
    if (condition) passes.push(message);
    else failures.push(message);
  }
  return { failures, passes };
}

function read(relativePath) {
  const absolutePath = resolve(root, relativePath);
  return existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : "";
}

function main() {
  const paths = [
    ".github/workflows/ci.yml",
    "android/app/src/debug/AndroidManifest.xml",
    "android/app/src/debug/res/xml/network_security_config.xml",
    "android/app/src/main/AndroidManifest.xml",
    "android/app/build.gradle.kts",
    "android/app/src/androidTest/kotlin/com/maintenance/field/WorkOrderFlowTest.kt",
    "e2e/harness/gen-keys.sh",
    "e2e/harness/boot-backend.sh",
    "e2e/harness/seed-mobile-ci.sql",
    "e2e/run.sh",
  ];
  const files = Object.fromEntries(paths.map((path) => [path, read(path)]));
  const { failures, passes } = evaluateAndroidE2eFailClosedChecks(files);

  for (const pass of passes) console.log(`PASS ${pass}`);
  if (failures.length > 0) {
    console.error("\nAndroid E2E hermetic workflow guard failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nAndroid E2E hermetic workflow guard passed (${passes.length} checks).`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) main();
