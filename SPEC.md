# SPEC — KNL Conglomerate Operations Platform

> Canonical root spec (agent-skills:spec). Crystallized via deep-interview (~19% ambiguity) + Foundry/
> domain research. **Full detail:** `docs/specs/knl-business-os.md`. **Grounding:** `.omc/research/{palantir-
> blueprint,foundry-domain-research,broken-flows-fix-plan,role-workflow-backlog,analytics-intelligence-
> roadmap,webmail-build-plan,dispatchmap-build-plan}.md`. **Execution ledger:** `.omc/ultragoal/plans/
> conglomerate-platform/` (G001–G015). Quality chain: spec → plan → test → build → review → webperf →
> ai-slop-cleaner/simplify → ship.
>
> **QUALITY BAR = PALANTIR-GRADE, ENTERPRISE-PRODUCTION (non-negotiable, every story).** No MVP, no
> shortcuts, no "good for now". Every increment is fully wired (no stubs/placeholders/dummy data),
> error-handled, RLS+authz+audited, covered by real `mnt_rt` tests, AA-accessible, rendered in the
> dense/legible Blueprint system at **visual-verdict ≥90**, slop-cleaned + independently reviewed —
> BEFORE any ultragoal checkpoint. A slice is an increment of a complete system, never a stopping point.

## Objective

A single object-centric platform that runs an entire **conglomerate's** business — a faithful
**carbon-copy of Palantir Foundry (NO AI for now)**, then diverge. Generic operational primitives +
(ultimately) a no-code configurable ontology that captures any business's **operations, employees,
assets (universal — real-estate/machinery/vehicles, not just forklifts), and workflows**. Group of legal
entities (KNL 물류 · COSS/BESTEC 제조·OEM · 파견·용역 staffing) on one shared back-office (HR · Korean
payroll · ERP) with consolidated-vs-single scoped administration. **Users:** field techs, receptionists,
admins, executives, HR/payroll, finance, and group/法人 administrators. **Build path = phased extraction**
(stabilize live → generic object core w/ KNL FSM as first instance → extract ontology engine → low-code →
no-code). KNL's forklift FSM is the first configured instance proving the generic core.

## Tech Stack

React 19 + Vite + Tailwind v4 (`@theme`) + react-router 7 + Pretendard, typed client `@maintenance/
api-client-ts`. Rust (axum) bounded-context crates (`domain/application/adapter-*/rest`), sqlx, multi-
tenant Postgres 18 RLS (runtime role `mnt_rt` NOBYPASSRLS + FORCE RLS; owner `mnt_app` runs migrations
out-of-band). OpenAPI single source (`backend/openapi/openapi.yaml`, served via `include_str`) covers tenant
and `/api/platform/*` platform-admin routes; generated clients and the web platform API types derive from
that file. OCI/Talos k8s, CNPG, Argo Rollouts, image-release auto-deploy on push, secrets in OCI Vault.
i18n `web/src/i18n/ko.ts` (no inline Hangul). New external integrations are ask-first (Kakao geocode,
전자세금계산서 relay, payroll rate data).

## Commands

```
# Web (cd web)
npm run lint        # eslint --max-warnings 0 + check-ui-strings (no inline Hangul)
npm run build       # tsc -b + vite build
npm test            # vitest; until #31: npx vitest run --exclude '**/PlatformConsole.test.tsx'
npm run gen:api:ts  # regen TS client from OpenAPI, including platform-admin DTOs

# Backend (cd backend; SQLX_OFFLINE=true; DATABASE_URL=postgres://<user>@localhost/mnt_ci — user REQUIRED)
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test -p <crate>                    # #[sqlx::test] applies migrations
cargo run -p mnt-gate-{rls-arming,tenant-isolation,layer-boundary,audit-coverage,migration-safety}
npm run check:openapi-app                # platform route inventory + served openapi == committed file
npm run gen:api:swift
```

## Project Structure

```
backend/crates/<context>/{domain,application,adapter-postgres,adapter-*,rest}   # bounded contexts
backend/crates/platform/{auth,authz,storage,realtime,request-context,db/migrations,email,comms}
backend/ci/gates/<gate>                  # static-analysis gates
backend/app/src/lib.rs                   # composition root (routers + background workers)
backend/openapi/openapi.yaml             # single source for tenant + platform routes; clients regenerated from it
web/src/{pages,features/<domain>,components/{ui,shell,states},i18n,lib,context,api}
SPEC.md (this) · docs/specs/             # master spec + JIT domain sub-specs (payroll, accounting, org-hierarchy, rbac-configurable)
.omc/{research,ultragoal}/               # blueprints, research, durable goal ledger
```

## Code Style

