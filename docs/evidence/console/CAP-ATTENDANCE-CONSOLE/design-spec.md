# CAP-ATTENDANCE-CONSOLE — Design Spec (dc.html extract + markdown intent)

Stage-1 scout artifact. Source of authority: Claude Design project "B2B SaaS Console Design",
byte-exact mirror `docs/design/oyatie-console/` (change-log 190, synced 2026-07-24).
Everything below is design intent extracted from the mirror — **not** implementation-status evidence.

Signature story **STORY-ATTENDANCE-001**: "A day's plan versus actual reconciles: check-ins,
exceptions with mandatory reasons, substitute coverage, weekly-52h monitoring, and a gated
monthly close." Route: `/console/attendance`, screen key `att` (console nav key: `attendance`).

## 1. Where the module lives in the design

- DESIGN.md §2: 근태 = "일별 기록, 주52h, 월 마감(게이트)". Exception objects carry `AT-` codes.
- DESIGN.md §3 chain: `… 직원 + 타임테이블 → 근태 기록(자동) ⇄ 연장근로 신청(AP- 결재) → 근태 마감(게이트) → 급여 회차 → 이체 → 인건비 분석 → 계약 수익성`. Gates are pipeline steps with a **single contextual CTA** (§3, §4.7-6).
- DESIGN.md §5: derived numbers (출근율, 주52h) must always drill to source objects.
- Empty-state exemplar (§4-10) is literally this module: "근태 마감 후 계산 가능 → 근태로 이동".
- AGENTS.md §5 change-log entries that define the module: (3)(e)(f), (4), 82, 96, 98, 99, 101, 102, 112, 118, 125, 165 — day timeline, month plan-vs-actual, cover planner, check-in verify, swap, close preflight, SLO seed, golden-path audit.
- ROADMAP.md module row: `근태 | att | Kronos·Deputy·Workday Time | Attendance·계획/실적·대근 | 🟡 심화`. Persona flows: 공장 반장 (결원 감지→대근 편성→승인→일지, 3 clicks), 급여 담당 (근태 마감 게이트→회차…).
- BENCHMARK.md row (근태·급여 = Workday): parity claims = plan-vs-actual timeline, close gate (exception fail-closed), 계산→예외→상신→이체 chain, 회차 series. Honest gaps = real payroll engine, multi-country compliance, audited retro calc, large rosters.
- DEMO.md scripts touching att: #4 (결원→커버 플래너→대근 편성→건별 계약 C-D passkey 수령→급여 SR-206 반영→마진 갱신), #5 (근태 예외 처리(사유 필수)→법인 마감 4/4→급여 계산→상신 AP-→이체 예약), #2 (근태 이벤트 trigger workflow).

## 2. Screen layout (dc.html template, lines ~1710–2109)

Header row:
- `h1 근태` + operational subline `7/3 (금) 실시간 현황 · 6월분 마감 {attCloseHead}` (operational data, judged §4-12-compliant — not prose).
- **커버 플래너** button + hot count badge (`attCoverN`, danger tone when approved-unassigned exists) → popover "커버 플래너 — D+7" (승인 부재 × 상주 커버 필수; footer note 주간 점검 · 매주 월 07:00). Rows: person (→인사 카드), type chip (연차/반차/퇴사/휴직), when·team, status chip {편성됨 ok | 미편성 danger | 승인 대기 muted | 장기 — 충원}, CTA {대근 편성→subOpen(gap incl. date & partial time window) | 결재 큐→leave | 충원 — 채용→recruit}. Empty state: "커버 필요 부재 없음 — 연차·근무 승인 시 자동 합류".
- 배치 (card-layout presets 기본 2단 63:37 / 포커스 74 / 비교 50:50 / 단일 스택) + 기본 배치 reset — personal workspace config (§3.9.0-①).
- **월 근무표** button → att screen month view.

KPI compact stat bar (`attKpis`, 1-row stat chips — never big-number cards):
1. `출근율 · 오늘` = Σinn/Σplan over scoped ATT_SITES (PBAC scope: "전체" = union of authorized entities)
2. `지각 · 결원` = attLateN · attAbsN (danger tone while unresolved exceptions exist)
3. `주 52시간 임박` = count(WEEK52 tone≠ok, not handled)
4. `6월 마감` = closed-entity count "3 / 4" → "4 / 4"

Card zone (CARD_META.att: main=[board], side=[ex, close, w52]; every card = window-model citizen: header-drag popout, dbl-click pin-split, tray minimize, resize, per-user persisted):

