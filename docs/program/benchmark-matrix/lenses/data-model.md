# DATA-MODEL / OBJECT-SEMANTICS lens — 14 modules

**Question per module:** how does each vendor model the underlying objects —
*typed? linked? versioned? effective-dated?* — vs our ontology engine, and where
is our object model **stronger** or **weaker**.

**Our engine, evidence-based** (read from `web/src/console/**` +
`docs/program/{console-program-ledger.md,ontology-coverage-matrix.md}`):
- **Typed**: `ont_object_types` → `ont_property_defs` (10 FieldKinds: text/number/money/date/datetime/boolean/choice/user/object_ref/attachment; arch says ~35) with `required`, per-property policy flag. `objectcard/types.ts`, `ontology/types.ts`.
- **Linked**: `ont_link_types` as a **4-tuple `[rel, to, cardinality, reverse-name]`** (one_one/one_many/many_many), instance edges in `ont_links`, graph traversal REST (depth-bounded). `objectcard/types.ts:31`.
- **Versioned**: append-only `ont_instance_revisions`, **content-addressed schema versions** (published = immutable, v+1, superseded/retired FSM), **row_hash fixity chain** (L20 canonicalizer, tamper-detected). `ontology/types.ts:7`, coverage-matrix OB-/OT- rows.
- **Effective-dated**: `valid_from/valid_to` + **`get_as_of` reconstruction** + `history` (proven for `ont_instances`). D2: audit-derived history for projected types, full bi-temporal only for instance-backed.
- **Two backing modes**: *projected* (domain tables surfaced as typed projections — WO/employee/equipment) vs *instance-backed* (engine-owned store).
- **Governance native to the model**: draft→active→locked→archived→disposed instance FSM; every transition = audit event; edits on non-draft require **override(reason+four-eyes)**; Cedar object-policy(row)+property-policy(field) with **partial-eval → residual → SQL WHERE** deny-by-omission.

**Honest reality check (weakness that spans every module):** the engine is BUILT
and PROVEN but the **catalog is near-empty — only ~2-4 types actually registered**
(`support_slo_setting`, `console_view`, OT-, generic OB-); every business object
(WO/employee/finance/leave/support/evidence) is still a **plain domain table not
engine-registered**, and the FE `ONT_TYPES` mirror is a hand-authored wire-pending
constant (coverage-matrix). So our *architecture* out-models the vendors; our
*populated model* does not yet. Every "stronger" claim below is about the engine
design + governance semantics, not breadth of shipped types.

Vendor claims labeled **[V]** (verified, URL) or **[I]** (inferred). N/A = vendor
doesn't play here.

---

## 1. overview
A landing/portal surface, not a data domain of its own — it *projects* other
objects. Data-model relevance = whether the portal is a typed object or hardcoded.

| Vendor | Typed | Linked | Versioned | Eff-dated | Note |
|---|---|---|---|---|---|
| Palantir Workshop home | ✅ objects | ✅ | via ontology | N/A | Home = a Workshop module bound to ontology object sets [V] |
| ServiceNow homepages | ◐ tables | ✅ ref | ◐ | ✗ | portal widgets over tables [I] |
| **Ours** | ✅ (once `console_view` populated) | ✅ | ✅ governed-config-as-instance | ✅ as-of | overview = a `console_view` ont instance, staged draft→approve |

**Stronger than them:** the overview/dashboard config is itself a **governed
ontology object** (`console_view` is engine-registered TODAY — coverage-matrix),
so the landing page has draft→approve→effective + rollback + as-of. Foundry Home
is configured but not itself a first-class versioned business object with four-eyes.
**Weaker:** Foundry Home ships live object-set widgets out of the box; ours needs
the widget→ontQuery binding finished (post-replica backlog).

**What we'd steal (ranked):**
1. Object-set-bound home widgets (Palantir) → fits our ontQuery grammar → **M**.
2. Per-persona default home resolved from role attributes (Workday landing) → Cedar principal-attr already exists → **S**.

---

