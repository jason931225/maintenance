# Inventory module (IV-) data/config mapping

Kanban: `t_a98e0cf4` · GitHub issue: `jason931225/maintenance#334` · Backend dependency: `#318` / `t_224d8594`

## Executive finding

Inventory cannot be truthfully wired as a live module in the current frontend without backend-gap/B21b. The real generic module substrate exists on `origin/main` (PR #279 lineage) but not in this stale dirty `feat/cedar-activation` worktree. `origin/main` declares the `stock` generic field for inventory, yet only `lanes` and `prog` render today; `stock` intentionally throws dev-loud until the inventory slice implements the generic renderer.

The only inventory backend code found is an ERP-domain accounting guardrail (`consume_inventory_to_work_order`) with no REST/read model, no `IV-` object kind, no list/detail endpoints, and no persisted quantity/safety-stock/consumption surface. Do not fabricate inventory rows, quantities, or `IV-` codes.

## Sources inspected

- Current workspace status: `feat/cedar-activation...origin/feat/cedar-activation [gone]`, with many unrelated modified/untracked files; `web/src/console/module` is absent in this checkout.
- `origin/main:web/src/console/module/config.ts` — `ModuleConfig<Row>` contract and `ModuleField` union; `stock` is declared for inventory but not implemented.
- `origin/main:web/src/console/module/ModuleScreen.tsx` — one generic screen with compact statbar, search, shared-track list, detail kv/link/action, PolicyGated action rendering, J/K/Enter keyboard grammar, column resize, bottom fade, and dev-loud unsupported-field guard.
- `origin/main:web/src/console/module/moduleConfigs.ts` — real proof configs for work orders and support; demonstrates `load(api)`, columns, statbar, search, detail, actions, and `primaryAction` conventions.
- `origin/main:web/src/console/module/ModuleHarness.tsx` — live harness config registry currently only includes `workOrder` and `support`.
- `origin/main:web/src/console/shell/nav.ts` — inventory nav item exists as `screen: "inventory"`, label key `console.shell.nav.inventory`.
- `origin/main:web/src/i18n/ko.ts` — shell nav label `inventory: "재고"`; generic `ko.console.module` keys for list/detail/board/prog/action plus workOrder/support examples. No `ko.console.module.inventory` block exists.
- Current `web/src/console/explore/*` — object explorer and relation authoring use `GET /api/v1/search`, `/api/objects/{kind}/{id}/graph`, `POST /api/v1/object-links`, `DELETE /api/v1/object-links/{id}`, and `/api/audit` refresh.
- `origin/main:backend/openapi/openapi.yaml` — object substrate exists: `/api/v1/search`, `/api/objects/{kind}/{id}`, `/api/objects/{kind}/{id}/graph`, `/api/v1/object-links`, `/api/v1/object-types`; object actions exist only for `object_type=equipment`.
- `backend/crates/erp/domain/src/lib.rs` — pure helper validates inventory consumption accounting, but not a persisted inventory domain or API.
- `.omc/research/oyatie/prototype-anatomy/02-screens/post-snapshot-screens.md` and `05-post-snapshot-todo-digest.md` — inventory `IV-` display is a quantity-bar matrix: current stock + safety tick + monthly consumption; shortage uses danger tone.
- `.omc/research/oyatie/prototype-anatomy/04-backend-contract.md` — inventory IV- is explicitly `GAP: module domain — inventory` with zero backend for qty/safety-stock/consumption.

## Target implementation files

Use a fresh worktree from `origin/main`, not this stale dirty branch, before implementing.

Primary frontend targets:

1. `web/src/console/module/config.ts`
   - Keep a single `ModuleConfig<Row>` contract.
   - Extend the declared stock field from a marker to a data-bearing generic field, for example:
     - `kind: "stock"`
     - row stock accessor returning current quantity, safety-stock threshold, monthly consumption, unit/label, and computed shortage state.
   - Keep the field generic; do not add inventory-only component props.

2. `web/src/console/module/ModuleScreen.tsx`
   - Implement the generic `stock` renderer as a config-driven display field.
   - Preserve existing generic behavior: compact statbar, multi-attribute search, shared-column track list, detail panel, link chips, domain actions, PolicyGated rendering, J/K/Enter navigation, resize handles, fade, and no explanatory UI.
   - Update `IMPLEMENTED_FIELDS` only once the renderer is implemented.

3. `web/src/console/module/moduleConfigs.ts`
   - Add `inventoryModuleConfig` only when a real inventory read endpoint/type exists.
   - Register through the same config object shape as `workOrderModuleConfig` and `supportTicketModuleConfig`; no bespoke inventory screen.

4. `web/src/console/module/ModuleHarness.tsx` or the product shell/window registry on `origin/main`
   - Add `inventory` to the config registry only after `inventoryModuleConfig.load(api)` reads a real backend endpoint.

5. `web/src/console/module/ModuleScreen.test.tsx` and `moduleConfigs.test.ts`
   - Replace/adjust the dev-loud unsupported-stock test with renderer coverage once stock is implemented.
   - Add config tests proving inventory uses the generic screen, not duplicated shapes.

6. `web/src/i18n/ko.ts`
   - Add `ko.console.module.inventory` beside workOrder/support.
   - Add only strings that render; no explanatory captions or meta notices.

## Required `ModuleConfig` shape for Inventory

The Inventory module should be a plain `ModuleConfig<InventoryRow>`:

- `key`: `"inventory"`
- `title`: `ko.console.module.inventory.title` (`재고`)
- `rowId(row)`: backend UUID or canonical object id.
- `rowTitle(row)`: canonical issued object code (`IV-...`) plus item label when needed. Never raw UUID as the primary UI label.
- `columns`:
  - `code`: `IV-` code, mono.
  - `item`: part/material name.
  - `location` or `site`: branch/site/storage context, if backend returns it.
  - `current`: current quantity, mono/right-aligned.
  - `safety`: safety-stock threshold, mono/right-aligned.
  - `monthlyConsumption`: monthly usage/consumption, mono/right-aligned.
  - `status`: chip only for exceptions (`danger` when current < safety; possibly `warn` for near-threshold). Routine/ok statuses should stay plain or absent per console chip rules.
- `statbar(rows)`:
  - `total`: count of visible real inventory rows.
  - `shortage`: count where current < safety, tone `danger`.
  - `nearSafety`: optional count within a backend-defined warning band, tone `warn`.
  - `monthlyConsumption`: aggregate monthly usage only if the backend returns a source-backed aggregate and every number can drill to source objects.
- `search(row)` multi-attribute haystack:
  - `IV-` code, item/part name, SKU/vendor/material identifiers if present, branch/site/storage labels, linked work-order/purchase codes, and status label.
- `detail.kv(row)`:
  - `code`, `item`, `current`, `safety`, `monthlyConsumption`, `unit`, `location/site`, `updatedAt`, and backend-proven source/last movement identifiers.
- `detail.links(row)`:
  - Only real object codes/refs returned by backend or resolvable through object substrate: consuming `WO-`/dispatch object, purchase request `PO-`, asset/equipment `FL-` if applicable, supplier/vendor if backed by object kind.
  - No hardcoded placeholder codes.
- `detail.actions(row)`:
  - Domain primary action should be policy-gated and real-audited. Candidate labels: `소모 등록` / `출고 등록` / `재주문 요청` depending on B21b API.
  - Until B21b provides an audited mutation endpoint, return no actions for inventory rows.
- `primaryAction`:
  - Only if a real create/import/reorder route exists and is PolicyGated. Otherwise omit rather than render a dead CTA.
- `field`:
  - `kind: "stock"` with generic data accessors for current/safety/monthly consumption once the renderer contract is implemented.

## Required Korean i18n keys

Add under `ko.console.module.inventory`:

- `title`: `재고`
- `compose` or `primary`: only when a real primary action exists.
- `col.code`, `col.item`, `col.location`, `col.current`, `col.safety`, `col.monthlyConsumption`, `col.status`
- `kv.code`, `kv.item`, `kv.location`, `kv.current`, `kv.safety`, `kv.monthlyConsumption`, `kv.unit`, `kv.updatedAt`, `kv.lastMovement`
- `stat.total`, `stat.shortage`, `stat.nearSafety`, `stat.monthlyConsumption`
- `status.shortage`, `status.nearSafety`, `status.ok` if shown by the renderer/config.
- `action.consume`, `action.reorder`, `action.failed` only when backed by a real endpoint.
- Generic stock renderer labels, if shared across modules, should live under `ko.console.module.stock.current`, `stock.safety`, `stock.monthlyConsumption` rather than duplicating per module.

Existing generic keys already available on `origin/main`: `ko.console.module.list.*`, `detail.*`, `board.label`, `prog.label`, `action.failed`, plus `ko.console.shell.nav.inventory`.

## Real substrates available now

These can be reused by the Inventory implementation once B21b adds a real `inventory` object kind/read model:

- Generic module template: `ModuleConfig<Row>` + `ModuleScreen` on `origin/main`.
- Console policy gate: `PolicyGated` denies by omission; use a domain action string such as `inventory.read`, `inventory.consume`, `inventory.reorder` only after backend/session grants exist.
- Object search: `GET /api/v1/search` searches currently supported kinds only (`work_order`, `equipment`, `support_ticket`, `org_unit`, person directory). It will need `inventory`/`IV-` added before inventory search is real.
- Object resolve: `GET /api/objects/{kind}/{id}` can render object chips only for registered kinds. It needs `inventory` kind registration before `IV-` chips resolve.
- Object graph: `GET /api/objects/{kind}/{id}/graph` and object-links can connect inventory to consuming work orders/dispatch objects after the inventory kind and row ids exist.
- Object links: `POST /api/v1/object-links` / `DELETE /api/v1/object-links/{id}` are audited generic links, usable after both ends are registered/resolvable object kinds.
- Object action catalog: `/api/v1/object-actions/catalog` exists, but OpenAPI restricts `object_type` to `equipment`; inventory actions need B21b/backend extension before use.
- Lifecycle/run-log UI primitives: current console workflow components can render generated object chips and lifecycle/status timelines, but they are not an inventory persistence substrate by themselves.
- Code issuance substrate exists in platform DB on `origin/main`, but `IV-` prefix/object-kind issuance must be added by B21b before UI shows `IV-` codes.

## Backend-blocked gaps

Backend-gap/B21b must provide, at minimum:

1. Persisted inventory object/read model:
   - `inventory_item` / `inventory_part` rows scoped by org/branch/site/storage.
   - Canonical `IV-` code issuance.
   - Quantity on hand, safety-stock threshold, monthly consumption, unit, updated timestamp.
   - Branch/org RLS and feature-gated read access.

2. Consumption event model:
   - Append-only/audited movements or consumption events.
   - Links back to consuming work order / dispatch object.
   - Negative-stock guard, likely reusing the ERP-domain validation logic.

3. REST/OpenAPI/clients:
   - List/read endpoint that returns only source-backed visible inventory rows.
   - Movement/consume/reorder mutation endpoints wrapped in audit + policy.
   - OpenAPI update plus all generated clients.

4. Object substrate registration:
   - Register `inventory` kind for resolve/search/graph/object-links.
   - Teach `/api/v1/search` about `IV-` code and item labels.
   - Make `object_links` valid between `inventory` and `work_order`/dispatch/purchase/equipment as applicable.

5. Policy grants:
   - Add read/manage/consume/reorder feature keys to backend policy/session projection before frontend PolicyGated controls can appear.

Until those land, the frontend may implement only generic `stock` renderer infrastructure; it must not register a live inventory config with mock rows or fabricated `IV-` codes.

## Implementation recommendation

1. Link `t_209a85d9` to backend parent `t_224d8594` unless the implementation card is explicitly narrowed to generic stock-renderer plumbing only.
2. When B21b is available, build on `origin/main`:
   - implement generic `stock` field renderer,
   - add `inventoryModuleConfig`,
   - add Korean i18n,
   - register in the module harness/product shell,
   - prove rows/numbers drill to object resolve/graph/source event records.
3. Verification gates for the implementation card:
   - `tsc -b`
   - `eslint --max-warnings 0`
   - `web/scripts/check-console-purity.mjs`
   - `vitest run` for module tests
   - `check-ui-strings`
   - fidelity/grammar checklist using AGENTS.md + DESIGN grammar because the current checkout lacks `docs/design/oyatie-console/Oyatie Console.dc.html`.
