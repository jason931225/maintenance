-- Ephemeral mobile-CI session bootstrap.
--
-- The caller must generate a fresh OTP, retain the plaintext only in process
-- memory, and pass its lowercase SHA-256 digest as the psql variable
-- `otp_hash`. The database is recreated for every job; this credential exists
-- only long enough to mint the job-local mechanic session.

\set ON_ERROR_STOP on

\if :{?otp_hash}
\else
  DO $seed_error$ BEGIN
    RAISE EXCEPTION 'seed-mobile-ci: required psql variable otp_hash is missing';
  END $seed_error$;
\endif

SELECT :'otp_hash' ~ '^[0-9a-f]{64}$' AS otp_hash_valid \gset
\if :otp_hash_valid
\else
  DO $seed_error$ BEGIN
    RAISE EXCEPTION 'seed-mobile-ci: otp_hash must be a lowercase SHA-256 hex digest';
  END $seed_error$;
\endif

\if :{?fixture_profile}
\else
  DO $seed_error$ BEGIN
    RAISE EXCEPTION 'seed-mobile-ci: required psql variable fixture_profile is missing';
  END $seed_error$;
\endif

SELECT :'fixture_profile' IN ('full', 'accessibility-audit-one-row') AS fixture_profile_valid \gset
\if :fixture_profile_valid
\else
  DO $seed_error$ BEGIN
    RAISE EXCEPTION 'seed-mobile-ci: fixture_profile must be full or accessibility-audit-one-row';
  END $seed_error$;
\endif

SELECT :'fixture_profile' = 'accessibility-audit-one-row' AS accessibility_audit_one_row \gset

BEGIN;

SELECT set_config('app.current_org', '00000000-0000-0000-0000-0000000000a1', true);

-- Each test class receives the same mutable mobile fixture baseline. Keep this
-- scoped to ephemeral CI fixture rows: append-only audit_events are never
-- touched. Delete dependents first where current FK policy is RESTRICT.
DELETE FROM work_order_approval_steps
WHERE work_order_id IN (
  '00000000-0000-0000-0000-000000f00003',
  '00000000-0000-0000-0000-000000f00004',
  '00000000-0000-0000-0000-000000f00005'
);

DELETE FROM work_order_status_history
WHERE work_order_id IN (
  '00000000-0000-0000-0000-000000f00003',
  '00000000-0000-0000-0000-000000f00004',
  '00000000-0000-0000-0000-000000f00005'
);

-- Today is assignment-backed, and the shared admin fixture also assigns the
-- approval targets (…f00007/…f00008) to this mechanic. Reset the mechanic's
-- complete ephemeral assignment set so the selected profile is exact rather
-- than accidentally inheriting rows from an earlier seed.
DELETE FROM work_order_assignments
WHERE org_id = '00000000-0000-0000-0000-0000000000a1'
  AND mechanic_id = '00000000-0000-0000-0000-0000000d0002';

UPDATE work_orders
SET
  status = CASE id
    WHEN '00000000-0000-0000-0000-000000f00003' THEN 'ASSIGNED'
    ELSE 'IN_PROGRESS'
  END,
  result_type = 'UNKNOWN',
  diagnosis = NULL,
  action_taken = NULL,
  report_submitted_by = NULL,
  report_submitted_at = NULL,
  delay_reason = NULL,
  delay_note = NULL,
  kpi_excluded = false,
  evidence_verified = false,
  updated_at = now()
WHERE id IN (
  '00000000-0000-0000-0000-000000f00003',
  '00000000-0000-0000-0000-000000f00004',
  '00000000-0000-0000-0000-000000f00005'
);

\if :accessibility_audit_one_row
-- XCTest on iOS 26.5 exposes a platform List accessibility-frame defect when a
-- repeated row is only partially visible behind the floating tab-bar material.
-- Audit one representative production row without suppressing any audit type;
-- every functional shard receives and traverses the full five-row fixture.
INSERT INTO work_order_assignments (id, work_order_id, mechanic_id, role, assigned_at, org_id)
VALUES (
  '00000000-0000-0000-0000-000000a00002',
  '00000000-0000-0000-0000-000000f00004',
  '00000000-0000-0000-0000-0000000d0002',
  'PRIMARY', now(), '00000000-0000-0000-0000-0000000000a1'
);
\else
INSERT INTO work_order_assignments (id, work_order_id, mechanic_id, role, assigned_at, org_id)
VALUES
  (
    '00000000-0000-0000-0000-000000a00001',
    '00000000-0000-0000-0000-000000f00003',
    '00000000-0000-0000-0000-0000000d0002',
    'PRIMARY', now(), '00000000-0000-0000-0000-0000000000a1'
  ),
  (
    '00000000-0000-0000-0000-000000a00002',
    '00000000-0000-0000-0000-000000f00004',
    '00000000-0000-0000-0000-0000000d0002',
    'PRIMARY', now(), '00000000-0000-0000-0000-0000000000a1'
  ),
  (
    '00000000-0000-0000-0000-000000a00003',
    '00000000-0000-0000-0000-000000f00005',
    '00000000-0000-0000-0000-0000000d0002',
    'PRIMARY', now(), '00000000-0000-0000-0000-0000000000a1'
  ),
  (
    '00000000-0000-0000-0000-000000a00007',
    '00000000-0000-0000-0000-000000f00007',
    '00000000-0000-0000-0000-0000000d0002',
    'PRIMARY', now(), '00000000-0000-0000-0000-0000000000a1'
  ),
  (
    '00000000-0000-0000-0000-000000a00008',
    '00000000-0000-0000-0000-000000f00008',
    '00000000-0000-0000-0000-0000000d0002',
    'PRIMARY', now(), '00000000-0000-0000-0000-0000000000a1'
  );
