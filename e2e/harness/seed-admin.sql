-- E2E seed data for ADMIN / SUPER_ADMIN story specs.
-- Run as PG superuser (BYPASSRLS) against mnt_e2e, AFTER seed.sql + seed-mech.sql.
-- Idempotent via ON CONFLICT DO NOTHING.
--
-- Provides admin-only prerequisite rows the ADMIN/SADMIN specs act on:
--   - A REPORT_SUBMITTED work order (…f00007) for ADMIN-07 approvals approve
--   - A REPORT_SUBMITTED work order (…f00008) for ADMIN-07 approvals reject
--   - A RECEIVED P1 work order (…f00009) + BROADCASTING dispatch (…d10003) for
--     ADMIN-09 dispatch controls (priority / schedule / multi-assign / force-assign)
--   - A second MECHANIC user (…d0006) so multi-mechanic assign has 2 candidates
--   - A 예비 (spare) equipment (…ee0006) matching the seed-mech 호기 for ADMIN-14 대차
--   - An evidence_media row (…ev0001) so ADMIN-13 can create a purchase request
--     in-spec (the create needs a real statement_evidence_id FK)
--   - A manual cost-ledger entry (…cl0001) so ADMIN-13 cost-ledger view renders a row
--
-- NOTE: the daily-plan review (ADMIN-08) reuses the MECH-09 self-contained flow;
-- region/branch/equipment/user CRUD (ADMIN-01..05) create their own rows in-spec.
BEGIN;

SELECT set_config('app.current_org', '00000000-0000-0000-0000-0000000000a1', true);

-- ADMIN-13 rental quote: the seed-mech source equipment needs financial value
-- attributes (vehicle/residual value) or the quote computation rejects it with
-- "equipment vehicle value is required".
UPDATE registry_equipment
  SET vehicle_value = 30000000, residual_value = 20000000,
      asset_registered_on = CURRENT_DATE - 365
WHERE id = '00000000-0000-0000-0000-000000ee0003';

\set org_id       '00000000-0000-0000-0000-0000000000a1'
\set branch_id    '00000000-0000-0000-0000-0000000000c1'
\set mech_id      '00000000-0000-0000-0000-0000000d0002'
\set admin_id     '00000000-0000-0000-0000-0000000d0003'
\set sadmin_id    '00000000-0000-0000-0000-0000000d0005'
\set mech2_id     '00000000-0000-0000-0000-0000000d0006'
\set equip_id     '00000000-0000-0000-0000-000000ee0003'
\set spare_id     '00000000-0000-0000-0000-000000ee0006'
\set cust_id      '00000000-0000-0000-0000-000000ee0001'
\set site_id      '00000000-0000-0000-0000-000000ee0002'

-- ─────────────────────────────────────────────────────────────────────────────
-- A second MECHANIC so the multi-mechanic assign control has 2 candidates.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO users (id, display_name, roles, org_id) VALUES
  (:'mech2_id', 'E2E Mechanic 2', ARRAY['MECHANIC'], :'org_id')
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_branches (user_id, branch_id, org_id)
VALUES (:'mech2_id', :'branch_id', :'org_id')
ON CONFLICT (user_id, branch_id) DO NOTHING;

