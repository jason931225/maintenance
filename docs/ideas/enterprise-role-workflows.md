# Enterprise Role Workflows, Policy, Ontology, and Daily Work UX

Date: 2026-06-28

## Problem Statement

How might we make KNL a full enterprise operations system where every employee lands on the right daily work queue, every manager can shape roles/policies/workflows without developer involvement, and every action remains object-centric, audited, policy-governed, and simple enough for real field operations?

## Benchmark anchors

Official/live sources used for the benchmark direction:

- SAP Fiori elements List Report/Object Page: <https://ui5.sap.com/test-resources/sap/fe/core/fpmExplorer/overview/introduction.html>
- SAP Fiori sample apps with list/object visual references: <https://ui5.sap.com/test-resources/sap/fe/core/fpmExplorer/index.html>
- SAP My Inbox workflow guide with screenshots: <https://learning.sap.com/courses/sap-workflow-overview-basics-strategy-and-extensibility/installing-and-setting-up-the-my-inbox-app>
- SAP Task Center public guide: <https://help.sap.com/doc/ab1cc29fb9aa41889779ce4f699142cd/Cloud/en-US/TaskCenter_PUBLIC_EN_1.pdf>
- ServiceNow My To-dos: <https://www.servicenow.com/docs/r/employee-service-management/employee-experience-foundation/use-the-my-to-dos-page.html>
- ServiceNow task filters: <https://www.servicenow.com/docs/r/employee-service-management/employee-experience-foundation/configurable-filters-experience.html>
- ServiceNow workspace approvals: <https://www.servicenow.com/docs/r/australia/servicenow-platform/platform-user-interface/view-and-approve-records-in-service-operations-workspace.html>
- ServiceNow approval hub reference: <https://www.servicenow.com/docs/r/yokohama/employee-service-management/employee-experience-foundation/approval-hub-ootb.html>
- Palantir Foundry Ontology overview: <https://palantir.com/docs/foundry/ontology/overview/>
- Palantir Action Types: <https://palantir.com/docs/foundry/actions/action-types/>
- Palantir Object Explorer getting started/results: <https://palantir.com/docs/foundry/object-explorer/getting-started/>, <https://palantir.com/docs/foundry/object-explorer/results-view/>
- Palantir Workshop: <https://palantir.com/docs/foundry/workshop/overview/>
- NIST RBAC: <https://csrc.nist.gov/projects/role-based-access-control>
- NIST ABAC SP 800-162: <https://csrc.nist.gov/pubs/sp/800/162/final>
- IBM Maximo Application Suite: <https://www.ibm.com/products/maximo>
- Microsoft Dynamics 365 Asset Management work orders: <https://learn.microsoft.com/en-us/dynamics365/supply-chain/asset-management/work-orders/introduction-to-work-orders>
- Microsoft Dynamics 365 asset/work-order object model: <https://learn.microsoft.com/en-us/dynamics365/supply-chain/asset-management/overview/objects-and-work-orders>
- ServiceNow Field Service Management: <https://www.servicenow.com/docs/r/field-service-management/fsm-application-landing-page.html>
- ServiceNow Dispatcher Workspace configuration: <https://www.servicenow.com/docs/r/field-service-management/configuring-dispatcher-workspace.html>

## First principles

