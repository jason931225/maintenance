"""Fail-closed contract for the current-lock Buck2 Rust admission graph."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import tomllib
import unittest
import urllib.parse


REPO = Path(os.environ.get("MAINTENANCE_REPO_ROOT", Path(__file__).resolve().parents[4]))
LOCK = REPO / "backend/Cargo.lock"
GRAPH = REPO / "backend/current-lock-rust-graph.generated.json"
ADMISSION = REPO / "backend/buck2-rust-admission.json"
POLICY = REPO / "backend/ci/gates/buck2-coverage/policy.json"
LITERAL_INCLUDE = re.compile(
    r'\b(?:include_str|include_bytes)!\s*\(\s*"([^"\\]*(?:\\.[^"\\]*)*)"\s*\)'
)

REQUIRED_QUERY_LABELS = {
    "//backend/app:mnt-app-lib",
    "//backend/app:mnt-app",
    "//backend/crates/platform/db:mnt-platform-db",
    "//backend/crates/platform/jobs:mnt-platform-jobs",
    "//backend/crates/workflow/domain:mnt-workflow-domain",
    "//backend/crates/workflow/runtime:mnt-workflow-runtime",
    "//backend/crates/workflow/adapter-postgres:mnt-workflow-runtime-adapter-postgres",
    "//backend/crates/workorder/rest:mnt-workorder-rest",
    "//backend/crates/finance-gl/domain:mnt-finance-gl-domain",
    "//backend/crates/finance-gl/application:mnt-finance-gl-application",
    "//backend/crates/finance-gl/adapter-postgres:mnt-finance-gl-adapter-postgres",
    "//backend/crates/ontology/domain:mnt-ontology-domain",
}
ONTOLOGY_CONTRACT_PRECURSOR = (
    "//backend/crates/ontology/domain:mnt-ontology-domain-contract-precursor"
)
REQUIRED_TEST_PREFIXES = {
    "//backend/app:mnt-app-",
    "//backend/crates/platform/db:mnt-platform-db-",
    "//backend/crates/platform/jobs:mnt-platform-jobs-",
    "//backend/crates/workflow/domain:mnt-workflow-domain-",
    "//backend/crates/workflow/runtime:mnt-workflow-runtime-",
    "//backend/crates/workflow/adapter-postgres:mnt-workflow-runtime-adapter-postgres-",
    "//backend/crates/workorder/rest:mnt-workorder-rest-",
    "//backend/crates/finance-gl/domain:mnt-finance-gl-domain-",
    "//backend/crates/finance-gl/application:mnt-finance-gl-application-",
    "//backend/crates/finance-gl/adapter-postgres:mnt-finance-gl-adapter-postgres-",
}
MAPPER_TEST_OBLIGATIONS = {
    "backend/app/src/lib.rs": "//backend/app:mnt-app-unit",
    "backend/app/tests/apalis_owner_bootstrap.rs": "//backend/app:mnt-app-apalis-owner-bootstrap",
    "backend/app/tests/config.rs": "//backend/app:mnt-app-config",
    "backend/app/tests/finance_gl_voucher_sod.rs": "//backend/app:mnt-app-finance-gl-voucher-sod",
    "backend/app/tests/migrations_as_mnt_app.rs": "//backend/app:mnt-app-migrations-as-mnt-app",
    "backend/app/tests/workflow_automation_triggers.rs": "//backend/app:mnt-app-workflow-automation-triggers",
    "backend/app/tests/workflow_dynamics_branch.rs": "//backend/app:mnt-app-workflow-dynamics-branch",
    "backend/app/tests/workflow_schedule_control_config.rs": "//backend/app:mnt-app-workflow-schedule-control-config",
    "backend/crates/finance-gl/adapter-postgres/tests/finance_v21_shared_schema_as_runtime_role.rs": (
        "//backend/crates/finance-gl/adapter-postgres:"
        "mnt-finance-gl-adapter-postgres-finance-v21-shared-schema-as-runtime-role"
    ),
    "backend/crates/finance-gl/adapter-postgres/tests/voucher_rls_and_fsm_as_runtime_role.rs": (
        "//backend/crates/finance-gl/adapter-postgres:"
        "mnt-finance-gl-adapter-postgres-voucher-rls-and-fsm-as-runtime-role"
    ),
    "backend/crates/platform/db/tests/workflow_schedules_rls.rs": (
        "//backend/crates/platform/db:mnt-platform-db-workflow-schedules-rls"
    ),
    "backend/crates/platform/db/tests/workflow_schedules_upgrade.rs": (
        "//backend/crates/platform/db:mnt-platform-db-workflow-schedules-upgrade"
    ),
    "backend/crates/platform/jobs/src/lib.rs": "//backend/crates/platform/jobs:mnt-platform-jobs-unit",
    "backend/crates/platform/jobs/tests/apalis_adapter.rs": (
        "//backend/crates/platform/jobs:mnt-platform-jobs-apalis-adapter"
    ),
    "backend/crates/workflow/adapter-postgres/tests/workflow_schedule_runtime.rs": (
        "//backend/crates/workflow/adapter-postgres:"
        "mnt-workflow-runtime-adapter-postgres-workflow-schedule-runtime"
    ),
}

SCHEDULER_APALIS_ADMISSION_LABELS = {
    "backend/app/tests/apalis_owner_bootstrap.rs": (
        "//backend/app:mnt-app-apalis-owner-bootstrap"
    ),
    "backend/app/tests/migrations_as_mnt_app.rs": (
        "//backend/app:mnt-app-migrations-as-mnt-app"
    ),
    "backend/app/tests/workflow_schedule_control_config.rs": (
        "//backend/app:mnt-app-workflow-schedule-control-config"
    ),
    "backend/crates/platform/db/tests/workflow_schedules_rls.rs": (
        "//backend/crates/platform/db:mnt-platform-db-workflow-schedules-rls"
    ),
    "backend/crates/platform/db/tests/workflow_schedules_upgrade.rs": (
        "//backend/crates/platform/db:mnt-platform-db-workflow-schedules-upgrade"
    ),
    "backend/crates/workflow/adapter-postgres/tests/workflow_schedule_runtime.rs": (
        "//backend/crates/workflow/adapter-postgres:"
        "mnt-workflow-runtime-adapter-postgres-workflow-schedule-runtime"
    ),
}


def load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise AssertionError(f"{path} must contain an object")
    return value


def registry_lock_packages() -> list[dict[str, str]]:
    lock = tomllib.loads(LOCK.read_text(encoding="utf-8"))
    result = []
    for package in lock["package"]:
        source = package.get("source")
        if not isinstance(source, str) or not source.startswith("registry+"):
            continue
        checksum = package.get("checksum")
        if not isinstance(checksum, str) or len(checksum) != 64:
            raise AssertionError(
                f"registry package {package['name']} {package['version']} lacks checksum"
            )
        result.append(
            {
                "name": package["name"],
                "version": package["version"],
                "source": source,
                "checksum": checksum,
            }
        )
    return sorted(result, key=lambda item: (item["name"], item["version"], item["source"]))


class CurrentLockRustGraphContract(unittest.TestCase):
    def test_third_party_manifest_is_exactly_current_lock_derived(self) -> None:
        graph = load_json(GRAPH)
        self.assertEqual(1, graph.get("schema_version"))
        self.assertEqual("backend/Cargo.lock", graph.get("lockfile"))
        self.assertEqual(
            hashlib.sha256(LOCK.read_bytes()).hexdigest(), graph.get("lock_sha256")
        )
        self.assertEqual(registry_lock_packages(), graph.get("registry_packages"))
        self.assertEqual(len(graph["registry_packages"]), graph.get("registry_package_count"))
        self.assertGreater(graph["registry_package_count"], 0)
        self.assertEqual(len(graph["buck_targets"]), graph.get("buck_target_count"))
        self.assertGreater(graph["buck_target_count"], 0)

    def test_mirror_routes_percent_encode_lock_identity_components(self) -> None:
        graph = load_json(GRAPH)
        packages = graph.get("materialized_registry_packages")
        self.assertIsInstance(packages, list)
        self.assertEqual(583, len(packages))
        for package in packages:
            name = urllib.parse.quote(package["name"], safe="")
            version = urllib.parse.quote(package["version"], safe="")
            self.assertEqual(
                f"/crates/{name}/{version}/download",
                package["mirror_route"],
            )
        self.assertEqual(
            "/crates/wasip2/1.0.3%2Bwasi-0.2.9/download",
            next(
                package["mirror_route"]
                for package in packages
                if package["name"] == "wasip2"
            ),
        )

    def test_admission_is_exact_nonempty_and_covers_required_real_labels(self) -> None:
        admission = load_json(ADMISSION)
        self.assertEqual(1, admission.get("schema_version"))
        self.assertEqual("backend/Cargo.lock", admission.get("lockfile"))
        self.assertEqual(
            hashlib.sha256(LOCK.read_bytes()).hexdigest(), admission.get("lock_sha256")
        )
        for key in ("query_labels", "build_labels", "test_labels"):
            labels = admission.get(key)
            self.assertIsInstance(labels, list)
            self.assertGreater(len(labels), 0)
            self.assertEqual(labels, sorted(set(labels)))
            self.assertFalse(any(label.endswith(":cargo-manifest-ownership") for label in labels))
        self.assertTrue(REQUIRED_QUERY_LABELS.issubset(admission["query_labels"]))
        self.assertTrue(REQUIRED_QUERY_LABELS.issubset(admission["build_labels"]))
        for prefix in REQUIRED_TEST_PREFIXES:
            self.assertTrue(
                any(label.startswith(prefix) for label in admission["test_labels"]),
                f"missing executable test label for {prefix}",
            )
        self.assertEqual(
            ONTOLOGY_CONTRACT_PRECURSOR,
            admission.get("ontology_contract_precursor"),
        )
        for key in ("query_labels", "build_labels", "test_labels"):
            self.assertIn(
                ONTOLOGY_CONTRACT_PRECURSOR,
                admission[key],
                f"ontology contract precursor must execute through {key}",
            )

        mapper_obligations = admission.get("mapper_test_obligations")
        self.assertIsInstance(mapper_obligations, list)
        self.assertEqual(
            mapper_obligations,
            sorted(mapper_obligations, key=lambda item: item["source"]),
        )
        self.assertEqual(
            set(MAPPER_TEST_OBLIGATIONS),
            {item.get("source") for item in mapper_obligations},
        )
        for item in mapper_obligations:
            source = item["source"]
            expected_label = MAPPER_TEST_OBLIGATIONS[source]
            self.assertEqual(expected_label, item.get("label"), source)
            if (REPO / source).is_file():
                self.assertEqual("admitted", item.get("state"), source)
                self.assertIn(expected_label, admission["query_labels"], source)
                self.assertIn(expected_label, admission["test_labels"], source)
            else:
                self.assertEqual("cross_lane_integration", item.get("state"), source)

    def test_scheduler_apalis_fan_in_is_atomic_and_ci_serialized(self) -> None:
        admission = load_json(ADMISSION)
        obligations = {
            item["source"]: item
            for item in admission.get("mapper_test_obligations", [])
        }
        source_presence = {
            source: (REPO / source).is_file()
            for source in SCHEDULER_APALIS_ADMISSION_LABELS
        }
        self.assertEqual(
            1,
            len(set(source_presence.values())),
            "scheduler/Apalis mapper sources must fan in atomically",
        )
        admitted = all(source_presence.values())
        for source, label in SCHEDULER_APALIS_ADMISSION_LABELS.items():
            expected_state = "admitted" if admitted else "cross_lane_integration"
            self.assertEqual(expected_state, obligations[source].get("state"), source)
            self.assertEqual(label, obligations[source].get("label"), source)
            for key in ("query_labels", "build_labels", "test_labels"):
                if admitted:
                    self.assertIn(label, admission[key], f"{source} missing from {key}")
                else:
                    self.assertNotIn(
                        label,
                        admission[key],
                        f"{source} falsely present in {key} before atomic fan-in",
                    )

        runner = REPO / "tools/buck/ci_rust_admission.py"
        workflow = (REPO / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        invocation = "python3 -I tools/buck/ci_rust_admission.py"
        if not admitted:
            self.assertFalse(runner.exists(), runner.relative_to(REPO))
            self.assertEqual(0, workflow.count(invocation))
            return

        self.assertTrue(runner.is_file(), runner.relative_to(REPO))
        self.assertEqual(1, workflow.count(invocation))
        runner_text = runner.read_text(encoding="utf-8")
        ordered_gates = (
            "check_manifest_ownership",
            "check_generated_current_lock_receipt",
            "check_hermetic_toolchain",
            "query_admitted_labels",
            "build_admitted_labels",
            "test_admitted_labels",
        )
        offsets = [runner_text.index(gate) for gate in ordered_gates]
        self.assertEqual(offsets, sorted(offsets))
        self.assertIn("Cargo is shadow-only and non-authoritative", workflow)

    def test_manifest_ownership_declares_each_required_real_target(self) -> None:
        policy = load_json(POLICY)
        declared = policy.get("declared_targets")
        self.assertIsInstance(declared, dict)
        required_by_manifest: dict[str, set[str]] = {}
        for label in REQUIRED_QUERY_LABELS:
            package, _target = label[2:].split(":", 1)
            manifest = f"{package}/Cargo.toml"
            required_by_manifest.setdefault(manifest, set()).add(label)
        for manifest, labels in required_by_manifest.items():
            entry = declared.get(manifest)
            self.assertIsInstance(entry, dict, manifest)
            self.assertIn(entry.get("label"), labels)
            target = entry["label"].split(":", 1)[1]
            self.assertNotEqual("cargo-manifest-ownership", target)

    def test_canonical_resources_are_buck_mapped_without_product_source_rewrites(self) -> None:
        expected_source_fragments = {
            "backend/app/src/lib.rs": (
                'include_str!("../../openapi/openapi.yaml")',
                'sqlx::migrate!("../crates/platform/db/migrations")',
            ),
            "backend/crates/platform/authz/src/cedar_pbac/map.rs": (
                'include_str!("../../../../../../docs/specs/cedar-pbac-coexistence-map.json")',
            ),
            "backend/crates/reporting/adapter-postgres/src/lib.rs": (
                'include_bytes!("../../../../../docs/reference/일일업무진행현황_0605.xlsx")',
                'include_bytes!("../../../../../docs/reference/업무일지_26.05.27.xlsx")',
            ),
        }
        for relative, fragments in expected_source_fragments.items():
            text = (REPO / relative).read_text(encoding="utf-8")
            for fragment in fragments:
                self.assertIn(fragment, text, relative)

    def test_first_party_uses_only_public_current_lock_dependency_labels(self) -> None:
        generated = (REPO / "backend/BUCK").read_text(encoding="utf-8")
        public_targets = {
            name
            for _kind, block in re.findall(
                r'(?ms)^([A-Za-z0-9_.]+)\(\n(.*?)^\)\n', generated
            )
            for name in re.findall(r'(?m)^    name = "([^"]+)",$', block)
            if '    visibility = ["PUBLIC"],' in block
        }
        self.assertGreater(len(public_targets), 0)
        for buck in (REPO / "backend").rglob("BUCK"):
            if buck == REPO / "backend/BUCK":
                continue
            text = buck.read_text(encoding="utf-8")
            self.assertNotIn("//third-party/rust", text, buck.as_posix())
            for target in re.findall(r'"//backend:([^"]+)"', text):
                self.assertIn(
                    target,
                    public_targets,
                    f"{buck.relative_to(REPO)} depends on private //backend:{target}",
                )

        for duplicate in (
            "backend/app/openapi.yaml",
            "backend/app/migrations",
            "backend/crates/platform/authz/cedar-pbac-coexistence-map.json",
            "backend/crates/reporting/adapter-postgres/templates",
        ):
            self.assertFalse((REPO / duplicate).exists(), duplicate)

    def test_canonical_sqlx_migrations_have_one_exact_buck_staging_contract(self) -> None:
        helper = REPO / "backend/crates/platform/db/sqlx_migration_sources.bzl"
        self.assertTrue(helper.is_file(), helper.relative_to(REPO))
        helper_text = helper.read_text(encoding="utf-8")
        self.assertIn(
            '"//backend/crates/platform/db:sqlx-migrations"', helper_text
        )
        self.assertIn('"backend/crates/platform/db"', helper_text)
        self.assertNotIn('"backend/crates/platform/db/migrations"', helper_text)

        for relative in (
            "backend/app/BUCK",
            "backend/crates/finance-gl/adapter-postgres/BUCK",
            "backend/crates/platform/db/BUCK",
        ):
            text = (REPO / relative).read_text(encoding="utf-8")
            self.assertIn(
                'load("//backend/crates/platform/db:sqlx_migration_sources.bzl", '
                '"with_canonical_sqlx_migrations")',
                text,
                relative,
            )
            self.assertIn("with_canonical_sqlx_migrations({", text, relative)
            self.assertNotIn(
                '"//backend/crates/platform/db:sqlx-migrations": '
                '"backend/crates/platform/db/migrations"',
                text,
                relative,
            )

        platform_db_buck = (
            REPO / "backend/crates/platform/db/BUCK"
        ).read_text(encoding="utf-8")
        for mapping in (
            '"buck2_contract_tests/canonical_migration_identities.generated.rs": '
            '"backend/buck2_contract_tests/platform_db/'
            'canonical_migration_identities.generated.rs"',
            '"buck2_contract_tests/period_lock_domain.rs": '
            '"backend/buck2_contract_tests/platform_db/period_lock_domain.rs"',
        ):
            self.assertEqual(1, platform_db_buck.count(mapping), mapping)
        self.assertNotIn(
            '"backend/crates/platform/db/buck2_contract_tests/', platform_db_buck
        )

        sentinel_source = (
            REPO
            / "backend/crates/platform/db/buck2_contract_tests/period_lock_domain.rs"
        ).read_text(encoding="utf-8")
        self.assertEqual(
            1, sentinel_source.count('sqlx::migrate!("./migrations")')
        )
        self.assertNotIn('sqlx::migrate!("migrations")', sentinel_source)

        receipt = load_json(GRAPH)
        migrations = receipt.get("canonical_sqlx_migrations")
        self.assertIsInstance(migrations, list)
        self.assertEqual(168, len(migrations))
        self.assertEqual(list(range(1, 169)), [item["version"] for item in migrations])
        self.assertEqual(
            "backend/crates/platform/db/migrations/0001_create_regions_branches.sql",
            migrations[0]["path"],
        )
        self.assertEqual(
            "backend/crates/platform/db/migrations/0026_create_organizations.sql",
            migrations[25]["path"],
        )
        self.assertEqual(
            "backend/crates/platform/db/migrations/0168_runtime_public_schema_usage.sql",
            migrations[-1]["path"],
        )
        for item in migrations:
            self.assertRegex(item["sha256"], r"^[0-9a-f]{64}$")
        identity_source = receipt.get("canonical_sqlx_migration_identity_source")
        self.assertEqual(
            "backend/crates/platform/db/buck2_contract_tests/"
            "canonical_migration_identities.generated.rs",
            identity_source.get("path"),
        )
        self.assertRegex(identity_source.get("sha256"), r"^[0-9a-f]{64}$")
        runtime_sentinel = receipt["canonical_sqlx_migration_staging"][
            "runtime_sentinel"
        ]
        self.assertEqual("./migrations", runtime_sentinel["migration_literal"])
        self.assertEqual(
            "backend/crates/platform/db/buck2_contract_tests/period_lock_domain.rs",
            runtime_sentinel["path"],
        )
        self.assertRegex(runtime_sentinel["sha256"], r"^[0-9a-f]{64}$")

        expected_buck_fragments = {
            "backend/app/BUCK": (
                'srcs_filegroup = ":mnt-app-rust-sources"',
                '"//backend/openapi:openapi-yaml": "backend/openapi/openapi.yaml"',
                "with_canonical_sqlx_migrations({",
            ),
            "backend/crates/platform/authz/BUCK": (
                'srcs_filegroup = ":mnt-platform-authz-rust-sources"',
                '"//docs/specs:cedar-pbac-coexistence-map": "docs/specs/cedar-pbac-coexistence-map.json"',
            ),
            "backend/crates/reporting/adapter-postgres/BUCK": (
                'srcs_filegroup = ":mnt-reporting-adapter-postgres-rust-sources"',
                '"//docs/reference:daily-status-template": "docs/reference/일일업무진행현황_0605.xlsx"',
                '"//docs/reference:work-diary-template": "docs/reference/업무일지_26.05.27.xlsx"',
            ),
        }
        for relative, fragments in expected_buck_fragments.items():
            text = (REPO / relative).read_text(encoding="utf-8")
            for fragment in fragments:
                self.assertIn(fragment, text, relative)

    def test_vendor_patches_and_multiversion_sqlx_have_one_exact_owner(self) -> None:
        generated = (REPO / "backend/BUCK").read_text(encoding="utf-8")
        for manifest_dir in (
            "vendor/calamine-0.35.0-quickxml41",
            "vendor/quick-xml-0.41.0-compat",
            "vendor/umya-spreadsheet-3.0.0-quickxml41",
        ):
            self.assertNotIn(
                f'"CARGO_MANIFEST_DIR": "{manifest_dir}"',
                generated,
                manifest_dir,
            )
        for fragment in (
            'name = "calamine",\n    actual = "//backend/vendor/calamine-0.35.0-quickxml41:calamine-0.35"',
            'name = "umya-spreadsheet",\n    actual = "//backend/vendor/umya-spreadsheet-3.0.0-quickxml41:umya-spreadsheet-3"',
            'name = "sqlx-0_8",\n    actual = ":sqlx-0.8"',
            'name = "sqlx",\n    actual = ":sqlx-0.9"',
        ):
            self.assertEqual(1, generated.count(fragment), fragment)

    def test_vendor_literal_include_resources_are_deterministically_bound(self) -> None:
        graph = load_json(GRAPH)
        receipt_resources = {
            item["path"]: item.get("literal_include_resources")
            for item in graph["buckfiles"]
            if item["path"].startswith("backend/vendor/")
        }
        for package in sorted((REPO / "backend/vendor").iterdir()):
            if not package.is_dir() or not (package / "Cargo.toml").is_file():
                continue
            resources: set[str] = set()
            for source in sorted((package / "src").rglob("*.rs")):
                for encoded in LITERAL_INCLUDE.findall(source.read_text(encoding="utf-8")):
                    literal = bytes(encoded, "utf-8").decode("unicode_escape")
                    resolved = (source.parent / literal).resolve(strict=True)
                    self.assertTrue(resolved.is_relative_to(package.resolve(strict=True)))
                    resources.add(resolved.relative_to(package).as_posix())
            buck_path = package / "BUCK"
            buck = buck_path.read_text(encoding="utf-8")
            for resource in resources:
                self.assertEqual(1, buck.count(f'        "{resource}",'), resource)
            relative_buck = buck_path.relative_to(REPO).as_posix()
            self.assertEqual(
                [
                    {
                        "path": resource,
                        "sha256": hashlib.sha256((package / resource).read_bytes()).hexdigest(),
                    }
                    for resource in sorted(resources)
                ],
                receipt_resources[relative_buck],
            )

    def test_cedar_policy_core_build_script_outputs_are_real_graph_inputs(self) -> None:
        generated = (REPO / "backend/BUCK").read_text(encoding="utf-8")
        for fragment in (
            '"OUT_DIR": "$(location :cedar-policy-core-4-build-script-run[out_dir])"',
            'rustc_flags = ["@$(location :cedar-policy-core-4-build-script-run[rustc_flags])"]',
            'name = "cedar-policy-core-4-build-script-build"',
            'crate_root = "cedar-policy-core-4.11.2.crate/build.rs"',
            'name = "cedar-policy-core-4-build-script-run"',
            'package_name = "cedar-policy-core"',
            'buildscript_rule = ":cedar-policy-core-4-build-script-build"',
            'version = "4.11.2"',
        ):
            self.assertEqual(1, generated.count(fragment), fragment)
        self.assertEqual(
            [
                {
                    "library_target": "//backend:cedar-policy-core-4",
                    "buildscript_target": (
                        "//backend:cedar-policy-core-4-build-script-build"
                    ),
                    "runner_target": "//backend:cedar-policy-core-4-build-script-run",
                    "package_name": "cedar-policy-core",
                    "version": "4.11.2",
                }
            ],
            load_json(GRAPH).get("required_buildscripts"),
        )

    def test_app_unit_graph_declares_its_dev_only_tower_dependency(self) -> None:
        buck = (REPO / "backend/app/BUCK").read_text(encoding="utf-8")
        match = re.search(
            r'(?ms)^rust_test\(\n    name = "mnt-app-unit",\n(.*?)^\)\n', buck
        )
        self.assertIsNotNone(match)
        self.assertIn('deps = _MNT_APP_DEPS + ["//backend:tower"]', match.group(1))

    def test_openssl_is_an_exact_native_current_lock_dependency(self) -> None:
        graph = load_json(GRAPH)
        native = graph.get("required_native_dependencies")
        self.assertIsInstance(native, list)
        self.assertEqual(1, len(native))
        self.assertEqual("toolchains//:openssl-static", native[0].get("label"))
        self.assertEqual("3.6.3", native[0].get("version"))
        self.assertEqual(4, len(native[0].get("platforms", [])))
        generated = (REPO / "backend/BUCK").read_text(encoding="utf-8")
        self.assertNotIn("openssl-sys-0.9-build-script", generated)
        self.assertNotIn("openssl-0.10-build-script", generated)


if __name__ == "__main__":
    unittest.main()