### Card "근무 현황" (board) — day/today view
- Segmented control 오늘 | 월간; day view adds entity filter segment (전체/코스/KNL/BESTEC…), meta mono chip `출근 N / 예정 N`, hint `출입기록 연동 · 실시간`.
- 24h two-track timeline per person, grouped by **site** (group header: fold toggle preserving state, tone dot, site name = drillable object (graph/map), entity chip, collapsed headcount, exception note e.g. "무단결근 1 · 대근 미편성" danger).
- Row: person name button (→인사 카드 pin panel), title, status chips (지각 28분 warn | 무단결근 danger | 승인 연차 · 대체 불요 leave | 예정 15:00 plan | 연장 예정 2.0h plan | 대근 편성됨 → {name} ok | 대근 투입 HH:MM ok | 체크인 HH:MM · 근무 중 (인증) ok), and **대근 편성** inline button on rows with an open gap.
- Track 1 = plan segments (dashed outline; OT plan dashed accent; approved leave = purple dashed fill), Track 2 = actual segments (근무 teal / 휴게 muted / 지각·미출 warn / 연장 signal / 결근 danger / 휴가 purple). "지금" red now-line with time label. Cell/segment tooltips carry HH:MM ranges.
- Row timeline click = **직원-일자 개체** (`openEmpDay`): plan/actual + that day's audit + pay impact + comms; opening is itself an audited view (`cls: 민감정보`, "열람 자체가 감사 기록").
- Substitution assignments merge live into the timeline: covered person's gap chip flips to "대근 편성됨 → {worker}", a fill-in row appears for the worker (badge = worker type), site note flips danger→warn "무단결근 1 → 대근 투입 완료".
- Self check-in (`attCheckIn`, field personas): registered-device × geofence verification, **fail-closed** (`forbid` audit on unverifiable), check-in/out stamps write the actual track in real time; 교대 스왑 request = AP- into the leave/approval queue (mutual consent → foreman approval → timetable swap).

