#!/usr/bin/env python3
"""Generate first-party BUCK files for the backend workspace crates.

reindeer generates the third-party graph; this emits one BUCK per workspace
member (rust_library / rust_binary + rust_test targets) from its Cargo.toml.
Cargo stays the source of truth — re-run after adding/moving crates, deps, or
tests. First-party sources are materialized at repository-relative paths inside
each Buck action so compile-time include paths retain the same topology as the
checkout without source-tree symlinks or copied fixtures.

Dependency mapping:
  - a dep whose (renamed) crate is another workspace member  -> //<dir>:<name>
  - sqlx 0.8 (renamed apalis-sqlx, pinned for apalis)        -> //third-party/rust:sqlx-0_8
  - any other dep                                            -> //third-party/rust:<crate>

Test targets:
  - <name>-unit            : inline #[cfg(test)] tests (recompiles the lib srcs
                             with --test; needs [dev-dependencies] too).
  - <name>-itest-<stem>    : one per tests/*.rs integration file (depends on the
                             library + dev-deps; non-test helper files in tests/
                             are added to srcs so `mod common;` resolves).
  - Every generated rust_test has exactly one test-type label
    (test.unit or test.integration) and exactly one resource label
    (resource.none or resource.postgres). Postgres tests retain the legacy
    needs-postgres label while runners migrate to resource.postgres.
  - owner.* and domain.* labels are derived from package paths, never a central
    hand-maintained exception table.
"""
import os
import sys
import tomllib

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MEMBER_ROOTS = ["backend/app", "backend/crates", "backend/ci"]

MIGRATION_TREE = {
    "//backend/crates/platform/db/migrations:tree":
        "backend/crates/platform/db/migrations",
}

OPENAPI_DRIFT_SOURCE_PACKAGES = [
    "backend/crates/attendance/rest",
    "backend/crates/inventory/rest",
    "backend/crates/dispatch/rest",
    "backend/crates/benefit/rest",
    "backend/crates/financial/rest",
    "backend/crates/inspection/rest",
    "backend/crates/support/rest",
    "backend/crates/identity/rest",
    "backend/crates/compliance/rest",
    "backend/crates/compliance/integrity",
    "backend/crates/registry/rest",
    "backend/crates/sales/rest",
    "backend/crates/reporting/rest",
    "backend/crates/workorder/rest",
    "backend/crates/messenger/rest",
    "backend/crates/comms/rest",
    "backend/crates/platform/platform-rest",
    "backend/crates/platform/auth-rest",
    "backend/crates/platform/realtime",
    "backend/crates/ontology/rest",
    "backend/crates/governance/rest",
    "backend/crates/platform/authz-rest",
    "backend/crates/docs/rest",
    "backend/crates/notices/rest",
    "backend/crates/finance-gl/rest",
    "backend/crates/payroll/rest",
    "backend/crates/analytics-quant/rest",
    "backend/crates/equipment/rest",
]


def source_tree_label(package):
    return "//{}:crate-source-tree".format(package)


OPENAPI_DRIFT_EXTERNAL = {
    source_tree_label(package): package + "/src"
    for package in OPENAPI_DRIFT_SOURCE_PACKAGES
}
OPENAPI_DRIFT_EXTERNAL["//backend/openapi:openapi.yaml"] = (
    "backend/openapi/openapi.yaml"
)

# Compile-time and runtime fixture inputs outside a crate package. Labels expose
# the authoritative bytes; mapped destinations preserve the checkout topology.
RESOURCE_CONFIG = {
    "mnt-app": {
        "external": {
            "//backend/openapi:openapi.yaml": "backend/openapi/openapi.yaml",
            **MIGRATION_TREE,
        },
        "itests": {
            "tests/openapi_drift.rs": {
                "srcs": ["src/**/*.rs"],
                "external": OPENAPI_DRIFT_EXTERNAL,
            },
            "tests/dev_seed_notification_links.rs": {
                "external": {
                    "//scripts:dev-seed.sql": "scripts/dev-seed.sql",
                },
            },
            "tests/openslo_files.rs": {
                "srcs": ["slos/**"],
            },
        },
    },
    "mnt-platform-authz": {
        "external": {
            "//docs/specs:cedar-pbac-map":
                "docs/specs/cedar-pbac-coexistence-map.json",
        },
        "itest_srcs": ["tests/fixtures/**"],
    },
    "mnt-reporting-adapter-postgres": {
        "external": {
            "//docs/reference:daily-progress":
                "docs/reference/일일업무진행현황_0605.xlsx",
            "//docs/reference:work-log":
                "docs/reference/업무일지_26.05.27.xlsx",
        },
    },
    "mnt-platform-excel": {
        "itest_external": {
            "//docs/reference:daily-progress":
                "docs/reference/일일업무진행현황_0605.xlsx",
            "//docs/reference:work-log":
                "docs/reference/업무일지_26.05.27.xlsx",
        },
    },
    "mnt-registry-adapter-postgres": {
        "itest_external": {
            "//docs/reference:master-list":
                "docs/reference/master-list_251120.xlsx",
        },
    },
    "mnt-registry-rest": {
        "itest_external": {
            "//docs/reference:master-list":
                "docs/reference/master-list_251120.xlsx",
        },
    },
}

SQLX_MACRO_MARKERS = ("query!", "query_as!", "query_scalar!")
TEST_MARKERS = ("#[test]", "#[tokio::test", "#[sqlx::test", "#[rstest")

