# Architecture decision records

This directory is the local decision authority for Maintenance. The index is reviewed against `origin/main` and must be updated atomically with every ADR status, identity, amendment, or supersession change.

## Authority rules

1. An **accepted** local ADR is authoritative within its stated scope.
2. Only another **accepted** local ADR may amend or supersede it.
3. A later number does not win automatically. Amendment or supersession must be explicit in both records.
4. `proposed`, `draft`, `design-note`, plan, prototype, and DARK material cannot supersede an accepted ADR.
5. Sibling-project records must be namespaced (for example, `oyatie ADR-0240`). They are references until a local accepted ADR adopts a specific rule.
6. Current implementation/live evidence may show that code diverged from an ADR; that is a governance gap, not silent supersession. Reconcile it through a new decision.
7. `ADR-0013` was a plan-only APNs placeholder and was never issued. Do not reuse or backfill the number.

Required ADR frontmatter:

```yaml
id: ADR-0000
status: proposed | accepted | superseded | rejected | withdrawn
doc_status: review | published | archived
date: YYYY-MM-DD
owner: name
related: []
```

`related` is always required and uses an inline list, including `related: []`. Relationship keys (`amends`, `amended_by`, `supersedes`, `superseded_by`, `related`) use local ADR IDs and must be reciprocal where applicable. A proposed record may use `proposes_amendments_to`; it cannot declare active `amends` or `supersedes` authority. Design notes live under `notes/` and declare `kind`, `parent_adr`, `authority: subordinate`, and activation state.

## Current index

| ID | Status | Decision and scope |
|---|---|---|
| [ADR-0001](ADR-0001-modularmonolith-cargo-workspace-with-compilerenforced-cleanarchitecture.md) | accepted | Modular-monolith Rust workspace and compiler-enforced layering |
| [ADR-0002](ADR-0002-auditfirst-transactional-discipline-audit-event-in.md) | accepted | Audit event in the same transaction; append-only audit store |
| [ADR-0003](ADR-0003-branchscoped-authorization-model-nonnull-branch-scope.md) | accepted | Non-null branch scope and default-deny authorization |
| [ADR-0004](ADR-0004-passkeysfirst-auth-with-rotating-refreshtoken-families.md) | accepted | Passkey-first local auth and rotating refresh-token families |
| [ADR-0005](ADR-0005-seaweedfs-primary-oci-object-storage-worm.md) | accepted, amended | SeaweedFS primary and a context-appropriate independent WORM replica; amended by ADR-0024 self-host-first portable seams |
| [ADR-0006](ADR-0006-p1-broadcastaccept-dispatch-with-livegps-scoring.md) | accepted | P1 broadcast-accept dispatch and live-GPS scoring |
| [ADR-0007](ADR-0007-postgrespersisted-messenger-with-listennotify-multiinstance-fanout.md) | accepted | Postgres messenger and LISTEN/NOTIFY fan-out |
| [ADR-0008](ADR-0008-excel-export-engine.md) | accepted | Excel export engine |
| [ADR-0009](ADR-0009-dualnative-swiftkotlin-parity-strategy-via-single.md) | accepted | Dual-native Swift/Kotlin employee apps from one OpenAPI contract; `coss-rn` is outside this scope |
| [ADR-0010](ADR-0010-integration-seams-as-ports-only-oyatie.md) | accepted, amended | Oyatie AI port; speculative identity-provider portion amended by ADR-0022 |
| [ADR-0011](ADR-0011-apalis-10rc-isolated-behind-a-jobqueue.md) | accepted | Apalis isolated behind `JobQueue` |
| [ADR-0012](ADR-0012-monorepo-layout-for-four-deliverables-contract.md) | accepted | Monorepo for atomic contract/client delivery |
| ADR-0013 | never issued | Plan-only APNs placeholder; reserved historical gap |
| [ADR-0014](ADR-0014-locationping-destructible-store-carved-out-of.md) | accepted | Destructible location store outside the append-only audit store |
| [ADR-0015](ADR-0015-dr-posture-wal-archiving-continuous-pitr.md) | accepted, amended | Continuous PITR/degraded-mode invariants plus context-specific multi-node/multi-site target; amended by ADR-0024 |
| [ADR-0016](ADR-0016-oyatie-ai-assistant-port-contract.md) | accepted | Oyatie AI assistant port contract |
| [ADR-0017](ADR-0017-superseded-identity-provider-port-contract.md) | superseded | Superseded in full by ADR-0022 |
| [ADR-0018](ADR-0018-clean-room-rust-corporate-workflow-engine.md) | accepted | Clean-room Rust corporate workflow engine |
| [ADR-0019](ADR-0019-standalone-mailbox-server-build-vs-adopt.md) | accepted, amended, reconciliation required | Clean-room Rust mailbox default; ADR-0024 makes self-host the first deployment envelope. Mox design/DARK implementation still needs a newer accepted decision before activation |
| [ADR-0020](ADR-0020-korean-institutional-connectivity-coverage-factory.md) | accepted, fixture-only | Institutional connector coverage factory; no live institution access |
| [ADR-0021](ADR-0021-cedar-pbac-authorization-strangler.md) | accepted target only | Cedar/PBAC strangler baseline; no live enforcement switch |
| [ADR-0022](ADR-0022-local-identity-no-external-idp.md) | accepted | Local passkey identity; no speculative external IdP seam |
| [ADR-0023](ADR-0023-oyatie-console-authority.md) | accepted, amended | Console product/workflow authority; shared-chrome composition and coexistence clauses amended by ADR-0025; historical COSS RN follow-up amended by ADR-0026 |
| [ADR-0024](ADR-0024-bare-metal-portability-and-ha.md) | accepted | Self-host first; cloud-agnostic core through ports/adapters; Oyatie Cloud, AWS, OCI, Azure, and GCP remain first-class and may use native capabilities behind replaceable context boundaries |
| [ADR-0025](ADR-0025-carbon-copy-console-shared-platform-spine.md) | accepted | Amends ADR-0023 with an isolated carbon-copy `/console` visual system, one shared platform spine, staged rollout, full-stack slice gates, and measured legacy deletion |
| [ADR-0026](ADR-0026-retire-coss-rn-public-site-surface.md) | accepted | Retire the standalone COSS RN public-site surface; remove it from npm workspaces and do not cite its historical evidence for MaintenanceField parity or releases |

