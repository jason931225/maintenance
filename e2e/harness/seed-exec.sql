-- E2E seed data for EXECUTIVE story specs.
-- Run as migration-only mnt_app (BYPASSRLS) against mnt_e2e, AFTER seed-admin.sql.
-- Idempotent via ON CONFLICT DO NOTHING.
--
-- Provides the executive-only prerequisite the EXEC specs act on:
--   - A purchase request parked at EXECUTIVE_PENDING (…f10001) so the executive's
--     final-approve (PurchaseFinalApprove `[D, D, D, A, A]`) can be exercised
--     end-to-end in the browser. The amount exceeds the 2,000,000원 executive
--     threshold, which is exactly the condition that routes a request to
--     EXECUTIVE_PENDING rather than straight to READY_TO_EXECUTE.
--
-- Reuses the seed-admin equipment (…ee0003) + REQUEST evidence (…0ed001) so no
-- new equipment/evidence rows are needed.
BEGIN;

SELECT set_config('app.current_org', '00000000-0000-0000-0000-0000000000a1', true);

\set org_id    '00000000-0000-0000-0000-0000000000a1'
\set branch_id '00000000-0000-0000-0000-0000000000c1'
\set equip_id  '00000000-0000-0000-0000-000000ee0003'
\set evidence  '00000000-0000-0000-0000-0000000ed001'
\set admin_id  '00000000-0000-0000-0000-0000000d0003'
\set exec_id   '00000000-0000-0000-0000-0000000d0004'

-- A purchase request already admin-approved and awaiting the executive's final
-- approval. The amount (3,000,000원) is above the executive threshold so the
-- EXECUTIVE_PENDING state is the legitimate next step in the workflow.
INSERT INTO financial_purchase_requests (
  id, branch_id, equipment_id, statement_evidence_id,
  vendor_name, amount_won, memo, status, expenditure_no,
  requested_by, submitted_by, admin_approved_by,
  depreciation_method, useful_life_months, residual_rate_bps,
  declining_balance_rate_bps, management_fee_rate_bps, profit_rate_bps,
  floor_negative_quote_residual, executive_threshold_won,
  created_at, updated_at, org_id, purchase_type
)
VALUES (
  '00000000-0000-0000-0000-000000f10001',
  :'branch_id', :'equip_id', :'evidence',
  'E2E임원거래처', 3000000, 'E2E 임원 최종 승인 대상', 'EXECUTIVE_PENDING', 'E2E-EXP-0001',
  :'admin_id', :'admin_id', :'admin_id',
  'STRAIGHT_LINE', 60, 1000,
  2000, 1000, 500,
  true, 2000000,
  now(), now(), :'org_id', 'ONE_OFF'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO financial_purchase_request_lines (
  purchase_request_id, line_no, item, quantity,
  unit_supply_price_won, vat_won, vat_overridden,
  line_total_won, org_id
)
VALUES (
  '00000000-0000-0000-0000-000000f10001', 1, 'E2E 임원 최종 승인 대상', 1,
  3000000, 0, false,
  3000000, :'org_id'
)
ON CONFLICT (purchase_request_id, line_no) DO NOTHING;

COMMIT;