1. **The landing page is the product promise; the console home is the daily truth.** Public landing explains the operating system. Sign-in, sign-up, and onboarding should immediately collect legal consent, role/org context, and setup prerequisites, then send the user to their work queue.
2. **The default screen is not a generic dashboard.** It is a role-aware work queue: today, this week, blocked, due soon, delegated, completed, and awaiting approval.
3. **Every operation is an ontology object + workflow action + policy decision.** UI buttons are not enough. Each action needs object type, state transition, policy reason, actor, timestamp, evidence, and audit trail.
4. **Policy is configurable business logic, not static code.** System defaults are only a safe baseline. Tenant/group admins with permission must be able to configure job functions, permission bundles, ABAC conditions, responsibility assignments, approval thresholds, and workflow guards through audited UI.
5. **No-code workflow is how the business stays malleable.** Workflow Studio should define states, forms, SLAs, approvals, notification rules, passkey step-up, and audit requirements without code deploys.
6. **Legal/sensitive work must be purpose-bound.** HR, payroll, GPS/location, wage/overtime, retirement, and signing-equivalent actions require purpose tags, minimization, retention, masking, passkey step-up, and audit according to Korean privacy/labor/location requirements.
7. **Operational history is training data for the business.** 기안, 구매, 승인, 입찰, pricing, planning, dispatch, maintenance, HR, payroll, and asset decisions must leave structured event history that can improve future recommendations, templates, thresholds, pricing, reserves, staffing, and risk models.
8. **AI comes last, not first.** Artificial intelligence, machine learning, reinforcement learning, and LLMs can later help executive decision making, operational intelligence, analytics, workflow drafting, and scenario explanation only after mechanical workflows, deterministic/probabilistic algorithms, observability, policy, and audit are mature.

## Recommended Direction

Build a **Work Operating System** with four visible layers:

1. **Work Hub** — daily/weekly queue for the current user, with source provenance and open-only actionable items.
2. **Object Explorer** — list-report to object-page pattern for employees, assets, inventory, clients, sites, work orders, tickets, mail, calendar, approvals, payroll receipts, and any tenant-defined item type.
3. **Workflow Studio** — no-code state machines, forms, approvals, SLAs, notifications, passkey step-up, employment-transition hooks, and audit routing for each object/action type.
4. **Policy Studio** — configurable job functions, permission bundles, responsibility assignments, RBAC/PBAC/ABAC rules, effective-access preview, and assignment guardrails.

The current product should converge on a queue-first, object-centric SAP/ServiceNow/Palantir style: list/filter/search/saved view -> object detail -> related facts/history/actions -> policy-backed workflow action. Avoid separate cosmetic screens that duplicate the same object; use separate tabs only for materially different jobs.

## B2B / industrial OS UX doctrine

Best-in-class industrial SaaS does **not** look like a collection of unrelated admin pages. It uses a small number of repeatable enterprise patterns that make high-volume operational work fast, safe, and auditable:

1. **Role/scoped workspace, not global navigation first.** The default workspace is determined by subject attributes: job function, position, department/team, responsibility assignment, group/org/site scope, and current shift/context. Users should not hunt through all modules to find their day.
2. **Queue -> object -> action.** Work starts in a queue/list/report, drills into an object page, and actions live beside facts/history/policy. SAP Fiori List Report/Object Page, SAP Task Center, ServiceNow My To-dos, and Palantir Object Explorer all reinforce this pattern.
3. **Exception-first dashboards.** Managers and executives should see risk, overdue work, blockers, SLA/capacity/cost exceptions, and approvals before vanity charts. Dashboards are for decisions; detailed work happens on object pages.
4. **Configurable work surfaces.** Dispatch, field service, and industrial operations need default filters, task-card fields, contextual side panels, work-order state colors, and saved views per role/team/site. ServiceNow Dispatcher Workspace explicitly treats this as configuration, not hardcoded page chrome.
5. **Operational object model.** Assets, work orders, tasks, resources, skills, locations, calendars, inventory, documents, costs, and lifecycle states are linked objects. Dynamics 365 and ServiceNow both model work orders around assets/jobs/resources/locations, not isolated forms.
6. **Action validity is visible.** Actions are shown only when valid for the object state and user policy. Disabled actions should explain the missing policy/state/evidence, not silently fail.
7. **Dense but readable.** Industrial users need high-density tables, task cards, maps/schedules, and side panels, but with accessible focus, clear hierarchy, KST timestamps, Korean-first labels, and no raw UUIDs.
8. **Mobile/kiosk parity for critical flows.** Field operators, maintenance crew, line workers, and approval users need narrow-layout task completion, alerts, passkey step-up, evidence capture, and offline/low-connectivity tolerance where applicable.
9. **No fake integration.** Mail, calendar, polls, messenger, workflow, analytics, and optimization must attach to real objects and policies. If a backend capability is not live, the UI must not advertise it as an actionable feature.
10. **Admin UX is a product, not a database editor.** Policy Studio, Workflow Studio, Ontology Studio, import/export mapping, and org graph tools require preview/diff/test/audit affordances before saving.
11. **Workflow history is reusable intelligence.** A purchase request, bid, draft approval, price exception, overtime approval, equipment sale/acquisition decision, or dispatch plan is not “done” when approved. It becomes an analyzable object with inputs, alternatives, approvers, timing, vendor/customer/asset context, price/cost/quality result, and later outcome.
12. **UI maturity is the expansion gate.** Once Work Hub, Object Explorer, workflow/approval action rail,
policy explanation, scenario workbench, and dense object tables are polished and verified, feature
expansion should reuse those patterns. New one-off screen shapes are a smell unless a documented user
story truly demands them.

