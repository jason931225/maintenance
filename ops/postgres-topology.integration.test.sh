#!/usr/bin/env bash
# Real PostgreSQL regression for fresh/idempotent/drift reconciliation, secret
# log suppression, and the guarded Compose upgrade from a legacy mnt_app-only
# superuser volume.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POSTGRES_IMAGE="postgres:18.4@sha256:65f70a152846cf504dff86e807007e9aeac98c3aeb7b62541b2c55ab9d264e56"
fresh_container="mnt-topology-fresh-$$"
pg16_container="mnt-topology-pg16-$$"
prepared_container="mnt-topology-prepared-$$"
legacy_pg16_container="mnt-topology-legacy-pg16-$$"
legacy_prepared_container="mnt-topology-legacy-prepared-$$"
legacy_project="mnt-topology-legacy-$$"
rendered_cnpg_dir="$(mktemp -d "${REPO_ROOT}/.tmp-cnpg-topology.XXXXXX")"
rendered_cnpg_script="${rendered_cnpg_dir}/job-script.sh"

if docker compose version >/dev/null 2>&1; then
  compose_command=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  compose_command=(docker-compose)
else
  echo "topology-test: docker compose is required" >&2
  exit 127
fi

export MNT_POSTGRES_DB=mnt_topology_test
export MNT_POSTGRES_ADMIN_USER=mnt_cluster_admin
export MNT_POSTGRES_ADMIN_PASSWORD=admin-log-secret-93a56f
export MNT_APP_POSTGRES_PASSWORD=app-log-secret-78d24b
export MNT_RT_POSTGRES_PASSWORD=runtime-log-secret-65c13e
export MNT_LEAVE_COMMAND_POSTGRES_PASSWORD=leave-log-secret-42b07d
export MNT_ONTOLOGY_COMMAND_POSTGRES_PASSWORD=ontology-log-secret-19a84c

compose() {
  "${compose_command[@]}" -p "${legacy_project}" -f "${REPO_ROOT}/ops/compose.yml" "$@"
}

