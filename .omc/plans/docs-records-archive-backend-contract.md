# BE-DOCS Records Archive Backend Contract

Task: `t_90906f1d` / GitHub issue `#311` (`[backend-gap/B15a] Records-archive (DOCS) domain — IN- registration + records-manager approval`)

## Source and scope

Primary source refs inspected:

- `.omc/research/oyatie/prototype-anatomy/02-screens/docs-policy-inbox-audit.md` — DOCS UI fields and interactions: `code`, `title`, `type`, `who`, `closed`/`종결일`, `keep`/retention label, filters, search, and the missing row-open view audit.
- `.omc/research/oyatie/prototype-anatomy/04-backend-contract.md` — gap register #15: records archive + EV split; records archive must reuse lifecycle `/hold` for `legal_hold`/`retention_until`.
- `.omc/research/oyatie/prototype-anatomy/05-post-snapshot-todo-digest.md` — registration UX: file drop + title/type/retention/reason -> `IN-` pending -> records-manager approval.
- `origin/main:backend/app/src/lifecycle.rs` and `origin/main:backend/crates/platform/db/src/lifecycle.rs` — existing BE-LC `/api/v1/lifecycles/{objectType}/{objectId}` + `/transition` + `/hold` substrate.
- `origin/main:backend/crates/platform/db/migrations/0107_create_period_locks_versioning_lifecycle.sql` — `object_lifecycles` owns `legal_hold` and `retention_until`; lifecycle transitions are append-only and RLS-protected.

In scope for B15a:

- Tenant-scoped records archive catalog for DOCS rows.
- `IN-` registration submission and records-manager approval before a record becomes active.
- Filterable list/detail API and audited detail/open/export reads.
- Persistence and RLS contract for records and approval decisions.
- OpenAPI/client impact.

Out of scope for B15a:

- Evidence EV- object model (`EV-`, TSA, WORM original/derivative, chain-of-custody, admissibility). That stays B15b and may link to records later.
- Signed append-only export implementation beyond the API/audit contract for export requests.
- Building a new retention/hold table. Retention/legal hold must live in BE-LC `object_lifecycles`.

## Existing substrate to reuse

Use the existing lifecycle stack, not a records-local lifecycle mechanism:

- HTTP substrate: `GET /api/v1/lifecycles/{objectType}/{objectId}`, `POST /transition`, `POST /hold`.
- DB substrate: `object_lifecycles(org_id, object_type, object_id, current_state, legal_hold, retention_until)` and append-only `object_lifecycle_transitions`.
- Enforcement: transition to `disposed` fails while `legal_hold = true` or `retention_until > today`.
- Audit: lifecycle REST already emits `lifecycle.transition` and `lifecycle.hold_set` audit events.

BE-DOCS should seed lifecycle rules for its own object type instead of creating local state columns for hold/retention:

- `object_type = 'record_document'`
- Valid lifecycle states:
  - `draft` — server-created transient initial state.
  - `submitted` — `IN-` registration is awaiting records-manager review.
  - `active` — records-manager approved; row is visible in the normal archive.
  - `rejected` — records-manager rejected; visible only to submitter/records managers.
  - `revised` — active record has a metadata/content revision pending approval.
  - `archived` — retained but no longer operationally active.
  - `disposed` — terminal destruction/disposal record, only after BE-LC hold/retention gate allows it.
- Valid transitions to seed in `lifecycle_transition_rules`:
  - `draft -> submitted`
  - `submitted -> active`
  - `submitted -> rejected`
  - `rejected -> submitted`
  - `active -> revised`
  - `revised -> submitted`
  - `active -> archived`
  - `archived -> disposed`

The DOCS list/detail API joins lifecycle state and hold fields from `object_lifecycles`. It must not add `legal_hold`, `retention_until`, or lifecycle-state columns to the records table as a second source of truth.

## Domain entities

### Record

A `docs_records` row is the archive catalog entry shown by DOCS.

Required fields:

