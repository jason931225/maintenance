# TASK-FLOW LENS — money task step/click count, ours vs vendors (14 modules)

Method: for each module I name its ONE money task, count the interaction steps in
OUR console (evidence: `web/src/console/**` read directly + `docs/program/console-program-ledger.md`),
then compare vendor step-count. Every vendor claim is [V] (source URL) or [I] (inferred
from known product pattern). Korean 전자결재 / 근로기준법 / group-scope fit called out where global vendors miss it.

Rigor labels: [V]=verified w/ URL, [I]=inferred, N/A=vendor doesn't play here.

---

## 1. overview
**Money task:** triage my inbox — see what needs me, act on it.
**OURS (evidence):** overview = actionable inbox rows with code chips (ledger §fe-fix-wave1; `console/shell`, CommsRail unread summary is a wire-gap per BACKEND GAP INVENTORY). A row today = click code → opens ObjectCard pin → act inside the card. So triage-to-action = **2–3 steps** (row → card → action), and the row itself is NOT yet an actionable card (no inline approve on the inbox row).
**Vendors:**
- Slack/Teams: the inbox item IS the action surface — approve/reject buttons render inline on the message/adaptive card, **0 navigation, 1 click** [V] slack.com/blog (Approvals Bot, deals 70% faster); learn.microsoft.com (universal actions for adaptive cards).
- Workday: "My Tasks" inbox, open item → act = **2 steps** [I] (standard Workday inbox pattern).
- Palantir Foundry: home = Workshop module with Object Table; row → Object View → action button = **2–3 steps** [I] palantir.com/docs/foundry/workshop.
**Where vendors collapse what we spread:** Slack/Teams make the notification itself terminal (decision without opening anything). We always open the object first.
**What we'd steal:** actionable inbox rows (approve/reject/ack rendered on the row, PolicyGated) → collapses overview money task from 3 → 1. Vendor: Slack/Teams. Fit: our PolicyGated + GovernedObjectCard action layer already exists; render its top action inline on the row. Cost: **M**.

## 2. dashboard
**Money task:** spot an anomaly → drill to the offending object.
**OURS:** scope×period matrix + real-API stat strip + honest charts (ledger fe-fix-wave1/dashboard-rebuild). Every stat drills: stat button → ObjectCard pin. Anomaly-to-object = **2 steps** (stat → object). This is genuinely strong (drill-everything is default grammar).
**Vendors:**
- Palantir: dashboard widget → filter → Object View, drill is native, **2 steps** [V] palantir.com/docs/foundry/workshop (Object Table + Filter widgets).
- Workday/SAP Analytics: KPI tile → report → row → object = **3–4 steps** [I] (BI drill-through is multi-hop).
**Where vendors collapse:** Palantir ties every number to its backing objects (same as us). Workday/SAP do NOT — their dashboards are report-first, drill is a detour.
**What we'd steal:** little — we already match Palantir here. Guard against regressing to KPI-card dashboards (the §4-11 rule already forbids big-number tiles). Cost: **S** (hold the line).

## 3. finance
**Money task:** approve a voucher / vendor bill.
**OURS (evidence):** `FinanceModuleScreen` → `GenericModuleScreen(financeModuleScreen)`. Currently `emptyMode: blocked-until-backend` — voucher REST MISSING (visual-verdict round-1 scored finance **40/fail**, "전표 도메인 대기" placeholder chips, no stat values/CTA). So the money task resolves in **0 usable steps today** — the surface is dead. When wired: list → row → detail action = **2–3 steps**.
**Vendors:**
- SAP Concur mobile: open app → **one click** approve or send-back-with-comment; summary + invoice image + line items on one glance [V] concur.com/blog (How Concur Invoice Works).
- NetSuite: Enter Bills > List → Edit → set Approved → Save = **~4 steps**; but **bulk approve** page approves many at once [V] docs.oracle.com/netsuite (Approving Vendor Bills / Bulk Approving).
**Where vendors collapse:** Concur = 1-click from a rich single-glance card + mobile push. NetSuite = bulk approve (N bills, 1 action).
**What we'd steal:** (a) wire the voucher REST + object action so the money task exists at all — **highest-ROI gap in the whole console**; (b) 1-click approve-with-image glance card (Concur); (c) bulk/batch approve. Vendor: Concur (glance+1-click) + NetSuite (bulk). Fit: GovernedObjectCard already does preflight→execute; needs the projected-type action dispatch (ledger's "biggest §18 residual" = NotWiredYet). Cost: **L** (backend voucher domain + action wiring).

