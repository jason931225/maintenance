# Benchmark Matrix — Module: object-platform

**Scope:** Ontology manager (object *types*, properties, link types, actions) + object
explorer (instances, links, graph, search-around, actions). This is the *semantic + kinetic*
spine of the console — every other module (workflow, policy, modules, dashboards) is a consumer
of it.

**Columns:** OURS · Palantir Foundry · SAP (S/4HANA MDG + SuccessFactors) · n8n · Slack ·
Microsoft Teams · Asana · Rippling.

**Most-relevant vendors (per brief):** Foundry ontology (THE reference), SAP MDG (master-data
governance), n8n (data pinning). Slack/Teams are near-N/A for a true ontology and are marked so
per-row with reason. Rippling's "Employee Graph" is the closest *non-Foundry* production analog.

Rigor: every vendor claim is **[V]** verified (source URL) or **[I]** inferred (reasoned from
known product patterns). OURS column is grounded in `web/src/console/**` + the read-only audit
`docs/program/ontology-coverage-matrix.md` (cites `file:line`).

---

## OUR CONSOLE — evidence-based baseline

Read from source, not aspiration:

- **Ontology Manager** (`web/src/console/ontology/OntologyManagerScreen.tsx`, 1047 lines):
  typed-property schema authoring (`FIELD_KINDS`), link cardinalities (`ONT_CARDINALITIES`
  1-1/1-many/many-many), action/writeback dispatch declarations (`ACTION_DISPATCHES`), and
  **draft→approve schema governance** via revision staging (`createDraftType`, `applySchemaEdit`,
  `approveRevision`, `discardRevision`, `isStaged` in `ontology/model.ts`). Cedar-gated
  (`PolicyGated`). Lifecycle steps rendered from `wire.ts`.
- **Object Explorer** (`web/src/console/explore/ObjectExplorerScreen.tsx`, 938 lines): single
  search bar → `GET /api/v1/search`; **graph traversal** from
  `GET /ontology/instances/{id}/traverse` folded into a BFS-reachable upstream/downstream layout
  (`ObjectExplorerModel.ts` `collectReachableNodeIds`, `buildObjectExplorerView`); draft-node
  create; type-registry rail; pins an `ObjectCard` into the window manager.
- **ObjectCard** (`web/src/console/objectcard/ObjectCard.tsx`): the shared 3-layer viewer —
  **Semantic** (typed props + links), **Kinetic** (lifecycle + `HistoryTimeline` with
  per-revision `hashVerified` from the tamper-evident audit chain), **Dynamic** (`ActingChips` =
  the `acting_on_instance` decision feed).
- **Backend reality** (`ontology-coverage-matrix.md`): only **4** things are genuinely
  engine-registered ont types — the registry itself (`OT-`), the generic instance (`OB-`), and 2
  seeded governed-config types (`support_slo_setting`, `console_view`, `seed.rs`). The generic
  instance is the **only** object with full dynamic layer wired: `acting_on_instance`,
  `get_as_of`, `history`, `ont_analytics`. Schema-lifecycle FSM (draft→published) is real and
  audited. Cedar decisions log **globally** (`cedar_decision_log`) but are not surfaced per-object.
- **The single largest gap:** the semantic layer is near-empty. Every real business object (work
  order, employee, equipment, voucher, contract, approval) is a **plain domain table with no
  `ont_object_types` registration**. The FE `ONT_TYPES` registry mirrors 7 of them for display but
  is `wire-pending` — a display schema, not backing engine rows.

**Net:** the *grammar* (types→instances→links→graph→actions→3-layer card→as-of→audited) is
Foundry-shaped and already coded; the *coverage* (how many real domains actually flow through it)
is ~4 types deep. We have the engine; we haven't populated it.

---

## Capability Matrix

Cell key: 1–3 lines, HOW that vendor does it, [V]/[I] labeled. `N/A` = vendor doesn't play here.

### 1. Core primitives (object type / instance / property / link)

