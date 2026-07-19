#!/usr/bin/env bash
# Real PostgreSQL regression for fresh/idempotent/drift reconciliation, secret
# log suppression, and the guarded Compose upgrade from a legacy mnt_app-only
# superuser volume.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POSTGRES_IMAGE="postgres:18.4@sha256:65f70a152846cf504dff86e807007e9aeac98c3aeb7b62541b2c55ab9d264e56"
fresh_container="mnt-topology-fresh-$$"
legacy_project="mnt-topology-legacy-$$"

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
  compose down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_for_postgres() {
  local container="$1"
  local user="$2"
  for attempt in {1..30}; do
    if docker exec "${container}" pg_isready -U "${user}" -d "${MNT_POSTGRES_DB}" >/dev/null 2>&1; then
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
run_fresh_reconcile

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
