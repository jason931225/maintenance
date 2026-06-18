-- Multi-tenant phase 1, step 3: seed tenant #1 and backfill every slice row.
--
-- All pre-existing data belongs to KNL Logistics (the only tenant before
-- multi-tenancy). Create that organization and stamp every slice row with its
-- id, leaving zero NULLs so 0029 can SET NOT NULL. The DO block captures the
-- freshly generated org id in a variable and reuses it across all updates.
--
-- Idempotent on the organization (ON CONFLICT on the unique slug); the UPDATEs
-- only touch rows whose org_id is still NULL, so re-running is a clean no-op.

DO $$
DECLARE
    knl_id UUID;
BEGIN
    INSERT INTO organizations (slug, name)
    VALUES ('knl', 'KNL Logistics')
    ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
    RETURNING id INTO knl_id;

    UPDATE regions            SET org_id = knl_id WHERE org_id IS NULL;
    UPDATE branches           SET org_id = knl_id WHERE org_id IS NULL;
    UPDATE users              SET org_id = knl_id WHERE org_id IS NULL;
    UPDATE registry_customers SET org_id = knl_id WHERE org_id IS NULL;
    UPDATE registry_sites     SET org_id = knl_id WHERE org_id IS NULL;
    UPDATE registry_equipment SET org_id = knl_id WHERE org_id IS NULL;
    UPDATE work_orders        SET org_id = knl_id WHERE org_id IS NULL;
END
$$;
