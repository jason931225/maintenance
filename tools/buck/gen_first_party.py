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
# the generated face in the same reviewed diff. Omitted targets are hermetic.
POSTGRES_TEST_REQUIREMENTS = {
    'mnt-app': {
        'unit': True,
        'integration': frozenset({
            'tests/action_inbox_api.rs',
            'tests/audit_api.rs',
            'tests/auth_rest.rs',
            'tests/benefit_catalog_api.rs',
            'tests/cedar_freshness_mint.rs',
            'tests/cedar_parity_shadow.rs',
            'tests/cedar_shadow_role_manage.rs',
            'tests/compliance_api.rs',
            'tests/compliance_catalog_api.rs',
            'tests/console_kill_switch.rs',
            'tests/console_route_telemetry.rs',
            'tests/consulting_engagement_api.rs',
            'tests/dev_auth_persona_guard.rs',
            'tests/dev_auth_persona_guard_feature.rs',
            'tests/facilities_pilot_story.rs',
            'tests/finance_gl_voucher_sod.rs',
            'tests/health_readiness.rs',
            'tests/hr_attendance_self_read.rs',
            'tests/hr_ingest_checklist_gate.rs',
            'tests/hr_people_create_api.rs',
            'tests/logistics_pilot_story.rs',
            'tests/m2_real_engine_drive.rs',
            'tests/mobile_api.rs',
            'tests/notifications_api.rs',
            'tests/object_graph_api.rs',
            'tests/object_links_api.rs',
            'tests/object_ontology_api.rs',
            'tests/object_resolve_api.rs',
            'tests/office_versions.rs',
            'tests/platform_onboarding_e2e.rs',
            'tests/purchase_request_collection_api.rs',
            'tests/realtime_ws.rs',
            'tests/registry_api.rs',
            'tests/router_layers.rs',
            'tests/search_api.rs',
            'tests/submittable_definitions_api.rs',
            'tests/tenant_context_e2e.rs',
            'tests/workbench_native_api.rs',
            'tests/workflow_automation_triggers.rs',
            'tests/workflow_dynamics_branch.rs',
            'tests/workflow_four_eyes_publish.rs',
            'tests/workflow_object_context_api.rs',
            'tests/workflow_object_kind_dynamics.rs',
            'tests/workflow_run_read_surface.rs',
            'tests/workflow_runtime_finalize_api.rs',
            'tests/workflow_runtime_instance_api.rs',
            'tests/workorder_api.rs',
        }),
    },
    'mnt-gate-audit-coverage': {
        'integration': frozenset({
            'tests/gate_detects_violation.rs',
        }),
    },
    'mnt-gate-rls-arming': {
        'unit': True,
    },
    'mnt-gate-tenant-isolation': {
        'unit': True,
        'integration': frozenset({
            'tests/owner_only_acl_postgres18.rs',
        }),
    },
    'mnt-benefit-adapter-postgres': {
        'integration': frozenset({
            'tests/catalog_rls_surfaces_as_runtime_role.rs',
        }),
    },
    'mnt-comms-adapter-postgres': {
        'integration': frozenset({
            'tests/mail_account_rls_surfaces_as_runtime_role.rs',
            'tests/mail_sync_rls_surfaces_as_runtime_role.rs',
            'tests/send_rate_limit_rls_surfaces_as_runtime_role.rs',
        }),
    },
    'mnt-comms-rest': {
        'integration': frozenset({
            'tests/mox_webhook.rs',
            'tests/readiness.rs',
        }),
    },
    'mnt-compliance-adapter-postgres': {
        'integration': frozenset({
            'tests/location_consent_status_rls_as_runtime_role.rs',
            'tests/location_store.rs',
        }),
    },
    'mnt-dispatch-adapter-postgres': {
        'integration': frozenset({
            'tests/p1_dispatch.rs',
        }),
    },
    'mnt-dispatch-worker': {
        'integration': frozenset({
            'tests/timer_delivery.rs',
        }),
    },
    'mnt-docs-rest': {
        'integration': frozenset({
            'tests/evidence_rest_rls_surfaces_as_runtime_role.rs',
        }),
    },
    'mnt-finance-gl-adapter-postgres': {
        'integration': frozenset({
            'tests/voucher_rls_and_fsm_as_runtime_role.rs',
        }),
    },
    'mnt-financial-adapter-postgres': {
        'integration': frozenset({
            'tests/lifecycle_rls_surfaces_as_runtime_role.rs',
            'tests/period_lock_blocks_ledger_as_runtime_role.rs',
            'tests/use_cases.rs',
        }),
    },
    'mnt-financial-rest': {
        'integration': frozenset({
            'tests/purchase_request_list.rs',
        }),
    },
    'mnt-governance-adapter-postgres': {
        'integration': frozenset({
            'tests/approvals_create_as_runtime_role.rs',
            'tests/four_eyes_bind_consume.rs',
            'tests/governance_rls_as_runtime_role.rs',
        }),
    },
    'mnt-identity-adapter-postgres': {
        'integration': frozenset({
            'tests/deactivate_revokes_credentials.rs',
            'tests/me_workspace_layouts_rls.rs',
            'tests/region_branch_crud_rls_surfaces_as_runtime_role.rs',
            'tests/subject_authz_versions_freshness_rls.rs',
        }),
    },
    'mnt-identity-rest': {
        'unit': True,
        'integration': frozenset({
            'tests/org_setup.rs',
        }),
    },
    'mnt-inbox-adapter-postgres': {
        'integration': frozenset({
            'tests/inbox_docs_rls_surfaces_as_runtime_role.rs',
        }),
    },
    'mnt-inbox-rest': {
        'integration': frozenset({
            'tests/api.rs',
        }),
    },
    'mnt-inspection-adapter-postgres': {
        'integration': frozenset({
            'tests/lifecycle.rs',
            'tests/schedule_window_rls_surfaces_as_runtime_role.rs',
        }),
    },
    'mnt-leave-adapter-postgres': {
        'integration': frozenset({
            'tests/leave_migration_expand_contract.rs',
            'tests/leave_rls_surfaces_as_runtime_role.rs',
        }),
    },
    'mnt-leave-rest': {
        'integration': frozenset({
            'tests/leave_http_personas.rs',
        }),
    },
    'mnt-messenger-adapter-postgres': {
        'integration': frozenset({
            'tests/parity_tables_rls_as_runtime_role.rs',
            'tests/use_cases.rs',
        }),
    },
    'mnt-messenger-rest': {
        'integration': frozenset({
            'tests/api.rs',
        }),
    },
    'mnt-notices-adapter-postgres': {
        'integration': frozenset({
            'tests/notices_rls_surfaces_as_runtime_role.rs',
        }),
    },
    'mnt-notices-rest': {
        'integration': frozenset({
            'tests/api.rs',
        }),
    },
    'mnt-notifications-adapter-postgres': {
        'integration': frozenset({
            'tests/notifications_rls_surfaces_as_runtime_role.rs',
        }),
    },
    'mnt-notifications-rest': {
        'integration': frozenset({
            'tests/api.rs',
        }),
    },
    'mnt-ontology-adapter-postgres': {
        'integration': frozenset({
            'tests/c_chain_as_runtime_role.rs',
            'tests/config_object_types_as_runtime_role.rs',
            'tests/instances_residual_filter_as_runtime_role.rs',
            'tests/instances_rls_surfaces_as_runtime_role.rs',
            'tests/key_revision_migration_upgrade.rs',
            'tests/key_write_cas_as_runtime_role.rs',
            'tests/niche_config_object_types_as_runtime_role.rs',
            'tests/projected_instances_read_as_runtime_role.rs',
            'tests/registry_rls_surfaces_as_runtime_role.rs',
        }),
    },
    'mnt-ontology-rest': {
        'integration': frozenset({
            'tests/action_execute_as_runtime_role.rs',
            'tests/object_type_cas_as_runtime_role.rs',
            'tests/ont_gaps_as_runtime_role.rs',
            'tests/projected_dispatch_as_runtime_role.rs',
            'tests/publish_auto_create_action_as_runtime_role.rs',
        }),
    },
    'mnt-payroll-adapter-postgres': {
        'integration': frozenset({
            'tests/payroll_rls_surfaces_as_runtime_role.rs',
        }),
    },
    'mnt-payroll-rest': {
        'integration': frozenset({
            'tests/api.rs',
        }),
    },
    'mnt-platform-audit-chain': {
        'integration': frozenset({
            'tests/audit_chain_rls.rs',
        }),
    },
    'mnt-platform-auth': {
        'integration': frozenset({
            'tests/refresh_tokens.rs',
            'tests/webauthn_ceremony.rs',
            'tests/webauthn_ceremony_replay.rs',
        }),
    },
    'mnt-platform-auth-rest': {
        'unit': True,
        'integration': frozenset({
            'tests/dev_auth_absence.rs',
            'tests/dev_auth_session.rs',
            'tests/group_admin_tenant_context.rs',
        }),
    },
    'mnt-platform-authz': {
        'integration': frozenset({
            'tests/policy.rs',
        }),
    },
    'mnt-platform-authz-rest': {
        'integration': frozenset({
            'tests/cedar_authoring_rls_as_runtime_role.rs',
            'tests/decision_feed_as_runtime_role.rs',
        }),
    },
    'mnt-platform-db': {
        'unit': True,
        'integration': frozenset({
            'tests/code_issuance.rs',
            'tests/group_resolvers.rs',
            'tests/m2_flag_on_runtime_drain.rs',
            'tests/period_locks_and_lifecycle.rs',
            'tests/rls_isolation.rs',
            'tests/rls_rollout_isolation.rs',
        }),
    },
    'mnt-platform-group': {
        'unit': True,
    },
    'mnt-platform-jobs': {
        'unit': True,
        'integration': frozenset({
            'tests/apalis_adapter.rs',
            'tests/apalis_schema_contract.rs',
        }),
    },
    'mnt-platform-rest': {
        'integration': frozenset({
            'tests/onboard_seeds_config_objects.rs',
            'tests/ops_dashboard.rs',
            'tests/platform_groups.rs',
            'tests/remove_tenant.rs',
            'tests/view_as.rs',
        }),
    },
    'mnt-platform-provisioning': {
        'integration': frozenset({
            'tests/bootstrap_passkey.rs',
            'tests/bootstrap_passkey_replay.rs',
            'tests/dev_principal_upsert_race.rs',
            'tests/rls_auth_chain_as_runtime_role.rs',
            'tests/roster_import.rs',
            'tests/self_enroll_handoff_as_runtime_role.rs',
        }),
    },
    'mnt-platform-realtime': {
        'integration': frozenset({
            'tests/postgres_bridge.rs',
        }),
    },
    'mnt-platform-storage': {
        'unit': True,
        'integration': frozenset({
            'tests/evidence_processing_rls_surfaces_as_runtime_role.rs',
        }),
    },
    'mnt-policy-adapter-postgres': {
        'integration': frozenset({
            'tests/draft_storage.rs',
        }),
    },
    'mnt-production-rest': {
        'integration': frozenset({
            'tests/production_lifecycle_http.rs',
        }),
    },
    'mnt-registry-adapter-postgres': {
        'integration': frozenset({
            'tests/create_rls_surfaces_as_runtime_role.rs',
            'tests/equipment_list_rls_as_runtime_role.rs',
            'tests/equipment_lookup_normalization_rls_as_runtime_role.rs',
            'tests/equipment_versioning_as_runtime_role.rs',
            'tests/master_list_import.rs',
            'tests/master_list_import_rls_as_runtime_role.rs',
            'tests/site_address_postal_roundtrip_rls_as_runtime_role.rs',
        }),
    },
    'mnt-registry-rest': {
        'integration': frozenset({
            'tests/equipment_admin.rs',
        }),
    },
    'mnt-reporting-adapter-postgres': {
        'integration': frozenset({
            'tests/excel_exports.rs',
            'tests/kpi_golden_dataset.rs',
            'tests/ops_summary.rs',
            'tests/work_diary_rls_surfaces_as_runtime_role.rs',
        }),
    },
    'mnt-sales-adapter-postgres': {
        'integration': frozenset({
            'tests/inquiry_rls_surfaces_as_runtime_role.rs',
            'tests/sales_store.rs',
        }),
    },
    'mnt-support-adapter-postgres': {
        'integration': frozenset({
            'tests/assignee_name_join_rls_surfaces_as_runtime_role.rs',
            'tests/create_internal_ticket_rls_surfaces_as_runtime_role.rs',
            'tests/support_tickets.rs',
        }),
    },
    'mnt-support-rest': {
        'unit': True,
        'integration': frozenset({
            'tests/authz.rs',
            'tests/intake.rs',
        }),
    },
    'mnt-todos-adapter-postgres': {
        'integration': frozenset({
            'tests/todos_rls_surfaces_as_runtime_role.rs',
        }),
    },
    'mnt-workflow-runtime-adapter-postgres': {
        'integration': frozenset({
            'tests/notification_bridge.rs',
            'tests/payroll_drain_period_lock.rs',
        }),
    },
    'mnt-workorder-adapter-postgres': {
        'integration': frozenset({
            'tests/m2_flag_off_parity.rs',
            'tests/rls_read_surfaces_as_runtime_role.rs',
            'tests/use_cases.rs',
        }),
    },
    'mnt-workorder-rest': {
        'integration': frozenset({
            'tests/mobile_evidence.rs',
            'tests/mobile_sync.rs',
        }),
    },
}