### Industrial workspace archetypes

| Archetype | Primary visual pattern | Must include | Must avoid |
| --- | --- | --- | --- |
| Field/maintenance worker | Mobile task list + object detail + evidence capture | Today/next job, site/equipment facts, safety checklist, parts, photos, start/complete/report actions | Manager dashboards, raw policy controls, hidden required evidence |
| Dispatcher/logistics office | Board/list/map/schedule split workspace | Unassigned/late work, technician capacity/skills, location, SLA, task-card fields, contextual side panel | Separate map/list/forms that lose selection context |
| Production line | Kiosk/mobile shift queue + line/station object page | Shift tasks, quality checks, material shortages, incident report, supervisor escalation | Logistics-specific modules unless assigned |
| Manager/supervisor | Exception queue + team workload + approval center | SLA/capacity/cost blockers, pending approvals, delegated work, policy explanations | Vanity charts without actionable drilldown |
| HR/payroll/finance | Secure case/work queue + document/mail/object rail | Sensitive masking, purpose tag, retention, passkey step-up, approval and receipt issuance | Showing sensitive employee/payroll data through generic queues |
| Executive/group admin | Group/org command center + subsidiary switch + saved views | Group-wide and per-subsidiary mode, risk/financial/asset/workforce summaries, major approvals | Blending platform ops with tenant-private reads without policy |
| Platform admin | Tenant health/security/log console | Tenant lifecycle, group grants, audit/log metadata, rollout health, object-storage/mail config | Default access to tenant-private content |

### UX review questions for every screen

- Who is this screen for by job function, position, department/team, responsibility, and scope?
- What is the primary queue or object the user is trying to act on?
- Does the screen preserve context from list to detail to action?
- Are terminal/closed items excluded from action inboxes unless the user explicitly views history?
- Does every action show policy/state/evidence requirements and audit consequences?
- Are filters/saved views powerful enough for high-volume B2B operations?
- Does the screen work in the density and device class the role actually uses?
- Is any visible feature a stub, future promise, or unsupported backend capability? If yes, remove or label as unavailable.
- Can a manager/admin configure the surface safely through policy/workflow/ontology controls instead of asking a developer?

## Role model correction

The current fixed tenant roles (`MEMBER`, `RECEPTIONIST`, `MECHANIC`, `ADMIN`, `EXECUTIVE`, `SUPER_ADMIN`) are only bootstrap roles. They are not rich enough for production enterprise operations.

Target identity/policy dimensions:

| Dimension | Examples | Used for |
| --- | --- | --- |
| Job family / function | 정비, 배차, 생산, HR, Payroll, Finance, Purchasing, Sales, Platform Ops | Default capability bundle and work-hub template. |
| Position / level | 사원, 대리, 과장, 부장, 임원, 대표 | Approval thresholds, signing authority, escalation, sensitive data visibility. |
| Department / team | 정비팀, 배차팀, 생산라인 A, 재무팀, 인사팀, HQ | Queue scope, reporting line, team calendar/mail/polls, workload rollups. |
| Responsibility assignment | Site owner, equipment owner, line supervisor, purchase approver, payroll processor, group admin | Object-specific authority independent of title. |
| Scope | Platform, group, subsidiary/org, department, site, branch, object, self | What rows/objects are visible and mutable. |
| Employment/person state | Employee, contractor, pending setup, leave, retired, suspended | Login eligibility, HR/payroll flow, data retention, inactive-user behavior. |
| Environment/context | Shift, time, location consent, device/passkey freshness, emergency mode | ABAC conditions, step-up auth, mobile-only or location-gated actions. |
| Object state | Open, blocked, pending approval, completed, closed, archived | Which workflow actions appear and which terminal items leave the action inbox. |

Policy decision shape:

```text
allow? = policy(subject attributes, object attributes, action, environment)

subject = person + account + job function + position + department/team + responsibilities + scopes
object = ontology object type/id + owning org/group/site/team + sensitivity class + lifecycle state
action = read/create/update/approve/sign/export/import/delegate/archive
environment = time/shift/device/passkey freshness/location consent/network/risk
```

This means “role” in the UI should eventually read as **job function + responsibility + policy scope**, not a single checkbox. A dispatcher, logistics office manager, site owner, and group admin may all be “managers” in everyday speech, but they must receive different effective capabilities because their responsibilities, departments, scopes, and object relationships differ.

Minimum UX implication: user/account management must show an **effective access preview** that explains which job function, team/department, position, responsibility, and scope produced the capability. If the current screen only has legacy role/team/branch fields, it must say so plainly and point to the Policy Studio gap rather than pretending that checkboxes are the final model.

### Configurable policy lifecycle

Policy must be data-driven and versioned:

1. **Draft** — manager edits policy bundles, ABAC conditions, approval thresholds, or responsibility rules.
2. **Preview** — UI shows affected people, capabilities gained/lost, workflows impacted, lockout/escalation risks, and example decisions.
3. **Test** — run policy simulation against representative users/objects/actions before activation.
4. **Approve** — sensitive policy changes route through workflow and passkey step-up where required.
5. **Activate** — publish a versioned policy bundle; all decisions log policy version and reason.
6. **Rollback/retire** — revert or retire policy safely; retain audit trail and historical decision lineage.

Static hardcoded role checks are acceptable only as a temporary bootstrap guard or compatibility fallback. Product behavior should converge on server-resolved effective policy so UI, backend, mobile, imports, workflow, and audit all agree.

### Employment transition handling

Employment status changes are first-class workflows, not ad hoc account edits:

| Transition | Required system behavior | Policy/workflow requirements |
| --- | --- | --- |
| Candidate/pre-hire -> pending setup | Create employee/person record without claiming active account. | No app access except onboarding; collect required agreements when login begins. |
| Pending setup -> active | Passkey/OTP setup completed; required privacy/terms accepted; org/team/scope assigned. | Mark active only after credential setup and minimum policy assignment. |
| Transfer between department/team/site/org | Preserve employment history; change queue scope, managers, calendars, mail groups, asset responsibilities. | Effective-access diff, future-dated activation, manager approval if responsibility changes. |
| Promotion/demotion/title change | Update position/authority without overwriting job history. | Approval thresholds and signing authority recompute from policy version. |
| Leave/absence/suspension | Temporarily remove or reduce login/action rights while preserving employment record. | Delegation/backup assignments; payroll/HR visibility remains limited to authorized specialists. |
| Contractor/vendor conversion | Change employment class and retention/legal basis. | Review privacy/contract terms, access scope, expiry date, and object responsibilities. |
| Termination/retirement | Disable login, revoke sessions/passkeys as policy requires, preserve legally required records. | Handoff open work, revoke responsibilities, retain wage/labor/retirement records by law, avoid showing as active user. |
| Rehire/reactivation | Reactivate person history without duplicating identity. | New agreements/passkeys if required; previous access does not automatically return. |