\endif

SELECT CASE :'fixture_profile'
  WHEN 'full' THEN
    COUNT(*) = 5
    AND COUNT(*) FILTER (
      WHERE work_order_id IN (
        '00000000-0000-0000-0000-000000f00003',
        '00000000-0000-0000-0000-000000f00004',
        '00000000-0000-0000-0000-000000f00005',
        '00000000-0000-0000-0000-000000f00007',
        '00000000-0000-0000-0000-000000f00008'
      )
    ) = 5
  WHEN 'accessibility-audit-one-row' THEN
    COUNT(*) = 1
    AND COUNT(*) FILTER (
      WHERE work_order_id = '00000000-0000-0000-0000-000000f00004'
    ) = 1
  ELSE false
END AS fixture_profile_postcondition_valid
FROM work_order_assignments
WHERE org_id = '00000000-0000-0000-0000-0000000000a1'
  AND mechanic_id = '00000000-0000-0000-0000-0000000d0002' \gset
\if :fixture_profile_postcondition_valid
\else
  DO $seed_error$ BEGIN
    RAISE EXCEPTION 'seed-mobile-ci: fixture profile assignment postcondition failed';
  END $seed_error$;
\endif

-- Location collection rows are destructible fixture data. Ledger rows must be
-- removed before their consent because the current composite FK is RESTRICT.
DELETE FROM location_collection_logs
WHERE user_id = '00000000-0000-0000-0000-0000000d0002';

DELETE FROM location_pings
WHERE user_id = '00000000-0000-0000-0000-0000000d0002';

DELETE FROM location_consent_ledger
WHERE user_id = '00000000-0000-0000-0000-0000000d0002';

DELETE FROM location_consents
WHERE user_id = '00000000-0000-0000-0000-0000000d0002';

-- Read receipts use RESTRICT against the last message; remove them before
-- clearing every mutable message in the dedicated mobile CI thread. The fixed
-- initial message is recreated below.
DELETE FROM messenger_read_receipts
WHERE thread_id = '00000000-0000-0000-0000-000000c10001';

DELETE FROM messenger_messages
WHERE thread_id = '00000000-0000-0000-0000-000000c10001';

DELETE FROM auth_bootstrap_credentials
WHERE user_id = '00000000-0000-0000-0000-0000000d0002';

INSERT INTO auth_bootstrap_credentials (
  id,
  user_id,
  token_hash,
  issued_at,
  expires_at,
  org_id
) VALUES (
  '00000000-0000-0000-0000-00000e000002',
  '00000000-0000-0000-0000-0000000d0002',
  decode(:'otp_hash', 'hex'),
  now(),
  now() + interval '15 minutes',
  '00000000-0000-0000-0000-0000000000a1'
);