| OURS | Foundry | SAP MDG/SF | n8n | Slack | Teams | Asana | Rippling |
|---|---|---|---|---|---|---|---|
| Type=`ont_object_types` row w/ typed prop-defs + link-defs; instance=`ont_instances`; only 4 types truly registered, 7 more FE-mirror `wire-pending` (coverage-matrix) | Object type ≈ dataset, object ≈ row, properties = columns; a **typed projection over an existing backing dataset** w/ PK + title key [V] | MDG data model = entity types + attributes + relationships; "any complexity"; SF = person/employment/job objects [V] | No object model — nodes emit JSON items; a "type" is an ad-hoc field shape, not a registered schema [V] | Slack **Lists** = rows/items + typed columns (text/date/person/status); no cross-list schema/registry [V] | No native object model; rides Dataverse tables via Power Platform, or embedded Lists [I] | Task/project/portfolio + **custom fields** (text/number/date/select/people/formula); fields are the data layer [V] | **Employee Graph** = single first-party model linking employees→payroll→device→app; custom fields on it [V] |

### 2. Type authoring (schema editing: PK, title key, typed props)

| OURS | Foundry | SAP MDG/SF | n8n | Slack | Teams | Asana | Rippling |
|---|---|---|---|---|---|---|---|
| Full UI: `FIELD_KINDS` typed props, add/edit via `applySchemaEdit`; no explicit PK/title-key concept yet (uses `code`+`label`) | Ontology Manager UI: display name, types, **declare PK (required, unique)** + **title key** (display), map columns→typed props [V] | MDG data-model UI (USMD) + SF Metadata Framework (MDF) — admin-defined objects/attributes, no-code [V] | N/A — no schema authoring; you shape data in a Set/Edit-Fields node per-workflow [V] | Add/edit list columns inline; column = field type; no reusable type def [V] | N/A natively (Dataverse table designer if via Power Apps) [I] | Create custom field (global=reusable org-wide vs local); formula fields; 100/project cap [V] | Admin adds custom fields to Employee Graph; auto org-chart derives from the model [V] |

### 3. Link / relationship modeling

| OURS | Foundry | SAP MDG/SF | n8n | Slack | Teams | Asana | Rippling |
|---|---|---|---|---|---|---|---|
| `ONT_CARDINALITIES` 1-1/1-many/many-many link-type defs; links are typed edges w/ `relation` label; traversed in explorer | Link type ≈ a join; **1-1 / 1-many / many-many** (m-m needs join dataset); traversable in UI + code [V] | MDG relationships between entity types (e.g. cost-center↔hierarchy); SF associations between objects [V] | N/A — no persistent links; "relationship" = a Merge node joining items at runtime [V] | **Reference** in a list cell can point to another item; no typed relationship graph [I] | N/A [I] | **Reference custom fields** relate tasks↔projects↔portfolios↔goals; dependencies between tasks [V] | Graph *is* the relationships (employee↔manager↔dept↔device); first-party, not user-defined link types [I] |

### 4. Object explorer — search

| OURS | Foundry | SAP MDG/SF | n8n | Slack | Teams | Asana | Rippling |
|---|---|---|---|---|---|---|---|
| Single search bar → `GET /api/v1/search` (limit 10), typed results by kind; Cedar-filtered results | Single search bar over the whole ontology; **search-syntax** DSL; results are objects w/ actions [V] | MDG search via Fiori "Search Master Data" / SF People/position search; not a graph explorer [I] | N/A — no cross-workflow search of business objects [V] | Global message/file/list search; not an object-type-scoped semantic search [V] | Global search across chats/files; no object semantics [I] | Search + saved "Advanced search" reports filter by custom fields across projects [V] | Directory + report search over the Employee Graph; filter by any graph field [I] |

### 5. Graph traversal / search-around