The UI must distinguish **person/employee status** from **account credential status** from **policy assignment status**. “Active” cannot mean merely “row exists.” A user who has not completed signup/passkey setup is pending; a retired user is not active but their legally required HR/payroll history remains.

For intra-group moves between separate legal employers, default to **same person identity + sending-org
separation episode + receiving-org new-hire episode**. If the employee voluntarily leaves one group
company and starts at another, preserve the prior company's employment, wage, retirement/severance,
and audit records; compute/record final settlement or counsel-approved continuity; revoke old active
responsibilities; and activate only the new org's scopes from the start date. Do not duplicate the
person or expose sending-org sensitive payroll/retirement data to the receiving org unless policy and
legal basis allow it.

## Workflow memory and analytics loop

Operational workflow should be a closed learning loop:

```text
draft/request/proposal -> review/approval -> execution -> outcome -> analytics -> next recommendation/template/policy
```

Required event shape for operational workflows:

| Data captured | Examples | Future use |
| --- | --- | --- |
| Intent and object context | 기안 목적, purchase request, bid, asset, customer/site, department, SLA | Suggest correct workflow, approvers, required evidence, and comparable past cases. |
| Alternatives considered | Vendor quotes, rental price options, repair vs replace, reserve parts options | Benchmark bids/pricing and explain decision tradeoffs. |
| Decision path | Approvers, memos, policy version, passkey step-up, delegation, rejected revisions | Improve approval thresholds, detect bottlenecks, prove audit lineage. |
| Financial/operational inputs | Cost, budget, expected downtime, utilization, market value, inventory level, labor capacity | Forecast pricing, reserve policy, workforce planning, asset lifecycle timing. |
| Outcome and variance | Final cost, delivery time, SLA hit/miss, asset performance, vendor quality, customer response | Compare expected vs actual and improve future recommendations. |
| Sensitive/legal classification | HR/payroll/location/privacy flags, retention, masking, legal basis | Keep analytics privacy-safe and permissioned. |

This applies to at least:

- **기안 / internal proposals** — templates should suggest approvers, required evidence, risk flags, and comparable prior proposals.
- **구매 / procurement** — prior quotes, lead times, vendor quality, budgets, and approval outcomes should inform future purchase recommendations and bid evaluation.
- **승인 / approvals** — approval latency, rejection reasons, memo patterns, and policy exceptions should tune workflow paths and SLA escalation.
- **입찰 / bids** — historical bid win/loss, pricing, scope, vendor/customer behavior, and delivery outcomes should inform bid strategy.
- **Pricing / rental rates** — historical utilization, downtime, SLA penalties, seasonality, asset market value, and customer/site segment should feed recommendations.
- **Planning / dispatch / workforce** — past plans, actual completion, travel/geofence data where consented, overtime, and skill match should improve future scheduling.
- **Asset lifecycle** — repair cost, downtime, utilization, resale value, replacement availability, and customer revenue should support sell/keep/acquire recommendations.

Non-negotiable boundary: recommendations are **drafts**, not decisions. They must show source history, assumptions, confidence/uncertainty, comparable cases, sensitivity class, and the workflow/policy path needed to approve any write-back.

## Role-by-role daily workflow map

