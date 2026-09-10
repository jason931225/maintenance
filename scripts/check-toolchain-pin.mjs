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
//
// Scope, stated so it is not mistaken for more than it is: this scans `.github`
// for YAML and shell shapes. A version in a Dockerfile, a Python script, or a
// path outside `.github` is NOT caught, and a toolchain file under
// `third-party/` is deliberately excluded because vendored crates carry their
// own. Widening the scan is cheap; claiming a coverage it does not have is not.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const PIN = "rust-toolchain.toml";
const failures = [];

// --- the pin must be EXACT --------------------------------------------------
// A floating channel (`nightly`, `stable`, `beta`) names a different compiler
// on different days. It cannot be hash-pinned, and a lock generated against one
// records hashes that silently stop describing what the name resolves to. The
// whole design -- compiler bytes inside the action digest -- requires that the
// channel and the compiler are the same fact.
const EXACT_CHANNEL = /^(\d+\.\d+(\.\d+)?|nightly-\d{4}-\d{2}-\d{2})$/;

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
    else {
      channel = m[1];
      if (!EXACT_CHANNEL.test(channel)) {
        failures.push(
          `${PIN}: channel "${channel}" is not exact. Use x.y.z or nightly-YYYY-MM-DD — `
            + "a floating channel cannot be hash-pinned, so the lock would describe a compiler the name no longer resolves to.",
        );
      }
    }
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
  // A `toolchain:` input. `${{ ... }}` is NOT exempted: wrapping the literal in
  // an expression (`${{ '1.99.0' }}`, or an `env.RUST_VERSION` set two lines
  // up) is the realistic way a version re-enters, and an earlier revision of
  // this gate exempted exactly that. The one allowed expression is the
  // action's own output, matched precisely rather than by shape.
  {
    re: /^\s*toolchain:\s*(?!\$\{\{\s*steps\.pin\.outputs\.channel\s*\}\}\s*$)(\S.*)$/gm,
    what: "a `toolchain:` input naming a version",
  },
  { re: /\bnightly-\d{4}-\d{2}-\d{2}\b/g, what: "a dated nightly literal" },
  // `run:` blocks were unscanned, and `rustup toolchain install` already
  // appears in one (ci.yml, for reindeer's separately locked compiler). A
  // version handed to rustup in a shell step is every bit as much a second
  // source of truth as one in a `with:` block.
  {
    re: /\brustup\s+(?:default|toolchain\s+install|override\s+set)\s+(?!"?\$)([0-9]+\.[0-9]+(?:\.[0-9]+)?|nightly|beta|stable)\b/g,
    what: "a rustup invocation naming a version in a shell step",
  },
];
const scan = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) scan(full, out);
    else if (/\.(ya?ml|sh|mjs|js)$/.test(entry)) out.push(full);
  }
  return out;
};
// Reindeer bootstraps the third-party graph with its OWN deliberately locked
// compiler (`REINDEER_TOOLCHAIN` in third-party/rust/reindeer/upstream.lock),
// invoked through `rustup run` so it never becomes the ambient toolchain. That
// is a fifth Rust version in this repository and it is intentional; this gate
// governs the compiler that builds console's own code, not that one.
const REINDEER_PIN = "third-party/rust/reindeer/upstream.lock";
const ALLOWED = new Set([
  // The action that READS the pin is the one place allowed to name it.
  ".github/actions/setup-rust/action.yml",
]);
for (const file of SCAN_DIRS.flatMap((d) => scan(join(REPO, d)))) {
  const rel = relative(REPO, file);
  if (ALLOWED.has(rel)) continue;
  const text = readFileSync(file, "utf8");
  for (const { re, what } of VERSION_SHAPES) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      // The reindeer bootstrap reads its version from its own lockfile rather
      // than naming one, so it does not match these shapes -- but a future
      // edit that inlines it should be told where the carve-out is recorded.
      const line = m[0].trim();
      if (line.includes("REINDEER_TOOLCHAIN")) continue;
      failures.push(`${rel}: ${what} (${line}). Use \`uses: ./.github/actions/setup-rust\`; the version comes from ${PIN}, except reindeer's separately locked bootstrap compiler in ${REINDEER_PIN}.`);
    }
  }
}

// --- the lock must be derived FROM the pin, not maintained beside it --------
// The lock carries urls and sha256s for the compiler buck2 materializes. If it
// drifts from the pin, buck2 builds with one compiler while CI installs another
// -- which is the exact divergence this whole design removes, reintroduced one
// level down. Checked by content rather than by regenerating: this gate must
// not reach the network.
const LOCK = "toolchains/rust/lock.bzl";
try {
  const lockText = readFileSync(join(REPO, LOCK), "utf8");
  const declared = /^RUST_CHANNEL = "([^"]+)"/m.exec(lockText);
  if (!declared) {
    failures.push(`${LOCK}: no RUST_CHANNEL — regenerate with node scripts/lock-rust-toolchain.mjs`);
  } else if (channel && declared[1] !== channel) {
    failures.push(
      `${LOCK} is locked to ${declared[1]} but ${PIN} says ${channel}. `
        + "Regenerate with: node scripts/lock-rust-toolchain.mjs",
    );
  }
  // Every artifact must carry a hash. An entry without one is a download this
  // build cannot verify, which is the property the lock exists to provide.
  const urls = (lockText.match(/^\s+"url":/gm) ?? []).length;
  const hashes = (lockText.match(/^\s+"sha256":/gm) ?? []).length;
  if (urls === 0) failures.push(`${LOCK}: no artifacts locked`);
  if (urls !== hashes) failures.push(`${LOCK}: ${urls} urls but ${hashes} sha256s — every artifact must be hash-pinned`);
} catch {
  failures.push(`${LOCK} is missing — generate it with node scripts/lock-rust-toolchain.mjs`);
}

if (failures.length) {
  console.error("Rust toolchain pin contract failed:");
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}
console.log(`Rust toolchain pin: one source of truth, channel = ${channel}`);
