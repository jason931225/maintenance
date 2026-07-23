-- Production subcontracting pilot: owns plan/operation execution and immutable
-- lifecycle evidence only. Customer demand, people, inventory, approvals,
-- ontology, and reporting remain referenced ports, never copied stores.
CREATE TABLE production_plans (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    branch_id UUID NOT NULL,
    customer_demand_id UUID NOT NULL,
    product_code TEXT NOT NULL CHECK (btrim(product_code) <> '' AND char_length(product_code) <= 80),
    quantity BIGINT NOT NULL CHECK (quantity > 0),
    due_at TIMESTAMPTZ NOT NULL,
    checks JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'RELEASED')),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    idempotency_key TEXT NOT NULL CHECK (btrim(idempotency_key) <> '' AND char_length(idempotency_key) <= 128),
    approval_ref UUID,
    ontology_type TEXT NOT NULL CHECK (btrim(ontology_type) <> '' AND char_length(ontology_type) <= 120),
    first_operation_id UUID NOT NULL UNIQUE,
    created_by UUID NOT NULL,
    released_by UUID,
    released_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (id, org_id),
    UNIQUE (org_id, idempotency_key),
    FOREIGN KEY (branch_id, org_id) REFERENCES branches(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (created_by, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (released_by, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT,
    CHECK ((status = 'DRAFT' AND released_by IS NULL AND released_at IS NULL) OR (status = 'RELEASED' AND released_by IS NOT NULL AND released_at IS NOT NULL))
);
CREATE INDEX idx_production_plans_branch_created ON production_plans (org_id, branch_id, created_at DESC, id DESC);

CREATE TABLE production_operations (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    plan_id UUID NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    status TEXT NOT NULL CHECK (status IN ('PENDING', 'RELEASED', 'RECORDED')),
    output_quantity BIGINT NOT NULL DEFAULT 0 CHECK (output_quantity >= 0),
    scrap_quantity BIGINT NOT NULL DEFAULT 0 CHECK (scrap_quantity >= 0),
    downtime_minutes INTEGER NOT NULL DEFAULT 0 CHECK (downtime_minutes >= 0),
    quality_evidence_ref TEXT CHECK (quality_evidence_ref IS NULL OR btrim(quality_evidence_ref) <> ''),
    quality_passed BOOLEAN,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    UNIQUE (id, org_id),
    UNIQUE (plan_id, sequence),
    FOREIGN KEY (plan_id, org_id) REFERENCES production_plans(id, org_id) ON DELETE RESTRICT,
    CHECK ((status = 'RECORDED') = (quality_evidence_ref IS NOT NULL AND quality_passed IS NOT NULL))
);

CREATE TABLE production_plan_events (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    plan_id UUID NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('PLAN_CREATED', 'PLAN_RELEASED', 'OPERATION_RECORDED')),
    actor_id UUID NOT NULL,
    payload JSONB NOT NULL,
    idempotency_key TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, idempotency_key),
    FOREIGN KEY (plan_id, org_id) REFERENCES production_plans(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (actor_id, org_id) REFERENCES users(id, org_id) ON DELETE RESTRICT
);
CREATE INDEX idx_production_plan_events_lineage ON production_plan_events (org_id, plan_id, occurred_at, id);

ALTER TABLE production_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON production_plans USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid) WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
CREATE TRIGGER trg_production_plans_org_immutable BEFORE UPDATE ON production_plans FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();
ALTER TABLE production_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON production_operations USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid) WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);
ALTER TABLE production_plan_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_plan_events FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON production_plan_events USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid) WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON production_plans TO mnt_rt;
GRANT SELECT, INSERT, UPDATE ON production_operations TO mnt_rt;
GRANT SELECT, INSERT ON production_plan_events TO mnt_rt;
REVOKE DELETE ON production_plans, production_operations, production_plan_events FROM mnt_rt;
