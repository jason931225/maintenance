#!/usr/bin/env bash
# Reconcile the portable six-role application topology from a distinct cluster
# administrator. Safe to run on fresh or existing databases before migrations.
set -euo pipefail

: "${POSTGRES_HOST:=postgres}"
: "${POSTGRES_PORT:=5432}"
: "${POSTGRES_LOCAL_SOCKET_DIR:=/var/run/postgresql}"
: "${POSTGRES_DB:?required}"
: "${POSTGRES_ADMIN_USER:?required}"
: "${POSTGRES_ADMIN_PASSWORD:?required}"
: "${MNT_APP_POSTGRES_PASSWORD:?required}"
: "${MNT_RT_POSTGRES_PASSWORD:?required}"
: "${MNT_LEAVE_COMMAND_POSTGRES_PASSWORD:?required}"
: "${MNT_ONTOLOGY_COMMAND_POSTGRES_PASSWORD:?required}"
: "${MNT_ALLOW_LEGACY_MNT_APP_SUPERUSER_CONVERSION:=0}"
export POSTGRES_ADMIN_USER POSTGRES_ADMIN_PASSWORD

if [[ "${POSTGRES_ADMIN_USER}" == "mnt_app" ]]; then
  echo "topology: POSTGRES_ADMIN_USER must be distinct from mnt_app" >&2
  exit 1
fi