- `id: uuid` — primary key; add `DocsRecordId` to `mnt_kernel_core::ids`.
- `org_id: uuid` — tenant scope from the authenticated principal, never request body.
- `branch_id: uuid | null` — concrete branch scope when applicable; `null` means org-wide and requires org-wide read/manage authority.
- `code: text` — visible archive code. It may be a source-object code (`AP-`, `JL-`, `NT-`, `C-`) or the generated `IN-` registration code when the record is born from a registration. Unique per org.
- `registration_code: text` — generated `IN-` code for this registration flow. Unique per org. For imported historical rows, generate an `IN-` code anyway so approval/audit has a stable registration handle.
- `record_type: text` — enum-like DB text for UI filter values: `approval`, `notice`, `journal`, `contract`, `intake`, `policy`, `other`. The REST DTO exposes both this machine value and a Korean label.
- `title: text` — 1..200 chars after trim.
- `owner_user_id: uuid | null` — 작성/담당 person where known.
- `source_object_type: text | null` and `source_object_id: uuid | null` — optional upstream object link; both set or both null.
- `closed_on: date | null` — `종결일`. Required before a record can move to `archived`; allowed null for pending registrations and still-open source objects.
- `retention_label: text` — machine retention key (`3y`, `5y`, `10y`, `permanent`, or tenant policy key). This is the label/policy selector, not the enforcement deadline.
- `retention_label_display: text` may be computed in Rust/client from `retention_label`; do not duplicate unless the project already has a localization table.
- `file_ref: jsonb | null` — optional lightweight uploaded-document pointer for registration UX. Keep it metadata only (`object_store_key`, `filename`, `content_type`, `size_bytes`, `sha256` if already available). Do not implement EV/TSA/WORM custody here.
- `submitted_by`, `submitted_at` — creator of the registration.
- `approved_by`, `approved_at`, `rejected_by`, `rejected_at` — denormalized decision pointers for fast list/filter; lifecycle current state remains authoritative for active/rejected.
- `created_at`, `updated_at`.

DB constraints and indexes:

- `UNIQUE (id, org_id)`
- `UNIQUE (org_id, code)`
- `UNIQUE (org_id, registration_code)`
- `CHECK (code ~ '^[A-Z]{2,4}-[A-Z0-9-]{3,40}$')`
- `CHECK (registration_code ~ '^IN-[A-Z0-9-]{3,40}$')`
- `CHECK (record_type IN (...))`
- `CHECK (retention_label ~ '^[a-z0-9][a-z0-9_.-]{1,63}$')`
- `CHECK ((source_object_type IS NULL AND source_object_id IS NULL) OR (source_object_type IS NOT NULL AND source_object_id IS NOT NULL))`
- `CHECK (jsonb_typeof(file_ref) = 'object')` when non-null.
- Index `(org_id, record_type, updated_at desc)`, `(org_id, code)`, `(org_id, closed_on desc)`, `(org_id, retention_label)`, `(org_id, owner_user_id)`, and `(org_id, branch_id, updated_at desc)`.

### Registration decision ledger

`docs_record_registration_decisions` is append-only approval evidence.

Fields:

- `id: uuid` — add `DocsRecordDecisionId` typed id if Rust callers need it.
- `org_id: uuid`
- `record_id: uuid`
- `registration_round: integer` — starts at 1; increments for resubmission/revision.
- `decision: text` — `APPROVED` or `REJECTED`.
- `memo: text` — required for `REJECTED`, optional for `APPROVED`, max 2000 chars.
- `decided_by: uuid`
- `decided_at: timestamptz`
- `before_state: text`
- `after_state: text`
- `workflow_task_id: uuid | null` — optional pointer if the implementation uses `workflow_waiting_tasks` for inbox/approval queue fan-out.

DB constraints:

- FK `(record_id, org_id) -> docs_records(id, org_id)`.
- FK `(decided_by, org_id) -> users(id, org_id)`.
- Append-only trigger: no UPDATE/DELETE except platform force-remove test cleanup if that project convention requires it.
- Unique `(org_id, record_id, registration_round, decision)` or stricter unique `(org_id, record_id, registration_round)` if only one terminal decision per round is allowed.

## API surface

All endpoints are under `/api/v1/docs/records` and mounted through request-context middleware so `Extension<Principal>` is available and `app.current_org` is armed by `with_org_conn`/`with_audit`/`with_audits`.

