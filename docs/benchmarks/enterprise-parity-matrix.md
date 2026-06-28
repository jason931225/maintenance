# Enterprise parity and weakness matrix

Date reviewed: 2026-06-28

Scope: current web console/public/mobile-adjacent product surface in `web/src/AppRouter.tsx`, with follow-up backlog for console, mobile apps, backend ontology/workflow, and imports.
Primary issue: [#55 Enterprise collaboration suite](https://github.com/jason931225/maintenance/issues/55).

## Quality gates for every future slice

Every proposed feature, capability, UI, or UX change must pass these gates before implementation:

1. **Pain point first** — name the role/persona, current friction, business risk, and expected outcome.
2. **Integrated workflow** — connect the action to its source object, owner, due/SLA, policy, evidence, message/mail/ticket, audit log, and analytics context where relevant.
3. **Group-wide by default** — action inbox, workflow, people, policy, and analytics are enterprise/group operations surfaces. Maintenance/logistics is one domain, not the product frame.
4. **Self-explanatory UI** — no operational screen should rely on a wall of non-functional explanatory copy. Use structure, status, visual priority, labels, counters, filters, and next-action affordances.
5. **Ergonomic and visually prioritized** — urgent, blocked, due, sensitive, and assigned-to-me work must be obvious; secondary context must not compete with primary actions.
6. **Story-aware** — validate through concrete daily/weekly stories for employee, manager, executive, platform admin, group admin, HR/payroll, finance/procurement, production, logistics, maintenance, sales/support, and mobile field users.
7. **Policy/audit/security aware** — PBAC/RBAC/ABAC, passkey step-up for signature-equivalent actions, legal/privacy constraints, retention, and auditability are not optional add-ons.
8. **Best-practice benchmarked** — compare against mature category leaders and official docs/guides/screens before accepting a gap or design pattern.
9. **No demo/stub paths** — if a screen cannot execute a real workflow, it should be hidden, clearly marked unavailable with setup next steps, or tracked as a gap.
10. **Matrix traceability** — every backlog item from this document should link to a matrix row, source object, benchmark evidence, and verification path.

## UI/UX acceptance rubric

Every screen-level change should be reviewed against this rubric before merge:

| Bar | Acceptance question | Evidence expected |
| --- | --- | --- |
| Intuitive | Can the target persona understand what the screen is for within one glance without reading explanatory paragraphs? | First-screen hierarchy, page title, object labels, empty state, and primary action are obvious in screenshots or e2e traces. |
| Self-explanatory | Are next actions discoverable from labels, status, grouping, and affordances rather than walls of copy? | Tests assert actionable UI elements, filters, counters, state chips, and next-action buttons — not decorative text blocks. |
| Ergonomic | Does the common path require the fewest safe clicks and avoid dead ends, duplicate routes, and context loss? | User-story e2e path covers the common path, fallback state, and recovery path. |
| Visually prioritized | Are urgent, overdue, blocked, sensitive, assigned-to-me, and approval-needed items visually distinct from background context? | Queue ordering, badges, color/weight, density, and keyboard/mobile accessibility are reviewed. |
| Workflow-aware | Does the screen preserve source object context, policy, evidence, messages, mail, files, approvals, and audit trail? | The implementation links actions back to typed source objects and records audit-relevant metadata. |
| Story-aware | Does the screen work for employee, manager, group admin, platform admin, and domain-specific roles without forcing maintenance/logistics vocabulary everywhere? | Role/scope stories are tested or explicitly tracked as gaps with a matrix row. |

Related repo references: [issue #55 collaboration/work hub benchmark](./issue-55-collaboration-work-hub.md) and [Palantir Foundry operations benchmark](./palantir-foundry-ops-benchmark.md).

## Current route and module inventory

| Area | Current routes/screens | Current product role |
| --- | --- | --- |
| Public storefront/onboarding | `/`, `/home`, `/landing`, `/rental`, `/used`, `/maintenance`, `/about`, `/contact`, `/privacy`, `/platform-fsm`, `/support/new`, `/login`, `/onboarding`, `/pending` | Public KNL/customer entry, platform marketing, login, passkey/onboarding, pending-access state |
| Platform administration | `/platform`, `/platform/tenants`, `/platform/groups`, `/platform/ops`, `/platform/onboard`, `/platform/account` | Vendor/platform admin tenancy, group, ops, tenant onboarding, platform account |
| Enterprise action inbox | `/work-hub` | Authenticated landing/action inbox across available sources |
| Dispatch/work execution | `/dispatch`, `/work-orders/:id`, `/dispatch-map`, `/intake`, `/daily-plan`, `/inspection`, `/ops`, `/reporting`, `/kpi`, `/wallboard` | Current maintenance/logistics execution, planning, inspection, ops, reporting, dashboard views |
| Workflow and approvals | `/approvals`, `/settings/policy`, `ApprovalQueue`, `ApprovalCommandCenter`, `TargetChangeReviewQueue` | Federated approval feed, policy studio, approval/rejection actions |
| Collaboration/work communications | `/collaboration`, `/messenger`, `/mail`, `/settings/email`, `/support`, `/support/new` | Messenger, work mail, support tickets, mail setup |
| People/org/security | `/settings`, `/settings/profile`, `/settings/location`, `/settings/employees`, `/settings/group`, `/settings/users`, `/settings/org`, `/settings/security` | Profile, location consent, employees, group admin, users, org branches/regions, admin security |
| Assets/sites/equipment | `/equipment`, `/equipment/:id`, `/equipment/manage`, `/equipment/legacy`, `/settings/sites`, equipment panels | Equipment browse/detail/manage, imports, site geography, substitutions, management number controls |
| Finance/procurement/assets economics | `/financial`, `PurchaseRequestPanel`, `RentalQuotePanel`, `CostLedgerPanel`, `AssetLifecycleCostPanel` | Purchase requests, rental quotes, cost ledgers, lifecycle economics |
| Catalog/ontology/data quality | `/catalog`, `/integrity`, import panels | Catalog administration, governance/integrity findings, import entry points |

## Official benchmark source registry

Use official product docs/pages first. Third-party roundup links from issue comments are discovery context only.

- **UX and enterprise shell**: SAP Fiori design principles (<https://www.sap.com/design-system/fiori-design-ios/discover/sap-design-system/vision-and-mission/sap-fiori-design-principles>), SAP Fiori web (<https://www.sap.com/design-system/fiori-design-web>), SAP Design System (<https://www.sap.com/design-system>).
- **Action inbox / approvals / service delivery**: ServiceNow Approvals Hub (<https://www.servicenow.com/docs/r/yokohama/employee-service-management/employee-experience-foundation/approval-hub-intro.html>), ServiceNow approval integrations (<https://www.servicenow.com/docs/r/washingtondc/employee-service-management/employee-experience-foundation/approvals-int-concept.html>), Jira Service Management approvals (<https://support.atlassian.com/jira-service-management-cloud/docs/what-are-approvals/>), Jira SLAs (<https://support.atlassian.com/jira-service-management-cloud/docs/create-service-level-agreements-slas/>), Power Automate approvals (<https://learn.microsoft.com/en-us/power-automate/get-started-approvals>).
- **Collaboration / messaging / mail**: Slack Workflow Builder (<https://slack.com/help/articles/360035692513-Guide-to-Slack-Workflow-Builder>), Slack workflow automation (<https://slack.com/features/workflow-automation>), Slack canvas automation (<https://slack.com/help/articles/25883690838419-Automate-data-collection-with-canvas-and-Workflow-Builder>), Microsoft Teams help (<https://support.microsoft.com/en-us/teams>), Microsoft Teams product (<https://www.microsoft.com/en-us/microsoft-teams/group-chat-software>), Outlook mail/calendar (<https://www.microsoft.com/en-us/microsoft-365/outlook/email-and-calendar-software-microsoft-outlook>), Outlook calendar support (<https://support.microsoft.com/en-us/outlook/calendar/introduction-to-the-outlook-calendar>), Gmail labels/filters (<https://support.google.com/a/users/answer/9282734?hl=en>), Gmail attachment filters (<https://knowledge.workspace.google.com/admin/gmail/advanced/filter-messages-with-attachments>), Proton Mail (<https://proton.me/support/mail/using-mail>), Proton business mail (<https://proton.me/business/mail>), KakaoTalk official service page (<https://www.kakaocorp.com/page/service/service/kakaotalk?lang=en>), WhatsApp Business Platform (<https://business.whatsapp.com/products/business-platform>), WhatsApp Business Platform features (<https://business.whatsapp.com/products/business-platform-features>), Messenger Platform (<https://developers.facebook.com/documentation/business-messaging/messenger-platform>), Messenger Platform overview (<https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview>).
- **Work/task/project tracking and knowledge**: Asana rules (<https://help.asana.com/s/article/rules>), Asana board view (<https://help.asana.com/s/article/board-view>), Microsoft Planner in Teams (<https://support.microsoft.com/en-us/planner/teams/getting-started-with-planner-in-teams>), Microsoft task publishing (<https://support.microsoft.com/en-us/office/publish-task-lists-to-define-and-track-work-in-your-organization-095409b3-f5af-40aa-9f9e-339b54e705df>), Confluence live docs (<https://support.atlassian.com/confluence-cloud/docs/create-and-collaborate-in-real-time-with-live-docs/>), Confluence overview (<https://support.atlassian.com/confluence-cloud/docs/what-is-confluence-cloud/>), Notion wikis (<https://www.notion.com/product/wikis>), Notion projects (<https://www.notion.com/product/projects>).
- **Visual workflow / BPM / no-code automation**: monday automations (<https://support.monday.com/hc/en-us/articles/360001222900-Get-started-with-monday-automations>), monday workflow builder vs automations (<https://support.monday.com/hc/en-us/articles/18382067611410-Comparing-the-workflow-builder-and-automations>), ClickUp statuses (<https://help.clickup.com/hc/en-us/articles/6309452618647-Manage-task-statuses>), Kissflow no-code approval workflow (<https://kissflow.com/no-code/no-code-approval-workflow/>), Pipefy connected-card automation (<https://help.pipefy.com/en/articles/8186232-how-to-create-an-automation-for-when-all-connected-cards-are-moved-from-one-phase-to-another>), Zapier workflow concepts (<https://help.zapier.com/hc/en-us/articles/8496181725453-Learn-key-concepts-in-Zap-workflows>), Zapier filters (<https://help.zapier.com/hc/en-us/articles/8496276332557-Add-conditions-to-Zap-workflows-with-filters>), Make error handling (<https://help.make.com/overview-of-error-handling>), Power Automate docs (<https://learn.microsoft.com/en-us/power-automate/>), UiPath docs (<https://docs.uipath.com/>), Automation Anywhere docs (<https://docs.automationanywhere.com/>), Automation Anywhere Process Discovery (<https://www.automationanywhere.com/products/process-discovery>), Automation Anywhere Document Automation (<https://www.automationanywhere.com/products/document-automation>).
- **HRIS / HCM / org design / performance**: Rippling IAM (<https://www.rippling.com/products/it/identity-access-management>), Rippling device management (<https://www.rippling.com/products/it/device-management>), BambooHR (<https://www.bamboohr.com/>), BambooHR onboarding (<https://www.bamboohr.com/platform/onboarding/>), Gusto (<https://gusto.com/>), Gusto HR compliance (<https://gusto.com/product/hr/compliance>), Workday HCM (<https://www.workday.com/en-us/products/human-capital-management/overview.html>), Workday HCM concept (<https://www.workday.com/en-us/topics/hr/human-capital-management-software.html>), SAP SuccessFactors HCM (<https://www.sap.com/products/hcm.html>), SAP SuccessFactors Employee Central (<https://www.sap.com/products/hcm/employee-central-hris.html>), SAP Help Employee Central (<https://help.sap.com/docs/successfactors-employee-central>), ADP Workforce Now (<https://www.adp.com/what-we-offer/products/adp-workforce-now.aspx>), ADP HRIS (<https://www.adp.com/what-we-offer/hr-information-systems.aspx>), ChartHop (<https://www.charthop.com/>), ChartHop planning (<https://docs.charthop.com/planning>), ChartHop headcount planning (<https://docs.charthop.com/headcount-planning>), Pingboard/Workleap (<https://workleap.com/pingboard>), Lucidchart org chart (<https://www.lucidchart.com/pages/examples/orgchart_software>), Lucid org chart help (<https://help.lucid.co/hc/en-us/articles/16463330693268-Create-an-org-chart>), Lattice 1:1s (<https://lattice.com/platform/performance/one-on-ones>), Lattice OKRs (<https://lattice.com/platform/goals/okrs>), 15Five (<https://www.15five.com/>), 15Five check-ins (<https://www.15five.com/products/perform/check-ins>), Culture Amp platform (<https://www.cultureamp.com/platform>), Culture Amp insights (<https://www.cultureamp.com/science/insights>).
- **ERP / finance / procurement / assets**: SAP Cloud ERP (<https://www.sap.com/products/erp.html>), SAP S/4HANA Cloud (<https://www.sap.com/products/erp/s4hana.html>), NetSuite ERP (<https://www.netsuite.com/portal/products/erp.shtml>), NetSuite inventory (<https://www.netsuite.com/portal/products/erp/warehouse-fulfillment/inventory-management.shtml>), SAP EAM (<https://www.sap.com/products/scm/asset-management-eam.html>), SAP EAM concept (<https://www.sap.com/resources/what-is-eam>), Dynamics 365 Supply Chain docs (<https://learn.microsoft.com/en-us/dynamics365/supply-chain/>), Dynamics asset management (<https://learn.microsoft.com/en-us/dynamics365/supply-chain/asset-management/>).
- **CRM / CX / support**: Salesforce Sales Cloud (<https://www.salesforce.com/sales/cloud/>), Salesforce pipeline (<https://www.salesforce.com/sales/pipeline/>), HubSpot pipeline automation (<https://knowledge.hubspot.com/object-settings/set-up-pipeline-automations-for-objects>), HubSpot tickets (<https://knowledge.hubspot.com/records/create-tickets>), Zendesk service platform (<https://www.zendesk.com/>), Zendesk SLA guide (<https://www.zendesk.com/blog/customer-service/support/keeping-word-support-sla/>).
- **Analytics / ontology / operational intelligence**: Power BI dashboards (<https://learn.microsoft.com/en-us/power-bi/create-reports/service-dashboards>), Power BI concepts (<https://learn.microsoft.com/en-us/power-bi/fundamentals/service-basic-concepts>), Power BI semantic models (<https://learn.microsoft.com/en-us/power-bi/connect-data/service-datasets-understand>), SAP Analytics Cloud (<https://www.sap.com/products/data-cloud/cloud-analytics.html>), SAP Analytics business content (<https://pages.community.sap.com/topics/cloud-analytics/business-content>), Palantir Action Types (<https://palantir.com/docs/foundry/action-types/overview/>), Palantir Action rules (<https://palantir.com/docs/foundry/action-types/rules/>), Palantir Workflow Lineage (<https://palantir.com/docs/foundry/workflow-lineage/overview/>).

## Cross-screen parity matrix

This table intentionally includes the issue #55 fields: current screen/module, intended enterprise category, benchmark products/evidence, current strengths, missing capabilities, UX weaknesses, policy/audit/security gaps, data/model gaps, integration gaps, e2e/user-story gaps, priority, and recommended implementation slices. Detailed gap fields are in the row details below to keep this table reviewable.

| ID | Current screen/module | Intended enterprise category | Benchmark products/evidence | Current strengths | Priority | Recommended first closure slice |
| --- | --- | --- | --- | --- | --- | --- |
| EP-001 | Public storefront, contact, support intake, platform marketing, login/onboarding/pending | Public trust, onboarding, legal consent, authenticated entry | SAP Fiori, Outlook/Gmail/Proton trust patterns, Zendesk intake, Korea legal review | Public routes, privacy route, public support intake, passkey onboarding | P1 | Public IA cleanup: group/platform vs KNL service pages, onboarding recovery, legal consent mapping |
| EP-002 | `/work-hub` action inbox | Group-wide enterprise action inbox | ServiceNow Approvals Hub, SAP Task Center/Work Zone pattern, Microsoft Planner, Slack workflows | Aggregates work orders, approvals, daily plans, messenger, support, mail readiness; login routes here | P0 | Remove explainer copy; replace with actionable personal/team/group queues and neutral source taxonomy |
| EP-003 | `/approvals`, approval queues, target-change review | Universal approval/decision center | ServiceNow/Jira/Power Automate/Kissflow | Server-owned `GET /api/approval-items`; typed approval feed for some sources | P0 | Universal `ApprovalItem` context rail with passkey step-up and source-object evidence |
| EP-004 | `/settings/policy`, RBAC/PBAC/ABAC | Configurable access policy and governed actions | Rippling IAM, Palantir action rules, ServiceNow/Jira approvals | Policy Studio, route guards, backend checks | P0 | Effective-permissions preview, deny reasons, policy approval workflow |
| EP-005 | `/messenger`, `/collaboration` | Enterprise messaging and object-linked collaboration | Slack, Teams, KakaoTalk/Kakao Work, WhatsApp Business, Messenger Platform | Branch-scoped members; conversation create/send/search/thread slices | P1 | Channel/team/object-thread taxonomy with mentions, read state, files, retention |
| EP-006 | `/mail`, `/settings/email` | Work mail and secure correspondence | Gmail, Outlook, Proton Mail, Teams email-to-channel | Account readiness, inbox/thread detail, reply/forward, outbound attachments | P1 | Drafts/templates/labels/filters/search plus object-linked mail sends |
| EP-007 | `/support`, `/support/new`, customer intake | Service desk and customer/internal support | Zendesk, Jira Service Management, HubSpot tickets, Salesforce | Public intake and ticket list/detail/comment/transition; closed tickets removed from Work Hub | P1 | SLA/status/priority model, ticket-to-work-object conversion, customer/account timeline |
| EP-008 | People, users, profile, location, security settings | HRIS, identity, account lifecycle, legal people records | Workday, SAP SuccessFactors, BambooHR, Gusto, Rippling, ADP | Employee/user pages, passkey/security panels, location consent panel | P0 | HRIS master record, employment lifecycle, signup state split, Korea legal field review |
| EP-009 | Group/platform/org admin routes | Platform, tenant, group, subsidiary, org administration | Workday, ChartHop, Pingboard, Rippling, ServiceNow | Group/platform pages; group/subsidiary management slices; platform account | P0 | Unified group/org graph, scope switcher, group account management, platform audit console |
| EP-010 | Org chart, directory, headcount, performance/engagement | Org design, workforce planning, talent performance | ChartHop, Pingboard, Lucidchart, Lattice, 15Five, Culture Amp | Basic org/group/employees routes | P1 | Dynamic org graph and directory with positions, teams, departments, and history |
| EP-011 | `/equipment`, equipment detail/manage, sites/location | Assets, inventory, EAM, location management | SAP EAM, Dynamics Asset Management, NetSuite Inventory, Palantir ontology | Equipment browse/detail/manage/import, object action catalog, site geography, lifecycle cost panel | P1 | General Asset/InventoryItem/Location ontology with custom types and activity rail |
| EP-012 | `/financial`, purchase/rental/cost/lifecycle panels | Finance, procurement, rental economics, asset lifecycle | SAP Cloud ERP, NetSuite ERP, Dynamics Supply Chain | Purchase requests, rental quotes, cost ledger, asset lifecycle cost panels | P1 | Procurement request workflow with vendors, budget/cost center, approvals, rental margin |
| EP-013 | Dispatch/work orders/daily plan/inspection/reporting/ops/KPI/wallboard | Operations execution and operational reporting | SAP, Dynamics, ServiceNow, Power BI, SAP Analytics | Work orders, daily plans, inspection, reporting, ops dashboard, KPI/wallboard | P1 | Generic `WorkItem/Task/Plan` model with domain type and role-specific day/week dashboards |
| EP-014 | `/catalog`, `/integrity`, import panels | Ontology, data quality, import/export, semantic catalog | Palantir ontology/action/lineage, Power BI semantic models, Make/Zapier error handling | Catalog admin, integrity findings, equipment import panels | P0 | Upload-preview-map-validate-dry-run-commit import mapper with type-safe destinations |
| EP-015 | Analytics/optimization/intelligence surfaces | Operational intelligence, scenario analysis, recommendations | Power BI, SAP Analytics, Palantir, SAP EAM/NetSuite economics | KPI/reporting and lifecycle cost panels | P2 | Recommendation/scenario/assumption model after trusted source-object data exists |
| EP-016 | Swift/Kotlin mobile apps | Mobile employee self-service, secure field actions, notifications | Slack/Teams mobile, Workday/Gusto self-service, Power Automate approvals, KakaoTalk/WhatsApp mobile ergonomics | Mobile builds and parity checks exist; passkey/auth direction exists | P1 | Mobile day-start action inbox, push preferences, passkey approval step-up, messaging/mail/calendar/poll parity |

## Row-level gap traceability

### EP-001 — public storefront/onboarding

- **Pain point**: visitors, customers, and employees need clear entry paths, legal trust, and role-appropriate onboarding without confusion.
- **Missing capabilities**: role-request onboarding, self-service recovery, cookie/privacy consent mapping, customer-vs-employee route clarity.
- **UX weaknesses**: public product framing remains KNL/maintenance-heavy; pending/onboarding guidance is thin.
- **Policy/audit/security gaps**: Korea-specific privacy/cookie/retention review is not fully encoded in UI or audit evidence.
- **Data/model gaps**: no unified consent/version/retention model tied to onboarding identity.
- **Integration gaps**: support intake, account creation, role request, and admin approval are not a single traceable flow.
- **E2E/user-story gaps**: no full visitor-to-support, employee-to-role-request, or passkey-loss recovery story proof.

### EP-002 — Work Hub/action inbox

- **Pain point**: every user needs a first screen showing what matters today/week across role, group, org, department, and team.
- **Missing capabilities**: generic enterprise task/action taxonomy, scope switcher, personal/team/manager lanes, due/SLA/blocked visual priority.
- **UX weaknesses**: text such as `Workflow + Approval / 업무 객체 중심 실행 흐름` explains intent but does not help users act; maintenance/logistics framing leaks into the shell.
- **Policy/audit/security gaps**: visibility and actions are not fully explained by PBAC/RBAC/ABAC deny reasons or sensitive-action step-up.
- **Data/model gaps**: no universal `ActionItem`/`WorkItem` object that can represent HR, payroll, finance, purchasing, production, support, logistics, and maintenance.
- **Integration gaps**: messages, mail, support, approvals, tasks, evidence, and audit are aggregated but not consistently object-linked.
- **E2E/user-story gaps**: needs role-specific day/week flows for employee, manager, group admin, platform admin, HR, finance, production, logistics, and maintenance.

### EP-003 — approvals

- **Pain point**: managers must approve/reject real decisions with source context, evidence, policy, and audit instead of isolated cards.
- **Missing capabilities**: purchase/HR/payroll/finance/group approvals, delegation, substitution, escalation, conditional routing.
- **UX weaknesses**: approval context is shallow and not always visually tied to source object, requester, evidence, conversation, SLA, or policy reason.
- **Policy/audit/security gaps**: passkey step-up is not uniformly enforced for signing-equivalent decisions; decision history is thin.
- **Data/model gaps**: source-specific approvals need a universal typed approval schema and decision event model.
- **Integration gaps**: approval decisions are not consistently embedded into workflow, messenger, mail, support, procurement, HR, and audit rails.
- **E2E/user-story gaps**: needs approve/reject/escalate/delegate flows with audit proof and step-up verification.

### EP-004 — policy and access

- **Pain point**: admins need configurable policy based on company, group, org, department, team, position, responsibility, and custom roles.
- **Missing capabilities**: PBAC/ABAC conditions, obligations, role simulation, policy diff, change approval, effective-permissions viewer.
- **UX weaknesses**: admins cannot confidently see why a person can/cannot perform an action or what a policy change will affect.
- **Policy/audit/security gaps**: policy changes need approval, passkey step-up, immutable audit, and rollback/reversal semantics.
- **Data/model gaps**: custom roles, attributes, scopes, and employment transitions are not first-class enough.
- **Integration gaps**: policy outcomes are not consistently surfaced in Work Hub, approvals, messenger/mail, imports, and platform admin.
- **E2E/user-story gaps**: needs manager-created custom role, denied-action explanation, and policy-change approval stories.

### EP-005 — messenger/collaboration

- **Pain point**: work conversations must stay connected to teams, objects, decisions, files, and audit rather than becoming disconnected chat.
- **Missing capabilities**: channels, DMs, group conversations, mentions, read receipts, presence, files, object threads, retention/legal holds.
- **UX weaknesses**: no Slack/Teams/KakaoTalk-grade conversation ergonomics, searchable team taxonomy, or mobile parity.
- **Policy/audit/security gaps**: retention, legal hold, sensitive-content access, and audit metadata need admin controls.
- **Data/model gaps**: messages are not consistently modeled as object-linked evidence or decision context.
- **Integration gaps**: threads are not universally attachable to tasks, approvals, support tickets, mail, HR/payroll, procurement, and assets.
- **E2E/user-story gaps**: needs channel creation, mention notification, object-thread evidence, retention-policy, and mobile push stories.

### EP-006 — work mail

- **Pain point**: employees need complete work mail for receipts, notices, support, and object-linked correspondence.
- **Missing capabilities**: drafts, templates, folders, labels, filters/rules, search, schedule/snooze/undo, secure receipts, retention/legal hold.
- **UX weaknesses**: folder/search/action ergonomics are not Gmail/Outlook/Proton-grade.
- **Policy/audit/security gaps**: payroll/HR receipts and sensitive notices need access policy, read tracking, retention, and audit evidence.
- **Data/model gaps**: mail messages need object links, receipt types, retention classes, and standardized attachment metadata.
- **Integration gaps**: mail is not yet deeply wired to HR/payroll, support, procurement, approvals, and object activity rails.
- **E2E/user-story gaps**: needs compose draft, filter, object-linked payroll receipt, secure read, and retention/audit stories.

### EP-007 — support/service desk

- **Pain point**: customers and internal users need trackable requests with SLA, ownership, comments, knowledge, and conversion to work.
- **Missing capabilities**: knowledge suggestions, omnichannel intake, customer/account timeline, SLA automation, assignment/escalation rules.
- **UX weaknesses**: ticket context and next actions are thin compared with Zendesk/Jira/HubSpot.
- **Policy/audit/security gaps**: tenant/customer data boundaries, admin visibility, and SLA decisions need clearer audit trail.
- **Data/model gaps**: ticket priority, SLA clocks, account/customer objects, and conversion links are incomplete.
- **Integration gaps**: ticket-to-work-order/task/procurement/HR conversion is not mature.
- **E2E/user-story gaps**: needs customer submits ticket, manager triages SLA, converts to work item, closes with audit proof.

### EP-008 — people/users/security

- **Pain point**: group operations require legal, accurate people records plus account/device/passkey lifecycle and HR/payroll attributes.
- **Missing capabilities**: HRIS master file, onboarding/offboarding checklist, lifecycle state, time-off/payroll/benefits handoffs, device/app provisioning.
- **UX weaknesses**: user `active` status can mislead before signup completion; people, account, security, and HR context are split.
- **Policy/audit/security gaps**: device/passkey recovery, employment transitions, location consent, and sensitive HR actions need step-up and audit.
- **Data/model gaps**: employee, user account, employment, position, department/team, payroll/legal fields, and signup state are not sufficiently separated.
- **Integration gaps**: HRIS import, group admin account creation, access provisioning, mail receipts, and policy are not a single lifecycle.
- **E2E/user-story gaps**: needs hire, onboard, passkey loss, transfer, leave, offboard, and rehire stories with Korea legal review.

### EP-009 — platform/group/org admin

- **Pain point**: platform and group admins need to manage tenancy, groups, subsidiaries, accounts, logs, and scoped views without impersonation confusion.
- **Missing capabilities**: full group/org graph, group account management, scope-isolated views, platform audit/log console, name/slug edit consistency.
- **UX weaknesses**: separation of platform, tenant, group, and org remains immature; group-wide management affordances are not visually clear.
- **Policy/audit/security gaps**: cross-tenant admin actions need strict authorization, passkey step-up, scoped audit, and visibility controls.
- **Data/model gaps**: group, tenant, org, subsidiary, branch, department, and team hierarchy need durable graph semantics.
- **Integration gaps**: spreadsheet/CSV org import, account creation, policy, audit, and Work Hub scope are not fully connected.
- **E2E/user-story gaps**: needs platform admin, group admin, subsidiary admin, and org-scope switch stories.

### EP-010 — org chart/performance/engagement

- **Pain point**: leaders and managers need to understand reporting lines, plan headcount, transfer employees, and manage performance while preserving history.
- **Missing capabilities**: dynamic org chart, directory, headcount scenarios, compensation/performance/OKR/1:1/survey modules.
- **UX weaknesses**: no visual graph or scenario-planning interaction comparable to ChartHop/Pingboard/Lucidchart.
- **Policy/audit/security gaps**: legal transfers, terminations, rehires, and compensation/performance visibility need role-scoped audit.
- **Data/model gaps**: position, reporting line, job family, employment event, compensation, and historical org snapshot models are incomplete.
- **Integration gaps**: org chart is not yet tied to HRIS import, payroll, policy, Work Hub, approvals, and analytics.
- **E2E/user-story gaps**: needs manager views org, proposes transfer, preserves history, and updates access/payroll stories.

### EP-011 — assets/equipment/sites/inventory

- **Pain point**: asset-heavy companies need trusted asset/location/inventory records and lifecycle decisions, while non-asset companies should not be forced into maintenance vocabulary.
- **Missing capabilities**: generalized inventory, custom item types, reserve policy, probabilistic SLA/spares planning, lifecycle sell/keep/acquire workflows.
- **UX weaknesses**: product shell remains equipment/maintenance-specific in places; `장비관리` and `장비조회` are split where browse-select-manage may be clearer.
- **Policy/audit/security gaps**: asset changes, site/geolocation, lifecycle decisions, and rentals need permissions, audit, and approval routing.
- **Data/model gaps**: `Asset`, `InventoryItem`, `Location`, `Site`, `Client`, `Part`, and custom item types need ontology-style schema.
- **Integration gaps**: asset data is not fully connected to finance, procurement, work orders, reservations, imports, and analytics.
- **E2E/user-story gaps**: needs import assets, browse list, manage asset, attach part/inventory, price rental, and sell/keep decision stories.

### EP-012 — finance/procurement/rental economics

- **Pain point**: finance and procurement need request-to-approval-to-cost/vendor/asset workflows, not isolated calculators.
- **Missing capabilities**: procure-to-pay, vendor, budget, cost center, tax, quote-to-contract, invoice/payment, rental margin simulation.
- **UX weaknesses**: panels are not yet a coherent SAP/NetSuite/Dynamics-grade workflow.
- **Policy/audit/security gaps**: purchase, budget, rental rate, and payment-like decisions need approval, passkey step-up, and audit.
- **Data/model gaps**: vendor, PO, quote, contract, invoice, budget, cost center, margin, and lifecycle economics models are incomplete.
- **Integration gaps**: finance is not fully connected to assets, inventory, workforce, mail receipts, support/customer, and analytics.
- **E2E/user-story gaps**: needs purchase request, approval, vendor quote, budget impact, asset link, and rental margin stories.

### EP-013 — operations execution/reporting

- **Pain point**: operations users need domain-specific execution paths, while the platform must also serve production, HQ, finance, HR, and admin workflows.
- **Missing capabilities**: generic task/work/plan model, production/HQ/finance/HR templates, drilldowns from KPI/report to source objects.
- **UX weaknesses**: daily workflows remain maintenance/logistics-centered and do not always preserve source context.
- **Policy/audit/security gaps**: operational assignments, sensitive tasks, and KPI drilldowns need role-scoped visibility and audit.
- **Data/model gaps**: a generalized `WorkItem/Task/Plan` with domain type, schedule, owner, state, SLA, evidence, and source object is missing.
- **Integration gaps**: reporting, work orders, support, messenger, mail, approvals, and analytics are not consistently connected.
- **E2E/user-story gaps**: needs day/week stories for equipment operator, maintenance crew, logistics office worker/manager, production worker/supervisor, HQ worker/manager/executive.

### EP-014 — catalog/import/ontology/data quality

- **Pain point**: admins need to ingest messy spreadsheets/CSVs safely and output standardized typed data.
- **Missing capabilities**: preview, column mapping, destination type guardrails, validation, dry run, row-level errors, dedupe, lineage, standardized export.
- **UX weaknesses**: simple upload/import is insufficient; users need a visual mapping table and safe commit workflow.
- **Policy/audit/security gaps**: imports need data-class warnings, sensitive-field handling, approval for high-risk changes, and audit of source file/mapping/actor.
- **Data/model gaps**: user-configurable ontology object/item types, fields, relationships, actions, semantic models, and quality rules are immature.
- **Integration gaps**: imports are not generally wired to employee, org graph, clients, locations, assets, inventory, finance, and standardized export.
- **E2E/user-story gaps**: needs upload workbook, preview rows, map employee-only columns to employee schema, reject wrong domain, dry-run, commit, export standardized data.

### EP-015 — analytics/optimization/intelligence

- **Pain point**: executives need trusted operational intelligence for pricing, utilization, reserves, workforce, maintenance windows, asset lifecycle, and SLA risk.
- **Missing capabilities**: recommendation/scenario/assumption objects, confidence, drilldown, approval, write-back, baseline algorithms.
- **UX weaknesses**: dashboards do not consistently explain source data, assumptions, confidence, and available decisions.
- **Policy/audit/security gaps**: AI/ML/LLM/RL-assisted decisions must be governed, explainable, auditable, and approval-gated.
- **Data/model gaps**: trusted object/event/cost/workforce/asset data and semantic models must exist before advanced intelligence.
- **Integration gaps**: analytics is not yet tied to workflow actions, approvals, source object lineage, and observability feedback loops.
- **E2E/user-story gaps**: needs read-only scenario review, approval of recommendation, and drilldown-to-source evidence stories before automation.

### EP-016 — mobile apps

- **Pain point**: field and employee users need clock-in, passkey signing, notifications, approvals, messenger, mail, calendar, and polls in mobile-first workflows.
- **Missing capabilities**: mobile day-start action inbox, notification preferences, secure approvals, messenger/mail/calendar/poll parity, offline-safe field UX.
- **UX weaknesses**: mobile workflows are not yet benchmarked to Slack/Teams/mobile messenger ergonomics or Workday/Gusto employee self-service.
- **Policy/audit/security gaps**: location/clock-in consent, passkey step-up, device trust, and sensitive actions need explicit mobile audit flows.
- **Data/model gaps**: mobile notification, device, session, location consent, and offline action models need product-level design.
- **Integration gaps**: mobile app parity is not fully connected to Work Hub, approvals, mail, messenger, calendar, poll, HR/payroll, and operations.
- **E2E/user-story gaps**: needs Swift/Kotlin user stories for clock-in, approval, passkey reset, notification, message/mail/calendar/poll, and offline retry.

## Priority backlog derived from the matrix

### P0 — unblock product maturity and prevent bad patterns

1. **EP-002 remove text-wall UI from operational screens**: start with Work Hub's `Workflow + Approval / 업무 객체 중심 실행 흐름` block and update tests/e2e to assert actionable queues instead of decorative copy.
2. **EP-002 make Work Hub group-wide**: domain-neutral action inbox taxonomy with maintenance/logistics as one source type; add personal/team/group/org scope affordances.
3. **EP-008/EP-009 people/org foundation**: split account signup state from employee active state; implement HRIS-grade employee/org/group schema and import readiness.
4. **EP-004 policy foundation**: effective permissions, PBAC/ABAC conditions, role/position/department/team attributes, deny reasons, policy change audit.
5. **EP-014 import/ontology foundation**: spreadsheet/CSV preview, column mapping, type-safe destination mapping, dry-run, row errors, dedupe, lineage, standardized export.
6. **EP-003 approval/signature foundation**: passkey step-up for signing-equivalent approval decisions and policy changes.

### P1 — close visible workflow gaps

1. **EP-003/EP-005/EP-006/EP-007/EP-011** universal object activity rail: messages, mail, files/evidence, approvals, comments, status history, and audit on every major object.
2. **EP-006 Work Mail maturity**: drafts/templates/labels/filters/search/object-linking/retention/audit/receipts.
3. **EP-005 Messenger maturity**: channels/object threads/mentions/files/read state/notifications/retention.
4. **EP-007 Support maturity**: SLA, knowledge suggestions, ticket-to-work conversion, customer/account timeline.
5. **EP-009/EP-010 Org chart and group hierarchy**: dynamic visual graph, subsidiary/team/department switching, headcount scenario planning.
6. **EP-013 generic task/work model**: day/week dashboard for HR, finance, production, HQ, logistics, maintenance, and support.

### P2 — expand enterprise modules

1. **EP-008/EP-010 HR lifecycle**: onboarding/offboarding, transfers, time-off, payroll receipt, benefits/compliance, performance/OKR/1:1/survey after HRIS foundation.
2. **EP-012 finance/procurement/ERP**: purchase-to-approval, vendor, budget/cost center, rental quote lifecycle, invoice/payment hooks.
3. **EP-011 asset/inventory lifecycle**: generalized inventory/parts/assets, reserve policy, lifecycle economics, sell/keep/acquire workflows.
4. **EP-015 analytics semantic layer**: Power BI/SAP Analytics-style dashboards that drill to semantic models and source objects.

### P3 — intelligence after mechanics are trustworthy

1. **EP-015 recommendation/scenario/optimization objects** for rental pricing, reserve levels, workforce utilization, maintenance windows, asset lifecycle decisions, and SLA risk.
2. Algorithmic baselines first; ML/RL/LLM only after data quality, observability, and approval/write-back controls exist.

## Rejection rules

Reject or defer any GitHub issue/comment/request when it:

- Makes a group-wide enterprise surface more maintenance-specific without a domain-neutral abstraction.
- Adds decorative copy or marketing explanations inside an operational workflow instead of actionable affordances.
- Creates isolated demo/stub UI with no real backend/source object/audit path.
- Weakens privacy, Korean labor-law compliance, retention, consent, passkey step-up, or auditability.
- Adds AI/ML/LLM/RL before source data, algorithms, observability, and governed write-back are ready.
- Bypasses PBAC/RBAC/ABAC, org/group scope, or legal employment history.

## Verification expectations for future PRs

Each PR that claims to close a matrix gap must include:

- Stable matrix row ID.
- Persona and pain point.
- Source object(s) and workflow state(s).
- Benchmark pattern used, with official source link.
- Policy/audit/security impact.
- Data/model and integration impact.
- Unit/integration/e2e coverage for at least one real user story.
- Live or staging evidence when deployed.
