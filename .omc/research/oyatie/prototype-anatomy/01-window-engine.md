# 01 — Window / Pin Engine

Source: `Oyatie Console.dc.html`, methods at lines 4278-5395 (verified against Jul-4 snapshot). This is the card-layout system used by **hr**, **review**, **att**, **pay** screens (the only 4 screens wired to it in the snapshot — see `CARD_META` below). Every other screen uses static flex layout with no pin/float/tray capability.

## Core config objects (constructor, ~3592-3610)

```js
CARD_META = {
  hr:     { off: 214, main: ["roster"], side: ["issues"],              min: { roster: 340, issues: 300 } },
  review: { off: 176, main: ["teams"],  side: ["tasks"],               min: { teams: 260, tasks: 240 } },
  att:    { off: 214, main: ["board"],  side: ["ex","close","w52"],    min: { board: 360, ex: 172, close: 236, w52: 196 } },
  pay:    { off: 240, main: ["reg"],    side: ["ex","cost","sched"],   min: { reg: 360, ex: 216, cost: 238, sched: 186 } }
}
CARD_TITLES = {
  hr: { roster: "직원 명부", issues: "근태 이상" },
  review: { teams: "팀별 진행률", tasks: "내 평가 할 일" },
  att: { board: "근무 현황", ex: "근태 예외", close: "근태 마감", w52: "주 52시간 모니터" },
  pay: { reg: "급여 명부", ex: "예외 검토", cost: "지급 총액", sched: "지급 일정" }
}
```
Each screen (`scr` key: `hr|review|att|pay`) has a `main` column (63% width by default) and a `side` column (37%), each holding an ordered list of card ids. `off` = vertical pixel offset consumed by the page header above the card zone (used to compute available height budget).

`CARD_PRESETS` — 4 named layout presets, each a `make(meta) -> {main, side, h, split}` factory:
- `default` — meta's original main/side split, `split: 0.63`
- `focus` — same main/side, `split: 0.74` (main card enlarged)
- `compare` — `split: 0.5`
- `stack` — all cards (main+side) merged into `main`, `side: []`, full width, `split: 0.63`

Selecting a preset calls `applyPreset(scr, pid)` which replaces `state.cardLayout[scr]` wholesale and clears `cardMode[scr]`.

## State shape

