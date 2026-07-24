#!/usr/bin/env python3
"""Behavior locks for the first-party Rust BUCK graph generator."""

import importlib.util
import inspect
import subprocess
import sys
import unittest
from pathlib import Path


GENERATOR_PATH = Path(__file__).with_name("gen_first_party.py")
SPEC = importlib.util.spec_from_file_location("gen_first_party", GENERATOR_PATH)
assert SPEC is not None and SPEC.loader is not None
GENERATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GENERATOR)


class FirstPartyBuckGeneratorTests(unittest.TestCase):
    def test_repo_source_layout_uses_mapped_sources_and_explicit_crate_root(self) -> None:
        block = "\n".join(
            GENERATOR._block(
                "rust_library",
                "example",
                'glob(["src/**/*.rs"])',
                "example",
                [],
                {},
                {"CARGO_MANIFEST_DIR": "backend/crates/example"},
                package="backend/crates/example",
                crate_root="backend/crates/example/src/lib.rs",
                external={
                    "//docs/specs:cedar-pbac-map": (
                        "docs/specs/cedar-pbac-coexistence-map.json"
                    ),
                },
            )
        )

        self.assertIn(
            'mapped_srcs = repo_mapped_srcs("backend/crates/example", '
            'glob(["src/**/*.rs"]), external = {',
            block,
        )
        self.assertIn(
            '"//docs/specs:cedar-pbac-map": '
            '"docs/specs/cedar-pbac-coexistence-map.json"',
            block,
        )
        self.assertIn(
            'crate_root = "backend/crates/example/src/lib.rs"',
            block,
        )
        self.assertNotIn("\n    srcs =", block)

    def test_generation_is_clean_for_all_first_party_buck_faces(self) -> None:
        subprocess.run(
            [sys.executable, str(GENERATOR_PATH)],
            cwd=GENERATOR.REPO,
            check=True,
            capture_output=True,
            text=True,
        )
        buck_files = [
            str(Path(directory).relative_to(GENERATOR.REPO) / "BUCK")
            for directory in GENERATOR.find_members()
        ]
        result = subprocess.run(
            ["git", "diff", "--quiet", "--", *buck_files],
            cwd=GENERATOR.REPO,
            check=False,
        )
        self.assertEqual(0, result.returncode, "generated BUCK faces are stale")

    def test_compile_time_resource_contracts_are_declared(self) -> None:
        resources = GENERATOR.RESOURCE_CONFIG

        self.assertEqual(
            resources["mnt-platform-authz"]["external"][
                "//docs/specs:cedar-pbac-map"
            ],
            "docs/specs/cedar-pbac-coexistence-map.json",
        )
        self.assertEqual(
            resources["mnt-reporting-adapter-postgres"]["external"][
                "//docs/reference:daily-progress"
            ],
            "docs/reference/일일업무진행현황_0605.xlsx",
        )
        self.assertEqual(
            resources["mnt-app"]["external"]["//backend/openapi:openapi.yaml"],
            "backend/openapi/openapi.yaml",
        )

    def test_sqlx_tests_map_the_authoritative_migration_tree(self) -> None:
        external = GENERATOR.integration_external_resources(
            "mnt-leave-adapter-postgres",
            "tests/leave_migration_expand_contract.rs",
            '#[sqlx::test(migrations = "../../platform/db/migrations")]',
        )

        self.assertEqual(
            external["//backend/crates/platform/db/migrations:tree"],
            "backend/crates/platform/db/migrations",
        )

    def test_openapi_drift_maps_real_rest_source_trees(self) -> None:
        config = GENERATOR.integration_resource_config(
            "mnt-app",
            "tests/openapi_drift.rs",
        )

        self.assertIn("src/**/*.rs", config["srcs"])
        self.assertEqual(
            config["external"][
                "//backend/crates/dispatch/rest:crate-source-tree"
            ],
            "backend/crates/dispatch/rest/src",
        )
        self.assertEqual(
            config["external"]["//backend/openapi:openapi.yaml"],
            "backend/openapi/openapi.yaml",
        )
        self.assertEqual(
            config["external"]["//backend/crates/equipment/rest:crate-source-tree"],
            "backend/crates/equipment/rest/src",
        )

    def test_manifest_env_is_hermetic_and_repo_relative(self) -> None:
        env = GENERATOR.base_env("backend/crates/example", uses_sqlx=True)

        self.assertEqual(env["CARGO_MANIFEST_DIR"], "backend/crates/example")
        self.assertEqual(env["SQLX_OFFLINE"], "true")
        self.assertEqual(
            env["SQLX_OFFLINE_DIR"],
            "$(location //backend:sqlx-offline)",
        )

    def test_production_parser_unit_target_stays_hermetic(self) -> None:
        self.assertFalse(
            GENERATOR.requires_postgres("mnt-production-rest", "test.unit")
        )

    def test_mnt_app_inline_postgres_variant_is_feature_gated(self) -> None:
        variant = GENERATOR.INLINE_TEST_VARIANTS["mnt-app"][0]
        app_dir = Path(GENERATOR.REPO) / "backend" / "app"
        manifest = GENERATOR.load(app_dir)
        app_source = (app_dir / "src").glob("**/*.rs")
        source_text = "\n".join(path.read_text(encoding="utf-8") for path in app_source)

        self.assertEqual("itest-inline-postgres", variant["name"])
        self.assertEqual("test-postgres", variant["feature"])
        self.assertEqual("postgres", variant["resource"])
        self.assertEqual([], manifest["features"]["test-postgres"])
        self.assertNotIn("default", manifest["features"])
        self.assertEqual(151, source_text.count('#[cfg(not(feature = "test-postgres"))]'))
        self.assertEqual(17, source_text.count("#[sqlx::test"))
        self.assertEqual(17, source_text.count('#[cfg(feature = "test-postgres")]'))

    def test_inline_test_variants_reject_missing_manifest_features(self) -> None:
        with self.assertRaisesRegex(ValueError, "feature is absent"):
            GENERATOR.validate_inline_test_variants(
                {"mnt-app": {"features": {}}}
            )


