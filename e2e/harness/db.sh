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
MIGRATIONS_DIR="${BACKEND_DIR}/crates/platform/db/migrations"
MNT_APP_BIN="${MNT_APP_BIN:-}"

run_source_migrations() {
  # Build/run from source: force sqlx offline so the apalis-postgres dep (and
  # our own queries) compile against the committed `.sqlx` cache, not the empty
  # mnt_e2e DB (which lacks `apalis.jobs` until migrations run).
  ( cd "${BACKEND_DIR}" && \
    CARGO_INCREMENTAL="${CARGO_INCREMENTAL:-0}" \
    CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-${REPO_ROOT}/.tmp/cargo-target-e2e}" \
    SQLX_OFFLINE=true MNT_APP_ROLE=migrate DATABASE_URL="${DATABASE_URL}" cargo run -q -p mnt-app )
}

migration_file_count() {
  find "${MIGRATIONS_DIR}" -type f -name '*.sql' | wc -l | tr -d ' '
}

applied_migration_count() {
  psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -Atqc "SELECT count(*) FROM _sqlx_migrations"
}

create_clean_db() {
  psql "${ADMIN_URL}" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE);"
  psql "${ADMIN_URL}" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE ${DB_NAME};"
}

echo "db: dropping + recreating ${DB_NAME}" >&2
create_clean_db

echo "db: applying migrations (MNT_APP_ROLE=migrate)" >&2
if [[ -n "${MNT_APP_BIN}" && -x "${MNT_APP_BIN}" ]]; then
  newer_migration="$(find "${MIGRATIONS_DIR}" -type f -name '*.sql' -newer "${MNT_APP_BIN}" -print -quit)"
  if [[ -n "${newer_migration}" ]]; then
    echo "db: ${MNT_APP_BIN} is older than ${newer_migration#"${REPO_ROOT}/"}; using source migrations" >&2
    run_source_migrations
  else
    MNT_APP_ROLE=migrate DATABASE_URL="${DATABASE_URL}" "${MNT_APP_BIN}"

    expected_migrations="$(migration_file_count)"
    applied_migrations="$(applied_migration_count)"
    if [[ "${applied_migrations}" != "${expected_migrations}" ]]; then
      echo "db: ${MNT_APP_BIN} applied ${applied_migrations}/${expected_migrations} checked-out migrations; recreating DB with source migrations" >&2
      create_clean_db
      run_source_migrations
    fi
  fi
else
  run_source_migrations
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
