---
id: ADR-0012
status: accepted
doc_status: published
date: 2026-06-12
owner: jasonlee
consensus: ralplan iteration 3 (Planner/Architect/Critic APPROVE, 2026-06-12)
related: [ADR-0009]
---

# ADR-0012 — Monorepo layout for four deliverables (contract atomicity over toolchain isolation)

## Status
Accepted (consensus-approved plan §2.1).

## Context
Four deliverables (Rust backend, React web, Swift iOS, Kotlin Android) must stay in lockstep with one API contract; the consensus Architect steelmanned polyrepo-with-published-contract seriously (macOS CI runners tax on every PR).

## Decision
One repository: `backend/`, `web/`, `ios/`, `android/`, `docs/`, `ops/`. The OpenAPI contract and its generated clients live and version atomically with all consumers; cross-cutting changes are one reviewable commit. The CI tax is mitigated by path-filtered jobs (mobile toolchains build only when their paths or the contract change).

## Consequences
+ Parity machinery (ADR-0009) is enforceable in one CI; no contract-version skew between repos.
− Path-filter discipline required to keep PR CI fast; macOS runners only on ios/** or contract changes.

## Alternatives considered
Polyrepo + published contract artifact (workable; rejected because contract atomicity directly serves the #1 parity risk, and a 1–2 dev team gains little from repo isolation).
