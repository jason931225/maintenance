-- Consulting engagement pilot: an append-only, tenant-scoped evidence-to-benefit chain.
INSERT INTO feature_catalog (feature_key) VALUES ('consulting_read'), ('consulting_manage') ON CONFLICT DO NOTHING;

-- External systems have no common FK shape. Bind each reviewed source once to
-- this tenant-owned control plane, then reference the binding rather than an
-- unchecked caller UUID.
CREATE TABLE consulting_reference_bindings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('DOCUMENT','EVIDENCE','KPI_DEFINITION','ONTOLOGY_INSTANCE')),
    source_id UUID NOT NULL, source_version TEXT NOT NULL CHECK (btrim(source_version) <> ''),
    evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(), evaluated_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    UNIQUE (id, org_id), UNIQUE (org_id, source_kind, source_id, source_version)
);

CREATE TABLE consulting_engagements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    customer_id UUID NOT NULL, customer_document_id UUID NULL, ontology_instance_id UUID NULL,
    title TEXT NOT NULL CHECK (btrim(title) <> '' AND char_length(title) <= 180),
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PROPOSED','APPROVED','IMPLEMENTED','MEASURED','SUSTAINED','CORRECTIVE')),
    approval_id UUID NULL, workflow_execution_id UUID NULL, version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
    idempotency_key TEXT NOT NULL CHECK (btrim(idempotency_key) <> '' AND char_length(idempotency_key) <= 128),
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, idempotency_key), UNIQUE (id, org_id),
    FOREIGN KEY (customer_id, org_id) REFERENCES registry_customers(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (customer_document_id, org_id) REFERENCES consulting_reference_bindings(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (ontology_instance_id, org_id) REFERENCES consulting_reference_bindings(id, org_id) ON DELETE RESTRICT
);
CREATE TABLE consulting_diagnostics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    engagement_id UUID NOT NULL, summary TEXT NOT NULL CHECK (btrim(summary) <> ''), document_id UUID NULL, created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (id, org_id), FOREIGN KEY (engagement_id, org_id) REFERENCES consulting_engagements(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (document_id, org_id) REFERENCES consulting_reference_bindings(id, org_id) ON DELETE RESTRICT
);
CREATE TABLE consulting_findings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    engagement_id UUID NOT NULL, diagnostic_id UUID NOT NULL, statement TEXT NOT NULL CHECK (btrim(statement) <> ''), evidence_id UUID NOT NULL, document_id UUID NULL, created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (id, org_id), FOREIGN KEY (engagement_id, org_id) REFERENCES consulting_engagements(id, org_id) ON DELETE RESTRICT, FOREIGN KEY (diagnostic_id, org_id) REFERENCES consulting_diagnostics(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (evidence_id, org_id) REFERENCES consulting_reference_bindings(id, org_id) ON DELETE RESTRICT, FOREIGN KEY (document_id, org_id) REFERENCES consulting_reference_bindings(id, org_id) ON DELETE RESTRICT
);
CREATE TABLE consulting_initiatives (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    engagement_id UUID NOT NULL, finding_id UUID NOT NULL, title TEXT NOT NULL CHECK (btrim(title) <> ''), hypothesis TEXT NOT NULL CHECK (btrim(hypothesis) <> ''), kpi_definition_id UUID NOT NULL, target_direction TEXT NOT NULL CHECK (target_direction IN ('INCREASE','DECREASE')), created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (id, org_id), FOREIGN KEY (engagement_id, org_id) REFERENCES consulting_engagements(id, org_id) ON DELETE RESTRICT, FOREIGN KEY (finding_id, org_id) REFERENCES consulting_findings(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (kpi_definition_id, org_id) REFERENCES consulting_reference_bindings(id, org_id) ON DELETE RESTRICT
);
CREATE TABLE consulting_benefit_observations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    engagement_id UUID NOT NULL, initiative_id UUID NOT NULL, kpi_definition_id UUID NOT NULL, evidence_id UUID NOT NULL, observed_at TIMESTAMPTZ NOT NULL, note TEXT NOT NULL CHECK (btrim(note) <> ''), created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (id, org_id), FOREIGN KEY (engagement_id, org_id) REFERENCES consulting_engagements(id, org_id) ON DELETE RESTRICT, FOREIGN KEY (initiative_id, org_id) REFERENCES consulting_initiatives(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (kpi_definition_id, org_id) REFERENCES consulting_reference_bindings(id, org_id) ON DELETE RESTRICT, FOREIGN KEY (evidence_id, org_id) REFERENCES consulting_reference_bindings(id, org_id) ON DELETE RESTRICT
);
CREATE TABLE consulting_engagement_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    engagement_id UUID NOT NULL, actor_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, event_type TEXT NOT NULL, from_status TEXT NULL, to_status TEXT NULL, version BIGINT NOT NULL, payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'), occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (engagement_id, org_id) REFERENCES consulting_engagements(id, org_id) ON DELETE RESTRICT
);
CREATE INDEX idx_consulting_engagements_org_updated ON consulting_engagements(org_id, updated_at DESC, id);
CREATE INDEX idx_consulting_history_engagement ON consulting_engagement_history(org_id, engagement_id, occurred_at);
CREATE OR REPLACE FUNCTION consulting_reject_terminal_write()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM consulting_engagements WHERE id=NEW.engagement_id AND org_id=NEW.org_id AND status IN ('SUSTAINED','CORRECTIVE')) THEN
    RAISE EXCEPTION 'terminal consulting engagement is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_consulting_diagnostics_terminal BEFORE INSERT ON consulting_diagnostics FOR EACH ROW EXECUTE FUNCTION consulting_reject_terminal_write();
