# Ontology Lifecycle Coverage Matrix

Assessment of every console business-object type against the three ontology
layers (Semantic / Kinetic / Dynamic) plus UI and Tests. Evidence-based, cites
`file:line`. Read-only audit — no code changed.

## How to read the layers

- **Semantic** — is it a *registered ontology type* (a row in `ont_object_types`
  with typed `ont_property_defs` + `ont_link_types`, seeded through the engine),
  or a plain domain table with no type registration? Real backend registration
  today = **only** the 2 governed-config types seeded in
  `crates/ontology/adapter-postgres/src/seed.rs` (`support_slo_setting`,
  `console_view`). The frontend `ONT_TYPES` mirror
  (`web/src/console/modules/typeRegistry.ts:122`) hand-declares 5 more
  (`finance_voucher`, `equipment`, `employee`, `approval`, `support_ticket`) but
  is explicitly `wire-pending` (file header) — a display schema, **not** backing
  `ont_object_types` rows. So "registered in the engine" and "mirrored in the FE
  registry" are two different, mostly-disjoint facts; both are called out.
- **Kinetic** — lifecycle FSM. Two kinds: the **generic engine
  instance-lifecycle** (`ont_instances` draft→active→locked→archived→disposed,
  `crates/ontology/domain/src/lib.rs:248` + `validate_instance_lifecycle_transition:282`)
  vs a **bespoke domain FSM** (workorder status, compliance per-object status,
  governance config-driven lifecycle, docs custody, etc.). "Audited" = mutation
  routes through `mnt_platform_db::with_audit(s)` (`crates/platform/db/src/audit_tx.rs`).
- **Dynamic** — acting-read / decision-feed / series / as-of / analytics. Real
  surface today: **only ontology instances** get `acting_on_instance`
  (`adapter-postgres/src/lib.rs:571`), `get_as_of` (`instances.rs:355`),
  `history` (`instances.rs:392`) and `ont_analytics` (`lib.rs:508`). Cedar
  decisions are logged globally in `cedar_decision_log`
  (`crates/platform/authz-rest/src/store.rs:488`) but not surfaced per object.
- **UI** — opens as the shared 3-layer `ObjectCard`
  (`web/src/console/objectcard/`) via a real `ObjectCardDescriptor`, vs a bespoke
  panel, vs no web UI.
- **Tests** — any lifecycle-transition or RLS-as-`mnt_rt` test covering it.

---

## Condensed coverage table

Legend: ✅ EXISTS · ◐ PARTIAL · ✗ MISSING