- `cardLayout: { [scr]: { main: string[], side: string[], h: {[cardId]: number}, split: number } }` — per-screen card order/heights/split ratio. `h[id]` is an explicit pixel height override (absent = auto-computed from `min` budget-fill algorithm). Persisted to `localStorage["oyatie-cards-v1"]`.
- `cardMode: { [scr]: null | {kind:"max", id} | {kind:"modal", id} | {kind:"split", id, dir:"left"|"right"|"top"|"bottom"} }` — transient full-viewport-within-zone modes, one active card at a time per screen.
- `cardMin: [{scr, id}]` — cards minimized to the docked task tray (bottom bar).
- `cardFloat: { [scr+":"+id]: {x,y,w,h,ax,ay,pinned,dock} }` — cards popped out of the zone into a free-floating (or docked-pinned) window. `ax`/`ay` are magnet-snap anchors (`"left"|"cx"|"right"` / `"top"|"cy"|"bottom"`) recomputed on viewport resize (`componentDidUpdate`) so the float re-anchors relative to the live sidebar/rail-adjusted main content area.
- `cardHover: {scr,id} | null` — which card currently shows the hover toolbar (3-button controls), set after a 300ms `cardHoverEnter` debounce, cleared after a 260ms `cardHoverLeave` debounce (debounce is bypassed while the toolbar itself is hovered via `cardToolKeep`/`_hvKeep`).
- `cardSplitMenu: boolean` — split-direction submenu open on the hover toolbar.
- `cardDrag: {screen, id, tz, ti} | null` — live drag-reorder target zone (`tz`: "main"|"side") and target index (`ti`), computed continuously in `cardDragMove` from mouse Y vs each card's midpoint.
- `layMenuFor: string | null` — which screen's preset dropdown is open.
- `quickCards: [{scr,id}]` — cards flagged "quick" (bookmarked for fast access from Overview's + menu); independent of layout/float/min state.

## Card lifecycle states

1. **default** — laid out in its zone's `main`/`side` column per `computeCardLay`, height auto-filled from remaining budget proportional to `min` weights (or fixed if `h[id]` set).
2. **pinned** (`cardFloat[key].pinned === true`) — `cardPinRight(scr,id)`: docks the card as a real space-reserving side panel (desktop: right side, `dock:"right"`, width 44% of main area clamped 360-620px, full available height) or bottom sheet on narrow viewports (`vw<1024`: `dock:"bottom"`, height 42% of viewport). Reserves real layout space — `bodyPadRightPx`/`bodyPadBottomPx` (renderVals, computed from `cardFloat` pins) padding the page body so content doesn't sit under the pin. Toggling again (already pinned) unpins → returns to default zone position. Triggered by **double-clicking the card header** (`onDbl` handler, only fires if click Y ≤ 54px from top and not on an interactive child) or the pin button in the hover toolbar.
3. **popout** (`cardFloat[key]` present, `pinned: false`) — free-floating window, does NOT reserve space (overlays canvas). Created by `cardGrab` (header mouse-down drag, immediately starts `startFloatDrag`) or `cardPopOut` (explicit popout button — if the card is currently an unpinned float already, this instead calls `cardRestoreDefault`, i.e. it's a toggle). Default popout size 468×412 at cursor position (drag) or centered (`cardPopOut`: `ax:"cx"`).
4. **minimized/tray** (`cardMin` membership) — hidden from its zone, chip appears in the docked task tray at the bottom of the viewport. `cardMinToggle(scr,id)` toggles; also auto-triggered when a float drag ends with the card released below `vh - 42px` (drag-to-tray gesture in `startFloatDrag`'s `_fmUp`).
5. **restored** — `cardRestoreDefault(scr,id)` deletes the float entry and clears any cardMode for that id, returning it to normal zone flow (used by the hover toolbar's close/X button, and by `cardPopOut` toggle-off).

## Header drag → popout mechanics (`cardGrab`)

- Only starts on left-button mousedown (`e.button === 0`), and only if the mousedown target is NOT an interactive control (`closest("button,input,textarea,select,a,[role=button],[role=listbox],[contenteditable]")`).
- Only starts if the mousedown Y is within the card header band (≤54px from the card's top edge) — body scroll/click is never hijacked.
- If the card is already a float: unpins it if pinned, then calls `startFloatDrag` from its current float position (drag continues an existing float).
- If viewport `vw < 1024`: grab immediately snaps to `cardPinRight` (mobile/narrow has no free-float — grab = pin-to-bottom-sheet).
- Otherwise: creates a fresh unpinned float (468×412) positioned under the cursor (`cx-46, cy-14`, clamped to viewport), then calls `startFloatDrag` to continue tracking the mouse from that point.

## Double-click → pin with real space reservation

Handled inline in `cardVal`'s returned `onDbl` handler: guards against clicks on interactive children and against clicks below the 54px header band, then calls `cardPinRight(scr,id)`. This is the ONLY way to pin without going through the hover-toolbar pin button. Pin reserves space by:
1. Computing `mainArea()` (`{left,right}` in px, derived from sidebar/rail collapse state and viewport width — sidebar left edge = 62px collapsed / 236px open; rail right edge = 54px collapsed / 300-336px open depending on `vw`).
2. Placing the float at `ax:"right"|"left"`, full-height, width 360-620px (desktop) — or bottom-sheet 42vh (narrow).
3. `renderVals` then computes `bodyPadRightPx`/`bodyPadBottomPx` from the minimum `x`/`y` among all `pinned` floats, so the page body's CSS `padding-right`/`padding-bottom` grows to avoid underlap — this is the "real space reservation," distinct from popout which just floats on top with no reservation (`z-index` stacking only).

## Tray (docked task bar)

- Membership: `state.cardMin`. Rendered as a fixed bottom bar (`trayOn` sc-if) listing minimized cards as chips.
- Chip click → `cardMinToggle(scr,id)` again (restores to whatever it was before minimizing — floats lose their float state since `cardFloat[key]` is deleted on minimize, so restoring from tray always returns to the DEFAULT zone position, never back to float/pin).
- Empty state: `trayEmptyOn` sc-if shows a placeholder when `cardMin` is empty (tray bar itself only rendered when `trayOn`, gated by `cardMin.length > 0` presumably in renderVals — tray bar is otherwise hidden entirely).
- Distinct from the separate **docked task modal system** (`state.docked`, `dockModal()`/`restoreDock(id)` methods) — that is a DIFFERENT mechanism for parking an open TASK-DETAIL MODAL (approval/dispatch/hr-issue) so the user can navigate away and resume later; it reuses similar tray-chip visual language but operates on `items[]` task ids, not on layout cards. Do not conflate: card-tray = layout cards; docked-modal-tray = paused task detail modals.

## Hover 3-button controls (`cardToolVals`)

Shown when `state.cardHover` matches the current screen, positioned absolutely at the top-right of the card (or float, or modal-mode card, computed per-position-mode in `cardToolVals`). Three buttons, left to right:
1. **Pin** (`cardPinRight`) — icon toggles based on `pinned` state; tooltip "핀 — 분할 패널 고정 (더블클릭)" / "핀 해제 — 기본 배치".
2. **Minimize** (`cardMinToggle`) — always "최소화 — 작업 트레이".
3. **Close** (`cardRestoreDefault`) — always "닫기 — 기본 배치로".

A 4th split-direction affordance is separate: hovering reveals a split submenu (`cardSplitMenu` state, opened via a splitter icon not enumerated in the 3 buttons above — actually the split menu is invoked via `cardModeSet(scr, {kind:"split", ...})` from `opts` computed in `cardToolVals`, 4 directions left/right/top/bottom, reduced to 2 (left/right only) when `state.panels.length > 0` i.e. when quadrant split-screen panels are already open). Split mode makes the card occupy exactly half the zone (by width for left/right, by height 48%/52% for top/bottom) with the remaining cards in that column re-flowing into the other half.

There is also a **max** mode (`cardModeSet(scr,{kind:"max",id})`) not exposed via a toolbar button in the read code but settable via `cardModeSet` — expands the card to 100% of the zone, hiding all siblings (`vis:false`).

## Reference pins (`cardFloat` anchor system)

`cardFloat[key].ax`/`ay` store a semantic anchor (not raw pixels) so the float re-flows correctly when the sidebar/rail collapse or the viewport resizes:
- `ax`: `"left"` (mainArea.left+12), `"cx"` (horizontally centered in main area), `"right"` (mainArea.right - w - 12), or `null` (free, absolute pixel position not re-anchored).
- `ay`: `"top"` (y=64), `"cy"` (vertically centered), `"bottom"` (vh-40-h-12), or `null`.
- `componentDidUpdate` recomputes all anchored floats' `x`/`y` whenever `vw`/`vh`/sidebar-collapse/rail-collapse changes, clamping into viewport bounds.
- During a drag (`startFloatDrag`), a magnet-snap pass (`MAG=12px` threshold) tests the float's candidate position against the 3 `ax` targets and 3 `ay` targets and snaps + records the hit anchor in `this._fm.hitX`/`hitY`; on mouseup these become the float's new `ax`/`ay` (or `null` if no snap occurred — free position, un-anchored until next drag).
- A secondary 16px grid-snap (`GRID=16`, `TICK=6`) applies independently for fine alignment.

## Panels (quadrant split-screen) + `snapTo`

Distinct top-level system (not part of the card engine, but interacts with it): `state.panels` is an array of up to N "pinned detail" panels arranged in a 2×2 CSS grid (`grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr`) alongside the main `dashArea` body — dragging a task-list item (approval/dispatch/mail/person) onto one of 4 invisible quadrant drop-zones (`snapDrop(zone)` computes hit-testing, `dragSnapKind` state) calls `snapTo(zone, entryO, quiet)` to pin that item's mini-detail view into the grid quadrant. When `panels.length > 0`, the main body's own card engine (`cardToolVals` split options) narrows to left/right only, and card layouts go "narrow" mode (`narrow = vw<1024 || panels.length>0`) which stacks all cards full-width regardless of main/side split.

## Exact method behaviors (verbatim summary)

- **`cardVal(scr,id)`** — the single source of truth for a card's CSS geometry. Priority: (1) if floated and not minimized → `pos:fixed`, raw float `x/y/w/h`, `z:80`. (2) Else pull from `computeCardLay(scr).cards[id]` (or default `{x:0,w:100%,y:0,h:300}` if not yet computed) → `pos:absolute` (or `fixed` if `cd.modal`), applies drag-opacity (`0.45` while being drag-reordered) and z-index (`130` modal / `30` dragging / `1` normal). Also returns the drag/resize/corner-resize handler bindings and correct corner-resize-cursor side (`cornerLeft` flips based on whether the card is in the side zone or was popped from the right, so the resize handle appears on the correct visual corner).
- **`cardToolVals(scr)`** — computes hover-toolbar visibility + position + button list + split submenu options, described above. Returns an "empty" (`on:false`) result unless `state.cardHover` targets this screen AND (the card is floated OR the current screen matches, i.e. toolbar only shows for the active screen or an always-visible float).
- **`cardGrab(scr,id,e)`** — described under "header drag" above; the entry point for both popout-drag and (on narrow viewports) pin.
- **`cardPinRight(scr,id)`** — described under "pin" above; is a toggle (pin/unpin) keyed on `cur.pinned`.
- **`cardRestoreDefault(scr,id)`** — unconditional: deletes the float key, clears matching `cardMode`, removes from `cardMin`. Used as the "X close" action from anywhere a card can be in a non-default state.
- **`computeCardLay(scr)`** — the layout solver. Computes: `narrow` (vw<1024 or panels open), `budget` (available px height = max(430, vh-off)), then branches on `cardMode[scr].kind` (max/modal/split) vs normal 2-column stacking (`stackCol` helper: fills fixed-height cards first, then distributes remaining budget proportionally across auto-height cards by their `min` weight, floor-clamped to `min`, never shrinks below `min`). Caches result in `this._layCache[scr]` (read synchronously elsewhere in the same render for `cardVal`/`cardToolVals`/`cardDropVals` — these must run AFTER `computeCardLay` in the same tick, which `renderVals()` enforces by calling `computeCardLay` for all 4 screens up front before computing per-card vals).

## Related but distinct systems (do not conflate in carbon-copy)

- **`docked`/`dockModal`/`restoreDock`** — task-detail-modal parking (separate from card-tray).
- **`panels`/`snapTo`/`snapDrop`** — quadrant split-screen pinned mini-detail views (separate from the 4-card-screen layout engine, though it forces those 4 screens into narrow/stacked mode while active).
- **`quickCards`** — pure bookmark list, no geometry, unrelated to float/pin/min state machine.

## Carbon-copy notes

- This engine is genuinely complex (drag physics, magnet snapping, budget-proportional auto-sizing, anchor re-flow on resize) and is used on exactly 4 screens in the snapshot. A faithful carbon copy needs: (1) a `CARD_META`-equivalent per-screen card registry, (2) the `computeCardLay` budget-fill algorithm verbatim (it is the least discoverable part — pure math, easy to get subtly wrong), (3) the anchor-based float re-flow on viewport/chrome changes, (4) the header-band (≤54px) + non-interactive-target guard for both drag-start and double-click-to-pin (an easy source of accidental-drag bugs if omitted).
- `localStorage["oyatie-cards-v1"]` persistence (`persistCards()`) is prototype-only state; a real backend would need a per-user layout-preference endpoint if this UX is to survive across devices — not currently in the backend-adequacy audit's gap list, worth flagging as a minor net-new requirement if carbon-copied faithfully (low priority, cosmetic).
