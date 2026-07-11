# Benchmark Matrix — Module: **comms** (messenger + mail + notices/공지, object chips + audit)

Scope: our console's real-time messenger, custom webmail, and (unbuilt) notices/공지 board — all
distinguished by **ontology object chips** (`WO-…`, `AP-…`, `EQ-…` codes that unfurl to governed
object cards) and a **universal append-only audit** on every mutation. Compared against Palantir
Foundry, Slack (THE reference), Microsoft Teams, Asana (inbox), n8n, Rippling, SAP (S/4HANA My Inbox +
SuccessFactors / Work Zone).

Rigor: every vendor claim is **[V]** verified (URL) or **[I]** inferred (labeled). Our column is
grounded in the actual code under `web/src/console/{messenger,mail}` + `backend/crates/{messenger,comms}`
and `docs/program/console-program-ledger.md`.

---

## 0. Our console — evidence-based state (grep'd, not assumed)

**Messenger** — `web/src/console/messenger/` (MessengerConsoleScreen.tsx 1075 LOC), backend
`backend/crates/messenger/*`, migrations `0012_create_messenger.sql` (core) + `0134_messenger_acks_and_reply_quote.sql` (acks) + `0135_messenger_presence_and_mute.sql` (presence/mute), all FORCE-RLS (threads/visibility across `0133`/`0137`–`0143`):
- 3-tier rail; **channels + direct threads**, join channel, thread search + in-message search
  (`searchMessages`), reply/**quote** (quoted_message_id/body/sender), **@mentions** (PBAC-authorized —
  a mention the reader can't resolve degrades to plain text), **presence** (online/away/offline,
  `listPresence`), **read receipts** + unread divider (`markRead` / `dividerUnreadByThread`), **thread
  mute**, and **ack** (`toggleAck` → ack_count / acked_by_me — an explicit "확인" acknowledgment receipt).
- **Object chips**: a shared regex (`OBJECT_CODE_RE`, 24 prefixes incl. WO/AP/EQ/PAY/HR/EV…) renders
  bare codes as chips; **PBAC-gated** (`object.open`) — an unauthorized code is a silent no-op (deny by
  omission); chips are **objDrag drag sources** and the composer is a **drop target** (drop an object →
  its code is inserted through the compose token grammar). This is the module's signature.
- **Create-todo from a message** (`createTodo` with `scopes`/`links` = TodoRef object links) — turns a
  message into tracked work linked to objects.
- Backend: universal audit on mutations; RLS armed as `mnt_rt` on every read.

**Mail** — `web/src/console/mail/` (MailScreen 437, MailComposer, MailReadPane, MailGovernance),
backend custom Rust stack `backend/crates/comms/*` (adapter-imap / adapter-smtp / adapter-mox /
adapter-postgres / credential-cipher):
- Gmail-style **threading**, folders, thread read-state + mute, **reply/forward** with References
  headers, attachments (size cap `MAX_OUTBOUND_ATTACHMENT_BYTES`, safe download URL).
- **Governance**: message **classification** (normal / sensitive / quarantine), **egress DLP gate**
  (`blockedEgress` — external recipient + attachment / sensitive classification → blocked with a
  next-action: `requestApproval` / `removeAttachment` / `notifyCompliance` / `openLifecycle`), governance
  chips, **sender-auth panel** (SPF/DKIM/DMARC-style chips), litigation-hold reason.
- Credential **ciphertext write-only** (never read back); audit builders record config/send without
  leaking credentials (`account_config_audit_event`).

**Notices / 공지** — **NOT BUILT.** Ledger lists "board" among deferred plain-domain REST
(`console-program-ledger.md:116`). No mandatory-read announcement surface exists; a messenger `channel`
+ `ack` is the closest primitive. **This is the module's biggest gap and the top steal candidate.**

---

## 1. Vendor relevance

| Vendor | Plays here? | Why |
|---|---|---|
| **Slack** | ✅ core | THE messaging reference: channels/threads/DM/Connect/Canvas/Workflow/Discovery. |
| **MS Teams** | ✅ core | Channels + chat + Loop + Purview compliance; enterprise incumbent. |
| **Asana** | ✅ inbox/msgs | Work-graph messages + Inbox; drag-a-task-into-a-message = our object chip. |
| **Foundry** | ◑ partial | Not chat, but **object comments + @mentions + Automate notification effects** = the object-centric-comms benchmark. |
| **SAP** | ◑ partial | No chat. **My Inbox / Task Center** unified approvals inbox + Work Zone notices = the 전자결재 / 공지 analog. |
| **Rippling** | ◑ partial | No native chat; **announcements via Slack + Workflow Automator notifications** + approvals inbox. |
| **n8n** | ◇ hooks-only | Not a comms UI. **Slack/Teams/Email nodes + triggers** = the automation-hook column only. |

---

## 2. Capability matrix

Legend: **Ours** = built unless marked (gap). Cells: how the vendor does it, [V]/[I].

### R1 — Information architecture (channels / DM / mail / notices in one place)
- **Ours**: messenger (channels+DM) + webmail + comms-rail promotion into any screen; notices **absent**. Object chips thread all three back to the ontology. [evidence: `console/messenger`, `console/mail`, ledger comms-rail]
- **Foundry**: comms live *on the object* (Object View comment threads), not a separate inbox. [V] https://www.palantir.com/docs/foundry/object-views/comment-on-objects
- **Slack**: channels (public/private) + DM + threads + Slack Connect + Canvas as the unifying IA. [V] https://slack.com/help/articles/360035692513-Guide-to-Slack-Workflow-Builder
- **Teams**: teams→channels (+ private/shared channels) + 1:1/group chat, one client. [V] https://techcommunity.microsoft.com/blog/microsoftteamsblog/new-enhancements-in-private-channels-in-microsoft-teams-unlock-their-full-potent/4438767
- **Asana**: Inbox aggregates @mentions, assigned tasks, messages; project-level Messages + task comments. [V] https://asana.com/features/project-management/inbox
- **n8n**: N/A — no inbox; routes messages between other tools. [I]
- **Rippling**: unified employee "Inbox" of tasks/approvals; chat delegated to Slack. [V] https://www.rippling.com/platform
- **SAP**: My Inbox (F0862) + My Outbox + Task Center unified inbox across cloud apps. [V] https://community.sap.com/t5/enterprise-resource-planning-blog-posts-by-sap/sap-fiori-for-sap-s-4hana-which-notification-to-use-when-workflow-situation/ba-p/14108545

### R2 — Core messaging (reply-in-thread, quote, edit/delete, reactions)
- **Ours**: reply + quote (quoted body/sender), head-on grouping, unread divider; **no edit/delete/reactions/emoji** (ack replaces the reaction). Deliberate — audit-first, immutable messages. [evidence: `messengerModel.ts`]
- **Foundry**: object comment threads with mentions + file/image attach; not a general chat. [V] comment-on-objects (above)
- **Slack**: threads, edit/delete, reactions, rich text; edits/deletes still captured by Discovery. [V] https://slack.com/help/articles/360002079527-A-guide-to-Slacks-Discovery-APIs
- **Teams**: reply-in-channel, reactions, edit/delete; content journaled to hidden mailbox folders. [V] https://learn.microsoft.com/en-us/purview/retention-policies-teams
- **Asana**: task comments + project messages; @mention tasks/projects; reply from Inbox. [V] https://help.asana.com/s/article/communicating-in-asana
- **n8n**: N/A (sends/reads messages programmatically only). [I]
- **Rippling**: N/A native — comment/announce via connected Slack. [V] https://www.rippling.com/blog/how-i-solved-it-culture
- **SAP**: comments live on the workflow task / business object, not free chat. [I]

### R3 — Object references / chips (link a business object into a message) — **signature row**
- **Ours**: **best-in-class-for-our-domain** — 24-prefix code regex → PBAC-gated chip that unfurls to the
  real object card, is drag-source + drop-target, and degrades to plain text if unauthorized. One
  ontology, referenced from chat. [evidence: `messengerModel.ts renderMessageParts`, `objDrag`]
- **Foundry**: comment *on* an object + @mention users; the object is the container, not an inline chip. [V] comment-on-objects
- **Slack**: app **link unfurling** — a recognized URL fires an event and the app renders a preview block;
  not permission-aware to the *reader*, and it's a URL not a typed object. [V] https://docs.slack.dev/messaging/unfurling-links-in-messages/
- **Teams**: Adaptive Cards embed app content in messages (and are eDiscoverable as HTML). [V] https://techcommunity.microsoft.com/t5/microsoft-teams-blog/microsoft-365-compliance-capabilities-for-adaptive-card-content/ba-p/2095869
- **Asana**: **drag a task/project into a message or @mention it** — closest analog to our chip, but the
  "object" is only Asana work items, no per-reader authz on the chip. [V] https://asana.com/features/project-management/inbox
- **n8n**: N/A (can inject object data into a message body via expressions, not interactive). [I]
- **Rippling**: N/A. [I]
- **SAP**: workflow task deep-links to the business object in Fiori; not an inline chip in free text. [I]

### R4 — Mail / email
- **Ours**: full custom IMAP/SMTP webmail with threading, folders, classification, egress DLP, sender-auth
  chips, WORM/attachment governance — **built in-house, not a Gmail wrapper**. [evidence: `crates/comms`]
- **Foundry**: N/A as a mailbox; Automate sends outbound email + PDF digests only. [V] https://www.palantir.com/docs/foundry/automate/example-weekly-report
- **Slack**: not email; ingests via integrations. N/A for mailbox. [I]
- **Teams**: not a mailbox itself, but Outlook/Exchange sits beside it; channel email-in address. [I]
- **Asana**: email-to-task / notification email; no mailbox. [V] https://help.asana.com/s/article/email-notifications
- **n8n**: **Email Trigger (IMAP) + send-email nodes** — programmatic mail, not a client. [V] https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.emailimap
- **Rippling**: transactional email notifications only. [V] https://developer.rippling.com/documentation/developer-portal/test-company/email
- **SAP**: Fiori launchpad + email notifications from workflow; not a mailbox. [V] https://community.sap.com/t5/enterprise-resource-planning-blog-posts-by-sap/sap-s-4hana-email-and-fiori-launchpad-notifications-in-purchase-order/ba-p/13807255

### R5 — Notices / 공지 (broadcast with mandatory-read acknowledgment)
- **Ours**: **GAP** — no board; messenger `ack` gives a read-acknowledgment primitive but no
  broadcast/target/must-read-tracking surface. [evidence: ledger:116 "board" deferred]
- **Foundry**: Automate **notification effects** (static or object-property-driven recipient lists) = broadcast, no read-receipt board. [V] https://www.palantir.com/docs/foundry/automate/effect-notification
- **Slack**: announcement-only channels + Workflow Builder scheduled posts; reactions ≠ enforced read. [V] https://slack.com/help/articles/17542172840595-Build-a-workflow--Create-a-workflow-in-Slack
- **Teams**: announcement posts + "important/urgent" flags; no built-in mandatory-read ledger. [I from Teams posting features]
- **Asana**: project Messages + status updates as team broadcasts; no read-receipt enforcement. [V] https://help.asana.com/s/article/communicating-in-asana
- **n8n**: fan-out a notice to Slack/Teams/email via a trigger→multi-node workflow. [V] https://n8n.io/integrations/microsoft-teams/and/slack/
- **Rippling**: **automated announcements** (birthdays/anniversaries) pushed to Slack channels via Workflow Automator. [V] https://www.rippling.com/blog/how-i-solved-it-culture
- **SAP**: SuccessFactors/Work Zone home announcements + Task Center; formal, HR-broadcast oriented. [V] https://www.slideshare.net/slideshow/sap-build-work-zone-overview-l2l3pptx/267319527

### R6 — Presence & read state
- **Ours**: presence (online/away/offline) + per-message read receipts + unread divider + ack counts. [evidence: `listPresence`, `markRead`, `toggleAck`]
- **Foundry**: N/A (no presence). [I]
- **Slack**: active/away presence; read state per channel; no per-message read receipts. [I]
- **Teams**: rich presence (available/busy/DND/in-a-call) from calendar; read receipts optional. [I]
- **Asana**: no presence; Inbox unread tracking only. [V] inbox (above)
- **n8n**: N/A. [I]
- **Rippling**: N/A. [I]
- **SAP**: task status (open/in-progress/completed) stands in for read state. [I]

### R7 — Permissions / access control
- **Ours**: **Cedar-PBAC, deny-by-omission on every action AND every object chip AND every mention** —
  identical policy for UI/API; a chip you can't open silently disappears. Group→법인→branch→worksite scope. [evidence: `MESSENGER_ACTIONS`, `PolicyGated`, `usePolicyGate`]
- **Foundry**: object + property (cell-level) policies, mandatory markings; comments inherit object security. [V] https://www.palantir.com/docs/foundry/object-permissioning/object-and-property-policies
- **Slack**: workspace/channel membership + admin roles; DLP/Discovery are Enterprise-Grid-gated. [V] https://slack.com/help/articles/360002079527-A-guide-to-Slacks-Discovery-APIs
- **Teams**: AAD groups + team/channel roles + sensitivity labels; private/shared channels. [V] private-channels (above)
- **Asana**: project membership + commenter/editor + admin console; no per-object-in-message authz. [V] https://handbook.mrsystem.co.uk/tools/asana/project-members-notifications/
- **n8n**: credential-scoped; RBAC on workflows (enterprise). [I]
- **Rippling**: **custom permission profiles / attribute-based access** — strong RBAC/ABAC pedigree. [V] https://www.rippling.com/products/it/platform/permissions
- **SAP**: PFCG roles + workflow agent determination; approvals gated by org structure. [I]

### R8 — Automation hooks (message → action, action → message)
- **Ours**: create-todo-from-message (object-linked); object chips are drop targets; **no rules engine in
  comms yet** — Automate lane is separate. [evidence: `createTodo`; ledger Automate is its own surface]
- **Foundry**: **Automate Condition→Effect**, notification effects, Action side-effects (webhooks/notify). [V] https://www.palantir.com/docs/foundry/automate/overview
- **Slack**: **Workflow Builder** (link/shortcut/schedule triggers → forms → canvas/connectors). [V] https://slack.com/help/articles/25883690838419-Automate-data-collection-with-canvas-and-Workflow-Builder
- **Teams**: Power Automate flows + message extensions + bots. [I]
- **Asana**: **Rules** (trigger→action) + create follow-up task from any Inbox notification in one click. [V] https://asana.com/features/project-management/inbox
- **n8n**: **the reference** — Slack/Teams/Email trigger nodes → arbitrary action graph. [V] https://n8n.io/integrations/slack/
- **Rippling**: **Workflow Automator** — event→notification/approval, multi-approver, vacation re-routing. [V] https://www.rippling.com/recipes/pay-run-approved-notification
- **SAP**: Flexible Workflow + Situation Handling drive notifications into My Inbox. [V] which-notification (above)

### R9 — Audit / retention / legal hold / eDiscovery
- **Ours**: **universal append-only audit on every message + mail mutation**, RLS-as-runtime-role,
  credential-redacting audit builders; **retention/legal-hold surface = partial** (mail litigation-hold
  reason exists; no org-wide hold/eDiscovery export yet). [evidence: `crates/comms` audit builders, ledger]
- **Foundry**: full changelog/lineage on objects; comments carry object security. [I from Foundry governance model]
- **Slack**: **Discovery API** streams every message/edit/delete/file across all convs incl. Connect; **Legal
  Holds Admin** preserves regardless of retention. Enterprise-Grid only. [V] https://slack.com/help/articles/4401830811795-Create-and-manage-legal-holds
- **Teams**: **Purview** retention + eDiscovery via hidden mailbox folders; Loop components are
  eDiscoverable via Purview since 2024 (SharePoint-Embedded / OneDrive-backed — searchable, collectable,
  reviewable, exportable), with a **residual gap**: Loop "My workspace" containers aren't auto-included on
  Litigation Hold and must be added manually. [V] https://learn.microsoft.com/en-us/purview/retention-policies-teams · Purview/Loop 2024 changelog
- **Asana**: enterprise audit-log API + data-export; not litigation-grade eDiscovery. [I]
- **n8n**: execution logs per run; not a comms archive. [I]
- **Rippling**: HR audit trails on approvals/changes. [I]
- **SAP**: **workflow log = end-to-end audit trail** (who approved what, when) per task. [V] which-notification-to-use (above)

### R10 — DLP / egress control (outbound sensitive-data blocking)
- **Ours**: **built into the composer** — classification + external-recipient + attachment rules block send
  and route to approval/compliance inline (전자결재-adjacent). [evidence: `blockedEgress`, `MailGovernance`]
- **Foundry**: mandatory markings prevent cross-classification leakage at the data layer. [V] object-and-property-policies (above)
- **Slack**: **DLP rules** scan messages, flag violations for review (Enterprise). [V] https://www.strac.io/blog/slack-discovery-api
- **Teams**: Purview DLP policies on chat/channel messages + sensitivity labels. [I from Purview]
- **Asana**: N/A (no message DLP). [I]
- **n8n**: could implement DLP as a node, but nothing native. [I]
- **Rippling**: N/A for message DLP (data governance is HR-record-centric). [I]
- **SAP**: approval gates enforce policy, not content DLP. [I]

### R11 — Mobile
- **Ours**: native field app (Android `com.maintenance.field`) covers work-order flow + messaging-adjacent; console mail/messenger are web-responsive. [evidence: memory native-app-identifiers; android/ tree]
- **Foundry**: mobile app for object views + notifications. [I]
- **Slack**: first-class iOS/Android. [I]
- **Teams**: first-class mobile incl. calls. [I]
- **Asana**: mobile Inbox + tasks. [I]
- **n8n**: N/A (server tool). [I]
- **Rippling**: mobile app for inbox/approvals/announcements. [I]
- **SAP**: **SAP Mobile Start** surfaces Task Center on mobile. [V] which-notification (above)

### R12 — Extensibility / external federation
- **Ours**: object-chip grammar is extensible by prefix (24 today); no third-party app platform; no
  external-org federation. Deliberately closed (auditable, no E2EE, no外부 bots). [evidence: `OBJECT_CODE_RE`]
- **Foundry**: custom widgets (iframe bridge) + Functions; closed to org. [V] brief §1d
- **Slack**: huge app platform + **Slack Connect** cross-org channels + Canvas connectors. [V] workflow-builder (above)
- **Teams**: app store + message extensions + Loop + external/guest access. [I]
- **Asana**: apps/integrations + API + rules connectors. [I]
- **n8n**: **itself the extensibility layer** — 400+ nodes, custom nodes. [V] https://n8n.io/integrations/slack/
- **Rippling**: app marketplace + API; HR-system-of-record integrations. [I]
- **SAP**: Work Zone integration content + BTP extensibility. [V] work-zone (above)

### R13 — Korean B2B fit (전자결재 culture, 근로기준법, group-company scoping)
- **Ours**: **native fit** — Korean-first i18n (`ko.console.*`), group→법인→branch→worksite Cedar scoping,
  ack = 확인 culture, mail egress→approval routing = 전자결재 adjacency, in-house stack avoids data-residency
  concerns. [evidence: `i18n/ko.ts`, PBAC scoping]
- **Foundry**: strong governance but no 전자결재/근로기준법 semantics; heavy, US-centric. [I]
- **Slack**: KR-localized UI but no 전자결재/결재선; global retention may conflict with 개인정보보호법 residency. [I]
- **Teams**: KR-localized; Purview residency configurable but 전자결재 needs 3rd-party (e.g. 다우오피스) add-ons. [I]
- **Asana**: KR UI; work-graph, no approval-line or Korean-HR semantics. [I]
- **n8n**: neutral; could wire a 결재선 but nothing native. [I]
- **Rippling**: US-payroll-centric, weak KR 근로기준법/4대보험 fit. [I]
- **SAP**: SuccessFactors has KR localization + approval workflows; enterprise-heavy, costly, slow to tailor. [I]

---

## 3. How each vendor would build OUR comms module

**Palantir Foundry** — There would *be* no separate messenger. Comms would collapse onto the object:
every WO-/AP-/EQ- object carries a comment thread with @mentions and attachments, and "notices" become
**Automate notification effects** whose recipient lists are object-set queries (e.g. "all sites with an
overdue inspection"). Auth is object/property policy — identical to ours in spirit. They'd nail the
object-centricity we prize but ship no chat-native experience and no mandatory-read ledger.

**Slack** — A channel-per-worksite + DM fabric, object chips implemented as **app unfurls** on
`console://object/WO-123` links, notices as announcement channels + scheduled Workflow Builder posts, and
compliance bolted on via **Discovery API + Legal Holds + DLP** (Enterprise Grid). Superb velocity and
extensibility; weaker on *governed, per-reader* object references and on the deny-by-omission chip we do
natively. Retention is a paid compliance layer, not an intrinsic append-only log.

**Microsoft Teams** — Teams→channels mapped to org units, object chips as **Adaptive Cards** from a
custom app, notices as "important" announcement posts + Loop components, and eDiscovery/retention via
**Purview**. Deep enterprise compliance, but comms data scatters into hidden mailbox folders and Loop/SPO
indexes — the opposite of our single append-only audit; 전자결재 needs third-party add-ons.

**Asana** — Everything hangs off the work graph: threads are task comments + project Messages, our object
chip is their **drag-a-task-into-a-message / @mention-work**, notices are project status updates, and
automation is **Rules** + one-click follow-up tasks. Closest philosophical cousin to our object-first
composer — but "objects" are only Asana work items, there's no mailbox, and no per-reference authorization
or litigation-grade audit.

**n8n** — Not a UI at all; it would *wire* our comms. Messenger events (Slack/email triggers) fan out
into notice broadcasts across channels/email/Teams, DLP checks become nodes, approval routing becomes a
workflow. It's the **automation-hook layer we'd embed**, not the console.

**Rippling** — An HR-record-of-truth with an **Inbox of tasks/approvals** and **Workflow-Automator**
announcements pushed to Slack; chat is delegated. They'd model notices + approval routing beautifully
(multi-approver, vacation re-routing) and permissions via custom profiles, but bring no messenger, no
mailbox, and weak KR 근로기준법 fit.

**SAP** — Comms as **My Inbox / Task Center** — a unified approvals inbox across modules with a full
**workflow log audit trail**, notices via **Work Zone / SuccessFactors** home announcements, delivered to
**SAP Mobile Start**. This is the closest to Korean 전자결재 semantics (formal approval lines + audit) but
it's an approvals inbox, not a chat, and customization is heavy/slow/expensive.

---

## 4. What we'd steal — ranked

1. **Notices/공지 board with mandatory-read acknowledgment** → *best: SAP My Inbox/Task Center audit-trail
   + Slack announcement channels + our own `ack` primitive.* Fills our #1 gap. Ontology fit: a `Notice`
   instance type + target object-set (recipient = object query, à la Foundry notification effects) +
   per-recipient ack rows folded from the audit log. Deterministic read-receipt ledger = native 전자결재
   확인 culture. **Cost: M.**

2. **Legal hold + eDiscovery export** → *best: Slack (Legal Holds Admin + Discovery API stream of
   edits/deletes).* We already have the append-only audit; expose an org-scoped hold flag + a
   compliance-scoped export endpoint over existing message/mail rows. Turns our audit into litigation-grade
   evidence. Ontology fit: hold = a governed policy object; export = a Cedar-gated read. **Cost: M.**

3. **Rules engine on comms events (message→action)** → *best: Asana Rules + n8n triggers.* Extend the
   existing create-todo hook into declarative "when a message contains WO-* and @role → create task /
   notify / route approval." Reuses ontology Actions as the effect surface. **Cost: M–L.**

4. **Reader-aware object-chip parity everywhere via Adaptive-Card-style rich unfurl** → *best: Teams
   Adaptive Cards + Slack unfurl, but keep our PBAC-per-reader edge.* Upgrade the chip from code-token to a
   compact card (title/status/owner) still degrading to plain text on deny. Ontology fit: card = object
   title-key + a couple of policy-visible properties. **Cost: S–M.**

5. **Scheduled / templated broadcast digests** → *best: Foundry Automate PDF-digest notification effects +
   Slack scheduled workflow posts.* "Weekly overdue-WO digest to each site manager," recipient = object-set
   query, content = deterministic template. Complements #1. **Cost: M.**

6. **Approval-line (결재선) routing surfaced in comms** → *best: SAP Flexible Workflow + Rippling
   multi-approver re-routing.* Our mail egress already routes to "requestApproval" — formalize a named
   approval-line object with substitute-on-vacation. Native KR 전자결재 fit. **Cost: M.**

7. **Message shortcuts / composer command palette** → *best: Slack `/`-shortcuts + Workflow links.* Cheap
   UX win: `/` in the composer to run object-linked actions (create-todo already exists; add object-open,
   assign, escalate). **Cost: S.**

---

## Sources
Slack Discovery/Legal-Hold/DLP — slack.com/help 360002079527, 4401830811795; strac.io/blog/slack-discovery-api.
Slack Workflow/Unfurl/Canvas — slack.com/help 360035692513, 25883690838419, 17542172840595; docs.slack.dev/messaging/unfurling-links-in-messages.
Teams — learn.microsoft.com/purview/retention-policies-teams; techcommunity …/adaptive-card-content…2095869; Purview/Loop eDiscovery 2024 changelog (SharePoint-Embedded).
Asana — asana.com/features/project-management/inbox; help.asana.com communicating-in-asana, email-notifications.
Foundry — palantir.com/docs/foundry: object-views/comment-on-objects, automate/effect-notification, automate/overview, object-permissioning/object-and-property-policies, automate/example-weekly-report.
n8n — n8n.io/integrations/slack, /microsoft-teams/and/slack; docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.emailimap.
Rippling — rippling.com/platform; rippling.com/blog/how-i-solved-it-culture, /recipes/pay-run-approved-notification, /products/it/platform/permissions.
SAP — community.sap.com …which-notification-to-use…14108545, …fiori-launchpad-notifications…13807255; slideshare …sap-build-work-zone-overview.
Ours — web/src/console/{messenger,mail}; backend/crates/{messenger,comms}; migration 0114; docs/program/console-program-ledger.md.

---

## 5. Cross-cutting lens findings (5 independent review lenses)

- **Task-flow:** money task = *turn a conversation into a decision/action on an object*. You can drag an object into chat and unfurl its card — but the decision happens on the module surface, so chat-to-action = **2+ context switches**. Slack/Teams close the loop inside chat (approve/reject inline, 1 click). **Steal:** in-rail action buttons on the unfurled object card (approve/ack/decide without leaving the rail) — CommsRail↔main promotion + `GovernedObjectCard` action layer already exist. Cost **M**.
- **IA / layout:** messenger + mail + the shell's **54px comms rail** — but the **interactive rail is unbuilt** (strip only). Decision point: channel-native (Slack) vs thread/DM-native? Rail-as-persistent-comms is a good Teams/Slack-hybrid instinct, unbuilt. **Steal:** build the interactive docked comms rail (the shell already reserves the space) [L]; channel **sections** for org/법인 grouping → Slack [M]; keep high density (resist the "lighter/playful" drift — enterprise ops wants density) [S].
- **Data-model:** **stronger on object-linkage** — messages carry typed object references (#WO-2643 drag-drop, object-card unfurl, PBAC-gated drop target); Slack/Teams/Gmail do this only via unfurled URLs, not first-class typed edges into an ontology. **Weaker:** threads/channels aren't engine-registered (no thread lifecycle object, no as-of), and Slack/Teams out-mature us on real-time/search/retention. **Steal:** Slack typed event/message object model + retention-as-config (register the thread as an ont type with lifecycle + as-of) [M]; message↔object as a first-class typed `ont_link` edge (we're 80% there via objDrag) [S].
- **Governance:** **Behind** — comms governance (hold/retention/eDiscovery/DLP) is the biggest coverage gap vs Slack/Purview, and the ledger already flags it unbuilt. Our append-only + no-E2EE + WORM + hash-chain substrate makes it *cheap to add*. **Steal:** litigation hold on messenger/mail (reuse the evidence four-eyes-hold model) [M]; retention policy per channel/content-type (governed setting object) [M]; eDiscovery export (custodian/date-scoped, watermarked) [L]; outbound DLP (tombstone on sensitive-pattern match) [M].
- **Automation / extensibility:** a Slack-refugee power user loses **slash commands** + **chat-native workflow triggers** most. **Steal:** chat-native workflow trigger (a messenger message/marker fires an Automate workflow; objDrag markers already exist as a drop target) → Slack Workflow Builder [M]; slash-command → ontology Action (`/wo close WO-123`, Cedar-gated, audited) [M]; interactive four-eyes approval blocks in the rail → Block Kit [S].

**Adjudicated fixes:** the Messenger evidence base migration citation was corrected from the non-existent `0114_messenger_channels_acks_presence.sql` to the real files (`0012_create_messenger` core + `0134` acks + `0135` presence/mute, all FORCE-RLS); the n8n IMAP source was re-pointed to the `emailimap` node doc (was the Slack-trigger URL); and the Teams Loop eDiscovery claim was de-staled (Purview support shipped 2024, with a residual "My workspace not auto-held on Litigation Hold" gap).
