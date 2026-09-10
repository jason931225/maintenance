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
// Scope, stated so it is not mistaken for more than it is.
//
// COVERED: everything under `.github` -- YAML, shell inside `run:` blocks, and
// the `.mjs`/`.js` files that live there. The shapes below were derived from an
// adversarial sweep in which SEVEN crafted-but-plausible inputs walked straight
// past an earlier revision: env-var indirection into `rustup default`,
// `uses: dtolnay/rust-toolchain@1.99.0`, a bare `RUSTUP_TOOLCHAIN:`,
// `rustup-init --default-toolchain`, `rustup component add --toolchain`,
// `rustup install`, and a one-comment bypass of the whole gate via the reindeer
// carve-out. Each of those is now a shape or a narrowed exemption. Any change
// here should be re-run against those cases before it is believed.
//
// NOT COVERED, and deliberately so: anything outside `.github`. Two live
// instances, both real second sources of truth --
//   * `backend/Dockerfile` pins its own `rust:` image, and also COPYs a
//     `backend/rust-toolchain.toml` that no longer exists.
//   * a toolchain file under `third-party/` is excluded on purpose, because
//     vendored crates legitimately carry their own.
// Widening the scan is cheap; claiming a coverage it does not have is not, and
// this gate has already once been described as covering more than it did.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
// The generator's own definition of what a pin requires. Imported rather than
// restated so the gate cannot drift from the thing it checks; both modules
// guard their CLI behind `import.meta.url`, so this reaches no network.
import { parsePin } from "./lib/rust-pin.mjs";
import { required } from "./lock-rust-toolchain.mjs";

// `--root` mirrors scripts/check-adrs.mjs. It exists so the bypass corpus in
// the test file can run this gate against crafted trees: a gate whose only
// possible input is the repository that already passes it cannot be shown to
// fail, and this one shipped a revision that seven crafted inputs walked past.
const ROOT_FLAG = process.argv.indexOf("--root");
if (ROOT_FLAG !== -1 && !process.argv[ROOT_FLAG + 1]) {
  console.error("--root requires a directory");
  process.exit(2);
}
const REPO = ROOT_FLAG === -1
  ? new URL("..", import.meta.url).pathname.replace(/\/$/, "")
  : process.argv[ROOT_FLAG + 1].replace(/\/$/, "");
const PIN = "rust-toolchain.toml";
const failures = [];
let pin = null;

// --- the pin must be EXACT --------------------------------------------------
// A floating channel (`nightly`, `stable`, `beta`) names a different compiler
// on different days. It cannot be hash-pinned, and a lock generated against one
// records hashes that silently stop describing what the name resolves to. The
// whole design -- compiler bytes inside the action digest -- requires that the
// channel and the compiler are the same fact.
const EXACT_CHANNEL = /^(\d+\.\d+\.\d+|nightly-\d{4}-\d{2}-\d{2})$/;