## 2. dashboard
| Vendor | Typed | Linked | Versioned | Eff-dated | Note |
|---|---|---|---|---|---|
| Palantir Quiver/Workshop | ✅ ontology-bound | ✅ | ✅ ontology | ◐ | metrics are functions over typed objects [V-inferred from ontology docs] |
| Tableau/Power BI/Looker | ◐ semantic layer (LookML typed) | ◐ joins | ◐ git-versioned (Looker) | ✗ | dashboards over a modeled layer, not effective-dated objects [I] |
| **Ours** | ✅ live ontQuery widgets | ✅ drill→ObjectCard | ✅ config = instance | ✅ | scope×period matrix, honest-scale (§4-24), drill-everything to the 3-layer card |

**Stronger:** every dashboard tile **drills to the governed 3-layer ObjectCard**
(lifecycle + fixity history + acting policies), not just a filtered row — the metric
and its provenance share one object model. Looker's LookML is typed+git-versioned
but has no lifecycle/as-of on the *underlying facts*. **Weaker:** BI vendors have
mature aggregation/semantic-join engines; our widget chart-binding is still partly
stub (ledger: "widget chart-binding" in post-replica backlog).

**What we'd steal:**
1. Looker's git-versioned semantic model as the pattern for our `console_view` diffs → we already version, borrow the **diff/merge UX** → **M**.
2. Power BI incremental-refresh windows → maps to our effective-dated folds → **M**.

---

## 3. finance
| Vendor | Typed | Linked | Versioned | Eff-dated | Note |
|---|---|---|---|---|---|
| SAP S/4HANA GL | ✅ document types + line items | ✅ (doc header↔lines, ledger) | ✅ **document principle — posted doc immutable until archive** | ✅ posting date/period | every txn = a saved document, min 2 lines D/C, never mutated [V] |
| Workday Financials | ✅ business objects | ✅ | ✅ | ✅ effective-dated | [I] |
| NetSuite | ✅ record types | ✅ | ◐ | ◐ | [I] |
| **Ours** | ◐ FE mirror `finance_voucher`, **no backend voucher/posting table** — CostLedgerSource append model | ◐ contract link-chip only | ✅ append-only | ◐ | coverage-matrix VC-/JP-/PO- rows: posting JP- has NO entity |

**Weaker than SAP here — call it out:** SAP's **document principle is exactly our
append-only-immutable philosophy, but *populated* and battle-proven for GL**; we
have the append substrate but **no posting/voucher entity** (JP- "no table", VC-
"no backend voucher table"). This is our single biggest data-model gap vs a
category leader. **Where our design would be stronger once built:** SAP documents
are immutable but their *audit fixity* is DB-trust; our revisions carry a **hash
chain** (tamper-*evident*, not just tamper-resistant), and a voucher would inherit
Cedar property-policy field-masking + as-of for free. Korean context: 전표/분개 must
map to 부가세/원천세 and 세금계산서 — SAP localizes this; we'd need the 전표 entity to
carry Korean tax typed props.

**What we'd steal:**
1. **SAP document principle as the voucher/posting entity spec** (immutable header+lines, doc-type registry) → maps 1:1 onto instance-backed ont type + our hash chain → **L** (biggest finance win).
2. Extension-ledger concept (parallel valuation) → model as a link-typed shadow revision → **M**.
3. Number-range/document-type registry → a `finance_voucher` ont_object_type with typed doc-type choice → **S**.

---

## 4. people (HR)
| Vendor | Typed | Linked | Versioned | Eff-dated | Note |
|---|---|---|---|---|---|
| **Workday HCM** | ✅ business objects | ✅ **Worker→Position→JobProfile→SupOrg nested** | ✅ | ✅ **effective-dating is the core primitive** — correct(overwrite) vs new-dated-change | almost every Core-HCM object is effective-dated; entry-date + effective-date dual stamp [V] |
| SAP SuccessFactors | ✅ | ✅ | ✅ | ✅ MDF effective-dated | [I] |
| BambooHR | ◐ fields | ◐ | ◐ history | ◐ | lighter model [I] |
| **Ours** | ◐ FE mirror; `employees` table **not engine-registered**; `position` is a **string column, not an entity** | ◐ inline lifecycle-events FSM | ◐ REST lifecycle-events, audited | ◐ audit-derived | coverage-matrix employee/position rows |

