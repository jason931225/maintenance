#!/usr/bin/env bash
# Boot the mnt-app API role for e2e and block until /readyz is green.
#
# Same-origin requirement: the browser loads the Vite origin
# (http://localhost:5173) and proxies /api -> 127.0.0.1:8080, so the WebAuthn RP
# origin MUST be the Vite origin, not the backend's. MNT_COOKIE_SECURE=false lets
# the HttpOnly mnt_refresh cookie set over plain http. MNT_EMAIL_STUB_MODE=e2e
# explicitly enables the OTP-logging email stub used by signup specs. The
# cold-start OTP seeds the PLATFORM admin so AUTH-01 can redeem it.
#
# Writes the child PID to e2e/.auth/backend.pid for teardown. Idempotent keys via
# gen-keys.sh. Sourcing is not required; run directly.
set -euo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${E2E_DIR}/.." && pwd)"
BACKEND_DIR="${REPO_ROOT}/backend"
MIGRATIONS_DIR="${BACKEND_DIR}/crates/platform/db/migrations"
AUTH_DIR="${E2E_DIR}/.auth"
PID_FILE="${AUTH_DIR}/backend.pid"
LOG_FILE="${AUTH_DIR}/backend.log"
MNT_APP_BIN="${MNT_APP_BIN:-}"

run_source_app() {
  # Build/run from source: force sqlx offline so the apalis-postgres dep (and
  # our own queries) compile against the committed `.sqlx` cache, not the empty
  # mnt_e2e DB (which lacks `apalis.jobs` until migrations run).
  ( cd "${BACKEND_DIR}" && \
    CARGO_INCREMENTAL="${CARGO_INCREMENTAL:-0}" \
    CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-${REPO_ROOT}/.tmp/cargo-target-e2e}" \
    SQLX_OFFLINE=true cargo run -q -p mnt-app >"${LOG_FILE}" 2>&1 ) &
}

mkdir -p "${AUTH_DIR}"

HTTP_ADDR="${E2E_HTTP_ADDR:-127.0.0.1:8080}"
HTTP_PORT="${HTTP_ADDR##*:}"

# Reap any backend we started previously, then free the port defensively so a
# stale process from an earlier run cannot answer probes with the wrong JWT keys
# or OTP (which manifests as confusing 401s).
if [[ -s "${PID_FILE}" ]]; then
  OLD_PID="$(cat "${PID_FILE}")"
  if kill -0 "${OLD_PID}" 2>/dev/null; then
    kill "${OLD_PID}" 2>/dev/null || true
    sleep 0.5
  fi
fi
if command -v lsof >/dev/null 2>&1; then
  STALE_PIDS="$(lsof -ti ":${HTTP_PORT}" 2>/dev/null || true)"
  if [[ -n "${STALE_PIDS}" ]]; then
    echo "boot-backend: freeing port ${HTTP_PORT} (killing: ${STALE_PIDS})" >&2
    echo "${STALE_PIDS}" | xargs -r kill -9 2>/dev/null || true
    sleep 0.5
  fi
fi

PG_HOST="${E2E_PG_HOST:-localhost}"
PG_PORT="${E2E_PG_PORT:-5432}"
DB_NAME="${E2E_DB_NAME:-mnt_e2e}"

# ES256 keypair -> exports MNT_JWT_PRIVATE_KEY_PEM / MNT_JWT_PUBLIC_KEY_PEM.
# shellcheck source=./gen-keys.sh
. "$(dirname "${BASH_SOURCE[0]}")/gen-keys.sh"

export MNT_APP_ROLE=api
MNT_RT_POSTGRES_PASSWORD="${E2E_MNT_RT_POSTGRES_PASSWORD:-mnt-e2e-runtime-change-me}"
MNT_LEAVE_COMMAND_POSTGRES_PASSWORD="${E2E_MNT_LEAVE_COMMAND_POSTGRES_PASSWORD:-mnt-e2e-leave-command-change-me}"
MNT_ONTOLOGY_COMMAND_POSTGRES_PASSWORD="${E2E_MNT_ONTOLOGY_COMMAND_POSTGRES_PASSWORD:-mnt-e2e-ontology-command-change-me}"
export DATABASE_URL="postgres://mnt_rt:${MNT_RT_POSTGRES_PASSWORD}@${PG_HOST}:${PG_PORT}/${DB_NAME}"
export LEAVE_COMMAND_DATABASE_URL="postgres://mnt_leave_cmd:${MNT_LEAVE_COMMAND_POSTGRES_PASSWORD}@${PG_HOST}:${PG_PORT}/${DB_NAME}"
export ONTOLOGY_COMMAND_DATABASE_URL="postgres://mnt_ontology_cmd:${MNT_ONTOLOGY_COMMAND_POSTGRES_PASSWORD}@${PG_HOST}:${PG_PORT}/${DB_NAME}"
export MNT_HTTP_ADDR="${HTTP_ADDR}"
export MNT_WEBAUTHN_RP_ID="${E2E_RP_ID:-localhost}"
export MNT_WEBAUTHN_RP_ORIGIN="${E2E_RP_ORIGIN:-http://localhost:5173}"
export MNT_COOKIE_SECURE=false
export MNT_EMAIL_STUB_MODE=e2e
export MNT_COLDSTART_OTP="${E2E_COLDSTART_OTP:-e2e-coldstart-otp-000}"
export MNT_DISPATCH_JOBS_ENABLED=false
export RUST_LOG="${RUST_LOG:-info}"

echo "boot-backend: starting mnt-app api on ${MNT_HTTP_ADDR}" >&2
if [[ -n "${MNT_APP_BIN}" && -x "${MNT_APP_BIN}" ]]; then
  newer_migration="$(find "${MIGRATIONS_DIR}" -type f -name '*.sql' -newer "${MNT_APP_BIN}" -print -quit)"
  if [[ -n "${newer_migration}" ]]; then
    echo "boot-backend: ${MNT_APP_BIN} is older than ${newer_migration#"${REPO_ROOT}/"}; using source app" >&2
    run_source_app
  else
    "${MNT_APP_BIN}" >"${LOG_FILE}" 2>&1 &
  fi
else
  run_source_app
fi
BACKEND_PID=$!
echo "${BACKEND_PID}" >"${PID_FILE}"
echo "boot-backend: pid ${BACKEND_PID} (log: ${LOG_FILE})" >&2

READY_URL="http://${MNT_HTTP_ADDR}/readyz"
for _ in $(seq 1 60); do
  if ! kill -0 "${BACKEND_PID}" 2>/dev/null; then
    echo "boot-backend: process exited early; last log lines:" >&2
    tail -20 "${LOG_FILE}" >&2 || true
    exit 1
  fi
  if curl -fsS "${READY_URL}" >/dev/null 2>&1; then
    echo "boot-backend: /readyz green" >&2
    exit 0
  fi
  sleep 0.5
done

echo "boot-backend: timed out waiting for ${READY_URL}; last log lines:" >&2
tail -20 "${LOG_FILE}" >&2 || true
exit 1
