# INFORMATION ARCHITECTURE & LAYOUT LENS — Oyatie Console vs vendors

Independent pass. Vendor claims labeled **[V]** (verified, source URL) or **[I]** (inferred from known product patterns). Our-console column read from `web/src/console/**` + `docs/program/console-program-ledger.md`.

> **Deliverable note:** the `benchmark/draft/` dir is a protected sibling artifact (draft matrices) I was told not to read/clobber. All 14 module sections are consolidated here in `lens/ia-layout.md`.

---

## 0. Our console's IA — ground truth (code evidence)

- **Left sidebar**, 9 groups, Korean labels carbon-copied from `Oyatie Console.dc.html`: 개요 · 인사 · 급여·근태 · ERP · 현장운영 · 거버넌스 · 분석 · 자동화 · 커뮤니케이션 (`shell/nav.ts:84-228`). **Deny-by-omission** gating (item hidden unless role/feature grant intersects); empty groups dropped. Responsive auto-collapse <1280px (`ConsoleShell.tsx:51-68`).
- **Topbar**: group-company **scope selector** (UNION_SCOPE — 법인/branch scoping), **⌘K command palette** — but **results surface is empty/unwired** (`ConsoleShell.tsx:326` "full palette … is a later slice"), theme cycle, user chip.
- **Right comms rail**: fixed **54px collapsed strip only** (messenger/mail/notif glyphs); the interactive rail is **not built** (`ConsoleShell.tsx:210-244` "presentational here").
- **Navigation is `state.screen`-driven, NOT react-router** (`ConsoleApp.tsx:24`, `ConsoleShell.tsx:70`). No breadcrumbs; flat 2-level (group → item).
- **Generic master-detail engine** (`module/ModuleScreen.tsx`): header (title + search + policy-gated primary action) → **statbar** (exception-only chips, `0`→em-dash, §4.7-1) → optional **prog bar** → body = **list-table** (resizable cols snapping to 8px ticks, **J/K/Enter** keyboard grammar) OR **kanban lanes** → **single 22rem right `DetailPanel`** (KV grid + object **link chips** that route to object nav + policy-gated action footer).
- **TWO parallel module engines coexist** — a divergence: legacy `module/ModuleScreen.tsx` (workOrder/support configs) AND newer ontology-driven `modules/moduleScreens.ts` (finance/asset; columns derive from `ONT_TYPES.propSchema`, `dataAdapter` pattern, richer link-chip graph). Two grammars for "a module."
- **Ontology-first grammar**: link chips carry object-kind tone and route to object nav; object surfaces exist as `explore/ObjectExplorer`, `ontology/OntologyManager`, `objectcard/ObjectCard`, `lifecycle/LifecycleCard`, `policycanvas`, `workflows` canvas.
- **Nav offers more than exists**: `mywork, inbox, recruit, orgchart, evaluation, purchase, inventory, dispatch, forecast, scheduled, board, directory` are nav items with **no built screen** located under `console/`. `badges` is hard-coded `{}` — **no live counts anywhere** (`ConsoleShell.tsx:148`).

---

## 1. Overview (개요 / mywork / inbox)

| Vendor | Landing IA | Disclosure | Src |
|---|---|---|---|
| SAP Fiori | Role-based launchpad tiles w/ **live status counts** on tile face; hub-and-spoke tile→app. | count→app list | [V] sap.com fiori launchpad overview |
| Workday | **Worklets**; select → **Actions \| Views** two-column split; search-first. | worklet→actions/views | [V] workday worklet docs |
| ServiceNow | Persona **home = actionable insights + quick links**. | card→workspace | [V] servicenow next-experience landing-page |
| Palantir Carbon | Workspace = curated apps + configurable menu bar; enter a workflow, no generic home. | menu-bar step | [V] palantir carbon/workspaces-overview |

