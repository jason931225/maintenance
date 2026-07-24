#!/usr/bin/env bash
# Build and execute the repository-pinned Reindeer binary. No PATH fallback.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=upstream.lock
source "$script_dir/upstream.lock"

for required in curl shasum tar patch rustup install mktemp; do
  command -v "$required" >/dev/null 2>&1 || {
    echo "reindeer bootstrap: required tool missing: $required" >&2
    exit 1
  }
done

patches=(
  "$script_dir/patches/0001-workspace-dev-dependency-roots.patch"
  "$script_dir/patches/0002-cargo-security-uplift.patch"
)
patch_sha=$(
  for patch_file in "${patches[@]}"; do
    shasum -a 256 "$patch_file"
  done | shasum -a 256 | awk '{print $1}'
)
cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/maintenance/reindeer/${REINDEER_COMMIT}-${patch_sha}"
binary="$cache_root/bin/reindeer"
if [[ -x "$binary" ]]; then
  exec "$binary" "$@"
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/maintenance-reindeer.XXXXXX")
cleanup() { rm -rf "$work"; }
trap cleanup EXIT
archive="$work/reindeer.tar.gz"
source_dir="$work/reindeer"

curl --fail --location --silent --show-error "$REINDEER_ARCHIVE_URL" --output "$archive"
actual_sha=$(shasum -a 256 "$archive" | awk '{print $1}')
if [[ "$actual_sha" != "$REINDEER_ARCHIVE_SHA256" ]]; then
  echo "reindeer bootstrap: archive SHA-256 mismatch" >&2
  echo "expected: $REINDEER_ARCHIVE_SHA256" >&2
  echo "actual:   $actual_sha" >&2
  exit 1
fi

mkdir "$source_dir"
tar -xzf "$archive" --strip-components=1 -C "$source_dir"
install -m 0644 "$script_dir/Cargo.lock" "$source_dir/Cargo.lock"
for patch_file in "${patches[@]}"; do
  patch --batch --fuzz=0 --forward -d "$source_dir" -p1 --input "$patch_file"
done

cargo_command=$(printf '%s' cargo)
mkdir -p "$cache_root/bin"
build_args=(build --locked --release --manifest-path "$source_dir/Cargo.toml" --target-dir "$cache_root/target")
rustup run "$REINDEER_TOOLCHAIN" "$cargo_command" "${build_args[@]}"

install -m 0755 "$cache_root/target/release/reindeer" "$binary"
exec "$binary" "$@"
