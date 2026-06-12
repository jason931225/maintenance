# M0 Wave 1 — worker briefs (base commit a1becca)

Read FIRST: your task's row in `/Users/jasonlee/Developer/maintenance/.omc/plans/fsm-maintenance-plan.md` (+ architecture §2) and the spec `/Users/jasonlee/Developer/maintenance/.omc/specs/deep-interview-fsm-maintenance.md`. Rust workspace: `backend/` (stable 1.96 pinned).

## Hard rules (every worker)
- Production-grade only — no mocks, stubs, demo modes, or placeholder logic.
- Verify latest crate versions LIVE via crates.io API before `cargo add` (needs a User-Agent header: `curl -s -A "mnt-fsm-build" https://crates.io/api/v1/crates/<name>`).
- Reuse `mnt-kernel-core` types (read `backend/crates/kernel/core/src/`) and `mnt-platform-db::with_audit`. Do not duplicate kernel types.
- PostgreSQL is **18.4** (local: `postgres://jasonlee@localhost/mnt_dev`, migrations already applied). Production images must pin Postgres 18.x.
- Before finishing, run from `backend/` and require ALL green:
  1. `cargo fmt --all` then `cargo fmt --all -- --check`
  2. sqlx users: `DATABASE_URL=postgres://jasonlee@localhost/mnt_dev cargo sqlx prepare --workspace -- --all-targets` and commit `.sqlx/`
  3. `cargo clippy --all-targets` (zero warnings, offline)
  4. `DATABASE_URL=postgres://jasonlee@localhost/mnt_dev cargo test`
  5. `cargo run -q -p mnt-gate-layer-boundary` (exit 0)
- Commit in YOUR worktree branch with verification evidence in the message + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- New migrations: claim the next free number prefix in `backend/crates/platform/db/migrations/` per your subtask below (numbers pre-assigned to avoid collisions).

## Subtask assignment: worker-N takes subtask N

