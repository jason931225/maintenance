---
id: ADR-0003
status: accepted
doc_status: published
date: 2026-06-12
owner: jasonlee
consensus: ralplan iteration 3 (Planner/Architect/Critic APPROVE, 2026-06-12)
related: []
---

# ADR-0003 — Branch-scoped authorization model (non-null branch scope day 1; default-deny)

## Status
Accepted (consensus-approved plan §2.3).

## Context
The organization is 300+ people across multiple 지점/지역 with a 수도권→충청→영남→호남 rollout. The prior project deferred branch scoping ("nullable, then mandatory") and its own docs flagged that as a must-fix-day-1.

## Decision
`Branch`/`Region` are first-class day-1 schema concepts. Principals carry a `BranchScope` (kernel type): `All` for SUPER_ADMIN/EXECUTIVE rollups, an explicit branch set otherwise. Repositories filter by scope by default (default-deny); cross-branch access is an authorization test fixture (T0.6). P1 broadcasts, KPI rollups, wall-boards, and team channels are branch-scoped.

## Consequences
+ No retrofit migration; rollout waves map to branch seeding.
− Every query carries scope; small constant complexity cost.

## Alternatives considered
Nullable-then-mandatory branch_id (rejected: known prior-project regret); separate DB per branch (rejected: cross-branch rollups + ops cost).
