-- HR leave-request + 연차 사용 촉진 (annual-leave usage promotion) workflow.
--
-- Leave requests are owner-authored (self-service) and approved by the branch
-- HR/manager tier. A decide step is separation-of-duties: the approver must be
-- a different user than the requester (enforced both in code and by the
-- leave_requests_decider_distinct CHECK below). Promotion rounds carry the
-- 근로기준법 §61 1차/2차 usage-promotion notices; each round fans out to a
-- computed set of target employees whose per-target receipt (수령확인) state
-- lives on leave_promotion_targets so the existing document/inbox flow can flip
-- it to CONFIRMED without a bespoke table.

-- mnt-gate: audited-table leave_requests
CREATE TABLE leave_requests (
    id             UUID        NOT NULL DEFAULT gen_random_uuid(),
    org_id         UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    employee_id    UUID        NOT NULL,
    branch_id      UUID        NULL REFERENCES branches(id) ON DELETE SET NULL,
    leave_type     TEXT        NOT NULL
        CHECK (leave_type IN ('ANNUAL','HALF_DAY_AM','HALF_DAY_PM','SICK','FAMILY_EVENT','PUBLIC_DUTY','UNPAID','OTHER')),
    reason         TEXT        NOT NULL
        CHECK (reason IN ('PERSONAL','FAMILY_EVENT','MEDICAL','BEREAVEMENT','CHILDCARE','CIVIC_DUTY','OTHER')),
    start_date     DATE        NOT NULL,
    end_date       DATE        NOT NULL,
    note           TEXT        NULL CHECK (note IS NULL OR char_length(note) <= 1000),
    status         TEXT        NOT NULL DEFAULT 'SUBMITTED'
        CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED')),
    requested_by   UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    requested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_by     UUID        NULL REFERENCES users(id) ON DELETE RESTRICT,
    decided_at     TIMESTAMPTZ NULL,
    decision_note  TEXT        NULL CHECK (decision_note IS NULL OR char_length(decision_note) <= 1000),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, org_id),
    FOREIGN KEY (employee_id, org_id) REFERENCES employees(id, org_id) ON DELETE CASCADE,
    CONSTRAINT leave_requests_date_range CHECK (end_date >= start_date),
    -- Separation of duties: an approver/rejecter can never be the requester.
    CONSTRAINT leave_requests_decider_distinct CHECK (decided_by IS NULL OR decided_by <> requested_by),
    -- A decided request must carry its decider and timestamp; a pending one must not.
    CONSTRAINT leave_requests_decision_shape CHECK (
        (status IN ('APPROVED','REJECTED') AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
        OR (status IN ('DRAFT','SUBMITTED') AND decided_by IS NULL AND decided_at IS NULL)
    )
);

CREATE INDEX leave_requests_org_status_idx
    ON leave_requests (org_id, status, requested_at DESC);
CREATE INDEX leave_requests_org_employee_idx
    ON leave_requests (org_id, employee_id, requested_at DESC);
CREATE INDEX leave_requests_branch_status_idx
    ON leave_requests (org_id, branch_id, status, requested_at DESC)
    WHERE branch_id IS NOT NULL;
CREATE TRIGGER trg_leave_requests_org_immutable
    BEFORE UPDATE ON leave_requests
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();

-- mnt-gate: audited-table leave_promotion_rounds
CREATE TABLE leave_promotion_rounds (
    id             UUID        NOT NULL DEFAULT gen_random_uuid(),
    org_id         UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    round_no       SMALLINT    NOT NULL CHECK (round_no IN (1, 2)),
    reference_year INTEGER     NOT NULL CHECK (reference_year BETWEEN 2000 AND 2100),
    threshold_days NUMERIC     NOT NULL DEFAULT 0 CHECK (threshold_days >= 0),
    status         TEXT        NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT','SENT','COMPLETED')),
    note           TEXT        NULL CHECK (note IS NULL OR char_length(note) <= 1000),
    created_by     UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    sent_at        TIMESTAMPTZ NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, org_id),
    UNIQUE (org_id, round_no, reference_year)
);

CREATE INDEX leave_promotion_rounds_org_status_idx
    ON leave_promotion_rounds (org_id, status, reference_year DESC, round_no);
CREATE TRIGGER trg_leave_promotion_rounds_org_immutable
    BEFORE UPDATE ON leave_promotion_rounds
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();

-- mnt-gate: audited-table leave_promotion_targets
CREATE TABLE leave_promotion_targets (
    id                    UUID        NOT NULL DEFAULT gen_random_uuid(),
    org_id                UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    round_id              UUID        NOT NULL,
    employee_id           UUID        NOT NULL,
    remaining_days_snapshot NUMERIC   NOT NULL DEFAULT 0,
    receipt_status        TEXT        NOT NULL DEFAULT 'PENDING'
        CHECK (receipt_status IN ('PENDING','CONFIRMED')),
    receipt_confirmed_at  TIMESTAMPTZ NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, org_id),
    UNIQUE (org_id, round_id, employee_id),
    FOREIGN KEY (round_id, org_id) REFERENCES leave_promotion_rounds(id, org_id) ON DELETE CASCADE,
    FOREIGN KEY (employee_id, org_id) REFERENCES employees(id, org_id) ON DELETE CASCADE
);

CREATE INDEX leave_promotion_targets_round_idx
    ON leave_promotion_targets (org_id, round_id, receipt_status);
CREATE TRIGGER trg_leave_promotion_targets_org_immutable
    BEFORE UPDATE ON leave_promotion_targets
    FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable();

DO $$
DECLARE
    t TEXT;
    tenant_tables TEXT[] := ARRAY[
        'leave_requests',
        'leave_promotion_rounds',
        'leave_promotion_targets'
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
    END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE ON leave_requests TO mnt_rt;
GRANT SELECT, INSERT, UPDATE ON leave_promotion_rounds TO mnt_rt;
GRANT SELECT, INSERT, UPDATE ON leave_promotion_targets TO mnt_rt;
