# Oyatie Console — Messenger full-view fidelity requirements

Status: worker-ready requirements brief for the carbon-copy `msgr` full-view slice.

## Scope

Build the Slack/Teams-parity messenger full view as a carbon-copy console screen under `web/src/console/**`. The screen is the main-surface promotion of the communication rail messenger state: thread list + conversation pane, fully wired to real messenger APIs where the backend exists, and explicitly blocked or split for parity fields that do not yet exist. Do not port legacy pages or visual primitives.

This brief covers threads, messages, send, read receipts, members, search, channel vs DM presentation, presence, ack reactions, reply quote, per-thread mute, message-to-todo conversion, and `@` mention token-composer integration.

## Source verdict

- Current checkout note: `docs/design/oyatie-console/Oyatie Console.dc.html` is not present in this worktree (`docs/design/oyatie-console/` contains `Oyatie Mobile.dc.html` but no desktop `Oyatie Console.dc.html`). Direct desktop-HTML line extraction is therefore impossible from this checkout.
- The messenger full view is post-Jul-4 design work. The offline precedence path says the Jul-4 desktop HTML was too large to re-fetch, and post-Jul-4 screens are specified by `AGENTS.md` changelog + ROADMAP/TODO/prototype-anatomy grammar docs: `docs/design/oyatie-console/SYNC-MANIFEST.md:16-18`, `:26-29`.
- This brief follows that documented substitute path and cites the mirrored design-authority markdowns. It must not be treated as permission to invent behavior outside those sources. If a future worker obtains a bit-exact current desktop HTML export, they should backfill direct prototype line references and update this brief.

## Sources consulted

1. `.omc/plans/carbon-copy-charter.md`
   - `:40-44` — `/console` app-within-app, whole viewport, own tokens/shell, no AppShell/shadcn/Tailwind.
   - `:58-67` — fidelity gate, grammar checklist, no explanatory UI, no duplicated shapes, post-snapshot substitute path.
   - `:80-89` — transfer only shared spine: typed client/auth/realtime/E2E/i18n; rebuild legacy visual JSX.
   - `:120-123` — P0 token composer contract and backend proof for mentions/object refs.
2. `docs/design/oyatie-console/SYNC-MANIFEST.md`
   - `:16-18`, `:26-29` — desktop HTML stale/missing-large-file handling; AGENTS changelog + grammar catalog are the spec for post-Jul-4 screens.
3. `docs/design/oyatie-console/AGENTS.md`
   - `:14-15` — `msgr` is a full view with Slack/Teams parity; mail/messenger/notif share rail(summary) ↔ main(full-view) state.
   - `:27-30` — Korean-first, noun labels, status as chips, no explanatory UI, every feature links upstream/downstream objects and audit.
   - `:61-67` — messenger stages: full view, rail state sharing, `msgrSel/msgrSend`, grouping, unread divider, search, `msgrTodo`, channels/DMs, presence, ack, quote, object-code chips, autocomplete, scroll landing.
   - `:113-115` — per-thread mute and benchmark parity closure.
4. `docs/design/oyatie-console/ROADMAP.md`
   - `:33-42` — PBAC, audit, pin/window, list grammar, token grammar, automation, no-code, token styling are inherited systems.
   - `:88` — communication module status and benchmark: Slack/Gmail/mox with Thread/Mail/Notice objects.
   - `:131-133` — messenger full-view and Slack/Teams parity completion details.
5. `.omc/research/oyatie/prototype-anatomy/00-shell.md`
   - `:48-59` — rail messenger summary, thread view, composer, `msgParts`, `@` autocomplete, and rail↔main promotion invariant.
   - `:86-113` — global search/Escape/J/K/Enter keyboard conventions.
   - `:122-132` — token family names and `var(--*)` discipline.
6. `.omc/research/oyatie/prototype-anatomy/02-screens/post-snapshot-screens.md`
   - `:37-45` — consolidated messenger full-view requirements and bugfix/scroll gotchas.
