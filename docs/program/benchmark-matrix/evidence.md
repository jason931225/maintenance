# Benchmark Matrix — Module: Evidence (records/evidence — WORM custody, retention, fixity, legal holds)

**Scope:** immutable custody of records/evidence: SHA-256 fixity, WORM copies, chain-of-custody, RFC-3161 timestamps, retention/disposition, legal/litigation holds, admissibility, eDiscovery export.

**Our column is code-evidenced** from `/Users/jasonlee/Developer/maintenance`: FE `web/src/console/evidence/*` (EvidenceRecords, EvidenceCard, evidenceModel, types), BE `backend/crates/docs/rest` (mnt-docs-rest), domain contract `.omc/handoffs/t_15b1a1ec-ev-object-domain-api-contract.md`, ledger `docs/program/console-program-ledger.md`.

**Honesty flag (our column):** the EV backend is REAL and green (BE2 evidence: list/detail/verify/hold; ledger line "2026-07-10 — BE2 evidence DONE … all green as mnt_rt"), but the **FE still renders a stub feed** (`evidenceStubs.ts`; `EvidenceRecords` default `records ?? createEvidenceStubs()`, `wire-pending: Phase C → GET /api/v1/evidence-objects`). So UI-surfaced capabilities below are "modeled + backend-real, FE-wire-pending" unless the store call is already live (only `POST verify` fixity + `/audit` custody are real-wired). This is the exact fabrication class §4-25 already caught here, so it is labeled, not hidden.

Rigor labels: **[V]** verified w/ source URL · **[I]** inferred from known product patterns.

---

## Vendor relevance (this module)

| Vendor | Plays here? | One-line |
|---|---|---|
| **SAP** (S/4HANA + ILM) | **Core** | Purpose-built records/ILM: retention rules, WORM-store handoff, legal hold, e-discovery, auto-destruction. |
| **Palantir Foundry** | **Core (provenance)** | Immutable transactional datasets + data lineage + lineage-aware retention (Data Lifetime); strong on custody/provenance, thin on legal-hold/admissibility framing. |
| **Microsoft Teams / M365 Purview** | **Core (holds)** | Teams content governed by Purview: retention labels, regulatory-record immutability, litigation/eDiscovery holds. |
| **Slack** (Enterprise Grid) | Adjacent | Retention policies + legal holds + Discovery API export; a comms archive, not a records store. |
| **Rippling** | Narrow | HR-document retention (I-9/W-4 permanence) inside an HRIS; no general WORM/fixity/legal-hold engine. |
| **n8n** | N/A (automation only) | No custody store; relevant only as an automation hook — execution-data pruning is the opposite of WORM. |
| **Asana** | N/A (work mgmt) | Immutable *audit log* only; explicitly **no** custom retention or legal hold. |

---

## Capability matrix (rows = dimensions, cells = how each does it)