cleanup() {
  docker rm -f "${fresh_container}" >/dev/null 2>&1 || true
  docker rm -f "${pg16_container}" "${prepared_container}" \
    "${legacy_pg16_container}" "${legacy_prepared_container}" >/dev/null 2>&1 || true
  rm -f "${rendered_cnpg_script}"
  rmdir "${rendered_cnpg_dir}" >/dev/null 2>&1 || true
  compose down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_for_postgres() {
  local container="$1"
  local user="$2"
  for attempt in {1..30}; do
    # The official image briefly accepts connections from a temporary server
    # while docker-entrypoint initializes the cluster, then stops that server
    # before execing the durable PID 1. Do not let a cold pull race that handoff.
    if [[ "$(docker exec "${container}" cat /proc/1/comm 2>/dev/null || true)" == "postgres" ]] &&
      docker exec "${container}" pg_isready -U "${user}" -d "${MNT_POSTGRES_DB}" >/dev/null 2>&1; then
      return 0
    fi
    if [[ "${attempt}" == 30 ]]; then
      echo "topology-test: ${container} did not become ready" >&2
      return 1
    fi
    sleep 1
  done
}

run_fresh_reconcile() {
  docker exec \
    -e POSTGRES_HOST=127.0.0.1 \
    -e POSTGRES_DB="${MNT_POSTGRES_DB}" \
    -e POSTGRES_ADMIN_USER="${MNT_POSTGRES_ADMIN_USER}" \
    -e POSTGRES_ADMIN_PASSWORD="${MNT_POSTGRES_ADMIN_PASSWORD}" \
    -e MNT_APP_POSTGRES_PASSWORD="${MNT_APP_POSTGRES_PASSWORD}" \
    -e MNT_RT_POSTGRES_PASSWORD="${MNT_RT_POSTGRES_PASSWORD}" \
    -e MNT_LEAVE_COMMAND_POSTGRES_PASSWORD="${MNT_LEAVE_COMMAND_POSTGRES_PASSWORD}" \
    -e MNT_ONTOLOGY_COMMAND_POSTGRES_PASSWORD="${MNT_ONTOLOGY_COMMAND_POSTGRES_PASSWORD}" \
    "$@" "${fresh_container}" bash /topology.sh
}

query_as_direct_login() {
  local role="$1"
  local password="$2"
  local sql="$3"
  local postgres_address
  postgres_address="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "${fresh_container}")"
  docker run --rm --network bridge -e PGPASSWORD="${password}" "${POSTGRES_IMAGE}" \
    psql -h "${postgres_address}" -U "${role}" -d "${MNT_POSTGRES_DB}" \
    -v ON_ERROR_STOP=1 -At -F '|' -c "${sql}"
}

assert_prerequisite_refusal_before_mutation() {
  local container="$1"
  local image="$2"
  shift 2
  docker run -d --name "${container}" \
    -v "${REPO_ROOT}/ops/postgres-reconcile-topology.sh:/topology.sh:ro" \
    -e POSTGRES_DB="${MNT_POSTGRES_DB}" \
    -e POSTGRES_USER="${MNT_POSTGRES_ADMIN_USER}" \
    -e POSTGRES_PASSWORD="${MNT_POSTGRES_ADMIN_PASSWORD}" \
    "${image}" "$@" >/dev/null
  wait_for_postgres "${container}" "${MNT_POSTGRES_ADMIN_USER}"
  if docker exec \
    -e POSTGRES_HOST=127.0.0.1 \
    -e POSTGRES_DB="${MNT_POSTGRES_DB}" \
    -e POSTGRES_ADMIN_USER="${MNT_POSTGRES_ADMIN_USER}" \
    -e POSTGRES_ADMIN_PASSWORD="${MNT_POSTGRES_ADMIN_PASSWORD}" \
    -e MNT_APP_POSTGRES_PASSWORD="${MNT_APP_POSTGRES_PASSWORD}" \
    -e MNT_RT_POSTGRES_PASSWORD="${MNT_RT_POSTGRES_PASSWORD}" \
    -e MNT_LEAVE_COMMAND_POSTGRES_PASSWORD="${MNT_LEAVE_COMMAND_POSTGRES_PASSWORD}" \
    -e MNT_ONTOLOGY_COMMAND_POSTGRES_PASSWORD="${MNT_ONTOLOGY_COMMAND_POSTGRES_PASSWORD}" \
    "${container}" bash /topology.sh >/dev/null 2>&1; then
    echo "topology-test: prerequisite refusal unexpectedly succeeded for ${image}" >&2
    exit 1
  fi
  test "$(docker exec "${container}" psql -U "${MNT_POSTGRES_ADMIN_USER}" -d "${MNT_POSTGRES_DB}" -Atqc \
    "SELECT count(*) FROM pg_roles WHERE rolname IN ('mnt_app','mnt_rt','mnt_leave_cmd','mnt_ontology_cmd','mnt_leave_definer','mnt_ontology_writer')")" = 0
  docker rm -f "${container}" >/dev/null
}

assert_prerequisite_refusal_before_mutation "${pg16_container}" postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777
assert_prerequisite_refusal_before_mutation "${prepared_container}" "${POSTGRES_IMAGE}" -c max_prepared_transactions=10

legacy_catalog_snapshot() {
  local container="$1"
  docker exec "${container}" psql -U mnt_app -d "${MNT_POSTGRES_DB}" -At -F '|' <<'SQL'
SELECT 'role', oid::text, rolname, rolcanlogin::text, rolsuper::text,
       rolbypassrls::text, rolinherit::text, rolcreatedb::text,
       rolcreaterole::text, rolreplication::text, COALESCE(rolpassword, '')
FROM pg_authid
WHERE rolname IN ('mnt_app', 'mnt_rt', 'mnt_cluster_admin', 'mnt_legacy_conversion_admin')
UNION ALL
SELECT 'relation', relation.oid::text, namespace.nspname || '.' || relation.relname,
       relation.relowner::text, COALESCE(relation.relacl::text, ''), '', '', '', '', '', ''
FROM pg_class relation
JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
WHERE namespace.nspname = 'public' AND relation.relname = 'legacy_prerequisite_marker'
UNION ALL
SELECT 'default_acl', defaults.oid::text, defaults.defaclrole::text,
       defaults.defaclnamespace::text, defaults.defaclobjtype::text,
       defaults.defaclacl::text, '', '', '', '', ''
FROM pg_default_acl defaults
WHERE defaults.defaclrole = (SELECT oid FROM pg_roles WHERE rolname='mnt_app')
ORDER BY 1, 3;
SQL
}

assert_legacy_prerequisite_refusal_before_mutation() {
  local container="$1"
  local image="$2"
  shift 2
  docker run -d --name "${container}" \
    -v "${REPO_ROOT}/ops/postgres-reconcile-topology.sh:/topology.sh:ro" \
    -e POSTGRES_DB="${MNT_POSTGRES_DB}" \
    -e POSTGRES_USER=mnt_app \
    -e POSTGRES_PASSWORD=legacy-prerequisite-password-73d1 \
    "${image}" "$@" >/dev/null
  wait_for_postgres "${container}" mnt_app
  docker exec "${container}" psql -U mnt_app -d "${MNT_POSTGRES_DB}" -v ON_ERROR_STOP=1 -qc \
    "CREATE ROLE mnt_rt NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
     CREATE TABLE public.legacy_prerequisite_marker (id bigint PRIMARY KEY);
     ALTER DEFAULT PRIVILEGES FOR ROLE mnt_app IN SCHEMA public
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mnt_rt"
  local before after failure_output
  before="$(legacy_catalog_snapshot "${container}")"
  if failure_output="$(docker exec \
    -e POSTGRES_HOST=127.0.0.1 \
    -e POSTGRES_DB="${MNT_POSTGRES_DB}" \
    -e POSTGRES_ADMIN_USER=mnt_cluster_admin \
    -e POSTGRES_ADMIN_PASSWORD=legacy-new-admin-password-a672 \
    -e MNT_APP_POSTGRES_PASSWORD=legacy-new-owner-password-b783 \
    -e MNT_RT_POSTGRES_PASSWORD=legacy-new-runtime-password-c894 \
    -e MNT_LEAVE_COMMAND_POSTGRES_PASSWORD=legacy-new-leave-password-d905 \
    -e MNT_ONTOLOGY_COMMAND_POSTGRES_PASSWORD=legacy-new-ontology-password-e016 \
    -e MNT_ALLOW_LEGACY_MNT_APP_SUPERUSER_CONVERSION=1 \
    "${container}" bash /topology.sh 2>&1)"; then
    echo "topology-test: legacy prerequisite refusal unexpectedly succeeded for ${image}" >&2
    exit 1
  fi
  grep -Fq 'topology.transaction_timeout_prerequisite_failed' <<<"${failure_output}"
  after="$(legacy_catalog_snapshot "${container}")"
  test "${after}" = "${before}"
  docker rm -f "${container}" >/dev/null
}

assert_legacy_prerequisite_refusal_before_mutation \
  "${legacy_pg16_container}" \
  postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777
assert_legacy_prerequisite_refusal_before_mutation \
  "${legacy_prepared_container}" "${POSTGRES_IMAGE}" -c max_prepared_transactions=10

docker run -d --name "${fresh_container}" \
  -v "${REPO_ROOT}/ops/postgres-reconcile-topology.sh:/topology.sh:ro" \
  -e POSTGRES_DB="${MNT_POSTGRES_DB}" \
  -e POSTGRES_USER="${MNT_POSTGRES_ADMIN_USER}" \
  -e POSTGRES_PASSWORD="${MNT_POSTGRES_ADMIN_PASSWORD}" \
  "${POSTGRES_IMAGE}" -c log_statement=all >/dev/null
wait_for_postgres "${fresh_container}" "${MNT_POSTGRES_ADMIN_USER}"

# Force the first secret-bearing CREATE ROLE to fail. PostgreSQL is configured
# to log every statement, so the marker would appear unless transaction-local
# suppression was active before password DDL reached the server.
if run_fresh_reconcile -e PGOPTIONS='-c default_transaction_read_only=on' >/dev/null 2>&1; then
  echo "topology-test: forced secret-DDL failure unexpectedly succeeded" >&2
  exit 1
fi
fresh_logs="$(docker logs "${fresh_container}" 2>&1)"
for secret in \
  "${MNT_POSTGRES_ADMIN_PASSWORD}" \
  "${MNT_APP_POSTGRES_PASSWORD}" \
  "${MNT_RT_POSTGRES_PASSWORD}" \
  "${MNT_LEAVE_COMMAND_POSTGRES_PASSWORD}" \
  "${MNT_ONTOLOGY_COMMAND_POSTGRES_PASSWORD}"; do
  if grep -Fq "${secret}" <<<"${fresh_logs}"; then
    echo "topology-test: PostgreSQL log leaked a database password" >&2
    exit 1
  fi
done

run_fresh_reconcile

for direct_login in \
  "mnt_rt|${MNT_RT_POSTGRES_PASSWORD}" \
  "mnt_leave_cmd|${MNT_LEAVE_COMMAND_POSTGRES_PASSWORD}" \
  "mnt_ontology_cmd|${MNT_ONTOLOGY_COMMAND_POSTGRES_PASSWORD}"; do
  IFS='|' read -r role password <<<"${direct_login}"
  fresh_runtime_gucs="$(query_as_direct_login "${role}" "${password}" \
    "SELECT current_setting('statement_timeout'),current_setting('idle_in_transaction_session_timeout'),current_setting('transaction_timeout')")"
  test "${fresh_runtime_gucs}" = '30s|30s|45s'
done

docker exec "${fresh_container}" psql -U "${MNT_POSTGRES_ADMIN_USER}" -d "${MNT_POSTGRES_DB}" -v ON_ERROR_STOP=1 -qc \
  "CREATE DATABASE topology_other"
for role in mnt_rt mnt_leave_cmd mnt_ontology_cmd; do
  docker exec "${fresh_container}" psql -U "${MNT_POSTGRES_ADMIN_USER}" -d "${MNT_POSTGRES_DB}" -v ON_ERROR_STOP=1 -qc \
    "ALTER ROLE ${role} SET statement_timeout='1s';
     ALTER ROLE ${role} SET idle_in_transaction_session_timeout='2s';
     ALTER ROLE ${role} SET transaction_timeout='5s';
     ALTER ROLE ${role} IN DATABASE ${MNT_POSTGRES_DB} SET statement_timeout='3s';
     ALTER ROLE ${role} IN DATABASE ${MNT_POSTGRES_DB} SET idle_in_transaction_session_timeout='4s';
     ALTER ROLE ${role} IN DATABASE ${MNT_POSTGRES_DB} SET transaction_timeout='6s';
     ALTER ROLE ${role} IN DATABASE topology_other SET statement_timeout='7s';
     ALTER ROLE ${role} IN DATABASE topology_other SET idle_in_transaction_session_timeout='8s';
     ALTER ROLE ${role} IN DATABASE topology_other SET transaction_timeout='9s';"
done
docker exec "${fresh_container}" psql -U "${MNT_POSTGRES_ADMIN_USER}" -d "${MNT_POSTGRES_DB}" -v ON_ERROR_STOP=1 -qc \
  "ALTER ROLE mnt_rt SET default_transaction_isolation='repeatable read';
   ALTER ROLE mnt_rt IN DATABASE ${MNT_POSTGRES_DB} SET work_mem='8MB';
   ALTER ROLE mnt_rt IN DATABASE topology_other SET application_name='preserve_database_runtime_guc';"

declare -a stale_client_processes=()
declare -a stale_backend_pids=()
for direct_login in \
  "mnt_rt|${MNT_RT_POSTGRES_PASSWORD}" \
  "mnt_leave_cmd|${MNT_LEAVE_COMMAND_POSTGRES_PASSWORD}" \
  "mnt_ontology_cmd|${MNT_ONTOLOGY_COMMAND_POSTGRES_PASSWORD}"; do
  IFS='|' read -r role password <<<"${direct_login}"
  application_name="topology_stale_${role}_$$"
  docker exec -e PGPASSWORD="${password}" \
    -e PGAPPNAME="${application_name}" \
    -e PGOPTIONS="-c statement_timeout=0 -c idle_in_transaction_session_timeout=0 -c transaction_timeout=0" \
    "${fresh_container}" psql -h 127.0.0.1 -U "${role}" -d "${MNT_POSTGRES_DB}" \
    -v ON_ERROR_STOP=1 -qc "SELECT pg_sleep(120)" >/dev/null 2>&1 &
  stale_client_processes+=("$!")
  for attempt in {1..30}; do
    stale_pid="$(docker exec "${fresh_container}" psql -U "${MNT_POSTGRES_ADMIN_USER}" -d "${MNT_POSTGRES_DB}" -Atqc \
      "SELECT pid FROM pg_stat_activity WHERE application_name='${application_name}'")"
    if [[ -n "${stale_pid}" ]]; then
      stale_backend_pids+=("${stale_pid}")
      break
    fi
    sleep 0.1
  done
  test -n "${stale_pid}"
done
run_fresh_reconcile
for stale_client_process in "${stale_client_processes[@]}"; do
  if wait "${stale_client_process}"; then
    echo "topology-test: reconciliation did not drain an existing serving session" >&2
    exit 1
  fi
done
captured_pid_csv="$(IFS=,; echo "${stale_backend_pids[*]}")"
test "$(docker exec "${fresh_container}" psql -U "${MNT_POSTGRES_ADMIN_USER}" -d "${MNT_POSTGRES_DB}" -Atqc \
  "SELECT count(*) FROM pg_stat_activity WHERE pid = ANY (ARRAY[${captured_pid_csv}]::integer[])")" = 0

expected_runtime_settings='mnt_leave_cmd|global|idle_in_transaction_session_timeout=30s
mnt_leave_cmd|global|statement_timeout=30s
mnt_leave_cmd|global|transaction_timeout=45s
mnt_ontology_cmd|global|idle_in_transaction_session_timeout=30s
mnt_ontology_cmd|global|statement_timeout=30s
mnt_ontology_cmd|global|transaction_timeout=45s
mnt_rt|global|default_transaction_isolation=repeatable read
mnt_rt|global|idle_in_transaction_session_timeout=30s
mnt_rt|global|statement_timeout=30s
mnt_rt|global|transaction_timeout=45s
mnt_rt|mnt_topology_test|work_mem=8MB
mnt_rt|topology_other|application_name=preserve_database_runtime_guc'
actual_runtime_settings="$(docker exec "${fresh_container}" psql -U "${MNT_POSTGRES_ADMIN_USER}" -d "${MNT_POSTGRES_DB}" -At -F '|' -c \
  "SELECT role.rolname, CASE settings.setdatabase WHEN 0 THEN 'global' ELSE database.datname END, setting FROM pg_db_role_setting settings JOIN pg_roles role ON role.oid=settings.setrole LEFT JOIN pg_database database ON database.oid=settings.setdatabase CROSS JOIN LATERAL unnest(settings.setconfig) setting WHERE role.rolname IN ('mnt_rt','mnt_leave_cmd','mnt_ontology_cmd') ORDER BY 1,2,3")"
test "${actual_runtime_settings}" = "${expected_runtime_settings}"
for direct_login in \
  "mnt_rt|${MNT_RT_POSTGRES_PASSWORD}" \
  "mnt_leave_cmd|${MNT_LEAVE_COMMAND_POSTGRES_PASSWORD}" \
  "mnt_ontology_cmd|${MNT_ONTOLOGY_COMMAND_POSTGRES_PASSWORD}"; do
  IFS='|' read -r role password <<<"${direct_login}"
  restored_runtime_gucs="$(query_as_direct_login "${role}" "${password}" \
    "SELECT current_setting('statement_timeout'),current_setting('idle_in_transaction_session_timeout'),current_setting('transaction_timeout')")"
  test "${restored_runtime_gucs}" = '30s|30s|45s'
done
restored_unrelated_gucs="$(query_as_direct_login mnt_rt "${MNT_RT_POSTGRES_PASSWORD}" \
  "SELECT current_setting('default_transaction_isolation'),current_setting('work_mem')")"
test "${restored_unrelated_gucs}" = 'repeatable read|8MB'

docker exec -i -e PGPASSWORD="${MNT_APP_POSTGRES_PASSWORD}" "${fresh_container}" \
  psql -h 127.0.0.1 -U mnt_app -d "${MNT_POSTGRES_DB}" -v ON_ERROR_STOP=1 \
  < "${REPO_ROOT}/backend/crates/platform/db/migrations/0112_mnt_rt_statement_timeout.sql"
docker exec -i -e PGPASSWORD="${MNT_APP_POSTGRES_PASSWORD}" "${fresh_container}" \
  psql -h 127.0.0.1 -U mnt_app -d "${MNT_POSTGRES_DB}" -v ON_ERROR_STOP=1 \
  < "${REPO_ROOT}/backend/crates/platform/db/migrations/0167_serving_role_transaction_timeouts.sql"

# The non-superuser migration path is assert-only. A wrong global default plus
# a higher-precedence per-database override must fail atomically and preserve
# the catalog for operator reconciliation.
docker exec "${fresh_container}" psql -U "${MNT_POSTGRES_ADMIN_USER}" -d "${MNT_POSTGRES_DB}" -v ON_ERROR_STOP=1 -qc \
  "ALTER ROLE mnt_leave_cmd SET transaction_timeout='44s';
   ALTER ROLE mnt_ontology_cmd IN DATABASE ${MNT_POSTGRES_DB} SET statement_timeout='29s';"
migration_drift_before="$(docker exec "${fresh_container}" psql -U "${MNT_POSTGRES_ADMIN_USER}" -d "${MNT_POSTGRES_DB}" -Atqc \
  "SELECT string_agg(role.rolname || '|' || settings.setdatabase || '|' || setting, E'\\n' ORDER BY role.rolname, settings.setdatabase, setting) FROM pg_db_role_setting settings JOIN pg_roles role ON role.oid=settings.setrole CROSS JOIN LATERAL unnest(settings.setconfig) setting WHERE role.rolname IN ('mnt_rt','mnt_leave_cmd','mnt_ontology_cmd')")"
if docker exec -i -e PGPASSWORD="${MNT_APP_POSTGRES_PASSWORD}" "${fresh_container}" \
  psql -h 127.0.0.1 -U mnt_app -d "${MNT_POSTGRES_DB}" -v ON_ERROR_STOP=1 \
  < "${REPO_ROOT}/backend/crates/platform/db/migrations/0167_serving_role_transaction_timeouts.sql" >/dev/null 2>&1; then
  echo "topology-test: owner-run 0167 accepted wrong/overridden timeout catalog" >&2
  exit 1
fi
migration_drift_after="$(docker exec "${fresh_container}" psql -U "${MNT_POSTGRES_ADMIN_USER}" -d "${MNT_POSTGRES_DB}" -Atqc \
  "SELECT string_agg(role.rolname || '|' || settings.setdatabase || '|' || setting, E'\\n' ORDER BY role.rolname, settings.setdatabase, setting) FROM pg_db_role_setting settings JOIN pg_roles role ON role.oid=settings.setrole CROSS JOIN LATERAL unnest(settings.setconfig) setting WHERE role.rolname IN ('mnt_rt','mnt_leave_cmd','mnt_ontology_cmd')")"
test "${migration_drift_after}" = "${migration_drift_before}"
run_fresh_reconcile

# Execute the exact embedded CNPG Job script against the ephemeral database.
# A late bad credential must fail during preflight without draining mnt_rt;
# hostile low role defaults must not wedge the scoped repair connection.
python3 - \
  "${REPO_ROOT}/deploy/apps/maintenance/components/governed-command-database/database-topology-job.yaml" \
  "${rendered_cnpg_script}" <<'PY'
import pathlib
import sys

source = pathlib.Path(sys.argv[1]).read_text().splitlines()
marker = source.index("            - |")
script = []
for line in source[marker + 1:]:
    if line and not line.startswith(" " * 14):
        break
    script.append(line[14:] if line else "")
pathlib.Path(sys.argv[2]).write_text("\n".join(script) + "\n")
PY
test -s "${rendered_cnpg_script}"
postgres_address="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "${fresh_container}")"
cnpg_application_name="cnpg_preflight_survivor_$$"
docker exec -e PGPASSWORD="${MNT_RT_POSTGRES_PASSWORD}" \
  -e PGAPPNAME="${cnpg_application_name}" \
  -e PGOPTIONS="-c statement_timeout=0 -c idle_in_transaction_session_timeout=0 -c transaction_timeout=0" \
  "${fresh_container}" psql -h 127.0.0.1 -U mnt_rt -d "${MNT_POSTGRES_DB}" \
  -v ON_ERROR_STOP=1 -qc "SELECT pg_sleep(120)" >/dev/null 2>&1 &
cnpg_stale_client=$!
for attempt in {1..30}; do
  cnpg_stale_pid="$(docker exec "${fresh_container}" psql -U "${MNT_POSTGRES_ADMIN_USER}" -d "${MNT_POSTGRES_DB}" -Atqc \
    "SELECT pid FROM pg_stat_activity WHERE application_name='${cnpg_application_name}'")"
  [[ -n "${cnpg_stale_pid}" ]] && break
  sleep 0.1
done
test -n "${cnpg_stale_pid}"
if docker run --rm --network bridge \
  -v "${rendered_cnpg_script}:/cnpg-topology.sh:ro" \
  -e PGHOST="${postgres_address}" -e PGPORT=5432 -e PGDATABASE="${MNT_POSTGRES_DB}" \
  -e PGUSER=mnt_app -e PGPASSWORD="${MNT_APP_POSTGRES_PASSWORD}" \
  -e MNT_RT_USERNAME=mnt_rt -e MNT_RT_PASSWORD="${MNT_RT_POSTGRES_PASSWORD}" \
  -e MNT_LEAVE_COMMAND_USERNAME=mnt_leave_cmd -e MNT_LEAVE_COMMAND_PASSWORD=invalid-late-credential \
  -e MNT_ONTOLOGY_COMMAND_USERNAME=mnt_ontology_cmd -e MNT_ONTOLOGY_COMMAND_PASSWORD="${MNT_ONTOLOGY_COMMAND_POSTGRES_PASSWORD}" \
  "${POSTGRES_IMAGE}" bash -ceu 'source /cnpg-topology.sh' >/dev/null 2>&1; then
  echo "topology-test: rendered CNPG script accepted an invalid second credential" >&2
  exit 1
fi
test "$(docker exec "${fresh_container}" psql -U "${MNT_POSTGRES_ADMIN_USER}" -d "${MNT_POSTGRES_DB}" -Atqc \
  "SELECT count(*) FROM pg_stat_activity WHERE pid=${cnpg_stale_pid}")" = 1
# An exact-state recurring Sync hook is readback-only and must not abort a
# healthy compliant session merely because an unrelated Application sync ran.
docker run --rm --network bridge \
  -v "${rendered_cnpg_script}:/cnpg-topology.sh:ro" \
  -e PGHOST="${postgres_address}" -e PGPORT=5432 -e PGDATABASE="${MNT_POSTGRES_DB}" \
  -e PGUSER=mnt_app -e PGPASSWORD="${MNT_APP_POSTGRES_PASSWORD}" \
  -e MNT_RT_USERNAME=mnt_rt -e MNT_RT_PASSWORD="${MNT_RT_POSTGRES_PASSWORD}" \
  -e MNT_LEAVE_COMMAND_USERNAME=mnt_leave_cmd -e MNT_LEAVE_COMMAND_PASSWORD="${MNT_LEAVE_COMMAND_POSTGRES_PASSWORD}" \
  -e MNT_ONTOLOGY_COMMAND_USERNAME=mnt_ontology_cmd -e MNT_ONTOLOGY_COMMAND_PASSWORD="${MNT_ONTOLOGY_COMMAND_POSTGRES_PASSWORD}" \
  "${POSTGRES_IMAGE}" bash -ceu 'source /cnpg-topology.sh' >/dev/null
test "$(docker exec "${fresh_container}" psql -U "${MNT_POSTGRES_ADMIN_USER}" -d "${MNT_POSTGRES_DB}" -Atqc \
  "SELECT count(*) FROM pg_stat_activity WHERE pid=${cnpg_stale_pid}")" = 1
docker exec "${fresh_container}" psql -U "${MNT_POSTGRES_ADMIN_USER}" -d "${MNT_POSTGRES_DB}" -v ON_ERROR_STOP=1 -qc \
  "ALTER ROLE mnt_rt SET statement_timeout='1ms'; ALTER ROLE mnt_rt SET idle_in_transaction_session_timeout='1ms'; ALTER ROLE mnt_rt SET transaction_timeout='1ms';
   ALTER ROLE mnt_leave_cmd SET statement_timeout='1ms'; ALTER ROLE mnt_leave_cmd SET idle_in_transaction_session_timeout='1ms'; ALTER ROLE mnt_leave_cmd SET transaction_timeout='1ms';
   ALTER ROLE mnt_ontology_cmd SET statement_timeout='1ms'; ALTER ROLE mnt_ontology_cmd SET idle_in_transaction_session_timeout='1ms'; ALTER ROLE mnt_ontology_cmd SET transaction_timeout='1ms';"
docker run --rm --network bridge \
  -v "${rendered_cnpg_script}:/cnpg-topology.sh:ro" \
  -e PGHOST="${postgres_address}" -e PGPORT=5432 -e PGDATABASE="${MNT_POSTGRES_DB}" \
  -e PGUSER=mnt_app -e PGPASSWORD="${MNT_APP_POSTGRES_PASSWORD}" \
  -e MNT_RT_USERNAME=mnt_rt -e MNT_RT_PASSWORD="${MNT_RT_POSTGRES_PASSWORD}" \
  -e MNT_LEAVE_COMMAND_USERNAME=mnt_leave_cmd -e MNT_LEAVE_COMMAND_PASSWORD="${MNT_LEAVE_COMMAND_POSTGRES_PASSWORD}" \
  -e MNT_ONTOLOGY_COMMAND_USERNAME=mnt_ontology_cmd -e MNT_ONTOLOGY_COMMAND_PASSWORD="${MNT_ONTOLOGY_COMMAND_POSTGRES_PASSWORD}" \
  "${POSTGRES_IMAGE}" bash -ceu 'source /cnpg-topology.sh' >/dev/null
if wait "${cnpg_stale_client}"; then
  echo "topology-test: rendered CNPG script did not drain tagged mnt_rt session" >&2
  exit 1
fi
test "$(docker exec "${fresh_container}" psql -U "${MNT_POSTGRES_ADMIN_USER}" -d "${MNT_POSTGRES_DB}" -Atqc \
  "SELECT count(*) FROM pg_stat_activity WHERE pid=${cnpg_stale_pid}")" = 0

# The guard must compare the decoded secret values themselves, not merely DSN
# strings or role names, and it must fail before any topology mutation.
if run_fresh_reconcile \
  -e MNT_ONTOLOGY_COMMAND_POSTGRES_PASSWORD="${MNT_LEAVE_COMMAND_POSTGRES_PASSWORD}" \
  >/dev/null 2>&1; then
  echo "topology-test: pairwise-equal command credentials unexpectedly succeeded" >&2
  exit 1
fi

fresh_runtime_defaults="$(docker exec "${fresh_container}" psql -U "${MNT_POSTGRES_ADMIN_USER}" -d "${MNT_POSTGRES_DB}" -Atqc \
  "SELECT count(*) FROM pg_default_acl defaults CROSS JOIN LATERAL aclexplode(defaults.defaclacl) privilege WHERE defaults.defaclrole=(SELECT oid FROM pg_roles WHERE rolname='mnt_app') AND privilege.grantee=(SELECT oid FROM pg_roles WHERE rolname='mnt_rt')")"
test "${fresh_runtime_defaults}" = 0
docker exec "${fresh_container}" psql -U "${MNT_POSTGRES_ADMIN_USER}" -d "${MNT_POSTGRES_DB}" -v ON_ERROR_STOP=1 -qc \
  "CREATE ROLE topology_rogue_member NOLOGIN; CREATE ROLE topology_rogue_granted NOLOGIN; ALTER ROLE mnt_app NOBYPASSRLS; ALTER ROLE mnt_rt BYPASSRLS; GRANT mnt_rt TO topology_rogue_member; GRANT topology_rogue_granted TO mnt_rt;"
run_fresh_reconcile

expected_roles='mnt_app|t|f|t|t
mnt_leave_cmd|t|f|f|f
mnt_leave_definer|f|f|f|f
mnt_ontology_cmd|t|f|f|f
mnt_ontology_writer|f|f|f|f
mnt_rt|t|f|f|f'
actual_roles="$(docker exec "${fresh_container}" psql -U "${MNT_POSTGRES_ADMIN_USER}" -d "${MNT_POSTGRES_DB}" -At -F '|' -c \
  "SELECT rolname,rolcanlogin,rolsuper,rolbypassrls,rolinherit FROM pg_roles WHERE rolname IN ('mnt_app','mnt_rt','mnt_leave_cmd','mnt_ontology_cmd','mnt_leave_definer','mnt_ontology_writer') ORDER BY rolname")"
test "${actual_roles}" = "${expected_roles}"

expected_memberships='mnt_app|mnt_leave_definer|f|t|t
mnt_app|mnt_ontology_writer|f|t|t'
actual_memberships="$(docker exec "${fresh_container}" psql -U "${MNT_POSTGRES_ADMIN_USER}" -d "${MNT_POSTGRES_DB}" -At -F '|' -c \
  "SELECT member.rolname,granted.rolname,m.admin_option,m.inherit_option,m.set_option FROM pg_auth_members m JOIN pg_roles member ON member.oid=m.member JOIN pg_roles granted ON granted.oid=m.roleid WHERE member.rolname IN ('mnt_app','mnt_rt','mnt_leave_cmd','mnt_ontology_cmd','mnt_leave_definer','mnt_ontology_writer') OR granted.rolname IN ('mnt_app','mnt_rt','mnt_leave_cmd','mnt_ontology_cmd','mnt_leave_definer','mnt_ontology_writer') ORDER BY member.rolname,granted.rolname")"
test "${actual_memberships}" = "${expected_memberships}"

migration_identity="$(query_as_direct_login mnt_app "${MNT_APP_POSTGRES_PASSWORD}" \
  "SELECT session_user,current_user,authenticated.rolcanlogin,authenticated.rolsuper,authenticated.rolbypassrls,authenticated.rolinherit,authenticated.rolcreatedb,authenticated.rolcreaterole,authenticated.rolreplication,pg_has_role(session_user,'pg_database_owner','MEMBER'),(SELECT count(*) FROM pg_auth_members membership WHERE membership.member=authenticated.oid),(SELECT count(*) FROM pg_roles candidate WHERE candidate.rolname<>session_user AND candidate.rolname NOT IN ('pg_database_owner','mnt_leave_definer','mnt_ontology_writer') AND pg_has_role(session_user,candidate.oid,'MEMBER')) FROM pg_roles authenticated WHERE authenticated.rolname=session_user")"
test "${migration_identity}" = 'mnt_app|mnt_app|t|f|t|t|f|f|f|t|2|0'

for direct_login in \
  "mnt_rt|${MNT_RT_POSTGRES_PASSWORD}" \
  "mnt_leave_cmd|${MNT_LEAVE_COMMAND_POSTGRES_PASSWORD}" \
  "mnt_ontology_cmd|${MNT_ONTOLOGY_COMMAND_POSTGRES_PASSWORD}"; do
  IFS='|' read -r role password <<<"${direct_login}"
  serving_identity="$(query_as_direct_login "${role}" "${password}" \
    "SELECT session_user,current_user,authenticated.rolcanlogin,authenticated.rolsuper,authenticated.rolbypassrls,authenticated.rolinherit,authenticated.rolcreatedb,authenticated.rolcreaterole,authenticated.rolreplication,EXISTS(SELECT 1 FROM pg_auth_members membership WHERE membership.member=authenticated.oid OR membership.roleid=authenticated.oid) FROM pg_roles authenticated WHERE authenticated.rolname=session_user")"
  test "${serving_identity}" = "${role}|${role}|t|f|f|f|f|f|f|f"
done

# A password from one credential must never authenticate another login.
if query_as_direct_login mnt_leave_cmd "${MNT_RT_POSTGRES_PASSWORD}" 'SELECT 1' \
  >/dev/null 2>&1; then
  echo "topology-test: runtime password authenticated the leave command login" >&2
  exit 1
fi

docker rm -f "${fresh_container}" >/dev/null

prepare_legacy_volume() {
  local default_acl_sql="$1"

  compose down -v --remove-orphans >/dev/null 2>&1 || true
  export MNT_POSTGRES_ADMIN_USER=mnt_app
  export MNT_POSTGRES_ADMIN_PASSWORD=legacy-only-password-5c8f
  compose up -d postgres >/dev/null
  legacy_container="$(compose ps -q postgres)"
  wait_for_postgres "${legacy_container}" mnt_app
  docker exec "${legacy_container}" psql -U mnt_app -d "${MNT_POSTGRES_DB}" -v ON_ERROR_STOP=1 -qc \
    "ALTER SYSTEM SET log_statement='all'"
  docker exec "${legacy_container}" psql -U mnt_app -d "${MNT_POSTGRES_DB}" -v ON_ERROR_STOP=1 -qc \
    "SELECT pg_reload_conf()"
  docker exec "${legacy_container}" psql -U mnt_app -d "${MNT_POSTGRES_DB}" -v ON_ERROR_STOP=1 -qc \
    "CREATE TABLE public.legacy_owned_marker (id bigint PRIMARY KEY)"
  docker exec "${legacy_container}" psql -U mnt_app -d "${MNT_POSTGRES_DB}" -v ON_ERROR_STOP=1 -qc \
    "${default_acl_sql}"
  legacy_identity_before="$(docker exec "${legacy_container}" psql -U mnt_app -d "${MNT_POSTGRES_DB}" -At -F '|' -c \
    "SELECT oid,rolcanlogin,rolsuper,rolbypassrls,rolinherit FROM pg_roles WHERE rolname='mnt_app'")"
  compose stop postgres >/dev/null

  export MNT_POSTGRES_ADMIN_USER=mnt_cluster_admin
  export MNT_POSTGRES_ADMIN_PASSWORD=legacy-admin-log-secret-a672
  export MNT_APP_POSTGRES_PASSWORD=legacy-app-log-secret-b783
  export MNT_RT_POSTGRES_PASSWORD=legacy-runtime-log-secret-c894
  export MNT_LEAVE_COMMAND_POSTGRES_PASSWORD=legacy-leave-log-secret-d905
  export MNT_ONTOLOGY_COMMAND_POSTGRES_PASSWORD=legacy-ontology-log-secret-e016
  export MNT_ALLOW_LEGACY_MNT_APP_SUPERUSER_CONVERSION=1
  compose up -d postgres >/dev/null
  legacy_container="$(compose ps -q postgres)"
  wait_for_postgres "${legacy_container}" mnt_cluster_admin
}

assert_noncanonical_legacy_acl_rejected() {
  local default_acl_sql="$1"
  local expected_acl_entries="$2"
  local failure_output
  local preserved_state

  prepare_legacy_volume "${default_acl_sql}"
  if failure_output="$(compose run --rm postgres-topology 2>&1)"; then
    echo "topology-test: noncanonical legacy default ACL unexpectedly converted" >&2
    echo "${failure_output}" >&2
    exit 1
  fi
  grep -Fq "topology.legacy_default_acl_preflight_noncanonical" <<<"${failure_output}"
  unset MNT_ALLOW_LEGACY_MNT_APP_SUPERUSER_CONVERSION

  preserved_state="$(docker exec "${legacy_container}" psql -U mnt_app -d "${MNT_POSTGRES_DB}" -At -F '|' -c \
    "SELECT oid,rolcanlogin,rolsuper,rolbypassrls,rolinherit, EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mnt_cluster_admin'), EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mnt_legacy_conversion_admin'), (SELECT count(*) FROM pg_default_acl defaults CROSS JOIN LATERAL aclexplode(defaults.defaclacl) privilege WHERE defaults.defaclrole=(SELECT oid FROM pg_roles WHERE rolname='mnt_app') AND defaults.defaclnamespace=(SELECT oid FROM pg_namespace WHERE nspname='public') AND defaults.defaclobjtype='r') FROM pg_roles WHERE rolname='mnt_app'")"
  test "${preserved_state}" = "${legacy_identity_before}|f|f|${expected_acl_entries}"
}

