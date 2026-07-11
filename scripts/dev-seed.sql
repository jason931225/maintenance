-- Local dev business-data seed for the KNL tenant (org …a1).
--
-- WHY THIS EXISTS: `dev-up.mjs` migrates the schema but seeds no business data,
-- so every console screen rendered 0-counts/empty for a fresh dev-auth session
-- (only the one stray support ticket a prior manual session left behind ever
-- surfaced). This file populates ONE realistic org-scoped story — KNL Logistics,
-- a 창원-based forklift fleet-maintenance operator — across every domain the
-- console's mounted screens read, so each screen shows REAL rows.
--
-- IDIOM: same as e2e/harness/seed*.sql — connected as the PG superuser
-- (BYPASSRLS), arm `app.current_org` to mirror runtime tenant-scoping and to
-- satisfy any FORCE-RLS WITH CHECK, deterministic all-hex ids, ON CONFLICT DO
-- NOTHING so re-runs are idempotent. NOT production ops (that goes through the
-- audited console API, per project policy) — this is local dev fixture tooling
-- only. The KNL tenant org row itself is migration-seeded (0028); everything
-- below is the tenant's operating data.

BEGIN;

SELECT set_config('app.current_org', '00000000-0000-0000-0000-0000000000a1', true);

-- ── org structure: one region, two branches ────────────────────────────────
INSERT INTO regions (id, name, org_id) VALUES
  ('00000000-0000-0000-0000-0000000000b1', '경남권역', '00000000-0000-0000-0000-0000000000a1')
ON CONFLICT (id) DO NOTHING;

INSERT INTO branches (id, region_id, name, org_id) VALUES
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b1', '창원 본사', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000b1', '부산 지점', '00000000-0000-0000-0000-0000000000a1')
ON CONFLICT (id) DO NOTHING;