### 1. Information architecture (what "a record" is)
| Ours | SAP | Palantir | Teams/Purview | Slack | Rippling | n8n | Asana |
|---|---|---|---|---|---|---|---|
| EV- object: classification, admissibility, custodian, custody-stage, copies[] (ORIGINAL/DERIVATIVE w/ parent lineage), holds[], custody audit-stream. Typed in the 3-layer ontology, opens as ObjectCard. **[code:** `types.ts` `EvidenceObjectDetail`] | Business objects → ILM "records" via retention rules on archived data + Retention Warehouse for decommissioned systems. **[V]** ([ArchiveHub](https://archivehub.io/sap-information-lifecycle-management-features-and-benefits/)) | Dataset = files under append-only transactions; "record" is a row/transaction, not a legal artifact. **[V]** ([Datasets](https://www.palantir.com/docs/foundry/data-integration/datasets)) | Any M365 item (email/file/Teams msg) taggable as record/regulatory-record via retention label. **[V]** ([Records mgmt](https://learn.microsoft.com/en-us/purview/records-management)) | Message/file/channel objects; no first-class "record" type — the export is the artifact. **[V]** ([Discovery API](https://slack.com/help/articles/360002079527)) | HR documents (I-9/W-4/signed docs) in a Documents Engine. **[V]** ([HR doc mgmt](https://www.rippling.com/hr-document-management)) | Execution + binary data rows; no record concept. **[V]** ([exec data](https://docs.n8n.io/hosting/scaling/execution-data/)) | Audit-log events only; tasks are not records. **[V]** ([audit events](https://developers.asana.com/docs/audit-log-events)) |

### 2. Immutability / WORM custody
| Ours | SAP | Palantir | Teams/Purview | Slack | Rippling | n8n | Asana |
|---|---|---|---|---|---|---|---|
| Originals never mutate; per-copy `WormStatus` PENDING/VERIFIED/FAILED; storage crate owns S3/WORM replica. Bucket object-lock/retention = infra runbook **pending**. **[code+ledger]** | ILM writes archive files w/ retention time to "WORM-like storage" device; destruction only after expiry. **[V]** ([help.sap ILM](https://help.sap.com/doc/64463e3149134842aba27208f6c59ce8/7.0/en-US/SAP_NetWeaver_ILM_vs_DARTE.PDF)) | Transactions are immutable & append-only (OPEN→COMMITTED); prior views retained until retention deletes them. **[V]** ([Datasets](https://www.palantir.com/docs/foundry/data-integration/datasets)) | Regulatory-record label → content immutable (can't edit/delete); backed by Preservation Hold Library; Azure immutable-blob WORM under the hood. **[V]** ([Records mgmt](https://learn.microsoft.com/en-us/purview/records-management)) / **[I]** (blob WORM) | Legal hold preserves msgs/files even if user-deleted or retention-expired. **[V]** ([legal holds](https://slack.com/help/articles/4401830811795)) | Signed docs "remain permanently"; no WORM/object-lock guarantee exposed. **[V]/[I]** ([document-engine](https://www.rippling.com/blog/document-engine)) | Opposite — prunes/deletes execution+binary data on schedule. **[V]** ([manage exec data](https://docs.n8n.io/deploy/host-n8n/configure-n8n/scaling/manage-execution-data)) | Audit log immutable; task data mutable/deletable. **[V]** ([audit API](https://developers.asana.com/reference/audit-log-api)) |

### 3. Fixity / integrity verification
| Ours | SAP | Palantir | Teams/Purview | Slack | Rippling | n8n | Asana |
|---|---|---|---|---|---|---|---|
| SHA-256 per copy; `POST verify` = **REAL** re-hash (HEAD each WORM copy, normalize, audited), reuses L20 canonicalizer; `FixityStatus` VERIFIED/PENDING/MISMATCH; tamper→detected proof. **[code+ledger]** — strongest differentiator | ILM relies on WORM device + retention integrity; no per-object user-facing hash re-verify surfaced. **[I]** | Files content-addressed; rollback uses provenance to reconstruct exact prior state (implicit fixity), no exposed "verify hash" button. **[V]** ([rollback](https://www.palantir.com/docs/foundry/data-lineage/pipeline-rollback)) | No per-item fixity hash surfaced; integrity = platform assurance + immutable label. **[I]** | No fixity hash; integrity = "Slack stored it" attestation. **[I]** | N/A — no fixity primitive. **[I]** | N/A. **[I]** | N/A. **[I]** |

### 4. Chain of custody / provenance / lineage
| Ours | SAP | Palantir | Teams/Purview | Slack | Rippling | n8n | Asana |
|---|---|---|---|---|---|---|---|
| 12-stage custody ledger (REGISTERED→…→DISPOSED incl. ACCESSED/EXPORTED); timeline in audit-stream shape; derivative→parent lineage. **[code:** `evidenceModel.ts` `AUDIT_CUSTODY_STAGE`] | Retention Warehouse holds provenance of decommissioned data; audit of destruction. **[V]** ([auritas](https://www.auritas.com/blogs/a-roadmap-to-sap-ilm-retention-management/)) | **Best-in-class**: interactive Data Lineage graph, transaction-level provenance, lineage-aware downstream tracing. **[V]** ([Data Lineage](https://www.palantir.com/docs/foundry/data-lineage/overview)) | Custodian mgmt + hold-communication trail in eDiscovery Premium; content-level custody via Preservation Hold Library. **[V]** ([hold mgmt](https://learn.microsoft.com/en-us/purview/edisc-hold-manage)) | Discovery API captures edits/deletions/metadata history = a custody trail for messages. **[V]** ([Discovery API](https://slack.com/help/articles/360002079527)) | Version/e-sign tracking on docs (who signed latest). **[V]** ([HR doc mgmt](https://www.rippling.com/hr-document-management)) | Execution history = flow provenance, but ephemeral (pruned). **[V]** ([exec data](https://docs.n8n.io/hosting/scaling/execution-data/)) | Immutable audit log of security/compliance events. **[V]** ([audit events](https://developers.asana.com/docs/audit-log-events)) |

### 5. Retention scheduling & automated disposition
| Ours | SAP | Palantir | Teams/Purview | Slack | Rippling | n8n | Asana |
|---|---|---|---|---|---|---|---|
| **Gap**: disposal is manual (DISPOSAL_REQUESTED→DISPOSED, hold-gated); **no** automated retention schedule / auto-destruction yet. **[code:** no timer in `types.ts` CustodyStage] | **Best-in-class**: policy-driven retention periods, automated destruction on expiry accounting for holds. **[V]** ([ILM features](https://archivehub.io/sap-information-lifecycle-management-features-and-benefits/)) | Data Lifetime = lineage-aware retention policies deleting transactions + downstream by age. **[V]** ([Data Lifetime](https://www.palantir.com/docs/foundry/data-lifetime/overview)) | Retention labels/policies retain-then-delete or delete-only; disposition review before deletion. **[V]** ([retention](https://learn.microsoft.com/en-us/purview/retention)) | Org-level retention policies override workspace; auto-delete msgs/files. **[V]** ([Discovery guide](https://slack.com/help/articles/360002079527)) | Legal minimums (I-9 3yr/1yr) as guidance; permanence default, no auto-purge engine surfaced. **[V]/[I]** ([payroll records](https://www.rippling.com/blog/payroll-records)) | Age/count pruning (default 336h / 10k); annotated runs never pruned. **[V]** ([manage exec data](https://docs.n8n.io/deploy/host-n8n/configure-n8n/scaling/manage-execution-data)) | **None** — explicitly no custom retention policy. **[V]** ([Asana data-retention](https://help.asana.com/s/article/data-retention-policy) + Asana community thread confirming no custom retention) |

### 6. Legal / litigation hold
| Ours | SAP | Palantir | Teams/Purview | Slack | Rippling | n8n | Asana |
|---|---|---|---|---|---|---|---|
| `EvidenceLegalHold` ACTIVE/RELEASED gates disposal **fail-closed**; `POST hold` apply/release = **four-eyes distinct-approver**. **[code+ledger]** | ILM Legal Hold Mgmt places holds blocking deletion/alteration until lifted. **[V]** ([ILM Legal Hold](https://blogs.sap.com/2021/09/02/ilm-legal-hold-management-part-1)) | No native "legal hold" object; achieved by disabling retention / preserving transactions. **[I]** | Litigation hold + eDiscovery holds preserve in place across locations; any one preservation source suffices. **[V]** ([retention](https://learn.microsoft.com/en-us/purview/retention)) | Legal Holds Admin role preserves all convos/DMs for a person regardless of retention. **[V]** ([legal holds](https://slack.com/help/articles/4401830811795)) | N/A — no legal-hold construct. **[I]** | N/A. **[I]** | **None** — explicitly no legal hold. **[V]** ([Asana data-retention](https://help.asana.com/s/article/data-retention-policy) + Asana community thread) |

### 7. eDiscovery — search & export
| Ours | SAP | Palantir | Teams/Purview | Slack | Rippling | n8n | Asana |
|---|---|---|---|---|---|---|---|
| Export as custody stage + `EXPORT_MANIFEST` derivative; search = client-side stat-bar filters (admissibility/hold) only — **no full-text discovery search**. **[code:** `EvidenceRecords` filters] | ILM e-discovery search/retrieve within SAP systems for legal purposes. **[V]** ([ArchiveHub](https://archivehub.io/sap-information-lifecycle-management-features-and-benefits/)) | Search datasets; export via pipelines; no legal-review-set construct. **[I]** | eDiscovery Std (search+export) / Premium (review sets, analytics, custodian mgmt). **[V]** ([service desc](https://learn.microsoft.com/en-us/office365/servicedescriptions/microsoft-365-service-descriptions/microsoft-365-tenantlevel-services-licensing-guidance/microsoft-purview-service-description)) | Discovery API → JSON export of all history incl. edits/deletes to 3rd-party eDiscovery. **[V]** ([Discovery API](https://slack.com/help/articles/360002079527)) | Reporting/export of HR docs, not litigation-grade eDiscovery. **[I]** | No discovery search. **[I]** | Audit-log export via API (90-day window). **[V]** ([audit events](https://developers.asana.com/docs/audit-log-events)) |

### 8. Admissibility / trust signals (TSA, signatures)
| Ours | SAP | Palantir | Teams/Purview | Slack | Rippling | n8n | Asana |
|---|---|---|---|---|---|---|---|
| Admissibility chip (ADMISSIBLE/REVIEW_NEEDED/BLOCKED/INADMISSIBLE) + `TsaStatus` (RFC-3161 anchoring **wire-pending**, nullable today). **[code+contract]** — unique "is this court-ready?" lens | No explicit admissibility scoring; compliance = retention-rule adherence. **[I]** | No admissibility construct (data-eng platform). **[I]** | Immutable regulatory-record + audit ≈ defensibility, but no "admissibility" UI. **[I]** | Preservation attestation used in litigation but no admissibility scoring. **[I]** | E-signature validity on docs. **[V]** ([HR doc mgmt](https://www.rippling.com/hr-document-management)) | N/A. **[I]** | N/A. **[I]** |

### 9. Permissions (deny-by-default / PBAC)
| Ours | SAP | Palantir | Teams/Purview | Slack | Rippling | n8n | Asana |
|---|---|---|---|---|---|---|---|
| Cedar/PBAC actions `evidence.read/custody.manage/hold.manage/dispose`, **deny-by-omission** (`PolicyGated`), FORCE-RLS org isolation. **[code+memory]** | SAP auth objects + ILM role separation. **[I]** | Row/column/transaction-level security; branch permissions. **[V]** ([Data Lineage FAQ](https://www.palantir.com/docs/foundry/data-lineage/faq)) | RBAC via Purview role groups (Records Mgmt, eDiscovery Mgr). **[V]** ([service desc](https://learn.microsoft.com/en-us/office365/servicedescriptions/microsoft-365-service-descriptions/microsoft-365-tenantlevel-services-licensing-guidance/microsoft-purview-service-description)) | Legal Holds Admin / Org Owner roles; Discovery gated to compliance use only. **[V]** ([Discovery API](https://slack.com/help/articles/360002079527)) | Rippling RBAC/IAM. **[V]** ([IAM review](https://www.rippling.com/blog/rippling-identity-and-access-management-review)) | Instance RBAC (self-host). **[I]** | Audit API gated to Enterprise+/Compliance add-on. **[V]** ([audit API](https://developers.asana.com/reference/audit-log-api)) |

### 10. Tamper-evident audit trail
| Ours | SAP | Palantir | Teams/Purview | Slack | Rippling | n8n | Asana |
|---|---|---|---|---|---|---|---|
| L20 hash-chain audit (seal worker + verify), every mutation `with_audit`; custody events are audit actions. **[memory: audit-chain-status]** — cryptographic chain, not just an append log | ILM logs destruction/holds for audit. **[V]** ([auritas](https://www.auritas.com/blogs/a-roadmap-to-sap-ilm-retention-management/)) | Transaction log + lineage is inherently audit-grade. **[V]** ([Data Lineage](https://www.palantir.com/docs/foundry/data-lineage/overview)) | Purview audit (unified audit log). **[V]** ([compliance](https://learn.microsoft.com/en-us/purview/purview-compliance)) | Audit logs API on Enterprise Grid. **[I]** | Audit logs. **[I]** | N/A (self-host DB). **[I]** | **Immutable** audit log — its core strength. **[V]** ([audit API](https://developers.asana.com/reference/audit-log-api)) |

### 11. Automation hooks (events/workflows)
| Ours | SAP | Palantir | Teams/Purview | Slack | Rippling | n8n | Asana |
|---|---|---|---|---|---|---|---|
| Custody transitions = audit actions; ontology dynamic layer (acting policies/automations) is the substrate — evidence auto-actions **not yet wired**. **[ledger]** | ILM rules run as scheduled jobs (archive/destroy). **[V]** ([auritas](https://www.auritas.com/blogs/a-roadmap-to-sap-ilm-retention-management/)) | Pipelines/schedules on transactions; retention runs automatically. **[V]** ([Data Lifetime](https://www.palantir.com/docs/foundry/data-lifetime/overview)) | Auto-apply labels by keyword/sensitive-type; disposition review workflow. **[V]** ([records mgmt](https://learn.microsoft.com/en-us/purview/records-management)) | Discovery API + webhooks for archiving pipelines. **[I]** | Workflow triggers on HR events. **[I]** | **Best-in-class automation** but on the workflow, not custody — could orchestrate evidence intake. **[V]** ([manage data](https://docs.n8n.io/deploy/use-n8n-cloud/configure-cloud/manage-your-data)) | Rules/triggers on tasks, not records. **[I]** |

### 12. Mobile / field capture
| Ours | SAP | Palantir | Teams/Purview | Slack | Rippling | n8n | Asana |
|---|---|---|---|---|---|---|---|
| Android field app captures work-order `evidence_media` (presign/confirm, `checksum_sha256`); EV copies wrap `sourceEvidenceMediaId`. **[code:** `migrations/0009`, `types.ts`] — real field→custody path | SAP Fiori mobile capture into archiving. **[I]** | Foundry mobile is analytics-consumption, not field evidence capture. **[I]** | Teams mobile is the capture surface; Purview governs after. **[V]** ([records mgmt](https://learn.microsoft.com/en-us/purview/records-management)) | Slack mobile capture; governed after. **[I]** | Rippling mobile doc upload during onboarding. **[V]** ([remote onboarding](https://www.rippling.com/blog/how-to-onboard-and-manage-remote-employees-with-rippling)) | N/A. **[I]** | Asana mobile (tasks). **[I]** |

### 13. Extensibility (typed objects / ontology)
| Ours | SAP | Palantir | Teams/Purview | Slack | Rippling | n8n | Asana |
|---|---|---|---|---|---|---|---|
| EV- is a first-class typed object in the 3-layer ontology (semantic/kinetic/dynamic); custody = FSM transitions; opens as generic ObjectCard. **[ledger §18]** — evidence rides the same engine as every object | ILM extends via custom archiving objects/rules. **[I]** | **Best-in-class ontology** (Objects/Actions over datasets) — but evidence isn't a shipped ontology type. **[V]** ([datasets](https://www.palantir.com/docs/foundry/data-integration/datasets)) | Extensible via content types + label taxonomy + Graph/Export APIs. **[V]** ([Teams Export API](https://learn.microsoft.com/en-us/purview/edisc-hold-manage)) | Extend via Discovery/Web APIs + apps. **[V]** ([Discovery API](https://slack.com/help/articles/360002079527)) | Custom fields/workflows on documents. **[I]** | **Node-based extensibility** is its whole product. **[V]** ([exec data](https://docs.n8n.io/hosting/scaling/execution-data/)) | Custom fields + API. **[I]** |

### 14. Korean B2B fit (전자결재 / 근로기준법 retention / group-company scoping)
| Ours | SAP | Palantir | Teams/Purview | Slack | Rippling | n8n | Asana |
|---|---|---|---|---|---|---|---|
| Native 증거 module; four-eyes distinct-approver ≈ 전자결재 sign-off on hold/dispose; Group→법인→branch→site RLS scoping. 근로기준법 retention schedules **not yet automated** (see row 5 gap). **[code+memory: conglomerate-platform-pivot]** | Global localization incl. Korea; retention rules can encode 근로기준법 periods but heavy config + no 전자결재-native chain. **[I]** | No Korean records-law templates; would be custom-built. **[I]** | Purview retention can encode KR periods; 전자결재 culture not modeled (approval ≠ eDiscovery hold). **[I]** | US-centric compliance; KR data-residency/retention needs 3rd-party. **[I]** | US HR/payroll focus; weak KR 근로기준법/전자결재 fit. **[I]** | Self-host = data residency control, but zero KR records semantics. **[I]** | No KR records/retention semantics. **[I]** |

---

## Per-vendor "how they'd build OUR evidence module"

**SAP** — Would model evidence as archived business objects under an ILM policy: every EV row gets a retention rule (근로기준법/tax period), a WORM-store destination, and an automated destruction job that consults active legal holds first. Strength they'd bring: the retention→disposition→hold lifecycle we're missing (our row-5 gap). Weakness: config-heavy, IMG-transaction UX, no cryptographic per-object fixity re-verify or admissibility lens.

**Palantir** — Evidence = an immutable dataset/ontology object; each capture is an append-only transaction, custody = the lineage graph, retention = Data Lifetime lineage-aware policies, disposal = DELETE transactions. Strength: provenance and lineage (row 4) far past ours, plus retention automation. Weakness: no legal-hold object, no admissibility/TSA framing, no field-evidence capture — they'd bolt custody-of-record concepts onto a data-engineering substrate.

**Microsoft (Teams/Purview)** — Evidence lives wherever it's created (Teams/SharePoint/Exchange); a regulatory-record label makes it immutable, retention labels drive disposition-with-review, and eDiscovery holds preserve in place with custodian mgmt + review sets. Strength: holds + disposition review + eDiscovery depth (rows 5–7). Weakness: no per-item SHA-256 fixity UI, no admissibility scoring, no single "evidence object" — it's federated across M365, hard to give a field tech one custody card.

**Slack** — Evidence = the message/file stream; legal holds preserve per-person, retention auto-deletes, Discovery API exports everything (incl. deletes) to a 3rd-party eDiscovery tool. Strength: capture-time custody of comms + deletion-proof export. Weakness: it's a comms archive, not a records store — no fixity, no WORM object-lock, no admissibility, custody-of-file only via export.

**Rippling** — Evidence = HR documents in the Documents Engine: prebuilt gov forms, e-sign, permanence, version tracking, mobile upload. Strength: opinionated per-doc-type retention (I-9 3yr/1yr) + e-sign validity. Weakness: HR-only, no general WORM/fixity/legal-hold engine, no admissibility, no chain-of-custody beyond version history.

**n8n** — Wouldn't build the store; would build the *pipeline into* it: a workflow that ingests captured media, hashes it, pushes to a WORM bucket, writes the custody event, and fires the TSA request. Strength: the intake/automation glue (row 11). Weakness: its own data model prunes/deletes by design (row 2/5) — the antithesis of custody; unfit as the system of record.

**Asana** — Wouldn't build it; out of category. The one transferable idea is its **immutable audit log** as the tamper-evident spine — but Asana explicitly ships no retention policy and no legal hold, so it can't hold evidence.

---

## What we'd steal (ranked, capability → best vendor → fit with our ontology-first grammar → cost)

1. **Automated retention schedules + disposition-with-review** → **SAP ILM** (Palantir Data Lifetime as the cleaner model) → fits directly: add a `retentionPolicyId` + `disposeAfter` to the EV object and a scheduled action that respects the fail-closed hold gate; disposition-review = a REVIEW_NEEDED→approve transition through existing four-eyes. **Closes our row-5 gap — highest-value.** Cost **M**.
2. **Lineage-aware retention & richer provenance graph** → **Palantir** → our derivative→parent lineage + custody ledger is the seed; render custody + copy-lineage as a graph and let retention cascade to derivatives. Cost **M**.
3. **eDiscovery review-set + full-text search/export** → **Purview Premium / Slack Discovery API** → today we only stat-bar-filter; add server-side search over EV objects + a signed `EXPORT_MANIFEST` bundle (we already have the manifest derivative kind). Cost **M–L**.
4. **Disposition-review + custodian-communication trail** → **Purview** → a hold/dispose approval already emits audit; add a custodian-notification record to the custody stream. Cost **S**.
5. **Retention templates keyed to law (근로기준법/tax)** → **SAP** → ship KR retention presets as ontology config, not code (our ledger already prefers governed-config-as-ontology-instance). Cost **S–M**.
6. **Intake automation (hash→WORM→custody→TSA)** → **n8n pattern** → wire the existing dynamic-layer automations to fire on capture so field media auto-becomes an EV object. Cost **S** (substrate exists).

**Where we already lead:** cryptographic per-object fixity re-verify (row 3), tamper-evident hash-chain audit (row 10), a single admissibility-scored evidence card (row 8), fail-closed four-eyes legal hold (row 6), and one typed EV object on the same ontology as everything else (row 13) — no single vendor combines all five. **Our biggest real gap is automated retention/disposition (row 5) and the fact the FE still reads stubs (must finish Phase C wiring).**

---
### Sources
SAP ILM: [ArchiveHub](https://archivehub.io/sap-information-lifecycle-management-features-and-benefits/) · [Legal Hold Pt1](https://blogs.sap.com/2021/09/02/ilm-legal-hold-management-part-1) · [Auritas retention](https://www.auritas.com/blogs/a-roadmap-to-sap-ilm-retention-management/) · [help.sap ILM vs DART](https://help.sap.com/doc/64463e3149134842aba27208f6c59ce8/7.0/en-US/SAP_NetWeaver_ILM_vs_DARTE.PDF)
Palantir: [Data Lineage](https://www.palantir.com/docs/foundry/data-lineage/overview) · [Data Lifetime](https://www.palantir.com/docs/foundry/data-lifetime/overview) · [Datasets](https://www.palantir.com/docs/foundry/data-integration/datasets) · [Pipeline rollback](https://www.palantir.com/docs/foundry/data-lineage/pipeline-rollback)
Purview/Teams: [Records mgmt](https://learn.microsoft.com/en-us/purview/records-management) · [Retention](https://learn.microsoft.com/en-us/purview/retention) · [Hold mgmt](https://learn.microsoft.com/en-us/purview/edisc-hold-manage) · [Service description](https://learn.microsoft.com/en-us/office365/servicedescriptions/microsoft-365-service-descriptions/microsoft-365-tenantlevel-services-licensing-guidance/microsoft-purview-service-description) · [Compliance](https://learn.microsoft.com/en-us/purview/purview-compliance)
Slack: [Discovery API guide](https://slack.com/help/articles/360002079527-A-guide-to-Slacks-Discovery-APIs) · [Legal holds](https://slack.com/help/articles/4401830811795-Create-and-manage-legal-holds)
Asana: [Audit log API](https://developers.asana.com/reference/audit-log-api) · [Audit events](https://developers.asana.com/docs/audit-log-events) · [Data-retention policy](https://help.asana.com/s/article/data-retention-policy)
n8n: [Manage execution data](https://docs.n8n.io/deploy/host-n8n/configure-n8n/scaling/manage-execution-data) · [Execution data](https://docs.n8n.io/hosting/scaling/execution-data/)
Rippling: [HR doc mgmt](https://www.rippling.com/hr-document-management) · [Document Engine](https://www.rippling.com/blog/document-engine) · [Remote onboarding](https://www.rippling.com/blog/how-to-onboard-and-manage-remote-employees-with-rippling)

---

## Cross-cutting lens findings (5 independent review lenses)

- **Task-flow:** money task = *produce audit evidence* — verify fixity is **1 click** (real store re-HEAD each WORM copy, audited); assembling an audit package is **N clicks (one per record)**. ServiceNow GRC makes audit-time steps ≈ **0** (evidence pre-collected continuously). **Steal:** scheduled/continuous auto-verify + auto-attestation so an audit package assembles itself — extend the L20 seal worker to scheduled re-verify + package rollup. Cost **M**.
- **IA / layout:** Card + records list; **edge** — our audit chain is cryptographically sealed (stronger integrity than any vendor evidence store). **GAP:** no single-pane **audit-timeline workspace** tying request→control→evidence→observation. **Steal:** single-pane audit-timeline workspace → ServiceNow GRC [M]; evidence-request task loop (recurring auto-request) [M]; surface the seal/verify verdict inline as an evidence-card badge (our unique edge) [S].
- **Data-model:** **12-stage custody FSM + real fixity re-verify + legal-hold four-eyes** — richer object semantics than a SnapLock volume (storage-layer immutability + thin metadata). **Weaker vs Veritas/OpenText:** they ship effective-dated retention schedules + record-class taxonomies + disposition workflows; ours has holds but no retention-schedule object, and TSA anchoring is nullable. **Steal:** effective-dated retention-schedule + disposition object [M]; 17a-4-style immutable-fingerprint attestation (add RFC-3161 TSA) [M]; record-class taxonomy as ont types [S].
- **Governance:** **Ahead on integrity/fixity/holds; Behind on retention-schedule + disposition-review.** We hold indefinitely / WORM; we lack Purview's scheduled retention → disposition-review (four-eyes) → governed dispose. **Steal:** retention-schedule + disposition-review → Purview records-management [M]; finish RFC-3161 TSA anchoring [M]; regulatory-record lock tier (admins can't release) [S].
- **Automation / extensibility:** we have the evidence substrate (better than Vanta on integrity: SHA-256 + WORM + FRE 902(14)); we lack the continuous-test scheduler + integration-sourced collection. **Steal:** continuous control-test scheduler (schedule trigger + a "test" Action → timestamped EV-) [M]; cross-framework control mapping (one EV- satisfies many RG- via many-many links) [M]; evidence-from-integration collectors (internal first) [M–L].

**Adjudication (12-stage, code-confirmed):** the FE `CustodyStage` enum (`web/src/console/evidence/types.ts`) has **exactly 12** members (REGISTERED → … → DISPOSED). evidence.md's "12-stage" is correct; the data-model lens's earlier "13-stage" was the outlier and has been corrected to 12. Also: the Asana "no retention / no legal hold" claim is re-cited to Asana's own docs (was a third-party Cirface page).