# A partial ACL and an ACL with an additional grantee must stop conversion and
# retain the original mnt_app identity and ACL OID for operator audit.
assert_noncanonical_legacy_acl_rejected \
  "CREATE ROLE mnt_rt NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT; ALTER DEFAULT PRIVILEGES FOR ROLE mnt_app IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO mnt_rt" \
  3
assert_noncanonical_legacy_acl_rejected \
  "CREATE ROLE mnt_rt NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT; CREATE ROLE legacy_acl_extra NOLOGIN; ALTER DEFAULT PRIVILEGES FOR ROLE mnt_app IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mnt_rt; ALTER DEFAULT PRIVILEGES FOR ROLE mnt_app IN SCHEMA public GRANT SELECT ON TABLES TO legacy_acl_extra" \
  5

assert_legacy_conversion_admin_neutralized() {
  local catalog_user="$1"
  local role_state
  role_state="$(docker exec "${legacy_container}" psql -U "${catalog_user}" -d "${MNT_POSTGRES_DB}" -At -F '|' -c \
    "SELECT rolcanlogin,rolsuper,(rolpassword IS NULL) FROM pg_authid WHERE rolname='mnt_legacy_conversion_admin'")"
  test "${role_state}" = 'f|f|t'
  if docker exec -e PGPASSWORD="${MNT_POSTGRES_ADMIN_PASSWORD}" "${legacy_container}" \
    psql -h 127.0.0.1 -U mnt_legacy_conversion_admin -d "${MNT_POSTGRES_DB}" \
    -v ON_ERROR_STOP=1 -Atqc 'SELECT 1' >/dev/null 2>&1; then
    echo "topology-test: neutralized legacy conversion administrator still authenticated" >&2
    exit 1
  fi
}

