# CI Gates

The GitHub Actions workflow in `.github/workflows/ci.yml` is the source of truth
for CI enforcement. This document mirrors the current gate inventory and splits
the checks into two groups: core local gates that a fresh development session can
run directly, and CI-contextual/heavy gates that need platform-specific runner
setup, services, browser/device runtimes, or optional secrets.

The gates encode the project's non-negotiable invariants (clean-architecture
layering, audit-first discipline, 위치정보법/PIPA data handling, multi-tenant
isolation, cross-client contract, and cross-surface parity) so that a violation
fails before production. Do not treat a lightweight local loop as full CI
confidence: a change is not "done" until the relevant local gates, review/user
story evidence, and CI jobs for the touched surfaces are green.

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

## Local gate runbook

Start with the core local gates for the surfaces you touched. The command list
below intentionally separates always-local commands from CI-parity/heavy surfaces
so a fresh session does not gain false confidence from a partial run.

```bash
# Backend core (from backend/)
cargo fmt --all -- --check
SQLX_OFFLINE=true cargo clippy --all-targets -- -D warnings
SQLX_OFFLINE=true DATABASE_URL=postgres://<user>@localhost/mnt_dev cargo test
for g in layer-boundary audit-coverage migration-safety tenant-isolation pii-no-logs rls-arming dev-auth-absence; do
  cargo run -q -p mnt-gate-$g            # each must exit 0
done
SQLX_OFFLINE=true cargo test -p mnt-platform-auth-rest --features dev-auth
SQLX_OFFLINE=true cargo test -p mnt-app --features dev-auth --test dev_auth_persona_guard_feature
SQLX_OFFLINE=true cargo test -p mnt-platform-provisioning --test dev_principal_upsert_race

# API/client contract gates (from repo root after npm ci)
npm run check:api-drift:portable          # regenerate ts+kotlin, expect no diff
npm run check:ts
npm run check:kotlin
npm run check:api-drift:swift             # macOS/Swift toolchain gate
npm run check:swift                       # macOS/Swift toolchain gate
npm run check:openapi-app                 # committed openapi.yaml covers mounted routes
CONTRACT_DATABASE_URL=postgres://<user>@localhost/mnt_contract npm run test:contract

# Web console + product-maturity gates (from repo root after npm ci)
npm run test:adrs
npm run check:adrs
for s in \
  check:foundation-gates \
  check:enterprise-ux-parity \
  check:browser-persona-matrix \
  check:ios-ui-test-fail-closed \
  check:android-e2e-fail-closed \
  check:g004-identity-foundation \
  check:g005-workflow-lifecycle \
  check:workflow-runtime-spine \
  check:workflow-runtime-m2-strangler \
  check:workflow-runtime-m2-cedar-guards \
  check:workflow-runtime-m2-runtime \
  check:workflow-runtime-m2-drainer \
  check:g006-asset-dispatch-lifecycle \
  check:g007-collaboration-mobile-lifecycle \
  check:g008-payroll-readiness \
  check:people-hr-maturity \
  check:payroll-release-gate \
  check:financial-maturity \
  check:cx-reporting-maturity \
  check:operations-intelligence-maturity; do
  npm run "$s"
done
npm run web:lint
npm run web:test
npm run web:build

# Deployment and mobile parity gates
npm run check:k8s                         # render manifests; CI warns if no live cluster
MNT_NETWORKPOLICY_PREFLIGHT=require npm run check:k8s:networkpolicy
MNT_NETWORKPOLICY_EXPECTED_ENFORCER=cilium \
  MNT_NETWORKPOLICY_SMOKE_POSTGRES=auto \
  npm run smoke:k8s:networkpolicy-deny
npm run check:production-hardening
node scripts/check-i18n.mjs

# Android local build/unit/screenshot gates
( cd android && ./gradlew build -x testReleaseUnitTest -x testDebugUnitTest )
( cd android && ./gradlew testDebugUnitTest )
( cd android && ./gradlew verifyRoborazziDebug )

# iOS local gates (macOS with Swift toolchain)
swift build --package-path ios
swift test --package-path ios
swift run --package-path ios MaintenanceFieldCoreBehaviorTests
```

CI also runs heavier or runner-contextual gates. Reproduce them locally only when
their prerequisites are available:

- `npm run dev:bootstrap`, `/readyz`, `MNT_DEV_AUTH_E2E=1 npm run dev:bootstrap`,
  and `npx playwright test --project=dev-auth` for the dev-up/dev-auth smoke.
- `bash e2e/run.sh` for the full browser user-story suite after Postgres, Python
  helpers, Rust backend, Node dependencies, and Playwright Chromium are ready.
