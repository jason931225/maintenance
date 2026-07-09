-- BE-AUTO slice 2 — object-type-bound blocks (dynamics↔ontology).
--
-- A trigger binding now declares WHICH object kind the rule acts on, tying the
-- automation layer to the ontology's object_types registry. The explore
-- screen's "작용 자동화" panel reads this to answer "which rules touch this
-- object type" (GET /workflow-studio/definitions/by-object-kind/{kind}).
--
-- Nullable so slice-1 bindings (and event bindings that are not object-scoped)
-- keep working; when set it MUST be a known kind — the FK to the global
-- object_types registry (0102) is the DB-level existence guarantee, and the
-- create endpoint validates it up front for a clean 422 instead of a 500.

ALTER TABLE workflow_trigger_bindings
    ADD COLUMN subject_kind TEXT NULL
        REFERENCES object_types(kind) ON DELETE RESTRICT;

-- The by-object-kind panel's hot read: enabled bindings acting on one kind.
CREATE INDEX idx_workflow_trigger_bindings_subject_kind
    ON workflow_trigger_bindings (org_id, subject_kind)
    WHERE enabled AND subject_kind IS NOT NULL;
