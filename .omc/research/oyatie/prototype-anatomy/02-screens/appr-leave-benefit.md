# Oyatie Console — Spec for APPROVAL / LEAVE / BENEFIT

File: `docs/design/oyatie-console/Oyatie Console.dc.html`. DSL: `x-dc` template with `sc-if`/`sc-for`/`{{binding}}`; logic in `class Component extends DCLogic`. All three screens are sibling top-level `<div>`s whose visibility is driven by `scrWrapOf2(scr)` → `{disp: s.screen===scr ? "flex" : "none"}` (line 5955).

Shared layout idiom: header (`h1` + one caption) → optional tab row / KPI stat-bar → a `flex` body that is `1.7fr` main panel + `1fr` side rail (`max-width:440px`), wrapping via `{{wzWrap}}`.

---

## 1. 전자결재 — APPROVAL (screen id `"appr"`)

### 1.1 Layout anatomy (template 1634–1867)
- **Header** (1636–1641): title "전자결재" + caption `{{apprHead}}` (dynamic: "결재 대기 N건 · 내 상신 M건 진행").
- **Tab row** (1643–1650): `sc-for {{apprTabs}}` → 3 pill buttons (결재함/상신함/기안). Each shows label + monospace count chip when `tb.nOn`. Active tab = ink fill.
- **Body split**: main panel `flex:1.7 1 480px` (1653) + side rail `flex:1 1 300px` (1843).
- **Main panel — three mutually-exclusive `sc-if` sub-views** keyed on tab:
  - **결재함 / inbox** (`{{apprTabInbox}}`, 1656–1698):
    - Section header "내가 결재할 문서" (danger dot).
    - List `sc-for {{apprInbox}}` (1662): each row = ref chip · title · `{{who}} · {{site}}` · optional amount (`ib.amountOn`) · due badge colored by `ib.dueColor`. Click → `openDetail(it.id)`.
    - Empty state `{{apprInboxEmpty}}` (1673): "결재할 문서가 없습니다".
    - Sub-section "내 결재 완료 · 종결 대기" (1676) + list `sc-for {{apprProgress}}` (1682): ref chip · title · tmpl chip · horizontal step stepper (`pg.steps` → dot+label+connector line). Click → toast.
  - **상신함 / outbox** (`{{apprTabOutbox}}`, 1701–1734):
    - Header "내가 올린 문서".
    - List `sc-for {{apprOutbox}}` (1706): ref chip · title · tmpl chip · status badge (`ob.stLabel`); second row = step stepper + conditional action buttons:
      - `ob.finalizeOn` → "종결" (`onFinalize`) + "대행" override (`onOverride`).
      - `ob.revokeOn` → "사후 반려" (`onRevoke`).
    - Row opacity dimmed when finalized (`ob.rowOpacity`).
  - **기안 / draft** (`{{apprTabDraft}}`, 1737–1840): itself two states:
    - **Compose form** (`{{apprComposeOn}}`, 1738–1820): back button (`onApprComposeCancel`) + title `{{apprComposeTitle}}`; fields:
      - 제목 input (`apprComposeVal`/`onApprComposeTitle`), error border/msg when `apprComposeErr`.
      - 사유 유형 chips `sc-for {{apprReasonOpts}}` (1757), error `apprReasonErr`.
      - 상세 내용 textarea (`apprComposeBody`/`onApprComposeBody`).
      - Attachment block `sc-if {{apprAttachOn}}` (1766): label `{{apprAttachLabel}}`, button `onApprAttach`.
      - Target/개체 연결 block (1775–1804): label `{{apprTargetLabel}}`, error `apprTargetErr`; chips `sc-for {{apprTargets}}` each with `×` remove (`tg.onRemove`); "개체 연결" button (`onApprTargetMenu`) opens dropdown `sc-if {{apprTargetMenuOn}}` listing `{{apprTargetOpts}}` (`op.onPick`).
      - 결재선 (1805–1814): fixed "전성진 상신" node + `sc-for {{apprComposeLine}}` chevron-separated line nodes.
      - Footer (1816–1819): "상신" (`onApprSubmit`) + "취소" (`onApprComposeCancel`).
    - **Template picker** (`{{apprComposeClosed}}`, 1821–1839): header "양식 선택"; responsive grid `sc-for {{apprDrafts}}` (1827) — each card = colored icon tile + label; click `dr.onPick` → `apprOpenCompose(id)`.