### List records

`GET /api/v1/docs/records`

Query filters:

- `q` — substring/prefix search across `code`, `registration_code`, `title`, owner display name when joined, and source object text.
- `type` — machine `record_type`.
- `state` — lifecycle `current_state`; default for ordinary archive view is `active,archived`; records managers may request `submitted,rejected,revised`.
- `codePrefix` — `AP`, `JL`, `NT`, `C`, `IN`, etc.
- `retentionLabel`
- `legalHold: boolean`
- `retentionUntilBefore`, `retentionUntilAfter` — joined from lifecycle.
- `closedFrom`, `closedTo` — `closed_on` range.
- `ownerUserId`
- `branchId` — must be allowed by `principal.branch_scope`; omitted means all visible branches, not all tenant rows unless org-wide.
- `limit` and `offset` — max 100, default 50.

Response shape:

- `items[]` with `id`, `code`, `registrationCode`, `title`, `type`, `typeLabel`, `owner`, `closedOn`, `retentionLabel`, `retentionLabelDisplay`, `lifecycleState`, `legalHold`, `retentionUntil`, `branchId`, `sourceObject`, `updatedAt`.
- `total`, `limit`, `offset`.
- Optional `summary` for DOCS stat bar: `totalRecords`, `closedThisMonth`, `retentionExpiringSoon`.

Read contract:

- Use `with_org_conn(pool, principal.org_id, ...)`.
- Enforce deny-by-omission in SQL: join lifecycle on `(org_id, 'record_document', record.id)` and add branch-scope predicate before materializing rows.
- Do not audit each list result as a view. Audit detail/open/export, not ordinary list rendering.

### Create/submit an IN registration

`POST /api/v1/docs/records/registrations`

Request:

- `title`
- `recordType`
- `retentionLabel`
- `closedOn: date | null`
- `reason`
- `branchId: uuid | null`
- `ownerUserId: uuid | null`
- `sourceObjectType/sourceObjectId` optional pair
- `fileRef` optional metadata object
- `idempotencyKey` required when the client is submitting an upload-backed registration.

Server behavior:

1. Authorize the submitter with `Feature::RecordsArchiveRegister` (request/limited cells are acceptable if the matrix adds them).
2. Derive `org_id` from `principal.org_id` and validate branch scope from `principal.branch_scope`; never accept org from the client.
3. Generate `registration_code` with `IN-` prefix. `code` defaults to `registration_code` unless the request references a source object with a canonical code that the server resolves.
4. Insert `docs_records` row in a `with_audits` transaction.
5. In the same transaction call `lifecycle_db::transition_lifecycle(org_id, 'record_document', record_id, 'submitted', actor, reason, today)` to materialize lifecycle state through the BE-LC table.
6. Optionally create a `workflow_waiting_tasks` row assigned to `assignee_role_key = 'records.manager'` or `required_policy = 'records_archive_approve'`. This is queue UX only; authorization still checks server-side feature grants on decision.
7. Emit audit event `docs_record.register` with target type `docs_record`, target id `record_id`, org/branch set, and after snapshot containing `code`, `registration_code`, `record_type`, `retention_label`, `closed_on`, `source_object`, and `lifecycle_state: submitted`.

Response: `201 Created` with the same detail DTO as `GET /{id}`.

### Get/open record detail

`GET /api/v1/docs/records/{recordId}`

Behavior:

- Authorize `Feature::RecordsArchiveRead` and branch visibility. If the id exists but is outside the principal's visible branch/scope, return `404` or the project-standard deny-by-omission response; do not leak existence.
- Use `with_audit`, not plain `with_org_conn`, so every detail/open is recorded as a read event.
- Audit action: `docs_record.view`.
- Audit target: `target_type = 'docs_record'`, `target_id = record_id`.
- Audit after snapshot should be redacted metadata only: `code`, `record_type`, `classification`, `lifecycle_state`, `legal_hold`, `retention_until`; never raw document contents or secret file URLs.

Response adds detail-only fields: file metadata, registration/decision timeline, lifecycle transitions, source object link, audit route hint for correlated events.

### Decide registration

