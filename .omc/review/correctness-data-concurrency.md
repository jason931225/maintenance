<!-- Source: codex gpt-5.5 adversarial correctness/data/concurrency review (read-only sandbox; report recovered from transcript bf3834uzn by lead). Findings 1-5 dispositioned into harden wave 2 (fix/harden-2); finding 6 (NULL branch_id reporting rollup) deferred for lead document+test. -->

# Correctness, Data & Concurrency Review

**Findings**
1. HIGH: `/sync` replay cache is not bound to the operation.
Evidence: [workorder/rest/src/lib.rs](/Users/jasonlee/Developer/maintenance/backend/crates/workorder/rest/src/lib.rs:1008) uses `ON CONFLICT (device_hash, request_id)`, then [workorder/rest/src/lib.rs](/Users/jasonlee/Developer/maintenance/backend/crates/workorder/rest/src/lib.rs:1032) selects only `response_body`; schema stores more fields but has `UNIQUE (device_hash, request_id)` at [0010_create_mobile_sync_devices.sql](/Users/jasonlee/Developer/maintenance/backend/crates/platform/db/migrations/0010_create_mobile_sync_devices.sql:23).
Fix: store/compare canonical payload hash plus `user_id`, `sync_id`, `operation_type`, `client_created_at`; reject mismatched replays and duplicate request IDs in-batch.

2. HIGH: `/sync` claim, mutation, completion are split across transactions.
Evidence: claim/execute/complete flow at [workorder/rest/src/lib.rs](/Users/jasonlee/Developer/maintenance/backend/crates/workorder/rest/src/lib.rs:750), business mutations call separate `with_audit` paths at [workorder/adapter-postgres/src/lib.rs](/Users/jasonlee/Developer/maintenance/backend/crates/workorder/adapter-postgres/src/lib.rs:370), completion is another `with_audit` at [workorder/rest/src/lib.rs](/Users/jasonlee/Developer/maintenance/backend/crates/workorder/rest/src/lib.rs:1071).
Fix: make sync operation recovery-capable in one transactional/outbox flow, or add stale-claim reconciliation that can finalize applied operations.

3. HIGH: WORM completion invariant can be invalidated after final completion.
Evidence: final approval uses `row.evidence_verified` from [workorder/adapter-postgres/src/lib.rs](/Users/jasonlee/Developer/maintenance/backend/crates/workorder/adapter-postgres/src/lib.rs:1338), but evidence upload inserts `PENDING` rows without parent status lock/check at [platform/storage/src/lib.rs](/Users/jasonlee/Developer/maintenance/backend/crates/platform/storage/src/lib.rs:1083); REST presign has no terminal-status guard at [workorder/rest/src/lib.rs](/Users/jasonlee/Developer/maintenance/backend/crates/workorder/rest/src/lib.rs:1178).
Fix: lock/check `work_orders` in the evidence insert transaction; reject `AFTER`/`REPORT` evidence for terminal work orders; add a DB trigger for non-REST writers.

4. HIGH: P1 alert delivery can double-send after retry/crash.
Evidence: pending alerts are selected before provider calls at [dispatch/adapter-postgres/src/lib.rs](/Users/jasonlee/Developer/maintenance/backend/crates/dispatch/adapter-postgres/src/lib.rs:445), sent at [dispatch/worker/src/lib.rs](/Users/jasonlee/Developer/maintenance/backend/crates/dispatch/worker/src/lib.rs:211), then marked with unconditional update at [dispatch/adapter-postgres/src/lib.rs](/Users/jasonlee/Developer/maintenance/backend/crates/dispatch/adapter-postgres/src/lib.rs:658).
Fix: claim alerts atomically before fanout using `SENDING` plus lease token or `FOR UPDATE SKIP LOCKED`; mark sent/failed only with the lease; pass stable provider idempotency keys.

5. MEDIUM: negative quote residual policy conflicts with DB schema.
Evidence: domain can keep negative `effective_residual` when flooring is false at [financial/domain/src/lib.rs](/Users/jasonlee/Developer/maintenance/backend/crates/financial/domain/src/lib.rs:173), insert binds it at [financial/adapter-postgres/src/lib.rs](/Users/jasonlee/Developer/maintenance/backend/crates/financial/adapter-postgres/src/lib.rs:884), but DB requires non-negative at [0015_create_financial.sql](/Users/jasonlee/Developer/maintenance/backend/crates/platform/db/migrations/0015_create_financial.sql:13).
Fix: always floor persisted quote residuals, or relax the DB check and add persistence tests for negative quote residuals.

6. MEDIUM: audited reporting tables permit/write `NULL branch_id`.
Evidence: branch non-null contract at [0001_create_regions_branches.sql](/Users/jasonlee/Developer/maintenance/backend/crates/platform/db/migrations/0001_create_regions_branches.sql:1); nullable `branch_id` at [0016_create_reporting_exports.sql](/Users/jasonlee/Developer/maintenance/backend/crates/platform/db/migrations/0016_create_reporting_exports.sql:4) and [0016_create_reporting_exports.sql](/Users/jasonlee/Developer/maintenance/backend/crates/platform/db/migrations/0016_create_reporting_exports.sql:22); adapter maps all/multi-branch scopes to `None` at [reporting/adapter-postgres/src/lib.rs](/Users/jasonlee/Developer/maintenance/backend/crates/reporting/adapter-postgres/src/lib.rs:1241).
Fix: model rollup scope explicitly while preserving branch-scoped rows, or document/test this as an intentional exception.

**Clean Dimensions**
Work-order FSM transitions, request number allocation, dispatch accept-window/auto-assign, ledger residual recompute, `with_audit`/`with_audits` atomicity, realtime mpsc/NOTIFY/replay, job enqueue idempotency, messenger persist-before-fanout, and append-only audit triggers all looked clean in the opened code.

Validation gap: no Cargo tests run because the workspace is read-only and Cargo would need build artifacts/locks.
