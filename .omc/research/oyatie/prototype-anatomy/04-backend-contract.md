# 04 — Backend Contract (per screen)

> Endpoint source of truth: `backend/openapi/openapi.yaml` on **origin/main as of 2026-07-09** (226 paths — includes merged BE-OBJ #206/#227, BE-LC #211, BE-AUTO #208, run read-surface #224, SoD #205, audit chain #204/#226, todos/dispatch-offers #209, me/authz+workspace #234). NOTE: the `feat/cedar-activation` worktree copy is stale (187 paths) — do not map against it. One endpoint exists in code but NOT in openapi.yaml: `GET /api/audit` (app-level route, `backend/app/src/lib.rs:1367`, now with `target_id`/`trace_id`/`target_type`/`actor` filters) — flag for openapi backfill.
>
> Legend: **EXISTS** = openapi path (or the noted code-verified route). **GAP:** = named backend gap. Gaps are ranked in §Gap Register at the end; charter ownership in §Gap→Charter.

---

## Shell (00-shell)

| Prototype read/mutation | Backend mapping |
|---|---|
| ⌘K palette: fuzzy search across work items + people + screens | **GAP: global object/person search** — no cross-kind search endpoint; only `GET /api/messenger/search` (messages) and per-domain lists exist. `GET /api/objects/{kind}/{id}` resolves a known code but cannot search by name/prefix |
| `!CODE` deref from palette/chips | EXISTS `GET /api/objects/{kind}/{id}` + `GET /api/objects/{kind}/{id}/graph` |
| Scope switcher (그룹 전체/법인 union) | EXISTS `GET /api/v1/me/authz` (scope + deny-by-omission capability grants, advisory) + `GET /api/v1/branches`, `/api/v1/regions`, `/api/platform/orgs/{id}`. "전체 = union of authorized entities" is the client applying `me/authz` scope to list queries |
| Sidebar nav badges (결재/연차/알림/감사 counts) | EXISTS `GET /api/v1/me/notifications/unread-count`; approval count = `GET /api/v1/workflow-tasks` (mine); leave-pending / audit-anomaly counts → same gaps as their screens (see below) |
| User menu → self personnel card, punch-out | EXISTS `GET /api/v1/users/me`, `GET /api/v1/hr/attendance-records/me`; punch in/out mutation — **GAP: clock-in/out endpoint** (attendance records are import-fed today, no self-punch write) |
| Rail sections (msgr/mail/notif/notices) | messenger + mail + notifications EXIST (see comms screens); 공지 list — **GAP: board/notices (NT-) domain** |
| TASK DETAIL MODAL — approval variant (결재선, approve/reject/return w/ mandatory comment) | EXISTS `GET /api/v1/workflow-tasks`, `POST /api/v1/workflow-tasks/{task_id}/claim`, `/decide`, `/finalize`, `POST /api/v1/workflow-runs/{run_id}/post-finalization-rejection`; approval-line reassignment/append (결재선 편집 chips) — **GAP: runtime approval-line edit** (line is fixed by definition at start; no task-level reassign/add-stage endpoint) |
| TASK DETAIL MODAL — dispatch variant (driver pick + confirm) | EXISTS `POST /api/v1/work-orders/{workOrderId}/p1-dispatch`, `GET/POST /api/v1/p1-dispatches/{dispatchId}/responses`, `/force-assign`, `GET /api/v1/me/dispatch-offers` |
| TASK DETAIL MODAL — hr-issue variant (근태 이상 resolve w/ justification) | **GAP: attendance-exception queue** — `GET /api/v1/hr/attendance-records` returns records, but there is no exception/issue object with evidence, resolve-action, or 소명(justification) requirement |
| CALENDAR MODAL (month grid, quick-add) | EXISTS `GET/POST /api/v1/collaboration/calendar/events`; todos EXISTS `GET/POST /api/v1/me/todos`, `POST .../{todoId}/done`, `DELETE .../{todoId}` |
| PERSONNEL CARD (tiered PBAC disclosure; "열람 — 기록 남음" reveal) | EXISTS `GET /api/v1/employees`, `/api/v1/users/{id}`; person view-audit merged via #202 lane. Sensitive-section reveal-as-distinct-logged-action (bank account/emergency contact, masked payroll) — **GAP: field-tier read gates** (per-section step-up read endpoints emitting their own audit events; only person-view-level audit exists) |
| PASSKEY step-up (modal) | EXISTS `POST /api/v1/auth/passkey/*` (webauthn infra live; step-up used by workflow-studio mutations) |
| Docked tray / quick actions | client state; layout persistence → window engine row below |

## Window engine (01-window-engine)

| Prototype read/mutation | Backend mapping |
|---|---|
| `localStorage["oyatie-cards-v1"]` per-user layout | EXISTS `GET/PUT /api/v1/me/workspace` (opaque frontend-owned layout JSON) — the exact endpoint the doc flagged as "minor net-new"; already shipped (#234) |

## 통합 개요 Overview (02-screens/overview)

| Prototype read/mutation | Backend mapping |
|---|---|
| `items[]` unified action inbox (approval+dispatch+work+support, urgency buckets, due tone, amount, links, stats) | PARTIAL — fan-in across EXISTS `GET /api/v1/workflow-tasks` + `GET /api/v1/me/dispatch-offers` + `GET /api/v1/work-orders` + `GET /api/v1/support/tickets`. **GAP: unified my-action-inbox read model** — no single endpoint; and the constituent lists lack the shape's SLA/urgency bucket, due-tone, cross-object `links[]`, and `stats` sparkline block. Client fan-in is viable for v1 if each list carries due dates; the sparkline/trend block is an analytics gap regardless |
| KPI strip | PARTIAL — EXISTS `GET /api/v1/kpi`, `GET /api/v1/ops/summary` (FSM-era metrics); conglomerate KPIs (출근율, 주52 임박, 마감 progress) → **GAP: cross-module KPI aggregates** (fold into analytics; counts derivable client-side from lists meanwhile) |
| Row primary action / `setItemDone` | EXISTS per kind: tasks decide, dispatch responses, work-order report/approve, support transition |
| Undo last action | client-side only (server mutations are not undoable; acceptable — prototype undo is a demo affordance) |
| Today/plan pane: `schedByDay`, todo CRUD, @mention | EXISTS `me/todos` + `collaboration/calendar/events`; mention→notification EXISTS via message_refs/notifications path (#227) |
| Punch status chip | **GAP: clock-in/out** (as shell) |

## 내 업무 MyWork (post-snapshot)

| Prototype read/mutation | Backend mapping |
|---|---|
| 내 차례 (approvals awaiting me) | EXISTS `GET /api/v1/workflow-tasks?assignee=me` (+ group inbox by role_key) |
| 상신 중 (my submissions + progress stepper) | EXISTS `GET /api/v1/workflow-runs/mine`, `GET /api/v1/workflow-runs/{run_id}` (node-step timeline, #224) |
| 배차 queue (mine) | EXISTS `GET /api/v1/me/dispatch-offers` |
| 수령확인 대기 (receipt confirmations pending) | **GAP: InboxDoc domain** — no personal-inbox document object/endpoint exists (see Inbox screen) |
| Notification rows resolving to real object content + 처리 panel routing | EXISTS `GET /api/v1/me/notifications` (NotificationLink Object/Screen) + `GET /api/objects/{kind}/{id}` resolve |
| Persona-relative scoping (server-side owner-match, deny-by-omission) | EXISTS — lists above are principal-scoped; `me/authz` gates rendering. (The prototype's (25) leak-fix lesson is satisfied by these being `me/*` endpoints) |

## 전자결재 Appr / 연차 Leave / 복리후생 Benefit (02-screens/appr-leave-benefit)

| Prototype read/mutation | Backend mapping |
|---|---|
| 결재함 inbox rows + decide (승인/반려/거부, comment mandatory on reject/return) | EXISTS workflow-tasks list/claim/decide (SoD initiator-guard live, #205) |
| 내 결재 완료·종결 대기 progress steppers | EXISTS `GET /api/v1/workflow-runs/{run_id}` node timeline |
| 상신함 outbox + 종결(finalize) / 대행(delegate) / 사후 반려(revoke) | EXISTS `runs/mine`, `POST /api/v1/workflow-tasks/{task_id}/finalize` (Author\|Delegate), `POST /api/v1/workflow-runs/{run_id}/post-finalization-rejection` |
| 기안 template picker (`APPR_TEMPLATES` 8종, all-employee) | **GAP: submittable-templates catalog** — all-employee `GET /api/v1/workflow-studio/submittable-definitions`; every existing catalog/definition endpoint is `authorize_workflow_manage` (admin-only). Known from PR #233 — do not stub the gallery |
| 상신 submit (`apprSubmit` → AP- ref) | EXISTS `POST /api/v1/workflow-runs` (start); canonical AP- code issuance shipped in BE-OBJ |
| 개체 연결 target picker (`apprLinkSpec` opts per template) | PARTIAL — link persistence EXISTS `POST /api/v1/object-links`; candidate lookup → **GAP: global object search** (same as shell palette) |
| 첨부 (reimburse/expense/purchase) | EXISTS purchase-request attachment presign/confirm/download family; generic evidence presign/confirm for others |
| 내 급여 명세 side rail (payslips) | **GAP: payroll REST surface** — zero `/payroll` paths anywhere (see Pay screen) |
| `lvReqs` leave-request queue + 승인/반려/거부 (`lvDecide`) | **GAP: leave-request domain** — `GET /api/v1/hr/leave-balances` is read-only balances; no request objects, no decide mutation (can be hosted as an engine workflow definition once submittable-templates exist, but the leave ledger write-back "근태·급여 자동 반영" needs a domain) |
| `LV_EMP` per-employee grant/used/left table | EXISTS `GET /api/v1/hr/leave-balances` |
| 연차 촉진 push (`lvPromotePush`, 근로기준법 §61 1차/2차) + 노무수령거부 (`lvRefusalPush`) → AP- sub + target's personal inbox | **GAP: statutory-notice push chain** — needs leave-request domain + InboxDoc delivery + workflow start; none of the three legs beyond workflow start exist |
| `benefitData()` catalog (legal/extra, tiers, conds) | **GAP: benefit-catalog domain** (audit: bespoke FSM in-slice at UI-M12) |
| `benefitAdvance` lifecycle FSM | EXISTS generic substrate `GET /api/v1/lifecycles/{objectType}/{objectId}` + `POST .../transition` + `/hold` (BE-LC #211) — benefit rows just need a domain table to hang off it |

## 근태 Att / 급여 Pay (02-screens/att-pay)

| Prototype read/mutation | Backend mapping |
|---|---|
| Day-view site staffing board (`ATT_SITES` plan/in/late/absent) | PARTIAL — EXISTS `GET /api/v1/hr/attendance-summary`, `/attendance-records`; per-site coverage aggregation → **GAP: attendance aggregates** (site/entity rollups with plan-vs-actual) |
| Month-view org-drill matrix (`buildAttMonth`: 그룹→법인→사업장→팀→인원, per-day cells) | **GAP: attendance aggregates** — the prototype's generator is fixture code; backend needs org-tree rollup + per-person per-day status reads (org tree EXISTS `GET /api/v1/hr/org-chart`; records EXIST; the rollup query surface does not) |
| 주 52시간 모니터 (`WEEK52` cur/proj) | **GAP: attendance aggregates** (weekly hours + projection) |
| 근태 예외 (`HR_ISSUES`) queue + resolve | **GAP: attendance-exception queue** (as shell hr-issue modal) |
| 대근 편성 request / 근무 조정 todo | substitute request → EXISTS `POST /api/v1/equipment-substitutions`-analog does NOT cover people — **GAP: staffing-substitute request** (fold into attendance-exception/dispatch domain); 근무 조정 = `me/todos` EXISTS |
| 근태 마감 (`attConfirmClose`, gated on zero exceptions; 마감 후 소급 보정 기록) | EXISTS `POST /api/v1/period-locks` + `POST /api/v1/period-locks/{lockId}/unlock` (BE-LC) — enforcement substrate real; the close-gate precondition (exception count = 0) rides the attendance-exception gap |
| 급여 5-step pipeline (마감→계산→예외→상신→승인) | **GAP: payroll REST surface** — no payroll run/calc/register/exception endpoints at all. `paySubmit` handoff → EXISTS workflow-runs start once a payroll run object exists |
| 급여 명부 `PAY_ROWS` (base/allow/ded/net, delta) + search | **GAP: payroll REST surface** |
| 예외 검토 `PAY_EX` (ok/hold per exception) | **GAP: payroll REST surface** |
| 지급 총액 `PAY_ENT_COST` + 지급 일정 | **GAP: payroll REST surface** (+ analytics for entity breakdown) |
| Row click → person card + "급여 열람은 감사 로그에 기록" | person view-audit EXISTS (#202); payroll-row view audit rides the payroll gap |

## 인사 HR / 조직도 Org / 채용 Recruit / 평가 Review (02-screens/hr-org-recruit-review)

| Prototype read/mutation | Backend mapping |
|---|---|
| 직원 명부 roster (`EMPLOYEES`) + search/filter | EXISTS `GET /api/v1/employees` (+ import/export family, lifecycle-events) |
| 직원 등록 CTA | EXISTS `POST /api/v1/employees` via import/apply path; direct-create present in employees family |
| 근태 이상 card | **GAP: attendance-exception queue** (shared) |
| PEOPLE person detail (tiered) | EXISTS employees/users + view-audit; sensitive-tier reveal → **GAP: field-tier read gates** (shared with shell) |
| Org tree read (`orgData` 법인→사업장→팀) | EXISTS `GET /api/v1/hr/org-chart` (+ regions/branches/sites) |
| Org edit = DRAFT reorg proposal → 조직 개편 결재 (never direct write) | PARTIAL — approval flow EXISTS (workflow-runs); **GAP: effective-dating / as-of** — future-dated reorg commit + "view org as of X" has no temporal substrate (BE-LC #211 shipped locks+versioning, not valid_from/to) |
| 채용 postings + candidates (`rcData`), stage advance, hire→직원 개체 생성, reject→인재풀 | **GAP: recruit pipeline domain** — zero backend (postings, candidates, stage FSM, hire-creates-employee chain, rejected-pool retention) |
| 평가 (`rvTeams`/`rvTasks` review cycles) | **GAP: review-cycle domain** — zero backend (audit: bespoke FSM in-slice UI-M12) |

## 문서 Docs / 정책 Policy / 수신함 Inbox / 감사 Audit (02-screens/docs-policy-inbox-audit)

| Prototype read/mutation | Backend mapping |
|---|---|
| DOCS record archive (`DOCS()`: code/type/retention/종결일) + filters + 열람 감사 | **GAP: records-archive domain** — no records table/endpoint (retention labels chartered to ride BE-LC per audit; `legal_hold`/`retention_until` substrate exists in lifecycles `/hold`) |
| 문서 등록 (IN- registration → records-manager approval) | **GAP: records-archive domain** |
| 증거 EV- objects (SHA-256+TSA, WORM original/derivative, chain-of-custody, legal hold) | **GAP: evidence (EV-) objects** — storage WORM + evidence presign/confirm EXIST as plumbing; the EV- object model (TSA proof, custody stages, admissibility chip) does not |
| 내보내기 (signed append-only export) | **GAP: audit/records export** |
| POLICY Cedar catalog rows (natural-language rules, permit/forbid, 시행/초안) | **GAP: Cedar policy catalog/authoring** — `/api/v1/policy/*` is the legacy role matrix, not Cedar policies; Cedar is shadow-only. Read/simulate/no-code-save all unbacked |
| 시뮬레이션 ("누가 무엇을 보는가") / 규칙 편집 / 새 정책 | **GAP: Cedar policy catalog/authoring** (Cedar promotion charter) |
| INBOX `inboxDocs` (근로계약/취업규칙/연차촉진/노무수령거부/급여명세) + filters | **GAP: InboxDoc domain** — no endpoint; webauthn step-up EXISTS for the passkey leg |
| `inboxConfirm` receipt (passkey auth = legal receipt; audit `cat:receipt, decision:self`; finalizes linked AP-) | **GAP: InboxDoc domain** (receipt-confirm mutation + audit + workflow-run finalize tie-back); payslip self-view (audit-exempt) rides the payroll gap |
| AUDIT feed (day groups, search, filters, correlate-by-target, expand detail) | EXISTS `GET /api/audit` (code-verified: `target_type`/`actor`/`target_id`/`trace_id` filters — gap 3 CLOSED; not yet in openapi.yaml) + `GET /api/v1/policy/audit-events` (policy slice) |
| Hash-chain integrity line (`#seq · hash ← prev`) + tamper indicator | EXISTS audit chain seal + `GET /api/v1/audit/attestation` (#204/#226) |
| deviceCtx (device/browser/ip/geo/auth method) + classification badges (민감정보/대외비/비밀) + anomaly + reason + before→after | before/after + trace EXIST on AuditRecord; **GAP: audit context enrichment** — no request-context (ip/user_agent/auth_method/device) or classification/reason/anomaly columns on audit events |
| Full-text search / time-range / action filter / export | **GAP: audit query filters + export** (only type/actor/target_id/trace today) |

## 자동화 Auto (02-screens/auto)

| Prototype read/mutation | Backend mapping |
|---|---|
| `workflows[]` list + detail (trigger/when/then) | EXISTS `GET /api/v1/workflow-studio/definitions` (+ `{id}`, history) — but admin-gated; the auto screen is an admin surface, so OK |
| `wfToggle` (활성/비활성, audited as policy act) | EXISTS `.../publish`, `/pause` (passkey step-up, audited) |
| Event trigger bindings ("근태 이벤트→…") | EXISTS `GET/POST /api/v1/workflow-studio/trigger-bindings` + `{id}/enable`/`disable` (BE-AUTO #208) |
| `schedules[]` (real cron, next/last, history) + `schEditSave` | EXISTS `GET/POST /api/v1/workflow-studio/schedules`, `{id}` (update), `/preview-next-runs`, `{id}/runs` |
| `wfRun`/`schRun` manual trigger | EXISTS `POST /api/v1/workflow-runs` (TriggerType provenance) |
| `wfSimulate` | EXISTS `POST /api/v1/workflow-studio/definitions/{id}/simulate` |
| runLog (per-run timeline, error/retry, created-object chips) | EXISTS `GET /api/v1/workflow-runs` (admin list incl. dead-letter visibility, #224) + `{run_id}` node timeline |
| No-code block canvas (trigger/condition/branch blocks) + pendingRev four-eyes publish | **GAP: canvas semantics** — no condition/branch node kind in wf.exec.v1; trigger block not persisted on definition; publish is single-actor (staging a draft also still blocks starts unless #224-era decoupling landed — verify at build time) |

## 객체 탐색 Explore (02-screens/explore)

| Prototype read/mutation | Backend mapping |
|---|---|
| Graph traversal (radial, up/downstream, re-center) | EXISTS `GET /api/objects/{kind}/{id}/graph` (recursive over object_links) + `GET /api/v1/object-links` (list by either end) |
| Relation authoring (`objLinkAdd`, ×-remove, audited) | EXISTS `POST /api/v1/object-links`, `DELETE /api/v1/object-links/{id}` |
| Object search (name/code/type across graph) | **GAP: global object search** (shared) |
| "+ 새 개체" `nodeCreate` (OB- draft nodes) | **GAP: user-authored generic objects (OB-)** — object registry resolves domain rows only; no free node kind |
| 시리즈 승격 (SR- series, attach, trend) | **GAP: series (SR-) objects** — inspection-schedules shape only; audit recommends generalize-or-descope decision |
| Type legend → OT- type cards (definition/owner/count/lifecycle/archive gate), "+ 타입 제안" | **GAP: OT- type registry** — seeded object_types lookup shipped in BE-OBJ; the type-card lifecycle (propose→review→active→archive w/ instance migration) is not |
| Lifecycle chip → lifecycle modal | EXISTS `/api/v1/lifecycles/*` |
| 작용 자동화 chips (rules acting on center type) | EXISTS trigger-bindings list filtered by object_type |

## 인제스트 Ingest (02-screens/ingest)

| Prototype read/mutation | Backend mapping |
|---|---|
| Everything: DX- IngestJob (7-stage pipeline), connectors (file/API/webhook, 나라장터/오픈뱅킹), field-mapping review (confidence/PII/verify), mapping templates (versioned), provenance/lineage, ontology commit, auto-commit threshold | **GAP: ingest pipeline (whole domain)** — zero backend. HANDOFF §10 is the contract (Rust deterministic parsers, no AI). Largest single net-new charter; build the screen dark/mocked until it exists |
| Committed object joins graph + audit per stage transition | substrate EXISTS (objects/object-links/audit) once jobs exist |

## 메일 Mail (02-screens/mail + post-snapshot)

| Prototype read/mutation | Backend mapping |
|---|---|
| Folders / thread list / read pane / read-state / message / attachment download | EXISTS `GET /api/v1/mail/folders`, `/threads`, `/threads/{id}`, `/threads/{id}/read-state`, `/messages/{id}`, `/attachments/{id}/download` |
| Send / reply / forward (composer) | EXISTS `POST /api/v1/mail/send`, `/reply`, `/forward` |
| Account setup + test | EXISTS `GET/PUT /api/v1/mail/account`, `POST /api/v1/mail/account/test` |
| Reply completes linked support item (`itemId` cross-ref) | EXISTS support ticket transition + object-links; wiring is client orchestration |
| Threading (subject-normalized conversations) | EXISTS threads model (verify grouping semantics at build) |
| Sender-auth panel (SPF/DKIM/DMARC pass/fail), TLS/at-rest chips | **GAP: mail governance** — mail crate surface has no auth-result fields exposed (mox integration detail) |
| Classification (대외비/민감/격리), retention, litigation hold on mail | **GAP: mail governance** |
| Composer egress gate (external recipient × unapproved/sensitive attachment = block + anomaly audit + compliance alert; `egressDocs` lifecycle chips) | **GAP: egress/DLP gate** — lifecycle status EXISTS to read per object; the evaluation endpoint, block semantics, and anomaly audit event do not |
| Attachment → ingest (DX-) primary CTA / evidence registration | rides **ingest** and **records-archive/EV-** gaps |
| Read/send audit (full coverage) | EXISTS audit envelope (verify mail crate emits on read) |

## 메신저 Msgr / 알림 Notif (post-snapshot-screens)

| Prototype read/mutation | Backend mapping |
|---|---|
| Threads / messages / send / read receipts / members / search | EXISTS `GET/POST /api/messenger/threads`, `.../{threadId}/messages`, `/read-receipt`, `/members`, `/members/{userId}`, `/search` |
| @mention → notification + PBAC re-resolution of refs | EXISTS message_refs parse-on-write → notifications (#227) |
| Object-code auto-linking in bodies (`msgParts`) | EXISTS objects resolve + message_refs; rendering is client |
| Channels (#) vs DMs, presence dots | **GAP: messenger parity** — no channel/DM distinction fields or presence endpoint |
| Ack toggle (확인 count chip), reply-quote | **GAP: messenger parity** (reactions/ack + quote metadata not in message model) |
| Per-thread mute (personal setting, badge suppression) | **GAP: messenger parity** (per-user thread mute flag; direct-save whitelisted) |
| Message→todo conversion | EXISTS `POST /api/v1/me/todos` |
| Notif full view: list, unread, read-all, row→object routing | EXISTS `me/notifications` family + NotificationLink + objects resolve |

## 운영 지도 Map / 대시보드 Dashboard / 배차 Dispatch (post-snapshot-screens)

| Prototype read/mutation | Backend mapping |
|---|---|
| Site markers + site summary | EXISTS `GET /api/v1/sites`, `/sites/{id}`, `GET /api/v1/equipment-by-location`; real geo coordinates — **GAP: site geo/marker authoring** (minor; sites lack lat/lng authoring surface) |
| Unit layer (FL-/기사/BUS live positions) | EXISTS `POST /api/v1/location-pings` + consent ledger family (consented driver location); equipment location EXISTS |
| Dispatch overlay queue + 처리 CTA | EXISTS p1-dispatch family + me/dispatch-offers |
| Marker drag / "+ 현장" draft → reorg approval | draft-proposal → workflow-runs EXISTS; site create EXISTS `POST /api/v1/sites` (should be approval-gated per lifecycle rules) |
| Dashboard stat bar / contract profitability / 6M labor-cost trend / AN- insights / scope×period as-of | PARTIAL — EXISTS `GET /api/v1/kpi`, `GET /api/v1/exports/kpi` (#223), cost-ledger + lifecycle-cost per equipment; **GAP: analytics derivations** (contract profitability, labor-cost trend, AN- insight objects with evidence chains); **GAP: effective-dating / as-of** for period reconstruction |
| Every number drills to source object | EXISTS objects resolve once the aggregate cites source ids — analytics gap must return evidence refs, not bare numbers |
| Dispatch SLA lanes | EXISTS dispatch reads; SLA bucket computation client-side or in analytics gap |

## 모듈 서피스 10종 (post-snapshot-screens)

| Module | Backend mapping |
|---|---|
| maintenance WO- | EXISTS work-orders family (richest domain; canonical codes) |
| purchase PO- | EXISTS financial/purchase-requests family (SoD, attachments, execute) |
| asset FL- | EXISTS equipment family + `/versions` + `/versions/{version}/rollback` + `/timeline-graph` + cost-ledger |
| field ST- (고객·현장) | EXISTS sites + customers; contract×SLA cross-refs → object-links |
| directory | EXISTS employees/users (prototype builds it from PEOPLE — same) |
| finance VC- (전표/GL) | **GAP: module domain — finance vouchers** (rental-quotes/cost-ledger exist; no VC- voucher/GL model) |
| inventory IV- | **GAP: module domain — inventory** (zero backend; qty/safety-stock/consumption) |
| compliance CP-/RG-/FW- | PARTIAL — EXISTS `GET /api/v1/integrity/findings` + `/triage`; **GAP: module domain — compliance obligations/regulations/frameworks** (CP- obligations, RG- regulation impact objects, FW- control→evidence matrix) |
| laborcost (경영 분석) | **GAP: analytics derivations** (shared with dashboard) |
| board NT- | **GAP: board/notices (NT-) domain** (posts, receipt-progress `prog` done/total) |

All 10 ride the shipped substrate: lifecycles + object-links + objects resolve + code issuance — per the audit, each remaining module = a thin domain crate + screen, not platform work.

## Cross-cutting systems (03-systems)

| System | Backend mapping |
|---|---|
| Audit backbone (logEvent everywhere) | EXISTS `with_audit` (16 domain families) + chain seal + attestation; enrichment gap as noted |
| Generic lifecycle engine + pendingRev + save/apply whitelist | EXISTS `/api/v1/lifecycles/*` + period-locks + equipment/workflow-def versioning; **GAP: versioning generalization** to remaining object types as their modules ship; **GAP: effective-dating / as-of** |
| Impact pre-check before effectuate/dispose | PARTIAL — identity policy-role preview pattern only; **GAP: generic dependents-preview endpoint** (registry per object type — small, BE-LC follow-on) |
| Guardrails §3.10 (attestation checklist, four-eyes peer, configurable SoD, egress) | PARTIAL — authority fail-closed + passkey step-up + engine SoD guard EXIST; **GAP: guardrail control-point objects** (checklist/peer-review/egress as wf.exec.v1 node-level control points) |
| Token grammar (@/#/! PBAC-gated) | EXISTS message_refs + objects resolve + me/authz; candidate dropdown → **GAP: global object search** |
| View-as personas | demo affordance — real backend = real principals; no gap (do not build impersonation) |
| Covert clearance / CEO-only audit stream | **GAP: covert clearance** — defer to Cedar promotion (audit gap 26; do not build in legacy matrix) |
| Office editor (ONLYOFFICE heavy fork) | **GAP: office-editor integration** — separate P3/P4 epic (HANDOFF §12); UI contract only today |

---

# Gap Register (ranked)

## P1 — blocks overview / mywork / appr

1. **Submittable-templates catalog** — all-employee `GET /api/v1/workflow-studio/submittable-definitions`; without it the 기안 compose tab has no live template source (known: PR #233). Smallest P1; do first.
2. **Global object/person search** — one Cedar-gated search endpoint (name/code prefix/type) over the object registry; blocks ⌘K palette, compose 대상 지정 picker, explore search, token-grammar dropdowns.
3. **Unified my-action-inbox read model** — either a `GET /api/v1/me/action-items` aggregate or sanctioned client fan-in; the hard backend part is due/SLA/urgency metadata (and the `stats` trend block) that the constituent lists don't carry today.
4. **InboxDoc domain (개인 수신함)** — inbox documents + passkey receipt-confirm mutation (audit `receipt/self`) + AP- finalize tie-back; blocks the inbox screen, mywork's 수령확인 stat, and the statutory-notice chain. Compliance-critical (열람 = 법적 수령).
5. **Leave-request domain + statutory push** — request queue, decide, ledger write-back, 연차촉진/노무수령거부 generation into InboxDoc; feeds both appr inbox and the leave screen.
6. **Clock-in/out (punch) endpoint** — small; overview punch chip + self attendance.

## P2 — comms

7. **Messenger parity fields** — channels/DM distinction, presence, ack reactions, reply-quote metadata, per-thread mute (personal-setting direct save).
8. **Mail governance** — egress/DLP gate evaluation (external recipient × lifecycle/classification → block + anomaly audit + compliance alert), classification/retention/litigation-hold on mail, sender-auth (SPF/DKIM/DMARC) result surface.
9. **Board/notices (NT-) domain** — posts + receipt-progress; backs the rail 공지 section and the board module surface.

## P3 — modules / audit / policy / auto

10. **Payroll REST surface** — run pipeline (calc/exceptions/submit), register rows, entity cost, payslip self-view (audit-exempt); the pay screen and appr's payslip rail have literally zero endpoints.
11. **Attendance aggregates + exception queue** — org-drill month matrix, site coverage, 주52 weekly projection; exception objects with evidence + justified resolve (also feeds HR screen + close gate). Period-lock substrate already EXISTS.
12. **Recruit pipeline domain** — postings/candidates/stage FSM/hire→employee chain/rejected pool.
13. **Review-cycle domain** — 평가 teams progress + per-person tasks (bespoke FSM in-slice per UI-M12).
14. **Benefit-catalog domain** — rows to hang on the existing lifecycle engine.
15. **Records-archive + evidence (EV-)** — DOCS registry (IN- registration, retention enforcement, records-manager approval) + EV- objects (SHA-256/TSA/WORM custody, admissibility, legal hold) + signed export.
16. **Cedar policy catalog/authoring** — policy screen read/simulate/no-code save; Cedar is shadow-only with zero authoring surface.
17. **Audit context enrichment + filters/export** — request-context columns (ip/device/auth_method), classification/reason/anomaly, action/time-range/full-text filters, signed export. (target_id/trace_id CLOSED on main; backfill `/api/audit` into openapi.yaml.)
18. **Ingest pipeline (DX-)** — whole domain: jobs, 7-stage deterministic pipeline, connectors, mapping templates, provenance/lineage, commit-to-ontology. Largest net-new build.
19. **Automation canvas semantics** — condition/branch node kinds, persisted trigger blocks, four-eyes publish on definitions.
20. **Effective-dating / as-of + versioning generalization** — valid_from/to + as-of reads (org restructure, dashboard scope×period) + `<object>_versions` beyond equipment/workflow-defs; generic dependents-preview endpoint.
21. **Module domains: finance VC-, inventory IV-, compliance CP-/RG-/FW-** — thin domain crates on the shipped object/lifecycle substrate.
22. **Analytics derivations** — contract profitability, labor-cost trend, AN- insight objects with evidence-chain refs, cross-module KPIs.
23. **OT- type-card lifecycle + SR- series** — type propose/review/archive w/ instance migration; series = generalize-or-descope decision.
24. **Guardrail control points** — attestation checklist / peer four-eyes / egress as configurable wf.exec.v1 control points.
25. **Field-tier read gates** — per-section sensitive reveal (bank/emergency/payroll on the person card) as distinct logged step-up reads.
26. **Deferred epics** — office-editor integration (ONLYOFFICE fork), covert clearance (Cedar promotion dimension), site geo authoring.

# Gap → Charter mapping

| Gap | Owner charter |
|---|---|
| 1 submittable-templates | **BE-WF-HARDEN follow-up** (Engine-Gen; named in audit §5 as the PR #233 follow-up) |
| 2 global object search | **BE-OBJ slice 2** (extend the resolve/registry crate; also settle the url_path authority decision item) |
| 3 unified action inbox | **NEW: BE-INBOX-AGG** (thin aggregate over existing lists) or explicit client fan-in decision at UI-M3 review — decide before building twice |
| 4 InboxDoc + receipt | **UI-M5 in-slice** per audit ("in-slice InboxDoc + webauthn infra exists") — if it outgrows a slice, split as **NEW: BE-DOCS-INBOX** |
| 5 leave requests + statutory push | **NEW: BE-HR-LEAVE** (rides workflow engine + InboxDoc) |
| 6 punch endpoint | **BE-HR-LEAVE** (or a 1-endpoint rider on attendance) |
| 7 messenger parity | **NEW: BE-COMMS-PARITY** |
| 8 mail governance / egress-DLP | **NEW: BE-MAIL-GOV** (mox-integration charter, HANDOFF §14) |
| 9 board NT- | **BE-COMMS-PARITY** (or module-domain batch, #21) |
| 10 payroll | **NEW: BE-PAY** (biggest domain gap; feeds att-pay, appr payslips, inbox payslips) |
| 11 attendance aggregates + exceptions | **NEW: BE-HR-ATT** (period-locks from BE-LC already shipped) |
| 12 recruit / 13 review / 14 benefit | **UI-M12 bespoke FSM in-slice** per audit; promote to **NEW: BE-HRX** if slices balloon |
| 15 records-archive + EV- | **NEW: BE-DOCS** (retention/hold rides shipped BE-LC `/hold`) |
| 16 Cedar policy authoring | **Cedar promotion charter** (also owns covert clearance, #26) |
| 17 audit enrichment/filters/export | **Audit-Chain follow-up** (nullable request-context columns named in `.omc/plans/audit-chain-lane.md`; PR-2/PR-3 lane) |
| 18 ingest | **NEW: BE-INGEST** (HANDOFF §10 is the spec; largest charter — start dark-mocked UI regardless) |
| 19 canvas semantics | **BE-AUTO follow-on** (audit gap 10, "canvas already deferred to follow-on charter") |
| 20 effective-dating/versioning/impact-preview | **BE-LC follow-on** (BE-LC #211 shipped FSM+locks+partial versioning; temporal layer explicitly remains) |
| 21 finance/inventory/compliance modules | **consensus re-plan UI-M13+** per audit §9 (thin domain crates on BE-OBJ/BE-LC) |
| 22 analytics | **NEW: BE-ANALYTICS** (must emit evidence refs for the drill invariant) |
| 23 OT-/SR- | **BE-OBJ slice 3** — with the audit's standing recommendation to consider descoping SR- |
| 24 guardrail control points | **BE-WF-HARDEN follow-on** (generalize financial/HR-exit SoD patterns as node control points) |
| 25 field-tier read gates | generalization of the #202 view-audit pattern — **UI-M9 slice** |
| 26 office / covert / geo | separate deferred epics (office = P3-P4 epic; covert = Cedar promotion; geo = 1-column rider on sites) |