| Object (code) | Semantic | Kinetic | Dynamic | UI | Tests |
|---|---|---|---|---|---|
| **work order** WO- | ✗ plain table, no type reg | ✅ bespoke 16-state FSM `workorder/domain/src/lib.rs:1196`, audited `adapter/…:133` | ✗ none | ◐ bespoke legacy `pages/WorkOrderDetailPage.tsx`, no card | ✅ `domain/tests/workorder_fsm.rs` + RLS `rls_read_surfaces_as_runtime_role.rs` |
| **contract** C- | ✗ **no table, no type, no crate** | ✗ | ✗ | ✗ only a finance link-chip `resourceKind:"contract"` (`moduleScreens.ts:461`) | ✗ |
| **employee** HR- | ◐ FE mirror only (`typeRegistry.ts:204`); real table `employees` (mig 0063) not engine-registered | ◐ REST lifecycle-events FSM `hr.rs:432` (`from_status/to_status`), audited `hr.rs:1057`; inline, no kernel FSM | ✗ | ✅ shared card via FE registry (no list screen); legacy `pages/EmployeesPage.tsx` | ✗ no crate test (hr.rs in `app/`) |
| **position** | ✗ **not an entity** — string col `employees.position` (`hr.rs:215`) | ✗ | ✗ | ✗ | ✗ |
| **compliance obligation** CP- | ✗ plain table `compliance_obligations` (mig 0101), no type reg | ✅ bespoke `validate_obligation_status_transition` (`compliance/adapter/…:1002`), audited `:131` | ✗ | ✗ no web UI (0 refs) | ◐ RLS `location_consent_status_rls…`; no obligation-FSM unit test |
| **regulation** RG- | ✗ plain table `compliance_regulations`, no type reg | ✅ `validate_regulation_status_transition` `…:977`, audited | ◐ validity window `valid_from/valid_to` `…:832` (no as-of read fn) | ✗ no web UI | ◐ RLS only |
| **standard framework** FW- | ✗ plain table `compliance_frameworks`, no type reg | ✅ `validate_framework_status_transition` `…:1027`, audited | ✗ | ✗ no web UI | ◐ RLS only |
| **policy (Cedar)** | ✗ `cedar_policy_catalog_entries` (mig 0103/0107), not an ont type | ◐ draft/publish staging FSM (catalog vs draft), audited | ✅ `cedar_decision_log` global decision feed (`authz-rest/store.rs:488`) | ✅ bespoke canvas `console/policycanvas/PolicyCanvasScreen.tsx` | ◐ authz cedar tests |
| **approval** AP- | ◐ FE mirror (`typeRegistry.ts:236`); backed by `gov_approval_requests` (mig 0112) | ✅ governance config-driven `validate_lifecycle_transition` (`governance/…:90`) + `gov_lifecycle_transitions`, audited `:95` | ✗ | ◐ shared card via registry + bespoke compose `console/appr/ApprovalCompose.tsx` | ✅ RLS `governance_rls…`, `approvals_create_as_runtime_role.rs` |
| **attendance** AT- | ✗ plain `site_attendance_events`/`employee_attendance_records`, no type reg | ✗ event log, no FSM | ✗ | ◐ bespoke legacy `pages/AttendancePage.tsx` | ◐ site-attendance tests (app-level) |
| **work log** JL- | ✗ no distinct table / type found | ✗ | ✗ | ✗ no web UI (0 refs) | ✗ |
| **payslip / payroll** PS- | ✗ plain `payroll_draft_runs/lines` (mig 0074), no type reg | ◐ string-status draft runs, no FSM fn | ✗ | ◐ bespoke legacy `pages/PayrollPage.tsx` | ✗ |
| **record/registration** IN- | ✗ design catalog code, no dedicated table | ✗ | ✗ | ✗ | ✗ |
| **ingest** DX- | ◐ `data_import_runs` (mig 0070) + `attendance_direct_import_events` | ◐ import-run status, no FSM fn | ✗ | ◐ import panels (legacy) | ◐ import RLS tests (registry master-import) |
| **evidence** EV- | ✗ plain `docs_evidence_objects` (mig 0104), no type reg | ✅ bespoke 13-stage custody FSM `docs/domain/…:361`, audited `adapter/…:154` | ✗ (custody = append log) | ✅ shared card + bespoke chrome `evidence/EvidenceCard.tsx:446` wrapping `<ObjectCard>` (`evidenceModel.ts:107`) | ✅ RLS `evidence_rest_rls_surfaces_as_runtime_role.rs` |
| **posting** JP- | ✗ **no table** — accounting is cost-ledger append, no posting entity | ✗ no posting FSM | ✗ | ✗ (only `finance_voucher.postVoucher` action label in FE) | ✗ |
| **voucher** VC- (finance_voucher) | ◐ FE mirror (`typeRegistry.ts:123`); **no backend voucher table/FSM** — `CostLedgerSource` append model (`financial/application/…:93`) | ✗ no voucher/posting FSM; only `PurchaseStatus` enum (`financial/domain/…:110`) | ✗ | ✅ shared ObjectCard + live module screen (`moduleScreens.ts:340`) | ✅ RLS `lifecycle_rls_surfaces_as_runtime_role.rs` |
| **purchase** PO- | ✗ plain table, no type reg | ◐ `PurchaseStatus` enum, no transition fn | ✗ | ◐ finance module surfaces | ✅ financial `use_cases.rs`, RLS |
| **applicant/candidate** | ✗ no table / type found | ✗ | ✗ | ✗ no web UI | ✗ |
| **support ticket** SUP- | ◐ FE mirror (`typeRegistry.ts:267`); real `support` crate table, not engine-registered | ✅ bespoke `TicketStatus.transition_to` (`support/domain/…:80`), audited `adapter/…:116` | ✗ | ◐ shared card via registry (no list screen); legacy `pages/SupportPage.tsx` | ✅ `rest/tests/intake.rs`, `authz.rs`, RLS |
| **series** SR- | ✗ design catalog code; only `ont_analytics` derived props exist | ✗ | ◐ `ont_analytics` per ont type (`ontology/…:508`) | ✗ | ✗ |
| **ontology type-def** OT- | ✅ `ont_object_types` schema-lifecycle (`domain/…:83`) — the registry itself | ✅ schema-lifecycle FSM draft→published, audited | ◐ registry read APIs | ✅ `OntologyManagerScreen.tsx` (shared card + editor) | ✅ `config_object_types_as_runtime_role.rs`, `registry_rls…` |
| **user object** OB- (generic instance) | ✅ **the model** — `ont_instances` typed by `ont_object_types` | ✅ generic instance-lifecycle FSM, audited `instances.rs:26` | ✅ **only full dynamic**: `acting_on_instance`, `get_as_of`, `history`, `ont_analytics` | ✅ shared card via API `ontology/wire.ts:297` | ✅ `instances_rls…`, `action_execute…`, `instances_residual_filter…` |
| **meeting** MT- | ✗ no table / type found | ✗ | ✗ | ✗ | ✗ |
| **module** MD- | ✗ design catalog code (console module = FE construct) | ✗ | ✗ | ◐ FE module engine (`console/modules/`) | ◐ `moduleEngine.test.tsx` |
| **leave request** | ✗ plain `leave_requests` (mig 0111), no type reg | ✅ leave-workflow states (mig 0111), audited via hr | ✗ | ✅ shared card `leave/model.ts:236` + `LeaveConsole.tsx:458` | ◐ `LeaveConsole.test.tsx` (FE); BE via hr |
| **leave promotion round** | ✗ plain `leave_promotion_rounds`, no type reg | ◐ round/target states, audited | ✗ | ✅ shared card `leave/model.ts:356` | ◐ FE test |
| **SLO setting** | ✅ **engine-registered** — `support_slo_setting` seeded `seed.rs:73` | ✅ generic instance-lifecycle (it's an ont instance) | ◐ instance-layer (acting/as-of/history) | ✗ no dedicated card (only `support_ticket.sloDueAt` prop) | ✅ `config_object_types_as_runtime_role.rs` |
| **console view** | ✅ **engine-registered** — `console_view` seeded `seed.rs:114` | ✅ generic instance-lifecycle | ◐ instance-layer | ◐ bespoke `configconsole/DashboardEditor.tsx` (not a card) | ✅ `config_object_types…`, `DashboardEditor.test.tsx` |
| **workflow definition** | ✗ plain `workflow` tables, no type reg | ✅ run/node FSM `workflow/runtime/engine.rs:90` + definition publish `workflow_studio.rs:189`, audited | ✗ | ✅ bespoke canvas `console/workflows/WorkflowAutoScreen.tsx` | ✗ no `crates/workflow/*/tests/` dir (inline only) |
| **schedule** | ◐ `inspection` schedules; no generic schedule type | ✅ `InspectionScheduleStatus` FSM (`inspection/domain/…:59`), audited | ✗ | ◐ inspection surfaces | ✅ `inspection/…/tests/lifecycle.rs`, RLS |
| **equipment/asset** FL- | ◐ FE mirror (`typeRegistry.ts:164`); real `registry_equipment`, not engine-registered | ◐ `EquipmentStatus` enum, **no transition fn** (`registry/domain/…:80`), audited `adapter/…:129` | ✗ | ✅ shared ObjectCard + live module screen (`moduleScreens.ts:483`) | ✅ many RLS `create_rls…`, `equipment_list_rls…`, `master_list_import_rls…` |
| **customer/site** | ✗ plain table, no type reg | ✗ no FSM | ✗ | ◐ bespoke legacy `pages/SitesPage.tsx`, `CustomerIntakePage.tsx` | ◐ identity/registry RLS |
| **inventory** IV- | ✗ plain `inventory_items` (mig 0109), no type reg | ◐ `InventoryItemStatus` enum, **no transition fn** (`inventory/domain/…:14`), audited `adapter/…:92` | ✗ | ✗ no console UI (legacy refs only) | ✗ no `crates/inventory/*/tests/` dir |
| **messenger thread** | ✗ plain `messenger_*` (mig 0114), no type reg | ✗ no thread FSM (only `PresenceStatus` helper) | ✗ | ◐ bespoke `console/messenger/MessengerConsoleScreen.tsx` | ◐ `use_cases.rs`, `thread_kind.rs` (no RLS-as-role) |
| **mail** | ✗ plain table, no type reg | ✗ | ✗ | ◐ bespoke `console/mail/MailScreen.tsx` | ◐ comms tests |
| **notification** | ✗ plain table, no type reg | ✗ | ✗ | ◐ bespoke/legacy (72 refs, no card) | ◐ notif backend tests |
| **board notice** NT- | ✗ plain table, no type reg | ✗ | ✗ | ◐ bespoke `pages/WallBoardPage.tsx` | ◐ |

---

## Cross-cutting findings

1. **Semantic layer is near-empty.** Only **4 things** are genuinely registered
   ontology types: the registry itself (`OT-`), generic instances (`OB-`), and
   the 2 seeded governed-config types (`support_slo_setting`, `console_view`,
   `seed.rs`). Every real business object — work order, employee, equipment,
   voucher, compliance, approval — is a **plain domain table with no
   `ont_object_types` registration**. The FE `ONT_TYPES` registry
   (`typeRegistry.ts`) hand-mirrors 5 of them for display but is `wire-pending`
   and not backed by engine rows. This is the single largest gap.

2. **Kinetic layer is strong but fragmented.** Real bespoke FSMs with
   transition-validation fns exist for workorder, compliance (4 objects),
   governance, docs custody, support, inspection, workflow run/node, and the
   generic ontology instance-lifecycle. **All mutations are audited** via
   `with_audit(s)` — audit coverage is effectively universal. But several
   "statuses" are **enum-only with no transition fn** (equipment, inventory,
   sales, purchase, messenger) — no guarded transitions.

3. **Dynamic layer barely exists off the engine.** `acting_on_instance`,
   `get_as_of`, `history`, `ont_analytics` are **only** wired for
   `ont_instances`. No domain table gets acting-read, series, or as-of. Cedar
   decisions log globally but aren't surfaced per object.

4. **Version/as-of history exists in exactly one place** — ontology instances
   (`get_as_of` + `history` revision chain). Every other domain is append-log or
   nothing.

5. **UI: shared ObjectCard reaches ~10 types** (finance_voucher, equipment,
   employee, approval, support_ticket via the FE registry; leave_request /
   ledger / promotion_round; evidence wrapped; any generic ontology instance via
   `wire.ts`). Everything else is a **bespoke/legacy panel** (work order,
   attendance, payslip, policy, workflow, messenger, mail, board, sites) or
   **has no web UI** (contract, position, obligation, regulation, framework,
   work log, applicant, inventory).

6. **The DESIGN §3 north-star chain C-→Position→Posting→Employee is broken at 3
   of 4 links.** `contract` (C-), `position`, and `posting` (JP-) **do not exist
   as tables, types, FSMs, or UI anywhere in the repo**. Only `employee` exists
   (as a plain table + FE mirror). Financial has **no voucher/posting FSM** — the
   `VC-`/`JP-` premise is a FE display label over a cost-ledger append model.

---

## Top-10 gap lanes (ranked by design-criticality)

Ranked against the DESIGN §3 north star (the C-→Position→Posting→Employee
governance chain) and the semantic-registration deficit.

1. **Contract (C-) — build from zero.** No table, type, FSM, or UI. It is the
   head of the north-star chain (contract → drives postings/employees/vouchers).
   Highest-value greenfield lane: table + engine type registration + lifecycle
   FSM (draft/active/expired/terminated) + ObjectCard.

2. **Position — build from zero as a first-class entity.** Currently a bare
   string column `employees.position` (`hr.rs:215`). The org/RBAC model
   (Group→법인→branch→worksite scoped roles) needs positions as real objects with
   link types to employee + org unit. Register as ont type + FSM.

3. **Posting (JP-) / Voucher (VC-) — real backend accounting object.** Today
   `finance_voucher` is a FE-only mirror over an append cost-ledger; there is **no
   voucher/posting table or FSM**. Build the double-entry posting object with a
   real draft→posted→reversed FSM, audited, and back the FE registry with engine
   rows. Closes the tail of the north-star chain.

4. **Register the existing domain tables as engine ontology types
   (semantic-layer backfill).** The biggest structural gap: work order,
   equipment, employee, support_ticket, approval, purchase, compliance objects
   are all plain tables. Seed them through `seed.rs` (as `finance`/`console_view`
   were) or via `BackingKind::Table` so the FE `ONT_TYPES` mirror stops being
   `wire-pending` and they gain acting/as-of/analytics for free.

5. **Dynamic-layer surfacing for domain objects.** Extend `acting_on_instance` /
   `get_as_of` / `history` / `ont_analytics` beyond `ont_instances` to the
   registered domain types (depends on lane 4). Gives every object the decision
   feed + as-of read that only the generic engine has today.

6. **Compliance obligation/regulation/framework UI.** FSMs and audit exist
   (`validate_*_status_transition`) but there is **zero web UI** — no ObjectCard,
   no screen. High design-criticality (CP-/RG-/FW- are catalog §2 objects). Wire
   them to the shared ObjectCard via `objectCardDescriptorFrom`.

7. **Work order into the ontology + shared card.** Strong FSM + tests, but plain
   table and bespoke legacy `pages/WorkOrderDetailPage.tsx` only. Register as ont
   type and route through the 3-layer ObjectCard (drop the legacy page).

8. **Employee: promote from FE-mirror to engine-registered + BE tests.** Real
   table + REST lifecycle-events FSM exist but no engine registration and **no
   crate-level FSM/RLS test** (hr.rs lives in `app/`). Register the type, add
   lifecycle-transition + RLS-as-`mnt_rt` tests.

9. **Guard the enum-only "FSMs."** equipment, inventory, purchase, sales,
   messenger expose a status enum with **no transition-validation fn** — any
   value can be written. Add `validate_*_transition` + tests (inventory and
   workflow have **no `tests/` dir at all**).

10. **Attendance / payslip / work-log (JL-) lifecycle + registration.** Core HR
    operational objects are event-log tables with bespoke legacy pages and no
    type registration; work-log (JL-) has no table at all. Model them as ont
    types with FSMs to complete the HR object family behind the employee node.

---

*Method: greps + reads across `backend/crates/{ontology,workorder,workflow,
compliance,governance,financial,docs,inventory,support,messenger,registry,
inspection,sales}`, `backend/app/src/hr.rs`, migrations `0100–0114`, and
`web/src/console/{modules/typeRegistry.ts,objectcard,leave,evidence,ontology,
explore}` + `web/src/api`. Two parallel Explore agents corroborated the FSM/test
and UI-consumer findings. No files committed.*

---

# Section A — Default Type Catalog (beyond Palantir)

Palantir Foundry ships a generic object/link/action *model* with **zero domain
types** — every customer builds their own ontology. Our directive is the
opposite: the console must **ship a rich default catalog** for the niche (Korean
conglomerate outsourcing / 노무·현장 operations) so a new tenant is productive
out-of-the-box, not staring at an empty registry.

**Reality today:** exactly **2** types are shipped-by-default through the engine
seed — `support_slo_setting`, `console_view` (`seed.rs:73,114`). The 5 FE-mirror
types (`typeRegistry.ts`) are display-only, `wire-pending`, not seeded. So the
"default catalog" is essentially empty vs the ambition below.

Classification columns:
- **Ship status** — `SEEDED` (seed exists) · `NEEDS-SEED` (schema/crate exists,
  no engine seed) · `NEEDS-SCHEMA` (no table/crate yet).
- **Backing** — `INSTANCE` (pure config/data → an `ont_instances` type, **cheap
  to seed now** via `seed.rs` pattern, no new crate) · `DOMAIN` (needs a domain
  crate/table: transactional FSM, money/legal correctness, heavy joins).

## A.1 — Types already in the matrix (domain-backed, need engine *registration*)

| Type | Ship status | Backing | Note |
|---|---|---|---|
| work order WO- | NEEDS-SEED | DOMAIN | table+FSM exist; register type |
| equipment FL- | NEEDS-SEED | DOMAIN | table exists; FE mirror only |
| employee | NEEDS-SEED | DOMAIN | `employees` table; FE mirror only |
| approval AP- | NEEDS-SEED | DOMAIN | `gov_approval_requests` |
| support ticket SUP- | NEEDS-SEED | DOMAIN | support crate |
| voucher VC- / purchase PO- | NEEDS-SEED | DOMAIN | financial crate (no posting FSM) |
| evidence EV- | NEEDS-SEED | DOMAIN | docs crate custody FSM |
| compliance obligation CP- / regulation RG- / framework FW- | NEEDS-SEED | DOMAIN | compliance crate FSMs |
| leave request / promotion round | NEEDS-SEED | DOMAIN | hr leave-workflow |
| inventory IV- | NEEDS-SEED | DOMAIN | inventory crate |
| messenger thread / mail / notification / board NT- | NEEDS-SEED | DOMAIN | comms/messenger crates |
| workflow definition | NEEDS-SEED | DOMAIN | workflow crate |
| SLO setting · console view | **SEEDED** | INSTANCE | the only two shipped today |

## A.2 — Niche types the design carries that generic platforms lack

These are the differentiators. Most are **INSTANCE-backed → seedable *now*** with
the `seed.rs` `CreateObjectTypeDraft` pattern (no new crate), which is the fast
path to a rich default catalog.

| Niche type | Ship status | Backing | Evidence / rationale |
|---|---|---|---|
| **SLO / SLA setting** (per ticket-type) | SEEDED (SLO) / NEEDS-SEED (SLA) | INSTANCE | `support_slo_setting` seeded; SLA = second instance type |
| **console view / dashboard layout** | SEEDED | INSTANCE | `console_view` seeded |
| **handover policy HO-** (인수인계) | NEEDS-SCHEMA | INSTANCE | no `handover`/`HO-` anywhere in repo; pure config → seedable |
| **APPR routing** (결재선/approval matrix) | NEEDS-SEED | INSTANCE | `gov_lifecycle_transitions` config exists; expose as an instance type |
| **교대/shift · timetable** | NEEDS-SCHEMA | INSTANCE | no shift/timetable table; roster config → seedable |
| **position / TO** (직책·정원) | NEEDS-SCHEMA | DOMAIN | today only string col `employees.position` (`hr.rs:215`); org/RBAC needs it real |
| **인력풀 / workforce-pool member** | NEEDS-SCHEMA | DOMAIN | no `workforce`/`인력풀`/`labor_pool` in repo; roster w/ availability FSM |
| **per-shift 근로계약 C-D** (일용/단시간) | NEEDS-SCHEMA | DOMAIN | no `contract`/`C-` table; legal doc + validity FSM |
| **대근 / substitution** | NEEDS-SCHEMA | DOMAIN | no substitution entity (only generic org-rollout hits); links attendance↔employee |
| **4대보험 filing** (건강·국민·고용·산재) | NEEDS-SEED | DOMAIN | `crates/payroll/domain` + `hr.rs` carry pieces; filing record = new type |
| **법정 수령확인 문서** (inbox legal doc) | NEEDS-SCHEMA | DOMAIN | no receipt-confirmation inbox; ties to `docs`/evidence custody |
| **연차촉진 round** (leave-promotion) | NEEDS-SEED | DOMAIN | `leave_promotion_rounds` (mig 0111) exists; register type |
| **노무수령거부** (refusal-to-receive-labor) | NEEDS-SCHEMA | INSTANCE | no entity; legal-status record → seedable instance |
| **규제 파라미터 RG-** (최저임금 고시, 주52h) | NEEDS-SCHEMA | INSTANCE | `compliance_regulations` is text FSM, no *parameter* type; min-wage/52h are org-scoped config → seedable |
| **PIPA consent** (개인정보 동의) | NEEDS-SEED | DOMAIN | `LocationConsentState` FSM in compliance crate; register consent type |
| **현장 coverage** (worksite staffing coverage) | NEEDS-SCHEMA | INSTANCE | no coverage entity; derived config/analytic |
| **계약 수익성 analytics** (contract margin) | NEEDS-SCHEMA | INSTANCE | `ont_analytics` mechanism exists; add analytic defs once contract type lands |
| **감사 이벤트** (audit event) | NEEDS-SEED | DOMAIN | audit stream exists (`ceo_covert_audit_stream` mig 0100); surface as read-only type |

**Takeaway:** ~7 of the niche types (SLA, handover, shift/timetable, 노무수령거부,
RG- parameters, 현장 coverage, 계약 수익성) are **INSTANCE-backed and seedable in the
same PR** that seeded SLO/console_view — the cheapest, highest-visibility way to
make the default catalog feel "beyond Palantir." The rest (position, workforce
pool, per-shift contract, substitution, 4대보험 filing, 수령확인 inbox) carry real
transactional/legal correctness and need domain crates — these are the
north-star chain and belong on the build lanes in the main matrix.

---

# Section B — No-code "add-a-type" wiring path (end-to-end intuitiveness test)

**Question:** a tenant admin opens the Ontology Manager (`OntologyManagerScreen`),
clicks 타입 추가, defines properties/links, publishes. What lights up
**automatically**, and what silently requires an engineer to edit code?

Traced every consumer hop. Verdict up front: **NOT intuitive end-to-end
no-code.** The new type is a first-class *registry* citizen (it lists, opens as
an ObjectCard, is policy-referenceable), but **≥6 downstream consumers are
hardcoded** and silently ignore it — most dangerously the object-code grammar,
which will **fail to parse/drag the new type's codes**.

## B.1 — Hop-by-hop

| Hop | Auto or manual? | Evidence |
|---|---|---|
| **Registry list / detail** | ✅ AUTO | `model.ts:99` 타입 추가 appends draft w/ next free OT- code; lists via engine |
| **ObjectCard (3-layer) open** | ✅ AUTO | generic `objectCardDescriptorFrom` (`wire.ts:297`) renders any type from the API |
| **Explore graph / traversal** | ✅ AUTO | `ObjectExplorerScreen` `nodeDescriptor` is type-agnostic (API-driven) |
| **Instance CRUD (create/edit)** | ❌ **MANUAL** | no-code 타입 추가 sets **`actions: []`** (`model.ts:121`); the generic `create` action that `seed.rs:47` hand-builds is **not** auto-attached → **no way to create an instance** until an admin authors an action. The engine's instance-create path *requires* an `InstanceRevision` `create` action (`seed.rs` header). |
| **Module surface / list screen** | ❌ **MANUAL** | `MOD_SCREENS` is a hardcoded 2-entry map `{finance, asset}` (`moduleScreens.ts:610`) with a `finance` fallback; new type gets **no** list screen |
| **Nav / route** | ❌ **MANUAL** | routes hardcoded per screen (`moduleScreens.ts:343` `/console`, `:486` `?screen=asset`) |
| **objDrag / token-grammar (code prefix)** | ❌ **MANUAL — silent failure** | **prefix alternation hardcoded in 3 files** and must stay in sync: `objDrag.ts:17`, `messengerModel.ts:33`, `composeModel.ts:209` — all `(?:AP\|WO\|AT\|CS\|JL\|PS\|IN\|DX\|Bid\|MT\|EV\|OT\|SR\|PAY\|EQ\|VC\|FL\|HR\|TK\|C\|R)-`. A new type's code prefix is **not in the regex → its codes won't parse, won't render as object chips, won't drag, won't autocomplete in messenger/approval compose.** There is already a `ponytail:` comment at `objDrag.ts:13` admitting the triplication. |
| **Policy resource candidate** | ◐ PARTIAL | `policycanvas/model.ts:35` `resource_type` is a **free-text** field — any string (incl. the new key) is accepted, but there is **no dropdown/autocomplete** sourced from `ONT_TYPES ∪ POL_BLOCKS`; not discoverable |
| **Automation trigger/action candidate** | ◐ PARTIAL | `api/automate.ts:21` `objectType: string` free field; works if typed, no registry-derived candidate list |
| **ko.ts label path** | ❌ **MANUAL** | `nameKey`/`labelKey` resolve dotted `ko` keys (`typeRegistry.ts:18` `resolveText`); a new type has no `ko.ts` entry → labels fall back to the raw key literal |
| **FE `ONT_TYPES` registry** | ❌ **MANUAL** | hand-authored constant (`typeRegistry.ts:122`), `wire-pending`; module rendering/columns/chips for the type require a code edit here |

## B.2 — Ordered list of MANUAL steps today (each = an automation-gap lane)

To make a *new* no-code type actually usable across the console, an engineer
currently must:

1. **Attach a generic `create` action** to the type (or teach 타입 추가 to auto-seed
   one like `seed.rs:47`) — otherwise instances can't be created. *(highest:
   blocks the core loop)*
