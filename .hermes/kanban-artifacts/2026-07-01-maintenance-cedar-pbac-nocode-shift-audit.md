# Maintenance Kanban direction-shift audit — Cedar/PBAC + no-code org/ops editor

Source: direct user directives in Discord #development on 2026-07-01. Scope: maintenance repo only; no Oyatie changes.

Shift to reflect: start from company basics (employees + organizational structure), build a no-code editor for complex organizational/operational logic, adopt Cedar policy control + PBAC for CRUD/access, support 점조직-style HQ/group across orgs, cross-org workers, nested group/org/site(사업장) cells, optional local policy/operational/payroll quirks, and higher-scope policies that supersede contradictory lower/substrate rules.

Active cards scanned: 136. Affected cards needing some reframe/gate/comment: 118. Process/unrelated/no immediate change: 18.

## Required board changes by category

- **CEDAR_PBAC_AUTHZ** (94 cards): t_542e9b49, t_179a510b, t_2f51772f, t_22dd46d1, t_63adc1a4, t_97571564, t_a34c4de5, t_bb35b301, t_f6894943, t_90081791, t_8fa67b16, t_c8b1c9b8, t_7a18524e, t_f6846b41, t_2807559b, t_388bf246, t_75025850, t_a37568df, t_ccc11e52, t_c5a221ab, t_5cdfbc12, t_7e7a01e7, t_c45f6ab0, t_1ac74db1, t_2359c04a, t_7a81e59f, t_b419d0b7, t_b6cda382, t_1e936ff1, t_c90824e2 … +64
- **ORG_EMPLOYEE_STRUCTURE** (72 cards): t_542e9b49, t_179a510b, t_2f51772f, t_bb35b301, t_90081791, t_8fa67b16, t_7a18524e, t_2807559b, t_388bf246, t_75025850, t_ccc11e52, t_d02b7abb, t_cc292bc9, t_1e0e137b, t_5cdfbc12, t_7e7a01e7, t_f0bfa148, t_7a81e59f, t_b419d0b7, t_b6cda382, t_1e936ff1, t_99d84747, t_c90824e2, t_f873770a, t_9f8f3f5a, t_394023da, t_306c59d0, t_33c68da9, t_884da940, t_2addbe28 … +42
- **CELL_POLICY_PAYROLL_RULESETS** (37 cards): t_542e9b49, t_bb35b301, t_c8b1c9b8, t_7a18524e, t_2807559b, t_388bf246, t_75025850, t_ccc11e52, t_7e7a01e7, t_761bb793, t_f0bfa148, t_7a81e59f, t_b419d0b7, t_b6cda382, t_1e936ff1, t_c90824e2, t_f873770a, t_9f8f3f5a, t_b0eee3f0, t_a50f8446, t_d688c613, t_4e472441, t_772fbf40, t_6ab6ae63, t_b394101a, t_bd5d2c2c, t_fab75c71, t_ada94bb6, t_303b62b0, t_ba05ff41 … +7
- **OPS_WORKFLOW_AUTHZ** (53 cards): t_542e9b49, t_179a510b, t_2f51772f, t_1cef720c, t_22dd46d1, t_97571564, t_bb35b301, t_90081791, t_2807559b, t_388bf246, t_75025850, t_a37568df, t_d02b7abb, t_cc623b69, t_c5a221ab, t_7e7a01e7, t_c45f6ab0, t_2359c04a, t_80b2928a, t_b419d0b7, t_1e936ff1, t_d842f719, t_9f8f3f5a, t_954834c8, t_cfe7b580, t_306c59d0, t_90491089, t_c7172874, t_a50f8446, t_d18c9978 … +23
- **NO_CODE_ORG_EDITOR_FOUNDATION** (11 cards): t_7a81e59f, t_80b2928a, t_b419d0b7, t_b6cda382, t_1e936ff1, t_99d84747, t_c90824e2, t_d842f719, t_9f8f3f5a, t_954834c8, t_4a781840

## High-priority cards to reframe/comment now

### t_542e9b49 — NORTHSTAR-CEDAR-PBAC-GROUP-CELL-ACCESS-20260701: Cedar PBAC for group/org/site CRUD policy UI
- Status/assignee/priority: `running` / `default` / `98`
- Categories: CEDAR_PBAC_AUTHZ, ORG_EMPLOYEE_STRUCTURE, CELL_POLICY_PAYROLL_RULESETS, OPS_WORKFLOW_AUTHZ
- Needed change: Add Cedar/PBAC migration criteria: default-deny, group/org/site hierarchy, cross-org worker grants, higher-scope policy precedence, conflict detection, audit/revocation, and CRUD checks.
- Needed change: Add org-structure criteria: group/HQ, corporations/orgs, departments/teams, employees, roles/positions, reporting lines, worksites/사업장 cells, and cross-org assignments as editable CRUD objects.
- Needed change: Add site/cell ruleset criteria: optional local policies, operational quirks, payroll rulesets, inherited defaults, higher-scope overrides, and import/export as secondary output only.
- Needed change: Add operational workflow criteria: policy-scoped CRUD/actions across group/org/site cells, cross-org assignment context, approval eligibility, and E2E browser evidence.