**Weaker — Workday is the gold standard our effective-dating aspires to.** Workday's
**correct-vs-new-effective-change distinction** (retroactively overwrite history vs
append a future-dated slice) is *precisely* our draft-direct-vs-override semantics
but far more mature and pervasive; and Workday makes **Position a first-class object**
in a nested chain, where we store `employees.position` as a **string**. **Where we'd
be stronger:** Workday's effective-dating is proprietary and opaque per-tenant
(search: "every customer a different schema, not discoverable"); ours is **one
uniform engine with a public typed registry + hash-fixity + Cedar field-masking**,
and our override path carries an explicit **reason + four-eyes audit event** Workday
buries in transaction logs. Korean context: 근로기준법 requires typed 근로계약(per-shift
C-D), 4대보험 filing objects, 연차 rounds — Workday localizes weakly for Korea; our
default-catalog directive ships these as typed objects (a genuine local edge).

**What we'd steal:**
1. **Position/Job-Profile as first-class linked objects** (Workday) → instance-backed ont types in the C-→Position→Posting→Employee chain (already the north-star acceptance test) → **L**.
2. Workday's **correct vs. new-effective-dated-change** UX distinction → map onto our draft-direct/override + as-of, make the two paths explicit in ObjectCard → **M**.
3. Dual entry-date/effective-date stamping (bi-temporal) → we have valid_from/to; add the entry-date axis for instance types → **M**.

---

## 5. leave
| Vendor | Typed | Linked | Versioned | Eff-dated | Note |
|---|---|---|---|---|---|
| Workday Absence | ✅ leave/time-off objects | ✅ →Worker | ✅ | ✅ effective-dated accruals | [I from Workday model] |
| Korean 근태 (Shiftee/flex/Hanbiro) | ◐ | ◐ | ◐ | ◐ | 연차 rules typed to 근로기준법 [I] |
| **Ours** | ✗ `leave_requests` (mig `0122_create_leave_requests`; promotions `0123`) **not engine-registered** | ◐ →employee | ✅ FSM DRAFT→SUBMITTED→APPROVED/REJECTED, audited, decider≠requester CHECK | ✗ | coverage-matrix leave rows: shared card + promotion rounds |

**Mixed.** Our leave has a **real audited FSM with SoD (decider≠requester CHECK)**
and 촉진 promotion rounds typed to 근로기준법 — a Korean-specific edge Workday Absence
doesn't ship natively. **Weaker:** Workday models **accrual balances as
effective-dated derived quantities**; ours is request-centric with no effective-dated
balance object, and leave isn't yet an engine-registered type (so no as-of on a
leave balance). **Stronger:** 연차촉진 round + 노무수령거부 modeled as a **backend §61 flow**
(default-catalog **directive**, not yet engine-registered as an ontology type — ledger §194: catalog 2 of
~30 shipped, 노무수령거부 = same-PR seedable) is genuinely ahead of global vendors on KR domain semantics,
pending ontology registration.

**What we'd steal:**
1. Workday **effective-dated accrual/balance object** (not just requests) → new instance-backed `leave_balance` type folding grants−takes as-of → **M**.
2. Carryover/expiry as effective-dated slices → our valid_from/to fits → **S**.

---