### 1. T0.4 — three CI gate binaries (`backend/ci/gates/`)
- `mnt-gate-audit-coverage`: every state-changing handler in the workspace emits an AuditEvent via `with_audit`; the exclusion set contains EXACTLY the LocationPing ingestion path; a test asserts it is the ONLY exclusion; red/green fixture test (follow `mnt-gate-layer-boundary`'s lib+thin-main+temp-workspace-fixture pattern).
- `mnt-gate-migration-safety`: rejects DROP TABLE/COLUMN on audited tables, and any GRANT UPDATE/DELETE or DISABLE TRIGGER touching `audit_events`, in any migration file; fixture tests.
- `mnt-gate-pii-no-logs`: flags Korean phone numbers (010-XXXX-XXXX), GPS coordinate pairs, and 주민등록번호 patterns inside `tracing`/`log` macro call sites; fixture tests.
- Wire all three into `.github/workflows/ci.yml` after the layer gate.

### 2. T0.5 — `backend/crates/platform/auth` (`mnt-platform-auth`)
- webauthn-rs passkey registration + login ceremonies (server side; verify webauthn-rs current version live; ceremony state persisted, not in-memory).
- JWT ES256 access tokens (jsonwebtoken v10.x — verify exact version live; pick the crypto backend explicitly).
- Opaque rotating refresh tokens hashed in Postgres: family tracking, rotation-on-use, reuse-detection → whole-family revocation. Migration number **0004**. `#[sqlx::test]` proves rotation + reuse-revocation.
- AASA + assetlinks.json serving design (static, documented; actual domain config is a later ops step).
- Prefer an integration test using `webauthn-authenticator-rs` soft token if available; else thorough ceremony-state + token-lifecycle tests.

### 3. T0.6 — `backend/crates/platform/authz` (`mnt-platform-authz`)
- Branch-scoped policy engine per plan §2.3 + ADR-0003 (docs/decisions/).
- `Role` enum (SUPER_ADMIN/ADMIN/MECHANIC/RECEPTIONIST/EXECUTIVE) + the 22-feature permission matrix from the spec's Technical Context (prior project PERMISSIONS.md, reproduced in the plan).
- BranchScope resolution from `user_branches` (kernel `BranchScope`), default-deny `authorize(principal, action, resource_branch) -> Result<(), KernelError>`, repository filter helper producing SQL predicates.
- Tests: cross-branch read/write denied; SUPER_ADMIN spans; ADMIN limited to memberships; the permission matrix exhaustively table-tested.

### 4. T0.7 — Compose prod stack (`ops/`) + `backend/app` (`mnt-app`)
- Real composition-root binary `mnt-app` (axum 0.8 + tower-http — verify versions live): `/healthz` + `/readyz`, OTel tracing wired, env-based 12-factor config, SIGTERM graceful shutdown. This is a REAL binary (no placeholder routes beyond health/ready, which are real operational surface).
- Multi-stage `backend/Dockerfile` building `mnt-app` (use SQLX_OFFLINE=true with the committed cache).
- `ops/compose.yml` (prod) + `ops/compose.dev.yml` (override): Traefik v3 (verify current tag live) HTTPS; **postgres:18.x pinned by digest**; SeaweedFS single-node S3 (pinned release a few weeks behind head per ADR-0005; S3 port ONLY — no Filer/Admin UI exposed); app + worker services; OTel collector; healthcheck stanzas on every service.
- Acceptance: `docker compose -f ops/compose.yml up -d` from clean checkout boots all services healthy on local Docker (colima, server 29.5.2); `curl` healthz/readyz return 200; `compose down` clean.
- `ops/README.md` documents the OCI deploy steps (actual OCI provisioning is a USER action — document, do not fake).

### 5. T0.11 — compliance domain (`backend/crates/compliance/`)
- Crates per layering: `mnt-compliance-domain`, `mnt-compliance-application`, `mnt-compliance-adapter-postgres`. Add `"crates/compliance/*"` to workspace members.
- LocationConsent ledger FSM (grant/withdraw/suspend/resume) on kernel Transition types.
- LocationPing destructible store: migration **0005** — `location_pings` PARTITIONED BY RANGE (day), partition management + retention-purge function.
- Destruction-on-withdrawal: deletes ALL pings + collection logs for the user in the SAME tx as the consent-withdrawal audit event.
- CRITICAL (위치정보법, ADR-0014 + plan §2.2): coordinates must NEVER enter `audit_events` — consent lifecycle events ARE audited, coordinate payloads are NOT; a test asserts no audit row contains coordinate fields.
- Tests per plan T0.11 acceptance: withdrawal destroys all pings+logs; purge drops expired day-partitions; ping-volume bound test.

### 6. T0.12 — user provisioning + passkey cold-start (`backend/crates/platform/provisioning` or inside auth crate — your call, justify in commit)
- Bulk roster provisioning: import users (display_name, phone, team, roles, branch memberships) from a roster file format you define (CSV or JSON — document it); idempotent upsert (re-run = no-op); branch/role assigned from roster rows.
- OTP/temp-credential bootstrap: a net-new zero-credential user receives a one-time bootstrap credential (time-limited, single-use, hashed at rest) that authorizes EXACTLY ONE passkey enrollment via the existing mnt-platform-auth ceremonies, then auto-revokes.
- Migration number **0006**.
- Tests (#[sqlx::test]): zero-credential user bootstraps → enrolls passkey (use webauthn-authenticator-rs SoftPasskey like tests/webauthn_ceremony.rs does) → temp credential auto-revoked + cannot be reused; bulk import idempotency (re-run = 0 changes, reconciliation counts); roster row with unknown branch fails validation without partial writes.

### 7. T0.8 — observability baseline (mnt-app + ops/ + slos/)
- End-to-end OTel: a request to a real mnt-app route produces a trace visible in the otel-collector debug exporter spanning REST handler → DB query; structured JSON logs carry trace_id. Verify by booting ops/compose.yml (use docker-compose, hyphenated) and curling; capture the evidence.
- Audit-log read API in mnt-app: GET /api/audit (paginated, filterable by target_type/actor) — JWT-verified (mnt-platform-auth) + role-gated via mnt-platform-authz (Feature::AuditLogRead: ADMIN/SUPER_ADMIN only) + branch-scoped; AND the access itself emits an audit event via with_audit (action audit.read). #[sqlx::test] + integration tests: unauthorized role denied; access emits audit row.
- OpenSLO v1 files under backend/app/slos/: api-availability.openslo.yaml (99.5%/30d) + api-latency.openslo.yaml (p99<500ms) — validate against the OpenSLO v1 schema (vendor the schema or validate structurally in a test).
### 8. T0.9 — backup/restore runbook (ops/backup/)
- Nightly backup: script(s) + compose-integrated mechanism for Postgres (pg_dump custom format AND document pg_basebackup for the PITR base used by T0.13) and SeaweedFS data volume; retention policy (e.g., 14 daily, 8 weekly); works against the running ops/compose.yml stack (docker-compose hyphenated CLI).
- Restore drill: script that restores the latest backup into a SCRATCH compose project (separate project name/volumes), verifies row counts/migration version match, and tears down. RUN IT against the real stack and record the drill output to ops/backup/drill-logs/ (timestamped).
- Runbook ops/backup/RUNBOOK.md: step-by-step restore (who/when/commands/verification), failure modes.
- No cargo changes expected; if any, full verification suite applies.
