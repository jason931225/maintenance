# Screens: 인사 관리 (hr) · 조직도 (org) · 채용 (recruit) · 평가 (review)

Source: template lines 517-993 (HR 517-683, ORG 684-791, RECRUIT 792-887, REVIEW 888-993). `hr` and `review` are window/pin-engine screens (see `01-window-engine.md`); `org` and `recruit` are static flex layouts.

---

## 인사 관리 (HR) — `state.screen === "hr"`

### Layout anatomy
Uses the pin/window engine — `CARD_META.hr = {main:["roster"], side:["issues"]}`. Page header (title + headcount subline + 배치 preset dropdown + conditional "기본 배치" reset + "직원 등록" CTA button) + KPI strip (`hrKpis[]`) + a positioned zone (`hrZoneRef`) hosting:
- **직원 명부 (roster, main card)** — header: title + count pill + search input (`hrQ`). Body: sticky column header (이름/부서/직무/법인/근태/내선/입사) + scrollable rows (`hrRows[]`), each a full-row button (avatar-initial + name/title, team, job, entity chip, status chip + optional note, ext, joined date). Row click → opens PERSONNEL CARD. `j`/`k`/Enter keyboard nav supported (see `00-shell.md`).
- **근태 이상 (issues, side card)** — header: red dot + "근태 이상 · 오늘" + count. List of `hrIssues[]` (from `HR_ISSUES`, filtered by `hrHandled`): type badge (지각/미출근/연장), who (clickable→person card), detail line, "확인" button (unhandled) or "처리됨" badge (handled). Below: divider + "예정 인사 일정" (`hrPlan[]` — date + text, static upcoming-events list).

### Interactive affordances
- 배치 (layout preset) dropdown → `applyPreset("hr", presetId)` — 4 presets (기본/포커스/비교/단일 스택).
- "기본 배치" reset button (only shown when layout is customized) → `cardLayoutReset("hr")`.
- "직원 등록" CTA → stub in snapshot (no dedicated create-employee flow observed; likely opens a form not present in this read range).
- Search input → filters `hrFiltered()` (name/team/title/job/entity substring match, plus scope + `hrF` tone filter — issue/field/ok buckets).
- Roster row click → `openPerson(name)` (opens PERSONNEL CARD, logs a "열람" audit event unless viewing self).
- HR-issue row click → `openHrIssue(id)` → opens TASK DETAIL MODAL in `modalHrIssue` variant.
- HR-issue "확인" button → same as row click (opens the modal to resolve).
- Card header double-click / drag → pin/popout (window engine, see `01-window-engine.md`).
- Card hover toolbar (pin/minimize/close) + split-direction menu.

### State read/written
`hrQ`, `hrF`, `hrSel` (keyboard-nav cursor), `hrHandled[]` (resolved issue ids), `hrOtHours`/`hrOtPlan` (draft state for OT-type issue resolution), `cardLayout.hr`, `cardMode.hr`, `cardMin`, `cardFloat`, `layMenuFor`, `modal` (hr-issue variant), `personName` (opens personnel card).

### Seed-data shapes
**`EMPLOYEES[]`**: `{name, title, team, job, ent (display), entity (key), ext, joined, st (status label), tone: "ok"|"info"|"warn"|"danger", note?}`.
**`HR_ISSUES[]`**: `{id, type: "지각"|"미출근"|"연장", tone, who, team, ref (e.g. "AT-0703-01"), time, detail: string[], evidence: [{name,size}], links: [{kind,label}], ot?: bool}`.
**`PEOPLE{}`** (keyed by name, backs PERSONNEL CARD + `openPerson`): `{title, team, entity, ext, email, joined, me?: bool, thread?: threadId}`.

### Methods
`hrFiltered()` (scope+tone+search filter), `openHrIssue(id)`, `hrResolve()` (validates OT issues require comment+plan tag before resolving; marks `hrHandled`, closes modal/panel/dock), `attIssuesLeftN()` (badge count used in sidebar nav), `openPerson(name)`.

---

## 조직도 (Org Chart) — `state.screen === "org"`