## 6. support
| Vendor | Typed | Linked | Versioned | Eff-dated | Note |
|---|---|---|---|---|---|
| **Zendesk** | ✅ **custom objects** (≤100 fields) + native ticket/user/org | ✅ **lookup relationship fields** (5-10/obj), junction objects for M:N | ◐ (audit events, no object versioning) | ✗ | you extend the data model with typed custom objects + typed lookups [V] |
| ServiceNow ITSM | ✅ tables, extend base | ✅ reference fields | ◐ | ✗ | [V] |
| Jira SM | ◐ issue types + fields | ◐ | ◐ | ✗ | [I] |
| **Ours** | ◐ FE mirror `support_ticket`; real `support` crate table not engine-registered; but **`support_slo_setting` IS engine-registered** | ◐ | ✅ TicketStatus FSM audited; SLO setting = governed instance w/ pendingRev staging | ◐ | coverage-matrix support/SLO rows; §4-26 SLO≠SLA |

**Close, different axes.** Zendesk's **custom-objects + typed lookup relationships**
is a mature no-code object-extension model — arguably ahead of our *populated* state
(their custom objects work today; our tickets aren't engine-registered yet).
**Where we're stronger:** Zendesk custom objects **aren't versioned or effective-dated
and their config isn't governed** — our **SLO setting is a governed ontology instance
with draft→approve staging + as-of** (§4-26), which no support vendor offers for their
config. And our ticket FSM is audited with hash-fixity. Zendesk's lookup cap (5-10)
vs our uncapped typed 4-tuple links is a modeling-ceiling difference.

**What we'd steal:**
1. **Zendesk custom-objects + typed lookup UX** as the reference for no-code ticket-adjacent types (our add-a-type still has 6 manual steps — coverage-matrix) → **M**.
2. Junction-object pattern for M:N → we already have many_many links; borrow their **relationship-field authoring UI** → **S**.

---

## 7. evidence
| Vendor | Typed | Linked | Versioned | Eff-dated | Note |
|---|---|---|---|---|---|
| WORM/records (NetApp SnapLock, CTERA, DAM 17a-4) | ◐ file+metadata | ✗ | ✅ **every change = new version, immutable, retention-expiry** | ◐ retention dates | hash/digital-signature fingerprint per record; chain-of-custody audit trail [V] |
| Veritas/OpenText RM | ✅ record classes | ◐ | ✅ | ✅ retention schedules | [I] |
| **Ours** | ✗ `docs_evidence_objects` (mig `0151_create_docs_evidence_objects`) **not engine-registered** | ◐ custody chain | ✅ **12-stage custody FSM, WORM copies w/ SHA-256, nullable TSA, holds, exports** | ◐ | coverage-matrix EV- row: shared card + real /verify fixity |

**Stronger than commodity WORM, weaker than dedicated RM.** Our evidence has a
**12-stage custody FSM + real fixity re-verify (HEAD each WORM copy, hash-normalize,
audited) + legal-hold four-eyes** — richer *object semantics* than a SnapLock volume
(which is storage-layer immutability with thin metadata). **Weaker vs Veritas/OpenText:**
they ship **effective-dated retention schedules + record-class taxonomies + disposition
workflows**; ours has holds but **no retention-schedule object** and TSA anchoring is
nullable (RFC-3161 TSA is a post-replica backlog item). Korean context: 전자문서 &
공인전자문서센터 / 수령확인 문서 — our default catalog lists 법정 수령확인 문서; global RM doesn't.

**What we'd steal:**
1. **Effective-dated retention-schedule + disposition object** (Veritas) → instance-backed `retention_schedule` type driving the disposed lifecycle state → **M**.
2. 17a-4-style **immutable-fingerprint attestation** (already have SHA-256; add RFC-3161 TSA) → **M** (backlog).
3. Record-class taxonomy as ont types → our registry fits → **S**.

---

## 8. object-platform (the head-to-head)
| Vendor | Typed | Linked | Versioned | Eff-dated | Note |
|---|---|---|---|---|---|
| **Palantir Foundry Ontology** | ✅ object types + properties (time-series, geospatial base types) | ✅ **link types 1:1/1:many/many:many** | ✅ **Global Branching — ontology proposal = PR; changelog; status active/experimental/deprecated** | ◐ time-series props, not object-level bitemporal | THE comparator; action types = declarative edit-sets w/ side-effects [V] |
| Microsoft Dataverse | ✅ typed tables/columns | ✅ relationships | ◐ | ✗ | [I] |
| Salesforce | ✅ custom objects + typed fields | ✅ lookup/master-detail | ◐ **field history (20 fields, 18 months)** | ✗ | history is field-scoped + time-capped, not object-versioning [V] |
| **Ours** | ✅ ont_object_types + 10 FieldKinds + property-policy | ✅ **4-tuple link (adds reverse-name)** | ✅ content-addressed immutable versions + **hash-fixity chain** | ✅ **as-of reconstruction + bi-temporal (instance types)** | the engine |

**Where we're STRONGER than Foundry (call it out):**
1. **Fixity/tamper-evidence in the object model.** Foundry versions ontology
   resources (proposals, changelog) but does **not** hash-chain object *instance*
   revisions for tamper-evidence; ours does (L20 canonicalizer, verify_chain).
   [V for Foundry branching; our fixity = coverage-matrix OB-].
2. **Governance is native to every write.** Our instance FSM + override(reason+
   four-eyes) + Cedar property-policy field-masking is enforced **on the object
   model itself**; Foundry Actions have side-effects + Cedar-like permissions but
   field-level property-policy with **partial-eval→SQL residual deny-by-omission**
   is our distinctive substrate [V our residual; Foundry = separate governance layer].
3. **True object-level as-of / bitemporal** for instance types. Foundry's point-in-time story centers on
   time-**series properties** + edit-history writeback transactions; a *uniform object-level as-of/bitemporal
   reconstruction* is our engine's native primitive [I] (avoid asserting Foundry lacks it as verified fact —
   it exposes edit history via the Ontology changelog).
