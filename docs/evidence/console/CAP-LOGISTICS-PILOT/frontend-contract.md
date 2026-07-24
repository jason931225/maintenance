# CAP-LOGISTICS-PILOT — frontend contract + convention scout (Stage 1)

Extracted 2026-07-23 from this branch's backend (`backend/crates/logistics/*`,
`backend/app/tests/logistics_pilot_story.rs`) and the console exemplars
(`web/src/console/production/**`, `web/src/console/consulting/**`). Everything
below is verified against source, not inferred.

## 1. REST contract

All routes live in `backend/crates/logistics/rest/src/lib.rs` and are wrapped by
`mnt_platform_request_context::with_request_context` (bearer JWT → Principal →
tenant `app.current_org` arming). **The router is write-only: 9 POST routes, zero
GET routes.** There is no list, detail-read, stock, or history endpoint anywhere
in the crate or in `backend/app` for logistics.

### 1.1 Routes

Request bodies are `camelCase` with `deny_unknown_fields` (an unknown field is a
422). Responses are ad-hoc `serde_json::json!` values (camelCase), documented
per route below. `Uuid` = canonical UUID string.

| # | Route | Body (required fields) | Success | Feature gate |
|---|-------|------------------------|---------|--------------|
| 1 | `POST /api/v1/logistics/asns` | `branchId`, `warehouseCode` (≤80), `externalReference` (≤120), `sku` (≤80), `expectedQuantity` (int >0) | `201 {id, status:"EXPECTED", branchId}` | `logistics_receive` |
| 2 | `POST /api/v1/logistics/asns/{asn_id}/receipts` — **requires `Idempotency-Key` header (16..200 chars)** | `branchId`, `receivedQuantity` (int >0) | `200 {id, status:"PARTIAL_RECEIVED"\|"RECEIVED", receivedQuantity}`; replay of same key+fingerprint → `200 {id, status, replayed:true}` | `logistics_receive` |
| 3 | `POST /api/v1/logistics/asns/{asn_id}/putaway` | `branchId` | `200 {id, status:"PUTAWAY"}` | `logistics_putaway` |
| 4 | `POST /api/v1/logistics/fulfillments` | `branchId`, `warehouseCode`, `sku`, `requestedQuantity` (int >0), `dueAt` (RFC3339 date-time) | `201 {id, status:"RELEASED", reservedQuantity}` | `logistics_release` |
| 5 | `POST /api/v1/logistics/fulfillments/{fulfillment_id}/pick` | `branchId`, `pickedQuantity` (int, 0..=reserved) | `200 {id, status:"PICKED"\|"SHORT_PICK", pickedQuantity}` | `logistics_pick_pack` |
| 6 | `POST /api/v1/logistics/fulfillments/{fulfillment_id}/pack` | `branchId` | `200 {id, status:"PACKED", pickedQuantity}` | `logistics_pick_pack` |
| 7 | `POST /api/v1/logistics/fulfillments/{fulfillment_id}/dispatch` | `branchId`, `carrierName` (≤120), `vehicleReference` (≤120) | `201 {id: <shipmentId>, fulfillmentId, status:"DISPATCHED"}` | `logistics_dispatch` |
| 8 | `POST /api/v1/logistics/shipments/{shipment_id}/pod` | `branchId`, `recipientName` (≤160), `evidenceReference` (must start `evidence://`), `confirmedAt` (date-time) | `200 {id, status:"DELIVERED", recipientConfirmedEvidenceReference, slaAssessment:"MET"\|"BREACHED"}` | `logistics_pod` |
| 9 | `POST /api/v1/logistics/shipments/{shipment_id}/settlements` | `branchId`, `currencyCode` (must be `"KRW"`), `amountMinor` (int ≥0), `settledAt` (date-time) | `200 {id, status:"SETTLED", operationalCost:{currency:"KRW", amountMinor}, financeGlPosting:null}` | `logistics_settle` |

SLA: `slaAssessment` = `MET` iff `confirmedAt <= fulfillment.due_at` else
`BREACHED` — computed server-side at POD time.

### 1.2 Error envelope

Single canonical shape from `RestError::into_response`:

```json
{ "error": { "code": "<code>", "message": "<human message>" } }
```

| HTTP | code |
|------|------|
| 401 | `unauthorized` (missing/malformed/invalid bearer) |
| 403 | `forbidden` (no grant, branch outside JWT scope, wrong token tier) |
| 404 | `not_found` (aggregate absent **or in another branch** — deny-by-omission) |
| 409 | `conflict` (illegal state transition, over-receipt, idempotency-key reuse with different body, insufficient stock, concurrent reservation loss) |
| 422 | `validation` (bounds, missing Idempotency-Key, non-KRW currency, non-`evidence://` reference, unknown body field) |
| 500 | `internal` |
| 503 | `unavailable` (JWT verifier unconfigured) |

