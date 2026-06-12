# Harden wave 2 — correctness/data/concurrency review fixes (confirmed)

Same Hard Rules as m0-wave1.md. Strict clippy -D warnings required. Migration number if needed: **0020** (0018=inspection T6.4, 0019=consent T2.2 reserved — do NOT reuse).

### FIX 1 [HIGH] — /sync replay cache not bound to the operation payload
backend/crates/workorder/rest/src/lib.rs (~1008 ON CONFLICT (device_hash,request_id); ~1032 selects only response_body). Migration 0010 keys idempotency on (device_hash, request_id) only. A client reusing a request_id with a DIFFERENT payload silently gets the old cached response (or a genuinely different op is dropped).
- Store a canonical payload hash (sha256 of normalized {user_id, sync_id, operation_type, client_created_at, payload}) on the sync row; on replay, if (device_hash, request_id) matches but the payload hash DIFFERS → reject with a clear 409-class error (request_id reuse with different content), do NOT return the stale response. Also reject duplicate request_ids WITHIN one batch.
- Tests: same request_id + same payload → cached response returned (idempotent); same request_id + different payload → rejected; duplicate request_id in one batch → rejected.

### FIX 2 [HIGH] — /sync claim/mutation/completion split across transactions (crash recovery gap)
Same file ~750 (claim), workorder/adapter ~370 (mutation in its own with_audit tx), rest ~1071 (completion mark). A crash between mutation-commit and completion-mark leaves a claimed-but-incomplete sync row; a retry returns an incomplete/empty cached response.
- Make the sync operation recovery-capable: either (a) single transaction spanning claim→mutate→complete, or (b) stale-claim reconciliation — on replay of a claimed-but-incomplete row, detect whether the business mutation actually applied (idempotent check on the target WO state) and finalize/re-derive the response rather than returning an incomplete one. Pick the simpler correct option; justify.
- Tests: simulate a crash (claim+mutate committed, completion NOT) → retry produces the correct final response, no double-mutation.

### FIX 3 [HIGH] — WORM completion invariant invalidatable after FINAL_COMPLETED
final approval reads row.evidence_verified (workorder/adapter ~1338), but evidence upload inserts PENDING rows with no parent-status check (platform/storage ~1083) and presign has no terminal-status guard (workorder/rest ~1178). New AFTER/REPORT evidence can be attached to an already-FINAL_COMPLETED WO → retroactively unverified evidence on a closed WO.
- Reject AFTER/REPORT-stage evidence presign+insert for work orders in a terminal status (FINAL_COMPLETED/ARCHIVED/CANCELLED): lock+check the work_orders row status inside the evidence insert tx; return a clear error.
- Defense-in-depth: a DB trigger (migration 0020) rejecting AFTER/REPORT evidence_media insert when the parent WO is terminal (covers non-REST writers).
- Tests: presign/upload AFTER evidence on a FINAL_COMPLETED WO → rejected at both REST and DB-trigger layers.

### FIX 4 [HIGH] — P1 alert delivery double-send after retry/crash (emergency path)
dispatch/adapter ~445 selects pending alerts before provider calls; worker ~211 sends; adapter ~658 marks sent unconditionally. Worker crash after send, before mark → retry re-sends (duplicate push/Alimtalk on an EMERGENCY).
- Claim alerts atomically before fanout: UPDATE ... SET status='SENDING', lease_token=$t, lease_expires=$exp WHERE status='PENDING' ... RETURNING (or SELECT ... FOR UPDATE SKIP LOCKED); send; mark SENT/FAILED only WHERE lease_token=$t. Pass a stable provider idempotency key (dispatch_id+alert_id) to FCM/Alimtalk so even a duplicate send dedups provider-side. Reclaim leases expired by crash.
- Tests: crash-after-send simulation → exactly one logical delivery / one SENT row; lease reclaim after expiry; idempotency key stable across retries.

### FIX 5 [HIGH-as-crash / MEDIUM-sev] — negative quote residual violates DB CHECK
financial/domain ~173: effective_residual stays negative when config.floor_negative_quote_residual=false; financial/adapter ~884 binds it to effective_residual_value_won which has CHECK (>=0) in migration 0015 → INSERT fails at runtime for a negative-잔존가 unit with flooring disabled (real data HAS negative 잔존가).
- Decide + implement: persisted effective_residual_value_won must ALWAYS be >= 0 (floor at persistence regardless of the flooring flag, but keep the flag's effect on the COMPUTED quote lines / record residual_was_floored), OR relax the DB CHECK and store the negative with explicit handling. Prefer flooring the PERSISTED residual to 0 with residual_was_floored=true while preserving the real current_residual_value_won (which has no >=0 check) for audit. Justify the choice.
- Tests: quote for a unit with negative current residual + flooring disabled → persists successfully (no DB error); residual_was_floored + current_residual_value reflect reality.

NOTE finding #6 (reporting nullable branch_id) is DEFERRED — it overlaps T6.4's in-flight reporting work and is likely an intentional company-rollup exception; lead will document+test it after T6.4 merges.

After all 5: full verification (fmt, strict clippy -D warnings, sqlx prepare --all-targets, cargo test, 4 gates, openapi-app + drift if routes/schemas change). Commit with evidence.