**Ours:** thin — `overview`/`mywork`/`inbox` nav items, no rich landing component; shell body historically an empty `<section>`; no live counts. **Korean context:** 전자결재 culture wants **결재 대기함** as the hero of home (다우오피스 makes 상신/수신함 the landing) — our `mywork` instinct is right but unbuilt.
**Steal:** (1) live nav/tile counts → Fiori — `NavBadge` type already exists, unwired [**S**]; (2) Actions\|Views landing grammar → Workday [**M**]; (3) 결재 대기함 hero card [**S**].

## 2. Dashboard (분석 / KPI)

| Vendor | IA | Disclosure | Src |
|---|---|---|---|
| Workday | Configurable worklet dashboards; per-worklet order/size/security. | worklet→report | [V] workday dashboard docs |
| SAP Fiori | Overview Page card grid + **smart-filter bar driving all cards**. | card→list app | [V] fiori overview |
| Palantir | Every metric = object aggregation; drills to Object Explorer set. | metric→object set | [V] palantir explore-charts |

**Ours (`DashboardScreen.tsx`):** genuinely ahead — **PBAC-relative scope segments** (§4.5), **typed month-period segments** (§4-19), **one-row drill-everywhere stat strip** (§4-11), **honest-scale charts** (§4-24), **omits unbacked sections** not placeholders (§4-12). **DIVERGENCE/bug:** drills use react-router `Link to="/dispatch|/approvals|/ops"` (`import { Link } from "react-router-dom"`; the `<Link to="/dispatch">` is at ~line 486, the stat strip itself at 162-225) while the console is `state.screen`-driven — likely dead-ends outside the shell.
**Steal:** (1) fix drills to route into `objectExplorer`/screen model, not router paths → Palantir + correctness fix [**S**]; (2) smart-filter bar unifying scope+period → SAP [**M**]; (3) user-configurable dashboard [**L**].

## 3. Finance (ERP / 전표)

| Vendor | IA | Disclosure | Src |
|---|---|---|---|
| SAP Fiori S/4HANA | **Object Page**: header facets + anchored sections (tabs) + related; smart-filter **list report**→object page→sub-object. **Dense tables.** | list→object→sub | [V] fiori s4hana best-practices |
| Salesforce | N/A — CRM, no native GL/finance-of-record. | — | [I] |
| Workday Fin | Related-Actions on every amount/account. | related actions | [I] parity w/ HCM |

**Ours (`financeModuleScreen`):** fully ontology-driven (columns from `ONT_TYPES.finance_voucher.propSchema`); rich **link-chip graph** (voucher→DX/AP/payroll/purchase/contract/GL/cost_ledger); exception-only statbar; honest `blockedUntil` on unbuilt actions. **GAP:** single 22rem panel, no anchored multi-section **object page**, sub-objects (JE lines/GL) open only as chips that **navigate away, losing context**. **Korean:** 전표→증빙 linkage + 법인별 원장 fits our link-graph + scope model better than SAP localization.
**Steal:** (1) SAP anchored in-panel sections (header→JE lines→GL→audit) so drill doesn't lose context [**M**]; (2) smart-filter list report [**M**]; (3) compact/comfort density toggle [**S**].

## 4. People (인사 / 조직도 / 평가)

| Vendor | IA | Disclosure | Src |
|---|---|---|---|
| Workday HCM | Worker profile = **anchored sections** (Job/Comp/TimeOff/Career); **Related Actions everywhere**; search-first find-a-person; org-chart drill. | section tabs; org drill | [V] workday HCM nav docs |
| SuccessFactors | People-Profile block wall; photo-card org chart. | block→detail | [I] |

**Ours:** 4 nav items, only `identity/` has real components; `recruit/orgchart/evaluation` **unbuilt**; no worker object page (would fall to generic list+KV panel). **Korean:** 직급 vs 직책, 호봉, 발령 history, 법인→본부→팀 org — Workday's flat "position" mismatches 직급 tables; our ontology can model 직급/호봉 as object props natively (edge if built).
**Steal:** (1) Related-Actions menu → our object-action catalog already exists in asset module [**M**]; (2) anchored worker profile (Job/발령/평가/근태) [**M-L**]; (3) org-chart drill reusing topbar scope tree [**M**].

