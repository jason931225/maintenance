# Screens: 문서·기록물 (DOCS) · 권한·정책 (POLICY/Cedar) · 개인 수신함 (INBOX) · 감사 로그 (AUDIT)

Source: `docs/design/oyatie-console/Oyatie Console.dc.html`
Template regions: DOCS 2056-2107, POLICY 2107-2163, INBOX 2163-2271, AUDIT 2271-2399.
Logic: `DOCS()`/`POLICIES()` @4973-4997; inbox methods @4843-4888; audit envelope system @4728-4789; renderVals blocks @6073-6143 (view calc) and @6880-7005 (bindings). Passkey modal template @3357-3385.

---

## 1. 문서·기록물 (DOCS, screen id `docs`)

### 1.1 Layout anatomy
- Header row: `<h1>문서·기록물</h1>` + spacer + `내보내기` (export) button (icon: download-tray svg).
- Stat bar (compact 1-row, not big-number KPI cards per DESIGN §4-11): `docKpis` — 3 tiles, grid `auto-fill minmax(150px,1fr)`.
- Single card containing:
  - Filter/search toolbar: `docFilters` pill row (전체/결재/공지/업무일지/계약/접수) + spacer + search input (`docQ`, placeholder "코드·제목·작성자").
  - Sticky column header row: 코드 / 제목 / 유형 / 작성/담당 / 종결일 / 보존 (grid-template-columns `92px minmax(180px,2fr) 84px minmax(90px,1fr) 74px 64px`).
  - Scrollable row list (`docRows`), each row a full-width button.
- No detail/pin panel wired yet — row click only toasts (see below). No `docCount` binding is used in the template (computed in renderVals but unconsumed by markup shown — dead binding, or reserved for a future count display).

### 1.2 Interactive affordances
- **내보내기** (`onDocExport`): toast only — "기록물 내보내기 — 보존·감사 정책에 따라 다음 단계 범위입니다" (out of scope stub, not wired to real export/egress gate).
- **Filter pills** (`f.onPick`): `setState({ docFilter: f.id })`, client-side filter by `d.type === docFilter` (or `all`).
- **Search input** (`onDocQ`): `setState({ docQ: e.target.value })`; filters by substring match across `code+title+who+type`.
- **Row click** (`dc.onOpen`): toast "코드 제목 — 기록물 상세는 핀 패널로 열립니다 (다음 단계) · 열람 감사 기록" — i.e. row open is a *stub*; no `logEvent`/pin-panel navigation is actually fired despite the toast claiming "열람 감사 기록" (view-audit-logging). This is a gap versus the audit envelope pattern used elsewhere (compare INBOX/AUDIT which do call `logEvent`).
- Row `title` attribute: "기록물 열기 — 열람 감사 기록" (same claim, same gap).

### 1.3 State read/written
- Read: `s.docFilter`, `s.docQ`.
- Written: `docFilter` (via filter pill), `docQ` (via search onChange). No other doc-specific state; no doc detail/pin state exists yet.

### 1.4 Seed data shape — `DOCS()` (static catalog method, not constructor state; called fresh on each render)
```js
{ code: "AP-3111", title: "6월 부서 운영비 정산", type: "결재", who: "전성진", closed: "6/30", keep: "5년", ent: "코스" }
```
Fields: `code` (record code, e.g. `AP-`/`JL-`/`NT-`/`C-`/`IN-` prefixes = 개체 코드 tying into other modules — 결재/업무일지/공지/계약/접수), `title`, `type` (결재/업무일지/공지/계약/접수), `who` (author/owner), `closed` (close date, M/D), `keep` (retention: `5년`/`3년`/`10년`/`영구`), `ent` (법인/entity: 코스/그룹/BESTEC/KNL/스태핑). 10 rows seeded. `ent` field is present in data but **not surfaced in the row template** (no entity column/badge shown) — potential gap vs. multi-법인 scoping requirement.

### 1.5 Methods
- `DOCS()`: pure static array, no computation, no filtering (filtering happens in renderVals via `docFilter`/`docQ` against `this.DOCS()` results).
- No dedicated docs-only methods beyond the render-time `.filter()`/`.map()` inline in renderVals (@6892-6900). No `logEvent` call is wired for doc open despite the UI copy implying it — this is a **stub gap**, not an intentional dark/shadow lane.

