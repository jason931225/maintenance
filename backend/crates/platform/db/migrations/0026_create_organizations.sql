-- Multi-tenant phase 1: the tenant table.
--
-- A tenant = one maintenance company (정비 회사) and the hard isolation
-- boundary of the system (org → region → branch → user). Every tenant-scoped
-- row carries a non-null `org_id`, and Postgres RLS keyed on the
-- `app.current_org` GUC makes cross-tenant reads/writes impossible at the
-- storage layer — a second mandatory gate beneath app-level scoping that FAILS
-- CLOSED (denies all rows) when the GUC is unset. KNL Logistics is tenant #1.
--
-- This slice proves the mechanism end-to-end on a representative cut of the
-- schema (parent + child + denormalized scoping); it is NOT yet rolled out to
-- every table.

-- mnt-gate: audited-table organizations
CREATE TABLE organizations (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    slug       TEXT        NOT NULL UNIQUE
                   CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
    name       TEXT        NOT NULL CHECK (name <> ''),
    status     TEXT        NOT NULL DEFAULT 'ACTIVE'
                   CHECK (status IN ('ACTIVE', 'SUSPENDED', 'ARCHIVED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The runtime application role. RLS is only enforced for roles that are NOT
-- superusers and do NOT have BYPASSRLS; the migration/owner role that runs these
-- scripts is typically privileged, so the app must connect (and tests must run
-- their tenant-scoped queries) as this unprivileged role for the org_isolation
-- policies to apply. NOLOGIN here — deployments attach a password/LOGIN out of
-- band; tests SET LOCAL ROLE to it within a transaction. Idempotent so a
-- partially-applied or shared cluster does not error.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mnt_app') THEN
        CREATE ROLE mnt_app NOLOGIN NOBYPASSRLS;
    END IF;
END
$$;
