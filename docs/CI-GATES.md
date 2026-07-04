# CI Gates

Every change to this repository is held to a fixed set of automated gates, run
in `.github/workflows/ci.yml` and reproducible locally. The gates encode the
project's non-negotiable invariants (clean-architecture layering, audit-first
discipline, 위치정보법/PIPA data handling, cross-client contract and parity) so
that a violation fails the build rather than reaching production.

A change is not "done" until **every** gate below passes from a fresh run. This
mirrors the lead's merge protocol: each merged surface is independently
re-verified (fmt, clippy, tests, the four Rust gates, and — when client-facing
surfaces move — the drift/parity/contract gates) before it lands on `main`.

## Review evidence gate

For user-facing features, PR/review evidence must prove the shipped workflow, not
just the transport seam. API endpoint tests, handler tests, or generated-client
round trips are necessary contract evidence, but they are **not sufficient** for
UI feature claims. When UI is involved, reviewers must require browser/E2E or
equivalent real-surface proof that walks the user story: sign-up, organization
onboarding, passkey setup, and the actual domain workflow.

The product guardrail is CRUD-first SaaS: database-backed create/read/update/
delete UI and normal editing workflows come before upload/import/Excel paths.
Upload/import/build requests from non-technical staff are product inputs, not
product authority; reviewers should reframe or reject them when they weaken SaaS
maturity or bypass first-class CRUD workflows.

## How to run the full suite locally

```bash
# Backend (from backend/)
cargo fmt --all -- --check
SQLX_OFFLINE=true cargo clippy --all-targets -- -D warnings
DATABASE_URL=postgres://<user>@localhost/mnt_dev cargo test --workspace
for g in layer-boundary audit-coverage migration-safety pii-no-logs; do
  cargo run -q -p mnt-gate-$g            # each must exit 0
done

# Cross-client contract + parity (from repo root)
npm run check:ts && npm run check:kotlin && npm run check:swift
npm run check:api-drift:portable          # regenerate ts+kotlin, expect no diff
npm run check:api-drift:swift             # regenerate swift, expect no diff
npm run check:openapi-app                 # committed openapi.yaml covers mounted routes
npm run test:contract                     # generated TS client <-> app round-trip
node scripts/check-i18n.mjs               # web/Android/iOS UI string-key parity

# Mobile build/behavior
( cd android && ./gradlew :app:testDebugUnitTest :app:assembleDebug )
swift build --package-path ios && swift run --package-path ios MaintenanceFieldCoreBehaviorTests
```

`SQLX_OFFLINE=true` uses the committed `.sqlx/` query cache; regenerate it with
`cargo sqlx prepare --workspace -- --all-targets` (note `--all-targets`, so test
queries are cached too) against a database migrated to head.

---

## Backend gates

### 1. `rustfmt` — formatting

`cargo fmt --all -- --check`. Zero diff required.

### 2. `clippy -D warnings` — lint + compile

`SQLX_OFFLINE=true cargo clippy --all-targets -- -D warnings`. **Every** warning
is an error, including in tests and benches. This also doubles as the offline
compile check (it fails if the `.sqlx` cache is stale or a query is malformed).

### 3. `cargo test` — workspace tests

The full workspace suite, including the DB-backed integration tests under
`backend/app/tests/` and per-crate `tests/`. Requires a `DATABASE_URL` pointing
at a Postgres database migrated to head (the suite is isolation-safe: tests key
on fresh UUIDs and do not assert on global counts, so they run in parallel).

### 4. `mnt-gate-layer-boundary` — clean-architecture + manifest hygiene

Source: `backend/ci/gates/layer-boundary/`. Enforces the dependency direction
([ADR-0001](decisions/ADR-0001-modularmonolith-cargo-workspace-with-compilerenforced-cleanarchitecture.md)):

```
kernel      → (nothing)
domain      → kernel
application → domain, kernel
adapter/platform → application, domain, kernel
rest/worker → adapter, platform, application, domain, kernel
app         → everything
```

Plus:
- **Purity:** `domain` and `application` crates may not depend on `sqlx`, `axum`,
  or `tokio` (no I/O in the pure core).
- **Manifest hygiene:** every workspace crate name starts with `mnt-`, uses
  `edition.workspace = true`, inherits `publish = false`, and carries
  `[lints] workspace = true`.
- **Conflict-marker scan:** rejects any git-tracked file containing unresolved
  merge markers (`<<<<<<<`, `=======`, `>>>>>>>`). Added after MFL-0001
  (a merge commit shipped with unresolved markers); see
  [MISTAKES-LEDGER.md](MISTAKES-LEDGER.md).