### t_179a510b — Review/fix: ADR-0019 first accepted mailbox slice
- Status/assignee/priority: `running` / `default` / `88`
- Categories: CEDAR_PBAC_AUTHZ, ORG_EMPLOYEE_STRUCTURE, OPS_WORKFLOW_AUTHZ
- Needed change: Add Cedar/PBAC migration criteria: default-deny, group/org/site hierarchy, cross-org worker grants, higher-scope policy precedence, conflict detection, audit/revocation, and CRUD checks.
- Needed change: Add org-structure criteria: group/HQ, corporations/orgs, departments/teams, employees, roles/positions, reporting lines, worksites/사업장 cells, and cross-org assignments as editable CRUD objects.
- Needed change: Add operational workflow criteria: policy-scoped CRUD/actions across group/org/site cells, cross-org assignment context, approval eligibility, and E2E browser evidence.

### t_2f51772f — Review/fix: ADR-0003 BranchScope/authz core gate
- Status/assignee/priority: `running` / `default` / `86`
- Categories: CEDAR_PBAC_AUTHZ, ORG_EMPLOYEE_STRUCTURE, OPS_WORKFLOW_AUTHZ
- Needed change: Add Cedar/PBAC migration criteria: default-deny, group/org/site hierarchy, cross-org worker grants, higher-scope policy precedence, conflict detection, audit/revocation, and CRUD checks.
- Needed change: Add org-structure criteria: group/HQ, corporations/orgs, departments/teams, employees, roles/positions, reporting lines, worksites/사업장 cells, and cross-org assignments as editable CRUD objects.
- Needed change: Add operational workflow criteria: policy-scoped CRUD/actions across group/org/site cells, cross-org assignment context, approval eligibility, and E2E browser evidence.

### t_1cef720c — ADR-0014 triage/spec: LocationPing destructible store, consent, and audit exclusion
- Status/assignee/priority: `running` / `default` / `85`
- Categories: OPS_WORKFLOW_AUTHZ
- Needed change: Add operational workflow criteria: policy-scoped CRUD/actions across group/org/site cells, cross-org assignment context, approval eligibility, and E2E browser evidence.

### t_22dd46d1 — Ops gate: ADR-0015 production DR credentials, drill window, and manual-dispatch rehearsal evidence
- Status/assignee/priority: `running` / `default` / `84`
- Categories: CEDAR_PBAC_AUTHZ, OPS_WORKFLOW_AUTHZ
- Needed change: Add Cedar/PBAC migration criteria: default-deny, group/org/site hierarchy, cross-org worker grants, higher-scope policy precedence, conflict detection, audit/revocation, and CRUD checks.
- Needed change: Add operational workflow criteria: policy-scoped CRUD/actions across group/org/site cells, cross-org assignment context, approval eligibility, and E2E browser evidence.

### t_63adc1a4 — Build: ADR-0011 JobQueue contract and apalis isolation gate
- Status/assignee/priority: `running` / `default` / `84`
- Categories: CEDAR_PBAC_AUTHZ
- Needed change: Add Cedar/PBAC migration criteria: default-deny, group/org/site hierarchy, cross-org worker grants, higher-scope policy precedence, conflict detection, audit/revocation, and CRUD checks.

### t_97571564 — Ops gate: ADR-0005 OCI WORM bucket, legal retention policy, and delete-fail evidence
- Status/assignee/priority: `running` / `default` / `84`
- Categories: CEDAR_PBAC_AUTHZ, OPS_WORKFLOW_AUTHZ
- Needed change: Add Cedar/PBAC migration criteria: default-deny, group/org/site hierarchy, cross-org worker grants, higher-scope policy precedence, conflict detection, audit/revocation, and CRUD checks.
- Needed change: Add operational workflow criteria: policy-scoped CRUD/actions across group/org/site cells, cross-org assignment context, approval eligibility, and E2E browser evidence.

### t_a34c4de5 — Build/verify: ADR-0015 WAL archiving, PITR drills, and VM-down runbook readiness
- Status/assignee/priority: `running` / `default` / `84`
- Categories: CEDAR_PBAC_AUTHZ
- Needed change: Add Cedar/PBAC migration criteria: default-deny, group/org/site hierarchy, cross-org worker grants, higher-scope policy precedence, conflict detection, audit/revocation, and CRUD checks.

