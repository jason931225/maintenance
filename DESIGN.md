# DESIGN.md

## Current design decision: Work Hub first

For issue #55, the enterprise collaboration suite starts from a role-aware Work Hub, not from a disconnected messenger/mail/task demo. The first screen after login should answer: what needs attention today, what is blocked on approval, where is the related conversation/evidence, and which source object owns the work.

## Interaction model

`Work Hub -> Source object -> Conversation / Mail / Evidence -> Approval or task action -> Audit trail`

This keeps each module native and production-grade while making the cross-module workflow feel integrated.

## UX rules

- Korean-first copy from `ko.ts`; no hardcoded user-facing strings in components.
- No raw UUIDs as labels. Use request numbers, customer/site names, display names, and safe fallbacks.
- No dead links for known role-gated routes. Disabled cards must explain that the capability is outside the current role scope.
- Loading, empty, partial-failure, and full-failure states are required for every aggregate surface.
- Sensitive decisions belong in the approval/workflow system, with passkey step-up and audit trail as the target architecture.

## Benchmark source

See `docs/benchmarks/issue-55-collaboration-work-hub.md` for the Slack, Microsoft, SAP, Atlassian, ServiceNow, and Palantir benchmark matrix and user stories.
