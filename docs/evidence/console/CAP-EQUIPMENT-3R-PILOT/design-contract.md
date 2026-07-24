# CAP-EQUIPMENT-3R-PILOT — Design Contract (Stage 1)

Binding contract for the backend build stage (`backend/crates/equipment/**`, migration `0185`,
`backend/app/tests/equipment_3r_api.rs`) and the frontend build stage (`/console/equipment`).
Conventions inherit from the logistics (0179) and facilities (0178) pilots as recorded in
`gap-analysis.md`. All money is KRW minor units (`amount_minor BIGINT`). All timestamps `TIMESTAMPTZ`.
All request DTOs are `camelCase` with `deny_unknown_fields`; responses `camelCase`.

## 1. Object model

- **Equipment unit** (`equipment_3r_units`) — serialized rental asset with an FSM `availability`.
  Identity: org-unique `serial_no`. Attributes: `model_name`, `capacity_class`,
  `acquisition_cost_minor`. Self-contained: no FK to `registry_equipment`.
- **Rental case** (`equipment_3r_rental_cases`) — one quote-to-close engagement binding a unit to a
  customer. Carries agreed pricing (`monthly_rate_minor`, `duration_months`, KRW), customer/site
  text identity, approval decision (four-eyes), dispatch leg (carrier/vehicle), handover evidence
  (`evidence://` reference), return timestamp. Created idempotently.
- **Inspection** (`equipment_3r_inspections`) — append-only on-rent inspection/maintenance record
  scoped to a case in `HANDED_OVER`.
- **Return assessment** (`equipment_3r_return_assessments`) — exactly one per case, posted while the
  case is `RETURNED`; records `condition_grade` and the binding `disposition` branch.
- **Disposition** (`equipment_3r_dispositions`) — repair/refurbish/resale/redeploy execution record
  opened by the assessment; completion returns the unit to circulation or ends its life (`SOLD`).
- **History** (`equipment_3r_history`) — append-only transition feed per aggregate (`unit`, `case`,
  `disposition`), written in the same transaction as every transition; feeds the console history layer.

Traversable links (console): unit ↔ active case, unit ↔ dispositions, case ↔ inspections,
case ↔ assessment, assessment ↔ disposition, everything ↔ history.

## 2. Lifecycle FSMs (every transition audited + history row, same transaction)

### 2.1 Rental case `status`
```
QUOTED ─(approval APPROVED)→ APPROVED ─(dispatch)→ DISPATCHED ─(handover)→ HANDED_OVER
QUOTED ─(approval DECLINED)→ DECLINED  [terminal]
HANDED_OVER ─(return)→ RETURNED ─(assessment)→ CLOSED  [terminal]
```
Guards: approval is four-eyes (`approver != created_by` → 403 `forbidden`); approval `APPROVED`
atomically reserves the unit (guarded `UPDATE … SET availability='RESERVED' WHERE id=$unit AND
availability='AVAILABLE'`, `rows_affected!=1` → 409 — the concurrent-approval single-winner rule);
inspections only in `HANDED_OVER`; assessment only in `RETURNED`.

### 2.2 Unit `availability`
```
AVAILABLE → RESERVED            (case approval)
RESERVED  → ON_RENT             (handover)
ON_RENT   → IN_ASSESSMENT       (return)
IN_ASSESSMENT → IN_REPAIR         (assessment disposition=REPAIR)
IN_ASSESSMENT → IN_REFURBISHMENT  (assessment disposition=REFURBISH)
IN_ASSESSMENT → FOR_SALE          (assessment disposition=RESALE)
IN_ASSESSMENT → AVAILABLE         (assessment disposition=REDEPLOY)
IN_REPAIR → AVAILABLE           (disposition completion)
IN_REFURBISHMENT → AVAILABLE    (disposition completion)
FOR_SALE  → SOLD                (disposition completion)   SOLD = terminal
```
Domain crate exposes `Availability`/`CaseState`/`DispositionState` enums with
`as_db/from_db/can_transition_to` + unit tests (logistics `FulfillmentState` pattern).
DB backstop: terminal-immutability trigger raises on any `UPDATE` moving a unit out of `SOLD`
and any update of a `DECLINED`/`CLOSED` case status.

