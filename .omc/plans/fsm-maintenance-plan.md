# Implementation Plan — 물류장비(지게차) 정비/렌탈 FSM 시스템

STATUS: **pending approval** — consensus APPROVED (Critic, iteration 3, 2026-06-12). Execution gated on explicit user approval; packaged as /ultragoal durable workflow (.omc/ultragoal/).
Mode: DELIBERATE (auth/security/compliance in scope → pre-mortem + expanded test plan REQUIRED)
Source spec: `/Users/jasonlee/Developer/maintenance/.omc/specs/deep-interview-fsm-maintenance.md` (ambiguity 16%, PASSED)
Consensus loop: Planner (this doc) → Architect (adversarial) → Critic. Iteration 2 (Architect: SOUND-WITH-AMENDMENTS; Critic: ITERATE) — all MUST items incorporated; SHOULD items incorporated or marked tracked fast-follow. Iteration 3: Architect re-review SOUND-WITH-AMENDMENTS (2 single-sentence, non-blocking) — both folded in (T0.4 gate/carve-out reconciliation, T0.13 drill-log evidence) + explicit M0 parallelism note; awaiting Critic gating verdict.
Versions in this plan were re-verified live against crates.io on 2026-06-11 (user mandate: never from training data). Re-verify again at first `cargo add` time per milestone.
Packaging: this plan will be packaged as an `/ultragoal` durable workflow (plan/ledger artifacts under `.omc/ultragoal`). **Milestone and task IDs (M0…M6, T0.x…T6.x) are STABLE and must not be renumbered** — the ledger references them. New tasks append within a milestone (e.g. T0.10) rather than reordering.

---

## 1. RALPLAN-DR Summary

### Principles (5)
1. **Audit-first domain core.** Every state transition / approval / assignment / chat message writes an append-only `audit_events` row in the *same* DB transaction as the mutation (`SELECT FOR UPDATE → validate transition → UPDATE → INSERT audit → COMMIT`). Audit is a domain invariant, not middleware. A CI `audit-coverage` gate fails the build if a state-changing handler has no audit emission.
2. **Production-grade-only increments.** Hard user mandate: NO stubs, NO placeholders, NO demo modes anywhere. Every milestone ends in shippable, tested, operable functionality. Integration seams (oyatie AI, Bitween identity) ship as *port definitions only* — NO mock adapters; the feature is simply absent until the real adapter lands. Prior project's demo-mode pattern is explicitly dropped.
3. **Branch-scoped everything from day 1.** `branch_id` is a non-nullable day-1 schema concept (NOT nullable-then-mandatory). P1 fan-out, permissions (ADMIN = branch-scoped, SUPER_ADMIN = all), KPI rollups (technician→branch→region→company), wall-boards, and chat team-channels are all branch-scoped. Cross-branch access denied by default and verified by authorization tests.
4. **Verify-latest-deps, compiler-enforced boundaries.** Stack versions re-verified live at each `cargo add`. Clean-architecture layering (`domain ← application ← adapter ← {rest, worker} ← app`) enforced by Cargo crate boundaries + a CI layer gate — the compiler refuses illegal dependency edges. SQLx compile-time-checked queries; TypeScript strict; OpenAPI-generated mobile/web clients.
5. **K8s-ready, Compose-deployed.** 12-factor posture (declarative config, health/readiness probes, graceful shutdown, OTel) so that the eventual K8s migration is config, not refactor. Launch on OCI Compute VM + Docker Compose + Traefik HTTPS. WebSocket fan-out and job workers sit behind interfaces (Postgres `LISTEN/NOTIFY` bridge) that permit multi-instance scale-out — 300+ users on one node is the *starting* point, not the ceiling.

### Decision Drivers (top 3)
1. **Regulatory exposure is launch-blocking and criminal.** 위치정보법 (Location Information Act) carries criminal penalties; GPS consent/destruction automation and KCC LBS 사업 신고 are go-live gates, not features. This forces compliance to be a first-class, early, independently-tested workstream — not bolted on.
2. **Dual-native client surface (Swift + Kotlin) doubles the client-side cost and creates parity drift risk.** The user made this an informed decision over Expo. Drives: shared OpenAPI-generated clients, shared design tokens, a CI-enforced per-release parity checklist, and a build-order that defers the *second* native app until the API contract for a slice is frozen.
3. **Exact Excel template fidelity is a hard acceptance criterion.** 일일업무진행현황 must reproduce the 4-section 양식 byte-for-byte as a downloadable export, validated against a golden file. Drives the template-fill vs. generate-from-scratch library decision (see Architecture §2.9) and a golden-file regression test.

### Viable Options (genuinely compared — macro build-order & layout)

> Settled stack decisions (Rust/Axum/SQLx/SeaweedFS+OCI WORM/Swift+Kotlin/React, passkeys-first, Compose-on-OCI) are **constraints, not options** and are not re-litigated here.

#### Option A — Vertical-slice-first (RECOMMENDED)
Build the platform spine (workspace skeleton, auth, audit, branch scoping, Compose/CI/observability) as M0, then ship **one complete vertical slice end-to-end** (WO lifecycle: web intake → API → Android+iOS today-list → evidence upload → approval → audit) before fanning out to the remaining domains. Each later domain (P1 broadcast, messenger, reporting, registry, financial) is its own vertical slice ending in shippable functionality.

- **Pros:** Proves the full layering + dual-native + offline + audit + compliance machinery on the smallest real feature early; de-risks the parity-drift and template-fidelity unknowns at minimum cost; every milestone is demoable to the HQ pilot team of 8; matches the production-grade-only mandate (no horizontal "all domains stubbed" phase ever exists).
- **Cons:** The M0 spine is heavy up-front before any user-visible domain feature; some cross-cutting refactors (e.g. messenger fan-out infra) recur across slices; requires discipline to keep slices thin.

#### Option B — Platform-first / layer-horizontal
Build all of `domain` for all 9 components first, then all of `application`, then all adapters, then all clients last.

- **Pros:** Clean separation of concerns per layer; domain modeling done once, coherently.
- **Cons:** **Violates the production-grade-only mandate** — for most of the timeline nothing is shippable/operable; the dual-native parity and Excel-fidelity risks surface only at the very end when they're most expensive; no early pilot feedback; classic big-bang integration risk. **Invalidated** as primary strategy by the no-demo-mode / every-milestone-ships mandate.

#### Option C — Two-client-staggered within slices (parity strategy sub-option)
Within Option A's slices, ship **web + Android first, iOS one milestone behind** per slice, rather than all three clients simultaneously.