4. **Effective-dated no-code config-as-object** (support_slo/console_view governed
   instances) — Foundry config isn't itself a versioned business object with four-eyes.

**Where we're WEAKER than Foundry (honest):**
1. **Branching/proposal workflow.** Foundry has **Global Branching — an ontology
   proposal is a PR with reviewers, changelog, isolated test-before-merge** [V]. Our
   schema lifecycle is draft→review→publish (linear, single-track); we have no
   branch/merge/isolated-preview of schema changes. This is their clearest edge.
2. **Breadth + maturity of populated types + Functions/Workshop consumer stack.**
   Foundry ships a rich compute layer (Functions on objects) over a fully populated
   ontology; ours has ~2-4 registered types and projected-action dispatch is still
   `NotWiredYet` (ledger: "THE biggest §18 residual").
3. **Base-type richness** — Foundry has geospatial + time-series base property types;
   we have 10 FieldKinds (arch says 35 planned).

**What we'd steal (highest-value module):**
1. **Foundry ontology branching / proposal-as-PR** → extend our draft→publish to a branch/merge model w/ isolated preview → **L** (our biggest object-platform gap).
2. **Functions-on-objects** (typed compute bound to object types) → our `ont_analytics` is the seed; grow to invokable typed functions → **L**.
3. **Geospatial + time-series base property types** (Foundry) → add FieldKinds → **M** (Korea terrain layer already wanted for dashboard).
4. Salesforce master-detail cascade semantics for owned children → link cardinality already there; add cascade-lifecycle → **S**.

---

## 9. policy
| Vendor | Typed | Linked | Versioned | Eff-dated | Note |
|---|---|---|---|---|---|
| **AWS Cedar / Verified Permissions** | ✅ **schema: entityTypes + attributes + actions + commonTypes** | ✅ entity refs (photographer→User) | ◐ policy store versioning | ✗ | principals/resources are typed entities w/ attrs; schema validates policies [V] |
| OPA/Rego | ◐ untyped JSON data | ◐ | ◐ bundle versions | ✗ | schemaless data documents [V-inferred] |
| **Ours** | ✅ Cedar catalog + **blocks→normalized_row→Cedar text**, object/property policies typed to ont types | ✅ policies reference ont object/link types | ✅ draft/publish staging FSM + pendingRev per-policy | ◐ | coverage-matrix policy row; residual→SQL |

