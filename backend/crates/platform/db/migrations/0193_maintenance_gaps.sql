-- Maintenance history is a distinct, append-only operational record. It is not
-- an equipment-registry version: a completed work order records an auditable
-- maintenance event, while registry_equipment_versions remains reserved for
-- snapshots of the equipment aggregate itself.
--
-- The work-order adapter writes this history only after the existing final
-- completion FSM transition. The database repeats that terminal/evidence
-- interlock so direct writers cannot create a premature maintenance record.

-- The older cost ledger predates composite tenant foreign keys. Add the key
-- required to make an immutable, tenant-pinned reference from the history
-- snapshot without copying or fabricating any monetary value.
ALTER TABLE equipment_cost_ledger
    ADD CONSTRAINT equipment_cost_ledger_id_org_key UNIQUE (id, org_id);

-- mnt-gate: audited-table equipment_maintenance_history
CREATE TABLE equipment_maintenance_history (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    equipment_id  UUID        NOT NULL,
    work_order_id UUID        NOT NULL,
    completed_at  TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (id, org_id),
    UNIQUE (org_id, work_order_id),
    CONSTRAINT equipment_maintenance_history_equipment_same_org_fk
        FOREIGN KEY (equipment_id, org_id)
        REFERENCES registry_equipment (id, org_id) ON DELETE RESTRICT,
    CONSTRAINT equipment_maintenance_history_work_order_same_org_fk
        FOREIGN KEY (work_order_id, org_id)
        REFERENCES work_orders (id, org_id) ON DELETE RESTRICT
);

CREATE INDEX idx_equipment_maintenance_history_equipment
    ON equipment_maintenance_history (org_id, equipment_id, completed_at DESC);

-- The evidence references comprise the exact AFTER/REPORT evidence set that
-- passed the final-completion interlock. They remain append-only even if
-- subsequent operational remediation creates additional evidence elsewhere.
CREATE TABLE equipment_maintenance_history_evidence (
    history_id        UUID NOT NULL,
    org_id            UUID NOT NULL,
    evidence_media_id UUID NOT NULL,
    PRIMARY KEY (history_id, evidence_media_id),
    CONSTRAINT equipment_maintenance_history_evidence_history_same_org_fk
        FOREIGN KEY (history_id, org_id)
        REFERENCES equipment_maintenance_history (id, org_id) ON DELETE RESTRICT,
    CONSTRAINT equipment_maintenance_history_evidence_media_same_org_fk
        FOREIGN KEY (evidence_media_id, org_id)
        REFERENCES evidence_media (id, org_id) ON DELETE RESTRICT
);

CREATE INDEX idx_equipment_maintenance_history_evidence_org
    ON equipment_maintenance_history_evidence (org_id, evidence_media_id);

-- A cost reference is optional. It only links an already-posted cost ledger
-- entry for this work order/equipment; it never stores a new amount or creates
-- a ledger movement as a side effect of completion.
CREATE TABLE equipment_maintenance_history_costs (
    history_id                 UUID NOT NULL,
    org_id                     UUID NOT NULL,
    equipment_cost_ledger_id   UUID NOT NULL,
    PRIMARY KEY (history_id, equipment_cost_ledger_id),
    CONSTRAINT equipment_maintenance_history_costs_history_same_org_fk
        FOREIGN KEY (history_id, org_id)
        REFERENCES equipment_maintenance_history (id, org_id) ON DELETE RESTRICT,
    CONSTRAINT equipment_maintenance_history_costs_ledger_same_org_fk
        FOREIGN KEY (equipment_cost_ledger_id, org_id)
        REFERENCES equipment_cost_ledger (id, org_id) ON DELETE RESTRICT
);

CREATE INDEX idx_equipment_maintenance_history_costs_org
    ON equipment_maintenance_history_costs (org_id, equipment_cost_ledger_id);