-- Isolated mobile-CI messenger fixture. This is deliberately distinct from
-- browser persona fixtures so the UI test can mutate and read it back without
-- coupling to another scenario's ordering or state.
INSERT INTO messenger_threads (
  id, kind, visibility, branch_id, title, created_by, org_id
) VALUES (
  '00000000-0000-0000-0000-000000c10001',
  'group',
  'direct',
  '00000000-0000-0000-0000-0000000000c1',
  'iOS CI 정비팀 대화',
  '00000000-0000-0000-0000-0000000d0002',
  '00000000-0000-0000-0000-0000000000a1'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO messenger_thread_members (thread_id, user_id, role, joined_at, org_id)
VALUES
  (
    '00000000-0000-0000-0000-000000c10001',
    '00000000-0000-0000-0000-0000000d0002',
    'OWNER',
    now(),
    '00000000-0000-0000-0000-0000000000a1'
  ),
  (
    '00000000-0000-0000-0000-000000c10001',
    '00000000-0000-0000-0000-0000000d0003',
    'MEMBER',
    now(),
    '00000000-0000-0000-0000-0000000000a1'
  )
ON CONFLICT (thread_id, user_id) DO NOTHING;

-- Keep the exact first message stable for audit assertions. Functional shards
-- additionally receive a realistic handoff sequence; the audit profile retains
-- only this first message so it can be positioned without competing rows.
\if :accessibility_audit_one_row
-- The audit profile deliberately has only the exact message selected by
-- AccessibilityAuditUITests. Functional classes retain the full handoff sequence.
INSERT INTO messenger_messages (
  id, thread_id, branch_id, sender_id, body, sent_at, org_id
) VALUES
  (
    '00000000-0000-0000-0000-000000c20001',
    '00000000-0000-0000-0000-000000c10001',
    '00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000d0003',
    'iOS CI 초기 메시지',
    now() - interval '8 minutes',
    '00000000-0000-0000-0000-0000000000a1'
  )
ON CONFLICT (id) DO NOTHING;
\else
INSERT INTO messenger_messages (
  id, thread_id, branch_id, sender_id, body, sent_at, org_id
) VALUES
  (
    '00000000-0000-0000-0000-000000c20001',
    '00000000-0000-0000-0000-000000c10001',
    '00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000d0003',
    'iOS CI 초기 메시지',
    now() - interval '8 minutes',
    '00000000-0000-0000-0000-0000000000a1'
  ),
  (
    '00000000-0000-0000-0000-000000c20002',
    '00000000-0000-0000-0000-000000c10001',
    '00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000d0002',
    '현장 점검을 시작했습니다. 상태 확인 후 공유하겠습니다.',
    now() - interval '7 minutes',
    '00000000-0000-0000-0000-0000000000a1'
  ),
  (
    '00000000-0000-0000-0000-000000c20003',
    '00000000-0000-0000-0000-000000c10001',
    '00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000d0003',
    '확인했습니다. 안전 절차와 작업 기록을 함께 남겨 주세요.',
    now() - interval '6 minutes',
    '00000000-0000-0000-0000-0000000000a1'
  ),
  (
    '00000000-0000-0000-0000-000000c20004',
    '00000000-0000-0000-0000-000000c10001',
    '00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000d0002',
    '설비 이력과 부품 재고를 확인 중입니다.',
    now() - interval '5 minutes',
    '00000000-0000-0000-0000-0000000000a1'
  ),
  (
    '00000000-0000-0000-0000-000000c20005',
    '00000000-0000-0000-0000-000000c10001',
    '00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000d0003',
    '부품 교체 전 사진과 측정값을 첨부해 주세요.',
    now() - interval '4 minutes',
    '00000000-0000-0000-0000-0000000000a1'
  ),
  (
    '00000000-0000-0000-0000-000000c20006',
    '00000000-0000-0000-0000-000000c10001',
    '00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000d0002',
    '점검 결과를 정리했습니다. 승인 후 작업을 계속하겠습니다.',
    now() - interval '3 minutes',
    '00000000-0000-0000-0000-0000000000a1'
  ),
  (
    '00000000-0000-0000-0000-000000c20007',
    '00000000-0000-0000-0000-000000c10001',
    '00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000d0003',
    '승인 대기 중입니다. 변경 사항이 있으면 이 대화에 남기겠습니다.',
    now() - interval '2 minutes',
    '00000000-0000-0000-0000-0000000000a1'
  ),
  (
    '00000000-0000-0000-0000-000000c20008',
    '00000000-0000-0000-0000-000000c10001',
    '00000000-0000-0000-0000-0000000000c1',
    '00000000-0000-0000-0000-0000000d0002',
    '다음 교대조에도 동일한 작업 맥락을 전달하겠습니다.',
    now() - interval '1 minute',
    '00000000-0000-0000-0000-0000000000a1'
  )
ON CONFLICT (id) DO NOTHING;
\endif

-- Both profiles must be exact: audit methods receive one representative Today
-- row and one exact Messenger message; functional methods receive all five
-- Today rows and all eight handoff messages.
SELECT CASE :'fixture_profile'
  WHEN 'full' THEN
    COUNT(*) = 8
    AND COUNT(*) FILTER (
      WHERE id IN (
        '00000000-0000-0000-0000-000000c20001',
        '00000000-0000-0000-0000-000000c20002',
        '00000000-0000-0000-0000-000000c20003',
        '00000000-0000-0000-0000-000000c20004',
        '00000000-0000-0000-0000-000000c20005',
        '00000000-0000-0000-0000-000000c20006',
        '00000000-0000-0000-0000-000000c20007',
        '00000000-0000-0000-0000-000000c20008'
      )
    ) = 8
  WHEN 'accessibility-audit-one-row' THEN
    COUNT(*) = 1
    AND COUNT(*) FILTER (
      WHERE id = '00000000-0000-0000-0000-000000c20001'
    ) = 1
  ELSE false
END AS fixture_profile_message_postcondition_valid
FROM messenger_messages
WHERE thread_id = '00000000-0000-0000-0000-000000c10001' \gset
\if :fixture_profile_message_postcondition_valid
\else
  DO $seed_error$ BEGIN
    RAISE EXCEPTION 'seed-mobile-ci: fixture profile message postcondition failed';
  END $seed_error$;
\endif

COMMIT;