### 2.3 Disposition `status`
```
OPEN → COMPLETED   [terminal]
```
`REDEPLOY` dispositions are inserted already `COMPLETED` (`cost_minor=0`) for a truthful history
trail. At most one `OPEN` disposition per unit (partial unique index).

## 3. REST surface — prefix `/api/v1/equipment-3r` (legacy registry keeps `/api/v1/equipment`)

Envelope on every error: `{"error":{"code":"<code>","message":"<human>"}}`.
Codes/status: `validation`→422, `not_found`→404 (also cross-org concealment via RLS),
`forbidden`→403 (missing grant, branch outside JWT scope, four-eyes violation),
`conflict`→409 (illegal transition, concurrent loser, idempotency-key reuse with different
fingerprint, duplicate serial), `unauthorized`→401, `unavailable`→503, `internal`→500.
No CAS/`If-Match` (no 412): optimistic concurrency is FOR UPDATE + status-guarded UPDATE → 409,
matching both exemplars. Transition bodies carry no `branchId`; branch is read from the locked
row and authorized in-transaction (facilities pattern). Creation bodies carry `branchId` (authz
pre-check + `authorize` against it).

| # | Method+Path | Feature (deny-by-default) | Request DTO | Success | Notes |
|---|---|---|---|---|---|
| 1 | `POST /units` | `equipment_3r_registry` | `{branchId: uuid, serialNo: 1..80, modelName: 1..120, capacityClass: 1..40, acquisitionCostMinor: i64>=0}` | 201 UnitView | duplicate `(org, serialNo)` → 409 |
| 2 | `GET /units` | `equipment_3r_observe` (org-wide) | — | 200 `[UnitView]` | newest first, LIMIT 200 |
| 3 | `GET /units/{unit_id}` | `equipment_3r_observe` | — | 200 UnitDetailView | includes `activeCaseId`, `openDispositionId` |
| 4 | `GET /units/{unit_id}/history` | `equipment_3r_observe` | — | 200 `[HistoryEntry]` | unit + its cases + dispositions, newest first |
| 5 | `POST /rental-cases` | `equipment_3r_quote` | header `Idempotency-Key` (16..200) + `{branchId, unitId, customerName: 1..160, siteReference: 1..200, monthlyRateMinor: i64>0, durationMonths: 1..=120, currencyCode: "KRW"}` | 201 CaseView | replay same key+fingerprint → 200 CaseView with `replayed: true`; same key, different fingerprint → 409. Unit must exist in branch and not be `SOLD` (else 409); quoting does NOT reserve |
| 6 | `GET /rental-cases` | `equipment_3r_observe` (org-wide) | — | 200 `[CaseView]` | newest first, LIMIT 200 |
| 7 | `GET /rental-cases/{case_id}` | `equipment_3r_observe` | — | 200 CaseDetailView | includes inspections + assessment + disposition ids |
| 8 | `POST /rental-cases/{case_id}/approval` | `equipment_3r_approve` | `{decision: "APPROVED"\|"DECLINED", reason?: 1..500 (required iff DECLINED)}` | 200 CaseView | four-eyes: actor == case creator → 403; APPROVED reserves unit (single winner) |
| 9 | `POST /rental-cases/{case_id}/dispatch` | `equipment_3r_dispatch` | `{carrierName: 1..120, vehicleReference: 1..120}` | 200 CaseView | only from `APPROVED` |
| 10 | `POST /rental-cases/{case_id}/handover` | `equipment_3r_dispatch` | `{recipientName: 1..160, evidenceReference: ^evidence://[A-Za-z0-9._/-]{8,400}$, handedOverAt: rfc3339}` | 200 CaseView | only from `DISPATCHED`; unit → ON_RENT |
| 11 | `POST /rental-cases/{case_id}/inspections` | `equipment_3r_inspect` | `{outcome: "PASS"\|"MAINTENANCE_PERFORMED", findings: 1..2000, maintenanceNote?: 1..2000 (required iff MAINTENANCE_PERFORMED)}` | 201 InspectionView | case must be `HANDED_OVER` else 409 |
| 12 | `POST /rental-cases/{case_id}/return` | `equipment_3r_assess` | `{returnedAt: rfc3339}` | 200 CaseView | only from `HANDED_OVER`; unit → IN_ASSESSMENT |
| 13 | `POST /rental-cases/{case_id}/assessment` | `equipment_3r_assess` | `{conditionGrade: "A"\|"B"\|"C"\|"D", findings: 1..2000, disposition: "REPAIR"\|"REFURBISH"\|"RESALE"\|"REDEPLOY"}` | 200 CaseDetailView | only from `RETURNED`; closes case, moves unit per §2.2, opens disposition (REDEPLOY: completed) |
| 14 | `POST /dispositions/{disposition_id}/completion` | `equipment_3r_disposition` | REPAIR/REFURBISH: `{costMinor: i64>=0}` · RESALE: `{saleAmountMinor: i64>=0, buyerName: 1..160}` | 200 DispositionView | only `OPEN`; REPAIR/REFURBISH → unit AVAILABLE, RESALE → unit SOLD. Response includes `financeGlPosting: null` (no GL claim) |