| OURS | Foundry | SAP MDG/SF | n8n | Slack | Teams | Asana | Rippling |
|---|---|---|---|---|---|---|---|
| **Yes** — BFS-reachable upstream/downstream graph from `/instances/{id}/traverse`, laid out around a focus node (`buildObjectExplorerView`) | **Search-around** is a first-class UI verb: hover a result → traverse across a link type; graph view of type-groups; linked-object filtering [V] | Hierarchy views (org/cost-center trees) but no free graph search-around [I] | N/A [V] | N/A — no graph of records [V] | N/A [I] | No graph explorer; Portfolios + Goals trees give partial hierarchy view [I] | Org-chart graph auto-derived; not a general link-traversal explorer [I] |

### 6. Kinetic writeback — Actions (the sanctioned mutation verb)

| OURS | Foundry | SAP MDG/SF | n8n | Slack | Teams | Asana | Rippling |
|---|---|---|---|---|---|---|---|
| `ACTION_DISPATCHES` declared on types; instance mutations go through `acting_on_instance`, audited via `with_audit`; not yet a full param/rules/side-effect action schema | **Action type** = atomic set of edits→**writeback dataset**, w/ parameters, **submission criteria** (validation), **rules**, side-effects (notify/webhook/build). The **sanctioned/default** mutation verb — object edits can be **locked to actions-only** OR reopened to Forms / direct Object-Explorer edit / API [V] | Change Request = the mutation verb: staging (USMD)→workflow→**approve→activate→distribute** to ODS; never direct table write [V] | Nodes call external APIs to mutate; no governed writeback verb over an internal object model [V] | Workflow Builder steps update a list item; ad-hoc, not a typed action schema [I] | Power Automate flows mutate Dataverse/Lists; no native governed action [I] | **Rules**: trigger→action (set field, move, assign); redesigned rule builder Jun-2025 [V] | Workflow Automator: trigger→action over graph data (update payroll/policy/training on relocate) [V] |

### 7. Instance lifecycle / FSM

| OURS | Foundry | SAP MDG/SF | n8n | Slack | Teams | Asana | Rippling |
|---|---|---|---|---|---|---|---|
| Generic instance FSM (draft→active→locked→archived→disposed) validated + audited; many *bespoke* domain FSMs (workorder 16-state, docs custody 12-stage) exist off-engine | Object **statuses** (metadata) + lifecycle enforced by action submission criteria + functions; no single mandated FSM [V] | CR status drives the lifecycle (create→process→approve→activate); staging vs active copy [V] | Execution status per node (success/error/waiting); no business-object lifecycle [V] | List item has a status column; no enforced transitions [V] | N/A [I] | Task status/section; workflow status fields; rules enforce transitions loosely [V] | Employee lifecycle (candidate→hire→active→offboard) drives cross-module automation [I] |

### 8. Version history / as-of / time-travel

| OURS | Foundry | SAP MDG/SF | n8n | Slack | Teams | Asana | Rippling |
|---|---|---|---|---|---|---|---|
| **Real, but only for instances**: `get_as_of` + `history` revision chain + per-revision `hashVerified` (tamper-evident audit chain) in the ObjectCard Kinetic layer | Object edit history via writeback dataset transactions; Ontology **Changelog** tab for schema; branch snapshots [V] | Full CR audit trail; before/after staging images; time-dependency on records (valid-from/to) [V] | No history of business objects; execution log only; **data pinning** freezes a node's last output for dev replay [V] | List item change history / activity; not point-in-time reconstruction [I] | Version history on files; not on records [I] | Task activity log; no as-of reconstruction of custom-field values [I] | Effective-dated records (comp/job changes carry effective dates) [I] |

### 9. Schema governance (branch / proposal / change-request / 전자결재)

