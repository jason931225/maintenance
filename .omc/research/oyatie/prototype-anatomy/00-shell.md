# 00 — App Shell

Source: `Oyatie Console.dc.html` template lines 1-330 (shell chrome), 2399-3411 (rail/tray/modals/palette), plus `renderVals()` bindings (constructor state + lines ~5695-5822 for keyboard/theme/palette methods, ~6700-7740 for shell geometry). Verified against Jul-4 snapshot unless marked UNVERIFIED-AGAINST-SNAPSHOT (post-snapshot, spec'd from `05-post-snapshot-todo-digest.md`).

## Top-level structure

```
<div class="console {themeClass}">          // full viewport, flex column, height:100dvh
  <div flex:1 row>                          // sidebar + main + rail row
    <aside sidebar />
    <main>
      <header topbar />
      <div class="quadrant-grid">           // 2x2 CSS grid (panels overlay)
        <panels... />                       // pinned quadrant mini-detail views
        <section dashArea />                // the actual page body (per-screen content)
      </div>
    </main>
    <aside comms-rail />
  </div>
  <div docked-task-bar />                   // fixed bottom tray, sibling of the row above
  <!-- modals (task detail, calendar, mail, team/entity/personnel card, passkey, palette) -->
</div>
```

The whole app is inside a single custom element `<x-dc>` (template DSL: `sc-if`/`sc-for`/`{{binding}}`), rendering a `.console` div. `.console` carries ALL CSS custom-property theme tokens as inline `--var` declarations (see Token usage below) and toggles class `t-light`/`t-dark` (or neither = follow OS `prefers-color-scheme`).

## Grid layout — quadrant split-screen

The body between topbar and comms rail is a CSS grid: `grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr; gap:2px`. This is the **panel quadrant system** (`state.panels`): up to 4 pinned mini-detail views (task/mail/person/team/entity/calendar) can occupy `tl`/`tr`/`bl`/`br` grid areas simultaneously, dragged in by dragging a task-list row or a modal's header onto one of 4 invisible drop zones (`snapDrop(zone)` → `snapTo`). The actual page content (`dashArea`, i.e. the current screen's body) occupies whatever grid area(s) are NOT claimed by panels — computed as `dashArea: dashQ.length ? rectArea(dashQ) : "auto"` (a helper that unions the free quadrant cells into a CSS `grid-area` spec). If all 4 panels are pinned, an "empty slot" placeholder message appears (`emptySlotOn`) telling the user to drag a detail there.

Each panel (`pn` in `sc-for list="panels"`) renders a self-contained card with header (kind chip, ref code, title, due, minimize/popup/close buttons) and one of 4 body variants gated by `pn.isTask` / `pn.isApproval` / `pn.isDispatch` / `pn.isMail` / `pn.isPerson` (approval shows 결재선 + comment + approve/reject/return; dispatch shows driver picker + confirm; mail shows body + reply; person shows contact card + message button).

## Sidebar (`<aside>`, left)

- Width: `sbW = sbCollapsed ? "62px" : "236px"`, `sbCollapsed = state.sbUser ?? (vw < 1280)` (user can override auto-collapse via `onSbToggle`; otherwise auto-collapses under 1280px viewport). Animated width transition (0.18s).
- Header band (56px): brand mark ("A" square, signal-colored) + "Acme Group" / "그룹 통합 운영 콘솔" wordmark (hidden when collapsed) + theme-cycle button (sun/moon icon, only shown when `sbOpen`).
- Nav: `navGroups` — array of `{label, items}` sections. In the Jul-4 snapshot: **개요** (통합 개요/내 업무/개인 수신함), **인사** (인사 관리/채용/조직도/평가), **급여·근태** (급여/근태/연차/복리후생), **ERP** (재무/구매/재고/자산 — all stubs), **현장 운영** (배차/정비/고객·현장 —배차 wired to filter, others stub), **거버넌스** (전자결재/문서·기록물/권한·정책/컴플라이언스[stub]/감사 로그), **분석** (대시보드/인건비 분석/객체 탐색/예측 — all stubs), **자동화** (워크플로 스튜디오/예약 작업, both real via `screen:"auto"` + `autoTab`), **커뮤니케이션** (메신저/메일/알림/게시판·공지/주소록 — these open the rail, not a screen). Each nav item: icon (24×24 SVG path from `this.ICONS`), label (hidden when collapsed, replaced by tooltip `title`), badge (count pill, red for urgent / muted "neutral" tone for informational) or a small red dot when collapsed (`dotOn`) since there's no room for a numeric badge.
- Unwired items call `stub(label)` → toast "「X」 화면은 다음 단계 범위입니다" (this defines exactly which nav destinations are NOT implemented in-snapshot: 재무/구매/재고/자산/정비/고객·현장/컴플라이언스/대시보드/인건비 분석/객체 탐색/예측, plus 게시판·공지 has a badge but no dedicated screen — clicking most 커뮤니케이션 items just opens the rail home).
- Footer: collapse/expand toggle button.

