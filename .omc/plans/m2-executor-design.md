# M2 Workflow Runtime Executor — Design (architect pass, 2026-07-04)

Blueprint for the M2 engine on branch `feat/workflow-engine-m2`. Substrate (spine 0077/0078, `cedar_pbac.rs`, Studio authoring, `with_org_conn`/`with_audits`) is sufficient — **no new runtime tables, no schema drift**.

## Crate placement (layer-boundary gate)
- `backend/crates/workflow/runtime/` (`mnt-workflow-runtime`) — APPLICATION layer: FSM, node interpreter, idempotency-key derivation, Cedar `AuthorizationRequest` builder, pure advance logic. **Must NOT depend on sqlx/axum/tokio** — DB access via a port trait. Depends on `mnt-workflow-domain` (new, thin enums/transition tables), `mnt-platform-authz`, `mnt-kernel-core`.
- `backend/crates/workflow/adapter-postgres/` (`mnt-workflow-runtime-adapter-postgres`) — ADAPTER: implements the port over `with_audits`/`with_org_conn`; only place touching spine tables + sqlx.
- Worker loop + strangler wiring live in `backend/app/src/`; the advance call is invoked from `mnt-workorder-rest` behind the flag. Every crate: `edition.workspace`, `mnt-` prefix, `publish=false`, `[lints] workspace=true`.

## 3 REAL GAPS (must close, not assume away)
1. **No per-tenant feature-flag store** anywhere. → new tiny `org_runtime_flags(org_id, flag_key, enabled, updated_by, updated_at)` table, RLS `org_isolation` + `mnt_rt` grants (pattern of 0074:114-138). NOT a spine table, so `check-workflow-runtime-spine.mjs` doesn't forbid it. Read inside strangler's `with_org_conn`.
2. **`Principal` carries NO `SubjectFreshness`** (`authz/src/lib.rs:509-524`; `resolve_principal` never sets it). Cedar `cedar_precondition_denial` (`cedar_pbac.rs:662-693`) denies `MissingSubjectFreshness` → **all Cedar modes unreachable until freshness is sourced (JWT claims / subject-version table)**.
3. **`definition` JSONB has no node/edge graph** (`workflow_studio.rs:1644-1666` validates only `schema_version` + optional `policy_decision`). → define the node graph INSIDE `definition` under a bumped `schema_version` (`wf.exec.v1`), reusing existing JSONB + sidecar arrays (0069:36-39). No migration.

## CRITICAL: start Cedar as `LegacyOnly`, NOT `cedar_shadow_legacy_enforce`
`cedar_required(mode)` is true for shadow-enforce; with Cedar inert (`NotConfigured`), the boundary returns `deny(BundleUnavailable)` BEFORE consulting legacy (`cedar_pbac.rs:600-604,746-752`). **Enrolling workflow in `cedar_shadow_legacy_enforce` today denies EVERY transition (dead on arrival).** So the coexistence-map entry `domain="workflow.node_transition"` starts at `DualEngineMode::LegacyOnly` (delegates to the current role-matrix `evaluate_legacy_contract`) and still emits full audit via `observe_cedar_pbac_decision`. Flip to shadow→compare→cedar_only only AFTER the cedar-policy crate + compiled bundle exist AND Principal carries freshness (step 8, separate charter; re-verify cedar-policy `=4.11.2` live).

## Advance model
- **Sync-in-request** advance up to first WAITING/terminal node (preserves legacy UX — immediate feedback like `workorder/rest:2944`).
- **DB-poll background worker** (`AppRole::Worker`, `tokio::interval` like `mail_sync::spawn` `app/src/lib.rs:990-996`) for outbox draining + crash recovery. **MUST re-enter `CURRENT_ORG.scope(org,…)` per run** (`request-context:19-21`) — a bare `tokio::spawn` doesn't inherit the task-local → unset GUC → RLS zero rows.
- **Locking via the spine's own `workflow_execution_locks`** (0077:164-179, `UNIQUE(org_id,lock_key)` atomic claim; "release" = `UPDATE expires_at=now()` since DELETE is trigger-blocked). Outbox claim: `WHERE status IN ('PENDING','FAILED') AND coalesce(next_attempt_at,created_at)<=now() FOR UPDATE SKIP LOCKED`. **NOT apalis** — substrate already has locks + outbox lease cols.

## Idempotency (3 levels, exactly-once)
- Run: `run:work_order:{work_order_id}:completion:v1` (UNIQUE org_id,idempotency_key 0077:34).
- Node: `node:{run_id}:{node_key}:{attempt}` (UNIQUE 0077:68,69). Retry = new row at attempt+1.
- Outbox: `outbox:{run_id}:{node_run_id}:{channel}:{logical}` e.g. `...:job:payroll_draft` (UNIQUE 0077:149).