2. **Add the code prefix to the 3 hardcoded regexes** (`objDrag.ts:17`,
   `messengerModel.ts:33`, `composeModel.ts:209`) — otherwise codes silently
   don't parse/drag/mention. *(highest: silent failure)*
3. **Register a `MOD_SCREENS` entry + route** (`moduleScreens.ts:610`) for a list
   surface + nav.
4. **Add `ko.ts` label keys** for the type name, properties, choices, actions.
5. **Add an `ONT_TYPES` FE-registry entry** (`typeRegistry.ts`) for column/chip/
   detail rendering (until the registry is fetched from the API per the file's
   own `wire-pending` note).
6. *(soft)* Add the type to policy/automation candidate lists for discoverability
   (works as free-text without this, but not intuitive).

## B.3 — Verdict

**Not "intuitive end-to-end no-code" per the directive.** The engine half is
genuinely dynamic — a new type lists, opens as a 3-layer ObjectCard, traverses in
Explore, and is policy/automation-referenceable as free text. But the
**presentation + interaction half is a hardcoded allow-list**: instance creation,
module screens, nav, the object-code grammar, and i18n all require code edits,
and the object-code grammar fails **silently**. The single most important fix is
to **derive the object-code prefix set (and the `create` action, MOD_SCREENS,
label fallbacks) from the registry** instead of hand-maintained constants — collapse
steps 1-5 into "publish the type." Until then, "no-code add-a-type" is really
"no-code add-a-registry-row, then file an engineering ticket to wire it up."

### Top automation-gap lanes (drives making type registration fully automatic)

1. **Registry-derived object-code grammar** — replace the 3 triplicated regexes
   with one prefix set fetched from the ontology registry (`code`/`codePrefix`
   already exist on every type). Kills the silent parse/drag failure.
2. **Auto-attach the generic `create` action on type publish** — port `seed.rs`
   `create_action` into the 타입 추가 flow so instance CRUD works with zero code.
3. **Data-driven module screens + nav** — make `MOD_SCREENS`/routes resolve from
   the registry (a `GenericModuleScreen` already exists; feed it the type).
4. **Fetch `ONT_TYPES` from `GET /ontology/object-types`** — retire the
   hand-authored FE mirror (the file's own `wire-pending` plan) so columns/chips/
   labels come from the published schema.
5. **Registry-sourced candidate lists** for policy `resource_type` and automation
   `objectType` (autocomplete from `ONT_TYPES ∪ POL_BLOCKS`) — discoverability.