### t_bb35b301 — Build: ADR-0003 KPI/ops/wallboard branch semantics proof
- Status/assignee/priority: `running` / `default` / `84`
- Categories: CEDAR_PBAC_AUTHZ, ORG_EMPLOYEE_STRUCTURE, CELL_POLICY_PAYROLL_RULESETS, OPS_WORKFLOW_AUTHZ
- Needed change: Add Cedar/PBAC migration criteria: default-deny, group/org/site hierarchy, cross-org worker grants, higher-scope policy precedence, conflict detection, audit/revocation, and CRUD checks.
- Needed change: Add org-structure criteria: group/HQ, corporations/orgs, departments/teams, employees, roles/positions, reporting lines, worksites/사업장 cells, and cross-org assignments as editable CRUD objects.
- Needed change: Add site/cell ruleset criteria: optional local policies, operational quirks, payroll rulesets, inherited defaults, higher-scope overrides, and import/export as secondary output only.
- Needed change: Add operational workflow criteria: policy-scoped CRUD/actions across group/org/site cells, cross-org assignment context, approval eligibility, and E2E browser evidence.

### t_f6894943 — Implement ADR-0002 global handler-surface audit gate hardening
- Status/assignee/priority: `running` / `default` / `84`
- Categories: CEDAR_PBAC_AUTHZ
- Needed change: Add Cedar/PBAC migration criteria: default-deny, group/org/site hierarchy, cross-org worker grants, higher-scope policy precedence, conflict detection, audit/revocation, and CRUD checks.

### t_90081791 — Build: ADR-0003 messenger/team-channel branch-scope proof
- Status/assignee/priority: `running` / `default` / `83`
- Categories: CEDAR_PBAC_AUTHZ, ORG_EMPLOYEE_STRUCTURE, OPS_WORKFLOW_AUTHZ
- Needed change: Add Cedar/PBAC migration criteria: default-deny, group/org/site hierarchy, cross-org worker grants, higher-scope policy precedence, conflict detection, audit/revocation, and CRUD checks.
- Needed change: Add org-structure criteria: group/HQ, corporations/orgs, departments/teams, employees, roles/positions, reporting lines, worksites/사업장 cells, and cross-org assignments as editable CRUD objects.
- Needed change: Add operational workflow criteria: policy-scoped CRUD/actions across group/org/site cells, cross-org assignment context, approval eligibility, and E2E browser evidence.

### t_8fa67b16 — Build/spec: ADR-0009/0012 OpenAPI generated-client atomicity integrator
- Status/assignee/priority: `running` / `default` / `82`
- Categories: CEDAR_PBAC_AUTHZ, ORG_EMPLOYEE_STRUCTURE
- Needed change: Add Cedar/PBAC migration criteria: default-deny, group/org/site hierarchy, cross-org worker grants, higher-scope policy precedence, conflict detection, audit/revocation, and CRUD checks.
- Needed change: Add org-structure criteria: group/HQ, corporations/orgs, departments/teams, employees, roles/positions, reporting lines, worksites/사업장 cells, and cross-org assignments as editable CRUD objects.

### t_c8b1c9b8 — ADR-0008 build/verify: platform Excel template fidelity invariants
- Status/assignee/priority: `running` / `default` / `82`
- Categories: CEDAR_PBAC_AUTHZ, CELL_POLICY_PAYROLL_RULESETS
- Needed change: Add Cedar/PBAC migration criteria: default-deny, group/org/site hierarchy, cross-org worker grants, higher-scope policy precedence, conflict detection, audit/revocation, and CRUD checks.
- Needed change: Add site/cell ruleset criteria: optional local policies, operational quirks, payroll rulesets, inherited defaults, higher-scope overrides, and import/export as secondary output only.

### t_7a18524e — Audit/fix: ADR-0017 Bitween identity port local-auth/no-surface guard
- Status/assignee/priority: `running` / `default` / `80`
- Categories: CEDAR_PBAC_AUTHZ, ORG_EMPLOYEE_STRUCTURE, CELL_POLICY_PAYROLL_RULESETS
- Needed change: Add Cedar/PBAC migration criteria: default-deny, group/org/site hierarchy, cross-org worker grants, higher-scope policy precedence, conflict detection, audit/revocation, and CRUD checks.
- Needed change: Add org-structure criteria: group/HQ, corporations/orgs, departments/teams, employees, roles/positions, reporting lines, worksites/사업장 cells, and cross-org assignments as editable CRUD objects.
- Needed change: Add site/cell ruleset criteria: optional local policies, operational quirks, payroll rulesets, inherited defaults, higher-scope overrides, and import/export as secondary output only.

