# Equipment / asset module (FL-) data/config contract

Generated: 2026-07-09T23:30:02Z  
Kanban: `t_bc0b1394`  
GitHub issue: `jason931225/maintenance#335` — `[carbon-copy/P3-mod] asset module screen (FL-)`

## Executive finding

The asset/equipment module should be implemented as the P3 `asset` binding of the generic console module substrate, not as another bespoke equipment page. The product contract is: list real branch-scoped equipment rows, select an equipment object, show source-backed lifecycle/timeline + graph + cost ledger/asset-cost affordances, and expose only audited/policy-gated writes.

The current repo already has most backend read surfaces for equipment master rows, timeline graph, cost ledger, lifecycle cost, substitutions, ownership transfer, and equipment profile update actions. It does **not** expose an equipment-specific version-history / non-destructive rollback API in the typed client, and the current generic module renderer is still static/config-only (`config.rows`) rather than a live OpenAPI-backed loader. Therefore the implementation should land in two steps:

1. Extend the generic module substrate just enough to load real rows and render an `tl`/timeline field generically.
2. Add `assetModuleScreen` as a thin config + adapter over the real equipment endpoints. Do not invent `FL-` codes, version rows, rollback actions, or cost numbers that the backend does not return.

## Source verdict

- Issue #335 scope: “Equipment + versions/rollback/timeline-graph/cost-ledger rendered through the P0 generic module template,” with compact statbar, multi-attribute search, shared-track list, detail kv/link chips/actions, `web/src/console/**` only, no Tailwind/shadcn/legacy imports, strings in `web/src/i18n/ko.ts`, no explanatory UI, `PolicyGated`, and fidelity/verification gates. Source fetched via `gh issue view 335 --repo jason931225/maintenance`.
- Design authority precedence: fresh markdowns and `AGENTS.md` are authoritative, with `web/src/**` as implementation truth; `Oyatie Console.dc.html` is a large Jul-4 artifact plus change-log deltas, and post-Jul-4 screens can use `AGENTS.md` + grammar catalog as spec when the prototype side is unavailable (`docs/design/oyatie-console/SYNC-MANIFEST.md:26-30`, `.omc/plans/carbon-copy-charter.md:67-68`).
- Local prototype availability gap: `docs/design/oyatie-console/Oyatie Console.dc.html` was not present in this checkout during this task (`search_files docs/design/oyatie-console '*Oyatie*Console*'` returned 0). Before final fidelity acceptance, either restore/export the bit-exact HTML or use the ratified post-snapshot substitute gate from the charter.
- P3 product identity is explicit: the ten module surfaces include `asset`, with module rows as typed graph nodes and generic module fields including `tl` for asset lifecycle timeline (`docs/design/oyatie-console/AGENTS.md:13-15`, `docs/design/oyatie-console/AGENTS.md:53-55`, `.omc/research/oyatie/prototype-anatomy/05-post-snapshot-todo-digest.md:70-72`).
- Program constraints are load-bearing: reusable grammar first, no fabricated data, PBAC deny-by-omission, audited sensitive views, and no dead rows/numbers (`.omc/plans/carbon-copy-charter.md:15-19`, `.omc/plans/carbon-copy-charter.md:59-63`).

## Current frontend substrate to compose

Use the current `web/src/console/modules/**` substrate, not legacy `web/src/pages/Equipment*` JSX and not the older extracted `origin/main:web/src/console/module/*` path, unless the branch has been rebased and the substrate path changes.

Current module substrate facts:

- `ConsoleModuleRoute` selects a config by `?screen=` and renders `GenericModuleScreen`; feature grants pass exact action strings, while module read falls back to role-based `sessionCanReadModule` (`web/src/console/modules/ConsoleModuleRoute.tsx:21-41`).
- `ModuleScreenConfig` is already a MOD_SCREENS-style config: id/screen/route/nav/objectKind/codePrefix, policy, data endpoints, statbar, search, list columns, detail fields/link chips/actions, primary action, and rows (`web/src/console/modules/types.ts:111-138`).
- The current renderer is generic but static: it derives `rows = config.rows`, selected row state, stat chips, search box, shared table, kv detail, link chips, and policy-gated buttons from config (`web/src/console/modules/GenericModuleScreen.tsx:320-459`).
- `moduleScreens.ts` has a finance example and `MOD_SCREENS` registry; asset should be added beside finance with the same config shape (`web/src/console/modules/moduleScreens.ts:13-162`).
- Console purity is enforced: console imports are restricted to React/react-router, `src/api`, `src/auth`, `src/console`, `src/context`, and `src/i18n`; Tailwind/shadcn/features/pages/lucide imports are forbidden, and non-`console` className usage is forbidden (`web/scripts/check-console-purity.mjs:9-28`, `web/scripts/check-console-purity.mjs:78-112`).
- `PolicyGated` is deny-by-omission; unauthorized controls are absent, not disabled with prose (`web/src/console/policy/PolicyGated.tsx:29-46`).

