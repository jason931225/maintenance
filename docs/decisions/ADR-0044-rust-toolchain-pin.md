---
id: ADR-0044
status: proposed
doc_status: review
date: 2026-09-10
owner: jasonlee
decision: rust-toolchain-pin
proposes_amendments_to: []
related: [ADR-0043]
---

# ADR-0044 — One Rust toolchain, one file, rolled on a schedule

## Status

**Proposed 2026-09-10.** Establishes how the Rust compiler version is pinned,
enforced, and rolled. Amends no product authority and clears no HOLD. It does
not authorize production exposure; `docs/current/PRODUCT.md` keeps that on
**HOLD** independently of which compiler builds the artifact.

## Context — measured, at `aff5cd59`

Before this record the repository ran **five** different Rust compilers, and
nothing said so. An earlier revision of this record said four; it missed
reindeer's.

| where | compiler | how it was chosen |
|---|---|---|
| CI cargo jobs | 1.97.1 | a literal repeated in 13 workflow steps |
| CI buck2 jobs | 1.98.0 **or** 1.98.1 | whatever the runner image shipped |
| a shell at the repo root | rustup default | no pin was visible from there |
| a shell inside `backend/` | 1.97.1 | `backend/rust-toolchain.toml` |
| the reindeer bootstrap | `nightly-2026-02-28` | `REINDEER_TOOLCHAIN`, deliberately locked |

Each row is checkable. The 13 literals were `grep -c '1\.97\.1'` = 12 in
`ci.yml` and 1 in `nightly.yml`. `toolchains/BUCK:8` declares
`system_rust_toolchain`, which takes rustc from `PATH`, and
`.github/actions/buck2-setup` installed no Rust at all — it printed
`rustc --version` and moved on. `backend/rust-toolchain.toml` governed **some** of
CI, not none: three jobs (`backend`, `migration-expand-contract`, `rust-fmt`)
set `defaults.run.working-directory: backend`, so their cargo invocations did
read it. The ~20 `--manifest-path` call sites run from the root and did not. An
earlier revision of this record said it governed no part of CI, which promoted
the majority case to a universal.

Two of those steps carried the comment *"rust-toolchain.toml drives the exact
version; this step just ensures rustup is available and honours the file"*
directly above a hardcoded literal. That sentence was false when written.

### What the drift actually cost

The unpinned row is not hypothetical. GitHub's hosted fleet served rustc
1.98.0 and 1.98.1 **concurrently**, and the shared CAS key carries no compiler
identity, so an `rlib` built by one was handed to a build running the other:

```
error[E0514]: found crate `unicode_ident` compiled by an incompatible version of rustc
    = note: crate `unicode_ident` compiled by rustc 1.98.1 (48a229cea 2026-09-01)
    = help: please recompile that crate using this compiler
            (rustc 1.98.0 (88d9e12ae 2026-08-18))
```

Across every run and attempt in the window examined, **4 of 4** on 1.98.0
failed and **5 of 5** on 1.98.1 passed, with the versions interleaving in both
directions over nine hours. It read as a flake for weeks (#1083). It was a
standing coin flip on runner assignment.

## Decision

1. **One file.** `//rust-toolchain.toml`, at the repository root, is the only
   place a Rust version may appear. `backend/rust-toolchain.toml` is deleted; a
   nested file shadows the root one for anything run inside its directory,
   which is how the old copy came to govern developer shells and no part of CI.

2. **Everything reads it.** `.github/actions/setup-rust` parses `channel` and
   installs it; every workflow uses that action and passes **no version**.
   `buck2-setup` uses it too and exports `RUSTUP_TOOLCHAIN`, so the Buck2
   graph's `system_rust_toolchain` resolves the same compiler as cargo. That is
   the half of #1083 this repository owns; keying the CAS on compiler identity
   is the other half and is not decided here.

3. **A gate, not a convention.** `scripts/check-toolchain-pin.mjs` fails the
   build if a `toolchain:` input names a version, if a dated nightly literal
   appears under `.github/`, if a second toolchain file exists anywhere, or if
   the pin declares zero or more than one channel. It runs in the gate sweep.
   The action's own body is digest-locked in the CI-preflight contract, because
   once it is the only namer of a version, repointing it silently is the
   remaining way to defeat the pin.

4. **Rolling is routine and reviewed.** A scheduled job proposes the bump as a
   pull request; it never merges one. The PR is the canary, `dev` is the
   promote, and rollback is reverting one line. This is deliberate: the
   repository requires independent adversarial review before merge
   (`docs/current/DELIVERY.md`), and an auto-merging bot would launder a
   compiler change past it.

5. **Dated, never bare.** A nightly pin is `nightly-YYYY-MM-DD`. Bare `nightly`
   is not reproducible: two machines resolve it differently on the same day,
   which is the property this record exists to remove.

## Why the roller is a workflow and not Renovate

`renovate.json5` is present and configured, including a `customManagers` regex
precedent for exactly this kind of plain-string version. It is **inert**:
Renovate has opened zero pull requests in this repository's history. Even if it
were installed, no standard datasource enumerates dated nightlies, and the roll
needs a property no datasource carries — whether the required *components*
(`rustfmt`, `clippy`) and *targets* (`wasm32-unknown-unknown`, which
`tools/ui/build-payroll-wasm.sh` needs) were actually published for that date.
Some nightlies ship without them. The roller must walk back from today to the
most recent date that has them, which is a check, not a lookup.

## Consequences

- A bump is one line in one file. A rollback is reverting it.
- **A pin change does NOT invalidate the Buck2 CAS.** An earlier revision of
  this record claimed the opposite — that every action digest changes, so
  #1083's poisoned entries age out on the first run. Measured on this change's
  own canary: `Cache hits: 100%`, 97 of 97 commands cached. It could not be
  otherwise: `rust-toolchain.toml` is not a declared input to any Buck2 target,
  and `system_rust_toolchain` resolves rustc at execution time, so no digest
  changes. That claim also contradicted this record's own statement above that
  the CAS key carries no compiler identity.
- **The real consequence is the inverse, and it is why both halves of #1083
  land together.** Cached rlibs outlive a pin change, and an rlib is linkable
  only by the compiler that built it. Pinning removes the nondeterminism but not
  the mixed store, so it would turn `E0514` from an intermittent coin flip into
  a *standing* failure — the pinned compiler differing from the cached artifacts
  on every run rather than half of them. So `cas-inrunner` now derives its cache
  prefix from `rustc --version`, and the seed saves under the prefix it restored
  from. An artifact this runner cannot link becomes a cache *miss* — a slow
  build — instead of a poisoned hit.
- That risk was **untested, not absent**, on the run that looked green: `97
  (cached: 97, local: 0)` means nothing compiled, so nothing linked. The base
  run for comparison was `97 (cached: 83, local: 14)` on rustc 1.98.1. The first
  content change would have run a local rustc against 1.98.x-built rlibs.
- `check:executed-tests` keys test binaries by `(crate_root, feature set)`, not
  by compiler, so a toolchain change does not re-key anything.
- Committed `pkg/*.wasm` bytes are built by `tools/ui/build-payroll-wasm.sh`,
  which now inherits the pin like everything else. Whether a compiler change
  alters those bytes, and whether anything downstream requires it not to, is
  **not settled here** and is a question the first bump must answer.

## What this record does not do

It does not choose a channel. The pin is `1.97.1` at this record's date — the
version CI was already green on — and moving it to a nightly is a separate,
separately reviewed change, made through this mechanism rather than alongside
it. Changing the pipe and the water in one commit is how a toolchain migration
becomes unattributable when it breaks.