### 1.3 Idempotency-Key semantics (receipts only)

- Required header on route 2 only; absent → 422 `validation`.
- 16..200 chars. Server stores `sha256({"asnId":<id>,"receivedQuantity":<n>})`
  as the fingerprint. Same key + same fingerprint → `200 {replayed:true}` (no
  double-count). Same key + different body → `409 conflict`.
- Frontend should generate one key per submit intent (e.g. `crypto.randomUUID()`
  twice-joined to clear 16 chars) and reuse it across retries of that intent.

### 1.4 Pagination

None. No GET routes exist, so there is no pagination convention in this module.

### 1.5 Authz model

- Features (snake_case keys as served by `GET /api/v1/me/authz` capabilities):
  `logistics_receive`, `logistics_putaway`, `logistics_release`,
  `logistics_pick_pack`, `logistics_dispatch`, `logistics_pod`,
  `logistics_settle`.
- **Grant-only PBAC**: the built-in role matrix denies all six roles
  (`[D,D,D,D,D,D]` in `platform/authz`); a caller only passes via a
  `policy_roles`/`policy_role_permissions` `allow` grant (story test seeds
  exactly this). SUPER_ADMIN does not inherit access.
- Branch scoping: `allow()` uses `authorize(principal, action, branchId)` unless
  the principal's JWT `BranchScope::All`, then `authorize_org_wide`. A grant
  cannot widen JWT branch scope (proven in story test 2): body `branchId`
  outside the JWT's branches → 403 even with the feature grant.
- Cross-branch reads of aggregates 404 (concealment), verified by
  `WHERE ... AND branch_id=$2` on dispatch/pod/settle lookups.

### 1.6 Story semantics (backend/app/tests/logistics_pilot_story.rs)

Signature chain — what the backend actually implements:

| Step | Implemented? |
|------|--------------|
| Inbound ASN | YES (route 1; single-SKU, single-line only) |
| Receiving (partial/full, idempotent, over-receipt rejected) | YES (route 2). ASN states: `EXPECTED → PARTIAL_RECEIVED → RECEIVED → PUTAWAY` |
| Putaway (stock upsert on-hand += received) | YES (route 3, from `RECEIVED` or `PARTIAL_RECEIVED`) |
| Replenishment | **NO** — not implemented anywhere |
| Pick / pack (short-pick explicit) | YES (routes 5–6). Fulfillment FSM: `RELEASED → PICKED|SHORT_PICK → PACKED → DISPATCHED → DELIVERED → SETTLED` |
| Release/reservation (no oversell, concurrent-safe) | YES (route 4; conditional `UPDATE ... WHERE on_hand - reserved >= q`, exactly one concurrent winner) |
| Dispatch (carrier + vehicle leg) | YES (route 7; creates the shipment aggregate) |
| Delivery evidence (POD, immutable `evidence://` ref) | YES (route 8) |
| SLA evaluation | YES but only the calendar comparison at POD; no SLO config, no breach workflow |
| Cost settlement | YES route 9, operational KRW only; `financeGlPosting` is **always `null` by design** (no GL/finance edge) |
| Any read/list/history API | **NO**. `logistics_history` and `audit_events` rows are written in-transaction (`with_audits`) but not exposed over REST |

## 2. Generated TS client status (drift the build stage must handle)

`clients/ts/src/schema.d.ts` has all 9 paths, but:

- Only routes 1–4 have typed `requestBody`. Routes 5–9
  (`pickLogisticsFulfillment`, `packLogisticsFulfillment`,
  `dispatchLogisticsShipment`, `verifyLogisticsPod`,
  `settleLogisticsOperationalCost`) are generated with `requestBody?: never`
  because `backend/openapi/openapi.yaml` omits their request bodies — **the
  backend rejects those calls without a body**, so `api.POST(...)` cannot be
  used as-is for them (passing `body` is a type error).
- All 9 success responses are `content?: never` — no typed response data. The
  production-style `requireData` (checks `response.data !== undefined`) works at
  runtime (openapi-fetch parses JSON regardless) but the value is untyped.
- `receiveLogisticsAsn` does type the required `Idempotency-Key` header param.

Resolution paths for the build stage (both truthful):

1. **Preferred**: manifest an `openapi.yaml` patch for the integrator adding the
   five missing `requestBody` schemas (mirroring §1.1 exactly) and typed 2xx
   response schemas for all nine, then module code uses the typed client
   everywhere. Collision roots `backend/openapi/**` + `clients/**` are
   integrator-owned, so this goes in a manifest JSON, not a direct edit.