# Resource scheduling is target metadata, not source-text inference. Test type
# comes from the generated target shape (inline tests are unit; tests/*.rs are
# integration); PostgreSQL is an explicit reviewable execution requirement.
# Keep this table in the generator so adding a live database dependency changes
# the generated face in the same reviewed diff. Every generated target is
# enumerated explicitly; missing or stale metadata fails generation.
TEST_RESOURCE_REQUIREMENTS = {
    'mnt-app': {
        'unit': 'none',
        'integration': {
            'tests/action_inbox_api.rs': 'postgres',
            'tests/audit_api.rs': 'postgres',
            'tests/auth_rest.rs': 'postgres',
            'tests/benefit_catalog_api.rs': 'postgres',
            'tests/cedar_freshness_mint.rs': 'postgres',
            'tests/cedar_parity_shadow.rs': 'postgres',
            'tests/cedar_shadow_role_manage.rs': 'postgres',
            'tests/compliance_api.rs': 'postgres',
            'tests/compliance_catalog_api.rs': 'postgres',
            'tests/config.rs': 'none',
            'tests/console_kill_switch.rs': 'postgres',
            'tests/console_route_telemetry.rs': 'postgres',
            'tests/consulting_engagement_api.rs': 'postgres',
            'tests/dev_auth_persona_guard.rs': 'postgres',
            'tests/dev_auth_persona_guard_feature.rs': 'postgres',
            'tests/dev_seed_notification_links.rs': 'none',
            'tests/dispatch_pipeline_api.rs': 'postgres',
            'tests/equipment_3r_api.rs': 'postgres',
            'tests/facilities_pilot_story.rs': 'postgres',
            'tests/finance_gl_voucher_sod.rs': 'postgres',
            'tests/health_readiness.rs': 'postgres',
            'tests/hr_attendance_manager_scope.rs': 'postgres',
            'tests/hr_attendance_self_read.rs': 'postgres',
            'tests/hr_ingest_checklist_gate.rs': 'postgres',
            'tests/hr_people_create_api.rs': 'postgres',
            'tests/logistics_pilot_story.rs': 'postgres',
            'tests/m2_real_engine_drive.rs': 'postgres',
            'tests/mobile_api.rs': 'postgres',
            'tests/notifications_api.rs': 'postgres',
            'tests/object_graph_api.rs': 'postgres',
            'tests/object_links_api.rs': 'postgres',
            'tests/object_ontology_api.rs': 'postgres',
            'tests/object_resolve_api.rs': 'postgres',
            'tests/office_versions.rs': 'postgres',
            'tests/openapi_drift.rs': 'none',
            'tests/openslo_files.rs': 'none',
            'tests/platform_onboarding_e2e.rs': 'postgres',
            'tests/purchase_request_collection_api.rs': 'postgres',
            'tests/realtime_ws.rs': 'postgres',
            'tests/registry_api.rs': 'postgres',
            'tests/router_layers.rs': 'postgres',
            'tests/search_api.rs': 'postgres',
            'tests/submittable_definitions_api.rs': 'postgres',
            'tests/tenant_context_e2e.rs': 'postgres',
            'tests/well_known.rs': 'none',
            'tests/workbench_api.rs': 'none',
            'tests/workbench_native_api.rs': 'postgres',
            'tests/workflow_automation_triggers.rs': 'postgres',
            'tests/workflow_dynamics_branch.rs': 'postgres',
            'tests/workflow_four_eyes_publish.rs': 'postgres',
            'tests/workflow_object_context_api.rs': 'postgres',
            'tests/workflow_object_kind_dynamics.rs': 'postgres',
            'tests/workflow_run_read_surface.rs': 'postgres',
            'tests/workflow_runtime_finalize_api.rs': 'postgres',
            'tests/workflow_runtime_instance_api.rs': 'postgres',
            'tests/workorder_api.rs': 'postgres',
        },
    },
    'mnt-attendance-adapter-postgres': {
        'unit': 'none',
        'integration': {
            'tests/cancel_substitution.rs': 'postgres',
            'tests/concurrency.rs': 'postgres',
            'tests/self_service.rs': 'postgres',
        },
    },
    'mnt-attendance-application': {
        'unit': 'none',
        'integration': {
            'tests/attendance_policy.rs': 'none',
        },
    },
    'mnt-attendance-domain': {
        'unit': 'none',
        'integration': {
            'tests/range_and_history.rs': 'none',
        },
    },
    'mnt-attendance-rest': {
        'unit': 'none',
    },
    'mnt-equipment-domain': {
        'unit': 'none',
    },
    'mnt-gate-audit-coverage': {
        'integration': {
            'tests/gate_detects_violation.rs': 'postgres',
        },
    },
    'mnt-gate-dev-auth-absence': {
        'unit': 'none',
    },
    'mnt-gate-iac-tier': {
        'unit': 'none',
    },
    'mnt-gate-layer-boundary': {
        'unit': 'none',
        'integration': {
            'tests/gate_detects_violation.rs': 'none',
        },
    },
    'mnt-gate-migration-safety': {
        'integration': {
            'tests/gate_detects_violation.rs': 'none',
        },
    },
    'mnt-gate-pii-no-logs': {
        'integration': {
            'tests/gate_detects_violation.rs': 'none',
        },
    },
    'mnt-gate-rls-arming': {
        'unit': 'postgres',
    },
    'mnt-gate-tenant-isolation': {
        'unit': 'postgres',
        'integration': {
            'tests/owner_only_acl_postgres18.rs': 'postgres',
        },
    },
    'mnt-gate-vendor-lockin': {
        'unit': 'none',
        'integration': {
            'tests/gate_detects_violation.rs': 'none',
        },
    },
    'mnt-action-inbox-application': {
        'unit': 'none',
    },
    'mnt-analytics-quant-service': {
        'unit': 'none',
    },
    'mnt-benefit-adapter-postgres': {
        'integration': {
            'tests/catalog_rls_surfaces_as_runtime_role.rs': 'postgres',
        },
    },
    'mnt-benefit-application': {
        'unit': 'none',
    },
    'mnt-benefit-domain': {
        'unit': 'none',
    },
    'mnt-benefit-rest': {
        'unit': 'none',
    },
    'mnt-comms-adapter-imap': {
        'unit': 'none',
    },
    'mnt-comms-adapter-mox': {
        'unit': 'none',
    },
    'mnt-comms-adapter-postgres': {
        'integration': {
            'tests/mail_account_rls_surfaces_as_runtime_role.rs': 'postgres',
            'tests/mail_sync_rls_surfaces_as_runtime_role.rs': 'postgres',
            'tests/send_rate_limit_rls_surfaces_as_runtime_role.rs': 'postgres',
        },
    },
    'mnt-comms-adapter-smtp': {
        'unit': 'none',
    },
    'mnt-comms-application': {
        'unit': 'none',
    },
    'mnt-comms-credential-cipher': {
        'unit': 'none',
    },
    'mnt-comms-domain': {
        'unit': 'none',
    },
    'mnt-comms-mailbox': {
        'unit': 'none',
    },
    'mnt-comms-rest': {
        'unit': 'none',
        'integration': {
            'tests/mox_webhook.rs': 'postgres',
            'tests/readiness.rs': 'postgres',
        },
    },
    'mnt-compliance-adapter-postgres': {
        'integration': {
            'tests/location_consent_status_rls_as_runtime_role.rs': 'postgres',
            'tests/location_store.rs': 'postgres',
        },
    },
    'mnt-compliance-domain': {
        'unit': 'none',
        'integration': {
            'tests/location_consent_fsm.rs': 'none',
            'tests/location_ping_policy.rs': 'none',
        },
    },
    'mnt-integrity': {
        'unit': 'none',
    },
    'mnt-compliance-rest': {
        'unit': 'none',
    },
    'mnt-consulting-rest': {
        'unit': 'none',
        'integration': {
            'tests/audit_atomicity.rs': 'postgres',
        },
    },
    'mnt-dispatch-application': {
        'unit': 'none',
    },
    'mnt-dispatch-adapter-postgres': {
        'integration': {
            'tests/p1_dispatch.rs': 'postgres',
        },
    },
    'mnt-dispatch-domain': {
        'unit': 'none',
    },
    'mnt-dispatch-rest': {
        'unit': 'none',
    },
    'mnt-dispatch-worker': {
        'integration': {
            'tests/timer_delivery.rs': 'postgres',
        },
    },
    'mnt-docs-adapter-postgres': {
        'unit': 'none',
    },
    'mnt-docs-application': {
        'unit': 'none',
    },
    'mnt-docs-domain': {
        'unit': 'none',
    },
    'mnt-docs-rest': {
        'unit': 'none',
        'integration': {
            'tests/evidence_rest_rls_surfaces_as_runtime_role.rs': 'postgres',
        },
    },
    'mnt-erp-domain': {
        'unit': 'none',
    },
    'mnt-facilities-rest': {
        'unit': 'none',
    },
    'mnt-finance-gl-adapter-postgres': {
        'integration': {
            'tests/voucher_rls_and_fsm_as_runtime_role.rs': 'postgres',
        },
    },
    'mnt-finance-gl-domain': {
        'unit': 'none',
    },
    'mnt-financial-adapter-postgres': {
        'integration': {
            'tests/lifecycle_rls_surfaces_as_runtime_role.rs': 'postgres',
            'tests/period_lock_blocks_ledger_as_runtime_role.rs': 'postgres',
            'tests/use_cases.rs': 'postgres',
        },
    },
    'mnt-financial-domain': {
        'unit': 'none',
        'integration': {
            'tests/quote_and_residual.rs': 'none',
        },
    },
    'mnt-financial-rest': {
        'unit': 'none',
        'integration': {
            'tests/purchase_request_list.rs': 'postgres',
        },
    },
    'mnt-governance-adapter-postgres': {
        'integration': {
            'tests/approvals_create_as_runtime_role.rs': 'postgres',
            'tests/four_eyes_bind_consume.rs': 'postgres',
            'tests/governance_rls_as_runtime_role.rs': 'postgres',
        },
    },
    'mnt-governance-domain': {
        'unit': 'none',
    },
    'mnt-identity-adapter-postgres': {
        'integration': {
            'tests/deactivate_revokes_credentials.rs': 'postgres',
            'tests/me_workspace_layouts_rls.rs': 'postgres',
            'tests/region_branch_crud_rls_surfaces_as_runtime_role.rs': 'postgres',
            'tests/subject_authz_versions_freshness_rls.rs': 'postgres',
        },
    },
    'mnt-identity-application': {
        'unit': 'none',
    },
    'mnt-identity-domain': {
        'unit': 'none',
    },
    'mnt-identity-rest': {
        'unit': 'postgres',
        'integration': {
            'tests/org_setup.rs': 'postgres',
        },
    },
    'mnt-inbox-adapter-postgres': {
        'integration': {
            'tests/inbox_docs_rls_surfaces_as_runtime_role.rs': 'postgres',
        },
    },
    'mnt-inbox-application': {
        'unit': 'none',
    },
    'mnt-inbox-domain': {
        'unit': 'none',
    },
    'mnt-inbox-rest': {
        'integration': {
            'tests/api.rs': 'postgres',
        },
    },
    'mnt-inventory-adapter-postgres': {
        'unit': 'none',
        'integration': {
            'tests/consume_idempotency_concurrency.rs': 'postgres',
        },
    },
    'mnt-inventory-rest': {
        'unit': 'none',
    },
    'mnt-inspection-adapter-postgres': {
        'integration': {
            'tests/lifecycle.rs': 'postgres',
            'tests/schedule_window_rls_surfaces_as_runtime_role.rs': 'postgres',
        },
    },
    'mnt-inventory-domain': {
        'unit': 'none',
    },
    'mnt-kernel-core': {
        'unit': 'none',
    },
    'mnt-leave-adapter-postgres': {
        'unit': 'none',
        'integration': {
            'tests/leave_migration_expand_contract.rs': 'postgres',
            'tests/leave_rls_surfaces_as_runtime_role.rs': 'postgres',
        },
    },
    'mnt-leave-domain': {
        'unit': 'none',
    },
    'mnt-leave-rest': {
        'unit': 'none',
        'integration': {
            'tests/leave_http_personas.rs': 'postgres',
        },
    },
    'mnt-logistics-domain': {
        'unit': 'none',
    },
    'mnt-messenger-adapter-postgres': {
        'integration': {
            'tests/parity_tables_rls_as_runtime_role.rs': 'postgres',
            'tests/use_cases.rs': 'postgres',
        },
    },
    'mnt-messenger-application': {
        'unit': 'none',
    },
    'mnt-messenger-domain': {
        'integration': {
            'tests/mentions.rs': 'none',
            'tests/object_code_refs.rs': 'none',
            'tests/parity.rs': 'none',
            'tests/thread_kind.rs': 'none',
        },
    },
    'mnt-messenger-rest': {
        'integration': {
            'tests/api.rs': 'postgres',
        },
    },
    'mnt-notices-adapter-postgres': {
        'integration': {
            'tests/notices_rls_surfaces_as_runtime_role.rs': 'postgres',
        },
    },
    'mnt-notices-domain': {
        'unit': 'none',
    },
    'mnt-notices-rest': {
        'integration': {
            'tests/api.rs': 'postgres',
        },
    },
    'mnt-notifications-adapter-postgres': {
        'integration': {
            'tests/notifications_rls_surfaces_as_runtime_role.rs': 'postgres',
        },
    },
    'mnt-notifications-domain': {
        'unit': 'none',
    },
    'mnt-notifications-rest': {
        'integration': {
            'tests/api.rs': 'postgres',
        },
    },
    'mnt-ontology-adapter-postgres': {
        'unit': 'none',
        'integration': {
            'tests/c_chain_as_runtime_role.rs': 'postgres',
            'tests/config_object_types_as_runtime_role.rs': 'postgres',
            'tests/instances_residual_filter_as_runtime_role.rs': 'postgres',
            'tests/instances_rls_surfaces_as_runtime_role.rs': 'postgres',
            'tests/key_revision_migration_upgrade.rs': 'postgres',
            'tests/key_write_cas_as_runtime_role.rs': 'postgres',
            'tests/niche_config_object_types_as_runtime_role.rs': 'postgres',
            'tests/projected_instances_read_as_runtime_role.rs': 'postgres',
            'tests/registry_rls_surfaces_as_runtime_role.rs': 'postgres',
        },
    },
    'mnt-ontology-application': {
        'unit': 'none',
    },
    'mnt-ontology-domain': {
        'unit': 'none',
    },
    'mnt-ontology-rest': {
        'unit': 'none',
        'integration': {
            'tests/action_execute_as_runtime_role.rs': 'postgres',
            'tests/object_type_cas_as_runtime_role.rs': 'postgres',
            'tests/ont_gaps_as_runtime_role.rs': 'postgres',
            'tests/projected_dispatch_as_runtime_role.rs': 'postgres',
            'tests/publish_auto_create_action_as_runtime_role.rs': 'postgres',
        },
    },
    'mnt-payroll-adapter-postgres': {
        'integration': {
            'tests/payroll_rls_surfaces_as_runtime_role.rs': 'postgres',
        },
    },
    'mnt-payroll-domain': {
        'unit': 'none',
    },
    'mnt-payroll-rest': {
        'unit': 'none',
        'integration': {
            'tests/api.rs': 'postgres',
        },
    },
    'mnt-platform-audit-chain': {
        'unit': 'none',
        'integration': {
            'tests/audit_chain_rls.rs': 'postgres',
        },
    },
    'mnt-platform-auth': {
        'unit': 'none',
        'integration': {
            'tests/jwt_es256.rs': 'none',
            'tests/jwt_verifier.rs': 'none',
            'tests/refresh_tokens.rs': 'postgres',
            'tests/webauthn_ceremony.rs': 'postgres',
            'tests/webauthn_ceremony_replay.rs': 'postgres',
            'tests/well_known.rs': 'none',
        },
    },
    'mnt-platform-auth-rest': {
        'unit': 'postgres',
        'integration': {
            'tests/dev_auth_absence.rs': 'postgres',
            'tests/dev_auth_session.rs': 'postgres',
            'tests/group_admin_tenant_context.rs': 'postgres',
        },
    },
    'mnt-platform-authz': {
        'unit': 'none',
        'integration': {
            'tests/cedar_pbac_legacy_only_observe_and_record.rs': 'none',
            'tests/cedar_pbac_readiness_cases.rs': 'none',
            'tests/policy.rs': 'postgres',
        },
    },
    'mnt-platform-authz-rest': {
        'unit': 'none',
        'integration': {
            'tests/cedar_authoring_rls_as_runtime_role.rs': 'postgres',
            'tests/decision_feed_as_runtime_role.rs': 'postgres',
        },
    },
    'mnt-platform-db': {
        'unit': 'postgres',
        'integration': {
            'tests/attendance_console_migration_contract.rs': 'postgres',
            'tests/code_issuance.rs': 'postgres',
            'tests/group_resolvers.rs': 'postgres',
            'tests/m2_flag_on_runtime_drain.rs': 'postgres',
            'tests/period_locks_and_lifecycle.rs': 'postgres',
            'tests/rls_isolation.rs': 'postgres',
            'tests/rls_rollout_isolation.rs': 'postgres',
        },
    },
    'mnt-platform-email': {
        'unit': 'none',
    },
    'mnt-platform-excel': {
        'integration': {
            'tests/template_fidelity.rs': 'none',
            'tests/template_fill_engine.rs': 'none',
        },
    },
    'mnt-platform-group': {
        'unit': 'postgres',
    },
    'mnt-platform-jobs': {
        'unit': 'postgres',
        'integration': {
            'tests/apalis_adapter.rs': 'postgres',
            'tests/apalis_schema_contract.rs': 'postgres',
        },
    },
    'mnt-platform-rest': {
        'integration': {
            'tests/onboard_seeds_config_objects.rs': 'postgres',
            'tests/ops_dashboard.rs': 'postgres',
            'tests/platform_groups.rs': 'postgres',
            'tests/remove_tenant.rs': 'postgres',
            'tests/view_as.rs': 'postgres',
        },
    },
    'mnt-platform-provisioning': {
        'integration': {
            'tests/bootstrap_passkey.rs': 'postgres',
            'tests/bootstrap_passkey_replay.rs': 'postgres',
            'tests/dev_principal_upsert_race.rs': 'postgres',
            'tests/rls_auth_chain_as_runtime_role.rs': 'postgres',
            'tests/roster_import.rs': 'postgres',
            'tests/self_enroll_handoff_as_runtime_role.rs': 'postgres',
        },
    },
    'mnt-platform-push': {
        'unit': 'none',
    },
    'mnt-platform-realtime': {
        'unit': 'none',
        'integration': {
            'tests/hub.rs': 'none',
            'tests/notify_payload.rs': 'none',
            'tests/postgres_bridge.rs': 'postgres',
        },
    },
    'mnt-platform-request-context': {
        'unit': 'none',
    },
    'mnt-platform-storage': {
        'unit': 'postgres',
        'integration': {
            'tests/evidence_processing_rls_surfaces_as_runtime_role.rs': 'postgres',
            'tests/seaweedfs_worm.rs': 'none',
        },
    },
    'mnt-policy-adapter-postgres': {
        'integration': {
            'tests/draft_storage.rs': 'postgres',
        },
    },
    'mnt-policy-application': {
        'unit': 'none',
    },
    'mnt-policy-domain': {
        'unit': 'none',
    },
    'mnt-production-rest': {
        'unit': 'none',
        'integration': {
            'tests/production_lifecycle_http.rs': 'postgres',
        },
    },
    'mnt-registry-adapter-postgres': {
        'integration': {
            'tests/create_rls_surfaces_as_runtime_role.rs': 'postgres',
            'tests/equipment_list_rls_as_runtime_role.rs': 'postgres',
            'tests/equipment_lookup_normalization_rls_as_runtime_role.rs': 'postgres',
            'tests/equipment_versioning_as_runtime_role.rs': 'postgres',
            'tests/master_list_import.rs': 'postgres',
            'tests/master_list_import_rls_as_runtime_role.rs': 'postgres',
            'tests/site_address_postal_roundtrip_rls_as_runtime_role.rs': 'postgres',
        },
    },
    'mnt-registry-domain': {
        'integration': {
            'tests/equipment.rs': 'none',
        },
    },
    'mnt-registry-rest': {
        'integration': {
            'tests/equipment_admin.rs': 'postgres',
        },
    },
    'mnt-reporting-adapter-postgres': {
        'unit': 'none',
        'integration': {
            'tests/excel_exports.rs': 'postgres',
            'tests/kpi_golden_dataset.rs': 'postgres',
            'tests/ops_summary.rs': 'postgres',
            'tests/work_diary_rls_surfaces_as_runtime_role.rs': 'postgres',
        },
    },
    'mnt-reporting-domain': {
        'unit': 'none',
    },
    'mnt-sales-adapter-postgres': {
        'integration': {
            'tests/inquiry_rls_surfaces_as_runtime_role.rs': 'postgres',
            'tests/sales_store.rs': 'postgres',
        },
    },
    'mnt-sales-domain': {
        'unit': 'none',
    },
    'mnt-support-adapter-postgres': {
        'unit': 'none',
        'integration': {
            'tests/assignee_name_join_rls_surfaces_as_runtime_role.rs': 'postgres',
            'tests/create_internal_ticket_rls_surfaces_as_runtime_role.rs': 'postgres',
            'tests/support_tickets.rs': 'postgres',
        },
    },
    'mnt-support-application': {
        'unit': 'none',
    },
    'mnt-support-domain': {
        'unit': 'none',
    },
    'mnt-support-rest': {
        'unit': 'postgres',
        'integration': {
            'tests/authz.rs': 'postgres',
            'tests/intake.rs': 'postgres',
        },
    },
    'mnt-todos-adapter-postgres': {
        'integration': {
            'tests/todos_rls_surfaces_as_runtime_role.rs': 'postgres',
        },
    },
    'mnt-todos-domain': {
        'unit': 'none',
    },
    'mnt-workflow-runtime-adapter-postgres': {
        'unit': 'none',
        'integration': {
            'tests/notification_bridge.rs': 'postgres',
            'tests/payroll_drain_period_lock.rs': 'postgres',
        },
    },
    'mnt-workflow-domain': {
        'unit': 'none',
    },
    'mnt-workflow-runtime': {
        'unit': 'none',
    },
    'mnt-workorder-adapter-postgres': {
        'integration': {
            'tests/m2_flag_off_parity.rs': 'postgres',
            'tests/rls_read_surfaces_as_runtime_role.rs': 'postgres',
            'tests/use_cases.rs': 'postgres',
        },
    },
    'mnt-workorder-application': {
        'unit': 'none',
    },
    'mnt-workorder-domain': {
        'integration': {
            'tests/approval_and_assignment.rs': 'none',
            'tests/serde_roundtrips.rs': 'none',
            'tests/workorder_fsm.rs': 'none',
        },
    },
    'mnt-workorder-rest': {
        'unit': 'none',
        'integration': {
            'tests/mobile_evidence.rs': 'postgres',
            'tests/mobile_sync.rs': 'postgres',
        },
    },
}

