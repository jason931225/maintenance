# 02 — Screens: ATTENDANCE (근태, `att`) + PAYROLL (급여, `pay`)

Source: `Oyatie Console.dc.html` — template ATT lines 994-1352, template PAY lines
1352-1634, methods ~4225-4280 / 5396-5495, seed data ~3523-3610, `renderVals()`
bindings ~5896-6072 + ~7210-7410 + ~7654-7665.

Card pin/float/tray mechanics are NOT re-derived here — see
`01-window-engine.md`. This doc only lists which cards each screen registers
and what each card's *content* does.

Card registration (`CARD_META`, line 3592-3597):

```js
att: { off: 214, main: ["board"], side: ["ex", "close", "w52"], min: { board: 360, ex: 172, close: 236, w52: 196 } },
pay: { off: 240, main: ["reg"],   side: ["ex", "cost", "sched"], min: { reg: 360, ex: 216, cost: 238, sched: 186 } }
```

Card titles (`CARD_TITLES`, line 3598-3603):

```js
att: { board: "근무 현황", ex: "근태 예외", close: "근태 마감", w52: "주 52시간 모니터" },
pay: { reg: "급여 명부", ex: "예외 검토", cost: "지급 총액", sched: "지급 일정" }
```

---

## 1. ATTENDANCE (`att`)

### 1.1 Layout anatomy

- **Header** (`data-screen-label="근태"`, line 996-1030): title "근태" + static
  subtitle line `7/3 (금) 실시간 현황 · 6월분 마감 {{attCloseHead}}` (not a
  caption per DESIGN §4-12 — it's the live closing-status readout, computed from
  `attCossClosed`). Right side: 배치 (layout preset) menu button + popover list
  (`attLayPresets`, 4 presets shared with window-engine doc), conditional 기본
  배치 (reset layout) button when `attLayCustom`, and 월 근무표 (monthly
  worksheet) button — currently a stub (`onAttSheet` → toast "다음 단계 범위").
