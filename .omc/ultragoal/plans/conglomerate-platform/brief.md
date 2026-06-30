# Ultragoal brief — platform maturity E2E completion

Created: 2026-06-30T00:09:54Z

Use the approved ralplan consensus handoff as the source of truth.

Source artifacts:
- Durable handoff: .omx/state/ralplan/platform-maturity-e2e-completion-20260629T215449Z.json
- PRD: .omx/plans/platform-maturity-e2e-completion-prd-20260629T215449Z.md
- Test spec: .omx/plans/platform-maturity-e2e-completion-test-spec-20260629T215449Z.md
- Architect APPROVE: .omx/plans/platform-maturity-e2e-completion-architect-review-20260629T215449Z-iter2.md
- Critic APPROVE: .omx/plans/platform-maturity-e2e-completion-critic-review-20260629T215449Z-final.md

Goal:
Drive the maintenance platform from WIP to enterprise production maturity against best-in-class products with live rollout and browser E2E verification. The platform is a full corporate/enterprise operations OS, not only maintenance/logistics.

Non-negotiable constraints from ralplan:
1. A capability is complete only when merged to main, CI/security/mobile/browser checks are green, image/release discipline is respected, Argo is Synced/Healthy, and live smoke/browser evidence exists.
2. Work must be object-centered: source object, relationships, lifecycle, activity rail, workflow state, audit trail, and scope are visible/actionable.
3. Policy-safe PBAC/RBAC/ABAC, RLS, group/org/department/team/position/custom-role scope, denial reasons, passkey step-up for signing-equivalent actions, and audit actor attribution are enforced.
4. UX must be mature: no text walls, no stub/demo/placeholder paths, no raw UUID labels, production loading/empty/error/partial states, accessibility/keyboard/responsive behavior, clear next action.
5. E2E must cover platform admin, group admin, and at least one persona from every live org in 그룹사: dsl, cnl, elso, cheongun-hr, cheongun-logis, knl, coss, jy-tech, plus platform vendor tier.
6. GitHub issues/comments and session backlog must be refreshed before work, mapped as shipped/valid-planned/rejected/gated/future, and updated after PR/live rollout.
7. Korean legal/privacy/labor/payroll/location/mail/import compliance claims must be gated: no blanket legal compliance claim without official-source refresh, golden tests where relevant, and counsel/management signoff for regulated payroll/tax/labor release.
8. Team workers must not own Ultragoal state; leader checkpoints from team evidence.

Execution strategy:
- Start with Wave 0 + Wave 1 only: route/persona/generated route-audit schema, issue/comment ledger, compliance lane, policy/auth/passkey contract, workflow builder/approval contract, ontology/activity rail contract, import/export contract, observability/release contract, and browser persona harness.
- Do not start broad module implementation until Wave 0+1 hard gates are green.
- Then execute Wave 2+ module slices: identity/account lifecycle; group/org/people/HR/payroll; workflow builder/approvals/Work Hub; equipment/assets/inventory/dispatch; collaboration/mail/calendar/polls; data exchange; public/CX; finance/procurement/ERP; reporting/intelligence; mobile.
- Final story requires ai-slop-cleaner, verification rerun, architecture-invariant audit, independent code-reviewer and architect approval, and quality-gate JSON before marking Codex goal complete.
