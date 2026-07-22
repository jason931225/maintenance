-- Ephemeral mobile-CI session bootstrap.
--
-- The caller must generate a fresh OTP, retain the plaintext only in process
-- memory, and pass its lowercase SHA-256 digest as the psql variable
-- `otp_hash`. The database is recreated for every job; this credential exists
-- only long enough to mint the job-local mechanic session.

\if :{?otp_hash}
\else
  \echo 'seed-mobile-ci: required psql variable otp_hash is missing'
  \quit 1
\endif

SELECT :'otp_hash' ~ '^[0-9a-f]{64}$' AS otp_hash_valid \gset
\if :otp_hash_valid
\else
  \echo 'seed-mobile-ci: otp_hash must be a lowercase SHA-256 hex digest'
  \quit 1
\endif

BEGIN;

SELECT set_config('app.current_org', '00000000-0000-0000-0000-0000000000a1', true);

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

INSERT INTO messenger_messages (
  id, thread_id, branch_id, sender_id, body, sent_at, org_id
) VALUES (
  '00000000-0000-0000-0000-000000c20001',
  '00000000-0000-0000-0000-000000c10001',
  '00000000-0000-0000-0000-0000000000c1',
  '00000000-0000-0000-0000-0000000d0003',
  'iOS CI 초기 메시지',
  now() - interval '1 minute',
  '00000000-0000-0000-0000-0000000000a1'
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
