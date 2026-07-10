# Mail screen reusable component plan

Kanban: `t_4c921600`

## Executive finding

The current checkout does not contain `docs/design/oyatie-console/Oyatie Console.dc.html` — `docs/design/oyatie-console/` currently has `Oyatie Mobile.dc.html` but no desktop console HTML mirror. The extracted source `.omc/research/oyatie/prototype-anatomy/02-screens/mail.md` already records the same issue: the saved desktop mirror predates the post-snapshot `screen:"mail"` full view, so the full mail screen must be implemented from the changelog/spec sources, not by eyeballing a present dc.html region.

Build the mail slice as a new carbon-copy console surface under `web/src/console/mail/**`. Do not reuse `web/src/pages/MailPage.tsx` JSX, shadcn components, Tailwind classes, or legacy explanatory copy. Reuse only the proven data flow concepts and typed API calls from the legacy page: folders, threads, read-state, sanitized HTML bodies, send/reply/forward, attachment download, and keyboard submit.

The basic mail backend exists today (`/api/v1/mail/folders`, `/threads`, `/threads/{id}`, `/threads/{id}/read-state`, `/messages/{id}`, `/attachments/{id}/download`, `/send`, `/reply`, `/forward`). The prototype-required governance layer is still a backend gap: sender-auth results, classification, retention, litigation hold, egress/DLP evaluation, ingest/evidence registration, and object-link side effects must not be fabricated in the UI.

## Sources inspected

- `docs/design/oyatie-console/AGENTS.md` lines 13-15, 17-29, 42-50, 59-71, 113-115, 121: post-snapshot mail, mox, egress, ingest, message-linking, threading, and no-explanatory-UI directives.
- `.omc/plans/carbon-copy-charter.md` lines 40-65, 72-88, 107-128: carbon-copy surface strategy, no Tailwind/shadcn, reusable grammar, fidelity gate, backend wiring, P2 comms order.
- `.omc/research/oyatie/prototype-anatomy/02-screens/mail.md`: verified pre-full-view mail rail/modal/pin anatomy and post-snapshot full-view contract.
- `.omc/research/oyatie/prototype-anatomy/03-systems.md` sections 1, 2, 5, 7, 10, 12, 13: window/list grammar, audit backbone, lifecycle sync, current token grammar directive, egress gate.
- `.omc/research/oyatie/prototype-anatomy/04-backend-contract.md` lines 152-166 and gap register lines 235-239, 271-273: available mail endpoints and BE-MAIL-GOV gap.
- `.omc/research/oyatie/prototype-anatomy/02-screens/ingest.md` lines 22-28, 30-43, 53-68, 76-78: attachment-to-ingest DX- contract.
- `web/src/console/tokens.css`: available `.console` token set.
- `web/src/console/components/StatusChip.tsx`: reusable tokenized status chip.
- `web/src/console/policy/PolicyGated.tsx`: deny-by-omission policy wrapper.
- `web/src/pages/MailPage.tsx`: legacy typed API flow only; visual implementation must be rebuilt.
- `web/src/i18n/ko.ts` `mailbox` block: existing Korean mail labels to mine, but console-specific keys should live under `ko.console.mail`.
- `backend/openapi/openapi.yaml` mail paths and `Mail*` schemas.

## Target files

Create a focused console mail component family:

1. `web/src/console/mail/types.ts`
   - Console-facing view models and governance extension types.
   - Keep API schemas imported from `web/src/api/types.ts` where they exist.
   - Add only UI-local derived fields, not mock backend truth.

2. `web/src/console/mail/mailScreenConfig.ts`
   - Single config object for folders, thread-row chips, message actions, governance chips, sender-auth chips, attachment actions, and policy actions.
   - The same config must drive full screen, right-rail summary, and mobile/stacked variants when those mount.

