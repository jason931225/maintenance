This is a synthesis/writing task — I have the full evidence base (ontology, object-view + nav, lenses, blueprint visual) provided directly in the prompt. No further file reading needed. I'll produce the four deliverables tight and opinionated.

# FORKLIFT FSM CONSOLE — THE PALANTIR NORTH STAR

## (1) NORTH STAR — one page

**Stop building pages. Start building objects.** Today the console is 13 page-per-table CRUD screens. The target is a single object-centric instrument where the **ontology is the product**: every real-world thing (장비, 작업지시, 정비사, 고객, 현장, 점검, 매입요청, 매물, 대차, 이상징후) is a first-class **Object** with a 360° view, its **Links** are clickable, and its **Actions** are role-gated, audited, closed-loop write-backs.

Five layers, one substrate:

1. **Ontology** — 17 object types on the tenancy spine `Org → Region → Branch → User`, joined by real FK links (Customer→Site→Equipment→WorkOrder→Mechanic, Equipment↔Equipment 대차, Equipment→CostLedger→PurchaseRequest, the polymorphic GovernanceFinding→anything, universal AuditEvent). The schema already *is* an ontology — we surface it.

2. **Object Views** — ONE reusable kit (`ObjectViewScaffold` + N config files), not N hand-rolled detail pages. Identity band → properties → linked-object rail → timeline → audit trail → gated ActionBar. Today WorkOrder is the lone exemplar; Equipment is the next anchor (richest links). Every link is an `ObjectLink` (never leaks a UUID — `safeLabel` rule).

3. **Triage Home** (`/home`) — the decision-first landing that replaces "land on a table." Per-role queue cards: *"what needs me now,"* each row = object + its pre-targeted resolving action. Dispatcher sees 미배정 P1, mechanic sees 오늘 내 작업, executive sees 임원 승인 대기 + 이상 징후, admin sees 미분류 우선순위. An empty queue is a *good* state.

4. **Four Lenses** over the *same* object set — Gotham's analytical surfaces, never dead dashboards: **Map** (#29, live mechanics + equipment + open WOs, draw-polygon → assign), **Timeline** (equipment lifecycle ribbon = the repair-vs-replace story as one picture; per-mechanic day), **Graph** (Customer→Site→Equipment→WO→Mechanic with Search-Around; the corp-grouping #37 UI), **Faceted** (KpiPage/Ops tiles → interactive facets that drill to actionable object sets — #24). Every lens selection flows into a shared `<LensActionBar>`.

5. **Blueprint skin** — a `.console`-scoped operational-industrial layer over the C1–C13 polish: 13px dense type, mono+tabular for ids/₩/timestamps, one centralized `tone` semantic-color map (color = meaning, AA-tuned), sticky/zebra/roving-keyboard `DataTable`, 36px controls, ⌘K omnibar, breadcrumbs, dark-ready. Storefront untouched.

**The through-line: closed-loop + provenance.** Every screen ends in a *named, validated, audited, console-only* Action (never raw SQL — the operations memory). Every object shows its source + freshness + AuditEvent stream. The WO 16-state FSM, the approval line, and the Purchase amount-gated FSM are the proof that write-back is real, not decorative.

---

## (2) RECONCILED MODEL

### Ontology (canonical)
- **Spine:** `Org → Region → Branch → User`; RLS on `app.current_org`, armed on every tenant read (the bypassrls memory — test as `mnt_rt`).
- **Anchor objects:** Equipment (`registry_equipment`, 40+ cols, 호기 `AAANN-NNNN`), WorkOrder (`work_orders`, 16-state FSM, `request_no`), User/Mechanic (roles[] + team + branches), Customer/Site (registry hierarchy), Inspection (schedule→round), PurchaseRequest (amount-gated FSM → writes CostLedger), Inquiry/SalesListing (storefront), Region/Branch, Substitution (Equipment↔Equipment temporal link), GovernanceFinding (polymorphic), CostLedger (per-asset money timeline), SupportTicket.
- **Provenance backbone:** Evidence (WORM stages), AuditEvent (universal), ApprovalStep (ordered line).

### Universal Object-View spec (the contract)
One `ObjectViewConfig<T>` per type: `{ load, identity(mono/title), status, priority, properties[], links[], timeline?, actions(role-gated), provenance }`. Rendered by ONE `<ObjectViewScaffold>`. Kit: `ObjectHeader · PropertiesPanel · LinkedObjectsPanel · ObjectLink · TimelinePanel · AuditTrailPanel · ActionBar`. Built entirely on existing shared UI (Dialog/Card/Badge/Button/Combobox/PageHeader) — zero new deps. The `EquipmentDetailDialog` edit form splits: read-half → PropertiesPanel, edit-half → an `editEquipment` ActionBar action; popup survives as a *peek* with a "전체 보기" → `/equipment/:id`.

