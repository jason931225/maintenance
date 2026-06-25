#!/usr/bin/env bash
set -u

hook="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/no-cargo-enforcer.sh"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
fail=0

check() {
  local name="$1" expected="$2" command="$3" workdir="${4:-$repo_root}" code
  printf '{"tool_input":{"command":"%s","workdir":"%s"}}' "$command" "$workdir" | "$hook" >/tmp/no-cargo-enforcer.out 2>&1
  code=$?
  if [[ "$code" != "$expected" ]]; then
    printf 'FAIL %s expected=%s got=%s\n' "$name" "$expected" "$code" >&2
    cat /tmp/no-cargo-enforcer.out >&2
    fail=1
  fi
}

c=cargo
t=test
check host-block 2 "$c $t"
check metadata-allow 0 "$c metadata"
check quoted-allow 0 'git commit -m \"cargo test\"'
check docker-allow 0 "docker run --rm rust:latest $c $t"
check outside-repo-allow 0 "$c $t" /tmp

exit "$fail"
