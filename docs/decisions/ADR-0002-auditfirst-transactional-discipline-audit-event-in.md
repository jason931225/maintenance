---
id: ADR-0002
status: accepted
doc_status: published
date: 2026-06-12
owner: jasonlee
consensus: ralplan iteration 3 (Planner/Architect/Critic APPROVE, 2026-06-12)
related: [ADR-0014]
---

# ADR-0002 — Audit-first transactional discipline (audit event in same tx; append-only table)

## Status
Accepted (consensus-approved plan §2.2).

## Context
Auditability is a critical quality attribute (user mandate): every state transition, approval, assignment, and chat message must be provable after the fact, and audit records must be tamper-evident.

## Decision
Every state mutation runs `SELECT FOR UPDATE → validate transition → UPDATE → INSERT audit_events → COMMIT` via the `with_audit` helper (T0.3). `audit_events` is append-only: UPDATE/DELETE revoked and additionally blocked by trigger. A CI `audit-coverage` gate (T0.4) fails the build if a state-changing handler emits no audit event; its exclusion set contains exactly one entry — the LocationPing ingestion path (ADR-0014) — and a test asserts that is the only exclusion.

## Consequences
+ Audit cannot drift from reality (same transaction = atomic with the change); access to audit is itself audited (T0.8).
− Every write path pays one extra INSERT; acceptable at this scale.

## Alternatives considered
Middleware/log-based audit (rejected: can diverge from committed state); pgaudit (rejected: ops-level, not domain-semantic); temporal tables (rejected: heavier, weaker fit for actor/action semantics).