## Effective relationship graph

- ADR-0022 amends the identity-provider portion of ADR-0010 and supersedes ADR-0017.
- ADR-0005, ADR-0015, and ADR-0019 remain accepted and are amended—not erased—by ADR-0024. For ADR-0019, only the OCI-first deployment-resource envelope changes; the mailbox build-vs.-adopt decision remains. The fully working self-host reference is now the first portability delivery gate; Oyatie Cloud and provider-native cloud adapters follow without losing first-class status.
- ADR-0024's context-native identity seam means workload/infrastructure identity only. It does not amend ADR-0022's local product-user identity or authorize a speculative external IdP/federation seam.
- ADR-0025 amends ADR-0023's shared-chrome composition and non-feature-flag coexistence clauses. ADR-0023 remains accepted for `/overview`, Work Hub/My Work semantics, workflow-engine direction, policy/audit rules, and the fully-wired/no-stub delivery contract.
- ADR-0019 remains the mail-server authority. Mox is DARK and unresolved, not silently accepted.
- ADR-0026 narrowly amends ADR-0023's historical COSS RN follow-up, records a product-surface retirement outside ADR-0009's MaintenanceField parity scope and ADR-0012's four deliverables, and does not amend either of those decisions.

## Subordinate design notes

| Note | Parent | Activation | Scope |
|---|---|---|---|
| [DN-0001](notes/DN-0001-adr-0024-ha-workload-scheduling.md) | accepted ADR-0024 | DARK | First self-host HA workload scheduling expectations; not activation evidence |
| [DN-0002](notes/DN-0002-adr-0024-on-prem-vip-ingress.md) | accepted ADR-0024 | DARK | First self-host on-prem VIP/ingress approach; not activation evidence |
| [DN-0003](notes/DN-0003-adr-0025-operational-object-runtime.md) | accepted ADR-0025 | IN PROGRESS | Palantir-derived operational object runtime, deterministic Actions, object-focused tooling, and governed scenario direction; not release evidence |

## Planning entry

Current facts, unresolved decisions, and planning stop gates are revision-bound evidence maintained separately under `docs/program`. Do not begin from an ADR number alone; read any higher-numbered accepted ADRs and follow explicit relationship fields.
