---
id: ADR-0001
status: accepted
doc_status: published
date: 2026-06-12
owner: jasonlee
consensus: ralplan iteration 3 (Planner/Architect/Critic APPROVE, 2026-06-12)
related: [ADR-0012]
---

# ADR-0001 — Modular-monolith Cargo workspace with compiler-enforced clean-architecture layering

## Status
Accepted (consensus-approved plan §2.1).

## Context
One small team builds a system spanning nine business domains for a 300+ user, multi-branch org. Microservices would multiply operational surface; an unstructured monolith would rot. The reference discipline (oyatie) layers `kernel ← domain ← application ← adapter ← {rest, worker} ← app`.

## Decision
Single deployable Rust binary from a Cargo workspace with one crate family per domain (`mnt-<domain>-{domain,application,adapter-postgres,rest,worker}`), shared `mnt-kernel-core`, cross-cutting `mnt-platform-*` crates. Dependency direction is enforced twice: by crate visibility (the compiler refuses absent edges) and by a CI layer-boundary gate (T0.2) that fails on illegal edges and on `sqlx`/`axum`/`tokio` appearing in domain/application crates.

## Consequences
+ Domain logic stays pure and exhaustively unit-testable; adapters are swappable; later service extraction is per-crate, not a rewrite.
+ One process to deploy/observe/back up on the single OCI VM.
− Workspace compile times grow with crate count; mitigated by per-crate `cargo test -p`.

## Alternatives considered
Microservices (rejected: disproportionate ops for team size); single-crate monolith (rejected: no compiler-enforced boundaries, rot risk).