### t_f6846b41 — Audit/fix: ADR-0016 AI assistant port no-surface guard
- Status/assignee/priority: `running` / `default` / `80`
- Categories: CEDAR_PBAC_AUTHZ
- Needed change: Add Cedar/PBAC migration criteria: default-deny, group/org/site hierarchy, cross-org worker grants, higher-scope policy precedence, conflict detection, audit/revocation, and CRUD checks.

### t_2807559b — Design Cedar/PBAC authorization for org and ops CRUD
- Status/assignee/priority: `running` / `default` / `0`
- Categories: CEDAR_PBAC_AUTHZ, ORG_EMPLOYEE_STRUCTURE, CELL_POLICY_PAYROLL_RULESETS, OPS_WORKFLOW_AUTHZ
- Needed change: Add Cedar/PBAC migration criteria: default-deny, group/org/site hierarchy, cross-org worker grants, higher-scope policy precedence, conflict detection, audit/revocation, and CRUD checks.
- Needed change: Add org-structure criteria: group/HQ, corporations/orgs, departments/teams, employees, roles/positions, reporting lines, worksites/사업장 cells, and cross-org assignments as editable CRUD objects.
- Needed change: Add site/cell ruleset criteria: optional local policies, operational quirks, payroll rulesets, inherited defaults, higher-scope overrides, and import/export as secondary output only.
- Needed change: Add operational workflow criteria: policy-scoped CRUD/actions across group/org/site cells, cross-org assignment context, approval eligibility, and E2E browser evidence.

### t_388bf246 — Model policy inheritance, site overrides, and payroll rulesets
- Status/assignee/priority: `running` / `default` / `0`
- Categories: CEDAR_PBAC_AUTHZ, ORG_EMPLOYEE_STRUCTURE, CELL_POLICY_PAYROLL_RULESETS, OPS_WORKFLOW_AUTHZ
- Needed change: Add Cedar/PBAC migration criteria: default-deny, group/org/site hierarchy, cross-org worker grants, higher-scope policy precedence, conflict detection, audit/revocation, and CRUD checks.
- Needed change: Add org-structure criteria: group/HQ, corporations/orgs, departments/teams, employees, roles/positions, reporting lines, worksites/사업장 cells, and cross-org assignments as editable CRUD objects.
- Needed change: Add site/cell ruleset criteria: optional local policies, operational quirks, payroll rulesets, inherited defaults, higher-scope overrides, and import/export as secondary output only.
- Needed change: Add operational workflow criteria: policy-scoped CRUD/actions across group/org/site cells, cross-org assignment context, approval eligibility, and E2E browser evidence.

### t_75025850 — Specify cross-org work assignment and operations workflows
- Status/assignee/priority: `running` / `default` / `0`
- Categories: CEDAR_PBAC_AUTHZ, ORG_EMPLOYEE_STRUCTURE, CELL_POLICY_PAYROLL_RULESETS, OPS_WORKFLOW_AUTHZ
- Needed change: Add Cedar/PBAC migration criteria: default-deny, group/org/site hierarchy, cross-org worker grants, higher-scope policy precedence, conflict detection, audit/revocation, and CRUD checks.
- Needed change: Add org-structure criteria: group/HQ, corporations/orgs, departments/teams, employees, roles/positions, reporting lines, worksites/사업장 cells, and cross-org assignments as editable CRUD objects.
- Needed change: Add site/cell ruleset criteria: optional local policies, operational quirks, payroll rulesets, inherited defaults, higher-scope overrides, and import/export as secondary output only.
- Needed change: Add operational workflow criteria: policy-scoped CRUD/actions across group/org/site cells, cross-org assignment context, approval eligibility, and E2E browser evidence.

### t_a37568df — Confirm live deployment and baseline access
- Status/assignee/priority: `running` / `default` / `0`
- Categories: CEDAR_PBAC_AUTHZ, OPS_WORKFLOW_AUTHZ
- Needed change: Add Cedar/PBAC migration criteria: default-deny, group/org/site hierarchy, cross-org worker grants, higher-scope policy precedence, conflict detection, audit/revocation, and CRUD checks.
- Needed change: Add operational workflow criteria: policy-scoped CRUD/actions across group/org/site cells, cross-org assignment context, approval eligibility, and E2E browser evidence.

