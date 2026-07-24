#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function iosJob(workflow) {
  const match = workflow.match(/^[ ]{2}ios-ui-tests:\s*$(.*?)(?=^[ ]{2}[A-Za-z0-9_-]+:\s*$|(?![\s\S]))/ms);
  return match?.[0] ?? "";
}

function steps(job) {
  return job.split(/(?=^[ ]{6}- )/m).filter((step) => /^[ ]{6}- /.test(step));
}

function hasCandidateShaBeforeBackendBuild(job) {
  const sha = job.search(/git\s+rev-parse\s+HEAD[\s\S]{0,240}GITHUB_SHA|GITHUB_SHA[\s\S]{0,240}git\s+rev-parse\s+HEAD/);
  const build = job.search(/cargo\s+build\b[\s\S]{0,100}(?:-p|--package)\s+mnt-app/);
  return sha !== -1 && build !== -1 && sha < build;
}

function hasOptimizedBehavioralBackendBuild(job) {
  const activeJob = stripInertShellData(job);
  const command = "cargo" + " build";
  return /CARGO_PROFILE_DEV_DEBUG:\s*"0"/.test(activeJob)
    && activeJob.includes(`${command} --locked -p mnt-app`)
    && /MNT_APP_BIN="\$CARGO_TARGET_DIR\/debug\/mnt-app"/.test(activeJob)
    && !new RegExp(`${command}[^\n]*--release`).test(activeJob)
    && !/MNT_APP_BIN="\$CARGO_TARGET_DIR\/release\/mnt-app"/.test(activeJob);
}