| Persona | Default landing after sign-in | Daily queue priorities | Core object pages | Approvals/workflow needs | Policy/UX quirks |
| --- | --- | --- | --- | --- | --- |
| Public visitor at `knllogistic.com` | Product landing with industry modules, trust/legal links, sign in/sign up | N/A | Solution, pricing/contact, privacy/cookie | Contact/sales intake only | Public copy must not promise unimplemented console features. |
| New tenant/org signer | Sign-up -> consent -> passkey -> org/group bootstrap -> onboarding checklist | Create group/org, invite admins, import employees/assets/sites | Group, tenant, org, users, imports | Legal agreements, privacy/cookie, service terms | Must distinguish platform account vs group admin vs org member. |
| New employee | OTP/passkey setup -> mandatory consent -> role-specific first-run checklist | Complete profile, passkey, device/location consent if required | Profile, passkeys, assigned org/team | Policy acceptance, optional GPS consent | Pending users are not “active” until setup is complete. |
| Equipment operator | Work Hub mobile/phone-first | Today’s assigned equipment/tasks, safety checks, incidents, handoffs | Equipment, shift/task, incident, calendar | Safety incident report, overtime/exception, acknowledgement | Minimal UI, large tap targets, offline-friendly, no manager-only noise. |
| Equipment maintenance crew | Work Hub + dispatch | Assigned work orders, preventive maintenance, evidence capture, parts needed | Work order, equipment, parts/inventory, site, messenger thread | Completion report, target date change, parts request | 담당 정비사 fields only to mechanics; photo/evidence gates completion. |
| Logistics office worker | Work Hub + dispatch board | Intake, dispatch changes, customer/site issues, support tickets | Work order, customer/site, messenger/mail, calendar | Dispatch handoff, customer escalation, target change request | Needs fast search, dropdown-first customer/site/model fields with add-new. |
| Logistics office manager | Manager Work Hub + approval center | Team queue, late/SLA risk, approvals, staffing, escalations | Dispatch, approvals, work orders, KPI | Approve completion, schedule changes, overtime, purchase/parts | Group/subsidiary scope depends on group/admin policy. |
| Production line worker | Mobile/kiosk Work Hub | Shift tasks, line checks, quality incidents, inventory consumption | Work task, line/station, inventory item, incident | Quality hold, overtime, absence/leave | Should not see logistics/maintenance modules unless assigned. |
| Production line supervisor | Supervisor queue | Line status, staffing gaps, quality holds, material shortages | Line, shift, workers, inventory, quality incident | Approve shift changes, quality disposition, replenishment | Needs real-time board and escalation path. |
| Production office worker | Work Hub + office ops | Purchase requests, inventory admin, vendor docs, HR/service tickets | Purchase request, inventory, vendor, mail | Purchase/receipt/document workflows | Requires mail/calendar/poll integration but object-linked, not standalone clutter. |
| Production office manager | Manager queue + analytics | Department work, approvals, capacity, quality/cost exceptions | KPI, workflow, approvals, inventory/assets | Purchase approval, policy exceptions, staffing | Needs saved views by line/department/company. |
| HQ office worker | Personal Work Hub | Assigned back-office tasks, mail, calendar, HR/payroll docs, approvals requested | Employee self-service, mail, calendar, documents | Leave, overtime, expenses, payroll receipt acknowledgements | Most users see only their own dashboard by default. |
| HQ office manager | Manager Work Hub + Policy/Workflow where permitted | Department queue, HR/payroll/process approvals, role assignments | Employees, roles, workflow, approvals, reports | Leave/overtime/payroll approvals, policy changes | Sensitive fields masked unless explicit domain permission. |
| HQ executive | Executive Work Hub | Cross-org exceptions, KPIs, risk, major approvals, optimization recommendations | Group view, org graph, KPI, assets, costs, recommendations | High-value purchase/sale, policy, budget, risk exceptions | Needs group-wide and subsidiary-specific view modes. |
| HR/payroll specialist | HR/Payroll Work Hub | Employee lifecycle, wage statements, benefit records, retirement/interim settlement dates | Employee, payroll receipt, labor record, retirement record | Leave/overtime/payroll receipt issuance, sensitive corrections | High-sensitivity domain: purpose tags, masking, passkey step-up, retention. |
| Finance/purchasing | Finance queue | Purchase requests, vendor invoices, cost ledger, asset acquisition/sale | Purchase, vendor, cost ledger, asset lifecycle | Multi-step purchase, approval thresholds, invoice receipt | Segregation of duties; self-approval restrictions. |
| Platform admin | Platform console | Tenant health, security, audit, logs, rollout, mail config, object storage | Tenant, group, account, audit/logs | Tenant setup, group admin grants, account recovery | Platform access must not imply tenant-private data read unless policy allows. |
| Group admin | Group Work Hub | Subsidiary queues, group-wide approvals, policy/workflow templates | Group, subsidiary orgs, users, approvals, org graph | Manage subsidiary context with audit | Can manage subsidiaries independent of their home tenant association. |

