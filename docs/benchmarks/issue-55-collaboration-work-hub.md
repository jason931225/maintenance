# Issue #55 benchmark: enterprise collaboration/work hub

Date reviewed: 2026-06-28

## Product benchmark conclusion

The mature enterprise pattern is not a standalone chat clone. The benchmark pattern is a role-based work home that aggregates tasks, approvals, conversations, evidence, and notifications around business objects, with deep links back to the source system of record.

Primary official references:

- Slack: Lists, canvases, huddles, email ingestion, and Workflow Builder show conversation-first work tracking and lightweight automation beside chat.
  - https://slack.com/help/articles/27452748828179-Use-lists-in-Slack
  - https://slack.com/help/articles/203950418-Use-a-canvas-in-Slack
  - https://slack.com/features/huddles
  - https://slack.com/help/articles/206819278-Send-emails-to-Slack
  - https://slack.com/help/articles/360035692513-Guide-to-Workflow-Builder
- Microsoft 365: Teams + Outlook + Planner + Approvals proves the suite-shell model where chat, mail, tasks, and approvals remain separate capable apps but are promoted into the collaboration surface.
  - https://www.microsoft.com/en-us/microsoft-teams/group-chat-software
  - https://www.microsoft.com/en-us/microsoft-365/outlook/log-in
  - https://learn.microsoft.com/en-us/office365/servicedescriptions/project-online-service-description/microsoft-planner-service-description
  - https://support.microsoft.com/en-us/office/what-is-approvals-a9a01c95-e0bf-4d20-9ada-f7be3fc283d3
- SAP: Build Work Zone, Task Center, Build Process Automation, and Fiori establish the role-based work zone, federated task inbox, workflow automation, and consistent enterprise UX baseline.
  - https://www.sap.com/products/technology-platform/workzone.html
  - https://www.sap.com/products/technology-platform/task-center.html
  - https://www.sap.com/products/technology-platform/process-automation.html
  - https://www.sap.com/products/technology-platform/fiori.html
- Atlassian: Jira task tracking, Confluence live docs, and Jira Service Management approvals show docs/tasks/status transitions as workflow objects.
  - https://www.atlassian.com/software/jira/templates/task-tracking
  - https://support.atlassian.com/confluence-cloud/docs/create-and-collaborate-in-real-time-with-live-docs/
  - https://support.atlassian.com/jira-service-management-cloud/docs/what-are-approvals/
- ServiceNow: My Approvals / approval hubs and workspaces show a personal action inbox plus omnichannel approval handling.
  - https://www.servicenow.com/docs/r/yokohama/employee-service-management/employee-experience-foundation/approval-hub-intro.html
  - https://www.servicenow.com/docs/r/it-service-management/service-operations-workspace/view-approvals-sow.html
- Palantir Foundry/AIP: approvals, workflow lineage, operational process coordination, and branch protection show object/action/decision lineage as the maturity bar for operational workflows.
  - https://palantir.com/docs/foundry/approvals/overview/
  - https://palantir.com/docs/foundry/workflow-lineage/overview/
  - https://palantir.com/docs/foundry/use-case-patterns/operational-process-coordination/
  - https://palantir.com/docs/foundry/global-branching/resource-protection-and-approval-policies/

## Required user stories

### Mechanic / operator

- See today's and this week's assigned work, unread work threads, support blockers, evidence requests, and plan review state on the first screen.
- Open a work item and continue into the source object: work order, daily plan, messenger thread, support ticket, evidence, or approval decision.
- Post status, attach evidence, and request review without losing object context.

### Manager / tenant admin

- Triage a unified queue across work orders, report approvals, target due-date changes, daily-plan reviews, support tickets, messenger threads, and mail-derived work.
- Approve/reject with memo after seeing object context, evidence, conversation history, requester, and policy reason.
- Convert customer/internal messages or mail into work objects without copying raw text into an untracked side channel.

### Executive / group operator

