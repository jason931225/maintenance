# CAP-LOGISTICS-PILOT — frontend verification (Stage 3, fresh eyes)

Adversarial verification of `web/src/console/logistics/**` against
`backend/crates/logistics/rest/src` + `adapter-postgres/src`, the module
completion contract (`docs/program/console-enterprise-roadmap.md` §258), and the
UI grammar. The verifier did not write the original code. Everything below was
re-derived from source and re-run, not copied from the build report.

## Verdict

PASS within the write-only backend ceiling, with one critical wire-format
defect found and fixed during verification (`c719f75c`), and the known
backend-charter gaps re-confirmed as real (not fixable frontend-side).

## Critical finding fixed during verification

**Datetime wire format (release / pod / settle would have 422'd in production).**
`ReleaseBody.due_at`, `PodBody.confirmed_at`, `SettleBody.settled_at` are plain
`time::OffsetDateTime` — no `#[serde(with = "time::serde::rfc3339")]` — in
`backend/crates/logistics/rest/src/lib.rs`. Empirical proof (scratch crate
pinned to `time =0.3.47` with the workspace feature set, cross-checked with
`cargo tree -p mnt-logistics-rest -i time -e features` and
`-p mnt-app`: only `serde` + `serde-well-known` unify; `serde-human-readable`
is absent from both graphs, and in time 0.3.47 `serde-well-known` does NOT
imply it):

```
rfc3339 string: Err("invalid type: string \"2026-07-23T12:34:56Z\", expected an `OffsetDateTime`")
tuple:          Ok(ReleaseBody { due_at: 2026-07-23 12:34:56.0 +00:00:00 })
serde_json serializes OffsetDateTime as: [2026,205,12,34,56,0,0,0,0]
```

So the only accepted wire form is time's default serde 9-tuple
`[year, ordinal-day, h, m, s, nanos, 0, 0, 0]`, and the backend's own story
test passes only because `serde_json::json!` emits that tuple. Fix:
`toTimeWire()` in `logisticsApi.ts` encodes the three fields in UTC at the
release/pod/settle call sites; unit tests pin leap-year ordinals and non-UTC
offset normalization. The divergence, the backend fix (add the rfc3339
annotations), and the rollout-safety note are recorded in
`manifests/openapi.json` (`datetimeDivergence`) — the spec patch there
describes the POST-fix contract and must not be applied without the backend
annotation.

## Contract fidelity (field-level diff vs backend)

- Routes: all 9 `LOGISTICS_ROUTE_PATHS` bound, POST-only, path params
  `{asn_id}/{fulfillment_id}/{shipment_id}` match. The backend has zero GET
  routes — repeated-query parsing and N+1 fetch classes are structurally
  inapplicable (no reads exist).
- Request bodies: `AsnBody`, `ReceiptBody`, `BranchBody` (putaway + pack),
  `ReleaseBody`, `PickBody`, `DispatchBody`, `PodBody`, `SettleBody` — every
  camelCase field name and type matches; `deny_unknown_fields` is satisfied
  (spreads introduce no extra keys; verified by wire-serialization tests).
- Responses: all 9 hand-written interfaces mirror the adapter's `json!`
  payloads verbatim, including the receive replay branch
  (`replayed: true`, `receivedQuantity` absent), `dispatch`'s created-shipment
  `id` + `fulfillmentId`, `pod`'s `recipientConfirmedEvidenceReference` +
  `slaAssessment` (MET iff `confirmed_at <= due_at`), and `settle`'s
  `operationalCost.{currency,amountMinor}` + `financeGlPosting: null`.
- Error envelope: `{"error":{"code","message"}}` with status mapping
  422/404/403/409/500 — `LogisticsApiError` surfaces `error.message`,
  409-conflict messages asserted verbatim in tests.
- Idempotency: `Idempotency-Key` header on receipts only, caller-owned, one
  key per submit intent (fingerprint `asnId:quantity`), reused across retries
  of that intent, discarded on applied success — retry-key-reuse asserted by
  test.
- Authz feature names: the 7 `logistics_*` strings match
  `mnt-platform-authz` `Feature::as_str` exactly (lib.rs:433-439).

## Module completion contract (9 points)

1. **No stubs/dead controls** — sweep clean (TODO/FIXME/skip/only/placeholder
   text: zero hits). The `placeholder="evidence://"` input attribute is the
   backend's `^evidence://` pattern affordance, paired with `pattern=`
   validation, not filler copy.
2. **Truthful data only** — every rendered row originates from a mutation
   response this session; truthful empty (`asnEmpty`/…), denied (`denied`),
   no-branch (`noBranch`), error+retry (role=alert) states. No fabrication.
3. **Real mutations, failure exposure, safe retry** — 9 real routes; server
   records audit evidence in the same transaction (`with_audits`); errors
   render verbatim; retry re-runs the exact intent (same idempotency key on
   receipts).
4. **Layers** — list/overview (3 queues + compact stat chips), object detail
   (ASN/fulfillment/shipment articles), action/workflow (per-state,
   per-capability forms for all 9 mutations), history (ASN receipt log with
   replay marking; POD + settlement records on the shipment). History is
   session-local — see gaps.
5. **≥2 upstream + ≥2 downstream links** — fulfillment→shipment and
   ASN→related-fulfillments (downstream), shipment→fulfillment and
   fulfillment→related-ASNs (upstream), the related-object edge being the
   backend's real `(branch, warehouseCode, sku)` stock join (putaway feeds
   `logistics_stock`, release reserves from it). Both directions
   click-asserted in tests. Added during verification (`c719f75c`) — the
   build-stage code had only the fulfillment↔shipment pair.
