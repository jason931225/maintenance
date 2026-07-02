# Ops UI benchmark guidance — 2026-06-30

Source: parallel read-only research delegation `deleg_92a6d5e8` plus implementation steering. This file is for GJC execution session `gjc-coordinator-24af2a53` and Kanban atomic lanes. Do not treat as a replacement for repo tests/requirements; use it to shape UI/UX acceptance.

## A. Dispatch control / compact admin-mechanic workflow guidance

### Core layout
- Use a compact dispatch board/table with filters/date/status tabs at top, dense rows in the middle, and selected-work detail/action rail when useful.
- Row height target: desktop admin `32–40px`; buttons around `32px` high; preserve `44px` hit areas for touch/mobile variants.
- Row actions should be hierarchy-driven:
  - Primary: one current best action (`출동 시작`, `정비사 배정`).
  - Secondary: 1–2 frequent actions (`일정 요청`, `메모`).
  - Tertiary/destructive/rare actions: overflow menu with aria-label/tooltips.
- Do not let P1/assign/schedule buttons occupy a full row each; keep them inline/chip/menu-based.

### P1 dispatch start
- `P1 출동 시작` must be visible and not hidden in overflow when eligible.
- Display unmet prerequisites near the CTA: mechanic missing, date/address/checklist missing.
- Prevent duplicate submit with loading state; show success audit text such as `출동 시작됨 · 14:32 · 홍길동`.
- Use confirm only for irreversible/external-notification actions; otherwise use undo/snackbar.

### Schedule change and date-only controls
- Separate `일정 변경` from `일정 변경 요청` if permissions/approval differ.
- Show current date and requested date side-by-side.
- Use date-only controls/values (`YYYY-MM-DD` or DB date type), not UTC-midnight datetime.
- Validate timezone/date persistence, past date rules, weekends/holidays/P1 constraints as applicable.

### Mechanic assignment
- For unassigned rows: visible compact `정비사 배정` CTA.
- For assigned rows: mechanic chip/avatar + dropdown/overflow for change/release/detail.
- Assignment picker should show availability/capacity/skill/region where available.
- Before save, show dirty states (`변경됨`, subtle row highlight, changed field dot).

### Global save
- Add sticky save bar or always-visible save affordance: `변경사항 N개`, `모두 저장`, `변경 취소`, validation error count.
- Support partial failure: `4개 중 3개 저장됨, 1개 실패`; mark failed row inline.
- Add unsaved-change navigation guard and concurrency conflict messaging.

### Dispatch anti-patterns
- datetime picker when only date is needed.
- Disabled button with no explanation.
- Three+ primary buttons in one row.
- Full-width repeated action buttons consuming vertical space.
- Storing date-only values as UTC datetime and causing off-by-one dates.
- Hiding P1 start in overflow.
- Color-only status indicators.

### Dispatch verification
- P1 unassigned → assign mechanic → 모두 저장 → 출동 시작.
- Schedule change request shows current/requested date and status.
- Multiple dirty rows → global save success/partial failure.
- Timezone change does not shift target dates.
- Narrow layout folds actions predictably without label truncation.
- Keyboard/focus/aria-label coverage for icon/overflow actions.

## B. Electronic approval / attachment image visibility

### Approver-visible attachments
- Approval detail/card should show maintenance request content plus attachment thumbnail strip directly near the request body.
- Images should open in lightbox/modal viewer with zoom, file name, uploader, timestamp, and download/open action.
- PDF/quote/receipt should have first-page preview or clear PDF viewer/open affordance.
- Empty state should say attachment is absent, not silently hide the area.
- Mobile approval should still show the first attachment thumbnail.
- Keep approval read authorization strict: approver can view relevant evidence read-only; no permission leakage to unrelated files.

### Acceptance
- Approver can see maintenance photos before approving/rejecting.
- Attachment links open actual file/preview, not JSON metadata.
- Audit/timeline preserves which attachments existed at approval time where possible.
- Tests cover approver role and requester/unauthorized role boundaries.

## C. Purchase request refinement

### Vendor field
- Use autocomplete combobox over vendor master data; search name/alias/business registration/contact/recent vendors.
- If no match, provide `새 거래처로 입력` manual-entry path.
- Mark vendors as existing/new/unverified for approvers.
- Warn on probable duplicate vendor names.

### Line-item grid
- Use compact grid, not stacked cards, for desktop.
- Columns: 품목/설명, 수량, 공급가액 단가, 부가세율/부가세액, 금액/총액, 카테고리/비고/견적 reference as needed.
- Auto-calculate supply × qty, VAT default 10%, line total, footer total.
- VAT override allowed with reason/audit/badge for approver visibility.
- 거래처명 옆 total should be derived from line totals.

### Price anomaly/history
- Compare vendor + item/category against recent purchases.
- Show last price, recent average/range, percent difference, last purchase date/vendor.
- Anomalies are normally warning/escalation aids, not silent blockers.
- For regular purchase items, first quote can seed baseline; later price difference should warn and require reconfirm/quote update according to policy.

### Quote rules
- Quote upload is always possible but not always required.
- Policy states: optional / recommended / required / waiver allowed.
- Approver sees quote status: attached, optional missing, waiver, required missing.

### Requester visibility
- Approver must see requester identity.
- Requester should see own request status, approver/role pending, timeline, comments, attachments, VAT/quote/vendor warnings, reject/needs-change reasons.
- Separate requester-visible comments from internal approval notes.

## D. Work Hub / nav badges / notification bell guidance