| OURS | Foundry | SAP MDG/SF | n8n | Slack | Teams | Asana | Rippling |
|---|---|---|---|---|---|---|---|
| Draft→approve **revision staging** on the type (`approveRevision`/`discardRevision`, `schemaStageTone`), audited; **no branch/merge-check/named-reviewer** flow yet | **Proposals = PRs for the ontology**: branch→merge-checks (conflict)→named reviewer (editor/owner)→merge; protection forces branch+proposal; changelog [V] | The gold standard for governed change: CR type binds workflow+data-model+activity; multi-step approval, parallel/sequential agents [V] | N/A — workflows are versioned by the git-ish "versions" but no schema-approval governance [I] | N/A [V] | N/A [I] | Portfolio/project field changes are ungoverned (admin edits live) [I] | Field/policy changes are admin-gated but not a proposal/review workflow [I] |

### 10. Permissions — row / field / cell-level

| OURS | Foundry | SAP MDG/SF | n8n | Slack | Teams | Asana | Rippling |
|---|---|---|---|---|---|---|---|
| **Cedar PBAC**: `permit/forbid` over principal/action/resource; deny-by-omission; screen/row/card/action all render permitted subset; decisions logged globally | **Object policy** = row (fail→whole instance hidden) + **property policy** = field (fail→null) = **cell-level**; discretionary + mandatory markings; independent of dataset perms [V] | Authorization objects + CR-type/entity-type auth; field-level via UI configs; role-based (PFCG) [V] | Owner/sharee on a workflow; credentials scoping; **no per-record field authz** [I] | Channel/workspace membership; list can be private; no field-level policy [I] | Team/channel membership; Dataverse security roles if used [I] | Project/portfolio membership + share settings; **no field-level** permissions on custom fields [I] | Role-based + attribute-based access to Employee Graph fields (comp visible to HR only) [V] |

### 11. Automation hooks (monitors → effects over the object model)

| OURS | Foundry | SAP MDG/SF | n8n | Slack | Teams | Asana | Rippling |
|---|---|---|---|---|---|---|---|
| Workflow engine + trigger-bindings on types (`trigger_bindings`, `automation_chips` on explorer nodes); Cedar-gated; consumes the same ONT_TYPES engine | **Automate**: Condition (time/object-data/combined over object *sets*) → Effect (Action / function / notify / webhook); same Action verbs humans use [V] | CR triggers workflow; MDG Consolidation/Mass-processing; SF Business Rules + Intelligent Services events [V] | **The reference for this axis** for us: trigger→node graph→effect; but over external APIs, not an internal ontology [V] | Workflow Builder: trigger (message/schedule/form)→steps incl. update list [V] | Power Automate: trigger→actions over Dataverse/365; deep but external to any ontology [I] | **Rules** + **Portfolio rules** (update status/fields/dates/move on trigger); AI Studio adds goals/portfolios/workload Jun-2025 [V] | **Workflow Automator**: any Employee-Graph field as a custom trigger→multi-department effects [V] |

### 12. Extensibility / no-code config (add-anything from where you stand)

| OURS | Foundry | SAP MDG/SF | n8n | Slack | Teams | Asana | Rippling |
|---|---|---|---|---|---|---|---|
| Config-as-governed-object target (§19): module surfaces/dashboards/policies editable via UI, stored as ont objects (draft→approve→effective); partially built (`console_view` seeded) | **Workshop**: apps = declarative docs (widgets + typed variables + event bindings + Actions); no imperative app code; custom iframe widgets [V] | MDG Flex custom entity types; SF MDF custom objects/rules — admin no-code but heavyweight [V] | Node-based no-code + code nodes; **data pinning** = pin a node's output as fixture for dev [V] | Canvas + Lists + Workflow Builder = light no-code; not a platform ontology [V] | Power Platform (Apps/Automate/Pages) = strong low-code, but bolt-on, not native [I] | Custom fields + rules + formula fields = citizen-config; capped, no app builder [V] | Custom fields + Automator; add modules; not a general app/ontology builder [I] |

### 13. Audit / compliance (tamper-evidence, WORM, Korean 전자결재)