### Response DTOs
- **UnitView**: `{id, serialNo, modelName, capacityClass, availability, acquisitionCostMinor, branchId}`
- **UnitDetailView**: UnitView + `{activeCaseId: uuid|null, openDispositionId: uuid|null, createdAt, updatedAt}`
- **CaseView**: `{id, unitId, status, customerName, siteReference, monthlyRateMinor, durationMonths, currencyCode: "KRW", branchId, replayed?: true}`
- **CaseDetailView**: CaseView + `{approval: {decision, reason, decidedBy, decidedAt}|null, dispatch: {carrierName, vehicleReference, dispatchedAt}|null, handover: {recipientName, evidenceReference, handedOverAt}|null, returnedAt: ts|null, assessment: {conditionGrade, findings, disposition, assessedBy, assessedAt}|null, dispositionId: uuid|null, inspections: [InspectionView], createdBy, createdAt, updatedAt}`
- **InspectionView**: `{id, caseId, outcome, findings, maintenanceNote, inspectedBy, inspectedAt}`
- **DispositionView**: `{id, unitId, caseId, kind, status, costMinor, saleAmountMinor, buyerName, completedBy, completedAt, financeGlPosting: null}`
- **HistoryEntry**: `{aggregateKind: "unit"|"case"|"disposition", aggregateId, transition, actorId, occurredAt}`

### Audit actions (all validated by `AuditAction::new`, `[a-z0-9_]` segments)
`equipment_3r.unit.register`, `equipment_3r.case.quote`, `equipment_3r.case.approval`,
`equipment_3r.case.dispatch`, `equipment_3r.case.handover`, `equipment_3r.case.inspect`,
`equipment_3r.case.return`, `equipment_3r.case.assess`, `equipment_3r.disposition.complete`.
Target kinds: `equipment_3r_unit`, `equipment_3r_case`, `equipment_3r_disposition`.

## 4. Authz (deny-by-default PBAC)

Feature keys registered in `feature_catalog` by migration 0185; grants exist only through ACTIVE
custom roles (`policy_roles`/`policy_role_permissions`/`user_role_assignments`). New `Feature`
variants (platform/authz — integrator-flagged file):
`Equipment3rRegistry`→`equipment_3r_registry`, `Equipment3rQuote`→`equipment_3r_quote`,
`Equipment3rApprove`→`equipment_3r_approve`, `Equipment3rDispatch`→`equipment_3r_dispatch`,
`Equipment3rInspect`→`equipment_3r_inspect`, `Equipment3rAssess`→`equipment_3r_assess`,
`Equipment3rDisposition`→`equipment_3r_disposition`, `Equipment3rObserve`→`equipment_3r_observe`.
`allow()` helper: `BranchScope::All` → `authorize_org_wide`, else `authorize(p, action, branch)`
(logistics pattern). Deny-by-omission: cross-org objects 404 via RLS; unauthorized branch/grant 403.

## 5. DDL — migration `0185_create_equipment_3r.sql` (PROVISIONAL slot; head is 0180; integrator renumbers)