# If the rename transaction fails after the temporary superuser is created,
# EXIT cleanup must revoke both LOGIN and SUPERUSER and discard its password.
prepare_legacy_volume "CREATE ROLE mnt_cluster_admin NOLOGIN NOSUPERUSER"
if compose run --rm postgres-topology >/dev/null 2>&1; then
  echo "topology-test: colliding legacy administrator conversion unexpectedly succeeded" >&2
  exit 1
fi
assert_legacy_conversion_admin_neutralized mnt_app

# Reproduce the catalog left by an interruption after the real administrator
# was established but before the temporary role was dropped. A later substrate
# failure must still leave the temporary role unable to log in or act as root.
prepare_legacy_volume "SELECT 1"
docker exec -i -e ADMIN_PASSWORD="${MNT_POSTGRES_ADMIN_PASSWORD}" "${legacy_container}" \
  psql -U mnt_app -d "${MNT_POSTGRES_DB}" -v ON_ERROR_STOP=1 -q <<'SQL'
BEGIN;
SET LOCAL log_statement = 'none';
SET LOCAL log_min_error_statement = 'panic';
\getenv admin_password ADMIN_PASSWORD
SELECT format(
  'CREATE ROLE mnt_legacy_conversion_admin LOGIN SUPERUSER PASSWORD %L',
  :'admin_password'
) \gexec
COMMIT;
SQL
docker exec -i -e PGPASSWORD="${MNT_POSTGRES_ADMIN_PASSWORD}" \
  -e ADMIN_USER="${MNT_POSTGRES_ADMIN_USER}" \
  -e ADMIN_PASSWORD="${MNT_POSTGRES_ADMIN_PASSWORD}" "${legacy_container}" \
  psql -h 127.0.0.1 -U mnt_legacy_conversion_admin -d "${MNT_POSTGRES_DB}" \
  -v ON_ERROR_STOP=1 -q <<'SQL'