| OURS | Foundry | SAP MDG/SF | n8n | Slack | Teams | Asana | Rippling |
|---|---|---|---|---|---|---|---|
| **Strong**: all mutations `with_audit`; tamper-evident hash-chain per revision (`hashVerified` in card); Cedar `cedar_decision_log`; approval objects (`gov_approval_requests`) = native 전자결재 | Changelog + writeback transactions + markings; enterprise audit but not a customer-facing hash-chain by default [I] | Full CR audit + change docs; strong for regulated master data; SoX-grade [V] | Execution logs (retained per plan); no cryptographic audit chain [I] | Enterprise audit logs (Audit Logs API) for admin events; not per-record chain [I] | Purview audit / retention; not object-level tamper-evidence [I] | Admin audit log (Enterprise); no per-field tamper chain [I] | Change history + SOC2; compliance-oriented but not a customer hash-chain [I] |

### 14. Mobile & Korean B2B fit

| OURS | Foundry | SAP MDG/SF | n8n | Slack | Teams | Asana | Rippling |
|---|---|---|---|---|---|---|---|
| Native Android app (`com.maintenance.field`) is field-ops, not the ontology console (web-first); Korean-native (i18n `ko.ts`, group→법인→branch→worksite Cedar scoping, 전자결재 approvals) | Foundry mobile app exists; **weak Korean-B2B fit**: no native 전자결재/근로기준법 model, US-gov origin [I] | Fiori mobile; SAP is deeply localized incl. Korea (payroll/statutory) but 전자결재 needs config [I] | Web-only; no mobile; no localization for KR B2B ops [I] | First-class mobile; Korean UI; but no ontology/master-data model to govern [V] | First-class mobile; Korean UI; same — chat surface, not a data platform [I] | Strong mobile; Korean UI; project mgmt only [I] | Strong mobile; **weak Korea payroll/근로기준법**; US-centric HR model [I] |

---

## Per-vendor: "how they'd build OUR module"

**Palantir Foundry** — Would build exactly our target and then some. Object types = typed
projections over our existing Postgres tables (no data migration: `equipment`, `employees`,
`gov_approval_requests` become object types with a declared PK + title key). Every mutation becomes
an **Action type** with parameters, submission-criteria validation, and rules, landing in a
writeback store — collapsing our bespoke domain FSMs onto one kinetic surface (object edits can be
**locked to actions-only**, or reopened to Forms / direct-edit / API — it's a configurable lockdown,
not an absolute mandate). Schema
changes go through **branch → proposal → merge-check → reviewer → changelog** (a superset of our
draft→approve staging). Security = object policy (row) + property policy (cell) evaluated
identically for UI/automation/API — our exact Cedar posture. Object Explorer with search-around +
linked-object filtering ships day one. This *is* our north star; the gap is coverage + governance
depth, not grammar.  [V, brief §1 + Foundry docs]

**SAP (MDG + SuccessFactors)** — Would make **governance the product**. Every object edit is a
**Change Request** with a configured workflow (staging tables → multi-agent approval → activation →
distribution), which maps 1:1 onto Korean **전자결재** and is our single biggest steal. The data
model (entity types + attributes + relationships, MDG Flex custom entities / SF MDF) is admin-no-code
but heavyweight. Time-dependency (valid-from/to) is native on records. Weakness vs us: no
graph-explorer / search-around, and the UX is transaction-heavy Fiori, not a fluid object canvas.
Their version = airtight audit + approval, clunky exploration.  [V, SAP Help + MDG docs]

**n8n** — Doesn't build an ontology; builds the **automation seam** over it, and contributes one
sharp idea: **data pinning**. For our module, n8n-thinking says: when authoring a type/action/policy,
let a builder **pin a real instance's payload as a fixture** so they can design and preview the card,
the traversal, and the writeback without hammering the live object or waiting on the backend. That
maps directly onto our "config-as-data + preview" story and our test-seams. Everything else (types,
graph, governance, cell-level authz) is N/A for n8n.  [V, n8n data-pinning docs]