Both dedicated Work Hub/nav research attempts returned `Broken pipe`, so this section is Hermes-synthesized benchmark-informed guidance based on Linear/Slack/Teams/Outlook/Zendesk/Intercom/Jira/Asana/Notion/Google Workspace/Stripe-style enterprise UX patterns. Use it as product direction, but prove final behavior through repo tests and E2E.

### Left navigation badges
- Move low-priority conversation/mail board cards out of the main Work Hub first screen when they are only awareness signals.
- Put unread counts in left-nav badges rather than main dashboard cards:
  - Messenger/thread unread: red speech-bubble or rounded badge.
  - Mail unread: smaller neutral/red badge depending whether mail requires action.
  - Customer support: show both unread inquiries and open tickets.
  - Electronic approval: show actionable pending approvals and submitted/complete counts inside the page summary.
- Count format:
  - `0` hidden unless the page needs explicit zero state.
  - `1–99` exact.
  - `99+` capped.
  - Expanded sidebar can show compact text such as `3 읽지 않음`, `12 열림`; collapsed sidebar uses badge + tooltip/aria-label.
- Badges must not cause layout shift or truncate nav labels. Reserve width or overlay badges at a fixed anchor.
- Use color plus text/aria, not color alone.

### Work Hub first-screen dashboard
- First screen should answer: `오늘 내가 해야 할 일은 무엇인가?`, `막힌 일은 무엇인가?`, `언제 해야 하는가?`, `새로 읽어야 할 것은 무엇인가?`.
- Recommended compact layout:
  1. Top summary strip: today tasks, overdue, due soon, pending approvals, support open/unread, unread messages/mail.
  2. Main 60–70% column: personal task list grouped by today / due soon / blocked / waiting.
  3. Side 30–40% column: compact personal calendar agenda + priority/focus items.
  4. Activity/messages/mail/support only as small awareness rows or nav badges, not large board cards.
- Use dense cards/rows with `8px` rhythm, minimal padding, no oversized empty cards.
- Each row should expose status chip, due date, assignee/current owner, and one primary action or deep link.
- Provide clear empty states: `오늘 예정된 업무가 없습니다`, `읽지 않은 메시지가 없습니다`.

### Customer support nav counts
- Left nav should expose:
  - unread/new customer inquiries;
  - open tickets needing attention;
  - optionally SLA/overdue tickets if existing data supports it.
- Suggested expanded label: `고객지원 3 unread · 12 open` translated through i18n.
- Suggested collapsed behavior: primary badge for unread, tooltip with `읽지 않은 문의 3개, 열린 티켓 12개`.
- Do not display multiple large pills that widen the sidebar; compact dual-badge or tooltip is better.

### Electronic approval counts and page summary
- Rename nav label `승인` → `전자결제` consistently in sidebar, route labels, page title, tests/i18n.
- Electronic approval page should summarize:
  - `결재할 문서` / pending approvals assigned to me;
  - `상신/접수 문서` / submitted documents awaiting approval;
  - `결재완료` / completed documents.
- Use compact metric cards or segmented summary chips at top of page; each count should be clickable/filtering when feasible.
- Avoid mixing approval documents with general notifications; approval counts should be task-oriented.

### Notification bell
- Top-right bell should be keyboard accessible and screen-reader labeled.
- Show unread dot/count; popover should list latest personal alerts grouped by today/earlier or by category.
- Actions: open target, mark one read, mark all read if supported.
- Use existing polling/summary endpoints where possible; do not invent realtime infra unless repo already has SSE/websocket support.
- If real-time is not available, implement predictable polling/refetch and label it as near-real-time in code/tests.
- Empty/loading/error states must be polished.

### Anti-patterns
- Large dashboard cards for low-priority mail/conversation metrics that push personal tasks/calendar below the fold.
- Badge counts that shift nav width, overlap text, or truncate labels such as `업무 허...`.
- Multiple red badges everywhere; reserve red for actionable unread/attention.
- Icon-only bell/nav controls without tooltip and aria-label.
- Hardcoded Korean strings in TSX; all visible strings should go through i18n.
- Showing stale counts without loading/error states or refresh behavior.
- Hiding support open-ticket counts inside the page when the user asked for sidebar visibility.

### Work Hub/nav verification
- Expanded sidebar shows messenger/mail/support/e-approval badges with correct counts and no label truncation.
- Collapsed sidebar shows badges and accessible tooltip/aria-label summaries.
- Work Hub first screen shows personal task list, compact calendar agenda, focus/priority items, and key counts without excessive scrolling.
- Conversation/mail are not large primary board cards unless they contain actionable personal work.
- Customer support nav displays unread inquiries and open tickets distinctly.
- `승인` is renamed to `전자결제` everywhere visible and in tests/i18n.
- Notification bell opens via mouse and keyboard, shows unread count/list, handles empty/loading/error, and supports mark-read behavior if backend supports it.
- Counts update after mocked API changes/refetch; `99+` cap works.
- Browser E2E covers worker dashboard, support/nav awareness, electronic approval count/bell path.

## E. Shared acceptance / E2E expectations

- E2E should simulate real user paths where possible:
  - approver opens approval and views attached maintenance photos;
  - dispatcher assigns mechanic, changes date-only schedule, saves all, starts P1;
  - worker opens compact Work Hub and sees calendar/focus items;
  - user sees nav unread/support/e-approval badges and bell;
  - requester creates purchase request with vendor/manual entry, lines, VAT, optional quote, anomaly visibility;
  - group admin sees LSO slug corrected and compact actions without label truncation.
- If live auth/test credentials are unavailable, run local Playwright and record live blocker explicitly.
