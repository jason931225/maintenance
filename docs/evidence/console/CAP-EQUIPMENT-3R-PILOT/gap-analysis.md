# CAP-EQUIPMENT-3R-PILOT — Gap Analysis (Stage 1)

Lane: CAP-EQUIPMENT-3R-PILOT · Story STORY-EQUIPMENT-3R-001 · Route `/console/equipment`
Date: 2026-07-23 · Worktree branch: `claude/console-equipment-backend-20260724`

Verdict summary: **build a bounded, self-contained pilot vertical** (`backend/crates/equipment/**`,
tables `equipment_3r_*`, routes `/api/v1/equipment-3r/**`) following the logistics/facilities
pilot discipline. Reuse *platform substrate* (RLS arming, `with_audits`, request-context,
PBAC feature grants, error envelope) verbatim; reuse *no legacy domain tables or crates*.

## 1. Existing concepts surveyed — reuse-vs-build verdict per concept

| Concept | Where it exists today | Verdict | Rationale |
|---|---|---|---|
| Equipment master (unit registry) | `registry_equipment` (migration 0007; org_id+RLS retrofitted in 0027–0031). Korean statuses `임대/예비/폐기/대체/매각`, forklift import columns (`ton_milli`, `vin`, `management_no`, insurance…), trgm autocomplete (0020). REST: `/api/v1/equipment*` in `registry/rest` (~11k LoC crate: versioning, rollback, ownership-transfer, substitutions, timeline-graph). | **DO NOT reuse; build `equipment_3r_units`.** | `registry_equipment` is the legacy FSM import master: its status vocabulary is display-oriented Korean strings with no FSM enforcement, its columns are Excel-import shaped, and its lifecycle has no rental-case linkage. Prior program precedent is explicit — sales #6 deliberately did NOT reuse `registry_equipment` (memory: sales-catalog-6-build), and the facilities pilot header states it "intentionally does not depend on the legacy equipment-required work-order model." The 3R pilot needs an FSM-governed availability state; grafting that onto the legacy table would couple the pilot to versioning/rollback/import machinery it must not inherit. No FK from pilot tables into `registry_equipment`. |
| Rental quote / pricing | `financial_rental_quotes` + `financial_rental_quote_lines` (0015): depreciation-method quote calculator (STRAIGHT_LINE/DECLINING_BALANCE, bps rates, residual floors), FK → `registry_equipment`. | **DO NOT reuse; embed simple pricing on `equipment_3r_rental_cases`.** | The financial quote is an *equipment-costing calculator* (residual value model pending 경리 validation), not a rental-agreement lifecycle. It has no approval/dispatch/return chain and hard-FKs the legacy master. The pilot stores the agreed `monthly_rate_minor` + `duration_months` (KRW) on the case, mirroring how the logistics pilot stored operational KRW amounts without touching finance-gl. Depreciation-derived pricing stays a future integration (quote pre-fill), not a dependency. |
| Work orders (repair execution) | `workorder` crate (~14k LoC), `work_orders` (0008): 16-state FSM, approval lines, assignments, FK → `registry_equipment`. | **DO NOT reuse; represent repair/refurbish as `equipment_3r_dispositions`.** | The work-order FSM is the legacy field-service pipeline bound to legacy equipment and approval-role machinery. The 3R story needs only "disposition opened → completed (cost)" — one guarded transition. Facilities faced the same choice and built its own case pipeline. |
| Dispatch | `dispatch` crate: `p1_dispatches` (0011) — emergency *technician* dispatch (geo scoring, response timers). | **DO NOT reuse.** | Different noun: 3R dispatch is *physical delivery of a unit to a customer* (carrier + vehicle), exactly the `logistics_shipments` shape. Modeled as a case transition carrying `carrier_name`/`vehicle_reference`. |
| Inventory | `inventory` crate: parts/consumables stock (`QuantityMilli`, safety stock, consumption). | **DO NOT reuse.** | Serialized rental units are not fungible stock. The oversell guard the pilot needs is a single-row guarded `UPDATE … WHERE availability='AVAILABLE'` (logistics stock-reservation pattern at quantity 1). |
| Financial / ERP posting | `financial` (purchase requests, cost ledger), `finance-gl` (vouchers, SoD), `erp/domain` (journal/VAT types). | **DO NOT touch.** | Same boundary the logistics pilot proved: operational KRW amounts are recorded on pilot tables; responses state no GL posting occurred (`financeGlPosting: null` precedent). Voucher integration is a future charter. |
| Resale / listings | `sales` crate: `sales_listings` + `customer_inquiries` (0043), public storefront. | **PARTIAL FUTURE INTEGRATION; build `RESALE` disposition now.** | Sales listings are the *public storefront* surface. The 3R resale disposition records the internal decision + sale completion (buyer, amount). Pushing a FOR_SALE unit into `sales_listings` is a clean later charter; a hard dependency now would drag storefront media/RustFS scope into the pilot. |
| Inspection | `inspection` crate: schedule/round self-inspection (`/api/v1/inspections/*`), FK → `registry_equipment`. | **DO NOT reuse; build `equipment_3r_inspections`.** | Legacy inspection is schedule-window driven and legacy-master-bound. 3R needs case-scoped on-rent inspection/maintenance records and a distinct return assessment gate. |
| Equipment substitutions | `equipment_substitutions` (0014) + registry REST. | **Out of scope.** | Substitution is a legacy availability workaround; the 3R redeployment loop supersedes it inside the pilot boundary. |
| Legacy FE capability intent | `web/src/features/equipment/`: EquipmentManagementPanel (list/filter/edit), EquipmentDetailDialog, EquipmentImportPanel, SubstitutionPanel, SiteGeographyPanel, ManagementNoCombobox. | **Intent only.** | Confirms the console module must lead with a filterable unit list + object detail; import/substitution/geography stay legacy-only. The 3R console adds what legacy never had: lifecycle actions, rental-case workflow, history. |
| Platform substrate | `with_audits`/`with_audit` (platform/db), `with_request_context` + `resolve_principal` (platform/request-context), `authorize`/`authorize_org_wide` + `Feature` (platform/authz), `feature_catalog`+`policy_roles` PBAC grants, `enforce_org_id_immutable()`, org-isolation RLS policy DO-block, JWT verifier. | **REUSE verbatim.** | This is the entire point of the pilot pattern; both exemplars use it identically. |

