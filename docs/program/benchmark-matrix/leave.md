# Benchmark Matrix — Module: `leave` (연차/휴가 관리)

Scope: balances · requests · approvals · **사용촉진 (근로기준법 §61) compliance** · 원장(ledger).
Most-relevant vendors for this module: **Rippling, SAP SuccessFactors, Microsoft Teams (Approvals/Shifts)**. Foundry, Slack, Asana, n8n cover the periphery (workflow/automation substrate) and are scored honestly where they touch, N/A'd where they don't.

Rigor legend: **[V]** = verified against a cited source, **[I]** = inferred from the vendor's known product patterns (honest, unproven).

---

## Our console — evidence base (grepped, not assumed)

Read from `web/src/console/leave/{LeaveConsole.tsx,model.ts}`, `backend/app/src/hr.rs`, `docs/program/console-program-ledger.md`.

- **UI surface exists and is deep**: 1-row drillable stat bar (인원/잔여/소진율/촉진대상 — each stat filters the ledger, §4-11 no big-number cards); 내 연차 self-service + 신청 생성 (typed enum reasons `annual/half_am/half_pm/family_event/sick`, half-day = 0.5, calendar-day span count); 팀 결재함 with decide + **SoD (no self-approval)**; 사용촉진 회차 FSM (send→ack→done, round 1|2, single contextual CTA §4.7-6); 인원별 연차 원장. Every object row is an `objDrag` source and opens the 3-layer **ObjectCard** (semantic/kinetic/dynamic) as a right pin.
- **Backend, live**: `GET /api/v1/hr/leave-balances` (read-only, RLS'd, tenant-summary) — real, wired.
- **Backend, built but not wired to UI**: migration `0111_create_hr_leave_workflow` — FSM `DRAFT→SUBMITTED→APPROVED/REJECTED`, `decider≠requester` CHECK (SoD at the DB), typed enums fail-closed, promotion rounds `1|2` + `receipt_status`; 7 REST paths under `hr::router`. Authz reuses branch-scoped `EmployeeDirectoryManage`.
- **PBAC**: `LEAVE_ACTIONS` + `LEAVE_RUNTIME_GATE` (allow-list stub today; Cedar `authorize()` wire-pending, same pattern as AutomatePage).
- **Honest gaps (marked `wire-pending`/`ponytail:` in-code)**: request/decide/촉진 mutations run on **local React state**, not yet POSTing to the FSM endpoints (`POST /ontology/actions/*` is the HANDOFF contract). No automatic accrual engine (balances are imported/summed, not earned by rule). No 근무일/holiday calendar (calendar-day count only). No calendar/timeline view. No mobile leave surface yet. L20 audit `hashVerified` is client-local `false` until history wiring.

Net: **richest domain UI + strongest compliance model on paper (§61 FSM, DB-level SoD), thinnest runtime wiring.** The opposite of the SaaS vendors, who have shallow §61 but fully-wired accrual/payroll.

---

## Capability matrix (rows = dimensions, cells = HOW, 1-3 lines)

### 1. Information architecture / object model
| Vendor | How |
|---|---|
| **Our console** | Ontology objects: 연차 신청(AP-), 연차 원장(JL-), 사용촉진 회차(R-); each opens a 3-layer ObjectCard with typed props + link-types + lifecycle FSM + audit history. Object-first, drag-anywhere. [V] code |
| **Foundry** | No leave module. Generic ontology/object-graph platform; you'd *model* a LeaveRequest object type yourself over integrated HR source data. [I] |
| **Slack** | No object model — a PTO request is a Workflow Builder form + a message in a channel. [V] slack.com PTO template |
| **Teams** | Approvals app = a structured "approval" record; Shifts = a time-off request tied to a schedule. Two disjoint object types, no unified ledger. [V] learn.microsoft.com |
| **Asana** | No leave object. Modeled as tasks in an "Out of Office" project or via 3rd-party (Calamari) integration. [V] forum.asana.com |
| **n8n** | No object model; leave = rows in Google Sheets/Airtable that a workflow reads/writes. [V] n8n.io HR templates |
| **Rippling** | First-class Time Off policy + per-employee balance objects inside a unified employee graph (HR/payroll/IT). [V] rippling.com/blog/leave-management |
| **SAP SF** | Rich EC Time Off model: Time Type, Time Account, Accrual, Absence, holiday calendar, work schedule — deeply typed, deeply configurable. [V] help.sap.com |

### 2. Balance & accrual engine
| Vendor | How |
|---|---|
| **Our console** | Balances read from `leave-balances` (accrued/used/remaining, summed); approve decrements remaining locally. **No rule-based accrual engine yet.** [V] hr.rs / model.ts |
| **Foundry** | N/A as engine; could compute balances as derived object properties/pipelines, but nothing out-of-box. [I] |
| **Slack** | None — balance is a number a human types into the form or tracks in a sheet. [V] |
| **Teams** | None native; Shifts shows availability, not an accrued balance. [I] |
| **Asana** | None native; Calamari add-on carries the balance. [V] |
| **n8n** | "Check against leave balance" = a Sheet lookup node; you build the arithmetic. [V] |
| **Rippling** | Full accrual engine: accrual schedules, upfront grants, unlimited, carryover, tenure tiers; real-time balances feed scheduling + payroll. [V] rippling.com/blog/pto-accrual |
| **SAP SF** | Accrual calendars run automatically; seniority-based averaging (MY/ID/VN), accrual in weeks/days/hours, recalculation options, prorating. Deepest engine here. [V] help.sap.com accruals |

### 3. Request creation / self-service
| Vendor | How |
|---|---|
| **Our console** | 내 연차 panel: typed reason enum, half-day, date range → 신청 (AP-) created; fail-closed validation (invalid range blocked). Currently local-state. [V] LeaveConsole.tsx |
| **Foundry** | N/A (no requester UX). [I] |
| **Slack** | Slash-command/form PTO request from within Slack; low-friction, no balance check. [V] slack.com template |
| **Teams** | Employee submits via Shifts "Time off" request or an Approvals card with dates+reason. [V] support.microsoft.com |
| **Asana** | Create a task in the OOO project / set vacation indicator + return date. [V] asana.com/resources |
| **n8n** | `/leave` Slack command triggers the workflow; n8n is the plumbing, Slack is the form. [V] |
| **Rippling** | Self-service portal: view accrual, upcoming leave, submit — with instant manager notify. [V] |
| **SAP SF** | Employee self-service Time Off tile with holiday/work-schedule-aware day counting. [V] |

### 4. Approval workflow + Separation of Duties
| Vendor | How |
|---|---|
| **Our console** | 팀 결재함 decide; **DB-enforced `decider≠requester` CHECK** + authoritative requester read in-tx (self-approval hole closed). Single-step today; multi-step 전자결재 is the `appr` module. [V] hr.rs, ledger 0112 note |
| **Foundry** | N/A native; could route via Actions but no approval primitive for leave. [I] |
| **Slack** | Single approver via Workflow Builder button/Approvals; no SoD guard, no multi-step chain. [V] |
| **Teams** | Approvals app = auditable single/parallel approval; Power Automate "Start and wait for approval" for multi-stage. No native SoD rule. [V] learn.microsoft.com |
| **Asana** | Task assignee/approval task type; not a real leave-approval control. [I] |
| **n8n** | Arbitrary multi-step routing (IF/Router → manager lookup); you code SoD if you want it. [V] n8n.io |
| **Rippling** | Configurable approval workflows per policy; auto-forward to manager; org-chart-aware routing. [V] |
| **SAP SF** | Workflow config (user-triggered vs admin-triggered), multi-approver chains, dynamic groups/escalation. [V] help.sap.com |

### 5. 사용촉진 compliance (근로기준법 §61) — Korean-specific
| Vendor | How |
|---|---|
| **Our console** | **Only vendor with a first-class §61 primitive**: 사용촉진 회차 object (R-), 1차/2차 FSM (서면촉구 발송 → 수령확인 대기 → 완료), deadline-days, receipt_status. **노무수령거부** is a **built backend §61 round-2 notice flow** (receipt-gated) — `crates/leave/domain/src/lib.rs` `Refusal→"노무수령거부"`, migration `0123_create_leave_promotions`, inbox `0119_create_inbox_docs`, TS client schema — **not yet an engine-registered ontology type** (ledger §194: default catalog 2 of ~30 shipped; 노무수령거부 = same-PR seedable). The term is **not** in the cited FE `model.ts`. [V] `crates/leave/domain`, mig 0123/0119, ledger |
| **Foundry** | N/A — no legal knowledge; you'd model §61 rounds yourself. [I] |
| **Slack** | N/A — no compliance concept. [V] |
| **Teams** | N/A native; DIY via Power Automate + reminders, no §61 semantics. [I] |
| **Asana** | N/A. [I] |
| **n8n** | N/A native; buildable as scheduled reminder + receipt-log workflow, no legal model. [I] |
| **Rippling** | Strong US/global compliance (FMLA, statutory leave) but **§61 사용촉진 서면촉구/수령확인 is not a native Korean primitive** — Korea Payroll/EOR coverage is partial. [I] |
| **SAP SF** | Country-specific accrual rules incl. Asia; but §61 촉진 회차/수령확인 documents are typically **custom BRF/extension work, not shipped**. [I] |

### 6. Permissions / RBAC → PBAC
| Vendor | How |
|---|---|
| **Our console** | Persona lenses (본인/팀장/HR 전담/관리자) via `PolicyGated` over `LEAVE_ACTIONS`, deny-by-omission; Cedar `authorize()` wire-pending. Branch/group-scoped. [V] model.ts |
| **Foundry** | Best-in-class object/row-level security + attribute policies (Markings), but not leave-specific. [I] |
| **Slack** | Channel membership only; no field/action-level authz. [V] |
| **Teams** | Approvals admin + manager role; RBAC coarse, tied to team/schedule ownership. [V] approval-admin |
| **Asana** | Project/team membership; no HR-grade authz. [I] |
| **n8n** | Credential/workflow-level access; no per-record authz. [I] |
| **Rippling** | Granular role-based permissions across HR data; approval scoping by org. [V] |
| **SAP SF** | RBP (Role-Based Permissions) — very granular target-population + field-level. [V] help.sap.com |

### 7. Automation hooks
| Vendor | How |
|---|---|
| **Our console** | Ontology automations/series on object transitions (design); 대근/cover-planner cron in backlog. Not yet firing on leave events. [V] ledger |
| **Foundry** | Actions + functions on object edits; strong but you build it. [I] |
| **Slack** | Workflow Builder triggers (form submit, emoji, schedule). [V] |
| **Teams** | Power Automate: on-approve post to channel, remove from schedule, notify. [V] |
| **Asana** | Rules (Flowsana) shift due dates around PTO/holidays. [V] forum.asana.com |
| **n8n** | **This is the whole product** — richest automation graph; 248 HR automation workflows (community catalog, live count), arbitrary integrations. [V] n8n.io/workflows/categories/hr |
| **Rippling** | "Recipes"/workflow automation (e.g. alert when request exceeds accrued hours); schedule-blocking on approve. [V] rippling.com/recipes |
| **SAP SF** | Business rules + Intelligent Services events on time-off. [I] |

### 8. Calendar / scheduling integration
| Vendor | How |
|---|---|
| **Our console** | No calendar/timeline view yet; no holiday calendar (calendar-day count only). Gap. [V] model.ts ponytail note |
| **Foundry** | N/A. [I] |
| **Slack** | Posts to channel; Google Calendar via workflow, not native. [V] |
| **Teams** | Shifts schedule is the calendar; on approve the employee is marked **unavailable (gray "Off" indicator)** — the assigned shift is **NOT auto-removed** ("This is a designed behavior"); auto-remove / reassign-to-open-shift requires a custom **Power Automate** flow. [V] learn.microsoft.com Q&A |
| **Asana** | Timeline/calendar shows OOO tasks; core competency. [V] |
| **n8n** | Writes to Google Calendar on approve. [V] |
| **Rippling** | Team PTO calendar + schedule-blocking; feeds workforce/shift planning. [V] |
| **SAP SF** | Time-off calendars, team absence calendar, holiday/work-schedule aware. [V] help.sap.com calendars |

### 9. Mobile
| Vendor | How |
|---|---|
| **Our console** | Native field app exists but **no leave surface yet** (mobile leave = backlog). Gap. [V] ledger |
| **Foundry** | Mobile app, not for leave. [I] |
| **Slack** | Full mobile — request/approve in the Slack app. [V] |
| **Teams** | Full mobile — Shifts + Approvals on phone (frontline-worker focus). [V] |
| **Asana** | Mobile app for tasks/OOO. [V] |
| **n8n** | No end-user app (mobile UX = whatever Slack/Teams front-end you wire). [I] |
| **Rippling** | Mobile self-service request/approve/balances. [V] |
| **SAP SF** | Mobile ESS/MSS time-off. [V] |

### 10. Audit / compliance trail
| Vendor | How |
|---|---|
| **Our console** | Every FSM transition = audit event; ObjectCard version history + as-of; L20 tamper-evident chain (hashVerified wire-pending). Strongest design. [V] ledger, model.ts |
| **Foundry** | Full lineage/audit on object edits. [I] |
| **Slack** | Message history only; weak audit. [V] |
| **Teams** | Approvals app touts "auditing, compliance, accountability" — approval record retained. [V] approval-admin |
| **Asana** | Task activity log. [I] |
| **n8n** | Execution logs per run. [V] |
| **Rippling** | HR-grade audit on approvals/changes. [I] |
| **SAP SF** | Audit trail + recalculation history; enterprise-grade. [I] |

### 11. Analytics / reporting
| Vendor | How |
|---|---|
| **Our console** | Drillable stat bar (소진율/촉진대상) = inline analytics; dashboard module for deeper. [V] LeaveConsole.tsx |
| **Foundry** | Best-in-class analytics/quiver over the object graph. [I] |
| **Slack** | None. [V] |
| **Teams** | Minimal (request counts). [I] |
| **Asana** | Dashboards/reporting on OOO tasks. [I] |
| **n8n** | None native (pipe to a BI tool). [I] |
| **Rippling** | Real-time PTO analytics + liability reporting. [V] rippling.com/blog/leave-management |
| **SAP SF** | Time reporting, accrual liability, Stories/People Analytics. [I] |

### 12. Extensibility / no-code type creation
| Vendor | How |
|---|---|
| **Our console** | Directive: a new object type wires itself end-to-end (instances/module/policy/automation/graph/i18n) no-code — richer default HR catalog than Foundry. [V] ledger 2026-07-10 |
| **Foundry** | The gold standard for no-code object-type modeling, but ships **zero** domain types. [I] |
| **Slack** | Workflow Builder = low-code forms only. [V] |
| **Teams** | Power Apps/Power Automate for custom leave apps. [V] teamswork.app |
| **Asana** | Custom fields/templates; app integrations. [I] |
| **n8n** | Infinitely extensible plumbing; no data-model layer. [V] |
| **Rippling** | Configurable policies, custom fields; not open object modeling. [I] |
| **SAP SF** | Deeply configurable (MDF objects, business rules) but consultant-heavy, not no-code. [I] |

### 13. Korean 전자결재 / 법인 scoping fit
| Vendor | How |
|---|---|
| **Our console** | Built for it: 전자결재-style 결재함, group→법인→branch→worksite scoping, §61 native, Korean-first i18n. [V] |
| **Foundry** | Neutral platform; no Korean HR/legal content. [I] |
| **Slack/Teams/Asana/n8n** | Global-generic; **미스매치** — no 전자결재 승인선/전결규정, no 근로기준법, no 법인 scoping; Korean HR teams bolt on 시프티/플렉스 instead. [I] |
| **Rippling** | US-centric; Korea via EOR/partners, weak 전자결재 + §61. [I] |
| **SAP SF** | Localizable to Korea but §61 촉진/전결규정 = custom implementation project. [I] |

---

## Per-vendor: "how they'd build OUR leave module"

**Foundry** — Would model 연차원장/신청/촉진회차 as first-class object types with row-level Markings for 법인 scoping, and drive every transition through Actions + Functions, with lineage-perfect audit. It would *nail* the ontology and security spine — which is exactly the spine we already copied. What it would never ship is the §61 legal content, the accrual math, or a Korean 결재함; Foundry hands you the loom, not the cloth. Our module is essentially "Foundry-for-Korean-HR with the domain types pre-woven."

**Slack** — A PTO Workflow Builder form + an Approvals message, balance tracked in a linked sheet. Fast, delightful, zero compliance. Their version optimizes the 30 seconds of request+approve and ignores accrual, ledger, and §61 entirely. Steal the *friction* (request-in-the-conversation), not the model.

**Microsoft Teams** — Shifts (frontline schedule) + Approvals app + Power Automate glue: submit time-off, **mark the employee unavailable (gray "Off") on approve** (auto-remove / reassign-to-open-shift needs a Power Automate flow), post to channel, retain an auditable approval record. Strong for shift workers and audit-of-approval, but leave "balance/accrual" and §61 live outside it in a custom Power App. Their strength is **schedule-coupling** (approve → unavailable) which our 대근/cover-planner backlog should copy — though the *fully* coupled "approve auto-clears the roster slot" reference is **Rippling**, not Teams.

**Asana** — An "Out of Office" project of tasks on a timeline, vacation indicators, Flowsana rules shifting due dates around PTO. It treats leave as *capacity planning*, not HR compliance — genuinely good at "who's out and how does that move the work," which our workforce/dispatch surface could borrow, but it is not a system of record for balances or §61.

**n8n** — Wouldn't build a UI at all: a graph — Slack `/leave` → balance lookup → manager approval button → update calendar/payroll — with the org-chart→manager mapping in Airtable so routing survives reorgs. Their lesson for us is the **externalized routing table** (approvers as data, not code) — directly relevant to our 승인선/전결규정 automation.

**Rippling** — The closest true peer: policy-driven accrual engine, real-time balances, self-service portal, org-aware approval routing, schedule-blocking on approve, and PTO analytics/liability — all fused with payroll so an approved day flows to pay automatically. Their version is everything our runtime is *not yet*: fully wired accrual→approve→payroll. What they lack is §61 촉진 and 전자결재 승인선. If we wire our FSM to payroll the way Rippling does, plus keep §61, we beat them in Korea.

**SAP SuccessFactors** — The most powerful and most expensive: Time Types, Time Accounts, automatic accrual calendars, seniority tiers, holiday/work-schedule-aware counting, RBP field-level security, multi-step workflows, recalculation. Their version handles every accrual edge case globally — but §61 촉진 회차/수령확인 문서 is a consulting deliverable, and the whole thing needs an implementation team. We copy the **accrual-calendar + work-schedule-aware day counting** concepts without the SI cost.

---

## What we'd steal — ranked (capability → best-in-class → fit with our ontology-first grammar → cost)

1. **Rule-based accrual engine** (accrual schedules, upfront grant, tenure tiers, carryover) → **Rippling / SAP SF** → fits as a `dynamic`-layer derivation on the 연차 원장 object + a nightly accrual series; replaces today's imported-balance stub. This is the single biggest runtime gap. **Cost: L**
2. **Wire the built FSM to the UI** (request/decide/촉진 mutations → `POST /ontology/actions/*` instead of local state) → **Rippling** (their approve→balance→payroll flow is the reference) → pure Phase-C wiring of code we already have; unblocks everything below. **Cost: M**
3. **Work-schedule / holiday-aware day counting** (skip 휴일·비근무일 in the span) → **SAP SF** → a 근무표/holiday-calendar object feeding `requestDays()`; removes the `ponytail:` calendar-day approximation. **Cost: M**
4. **Schedule-coupling on approve** (approved leave → unavailable in dispatch/대근 planning) → **Rippling** (fully coupled — approve clears the roster slot; Teams only marks unavailable, auto-remove needs Power Automate) → an automation on the APPROVED transition writing to the workforce/cover-planner surface; leverages the 대근 cron already in backlog. **Cost: M**
5. **Externalized approval-routing table** (승인선/전결규정 as data, org-chart-aware, survives reorgs) → **n8n / Rippling** → model 전결규정 as an ontology instance type the `appr` engine reads; no hard-coded approver. **Cost: M**
6. **Request-in-the-conversation** (submit/approve from the CommsRail/messenger, not just the module) → **Slack / Teams** → an Approvals-style card in our messenger bound to the same FSM action; low friction, high adoption. **Cost: S**
7. **PTO liability / burn analytics + team absence calendar** → **Rippling / SAP SF** → extends the existing drillable stat bar with a liability rollup + a timeline view (the missing calendar surface). **Cost: M**
8. **Mobile self-service leave** (request/approve/balance on the native field app) → **Rippling / Teams** → add a leave tab to the pending mobile app against the same REST. **Cost: M**

**What we already beat everyone on (defend, don't steal):** native 사용촉진 §61 회차 FSM + 수령확인, DB-level SoD (`decider≠requester`), the 3-layer ObjectCard/audit spine, and group→법인→branch PBAC scoping. No global vendor ships these; keep them as the Korean-B2B moat.

---

Sources: [Rippling leave management](https://www.rippling.com/blog/leave-management), [Rippling PTO accrual](https://www.rippling.com/blog/pto-accrual), [Rippling PTO-exceeds-accrued recipe](https://www.rippling.com/recipes/pto-request-exceeds-accrued-hours-alert), [SAP SF Time Off config guide](https://help.sap.com/docs/successfactors-employee-central/time-off-and-leave-of-absence-configuration-guide-getting-started/accruals-based-on-recorded-times), [SAP handling leave absences](https://learning.sap.com/courses/sap-successfactors-time-management-academy/handling-leave-absences), [Teams Approvals admin](https://learn.microsoft.com/en-us/microsoftteams/approval-admin), [Teams manage time off in Shifts](https://support.microsoft.com/en-us/office/manage-shift-requests-and-time-off-in-shifts-231fc82f-db7f-4f06-9215-8b36b599d69c), [Asana OOO/time-off](https://forum.asana.com/t/holiday-leave-block-off-time-either-as-pto-holiday-or-all-day-task/20302), [Asana + Calamari](https://asana.com/apps/calamari), [n8n HR workflows](https://n8n.io/workflows/categories/hr/), [Slack PTO request template](https://slack.com/templates/time-off-request-process). Our-console claims: `web/src/console/leave/{LeaveConsole.tsx,model.ts}`, `backend/app/src/hr.rs`, `docs/program/console-program-ledger.md`.

---

## Cross-cutting lens findings (5 independent review lenses)

- **Task-flow:** **our most collapsed surface — best-in-class.** One `LeaveConsole.tsx` holds all four personas: self-submit = 1 screen / ~4 inputs / 1 submit; team-decide = **1 click** inline (SoD: own request shows no buttons); 촉진 round = one contextual CTA per state. Workday reduced its own click count but still SPREADS self-service / approve / 촉진 across separate worklets. **Steal: almost nothing — PROPAGATE this co-located-personas pattern to people/support/compliance.** Only gap: leave mutations are state-only (unwired). Cost **S** (wire the REST that already exists).
- **IA / layout:** `LeaveConsole` is real; **Korean context is decisive** — 근로기준법 mandates 연차 accrual, 대체공휴일, 반차/반반차; leave **must** flow through the 전자결재 결재선. **Steal:** team **calendar-grid** leave board (who's out) → Korean HR SaaS [M]; 잔여 연차 counter tied to 근로기준법 accrual [M]; leave-request → 결재선 handoff (reuse `appr`) [S].
- **Data-model:** real audited FSM with **SoD (decider≠requester CHECK)** + 촉진 promotion rounds typed to 근로기준법 — a Korean edge Workday Absence doesn't ship. **Weaker:** Workday models accrual balances as **effective-dated derived quantities**; ours is request-centric with no effective-dated balance object (no as-of on a balance). **Steal:** Workday effective-dated accrual/balance object [M]; carryover/expiry as effective-dated slices [S].
- **Governance:** **Ahead** — 연차촉진 (statutory §61) is a construct none of Workday/ServiceNow/SAP model natively. **Steal:** 수령확인 as a **reusable governed acknowledgment object-type** (the *flow* already exists via inbox `0119` + leave R-; the reusable object-type abstraction is the deferred piece) [S]; promotion-round SLA/escalation (auto-escalate un-actioned round) [M].
- **Automation / extensibility:** we have effective-dating + actions; missing HR-event triggers. **Steal:** HR-event lifecycle triggers (on-approve-leave → balance decrement / 연차촉진 round) [S–M]; 연차촉진 round scheduler + 촉진 통보 notification effect [M]; org-scope routing modifiers [M].

**Adjudicated contradictions:** (1) **Teams Shifts does NOT auto-remove from schedule on approve** — its own cited MS source says the employee is marked unavailable (gray "Off"); auto-remove needs Power Automate. The fully-coupled "approve clears the roster slot" reference is **Rippling**, not Teams (Row 8, per-vendor, and Steal #4 corrected above). (2) **노무수령거부** is a **built backend §61 flow** (`crates/leave/domain`, migrations `0123`/`0119`), **not** an engine-registered ontology type, and is **not** in the FE `model.ts` the draft cited (Row 5 corrected).
