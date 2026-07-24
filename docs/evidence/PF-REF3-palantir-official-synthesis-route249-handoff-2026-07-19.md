# PF-REF3 — repaired official Palantir reference and Route249 handoff

**Task / run:** `t_50c98255` / Hermes run recorded at terminalization.  **Purpose:** repair PF-REF2’s evidence defects with live direct Palantir documentation.  **Boundary:** documentation-only reference; no product, program, lifecycle, Git, build, database, integration, deployment, or parity mutation/claim.

## Repair outcome

The controlling [ledger](PF-REF3-palantir-official-source-ledger-2026-07-19.json) has 31 direct official URLs, each reopened on 2026-07-19 with HTTP 200, a per-source UTC `retrieved_at`, `source_date_status`, canonical URL, precise section-to-claim mapping, and availability qualification.  Its dates are custody facts, not claimed document publication dates: every rendered page lacked a reliable page-level published/updated date, and any copyright/footer year is expressly not used as one.

The controlling [matrix](PF-REF3-palantir-official-capability-matrix-2026-07-19.md) places every statement in one—and only one—classification: sourced documented behavior, explicit inference, independent console requirement, or held/unsupported claim.  Its console tests name fixture, actor/tenant, initial state, action, expected observable/cardinality/terminal state, and prohibited side effect.

## PF-REF2 finding-to-repair map

| PF-REF2 finding | Repair evidence | Result claimed by PF-REF3 |
|---|---|---|
| PF2-01 unledgered Functions getting-started URL | Ledger P22, exact canonical URL and sections `Test in live preview` / `Publish your functions`; matrix M05 | Source custody repaired; P22 is now a controlling ledger source. |
| PF2-02 incomplete Builds/Pipeline Builder/transforms/Workflow Lineage/policy-versioning/observability coverage | P23 Builds; P24 Pipeline Builder; P25 transforms; P26–P27 Workflow Lineage; P09/P12/P22/P24/P26 policy/versioning; P19/P23/P28–P31 operations | Each requested surface has one or more narrow source-backed matrix rows—not a high-level substitute. |
| PF2-03 declared vs stronger-test conflation | Matrix M01–M14 four-way columns plus C01–C12 console-only tests | No inference or console acceptance condition is labeled Palantir-declared. |
| PF2-04 P09/P12 attribution/freshness precision | P09 and P12 separate correction; all P01–P31 have `retrieved_at`, canonical URL and `source_date_status` | P09 only carries Action-type legacy→Ontology-role warning; P12 only carries project-based permission migration/enrollment conditions. |

## Direct coverage reconciliation

| Requested surface | Direct official evidence | Exact documented boundary retained |
|---|---|---|
| Builds | [P23 §Jobs and JobSpecs, Job states, Build lifecycle, Live logs](https://www.palantir.com/docs/foundry/data-integration/builds) | Failed builds can retain already completed-job output; build locking is not a global rollback claim. |
| Pipeline Builder | [P24 §Features, Workflow](https://www.palantir.com/docs/foundry/pipeline-builder/overview) | Streaming availability varies by Foundry environment. |
| Transforms | [P25 §Using transforms, User-defined functions](https://www.palantir.com/docs/foundry/pipeline-builder/transforms-overview) | UDF language/recommendation details are conditional; no deterministic-output claim. |
| Workflow Lineage | [P26 §Workflow Lineage, When to use, Access control](https://www.palantir.com/docs/foundry/workflow-lineage/overview), [P27 §Support for multiple ontologies](https://www.palantir.com/docs/foundry/workflow-lineage/getting-started) | Administrator access and cross-Ontology limitations are retained. |
| Policy / versioning | [P09 §Warning, Apply Action](https://www.palantir.com/docs/foundry/action-types/permissions), [P12 §Ontology permissions](https://www.palantir.com/docs/foundry/object-permissioning/ontology-permissions), [P22 §Test/Publish](https://www.palantir.com/docs/foundry/functions/getting-started), [P24 §Features](https://www.palantir.com/docs/foundry/pipeline-builder/overview), [P26 §Workflow Lineage](https://www.palantir.com/docs/foundry/workflow-lineage/overview) | No uniform permission model, universal promotion atomicity, deterministic conflict handling, or preview-production equivalence is claimed. |
| Operational observability | [P19 §Health checks](https://www.palantir.com/docs/foundry/health-checks/overview), [P28 §Monitoring/Metrics/Debugging/Log export](https://www.palantir.com/docs/foundry/observability/overview), [P29 §Run history](https://www.palantir.com/docs/foundry/aip-observability/run-history), [P30 §Audit logs](https://www.palantir.com/docs/foundry/security/audit-logs-overview), [P31 §Log guarantees](https://www.palantir.com/docs/foundry/administration/configure-logging) | Telemetry is not audit immutability; log export is beta/enrollment gated and lacks 100% delivery guarantee. |

## Non-parity / held boundary

The following remain independent console requirements or held claims and must never be presented as Palantir declared behavior: Korea residency, Korean retention/legal hold/DSR, PostgreSQL RLS, fresh-version fences, durable idempotency, deterministic conflict resolution, exactly-once delivery/effects, cross-tenant enforcement, cross-resource or external-effect atomicity, and tamper-evident/WORM/hash-chained audit.  P30 documents audit-log content/access; P31 expressly says operational logs are not audit logs and do not have 100% reliable delivery.

## Route249 exact-inventory handoff

This is a handoff, not an implementation request. A later Route249 owner must create one immutable inventory record per module/API/job and map every M01–M14 row to zero-or-more records. `no_mapping` is a recorded gap, not parity.

```text
route249_id
owner and review authority
tenant / data classification / approved region
object-field-link or pipeline contract IDs
source-of-truth dataset/table and input/output version IDs
command/function/action/job/automation identifiers and release IDs
authorization policy ID and PostgreSQL RLS policy ID
freshness fence, idempotency-key scope and transaction/effect boundary
audit-event schema plus tamper-evidence verifier
lineage producer/input/output records and transform/config digest
schedule trigger, retry/dedupe policy, terminal-state model
health rule, owner, alert route, telemetry retention/access qualification
retention/legal-hold/DSR policy IDs and explicit nonapplicability
residency evidence and cross-region rejection receipt
test fixture, tenant, actor, expected observable/cardinality, terminal outcome
source IDs, direct URL/section, evidence hash and review status
```

Permitted transfer labels are only `documented_reference`, `console_requirement`, `held`, and `implemented_and_independently_tested`. Only the final label, backed by later implementation/runtime evidence, could support a product claim; PF-REF3 contains none.

## Fresh-review request

Request a **new, independent official-source review** of the stored attachments and their post-upload hashes. The requested terminal is therefore exactly `OFFICIAL_PARITY_REFERENCE_REPAIR_COMPLETE_PENDING_FRESH_REVIEW`; it is not approval, implementation completion, or parity.