BEGIN;
SET LOCAL log_statement = 'none';
SET LOCAL log_min_error_statement = 'panic';
\getenv admin_user ADMIN_USER
\getenv admin_password ADMIN_PASSWORD
SELECT format('ALTER ROLE mnt_app RENAME TO %I', :'admin_user') \gexec
SELECT format(
  'ALTER ROLE %I LOGIN SUPERUSER CREATEDB CREATEROLE REPLICATION BYPASSRLS PASSWORD %L',
  :'admin_user', :'admin_password'
) \gexec
COMMIT;
SQL
docker exec "${legacy_container}" psql -U "${MNT_POSTGRES_ADMIN_USER}" \
  -d "${MNT_POSTGRES_DB}" -v ON_ERROR_STOP=1 -qc \
  "ALTER SYSTEM SET max_prepared_transactions=10"
compose restart postgres >/dev/null
wait_for_postgres "${legacy_container}" "${MNT_POSTGRES_ADMIN_USER}"
if compose run --rm postgres-topology >/dev/null 2>&1; then
  echo "topology-test: interrupted legacy recovery ignored its invalid transaction substrate" >&2
  exit 1
fi
assert_legacy_conversion_admin_neutralized "${MNT_POSTGRES_ADMIN_USER}"

# A legacy volume with no relevant default ACL converts without inventing the
# migration-owned grant; migration 0031 remains responsible for fresh timing.
prepare_legacy_volume "SELECT 1"
compose run --rm postgres-topology
unset MNT_ALLOW_LEGACY_MNT_APP_SUPERUSER_CONVERSION
absent_acl_state="$(docker exec "${legacy_container}" psql -U mnt_cluster_admin -d "${MNT_POSTGRES_DB}" -At -F '|' -c \
  "SELECT (SELECT rolsuper FROM pg_roles WHERE rolname='mnt_app'), (SELECT rolbypassrls FROM pg_roles WHERE rolname='mnt_app'), (SELECT rolsuper FROM pg_roles WHERE rolname='mnt_cluster_admin'), EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mnt_legacy_conversion_admin'), (SELECT count(*) FROM pg_default_acl defaults CROSS JOIN LATERAL aclexplode(defaults.defaclacl) privilege WHERE defaults.defaclrole=(SELECT oid FROM pg_roles WHERE rolname='mnt_app') AND privilege.grantee=(SELECT oid FROM pg_roles WHERE rolname='mnt_rt'))")"
