# Focused maintenance Kanban audit — no-code org/ops editor + Cedar/PBAC

Scope: maintenance repo only. This audit intentionally excludes generic process/dispatcher/infra cards unless their title/body directly affects org structure, policy/access, HR/payroll, Workflow Studio, or operational CRUD flows.

Active cards scanned: 136. Direction-relevant cards: 48. Excluded/process/unrelated: 88.

## Direction-relevant cards needing changes or guardrails

### t_542e9b49 — NORTHSTAR-CEDAR-PBAC-GROUP-CELL-ACCESS-20260701: Cedar PBAC for group/org/site CRUD policy UI
- Status/assignee/priority: `running` / `default` / `98`
- Categories: FOUNDATION_ORG_OPS_EDITOR
- Needed change: Keep as north-star/planning anchor; ensure it stays planning-only until approved PR lanes exist.

### t_2f51772f — Review/fix: ADR-0003 BranchScope/authz core gate
- Status/assignee/priority: `running` / `default` / `86`
- Categories: AUTHZ_TO_CEDAR_PBAC
- Needed change: Add Cedar/PBAC criteria: default-deny, nested group/org/site policy precedence, cross-org worker grants, conflict detection, audit/revocation, CRUD checks.

### t_c8b1c9b8 — ADR-0008 build/verify: platform Excel template fidelity invariants
- Status/assignee/priority: `running` / `default` / `82`
- Categories: POLICY_PAYROLL_SITE_RULESETS
- Needed change: Add optional site/cell policies, operational quirks, payroll rulesets, inherited defaults, higher-scope overrides, and import/export as secondary output only.

### t_7a18524e — Audit/fix: ADR-0017 Bitween identity port local-auth/no-surface guard
- Status/assignee/priority: `running` / `default` / `80`
- Categories: AUTHZ_TO_CEDAR_PBAC
- Needed change: Add Cedar/PBAC criteria: default-deny, nested group/org/site policy precedence, cross-org worker grants, conflict detection, audit/revocation, CRUD checks.

### t_f6846b41 — Audit/fix: ADR-0016 AI assistant port no-surface guard
- Status/assignee/priority: `running` / `default` / `80`
- Categories: AUTHZ_TO_CEDAR_PBAC
- Needed change: Add Cedar/PBAC criteria: default-deny, nested group/org/site policy precedence, cross-org worker grants, conflict detection, audit/revocation, CRUD checks.

### t_2807559b — Design Cedar/PBAC authorization for org and ops CRUD
- Status/assignee/priority: `running` / `default` / `0`
- Categories: FOUNDATION_ORG_OPS_EDITOR, AUTHZ_TO_CEDAR_PBAC
- Needed change: Keep as north-star/planning anchor; ensure it stays planning-only until approved PR lanes exist.
- Needed change: Add Cedar/PBAC criteria: default-deny, nested group/org/site policy precedence, cross-org worker grants, conflict detection, audit/revocation, CRUD checks.

### t_388bf246 — Model policy inheritance, site overrides, and payroll rulesets
- Status/assignee/priority: `running` / `default` / `0`
- Categories: FOUNDATION_ORG_OPS_EDITOR, AUTHZ_TO_CEDAR_PBAC, POLICY_PAYROLL_SITE_RULESETS
- Needed change: Keep as north-star/planning anchor; ensure it stays planning-only until approved PR lanes exist.
- Needed change: Add Cedar/PBAC criteria: default-deny, nested group/org/site policy precedence, cross-org worker grants, conflict detection, audit/revocation, CRUD checks.
- Needed change: Add optional site/cell policies, operational quirks, payroll rulesets, inherited defaults, higher-scope overrides, and import/export as secondary output only.

### t_75025850 — Specify cross-org work assignment and operations workflows
- Status/assignee/priority: `running` / `default` / `0`
- Categories: FOUNDATION_ORG_OPS_EDITOR, AUTHZ_TO_CEDAR_PBAC
- Needed change: Keep as north-star/planning anchor; ensure it stays planning-only until approved PR lanes exist.
- Needed change: Add Cedar/PBAC criteria: default-deny, nested group/org/site policy precedence, cross-org worker grants, conflict detection, audit/revocation, CRUD checks.

### t_a37568df — Confirm live deployment and baseline access
- Status/assignee/priority: `running` / `default` / `0`
- Categories: AUTHZ_TO_CEDAR_PBAC
- Needed change: Add Cedar/PBAC criteria: default-deny, nested group/org/site policy precedence, cross-org worker grants, conflict detection, audit/revocation, CRUD checks.

