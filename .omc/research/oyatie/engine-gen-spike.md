# Engine-Gen Spike: M2 Workflow Engine Generalization for Oyatie Approvals

Verdict: **FEASIBLE**.

The M2 engine can be generalized into the Oyatie electronic-approval platform if Engine-Gen adds runtime instance/task REST, an approval-definition builder that emits `wf.exec.v1`, and task-completion storage/advance logic. The existing FSM does not need terminal reopening. 최종승인, 작성자/대행 종결, and 수령확인 must be `WAITING` human tasks before the run reaches `SUCCEEDED`; 사후 반려 must be a compensating AP/event linked to the finalized run.

## Evidence Baseline

- The console plan explicitly makes Engine-Gen the backend prerequisite for approvals and requires runtime REST, generalized approval-line DAGs, finalization/receipt as pre-terminal `WAITING` nodes, compensating 사후 반려, and `with_audit` on transitions (`.omc/plans/oyatie-console-plan.md:60`, `.omc/plans/oyatie-console-plan.md:62`, `.omc/plans/oyatie-console-plan.md:63`).
- The current Studio REST is authoring-only: catalog, definitions, history, simulate, publish, pause, rollback, and clone are the only registered surfaces (`backend/app/src/workflow_studio.rs:16`, `backend/app/src/workflow_studio.rs:31`, `backend/app/src/workflow_studio.rs:131`, `backend/app/src/workflow_studio.rs:168`).
- Current domain statuses already include non-terminal run `WAITING`, terminal run statuses, node `WAITING`, and waiting-task statuses (`backend/crates/workflow/domain/src/lib.rs:71`, `backend/crates/workflow/domain/src/lib.rs:81`, `backend/crates/workflow/domain/src/lib.rs:84`, `backend/crates/workflow/domain/src/lib.rs:107`).
- No edge leaves a terminal node, and tests lock that invariant (`backend/crates/workflow/domain/src/lib.rs:229`, `backend/crates/workflow/domain/src/lib.rs:245`, `backend/crates/workflow/domain/src/lib.rs:461`, `backend/crates/workflow/domain/src/lib.rs:478`).
- The runtime starts a run with audited `workflow_run.start` and `workflow_run.transition`, then processes nodes through `PENDING -> RUNNING -> final/WAITING` with a single atomic commit (`backend/crates/workflow/runtime/src/engine.rs:81`, `backend/crates/workflow/runtime/src/engine.rs:136`, `backend/crates/workflow/runtime/src/engine.rs:141`, `backend/crates/workflow/runtime/src/engine.rs:216`).
- Human tasks already park on `NewWaitingTask`, carrying `assignee_role_key`, `required_policy`, and `form_payload` (`backend/crates/workflow/runtime/src/interpreter.rs:28`, `backend/crates/workflow/runtime/src/interpreter.rs:95`, `backend/crates/workflow/runtime/src/interpreter.rs:105`).
- The adapter inserts waiting tasks as `OPEN` and commits them with node/run transition and audit rows under `with_audits` (`backend/crates/workflow/adapter-postgres/src/lib.rs:512`, `backend/crates/workflow/adapter-postgres/src/lib.rs:518`, `backend/crates/workflow/adapter-postgres/src/lib.rs:555`, `backend/crates/workflow/adapter-postgres/src/lib.rs:568`).
- Authorization must be phrased as policy-gated, legacy enforce, Cedar shadow: the guard is pinned to `DualEngineMode::LegacyOnly`, Cedar is `NotConfigured`, and the audit records the inert shadow detail (`backend/crates/workflow/runtime/src/authz_guard.rs:7`, `backend/crates/workflow/runtime/src/authz_guard.rs:14`, `backend/crates/workflow/runtime/src/authz_guard.rs:98`, `backend/crates/workflow/runtime/src/authz_guard.rs:110`).

## FSM Mechanism

M2 can express AP finalization without violating the terminal invariant:

1. `start-run` creates the run and advances `STARTING -> RUNNING`, using the existing start/transition semantics (`backend/crates/workflow/runtime/src/engine.rs:81`, `backend/crates/workflow/runtime/src/engine.rs:90`, `backend/crates/workflow/runtime/src/engine.rs:135`).
2. Each 검토/승인/합의/참조 step is a `human_task`. The interpreter parks on a `WAITING` task with role/policy metadata (`backend/crates/workflow/runtime/src/interpreter.rs:28`, `backend/crates/workflow/runtime/src/interpreter.rs:60`, `backend/crates/workflow/domain/src/lib.rs:356`).
3. Final approval is only another successful waiting-task decision. It does not close the run.
4. The definition builder emits an author-finalize `human_task` after the final approval node. If the document has legal receipt, it emits a receipt-confirmation `human_task` after finalize. Both keep the run pre-terminal.
5. Only the last required pre-terminal task transitions the run to `SUCCEEDED`; the domain only stamps terminal timestamps when transitioning into terminal run statuses (`backend/crates/workflow/domain/src/lib.rs:166`, `backend/crates/workflow/domain/src/lib.rs:185`, `backend/crates/workflow/adapter-postgres/src/lib.rs:293`, `backend/crates/workflow/adapter-postgres/src/lib.rs:320`).
6. 사후 반려 after finalization is not a mutation of the terminal run. It creates a compensating AP/document/event with a back-reference to the finalized run, because terminal run/node states have no legal outgoing edges (`backend/crates/workflow/domain/src/lib.rs:167`, `backend/crates/workflow/domain/src/lib.rs:174`, `backend/crates/workflow/domain/src/lib.rs:229`, `backend/crates/workflow/domain/src/lib.rs:245`).

Required audit mapping:

| Transition | Engine/API action | Audit event |
| --- | --- | --- |
| Run started | `POST /api/v1/workflow-runs` | `workflow_run.start`, then `workflow_run.transition` (`backend/crates/workflow/runtime/src/engine.rs:110`, `backend/crates/workflow/runtime/src/engine.rs:127`) |
| Human node parked | engine process node | `workflow_node.commit` with node `WAITING` (`backend/crates/workflow/runtime/src/engine.rs:192`, `backend/crates/workflow/runtime/src/engine.rs:203`) |
| Task claim | new task REST mutation | `workflow_task.claim` via `with_audit`, plus guard audit when required |
| Approve/reject/return | new task REST mutation | `workflow_task.decide` via `with_audit`, plus guard audit |
| Finalize/delegated finalize | new task REST mutation on finalize waiting task | `workflow_task.finalize` via `with_audit`, plus guard audit; delegated finalize requires reason |
| Receipt confirm | new task REST mutation on receipt waiting task | `workflow_task.receipt_confirm` via `with_audit` |
| Run terminal success | final advance | `workflow_run.transition` to `SUCCEEDED` (`backend/crates/workflow/runtime/src/engine.rs:127`, `backend/crates/workflow/adapter-postgres/src/lib.rs:407`) |
| Post-finalization rejection | compensating AP/event | `workflow_compensation.create_post_finalization_rejection`, linked to original run |

## Instance/Task REST Surface

Use the existing `/api/v1/...` shape and Studio error envelope: `{"error":{"code","message"}}` (`backend/app/src/workflow_studio.rs:16`, `backend/app/src/workflow_studio.rs:31`, `backend/app/src/workflow_studio.rs:2114`, `backend/app/src/workflow_studio.rs:2121`). Validation maps to 422, not found to 404, forbidden to 403, conflicts/invalid transitions to 409 (`backend/app/src/workflow_studio.rs:2084`, `backend/app/src/workflow_studio.rs:2091`). Mutations use `with_audit`/`with_audits`, matching Studio and runtime adapter practice (`backend/app/src/workflow_studio.rs:479`, `backend/app/src/workflow_studio.rs:588`, `backend/crates/workflow/adapter-postgres/src/lib.rs:323`, `backend/crates/workflow/adapter-postgres/src/lib.rs:437`).