3. `web/src/console/mail/api.ts`
   - Thin typed API helpers: list folders, list threads, get thread, set read state, send, reply, forward, attachment download.
   - Future hooks for `evaluateMailEgress`, `ingestMailAttachment`, `registerMailEvidence`, and `getMailGovernance` should be typed but disabled behind backend feature detection until BE-MAIL-GOV/BE-INGEST/BE-DOCS exist.

4. `web/src/console/mail/MailScreen.tsx`
   - Orchestrates state and renders one single-surface 3-pane screen.
   - Imports `../tokens.css`, uses root className `"console"` only, and tokenized inline styles.

5. `web/src/console/mail/MailFolderPane.tsx`
   - Folder nav and unread totals.

6. `web/src/console/mail/MailThreadList.tsx`
   - Search, unread filter, J/K/Enter list grammar, conversation-count chip, attachment indicator, unread dot, selected row state.

7. `web/src/console/mail/MailReadPane.tsx`
   - Thread header, sender-auth panel, governance chip row, collapsed prior-message rows, current message body, attachment rows, reply/forward actions.

8. `web/src/console/mail/MailComposer.tsx`
   - Shared composer for `new`, `reply`, and `forward` modes.
   - Owns recipients, subject, body, threading headers, classification picker, object/file attachments, and egress result state.

9. `web/src/console/mail/MailGovernance.tsx`
   - `SenderAuthPanel`, `GovernanceChipRow`, `EgressGatePanel`, and tone helpers.

10. `web/src/console/mail/MailAttachmentRows.tsx`
    - Shared attachment display for read pane and composer attachment chips.
    - Primary attachment CTA is ingest (`DX-`) once backend exists; evidence registration is secondary.

11. `web/src/console/mail/MailScreen.test.tsx`
    - Component tests for pane layout, keyboard list behavior, send/reply/forward payloads, sanitized body rendering, policy deny-by-omission, egress block, and attachment CTAs.

12. `web/src/i18n/ko.ts`
    - Add `ko.console.mail` keys. Do not hardcode Korean in TSX.

Wire into shell/window registry only after the screen component passes console purity and UI string checks. If `web/src/console/shell/nav.ts` exists on the implementation branch, register `screen: "mail"` there; otherwise register through the current console screen host/route surface.

## Data contracts

### Existing backend fields to use now

- `MailFolderView`: `id`, `role`, `name`, `unread_count`, `total_count`.
- `MailThreadView`: `id`, `subject`, `last_message_at`, `message_count`, `unread_count`, `has_attachments`, `is_flagged`.
- `MailThreadDetail`: `id`, `subject`, `messages[]`.
- `MailMessageView`: `id`, `thread_id`, `direction`, `message_id`, `in_reply_to`, `from_address`, `from_name`, `to`, `cc`, `subject`, `snippet`, `body_text`, `body_html`, `seen`, `flagged`, `answered`, `has_attachments`, `received_at`, `attachments[]`.
- `MailAttachmentView`: `id`, `filename`, `content_type`, `size_bytes`, `is_inline`.
- `SendMailRequest`: `to`, `cc`, `bcc`, `subject`, `body_text`, `attachments`, `in_reply_to`, `references`.

### Required governance fields from BE-MAIL-GOV

Add these to backend/OpenAPI before rendering real governance state:

- Sender auth per message or thread:
  - `spf: "pass" | "fail" | "neutral" | "unknown"`
  - `dkim: "pass" | "fail" | "neutral" | "unknown"`
  - `dmarc: "pass" | "fail" | "neutral" | "unknown"`
  - `tls: "verified" | "opportunistic" | "none" | "unknown"`
  - `storage_encryption: "encrypted" | "unknown"`
- Governance per thread/message:
  - `classification: "normal" | "confidential" | "sensitive" | "quarantine"`
  - `retention_label`, `retention_until`, `retention_state`
  - `litigation_hold: boolean`
  - `pbac_decision: "allowed" | "omitted" | "step_up_required"`
  - `object_refs[]` for linked `CS-`, `AP-`, `WO-`, `DX-`, `EV-`, `C-`, etc.