class TestTaxonomy(unittest.TestCase):
    def test_every_test_has_exactly_one_type_and_resource_label(self) -> None:
        for package in (
            "backend/app",
            "backend/ci/contract-tests",
            "backend/crates/logistics/domain",
            "backend/crates/platform/authz-rest",
        ):
            for test_type in GENERATOR.TEST_TYPE_LABELS:
                for uses_postgres in (False, True):
                    labels = GENERATOR.test_labels(package, test_type, uses_postgres)
                    self.assertEqual(
                        1,
                        len(set(labels) & GENERATOR.TEST_TYPE_LABELS),
                    )
                    self.assertEqual(
                        1,
                        len(set(labels) & GENERATOR.RESOURCE_LABELS),
                    )
                    self.assertEqual("needs-postgres" in labels, uses_postgres)

    def test_ownership_labels_are_path_derived_and_deterministic(self) -> None:
        package = "backend/crates/logistics/adapter-postgres"
        expected = [
            "owner.backend.crates.logistics.adapter-postgres",
            "domain.logistics",
        ]
        self.assertEqual(expected, GENERATOR.ownership_labels(package))
        self.assertEqual(expected, GENERATOR.ownership_labels(package))
        self.assertEqual(
            ["owner.backend.app", "domain.app"],
            GENERATOR.ownership_labels("backend/app"),
        )

    def test_unknown_test_type_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            GENERATOR.test_labels("backend/app", "test.e2e", False)

