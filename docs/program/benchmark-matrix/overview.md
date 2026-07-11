# Benchmark Matrix — Module: `overview` (Operations Overview / Work Hub)

Scope: the landing surface a signed-in operator hits first — stat strip, unified work queue,
agenda, and comms rail. Compared against Palantir Foundry, Slack, Microsoft Teams, Asana, n8n,
Rippling, and SAP (S/4HANA Fiori + SuccessFactors). Most-relevant vendors for this module:
**Slack / Teams** (home & activity triage), **Asana** (My Tasks / Inbox / Home widgets),
**Rippling** (unified home), **Foundry** (Workshop workspace). n8n and SAP are covered but weaker
fits (noted per row).

Rigor: every vendor claim is `[V]` VERIFIED (source URL) or `[I]` INFERRED (reasoned from known
product patterns). Our own column is grounded in the actual code state (grep'd, not aspirational).

---

## 0. Our console — evidence-based baseline (what actually exists today)

Read from `web/src/console/` on `feat/cedar-activation` (2026-07-11):

- **`dashboard/DashboardScreen.tsx`** — the built overview content. A **PBAC-relative scope × period**
  header (scope segments = only the KPI rollups the caller is authorized for; six typed month
  segments, current month marked 진행 / closed months 확정 — no raw date input). A **one-row stat
  strip** of 7 KPI stats (completed count, response speed, completion duration + due compliance,
  revisit rate, delay rate, inspection-plan completion, P1 acceptance) **+ 4 ops alerts**
  (`sla_breached`, `sla_at_risk`, `pending_approvals`, `open_support`, red tone when > 0). **Every
  stat is authored as a drill `<Link>`** to its source screen (e.g. `/dispatch?status=COMPLETED`,
  `/approvals`, `/support`, `/dispatch?priority=P1`). ⚠️ **Known wiring gap** (ia-layout lens,
  code-confirmed): those drills are react-router paths that resolve in the legacy `KpiPage` mount, but
  the target console is `state.screen`-driven — they must be rewired to the shell model, so
  "drill-everything" is the *intent*, not yet a clean law. Two **honest-scale** `HonestBar` charts
  (completion by scope, delay-reason distribution). Sections with no backing API are **omitted, not
  placeholdered** (a hard house rule).
- **`shell/ConsoleShell.tsx`** — new 3-column shell: **sidebar · main · comms-rail**. Foundry-style
  grouped nav (개요 · 인사 · 급여·근태 · ERP · 현장운영 · 거버넌스 · 분석 · 자동화 · 커뮤니케이션).
  Quick-actions **ShellDock** + single **TrayDock**, `WindowManagerProvider`. **Honest partial state:**
  the main body currently renders an *empty themed canvas* per active screen (P0.1); the comms rail is
  a **collapsed 54px glyph strip** (msg / mail / notif) — the interactive rail is P2, so no unwired
  handlers.
- **`shell/nav.ts`** — the 개요 group is `overview · mywork (내 작업 inbox) · inbox (mailbox)`.
  `mywork`/`inbox` are **nav entries whose screens are wire-pending**; the built dashboard is reached
  via the legacy `KpiPage` route today. Nav is **deny-by-omission** on Cedar/PBAC grants; backend
  re-authorizes every call.
- Program ledger (`docs/program/console-program-ledger.md`): visual-verdict has `overview` at 74
  (revise), and `dashboard` was rebuilt 35 → real-API in `fe-fix-wave1`. No-AI / deterministic;
  tamper-evident audit chain under everything; scoping is Group → 법인 → branch → worksite.

**Net:** the *executive KPI hub* is real and strong (authorized scope, drill-everything, no fake
tiles). The *personal work hub* (unified My-Tasks/To-Do queue, agenda, activity feed, live comms
rail) is **chartered but not yet wired** — exactly where the vendors below are strongest.

---

## 1. Capability matrix

Columns: **Us** = our console. **Fnd** = Foundry. **Slk** = Slack. **Tms** = Teams. **Asa** = Asana.
**n8n**. **Rip** = Rippling. **SAP** = S/4HANA Fiori + SuccessFactors.

### Row 1 — Information architecture (the landing surface)
- **Us:** 3-column shell (sidebar · KPI/ops main · comms rail); overview = scope×period + stat strip +
  honest charts. Personal work-hub panes wire-pending. `[code: ConsoleShell.tsx, DashboardScreen.tsx]`
- **Fnd:** Workshop module = module-header + pages + sections + widgets; a "homepage" is just another
  Workshop app you build, no fixed home. `[V]` [layouts](https://www.palantir.com/docs/foundry/workshop/concepts-layouts)
- **Slk:** Left rail + Home (channels/DMs) and a dedicated **Activity view** as the triage surface.
  `[V]` [Activity view](https://slack.com/help/articles/19693583638803-Get-your-work-done-from-the-Activity-view)
- **Tms:** App bar with **Activity** as first stop (feed of everything across Teams). `[V]`
  [Activity feed](https://support.microsoft.com/en-us/office/explore-the-activity-feed-in-microsoft-teams-91c635a1-644a-4c60-9c98-233db3e13a56)
- **Asa:** Dedicated **Home** = customizable widget canvas + **My Tasks** + **Inbox** as three distinct
  surfaces. `[V]` [Home](https://asana.com/features/project-management/home)
- **n8n:** **Overview** page = the home base (workflow/project list + global Executions tab); the 5 ops
  metrics live on the separate **Insights** dashboard, not the Overview landing page. `[V]`
  [insights](https://docs.n8n.io/insights/)
- **Rip:** Single unified home with People/Payroll/Benefits/IT/Finance menus + an attention panel.
  `[V]` [platform](https://www.rippling.com/platform)
- **SAP:** **Fiori Launchpad** = spaces/pages of tiles; **My Home** (S/4HANA 2023 FPS01+); SuccessFactors
  **redesigned Home Page** (2H 2025). `[V]` [My Home](https://community.sap.com/t5/technology-blog-posts-by-sap/sap-fiori-for-sap-s-4hana-empowering-your-homepage-enabling-my-home-for-sap/ba-p/13672904)

### Row 2 — Unified work queue / personal task inbox ("my tasks / to-dos")
- **Us:** `mywork` (내 작업) nav slot exists; **screen not yet wired**. Ops alerts partially proxy it
  (pending approvals, open support drill to lists). Gap vs vendors. `[code: nav.ts]`
- **Fnd:** No native "my tasks" — you build an object-set widget filtered to `assignee = me` over an
  ontology task type; Automate can route. `[I]` (pattern from Workshop object-set widgets + Automate)
- **Slk:** Not a task manager, but **Later / saved items** + reminders act as a personal follow-up
  queue; threads/mentions filters. `[V]` [reminders](https://slack.com/help/articles/208423427-Set-a-reminder)
- **Tms:** No first-class task queue in Activity; tasks live in the Planner/Tasks app, not the hub.
  `[I]` (Activity is notifications, not assignments)
- **Asa:** **My Tasks** is the flagship — Today/Upcoming/Later sections, list/board/calendar views,
  auto-promotion by due date. Best-in-class. `[V]` [My Tasks](https://asana.com/features/project-management/my-tasks)
- **n8n:** N/A as a human task queue — its "queue" is workflow **executions** (Failed/Running/Success/
  Waiting), a machine work log, not assignments. `[V]` [executions](https://docs.n8n.io/workflows/executions/all-executions/)
- **Rip:** **Task inbox** surfaces pending approvals, onboarding tasks, and compliance deadlines to act
  on. `[V]` [platform](https://www.rippling.com/platform)
- **SAP:** **My Inbox 2.0** = unified work-item queue across all workflow providers (All-Items tile or
  scenario-filtered tiles); **Task Center** consolidates cross-system. `[V]` [My Inbox](https://community.sap.com/t5/technology-blog-posts-by-sap/sap-fiori-for-sap-s-4hana-fiori-my-inbox-part-1-activation/ba-p/13326175)

### Row 3 — Approvals surfacing (전자결재 / 결재함)
- **Us:** `pending_approvals` ops-alert stat drills to `/approvals`; approvals module (`appr/`) exists
  separately. First-class Korean 결재 surfacing on the hub itself is thin. `[code: DashboardScreen.tsx]`
- **Fnd:** Approvals modeled as ontology Actions + Automate; a Workshop widget can list pending. `[I]`
- **Slk:** Approvals via **Workflow Builder** / approval apps posting to a channel or DM, not a native
  hub queue. `[I]`
- **Tms:** Native **Approvals** app + adaptive-card approvals inline in Activity/chat. `[I]`
- **Asa:** Task **Approvals** (approve/request-changes/reject status) surface in My Tasks & Inbox. `[V]`
  [My Tasks](https://asana.com/features/project-management/my-tasks)
- **n8n:** N/A — no human approval inbox (can send an approval webhook step, but no console). `[I]`
- **Rip:** Pending **approvals** are a headline item on the home attention panel & task inbox. `[V]`
  [platform](https://www.rippling.com/platform)
- **SAP:** **My Inbox** IS the approval engine — multi-step workflow approvals, delegation, mass
  actions; the gold standard for 전자결재-style flows. `[V]` [My Inbox](https://community.sap.com/t5/enterprise-resource-planning-blog-posts-by-sap/sap-fiori-for-sap-s-4hana-replacing-sap-fiori-apps-during-system-conversion/ba-p/14260897)

### Row 4 — Activity / notification feed & triage
- **Us:** Comms rail exposes msg/mail/notif glyphs but the **interactive feed is P2** (not built).
  No unified activity stream yet. `[code: ConsoleShell.tsx]`
- **Fnd:** Notifications from Action side-effects + Automate effects; no consumer-grade unified feed —
  you compose one. `[I]` / `[V]` effects [Automate](https://www.palantir.com/docs/foundry/automate/effect-actions)
- **Slk:** **Activity view** with tabs Unreads / DMs / Mentions / Threads / Reactions (all but "All
  notifications" and "DMs" now hidden by default behind the Filters control) + custom filters; clear-all
  triage. Best-in-class triage UX. `[V]` [Activity](https://slack.com/help/articles/19693583638803)
- **Tms:** **Activity feed** = all @mentions/replies/likes/meeting events, 30-day retention, filter
  pills for @mention & unread, keyword filter (via the Filter control). `[V]` [feed](https://support.microsoft.com/en-us/office/explore-the-activity-feed-in-microsoft-teams-91c635a1-644a-4c60-9c98-233db3e13a56)
- **Asa:** **Inbox** = per-task activity/notifications, archive/snooze, filterable. `[V]`
  [Home](https://asana.com/features/project-management/home)
- **n8n:** Execution log is the "feed" — failures/runs, filterable by status; machine events only. `[V]`
  [executions](https://docs.n8n.io/build/understand-workflows/understand-executions/view-all-executions)
- **Rip:** Attention panel aggregates changes needing action; not a chat-style feed. `[I]`
- **SAP:** **Needs Attention** section (SuccessFactors 2H 2025) groups all attention cards with
  type filters; notification bell in Launchpad. `[V]` [2H 2025 home](https://community.sap.com/t5/human-capital-management-blog-posts-by-sap/sap-successfactors-hcm-updated-home-page-2h-2025/ba-p/14269975)

### Row 5 — Stat strip / at-a-glance KPI tiles
- **Us:** Strong — one compact scrollable stat row; 7 KPIs + 4 ops alerts; tabular-nums, danger tone,
  every tile drills. Honest-scale charts below. `[code: DashboardScreen.tsx]`
- **Fnd:** Metric-card / KPI widgets in Workshop bound to object-set aggregations; fully composable. `[V]`
  [widgets](https://www.palantir.com/docs/foundry/workshop/concepts-widgets)
- **Slk:** N/A — no KPI tiles; not an analytics surface. `[I]`
- **Tms:** N/A natively (Power BI tab can embed, but not the hub). `[I]`
- **Asa:** **Dashboard widgets** (charts, number widgets, completion stats) on Home & project
  dashboards. `[V]` [dashboard widgets](https://help.asana.com/s/article/text-widgets-in-dashboards?language=en_US)
- **n8n:** 5 fixed metrics (Prod. executions, Failed, Failure rate, Time saved, Avg runtime) — on the
  **Insights** dashboard, not the Overview landing page. `[V]` [insights](https://docs.n8n.io/insights/)
- **Rip:** Attention counts (approvals, deadlines, onboarding) but not analytical KPI tiles on home. `[I]`
- **SAP:** **KPI / dynamic-count tiles** on the Launchpad (live count on the tile face) — the original
  drill-from-tile pattern. `[V]` [Launchpad](https://help.sap.com/docs/SAP_S4HANA_ON-PREMISE/22bbe89ef68b4d0e98d05f0d56a7f6c8/753af2c410584bc98f0363ca69a404f1.html)

### Row 6 — Agenda / today / calendar view
- **Us:** None on the hub yet (no agenda pane). Gap. `[code: — no agenda component]`
- **Fnd:** Build a calendar/Gantt-style widget over a date property; no native agenda. `[I]`
- **Slk:** Reminders + calendar-app unfurls; no agenda pane per se. `[I]`
- **Tms:** Calendar app + meeting notifications in Activity (2024+); not on a home pane. `[V]`
  [feed calendar](https://office365itpros.com/2024/05/29/teams-activity-feed-changes/)
- **Asa:** **My Tasks calendar/week view** + Home "upcoming tasks" widget = de-facto agenda. `[V]`
  [My Tasks](https://asana.com/features/project-management/my-tasks)
- **n8n:** N/A (schedule triggers exist, but no human agenda). `[I]`
- **Rip:** Upcoming compliance deadlines / onboarding timelines surfaced; not a calendar. `[I]`
- **SAP:** SuccessFactors home cards can show upcoming (e.g. time-off, reviews); Fiori has a Calendar
  app but not a home agenda. `[I]`

### Row 7 — Comms rail / embedded messaging
- **Us:** Dedicated rail column reserved (msg/mail/notif); auditable in-app chat exists as a module
  (`messenger/`); rail interactivity = P2. Architecturally first-class, not yet live. `[code: ConsoleShell.tsx, messenger/]`
- **Fnd:** N/A — no built-in chat; comms happen in the object/notification layer, not a rail. `[I]`
- **Slk:** IS the comms product — DMs/threads/huddles are the whole app. `[V]`
  [threads](https://slack.com/help/articles/115000769927-Use-threads-to-organize-discussions)
- **Tms:** IS the comms product — chat/channels/calls with the app in one shell. `[V]`
  [activity/chat](https://support.microsoft.com/en-us/office/explore-the-activity-feed-in-microsoft-teams-91c635a1-644a-4c60-9c98-233db3e13a56)
- **Asa:** Task comments + project messages; no persistent side chat rail. `[I]`
- **n8n:** N/A (Chat beta = AI assistant, not team comms). `[V]` [insights](https://docs.n8n.io/insights/)
- **Rip:** No native team chat rail. `[I]`
- **SAP:** No native persistent chat rail (SAP Jam retired; relies on Teams integration). `[I]`

### Row 8 — Drill-down navigation (stat → source records)
- **Us:** every stat/alert is *authored* as a deep-link with query params to the filtered source screen;
  chart bars drill too. ⚠️ Caveat (ia-layout lens, code-confirmed): the `to:` targets are react-router
  paths (`/dispatch`,`/approvals`,`/ops`) that resolve in the legacy `KpiPage` mount and must be rewired
  to the `state.screen` shell — a real wiring gap, not yet a "no dead numbers" law. `[code: DashboardScreen.tsx kpiStats/opsStats `to:`]`
- **Fnd:** Widget events → navigate/filter; object-set drill into Object Explorer search-around. `[V]`
  [events](https://www.palantir.com/docs/foundry/workshop/concepts-events)
- **Slk:** Activity item → jump to message-in-channel. `[V]` [Activity](https://slack.com/help/articles/19693583638803-Get-your-work-done-from-the-Activity-view)
- **Tms:** Activity item → open the source message/meeting. `[V]` [feed](https://support.microsoft.com/en-us/office/explore-the-activity-feed-in-microsoft-teams-91c635a1-644a-4c60-9c98-233db3e13a56)
- **Asa:** Home widget / My-Task row → open the task; number widgets link to filtered lists. `[V]`
  [Home](https://asana.com/features/project-management/home)
- **n8n:** Metric → filtered Executions list → single run detail. `[V]` [executions](https://docs.n8n.io/workflows/executions/all-executions/)
- **Rip:** Task inbox item → the action screen. `[V]` [platform](https://www.rippling.com/platform)
- **SAP:** **Dynamic tile → filtered list → object page** — the canonical drill chain. `[V]`
  [Launchpad](https://help.sap.com/docs/SAP_S4HANA_ON-PREMISE/22bbe89ef68b4d0e98d05f0d56a7f6c8/753af2c410584bc98f0363ca69a404f1.html)

### Row 9 — Personalization / configurable widgets
- **Us:** No end-user home personalization yet; layout is fixed code. Config-as-governed-object is the
  charter (dashboard widget slots) but not on the overview surface. `[code: — fixed layout]`
- **Fnd:** Fully config-as-data (widgets + typed variables + events); but that's *builder-time*, not
  end-user drag. `[V]` [variables](https://www.palantir.com/docs/foundry/workshop/concepts-variables)
- **Slk:** Sidebar sections + Activity filters are the personalization; layout is fixed. `[V]`
  [Activity](https://slack.com/help/articles/46751260742035-Introducing-the-new-Activity-view-in-Slack)
- **Tms:** Pin/reorder apps in app bar; filter Activity; layout fixed. `[V]` [manage notifications](https://support.microsoft.com/en-us/office/manage-notifications-in-microsoft-teams-1cc31834-5fe5-412b-8edb-43fecc78413d)
- **Asa:** **Best for end-users** — drag/drop/resize Home widgets, background styles, add/remove widget
  types, private notepad. `[V]` [customize Home](https://help.asana.com/s/article/how-to-customize-your-home-page)
- **n8n:** Home metrics are fixed; no widget personalization. `[I]`
- **Rip:** Role-shaped home; limited end-user layout control. `[I]`
- **SAP:** **Admin + end-user home configuration** — spaces/pages, role-based launchpad params
  (/UI2/FLP_PROF_CONF new in 2025), SF card config & user personalization. `[V]`
  [what's new 2025](https://avotechs.com/blog/sap-fiori-for-s4hana-2025-release/)

### Row 10 — Permissions / scoping (who sees which stats & items)
- **Us:** **Deny-by-omission** nav + **PBAC-relative scope segments** (only the KPI rollups Cedar
  authorizes render); backend re-authorizes every call; group→법인→branch→worksite scoping. Strongest
  in class for *hub-level* authz. `[code: nav.ts, DashboardScreen scopeChipLabel]`
- **Fnd:** Object/property policies (row + cell-level), mandatory markings; a stat computed over an
  object-set inherits them. Deepest data-level model. `[V]`
  [object policies](https://www.palantir.com/docs/foundry/object-permissioning/object-and-property-policies)
- **Slk:** Channel membership + workspace/org roles; DLP/enterprise controls. Coarse vs data-cell. `[I]`
- **Tms:** Team/channel roles, sensitivity labels; feed shows only what you can access. `[I]`
- **Asa:** Project/team membership + admin roles; My Tasks is inherently self-scoped. `[I]`
- **n8n:** Project/RBAC (enterprise) scopes visible workflows/executions. `[V]`
  [view-all-executions](https://docs.n8n.io/build/understand-workflows/understand-executions/view-all-executions)
- **Rip:** Granular role/permission graph across HR/IT/Fin; home reflects entitlements. `[I]`
- **SAP:** Business-role → launchpad space/page/tile assignment; workflow-provider authorization on My
  Inbox items. Mature but role-catalog-heavy. `[V]` [My Inbox activation](https://community.sap.com/t5/technology-blog-posts-by-sap/sap-fiori-for-sap-s-4hana-fiori-my-inbox-part-1-activation/ba-p/13326175)

### Row 11 — Automation hooks (surfacing automated conditions on the hub)
- **Us:** Ops alerts (SLA breach/at-risk) are the automation-surfaced signals; broader Automate→home
  wiring is charter, not built. `[code: opsStats]`
- **Fnd:** **Automate**: Condition(s)→Effect(s) continuous/scheduled monitors feed notifications/cards.
  Deepest. `[V]` [Automate](https://www.palantir.com/docs/foundry/automate/overview)
- **Slk:** Workflow Builder can post scheduled/triggered items into channels/Activity. `[I]`
- **Tms:** Power Automate cards land in Activity/chat. `[I]`
- **Asa:** **Rules** trigger task moves/assignments that surface in My Tasks/Inbox. `[V]`
  [rules & widgets](https://help.asana.com/s/article/rules-integrations-and-widgets?language=en_US)
- **n8n:** IS the automation engine — Insights metrics ARE automation output. `[V]`
  [insights](https://docs.n8n.io/insights/)
- **Rip:** **If-then Workflow Studio** drives tasks onto the home attention panel. `[V]`
  [workflows](https://www.rippling.com/platform/workflows)
- **SAP:** Workflow engine routes items to My Inbox; SF business rules drive home cards. `[V]`
  [My Inbox](https://community.sap.com/t5/enterprise-resource-planning-blog-posts-by-sap/sap-fiori-for-sap-s-4hana-replacing-sap-fiori-apps-during-system-conversion/ba-p/14260897)

### Row 12 — Mobile
- **Us:** Native field app exists (Android `com.maintenance.field`); console overview is web-responsive;
  no dedicated overview mobile widget. `[memory: native-app-identifiers]`
- **Fnd:** Workshop **mobile** modules + app launcher + mobile nav-bar widget. `[V]`
  [mobile](https://www.palantir.com/docs/foundry/workshop/mobile-overview)
- **Slk:** Full native apps; Activity/reminders parity. `[V]` [Activity](https://slack.com/help/articles/19693583638803-Get-your-work-done-from-the-Activity-view)
- **Tms:** Full native apps; Activity feed parity. `[I]`
- **Asa:** Native apps + **home-screen widgets** (top-5 today on iOS, task lists on Android). `[V]`
  [widgets](https://asana.com/inside-asana/widgets)
- **n8n:** Web-only, not mobile-optimized. `[I]`
- **Rip:** Native employee app with tasks/self-service. `[I]`
- **SAP:** Fiori is responsive; SAP Mobile Start app aggregates tiles/notifications. `[I]`

### Row 13 — Audit / compliance
- **Us:** **Tamper-evident append-only audit chain** under every mutation; deterministic (no AI);
  drill targets are audited screens. Strongest compliance posture. `[memory: audit-chain-status]`
- **Fnd:** Ontology changelog + Action writeback lineage; full history. `[V]`
  [proposals/changelog](https://www.palantir.com/docs/foundry/ontologies/ontologies-proposals)
- **Slk:** Enterprise audit logs API + eDiscovery/DLP (Enterprise Grid). `[I]`
- **Tms:** Purview audit/compliance, retention labels. `[I]`
- **Asa:** Admin audit-log API (Enterprise+). `[I]`
- **n8n:** Execution history is the audit trail; enterprise log streaming. `[V]`
  [executions](https://docs.n8n.io/workflows/executions/all-executions/)
- **Rip:** HR/payroll compliance + audit trails on changes. `[I]`
- **SAP:** Workflow item history, change docs, GRC; deep regulated-industry audit. `[I]`

### Row 14 — Extensibility (custom cards/widgets on the hub)
- **Us:** Charts/StatusChip are shared primitives; adding a hub card = code today (config-as-data
  charter pending). `[code: charts/, components/]`
- **Fnd:** **Custom (iframe) widgets** read/write Workshop variables via a documented bridge. `[V]`
  [embed apps](https://www.palantir.com/docs/foundry/workshop/widgets-embed-foundry-apps)
- **Slk:** App home tab + Block Kit; apps post to Activity. `[I]`
- **Tms:** Custom apps/tabs, adaptive cards in Activity. `[I]`
- **Asa:** App widgets on dashboards via the developer Widgets API. `[V]`
  [widgets API](https://developers.asana.com/reference/widgets)
- **n8n:** Community nodes extend workflows, not the home UI. `[I]`
- **Rip:** App Shop / custom apps; limited home-surface extensibility. `[I]`
- **SAP:** Custom tiles/cards on Launchpad & SF home (KBA 2641544). `[V]`
  [custom SF tile](https://userapps.support.sap.com/sap/support/knowledge/en/2641544)

### Row 15 — Korean B2B fit (전자결재 culture, 근로기준법, group-company scoping)
- **Us:** **Purpose-built** — Korean-first copy, 진행/확정 period grammar, group→법인→branch→worksite
  scope, 결재/approvals surfacing, and 근로기준법-aware modules (leave/att/pay). Native fit. `[code]`
- **Fnd:** Locale-agnostic; you build 전자결재 as Actions/Automate — flexible but from scratch. `[I]`
- **Slk/Tms:** Localized UI, but 전자결재 is a bolt-on app; no native multi-법인 org scoping in the hub. `[I]`
- **Asa:** Localized; no 전자결재 semantics; flat workspace model mismatches group-company hierarchy. `[I]`
- **n8n:** N/A for HR/approval culture. `[I]`
- **Rip:** US-payroll-centric; Korean 근로기준법/4대보험 payroll not a native strength. `[I]`
- **SAP:** Closest global fit — multi-company-code, delegation, localized payroll; but heavy, and My
  Inbox ≠ Korean 결재선/전결 규정 out of the box. `[I]`

---

## 2. How each vendor would build OUR overview module

**Palantir Foundry.** A Workshop module with a header + one page; sections holding metric-card widgets
bound to object-set aggregations over a `WorkOrder`/`Approval` ontology type, each with an event that
navigates to a filtered Object Explorer view. The "work queue" = an object-table widget filtered to
`assignee = currentUser`; the "alerts" = Automate monitors (Condition→Effect) writing notification
cards. No fixed home — the home *is* config-as-data, versioned like the ontology. Our stat-drill and
authorized-scope patterns already echo this; Foundry would push us to make the whole surface a
declarative document, not TSX. `[V]` widgets/events/automate cited above.

**Slack.** Overview = an **Activity view**: Unreads / Mentions / Reactions / Approvals(app) tabs with
filter pills and clear-all triage, plus a Home with pinned channels per worksite. Work items arrive as
Workflow-Builder messages with interactive approve buttons; "later" = saved items. Slack would nail the
*triage ergonomics* (fast filter, keyboard, snooze) but treat KPIs and structured queues as second-class
— they'd live in embedded apps, not native tiles. `[V]` Activity/reminders cited.

**Microsoft Teams.** A pinned **Activity feed** as the hub: filter pills for @mention/unread, calendar
+ approval adaptive-cards inline, 30-day retention. The work queue is delegated to the Tasks/Planner
app; approvals to the Approvals app. Teams would deliver a strong notification-triage home but a
fragmented task story (many apps, one feed). `[V]` feed/filters cited.

**Asana.** The most complete personal work hub: a customizable **Home** (drag/resize widgets: My
Priorities, upcoming, completion stats, notepad) + **My Tasks** (Today/Upcoming/Later, list/board/
calendar) + **Inbox** (per-item activity, snooze/archive). Rules auto-route tasks; number widgets drill
to filtered lists. Asana would give us the best *end-user personalization and agenda*, but no KPI-grade
authorized rollups or 전자결재/audit-chain rigor. `[V]` Home/My Tasks/widgets cited.

**n8n.** An **Overview** page of fixed operational metrics (executions, failure rate, time saved) + a
global execution log filterable by status, drilling to a single run. It would model our "work" as
*automation runs*, not human assignments — excellent for the SLA/monitor half of our ops alerts, a
non-fit for the human work queue / approvals / comms half. `[V]` overview/executions cited.

**Rippling.** A unified **home + task inbox**: an attention panel of pending approvals, compliance
deadlines, and onboarding tasks, driven by an if-then Workflow Studio, with entitlement-shaped
visibility across HR/IT/Finance. Closest to our "one operational hub across domains" thesis; Rippling
would push cross-domain task unification hard, but its home is HR-ops-shaped and US-payroll-centric.
`[V]` platform/workflows/inbox cited.

**SAP (S/4HANA + SuccessFactors).** A **Fiori Launchpad** of role-assigned spaces/pages with dynamic
KPI-count tiles drilling tile→list→object, plus **My Inbox 2.0 / Task Center** as the unified,
delegation-capable approval queue, and a SuccessFactors **"Needs Attention" / "For You Today"** home
with configurable cards. SAP would deliver the deepest approval-workflow + role-catalog machinery and
the original drill-from-tile pattern — at the cost of weight and a role-catalog burden, and My Inbox
still isn't Korean 결재선/전결 규정 natively. `[V]` My Inbox/Launchpad/2H-2025 home cited.

---

## 3. What we'd steal (ranked, actionable)

Fit rated against our **ontology-first, Cedar-PBAC, deterministic, audited, Korean-B2B** grammar. Cost
S/M/L.

1. **Unified personal work queue (My Tasks / To-Do) → best: Asana; enterprise proof: SAP My Inbox.**
   Wire the empty `mywork` slot into a real cross-module queue (approvals + assigned WOs + support +
   inspections) with Today/Upcoming/Later sections. Fit: excellent — it's an authorized object-set over
   our ontology; each row is already a drill target. This is our single biggest gap vs every vendor.
   **Cost: M.**

2. **Activity/triage view with filter pills → best: Slack; enterprise: SAP "Needs Attention".**
   Build the P2 comms-rail feed as a real triage surface: Unreads / Mentions / Approvals / Reminders
   pills, snooze, clear-all, deep-link to source. Fit: strong — our audit chain makes "who cleared what
   when" free. **Cost: M.**

3. **Dynamic KPI tile → filtered-list → object drill chain → best: SAP Fiori; also Foundry.**
   We already do stat→screen drilling; formalize it as a reusable *tile primitive* with a live count on
   the face and a governed target query, so every module gets it. Fit: native — extends our stat strip.
   **Cost: S.**

4. **End-user home personalization (drag/resize widgets) → best: Asana; governed: SAP.**
   Let operators arrange overview widgets, backed by our config-as-governed-object charter (draft→
   approve→effective, per-persona defaults). Fit: good, but must stay inside the governed-config model,
   not free-form localStorage. **Cost: L.**

5. **Approval delegation + escalation semantics → best: SAP My Inbox.**
   Add delegation (위임) and escalation to the approvals surfaced on the hub — the piece 전자결재 culture
   actually needs (전결/대결/부재중 위임). Fit: strong and locally required; global vendors miss the
   Korean 결재선 semantics, so we build it, informed by SAP's model. **Cost: M.**

6. **Automate-style Condition→Effect monitors feeding the hub → best: Foundry; ops-proof: n8n.**
   Generalize our two SLA ops-alerts into declarative monitors that any ontology type can raise onto the
   overview + comms feed. Fit: native to the ontology/Cedar substrate; deterministic (no AI) keeps it in
   bounds. **Cost: M.**

7. **Home-screen mobile widget (top-N today) → best: Asana.**
   A small overview widget for the native field app (top open WOs / pending approvals). Fit: good, low
   priority vs the web hub gaps. **Cost: S.**

**Deliberately NOT stealing:** Teams' one-feed-many-apps fragmentation (we want one authorized hub, not
N bolt-on apps); n8n's runs-as-work model for humans (our queue is assignments, not executions); any
AI-driven "smart" surfacing (deterministic house rule). Asana's flat workspace and Rippling's
US-payroll shape both mismatch our group→법인→branch→worksite + 근로기준법 reality — steal the UX, not
the org model.

---

## 4. Cross-cutting lens findings (5 independent review lenses)

Five reviewers each swept all 14 modules through one lens (evidence read from `web/src/console/**` + the program ledger). Their `overview`-specific findings:

- **Task-flow (money-task step count):** money task = *triage my inbox → act*. Ours today = **2–3 steps** (inbox row → open ObjectCard pin → act inside the card); the row is **not yet an actionable card** (no inline approve on the row). Slack/Teams make the notification itself terminal — **0 navigation, 1 click** (approve/reject render inline). **Steal:** actionable inbox rows (top action rendered inline, PolicyGated) collapses 3 → 1; the `PolicyGated` + `GovernedObjectCard` action layer already exists. Cost **M**. This is the highest cross-module ROI item (touches overview/comms/appr/leave/finance).
- **IA / layout:** the landing is **thin** — `overview`/`mywork`/`inbox` nav slots with no rich landing component, `badges = {}` hard-coded (**zero live counts anywhere**). Korean 전자결재 culture wants **결재 대기함 as the hero of home** (다우오피스 makes 상신/수신함 the landing) — our `mywork` instinct is right but unbuilt. **Steal:** live nav/tile counts → Fiori (`NavBadge` type exists, unwired) [S]; Actions\|Views landing grammar → Workday [M]; 결재 대기함 hero card [S].
- **Data-model / object-semantics:** the landing *projects* other objects; its config (`console_view`) is **engine-registered TODAY** as a governed ontology instance (draft→approve→effective + rollback + as-of) — **stronger than Foundry Home**, which is configured but not itself a first-class versioned business object with four-eyes. **Weaker:** Foundry ships live object-set widgets out of the box; ours needs the widget→ontQuery binding finished.
- **Governance:** **Behind on governance-posture summary, Ahead on enforcement.** We render only the permitted subset (deny-by-omission) but never *summarize the governance system itself*. **Steal:** a governance-posture strip (pending four-eyes · active legal holds · Cedar denials 24h · overdue lifecycle reviews) → Vanta/Drata — trivially an ontQuery widget over `gov_approvals`/holds/`cedar_decision_log`. Cost **S**, high-visibility.
- **Automation / extensibility:** dashboard/overview extensibility = **alert-as-trigger** + **drill-to-action**. **Steal:** alert-rule trigger (metric crosses threshold → run workflow) → Grafana; drill-to-action from a stat (click → governed ontology Action on the underlying set) → Foundry/Retool; scheduled digest effect (needs a notification effect first).

**Adjudicated contradiction:** the flagship "every stat is a `<Link>` that drills" strength is **overstated** — code-confirmed by the ia-layout lens (finding #6): the drills are react-router paths that resolve only in the legacy `KpiPage` mount, not the `state.screen` console shell, so they dead-end until rewired. The §0 and Row 8 caveats above reflect the lens's (correct) adjudication.
