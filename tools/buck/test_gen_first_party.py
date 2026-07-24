#!/usr/bin/env python3
"""Behavior locks for the first-party Rust BUCK graph generator."""

import importlib.util
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

    def test_manifest_env_is_hermetic_and_repo_relative(self) -> None:
        env = GENERATOR.base_env("backend/crates/example", uses_sqlx=True)

        self.assertEqual(env["CARGO_MANIFEST_DIR"], "backend/crates/example")
        self.assertEqual(env["SQLX_OFFLINE"], "true")
        self.assertEqual(
            env["SQLX_OFFLINE_DIR"],
            "$(location //backend:sqlx-offline)",
        )

    def test_production_parser_unit_target_stays_hermetic(self) -> None:
        self.assertIn("mnt-production-rest", GENERATOR.PURE_UNIT_PACKAGES)


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


if __name__ == "__main__":
    unittest.main()
