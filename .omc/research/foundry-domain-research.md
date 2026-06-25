I have sufficient grounding. The codebase confirms: polymorphic `governance_findings` (entity_type/entity_id) already exists as the Foundry-style polymorphic-link pattern, `financial::tco` exists for cost/residual, `BranchScope` is referenced in the spec as the generalization seed, and there's no `groups` table yet (org-hierarchy is greenfield). I'll now produce the four deliverables.

---

# SPEC INPUTS — Conglomerate Operations Platform (carbon-copy Foundry, no-AI, phased-extraction)

Feeds `docs/specs/knl-business-os.md` finalization + the JIT sub-specs + `/ultragoal` execution. Every section maps Foundry/KR-payroll/domain research onto the existing codebase and slots into the master spec's Track A/B0/B/C/D roadmap. Citations are inline; the full source registries live in the three research blocks.

---

## (1) CARBON-COPY-FOUNDRY MVP CAPABILITY SCOPE — buildable acceptance criteria

The generic, object-centric core = Foundry's **seven-part spine** (Foundry §7), reframed against the master spec's five layers (`knl-business-os.md` §Architecture) and the existing `palantir-blueprint.md` P0–P10 plan. Each capability is stated as **acceptance criteria (AC)** + **codebase mapping** + **nice-to-have deferred**. The blueprint's phase letters (P0–P10) are the build order; this section defines *what "done" means* for each.

### CAP-1 — Ontology catalog (object/property/link/action metadata)
Foundry's four primitives — Object Type, Property, Link Type, Action Type — over a primary-key + title-property contract (Foundry §1). The master spec's "ontology by extraction" (§Strategy) means: **do NOT build the no-code meta-catalog yet**; the ontology in Phases B is *code-defined configs* (one `ObjectViewConfig<T>` per type), and the extractable catalog is deferred to Track-after-B.

- **AC-1.1** Each of the ≥6 core objects (Equipment, WorkOrder, User/Mechanic, Customer, Site, Inspection — `knl-business-os.md` Success §2) is declared as a typed config with: a **primary key**, exactly one **title property** (never a raw UUID surfaced — `safeLabel`), an explicit base-type per property from the workhorse subset (`String, Long/Integer, Decimal, Boolean, Date, Timestamp, Geopoint, Array<scalar>, Attachment-URI, Marking`; Foundry §1), and a declared link set.
- **AC-1.2** Link types carry cardinality (1-1 / 1-N / N-N; Foundry §1) and resolve to existing FKs (1-N) or join tables (N-N). The polymorphic finding→anything link is already realized by `governance_findings(entity_type, entity_id)` (migration 0050, verified) — this is Foundry's interface/polymorphism pattern in production; document it as the canonical polymorphic-link exemplar.
- **AC-1.3** Action types are declared as `{ target_type, rule ∈ {create,modify,delete,add-link,remove-link}, parameters[], submission_criteria }` (Foundry §6) — see CAP-5.
- **Deferred (nice-to-have):** runtime no-code ontology manager UI, shared properties, Struct/Vector/TimeSeries/Cipher base types, change-management diff/restore. (Master spec §Strategy step 3–4: extracted *after* the patterns prove out.)

### CAP-2 — Object Views (the Workshop core, metadata-driven)
Foundry's Object View = one hub per object: properties + links + embedded actions + timeline, rendered by ONE generic component (Foundry §2). This is blueprint **P1 (kit)** + **P2/P7 (configs)**.