test "${absent_acl_state}" = 'f|t|t|f|0'

# Build a canonical real legacy Compose volume, then exercise the guarded
# shared-socket conversion and transfer migration 0031's exact default ACL.
prepare_legacy_volume \
  "CREATE ROLE mnt_rt NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT; ALTER DEFAULT PRIVILEGES FOR ROLE mnt_app IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mnt_rt"
compose run --rm postgres-topology
unset MNT_ALLOW_LEGACY_MNT_APP_SUPERUSER_CONVERSION

legacy_roles="$(docker exec "${legacy_container}" psql -U mnt_cluster_admin -d "${MNT_POSTGRES_DB}" -At -F '|' -c \
  "SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN ('mnt_cluster_admin','mnt_app') ORDER BY rolname")"
test "${legacy_roles}" = $'mnt_app|f|t\nmnt_cluster_admin|t|t'
legacy_table_owner="$(docker exec "${legacy_container}" psql -U mnt_cluster_admin -d "${MNT_POSTGRES_DB}" -Atqc \
  "SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='legacy_owned_marker'")"
test "${legacy_table_owner}" = mnt_app
docker exec -e PGPASSWORD="${MNT_APP_POSTGRES_PASSWORD}" "${legacy_container}" \
  psql -h 127.0.0.1 -U mnt_app -d "${MNT_POSTGRES_DB}" -v ON_ERROR_STOP=1 -qc \
  "CREATE TABLE public.post_conversion_default_acl (id bigint PRIMARY KEY)"