- Attachment governance:
  - `ingest_job_id` / `ingest_code` when already promoted to DX-.
  - `evidence_record_id` / `evidence_code` when already registered as evidence/records.
  - `lifecycle_status` for egress eligibility.
- Egress evaluation:
  - `allowed: boolean`
  - `reasons[]` from a stable enum such as `external_recipient`, `unapproved_attachment`, `sensitive_classification`, `litigation_hold`, `retention_lock`, `policy_denied`.
  - `required_action` such as `open_lifecycle`, `remove_attachment`, `request_approval`, `notify_compliance`.

If any governance field is unavailable, omit the matching chip/affordance or show a data-loading/error state for the whole governed action. Do not fabricate pass/fail security chips or lifecycle statuses.

## Reusable component shapes

### 1. `MailSurfaceLayout`

One single card surface with internal separators, not three floating cards. Desktop grid:

- folder pane: 220-280px
- thread pane: 320-420px
- read pane: `minmax(520px, 1fr)`
- separators: `1px solid var(--border-soft)`
- root background: `var(--canvas)`
- card background: `var(--surface)`
- no gaps between folder/list/read regions inside the card

Responsive behavior:

- At narrower widths, stack as folder chips → thread list → read pane.
- Preserve one selected-thread state across layouts.
- Use the same `MailSurfaceLayout` for the full screen and future mobile/rail host; do not draw a separate mail layout twice.

### 2. `MailFolderPane`

Config-driven folder rows:

- role-based label from `folderRoles` config (`INBOX`, `SENT`, `DRAFTS`, `ARCHIVE`, `TRASH`, `JUNK`, `CUSTOM`).
- unread/total shown as mono numbers.
- active folder uses an accent/ink border, not a new button style.
- `ALL` is a virtual folder, not a backend id.
- No explanatory mailbox setup prose inside the carbon-copy screen; readiness failures are compact status rows/actions.

### 3. `MailThreadList`

Shared list grammar:

- search input + unread-only segment in the list header.
- rows are buttons/listitems with J/K selection and Enter open.
- unread dot + strong subject for unread.
- right-aligned mono timestamp.
- chips: conversation count, unread count, attachment, flagged, spam/quarantine when real.
- Gmail-style threading: group by backend thread id; if backend later provides subject-normalized conversation ids, keep grouping in the data adapter, not in row JSX.
- Row chips come from `mailScreenConfig.threadChips(thread)` so the same chip shape can be used in rail/mobile list variants.

### 4. `MailReadPane`

Header:

- subject or `제목 없음`.
- compact sender/from line, recipient line, mono timestamp.
- `SenderAuthPanel` and `GovernanceChipRow` immediately below subject metadata.
- thread actions: read/unread, reply, forward; each action policy-gated.

Body:

- messages oldest-first, but collapse prior messages by default when there is more than one message.
- collapsed rows show sender, timestamp, short snippet, and conversation index; click expands.
- current/latest message body renders sanitized `body_html` or text fallback.
- Body text must run through the shared message-part renderer for bare object-code auto-linking (`WO-`, `AP-`, `CS-`, `DX-`, `EV-`, `C-`, etc.). Do not restore old `#` object linking or `!CODE` triggers.
- Attachments render through `MailAttachmentRows`, not ad-hoc buttons.

### 5. `MailComposer`

One component for all modes:

- `mode: "new" | "reply" | "forward"`.
- Reply sets `to` from the current inbound sender or outbound recipient, `subject` with `Re:`, `in_reply_to`, and accumulated `references`.
- Forward sets `subject` with `Fwd:` and includes a compact original-message block in body only if the backend does not provide server-side forward rendering.
- Ctrl/Cmd+Enter sends.
- `@` mentions people/channels according to current composer directive; `#` is channels only; object links are bare-code recognition in rendered body.
- Classification picker is a compact chip/segment row (`일반`, `대외비`, `민감`, `격리`) and must feed egress evaluation.
- Attachments can be files or existing object chips (`개체 첨부`). Object attachments show lifecycle chips via `egressDocs`/lifecycle data when real.
- The send button is hidden/blocked by `PolicyGated` and by egress evaluation. External send with unapproved or sensitive attachment must fail closed and render `EgressGatePanel` with one next-action CTA.