- **AC-2.1** ONE `ObjectViewScaffold` + per-type config renders: identity band → PropertiesPanel → LinkedObjectsPanel (each link an `ObjectLink`, click-through) → TimelinePanel → AuditTrailPanel (provenance: source + freshness + AuditEvent stream) → role-gated ActionBar (`palantir-blueprint.md` §Universal Object-View spec). Extracted from the lone working exemplar `WorkOrderDetail.tsx` with **no behavior change first** (refactor-then-extend).
- **AC-2.2** Equipment Object View at `/equipment/:id` (richest inbound links: WOs, Substitutions, CostLedger, Inspections, Quotes, PurchaseRequests, SalesListing) closes the "imported equipment not viewable" bug (#8); the `EquipmentDetailDialog` edit-half becomes an `editEquipment` ActionBar action, the popup survives as a peek with "전체 보기".
- **AC-2.3** ≥6 objects reachable via inter-object links + ⌘K (master spec Success §2).
- **Deferred:** visual drag-drop Workshop layout builder (apps stay JSON-config/hand-authored); Gantt/Pivot/Comments/Media-uploader widgets.

### CAP-3 — Object Set query API (the universal read contract)
Foundry's load-bearing abstraction: every lens/table/filter reads through an Object Set API (filter, link search-around, histogram/listogram facets, aggregates), never raw SQL against base tables (Foundry §0, §3).

- **AC-3.1** A per-object-type query API supporting: equality/range filters, **histogram** (numeric/date bucketing → Postgres `width_bucket`), **listogram** (group-by count), single-stat aggregates (Sum/Avg/Min/Max/Count/Unique), and **search-around-link** (traverse a link type to the linked object set). This is the contract the faceted lens (P5) and triage queues (P4) consume.
- **AC-3.2** Every Object Set read is **RLS-armed** (`app.current_org`) and tested as real `mnt_rt` — never BYPASSRLS (master spec §Code Style + the `rls-verify-as-runtime-role` memory).
- **Deferred:** Quiver time-series cards, Contour path/board ad-hoc analysis over raw tables, compare-object-sets, saved/shared explorations.

### CAP-4 — Scoped RBAC + object/row security (the keystone — Foundry §5 ≈ Postgres RLS)
Foundry layers four mechanisms; three map ~1:1 onto the existing stack. This is master-spec **Track B0** (`org-hierarchy.md` sub-spec + architect + security-review FIRST).

- **AC-4.1 (resource hierarchy → AccessScope):** Generalize the existing `BranchScope { All | Branches[] }` (master spec §Tenancy) into `AccessScope { level ∈ {Group,Org,Region,Branch,Worksite/Team}, node_id }` resolved at login; every list/read intersects the scope subtree, every action checks scope-membership × role (Foundry's project-role discretionary layer, generalized to a tree per Domain-C's NetSuite subsidiary-tree pattern).
- **AC-4.2 (row-level object security → RLS):** The RLS hard boundary **stays at Legal Entity/Org** (`app.current_org`, UNCHANGED). Group consolidated view = **aggregation over per-member ARMED reads** (iterate member 법인, each read RLS-correct under its own org), NEVER a blanket BYPASSRLS read (master spec §Security model — non-negotiable).
- **AC-4.3 (markings → conjunctive mandatory controls):** Highly-sensitive cross-entity data (payroll, financials) stays per-법인 RBAC even within a group unless an explicit group-finance role is granted (master spec §Tenancy) — this is Foundry's conjunctive-markings rule (must satisfy ALL; Foundry §5) realized as a control axis layered on top of org-RLS.
- **AC-4.4 (cross-entity admin):** A cross-entity admin action arms the *specific* target 법인 and is audited; group-admin reaches only their group's members; unrelated orgs invisible (master spec §Security).
- **Deferred:** column-level/cell-level property masking (null-out restricted columns), Foundry-style granular-policy→SQL compiler with operator set, "Expand Access" as a distinct permission, marking propagation through derived data.

### CAP-5 — Action engine + audited write-back (Foundry §6)
One transactional executor; all mutations flow through it; consistent everywhere it's surfaced.

- **AC-5.1** Action type = JSONB `{ target_type, rule, parameters[name,type,required,default,show-if], submission_criteria[predicate, failure_message] }`. Auto-generated React forms from parameters (conditional show/hide).
- **AC-5.2** A single Rust executor: validate params → check submission criteria → check authz (AccessScope × role + org-RLS) → apply in ONE Postgres transaction → write the AuditEvent/edit-history row (Foundry's writeback dataset = the existing audit log + updated row). Matches the master-spec invariant: **all operational mutations go through the audited console API, never direct SQL** (`operations-through-console-only` memory).
- **AC-5.3** ONE action surface: the same validated executor backs the ActionBar in Object View, Object Table, and the Explorer "apply to filtered set" (Foundry's "consistent edits across all applications"). The WorkOrder 16-state FSM + approval line + amount-gated PurchaseRequest FSM are the proof write-back is real.
- **Deferred:** user-authored function-backed actions (MVP ships a fixed library of server-side Rust "edit functions"); side-effects (webhooks/notifications/schedules) beyond the existing realtime/audit; optimistic UI; multi-object batch cascades.

### CAP-6 — Lenses over the same object set (Foundry §3 / Gotham)
Faithful clone of **Object Explorer** (the load-bearing lens), not Quiver/Contour. Blueprint **P5 (Faceted) → P6 (Timeline) → P8 (Graph) → P9 (Map)**.

- **AC-6.1 Faceted (P5, highest ROI, pure-read):** `FacetExplorer` with Histogram/Listogram/StatisticsTable + result table → click-through to Object View + `<LensActionBar>` (apply action to filtered set). The 4 KPI tiles (PM-overdue, cost-per-asset, MTBF, repair-vs-replace) become drag-to-act facets; `GET /analytics/explore` returns per-bucket id-lists (delivers #24).
- **AC-6.2 Timeline (P6):** Equipment lifecycle ribbon (cost-residual step-line under WO points → gross_margin at SOLD) using existing `financial::tco` (verified present) — no new metric store.
- **AC-6.3 Graph (P8):** `RelationshipCanvas` + search-around over Customer→Site→Equipment→WO→Mechanic; the intra-tenant customer-법인 grouping (#37) is a graph write-back.
- **AC-6.4 Map (P9):** wire the existing #29 map's Selection→`<LensActionBar>`; Geopoints render as clustered markers; draw-polygon→`createDispatch`. Don't rebuild the map — make it a lens.
- **Deferred:** Quiver time-series window functions/anomaly, Contour, choropleth, graph layout algorithms beyond force-directed.

### CAP-7 — Ingest→map→materialize (Foundry §4, boundary only)
The ontology consumes cleaned tables; ETL is out-of-band.

- **AC-7.1** CSV/Excel/DB import → raw Postgres table → column-mapping step → materialized/refreshed object table (the indexed read model CAP-3 queries). FLMS equipment masterlist + history import (#19.15 / #35/#38) is the first instance; existing `platform/excel` crate is the seam.
- **Deferred:** visual pipeline builder, live CDC connectors, virtual tables, incremental/streaming sync.

---

## (2) PAYROLL SUB-SPEC INPUTS (`docs/specs/payroll.md` — Track C2, REGULATED)

Feeds the master spec's Track C2 + Success §3 + the "Never ship payroll without (a) effective-dated config (b) golden-case (c) 노무사 sign-off" boundary. **Architectural mandate (KR-Payroll §0): every rate/threshold is a row keyed by `(effective_from, effective_to)` — never a constant** — because the cadences differ (calendar-year for most; **July-1 for the NPS 기준소득월액 상·하한**, the classic bug source).

### (2a) Computation list (the full compute surface the engine implements)
1. **4대보험** — 국민연금 · 건강보험 + 장기요양 · 고용보험(실업급여 + 고안·직능 size-tiered) · 산재(업종별 + 부가요율). Bases differ: 국민연금/건강 use clamped 기준소득월액/보수월액; 고용/산재 on 보수총액; 비과세 (식대 ≤200k, 자가운전 ≤200k) excluded.
2. **근로소득세** — 간이세액표 lookup `(월 과세급여 × 공제대상 가족수)`, 8–20세 자녀 추가공제, worker-selectable **80/100/120%** election (stored per employee), result floored at 0.
3. **지방소득세** = 10% of withheld 소득세 (10원 절사).
4. **주휴수당** (≥15h/주, 209h/월 convention), **연차/연차수당** (≤11 / 15 / +1 per 2yr cap 25), **가산수당** (연장/야간/휴일 +50%/+100%, gated by **5인 미만 flag**), built on **통상임금** (post-2024-12-19 대법원 전합: 고정성 abolished — 재직조건부 정기상여 now included; each pay item flagged 통상임금 포함/제외, effective-dated pre/post the ruling).
5. **퇴직금** (≥1yr & ≥15h; `1일 평균임금×30×재직일/365`; 평균임금 floored at 통상임금; DB/DC variants).
6. **급여명세서** (근로기준법 §48②, mandatory since 2021-11-19; 6 필수 기재사항 incl. per-item 계산방법; up to ₩5M 과태료) — the legal output artifact, every computed figure rendered.
7. **연말정산** (separate reconciliation pass / export).

### (2b) Effective-dated rate/table config model
A single versioned config table family, keyed `(rate_kind, effective_from, effective_to)`, seeded with verified 2025/2026 values (KR-Payroll "What changes yearly"):

| rate_kind | 2025 | 2026 | cadence/boundary |
|---|---|---|---|
| 국민연금 요율 | 9.0% (4.5/4.5) | **9.5%** (4.75/4.75) | Jan-1; phased +0.5%p/yr→13% by 2033 |
| 국민연금 기준소득월액 상·하한 | 40만/637만 (from 2025.7) | **41만/659만 (from 2026.7)** | **July-1 (unique)** |
| 건강보험료율 | 7.09% | **7.19%** (MOHW 보도자료) | Jan-1 |
| 장기요양 | 12.95% of 건보료 | **0.9448% of 보수월액** | Jan-1 |
| 건강보험료 월액 상·하한 | per 고시 | per 고시 (**scrape attachment, don't hardcode blog #**) | Jan-1 |
| 고용보험 실업급여 | 1.8% (0.9/0.9) | 1.8% flat | Jan-1 |
| 고용보험 고안·직능 | size-tier table (0.25/0.45/0.65/0.85%) | same shape | headcount-tier table |
| 산재 업종별 + 부가 (출퇴근 0.6‰, 임채 ~0.6‰, 석면 0.06‰) | 업종코드 lookup | 2026 고시 | Jan-1, employer 100% |
| 최저임금 | ₩10,030 | **₩10,320** | Jan-1 |
| 간이세액표 | NTS file | reissue when 소득세법 changes | irregular — pull live |
| 비과세 한도 | config | per 세법 개정 | config |

Plus per-employee config rows: 부양가족수, 8–20세 자녀수, 원천징수 비율 election, employment type, 5인-미만 flag (사업장), 통상임금 inclusion flags per pay item (effective-dated).

### (2c) Official data sources (build as pull-feeds — master spec "ask-first: payroll data source")
- **국민연금:** nps.or.kr `getOHAF0038M0` + 복지부 고시 via law.go.kr 행정규칙.
- **건강/장기요양:** nhis.or.kr + **mohw.go.kr 보도자료** + law.go.kr 「월별 건강보험료액 상·하한 고시」 (**scrape the 첨부, the summary page omits the won figures**).
- **고용·산재:** moel.go.kr 고시 + 4insure.or.kr.
- **간이세액표 & 전자세금계산서 & 원천징수:** nts.go.kr / hometax.go.kr; machine-readable 간이세액표 on **data.go.kr (dataset 15050747)**.
- **최저임금:** minimumwage.go.kr. **통상임금 판례:** scourt.go.kr (대법원 2024-12-19 전합).

### (2d) Golden-case / 노무사 validation gate (master spec §Testing + Never-boundary)
- **Golden-case tests:** ≥1 known 급여명세서 per pay-type (월급 + 시급) computed end-to-end and asserted line-by-line against a **노무사-validated** worked example; the 간이세액표 implemented as a **lookup against the official NTS file** (bit-exact), not a recomputed formula.
- **Rate-table tests** keyed by effective-date, explicitly covering the **July-1 NPS boundary** crossing.
- **Sign-off gate (BLOCKING for prod):** no payroll/세금계산서 ships without (a) versioned effective-dated config, (b) the golden-case test green, (c) a 노무사/세무사 sign-off. The 노무사 sign-off areas (KR-Payroll §"Where sign-off is prudent"): 통상임금 구성 (post-판결), 평균임금 for 퇴직금, 5인-미만 가산 applicability, 연말정산/비과세 classification. **The engine computes + issues; the licensed professional validates — outputs are reviewable + overridable, never silently authoritative.**
- **Open input to resolve (master spec OQ#3):** pay cycle (월급/시급), 통상임금 components, 노무사 contact.

---

## (3) PER-VERTICAL OBJECT MODELS — configs over the generic primitives + multi-entity pattern

Each vertical is a **configuration over the 10 generic primitives** (master spec §9: Work Item / Asset / Party / Place / Schedule / Approval / Document / Money / Inventory / Message), NOT a bespoke crate. Stated as object configs to feed each vertical's JIT discovery sub-spec.

### (3a) STAFFING (파견·용역) — benchmarked on Bullhorn (Domains §A)
| Object (config) | Primitive | Key fields | Source |
|---|---|---|---|
| ClientCorporation / 거래처(원청) | Party | client legal entity | Bullhorn KB |
| ClientContact / 현장 담당자 | Party | belongs to one Company | Bullhorn |
| Worker / 근로자 | Party | resume, skills, tax info | Bullhorn |
| JobOrder / 배치요청 | WorkItem(request) | title, location, rates | Bullhorn entityref |
| Placement / 현장배치 | WorkItem(active) | **carries both `payRate` + `clientBillRate`** (→ margin), 2yr tenure counter | Bullhorn entityref |
| Timesheet / 근무일지 | WorkItem→Money | hoursWorked → pay+bill | Bullhorn |
| Invoice (AR) + Payroll/4대보험 (cost) | Money | margin = bill − (pay + burden) | Bullhorn Pay-Bill |

**파견법 compliance the config MUST encode (Domains §A.3, HIGH/primary statute):** Contract WorkItem needs explicit **파견 vs 도급** type (mislabel = 불법파견); **제5조③ 제조업 직접생산공정 = 절대금지** → a hard validation forbidding a Placement into a manufacturing Work-Center (the cross-vertical A↔B constraint); **제6조의2 2-year cumulative tenure** per worker×user-company → fires 직접고용 alarm (과태료 3천만, §46); **제34/35 employer-split** (임금: 파견사업주, 연대책임 on 사용사업주 귀책; OSH: 사용사업주 except 정기건강진단). *MEDIUM-confidence flag: the 4대보험 owner-of-record split re-verify against 근로복지공단 before hardcoding.*

### (3b) MANUFACTURING/OEM ERP — the 5 master-data pillars (Domains §B)
| Object (config) | Primitive | Role |
|---|---|---|
| Item/품목 master | Asset(def) + Inventory | costing, MRP params, quality reqs |
| BOM/자재명세서 | structure over Inventory | parent→component lines |
| Work Center/공정·설비 | Asset(resource) | capacity, efficiency, cost/hr |
| Routing + Operations | WorkItem template | ordered ops at work-centers |
| Work Order/생산오더 | WorkItem(instance) | reads BOM (materials) + routing (ops) + item (cost/quality) |
| QC Inspection | WorkItem(gate) | pass/fail at routing hold-points → **fail blocks order completion** |
| Stock/재고 | Inventory | MRP nets demand vs supply |
| Shipment/출하 | WorkItem→Money | final op → customer Invoice (→ AR) |

Workflow: master data → Work Order reads BOM+routing+item → ops at work-centers → QC gates → finished good to inventory → Shipment → invoice (Domains §B, HIGH). **Same Asset/WorkItem/Inventory primitives as FSM** — the forklift WO and the production order are the *same* WorkItem specialization (master spec §9 invariant).

### (3c) MULTI-ENTITY CONSOLIDATION (`org-hierarchy.md` — Track B0, Domains §C)
Benchmarked on NetSuite OneWorld / SAP company-code / 더존 EFIS10 — all converge:
- **Legal-entity = first-class Party node in a rollup tree** (NetSuite subsidiary = unique legal entity w/ own nexus + base currency, ≤250, root owns 100%; SAP company-code = independent legal entity). **Maps to the master spec's existing Org/법인 as the RLS boundary** — generalize the org tree, don't replace the boundary.
- **Three currency layers** (transaction / base / consolidated-reporting w/ FX) → single-entity statements AND consolidated roll-up + side-by-side from the same entity-tagged data.
- **Intercompany + elimination:** every Money doc tagged with owning entity + a `tradingPartner` ref; consolidation auto-generates **elimination entries** against a synthetic elimination Party (NetSuite auto-elimination / SAP ICMR first-common-parent). **The staffing-entity dispatching to the manufacturing-entity is exactly an intercompany case requiring elimination** (cross-vertical A→B billing).
- **Scoped admin = role over a set of entity nodes** (single / sibling-set / subtree) — directly the `AccessScope` generalization of `app.current_org`/`BranchScope` from CAP-4.1, and the master spec's group-admin-consolidated ↔ single-법인 scope selector.

---

## (4) RECOMMENDED PHASE-PLAN SLOTS (consistent with phased-extraction; maps onto master spec §Phased Roadmap)

| Deliverable | Master-spec Track slot | Blueprint phase | Gate before build | Sequencing rationale |
|---|---|---|---|---|
| **CAP-4 Scoped RBAC + org-hierarchy** (3c) | **Track B0** (foundational) | — | `org-hierarchy.md` sub-spec + **architect + security-review FIRST** | Keystone; per-법인 RLS unchanged so doesn't block A/B; precedes any consolidated read/cross-entity admin |
| **CAP-1/2 Ontology configs + Object-View kit** | Track B | **P0→P1** | extract from `WorkOrderDetail`, no behavior change | Load-bearing keystone everything reuses |
| **CAP-2 Equipment Object View** | Track B | **P2** | — | Richest links; closes #8 |
| **CAP-3 Object Set API + ⌘K nav + DataTable** | Track B | **P3** | — | Universal read contract + traversability |
| **CAP-5 Action engine** (formalize) | Track B (cross-cuts) | P1+ | audit-coverage + rls-arming gates | Already proven by WO/PurchaseRequest FSM; generalize |
| **Triage Home** | Track B | **P4** | — | "What needs me now"; v1 = existing list endpoints |
| **CAP-6 Lenses** (Faceted→Timeline→Graph→Map) | Track B | **P5→P6→P8→P9** | — | Faceted first (pure-read, #24 ROI); Map last (#29 reuse) |
| **CAP-7 Ingest→materialize** | Track B | folds into #35/#38 | — | FLMS import (#19.15) first instance via `platform/excel` |
| **PAYROLL** (2) | **Track C2** | — | `payroll.md` sub-spec + **effective-dated config + golden-case + 노무사 sign-off (BLOCKING)** | After C1 HR core (Employee/직급/조직도/attendance/leave); regulated gate |
| **STAFFING vertical** (3a) | Track C (new vertical) | reuses kit | JIT discovery sub-spec + 파견법 validation rules | Configures existing WorkItem/Party/Money primitives; encode 파견법 constraints |
| **MANUFACTURING vertical** (3b) | Track C (new vertical) | reuses kit | JIT discovery sub-spec | Same Asset/WorkItem/Inventory as FSM; A↔B 절대금지업무 hard constraint |
| **Accounting / Procurement-AP / Inventory / Sales-AR** | Track C (C3–C6) | reuses kit | each a JIT sub-spec | After payroll; intercompany-elimination (3c) ties into Track B0 |

**Extraction discipline (master spec §Strategy):** ontology stays *code-config* through Track B; the no-code ontology engine (CAP-1 deferred items) is extracted only *after* ≥6 object configs + the action engine + lenses prove the patterns — never speculatively. Each regulated/vertical domain gets its own approved sub-spec before code; this master spec is the umbrella + invariants.

**Non-negotiables threaded through all phases** (master spec §Boundaries + memories): every tenant read/write arms `app.current_org` + a real `mnt_rt` test (never BYPASSRLS); all operational mutations via the audited console Action engine (never direct SQL); `safeLabel` (no raw UUID); openapi-first + regen clients; authoring/review separate passes; payroll/세금계산서 never ship without the three-part regulated gate; storefront untouched (`.console`-scoped skin).

**Key anchor files for `/ultragoal`:** kit → `web/src/features/object-view/*` (new, from `web/src/features/dispatch/WorkOrderDetail.tsx`); tokens → `web/src/styles.css` + `web/src/lib/semantic.ts`; RBAC seed → `backend/crates/identity/domain` (`BranchScope`→`AccessScope`); polymorphic-link exemplar → `governance_findings` (migration 0050); cost/residual for Timeline lens → `backend/crates/financial/domain/src/tco.rs`; ingest seam → `backend/crates/platform/excel`; payroll → new `backend/crates/payroll/*` + `docs/specs/payroll.md`; org-hierarchy → new `groups` table + `docs/specs/org-hierarchy.md` (greenfield — no `groups` table exists yet).