- **Side rail — "내 급여 명세"** (1844–1862): `sc-for {{apprPaySlips}}` → month · net-pay (mono) · date · "최근" chip when `sl.curOn`; click `onOpen` → `inboxOpen(docId)`.

### 1.2 Interactive affordances
| Affordance | Handler | Effect |
|---|---|---|
| Tab pill | `apprTabs[].onPick` | `setState({apprTab:id, apprCompose:null})` |
| Inbox row | `apprInbox[].onOpen` | `openDetail(it.id)` (opens detail pin panel) |
| Progress row | `apprProgress[].onOpen` | toast only |
| Outbox row | `apprOutbox[].onOpen` | toast ("다음 단계 범위") |
| 종결 | `onFinalize` | `apprFinalize(id)` |
| 대행 (override) | `onOverride` | toast (Cedar override, next-phase) |
| 사후 반려 | `onRevoke` | `apprRevoke(id)` |
| Template card | `apprDrafts[].onPick` | `apprOpenCompose(tid)` |
| 제목 input | `onApprComposeTitle` | updates `apprCompose.title`, clears err |
| 사유 chip | `apprReasonOpts[].onPick` | sets `apprCompose.reason`, clears errR |
| 상세 textarea | `onApprComposeBody` | updates `apprCompose.body` |
| 첨부 | `onApprAttach` | toast (next-phase) |
| 개체 연결 button | `onApprTargetMenu` | toggles `apprCompose.targetMenu` |
| target option | `apprTargetOpts[].onPick` | `apprAddTarget(k,v)` |
| target chip × | `apprTargets[].onRemove` | `apprRemoveTarget(v)` |
| 상신 | `onApprSubmit` | `apprSubmit()` |
| 취소 / back | `onApprComposeCancel` | `setState({apprCompose:null})` |
| Pay slip row | `apprPaySlips[].onOpen` | `inboxOpen(docId)` |

Also reachable externally: quick-action "새 기안 작성" (line 6282) → `setState({screen:"appr", apprTab:"draft", apprCompose:null})`.

### 1.3 State read / written
- **Read**: `s.apprTab`, `s.apprCompose` (`.tid/.title/.body/.reason/.targets/.targetMenu/.line/.err/.errT/.errR`), `s.apprMySubs`, `pendingOf(scoped)` items with `kind==="approval"`, `s.screen`, `this.ENTITIES`.
- **Written**: `apprTab`, `apprCompose`, `apprMySubs` (prepend on submit/promote/refusal; mutate status/line/step on finalize/revoke), `notifs` (prepend), plus toast/`logEvent` side-effects.

### 1.4 Seed-data shapes (backend contract)

**`APPR_TEMPLATES()`** (4631) — array of 8 draft templates:
```
{ id: string,        // "ot"|"leave"|"expense"|"sub"|"purchase"|"benefit"|"reimburse"|"general"
  label: string,     // e.g. "연장근로 신청서"
  icon: string,      // SVG path data
  desc: string,      // one-line description
  tone: string,      // "warn"|"info"|"accent"|"purple"|"ok"|"teal" → drives card colors
  who: string }      // "본인"
```

**`apprMySubs` seed** (constructor 3663–3667) — array of submitted docs:
```
{ id: string,        // "ap-s1"
  ref: string,       // "AP-3122"
  title: string,
  tmpl: string,      // short template name "기안"/"지출결의"
  date: string,      // "오늘 09:10" | "어제" | "6/30"
  status: string,    // "progress"|"approved"|"rejected"|"finalized"
  line: string[],    // approval-line node labels, e.g. ["전성진 상신","감사팀 검토 중","CEO 최종"]
  step: number }     // index of current step
```
Runtime-added variants also carry: `target`, `promoteRound`, `receiptDoc`, `receiptAt` (from promote/refusal/receipt flows).