- **KPI strip** (line 1033-1041): `attKpis` — compact 1-row stat bar (grid
  `auto-fill minmax(150px,1fr)`), 4 items:
  1. 출근율 · 오늘 (today's attendance rate %)
  2. 지각 · 결원 (late count · absent count, combined string)
  3. 주 52시간 임박 (count of employees at risk of 52h/week breach)
  4. 6월 마감 (closing progress "N / 4" corporate entities)
- **Card zone** (`attZoneRef`, line 1043+): registers `board` (main),
  `ex`/`close`/`w52` (side). Drop-indicator, split-bar, hover-toolbar, and
  modal-backdrop plumbing is the generic window-engine machinery (see
  01-window-engine.md) — not re-described here.

#### Card: `board` (근무 현황) — main, lines 1074-1234

- Header row: title, **오늘/월간 segment toggle** (`onAttViewDay` /
  `onAttViewMonth` → `attView` state), month-nav (prev/next month arrows +
  `attMonthLabel`, only visible when `attMonthOn`), `attBoardMeta` (live
  monospace counter: day-view = "출근 N / 예정 M"; month-view = "근무일 N일"),
  `attBoardHint` (right-aligned dynamic hint, e.g. "출입기록 연동 · 실시간" /
  "마감 확정 반영" / "마감 전 잠정 집계" / "진행 중 · 7/3 기준").
- **Two mutually-exclusive sub-views** gated by `attDayOn` / `attMonthOn`
  (`s.attView === "day" | "month"`):

**Day view** (`attDayOn`, default true) — table of `attSites` (per-site
staffing board), columns: 현장(site, resizable via `attDayCol.h0-h3` drag
handles) / 출근 · 예정 (in / plan) / 충원율 (coverage % bar) / 예외 (지각/결원
chips) / action column. Row affordances:
  - Site-name button (`sr.onSite`) → opens `teamCard` panel (site info, not
    drill — see §1.2).
  - 대근 편성 (arrange substitute) button (`sr.onAct`, shown full-label or
    icon-only mini depending on `attDayActFull`/`attDayActMini` computed from
    resizable column width) — only when `r.act && absent>0` and not already
    requested; marks `attSubbed` and shows toast. Once requested shows a
    "요청됨" (requested) badge/chip instead (`subbedOn`).
- Legend footer row: 정상/지각/연장/유급휴가/결근(무급)/휴일/예정 color key +
  hint "집계는 마감 기준 · 칸에 마우스를 올리면 날짜·상태".

**Month view** (`attMonthOn`) — org-drill attendance matrix, built from
`buildAttMonth(month)` (see §1.5):
  - **Breadcrumb row** `attCrumbs` (line 1098-1104): 그룹 전체 → 법인 → 사업장
    → 팀, each crumb clickable except the last (drills back up via
    `attPath` truncation). Hint text: "행 클릭: 하위 단위 · 이름 클릭: 인사
    카드".
  - **Summary row** (`attMSum`, pinned above the drill rows): aggregate for
    the *currently selected node* — name/sub, 출근율 progress bar + %, 지각
    count, 결근 count, 연장(OT) hours, and a day-cell strip (`attMSum.cells`,
    one cell per calendar day, colored by aggregate rate).
  - **Drill rows** (`attMRows`): when `depth < 3` these are child org units
    (법인/사업장/팀) — row click (`mr.onRow`) pushes an index onto
    `attPath` to drill deeper; an info-icon button (`mr.onInfo`) opens
    `entCard`/`teamCard` panel instead of drilling. When `depth === 3`
    (inside a team) rows become **persons**: name is a clickable button
    (`mr.onWho` / `mr.onRow` → `openPerson`) for known employees, plain text
    for synthetic/unknown ones; each row shows rate/late/abs/ot + a per-day
    color-cell strip (`mr.cells`).
  - Row cap: 60 persons per team (`attMCapOn`/`attMCapNote` — "구성원 N명 중
    60명 표시 — 전체 목록은 검색을 사용하세요"), no client-side search wired
    yet.

#### Card: `w52` (주 52시간 모니터) — side, lines 1236-1275

- Header: title, static week range "6/29–7/5", 한도 52h legend swatch.
- List `att52` (from `WEEK52` seed): per person — name button (`onWho` →
  `openPerson`), team, horizontal progress bar (`curW`) with a danger-line
  marker at the 52h threshold, current hours (`cur`) + projected hours
  (`proj`, colored by risk tone).
  - 근무 조정 (adjust schedule) button (`onAct`, only for `tone === "danger"`
    and not yet handled) — pushes a `todo` scheduler item onto today's
    `schedByDay` ("Wname 주 52시간 근무 조정 협의") and marks `att52Handled`;
    shows a "요청됨" chip afterward (`handledOn`). Non-risk rows show "—"
    (`noneOn`).

#### Card: `ex` (근태 예외) — side, lines 1277-1305

- Header: red dot, title, live count `{{hrIssueCount}}`, hint "처리 후 마감
  가능".
- List `hrIssues` (from `HR_ISSUES` seed): each row is a clickable card
  (`iw.onOpen` → `openHrIssue(id)`, opens the issue detail panel) showing a
  type chip (지각/미출근/연장), name button (`iw.onWho` → `openPerson`), and
  detail line. 확인 (acknowledge) button (`iw.onHandle`, same
  `openHrIssue`) while unhandled; "처리됨" chip once in `hrHandled`.

#### Card: `close` (근태 마감) — side, lines 1307-1348

- Header: title "6월 근태 마감" + status chip `attCloseChip` ("완료" /
  "기한 7/4 (토)").
- Rows `attCloseRows`: one per corporate entity (KNL 물류, BESTEC OEM, HR
  스태핑, ㈜코스) — checkmark icon when `done`, amber dot + "미처리" text
  when waiting. Three of the four entities are hardcoded `done: true`; only
  ㈜코스 gates on live state `attCossClosed`.
- Footer action area (mutually exclusive on `attCloseReady` /
  `attCloseBlockedOn` / `attCloseDoneOn`):
  - **㈜코스 마감 확정** button (`onAttConfirmClose`) — enabled only when
    zero unresolved 근태 예외 (`attCloseReady = attIssuesLeft === 0 &&
    !attCossClosed`).
  - Blocked state: warning banner "근태 예외 N건 처리 후 마감할 수 있습니다".
  - Done state: success banner "4/4 법인 마감 — 급여 계산 가능" + **급여로
    이동** link (`onAttGoPay` → `setState({screen:"pay"})`).
  - Static note: "마감 후 수정은 소급 보정으로 기록됩니다" (retroactive
    correction disclosure — allowed under DESIGN §4-12 since it's a real
    governance statement, not filler).

### 1.2 Interactive affordances summary

| Affordance | Location | Action |
|---|---|---|
| 배치 (layout preset) menu | header | opens preset popover, picks a saved card arrangement (window-engine) |
| 기본 배치 reset | header | resets card layout to default |
| 월 근무표 button | header | stub toast, "다음 단계 범위" |
| 오늘/월간 segment | board card | toggles `attView` day/month |
| month prev/next arrows | board card (month view) | `attMonth` -1/+1, clamped 6..7 |
| breadcrumb crumb click | board card (month view) | truncates `attPath`, jumps up the org tree |
| drill row click | board card (month view) | pushes index onto `attPath`, drills into 법인→사업장→팀 |
| row info-icon | board card (month view) | opens `entCard`/`teamCard` panel without drilling |
| person name click | board card (month view, day view site col via w52/hrIssues) | `openPerson(name)` → opens 인사 카드 panel, logs a 열람(view) audit event unless self |
| site name click | board card (day view) | opens `teamCard` panel with site staffing summary |
| 대근 편성 button | board card (day view) | requests substitute coverage, toast, marks `attSubbed` |
| 근무 조정 button | w52 card | adds a todo to today's scheduler, marks `att52Handled` |
| 확인 button / row click | ex card | `openHrIssue(id)` — opens exception detail panel (evidence, links, comment) |
| ㈜코스 마감 확정 | close card | `attConfirmClose()` — gated on zero open exceptions |
| 급여로 이동 | close card (post-close) | navigates to `pay` screen |
| column resize handles | board card (day view header) | drag to resize `attDayCols`, persisted in state |
| hover toolbar buttons | board/w52/ex/close card headers | window-engine pin/float/tray controls (see 01-window-engine.md) |

### 1.3 State keys

**Read:**
`s.attView`, `s.attMonth`, `s.attPath`, `s.attCossClosed`, `s.hrHandled`,
`s.att52Handled`, `s.attSubbed`, `s.attDayCols`, `s.scope` (org scope
filter), `s.orgData`, `this.PEOPLE`, `this.EMPLOYEES`, `this.ATT_SITES`,
`this.WEEK52`, `this.HR_ISSUES`, `this.ENT_ORDER`.

**Written:**
- `onAttViewDay`/`onAttViewMonth` → `attView`
- `onAttMPrev`/`onAttMNext` → `attMonth`
- drill row `onRow` → `attPath` (push)
- breadcrumb `onGo` → `attPath` (truncate)
- `sr.onSite` → `teamCard` (panel open)
- `mr.onInfo` → `entCard` or `teamCard`
- `sr.onAct` → `attSubbed` (append id)
- `w.onAct` → `schedByDay[selDay]` (append todo) + `att52Handled` (append id)
- `iw.onOpen`/`onHandle` → (indirectly) `hrHandled` via `openHrIssue` flow
- `onAttConfirmClose` → `attCossClosed = true`, prepends a `notifs` entry
  linking to `pay` screen
- `onAttGoPay` → `screen = "pay"`
- `attDayCol.h0-h3` (drag) → `attDayCols` (column widths)
- `onAttLayMenu`/`onAttLayReset`/preset pick → card layout state
  (window-engine)

### 1.4 Seed-data shapes

**`ATT_SITES`** (line 3547-3554) — per-site day-view staffing rows. One
object per site:

```js
{ id: "as1", site: "대원강업 상주", entity: "coss", ent: "코스",
  plan: 44, inn: 42, late: 1, absent: 1, tone: "danger",
  note: "야간 인계 공백 — 최민석", act: true, oi: [0, 1] }
```

Fields: `id: string`, `site: string` (display name), `entity: string`
(scope key: coss/bestec/knl/staff), `ent: string` (short label), `plan:
number` (scheduled headcount), `inn: number` (checked-in count), `late:
number`, `absent: number`, `tone: "ok"|"warn"|"danger"` (drives coverage bar
+ dot color), `note?: string` (only when non-empty; e.g. staffing gap
call-out), `act: boolean` (whether 대근편성 action is offered), `oi:
[number, number]` (packed-layout hint, likely for the offline/legacy grid
packing algorithm — not otherwise read in the excerpted renderVals code).

**`WEEK52`** (line 3556-3561) — 52-hour-limit monitor rows:

```js
{ id: "w1", who: "김성호", team: "정비사업팀", cur: 44.5, proj: 54.0, tone: "danger" }
```

Fields: `id: string`, `who: string` (employee name, resolved via
`openPerson`), `team: string`, `cur: number` (hours worked so far this
week), `proj: number` (projected end-of-week hours), `tone:
"ok"|"warn"|"danger"` (danger = projected to exceed 52h).

**`HR_ISSUES`** (line 3523-3527) — shared exception feed also used by the
`ex` card (근태 예외) here and by the HR screen:

```js
{ id: "hi1", type: "지각", tone: "warn", who: "조이슨", team: "사업운영팀",
  ref: "AT-0703-01", time: "오늘 09:34",
  detail: ["표준 출근 09:00 — 34분 지각.", "본인 제출 사유: 통근버스 지연 (진영 노선)."],
  evidence: [{ name: "출입기록_0934.log", size: "2KB" }, { name: "통근버스 운행기록.pdf", size: "88KB" }],
  links: [{ kind: "근태", label: "7월 근무표" }, { kind: "차량", label: "통근버스 진영 노선" }] }
```

Fields: `id`, `type: string` (지각/미출근/연장), `tone:
"warn"|"danger"|"info"`, `who: string`, `team: string`, `ref: string`
(document/ticket code), `time: string`, `detail: string[]` (detail panel
body lines), `evidence: {name, size}[]` (attached files), `links: {kind,
label}[]` (linked objects), optional `ot: true` marker on the 연장 (OT) case.

### 1.5 Methods

- **`attStatus(name, m, d, dow, teamKey, ovDay)`** (line 5396-5411) —
  deterministic per-person per-day status generator. Weekend (`dow 0|6`) →
  `"we"`. Future dates beyond 7/3 → `"fu"` (or `"plv"` if an override marks
  leave). If an explicit override (`ovDay`) exists, use it. Otherwise hashes
  `name+m+d` and `teamKey` into pseudo-random thresholds (team-hash-derived
  absence/late/leave/OT rates) to deterministically classify the day as
  `ab` (absent) / `la` (late) / `lv` (leave) / `ot` (overtime) / `ok`
  (normal). This is a **fixture/demo generator**, not a real attendance
  computation — the real backend must replace this with actual clock-in/out
  + leave-ledger aggregation.
- **`buildAttMonth(m)`** (line 5413-5489) — builds and memoizes
  (`this._attM[m]`) the full month drill tree: root ("그룹 전체") → 법인
  (`orgData` entities) → 사업장 (sites) → 팀 (teams) → 인원 (persons,
  synthesized via deterministic name generation for headcount not covered by
  real `EMPLOYEES`/team-head records, with a small hand-authored `OV`
  override table for specific named individuals' exception days). For each
  person, walks every day of the month calling `attStatus` and accumulates
  per-day/per-node aggregates (`att`, `den`, `late`, `abs`, `otH`, and a
  `day[]` array of `{a: attended, e: expected}` counts used for the
  day-cell heatmap strips). Aggregates roll up site→entity→root via
  `addAgg`.
- **`attConfirmClose()`** (line 4227-4234) — no-ops if any 근태 예외 remain
  unhandled (`attIssuesLeftN() > 0`) or already closed. Otherwise sets
  `attCossClosed: true`, prepends a notification linking to the `pay`
  screen, and shows a toast. This is the sole write-gate for month-end
  attendance closing (only ㈜코스 is interactively gated in the prototype;
  the other 3 entities are seeded as already closed).
- **`attIssuesLeftN()`** (line 4225) — `HR_ISSUES.length -
  state.hrHandled.length`; used both to gate `attConfirmClose` and to drive
  the `ex` card's live count and the `close` card's blocked/ready banners.

---

## 2. PAYROLL (`pay`)

### 2.1 Layout anatomy

- **Header** (`data-screen-label="급여"`, line 1354-1395): title "급여" +
  static subtitle "7월 정기 지급 · 산정 6/1–6/30 · 지급일 7/10 (금) · 대상
  1,284명" (period/payday/headcount facts, not filler). Right side: 배치
  menu + reset (same window-engine pattern as att), a status chip
  (`payHeadChip`, tone-colored: "승인 기한 7/8 (수) 16:00" / "결재 대기 ·
  기한 7/8 16:00" / "반려 — 재상신 필요" / "이체 예약 7/10 04:00"), and
  either a **CTA button** (`payCtaBtnOn`/`onPayCta`) or a static chip
  (`payCtaChipOn`) depending on pipeline stage.
- **5-step payroll pipeline strip** (`paySteps`, line 1397-1411): 마감 →
  계산 → 예외처리 → 상신 → 승인(이체). Each step is a numbered/checked
  circle + label + sub-status + connecting line. See §2.5 for the state
  machine (`stStates`/`stSubs`/`payCta`/`payChip`).
- **Card zone** (`payZoneRef`): registers `reg` (main), `ex`/`cost`/`sched`
  (side).

#### Card: `reg` (급여 명부) — main, lines 1443-1506

- Header: title, live count chip `payCount` ("N / 1,284"), and — only once
  calculated (`payCalcedOn`) — a search input (`payQ`/`onPayQ`, filters by
  name+법인+title substring).
- **Gate state** (`payGateOn`, i.e. not yet calculated): centered icon +
  `payGateRegText` message ("근태 마감 → 계산 실행 후 명부가 생성됩니다" /
  "계산 중 — 잠시만요" / "계산을 실행하면 1,284명 명부가 생성됩니다"). No
  table shown.
- **Calculated state** (`payCalcedOn`): table `payRows`, columns 이름(초성
  아바타+이름+직함)/법인/기본급/수당/공제/실지급/전월 대비. Row is fully
  clickable (`pr.onOpen` → `openPerson`) with a caption "인사 카드 열기 —
  급여 열람은 감사 로그에 기록됩니다" (a real audit disclosure, kept per
  DESIGN §4-12 exception for action-relevant/compliance text). Last column
  is one of: 예외 flag button (`pr.onFlag` → opens that exception in the
  `ex` card), 보류 badge (held-exception marker), or a plain 전월-대비 delta
  figure.
- Footer: "단위 ₩ · 공제 = 4대보험 + 소득세" and the audit-log disclosure
  repeated.

#### Card: `ex` (예외 검토) — side, lines 1508-1574

- Header: status dot (`payExDot`), title, live meta `payExMeta` ("남음 N /
  5" / "5건 완료" / "계산 대기"), hint "처리 후 상신 가능".
- **Gate state** (`payGateOn`): icon + `payGateExText` message + a
  **급여 계산 실행 / 근태로 이동** button (`onPayGate` — routes to `att`
  screen if attendance isn't closed yet, otherwise triggers `payRunCalc()`).
- **Calculated state**: accordion list `payExRows` (from `PAY_EX` seed).
  Each row: type chip, name (button → `openPerson`, or plain text when
  `noPerson`), right-aligned signed amount, one-line summary; expand/collapse
  on row click (`ex.onToggle`) reveals `lines` (detail paragraphs) and
  `chips` (linked objects — 근태/정비/메신저/직원 — each opens the relevant
  panel via `ch.onOpen`), plus **확인 처리** (`ex.onOk` → `payExAct(id,
  "ok")`) and **이번 회차 보류** (`ex.onHold` → `payExAct(id, "hold")`)
  buttons. Resolved rows collapse to a dimmed state with a 확인됨/보류 chip
  and lose the expand affordance.

#### Card: `cost` (지급 총액) — side, lines 1576-1610

- Header: title + tag `payCostTag` ("확정 계산" once `payCalced`, else
  "예상 · 전월 기준").
- Big number "₩41.8억" (hardcoded display figure in the prototype) + delta
  "전월 +1.8%".
- Per-entity breakdown bars `payEnts` (from `PAY_ENT_COST` seed): entity
  label, proportional bar, amount.
- Footer stat rows: "사업자 부담 · 4대보험+퇴직" (₩5.6억, static) and "지급
  계좌 상태" (`payAcct`/`payAcctColor`, live — reflects `payExDone.px5`
  resolution: 오류 1건 조이슨 / 보류 1건 조이슨 / 오류 0건).

#### Card: `sched` (지급 일정) — side, lines 1612-1630

- Header: title only.
- Timeline list `paySched`: 4 fixed milestones (7/3 계산·예외검토, 7/8 결재
  기한 16:00, 7/9 이체파일 은행제출, 7/10 04:00 이체·명세서발송), each with
  a status dot + 완료/진행/대기 label driven by `payStageN`/`payApproved`/
  `paySubmitted`.
- Footer note: "이체 실패 건은 당일 08:00 재시도 후 알림으로 보고됩니다"
  (action-relevant operational fact, not filler).

### 2.2 Interactive affordances summary

| Affordance | Location | Action |
|---|---|---|
| 배치 menu / reset | header | window-engine layout controls |
| header CTA button | header | runs `payCta.run()` — one of: go to `att`, `payRunCalc()`, `paySubmit()`, `payResubmit()`, open detail `pa1` |
| pipeline step click | steps strip | step 1 (근태마감, when active) jumps to `att`; step 4 (결재, once submitted) opens the AP-3124 approval detail |
| search input | reg card | filters `payRows` by 이름/법인/직함 substring |
| row click / name click | reg card | `openPerson(name)` — logs an audited 급여 열람 view |
| flag button | reg card | opens the linked exception in the `ex` card (`payExOpen = ex.id`) |
| 급여 계산 실행 / 근태로 이동 | ex card gate | `payRunCalc()` or navigate to `att` |
| exception row click | ex card | expand/collapse detail |
| linked-object chips | ex card (expanded) | opens the linked 근태 issue / 메신저 thread / 직원 card |
| 확인 처리 | ex card | `payExAct(id, "ok")` |
| 이번 회차 보류 | ex card | `payExAct(id, "hold")`, deferred to next payroll run |

### 2.3 State keys

**Read:**
`s.attCossClosed`, `s.payCalced`, `s.payCalcing`, `s.payExDone`,
`s.payExOpen`, `s.paySubmitted`, `s.payQ`, `s.scope`, `this.PAY_EX`,
`this.PAY_ROWS`, `this.PAY_ENT_COST`, `s.items` (for the `pa1` approval
item's done/doneTone to derive `payApproved`/`payRejected`).

**Written:**
- `payRunCalc()` → `payCalcing` (true, then false), `payCalced` (true after
  1.4s timer)
- `payExAct(id, kind)` → `payExDone[id] = kind`, closes `payExOpen` if it
  was that row
- `ex.onToggle` → `payExOpen`
- `onPayQ` → `payQ`
- `paySubmit()` → `paySubmitted: true`, prepends an `items` approval entry
  (`pa1`, ref AP-3124) and a `notifs` entry
- `payResubmit()` → removes the `pa1` item, `paySubmitted: false`
- `onPayGate`/`payCta` routing → `screen` (to `att`) or triggers the above
- `pr.onFlag` → `payExOpen = r.ex`

### 2.4 Seed-data shapes

**`PAY_EX`** (line 3563-3569) — payroll exception queue:

```js
{ id: "px1", who: "김성호", team: "정비사업팀", type: "연장수당", tone: "warn",
  amt: "+₩412,000",
  oneline: "6월 연장 14.5h — 전월 8.0h · 사전승인 없는 2h 포함",
  lines: ["연장근로 14.5시간 (전월 8.0시간) — 연장수당 ₩412,000 증가.",
          "7/2 연장 2시간은 사전승인 없음 — 근태 예외 AT-0702-07에서 확인 절차 진행."],
  chips: [{ kind: "근태", label: "AT-0702-07 연장 기록", hr: "hi3" },
          { kind: "정비", label: "WO-2638 조립라인 3호기" }] }
```

Fields: `id`, `who: string` (or a group label like "신규 입사 2명" with
`noPerson: true` set — see `px4`), `team: string`, `type: string` (연장수당/
소급 인상/결근 공제/일할 계산/계좌 확인), `tone: "warn"|"danger"|"info"`,
`amt: string` (signed currency string, or a non-numeric status string like
"지급 보류 위험" for the account-verification case), `oneline: string`
(collapsed-row summary), `lines: string[]` (expanded detail paragraphs),
`chips: {kind, label, hr?, thread?, person?}[]` (linked-object jump targets
— `hr` → `openHrIssue`, `thread` → `openThread`, `person` → `openPerson`),
optional `noPerson: true` when `who` isn't a resolvable individual.

**`PAY_ROWS`** (line 3571-3582) — payroll register line items:

```js
{ who: "김성호", title: "반장", entity: "coss", ent: "코스",
  base: "3,420,000", allow: "892,000", ded: "618,000", net: "3,694,000",
  delta: "+12.9%", dTone: "warn", ex: "px1" }
```

Fields: `who: string`, `title: string` (job title), `entity: string` (scope
key), `ent: string` (display label), `base/allow/ded/net: string`
(currency figures, pre-formatted with commas, no ₩ prefix — 기본급/수당/공제/
실지급), `delta: string` (전월 대비 %, signed), `dTone:
"warn"|"none"`, `ex?: string` (id of a linked `PAY_EX` row, if this person
has an open payroll exception).

**`PAY_ENT_COST`** (line 3584-3589) — per-entity payroll cost breakdown:

```js
{ ent: "HR 스태핑", amt: "₩15.1억", pct: 36 }
```

Fields: `ent: string` (entity label), `amt: string` (formatted currency),
`pct: number` (share of total, used to compute the bar width relative to
the largest entry — `Math.round(pct/36*100)+"%"`, i.e. 36 is hardcoded as
the max in the render code, a fixture shortcut that a real implementation
should replace with `max(...pct)`).

### 2.5 Methods

- **`payRunCalc()`** (line 4236-4243) — no-ops unless attendance is closed
  and calculation hasn't already run/is running. Sets `payCalcing: true`,
  then after a 1.4s `setTimeout` sets `payCalcing: false, payCalced: true`
  and toasts "계산 완료 — 1,284명 · 검토할 예외 5건". This is a **simulated
  async job** — the real backend replaces the timer with an actual payroll
  calculation run (reading closed attendance, contracts, statutory
  deduction tables) and should expose real progress/failure states.
- **`payExAct(id, kind)`** (line 4245-4254) — records `payExDone[id] =
  kind` ("ok" or "hold"), closes the expanded row if it was open, and
  toasts a message that includes the running count of remaining
  unresolved exceptions (so the UI is state-driven, not toast-driven).
- **`paySubmit()`** (line 4256-4271) — no-ops if already submitted or not
  yet calculated, or if any `PAY_EX` row remains unresolved. Builds a full
  `approval`-kind work item (`pa1`, ref `AP-3124`, amount ₩41.8억, due 7/8
  16:00, with attached files, linked objects, and a 6-month spark-line
  stat block) and prepends it to `items`, sets `paySubmitted: true`, and
  raises a notification. This is the payroll → 전자결재(e-approval) handoff
  — the approval item shape here is the contract the 전자결재 screen
  consumes (relevant for cross-screen backend design).
- **`payResubmit()`** (line 4273-4274) — removes the rejected `pa1` item
  and resets `paySubmitted: false`, returning the pipeline to the 상신
  (submit) step so the user can re-submit after fixing whatever caused
  rejection. (The prototype has no live rejection trigger — `payRejected`
  is derived from `items` state that isn't otherwise mutated in the
  excerpted code, so rejection must be seeded/triggered elsewhere, e.g. the
  전자결재 screen's approve/reject actions on `pa1`.)

### 2.6 The 5-step pipeline state machine (`stStates`/`stSubs`, line 5914-5927)

Driven by four booleans/counters: `attCossClosed`, `payCalced`,
`payExLeft` (= `PAY_EX.filter(x => !payExDone[x.id]).length`),
`paySubmitted`, and derived `payApproved`/`payRejected` (from the `pa1`
item's `done`/`doneTone`).

| Step | label | state logic |
|---|---|---|
| 1 | 근태 마감 | `done` if `attCossClosed`, else `active` |
| 2 | 계산 | `locked` until att closed; `active` while not yet calced; `done` once `payCalced` |
| 3 | 예외 검토 | `locked` until calced; `active` while `payExLeft > 0`; `done` when 0 left |
| 4 | 상신 | `locked` until calced+no exceptions left; `active` when ready; `done` once `paySubmitted` |
| 5 | 승인(이체) | `locked` until submitted; `wait` while pending; `reject` if rejected; `done` if approved |

`payCta`/`payChip` (header CTA, line 5935-5942) mirror this: only one of a
primary button or an informational chip is shown at a time, computed as a
strict if/else-if chain over the same booleans — i.e. the header always
surfaces exactly the *next actionable step*.

---

## Cross-screen coupling

- `attConfirmClose()` is the sole gate that unlocks `payRunCalc()` — payroll
  cannot calculate until all 4 corporate entities (only ㈜코스 is
  interactive; the other 3 are pre-seeded closed) have closed attendance for
  the period.
- `HR_ISSUES` (근태 예외) is shared verbatim between the `att` screen's `ex`
  card and (per AGENTS.md context) the HR screen's issue card — same seed
  array, same `hrHandled` state, same `openHrIssue` navigation.
- `paySubmit()` emits an `items` entry consumed by the 전자결재 (e-approval)
  screen; `payResubmit()` and the derived `payApproved`/`payRejected` close
  the loop back into the payroll pipeline strip and CTA.
- Person-centric drill (`openPerson`) is the universal exit point from
  every att/pay row/name affordance — a single 인사 카드 (person card) object
  view backs 근태, 급여, 주 52시간, and 근태예외 references alike.