function hasHostedUntrustedBoundary(job) {
  return /runs-on:\s*macos-26\b/.test(job)
    && !/\bself-hosted\b/i.test(job.replace(/#.*$/gm, ""))
    && !/vars\.MNT_IOS_CI_RUNNER/.test(job)
    && !/\bruns-on:\s*\$\{\{/.test(job);
}

function hasCompleteFailSlowRuntimeBudget(job) {
  const timeout = /timeout-minutes:\s*(\d+)\b/.exec(job);
  const manifest = /SHARD_MANIFEST=\(([^)]*)\)/.exec(job);
  if (timeout === null || manifest === null) return false;

  const timeoutMinutes = Number(timeout[1]);
  const expectedBudgets = new Map([
    ["preflight", 180],
    ["login-validation", 90],
    ["accessibility-id-parity", 45],
    ["critical-path", 540],
    ["messenger", 210],
    ["camera-capture", 150],
    ["audit-dynamic-today", 150],
    ["audit-dynamic-detail", 150],
    ["audit-dynamic-messenger", 150],
    ["audit-dynamic-login", 120],
    ["accessibility-standard", 360],
    ["accessibility-largest", 240],
    ["accessibility-dark", 240],
    ["dynamic-type-large", 150],
    ["dynamic-type-ax5", 180],
  ]);
  const declaredShards = manifest[1].trim().split(/\s+/).filter(Boolean);
  if (declaredShards.length !== expectedBudgets.size
      || declaredShards.some((name, index) => name !== [...expectedBudgets.keys()][index])) return false;
  for (const [shard, seconds] of expectedBudgets) {
    const escaped = shard.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const budget = new RegExp(`${escaped}\\)[\\s\\S]{0,220}SHARD_TIMEOUT_SECONDS=${seconds}\\b`);
    if (!budget.test(job)) return false;
  }

  const testBudgetSeconds = [...expectedBudgets.values()].reduce((total, seconds) => total + seconds, 0);
  const setupVerificationAndCleanupReserveSeconds = 30 * 60;
  const minimumSeconds = testBudgetSeconds + setupVerificationAndCleanupReserveSeconds;

  return timeoutMinutes * 60 >= minimumSeconds && timeoutMinutes <= 90;
}

function hasPipelineTimingTelemetry(job) {
  const activeJob = stripInertShellData(job);
  const phases = [
    "postgres-18.4-build-and-start",
    "rust-debug-build",
    "database-and-backend-bootstrap",
    "xcode-project-and-test-build",
    "structured-result-verification",
    "runtime-cleanup",
  ];
  return /TIMINGS="\$ARTIFACTS\/pipeline-timings\.tsv";\s*ACTIVE_PHASE="\$ARTIFACTS\/active-phase\.txt"/.test(activeJob)
    && /TIMING_ACTIVE=0/.test(activeJob)
    && /timing_start\s*\(\s*\)[\s\S]{0,260}TIMING_STARTED_AT="\$\(date \+%s\)"[\s\S]{0,120}TIMING_ACTIVE=1[\s\S]{0,180}>\s*"\$ACTIVE_PHASE"/.test(activeJob)
    && /timing_finish\s*\(\s*\)[\s\S]{0,420}>>\s*"\$TIMINGS"[\s\S]{0,260}::notice title=iOS UI timing[\s\S]{0,120}TIMING_ACTIVE=0/.test(activeJob)
    && /on_exit\s*\(\s*\)[\s\S]{0,120}exit_status=\$\?[\s\S]{0,220}TIMING_ACTIVE\s*==\s*1[\s\S]{0,180}timing_finish\s+"aborted\(exit=\$exit_status\)"[\s\S]{0,160}clean_runtime\s*\|\|\s*true[\s\S]{0,120}exit\s+"\$exit_status"/.test(activeJob)
    && /trap\s+on_exit\s+EXIT/.test(activeJob)
    && phases.every((phase) => activeJob.includes(`timing_start ${phase}`))
    && /timing_start\s+"test:\$shard_name"/.test(activeJob)
    && /TIMING_BUDGET_SECONDS="\$SHARD_TIMEOUT_SECONDS"/.test(activeJob)
    && /timeout_marker="\$ARTIFACTS\/\$shard_name-timeout\.txt"/.test(activeJob)
    && />\s*"\$timeout_marker"/.test(activeJob)
    && /elif\s+\[\[\s+-e\s+"\$timeout_marker"\s+\]\];\s*then\s*status=124/.test(activeJob)
    && /if\s+\(\(\s*shard_status\s*==\s*0\s*\)\);\s*then[\s\S]{0,100}timing_finish\s+passed[\s\S]{0,100}elif\s+\(\(\s*shard_status\s*==\s*124\s*\)\);\s*then[\s\S]{0,100}timing_finish\s+timeout[\s\S]{0,100}else[\s\S]{0,100}timing_finish\s+failed/.test(activeJob)
    && /GITHUB_STEP_SUMMARY/.test(activeJob)
    && /iOS UI pipeline timings/.test(activeJob);
}

function hasPinnedToolchain(job, workflow) {
  const jobSteps = steps(job);
  const setupNodeStep = jobSteps.findIndex((step) => /actions\/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e/.test(step));
  const backendStep = jobSteps.findIndex((step) => /Hermetic exact-SHA backend and UI test/.test(step));
  const activeJob = stripInertShellData(job);
  const activeBackendStep = backendStep === -1 ? "" : stripInertShellData(jobSteps[backendStep]);
  const protectedStartupVariableNames = ["BASH_ENV", "ENV", "NODE_OPTIONS", "NODE_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH", "LD_PRELOAD"];
  const protectedStartupVariables = protectedStartupVariableNames.join(" ");
  const emptyStartupExpansion = protectedStartupVariableNames.map((name) => `\\$\\{${name}-\\}`).join("");
  const trustedNodePrelude = new RegExp(`run:\\s*\\|\\s*\\n[ \\t]*set -euo pipefail\\s*\\n[ \\t]*unset ${protectedStartupVariables}\\s*\\n[ \\t]*test -z "${emptyStartupExpansion}"\\s*\\n[ \\t]*readonly ${protectedStartupVariables}\\s*\\n[ \\t]*case "\\$RUNNER_ARCH" in X64\\) NODE_ARCH=x64 ;; ARM64\\) NODE_ARCH=arm64 ;; \\*\\) echo "unsupported runner architecture: \\$RUNNER_ARCH" >&2; exit 1 ;; esac\\s*\\n[ \\t]*readonly RUNNER_TOOL_CACHE RUNNER_ARCH NODE_ARCH\\s*\\n[ \\t]*readonly MNT_IOS_NODE_BIN="\\$RUNNER_TOOL_CACHE/node/24\\.16\\.0/\\$NODE_ARCH/bin/node"\\s*\\n[ \\t]*test -x "\\$MNT_IOS_NODE_BIN"; test ! -L "\\$MNT_IOS_NODE_BIN"; test "\\$\\("\\$MNT_IOS_NODE_BIN" --version\\)" = v24\\.16\\.0`);
  const nodeAssignments = activeJob.match(/^[ \t]*(?:readonly[ \t]+)?MNT_IOS_NODE_BIN=/gm) ?? [];
  const protectedEnvironmentName = "(?:MNT_IOS_NODE_BIN|RUNNER_TOOL_CACHE|RUNNER_ARCH|BASH_ENV|ENV|NODE_OPTIONS|NODE_PATH|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH|DYLD_FRAMEWORK_PATH|LD_PRELOAD)";
  const poisonedEnvironment = new RegExp(`${protectedEnvironmentName}=[^\\n]*(?:GITHUB_ENV|GITHUB_PATH)|(?:GITHUB_ENV|GITHUB_PATH)[^\\n]*${protectedEnvironmentName}=`).test(activeJob);
  const overriddenRunnerEnvironment = /(?:^|\n)[ \t]*(?:["'])?(?:RUNNER_TOOL_CACHE|RUNNER_ARCH)(?:["'])?[ \t]*:|[,{][ \t]*(?:["'])?(?:RUNNER_TOOL_CACHE|RUNNER_ARCH)(?:["'])?[ \t]*:/.test(workflow);
  const injectedStartupEnvironment = /(?:^|\n)[ \t]*(?:["'])?(?:BASH_ENV|ENV|NODE_OPTIONS|NODE_PATH|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH|DYLD_FRAMEWORK_PATH|LD_PRELOAD)(?:["'])?[ \t]*:|[,{][ \t]*(?:["'])?(?:BASH_ENV|ENV|NODE_OPTIONS|NODE_PATH|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH|DYLD_FRAMEWORK_PATH|LD_PRELOAD)(?:["'])?[ \t]*:/.test(workflow);
  const yamlEnvironmentSections = workflow.match(/^[ \t]*env:[^\n]*$/gm) ?? [];
  const exactJobEnvironment = /^[ ]{4}env:\n[ ]{6}DEVELOPER_DIR: \/Applications\/Xcode_26\.6\.app\/Contents\/Developer\n(?=^[ ]{4}steps:)/m.test(job);
  const exactBackendEnvironment = /^[ ]{8}env: \{CARGO_INCREMENTAL: "0", CARGO_PROFILE_DEV_DEBUG: "0", SQLX_OFFLINE: "true"\}$/m.test(activeBackendStep);
  const backendShellEntries = activeBackendStep.match(/^[ ]{8}shell:[^\n]*$/gm) ?? [];
  const exactEnvironmentFileWrite = /printf '%s\\n' "MNT_IOS_JOB_ROOT=\$D" "CARGO_HOME=\$D\/cargo-home" "RUSTUP_HOME=\$D\/rustup-home" "CARGO_TARGET_DIR=\$D\/cargo-target" >> "\$GITHUB_ENV"/.test(activeJob);
  return setupNodeStep !== -1
    && backendStep === setupNodeStep + 1
    && trustedNodePrelude.test(activeBackendStep)
    && nodeAssignments.length === 1
    && !poisonedEnvironment
    && !overriddenRunnerEnvironment
    && !injectedStartupEnvironment
    && yamlEnvironmentSections.length === 2
    && exactJobEnvironment
    && exactBackendEnvironment
    && backendShellEntries.length === 1
    && backendShellEntries[0] === "        shell: bash"
    && exactEnvironmentFileWrite
    && (activeJob.match(/\bGITHUB_ENV\b/g) ?? []).length === 1
    && (activeJob.match(/\bGITHUB_PATH\b/g) ?? []).length === 1
    && /"\$MNT_IOS_NODE_BIN"\s+--test\s+scripts\/boot-backend-port-conflict\.test\.mjs[\s\S]{0,400}"\$MNT_IOS_NODE_BIN"\s+scripts\/check-ios-ui-test-fail-closed\.mjs/.test(activeBackendStep)
    && /actions\/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e/.test(job)
    && /node-version:\s*"24\.16\.0"/.test(job)
    && /DEVELOPER_DIR:\s*\/Applications\/Xcode_26\.6\.app\/Contents\/Developer/.test(job)
    && /test\s+"\$\(xcodebuild -version\)"\s*=\s*\$'Xcode 26\.6\\nBuild version 17F113'/.test(job)
    && /SWIFT_COMPILER="\$\(xcrun swiftc -version 2>&1\)"/.test(job)
    && /\[\[\s+"\$SWIFT_COMPILER"\s+==\s+\*'Apple Swift version 6\.3\.3 \(swiftlang-6\.3\.3\.1\.3 clang-2100\.1\.1\.101\)'\*\s+\]\]/.test(job)
    && /SIM_RUNTIME=com\.apple\.CoreSimulator\.SimRuntime\.iOS-26-5/.test(job)
    && /SIM_DEVICE_TYPE=com\.apple\.CoreSimulator\.SimDeviceType\.iPhone-17-Pro/.test(job)
    && /simctl\s+list\s+devicetypes\s+-j[\s\S]{0,400}identifier[\s\S]{0,400}==\s*target[\s\S]{0,240}"\$SIM_DEVICE_TYPE"/.test(job)
    && /MNT_IOS_JOB_ROOT=\$D/.test(job)
    && /CARGO_HOME=\$D\/cargo-home/.test(job)
    && /RUSTUP_HOME=\$D\/rustup-home/.test(job)
    && /CARGO_TARGET_DIR=\$D\/cargo-target/.test(job)
    && />>\s*"\$GITHUB_ENV"/.test(job);
}

function hasStrictSwift6LanguageMode(files) {
  const project = files["ios/project.yml"] ?? "";
  const xcconfig = files["ios/Config/App.xcconfig"] ?? "";
  const projectSwiftVersions = project.match(/^[ \t]*SWIFT_VERSION:[^\n]*$/gm) ?? [];
  const projectStrictConcurrency = project.match(/^[ \t]*SWIFT_STRICT_CONCURRENCY:[^\n]*$/gm) ?? [];
  const xcconfigSwiftVersions = xcconfig.match(/^SWIFT_VERSION\s*=[^\n]*$/gm) ?? [];
  const xcconfigStrictConcurrency = xcconfig.match(/^SWIFT_STRICT_CONCURRENCY\s*=[^\n]*$/gm) ?? [];

  return projectSwiftVersions.length === 1
    && projectSwiftVersions[0].trim() === 'SWIFT_VERSION: "6.0"'
    && projectStrictConcurrency.length === 1
    && projectStrictConcurrency[0].trim() === "SWIFT_STRICT_CONCURRENCY: complete"
    && xcconfigSwiftVersions.length === 1
    && xcconfigSwiftVersions[0] === "SWIFT_VERSION = 6.0"
    && xcconfigStrictConcurrency.length === 1
    && xcconfigStrictConcurrency[0] === "SWIFT_STRICT_CONCURRENCY = complete";
}

function hasOfficialPostgres184Source(job) {
  return /ftp\.postgresql\.org\/pub\/source\/v18\.4\/postgresql-18\.4\.tar\.(?:bz2|gz)/.test(job)
    && /81a81ec695fb0c7901407defaa1d2f7973617154cf27ba74e3a7ab8e64436094/.test(job)
    && /(?:sha256sum|shasum\s+-a\s+256)[\s\S]{0,160}-c\b/i.test(job)
    && /\.\/configure\b[\s\S]{0,240}make\s+-j[\s\S]{0,240}make\s+install/.test(job);
}

function stripShellComments(source) {
  return source.split("\n").map((line) => {
    let singleQuoted = false;
    let doubleQuoted = false;
    let escaped = false;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\" && !singleQuoted) {
        escaped = true;
        continue;
      }
      if (character === "'" && !doubleQuoted) singleQuoted = !singleQuoted;
      else if (character === '"' && !singleQuoted) doubleQuoted = !doubleQuoted;
      else if (character === "#" && !singleQuoted && !doubleQuoted) {
        const previous = line[index - 1];
        if (index === 0 || /\s|[;&|()]/.test(previous)) return line.slice(0, index);
      }
    }
    return line;
  }).join("\n");
}

function nextShellQuoteState(line, initialQuote) {
  let quote = initialQuote;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quote = null;
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") escaped = true;
    else if (character === "'" || character === '"') quote = character;
    else if (character === "#" && (index === 0 || /\s|[;&|()]/.test(line[index - 1]))) break;
  }
  return quote;
}

function stripInertShellData(source) {
  const output = [];
  const pending = [];
  let active = null;
  let quote = null;
  for (const line of source.split("\n")) {
    if (active !== null) {
      if (line.trim() === active) active = pending.shift() ?? null;
      output.push("");
      continue;
    }

    const startedInsideQuote = quote !== null;
    quote = nextShellQuoteState(line, quote);
    if (startedInsideQuote) {
      output.push("");
      continue;
    }

    const command = stripShellComments(line);
    output.push(command);
    for (const match of command.matchAll(/(?:^|[\s;&|()])<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/g)) {
      pending.push(match[1] ?? match[2] ?? match[3]);
    }
    active = pending.shift() ?? null;
  }
  return output.join("\n");
}

function hasRequiredPostgresExtensions(job) {
  const activeJob = stripShellComments(job);
  const opensslPrefix = activeJob.search(/OPENSSL_PREFIX="\$\(brew\s+--prefix\s+openssl@3\)"/);
  const opensslCppFlags = activeJob.search(/(?:export\s+)?CPPFLAGS="-I\$OPENSSL_PREFIX\/include"/);
  const opensslLdFlags = activeJob.search(/LDFLAGS="-L\$OPENSSL_PREFIX\/lib"/);
  const opensslPkgConfig = activeJob.search(/PKG_CONFIG_PATH="\$OPENSSL_PREFIX\/lib\/pkgconfig"/);
  const sslConfigure = activeJob.search(/\.\/configure\b[\s\S]{0,400}--with-ssl=openssl\b/);
  const coreInstall = activeJob.search(/\bmake\s+install\b/);
  const pgcryptoBuild = activeJob.search(/\bmake\s+-C\s+contrib\/pgcrypto\s+-j/);
  const pgcryptoInstall = activeJob.search(/\bmake\s+-C\s+contrib\/pgcrypto\s+install\b/);
  const pgTrgmBuild = activeJob.search(/\bmake\s+-C\s+contrib\/pg_trgm\s+-j/);
  const pgTrgmInstall = activeJob.search(/\bmake\s+-C\s+contrib\/pg_trgm\s+install\b/);
  const postgresStart = activeJob.search(/"\$PG_PREFIX\/bin\/pg_ctl"[\s\S]{0,240}\s-w\s+start\b/);
  const extensionLoadTest = activeJob.search(/PGPASSWORD="\$UP"[\s\S]{0,160}"\$PG_PREFIX\/bin\/psql"[\s\S]{0,320}-v\s+ON_ERROR_STOP=1[\s\S]{0,160}-c\s+'CREATE EXTENSION pgcrypto;'[\s\S]{0,160}-c\s+'CREATE EXTENSION pg_trgm;'[\s\S]{0,160}-c\s+'DROP EXTENSION pg_trgm;'[\s\S]{0,160}-c\s+'DROP EXTENSION pgcrypto;'/);
  const backendBuild = activeJob.search(/cargo\s+build\b[\s\S]{0,100}(?:-p|--package)\s+mnt-app/);
  return opensslPrefix !== -1
    && opensslCppFlags > opensslPrefix
    && opensslLdFlags >= opensslCppFlags
    && opensslPkgConfig >= opensslLdFlags
    && sslConfigure > opensslPkgConfig
    && coreInstall > sslConfigure
    && pgcryptoBuild > coreInstall
    && pgcryptoInstall > pgcryptoBuild
    && pgTrgmBuild > pgcryptoInstall
    && pgTrgmInstall > pgTrgmBuild
    && postgresStart > pgTrgmInstall
    && extensionLoadTest > postgresStart
    && backendBuild > extensionLoadTest;
}

function hasValidLoopbackWebauthnPolicy(job, launcher) {
  const backendStep = steps(job).find((step) => /Hermetic exact-SHA backend and UI test/.test(step)) ?? "";
  const activeJob = stripInertShellData(job).replace(/\\\r?\n\s*/g, " ");
  const invocation = /^[ \t]*MNT_IOS_COLDSTART_OTP="\$COLDSTART_OTP"\s+"\$MNT_IOS_NODE_BIN"\s+"\$ROOT\/scripts\/boot-ios-ui-backend\.mjs"\s+"\$ROOT"\s+"\$AUTH_DIR"\s+"\$BP"[ \t]*$/gm;
  const matches = [...activeJob.matchAll(invocation)];
  const dbCommand = '"$ROOT/e2e/harness/db.sh"';
  const db = activeJob.indexOf(dbCommand);
  const launch = matches[0]?.index ?? -1;
  const pidRead = activeJob.indexOf('BACKEND_PID="$(cat "$BACKEND_PID_FILE")"');
  const forbiddenLowLevelControls = /\b(?:E2E_AUTH_DIR|E2E_HTTP_ADDR|E2E_PORT_CONFLICT_MODE|E2E_COLDSTART_OTP|E2E_RP_ORIGIN|E2E_RP_ID)\b|e2e\/harness\/boot-backend\.sh/;
  const approvedBackendStepSha256 = "038d3fff2cbbe28b710d0670f2ea3a978b7bdadbd2fb3aba25ac1ef1f598d041";
  const approvedLauncherSha256 = "a153fab32c9f4ca597605ec126d40e3bfc106c0ce17c368078e22c265ca9f1ad";
  const backendStepSha256 = createHash("sha256").update(backendStep).digest("hex");
  const launcherSha256 = createHash("sha256").update(launcher).digest("hex");
  const trustedNodeInvocations = activeJob.match(/"\$MNT_IOS_NODE_BIN"/g) ?? [];
  return matches.length === 1
    && (activeJob.match(/scripts\/boot-ios-ui-backend\.mjs/g) ?? []).length === 1
    && trustedNodeInvocations.length === 7
    && /"\$MNT_IOS_NODE_BIN"\s+"\$ROOT\/scripts\/verify-xcresult-test-results\.mjs"\s+"\$\{VERIFY_ARGS\[@\]\}"\s+--swift-tests\s+"\$ROOT\/ios\/UITests"/.test(activeJob)
    && !/(?:^|[;&|(])[ \t]*node[ \t]+/m.test(activeJob)
    && !forbiddenLowLevelControls.test(activeJob)
    && db !== -1 && launch > db && pidRead > launch
    && activeJob.slice(db + dbCommand.length, launch).trim() === ""
    && activeJob.slice(launch + (matches[0]?.[0].length ?? 0), pidRead).trim() === ""
    && backendStepSha256 === approvedBackendStepSha256
    && launcherSha256 === approvedLauncherSha256;
}

function hasPinnedJobLocalXcodegen(job) {
  return !/\bbrew\s+install\s+xcodegen\b/.test(job)
    && /\bTOOLS="\$MNT_IOS_JOB_ROOT\/tools"/.test(job)
    && /github\.com\/yonaskolb\/XcodeGen\/releases\/download\/2\.46\.0\/xcodegen\.zip/.test(job)
    && /4d9e34b62172d645eed6457cac13fc222569974098ef4ee9c3368bedf0196806/.test(job)
    && /shasum\s+-a\s+256\s+--check\s+-/.test(job)
    && /ditto\s+-x\s+-k\s+"\$ZIP"\s+"\$DIST"/.test(job)
    && /XCODEGEN_BIN="\$DIST\/xcodegen\/bin\/xcodegen"/.test(job)
    && /test\s+-d\s+"\$DIST\/xcodegen\/share\/xcodegen\/SettingPresets"/.test(job)
    && /test\s+"\$\("\$XCODEGEN_BIN"\s+--version\)"\s+=\s+'Version:\s+2\.46\.0'/.test(job)
    && /"\$DIST\/xcodegen\/bin"\s*>>\s*"\$GITHUB_PATH"/.test(job);
}

function hasJobLocalPostgres(job) {
  return /\bD="\$MNT_IOS_JOB_ROOT"/.test(job)
    && /\bPGDATA="\$D\/postgres-data"/.test(job)
    && /install\s+-d\s+-m\s+700\s+"\$D"[\s\S]{0,180}"\$PGDATA"/.test(job)
    && /\binitdb\b/.test(job)
    && /port\s*\(\)\s*\{[\s\S]{0,280}127\.0\.0\.1/.test(job)
    && /PP="?\$\(port\)"?[\s\S]{0,240}BP="?\$\(port\)"?[\s\S]{0,240}while\s+\[\[\s+"\$PP"\s+==\s+"\$BP"\s+\]\]/.test(job)
    && /pg_ctl/.test(job);
}

function hasPerClassSessions(job) {
  const activeJob = stripInertShellData(job);
  const fixtures = ["f00004", "f00003", "f00005", "f00007", "f00008", "c10001", "c20001"];
  const manifest = /SHARD_MANIFEST=\(([^)]*)\)/.exec(activeJob);
  const expectedShards = [
    "preflight", "login-validation", "accessibility-id-parity", "critical-path", "messenger", "camera-capture",
    "audit-dynamic-today", "audit-dynamic-detail", "audit-dynamic-messenger", "audit-dynamic-login",
    "accessibility-standard", "accessibility-largest", "accessibility-dark", "dynamic-type-large", "dynamic-type-ax5",
  ];
  const declaredShards = manifest?.[1].trim().split(/\s+/).filter(Boolean) ?? [];
  return declaredShards.length === expectedShards.length
    && declaredShards.every((shard, index) => shard === expectedShards[index])
    && /secret\s*\(\)\s*\{\s*openssl\s+rand\s+-hex\s+\d+;\s*\}/.test(activeJob)
    && /mint_shard_session\s*\(\)\s*\{[\s\S]{0,240}local\s+fixture_profile="\$1"\s+otp\s+hash[\s\S]{0,400}unset\s+MNT_UITEST_ACCESS_TOKEN\s+MNT_UITEST_REFRESH_TOKEN[\s\S]{0,240}rm\s+-f\s+"\$AUTH_DIR\/otp\.json"\s+"\$AUTH_DIR\/tokens\.json"[\s\S]{0,240}otp="\$\(secret\)"\s+\|\|\s+return\s+1/.test(activeJob)
    && /echo\s+"::add-mask::\$otp"/.test(activeJob)
    && /hash="\$\([\s\S]{0,160}shasum\s+-a\s+256[\s\S]{0,120}\)"\s+\|\|\s+return\s+1/.test(activeJob)
    && /seed-mobile-ci\.sql"\s+\|\|\s+return\s+1/.test(activeJob)
    && /auth\/otp\/redeem[\s\S]{0,400}\|\|\s+\{\s*rm\s+-f[\s\S]{0,160}return\s+1;\s*\}/.test(activeJob)
    && /MNT_UITEST_ACCESS_TOKEN/.test(activeJob)
    && /MNT_UITEST_REFRESH_TOKEN/.test(activeJob)
    && /echo\s+"::add-mask::\$MNT_UITEST_ACCESS_TOKEN"/.test(activeJob)
    && /echo\s+"::add-mask::\$MNT_UITEST_REFRESH_TOKEN"/.test(activeJob)
    && /for\s+shard_name\s+in\s+"\$\{SHARD_MANIFEST\[@\]\}";\s*do[\s\S]{0,900}configure_shard\s+"\$shard_name"[\s\S]{0,900}mint_shard_session\s+"\$SHARD_FIXTURE_PROFILE"/.test(activeJob)
    && /SHARD_SELECTORS=\(\)/.test(activeJob)
    && /for\s+selector\s+in\s+"\$@";\s*do\s*xcode_command\+=\("-only-testing:\$selector"\);\s*done/.test(activeJob)
    && fixtures.every((suffix) => new RegExp(`00000000-0000-0000-0000-000000${suffix}`).test(activeJob));
}

function hasAccessibilityFixtureProfileIsolation(job, seed) {
  const activeJob = stripInertShellData(job);
  const configure = /configure_shard\s*\(\)\s*\{([\s\S]*?)\n[ \t]*\}/.exec(activeJob)?.[1] ?? "";
  const oneRowShards = [
    "audit-dynamic-today", "audit-dynamic-detail", "audit-dynamic-messenger", "audit-dynamic-login",
    "accessibility-standard", "accessibility-largest", "accessibility-dark", "dynamic-type-large", "dynamic-type-ax5",
  ];
  const profileAssignments = oneRowShards.every((shard) => {
    const caseArm = new RegExp(`(?:^|\\n)[ \\t]*${shard}\\)([\\s\\S]*?)[ \\t]*;;`).exec(configure)?.[1] ?? "";
    return (caseArm.match(/SHARD_FIXTURE_PROFILE=accessibility-audit-one-row/g) ?? []).length === 1
      && !/SHARD_FIXTURE_PROFILE=full/.test(caseArm);
  });
  const fullDefault = /SHARD_FIXTURE_PROFILE=full/.test(configure);
  const rejectsUnknownShard = /\*\)\s*return\s+1\s*;;/.test(configure);
  const passesProfileToSeed = /mint_shard_session\s*\(\)\s*\{[\s\S]{0,240}local\s+fixture_profile="\$1"[\s\S]{0,800}-v\s+"otp_hash=\$hash"\s+-v\s+"fixture_profile=\$fixture_profile"\s+-f\s+"\$ROOT\/e2e\/harness\/seed-mobile-ci\.sql"/.test(activeJob);
  const resolvesBeforeMint = /for\s+shard_name\s+in\s+"\$\{SHARD_MANIFEST\[@\]\}";\s*do[\s\S]{0,1000}configure_shard\s+"\$shard_name"[\s\S]{0,1200}mint_shard_session\s+"\$SHARD_FIXTURE_PROFILE"/.test(activeJob);

  const failClosedSeedGuards = /^\\set\s+ON_ERROR_STOP\s+on\s*$/m.test(seed)
    && (seed.match(/RAISE\s+EXCEPTION\s+'seed-mobile-ci:/gi) ?? []).length === 6
    && !/\\quit\b/.test(seed);
  const requiresProfile = /\\if\s+:\{\?fixture_profile\}[\s\S]{0,220}\\else[\s\S]{0,220}RAISE\s+EXCEPTION\s+'seed-mobile-ci:\s+required psql variable fixture_profile is missing'[\s\S]{0,80}\\endif/i.test(seed);
  const exactAllowlist = /SELECT\s+:'fixture_profile'\s+IN\s*\(\s*'full'\s*,\s*'accessibility-audit-one-row'\s*\)\s+AS\s+fixture_profile_valid\s+\\gset[\s\S]{0,220}\\if\s+:fixture_profile_valid[\s\S]{0,180}\\else[\s\S]{0,220}RAISE\s+EXCEPTION\s+'seed-mobile-ci:\s+fixture_profile must be full or accessibility-audit-one-row'[\s\S]{0,80}\\endif/i.test(seed);
  const auditFlag = /SELECT\s+:'fixture_profile'\s*=\s*'accessibility-audit-one-row'\s+AS\s+accessibility_audit_one_row\s+\\gset/i.test(seed);
  const assignmentBranch = /\\if\s+:accessibility_audit_one_row([\s\S]*?)\\else([\s\S]*?)\\endif/i.exec(seed);
  const auditAssignments = assignmentBranch?.[1] ?? "";
  const fullAssignments = assignmentBranch?.[2] ?? "";
  const resetsCompleteMechanicSurface = /DELETE\s+FROM\s+work_order_assignments\s+WHERE\s+org_id\s*=\s*'00000000-0000-0000-0000-0000000000a1'\s+AND\s+mechanic_id\s*=\s*'00000000-0000-0000-0000-0000000d0002'/i.test(seed);
  const auditRetainsOnlyDetail = /INSERT\s+INTO\s+work_order_assignments/i.test(auditAssignments) && /f00004/.test(auditAssignments) && !/f00003|f00005|f00007|f00008/.test(auditAssignments);
  const fullFixtureIDs = ["f00003", "f00004", "f00005", "f00007", "f00008"];
  const fullAssignmentIDs = ["a00001", "a00002", "a00003", "a00007", "a00008"];
  const fullRetainsAllRows = [...fullFixtureIDs, ...fullAssignmentIDs].every((id) => fullAssignments.includes(id));
  const assignmentPostconditionBlock = /SELECT\s+CASE\s+:'fixture_profile'([\s\S]*?)\\gset/i.exec(seed)?.[0] ?? "";
  const assignmentPostcondition = /AS\s+fixture_profile_postcondition_valid/i.test(assignmentPostconditionBlock) && /WHEN\s+'full'[\s\S]*?COUNT\s*\(\s*\*\s*\)\s*=\s*5/i.test(assignmentPostconditionBlock) && fullFixtureIDs.every((id) => assignmentPostconditionBlock.includes(id)) && /WHEN\s+'accessibility-audit-one-row'[\s\S]*?COUNT\s*\(\s*\*\s*\)\s*=\s*1[\s\S]*?f00004/i.test(assignmentPostconditionBlock) && /FROM\s+work_order_assignments\s+WHERE\s+org_id\s*=\s*'00000000-0000-0000-0000-0000000000a1'\s+AND\s+mechanic_id\s*=\s*'00000000-0000-0000-0000-0000000d0002'/i.test(assignmentPostconditionBlock) && /\\if\s+:fixture_profile_postcondition_valid[\s\S]{0,160}\\else[\s\S]{0,240}RAISE\s+EXCEPTION\s+'seed-mobile-ci:\s+fixture profile assignment postcondition failed'[\s\S]{0,80}\\endif/i.test(seed);
  const messageBranch = /-- The audit profile deliberately has only the exact message selected by[\s\S]*?INSERT\s+INTO\s+messenger_messages([\s\S]*?)\\else\s*\nINSERT\s+INTO\s+messenger_messages([\s\S]*?)\\endif\s*\n\s*-- Both profiles must be exact/i.exec(seed);
  const auditMessages = messageBranch?.[1] ?? "";
  const fullMessages = messageBranch?.[2] ?? "";
  const fullMessageIDs = ["c20001", "c20002", "c20003", "c20004", "c20005", "c20006", "c20007", "c20008"];
  const auditRetainsOnlyInitialMessage = /c20001/.test(auditMessages) && !/c20002|c20003|c20004|c20005|c20006|c20007|c20008/.test(auditMessages);
  const fullRetainsAllMessages = fullMessageIDs.every((id) => fullMessages.includes(id));
  const messagePostconditionBlock = /-- Both profiles must be exact[\s\S]*?SELECT\s+CASE\s+:'fixture_profile'([\s\S]*?)END\s+AS\s+fixture_profile_message_postcondition_valid[\s\S]*?\\gset/i.exec(seed)?.[0] ?? "";
  const messagePostcondition = /WHEN\s+'full'[\s\S]*?COUNT\s*\(\s*\*\s*\)\s*=\s*8/i.test(messagePostconditionBlock) && fullMessageIDs.every((id) => messagePostconditionBlock.includes(id)) && /WHEN\s+'accessibility-audit-one-row'[\s\S]*?COUNT\s*\(\s*\*\s*\)\s*=\s*1[\s\S]*?c20001/i.test(messagePostconditionBlock) && /FROM\s+messenger_messages\s+WHERE\s+thread_id\s*=\s*'00000000-0000-0000-0000-000000c10001'/i.test(messagePostconditionBlock) && /\\if\s+:fixture_profile_message_postcondition_valid[\s\S]{0,160}\\else[\s\S]{0,240}RAISE\s+EXCEPTION\s+'seed-mobile-ci:\s+fixture profile message postcondition failed'[\s\S]{0,80}\\endif/i.test(seed);

  return fullDefault && profileAssignments && rejectsUnknownShard && passesProfileToSeed && resolvesBeforeMint
    && failClosedSeedGuards && requiresProfile && exactAllowlist && auditFlag && resetsCompleteMechanicSurface
    && auditRetainsOnlyDetail && fullRetainsAllRows && assignmentPostcondition && auditRetainsOnlyInitialMessage
    && fullRetainsAllMessages && messagePostcondition;
}

function hasPerClassFixtureIsolation(seed) {
  const index = (fragment) => seed.indexOf(fragment);
  const required = [
    "DELETE FROM work_order_approval_steps",
    "DELETE FROM work_order_status_history",
    "DELETE FROM work_order_assignments",
    "UPDATE work_orders",
    "INSERT INTO work_order_assignments",
    "DELETE FROM location_collection_logs",
    "DELETE FROM location_pings",
    "DELETE FROM location_consent_ledger",
    "DELETE FROM location_consents",
    "DELETE FROM messenger_read_receipts",
    "DELETE FROM messenger_messages",
    "INSERT INTO messenger_messages",
  ];
  const positions = required.map(index);
  const fixtureIds = [
    "f00003", "f00004", "f00005", "f00007", "f00008",
    "a00001", "a00002", "a00003", "a00007", "a00008", "c10001",
    "c20001", "c20002", "c20003", "c20004", "c20005", "c20006", "c20007", "c20008",
  ];
  return positions.every((position) => position !== -1)
    && positions.every((position, i) => i === 0 || position > positions[i - 1])
    && fixtureIds.every((suffix) => new RegExp(`00000000-0000-0000-0000-000000${suffix}`).test(seed))
    && /00000000-0000-0000-0000-0000000d0002/.test(seed)
    && /status\s*=\s*CASE id[\s\S]{0,360}f00003[\s\S]{0,100}'ASSIGNED'[\s\S]{0,240}ELSE 'IN_PROGRESS'/.test(seed)
    && /result_type\s*=\s*'UNKNOWN'[\s\S]{0,300}report_submitted_at\s*=\s*NULL/.test(seed)
    && !/DELETE\s+FROM\s+audit_events\b/i.test(seed);
}

function hasMode600Xctestrun(job) {
  const derived = job.search(/\bDERIVED="\$D\/derived-data"/);
  const discovered = job.search(/\bXCTESTRUN="\$\(find\s+"\$DERIVED\/Build\/Products"[\s\S]{0,160}-name\s+'\*\.xctestrun'[\s\S]{0,160}-print\s+-quit\)"/);
  const protectedFile = job.search(/chmod\s+600\s+"\$XCTESTRUN"/);
  const patched = job.search(/patch-ios-xctestrun\.py\s+"\$XCTESTRUN"/);
  const executed = job.search(/test-without-building[\s\S]{0,160}-xctestrun\s+"\$XCTESTRUN"/);
  return derived !== -1 && discovered > derived && protectedFile > discovered && patched > protectedFile && executed > patched
    && /MNT_UITEST_ACCESS_TOKEN/.test(job) && /MNT_UITEST_REFRESH_TOKEN/.test(job);
}

function hasExactFailSlowExecution(job) {
  const activeJob = job;
  const expectedShards = [
    "preflight", "login-validation", "accessibility-id-parity", "critical-path", "messenger", "camera-capture",
    "audit-dynamic-today", "audit-dynamic-detail", "audit-dynamic-messenger", "audit-dynamic-login",
    "accessibility-standard", "accessibility-largest", "accessibility-dark", "dynamic-type-large", "dynamic-type-ax5",
  ];
  const declaration = /SHARD_MANIFEST=\(([^)]*)\)/.exec(activeJob);
  const declared = declaration?.[1].trim().split(/\s+/).filter(Boolean) ?? [];
  if (declared.length !== expectedShards.length || declared.some((name, index) => name !== expectedShards[index])) return false;

  const loop = /for\s+shard_name\s+in\s+"\$\{SHARD_MANIFEST\[@\]\}";\s*do([\s\S]*?)^[ \t]*done\s*\n[ \t]*timing_start\s+structured-result-verification/m.exec(activeJob);
  if (!loop) return false;
  const body = loop[1];
  const loopEnd = (loop.index ?? -1) + loop[0].length;
  const resultDeclaration = /result="\$RAW_RESULTS\/\$shard_name\.xcresult";\s*summary="\$ARTIFACTS\/\$shard_name-summary\.json";\s*tests="\$ARTIFACTS\/\$shard_name-tests\.json"/.exec(body);
  const setupFailure = (name, text) => new RegExp(`if\\s+!\\s+${name}[\\s\\S]{0,520}${text}[\\s\\S]{0,280}TEST_STATUS=1[\\s\\S]{0,240}timing_finish\\s+setup-failed[\\s\\S]{0,120}continue`).test(body);
  const verifier = /"\$MNT_IOS_NODE_BIN"\s+"\$ROOT\/scripts\/verify-xcresult-test-results\.mjs"\s+"\$\{VERIFY_ARGS\[@\]\}"\s+--swift-tests\s+"\$ROOT\/ios\/UITests"\s+\|\|\s+\{\s*TEST_STATUS=1;\s*verification_status=failed;\s*\}/.exec(activeJob);
  const finalCleanup = /if\s+!\s+clean_runtime;\s*then([\s\S]*?)^[ \t]*fi[\s\S]{0,1600}^[ \t]*trap\s+-\s+EXIT\s+INT\s+TERM/m.exec(activeJob);
  const finalExit = /exit\s+"\$TEST_STATUS"/.exec(activeJob);
  const verifierIndex = verifier?.index ?? -1;
  const cleanupIndex = finalCleanup?.index ?? -1;
  const finalExitIndex = finalExit?.index ?? -1;
  const processGroupTerms = activeJob.match(/kill\s+-TERM\s+--\s+"-\$test_pid"/g) ?? [];
  const processGroupKills = activeJob.match(/kill\s+-KILL\s+--\s+"-\$test_pid"/g) ?? [];
  const ownsShardProcessGroup = /python3\s+-c\s+'import os,sys;\s*os\.setsid\(\);\s*os\.execvp\(sys\.argv\[1\],\s*sys\.argv\[1:\]\)'[\s\S]{0,120}xcodebuild\s+test-without-building/.test(activeJob)
    && /wait\s+"\$test_pid"[\s\S]{0,300}kill\s+-0\s+--\s+"-\$test_pid"/.test(activeJob)
    && processGroupTerms.length >= 2 && processGroupKills.length >= 2
    && /kill\s+-KILL\s+--\s+"-\$test_pid"[\s\S]{0,260}for\s+_\s+in\s+\{1\.\.20\};\s*do\s+kill\s+-0\s+--\s+"-\$test_pid"[\s\S]{0,220}if\s+kill\s+-0\s+--\s+"-\$test_pid"[\s\S]{0,220}status=125/.test(activeJob);

  return resultDeclaration !== null
    && /for\s+shard_name\s+in\s+"\$\{SHARD_MANIFEST\[@\]\}";\s*do/.test(activeJob)
    && /if\s+!\s+configure_shard\s+"\$shard_name";\s*then[\s\S]{0,720}named shard manifest invalid[\s\S]{0,420}continue/.test(activeJob)
    && setupFailure('set_simulator_presentation\\s+"\\$SHARD_APPEARANCE"\\s+"\\$SHARD_CONTENT_SIZE"', "simulator presentation setup/readback failed")
    && setupFailure('mint_shard_session\\s+"\\$SHARD_FIXTURE_PROFILE"', "session mint failed")
    && /if\s+\[\[\s+"\$shard_name"\s+==\s+camera-capture\s+\]\]\s+&&\s+!\s+xcrun\s+simctl\s+privacy\s+"\$UUID"\s+reset\s+camera;\s*then[\s\S]{0,760}camera privacy reset failed[\s\S]{0,420}continue/.test(body)
    && /os\.setsid\(\)/.test(activeJob) && (activeJob.match(/kill\s+-TERM\s+--\s+"-\$test_pid"/g) ?? []).length >= 2 && (activeJob.match(/kill\s+-KILL\s+--\s+"-\$test_pid"/g) ?? []).length >= 2
    && /run_xcode_with_timeout\s+"\$shard_name"\s+"\$result"\s+"\$SHARD_TIMEOUT_SECONDS"\s+"\$\{SHARD_SELECTORS\[@\]\}"\s+\|\|\s+\{\s*shard_status=\$\?;\s*TEST_STATUS=1;\s*\}/.test(activeJob)
    && /xcresulttool\s+get\s+test-results\s+summary\s+--path\s+"\$result"[\s\S]{0,260}TEST_STATUS=1/.test(activeJob)
    && /xcresulttool\s+get\s+test-results\s+tests\s+--path\s+"\$result"[\s\S]{0,260}TEST_STATUS=1/.test(activeJob)
    && /VERIFY_ARGS\+=\(\s*--summary\s+"\$summary"\s+--tests\s+"\$tests"\s*\)/.test(activeJob)
    && verifierIndex > loopEnd
    && cleanupIndex > verifierIndex
    && /TEST_STATUS=1[\s\S]{0,160}cleanup_status=failed/.test(finalCleanup?.[1] ?? "")
    && finalExitIndex > cleanupIndex
    && verifier !== null && /timing_start\s+structured-result-verification[\s\S]{0,760}verify-xcresult-test-results[\s\S]{0,760}timing_start\s+runtime-cleanup[\s\S]{0,760}clean_runtime[\s\S]{0,1200}exit\s+"\$TEST_STATUS"/.test(activeJob)
    && /\.xcresult/.test(activeJob);
}

function hasStructuredResultVerification(job) {
  return hasExactFailSlowExecution(job);
}

function hasArtifactSecretScan(job) {
  const scan = /name:\s*Scan result artifacts for raw session material[\s\S]{0,180}id:\s*artifact-scan[\s\S]{0,180}if:\s*always\(\)[\s\S]{0,2200}/.exec(job)?.[0] ?? "";
  return scan.length > 0
    && /RAW_RESULTS="\$D\/raw-xcresults"; ARTIFACTS="\$D\/artifacts"/.test(job)
    && /install\s+-d\s+-m\s+700\s+"\$D"\s+"\$AUTH_DIR"\s+"\$PGDATA"\s+"\$RAW_RESULTS"\s+"\$ARTIFACTS"/.test(job)
    && /result="\$RAW_RESULTS\/\$shard_name\.xcresult"/.test(job)
    && !/result="\$ARTIFACTS\/\$shard_name\.xcresult"/.test(job)
    && /\[\[\s+-d\s+"\$UPLOAD_DIR"\s+\]\]\s+\|\|\s+exit\s+0/.test(scan)
    && /\[\[\s+!\s+-e\s+"\$UPLOAD_DIR"\/raw-xcresults\s+\]\]/.test(scan)
    && /find\s+"\$UPLOAD_DIR"\s+-name\s+'\*\.xcresult'\s+-print\s+-quit\s+\|\s+grep\s+-q\s+\./.test(scan)
    && /raw xcresult bundle entered upload tree/.test(scan)
    && /find\s+"\$UPLOAD_DIR"\s+-type\s+l\s+-print\s+-quit\s+\|\s+grep\s+-q\s+\./.test(scan)
    && /symlink entered upload tree/.test(scan)
    && /\[\[\s+-d\s+"\$RAW_RESULTS"\s+\]\]\s+\|\|\s+\{\s*echo\s+'missing private raw xcresult directory'/.test(scan)
    && /if\s+find\s+"\$UPLOAD_DIR"\s+-mindepth\s+1\s+-print\s+-quit\s+\|\s+grep\s+-q\s+\.\s*;\s*then/.test(scan)
    && /\[\[\s+-s\s+"\$SECRETS_FILE"\s+\]\]\s+\|\|\s+\{\s*echo\s+'artifacts exist without the owned raw-session scan source'/.test(scan)
    && /\[\[\s+-n\s+"\$secret_value"\s+\]\]\s+\|\|\s+continue/.test(scan)
    && /grep\s+-R\s+-a\s+-F\s+-q\s+--\s+"\$secret_value"\s+"\$UPLOAD_DIR"/.test(scan)
    && /test artifact contains raw session material/.test(scan);
}

function hasOwnedCleanup(job) {
  const scan = job.search(/name:\s*Scan result artifacts for raw session material[\s\S]{0,180}id:\s*artifact-scan[\s\S]{0,180}if:\s*always\(\)/);
  const upload = job.search(/name:\s*Upload test results[\s\S]{0,300}if:\s*always\(\)\s*&&\s*steps\.artifact-scan\.outcome\s*==\s*'success'[\s\S]{0,300}uses:\s*actions\/upload-artifact@/);
  const cleanup = job.search(/name:\s*Always prove cleanup of exact owned resources[\s\S]*if:\s*always\(\)/);
  return scan !== -1 && upload > scan && cleanup > upload
    && /path:\s*"\$\{\{ runner\.temp \}\}\/ios-ui-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}\/artifacts"/.test(job)
    && !/\$\{\{ env\.MNT_IOS_JOB_ROOT \}\}/.test(job.replace(/#.*$/gm, ""))
    && /BACKEND_COMMAND_FILE/.test(job)
    && /ps\s+-p\s+"\$BACKEND_PID"\s+-o\s+command=\s+>\s+"\$BACKEND_COMMAND_FILE"/.test(job)
    && /backend PID identity changed; refusing cross-process cleanup/.test(job)
    && /kill\s+-TERM/.test(job) && /kill\s+-KILL/.test(job) && /kill\s+-0/.test(job)
    && /pg_ctl"?\s+-D\s+"\$PGDATA"\s+-w\s+stop/.test(job) && /pg_ctl"?\s+-D\s+"\$PGDATA"\s+status/.test(job)
    && /simctl\s+delete\s+"\$UUID"/.test(job) && /simctl\s+list\s+devices\s+-j/.test(job)
    && /rm\s+-rf\s+"\$D"/.test(job) && /\[\[\s*!\s+-e\s+"\$D"\s+\]\]/.test(job);
}

function hasStrictAccessibility(files) {
  const fieldCase = stripSwiftCommentsAndStrings(files["ios/UITests/Support/FieldUITestCase.swift"] ?? "", false);
  const auditTests = stripSwiftCommentsAndStrings(files["ios/UITests/AccessibilityAuditUITests.swift"] ?? "", false);
  const dynamicType = extractFunctionBody(fieldCase, /func\s+assertDynamicTypeAccessibilitySupport\s*\(/);
  const nonDynamicType = extractFunctionBody(fieldCase, /func\s+assertNoNonDynamicTypeAccessibilityIssues\s*\(/);
  const issue = extractFunctionBody(fieldCase, /struct\s+DynamicTypeAuditIssue\b/);
  if (dynamicType === null || nonDynamicType === null || issue === null) return false;

  const continuationScope = (body) => /let\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*continueAfterFailure\b[\s\S]{0,160}continueAfterFailure\s*=\s*true[\s\S]{0,160}defer\s*\{\s*continueAfterFailure\s*=\s*\1\s*\}/.test(body);
  const exactLedger = [
    /performAccessibilityAudit\(for:\s*\.dynamicType\)\s*\{\s*issue\s+in/,
    /issue\.auditType\s*==\s*\.dynamicType/,
    /issue\.compactDescription\s*==\s*DynamicTypeAuditIssue\.compactDescription/,
    /issue\.detailedDescription\s*==\s*DynamicTypeAuditIssue\.detailedDescription/,
    /let\s+element\s*=\s*issue\.element/,
    /\$0\.identifier\s*==\s*element\.identifier\s*&&\s*\$0\.elementType\s*==\s*element\.elementType/,
    /observed\.append\(expected\)/,
    /return\s+false/,
  ].every((pattern) => pattern.test(dynamicType));
  const exactSetEquality = /XCTAssertEqual\(\s*observed\.sorted\(\)\s*,\s*expectedCompatibilityIssues\.sorted\(\)/.test(dynamicType);
  const auditBody = (name) => extractFunctionBody(
    auditTests,
    new RegExp(`func\\s+${name}\\s*\\(\\s*\\)\\s+async\\s+throws`),
  ) ?? "";
  const hasExactCompatibilityLedger = (body, expectedEntries) => {
    if ((body.match(/assertDynamicTypeAccessibilitySupport\s*\(/g) ?? []).length !== 1) return false;
    if (expectedEntries.length === 0) {
      return /assertDynamicTypeAccessibilitySupport\s*\(\s*\)/.test(body)
        && !/expectedCompatibilityIssues/.test(body);
    }
    const entries = /assertDynamicTypeAccessibilitySupport\s*\(\s*expectedCompatibilityIssues:\s*\[([\s\S]*?)\]\s*\)/.exec(body)?.[1] ?? "";
    return entries.replace(/\s+/g, "") === expectedEntries.map((entry) => `${entry},`).join("");
  };
  const exactAuditLedgers = hasExactCompatibilityLedger(
    auditBody("testTodayScreenPassesDynamicTypeAudit"),
    [
      ".staticText(AID.locationConsentTitle)",
      ".staticText(AID.locationConsentStateLabel)",
      ".staticText(AID.locationConsentStateValue)",
      ".staticText(AID.locationConsentCollectionLabel)",
      ".staticText(AID.locationConsentCollectionValue)",
      ".button(AID.locationConsentGrantButton)",
    ],
  ) && hasExactCompatibilityLedger(
    auditBody("testWorkOrderDetailPassesDynamicTypeAudit"),
    [
      ".staticText(AID.detailSymptomLabel)",
      ".staticText(AID.detailSymptomValue)",
    ],
  ) && hasExactCompatibilityLedger(auditBody("testMessengerScreenPassesDynamicTypeAudit"), [])
    && hasExactCompatibilityLedger(auditBody("testLoginScreenPassesDynamicTypeAudit"), []);
  return continuationScope(dynamicType) && continuationScope(nonDynamicType)
    && exactLedger && exactSetEquality && exactAuditLedgers
    && /try\s+app\.performAccessibilityAudit\(for:\s*\.all\.subtracting\(\.dynamicType\)\)/.test(nonDynamicType)
    && !/issueHandler|MNT_ACCESSIBILITY_DIAGNOSTIC|MNT_UITEST_AUDIT_STRICT/.test(fieldCase + auditTests)
    && (fieldCase.match(/performAccessibilityAudit\s*\(/g) ?? []).length === 2
    && !/performAccessibilityAudit\s*\(\s*for:\s*\.all\s*\)/.test(fieldCase)
    && /static\s+let\s+compactDescription\s*=\s*"Dynamic Type font sizes are partially unsupported"/.test(issue)
    && /static\s+let\s+detailedDescription\s*=\s*"User will not be able to change the font size of this SwiftUI\.AccessibilityNode"/.test(issue)
    && /static\s+func\s+staticText[\s\S]{0,160}\.staticText/.test(issue)
    && /static\s+func\s+button[\s\S]{0,160}\.button/.test(issue);
}

function hasDeterministicAccessibilityPresentations(files) {
  const workflow = files[".github/workflows/ios-ui-tests.yml"] ?? "";
  const fieldCase = stripSwiftCommentsAndStrings(files["ios/UITests/Support/FieldUITestCase.swift"] ?? "", false);
  const auditTests = stripSwiftCommentsAndStrings(files["ios/UITests/AccessibilityAuditUITests.swift"] ?? "");
  const runtimeTests = stripSwiftCommentsAndStrings(files["ios/UITests/DynamicTypeRuntimeUITests.swift"] ?? "");
  const views = stripSwiftCommentsAndStrings(files["ios/Sources/MaintenanceFieldApp/FieldViews.swift"] ?? "");
  const setPresentation = /set_simulator_presentation\s*\(\)\s*\{[\s\S]{0,680}xcrun\s+simctl\s+ui\s+"\$UUID"\s+appearance\s+"\$expected_appearance"[\s\S]{0,260}content_size\s+"\$expected_content_size"[\s\S]{0,300}actual_appearance="\$\(xcrun\s+simctl\s+ui\s+"\$UUID"\s+appearance\)"[\s\S]{0,240}actual_content_size="\$\(xcrun\s+simctl\s+ui\s+"\$UUID"\s+content_size\)"[\s\S]{0,240}\[\[\s+"\$actual_appearance"\s+==\s+"\$expected_appearance"\s+&&\s+"\$actual_content_size"\s+==\s+"\$expected_content_size"\s+\]\]/.test(workflow);
  const resetPresentation = /clean_runtime\s*\(\)\s*\{[\s\S]{0,1800}simctl\s+ui\s+"\$UUID"\s+appearance\s+light[\s\S]{0,180}content_size\s+large[\s\S]{0,300}actual_appearance="\$\(xcrun\s+simctl\s+ui\s+"\$UUID"\s+appearance[\s\S]{0,280}actual_content_size="\$\(xcrun\s+simctl\s+ui\s+"\$UUID"\s+content_size[\s\S]{0,300}\[\[\s+"\$actual_appearance"\s+==\s+light\s+&&\s+"\$actual_content_size"\s+==\s+large\s+\]\]/.test(workflow);
  const configure = /configure_shard\s*\(\)\s*\{([\s\S]*?)\n[ \t]*\}/.exec(workflow)?.[1] ?? "";
  const exactPresentation = /SHARD_APPEARANCE=light[\s\S]{0,120}SHARD_CONTENT_SIZE=large/.test(configure)
    && /accessibility-standard\)[\s\S]{0,520}testTodayScreenPassesNonDynamicAuditStandard/.test(configure)
    && /accessibility-largest\)[\s\S]{0,240}SHARD_CONTENT_SIZE=accessibility-extra-extra-extra-large/.test(configure)
    && /accessibility-dark\)[\s\S]{0,240}SHARD_APPEARANCE=dark/.test(configure)
    && /dynamic-type-large\)[\s\S]{0,360}testLargeDynamicTypeRuntimeContract/.test(configure)
    && /dynamic-type-ax5\)[\s\S]{0,260}SHARD_CONTENT_SIZE=accessibility-extra-extra-extra-large[\s\S]{0,360}testAccessibilityExtraExtraExtraLargeRuntimeContract/.test(configure);
  const appFactory = extractFunctionBody(fieldCase, /static\s+func\s+fieldUITestApp\s*\(/) ?? "";
  const noProcessPresentationMutation = !/-UIPreferredContentSizeCategoryName|XCUIDevice\.shared\.appearance\s*=/.test(fieldCase + auditTests + runtimeTests);
  const appFactoryIsPresentationFree = /app\.launchArguments\s*\+=\s*LaunchLocale\.arguments/.test(appFactory) && /MAINTENANCE_API_BASE_URL/.test(appFactory) && !/UIPreferredContentSize|XCUIDevice/.test(appFactory);
  const auditMethods = [
    "testTodayScreenPassesDynamicTypeAudit", "testWorkOrderDetailPassesDynamicTypeAudit", "testMessengerScreenPassesDynamicTypeAudit", "testLoginScreenPassesDynamicTypeAudit",
    "testTodayScreenPassesNonDynamicAuditStandard", "testTodayScreenPassesNonDynamicAuditLargestDynamicType", "testTodayScreenPassesNonDynamicAuditDarkMode", "testWorkOrderDetailPassesNonDynamicAuditStandard",
    "testMessengerScreenPassesNonDynamicAuditStandard", "testMessengerScreenPassesNonDynamicAuditLargestDynamicType", "testMessengerScreenPassesNonDynamicAuditDarkMode", "testLoginScreenPassesNonDynamicAuditStandard",
  ];
  const independentAudits = auditMethods.every((name) => {
    const body = extractFunctionBody(auditTests, new RegExp(`func\\s+${name}\\s*\\(\\s*\\)\\s+async\\s+throws`));
    return body !== null && (body.match(/assert(?:DynamicTypeAccessibilitySupport|NoNonDynamicTypeAccessibilityIssues)\s*\(/g) ?? []).length === 1 && !body.includes("app.terminate()");
  });
  const largeRuntime = extractFunctionBody(runtimeTests, /func\s+testLargeDynamicTypeRuntimeContract\s*\(\s*\)\s+async\s+throws/) ?? "";
  const accessibilityRuntime = extractFunctionBody(runtimeTests, /func\s+testAccessibilityExtraExtraExtraLargeRuntimeContract\s*\(\s*\)\s+async\s+throws/) ?? "";
  const runtimeContracts = /todayLocationConsentButton/.test(largeRuntime)
    && /sameHorizontalBand/.test(largeRuntime) && /frame\.intersects/.test(largeRuntime)
    && /todayLocationConsentCloseButton/.test(accessibilityRuntime) && /locationConsentGrantButton/.test(accessibilityRuntime)
    && /XCTAssertGreaterThanOrEqual\(app\.buttons\[AID\.locationConsentGrantButton\]\.frame\.height,\s*44\)/.test(accessibilityRuntime)
    && /XCTAssertGreaterThan\(timestamp\.frame\.minY,\s*body\.frame\.maxY/.test(accessibilityRuntime)
    && /app\.collectionViews\[AID\.todayLocationConsentSheet\]/.test(accessibilityRuntime)
    && /XCTAssertClearOfChrome/.test(accessibilityRuntime)
    && (runtimeTests.match(/func\s+test[A-Za-z0-9_]+\s*\(\s*\)\s+async\s+throws/g) ?? []).length === 2;
  const semanticSource = /Text\([^\n]*message\.body[^\n]*\)[\s\S]{0,180}\.font\(\.body\)[\s\S]{0,420}Text\([^\n]*formatted[^\n]*\)[\s\S]{0,180}\.font\(\.caption\)/.test(views)
    && /dynamicTypeSize\.isAccessibilitySize[\s\S]{0,480}VStack[\s\S]{0,900}HStack/.test(views)
    && !/\.font\(\.system\s*\(\s*size:|\.dynamicTypeSize\s*\(|\.environment\s*\(\\\.dynamicTypeSize/.test(views);
  return setPresentation && resetPresentation && exactPresentation && noProcessPresentationMutation && appFactoryIsPresentationFree
    && (auditTests.match(/func\s+test[A-Za-z0-9_]+\s*\(\s*\)\s+async\s+throws/g) ?? []).length === auditMethods.length
    && independentAudits && runtimeContracts && semanticSource;
}

function hasAdaptiveTodayLocationConsent(files) {
  const views = stripSwiftCommentsAndStrings(files["ios/Sources/MaintenanceFieldApp/FieldViews.swift"] ?? "", false);
  const today = extractFunctionBody(views, /struct\s+TodayListView\b/) ?? "";
  const detail = extractFunctionBody(views, /struct\s+WorkOrderDetailView\b/) ?? "";
  if (!today || !detail) return false;

  // Standard sizes retain the inline controls. Accessibility sizes move the
  // same complete section into a dedicated sheet so neither the List nor its
  // system chrome clips the consent state/action controls.
  const inlineAtNonAccessibilitySize = /if\s+dynamicTypeSize\.isAccessibilitySize\s*==\s*false\s*\{\s*LocationConsentSection\s*\(\s*viewModel:\s*viewModel\s*\)/.test(today);
  const accessibilityToolbarButton = /if\s+dynamicTypeSize\.isAccessibilitySize\s*\{[\s\S]{0,480}Button\s*\{\s*isLocationConsentPresented\s*=\s*true[\s\S]{0,320}accessibilityIdentifier\s*\(\s*FieldAccessibilityID\.todayLocationConsentButton\s*\)/.test(today);
  const dedicatedSheet = /\.sheet\s*\(\s*isPresented:\s*\$isLocationConsentPresented\s*\)\s*\{[\s\S]{0,960}NavigationStack\s*\{[\s\S]{0,520}Form\s*\{\s*LocationConsentSection\s*\(\s*viewModel:\s*viewModel\s*\)[\s\S]{0,640}Button\s*\{\s*isLocationConsentPresented\s*=\s*false[\s\S]{0,320}accessibilityIdentifier\s*\(\s*FieldAccessibilityID\.todayLocationConsentCloseButton\s*\)/.test(today);
  const stableIdentifiers = /todayLocationConsentButton/.test(files["ios/Sources/MaintenanceFieldApp/FieldAccessibilityID.swift"] ?? "")
    && /todayLocationConsentCloseButton/.test(files["ios/Sources/MaintenanceFieldApp/FieldAccessibilityID.swift"] ?? "");
  const detailRetainsFullSection = /Form\s*\{\s*LocationConsentSection\s*\(\s*viewModel:\s*viewModel\s*\)/.test(detail);

  return inlineAtNonAccessibilitySize
    && accessibilityToolbarButton
    && dedicatedSheet
    && stableIdentifiers
    && detailRetainsFullSection
    && !/DisclosureGroup/.test(today);
}

function hasUnobscuredTabContentHost(files) {
  const views = stripSwiftCommentsAndStrings(files["ios/Sources/MaintenanceFieldApp/FieldViews.swift"] ?? "");
  const tabs = extractFunctionBody(views, /struct\s+FieldAuthenticatedTabs\b/) ?? "";
  const wrapper = extractFunctionBody(views, /private\s+struct\s+UnobscuredTabContent<Content:\s*View>:\s*View/) ?? "";
  const probe = extractFunctionBody(views, /private\s+struct\s+TabBarContentLayoutGuideProbe:\s*UIViewControllerRepresentable/) ?? "";
  const sensor = extractFunctionBody(views, /private\s+final\s+class\s+TabBarContentLayoutGuideSensor:\s*UIView/) ?? "";
  const controller = extractFunctionBody(views, /private\s+final\s+class\s+TabBarContentLayoutGuideProbeController:\s*UIViewController/) ?? "";
  const report = extractFunctionBody(controller, /private\s+func\s+reportContentInsetsIfAvailable\s*\(\s*\)/) ?? "";
  const install = extractFunctionBody(controller, /private\s+func\s+installContentLayoutSensorIfNeeded\s*\(/) ?? "";
  const remove = extractFunctionBody(controller, /private\s+func\s+removeContentLayoutSensor\s*\(\s*\)/) ?? "";
  const invalidate = extractFunctionBody(controller, /func\s+invalidate\s*\(\s*\)/) ?? "";
  const wrappers = [...tabs.matchAll(/UnobscuredTabContent\s*\{\s*NavigationStack\s*\{/g)].length === 4;
  const guideEdges = ["top", "leading", "bottom", "trailing"].every((edge) => new RegExp(`sensor\\.${edge}Anchor\\.constraint\\(equalTo:\\s*tabBarController\\.contentLayoutGuide\\.${edge}Anchor\\)`).test(install));
  const guideDrivenContentFrame = /ZStack\s*\{[\s\S]{0,600}TabBarContentLayoutGuideProbe[\s\S]{0,600}GeometryReader\s*\{\s*geometry\s+in[\s\S]{0,200}content\s*\.frame\s*\(/.test(wrapper)
    && /geometry\.size\.width\s*-\s*contentInsets\.leading\s*-\s*contentInsets\.trailing/.test(wrapper)
    && /geometry\.size\.height\s*-\s*contentInsets\.top\s*-\s*contentInsets\.bottom/.test(wrapper)
    && /alignment:\s*\.topLeading/.test(wrapper)
    && /\.offset\(x:\s*contentInsets\.leading,\s*y:\s*contentInsets\.top\)/.test(wrapper);
  const forbidden = /UIHostingController|selectedViewController\b|value\s*\(forKey:|NSClassFromString|object_getIvar|recursiveDescription|subviews\b|traitOverrides|setNeedsLayout|additionalSafeAreaInsets|contentInset\b|safeAreaInset\s*\(\s*edge:\s*\.bottom|constraint\s*\(equalToConstant:|\.frame\s*\(\s*height:|\bview\.frame\s*=(?!=)|tabBarController\.tabBar\.bounds\.height/.test(views);
  return wrappers
    && guideDrivenContentFrame
    && /func\s+makeUIViewController[\s\S]{0,220}TabBarContentLayoutGuideProbeController\(onInsetsChange:\s*onInsetsChange\)/.test(probe)
    && /static\s+func\s+dismantleUIViewController[\s\S]{0,220}invalidate\s*\(\s*\)/.test(probe)
    && /override\s+func\s+layoutSubviews[\s\S]{0,120}onLayout\?\(\)/.test(sensor)
    && /override\s+func\s+didMoveToWindow[\s\S]{0,120}onLayout\?\(\)/.test(sensor)
    && /private\s+var\s+pendingMeasurementTask:\s*Task<Void,\s*Never>\?/.test(controller)
    && /guard\s+pendingMeasurementTask\s*==\s*nil\s+else\s*\{\s*return\s*\}/.test(controller)
    && /await\s+Task\.yield\(\)/.test(controller)
    && /pendingMeasurementTask\s*=\s*nil[\s\S]{0,180}reportContentInsetsIfAvailable/.test(controller)
    && /override\s+func\s+didMove\s*\(\s*toParent[\s\S]{0,200}if\s+parent\s*==\s*nil\s*\{\s*invalidate\s*\(\s*\)/.test(controller)
    && /viewDidLayoutSubviews[\s\S]{0,120}requestMeasurement/.test(controller)
    && /viewSafeAreaInsetsDidChange[\s\S]{0,120}requestMeasurement/.test(controller)
    && /viewWillTransition[\s\S]{0,300}requestMeasurement/.test(controller)
    && /let\s+window\s*=\s*viewIfLoaded\?\.window[\s\S]{0,260}tabBarController\.view\.window\s*===\s*window/.test(report)
    && /sensorSuperview\.convert\(sensor\.frame,\s*to:\s*view\)/.test(report)
    && /effectiveUserInterfaceLayoutDirection/.test(report)
    && /leading:\s*layoutDirection\s*==\s*\.rightToLeft\s*\?\s*right\s*:\s*left/.test(report)
    && /trailing:\s*layoutDirection\s*==\s*\.rightToLeft\s*\?\s*left\s*:\s*right/.test(report)
    && guideEdges
    && /contentLayoutSensor\?\.onLayout\s*=\s*nil[\s\S]{0,120}contentLayoutSensor\?\.removeFromSuperview/.test(remove)
    && /pendingMeasurementTask\?\.cancel\(\)[\s\S]{0,100}removeContentLayoutSensor\(\)[\s\S]{0,100}onInsetsChange\s*=\s*nil/.test(invalidate)
    && !forbidden;
}

function hasSemanticMessengerMessagesHeader(files) {
  const views = files["ios/Sources/MaintenanceFieldApp/FieldViews.swift"] ?? "";
  const messenger = extractFunctionBody(views, /struct\s+MessengerTabView\b/) ?? "";
  return /Section\s*\{[\s\S]{0,180}Text\s*\(\s*"messenger_messages"\s*\)[\s\S]{0,300}accessibilityAddTraits\s*\(\s*\.isHeader\s*\)[\s\S]{0,2200}ForEach\s*\(\s*messages\s*\)/.test(messenger);
}

function hasContrastStableCapsules(files) {
  const views = stripSwiftCommentsAndStrings(files["ios/Sources/MaintenanceFieldApp/FieldViews.swift"] ?? "");
  const messageRow = extractFunctionBody(views, /struct\s+MessengerMessageRow:\s*View/) ?? "";
  const fieldChip = extractFunctionBody(views, /struct\s+FieldChip:\s*View/) ?? "";
  const stableBackground = /\.background\(\s*Color\.primary\.opacity\(\s*0\.12\s*\),\s*in:\s*Capsule\(\s*\)\s*\)/;
  return stableBackground.test(messageRow)
    && stableBackground.test(fieldChip)
    && /\.font\(\s*\.caption\s*\)[\s\S]{0,100}\.foregroundStyle\(\s*\.primary\s*\)[\s\S]{0,220}\.background\(/.test(messageRow)
    && !/\.(?:ultraThin|thin|regular|thick|ultraThick)Material\b/.test(messageRow + fieldChip);
}

function extractBalancedBlock(source, openingBrace) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = openingBrace; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"') {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openingBrace + 1, index);
    }
  }
  return null;
}

function extractEnumBody(source, enumName) {
  const declaration = new RegExp(`(?:public\\s+)?enum\\s+${enumName}\\b`).exec(source);
  if (!declaration) return null;
  const openingBrace = source.indexOf("{", declaration.index + declaration[0].length);
  return openingBrace === -1 ? null : extractBalancedBlock(source, openingBrace);
}

function extractFunctionBody(source, declaration) {
  const match = declaration.exec(source);
  if (!match) return null;
  const openingBrace = source.indexOf("{", match.index + match[0].length);
  return openingBrace === -1 ? null : extractBalancedBlock(source, openingBrace);
}

function stripSwiftCommentsAndStrings(source, stripStrings = true) {
  const output = source.split("");
  const blank = (index) => {
    if (source[index] !== "\n" && source[index] !== "\r") output[index] = " ";
  };
  let index = 0;
  let blockCommentDepth = 0;
  let stringDelimiter = null;

  while (index < source.length) {
    if (blockCommentDepth > 0) {
      if (source.startsWith("/*", index)) {
        blank(index);
        blank(index + 1);
        blockCommentDepth += 1;
        index += 2;
      } else if (source.startsWith("*/", index)) {
        blank(index);
        blank(index + 1);
        blockCommentDepth -= 1;
        index += 2;
      } else {
        blank(index);
        index += 1;
      }
      continue;
    }

    if (stringDelimiter !== null) {
      const { closing, rawHashes } = stringDelimiter;
      if (source.startsWith(closing, index)) {
        if (stripStrings) {
          for (let offset = 0; offset < closing.length; offset += 1) blank(index + offset);
        }
        index += closing.length;
        stringDelimiter = null;
      } else if (source.startsWith(`\\${"#".repeat(rawHashes)}`, index)) {
        const escapeLength = 2 + rawHashes;
        if (stripStrings) {
          for (let offset = 0; offset < escapeLength && index + offset < source.length; offset += 1) {
            blank(index + offset);
          }
        }
        index += escapeLength;
      } else {
        if (stripStrings) blank(index);
        index += 1;
      }
      continue;
    }

    if (source.startsWith("//", index)) {
      while (index < source.length && source[index] !== "\n") {
        blank(index);
        index += 1;
      }
      continue;
    }
    if (source.startsWith("/*", index)) {
      blank(index);
      blank(index + 1);
      blockCommentDepth = 1;
      index += 2;
      continue;
    }

    let rawHashes = 0;
    while (source[index + rawHashes] === "#") rawHashes += 1;
    const quoteIndex = index + rawHashes;
    if (source[quoteIndex] === '"') {
      const multiline = source.startsWith('"""', quoteIndex);
      const quoteLength = multiline ? 3 : 1;
      const openingLength = rawHashes + quoteLength;
      if (stripStrings) {
        for (let offset = 0; offset < openingLength; offset += 1) blank(index + offset);
      }
      stringDelimiter = {
        closing: `${'"'.repeat(quoteLength)}${"#".repeat(rawHashes)}`,
        rawHashes,
      };
      index += openingLength;
      continue;
    }

    index += 1;
  }

  return output.join("");
}

function plistKeychainAccessGroups(source) {
  const match = source.match(/<key>keychain-access-groups<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!match) return [];
  return [...match[1].matchAll(/<string>([^<]+)<\/string>/g)].map((entry) => entry[1].trim());
}

function hasSharedKeychainEntitlementContract(files) {
  const expectedGroup = "$(AppIdentifierPrefix)com.maintenance.field.shared";
  const appGroups = plistKeychainAccessGroups(files["ios/Config/MaintenanceFieldApp.entitlements"] ?? "");
  const seederGroups = plistKeychainAccessGroups(files["ios/Config/MaintenanceFieldUITestSeeder.entitlements"] ?? "");
  const project = files["ios/project.yml"] ?? "";
  const config = files["ios/Config/App.xcconfig"] ?? "";
  const seederTarget = /MaintenanceFieldUITestSeeder:\s*\n\s*type:\s*application\b[\s\S]*?\n\s{2}(?=\S|schemes:)/.exec(project)?.[0] ?? "";
  const uiTarget = /MaintenanceFieldUITests:\s*\n\s*type:\s*bundle\.ui-testing\b[\s\S]*?\n\s{2}(?=\S|schemes:)/.exec(project)?.[0] ?? "";
  return appGroups.length === 1
    && seederGroups.length === 1
    && appGroups[0] === expectedGroup
    && seederGroups[0] === expectedGroup
    && (project.match(/CODE_SIGN_ENTITLEMENTS:\s*Config\/MaintenanceFieldApp\.entitlements/g) ?? []).length === 1
    && (project.match(/CODE_SIGN_ENTITLEMENTS:\s*Config\/MaintenanceFieldUITestSeeder\.entitlements/g) ?? []).length === 1
    && /-\s*path:\s*Sources\/MaintenanceFieldUITestSeeder\b/.test(seederTarget)
    && /PRODUCT_BUNDLE_IDENTIFIER:\s*"\$\(MNT_IOS_BUNDLE_ID\)\.UITestSeeder"/.test(seederTarget)
    && /-\s*target:\s*MaintenanceFieldUITestSeeder\b/.test(uiTarget)
    && !/CODE_SIGN_ENTITLEMENTS:\s*Config\/MaintenanceFieldUITests\.entitlements/.test(uiTarget)
    && !/MaintenanceFieldUITests\.entitlements/.test(project)
    && /configFiles:\s*\n\s*Debug:\s*Config\/App\.xcconfig\s*\n\s*Release:\s*Config\/App\.xcconfig/.test(project)
    && /^CODE_SIGN_STYLE\s*=\s*Manual\s*$/m.test(config)
    && /^CODE_SIGNING_REQUIRED\s*=\s*YES\s*$/m.test(config)
    && /^CODE_SIGNING_ALLOWED\s*=\s*YES\s*$/m.test(config)
    && /^CODE_SIGN_IDENTITY\s*=\s*-\s*$/m.test(config);
}

function hasDefaultSharedKeychainResolution(files) {
  const persistence = files["ios/Sources/MaintenanceFieldCore/PersistenceStores.swift"] ?? "";
  const productionBody = extractFunctionBody(
    persistence,
    /public\s+static\s+func\s+resolveShared\s*\([\s\S]*?\n\s*\)\s*->\s*String\?\s*/,
  );
  const addProbe = extractFunctionBody(persistence, /public\s+func\s+addProbe\s*\(/);
  const deleteProbe = extractFunctionBody(persistence, /public\s+func\s+deleteProbe\s*\(/);
  const helper = files["ios/Sources/MaintenanceFieldUITestSeeder/UITestSeederApp.swift"] ?? "";
  const uiTestSupport = files["ios/UITests/Support/RealSessionSeed.swift"] ?? "";
  if (productionBody === null || addProbe === null || deleteProbe === null) return false;
  const addSucceeded = productionBody.search(/guard\s+let\s+result\s*=\s*try\?\s*probe\.addProbe/);
  const conditionalCleanup = productionBody.search(/defer\s*\{[\s\S]{0,360}do\s*\{[\s\S]{0,160}try\s+probe\.deleteProbe[\s\S]{0,160}catch\s*\{[\s\S]{0,160}reportCleanupFailure\s*\(\s*KeychainAccessGroupProbeCleanupFailure\s*\(\s*error:\s*error\s*\)\s*\)/);
  return addSucceeded !== -1
    && conditionalCleanup > addSucceeded
    && productionBody.includes("UUID().uuidString.lowercased()")
    && productionBody.includes('granted == suffix || granted.hasSuffix(".\\(suffix)")')
    && /SecItemAdd\s*\(/.test(addProbe)
    && /kSecReturnAttributes\s+as\s+String:\s*true/.test(addProbe)
    && (addProbe.match(/kSecAttrAccessGroup/g) ?? []).length === 1
    && /guard\s+status\s*==\s*errSecSuccess\s+else\s*\{[\s\S]{0,240}throw/.test(addProbe)
    && /SecItemDelete\s*\(/.test(deleteProbe)
    && /status\s*==\s*errSecSuccess\s*\|\|\s*status\s*==\s*errSecItemNotFound/.test(deleteProbe)
    && /public\s+struct\s+KeychainAccessGroupProbeCleanupFailure:\s*Sendable,\s*Equatable[\s\S]{0,480}errorDomain\s*=\s*nsError\.domain[\s\S]{0,160}errorCode\s*=\s*nsError\.code/.test(persistence)
    && /reportCleanupFailure:\s*KeychainAccessGroupProbeCleanupFailureReporter\s*=\s*\{\s*failure\s+in[\s\S]{0,320}NSLog\s*\([\s\S]{0,240}failure\.errorDomain[\s\S]{0,120}failure\.errorCode/.test(persistence)
    && !/try\?\s*probe\.deleteProbe/.test(productionBody)
    && !/preconditionFailure|fatalError|try!/.test(productionBody + addProbe + deleteProbe)
    && helper.includes("KeychainAccessGroup.resolveShared(suffix: sharedGroupSuffix)")
    && helper.includes("KeychainSessionTokenStore(")
    && helper.includes("SecKeychainAccess(accessGroup: accessGroup)")
    && !/import\s+Security\b|\bSecItem\w*\b|\bkSecAttrAccessGroup\b/.test(uiTestSupport);
}

function hasMainActorUiAutomationContract(files) {
  const field = stripSwiftCommentsAndStrings(files["ios/UITests/Support/FieldUITestCase.swift"] ?? "");
  const seeder = stripSwiftCommentsAndStrings(files["ios/UITests/Support/RealSessionSeed.swift"] ?? "");
  const preflight = stripSwiftCommentsAndStrings(files["ios/UITests/PreflightUITests.swift"] ?? "");
  const login = stripSwiftCommentsAndStrings(files["ios/UITests/LoginValidationUITests.swift"] ?? "");
  const declaration = /@MainActor\s+(?:final\s+)?class\s+FieldUITestCase\s*:\s*XCTestCase\b/.exec(field);
  if (!declaration) return false;
  const openingBrace = field.indexOf("{", declaration.index + declaration[0].length);
  const body = openingBrace === -1 ? null : extractBalancedBlock(field, openingBrace);
  if (body === null) return false;

  const setupBody = extractFunctionBody(body, /override\s+func\s+setUpWithError\s*\(\s*\)\s+throws\b/);
  const teardownBody = extractFunctionBody(body, /override\s+func\s+tearDownWithError\s*\(\s*\)\s+throws\b/);
  const synchronousSetup = setupBody !== null
    && /\btry\s+super\.setUpWithError\s*\(\s*\)/.test(setupBody)
    && /\btry\s+RealSessionSeed\.seed\s*\(\s*tokens\s*\)/.test(setupBody);
  const synchronousTeardown = teardownBody !== null
    && /\btry\s+RealSessionSeed\.clear\s*\(\s*\)/.test(teardownBody)
    && /\btry\s+super\.tearDownWithError\s*\(\s*\)/.test(teardownBody);
  const hasAsyncLifecycle = /override\s+func\s+(?:setUp|tearDown)(?:WithError)?\s*\([^)]*\)\s+async\b/.test(body);

  return synchronousSetup
    && synchronousTeardown
    && !hasAsyncLifecycle
    && /@MainActor\s+enum\s+RealSessionSeed\b/.test(seeder)
    && /@MainActor\s+final\s+class\s+PreflightUITests\s*:\s*XCTestCase\b/.test(preflight)
    && /@MainActor\s+final\s+class\s+LoginValidationUITests\s*:\s*XCTestCase\b/.test(login);
}

function hasBoundedExactWorkOrderScroll(files) {
  const field = stripSwiftCommentsAndStrings(files["ios/UITests/Support/FieldUITestCase.swift"] ?? "");
  const activationPoint = extractFunctionBody(
    field,
    /@MainActor\s+func\s+workOrderRowActivationPoint\s*\(\s*in\s+app:\s*XCUIApplication,\s*row:\s*XCUIElement,\s*list:\s*XCUIElement\s*\)\s*->\s*XCUICoordinate\?/,
  );
  const helper = extractFunctionBody(
    field,
    /@MainActor\s+func\s+scrollToWorkOrderRow\s*\(\s*in\s+app:\s*XCUIApplication,\s*id:\s*String,\s*timeout:\s*TimeInterval\s*=\s*60,\s*maxSwipes:\s*Int\s*=\s*48\s*\)\s*->\s*XCUIElement\?/,
  );
  if (activationPoint === null || helper === null) return false;

  const boundedPhases = (helper.match(/for\s+_\s+in\s+0\s*\.\.<\s*maxSwipes/g) ?? []).length >= 2;
  const timedRowProbes = helper.match(/row\.waitForExistence\s*\(/g) ?? [];
  const safeActivationProbes = helper.match(/workOrderRowActivationPoint\s*\(\s*in:\s*app\s*,\s*row:\s*row\s*,\s*list:\s*list\s*\)\s*!=\s*nil/g) ?? [];
  const geometryClipsChrome = /guard\s+row\.exists\s*,\s*row\.isHittable\s*,\s*list\.exists\s*,\s*row\.frame\.height\s*>\s*0\s+else\s*\{\s*return\s+nil\s*\}/.test(activationPoint)
    && /let\s+navigationBar\s*=\s*app\.navigationBars\.firstMatch/.test(activationPoint)
    && /if\s+navigationBar\.exists\s*\{/.test(activationPoint)
    && /visibleTop\s*=\s*max\s*\(\s*viewport\.minY\s*,\s*navigationBar\.frame\.maxY\s*\)/.test(activationPoint)
    && /let\s+tabBar\s*=\s*app\.tabBars\.firstMatch/.test(activationPoint)
    && /if\s+tabBar\.exists\s*\{/.test(activationPoint)
    && /let\s+tabChromeTop\s*=\s*tabBar\.frame\.minY\s*-\s*tabBar\.frame\.height/.test(activationPoint)
    && /visibleBottom\s*=\s*min\s*\(\s*viewport\.maxY\s*,\s*tabChromeTop\s*\)/.test(activationPoint)
    && /let\s+center\s*=\s*CGPoint\s*\(\s*x:\s*row\.frame\.midX\s*,\s*y:\s*row\.frame\.midY\s*\)/.test(activationPoint)
    && /guard\s+viewport\.contains\s*\(\s*center\s*\)\s+else\s*\{\s*return\s+nil\s*\}/.test(activationPoint)
    && /return\s+row\.coordinate\s*\(\s*withNormalizedOffset:\s*CGVector\s*\(\s*dx:\s*0\.5\s*,\s*dy:\s*0\.5\s*\)\s*\)/.test(activationPoint)
    && !/row\.frame\.intersection\s*\(\s*viewport\s*\)/.test(activationPoint);
  return geometryClipsChrome
    && /let\s+row\s*=\s*app\.buttons\[AID\.workOrderRow\s*\(\s*id\s*\)\]/.test(helper)
    && /let\s+deadline\s*=\s*Date\s*\(\s*\)\.addingTimeInterval\s*\(\s*timeout\s*\)/.test(helper)
    && /let\s+initialProbe\s*=\s*min\s*\(\s*timeout\s*,\s*2\s*\)/.test(helper)
    && /let\s+rowAppeared\s*=\s*row\.waitForExistence\s*\(\s*timeout:\s*initialProbe\s*\)/.test(helper)
    && /if\s+rowAppeared\s*,\s*workOrderRowActivationPoint\s*\(\s*in:\s*app\s*,\s*row:\s*row\s*,\s*list:\s*list\s*\)\s*!=\s*nil\s*\{\s*return\s+row\s*\}/.test(helper)
    && /let\s+list\s*=\s*app\.collectionViews\[AID\.todayList\]/.test(helper)
    && /guard\s+list\.waitForExistence\s*\(/.test(helper)
    && /let\s+topSentinel\s*=\s*app\.staticTexts\[KO\.locationConsentTitle\]/.test(helper)
    && /topSentinel\.exists[\s\S]{0,80}topSentinel\.isHittable/.test(helper)
    && /list\.swipeDown\s*\(\s*\)/.test(helper)
    && /coordinate\s*\(\s*withNormalizedOffset:/.test(helper)
    && /\.press\s*\(\s*forDuration:[\s\S]{0,100}thenDragTo:/.test(helper)
    && boundedPhases
    // Timed XPath-like hierarchy queries are only permitted for the initial
    // materialization probe. Every post-gesture exact target check must be a
    // synchronous settled-state probe or long Dynamic-Type scans fail fast.
    && timedRowProbes.length === 1
    && safeActivationProbes.length === 4
    && !/if\s+row\.exists\s*,\s*row\.isHittable\s*\{\s*return\s+row\s*\}/.test(helper)
    && /list\.swipeDown\s*\(\s*\)[\s\S]{0,240}workOrderRowActivationPoint\s*\(\s*in:\s*app\s*,\s*row:\s*row\s*,\s*list:\s*list\s*\)\s*!=\s*nil/.test(helper)
    && /thenDragTo:\s*dragEnd\s*\)[\s\S]{0,1500}workOrderRowActivationPoint\s*\(\s*in:\s*app\s*,\s*row:\s*row\s*,\s*list:\s*list\s*\)\s*!=\s*nil/.test(helper);
}

function hasBoundedExactElementScroll(files) {
  const field = stripSwiftCommentsAndStrings(files["ios/UITests/Support/FieldUITestCase.swift"] ?? "");
  const audit = stripSwiftCommentsAndStrings(files["ios/UITests/AccessibilityAuditUITests.swift"] ?? "");
  const messenger = stripSwiftCommentsAndStrings(files["ios/UITests/MessengerUITests.swift"] ?? "");
  const helper = extractFunctionBody(
    field,
    /@MainActor\s+func\s+scrollToElement\s*\(\s*_\s+element:\s*XCUIElement,\s*in\s+container:\s*XCUIElement,\s*topSentinel:\s*XCUIElement,\s*timeout:\s*TimeInterval\s*=\s*15,\s*maxSwipes:\s*Int\s*=\s*16\s*\)\s*->\s*XCUIElement\?/,
  );
  if (helper === null) return false;

  const boundedPhases = (helper.match(/for\s+_\s+in\s+0\s*\.\.<\s*maxSwipes/g) ?? []).length >= 2;
  const exactReturns = helper.match(/return\s+element\b/g) ?? [];
  const timedElementProbes = helper.match(/element\.waitForExistence\s*\(/g) ?? [];
  const synchronousElementReturns = helper.match(/if\s+element\.exists\s*,\s*element\.isHittable\s*\{\s*return\s+element\s*\}/g) ?? [];
  return /let\s+deadline\s*=\s*Date\s*\(\s*\)\.addingTimeInterval\s*\(\s*timeout\s*\)/.test(helper)
    && /let\s+initialProbe\s*=\s*min\s*\(\s*timeout\s*,\s*2\s*\)/.test(helper)
    && /if\s+element\.waitForExistence\s*\(\s*timeout:\s*initialProbe\s*\)\s*,\s*element\.isHittable\s*\{\s*return\s+element\s*\}/.test(helper)
    && /guard\s+container\.waitForExistence\s*\(/.test(helper)
    && /topSentinel\.exists[\s\S]{0,80}topSentinel\.isHittable/.test(helper)
    && /container\.swipeDown\s*\(\s*\)/.test(helper)
    // Anchor in the interior trailing gutter, outside a focused multiline
    // editor, both system-edge gesture regions, and the scroll-indicator strip.
    && /let\s+origin\s*=\s*container\.coordinate\s*\(\s*withNormalizedOffset:\s*\.zero\s*\)/.test(helper)
    && /let\s+trailingGutterX\s*=\s*max\s*\(\s*container\.frame\.width\s*\*\s*0\.9\s*,\s*8\s*\)/.test(helper)
    && /let\s+trailingGutterX\s*=\s*max\s*\(\s*container\.frame\.width\s*\*\s*0\.9\s*,\s*8\s*\)/.test(audit)
    && /let\s+trailingGutterX\s*=\s*max\s*\(\s*list\.frame\.width\s*\*\s*0\.9\s*,\s*8\s*\)/.test(messenger)
    && /let\s+dragStart\s*=\s*origin\.withOffset\s*\(\s*CGVector\s*\(\s*dx:\s*trailingGutterX\s*,\s*dy:\s*container\.frame\.height\s*\*\s*0\.50\s*\)\s*\)/.test(helper)
    && /let\s+dragEnd\s*=\s*origin\.withOffset\s*\(\s*CGVector\s*\(\s*dx:\s*trailingGutterX\s*,\s*dy:\s*container\.frame\.height\s*\*\s*0\.28\s*\)\s*\)/.test(helper)
    && !/CGVector\s*\(\s*dx:\s*0\.5\s*,\s*dy:/.test(helper)
    && /\.press\s*\(\s*forDuration:[\s\S]{0,100}thenDragTo:/.test(helper)
    && boundedPhases
    && exactReturns.length === 4
    && timedElementProbes.length === 1
    && synchronousElementReturns.length === 3
    && /container\.swipeDown\s*\(\s*\)[\s\S]{0,180}if\s+element\.exists\s*,\s*element\.isHittable\s*\{\s*return\s+element\s*\}/.test(helper)
    && /thenDragTo:\s*dragEnd\s*\)[\s\S]{0,380}if\s+element\.exists\s*,\s*element\.isHittable\s*\{\s*return\s+element\s*\}/.test(helper);
}

function hasDetailLazyControlScroll(files) {
  const field = stripSwiftCommentsAndStrings(files["ios/UITests/Support/FieldUITestCase.swift"] ?? "");
  const views = stripSwiftCommentsAndStrings(files["ios/Sources/MaintenanceFieldApp/FieldViews.swift"] ?? "");
  const critical = stripSwiftCommentsAndStrings(files["ios/UITests/FieldCriticalPathUITests.swift"] ?? "");
  const camera = stripSwiftCommentsAndStrings(files["ios/UITests/CameraCaptureUITests.swift"] ?? "");
  const detailStart = views.indexOf("struct WorkOrderDetailView");
  const detailEnd = views.indexOf("struct LocationConsentSection", detailStart);
  const detailView = detailStart === -1 || detailEnd === -1 ? "" : views.slice(detailStart, detailEnd);
  const detailHelper = extractFunctionBody(
    field,
    /func\s+scrollToDetailElement\s*\(\s*_\s+element:\s*XCUIElement,\s*timeout:\s*TimeInterval\s*=\s*15,\s*maxSwipes:\s*Int\s*=\s*16\s*\)\s*->\s*XCUIElement\?/,
  );
  if (detailHelper === null) return false;

  return hasBoundedExactElementScroll(files)
    // The toolbar back control stays mounted while the full-screen detail's
    // lazy Form materializes. A Form row is not a stable normalization anchor.
    && /scrollToElement\s*\(\s*element\s*,\s*in:\s*app\.descendants\s*\(\s*matching:\s*\.any\s*\)\[AID\.detailView\]\s*,\s*topSentinel:\s*app\.buttons\[AID\.detailBackButton\]/.test(detailHelper)
    && /\.scrollDismissesKeyboard\s*\(\s*\.immediately\s*\)/.test(detailView)
    && (critical.match(/scrollToDetailElement\s*\(\s*app\.buttons\[AID\.detailStartWorkButton\]\s*\)/g) ?? []).length === 1
    && (critical.match(/scrollToDetailElement\s*\(\s*app\.buttons\[AID\.detailSubmitReportButton\]\s*\)/g) ?? []).length === 2
    && (camera.match(/scrollToDetailElement\s*\(\s*app\.buttons\[AID\.detailCaptureEvidenceButton\]\s*\)/g) ?? []).length === 1;
}

function hasActionableDetailReadiness(files) {
  const field = stripSwiftCommentsAndStrings(files["ios/UITests/Support/FieldUITestCase.swift"] ?? "");
  const helper = extractFunctionBody(
    field,
    /func\s+openSeededWorkOrder\s*\(\s*fixtureKey:\s*String,\s*timeout:\s*TimeInterval\s*=\s*60\s*\)\s+throws/,
  );
  if (helper === null) return false;

  return /let\s+detail\s*=\s*app\.descendants\s*\(\s*matching:\s*\.any\s*\)\[AID\.detailView\]/.test(helper)
    && /let\s+back\s*=\s*app\.buttons\[AID\.detailBackButton\]/.test(helper)
    && /let\s+list\s*=\s*app\.collectionViews\[AID\.todayList\]/.test(helper)
    && /guard\s+let\s+activationPoint\s*=\s*workOrderRowActivationPoint\s*\(\s*in:\s*app\s*,\s*row:\s*row\s*,\s*list:\s*list\s*\)\s+else/.test(helper)
    && /activationPoint\.tap\s*\(\s*\)/.test(helper)
    && !/row\.coordinate\s*\([\s\S]{0,100}dy:\s*0\.20/.test(helper)
    && !/\brow\.tap\s*\(\s*\)/.test(helper)
    && /detail\.waitForExistence\s*\(/.test(helper)
    && /back\.waitForExistence\s*\(/.test(helper)
    && /back\.isHittable/.test(helper)
    && !/detail\.isHittable/.test(helper);
}

function hasDecodedTodayPreflight(files) {
  const preflight = stripSwiftCommentsAndStrings(files["ios/UITests/PreflightUITests.swift"] ?? "");
  const restoreProof = extractFunctionBody(preflight, /func\s+testSeederRestoresThenClearsRealSession\s*\(\s*\)\s+throws\b/);
  if (restoreProof === null) return false;

  return /restoredApp\.tabBars\.buttons\[KO\.todayTitle\]\.waitForExistence\s*\(\s*timeout:\s*20\s*\)/.test(restoreProof)
    && /restoredApp\.collectionViews\[AID\.todayList\]\.waitForExistence\s*\(\s*timeout:\s*20\s*\)/.test(restoreProof)
    && /let\s+detailWorkOrderID\s*=\s*try\s+UITestFixture\.requiredID\s*\(\s*UITestFixture\.detailWorkOrderID\s*\)/.test(restoreProof)
    && /scrollToWorkOrderRow\s*\(\s*in:\s*restoredApp,\s*id:\s*detailWorkOrderID,\s*timeout:\s*20\s*\)\s*!=\s*nil/.test(restoreProof)
    && hasBoundedExactWorkOrderScroll(files)
    && !/restoredApp\.staticTexts\[KO\.todayTitle\]/.test(restoreProof);
}

function hasFullFixtureTabBarGeometryEvidence(files) {
  const fieldCase = stripSwiftCommentsAndStrings(files["ios/UITests/Support/FieldUITestCase.swift"] ?? "");
  const criticalPath = stripSwiftCommentsAndStrings(files["ios/UITests/FieldCriticalPathUITests.swift"] ?? "");
  const geometry = extractFunctionBody(fieldCase, /func\s+assertTodayListEndsAtOrAboveTabBar\s*\(/);
  const traversal = extractFunctionBody(criticalPath, /func\s+testFullFixtureRowsRemainReachableAboveTabBar\s*\(\s*\)\s+async\s+throws/);
  if (geometry === null || traversal === null) return false;

  return /app\.collectionViews\[AID\.todayList\]/.test(geometry)
    && /app\.tabBars\.firstMatch/.test(geometry)
    && /list\.waitForExistence\s*\(\s*timeout:\s*15\s*\)/.test(geometry)
    && /tabBar\.waitForExistence\s*\(\s*timeout:\s*15\s*\)/.test(geometry)
    && /XCTAssertLessThanOrEqual\s*\(\s*list\.frame\.maxY\s*,\s*tabBar\.frame\.minY\s*\+\s*1/.test(geometry)
    && /XCTAssertGreaterThanOrEqual\s*\(\s*list\.frame\.maxY\s*,\s*tabBar\.frame\.minY\s*-\s*1/.test(geometry)
    && /launchApp\s*\(\s*\)/.test(traversal)
    && /waitForAuthenticatedShell\s*\(\s*\)/.test(traversal)
    && /assertTodayListEndsAtOrAboveTabBar\s*\(\s*in:\s*app\s*\)/.test(traversal)
    && ["startWorkOrderID", "reportWorkOrderID", "reportSuccessWorkOrderID", "adminApproveWorkOrderID", "adminRejectWorkOrderID"].every((fixture) => traversal.includes(`UITestFixture.${fixture}`))
    && /scrollToWorkOrderRow\s*\(\s*in:\s*app\s*,\s*id:\s*fixtureID/.test(traversal)
    && /workOrderRowActivationPoint\s*\(\s*in:\s*app\s*,\s*row:\s*row\s*,\s*list:\s*list\s*\)/.test(traversal)
    && !/TODAY_DIAGNOSTIC/.test(files["ios/UITests/Support/FieldUITestCase.swift"] ?? "");
}

function hasEntitledSimulatorSeederContract(job) {
  const activeJob = stripInertShellData(job);
  const rawJob = stripShellComments(job);
  const build = activeJob.indexOf("xcodebuild build-for-testing");
  const app = activeJob.indexOf('BUILT_APP="$(find "$DERIVED/Build/Products" -type d -name \'MaintenanceFieldApp.app\' -print -quit)"');
  const seeder = activeJob.indexOf('SEEDER_APP="$(find "$DERIVED/Build/Products" -type d -name \'MaintenanceFieldUITestSeeder.app\' -print -quit)"');
  const runner = activeJob.indexOf('UITEST_RUNNER_APP="$(find "$DERIVED/Build/Products"');
  const sectionParser = rawJob.indexOf('missing __TEXT,__entitlements section');
  const verifyApp = activeJob.indexOf('/usr/bin/codesign --verify --deep --strict "$BUILT_APP"');
  const verifySeeder = activeJob.indexOf('/usr/bin/codesign --verify --deep --strict "$SEEDER_APP"');
  const verifyRunner = activeJob.indexOf('/usr/bin/codesign --verify --deep --strict "$UITEST_RUNNER_APP"');
  const appGroup = activeJob.indexOf('APP_KEYCHAIN_GROUP="$(mach_o_keychain_group "$BUILT_APP/MaintenanceFieldApp")"');
  const seederGroup = activeJob.indexOf('SEEDER_KEYCHAIN_GROUP="$(mach_o_keychain_group "$SEEDER_APP/MaintenanceFieldUITestSeeder")"');
  const execute = activeJob.indexOf("xcodebuild test-without-building");
  return build !== -1
    && app > build
    && seeder > app
    && runner > seeder
    && sectionParser !== -1
    && /case "\$RUNNER_ARCH" in ARM64\) MACH_O_ARCH=arm64 ;; X64\) MACH_O_ARCH=x86_64/.test(activeJob)
    && /architectures="\$\(\/usr\/bin\/lipo -archs "\$executable"\)"/.test(activeJob)
    && /case " \$architectures " in \*" \$MACH_O_ARCH "\*\)/.test(activeJob)
    && /if \[\[ "\$architectures" == "\$MACH_O_ARCH" \]\]; then \/bin\/cp "\$executable" "\$thin"; else \/usr\/bin\/lipo "\$executable" -thin "\$MACH_O_ARCH" -output "\$thin"; fi/.test(activeJob)
    && /_, _, segment, _, _, _, _, _, _, nsects, _ = struct\.unpack_from\("<II16sQQQQiiII", executable, offset\)/.test(rawJob)
    && /name\.rstrip\(b"\\0"\) == b"__entitlements"/.test(rawJob)
    && /section_segment\.rstrip\(b"\\0"\) == b"__TEXT"/.test(rawJob)
    && /segment\.rstrip\(b"\\0"\) == b"__TEXT"/.test(rawJob)
    && /plistlib\.loads\(section\)/.test(rawJob)
    && /expected exactly one keychain-access-groups value/.test(rawJob)
    && /if group != suffix and not group\.endswith\("\." \+ suffix\):/.test(rawJob)
    && verifyApp > runner
    && verifySeeder > verifyApp
    && verifyRunner > verifySeeder
    && appGroup > verifyRunner
    && seederGroup > appGroup
    && activeJob.indexOf('test "$APP_KEYCHAIN_GROUP" = "$SEEDER_KEYCHAIN_GROUP"') > seederGroup
    && execute > seederGroup
    && !/codesign\s+--force\s+--sign\b/.test(activeJob)
    && !/MNT_IOS_KEYCHAIN_GROUP/.test(activeJob)
    && !/codesign\s+--display\s+--entitlements/.test(activeJob);
}

function normalizeInterpolationParameters(value) {
  return value.replace(/\\\(\s*[A-Za-z_][A-Za-z0-9_]*\s*\)/g, "\\($)");
}

function extractAccessibilityMembers(source, enumName) {
  const body = extractEnumBody(source, enumName);
  if (body === null) return { error: `missing or unbalanced ${enumName} enum` };

  const staticIdentifiers = new Map();
  for (const match of body.matchAll(/(?:public\s+)?static\s+let\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*String)?\s*=\s*"((?:\\.|[^"\\])*)"/g)) {
    staticIdentifiers.set(match[1], match[2]);
  }

  const dynamicIdentifiers = new Map();
  const declaration = /(?:public\s+)?static\s+func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*->\s*String\s*\{/g;
  for (const match of body.matchAll(declaration)) {
    const openingBrace = match.index + match[0].length - 1;
    const functionBody = extractBalancedBlock(body, openingBrace);
    const value = functionBody?.match(/(?:return\s+)?"((?:\\.|[^"\\])*)"/)?.[1];
    if (value === undefined) return { error: `${enumName}.${match[1]} must return a string literal` };
    dynamicIdentifiers.set(match[1], normalizeInterpolationParameters(value));
  }
  return { staticIdentifiers, dynamicIdentifiers };
}

function equivalentAccessibilityMembers(production, uiTests) {
  const differences = [];
  for (const category of ["staticIdentifiers", "dynamicIdentifiers"]) {
    for (const [name, value] of production[category]) {
      if (!uiTests[category].has(name)) differences.push(`UITests AID is missing ${category === "staticIdentifiers" ? "static" : "dynamic"} ${name}`);
      else if (uiTests[category].get(name) !== value) differences.push(`${name} differs (${value} != ${uiTests[category].get(name)})`);
    }
    for (const name of uiTests[category].keys()) {
      if (!production[category].has(name)) differences.push(`UITests AID has production-absent ${category === "staticIdentifiers" ? "static" : "dynamic"} ${name}`);
    }
  }
  return differences;
}

function hasAccessibilityIDParity(files) {
  const production = extractAccessibilityMembers(files["ios/Sources/MaintenanceFieldApp/FieldAccessibilityID.swift"] ?? "", "FieldAccessibilityID");
  const uiTests = extractAccessibilityMembers(files["ios/UITests/Support/FieldUITestCase.swift"] ?? "", "AID");
  if (production.error || uiTests.error) return false;
  return equivalentAccessibilityMembers(production, uiTests).length === 0;
}

function hasSectionScopedMessengerMessageRows(files) {
  const views = files["ios/Sources/MaintenanceFieldApp/FieldViews.swift"] ?? "";
  const searchResults = /ForEach\(viewModel\.messengerState\.searchResults\)\s*\{\s*message\s+in[\s\S]{0,360}MessengerMessageRow\s*\([\s\S]{0,240}accessibilityIdentifier:\s*FieldAccessibilityID\.messengerSearchResultRow\(message\.id\)/;
  const selectedThreadMessages = /ForEach\(messages\)\s*\{\s*message\s+in[\s\S]{0,360}MessengerMessageRow\s*\([\s\S]{0,240}accessibilityIdentifier:\s*FieldAccessibilityID\.messengerMessageRow\(message\.id\)/;
  const directBodyIdentifier = /struct\s+MessengerMessageRow:\s+View\s*\{[\s\S]{0,300}let\s+accessibilityIdentifier:\s+String[\s\S]{0,1800}Text\(message\.body\)[\s\S]{0,240}\.accessibilityIdentifier\(accessibilityIdentifier\)/.test(views);
  const noOuterContainerIdentifier = !/MessengerMessageRow\s*\([\s\S]{0,360}\)\s*\.accessibilityIdentifier\s*\(/.test(views);
  return searchResults.test(views) && selectedThreadMessages.test(views) && directBodyIdentifier && noOuterContainerIdentifier;
}

function hasCiOnlyLocalAts(files) {
  const production = files["ios/Sources/MaintenanceFieldApp/Info.plist"] ?? "";
  const workflow = files[".github/workflows/ios-ui-tests.yml"] ?? "";
  const hasCiPlist = /\bCI_PLIST="\$D\/Info\.ci\.plist"/.test(workflow)
    && /\bcp\s+Sources\/MaintenanceFieldApp\/Info\.plist\s+"\$CI_PLIST"/.test(workflow)
    && /PlistBuddy[\s\S]{0,240}Add\s+:NSAppTransportSecurity\s+dict[\s\S]{0,320}"\$CI_PLIST"/.test(workflow)
    && /PlistBuddy[\s\S]{0,320}Add\s+:NSAppTransportSecurity:NSAllowsLocalNetworking\s+bool\s+true[\s\S]{0,320}"\$CI_PLIST"/.test(workflow);
  const hasAppTargetOnlySpec = /python3\s+-\s+"\$CI_PLIST"\s+"\$CI_PROJECT_SPEC"/.test(workflow)
    && /needle\s*=\s*"INFOPLIST_FILE:\s*Sources\/MaintenanceFieldApp\/Info\.plist"/.test(workflow)
    && /source\.count\(needle\)\s*!=\s*1/.test(workflow)
    && /source\.replace\(needle,\s*f?"INFOPLIST_FILE:\s*\{sys\.argv\[1\]\}"\)/.test(workflow)
    && /xcodegen\s+generate\s+--spec\s+"\$CI_PROJECT_SPEC"/.test(workflow)
    && !/xcodebuild[^\n]*\bINFOPLIST_FILE=(?:"\$CI_PLIST"|\$CI_PLIST)/.test(workflow);
  const verifiesBuiltAppOnly = /BUILT_PLIST="\$\(find\s+"\$DERIVED\/Build\/Products"[\s\S]{0,240}MaintenanceFieldApp\.app\/Info\.plist[\s\S]{0,160}-print\s+-quit\)"/.test(workflow)
    && /PlistBuddy[\s\S]{0,240}Print\s+:NSAppTransportSecurity:NSAllowsLocalNetworking[\s\S]{0,240}"\$BUILT_PLIST"/.test(workflow)
    && /production Info\.plist must remain ATS-free/.test(workflow);
  return !/NSAllowsArbitraryLoads|NSExceptionAllowsInsecureHTTPLoads|NSExceptionDomains/.test(production)
    && hasCiPlist
    && hasAppTargetOnlySpec
    && verifiesBuiltAppOnly
    && /(?:127\.0\.0\.1|localhost)/.test(workflow)
    && /rm\s+-rf[^\n]*"\$CI_PLIST"[^\n]*"\$CI_PROJECT_SPEC"/.test(workflow);
}

function hasModernFullScreenLaunch(files) {
  const production = files["ios/Sources/MaintenanceFieldApp/Info.plist"] ?? "";
  const workflow = files[".github/workflows/ios-ui-tests.yml"] ?? "";
  return /<key>\s*UILaunchScreen\s*<\/key>\s*<dict(?:\s*\/>|>[\s\S]*?<\/dict>)/.test(production)
    && /PlistBuddy[\s\S]{0,240}Print\s+:UILaunchScreen[\s\S]{0,240}"\$BUILT_PLIST"/.test(workflow);
}

function hasCameraAuthorizationReactivation(files) {
  const camera = stripSwiftCommentsAndStrings(files["ios/Sources/MaintenanceFieldApp/CameraCaptureView.swift"] ?? "");
  return /@Environment\s*\(\s*\\\.scenePhase\s*\)\s+private\s+var\s+scenePhase/.test(camera)
    && /\.onChange\s*\(\s*of:\s*scenePhase\s*\)\s*\{\s*_,\s*newPhase\s+in[\s\S]{0,160}guard\s+newPhase\s*==\s*\.active\s+else\s*\{\s*return\s*\}[\s\S]{0,160}authorizationStatus\s*=\s*AVCaptureDevice\.authorizationStatus\s*\(\s*for:\s*\.video\s*\)/.test(camera);
}

function hasDurableCriticalPathEvidence(files) {
  const critical = files["ios/UITests/FieldCriticalPathUITests.swift"] ?? "";
  const messenger = files["ios/UITests/MessengerUITests.swift"] ?? "";
  const camera = files["ios/UITests/CameraCaptureUITests.swift"] ?? "";
  const login = files["ios/UITests/LoginValidationUITests.swift"] ?? "";
  const support = files["ios/UITests/Support/FieldUITestCase.swift"] ?? "";

  const startTap = critical.indexOf("startWork.tap()");
  const scopedStatus = critical.indexOf("AID.detailStatus", startTap);
  const scopedLabel = critical.indexOf("detailStatus.label", scopedStatus);
  const grant = critical.indexOf("grant.tap()");
  const withdraw = critical.indexOf("reloadedWithdraw.tap()", grant);
  const locationRelaunches = (critical.match(/app\.terminate\(\)/g) ?? []).length;

  const send = messenger.indexOf("AID.messengerSendButton");
  const messengerRelaunch = messenger.indexOf("app.terminate()", send);
  const reopenedThread = messenger.indexOf("openSeededThread()", messengerRelaunch);
  const persistedBody = messenger.indexOf("sentMessageBody", reopenedThread);

  const preview = camera.indexOf("if previewIsUsable");
  const cancel = camera.indexOf("cancel.tap()", preview);

  return startTap !== -1 && scopedStatus > startTap && scopedLabel > scopedStatus
    && /XCTAssertEqual\([\s\S]{0,160}detailStatus\.label[\s\S]{0,160}KO\.inProgress/.test(critical)
    && grant !== -1 && withdraw > grant && locationRelaunches >= 2
    && /fresh app launch must read the granted state back/i.test(critical)
    && /fresh app launch must read the withdrawn terminal state back/i.test(critical)
    && send !== -1 && messengerRelaunch > send && reopenedThread > messengerRelaunch && persistedBody > reopenedThread
    && preview !== -1 && cancel > preview
    && !/if\s+previewIsUsable\s*\{\s*return\b/.test(camera)
    && /XCTAssertEqual\([\s\S]{0,160}loginError\.label[\s\S]{0,160}KO\.errorInvalidUserID/.test(login)
    && /static\s+func\s+requiredID[\s\S]{0,260}UUID\(uuidString: value\)/.test(support)
    && !/static\s+func\s+workOrderID\s*\(/.test(support);
}


/** Pure, mutation-testable evaluation of the hosted iOS UI CI contract. */
export function evaluateIosUiTestFailClosedChecks(files) {
  const workflow = files[".github/workflows/ios-ui-tests.yml"] ?? "";
  const job = iosJob(workflow);
  const failures = [];
  const checks = [];
  if (!job) return { failures: ["ios-ui-tests workflow must define an ios-ui-tests job"], passes: [] };

  checks.push([hasHostedUntrustedBoundary(job), "iOS UI CI must isolate untrusted PR code on fixed GitHub-hosted macos-26, never a reusable self-hosted runner"]);
  checks.push([hasCompleteFailSlowRuntimeBudget(job), "iOS UI CI must use measured per-named-shard budgets plus 30 minutes for setup, verification, and cleanup without exceeding 90 minutes"]);
  checks.push([hasPinnedToolchain(job, workflow), "iOS UI CI must pin Xcode 26.6 build 17F113, Apple Swift 6.3.3, and iOS 26.5, bind Node 24.16.0 directly from the setup-node toolcache, and keep all Rust paths under its job root"]);
  checks.push([hasStrictSwift6LanguageMode(files), "iOS app, seeder, and UI-test targets must all compile in strict Swift 6 language mode without a Swift 5 compatibility override"]);
  checks.push([! /\bsecrets\./.test(job) && /URL="http:\/\/127\.0\.0\.1:\$BP"/.test(job) && /MNT_UITEST_BASE_URL="\$URL"/.test(job), "iOS UI CI must not depend on GitHub secrets or an external backend session"]);
  checks.push([hasValidLoopbackWebauthnPolicy(job, files["scripts/boot-ios-ui-backend.mjs"] ?? ""), "iOS UI CI must bind the backend to 127.0.0.1 while using localhost as the valid WebAuthn relying-party origin and ID through the exact approved backend step and structured launcher"]);
  checks.push([hasCandidateShaBeforeBackendBuild(job), "iOS UI CI must verify git rev-parse HEAD against GITHUB_SHA before building candidate mnt-app"]);
  checks.push([hasOptimizedBehavioralBackendBuild(job), "iOS UI CI must use the measured stripped-debug mnt-app build for behavioral E2E and reject release optimization overhead"]);
  checks.push([hasPipelineTimingTelemetry(job), "iOS UI CI must emit durable phase and per-shard timings so slow stages are diagnosed before budgets change"]);
  checks.push([hasPinnedJobLocalXcodegen(job), "iOS UI CI must install checksum-pinned XcodeGen 2.46.0 under its job root without mutating Homebrew"]);
  checks.push([hasOfficialPostgres184Source(job), "iOS UI CI must build PostgreSQL 18.4 from the official source tarball after SHA-256 verification"]);
  checks.push([hasRequiredPostgresExtensions(job), "iOS UI CI must configure PostgreSQL with OpenSSL and build, install, and load-test the required pgcrypto and pg_trgm extensions before compiling the backend"]);
  checks.push([hasJobLocalPostgres(job), "iOS UI CI must use a mode-0700 job-root PGDATA with a random loopback-only PostgreSQL port"]);
  checks.push([hasPerClassSessions(job), "iOS UI CI must mint and mask a random, SHA-256-backed OTP session for every bounded only-testing shard and provide all deterministic fixtures"]);
  checks.push([hasPerClassFixtureIsolation(files["e2e/harness/seed-mobile-ci.sql"] ?? ""), "iOS UI CI must restore the exact mutable mobile fixture baseline in FK-safe order before every named shard while preserving append-only audit history"]);
  checks.push([hasAccessibilityFixtureProfileIsolation(job, files["e2e/harness/seed-mobile-ci.sql"] ?? ""), "iOS accessibility audits must receive an isolated one-row Today and Messenger fixture while every functional named shard receives the full five-row and eight-message fixture, with unknown profiles rejected"]);
  checks.push([hasSharedKeychainEntitlementContract(files), "iOS app and dedicated UI-test seeder target must share one identically signed default keychain access group"]);
  checks.push([hasDefaultSharedKeychainResolution(files), "iOS app and UI-test seeder must resolve the fully qualified shared keychain group through the system-granted default group"]);
  checks.push([hasMainActorUiAutomationContract(files), "iOS UI test automation must confine XCUIApplication and its entitled session seeder to the main actor with synchronous throwing base lifecycle hooks"]);
  checks.push([hasDecodedTodayPreflight(files), "iOS preflight must prove the restored session decodes and renders the exact deterministic Today work order, not only an authenticated shell"]);
  checks.push([hasFullFixtureTabBarGeometryEvidence(files), "iOS functional tests must traverse all five deterministic Today rows above the tab bar while accessibility audits remain diagnostic-free"]);
  checks.push([hasActionableDetailReadiness(files), "iOS UI navigation must prove detail readiness with the actionable back control, not container hittability"]);
  checks.push([hasDetailLazyControlScroll(files), "iOS UI tests must use one deadline-bounded exact-element scroll for lazy detail controls, using the persistent detail toolbar back control as the normalization sentinel"]);
  checks.push([hasEntitledSimulatorSeederContract(job), "iOS UI CI must preserve the Xcode-created Simulator Runner and prove matching app/seeder Mach-O keychain entitlements before test execution"]);
  checks.push([hasMode600Xctestrun(job), "iOS UI CI must inject session material through a mode-0600 job-root xctestrun before patch/use"]);
  checks.push([!/-skip-testing|XCTSkip|optional\/skipped|HAS_REAL_SESSION_SOURCE/.test(workflow + (files["ios/UITests/Support/FieldUITestCase.swift"] ?? "") + (files["ios/UITests/Support/RealSessionSeed.swift"] ?? "")), "iOS UI CI and its test support must not include skip-testing, XCTSkip, or fail-open session branches"]);
  checks.push([! /MNT_UITEST_AUDIT_STRICT/.test(workflow), "iOS UI CI must not make strict accessibility conditional through an environment toggle"]);
  checks.push([hasStrictAccessibility(files), "iOS UI CI must enforce strict accessibility auditing"]);
  checks.push([hasDeterministicAccessibilityPresentations(files), "iOS accessibility audits must precondition supported Simulator appearance and content size per named shard, then enforce Dynamic Type compatibility ledgers and non-Dynamic-Type audits without process-local presentation mutation"]);
  checks.push([hasAdaptiveTodayLocationConsent(files), "iOS Today must retain inline location consent outside accessibility Dynamic Type and present the complete consent section in a stable-ID sheet with a stable-ID close control at accessibility sizes, while work-order detail retains the full section"]);
  checks.push([hasUnobscuredTabContentHost(files), "every authenticated iOS tab must use the public content-layout-guide sensor/probe seam with lifecycle-safe measurement and no private hierarchy coupling"]);
  checks.push([hasAccessibilityIDParity(files), "iOS UI CI must mirror every FieldAccessibilityID static and dynamic identifier in UITests AID"]);
  checks.push([hasSectionScopedMessengerMessageRows(files), "iOS messenger search results and selected-thread messages must use section-scoped dynamic accessibility IDs"]);
  checks.push([hasSemanticMessengerMessagesHeader(files), "iOS messenger messages must retain a scalable semantic header before selected-thread content"]);
  checks.push([hasContrastStableCapsules(files), "iOS status, attachment, and read-progress capsules must use explicit primary foregrounds on contrast-stable adaptive backgrounds"]);
  checks.push([hasModernFullScreenLaunch(files), "iOS app and CI build must preserve a modern full-screen launch contract"]);
  checks.push([hasCiOnlyLocalAts(files), "iOS UI CI must confine local ATS to CI-only job-root loopback configuration while production Info.plist remains unchanged"]);
  checks.push([hasExactFailSlowExecution(job), "iOS UI CI must execute exactly fifteen independent named shards fail-slow, preserve every xcresult extraction failure, verify after the loop, and exit with aggregate status"]);
  checks.push([hasStructuredResultVerification(job), "iOS UI CI must aggregate repeated structured xcresulttool summaries and tests through the reusable verifier"]);
  checks.push([hasCameraAuthorizationReactivation(files), "iOS camera capture must refresh authorization when the app becomes active after returning from Settings"]);
  checks.push([hasDurableCriticalPathEvidence(files), "iOS UI tests must prove scoped mutations, backend readback after relaunch, camera dismissal, and UUID fixtures without local-state false greens"]);
  checks.push([hasArtifactSecretScan(job), "iOS UI CI must upload only scan-clean derived diagnostics, never raw xcresult bundles containing OTP, access, or refresh session material"]);
  checks.push([hasOwnedCleanup(job), "iOS UI CI must upload before final always-cleanup and prove identity-aware backend, PostgreSQL, Simulator, and job-root cleanup"]);

  const passes = [];
  for (const [condition, message] of checks) {
    if (condition) passes.push(message);
    else failures.push(message);
  }
  return { failures, passes };
}

function read(relativePath) {
  const absolute = resolve(root, relativePath);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : "";
}

function main() {
  const paths = [
    ".github/workflows/ios-ui-tests.yml",
    "scripts/boot-ios-ui-backend.mjs",
    "ios/Sources/MaintenanceFieldApp/Info.plist",
    "ios/Sources/MaintenanceFieldApp/FieldApp.swift",
    "ios/Sources/MaintenanceFieldCore/PersistenceStores.swift",
    "ios/Sources/MaintenanceFieldApp/FieldAccessibilityID.swift",
    "ios/Sources/MaintenanceFieldApp/FieldViews.swift",
    "ios/Sources/MaintenanceFieldApp/CameraCaptureView.swift",
    "ios/Config/App.xcconfig",
    "ios/Config/MaintenanceFieldApp.entitlements",
    "ios/Config/MaintenanceFieldUITestSeeder.entitlements",
    "ios/Sources/MaintenanceFieldUITestSeeder/UITestSeederApp.swift",
    "ios/project.yml",
    "ios/UITests/Support/FieldUITestCase.swift",
    "ios/UITests/Support/RealSessionSeed.swift",
    "ios/UITests/AccessibilityAuditUITests.swift",
    "ios/UITests/DynamicTypeRuntimeUITests.swift",
    "ios/UITests/PreflightUITests.swift",
    "ios/UITests/FieldCriticalPathUITests.swift",
    "ios/UITests/MessengerUITests.swift",
    "ios/UITests/CameraCaptureUITests.swift",
    "ios/UITests/LoginValidationUITests.swift",
    "e2e/harness/seed-mobile-ci.sql",
  ];
  const files = Object.fromEntries(paths.map((path) => [path, read(path)]));
  const { failures, passes } = evaluateIosUiTestFailClosedChecks(files);
  for (const pass of passes) console.log(`PASS ${pass}`);
  if (failures.length > 0) {
    console.error("\niOS UI hermetic workflow guard failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\niOS UI hermetic workflow guard passed (${passes.length} checks).`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) main();
