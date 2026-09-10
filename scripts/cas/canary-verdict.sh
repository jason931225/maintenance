#!/usr/bin/env bash
# Decide what an empty CAS restore MEANS. Three situations reach that point and
# they are not the same thing:
#
#   (a) a seed exists under this prefix and the restore failed  -> broken, fail
#   (b) no seed under this prefix, other compilers have seeds   -> new compiler, pass
#   (c) no nativelink seeds at all                              -> first run, pass
#
# The job used to green all three. (b) happens on EVERY toolchain roll, because
# the cache prefix carries the compiler (#1083) and dev has not seeded the new
# one yet -- so the run right after a compiler change, the one you would most
# want a real cache assertion from, was the one guaranteed to assert nothing and
# report success (#1089).
#
# Lives here rather than inline in the workflow so the branches can be tested.
# (a) and (c) essentially never occur naturally, so CI alone would never
# exercise them.
#
#   canary-verdict.sh --prefix P --log FILE [--restored KEY] [--keys FILE]
#
# Omitting --keys means the cache list could not be read, which is its own
# outcome: it cannot tell (a) from (b) or (c), and says so instead of implying
# a cache assertion it did not make.
set -euo pipefail

restored="" prefix="" log="" keys=""
while [ $# -gt 0 ]; do
  case "$1" in
    --restored) restored="$2"; shift 2 ;;
    --prefix)   prefix="$2";   shift 2 ;;
    --log)      log="$2";      shift 2 ;;
    --keys)     keys="$2";     shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$prefix" ] || { echo "--prefix is required" >&2; exit 2; }

stats() { grep -E 'Cache hits|Commands:' "$log" 2>/dev/null || true; }

# LITERAL prefix matching. `grep "^$prefix"` treats the prefix as a regex, and a
# prefix carries dots -- `rustc-1.100.0-nightly` -- so `.` matches any character
# and a key differing only at those positions would falsely read as BROKEN, i.e.
# a red build for a cache that is not there. `case` globs literally.
starts_with_prefix() {
  while IFS= read -r key; do
    case "$key" in "${prefix}"*) return 0 ;; esac
  done < "$1"
  return 1
}
matching_keys() {
  while IFS= read -r key; do
    case "$key" in "${prefix}"*) printf '%s\n' "$key" ;; esac
  done < "$1"
}

# A cache WAS restored: the original assertion, unchanged.
if [ -n "$restored" ]; then
  if grep -qE 'Cache hits: (100|[1-9][0-9])%' "$log"; then
    echo "OK: this PR reused the cache dev seeded"
    exit 0
  fi
  echo "REGRESSION: a seeded cache was restored but produced no hits"
  stats
  exit 1
fi

if [ -z "$keys" ]; then
  echo "COULD NOT DETERMINE: the Actions cache list is unreadable, so a missing seed"
  echo "cannot be distinguished from a broken one. Not treating this as a cache assertion."
  stats
  exit 0
fi

if starts_with_prefix "$keys"; then
  echo "BROKEN: a cache exists under ${prefix} but nothing was restored."
  echo "That is a restore failure, not a missing seed. Seeds present:"
  matching_keys "$keys"
  exit 1
fi

if grep -q '^nativelink-cas-' "$keys"; then
  echo "NEW PREFIX: no seed under ${prefix} yet, but other compilers have seeds."
  echo "Expected right after a toolchain roll; dev seeds this prefix on its next push."
  grep '^nativelink-cas-' "$keys" || true
  stats
  exit 0
fi

echo "NO SEED AT ALL: no nativelink cache exists in this repository yet."
stats
exit 0