## Topbar (`<header>`, 56px, inside `<main>`)

- Search-palette trigger button (magnifying glass + placeholder "사람·업무·문서 검색" + kbd hint `⌘K`/`Ctrl K`) → `openPalette()`.
- Scope switcher (building icon + current scope label + chevron) → dropdown listbox of `scopeDefs`: `all`("그룹 전체"), `coss`(㈜코스), `knl`(KNL 물류), `bestec`(BESTEC OEM), `staff`(HR 스태핑). Selecting a scope filters almost every screen's data (`scopedItems()`, `attScoped`, `payList`, etc. all gate on `entity === scope || entity === "hq"`).
- Spacer.
- User menu button (avatar circle with initial "전" + name "전성진" + role "경영지원팀 · 그룹 관리자", text hidden on narrow). Opens the **PERSONNEL CARD modal** for self (`pMeOn` branch — includes punch-out/logout buttons instead of message/mail buttons).

## Comms rail (`<aside>`, right)

- Width: `railW = railCollapsed ? "54px" : (vw < 1560 ? "300px" : "336px")`; `railCollapsed = state.railUser ?? (vw < 1280)`.
- **Closed state** (`railClosed`): vertical icon strip — expand-toggle, divider, then 3 icon buttons (메신저/메일/알림) each with an unread red-dot indicator, no counts.
- **Open, home view** (`railOpen && railHome`): header ("커뮤니케이션" + collapse toggle) then 4 stacked, independently collapsible sections, each with a header row (icon, label, unread-count pill, quick-action button [new chat / new mail / mark-all-read / more]) and a scrollable list body whose flex-grow (`secXFlex`) and visibility (`secXDisp`) are individually toggled by clicking the section header (accordion behavior — sections can be independently expanded/collapsed, `onSecMsgr`/`onSecMail`/`onSecAlert`/`onSecNotice`):
  1. **메신저 (Messenger)** — list of `threads[]` (id, name, unread count, avatar init/colors, last message snippet+time). Row click → `openThread(id)` → promotes to thread view.
  2. **메일 (Mail)** — list of `mails[]` (from, subject, time, unread dot, draggable for cross-panel drop). Row click → `openMail(id)` → promotes to mail-read view.
  3. **알림 (Notifications)** — list of `notifs[]` (category chip, text, time, unread dot). Row click → `notifClick(n)` (navigates to the linked item/thread/screen per `n.link`). "모두 읽음" button → `markAllNotifs()`.
  4. **공지 (Board notices)** — list of `notices[]` (title, meta, unread dot). "더보기" button (stub in snapshot — no dedicated board screen).
- **Thread view** (`railThread`): back button + thread name/meta header, scrollable message bubbles (`msgs[]`, alignment/color driven by `m.me`, `msgParts` tokenizes `@mention` spans as clickable purple text via `pickCMention`), composer input with `@`-mention autocomplete popover (`cMentionOpen`/`cMentions`) and drag-drop-to-attach support, send button → `sendMsg()`.
- **Mail-read view** (`railMailRead`): back button + "크게 열기" (expand to full MAIL MODAL) button, subject/from/time header + linked-task tag chip (if `mailTagOn`), body paragraphs, inline quick-reply input (or a "회신 발송 완료" success banner if already replied) → `sendReply()`.
- Promotion pattern: EVERY rail summary row (thread, mail, notif, notice) is a compact preview; clicking promotes to either an in-rail full view (thread/mail-read) or an app-level modal/screen. This is the **rail↔main promotion** invariant named in the project's CLAUDE.md charter ("커뮤니케이션은 rail↔main 승격").