- `./gradlew fieldApi34DebugAndroidTest` for Android instrumented E2E after
  KVM/Gradle Managed Device setup. Protected branch push contexts require
  `FIELD_E2E_BASE_URL` and `FIELD_E2E_SEED_REFRESH_TOKEN` and fail closed before
  Gradle execution when they are unavailable or cannot mint a session. Fork PRs
  or explicitly optional runs may omit them only with truthful optional/skipped
  gate output; a protected branch push mobile gate must not false-green from an
  all-skip run.
- `.github/workflows/ios-ui-tests.yml` for Simulator-bound XCUITest/accessibility
  audit on macOS/Xcode. Required real-session contexts need
  `MNT_UITEST_BASE_URL` plus either `MNT_UITEST_REFRESH_TOKEN` or
  `MNT_UITEST_OTP`; optional/fork contexts may skip the session-dependent tests
  only with truthful optional-gate output.
- Swift client and iOS app gates require macOS/Swift; Linux developers should use
  CI or a macOS runner for those surfaces.

`SQLX_OFFLINE=true` uses the committed `.sqlx/` query cache; regenerate it with
`cargo sqlx prepare --workspace -- --all-targets` (note `--all-targets`, so test
queries are cached too) against a database migrated to head.

## Current CI workflow gate inventory

This inventory is sourced from `.github/workflows/ci.yml` and the root/web
`package.json` scripts. When the workflow changes, update this table and the
runbook together.

`npm run check:foundation-gates` machine-checks the three lists below against the
workflow and package manifests. The lists intentionally track stable command/gate
names only, not incidental workflow prose or runner setup text.

### Backend mnt-gate binaries run by CI

- `mnt-gate-audit-coverage`
- `mnt-gate-dev-auth-absence`
- `mnt-gate-iac-tier`
- `mnt-gate-layer-boundary`
- `mnt-gate-migration-safety`
- `mnt-gate-pii-no-logs`
- `mnt-gate-rls-arming`
- `mnt-gate-tenant-isolation`

### Root package scripts run by CI

- `check:android-e2e-fail-closed`
- `check:adrs`
- `check:browser-persona-matrix`
- `check:cx-reporting-maturity`
- `check:enterprise-ux-parity`
- `check:financial-maturity`
- `check:foundation-gates`
- `check:g004-identity-foundation`
- `check:g005-workflow-lifecycle`
- `check:g006-asset-dispatch-lifecycle`
- `check:g007-collaboration-mobile-lifecycle`
- `check:g008-payroll-readiness`
- `check:ios-ui-test-fail-closed`
- `check:k8s`
- `check:kotlin`
- `check:openapi-app`
- `check:operations-intelligence-maturity`
- `check:payroll-release-gate`
- `check:people-hr-maturity`
- `check:pr473-migration-operational`
- `check:production-hardening`
- `check:swift`
- `check:ts`
- `check:workflow-runtime-m2-cedar-guards`
- `check:workflow-runtime-m2-drainer`
- `check:workflow-runtime-m2-runtime`
- `check:workflow-runtime-m2-strangler`
- `check:workflow-runtime-spine`
- `gen:api:portable`
- `gen:api:swift`
- `test:api-client-contract:swift`
- `test:api-client-contract:ts`
- `test:contract`
- `test:adrs`
- `test:employee-import-contract`
- `test:ontology-write-precondition`
- `test:production-hardening`
- `test:text-gate`

### Web console package scripts run by CI

- `web:build`
- `web:lint`
- `web:test`

- **Backend — fmt / clippy / test / gates**: `cargo fmt --all -- --check`,
  `SQLX_OFFLINE=true cargo clippy --all-targets -- -D warnings`,
  `SQLX_OFFLINE=true cargo test`, seven `mnt-gate-*` binaries
  (`layer-boundary`, `audit-coverage`, `migration-safety`, `tenant-isolation`,
  `pii-no-logs`, `rls-arming`, `dev-auth-absence`), and three dev-auth feature
  tests for `mnt-platform-auth-rest`, `mnt-app`, and
  `mnt-platform-provisioning`.
- **dev-up.mjs smoke — compose deps + migrate + /readyz + dev-auth e2e**:
  `node scripts/dev-up.mjs bootstrap`, `/readyz` curl, `node scripts/dev-up.mjs
  down`, dev-auth bootstrap with `MNT_DEV_AUTH_E2E=1`, and `npx playwright test
  --project=dev-auth`.
- **API clients — TypeScript / Kotlin generation and compile**:
  `npm run gen:api:portable`, `git diff --exit-code -- clients/ts
  clients/kotlin`, `npm run check:ts`, and `npm run check:kotlin`. The local
  wrapper for the generation+diff check is `npm run check:api-drift:portable`.