### t_ccc11e52 — Define org editor primitives and setup UX flows
- Status/assignee/priority: `running` / `default` / `0`
- Categories: CEDAR_PBAC_AUTHZ, ORG_EMPLOYEE_STRUCTURE, CELL_POLICY_PAYROLL_RULESETS
- Needed change: Add Cedar/PBAC migration criteria: default-deny, group/org/site hierarchy, cross-org worker grants, higher-scope policy precedence, conflict detection, audit/revocation, and CRUD checks.
- Needed change: Add org-structure criteria: group/HQ, corporations/orgs, departments/teams, employees, roles/positions, reporting lines, worksites/사업장 cells, and cross-org assignments as editable CRUD objects.
- Needed change: Add site/cell ruleset criteria: optional local policies, operational quirks, payroll rulesets, inherited defaults, higher-scope overrides, and import/export as secondary output only.

### t_d02b7abb — Reconcile active-PR guard for operations UI review/merge/E2E lane
- Status/assignee/priority: `ready` / `default` / `97`
- Categories: ORG_EMPLOYEE_STRUCTURE, OPS_WORKFLOW_AUTHZ
- Needed change: Add org-structure criteria: group/HQ, corporations/orgs, departments/teams, employees, roles/positions, reporting lines, worksites/사업장 cells, and cross-org assignments as editable CRUD objects.
- Needed change: Add operational workflow criteria: policy-scoped CRUD/actions across group/org/site cells, cross-org assignment context, approval eligibility, and E2E browser evidence.

### t_cc623b69 — Review/fix: ADR-0002 DB-backed append-only/atomicity CI proof
- Status/assignee/priority: `ready` / `default` / `81`
- Categories: OPS_WORKFLOW_AUTHZ
- Needed change: Add operational workflow criteria: policy-scoped CRUD/actions across group/org/site cells, cross-org assignment context, approval eligibility, and E2E browser evidence.

### t_cc292bc9 — Atomic PR: group management LSO slug and compact company actions
- Status/assignee/priority: `ready` / `default` / `0`
- Categories: ORG_EMPLOYEE_STRUCTURE
- Needed change: Add org-structure criteria: group/HQ, corporations/orgs, departments/teams, employees, roles/positions, reporting lines, worksites/사업장 cells, and cross-org assignments as editable CRUD objects.

### t_1e0e137b — Native KNL console read-only realtime Kanban mirror via local helper
- Status/assignee/priority: `todo` / `default` / `98`
- Categories: ORG_EMPLOYEE_STRUCTURE
- Needed change: Add org-structure criteria: group/HQ, corporations/orgs, departments/teams, employees, roles/positions, reporting lines, worksites/사업장 cells, and cross-org assignments as editable CRUD objects.

### t_c5a221ab — Review/fix: board cleanup detritus retirement verification [t_87cbefe5]
- Status/assignee/priority: `todo` / `None` / `98`
- Categories: CEDAR_PBAC_AUTHZ, OPS_WORKFLOW_AUTHZ
- Needed change: Add Cedar/PBAC migration criteria: default-deny, group/org/site hierarchy, cross-org worker grants, higher-scope policy precedence, conflict detection, audit/revocation, and CRUD checks.
- Needed change: Add operational workflow criteria: policy-scoped CRUD/actions across group/org/site cells, cross-org assignment context, approval eligibility, and E2E browser evidence.

### t_5cdfbc12 — Resolution: recover worker protocol/provider failures
- Status/assignee/priority: `todo` / `default` / `97`
- Categories: CEDAR_PBAC_AUTHZ, ORG_EMPLOYEE_STRUCTURE
- Needed change: Add Cedar/PBAC migration criteria: default-deny, group/org/site hierarchy, cross-org worker grants, higher-scope policy precedence, conflict detection, audit/revocation, and CRUD checks.
- Needed change: Add org-structure criteria: group/HQ, corporations/orgs, departments/teams, employees, roles/positions, reporting lines, worksites/사업장 cells, and cross-org assignments as editable CRUD objects.

### t_7e7a01e7 — NORTHSTAR-NOCODE-ORG-OPS-EDITOR-20260701: no-code editor for company employees org structure and operations logic
- Status/assignee/priority: `todo` / `None` / `97`
- Categories: CEDAR_PBAC_AUTHZ, ORG_EMPLOYEE_STRUCTURE, CELL_POLICY_PAYROLL_RULESETS, OPS_WORKFLOW_AUTHZ
- Needed change: Add Cedar/PBAC migration criteria: default-deny, group/org/site hierarchy, cross-org worker grants, higher-scope policy precedence, conflict detection, audit/revocation, and CRUD checks.
- Needed change: Add org-structure criteria: group/HQ, corporations/orgs, departments/teams, employees, roles/positions, reporting lines, worksites/사업장 cells, and cross-org assignments as editable CRUD objects.
- Needed change: Add site/cell ruleset criteria: optional local policies, operational quirks, payroll rulesets, inherited defaults, higher-scope overrides, and import/export as secondary output only.
- Needed change: Add operational workflow criteria: policy-scoped CRUD/actions across group/org/site cells, cross-org assignment context, approval eligibility, and E2E browser evidence.