## Docked task bar (bottom tray, full-width, above the viewport bottom edge)

Two DISTINCT chip families rendered side by side in the same bar (`trayOn`):
1. **빠른 작업 (Quick actions)** — a dropdown button (signal-yellow, always first) listing `quickActions[]` (bookmarked cards from `quickCards` state, plus possibly other quick-launch entries) — `onQuickToggle` opens a menu of runnable actions, each optionally flagged `stubOn` ("다음 단계").
2. **작업 트레이 (Task tray) label** + **`minChips`** (minimized layout cards — from the window engine's `cardMin`, tag = card title abbreviation, click restores) + **`dockItems`** (parked task-detail modals — from `state.docked`, tag = kind, shows ref+title, a pulsing dot if `draftOn` i.e. has unsaved comment text, click restores via `restoreDock`, separate X dismisses without restoring).
- Empty state: "보관한 결재·최소화한 카드가 여기에 쌓입니다" placeholder text when both `minChips` and `dockItems` are empty.
- "모두 닫기" (clear all) button at the far right.

## Modals inventory

All modals share the pattern: fixed-inset semi-transparent backdrop (click-to-close), a `role="dialog" aria-modal="true"` panel, `pop-in` entrance animation, and (except passkey/palette) a draggable header (`draggable onDragStart=onSnapDragStart`) that lets the user drag the whole modal onto a quadrant drop-zone to pin it as a panel instead of closing it.

1. **TASK DETAIL MODAL** (`modalOn`) — the primary work-item modal, 3 body variants sharing a common header (kind chip/ref/due, pin/dock/close buttons) and common metadata grid (법인/부서·현장/기안or배정/상신/금액) + detail paragraphs + files + linked-objects chips + stats/sparkline block:
   - `modalApproval` — 결재선 (approval chain chips, each clickable to open a role-reassignment menu; dashed "추가" chip to append a stage via a 2-step role→person picker), comment textarea (required for reject/return), media/object tag picker, footer buttons 거부/반려/승인.
   - `modalHrIssue` — (for 근태 이상 rows) optional 연장 시간 quick-pick chips + 업무 범위 연결 chips (only when `hrOtOn`, i.e. an OT-type issue), comment textarea, tag picker, footer 소명 요청 / 처리-label button (dynamic `hrResolveLabel`).
   - `modalDispatch` — driver radio-list (`mDrivers`, ETA badge, note), footer 취소 / 배차 확정.
   - Header actions: **pin** (`onModalPin` → converts to a panel via drag-equivalent), **dock** (`onModalDock` → parks in the tray, preserving comment/tags/extras draft state), **close** (`onModalClose`).
2. **CALENDAR MODAL** (`calOpen`) — month grid (prev/next nav, 주간/월간 toggle [주간 is a stub — only 월간 implemented]) + day cells (`calCells`, event/todo chips, "+N more" overflow) + a right rail (270px) showing the selected day's schedule items and a quick-add input (only when the selected date is within the demo week — otherwise "시연 데이터 없음"/"일정 없음" placeholders).
3. **MAIL MODAL** ("크게 열기" expanded view, `mailModalOn`) — full-width version of the rail mail-read view, same reply mechanics.
4. **TEAM CARD** (`tcOn`) — org-chart team popover: name/path header, 책임자(head, clickable→person card)/인원 grid, 팀원 명부 / 팀 채널 buttons.
5. **ENTITY CARD** (`entCardOn`) — org-chart entity(법인) popover: initial-badge/name/meta header, 대표이사/설립/사업자번호/소재지/조직 grid, 조직 개편 결재 / 법인 상세 buttons.
6. **PERSONNEL CARD** (`personOn`) — the richest modal: photo placeholder + name/title/emp-no + team/entity/재직 status header; tiered-disclosure info sections each carrying an explicit PBAC visibility badge ("전체 공개"/"팀 내 공개"/"관리자 · 열람 기록됨"/"민감 · 인사 책임자") — 기본 정보 (ext/joined/email, always visible), 직무 정보 (job/position, team-visible), 최근 업무·KPI (hours/open/done stats + linked work-item chips, admin-viewable+logged), 상세 정보 (emergency contact/bank account/address, gated behind an explicit "열람 — 기록 남음" reveal button that logs an audit view event on click — `pDetailClosed`→`pDetailOpen`), and an "인사 관리 모드" (admin mode) collapsible section with 고용 이력 (employment history timeline) + masked 급여 정보 (payroll, needs a separate 열람 reveal) + `pActions` action buttons. If viewing self (`pMeOn`), footer shows punch-out/logout instead of message/mail. This encodes the read-gate pattern: **sensitive fields are masked by default and every reveal is a distinct logged action**, not just page-load visibility.
7. **PASSKEY MODAL** (`pkModalOn`) — the 개인 수신함 (personal inbox) legal-document read-gate: doc kind/ref/title header, animated fingerprint scan UI (idle→scanning→done states via `pkPhase`), legal-basis badge, cancel/authenticate buttons. See `02-screens/docs-policy-inbox-audit.md` for the full `pkStart→pkAuth→inboxConfirm` flow — this is the compliance-critical UX pattern for 근로계약/취업규칙/연차촉진/노무수령거부 documents.
8. **SEARCH PALETTE** (`paletteOpen`) — see below.

## Search palette

- Trigger: topbar search button, or global `⌘K`/`Ctrl+K` (`handleKey`, toggles open/close).
- On open (`openPalette`): resets query + selection index to 0, focuses the input after a 60ms timeout (post-render focus).
- `searchResults()` — when query empty: first 4 pending task rows + first 5 screen rows. When query non-empty: fuzzy substring match (label+hint, lowercased) across task rows, then `MEMBERS` (people) rows, then screen rows, capped at 12 total. Screen rows resolve through a `realScreens` map (only `인사 관리/채용/조직도/평가/급여/근태` are real navigations in-snapshot — the other 15 listed screen names in `screenDefs` — 재무/구매/재고/자산/배차/정비/전자결재[note: 전자결재 IS real via nav but not in this stub list]/문서·기록물/감사 로그/대시보드/객체 탐색/워크플로 스튜디오/게시판·공지/주소록 — render with a `stub: true` "다음 단계" tag).
- Keyboard nav (`paletteKey`): ArrowUp/Down move `paletteIdx`, Enter runs the selected result's `.run()`, Escape closes.
- Task rows navigate via `openDetail(id)`; screen rows via `setState({screen})`; people rows are stubs in-snapshot ("프로필은 다음 단계 범위입니다").

## Esc / keyboard chains (`handleKey`)

Global `keydown` listener (attached in `componentDidMount`). Priority-ordered dispatch:
1. `⌘/Ctrl+K` → toggle palette (always first, works everywhere).
2. If palette open → all other keys ignored (palette owns its own `paletteKey` handler on its input).
3. **Escape** — a strict priority chain, each level consuming the Escape and returning (only the topmost open thing closes per press, enabling "Esc-Esc-Esc" to peel back layers):
   1. Any of hr/review/att/pay in `cardMode.kind === "modal"` → exit that card's modal-zoom mode.
   2. Calendar modal open → close it.
   3. Team card open → close it.
   4. Entity card open → close it.
   5. Person card open → close it.
   6. Task detail modal open → (if a sub-popover — add-approver/tag-picker/role-menu — is open, close just that first; otherwise close the whole modal).
   7. Rail not at home (thread/mail-read view) and rail not collapsed → return rail to home view (also closes scope/quick/mention dropdowns as a side effect).
   8. Any panels pinned → pop the LAST pinned panel off (`panels.slice(0,-1)`) — each Escape removes one panel, most-recent first.
   9. Fallback → clear all transient UI flags at once (scope dropdown, quick-action menu, mention popovers, toast, role-menu, layout-preset menu, card hover toolbar/split-menu).
4. If a task modal is open, no further key handling (modal owns focus).
5. If focus is in an `<input>`/`<textarea>`, no further key handling (don't hijack typing).
6. **Screen-specific `j`/`k`/Enter list navigation**: on `hr` screen, `hrFiltered()` roster list; on `leave` screen, `LV_EMP` list; both move a named selection (`hrSel`/`lvSel`) and Enter opens that person's card. Falls through to a **global** `j`/`k`/Enter handler operating on `flatPendingIds()` (the flattened now/today/wait pending task queue from Overview) for any other screen — `selectedId` moves, Enter calls `openDetail`.

This means `j`/`k`/Enter act as a universal "select next/prev, open" pattern across the Overview task inbox AND (screen-specific override) the HR roster and Leave roster tables — a reusable list-navigation convention worth preserving in the carbon copy.

## Responsive breakpoints (verified in snapshot)

- **`vw < 1280`** — sidebar and rail auto-collapse to icon-only rails (62px / 54px) unless the user has manually pinned them open/closed (`sbUser`/`railUser` override the auto rule once touched).
- **`vw < 1560`** — rail open-width shrinks from 336px to 300px (still full, just narrower).
- **`vw < 1024`** — the window/pin engine (`01-window-engine.md`) switches to `narrow` mode: all cards in hr/review/att/pay stack full-width single-column regardless of main/side split; grabbing a card header immediately pins it (bottom sheet, 42vh) instead of free-floating; org-chart column min-width collapses to 180px (from a wider auto value). Overview's work-zone (`wzWrap`) also switches from `nowrap` (two-column: action inbox + today/plan) to `wrap` (stacked) below 1024px OR whenever any quadrant panel is pinned (panels force narrow layout even on wide viewports, since they eat horizontal space).
- **No genuine `<768` "mobile shell" (distinct tab-bar/bottom-sheet nav) exists in the Jul-4 snapshot.** The only artifact resembling a mobile app is `Oyatie Mobile.dc.html`, which is a thin wrapper (`ios-frame.jsx` device chrome) that just iframes the SAME `Oyatie Console.dc.html` at phone width — i.e., in-snapshot, "mobile" = the same responsive console rendered narrow, with no dedicated bottom tab bar. **UNVERIFIED-AGAINST-SNAPSHOT**: `05-post-snapshot-todo-digest.md` (office-shell entry) describes a post-Jul-4 addition where `<768px` becomes a distinct 7-screen employee app (메신저·메일·알림·주소록·게시판·수신함·전자결재 only) with a bottom tab bar (5 tabs + "더보기" sheet, 48px height, safe-area aware, unread badges) that redirects disallowed screens to messenger. This is a real behavioral addition not present in the html file — carbon-copy builders should treat it as a separate, later-dated spec, not part of the base shell.

## `.console` theme token usage

The `.console` root element declares the full token set as inline CSS custom properties (light values by default; `.t-dark` class or `.t-light` class override; absent either class, a `@media (prefers-color-scheme: dark)` block re-declares the dark set so OS-level dark mode "just works" without JS). Token families consumed throughout every screen/modal/rail component via `var(--token)`:
- **Surface/canvas**: `--canvas` (page bg), `--surface` (card/modal bg), `--muted` (subtle fill, hover bg, badges), `--border`, `--border-soft` (two border weights).
- **Text**: `--ink` (primary text), `--steel` (secondary text), `--faint` (tertiary/meta text).
- **Brand**: `--signal` / `--signal-deep` (primary CTA yellow, e.g. "직원 등록" buttons, brand mark), `--teal` (interactive/link accent, e.g. person-name links).
- **Semantic status pairs** (`-bg`/`-bd`/`-tx` triplets, plus a `-solid` for dots/bars): `--danger-*`, `--warn-*`, `--ok-*`, `--info-*`, `--accent-*` (used for 결재 kind chips), `--purple-*` (used for linked-object chips and mention/tag pills).
- **Elevation**: `--shadow` (resting cards), `--shadow-pop` (modals/popovers).
- Dark mode remaps every token (not just inverting ink/canvas) — status colors shift to higher-saturation variants for contrast (e.g. `--ok-solid` `#059669`→`#34d399`).

A carbon copy should implement this as a CSS custom-property theme file (light + dark) mirroring these exact token names, since every component in the template references them by `var(--x)` rather than hardcoded hex — the design system IS the token set.
