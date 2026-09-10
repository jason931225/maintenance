#!/usr/bin/env node
// The committed hydration bundle must be the one this source produces.
//
// `backend/crates/payroll/ui/pkg/` holds a wasm binary and its JS glue that
// SHIP: `src/lib.rs` include_bytes! them into the server binary and serves them
// at /_ui/pkg. They are produced by tools/ui/build-payroll-wasm.sh, by hand.
// Nothing regenerated or checked them, so the committed bytes could drift from
// the source that is supposed to produce them -- and had: measured 640 bytes
// stale against its own toolchain pin before this gate existed (#1092).
//
// `backend/app/tests/health_readiness.rs` asserts the served bytes, which looks
// like it would catch this and cannot: it pins the COMMITTED bytes, not the
// bytes the source produces, so it passes with equal enthusiasm either way.
//
// What this checks, offline:
//   * every input's content, so editing the crate without rebundling fails
//   * the input SET, so adding or deleting a source file fails even if every
//     surviving file is untouched
//   * every output's content, so hand-editing the artifact fails
//   * the toolchain channel and the declared wasm-bindgen version, because both
//     change the bytes
//
// What it does NOT check, stated so it is not mistaken for more: a dependency
// bump reachable through Cargo.lock changes the emitted wasm without touching
// any file hashed here. Widening to the lock's dependency closure is possible;
// it is not done because it would fire on every unrelated backend dependency
// bump, and the failure this gate exists for is "edited the crate, forgot to
// rebundle". If lock-driven drift ever bites, tighten it then rather than
// claiming a coverage it does not have.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const CRATE = "backend/crates/payroll/ui";
const SRC = `${CRATE}/src`;
const CARGO = `${CRATE}/Cargo.toml`;
const MANIFEST = `${CRATE}/bundle.lock.json`;
const PIN = "rust-toolchain.toml";
const OUTPUTS = [
  `${CRATE}/pkg/console_payroll_ui_bg.wasm`,
  `${CRATE}/pkg/console_payroll_ui.js`,
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashFile = (rel) => sha256(readFileSync(join(REPO, rel)));

/** Every file under the crate's src/, sorted, repo-relative. */
function sourceFiles(dir = join(REPO, SRC), out = []) {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else out.push(relative(REPO, path));
  }
  return out;
}

function pinChannel() {
  const m = /^\s*channel\s*=\s*"([^"]+)"/m.exec(readFileSync(join(REPO, PIN), "utf8"));
  if (!m) throw new Error(`${PIN}: no channel`);
  return m[1];
}

/** The wasm-bindgen version the crate declares. The CLI that produced the
 *  bundle must match it -- bindgen's glue is version-coupled to its runtime. */
function bindgenVersion() {
  const m = /^\s*wasm-bindgen\s*=\s*\{[^}]*version\s*=\s*"([^"]+)"/m.exec(readFileSync(join(REPO, CARGO), "utf8"));
  if (!m) throw new Error(`${CARGO}: no wasm-bindgen version`);
  return m[1];
}

function describe() {
  const inputs = {};
  for (const rel of [CARGO, ...sourceFiles()]) inputs[rel] = hashFile(rel);
  const outputs = {};
  for (const rel of OUTPUTS) outputs[rel] = hashFile(rel);
  return {
    _comment: `Regenerate with: bash tools/ui/build-payroll-wasm.sh (it writes this file). Checked by scripts/${"check-wasm-bundle-drift.mjs"}.`,
    toolchain_channel: pinChannel(),
    wasm_bindgen: bindgenVersion(),
    inputs,
    outputs,
  };
}

const REBUILD = "Rebuild with: bash tools/ui/build-payroll-wasm.sh";

if (process.argv.includes("--write")) {
  writeFileSync(join(REPO, MANIFEST), `${JSON.stringify(describe(), null, 2)}\n`);
  const n = Object.keys(describe().inputs).length;
  console.log(`wrote ${MANIFEST}: ${n} inputs, ${OUTPUTS.length} outputs, channel ${pinChannel()}`);
  process.exit(0);
}

const failures = [];
let recorded = null;
try {
  recorded = JSON.parse(readFileSync(join(REPO, MANIFEST), "utf8"));
} catch {
  failures.push(`${MANIFEST} is missing or unparseable. ${REBUILD}`);
}

if (recorded) {
  const now = describe();

  if (recorded.toolchain_channel !== now.toolchain_channel) {
    failures.push(
      `the bundle was built with channel ${recorded.toolchain_channel} but ${PIN} says `
        + `${now.toolchain_channel}. A different compiler emits different wasm. ${REBUILD}`,
    );
  }
  if (recorded.wasm_bindgen !== now.wasm_bindgen) {
    failures.push(
      `the bundle was built with wasm-bindgen ${recorded.wasm_bindgen} but ${CARGO} declares `
        + `${now.wasm_bindgen}. The glue and the runtime are version-coupled. ${REBUILD}`,
    );
  }

  // Set equality first: a file added to src/ that nothing hashes is a change
  // the bundle silently does not contain.
  for (const rel of Object.keys(now.inputs)) {
    if (!Object.hasOwn(recorded.inputs ?? {}, rel)) {
      failures.push(`${rel} is a source file the committed bundle was not built from. ${REBUILD}`);
    }
  }
  for (const rel of Object.keys(recorded.inputs ?? {})) {
    if (!Object.hasOwn(now.inputs, rel)) {
      failures.push(`${rel} was built into the committed bundle but no longer exists. ${REBUILD}`);
    }
  }
  for (const [rel, hash] of Object.entries(recorded.inputs ?? {})) {
    if (Object.hasOwn(now.inputs, rel) && now.inputs[rel] !== hash) {
      failures.push(`${rel} has changed since the bundle was built. ${REBUILD}`);
    }
  }

  // The outputs themselves, so a hand-edited artifact is caught too.
  for (const rel of OUTPUTS) {
    const was = (recorded.outputs ?? {})[rel];
    if (!was) failures.push(`${MANIFEST} records no hash for ${rel}. ${REBUILD}`);
    else if (was !== now.outputs[rel]) {
      failures.push(`${rel} does not match the hash recorded when it was built — it was edited by hand or partially rebuilt. ${REBUILD}`);
    }
  }
}

if (failures.length) {
  console.error("Committed hydration bundle is stale:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`hydration bundle matches its source (channel ${recorded.toolchain_channel}, wasm-bindgen ${recorded.wasm_bindgen})`);
