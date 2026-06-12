---
id: ADR-0015
status: accepted
doc_status: published
date: 2026-06-12
owner: jasonlee
consensus: ralplan iteration 3 (Planner/Architect/Critic APPROVE, 2026-06-12)
related: [ADR-0005]
---

# ADR-0015 — DR posture: WAL archiving + continuous PITR (RPO ≤5min / RTO ≤1h) and VM-down emergency-dispatch fallback

## Status
Accepted (consensus-approved plan §ops).

## Context
Launch runs on a single OCI VM (single fault domain) carrying criminal-liability compliance records and P1 emergency dispatch. Nightly-only backups (RPO ≈24h) were judged inadequate by consensus review.

## Decision
Postgres continuous WAL archiving with point-in-time recovery; targets RPO ≤5min, RTO ≤1h, proven by a restore drill to an arbitrary timestamp (T0.13). SeaweedFS evidence already replicates offsite with retention lock (ADR-0005). A VM-down runbook defines in-flight-P1 behavior: manual 유선 dispatch + Alimtalk while the system is down; each rehearsal writes a timestamped drill log under `docs/evidence/` recording manual-dispatch time-to-first-contact.

## Consequences
+ Data-loss window shrinks from hours to minutes without adding infrastructure tiers; emergency operations have a defined degraded mode.
− WAL archive storage + drill cadence are ongoing ops costs; availability (not durability) still has a single fault domain until the K8s/cloud-growth trigger.

## Alternatives considered
Nightly dumps only (rejected: RPO 24h indefensible for this data); hot standby/HA pair now (deferred: cost/complexity disproportionate at launch; revisit at cloud migration).