### 6. `SenderAuthPanel`

Compact chip cluster; no protocol explanatory paragraph.

- SPF, DKIM, DMARC: pass=`ok`, fail=`danger`, neutral/unknown=`neutral`.
- TLS: verified=`ok`, opportunistic=`warn`, none=`danger`, unknown=`neutral`.
- Storage encryption: encrypted=`ok`, unknown=`neutral`.
- If a message is in spam/quarantine due to DMARC fail, show `DMARC 실패` as `danger` and let the row/read-pane tone carry the warning. Do not add a prose warning caption unless it is an action-driving block.

### 7. `GovernanceChipRow`

One chip row used by thread rows, read pane header, composer attachments, and future rail summary.

- classification: `일반` neutral, `대외비` warn, `민감` danger, `격리` danger/alert.
- retention: `보존 {label}` info/accent; expired or dispose-blocked states use warn/danger only when actionable.
- litigation hold: `보존명령` danger/alert.
- PBAC: normally omit allowed state; show step-up-required only when the next action is passkey/lifecycle CTA.
- object refs: purple/accent object chips that call the shared object navigation function. No dead chips.

### 8. `MailAttachmentRows`

Read pane attachment rows:

- file name, size, content type, inline flag only if useful.
- primary CTA: `인제스트` once BE-INGEST exists and policy allows it. It calls a real endpoint that creates a DX- job, then replaces the CTA with the `DX-` chip.
- secondary CTA: `증거 등재` once records/evidence backend exists; prefill evidence registration from attachment metadata.
- fallback CTA: `다운로드` from `/api/v1/mail/attachments/{id}/download` with safe URL validation.
- Each CTA is policy-gated. If the policy denies, omit the control rather than showing disabled/explanatory text.

### 9. `EgressGatePanel`

Fail-closed composer block shown only when `mailEgressEval` returns blocked.

- Tone: danger.
- Content: compact reason chips and one next-action CTA.
- Examples: `외부 수신자`, `미승인 첨부`, `민감`, `보존명령`.
- Next actions: `생애주기 열기`, `첨부 제거`, `승인 요청`, `컴플라이언스 알림`.
- On block, backend must emit anomaly audit + compliance notification. UI only displays the returned result; it does not synthesize audit success.

## Required Korean i18n keys

Add under `ko.console.mail`. Keep labels/action text as short nouns/verbs. Avoid description/subtitle/caption keys unless they are strictly error/action states.