### 1.6 Renderer bindings (docs)
- `docKpis`: 총 기록물 (`DOCS().length + 1274`, static offset simulating a larger real corpus), 이번 달 종결 (`34`, hardcoded), 보존 만료 임박 (`3`, hardcoded, warn-tone).
- `docFilters`: pill list with active-state styling toggled by `docFilter`.
- `docRows`: mapped rows with type-based badge colors (결재=accent, 공지=warn, 계약=purple, 업무일지=ok, else=info) and `keepColor` (영구=steel, else=faint).
- `docCount`: computed but not referenced in the template shown — likely a future stat/badge slot.

---

## 2. 권한·정책 (POLICY / Cedar, screen id `policy`)

### 2.1 Layout anatomy
- Header: `<h1>권한·정책</h1>` + spacer + `새 정책` (new policy) primary button (signal-colored, plus-icon).
- Stat bar: `policyKpis` — 3 compact tiles (활성 정책 / 초안 / 적용 대상).
- Single card, header "정책" (shield icon), body = accordion list `policyRows` (no filter/search toolbar on this screen — flatter than DOCS/INBOX/AUDIT).
- Each row: collapsed state = 허용/금지 effect badge + rule sentence (truncated) + status badge (시행 중/초안) + chevron.
- Expanded state (`pl.openOn`): reveals a Cedar principal→action→resource breadcrumb ("누가" chip → arrow → "무엇을" chip → arrow → action chip), plus a metadata line (등록자·시행상태) and two actions: `시뮬레이션` and `규칙 편집`.

### 2.2 Interactive affordances
- **새 정책** (`onPolicyNew`): toast stub — "새 정책 — Cedar no-code 규칙 캔버스는 다음 단계 범위입니다" (explicitly out-of-scope; no-code Cedar policy canvas is a documented future charter, matches CLAUDE.md "진행 중 에픽").
- **Row toggle** (`pl.onToggle`): `setState` toggles `policyOpen` (single-open accordion — only one policy's detail expanded at a time, keyed by `p.id`).
- **시뮬레이션** (`pl.onSim`, stops propagation): toast stub — "정책 시뮬레이션 — 「누가 무엇을 보는가」 미리보기는 다음 단계 범위입니다" (policy simulation / "who can see what" preview is future scope).
- **규칙 편집** (`pl.onEdit`, stops propagation): toast stub — "no-code 규칙 편집 — Cedar 캔버스는 다음 단계 범위입니다".
- All three primary policy-authoring actions (new/simulate/edit) are **dark/stub** — this screen is read-only display of the Cedar policy catalog today; no-code authoring canvas is not yet built (consistent with the Cedar activation status: shadow-lane enforcement exists on the backend but no console authoring surface).

### 2.3 State read/written
- Read: `s.policyOpen` (id of currently expanded policy row, or null).
- Written: `policyOpen` only (accordion toggle). No policy CRUD state exists.

### 2.4 Seed data shape — `POLICIES()` (static catalog method)
```js
{ id: "p1", rule: "경비팀 팀장은 소속 팀원의 근태를 열람할 수 있다", principal: "직책 · 팀장", action: "열람", resource: "소속 팀원 근태", effect: "허용", status: "active", by: "인사팀", when: "시행 중" }
```
Fields: `id`, `rule` (plain-Korean policy sentence — no-code phrasing), `principal` (Cedar principal descriptor, e.g. "직책 · 팀장" / "전 직원" / "본인" / "직무 · 인사"), `action` (열람/반려/…), `resource` (target resource description), `effect` (`허용`|`금지` = Cedar permit/forbid), `status` (`active`|`draft`), `by` (author/org), `when` (시행 중/초안 — display label). 6 seeded policies covering: team-scoped attendance view, cross-법인 pay-detail forbid, self-view pay (audit-exempt), sensitive HR detail view w/ audit, post-finalization audit-team reject override, and a draft policy (파견 코디네이터 scoped view).

### 2.5 Methods
- `POLICIES()`: pure static array. No filtering/search on this screen (unlike DOCS/AUDIT). All computation is cosmetic (badge colors) in renderVals @6906-6921.
- No `logEvent` calls anywhere on this screen — opening/viewing a policy is not itself audited (differs from DOCS' claimed-but-unwired "열람 감사" and from AUDIT's own event-logging elsewhere in the app). Given DESIGN's "권한 있어도 열람은 기록" invariant, this is a likely gap once policy-detail viewing becomes a real feature (currently it's just an accordion of static seed text, not a mutating/sensitive read).

