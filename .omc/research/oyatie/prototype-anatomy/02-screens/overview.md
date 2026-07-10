# Screen: 통합 개요 (Overview) — `state.screen === "overview"`

Source: template lines 318-515 (default screen, `hint-placeholder-val="{{ true }}"` — renders by default). This is the landing screen and the ONLY screen using simple flex layout with no window/pin engine (no card registration in `CARD_META`).

## Layout anatomy

Page header (title "업무·운영 개요" + date/scope subline) + KPI strip (`kpis[]`, compact 1-row stat chips, `grid-template-columns:repeat(auto-fill,minmax(150px,1fr))`) + a two-pane "work zone" (`flex-wrap` controlled by `wzWrap` — nowrap side-by-side ≥1024px with no panels pinned, else stacked):

1. **처리 대기 (Action Inbox)** — the primary pane (flex 1.7). Header: title + total-count pill + filter chip row (`filters[]`: all/approval/dispatch/work/support, each showing a live count). Body: items grouped by urgency bucket (`groups[]`: 지금/오늘/대기 — colored pulsing dot per bucket) each containing rows (`g.items`). Each row: kind chip (60px, colored per `KINDS[kind]`), title+ref, entity chip + site + who + optional amount, due-text (color-coded by urgency), and either a primary action button (`it.primaryLabel` — 검토/배차/확인/회신 depending on kind) or a "done" badge if already handled. Rows are `draggable` (drag payload = item id, kind "obj") — can be dropped onto a quadrant zone (panel pin) or onto other UI drop targets (quick-add input, comment textarea, mail reply input) to attach a reference. Empty state (all handled): checkmark icon + "처리할 항목이 없습니다" + optional "처리 내역 복원" (undo-all) button. Footer hint bar: `J`/`K` move, `↵` detail, `⌘K` search kbd hints + "handled" count.
2. **오늘의 일정 (Today/Plan)** — secondary pane (flex 1, 280-460px). Header: day title + progress fraction/bar. Punch-in status chip. Week-strip (7-day picker, `week[]`, click switches `selDay`) + calendar-open icon button (opens CALENDAR MODAL). Scrollable schedule list for the selected day (`sched[]`): each row = time + (event blue rail OR todo checkbox) + title (+ optional scope chip, `@who` teal link, due badge, linked-object purple chips) + optional sub-line. Empty state placeholder. Footer: `+` icon + optional active quick-scope chip (removable) + quick-add text input with `@mention` autocomplete popover and drag-drop-to-link support (`addTodo`/`onQuickChange`/`pickMention`).

## Interactive affordances

| Affordance | Action / navigation |
|---|---|
| KPI chip click | `kp.onClick` — filters/navigates depending on KPI (not fully enumerated in template read; KPIs are clickable shortcuts into the inbox filter or a specific screen) |
| Filter chip click | Sets `state.filter` to `all\|approval\|dispatch\|work\|support`, narrows `visibleItems()` |
| Row click (not done) | `openDetail(id)` → opens TASK DETAIL MODAL (or restores from dock if already parked) |
| Row primary-action button | `rowAct(id)` — for `kind:"work"` items, marks done immediately ("확인 완료") without opening a modal; for all other kinds, delegates to `openDetail` |
| Row drag start/end | Sets `dragItemId`/`dragKind="obj"` for cross-drop (quadrant panel pin via `snapDrop`, or quick-add/comment/reply text field attachment via `dropToken`) |
| "처리 내역 복원" | `undoLast()` — reverts the most recent `setItemDone` action |
| Week-day pick | `w.onPick` → `setState({selDay: i})`, re-renders `sched` for that day |
| Calendar icon | `onCalOpen` → opens CALENDAR MODAL (`calOpen:true`) |
| Todo checkbox toggle | `toggleTodo(dayIdx, id)` — flips `done` on a `schedByDay[dayIdx]` entry (only `type:"todo"` entries are checkable; `type:"ev"` events are not) |
| `@who` link in schedule row | Opens PERSONNEL CARD (`openPerson`) |
| Linked-object chip in schedule row | `lk.onOpen` — navigates to the linked object (approval/work-order reference) |
| Quick-add input | `onQuickChange` (typing, triggers `@mention` autocomplete via `mentionOpen`/`mentionQ`), `onQuickKey` (Enter submits via `addTodo()`), drag-drop onto the input attaches a dragged item as a linked reference |
| Quick-add `@mention` picker | `pickMention(m)` — inserts a person mention into the quick-add draft |
| Quick-scope chip remove (×) | `onQuickScopeClear` — clears an active scope tag on the draft todo |