### t_ccc11e52 — Define org editor primitives and setup UX flows
- Status/assignee/priority: `running` / `default` / `0`
- Categories: FOUNDATION_ORG_OPS_EDITOR, AUTHZ_TO_CEDAR_PBAC
- Needed change: Keep as north-star/planning anchor; ensure it stays planning-only until approved PR lanes exist.
- Needed change: Add Cedar/PBAC criteria: default-deny, nested group/org/site policy precedence, cross-org worker grants, conflict detection, audit/revocation, CRUD checks.

### t_d02b7abb — Reconcile active-PR guard for operations UI review/merge/E2E lane
- Status/assignee/priority: `ready` / `default` / `97`
- Categories: OPS_WORKFLOW_CONTEXT
- Needed change: Add operational context: policy-scoped actions across group/org/site cells, approval eligibility, cross-org assignment context, and E2E browser evidence.

### t_cc292bc9 — Atomic PR: group management LSO slug and compact company actions
- Status/assignee/priority: `ready` / `default` / `0`
- Categories: ORG_EMPLOYEE_GROUP_CRUD
- Needed change: Add group/HQ, corporation/org, department/team, employee, role/position, reporting-line, worksite/사업장 cell, and cross-org assignment CRUD semantics.

### t_7e7a01e7 — NORTHSTAR-NOCODE-ORG-OPS-EDITOR-20260701: no-code editor for company employees org structure and operations logic
- Status/assignee/priority: `todo` / `None` / `97`
- Categories: FOUNDATION_ORG_OPS_EDITOR, AUTHZ_TO_CEDAR_PBAC, ORG_EMPLOYEE_GROUP_CRUD
- Needed change: Keep as north-star/planning anchor; ensure it stays planning-only until approved PR lanes exist.
- Needed change: Add Cedar/PBAC criteria: default-deny, nested group/org/site policy precedence, cross-org worker grants, conflict detection, audit/revocation, CRUD checks.
- Needed change: Add group/HQ, corporation/org, department/team, employee, role/position, reporting-line, worksite/사업장 cell, and cross-org assignment CRUD semantics.

### t_f0bfa148 — Review/fix: HR read-path indexes PR #129
- Status/assignee/priority: `todo` / `default` / `95`
- Categories: ORG_EMPLOYEE_GROUP_CRUD
- Needed change: Add group/HQ, corporation/org, department/team, employee, role/position, reporting-line, worksite/사업장 cell, and cross-org assignment CRUD semantics.

### t_7a81e59f — Workflow Studio split: typed graph domain schema slice
- Status/assignee/priority: `todo` / `default` / `92`
- Categories: WORKFLOW_STUDIO_TO_EDITOR_SUBSTRATE
- Needed change: Reframe from generic workflow canvas to no-code org/operations editor substrate for company/org/employee/site/cell logic; gate implementation behind t_7e7a01e7/t_542e9b49 plan approval.

### t_80b2928a — Workflow Studio split: connector registry and fail-closed validation slice
- Status/assignee/priority: `todo` / `default` / `91`
- Categories: WORKFLOW_STUDIO_TO_EDITOR_SUBSTRATE
- Needed change: Reframe from generic workflow canvas to no-code org/operations editor substrate for company/org/employee/site/cell logic; gate implementation behind t_7e7a01e7/t_542e9b49 plan approval.

### t_b419d0b7 — Workflow Studio foundation: typed graph IR and connector registry
- Status/assignee/priority: `todo` / `default` / `91`
- Categories: WORKFLOW_STUDIO_TO_EDITOR_SUBSTRATE
- Needed change: Reframe from generic workflow canvas to no-code org/operations editor substrate for company/org/employee/site/cell logic; gate implementation behind t_7e7a01e7/t_542e9b49 plan approval.

### t_b6cda382 — Decompose: Workflow Studio typed graph IR and connector registry recovery
- Status/assignee/priority: `todo` / `default` / `91`
- Categories: WORKFLOW_STUDIO_TO_EDITOR_SUBSTRATE
- Needed change: Reframe from generic workflow canvas to no-code org/operations editor substrate for company/org/employee/site/cell logic; gate implementation behind t_7e7a01e7/t_542e9b49 plan approval.

### t_1e936ff1 — Workflow Studio foundation: runtime executor and executable nodes
- Status/assignee/priority: `todo` / `default` / `90`
- Categories: WORKFLOW_STUDIO_TO_EDITOR_SUBSTRATE
- Needed change: Reframe from generic workflow canvas to no-code org/operations editor substrate for company/org/employee/site/cell logic; gate implementation behind t_7e7a01e7/t_542e9b49 plan approval.

