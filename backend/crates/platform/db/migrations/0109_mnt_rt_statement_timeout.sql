-- L20 audit-chain F2: bound every mnt_rt transaction below the seal watermark.
--
-- The audit-chain "no gaps by construction" invariant (charter §2.2) rests on
-- SEAL_LAG (60s) exceeding the maximum audited-transaction duration: a row is
-- only sealed once `created_at <= now() - SEAL_LAG`, so its transaction has
-- certainly committed. Post-merge review F2 found that bound DID NOT EXIST for
-- background writers — `mnt_rt` carried no statement_timeout (only the app's 30s
-- tower HTTP TimeoutLayer, which never covers the dispatch worker, workflow
-- drainer, mail sync, apalis, or the seal worker itself). A >60s background txn
-- could commit a row below an already-advanced cursor and make verify report a
-- FALSE-POSITIVE CoverageGap.
--
-- Fix: pin a role-level statement_timeout + idle_in_transaction_session_timeout
-- on `mnt_rt` at 30s — matching the HTTP layer and comfortably below SEAL_LAG.
-- No legitimate background transaction exceeds this: the drainer, schedule
-- poller, mail sync, and apalis dispatch are all per-item/per-bounded-batch
-- txns, and the seal worker caps one txn at SEAL_BATCH_MAX (500) rows of one
-- SELECT + one INSERT. If a long-running audited txn is ever genuinely needed,
-- raise BOTH this timeout and SEAL_LAG together (and prefer the xmin-snapshot
-- watermark the crate's ponytail comment names).
--
-- These are ROLE-DEFAULT GUCs applied when a session authenticates AS mnt_rt
-- (the production login role); a superuser session that merely `SET ROLE mnt_rt`
-- (the sqlx test harness) does NOT inherit them, so this does not perturb tests.

-- ALTER ROLE ... SET writes the cluster-global pg_db_role_setting tuple for
-- mnt_rt (pg_authid/pg_db_role_setting are shared catalogs, not per-database).
-- When sqlx::test applies every migration into N fresh databases in parallel,
-- concurrent writes to that one shared tuple race with "tuple concurrently
-- updated" (XX000). The advisory lock below is BEST-EFFORT ONLY, same caveat as
-- 0031: PostgreSQL advisory locks are scoped to the connecting session's
-- database (LOCKTAG_ADVISORY carries the database OID), so it does NOT
-- serialize writers connected to DIFFERENT databases — exactly what parallel
-- `#[sqlx::test]` does. The real guard is the exception handler below: whichever
-- racer's write commits is sufficient, because the setting is a single
-- cluster-wide role default, not a per-database value — a swallowed loser
-- changes nothing that the winner didn't already set. In production (one
-- migration applier, uncontended) both statements just succeed.
SELECT pg_advisory_xact_lock(hashtext('mnt_rt_role_setup'));

DO $$
BEGIN
    ALTER ROLE mnt_rt SET statement_timeout = '30s';
EXCEPTION
    WHEN internal_error THEN NULL; -- XX000 tuple-concurrently-updated race; see above
END
$$;

DO $$
BEGIN
    ALTER ROLE mnt_rt SET idle_in_transaction_session_timeout = '30s';
EXCEPTION
    WHEN internal_error THEN NULL; -- XX000 tuple-concurrently-updated race; see above
END
$$;