`POST /api/v1/docs/records/{recordId}/approval-decisions`

Request:

- `decision: APPROVE | REJECT`
- `memo: string | null` (required for reject)
- `workflowTaskId: uuid | null`

Behavior:

1. Authorize `Feature::RecordsArchiveApprove`. A tenant custom role named records-manager may grant this; do not trust a role label from the request.
2. Fetch record + lifecycle `FOR UPDATE` inside `with_audits`.
3. Require current lifecycle state `submitted` or `revised`; otherwise return `409 invalid_transition`.
4. Separation of duties: reject approval when `principal.user_id == submitted_by` unless the product explicitly grants a break-glass feature and records an override reason. Default: no self-approval.
5. `APPROVE`:
   - append decision row (`APPROVED`).
   - update `approved_by/approved_at`, clear rejected pointers for that round if applicable.
   - call `lifecycle_db::transition_lifecycle(..., 'active', actor, memo_or_default, today)`.
   - compute `retention_until` from `(closed_on, retention_label)` where possible and call `lifecycle_db::set_lifecycle_hold(... legal_hold = false, retention_until = computed)` in the same DB transaction. For `permanent`, set `retention_until = null` and expose `retentionLabel = permanent`; do not fake a far-future date.
6. `REJECT`:
   - append decision row (`REJECTED`).
   - update `rejected_by/rejected_at`.
   - transition lifecycle to `rejected`.
7. Complete/cancel the optional `workflow_waiting_tasks` row only after the above state change succeeds.
8. Emit audit events in the same transaction:
   - `docs_record.approve` or `docs_record.reject` on `docs_record`.
   - lifecycle/hold events as separate audit events if using `with_audits` directly; if calling only the DB lifecycle helpers, the BE-DOCS layer must still emit equivalent `lifecycle.transition` / `lifecycle.hold_set` events so the generic audit timeline remains complete.

Response: updated detail DTO.

### Update metadata / resubmit

`PATCH /api/v1/docs/records/{recordId}`

Allowed only for `submitted`, `rejected`, or `revised` states unless the caller holds manage authority and provides a revision reason.

Mutable fields:

- `title`
- `recordType`
- `ownerUserId`
- `branchId` within caller scope
- `closedOn`
- `retentionLabel`
- `sourceObjectType/sourceObjectId`
- `fileRef`

Behavior:

- Mutations are audited with `docs_record.update_metadata`.
- If a rejected record is resubmitted, use a dedicated endpoint or `PATCH` flag to transition `rejected -> submitted`, increment `registration_round`, and emit `docs_record.resubmit`.
- If an active record is materially changed, transition `active -> revised`; resubmission/approval must return it to `active`.

### Lifecycle / hold / retention

Do not add `POST /api/v1/docs/records/{id}/hold` unless product later needs a domain-shaped proxy. The canonical hold endpoint is:

`POST /api/v1/lifecycles/record_document/{recordId}/hold`

Request follows BE-LC:

- `legalHold: boolean`
- `retentionUntil: YYYY-MM-DD | null`

Behavior:

- Authorized by `Feature::LifecycleManage` today. A records-manager custom role should receive this grant together with `records_archive_approve`.
- The DOCS detail/list API reflects the resulting `legalHold` and `retentionUntil` by joining `object_lifecycles`.
- Disposal/archive endpoints must use lifecycle transition and let BE-LC reject `archived -> disposed` while hold/retention blocks it.

### Export

`POST /api/v1/docs/records/export-requests`

This can land as an audit-only stub in B15a if signed export itself is B15 follow-up.

Request: same filters as list, plus `format`.

Behavior:

- Authorize `Feature::RecordsArchiveExport` or reuse `ExcelDownload` only if product accepts that broader permission; records export is compliance-sensitive, so a dedicated feature is preferred.
- Emit `docs_record.export_request` with filter snapshot and count.
- Return `202 Accepted` with a job/request id if async; otherwise `501/not_implemented` should still be audited only if the request reached an authorized intent boundary.

## Authorization and feature catalog

Add feature keys in the BE-DOCS migration and `Feature` enum:

- `records_archive_read`
- `records_archive_register`
- `records_archive_approve`
- `records_archive_export`