TEST_TYPE_LABELS = frozenset({"test.unit", "test.integration"})
RESOURCE_LABELS = frozenset({"resource.none", "resource.postgres"})

# Inline database tests remain in their crate source tree, but cannot share the
# hermetic unit target. Each declared variant is compiled with its inert Cargo
# feature and emitted as a separately schedulable integration target.
INLINE_TEST_VARIANTS = {
    "mnt-app": ({
        "name": "itest-inline-postgres",
        "feature": "test-postgres",
        "resource": "postgres",
    },),
}

INTEGRATION_TEST_FEATURES = {
    "mnt-app": {
        "tests/dev_auth_persona_guard_feature.rs": ("dev-auth",),
    },
    "mnt-platform-auth-rest": {
        "tests/dev_auth_session.rs": ("dev-auth",),
    },
}

# Cargo feature unification does not cross Buck targets.  These reviewed
# variants preserve the production libraries while making the local dev-auth
# graph explicit for the app feature integration test and auth-rest session
# test.
FEATURE_LIBRARY_VARIANTS = {
    "mnt-platform-auth-rest": {"dev-auth": {"deps": {}}},
    "mnt-app": {
        "dev-auth": {
            "deps": {
                "//backend/crates/platform/auth-rest:mnt-platform-auth-rest":
                    "//backend/crates/platform/auth-rest:mnt-platform-auth-rest-dev-auth",
            },
        },
    },
}