```sql
-- Bounded equipment 3R pilot. Deliberately independent of registry_equipment,
-- work orders, inventory, financial quotes, and finance-gl.
INSERT INTO feature_catalog (feature_key) VALUES
    ('equipment_3r_registry'), ('equipment_3r_quote'), ('equipment_3r_approve'),
    ('equipment_3r_dispatch'), ('equipment_3r_inspect'), ('equipment_3r_assess'),
    ('equipment_3r_disposition'), ('equipment_3r_observe')
ON CONFLICT (feature_key) DO NOTHING;

CREATE TABLE equipment_3r_units (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    branch_id UUID NOT NULL,
    serial_no TEXT NOT NULL CHECK (char_length(btrim(serial_no)) BETWEEN 1 AND 80),
    model_name TEXT NOT NULL CHECK (char_length(btrim(model_name)) BETWEEN 1 AND 120),
    capacity_class TEXT NOT NULL CHECK (char_length(btrim(capacity_class)) BETWEEN 1 AND 40),
    acquisition_cost_minor BIGINT NOT NULL CHECK (acquisition_cost_minor >= 0),
    availability TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (availability IN
        ('AVAILABLE','RESERVED','ON_RENT','IN_ASSESSMENT','IN_REPAIR','IN_REFURBISHMENT','FOR_SALE','SOLD')),
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (id, org_id), UNIQUE (org_id, serial_no),
    FOREIGN KEY (branch_id, org_id) REFERENCES branches(id, org_id) ON DELETE RESTRICT
);
CREATE TABLE equipment_3r_rental_cases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    branch_id UUID NOT NULL, unit_id UUID NOT NULL,
    customer_name TEXT NOT NULL CHECK (char_length(btrim(customer_name)) BETWEEN 1 AND 160),
    site_reference TEXT NOT NULL CHECK (char_length(btrim(site_reference)) BETWEEN 1 AND 200),
    monthly_rate_minor BIGINT NOT NULL CHECK (monthly_rate_minor > 0),
    duration_months INTEGER NOT NULL CHECK (duration_months BETWEEN 1 AND 120),
    currency_code TEXT NOT NULL CHECK (currency_code = 'KRW'),
    status TEXT NOT NULL DEFAULT 'QUOTED' CHECK (status IN
        ('QUOTED','APPROVED','DECLINED','DISPATCHED','HANDED_OVER','RETURNED','CLOSED')),
    approval_decision TEXT NULL CHECK (approval_decision IS NULL OR approval_decision IN ('APPROVED','DECLINED')),
    approval_reason TEXT NULL CHECK (approval_reason IS NULL OR char_length(btrim(approval_reason)) BETWEEN 1 AND 500),
    approved_by UUID NULL REFERENCES users(id) ON DELETE RESTRICT, approved_at TIMESTAMPTZ NULL,
    carrier_name TEXT NULL CHECK (carrier_name IS NULL OR char_length(btrim(carrier_name)) BETWEEN 1 AND 120),
    vehicle_reference TEXT NULL CHECK (vehicle_reference IS NULL OR char_length(btrim(vehicle_reference)) BETWEEN 1 AND 120),
    dispatched_at TIMESTAMPTZ NULL,
    recipient_name TEXT NULL CHECK (recipient_name IS NULL OR char_length(btrim(recipient_name)) BETWEEN 1 AND 160),
    handover_evidence_reference TEXT NULL CHECK (handover_evidence_reference IS NULL
        OR handover_evidence_reference ~ '^evidence://[A-Za-z0-9._/-]{8,400}$'),
    handed_over_at TIMESTAMPTZ NULL, returned_at TIMESTAMPTZ NULL,
    idempotency_key TEXT NOT NULL CHECK (char_length(btrim(idempotency_key)) BETWEEN 16 AND 200),
    request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (id, org_id), UNIQUE (org_id, idempotency_key),
    FOREIGN KEY (branch_id, org_id) REFERENCES branches(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (unit_id, org_id) REFERENCES equipment_3r_units(id, org_id) ON DELETE RESTRICT
);
CREATE INDEX idx_equipment_3r_cases_unit ON equipment_3r_rental_cases (org_id, unit_id, created_at DESC);
CREATE UNIQUE INDEX uq_equipment_3r_cases_active_unit ON equipment_3r_rental_cases (org_id, unit_id)
    WHERE status IN ('APPROVED','DISPATCHED','HANDED_OVER','RETURNED');
CREATE TABLE equipment_3r_inspections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    branch_id UUID NOT NULL, case_id UUID NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('PASS','MAINTENANCE_PERFORMED')),
    findings TEXT NOT NULL CHECK (char_length(btrim(findings)) BETWEEN 1 AND 2000),
    maintenance_note TEXT NULL CHECK (maintenance_note IS NULL OR char_length(btrim(maintenance_note)) BETWEEN 1 AND 2000),
    inspected_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    inspected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (id, org_id),
    FOREIGN KEY (branch_id, org_id) REFERENCES branches(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (case_id, org_id) REFERENCES equipment_3r_rental_cases(id, org_id) ON DELETE RESTRICT,
    CONSTRAINT maintenance_note_matches_outcome CHECK (
        (outcome = 'MAINTENANCE_PERFORMED') = (maintenance_note IS NOT NULL))
);
CREATE TABLE equipment_3r_return_assessments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    branch_id UUID NOT NULL, case_id UUID NOT NULL,
    condition_grade TEXT NOT NULL CHECK (condition_grade IN ('A','B','C','D')),
    findings TEXT NOT NULL CHECK (char_length(btrim(findings)) BETWEEN 1 AND 2000),
    disposition TEXT NOT NULL CHECK (disposition IN ('REPAIR','REFURBISH','RESALE','REDEPLOY')),
    assessed_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    assessed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (id, org_id), UNIQUE (org_id, case_id),
    FOREIGN KEY (branch_id, org_id) REFERENCES branches(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (case_id, org_id) REFERENCES equipment_3r_rental_cases(id, org_id) ON DELETE RESTRICT
);
CREATE TABLE equipment_3r_dispositions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    branch_id UUID NOT NULL, unit_id UUID NOT NULL, case_id UUID NOT NULL, assessment_id UUID NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('REPAIR','REFURBISH','RESALE','REDEPLOY')),
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','COMPLETED')),
    cost_minor BIGINT NULL CHECK (cost_minor IS NULL OR cost_minor >= 0),
    sale_amount_minor BIGINT NULL CHECK (sale_amount_minor IS NULL OR sale_amount_minor >= 0),
    buyer_name TEXT NULL CHECK (buyer_name IS NULL OR char_length(btrim(buyer_name)) BETWEEN 1 AND 160),
    completed_by UUID NULL REFERENCES users(id) ON DELETE RESTRICT, completed_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (id, org_id), UNIQUE (org_id, assessment_id),
    FOREIGN KEY (branch_id, org_id) REFERENCES branches(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (unit_id, org_id) REFERENCES equipment_3r_units(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (case_id, org_id) REFERENCES equipment_3r_rental_cases(id, org_id) ON DELETE RESTRICT,
    FOREIGN KEY (assessment_id, org_id) REFERENCES equipment_3r_return_assessments(id, org_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX uq_equipment_3r_dispositions_open_unit ON equipment_3r_dispositions (org_id, unit_id)
    WHERE status = 'OPEN';
CREATE TABLE equipment_3r_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT, branch_id UUID NOT NULL,
    aggregate_kind TEXT NOT NULL CHECK (aggregate_kind IN ('unit','case','disposition')),
    aggregate_id UUID NOT NULL, transition TEXT NOT NULL,
    actor_id UUID NOT NULL REFERENCES users(id), occurred_at TIMESTAMPTZ NOT NULL, trace_id UUID NOT NULL,
    UNIQUE (id, org_id), FOREIGN KEY (branch_id, org_id) REFERENCES branches(id, org_id) ON DELETE RESTRICT
);
CREATE INDEX idx_equipment_3r_history_aggregate ON equipment_3r_history (org_id, aggregate_id, occurred_at DESC);

-- RLS: every pilot object is tenant-concealed.
DO $$ DECLARE t TEXT; BEGIN FOREACH t IN ARRAY ARRAY['equipment_3r_units','equipment_3r_rental_cases',
 'equipment_3r_inspections','equipment_3r_return_assessments','equipment_3r_dispositions','equipment_3r_history'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
 EXECUTE format('CREATE POLICY org_isolation ON %I USING (org_id = NULLIF(current_setting(''app.current_org'', true), '''')::uuid) WITH CHECK (org_id = NULLIF(current_setting(''app.current_org'', true), '''')::uuid)', t);
 EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO mnt_rt', t);
 EXECUTE format('CREATE TRIGGER trg_%s_org_immutable BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION enforce_org_id_immutable()', t, t);
END LOOP; END $$;
CREATE OR REPLACE FUNCTION equipment_3r_terminal_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_TABLE_NAME = 'equipment_3r_units' AND OLD.availability = 'SOLD' AND NEW.availability <> OLD.availability
   THEN RAISE EXCEPTION 'sold equipment unit is immutable'; END IF;
 IF TG_TABLE_NAME = 'equipment_3r_rental_cases' AND OLD.status IN ('DECLINED','CLOSED') AND NEW.status <> OLD.status
   THEN RAISE EXCEPTION 'terminal rental case is immutable'; END IF;
 IF TG_TABLE_NAME = 'equipment_3r_dispositions' AND OLD.status = 'COMPLETED' AND NEW.status <> OLD.status
   THEN RAISE EXCEPTION 'completed disposition is immutable'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER trg_equipment_3r_units_terminal BEFORE UPDATE ON equipment_3r_units FOR EACH ROW EXECUTE FUNCTION equipment_3r_terminal_immutable();
CREATE TRIGGER trg_equipment_3r_cases_terminal BEFORE UPDATE ON equipment_3r_rental_cases FOR EACH ROW EXECUTE FUNCTION equipment_3r_terminal_immutable();
CREATE TRIGGER trg_equipment_3r_dispositions_terminal BEFORE UPDATE ON equipment_3r_dispositions FOR EACH ROW EXECUTE FUNCTION equipment_3r_terminal_immutable();
CREATE OR REPLACE FUNCTION equipment_3r_history_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'equipment 3R history is immutable'; END $$;
CREATE TRIGGER trg_equipment_3r_history_no_update BEFORE UPDATE OR DELETE ON equipment_3r_history FOR EACH ROW EXECUTE FUNCTION equipment_3r_history_append_only();
```

