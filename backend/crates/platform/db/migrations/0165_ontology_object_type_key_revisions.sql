-- Tenant/key-scoped optimistic-concurrency token for ontology writes.
--
-- Object-type rows are immutable version snapshots, but authoring and lifecycle
-- operations mutate the logical stable key. A token copied onto every version
-- would therefore admit stale writes against sibling rows. This sidecar owns
-- exactly one revision counter and one unguessable validator identity per
-- (tenant, stable key).

CREATE TABLE ont_object_type_key_revisions (
    org_id       UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    stable_key   TEXT        NOT NULL CHECK (stable_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
    validator_id UUID        NOT NULL DEFAULT gen_random_uuid(),
    revision     BIGINT      NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, stable_key),
    UNIQUE (validator_id),
    UNIQUE (org_id, stable_key, validator_id)
);

-- Legacy keys receive a conservative monotone baseline. New keys start at r1.
INSERT INTO ont_object_type_key_revisions (
    org_id, stable_key, revision, created_at, updated_at
)
SELECT org_id, stable_key, MAX(schema_version), MIN(created_at), MAX(updated_at)
FROM ont_object_types
GROUP BY org_id, stable_key;

ALTER TABLE ont_object_types
    ADD CONSTRAINT fk_ont_object_types_key_revision
    FOREIGN KEY (org_id, stable_key)
    REFERENCES ont_object_type_key_revisions (org_id, stable_key)
    ON DELETE RESTRICT;

ALTER TABLE ont_object_type_key_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ont_object_type_key_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON ont_object_type_key_revisions
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_ont_object_type_key_revisions_org_immutable
    BEFORE UPDATE ON ont_object_type_key_revisions
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();

GRANT SELECT ON ont_object_type_key_revisions TO mnt_rt;
GRANT INSERT (org_id, stable_key) ON ont_object_type_key_revisions TO mnt_rt;
GRANT UPDATE (revision, updated_at) ON ont_object_type_key_revisions TO mnt_rt;
REVOKE DELETE ON ont_object_type_key_revisions FROM mnt_rt;
REVOKE UPDATE (org_id, stable_key, validator_id, created_at)
    ON ont_object_type_key_revisions FROM mnt_rt;