class TestResourceClassification(unittest.TestCase):
    def test_benefit_and_facilities_units_are_hermetic_even_when_sources_mention_postgres(self) -> None:
        for package in ("mnt-benefit-rest", "mnt-facilities-rest"):
            self.assertFalse(GENERATOR.requires_postgres(package, "test.unit"))
            labels = GENERATOR.test_labels(
                "backend/crates/{}/rest".format(package.removeprefix("mnt-").removesuffix("-rest")),
                "test.unit",
                GENERATOR.requires_postgres(package, "test.unit"),
            )
            self.assertIn("resource.none", labels)
            self.assertNotIn("resource.postgres", labels)

    def test_comments_and_unrelated_library_code_cannot_require_postgres(self) -> None:
        self.assertNotIn("PgPool", inspect.getsource(GENERATOR.requires_postgres))
        self.assertFalse(GENERATOR.requires_postgres("mnt-facilities-rest", "test.unit"))
        with self.assertRaisesRegex(ValueError, "missing reviewed resource metadata"):
            GENERATOR.requires_postgres(
                "mnt-facilities-rest", "test.integration", "tests/comment_only.rs"
            )

    def test_reviewed_database_integration_target_is_postgres_bound(self) -> None:
        self.assertTrue(
            GENERATOR.requires_postgres(
                "mnt-benefit-adapter-postgres",
                "test.integration",
                "tests/catalog_rls_surfaces_as_runtime_role.rs",
            )
        )
        labels = GENERATOR.test_labels(
            "backend/crates/benefit/adapter-postgres", "test.integration", True
        )
        self.assertIn("resource.postgres", labels)
        self.assertIn("needs-postgres", labels)

    def test_attendance_self_service_integration_is_postgres_bound(self) -> None:
        self.assertTrue(
            GENERATOR.requires_postgres(
                "mnt-attendance-adapter-postgres",
                "test.integration",
                "tests/self_service.rs",
            )
        )

    def test_equipment_discoveries_have_reviewed_resources(self) -> None:
        self.assertTrue(
            GENERATOR.requires_postgres(
                "mnt-app", "test.integration", "tests/equipment_3r_api.rs"
            )
        )
        self.assertFalse(GENERATOR.requires_postgres("mnt-equipment-domain", "test.unit"))

    def test_integration_resource_lookup_requires_a_target_path(self) -> None:
        with self.assertRaises(ValueError):
            GENERATOR.requires_postgres("mnt-benefit-adapter-postgres", "test.integration")

    def test_unreviewed_discovered_test_fails_generation_preflight(self) -> None:
        discovered = {
            ("mnt-benefit-rest", "test.unit", None),
            ("mnt-benefit-rest", "test.integration", "tests/unreviewed.rs"),
        }
        requirements = {"mnt-benefit-rest": {"unit": "none"}}
        with self.assertRaisesRegex(ValueError, "missing"):
            GENERATOR.validate_resource_metadata(discovered, requirements)

    def test_metadata_is_exhaustive_for_current_generator_targets(self) -> None:
        discovered = set()
        for directory in GENERATOR.find_members():
            package = GENERATOR.load(directory)["package"]["name"]
            discovered.update(GENERATOR.discovered_test_resource_keys(directory, package))
        GENERATOR.validate_resource_metadata(discovered)

    def test_every_discovered_target_has_exactly_one_test_and_resource_label(self) -> None:
        for directory in GENERATOR.find_members():
            package_name = GENERATOR.load(directory)["package"]["name"]
            package_path = str(Path(directory).relative_to(GENERATOR.REPO))
            for _, test_type, test_file in GENERATOR.discovered_test_resource_keys(
                directory, package_name
            ):
                labels = GENERATOR.test_labels(
                    package_path,
                    test_type,
                    GENERATOR.requires_postgres(package_name, test_type, test_file),
                )
                self.assertEqual(1, len(set(labels) & GENERATOR.TEST_TYPE_LABELS))
                self.assertEqual(1, len(set(labels) & GENERATOR.RESOURCE_LABELS))


if __name__ == "__main__":
    unittest.main()