- **Pros:** Reduces parity-drift WIP; lets the OpenAPI contract for a slice fully freeze before the second native app consumes it; halves concurrent native debugging.
- **Cons:** Temporarily breaks iOS/Android parity *between* milestones (acceptable: the parity gate is enforced per *shipped release*, and a slice isn't "released to a branch" until both natives pass). Risk of iOS perpetually trailing if not gated.

**SELECTION: Option A (vertical-slice-first) as the build-order, incorporating Option C as the per-slice client-sequencing tactic.** Rationale: A is the only strategy compatible with the production-grade-only / every-milestone-ships mandate while front-loading the three biggest unknowns (compliance, dual-native parity, Excel fidelity). C bounds the dual-native WIP without ever shipping a branch a non-parity release. B is invalidated for primary use but its "model the domain coherently once" virtue is preserved by doing full ontology-driven domain modeling inside M0 even though adapters/clients land slice-by-slice.

#### Repo layout option: Monorepo vs Polyrepo
- **Monorepo (RECOMMENDED):** single repo, top-level `/backend` (Rust Cargo workspace), `/web` (React), `/ios` (Swift), `/android` (Kotlin), `/ops` (Compose/Traefik/OpenSLO/runbooks), `/docs` (ADRs/HANDOFF/MISTAKES-LEDGER), `/openapi` (the contract — single source of truth that generates web + both native clients), `/templates` (golden Excel files + fixtures). **Pros:** one OpenAPI contract atomically versioned with all four consumers (critical for parity); atomic cross-cutting commits; one CI; branch-scoped everything literally lives on one branch per the "branch-scoped" principle wording for code too. **Cons:** large checkout; native toolchains (Xcode/Gradle) coexist with Cargo.
- **Polyrepo:** separate repos per deliverable. **Pros:** clean toolchain isolation. **Cons:** OpenAPI contract drift across repos is exactly the parity-drift failure mode we must prevent; cross-cutting changes need coordinated multi-repo PRs. **Invalidated** primarily by parity-drift driver — the contract MUST be atomic with its consumers.

**SELECTION: Monorepo**, with `/openapi/openapi.yaml` (utoipa-emitted, committed) as the single contract that generates `/web`, `/ios`, `/android` clients in CI. Parity is structurally enforced because all four consumers move with one commit.

---

## 2. Architecture

### 2.1 Cargo workspace — modular monolith, per-domain crates (oyatie-style layering)

Layering (compiler-enforced dependency direction; illegal edges fail a CI layer gate):

```
domain  ←  application  ←  adapter  ←  { rest, worker }  ←  app
```

- `domain` crates: pure entities, value objects, state machines, transition tables, domain errors. NO async, NO sqlx, NO axum. Deterministic, exhaustively unit-tested.
- `application` (usecase) crates: orchestrate domain + ports (traits). Define repository/port traits here. NO concrete adapters.
- `adapter` crates: concrete implementations of ports — `-adapter-postgres` (sqlx), `-adapter-seaweed` (S3), `-adapter-apns`/`-adapter-fcm`, `-adapter-alimtalk`. Named with backend suffix per oyatie convention.
- `rest` crates: Axum routers, utoipa OpenAPI annotations, DTOs. `worker` crates: apalis job handlers, LISTEN/NOTIFY subscribers, escalation timers.
- `app` crate(s): composition root — wires ports to adapters, builds the router, boots the worker runtime, reads config.

Workspace member glob (oyatie-style), under `/backend`:

```
[workspace]
members = [
  "crates/kernel/*",         # mnt-kernel-* : shared kernel (ids, time, audit-event type, error, trace)
  "crates/<domain>/*",       # mnt-<domain>-{domain,application,adapter-postgres,rest,worker}
  "crates/platform/*",       # mnt-platform-{auth,authz,storage,push,realtime,excel}
  "ci/gates/*",              # CI gate binaries (audit-coverage, layer-boundary, etc.)
  "app",                     # mnt-app : composition root binary
]
```

Domains (per-domain crate families — naming `mnt-<domain>-<layer>`):
- `workorder` (16-state FSM, assignments, approvals, target-change, daily-plan)
- `dispatch` (P1 broadcast, accept-window, GPS scoring, escalation)
- `compliance` (location consent ledger, location pings, destruction automation)
- `registry` (equipment master, customer/site, substitute matching)
- `messenger` (threads, messages, read receipts, channels)
- `reporting` (daily-status 일일현황, work-diary 업무일지, KPI 7종)
- `financial` (rental quote, purchase/expenditure approval chain)
- `identity` (local users/roles/devices, passkeys; Bitween port)
- `inspection` (예방점검 regular-inspection schedules/rounds)

Platform crates (cross-cutting, port + adapter pairs):
- `platform-auth` (webauthn-rs passkey ceremonies, JWT issue/verify, refresh-token family)
- `platform-authz` (branch-scoped authorization policy engine)
- `platform-storage` (S3 port + SeaweedFS adapter + OCI WORM replication verifier)
- `platform-push` (push port + APNs/FCM/Alimtalk adapters)
- `platform-realtime` (WebSocket hub port + per-connection mpsc + LISTEN/NOTIFY bridge)
- `platform-excel` (template-fidelity export engine)

Kernel crate `mnt-kernel-*`: `AuditEvent` type, `BranchId`/`Tenant` scope types, typed IDs, `TraceContext`, error taxonomy, transition-result type. Everything depends inward on kernel.

### 2.2 Audit-first transaction discipline
The kernel exposes a `with_audit` transactional helper: `tx → SELECT ... FOR UPDATE → domain.validate_transition() → UPDATE → INSERT audit_events(actor, target_type, target_id, action, before_json, after_json, trace_id, ts) → COMMIT`. Application-layer use-cases MUST route every state mutation through it. The `audit-coverage` CI gate statically asserts that every handler annotated as state-changing constructs an `AuditEvent`. `audit_events` is append-only (no UPDATE/DELETE grant; enforced by a migration-safety check).

**FSM clarification (per Critic).** Two distinct state machines exist and must not be conflated: (1) the **WorkOrder FSM = the 16 inherited states** (`RECEIVED…CANCELLED`), in the `workorder` domain; (2) the **P1 broadcast accept-window FSM** (`BROADCASTING / AUTO_ASSIGNED / MANAGER_FORCE_PENDING`), which lives in the SEPARATE `dispatch` domain and governs the dispatch lifecycle of a P1, not the WorkOrder's lifecycle state. A P1 WorkOrder still walks the 16-state WO FSM; the dispatch FSM is an orthogonal overlay that resolves *who* gets assigned.

**CRITICAL compliance carve-out — LocationPing is NOT routed through `with_audit` (per Critic MUST).** Appending raw GPS coordinates into the append-only, never-deleted `audit_events` store would (a) directly violate 위치정보법 destruction-on-withdrawal (audit is by design indestructible) and (b) bloat the audit store. Therefore:
- **LocationPing** rows live in a SEPARATE, *destructible*, partitioned/TTL'd store (`location_pings`, range-partitioned by day) — NOT in `audit_events`. An enforced retention-purge job drops expired partitions and is the mechanism that makes withdrawal-destruction and on-duty-only collection physically realizable.
- **Consent lifecycle events** (grant / withdraw / suspend / resume) ARE audited via `with_audit` — these are non-PII control events the regulator expects to be provable. The *coordinates* are not audited; the *fact and time of consent change* is.
- A CI/lint rule asserts no code path writes coordinate fields into `audit_events`.

### 2.3 Branch-scoped authorization model
- Every operational row carries non-null `branch_id` (FK → `branches`); `branches` has `region_id` (FK → `regions`) for region rollups; `regions` belongs to company.
- `platform-authz` evaluates `(actor_roles, actor_branch_scope, resource_branch_id, action)`:
  - `MECHANIC`/`RECEPTIONIST`: own branch only.
  - `ADMIN`: assigned branch(es) (UserBranch membership) — manage, approve, KPI within scope.
  - `EXECUTIVE`: read-only across permitted branches + cross-branch rollups.
  - `SUPER_ADMIN`: all branches.
- Default-deny: queries are branch-filtered at the repository boundary; a missing scope check is a test failure. Authorization tests assert cross-branch reads/writes are rejected and that SUPER_ADMIN/EXECUTIVE rollups span branches.
- Roles: 5 from prior project (`SUPER_ADMIN, ADMIN, MECHANIC, RECEPTIONIST, EXECUTIVE`); 예방점검팀 modeled as a `team` attribute (정비/예방) on the user + the `inspection` domain, NOT a 6th role (matches prior project; spec allows either — choosing attribute to avoid role-matrix explosion).

### 2.4 P1 broadcast engine design
- **Branch-scoped fan-out:** on P1 registration, resolve the equipment's `branch_id` → push to that branch's (+ region, configurable) on-duty technicians + managers within ≤5s server-side.
- **Accept-window state machine** (in `dispatch` domain): `BROADCASTING → (collect accept/decline/timeout responses) → {AUTO_ASSIGNED | MANAGER_FORCE_PENDING}`. Configurable timers (defaults: accept-window 5min, force-assign alert 10min, Alimtalk at no-ack 2min) live in config, not code.
- **GPS scoring:** `score = f(live_gps_distance, current_work_priority_weight)`; ≥2 accepts → auto-assign by best score. Technicians without a valid LocationConsent record are NOT GPS-ranked → fall back to schedule-based ranking (compliance interlock).
- **Escalation timers:** apalis-scheduled jobs (behind a `JobQueue` trait so apalis is swappable). Timer fire → re-evaluate state → escalate (push → Alimtalk → 관리자 유선 alert). 0 accepts after N min → manager force-assign alert.
- **Alimtalk adapter:** `platform-push` Alimtalk adapter via aggregator (Solapi/NHN, ~13 KRW/건). Best-effort; the in-app ACK loop is the source of truth for delivery, not push receipts.
- Assigned tech's today-list updates immediately (realtime push + offline-queue reconcile).

### 2.5 Full-messenger design (audit-grade, NOT E2EE)
- **Postgres-persisted source of truth:** message is INSERTed (+ audit row) BEFORE any fan-out. The broadcast channel is NEVER the source of truth.
- **Per-connection mpsc + LISTEN/NOTIFY bridge:** each WS connection owns an mpsc receiver; a per-instance `pg LISTEN` task receives `NOTIFY message_posted` and routes to local subscribers' mpsc senders → multi-instance correct (any instance's NOTIFY reaches subscribers on any instance). `platform-realtime` hub is a trait so the bridge is swappable for a future broker.
- **NOTIFY payload discipline (per Critic):** NOTIFY payloads carry **IDs only** (e.g. `{message_id, thread_id, branch_id}`), NEVER message bodies. Postgres caps NOTIFY payloads at 8000 bytes; an ID-only payload stays far under that ceiling (a hard assertion in `platform-realtime` rejects oversize payloads at build/test time). On receipt, subscribers **re-read the authoritative row from Postgres** by ID — so the message body is never trusted from the transient channel, consistent with persist-before-fanout.
- **Channel kinds:** WO-thread (auto-created per 접수건), team channel (branch-scoped), 1:1 DM, group. Read receipts persisted. Full-text search (Postgres FTS / `tsvector`). Media via presigned S3 URLs (same evidence pipeline). Every message lands in the audit store; audit access is itself role-gated and audited.