## 6. Build-stage obligations (backend)

- Crates: `backend/crates/equipment/{domain,application,adapter-postgres,rest}` — packages
  `mnt-equipment-domain/-application/-adapter-postgres/-rest` + BUCK files; workspace-member
  registration in the root `Cargo.toml`.
- Rest crate exports `EQUIPMENT_3R_ROUTE_PATHS: &[&str]` (all 14 paths with `{param}` syntax) and
  `router(state) -> Router` wrapped in `with_request_context`.
- Every mutation in `with_audits` returning `(json, Vec<AuditEvent>)`; history row per transition
  in the same transaction; `FOR UPDATE` + status-guarded UPDATE with `rows_affected` check.
- Tests `backend/app/tests/equipment_3r_api.rs` (mnt_rt pool, real JWT, oneshot router), minimum:
  1. Full lifecycle happy path quote→…→assessment(REPAIR)→completion with audit/history count asserts
     and `financeGlPosting: null` assert.
  2. Idempotent quote replay (`replayed: true`) + changed-fingerprint 409.
  3. PBAC denial (ungranted user 403), branch-scope widening 403, four-eyes approval 403.
  4. Concurrent approval of two quotes on one unit → exactly one 200, one 409 (`tokio::join!`).
  5. Cross-org concealment: second-org actor gets 404 for first-org unit/case (RLS as mnt_rt).
  6. RESALE branch: assessment(RESALE)→completion → unit SOLD; new quote on SOLD unit → 409.