**Stronger than raw Cedar/OPA.** We **use** Cedar's typed-entity model but add:
(a) **no-code P→R→A→Effect canvas → normalized_row → generated Cedar text** with live
simulator (deny-by-omission), (b) **policies are governed ontology objects** with
draft→approve staging + audit, (c) **partial-eval → residual → SQL WHERE** for
list-filtering (Cedar's `is_authorized_partial` is experimental — we lowered our own
grammar per D1). Raw Cedar is a decision library; OPA is *schemaless* (weaker typing
than both). **Weaker:** Cedar's **schema-validation of policies against entity types**
is a mature safety net; our residual **fail-closes to DENY on any untranslatable term**
(safe but coarser than full validation). AVP also has managed policy-store versioning
we approximate with staging.

**What we'd steal:**
1. **Cedar schema-based policy validation** (catch type errors at author time, not runtime-deny) → bind our block editor to the ont-type schema for pre-submit validation → **M**.
2. `commonTypes` reuse (Cedar) → shared predicate fragments in our canvas → **S**.

---

## 10. automate
| Vendor | Typed | Linked | Versioned | Eff-dated | Note |
|---|---|---|---|---|---|
| **n8n** | ◐ **items = array of `{json, binary}` — largely untyped/schema-inferred** | ✗ (data flows node→node, no object links) | ◐ workflow JSON versioned; node-type versions | ✗ | data is JSON items, schema inferred per-run, not a typed object model [V] |
| Temporal | ◐ typed activities/signals | ✗ | ✅ workflow versioning/replay | ✅ event-sourced history | durable event-sourced execution [I] |
| Zapier/Workato | ◐ mapped fields | ✗ | ◐ | ✗ | [I] |
| **Ours** | ✅ **effect = ontology action** (typed dispatch: projected_usecase / instance_revision) | ✅ acts on typed ont objects | ✅ workflow def publish FSM + four-eyes, run/node FSM audited | ◐ | coverage-matrix workflow row; Automate = ontology action |

**Stronger than n8n/Zapier — clearest data-model win in automation.** n8n's data is
**untyped JSON items with per-run inferred schema** — no object identity, no links, no
governance. Our automation **effect IS a typed ontology action** dispatched through the
same writeback path humans use (projected_usecase/instance_revision), so an automation
edit is **indistinguishable from a governed human edit** — same audit, same Cedar gate,
same fixity. n8n can't reference "the WO object" as a typed linked entity; it passes a
JSON blob. **Weaker vs Temporal:** Temporal's **event-sourced durable execution with
replay + workflow versioning** is more mature than our run/node FSM for long-running,
retryable orchestration; and n8n's **connector breadth** dwarfs ours.

**What we'd steal:**
1. **Temporal-style event-sourced durable execution + replay** → our run-log is close; add deterministic replay over the append log we already have → **L**.
2. n8n **connector/integration breadth** (typed triggers on external systems) → **M** (ongoing).
3. n8n Schema-view auto-inference for mapping external JSON onto typed ont props → aids DX- ingest mapping → **M**.

---

## 11. comms
| Vendor | Typed | Linked | Versioned | Eff-dated | Note |
|---|---|---|---|---|---|
| Slack | ◐ messages/channels/users objects (Web API), typed events | ◐ thread_ts links | ✗ (edit history thin) | ✗ | conversation objects, not business-object links [I] |
| MS Teams / Graph | ◐ chatMessage/channel typed via Graph | ◐ | ◐ | ✗ | [I] |
| Gmail | ◐ message/thread/label | ◐ threading | ✗ | ✗ | [I] |
| **Ours** | ✗ `messenger_*` (core `0012_create_messenger`; acks `0134`, presence `0135`) **not engine-registered**, no thread FSM | ◐ **object-card unfurl / #code drag-drop into messages** | ◐ acks/presence, audited | ✗ | coverage-matrix messenger/mail rows |

