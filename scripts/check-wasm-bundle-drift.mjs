#!/usr/bin/env node
// The committed hydration bundle must be the one this source produces.
//
// `backend/crates/payroll/ui/pkg/` holds a wasm binary and its JS glue that
// SHIP: `src/lib.rs` include_bytes! them into the server binary and serves them
// at /_ui/pkg. They are produced by tools/ui/build-payroll-wasm.sh, by hand.
// Nothing regenerated or checked them, so the committed bytes could drift from
// the source that is supposed to produce them -- and had. Rebuilding under the
// pin this gate was added on moved the wasm from 373,332 to 383,081 bytes
// (#1092). An earlier revision of this comment said "640 bytes stale", a
// pre-bump figure that cannot be re-derived from this tree and that
// contradicted its own commit message; replaced with the number anyone here
// can reproduce.
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
//   * the toolchain channel, and the wasm-bindgen CLI that actually emitted the
//     glue, because both change the bytes
//
// Only GIT-TRACKED files under src/ are inputs, which would leave an untracked
// or gitignored source compiled by cargo and invisible here on both sides. That
// is not left as a residual: --write refuses outright when git reports anything
// under src/ it is not listing (see sourceFiles), so the blind manifest cannot
// be written in the first place.
//
// What it does NOT check, stated so it is not mistaken for more:
//   * anything reached through dependency resolution: Cargo.lock, and the
//     `[workspace.dependencies]` this crate inherits `serde` from. Widening to
//     either would fire on every unrelated backend bump, and the failure this
//     gate exists for is "edited the crate, forgot to rebundle". The existing
//     assertions in src/lib.rs are the tripwire for that case -- they bind the
//     SSR-emitted island name to both committed artifacts, so a dependency
//     change that moved the island hash fails there.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CRATE = "backend/crates/payroll/ui";
const SRC = `${CRATE}/src`;
const CARGO = `${CRATE}/Cargo.toml`;
const MANIFEST = `${CRATE}/bundle.lock.json`;
const PIN = "rust-toolchain.toml";
// The recipe is an input too. `--release`, `--no-default-features
// --features hydrate,islands` and `--target web` all determine the bytes, so a
// bundle can go stale against its own build script with every source file
// untouched -- and that script's own header says "Do not commit debug wasm"
// with nothing enforcing it. Two touches in the last 200 commits, and directly
// causal.
//
// `backend/Cargo.toml` was here briefly and is deliberately NOT: 60 touches
// over the same window, four times the crate's own source, while the only
// thing it contributes to the wasm build is `serde` and the edition -- `axum`
// is optional and off under `--no-default-features --features hydrate,islands`.
// Hashing that would train people to rebuild-and-commit as a reflex on
// unrelated backend PRs, which is how a gate stops being read. Recorded as a
// residual below instead.
const RECIPE = ["tools/ui/build-payroll-wasm.sh"];
const OUTPUTS = [
  `${CRATE}/pkg/console_payroll_ui_bg.wasm`,
  `${CRATE}/pkg/console_payroll_ui.js`,
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** null when the file is listed but not on disk -- a `git rm`-less delete or a
 *  partial checkout. That is an ordinary intermediate state, and throwing a raw
 *  ENOENT from node:fs meant the "no longer exists" message that should fire
 *  never got the chance. */
const hashFile = (rel) => {
  try {
    return sha256(readFileSync(join(REPO, rel)));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

/** The crate's tracked source files, repo-relative and sorted.
 *
 * Asks git rather than walking the filesystem, because CI only ever has
 * tracked files and the manifest must describe what CI will see. Walking
 * recorded whatever happened to be lying in the directory: a Mac developer who
 * opened src/ in Finder got `.DS_Store` hashed into the lock, CI then failed
 * telling them to rebuild, and rebuilding on their machine regenerated the
 * same poisoned lock. Fail-closed, but a loop -- and `.swp`, `.orig` and vim's
 * `4913` do the same.
 */
const ANCHOR = `${SRC}/lib.rs`;
// What cargo actually compiles into the bundle. Used to decide whether a file
// git is hiding matters -- `.DS_Store` is ignored and irrelevant, `generated.rs`
// is ignored and compiled.
const COMPILED = /\.(rs|js)$/;

function git(...args) {
  try {
    return execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      .split("\0").filter(Boolean).sort();
  } catch (error) {
    // No .git (a tarball, a Docker COPY, an archive export) or no git binary.
    // Named, because the alternative was a raw execFileSync stack trace.
    throw new Error(`could not read ${SRC} with git (${String(error.stderr ?? error.message).trim()}). This gate needs a checkout with .git.`);
  }
}

/** The crate's tracked sources.
 *
 * `strict` is for --write only. The write side is where blindness gets baked in
 * permanently -- a manifest recorded from a partial listing accepts every later
 * edit to the files it never saw. The check side already fails closed on a
 * shrinking set, and a developer with an unrelated scratch file under src/
 * should not get a hard failure on an otherwise-valid committed bundle.
 */
function sourceFiles({ strict = false } = {}) {
  const files = git("ls-files", "-z", SRC);

  // The degenerate case: no listing at all. Named after a file so the message
  // says which, rather than reporting a count nobody can act on.
  if (!files.includes(ANCHOR)) {
    throw new Error(
      `git listed ${files.length} file(s) under ${SRC} and ${ANCHOR} was not among them. `
        + "Refusing to describe a bundle whose sources cannot be enumerated -- a manifest "
        + "written from an empty listing would silently accept every later edit.",
    );
  }
  if (!strict) return files;

  // The anchor alone is too weak, and only asks "is ONE file tracked?". The
  // question that matters is "is anything under src/ invisible to me?", and git
  // answers it exactly rather than by heuristic. A minimum count would be a
  // magic number to maintain; comparing against the manifest would be circular,
  // since the manifest is what is being written.
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z", "--", SRC);
  if (untracked.length) {
    throw new Error(
      `untracked file(s) under ${SRC}: ${untracked.join(", ")}. cargo compiles what is on disk, `
        + "but only tracked files are recorded, so the manifest would describe a bundle built "
        + "from more than it lists. Commit them or remove them, then rebuild.",
    );
  }
  // Ignored-and-compiled is the nastier twin: invisible to `ls-files` on BOTH
  // sides, so it never surfaces later either. Filtered to what cargo compiles,
  // because `.DS_Store` is ignored too and is exactly the noise this must not
  // reintroduce.
  const hidden = git("ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", SRC).filter((f) => COMPILED.test(f));
  if (hidden.length) {
    throw new Error(
      `gitignored source file(s) under ${SRC}: ${hidden.join(", ")}. cargo compiles them and git `
        + "never lists them, so they would be absent from the manifest permanently -- an edit to "
        + "one would never fail this gate. Un-ignore them or move them out of the crate.",
    );
  }
  return files;
}

function pinChannel() {
  const m = /^\s*channel\s*=\s*"([^"]+)"/m.exec(readFileSync(join(REPO, PIN), "utf8"));
  if (!m) throw new Error(`${PIN}: no channel`);
  return m[1];
}

/** The wasm-bindgen version the crate DECLARES. */
function declaredBindgen() {
  const m = /^\s*wasm-bindgen\s*=\s*\{[^}]*version\s*=\s*"([^"]+)"/m.exec(readFileSync(join(REPO, CARGO), "utf8"));
  if (!m) throw new Error(`${CARGO}: no wasm-bindgen version`);
  return m[1];
}