// --- the pin itself ---------------------------------------------------------
let channel = null;
try {
  const text = readFileSync(join(REPO, PIN), "utf8");
  try { pin = parsePin(text); } catch { /* the checks below report the shape problem */ }
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
    re: /\brustup\s+(?:default|toolchain\s+install|install|override\s+set)\s+(?!"?\$)([0-9]+\.[0-9]+(?:\.[0-9]+)?|nightly|beta|stable)\b/g,
    what: "a rustup invocation naming a version in a shell step",
  },
  // Indirection through a shell variable. An earlier revision exempted `$VAR`
  // outright, which green-lit `env: RUST_VERSION: 1.99.0` two lines above
  // `rustup default "$RUST_VERSION"` -- materially the pre-2026-09-10 failure
  // this gate exists to stop. The version literal is unfindable in general
  // (it can come from a matrix, an output, a repo variable), so the rustup
  // CALL is what gets caught. reindeer's bootstrap is the one legitimate
  // instance and it is carved out below by variable name.
  {
    re: /\brustup\s+(?:default|toolchain\s+install|install|override\s+set|run)\s+"?\$\{?[A-Za-z_]*(?:RUST|TOOLCHAIN)[A-Za-z_]*\}?/g,
    what: "a rustup invocation taking its version from a shell variable",
  },
  // `--toolchain` / `--default-toolchain`, which rustup-init and
  // `rustup component add` both accept and neither shape above covers.
  {
    re: /--(?:default-)?toolchain[=\s]+(?!"?\$)([0-9]+\.[0-9]+(?:\.[0-9]+)?|nightly(?:-\d{4}-\d{2}-\d{2})?|beta|stable)\b/g,
    what: "a --toolchain flag naming a version",
  },
  // The single most idiomatic way a Rust version re-enters a GitHub workflow.
  // `@master`/`@main` float by design and name no version, so they are not a
  // second source of truth; anything else after the `@` is.
  // `- uses:` and `uses:` both occur, so the list dash is optional.
  {
    re: /^\s*(?:-\s*)?uses:\s*\S*rust-toolchain@(?!master\s*$|main\s*$)\S+/gm,
    what: "a third-party rust-toolchain action pinned to a version",
  },
  // `RUSTUP_TOOLCHAIN` selects the toolchain for every rustup shim in the
  // process, so setting it to a literal is a second source of truth even
  // though no rustup command names a version. Buck2 scrubs this variable
  // inside its actions -- cargo, rustfmt and the wasm script do not.
  {
    re: /^\s*RUSTUP_TOOLCHAIN:\s*(?!\$)["']?([0-9]+\.[0-9]+(?:\.[0-9]+)?|nightly(?:-\d{4}-\d{2}-\d{2})?|beta|stable)\b/gm,
    what: "RUSTUP_TOOLCHAIN set to a version literal",
  },
  // An official `rust:` image carries its own compiler and ignores this pin
  // entirely. A `container:` or `image:` key inside a workflow is as much a
  // second source of truth as a rustup call -- more so, because nothing in the
  // job can override it. (backend/Dockerfile does exactly this and is OUTSIDE
  // this scan; see the scope note in the header.)
  {
    re: /^\s*(?:container|image):\s*["']?rust:\d[^\s"']*/gm,
    what: "a rust: container image naming its own compiler",
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
      // Anchored on an actual VARIABLE REFERENCE, not the bare token. Matching
      // the token anywhere in the line disabled every shape for any line that
      // merely mentioned it -- `toolchain: 1.99.0  # REINDEER_TOOLCHAIN` was a
      // one-comment bypass of the whole gate.
      if (/\$\{?REINDEER_TOOLCHAIN\}?/.test(line)) continue;
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
// Every locked artifact must come from Rust's own dist host.
const DIST_PREFIX = "https://static.rust-lang.org/dist";
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
  for (const [, url] of lockText.matchAll(/^\s+"url": "([^"]+)"/gm)) {
    if (!url.startsWith(`${DIST_PREFIX}/`)) {
      failures.push(
        `${LOCK}: ${url} is not under ${DIST_PREFIX}. The sha256 still pins the `
          + "bytes, but nothing else checked where a hand-edited lock points.",
      );
    }
  }
  if (urls === 0) failures.push(`${LOCK}: no artifacts locked`);
  if (urls !== hashes) failures.push(`${LOCK}: ${urls} urls but ${hashes} sha256s — every artifact must be hash-pinned`);

  // Everything above holds the lock's SHAPE. None of it ties an artifact to
  // the pin. A lock whose RUST_CHANNEL reads nightly-2026-09-10 while every
  // URL points into /dist/2026-08-01/, hashes matching those August bytes,
  // passes every check above -- and then `setup-rust` installs 09-10 for cargo
  // while buck2 compiles with 08-01. That is #1083's divergence rebuilt one
  // level down, which is the failure this whole lane exists to remove.
  //
  // These three tie content to the pin WITHOUT the network, which is why they
  // can live in a gate at all. `--check` regenerates from the live manifest
  // and stays out of CI deliberately: it is the only way to catch a wrong
  // sha256 for a correctly-named artifact, and it cannot run offline.
  if (pin && lockText) {
    const locked = new Map();
    let pkg = null;
    let triple = null;
    for (const line of lockText.split("\n")) {
      const p = /^ {4}"([^"]+)": \{/.exec(line);
      if (p) { pkg = p[1]; triple = null; continue; }
      const t = /^ {8}"([^"]+)": \{/.exec(line);
      if (t) { triple = t[1]; locked.set(`${pkg} ${triple}`, {}); continue; }
      const f = /^ {12}"(url|strip_prefix)": "([^"]+)"/.exec(line);
      if (f && pkg && triple) locked.get(`${pkg} ${triple}`)[f[1]] = f[2];
    }

    // (a) exactly the artifacts this pin calls for -- no missing component,
    // and no extra one smuggled in by hand.
    const want = new Set(required(pin).map(([p, t]) => `${p} ${t}`));
    const show = (k) => k.replace(" ", " / ");
    for (const k of want) {
      if (!locked.has(k)) failures.push(`${LOCK}: ${PIN} requires ${show(k)} but the lock has no entry for it`);
    }
    for (const k of locked.keys()) {
      if (!want.has(k)) failures.push(`${LOCK}: ${show(k)} is locked but ${PIN} does not call for it`);
    }

    // (b) every URL must name the pinned channel. A dated nightly lives under
    // /dist/<date>/; a stable release carries the version in the filename.
    const dated = /^nightly-(\d{4}-\d{2}-\d{2})$/.exec(pin.channel);
    for (const [k, e] of locked) {
      if (!e.url) continue;
      const ok = dated
        ? e.url.startsWith(`${DIST_PREFIX}/${dated[1]}/`)
        : e.url.split("/").pop().includes(`-${pin.channel}-`);
      if (!ok) {
        failures.push(
          `${LOCK}: ${show(k)} points at ${e.url}, which does not name channel `
            + `${pin.channel}. The sha256 pins those bytes, but they are the wrong compiler.`,
        );
      }
    }

    // (c) strip_prefix is where this generator has shipped two bugs, so it is
    // recomputed here rather than trusted. `rust-std` is the ONLY package whose
    // inner directory carries the triple; the rest are bare. The archive
    // basename is read from the URL because the dist FILE name drops the
    // `-preview` that the PACKAGE name carries (clippy-preview -> clippy-*).
    for (const [k, e] of locked) {
      if (!e.url || !e.strip_prefix) continue;
      const [p, t] = k.split(" ");
      const base = e.url.split("/").pop().replace(/\.tar\.(xz|gz)$/, "");
      const want_prefix = `${base}/${p === "rust-std" ? `rust-std-${t}` : p}`;
      if (e.strip_prefix !== want_prefix) {
        failures.push(
          `${LOCK}: ${show(k)} strip_prefix is "${e.strip_prefix}" but the archive `
            + `layout gives "${want_prefix}" — the extracted tree would not be found.`,
        );
      }
    }
  }
} catch {
  failures.push(`${LOCK} is missing — generate it with node scripts/lock-rust-toolchain.mjs`);
}

if (failures.length) {
  console.error("Rust toolchain pin contract failed:");
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}
console.log(`Rust toolchain pin: one source of truth, channel = ${channel}`);
