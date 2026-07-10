---
id: ADR-0015
status: superseded
doc_status: published
date: 2026-06-12
owner: jasonlee
consensus: ralplan iteration 3 (Planner/Architect/Critic APPROVE, 2026-06-12)
related: [ADR-0005, ADR-0022]
superseded_by: ADR-0022
supersession_scope: ADR-0022 supersedes the single-node/OCI final-state assumption with a multi-node and multi-site failover target while preserving the current oci-guest restore/degraded-mode posture as a supported substrate.
---

# ADR-0015 — DR posture: continuous PITR plus multi-node/multi-site failover (oci-guest launch posture superseded by ADR-0022)

## Status
Superseded by ADR-0022 — Cloud-Agnostic Multi-Substrate Portability + High Availability (`origin/main:docs/decisions/ADR-0022-bare-metal-portability-and-ha.md`) for the target DR topology.

Continuous WAL archiving, arbitrary-timestamp PITR, RPO ≤5min / RTO ≤1h targets, and the emergency-dispatch fallback remain required controls. The superseded part is treating a single OCI VM/fault domain as the long-term DR shape. That posture remains documented and supported for the current `oci-guest` substrate, but it is a restore/degraded-mode posture, not the HA or multi-site failover target.

## Context
Launch runs on a single OCI VM (single fault domain) carrying criminal-liability compliance records and P1 emergency dispatch. Nightly-only backups (RPO ≈24h) were judged inadequate by consensus review.

ADR-0022 changes the target architecture: OCI remains a first-class `oci-guest` substrate, but cloud is swappable, the added `on-prem`/bare-metal context requires no single point of failure, and DR must progress from single-node restore to multi-node and multi-site failover. Documentation must therefore distinguish the current OCI guest's honest limitations from the HA target instead of presenting the launch posture as the final state.

## Decision
Postgres continuous WAL archiving with point-in-time recovery remains mandatory in every substrate; targets RPO ≤5min and RTO ≤1h are proven by a restore drill to an arbitrary timestamp (T0.13 or successor evidence). SeaweedFS evidence WORM replication follows ADR-0005 as superseded by ADR-0022: the durable evidence replica must live in a separate physical site/S3-compatible target, with OCI Object Storage still valid for the `oci-guest` path but not required everywhere.

The ADR-0022 target DR posture is multi-node and multi-site:

- `on-prem`/bare-metal HA uses multi-instance CNPG (for example `instances: 3`), replicated storage across worker/storage failure domains, and a failover drill that proves primary/node loss without data loss beyond the RPO.
- WAL archives and base backups are written to a site-independent object store, not only to storage in the same building/rack as the primary.
- A warm-standby or secondary-site runbook owns traffic/DNS/VIP promotion, data-divergence checks, and rollback before any site-level failover is called production-ready.
- Emergency P1 behavior remains defined: manual 유선 dispatch + Alimtalk while automation is unavailable; each rehearsal writes a timestamped drill log under `docs/evidence/` recording manual-dispatch time-to-first-contact.

The current `oci-guest` path remains supported and accurately limited: single-node CNPG/VM loss is a restore-from-backup or degraded emergency-dispatch event, not automatic failover. Its OCI Object Storage/Barman posture is acceptable only as that substrate's current recovery posture until the HA context is activated and verified.

## Consequences
+ Data-loss windows stay bounded by continuous WAL/PITR, while the ADR-0022 target removes the single-node/single-site availability assumption.
+ OCI remains deployable and documented as `oci-guest`, but docs and gates can now require separate evidence for `on-prem`/bare-metal HA before claiming automatic failover.
− Multi-node and multi-site failover adds operational cost: node inventory, replicated storage, site-independent object storage, failover drills, rollback checks, and observability evidence.
− RPO/RTO restore drills alone are not sufficient HA proof; primary/node failure and site-promotion drills are required for the HA target.

## Alternatives considered
Nightly dumps only (rejected: RPO 24h indefensible for this data); single-node OCI PITR as the final posture (superseded by ADR-0022; retained only as the `oci-guest` recovery posture); hot standby/HA pair at the original launch (deferred then because cost/complexity was disproportionate, now replaced by the ADR-0022 multi-node/multi-site target).