- `title`: `메일함`
- `folder.all`, `folder.inbox`, `folder.sent`, `folder.drafts`, `folder.archive`, `folder.trash`, `folder.junk`, `folder.custom`
- `folder.count`: function for `{unread}/{total}`
- `search.label`, `search.placeholder`
- `filter.unreadOnly`
- `thread.listLabel`, `thread.empty`, `thread.noSubject`, `thread.unreadCount`, `thread.messageCount`, `thread.conversationCount`, `thread.attachment`, `thread.flagged`, `thread.spam`
- `read.selectThread`, `read.loadFailed`, `read.emptyBody`, `read.collapsedMessages`, `read.expandMessage`, `read.markRead`, `read.markUnread`, `read.reply`, `read.forward`
- `composer.newTitle`, `composer.replyTitle`, `composer.forwardTitle`, `composer.cancelThread`, `composer.to`, `composer.cc`, `composer.bcc`, `composer.subject`, `composer.body`, `composer.bodyPlaceholder`, `composer.send`, `composer.replySend`, `composer.forwardSend`, `composer.sending`, `composer.sent`, `composer.replySent`, `composer.forwardSent`, `composer.failed`, `composer.shortcut`, `composer.attachFile`, `composer.attachObject`, `composer.removeAttachment`
- `composer.validation.to`, `composer.validation.subject`, `composer.validation.body`, `composer.validation.attachments`, `composer.validation.threadingUnavailable`
- `classification.normal`, `classification.confidential`, `classification.sensitive`, `classification.quarantine`
- `senderAuth.spf`, `senderAuth.dkim`, `senderAuth.dmarc`, `senderAuth.tls`, `senderAuth.encrypted`, `senderAuth.pass`, `senderAuth.fail`, `senderAuth.neutral`, `senderAuth.unknown`, `senderAuth.verified`, `senderAuth.opportunistic`, `senderAuth.none`
- `governance.retention`, `governance.litigationHold`, `governance.stepUpRequired`
- `attachment.download`, `attachment.downloadFailed`, `attachment.ingest`, `attachment.ingestCreated`, `attachment.evidenceRegister`, `attachment.registered`, `attachment.inline`
- `egress.blocked`, `egress.externalRecipient`, `egress.unapprovedAttachment`, `egress.sensitiveClassification`, `egress.litigationHold`, `egress.retentionLock`, `egress.policyDenied`, `egress.openLifecycle`, `egress.removeAttachment`, `egress.requestApproval`, `egress.notifyCompliance`
- `state.loading`, `state.unavailable`, `state.notConfigured`, `state.retry` as compact state labels/actions only.

Existing `ko.mailbox` strings can be copied/renamed where they are labels, but do not import legacy description/help prose into the console surface.

## Token and style rules

- Every console mail component imports `../tokens.css` through the root screen or existing console entrypoint and renders under `.console`.
- `className` must be absent except the root `className="console"`; use `CSSProperties` and `var(--*)` tokens.
- Use only tokens present in `web/src/console/tokens.css`:
  - surfaces: `--canvas`, `--surface`, `--muted`, `--border`, `--border-soft`
  - text: `--ink`, `--steel`, `--faint`
  - tones: `--ok-*`, `--warn-*`, `--danger-*`, `--info-*`, `--accent-*`, `--purple-*`
  - layout: `--sp-*`, `--radius-*`, `--shadow`, `--shadow-pop`
  - typography: `--font-sans`, `--font-mono`, `--text-*`, `--fw-*`, `--tracking-*`
- Reuse `StatusChip` for all chips. If a second chip shape is needed, extend `StatusChip` once rather than drawing a new chip style.
- Do not add new token names unless the design-system source adds them first.
- Do not import `web/src/components/ui/*`, `Badge`, `Button`, `Card`, `Input`, `Textarea`, `cn`, Tailwind helpers, shadcn, or Tailwind utility classes.

## Policy-gated affordances

Use `PolicyGated` with deny-by-omission for:

- `mail.read` / `mail.use`: whole screen and thread fetch affordances.
- `mail.send`: new send.
- `mail.reply`: reply.
- `mail.forward`: forward.
- `mail.mark_read`: read/unread mutation if the policy model separates it.
- `mail.attachment.download`: download CTA.
- `mail.attachment.ingest`: attachment-to-DX CTA.
- `mail.evidence.register`: evidence/records CTA.
- `mail.governance.view`: sender-auth/governance panel if visibility is sensitive.
- `mail.egress.external`: external send path.

Do not render disabled buttons with policy explanations. If a policy-denied state must be communicated, it belongs in a compact state row from the backend decision, not a hand-written caption.

## Fidelity-sensitive details

