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

function hasHostedUntrustedBoundary(job) {
  return /runs-on:\s*macos-15\b/.test(job)
    && !/\bself-hosted\b/i.test(job.replace(/#.*$/gm, ""))
    && !/vars\.MNT_IOS_CI_RUNNER/.test(job)
    && !/\bruns-on:\s*\$\{\{/.test(job);
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
  const exactJobEnvironment = /^[ ]{4}env:\n[ ]{6}DEVELOPER_DIR: \/Applications\/Xcode_16\.4\.app\/Contents\/Developer\n(?=^[ ]{4}steps:)/m.test(job);
  const exactBackendEnvironment = /^[ ]{8}env: \{CARGO_INCREMENTAL: "0", SQLX_OFFLINE: "true"\}$/m.test(activeBackendStep);
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
    && /DEVELOPER_DIR:\s*\/Applications\/Xcode_16\.4\.app\/Contents\/Developer/.test(job)
    && /test\s+"\$\(xcodebuild -version\)"\s*=\s*\$'Xcode 16\.4\\nBuild version 16F6'/.test(job)
    && /SIM_RUNTIME=com\.apple\.CoreSimulator\.SimRuntime\.iOS-18-5/.test(job)
    && /SIM_DEVICE_TYPE=com\.apple\.CoreSimulator\.SimDeviceType\.iPhone-16/.test(job)
    && /simctl\s+list\s+devicetypes\s+-j[\s\S]{0,400}identifier[\s\S]{0,400}==\s*target[\s\S]{0,240}"\$SIM_DEVICE_TYPE"/.test(job)
    && /MNT_IOS_JOB_ROOT=\$D/.test(job)
    && /CARGO_HOME=\$D\/cargo-home/.test(job)
    && /RUSTUP_HOME=\$D\/rustup-home/.test(job)
    && /CARGO_TARGET_DIR=\$D\/cargo-target/.test(job)
    && />>\s*"\$GITHUB_ENV"/.test(job);
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
  const approvedBackendStepSha256 = "ee9870e3f0b86ac5dc793843d9baff5b0782bba082fba477a967268ff9821795";
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
  const fixtures = ["f00004", "f00003", "f00005", "c10001", "c20001"];
  return /secret\s*\(\)\s*\{\s*openssl\s+rand\s+-hex\s+\d+;\s*\}/.test(job)
    && /mint_class_session\s*\(\)\s*\{[\s\S]{0,400}otp="\$\(secret\)"/.test(job)
    && /echo\s+"::add-mask::\$otp"/.test(job)
    && /shasum\s+-a\s+256/.test(job)
    && /seed-mobile-ci\.sql/.test(job)
    && /auth\/otp\/redeem/.test(job)
    && /MNT_UITEST_ACCESS_TOKEN/.test(job)
    && /MNT_UITEST_REFRESH_TOKEN/.test(job)
    && /echo\s+"::add-mask::\$MNT_UITEST_ACCESS_TOKEN"/.test(job)
    && /echo\s+"::add-mask::\$MNT_UITEST_REFRESH_TOKEN"/.test(job)
    && /TEST_CLASSES=\([^)]*\)/.test(job)
    && /for\s+test_class\s+in\s+"\$\{TEST_CLASSES\[@\]\}";\s*do\s+mint_class_session/.test(job)
    && /sleep\s+720/.test(job)
    && /-only-testing:"MaintenanceFieldUITests\/\$test_class"/.test(job)
    && fixtures.every((suffix) => new RegExp(`00000000-0000-0000-0000-000000${suffix}`).test(job));
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

function hasStructuredResultVerification(job) {
  return /xcresulttool\s+get\s+test-results\s+summary/.test(job)
    && /xcresulttool\s+get\s+test-results\s+tests/.test(job)
    && /--summary\s+"\$summary"\s+--tests\s+"\$tests"/.test(job)
    && /VERIFY_ARGS\+=\(/.test(job)
    && /verify-xcresult-test-results\.mjs"?\s+"\$\{VERIFY_ARGS\[@\]\}"[\s\S]{0,160}--swift-tests\s+"\$ROOT\/ios\/UITests"/.test(job)
    && /\.xcresult/.test(job);
}

function hasArtifactSecretScan(job) {
  const scan = /name:\s*Scan result artifacts for raw session material[\s\S]{0,180}id:\s*artifact-scan[\s\S]{0,180}if:\s*always\(\)[\s\S]{0,2200}/.exec(job)?.[0] ?? "";
  return scan.length > 0
    && /RAW_RESULTS="\$D\/raw-xcresults"; ARTIFACTS="\$D\/artifacts"/.test(job)
    && /install\s+-d\s+-m\s+700\s+"\$D"\s+"\$AUTH_DIR"\s+"\$PGDATA"\s+"\$RAW_RESULTS"\s+"\$ARTIFACTS"/.test(job)
    && /result="\$RAW_RESULTS\/\$test_class\.xcresult"/.test(job)
    && !/result="\$ARTIFACTS\/\$test_class\.xcresult"/.test(job)
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
  const fieldCase = files["ios/UITests/Support/FieldUITestCase.swift"] ?? "";
  return /performAccessibilityAudit\(for:\s*\.all\)/.test(fieldCase)
    && !/issueHandler/.test(fieldCase)
    && !/performAccessibilityAudit\([\s\S]{0,120}\)\s*\{/.test(fieldCase)
    && !/MNT_UITEST_AUDIT_STRICT/.test(fieldCase);
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

function stripSwiftCommentsAndStrings(source) {
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
        for (let offset = 0; offset < closing.length; offset += 1) blank(index + offset);
        index += closing.length;
        stringDelimiter = null;
      } else if (source.startsWith(`\\${"#".repeat(rawHashes)}`, index)) {
        const escapeLength = 2 + rawHashes;
        for (let offset = 0; offset < escapeLength && index + offset < source.length; offset += 1) {
          blank(index + offset);
        }
        index += escapeLength;
      } else {
        blank(index);
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
      for (let offset = 0; offset < openingLength; offset += 1) blank(index + offset);
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
  const productionBody = extractFunctionBody(
    files["ios/Sources/MaintenanceFieldCore/PersistenceStores.swift"] ?? "",
    /public\s+static\s+func\s+resolveShared\s*\(/,
  );
  const helper = files["ios/Sources/MaintenanceFieldUITestSeeder/UITestSeederApp.swift"] ?? "";
  const uiTestSupport = files["ios/UITests/Support/RealSessionSeed.swift"] ?? "";
  if (productionBody === null) return false;
  const productionAccessGroupReferences = productionBody.match(/kSecAttrAccessGroup/g) ?? [];
  return productionAccessGroupReferences.length === 1
    && productionBody.includes("UUID().uuidString.lowercased()")
    && productionBody.includes("kSecReturnAttributes as String: true")
    && productionBody.includes('granted == suffix || granted.hasSuffix(".\\(suffix)")')
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
  const helper = extractFunctionBody(
    field,
    /@MainActor\s+func\s+scrollToWorkOrderRow\s*\(\s*in\s+app:\s*XCUIApplication,\s*id:\s*String,\s*timeout:\s*TimeInterval\s*=\s*15,\s*maxSwipes:\s*Int\s*=\s*12\s*\)\s*->\s*XCUIElement\?/,
  );
  if (helper === null) return false;

  return /let\s+row\s*=\s*app\.buttons\[AID\.workOrderRow\s*\(\s*id\s*\)\]/.test(helper)
    && /let\s+list\s*=\s*app\.collectionViews\[AID\.todayList\]/.test(helper)
    && /guard\s+list\.waitForExistence\s*\(/.test(helper)
    && /for\s+_\s+in\s+0\s*\.\.<\s*maxSwipes/.test(helper)
    && /list\.swipeUp\s*\(\s*\)/.test(helper)
    && /row\.waitForExistence\s*\(/.test(helper)
    && /row\.isHittable/.test(helper);
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
  const searchResults = /ForEach\(viewModel\.messengerState\.searchResults\)\s*\{\s*message\s+in[\s\S]{0,360}FieldAccessibilityID\.messengerSearchResultRow\(message\.id\)/;
  const selectedThreadMessages = /ForEach\(messages\)\s*\{\s*message\s+in[\s\S]{0,360}FieldAccessibilityID\.messengerMessageRow\(message\.id\)/;
  return searchResults.test(views) && selectedThreadMessages.test(views);
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

  checks.push([hasHostedUntrustedBoundary(job), "iOS UI CI must isolate untrusted PR code on fixed GitHub-hosted macos-15, never a reusable self-hosted runner"]);
  checks.push([hasPinnedToolchain(job, workflow), "iOS UI CI must pin Xcode 16.4 build 16F6 and iOS 18.5, bind Node 24.16.0 directly from the setup-node toolcache, and keep all Rust paths under its job root"]);
  checks.push([! /\bsecrets\./.test(job) && /URL="http:\/\/127\.0\.0\.1:\$BP"/.test(job) && /MNT_UITEST_BASE_URL="\$URL"/.test(job), "iOS UI CI must not depend on GitHub secrets or an external backend session"]);
  checks.push([hasValidLoopbackWebauthnPolicy(job, files["scripts/boot-ios-ui-backend.mjs"] ?? ""), "iOS UI CI must bind the backend to 127.0.0.1 while using localhost as the valid WebAuthn relying-party origin and ID through the exact approved backend step and structured launcher"]);
  checks.push([hasCandidateShaBeforeBackendBuild(job), "iOS UI CI must verify git rev-parse HEAD against GITHUB_SHA before building candidate mnt-app"]);
  checks.push([hasPinnedJobLocalXcodegen(job), "iOS UI CI must install checksum-pinned XcodeGen 2.46.0 under its job root without mutating Homebrew"]);
  checks.push([hasOfficialPostgres184Source(job), "iOS UI CI must build PostgreSQL 18.4 from the official source tarball after SHA-256 verification"]);
  checks.push([hasRequiredPostgresExtensions(job), "iOS UI CI must configure PostgreSQL with OpenSSL and build, install, and load-test the required pgcrypto and pg_trgm extensions before compiling the backend"]);
  checks.push([hasJobLocalPostgres(job), "iOS UI CI must use a mode-0700 job-root PGDATA with a random loopback-only PostgreSQL port"]);
  checks.push([hasPerClassSessions(job), "iOS UI CI must mint and mask a random, SHA-256-backed OTP session for every 720-second only-testing shard and provide all deterministic fixtures"]);
  checks.push([hasSharedKeychainEntitlementContract(files), "iOS app and dedicated UI-test seeder target must share one identically signed default keychain access group"]);
  checks.push([hasDefaultSharedKeychainResolution(files), "iOS app and UI-test seeder must resolve the fully qualified shared keychain group through the system-granted default group"]);
  checks.push([hasMainActorUiAutomationContract(files), "iOS UI test automation must confine XCUIApplication and its entitled session seeder to the main actor with synchronous throwing base lifecycle hooks"]);
  checks.push([hasDecodedTodayPreflight(files), "iOS preflight must prove the restored session decodes and renders the exact deterministic Today work order, not only an authenticated shell"]);
  checks.push([hasEntitledSimulatorSeederContract(job), "iOS UI CI must preserve the Xcode-created Simulator Runner and prove matching app/seeder Mach-O keychain entitlements before test execution"]);
  checks.push([hasMode600Xctestrun(job), "iOS UI CI must inject session material through a mode-0600 job-root xctestrun before patch/use"]);
  checks.push([!/-skip-testing|XCTSkip|optional\/skipped|HAS_REAL_SESSION_SOURCE/.test(workflow + (files["ios/UITests/Support/FieldUITestCase.swift"] ?? "") + (files["ios/UITests/Support/RealSessionSeed.swift"] ?? "")), "iOS UI CI and its test support must not include skip-testing, XCTSkip, or fail-open session branches"]);
  checks.push([! /MNT_UITEST_AUDIT_STRICT/.test(workflow), "iOS UI CI must not make strict accessibility conditional through an environment toggle"]);
  checks.push([hasStrictAccessibility(files), "iOS UI CI must enforce strict accessibility auditing"]);
  checks.push([hasAccessibilityIDParity(files), "iOS UI CI must mirror every FieldAccessibilityID static and dynamic identifier in UITests AID"]);
  checks.push([hasSectionScopedMessengerMessageRows(files), "iOS messenger search results and selected-thread messages must use section-scoped dynamic accessibility IDs"]);
  checks.push([hasCiOnlyLocalAts(files), "iOS UI CI must confine local ATS to CI-only job-root loopback configuration while production Info.plist remains unchanged"]);
  checks.push([hasStructuredResultVerification(job), "iOS UI CI must aggregate repeated structured xcresulttool summaries and tests through the reusable verifier"]);
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
    "ios/Sources/MaintenanceFieldCore/PersistenceStores.swift",
    "ios/Sources/MaintenanceFieldApp/FieldAccessibilityID.swift",
    "ios/Sources/MaintenanceFieldApp/FieldViews.swift",
    "ios/Config/App.xcconfig",
    "ios/Config/MaintenanceFieldApp.entitlements",
    "ios/Config/MaintenanceFieldUITestSeeder.entitlements",
    "ios/Sources/MaintenanceFieldUITestSeeder/UITestSeederApp.swift",
    "ios/project.yml",
    "ios/UITests/Support/FieldUITestCase.swift",
    "ios/UITests/Support/RealSessionSeed.swift",
    "ios/UITests/PreflightUITests.swift",
    "ios/UITests/FieldCriticalPathUITests.swift",
    "ios/UITests/MessengerUITests.swift",
    "ios/UITests/CameraCaptureUITests.swift",
    "ios/UITests/LoginValidationUITests.swift",
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
