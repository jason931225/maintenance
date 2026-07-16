# Buck2 backend manifest ownership coverage

## Claim boundary

`tools/buck/backend_manifest_coverage.py` discovers every `backend/**/Cargo.toml`
and requires one of two explicit outcomes:

1. a queryable Buck2 owner label; or
2. an exemption in `backend/ci/gates/buck2-coverage/policy.json` with a stable
   reason code and rationale.

Cargo manifests are discovery inputs only. They are **not** final build or test
authority. The generated `cargo-manifest-ownership` filegroups prove that Buck2
can query and build ownership metadata for a package; they do not claim that the
package's Rust sources compile under Buck2. Real Rust build parity must replace
the metadata target with a declared target in the policy. The existing
`migration-safety` Rust leaf is the first such declared target and is preserved
unchanged.

## Canonical files

- `policy.json` is the reviewed exception and declared-target policy.
- `ownership.generated.json` is the deterministic, generated manifest-to-label
  registry.
- Generated `backend/**/BUCK` files expose one public ownership metadata target.
- Hand-maintained `BUCK` files are never overwritten. They must first be mapped
  to a real target under `declared_targets`.

The only current exemption is the virtual `backend/Cargo.toml` workspace
aggregator, which does not define a Rust build unit.

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
metadata, a stale generated file, a stale policy entry, a malformed exemption,
or a declared target absent from its package's `BUCK` file. `labels` refuses to
emit a query set while any deterministic drift exists.

## Remaining Rust build-parity boundary

This gate closes the previous **manifest-discovery false green**; it does not
claim that 139 metadata-owned crates compile under Buck2. Full backend Rust
build authority still requires a locked third-party Buck graph plus real
first-party `rust_library`, `rust_binary`, and `rust_test` targets with their
source, dependency, build-script, SQLx, native-library, and runtime-test inputs.
Until those real targets replace metadata entries under `declared_targets`, the
only Rust build-authoritative backend package is the preserved
`migration-safety` leaf.