**Stronger on object-linkage, weaker on messaging maturity.** Our distinctive edge:
messages can **carry typed object references** (#WO-2643 drag-drop, object-card unfurl,
PBAC-gated drop target) — a message links to a governed business object, which Slack/
Teams/Gmail do only via unfurled URLs, not first-class typed edges into an ontology.
**Weaker:** threads/channels **aren't engine-registered** (no thread lifecycle object,
no as-of), and Slack/Teams vastly out-mature us on real-time/search/retention.
Korean context: our audit-in-app-chat (no E2EE, auditable — per project decision)
matches KR 감사 expectations better than Slack's E2EE-optional consumer stance.

**What we'd steal:**
1. Slack **typed event/message object model + retention-as-config** → register messenger thread as an ont type with lifecycle + as-of → **M**.
2. Message↔object link as a **first-class typed link** (not just unfurl) → we're 80% there via objDrag; make it an `ont_link` edge → **S**.

---

## 12. appr (전자결재 / approval)
| Vendor | Typed | Linked | Versioned | Eff-dated | Note |
|---|---|---|---|---|---|
| Korean 전자결재 (더존/Naver Works/Hanbiro/Flow) | ✅ **문서양식(typed forms) + 결재선(fixed/dynamic approval line)** | ✅ form↔결재선↔drafter | ◐ document history | ✗ | admin sets whether drafter picks 결재선 or fixed; typed forms + line mgmt [V] |
| SAP Workflow | ✅ | ✅ | ◐ | ✗ | [I] |
| **Ours** | ◐ FE mirror `approval` AP-; backed by `gov_approval_requests` (mig `0158_create_gov_approval_requests`) | ✅ →governed object | ✅ **governance config-driven FSM + gov_lifecycle_transitions, audited, approver≠requester CHECK** | ◐ | coverage-matrix approval row; bespoke ApprovalCompose |

**Mixed vs Korean incumbents — the local-fit test.** Korean 전자결재 ships **mature
typed 문서양식 + 결재선 (fixed vs drafter-selected, delegation, 전결/대결)** that our
approval doesn't fully model yet: we have **AP- with four-eyes SoD (approver≠requester
CHECK) + config-driven lifecycle + audit**, which is *structurally* sound and more
governed (hash-fixity, Cedar), but **결재선 semantics (multi-step ordered line, 전결
rules, 대결/위임, 병렬/순차 approval) are a Korean-culture requirement the incumbents
model natively and we only partially do**. This is a genuine local mismatch to close.
**Stronger:** our approval is a **governed ontology object** with as-of + fixity + Cedar
— 더존/Flow store approvals in RDBMS rows without tamper-evidence.

**What we'd steal (high local priority):**
1. **Typed 결재선 model — ordered multi-step line, 전결/대결/위임, 병렬 vs 순차** (더존/Naver Works) → model 결재선 as a typed ordered link-set on the approval object → **L** (KR must-have).
2. **문서양식 typed forms** (approval templates) → ont_object_type per form (ledger already has "console-change AP- template UI") → **M**.
3. 부재중 위임(delegation) as effective-dated authority grant → our Cedar + valid_from/to → **M**.

---

## 13. field (field service)
| Vendor | Typed | Linked | Versioned | Eff-dated | Note |
|---|---|---|---|---|---|
| ServiceNow FSM | ✅ work-order/task tables + CMDB CI links | ✅ reference fields to CI/asset | ◐ | ✗ | WO references asset via reference field to cmdb_ci [V] |
| Salesforce Field Service | ✅ WorkOrder/ServiceAppointment/Asset objects | ✅ lookups | ◐ field history | ✗ | [I] |
| SAP FSM | ✅ | ✅ | ◐ | ◐ | [I] |
| **Ours** | ✗ WO- **plain table, no type reg**, but **16-state bespoke FSM** (richest kinetic in the tree) | ◐ finance/equipment link-chips | ✅ FSM audited + RLS | ✗ | coverage-matrix WO- row; legacy WorkOrderDetailPage, no ObjectCard yet |

