-- Make the evidentiary meaning of every EV copy explicit and database-derived.
--
-- WORM replication proves storage immutability; it does not promote a derived
-- rendering to the legal/evidentiary status of the original.  A stored generated
-- column is intentionally used so no command handler, client, or backfill can
-- claim that equivalence by supplying a mutable flag.
ALTER TABLE docs_evidence_copies
    ADD COLUMN evidentiary_status TEXT GENERATED ALWAYS AS (
        CASE
            WHEN copy_kind = 'DERIVATIVE' THEN 'NON_EVIDENTIARY_DERIVATIVE'
            WHEN worm_status = 'VERIFIED' THEN 'VERIFIED_ORIGINAL'
            ELSE 'ORIGINAL_UNVERIFIED'
        END
    ) STORED;

ALTER TABLE docs_evidence_copies
    ADD CONSTRAINT docs_evidence_copies_evidentiary_status_check
    CHECK (evidentiary_status IN (
        'VERIFIED_ORIGINAL',
        'ORIGINAL_UNVERIFIED',
        'NON_EVIDENTIARY_DERIVATIVE'
    ));

CREATE INDEX idx_docs_evidence_copies_evidentiary_status
    ON docs_evidence_copies (org_id, evidence_object_id, evidentiary_status, created_at DESC);