### t_99d84747 — Workflow Studio split: OpenAPI contract and readiness integrator slice
- Status/assignee/priority: `todo` / `default` / `90`
- Categories: WORKFLOW_STUDIO_TO_EDITOR_SUBSTRATE
- Needed change: Reframe from generic workflow canvas to no-code org/operations editor substrate for company/org/employee/site/cell logic; gate implementation behind t_7e7a01e7/t_542e9b49 plan approval.

### t_c90824e2 — Workflow template: annual-leave promotion active labor-refusal duty flag
- Status/assignee/priority: `todo` / `default` / `90`
- Categories: WORKFLOW_STUDIO_TO_EDITOR_SUBSTRATE, POLICY_PAYROLL_SITE_RULESETS
- Needed change: Reframe from generic workflow canvas to no-code org/operations editor substrate for company/org/employee/site/cell logic; gate implementation behind t_7e7a01e7/t_542e9b49 plan approval.
- Needed change: Add optional site/cell policies, operational quirks, payroll rulesets, inherited defaults, higher-scope overrides, and import/export as secondary output only.

### t_f873770a — Performance: durable HR/직원명부 read-path indexes
- Status/assignee/priority: `todo` / `default` / `90`
- Categories: ORG_EMPLOYEE_GROUP_CRUD
- Needed change: Add group/HQ, corporation/org, department/team, employee, role/position, reporting-line, worksite/사업장 cell, and cross-org assignment CRUD semantics.

### t_d842f719 — Workflow Studio foundation: visual designer and execution history UX
- Status/assignee/priority: `todo` / `default` / `89`
- Categories: WORKFLOW_STUDIO_TO_EDITOR_SUBSTRATE
- Needed change: Reframe from generic workflow canvas to no-code org/operations editor substrate for company/org/employee/site/cell logic; gate implementation behind t_7e7a01e7/t_542e9b49 plan approval.

### t_9f8f3f5a — Workflow Studio templates: HR/legal approval and policy document workflows
- Status/assignee/priority: `todo` / `default` / `88`
- Categories: WORKFLOW_STUDIO_TO_EDITOR_SUBSTRATE, ORG_EMPLOYEE_GROUP_CRUD, POLICY_PAYROLL_SITE_RULESETS
- Needed change: Reframe from generic workflow canvas to no-code org/operations editor substrate for company/org/employee/site/cell logic; gate implementation behind t_7e7a01e7/t_542e9b49 plan approval.
- Needed change: Add group/HQ, corporation/org, department/team, employee, role/position, reporting-line, worksite/사업장 cell, and cross-org assignment CRUD semantics.
- Needed change: Add optional site/cell policies, operational quirks, payroll rulesets, inherited defaults, higher-scope overrides, and import/export as secondary output only.

### t_954834c8 — Review/fix: Workflow Studio ADR-0018 normalization [t_0fcbae86]
- Status/assignee/priority: `todo` / `None` / `87`
- Categories: WORKFLOW_STUDIO_TO_EDITOR_SUBSTRATE
- Needed change: Reframe from generic workflow canvas to no-code org/operations editor substrate for company/org/employee/site/cell logic; gate implementation behind t_7e7a01e7/t_542e9b49 plan approval.

### t_90491089 — ADR-0006 triage/spec: P1 broadcast/accept dispatch with GPS fallback and escalation
- Status/assignee/priority: `todo` / `default` / `83`
- Categories: AUTHZ_TO_CEDAR_PBAC
- Needed change: Add Cedar/PBAC criteria: default-deny, nested group/org/site policy precedence, cross-org worker grants, conflict detection, audit/revocation, CRUD checks.

### t_a50f8446 — ADR-0008 build/verify: daily-status fill engine and export audit/log contract
- Status/assignee/priority: `todo` / `default` / `81`
- Categories: POLICY_PAYROLL_SITE_RULESETS
- Needed change: Add optional site/cell policies, operational quirks, payroll rulesets, inherited defaults, higher-scope overrides, and import/export as secondary output only.

### t_772fbf40 — ADR-0008 browser/E2E: admin and role-based daily-status workbook download evidence
- Status/assignee/priority: `todo` / `default` / `80`
- Categories: AUTHZ_TO_CEDAR_PBAC, POLICY_PAYROLL_SITE_RULESETS
- Needed change: Add Cedar/PBAC criteria: default-deny, nested group/org/site policy precedence, cross-org worker grants, conflict detection, audit/revocation, CRUD checks.
- Needed change: Add optional site/cell policies, operational quirks, payroll rulesets, inherited defaults, higher-scope overrides, and import/export as secondary output only.