### t_c45f6ab0 — Resolution: classify passive/untyped blocked maintenance cards
- Status/assignee/priority: `todo` / `default` / `96`
- Categories: CEDAR_PBAC_AUTHZ, OPS_WORKFLOW_AUTHZ
- Needed change: Add Cedar/PBAC migration criteria: default-deny, group/org/site hierarchy, cross-org worker grants, higher-scope policy precedence, conflict detection, audit/revocation, and CRUD checks.
- Needed change: Add operational workflow criteria: policy-scoped CRUD/actions across group/org/site cells, cross-org assignment context, approval eligibility, and E2E browser evidence.

### t_761bb793 — Resolution: fix closed-loop stewardship regression and ready-work stall
- Status/assignee/priority: `todo` / `default` / `95`
- Categories: CELL_POLICY_PAYROLL_RULESETS
- Needed change: Add site/cell ruleset criteria: optional local policies, operational quirks, payroll rulesets, inherited defaults, higher-scope overrides, and import/export as secondary output only.

### t_f0bfa148 — Review/fix: HR read-path indexes PR #129
- Status/assignee/priority: `todo` / `default` / `95`
- Categories: ORG_EMPLOYEE_STRUCTURE, CELL_POLICY_PAYROLL_RULESETS
- Needed change: Add org-structure criteria: group/HQ, corporations/orgs, departments/teams, employees, roles/positions, reporting lines, worksites/사업장 cells, and cross-org assignments as editable CRUD objects.
- Needed change: Add site/cell ruleset criteria: optional local policies, operational quirks, payroll rulesets, inherited defaults, higher-scope overrides, and import/export as secondary output only.

### t_1ac74db1 — Review/fix: active_pr guard live-state routing RED/spec [t_2359c04a]
- Status/assignee/priority: `todo` / `None` / `94`
- Categories: CEDAR_PBAC_AUTHZ
- Needed change: Add Cedar/PBAC migration criteria: default-deny, group/org/site hierarchy, cross-org worker grants, higher-scope policy precedence, conflict detection, audit/revocation, and CRUD checks.

### t_2359c04a — RED test/repro: active_pr guard live-PR-state routing [t_761bb793]
- Status/assignee/priority: `todo` / `None` / `94`
- Categories: CEDAR_PBAC_AUTHZ, OPS_WORKFLOW_AUTHZ
- Needed change: Add Cedar/PBAC migration criteria: default-deny, group/org/site hierarchy, cross-org worker grants, higher-scope policy precedence, conflict detection, audit/revocation, and CRUD checks.
- Needed change: Add operational workflow criteria: policy-scoped CRUD/actions across group/org/site cells, cross-org assignment context, approval eligibility, and E2E browser evidence.

### t_7a81e59f — Workflow Studio split: typed graph domain schema slice
- Status/assignee/priority: `todo` / `default` / `92`
- Categories: NO_CODE_ORG_EDITOR_FOUNDATION, CEDAR_PBAC_AUTHZ, ORG_EMPLOYEE_STRUCTURE, CELL_POLICY_PAYROLL_RULESETS
- Needed change: Reframe as/no-block behind the maintenance no-code org/operations editor. Avoid a generic n8n clone; model company/org/employee/site/cell objects, inherited policy/ruleset logic, simulation, and Cedar/PBAC hooks.
- Needed change: Add Cedar/PBAC migration criteria: default-deny, group/org/site hierarchy, cross-org worker grants, higher-scope policy precedence, conflict detection, audit/revocation, and CRUD checks.
- Needed change: Add org-structure criteria: group/HQ, corporations/orgs, departments/teams, employees, roles/positions, reporting lines, worksites/사업장 cells, and cross-org assignments as editable CRUD objects.
- Needed change: Add site/cell ruleset criteria: optional local policies, operational quirks, payroll rulesets, inherited defaults, higher-scope overrides, and import/export as secondary output only.

### t_80b2928a — Workflow Studio split: connector registry and fail-closed validation slice
- Status/assignee/priority: `todo` / `default` / `91`
- Categories: NO_CODE_ORG_EDITOR_FOUNDATION, OPS_WORKFLOW_AUTHZ
- Needed change: Reframe as/no-block behind the maintenance no-code org/operations editor. Avoid a generic n8n clone; model company/org/employee/site/cell objects, inherited policy/ruleset logic, simulation, and Cedar/PBAC hooks.
- Needed change: Add operational workflow criteria: policy-scoped CRUD/actions across group/org/site cells, cross-org assignment context, approval eligibility, and E2E browser evidence.