## Capability matrix to build toward

| Layer | Required capability | Best-in-class benchmark signal | Acceptance bar |
| --- | --- | --- | --- |
| Landing | Product narrative, role/industry modules, privacy/cookie/legal links, sign-in/up | SAP product pages + enterprise trust pattern | No unsupported promises; Korean-first; legal links visible; copyright/semver footer. |
| Sign in/up | Passkey-first login, OTP recovery, consent gates, onboarding state | Modern identity + enterprise onboarding | Pending setup users clearly separated from active users. |
| Work Hub | Open-only central queue, due/urgency filters, saved views, source provenance | SAP Task Center, ServiceNow My To-dos | Closed/completed items do not appear in action inbox. |
| Object Explorer | Search/browse -> object detail, related facts/history/actions | SAP List Report/Object Page, Palantir Object Explorer | Equipment, employees, sites, inventory, tickets, approvals use list-first drilldown. |
| Ontology Studio | Tenant-defined item types, fields, validation, relationships, lifecycle | Palantir Ontology | Users can create item types without creating unsafe permissions. |
| Workflow Studio | State machines, forms, SLAs, approvals, notifications, passkey step-up | SAP/ServiceNow workflow | Workflow changes are versioned, audited, and policy-gated. |
| Policy Studio | Configurable job functions, positions, departments/teams, responsibilities, PBAC bundles, ABAC rules, effective access preview/versioning/simulation | NIST RBAC/ABAC | No role-string auth; server policy envelope backs every UI action; policy is editable through audited UI, not code deploys. |
| Collaboration | Messenger, mail, calendar, polls, object threads | Slack/Microsoft/ServiceNow workspaces | Messages/mail/calendar events attach to objects and respect retention/policy. |
| Assets/inventory | Equipment + parts + office/manufacturing inventory + lifecycle | SAP EAM/Maximo style object lifecycle | One asset list leads to manage/detail; optimization only after data is trustworthy. |
| Analytics/optimization | Recommendations, scenarios, assumptions, approvals | Palantir ontology/actions + enterprise analytics | Recommendations never write back without policy/workflow approval. |
| Workflow intelligence | Durable 기안/구매/승인/입찰/pricing/planning history feeding future recommendations | SAP/ServiceNow workflow history + Palantir ontology/actions | Every workflow captures outcome/variance and can be queried for future planning without exposing sensitive data. |
| AI/ML/RL/LLM augmentation | Forecasting, offline optimization, evidence summaries, executive decision briefs | Modern decision-intelligence systems layered on governed data | Last-stage only: requires trusted ledgers, deterministic calculators, observability, evaluation, privacy review, and workflow-only write-back. |

## Idea variations considered

1. **Queue-first OS** — everyone starts in a work queue; modules are secondary. Highest immediate value.
2. **Object-first OS** — everyone starts in Object Explorer; tasks are filters over objects. Strong foundation, slower to feel useful.
3. **Workflow-first OS** — admins configure workflows first; users follow generated screens. Powerful, but risky before object/policy foundations mature.
4. **Role-pack marketplace** — templates for logistics, maintenance, production, HR, finance. Useful later; dangerous if templates hide policy gaps.
5. **Analytics-first OS** — executive optimization and recommendations lead the product. Not now; requires trusted operational data first.
6. **Mobile-first employee shell** — phone app drives attendance, approvals, alerts, mail, calendar, polls. Necessary, but should share ontology/workflow contracts with web.
7. **AI-first OS** — use LLM/ML/RL to shortcut operations maturity. Rejected for now: it would hide missing
   master data, weak policy, weak observability, and missing outcome history. Keep it as the final
   augmentation layer after the mechanical system works.

## Convergence decision