## 4. people (HR / 인사)
**Money task:** open an employee, take an HR action (change position, start offboarding).
**OURS:** employee = a domain table, NOT an engine-registered type (ontology-coverage-matrix: "position = a string column", C-/position/posting "don't exist anywhere"). People actions route through modules/ObjectCard but projected-type action dispatch = NotWiredYet. So open-employee-and-act = **2 steps to view, action often dead**.
**Vendors:**
- Workday: worker profile → Related Actions (the orange "twinkie") → action = **2–3 steps**, one consistent action menu on every object [I] (Workday Related Actions pattern is canonical).
- SAP SuccessFactors: employee file → action = **2–3 steps** [I].
**Where vendors collapse:** Workday's Related Actions menu is on EVERY worker uniformly — same muscle memory everywhere. Our ObjectCard aspires to this but projected types can't fire actions yet.
**Korean fit:** global HCM weak on 4대보험 filing, 법정 수령확인 문서, 연차촉진 — our default type catalog targets these (a genuine local edge, once wired).
**What we'd steal:** Workday Related-Actions uniformity → our ObjectCard action row IS this; the fix is backend (register employee as projected type + wire action dispatch). Vendor: Workday. Cost: **L**.

## 5. leave (연차)
**Money task:** submit a leave request / decide a team member's request.
**OURS (evidence, `leave/LeaveConsole.tsx`):** ONE screen holds all four personas. Self submit = pick reason (enum) + start date + end date + submit = **1 screen, ~4 inputs, 1 submit**. Team decide = inline approve/reject button on the queue row = **1 click** (SoD: own request shows no buttons). Promotion round (근로기준법 §61) = single contextual CTA per state. **This is our most collapsed surface — best-in-class.**
**Vendors:**
- Workday 2025 "Manage Absence": fewer clicks, request/edit in the mobile Absence calendar worklet — but self-service, decide, and 촉진 are SEPARATE worklets [V] hr.osu.edu/news/2025/05 (New Manage Absence), workday.com/absence.
- Korean 근태 (Shifty/flex): request on one screen [I].
**Where vendors collapse:** Workday reduced its own click count but still SPREADS self/approve/policy across worklets — we already beat that by co-locating.
**Korean fit:** 근로기준법 §61 사용촉진 회차 FSM (for 1년+ employees: 사용기간 종료 6개월 전 기준 10일 이내 1차 서면촉구 → 미사용 시 2개월 전까지 사용시기 지정; 1년 미만은 3개월 전 기준) is modeled natively — Workday has no concept of it. Strong local moat.
**What we'd steal:** almost nothing — instead PROPAGATE this co-located-personas pattern to other modules. Only gap: leave mutations are unwired (state-only, `ponytail: stub 법정기한`). Cost: **S** (wire the REST that exists — `hr.rs` 0111 already built).

## 6. support (SUP-)
**Money task:** resolve a ticket.
**OURS (evidence):** §4-11 stat strip + chip filters + right-pin detail (ledger support-slo, fe-fix-wave1). Resolve = filter chip → row → detail pin → action. SLO (not SLA) modeled as configurable setting object. Resolve = **~3 steps, one ticket at a time, no canned reply/macro**.
**Vendors:**
- Zendesk: **one-click macro** = canned reply + multiple field changes bundled; apply via toolbar button OR type `/` inline (no leaving keyboard); 7 most-used macros float to top [V] support.zendesk.com (Using macros / Creating macros).
**Where vendors collapse:** Zendesk macro = N field updates + reply in 1 click; we change fields one action at a time.
**Korean fit:** neutral (support is domain-generic).
**What we'd steal:** saved macros (bundled field-set + reply as a reusable ontology action) + `/`-inline apply. Vendor: Zendesk. Fit: our ontology Action types ARE bundled writebacks — expose "saved action bundle" as a macro. Cost: **M**.

