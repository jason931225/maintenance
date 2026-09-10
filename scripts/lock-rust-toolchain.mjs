#!/usr/bin/env node
// Derive rust-toolchain.lock from rust-toolchain.toml. One pin, everything else generated.
//
// WHY A LOCKFILE AND NOT A PATH LOOKUP
//
// buck2's `system_rust_toolchain` resolves `rustc` from PATH at execution time,
// so the compiler is an input to nothing: it appears in no action digest. That
// is the root of #1083 -- a shared CAS handed an rlib built by one rustc to a
// build running another (`error[E0514]`), because as far as buck2 was concerned
// the two actions were identical.
//
// Naming the channel in the argv (`rustup run 1.97.1 rustc`) is NOT the fix. It
// puts the NAME in the digest, not the bytes: two machines can both have
// "1.97.1" installed and disagree about what that is. Measured, it also costs
// ~75% per invocation across ~7000 actions.
//
// The fix is the one Bazel/Blaze use: the toolchain is a hash-pinned artifact
// that buck2 materializes as a build input, so the action's input tree CONTAINS
// the compiler and its digest covers the compiler's actual bytes. A different
// compiler is then a different action -- a cache MISS, which is correct and
// cheap -- rather than a poisoned hit, which is neither.
//
// Rust publishes url + sha256 per package per target in its dist manifest, so
// this is a lookup, not a guess.
//
//   node scripts/lock-rust-toolchain.mjs           # rewrite the lock
//   node scripts/lock-rust-toolchain.mjs --check   # fail if it would change
import { readFileSync, writeFileSync } from "node:fs";

import { parsePin } from "./lib/rust-pin.mjs";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const DIST = "https://static.rust-lang.org/dist";

// The hosts this repository builds on. CI is linux/x86_64; developer machines
// are arm64 macOS. Both must be in the lock or a `buck2 build` on the other one
// falls back to... nothing, because there is no fallback by design.
export const HOSTS = ["x86_64-unknown-linux-gnu", "aarch64-apple-darwin"];

// rustup component name -> dist package name. `rustc` and `rust-std` are not
// components in the rustup sense; they are what a toolchain IS.
const COMPONENT_PKG = { rustfmt: "rustfmt-preview", clippy: "clippy-preview" };

/** The dist channel manifest URL for a pinned channel. */
export function manifestUrl(channel) {
  const dated = /^nightly-(\d{4}-\d{2}-\d{2})$/.exec(channel);
  if (dated) return `${DIST}/${dated[1]}/channel-rust-nightly.toml`;
  // Patch REQUIRED. `channel-rust-1.97.toml` is HTTP 200 and floats to the
  // newest patch, so a lock generated from it stops describing the name it was
  // generated for the day 1.97.2 ships.
  if (/^\d+\.\d+\.\d+$/.test(channel)) return `${DIST}/channel-rust-${channel}.toml`;
  // Bare `nightly`/`stable`/`beta` name a different compiler on different days.
  // Locking one would record a hash that silently stops matching the name.
  throw new Error(
    `channel "${channel}" is not an exact version. Use x.y.z or nightly-YYYY-MM-DD: `
      + "a floating channel cannot be hash-pinned, which is the whole point of this lock.",
  );
}

/** Every `[pkg.NAME.target.TRIPLE]` entry that is available, with its hash. */
export function parseManifest(text) {
  const out = {};
  const re = /^\[pkg\.([^.\]]+)\.target\.([^\]]+)\]$/gm;
  for (const match of text.matchAll(re)) {
    const [, pkg, triple] = match;
    const rest = text.slice(match.index + match[0].length);
    const end = rest.indexOf("\n[");
    const body = end < 0 ? rest : rest.slice(0, end);
    if (!/^\s*available\s*=\s*true\s*$/m.test(body)) continue;
    // Prefer .xz: roughly half the bytes of .gz, and CI pays for every byte.
    const url = /^\s*xz_url\s*=\s*"([^"]+)"/m.exec(body) ?? /^\s*url\s*=\s*"([^"]+)"/m.exec(body);
    const hash = /^\s*xz_hash\s*=\s*"([^"]+)"/m.exec(body) ?? /^\s*hash\s*=\s*"([^"]+)"/m.exec(body);
    if (!url || !hash) continue;
    // The archive's top-level directory, DERIVED from the URL rather than
    // reconstructed from the channel. Upstream names it after the RELEASE
    // string, which is the channel for stable (`rust-std-1.97.1-<triple>`) but
    // the literal word for a dated nightly (`rust-std-nightly-<triple>`).
    // Rebuilding that in Starlark got it wrong the first time; the filename
    // already states it, so read it instead of predicting it.
    const base = url[1].split("/").pop().replace(/\.tar\.(xz|gz)$/, "");
    // Inside that, the payload sits in a directory named after the component.
    // `rust-std` is the ONLY one that carries the triple, because it is the only
    // per-target payload -- rustc, clippy-preview and rustfmt-preview are all
    // bare. Verified against all four tarballs; each archive also states its own
    // directory in a top-level `components` file, which is the authority if this
    // ever needs revisiting.
    const inner = pkg === "rust-std" ? `rust-std-${triple}` : pkg;
    (out[pkg] ??= {})[triple] = {
      url: url[1],
      sha256: hash[1],
      strip_prefix: `${base}/${inner}`,
    };
  }
  return out;
}