- Verification commands (subagent can run cargo): `cargo build -p` each crate, `cargo fmt`,
  `cargo clippy -p <crates> -- -D warnings`, `cargo test -p mnt-equipment-domain`, and the
  app-level sqlx tests against a scratch DB (`MNT_POSTGRES_DB` convention; never dev-up down/up).
- Integrator manifests to emit under `docs/evidence/console/CAP-EQUIPMENT-3R-PILOT/`:
  `openapi-manifest.json` (14 operations, `tags: [equipment-3r]`, DTO schemas above),
  `authz-manifest.json` (8 Feature variants + `feature_catalog` keys),
  `app-mount-manifest.json` (router merge + route-path telemetry registration in `backend/app/src/lib.rs`)
  — the latter two because those files sit outside this lane's ownership roots.

## 7. Frontend contract notes (`/console/equipment`)

List/overview: unit list (chips = availability) + compact stat bar (counts per availability, no
KPI cards). Object detail: unit detail + active case pipeline + disposition; every noun (case,
inspection, assessment, disposition, branch) traversable. Action layer: the 9 mutations above,
rendered deny-by-omission from grant probes (403 → control absent, not disabled). History layer:
endpoint #4. Draft survival: quote form keeps `Idempotency-Key` in client state across
refresh/retry so resubmit replays instead of duplicating. Korean labels via ko.ts manifest
(integrator-owned): 가용/예약/임대중/반납평가/수리중/정비중/판매대기/매각 for the 8 availability states.