-- ── users ───────────────────────────────────────────────────────────────────
-- d001 is the dev-auth SUPER_ADMIN principal. dev-auth upserts on
-- phone='dev-auth:{org}:{role}' (DevPrincipalProvisioner), so pre-seeding the
-- row with THIS id + phone makes the later `POST /dev-auth/session` mint
-- ON CONFLICT (phone) DO UPDATE the SAME row — the session's user_id stays d001,
-- so the "me"-scoped rows below (notifications, assigned tickets) surface.
INSERT INTO users (id, display_name, phone, roles, team, is_active, org_id, is_org_lead) VALUES
  ('00000000-0000-0000-0000-00000000d001', '개발 최고관리자', 'dev-auth:00000000-0000-0000-0000-0000000000a1:SUPER_ADMIN', ARRAY['SUPER_ADMIN'], '관리', true, '00000000-0000-0000-0000-0000000000a1', true),
  ('00000000-0000-0000-0000-00000000d002', '김정비', '01041110001', ARRAY['MECHANIC'], '정비', true, '00000000-0000-0000-0000-0000000000a1', false),
  ('00000000-0000-0000-0000-00000000d003', '박접수', '01041110002', ARRAY['RECEPTIONIST'], '접수', true, '00000000-0000-0000-0000-0000000000a1', false),
  ('00000000-0000-0000-0000-00000000d004', '이대표', '01041110003', ARRAY['EXECUTIVE'], '관리', true, '00000000-0000-0000-0000-0000000000a1', false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_branches (user_id, branch_id, org_id)
SELECT u, '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1'
FROM unnest(ARRAY[
  '00000000-0000-0000-0000-00000000d001'::uuid,
  '00000000-0000-0000-0000-00000000d002'::uuid,
  '00000000-0000-0000-0000-00000000d003'::uuid,
  '00000000-0000-0000-0000-00000000d004'::uuid]) u
ON CONFLICT (user_id, branch_id) DO NOTHING;

-- ── employees (roster → leave + policy 인원 count) ───────────────────────────
INSERT INTO employees (
  id, org_id, company, name, source_filename, source_sheet, source_row, source_key,
  raw_row, source_metadata, employment_status, employee_number, org_unit, job, position,
  worksite_name, hire_date, leave_accrued, leave_used, leave_remaining,
  identity_resolution_strategy, identity_resolution_confidence, identity_review_required, identity_name_only_merge
) VALUES
  ('00000000-0000-0000-0000-000000ee0001', '00000000-0000-0000-0000-0000000000a1', 'KNL로지스틱스', '김정비', 'roster_2026.xlsx', '정규직', 2, 'emp-1001', '{}'::jsonb, '{}'::jsonb, 'ACTIVE', '1001', '정비팀', '지게차 정비', '주임', '창원 본사', '2019-03-04', 15, 4, 11, 'employee_number', 'high', false, false),
  ('00000000-0000-0000-0000-000000ee0002', '00000000-0000-0000-0000-0000000000a1', 'KNL로지스틱스', '박접수', 'roster_2026.xlsx', '정규직', 3, 'emp-1002', '{}'::jsonb, '{}'::jsonb, 'ACTIVE', '1002', '접수팀', '고객 접수', '사원', '창원 본사', '2021-07-12', 15, 9, 6, 'employee_number', 'high', false, false),
  ('00000000-0000-0000-0000-000000ee0003', '00000000-0000-0000-0000-0000000000a1', 'KNL로지스틱스', '최현장', 'roster_2026.xlsx', '정규직', 4, 'emp-1003', '{}'::jsonb, '{}'::jsonb, 'ACTIVE', '1003', '정비팀', '현장 정비', '반장', '부산 지점', '2016-01-20', 20, 2, 18, 'employee_number', 'high', false, false),
  ('00000000-0000-0000-0000-000000ee0004', '00000000-0000-0000-0000-0000000000a1', 'KNL로지스틱스', '정관리', 'roster_2026.xlsx', '정규직', 5, 'emp-1004', '{}'::jsonb, '{}'::jsonb, 'ACTIVE', '1004', '관리팀', '운영 관리', '과장', '창원 본사', '2014-09-01', 22, 15, 7, 'employee_number', 'high', false, false)
ON CONFLICT (id) DO NOTHING;

-- ── leave: annual obligations + a couple of pending requests ─────────────────
INSERT INTO annual_leave_obligations (id, org_id, employee_id, leave_year, leave_accrued, leave_used, leave_remaining, status, statutory_basis, notification_plan) VALUES
  ('00000000-0000-0000-0000-000000a10001', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000ee0001', 2026, 15, 4, 11, 'NEEDS_HR_REVIEW', '{"law":"근로기준법 제60조"}'::jsonb, '{"stage":"none"}'::jsonb),
  ('00000000-0000-0000-0000-000000a10002', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000ee0002', 2026, 15, 9, 6, 'USAGE_PROMOTION_DRAFT_REQUIRED', '{"law":"근로기준법 제61조"}'::jsonb, '{"stage":"draft_required"}'::jsonb),
  ('00000000-0000-0000-0000-000000a10003', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000ee0003', 2026, 20, 2, 18, 'PROMOTION_SENT', '{"law":"근로기준법 제61조"}'::jsonb, '{"stage":"sent","sent_on":"2026-06-30"}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO leave_requests (id, org_id, branch_id, requester_user_id, subject_employee_id, leave_type, days, start_date, end_date, reason, status) VALUES
  ('00000000-0000-0000-0000-000000a20001', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000d002', '00000000-0000-0000-0000-000000ee0001', 'annual', 2, '2026-07-21', '2026-07-22', '개인 사유 연차 사용', 'pending'),
  ('00000000-0000-0000-0000-000000a20002', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-00000000d003', '00000000-0000-0000-0000-000000ee0003', 'half_day', 0.5, '2026-07-18', '2026-07-18', '오전 반차 (병원 방문)', 'pending')
ON CONFLICT (id) DO NOTHING;

-- ── registry chain (customer → site → equipment) backing work orders ─────────
INSERT INTO registry_customers (id, branch_id, name, org_id) VALUES
  ('00000000-0000-0000-0000-000000c00001', '00000000-0000-0000-0000-0000000000c1', '한성물류㈜', '00000000-0000-0000-0000-0000000000a1')
ON CONFLICT (id) DO NOTHING;

INSERT INTO registry_sites (id, branch_id, customer_id, name, org_id, address, province, city) VALUES
  ('00000000-0000-0000-0000-000000c10001', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000c00001', '한성물류 창원센터', '00000000-0000-0000-0000-0000000000a1', '경남 창원시 성산구 창원대로 1234', '경상남도', '창원시')
ON CONFLICT (id) DO NOTHING;

INSERT INTO registry_equipment (id, branch_id, customer_id, site_id, equipment_no, manufacturer_code, kind_code, power_code, status, specification, ton_text, source_sheet, source_row, org_id) VALUES
  ('00000000-0000-0000-0000-000000c20001', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000c00001', '00000000-0000-0000-0000-000000c10001', 'KNLFL-0001', 'DOOSAN', 'FORKLIFT', 'DIESEL', '임대', '디젤 지게차 2.5톤', '2.5톤', '장비대장', 2, '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-000000c20002', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000c00001', '00000000-0000-0000-0000-000000c10001', 'KNLFL-0002', 'HYUNDAI', 'FORKLIFT', 'ELECTRIC', '임대', '전동 지게차 1.5톤', '1.5톤', '장비대장', 3, '00000000-0000-0000-0000-0000000000a1')
ON CONFLICT (id) DO NOTHING;

-- ── work orders (dashboard KPI + ops summary + evidence parent) ──────────────
INSERT INTO work_orders (
  id, request_no, branch_id, equipment_id, customer_id, site_id, requested_by, status, priority,
  symptom, customer_request, result_type, kpi_excluded, evidence_verified, org_id
) VALUES
  ('00000000-0000-0000-0000-000000ad0001', '20260701-001', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000c20001', '00000000-0000-0000-0000-000000c00001', '00000000-0000-0000-0000-000000c10001', '00000000-0000-0000-0000-00000000d003', 'FINAL_COMPLETED', 'P2', '유압 실린더 누유', '리프트 하강 시 기름 누출', 'COMPLETED', false, true, '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-000000ad0002', '20260705-002', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000c20002', '00000000-0000-0000-0000-000000c00001', '00000000-0000-0000-0000-000000c10001', '00000000-0000-0000-0000-00000000d003', 'IN_PROGRESS', 'P1', '배터리 충전 불가', '전동 지게차 시동 불량', 'UNKNOWN', false, false, '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-000000ad0003', '20260708-003', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000c20001', '00000000-0000-0000-0000-000000c00001', '00000000-0000-0000-0000-000000c10001', '00000000-0000-0000-0000-00000000d003', 'ASSIGNED', 'P3', '경적 작동 불량', '경고음이 나지 않음', 'UNKNOWN', false, false, '00000000-0000-0000-0000-0000000000a1')
ON CONFLICT (id) DO NOTHING;

-- ── evidence media (docs screen) + lifecycle rows ────────────────────────────
INSERT INTO evidence_media (
  id, work_order_id, stage, s3_key, content_type, size_bytes, checksum_sha256, uploaded_by,
  worm_replica_status, retry_count, next_retry_at, verified_at, upload_confirmed_at, confirmed_by,
  org_id, processing_status
) VALUES
  ('00000000-0000-0000-0000-000000ed0001', '00000000-0000-0000-0000-000000ad0002', 'AFTER', 'evidence/knl/wo2-after.jpg', 'image/jpeg', 482013, encode(sha256('wo2-after'), 'hex'), '00000000-0000-0000-0000-00000000d002', 'VERIFIED', 0, now(), now(), now(), '00000000-0000-0000-0000-00000000d002', '00000000-0000-0000-0000-0000000000a1', 'READY'),
  ('00000000-0000-0000-0000-000000ed0002', '00000000-0000-0000-0000-000000ad0002', 'BEFORE', 'evidence/knl/wo2-before.jpg', 'image/jpeg', 391244, encode(sha256('wo2-before'), 'hex'), '00000000-0000-0000-0000-00000000d002', 'PENDING', 0, now(), NULL, now(), '00000000-0000-0000-0000-00000000d002', '00000000-0000-0000-0000-0000000000a1', 'READY')
ON CONFLICT (id) DO NOTHING;

INSERT INTO object_lifecycles (id, org_id, object_type, object_id, current_state, legal_hold) VALUES
  ('00000000-0000-0000-0000-0000001c0001', '00000000-0000-0000-0000-0000000000a1', 'work_order', '00000000-0000-0000-0000-000000ad0001', 'final_completed', false),
  ('00000000-0000-0000-0000-0000001c0002', '00000000-0000-0000-0000-0000000000a1', 'work_order', '00000000-0000-0000-0000-000000ad0002', 'in_progress', false)
ON CONFLICT (id) DO NOTHING;

-- ── policy roles + permissions + version (거버넌스 / 정책) ───────────────────
INSERT INTO policy_roles (id, org_id, role_key, display_name, description, status, is_system, created_by) VALUES
  ('00000000-0000-0000-0000-000000b00001', '00000000-0000-0000-0000-0000000000a1', 'branch_manager', '지점장', '지점 단위 운영 및 승인 권한', 'ACTIVE', false, '00000000-0000-0000-0000-00000000d001'),
  ('00000000-0000-0000-0000-000000b00002', '00000000-0000-0000-0000-0000000000a1', 'field_mechanic', '현장 정비원', '작업지시 처리 및 증빙 업로드', 'ACTIVE', false, '00000000-0000-0000-0000-00000000d001')
ON CONFLICT (id) DO NOTHING;

INSERT INTO policy_role_permissions (id, org_id, role_id, feature_key, permission_level) VALUES
  ('00000000-0000-0000-0000-000000bb0001', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000b00001', 'evidence_attach', 'allow'),
  ('00000000-0000-0000-0000-000000bb0002', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000b00002', 'evidence_attach', 'allow')
ON CONFLICT (id) DO NOTHING;

INSERT INTO policy_versions (org_id, version, updated_at) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 3, now())
ON CONFLICT (org_id) DO UPDATE SET version = EXCLUDED.version, updated_at = EXCLUDED.updated_at;

-- ── workflow studio definitions (자동화 / 워크플로) ──────────────────────────
INSERT INTO workflow_definitions (id, org_id, workflow_key, display_name, object_type, status, latest_version, active_version, created_by) VALUES
  ('00000000-0000-0000-0000-000000f00001', '00000000-0000-0000-0000-0000000000a1', 'work_order.approval', '작업지시 승인 흐름', 'work_order', 'ACTIVE', 1, 1, '00000000-0000-0000-0000-00000000d001'),
  ('00000000-0000-0000-0000-000000f00002', '00000000-0000-0000-0000-0000000000a1', 'leave.promotion', '연차 촉진 통보', 'leave_obligation', 'DRAFT', 1, NULL, '00000000-0000-0000-0000-00000000d001')
ON CONFLICT (id) DO NOTHING;

INSERT INTO workflow_definition_versions (
  id, org_id, definition_id, version, status, definition, approval_line, payment_line,
  notification_rules, action_allowlist, required_approval_line, required_payment_line, created_by
) VALUES
  ('00000000-0000-0000-0000-000000fa0001', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000f00001', 1, 'PUBLISHED', '{"nodes":[{"id":"start","type":"start"},{"id":"approve","type":"approval"},{"id":"end","type":"end"}]}'::jsonb, '[{"step":1,"role":"branch_manager"}]'::jsonb, '[]'::jsonb, '[]'::jsonb, '["work_order.complete"]'::jsonb, true, false, '00000000-0000-0000-0000-00000000d001'),
  ('00000000-0000-0000-0000-000000fa0002', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000f00002', 1, 'DRAFT', '{"nodes":[{"id":"start","type":"start"},{"id":"notify","type":"notification"},{"id":"end","type":"end"}]}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[{"channel":"in_app"}]'::jsonb, '[]'::jsonb, false, false, '00000000-0000-0000-0000-00000000d001')
ON CONFLICT (id) DO NOTHING;

-- ── ontology: one instance-backed object type + property defs + instances ────
INSERT INTO ont_object_types (id, org_id, stable_key, title, title_property_key, backing_kind, schema_version, lifecycle_state, created_by) VALUES
  ('00000000-0000-0000-0000-000000a70001', '00000000-0000-0000-0000-0000000000a1', 'maintenance_contract', '정비 계약', 'name', 'instance', 1, 'published', '00000000-0000-0000-0000-00000000d001')
ON CONFLICT (id) DO NOTHING;

INSERT INTO ont_property_defs (id, org_id, object_type_id, key, title, type, config, required, in_property_policy) VALUES
  ('00000000-0000-0000-0000-000000a80001', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000a70001', 'name', '계약명', 'string', '{}'::jsonb, true, false),
  ('00000000-0000-0000-0000-000000a80002', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000a70001', 'annual_fee_won', '연간 계약금(원)', 'number', '{}'::jsonb, false, false)
ON CONFLICT (id) DO NOTHING;

-- instances + genesis revision (hash chain: prev = 64 zeros, row = sha256 of attrs)
INSERT INTO ont_instances (id, org_id, object_type_id, title, current_revision_id, lifecycle_state) VALUES
  ('00000000-0000-0000-0000-000000a90001', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000a70001', '한성물류 연간 정비 계약', '00000000-0000-0000-0000-000000ab0001', 'active'),
  ('00000000-0000-0000-0000-000000a90002', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000a70001', '부산 지점 정기 점검 계약', '00000000-0000-0000-0000-000000ab0002', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO ont_instance_revisions (id, org_id, instance_id, version, attributes, valid_from, prev_hash, row_hash) VALUES
  ('00000000-0000-0000-0000-000000ab0001', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000a90001', 1, '{"name":"한성물류 연간 정비 계약","annual_fee_won":36000000}'::jsonb, now(), repeat('0', 64), encode(sha256('mc-001-v1'), 'hex')),
  ('00000000-0000-0000-0000-000000ab0002', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000a90002', 1, '{"name":"부산 지점 정기 점검 계약","annual_fee_won":18000000}'::jsonb, now(), repeat('0', 64), encode(sha256('mc-002-v1'), 'hex'))
ON CONFLICT (id) DO NOTHING;

-- ── finance GL vouchers (모듈 / 재무) ────────────────────────────────────────
INSERT INTO finance_gl_vouchers (id, org_id, branch_id, voucher_no, status, memo, created_by, approved_by, posted_at) VALUES
  ('00000000-0000-0000-0000-000000fc0001', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'GL-2026-0001', 'POSTED', '유압 실린더 부품 매입', '00000000-0000-0000-0000-00000000d003', '00000000-0000-0000-0000-00000000d004', now()),
  ('00000000-0000-0000-0000-000000fc0002', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'GL-2026-0002', 'DRAFT', '전동 지게차 배터리 교체 예정', '00000000-0000-0000-0000-00000000d003', NULL, NULL)
ON CONFLICT (id) DO NOTHING;

-- ── support tickets (지원 센터) — one assigned to the dev SUPER_ADMIN so the
--     overview action-inbox ("내 처리 대기") also surfaces a row. ─────────────
INSERT INTO support_tickets (id, branch_id, origin, category, priority, status, title, body, requester_name, requester_contact, assignee_user_id, org_id) VALUES
  ('00000000-0000-0000-0000-0000005c0001', '00000000-0000-0000-0000-0000000000c1', 'CUSTOMER', 'EQUIPMENT_INQUIRY', 'HIGH', 'OPEN', '지게차 시동 불량 문의', '전동 지게차가 아침부터 시동이 걸리지 않습니다.', '한성물류 김과장', '055-1234-5678', '00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000005c0002', '00000000-0000-0000-0000-0000000000c1', 'CUSTOMER', 'OPERATIONAL', 'MEDIUM', 'IN_PROGRESS', '정기 점검 일정 문의', '다음 달 정기 점검 일정을 조율하고 싶습니다.', '한성물류 이대리', 'lee@hansung.co.kr', '00000000-0000-0000-0000-00000000d003', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000005c0003', '00000000-0000-0000-0000-0000000000c2', 'CUSTOMER', 'COMPLAINT', 'URGENT', 'RESOLVED', '유압 누유 재발', '지난 번 수리한 부위에서 다시 누유가 발생했습니다.', '부산 창고 박팀장', '051-9876-5432', '00000000-0000-0000-0000-00000000d002', '00000000-0000-0000-0000-0000000000a1')
ON CONFLICT (id) DO NOTHING;

-- ── notifications (개요 / 알림) — recipient = dev SUPER_ADMIN (d001) ──────────
INSERT INTO notifications (id, org_id, recipient_user_id, category, kind, body, link, unread) VALUES
  ('00000000-0000-0000-0000-000000ce0001', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000d001', 'support', 'ticket_assigned', '새 지원 요청이 배정되었습니다: 지게차 시동 불량 문의', '{"type":"object","kind":"support_ticket","id":"00000000-0000-0000-0000-0000005c0001"}'::jsonb, true),
  ('00000000-0000-0000-0000-000000ce0002', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000d001', 'leave', 'approval_pending', '연차 신청 승인 대기: 김정비 (2일)', '{"type":"object","kind":"leave_request","id":"00000000-0000-0000-0000-000000a20001"}'::jsonb, true),
  ('00000000-0000-0000-0000-000000ce0003', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000d001', 'finance', 'voucher_posted', 'GL 전표가 전기되었습니다: GL-2026-0001', '{"type":"object","kind":"gl_voucher","id":"00000000-0000-0000-0000-000000fc0001"}'::jsonb, false)
ON CONFLICT (id) DO NOTHING;

COMMIT;