Suggested built-in matrix until custom roles mature:

- Read: ADMIN, EXECUTIVE, SUPER_ADMIN. Optional limited branch-scoped read for RECEPTIONIST if product wants front-office filing search.
- Register: RECEPTIONIST, ADMIN, EXECUTIVE, SUPER_ADMIN; MECHANIC denied by default.
- Approve/manage: ADMIN and SUPER_ADMIN. EXECUTIVE read-only unless policy says executives are records managers.
- Export: ADMIN and SUPER_ADMIN, or EXECUTIVE only with an explicit product decision.

Records-manager is a product role, not a trusted client input. Implement it as either:

- built-in ADMIN/SUPER_ADMIN for the first slice, or
- tenant custom-role grants for `records_archive_approve` + `lifecycle_manage` + necessary read/export permissions.

Every handler must still validate feature + branch/org scope server-side.

## RLS / tenant isolation contract

Migrations must follow the existing runtime-role pattern:

- `ALTER TABLE docs_records ENABLE ROW LEVEL SECURITY;`
- `ALTER TABLE docs_records FORCE ROW LEVEL SECURITY;`
- `CREATE POLICY org_isolation ... org_id = NULLIF(current_setting('app.current_org', true), '')::uuid`
- Same for `docs_record_registration_decisions`.
- Grant only required privileges to `mnt_rt`: `SELECT, INSERT, UPDATE` on `docs_records`; `SELECT, INSERT` on append-only decisions.
- Add `enforce_org_id_immutable()` triggers to mutable tables.
- Add append-only triggers to decision ledger.
- Do not grant DELETE to `mnt_rt`.
- Add force-remove cleanup only if platform tenant-removal tests require it, and keep that cleanup behind the existing platform-owned SECURITY DEFINER path.

Runtime rules:

- Reads use `with_org_conn(pool, principal.org_id, ...)` except audited detail/export reads, which use `with_audit` with `.with_org(principal.org_id)`.
- Mutations use `with_audit` or `with_audits`; no mutation may open a raw transaction without setting `app.current_org`.
- SQL filters must apply branch/owner visibility before rows are returned.
- Cross-tenant tests must use the real `mnt_rt` runtime role; superuser/BYPASSRLS tests are not evidence.

## Audit events

Required action names:

- `docs_record.register`
- `docs_record.view`
- `docs_record.update_metadata`
- `docs_record.resubmit`
- `docs_record.approve`
- `docs_record.reject`
- `docs_record.export_request`
- Existing lifecycle events: `lifecycle.transition`, `lifecycle.hold_set`

Audit target conventions:

- `target_type = 'docs_record'` for record actions.
- `target_id = record_id.to_string()`.
- `branch_id` set when record is branch-scoped; omitted only for org-wide records.
- `org_id` always set for tenant records.
- Snapshots redact raw content and signed URLs. Keep metadata: code, registration code, type, title, lifecycle state, retention label, legal hold, retention until, source object pointer, and decision result.

View audit:

- `GET /api/v1/docs/records/{id}` must create `docs_record.view`.
- Download/export/open-file should create distinct audit events if implemented later.
- List queries should not log one event per row; that would be noisy and does not satisfy the UX's row-open audit promise.

## OpenAPI / client impact

OpenAPI additions:

- Paths under `/api/v1/docs/records` and `/api/v1/docs/records/...` listed above.
- Schemas:
  - `DocsRecordSummary`
  - `DocsRecordDetail`
  - `DocsRecordPage`
  - `CreateDocsRecordRegistrationRequest`
  - `UpdateDocsRecordRequest`
  - `DecideDocsRecordRegistrationRequest`
  - `DocsRecordDecision`
  - `DocsRecordLifecycleSnapshot`
  - `DocsRecordExportRequest`
- Query enum schemas for `DocsRecordType`, `DocsRecordLifecycleState`, and `RetentionLabel` if labels are fixed for v1.

Client regeneration:

- Any `backend/openapi/openapi.yaml` edit requires regenerating all clients through the repo's standard API generation (`npm run gen:api`) and checking TS/Kotlin/Swift outputs.
- Do not create a console-private client fork. The console imports the shared generated API client.

