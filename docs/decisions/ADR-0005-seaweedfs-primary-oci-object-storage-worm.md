---
id: ADR-0005
status: superseded
doc_status: published
date: 2026-06-12
owner: jasonlee
consensus: ralplan iteration 3 (Planner/Architect/Critic APPROVE, 2026-06-12)
related: [ADR-0010, ADR-0022]
superseded_by: ADR-0022
supersession_scope: OCI Object Storage is no longer the mandatory WORM replica target; ADR-0022 retargets evidence WORM replication to a physically separate site/self-hosted S3 endpoint while preserving OCI Object Storage as one supported target.
---

# ADR-0005 — SeaweedFS primary + portable WORM evidence replica (OCI target superseded by ADR-0022)

## Status
Superseded by ADR-0022 — Cloud-Agnostic Multi-Substrate Portability + High Availability (`origin/main:docs/decisions/ADR-0022-bare-metal-portability-and-ha.md`) for replica-target selection.

The SeaweedFS primary, generic S3 port, CI WORM retention tests, and evidence completion interlock remain accepted. The superseded part is the fixed requirement that the second WORM copy must be OCI Object Storage. OCI Object Storage remains a valid replica target for the `oci-guest` substrate or as one S3-compatible replica, but it is no longer mandatory and must not be treated as the only compliant offsite copy.

## Context
Maintenance photo/video evidence is legally meaningful and must be tamper-proof (WORM) and durable beyond a single machine. The user initially decided RustFS; adversarial verification (2026-06-11) found: pre-GA beta, disk-full metadata corruption (rustfs discussion #2737, unanswered), SSE-plaintext and Object-Lock misreporting bugs in recent betas, CVE-2025-68926 (CVSS 9.8 hardcoded credential), and the only rigorous third-party evaluation concluding "not production-ready". MinIO community is archived (no CVE fixes); Garage lacks Object Lock; Ceph needs 3+ nodes.

ADR-0022 changes the substrate assumption: cloud is a swappable target, the live OCI Talos cluster remains supported as `oci-guest`, and the added `on-prem`/bare-metal HA context must not depend on OCI as the fixed second copy. WORM evidence therefore needs physical and administrative separation from the primary site, not a hard dependency on one cloud provider.

## Decision
SeaweedFS remains the self-hosted primary behind a generic S3 port (`mnt-platform-storage`), hardened: Filer UI/Admin GUI not exposed, releases pinned a few weeks behind head, and our own WORM retention test suite in CI (put-retention COMPLIANCE → version-delete attempt must fail).

Every evidence object must replicate to a WORM-capable S3-compatible target in a physically separate site/failure domain from the primary. For the `on-prem`/bare-metal HA target in ADR-0022, the preferred second copy is self-hosted S3 (SeaweedFS, MinIO, or Ceph-RGW when their production-readiness and immutable-retention posture are accepted for the selected site) located in another physical site. OCI Object Storage with retention lock remains an allowed `oci-guest` replica target or additional replica, configured through the same generic S3 endpoint/credentials seam, but no application, gate, or runbook may require OCI Object Storage as the only valid WORM evidence replica.

Completion interlock: a WorkOrder cannot reach FINAL_COMPLETED with unverified AFTER/REPORT evidence. RustFS re-evaluated at GA (~2026-07): requires stable 1.0.0, the disk-full corruption class fixed, and a published security-patch policy. SeaweedFS↔RustFS swap is config behind the S3 port.

## Consequences
+ Evidence integrity survives primary-node and primary-site loss when the replica is placed in a separate site; vendor swap stays cheap because the app speaks the generic S3 port.
+ OCI remains supported for `oci-guest` and migration/bootstrap scenarios, but portability and HA documentation can point at a provider-neutral second site.
− The `on-prem` posture needs a real second physical site/self-hosted S3 target before WORM durability can be claimed; same-rack or same-building replication is not sufficient evidence protection.
− Replication failures still need the alert/queue path (plan §2.6), now with per-target health and retention-lock verification.

## Alternatives considered
OCI Object Storage as the mandatory replica (superseded: still valid for `oci-guest`, but conflicts with ADR-0022 portability when treated as required); RustFS now (rejected on evidence above, user approved fallback); MinIO (archived in the version assessed at launch); Garage (no Object Lock); Ceph/RGW (ops-disproportionate for the original launch, re-evaluable for multi-node/site HA).