CREATE TRIGGER trg_consulting_findings_terminal BEFORE INSERT ON consulting_findings FOR EACH ROW EXECUTE FUNCTION consulting_reject_terminal_write();
CREATE TRIGGER trg_consulting_initiatives_terminal BEFORE INSERT ON consulting_initiatives FOR EACH ROW EXECUTE FUNCTION consulting_reject_terminal_write();
CREATE TRIGGER trg_consulting_observations_terminal BEFORE INSERT ON consulting_benefit_observations FOR EACH ROW EXECUTE FUNCTION consulting_reject_terminal_write();
DO $$ DECLARE t TEXT; BEGIN FOREACH t IN ARRAY ARRAY['consulting_reference_bindings','consulting_engagements','consulting_diagnostics','consulting_findings','consulting_initiatives','consulting_benefit_observations','consulting_engagement_history'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('CREATE POLICY org_isolation ON %I USING (org_id = NULLIF(current_setting(''app.current_org'', true), '''')::uuid) WITH CHECK (org_id = NULLIF(current_setting(''app.current_org'', true), '''')::uuid)', t);
  EXECUTE format('CREATE TRIGGER trg_%I_org_immutable BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable()', t, t);
END LOOP; END $$;
CREATE TRIGGER trg_consulting_history_no_update BEFORE UPDATE ON consulting_engagement_history
    FOR EACH ROW EXECUTE FUNCTION governance_append_only_record();
CREATE TRIGGER trg_consulting_history_no_delete BEFORE DELETE ON consulting_engagement_history
    FOR EACH ROW EXECUTE FUNCTION governance_append_only_record();

GRANT SELECT, INSERT, UPDATE ON consulting_engagements, consulting_diagnostics, consulting_findings, consulting_initiatives, consulting_benefit_observations TO mnt_rt;
GRANT SELECT, INSERT ON consulting_engagement_history TO mnt_rt;
REVOKE DELETE ON consulting_engagements, consulting_diagnostics, consulting_findings, consulting_initiatives, consulting_benefit_observations, consulting_engagement_history FROM mnt_rt;
REVOKE UPDATE ON consulting_engagement_history FROM mnt_rt;