### Layout anatomy
Static flex (no window engine). Page header (title + subline explaining click affordances + 편집/보기 toggle button). Body: horizontally-scrollable org tree — a single root node ("Acme 그룹 지주") connected via CSS-drawn tree lines to N entity columns (`orgCols[]`), each entity card containing nested site rows, each site containing nested team rows (2-level nesting: 법인→사업장→팀).

### Interactive affordances
- 편집/보기 toggle (`onOrgEdit`) → `state.orgEdit` — switches between read-only view (names as static text, click entity/site/team → opens the corresponding info card) and edit mode (names become inline `<input>` fields, adds "+ 팀 추가"/"+ 사업장 추가"/"+ 법인 추가" dashed buttons and team-remove ✕ buttons).
- Entity card click → opens ENTITY CARD modal (name/CEO/founded/reg-no/address/team-summary + "조직 개편 결재"/"법인 상세" buttons).
- Entity "i" info button → same, explicit trigger separate from the name click (name click in view mode also expands, per `oc.expandHint` title).
- Site row click → toggles site expand/collapse (implicit in the tree, `st.onSite`).
- Team row click (view mode) → opens TEAM CARD modal (name/path/head[clickable→person]/headcount + "팀원 명부"/"팀 채널" buttons).
- Team row is `draggable` (edit mode only, `tm.dragOn`) → drag onto another site's drop zone → `orgMoveTeam(toCi, toSi)` (moves the team in local state, toast clarifies "실제 반영은 조직 개편 결재로 상신됩니다" — i.e. the drag is a DRAFT reorg proposal, not an immediate live mutation).
- Edit-mode inline rename inputs → `orgRenameEnt`/`orgRenameSite`/`tm.onRename` (direct `onChange` state mutation, no explicit save step observed — implies autosave-to-draft).
- "+ 팀 추가" / "+ 사업장 추가" / "+ 법인 추가" → `orgAddSite(ci)` / `orgAddEntity()` (adds a placeholder-named node; toast explicitly says the real commit happens via "조직 개편 결재" — org changes are approval-gated, not direct writes).
- Team remove (✕, edit mode) → removes team from local draft.

### State read/written
`orgEdit`, `orgOpen[]`/`siteOpen[]` (expand state — referenced in state but exact usage not fully traced in this read), `entCard` (index or null), `teamCard` (`{name,head,hc,path}` or null), `orgData[]`.

### Seed-data shape
**`orgData[]`**:
```ts
[{ ent: string, meta: string, sites: [
  { name: string, hc: string, teams: [{ name: string, head: string /* "-" if vacant */, hc: string }] }
]}]
```
4 entities seeded (㈜코스/KNL 물류/BESTEC OEM/HR 스태핑), 2-3 sites each, 1-4 teams per site.

### Methods
`orgMoveTeam(toCi,toSi)`, `orgAddSite(ci)`, `orgAddEntity()`, `orgRenameSite(ci,si,v)`, `orgRenameEnt(ci,v)`.

### Backend contract implication
Org structure edits (add/rename/move) are explicitly modeled as DRAFT local-state mutations that require a downstream "조직 개편 결재" (org-restructure approval) submission to actually take effect — this is the org-chart's instance of the project's Draft→Archive lifecycle governance pattern (see project CLAUDE.md §핵심 원칙 and `03-systems.md`). A carbon copy must NOT wire these org-tree edits directly to a persistence endpoint; they should stage into an approval-workflow payload instead.

---

## 채용 (Recruit) — `state.screen === "recruit"`

### Layout anatomy
Static flex, single full-width card (no side card, no window engine). Header: title + headcount-progress subline (`rcHead`) + "공고 등록" CTA. Card header: "모집 공고" + hint text. Table: sticky columns (공고·사업장/충원/진행 단계/마감/chevron), rows = `rcPosts[]` — each collapsible (`rp.onToggle`) showing role+entity chip+site, a fill-progress bar (hired/need), a 4-stage pipeline mini-chart (`rp.stages[]`: 접수/서류/면접/오퍼 counts), and due date. Expanding a row reveals its candidate list (`rp.cands[]`): stage badge, name, optional 보류/보충 대기 flags, description, "다음 단계" button, and a `⋮` overflow menu (보충 서류 요청/보류-토글/탈락 처리). Row-expanded footer notes rejected-count if any. Table footer: static pipeline-stage legend + PII audit notice.