- **Web console — lint / test / build**: ADR governance scripts `test:adrs`
  and `check:adrs`, followed by root product-maturity scripts
  `check:foundation-gates`, `check:enterprise-ux-parity`,
  `check:browser-persona-matrix`, `check:ios-ui-test-fail-closed`,
  `check:android-e2e-fail-closed`, `check:g004-identity-foundation`,
  `check:g005-workflow-lifecycle`, `check:workflow-runtime-spine`,
  `check:workflow-runtime-m2-strangler`, `check:workflow-runtime-m2-cedar-guards`,
  `check:workflow-runtime-m2-runtime`, `check:workflow-runtime-m2-drainer`,
  `check:g006-asset-dispatch-lifecycle`, `check:g007-collaboration-mobile-lifecycle`,
  `check:g008-payroll-readiness`, `check:people-hr-maturity`,
  `check:payroll-release-gate`, `check:financial-maturity`,
  `check:cx-reporting-maturity`, and `check:operations-intelligence-maturity`,
  followed by `npm run lint --workspace @console/web`,
  `npm run test --workspace @console/web`, and
  `npm run build --workspace @console/web`. Root shortcuts are
  `web:lint`, `web:test`, and `web:build`.
- **API contract — app OpenAPI and generated TS round-trip**:
  `npm run check:openapi-app` and `npm run test:contract` with
  `CONTRACT_DATABASE_URL`.
- **Kubernetes manifests — render / hardening / NetworkPolicy preflight**:
  `npm run check:k8s` (render plus `scripts/check-networkpolicy-enforcement.sh`)
  and `npm run check:production-hardening`.
- **API client — Swift generation and build**: `swift --version`,
  `npm run gen:api:swift`, `git diff --exit-code -- clients/swift`, and
  `npm run check:swift`. The local wrapper for generation+diff is
  `npm run check:api-drift:swift`.
- **Mobile parity — checklist and strings**: `node scripts/check-i18n.mjs` plus
  the inline workflow check that validates `docs/parity-checklist.md`, Android
  string keys, and iOS localized string keys. There is not currently a named root
  package script for the inline checklist/string-key check.
- **Android app — Gradle build**: `./gradlew build -x testReleaseUnitTest -x
  testDebugUnitTest`, `./gradlew testDebugUnitTest`, and
  `./gradlew verifyRoborazziDebug` from `android/`.
- **Android app — instrumented post-login E2E (emulator)**:
  `./gradlew fieldApi34DebugAndroidTest` with Gradle Managed Device/KVM setup.
  Protected branch push contexts need `FIELD_E2E_BASE_URL` and
  `FIELD_E2E_SEED_REFRESH_TOKEN`; CI fails closed before Gradle execution when
  they are missing or the backend exchange cannot mint fresh tokens. Fork/optional
  runs may skip only with clear optional-gate messaging; protected branch push gates must fail
  closed rather than treating missing secrets as post-login evidence.
- **iOS app — Swift build and behavior tests**: `swift build`, `swift test`, and
  `swift run MaintenanceFieldCoreBehaviorTests` from `ios/` on macOS.
- **iOS UI tests — XCUITest/accessibility audit (Simulator)**:
  `.github/workflows/ios-ui-tests.yml` generates the Xcode project with XcodeGen,
  resolves Swift packages, and runs the UI-test bundle against an iPhone
  Simulator. Real post-login coverage requires `MNT_UITEST_BASE_URL` and either
  `MNT_UITEST_REFRESH_TOKEN` or `MNT_UITEST_OTP`; protected/push contexts must
  fail closed when those inputs or the shared keychain entitlement are missing,
  while fork PR/explicitly optional contexts may skip with explicit optional
  output.
- **Browser E2E — Playwright (all user stories)**: backend `mnt-app` build,
  Postgres/psql/Python helper setup, `npx playwright install --with-deps
  chromium`, and `bash e2e/run.sh`.

---

## Backend gates

### `rustfmt` — formatting

`cargo fmt --all -- --check`. Zero diff required.

### `clippy -D warnings` — lint + compile

`SQLX_OFFLINE=true cargo clippy --all-targets -- -D warnings`. **Every** warning
is an error, including in tests and benches. This also doubles as the offline
compile check (it fails if the `.sqlx` cache is stale or a query is malformed).

### `cargo test` — workspace tests

The full workspace suite, including the DB-backed integration tests under
`backend/app/tests/` and per-crate `tests/`. Requires a `DATABASE_URL` pointing
at a Postgres database migrated to head (the suite is isolation-safe: tests key
on fresh UUIDs and do not assert on global counts, so they run in parallel).

