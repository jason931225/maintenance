import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CRATE = "backend/crates/payroll/ui";
const MANIFEST = `${CRATE}/bundle.lock.json`;
const GATE = "scripts/check-wasm-bundle-drift.mjs";

/** A miniature repo carrying everything the gate reads, as a git repo.
 *
 * It must be a real repository because the gate asks `git ls-files` for the
 * source list rather than walking the directory -- CI only ever has tracked
 * files, and walking recorded whatever happened to be lying around (a Finder
 * visit put `.DS_Store` in the lock, and rebuilding regenerated it).
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wasm-drift-"));
  cpSync(join(ROOT, CRATE), join(dir, CRATE), { recursive: true });
  mkdirSync(join(dir, "tools/ui"), { recursive: true });
  cpSync(join(ROOT, "tools/ui/build-payroll-wasm.sh"), join(dir, "tools/ui/build-payroll-wasm.sh"));
  cpSync(join(ROOT, "backend/Cargo.toml"), join(dir, "backend/Cargo.toml"));
  cpSync(join(ROOT, "rust-toolchain.toml"), join(dir, "rust-toolchain.toml"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  cpSync(join(ROOT, GATE), join(dir, GATE));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("add", "-A");
  return dir;
}

/** Exit code of the gate against a fixture. 0 = the bundle was accepted. */
function gate(dir) {
  try {
    execFileSync("node", [join(dir, GATE)], { stdio: "pipe" });
    return 0;
  } catch (error) {
    return error.status;
  }
}

/** stderr of the gate, so a case can assert it failed for its OWN reason. */
function why(dir) {
  try {
    execFileSync("node", [join(dir, GATE)], { stdio: "pipe" });
    return "";
  } catch (error) {
    return String(error.stderr ?? "");
  }
}

const read = (dir, rel) => readFileSync(join(dir, rel), "utf8");
const write = (dir, rel, text) => writeFileSync(join(dir, rel), text);
const track = (dir) => execFileSync("git", ["-C", dir, "add", "-A"], { stdio: "pipe" });
const manifest = (dir, mutate) => {
  const m = JSON.parse(read(dir, MANIFEST));
  write(dir, MANIFEST, JSON.stringify(mutate(m) ?? m, null, 2));
};

describe("the committed hydration bundle cannot drift from its source", () => {
  // Each case names the check it is meant to exercise, and asserts on the
  // MESSAGE as well as the exit code. An earlier version asserted only
  // `exit != 0`, and two cases passed for reasons unrelated to their names:
  // the wasm-bindgen case was caught by the Cargo.toml input hash, and the
  // missing-manifest case was satisfied by an uncaught TypeError.
  const DRIFTS = {
    "the crate source is edited without rebundling": {
      drift: (d) => { write(d, `${CRATE}/src/lib.rs`, `${read(d, `${CRATE}/src/lib.rs`)}\n// edit\n`); track(d); },
      because: /src\/lib\.rs has changed/,
    },
    "a source file is added that the bundle was not built from": {
      drift: (d) => { write(d, `${CRATE}/src/new_island.rs`, "fn island() {}\n"); track(d); },
      because: /new_island\.rs is a source file the committed bundle was not built from/,
    },
    "a source file is deleted": {
      // The backstop for the skip-guard in the hash comparison: that loop only
      // compares files present in BOTH, so a deletion is invisible to it.
      drift: (d) => { rmSync(join(d, `${CRATE}/src/island_script.js`)); track(d); },
      because: /island_script\.js was built into the committed bundle but no longer exists/,
    },
    "the build recipe changes": {
      // The script is what turns sources into bytes -- `--release`, the feature
      // set, `--target web`. Its own header says "Do not commit debug wasm".
      drift: (d) => { write(d, "tools/ui/build-payroll-wasm.sh", `${read(d, "tools/ui/build-payroll-wasm.sh")}\n# tweak\n`); track(d); },
      because: /build-payroll-wasm\.sh has changed/,
    },
    "an artifact is edited by hand": {
      drift: (d) => { write(d, `${CRATE}/pkg/console_payroll_ui.js`, `${read(d, `${CRATE}/pkg/console_payroll_ui.js`)}\n// tweak\n`); track(d); },
      because: /console_payroll_ui\.js does not match the hash recorded/,
    },
    "the toolchain pin moves": {
      drift: (d) => { write(d, "rust-toolchain.toml", read(d, "rust-toolchain.toml").replace(/channel = "[^"]+"/, 'channel = "1.97.1"')); track(d); },
      because: /built with channel .* but rust-toolchain\.toml says/,
    },
    "the glue was emitted by a different wasm-bindgen CLI": {
      // Only the recorded CLI moves -- no input file is touched -- so this can
      // only pass if the CLI comparison itself fires.
      drift: (d) => manifest(d, (m) => { m.wasm_bindgen_cli = "0.2.99"; }),
      because: /emitted by wasm-bindgen CLI 0\.2\.99/,
    },
    "the manifest is missing": {
      drift: (d) => rmSync(join(d, MANIFEST)),
      because: /is missing or unparseable/,
    },
    "the manifest is truncated to a falsy scalar": {
      // `0`, `false` and `""` are valid JSON. A truthiness guard skipped every
      // check and printed success over a stale bundle.
      drift: (d) => write(d, MANIFEST, "0"),
      because: /is not a JSON object \(parsed as number\)/,
    },
    "the manifest is an array": {
      drift: (d) => write(d, MANIFEST, "[]"),
      because: /is not a JSON object \(parsed as an array\)/,
    },
    "the manifest records no wasm-bindgen version at all": {
      drift: (d) => manifest(d, (m) => { delete m.wasm_bindgen_cli; delete m.wasm_bindgen; }),
      because: /records no wasm-bindgen version/,
    },
  };

  for (const [name, { drift, because }] of Object.entries(DRIFTS)) {
    it(`rejects when ${name}`, () => {
      const dir = fixture();
      try {
        assert.equal(gate(dir), 0, "fixture should start clean");
        drift(dir);
        assert.notEqual(gate(dir), 0, `${name} passed the gate`);
        assert.match(why(dir), because, `${name} failed, but not for its own reason`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("ignores an untracked file that git would not ship", () => {
    // The .DS_Store loop: a Finder visit must not become a build input, or CI
    // fails telling the developer to rebuild and rebuilding re-poisons the lock.
    const dir = fixture();
    try {
      write(dir, `${CRATE}/src/.DS_Store`, "\0\0junk");
      assert.equal(gate(dir), 0, "an untracked stray file must not be treated as a source input");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts the committed bundle as it stands", () => {
    // The control. Without it every case above is satisfied by a gate that
    // rejects everything. It uses the real crate, so if this fails in CI the
    // bundle genuinely needs rebuilding -- not a fixture problem.
    const dir = fixture();
    try {
      assert.equal(
        gate(dir),
        0,
        "the committed bundle does not match its source. This is not a test-fixture bug: "
          + "run `bash tools/ui/build-payroll-wasm.sh` and commit the result.",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
