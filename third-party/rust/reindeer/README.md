# Patched Reindeer bootstrap

`bootstrap.sh` is the only Reindeer entry point used by this repository. It
fetches the exact upstream archive recorded in `upstream.lock`, verifies its
SHA-256 before extraction, applies the carried patches with zero fuzz, and
builds with the pinned Rust toolchain. It never falls back to a globally
installed `reindeer` binary.
The local cache key includes every carried-patch SHA-256, so a changed reviewed
patch set cannot reuse an earlier binary.

The carried patch enables only direct `dev-dependencies` of workspace members
when `include_workspace_dev_dependencies = true`; each such root uses the
existing normal/build resolver for its transitive closure. It intentionally
does not add dev-dependencies of third-party packages.

The security uplift patch moves Reindeer's `cargo` library dependency to the
first release whose `gix` graph contains the fixes required by the blocking
HIGH/CRITICAL dependency scan. The repository-owned `Cargo.lock` records that
reviewed graph and the bootstrap keeps using `--locked`.