### `mnt-gate-layer-boundary` — clean-architecture + manifest hygiene

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
  `edition.workspace = true`, opts into non-publishability with
  `publish.workspace = true` (inheriting workspace `publish = false`) or direct
  `publish = false`, and carries `[lints] workspace = true`.
- **Conflict-marker scan:** rejects any git-tracked file containing unresolved
  merge markers (`<<<<<<<`, `=======`, `>>>>>>>`). Added after MFL-0001
  (a merge commit shipped with unresolved markers); see
  [MISTAKES-LEDGER.md](MISTAKES-LEDGER.md).

### `mnt-gate-audit-coverage` — audit-first discipline

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

### `mnt-gate-migration-safety` — append-only audit trail

Source: `backend/ci/gates/migration-safety/`. Migrations are append-only and may
not erode the audit trail. It rejects:
- `DROP TABLE` on an audited table,
- `ALTER TABLE … DROP COLUMN` on an audited table,
- `GRANT UPDATE`/`GRANT DELETE` on `audit_events`,
- `DISABLE TRIGGER` on `audit_events`.

The append-only protection on `audit_events` (REVOKE UPDATE/DELETE + trigger) is
thus immune to being silently undone by a later migration.

### `mnt-gate-pii-no-logs` — PIPA log hygiene

Source: `backend/ci/gates/pii-no-logs/`. Scans the bodies of logging macros
(`info!`/`debug!`/`warn!`/`error!`/etc.) and rejects:
- Korean mobile phone-number patterns,
- GPS coordinate pairs (two plausible lat/long floats together),
- resident-registration-number (주민등록번호) patterns.

PII/location data may be persisted (audited or destructible per policy) but must
never be written to logs.

### `mnt-gate-tenant-isolation` — RLS tenant-scope coverage

Source: `backend/ci/gates/tenant-isolation/`. Statically scans database
migrations and the audit GUC source path to ensure tenant-scoped tables are
classified, carry a non-null `org_id` unless explicitly allowlisted, enable and
force Row Level Security, and use policies bound to
`current_setting('app.current_org')`. It also rejects session-level or non-local
GUC arming that could bleed tenant context across requests.

The static scan is a fast source-level lint, not a reimplementation of
PostgreSQL privilege resolution. During the PostgreSQL 18 boot smoke, CI also
runs `owner_only_acl_postgres18` immediately after migrations execute as the
production owner role (`mnt_app`). That contract reuses the gate's owner-only
table allowlist and asks PostgreSQL for the effective `mnt_rt` table and column
privileges, so direct, `PUBLIC`, role-inherited, column-level, schema-wide, and
default-privilege grants are evaluated by the database itself. It also rejects
roles that `mnt_rt` can assume with `SET ROLE`, case-distinct table-like
relation shadows in `public`, and proves adversarial ACL mutations are
observable before rolling them back.

### `mnt-gate-rls-arming` — production queries use an armed org context

Source: `backend/ci/gates/rls-arming/`. Scans adapter/rest data-layer code for
query execution on a bare pool where no per-transaction `app.current_org` GUC is
armed. Legitimately global reads must carry an inline `// rls-arming: ok
<reason>` marker so each exception is reviewed and path-local.

### `mnt-gate-dev-auth-absence` — dev auth stays out of release defaults

Source: `backend/ci/gates/dev-auth-absence/`. Uses `cargo metadata` to prove the
`mnt-app` default feature set does not transitively enable `dev-auth`, so the
local role-switch endpoint cannot ship in the default release binary. HTTP-level
absence tests complement this feature-graph proof.

### Dev-auth feature build/tests — explicit non-default coverage

CI separately runs the non-default dev-auth path so the code remains healthy
without making it part of the release feature set:

```bash
SQLX_OFFLINE=true cargo test -p mnt-platform-auth-rest --features dev-auth
SQLX_OFFLINE=true cargo test -p mnt-app --features dev-auth --test dev_auth_persona_guard_feature
SQLX_OFFLINE=true cargo test -p mnt-platform-provisioning --test dev_principal_upsert_race
```

---

## Cross-client contract gates

The backend serves the committed `backend/openapi/openapi.yaml`; the TypeScript,
Kotlin, and Swift clients are **generated** from it. These gates keep the three
clients and the spec in lockstep.

The authoritative platform-admin API contract is the same OpenAPI document, not a
sidecar or undocumented internal surface. `/api/platform/*` route definitions in
`mnt-platform-rest` must match the OpenAPI path+method inventory, and
`web/src/api/platform.ts` must consume the generated `@maintenance/api-client-ts`
types for platform DTOs/request/response shapes. The raw fetch wrapper in the web
module is transport-only: it preserves bearer/cookie/device behavior while the
contract remains schema-driven.