## State read/written

`items[]` (task queue, shared with 전자결재/배차/지원 flows — see `03-systems.md` for the cross-screen item model), `filter`, `scope` (from topbar, filters `scopedItems()`), `selectedId` (keyboard-nav cursor), `selDay`, `schedByDay[]` (7-day array, index = day offset from `WEEK_DATES[0]`), `quickVal`, `mentionOpen`/`mentionQ`, `quickScope`, `modal`/`docked`/`panels` (shared task-detail-modal/dock/panel machinery), `notifs[]` (dismissed via `dismissNotifFor` when an item completes), `punchedOut`, `lastAction` (undo target).

## Seed-data shapes (backend contract)

**`items[]`** (the unified cross-module task queue — approval/dispatch/work/support all share one shape):
```ts
{
  id: string, kind: "approval"|"dispatch"|"work"|"support",
  urg: "now"|"today"|"wait",
  ref: string,              // e.g. "AP-3121", "WO-2643", "CS-118"
  title: string,
  entity: string,           // entity key: hq|coss|knl|bestec|staff
  site: string,
  who: string,               // assignee/submitter display name, or "미배정" for unassigned dispatch
  due: string, dueTone: "danger"|"warn"|"neutral",
  amount?: string,           // approval only, formatted currency
  submitted: string,         // display date/time
  detail: string[],          // paragraph lines
  files?: [{name, size}],
  links?: [{kind, label}],   // cross-object references, rendered as purple chips, "kind" = object type label
  stats?: { spark?: number[], summary: string, delta?: string, tone: "warn"|"danger"|"neutral" },
  mailId?: string,           // support kind only — links to a mails[] entry
  done: boolean, doneLabel?: string, doneTone?: "ok"|"warn"|"danger"
}
```
This is the single most important shape in the whole prototype — the backend needs ONE unified "actionable work item" read model spanning at minimum: approval requests, dispatch requests, maintenance work orders, and support tickets, each carrying: urgency bucket, due SLA + color tone, submitter/assignee, monetary amount (optional), free-text detail lines, file attachments, cross-object links, and an analytics/trend block (sparkline + summary + delta). See `04-backend-contract.md`.

**`kpis[]`** — not fully captured from template read alone (values computed in renderVals, not re-derived here); structurally `{label, value, valueColor, sub, subColor, onClick}`.

**`schedByDay[]`** (7-element array, index 0-6 = `WEEK_DATES[i]`):
```ts
[{ id, type: "ev"|"todo", t: string /*HH:MM or ""*/, title, sub?, who?: "@Name", scope?: {kind, label}, due?: string, links?: [{ref, itemId}], done: boolean }]
```

## Methods driving it

- `scopedItems()` / `visibleItems()` — filter `items` by topbar scope then by `state.filter`.
- `pendingOf(list)` — filters to `!done`.
- `openDetail(id)` — the universal "open a task item" entry point: restores from dock if parked, else opens the TASK DETAIL MODAL with kind-specific fresh draft state (approval fields vs dispatch driver).
- `rowAct(id)` — work-kind items complete inline; everything else routes to `openDetail`.
- `setItemDone(id, done, doneLabel, doneTone)` — the shared completion mutator (also removes any pinned panel for that item).
- `undoLast()` — reverts `lastAction`.
- `toggleTodo`/`addTodo`/`addTodoToDay`/`onQuickChange`/`pickMention` — today/plan pane todo CRUD + mention-tagging.
- `dismissNotifFor(itemId)` — marks related notification rows read once an item completes.
- `flatPendingIds()` — the `now→today→wait` flattened id list driving global `j`/`k`/Enter keyboard nav (see `00-shell.md`).

## Carbon-copy notes

- Overview is the one screen with NO window/pin engine — a faithful copy should keep it as fixed two-pane flex, not force it into the 4-screen card system.
- The unified `items[]` "actionable work item" model is the backbone of the whole cross-cutting inbox/notification/audit/search-palette system — get this contract right first, everything else (rail promotion, palette results, keyboard nav, panels) reads from it.
