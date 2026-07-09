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
-- concurrent writers race on that one shared tuple ("tuple concurrently
-- updated", XX000) unless actually serialized.
--
-- `pg_advisory_xact_lock` does NOT serialize this, despite 0031 using it for an
-- analogous race: advisory locks are scoped to the CONNECTING SESSION'S
-- DATABASE, not the cluster — verified empirically (a lock held by a session in
-- database A does not block an identical lock request from a session in
-- database B; a real `FOR UPDATE` row lock on a shared catalog, by contrast,
-- does block cross-database). So the advisory lock is a no-op across parallel
-- `#[sqlx::test]` databases — exactly the case that matters here.
--
-- Lock the ACTUAL shared row instead: `pg_authid` is a genuinely global
-- catalog (one physical table, not per-database; it backs both role attributes
-- AND `pg_db_role_setting`'s role-default GUCs). `SELECT ... FOR UPDATE` against
-- mnt_rt's own row blocks a concurrent session in ANY database on the same
-- Postgres instance until this transaction commits (verified empirically:
-- session B in a different database timed out waiting on the row lock held by
-- session A in this database). This makes the ALTERs and the post-migration
-- assertion below genuinely race-free — no exception handler needed.
SELECT rolname FROM pg_authid WHERE rolname = 'mnt_rt' FOR UPDATE;

ALTER ROLE mnt_rt SET statement_timeout = '30s';
ALTER ROLE mnt_rt SET idle_in_transaction_session_timeout = '30s';

-- Post-migration assertion: confirm both GUCs actually landed on mnt_rt's
-- role-default settings, and fail the migration loudly if not. Safe to assert
-- unconditionally (no retry/tolerance needed) — the FOR UPDATE lock above
-- means no other session can be concurrently writing this row, so a genuine
-- ALTER failure can no longer silently defeat the F2 invariant.
DO $$
DECLARE
    settings TEXT[];
BEGIN
    SELECT drs.setconfig INTO settings
    FROM pg_db_role_setting drs
    JOIN pg_roles r ON r.oid = drs.setrole
    WHERE r.rolname = 'mnt_rt' AND drs.setdatabase = 0;

    IF settings IS NULL
        OR NOT EXISTS (SELECT 1 FROM unnest(settings) AS s WHERE s LIKE 'statement_timeout=%')
        OR NOT EXISTS (
            SELECT 1 FROM unnest(settings) AS s WHERE s LIKE 'idle_in_transaction_session_timeout=%'
        )
    THEN
        RAISE EXCEPTION
            'mnt_rt statement_timeout / idle_in_transaction_session_timeout did not land (pg_db_role_setting.setconfig = %) — F2 invariant not enforced',
            settings;
    END IF;
END
$$;
