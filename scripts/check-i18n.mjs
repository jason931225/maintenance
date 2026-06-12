import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
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

console.log("\nChecked web, Android, and iOS UI string gates.");
