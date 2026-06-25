#!/usr/bin/env bash
# maintenance no-cargo-enforcer (PreToolUse:Bash)
# Repo-local guard: avoid accidental long-running local Cargo build/check/test/run
# commands from Codex. CI may still invoke Cargo internally until this repo has a
# complete Buck2 build graph; metadata/install/vendor/version remain allowed.
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
payload="$(cat)"

extract_json_string() {
  local key="$1"
  printf '%s' "$payload" \
    | tr '\n' ' ' \
    | sed -nE "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"(([^\"\\\\]|\\\\.)*)\".*/\1/p" \
    | head -n 1 \
    | sed -E 's/\\n/ /g; s/\\t/ /g; s/\\r/ /g; s/\\"/"/g; s/\\\\/\\/g'
}

cmd="$(extract_json_string command)"
if [[ -z "$cmd" ]]; then
  cmd="$(extract_json_string cmd)"
fi

workdir="$(extract_json_string workdir)"
if [[ -z "$workdir" ]]; then
  workdir="$(extract_json_string cwd)"
fi
if [[ -z "$workdir" ]]; then
  workdir="$PWD"
fi

# Scope this repo-local hook to this repository only even when registered in the
# global Codex hook file.
case "$(cd "$workdir" 2>/dev/null && pwd -P || printf '%s' "$workdir")" in
  "$repo_root"|"$repo_root"/*) ;;
  *) exit 0 ;;
esac

# Strip quoted strings before matching so commit messages, PR comments, and JSON
# payloads mentioning forbidden examples do not false-positive.
cmd_stripped="$(printf '%s' "$cmd" | sed -E "s/'[^']*'//g; s/\"[^\"]*\"//g")"

# Containerized Cargo is okay; the guard is for host-local Cargo.
if printf '%s' "$cmd_stripped" | grep -Eq '^[[:space:]]*(docker|podman)([[:space:]]|$)'; then
  exit 0
fi

# cargo, optional toolchain (+stable), then local build/verify/run subcommand.
if printf '%s' "$cmd_stripped" | grep -Eq '(^|[;&|(]|[[:space:]])cargo[[:space:]]+(\+[^[:space:]]+[[:space:]]+)?(build|check|test|nextest|clippy|run|bench)([[:space:]]|$)'; then
  {
    echo "🚫 BLOCKED: direct local 'cargo build/check/test/clippy/run/bench' is disabled for this repository."
    echo "Use repo scripts/CI, generated-client checks, or Buck2 where available."
    echo "Allowed: cargo metadata / cargo install / cargo vendor / cargo --version / cargo tree / cargo search."
  } >&2
  exit 2
fi

exit 0
