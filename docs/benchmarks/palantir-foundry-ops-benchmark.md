# Palantir Foundry operations benchmark — applicable product bar

Status: planning/quality gate for the enterprise-operations platform. This is a
benchmarking note, not a claim that we implement or copy Palantir Foundry. We use
public Palantir documentation and read-only Oyatie planning artifacts to sharpen
our own product, observability, governance, and policy requirements.

## Public benchmark sources

- Palantir Foundry Ontology: model the business as object types, properties,
  link types, action types, and functions; the Ontology is the semantic layer over
  operational data. Source: <https://palantir.com/docs/foundry/ontology/overview/>
  and <https://palantir.com/docs/foundry/ontology/core-concepts/>.
- Object types and object sets: use real-world entities/events and filtered sets
  as first-class UX/API primitives, not just database tables. Source:
  <https://palantir.com/docs/foundry/object-link-types/object-types-overview/>.
- Action types: define governed business changes, including submitted edits and
  side effects. Source: <https://palantir.com/docs/foundry/action-types/overview/>.
- Data lineage: expose how data and ontology entities relate across flows; make
  provenance inspectable rather than implicit. Source:
  <https://palantir.com/docs/foundry/data-lineage/overview/> and
  <https://palantir.com/docs/foundry/data-lineage/explore-artifacts/>.
- Security controls: authorization is attribute/permission based; markings,
  classification-based controls, projects/roles, and restricted views make access
  boundaries legible and enforceable. Sources:
  <https://palantir.com/docs/foundry/security/overview/>,
  <https://palantir.com/docs/foundry/security/markings/>,
  <https://palantir.com/docs/foundry/security/classification-based-access-controls/>,
  <https://palantir.com/docs/foundry/security/projects-and-roles/>, and
  <https://palantir.com/docs/foundry/security/restricted-views/>.

## Oyatie read-only references to lift conceptually

Do not copy Oyatie code into this repo without a separate implementation task.
The following artifacts are useful as design precedent:

- `/Users/jasonlee/Developer/oyatie/registry/knowledge-graph-kinetic.json` —
  Palantir-style kinetic layer: typed action definitions with required fields,
  audit topic, idempotency class, lock pattern, and validator invariants.
- `/Users/jasonlee/Developer/oyatie/specs/root-hub-pointers.json` entries:
  `knowledge_graph_semantic`, `knowledge_graph_kinetic`, `knowledge_graph_dynamic`,
  `prd_ontology`, `prd_workflow`, `design_entity_action_policy_preview`,
  `design_audit_evidence_timeline`, `design_workflow_replay_timeline`,
  `spec_ontology_projection_schema`, `spec_audit_event_class_registry`,
  `cloud_observability_slo_target`, and `spec_agentic_slo_gated_promotion`.
- `/Users/jasonlee/Developer/oyatie/specs/hyperscaler-architecture-invariants.json`
  invariants: `INV-IDEMPOTENCY`, `INV-MULTI-TENANCY-ISOLATION`,
  `INV-TYPE-SAFETY-BOUNDARY`, and `INV-DATA-LINEAGE`.
- `/Users/jasonlee/Developer/oyatie/templates/runbook-template.md` — every alert
  resolves to a concrete human/agent-readable runbook, with SLO impact,
  diagnostics, mitigation, rollback, verification, and postmortem trigger.
- `/Users/jasonlee/Developer/oyatie/templates/evidence-bundle-template.json` —
  evidence bundles for runbook executions, milestone gates, and capability
  invocations with tenant scope, data classes, outcome, audit reference, and
  signing metadata.

## Maintenance acceptance bar derived from the benchmark

### 1. Object-centric product model

- Every domain surface must expose typed objects and relationships: Group, Org,
  Department/Team, Employee, Role, PolicyRole, Site, Client, Asset, WorkOrder,
  Invoice, PayrollRun, Message, CalendarEvent, Poll, Approval, and AuditEvent.
- List/detail pages should be object views over object sets, with saved filters,
  related-object panels, lineage/provenance, action cards, and role-aware actions.
- Import/export must map source columns into these typed object domains with
  dry-run review, data-class warnings, and standardized output formats.

### 2. Governed action model

Every sensitive or state-changing action must have:

- typed inputs and domain validation;
- authorization preview before execution;
- passkey/step-up when equivalent to signing, approval, payroll, policy, or
  tenant administration;
- idempotency key or deterministic duplicate prevention;
- transactionally written audit row with before/after snapshots where applicable;
- bounded structured telemetry event and low-cardinality metric increment;
- rollback/reversal semantics or explicit irreversible marker.

### 3. Policy and access model

- RBAC/PBAC/ABAC are one policy studio, not separate hidden mechanisms.
- Built-in roles remain immutable seed policy; custom roles grant only fixed,
  reviewed capabilities.
- Policy preview must show effective permissions, scope, data classes, audit
  consequences, and out-of-scope denials before save/publish.
- RLS/tenant/org boundaries are hard data boundaries; policy can reduce access
  but must not widen across the hard boundary without an explicit audited
  group/cross-entity pathway.

### 4. Lineage and governance

- Data import, derived fields, payroll calculations, approval transitions, role
  changes, and object mutations must produce inspectable lineage: source file or
  upstream object, transform/mapping profile, actor, timestamp, policy version,
  and output object IDs.
- UI must make lineage legible for operators and auditors: “where did this value
  come from, who changed it, under which policy, and what downstream outputs were
  affected?”

### 5. Observability and SRE discipline

For every new production feature, document 2–4 on-call questions and wire the
signals that answer them:

- endpoint RED metrics and bounded feature metrics;
- structured logs with stable event names and request/trace correlation;
- OpenTelemetry spans across request, DB, queue/job, object-storage, and mail
  boundaries where applicable;
- no secrets, tokens, or raw PII in logs/metrics/traces;
- symptom-based alerts tied to an active runbook;
- smoke test that proves metrics/alerts/logs/traces can diagnose an induced
  failure without reading the source.

For G016 Policy Studio specifically, the on-call questions are:

1. Are policy role create/edit/publish/assignment/preview actions succeeding and
   how often are they denied by scope or escalation closure?
2. Which actor changed which policy, under which org/group scope and policy
   version, without exposing PII in logs?
3. Did a policy publish or assignment change affect authorization latency,
   cache freshness, or no-lockout guarantees?
4. Can support reconstruct a policy incident from audit row, request ID, trace
   ID, and UI-visible policy lineage?

### 6. Verification gate before claiming “Palantir-grade”

A feature is not benchmark-complete until all are true:

- unit + real-tenant/RLS integration + Playwright user-story e2e pass;
- visual/UX audit passes for primary personas and responsive states;
- audit coverage gate proves every mutation emits same-transaction audit;
- no-PII telemetry spot check passes;
- `/metrics` contains expected bounded series after exercising the feature;
- trace/log correlation is demonstrated for at least one success and one denied
  path;
- alert/runbook pair is either active or explicitly marked infra-gated in
  `docs/GO-LIVE-CHECKLIST.md` / `docs/ENTERPRISE-READINESS.md`.