### 2.6 Renderer bindings (policy)
- `policyKpis`: 활성 정책 (count where `status==="active"`), 초안 (count where `status==="draft"`, warn-tone), 적용 대상 (`1,284`, hardcoded — "전 직원").
- `policyRows`: effect badge (허용=ok tone, 금지=danger tone), status badge (active=ok tone "시행 중", draft=warn tone "초안"), chevron direction from `openOn`.

---

## 3. 개인 수신함 (INBOX, screen id `inbox`)

### 3.1 Layout anatomy
Two-pane list/detail pattern sharing one flex row (`inboxScr`), toggled via `s.inboxView` (`"list"` | `"doc"`):
- **List view** (`inboxListView` = `inboxView !== "doc"`):
  - Header: "받은 문서" + count chip (`inboxCount`) + filter pill row (`inboxFilters`: 확인 필요/급여명세/완료/전체, each with a count badge).
  - Scrollable list of `inboxDocsList` rows: kind icon tile, title + kind badge, `from · date` subline, a locked-fingerprint icon (if `d.lockedOn`) or a completed-checkmark icon (if `d.confirmedOn`).
  - Empty state: "문서가 없습니다".
- **Doc view** (`inboxDocView` = `inboxView === "doc" && has selected doc`):
  - Back-to-list button (`onInboxBack`).
  - Doc header: kind badge + ref code + optional legal-basis chip (`inbSel.basisOn`, gavel icon) + title (`<h2>`) + `발신 {from} · {date}` line.
  - Body area, one of three mutually exclusive states:
    1. **Locked gate** (`inbLockedOn`): a full-width dashed-border button — fingerprint icon circle, "본인 인증 후 열람" / "열람이 곧 법적 수령 확인입니다" copy, "passkey 인증" pill button. Clicking anywhere on this button triggers `onInbUnlock`.
    2. **Unlocked, kind=pay** (`inbSel.payOn`): payslip summary card (실수령액 net figure + delta badge) and a 3-col grid (기본급/수당/공제), plus pay-date + explicit copy "본인 열람은 감사 대상이 아닙니다" (self-view of own pay is NOT audited — matches POLICIES p3).
    3. **Unlocked, non-pay** (`inbBodyOn`): renders `inbSelBody` paragraphs (`inbSelDoc.body[]`).
    - Common to any unlocked state: confirmed-receipt banner (`inbSel.confirmedOn`) showing "수령 확인 완료" + timestamp + "감사 기록됨"; and a "연결 개체" (linked objects) chip row (`inbSelLinks`) if `inbSelDoc.links` present.
- **Passkey modal** (separate overlay, `pkModalOn`, template @3357-3385): dialog with doc kind/ref/title header, animated fingerprint/spinner/checkmark state circle, status text, legal-basis chip, Cancel + Auth-action button.

### 3.2 Interactive affordances
- **Filter pills** (`f.onPick`): `setState({ inboxFilter: f.id })` — client filters `inboxDocs` by `action` (legal && !confirmed), `pay` (kind==="pay"), `done` (has confirmed), or `all`.
- **List row click** (`d.onOpen` = `inboxViewDoc(d.id)`): `setState({ inboxSel: id, inboxView: "doc" })` — switches to doc view for that id. Note: this is a *different* entry path than `pkStart`/`inboxOpen` — clicking a locked row still navigates into doc view first (showing the passkey gate inline), it does not itself pop the modal.
- **목록 (Back)** (`onInboxBack` = `inboxBack()`): `setState({ inboxView: "list" })`.
- **Locked-gate button** (`onInbUnlock`): calls `pkStart(inbSelId)` if a doc is selected.
- **연결 개체 chips** (`lk.onOpen` = `inboxLinkGo(l)`): navigates by `l.to`: `"pay"` → `screen: "pay"` (payroll screen) + toast; `"att"` → `screen: "att"` (attendance) silently; `"notice"` → opens comms rail home view (`railUser:false, railView:"home"`) + toast; else generic toast "개체 — 상·하류는 객체 탐색에서 추적" (defers to object-explorer for lineage).
- **Passkey modal — 취소** (`onPkCancel` = `pkCancel()`): clears any pending timeout, `setState({ pkModal: null, pkPhase: "idle" })`.
- **Passkey modal — Auth button** (`onPkAuth` = `pkAuth()`): drives the read-gate state machine (detailed in §3.3 below).
- **Passkey modal — backdrop click** (`onPkBackdrop`): closes only if the click target is the backdrop itself (`e.target === e.currentTarget`), same as Cancel.