### 2.6 Evidence pipeline (presigned → SeaweedFS → OCI WORM verify)
- Mobile capture → local offline queue → request presigned PUT URL from API → client uploads directly to SeaweedFS (S3 port) → server records `EvidenceMedia{stage, s3_key, worm_replica_status=PENDING}`.
- A `worker` job replicates the object to OCI Object Storage (S3-compat, retention-locked / COMPLIANCE mode) and **verifies** the replica (HEAD + object-lock metadata) → flips `worm_replica_status=VERIFIED`. Unverified evidence is flagged.
- **WORM negative-path behavior (per Critic SHOULD #11):** replication is retried with bounded exponential backoff (worker job, max N attempts). While `worm_replica_status ∈ {PENDING, FAILED}`: the evidence is usable in-app but the **WorkOrder cannot transition to FINAL_COMPLETED** if it carries any unverified AFTER/REPORT-stage evidence — a domain interlock (completion approval checks WORM-verified status of required evidence). Persistent FAILED after max retries raises an operational alert (OpenSLO burn) and surfaces on an "unverified evidence" admin queue; it never silently drops. The interlock and the alert are both tested (T1.4 acceptance extended below).
- SeaweedFS hardened: no Filer/Admin UI exposed, pinned (slightly aged) releases, generic S3 port only. Own WORM retention test suite (put → attempt delete/overwrite under COMPLIANCE → expect denial) runs in CI against a pinned SeaweedFS container. RustFS re-evaluated at GA (~2026-07) — recorded as an ADR follow-up, not a launch dependency.

### 2.7 Passkey flows (webauthn-rs 0.5.x)
- Phone apps are WebAuthn anchors (platform authenticators). Desktop login via platform authenticator (Touch ID / Windows Hello) or cross-device hybrid (QR) WebAuthn. Password/OTP fallback for older devices.
- RP-domain hosting of `apple-app-site-association` (AASA) + `assetlinks.json`; Android apk-key-hash origins registered for BOTH debug and release/Play-signing keys.
- Tokens: short-lived access JWT (ES256/EdDSA) + opaque rotating refresh tokens with **family reuse-detection** → reuse triggers family revocation (tested). `platform-auth`.

### 2.8 Excel export engine (template-fidelity strategy)
**Decision: `umya-spreadsheet` 3.0.0 (template-fill), NOT `rust_xlsxwriter` 0.95.0 (generate-from-scratch).** Verified live 2026-06-11: `rust_xlsxwriter` is write-only (no read/template support); `umya-spreadsheet` reads AND writes existing xlsx, so it can LOAD the golden `일일업무진행현황_0605.xlsx`, fill the data cells, and emit — preserving the exact 양식 (merged cells, styin, the ◈ header, the 4 sections 실적/계획/미결누적/정기검사, Priority#N Warning column) that an acceptance criterion demands byte-fidelity for. `rust_xlsxwriter` would force re-creating all styling by hand and still risk drift.
- **Strategy:** keep the authoritative templates in `/templates` as golden files. The engine loads the template workbook, writes only the data ranges, and exports. A golden-file regression test asserts structural fidelity (sheet name `6월05일`-pattern, section headers, merged-cell map, column layout) against a checked-in expected workbook. Same approach for 업무일지 (2-column 전일실적/금일예정 + 순회점검 + 긴급조치 + monthly-plan calendar sheet) and the master-list-derived exports.
- **Verified template facts (re-inspected 2026-06-11, per Critic MUST #1):** `일일업무진행현황_0605.xlsx` has ONE worksheet `6월05일`, dimension **A1:AH97**, with **16 merged cells** (NOT 143 — the 143-merge sheet is 업무일지's `2026.05월(계획)` monthly-plan calendar, sheet 3, dim A1:Q50). 업무일지 sheets: sheet1 `05월 27일` A1:AL151 / 59 merges; sheet2 battery-result A1:AD35 / 25 merges; sheet3 monthly-plan A1:Q50 / 143 merges. The M0 viability spike (T0.10) round-trips the REAL 일일현황 file and asserts the 16-merge map + ◈ glyph + 4-section headers (실적/계획/미결누적/정기검사) + column layout, deciding the umya-vs-hybrid path BEFORE M4 commits to it.
- Risk noted for Architect: umya-spreadsheet template round-trip can drop some advanced styling; the golden-file test (and the M0 spike) is the guard, and a fallback hybrid (umya for layout + targeted cell-style preservation, or rust_xlsxwriter rebuild of the worst sheets) is the contingency — **the contingency is decided in M0, not deferred to M4.**

### 2.9 Repo layout for the 4 deliverables (monorepo — selected)
```
/ (monorepo root)
  /backend         Rust Cargo workspace (modular monolith, §2.1)
  /web             React + TS strict, shadcn/ui + Tailwind v4, TanStack Table, Gantt/kanban/map
  /ios             Swift / SwiftUI native
  /android         Kotlin / Compose native
  /openapi         openapi.yaml (utoipa-emitted, committed) → generates web + ios + android clients in CI
  /ops             docker-compose.prod.yml, Traefik, OpenSLO files, runbooks, backup/restore
  /docs            decisions/ (ADRs), HANDOFF.md, MISTAKES-LEDGER.md, registry/catalog YAML
  /templates       golden Excel files + golden-file test fixtures
```

### 2.10 Live-verified stack versions (re-verify at each `cargo add`)
Verified on crates.io 2026-06-11: **axum 0.8.9**, **tower-http 0.6.11**, **sqlx 0.9.0**, **utoipa 5.5.0**, **apalis 1.0.0-rc.9** (pinned RC per spec; isolate behind `JobQueue` trait — RC soak criterion gates M2, see T1.9), **webauthn-rs 0.5.5** (stable; 0.6 is `-dev`, do not use), **jsonwebtoken 10.4.0**, **umya-spreadsheet 3.0.0** (Excel template-fill), **rust_xlsxwriter 0.95.0** (rejected for fidelity; available if a write-from-scratch export is later needed).
- **APNs push decision (M1 — per Critic SHOULD #13):** compare **`a2` 0.10.0** (last published 2024-05 — staleness/maintenance risk) vs **`apns-h2` 0.11.0** (verified published 2026-02-09 — actively maintained). Default lean: `apns-h2` for currency, but the decision is made at M1 `cargo add` time behind the `platform-push` APNs port (the port makes the choice swappable, so this never blocks). FCM HTTP v1: own thin client or current `fcm`-family crate, verify at add-time. ADR-0013 records the chosen APNs crate + rationale.

### 2.11 Integration seams (ports only — NO mock adapters)
- **oyatie AI port:** `inspection`/`workorder` application layer defines an `AiAssistantPort` trait (symptom+model → 점검절차; auto-report). NO adapter ships at launch. The feature is absent until oyatie cloud intelligence is ready. Port shape only.
- **Bitween identity port:** `identity` defines an `IdentityProviderPort` (roster/attendance/SSO). Local accounts at launch; SSO bridge later. NO mock adapter — local identity is the real, complete implementation; the port is the future seam.

### 2.12 Notification type → channel mapping (inherited 15 types — per Critic gap #15)
The prior project's 15 notification types are carried forward and explicitly mapped to delivery channels. Channels: **in-app** (realtime + notification center), **push** (APNs/FCM, best-effort), **Alimtalk** (escalation only, ~13 KRW/건). P1 is the only flow with a guaranteed-delivery ACK loop; everything else is in-app + best-effort push.

| # | Notification type | in-app | push | Alimtalk | Notes |
|---|-------------------|:--:|:--:|:--:|-------|
| 1 | `NEW_WORK_ORDER` | ✓ | ✓ | — | to branch RECEPTIONIST/ADMIN |
| 2 | `PRIORITY_URGENT` (P1) | ✓ | ✓ | ✓ | the P1 ACK-loop flow (T2.4/T2.5); Alimtalk on no-ack escalation |
| 3 | `ASSIGNED` | ✓ | ✓ | — | to assigned tech(s) 주/부 |
| 4 | `TARGET_DUE_SOON` | ✓ | ✓ | — | timer-driven |
| 5 | `TARGET_OVERDUE` | ✓ | ✓ | — | timer-driven |
| 6 | `DELAYED` | ✓ | ✓ | — | with DelayReason |
| 7 | `TARGET_CHANGE_REQUESTED` | ✓ | ✓ | — | tech→admin |
| 8 | `TARGET_CHANGE_REVIEWED` | ✓ | ✓ | — | admin→tech |
| 9 | `DAILY_PLAN_REQUESTED` | ✓ | — | — | in-app queue |
| 10 | `DAILY_PLAN_REVIEWED` | ✓ | ✓ | — | admin→tech |
| 11 | `REPORT_SUBMITTED` | ✓ | — | — | to admin review queue |
| 12 | `REPORT_APPROVED` | ✓ | ✓ | — | admin→tech |
| 13 | `REPORT_REJECTED` | ✓ | ✓ | — | admin→tech |
| 14 | `COMMENT_ADDED` | ✓ | ✓ | — | thread participants |
| 15 | `FOLLOW_UP_DUE` | ✓ | ✓ | — | TEMPORARY_ACTION follow-up timer |

All notification emissions are branch-scoped and audited (the emission event, not necessarily a push receipt). Implemented as a `notification` concern spanning `workorder`/`dispatch` application layers + `platform-push`; mapping table is config-driven so channel routing per type is tunable without code change.

---

## 3. Phased Task Breakdown

Every milestone ends in shippable, production-complete, tested functionality. NO stubs/placeholders/demo modes. Ordered by dependency. Size: S (≤2d), M (≤1wk), L (>1wk). Per-slice client sequencing: web + Android first, iOS within the same milestone before the milestone is "released" (parity gate is per-release).

### M0 — Platform spine (foundation; ends shippable: a real authenticated, audited, branch-scoped "hello" health surface deployed on OCI)

> **M0 parallelism (per Architect r2 synthesis):** T0.10 (Excel spike), T0.11 (compliance core), and T0.13 (DR) sit on disjoint dependency subtrees (→T0.1, →T0.3, →T0.7/T0.9) and run as concurrent M0 sub-tracks alongside the auth/Compose spine — compressing M0 wall-clock without weakening any gate.
| ID | Description | Acceptance criteria (testable) | Deps | Size |
|----|-------------|-------------------------------|------|------|
| T0.1 | Monorepo + Cargo workspace skeleton with layering + kernel crate (AuditEvent, BranchId, typed IDs, TraceContext, error taxonomy) | `cargo build` green; kernel unit tests pass; no domain crate depends on sqlx/axum (asserted by layer gate) | — | M |
| T0.2 | CI layer-boundary gate (illegal dependency edge fails build) + manifest hygiene + `mnt-` prefix gate | A deliberately-illegal `domain → adapter` edge in a fixture fails CI; passes when removed | T0.1 | M |
| T0.3 | Postgres schema v1 + `branches`/`regions`/`users`/`audit_events` + sqlx migrate; `with_audit` transactional helper | `#[sqlx::test]` proves audit row written in same tx as a state change; rollback drops both atomically | T0.1 | M |
| T0.4 | `audit-coverage` CI gate + `db-migration-safety` gate + `pii-no-logs` gate | audit-coverage fails on a state-changing handler with no AuditEvent (fixture); migration-safety rejects a DROP/UPDATE-grant on audit_events; pii-no-logs flags a logged GPS coord/phone (fixture). **Gate/carve-out reconciliation (per Architect r2 #1): the audit-coverage gate's state-changing set explicitly EXCLUDES the LocationPing ingestion path (§2.2 carve-out), and a test asserts this carve-out is the ONLY exclusion** | T0.3 | M |
| T0.5 | `platform-auth`: passkey register+login (platform + cross-device QR), JWT ES256/EdDSA, rotating refresh tokens w/ family reuse-detection; AASA + assetlinks.json hosting | E2E: register+login on desktop browser passkey; refresh-token reuse triggers family revocation (test); AASA/assetlinks served at RP domain | T0.3 | L |
| T0.6 | `platform-authz` branch-scoped policy engine + default-deny repository filter | Authorization tests: cross-branch read/write denied; SUPER_ADMIN spans branches; ADMIN limited to UserBranch scope | T0.3 | M |
| T0.7 | OCI Compose prod stack: Traefik HTTPS, Postgres, SeaweedFS, app + worker; health/readiness probes; graceful shutdown; OTel wired | `docker compose up` from clean checkout boots in one command; probes green; an OTel trace spans REST→worker; SeaweedFS reachable only via S3 port (no Filer/Admin UI) | T0.1 | L |
| T0.8 | Observability baseline: OTel traces+structured logs; OpenSLO files (availability+latency); audit access role-gated and itself audited | Trace visible end-to-end; OpenSLO files validate; accessing audit log emits an audit event | T0.7 | M |
| T0.9 | Backup/restore runbook: nightly Postgres + SeaweedFS backup; restore drill | Restore runbook executed against a scratch env restores data; documented in `/ops` | T0.7 | M |
| T0.10 | **Excel byte-fidelity viability spike** (front-loaded per Critic MUST #1): umya-spreadsheet 3.0.0 round-trips the REAL `docs/reference/일일업무진행현황_0605.xlsx`, fills sample data, re-emits | Asserts post-round-trip: sheet `6월05일`, dim A1:AH97, **16-merged-cell map preserved**, ◈ glyph intact, 4-section headers (실적/계획/미결누적/정기검사) present, column layout intact, vs golden file. If umya fails any assertion → **hybrid/contingency path decided and recorded (ADR-0008) in M0** | T0.1 | M |
| T0.11 | **Compliance core decoupled from app delivery** (per Critic MUST #2): `compliance` domain LocationConsent ledger (grant/withdraw/suspend/resume) + LocationPing destructible store + destruction-on-withdrawal + retention-purge job — proven as pure domain + Postgres, NO client UI | `#[sqlx::test]`: withdrawal destroys all location_pings + collection logs for user; retention-purge drops expired day-partitions; consent lifecycle events audited (coords NOT audited); ping volume bounded (acceptance: rows ≤ on-duty-window × ping-rate × users). Deps M0 ONLY — does not wait on mobile | T0.3 | L |
| T0.12 | **300+ user provisioning + passkey cold-start** (per Critic MUST #6): bulk roster provisioning, OTP/temp-credential bootstrap, bulk passkey enrollment flow | A net-new zero-credential user bootstraps via temp credential → enrolls a passkey → temp credential auto-revoked; bulk import of N users idempotent (re-run = no-op); branch/role assigned from roster | T0.5 | M |
| T0.13 | **DR hardening** (per Critic MUST #5): explicit RPO/RTO targets; Postgres WAL archiving + continuous PITR (not nightly-only); VM-down emergency-dispatch fallback runbook | Documented **RPO ≤ 5min (PITR), RTO ≤ 1h**; PITR restore drill to an arbitrary timestamp succeeds; VM-down runbook defines in-flight-P1 behavior (manual 유선 dispatch fallback + Alimtalk while system down); **rehearsal produces a timestamped drill log under `docs/evidence/` recording manual-dispatch time-to-first-contact for a simulated in-flight P1 (per Architect r2 #2)** | T0.7, T0.9 | M |

### M1 — Registry + WO core vertical slice (ends shippable: real WO lifecycle end-to-end, web + Android + iOS, with evidence + approval + audit)
| ID | Description | Acceptance criteria | Deps | Size |
|----|-------------|---------------------|------|------|
| T1.1 | `registry` domain+adapters: equipment master (parse master-list_251120.xlsx fields: 장비No/호기/model/VIN/ton/규격/동력/상태/hours/차량가액/잔존가/임대료/사업장), customer/site, branch FK. **Idempotent upsert importer keyed on 장비No/호기 + reconciliation report** (per Critic MUST #9) | Master list (465 units) imports; equipment queryable by 호기→model; `#[sqlx::test]` per repo. **Re-import of the same file = no-op (0 changes); importer emits reconciliation report (added / updated / unchanged / orphaned counts); upsert is keyed on 장비No/호기 so re-runs are safe** | M0 | L |
| T1.2 | `workorder` domain: 16-state FSM + explicit transition table; Priority(P1/P2/P3/OUTSOURCE/UNSET); DelayReason(8); illegal transitions rejected at domain layer | Unit test for EVERY transition (legal accepted, illegal rejected); states match prior project (RECEIVED…CANCELLED) | T1.1 | L |
| T1.3 | WO application+rest: 접수 intake, assignment (2인작업 주/부), approval gates (계획/완료/외주), target-change flow, daily-work-plan flow (DRAFT→FINAL_CONFIRMED); all via `with_audit` | Each transition writes audit row; OpenAPI emitted to `/openapi`; authz branch-scoped | T1.2, M0 | L |
| T1.4 | Evidence pipeline: presigned upload → SeaweedFS → OCI WORM replicate+verify; EvidenceMedia stages (REQUEST/BEFORE/DURING/AFTER/REPORT/OUTSOURCE_RESULT); **WORM negative-path interlock** (§2.6) | Upload via presigned URL; worm_replica_status flips to VERIFIED; WORM retention suite passes vs pinned SeaweedFS. **Completion interlock tested: WO with unverified AFTER/REPORT evidence cannot reach FINAL_COMPLETED; persistent replication FAILED after max retries raises alert + lands on unverified-evidence admin queue (never silent-drops)** | M0, T1.3 | L |
| T1.5 | Web console slice: 접수 입력 form, dispatch board (Gantt+kanban+map), approval queue — React strict, shadcn/Tailwind v4, Pretendard, KS X ISO 8601, WCAG AA, 48dp targets | Receptionist creates WO; admin approves; board renders WO; generated OpenAPI client | T1.3 | L |
| T1.6 | Android (Compose) slice: today's to-do, start work, write report, capture evidence, OFFLINE queue (device-hash + request-ID dedup, idempotent /sync), native push, passkey | Offline: view jobs, start, report, capture with no connectivity; reconnect syncs idempotently; per-item synced/pending indicators | T1.3, T1.4, T0.5 | L |
| T1.7 | iOS (SwiftUI) slice: feature-parity with Android slice (same capabilities) | Passes the iOS/Android parity checklist; CI builds both apps from the tagged commit | T1.6 | L |
| T1.8 | Parity checklist + CI dual-build gate | CI builds ios+android from tagged commit; parity checklist enforced as a release gate | T1.6, T1.7 | M |
| T1.9 | **OpenAPI client generation in CI** (per Critic MUST #4): generate `{ts, swift, kotlin}` clients from `/openapi/openapi.yaml` (emitted by T1.3) | All three generated clients **compile**; each round-trips a sample request/response against the running app in CI (contract test); CI fails if the committed openapi.yaml drifts from utoipa output. This is the structural backbone of the parity guarantee | T1.3 | M |
| T1.10 | **apalis 1.0-rc soak harness** (per Critic MUST #10) — gates entry to M2 | N escalation timers fire within tolerance under: worker restart mid-window, ±clock-skew, and crash-recovery (no lost/duplicate fire beyond idempotency). **M2 may not start until this passes** (de-risks the RC dependency before P1 depends on it) | T1.3 | M |
| T1.11 | **Mobile distribution pipeline** (per Critic MUST #8): TestFlight + Play internal track; code-signing + provisioning profiles (debug + release/Play); App Store review lead-time sequenced before pilot | A tagged build reaches TestFlight (iOS) and Play internal track (Android) automatically; signing keys registered (matches passkey apk-key-hash origins, T0.5); App Store review submission lead-time accounted for in the pilot schedule | T1.7 | M |
| T1.12 | **i18n-ready resource structure** on all 3 clients (per Critic gap #16): Korean-only content, externalized string resources, no hardcoded UI strings | Web/iOS/Android use resource files (not literals) for all user-facing strings; a lint/check flags hardcoded UI strings; structure ready for future locale add (content stays Korean-only) | T1.5, T1.6, T1.7 | S |

### M2 — P1 broadcast dispatch + compliance (ends shippable: full P1 emergency flow with live GPS, legally compliant)
**M2 entry gate:** T1.10 (apalis RC soak) must pass before M2 begins — P1 escalation depends on the RC job runtime.

| ID | Description | Acceptance criteria | Deps | Size |
|----|-------------|---------------------|------|------|
| T2.1 | **Consent UI only** (compliance core already built+tested in T0.11): wire the LocationConsent/LocationPing domain to clients | Domain interlocks (destruction-on-withdrawal, ping carve-out from audit, retention-purge) already proven in T0.11; this task only adds the client surface — consent ledger exportable from web | T0.11 | S |
| T2.2 | **위치정보법 consent UI** (web + both natives): always-visible non-refusable in-app GPS off switch; per-employee individual consent capture; on-duty-only collection | Consent recorded per employee; off-switch always visible & functional on all 3 clients; on-duty-only enforced; withdrawal from any client triggers T0.11 destruction path | T0.11, T1.6, T1.7 | M |
| T2.3 | **KCC LBS 사업 신고** legal review (BUSINESS ACTION — launch-blocking, multi-week lead) | 신고 filed / legal sign-off documented in `/ops` compliance folder before go-live; **started early (deps T0.11 only) given lead time** | T0.11 | S |
| T2.4 | `dispatch` domain+worker: P1 broadcast accept-window FSM (BROADCASTING/AUTO_ASSIGNED/MANAGER_FORCE_PENDING — separate from WO FSM), branch/region fan-out ≤5s, GPS×priority scoring, ≥2-accept auto-assign, escalation timers (apalis behind JobQueue trait), Alimtalk adapter | E2E multi-client sim: 등록→branch techs pushed ≤5s→accept/decline countdown→≥2 accepts auto-assigns by score→0 accepts→manager force-assign alert + Alimtalk; assigned today-list updates immediately | T0.11, T1.10, T1.3 | L |
| T2.5 | Alimtalk + 관리자 유선 escalation chain; configurable timers | Escalation fires push→Alimtalk→manager alert per configured timers; timers config-driven (test) | T2.4, T2.6 | M |
| T2.6 | **Alimtalk template pre-approval** (BUSINESS ACTION — per Critic MUST #7, multi-day Kakao lead time; modeled like KCC 신고): draft + submit P1-escalation Alimtalk templates to Kakao via aggregator; await approval | Approved 템플릿 IDs registered in config before T2.5 can send; **dependency-linked to T2.5** so the escalation chain cannot ship un-templated; submission lead-time sequenced into M2 schedule | T0.11 | S |

### M3 — Full messenger (ends shippable: audit-grade in-app messenger across clients)
| ID | Description | Acceptance criteria | Deps | Size |
|----|-------------|---------------------|------|------|
| T3.1 | `messenger` domain+adapters: Postgres-persisted messages (persist-before-fanout), WO-thread auto-create per 접수건, team/DM/group channels (branch-scoped), read receipts, FTS | Message persisted+audited before fan-out; WO thread auto-created; FTS search returns hits; every message in audit store | M0, T1.3 | L |
| T3.2 | `platform-realtime`: per-connection mpsc + LISTEN/NOTIFY bridge (multi-instance correct); WS hub behind trait; **IDs-only NOTIFY payloads** (§2.5) | Two app instances: NOTIFY on instance A reaches subscriber on instance B (integration test); **NOTIFY payload is IDs-only and asserted < 8000-byte ceiling (oversize rejected at test time); subscriber re-reads message body from Postgres by ID** | T3.1 | L |
| T3.3 | Messenger clients: web + Android + iOS (threads, channels, read receipts, search, media via presigned URLs) | Parity across 3 clients; media upload reuses evidence pipeline; read receipts sync | T3.1, T3.2, T1.7 | L |

### M4 — Reporting & KPI automation (ends shippable: exact-format Excel exports + KPI dashboards)
| ID | Description | Acceptance criteria | Deps | Size |
|----|-------------|---------------------|------|------|
| T4.1 | `platform-excel` engine (umya-spreadsheet 3.0.0 template-fill) | Golden-file test: loads template, fills data, emits — structural fidelity asserted | M0 | M |
| T4.2 | 일일업무진행현황 export (4 sections 실적/계획/미결누적/정기검사; Priority#N Warning col) | Reproduces `docs/reference/일일업무진행현황_0605.xlsx` 양식 exactly vs golden file; downloadable from web console | T4.1, T1.3 | M |
| T4.3 | 업무일지 auto-generation (2-col 전일실적/금일예정 + 순회점검 + 긴급조치 점검/조치 + monthly-plan calendar sheet); editable before manager confirm; exportable | Auto-generated daily from completed WO data; editable; export matches `업무일지_26.05.27.xlsx` format | T4.1, T1.3 | M |
| T4.4 | KPI 표준 7종 on approval-timestamp basis with KpiExclusion honored | Golden-dataset test per metric; exclusion (WORK_ORDER/OUTSOURCE scope) honored | T1.3 | M |
| T4.5 | Web: KPI executive dashboard (technician→branch→region→company rollups) + wall-board kiosk mode (auto-refresh, large type, exception strip) | EXECUTIVE sees cross-branch rollups; wall-board auto-refreshes | T4.4, T1.5 | M |

### M5 — Registry substitute-matching + Financial (ends shippable: substitute matching, rental quoting, purchase chain)
| ID | Description | Acceptance criteria | Deps | Size |
|----|-------------|---------------------|------|------|
| T5.1 | Substitute matching: down unit → 예비 units filtered by ton/규격(입식·좌식)/동력 + current location/status | Given a down unit, lists matching 예비 units with location/status | T1.1 | M |
| T5.2 | `financial` rental quote: configurable formula (취득가/잔존가/감가상각 정액·정률/수선비 이력/관리비율/이윤율) → itemized quote; handle negative 잔존가 | Itemized quote produced; formula configurable; negative residual handled (test); validate with 경리 using 예비차량 sheet | T1.1 | M |
| T5.3 | 정비비용 집행 → equipment cost ledger → recompute 잔존가액 per configured depreciation | Cost execution updates ledger and recomputes residual (test) | T5.2 | M |
| T5.4 | Purchase workflow: 거래명세표 첨부 → 구매요청서 → 승인 → 지출결의서 → 승인 → 집행기록; each step role-gated + audited; thresholds configurable | Each step role-gated + audited; threshold-based 임원 final approval (config) | T1.3 | M |

### M6 — Integration seams + launch hardening (ends shippable: production launch-ready)
| ID | Description | Acceptance criteria | Deps | Size |
|----|-------------|---------------------|------|------|
| T6.1 | oyatie `AiAssistantPort` trait definition (NO adapter) | Port compiles; documented; no mock adapter present | M0 | S |
| T6.2 | Bitween `IdentityProviderPort` trait definition (local identity is the real impl; port is future seam, NO mock) | Port compiles; local identity complete & tested; SSO bridge deferred | M0 | S |
| T6.3 | CI quality-gate full suite green: db-migration-safety, pii-no-logs, audit-coverage, WORM retention suite, layer-boundary, parity, dual-build | All gates green on main; documented in `/docs` | all | M |
| T6.4 | inspection domain: 예방점검 RegularInspectionSchedule + rounds (feeds 정기검사 section + 업무일지 순회점검) | Schedules drive 정기검사 export section + 순회점검 diary; 예방 team flow works | T1.2, T4.2 | M |
| T6.5 | Final compliance + go-live checklist: consent destruction verified, KCC 신고 done, backup/restore drilled, OTel/OpenSLO live | Go/no-go checklist all green | all | S |

---

## 4. Pre-mortem (DELIBERATE mode — REQUIRED)

### Scenario ① — Dual-native parity drift halts releases
**Failure:** iOS perpetually trails Android; a release can't ship because parity checklist fails repeatedly; features diverge subtly (offline behavior, push, passkey edge cases).
**Mitigations baked into tasks:** single committed OpenAPI contract generates BOTH native clients (T1.3 emits, monorepo §2.9 keeps it atomic); per-slice client sequencing (web+Android first, iOS same milestone) bounds WIP (Option C); CI dual-build gate + parity checklist as a hard release gate (T1.8, T6.3); shared design tokens. A slice is NEVER "released to a branch" until both natives pass parity — so drift can delay a release but can never ship a broken one.

### Scenario ② — 위치정보법 violation via location-data retention bug
**Failure:** a withdrawn-consent user's location rows aren't destroyed, or off-switch leaves a leak, or GPS logged in plaintext → criminal exposure.
**Mitigations baked into tasks:** consent is a first-class domain with destruction automation tested (T2.1 — withdrawal destroys rows + logs, off-switch ≤1 ping); always-visible non-refusable off switch on all 3 clients (T2.2); `pii-no-logs` CI gate flags any logged coord/phone (T0.4); without-consent → not GPS-rankable interlock in dispatch scoring (T2.4); KCC LBS 신고 as an explicit launch-blocking business task (T2.3); consent ledger exportable for audit (T2.1); final compliance verification gate (T6.5).

### Scenario ③ — P1 push non-delivery during a real emergency / WebSocket fan-out loss
**Failure:** a P1 emergency push is silently dropped (APNs/FCM best-effort), or a WS message is lost because the broadcast channel was treated as source of truth, and no one is dispatched.
**Mitigations baked into tasks:** push is explicitly best-effort — the in-app ACK loop with timed escalation is the source of truth (T2.4/T2.5: push→Alimtalk→관리자 유선); messages/state persisted to Postgres BEFORE fan-out, never broadcast-channel-as-truth (T3.1, §2.5); IDs-only NOTIFY + re-read-from-Postgres means a missed/oversize channel event never loses data (T3.2); LISTEN/NOTIFY bridge makes fan-out multi-instance-correct (T3.2); 0-accept → manager force-assign alert path (T2.4); apalis RC soak-gate proves timers fire under restart/skew/crash before P1 depends on them (T1.10); Alimtalk templates pre-approved so escalation can't be blocked by Kakao lead time (T2.6); the **VM-down emergency-dispatch fallback runbook (T0.13)** defines manual 유선 + Alimtalk dispatch for in-flight P1s while the system is down; E2E multi-client simulation proves the whole escalation chain (T2.4 acceptance + §5 E2E).

---

## 5. Expanded Test Plan (DELIBERATE mode — REQUIRED)

### Unit (domain state machines — every transition)
- `workorder`: a test per edge of the 16-state transition table — every legal transition accepted, every illegal transition rejected at the domain layer. Property test: no transition bypasses audit-event construction.
- `dispatch`: P1 accept-window FSM transitions (BROADCASTING→AUTO_ASSIGNED / →MANAGER_FORCE_PENDING) for accept/decline/timeout permutations; GPS×priority scoring determinism; no-consent → schedule-fallback ranking.
- `compliance`: consent state transitions (grant/suspend/withdraw); destruction triggers.
- `financial`: depreciation formula (정액/정률), negative-residual handling, quote itemization.
- `reporting`: KPI 7종 pure calculators on golden datasets; KpiExclusion honored.

### Integration (`#[sqlx::test]` per repo adapter)
- One `#[sqlx::test]` per repository adapter (workorder, registry, dispatch, compliance, messenger, reporting, financial, identity) asserting persistence + branch-scoped filtering + audit row in same tx.
- **WORM retention suite** vs pinned SeaweedFS: put object → attempt delete/overwrite under COMPLIANCE retention → expect denial; verify OCI replica object-lock metadata. Runs in CI against a pinned SeaweedFS container.
- Authorization integration tests: cross-branch deny matrix per role; SUPER_ADMIN/EXECUTIVE rollup span.
- Refresh-token family reuse-detection (reuse → family revoked).

### E2E
- **P1 broadcast multi-client simulation:** N simulated technician clients in a branch; assert ≤5s fan-out, countdown accept/decline, ≥2-accept auto-assign by score, 0-accept force-assign + Alimtalk escalation, assigned today-list immediate update.
- **Offline sync conflict/idempotency:** technician offline → start+report+capture → reconnect → idempotent /sync (device-hash + request-ID dedup); duplicate replay returns cached result without re-executing; conflict resolution deterministic.
- **Passkey cross-device:** desktop browser platform-authenticator login; cross-device hybrid (QR) flow; register+login on both native apps.
- **Excel golden-file:** generated 일일현황 + 업무일지 match golden templates (structural fidelity).

### Observability verification
- **Trace continuity:** a single trace spans REST → worker → push for a P1 flow (assert trace-id propagation across the apalis job boundary).
- **Audit-event completeness gate:** the `audit-coverage` CI gate asserts every state-changing handler emits an AuditEvent; a runtime test asserts a representative flow produces the expected audit chain (actor/before/after/trace-id).
- OpenSLO files validate; burn-rate alert policy present for availability+latency.

---

## 5.9 ADR — Consensus Decision Record (ralplan)

**Decision.** Build the 물류장비 정비/렌탈 FSM as a Rust (Axum 0.8.x/SQLx 0.9) clean-architecture modular monolith in a monorepo, vertical-slice-first (M0 spine with parallel sub-tracks → WO-lifecycle slice → P1 dispatch+compliance → messenger → reporting → financial → seams/hardening), with PostgreSQL + append-only same-transaction audit, SeaweedFS+OCI-WORM evidence storage behind an S3 port, passkeys-first auth, Swift+Kotlin dual-native mobile + React web, Compose-on-OCI K8s-ready deployment, branch-scoped day-1 for a 300+ user multi-region org.

**Drivers.** (1) Criminal-exposure 위치정보법 compliance is launch-blocking → compliance core proven in M0 as pure domain, decoupled from app delivery. (2) Dual-native parity risk (informed user decision) → single OpenAPI contract, CI tri-client generation gate, parity checklist, slice sequencing. (3) Excel 양식 byte-fidelity is a hard acceptance criterion → umya-spreadsheet template-fill with M0 viability spike against the real file.

**Alternatives considered.** Platform-first build order (rejected: violates production-grade-only mandate — nothing shippable for most of the timeline; big-bang integration risk). Polyrepo (rejected: contract atomicity beats toolchain isolation for parity-drift defense; macOS-runner path-filtering mitigates the CI tax). Expo/React-Native single codebase (user overrode — informed decision for dual native). RustFS at launch (rejected on adversarial verification: pre-GA beta, disk-full metadata corruption, CVE-2025-68926; SeaweedFS chosen, RustFS re-eval at GA). Mattermost embed (rejected: separate auth/audit/ops island; full messenger built in-domain). Kubernetes at launch (rejected at this scale; K8s-ready posture preserved).

**Why chosen.** The selected combination is the only one satisfying all four hard mandates simultaneously: production-grade-only increments (every milestone ships), auditability as domain invariant (same-tx audit + CI coverage gate with the sole LocationPing carve-out), criminal-liability compliance front-loaded (M0 sub-track), and honest scale posture (single-VM start, multi-instance-safe interfaces).

**Consequences.** Positive: compiler-enforced layering; per-slice pilot feedback from HQ team of 8; compliance/storage/Excel unknowns retired in M0; swap-safe adapters (APNs crate, JobQueue, S3). Negative (accepted): heavy M0 before first user-visible feature (mitigated by parallel sub-tracks); dual-native = duplicated client work per slice (user-accepted cost); apalis RC in timer path until soak gate proves it; single fault domain until cloud growth (RPO≤5min/RTO≤1h via PITR + VM-down runbook).

**Follow-ups (tracked fast-follows from Critic APPROVE — non-gating).**
1. Notification-type count: spec said 12, prior schema verified 15 — spec corrected to 15; confirm all 15 are genuinely inherited when building the notification concern (M1/M2).
2. Spec branch_id phrasing drift — corrected in spec (non-nullable day-1); no further action.
3. docs/reference/.omc stray hook-state dir — removed 2026-06-12; keep golden-file dir clean (CI golden-diff path matching).
4. Open-questions ownership: assign explicit resolution owners/dates at gated milestones (quote formula + purchase chain → M5 w/ 경리·손화나; P1 timers → M2 w/ operations; APNs/FCM crates → M1 cargo-add; RustFS re-eval → post-launch ~2026-07).

---

## 6. ADR Seed List (first ~10 — titles only)
1. ADR-0001 — Modular-monolith Cargo workspace with compiler-enforced clean-architecture layering
2. ADR-0002 — Audit-first transactional discipline (audit-event in same tx; append-only table)
3. ADR-0003 — Branch-scoped authorization model (non-null branch_id day 1; default-deny)
4. ADR-0004 — Passkeys-first auth with rotating refresh-token families + reuse-detection
5. ADR-0005 — SeaweedFS primary + OCI Object Storage WORM replica (RustFS rejected at launch; re-eval GA)
6. ADR-0006 — P1 broadcast-accept dispatch with live-GPS scoring (deliberate departure from dispatcher-mediated norm)
7. ADR-0007 — Postgres-persisted messenger with LISTEN/NOTIFY multi-instance fan-out (NOT E2EE; audit-grade)
8. ADR-0008 — Excel export via umya-spreadsheet template-fill (over rust_xlsxwriter generate-from-scratch)
9. ADR-0009 — Dual-native (Swift+Kotlin) parity strategy via single OpenAPI contract + CI parity gate
10. ADR-0010 — Integration seams as ports-only (oyatie AI, Bitween identity) — NO mock adapters (production-grade-only)
11. ADR-0011 — apalis 1.0-rc isolated behind a JobQueue trait (RC pinning + soak-gate + swap path)
12. ADR-0012 — Monorepo layout for 4 deliverables (contract atomicity over toolchain isolation)
13. ADR-0013 — APNs crate selection: apns-h2 0.11.0 vs a2 0.10.0 (currency vs incumbent; chosen behind push port)
14. ADR-0014 — LocationPing destructible store carve-out from the append-only audit store (위치정보법 destruction compatibility)
15. ADR-0015 — DR posture: WAL archiving + continuous PITR (RPO ≤5min / RTO ≤1h) and VM-down emergency-dispatch fallback

## 7. Verification & Rollout

### Per-milestone verification (commands / evidence)
- **M0:** `cargo build && cargo test`; `docker compose -f ops/docker-compose.prod.yml up` one-command boot; probe curl green; OTel trace screenshot; layer-gate fixture fails-then-passes; backup/restore drill log.
- **M1:** `cargo test` (every WO transition); master-list import count = 465; presigned upload + WORM-verified; web+Android+iOS dual-build green; parity checklist artifact.
- **M2:** P1 E2E multi-client sim log; consent withdrawal destruction test; off-switch on all 3 clients; KCC 신고 sign-off doc; Alimtalk escalation trace.
- **M3:** two-instance LISTEN/NOTIFY integration test; persist-before-fanout assertion; messenger parity across clients.
- **M4:** golden-file diff (일일현황, 업무일지) = pass; KPI golden-dataset per-metric pass; wall-board auto-refresh demo.
- **M5:** substitute-match query result; rental-quote itemization + negative-residual test; purchase-chain role-gated audit trail.
- **M6:** full CI gate suite green (db-migration-safety, pii-no-logs, audit-coverage, WORM-retention, layer-boundary, parity, dual-build); go/no-go checklist.
- Evidence captured as JSON under `/docs/evidence/` for high-risk changes (auth, compliance, WORM, P1).

### Pilot → branch rollout sequencing
1. **Pilot — HQ team of 8** (정비팀 3, 예방점검팀 2, 관리자 3): run M1–M2 features on real WOs in production for the HQ branch; collect parity/offline/compliance feedback; validate rental-quote formula with 경리/손화나 against real 예비차량 data.
2. **Branch rollout** following the prior phasing: **수도권 → 충청 → 영남 → 호남.** Each region onboarded only after: branch-scoped data seeded, ADMIN UserBranch memberships configured, KCC 신고 coverage confirmed for the region's operation, and the parity/CI gates green on the release tag.
3. Each rollout wave is gated by: backup/restore drill on the production env, OTel/OpenSLO dashboards live for the region, and an audit-access review.

---

## Open Questions (persisted to `.omc/plans/open-questions.md`)
- Rental quote formula specifics (정액/정률, 내용연수, 잔존율, 관리비율, 이윤율 defaults) — validate with 경리/손화나 using real 예비차량 sheet data (negative 잔존가 occurs — confirm handling rule).
- Purchase approval actor chain + thresholds — confirm 정비사→접수자/경리→관리자→임원(전무) chain and threshold values.
- P1 escalation timer defaults (accept 5min / force-assign 10min / Alimtalk no-ack 2min) — confirm with operations.
- a2 (APNs) crate maintenance risk (last publish 2024-05) — confirm acceptable or pick alternative at M1.
- FCM HTTP v1 client crate choice — verify current crate at M1 `cargo add` time.
- RustFS GA re-evaluation (~2026-07) — schedule decision point post-launch.
