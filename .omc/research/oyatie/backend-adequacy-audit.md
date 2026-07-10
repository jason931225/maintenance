# Backend Adequacy Audit — Oyatie Console (2026-07-09)

> Produced by a 9-agent verified audit workflow (4 dimension audits, adversarial verification, synthesis).
> Dimensions: ontology/object · workflow/automation · lifecycle/versioning · audit/PBAC (user-designated key areas).

## Verdict

The backend is adequate for the workflow/approval spine and the comms layer but inadequate for the ontology/object platform the design assumes — and that split is precise. The engine instance REST is verified complete and live (결재함/상신함/claim/decide/finalize/대행/사후반려), the audit envelope is universal and WORM-protected, and notifications/realtime are merged and wired: UI-M2b, M3, M5, M6 can be built today. But the design's Foundry-like generic object layer has essentially zero backend: no object resolve endpoint, no canonical code issuance beyond work orders (the frontend registry fabricates codes it cannot dereference), no cross-object links, no graph traversal, and an audit log that cannot even be queried per-object despite the index existing. Automation is a facade — one hardcoded trigger, no rule bindings, and no recurring-schedule substrate at all even though UI-M11 assumes one. Lifecycle/versioning/effective-dating/period-locks exist only as point solutions inside Workflow Studio and two hardcoded domains, so the generic lifecycle ribbon, pendingRev, as-of views, and close gates across the ~15 newly designed module surfaces have nothing to stand on. One finding is a live security defect, not just a UI blocker: the shared engine decide path permits initiator self-approval, so maker-checker holds only for financial purchases. Net: roughly four backend charters (Object-Layer, Automation-Triggers, Lifecycle-Engine, plus the already-planned Audit-Chain lane and one small engine-hardening slice) stand between the current backend and the design — none are huge, most generalize patterns that already exist in one domain, and they can all run in parallel worktrees alongside the UI-M3..M12 sequence without reordering it.

# Gap Register — Oyatie Console Backend Adequacy (2026-07-08)

Legend — **Plan**: (a) = existing plan already schedules backend work for this; (a\*) = plan names it but presumes a backend that does not exist; **(b) = NEW structural gap the plan does not cover**. Ranked by how early the gap blocks the replacement path.