### Command palette (⌘K)
Built on `AsyncCombobox` + `Dialog`, mounted once in `AppShell`. Two sections: **Objects** (server typeahead by 호기/request_no/name/phone, each tagged `type` → `objectRoute`) + **Actions** (static, role-filtered via `hasAnyRole`, reusing `NAV_GROUPS` + verbs). Recents from the back-stack. Keyboard-first, no 403 actions ever offered.

### Triage home
`/home` → `TriageHomePage` picks queue set by `hasAnyRole`. `QueueCard` (count badge + rows + 전체보기) / `QueueRow` (`ObjectLink` + status/priority badge + one inline gated action). v1 = existing list endpoints with filters; #24 swaps pre-aggregated counts behind the same contract. Multi-role users see the de-duplicated union.

### Inter-object nav
`objectRoute(type,id)` route table extends the lone `/work-orders/:id`. `ObjectNavProvider` keeps an in-memory back-stack; breadcrumb bar between Topbar and `<main>`; `◀ 뒤로` pops, falls back to the natural list route. UX state, no URL pollution.

---

## (3) PHASED EXECUTION PLAN — folds in existing tasks

| Phase | What ships | User-visible win | Folds in | Effort |
|---|---|---|---|---|
| **P0 — Blueprint token foundation** | `styles.css` `@theme` tokens + `.console` scope (dark-ready vars); `lib/semantic.ts` `tone` map + `<Mono>/<Won>`; re-pin the 4 color helpers (`priorityClass`, `statusBadgeClass`/`priorityBadgeClass`, `SlaBadge`, `EquipmentBrowse statusClassName`) — pure swap | P1/URGENT/breached finally render the *same red*; ₩/호기 align & stop jittering | **extends C1–C13**; reframes #14 polish as a token system | S |
| **P1 — Object-View kit** (the keystone) | Extract kit from `WorkOrderDetail` with no behavior change; re-point `WorkOrderDetailPage` at `ObjectViewScaffold`; add status-history `TimelinePanel`, approval-line widget, evidence gallery as LinkedObjectsPanels | WO detail gains timeline + approval line + evidence gallery | **closes #23 blockers** (WO-detail + approval-queue); reframes #14 | M |
| **P2 — Equipment Object View** | `/equipment/:id` via scaffold config; "전체 보기" from popup; links rail (WOs/Substitutions/CostLedger/Inspections/Quotes/PurchaseRequests/SalesListing); actions 상태변경/대차배정/점검예약/원가추가; source+freshness provenance | The highest-value 360° view; imported equipment finally viewable | **closes #8** (imported equipment not viewable) | M |
| **P3 — Nav fabric: ⌘K + back-stack + DataTable** | `ObjectLink` + `ObjectNavProvider` + breadcrumb bar; `CommandPalette` on AsyncCombobox; `DataTable` (sticky/zebra/roving-keyboard, density prop) converging the ~5 hand-rolled tables; 36px control density | Jump to any object in 2 keystrokes; click-through everywhere; tables feel operational | reframes #14 polish; keyboard-first req | M |
| **P4 — Triage Home** | `/home` + role queue cards; default post-login route for operator roles; sidebar `triage` nav item above `operations` | "What needs me now" replaces landing on a table | **delivers the role-workflow backlog** (`role-workflow-backlog.md`) as a surface | M |
| **P5 — Lens: Faceted (#24)** | `FacetExplorer` + Histogram/Listogram/StatisticsTable + `ObjectResultTable` + `<LensActionBar>`; the 4 KPI tiles (PM-overdue, cost-per-asset, MTBF, repair-vs-replace) as drag-to-act facets; `GET /analytics/explore` returns per-bucket id-lists | KpiPage/Ops stop being dashboards — every tile drills to objects you can act on | **delivers #24** (`analytics-intelligence-roadmap.md`) | L |
| **P6 — Lens: Timeline** | `TimelineRibbon`; **2a** Equipment lifecycle ribbon (cost residual step-line under WO points → gross_margin at SOLD) embedded in Equipment view; **2b** per-mechanic day in User view; `GET /equipment/{id}/lifecycle` rollup | The repair-vs-replace story as one picture; tech utilization | uses existing `financial::tco` + substitution data, no new metric store | M |
| **P7 — Customer + Mechanic Object Views** | `/customers/:id` (Customer→Site→Equipment drill), `/users/:id` (dispatcher's "is this mechanic free + load") — reuse kit + ObjectLink + timeline 2b | Registry hierarchy traversable; people anchor | **closes the `OrgPage`/`UsersPage` page-per-table gap** | M |
| **P8 — Lens: Graph + corp-grouping (#37)** | `RelationshipCanvas` + `useSearchAround`; pre-#37 groups by `customer_id` with dashed candidate edges; when `corporate_groups` + `registry_customers.group_id` land → `LegalEntity` node + `linkCustomersToGroup` action | See fragmented 법인 visually; group addresses under one legal entity as a graph write-back | **delivers #19.12 / #37** | L |
| **P9 — Lens: Map host + remaining objects** | Generic Layers-panel abstraction + Selection→`<LensActionBar>` binding over the existing #29 map; draw-polygon → `createDispatch`; remaining object views (PurchaseRequest, Inquiry, SalesListing, SupportTicket, Substitution, CostLedger surface) | Assign from the map; every object type has a home | **adds only the lens-binding to #29** (don't rebuild the map) | M |
| **P10 — Dark/density toggles** | UserMenu toggles writing `.console.dark`/`data-density`; `?` shortcut cheat-sheet; go-to chords (`g d`/`g o`) | Dark mode, density choice, power-user nav | finishes the Blueprint skin | S |

**Sequencing logic:** P0→P1 is the load-bearing keystone (token system + the kit that everything reuses). P2/P3/P4 are the visible "this is a different product" moment. Lenses (P5–P9) each ship independently — Faceted first (pure-read, highest ROI, turns dashboards into worklists). Map is last because #29 already did the hard part.

---

## (4) TOP 10 HIGHEST-LEVERAGE MOVES TO START

1. **Extract the Object-View kit from `WorkOrderDetail`** (P1). The single keystone — every other object view, lens panel, and triage row reuses it. Refactor-first, no behavior change, proves the abstraction against the one working view.
2. **Ship the `tone` semantic-color map + re-pin the 4 helpers** (P0). One day of work; instantly fixes the embarrassing inconsistency where P1, URGENT, and SLA-breached render three *different* reds. Snapshot-safe pure swap.
3. **Build the Equipment Object View at `/equipment/:id`** (P2). Richest inbound links, and it closes the "imported equipment not viewable" bug (#8). Convert the dialog: read→PropertiesPanel, edit→ActionBar action, popup→peek with 전체보기.
4. **⌘K command palette** (P3). Built on `AsyncCombobox`+`Dialog`, zero new deps. The cross-cutting jump-to-object + run-action that makes the whole ontology feel navigable. Disproportionate perceived-quality lift.
5. **`ObjectLink` + back-stack breadcrumb** (P3). Turns the static ontology into a *traversable graph* — the core Palantir interaction. Generalizes the WO page's hard-coded `Link to="/dispatch"`.
6. **Triage Home `/home`** (P4). Replaces land-on-a-table with decision-first "what needs me now." Delivers the role-workflow backlog as a real surface; v1 needs only existing list endpoints + filters.
7. **`DataTable` (sticky/zebra/roving-keyboard, density prop)** (P3). Converges ~5 hand-rolled tables into one operational-grade primitive; 36px controls. The biggest "feels like CRUD" → "feels like an instrument" change.
8. **Faceted lens over KpiPage (#24)** (P5). Highest analytical ROI — every KPI tile drills to an actionable object set + `<LensActionBar>`. Pure-read on existing rollups; just needs per-bucket id-lists.
9. **Equipment lifecycle timeline ribbon** (P6). The repair-vs-replace story as ONE picture: cost residual step-line eroding under WO points until the SOLD marker prints gross_margin. The headline panel of the Equipment view; uses existing `financial::tco` data.
10. **Wire the existing #29 map's Selection → `<LensActionBar>`** (P9). Don't rebuild the map — make it a lens. Draw-polygon → assign-mechanic is the proof that a lens is "not a dead dashboard."

**Non-negotiables threaded through all 10:** every Action is named, validated, role-gated, audited, console-only (never raw SQL); every tenant read is RLS-armed and tested as `mnt_rt` (not BYPASSRLS superuser); `safeLabel` guarantees a UUID never leaks as link text; the storefront stays untouched (`.console`-scoped skin only).

Files anchoring the start: kit → `web/src/features/object-view/*` (new) refactored from `web/src/features/dispatch/WorkOrderDetail.tsx`; tokens → `web/src/styles.css` + new `web/src/lib/semantic.ts` + `web/src/lib/format.tsx`; palette → `web/src/features/command-palette/CommandPalette.tsx` (new) mounted in `web/src/components/shell/AppShell.tsx`; triage → `web/src/pages/TriageHomePage.tsx` (new) + `web/src/components/shell/nav.ts`; routes → `web/src/AppRouter.tsx`.