### 3.3 The passkey read-gate flow (compliance-critical UX pattern)
Applies to any inbox doc where `d.legal === true` (kinds: `contract`, `rule`, `promote`, `refusal` — i.e. everything except `pay`) **and** `!d.confirmed`. `inboxLocked(d) = !!(d && d.legal && !d.confirmed)`.

1. **Entry** — `pkStart(id)`:
   - Looks up the doc via `inboxDocOf(id)`.
   - If the doc is *not* locked (already confirmed, or not a legal doc — e.g. `pay` kind), it just selects it (`setState({ inboxSel: id })`) — no gate needed.
   - If locked, opens the modal: `setState({ inboxSel: id, pkModal: { docId: id }, pkPhase: "idle" })`.
2. **Idle** (`pkPhase: "idle"`): modal shows the doc's kind badge/ref/title, a static fingerprint icon in a neutral-bordered circle, prompt text "기기 인증기(지문·Face ID·PIN)로 본인 확인", and legal-basis chip if present (e.g. "근로기준법 §61" for 연차촉진). Auth button enabled.
3. **Scanning** (`pkAuth()` fires while phase is `"idle"`):
   - Guarded: `if (this.state.pkPhase !== "idle") return;` — re-entrant clicks are no-ops.
   - `setState({ pkPhase: "scanning" })` — spinner ring animates (`pk-spin`), ring color → signal, status text → "기기 인증기로 본인 확인 중…", icon pulses.
   - After 1050ms (`this._pkT` timeout): advances to `done`.
4. **Done** (`pkPhase: "done"`): ring → ok-solid green, checkmark icon replaces fingerprint, status text → "본인 확인됨 — 수령 증빙 기록". Held for 640ms (second nested timeout), then:
   - Modal closes: `setState({ pkModal: null, pkPhase: "idle" })`.
   - Calls **`inboxConfirm(id)`** — the actual confirm/receipt action — using the doc id captured from `pkModal.docId` before clearing.
5. **`inboxConfirm(id)`** (the confirm/receipt action itself, only reachable through this passkey chain for legal docs):
   - Builds a `stamp = { by: "전성진", at: "오늘 HH:MM" }`.
   - Sets `inboxDocs[matching id].confirmed = stamp` (this flips `inboxLocked` false thereafter, unlocking the body/detail and rendering the "수령 확인 완료" banner).
   - Side-effect: also finalizes any linked approval sub in `apprMySubs` where `receiptDoc === id` (`step: line.length, status: "finalized", receiptAt: stamp.at`) — ties inbox receipt confirmation back into the 전자결재 (e-approval) workflow object graph (e.g. 연차촉진/노무수령거부 notices that were pushed as AP- approval line items).
   - Toast: "{title} 수령 확인 — passkey 본인확인 완료, 열람이 법적 수령 증빙으로 감사 기록됩니다".
   - **`logEvent`** call: `{ action: "수령 확인", cat: "receipt", target: { type: kind==="pay" ? "급여" : "법적 문서", label: title, code: ref }, decision: "self", reason: "passkey 본인확인 · 열람 = 수령 증빙" }` — this is the actual audit-trail write; `decision: "self"` marks it as the person's own legal act of receipt (not a permit/forbid access-control decision), and it's the pattern audit rows render with a "본인" badge (`decLabel: "본인"`) rather than a permit/forbid badge.
   - **Note on `pay` kind**: pay docs are never `legal: true` in this pattern (per DESIGN "본인 급여 명세는 스스로 열람할 수 있다 (감사 미기록)" / POLICIES p3), so the payslip path never routes through the passkey gate at all — payslip viewing is deliberately *not* audited, in direct contrast to the passkey-gated legal docs which are audited specifically *because* opening them constitutes legal receipt.
