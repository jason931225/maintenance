---
id: ADR-0005
status: accepted
doc_status: published
date: 2026-06-12
owner: jasonlee
consensus: ralplan iteration 3 (Planner/Architect/Critic APPROVE, 2026-06-12)
related: [ADR-0010]
---

# ADR-0005 — SeaweedFS primary + OCI Object Storage WORM replica (RustFS rejected at launch; re-evaluate at GA)

## Status
Accepted (consensus-approved plan §2.6).

## Context
Maintenance photo/video evidence is legally meaningful and must be tamper-proof (WORM) and durable beyond a single machine. The user initially decided RustFS; adversarial verification (2026-06-11) found: pre-GA beta, disk-full metadata corruption (rustfs discussion #2737, unanswered), SSE-plaintext and Object-Lock misreporting bugs in recent betas, CVE-2025-68926 (CVSS 9.8 hardcoded credential), and the only rigorous third-party evaluation concluding "not production-ready". MinIO community is archived (no CVE fixes); Garage lacks Object Lock; Ceph needs 3+ nodes.

## Decision
SeaweedFS as the self-hosted primary behind a generic S3 port (`mnt-platform-storage`), hardened: Filer UI/Admin GUI not exposed, releases pinned a few weeks behind head, and our own WORM retention test suite in CI (put-retention COMPLIANCE → version-delete attempt must fail). Every evidence object replicates to an OCI Object Storage bucket with retention lock; the offsite WORM copy is what actually protects evidentiary value. Completion interlock: a WorkOrder cannot reach FINAL_COMPLETED with unverified AFTER/REPORT evidence. RustFS re-evaluated at GA (~2026-07): requires stable 1.0.0, the disk-full corruption class fixed, and a published security-patch policy. SeaweedFS↔RustFS swap is config behind the S3 port.

## Consequences
+ Evidence integrity survives single-VM loss; vendor swap is cheap.
− Two storage systems to operate (local + OCI replica); replication failures need the alert/queue path (plan §2.6).

## Alternatives considered
RustFS now (rejected on evidence above, user approved fallback); MinIO (archived); Garage (no Object Lock); Ceph/RGW (ops-disproportionate).
