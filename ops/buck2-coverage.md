# Buck2 backend manifest ownership coverage

## Claim boundary

`tools/buck/backend_manifest_coverage.py` inventories every canonical, regular
`backend/**/Cargo.toml` and requires one of two explicit outcomes:

1. a queryable Buck2 owner label; or
2. the one code-locked exemption for the virtual `backend/Cargo.toml` workspace.

Cargo manifests are discovery inputs only. They are **not** final build or test
authority. The generated `cargo-manifest-ownership` filegroups prove that Buck2
can query and build ownership metadata for a package; they do not claim that the
package's Rust sources compile under Buck2. Real Rust build parity must replace
the metadata target with a declared target in the policy. The existing
`migration-safety` Rust leaf is the first such declared target and is preserved
unchanged. A declared owner passes only when Buck2's semantic query resolves the
exact label to one `rust_library`, `rust_binary`, or `rust_test`; comments,
filegroups, missing targets, and duplicate node output cannot satisfy the gate.

## Canonical files

- `policy.json` is the canonical reviewed exception and declared-target policy.
- `ownership.generated.json` is the deterministic, generated manifest-to-label
  registry.
- Generated `backend/**/BUCK` files expose one public ownership metadata target.
- Hand-maintained `BUCK` files are never overwritten. They must first be mapped
  to a real target under `declared_targets`.

Both control files are pinned to their repository-contained canonical paths and
must be regular files with no symlink component. Manifest discovery rejects
symlink manifests and ancestors, non-regular files, escapes from the resolved
backend, non-NFC or nonportable components, invalid Buck labels, and casefold
collisions. The only exemption is `backend/Cargo.toml`; its TOML must contain
`[workspace]` and no top-level `[package]`.

Generation uses unpredictable `O_EXCL`/no-follow temporary files and a
directory-anchored `os.replace`. It rejects symlink/non-regular targets and
leaves the prior target intact on write or replace failure. A stale generated
`BUCK` is pruned only when both its complete bytes and an internally consistent
prior registry entry prove the exact former generated artifact. A generated
header alone never authorizes overwrite or deletion.

## Update and verify

After adding, moving, or removing a backend Cargo manifest:

```sh
python3 tools/buck/backend_manifest_coverage.py generate
python3 tools/buck/backend_manifest_coverage.py check
python3 -m unittest \
  backend/ci/gates/buck2-coverage/test_backend_manifest_coverage.py
buck2 test //backend/ci/gates/buck2-coverage:backend-manifest-coverage-unit
python3 tools/buck/backend_manifest_coverage.py labels > /tmp/buck2-owner-labels
buck2 uquery "set($(cat /tmp/buck2-owner-labels))"
buck2 build $(cat /tmp/buck2-owner-labels)
```

`check` fails closed for a new unowned manifest, missing or hand-edited generated
metadata, a stale generated file, a stale policy entry, any path/control-file
safety violation, or a declared target that fails the semantic Rust query.
`labels` and `summary` refuse to emit results while deterministic or semantic
drift exists.

## Remaining Rust build-parity boundary

For the current exact inventory, the registry contains 141 manifests, 140
queryable labels, and one virtual-workspace exemption. Of those labels, 139 are
metadata filegroups and one is the `migration-safety` Rust library. This is a
bounded inventory/ownership claim only: it does **not** claim that the 139
metadata-owned crates compile under Buck2 or that full backend Rust compile
parity is complete. That later boundary requires real first-party Rust rules and
their locked dependency, build-script, SQLx, native-library, and runtime-test
inputs. Until those targets replace metadata entries, `migration-safety` is the
only build-authoritative Rust package proven by this coverage gate.
