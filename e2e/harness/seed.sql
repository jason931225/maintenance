-- E2E tenant fixtures: one tenant org (the migration-seeded KNL org) with one
-- user per tenant role + a region/branch + user_branches memberships. These rows
-- back the ROLE specs (RECEPTIONIST/MECHANIC/ADMIN/EXECUTIVE/SUPER_ADMIN). The
-- AUTH specs do NOT use these — they drive the real cold-start -> onboard ->
-- enroll chain against the PLATFORM admin seeded by the app at boot.
--
-- Connected as migration-only mnt_app (BYPASSRLS), so writes are not gated by RLS;
-- app.current_org is still armed to mirror the runtime tenant-scoping pattern
-- and to satisfy any FORCE-RLS WITH CHECK if the role ever changes.
BEGIN;

-- KNL Logistics tenant org id (seeded by migration 0028_backfill_org_id.sql).
SELECT set_config('app.current_org', '00000000-0000-0000-0000-0000000000a1', true);

-- Region + branch under the tenant.
INSERT INTO regions (id, name, org_id)
VALUES (
  '00000000-0000-0000-0000-0000000000b1',
  'E2E Region',
  '00000000-0000-0000-0000-0000000000a1'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO branches (id, region_id, name, org_id)
VALUES (
  '00000000-0000-0000-0000-0000000000c1',
  '00000000-0000-0000-0000-0000000000b1',
  'E2E Branch',
  '00000000-0000-0000-0000-0000000000a1'
)
ON CONFLICT (id) DO NOTHING;

-- One user per tenant role. Deterministic ids so specs can reference them.
INSERT INTO users (id, display_name, roles, org_id) VALUES
  ('00000000-0000-0000-0000-0000000d0001', 'E2E Receptionist', ARRAY['RECEPTIONIST'], '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000d0002', 'E2E Mechanic',     ARRAY['MECHANIC'],     '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000d0003', 'E2E Admin',        ARRAY['ADMIN'],        '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000d0004', 'E2E Executive',    ARRAY['EXECUTIVE'],    '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000d0005', 'E2E SuperAdmin',   ARRAY['SUPER_ADMIN'],  '00000000-0000-0000-0000-0000000000a1')
ON CONFLICT (id) DO NOTHING;

-- Branch memberships for every seeded user.
INSERT INTO user_branches (user_id, branch_id, org_id)
SELECT u.id, '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1'
FROM users u
WHERE u.id IN (
  '00000000-0000-0000-0000-0000000d0001',
  '00000000-0000-0000-0000-0000000d0002',
  '00000000-0000-0000-0000-0000000d0003',
  '00000000-0000-0000-0000-0000000d0004',
  '00000000-0000-0000-0000-0000000d0005'
)
ON CONFLICT (user_id, branch_id) DO NOTHING;

-- A bootstrap OTP for the tenant ADMIN so AUTH-06 can drive a TENANT session
-- (the cold-start admin is PLATFORM-tier and is rejected by tenant /api/* routes
-- like /api/v1/passkeys). token_hash = sha256('e2e-tenant-otp-000').
INSERT INTO auth_bootstrap_credentials (id, user_id, token_hash, issued_at, expires_at, org_id)
VALUES (
  '00000000-0000-0000-0000-00000000e001',
  '00000000-0000-0000-0000-0000000d0003',
  decode('9275f042001e5474c2a6f88b4660af9fba27919435cc8e5a547b68615577b1cf', 'hex'),
  now(),
  now() + interval '24 hours',
  '00000000-0000-0000-0000-0000000000a1'
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
