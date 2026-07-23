-- Live object-policy reads lower the validated no-code blocks stored with the
-- enforced catalog entry. Keeping this immutable, structured source alongside
-- the generated Cedar text lets list filtering fail closed when it cannot prove
-- an SQL-equivalent residual.
ALTER TABLE cedar_policy_catalog_entries
    ADD COLUMN normalized_row JSONB NULL
        CHECK (normalized_row IS NULL OR jsonb_typeof(normalized_row) = 'object');

ALTER TABLE cedar_policy_catalog_entries
    ADD CONSTRAINT cedar_policy_catalog_enforced_normalized_row
    CHECK (status NOT IN ('enforced', 'shadow') OR normalized_row IS NOT NULL);
