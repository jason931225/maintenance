import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const SCRIPT = new URL("./canary-verdict.sh", import.meta.url).pathname;
const PREFIX = "nativelink-cas-linux-x64-rustc-1.100.0-nightly-a36d05efa-";

/** Run the verdict with fixture files; returns { status, out }. */
function verdict({ restored = "", log = "Cache hits: 0%", keys = null }) {
  const dir = mkdtempSync(join(tmpdir(), "canary-"));
  try {
    const logPath = join(dir, "buck.log");
    writeFileSync(logPath, `${log}\nCommands: 97 (cached: 0, remote: 0, local: 97)\n`);
    const args = ["--restored", restored, "--prefix", PREFIX, "--log", logPath];
    if (keys !== null) {
      const keysPath = join(dir, "keys.txt");
      writeFileSync(keysPath, keys.length ? `${keys.join("\n")}\n` : "");
      args.push("--keys", keysPath);
    }
    try {
      return { status: 0, out: execFileSync(SCRIPT, args, { encoding: "utf8" }) };
    } catch (error) {
      return { status: error.status, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("cas canary verdict", () => {
  // The two outcomes that already existed. Unchanged behaviour, pinned so the
  // refactor cannot quietly alter what a restored cache means.
  it("passes when a cache was restored and produced hits", () => {
    const r = verdict({ restored: `${PREFIX}123`, log: "Cache hits: 86%" });
    assert.equal(r.status, 0);
    assert.match(r.out, /OK: this PR reused the cache dev seeded/);
  });

  it("fails when a cache was restored but produced no hits", () => {
    const r = verdict({ restored: `${PREFIX}123`, log: "Cache hits: 0%" });
    assert.equal(r.status, 1);
    assert.match(r.out, /REGRESSION/);
  });

  // The three that used to be indistinguishable. This is the whole point:
  // each must reach a DIFFERENT outcome, and exactly one of them must fail.
  it("FAILS when a seed exists under this prefix but nothing was restored", () => {
    // A restore failure, not a missing seed. Previously green.
    const r = verdict({ keys: [`${PREFIX}999`, "nativelink-cas-linux-x64-rustc-1.97.1-8bab26f4f-1"] });
    assert.equal(r.status, 1, "a broken restore must fail");
    assert.match(r.out, /BROKEN/);
  });

  it("passes, saying so, when only OTHER compilers have seeds", () => {
    // Every toolchain roll lands here. Legitimately green -- but it must say
    // which of the three it is, or it is the silent green all over again.
    const r = verdict({ keys: ["nativelink-cas-linux-x64-rustc-1.97.1-8bab26f4f-1"] });
    assert.equal(r.status, 0);
    assert.match(r.out, /NEW PREFIX/);
    assert.doesNotMatch(r.out, /BROKEN/);
  });

  it("passes, saying so, when no nativelink cache exists at all", () => {
    const r = verdict({ keys: [] });
    assert.equal(r.status, 0);
    assert.match(r.out, /NO SEED AT ALL/);
  });

  it("does not claim a cache assertion when the cache list is unreadable", () => {
    // gh api failed. Cannot tell broken from missing, so it must not imply it
    // checked anything -- but must not turn an API hiccup into a red build.
    const r = verdict({});
    assert.equal(r.status, 0);
    assert.match(r.out, /COULD NOT DETERMINE/);
  });

  it("refuses to run without a prefix rather than guessing one", () => {
    try {
      execFileSync(SCRIPT, ["--log", "/dev/null"], { encoding: "utf8" });
      assert.fail("expected a non-zero exit");
    } catch (error) {
      assert.equal(error.status, 2);
    }
  });
});
