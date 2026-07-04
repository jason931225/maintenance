# G010 final review blockers — 2026-06-30T08:10Z

Independent code-reviewer result: REQUEST CHANGES (`independentReview: code-reviewer=true`).

## HIGH

- `backend/crates/platform/db/migrations/0077_create_workflow_runtime_spine.sql:105-106` and `150-151`: `workflow_waiting_tasks` and `workflow_outbox_events` independently FK `run_id` and `node_run_id` by org, but do not enforce that `node_run_id` belongs to the same `run_id`. A row can point to run A while attaching a node run from run B in the same tenant, corrupting approval/outbox execution trace integrity.
  - Required fix: add a composite key on `workflow_node_runs`, e.g. `UNIQUE (org_id, run_id, id)`, and add composite FKs from waiting tasks/outbox using `(org_id, run_id, node_run_id)`.

## MEDIUM

- `scripts/check-workflow-runtime-spine.mjs:74-80`: gate uses broad/global grant substring checks. Required fix: table-qualified grant assertions and stronger per-table invariant checks.
- `backend/crates/platform/db/migrations/0077_create_workflow_runtime_spine.sql:152-153`: outbox terminal timestamp checks are one-way only. Required fix: reverse terminal-state constraints requiring timestamps/evidence for delivered/dead-letter states.
- `.omx/context/platform-maturity-g009/g009-completion-evidence-20260630T0805Z.md:38-49`: live DB evidence lacks negative trigger/FK/terminal/lock verification. Required fix: after schema fix, add live catalog readback and negative checks.

Independent architect result: WATCH (`independentReview: architect=true`).

## WATCH

- Trigger/channel enums are tight for integrity but schema-bound for future connector growth; recommend connector/capability registry before hardening further.
- Runtime tables are strictly org-scoped; cross-org/group workflows need parent orchestration envelope above org-local runs.