def validate_inline_test_variants(metadata):
    """Require each emitted inline variant to name an inert manifest feature."""
    for package_name, variants in INLINE_TEST_VARIANTS.items():
        try:
            manifest = metadata[package_name]
        except KeyError as error:
            raise ValueError("inline test variant has no workspace package: {}".format(package_name)) from error
        declared_features = manifest.get("features", {})
        for variant in variants:
            if variant["feature"] not in declared_features:
                raise ValueError(
                    "inline test variant feature is absent from {}: {}".format(
                        package_name, variant["feature"]
                    )
                )


def integration_test_features(package_name, test_file):
    return INTEGRATION_TEST_FEATURES.get(package_name, {}).get(test_file, ())


def integration_test_library_target(package_name, test_file, default_target):
    features = integration_test_features(package_name, test_file)
    if features == ("dev-auth",):
        return default_target + "-dev-auth"
    return default_target


def variant_deps(package_name, feature, deps):
    replacements = FEATURE_LIBRARY_VARIANTS[package_name][feature]["deps"]
    return [replacements.get(dep, dep) for dep in deps]


def resource_requirement(package_name, test_type, test_file=None):
    """Return a reviewed resource requirement for exactly one generated test."""
    if test_type not in TEST_TYPE_LABELS:
        raise ValueError("unknown test type: {}".format(test_type))
    if test_type == "test.unit":
        key = "unit"
    else:
        if test_file is None:
            raise ValueError("integration resource lookup requires a test file")
        key = test_file
    try:
        requirement = TEST_RESOURCE_REQUIREMENTS[package_name]
        resource = (
            requirement[key]
            if test_type == "test.unit"
            else requirement["integration"][key]
        )
    except KeyError as error:
        raise ValueError(
            "missing reviewed resource metadata for {} {}{}".format(
                package_name,
                test_type,
                " " + test_file if test_file else "",
            )
        ) from error
    if resource not in {"none", "postgres"}:
        raise ValueError("unknown test resource: {}".format(resource))
    return resource