6. **Compliance semantics**: the UX explicitly conflates "read/view" with "legal receipt" for this document class — the locked-gate copy states this outright ("열람이 곧 법적 수령 확인입니다" — viewing IS legal receipt confirmation). There is no separate "I acknowledge" click after unlocking; passkey success *is* the confirmation act. This matches the labor-law basis chips seen in seed data (e.g. 근로기준법 §61 연차촉진) where proof-of-receipt has legal weight (연차 사용 촉진 통지, 노무수령거부 notices, 근로계약, 취업규칙).

### 3.4 State read/written
- Read: `s.inboxDocs[]`, `s.inboxSel`, `s.inboxView`, `s.inboxFilter`, `s.pkModal`, `s.pkPhase`, `s.apprMySubs[]` (for the receipt→approval tie-back).
- Written: `inboxSel`, `inboxView`, `inboxFilter`, `pkModal` (`null` or `{docId}}`), `pkPhase` (`idle`|`scanning`|`done`), `inboxDocs` (confirm stamps a doc), `apprMySubs` (finalizes linked approval), `screen`/`railUser`/`railView` (via link navigation), `auditEvents` (via `logEvent` inside `inboxConfirm`).

### 3.5 Seed data shape — `inboxDocs[]` (constructor-seeded state, per task's given field list)
Fields (as provided): `id`, `kind` (`contract`|`rule`|`promote`|`refusal`|`pay`), `ref`, `title`, `from`, `date`, `legal` (bool), `basis`, `confirmed` (`null` or `{by, at}`), `body[]`, `links[{kind, label, to?}]`; for `kind === "pay"` additionally: `net`, `base`, `allow`, `ded`, `payDate`, `delta`, `dTone`.
- Kind→meta mapping (`inbKindMeta`, renderVals @6076-6082): `contract` → "근로계약" (purple), `rule` → "취업규칙" (warn), `promote` → "연차촉진" (warn), `refusal` → "노무수령거부" (danger), `pay` → "급여명세" (info); fallback "문서" (muted).

### 3.6 Methods driving INBOX
- `inboxOpen(id)`: `setState({ screen: "inbox", inboxSel: id||current, inboxView: "doc" })` — external entry point (e.g. from a notification/link elsewhere in the app) that jumps straight into inbox doc view.
- `inboxSelect(id)`: `setState({ inboxSel: id })` only (no view change) — lighter-weight selection setter, likely for list-row hover/pre-select use if ever added.
- `inboxViewDoc(id)`: `setState({ inboxSel: id, inboxView: "doc" })` — the list row's actual click handler.
- `inboxBack()`: `setState({ inboxView: "list" })`.
- `inboxDocOf(id)`: `state.inboxDocs.find(x => x.id === id) || null`.
- `inboxLocked(d)`: `!!(d && d.legal && !d.confirmed)`.
- `pkStart`/`pkCancel`/`pkAuth`/`inboxConfirm`/`inboxLinkGo`: see §3.3 above.

---

## 4. 감사 로그 (AUDIT, screen id `audit`)

### 4.1 Layout anatomy
- Header row: `<h1>감사 로그</h1>` + live pulse-dot "실시간" indicator + a standards-compliance chip (`auditStandards`, title "표준 감사 텔레메트리 정합" — points at the NIST/ISO/CADF-OCSF envelope). Spacer. A 3-cell inline stat strip (오늘/정책 거부/이상 counts, borders between cells, no card wrapper) + `내보내기` export button.
- Toolbar row: search input (`auditQ`, placeholder "주체 · 행위 · 개체 · 사유 검색") + filter pill row (`auditFilters`) + conditional **scope-drill chip** (`auditScopeOn`) showing "연관: {label}" with an inline × to clear + spacer + total count (`auditCount`건).
- Single card: scrollable, **day-grouped** event list (`auditGroups` → sticky day-header (`g.day`) → rows (`g.rows`)).
  - Collapsed row: time, actor-initial avatar circle, actor name (clickable → opens person profile), category badge (icon+label, color-coded per `audCatMeta`), target (optional code chip + label, clickable → `auditOpenTarget`), optional anomaly badge (triangle-warn icon), optional classification badge (민감정보/대외비/비밀 — 일반 shows no badge), optional decision badge (forbid="정책 거부" danger, self="본인" muted; permit shows nothing), chevron.
  - Expanded row (`e.openOn`): optional 사유 (reason) line, optional 변경 (before→after diff) line, then a metadata grid card: 주체·인증 / 기기·브라우저 / 위치·IP / 데이터 분류 / a full-width **정책 결정 (Cedar)** card ("이 평가가 열람·로깅을 구동" — this decision drove the view/logging) showing full decision + policy rule text / 세션·상관ID / a full-width **무결성·불변 해시 체인** line (`#{seq} · {hash} ← prev {prevHash}`). Two action buttons: `개체로 이동` (go to object) and `연관 이벤트` (correlate — sets scope drill).
  - Empty state: "해당 조건의 이벤트가 없습니다".