**`items[]` `kind:"approval"` entries** (feed 결재함; 3758–3765, +`pa1` payroll 4260):
```
{ id, kind:"approval", urg: "now"|"today"|"wait",
  ref: string, title: string,
  entity: string,      // "coss"|"hq"|"staff"|... → Cedar scope + ENTITIES[entity].short
  site: string, who: string,
  due: string, dueTone: "danger"|"warn"|"neutral",
  amount?: string,     // "₩1,860,000" (optional; drives amountOn)
  submitted: string,
  detail: string[],
  files?: [{ name: string, size: string }],
  links: [{ kind: string, label: string }],   // 계약/현장/자산/직원/근태...
  stats?: { spark?: number[], summary: string, delta: string, tone: string },
  done: boolean }      // pendingOf = !done
```

**`apprPaySlips`** (renderVals 7209) — hard-coded 3 months:
```
{ m, net, base, allow, ded, d, cur:boolean, docId }
```

**`apprLinkSpec(tid)`** (4664) — per-template linkable-object spec:
```
{ label: string, req: boolean, opts: [{ k: string, v: string }] }
```
`apprReasons(tid)` (4650) → `string[]`; `apprDefaultLine(tid)` (4691) → `string[]` default approval line.

### 1.5 renderVals bindings (7132–7213)
- `apprTabInbox/Outbox/Draft` = `s.apprTab === x`.
- `apprHead` (7135): count string.
- `apprTabs` (7136): 3 tabs; inbox count = pending approvals, outbox count = progress subs, draft n=0; styling by active; `onPick` sets tab + clears compose.
- `apprInbox` (7141): maps pending approval items → `{ref,title,who("…기안"),site(ENTITIES.short · site),amount,amountOn,due,dueColor,onOpen:openDetail}`.
- `apprInboxEmpty` (7147).
- `apprProgress` (7148): 2 hard-coded in-progress docs with stepper (first 2 steps ok, rest signal).
- `apprOutbox` (7156): maps `apprMySubs` → status label/colors, `finalizeOn`=(approved|rejected), `revokeOn`=(approved|finalized), stepper via `x.step`, all handlers.
- `apprDrafts` (7171): maps templates → tile colors from `tone`, `onPick`.
- Compose bindings (7178–7207): `apprComposeOn/Title/Val/Body/Err/ErrBd/Closed`; `apprAttachOn`=(reimburse|expense|purchase); `apprAttachLabel/Hint` (reimburse-specific); `apprTargetLabel/Targets/Err/MenuOn/Opts`; `apprReasonErr/Opts`; `apprComposeLine`; input/submit/cancel handlers.
- `apprScr` (6879) = `scrWrapOf2("appr")`; `scrAppr` (6878) = boolean.

### 1.6 Methods driving it
- `APPR_TEMPLATES` (4631) — template catalog.
- `apprOpenCompose(tid)` (4644): sets `apprCompose` with default line, empty targets/reason.
- `apprReasons` (4650), `apprLinkSpec` (4664), `apprDefaultLine` (4691) — config.
- `apprAddTarget(k,v)` (4679): appends unique target, closes menu, clears err.
- `apprRemoveTarget(v)` (4687): filters out target.
- `apprSubmit()` (4699): validates title/target(req)/reason → builds `sub` with `ref="AP-"+(3123+len)`, tmpl label normalized, `line=["전성진 상신",...defaultLine w/ first "+ 중"]`, `status:"progress"`, `step:1`; prepends to `apprMySubs`, switches to outbox tab, prepends notif, toast.
- `apprFinalize(id)` (4958): status→`finalized`, toast, `logEvent(finalize)`.
- `apprRevoke(id)` (4966): status→`rejected`, appends "감사팀 사후 반려" to line, toast (Cedar 인가).

---

## 2. 연차 — LEAVE (screen id `"leave"`)