def requires_postgres(package_name, test_type, test_file=None):
    return resource_requirement(package_name, test_type, test_file) == "postgres"


def discovered_test_resource_keys(d, package_name):
    """Return resource keys for targets this generator will emit."""
    keys = set()
    src = os.path.join(d, "src")
    if tree_has(src, "#[cfg(test)]"):
        keys.add((package_name, "test.unit", None))
    testsdir = os.path.join(d, "tests")
    if os.path.isdir(testsdir):
        for dp, _, files in os.walk(testsdir):
            for filename in files:
                if filename.endswith(".rs"):
                    test_file = os.path.relpath(os.path.join(dp, filename), d)
                    if file_has(os.path.join(d, test_file), *TEST_MARKERS):
                        keys.add((package_name, "test.integration", test_file))
    return keys


def declared_test_resource_keys(requirements=TEST_RESOURCE_REQUIREMENTS):
    keys = set()
    for package_name, requirement in requirements.items():
        if "unit" in requirement:
            keys.add((package_name, "test.unit", None))
        for test_file in requirement.get("integration", {}):
            keys.add((package_name, "test.integration", test_file))
    return keys


def validate_resource_metadata(discovered, requirements=TEST_RESOURCE_REQUIREMENTS):
    """Require a one-to-one reviewed resource declaration for emitted tests."""
    declared = declared_test_resource_keys(requirements)
    missing, stale = discovered - declared, declared - discovered
    if missing or stale:
        parts = []
        if missing:
            parts.append("missing " + repr(sorted(missing)))
        if stale:
            parts.append("stale " + repr(sorted(stale)))
        raise ValueError("test resource metadata must match generated targets: " + "; ".join(parts))
    for package_name, test_type, test_file in discovered:
        resource_requirement(package_name, test_type, test_file)