| # | Requirement | Status | Plan | Evidence (verified) | Blocks what (earliest) |
|---|---|---|---|---|---|
| 1 | Typed-object registry: backend resolve endpoint | missing | **(b)** | No `/api/objects/*` route anywhere (app router = healthz/audit only, `backend/app/src/lib.rs:1282-1327`); `web/src/lib/objectRegistry.ts` stands alone; `NotificationLink::Object{kind:String}` free-form | **PR #202 / UI-M2a being real**: `!`-code deref, ⌘K global object search, every object chip beyond hardcoded WO/CS; all ~55 screens' object navigation |
| 2 | Object code issuance (AP-, WO-, … canonical) | partial | **(b)** | Only issuer = workorder `next_request_no` (`YYYYMMDD-NNN`, no prefix, 999/day cap, `workorder/adapter-postgres/src/lib.rs:1642-1672`); financial `expenditure_no` caller-supplied; all other kinds UUID-only; frontend fabricates prefixes | UI-M2a token grammar + UI-M4 대상 지정 + docs archive cross-refs: every displayed code except WO is non-canonical fiction |
| 3 | Audit per-object timeline (target_id/trace_id filters) | partial | (a) at UI-M10, **needed at UI-M3** | `AuditQuery` = {limit, offset, target_type, actor} only (`backend/app/src/lib.rs:1075-1080,1836-1841`); DB index on target already exists (0003:56) — **smallest gap-closer in the set** | History tab on every object detail screen from UI-M3 onward; trace correlation drill |
| 4 | Workflow run read surface (GET run/{id}, node steps, dead-letter) | partial | **(b)** | Only run routes = POST start + GET mine (`workflow_studio.rs:51-52`); node steps + outbox attempts persisted but unreadable via API | UI-M4 progress timelines, admin run search, retry/dead-letter visibility |
| 5 | Maker-checker on engine decide (SoD) — **security** | partial | **(b)** | `decide_waiting_task` never compares actor to `run.initiated_by` (`workflow/adapter-postgres/src/lib.rs:1136-1237`); SoD real only in financial + HR-exit hardcodes | UI-M4 truthfully: any initiator on the approval line can self-approve any engine-run workflow |
| 6 | Cross-object links/edges (generic, audited, removable) | missing | **(b)** | No generic edge table in 99 migrations; calendar/poll/workflow_runs carry one-directional (object_type, object_id) stamps only, no reverse traversal | "Related objects" / pin-A-to-B link panels on every detail screen; prerequisite for #7 |
| 7 | Graph traversal API (upstream/downstream walk) | missing | **(b)** | Only graph = `ExecGraph` (one workflow's node graph); no typed nodes+edges endpoint | Object explorer graph screen (unscheduled design screen); lineage views |
| 8 | Event triggers (domain event → rule → workflow start) | partial | **(b)** | Sole producer = hardcoded work-order-completion inline start (`m2_strangler.rs:269`); trigger_type is a provenance CHECK column, no binding table, zero rule evaluation | UI-M11 auto + all automation-rule screens; "when X → start Y" cannot exist |
| 9 | Recurring schedules (cron objects, next-run, run history) | missing | **(a\*)** UI-M11 cites `platform/jobs` schedules that don't exist | No cron dep; jobs crate is one-shot delayed only; inspection schedules never fire/advance; SCHEDULE TriggerType never produced | UI-M11 schedule pane entirely; recurring workflows |
| 10 | No-code canvas semantics (trigger/condition/branch blocks) | partial | **(b)** (canvas already deferred to follow-on charter) | `graph.rs:13` "Branching/parallel graphs are a later charter"; node vocab has no condition kind; trigger never persisted on definition | Cedar no-code canvas + block-canvas automation screens (unscheduled) |
| 11 | Generic lifecycle engine (draft→…→dispose FSM) | partial | **(b)** (M12 does bespoke per-domain FSMs) | ~20 ad-hoc per-domain status enums; workflow runtime is an approval-run engine, not object lifecycle | Generic lifecycle ribbon + per-state action gating on ALL screens; especially the 10 unscheduled module surfaces (finance/purchase/inventory/asset/…) |
| 12 | Non-destructive versioning + rollback (generalized) | partial | **(b)** | Content versioning exists ONLY for workflow_definitions (0069, trigger-protected); policy/subject "versions" are counters | "Version history + restore" panel everywhere except Workflow Studio |
| 13 | Revision sandbox (pendingRev on business objects + on ACTIVE defs) | partial | **(b)** | Workflow-defs only, and staging an edit sets status DRAFT which **blocks new starts** (`workflow_studio.rs:2013,1338-1342`); publish = single-actor, no four-eyes | Propose-revision flows on equipment/policy/org; truthful pendingRev on live workflows |
| 14 | Impact pre-check before effectuate/dispose | partial | **(b)** | Exists only for policy-role assignment (identity receipt pattern, `identity/adapter-postgres/src/lib.rs:1129-1170`) | Pre-dispose/pre-effectuate dependents dialog on all other types |
| 15 | Effective-dating (valid_from/to, future-dated commit, as-of) | partial | **(b)** | Zero temporal columns repo-wide; effective_date is logged TEXT only; no applier, no as-of reads | UI-M9 future-dated org restructure; "view as of date X" screens |
| 16 | Freeze windows (payroll/accounting period locks) | missing | (a\*) M7 close-gate/M8 마감 gate scheduled but no enforcement substrate | No period-lock table or write-window guard anywhere | UI-M7 month close + UI-M8 마감 being enforceable rather than decorative |
| 17 | PBAC policy projection endpoint (/me/authz) | partial | **(b)** | Zero backend hits for effective_permissions; Cedar shadow-only (2 sites, LegacyOnly pinned); frontend derives gating from JWT | Stable policy-gated-rendering contract for every screen; per-object deny-by-omission |
| 18 | View (read) auditing + self-view exemption | partial | (a) — in-flight | Person view-audit commits exist ONLY on `feat/console-oyatie-m2a-integration` (PR #202 lane), not on main | UI-M2a AC (person chip view-audit), UI-M9 sensitive-view gate |
| 19 | Audit telemetry (device/auth ctx, classification, seq+prev-hash) | partial | (a) UI-M10 + existing `audit-chain-lane.md` / `feat/audit-chain-l20` branch | No device/classification fields on AuditEvent; seal work unmerged | UI-M10 telemetry grid + tamper-evidence indicator |
| 20 | Guardrail control points (attestation/peer/SoD/egress, configurable) | partial | **(b)** | Authority checks fail-closed + passkey step-up real; SoD hardcoded in 2 domains; no checklist/egress objects | Guardrail preflight UI beyond authority+step-up; per-workflow control points |
| 21 | Reference tokens persisted + PBAC re-resolution | partial | (a) M2a/M2b ACs, but no `message_refs` backend chartered | messenger body = plain TEXT (0012); no token table, no parse-on-write | Mentions as live policy-gated refs; server-side mention notifications |
| 22 | Retention/legal hold on business objects | partial | (a-partial) M12 docs "retention labels"; enforcement uncovered | Storage WORM real; zero domain-level legal_hold/retention gates | Dispose screens enforcing retention/holds |
| 23 | No hard delete of business objects | partial | **(b)** trivial | `DELETE FROM sales_listings` (`sales/adapter-postgres/src/lib.rs:330`) — audited but row gone | Sales listing history/graph integrity; 1-line fix |
| 24 | Schema-as-object (OT- type registry) | partial | **(b)** minimal | object_type = regex slug in 3 tables, no enumerating table | OT- admin screens; type identity stringly across workflow/calendar/notifications |
| 25 | Series objects (SR-) | partial | **(b)** — recommend descope | Real shape exists for inspections only (0018) | SR- screens generalized beyond inspections |
| 26 | Covert clearance / CEO-only audit stream | missing | **(b)** — defer to Cedar promotion (avoid building twice) | Zero substrate; UI-M10 AC mentions covert rows but nothing backs it | Covert-object rendering; CEO audit channel |

**Not gaps (verified adequate today)**: workflow instance REST (결재함/상신함/claim/decide/finalize/대행/사후반려 — complete, live-wired), audit envelope (`with_audit` across 16 domain families, WORM), notifications/realtime backend (#198 merged, wired).

# Recommended Build Path to Full Frontend Replacement

Four new backend charters are needed: **BE-OBJ** (Object-Layer), **BE-WF-HARDEN** (engine reads + SoD), **BE-AUTO** (Automation-Triggers), **BE-LC** (Lifecycle-Engine). Audit-Chain already has a lane (`.omc/plans/audit-chain-lane.md`, branch `feat/audit-chain-l20`). Backend charters run in separate worktrees parallel to UI milestones; each must merge before its named UI consumer.

**Unblocked today** (backend verified sufficient or in-slice): UI-M2b (notifications merged), UI-M3 (Engine-Gen instance REST live), UI-M5, UI-M6, UI-M7 (aggregation in-slice), UI-M12 benefit/recruit/review (bespoke FSMs in-slice).
**Blocked on new charters**: UI-M4 (BE-WF-HARDEN), UI-M8-마감 (BE-LC period locks), UI-M9 (PR #202 view-audit merge + BE-LC effective-dating), UI-M10 (Audit-Chain), UI-M11 (BE-AUTO — hard blocked, schedules backend nonexistent), and **all ~15 unscheduled design screens** (BE-OBJ/BE-AUTO/BE-LC).

### 1. BE-OBJ — Object-Layer backend charter (NEW; start NOW, parallel worktree)
Small platform crate: kind→table registry + `GET /api/objects/{kind}/{id}` resolve (Cedar-gated, reusing kernel typed IDs); generalize the workorder counter into shared code issuance keyed by kind prefix; `object_links` table (src/dst kind+id, link_type, audited POST/DELETE, list-by-either-end); seeded `object_types` lookup FK'd by the 3 free-form columns; **add target_id/trace_id to AuditQuery (tiny, do first)**; `message_refs` parse-on-write feeding NotificationLink; sales `DELETE`→`UPDATE` fix. Closes gaps 1, 2, 3, 6, 21, 23, 24. Parallel with UI-M2b build + PR #202 merge; must land before UI-M4 (canonical codes for 대상 지정); UI-M3 detail-screen history tabs want the AuditQuery slice.
> Slice 1 MERGED (#206). Slice-2 DECISION ITEM from the post-wave simplify pass (2026-07-09): backend `url_path_for` (`backend/app/src/objects.rs:570`) and frontend `objectRegistry` route closures are two independent kind→URL tables that ALREADY diverge (support_ticket: backend `/support?ticket={raw_uuid}` vs frontend `/support?ticket=CS-{code}`), and `url_path` has zero web consumers today. Before wiring the resolve endpoint into the UI, pick ONE authority: (a) client trusts server `url_path` and drops the per-kind `route()` closures, or (b) delete `url_path_for` from the API and `objectRegistry` stays sole routing authority. Do not ship both.

### 2. UI-M2b + merge PR #202 (current work; parallel with BE-OBJ)
As planned — backend verified sufficient (notifications/realtime live). Merging #202 also lands the person view-audit slice (gap 18).

### 3. UI-M3 — Overview (UNBLOCKED; parallel with BE-WF-HARDEN lane)
As planned. Engine-Gen instance REST verified complete; todos domain in-slice.

### 4. BE-WF-HARDEN — engine read surface + SoD (NEW, small; merges before UI-M4)
Read-only `GET /workflow-runs/{id}` + node-step timeline + admin run/dead-letter list over already-persisted tables (pure queries); **`actor != run.initiated_by` guard in `decide_waiting_task`** with financial-style org-lead override + governance finding (one guard in the shared decide path covers all engine workflows); optionally decouple ACTIVE+latest-DRAFT so staging an edit stops blocking starts. Closes gaps 4, 5, (13-definitions). Parallel with UI-M3.
> SoD guard portion DONE (#205). Post-wave simplify pass (2026-07-09) flagged for this charter: the self-approval policy body (exempt roles + `governance_findings` OPEN-upsert with its ON CONFLICT target) now exists in THREE near-verbatim copies — financial `check_self_approval_tx`, integrity `upsert_price_outlier_finding`, workflow `check_self_approval_tx` — and the copies already diverge mechanically (parameterized vs inlined detector/entity). Two reviewers (reuse+altitude) recommend extracting one shared governance helper (e.g. `upsert_open_finding_tx(tx, org, {detector_id, entity_type, entity_id, score, severity, evidence})` owned by compliance/integrity, callable inside a caller's tx); one reviewer (simplification) dissents (cross-crate dep + parameterizing away real differences). DECIDE at BE-WF-HARDEN implement time — before any fourth module grows its own copy. Call-site placement in `decide_waiting_task` is confirmed correct; only the body is at issue.

### 5. UI-M4 — 전자결재 (after BE-WF-HARDEN + BE-OBJ)
> Slice 1 BUILT as PR #233 (2026-07-09): 결재함/상신함 + engine decide flow + SoD deny-by-omission + overview drill-in. **GAP surfaced: 기안 compose deferred** — every workflow-studio catalog/definition endpoint is authorize_workflow_manage (admin-only), so a normal initiator has no live source for the submittable-template gallery. NEEDS: an all-employee "submittable definitions" catalog endpoint (Engine-Gen follow-up) before the compose UI ships. Do not stub the gallery.
As planned; progress timelines bind the new run-read endpoints; 대상 지정 uses canonical codes.

### 6. UI-M5 → UI-M6 chain ∥ BE-AUTO lane starts
M5/M6 as planned (in-slice InboxDoc + webauthn infra exists; serial: M6 needs M5). **BE-AUTO** (NEW) runs parallel: `workflow_trigger_bindings` table + dispatcher at existing audited-mutation commit points (reusing start_run + reserved TriggerType values); schedules table (label, cron, definition_id, next/last_run) + poller in the workflow_drain pattern; condition/branch node kind + persisted trigger block in wf.exec.v1. Closes gaps 8, 9, 10. Must merge before UI-M11 and the automation/canvas screens.

### 7. UI-M7 → UI-M8 ∥ BE-LC lane + Audit-Chain lane
M7/M8 as planned. **BE-LC** (NEW) parallel: shared lifecycle crate (state-set + transition table keyed by object_type, generic audited transition endpoint, optional workflow_run spawn on gated transitions); generalize the 0069 versioning pattern (`<object>_versions` + trigger protection + rollback-as-new-version); dependents-count preview registry behind one endpoint (identity receipt pattern); `legal_hold`/`retention_until` + dispose gates; **`period_locks` table + guard helper in payroll/financial write paths** (feeds M7 month-close and M8 마감 so the gates are enforced, not decorative); effective-dating (valid_from/to or staging+jobs applier) for org units + policy roles first. Closes gaps 11–16, 22. Simultaneously land `feat/audit-chain-l20` + nullable request-context columns (gap 19).

### 8. UI-M9 → UI-M10
M9 needs #202's view-audit pattern generalized + BE-LC effective-dating for future-dated restructure. M10 needs Audit-Chain merged + the AuditQuery filters from BE-OBJ; ship `/api/v1/me/authz` projection here at the latest (legacy-matrix-backed, marked non-authoritative — gap 17) so the frontend gating contract is stable before Cedar promotion.

### 9. UI-M11 → UI-M12 → re-plan consensus for the ~15 unscheduled screens (UI-M13+)
UI-M11 binds BE-AUTO (definitions/simulate/publish + real schedules). UI-M12 as planned (bespoke FSMs fine; docs retention labels ride BE-LC). Then a **consensus re-plan** slots the design-prototype growth: the 10 module surfaces onto the BE-LC lifecycle + BE-OBJ code/link substrate (each becomes a thin domain crate + screen, not bespoke platform work); object explorer graph = recursive-CTE endpoint over `object_links` (gap 7); Cedar no-code canvas rides BE-AUTO + Cedar promotion; covert clearance (gap 26) is modeled as a Cedar policy dimension in the promotion charter, not legacy tables; SR- series either generalizes the inspection shape or is formally descoped.

### Legacy-retirement endgame criteria (delete AppShell + ~40 legacy routes when ALL hold)
1. Every legacy route has a ConsoleShell replacement at feature parity, verified by the Playwright route-smoke matrix + PBAC persona matrix on the new shell.
2. No frontend code path fabricates object codes — all codes server-issued and resolvable via `/api/objects` (BE-OBJ complete, `objectRegistry.ts` fabrication deleted).
3. All mutations flow through audited console APIs with the SoD decide-guard live; per-object timelines render from the audit query surface.
4. `/me/authz` projection is the sole gating source (Cedar promoted or legacy-backed, but one contract); no screen derives permissions from JWT claim parsing.
5. Period locks, view-audit, and passkey receipt flows proven in E2E on the new shell (the compliance-critical parity bar).
6. Two consecutive release cycles with zero traffic to legacy-only routes (nav telemetry), then delete AppShell, legacy route components, and their tests in one PR.

## Appendix — verified findings (raw)

```json
[
 {
  "dimension": "ontology-object",
  "findings": [
   {
    "requirement": "Typed-object registry (backend code -> object resolution)",
    "status": "missing",
    "evidence": "VERIFIED, upheld. Re-checked the strongest refutation candidate: backend/crates/kernel/core/src/ids.rs is a typed_id! macro producing UUID newtypes (OrgId, WorkOrderId...) with no code scheme, no kind registry, no resolution; kernel/core/src/lib.rs is pure data/logic (no routes). Greps for object_code/ObjectCode/object_registry/resolve_object across backend/*.rs and *.sql return nothing. App router exposes only /healthz, /readyz, /openapi, /metrics, /api/audit (backend/app/src/lib.rs:1282-1327); the only search route anywhere is /api/messenger/search (backend/crates/messenger/rest/src/lib.rs:64). NotificationLink::Object{kind:String,id:String} confirmed free-form at backend/crates/notifications/domain/src/lib.rs:80-82. Frontend registry web/src/lib/objectRegistry.ts stands alone.",
    "impact": "Universal code-based navigation (paste/click any AP-/WO-/C- code to open its object), global object search, and the token grammar all lack a backend resolve surface; the frontend can only fabricate codes it cannot dereference.",
    "recommendation": "Add a small platform crate with a kind->table registry and one GET /api/objects/{kind}/{id} resolve endpoint (Cedar-gated), reusing kernel typed IDs."
   },
   {
    "requirement": "Cross-object links/edges (generic, user-created, audited, removable)",
    "status": "missing",
    "evidence": "VERIFIED, upheld with enrichment. Grep of all 99 migrations finds no generic edge table (only ledger tables match 'link|edge|relation' in CREATE TABLE; user_employee_link 0076 is a fixed user<->employee join). Closest overlooked pattern: collaboration calendar events and polls accept an optional free-form (object_type, object_id) attachment via live API (backend/app/src/collaboration.rs:82-84, migration 0073_create_collaboration_calendar_polls.sql:19-33), and workflow_runs carries the same pattern (0077:19-48) — but all are one-directional 'this row is about X' stamps with no reverse traversal, no arbitrary A<->B link creation, no removal semantics. No API writes a generic typed relation.",
    "impact": "The design's link panels ('related objects', pin object A to object B, dependency views) have no backend to read or write; every relationship shown must be hardcoded per domain pair.",
    "recommendation": "One org-scoped object_links table (src_kind, src_id, dst_kind, dst_id, link_type, created_by) with audited POST/DELETE and a list-by-either-end query."
   },
   {
    "requirement": "Graph traversal API (upstream/downstream walk)",
    "status": "missing",
    "evidence": "VERIFIED, upheld. Re-grepped graph|traverse|neighbor|adjacen|related_ across backend/*.rs: the only graph is workflow/runtime/src/graph.rs ExecGraph, which parses a workflow definition's node graph (steps of one workflow), not an object graph. Domain rest crates return only their own aggregates (e.g. work-order detail embeds status_history/assignments, backend/crates/workorder/rest/src/lib.rs:2569-2576). No endpoint returns typed nodes+edges for an object.",
    "impact": "The graph/lineage view (walk upstream to the approval that authorized a work order, downstream to invoices) cannot be built; blocked on the edge store above.",
    "recommendation": "After object_links exists, one recursive-CTE endpoint GET /api/objects/{kind}/{id}/graph?depth=N filtered per-node by Cedar."
   },
   {
    "requirement": "Events-as-objects (per-object activity timeline, correlated)",
    "status": "partial",
    "evidence": "VERIFIED, upheld with one addition. Confirmed by reading the code: AuditQuery has only limit/offset/target_type/actor — no target_id, no trace_id (backend/app/src/lib.rs:1075-1080), and the SQL builder binds only target_type and actor (backend/app/src/lib.rs:1836-1841), so the DB's per-target index and trace columns (0003_create_audit_events.sql) are unreachable via API. One additional read path the original audit missed: identity's list_policy_audit_events (backend/crates/identity/adapter-postgres/src/lib.rs:725-760) — but it is hard-scoped to action LIKE 'policy.%' AND target_type IN (policy_role, policy_role_assignment), so it does not provide a generic per-object timeline either. Per-domain event tables (work_order_status_history, employee_lifecycle_events 0071, workflow_definition_events 0069) confirmed. Events have UUIDs, no issued codes, not addressable.",
    "impact": "The per-object activity timeline (every object detail screen's history tab) and trace/session correlation views cannot be served; only a global type-filtered audit feed is possible today.",
    "recommendation": "Add target_id and trace_id params to AuditQuery/fetch_audit_records — the index (0003:56) already supports it; smallest gap-closer in the whole set."
   },
   {
    "requirement": "Series objects (SR-) with instance membership, trend, next-expected",
    "status": "partial",
    "evidence": "VERIFIED, upheld. Confirmed regular_inspection_schedules (cycle DAILY..CUSTOM, interval_days, due_date) with inspection_rounds FK'd via schedule_id (backend/crates/platform/db/migrations/0018_create_inspection.sql:6-17,30-33) — a real recurring-parent-with-instances shape, inspection-only. Confirmed payroll_draft_runs are period-keyed instances with UNIQUE(org, period, source_label) and no parent series row (0074_create_payroll_readiness.sql:5-23). Re-grep of recurr|series across backend hits only vendored spreadsheet code and a metrics comment; platform/jobs is background job execution, not series objects.",
    "impact": "SR- series screens (recurring inspections generalized to recurring work orders/charges, trend + next-expected panels) work only for inspections; every other domain needs its own bespoke recurrence.",
    "recommendation": "Either generalize the inspection schedule shape into a shared series table, or accept per-domain recurrence and drop the generic SR- kind from v1 scope."
   },
   {
    "requirement": "Schema-as-object (OT- object-type registry with lifecycle)",
    "status": "partial",
    "evidence": "VERIFIED, upheld. Confirmed workflow_definitions has DRAFT/ACTIVE/PAUSED/RETIRED lifecycle with versioned JSONB (PUBLISHED/ROLLED_BACK/CLONED version states) and an append event log (0069_create_workflow_studio.sql:14-16,34-46,51+), wired via backend/app/src/workflow_studio.rs. Its object_type is a regex-validated free-form slug (0069:14; same pattern in 0073:19 and 0077:19) — grep for object_kind/object_types/any enumerating table or enum across backend returns nothing. No type propose/review/deprecate lifecycle, no instance migration.",
    "impact": "The OT- object-type admin screens (browse/define/version object schemas) have no backing; type identity is stringly-typed and unvalidated across workflow, calendar, and notifications.",
    "recommendation": "Minimal: a seeded object_types lookup table that the three existing free-form object_type columns FK to; full OT- lifecycle only if the design's type-authoring screens are actually in scope."
   },
   {
    "requirement": "Reference tokens in text (@/#/! persisted + PBAC re-resolution)",
    "status": "partial",
    "evidence": "VERIFIED, upheld. Confirmed messenger_messages.body is plain TEXT with a generated tsvector (0012_create_messenger.sql:47-48); grep for mention|token_text|reference_token across backend hits only a prose comment in 0099_create_notifications.sql:4 and audit_tx.rs test assertions — no token table, no parse-on-write, no PBAC re-resolve read path. The delivery half confirmed live: NotificationLink Object/Screen with validation (backend/crates/notifications/domain/src/lib.rs:80-95) and a wired inbox router (backend/crates/notifications/rest/src/lib.rs:53-60). TokenText rendering is frontend-only.",
    "impact": "@mentions/#object/!action tokens in chat and comments cannot survive as live, policy-gated references — they render as dead text; mention-driven notifications cannot be generated server-side.",
    "recommendation": "Parse tokens on message/comment write into a small message_refs table and emit notifications through the existing NotificationLink path; re-resolve refs at read time behind Cedar."
   },
   {
    "requirement": "Object code issuance (AP-, WO-, ... consistent scheme)",
    "status": "partial",
    "evidence": "VERIFIED, upheld. Confirmed next_request_no issues 'YYYYMMDD-NNN' with no 'WO-' prefix and a hard 999/day cap via the work_order_request_counters upsert (backend/crates/workorder/adapter-postgres/src/lib.rs:1642-1672). Re-grepped for any other issuance: work_order_request_counters is the ONLY counter table in all migrations, no format!(\"XX-...\") code generation exists outside tests, and financial expenditure_no is caller-supplied free text (test fixture 'AP-20260630-001' is hand-written, backend/crates/financial/adapter-postgres/tests/use_cases.rs:668). Support tickets, payroll runs, purchase requests, workflow runs: UUID-only. Frontend fabricates all prefixes (web/src/lib/objectRegistry.ts:49-50,153).",
    "impact": "Every screen that displays or accepts an object code shows fabricated, non-canonical identifiers for all kinds except work orders; codes cannot be used as stable cross-references in documents or audit.",
    "recommendation": "Generalize the existing per-org per-day counter into a shared issuance helper keyed by kind prefix (reuse the upsert pattern from workorder adapter), and backfill codes per domain as each screen ships."
   }
  ]
 },
 {
  "dimension": "workflow-automation",
  "findings": [
   {
    "requirement": "Instance REST completeness (결재함/상신함/claim/decide/finalize/대행/사후반려)",
    "status": "exists",
    "evidence": "VERIFIED (adversarial re-check): all runtime routes declared backend/app/src/workflow_studio.rs:48-55 and wired in router() :244-296 (start_workflow_run, list_my_workflow_runs, list_workflow_tasks, claim, decide, finalize, post-finalization-rejection); router mounted UNCONDITIONALLY (not dark/flagged) at backend/app/src/lib.rs:1371-1377. Re-opened cited code: FinalizeMode Author|Delegate with author-identity check + policy-gated delegate requiring stated reason (crates/workflow/runtime/src/completion.rs:12-60); TaskDecision Approve/Reject/Return (crates/workflow/adapter-postgres/src/lib.rs:161-176); comment ≤4000 chars and MANDATORY on reject/return (workflow_studio.rs:1735-1754); group-inbox role_key + personal ?assignee=me with authority-role gating (adapter-postgres/src/lib.rs:66-86 WaitingTaskListFilter); post-finalization-rejection domain command crates/workflow/domain/src/lib.rs:427-489; start authz via start_policy/entry-node policy with Cedar shadow (workflow_studio.rs:1455-1470).",
    "impact": "None — approval inbox (결재함), sent box (상신함), claim/decide/finalize/대행/사후반려 console screens can be built on this today."
   },
   {
    "requirement": "Event triggers (domain event → automation rule → workflow start)",
    "status": "partial",
    "evidence": "CONFIRMED after aggressive re-grep: the ONLY non-test TriggerType producer in the backend is the hardcoded work-order-completion inline start at crates/workorder/rest/src/m2_strangler.rs:269 (TriggerType::ObjectEvent). Migration 0077 (crates/platform/db/migrations/0077_create_workflow_runtime_spine.sql:17-18) shows trigger_type is a provenance CHECK column on the run row (MANUAL/SCHEDULE/OBJECT_EVENT/IMPORT_EVENT/MAIL_EVENT/MESSENGER_EVENT/CALENDAR_EVENT/POLL_EVENT/API), NOT a binding table. Grep for automation_rule/trigger_binding/event_rule/workflow_trigger across backend + migrations: zero hits (only Cedar map.rs false positive). crates/platform/realtime is a LISTEN/NOTIFY→websocket UI bridge, not automation. No rule evaluation on any domain event.",
    "impact": "Automation-rule authoring screens (\"when X happens, start workflow Y\") and any event-driven workflow beyond the one hardcoded work-order path cannot ship.",
    "recommendation": "Add a workflow_trigger_bindings table (object_type + event → definition_id) plus a small dispatcher invoked at the existing audited-mutation commit points, reusing start_run and the reserved TriggerType values."
   },
   {
    "requirement": "Recurring schedules (cron objects with label, next-run preview, run history, retry)",
    "status": "missing",
    "evidence": "CONFIRMED: no cron dependency in platform/jobs or app Cargo.toml; crates/platform/jobs/src/lib.rs is one-shot delayed scheduling only (schedule_at :204/:630, schedule_after :791) with worker retries but no recurrence/next-run/schedule objects. Recurring in-process work is hardcoded tokio interval loops (backend/app/src/workflow_drain.rs, mail_sync). Near-misses re-checked and rejected: inspection regular_inspection_schedules rows carry interval_days + due_date (crates/inspection/adapter-postgres/src/lib.rs:104-116,:524-525) but nothing fires or advances them — no next-run computation, no auto-spawn on completion; dispatch worker consumes one-shot delayed jobs (scheduled_for) only. TriggerType SCHEDULE/CALENDAR_EVENT/POLL_EVENT are reserved enum/CHECK values never produced.",
    "impact": "Scheduled-automation screens (cron list, next-run preview, per-schedule run history, retry controls) have zero backend surface; recurring workflows cannot exist.",
    "recommendation": "Add a schedules table (label, cron expr, definition_id, enabled, last/next_run) + a poller loop in the existing workflow_drain pattern that calls start_run with TriggerType::Schedule, plus a thin CRUD/list REST slice."
   },
   {
    "requirement": "No-code definition persistence (block-canvas: trigger/condition/action blocks bound to object types)",
    "status": "partial",
    "evidence": "CONFIRMED: authoring REST complete and versioned (catalog/CRUD/history/simulate/publish/pause/rollback/clone, backend/app/src/workflow_studio.rs:32-55, router :244-296) persisting JSONB definition + approval_line + payment_line + notification_rules + action_allowlist bound to object_type; wf.exec.v1 node graph interpreted by runtime. Re-checked the refutation angle: crates/workflow/runtime/src/graph.rs:13 states verbatim \"Branching/parallel graphs are a later charter\" and the node vocabulary is only object_gate / object_mutation / human_task|waiting_task / job (graph.rs:114-150) — no condition/branch node kind exists. trigger_type appears only on the run-start request (workflow_studio.rs:810,:1517), never persisted as a definition block. Actions are a fixed 5-connector allowlist (:67-98).",
    "impact": "Block-canvas builder can ship for linear approval-line workflows only; trigger blocks and condition/branch blocks in the canvas have no persistence or execution semantics.",
    "recommendation": "Extend wf.exec.v1 with a condition/branch node kind in the interpreter and persist a trigger block on the definition (feeding the trigger-binding dispatcher from the event-trigger gap)."
   },
   {
    "requirement": "Revision staging on ACTIVE definitions (pendingRev; active keeps running until 적용 승인 four-eyes)",
    "status": "partial",
    "evidence": "CONFIRMED by re-opening cited lines: PATCH creates a new DRAFT version row preserving active_version (workflow_studio.rs:1999-2017) but sets definition_status: \"DRAFT\" (:2013), and resolve_start_definition returns conflict for any status != \"ACTIVE\" (:1338-1342) — so staging an edit blocks new starts of the still-active version. publish_definition (:2216-2235) is authorize_workflow_manage + passkey step-up by a SINGLE actor; repo-wide grep for four-eyes/maker-checker/dual-control on definitions: no hits — the same admin drafts and publishes. Rollback + full version history exist (:44-45, :2127-2160).",
    "impact": "The design's pendingRev pattern (active version keeps serving while a staged revision awaits a second approver) cannot be rendered truthfully; editing a live workflow takes it out of service.",
    "recommendation": "Decouple definition_status from draft-version creation (keep ACTIVE + latest DRAFT version), and route publish through the workflow engine's own approval task (or a second-approver check) instead of single-actor step-up."
   },
   {
    "requirement": "Guardrail preflight / control points (authority + self-checklist attestation + peer four-eyes + SoD + egress gate, fail-closed)",
    "status": "partial",
    "evidence": "STATUS CONFIRMED, EVIDENCE CORRECTED: authority checks are fail-closed at every node transition/waiting-task completion (crates/workflow/runtime/src/authz_guard.rs), start_policy gating (workflow_studio.rs:1455-1470), passkey step-up on studio mutations, author/delegate finalize policy (completion.rs:44-60). CORRECTION to prior claim \"SoD is only implicit\": explicit hardcoded SoD guards exist — financial self-approval block check_self_approval_tx (crates/financial/adapter-postgres/src/lib.rs:1020-1027, :2605-2615, recorded to governance_findings) and HR absence→exit→settlement chain SoD with distinct-actor check across capability tiers (crates/platform/authz/src/lib.rs:386-397, tests/policy.rs:820). Still verified MISSING: no generic SoD rule engine, no checklist/attestation object (only work-order procedure text, crates/workorder/application/src/lib.rs:181-299), no generic peer four-eyes control point, no egress gate object.",
    "impact": "Guardrail preflight UI can render authority + step-up + the two hardcoded SoD domains, but generic per-workflow control points (attestation checklists, peer review, configurable SoD, egress gates) have no backend objects.",
    "recommendation": "Model control points as a node-level list on wf.exec.v1 (attestation/peer-review/sod/egress kinds) enforced in the existing authz_guard seam, generalizing the financial/HR-exit SoD patterns."
   },
   {
    "requirement": "Workflow run history / execution logs (per-rule timeline with retry)",
    "status": "partial",
    "evidence": "CONFIRMED: append-only node-step persistence via commit_node_step keyed (org_id, run_id, node_key, attempt) (crates/workflow/adapter-postgres/src/lib.rs:1600; engine.rs:216) and notification outbox with attempt_count/backoff/dead-letter at 10 attempts (adapter :35-39, :574, :670-760). Definition-level history REST exists (workflow_studio.rs:2127-2160). Re-grepped for any run-read surface beyond the claim: the only run routes are POST /api/v1/workflow-runs and GET /workflow-runs/mine (workflow_studio.rs:51-52, router :287) — no GET /workflow-runs/{id}, no node-step timeline endpoint, no retry/dead-letter visibility endpoint anywhere in backend/app or workflow crates; list_runs_for_initiator (:950-996) returns summary RunListItem rows and RunListFilter (:101) is initiator-scoped only.",
    "impact": "Run-detail screens (per-node timeline, attempt/retry visibility, dead-letter inspection, admin run search) cannot ship; only a submitter's own run summary list is possible.",
    "recommendation": "Add read-only GET /workflow-runs/{id} (+ node-steps) and an admin-scoped run/dead-letter list over the already-persisted workflow_run_node_steps and outbox tables — pure query endpoints, no new writes."
   }
  ]
 },
 {
  "dimension": "lifecycle-versioning",
  "findings": [
   {
    "requirement": "Generic lifecycle engine (draft→submit→approve→active→revise→archive→dispose as reusable FSM)",
    "status": "partial",
    "evidence": "Re-verified: no shared lifecycle crate exists (grep 'lifecycle|state_machine|fsm' across backend/crates/platform hits only app/request lifecycle comments; the only 'lifecycle' table is employee_lifecycle_events, backend/crates/platform/db/migrations/0071_create_employee_lifecycle_events.sql — an HR event ledger, not an FSM). Spot-checked backend/crates/workorder/domain/src/lib.rs:66-80: WorkOrderStatus is a per-domain ad-hoc enum as claimed; ~20 sibling enums exist (registry/domain/src/lib.rs:80, sales/domain/src/lib.rs:121+213, support/domain/src/lib.rs:31, dispatch/domain/src/lib.rs:16, financial/domain/src/lib.rs:110, inspection/domain/src/lib.rs:59, reporting/domain/src/lib.rs:461, compliance/integrity/src/domain.rs:71, identity/application/src/org.rs:257+281). What IS generic: the M2 workflow runtime — workflow_runs bind arbitrary (object_type, object_id) with generic RunStatus/NodeStatus/WaitingTaskStatus (backend/crates/workflow/domain/src/lib.rs:73-136; adapter backend/crates/workflow/adapter-postgres/src/lib.rs:458,1496) and workflow_definitions carry DRAFT/ACTIVE/RETIRED (0069_create_workflow_studio.sql:9-48). That is an approval-run engine, not an object-lifecycle FSM.",
    "impact": "Every Oyatie object detail screen's generic lifecycle ribbon (draft→…→dispose) and per-state action gating cannot render from one API; each object type needs bespoke status mapping.",
    "recommendation": "Introduce a platform lifecycle crate: a shared state-set + transition table keyed by object_type, with a generic transition endpoint that emits the audit event and optionally spawns a workflow_run for gated transitions; migrate domains onto it incrementally."
   },
   {
    "requirement": "Effective-dating (valid-from/to, future-dated atomic commit, as-of reconstruction)",
    "status": "partial",
    "evidence": "Refutation attempt failed: grep 'valid_from|valid_to|effective_from|effective_to|as_of' across backend/**/*.rs and *.sql returns zero hits (non-vendor). effective_date exists only as a logged TEXT attribute: employee_lifecycle_events.effective_date (migrations/0071_create_employee_lifecycle_events.sql:24, CHECK non-blank, TEXT not DATE), HR position transitions (backend/app/src/hr.rs:397,5336-5380,7845), and payroll statutory rate tables effective-dated in code (backend/crates/payroll/domain/src/lib.rs:725). No temporal columns, no scheduler applying future-dated changes at effect date, no as-of read API.",
    "impact": "Oyatie's future-dated org-restructure commit and 'view org/policy as of date X' screens cannot ship; effective-date pickers would be cosmetic.",
    "recommendation": "Add valid_from/valid_to (or an effective-change staging table + jobs-crate applier using the existing platform/jobs runner) for the small set of objects the design actually effective-dates first: org units and policy roles."
   },
   {
    "requirement": "Non-destructive versioning + rollback (new version republishing old content)",
    "status": "partial",
    "evidence": "Re-checked and refutation attempt failed. Full grep of migrations for version tables found exactly three: workflow_definition_versions (0069:29 — real content versioning, UPDATE/DELETE forbidden by triggers at 0069:105-109), policy_versions (0065_create_policy_roles.sql:177 — a per-org BIGINT bump counter, no content), subject_authz_versions (0096_create_subject_authz_versions.sql:22 — Cedar freshness counters, no content). Rollback verified live-wired: route /workflow-studio/definitions/{id}/rollback (backend/app/src/workflow_studio.rs:45,275), handler rollback_definition at 2286 calling mutate_definition_with_source_version (defined at 2520) which creates a NEW version from target content; edit creates version N+1 (1977-2040). No other domain object has version history or rollback.",
    "impact": "Oyatie's 'version history + restore' panel works only on the Workflow Studio screen; equipment, policies, org units, and documents cannot show history or roll back.",
    "recommendation": "Generalize the 0069 pattern (append-only <object>_versions + trigger protection + rollback-as-new-version) into a shared helper; apply to the objects the design versions."
   },
   {
    "requirement": "Revision sandbox (pendingRev: draft proposal while active stays live)",
    "status": "partial",
    "evidence": "Confirmed workflow-definitions-only: update_definition inserts a DRAFT version while active_version keeps serving (backend/app/src/workflow_studio.rs:2003-2017); runs bind to active_version via resolve_start_definition (1294-1348). Greps for draft/pending-revision mechanisms elsewhere found only payroll_draft_runs (0074 — a readiness scratch table) and financial/sales draft statuses on the live row itself; all other domain updates mutate the live row in place.",
    "impact": "The design's 'propose revision, review, then effectuate' flow on business objects (equipment specs, policy roles, org structure) has no backend; only workflow graphs support it.",
    "recommendation": "Falls out of the generalized versioning work above: a DRAFT row in <object>_versions with a publish/effectuate transition is the pendingRev."
   },
   {
    "requirement": "Impact pre-check before effectuate/dispose (dependency scan, blocker vs warn)",
    "status": "partial",
    "evidence": "Refutation attempt failed: grep 'impact|preview' across all crates hits only identity (policy-role assignment impact preview: backend/crates/identity/adapter-postgres/src/lib.rs:1129-1154 count_policy_role_assignments; preview receipt persisted+consumed in-transaction, lib.rs:1156-1170 and policy_assignment_preview_receipts table at migrations/0065:159-173; REST PolicyRoleImpactResponse backend/crates/identity/rest/src/lib.rs:523,1116-1173) plus a comment in platform/authz (lib.rs:825, Policy Studio preview visibility — not a dependency scan). Workflow studio findings (backend/app/src/workflow_studio.rs:3375-3439) are publish-time self-validation, not a dependents scan.",
    "impact": "Oyatie's pre-dispose/pre-effectuate impact dialog (N dependents, blockers vs warnings) can only ship for policy-role assignment; all other object types have nothing to call.",
    "recommendation": "Reuse the identity receipt pattern generically: a per-object-type dependents-count query registry behind one preview endpoint, receipt consumed by the mutating call."
   },
   {
    "requirement": "Referential-integrity dispose gates + retention/legal hold",
    "status": "partial",
    "evidence": "Confirmed point solutions only. Region/branch soft-deactivation guarded against orphaning (backend/crates/identity/rest/src/lib.rs:11-12,197-202; migrations/0047). Workflow definition archive gated DRAFT-only (backend/app/src/workflow_studio.rs:2042-2070 ensure_draft_definition). Storage-layer WORM/COMPLIANCE retention real (backend/crates/platform/storage/src/lib.rs:219-236,363-380,732-750; migrations/0019 hardens it; seaweedfs_worm tests exist). Refutation greps: 'legal_hold|ObjectLockLegalHold' → zero non-vendor hits; 'retention' outside storage/audit is only a comment about COMPLIANCE-retained 거래명세표 (financial/adapter-postgres/src/lib.rs:1402). No domain-level retention-deadline or legal-hold gate, no generic dependents check before archive/dispose.",
    "impact": "Dispose screens cannot show or enforce retention deadlines/legal holds on business objects; dispose gating exists only for the two hardcoded cases.",
    "recommendation": "Add a legal_hold flag + retention_until on the disposal-eligible object tables and check both in the (new) generic dispose transition; keep storage WORM as the evidence layer."
   },
   {
    "requirement": "No hard delete of business objects",
    "status": "partial",
    "evidence": "Spot-checked the exception: backend/crates/sales/adapter-postgres/src/lib.rs:330 — 'DELETE FROM sales_listings WHERE id = $1' inside with_audit; audit event written but the row is gone, no version retained. Confirmed. Rest of claim re-verified as stated: region/branch deactivated_at soft delete (migrations/0047), workflow versions trigger-protected append-only (0069:105-109), subject_authz_versions even has REVOKE DELETE FROM mnt_rt (0096:39-48), remaining DELETEs are child-row replace-on-write or hygiene (workorder/adapter-postgres/src/lib.rs:350-354; dispatch/adapter-postgres/src/lib.rs:1526-1530; financial/adapter-postgres/src/lib.rs:1755; identity/adapter-postgres/src/lib.rs:447,955,981; compliance privacy erasure lib.rs:213-228,384).",
    "impact": "A disposed sales listing vanishes from the object graph — its code becomes a dangling reference in Oyatie's traversal and its history page is unreconstructable.",
    "recommendation": "Convert sales listing delete to an ARCHIVED/DISPOSED status write (one-column migration + swap the DELETE for an UPDATE); smallest possible fix."
   },
   {
    "requirement": "Freeze windows (payroll-close/accounting-period locks)",
    "status": "missing",
    "evidence": "Refutation attempt failed. Re-ran greps 'freeze|frozen|period_lock|accounting_period|payroll_close|close_period|period_close|마감' plus payroll-crate 'lock|closing|finalize_period|정산': only hits are evidence-WORM comments (migrations/0019, 0051), a vendored spreadsheet frozen-pane enum, a terminal work-order attachment guard (workorder/rest/src/lib.rs:2061), and the '업무 마감' reason-enum label in workflow_studio.rs:136. payroll_draft_runs (0074) is draft readiness, not a period lock. No period-lock table, no write-window enforcement anywhere.",
    "impact": "Payroll-close and accounting-period screens cannot lock a period; any Oyatie 'period closed' badge would be decorative with writes still possible.",
    "recommendation": "Add a period_locks table (org, domain, period, locked_by/at) and a single guard helper called from payroll/financial write paths; wire a close/reopen endpoint with audit."
   },
   {
    "requirement": "Maker-checker/SoD (drafter ≠ approver at decide time)",
    "status": "partial",
    "evidence": "Both halves re-verified in code. Financial SoD real: check_self_approval_tx blocks approver==requested_by/submitted_by with org-lead override writing an anomaly.self_approval governance finding (backend/crates/financial/adapter-postgres/src/lib.rs:1020-1027,2605-2690; tests use_cases.rs:1143,1217). Generic engine: enforce_finalize_policy in backend/crates/workflow/runtime/src/completion.rs:44-100 confirmed (Author mode requires principal==initiated_by; Delegate requires reason+policy guard) — but that guards FINALIZE only. The generic approve path decide_waiting_task (backend/crates/workflow/adapter-postgres/src/lib.rs:1136-1237) checks task status and claimed_by==actor (1204-1205) and never compares actor to run.initiated_by; grep for self-approval/SoD in workflow crates confirms no such check exists. An initiator on the approval line can self-approve any engine-run workflow.",
    "impact": "Oyatie's maker-checker guarantee ('drafter can never be the checker') holds only for financial purchases; every workflow-engine-routed approval screen would silently permit self-approval.",
    "recommendation": "Add an actor != run.initiated_by check (with the financial-style org-lead override + governance finding) inside decide_waiting_task — one guard in the shared decide path covers all engine-run workflows."
   }
  ]
 },
 {
  "dimension": "audit-pbac",
  "findings": [
   {
    "requirement": "Audit envelope (with_audit coverage, fields, append-only)",
    "status": "exists",
    "evidence": "VERIFIED unchanged. Re-checked backend/crates/platform/db/src/audit_tx.rs:56 (with_audit), :111 (with_audits), :194 (insert_audit_event) — all present. AuditEvent shape confirmed at backend/crates/kernel/core/src/audit.rs:66-88 (id, actor Option, validated dot-namespaced action, target_type, target_id, branch_id, org_id, before/after JSON, trace, occurred_at); grep confirms NO reason/justification and NO classification field in audit.rs. WORM migration exists (correct path: backend/crates/platform/db/migrations/0019_harden_worm_and_alert_leases.sql, not backend/migrations). with_audit used across 16 domain families (comms, compliance, dispatch, financial, identity, inspection, kernel, messenger, notifications, platform, registry, reporting, sales, support, workflow, workorder) — the '~25 crates' figure counts individual crates within these families.",
    "impact": "Object activity timelines and audit drawer can render from this envelope today; reason-capture and classification badges cannot.",
    "recommendation": "Add optional reason and classification columns to audit_events + AuditEvent builder when the design's justification/classification UI lands."
   },
   {
    "requirement": "Telemetry enrichment (device ctx, data classification, seq+prev-hash chain, trace id, OCSF/CADF)",
    "status": "partial",
    "evidence": "VERIFIED unchanged. Re-grepped user_agent/ip_addr/device_id/auth_method/prev_hash/classification across backend/crates/kernel and backend/crates/platform/db: zero hits — no device/geo/auth-method or classification fields on audit events. trace_id/span_id persisted at backend/crates/platform/db/src/audit_tx.rs:154-178. No audit-chain crate under backend/crates/platform/ (ls confirms: auth, auth-rest, authz, db, email, excel, group, jobs, platform-rest, provisioning, push, realtime, request-context, storage only) — seq+prev-hash seal work lives on unmerged branch feat/audit-chain-l20. OCSF/CADF appears only in design docs, no backend code.",
    "impact": "Audit detail pane's device/session context, classification chips, and tamper-evidence indicator cannot ship; trace correlation can.",
    "recommendation": "Land the feat/audit-chain-l20 seal worker; add nullable request-context columns (ip, user_agent, auth_method) captured at the REST layer into AuditEvent."
   },
   {
    "requirement": "View (read) auditing + self-view exemption",
    "status": "partial",
    "evidence": "VERIFIED unchanged, with refutation attempt: person view-audit commits (19eb4978 'branch-scoped person-view endpoint + view-audit', b2822a57) exist ONLY on branch feat/console-oyatie-m2a-integration — git merge-base --is-ancestor confirms both are NOT ancestors of HEAD (e02dd0ba, #203). On this checkout only the audit log read itself is audited ('audit.read' at backend/app/src/lib.rs:1782 via audit_read_event, emitted in handler :1667). Grep for person.view/self_view across backend source: zero non-comment hits. No self-view exemption anywhere.",
    "impact": "Sensitive-record access logging (HR/person screens) and the self-view carve-out cannot ship from main; merging PR #202's lane closes the person-view slice.",
    "recommendation": "Merge the feat/console-oyatie-m2a-integration view-audit lane, then generalize the view-audit emission pattern to other sensitive object types with a self-view skip."
   },
   {
    "requirement": "Audit query surface (GET /api/audit filters, timeline, correlation drill, export)",
    "status": "partial",
    "evidence": "VERIFIED unchanged. Route wired backend/app/src/lib.rs:1322 ('/api/audit', get(audit_log)); gate authorize_audit_read :1738 uses Feature::AuditLogRead :1749. AuditQuery struct re-read at :1075-1080 — fields are exactly {limit, offset, target_type, actor}; NO target_id, action, time-range, trace_id, or export params exist. AuditRecord :1090-1105 does return before/after snaps + trace_id/span_id.",
    "impact": "Per-object activity timeline (target_id drill), time-scoped audit search, correlation pivot by trace, and export are all blocked; only a coarse per-type/per-actor list can render.",
    "recommendation": "Add target_id, action, occurred_at range, and trace_id filters to AuditQuery + the fetch SQL (small additive change to one handler); export can be a later streaming variant."
   },
   {
    "requirement": "Cedar PBAC state (shadow call sites, DualEngineMode, policy projection, deny-by-omission pattern)",
    "status": "partial",
    "evidence": "VERIFIED unchanged. DualEngineMode 4 variants confirmed at backend/crates/platform/authz/src/cedar_pbac.rs:277-291. Shadow call site 1: authorize_org_manage_observed guards ~12 RoleManage handlers in backend/crates/identity/rest/src/lib.rs (:589,:609,:649,:670,:699,:750,:826,:874,...), gated by runtime flag cedar_pbac_shadow_role_manage, legacy sole enforcer. Shadow call site 2: backend/crates/workflow/runtime/src/authz_guard.rs pinned LegacyOnly with CedarEvaluation::NotConfigured (:7-10,:31). Freshness claims confirmed backend/crates/platform/auth/src/jwt.rs:66-68 (authz_subject_version/authz_policy_version/session_generation). Policy projection: re-grepped policy_projection/effective_permissions//me/permissions across backend — zero backend hits; only docs/specs/cedar-pbac-coexistence-map.json:51 uiProjectionNonAuthoritative. Deny-by-omission today = legacy Feature/permission matrix (backend/crates/platform/authz/src/lib.rs) + Postgres FORCE-RLS.",
    "impact": "The console's policy-gated rendering has no authoritative backend projection endpoint — frontend must keep deriving gating from JWT claims; per-object Cedar deny-by-omission is not enforceable yet (shadow only).",
    "recommendation": "Ship a /api/v1/me/authz projection endpoint backed by the same legacy matrix now (marked non-authoritative), so the frontend contract is stable before Cedar promotion flips the source."
   },
   {
    "requirement": "Covert clearance / deny-by-omission covert resources / CEO-only audit stream",
    "status": "missing",
    "evidence": "REFUTATION ATTEMPTED, FAILED — confirmed missing. Case-insensitive grep covert/clearance/ceo_only/CEO across backend/**.rs: only prose comments (backend/crates/financial/adapter-postgres/src/lib.rs:2609 org-lead self-approval rule; backend/app/src/workflow_studio.rs:711 compensate-feature doc), an is_org_lead boolean (approval semantics, not clearance), and backend/app/src/hr.rs:5247 explicit_review_clearance (a review-required flag, unrelated). No covert resource flag, no clearance-level model, no separate audit stream.",
    "impact": "Covert-object rendering (objects invisible even in audit/search to non-cleared principals) and the CEO-only audit channel have zero backend substrate.",
    "recommendation": "Model as a Cedar policy dimension (clearance attribute on principal + covert flag on resource) rather than new tables — defer until Cedar promotion so it is not built twice in the legacy matrix."
   },
   {
    "requirement": "Notifications/realtime backend (#198) + messenger MessageNotifier",
    "status": "exists",
    "evidence": "SPOT-CHECKED, confirmed live and wired (not dark). Routes real at backend/crates/notifications/rest/src/lib.rs:24-60 (GET /api/v1/me/notifications, POST .../{id}/read, POST .../read-all, router() registers all three); merged into the app router at backend/app/src/lib.rs:1421 (mnt_notifications_rest::router). Notifiers wired: PostgresMessageNotifier :1301, PostgresNotificationNotifier :1303; realtime WS router merged after timeout layer :1512. Channels confirmed backend/crates/platform/realtime/src/lib.rs:36-37 (message_posted, notification_created), WS path :42 (/api/v1/ws). Merge commit 8db3d177 (#198) is on HEAD's first-parent history.",
    "impact": "Notification center (UI-M2b) and realtime toast/badge updates can be built against this today.",
    "recommendation": "None — backend surface is sufficient for the notification center screens."
   }
  ]
 }
]
```