### Generated-client drift — `check:api-drift:portable` / `:swift`

Regenerates the clients from `openapi.yaml` and runs `git diff --exit-code`. Any
drift between the committed generated code and a fresh regeneration fails. (Hand-
editing generated client files therefore fails the gate — regenerate instead.)
`check:ts` / `check:kotlin` / `check:swift` additionally compile each client.

Generated clients are generated artifacts. Durable parser or model changes must
start from the OpenAPI schema (`backend/openapi/openapi.yaml`) or the generator
configuration/template/script that produces the checked-in client, then commit the
regenerated output. Hand-editing `clients/kotlin/src/main/...` to relax JSON
parsing is only acceptable as a throwaway diagnosis step; the shipped source of
truth must be schema or generator-driven so the drift gates can reproduce it.

Generated-client source-control policy for cleanup issue #108:
- `backend/openapi/openapi.yaml` is the reviewed source of truth for generated
  clients. Keep generated TypeScript, Kotlin, and Swift client output committed
  and versioned atomically with OpenAPI changes so web/mobile consumers have
  reproducible source and CI can fail on drift.
- Regenerate clients with `npm run gen:api:portable` and `npm run gen:api:swift`;
  do not hand-edit `clients/ts/src/schema.d.ts`, `clients/kotlin/**`, or
  `clients/swift/Sources/MaintenanceAPIClient/Generated/**`.
- Code review and audit de-emphasize generated hunks and instead review
  `backend/openapi/openapi.yaml`, generator scripts/configuration, and the drift
  gate output for intent.
- This policy can change only after a replacement release path proves consumer
  builds, package publishing, and drift checks without committed generated
  clients.

Kotlin generated clients must parse JSON fail-closed by default: unknown response
keys, non-standard lenient JSON, and malformed payloads are contract drift and
must fail client/contract tests unless an explicit compatibility exception exists.
Broad defaults such as `ignoreUnknownKeys = true` or `isLenient = true` are not
allowed on the shared generated-client `Json` instance because they hide OpenAPI
or backend/client drift.

Compatibility exceptions must be route- or schema-scoped and documented before
implementation. Each exception must name the endpoint/`operationId`, request vs.
response direction, exact parser relaxation, production compatibility reason,
owner, expiry or removal trigger, source-of-truth change point (schema vs.
generator config/template/script), and the fixture/test that proves the exception
is narrow. Exception tests must still run under `check:kotlin` or the relevant
contract/drift gate so future routes do not inherit compatibility mode silently.

### `check:openapi-app` — spec covers mounted routes

`node scripts/check-openapi-app.mjs` first runs
`scripts/check-platform-contract-drift.mjs`, then asserts the app-served OpenAPI
document is byte-for-byte equal to the committed `backend/openapi/openapi.yaml`.
The platform drift gate parses `mnt-platform-rest` router definitions in
`src/lib.rs` and `src/view_as.rs` and fails when any `/api/platform/*`
path+HTTP-method is missing from OpenAPI, or when OpenAPI documents a platform
operation that the backend router does not define. The backend
`openapi_drift.rs` test continues to check each REST crate's exported
`*_ROUTE_PATHS` against OpenAPI path keys and mirrors the stricter platform
operation inventory via `PLATFORM_ROUTE_OPERATIONS`. Together these prevent an
unowned/undocumented HTTP surface (MFL-0002), including method-level platform
drift on already-documented paths.

Verification notes for platform route or DTO changes must name both halves of the
contract check: the route inventory comparison (`node scripts/check-platform-contract-drift.mjs`
or `npm run check:openapi-app`) and frontend type generation/validation (`npm run gen:api:ts`
plus `npm run check:ts`).

### `test:contract` — generated client ↔ app round-trip

`npm run test:contract` exercises the generated TS client against the running app
to confirm request/response shapes round-trip against the real handlers (needs
`CONTRACT_DATABASE_URL`).

---

## Web console and product-maturity gates

The web job runs root-level product maturity scripts before the normal web
workspace lint/test/build trio. These scripts are local Node gates, not Playwright
runtime tests:

- `npm run check:foundation-gates`
- `npm run check:enterprise-ux-parity`
- `npm run check:browser-persona-matrix`
- `npm run check:ios-ui-test-fail-closed`
- `npm run check:g004-identity-foundation`
- `npm run check:g005-workflow-lifecycle`
- `npm run check:workflow-runtime-spine`
- `npm run check:workflow-runtime-m2-strangler`
- `npm run check:workflow-runtime-m2-cedar-guards`
- `npm run check:workflow-runtime-m2-runtime`
- `npm run check:workflow-runtime-m2-drainer`
- `npm run check:g006-asset-dispatch-lifecycle`
- `npm run check:g007-collaboration-mobile-lifecycle`
- `npm run check:g008-payroll-readiness`
- `npm run check:people-hr-maturity`
- `npm run check:payroll-release-gate`
- `npm run check:financial-maturity`
- `npm run check:cx-reporting-maturity`
- `npm run check:operations-intelligence-maturity`

The workspace checks map to `web/package.json`:

- `npm run lint --workspace @console/web` (`npm run web:lint`) runs
  ESLint and `web/scripts/check-ui-strings.mjs`.
- `npm run test --workspace @console/web` (`npm run web:test`) runs
  Vitest.
- `npm run build --workspace @console/web` (`npm run web:build`) runs
  `tsc -b` and `vite build`.

---

## Deployment and hardening gates

The Kubernetes manifests job runs `npm run check:k8s`, which renders the
production overlays, guards Argo CD targets, and invokes
`scripts/check-networkpolicy-enforcement.sh`. Generic CI has no production
kubeconfig, so that live NetworkPolicy readback runs with
`MNT_NETWORKPOLICY_PREFLIGHT=warn`: CI may prove manifests render, but it must
not be cited as proof that the target cluster enforces NetworkPolicy isolation.

Before deployment, an operator with a kubeconfig for the target cluster must run:

```bash
MNT_NETWORKPOLICY_PREFLIGHT=require npm run check:k8s:networkpolicy
MNT_NETWORKPOLICY_EXPECTED_ENFORCER=cilium \
  MNT_NETWORKPOLICY_SMOKE_POSTGRES=auto \
  npm run smoke:k8s:networkpolicy-deny
```

That required mode reads the selected cluster context, confirms the `maintenance`
namespace has applied NetworkPolicy objects, and fails unless it detects a
policy-capable enforcer such as Cilium, Calico/Canal, Antrea, kube-router, or
OVN-Kubernetes. Plain flannel-only clusters fail the preflight. Use
`MNT_NETWORKPOLICY_EXPECTED_ENFORCER=cilium` (or another supported value) when a
deployment context has a declared CNI owner. The denied-traffic smoke then creates
temporary same-namespace pods: an unlabeled control pod must reach an
`app=mnt-web` target on TCP/8080; an `app=mnt-app` client selected by
`default-deny-egress-app-tier` must resolve kube-dns, reach outbound HTTPS on
TCP/443, and reach `mnt-db-rw:5432` when the CNPG Service exists; that same
app-tier client must fail to reach the temporary HTTP target on TCP/8080. A smoke
PASS is the deny/allow packet evidence required for production isolation; a
preflight or smoke FAIL means wrong context/RBAC, missing policies, public
image-pull blocking (override `MNT_NETWORKPOLICY_SMOKE_*_IMAGE` to approved
mirrors), no approved HTTPS probe, or a CNI/policy regression that must be fixed
before launch.

`scripts/deploy.sh` is the deployment output contract, not just a digest helper.
Default mode must fail closed unless it can produce fresh rollout evidence. A
deployment-complete claim requires all of these signals from the same run: a
successful `image-release.yml` run for the target commit; fresh `mnt-app` and
`mnt-web` digest artifacts; the prod overlay/bump revision that Argo should sync;
Argo Application `maintenance` reporting `Synced` at that revision;
`mnt-app`/`mnt-web` Rollouts Healthy; `mnt-worker` Deployment rolled out;
workload template image digests and running/ready pod image IDs or image
references matching the built digests; and HTTP 200 from both public endpoints.
Missing `kubectl`, missing target kubeconfig/RBAC, an unreachable Argo
Application, unavailable argo-rollouts plugin, rollout failure, pod readiness
failure, digest mismatch, or endpoint failure is a failed deploy verification, not
an optional skip.

`scripts/deploy.sh --digest-bump-only` / `--bump-only` is intentionally different:
it updates the desired prod image digests and prints that deployment, rollout,
pod-image, and endpoint verification were **NOT** run. Use it only when an
operator explicitly wants a digest bump from a host without cluster access; the
result must be documented as "desired prod digests updated only" and must not be
cited as deployed, verified, production-ready, or a G008 rollout completion.

