-- no-transaction
-- HR read-path performance: 직원명부 / 조직도 / 연차 / payroll readiness.
-- SQLx recognizes the first line and applies this migration outside a
-- transaction, which is required for CONCURRENTLY. Production rollout should use
-- this low-lock path so large tenant ledgers keep serving writes while indexes
-- are built; rollback is DROP INDEX CONCURRENTLY for the named indexes below.
--
-- These indexes mirror the tenant-scoped ORDER BY / filter shapes used by
-- backend/app/src/hr.rs. The leading org_id column matches the RLS-injected
-- tenant predicate from with_org_conn/current_setting('app.current_org', true),
-- preventing large cross-tenant scans and memory sorts as HR ledgers grow.

CREATE INDEX CONCURRENTLY IF NOT EXISTS employees_org_directory_order_idx
    ON employees (org_id, company, name, source_sheet, source_row);

CREATE INDEX CONCURRENTLY IF NOT EXISTS employees_org_chart_order_idx
    ON employees (
        org_id,
        company,
        (COALESCE(NULLIF(org_unit, ''), '소속 미지정')),
        (COALESCE(NULLIF(position, ''), '직책 미지정')),
        name,
        source_sheet,
        source_row
    );

CREATE INDEX CONCURRENTLY IF NOT EXISTS employees_org_leave_order_idx
    ON employees (org_id, company, name, source_sheet, source_row)
    WHERE leave_accrued IS NOT NULL
       OR leave_used IS NOT NULL
       OR leave_remaining IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS payroll_draft_lines_org_status_employee_idx
    ON payroll_draft_lines (
        org_id,
        calculation_status,
        employee_company,
        employee_display_name,
        run_id
    );

CREATE INDEX CONCURRENTLY IF NOT EXISTS data_import_rows_org_run_status_order_idx
    ON data_import_rows (org_id, run_id, row_status, source_sheet, source_row);

CREATE INDEX CONCURRENTLY IF NOT EXISTS data_import_rows_org_status_created_idx
    ON data_import_rows (org_id, row_status, created_at DESC);