7. `.omc/research/oyatie/prototype-anatomy/03-systems.md`
   - `:84-106` — token composer and current carbon-copy directive: `@` mentions, `#` channels, object refs as bare-code auto-recognition, `!` removed.
   - `:107-117` — guardrail layers: authz, self-check, peer review, SoD, egress/deploy gate, detection/audit.
8. `.omc/research/oyatie/prototype-anatomy/04-backend-contract.md`
   - `:167-178` — existing messenger endpoints and backend gaps for parity fields.
9. `.omc/research/oyatie/prototype-anatomy/05-post-snapshot-todo-digest.md`
   - `:42-45` — Slack/Teams benchmark checklist and mute semantics.
10. `web/scripts/check-console-purity.mjs`
   - `:9-28`, `:100-147` — console import/className/token purity constraints.

## Non-goals and hard constraints

- Do not edit or import legacy visual surfaces (`web/src/pages/**`, `web/src/components/ui/**`, shadcn, Tailwind, AppShell chrome, legacy `features/**` JSX). Import only shared spine that the charter allows.
- Do not fabricate threads, DMs, channels, presence, ack counts, quote metadata, mute flags, or object codes. If the API lacks a field, hide the affordance, show an operational status chip only where necessary, or split a backend follow-up.
- Do not add explanatory captions, protocol prose, or “this is audited” helper text. Status must be chips/icons/position/behavior, not paragraphs.
- Do not reintroduce old token grammar: `#` is channels, `@` is mentions, `!` is removed, and object references are bare-code auto-links only.

## Target route/component registration

- Internal console screen id: `msgr`.
- Nav label: `메신저` under communication surfaces.
- Object family: `Thread` / messenger message objects; meetings referenced from messenger are `MT-` objects.
- Implementation target: `web/src/console/**`, likely a dedicated `messenger/` or `comms/` subtree, registered through the console router/state-screen layer.
- Shared state invariant: rail messenger summary and full view consume the same thread/read/unread state; the full view is a promotion of the rail, not a second data model.
- Every visible string belongs in `web/src/i18n/ko.ts` (for example `ko.console.messenger.*`). Component files should reference keys, not hard-coded Korean labels except test fixtures.

## Prototype-derived full-view anatomy

### 1. Desktop layout

Checklist:

- [ ] Render a two-pane main surface: left thread sidebar, right selected conversation.
- [ ] Left sidebar has a compact search control, a channel section, and a direct-message section.
- [ ] Channel rows show `#` channel identity; direct rows show avatar/initial + person/thread name.
- [ ] Rows show unread state as badge/dot/chip; muted rows show bell-off and suppress count contribution.
- [ ] Row selection drives `msgrSel`-equivalent state and opens the conversation pane.
- [ ] The right pane header shows thread/channel name, member chips, presence where applicable, auto-extracted object-code chips, and a mute bell toggle.
- [ ] The message body scroll pane shows grouped bubbles, unread divider, hover affordances, and the composer fixed at the bottom of the conversation area.
- [ ] Preserve rail↔main promotion: clicking `메신저` from the rail/nav opens `screen:"msgr"` with the same selected thread/message state. Do not duplicate rail rows into an unrelated screen.

Fidelity-sensitive details:

- The full view is a single carbon-copy console surface, not floating card stacks.
- Keep the rail's compact preview grammar for rail mode and the two-pane grammar for full view; both must share state and read/unread counts.
- Use only existing console token families (`--canvas`, `--surface`, `--muted`, `--border`, `--ink`, `--steel`, `--faint`, semantic tone triplets, `--shadow*`). No hard-coded colors.

### 2. Threads, messages, send, read receipts, members, search

Backend mapping:

- Core endpoints exist: `GET/POST /api/messenger/threads`, `GET /api/messenger/threads/{threadId}/messages`, `POST /api/messenger/threads/{threadId}/messages`, read receipt, members, member add/remove, search (`04-backend-contract.md:167-172`).
- `@mention` notification and PBAC re-resolution exist through message refs (`04-backend-contract.md:172`).
- Object-code linking is client rendering over object resolve/message refs (`04-backend-contract.md:173`).

Checklist:

- [ ] Load the thread list from the messenger threads API; do not seed local demo threads in production code.
- [ ] Load messages for the selected thread; loading/empty/error states must be compact chips or skeleton rows, not explanatory panels.
- [ ] Opening a thread marks read through the read-receipt endpoint and updates unread state locally only after the endpoint succeeds or an accepted optimistic policy is explicitly tested.
- [ ] `msgrSend` posts to the real send endpoint, then appends/revalidates the returned message. Sending must also scroll to bottom.
- [ ] Member chips come from the members endpoint; member add/remove affordances are `PolicyGated` and hidden without permission.
- [ ] Search has two scopes: thread/sidebar search and in-thread content search (`msgrQ`-equivalent). Do not mix it with global palette search. Use messenger search endpoint where available; client filtering is acceptable only over already-loaded authorized rows.
- [ ] J/K moves thread-row selection when focus is not in an input; Enter opens the selected thread. Focus inside the composer/search must not be hijacked.

### 3. Channel vs DM presentation

Checklist:

- [ ] Split the sidebar into channel rows and direct-message rows.
- [ ] Channels use `#` identity and are candidates for the `#` composer trigger.
- [ ] DMs use person/group avatar initials and show presence dots where presence is available.
- [ ] Rows and headers must never expose unauthorized threads as disabled/locked entries; unauthorized content is omitted.
- [ ] If backend taxonomy lacks `kind === "channel"|"dm"`, do not guess based on names unless the implementation records a temporary adapter and tests it. Backend gap is “messenger parity fields” (`04-backend-contract.md:174`).

Fidelity-sensitive details:

- `#` no longer means object link in the carbon-copy console. It means channel reference.
- Object references inside messages are bare canonical codes (`WO-2643`, `AP-3121`, etc.) rendered as links/chips only when resolved and authorized.

### 4. Presence

Checklist:

- [ ] Render presence as compact tokenized dots/chips on DM rows and member chips.
- [ ] Use a `PRESENCE`-equivalent model from the API when available; do not invent online/offline state.
- [ ] Presence labels, if visible, are short chip labels only (`온라인`, `자리비움`, etc.) and live in `ko.ts`.
- [ ] Absence of presence data should omit the indicator or render a neutral chip; no explanatory copy.

Backend note: presence is a parity gap today (`04-backend-contract.md:174`). A production GO either needs BE-COMMS-PARITY presence fields or an explicit N/A/non-shipping gate.

### 5. Message grouping and unread divider

Checklist:

- [ ] Consecutive messages by the same sender are grouped (`headOn`-equivalent): first bubble in a run shows avatar/name/time header; following bubbles are visually connected without repeating the header.
- [ ] Insert one `새 메시지` unread divider (`msgrDiv`) before the first unread message for the viewer.
- [ ] On thread entry, scroll to the unread divider if present; otherwise scroll to bottom.
- [ ] On send, always scroll to bottom.
- [ ] Use manual scrollTop arithmetic for the scroll landing (`_msgrScrollSync`-equivalent), not `scrollIntoView`, matching the recorded bugfix convention.

Fidelity-sensitive details:

- Divider is a structural line in the message pane, not a toast or banner.
- The scroll behavior is part of fidelity; “messages load somewhere near the bottom” is not acceptable.

### 6. `msgParts` and live references

Checklist:

- [ ] Message body renderer returns an array of render segments, not a single React element. Regression-test this because a prior `tokenRender(...).map` mismatch crashed the whole app render path (`post-snapshot-screens.md:45`).
- [ ] Render `@mentions` as live mention spans/chips and route click to the person/member surface when authorized.
- [ ] Render canonical object codes as live links/chips through object resolution and `objectLinkGo`-equivalent behavior.
- [ ] Unknown, unauthorized, or unregistered codes remain inert plain text. No dead links.
- [ ] Header object-code chips are auto-extracted from the selected thread content and route through the same object-link dispatcher.

### 7. Composer and `@mention` token integration

Checklist:

- [ ] Use the shared console composer grammar, not a messenger-only parser.
- [ ] `@` opens person/member mention candidates, PBAC-filtered by current viewer.
- [ ] `#` opens channel candidates, PBAC-filtered by current viewer.
- [ ] Bare object-code typing can autocomplete/resolve known codes without a trigger character; resolved codes are inserted/recognized as text that `msgParts` links.
- [ ] `!` trigger is not supported.
- [ ] Composer dropdown supports arrow-key navigation, Tab/click confirmation, Escape dismissal, and viewport clamp/flip.
- [ ] Enter sends only when the dropdown is not in an explicit candidate-confirm flow; normal prose must not be hijacked. If multiline is supported, Shift+Enter inserts newline.
- [ ] `@mention` send side effect creates notification + audit through backend message_refs/notification path.
- [ ] Drag-drop object reference payloads append an object-code/reference token in the composer, reusing the cross-app object-drag payload.

### 8. Ack reactions vs read receipts

Checklist:

- [ ] Keep read receipts and ack reactions distinct.
- [ ] Read receipt is passive/open-state and uses the read-receipt endpoint.
- [ ] Ack is an explicit hover action (`msgrAck`-equivalent) on a message, toggling the current user's acknowledgment.
- [ ] Ack count renders as a compact chip on the message/bubble action area.
- [ ] Ack state must be persisted by real backend reaction/ack metadata before shipping. If BE-COMMS-PARITY has not landed, hide or mark the ack affordance as blocked in developer-facing tests; do not fake counts.

Backend note: ack/reaction metadata is a parity gap today (`04-backend-contract.md:175`).

### 9. Reply quote

Checklist:

- [ ] Hover “reply” action stores the quoted message id/author/body excerpt (`msgrQuote`-equivalent).
- [ ] Composer shows a compact quote preview with a clear/cancel control.
- [ ] Sent reply renders an in-bubble quote block above the new message text.
- [ ] Quote metadata must be persisted; if the backend lacks it, do not ship local-only quote state as production behavior.
- [ ] Quoted text must pass through the same authorization and rendering constraints as the original message. If the original message is no longer visible to the viewer, omit the quote body or render a neutral unavailable chip, not leaked content.

Backend note: quote metadata is a parity gap today (`04-backend-contract.md:175`).

### 10. Message-to-todo conversion

Checklist:

- [ ] Hover “할 일” action calls the real todo API (`POST /api/v1/me/todos`) and/or the shared `addTodoToDay`-equivalent only after the API succeeds in production wiring.
- [ ] Created todo links back to the thread/message and preserves object-code references in the body.
- [ ] Message row/bubble shows a compact `할 일` status chip after successful conversion.
- [ ] The action is `PolicyGated`; if the viewer cannot create personal todos, the affordance is omitted.
- [ ] It must feed the Overview today/plan pane, matching the prototype cross-surface link.

### 11. Per-thread mute

Checklist:

- [ ] Header bell toggles a per-user thread mute setting.
- [ ] Muted state renders as bell-off in the header and on the thread row.
- [ ] Muted threads suppress unread badge contribution in the sidebar/rail/mobile tab totals while preserving actual unread state for the thread itself.
- [ ] Mute is a personal setting and is a direct-save whitelist case, not a lifecycle-governed business object.
- [ ] Mute state must persist across reload/device if shipped; otherwise keep it hidden behind a backend gap.

Backend note: per-user mute flag is a parity gap today (`04-backend-contract.md:176`).

### 12. Meetings and object chips

Checklist:

- [ ] Meeting references render as `MT-` objects when present.
- [ ] Header object-code chips auto-extract every resolvable canonical code in the thread (`WO-`, `AP-`, `MT-`, etc.) and route via the object dispatcher.
- [ ] Do not create a special messenger-only object-chip style. Use the shared StatusChip/link-chip grammar.

### 13. Policy gates and audit

Checklist:

- [ ] `PolicyGated` wraps nav entry, thread read, member list, send, ack, quote, todo conversion, mute toggle, object links, member management, and any future channel creation/invite affordance.
- [ ] Deny-by-omission is required: forbidden rows/actions are absent, not disabled with explanatory text.
- [ ] Sends with `@mention` produce notifications and audit via message_refs path.
- [ ] Read/open, send, ack, todo-convert, mute, and member changes should each have audit semantics. If a backend action does not emit audit today, record a backend follow-up rather than faking audit in the UI.
- [ ] Policy resource shape should include thread id/message id/member id as applicable; avoid module-wide grants for per-message/member affordances.