After the Kubernetes check, CI/local validation still runs
`npm run check:production-hardening`. That production-hardening contract includes
the SMTP relay fail-closed guard: if the production-like `mnt-config` ConfigMap
sets non-secret `MNT_EMAIL_*` relay fields (`MNT_EMAIL_SMTP_HOST`,
`MNT_EMAIL_SMTP_PORT`, `MNT_EMAIL_FROM`, or `MNT_EMAIL_FROM_NAME`), the API and
worker manifests must explicitly require `MNT_EMAIL_SMTP_USERNAME` and
`MNT_EMAIL_SMTP_PASSWORD` from `mnt-secrets` via non-optional `secretKeyRef`
entries. `envFrom` alone is not enough because Kubernetes silently omits missing
Secret keys; local/dev/e2e stub-email configs should omit the whole SMTP relay
group. Local reproduction needs the same renderer tooling that CI installs,
including a compatible `kubectl`/kustomize runtime.

These are manifest and desired-state gates, not live packet-enforcement proof.
They prove that the NetworkPolicy manifests such as
`deploy/apps/maintenance/base/networkpolicy.yaml` render and that the production
hardening contract still points at the intended deployment surfaces. They do not
prove that traffic is isolated in a running cluster. Production NetworkPolicy
isolation requires a policy-capable CNI (the staged on-prem path uses Cilium;
Calico or Canal with Calico policy would be equivalent if explicitly selected).
Plain Talos/flannel renders NetworkPolicy resources inert even when the YAML
renders cleanly.

Security/review evidence for production networking must therefore pair the render
gate and `check:production-hardening` result with live CNI readiness plus
deny/allow DNS, Postgres-if-present, HTTPS, and explicit denied-flow connectivity
evidence from `npm run smoke:k8s:networkpolicy-deny` (or an equivalent recorded
pod-connectivity transcript) before claiming network isolation. Cross-reference
the enforcement notes in
`deploy/apps/maintenance/base/networkpolicy.yaml`, the on-prem CNI stage in
`deploy/apps/cilium/README.md`, and the Talos on-prem substrate notes in
`deploy/talos/on-prem/README.md` when reviewing those gates.

---

## Mobile parity gates

### `check-i18n.mjs` — UI string-key parity

`node scripts/check-i18n.mjs` checks that web, Android, and iOS UI string keys
are present and consistent across the three clients (no missing/orphaned keys for
shared surfaces).

### Parity checklist — feature parity

Validates `docs/parity-checklist.md`: each shipped feature row names its Android
target, its iOS implementation, and the evidence commands that prove parity
([ADR-0009](decisions/ADR-0009-dualnative-swiftkotlin-parity-strategy-via-single.md)).

### iOS app — build + behavior tests

`swift build`, `swift test`, and `swift run MaintenanceFieldCoreBehaviorTests`
from `ios/`. The behavior runner mirrors the Android unit-test assertions for
shared domain logic (consent state machine, messenger reducer, sync, etc.). These
gates are local on macOS with a compatible Swift toolchain and otherwise rely on
the macOS CI runner.

### iOS UI tests — real-session XCUITest/accessibility gate

The standalone `.github/workflows/ios-ui-tests.yml` workflow is the CI-only
Simulator gate for SwiftUI post-login flows and accessibility audit coverage. It
installs XcodeGen, generates `ios/MaintenanceField.xcodeproj` from
`ios/project.yml`, resolves Swift packages, builds for testing, patches the
`.xctestrun` file, and then runs the UI-test bundle. This is not a TestFlight or
archive-signing gate; release signing remains governed by the mobile release
workflow and go-live checklist.

Required real-session inputs for post-login coverage are:

- `MNT_UITEST_BASE_URL` GitHub secret: the real backend base URL used by the
  UI-test runner.
- One of `MNT_UITEST_REFRESH_TOKEN` or `MNT_UITEST_OTP` GitHub secrets: a real
  dedicated UI-test mechanic session source. The refresh-token path exchanges a
  seeded long-lived refresh token through `/api/v1/auth/token/refresh`; the OTP
  path redeems an out-of-band code through `/api/v1/auth/otp/redeem`.
- A granted shared keychain access-group entitlement for the Simulator build so
  the test runner can seed the real session into the same Keychain group the app
  reads. `MNT_IOS_KEYCHAIN_GROUP` is an optional repository variable override;
  when unset, the test probes the granted `com.maintenance.field.shared` group.
- `MNT_UITEST_REQUIRE_REAL=1` is the enforcement flag, not a credential. Required
  branch/push contexts must enable it; optional contexts may leave it disabled.

Expected behavior by context:

- **Protected branch or required push runs:** fail closed when the base URL is
  absent, neither session source is present, the backend exchange fails, or the
  shared keychain entitlement cannot be granted. `PreflightUITests` must fail in
  those cases; an all-skip post-login run is not valid evidence for a protected
  branch.