| Endpoint | Request | Response | Semantics, errors, idempotency |
| --- | --- | --- | --- |
| `POST /api/v1/workflow-runs` | `{definition_id, definition_version?, object_type?, object_id?, trigger_type:"MANUAL"|"API", idempotency_key, correlation_id?, input_payload, context_payload?}` | `{run:{id,status,definition_id,definition_version,object_ref,initiated_by,created_at}, next_task?}` | Starts an active definition, inserts `STARTING`, advances to `RUNNING`, then advances synchronously until first `WAITING` or terminal node. `idempotency_key` is required and maps to `workflow_runs.idempotency_key` (`backend/crates/workflow/domain/src/lib.rs:288`, `backend/crates/workflow/domain/src/lib.rs:306`). Replay returns the existing run; mismatch on same key returns 409. Unknown/inactive definition 404/409; validation 422; authorization 403. |
| `GET /api/v1/workflow-tasks?role_key=&status=OPEN` | Query only | `{items:[{task_id,run_id,waiting_key,title,assignee_role_key,required_policy,object_ref,due_at,claimed_by?,status,form_payload}]}` | Lists waiting tasks by role for group inboxes. Role filtering uses `assignee_role_key`; tasks are policy-gated (legacy enforce, Cedar shadow) before rendering. Deny-by-omission means forbidden rows are absent, not returned as locked rows. |
| `GET /api/v1/workflow-tasks?assignee=me&status=OPEN,CLAIMED` | Query only | Same item shape | Personal approval inbox. Returns `OPEN` tasks claimable by the user and `CLAIMED` tasks assigned to the user. The table has `OPEN` and `CLAIMED` states already (`backend/crates/workflow/domain/src/lib.rs:97`, `backend/crates/workflow/domain/src/lib.rs:106`). |
| `GET /api/v1/workflow-runs/mine?status=&object_type=&q=` | Query only | `{items:[{run_id,code?,definition,object_ref,status,initiated_by,started_at,updated_at,current_step,finalized_at?,closed_at?}]}` | Submission box. Filters runs where `initiated_by = principal.user_id` using the existing run field (`backend/crates/workflow/domain/src/lib.rs:292`, `backend/crates/workflow/domain/src/lib.rs:306`). Final-approved but not finalized runs remain visible because they are still non-terminal. |
| `POST /api/v1/workflow-tasks/{task_id}/claim` | `{idempotency_key}` | `{task:{...status:"CLAIMED",claimed_by,claimed_at}}` | Claims an `OPEN` task. If already claimed by the same user, replay returns 200. If claimed by another user, return 409. If terminal/cancelled/expired, return 409. Policy denial is 403. Audit `workflow_task.claim`. |
| `POST /api/v1/workflow-tasks/{task_id}/decide` | `{decision:"approve"|"reject"|"return", comment?, idempotency_key}` | `{task:{status:"APPROVED"|"REJECTED"}, run:{status}, next_task?}` | Completes a non-finalize waiting task. `reject` and `return` require non-empty `comment`; `approve` accepts optional comment. `return` is a business-level rejection/return with comment and should land the waiting task in `REJECTED` while the AP document records `returned`; if the template needs resubmission, the builder creates a compensating/resubmission run, not a terminal reopen. Replays by `idempotency_key` return the recorded result. Invalid decision/comment returns 422; stale status 409; policy denial 403. Audit `workflow_task.decide`. |
| `POST /api/v1/workflow-tasks/{task_id}/finalize` | `{mode:"author"|"delegate", reason?, idempotency_key}` | `{task:{status:"APPROVED"}, run:{status:"WAITING"|"SUCCEEDED"}, archive_ref?}` | Only valid on a finalization waiting task. `mode:"author"` requires initiator/owner. `mode:"delegate"` is policy-gated (legacy enforce, Cedar shadow) and requires `reason`. If a receipt node follows, run remains `WAITING`; otherwise it may transition to `SUCCEEDED`. Replay returns the same result. Non-finalize task 422; missing delegated reason 422; stale status 409; policy denial 403. Audit `workflow_task.finalize`. |

The REST layer must add task-completion persistence not present in the current domain port. Today the domain can create waiting tasks but has no port method for claim/decide/finalize completion (`backend/crates/workflow/domain/src/lib.rs:388`, `backend/crates/workflow/domain/src/lib.rs:409`). That is an implementation gap, not a structural blocker.

## Generalized Approval-Line Definition Builder

The builder should translate the eight approval templates from the prototype inventory into `wf.exec.v1` graphs. The prototype has eight AP templates, template-specific reason enums, link requirements, and default approval lines (`.omc/research/oyatie/logic-inventory.md:17`, `.omc/research/oyatie/logic-inventory.md:23`, `.omc/research/oyatie/logic-inventory.md:47`). Compose requirements also require object targets and enum reasons (`docs/design/oyatie-console/DESIGN.md:114`, `docs/design/oyatie-console/DESIGN.md:116`).

Current `wf.exec.v1` validation already accepts `object_gate`, `object_mutation`, `human_task`, and `job` nodes and requires human-task `assignee_role_key` (`backend/app/src/workflow_studio.rs:1659`, `backend/app/src/workflow_studio.rs:1670`, `backend/app/src/workflow_studio.rs:1688`, `backend/app/src/workflow_studio.rs:1728`). The seeded completion template proves the pattern: gate, human approvals, object mutation, and job edge sequence (`backend/app/src/workflow_studio.rs:2157`, `backend/app/src/workflow_studio.rs:2203`).

Builder output shape:

```json
{
  "schema_version": "wf.exec.v1",
  "workflow_key": "approval.leave",
  "object_type": "approval_document",
  "approval_template": "leave",
  "reason_enum": ["annual", "half_day", "promotion_notice"],
  "linked_objects": [{"kind": "attendance_schedule", "required": true}],
  "nodes": [
    {"node_key": "submit", "node_type": "object_gate"},
    {"node_key": "review.hr", "node_type": "human_task", "assignee_role_key": "hr_reviewer", "required_policy": "approval_review"},
    {"node_key": "approve.manager", "node_type": "human_task", "assignee_role_key": "manager_approver", "required_policy": "approval_decide"},
    {"node_key": "finalize.author", "node_type": "human_task", "assignee_role_key": "initiator", "required_policy": "approval_finalize"},
    {"node_key": "receipt.target", "node_type": "human_task", "assignee_role_key": "receipt_subject", "required_policy": "approval_receipt"}
  ],
  "edges": [
    {"from": "submit", "to": "review.hr"},
    {"from": "review.hr", "to": "approve.manager"},
    {"from": "approve.manager", "to": "finalize.author"},
    {"from": "finalize.author", "to": "receipt.target"}
  ]
}
```

Design rules:

- Dynamic 결재선 roles map to human-task nodes: 검토, 승인, 합의, 참조. 참조 may be a notification/outbox-only node when it has no blocking decision.
- Template catalog records reason enum, required linked object kinds, default line, receipt requirement, finalizer role, and compensation permissions.
- Existing completion→approval→payroll compatibility is preserved by keeping `wf.exec.v1` validation additive; current authoring schema remains accepted separately (`backend/app/src/workflow_studio.rs:1665`, `backend/app/src/workflow_studio.rs:1685`).
- Job/outbox side effects stay allowlisted. The current `internal.jobs.draft_payroll_run` connector is allowlisted (`backend/app/src/workflow_studio.rs:64`, `backend/app/src/workflow_studio.rs:73`, `backend/app/src/workflow_studio.rs:2212`, `backend/app/src/workflow_studio.rs:2215`).

## Work Breakdown

1. **Runtime REST crate/app surface**
   - Add `/api/v1/workflow-runs` and `/api/v1/workflow-tasks` router beside Studio.
   - Tests: `sqlx::test` as `mnt_rt` for start/list/claim/decide/finalize, with RLS proof and error envelope checks.

2. **Waiting-task completion port**
   - Extend the runtime port/adapter with task claim and completion methods, guarded by status predicates and idempotency keys.
   - Store task decision/comment/finalizer metadata and advance the run from `WAITING -> RUNNING` for the next node or `WAITING -> SUCCEEDED` at the true terminal close.
   - Tests: stale claim 409, same-user replay 200, comment-required failures 422, delegated finalize requires reason.

3. **Approval definition builder**
   - Add AP template catalog for eight templates, reason enums, object-link requirements, default line generation, and receipt/finalization flags.
   - Emit `wf.exec.v1` graphs using existing node kinds first; add notification-only/object-event node support only where 참조 cannot be represented by current primitives.
   - Tests: all eight templates validate; existing completion→approval→payroll graph still validates.

4. **Finalization and compensation**
   - Implement finalization and receipt as waiting tasks before terminal success.
   - Implement 사후 반려 as a new compensating AP/document/event linked to original run id, never as an update to a terminal run.
   - Tests: terminal-node invariant unchanged; finalized run cannot be reopened; compensation creation audits and notifies the original line.

5. **Audit and authorization**
   - Every state transition uses `with_audit` or `with_audits`, carrying enforced legacy decision plus inert Cedar shadow where gated.
   - Tests: audit rows exist for start, claim, decide, finalize, receipt, compensation; unknown policy fails closed per guard behavior (`backend/crates/workflow/runtime/src/authz_guard.rs:53`, `backend/crates/workflow/runtime/src/authz_guard.rs:79`, `backend/crates/workflow/runtime/src/authz_guard.rs:160`, `backend/crates/workflow/runtime/src/authz_guard.rs:173`).

6. **OpenAPI/client drift**
   - Regenerate OpenAPI and typed client after REST lands.
   - Tests: client drift gate green; UI-M3/UI-M4 can consume inbox/submission endpoints.

## Spike Conclusion

**FEASIBLE**. The blocker feared in the plan is avoidable because the existing FSM already supports long-lived `WAITING` runs and waiting human nodes, while forbidding terminal reopening. Engine-Gen must add missing runtime/task REST and task-completion persistence, but it can preserve the terminal-node invariant, keep existing `wf.exec.v1` compatibility, and model finalization/receipt/compensation in the required Oyatie terms.
