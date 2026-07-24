# CAP-LOGISTICS-PILOT — openapi.json application notes (2026-07-23)

Applied by the consolidation integrator to `backend/openapi/openapi.yaml`.

## Applied as manifested

- Request bodies added to the five body-less operations (`pickLogisticsFulfillment`,
  `packLogisticsFulfillment`, `dispatchLogisticsShipment`, `verifyLogisticsPod`,
  `settleLogisticsOperationalCost`), including `additionalProperties: false`
  (backend uses `deny_unknown_fields`).
- Typed 2xx response schemas added to all nine logistics operations as named
  components (`LogisticsAsnCreated`, `LogisticsAsnReceipt`, `LogisticsAsnPutaway`,
  `LogisticsFulfillmentReleased`, `LogisticsFulfillmentPicked`,
  `LogisticsFulfillmentPacked`, `LogisticsShipmentDispatched`,
  `LogisticsPodVerified`, `LogisticsShipmentSettlement`) so the web client can
  alias `components["schemas"]` instead of hand-written interfaces.

## Deviations from the manifest (deliberate)

1. **Datetime format — tuple, not RFC3339.** The manifest declares
   `dueAt`/`confirmedAt`/`settledAt` as `format: date-time`, but its own
   `datetimeDivergence.caution` marks that as the POST-backendFix contract. Verified
   in `backend/crates/logistics/rest/src/lib.rs`: `ReleaseBody.due_at`,
   `PodBody.confirmed_at`, and `SettleBody.settled_at` are plain
   `time::OffsetDateTime` with NO `#[serde(with = "time::serde::rfc3339")]`, so
   the only accepted wire form is time's default serde tuple
   `[year, ordinal-day, hour, minute, second, nanosecond, offsetH, offsetM, offsetS]`
   (an RFC3339 string is rejected with 422). The spec therefore declares all
   three fields as the shared `LogisticsTimeTuple` schema (9-integer array) —
   including the pre-existing `dueAt`, whose old `format: date-time` declaration
   was equally wrong. `web/src/console/logistics/logisticsApi.ts` keeps
   `toTimeWire()`. When the backend lane lands the rfc3339 annotations
   (`backendFix` in openapi.json), flip `LogisticsTimeTuple` refs back to
   `{ type: string, format: date-time }`, regenerate clients, and drop
   `toTimeWire`.
2. **`financeGlPosting`** — manifest says `type: "null"` (JSON Schema null
   type); declared as `nullable: true` with no type instead, matching the
   equipment-3r fragment's convention for the same concept, because the Kotlin
   generator does not accept a bare `type: "null"`.