-- A PREVENTION-team mechanic (team='예방') for ADMIN-10 inspection scheduling:
-- the inspection adapter only accepts an active 예방 MECHANIC in the branch.
INSERT INTO users (id, display_name, team, roles, org_id) VALUES
  ('00000000-0000-0000-0000-0000000d0007', 'E2E Prevention', '예방', ARRAY['MECHANIC'], :'org_id')
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_branches (user_id, branch_id, org_id)
VALUES ('00000000-0000-0000-0000-0000000d0007', :'branch_id', :'org_id')
ON CONFLICT (user_id, branch_id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- ADMIN-07: two REPORT_SUBMITTED work orders awaiting approval (approve + reject).
-- A submitted report needs result_type + diagnosis + action_taken populated.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO work_orders (
  id, request_no, branch_id, equipment_id, customer_id, site_id,
  requested_by, status, priority, symptom,
  result_type, diagnosis, action_taken, report_submitted_by, report_submitted_at,
  org_id
)
VALUES (
  '00000000-0000-0000-0000-000000f00007',
  to_char(CURRENT_DATE, 'YYYYMMDD') || '-071',
  :'branch_id', :'equip_id', :'cust_id', :'site_id',
  :'mech_id', 'REPORT_SUBMITTED', 'P2', '승인 대상 작업 (E2E-07A)',
  'COMPLETED', '엔진 점검 완료', '부품 교체 후 정상화', :'mech_id', now(),
  :'org_id'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_order_assignments (id, work_order_id, mechanic_id, role, assigned_at, org_id)
VALUES ('00000000-0000-0000-0000-000000a00007', '00000000-0000-0000-0000-000000f00007', :'mech_id', 'PRIMARY', now(), :'org_id')
ON CONFLICT (id) DO NOTHING;

-- Approval line for the approve-target WO: mechanic step APPROVED, admin step
-- PENDING (so the admin's approve transitions it), executive step NOT_STARTED.
-- This mirrors the state a real report-submit leaves behind.
INSERT INTO work_order_approval_steps (work_order_id, step_order, role, approver_id, status, requested_at, approved_at, approved_by_id, org_id)
VALUES
  ('00000000-0000-0000-0000-000000f00007', 1, 'MECHANIC',  :'mech_id', 'APPROVED', now(), now(), :'mech_id', :'org_id'),
  ('00000000-0000-0000-0000-000000f00007', 2, 'ADMIN',     NULL,       'PENDING',  now(), NULL, NULL,        :'org_id'),
  ('00000000-0000-0000-0000-000000f00007', 3, 'EXECUTIVE', NULL,       'NOT_STARTED', NULL, NULL, NULL,     :'org_id')
ON CONFLICT (work_order_id, step_order) DO NOTHING;

INSERT INTO work_orders (
  id, request_no, branch_id, equipment_id, customer_id, site_id,
  requested_by, status, priority, symptom,
  result_type, diagnosis, action_taken, report_submitted_by, report_submitted_at,
  org_id
)
VALUES (
  '00000000-0000-0000-0000-000000f00008',
  to_char(CURRENT_DATE, 'YYYYMMDD') || '-072',
  :'branch_id', :'equip_id', :'cust_id', :'site_id',
  :'mech_id', 'REPORT_SUBMITTED', 'P2', '반려 대상 작업 (E2E-07B)',
  'INCOMPLETE', '추가 점검 필요', '임시 조치만 수행', :'mech_id', now(),
  :'org_id'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_order_assignments (id, work_order_id, mechanic_id, role, assigned_at, org_id)
VALUES ('00000000-0000-0000-0000-000000a00008', '00000000-0000-0000-0000-000000f00008', :'mech_id', 'PRIMARY', now(), :'org_id')
ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- ADMIN-09: a RECEIVED P1 work order with a BROADCASTING dispatch so the dispatch
-- controls panel can set priority, request schedule-change, multi-assign, and
-- force-assign (force-assign requires an in-flight P1 dispatch).
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO work_orders (
  id, request_no, branch_id, equipment_id, customer_id, site_id,
  requested_by, status, priority, symptom, org_id
)
VALUES (
  '00000000-0000-0000-0000-000000f00009',
  to_char(CURRENT_DATE, 'YYYYMMDD') || '-091',
  :'branch_id', :'equip_id', :'cust_id', :'site_id',
  :'admin_id', 'RECEIVED', 'P1', 'P1 배차 제어 테스트 (E2E-09)', :'org_id'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO p1_dispatches (
  id, work_order_id, branch_id, status,
  accept_window_started_at, accept_window_ends_at,
  created_by, created_at, updated_at, org_id
)
VALUES (
  '00000000-0000-0000-0000-000000d10003',
  '00000000-0000-0000-0000-000000f00009',
  :'branch_id', 'BROADCASTING',
  now(), now() + interval '2 hours',
  :'admin_id', now(), now(), :'org_id'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO p1_dispatch_targets (
  id, dispatch_id, user_id, target_role, fanout_created_at, org_id
)
VALUES (
  '00000000-0000-0000-0000-000000d10004',
  '00000000-0000-0000-0000-000000d10003',
  :'mech_id', 'TECHNICIAN', now(), :'org_id'
)
ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- ADMIN-14: a 예비 (spare) equipment compatible with the seed-mech source
-- equipment (…ee0003: spec '15t/6m', ton_milli 15000, equipment_no 'EEEEE-0001'
-- → power code char[2]='E'). The spare must share the exact specification, power
-- code (equipment_no char[2]='E'), and tonnage so the candidate read ranks it as
-- an ExactTon match. Same branch.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO registry_equipment (
  id, branch_id, customer_id, site_id,
  equipment_no, management_no, model,
  manufacturer_code, kind_code, power_code,
  status, specification, ton_text, ton_milli,
  source_sheet, source_row, org_id
)
VALUES (
  :'spare_id', :'branch_id', :'cust_id', :'site_id',
  'AAEAA-0002', 'E2E-SPARE', 'E2E예비-15T',
  'E2E-MAKER', 'FORK', 'ELEC',
  '예비', '15t/6m', '15t', 15000,
  'e2e-seed', 2, :'org_id'
)
ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- ADMIN-13: an evidence_media row + a STATEMENT_ATTACHED purchase request so the
-- spec can deep-link the request and drive its approval workflow. A purchase
-- request needs a statement_evidence_id referencing a real evidence row.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO evidence_media (
  id, work_order_id, stage, s3_key, content_type, size_bytes,
  uploaded_by, worm_replica_status, org_id
)
-- The purchase-request create requires a VERIFIED REQUEST-stage evidence row as
-- the statement evidence, so seed it at stage 'REQUEST' with a verified replica.
VALUES (
  '00000000-0000-0000-0000-0000000ed001',
  '00000000-0000-0000-0000-000000f00003',
  'REQUEST', 'e2e/admin/statement-0001.pdf', 'application/pdf', 1024,
  :'admin_id', 'VERIFIED', :'org_id'
)
ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- ADMIN-13: a manual cost-ledger entry so the cost-ledger view renders a row.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO equipment_cost_ledger (
  id, equipment_id, branch_id, source, amount_won, memo,
  residual_before_won, residual_after_won, entry_at, created_by, org_id
)
VALUES (
  '00000000-0000-0000-0000-0000000cd001',
  :'equip_id', :'branch_id', 'MANUAL_ADMIN', 500000, 'E2E 원장 항목',
  20000000, 19500000, now(), :'admin_id', :'org_id'
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