## FSM → 0077 CHECKs
Run STARTING→RUNNING→WAITING⇄RUNNING→SUCCEEDED/FAILED/CANCELLED/DEAD_LETTERED. Node PENDING→RUNNING→WAITING→SUCCEEDED/FAILED/SKIPPED/CANCELLED. **Terminal transitions MUST set the timestamp** (`completed_at` 0077:39 / `failed_at` 0077:40 / node `finished_at` 0077:71 / waiting `completed_at` 0077:112) or the DB CHECK rejects. Never mutate a finished node backward (interpreter-enforced).

## Cedar guard (2 call sites)
Call `evaluate_cedar_pbac_boundary(&req, map_entry, cedar)` before (1) every business-mutating/side-effect node transition and (2) every waiting-task completion. Build `AuthorizationRequest` from SERVER data only: `action = Action::new(Feature::from_str(waiting_task.required_policy)?)` (unknown → deny); `resource = branch(org,branch_id,"work_order").with_resource_id(object_id)` from `workflow_runs.object_type/object_id`; `.with_rls_scope_proof(RlsScopeProof::runtime_role_guc(org))` (org must match principal+resource or `RlsBoundaryMismatch`). Worker-driven system nodes (terminal payroll) are audited but NOT per-request Cedar-guarded.

## Template: completion→approval→payroll
Node graph in `definition` JSONB: `mechanic_report`(object_gate) → `admin_approval`(human_task, required_policy=completion_review, assignee_role_key=admin) → `executive_approval`(human_task, executive) → `apply_completion`(object_mutation → work_order.FinalCompleted) → `emit_payroll`(outbox, channel=JOB). Mirrors legacy approval line (`workorder/adapter-postgres:631-649`) + adds payroll node. **Add `internal.jobs` connector to `ALLOWED_CONNECTORS`** (`workflow_studio.rs:38-56` has no JOB) or publish-validation rejects it.

## Strangler
In `mnt-workorder-rest` at the executive-approval→FinalCompleted seam (`workorder/adapter-postgres:633-635`): if `strangler_flag_enabled(org,"workflow_runtime_m2_strangler")` → runtime owns approval+completion+payroll; else legacy path. **Terminal `apply_completion` performs the work-order FinalCompleted mutation inside the runtime's own `with_audits` txn** (runtime becomes the writer — an accepted behavior shift, chosen over 2-txn non-atomicity for a money-adjacent path). Flag off = revert to legacy, no data migration.

## Payroll outbox linkage (exactly-once)
`emit_payroll` node inserts ONE `workflow_outbox_events` (channel=JOB) in the SAME `with_audits` txn as the node SUCCEEDED. Drainer creates a **`payroll_draft_runs`** row (0074:5-26) — NOT `build_employee_payroll_draft` (pure fn, zero callers/persistence, `payroll/domain:333`) — with `ON CONFLICT (org_id,period_start,period_end,source_label) DO NOTHING` (0074:22); lands `BLOCKED_LEGAL_GATE` (0074:11-13) so no payable calc without the legal gate. Replay → 0 rows → mark outbox DELIVERED (409 semantic). DEAD_LETTERED requires `dead_lettered_at`+`attempt_count>=1`+non-empty `error_payload` (0078:49-60).

## Audit
Every state change via `with_audits` (arms GUC + writes `audit_events` same txn). Adapter state-changers need `// mnt-gate: state-changing-handler` + AuditEvent or audit-coverage fails. Multi-write advances return `Vec<AuditEvent>` from one `with_audits` closure (atomic).

## Tests (authored + CI-verified; local cargo hook-disabled)
1. RLS-as-`mnt_rt` isolation (load-bearing — superuser masks broken reads); unset GUC → zero rows + rejected writes. 2. Idempotency/replay (one run, one node/attempt, one payroll draft). 3. FSM invariants (terminal sets timestamp; illegal transitions refused; DB CHECK rejects null-timestamp terminal). 4. Cedar fail-closed (LegacyOnly real allow/deny+audit; shadow+inert → BundleUnavailable; unknown policy → deny; org mismatch → RlsBoundaryMismatch). 5. E2E strangler both flag states. 6. `check:workflow-runtime-spine` still passes.

## Build sequencing (PR-sized, each CI-verifiable)
1. Crates + FSM (no DB) — layer-boundary + unit tests. 2. Adapter + arming — rls-arming/audit-coverage/tenant-isolation. 3. Cedar guard (LegacyOnly, hardcoded map entry, required_policy→Feature) — no new deps. 4. `org_runtime_flags` migration + read helper. 5. Outbox drainer + `payroll_draft_runs` idempotent creation. 6. Template + `internal.jobs` connector. 7. Strangler wiring in workorder-rest, E2E both flag states. 8. (Later/separate charter) Cedar activation: add cedar-policy dep, source SubjectFreshness, flip modes.

Cross-model codex review required before completion (per session norm).
