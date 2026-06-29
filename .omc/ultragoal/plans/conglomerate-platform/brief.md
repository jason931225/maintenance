# Ultragoal Brief — Remaining Backlog Clearance

Use the approved ralplan artifacts as the authoritative source:
- PRD: `.omx/plans/remaining-backlog-clearance-prd-20260629T083137Z.md`
- Test spec: `.omx/plans/remaining-backlog-clearance-test-spec-20260629T083137Z.md`
- Handoff: `.omx/state/ralplan/remaining-backlog-clearance-20260629T083137Z.json`

Create a durable aggregate Codex objective for this plan and track only these execution stories. Do not split principles, risks, pros/cons, or acceptance bullets into separate goals. Every story must preserve: no stubs/placeholders, no premature AI, Korean legal/privacy/labor boundaries, passkey step-up for sensitive actions, PBAC/ABAC/RBAC policy discipline, object-centered workflow, import dry-run/PII governance, PR→review→fix→merge→CI/security/Trivy→Argo/live evidence, and issue/comment traceability.

G001 — Wave 0 backlog ledger and dispatch contracts. Produce the canonical backlog clearance ledger for GitHub issues #6-#19/#55/#56 and session backlog items; reconcile merged PRs #61-#86; classify every item as shipped/valid-planned/rejected/gated/future; create the lane ownership/no-touch matrix, generated-client rules, and evidence/signoff columns. This is the mandatory gate before domain implementation.

G002 — W1A0/W1I/W1UX foundation gates. Establish the policy/audit/passkey contract baseline, CI/CD/security/release baseline, and UI shell/design/i18n/a11y baseline. Verify the installed `omx team 6:executor` launch path and ensure W1A-W1H cannot start until these gates are green.

G003 — Identity, passkey, account lifecycle, and configurable policy. Implement and verify W1A: desktop passkey, desktop QR-to-mobile handoff, mobile passkey, OTP-limited setup, multiple passkeys/account settings, sensitive-action passkey step-up, group/org/tenant/user lifecycle status, and configurable PBAC/ABAC/RBAC with audit/RLS tests.

G004 — Ontology/workflow builder, approvals, planned work, and notifications. Implement and verify W1B: no-code workflow authoring, approval/payment lines, comments/evidence/image visibility, queue/badge lifecycle, planned work from source work order, work-order detail dispatch/edit surface, urgent notifications, object timelines, and audit trails.

G005 — Import/export and data governance. Implement and verify W1C: raw import ledger, spreadsheet/folder classification, preview/table mapping UI, server-side schema/entity-type allowlist, PII/payroll/location masking, safe diff/dry-run/apply, standardized export, and workbook row-count to DB/API/browser parity.

G006 — Group/org/people/HR/payroll lifecycle. Implement and verify W1D: tenant/group/org separation, group consolidated/per-org switching, org graph, departments/teams/positions/custom roles, onboarding/offboarding/termination/intra-group transfer workflows, payroll/HR masking, Korean labor/privacy/payroll signoff gates.

G007 — Assets/equipment/sites/dispatch lifecycle. Implement and verify W1E: owner vs operator, group-admin selected legal owner, cross-org two-party transfer approval with legal/accounting signoff, equipment search parity, detail popup/edit, maintenance history/cost/residual/warranty/contract, address/geocode/site persistence, geofence/map pins, dispatch Kanban, substitute recommendation.

G008 — Collaboration, mail, calendar, polls, Work Hub, and mobile app. Implement and verify W1F/W1G: mature messenger/mail/calendar/poll UX, unread/read/mentions/search/attachments/object links, role-aware Work Hub, mobile employee app for clock-in/passkey/signing/notifications/approvals/comms/calendar/polls, generated Swift/Kotlin drift and mobile build/smoke.

G009 — Public landing, CX, sales/rental marketplace, and support pipeline. Implement and verify W1H: public landing with privacy/cookie/footer/copyright/semver, public sale/rental asset listings and filters, customer inquiry to internal CX/support/sales queues, support lifecycle, billing/subscription only behind legal/security/merchant gate.

G010 — Security, observability, CI/CD, backup/DR, and release discipline. Implement and verify W1I production hardening: digest deploy, admission verification/audit mode, global limits/timeouts/tracing layers, secrets GitOps path, monitoring/runbooks within OCI free-tier constraints, backup/restore/object-store lifecycle, Argo rollout, no false HA claims.

G011 — Enterprise module maturity and UI/UX parity closure. After W1 foundations are green, mature HR/payroll, procurement/purchasing, finance/accounting, CX/sales, reporting/BI, executive dashboards, and all screens against the parity matrix; remove text walls/dead screens; verify role stories and accessibility.

G012 — Operations intelligence, MES, optimization, and governed AI readiness. Only after trusted master data/workflow/policy/observability foundations are production-grade, implement deterministic analytics foundations for rental pricing, margin, maintenance cycles, sell/keep, reserve parts/equipment, workforce/SLO planning, purchasing/bidding analytics, MES future scope, and AI/LLM/RL/ML as governed recommendation/draft assistants only.

Final quality gate: before marking the aggregate complete, run targeted verification, ai-slop-cleaner on changed files, architecture invariant audit, independent code-reviewer and architect review, and checkpoint with quality-gate JSON as required by the Ultragoal skill.