passwords=(
  "${POSTGRES_ADMIN_PASSWORD}"
  "${MNT_APP_POSTGRES_PASSWORD}"
  "${MNT_RT_POSTGRES_PASSWORD}"
  "${MNT_LEAVE_COMMAND_POSTGRES_PASSWORD}"
  "${MNT_ONTOLOGY_COMMAND_POSTGRES_PASSWORD}"
)
for ((i = 0; i < ${#passwords[@]}; i++)); do
  for ((j = i + 1; j < ${#passwords[@]}; j++)); do
    if [[ "${passwords[i]}" == "${passwords[j]}" ]]; then
      echo "topology: cluster-admin, owner, runtime, and command passwords must be pairwise distinct" >&2
      exit 1
    fi
  done
done

admin_psql_args=(
  --host "${POSTGRES_HOST}"
  --port "${POSTGRES_PORT}"
  --username "${POSTGRES_ADMIN_USER}"
  --dbname "${POSTGRES_DB}"
  --set ON_ERROR_STOP=1
  --quiet
)
legacy_reassign_from_admin=0

admin_connection_ready() {
  PGPASSWORD="${POSTGRES_ADMIN_PASSWORD}" \
    psql "${admin_psql_args[@]}" -Atqc 'SELECT 1' >/dev/null 2>&1
}

bootstrap_legacy_admin() {
  if [[ "${MNT_ALLOW_LEGACY_MNT_APP_SUPERUSER_CONVERSION}" != "1" ]]; then
    echo "topology.admin_unavailable: the distinct cluster administrator could not connect; legacy conversion requires MNT_ALLOW_LEGACY_MNT_APP_SUPERUSER_CONVERSION=1" >&2
    exit 1
  fi
  if [[ ! -S "${POSTGRES_LOCAL_SOCKET_DIR}/.s.PGSQL.${POSTGRES_PORT}" ]]; then
    echo "topology.legacy_socket_unavailable: expected the PostgreSQL local socket at ${POSTGRES_LOCAL_SOCKET_DIR}" >&2
    exit 1
  fi

  local legacy_psql_args=(
    --host "${POSTGRES_LOCAL_SOCKET_DIR}"
    --port "${POSTGRES_PORT}"
    --username mnt_app
    --dbname "${POSTGRES_DB}"
    --set ON_ERROR_STOP=1
    --quiet
  )
  local legacy_identity
  legacy_identity="$(PGPASSWORD='' psql "${legacy_psql_args[@]}" -At -F '|' -c \
    "SELECT current_user, rolsuper FROM pg_roles WHERE rolname=current_user")"
  if [[ "${legacy_identity}" != "mnt_app|t" ]]; then
    echo "topology.legacy_identity_refused: local-socket bootstrap requires the extant mnt_app superuser" >&2
    exit 1
  fi

  # Classify the legacy ACL before creating or renaming any role. A rejected
  # volume must retain its original mnt_app identity and ACL evidence exactly as
  # found so an operator can audit and repair it deliberately.
  local legacy_default_acl_state
  legacy_default_acl_state="$(PGPASSWORD='' psql "${legacy_psql_args[@]}" -At <<'SQL'
WITH relevant_defaults AS (
  SELECT defaults.defaclacl
  FROM pg_default_acl defaults
  WHERE defaults.defaclrole = (SELECT oid FROM pg_roles WHERE rolname=current_user)
    AND defaults.defaclnamespace = (SELECT oid FROM pg_namespace WHERE nspname='public')
    AND defaults.defaclobjtype = 'r'
), privileges AS (
  SELECT privilege.*
  FROM relevant_defaults defaults
  CROSS JOIN LATERAL aclexplode(defaults.defaclacl) privilege
)
SELECT CASE
  WHEN (SELECT count(*) FROM relevant_defaults) = 0 THEN 'absent'
  WHEN (SELECT count(*) FROM relevant_defaults) = 1
    AND (SELECT count(*) FROM privileges) = 4
    AND (
      SELECT count(*)
      FROM privileges
      WHERE grantee = (SELECT oid FROM pg_roles WHERE rolname='mnt_rt')
        AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
        AND NOT is_grantable
    ) = 4
    AND (SELECT count(DISTINCT privilege_type) FROM privileges) = 4
    THEN 'canonical'
  ELSE 'invalid'
END;
SQL
)"
  if [[ "${legacy_default_acl_state}" == "invalid" ]]; then
    echo "topology.legacy_default_acl_preflight_noncanonical: expected either no public table default ACL or exactly non-grantable SELECT, INSERT, UPDATE, DELETE for mnt_rt; original mnt_app and ACL preserved for audit" >&2
    exit 4
  fi

  # PostgreSQL 18 forbids removing SUPERUSER from the bootstrap role. The sole
  # legacy escape hatch therefore creates a temporary superuser locally, uses
  # it to rename the bootstrap mnt_app identity to the requested administrator,
  # then lets normal reconciliation recreate a non-superuser mnt_app and move
  # application ownership to it. Logging is suppressed before secret SQL.
  POSTGRES_ADMIN_PASSWORD="${POSTGRES_ADMIN_PASSWORD}" \
  PGPASSWORD='' psql "${legacy_psql_args[@]}" <<'SQL'
BEGIN;
SET LOCAL log_statement = 'none';
SET LOCAL log_min_error_statement = 'panic';
\getenv admin_password POSTGRES_ADMIN_PASSWORD
SELECT format(
  'CREATE ROLE mnt_legacy_conversion_admin LOGIN SUPERUSER PASSWORD %L',
  :'admin_password'
) WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mnt_legacy_conversion_admin') \gexec
SELECT format(
  'ALTER ROLE mnt_legacy_conversion_admin LOGIN SUPERUSER PASSWORD %L',
  :'admin_password'
) \gexec
COMMIT;
SQL

  local conversion_psql_args=(
    --host "${POSTGRES_HOST}"
    --port "${POSTGRES_PORT}"
    --username mnt_legacy_conversion_admin
    --dbname "${POSTGRES_DB}"
    --set ON_ERROR_STOP=1
    --quiet
  )
  PGPASSWORD="${POSTGRES_ADMIN_PASSWORD}" psql "${conversion_psql_args[@]}" <<'SQL'
BEGIN;
SET LOCAL log_statement = 'none';
SET LOCAL log_min_error_statement = 'panic';
\getenv admin_user POSTGRES_ADMIN_USER
\getenv admin_password POSTGRES_ADMIN_PASSWORD
SELECT format('ALTER ROLE mnt_app RENAME TO %I', :'admin_user') \gexec
SELECT format(
  'ALTER ROLE %I LOGIN SUPERUSER CREATEDB CREATEROLE REPLICATION BYPASSRLS PASSWORD %L',
  :'admin_user', :'admin_password'
) \gexec
COMMIT;
SQL
  legacy_reassign_from_admin=1
  echo "topology: converted the legacy bootstrap identity into the distinct cluster administrator" >&2
}

if ! admin_connection_ready; then
  bootstrap_legacy_admin
fi
if ! admin_connection_ready; then
  echo "topology.admin_unavailable: distinct cluster administrator still cannot connect after bootstrap" >&2
  exit 1
fi

export PGPASSWORD="${POSTGRES_ADMIN_PASSWORD}"
IFS='|' read -r current_user mnt_app_exists legacy_mnt_app_superuser conversion_role_exists < <(
  psql "${admin_psql_args[@]}" -At -F '|' -c \
    "SELECT current_user, EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mnt_app'), COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname='mnt_app'), false), EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mnt_legacy_conversion_admin')"
)
if [[ "${current_user}" != "${POSTGRES_ADMIN_USER}" || "${current_user}" == "mnt_app" ]]; then
  echo "topology: connection did not resolve to the distinct cluster administrator" >&2
  exit 1
fi
if [[ "${legacy_mnt_app_superuser}" == "t" && "${MNT_ALLOW_LEGACY_MNT_APP_SUPERUSER_CONVERSION}" != "1" ]]; then
  echo "topology.legacy_mnt_app_superuser_refused: audit the volume, then set MNT_ALLOW_LEGACY_MNT_APP_SUPERUSER_CONVERSION=1 for one guarded reconciliation" >&2
  exit 1
fi
if [[ "${MNT_ALLOW_LEGACY_MNT_APP_SUPERUSER_CONVERSION}" == "1" && "${mnt_app_exists}" == "f" && "${conversion_role_exists}" == "t" ]]; then
  legacy_reassign_from_admin=1
fi
export MNT_LEGACY_REASSIGN_FROM_ADMIN="${legacy_reassign_from_admin}"

# Role passwords must be sent as SQL because PostgreSQL has no parameterized
# ALTER ROLE protocol. Suppress statement and error-statement logging for this
# privileged transaction before psql expands any password variables.
psql "${admin_psql_args[@]}" <<'SQL'
BEGIN;
SET LOCAL log_statement = 'none';
SET LOCAL log_min_error_statement = 'panic';
\getenv app_password MNT_APP_POSTGRES_PASSWORD
\getenv runtime_password MNT_RT_POSTGRES_PASSWORD
\getenv leave_password MNT_LEAVE_COMMAND_POSTGRES_PASSWORD
\getenv ontology_password MNT_ONTOLOGY_COMMAND_POSTGRES_PASSWORD
\getenv legacy_reassign MNT_LEGACY_REASSIGN_FROM_ADMIN

SELECT format(
  'CREATE ROLE mnt_app LOGIN NOSUPERUSER BYPASSRLS INHERIT NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L',
  :'app_password'
) WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mnt_app') \gexec
SELECT format(
  'ALTER ROLE mnt_app LOGIN NOSUPERUSER BYPASSRLS INHERIT NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L',
  :'app_password'
) \gexec

SELECT format(
  'CREATE ROLE mnt_rt LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L',
  :'runtime_password'
) WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mnt_rt') \gexec
SELECT format(
  'ALTER ROLE mnt_rt LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L',
  :'runtime_password'
) \gexec

SELECT format(
  'CREATE ROLE mnt_leave_cmd LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L',
  :'leave_password'
) WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mnt_leave_cmd') \gexec
SELECT format(
  'ALTER ROLE mnt_leave_cmd LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L',
  :'leave_password'
) \gexec

SELECT format(
  'CREATE ROLE mnt_ontology_cmd LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L',
  :'ontology_password'
) WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mnt_ontology_cmd') \gexec
SELECT format(
  'ALTER ROLE mnt_ontology_cmd LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L',
  :'ontology_password'
) \gexec

SELECT format(
  'CREATE ROLE mnt_leave_definer NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION'
) WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mnt_leave_definer') \gexec
ALTER ROLE mnt_leave_definer NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;

SELECT format(
  'CREATE ROLE mnt_ontology_writer NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION'
) WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mnt_ontology_writer') \gexec
ALTER ROLE mnt_ontology_writer NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;

-- Migration 0031 owns fresh-database timing. A guarded legacy rename may leave
-- its table default ACL attached to the renamed bootstrap administrator OID.
-- Skip only when that legacy table ACL is absent, transfer only its exact known
-- shape, and fail closed without changing a noncanonical ACL. Do not introduce
-- sequence/function defaults.
WITH relevant_defaults AS (
  SELECT defaults.defaclacl
  FROM pg_default_acl defaults
  WHERE defaults.defaclrole = (SELECT oid FROM pg_roles WHERE rolname=current_user)
    AND defaults.defaclnamespace = (SELECT oid FROM pg_namespace WHERE nspname='public')
    AND defaults.defaclobjtype = 'r'
), privileges AS (
  SELECT privilege.*
  FROM relevant_defaults defaults
  CROSS JOIN LATERAL aclexplode(defaults.defaclacl) privilege
), classified AS (
  SELECT CASE
    WHEN :'legacy_reassign' <> '1' THEN 'skip'
    WHEN (SELECT count(*) FROM relevant_defaults) = 0 THEN 'absent'
    WHEN (SELECT count(*) FROM relevant_defaults) = 1
      AND (SELECT count(*) FROM privileges) = 4
      AND (
        SELECT count(*)
        FROM privileges
        WHERE grantee = (SELECT oid FROM pg_roles WHERE rolname='mnt_rt')
          AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
          AND NOT is_grantable
      ) = 4
      AND (SELECT count(DISTINCT privilege_type) FROM privileges) = 4
      THEN 'canonical'
    ELSE 'invalid'
  END AS state
)
SELECT state AS legacy_default_acl_state,
       (state = 'invalid')::text AS legacy_default_acl_invalid
FROM classified \gset
\if :legacy_default_acl_invalid
  \echo topology.legacy_default_acl_noncanonical: expected either no public table default ACL or exactly non-grantable SELECT, INSERT, UPDATE, DELETE for mnt_rt; preserved legacy ACL for audit
  SELECT 'topology.legacy_default_acl_noncanonical'::integer;
\endif
SELECT 'ALTER DEFAULT PRIVILEGES FOR ROLE mnt_app IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mnt_rt'
WHERE :'legacy_default_acl_state' = 'canonical' \gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM mnt_rt',
  current_user
)
WHERE :'legacy_default_acl_state' = 'canonical' \gexec
SELECT CASE WHEN :'legacy_default_acl_state' <> 'canonical' OR (
  EXISTS (
    SELECT 1
    FROM pg_default_acl defaults
    WHERE defaults.defaclrole = (SELECT oid FROM pg_roles WHERE rolname='mnt_app')
      AND defaults.defaclnamespace = (SELECT oid FROM pg_namespace WHERE nspname='public')
      AND defaults.defaclobjtype = 'r'
      AND (
        SELECT count(*)
        FROM aclexplode(defaults.defaclacl) privilege
        WHERE privilege.grantee = (SELECT oid FROM pg_roles WHERE rolname='mnt_rt')
          AND privilege.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
          AND NOT privilege.is_grantable
      ) = 4
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_default_acl defaults
    CROSS JOIN LATERAL aclexplode(defaults.defaclacl) privilege
    WHERE defaults.defaclrole = (SELECT oid FROM pg_roles WHERE rolname=current_user)
      AND defaults.defaclnamespace = (SELECT oid FROM pg_namespace WHERE nspname='public')
      AND defaults.defaclobjtype = 'r'
      AND privilege.grantee = (SELECT oid FROM pg_roles WHERE rolname='mnt_rt')
  )
) THEN 'true' ELSE 'false' END AS legacy_default_acl_repaired \gset
\if :legacy_default_acl_repaired
\else
  \echo topology.legacy_default_acl_repair_failed
  SELECT 'topology.legacy_default_acl_repair_failed'::integer;
\endif

-- After the PostgreSQL-18 legacy rename, move user-schema application objects
-- from the renamed bootstrap administrator to the recreated mnt_app. A blanket
-- REASSIGN OWNED is forbidden for the bootstrap role because it owns objects
-- required by the database system, so enumerate only portable user objects.
SELECT format(
  'ALTER %s %I.%I OWNER TO mnt_app',
  CASE relation.relkind
    WHEN 'S' THEN 'SEQUENCE'
    WHEN 'v' THEN 'VIEW'
    WHEN 'm' THEN 'MATERIALIZED VIEW'
    WHEN 'f' THEN 'FOREIGN TABLE'
    ELSE 'TABLE'
  END,
  namespace.nspname,
  relation.relname
)
FROM pg_class relation
JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
WHERE :'legacy_reassign' = '1'
  AND relation.relowner = (SELECT oid FROM pg_roles WHERE rolname=current_user)
  AND relation.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
  AND namespace.nspname <> 'information_schema'
  AND namespace.nspname NOT LIKE 'pg\_%' ESCAPE '\'
\gexec
SELECT format(
  'ALTER %s %I.%I(%s) OWNER TO mnt_app',
  CASE routine.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END,
  namespace.nspname,
  routine.proname,
  pg_get_function_identity_arguments(routine.oid)
)
FROM pg_proc routine
JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
WHERE :'legacy_reassign' = '1'
  AND routine.proowner = (SELECT oid FROM pg_roles WHERE rolname=current_user)
  AND namespace.nspname <> 'information_schema'
  AND namespace.nspname NOT LIKE 'pg\_%' ESCAPE '\'
\gexec
SELECT format(
  'ALTER %s %I.%I OWNER TO mnt_app',
  CASE type.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END,
  namespace.nspname,
  type.typname
)
FROM pg_type type
JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
WHERE :'legacy_reassign' = '1'
  AND type.typowner = (SELECT oid FROM pg_roles WHERE rolname=current_user)
  AND type.typrelid = 0
  AND namespace.nspname <> 'information_schema'
  AND namespace.nspname NOT LIKE 'pg\_%' ESCAPE '\'
\gexec
SELECT format('ALTER LARGE OBJECT %s OWNER TO mnt_app', oid)
FROM pg_largeobject_metadata
WHERE :'legacy_reassign' = '1'
  AND lomowner = (SELECT oid FROM pg_roles WHERE rolname=current_user)
\gexec
SELECT format('ALTER SCHEMA %I OWNER TO mnt_app', nspname)
FROM pg_namespace
WHERE :'legacy_reassign' = '1'
  AND nspowner = (SELECT oid FROM pg_roles WHERE rolname=current_user)
  AND nspname <> 'information_schema'
  AND nspname NOT LIKE 'pg\_%' ESCAPE '\'
\gexec

-- Exact topology: remove every membership edge touching any application role,
-- including edges to or from an unexpected external role, then restore only
-- the two explicitly allowed non-admin memberships.
SELECT format('REVOKE %I FROM %I', granted.rolname, member.rolname)
FROM pg_auth_members membership
JOIN pg_roles member ON member.oid = membership.member
JOIN pg_roles granted ON granted.oid = membership.roleid
WHERE member.rolname IN (
        'mnt_app', 'mnt_rt', 'mnt_leave_cmd', 'mnt_ontology_cmd',
        'mnt_leave_definer', 'mnt_ontology_writer'
      )
   OR granted.rolname IN (
        'mnt_app', 'mnt_rt', 'mnt_leave_cmd', 'mnt_ontology_cmd',
        'mnt_leave_definer', 'mnt_ontology_writer'
      )
\gexec
GRANT mnt_leave_definer, mnt_ontology_writer TO mnt_app
    WITH ADMIN FALSE, INHERIT TRUE, SET TRUE;

SELECT format('ALTER DATABASE %I OWNER TO mnt_app', current_database()) \gexec
ALTER SCHEMA public OWNER TO mnt_app;

DO $block$
DECLARE
    bad_roles INTEGER;
    bad_memberships INTEGER;
BEGIN
    SELECT count(*) INTO bad_roles
    FROM pg_roles
    WHERE (rolname = 'mnt_app' AND (NOT rolcanlogin OR rolsuper OR NOT rolbypassrls OR NOT rolinherit OR rolcreatedb OR rolcreaterole OR rolreplication))
       OR (rolname = 'mnt_rt' AND (NOT rolcanlogin OR rolsuper OR rolbypassrls OR rolinherit OR rolcreatedb OR rolcreaterole OR rolreplication))
       OR (rolname IN ('mnt_leave_cmd', 'mnt_ontology_cmd') AND (NOT rolcanlogin OR rolsuper OR rolbypassrls OR rolinherit OR rolcreatedb OR rolcreaterole OR rolreplication))
       OR (rolname IN ('mnt_leave_definer', 'mnt_ontology_writer') AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolinherit OR rolcreatedb OR rolcreaterole OR rolreplication));
    IF bad_roles <> 0 OR (SELECT count(*) FROM pg_roles WHERE rolname IN (
        'mnt_app', 'mnt_rt', 'mnt_leave_cmd', 'mnt_ontology_cmd',
        'mnt_leave_definer', 'mnt_ontology_writer'
    )) <> 6 THEN
        RAISE EXCEPTION 'topology.role_readback_failed';
    END IF;

    SELECT count(*) INTO bad_memberships
    FROM pg_auth_members membership
    JOIN pg_roles member ON member.oid = membership.member
    JOIN pg_roles granted ON granted.oid = membership.roleid
    WHERE (
        member.rolname IN (
          'mnt_app', 'mnt_rt', 'mnt_leave_cmd', 'mnt_ontology_cmd',
          'mnt_leave_definer', 'mnt_ontology_writer'
        )
        OR granted.rolname IN (
          'mnt_app', 'mnt_rt', 'mnt_leave_cmd', 'mnt_ontology_cmd',
          'mnt_leave_definer', 'mnt_ontology_writer'
        )
      )
      AND NOT (
        member.rolname = 'mnt_app'
        AND granted.rolname IN ('mnt_leave_definer', 'mnt_ontology_writer')
        AND NOT membership.admin_option
        AND membership.inherit_option
        AND membership.set_option
      );
    IF bad_memberships <> 0 OR (
        SELECT count(*)
        FROM pg_auth_members membership
        JOIN pg_roles member ON member.oid = membership.member
        JOIN pg_roles granted ON granted.oid = membership.roleid
        WHERE member.rolname = 'mnt_app'
          AND granted.rolname IN ('mnt_leave_definer', 'mnt_ontology_writer')
          AND NOT membership.admin_option
          AND membership.inherit_option
          AND membership.set_option
    ) <> 2 THEN
        RAISE EXCEPTION 'topology.membership_readback_failed';
    END IF;
    IF (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) <> 'mnt_app' THEN
        RAISE EXCEPTION 'topology.database_owner_readback_failed';
    END IF;
END
$block$;
SELECT 'DROP ROLE mnt_legacy_conversion_admin'
WHERE :'legacy_reassign' = '1' \gexec
COMMIT;
SQL

echo "topology: six application roles reconciled and verified" >&2