Match surrounding code. **Every tenant read/write arms `app.current_org`; tests run as real `mnt_rt`.**
```rust
// READ: armed, org-scoped, fail-closed under FORCE RLS.
let org = current_org().map_err(KernelError::from)?;           // never a default tenant
with_org_conn(&self.pool, org, move |tx| Box::pin(async move { /* sqlx … tx.as_mut() */ })).await
// WRITE: AuditEvent.with_org(org) so with_audit arms the GUC (the #27/#43 lesson);
// org MUST be a dynamic current_org()-derived value, NEVER a hardcoded OrgId literal.
```
Web: shared `ui` primitives only (Dialog/Combobox/DataTable/SkeletonTable/FeedbackBanner); object links
via `ObjectLink`/`safeLabel` (never render a raw UUID); copy in `ko.ts`; KST via `formatKoreanDateTime`;
ids/₩ in `Mono`. New objects = one `ObjectViewConfig<T>` over `ObjectViewScaffold`, not a hand-rolled page.

## Testing Strategy

- **TDD**: failing test first. **Backend**: a real `mnt_rt` RLS test per tenant flow (seed via the ARMED
  path, not the BYPASSRLS owner pool) proving create→read round-trip, org-scoping, cross-tenant
  invisibility, fail-closed-unarmed. **Web**: vitest per page + shared kit; **visual-verdict ≥90** on every
  path before a UI phase is "done". **Regulated** (payroll/회계): golden-case tests vs 노무사/세무사-validated
  worked examples + effective-dated rate-table tests. Gates + fmt/clippy + platform route-inventory
  comparison (`scripts/check-platform-contract-drift.mjs` via `check:openapi-app`) + generated frontend
  type regeneration/validation (`gen:api:ts`, `check:ts`) green before commit.

## Boundaries

- **Always**: arm `app.current_org` + a real `mnt_rt` test for every tenant read/write · openapi-first
  (including `/api/platform/*`) + regen clients · incremental (≤~5 files/task) · gates+fmt+clippy+tests green + evidence before "done" ·
  authoring and review are separate passes (code-reviewer/security-reviewer; never self-approve) ·
  operational/business mutations through the audited console API (never direct SQL).
- **Ask first**: DB schema changes · new dependencies · new external integrations/keys (Kakao,
  전자세금계산서 relay, payroll data) · authz-matrix/RLS-posture changes · enabling a regulated module in prod.
- **Never (for now)**: AI/LLM/generative integration (deferred — Foundry reference is pre-AI) · ship a
  payroll or 세금계산서 calculation to prod without versioned effective-dated rates + a golden-case test +
  노무사/세무사 sign-off · secrets to /tmp · self-approving a review · weakening tenant isolation.

## Success Criteria

1. **FSM loop closes** end-to-end as real `mnt_rt`: intake→plan→dispatch→execute(evidence)→approve→close;
   nothing "created but invisible" (issue #19 #13/#17/#18/#21/#22 fixed + tested).
2. **Object-centric**: ≥6 core objects have an Object View reachable via ⌘K + inter-object links; triage
   home is the post-login landing for operator roles; raw UUIDs never shown.
3. **Org hierarchy**: group-admin manages all member 법인 in one screen + scope-selects to a single entity;
   local users limited to their subtree; consolidated views are aggregation over per-member armed reads.
4. **HR/Payroll**: employees w/ 직급/조직도 + attendance + leave; a payroll run produces a 급여명세서 matching a
   노무사-validated golden case; salaries RBAC-restricted + audited.
5. **ERP**: 견적→수주→세금계산서→미수금 and PO→입고→거래명세표→미지급금 flow; a 부가세 period reconciles; WO-consumed parts
   decrement inventory + post to the cost ledger.
6. **Provenance + quality**: every KPI drills to its source objects; every mutation audited; all gates
   green; visual-verdict ≥90 on every path; no AI.

## Phased Roadmap (ultragoal G001–G015)

A stabilize live (#40 + #19; incl. codex-flagged authz fixes — `OrgWideQueueTriage` replaces the
`is_admin_like→All` widen, daily-plan list gated on daily-plan perms) → B0 org-hierarchy security
(sub-spec + security-review FIRST) → B0.5 configurable RBAC (data-driven custom roles + per-role policy,
console-managed; sub-spec `rbac-configurable.md` + security-review FIRST; "org-admin" = first custom
role; convert all role-string authz checks → capability checks) → B carbon-copy-Foundry core: P0
Blueprint tokens → P1 Object-View kit → P2 Equipment view → P3 ⌘K/nav/DataTable → P4 Triage Home →
P5 Object-Set query API + faceted (CAP-3) → P6 timeline+graph → action/write-back engine (CAP-5) →
C HR + Korean payroll + ERP (JIT sub-specs) → D webmail + dispatch-map.

## Open Questions

org-hierarchy access detail (group payroll/financial visibility); 전자세금계산서 relay choice; payroll inputs +
노무사 contact; FLMS vendor data format (#19.15); #19.12 customer-법인 grouping vs the group hierarchy.