## Implementation shape

Recommended crates:

- `backend/crates/docs/domain` — pure enums/value objects and lifecycle state helpers; no sqlx/authz.
- `backend/crates/docs/application` — DTOs, commands, query structs, audit-event builders.
- `backend/crates/docs/adapter-postgres` — SQL persistence, RLS-scoped queries, lifecycle helper calls, audit-wrapped mutations.
- `backend/crates/docs/rest` — Axum router, authz, request normalization, OpenAPI-facing DTOs.

Integration:

- Add typed IDs to `backend/crates/kernel/core/src/ids.rs`.
- Add features to `backend/crates/platform/authz/src/lib.rs`, tests, and `feature_catalog` seed.
- Add migration for docs tables and lifecycle rules. Claim the next free migration number immediately before implementation merge to avoid collisions.
- Mount the router in `backend/app/src/lib.rs` alongside other tenant domain routers.

Layer-boundary rule:

- Domain/application must not depend on other domain crates.
- If records need to resolve source object display codes, do that in adapter/application integration through allowed platform/kernel interfaces or store the source code as a denormalized string supplied by an allowed caller.

## Required tests and gates

Focused tests:

1. Migration/RLS:
   - `mnt_rt` with `app.current_org` set can read/write only its org.
   - `mnt_rt` with GUC unset sees zero tenant rows and cannot insert.
   - org A cannot see org B record or decision rows.
   - decision ledger rejects UPDATE/DELETE.
2. Registration flow:
   - create registration returns `IN-` code and lifecycle `submitted`, not `active`.
   - default archive list excludes pending rows for non-manager personas.
   - self-approval is rejected.
   - records manager approval transitions to `active`, appends decision, emits audit, and sets lifecycle retention deadline from label/closed date.
   - rejection transitions to `rejected`, requires memo, and does not make record active.
3. View audit:
   - detail/open emits `docs_record.view` under `mnt_rt` with org id and redacted snapshot.
   - unauthorized detail returns deny-by-omission and emits no misleading view audit.
4. Retention/legal hold:
   - generic `/api/v1/lifecycles/record_document/{id}/hold` sets `legal_hold`/`retention_until` in `object_lifecycles`.
   - `archived -> disposed` is refused while legal hold is true or retention date is in the future.
   - no `docs_records.legal_hold` or `docs_records.retention_until` column exists.
5. Filters:
   - type, code prefix, q, closed date, retention label, lifecycle state, legal hold, retention-until ranges, owner, and branch filters work under branch-scope deny-by-omission.

Gates to run from `backend/` or with `--manifest-path backend/Cargo.toml`:

- `SQLX_OFFLINE=true cargo test -p <docs-crates> ...` for focused unit/integration tests.
- Runtime-role DB tests that actually connect as `mnt_rt`.
- `cargo run -p mnt-gate-tenant-isolation --offline`
- `cargo run -p mnt-gate-rls-arming --offline`
- `cargo run -p mnt-gate-audit-coverage --offline`
- `cargo run -p mnt-gate-migration-safety --offline`
- `cargo run -p mnt-gate-layer-boundary --offline`
- OpenAPI drift/client generation checks after route schemas land.

## Acceptance checklist for downstream implementation

- Records archive table exists and stores `code`, `record_type`, `retention_label`, `closed_on`/`종결일`, owner/source metadata, and registration metadata.
- `legal_hold` and `retention_until` are read from `object_lifecycles` through `object_type = 'record_document'`; no parallel docs hold table/columns exist.
- `IN-` registration is submitted to lifecycle `submitted`; records-manager approval is required before lifecycle `active`.
- Approval/rejection decisions are durable, audited, SoD-protected, and RLS scoped.
- Detail/open view writes `docs_record.view` audit rows; list does not spam row-view audits.
- Reads and writes derive org from principal and enforce branch/tenant deny-by-omission.
- All mutations run through `with_audit`/`with_audits`; all read queries run through `with_org_conn` unless intentionally audited.
- FORCE RLS + `mnt_rt` tests prove tenant isolation.
- OpenAPI and all generated clients are updated through the shared generation path.