Start with **Queue-first OS + Object Explorer**, then layer Workflow Studio and Policy Studio. This gives immediate daily value while establishing the ontology/policy seams needed for long-term SAP/Palantir-level maturity.

## Key assumptions to validate

- [ ] Users will adopt a queue-first landing if it removes daily confusion and shows only valid actions.
- [ ] Managers can safely change policy through draft/preview/test/approve/activate/rollback without code changes.
- [ ] Employment transitions recompute access, queues, responsibilities, and credential state without losing legally required history.
- [ ] Intra-group inter-org moves preserve one person identity while creating legally separate employment episodes, final settlement/continuity records, and active-scope handoff.
- [ ] Workflow admins can maintain state machines safely if every workflow action is versioned, testable, reversible, and analytics-ready.
- [ ] Past workflow outcomes improve future 기안, 구매, 승인, 입찰, pricing, planning, and asset/workforce recommendations without bypassing policy.
- [ ] AI/ML/RL/LLM can eventually assist only after deterministic calculators, model/eval registry,
      observability, privacy gates, and workflow-only write-back exist.
- [ ] UI/UX is mature enough for feature expansion when role-story paths reuse Work Hub, Object Explorer,
      policy/workflow action rails, and scenario patterns without introducing unreviewed one-off pages.
- [ ] Field users need a narrower mobile/kiosk UX than office users; forcing the full console on them will fail.
- [ ] Group admins need both “view together” and “manage subsidiary” modes; conflating them creates audit/policy confusion.

## MVP Scope

P0 slices that are worth building before broad ERP/HR/payroll/analytics expansion:

1. Work Hub remains the default authenticated landing and filters terminal/closed items out of the action inbox.
2. Group Admin can move from a group/subsidiary list into work hub, org management, approvals, and daily plan under an audited management context.
3. Equipment management becomes list-first: browse the full equipment list, pick an object, then manage it; admin-only bulk tools are separate.
4. User management shows a policy preview before role/scope saves, explicitly identifying the current fixed-role limitation; the real configurable job-function/position/responsibility policy implementation follows the RBAC/PBAC/ABAC spec before arbitrary role grants ship.
5. Employment status, credential status, and policy assignment status are separate in UX, API, imports, and audit.
6. A living benchmark matrix records role workflows, object types, workflow requirements, and policy requirements so tickets that weaken maturity can be rejected.
7. Workflow objects store structured decision inputs/outcomes so analytics and future recommendations can use them without scraping notes.
8. Establish the UI/UX maturity gate: every new feature must fit the shared queue/list/detail/action/policy/scenario patterns or document the exception.

## Not Doing (and why)

- Fake full mail/calendar/poll clients — would create dead product promises without backend policy, retention, and object-linking.
- Fake Workflow Studio — no-code workflow must be executable, versioned, and audited, not a cosmetic diagram builder.
- Fake Ontology Studio — tenant-defined item types need schema validation, import/export, policy, lifecycle, and relationship support.
- Static policy as final product — hardcoded checks cannot support tenant-specific departments, positions, responsibilities, and employment transitions.
- Analytics write-back — optimization recommendations require trusted ledgers, utilization, market-value, SLA, and approval lineage first.
- AI/ML/RL/LLM write-back — future AI output is draft assistance only until mechanical algorithms,
  observability, evaluation, privacy/security review, and governed workflow write-back are live.
- Disposable one-off workflow forms — every operational workflow must produce durable, queryable, permissioned event history.
- One-size-fits-all navigation — logistics, production, HQ, HR/payroll, and platform users need role-aware defaults.

## Open Questions

- Which production/manufacturing roles are required for the first paid tenant, and which can remain templates?
- What legal counsel-approved text/version is the source of truth for consent, privacy, cookies, and labor/location disclosures?
- Which workflow actions require immediate passkey step-up vs ordinary session auth?
- Which object types need import/export mapping first: employees, org graph, equipment/assets, sites/customers, inventory, or payroll/HR records?
