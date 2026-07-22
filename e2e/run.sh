#!/usr/bin/env bash
# One-shot, reproducible, CI-ready orchestration of the browser-E2E suite.
#
#   gen-keys -> db (drop+migrate+seed) -> boot-backend (wait /readyz)
#            -> playwright test (builds + previews the web tier itself)
#            -> teardown.
#
# The Playwright config owns the web tier (build + `vite preview` on :5173 via its
# webServer); this script owns keys, DB, and the backend. Pass extra args straight
# through to `playwright test` (e.g. `e2e/run.sh e2e/specs/auth-01-passkey-login.spec.ts`).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARNESS="${REPO_ROOT}/e2e/harness"
AUTH_DIR="${E2E_AUTH_DIR:-${REPO_ROOT}/e2e/.auth}"
PID_FILE="${AUTH_DIR}/backend.pid"

cleanup() {
  if [[ -s "${PID_FILE}" ]]; then
    local pid
    pid="$(cat "${PID_FILE}")"
    if kill -0 "${pid}" 2>/dev/null; then
      echo "run: stopping backend pid ${pid}" >&2
      kill "${pid}" 2>/dev/null || true
    fi
    rm -f "${PID_FILE}"
  fi
  # Free the preview port if Playwright left it (e.g. on failure).
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti ":${E2E_WEB_PORT:-5173}" 2>/dev/null | xargs -r kill 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "run: [1/4] generating JWT keys" >&2
bash "${HARNESS}/gen-keys.sh" >/dev/null

echo "run: [2/4] resetting + migrating + seeding database" >&2
bash "${HARNESS}/db.sh"

echo "run: [3/4] booting backend (api role)" >&2
bash "${HARNESS}/boot-backend.sh"

echo "run: [4/4] running playwright" >&2
cd "${REPO_ROOT}"
npx playwright test "$@"
