import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { buildLock, manifestUrl, parseManifest, renderBzl, required } from "./lock-rust-toolchain.mjs";
import { parsePin } from "./lib/rust-pin.mjs";

const HOST = "x86_64-unknown-linux-gnu";
const PIN = '[toolchain]\nchannel = "nightly-2026-09-10"\ncomponents = ["rustfmt", "clippy"]\ntargets = ["wasm32-unknown-unknown"]\n';

const entry = (pkg, triple, release = "nightly") => `[pkg.${pkg}.target.${triple}]
available = true
url = "https://static.rust-lang.org/dist/2026-09-10/${pkg}-${release}-${triple}.tar.gz"
hash = "gz${pkg}${triple}"
xz_url = "https://static.rust-lang.org/dist/2026-09-10/${pkg}-${release}-${triple}.tar.xz"
xz_hash = "xz${pkg}${triple}"
`;

describe("lock-rust-toolchain", () => {
  it("routes a dated nightly to its dated manifest and a stable to its own", () => {
    assert.equal(
      manifestUrl("nightly-2026-09-10"),
      "https://static.rust-lang.org/dist/2026-09-10/channel-rust-nightly.toml",
    );
    assert.equal(
      manifestUrl("1.97.1"),
      "https://static.rust-lang.org/dist/channel-rust-1.97.1.toml",
    );
  });

  it("refuses a floating channel instead of locking a hash that will stop matching", () => {
    // The whole design requires the channel and the compiler to be the same
    // fact. `nightly` is a different compiler tomorrow.
    for (const channel of ["nightly", "stable", "beta"]) {
      assert.throws(() => manifestUrl(channel), /not an exact version/, channel);
    }
  });

  it("derives strip_prefix from the URL rather than rebuilding it from the channel", () => {
    // The bug this test exists for: upstream names the archive directory after
    // the RELEASE string -- the channel for stable, the literal `nightly` for a
    // dated nightly -- so reconstructing it from the channel broke on the very
    // first bump, which is the operation this design exists to make routine.
    const manifest = parseManifest(entry("rust-std", "wasm32-unknown-unknown"));
    assert.equal(
      manifest["rust-std"]["wasm32-unknown-unknown"].strip_prefix,
      "rust-std-nightly-wasm32-unknown-unknown/rust-std-wasm32-unknown-unknown",
    );
    const stable = parseManifest(entry("rust-std", "wasm32-unknown-unknown", "1.97.1"));
    assert.equal(
      stable["rust-std"]["wasm32-unknown-unknown"].strip_prefix,
      "rust-std-1.97.1-wasm32-unknown-unknown/rust-std-wasm32-unknown-unknown",
    );
  });

  it("puts rustc's payload under rustc/, not a per-triple directory", () => {
    const manifest = parseManifest(entry("rustc", HOST));
    assert.equal(manifest.rustc[HOST].strip_prefix, `rustc-nightly-${HOST}/rustc`);
  });

  it("prefers the xz artifact, because CI pays for every byte", () => {
    const manifest = parseManifest(entry("rustc", HOST));
    assert.match(manifest.rustc[HOST].url, /\.tar\.xz$/);
    assert.equal(manifest.rustc[HOST].sha256, `xzrustc${HOST}`);
  });

  it("treats `available = false` as absent", () => {
    const text = entry("rustc", HOST).replace("available = true", "available = false");
    assert.deepEqual(parseManifest(text), {});
  });

  it("requires rustc, std and every declared component per host, plus std per target", () => {
    const wanted = required(parsePin(PIN), [HOST]);
    const asStrings = wanted.map((pair) => pair.join("@"));
    assert.ok(asStrings.includes(`rustc@${HOST}`));
    assert.ok(asStrings.includes(`rust-std@${HOST}`));
    // rustup names differ from dist package names; a literal lookup finds
    // nothing and would reject every channel forever.
    assert.ok(asStrings.includes(`rustfmt-preview@${HOST}`));
    assert.ok(asStrings.includes(`clippy-preview@${HOST}`));
    // The declared cross target. Not optional: it is how the UI bundle builds.
    assert.ok(asStrings.includes("rust-std@wasm32-unknown-unknown"));
  });

  it("fails closed when the channel does not publish something the pin declares", () => {
    // A lock missing an entry produces a toolchain that cannot build, found at
    // build time instead of here.
    const partial = parseManifest(entry("rustc", HOST));
    assert.throws(
      () => buildLock(parsePin(PIN), partial, [HOST]),
      /does not publish/,
    );
  });

  it("renders Starlark that carries a hash for every url", () => {
    const manifest = parseManifest(
      entry("rustc", HOST) + entry("rust-std", HOST) + entry("rust-std", "wasm32-unknown-unknown")
        + entry("rustfmt-preview", HOST) + entry("clippy-preview", HOST),
    );
    const text = renderBzl(buildLock(parsePin(PIN), manifest, [HOST]));
    assert.match(text, /^# @generated/);
    assert.match(text, /RUST_CHANNEL = "nightly-2026-09-10"/);
    const urls = (text.match(/"url":/g) ?? []).length;
    const hashes = (text.match(/"sha256":/g) ?? []).length;
    const prefixes = (text.match(/"strip_prefix":/g) ?? []).length;
    assert.equal(urls, hashes, "every artifact must be hash-pinned");
    assert.equal(urls, prefixes);
    assert.ok(urls >= 5);
  });

  it("the committed lock matches the committed pin", () => {
    // Not a regeneration -- this must not reach the network. It asserts the two
    // committed files agree, which is what makes the lock derived rather than
    // maintained beside the pin.
    const pin = parsePin(readFileSync(new URL("../rust-toolchain.toml", import.meta.url), "utf8"));
    const lock = readFileSync(new URL("../toolchains/rust/lock.bzl", import.meta.url), "utf8");
    assert.match(lock, new RegExp(`RUST_CHANNEL = "${pin.channel}"`));
  });
});