6. **Server-enforced authz, deny-by-omission** — backend authorizes every call
   (grant-only features, no role inheritance); render gate consumes the
   canonical authz projection, fails closed to the JWT floor (floor grants
   only runtime-effective JWT `feature_grants`, so nothing unauthorized can
   flash); `request_only` permission and out-of-scope branches render the
   denied state with zero control leakage (tested). No server counts exist to
   leak.
7. **Keyboard/contrast/Korean/responsive** — keyboard activation test
   (focus + Enter on queue items, aria-pressed); labeled controls via
   htmlFor/useId; role=status/alert, aria-busy, aria-live; tokens-only colors
   (0 raw color literals, 78 token refs); `@media (max-width: 900px)` +
   wrap/minmax layout; Korean-only strings from the module strings file
   (`check-ui-strings` green, no inline Hangul outside tests). No
   JSDOM-meaningful responsive assertion exists — layout reflow is CSS-only
   and was not browser-verified in this lane.
8. **Selection/draft survival** — survive error/retry and session-noop
   re-renders (fence keys identity); a stale session/tenant swap remounts and
   aborts in-flight work (tested, including the AbortSignal). Browser-refresh
   survival is impossible truthfully — nothing server-side to rehydrate from
   (see gaps).
9. **This document.**

## Evidence topology (executable user-story gate)

`27/27` tests across 4 files assert business outcomes: full outbound chain
release→pick(SHORT_PICK)→pack→dispatch→POD(SLA MET)→settle with queue-status
and settlement-amount assertions; denied-before-fetch; least-privileged
receive-only persona (no putaway/release/dispatch controls); 409 denial
surfaced verbatim then retried with the SAME idempotency key; idempotent
replay marked without double-counting; stale-session fence dropping a resolved
mutation; keyboard completion; filter without working-set loss; tuple wire
encoding (leap year, offset normalization); route-level authz parsing
(`request_only` deny, branch-scope deny, multi-branch in-module selection).
Missing: browser/E2E replay against the real backend with provisioned
identities (needs the read-endpoint charter to be meaningful), responsive
behavior assertion (JSDOM cannot), cross-tenant isolation probe (backend-side
test exists in `logistics_pilot_story.rs`; no frontend-reachable read surface
to probe).

## Gate results (this stage, re-run after fixes)

- `npx vitest run src/console/logistics` → 4 files, 27/27 passed
- `npx vitest run` (full web suite) → 268 files, 2210/2210 passed (no
  cross-module fallout from the new `src/i18n/logistics.ts`)
- `npx tsc -b` → clean (exit 0)
- `npx eslint src/console/logistics src/i18n/logistics.ts --max-warnings 0` →
  clean (exit 0)
- `node scripts/check-ui-strings.mjs` → exit 0
- `node scripts/check-console-purity.mjs` → OK, 407 files clean

## NOT fixed (honest gaps, all backend-charter shaped)

1. **No server read surface** — list/detail/history render only the session
   working set; a browser refresh truthfully empties the queues. Blocked on
   the logistics read-endpoint charter (frontend-contract.md §4). This also
   caps point 4 (history readback) and point 8 (refresh survival).
2. **Client-side fulfillment advance on POD/settle** — the linked
   fulfillment's DELIVERED/SETTLED status is updated client-side mirroring the
   backend's verified same-transaction update, because the response body
   covers only the shipment. Truthful to the source; still second-hand until
   a read endpoint exists.
3. **`as never` casts + hand-written response types** stand until the
   integrator applies `manifests/openapi.json` (including the
   `datetimeDivergence` backend fix first) and regenerates
   `clients/{ts,kotlin,swift}`.
4. **Replay after a lost receive response undercounts locally** — a replayed
   receipt carries no `receivedQuantity`, so if the original response was
   never seen, the client total stays at its last-known value (marked with
   the replay chip). Only a read endpoint can reconcile.
5. **Full-web `npm run lint`** remains red from 15 pre-existing errors in
   `web/src/console/{comms-rail,production}` — outside this lane's roots,
   untouched, present with the lane's changes stashed.
6. **`web/src/i18n/logistics.ts`** sits one directory outside the literal
   ownership roots (per-module-file precedent: production/salesCrm/
   dataExchange/hrWorkflows); fully mirrored in `manifests/i18n.json` for
   integrator audit/relocation.
