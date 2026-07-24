#!/usr/bin/env bash
# Cheap, fail-closed Buck2 graph preflight.  It never writes to the caller's
# worktree: generation runs against a temporary archive of HEAD instead.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
buck_bin="${MNT_BUCK_PREFLIGHT_BUCK:-${repo_root}/tools/buck2}"
expected_release="2026-07-15"
safe_user="${USER:-user}"
safe_user="${safe_user//[^[:alnum:]_.-]/_}"
repo_hash="$(printf '%s' "${repo_root}" | cksum | awk '{print $1}')"
isolation_name="${MNT_BUCK_PREFLIGHT_ISOLATION_DIR:-mnt-buck-preflight-${safe_user}-${repo_hash}}"

if [[ ! "${isolation_name}" =~ ^[[:alnum:]_.-]+$ ]]; then
  echo "buck-preflight: isolation name must contain only letters, digits, dot, underscore, or dash" >&2
  exit 2
fi

manifest="${repo_root}/tools/buck2"
python3 - "${manifest}" "${expected_release}" <<'PY'
import json
import re
import sys
from pathlib import Path

manifest_path = Path(sys.argv[1])
release = sys.argv[2]
contents = manifest_path.read_text(encoding="utf-8").splitlines()
try:
    manifest = json.loads("\n".join(contents[1:]))
except (IndexError, json.JSONDecodeError) as error:
    raise SystemExit(f"buck-preflight: invalid dotslash manifest: {error}")

platforms = manifest.get("platforms")
if not isinstance(platforms, dict) or not platforms:
    raise SystemExit("buck-preflight: dotslash manifest has no platforms")

for platform, entry in platforms.items():
    providers = entry.get("providers")
    urls = [provider.get("url") for provider in providers or []]
    if (
        entry.get("hash") != "blake3"
        or not isinstance(entry.get("size"), int)
        or entry["size"] <= 0
        or not re.fullmatch(r"[0-9a-f]{64}", entry.get("digest", ""))
        or not isinstance(entry.get("path"), str)
        or not entry["path"]
        or not urls
        or any(
            not isinstance(url, str)
            or f"releases/download/{release}/" not in url
            for url in urls
        )
    ):
        raise SystemExit(
            f"buck-preflight: invalid immutable {release} pin for {platform}"
        )
PY

echo "buck-preflight: pinned release ${expected_release}"
python3 "${repo_root}/tools/buck/validate_generated_faces.py"
BUCK_ISOLATION_DIR="${isolation_name}" "${buck_bin}" --version
BUCK_ISOLATION_DIR="${isolation_name}" "${buck_bin}" audit cell

if ! targets="$(BUCK_ISOLATION_DIR="${isolation_name}" "${buck_bin}" uquery "kind('rust_test', '//backend/...')")"; then
  echo "buck-preflight: rust target enumeration failed" >&2
  exit 1
fi
if ! grep -Eq '(^|[[:space:]])(root)?//backend/' <<<"${targets}"; then
  echo "buck-preflight: no backend rust_test targets were enumerated" >&2
  exit 1
fi
printf 'buck-preflight: enumerated %s Rust test target(s)\n' "$(grep -Ec '(^|[[:space:]])(root)?//backend/' <<<"${targets}")"

scratch="$(mktemp -d "${TMPDIR:-/tmp}/mnt-buck-preflight.XXXXXX")"
cleanup() {
  rm -rf "${scratch}"
}
trap cleanup EXIT HUP INT TERM

# `git archive HEAD` snapshots exactly the candidate tree without touching the
# caller's index, working files, daemon state, or any parallel worktree.
git -C "${repo_root}" archive --format=tar HEAD | tar -x -C "${scratch}"
(cd "${scratch}" && python3 tools/buck/gen_first_party.py >/dev/null)
if drift="$(diff -qr "${repo_root}/backend" "${scratch}/backend")"; then
  echo "buck-preflight: first-party generator drift check passed"
else
  echo "buck-preflight: first-party generator drift detected; regenerate and commit BUCK files" >&2
  printf '%s\n' "${drift}" >&2
  exit 1
fi

echo "buck-preflight: PASS"
