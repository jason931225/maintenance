---
id: ADR-0010
status: accepted
doc_status: published
date: 2026-06-12
owner: jasonlee
consensus: ralplan iteration 3 (Planner/Architect/Critic APPROVE, 2026-06-12)
related: [ADR-0001]
---

# ADR-0010 — Integration seams as ports only (oyatie AI, Bitween identity) — no mock adapters

## Status
Accepted (consensus-approved plan §2.11).

## Context
Two future integrations are certain in shape but not in timing: oyatie cloud intelligence (AI assistant — deferred until oyatie is ready) and Bitween (employee identity/attendance/payroll system that will own HR data). The production-grade-only mandate forbids stubs and demo modes.

## Decision
Each seam is a port (trait) in the application layer with NO adapter until the real one lands: `IntelligencePort` (diagnosis suggestions, report drafting) and `IdentityProviderPort` (user/role sync, attendance read). Features behind an unfilled port are absent from the UI — not mocked, not faked. Local accounts (ADR-0004) are the identity source until the Bitween adapter exists; ownership boundaries follow the prior project's roadmap (Bitween owns identity/attendance/payroll; this system owns work orders/KPI/approvals).

## Consequences
+ No dead code or false affordances ship; the seam is compiler-checked the day the adapter arrives.
− Port design must be done carefully now against known Bitween contract fields (prior BITWEEN_INTEGRATION_ROADMAP) without an implementation to validate against.

## Alternatives considered
Mock adapters for demo (violates mandate); deferring port definition entirely (rejected: retrofitting a seam into nine domains later is the expensive path).