def stable_label_segment(value):
    """Normalize a repository path segment into a deterministic Buck label part."""
    normalized = []
    for char in value.lower():
        normalized.append(char if char.isalnum() else "-")
    return "".join(normalized).strip("-") or "root"


def ownership_labels(package):
    """Return stable owner/domain labels derived only from a package path.

    owner is fully qualified, so it remains useful for fine-grained ownership
    analysis. domain is the first bounded-context segment below backend/crates;
    app and ci packages retain their own stable roots. No package-name lookup or
    exception table is allowed here because that would not scale with the graph.
    """
    parts = [stable_label_segment(part) for part in package.split("/") if part]
    if parts[:2] == ["backend", "crates"] and len(parts) > 2:
        domain = parts[2]
    elif parts[:2] == ["backend", "app"]:
        domain = "app"
    elif parts[:2] == ["backend", "ci"]:
        domain = "ci"
    else:
        domain = parts[0] if parts else "root"
    return ["owner." + ".".join(parts), "domain." + domain]


def test_labels(package, test_type, uses_postgres):
    """Return the complete deterministic taxonomy for one generated rust_test."""
    if test_type not in TEST_TYPE_LABELS:
        raise ValueError("unknown test type: {}".format(test_type))
    resource = "resource.postgres" if uses_postgres else "resource.none"
    labels = ownership_labels(package) + [test_type, resource]
    if uses_postgres:
        # Compatibility during runner migration; resource.postgres is canonical.
        labels.append("needs-postgres")
    return labels


def find_members():
    dirs = []
    for root in MEMBER_ROOTS:
        for dirpath, _, files in os.walk(os.path.join(REPO, root)):
            if "Cargo.toml" in files and os.path.basename(dirpath) != "rust":
                with open(os.path.join(dirpath, "Cargo.toml"), "rb") as f:
                    if "package" in tomllib.load(f):
                        dirs.append(dirpath)
    return sorted(dirs)


def load(dirpath):
    with open(os.path.join(dirpath, "Cargo.toml"), "rb") as f:
        return tomllib.load(f)


def crate_ident(name):
    return name.replace("-", "_")