runtime_table_privileges="$(docker exec "${legacy_container}" psql -U mnt_cluster_admin -d "${MNT_POSTGRES_DB}" -At -F '|' -c \
  "SELECT has_table_privilege('mnt_rt','public.post_conversion_default_acl','SELECT'), has_table_privilege('mnt_rt','public.post_conversion_default_acl','INSERT'), has_table_privilege('mnt_rt','public.post_conversion_default_acl','UPDATE'), has_table_privilege('mnt_rt','public.post_conversion_default_acl','DELETE'), has_table_privilege('mnt_rt','public.post_conversion_default_acl','TRUNCATE'), has_table_privilege('mnt_rt','public.post_conversion_default_acl','REFERENCES'), has_table_privilege('mnt_rt','public.post_conversion_default_acl','TRIGGER')")"
test "${runtime_table_privileges}" = 't|t|t|t|f|f|f'
unexpected_runtime_defaults="$(docker exec "${legacy_container}" psql -U mnt_cluster_admin -d "${MNT_POSTGRES_DB}" -Atqc \
  "SELECT count(*) FROM pg_default_acl defaults CROSS JOIN LATERAL aclexplode(defaults.defaclacl) privilege WHERE defaults.defaclrole=(SELECT oid FROM pg_roles WHERE rolname='mnt_app') AND privilege.grantee=(SELECT oid FROM pg_roles WHERE rolname='mnt_rt') AND (defaults.defaclobjtype <> 'r' OR privilege.privilege_type NOT IN ('SELECT','INSERT','UPDATE','DELETE') OR privilege.is_grantable)")"
