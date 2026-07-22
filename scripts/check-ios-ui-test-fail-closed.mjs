#!/usr/bin/env node
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

function hasPinnedToolchain(job) {
  return /DEVELOPER_DIR:\s*\/Applications\/Xcode_16\.4\.app\/Contents\/Developer/.test(job)
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
    && /\[\[\s+-d\s+"\$ARTIFACTS"\s+\]\]\s+\|\|\s+exit\s+0/.test(scan)
    && /if\s+find\s+"\$ARTIFACTS"\s+-mindepth\s+1\s+-print\s+-quit\s+\|\s+grep\s+-q\s+\.\s*;\s*then/.test(scan)
    && /\[\[\s+-s\s+"\$SECRETS_FILE"\s+\]\]\s+\|\|\s+\{\s*echo\s+'artifacts exist without the owned raw-session scan source'/.test(scan)
    && /\[\[\s+-n\s+"\$secret_value"\s+\]\]\s+\|\|\s+continue/.test(scan)
    && /grep\s+-R\s+-a\s+-F\s+-q\s+--\s+"\$secret_value"\s+"\$ARTIFACTS"/.test(scan)
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
    && /static\s+func\s+workOrderID[\s\S]{0,260}try\s+requiredID\(/.test(support);
}


/** Pure, mutation-testable evaluation of the hosted iOS UI CI contract. */
export function evaluateIosUiTestFailClosedChecks(files) {
  const workflow = files[".github/workflows/ios-ui-tests.yml"] ?? "";
  const job = iosJob(workflow);
  const failures = [];
  const checks = [];
  if (!job) return { failures: ["ios-ui-tests workflow must define an ios-ui-tests job"], passes: [] };

  checks.push([hasHostedUntrustedBoundary(job), "iOS UI CI must isolate untrusted PR code on fixed GitHub-hosted macos-15, never a reusable self-hosted runner"]);
  checks.push([hasPinnedToolchain(job), "iOS UI CI must pin Xcode 16.4 build 16F6, iOS 18.5, and all Rust paths under its job root"]);
  checks.push([! /\bsecrets\./.test(job) && /URL="http:\/\/127\.0\.0\.1:\$BP"/.test(job) && /MNT_UITEST_BASE_URL="\$URL"/.test(job), "iOS UI CI must not depend on GitHub secrets or an external backend session"]);
  checks.push([hasCandidateShaBeforeBackendBuild(job), "iOS UI CI must verify git rev-parse HEAD against GITHUB_SHA before building candidate mnt-app"]);
  checks.push([hasPinnedJobLocalXcodegen(job), "iOS UI CI must install checksum-pinned XcodeGen 2.46.0 under its job root without mutating Homebrew"]);
  checks.push([hasOfficialPostgres184Source(job), "iOS UI CI must build PostgreSQL 18.4 from the official source tarball after SHA-256 verification"]);
  checks.push([hasRequiredPostgresExtensions(job), "iOS UI CI must configure PostgreSQL with OpenSSL and build, install, and load-test the required pgcrypto and pg_trgm extensions before compiling the backend"]);
  checks.push([hasJobLocalPostgres(job), "iOS UI CI must use a mode-0700 job-root PGDATA with a random loopback-only PostgreSQL port"]);
  checks.push([hasPerClassSessions(job), "iOS UI CI must mint and mask a random, SHA-256-backed OTP session for every 720-second only-testing shard and provide all deterministic fixtures"]);
  checks.push([hasMode600Xctestrun(job), "iOS UI CI must inject session material through a mode-0600 job-root xctestrun before patch/use"]);
  checks.push([!/-skip-testing|XCTSkip|optional\/skipped|HAS_REAL_SESSION_SOURCE/.test(workflow + (files["ios/UITests/Support/FieldUITestCase.swift"] ?? "") + (files["ios/UITests/Support/RealSessionSeed.swift"] ?? "")), "iOS UI CI and its test support must not include skip-testing, XCTSkip, or fail-open session branches"]);
  checks.push([! /MNT_UITEST_AUDIT_STRICT/.test(workflow), "iOS UI CI must not make strict accessibility conditional through an environment toggle"]);
  checks.push([hasStrictAccessibility(files), "iOS UI CI must enforce strict accessibility auditing"]);
  checks.push([hasAccessibilityIDParity(files), "iOS UI CI must mirror every FieldAccessibilityID static and dynamic identifier in UITests AID"]);
  checks.push([hasCiOnlyLocalAts(files), "iOS UI CI must confine local ATS to CI-only job-root loopback configuration while production Info.plist remains unchanged"]);
  checks.push([hasStructuredResultVerification(job), "iOS UI CI must aggregate repeated structured xcresulttool summaries and tests through the reusable verifier"]);
  checks.push([hasDurableCriticalPathEvidence(files), "iOS UI tests must prove scoped mutations, backend readback after relaunch, camera dismissal, and UUID fixtures without local-state false greens"]);
  checks.push([hasArtifactSecretScan(job), "iOS UI CI must fail if retained artifacts contain raw OTP, access, or refresh session material"]);
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
    "ios/Sources/MaintenanceFieldApp/Info.plist",
    "ios/Sources/MaintenanceFieldApp/FieldAccessibilityID.swift",
    "ios/project.yml",
    "ios/UITests/Support/FieldUITestCase.swift",
    "ios/UITests/Support/RealSessionSeed.swift",
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