## 5. Leave (급여·근태 / 휴가)

| Vendor | IA | Disclosure | Src |
|---|---|---|---|
| Workday Absence | Time-Off worklet; request → approval routing; balance card. | request→approval | [I] from worklet model |
| Korean HR (시프티/flex) | Calendar-grid team leave board + 잔여 연차 counter + 결재 line. | calendar→request | [I] Korean HR SaaS norm |

**Ours:** `leave/LeaveConsole.tsx` exists (real component). Likely list-based. **Korean context is decisive:** 근로기준법 mandates 연차 accrual rules, 대체공휴일, 반차/반반차; leave **must** flow through 전자결재 결재선. A global vendor's flat PTO request mismatches 근로기준법 accrual + 결재 routing.
**Steal:** (1) team **calendar-grid** leave board (who's out) → Korean HR SaaS [**M**]; (2) 잔여 연차 balance counter tied to 근로기준법 accrual [**M**]; (3) leave-request → 결재선 handoff (reuse `appr`) [**S**].

## 6. Support (현장운영 / 티켓)

| Vendor | IA | Disclosure | Src |
|---|---|---|---|
| ServiceNow | Configurable **agent workspace** replaces list+form; progressive disclosure via cards/tabs/sections; single-pane. | list→record tabs | [V] servicenow next-experience UI |
| Salesforce Console | **Workspace tabs + subtabs** (related records = subtabs); **split view** (list left/detail right); **utility bar** docked footer. | tab/subtab; split | [V] salesforce lightning console help |
| Zendesk | Ticket list + composer; macros. | list→ticket | [I] |

**Ours (`supportTicketModuleConfig`):** generic ModuleScreen, list + 22rem panel + resolve action (real mutation). Exception-only chips. **GAP:** no multi-record **tabs/subtabs** — you can hold only ONE open detail; no **split view** persistence; no **utility bar**. An agent juggling 5 tickets can't tab between them.
**Steal:** (1) **workspace tabs + subtabs** for multi-record work → Salesforce (biggest agent-productivity gap) [**L**]; (2) utility bar (notes/recent) as docked footer → Salesforce [**M**]; (3) progressive-disclosure tabbed record → ServiceNow [**M**].

## 7. Evidence (거버넌스 / 증빙)

| Vendor | IA | Disclosure | Src |
|---|---|---|---|
| ServiceNow GRC | **Audit Management Workspace** — single-pane audit timeline+status; evidence-request/control-test/observation in-workspace; persona home + quick links. | timeline→control→evidence | [V] servicenow grc audit workspace |
| AuditBoard (Optro) | SOX-team workspace: control→test→workpaper→evidence chain. | control→workpaper | [V] flevy GRC roundup |

**Ours:** `evidence/EvidenceCard`, `EvidenceRecords`, `audit/` (tamper-evident chain, MEMORY: L20 audit-chain). Card + records list. **Edge:** our audit chain is **cryptographically sealed** (memory: seal worker + CoverageGap verify) — stronger integrity guarantee than vendor evidence stores. **GAP:** no single-pane **audit-timeline workspace** tying request→control→evidence→observation.
**Steal:** (1) single-pane audit-timeline workspace → ServiceNow GRC [**M**]; (2) evidence-request task loop (recurring auto-request) → ServiceNow [**M**]; (3) surface the seal/verify verdict inline as an evidence-card badge (our unique edge) [**S**].

## 8. Object-platform (오브젝트 / 온톨로지 — our differentiator)

| Vendor | IA | Disclosure | Src |
|---|---|---|---|
| Palantir Foundry | **Object Explorer**: side-nav object groups → search/filter → **exploration view (charts, ≤20 preview cards)** → **Object View tabs**; **Layouts** = shareable saved views (charts+cols+sort); **Carbon** menu-bar workflow step-through. | group→set→object→view | [V] palantir object-explorer overview/getting-started |

**Ours:** `explore/ObjectExplorerScreen`, `ontology/OntologyManagerScreen`, `objectcard/ObjectCard`, `explore/RelationAuthoringPanel`, `policycanvas`. This is our closest-to-Palantir surface and the strategic core. **Assessment vs Palantir:** we have the object card + relation authoring + ontology manager, but likely lack (a) **configurable object groups** in a side-nav, (b) **exploration-view charts as the filter mechanism** (chart-click = filter), (c) **saveable/shareable Layouts**, (d) **multi-object tabs**.
**Steal:** (1) **chart-as-filter exploration view** (each chart = property aggregation, click to filter set) → Palantir — the single highest-fidelity gap for the differentiator [**L**]; (2) **saveable shareable Layouts** [**M**]; (3) configurable object-group side-nav [**M**]; (4) **Object View tabs** (multi-object) [**L**].

## 9. Policy (거버넌스 / PBAC — Cedar)

| Vendor | IA | Disclosure | Src |
|---|---|---|---|
| Palantir | Restricted views / markings on object properties; no visual policy IDE exposed. | inline marking | [I] |
| AWS/Cedar, OPA | Policy-as-code editors: policy list + test/playground + decision trace. | policy→test→trace | [I] Cedar/OPA tooling norm |

**Ours:** `policy/` (PolicyGate/PolicyGated/usePolicyGate) + `policycanvas/` — **policy gating is woven into every surface** (actions/nav/stats gate on policy codes). This ambient enforcement is more mature than any vendor's bolt-on. **GAP (IA):** no first-class **policy authoring workspace** (policy list → editor → **test/simulation** → **decision trace**). `policycanvas` exists but coverage unclear. **Korean:** SoD (직무분리) + 법인 scoping must be expressible; memory notes R1-R9 security findings binding on Cedar design.
**Steal:** (1) policy **test/simulation playground + decision-trace** panel → Cedar/OPA norm [**M**]; (2) policy-list master-detail (policy → affected principals/actions) [**M**]; (3) "why blocked" inline trace from a gated action [**S**].

## 10. Automate (자동화 / 워크플로우)

| Vendor | IA | Disclosure | Src |
|---|---|---|---|
| ServiceNow | Flow Designer: trigger→action canvas; run history. | flow→run log | [I] from platform |
| Palantir | Pipeline/Workshop: DAG canvas over ontology actions. | node→run | [I] |

**Ours:** `workflows/` = `WorkflowAutoScreen`, `CanvasBlock`, `RunLogTimeline`, `modelFromDefinitions`. Real **canvas + run-log timeline**. Nav: `workflow` + `scheduled` (scheduled unbuilt). **Strength:** run-log timeline + canvas is the right IA. **GAP:** `scheduled` (cron/recurring) unbuilt; no clear trigger-library master-detail.
**Steal:** (1) trigger/action **library master-detail** (browse → drop on canvas) → ServiceNow Flow Designer [**M**]; (2) **run-history list → per-run trace** (partly there via RunLogTimeline) [**S**]; (3) build `scheduled` recurring view [**M**].

## 11. Comms (커뮤니케이션 / 메신저 / 메일)

| Vendor | IA | Disclosure | Src |
|---|---|---|---|
| Slack | **Channel-native** left rail forces channel selection; channel **sections**; high info density preserved through redesign. | channel→thread | [V] jarango / slack.design IA review |
| Teams | **Meeting-native** — everything radiates from calendar/meetings. | meeting→chat | [V] dev.to teams-vs-slack analysis |

**Ours:** `messenger/MessengerConsoleScreen`, `mail/`, nav `comms` group (messenger/mail/notif/board/directory). Plus the **54px comms rail** in the shell — but **interactive rail unbuilt** (strip only). **Decision point:** are we channel-native (Slack) or thread/DM-native? Rail-as-persistent-comms (always-docked messenger) is a **Teams/Slack hybrid** — good instinct, unbuilt. **Korean:** auditable in-app chat, no E2EE (memory: forklift decisions).
**Steal:** (1) build the **interactive docked comms rail** (persistent messenger without leaving the module) — our shell already reserves the space [**L**]; (2) channel **sections** for org/법인 grouping → Slack [**M**]; (3) keep high density, resist the "lighter/playful" Slack drift — enterprise ops wants density [**S**].

## 12. Appr (거버넌스 / 전자결재) — Korean-critical

| Vendor | IA | Disclosure | Src |
|---|---|---|---|
| 다우오피스/더존/네이버웍스 | **결재선** configurable/fixed; **상신함** + **반려문서** states; drafter states 반려/협의요청/완료 vs approver states 예정/대기/완료; ~100 form types; mobile approval. | form→결재선→상신 | [V] daouoffice / hanbiro groupware docs |
| Workday | Business-process approval routing (Related Actions). | inbox→approve | [I] |

**Ours:** `appr/ApprovalCompose.tsx` + `composeModel` (real 전자결재 compose). Nav `appr` (checkSq). **This is the module where global vendors structurally mismatch Korea** — SAP/Workday model approval as a flat inbox; Korean 전자결재 needs **결재선 (sequential + 병렬 + 전결/대결)**, 상신/수신/반려 함 separation, and drafter-vs-approver **state dualism**. Our `ApprovalCompose` is the right foundation.
**Steal:** (1) **결재선 builder** (순차/병렬/전결/대결) as the compose core → Korean groupware — no global vendor does this [**M**]; (2) **함 IA**: 상신함/수신함/반려함/완료함 as master-detail tabs [**M**]; (3) drafter/approver **dual-state chips** (예정/대기/완료 vs 반려/협의) [**S**].

## 13. Field (현장운영 / 배차 / 정비)

| Vendor | IA | Disclosure | Src |
|---|---|---|---|
| ServiceNow FSM | **Dispatcher Workspace**: single configurable screen = unassigned tasks + **technician schedule board** (local-time aligned) + **live map** + drag-drop assign; configurable task/agent cards. | board+map single-pane | [V] servicenow dispatcher-workspace docs |
| Salesforce Field Service | Gantt scheduler + map + service appointments. | gantt→appointment | [I] |

**Ours:** nav `dispatch/maintenance/field` (fieldOps group) — but **screens unbuilt**; work orders flow through the generic **kanban lanes** (unassigned/active/review) in `workOrderModuleConfig`. **GAP:** no **schedule board** (time-grid), no **map**, no **drag-drop dispatch** — the three defining FSM IA elements. Kanban lanes are a weaker substitute for a dispatcher.
**Steal:** (1) **dispatcher single-pane** = unassigned-queue + schedule board + map → ServiceNow FSM (defining gap) [**L**]; (2) **drag-drop assignment** onto technician/timeslot [**M**]; (3) local-time-aligned schedule grid [**M**]. (Mobile field-exec is the native Android app, not console — correct split.)

## 14. Compliance (거버넌스 / 무결성)

| Vendor | IA | Disclosure | Src |
|---|---|---|---|
| ServiceNow IRM/GRC | Connects risk/control/audit; **automate control testing**, centralize evidence; persona home + module nav. | control→test→evidence | [V] servicenow IRM product page |
| AuditBoard | Control→test→finding→remediation chain. | control→finding | [V] flevy roundup |

**Ours:** nav `compliance` (fileCheck) gated `INTEGRITY_ROLES + integrity_findings_read` (EXECUTIVE/SUPER_ADMIN; ADMIN **excluded by design** — a deliberate SoD choice). Ties to `evidence/` + `audit/` chain. **Edge:** integrity findings + sealed audit chain = automated control evidence with cryptographic integrity. **GAP:** no **control→test→finding→remediation** master-detail workflow surface.
**Steal:** (1) control-library → test → **finding → remediation** master-detail → AuditBoard/ServiceNow [**M**]; (2) automated control-test scheduling (reuse `automate` + `scheduled`) [**M**]; (3) findings inbox routing to `appr` for remediation approval [**S**].

---

## CROSS-MODULE TOP-10 FINDINGS (ranked)

1. **No multi-record workspace (tabs/subtabs/split-view persistence).** We hold exactly ONE open detail (single 22rem panel). Salesforce workspace-tabs+subtabs [V] and ServiceNow configurable workspaces [V] let an agent juggle N records. Hurts **support, appr, field, finance, people** most. Highest-leverage structural gap. Cost **L**.

2. **The 22rem detail panel loses context on every drill.** Related objects (JE lines, GL, worker 발령, controls) open only as **link chips that navigate away**. SAP Object Page anchored sections [V] and Salesforce subtabs [V] keep the parent in view. Adopt **in-panel anchored sections** for object pages. Cost **M**, repo-wide payoff.

3. **Zero live counts anywhere** — `badges = {}` hard-coded (`ConsoleShell.tsx:148`). SAP Fiori tiles [V], ServiceNow quick-links [V], every Korean groupware home leads with **결재 대기 counts**. `NavBadge` type already exists, unwired. Cost **S**, huge perceived-liveness win.

4. **Command palette is an empty shell.** ⌘K opens but `data-cshell-palette-results` is empty (`ConsoleShell.tsx:326`). Linear/Notion [V] make Cmd+K the *primary* nav that "skips the linear IA." For a 9-group / 30+ item nav this is the single biggest keyboard-productivity miss. Cost **M**.

5. **Two divergent module engines** (`module/ModuleScreen` vs `modules/moduleScreens`). One ontology-driven with dataAdapter + propSchema columns, one hand-config. Every module should be the newer ontology-driven grammar; the fork is tech-debt that will make cross-module IA inconsistent. Consolidate. Cost **M**.

6. **Dashboard drills route to react-router paths that don't exist in the state.screen model** (`/dispatch`, `/approvals`, `/ops` — DashboardScreen.tsx:162-225) while the whole console is `state.screen`-driven. Likely dead-ends. Correctness bug + IA inconsistency; drills should route to `objectExplorer`/screen keys (Palantir metric→object-set model [V]). (The react-router `<Link to="/dispatch">` is at ~line 486; 162-225 is the stat strip.) Cost **S**.

7. **The object-platform (our Palantir analog) lacks chart-as-filter exploration + saveable Layouts.** Foundry Object Explorer [V] makes charts the *filter mechanism* and Layouts shareable. This is the differentiator module — closing this is strategic, not cosmetic. Cost **L**.

8. **Field/dispatch has no schedule board or map** — the three defining FSM IA elements (queue + time-grid board + live map + drag-drop) are absent; work orders fall back to weak kanban lanes. ServiceNow Dispatcher Workspace [V] is the reference. Cost **L**.

9. **전자결재 (appr) is where global vendors structurally mismatch Korea — lean in.** 결재선 (순차/병렬/전결/대결), 상신/수신/반려/완료 함 IA, and drafter-vs-approver dual-state [V Korean groupware] have NO global-vendor equivalent (SAP/Workday = flat approval inbox). Our `ApprovalCompose` foundation + this IA is a genuine local moat. Cost **M**.

10. **Nav promises screens that don't exist** (mywork, inbox, recruit, orgchart, evaluation, purchase, inventory, dispatch, forecast, scheduled, board, directory). Deny-by-omission hides by *grant*, not by *built-ness* — a granted user clicks into emptiness. Either gate on a `built` flag or ship stubs-with-honest-blocked-chips (the `blockedUntil` pattern already used in finance is the right model). Cost **S** (gating) / ongoing (build).

### Cross-cutting synthesis
Our IA has **two genuine edges no vendor matches**: (a) **PBAC/scope woven into the shell** (scope selector + deny-by-omission + policy-gated everything) — analytics and nav are authz-shaped natively; (b) **ontology-first link grammar** (every detail links typed objects). The recurring **weakness is progressive disclosure at the record level**: a single non-persistent detail panel that navigates away, no tabs, no anchored sections, no live counts, an empty palette. Vendors converged on **single-pane configurable workspaces with tabs + anchored sections + docked utilities** (ServiceNow, Salesforce, SAP Object Page); we stopped at list+one-panel. The Korean-specific moats (전자결재 결재선, 근로기준법 leave, 법인 scoping) are correctly identified in nav but mostly unbuilt.