### t_b419d0b7 — Workflow Studio foundation: typed graph IR and connector registry
- Status/assignee/priority: `todo` / `default` / `91`
- Categories: NO_CODE_ORG_EDITOR_FOUNDATION, CEDAR_PBAC_AUTHZ, ORG_EMPLOYEE_STRUCTURE, CELL_POLICY_PAYROLL_RULESETS, OPS_WORKFLOW_AUTHZ
- Needed change: Reframe as/no-block behind the maintenance no-code org/operations editor. Avoid a generic n8n clone; model company/org/employee/site/cell objects, inherited policy/ruleset logic, simulation, and Cedar/PBAC hooks.
- Needed change: Add Cedar/PBAC migration criteria: default-deny, group/org/site hierarchy, cross-org worker grants, higher-scope policy precedence, conflict detection, audit/revocation, and CRUD checks.
- Needed change: Add org-structure criteria: group/HQ, corporations/orgs, departments/teams, employees, roles/positions, reporting lines, worksites/사업장 cells, and cross-org assignments as editable CRUD objects.
- Needed change: Add site/cell ruleset criteria: optional local policies, operational quirks, payroll rulesets, inherited defaults, higher-scope overrides, and import/export as secondary output only.
- Needed change: Add operational workflow criteria: policy-scoped CRUD/actions across group/org/site cells, cross-org assignment context, approval eligibility, and E2E browser evidence.

### t_b6cda382 — Decompose: Workflow Studio typed graph IR and connector registry recovery
- Status/assignee/priority: `todo` / `default` / `91`
- Categories: NO_CODE_ORG_EDITOR_FOUNDATION, CEDAR_PBAC_AUTHZ, ORG_EMPLOYEE_STRUCTURE, CELL_POLICY_PAYROLL_RULESETS
- Needed change: Reframe as/no-block behind the maintenance no-code org/operations editor. Avoid a generic n8n clone; model company/org/employee/site/cell objects, inherited policy/ruleset logic, simulation, and Cedar/PBAC hooks.
- Needed change: Add Cedar/PBAC migration criteria: default-deny, group/org/site hierarchy, cross-org worker grants, higher-scope policy precedence, conflict detection, audit/revocation, and CRUD checks.
- Needed change: Add org-structure criteria: group/HQ, corporations/orgs, departments/teams, employees, roles/positions, reporting lines, worksites/사업장 cells, and cross-org assignments as editable CRUD objects.
- Needed change: Add site/cell ruleset criteria: optional local policies, operational quirks, payroll rulesets, inherited defaults, higher-scope overrides, and import/export as secondary output only.

### t_1e936ff1 — Workflow Studio foundation: runtime executor and executable nodes
- Status/assignee/priority: `todo` / `default` / `90`
- Categories: NO_CODE_ORG_EDITOR_FOUNDATION, CEDAR_PBAC_AUTHZ, ORG_EMPLOYEE_STRUCTURE, CELL_POLICY_PAYROLL_RULESETS, OPS_WORKFLOW_AUTHZ
- Needed change: Reframe as/no-block behind the maintenance no-code org/operations editor. Avoid a generic n8n clone; model company/org/employee/site/cell objects, inherited policy/ruleset logic, simulation, and Cedar/PBAC hooks.
- Needed change: Add Cedar/PBAC migration criteria: default-deny, group/org/site hierarchy, cross-org worker grants, higher-scope policy precedence, conflict detection, audit/revocation, and CRUD checks.
- Needed change: Add org-structure criteria: group/HQ, corporations/orgs, departments/teams, employees, roles/positions, reporting lines, worksites/사업장 cells, and cross-org assignments as editable CRUD objects.
- Needed change: Add site/cell ruleset criteria: optional local policies, operational quirks, payroll rulesets, inherited defaults, higher-scope overrides, and import/export as secondary output only.
- Needed change: Add operational workflow criteria: policy-scoped CRUD/actions across group/org/site cells, cross-org assignment context, approval eligibility, and E2E browser evidence.

### t_99d84747 — Workflow Studio split: OpenAPI contract and readiness integrator slice
- Status/assignee/priority: `todo` / `default` / `90`
- Categories: NO_CODE_ORG_EDITOR_FOUNDATION, ORG_EMPLOYEE_STRUCTURE
- Needed change: Reframe as/no-block behind the maintenance no-code org/operations editor. Avoid a generic n8n clone; model company/org/employee/site/cell objects, inherited policy/ruleset logic, simulation, and Cedar/PBAC hooks.
- Needed change: Add org-structure criteria: group/HQ, corporations/orgs, departments/teams, employees, roles/positions, reporting lines, worksites/사업장 cells, and cross-org assignments as editable CRUD objects.