### 5. `mnt-gate-audit-coverage` — audit-first discipline

Source: `backend/ci/gates/audit-coverage/`. Every state-changing handler marked
`// mnt-gate: state-changing-handler` must construct an `AuditEvent` and route
its mutation through `with_audit` / `with_audits` / `insert_audit_event`, so the
audit row is written in the **same transaction** as the mutation
([ADR-0002](decisions/ADR-0002-auditfirst-transactional-discipline-audit-event-in.md)).

The **sole** carve-out is LocationPing ingestion: raw GPS coordinates must remain
destructible and must never enter `audit_events`
([ADR-0014](decisions/ADR-0014-locationping-destructible-store-carved-out-of.md),
위치정보법). That exemption is **path-bound** to the
single real writer (`crates/compliance/adapter-postgres/src/lib.rs ::
record_location_ping`) — the same exemption reason on any other file/function is
rejected. (Path binding was hardened in `fix/harden-1`; previously the exemption
matched on reason only, which could silently apply to the wrong handler — see
[review/security-compliance.md](../.omc/review/security-compliance.md).)

### 6. `mnt-gate-migration-safety` — append-only audit trail

Source: `backend/ci/gates/migration-safety/`. Migrations are append-only and may
not erode the audit trail. It rejects:
- `DROP TABLE` on an audited table,
- `ALTER TABLE … DROP COLUMN` on an audited table,
- `GRANT UPDATE`/`GRANT DELETE` on `audit_events`,
- `DISABLE TRIGGER` on `audit_events`.

The append-only protection on `audit_events` (REVOKE UPDATE/DELETE + trigger) is
thus immune to being silently undone by a later migration.

### 7. `mnt-gate-pii-no-logs` — PIPA log hygiene

Source: `backend/ci/gates/pii-no-logs/`. Scans the bodies of logging macros
(`info!`/`debug!`/`warn!`/`error!`/etc.) and rejects:
- Korean mobile phone-number patterns,
- GPS coordinate pairs (two plausible lat/long floats together),
- resident-registration-number (주민등록번호) patterns.

PII/location data may be persisted (audited or destructible per policy) but must
never be written to logs.

---

## Cross-client contract gates

The backend serves the committed `backend/openapi/openapi.yaml`; the TypeScript,
Kotlin, and Swift clients are **generated** from it. These gates keep the three
clients and the spec in lockstep.

### 8. Generated-client drift — `check:api-drift:portable` / `:swift`

Regenerates the clients from `openapi.yaml` and runs `git diff --exit-code`. Any
drift between the committed generated code and a fresh regeneration fails. (Hand-
editing generated client files therefore fails the gate — regenerate instead.)
`check:ts` / `check:kotlin` / `check:swift` additionally compile each client.

### 9. `check:openapi-app` — spec covers mounted routes

`node scripts/check-openapi-app.mjs` asserts the committed `openapi.yaml`
documents every route actually mounted by the app (each REST crate exports its
`*_ROUTE_PATHS`; `backend/app/tests/openapi_drift.rs` asserts the served YAML
contains them). Prevents an unowned/undocumented HTTP surface (MFL-0002).

### 10. `test:contract` — generated client ↔ app round-trip

`npm run test:contract` exercises the generated TS client against the running app
to confirm request/response shapes round-trip against the real handlers (needs
`CONTRACT_DATABASE_URL`).

---

## Mobile parity gates

### 11. `check-i18n.mjs` — UI string-key parity

`node scripts/check-i18n.mjs` checks that web, Android, and iOS UI string keys
are present and consistent across the three clients (no missing/orphaned keys for
shared surfaces).

### 12. Parity checklist — feature parity

Validates `docs/parity-checklist.md`: each shipped feature row names its Android
target, its iOS implementation, and the evidence commands that prove parity
([ADR-0009](decisions/ADR-0009-dualnative-swiftkotlin-parity-strategy-via-single.md)).

### 13. iOS app — build + behavior tests

`swift build` (full app) plus `swift run MaintenanceFieldCoreBehaviorTests`, the
parity behavior runner that mirrors the Android unit-test assertions for shared
domain logic (consent state machine, messenger reducer, sync, etc.).

---

## Notes

- The four `mnt-gate-*` binaries exit non-zero on the first violation with a
  `file:detail` message; run an individual gate locally to see what it caught.
- When a change touches OpenAPI routes/schemas, the contract gates (8–10) and the
  client builds must all be re-run; a backend-only internal change (e.g. the
  hardening fixes) does not move the clients and only needs gates 1–7.
- Gate provenance and the incidents that motivated several checks are recorded in
  [MISTAKES-LEDGER.md](MISTAKES-LEDGER.md).