### 4.2 Interactive affordances
- **내보내기** (`onAuditExport`): toast "감사 리포트 내보내기 — 현재 필터 N건 · 서명·불변(append-only) 보존 · 컴플라이언스 포맷" — stub, but the copy signals the intended contract (append-only, signed export honoring current filter).
- **Search** (`onAuditQ`): free-text filter across actor+action+target(label/code/type)+reason+device+geo+browser+classification (all lowercased).
- **Filter pills** (`auditFilters`, `f.onPick`): sets `auditFilter` AND clears `auditOpen` (closes any expanded row on filter change). Filter ids: `all`, `workflow` (cat ∈ submit/finalize/approve/return/reject/receipt), `view` (cat==="view"), `forbid` (cat==="forbid"), `anomaly` (has `e.anomaly`), `sensitive` (classification ≠ 일반), `policy` (cat==="policy"). Note: `sensitive` and `policy` filter ids exist in `auditFiltered()` logic but only 7 defs are rendered (`all/workflow/view/forbid/anomaly/sensitive/policy` — all 7 are in `audFilterDefs`, confirmed at @6131-6139).
- **Scope-drill clear** (`onAuditScopeClear`): `setState({ auditScope: null })`.
- **Row toggle** (`e.onToggle`): accordion-expand, keyed by `auditOpen === e.id` (single-open, like POLICY).
- **Actor name click** (`e.onActor`, stops propagation): if `PEOPLE[actor]` exists, `openPerson(actor)` — jumps to that person's profile.
- **Target click** (`e.onTarget`, stops propagation): `auditOpenTarget(e)` (see §4.5).
- **연관 이벤트 / Correlate** (`e.onCorrelate`, stops propagation): sets `auditScope` to the event's target code (preferred) or label, and closes the open row (`auditOpen: null`) — this is what populates the scope-drill chip in the toolbar, letting the user pivot the whole log to "everything touching this object."
- **개체로 이동** button inside expanded row: same handler as target click (`e.onTarget`).

### 4.3 Classification badges (`auditClassify`)
```js
auditClassify(e) {
  if (e.cls) return e.cls;                                   // explicit override wins
  const tp = e.target?.type, lb = e.target?.label || "";
  if (/임원|비밀|인사 명령/.test(lb)) return "비밀";            // exec/secret/HR-order in label → 비밀 (Secret)
  if (tp === "급여" || tp === "법적 문서") return "민감정보";     // pay or legal-doc type → 민감정보 (Sensitive)
  if (["직원","취업규칙","연차촉진","노무수령거부","정책"].includes(tp)) return "대외비"; // internal-only
  return "일반";                                                // General — no badge shown
}
```
Badge tone map (`audClsMeta`): 민감정보 = warn, 대외비 = accent, 비밀 = danger; 일반 has no meta (no badge rendered, `clsOn = classify !== "일반"`).

### 4.4 Day-grouping
`audDayGroups` is built by iterating `audFiltered()` results in-order and grouping consecutively by `e.day` (linear scan, `find`-or-push — not a stable sort/bucket, so groups appear in the order the first event of that day was encountered in the already-filtered/day-ordered array). Seed events carry `day` values like `"오늘"`; runtime-logged events default `day: "오늘"` too (see `logEvent`).