### t_c90824e2 — Workflow template: annual-leave promotion active labor-refusal duty flag
- Status/assignee/priority: `todo` / `default` / `90`
- Categories: NO_CODE_ORG_EDITOR_FOUNDATION, CEDAR_PBAC_AUTHZ, ORG_EMPLOYEE_STRUCTURE, CELL_POLICY_PAYROLL_RULESETS
- Needed change: Reframe as/no-block behind the maintenance no-code org/operations editor. Avoid a generic n8n clone; model company/org/employee/site/cell objects, inherited policy/ruleset logic, simulation, and Cedar/PBAC hooks.
- Needed change: Add Cedar/PBAC migration criteria: default-deny, group/org/site hierarchy, cross-org worker grants, higher-scope policy precedence, conflict detection, audit/revocation, and CRUD checks.
- Needed change: Add org-structure criteria: group/HQ, corporations/orgs, departments/teams, employees, roles/positions, reporting lines, worksites/사업장 cells, and cross-org assignments as editable CRUD objects.
- Needed change: Add site/cell ruleset criteria: optional local policies, operational quirks, payroll rulesets, inherited defaults, higher-scope overrides, and import/export as secondary output only.

### t_f873770a — Performance: durable HR/직원명부 read-path indexes
- Status/assignee/priority: `todo` / `default` / `90`
- Categories: ORG_EMPLOYEE_STRUCTURE, CELL_POLICY_PAYROLL_RULESETS
- Needed change: Add org-structure criteria: group/HQ, corporations/orgs, departments/teams, employees, roles/positions, reporting lines, worksites/사업장 cells, and cross-org assignments as editable CRUD objects.
- Needed change: Add site/cell ruleset criteria: optional local policies, operational quirks, payroll rulesets, inherited defaults, higher-scope overrides, and import/export as secondary output only.

## Cards that should remain process-only / no product-direction change

- t_272f55e0 `running` — MAINTENANCE-HELD-FANOUT-GATE-001: hold non-cron scheduled cards behind path/conflict review
- t_7e2c6d36 `todo` — [Dogfood] Fix e2e seed-exec financial_purchase_requests schema drift
- t_c0960108 `todo` — Review/fix gate: dirty-root dogfood auth/e2e blocked tasks
- t_4f6c3a52 `running` — Review/fix: ADR-0002/0014 audit-exemption cardinality fix
- t_32021299 `todo` — Review/fix: ADR-0002 global audit gate hardening
- t_f698526d `todo` — why are todos and blocked tasks not ready? autonomously resolve the blockers and get the development back on track
- t_59278687 `todo` — Fix workflow and metadata readiness issues
- t_2fa7cfd2 `todo` — Publish recovery plan to get development back on track
- t_8c62e216 `todo` — .com/onboarding
패스키 등록
첫 로그인 설정을 완료하려면 필수 개인정보 수집•이용 및 서비스 약관 동의 후 패스키를 등록하세요.
이 기기
Touch ID:Windows Hello 등 이 기기의 생체 인증으로 등록합니다.
원유 휴대폰으로 등
- t_62ce3055 `todo` — Validate QR passkey fix end to end
- t_666cb84c `ready` — Review/fix: QR passkey regression coverage [t_372af557]
- t_bef6383f `todo` — Containment hold: retired placeholder wt-root fixture tasks
- t_46c8e3d8 `running` — Preserve blocked wt-root containment anchor
- t_61c6f330 `todo` — notification is not mature enough. the unread number still appears after reading messages, notification should be scrollable cards that actu
- t_37cc3a25 `todo` — Fix unread count clearing after messages are read
- t_c7f489c9 `todo` — Implement scrollable clickable notification cards
- t_969485da `todo` — messenger ui ux needs improvement. benchmark off slack
- t_a2c80c60 `todo` — Design the improved messenger interface

## Recommended next Kanban changes

1. Gate generic Workflow Studio implementation behind the no-code org/ops editor plan (`t_7e7a01e7`) so it becomes the editor substrate for company/org/employee/site/cell logic rather than a disconnected workflow canvas.
2. Add Cedar/PBAC acceptance criteria to authz/security cards, especially current BranchScope/review and wallboard/auth boundary work, preserving default-deny while planning migration away from hard-coded roles/branches.
3. Add group/org/site/cross-org worker semantics to HR/employee/company/group management cards before treating CRUD UI as complete.
4. Add site/cell-specific policy/payroll ruleset and higher-scope policy precedence to policy docs, daily-status/reporting, Excel/export, annual-leave, and approval/workflow cards.
5. Keep import/export lanes secondary and dependency-gated behind DB-backed CRUD/editor workflows.