test "${unexpected_runtime_defaults}" = 0
stranded_admin_defaults="$(docker exec "${legacy_container}" psql -U mnt_cluster_admin -d "${MNT_POSTGRES_DB}" -Atqc \
  "SELECT count(*) FROM pg_default_acl defaults CROSS JOIN LATERAL aclexplode(defaults.defaclacl) privilege WHERE defaults.defaclrole=(SELECT oid FROM pg_roles WHERE rolname='mnt_cluster_admin') AND privilege.grantee=(SELECT oid FROM pg_roles WHERE rolname='mnt_rt')")"
test "${stranded_admin_defaults}" = 0
legacy_logs="$(compose logs --no-color postgres 2>&1)"
for secret in \
  "${MNT_POSTGRES_ADMIN_PASSWORD}" \
  "${MNT_APP_POSTGRES_PASSWORD}" \
  "${MNT_RT_POSTGRES_PASSWORD}" \
  "${MNT_LEAVE_COMMAND_POSTGRES_PASSWORD}" \
  "${MNT_ONTOLOGY_COMMAND_POSTGRES_PASSWORD}"; do
  if grep -Fq "${secret}" <<<"${legacy_logs}"; then
    echo "topology-test: legacy PostgreSQL log leaked a database password" >&2
    exit 1
  fi
done

echo "topology-test: fresh, idempotent, drift, secret-log, absent/canonical conversion, and preflight-rejection ACL checks passed"
