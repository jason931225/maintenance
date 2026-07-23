# Console enterprise roadmap

## Authority and scope

Status: active implementation roadmap
Last refreshed: 2026-07-23
Product scope: the B2B SaaS console only. Oyatie and the Claude Design project are references, not implementation authority.

This document is the repository-native authority for console decomposition,
implementation state, integration order, and completion evidence. It does not
derive authority from Hermes, Hermes Kanban, OMX, OMC, GJC, or untracked agent
state.

The read-only
`/Users/jasonlee/Developer/canonical-no-regrets-engineering-lifecycle.md`
(SHA-256
`7ce8d90f953ab2f90e7053dea2965e87f6bfb1f928507f5ff979c37923dd400c`)
governs lifecycle interpretation. This roadmap is a subordinate execution
projection; it must not modify, supersede, or weaken that lifecycle.

The evolving Claude Design project is an approved visual and interaction
reference. Its mock data, prototype actions, and completion labels are not
backend or release evidence.

## Business coverage

The console is an enterprise operating system for all documented COSS business
lines, not a logistics or maintenance application.

Observed COSS operations:

1. [Production subcontracting](https://cossok.com/business/production):
   assembly, machining, staffing to production plans, quality, productivity,
   and delivery.
2. [Logistics subcontracting](https://cossok.com/business/logistics):
   inbound, outbound, packaging, warehouses, integrated logistics, forklifts,
   AGVs, staffing, safety, and accuracy.
3. [Integrated facility management](https://cossok.com/business/integrated):
   security, cleaning, waste and recycling, pest control, landscaping, HVAC,
   electricity, water, fire safety, energy, and building/site maintenance.
4. [Equipment 3R](https://cossok.com/business/three_r):
   rental, repair, resale, refurbishment, scheduled inspections, emergency
   response, parts, operators, and equipment history.
5. [Consulting](https://cossok.com/business/consulting):
   production improvement, automation, line optimization, Lean, inventory and
   warehouse optimization, transportation, TPM, KPI, implementation support,
   and performance follow-up.
6. [Owned plants](https://cossok.com/business/own-factory):
   Miryang pipe processing/welding/assembly, Changwon shock-absorber and wiper
   production, and Ulsan water-tank-module production.

Cross-company coverage also includes customers, contracts, bids, sites,
workforce, vendors, procurement, finance, quality, EHS, Net Zero, ethics,
whistleblowing, documents, approvals, communications, analytics, and
governance.

Foreseeable capabilities are roadmap hypotheses until confirmed by a real
workflow, schema, source system, or user. They must never appear as fabricated
production data.

## Product architecture

### Shared horizontal platform

- Organization: group, legal entity, business unit, site, facility, plant,
  warehouse, work center, team, cost center, jurisdiction.
- Identity and workforce: person, employment, vendor worker, role, skill,
  certification, roster, shift, attendance, payroll, benefit, training.
- Customer and commercial: account, opportunity, bid, contract, SLA, service
  scope, price schedule, change order, invoice, profitability.
- Supply and assets: vendor, requisition, purchase order, receipt, item, lot,
  stock, warehouse, equipment, component, spare part, rental agreement,
  refurbishment, depreciation.
- Execution: plan, order, task, work order, assignment, route, appointment,
  checklist, exception, incident, approval, evidence, handoff.
- Finance and control: ledger, voucher, budget, cost allocation, settlement,
  revenue, margin, tax, audit event, policy decision.
- Collaboration: message, thread, mail, notification, notice, document,
  comment, mention, subscription, task.
- Intelligence: metric, forecast, scenario, alert, lineage, data-quality rule,
  dashboard, report.

### Ontology and workflow control plane

Every released business noun is represented by a governed object type with:

- stable identity and tenant scope;
- typed properties and shared interfaces;
- typed links and traversals;
- lifecycle, version, effective date, and history;
- PBAC-enforced query, aggregate, object, property, and action behavior;
- action preflight, execution, idempotency, and audit;
- workflow triggers, conditions, effects, recovery, and compensation;
- lineage from source data to derived metric and decision;
- consistent opening in its module, object explorer, object card, search, and
  communication references.

Foundry-style parity is adapted to this context through ontology, actions,
functions, workflow studio, pipeline/lineage, object explorer, operational
applications, and governed analytics. It is extended with Korea-specific
operational, employment, safety, privacy, and audit requirements.

### Vertical operating packs

#### Production subcontracting

Objects: production plan, customer order, work center, routing, operation,
material, BOM, shift, assignment, production lot, output, scrap, downtime,
quality inspection, nonconformance, corrective action, OEE.

Signature workflow: customer demand -> capacity and material check -> staffed
plan -> execution -> in-process quality -> finished output -> delivery ->
settlement and margin.

#### Logistics subcontracting

Objects: inbound order, ASN, receipt, putaway, inventory, pick wave, shipment,
packaging unit, dock, yard slot, vehicle, route, transport order, AGV mission,
exception, proof of delivery.

Signature workflow: inbound notice -> receiving -> putaway -> replenishment ->
pick/pack -> dispatch -> delivery evidence -> SLA and cost settlement.

#### Integrated facility management

Objects: facility, space, service catalog, asset, preventive-maintenance plan,
inspection, work order, cleaning route, security post, access event, waste
stream, pest-control treatment, landscape task, utility meter, energy target,
fire-safety check, incident.

The official page's hard-service and soft-service headings appear inconsistent
with their listed contents. Preserve the official wording as source provenance,
but model each offering through a typed service catalog rather than encoding
those two headings as immutable product taxonomy.

Signature workflow: service obligation -> preventive schedule or request ->
triage -> assignment -> safe execution -> evidence -> customer acceptance ->
SLA/energy/cost reporting.

#### Equipment 3R

Objects: equipment model, serialized unit, rental quote, agreement, operator,
dispatch, inspection, maintenance history, fault, repair order, part, warranty,
acquisition, appraisal, refurbishment, resale listing, transfer.

Signature workflow: availability and suitability -> quote/approval -> dispatch
and handover -> inspection/maintenance -> return -> condition assessment ->
repair/refurbish/resale or redeploy.

#### Consulting

Objects: engagement, diagnostic, observation, baseline, value-stream map,
finding, initiative, experiment, KPI, benefit hypothesis, implementation plan,
review, realized benefit.

Signature workflow: diagnose -> analyze -> propose -> approve -> implement ->
measure -> sustain or correct.

#### Owned plants

Owned plants reuse the production pack with plant-specific routings, quality
plans, equipment, workforce, and cost models. Configuration must not fork the
core ontology or create a bespoke application per plant.

### Sustainability, quality, EHS, and governance

Objects: hazard, risk assessment, permit, incident, corrective action, safety
training, environmental aspect, emission source, energy use, waste stream,
quality standard, control, obligation, evidence, ethics report,
whistleblowing case.

These controls apply across every vertical and are not a detached compliance
dashboard.

### Cross-enterprise workflow backbone

- Inquiry -> opportunity -> bid -> contract -> delivery -> invoice -> margin.
- Contract -> position -> staffing/recruitment -> attendance -> payroll ->
  labor cost -> profitability.
- Requisition -> purchase order -> receipt -> three-way match -> accounts
  payable -> payment -> general ledger.
- Production demand -> order -> operation -> quality/genealogy -> delivery ->
  cost.
- Facility request -> triage -> schedule -> execute/evidence -> SLA evaluation
  -> invoice.
- Equipment acquisition -> rental -> inspection/repair -> refurbishment ->
  resale/disposal.
- Incident/hazard -> containment -> investigation -> CAPA -> verification ->
  closure.
- Consulting diagnostic -> finding -> initiative -> implementation ->
  measured benefit.

## Canonical capability registry

The machine-readable registry is
[`console-capability-registry.json`](console-capability-registry.json). It is
the dispatch and consolidation queue. A row may enter `in_progress` only when
its exact writer, isolated worktree, ownership roots, API/schema/migration
owner, signature story, evidence directory, and leaf gates are populated.
An unassigned or overlapping row is `HOLD`, not an invitation to guess.

The registry contains seeded rows for the shared console substrate, current
shell and Benefits work, the compliance catalog closure, and all six COSS
vertical pilots. Required fields:

- stable capability, object, link, action, workflow, event, and policy IDs;
- evidence classification: `official`, `repository_contract`,
  `design_reference`, `dated_audit`, or `inference`;
- business-pack owner and shared-platform owner;
- source-system and provenance;
- lifecycle and effective-dating strategy;
- projected-domain or generic-instance persistence mode;
- OpenAPI and generated-client ownership;
- migration and generated-artifact collision roots;
- module route and authorized navigation state;
- implementation states: `design_contract`, `backend`, `frontend`, `e2e`,
  `runtime`, `independent_review`, `production_exposure`;
- executable user-story IDs and current evidence locations.

Checkboxes in a prototype roadmap cannot substitute for these distinct states.

Shared collision roots (`web/src/i18n/ko.ts`, navigation, screen registry,
OpenAPI, generated clients, migrations, and this roadmap) have one
consolidation owner. Leaf lanes emit narrow commits; they do not concurrently
rewrite those roots.

## Non-negotiable module completion contract

A module is not done because a page renders.

1. No stubs, placeholders, filler text, copied prototype rows, dead controls,
   optional no-op actions, or production imports named `*Stub*`.
2. All visible data comes from a real authorized backend response or a truthful
   loading, empty, denied, error, or offline state.
3. Every visible mutation reaches a real backend action, records audit
   evidence, exposes failure, and supports safe retry or compensation.
4. The module has list/overview, object detail, action/workflow, and history
   layers.
5. At least two real upstream and two real downstream links are traversable.
6. Query, aggregate, object, property, and action authorization is enforced by
   the server and rendered without unauthorized flashes or count leakage.
7. Keyboard, focus, screen-reader, contrast, Korean expansion, high zoom,
   reduced motion, and responsive behavior pass.
8. The same selected object and draft survive rail/main promotion, responsive
   changes, retry, and Back navigation when the workflow requires it.
9. Documentation states verified reality and explicitly names missing
   independent or production evidence.

## Executable user-story gate

Each module must maintain at least one signature user story and replay it with
provisioned identities against the real backend.

Required evidence:

- happy path from trigger to durable result;
- least-privileged view;
- explicit authorization denial with no data or aggregate leakage;
- service or validation failure, retry, recovery, and state preservation;
- lifecycle and audit readback;
- cross-tenant isolation;
- responsive and keyboard completion;
- workflow efficiency: the critical action count and elapsed interaction time
  do not regress without a documented reason.

The test must assert business outcomes, not only selectors or screenshots.
Visual regression supplements this evidence; it cannot replace it.

Each registry row records exact test files and commands. The minimum evidence
topology is:

| Layer | Required proof |
|---|---|
| Component | focused Vitest interaction tests for happy, empty, error, denied, retry, responsive, and keyboard states |
| Frontend static | `node web/scripts/check-ui-strings.mjs`, `npm run web:lint`, `npm run web:build`, and `git diff --check` |
| Contract | OpenAPI drift and generated-client gates named by the registry row |
| Backend | non-empty, checked-in Buck2 target list; no Cargo result is accepted as Rust completion evidence |
| Integration | real app router, provisioned personas, PBAC denial, tenant isolation, durable mutation, audit/lifecycle readback |
| Browser | committed user-story replay at the row's exact route and responsive matrix |
| Operations | metrics, trace or audit correlation, failure injection, recovery, and rollback observation |

Because `origin/main` currently has no checked-in Buck2 configuration, every
Rust-backed row remains blocked from completion until its exact targets and
toolchain are committed and pass. The installed Buck2 binary alone is not
evidence.

## Visual parity gate

Approved composition: dense Korean operations cockpit with compact typography,
hairline separation, restrained semantic color, left navigation, main
workspace, and right communication context.

Required capture matrix:

- 1920x1080, 1560x900, 1440x900, 1280x800;
- 1279x800, 1024x768, 768x1024;
- 767x1024, 390x844, 320x568;
- light, dark, reduced motion, Korean expansion, keyboard focus;
- main-only, left drawer, right drawer, rail collapsed/open, error/retry, and
  canonical communication-route promotion.

The current immutable visual input receipt is
[`console-visual-baseline.json`](console-visual-baseline.json). The 2026-07-23
Claude export is pinned by ETag, byte length, and SHA-256. The initial 46/100
comparison and the post-shell 42/100 medium-width comparison are provisional
orientation baselines, not directly comparable desktop scores, Visual Ralph,
or release evidence. The lower post-shell score reflects the todo-only module
and compact communications rail at 937px, not a claim that the reviewed
accessibility/responsive shell regressed.
Every candidate Visual Ralph receipt must record the exact candidate commit,
reference digest, tool and model version, scoring rubric, viewport/theme/state
matrix, images, accessibility deltas, findings, and any approved waiver.

Hard requirements:

- no document-level horizontal overflow;
- 44px minimum mobile targets;
- mutually exclusive accessible drawers with focus trap/return, Escape,
  backdrop, and scroll lock;
- active route and selected object preserved across layout modes;
- real data only;
- Visual Ralph score at least 90 for released states, with accessibility
  improvements accepted as intentional differences.

## Parallel delivery and consolidation

The delivery model follows the useful parts of Bun's worktree rewrite process
without copying its agent count or file-by-file topology.

1. Lock behavior and acceptance before fanout.
2. Pilot one vertical slice before broad replication.
3. Split work by collision-safe ownership boundary, not by arbitrary file
   count.
4. Start each implementation lane from an exact reviewed base in an isolated
   worktree.
5. Give each lane one writer and a narrow commit series.
6. Reuse a bounded number of worktrees for compatible, serialized ownership
   queues instead of creating a worktree per tiny task; create a new worktree
   only when concurrent writers or exact-base isolation require it.
7. Run cheap local gates continuously; avoid redundant global builds in leaf
   lanes.
8. Use a fresh read-only reviewer. Native review is recorded as
   `I1_NON_INDEPENDENT`, never elevated to independent review.
9. Cherry-pick approved commits into one consolidation train in dependency
   order.
10. Run combined generated-client, schema, Buck2, frontend, mobile, browser,
   security, and user-story gates only on the exact train candidate.
11. Merge is not release. Image authorization, deployment, health, data
    readback, and rollback readiness are separate gates.

Forbidden in fanout lanes: shared-root edits without ownership, broad reset or
stash operations, hidden generated-output changes, claims based on another
worktree's dependencies, and integration directly into a dirty root checkout.

## Priority model

At each dependency frontier, score candidate work:

```text
priority =
  0.25 user_workflow_value
+ 0.20 dependency_unlock
+ 0.20 correctness_and_risk_reduction
+ 0.15 visual_or_functional_parity_gap
+ 0.10 business_coverage_gain
+ 0.10 verification_readiness
- 0.15 collision_probability
- 0.10 unpriced_dependency_cost
```

All factors are normalized to `[0,1]`. Quality-critical work receives the
higher weights. A lane is not started when its collision probability or
unpriced dependency cost makes parallel execution slower than serial
integration.

Each factor is scored in increments of `0.05` from observed repository,
runtime, design, user-story, or risk evidence recorded in the capability
registry. Ties resolve by: material-risk reduction, then dependency unlock,
then workflow value, then the lower collision score. A score is recomputed at
each dependency frontier and whenever the Claude reference, mainline,
authorization contract, or backend seam changes.

## Korea jurisdiction and independent-review overlay

The Target Jurisdiction Set is exactly `KR` until the user explicitly changes
it. The machine-readable
[`console-jurisdiction-register.json`](console-jurisdiction-register.json)
owns `JUR-*` scope rows and `CTRL-*` control rows. A qualified source owner must
record the authoritative legal source, effective date, applicability, product
and data scope, evidence, and review date before the related control may move
out of `research_required`.

The current register deliberately holds privacy, workforce, safety,
tax/accounting, location-data, and electronic-record controls rather than
inventing legal conclusions. Missing or stale legal authority, unclear
applicability, or an unqualified reviewer is a release `HOLD`.

Native implementation and review agents can produce only
`I1_NON_INDEPENDENT` evidence. Consequential integration, release,
jurisdictional, and production decisions require candidate-bound I2/I3
receipts in independent custody as defined by the read-only lifecycle. If that
custody is unavailable, the candidate remains locally testable but cannot be
self-elevated, merged, released, or activated.

## Failure pre-mortem and replanning triggers

| Failure mode | Owner | Detection gate | Stop condition | Recovery and replan trigger |
|---|---|---|---|---|
| OpenAPI or generated-client collision | consolidation owner | schema diff plus generated-client drift gate | two lanes change the same operation or generated file | stop both integrations, choose one canonical contract owner, regenerate once on the exact train |
| Migration collision or order dependence | backend integration owner | migration inventory plus fresh-database boot | duplicate/order-sensitive migration or stale-volume-only green | renumber on current main, replay on a fresh database, invalidate dependent runtime evidence |
| Persona or tenant contamination | user-story owner | isolated identities plus cross-tenant negative test | data, counts, cache, or selection crosses tenant/persona | quarantine seed/database, fix scoping, rerun every affected story |
| Moving Claude Design input | visual consolidation owner | project ETag and export digest check | reference digest changes after acceptance freeze | classify delta; preserve unaffected evidence and rerun impacted visual/interaction rows |
| Hidden stub or no-op control | module owner | production-source sweep plus browser mutation readback | production import, fake row, dead action, or silent optional handler | remove or wire the control; never waive with explanatory copy |
| Browser/iOS divergence | client owners | shared story IDs replayed per client | one client cannot complete the business outcome | hold the shared story, fix the divergent client, rerun exact-sha artifacts |
| Failed deployment or rollback | release owner | immutable image, health, data/audit readback, rollback rehearsal | authorization, health, readback, or rollback is missing | stop publication/activation, roll back, preserve evidence, open a new candidate |

Cheap leaf gates run continuously in each worktree: focused tests,
UI-string/purity checks, lint, typecheck/build, format/static checks, and
`git diff --check`. Expensive whole-product gates run only on the exact
consolidation train: generated contracts, Buck2 Rust graph/build/tests,
frontend full suite, browser persona stories, mobile/iOS matrices, security,
immutable image authorization, deployment, and post-deployment readback.

## Delivery waves

Waves are dependency frontiers, not fully serial phases.

### Frontier 0: truthful live development train

- Dev-only authenticated preview; production remains dark by default.
- Exact Claude Design export and screenshot evidence.
- Responsive shell, left rail, right rail, topbar, route preservation.
- Real error/retry states and no dead shell controls.
- Repo-native roadmap and status ledger.

### Frontier 1: shared operational backbone

- Ontology types, links, actions, lifecycle, history, search, audit.
- Customers, contracts, SLAs, organization/sites, workforce, vendors.
- Tasks, approvals, documents/evidence, communications.
- Finance, procurement, inventory, assets, analytics primitives.

### Frontier 2: vertical pilots in parallel

- Production subcontracting pilot.
- Integrated facility-management pilot.
- Equipment 3R pilot.
- Logistics pilot.
- Consulting engagement pilot.
- Owned-plant configuration on the production backbone.

Each pilot delivers one complete signature workflow before the vertical is
broadened.

### Frontier 3: cross-vertical closure

- Shared scheduling and capacity.
- Shared quality/EHS/incident/corrective-action control.
- Shared profitability and customer SLA views.
- Cross-domain ontology traversal and governed actions.
- Workflow studio, pipeline/lineage, monitoring, forecasting, and scenarios.

### Frontier 4: production exposure

- No unmounted navigation or hidden required workflow.
- All module stories replayed on the exact candidate.
- Visual and accessibility matrix green.
- Buck2-only Rust build/test completion evidence.
- Independent review requirements satisfied or explicitly held.
- CI, immutable image authorization, deployment, live readback, and rollback
  verified.

## Truthful implementation snapshot

As of 2026-07-23, local non-merged work includes:

- My Work and Messenger real-backend improvements in the development preview
  train.
- A dev-auth-only refresh fix reviewed for exact synthetic personas; default
  production behavior remains unchanged.
- Benefits frontend/backend completion and localization are on the development
  preview train through integration commit `9f1c12ef`; the combined component,
  UI-string, lint, and build gates are green, while Buck2 and restarted runtime
  evidence remain open.
- Responsive shell parity commit `38a53bdd` passed fresh
  `I1_NON_INDEPENDENT` review and is on the development preview train as
  `397e1e59`; its combined component, UI-string, lint, and build gates are
  green and the dev-auth stack has been restarted. A new medium-width visual
  review scores the total My Work experience 42/100 because the module remains
  todo-only and the communication rail is compact at that viewport.
- Mail responsive work was rejected and is being repaired around a true
  shell-aware 3-to-2-to-1 interaction model; repair commit `fed869b4` is
  awaiting fresh review.
- Overview polish `3a04a2b4` passed fresh `I1_NON_INDEPENDENT` review and is on
  the development preview train as `6381a1d2`.
- Pipeline preflight/release-ordering repairs are locally reviewed but are not
  production evidence.

This snapshot is not a release claim. Production exposure, independent review,
Buck2 Rust execution, combined user-story replay, deployment, and live
production readback remain open.
