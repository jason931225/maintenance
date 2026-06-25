# Build Strategy — Full Enterprise SaaS at Massive Parallel Scale

> idea-refine output (refined direction), feeding `/review` → `/agent-skills:review` →
> `/planning-and-task-breakdown`. Companion to `docs/specs/roadmap-to-production.md`.

## Problem Statement

**How might we** build the conglomerate platform (FSM + HR + Korean payroll + ERP + a no-code
configurable ontology) to *complete, meticulous, enterprise-grade production with no deferral* — as a
**productized multi-tenant SaaS** — by **extracting the ontology from concrete instances** (not
speculating it), while letting **many agents build disjoint areas in massive parallel** and integrate
cleanly?

## Recommended Direction (decided)

1. **Extract, don't speculate.** Build FSM / HR / payroll / ERP as concrete, fully-wired, enterprise-grade
   modules first; the no-code ontology + action engine is **extracted from their proven patterns**.
   Everything still ships (no deferral) — the meta-layer is just grounded in working instances.
2. **Productized multi-tenant SaaS.** KNL is the anchor tenant; the architecture (platform tier, RLS,
   onboarding, configurable RBAC) already supports arbitrary tenants. The extracted ontology must be
   genuinely general, validated against KNL's real depth.
3. **Massive parallelism via borrowed discipline.** Adopt oyatie's **kernel + vertical-slice** model and
   **contracts-first** integration so dozens of disjoint slices build concurrently and merge cleanly. Each
   bounded context (workorder, registry, financial, sales, inspection, messenger, support, identity,
   platform, location, compliance, reporting, **hr**, **payroll**, **accounting/erp**, **comms/webmail**,
   **gov-integrations**) is an independent worktree-agent lane against stable contracts.
4. **Government-direct integrations only** (국세청, 공공데이터포털, 도로명주소) — each a disjoint adapter slice.

## What makes massive parallelism actually work (the enablers — build these FIRST)

The substrate that turns "many agents" from collision into throughput:
- **Contracts-first:** define the openapi schemas, the **capability catalog** (configurable-RBAC authz),
  the **object-type/property/link/action** ontology schema, and the audit/RLS conventions UPFRONT. Each
  domain builds against frozen contracts → no cross-lane coupling. (oyatie `contracts/` pattern.)
- **Eliminate the two collision points:** `web/src/i18n/ko.ts` and `backend/openapi/openapi.yaml` are the
  only files every domain touches. **Modularize them per-domain** (`i18n/ko/<domain>.ts` merged at an
  index; openapi split into per-domain fragments composed at build) so disjoint lanes never conflict.
  This single refactor is the biggest parallelism unlock.
- **Shared kit + kernels (borrow from oyatie, customize here):** the Object-View kit (every screen is a
  config over one scaffold), the kernel libs (tax/invoice-total, quota/fairness, sla-obs, lifecycle FSMs),
  the mnt_rt test harness + gates. Built/borrowed once → every lane reuses.
- **AGENTS-OPERATING-CONTRACT (borrow):** a written contract for how parallel agents claim slices, respect
  boundaries, run the trifecta, and hand off — so the fleet self-coordinates.
- **Deploy-blocking CI + the trifecta gate:** so parallel merges can't silently break each other.

## Key Assumptions to Validate

- [ ] **oyatie code is borrowable into this stack** — same Rust/axum/sqlx + React idioms (or adaptable);
      its kernels (billing/tax, quota, lifecycle) map to our payroll/ERP/quota needs. → *the borrow-scan
      below answers this.*
- [ ] **ko.ts/openapi modularization is low-risk + high-unlock** — verify the build can compose per-domain
      fragments (vite/openapi tooling) without runtime change. → spike it first.
- [ ] **Extraction yields a general engine** — the FSM/HR/ERP instances share enough structure that a real
      ontology falls out (vs. each being bespoke). → the Object-View kit + capability catttalog force this.
- [ ] **The fleet stays quality-bound** — massive parallel ≠ sloppy; the deploy-blocking trifecta gate +
      per-lane security-review + visual-verdict ≥90 hold the line at scale.

## Build scope — substrate first, then the parallel fleet (NOT an MVP — the full thing, ordered)

**Wave 0 (substrate — unblocks everything, mostly sequential, partly borrow):**
1. Borrow + customize from oyatie: contracts pattern, Object-View kit, reusable kernels, AGENTS-OPERATING-
   CONTRACT, advanced CI/CD. 2. Modularize ko.ts + openapi per-domain. 3. Land the in-flight foundations
   (acme force-remove, CI-debt green, the deploy-blocking gate, log persistence). 4. Freeze the v1
   contracts (capability catalog, ontology schema, openapi conventions).

**Then the disjoint fleet (massive parallel, one worktree-agent per lane), each shipping its trifecta:**
- Quality/coverage backfill · org-hierarchy + configurable RBAC · #19/#20 FSM completion · HR core →
  payroll (gov rates) · ERP (AR/AP/inventory/GL/부가세 + 국세청 e-invoice) · comms/webmail/dispatch ·
  gov-API adapters · reporting/analytics · the Foundry UI spine (continuous) · ontology extraction
  (watches the instances).

**Integration:** continuous merge against the frozen contracts; the per-domain ko/openapi fragments merge
trivially; a nightly full-suite + the deploy gate catch cross-lane breakage.

## Not Doing (and why) — focus is saying no

- **NOT speculate-first ontology** — build instances, extract the engine. Avoids the meta-platform "executive trap".
- **NOT any commercial integration provider** (팝빌/바로빌/Kakao/relays) — government-direct only.
- **NOT horizontal slicing** (all-DB-then-all-API-then-all-UI) — vertical slices per domain, each shippable.
- **NOT one mega-ko.ts / one mega-openapi** — modularize, or parallelism dies on merge conflicts.
- **NOT "fast" over "correct"** — the deploy-blocking trifecta gate is non-negotiable; a fleet that ships
  red is worse than one slow lane.
- **NOT AI/LLM features** — deferred (Foundry reference is pre-AI).

## Open Questions

- Which oyatie pieces are directly liftable vs need adaptation? (→ borrow-scan, launching now.)
- Is the buck2 path (oyatie is buck2; we have a buck2-migration worktree) the route to oyatie-parity, or do
  we adapt oyatie's logic into our cargo layout? (Affects how much we lift wholesale.)