def file_has(path, *markers):
    try:
        with open(path, encoding="utf-8", errors="ignore") as source_file:
            txt = source_file.read()
    except OSError:
        return False
    return any(mk in txt for mk in markers)


def tree_has(root, *markers):
    for dp, _, files in os.walk(root):
        for f in files:
            if f.endswith(".rs") and file_has(os.path.join(dp, f), *markers):
                return True
    return False



def map_deps(dep_table, first_party):
    """Map a [dependencies]/[dev-dependencies] table to (deps_list, named_dict)."""
    deps, named = [], {}
    for key, spec in (dep_table or {}).items():
        pkg = spec.get("package", key) if isinstance(spec, dict) else key
        version = spec.get("version", "") if isinstance(spec, dict) else spec
        if pkg in first_party:
            target = first_party[pkg]
        elif pkg == "sqlx" and str(version).lstrip("=").startswith("0.8"):
            target = "//third-party/rust:sqlx-0_8"  # buckify.sh renames the 0.8 alias
        else:
            target = "//third-party/rust:{}".format(pkg)
        if key != pkg:  # renamed dependency -> named_dep so the crate sees `key`
            named[crate_ident(key)] = target
        else:
            deps.append(target)
    return deps, named


def globstr(patterns, exclude=None):
    pats = ", ".join('"{}"'.format(p) for p in patterns)
    if exclude:
        ex = ", ".join('"{}"'.format(e) for e in exclude)
        return "glob([{}], exclude = [{}])".format(pats, ex)
    return "glob([{}])".format(pats)


def listsrcs(paths):
    return "[" + ", ".join('"{}"'.format(p) for p in paths) + "]"


def base_env(package, uses_sqlx=False):
    env = {"CARGO_MANIFEST_DIR": package}
    if uses_sqlx:
        env.update({
            "SQLX_OFFLINE": "true",
            "SQLX_OFFLINE_DIR": "$(location //backend:sqlx-offline)",
        })
    return env


def integration_resource_config(name, test_file):
    crate = RESOURCE_CONFIG.get(name, {})
    specific = crate.get("itests", {}).get(test_file, {})
    return {
        "srcs": list(crate.get("itest_srcs", [])) + list(specific.get("srcs", [])),
        "external": {
            **crate.get("itest_external", {}),
            **specific.get("external", {}),
        },
    }


def integration_external_resources(name, test_file, contents):
    external = dict(integration_resource_config(name, test_file)["external"])
    if "#[sqlx::test" in contents:
        external.update(MIGRATION_TREE)
    return external


def mapped_srcs_lines(package, srcs, external):
    if not external:
        return [
            '    mapped_srcs = repo_mapped_srcs("{}", {}),'.format(
                package, srcs
            ),
        ]
    lines = [
        '    mapped_srcs = repo_mapped_srcs("{}", {}, external = {{'.format(
            package, srcs
        ),
    ]
    lines += [
        '        "{}": "{}",'.format(label, destination)
        for label, destination in sorted(external.items())
    ]
    lines.append("    }),")
    return lines


def _block(
    rule,
    name,
    srcs,
    crate,
    deps,
    named,
    env,
    *,
    package,
    crate_root,
    external=None,
    labels=None,
    features=None,
):
    lines = [
        "{}(".format(rule),
        '    name = "{}",'.format(name),
    ]
    lines += mapped_srcs_lines(package, srcs, external or {})
    lines += [
        '    crate = "{}",'.format(crate),
        '    edition = "2024",',
        '    crate_root = "{}",'.format(crate_root),
    ]
    lines.append('    visibility = ["PUBLIC"],')
    if env:
        items = ", ".join('"{}": "{}"'.format(k, v) for k, v in env.items())
        lines.append("    env = {" + items + "},")
    if labels:
        lines.append("    labels = [" + ", ".join('"{}"'.format(x) for x in labels) + "],")
    if features:
        lines.append("    features = [" + ", ".join('"{}"'.format(x) for x in features) + "],")
    if deps:
        lines.append("    deps = [")
        lines += ['        "{}",'.format(t) for t in sorted(set(deps))]
        lines.append("    ],")
    if named:
        lines.append("    named_deps = {")
        lines += ['        "{}": "{}",'.format(k, v) for k, v in sorted(named.items())]
        lines.append("    },")
    lines.append(")")
    return lines


def main():
    members = find_members()
    first_party, meta = {}, {}
    for d in members:
        m = load(d)
        name = m["package"]["name"]
        first_party[name] = "//{}:{}".format(os.path.relpath(d, REPO), name)
        meta[d] = (name, m)

    packages = {name: metadata for name, metadata in meta.values()}
    validate_inline_test_variants(packages)

    discovered = set()
    for d in members:
        name, _ = meta[d]
        discovered.update(discovered_test_resource_keys(d, name))
    validate_resource_metadata(discovered)

    generated = 0
    for d in members:
        name, m = meta[d]
        deps, named = map_deps(m.get("dependencies"), first_party)
        dev_deps, dev_named = map_deps(m.get("dev-dependencies"), first_party)
        emit(d, name, sorted(deps), named, sorted(dev_deps), dev_named)
        generated += 1
    print("generated {} first-party BUCK files".format(generated))


