# Oyatie Console.dc.html — Template inventory (lines 1–3413 of 7,871)

Source: `docs/design/oyatie-console/Oyatie Console.dc.html`. Template = lines 1–3413; logic class starts line 3415. support.js = generated dc-runtime (React-based `.dc.html` runtime: `sc-if`/`sc-for`/`{{ }}` bindings, `style-hover`/`style-focus`, DCLogic base). styles.css imports tokens/*.css (bundled under docs/design/oyatie-console/tokens/ — colors/typography/spacing/elevation with real console values) but the prototype itself does NOT consume them — the helmet `<style>` (lines 15–75) is the authoritative token source; reconcile both when formalizing.

## 1. Layout shell

Root `div.console` flex column 100dvh overflow-hidden, Pretendard, 13px base, word-break:keep-all. Row = sidebar + main + comms rail; below: docked task bar.

- Sidebar (81–126): width `{{ sbW }}` collapsible (.18s). 56px header: amber "A" logo tile, "Acme Group / 그룹 통합 운영 콘솔", theme-cycle button. Nav groups → items (16px stroke SVG icon, label, count badge / red dot when collapsed). Groups: 워크스페이스(통합 개요/내 업무/개인 수신함), 인사(인사 관리/채용/조직도/평가), 근무·보상(급여/근태/연차/복리후생), 거버넌스(전자결재/문서·기록물/권한·정책/감사 로그), 자동화(워크플로 스튜디오/예약 작업 → screen:"auto"+autoTab).
- Topbar (131–171): 56px — palette trigger (⌘K/Ctrl K kbd chip), scope switcher (법인 dropdown, pop-in, check on current), user button (avatar 전, 전성진 · 경영지원팀 · 그룹 관리자 → me person card).
- Quadrant split container (173–313): grid 1fr 1fr / 1fr 1fr, gap 2px. Page `<section>` uses `grid-area:{{ dashArea }}`; `sc-for panels` renders pinned detail panels each `grid-area:{{ pn.area }}` → true split into halves/quadrants. Empty-slot placeholder (dashed, "빈 화면 — 상세를 끌어다 고정").
- Page body (316): per-screen scroll region; `padding-right:{{ bodyPadRightPx }}` / `padding-bottom:{{ bodyPadBottomPx }}` reserve REAL space for right-pinned cards/tray (reflow, not overlay).
- Comms rail (2399–2635): right aside, `{{ railW }}` = 54px strip / 300–336px open. Views: home (stacked accordion sections 메신저/메일/알림/공지), thread, mail-read.
- Docked task bar/tray (2638–2695): bottom bar — 빠른 작업 lightning popover, 작업 트레이 minimized chips `{{ minChips }}`, docked drafts `{{ dockItems }}` (kind tag+ref+title+draft dot+dismiss), 모두 닫기.
- Snap drop zones (2378–2396): during header drag — 4 corners (28%×32%), 4 edges, center none-zone + dashed preview rect + label chip `{{ zpLabel }}`.

Screen switching: overview/org via sc-if; hr/review/att/pay stay MOUNTED, toggled by computed style (pos/vis/pe/h) so card layout survives; appr/leave/benefit/docs/policy/inbox/audit via display wrappers.

## 2. Screens (state.screen)

- **overview 업무·운영 개요** (318–515): header + date; KPI strip (auto-fill minmax(150px,1fr)) clickable stat pills. Two columns: Action inbox — 처리 대기 count, filter chips w/ counts, grouped draggable rows (kind chip, title+mono ref, entity·site·who·amount, due, primary action or done), empty state + undo, hint bar "J/K 이동 · ↵ 상세 · ⌘K 검색". Today/Plan — day title+progress, punch status, 7-day week strip + month button, schedule/todo list (time, dot/check, scope chip, title, person link, due, linked-object ref chips), @mention popover, quick-add input (accepts drops).
- **hr 인사 관리** (517–682): header + 직원 등록 CTA + 배치 preset menu + 기본 배치 reset; KPI strip; card zone: 직원 명부 card (search, 7-col table 이름/부서/직무/법인/근태/내선/입사, rows open person card, J/K/Enter, bottom fade), 근태 이상·오늘 card (typed rows + 확인 action, 예정 인사 일정 mini-list).
- **org 조직도** (684–790): edit-mode toggle; tree: group root card → connector lines → per-법인 columns (entity card, i button, rename in edit) → sites (drop target for team drag) → teams (draggable in edit, click team card, remove ✕). Edit adds +팀/+사업장/+법인.
- **recruit 채용** (792–886): 공고 등록 CTA; postings table (공고·사업장 / 충원 progress / 단계 chips / 마감) → row expands candidate list (stage chip, name, 보류/보충 badges, next-stage button, ⋯ menu 보충 서류/보류/탈락, rejected footer "사유 기록됨 · 인재풀 보관"). Legend 접수→서류→면접→오퍼→입사.
- **review 평가** (888–992): header (2026 상반기 · 7/18 마감) + presets; cards: 팀별 진행률 (progress bars), 내 평가 할 일 (due chip, person, 작성 CTA).
- **att 근태** (994–1350): KPI strip; 4 cards: 근무 현황 (오늘/월간 toggle — day: site rows w/ 출근/예정, 충원율 bar, 예외 chips, 대근 action, drag column-resize handles; month: pager + drill breadcrumbs 그룹→법인→사업장→개인, 출근율/지각/결근/연장/daily heat cells, 7-color legend), 주 52시간 모니터 (hour bars w/ 52h cap marker, 근무 조정), 근태 예외·오늘, 6월 근태 마감 (per-entity checklist, 마감 확정 CTA gated on exceptions, 급여로 이동 link).
- **pay 급여** (1352–1632): header (지급일 7/10 · 1,284명) + status chip + contextual CTA; 5-step stepper 근태 마감→계산→예외→상신→이체. 4 cards: 급여 명부 (gated "계산 전" lock → searchable 7-col table + delta/예외 flags, audit notice), 예외 검토 (gated → expandable rows + linked-object chips + 확인/보류), 지급 총액 (₩41.8억 hero + per-entity bars + facts), 지급 일정 (timeline + retry note).
- **appr 전자결재** (1634–1866): tabs 결재함/상신함/기안 (+counts). 결재함: rows → approval modal; 내 결재 완료·종결 대기 progress w/ step-dot timelines. 상신함: my docs (status chip + timeline) + inline 종결/대행(Cedar override)/사후 반려. 기안: template gallery (8) → compose: 제목, 사유 유형 chip picker, 상세 textarea (@mention/drag-link), 첨부, 대상 지정 (chips + 개체 연결 popover, validation), auto 결재선 preview, 상신/취소. Right rail: 내 급여 명세 → personal inbox doc.
- **leave 연차** (1868–1973): KPI strip; 직원별 연차 현황 table (부여/사용/잔여/소진율 bar + 촉진 badge, J/K) + right stack: 연차 승인 대기 cards (승인/반려/거부), 연차 사용 촉진 panel (round chip, 촉진 통지 상신 → AP- + personal inbox, 노무수령거부권 after round 2; 근로기준법 §61).
- **benefit 복리후생** (1975–2054): tabs 법정/법정외; KPI strip; table (제도/대상/월 비용/비고) → row expands 정책 수명주기 panel: lifecycle chip + advance CTA, legend draft→승인→확정→시행→폐지 예정→폐지, tier table (직급/근속 차등), 적용 조건 chips + 조건 편집 (Cedar no-code entry).
- **docs 문서·기록물** (2056–2105): 내보내기; KPI strip; filter chips + search; archive table (코드/제목/유형/작성·담당/종결일/보존), row = "기록물 열기 — 열람 감사 기록".
- **policy 권한·정책 Cedar** (2107–2162): 새 정책 CTA; KPI strip; rule rows (effect chip permit/forbid, NL sentence, status chip) → expands 누가→무엇을→액션 triple + provenance + 시뮬레이션/규칙 편집 buttons.
- **inbox 개인 수신함** (2163–2269): header (전성진 · 본인, 확인 필요 N chip). List: filter chips, doc rows (kind icon, title + chip, sub, lock icon if passkey-gated, check if confirmed). Doc view: kind/ref/legal-basis chips, from·date; locked → passkey unlock button ("본인 인증 후 열람 / 열람이 곧 법적 수령 확인입니다"); unlocked → payslip layout (실수령액 hero + 기본급/수당/−공제 grid + "본인 열람은 감사 대상이 아닙니다") or paragraphs, 수령 확인 완료 banner, 연결 개체 chips.
- **audit 감사 로그** (2271–2358): header (실시간 pulse, standards shield chip, 오늘/정책 거부/이상 counters, 내보내기); search + filter chips + correlation chip; day-grouped rows: time mono, actor, action + category icon, target code link, anomaly chip, classification chip, Cedar decision badge → expanded: 사유, before→after diff, fact grid (주체·인증/기기·브라우저/위치·IP/분류/정책 결정/세션·상관ID/무결성 해시 체인 #seq·hash←prev), 개체로 이동 / 연관 이벤트.
- **auto 워크플로 스튜디오/예약 작업**: NAV STUB — nav items + autoScr computed but NO template section exists. renderVals contract exists (§ logic inventory). Net-new UI design needed.

Overlay "screens": task detail modal (draggable-snap header, fact grid, sparkline SVG, 3 variants approval/hrissue/dispatch w/ editable 결재선 + two-step 추가 popover + tag chips), calendar modal (month/week, agenda + quick-add), mail modal, team card, entity card, personnel card (tiered disclosure: 기본 정보 전체 공개 / 직무 정보 팀 내 / 최근 업무·KPI 관리자·열람 기록됨 / 상세 정보 민감 — masked + "열람 — 기록 남음" button / collapsible 인사 관리 모드), passkey gate (fingerprint scan/done animations), search palette (⌘K).

## 3. Component grammar

**Card/window model** (hr/review/att/pay card zones): states default (abs-positioned per preset; bottom-edge + corner resize) / popout (header drag ≤54px or tool → position:fixed 468×412 shadow-pop z:80; drag over tray = minimize) / pin (double-click or tool = cardPinRight — right dock + body padding-right reservation; bottom dock <1024px) / minimize (tray chip, restore navigates+pops). Hover 3-button toolbar (pin/minimize/close=restore-default) + split submenu. Layout presets per screen (default 63:37/focus 74/compare 50:50/stack) + draggable split bar (0.42–0.78, snap stops .5/.63/.74) + drop indicator + persistCards().

**Pinned detail panels** (sc-for panels): shared header (kind chip, mono ref, title, due, minimize/popout/close) + 5 bodies: isTask, isApproval (결재선 chips w/ step state, drop-accepting comment, 거부/반려 outline + 승인 solid, reason-required), isDispatch (driver radios + ETA + 배차 확정), isMail (quick-reply), isPerson (fact grid + 메시지 CTA).

**Modals**: role=dialog aria-modal, backdrop rgba(10,14,18,.46), pop-in, min(680px,94vw), radius 13. All headers draggable to snap zones.

**Toast** (2362–2376): bottom-center dark, toast-in, optional 실행 취소 undo + close.

**Reference tokens/chips**: mono refs (AP-3108 etc.); 2-char kind chips w/ per-kind bg/bd/tx; linked-object chips clickable → target object.

**Drag & drop**: draggable sources = inbox rows, rail mails; targets = quick-add/composer/reply/comment inputs (attach ref), org sites (team move), snap zones (split-pin), tray (minimize). Card drag = mouse events; list/snap headers = HTML5 DnD.

**Keyboard**: ⌘K palette, J/K + Enter on overview inbox/HR roster/leave table, Esc cascade.

**Column resize**: att day-view header drag handles; card bottom/corner; main/side split bar.

**Search inputs**: 12px icon + borderless input on --canvas.

## 4. Tokens (helmet lines 25–68 = source of truth; light + full dark theme; theme cycle light→dark→system)

- Neutrals: --canvas #f2f4f7, --surface #fff, --muted #eceff3, --border #dbe1e8, --border-soft #e8ecf1, --ink #141a21, --steel #566475, --faint #8b98a7.
- Brand: --signal #f6b521 (amber, primary CTAs), --signal-deep #e2a30d, --teal #0f766e (person/entity links).
- Status triads bg/bd/tx(+solid): --danger-* (#fef2f2/#fca5a5/#b91c1c/#dc2626), --warn-*, --ok-*, --info-*, --accent-* (amber chips), --purple-*.
- Elevation: --shadow (0 1px 2px), --shadow-pop (floats/popovers/toasts).
- Usage freq: ink 320, faint 319, steel 280, border 233, muted 231, surface 152.

Type: Pretendard Variable; 13px/1.5 base; H1 17px/800/−0.3px; sections 12–12.5px/800; meta 10–11.5px; micro 9–10px/800 + ls .5–.9px; KPI 15px/800. Weights 600/700/800/900. Mono = ui-monospace/SF Mono/Menlo for refs/amounts/dates/hashes/IP/kbd. Radii 4–13 (chips 5–6, buttons 7–8, cards 9–11, modals 13). Dense: gaps 2–12, pads 5–15, 56px headers, 2px gutters. Chips = 1px border + tinted bg + same-hue dark text; primary solid = ink bg/surface text; brand CTA = signal.

Keyframes: toast-in, pop-in (.12–.15s), pulse-dot, pk-spin, pk-pulse; prefers-reduced-motion kill.

## 5. Icons

Inline 24×24 stroke SVGs (fill:none, stroke currentColor, w 1.6–3.5, round caps; Lucide-style), path `d` injected from ICONS dict (logic 3433+): overview inbox users userPlus network circleCheck calc clock calCheck heart receipt cart box layers truck wrench mapPin checkSq shieldCheck fileCheck folder history chart trend share gauge workflow repeat msg mail bell megaphone book plus pen sun moon monitor mailbox fingerprint lock lockOpen scroll gavel eye ban activity download alert + pin minz close. Many literal paths in template (search, chevrons, check, ✕, back, calendar, paperclip, send, kebab, corner-expand, collapse).

## 6. Korean specifics

Korean-only UI; keep-all breaking. Load-bearing vocab: 결재/상신/반려/거부/종결/대행/사후 반려, 기안, 결재선, 법인/사업장/팀, 근태/연차/촉진/노무수령거부권 (근로기준법 §61), 4대보험, 주 52시간, 대근, 소급 보정, 수령 확인. Dates 2026년 7월 3일 (금), 7/3 (금), ranges 6/29–7/5. Currency ₩41.8억, mono amounts, 1,284명. Compliance copy in UX: "감사 로그에 기록됩니다", "열람 — 기록 남음", masked PII 010-••••-38.

## Watch-outs

(1) auto screen = zero template, net-new. (2) Quadrant split (dashArea + panels[].area) + bodyPadRightPx space reservation are the non-obvious mechanisms. (3) All styling inline — the helmet token list is the design system to formalize; bundled tokens/*.css should be reconciled against helmet values (helmet wins on conflict).