- See weekly operating health, overdue approvals, unresolved threads, SLA risk, and department workload.
- Drill from KPI/risk to source work item to approval trail to evidence/message/mail lineage.

### HR / payroll

- Use work mail for receipts/notices with strict access, retention, and audit.
- Require passkey step-up for sensitive HR/payroll approvals or receipt issuance.

### Platform admin

- Configure retention, notification policy, channel scope, mail accounts, audit export, and capability gates.
- Inspect audit metadata without reading tenant-private content unless policy allows it.

## Capability requirements

- Messenger: channels, DMs, group conversations, work-object threads, mentions, read state, searchable history, evidence attachments, notifications, retention, and audit.
- Mail: inbox, sent, drafts, attachments, templates, payroll/HR receipts, object linking, search, retention, and audit. Unlike many benchmarks where mail is mostly ingress, this product requirement explicitly asks for a native work-mail UX.
- Work tracking: today/week dashboard, task assignments, due dates, comments, handoffs, reminders, evidence links, support links, approvals, and source-object deep links.
- Workflow/approvals: approval cards must show object type, requester, policy/capability, memo, evidence, conversation/mail links, SLA/due date, passkey step-up requirement, and audit trail.
- Policy: PBAC/RBAC/ABAC must determine visibility and action affordances. Users should not see dead links to known 403 routes.
- Audit: every sensitive write and approval decision must be auditable with actor, time, object, policy, and memo/evidence where applicable.

## First shipped slice in this branch

The first slice is `/work-hub`: an authenticated Work Hub landing page and default login destination that integrates existing live modules rather than inventing new stubs.

It currently aggregates:

- `/api/v1/work-orders` for assigned/team work.
- `/api/v1/work-orders?status=REPORT_SUBMITTED&status=ADMIN_REVIEW` for admin approval work.
- `/api/daily-work-plans` for daily-plan workflow.
- `/api/messenger/threads` for conversation/work-thread context.
- `/api/v1/support/tickets` for ticket/action blockers.
- `/mail` as the platform-operated mailbox surface; mail server host/port/password configuration is intentionally not exposed to tenants.

The page is role-aware:

- Mechanics default to `assigned_to=me` work-order scope.
- Admin/super-admin sessions see approval affordances; mail opens as a normal MailUse-gated mailbox, not as a server-settings task.
- Daily-plan cards only render as active for roles that hold the daily-plan capability.
- Partial backend failures are non-blank: loaded sources remain visible and the failed source list is shown with retry.


## Third shipped slice in this branch

This slice replaces browser-side approval composition with a server-owned federated approval-list API. `/approvals` now consumes `GET /api/approval-items`, which returns typed approval items, source counts, object identity, workflow keys, and policy context for work-order reports, daily-plan reviews, and target-change requests.

Quality and architecture notes:

- The backend denies mechanics and applies the existing branch-scope rule before returning approval items.
- The UI no longer calls legacy work-order/daily-plan list endpoints to assemble the approval inbox in the browser.
- Target-change review is no longer a manual request-code form; the page lists real pending target-change requests from the federated API and still posts decisions to the source-specific endpoint.
- Generated TS/Kotlin/Swift clients now include `ApprovalItem*` and `ApprovalItemsPage`, keeping web/mobile consumers on the same contract.
- Each approval item carries a small ontology/workflow/policy envelope so future passkey step-up, PBAC/ABAC/RBAC rules, object activity rails, and optimization recommendations can use the same source-object seam.

## Operations analytics/optimization benchmark

Valid user request: assets, rentals, workforce, reserves, pricing, and lifecycle decisions should eventually support analysis and optimization. This should be implemented as governed recommendations over trusted operational objects, not as speculative maintenance dashboards.

Official benchmark signals:

- SAP EAM positions enterprise asset management as lifecycle management that connects maintenance to financial, operational, and strategic outcomes: <https://www.sap.com/resources/what-is-eam>.
- SAP Asset Performance Management emphasizes asset health, performance, risk, maintenance strategy, sensor/maintenance records, and faster decisions: <https://www.sap.com/products/scm/apm.html>.
- SAP EAM product positioning covers full physical-asset lifecycle, operations, downtime, and ROI: <https://www.sap.com/products/scm/asset-management-eam.html>.
- Palantir Foundry Ontology frames data, models, and processes as an actionable representation of the business: <https://www.palantir.com/explore/platforms/foundry/ontology/>.
- Palantir Action Types emphasize object-linked actions as transactions over ontology objects, and Workflow Lineage helps understand/debug workflows across ontology resources: <https://palantir.com/docs/foundry/action-types/overview/>, <https://palantir.com/docs/foundry/workflow-lineage/overview/>.

Converged backlog direction:

1. Establish trusted object foundations first: tenant/group/org, people/roles/policies, clients/sites, assets/equipment/parts, cost ledgers, rental contracts/quotes, work orders, SLA commitments, and event history.
2. Add decision objects: `Recommendation`, `Scenario`, `AssumptionSet`, `OptimizationRun`, and `DecisionApproval`.
3. First optimization domains after setup: rental pricing, asset sell/keep/acquire, reserve equipment/parts policy, workforce utilization/scheduling, and SLA risk.
4. Every recommendation must show input snapshot, assumptions, confidence/uncertainty, expected impact, sensitivity/legal data classes, and approval/write-back path.
5. Never allow optimization write-back to bypass PBAC/ABAC/RBAC, passkey step-up for signing-equivalent actions, or audit.

## Next implementation slices

1. Approval Center unification: include target change, daily-plan review, purchase approvals, and future HR/payroll approvals in one typed approval card model.
2. Work Mail client: inbox/sent/drafts/search/attachments/templates/object-linking/receipt delivery, with retention and audit.
3. Messenger maturity: channel taxonomy, mentions, notification preferences, retention controls, archived/read-only states, and object context rail.
4. Universal object activity rail: comments, messages, mail, files/evidence, approvals, and status history side-by-side on work order, support, HR/payroll, and asset objects.
5. Policy UI: manager-editable PBAC/RBAC/ABAC policy surfaces with passkey step-up for sensitive actions.
6. E2E user-story coverage: mechanic day-start, admin approval, manager handoff, HR/payroll mail receipt, and platform audit scenarios.

## Second shipped slice in this branch

This slice upgrades `/approvals` into an Approval Command Center while staying on real production APIs.

It now aggregates:

- Work-order report approvals from `/api/v1/work-orders?status=REPORT_SUBMITTED&status=ADMIN_REVIEW`.
- Daily-plan approval work from `/api/daily-work-plans`, counting only `REQUESTED` plans as pending and deep-linking to `/daily-plan?planId=...` for review in the source object.
- Target due-date change review through the existing `/api/target-change-requests/{requestId}/review` review-by-code surface.

Quality and architecture notes:

- Partial source failures are non-blank: if daily-plan loading fails, work-order approvals remain visible with a retryable source-specific error.
- Work Hub approval cards now deep-link to `/approvals?source=work-order&focus=...`, preserving source-object context for future focus handling.
- The UI does not fake a target-change pending list. The remaining backend gap is a proper list endpoint carrying requester, work order, reason, due date, policy, and audit metadata.
- The UI does not claim passkey step-up is enforced for approvals yet. That remains a backend/session capability gap required before sensitive approval decisions can truthfully be labeled passkey-gated.

Additional valid backlog added from this slice:

1. Add a federated approval list API for target-date changes, purchase requests, HR/payroll requests, and future workflow objects.
2. Add source-object focus handling on `/approvals?source=...&focus=...` so deep links scroll/open the specific approval card.
3. Add passkey step-up challenge/attestation to approval and signing endpoints before marking those actions as signature-grade.
4. Enrich daily-plan summary payloads with requester/mechanic display name, item count, risk/SLA context, and audit trail so the Approval Command Center can support direct typed cards without blind decisions.
