import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const CRATE = "backend/crates/payroll/ui";
const GATE = join(ROOT, "scripts/check-wasm-bundle-drift.mjs");

/** A copy of the real crate, pin and gate, so drift can be injected safely.
 *
 * The gate resolves the repository from its own path, so it is copied into the
 * fixture rather than pointed at one. Everything here is small: the crate's
 * src/, its Cargo.toml, the two committed artifacts and the pin.
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wasm-drift-"));
  cpSync(join(ROOT, CRATE), join(dir, CRATE), { recursive: true });
  cpSync(join(ROOT, "rust-toolchain.toml"), join(dir, "rust-toolchain.toml"));
  cpSync(GATE, join(dir, "scripts/check-wasm-bundle-drift.mjs"), { recursive: false, force: true });
  return dir;
}

/** Exit code of the gate against a fixture. 0 = the bundle was accepted. */
function gate(dir) {
  try {
    execFileSync("node", [join(dir, "scripts/check-wasm-bundle-drift.mjs")], { stdio: "pipe" });
    return 0;
  } catch (error) {
    return error.status;
  }
}

const read = (dir, rel) => readFileSync(join(dir, rel), "utf8");
const write = (dir, rel, text) => writeFileSync(join(dir, rel), text);

describe("the committed hydration bundle cannot drift from its source", () => {
  // The bundle SHIPS: src/lib.rs include_bytes! these and serves them at
  // /_ui/pkg. Every case below is a way the committed bytes stop being the ones
  // this source produces. `health_readiness.rs` looks like it covers this and
  // does not -- it compares the served bytes to the same include_bytes!, so it
  // passes whatever those bytes are.
  const DRIFTS = {
    "the crate source is edited without rebundling":
      (d) => write(d, `${CRATE}/src/lib.rs`, `${read(d, `${CRATE}/src/lib.rs`)}\n// edit\n`),
    "a source file is added that the bundle was not built from":
      (d) => write(d, `${CRATE}/src/new_island.rs`, "fn island() {}\n"),
    "an artifact is edited by hand":
      (d) => write(d, `${CRATE}/pkg/console_payroll_ui.js`, `${read(d, `${CRATE}/pkg/console_payroll_ui.js`)}\n// tweak\n`),
    "the toolchain pin moves":
      (d) => write(d, "rust-toolchain.toml", read(d, "rust-toolchain.toml").replace(/channel = "[^"]+"/, 'channel = "1.97.1"')),
    "the declared wasm-bindgen version changes":
      (d) => write(d, `${CRATE}/Cargo.toml`, read(d, `${CRATE}/Cargo.toml`).replace(/(wasm-bindgen = \{ version = ")[^"]+/, "$10.2.999")),
    "the manifest is missing":
      (d) => rmSync(join(d, `${CRATE}/bundle.lock.json`)),
  };

  for (const [name, drift] of Object.entries(DRIFTS)) {
    it(`rejects when ${name}`, () => {
      const dir = fixture();
      try {
        assert.equal(gate(dir), 0, "fixture should start clean");
        drift(dir);
        assert.notEqual(gate(dir), 0, `${name} passed the gate`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

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