2. **Interim, module-local**: typed client for routes 1–4; for 5–9 a thin
   module-owned fetch wrapper with hand-written request/response interfaces
   matching §1.1 (precedent: `web/src/console/policy/authz.ts`
   `fetchAuthzProjection` raw fetch with its `ponytail:` note; must replicate
   `Authorization`, `X-Auth-Transport: cookie`, `X-Device-Id`,
   `credentials:"include"` headers).

## 3. Console module conventions (exemplar: production; secondary: consulting)

### 3.1 File layout (module root `web/src/console/<module>/`)

```
index.ts                    — public exports only
routeContract.ts            — mount-contract interface + structural fixture (no business data)
<module>Api.ts              — typed transport bound to ConsoleApiClient
<module>Capabilities.ts     — pure gate→capabilities projection
use<Module>ConsoleAuthz.ts  — authz projection hook
<Module>ConsoleRoute.tsx    — route adapter (useAuth + authz + capabilities → Screen)
<Module>Screen.tsx          — Screen (session-fence remount wrapper) + ScreenBody
<module>.css                — module CSS (plain classes; tokens.css vars only)
*.test.ts(x)                — colocated vitest tests per file
```

### 3.2 API module pattern (`productionApi.ts`)

- `import type { components } from "@maintenance/api-client-ts"`; DTO aliases
  from `components["schemas"][...]` (for logistics: hand-written interfaces
  until §2 is resolved).
- `create<Module>Api(api: ConsoleApiClient)` returns an object of methods, each
  `api.GET/POST(path, { params, body, signal })` → `requireData(response)`.
- `class <Module>ApiError extends Error { constructor(message, readonly status) }`;
  `message()` reads the canonical envelope `error.error.message`, falls back to
  a status-labelled string.
- Never raw-fetch what the typed client covers; the client adds bearer,
  `X-Auth-Transport: cookie`, `X-Device-Id`, cookie credentials, 401
  single-flight refresh + one retry, and a 30s-fresh/5m-stale GET cache that is
  invalidated on any mutation.

### 3.3 Authz hook + capabilities

- `use<Module>ConsoleAuthz()` (copy of `useProductionConsoleAuthz`): floor =
  `jwtFloorProjection(session)`, authoritative = `fetchAuthzProjection(token,
  signal)` (`GET /api/v1/me/authz`, 3 attempts, fail-closed to floor), returns
  `makePolicyGate(projection, projection.source === "authz")`.
- `<module>Capabilities.ts`: module-local `Feature` union of the backend
  snake_case keys + `derive<Module>Capabilities(gate, branchId)` mapping
  `gate.allows({feature, branch, minPermission:"allow"})` to booleans.
  `canRead` = OR of all module features (deny-by-omission: nothing granted →
  whole module renders the denied state and fetches nothing).
  For logistics: 7 features → e.g. `canReceive` (asns+receipts),
  `canPutaway`, `canRelease`, `canPickPack`, `canDispatch`, `canPod`,
  `canSettle`, `canRead` = any.

### 3.4 Screen conventions

- Session fencing: `Screen` wrapper computes a compound key
  (`sessionKey:branchId:actorId:apiFenceId:capabilityKey`) and remounts the body
  on change (`ProductionScreen`); plus in-body `generation` counter +
  `AbortController` fencing on every load/mutate; stale responses are dropped.
- States are truthful: `loading` (`role="status"`), `error` (`role="alert"` +
  retry button), `empty` (`role="status"`), denied (`role="status"` denied text,
  zero fetches, zero action controls), `busy` (buttons `disabled`,
  `aria-busy`).
- Forms: native `FormData`, `useId()` for label/htmlFor pairs, `required`
  attributes, reset on applied mutation.
- Deny-by-omission in render: an action button exists only when the capability
  is true AND the aggregate is in the legal source state (production renders
  the request/approve/confirm buttons per-status).
- Styling: either module CSS file with plain string-literal classNames
  (production) or inline `style` objects using `var(--…)` tokens with
  `import "../tokens.css"` (consulting). Purity gate
  (`web/scripts/check-console-purity.mjs`) bans Tailwind utility classes in
  className, `@apply` in console CSS, and imports from `components/ui|shell`;
  `cn`/`clsx` are structurally useless (string literals only).

### 3.5 i18n mechanism (check-ui-strings)

`web/scripts/check-ui-strings.mjs` fails lint on any Hangul string literal or
JSX text outside `web/src/i18n/`, `web/src/test/`, `*.test.ts(x)`, `*.d.ts`.
Two compliant patterns exist:

- **Module strings file** (production): `web/src/i18n/production.ts` exports
  `export const productionStrings = { … } as const;` imported as
  `import { productionStrings as text } from "../../i18n/production";` —
  including a `status: {STATE: label, unknown: …}` map.
- **ko.ts subtree** (consulting): `ko.console.consulting.*` — ko.ts is an
  integrator-owned collision root, so logistics must NOT edit it directly.

For logistics: create `web/src/i18n/logistics.ts` (new file, no collision — the
per-module file precedent is established by production/salesCrm/dataExchange/
hrWorkflows). Status maps needed: ASN `EXPECTED/PARTIAL_RECEIVED/RECEIVED/
PUTAWAY`, fulfillment `RELEASED/PICKED/SHORT_PICK/PACKED/DISPATCHED/DELIVERED/
SETTLED`, `slaAssessment MET/BREACHED`, plus `unknown`. Note: this path is one
directory outside the lane's stated ownership roots; if the build-stage
ownership rules are enforced literally, emit it via manifest instead —
content is identical either way.

### 3.6 Test conventions (vitest + @testing-library/react)

- API tests: real `createConsoleApiClient("bearer-token")` with
  `vi.stubGlobal("fetch", …)` to assert URL/headers; or a stub
  `{GET: vi.fn(), POST: vi.fn()} as unknown as ConsoleApiClient` returning
  `{data|error, response: new Response(null,{status})}` to assert
  params/body/error surfacing ("surfaces a backend denial instead of
  synthesizing success").
- Screen tests: fixed capability fixtures (granted/denied per persona), assert
  denied state renders no controls AND performs zero fetches; retry flow;
  keyboard activation; session/api-switch fencing (old `AbortSignal.aborted`
  === true, stale resolve does not clobber).
- Route tests: `AuthTestProvider` (`web/src/test/AuthTestProvider.tsx`) with a
  literal `AuthSession` `{access_token, user_id, org_id,
  client_session_incarnation}` + `overrides:{api}`; authz endpoint mocked by
  `vi.stubGlobal("fetch", …)` returning a `MeAuthzResponse` JSON
  `{roles, branch_scope:{kind,branches}, capabilities:[{feature, permission,
  branch_scope}]}` — tests both `allow` on the right branch and
  `request_only`/wrong-branch denial.
- Capabilities tests: pure, a stub gate closure per case.
- `afterEach(() => vi.unstubAllGlobals())` whenever fetch is stubbed.

### 3.7 Registration (integrator-owned — manifest only)

Read-only extraction of the exact shapes; the integrator applies these.

- `web/src/console/shell/nav.ts`:
  1. `MOUNTED_SCREEN_KEYS`: append `"logistics"` (type `MountedScreenKey`
     derives from it).
  2. `NAV_GROUPS`: item inside the `fieldOps` group (labelId `fieldOps`) —
     `{ screen: "logistics", labelKey: "console.shell.nav.logistics",
     icon: "truck", gate: g(undefined, [<logistics feature keys>]) }`.
     Gate note: nav gates match on role OR feature intersection; logistics is
     grant-only, so pass only `features` (all 7 keys) and no `roles`.
  3. `EXPOSED_SCREEN_KEYS`: NOT touched — module stays DARK (mounted, not
     exposed) until evidence-approved per ADR-0025.
- `web/src/console/screens/registry.ts`: import the body and add
  `logistics: LogisticsScreenBody` to `SCREEN_REGISTRY`. **The registry mounts
  `ComponentType` with no props** — the logistics body must take no props and
  derive session/api via `useAuth()` (consulting precedent). `branchId` must
  therefore come from inside the module (session `branches` / authz
  `branchScope` + explicit branch selection when >1), not from a prop.
- `web/src/i18n/ko.ts`: `console.shell.nav.logistics: "물류"` (plus any
  ko-subtree strings if the module opts into ko.ts instead of its own file).

## 4. Honest gaps the build stage must design around

1. **No read surface.** With zero GET endpoints, a server-truthful list/overview
   layer is impossible today. The module can render only (a) objects returned
   by its own mutations in the current session (a working-set, clearly scoped)
   and (b) truthful empty/denied states. The completion contract's
   "list/overview + ≥2 upstream/downstream traversable links + history layer"
   needs BE read endpoints (asns/fulfillments/shipments/stock/history GETs) —
   a backend charter, out of this lane's scope. Do not fabricate lists.
2. **Client type drift** (§2) — five untyped request bodies, nine untyped
   responses; needs a manifest openapi patch or module-local types.
3. **Registry bodies are prop-less** — in-module branch selection is required.
4. **`web/src/i18n/logistics.ts`** sits outside the lane's literal ownership
   roots; create-or-manifest decision belongs to the build stage (no collision
   risk either way).