### 4.5 `auditOpenTarget(e)`
```js
auditOpenTarget(e) {
  if (!e || !e.target) return;
  const tg = e.target;
  if (tg.type === "직원") {
    const nm = (tg.label||"").split(" ")[0].replace(/·.*/,"").trim();
    if (this.PEOPLE[nm]) { this.openPerson(nm); return; }
  }
  this.showToast(tg.type + " · " + tg.label + (tg.code ? " · " + tg.code : "") + " — 개체로 이동 (객체 탐색에서 상·하류 추적)", false);
}
```
For 직원 (employee) targets, resolves the first name-token against `PEOPLE` and opens that person's profile directly. For every other target type, falls back to a toast pointing at 객체 탐색 (Object Explorer) as the real navigation destination — i.e. AUDIT itself does not deep-link into every object type; only the person-profile shortcut is wired.

### 4.6 State read/written
- Read: `s.auditEvents[]`, `s.auditQ`, `s.auditFilter`, `s.auditScope`, `s.auditOpen`, `s.PEOPLE` (via `openPerson`).
- Written: `auditQ`, `auditFilter` (+ clears `auditOpen`), `auditScope` (via correlate / clear), `auditOpen` (row accordion toggle), and — indirectly, this screen is the *reader* of `auditEvents`, which is *written* by `logEvent()` calls scattered across the whole app (workflow toggles, approvals, receipts, etc.), never by AUDIT itself.

### 4.7 Seed data shape — `auditEvents[]` (constructor-seeded, per task's given field list)
Base fields: `id`, `day`, `t`, `actor`, `actorInit`, `action`, `cat` (`view`|`forbid`|`submit`|`finalize`|`approve`|`return`|`reject`|`receipt`|`system`|`auth`|`policy`), `target{type, label, code?}`, `decision` (`permit`|`forbid`|`self`), `reason?`, `session`, `ip`, `anomaly?`, `before?`, `after?`.
Runtime-appended events (via `logEvent`) additionally carry: `device`, `browser`, `geo`, `auth`, `seq`, `trace`, `prevHash`, `hash` — the hash-chained envelope.
Category → label/icon/tone map (`audCatMeta`, @6114-6126): view(muted,eye), forbid(danger,ban), submit(accent,trend), approve(ok,circleCheck), return(warn,repeat), reject(danger,ban), finalize(ok,fileCheck), receipt(purple,fingerprint), policy(info,shieldCheck), system(muted/faint,repeat), auth(muted,lock); unknown cat falls back to "이벤트"/activity icon/muted.

### 4.8 Methods driving the cross-cutting audit system (§ this is called from everywhere)
- **`deviceCtx()`** — derives request context from live browser state:
  ```js
  deviceCtx() {
    const vw = this.state.vw || window.innerWidth || 1400;
    const ua = navigator.userAgent || "";
    const device = vw < 768 ? "모바일" : vw < 1024 ? "태블릿" : "데스크톱";
    const browser = /Edg/.test(ua) ? "Edge" : /Chrome/.test(ua) ? "Chrome" : /Firefox/.test(ua) ? "Firefox" : /Safari/.test(ua) ? "Safari" : "기타";
    return { device, browser, ip: "10.20.11.4", geo: "창원 본사 · 사내망 (KR)", authMethod: "passkey (FIDO2)", managed: device === "데스크톱" };
  }
  ```
  Only `device`/`browser` are actually derived from the runtime (viewport width, UA sniff); `ip`/`geo`/`authMethod` are **hardcoded prototype constants** (single simulated office/network/auth-method — a real backend would populate these from the request).
