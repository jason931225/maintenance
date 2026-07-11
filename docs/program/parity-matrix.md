# THE PARITY MATRIX — intended shape (design markdowns) vs built console

> Master remaining-work checklist for the console program. **Binding directive: polish comes only after visual AND functional parity with the intended shape described in `docs/design/oyatie-console/*`.** This document derives that intended shape exhaustively from the design markdowns and diffs it against the built console.
>
> **Method.** Intended shape = `ROADMAP.md` module matrix + `DESIGN.md` §4 invariants (incl. §4.7 window model, token grammar @/#/!, §4-14 object card, §4-19..§4-26) + `HANDOFF.md` §0–§20 backend contract + `AGENTS.md` change-log through (101). Built state audited **evidence-based, no stack boot**, against the real build tip.
>
> **Build tip audited = `origin/main` @ `e9d818df` (release 0.1.61).** The main worktree is checked out on `feat/cedar-activation`, which is 55 commits **behind** origin/main on the console rounds (and 16 ahead on the Cedar shadow lane) — it does not even contain `web/src/console/screens/`. All frontend verdicts below are against **origin/main**; backend verdicts hold on both (the branch is only behind on console UI).
>
> **THE headline finding.** On origin/main the new `ConsoleShell` renders the main content area purely from `web/src/console/screens/registry.ts` (`const ScreenBody = SCREEN_REGISTRY[activeScreen]; {ScreenBody ? <ScreenBody/> : null}`, `ConsoleShell.tsx:86,225`). **`SCREEN_REGISTRY` has 11 entries; `nav.ts` declares 37 nav screen keys. So 26 of 37 nav keys currently render chrome-only (empty canvas).** That gap — not polish — is the console program's remaining work.

---

## 1. Summary table (counts by classification)

Classification scheme:
- **PARITY** — built in the target ontology-first console *and* wired to real backend, mounted and rendering real data.
- **PARTIAL** — capability exists but with a named gap: backend wired yet no new-console body; or a console component built but not mounted in `ConsoleShell`; or console body present but backend dark; or superseded legacy `pages/*` still hosts it.
- **MISSING** — no target-console surface at all (and often no backend).
- **N/A** — explicitly deferred by the design docs themselves.

| Layer | PARITY | PARTIAL | MISSING | N/A (deferred) | Total |
|---|---:|---:|---:|---:|---:|
| Module surfaces (ROADMAP §4 / nav keys) | 11 | 18 | 9 | 2 | 40 |
| Cross-cutting grammar (DESIGN §4.x) | 6 | 7 | 2 | 1 | 16 |
| Backend contract (HANDOFF §2–§20 + plain-domain) | 12 | 3 | 6 | 1 | 22 |

**Bottom line:** the *engine + governance spine* (ontology, Cedar PBAC, lifecycle, guardrails, audit chain, workflow-studio) and 11 flagship screens are at parity; the *breadth of employee-facing module surfaces* is the deficit — two-thirds of nav keys are empty-canvas, and several whole backend pillars (ingest DX-, contract C-, board, recruiting, forecast/quant) do not exist.

---

## 2. Module surfaces — per-module parity (ROADMAP §4)

Each row: intended capability (one line) · verdict · evidence (path/tag). "REGISTRY body" = has an entry in `web/src/console/screens/registry.ts` (renders in ConsoleShell). "backend tag N" = openapi op count under that tag (`backend/openapi/openapi.yaml`, 320 ops total). "mounted" = router merged in `backend/app/src/lib.rs build_router` (~30 routers).

### Overview / personal
| Module | Intended | Verdict | Evidence |
|---|---|---|---|
| overview | Palantir/Workday home: Task·WorkObject·KPI, agenda | **PARITY** | REGISTRY `overview`→`screens/overview/OverviewScreen.tsx` + `overviewApi.ts`; round 14 agenda depth |
| mywork (내 업무) | personal landing: 결재 차례·배차 큐·수령확인·오늘 할일 | **PARTIAL** | backend `action_inbox`+`todos(4)` mounted; **no REGISTRY body** → empty canvas |
| inbox (개인수신함) | passkey 수령확인 vault, InboxDoc legal docs | **PARTIAL** | backend `inbox` rest mounted + `passkeys(2)` + webauthn migration `0144`; **no console body** |

### HR / people
| Module | Intended | Verdict | Evidence |
|---|---|---|---|
| hr (인사) | Workday HCM: Person·인사카드 카테고리·PBAC | **PARTIAL** | backend `hr(10)`+`employees(8)` mounted; legacy `pages/EmployeesPage.tsx`; **no REGISTRY body** |
| recruit (채용) | Greenhouse: Posting·Applicant·인재풀 | **MISSING** | no console body; **no recruiting REST** (BE-5 gap); no legacy page |
| org (조직도) | Workday Org: Entity·Site·Team·Position, draft→archive | **PARTIAL** | backend `branches(5)`/`regions(4)`/`sites(2)` + legacy `OrgPage`/`GroupAdminPage`; no REGISTRY body |
| review (인사평가) | Lattice/15Five: Review·KPI·근태연동 | **MISSING** | no console body, **no backend** |
| directory (주소록) | Workday People: Person·조직 | **PARTIAL** | backend `employees(8)`/`users(7)`; no console body |

### Time / pay
| Module | Intended | Verdict | Evidence |
|---|---|---|---|
| att (근태) | Kronos/Deputy: 계획/실적·대근·주52h·월마감 | **PARTIAL** | backend `daily-work-plans(6)`; legacy `AttendancePage`; no REGISTRY body |
| pay (급여) | Workday Payroll: PayrollRun·PayItem·PS-·셀프서비스 | **PARTIAL** | `crates/payroll` = **domain-only, no REST (dark)**; legacy `PayrollPage`; no console body |
| leave (연차) | Workday Absence: Leave·촉진·거부권 | **PARITY** | REGISTRY `leave`→`screens/leave/LeaveBody.tsx`; backend `leave(5)` + `leave_promotions` mig `0123` |
| benefit (복리후생) | Workday Benefits: 제도 수명주기·tier | **MISSING** (backend built-dark) | `crates/benefit` domain-only + table `0157` seeded, **no REST/not mounted**; no console body |

### Governance / docs / policy
| Module | Intended | Verdict | Evidence |
|---|---|---|---|
| appr (전자결재) | 그룹웨어+ServiceNow: Approval AP-·종결 | **PARTIAL** | `console/appr/ApprovalCompose.tsx` built + `governance(4)`/`approval-items(1)`; **not in REGISTRY** (rendered only via legacy `ConsoleModuleRoute` special-case, not new shell) |
| docs (문서·기록물/증거) | Foundry Docs·M-Files: 기록물·IN-·증거 WORM | **PARITY** | REGISTRY `docs`→`screens/evidence/EvidenceScreenBody.tsx`; backend `evidence(4)`+`integrity(2)`+`lifecycles(3)`; media/ZIP viewer depth = partial |
| policy (권한·정책) | AWS Cedar/OPA: Policy·AccessGrant, no-code canvas | **PARITY** | REGISTRY `policy`→`screens/policy/PolicyBody.tsx`; backend `Policy(21)` + cedar authoring/authz-rest, residual→SQL |
| compliance | OneTrust/Purview: 의무 CP-·규제 RG-·FW-·DSR | **PARTIAL** | `crates/compliance` rest mounted (`location-consent(5)`); no console body; multi-jurisdiction PII deferred |
| audit (감사로그) | Splunk/CloudTrail: AuditEvent | **PARTIAL** | `console/audit/AuditFeed.tsx` **built but unrouted (orphan)**; backend `audit(1)`+`integrity(2)`+CEO covert stream mig `0147` |

### Foundry group (ontology / automation / analytics)
| Module | Intended | Verdict | Evidence |
|---|---|---|---|
| explore (객체탐색) | Foundry Object Explorer/graph | **PARITY** | REGISTRY `objectExplorer`→`screens/explore/ExploreBody.tsx`; backend `objects`/`object-links(3)`/traverse |
| ontology-manager (타입·매니저) | Foundry Ontology Manager: type editor·revision staging | **PARITY** (1 residual) | REGISTRY `ontologyManager`→`screens/ontology-manager/OntologyManagerBody.tsx`; backend `Ontology(10)`/`object-types(2)`/`object-actions(2)`. **Residual: projected-type action dispatch = `NotWiredYet`** (`crates/ontology/rest/src/lib.rs:484`) |
| auto/Automate (자동화·예약) | Workato/n8n: Workflow·Schedule, typed builder | **PARITY** | REGISTRY `workflow`+`scheduled`→`screens/automate/AutomateBody.tsx`; backend `workflow-studio(24)`+`workflow-runs(5)` |
| dashboard | Foundry Quiver/Tableau: 파생지표 drill | **PARITY** | REGISTRY `dashboard`→`screens/dashboard/DashboardBody.tsx`; backend `reporting(3)`/`kpi(1)` |
| laborcost (인건비/경영분석) | Foundry Contour/Adaptive: LaborCost·수익성 | **PARTIAL** | backend `financial`/`reporting` partial; legacy `KpiPage`/`OperationsIntelligencePage`; no console body |
| forecast (예측) | Anaplan/Foundry: 시나리오(규칙) | **N/A** (P4 deferred) | legacy `ForecastPage`; **no Monte-Carlo/EVT backend** (HANDOFF §18 quant deferred) |

### ERP
| Module | Intended | Verdict | Evidence |
|---|---|---|---|
| finance (재무) | SAP/NetSuite/더존: Voucher VC-·자동전표 | **PARITY** | REGISTRY `finance`→`screens/module-finance/ModuleFinanceScreenBody.tsx`; backend `financial(20)`; round 14 finance structure |
| purchase (구매) | Coupa/SAP Ariba: PO-·Vendor·3-way match | **MISSING** | `crates/erp` = domain-only; **no purchase REST**; no console body |
| inventory (재고) | SAP MM/Fishbowl: IV-·안전재고 | **MISSING** (backend built-dark) | `crates/inventory` domain-only + table `0156`, **no REST/not mounted**; no console body |
| asset (자산) | ServiceNow ITAM/EAM: FL-·GPU·렌탈 | **PARTIAL** | backend `equipment(15)`/`equipment-substitutions(2)` + legacy `EquipmentPage`; module config had equipment loader (feat branch); no REGISTRY body |

### Field ops
| Module | Intended | Verdict | Evidence |
|---|---|---|---|
| dispatch (배차) | Samsara/Onfleet: WO- 큐×기사×SLA·지도 | **PARTIAL** | backend `dispatch` rest mounted + `p1-dispatches(3)`; legacy `DispatchPage`/`DispatchMapPage`; no console body |
| maintenance (정비) | UpKeep/Fiix/SAP PM: WO- | **PARTIAL** | backend `work-orders(14)`; legacy `MaintenancePage`/`WorkOrderDetailPage`; no console body |
| field (고객·현장) | ServiceNow FSM: CustomerSite·SLA | **PARTIAL** | backend `customers(1)`/`work-orders`; no console body |

### Comms
| Module | Intended | Verdict | Evidence |
|---|---|---|---|
| mail | Gmail/mox: Mail·threading·litigation hold | **PARTIAL** | `console/mail/*` built + backend `mail(12)`/comms mounted; rail summary via `CommsRailPanel`; **main full-view not in REGISTRY** (§4.8 promotion missing) |
| messenger (msgr) | Slack/Teams parity: Thread·presence·unfurl | **PARTIAL** | `console/messenger/*` built + backend `messenger(13)` + migs `0133-0143`; rail wired; **main full-view not in REGISTRY** |
| notif (알림) | notification pointers | **PARTIAL** | backend `notifications` mounted; no console body |
| board (게시판·공지) | Confluence/Slack: Notice NT-·수령확인 | **MISSING** | no console body, **no board backend** |

### Contract chain / workforce / support / editor
| Module | Intended | Verdict | Evidence |
|---|---|---|---|
| contract (국가지원·조달·계약) | SAM.gov/나라장터/Icertis: Contract C-·Grant·Bid | **MISSING** | **C-/Position/Posting have no backend object at all** (ledger north-star break); no console body; P2 |
| ingest (데이터 인제스트) | Foundry Pipeline/Rossum: IngestJob DX-·Source·Template | **MISSING** | **no ingest crate, no DX- pipeline, no REST** anywhere; whole P1 pillar absent from build |
| workforce (인력풀) | WFM: WorkforcePool·대근 | **MISSING** | not in nav; backend `equipment-substitutions` partial; no console surface |
| support (지원센터) | Zendesk: SUP-·SLO(≠SLA) | **PARITY** | REGISTRY `support`→`screens/support/SupportBody.tsx`; backend `support(7)` + `support_slo_setting` engine object |
| editor (오피스 편집기) | ONLYOFFICE/Euro-Office fork | **N/A** (P3 deferred) | backend `office(4)` = governance shell (`app/src/office.rs`); real iframe editor deferred (HANDOFF §12) |

---

## 3. Cross-cutting grammar (DESIGN §4.x, §4.7)

| Capability | Intended (design ref) | Verdict | Evidence / residual gap |
|---|---|---|---|
| Window model | §4.7-2 pin/split·popout·tray·cross-screen persist | **PARTIAL (HIGH gap)** | full engine `console/window/*` exercised mainly in `window/harness.tsx`; **only 3 of 11 wired screen bodies consume it** (ontology workspace, graph explorer, support — verified `git grep origin/main -- screens/**`); the other 8 (leave, finance, dashboard, policy, evidence, overview…) use a reduced/no window model. **popout has no button, saveLayout/restoreDefault/width-drag API-only** (ledger F1 gaps) |
| objDrag reference tokens | §4-20/§4-23 every object = drag source | **PARTIAL** | `console/window/objDrag.ts` — 9 evidence-backed prefixes + multi-segment fix; **prefix regex hardcoded/triplicated = design's named gap** (not registry-derived) |
| Token grammar @/#/! | §4.7-7 mention/object/code, PBAC candidates | **PARTIAL** | `console/composer/*` (grammar, TokenComposer, PBAC-gated candidates) built; **surface breadth incomplete** (not on every input) |
| Object card 3-layer | §4-14 semantic/kinetic/dynamic + relation-draw + CRUD | **PARITY** | `console/objectcard/wired.tsx` GovernedObjectCard — preflight/execute/overrides/lifecycle, deny-by-omission (wave-1 wired) |
| Honest chart scaling | §4-24 axis-truncation chip | **PARITY** | `console/charts/honestScale.ts` + `HonestMarks` + `ProjectionPanel` (CI95/CVaR95) |
| Config console / add-anything | §4-22 add-anything · §19 component model | **PARTIAL** | `console/configconsole/*` (widget palette, add column/stat, `console_view` persisted via engine); **§4-22 full add-anything audit still OPEN (TODO #12)** — not end-to-end for every element type |
| Lifecycle engine (UI) | §3.9/§15 draft→archive, as-of | **PARTIAL** | `console/lifecycle/*` + `governance` backend; **bi-temporal as-of for projected types = D2 partial** |
| Guardrails (UI) | §3.10/§16 authority·checklist·four-eyes·egress | **PARTIAL** | governance gate-chain + mail egress wired; **checklist/four-eyes/SoD surfacing is backend-engine, thin UI** (ledger §85 judgment) |
| Cedar PBAC deny-by-omission | §4.5 screen/card/row/action/aggregate | **PARITY** | `console/shell/authz.ts` + `policy/PolicyGate` + `api/policyCedar.ts` + residual→SQL WHERE (backend) |
| Audit backbone | §7 tamper-evident hash chain | **PARITY** | audit chain seals mig `0100`/`0101` + CEO covert stream `0147`; `integrity` router mounted |
| No-explanatory-UI / stat-strip | §4-11/§4-12 | **PARITY** | mechanically enforced by `check-ui-strings` gate |
| SLO ≠ SLA | §4-26 configurable setting objects | **PARITY** (support) | `support_slo_setting` engine object; **relabel sweep to other surfaces = partial** |
| Comms rail↔main promotion | §4.8 | **PARTIAL** | `CommsRailPanel` (rail summary) wired; **main full-view promotion for mail/messenger MISSING** |
| DLP client layer-1 | §13.1 copy/ctx/devtools/print/watermark | **MISSING** (in console) | shipped in `.dc.html` prototype (AGENTS 87/89/90); **not ported to React console** (post-replica backlog). Layer-3 = deployment req (N/A) |
| Mobile employee app | §4.8 <768 app + bottom tab bar | **MISSING** | no `console/mobile/` dir; post-replica backlog |
| Closed-loop review protocol | §4-25 8-question loop | **N/A** (process) | mechanism = visual-verdict pipeline + `check-ui-strings`/gates; not a surface |

> **Primitive-consumption cross-check (vs `screens/**` on origin/main).** `HonestMarks`/`honestScale` and PBAC `hasPolicy`/`PolicyGate` are broadly consumed by the wired screen bodies (≥6 each — dashboard, policy, leave, finance, evidence, ontology, explore) — **not dead code**; the projection panel (EWMA/Student-t/CVaR) renders live in the dashboard body. But `window-model`/`objDrag`, `GovernedObjectCard`, and `TokenComposer` are consumed by **only the ontology-workspace / graph-explorer / support** bodies — the §4.7 window model and the object-card/token grammar are effectively confined to those surfaces, not the console-wide grammar the design mandates. Minor: two parallel gate components (`PolicyGate` vs `PolicyGated`) coexist — a reduced-copy seam worth collapsing.

---

## 4. Backend contract (HANDOFF §0–§20)

Mounted routers in `backend/app/src/lib.rs build_router` (authoritative "wired" set): console_telemetry, dispatch, financial, inspection, support, identity, compliance, integrity, registry, hr, workflow_studio, collaboration, action_inbox, objects, lifecycle, office, sales, reporting, workorder(+mobile), messenger, docs, notifications, inbox, leave, todos, comms, ontology, governance, platform-authz(cedar), platform-rest, platform-auth, realtime.

| HANDOFF § | Contract | Verdict | Evidence |
|---|---|---|---|
| §0 | do-not-ship scaffold absent | **PARITY** | final-shape rule; view-as/pkAuth-sim/client-hash-chain absent from console |
| §2/§4.5 | Cedar PBAC authorize/simulate/CRUD, residual→SQL | **BUILT-WIRED** | `crates/policy`+`platform/authz` cedar_pbac + authz-rest; migs `0150`/`0154`/`0159` |
| §3 | InboxDoc + passkey WebAuthn | **BUILT-WIRED** | `crates/inbox` rest + `passkeys` + webauthn mig `0144`, inbox_docs `0119` |
| §4 | 연차촉진·노무수령거부 | **BUILT-WIRED** | `crates/leave` rest + `app/src/hr.rs`; migs `0122`/`0123` |
| §5 | finalization (작성자 종결·override) | **PARTIAL** | governance covers approvals; finalization-specific FSM thin |
| §6 | 자동화·예약작업 | **BUILT-WIRED** | `crates/workflow`+`app/src/workflow_*.rs`; migs `0105`/`0106`/`0127` |
| §7 | audit tamper-evident hash chain | **BUILT-WIRED** | audit chain seals `0100`; `integrity` router; ceo covert `0147` |
| §10 | 데이터 인제스트 DX- (parse/OCR/Template/lineage) | **MISSING** | **no crate, no pipeline, no REST** |
| §11 | 증거 WORM/hash/TSA/custody | **BUILT-WIRED (partial)** | `crates/docs` rest `evidence(4)` + `docs_evidence_objects` `0151`; **TSA/RFC-3161 nullable/deferred** |
| §12 | 오피스 편집기 | **PARTIAL** (deferred) | `app/src/office.rs` governance shell + `office(4)`; real editor iframe deferred |
| §14 | 메일 | **BUILT-WIRED** | `crates/comms` (imap/smtp/mox adapters) mounted + `mail(12)`; custom Rust stack (not mox rewrite) |
| §15 | 생애주기 엔진 effective-dating/as-of | **BUILT-WIRED (partial)** | `crates/governance`+`app/src/lifecycle.rs`+`lifecycles(3)`; bi-temporal projected = partial |
| §16 | 가드레일 엔진 preflight/four-eyes/egress | **BUILT-WIRED** | `crates/governance` gate-chain, self-approval CHECK; mig `0153`/`0158` |
| §17 | 엔터프라이즈 표준 SSO/SCIM/KMS/OTel/SIEM/TSA | **MISSING (mostly)** | FW- objects are UI-only; SSO/SCIM/KMS-envelope/OTel/SIEM/TSA-anchor deferred |
| §18 | 온톨로지 엔진 registry+instances+actions+analytics+traversal | **BUILT-WIRED (partial)** | `crates/ontology` rest + `objects.rs`; migs `0102`/`0130`/`0152`/`0155`. **Residual: projected-type action dispatch `NotWiredYet` (`ontology/rest/src/lib.rs:484`) — being edited by wave-mc now** |
| §19 | 구성 가능 콘솔 (DashComponent/console_view 영속) | **BUILT-WIRED (partial)** | `console_view` seeded through engine + governance deploy approval |
| §20 | 전면 CRUD 거버넌스 (override four-eyes) | **BUILT-WIRED** | `gov_approval_requests` `0158`; override reason+four-eyes |
| plain | payroll · inventory · benefit REST | **BUILT-DARK** | crates domain-only, tables seeded (`0156`/`0157`), **no REST, not mounted** |
| plain | board · recruiting · contract(C-) · forecast/quant | **MISSING** | no crate/REST |

---

## 5. AGENTS change-log (92)–(101) feature parity

These are the **latest shipped state in the `.dc.html` design prototype** — each must be reflected in the built React console. Most are **NOT yet in the built console** because the built console (rounds 3-15) is a ground-up re-implementation that has reached 11 screen bodies, not the prototype's full surface set.

| AGENTS | Prototype feature | Built-console status |
|---|---|---|
| (91) leave 카드 존 (window-model) | window-zone wrap of leave sections | **PARTIAL** — LeaveBody wired; window-zone retrofit breadth is the §4.7 gap |
| (92)(93) benefit·docs 카드 존 | single card-zone retrofit | **MISSING (benefit)** / **PARITY (docs)** — benefit has no console body |
| (94) dashboard 위젯 제네릭 바인딩 | count/trend/dist widgets on ONT query | **PARTIAL** — DashboardBody wired; generic widget-add scope partial |
| (95) 기안 §68 투영 + fail-closed | structured 기안 + projection panel | **PARTIAL** — ApprovalCompose built, not in new shell |
| (96) 대시보드 실데이터 파생 | live-computed stats | **PARITY** — DashboardBody real-API |
| (97)(98) 급여·공고·월간 J/K/Enter | keyboard nav | **MISSING** — pay/recruit/att have no console bodies |
| (99) 미편성 결원 SLO 알림 시드 | SLO notif seed | **PARTIAL** — SupportBody SLO wired; cross-surface seed partial |
| (100) 증거 WORM 뷰어 | media pane + ZIP tree | **PARTIAL** — EvidenceScreenBody wired; media/ZIP viewer depth partial |
| (101) 인제스트 TP- 템플릿·hrSep·체크인·§18.2·커버플래너 | mapping templates, 퇴사/휴직 FSM, geofence check-in, sunset, cover planner | **MISSING** — ingest/att/hr bodies absent; §18.2 sunset partial (backend lifecycle only) |

---

## 6. RANKED gap register (impact × user-visibility)

### (a) Watch-list — gaps the running `wave/module-completion` (wave-mc) plausibly closes
wave-mc is the round-cadenced console-completion wave (produced rounds 3–15 → the 11 wired screens) and is **currently editing `backend/crates/ontology/rest` + `adapter-postgres`** (the `NotWiredYet` residual). It closes wire-pending/functional gaps in **existing/partially-built** modules. Plausibly in its queue:
1. **§18 projected-type action dispatch `NotWiredYet`** — writeback engine incomplete; actively being edited now. *(HIGH — engine correctness)*
2. **finance module depth** — round 14 shipped finance structure; continues. *(MED)*
3. **Window-model retrofit breadth + popout/split/persistence** — §4.7 is confined to 3 of 11 wired bodies (ontology/explore/support); the full engine is otherwise harness-only. *(HIGH — likely exceeds wave-mc per-round polish; a dedicated §4.7 retrofit charter may be needed to bring pin/popout/tray/persist to all 11 bodies + collapse PolicyGate/PolicyGated)*
4. **objDrag registry-derived prefixes** (drop the triplicated hardcoded regex). *(MED)*
5. **Evidence media/ZIP viewer depth**, **dashboard generic widget-add**, **SLO relabel sweep** — polish on wired screens. *(LOW-MED)*

> Note: wave-mc is console-completion by round; it can plausibly *also* add net-new bodies (hr/att/dispatch/…) in future rounds, but only for modules whose **backend already exists** — the final-shape rule forbids shipping fixture-fed bodies.

### (b) New charters — gaps nobody has chartered (the next waves)
Ranked by impact × visibility. **Top 10 program gaps overall are in bold** (these dominate the whole matrix, not just this list):

1. **hr (인사) console body** — backend `hr(10)`/`employees(8)` wired, nav key renders empty; core daily HR surface. *(HIGH)*
2. **att (근태) console body** — backend `daily-work-plans(6)` partial; empty canvas; every-manager surface. *(HIGH)*
3. **pay (급여) surface + payroll REST** — crate is dark (no REST) AND no body; every-employee self-service. *(HIGH — needs backend + UI)*
4. **appr (전자결재) into new ConsoleShell** — ApprovalCompose built but only in legacy route; every employee. *(HIGH — mount + reconcile key-namespace)*
5. **mail + messenger main full-view promotion (§4.8)** — rail works, main canvas empty; core comms. *(HIGH)*
6. **mywork (내 업무) personal landing** — backend action_inbox/todos wired, no body. *(HIGH)*
7. **recruit (채용) surface + recruiting REST** — HR persona core; no backend, no body. *(HIGH — needs backend + UI)*
8. **org (조직도) console body** — backend wired, no body; org-lifecycle reference impl (§3.9.2) not surfaced. *(MED-HIGH)*
9. **dispatch/maintenance/field console bodies** — backend `work-orders(14)`/`dispatch`/`p1-dispatches` wired, 3 empty canvases. *(MED-HIGH)*
10. **inbox (개인수신함 passkey) console body** — passkey backend + webauthn wired, no body; legal 수령확인 evidence path. *(MED-HIGH)*

Further new charters (below the top 10): benefit/inventory REST + bodies (crates dark); purchase surface + REST; review(인사평가) surface + backend; laborcost/notif/directory/compliance/audit(mount AuditFeed orphan) bodies; workforce(인력풀) surface; DLP client layer-1 port to React; mobile employee app (§4.8); §17 enterprise standard (SSO/SCIM/KMS/OTel/SIEM/TSA); identity onboarding mount (FirstLoginOnboarding unmounted); resolve nav-key↔ConsoleModuleRoute namespace mismatch; retire evidenceStubs residual in legacy `console/evidence/EvidenceRecords.tsx` (superseded by wired EvidenceScreenBody).

### (c) Deferred-epic debt (chartered separately in the ledger — still parity debt)
- **데이터 인제스트 DX- pipeline (§10)** — whole P1 pillar, no backend. *(design P1; deferred in build)*
- **contract C-/Position/Posting (§3 north-star chain)** — instance-backed engine types; the C-→Position→Posting→Employee chain is the acceptance test.
- **오피스 편집기 (§12)** — ONLYOFFICE AGPL fork; office shell only.
- **DLP layer-3 (§13)** — enterprise browser/VDI/MDM = deployment requirement.
- **규제 PII / 다중 관할 (Jurisdiction/Consent/DSR objects)** — compliance multi-jurisdiction.
- **forecast / quant (§18 Monte-Carlo/EVT)** — P4.
- **메일 mox 백엔드 개조** (custom Rust stack kept instead) + **access-grant TTL 토큰 (break-glass)**.
- **Tier-2 rebrand** (repo/crates mnt-*→console-*), **buck2 adoption**, **bare-metal portability** (infra, not parity).

---

*Generated 2026-07-11 from the design markdowns + evidence-based repo audit (origin/main @ 0.1.61, no stack boot). Update at each milestone; every classification is repo-cited above.*
