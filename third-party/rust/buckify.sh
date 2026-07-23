#!/usr/bin/env bash
# Regenerate the third-party Buck2 graph from the REAL backend workspace.
# Single source of truth stays backend/Cargo.toml + Cargo.lock (no parallel dep
# list). Run from anywhere: third-party/rust/buckify.sh
set -euo pipefail
cd "$(dirname "$0")/../.."  # -> repo root (worktree)

# buck2/reindeer must use the workspace-pinned toolchain; the machine default
# may differ. backend/rust-toolchain.toml pins 1.96.0 but does not apply at the
# repo root where buck2 runs.
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-1.96.0}"

# Reindeer cannot safely emit local-source rules for a path that escapes its
# third-party package. Keep every patched crate inside the canonical boundary
# and fail before generation if a future patch violates that invariant.
python3 - <<'PY'
from pathlib import Path
import tomllib

repo = Path.cwd().resolve()
manifest = repo / "backend/Cargo.toml"
third_party = (repo / "third-party/rust").resolve()
data = tomllib.loads(manifest.read_text())

violations = []
for name, spec in data.get("patch", {}).get("crates-io", {}).items():
    if not isinstance(spec, dict) or "path" not in spec:
        continue
    source = (manifest.parent / spec["path"]).resolve()
    try:
        source.relative_to(third_party)
    except ValueError:
        violations.append(f"{name}: {source}")
    if not (source / "Cargo.toml").is_file():
        violations.append(f"{name}: missing Cargo.toml at {source}")

if violations:
    raise SystemExit(
        "buckify.sh: local crates.io patches must live under "
        f"{third_party}:\n  " + "\n  ".join(violations)
    )
print("buckify.sh: local patch boundary verified")
PY

third-party/rust/reindeer/bootstrap.sh \
  --cargo-options=--locked \
  --third-party-dir third-party/rust \
  --manifest-path backend/Cargo.toml \
  buckify

# Deterministic workaround for a reindeer multi-version limitation. The workspace
# pins sqlx 0.9, but crates/platform/jobs depends on sqlx 0.8 (renamed
# apalis-sqlx) because apalis' rc release requires it. reindeer keys the public
# alias on the PACKAGE name, ignoring the first-party `package=` rename, so it
# emits alias(name="sqlx") for BOTH versions and Buck rejects the duplicate. We
# RENAME the 0.8 alias to a public, non-colliding `sqlx-0_8` (the bare `sqlx`
# alias stays 0.9); first-party `jobs` depends on //third-party/rust:sqlx-0_8.
python3 - <<'PY'
p = "third-party/rust/BUCK"
s = open(p).read()
old = 'alias(\n    name = "sqlx",\n    actual = ":sqlx-0.8",\n    visibility = ["PUBLIC"],\n)'
new = 'alias(\n    name = "sqlx-0_8",\n    actual = ":sqlx-0.8",\n    visibility = ["PUBLIC"],\n)'
if old in s:
    open(p, "w").write(s.replace(old, new, 1))
    print("buckify.sh: renamed duplicate sqlx-0.8 alias -> sqlx-0_8 (public)")
else:
    print("buckify.sh: WARNING expected sqlx-0.8 alias block not found "
          "(reindeer behavior changed — re-check the multi-version handling)")
PY
echo "buckify.sh: third-party/rust/BUCK regenerated"