### 2.1 Layout anatomy (template 1868–1974)
- **Header** (1870): "연차" + caption "2026년 · 회계연도 부여 기준".
- **KPI stat-bar** (1874–1882): `sc-for {{lvKpis}}` → compact 1-line stat tiles (label · value · sub).
- **Body split**: main `flex:1.7` (1884) + side rail (1917).
- **Main — "직원별 연차 현황"** (1884–1916): header title + count chip `{{hrCount}}`; scrollable table (min-width 560px) with sticky header (이름/부여/사용/잔여/소진율); rows `sc-for {{lvRows}}` (1894): avatar initial · name · team · grant · used · left · progress bar (`lv.pctW`/`lv.pctBg`) · pct · "촉진" chip when `lv.promoteOn`. Row highlight via `lv.rowBg`/`lv.ring` when selected. Click → `openPerson(name)`.
- **Side rail — two cards**:
  - **"연차 승인 대기"** (1918–1950): warn dot + count `{{leavePendingStr}}`; list `sc-for {{lvReqRows}}` (1925): type badge · who button · when·days · 잔여 · reason; if `rq.pending` → 승인/반려/거부 buttons; else state badge `{{rq.stateLabel}}`. Empty state `{{lvReqEmpty}}`.
  - **"연차 사용 촉진"** (`{{lvPromoteOn}}`, 1951–1970): list `sc-for {{lvPromote}}` (1958): name button · unused-days · round chip (`pm.roundChipOn`) · push button (`pm.pushOn`, label 1차/2차 촉진) · 노무수령거부권 button (`pm.refusalOn`) · "거부권 행사" badge (`pm.refusedOn`).

### 2.2 Interactive affordances
| Affordance | Handler | Effect |
|---|---|---|
| Employee row | `lvRows[].onOpen` | `openPerson(name)` (인사 카드; J/K nav) |
| Request who link | `lvReqRows[].onWho` | `openPerson(who)` (stops propagation) |
| 승인 | `onApprove` | `lvDecide(id,"approve")` |
| 반려 | `onReturn` | `lvDecide(id,"return")` |
| 거부 | `onReject` | `lvDecide(id,"reject")` |
| Promote name link | `lvPromote[].onWho` | `openPerson(name)` |
| 1차/2차 촉진 | `onPush` | `lvPromotePush(name, leftLabel)` |
| 노무수령거부권 | `onRefusal` | `lvRefusalPush(name)` |

Also: nav sidebar "연차" item (line 6176) with badge = `leavePending`; automation `wf2` (4811) auto-fires `lvPromotePush` for first un-promoted promote employee.

### 2.3 State read / written
- **Read**: `s.lvReqs`, `s.LV_EMP`, `s.leaveHandled`, `s.lvSel`, `s.lvPromoteRound`, `s.lvRefusal`.
- **Written**: `leaveHandled[id]` (lvDecide), `apprMySubs`+`notifs`+`lvPromoteRound` (promote), `apprMySubs`+`notifs`+`lvRefusal` (refusal). `lvSel` set by person navigation elsewhere.

### 2.4 Seed-data shapes

**`lvReqs` seed** (constructor 3646–3650) — pending leave requests:
```
{ id: string,       // "lr1"
  who: string, team: string,
  type: string,     // "연차"|"반차"
  days: string,     // "1일"|"0.5일"
  when: string,     // "7/6 (월)"
  reason: string,
  left: string,     // "6일"
  ref?: string }    // "AP-3108" (optional; only lr1)
```

**`LV_EMP` seed** (constructor 3651–3662) — 10 employees:
```
{ name: string, team: string,
  grant: number,   // days granted
  used: number,    // days used
  tone: string }   // "ok"|"promote"|"low" → drives bar color & 촉진 flag
```

