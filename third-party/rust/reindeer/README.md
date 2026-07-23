# Patched Reindeer bootstrap

`bootstrap.sh` is the only Reindeer entry point used by this repository. It
fetches the exact upstream archive recorded in `upstream.lock`, verifies its
SHA-256 before extraction, applies the carried patch with zero fuzz, and builds
with the pinned Rust toolchain. It never falls back to a globally installed
`reindeer` binary.
The local cache key includes the carried-patch SHA-256, so a changed reviewed
patch cannot reuse an earlier binary.

The carried patch enables only direct `dev-dependencies` of workspace members
when `include_workspace_dev_dependencies = true`; each such root uses the
existing normal/build resolver for its transitive closure. It intentionally
does not add dev-dependencies of third-party packages.