def emit(d, name, deps, named, dev_deps, dev_named):
    header = "# @generated by tools/buck/gen_first_party.py from Cargo.toml — do not edit by hand."
    ident = crate_ident(name)
    has_main = os.path.isfile(os.path.join(d, "src", "main.rs"))
    has_lib = os.path.isfile(os.path.join(d, "src", "lib.rs"))
    src = os.path.join(d, "src")
    package = os.path.relpath(d, REPO)
    uses_sqlx = tree_has(src, *(SQLX_MACRO_MARKERS + ("#[sqlx::test",)))
    env = base_env(package, uses_sqlx=uses_sqlx)
    resources = RESOURCE_CONFIG.get(name, {})
    lib_pats = ["src/**/*.rs"] + list(resources.get("srcs", []))
    lib_external = dict(resources.get("external", {}))
    if tree_has(src, "#[sqlx::test"):
        lib_external.update(MIGRATION_TREE)

    out = [
        header,
        'load("//tools/buck:rust_source_layout.bzl", "repo_mapped_srcs")',
        "",
        "export_file(",
        '    name = "crate-source-tree",',
        '    src = "src",',
        '    mode = "reference",',
        '    visibility = ["PUBLIC"],',
        ")",
        "",
    ]
    if has_main and has_lib:
        out += _block("rust_library", name + "-lib", globstr(lib_pats, exclude=["src/main.rs"]),
                      ident, deps, named, env, package=package,
                      crate_root=package + "/src/lib.rs", external=lib_external)
        for feature in FEATURE_LIBRARY_VARIANTS.get(name, {}):
            out.append("")
            out += _block("rust_library", name + "-lib-" + feature,
                          globstr(lib_pats, exclude=["src/main.rs"]), ident,
                          variant_deps(name, feature, deps), named, env,
                          package=package, crate_root=package + "/src/lib.rs",
                          external=lib_external, features=[feature])
        out.append("")
        out += _block("rust_binary", name, listsrcs(["src/main.rs"]), ident,
                      sorted(deps + [":" + name + "-lib"]), {},
                      base_env(package), package=package,
                      crate_root=package + "/src/main.rs")
        for feature in FEATURE_LIBRARY_VARIANTS.get(name, {}):
            out.append("")
            out += _block("rust_binary", name + "-" + feature,
                          listsrcs(["src/main.rs"]), ident,
                          sorted(variant_deps(name, feature, deps) + [":" + name + "-lib-" + feature]), {},
                          base_env(package), package=package,
                          crate_root=package + "/src/main.rs", features=[feature])
        lib_target, unit_root, unit_excl = ":" + name + "-lib", "src/lib.rs", ["src/main.rs"]
    elif has_main:
        out += _block("rust_binary", name, globstr(lib_pats), ident, deps, named, env,
                      package=package, crate_root=package + "/src/main.rs",
                      external=lib_external)
        lib_target, unit_root, unit_excl = ":" + name, "src/main.rs", None
    else:
        out += _block("rust_library", name, globstr(lib_pats), ident, deps, named, env,
                      package=package, crate_root=package + "/src/lib.rs",
                      external=lib_external)
        for feature in FEATURE_LIBRARY_VARIANTS.get(name, {}):
            out.append("")
            out += _block("rust_library", name + "-" + feature, globstr(lib_pats), ident,
                          variant_deps(name, feature, deps), named, env,
                          package=package, crate_root=package + "/src/lib.rs",
                          external=lib_external, features=[feature])
        lib_target, unit_root, unit_excl = ":" + name, "src/lib.rs", None

    test_deps = sorted(set(deps + dev_deps))
    test_named = {**named, **dev_named}

    # Unit tests recompile the library without non-default test features.
    if tree_has(src, "#[cfg(test)]"):
        uses_postgres = requires_postgres(name, "test.unit")
        labels = test_labels(package, "test.unit", uses_postgres)
        out.append("")
        out += _block("rust_test", name + "-unit",
                      globstr(lib_pats, exclude=unit_excl), ident,
                      test_deps, test_named, env, package=package,
                      crate_root=package + "/" + unit_root,
                      external=lib_external, labels=labels)

    # Feature-gated inline suites are separate integration targets. This keeps
    # the default unit binary hermetic while retaining database coverage.
    for variant in INLINE_TEST_VARIANTS.get(name, ()):
        if variant["resource"] != "postgres":
            raise ValueError("unknown inline test resource: {}".format(variant["resource"]))
        out.append("")
        out += _block(
            "rust_test",
            "{}-{}".format(name, variant["name"]),
            globstr(lib_pats, exclude=unit_excl),
            ident,
            test_deps,
            test_named,
            env,
            package=package,
            crate_root=package + "/" + unit_root,
            external=lib_external,
            labels=test_labels(package, "test.integration", True),
            features=[variant["feature"]],
        )

    # Integration tests: one rust_test per tests/*.rs with a test marker; non-test
    # helper files (tests/config.rs, tests/common/**) are added to srcs so their
    # `mod` declarations resolve (unreferenced ones are ignored by rustc).
    testsdir = os.path.join(d, "tests")
    if os.path.isdir(testsdir):
        all_rs = []
        for dp, _, files in os.walk(testsdir):
            for f in files:
                if f.endswith(".rs"):
                    all_rs.append(os.path.relpath(os.path.join(dp, f), d))
        test_files = sorted(p for p in all_rs if file_has(os.path.join(d, p), *TEST_MARKERS))
        helpers = sorted(p for p in all_rs if p not in test_files)
        for tf in test_files:
            test_path = os.path.join(d, tf)
            contents = open(test_path, encoding="utf-8", errors="ignore").read()
            stem = crate_ident(os.path.splitext(os.path.basename(tf))[0])
            labels = test_labels(
                package,
                "test.integration",
                requires_postgres(name, "test.integration", tf),
            )
            config = integration_resource_config(name, tf)
            srcs_expr = listsrcs(sorted(set([tf] + helpers)))
            if config["srcs"]:
                srcs_expr += " + " + globstr(config["srcs"])
            external = integration_external_resources(name, tf, contents)
            itest_env = base_env(
                package,
                uses_sqlx=any(marker in contents for marker in SQLX_MACRO_MARKERS)
                or "#[sqlx::test" in contents,
            )
            features = integration_test_features(name, tf)
            out.append("")
            test_lib_target = integration_test_library_target(name, tf, lib_target)
            featured_test_deps = test_deps
            if features == ("dev-auth",):
                featured_test_deps = variant_deps(name, "dev-auth", test_deps)
            out += _block("rust_test", "{}-itest-{}".format(name, stem),
                          srcs_expr, stem,
                          sorted(set(featured_test_deps + [test_lib_target])), test_named, itest_env,
                          package=package, crate_root=package + "/" + tf,
                          external=external, labels=labels, features=features)

    with open(os.path.join(d, "BUCK"), "w") as f:
        f.write("\n".join(out) + "\n")


if __name__ == "__main__":
    sys.exit(main())
