import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function fail(message, failures) {
  failures.push(message);
}

function splitMarkdownRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function parseParityRows(checklist) {
  return checklist
    .split(/\r?\n/)
    .filter((line) => /^\|.+\|$/.test(line.trim()))
    .map(splitMarkdownRow)
    .filter((cells) => cells.length >= 4)
    .filter(([area]) => area !== "Area" && !/^[-: ]+$/.test(area));
}

function parseAndroidStringKeys(xml) {
  return new Set(
    [...xml.matchAll(/<string\s+name="([^"]+)"(?:\s+[^>]*)?>[\s\S]*?<\/string>/g)].map(
      ([, key]) => key,
    ),
  );
}

function parseIosStringKeys(stringsFile) {
  return new Set(
    [...stringsFile.matchAll(/"((?:\\"|[^"])*)"\s*=\s*"((?:\\"|[^"])*)";/g)].map(
      ([, key]) => key.replace(/\\"/g, '"'),
    ),
  );
}

function checkRequiredText(checklist, failures) {
  const requiredText = [
    ["## Scope boundary", "scope boundary section"],
    ["## ADR-0009 release evidence gate", "release evidence gate section"],
    ["## Verified in T1.7", "T1.7 checklist section"],
    ["## Verified in T3.3", "T3.3 checklist section"],
    ["## Verified in T2.2", "T2.2 checklist section"],
    ["before adding a new mobile user-visible capability", "pre-capability checklist update rule"],
    ["`node scripts/check-i18n.mjs`", "local i18n/parity gate command"],
    ["`cd ios && swift build`", "iOS Swift build evidence"],
    ["`cd ios && swift test`", "iOS Swift test evidence"],
    ["`cd ios && swift run MaintenanceFieldCoreBehaviorTests`", "iOS behavior runner evidence"],
    ["`ios/E2E-MANUAL-SMOKE.md`", "iOS manual passkey smoke evidence"],
    ["ios-ui-tests.yml", "iOS XCUITest workflow evidence"],
    ["`cd android && ./gradlew build -x testReleaseUnitTest -x testDebugUnitTest`", "Android Gradle build evidence"],
    ["`cd android && ./gradlew testDebugUnitTest`", "Android unit/UI/accessibility evidence"],
    ["`cd android && ./gradlew verifyRoborazziDebug`", "Android screenshot evidence"],
    ["`cd android && ./gradlew fieldApi34DebugAndroidTest`", "Android instrumented E2E evidence"],
    ["`android/E2E-MANUAL-SMOKE.md`", "Android manual passkey smoke evidence"],
    ["`bash e2e/run.sh`", "browser E2E evidence"],
    ["`npm run check:api-drift:portable`", "portable client drift evidence"],
    ["`npm run check:api-drift:swift`", "Swift client drift evidence"],
    ["retired by ADR-0026", "accepted COSS RN retirement boundary"],
  ];

  for (const [needle, label] of requiredText) {
    if (!checklist.includes(needle)) {
      fail(`docs/parity-checklist.md is missing ${label}: ${needle}`, failures);
    }
  }
}

function checkChecklistRows(checklist, failures) {
  const parityRows = parseParityRows(checklist);

  if (parityRows.length === 0) {
    fail("docs/parity-checklist.md does not contain parity checklist rows.", failures);
    return;
  }

  const headings = [
    ["## Verified in T1.7", "T1.7"],
    ["## Verified in T3.3", "T3.3"],
    ["## Verified in T2.2", "T2.2"],
  ];
  for (const [heading, label] of headings) {
    const start = checklist.indexOf(heading);
    const next = checklist.indexOf("## ", start + heading.length);
    const section = start >= 0 ? checklist.slice(start, next >= 0 ? next : undefined) : "";
    const rowCount = parseParityRows(section).length;
    if (rowCount === 0) {
      fail(`docs/parity-checklist.md ${label} has no checked parity rows.`, failures);
    }
  }

  for (const [area, androidTarget, iosImplementation, evidence] of parityRows) {
    const missing = [];
    if (!androidTarget) missing.push("Android parity target");
    if (!iosImplementation) missing.push("iOS implementation");
    if (!evidence) missing.push("evidence");
    if (missing.length > 0) {
      fail(`docs/parity-checklist.md row "${area}" is missing ${missing.join(", ")}.`, failures);
    }

    const rowText = [androidTarget, iosImplementation, evidence].join(" ");
    if (/\b(TODO|TBD|unchecked|not checked|not verified|unverified)\b/i.test(rowText)) {
      fail(`docs/parity-checklist.md row "${area}" is not fully checked for both platforms.`, failures);
    }
  }
}

function checkStringKeyParity(failures) {
  const androidStringsPath = join(repoRoot, "android/app/src/main/res/values/strings.xml");
  const iosStringsPath = join(
    repoRoot,
    "ios/Sources/MaintenanceFieldApp/Resources/ko.lproj/Localizable.strings",
  );
  const iosOnlyStringKeys = {
    camera_unavailable: "iOS camera capability fallback copy",
    camera_open_settings: "iOS-only: deep-link to the Settings app for camera permission",
    capture_evidence: "SwiftUI alias for detail_capture_evidence",
    equipment: "SwiftUI detail label",
    error_invalid_user_id: "iOS-only login user-id format validation copy",
    error_network: "SwiftUI network error copy",
    location_consent_collection: "iOS base label; Android uses location_consent_collection_format",
    location_consent_state: "SwiftUI location-consent status label",
    messenger_search_no_results: "iOS messenger search empty-state copy",
    evidence_upload_failed: "iOS-only evidence upload failure copy",
    evidence_upload_retrying: "iOS-only evidence upload retry copy",
    offline_persistence_failed: "iOS-only offline persistence failure copy",
    operations_approval_submitted: "iOS-only operations approval confirmation copy",
    request_no: "SwiftUI detail label",
    result_type: "SwiftUI alias for report_result_type",
    session_invalidation_failed: "iOS-only Keychain session-deletion failure copy",
    site: "SwiftUI detail label",
    submit_report: "SwiftUI alias for detail_submit_report",
    symptom: "SwiftUI detail label",
    target_due: "SwiftUI detail label (target due date)",
    user_id: "SwiftUI alias for login_user_id_label",
  };

  const androidKeys = parseAndroidStringKeys(readFileSync(androidStringsPath, "utf8"));
  const iosKeys = parseIosStringKeys(readFileSync(iosStringsPath, "utf8"));
  const missingFromIos = [...androidKeys].filter((key) => !iosKeys.has(key)).sort();
  const undeclaredIosOnly = [...iosKeys]
    .filter((key) => !androidKeys.has(key) && !Object.hasOwn(iosOnlyStringKeys, key))
    .sort();

  if (missingFromIos.length > 0) {
    fail(`${iosStringsPath} is missing Android string keys: ${missingFromIos.join(", ")}`, failures);
  }

  if (undeclaredIosOnly.length > 0) {
    fail(`${iosStringsPath} has undeclared iOS-only string keys: ${undeclaredIosOnly.join(", ")}`, failures);
  }

  return {
    androidKeys: androidKeys.size,
    iosKeys: iosKeys.size,
    iosOnlyAliases: Object.keys(iosOnlyStringKeys).length,
  };
}

function runMobileParityGate() {
  console.log("\n== mobile parity checklist + native string-key gate ==");
  const failures = [];
  const checklistPath = join(repoRoot, "docs/parity-checklist.md");
  const checklist = readFileSync(checklistPath, "utf8");

  checkRequiredText(checklist, failures);
  checkChecklistRows(checklist, failures);
  const stringStats = checkStringKeyParity(failures);

  if (failures.length > 0) {
    console.error("Mobile parity gate failed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log(`Checked ${parseParityRows(checklist).length} parity rows across T1.7, T3.3, and T2.2.`);
  console.log(`Checked ${stringStats.androidKeys} Android string keys against ${stringStats.iosKeys} iOS keys.`);
  console.log(`Allowed ${stringStats.iosOnlyAliases} declared iOS-only aliases.`);
  console.log("Release evidence requirements and the COSS RN retirement boundary are present in docs/parity-checklist.md.");
}

const checks = [
  ["web", "web/scripts/check-ui-strings.mjs"],
  ["android", "scripts/check-android-ui-strings.mjs"],
  ["ios", "scripts/check-ios-ui-strings.mjs"],
];

for (const [name, script] of checks) {
  console.log(`\n== ${name} i18n check ==`);
  const result = spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

runMobileParityGate();

console.log("\nChecked web, Android, iOS, and ADR-0009 mobile parity gates.");
