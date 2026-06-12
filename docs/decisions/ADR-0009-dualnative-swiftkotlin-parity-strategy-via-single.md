---
id: ADR-0009
status: accepted
doc_status: published
date: 2026-06-12
owner: jasonlee
consensus: ralplan iteration 3 (Planner/Architect/Critic APPROVE, 2026-06-12)
related: [ADR-0012]
---

# ADR-0009 — Dual-native (Swift+Kotlin) parity strategy via single OpenAPI contract + CI parity gate

## Status
Accepted (consensus-approved plan §2.9).

## Context
The user chose native Swift (iOS) + Kotlin (Android) apps over a single React Native codebase (informed decision, interview R6) for maximal mobile UX. Two codebases create parity-drift risk — the plan's #1 pre-mortem scenario.

## Decision
Parity is enforced structurally, not by discipline: one utoipa-emitted `openapi.yaml` is the single contract; CI generates ts/swift/kotlin clients and fails on drift (T1.9); both apps build from every release tag (T1.8 dual-build gate); a per-release parity checklist (same user-visible capabilities) gates release; per-slice sequencing ships web+Android first, iOS immediately after, within the same milestone.

## Consequences
+ Best platform UX (camera pipeline, push handling, passkeys are platform-native anyway).
− Roughly 2× client implementation cost per slice — accepted by the user explicitly; the contract/codegen machinery is the mitigation, and it has its own CI gate.

## Alternatives considered
Expo/React Native single codebase (research-recommended; user overrode); RN + native modules hybrid (offered; declined).