- **Fork PRs and explicitly optional runs:** may run without repository secrets.
  Session-dependent UI tests may `XCTSkip` with the no-real-session message and
  the workflow output must make the gate's optional/skipped status clear. A green
  optional run is build/accessibility smoke only and must not be cited as real
  post-login coverage.

### Android app — build, unit/accessibility, and screenshots

From `android/`, CI runs `./gradlew build -x testReleaseUnitTest -x
testDebugUnitTest`, `./gradlew testDebugUnitTest`, and `./gradlew
verifyRoborazziDebug`. The first gate assembles/lint-checks without duplicate
unit-test execution, the second runs the Robolectric Compose UI/accessibility
tests, and the third verifies committed Roborazzi screenshot goldens.

### Android instrumented E2E — emulator-backed post-login workflow

The `android-instrumented` job in `.github/workflows/ci.yml` runs on a Linux
runner with KVM and Gradle Managed Device setup, mints and masks a fresh backend
session, stores the token pair in a permission-restricted temporary androidTest
asset fixture, and then executes `./gradlew fieldApi34DebugAndroidTest`. The
workflow deliberately avoids GitHub step outputs and raw Gradle CLI arguments for
token values. Local reproduction is possible with the same emulator/device setup,
but it is not part of the lightweight fresh-session loop.

`npm run check:android-e2e-fail-closed` is the lightweight regression guard for
issue #359: it statically inspects this workflow, dry-runs the missing-input shell
branch for required and optional contexts, and fails if the old protected-branch
self-skip/empty-output path can return success before Gradle starts. It does not
start a GitHub runner, evaluate branch protection live, boot the Gradle Managed
Device, or contact the real backend; use the `android-instrumented` CI job with
real `FIELD_E2E_*` secrets for full post-login Android evidence.

Required real-session inputs are:

- `FIELD_E2E_BASE_URL` GitHub secret: the real backend base URL used to refresh
  the seeded test session before the emulator starts.
- `FIELD_E2E_SEED_REFRESH_TOKEN` GitHub secret: the long-lived refresh token for
  the dedicated Android E2E test technician. CI exchanges it through
  `POST /api/v1/auth/token/refresh`, masks the seed token plus the fresh
  access/refresh pair immediately, and writes only the fresh pair to the
  temporary fixture.
- `FIELD_E2E_SESSION_ASSETS_DIR` is a runner-local environment handoff, not a
  repository secret. When set, Gradle wires that directory into the
  `androidTest` assets and `WorkOrderFlowTest` reads
  `field-e2e-session.properties` for `FIELD_E2E_ACCESS_TOKEN` and
  `FIELD_E2E_REFRESH_TOKEN`. The workflow removes the source fixture, generated
  copies, and androidTest APKs after the run.

Expected behavior by context:

- **Protected branch push runs:** configure both GitHub
  secrets and treat absence, refresh failure, fixture creation failure, or an
  all-skipped `WorkOrderFlowTest` as fail-closed. A green protected branch push
  mobile gate must prove real post-login Android coverage, not merely an emulator
  boot with no session.
- **Fork PRs and explicitly optional runs:** may omit repository secrets. The
  workflow's absent-secret path leaves `FIELD_E2E_SESSION_ASSETS_DIR` empty and
  `WorkOrderFlowTest` skips via JUnit `Assume`; that is acceptable only when the
  job output/summary makes the gate's optional/skipped disposition clear. Do not
  cite such a run as real post-login parity evidence.

---

## CI-contextual browser/dev-up gates

The dev-up smoke and browser E2E jobs are local only when their service/runtime
dependencies are available:

- **dev-up smoke:** `node scripts/dev-up.mjs bootstrap`, `/readyz`, cleanup with
  `node scripts/dev-up.mjs down`, dev-auth bootstrap with `MNT_DEV_AUTH_E2E=1`,
  and `npx playwright test --project=dev-auth`.
- **Browser E2E:** `bash e2e/run.sh` after CI-equivalent setup for Postgres,
  `psql`, Python E2E helpers, Rust `mnt-app`, Node dependencies, and Playwright
  Chromium. This is the all-user-stories browser gate and should be used for UI
  feature completion evidence when applicable.

---

## Notes

- The seven `mnt-gate-*` binaries exit non-zero on the first violation with a
  `file:detail` message; run an individual gate locally to see what it caught.
- When a change touches OpenAPI routes/schemas, the generated-client drift,
  client compile, `check:openapi-app`, and `test:contract` gates must all be
  re-run; a backend-only internal change that does not move API/client surfaces
  still needs the backend fmt/clippy/test/gate binaries and any touched-surface
  CI-contextual gates.
- Gate provenance and the incidents that motivated several checks are recorded in
  [MISTAKES-LEDGER.md](MISTAKES-LEDGER.md).
