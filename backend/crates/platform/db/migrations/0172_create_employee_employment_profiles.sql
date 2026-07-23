-- Canonical employment facts created by the People & Workforce console.
-- Compensation deliberately lives outside the ordinary directory row so list
-- readers cannot receive it accidentally.
CREATE TABLE employee_employment_profiles (
    employee_id       UUID PRIMARY KEY REFERENCES employees(id) ON DELETE RESTRICT,
    org_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    employment_type   TEXT NOT NULL CHECK (employment_type IN ('REGULAR', 'CONTRACT', 'PART_TIME', 'INTERN')),
    phone_e164        TEXT NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
    base_pay          NUMERIC(14, 2) NOT NULL CHECK (base_pay >= 0),
    currency          TEXT NOT NULL DEFAULT 'KRW' CHECK (currency = 'KRW'),
    idempotency_key   TEXT NOT NULL CHECK (btrim(idempotency_key) <> ''),
    request_hash      TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    created_by        UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, idempotency_key)
);

CREATE UNIQUE INDEX employees_org_employee_number_unique
    ON employees (org_id, employee_number)
    WHERE employee_number IS NOT NULL;
CREATE INDEX employee_employment_profiles_org_employee_idx
    ON employee_employment_profiles (org_id, employee_id);

ALTER TABLE employee_employment_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_employment_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON employee_employment_profiles
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

CREATE OR REPLACE FUNCTION employee_employment_profiles_same_org()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM employees e WHERE e.id = NEW.employee_id AND e.org_id = NEW.org_id) THEN
        RAISE EXCEPTION 'employee employment profile must belong to the same org' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_employee_employment_profiles_same_org
    BEFORE INSERT OR UPDATE ON employee_employment_profiles
    FOR EACH ROW EXECUTE FUNCTION employee_employment_profiles_same_org();

GRANT SELECT, INSERT ON employee_employment_profiles TO mnt_rt;