/** The wasm-bindgen CLI that is about to emit the glue.
 *
 * Recorded at --write time and compared against the declaration at check time.
 * Recording only the declared version would have been decorative: Cargo.toml
 * is already hashed as an input, so no state exists where a declaration check
 * fires and the input hash does not. The CLI is the actual free variable --
 * build-payroll-wasm.sh states "CLI wasm-bindgen must match Cargo.toml" as
 * prose, and nothing enforced it.
 */
function cliBindgen() {
  let out;
  try {
    out = execFileSync("wasm-bindgen", ["--version"], { encoding: "utf8" }).trim();
  } catch (error) {
    // Only --write needs this, and --write runs from build-payroll-wasm.sh
    // immediately after wasm-bindgen produced the glue. Reaching here means
    // someone is regenerating the manifest without the tool that builds the
    // bundle, which would record a version nothing emitted.
    throw new Error(
      `\`wasm-bindgen --version\` failed (${error.code ?? error.message}). `
        + `The manifest records the CLI that emitted the glue, so it cannot be written without it. `
        + `Install wasm-bindgen ${declaredBindgen()} to match ${CARGO}.`,
    );
  }
  const m = /(\d+\.\d+\.\d+\S*)/.exec(out);
  if (!m) throw new Error(`could not read a version from \`wasm-bindgen --version\`: ${out}`);
  return m[1];
}

