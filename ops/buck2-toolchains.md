# Buck2 toolchain bootstrap

This repository runs Buck2 through `tools/buck/bootstrap/buck2w`. The wrapper
validates repository-locked inputs before starting Buck2 and never downloads in
normal `run` or `doctor` operation. It is the fail-closed entry point for the
currently buckified backend leaf; it is **not** a claim that every backend
manifest is already represented by Buck targets or that all local Buck actions
are sandboxed.

## Locked authority

`tools/buck/toolchain-lock.json` is the machine-readable authority for:

- Buck2 release asset `2026-06-15` (binary version
  `2026-06-14-1169724e85cc1ef071df842d8ac603905c38e68e`), with a SHA-256 for
  each supported release archive.
- The bundled prelude at commit
  `405925e4737177390719d5555794dcce1aab7e30`. Buck2's `bundled` external-cell
  origin means the prelude is part of the Buck2 binary, so verifying the locked
  Buck2 archive binds the executable and prelude together. The release's
  `prelude_hash` asset digest is also recorded.
- Rust `1.96.0`, compiler commit
  `ac68faa20c58cbccd01ee7208bf3b6e93a7d7f96`, its channel-manifest digest,
  and the full distribution archive SHA-256 for each platform.
- The CPython `3.13.6+20250807` archive and SHA-256 used by the exact bundled
  prelude version.

The lock covers `macos-aarch64`, `macos-x86_64`, `linux-aarch64`, and
`linux-x86_64`. Windows is intentionally outside this card's acceptance scope.

## Populate once, run offline

Prerequisites are Python 3.12 or newer, `sh`, and `zstd`/`unzstd`. Network use is
available only through an explicit population gate:

```sh
python3 tools/buck/bootstrap/bootstrap.py populate --allow-network
```

Artifacts are stored under the ignored repository-controlled cache at
`tools/buck/bootstrap/cache/<platform>/`. To use an approved enterprise mirror
instead of the locked upstream origins, serve the same filenames and run:

```sh
python3 tools/buck/bootstrap/bootstrap.py populate \
  --allow-network \
  --mirror-base https://artifacts.example.invalid/maintenance/buck2
```

The mirror cannot change the accepted bytes: every artifact must match the
repository SHA-256 before the atomic cache rename. Population without
`--allow-network` exits `4` without creating cache files.

After population, all normal commands are offline:

```sh
tools/buck/bootstrap/buck2w query //backend/ci/gates/migration-safety:
tools/buck/bootstrap/buck2w build \
  //backend/ci/gates/migration-safety:mnt-gate-migration-safety
tools/buck/bootstrap/buck2w test \
  //backend/ci/gates/migration-safety:mnt-gate-migration-safety-itest-gate_detects_violation
tools/buck/bootstrap/buck2w run \
  //backend/ci/gates/migration-safety:mnt-gate-migration-safety -- --help
```

The wrapper verifies all three cached archives before each invocation,
materializes Buck2 and Rust only from those verified archives, and exposes the
cached CPython archive through an ephemeral server bound only to
`127.0.0.1`. Buck2 verifies the Python SHA-256 again while materializing the
`http_archive`. No upstream URL is present in the evaluated target graph.

## Compiler selection

No compiler path is committed. On macOS the bootstrap uses `xcrun --find`; on
Linux it selects a complete Clang toolchain and falls back to a complete GCC
toolchain. The selected paths are converted to explicit absolute Buck config
values. Operators may instead configure all four tools together:

```sh
export BUCK2_CC=/opt/llvm/bin/clang
export BUCK2_CXX=/opt/llvm/bin/clang++
export BUCK2_AR=/opt/llvm/bin/llvm-ar
export BUCK2_LD=/opt/llvm/bin/clang
export BUCK2_CXX_COMPILER_TYPE=clang
```

Partial overrides fail. `BUCK2_CXX_COMPILER_TYPE` must be `clang` or `gcc`.
The C/C++ compiler, linker, archiver, platform SDK, and system libraries remain
explicit host or image inputs; they are not content-pinned by this lock. Thus
this lane makes Buck2, the bundled prelude, Rust, and Python cache-only and
integrity-locked, but does not claim bit-for-bit reproducibility for native
compilation across differently provisioned hosts.

Use a static platform check without requiring cached archives when preparing a
Linux image:

```sh
python3 tools/buck/bootstrap/bootstrap.py doctor \
  --platform linux-x86_64 \
  --skip-cache
```

Run `doctor` without `--skip-cache` on the target host before admission to
verify and materialize its locked cache.

## Fail-closed behavior

| Condition | Result |
| --- | --- |
| Required archive missing | exit `4`, `offline cache incomplete`; no download |
| Population lacks explicit network gate | exit `4`; no cache mutation |
| Cached archive SHA-256 differs | exit `5`; no tool execution |
| Buck2 or Rust version/commit differs after materialization | exit `5` |
| Compiler selection is missing, partial, or invalid | exit `6` |
| Raw Buck2 bypasses the wrapper | toolchain parsing fails on the first missing `toolchain.*` value |

Contract tests cover missing-cache, tamper, explicit network-gate, Linux
compiler-fixture, lock-matrix, and host-path regressions:

```sh
python3 -m unittest tools.buck.bootstrap.tests.test_hermetic_toolchains -v
```

## Updating a pin

1. Choose one immutable Buck2 release and record its release commit, exact
   binary-reported version, platform asset URLs, and GitHub-published SHA-256
   digests.
2. Record that release's `prelude_hash` content and asset SHA-256. Keep
   `.buckconfig` on `external_cells.prelude = bundled`.
3. Choose one immutable Rust release, record the channel-manifest SHA-256,
   compiler commit, and full distribution SHA-256 for all four platforms.
4. Copy the CPython URLs and hashes from the selected prelude source, not from a
   floating branch.
5. Run the contract tests, cold-cache failure proof, tamper proof, macOS build
   and test, and Linux fixture checks. Production/readback verification remains
   a post-deployment gate and must not be inferred from these predeployment
   checks.

The migration-safety `BUCK` file and Rust sources are outside this toolchain
lane and remain unchanged.
