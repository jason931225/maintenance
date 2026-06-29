# Messenger + Mail maturity matrix

Date reviewed: 2026-06-29

## Verdict

This product does **not** yet match best-in-class messenger or mail systems. The current branch moves two real capabilities forward — Messenger unread/read state and Mail thread read-state actions/keyboard send — but those are foundation slices, not parity.

- **Messenger:** production-grade enough for audited basic work-thread messaging, but not yet Slack/Teams/Intercom class. Main gaps are notification fanout, searchable/persistent information architecture, reactions/replies/edit/delete, presence/typing, mature attachments, retention/export, and cross-object activity rails.
- **Mail:** basic tenant webmail exists, but it is not Gmail/Outlook/Proton/Postmark/SES class as a client or server. Main gaps are read/write mailbox actions beyond this slice, labels/rules/archive/delete/star, drafts/templates/scheduling/undo, deliverability operations, bounce/complaint/suppression, shared mailboxes/aliases, legal hold/eDiscovery, DLP/spam/phishing controls, and mobile/offline push.

## Benchmark references

Official / primary references already tracked in this repo:

- Slack: channels/messages/workflows/lists/canvases/huddles/notifications — <https://slack.com/help/articles/201457107-Send-and-read-messages-in-Slack>, <https://slack.com/help/articles/360035692513-Guide-to-Workflow-Builder>, <https://slack.com/help/articles/360025446073-Guide-to-Slack-notifications>
- Microsoft 365: Teams, Outlook, Planner, Approvals — <https://www.microsoft.com/en-us/microsoft-teams/group-chat-software>, <https://support.microsoft.com/en-us/office/what-is-approvals-a9a01c95-e0bf-4d20-9ada-f7be3fc283d3>, <https://support.microsoft.com/en-us/office/manage-email-messages-by-using-rules-in-outlook-c24f5dea-9465-4df4-ad17-a50704d66c59>
- Google Workspace/Gmail: labels, filters, keyboard-centric productivity, security controls — <https://support.google.com/mail/answer/6579>, <https://support.google.com/mail/answer/7190>, <https://support.google.com/mail/answer/6594>
- Proton Mail: privacy/security-oriented mail UX and labels/folders/filtering — <https://proton.me/mail/features>, <https://proton.me/support/email-inbox-filters>
- SAP Work Zone / Task Center / Process Automation / Fiori — <https://www.sap.com/products/technology-platform/workzone.html>, <https://www.sap.com/products/technology-platform/task-center.html>, <https://www.sap.com/products/technology-platform/process-automation.html>, <https://www.sap.com/products/technology-platform/fiori.html>
- Palantir Foundry/AIP: ontology actions, workflow lineage, approvals, operational coordination — <https://palantir.com/docs/foundry/approvals/overview/>, <https://palantir.com/docs/foundry/workflow-lineage/overview/>, <https://palantir.com/docs/foundry/action-types/overview/>
- Transactional mail operations: AWS SES bounce/complaint enforcement and deliverability guidance — <https://docs.aws.amazon.com/ses/latest/dg/faqs-enforcement.html>, <https://docs.aws.amazon.com/ses/latest/dg/send-email-concepts-deliverability.html>

## Capability matrix