/** What the lock must contain for this pin: (package, triple) pairs. */
export function required(pin, hosts = HOSTS) {
  const wanted = [];
  for (const host of hosts) {
    wanted.push(["rustc", host], ["rust-std", host]);
    for (const component of pin.components) {
      wanted.push([COMPONENT_PKG[component] ?? component, host]);
    }
  }
  // A declared target needs its std, on every host that might cross-compile to
  // it. wasm32 is not optional here: it is how the UI hydration bundle is built.
  for (const target of pin.targets) wanted.push(["rust-std", target]);
  return wanted;
}

export function buildLock(pin, manifest, hosts = HOSTS) {
  const packages = {};
  const missing = [];
  for (const [pkg, triple] of required(pin, hosts)) {
    const entry = manifest[pkg]?.[triple];
    if (!entry) {
      missing.push(`${pkg} for ${triple}`);
      continue;
    }
    (packages[pkg] ??= {})[triple] = entry;
  }
  if (missing.length) {
    // Fail closed. A lock missing an entry produces a toolchain that cannot
    // build, discovered at build time instead of here.
    throw new Error(`channel ${pin.channel} does not publish: ${missing.join(", ")}`);
  }
  return { channel: pin.channel, hosts, packages };
}

/** The lock, as Starlark, because that is what consumes it.
 *
 * Emitted as .bzl rather than JSON on purpose: Starlark cannot read a data file
 * at parse time, so a JSON lock would need a second generated .bzl beside it --
 * two derived representations of one fact, which is the duplicate this whole
 * design exists to remove. One pin, one derived artifact, one gate.
 */
export function renderBzl(lock) {
  const lines = [
    "# @generated by scripts/lock-rust-toolchain.mjs from //rust-toolchain.toml -- do not edit.",
    "#",
    "# Hash-pinned Rust toolchain artifacts. buck2 materializes these as build",
    "# INPUTS, so the compiler's bytes are inside every action's input tree and",
    "# therefore inside its digest. A different compiler is a different action:",
    "# a cache miss, not the unlinkable-artifact hit that was #1083.",
    "",
    `RUST_CHANNEL = ${JSON.stringify(lock.channel)}`,
    "",
    "# The hosts a sysroot is assembled for. Emitted rather than restated in",
    "# Starlark: a second hand-maintained copy of this list is exactly the kind",
    "# of second source of truth this whole design exists to remove.",
    `RUST_HOSTS = ${JSON.stringify(lock.hosts ?? HOSTS)}`,
    "",
    "# package -> target triple -> (url, sha256)",
    "RUST_DIST = {",
  ];
  for (const [pkg, triples] of Object.entries(lock.packages).sort()) {
    lines.push(`    ${JSON.stringify(pkg)}: {`);
    for (const [triple, entry] of Object.entries(triples).sort()) {
      lines.push(`        ${JSON.stringify(triple)}: {`);
      lines.push(`            "url": ${JSON.stringify(entry.url)},`);
      lines.push(`            "sha256": ${JSON.stringify(entry.sha256)},`);
      lines.push(`            "strip_prefix": ${JSON.stringify(entry.strip_prefix)},`);
      lines.push("        },");
    }
    lines.push("    },");
  }
  lines.push("}", "");
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes("--check");
  const pinPath = `${REPO}/rust-toolchain.toml`;
  const lockPath = `${REPO}/toolchains/rust/lock.bzl`;
  const pin = parsePin(readFileSync(pinPath, "utf8"));
  const url = manifestUrl(pin.channel);
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`dist manifest ${url} -> HTTP ${response.status}`);
    process.exit(1);
  }
  const lock = buildLock(pin, parseManifest(await response.text()));
  const text = renderBzl(lock);
  let current = null;
  try {
    current = readFileSync(lockPath, "utf8");
  } catch { /* first run */ }
  if (check) {
    if (current === text) {
      console.log(`rust-toolchain.lock matches the pin (channel ${pin.channel})`);
      process.exit(0);
    }
    console.error(
      "toolchains/rust/lock.bzl does not match rust-toolchain.toml.\n"
        + "Regenerate with: node scripts/lock-rust-toolchain.mjs",
    );
    process.exit(1);
  }
  writeFileSync(lockPath, text);
  const count = Object.values(lock.packages).reduce((n, t) => n + Object.keys(t).length, 0);
  console.log(`wrote toolchains/rust/lock.bzl: channel ${pin.channel}, ${count} hash-pinned artifacts`);
}
