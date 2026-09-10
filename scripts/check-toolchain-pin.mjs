#!/usr/bin/env node
// One Rust version, one file, enforced.
//
// Before 2026-09-10 the version lived as a literal in 13 workflow steps, in a
// foundation gate, and in `backend/rust-toolchain.toml` -- which, being nested,
// did not govern the root-cwd invocations CI actually uses. Buck2's
// `system_rust_toolchain` took a fourteenth version: whatever the runner image
// shipped. Four different compilers, one of which was nondeterministic.
//
// The literals are gone. This gate is what stops the next one, because a
// convention nothing checks is a convention that lasts until the next hurry.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const PIN = "rust-toolchain.toml";
const failures = [];

// --- the pin itself ---------------------------------------------------------
let channel = null;
try {
  const text = readFileSync(join(REPO, PIN), "utf8");
  const lines = text.split("\n").filter((l) => /^\s*channel\s*=/.test(l));
  if (lines.length !== 1) {
    failures.push(`${PIN} must declare exactly one channel; found ${lines.length}`);
  } else {
    const m = /^\s*channel\s*=\s*"([^"]+)"/.exec(lines[0]);
    if (!m) failures.push(`${PIN}: channel must be a double-quoted string`);
    else channel = m[1];
  }
} catch {
  failures.push(`${PIN} is missing from the repository root — it is the only place a Rust version may live`);
}

// A nested copy shadows the root one for anything run inside its directory,
// which is exactly how the pre-2026-09-10 `backend/rust-toolchain.toml` came to
// govern developer shells while governing none of CI.
const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", ".git", "buck-out", "target", "third-party"].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry === "rust-toolchain.toml" || entry === "rust-toolchain") out.push(relative(REPO, full));
  }
  return out;
};
const pins = walk(REPO);
if (pins.length !== 1 || pins[0] !== PIN) {
  failures.push(`exactly one toolchain file, at the repo root, is allowed; found: ${pins.join(", ") || "none"}`);
}

// --- no version may be named anywhere else ----------------------------------
// A bare `1.2.3` is far too common to ban outright, so this looks for the two
// shapes that actually caused the drift: a `toolchain:` input, and a dated
// nightly. Both are unambiguous.
const SCAN_DIRS = [".github"];
const VERSION_SHAPES = [
  { re: /^\s*toolchain:\s*["']?(?!\$\{\{)([^\s"']+)/gm, what: "a `toolchain:` input naming a version" },
  { re: /\bnightly-\d{4}-\d{2}-\d{2}\b/g, what: "a dated nightly literal" },
];
const scan = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) scan(full, out);
    else if (/\.(ya?ml|sh|mjs|js)$/.test(entry)) out.push(full);
  }
  return out;
};
for (const file of SCAN_DIRS.flatMap((d) => scan(join(REPO, d)))) {
  const rel = relative(REPO, file);
  // The action that READS the pin is the one place allowed to name it.
  if (rel === ".github/actions/setup-rust/action.yml") continue;
  const text = readFileSync(file, "utf8");
  for (const { re, what } of VERSION_SHAPES) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      failures.push(`${rel}: ${what} (${m[0].trim()}). Use \`uses: ./.github/actions/setup-rust\`; the version comes from ${PIN}.`);
    }
  }
}

if (failures.length) {
  console.error("Rust toolchain pin contract failed:");
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}
console.log(`Rust toolchain pin: one source of truth, channel = ${channel}`);
