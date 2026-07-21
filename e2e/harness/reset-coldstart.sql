-- Fast per-test reset of the cold-start auth state (no full migrate).
--
-- Restores the "first boot" condition so every AUTH spec starts from the same
-- place: the PLATFORM cold-start admin has NO passkey and exactly one open,
-- unexpired bootstrap OTP whose hash is sha256('e2e-coldstart-otp-000'). Run as
-- migration-only mnt_app (BYPASSRLS), which the reset harness uses directly.
--
-- Idempotent: safe to run before every test.
BEGIN;

-- Arm the platform sentinel org so any RLS-forced reads/writes resolve.
SELECT set_config('app.current_org', '00000000-0000-0000-0000-00000000face', true);

-- Drop every enrolled passkey (platform AND tenant users) so each test re-enrolls
-- from "needs passkey setup". Tenant rows are FORCE-RLS, so arm the tenant org for
-- that delete too.
DELETE FROM auth_webauthn_credentials
WHERE user_id IN (
  SELECT id FROM users WHERE org_id = '00000000-0000-0000-0000-00000000face'
);
SELECT set_config('app.current_org', '00000000-0000-0000-0000-0000000000a1', true);
DELETE FROM auth_webauthn_credentials
WHERE user_id IN (
  SELECT id FROM users WHERE org_id = '00000000-0000-0000-0000-0000000000a1'
);
SELECT set_config('app.current_org', '00000000-0000-0000-0000-00000000face', true);

-- Clear any refresh-token families/tokens so a revoked-session test cannot bleed
-- into the next test (children first for the FK).
DELETE FROM auth_refresh_tokens;
DELETE FROM auth_refresh_token_families;

-- Clear the fixed-window auth rate-limit counters. In e2e every request shares
-- one origin with NO X-Forwarded-For, so the per-IP bucket is skipped and ALL
-- traffic collapses onto the single `global` bucket (cap 100/min/endpoint). Across
-- a ~1.5-min suite the `refresh`/`otp_redeem` global counters can cross 100 inside
-- one wall-clock window and start returning 429 — surfacing as spurious
-- "invalid/expired OTP" or an undefined refreshed token. Resetting per test keeps
-- each test's budget isolated and order-independent. Production is unaffected:
-- real clients have distinct IPs, so the per-IP cap (not the global one) governs.
DELETE FROM auth_rate_limit;

-- Clear bootstrap credentials and re-issue a single fresh, unexpired OTP for the
-- cold-start admin. token_hash = sha256('e2e-coldstart-otp-000').
DELETE FROM auth_bootstrap_credentials;

INSERT INTO auth_bootstrap_credentials (id, user_id, token_hash, issued_at, expires_at, org_id)
SELECT
  gen_random_uuid(),
  u.id,
  decode('b70e40e9a2845750b774741a8473b4dd8dcf30d89df977409a58afa948e10618', 'hex'),
  now(),
  now() + interval '1 hour',
  u.org_id
FROM users u
WHERE u.org_id = '00000000-0000-0000-0000-00000000face'
ORDER BY u.created_at
LIMIT 1;

-- Re-issue the TENANT ADMIN bootstrap OTP (sha256('e2e-tenant-otp-000')) used by
-- AUTH-06's tenant session.
INSERT INTO auth_bootstrap_credentials (id, user_id, token_hash, issued_at, expires_at, org_id)
VALUES (
  '00000000-0000-0000-0000-00000000e001',
  '00000000-0000-0000-0000-0000000d0003',
  decode('9275f042001e5474c2a6f88b4660af9fba27919435cc8e5a547b68615577b1cf', 'hex'),
  now(),
  now() + interval '24 hours',
  '00000000-0000-0000-0000-0000000000a1'
);

COMMIT;
