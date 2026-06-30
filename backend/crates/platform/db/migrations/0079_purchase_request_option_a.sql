-- Purchase request Option A production model: normalized lines, server-owned totals,
-- structured exceptions, and quote attachment references.

ALTER TABLE financial_purchase_requests
    ALTER COLUMN equipment_id DROP NOT NULL,
    ALTER COLUMN statement_evidence_id DROP NOT NULL;

ALTER TABLE financial_purchase_requests
    ADD COLUMN purchase_type TEXT,
    ADD COLUMN subtotal_won BIGINT,
    ADD COLUMN vat_won BIGINT,
    ADD COLUMN shipping_won BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN discount_won BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN total_won BIGINT;

UPDATE financial_purchase_requests
SET purchase_type = 'EQUIPMENT',
    subtotal_won = amount_won,
    vat_won = 0,
    total_won = amount_won
WHERE purchase_type IS NULL;

ALTER TABLE financial_purchase_requests
    ALTER COLUMN purchase_type SET NOT NULL,
    ALTER COLUMN subtotal_won SET NOT NULL,
    ALTER COLUMN vat_won SET NOT NULL,
    ALTER COLUMN total_won SET NOT NULL,
    ADD CONSTRAINT financial_purchase_requests_purchase_type_check
        CHECK (purchase_type IN ('EQUIPMENT', 'NON_EQUIPMENT')),
    ADD CONSTRAINT financial_purchase_requests_totals_check
        CHECK (
            subtotal_won >= 0
            AND vat_won >= 0
            AND shipping_won >= 0
            AND discount_won >= 0
            AND total_won > 0
            AND amount_won = total_won
        ),
    ADD CONSTRAINT financial_purchase_requests_equipment_type_scope_check
        CHECK (
            (purchase_type = 'EQUIPMENT' AND equipment_id IS NOT NULL AND statement_evidence_id IS NOT NULL)
            OR purchase_type = 'NON_EQUIPMENT'
        );

-- mnt-gate: audited-table financial_purchase_request_lines
CREATE TABLE financial_purchase_request_lines (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    purchase_request_id  UUID        NOT NULL,
    line_order           SMALLINT    NOT NULL CHECK (line_order > 0),
    description          TEXT        NOT NULL CHECK (description <> ''),
    quantity             INTEGER     NOT NULL CHECK (quantity > 0),
    unit                 TEXT        NOT NULL CHECK (unit <> ''),
    unit_price_won       BIGINT      NOT NULL CHECK (unit_price_won >= 0),
    subtotal_won         BIGINT      NOT NULL CHECK (subtotal_won >= 0),
    tax_rate_bps         INTEGER     NOT NULL CHECK (tax_rate_bps BETWEEN 0 AND 10000),
    vat_won              BIGINT      NOT NULL CHECK (vat_won >= 0),
    total_won            BIGINT      NOT NULL CHECK (total_won >= 0),
    category             TEXT        NOT NULL CHECK (category <> ''),
    department           TEXT,
    cost_center          TEXT,
    project              TEXT,
    sku                  TEXT,
    quote_evidence_id    UUID,
    needed_by            DATE,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    org_id               UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    CONSTRAINT financial_purchase_request_lines_request_same_org_fk
        FOREIGN KEY (purchase_request_id, org_id)
        REFERENCES financial_purchase_requests(id, org_id)
        ON DELETE CASCADE,
    CONSTRAINT financial_purchase_request_lines_quote_same_org_fk
        FOREIGN KEY (quote_evidence_id, org_id)
        REFERENCES evidence_media(id, org_id)
        ON DELETE RESTRICT,
    UNIQUE (purchase_request_id, line_order),
    UNIQUE (id, org_id)
);

INSERT INTO financial_purchase_request_lines (
    purchase_request_id, line_order, description, quantity, unit,
    unit_price_won, subtotal_won, tax_rate_bps, vat_won, total_won,
    category, org_id
)
SELECT id, 1, memo, 1, 'EA', amount_won, amount_won, 0, 0, amount_won, 'legacy', org_id
FROM financial_purchase_requests;

