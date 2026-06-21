#!/usr/bin/env bash
# Recreate the dedicated e2e database and apply the sqlx schema migrations.
#
# Drops + recreates `mnt_e2e` (a clean slate every run so cold-start seeding is
# deterministic), then runs the app's `migrate` role which applies the embedded
# migrations and exits. Connects to local Postgres as the current OS user (the
# PG superuser on this box), which owns the schema and bypasses RLS for seeding.
set -euo pipefail

PG_SUPERUSER="${E2E_PG_SUPERUSER:-${USER}}"
PG_HOST="${E2E_PG_HOST:-localhost}"
PG_PORT="${E2E_PG_PORT:-5432}"
DB_NAME="${E2E_DB_NAME:-mnt_e2e}"
ADMIN_URL="postgres://${PG_SUPERUSER}@${PG_HOST}:${PG_PORT}/postgres"
export DATABASE_URL="postgres://${PG_SUPERUSER}@${PG_HOST}:${PG_PORT}/${DB_NAME}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="${REPO_ROOT}/backend"
MNT_APP_BIN="${MNT_APP_BIN:-${BACKEND_DIR}/target/debug/mnt-app}"

echo "db: dropping + recreating ${DB_NAME}" >&2
psql "${ADMIN_URL}" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE);"
psql "${ADMIN_URL}" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE ${DB_NAME};"

echo "db: applying migrations (MNT_APP_ROLE=migrate)" >&2
if [[ -x "${MNT_APP_BIN}" ]]; then
  MNT_APP_ROLE=migrate DATABASE_URL="${DATABASE_URL}" "${MNT_APP_BIN}"
else
  ( cd "${BACKEND_DIR}" && MNT_APP_ROLE=migrate DATABASE_URL="${DATABASE_URL}" cargo run -q -p mnt-app )
fi

echo "db: seeding tenant fixtures" >&2
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -q -f "$(dirname "${BASH_SOURCE[0]}")/seed.sql"

echo "db: seeding MECHANIC story fixtures" >&2
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -q -f "$(dirname "${BASH_SOURCE[0]}")/seed-mech.sql"

echo "db: seeding ADMIN/SUPER_ADMIN story fixtures" >&2
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -q -f "$(dirname "${BASH_SOURCE[0]}")/seed-admin.sql"

echo "db: seeding EXECUTIVE story fixtures" >&2
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -q -f "$(dirname "${BASH_SOURCE[0]}")/seed-exec.sql"

echo "db: seeding RECEPTIONIST story fixtures" >&2
psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -q -f "$(dirname "${BASH_SOURCE[0]}")/seed-recp.sql"

echo "db: ready (${DATABASE_URL})" >&2
