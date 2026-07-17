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
repository SHA-256 before publication. Locked upstream downloads accept only
the HTTPS redirect hosts required by their recorded origins. An explicit
mirror must remain on the same HTTPS authority through every redirect. The
bootstrap downloads into a random, exclusively created `0600` file, syncs it,
and publishes the verified file with a no-replace hard link followed by a
directory sync. Interrupted or rejected downloads remove their private staging
file. Population without `--allow-network` exits `4` without creating cache
files.

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

The wrapper rejects unsafe lock basenames and origins, walks every cache-path
component without following symlinks, and opens all three archives as regular
files. It hashes the opened file descriptors and keeps them open through the
entire Buck2 invocation. A pathname replacement after verification therefore
cannot change the bytes used by the invocation.

Buck2 and Rust are materialized into fresh, randomly named generations for
every invocation. Pre-existing legacy regular outputs are removed without
executing them; symlink or non-regular derived outputs fail closed. Buck2 is
decompressed from its held archive descriptor. Rust is extracted from its held
archive descriptor into exclusive staging directories, its compiler version
and commit are checked, and failed staging trees are removed.

The held CPython descriptor is exposed through an ephemeral server bound only
to `127.0.0.1`. The server implements only `GET` and `HEAD` for one exact route
and serves bytes with descriptor-based reads; it does not expose a filesystem
directory. Buck2 verifies the Python SHA-256 again while materializing the
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

Partial overrides fail. Setting `BUCK2_CXX_COMPILER_TYPE` by itself also fails;
when present it must accompany all four path overrides and be `clang` or `gcc`.
When all four paths are set and the type is omitted, the bootstrap infers
`clang` or `gcc` from the executable names.

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
| Lock filename, URL, origin, or redirect violates policy | exit `5` or `6`; no publication |
| Cache ancestor or archive is a symlink or non-directory/non-regular file | exit `5`; no tool execution |
| Verified archive pathname is replaced | held descriptor remains authoritative |
| Legacy derived output is a symlink or non-regular file | exit `5`; poisoned output is not executed |
| Buck2 or Rust version/commit differs after materialization | exit `5` |
| Download is interrupted or its final URL/digest is rejected | no final publication; staging is removed |
| Compiler selection is missing, partial, or invalid | exit `6` |
| Raw Buck2 bypasses the wrapper | toolchain parsing fails on the first missing `toolchain.*` value |

The fixture contract suite uses no external network. It covers missing-cache,
per-component tamper, cache and archive symlinks, verified-path replacement,
derived-output poisoning, redirect and download publication policy, interrupted
download and Rust-stage cleanup, explicit network gating, Linux Clang and GCC
fixtures, compiler-override combinations, lock-matrix, Python mirror, and
host-path regressions:

```sh
python3 -m unittest tools.buck.bootstrap.tests.test_hermetic_toolchains -v
```

Native cache validation is a separate admission check: run `doctor` without
`--skip-cache`, then the representative Buck query/build/test/run commands on
each provisioned host or image. Network population and official-provenance
refreshes are operator-controlled pin-maintenance checks, not part of the
offline fixture suite. Full runtime and user-visible readback remain
post-deployment gates.

## Trust boundary and remaining limits

This control prevents persisted cache poisoning through traversal, symlinks,
non-regular files, matching-hash archive indirection, pathname replacement,
predictable partial files, and reused derived binaries. File publication is
true no-replace publication. Rust directory publication uses a fresh random
128-bit generation name and a held parent directory descriptor because the
Python standard library does not expose a portable no-replace directory rename.

The bootstrap does not claim to defend against a concurrently malicious process
running as the same operating-system user. In particular, such a process could
race mutation of an extracted shell installer or a just-validated executable.
Admission must therefore run in a workspace and cache writable only by the
trusted build identity. Native compiler, linker, SDK, system-library, kernel,
and container-image provenance remain outside this lock and must be controlled
by the build-image supply chain.

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