**Slack** — Near-N/A as an ontology. Its relevant primitive is **Lists** (typed rows/columns) +
**Canvas** + link-unfurl. A Slack-built version of our module would be *flat*: a List per object
type, typed columns, a reference cell for "links," Workflow Builder for automation — no graph, no
schema governance, no cell-level policy, no as-of. What Slack does teach: make the object surface
*conversational and embeddable* (unfurl an object reference into any thread; embed a List view in a
Canvas dashboard). Steal the surfacing, not the model.  [V, Slack Lists/Canvas help]

**Microsoft Teams** — N/A natively; Teams has no object model. A "Teams version" is really a **Power
Platform** version: Dataverse tables as the object store, Power Apps as Workshop, Power Automate as
Automate, Dataverse security roles as authz. Capable but bolt-on and fragmented across four products
— the opposite of our "single engine, many consumers." Reason it's mostly N/A: chat/collab is the
product; structured data is an add-on people assemble themselves.  [I]

**Asana** — Would build a **custom-fields-first** version. Object type ≈ project template; property ≈
custom field (text/number/date/select/people/**formula**); link ≈ **reference custom field** relating
tasks↔projects↔portfolios↔goals; automation ≈ Rules + Portfolio Rules. It's a genuinely usable
citizen-config model — but capped (100 fields/project), no true instance graph, no schema governance,
no field-level permissions, no as-of. Their version is friendly and shallow: great field ergonomics,
no semantic depth.  [V, Asana custom-fields + rules docs]

**Rippling** — The most instructive **non-Foundry** analog: the **Employee Graph** proves that a
single first-party object model, with relationships and custom fields, driving cross-module automation
(**Workflow Automator** triggering on *any* graph field), is a shipped, loved product — not a
research toy. A Rippling-built version of our module would center one canonical graph (org →
법인 → worksite → employee → equipment → approval), attribute-based field visibility (comp = HR-only),
and automation over every field. Weakness: the graph is *first-party and closed* — you consume it,
you don't author arbitrary object types; and Korean statutory/근로기준법 payroll is weak.
This is our proof that ontology-first + automation-over-the-graph is the right bet at B2B scale.
[V, Rippling platform/workflows + Employee Graph]

---

## What we'd steal — ranked

| # | Capability | Best-in-class | Fit with our ontology-first grammar | Cost |
|---|---|---|---|---|
| 1 | **Register real domains as engine object types** (typed projection over existing tables + PK + title key) — close the near-empty semantic layer | **Foundry** [V] | This *is* the engine we already built; today only 4 types flow through it. Turn the 7 `wire-pending` FE mirrors + the north-star chain (contract→position→posting→employee) into real `ont_object_types` rows. Highest leverage on the board. | **L** |
| 2 | **Actions as the one sanctioned writeback verb** (params + submission-criteria validation + rules + side-effects → writeback), replacing scattered bespoke FSMs | **Foundry** [V] | We have `ACTION_DISPATCHES` + `acting_on_instance` + universal `with_audit`; we lack the param/validation/side-effect action *schema*. Unifies human + automated mutation on one audited surface. | **L** |
| 3 | **Change-Request / branch-proposal schema governance** (staging → named reviewer → merge-check → activate → changelog) = native **전자결재** | **SAP MDG** (governance) + **Foundry** (branch/proposal) [V] | Extends our existing draft→approve revision staging with named reviewers + merge-checks; reuses `gov_approval_requests`. Directly serves Korean 전자결재 culture — a hard local requirement global vendors miss. | **M** |
| 4 | **Cell-level policy** = object policy (row→hidden) + property policy (field→null) | **Foundry** [V] | Our Cedar spine already does row + action; property-policy (field returns null, object still visible) is a small, high-value extension to `cedarScreenGuard` / backend eval. Deny-by-omission stays. | **M** |
| 5 | **Automate: monitors over object *sets* → effects** (condition on object-data → Action/function/notify/webhook), sharing the human Action verbs | **Foundry** [V] + **Rippling** (any-field triggers) [V] | We have trigger-bindings + a workflow engine consuming ONT_TYPES; formalize "condition over an ontology query → same Action as the effect." Rippling proves the any-field-trigger UX. | **M** |
| 6 | **Search-around as a first-class explorer verb** + linked-object filtering + charts on linked types | **Foundry** [V] | Our explorer already does BFS traversal + focus layout; add hover-to-traverse-across-a-link-type and filter-main-set-on-linked-props. Mostly FE. | **S** |
| 7 | **Data pinning for authoring/preview** — pin a real instance payload as a fixture while designing a type/action/policy | **n8n** [V] | Slots into our config-as-data + test-seam story; lets non-devs preview a card/traversal/writeback without live calls. Small, delightful. | **S** |
| 8 | **Reference field ergonomics** — typed reference-fields relating instances, formula/derived fields | **Asana** [V] (refs/formula) + Foundry (shared/computed props) | Complements our link types with lightweight in-card references + computed props (we have `ont_analytics` derived props already). Ergonomic polish. | **S** |
| 9 | **Effective-dating / valid-from-to on records** (time-dependency), beyond instance as-of | **SAP** [V] + Rippling [I] | We have `get_as_of`/`history` for instances; generalize effective-dating so as-of reconstruction covers domain records (comp, job, policy) too. | **M** |
| 10 | **Embeddable/unfurlable object references** — surface an object into any thread/canvas/dashboard | **Slack** [V] | Fits our window-manager + ObjectCard: an object reference token that unfurls into the 3-layer card anywhere. We already have `objDrag` reference tokens. | **S** |

**Korean B2B note:** #3 (전자결재 change-request governance) and our existing group→법인→branch→worksite
Cedar scoping are where global vendors mismatch local needs — Foundry/Asana/Rippling have no native
전자결재 or 근로기준법 model, SAP has the approval spine but a heavyweight Fiori UX. Our edge is
Foundry-grade grammar + native Korean governance; the work is coverage (#1) and closing the
governance/authz/automation gaps (#2–#5).

---

### Sources
- Foundry: [object-types](https://www.palantir.com/docs/foundry/object-link-types/object-types-overview), [link-types](https://www.palantir.com/docs/foundry/object-link-types/link-types-overview), [actions](https://www.palantir.com/docs/foundry/action-types/overview), [functions](https://www.palantir.com/docs/foundry/functions/api-objects-links), [object-explorer](https://www.palantir.com/docs/foundry/object-explorer/overview), [proposals](https://www.palantir.com/docs/foundry/ontologies/ontologies-proposals), [object/property policies](https://www.palantir.com/docs/foundry/object-permissioning/object-and-property-policies), [Automate](https://www.palantir.com/docs/foundry/automate/overview), [Workshop widgets](https://www.palantir.com/docs/foundry/workshop/concepts-widgets)
- SAP: [MDG data modeling (Help Portal)](https://help.sap.com/docs/SAP_S4HANA_ON-PREMISE/6d52de87aa0d4fb6a90924720a5b0549/0bf59bff27284ddc8fde12261856c4f4.html), [MDG workflow modeling](https://medium.com/@sarojmeher200690/sap-mdg-workflow-modeling-ceb672e88d12), [MDG 2025 guide (MDP)](https://mdpgroup.com/en/blog/sap-master-data-governance-sap-mdg/)
- n8n: [data pinning](https://docs.n8n.io/data/data-pinning/)
- Rippling: [Workflows](https://www.rippling.com/platform/workflows), [Rippling Platform / Employee Graph](https://www.rippling.com/blog/introducing-rippling-platform)
- Asana: [custom fields guide](https://developers.asana.com/docs/custom-fields-guide), [reference custom fields](https://help.asana.com/s/article/reference-custom-fields), [portfolio rules](https://forum.asana.com/t/save-time-and-manage-portfolio-workflows-at-scale-with-portfolio-rules/915400)
- Slack: [Lists/Canvas data management](https://slack.com/help/articles/15708101445011-How-data-management-features-apply-to-canvases-and-lists), [Canvases (dev)](https://docs.slack.dev/surfaces/canvases/)
- OURS: `web/src/console/ontology/OntologyManagerScreen.tsx`, `web/src/console/explore/ObjectExplorerScreen.tsx` + `ObjectExplorerModel.ts`, `web/src/console/objectcard/ObjectCard.tsx`, `docs/program/ontology-coverage-matrix.md`, `docs/program/benchmark-brief.md §1`

---

## Cross-cutting lens findings (5 independent review lenses)

- **Task-flow:** money task = *create a no-code type that wires itself end-to-end*. Ours is **NOT no-code — 6 manual hand-edits** (generic create-action not auto-attached, triplicated hardcoded code-prefix regex, hardcoded MOD_SCREENS map, ko.ts labels, FE ONT_TYPES mirror, free-text policy/automation candidates). Palantir: define the type/action once in Ontology Manager → it propagates to every downstream app automatically. **Steal:** auto-propagation on publish (create-action auto-attach + registry-derived code prefixes + data-driven MOD_SCREENS + ONT_TYPES from `GET /object-types`) — this is Phase C wave 2's stated acceptance test. Cost **L**.
- **IA / layout:** our closest-to-Palantir surface and strategic core; we have object card + relation authoring + ontology manager but likely lack (a) configurable object-group side-nav, (b) chart-as-filter exploration, (c) saveable/shareable Layouts, (d) multi-object tabs. **Steal:** **chart-as-filter exploration view** (each chart = a property aggregation, click to filter the set) — the single highest-fidelity gap for the differentiator [L]; saveable shareable Layouts [M]; object-group side-nav [M]; Object View tabs [L].
- **Data-model (the head-to-head):** **Stronger than Foundry on 4 axes** — (1) fixity/tamper-evidence in the object model (L20 hash-chain on instance revisions; Foundry does not hash-chain instance revisions), (2) governance native to every write (instance FSM + override(reason+four-eyes) + Cedar property-policy with partial-eval→SQL residual deny-by-omission), (3) object-level as-of/bitemporal for instance types, (4) effective-dated config-as-governed-object. **Weaker:** (1) **branching/proposal-as-PR** (Foundry Global Branching — proposal = PR with reviewers/changelog/isolated preview; ours is linear draft→publish — their clearest edge), (2) populated breadth (~4 registered types; projected-action dispatch still `NotWiredYet`), (3) base-type richness (10 FieldKinds vs Foundry geospatial+time-series). **Steal:** Foundry ontology branching / proposal-as-PR [L]; Functions-on-objects [L]; geospatial + time-series base FieldKinds [M].
- **Governance:** **Par with Foundry** on object governance (genuinely peer-tier); **Behind on marking-propagation via lineage** — Foundry marks a source cell and every derived dataset inherits the eligibility gate; we filter at query time (residual) but don't propagate a sensitivity marking down derivation lineage. **Steal:** sensitivity markings that propagate down link/derivation lineage (marking = property + a forbid-policy keyed on it; propagation follows link-types) — the highest-value governance feature we lack [L]; purpose-based access [M].
- **Automation / extensibility:** Foundry IS our north star; its extensibility model is the one we're consciously copying (one ontology, many consumers; Actions = the only mutation verb; Automate monitors → effects). We lag on Functions, external API/OSDK, webhook/notification effects. **Steal:** effect parity with Foundry Automate (action/function/notification/webhook) [M–L]; deterministic "function-backed action" (governed, sandboxed, no-AI escape-hatch) [L]; OSDK-style external API (likely YAGNI for a single conglomerate — flag, don't build) [L].

**Adjudication:** the "Action = ONLY sanctioned mutation" framing (Row 6, per-vendor Foundry) is **softened** — Foundry object edits can be *locked to actions-only* OR reopened to Forms / direct Object-Explorer edit / API; it's a configurable lockdown, not an absolute mandate (corrected above).
