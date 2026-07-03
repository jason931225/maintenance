-- Add payroll-specific feature gates. Payroll data is separated from
-- purchase/finance and is visible only through payroll roles or explicit custom
-- grants.

INSERT INTO feature_catalog (feature_key) VALUES
    ('payroll_read'),
    ('payroll_manage')
ON CONFLICT (feature_key) DO NOTHING;