### t_c532b94d — Performance: 직원명부 progressive load, server windowing, and parallel hydration
- Status/assignee/priority: `todo` / `default` / `80`
- Categories: ORG_EMPLOYEE_GROUP_CRUD
- Needed change: Add group/HQ, corporation/org, department/team, employee, role/position, reporting-line, worksite/사업장 cell, and cross-org assignment CRUD semantics.

### t_0ba160b5 — Build/gate: ADR-0010 integration seams no-false-surface guard
- Status/assignee/priority: `todo` / `default` / `79`
- Categories: AUTHZ_TO_CEDAR_PBAC
- Needed change: Add Cedar/PBAC criteria: default-deny, nested group/org/site policy precedence, cross-org worker grants, conflict detection, audit/revocation, CRUD checks.

### t_b394101a — Review/fix: ADR-0008 Excel export correctness, Korean fidelity, browser, audit, dependency risk
- Status/assignee/priority: `todo` / `default` / `78`
- Categories: POLICY_PAYROLL_SITE_RULESETS
- Needed change: Add optional site/cell policies, operational quirks, payroll rulesets, inherited defaults, higher-scope overrides, and import/export as secondary output only.

### t_bd5d2c2c — ADR-0008 live/release verification: daily-status export closeout and governance impact
- Status/assignee/priority: `todo` / `default` / `77`
- Categories: POLICY_PAYROLL_SITE_RULESETS
- Needed change: Add optional site/cell policies, operational quirks, payroll rulesets, inherited defaults, higher-scope overrides, and import/export as secondary output only.

### t_44de8b32 — Review/fix: ADR-0010/0016/0017 integration seams no-false-surface
- Status/assignee/priority: `todo` / `default` / `76`
- Categories: AUTHZ_TO_CEDAR_PBAC
- Needed change: Add Cedar/PBAC criteria: default-deny, nested group/org/site policy precedence, cross-org worker grants, conflict detection, audit/revocation, CRUD checks.

### t_303b62b0 — [Dogfood] Verify and harden refresh-token rate limiting under rapid protected-route navigation
- Status/assignee/priority: `todo` / `default` / `75`
- Categories: AUTHZ_TO_CEDAR_PBAC
- Needed change: Add Cedar/PBAC criteria: default-deny, nested group/org/site policy precedence, cross-org worker grants, conflict detection, audit/revocation, CRUD checks.

### t_ba05ff41 — Build: daily-status/reporting source-data CRUD and report job UX
- Status/assignee/priority: `todo` / `default` / `75`
- Categories: AUTHZ_TO_CEDAR_PBAC, POLICY_PAYROLL_SITE_RULESETS
- Needed change: Add Cedar/PBAC criteria: default-deny, nested group/org/site policy precedence, cross-org worker grants, conflict detection, audit/revocation, CRUD checks.
- Needed change: Add optional site/cell policies, operational quirks, payroll rulesets, inherited defaults, higher-scope overrides, and import/export as secondary output only.

### t_debb2a2a — Verify: ADR-0010/0016/0017 integration seam absence and guard evidence
- Status/assignee/priority: `todo` / `default` / `75`
- Categories: AUTHZ_TO_CEDAR_PBAC
- Needed change: Add Cedar/PBAC criteria: default-deny, nested group/org/site policy precedence, cross-org worker grants, conflict detection, audit/revocation, CRUD checks.

### t_b1ee0e21 — Threat/privacy review: object lifecycle snapshots, events, and rollback
- Status/assignee/priority: `todo` / `default` / `73`
- Categories: ORG_EMPLOYEE_GROUP_CRUD
- Needed change: Add group/HQ, corporation/org, department/team, employee, role/position, reporting-line, worksite/사업장 cell, and cross-org assignment CRUD semantics.

### t_4a781840 — Migration POC: employee_profile object lifecycle spine
- Status/assignee/priority: `todo` / `default` / `72`
- Categories: AUTHZ_TO_CEDAR_PBAC, ORG_EMPLOYEE_GROUP_CRUD
- Needed change: Add Cedar/PBAC criteria: default-deny, nested group/org/site policy precedence, cross-org worker grants, conflict detection, audit/revocation, CRUD checks.
- Needed change: Add group/HQ, corporation/org, department/team, employee, role/position, reporting-line, worksite/사업장 cell, and cross-org assignment CRUD semantics.