- **`_evHash(ev)`** — deterministic DJB2-style string hash over `seq+t+actor+action+target.label+decision`, rendered as `"0x" + hex.padStart(8,"0")`. This is a **prototype stand-in** for a real cryptographic hash chain (DJB2 is not cryptographically secure) — it demonstrates the *shape* of hash-chaining (each event's hash depends on its own fields, and the next event references `prevHash`), not a production-grade integrity mechanism.
- **`auditClassify(e)`** — see §4.3.
- **`logEvent(partial)`** — the single append point for the audit trail, called from throughout the app (approvals, workflow toggles, schedule runs, inbox receipt confirms, etc.):
  ```js
  logEvent(partial) {
    if (!this._sess) this._sess = "s-8f2a";
    if (!this._seq) this._seq = 100420;
    this._seq += 1;
    const t = "HH:MM:SS" (now);
    const ctx = this.deviceCtx();
    const ev = Object.assign({
      id: "ev"+rand, day: "오늘", t, actor: "전성진", actorInit: "전", decision: "permit",
      session: this._sess, ip: ctx.ip, device: ctx.device, browser: ctx.browser, geo: ctx.geo, auth: ctx.authMethod,
      seq: this._seq, trace: "tr-"+rand, prevHash: this._lastHash || "0x00000000"
    }, partial);
    ev.hash = this._evHash(ev);
    this._lastHash = ev.hash;
    this.setState(s => ({ auditEvents: [ev, ...s.auditEvents] }));
  }
  ```
  Defaults: actor is always hardcoded to the logged-in prototype user ("전성진"), `decision` defaults to `"permit"` unless overridden, `day` defaults to `"오늘"`. Every call supplies a `partial` object (typically `action`, `cat`, `target`, sometimes `decision`/`reason`) that gets merged over these defaults. The instance keeps monotonic in-memory counters (`_sess`, `_seq`, `_lastHash`) that persist for the session, giving each new event a strictly increasing `seq` and a `prevHash` pointing at the prior event's `hash` — this is the hash-chain linkage rendered in AUDIT's "무결성 · 불변 해시 체인" line.
  Known callers observed in this pass: `wfToggle` (automation on/off, cat `policy`), `wfRun`/`schRun` (cat `system`, actor overridden to "자동화 엔진"/"예약 작업"), `inboxConfirm` (cat `receipt`, decision `self`) — confirming this is genuinely a shared, cross-screen envelope, not something AUDIT/INBOX own privately.
- **`auditFiltered()`** — applies `auditFilter`, `auditScope`, and `auditQ` (in that order) against `state.auditEvents`; this is what AUDIT's renderVals calls to produce `audFiltered`/`audDayGroups`, and it's also reused for `auditCount`/`onAuditExport`'s reported count.
- **`auditOpenTarget(e)`** — see §4.5.

### 4.9 Renderer bindings (audit) — notable derived values
- `auditForbidTone`/`auditAnomTone`: danger/warn tone only when count > 0, else `var(--ink)` (neutral) — avoids alarming color when nothing to flag.
- `auditGroups` row mapping computes, per event: `decFull` (human string "forbid · 거부" / "self · 본인 권리" / "permit · 허용"), `policyRule` (falls back to `e.reason` if it already mentions "Cedar", else synthesizes "Cedar forbid 규칙 적용" or "Cedar permit · {classification} 접근 · 기기={device}") — i.e. the UI backfills a plausible-looking Cedar policy citation string when the seed data didn't provide one verbatim in `reason`. Decision-card tone (`decCardBg/Bd/Tx`) is danger for forbid, muted otherwise.
- Hash-chain display always has safe fallbacks (`seq → "—"`, `hash → "—"`, `trace → "—"`, `prevHash → "genesis"`) for seed rows that predate the runtime `logEvent` fields.

---

## Cross-screen notes
- **Audit envelope is the one true cross-cutting system**: `logEvent`/`deviceCtx`/`_evHash`/`auditClassify` live in the "감사 로그" method section of the class but are invoked from workflow, automation-schedule, and inbox-receipt code paths elsewhere — AUDIT screen is a pure *reader/filterer* of `state.auditEvents`, never a writer of it itself (its own actions — search/filter/scope/expand — are not themselves audited).
- **DOCS and POLICY are the least-wired of the four**: both are backed by static, non-filtered-by-anything-except-client-search catalog methods (`DOCS()`, `POLICIES()`), with every mutating affordance (export, new policy, edit, simulate, doc-open) currently a toast-only stub pointing at "다음 단계 범위" (out of current scope / future slice). Compare INBOX/AUDIT, which have real state transitions and a real audit-envelope write (`inboxConfirm`).
- **INBOX is the one screen with a fully-wired compliance-critical flow** (passkey read-gate → `logEvent`), and it's also the one place where "opening/reading" itself is the legally significant action, deliberately contrasted with pay-slip self-view being explicitly exempt from audit — both facts are asserted directly in the seed copy and mirrored in POLICIES() row `p3`.
- **Object linkage**: DOCS row codes (`AP-`, `JL-`, `NT-`, `C-`, `IN-`), AUDIT target codes, and INBOX `links[]` all point at the same underlying 개체 코드 (object-code) convention used across the app, but only AUDIT (`auditOpenTarget`) and INBOX (`inboxLinkGo`) have any real navigation wired to those codes — DOCS row-open is a stub.
