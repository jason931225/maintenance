-- E2E seed data for MECHANIC story specs.
-- Run as migration-only mnt_app (BYPASSRLS) against mnt_e2e, AFTER seed.sql.
-- Idempotent via ON CONFLICT DO NOTHING / explicit id checks.
--
-- Provides:
--   - A registry_customer + registry_site + registry_equipment row (호기 #E2E-001)
--   - A RECEIVED/unassigned work order (e2e-wo-001) for MECH-01/02 self-assign
--   - A RECEIVED work order with a BROADCASTING P1 dispatch (e2e-wo-p1) for MECH-03/04
--   - An ASSIGNED work order (e2e-wo-start) for MECH-05 start
--   - An IN_PROGRESS work order (e2e-wo-report) for MECH-06 report
--   - A RECEIVED work order for MECH-08 intake verifying the 호기 autopull
--   - A support ticket (OPEN, INTERNAL) for MECH-12
--   - A messenger group thread with the mechanic + admin for MECH-11
--
-- NOTE: A fresh daily_work_plans row is NOT pre-seeded; MECH-09 creates one
-- during the test via the UI to keep the spec self-contained.
BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Constants
-- ─────────────────────────────────────────────────────────────────────────────
SELECT set_config('app.current_org', '00000000-0000-0000-0000-0000000000a1', true);

\set org_id       '00000000-0000-0000-0000-0000000000a1'
\set branch_id    '00000000-0000-0000-0000-0000000000c1'
\set mech_id      '00000000-0000-0000-0000-0000000d0002'
\set admin_id     '00000000-0000-0000-0000-0000000d0003'

-- ─────────────────────────────────────────────────────────────────────────────
-- Registry: customer, site, equipment
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO registry_customers (id, branch_id, name, org_id)
VALUES ('00000000-0000-0000-0000-000000ee0001', :'branch_id', 'E2E고객사', :'org_id')
ON CONFLICT (id) DO NOTHING;

INSERT INTO registry_sites (id, branch_id, customer_id, name, contact_name, contact_phone, org_id)
VALUES ('00000000-0000-0000-0000-000000ee0002', :'branch_id', '00000000-0000-0000-0000-000000ee0001', 'E2E사업장', '현장 담당자', '010-7777-8888', :'org_id')
ON CONFLICT (id) DO NOTHING;

-- Equipment with management_no #E2E-001 for 호기 autopull in intake/equipment lookup.
-- equipment_no must match ^[A-Z]{3}[A-Z0-9]{2}-[0-9]{4}$; status uses Korean values.
INSERT INTO registry_equipment (
  id, branch_id, customer_id, site_id,
  equipment_no, management_no, model,
  manufacturer_code, kind_code, power_code,
  status, specification, ton_text, ton_milli,
  source_sheet, source_row,
  org_id
)
VALUES (
  '00000000-0000-0000-0000-000000ee0003',
  :'branch_id',
  '00000000-0000-0000-0000-000000ee0001',
  '00000000-0000-0000-0000-000000ee0002',
  -- management_no is stored WITHOUT the leading '#': the master-import adapter
  -- and the equipment lookup/autocomplete both strip it (normalize_management_no
  -- → trim_start_matches('#')). Storing 'E2E-001' lets a user typing '#E2E-001'
  -- (normalized to 'E2E-001') match the exact-equality lookup.
  'EEEEE-0001',
  'E2E-001',
  'E2E모델-15T',
  'E2E-MAKER',
  'FORK',
  'ELEC',
  '임대',
  '15t/6m',
  '15t',
  15000,
  'e2e-seed',
  1,
  :'org_id'
)
ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- Work orders
-- ─────────────────────────────────────────────────────────────────────────────

-- MECH-01/02: RECEIVED unassigned work order (mechanic can self-assign)
INSERT INTO work_orders (
  id, request_no, branch_id, equipment_id, customer_id, site_id,
  requested_by, status, priority, symptom, org_id
)
VALUES (
  '00000000-0000-0000-0000-000000f00001',
  to_char(CURRENT_DATE, 'YYYYMMDD') || '-011',
  :'branch_id',
  '00000000-0000-0000-0000-000000ee0003',
  '00000000-0000-0000-0000-000000ee0001',
  '00000000-0000-0000-0000-000000ee0002',
  :'mech_id',
  'RECEIVED',
  'P2',
  '엔진 시동 불가 (E2E-01)',
  :'org_id'
)
ON CONFLICT (id) DO NOTHING;

-- MECH-03/04: RECEIVED work order with a BROADCASTING P1 dispatch
INSERT INTO work_orders (
  id, request_no, branch_id, equipment_id, customer_id, site_id,
  requested_by, status, priority, symptom, org_id
)
VALUES (
  '00000000-0000-0000-0000-000000f00002',
  to_char(CURRENT_DATE, 'YYYYMMDD') || '-012',
  :'branch_id',
  '00000000-0000-0000-0000-000000ee0003',
  '00000000-0000-0000-0000-000000ee0001',
  '00000000-0000-0000-0000-000000ee0002',
  :'admin_id',
  'RECEIVED',
  'P1',
  'P1 긴급 배차 테스트 (E2E-02)',
  :'org_id'
)
ON CONFLICT (id) DO NOTHING;

-- P1 dispatch targeting the mechanic (BROADCASTING, accept window 2h from now)
INSERT INTO p1_dispatches (
  id, work_order_id, branch_id, status,
  accept_window_started_at, accept_window_ends_at,
  created_by, created_at, updated_at, org_id
)
VALUES (
  '00000000-0000-0000-0000-000000d10001',
  '00000000-0000-0000-0000-000000f00002',
  :'branch_id',
  'BROADCASTING',
  now(),
  now() + interval '2 hours',
  :'admin_id',
  now(),
  now(),
  :'org_id'
)
ON CONFLICT (id) DO NOTHING;

-- Add mechanic as a dispatch target so the offers panel can find it
INSERT INTO p1_dispatch_targets (
  id, dispatch_id, user_id, target_role, fanout_created_at, org_id
)
VALUES (
  '00000000-0000-0000-0000-000000d10002',
  '00000000-0000-0000-0000-000000d10001',
  :'mech_id',
  'TECHNICIAN',
  now(),
  :'org_id'
)
ON CONFLICT (id) DO NOTHING;

-- MECH-05: ASSIGNED work order (mechanic is primary) — mechanic can start work
INSERT INTO work_orders (
  id, request_no, branch_id, equipment_id, customer_id, site_id,
  requested_by, status, priority, symptom, org_id
)
VALUES (
  '00000000-0000-0000-0000-000000f00003',
  to_char(CURRENT_DATE, 'YYYYMMDD') || '-013',
  :'branch_id',
  '00000000-0000-0000-0000-000000ee0003',
  '00000000-0000-0000-0000-000000ee0001',
  '00000000-0000-0000-0000-000000ee0002',
  :'mech_id',
  'ASSIGNED',
  'P2',
  '유압 오일 누유 (E2E-03)',
  :'org_id'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_order_assignments (id, work_order_id, mechanic_id, role, assigned_at, org_id)
VALUES (
  '00000000-0000-0000-0000-000000a00001',
  '00000000-0000-0000-0000-000000f00003',
  :'mech_id',
  'PRIMARY',
  now(),
  :'org_id'
)
ON CONFLICT (id) DO NOTHING;

-- MECH-06: IN_PROGRESS work order (mechanic is primary) — mechanic can submit report
INSERT INTO work_orders (
  id, request_no, branch_id, equipment_id, customer_id, site_id,
  requested_by, status, priority, symptom, org_id
)
VALUES (
  '00000000-0000-0000-0000-000000f00004',
  to_char(CURRENT_DATE, 'YYYYMMDD') || '-014',
  :'branch_id',
  '00000000-0000-0000-0000-000000ee0003',
  '00000000-0000-0000-0000-000000ee0001',
  '00000000-0000-0000-0000-000000ee0002',
  :'mech_id',
  'IN_PROGRESS',
  'P3',
  '배터리 방전 (E2E-04)',
  :'org_id'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO work_order_assignments (id, work_order_id, mechanic_id, role, assigned_at, org_id)
VALUES (
  '00000000-0000-0000-0000-000000a00002',
  '00000000-0000-0000-0000-000000f00004',
  :'mech_id',
  'PRIMARY',
  now(),
  :'org_id'
)
ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- Support ticket (OPEN, INTERNAL) for MECH-12
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO support_tickets (
  id, branch_id, origin, category, priority, status,
  title, body, requester_user_id, due_at, org_id
)
VALUES (
  '00000000-0000-0000-0000-000000b00001',
  :'branch_id',
  'INTERNAL',
  'OPERATIONAL',
  'MEDIUM',
  'OPEN',
  'E2E 지원 티켓 테스트',
  '정비 시스템 접근 권한 확인이 필요합니다.',
  :'mech_id',
  now() + interval '3 days',
  :'org_id'
)
ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- Messenger group thread with mechanic + admin for MECH-11
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO messenger_threads (
  id, kind, visibility, branch_id, title, created_by, org_id
)
VALUES (
  '00000000-0000-0000-0000-000000c00001',
  'group',
  'direct',
  :'branch_id',
  'E2E 정비팀 대화',
  :'mech_id',
  :'org_id'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO messenger_thread_members (thread_id, user_id, role, joined_at, org_id)
VALUES
  ('00000000-0000-0000-0000-000000c00001', :'mech_id',  'OWNER',  now(), :'org_id'),
  ('00000000-0000-0000-0000-000000c00001', :'admin_id', 'MEMBER', now(), :'org_id')
ON CONFLICT (thread_id, user_id) DO NOTHING;

COMMIT;
