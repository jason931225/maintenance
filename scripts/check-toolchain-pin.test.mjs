import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import yaml from "js-yaml";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const ACTION = yaml.load(readFileSync(join(ROOT, ".github/actions/setup-rust/action.yml"), "utf8"));
const PIN = readFileSync(join(ROOT, "rust-toolchain.toml"), "utf8");

/** Run the action's OWN parse step against a pin file, exactly as CI does. */
function runParse(pinText) {
  const dir = mkdtempSync(join(tmpdir(), "pin-"));
  try {
    writeFileSync(join(dir, "rust-toolchain.toml"), pinText);
    const out = join(dir, "out");
    writeFileSync(out, "");
    const step = ACTION.runs.steps.find((s) => s.id === "pin");
    const result = execFileSync("bash", ["-c", step.run], {
      env: { ...process.env, GITHUB_WORKSPACE: dir, GITHUB_OUTPUT: out },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const kv = Object.fromEntries(
      readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => {
        const at = l.indexOf("=");
        return [l.slice(0, at), l.slice(at + 1)];
      }),
    );
    return { kv, stdout: result };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("setup-rust reads the whole pin", () => {
  it("extracts channel, components and targets from the repository's own pin", () => {
    // The dimension that actually broke: an earlier revision installed the
    // channel and nothing else, so rustup tried to complete the toolchain
    // inside a buck2 build action and failed with `component download failed`.
    const { kv } = runParse(PIN);
    assert.equal(kv.channel, /channel\s*=\s*"([^"]+)"/.exec(PIN)[1]);
    assert.equal(kv.components, "rustfmt,clippy");
    assert.equal(kv.targets, "wasm32-unknown-unknown");
  });

  it("hands every declared component and target to the installer", () => {
    // Parsing them is useless if they are not passed on. This is the link that
    // was missing, and it is asserted structurally because the runner-side
    // proof cannot run here.
    const install = ACTION.runs.steps.find((s) => typeof s.uses === "string" && s.uses.includes("rust-toolchain@"));
    assert.match(install.with.toolchain, /steps\.pin\.outputs\.channel/);
    assert.match(install.with.components, /steps\.pin\.outputs\.components/);
    assert.match(install.with.targets, /steps\.pin\.outputs\.targets/);
  });

  it("re-proves on the runner that nothing is left to download", () => {
    // The behavioural half. It must run from the workspace and WITHOUT
    // RUSTUP_TOOLCHAIN, or it exercises the cargo path while buck2 takes the
    // toolchain-file path -- which is exactly how the broken revision reported
    // success while every buck2 rustc action was failing.
    const proof = ACTION.runs.steps.at(-1);
    assert.match(proof["working-directory"], /github\.workspace/);
    assert.doesNotMatch(proof.run, /RUSTUP_TOOLCHAIN=/, "must not pin the env var it is meant to test without");
    assert.match(proof.run, /downloading\|installing\|syncing/);
    assert.match(proof.run, /target-libdir/);
  });

  it("takes no inputs, so no job can declare a second toolchain", () => {
    assert.equal(Object.keys(ACTION.inputs ?? {}).length, 0);
  });

  it("refuses a pin it cannot read, rather than guessing", () => {
    for (const [name, text] of [
      ["two channels", '[toolchain]\nchannel = "1.0.0"\nchannel = "2.0.0"\n'],
      ["no channel", "[toolchain]\ncomponents = []\n"],
      ["single-quoted", "[toolchain]\nchannel = '1.0.0'\n"],
    ]) {
      assert.throws(() => runParse(text), name);
    }
  });

  it("accepts a pin with no components or targets", () => {
    const { kv } = runParse('[toolchain]\nchannel = "1.0.0"\n');
    assert.equal(kv.channel, "1.0.0");
    assert.equal(kv.components, "");
    assert.equal(kv.targets, "");
  });
});

const REAL_LOCK = readFileSync(join(ROOT, "toolchains/rust/lock.bzl"), "utf8");

/** A minimal repo the gate can scan: a valid pin, a lock, one workflow.
 *
 * `mutate` exists because an earlier version of this harness copied the real
 * lock verbatim into every case, so every corpus entry ran against a lock that
 * passes -- leaving the three lock checks with no coverage at all, which is
 * exactly where the `field indentation` bypass below was found.
 */
function craft(workflow, mutate = (t) => t) {
  const dir = mkdtempSync(join(tmpdir(), "pin-gate-"));
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  mkdirSync(join(dir, "toolchains/rust"), { recursive: true });
  writeFileSync(join(dir, "rust-toolchain.toml"), PIN);
  writeFileSync(join(dir, "toolchains/rust/lock.bzl"), mutate(REAL_LOCK));
  writeFileSync(join(dir, ".github/workflows/probe.yml"), workflow);
  return dir;
}

/** Exit code of the real gate against a crafted tree. 0 = the input passed. */
function gate(dir) {
  try {
    execFileSync("node", [join(ROOT, "scripts/check-toolchain-pin.mjs"), "--root", dir], { stdio: "pipe" });
    return 0;
  } catch (e) {
    return e.status;
  }
}

describe("the pin gate cannot be walked past", () => {
  // Every one of these passed an earlier revision of this gate. They are kept
  // as a corpus rather than a changelog: a gate is only worth its exit code if
  // something is known to make it non-zero, and the shapes are easy to narrow
  // by accident when adding the next one.
  const BYPASSES = {
    "a toolchain: input": "        toolchain: 1.99.0",
    "a trailing comment invoking the reindeer carve-out": "        toolchain: 1.99.0 # REINDEER_TOOLCHAIN",
    "a version reaching rustup through a shell variable":
      "    env:\n      RUST_VERSION: 1.99.0\n    steps:\n      - run: rustup default \"$RUST_VERSION\"",
    "rustup install": "      - run: rustup install 1.99.0",
    "rustup-init --default-toolchain": "      - run: rustup-init -y --default-toolchain 1.99.0",
    "a third-party action pinned to a version": "      - uses: dtolnay/rust-toolchain@1.99.0",
    "RUSTUP_TOOLCHAIN as a literal": "    env:\n      RUSTUP_TOOLCHAIN: 1.99.0",
    "rustup component add --toolchain": "      - run: rustup component add clippy --toolchain 1.99.0",
    "a rust: container image": "    container: rust:1.96",
  };
  for (const [name, workflow] of Object.entries(BYPASSES)) {
    it(`rejects ${name}`, () => {
      const dir = craft(workflow);
      try {
        assert.notEqual(gate(dir), 0, `${name} passed the gate`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  // The other half: a gate that fails on everything is equally useless, and
  // reindeer's separately locked bootstrap compiler is a legitimate fifth Rust
  // version that MUST keep working.
  const ALLOWED = {
    "reindeer's bootstrap, which names no version": '      - run: rustup run "$REINDEER_TOOLCHAIN" cargo build',
    "an action pinned to a floating ref": "      - uses: dtolnay/rust-toolchain@master",
    "a container image that is not rust": "    container: node:22",
  };
  for (const [name, workflow] of Object.entries(ALLOWED)) {
    it(`allows ${name}`, () => {
      const dir = craft(workflow);
      try {
        assert.equal(gate(dir), 0, `${name} was wrongly rejected`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe("the lock cannot drift from the pin", () => {
  const OK = "name: probe\n";

  // The lock carries the compiler buck2 materializes. Every one of these
  // produces a lock that is internally consistent and self-describing -- the
  // failure mode is not corruption, it is a lock that quietly names a
  // DIFFERENT compiler than the one CI installs. That is #1083's divergence
  // one level down, so each of these must be a non-zero exit.
  const DRIFTS = {
    // The headline scenario: RUST_CHANNEL still reads the pinned channel.
    "urls pointing at another month": (t) => t.replace(/dist\/2026-\d\d-\d\d\//g, "dist/2026-08-01/"),
    "a strip_prefix that does not match the archive layout":
      (t) => t.replace(/"strip_prefix": "([^"]*)\/rustc"/, '"strip_prefix": "$1/rustc-aarch64-apple-darwin"'),
    "a required artifact removed": (t) => t.replace(/ {4}"rustfmt-preview": \{[\s\S]*?\n {4}\},\n/, ""),
    "an artifact the pin does not call for": (t) => t.replace(
      / {4}"rustc": \{/,
      '    "miri-preview": {\n        "aarch64-apple-darwin": {\n'
        + '            "url": "https://static.rust-lang.org/dist/2026-09-10/miri-nightly-aarch64-apple-darwin.tar.xz",\n'
        + '            "sha256": "aa",\n'
        + '            "strip_prefix": "miri-nightly-aarch64-apple-darwin/miri-preview",\n'
        + "        },\n    },\n    \"rustc\": {",
    ),
    "a channel the pin does not declare": (t) => t.replace(/^RUST_CHANNEL = "[^"]+"/m, 'RUST_CHANNEL = "1.0.0"'),
    // Found by review. Re-indenting ONLY the field lines leaves the package and
    // triple regexes matching, so the artifact-set check sees every key present
    // and passes -- while both value checks skip on an empty entry. The lock
    // pointed at August and the gate printed "one source of truth".
    "field indentation, with urls pointing at another month":
      (t) => t.replace(/dist\/2026-\d\d-\d\d\//g, "dist/2026-08-01/").replace(/^ {12}"/gm, '          "'),
  };
  for (const [name, mutate] of Object.entries(DRIFTS)) {
    it(`rejects ${name}`, () => {
      const dir = craft(OK, mutate);
      try {
        assert.notEqual(gate(dir), 0, `${name} passed the gate`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("accepts the committed lock unmodified", () => {
    // The control. Without it the suite above is satisfied by a gate that
    // rejects everything, which would be no more useful than one that rejects
    // nothing.
    const dir = craft(OK);
    try {
      assert.equal(gate(dir), 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