Implementation consequence: do not copy from `web/src/pages/EquipmentBrowsePage.tsx`, `EquipmentDetailPage.tsx`, or `web/src/features/financial/AssetLifecycleCostPanel.tsx` into console. Those files are useful as endpoint/UX references only. The console module must remain a config + generic renderer extension.

## Backend / typed-client contract

### 1. Equipment list and master row

Use the generated OpenAPI client surfaces, not hand-written fetch types.

- List endpoint: `GET /api/v1/equipment/list`; branch-scoped, filterable, `q` normalized across management_no, equipment_no, model, maker, customer, site, and VIN (`clients/ts/src/schema.d.ts:693-704`).
- Create endpoint exists at `POST /api/v1/equipment`, but it is admin-gated `EquipmentManage`; do not expose create/import as an always-on module CTA (`clients/ts/src/schema.d.ts:713-727`).
- Row/detail endpoint: `GET /api/v1/equipment/{id}` returns `EquipmentListItem`; `PATCH` updates partial fields with `UpdateEquipmentRequest`; `DELETE` soft-deletes/disposes (`clients/ts/src/schema.d.ts:1170-1195`, `clients/ts/src/schema.d.ts:10093-10190`).
- `EquipmentListItem` required fields: `equipment_id`, `branch_id`, `equipment_no`, `status`, `specification`, `ton_text`, `customer_name`, `site_name`, `updated_at`; optional fields include `management_no`, `model`, `maker`, `asset_owner`, `vin` (`clients/ts/src/schema.d.ts:5154-5172`).
- Equipment statuses are `rented`, `spare`, `disposed`, `replacement`, `sold` (`backend/openapi/openapi.yaml:13541-13548`).
- `UpdateEquipmentRequest` can change customer/site/status/spec/ton/management_no/power/manager/placement/maker/model/VIN/year/hours/registration/insurance/owner/acquisition/rental/cost/residual and related fields; absent keys are unchanged, nullable keys clear columns (`backend/openapi/openapi.yaml:14319-14428`).

### 2. Timeline graph / lifecycle ribbon

- Timeline endpoint: `GET /api/v1/equipment/{id}/timeline-graph`, described as read-only equipment lens for lifecycle events and customer-site-equipment-work-order graph; missing/foreign ids return 404 (`clients/ts/src/schema.d.ts:1198-1209`).
- Operation returns `EquipmentTimelineGraph` (`clients/ts/src/schema.d.ts:10191-10222`).
- `EquipmentTimelineGraph` shape: `equipment`, `lifecycle_events`, `graph`, `work_order_count`, `cost_ledger_total_won` (`clients/ts/src/schema.d.ts:5182-5190`).
- Event shape: `id`, `kind`, `label`, optional `description`, `event_date`, `occurred_at`, `href`; graph shape: `nodes[]` and `edges[]`; node shape includes `id`, `node_type`, `label`, optional `subtitle`/`href`, and `current` (`clients/ts/src/schema.d.ts:5204-5230`).

Implementation consequence: the asset module's `tl` field should render this endpoint's `lifecycle_events` only. If a lifecycle event has an `href`, it may drill; otherwise show the event as data, not a fake link. Relationship graph chips/links come from `graph.nodes/edges`, not hardcoded customer/site/work-order labels.

### 3. Cost ledger / asset lifecycle cost

