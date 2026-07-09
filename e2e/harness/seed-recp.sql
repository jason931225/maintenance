-- E2E seed data for RECEPTIONIST story specs.
-- Run as PG superuser (BYPASSRLS) against mnt_e2e, AFTER seed-mech.sql.
-- Idempotent via ON CONFLICT DO NOTHING.
--
-- The shared support ticket (…b00001) is branch-scoped and already visible to any
-- user in the branch (the receptionist included), so no extra support row is
-- needed. Messenger threads are membership-scoped, so the receptionist needs its
-- own thread to open and post into:
--   - A 'group' thread (…c00002) with the receptionist as OWNER + admin MEMBER.
BEGIN;

SELECT set_config('app.current_org', '00000000-0000-0000-0000-0000000000a1', true);

\set org_id    '00000000-0000-0000-0000-0000000000a1'
\set branch_id '00000000-0000-0000-0000-0000000000c1'
\set recp_id   '00000000-0000-0000-0000-0000000d0001'
\set admin_id  '00000000-0000-0000-0000-0000000d0003'

INSERT INTO messenger_threads (
  id, kind, visibility, branch_id, title, created_by, org_id
)
VALUES (
  '00000000-0000-0000-0000-000000c00002',
  'group',
  'direct',
  :'branch_id',
  'E2E 접수팀 대화',
  :'recp_id',
  :'org_id'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO messenger_thread_members (thread_id, user_id, role, joined_at, org_id)
VALUES
  ('00000000-0000-0000-0000-000000c00002', :'recp_id',  'OWNER',  now(), :'org_id'),
  ('00000000-0000-0000-0000-000000c00002', :'admin_id', 'MEMBER', now(), :'org_id')
ON CONFLICT (thread_id, user_id) DO NOTHING;

COMMIT;