### 2.5 renderVals bindings (7037–7096)
- `lvKpis` (7037): computed — 평균 잔여 (avg grant−used), 소진율 (Σused/Σgrant %), 승인 대기 (`leavePending`, warn if >0), 촉진 대상 (count tone==="promote", danger if >0).
- `lvRows` (7049): per LV_EMP → grant/used/left with "일", pct + pctW, pctBg by tone (low=ok-solid, promote=warn-solid, else teal), promoteOn, rowBg/ring by `lvSel`, `onOpen`.
- `lvReqRows` (7063): per lvReqs → type badge colors (반차=info, else purple), pending=!handled, stateOn/Label/colors from `leaveHandled[id]` (approve→승인됨/ok, return→반려됨/warn, reject→거부됨/danger), handlers.
- `lvReqEmpty` (7082) = `leavePending===0`; `leavePendingStr` (7083). `leavePending` (5897) = `lvReqs.filter(r=>!leaveHandled[r.id]).length`.
- `lvPromoteOn` (7084); `lvPromote` (7085): per promote-tone emp → left-label, round from `lvPromoteRound[name]` (0/1/2), pushOn=(round<2), pushLabel, roundChipOn/roundChip, refusalOn=(round>=2 && !refused), refusedOn, handlers.
- `leaveScr` (7035) = `scrWrapOf2("leave")`.

### 2.6 Methods driving it
- `lvDecide(id, action)` (4718): reads `lvReqs`, sets `leaveHandled[id]=action`, toast (approve → "근태·급여 자동 반영"), `logEvent`.
- `lvPromotePush(name, leftLabel)` (4891): round = 2 if already pushed else 1; builds AP- sub (`tmpl:"연차촉진"`, `line:["전성진 상신","인사팀 승인",name+" 수령확인 대기"]`, `step:2`, `promoteRound`, `receiptDoc:"ext-"+name`); prepends to apprMySubs, sets `lvPromoteRound[name]`, prepends notif, toast + `logEvent` (근로기준법 §61).
- `lvRefusalPush(name)` (4910): builds AP- sub (`tmpl:"노무수령거부"`, `line:["전성진 상신","대표이사 승인",name+" 수령확인 대기"]`, `step:2`); sets `lvRefusal[name]=true`, notif, toast, `logEvent`.

---

## 3. 복리후생 — BENEFIT (screen id `"benefit"`)

### 3.1 Layout anatomy (template 1975–2055)
- **Header** (1977): "복리후생" + caption "그룹 4개 법인 · 재직 1,284명".
- **Tab row** (1981–1985): `sc-for {{benefitTabs}}` → 2 pills (법정/법정외).
- **KPI stat-bar** (1986–1994): `sc-for {{benefitKpis}}` → 3 compact tiles (tab-dependent).
- **Single table card** (1995–2054): scrollable (min-width 520px), sticky header (제도/대상/월 비용/비고/chevron); rows `sc-for {{benefitRows}}` (2001):
  - Row button (2003): name · optional external-link icon (`bf.linkOn`) · optional tier chip "`{{bf.tierBy}} 차등`" (`bf.tierOn`) · lifecycle chip `{{bf.lifeLabel}}` · cover · cost (mono) · note · chevron (`bf.tierOn`). Click → `bf.onOpen`.
  - Expandable detail `sc-if {{bf.openOn}}` (2015–2047): "정책 수명주기" + lifecycle chip + advance button (`bf.advanceOn`, label `bf.advanceLabel`, `onAdvance`); lifecycle explainer line; if `bf.tierOn`: "`{{bf.tierBy}}별 차등 적용`" + tier rows `sc-for {{bf.tiers}}` (k/v), then "적용 조건" chips `sc-for {{bf.conds}}` + "조건 편집" button (`onEditCond`).

### 3.2 Interactive affordances
| Affordance | Handler | Effect |
|---|---|---|
| Tab pill | `benefitTabs[].onPick` | `setState({benefitTab:id})` |
| Benefit row | `benefitRows[].onOpen` | if `b.link` → `setState({screen:b.link})` (e.g. →leave); else toggle `benefitOpen` |
| 상태 advance button | `onAdvance` | `benefitAdvance(name)` (stopPropagation) |
| 조건 편집 | `onEditCond` | toast (Cedar no-code, next-phase) |