### Card "근무 현황" — month view
- Breadcrumb drill: 그룹 전체 → 법인 → 사업장 → 팀 → 개인 (attPath); hint "행 클릭: 하위 단위 · 이름 클릭: 인사 카드"; J/K/Enter row nav.
- Sticky header grid: {단위/이름} | 출근율 (bar+mono%) | 지각 | 결근 | 연장(h) | 일별 현황 (day-cell strip).
- Day-cell status vocabulary (`attStatus` + legend): `ok` 정상, `la` 지각(warn), `ot` 연장(teal), `lv` 유급휴가(purple solid), `plv` planned leave(future), `pa` 승인 부재/무급(purple tint — **excluded from 출근율·결근 aggregates**), `ab` 무단결근(danger solid), `abc` 결근·대근 대체(danger solid + surface cover dot — still counts as the covered person's absence), `we` 휴일(muted), `fu` 예정(outline). Cell tooltip = date·status·substitute name.
- 대근 badge propagation: person `subBadge` "대근 대체" and node "대근 N" roll up team→site→entity, live from subAssignments.
- Month nav ◀ 6월/7월 ▶; meta `마감 확정 반영 | 마감 전 잠정 집계 | 진행 중 · 7/3 기준`; footer "집계는 마감 기준".

### Card "주 52시간 모니터" (w52)
- Window label 6/29–7/5, legend "한도 52h". Row: person (→인사 카드), team, progress bar vs 52h with 92.3% threshold tick, `cur`h mono + `예상 proj`h (danger/warn/ok tone).
- Action on danger rows: **근무 조정** → adds a todo "{name} 주 52시간 근무 조정 협의 @{name}" and flips the row chip to `요청됨` (ok chip); non-danger rows show `—`.
- Feeds: dashboard stat (주52h = non-ok minus handled), RG-102 규제 개체 (주 52시간 상한 — 근로기준법 §53, 감시 FC-03 48h 사전 경보), laborcost lc insight l52.

### Card "근태 예외 · 오늘" (ex)
- Count chip (`hrIssueCount`), right hint "처리 후 마감 가능" (action-driving copy).
- Row: type chip (지각 warn / 미출근 danger / 연장 info), person (→인사 카드), one-line detail, CTA `확인` → exception detail modal (HR_ISSUES shape: ref `AT-0703-01`-style code, time, detail[], evidence files, linked objects 근태/차량/현장/정비 WO-). Resolved rows show `처리됨` ok chip and dim.
- **Mandatory-reason gate (fail-closed)**: resolving requires a comment; the `연장` (unapproved OT) kind additionally requires a linked work scope (`hrOtPlan`) — submit blocked with inline error otherwise (§4-27-2 참조 구현 "연장근로 승인 3필수").
- OT approval completes the object chain: AT-ref → automation wf3 → payroll exception (연장수당) — audited system event, toast names the downstream payslip.

### Card "6월 근태 마감" (close)
- Status chip: `기한 7/4 (토)` warn → `완료` ok.
- Per-entity checklist rows: KNL 물류 ✓ 7/1 09:20 · 정하늘 / BESTEC ✓ / HR 스태핑 ✓ / ㈜코스 — pending shows "근태 예외 N건 미처리" (warn dot).
- Single contextual CTA (§4.7-6), exactly one of:
  1. blocked: warn banner-button "근태 예외 N건 처리 후 마감할 수 있습니다 — 클릭=이동" (**fix-link**: opens the first unresolved exception),
  2. ready: `㈜코스 마감 확정` (signal button) → **§4-29 preflight modal** with auto-judged checks {근태 예외 처리 ok=예외 0 · 타법인 마감 완료 · 미결 연차 신청 (soft warn — 승인 시 소급 반영)} + human attest; passing emits audit `근태 마감 확정 — 프리플라이트 통과` (code AT-CLOSE) + notification "급여 계산이 가능합니다" (→pay),
  3. done: ok banner "4/4 법인 마감 — 급여 계산 가능" + `급여로 이동`.
- Footer warn copy (action-relevant): "마감 후 수정은 소급 보정으로 기록됩니다" — post-close edits are retro-adjustments only, never in-place mutation.

### 대근 편성 modal (subModal, template ~8180–8224)
- Header: gap context "{site} · {role} · {HH:MM–HH:MM} · {who} {reason} 결원".
- Search input over pool (이름·직종·자격; 일용직·파견·알바·파트타임), count "가용·자격순 N".
- Worker card: name, type chip, availability chip, `자격 일치` chip when skills match the gap role, skills · rate · ★rating(jobs) · distance; CTA **배정**.
- Footer contract line: "배정 시 대근 승인(AP-) 상신 · 근태·급여(일당/시급) 자동 반영 · 타임라인 실시간 갱신 · 감사 기록".
- `subAssign` effects (behavioral contract): append substitution {site, ent, role, from, to, worker, ref AP-nnnn, coveredWho, date(default 오늘)}; create AP- approval (상신→현장소장 승인→투입 확인 line); issue per-assignment **건별 근로계약** InboxDoc (legal, passkey receipt = acceptance, basis 근로기준법 §17 · 기간제법); notification; resolve SLO alert nslo1; audit `대근 편성` with reason and (future-dated) "예약 편성 (커버 플래너)" marker; invalidate day timeline; feed SR-206 대근비 series → labor cost → contract margin loop (AGENTS 112).

## 3. Object model implied by the design

- **AttendanceException `AT-`** (event object): kind ∈ {지각, 미출근, 연장(무승인), 조퇴}, ref code `AT-MMDD-NN`, who, team, time, detail[], evidence[], links[] (WO-, 현장, 근무표, 차량…), lifecycle OPEN→RESOLVED, resolution = (actor, ts, reason **required**, linked work scope required for OT) — pure event object (생성=종결 계열, §3.9 축약형) but resolution is an audited transition.
- **EmployeeDay** (직원-일자 개체, personId×date): plan/actual segments + that day's audit stream + pay impact + comms; section-level dataClass gates; viewing audited (HANDOFF §9).
- **Substitution (대근)**: {gap(site, role, from, to, coveredPersonId, reason, date), worker, ap: AP-, contract: C-D InboxDoc} (HANDOFF §9); unfilled approved-absence × cover-mandatory position = cover-planner row with SLO (target 2h, 미편성 알림).
- **MonthClose (AT-CLOSE)**: per entity×month gate; preflight checks + attest; blocking = open exceptions; downstream unblocks payroll run; post-close amendment = retro adjustment record.
- **Week52 monitor row**: derived (cur hours, projected hours, tone) from records + planned OT; action = 근무 조정 request (todo + handled marker). Regulatory anchor RG-102 (주 52h) — parameter is a ledger object, not a constant (§4-16).
- **WorkforcePool WP-**: person subtype (일용직·파트타임·알바·프리랜서·파견) with contractType, rate, availability, skills, clearance, rating, rehire count, distance, provenance (recruit JP- origin); registry separate from the employee roster.

## 4. Invariants binding this lane (audit checklist)

- §4-1/§4-12: every noun clickable/pinnable (person→HR card, site→object/map, AT-→exception detail, AP-/WO-/PS- link chips); status = chips; no explanatory captions; only action-driving copy (blocked-close banner, fail-closed toasts).
- §4-11: compact 1-row stat bar, no KPI cards. §4-3: exceptions colored, normal quiet, 0 hidden/`—`.
- §4.7-6 gates = pipeline steps + exactly one contextual CTA (close card is the reference).
- §4-19/4-27: reason enums + structured fields, fail-closed required fields; server never trusts client form completeness.
- §4-29 preflight (auto-checks + human attest, fail-closed) on the close action; postflight = audit + notification + downstream unlock.
- §4.5 PBAC: deny-by-omission everywhere; "전체" scope = union of authorized entities; aggregates computed inside authorization scope only; EmployeeDay view itself audited (민감).
- §5: every derived number (출근율, 주52h, 결원) drills to source objects.
- §4.7-1: J/K/Enter keyboard nav (month view), column-track alignment, no horizontal table scroll (minmax tracks), fold/scope state survives view switches.
- Self-service floor (§4.8): field personas see check-in/swap on their own objects; the module is not admin-only.