- Cost ledger list: `GET /api/v1/financial/equipment/{equipmentId}/cost-ledger` -> `CostLedgerEntrySummary[]` (`clients/ts/src/schema.d.ts:2618-2634`, `clients/ts/src/schema.d.ts:11631-11655`).
- Lifecycle cost summary: `GET /api/v1/financial/equipment/{equipmentId}/lifecycle-cost`, read-gated by `EquipmentCostLedgerRead`, returns acquisition source, maintenance/purchase/manual totals, residual, sale/gross margin, TCO, cost-per-month/hour, and timeline (`clients/ts/src/schema.d.ts:2635-2646`, `clients/ts/src/schema.d.ts:11656-11679`).
- Manual ledger append exists: `POST /api/v1/financial/equipment/{equipmentId}/cost-ledger/manual`, operation `appendManualCostLedgerEntry`, returns `CostLedgerEntrySummary` and should require write entitlement; do not expose it unless the current session holds the write feature (`clients/ts/src/schema.d.ts:2655-2666`, `clients/ts/src/schema.d.ts:11681-11709`).
- `CostLedgerEntrySummary` includes ids, optional `work_order_id`/`purchase_request_id`, source, amount, memo, residual before/after, and `entry_at`; `AssetLifecycleCostSummary` includes TCO and timeline (`clients/ts/src/schema.d.ts:6980-7038`).

Implementation consequence: list statbar may show cost totals only after lifecycle-cost/cost-ledger read succeeds for selected row or after the list endpoint provides precomputed aggregates. Do not sum hidden rows client-side as “전체” if PBAC/scoping could hide ledger entries.

### 4. Governed object actions

- Catalog endpoint: `GET /api/v1/object-actions/catalog?object_type=equipment&object_id=...`, initial slice supports equipment actions and requires `EquipmentManage` (`clients/ts/src/schema.d.ts:1218-1229`, `clients/ts/src/schema.d.ts:10223-10256`).
- Execute endpoint: `POST /api/v1/object-actions/execute`; sensitive writes require fresh passkey step-up and return audit provenance (`clients/ts/src/schema.d.ts:1238-1251`, `clients/ts/src/schema.d.ts:10257-10299`).
- Descriptor shape is UI-renderable: `action_id`, `object_type`, `object_id`, labels, passkey requirement, risk level, and typed fields/options (`clients/ts/src/schema.d.ts:5380-5410`).
- Current execute request is hard-typed to `action_id: "equipment.update_profile"`, `object_type: "equipment"`, `input: UpdateEquipmentRequest`, optional `idempotency_key`, optional `step_up`; response carries `audit_event_id` and `target_href` (`clients/ts/src/schema.d.ts:5411-5431`).

Implementation consequence: primary/detail actions should come from the server action catalog where possible. The hardcoded config action can be only “open action catalog/update profile”; the form itself should be descriptor-driven, passkey-aware, and audit-verified.

### 5. Related equipment lifecycle writes

- Substitute assignment and return are audited equipment-lifecycle writes requiring `EquipmentManage` (`clients/ts/src/schema.d.ts:2483-2517`).
- Ownership transfer request ledger and workflow exist for one equipment asset; transfer only changes legal owner after sending-org, receiving-org, legal, and accounting signoff; create does not immediately mutate `asset_owner` (`clients/ts/src/schema.d.ts:2523-2547`, `clients/ts/src/schema.d.ts:2558-2560`).

Implementation consequence: these belong as policy-gated link chips or actions only if the asset module can route to the existing workflow/surface. Do not inline a bespoke ownership transfer wizard into the generic asset list/detail unless the generic action/flow substrate supports it.

## Required `assetModuleScreen` contract

Add an `assetModuleScreen` (or whatever name matches the final registry convention) with these semantics.

### Identity

- `id`: `"asset"`
- `screen`: `"asset"`
- `route`: `"/console?screen=asset"` or the current `/console` route with `screen=asset` query/state.
- `navLabelKey`: `console.modules.asset.nav`
- `titleKey`: `console.modules.asset.title`
- `objectNameKey`: `console.modules.asset.objectName`
- `objectKind`: `"equipment"`
- `codePrefix`: `"FL-"` only as a display/validation expectation from the prototype; actual primary code must be `row.equipment_no` from backend. If backend returns a non-`FL-` equipment number, show the backend code and record an implementation note rather than synthesizing `FL-`.
- `emptyMode`: `"live"` after the generic loader exists. Use `"blocked-until-backend"` only if implementing before a live loader/adapter lands; do not ship an empty fake module.

### Policy strings

Use feature-grant strings already used in this repo where possible:

- `read`: `"work_order_read_all"` for equipment list/detail read, matching the endpoint description and `FEATURES.WORK_ORDER_READ_ALL` (`web/src/components/shell/nav.ts:60-89`, `clients/ts/src/schema.d.ts:700-704`).
- `manage`: `"equipment_manage"` for create/update/delete/import/substitution/ownership-transfer actions, matching `FEATURES.EQUIPMENT_MANAGE` (`web/src/components/shell/nav.ts:60-89`).
- `costRead`: `"equipment_cost_ledger_read"` for cost ledger and lifecycle cost; this literal is already used by current finance config link chips (`web/src/console/modules/moduleScreens.ts:121-132`) and labeled in Korean feature labels (`web/src/i18n/ko.ts:2284-2287`).
- `costWrite`: `"equipment_cost_ledger_write"` for manual ledger append; do not expose unless the session has it.
- `graph`: `"object.view"` if using object graph/link chips, matching existing finance module convention (`web/src/console/modules/moduleScreens.ts:3-11`).
- `audit`: `"audit_log_read"` for audit trail link chips.

Current `ConsoleModuleRoute` only has a generic module-read role fallback and otherwise checks `session.feature_grants.includes(action)` (`web/src/console/modules/ConsoleModuleRoute.tsx:27-35`). If asset actions need role fallback for `equipment_manage`, add that generically or pass through backend feature grants; do not special-case only asset inside the renderer.

### Data endpoints

Minimum config data entries:

- `list`: `/api/v1/equipment/list`
- `detail`: `/api/v1/equipment/{id}`
- `update`: `/api/v1/equipment/{id}`
- `delete`: `/api/v1/equipment/{id}`
- `timeline`: `/api/v1/equipment/{id}/timeline-graph`
- `costLedger`: `/api/v1/financial/equipment/{equipmentId}/cost-ledger`
- `lifecycleCost`: `/api/v1/financial/equipment/{equipmentId}/lifecycle-cost`
- `manualCost`: `/api/v1/financial/equipment/{equipmentId}/cost-ledger/manual`
- `actionCatalog`: `/api/v1/object-actions/catalog?object_type=equipment&object_id={id}`
- `actionExecute`: `/api/v1/object-actions/execute`
- `substitutions`: `/api/v1/equipment-substitutions` and `/api/v1/equipment-substitutions/{id}/return`
- `ownershipTransfers`: `/api/v1/equipment/{id}/ownership-transfer-requests`
- `ownershipTransferDecision`: `/api/v1/equipment/ownership-transfer-requests/{id}/decisions`

### Statbar

Only source-backed counts/totals:

- `total`: visible equipment list total from `EquipmentListPage.total`, not `rows.length` when paginated.
- `rented`: count/status aggregate only if returned by backend or computed over the visible filtered page with label “visible” semantics. If implementing over current list page only, avoid presenting it as global total.
- `spare`: same constraint.
- `attention`: count statuses `disposed/replacement/sold` or timeline/cost exceptions only if source-backed.
- `costLedgerTotal`: selected equipment's `EquipmentTimelineGraph.cost_ledger_total_won` or lifecycle cost summary, policy-gated by cost read.
- `workOrders`: selected equipment's `EquipmentTimelineGraph.work_order_count`.

Do not show big KPI cards. The prototype contract requires compact 1-row statbar and every number drills to a source object (`.omc/plans/carbon-copy-charter.md:59-63`, `.omc/research/oyatie/prototype-anatomy/05-post-snapshot-todo-digest.md:5-11`).

### Search

Use the list endpoint `q` semantics server-side. Client search fields may mirror backend fields only as a convenience over loaded rows:

- `equipment_no`, `management_no`, `model`, `maker`, `customer_name`, `site_name`, `vin`, `asset_owner`, `status`, `specification`, `ton_text`.

### List columns

Recommended columns, all from `EquipmentListItem`:

1. `code` — `equipment_no`, mono, row detail button.
2. `managementNo` — `management_no`, mono when present.
3. `status` — status chip using `EquipmentStatus`.
4. `model` — `model` or `—`.
5. `maker` — `maker` or `—`.
6. `customerSite` — compact `customer_name / site_name`.
7. `owner` — `asset_owner` if present.
8. `updatedAt` — `updated_at`.
9. Optional `links` — link chips only if populated from real timeline graph/object graph/ledger data.