TEST_TYPE_LABELS = frozenset({"test.unit", "test.integration"})
RESOURCE_LABELS = frozenset({"resource.none", "resource.postgres"})


def requires_postgres(package_name, test_type, test_file=None):
    """Return a mutable-resource requirement from reviewed target metadata."""
    if test_type not in TEST_TYPE_LABELS:
        raise ValueError("unknown test type: {}".format(test_type))
    requirement = POSTGRES_TEST_REQUIREMENTS.get(package_name, {})
    if test_type == "test.unit":
        return requirement.get("unit", False)
    if test_file is None:
        raise ValueError("integration resource lookup requires a test file")
    return test_file in requirement.get("integration", frozenset())


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
        txt = open(path, encoding="utf-8", errors="ignore").read()
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
        out.append("")
        out += _block("rust_binary", name, listsrcs(["src/main.rs"]), ident,
                      sorted(deps + [":" + name + "-lib"]), {},
                      base_env(package), package=package,
                      crate_root=package + "/src/main.rs")
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
        lib_target, unit_root, unit_excl = ":" + name, "src/lib.rs", None

    test_deps = sorted(set(deps + dev_deps))
    test_named = {**named, **dev_named}

    # Unit tests: recompile the lib srcs with --test (only if inline tests exist).
    # SQL-backed suites are emitted and labeled rather than hidden: the migration
    # input is hermetic at compile time, while execution still requires Postgres.
    if tree_has(src, "#[cfg(test)]"):
        uses_postgres = requires_postgres(name, "test.unit")
        labels = test_labels(package, "test.unit", uses_postgres)
        out.append("")
        out += _block("rust_test", name + "-unit",
                      globstr(lib_pats, exclude=unit_excl), ident,
                      test_deps, test_named, env, package=package,
                      crate_root=package + "/" + unit_root,
                      external=lib_external, labels=labels)

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
            out.append("")
            out += _block("rust_test", "{}-itest-{}".format(name, stem),
                          srcs_expr, stem,
                          sorted(set(test_deps + [lib_target])), test_named, itest_env,
                          package=package, crate_root=package + "/" + tf,
                          external=external, labels=labels)

    with open(os.path.join(d, "BUCK"), "w") as f:
        f.write("\n".join(out) + "\n")


if __name__ == "__main__":
    sys.exit(main())