**Stronger kinetic, weaker semantic + linkage.** Our WO- has the **richest lifecycle
FSM in the codebase (16 states, audited, RLS-tested)** — deeper than ServiceNow's
typical status model. **Weaker:** WO- **isn't engine-registered** (no typed property
schema, no as-of, still legacy page not ObjectCard), and ServiceNow/Salesforce model
**WO↔Asset↔CI as first-class typed reference links** where ours are display link-chips.
Registering WO/equipment as projected types (coverage-matrix "semantic backfill") closes
most of this cheaply — the FSM + audit already exist. Korean context: 현장 coverage/대근/
교대 as typed objects (default catalog) is ahead of global FSM vendors for KR labor rules.

**What we'd steal:**
1. **WO↔Asset↔CI first-class typed reference links** (ServiceNow reference fields) → register WO/equipment as projected ont types + real ont_link_types → **M** (high value, cheap: FSM exists).
2. Salesforce ServiceAppointment as a distinct typed object (schedule≠work) → new instance type → **M**.
3. Open WO in the 3-layer ObjectCard instead of the legacy page → **S**.

---

## 14. compliance
| Vendor | Typed | Linked | Versioned | Eff-dated | Note |
|---|---|---|---|---|---|
| ServiceNow GRC / SAP GRC / OneTrust | ✅ control/risk/obligation record classes | ✅ control↔risk↔policy links | ◐ | ◐ assessment periods | typed GRC objects + control-test workflows [I] |
| **Ours** | ✗ `compliance_obligations`/`_regulations`/`_frameworks` **plain tables, not type-reg** but **each has a bespoke status-transition FSM, audited** | ◐ | ◐ **regulation validity window valid_from/valid_to (but no as-of read fn)** | ◐ | coverage-matrix CP-/RG-/FW- rows; **no web UI (0 refs)** |

**Weaker in surfacing, competitive in model.** We already have **typed status FSMs for
obligation/regulation/framework + a regulation validity window (valid_from/valid_to)** —
the *bones* of an effective-dated regulatory model — but **no as-of read fn and no web
UI at all** (coverage-matrix: 0 refs), and none are engine-registered. GRC vendors ship
**mature control↔risk↔obligation link graphs + assessment/attestation cycles + evidence
attachment**. **Where our design wins once surfaced:** regulation as an **effective-dated
ont type with as-of** would let us reconstruct "which reg text applied on date T" —
stronger than typical GRC point-in-time snapshots — and our evidence module already gives
tamper-evident attestation to bolt on. Korean context: RG-/규제 PII/multi-jurisdiction +
PIPA consent objects (default catalog) target KR/multi-jurisdiction regs global GRC
localizes weakly.

**What we'd steal:**
1. **Control↔Risk↔Obligation typed link graph + attestation cycle** (ServiceNow/SAP GRC) → register the 3 existing compliance tables as projected ont types + link them + build the missing UI → **M** (model half exists).
2. Effective-dated regulation as-of read (finish the fn on the existing validity window) → our engine's as-of → **S** (cheap, distinctive).
3. Assessment/evidence-request cycle wired to our EV- evidence objects → **M**.

---

## Cross-module synthesis
- **Our architecture out-models the field on 4 axes** (fixity/tamper-evidence, native
  governance-per-write, object-level as-of/bitemporal, config-as-governed-object), but
  is **under-populated** — the recurring weakness is "engine built, ~2-4 types registered,
  everything else a plain table." The steal-list is dominated by **populating** what the
  engine already supports, not new architecture.
- **Two genuine architectural gaps vs leaders:** (1) **Foundry ontology branching /
  proposal-as-PR** for schema changes; (2) **Temporal-style event-sourced durable
  execution/replay** for automate.
- **Two Korean local-fit must-haves** the global vendors won't give us: **전자결재 결재선
  semantics** (appr) and **finance 전표/분개 with KR tax typed props** (SAP does GL but
  localizes 세금계산서 heavily) — both are typed-object modeling tasks on our engine.