### Detail kv fields

Minimum kv fields from master row:

- `code` (`equipment_no`)
- `managementNo`
- `status`
- `model`
- `maker`
- `specification`
- `tonText`
- `customerName`
- `siteName`
- `assetOwner`
- `vin`
- `updatedAt`

Extended kv fields may come from `GET /api/v1/equipment/{id}` if backend returns them through the same `EquipmentListItem`, or from a future richer detail schema. Do not assume fields from `UpdateEquipmentRequest` are returned unless the generated response type proves it.

### Timeline / `tl` field

The prototype's generic `tl` field is “asset lifecycle timeline: acquire → maintenance events → return/replace dashed; WO-/AN-/SR- rows drill” (`.omc/research/oyatie/prototype-anatomy/05-post-snapshot-todo-digest.md:70-72`). Implement this generically, then feed it with `EquipmentTimelineGraph.lifecycle_events`:

- Each event row maps `label`, optional `description`, `event_date`/`occurred_at`, `kind`, and optional `href`.
- Link chips/drills are allowed only when event `href` or graph node `href` is returned.
- Dashed/future styling is allowed only if backend event `kind`/metadata distinguishes planned/replacement/return events. Otherwise use ordinary event dots/chips.
- Do not fabricate `AN-` or `SR-` rows. The current typed graph only exposes string `kind/label/href`, not typed analytical/series nodes.

### Link chips

Detail link chips should be generated from real sources:

- `timeline` — timeline graph endpoint.
- `objectGraph` — relationship graph nodes/edges from timeline graph or future object graph endpoint.
- `costLedger` — cost-ledger endpoint, cost-read gated.
- `lifecycleCost` — lifecycle cost endpoint, cost-read gated.
- `workOrders` — only if graph nodes/events provide work-order ids/hrefs.
- `customer` / `site` — only if graph nodes provide hrefs or object resolver supports them.
- `ownershipTransfer` — ownership transfer ledger route if implemented.
- `substitution` — substitute assignment/return surface if implemented.
- `auditTrail` — only if audit route can query this equipment object.

### Actions

Actions should be driven by backend capability, not UI desire:

- `updateProfile` — from object action catalog (`equipment.update_profile`), `equipment_manage`, passkey-aware, audited.
- `requestOwnershipTransfer` — only if route/form for `createEquipmentOwnershipTransfer` exists; `equipment_manage`.
- `assignSubstitute` / `returnSubstitute` — only if the current row/context supports the substitution endpoint and candidate flow; `equipment_manage`.
- `appendManualCost` — only with `equipment_cost_ledger_write` and real form for `AppendManualCostLedgerRequest`.
- `delete/dispose` — soft-delete only, `equipment_manage`, must preserve references.
- `rollbackVersion` — unavailable now; do not render. See unavailable-data notes.

Primary action:

- `createEquipment` may be primary only for `equipment_manage`; otherwise omit.
- `importMasterList` is not the asset module's default primary action; it belongs to equipment management/import tools and requires `master_list_import`/admin handling.
- If the prototype expects asset “취득 기안” as the asset primary action, wire it only when a real purchase/acquisition request endpoint and workflow link exists. Otherwise block it with an explicit backend-gap note in the implementation PR, not a dead button.

## Required Korean i18n keys

Current Korean copy already has legacy equipment strings (`web/src/i18n/ko.ts:3448-3675`) and financial asset-cost tab strings (`web/src/i18n/ko.ts:4303-4346`), but the current module substrate resolves `console.modules.*` keys and no `console.modules.asset` block was found. Add only keys that render.

Recommended keys:

- `console.modules.common.navAria`, `statsAria`, `listAria`, `detailAria`, `rowDetail` if missing for the current generic renderer.
- `console.modules.asset.nav`: `자산`
- `console.modules.asset.title`: `자산`
- `console.modules.asset.objectName`: `장비`
- `console.modules.asset.emptyBlockedChip`: only if temporarily blocked.
- `console.modules.asset.stats.total`: `전체`
- `console.modules.asset.stats.rented`: `임대`
- `console.modules.asset.stats.spare`: `예비`
- `console.modules.asset.stats.workOrders`: `작업`
- `console.modules.asset.stats.costLedger`: `원가`
- `console.modules.asset.search.label`: `장비 검색`
- `console.modules.asset.search.placeholder`: `호기·모델·고객·현장·VIN 검색`
- `console.modules.asset.columns.code`: `호기 번호`
- `console.modules.asset.columns.managementNo`: `관리 번호`
- `console.modules.asset.columns.status`: `상태`
- `console.modules.asset.columns.model`: `모델`
- `console.modules.asset.columns.maker`: `제조사`
- `console.modules.asset.columns.customerSite`: `고객 / 현장`
- `console.modules.asset.columns.owner`: `법적 소유자`
- `console.modules.asset.columns.updatedAt`: `수정일`
- `console.modules.asset.detail.lifecycle`: `생애주기`
- `console.modules.asset.detail.timeline`: `생애주기 리본`
- `console.modules.asset.detail.graph`: `관계 그래프`
- `console.modules.asset.detail.cost`: `수명주기 원가`
- `console.modules.asset.links.timeline`: `생애주기`
- `console.modules.asset.links.graph`: `그래프`
- `console.modules.asset.links.costLedger`: `원가 원장`
- `console.modules.asset.links.lifecycleCost`: `자산 비용`
- `console.modules.asset.links.ownershipTransfer`: `소유권 이전`
- `console.modules.asset.links.substitution`: `대차`
- `console.modules.asset.actions.updateProfile`: `정보 수정`
- `console.modules.asset.actions.requestOwnershipTransfer`: `소유권 이전 결재 요청`
- `console.modules.asset.actions.assignSubstitute`: `대차 배정`
- `console.modules.asset.actions.appendManualCost`: `수기 원가 기록`
- `console.modules.asset.actions.createEquipment`: `장비 등록`
- `console.modules.asset.status.rented/spare/disposed/replacement/sold`: reuse current `ko.equipment.manage.statuses` labels if the i18n structure permits, otherwise duplicate under module keys.

Do not add explanatory copy, captions, protocol text, or meta notices. §4-12/charter bans explanatory UI; status belongs in chips (`.omc/plans/carbon-copy-charter.md:59-63`, `.omc/research/oyatie/prototype-anatomy/05-post-snapshot-todo-digest.md:5-11`).

## Unavailable / blocked data notes

1. **Bit-exact prototype HTML unavailable locally.** `Oyatie Console.dc.html` was not found in this checkout. Final fidelity acceptance needs either a restored/exported file or the ratified post-snapshot substitute gate (`SYNC-MANIFEST.md:16-18`, `.omc/plans/carbon-copy-charter.md:67-68`).
2. **Equipment version-history / rollback endpoint unavailable in typed client.** Searches for equipment version/rollback-specific paths and schemas found no `/api/v1/equipment/{id}/versions`, `EquipmentVersion`, or equipment rollback operation. The current timeline endpoint is read-only. Do not render rollback buttons until a real API exists.
3. **Generic module live loader unavailable in current renderer.** `GenericModuleScreen` consumes static `config.rows`; `ModuleDataEndpointConfig` records endpoints but no loader/adapter invokes them (`web/src/console/modules/types.ts:17-26`, `web/src/console/modules/GenericModuleScreen.tsx:320-331`). Implement a generic loader or adapter before adding live asset rows.
4. **Generic `tl` renderer unavailable in current type union.** Current `ModuleColumnVariant` only supports text/mono/status/source/linkChips (`web/src/console/modules/types.ts:45-52`). Asset needs a generic timeline/detail field, not an asset-only component.
5. **`FL-` source is design intent, not proven backend code issuance.** Backend exposes `equipment_no`; design says asset rows are `FL-` but the typed schema does not require an `FL-` prefix. Display backend `equipment_no`; file a backend/code-issuance gap if it is not the prototype code.
6. **Cost totals are not list-wide unless backend returns list aggregates.** Lifecycle cost is per equipment id. Do not compute global TCO from a paginated visible page and label it as global.
7. **Object graph/object resolver for equipment is partial through timeline graph.** Timeline graph gives nodes/edges/hrefs. Use them; do not assume `/api/objects/equipment/{id}/graph` supports all required asset links unless verified in the implementation branch.
8. **Current `/console` route is guarded through the finance nav item.** `AppRouter` mounts `/console` under `RequireNavItemRoute itemKey="finance"` in this checkout, so asset may need route/nav/palette registration before it is reachable as an asset module (`web/src/AppRouter.tsx:124-127`, `web/src/AppRouter.tsx:384-386`).