CREATE OR REPLACE FUNCTION equipment_maintenance_history_require_final_completion()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM work_orders w
        WHERE w.id = NEW.work_order_id
          AND w.org_id = NEW.org_id
          AND w.equipment_id = NEW.equipment_id
          AND w.status = 'FINAL_COMPLETED'
          AND w.result_type = 'COMPLETED'
          AND EXISTS (
              SELECT 1
              FROM evidence_media e
              WHERE e.work_order_id = w.id
                AND e.org_id = w.org_id
                AND e.stage IN ('AFTER', 'REPORT')
                AND e.worm_replica_status = 'VERIFIED'
          )
          AND NOT EXISTS (
              SELECT 1
              FROM evidence_media e
              WHERE e.work_order_id = w.id
                AND e.org_id = w.org_id
                AND e.stage IN ('AFTER', 'REPORT')
                AND e.worm_replica_status <> 'VERIFIED'
          )
    ) THEN
        RAISE EXCEPTION
            'maintenance history requires a FINAL_COMPLETED work order with a verified completion evidence set'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION equipment_maintenance_history_evidence_require_verified_snapshot()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM equipment_maintenance_history h
        JOIN evidence_media e
          ON e.id = NEW.evidence_media_id
         AND e.org_id = NEW.org_id
        WHERE h.id = NEW.history_id
          AND h.org_id = NEW.org_id
          AND e.work_order_id = h.work_order_id
          AND e.stage IN ('AFTER', 'REPORT')
          AND e.worm_replica_status = 'VERIFIED'
    ) THEN
        RAISE EXCEPTION
            'maintenance history evidence must be verified completion evidence for the recorded work order'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION equipment_maintenance_history_cost_require_matching_ledger()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM equipment_maintenance_history h
        JOIN equipment_cost_ledger l
          ON l.id = NEW.equipment_cost_ledger_id
         AND l.org_id = NEW.org_id
        WHERE h.id = NEW.history_id
          AND h.org_id = NEW.org_id
          AND l.equipment_id = h.equipment_id
          AND l.work_order_id = h.work_order_id
    ) THEN
        RAISE EXCEPTION
            'maintenance history costs must reference an existing ledger entry for the recorded equipment and work order'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_equipment_maintenance_history_final_completion
    BEFORE INSERT ON equipment_maintenance_history
    FOR EACH ROW EXECUTE FUNCTION equipment_maintenance_history_require_final_completion();
CREATE TRIGGER trg_equipment_maintenance_history_evidence_verified_snapshot
    BEFORE INSERT ON equipment_maintenance_history_evidence
    FOR EACH ROW EXECUTE FUNCTION equipment_maintenance_history_evidence_require_verified_snapshot();
CREATE TRIGGER trg_equipment_maintenance_history_cost_matching_ledger
    BEFORE INSERT ON equipment_maintenance_history_costs
    FOR EACH ROW EXECUTE FUNCTION equipment_maintenance_history_cost_require_matching_ledger();

-- Every history relation is append-only; corrections are new work-order events,
-- never mutation or deletion of the completed evidence/cost snapshot.
CREATE TRIGGER trg_equipment_maintenance_history_no_update
    BEFORE UPDATE ON equipment_maintenance_history
    FOR EACH ROW EXECUTE FUNCTION platform_append_only_immutable();
CREATE TRIGGER trg_equipment_maintenance_history_no_delete
    BEFORE DELETE ON equipment_maintenance_history
    FOR EACH ROW EXECUTE FUNCTION platform_append_only_immutable();
CREATE TRIGGER trg_equipment_maintenance_history_evidence_no_update
    BEFORE UPDATE ON equipment_maintenance_history_evidence
    FOR EACH ROW EXECUTE FUNCTION platform_append_only_immutable();
CREATE TRIGGER trg_equipment_maintenance_history_evidence_no_delete
    BEFORE DELETE ON equipment_maintenance_history_evidence
    FOR EACH ROW EXECUTE FUNCTION platform_append_only_immutable();
CREATE TRIGGER trg_equipment_maintenance_history_costs_no_update
    BEFORE UPDATE ON equipment_maintenance_history_costs
    FOR EACH ROW EXECUTE FUNCTION platform_append_only_immutable();
CREATE TRIGGER trg_equipment_maintenance_history_costs_no_delete
    BEFORE DELETE ON equipment_maintenance_history_costs
    FOR EACH ROW EXECUTE FUNCTION platform_append_only_immutable();

ALTER TABLE equipment_maintenance_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE equipment_maintenance_history FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON equipment_maintenance_history
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE equipment_maintenance_history_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE equipment_maintenance_history_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON equipment_maintenance_history_evidence
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE equipment_maintenance_history_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE equipment_maintenance_history_costs FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON equipment_maintenance_history_costs
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

GRANT SELECT, INSERT ON equipment_maintenance_history TO mnt_rt;
GRANT SELECT, INSERT ON equipment_maintenance_history_evidence TO mnt_rt;
GRANT SELECT, INSERT ON equipment_maintenance_history_costs TO mnt_rt;