### Interactive affordances
- "공고 등록" → stub (no create-posting flow observed in this read range).
- Post row click → toggles `rp.openOn` (expand/collapse candidate list).
- Candidate "다음 단계" button → `rcAdvance(pid, cid)` — advances candidate through 접수→서류→면접→오퍼; if already at 오퍼 (`st>=3`), instead marks HIRED (increments `hired`, removes from `cands`, shows "충원 완료" toast if quota met) — **this is the "입사 = 직원 개체 생성" chain point** (hiring a candidate should, per project CLAUDE.md, create an EMPLOYEES record — not directly observed as implemented in-template but implied by the toast message and the project's documented 개체 체인 invariant).
- Candidate `⋮` menu → `rcCandAct(pid, cid, act)`: `"reject"` (removes candidate, increments `rejected` count, toast notes the applicant is notified — this feeds the "탈락 사유→인재풀" chain per CLAUDE.md), `"doc"` (flags `docReq:true`, requests supplementary documents), toggle-hold (flips `hold` flag).

### State read/written
`rcOpen` (which post is expanded), `rcActFor` (which candidate's overflow menu is open).

### Seed-data shape
**`rcData[]`**:
```ts
[{ id, role, ent, site, need: number, hired: number, due: string, rejected?: number, cands: [
  { id, name, st: 0|1|2|3 /* 접수|서류|면접|오퍼 */, d: string /* description */, hold?: bool, docReq?: bool }
]}]
```

### Methods
`rcAdvance(pid,cid)`, `rcCandAct(pid,cid,act)`.

---

## 평가 (Review) — `state.screen === "review"`

### Layout anatomy
Uses the window/pin engine — `CARD_META.review = {main:["teams"], side:["tasks"]}`. Page header (title + cycle-name/deadline subline + 배치 preset dropdown + conditional reset). Positioned zone hosting:
- **팀별 진행률 (teams, main card)** — list of `rvTeams[]`: team name + progress bar + percentage label. No further drill observed in this read range.
- **내 평가 할 일 (tasks, side card)** — list of `rvTasks[]`: due-date badge + task text (optionally a clickable person name → `tk.onWho`) + "작성" (write) button (`tk.onWrite`).

### Interactive affordances
- 배치 preset dropdown / reset — same pattern as HR.
- Task row person-name click → `openPerson`.
- "작성" button → stub in this read range (likely opens a review-authoring modal not captured; not present in the read template span).
- Card hover toolbar (pin/minimize/close) + split menu — window engine, identical mechanics to HR.

### State read/written
`cardLayout.review`, `cardMode.review`, standard window-engine state.

### Seed-data shapes
**`rvTeams[]`** (renderVals-computed, not raw constructor seed — shape: `{team, pctW, pctColor, pctLabel}`).
**`rvTasks[]`** (renderVals-computed — shape: `{d /*due*/, whoOn, t /*text*/, onWho, onWrite}`). Neither has a raw constructor-level seed array visible in the read range — the underlying review-cycle data source was not located in this pass; **flagged as needing a follow-up read of the constructor for a `REVIEW`/`rvData`-equivalent seed array**, or these may be entirely renderVals-synthesized placeholders with no real backing seed (worth verifying against a fresh `grep -n "rvTeams\|rvTasks" ` pass before treating as a stable backend contract).

---

## Backend contract summary for this batch
- HR needs: employee roster CRUD + read (EMPLOYEES shape), attendance-issue queue (HR_ISSUES shape) with a resolve action requiring justification for OT-type issues, person detail (PEOPLE shape, tiered visibility per PERSONNEL CARD in `00-shell.md`).
- Org needs: org-tree read (orgData shape) + a DRAFT reorg-proposal endpoint (not direct entity/site/team mutation) that feeds into 전자결재.
- Recruit needs: posting+candidate pipeline read/write (rcData shape), stage-advance mutation, hire mutation (should create an employee record per the object-chain invariant), reject/hold/doc-request mutations, rejected-candidate pool retention (탈락 사유 기록 + 인재풀 보관, per template footer text).
- Review needs: a review-cycle data model (teams progress + per-person task list) not fully captured here — **gap for follow-up verification**.