function inputHashes({ strict = false } = {}) {
  const inputs = {};
  for (const rel of [...RECIPE, CARGO, ...sourceFiles({ strict })].sort()) inputs[rel] = hashFile(rel);
  return inputs;
}

/** `cli` is supplied only by --write. The check path deliberately omits it:
 *  nothing reads `now.wasm_bindgen_cli`, and defaulting it to the declared
 *  version would be a field asserting a CLI version it never asked a CLI for. */
function describe({ cli, strict = false } = {}) {
  const outputs = {};
  for (const rel of OUTPUTS) outputs[rel] = hashFile(rel);
  return {
    _comment: "Regenerate with: bash tools/ui/build-payroll-wasm.sh (it writes this file). Checked by scripts/check-wasm-bundle-drift.mjs.",
    toolchain_channel: pinChannel(),
    // What the crate declares; and, on write, the CLI that actually emitted the
    // glue. The check compares the recorded CLI against the declaration.
    wasm_bindgen: declaredBindgen(),
    ...(cli ? { wasm_bindgen_cli: cli } : {}),
    inputs: inputHashes({ strict }),
    outputs,
  };
}

const REBUILD = "Rebuild with: bash tools/ui/build-payroll-wasm.sh";

if (process.argv.includes("--write")) {
  const written = describe({ cli: cliBindgen(), strict: true });
  writeFileSync(join(REPO, MANIFEST), `${JSON.stringify(written, null, 2)}\n`);
  const n = Object.keys(written.inputs).length;
  console.log(
    `wrote ${MANIFEST}: ${n} inputs, ${OUTPUTS.length} outputs, channel ${written.toolchain_channel}, `
      + `wasm-bindgen CLI ${written.wasm_bindgen_cli}`,
  );
  process.exit(0);
}

const failures = [];
let recorded = null;
try {
  const parsed = JSON.parse(readFileSync(join(REPO, MANIFEST), "utf8"));
  // A FALSY-BUT-VALID document is the fail-open case. `0`, `false` and `""` are
  // all legal JSON, so `JSON.parse` returns without throwing, and an
  // `if (recorded)` guard then skipped every check below and printed success
  // over a stale bundle -- a manifest truncated to `0` by a bad merge or a
  // partial write would have shipped silently. The shape is checked, not the
  // truthiness: an array is rejected too, since `recorded.inputs` on one is
  // `undefined` rather than an error.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    failures.push(`${MANIFEST} is not a JSON object (parsed as ${Array.isArray(parsed) ? "an array" : typeof parsed}). ${REBUILD}`);
  } else {
    recorded = parsed;
  }
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
  // The CLI that actually emitted the glue, against what the crate declares.
  // This is the non-redundant half: `wasm_bindgen` alone could never fire
  // without the Cargo.toml input hash firing first, because Cargo.toml is
  // itself a hashed input. The CLI is a machine-local variable nothing else
  // records, and build-payroll-wasm.sh only asks for the match in prose.
  // No `?? recorded.wasm_bindgen` fallback. It looked like back-compat and was
  // a hole: deleting only `wasm_bindgen_cli` degraded to the comparison that
  // cannot fire (Cargo.toml is already a hashed input), so the one
  // non-redundant check switched itself off. There are no legacy manifests to
  // protect either -- `--write` has always recorded the CLI, and cliBindgen()
  // throws rather than defaulting, so every manifest this tool ever wrote has
  // the field.
  const builtWith = recorded.wasm_bindgen_cli;
  if (!builtWith) {
    failures.push(`${MANIFEST} records no wasm-bindgen version. ${REBUILD}`);
  } else if (builtWith !== now.wasm_bindgen) {
    failures.push(
      `the bundle's glue was emitted by wasm-bindgen CLI ${builtWith} but ${CARGO} declares `
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