## 7. evidence (EV-)
**Money task:** produce audit evidence for a record (verify fixity, apply/release hold).
**OURS (evidence, `evidence/EvidenceCard.tsx` + `crates/docs/rest`):** EvidenceCard with WORM/hash/custody/legal-hold chips; verify = **1 click** (real store fixity HEAD each copy, audited); hold = four-eyes (distinct approver). Per-record, on-demand. Verify one record = **1 click**; assemble an audit package = **N clicks (one per record)**.
**Vendors:**
- ServiceNow GRC / Audit Mgmt: **continuous automated evidence collection** — control testing + attestation auto-collect evidence before the audit, "reducing audit fatigue"; single-pane Audit Workspace [V] servicenow.com/docs (GRC Audits), store.servicenow.com (Audit Management).
**Where vendors collapse:** ServiceNow makes audit-time evidence steps ≈ **0** (evidence pre-collected continuously); ours is verify-on-demand (N steps at audit time).
**What we'd steal:** scheduled/continuous auto-verify + auto-attestation so an audit package assembles itself. Vendor: ServiceNow GRC. Fit: L20 seal worker already runs; extend to scheduled re-verify + package rollup. Cost: **M**.

## 8. object-platform (ontology / 온톨로지)
**Money task:** create a new object type (no-code) that wires itself end-to-end.
**OURS (evidence, ontology-coverage-matrix + `console/ontology`):** OntologyManagerScreen (type list + 6-subtab editor + revision staging). BUT add-a-type is **NOT no-code end-to-end — 6 manual steps** documented: generic create-action not auto-attached (user types can't create instances at all), code-prefix regex triplicated/hardcoded (silent drag/parse fail), MOD_SCREENS hardcoded 2-entry map, ko.ts labels, FE ONT_TYPES mirror, free-text policy/automation candidates.
**Vendors:**
- Palantir: create Action Type in Ontology Manager → auto-available in Workshop/AIP/Automate; edit objects via Action-backed Button Group; writeback dataset required once [V] palantir.com/docs/foundry/workshop/actions-use, /ontology/overview.
**Where vendors collapse:** Palantir: define the type/action once in Ontology Manager, it propagates to every downstream app automatically. We require 6 hand-edits per new type — the exact opposite of collapse.
**What we'd steal:** auto-propagation on publish (create-action auto-attach + registry-derived code prefixes replacing the triplicated regex + data-driven MOD_SCREENS + ONT_TYPES from GET /object-types). Vendor: Palantir. Fit: this is literally Phase C wave 2's stated acceptance test. Cost: **L**.

## 9. policy (Cedar PBAC)
**Money task:** author a policy that denies/permits an action, verify it before ship.
**OURS (evidence, `console/policycanvas` + Cedar authoring REST):** P→R→A→Effect block canvas + typed predicates + live simulator (deny-by-omission) + four-eyes publish. Author = drop blocks → set predicates → simulate → submit → review. Simple allow/deny rule = **~5+ interactions** (canvas is powerful but heavy for a one-line rule).
**Vendors:**
- AWS Cedar / OPA: policy-as-text (`permit(...) when {...}`) — fast for authors who write, opaque for non-devs [I] (Cedar is our own backend spine).
- Palantir governance: policy on object/property via UI [I].
**Where vendors collapse:** for the 80% simple rule, a text/one-line path beats a canvas. Our canvas is correctly richer for branching but overkill for "deny X to role Y".
**Korean fit:** group-company (법인) scoping + clearance (console:deploy 민감정보 fail-closed) is modeled — global policy engines don't ship 법인-scope semantics.
**What we'd steal:** a "quick rule" linear path (single P→R→A→Effect row) alongside the canvas for simple policies; keep canvas for branching. Vendor: Cedar text ergonomics. Fit: the block model already serializes; render a 1-row form variant. Cost: **S–M**.

## 10. automate (자동화 / Automate)
**Money task:** build a trigger→action automation.
**OURS (evidence, `console/workflows` + Automate hub):** BlockCanvas typed nodes + 2px connectors + branch ≥2 outputs + live sim + runLog; effect = ontology action; monitors-as-definitions. Build = drag nodes → connect → configure → publish (four-eyes). Simple 1-trigger-1-action = **canvas-heavy, ~5+ steps**.
**Vendors:**
- Zapier: **linear** trigger→action, plain language, 1-click app connect — fastest for simple, weak at branching [V] n8n.io/vs/zapier.
- n8n: node canvas (like ours), more config, better branching visibility [V] n8n.io/vs/zapier.
- Palantir Automate: effect = Ontology Action (same model as ours) [V] palantir.com/docs/foundry/workshop/actions-use.
**Where vendors collapse:** Zapier collapses the simple case to a linear 2-step form; we (rightly) match n8n's canvas but pay n8n's simple-case tax.
**What we'd steal:** Zapier-style linear quick-automation for the trigger→action 80%; our effect=ontology-action already matches Palantir (keep). Vendor: Zapier (simple path). Cost: **M**.

## 11. comms (messenger)
**Money task:** turn a conversation into a decision/action on an object.
**OURS (evidence, `console/messenger`):** 3-tier rail, reply-in-thread, presence, object-card unfurl, objDrag reference-token drop into composer (PBAC-gated). You can DRAG an object into chat and unfurl its card — but the DECISION still happens on the module surface, not in the rail. Chat-to-action = **drag/unfurl in rail, then leave to act = 2+ context switches**.
**Vendors:**
- Slack/Teams: the message IS the transaction — approve/reject inline in-thread, 1 click, no leaving chat [V] slack.com/blog, learn.microsoft.com (adaptive card universal actions).
**Where vendors collapse:** Slack/Teams close the loop inside chat; we unfurl the object but bounce the user out to decide.
**What we'd steal:** in-rail action buttons on the unfurled object card (approve/ack/decide without leaving the rail) — we already unfurl + PolicyGate; add the terminal action. Vendor: Slack/Teams. Fit: CommsRail↔main promotion + GovernedObjectCard action layer exist; wire the action into the unfurl. Cost: **M**.

## 12. appr (전자결재)
**Money task (draft side):** compose an approval; **(decide side):** approve/reject.
**OURS (evidence, `appr/ApprovalCompose.tsx`):**
- Compose: select template (1 click) → fill title/reason(enum)/body → **type-and-submit object search form** → click each result to link target → review 결재선 preview → SoD check → submit. = **~6–8 interactions**, the object-linking is a manual typed search even when you already hold the object.
- Decide (`ApprovalDecisionPanel`): type comment → approve/reject/return = **1–2 clicks**; self-block enforced; delegate + post-finalization-reject + compensation modeled.
**Vendors:**
- Korean groupware (Hiworks/Douzone/Daou): 20+ mobile templates, draft-and-approve on mobile in real-time, 결재선 set by document type all at once, SMS/messenger notify [V] hiworks.com/market/approval, biz-solution.hiworks.com/product/function/groupware/approval, daouoffice.com/features_approval.jsp.
- SAP Concur / Slack / Teams: 1-click approve from push/inline [V] concur.com/blog, slack.com/blog.
**Where vendors collapse:** (a) decide from the notification (Concur/Slack/Teams) — 1 click, 0 nav; (b) Korean groupware pre-binds 결재선 by document type so the drafter never hand-picks approvers; (c) rich template library (20+) vs our thin catalog.
**Korean fit:** WE model what global vendors CAN'T — 결재선 preview, 전결/대결 (delegate finalize), post-finalization reject, SoD/four-eyes, reason enum, compensation. This is a real 전자결재 moat. The gap is ERGONOMICS not semantics.
**What we'd steal:** (1) decide inline from inbox/push (Concur/Slack) — biggest collapse; (2) auto-bind 결재선 by template so the drafter skips approver picking (Korean groupware); (3) launch-approval-FROM-object-card with target pre-linked (kills the manual object search); (4) richer template catalog. Vendors: Concur/Slack (1-click decide) + Hiworks/Douzone (결재선 + templates). Cost: **M** (decide-inline) / **M** (pre-link from card).

## 13. field (현장 / work order)
**Money task:** dispatch a work order to a technician (dispatcher) / complete it on-site (tech).
**OURS (evidence):** the new ontology console has NO dedicated field surface — WO- is handled generically via modules/ObjectCard; the L-Mobile employee-app + bottom-tab is DEFERRED (ledger Tier-1 "L-Mobile … M, deferred"); legacy `pages/*` field-service screens are SUPERSEDED, not yet reimagined (Phase D harvest). So dispatch = generic module row → detail → action (**2–3 steps, projected-type action often NotWiredYet**); on-site mobile = **not built** in new console.
**Vendors:**
- ServiceNow FSM: intelligent dispatch auto-matches skill/location/availability (dispatcher assigns in ~1 action or fully auto); tech mobile app shows task + asset + parts in one place, offline-capable [V] servicenow.com/products/field-service-management, servicenow.com/docs (mobile agent).
- Salesforce Field Service: similar auto-dispatch + mobile [I].
**Where vendors collapse:** ServiceNow auto-assigns (dispatcher does 0 manual matching) and gives the tech a single all-in-one mobile card (WO + asset + parts).
**What we'd steal:** (a) auto-dispatch matching (skill/location) as an ontology automation; (b) the deferred mobile employee-app is the actual money-task surface for techs — prioritize it; (c) single all-in-one WO card (already the ObjectCard shape). Vendor: ServiceNow FSM. Fit: WO- projected-type action dispatch is the blocker (same NotWiredYet root as finance/people). Cost: **L** (mobile app + WO action wiring).

## 14. compliance (규제 CP-/RG-/FW-)
**Money task:** run a compliance check / simulate a policy against the regulation.
**OURS (evidence):** compliance UI surface = Phase C wave 2 (ledger); typed policy REAL evaluation for compliance is a listed BACKEND residual ("typed policy real evaluation for compliance"). Today compliance leans on the policy simulator + evidence surface. Run-a-check = **partially wired, simulate via policy canvas (~3 steps), real typed-policy eval pending**.
**Vendors:**
- ServiceNow GRC: control → continuous test → auto-evidence → issue remediation, cross-module (control change instantly updates linked risks/policies/audits) [V] servicenow.com/docs (GRC), inmorphis.com (cross-module).
- AuditBoard: control-test workflow [I].
**Where vendors collapse:** ServiceNow's cross-module propagation — update a control once, every linked register/policy/audit reflects it (0 redundant re-testing). Ours would require touching each surface.
**Korean fit:** multi-jurisdiction 규제 / PIPA consent / DSR objects are in our default catalog roadmap (epic) — global GRC is weak on Korean statutory specifics.
**What we'd steal:** cross-module propagation via the single ontology engine (a control IS an object; linked risks/policies/audits are link-types → one edit propagates for free). Vendor: ServiceNow GRC. Fit: this is exactly what single-engine ontology buys us once compliance objects are registered. Cost: **L**.

---

# TOP-10 CROSS-MODULE FINDINGS (ranked by user-value)

1. **One-click decide from the notification/inbox is the universal step-collapse we lack.** Slack/Teams/Concur make the message or push terminal — approve/reject in 1 click, 0 navigation [V] slack.com/blog, concur.com/blog, learn.microsoft.com. Ours (appr, leave, finance, comms) always requires navigate-to-surface → open-panel → decide. Fix = actionable inbox rows + push with inline approve/reject (PolicyGated + GovernedObjectCard action already exist). Touches modules 1,3,5,11,12. **Highest cross-module ROI.**

2. **Launch actions FROM the object with context pre-linked, don't re-search.** ApprovalCompose forces a manual typed object-search to link targets even when the user already holds the object (we have objDrag!). Palantir/Concur pre-attach the source object [V] palantir.com/docs/foundry/workshop/actions-use. Collapse: "기안" button on the ObjectCard → approval opens with target pre-linked. Touches 4,8,12,13.

3. **Finance voucher approve doesn't exist yet (blocked-until-backend, visual-verdict 40/fail).** Every peer resolves it in ≤2 clicks (Concur 1-click glance card, NetSuite bulk) [V] concur.com/blog, docs.oracle.com/netsuite. This is the single biggest "money task with 0 usable steps" gap. Wire the voucher domain + projected-type action dispatch.

4. **Projected-type action dispatch = NotWiredYet is the shared root blocking finance, people, and field money tasks.** Our GovernedObjectCard does preflight→execute beautifully for engine types, but WO-/employee/voucher (projected) can't fire their money action. One backend fix (route projected writes through domain use-cases) unblocks 3 modules at once. Ledger already flags it as "THE biggest §18 residual."

5. **No macro/bulk collapse anywhere.** Zendesk 1-click macro (canned reply + N field changes) and NetSuite bulk-approve resolve N-updates-in-1 [V] support.zendesk.com, docs.oracle.com/netsuite. Our support + appr + finance are strictly one-item-at-a-time. Our ontology Action types ARE bundled writebacks — expose them as saved "macro" bundles + batch-select. Touches 3,6,12.

6. **Our leave surface is the pattern to propagate, not fix — co-located personas beat Workday's worklet spread** (self-service + team decide + 촉진 + ledger on ONE screen, inline decide, SoD by omission). Workday reduced clicks but still splits these across worklets [V] hr.osu.edu. Make this the reference grammar for people/support/compliance surfaces.

7. **Add-a-type is 6 manual hand-edits vs Palantir's define-once-propagate-everywhere.** Palantir: create Action Type in Ontology Manager → auto-available in every app [V] palantir.com/docs/foundry/workshop/actions-use. We hand-edit regex/MOD_SCREENS/ko.ts/ONT_TYPES per type. Auto-propagation on publish is Phase C wave 2's acceptance test — it directly determines whether "no-code configurability" is real.

8. **Compliance/evidence audit-time steps should be ≈0 via continuous auto-collection.** ServiceNow GRC pre-collects control evidence continuously so audit day is push-button [V] servicenow.com/docs. Ours is verify-on-demand (N clicks, one per record). Extend the L20 seal worker to scheduled re-verify + package rollup. Touches 7,14.

9. **Canvas authoring is right for branching but overkill for the 80% simple rule (policy + automate).** Zapier collapses simple trigger→action to a linear 2-step form [V] n8n.io/vs/zapier; our block canvas (correctly n8n-class for branching) taxes the simple case ~5 steps. Add a linear "quick rule / quick automation" path beside the canvas. Touches 9,10.

10. **Korean 전자결재 depth is a genuine moat global vendors can't match — protect the semantics, steal the ergonomics.** We model 결재선 preview, 전결/대결, post-finalization reject, SoD/four-eyes, §61 사용촉진, 법인-scope — Workday/Concur have none of these. But Korean groupware (Hiworks/Douzone) still beat us on ergonomics: auto-bound 결재선 by document type + 20+ mobile templates + mobile one-click draft-and-approve [V] hiworks.com/market/approval, daouoffice.com. Keep our governance depth, adopt their template richness + 결재선 auto-binding + mobile one-click. Touches 5,12.
