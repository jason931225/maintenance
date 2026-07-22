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

COMMIT;
