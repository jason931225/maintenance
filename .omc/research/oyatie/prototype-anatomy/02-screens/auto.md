# Screen: 자동화 — 워크플로 스튜디오 · 예약 작업 (auto) — `state.screen === "auto"`

Source: constructor seed (lines 3844-3868), methods (4789-4832), nav wiring (6203-6206, two sidebar entries both routing to `screen:"auto"` with different `autoTab`), renderVals view-calc (6154-6159, 7007-7011).

**IMPORTANT**: No template markup for this screen was found in the Jul-4 snapshot (`grep -n "scrAuto\|autoTab" ` over the template region 315-3414 returns zero hits inside that range — the only `scrAuto`/`autoTab*` hits are all inside `renderVals()`, i.e. past line 5862, meaning the view-model is computed but the actual `<sc-if value="{{ scrAuto }}">` template block is either absent from this file or was truncated/not-yet-authored at the Jul-4 snapshot point). Treat this screen's UI layout as **UNVERIFIED-AGAINST-SNAPSHOT** even though its state/logic IS real and present — it is a "logic built ahead of template" case, distinct from the fully-post-snapshot screens in `05-post-snapshot-todo-digest.md`. A carbon-copy builder should infer the layout from the data shape (a master-detail: tab switcher workflow/schedule → list → detail panel) rather than from any captured template.

## Inferred layout (from data shape + renderVals view-calc, NOT from template)
- Two-tab switcher: **워크플로 스튜디오** (`autoTab:"workflow"`) / **예약 작업** (`autoTab:"schedule"`) — `autoTabs` renderVals array gives tab chip styling + counts (`s.workflows.length` / `s.schedules.length`).
- Sidebar nav badges: 활성(active) count per tab — `autoActiveN`/`schActiveN` (filtered `.active` counts), shown as neutral-tone badges next to "워크플로 스튜디오"/"예약 작업" nav items.
- Master list (left): workflow or schedule rows, each selectable (`autoSel`/`autoSchSel`).
- Detail panel (right): the selected `autoWf`/`autoSch` record's full trigger/condition/action breakdown (workflow) or cron/history breakdown (schedule).

## Interactive affordances (from methods)
| Method | Effect |
|---|---|
| `autoSetTab(t)` | Switches `autoTab` between workflow/schedule |
| `autoSelWf(id)` | Selects a workflow for the detail panel |
| `autoSelSch(id)` | Selects a schedule for the detail panel |
| `wfToggle(id)` | Flips a workflow's `active` flag; `logEvent({action: "자동화 활성화"/"자동화 비활성화", cat:"policy", target:{type:"워크플로", label}})` — this is a POLICY-category audit event, i.e. toggling automation is treated as a governance action |
| `wfRun(id)` | Manually triggers a workflow run; `logEvent({actor:"자동화 엔진", actorInit:"⚙", action:"자동 실행", cat:"system", ...})` |
| `wfSimulate(id)` | Dry-run simulation (no state mutation observed beyond what's in the method signature — likely opens a simulation preview, exact body not fully captured) |
| `schToggle(id)` | Flips a schedule's `active` flag |
| `schRun(id)` | Manually triggers a scheduled job; `logEvent({actor:"예약 작업", actorInit:"⏱", action:"수동 실행", cat:"system", target:{type:"예약작업", label}})` |
| `schEditOpen(id)` | Opens an inline cron-label editor (`schEdit: id, schEditVal: j.cronLabel`) |
| `schEditSave()` | Commits the cron-label edit (exact body not captured in this read pass — infer a simple `setState` write-back to `schedules[].cronLabel`) |

## State read/written
`autoTab`, `autoSel`, `autoSchSel`, `schEdit` (id being edited or null), `schEditVal` (draft cron-label text), `workflows[]`, `schedules[]`.

## Seed-data shapes (backend contract)

**`workflows[]`**:
```ts
{
  id, name: string, active: bool, runs: number, lastRun: string, lastResult: "ok"|"warn"|"error",
  trigger: { label: string, icon: string },
  when: [{ label: string }],           // condition clauses, free-text described
  then: [{ label: string, icon: string }]  // action clauses, free-text described
}
```
4 seeded workflows, all real business logic descriptions (not placeholder): "무단결근 3회→인사 알림·소명 기안 자동생성", "연차 소진율<20%&7/1→촉진 1차 자동발송", "연장근로 승인→근태·급여 자동반영", "계약 만료 D-30→갱신 검토 기안" (last one `active:false`). Note the trigger taxonomy already implies TWO trigger kinds even in-snapshot: event-driven ("근태 이벤트", "결재 이벤트") and schedule-driven ("예약 트리거 · 매년 7/1 09:00", "예약 트리거 · 매일 02:00"). This is the frontend-side precursor to the backend gap **BE-AUTO** (`workflow_trigger_bindings` — see backend-adequacy-audit gap #8).

**`schedules[]`**:
```ts
{
  id, name: string, cronLabel: string /* human-readable */, cron: string /* real cron expr, e.g. "0 17 * * *" */,
  next: string, last: string, active: bool, lastResult: "ok"|"warn"|"error",
  history: [{ t: string, result: "ok"|"warn"|"error", note: string }]
}
```
5 seeded schedules with REAL cron expressions: 근태 마감 리마인더 (daily 17:00), 월 급여 회차 생성 (monthly day-25 09:00), 연차 촉진 배치 (yearly 7/1 09:00), 보존기한 만료 알림 (daily 02:00), 주간 운영 리포트 (weekly Mon 08:00, `active:false`). This is direct frontend evidence that the design assumes a real cron-scheduler backend — confirms backend-adequacy-audit gap #9 (recurring schedules backend is entirely missing; "SCHEDULE TriggerType never produced").

## Methods driving it
See table above. `_autoAP(title, tmpl, line)` (4793) — likely a helper constructing an auto-generated approval-package (`AP-`) object from a workflow's `then` action, consistent with workflow `wf1`'s described behavior ("소명 기안(AP-) 자동 생성 → 대상자") — exact body not captured in this pass but the name + call context imply it synthesizes an approval item and pushes it into `items[]`.

## Backend contract implications
This screen's seed data is the frontend's most direct evidence for the **BE-AUTO** backend charter (trigger bindings + recurring schedules — backend-adequacy-audit gaps #8, #9, #10): every workflow record already models a trigger/condition/action triple, and every schedule record already carries a real cron expression + run history, but (per the audit) the backend has zero rule-binding table and zero cron/schedule substrate — the sole real backend trigger is one hardcoded inline call in `m2_strangler.rs:269`. A carbon copy must not wire this screen to a live backend until BE-AUTO ships; until then it should be built dark/mocked against this exact seed shape so the eventual real integration is a drop-in swap.