## 2. Exemplar conventions extracted (logistics = 0179, facilities = 0178)

The freshest pilot (**logistics**) is the primary template; facilities contributes GET/read
surface and in-transaction branch authorization. The build stage follows:

- **Crate layout**: `equipment/{domain,application,adapter-postgres,rest}` with package names
  `mnt-equipment-{domain,application,adapter-postgres,rest}` (+ BUCK files per crate, mirroring logistics).
  Domain = FSM vocabulary with `as_db/from_db/can_transition_to` + unit tests; application = HTTP-independent
  DTO contracts (no org_id by design); adapter = `PgEquipment3rStore` with all mutations under `with_audits`;
  rest = router + authz + canonical envelope.
- **RLS**: every table `ENABLE`+`FORCE ROW LEVEL SECURITY`, `org_isolation` policy on
  `app.current_org` GUC, `GRANT SELECT, INSERT, UPDATE TO mnt_rt`, `enforce_org_id_immutable()`
  trigger per table, composite FKs `(branch_id, org_id) REFERENCES branches(id, org_id)` and
  `UNIQUE (id, org_id)` so child FKs carry org.
- **Audit**: `with_audits(pool, org, |tx| …)` returning `(json, Vec<AuditEvent>)`; audit action
  segments `[a-z0-9_]` dot-separated ≥2 (verified `AuditAction::new`); history table append-only
  (UPDATE/DELETE-raising trigger) written in the same transaction.
- **Idempotency**: `Idempotency-Key` header (16..200 chars), SHA-256 request fingerprint column
  `~ '^[a-f0-9]{64}$'`, `UNIQUE (org_id, idempotency_key)`; replay returns stored outcome with
  `"replayed": true`; same key + different fingerprint → 409.
- **Concurrency**: `SELECT … FOR UPDATE` + status-guarded `UPDATE … WHERE status=$from`;
  `rows_affected != 1` → 409; availability reservation via guarded single-row UPDATE (logistics
  stock pattern) so concurrent approvals produce exactly one winner.
- **Error envelope**: logistics nested form `{"error":{"code","message"}}` with codes
  `validation`(422) `not_found`(404) `forbidden`(403) `conflict`(409) `unauthorized`(401)
  `unavailable`(503) `internal`(500). (Facilities uses a flat envelope; the newer logistics
  form is the contract.)
- **Authz**: fail-closed PBAC — feature keys registered in `feature_catalog` by the migration,
  granted only via ACTIVE custom roles; REST resolves `Principal` via `resolve_principal`, then
  `authorize` (branch) / `authorize_org_wide` (`BranchScope::All`). Branch derived from the
  persisted row inside the locked transaction for transitions (facilities pattern — client
  cannot steer authz by body branch).
- **App mount**: `build_router` merges `mnt_equipment_rest::router(state)`; route paths exported
  as `EQUIPMENT_3R_ROUTE_PATHS` const for telemetry registration (facilities precedent at
  `backend/app/src/lib.rs:283`).
- **Test style** (`backend/app/tests/*_pilot_story.rs`): `#[sqlx::test(migrations=…)]`,
  ES256 keypair + real `JwtIssuer` token, `SET ROLE mnt_rt` pool via `after_connect`,
  `build_router(...).oneshot(...)` through the assembled HTTP router, PBAC grants seeded via
  `policy_roles`/`policy_role_permissions`/`user_role_assignments`, assertions on branch-scope
  widening denial, ungranted-user denial, concurrent single-winner, history/audit row counts.

## 3. Gaps the pilot must close (nothing existing provides these)

1. FSM-governed equipment availability with audited transitions (legacy status is free-text-ish Korean labels).
2. Rental case lifecycle: quote → approval (four-eyes) → dispatch → handover (evidence) → return → assessment → close.
3. Return assessment producing an enforced disposition branch (repair/refurbish/resale/redeploy).
4. Disposition execution records with completion costs / sale outcome and unit re-entry to availability.
5. Unified per-unit history feed for the console history layer.

## 4. Boundary risks flagged to the integrator/orchestrator

- `backend/crates/platform/authz/src/lib.rs` (Feature enum variants) and `backend/app/src/lib.rs`
  (router merge + route-path registration) are outside this lane's ownership roots and not in the
  declared collision list — the build stage needs either expanded ownership or an integrator manifest.
- `backend/openapi/openapi.yaml` + `clients/**` are integrator-owned: the build stage must emit a
  manifest (`docs/evidence/console/CAP-EQUIPMENT-3R-PILOT/openapi-manifest.json`) with `tags: [equipment-3r]`
  per operation (per-domain tag rule — Kotlin client OOM).
- Migration slot `0185` is PROVISIONAL (current head is `0180`); integrator renumbers at merge.