## Implementation checklist

### Substrate work

- [ ] Add/confirm `console.modules.common.*` i18n keys used by `GenericModuleScreen`.
- [ ] Add a generic OpenAPI-backed loader path to the module substrate:
  - [ ] accepts `config.data.list` and query/search params;
  - [ ] maps response items through a config adapter into `ModuleRow[]`;
  - [ ] keeps loading/error/empty states generic and caption-free;
  - [ ] does not fetch hidden policy-gated detail data.
- [ ] Add selected-row detail fetch hook/adaptor:
  - [ ] `GET /api/v1/equipment/{id}` for row detail;
  - [ ] `GET /api/v1/equipment/{id}/timeline-graph` for timeline/graph;
  - [ ] cost endpoints only when `equipment_cost_ledger_read` is allowed.
- [ ] Extend generic field/render contract for `tl`/timeline. It should accept a list of event descriptors and render the same shape for any module that later uses `tl`.
- [ ] Keep all renderer changes under `web/src/console/**`, with tokenized inline styles / `className="console"` only.
- [ ] Add tests to prove asset uses the generic renderer/config and does not duplicate finance/equipment page shapes.

### Asset config work

- [ ] Add `ASSET_MODULE_ACTIONS` or equivalent constants using snake_case feature strings (`work_order_read_all`, `equipment_manage`, `equipment_cost_ledger_read`, `equipment_cost_ledger_write`, `object.view`, `audit_log_read`).
- [ ] Add `assetModuleScreen` to `MOD_SCREENS` and update `ModuleScreenId` coverage.
- [ ] Register `/console?screen=asset` reachability in nav/palette/window state without replacing the existing legacy `/equipment` route prematurely.
- [ ] Map `EquipmentListItem` into rows with source-backed columns and status chips.
- [ ] Map `EquipmentTimelineGraph` into generic `tl` timeline plus graph/link chips.
- [ ] Map `AssetLifecycleCostSummary` and `CostLedgerEntrySummary[]` into cost link chips/detail rows only under cost-read gate.
- [ ] Load object-action catalog for selected row and render descriptor-driven `equipment.update_profile` affordance only when returned by server and allowed by policy.
- [ ] Add ownership transfer/substitution link/action entries only if routing/forms exist.
- [ ] Do not add rollback action until backend exposes version/rollback API.

### i18n work

- [ ] Add `console.modules.asset.*` keys listed above.
- [ ] Add/verify common renderer i18n keys.
- [ ] Reuse existing Korean vocabulary for equipment status/detail where structurally possible (`web/src/i18n/ko.ts:3448-3675`).
- [ ] Run `check-ui-strings`; remove captions/meta prose if flagged.

### Verification gates

Run at minimum:

- [ ] `npm run check-console-purity` or the actual script command for `web/scripts/check-console-purity.mjs`.
- [ ] `npm run check-ui-strings` or repo-equivalent.
- [ ] `npm run tsc -b` or repo-equivalent TypeScript build.
- [ ] `npm run lint -- --max-warnings 0` or repo-equivalent.
- [ ] `npm run test -- ...` / `vitest run` for module substrate + asset config tests.
- [ ] Persona/policy tests proving unauthorized asset actions are absent.
- [ ] Backend-backed browser test proving list row -> detail -> timeline/cost/action catalog all hit real endpoints and no fabricated code appears.
- [ ] Fidelity gate vs restored prototype HTML or ratified post-snapshot substitute checklist.

## Review lenses for downstream implementation

- Fidelity / grammar: §4-12 no explanatory UI, §4-18 no duplicate shapes, compact statbar/shared-track/detail grammar.
- Data correctness: every row/code/cost/timeline/link from OpenAPI result or graph node; no fake `FL-`, fake rollback, fake TCO.
- Authorization: read vs manage vs cost-read/cost-write separated; denied actions absent; backend still authoritative.
- Audit/security: object actions and sensitive cost/ownership writes produce audit provenance and passkey step-up when required.
- Scope/RLS: branch-scoped list/detail/timeline/cost behavior verified for non-SUPER_ADMIN; foreign/missing ids remain indistinguishable 404s.
- Console isolation: no imports from `web/src/pages/**`, `web/src/features/**`, Tailwind/shadcn/lucide, or legacy className styling.