### 3.3 State read / written
- **Read**: `s.benefitTab`, `s.benefitOpen` (key = `tab+":"+name`), `s.benefitLife` (per-name lifecycle override), `benefitData()`.
- **Written**: `benefitTab`, `benefitOpen`, `benefitLife[name]` (advance), `screen` (link rows).

### 3.4 Seed-data shapes

**`benefitData()`** (4928) — `{ legal: Benefit[], extra: Benefit[] }`:
```
Benefit = {
  name: string,
  cover: string,      // "1,284" | "전 직원" | "여 682" | "9개 모임" (display, not numeric)
  cost: string,       // "₩3.42억" | "—"
  note: string,
  link?: string,      // screen id to navigate to (e.g. "leave") — makes row a link, no expand
  life?: string,      // lifecycle seed: "finalized"|"pending"|"retiring"|... (default "implemented")
  lifeDate?: string,  // "시행 7/15" | "폐지 8/1" — shown for finalized/retiring
  tiers?: {           // present ⇒ tierOn, expandable
    by: string,       // "직급"|"현장"|"직책"|"직급·연령"
    rows: [{ k: string, v: string }]
  }
}
```
`legal` = 10 statutory items (연금/보험/퇴직/연차[link:"leave"]/검진 …); `extra` = 11 discretionary items (경조사비/명절/중식/통신비/자기계발비/동호회/… with tiers & lifecycle).

**`benefitLifeMeta(k)`** (5017) — lifecycle state machine:
```
{ label, bg, bd, tx, next: string|null, nextLabel }
// draft→pending→finalized→implemented→retiring→retired(next:null)
```

### 3.5 renderVals bindings (7097–7131)
- `benefitTabLegal/Extra` (7097); `benefitTabs` (7099): 2 tabs, active=ink, `onPick` sets `benefitTab`.
- `benefitRows` (7103): source = `benefitData().legal|extra` by tab; per row → name/cover/cost/note, linkOn=!!link, tierOn=!!tiers, tierBy, lifeLabel (label + lifeDate for finalized/retiring), life colors from `benefitLifeMeta(benefitLifeOf(name))`, advanceOn=(!link && lm.next), advanceLabel=lm.nextLabel, chev (link=arrow, else expand caret), openOn=(open && !link), tiers rows, conds = `["㈜코스·안산공장 적용","입사 1년 이상", by+"별 차등"]`, `onEditCond` toast, `onOpen` (link→screen nav; else toggle benefitOpen).
- `benefitKpis` (7126): legal → [사업자 부담 ₩11.3억, 가입 1,284, 특수검진 941]; extra → [법정외 총액 ₩3.0억, 운영 제도 8종, 이번 달 지급 312건]. (All hard-coded.)
- `benefitScr` (7036) = `scrWrapOf2("benefit")`.

### 3.6 Methods driving it
- `benefitData()` (4928) — catalog.
- `benefitLifeMeta(k)` (5017) — lifecycle chip meta + `next`/`nextLabel`.
- `benefitLifeOf(name)` (5029): returns `benefitLife[name]` override else seed `b.life` else `"implemented"`.
- `benefitAdvance(name)` (5036): reads current life → meta.next; if null no-op; sets `benefitLife[name]=next`, toast ("정책 <nextLabel> — 상태 변경이 실제 반영됩니다 · 참여자 알림·감사 기록").

---

## Cross-screen state summary
Constructor seeds (3641–3667): `leaveHandled:{}`, `benefitTab:"legal"`, `benefitOpen:null`, `benefitLife:{}`, `lvSel:null`, `lvReqs:[3]`, `LV_EMP:[10]`, `apprMySubs:[3]`. Runtime-only (lazy-init via `|| {}`): `lvPromoteRound`, `lvRefusal`, `apprCompose` (null until compose), `apprTab` (defaults to inbox). All three screens share the DESIGN.md object-lifecycle + Cedar-scope conventions: 결재함 rows are Cedar-scoped (`pendingOf(scoped)`), and every decision/advance/submit emits `logEvent` for the audit hash-chain.