-- mnt-gate: audited-table financial_purchase_request_attachments
CREATE TABLE financial_purchase_request_attachments (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    purchase_request_id  UUID        NOT NULL,
    line_id              UUID,
    evidence_id          UUID        NOT NULL,
    attachment_type      TEXT        NOT NULL CHECK (attachment_type IN ('QUOTE', 'INVOICE', 'STATEMENT', 'OTHER')),
    preferred_quote      BOOLEAN     NOT NULL DEFAULT false,
    created_by           UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    org_id               UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    CONSTRAINT financial_purchase_request_attachments_request_same_org_fk
        FOREIGN KEY (purchase_request_id, org_id)
        REFERENCES financial_purchase_requests(id, org_id)
        ON DELETE CASCADE,
    CONSTRAINT financial_purchase_request_attachments_line_same_org_fk
        FOREIGN KEY (line_id, org_id)
        REFERENCES financial_purchase_request_lines(id, org_id)
        ON DELETE CASCADE,
    CONSTRAINT financial_purchase_request_attachments_evidence_same_org_fk
        FOREIGN KEY (evidence_id, org_id)
        REFERENCES evidence_media(id, org_id)
        ON DELETE RESTRICT,
    UNIQUE (purchase_request_id, evidence_id)
);

INSERT INTO financial_purchase_request_attachments (
    purchase_request_id, evidence_id, attachment_type, preferred_quote, created_by, org_id
)
SELECT id, statement_evidence_id, 'STATEMENT', true, requested_by, org_id
FROM financial_purchase_requests
WHERE statement_evidence_id IS NOT NULL;

-- mnt-gate: audited-table financial_purchase_request_exceptions
CREATE TABLE financial_purchase_request_exceptions (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    purchase_request_id  UUID        NOT NULL,
    exception_type       TEXT        NOT NULL CHECK (exception_type IN ('PRICE_ANOMALY', 'MISSING_QUOTE', 'POLICY_OVERRIDE', 'BUDGET_OVERRIDE')),
    reason               TEXT        NOT NULL CHECK (reason <> ''),
    attachment_evidence_id UUID,
    escalation_approver  UUID        REFERENCES users(id) ON DELETE RESTRICT,
    status               TEXT        NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'NEEDS_CHANGES')) DEFAULT 'PENDING',
    created_by           UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    org_id               UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    CONSTRAINT financial_purchase_request_exceptions_request_same_org_fk
        FOREIGN KEY (purchase_request_id, org_id)
        REFERENCES financial_purchase_requests(id, org_id)
        ON DELETE CASCADE,
    CONSTRAINT financial_purchase_request_exceptions_evidence_same_org_fk
        FOREIGN KEY (attachment_evidence_id, org_id)
        REFERENCES evidence_media(id, org_id)
        ON DELETE RESTRICT
);

CREATE INDEX idx_financial_purchase_request_lines_request
    ON financial_purchase_request_lines (org_id, purchase_request_id, line_order);
CREATE INDEX idx_financial_purchase_request_attachments_request
    ON financial_purchase_request_attachments (org_id, purchase_request_id, created_at DESC);
CREATE INDEX idx_financial_purchase_request_exceptions_request
    ON financial_purchase_request_exceptions (org_id, purchase_request_id, created_at DESC);
CREATE INDEX idx_financial_purchase_requests_requester
    ON financial_purchase_requests (org_id, requested_by, updated_at DESC);

DO $$
DECLARE
    t TEXT;
    tenant_tables TEXT[] := ARRAY[
        'financial_purchase_request_lines',
        'financial_purchase_request_attachments',
        'financial_purchase_request_exceptions'
    ];
BEGIN
    FOREACH t IN ARRAY tenant_tables LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY org_isolation ON %I '
            || 'USING (org_id = NULLIF(current_setting(''app.current_org'', true), '''')::uuid) '
            || 'WITH CHECK (org_id = NULLIF(current_setting(''app.current_org'', true), '''')::uuid)',
            t
        );
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO mnt_rt', t);
        EXECUTE format(
            'CREATE TRIGGER trg_%s_org_immutable BEFORE UPDATE ON %I '
            || 'FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable()',
            t,
            t
        );
    END LOOP;
END
$$;
