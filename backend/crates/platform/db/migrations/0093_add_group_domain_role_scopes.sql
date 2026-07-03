-- Group/HQ delegation model:
--   * group_role_grants.group_role is the functional domain
--     (admin, viewer, HR, labor, finance, maintenance, payroll, approvals);
--   * group_role_grant_org_scopes optionally narrows that grant to selected
--     subsidiaries. No scope rows means the grant spans every active subsidiary
--     in the group.
--
-- This separates legal employment org from actual HQ/group responsibility. A
-- user can belong to one subsidiary but receive HQ/group authority for selected
-- or all subsidiaries through these owner-only grants.

ALTER TABLE group_role_grants
    DROP CONSTRAINT IF EXISTS group_role_grants_group_role_check;
ALTER TABLE group_role_grants
    ADD CONSTRAINT group_role_grants_group_role_check
        CHECK (group_role IN (
            'GROUP_ADMIN',
            'GROUP_VIEWER',
            'GROUP_HR',
            'GROUP_LABOR',
            'GROUP_FINANCE',
            'GROUP_MAINTENANCE',
            'GROUP_PAYROLL',
            'GROUP_APPROVALS'
        ));

-- mnt-gate: owner-only-table group_role_grant_org_scopes (rationale: cross-tenant group-role authorization scope)
CREATE TABLE group_role_grant_org_scopes (
    grant_id   UUID        NOT NULL REFERENCES group_role_grants(id) ON DELETE CASCADE,
    group_id   UUID        NOT NULL,
    org_id     UUID        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (grant_id, org_id),
    FOREIGN KEY (group_id, org_id) REFERENCES group_memberships(group_id, org_id) ON DELETE CASCADE
);
CREATE INDEX idx_group_role_grant_org_scopes_group_org
    ON group_role_grant_org_scopes (group_id, org_id);
REVOKE ALL ON group_role_grant_org_scopes FROM mnt_rt;
REVOKE ALL ON group_role_grant_org_scopes FROM PUBLIC;

-- rls-arming: ok identity-only SECURITY DEFINER resolver
CREATE OR REPLACE FUNCTION group_member_org_ids_for_roles(
    p_group UUID,
    p_actor UUID,
    p_roles TEXT[]
)
RETURNS TABLE (org_id UUID, slug TEXT, name TEXT, status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    result_rows organizations[];
BEGIN
    SET LOCAL row_security = off;
    SELECT array_agg(o ORDER BY o.created_at ASC, o.id ASC)
    INTO result_rows
    FROM organizations o
        JOIN group_memberships m ON m.org_id = o.id
    WHERE m.group_id = p_group
      AND o.status = 'ACTIVE'
      AND o.id <> '00000000-0000-0000-0000-00000000face'::uuid
      AND EXISTS (
          SELECT 1
          FROM group_role_grants g
              JOIN users u ON u.id = g.user_id
          WHERE g.group_id = p_group
            AND g.user_id = p_actor
            AND g.group_role = ANY(p_roles)
            AND u.is_active
            AND (
                NOT EXISTS (
                    SELECT 1
                    FROM group_role_grant_org_scopes s_all
                    WHERE s_all.grant_id = g.id
                )
                OR EXISTS (
                    SELECT 1
                    FROM group_role_grant_org_scopes s
                    WHERE s.grant_id = g.id
                      AND s.org_id = o.id
                )
            )
      );
    SET LOCAL row_security = on;

    RETURN QUERY
        SELECT r.id, r.slug, r.name, r.status
        FROM unnest(COALESCE(result_rows, ARRAY[]::organizations[])) AS r;
EXCEPTION WHEN OTHERS THEN
    SET LOCAL row_security = on;
    RAISE;
END;
$$;
REVOKE ALL ON FUNCTION group_member_org_ids_for_roles(UUID, UUID, TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION group_member_org_ids_for_roles(UUID, UUID, TEXT[]) TO mnt_rt;

-- Preserve the original broad resolver name but make it scope-aware.
CREATE OR REPLACE FUNCTION group_member_org_ids(p_group UUID, p_actor UUID)
RETURNS TABLE (org_id UUID, slug TEXT, name TEXT, status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    RETURN QUERY
        SELECT scoped.org_id, scoped.slug, scoped.name, scoped.status
        FROM group_member_org_ids_for_roles(
            p_group,
            p_actor,
            ARRAY[
                'GROUP_ADMIN',
                'GROUP_VIEWER',
                'GROUP_HR',
                'GROUP_LABOR',
                'GROUP_FINANCE',
                'GROUP_MAINTENANCE',
                'GROUP_PAYROLL',
                'GROUP_APPROVALS'
            ]::TEXT[]
        ) AS scoped;
END;
$$;
REVOKE ALL ON FUNCTION group_member_org_ids(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION group_member_org_ids(UUID, UUID) TO mnt_rt;

-- rls-arming: ok owner-only SECURITY DEFINER write helper for platform group account scope
CREATE OR REPLACE FUNCTION platform_replace_group_role_org_scopes(
    p_group_id UUID,
    p_user_id UUID,
    p_group_role TEXT,
    p_scope_org_ids UUID[]
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_grant_id UUID;
    v_invalid_count INTEGER;
BEGIN
    SET LOCAL row_security = off;

    SELECT id
    INTO v_grant_id
    FROM group_role_grants
    WHERE group_id = p_group_id
      AND user_id = p_user_id
      AND group_role = p_group_role;

    IF v_grant_id IS NULL THEN
        SET LOCAL row_security = on;
        RETURN NULL;
    END IF;

    DELETE FROM group_role_grant_org_scopes
    WHERE grant_id = v_grant_id;

    IF p_scope_org_ids IS NULL THEN
        SET LOCAL row_security = on;
        RETURN v_grant_id;
    END IF;

    IF cardinality(p_scope_org_ids) = 0 THEN
        RAISE EXCEPTION 'scope_org_ids must be null for all subsidiaries or contain at least one organization'
            USING ERRCODE = '23514';
    END IF;

    SELECT count(*)
    INTO v_invalid_count
    FROM (
        SELECT DISTINCT unnest(p_scope_org_ids) AS org_id
    ) requested
    LEFT JOIN group_memberships gm
      ON gm.group_id = p_group_id
     AND gm.org_id = requested.org_id
    WHERE gm.org_id IS NULL;

    IF v_invalid_count > 0 THEN
        RAISE EXCEPTION 'scope organization is not a member of the group'
            USING ERRCODE = '23503';
    END IF;

    INSERT INTO group_role_grant_org_scopes (grant_id, group_id, org_id)
    SELECT v_grant_id, p_group_id, requested.org_id
    FROM (
        SELECT DISTINCT unnest(p_scope_org_ids) AS org_id
    ) requested;

    SET LOCAL row_security = on;
    RETURN v_grant_id;
EXCEPTION WHEN OTHERS THEN
    SET LOCAL row_security = on;
    RAISE;
END;
$$;
REVOKE ALL ON FUNCTION platform_replace_group_role_org_scopes(UUID, UUID, TEXT, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_replace_group_role_org_scopes(UUID, UUID, TEXT, UUID[]) TO mnt_rt;