- Full view is `screen:"mail"`, but mail also has rail summary/read and pin-panel history. Keep one selected-thread/composer store so rail ↔ full view share state.
- The post-snapshot UX cleanup says folder/list/read are one card/surface with thin separators and no floating card gaps.
- No explanatory UI: remove mox chip captions, security prose, governance prose, "this read is audited" text, empty-state subtitles, and composer captions. Status chips and phishing/egress block panels remain because they drive action.
- Preserve list grammar: J/K moves thread selection, Enter opens/focuses the read pane, search is multi-attribute, bottom fade/overscroll behavior comes from the shared console list style.
- Preserve threading: conversation count chip on list rows; reading pane collapses previous messages and expands on demand.
- Preserve read-state semantics: opening or mark-read calls the backend read-state endpoint; do not rely only on local state.
- Preserve secure body rendering: `body_html` is untrusted and must be sanitized at render boundary; no direct `dangerouslySetInnerHTML` without sanitizer.
- Preserve object traceability: bare object codes in bodies/chips navigate through shared object resolution; no dead links and no old `#`/`!` object triggers.
- Preserve attachment hierarchy: file download is not the primary enterprise workflow. Ingest to DX- is primary when available; evidence registration is a separate governed CTA; download remains explicit and audited.
- Preserve fail-closed egress: external recipient + unapproved/sensitive/legal-hold attachment blocks send until backend returns an allowed egress result.
- Reply/forward must keep RFC threading headers (`in_reply_to`, `references`); if missing, show a compact threading-unavailable error and do not send as a fake reply.
- Sender-auth/security data is real only when returned by backend/mox integration. Until then, leave the panel empty or feature-gated, not green.

## Implementation sequence

1. Add `ko.console.mail` keys and a failing `MailScreen.test.tsx` that imports the screen and asserts no hardcoded Korean is needed.
2. Create `types.ts` and `mailScreenConfig.ts`; unit-test tone mapping and chip derivation from representative folder/thread/message/governance objects.
3. Add `api.ts` wrapper around existing mail endpoints; test send/reply/forward request bodies and read-state calls with MSW.
4. Build `MailSurfaceLayout`, `MailFolderPane`, and `MailThreadList` with tokenized inline styles and keyboard selection.
5. Build `MailReadPane`, including sanitized body rendering and collapsed prior messages.
6. Build `MailComposer` with new/reply/forward modes, Ctrl/Cmd+Enter submit, recipient validation, subject/body validation, attachment size validation, and RFC threading payloads.
7. Add `MailGovernance` and `MailAttachmentRows` with backend-feature guards. Real chips render only from real fields; egress block renders from real evaluation result.
8. Wrap every mutating or sensitive affordance in `PolicyGated`.
9. Register the screen in the console host/nav after component tests pass.
10. Add fidelity/build evidence: component screenshots for empty/loading/ready/threaded/blocked-egress states, then the screen-level fidelity gate when a current desktop prototype export exists.

## Verification checklist for implementer

Run from repo root after implementation:

- `npm --workspace web run test -- src/console/mail/MailScreen.test.tsx`
- `node web/scripts/check-console-purity.mjs`
- `node web/scripts/check-ui-strings.mjs`
- `npm run check:ts`
- If screen is routed: browser smoke `/console` → mail screen with real dev auth and mocked/seeded backend data.
- If backend governance endpoints land in the same slice: add real-backend E2E for external send blocked by sensitive/unapproved attachment, then allowed after lifecycle approval.

## Definition of done

- Folder pane, thread list, read pane, composer, sender-auth panel, governance chips, attachment CTAs, and policy gates are all composed from the reusable mail config/component family.
- No Tailwind, shadcn, legacy UI imports, hardcoded Korean TSX strings, subtitles, captions, or explanatory prose are introduced in `web/src/console/mail/**`.
- Every visible number/code/action is either returned by a real backend endpoint or omitted/gated with a named backend gap.
- Egress, classification, retention, litigation hold, ingest, and evidence controls fail closed when backend truth is missing.
- Tests prove send/reply/forward/read-state payloads, sanitized body rendering, keyboard list behavior, deny-by-omission policy behavior, and egress block behavior.