### 14. Console purity and component reuse

Checklist:

- [ ] Files live under `web/src/console/**`.
- [ ] Imports obey `web/scripts/check-console-purity.mjs`: allowed external imports only, no `features/**`, no `pages/**`, no shadcn/Radix/lucide/Tailwind/clsx/Tailwind-merge.
- [ ] `className` is only `"console"` where needed; otherwise use inline tokenized styles.
- [ ] Every `var(--*)` token exists in `web/src/console/tokens.css`.
- [ ] Status shapes use shared `StatusChip`; no duplicated chip CSS.
- [ ] Thread row, message bubble, action chip, member chip, object-code chip, search row, and composer candidate are config-driven/reusable primitives. Same shape drawn twice is a §4-18 violation.
- [ ] Strings go in `web/src/i18n/ko.ts` and use Korean noun/action labels.

## Backend gap handling

Core messenger API exists:

- Threads/messages/send/read receipts/members/search: usable now.
- `@mention` notifications/message refs: usable now.
- Todos: usable now via `POST /api/v1/me/todos`.

Parity fields are gaps and should be owned by BE-COMMS-PARITY before a full GO:

- channel vs DM taxonomy if not already present in thread fields,
- presence,
- ack/reaction metadata,
- reply-quote metadata,
- per-user thread mute flag.

Frontend rule while gaps remain: implement the shell and wire existing endpoints, but hide parity affordances that cannot persist correctly. Do not ship local-only fake Slack parity.

## Verification checklist

Required focused tests:

- [ ] Unit: message grouping (`headOn`) and unread divider placement.
- [ ] Unit: `msgParts` returns arrays and links authorized `@mention` + bare object code while leaving unauthorized codes plain.
- [ ] Unit: composer grammar — `@` people, `#` channels, bare-code recognition, no `!`, candidate keyboard controls, plain-text non-interference.
- [ ] Unit/RTL: `PolicyGated` omits send/ack/quote/todo/mute/member affordances when denied.
- [ ] Unit/RTL: mute badge suppression math excludes muted threads from rail/sidebar/mobile totals without clearing unread state.
- [ ] Unit/RTL: ack toggle and reply quote are hidden or disabled behind backend capability tests until BE-COMMS-PARITY fields exist.
- [ ] Unit/RTL: message-to-todo calls the todo API and renders a chip only after success.
- [ ] Integration: thread open calls read receipt endpoint; send calls messenger send and revalidates/appends returned message.
- [ ] Integration: `@mention` send creates/observes notification/message_ref behavior.
- [ ] Purity: run `node web/scripts/check-console-purity.mjs`.
- [ ] Web tests: run relevant Vitest/Testing Library suite for the new messenger files.
- [ ] Browser E2E on a real backend: open `/console`, navigate to `메신저`, select a thread, land on divider/bottom, send `WO-2643 배차 확인 부탁 @김성호`, verify WO code and mention render as live links, read receipt updated, todo conversion reaches today/plan, and all unauthorized affordances are omitted for a restricted persona.

## Acceptance checklist for implementer handoff

- [ ] Messenger screen is reachable as internal `screen:"msgr"` under the console app.
- [ ] Rail and full view share thread/unread/selection state.
- [ ] Thread list has channel/direct sections, search, unread/mute indicators, and keyboard navigation.
- [ ] Conversation header has members, object-code chips, and mute bell.
- [ ] Message pane has grouped bubbles, unread divider, manual scroll landing, and hover actions.
- [ ] Composer uses shared token grammar with `@` mentions, `#` channels, bare object codes, and no `!`.
- [ ] Existing backend endpoints are used for threads/messages/send/read receipts/members/search/todos.
- [ ] Parity gap affordances are either backed by BE-COMMS-PARITY or omitted/blocked without fake state.
- [ ] All affordances are `PolicyGated` and deny by omission.
- [ ] UI strings are in `web/src/i18n/ko.ts`; no explanatory UI; statuses are chips only.
- [ ] Console purity check and focused tests pass.