| Area | Best-in-class pattern | Current state | Gap / risk | Next concrete slice |
| --- | --- | --- | --- | --- |
| Messenger unread/read | Thread and app badges update immediately; read actions affect inbox/work hub counts. | This branch adds `unread_count`, Enter-to-send, read-state reducer updates, and Work Hub filters already-read threads. | Needs app-level nav badge and mobile push badge. | Add per-user unread total endpoint + shell/mobile badge. |
| Messenger mentions | `@user` creates addressable notification fanout and linkable identity chips. | This branch renders safe mention text; no persisted mention rows/fanout yet. | Mentions look right but do not notify or resolve identity. | Add `messenger_message_mentions`, resolver, notification routing. |
| Messenger notification fanout | Slack/Teams notify by DM/mention/channel prefs, away status, mobile push/email. | WebSocket realtime only. | Offline recipients miss urgent messages. | Wire messenger events to push/email with notification preferences. |
| Messenger replies/threads | Message replies preserve context without splitting source object. | Thread is conversation-level only. | Long work conversations become hard to scan. | Add parent message id, reply count, and reply affordance. |
| Messenger edit/delete | Edit/delete is soft, auditable, and visibly marked. | No edit/delete endpoint/schema. | Mistakes require follow-up messages; moderation weak. | Add `edited_at`, `deleted_at`, PATCH/DELETE with audit. |
| Messenger presence/typing | Presence/typing is ephemeral and non-audited. | Not present. | Product feels static; no real-time confidence. | Add ephemeral realtime events, no DB retention. |
| Messenger attachments | Files/media/evidence work across DM/group/team/object threads. | Evidence pipeline is work-order oriented. | Non-maintenance team conversations cannot attach mature files. | Generalize evidence/file object linking by source object. |
| Messenger search/export/retention | Search, retention, legal/export policy are admin configurable. | Basic search exists; no admin retention/export UI. | Enterprise compliance gap. | Add retention policy rows + export job for authorized admins. |
| Mail thread actions | Read/unread/star/archive/move/delete are first-class. | This branch adds backend-backed thread read/unread only. | Still missing everyday mail triage. | Add star/archive/move/delete endpoints and UI. |
| Mail compose | Drafts, templates, undo send, schedule send, signatures, attachments. | Send/reply/forward/attachments; this branch adds Ctrl/Cmd+Enter. | No drafts/templates/schedule/undo; accidental loss risk. | Add server-backed drafts + template catalog first. |
| Mail organization | Labels/folders/rules/search operators. | Folders/search/unread filter only. | Poor triage at volume. | Add labels/rules and richer query grammar. |
| Mail deliverability | DKIM/SPF/DMARC, bounce/complaint webhooks, suppression, monitoring, retries. | DKIM/SPF/DMARC foundation documented; no bounce/complaint/suppression queue. | Open signup/business notices can damage reputation. | Add suppression table + event ingest + queued retry sender. |
| Mail shared work | Shared mailboxes, aliases, groups, delegation, audit. | Single org mailbox config. | HR/payroll/support cannot operate with shared queues properly. | Add mailbox identity/alias model and scoped delegation. |
| Mail compliance/security | Legal hold, eDiscovery, DLP, spam/phishing, tracker blocking. | Sanitizes HTML body at render boundary and safe attachment URLs. | Missing enterprise security/compliance controls. | Add tracker image blocking default + audit export/legal hold backlog. |
| Object activity rail | Messages, mail, files, approvals, tasks attach to source object. | Work Hub links sources but no universal rail. | Communications still feel like side apps. | Add activity rail API keyed by ontology object id. |

## Prioritized backlog

### P0: reliability / no-demo foundation

1. **Messenger notification fanout** — persist mention targets, compute unread totals, push/email away users, and honor prefs. Files: `backend/crates/messenger/*`, `backend/crates/platform/realtime`, `backend/app`, `web/src/features/messenger`.
2. **Mail action endpoints** — extend this branch's read-state action with star, archive, move, delete, and undo-safe soft delete. Files: `backend/crates/comms/{application,adapter-postgres,rest}`, `web/src/pages/MailPage.tsx`.
3. **Mail deliverability ops** — suppression table, bounce/complaint ingest, queued retry/dead-letter sender, and metrics. Files: `backend/crates/comms/*` plus platform email/integration surface.
4. **Object activity rail** — one source-object timeline for messenger, mail, evidence, approvals, audit-safe status changes. Files: new backend read model + UI rail components.

### P1: parity / daily ergonomics

5. Messenger replies, edit/delete, reactions, pins/bookmarks.
6. Mail drafts, templates, signatures, schedule send, undo send.
7. Labels/rules/search grammar for mail; advanced search filters for messenger.
8. Shared mailbox/alias/delegation model.

### P2: enterprise governance

9. Configurable retention/legal hold/export for mail and messenger.
10. DLP/spam/phishing/tracker controls.
11. Mobile offline/push badge parity.
12. Analytics over communication-to-workflow latency, unresolved blockers, approval cycle time, and SLA risk.

## Non-negotiable implementation constraints

- Do not add cosmetic buttons without backend state changes and tests.
- Do not duplicate mail/message body content into audit logs.
- Do not log raw PII or mailbox bodies in tests or production logs.
- Sensitive signing-equivalent workflow actions still require passkey step-up; normal read/unread triage does not.
- Communications must attach to ontology/work objects where relevant, not remain maintenance-specific side demos.