### t_dcf13de5 — Policy/company documents: versioned lifecycle, optimized storage, search, employee access
- Status/assignee/priority: `todo` / `default` / `72`
- Categories: ORG_EMPLOYEE_GROUP_CRUD, POLICY_PAYROLL_SITE_RULESETS
- Needed change: Add group/HQ, corporation/org, department/team, employee, role/position, reporting-line, worksite/사업장 cell, and cross-org assignment CRUD semantics.
- Needed change: Add optional site/cell policies, operational quirks, payroll rulesets, inherited defaults, higher-scope overrides, and import/export as secondary output only.

### t_56e35a1f — Build: employee_profile lifecycle CRUD UI and browser story
- Status/assignee/priority: `todo` / `default` / `71`
- Categories: ORG_EMPLOYEE_GROUP_CRUD
- Needed change: Add group/HQ, corporation/org, department/team, employee, role/position, reporting-line, worksite/사업장 cell, and cross-org assignment CRUD semantics.

### t_7e8a9e95 — Performance: route/data prefetch for high-traffic pages
- Status/assignee/priority: `todo` / `default` / `65`
- Categories: AUTHZ_TO_CEDAR_PBAC
- Needed change: Add Cedar/PBAC criteria: default-deny, nested group/org/site policy precedence, cross-org worker grants, conflict detection, audit/revocation, CRUD checks.

### t_1b639345 — Product terminology: rename approval surfaces to 전자결제시스템 where applicable
- Status/assignee/priority: `todo` / `default` / `55`
- Categories: POLICY_PAYROLL_SITE_RULESETS
- Needed change: Add optional site/cell policies, operational quirks, payroll rulesets, inherited defaults, higher-scope overrides, and import/export as secondary output only.

### t_db65f5d4 — Scope recovery: 전자결제시스템 terminology rename after budget exhaustion
- Status/assignee/priority: `todo` / `default` / `55`
- Categories: POLICY_PAYROLL_SITE_RULESETS
- Needed change: Add optional site/cell policies, operational quirks, payroll rulesets, inherited defaults, higher-scope overrides, and import/export as secondary output only.

### t_2efab86c — Verify quote upload and requester visibility
- Status/assignee/priority: `todo` / `default` / `0`
- Categories: AUTHZ_TO_CEDAR_PBAC
- Needed change: Add Cedar/PBAC criteria: default-deny, nested group/org/site policy precedence, cross-org worker grants, conflict detection, audit/revocation, CRUD checks.

### t_cac2779c — Synthesize approved plan and E2E story for PR lanes
- Status/assignee/priority: `todo` / `default` / `0`
- Categories: FOUNDATION_ORG_OPS_EDITOR, AUTHZ_TO_CEDAR_PBAC
- Needed change: Keep as north-star/planning anchor; ensure it stays planning-only until approved PR lanes exist.
- Needed change: Add Cedar/PBAC criteria: default-deny, nested group/org/site policy precedence, cross-org worker grants, conflict detection, audit/revocation, CRUD checks.

### t_df532a0d — Test anomaly gate and approval review workflow
- Status/assignee/priority: `todo` / `default` / `0`
- Categories: POLICY_PAYROLL_SITE_RULESETS
- Needed change: Add optional site/cell policies, operational quirks, payroll rulesets, inherited defaults, higher-scope overrides, and import/export as secondary output only.

### t_f53dc9ba — Test requester purchase request creation flow
- Status/assignee/priority: `todo` / `default` / `0`
- Categories: OPS_WORKFLOW_CONTEXT
- Needed change: Add operational context: policy-scoped actions across group/org/site cells, approval eligibility, cross-org assignment context, and E2E browser evidence.

### t_b3b8dc85 — Design: secondary Excel/upload import bootstrap lane
- Status/assignee/priority: `todo` / `default` / `-20`
- Categories: FOUNDATION_ORG_OPS_EDITOR, POLICY_PAYROLL_SITE_RULESETS
- Needed change: Keep as north-star/planning anchor; ensure it stays planning-only until approved PR lanes exist.
- Needed change: Add optional site/cell policies, operational quirks, payroll rulesets, inherited defaults, higher-scope overrides, and import/export as secondary output only.

## Summary of required board changes

1. Treat Workflow Studio cards as implementation substrate for the no-code org/operations editor, not a standalone generic automation product.
2. Add Cedar/PBAC + policy precedence acceptance criteria to authz and access-boundary cards.
3. Add group/HQ, org, department/team, employee, role/position, worksite/cell, and cross-org assignment CRUD semantics to HR/company/group cards.
4. Add optional site/cell policy/payroll/operational-quirk rulesets and inherited-vs-local override semantics to policy, payroll, reporting/export, approval, and annual-leave cards.
5. Keep import/export/Excel secondary behind DB-backed CRUD/editor workflows.
