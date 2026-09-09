#!/usr/bin/env python3
"""Behavior locks for the first-party Rust BUCK graph generator."""

import importlib.util
import inspect
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


GENERATOR_PATH = Path(__file__).with_name("gen_first_party.py")
SPEC = importlib.util.spec_from_file_location("gen_first_party", GENERATOR_PATH)
assert SPEC is not None and SPEC.loader is not None
GENERATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GENERATOR)


class FirstPartyBuckGeneratorTests(unittest.TestCase):
    def test_ui_package_members_are_skipped_because_leptos_is_not_vendored(self) -> None:
        self.assertTrue(
            GENERATOR.skip_workspace_member({"package": {"name": "console-payroll-ui"}})
        )
        self.assertTrue(
            GENERATOR.skip_workspace_member({"package": {"name": "console-platform-ui"}})
        )
        self.assertFalse(
            GENERATOR.skip_workspace_member({"package": {"name": "console-payroll-rest"}})
        )
        self.assertFalse(
            GENERATOR.skip_workspace_member({"package": {"name": "console-platform-auth"}})
        )
        self.assertFalse(GENERATOR.skip_workspace_member({"package": {"name": "ui"}}))
        self.assertFalse(GENERATOR.skip_workspace_member({}))
        self.assertFalse(GENERATOR.skip_workspace_member({"package": {}}))

    def test_skipped_ui_dependency_is_omitted_not_rewritten_as_third_party(self) -> None:
        first_party = {"console-app": "//backend/app:console-app"}
        skipped = frozenset({"console-payroll-ui"})
        deps, named = GENERATOR.map_deps(
            {"console-payroll-ui": {"path": "crates/payroll/ui"}},
            first_party,
            skipped,
        )
        self.assertEqual([], deps)
        self.assertEqual({}, named)
        self.assertNotIn("//third-party/rust:console-payroll-ui", deps)

    def test_app_without_ui_dep_does_not_gain_a_ui_edge(self) -> None:
        app_dir = Path(GENERATOR.REPO) / "backend" / "app"
        manifest = GENERATOR.load(app_dir)
        first_party = {}
        for directory in GENERATOR.find_members():
            name = GENERATOR.load(directory)["package"]["name"]
            rel = str(Path(directory).relative_to(GENERATOR.REPO))
            first_party[name] = "//{}:{}".format(rel, name)
        deps, named = GENERATOR.map_deps(
            manifest.get("dependencies"),
            first_party,
            GENERATOR.skipped_ui_package_names(),
        )
        self.assertFalse(
            any("-ui" in target for target in deps),
            "App must not invent a Ui edge; got {}".format(deps),
        )
        self.assertFalse(
            any("-ui" in target for target in named.values()),
            "App must not invent a named Ui edge; got {}".format(named),
        )

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
            resources["console-platform-authz"]["external"][
                "//docs/specs:cedar-pbac-map"
            ],
            "docs/specs/cedar-pbac-coexistence-map.json",
        )
        self.assertEqual(
            resources["console-reporting-adapter-postgres"]["external"][
                "//docs/reference:daily-progress"
            ],
            "docs/reference/일일업무진행현황_0605.xlsx",
        )
        self.assertEqual(
            resources["console-app"]["external"]["//backend/openapi:openapi.yaml"],
            "backend/openapi/openapi.yaml",
        )

    def test_sqlx_tests_map_the_authoritative_migration_tree(self) -> None:
        external = GENERATOR.integration_external_resources(
            "console-leave-adapter-postgres",
            "tests/leave_migration_expand_contract.rs",
            '#[sqlx::test(migrations = "../../platform/db/migrations")]',
        )

        self.assertEqual(
            external["//backend/crates/platform/db/migrations:tree"],
            "backend/crates/platform/db/migrations",
        )

    def test_openapi_drift_maps_real_rest_source_trees(self) -> None:
        config = GENERATOR.integration_resource_config(
            "console-app",
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

    def test_openapi_drift_maps_every_compile_time_resource(self) -> None:
        test_path = Path(GENERATOR.REPO) / "backend/app/tests/openapi_drift.rs"
        source = test_path.read_text(encoding="utf-8")
        include_paths = re.findall(r'include_str!\(\s*"([^"]+)"', source)
        config = GENERATOR.integration_resource_config(
            "console-app",
            "tests/openapi_drift.rs",
        )
        mapped_roots = [
            Path(GENERATOR.REPO) / destination
            for destination in config["external"].values()
        ]
        app_source_root = Path(GENERATOR.REPO) / "backend/app/src"
        app_package_root = Path(GENERATOR.REPO) / "backend/app"

        def itest_src_maps(resource: Path, src_pattern: str) -> bool:
            # Package-relative itest srcs resolve against backend/app/.
            if "*" not in src_pattern:
                return resource == (app_package_root / src_pattern).resolve()
            prefix = src_pattern.split("*", 1)[0].rstrip("/")
            root = (app_package_root / prefix).resolve()
            return resource == root or (root.is_dir() and resource.is_relative_to(root))

        unmapped = []
        for include_path in include_paths:
            resource = (test_path.parent / include_path).resolve()
            self.assertTrue(resource.exists(), f"missing include_str resource: {resource}")
            if resource.is_relative_to(app_source_root):
                continue
            if any(
                resource == mapped_root
                or (mapped_root.is_dir() and resource.is_relative_to(mapped_root))
                for mapped_root in mapped_roots
            ):
                continue
            if any(itest_src_maps(resource, src) for src in config.get("srcs", [])):
                continue
            unmapped.append(str(resource.relative_to(GENERATOR.REPO)))

        self.assertEqual([], unmapped, "openapi_drift has unmapped include_str resources")

    def test_openapi_fragment_globs_detect_tree_and_include_str(self) -> None:
        governance = Path(GENERATOR.REPO) / "backend/crates/governance/rest"
        src = governance / "src"
        pats = GENERATOR.openapi_fragment_globs(str(governance), str(src))
        self.assertEqual(
            ["openapi/**/*.yaml", "openapi/**/*.json"],
            pats,
            "governance rest must map YAML + manifest.json under openapi/",
        )

        # include_str marker alone (no openapi/ dir) still emits YAML so examined-zero
        # cannot silently pass — buck/rustc fail closed when fragments are absent.
        bare = Path(GENERATOR.REPO) / "backend/crates/contracts"
        bare_src = bare / "src"
        # contracts has no openapi/ sibling and no ../openapi include_str in src
        self.assertEqual([], GENERATOR.openapi_fragment_globs(str(bare), str(bare_src)))

    def test_rest_faces_with_openapi_tree_map_fragment_globs_in_buck(self) -> None:
        """Lock: every first-party package with openapi/ must map fragments in BUCK.

        Examined-zero fails: if no openapi trees exist this assertion is wrong;
        if trees exist but BUCK omits the glob, the list is non-empty (RED).
        """
        missing = []
        examined = 0
        for directory in GENERATOR.find_members():
            openapi = Path(directory) / "openapi"
            if not openapi.is_dir():
                continue
            examined += 1
            buck = Path(directory) / "BUCK"
            text = buck.read_text(encoding="utf-8")
            if "openapi/**/*.yaml" not in text:
                missing.append(str(Path(directory).relative_to(GENERATOR.REPO)))
        self.assertGreater(
            examined,
            0,
            "expected at least one first-party crate with an openapi/ tree",
        )
        self.assertEqual(
            [],
            missing,
            "BUCK faces missing openapi/**/*.yaml mapped_srcs (regenerate gen_first_party)",
        )

    def test_openapi_dotfile_srcs_and_lib_srcs_expr_include_hidden(self) -> None:
        """Lock: Buck2 glob omits leading-dot basenames; generator must union them.

        Would have failed on tip 3c803bdc4 where identity BUCK used only
        glob(["...","openapi/**/*.yaml","openapi/**/*.json"]) with no explicit
        .well-known__* listsrcs union (CI Backend include_str missing those files).
        """
        identity = Path(GENERATOR.REPO) / "backend/crates/identity/rest"
        expected = [
            "openapi/paths/.well-known__apple-app-site-association.get.yaml",
            "openapi/paths/.well-known__assetlinks.json.get.yaml",
        ]
        found = GENERATOR.openapi_dotfile_srcs(str(identity))
        self.assertEqual(expected, found)

        # Temp tree: any leading-dot component must appear in emitted srcs expr.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            hidden = root / "openapi" / "paths" / ".hidden.yaml"
            hidden.parent.mkdir(parents=True)
            hidden.write_text("x: 1\n", encoding="utf-8")
            (root / "openapi" / "paths" / "visible.yaml").write_text("y: 2\n", encoding="utf-8")
            dots = GENERATOR.openapi_dotfile_srcs(str(root))
            self.assertEqual(["openapi/paths/.hidden.yaml"], dots)
            expr = GENERATOR.lib_srcs_expr(
                ["src/**/*.rs", "openapi/**/*.yaml"],
                explicit=dots,
            )
            self.assertIn('glob(["src/**/*.rs", "openapi/**/*.yaml"])', expr)
            self.assertIn('"openapi/paths/.hidden.yaml"', expr)
            self.assertIn(" + ", expr)

    def test_identity_rest_buck_maps_well_known_openapi_dotfiles(self) -> None:
        """Examined-zero lock: identity BUCK mapped_srcs must name both .well-known files.

        Plain openapi/**/*.yaml glob is insufficient on Buck2 (dot basenames excluded).
        """
        buck = Path(GENERATOR.REPO) / "backend/crates/identity/rest" / "BUCK"
        text = buck.read_text(encoding="utf-8")
        for path in (
            "openapi/paths/.well-known__apple-app-site-association.get.yaml",
            "openapi/paths/.well-known__assetlinks.json.get.yaml",
        ):
            self.assertIn(
                path,
                text,
                "identity rest BUCK must list {} after gen_first_party regen".format(path),
            )
        self.assertIn(
            " + ",
            text,
            "identity rest BUCK must union listsrcs for openapi dotfiles",
        )

    def test_workbench_integration_test_maps_its_path_module(self) -> None:
        config = GENERATOR.integration_resource_config(
            "console-app",
            "tests/workbench_api.rs",
        )

        self.assertIn("src/workbench.rs", config["srcs"])

    def test_cross_package_path_modules_are_explicit_mapped_inputs(self) -> None:
        expected = {
            ("console-dispatch-worker", "tests/timer_delivery.rs"): {
                "//backend/test_support:dispatch-worker-fixtures":
                    "backend/test_support/dispatch_worker_fixtures.rs",
            },
            ("console-workorder-rest", "tests/mobile_device_registration.rs"): {
                "//backend/test_support:mobile-evidence-fixtures":
                    "backend/test_support/mobile_evidence_fixtures.rs",
            },
            ("console-workorder-rest", "tests/mobile_evidence.rs"): {
                "//backend/test_support:mobile-evidence-fixtures":
                    "backend/test_support/mobile_evidence_fixtures.rs",
            },
            ("console-workorder-rest", "tests/mobile_sync.rs"): {
                "//backend/test_support:mobile-evidence-fixtures":
                    "backend/test_support/mobile_evidence_fixtures.rs",
            },
        }

        for (crate, test_file), external in expected.items():
            config = GENERATOR.integration_resource_config(crate, test_file)
            self.assertEqual(external, config["external"], f"{crate}:{test_file}")

    def test_cargo_pkg_version_env_tracks_source_references(self) -> None:
        """Cargo defines CARGO_PKG_VERSION for every crate; Buck2 does not.

        A crate that reaches for it through `env!` cannot compile under Buck
        unless the generator supplies it, which is how #1015 turned the Buck
        leg red -- `console-contracts` stamps the composed OpenAPI version from
        it, so every Buck target depending on contracts stopped building.

        The version deliberately is not `0.1.0`: every versioned member of this
        workspace is `0.1.0`, so a helper that ignored its `version` argument
        entirely would satisfy a test written against that value.
        """
        self.assertEqual(
            GENERATOR.cargo_pkg_version_env("pub const UNRELATED: u8 = 1;", "9.9.9-test"),
            {},
            "a unit that never names CARGO_PKG_VERSION must not carry it",
        )
        self.assertEqual(
            GENERATOR.cargo_pkg_version_env(
                'pub const V: &str = env!("CARGO_PKG_VERSION");', "9.9.9-test"
            ),
            {"CARGO_PKG_VERSION": "9.9.9-test"},
            "the emitted value must be this package's version, not a constant",
        )
        # `CARGO_PKG_VERSION_MAJOR` is a different variable. A substring match
        # would define VERSION, leave rustc failing on _MAJOR, and report success.
        self.assertEqual(
            GENERATOR.cargo_pkg_version_env(
                'env!("CARGO_PKG_VERSION_MAJOR")', "9.9.9-test"
            ),
            {},
            "a longer CARGO_PKG_VERSION_* name must not be read as VERSION",
        )

    def test_cargo_pkg_version_resolves_the_version_cargo_would_use(self) -> None:
        """23 members omit `version` from `[package]`. Cargo's documented
        default is 0.0.0, and `[workspace.package]` declares none to inherit, so
        refusing them would abort generation for the whole repository the first
        time one of them mentioned the variable -- in a comment, even."""
        self.assertEqual(GENERATOR.resolved_package_version("0.1.0"), "0.1.0")
        self.assertEqual(GENERATOR.resolved_package_version(None), "0.0.0")
        self.assertEqual(GENERATOR.resolved_package_version(""), "0.0.0")
        # `version.workspace = true` parses as a dict. Rendering it would put a
        # Python repr in BUCK as the crate version, so it fails closed instead.
        with self.assertRaises(ValueError):
            GENERATOR.resolved_package_version({"workspace": True})

    def test_cargo_pkg_version_is_scoped_to_the_referencing_target(self) -> None:
        """The library, the binary built from `main.rs`, and each integration
        test are separate compilation units. A single crate-level scan attaches
        the variable to whichever targets happen to come from `src/` -- too
        broad for a library that never names it, and too narrow for the binary
        and the integration tests, which are exactly where `--version` lives.
        """
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "src"
            src.mkdir()
            (src / "lib.rs").write_text("pub fn helper() {}\n", encoding="utf-8")
            (src / "main.rs").write_text(
                'fn main() { println!("{}", env!("CARGO_PKG_VERSION")); }\n',
                encoding="utf-8",
            )

            library = GENERATOR.cargo_pkg_version_env(
                GENERATOR.read_rs_sources(str(src), exclude=("main.rs",)), "9.9.9-test"
            )
            binary = GENERATOR.cargo_pkg_version_env(
                GENERATOR.file_text(str(src / "main.rs")), "9.9.9-test"
            )
            self.assertEqual(
                library, {}, "the library never names it; main.rs is not its unit"
            )
            self.assertEqual(
                binary,
                {"CARGO_PKG_VERSION": "9.9.9-test"},
                "the binary compiles main.rs and must carry it",
            )

            integration = GENERATOR.cargo_pkg_version_env(
                '#[test]\nfn v() { assert!(!env!("CARGO_PKG_VERSION").is_empty()); }\n',
                "9.9.9-test",
            )
            self.assertEqual(
                integration,
                {"CARGO_PKG_VERSION": "9.9.9-test"},
                "an integration test is its own compilation unit",
            )

    def test_emit_scopes_cargo_pkg_version_to_the_referencing_target(self) -> None:
        """Drives `emit` itself, not the helper.

        Asserting the helper on hand-built strings proves it is right when fed
        the right text; it cannot see whether `emit` feeds the right text to
        the right target, which is the entire defect class here -- the variable
        landing on a library that never names it while the binary that does
        goes without, and integration tests being skipped altogether.

        Reverting any of those wirings leaves the helper tests green, so this
        is the pin that holds them.
        """
        probe = Path(GENERATOR.REPO) / "tools" / "buck" / "_probe_crate"
        # Tolerate a fixture left by a hard interrupt rather than failing once
        # on the next run.
        shutil.rmtree(probe, ignore_errors=True)
        GENERATOR.TEST_RESOURCE_REQUIREMENTS["probe-crate"] = {
            "unit": "none",
            "integration": {"tests/probe.rs": "none"},
        }
        # A feature variant so the second `rust_binary` block is exercised too;
        # it takes its own env and regressed independently of the plain one.
        GENERATOR.FEATURE_LIBRARY_VARIANTS["probe-crate"] = {"probe-feature": {"deps": {}}}
        try:
            (probe / "src").mkdir(parents=True)
            # `#[cfg(test)]` so a `-unit` face is generated: it shares the
            # library's compilation unit, so it must track the library's answer.
            (probe / "src" / "lib.rs").write_text(
                "pub fn helper() {}\n#[cfg(test)]\nmod t {}\n", encoding="utf-8"
            )
            (probe / "src" / "main.rs").write_text(
                'fn main() { println!("{}", env!("CARGO_PKG_VERSION")); }\n',
                encoding="utf-8",
            )
            (probe / "tests").mkdir()
            (probe / "tests" / "probe.rs").write_text(
                '#[test]\nfn v() { assert!(!env!("CARGO_PKG_VERSION").is_empty()); }\n',
                encoding="utf-8",
            )
            GENERATOR.emit(
                str(probe), "probe-crate", [], {}, [], {}, version="9.9.9-test"
            )
            faces = self._buck_targets((probe / "BUCK").read_text(encoding="utf-8"))
        finally:
            shutil.rmtree(probe, ignore_errors=True)
            GENERATOR.TEST_RESOURCE_REQUIREMENTS.pop("probe-crate", None)
            GENERATOR.FEATURE_LIBRARY_VARIANTS.pop("probe-crate", None)

        self.assertEqual(
            faces.get("probe-crate"),
            True,
            "the binary compiles main.rs, which names it",
        )
        self.assertEqual(
            faces.get("probe-crate-lib"),
            False,
            "the library never names it; main.rs is not its compilation unit",
        )
        self.assertEqual(
            faces.get("probe-crate-itest-probe"),
            True,
            "an integration test is its own compilation unit",
        )
        self.assertEqual(
            faces.get("probe-crate-probe-feature"),
            True,
            "the feature-variant binary compiles the same main.rs",
        )
        self.assertEqual(
            faces.get("probe-crate-lib-probe-feature"),
            False,
            "its library variant still never names it",
        )
        self.assertEqual(
            faces.get("probe-crate-unit"),
            False,
            "the unit face shares the library's unit, which never names it",
        )
    def test_emit_uses_cargos_default_version_for_versionless_crates(self) -> None:
        """23 members omit `version`; rendering `None` into BUCK would be worse
        than the abort it replaced."""
        probe = Path(GENERATOR.REPO) / "tools" / "buck" / "_probe_versionless"
        shutil.rmtree(probe, ignore_errors=True)
        GENERATOR.TEST_RESOURCE_REQUIREMENTS["probe-versionless"] = {"unit": "none"}
        try:
            (probe / "src").mkdir(parents=True)
            (probe / "src" / "lib.rs").write_text(
                'pub const V: &str = env!("CARGO_PKG_VERSION");\n'
                "#[cfg(test)]\nmod t {}\n",
                encoding="utf-8",
            )
            GENERATOR.emit(str(probe), "probe-versionless", [], {}, [], {}, version=None)
            buck = (probe / "BUCK").read_text(encoding="utf-8")
            faces = self._buck_targets(buck)
        finally:
            shutil.rmtree(probe, ignore_errors=True)
            GENERATOR.TEST_RESOURCE_REQUIREMENTS.pop("probe-versionless", None)
        self.assertIn('"CARGO_PKG_VERSION": "0.0.0"', buck)
        self.assertNotIn("None", buck)
        # The unit face is built from the same sources as the library, so it
        # must carry the same answer. Asserting this on a library that DOES
        # name the variable is what pins the unit block's env wiring -- with a
        # library that never names it, both the correct and the broken form
        # render the same absent value.
        self.assertEqual(
            faces.get("probe-versionless"),
            True,
            "the library names it",
        )
        self.assertEqual(
            faces.get("probe-versionless-unit"),
            True,
            "the unit face shares the library's compilation unit",
        )

    @staticmethod
    def _buck_targets(buck: str) -> "dict[str, bool]":
        """{target name: does its env define CARGO_PKG_VERSION}."""
        found = {}
        for match in re.finditer(
            r"rust_\w+\(\s*\n\s*name = \"([^\"]+)\"(.*?)\n\)", buck, re.S
        ):
            found[match.group(1)] = "CARGO_PKG_VERSION" in match.group(2)
        return found

    def test_contracts_buck_carries_cargo_pkg_version(self) -> None:
        """The concrete crate that broke the Buck leg."""
        buck = (
            Path(GENERATOR.REPO) / "backend" / "crates" / "contracts" / "BUCK"
        ).read_text(encoding="utf-8")
        # The value, not just the key: asserting the key alone leaves the
        # `main()` -> `emit` seam unpinned, so a caller that stopped passing
        # `version` would still emit the variable, at Cargo's 0.0.0 default.
        self.assertIn(
            '"CARGO_PKG_VERSION": "0.1.0"',
            buck,
            "console-contracts stamps env!(CARGO_PKG_VERSION); Buck must define "
            "it, and with the crate's own version",
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
            GENERATOR.requires_postgres("console-production-rest", "test.unit")
        )

    def test_console_app_inline_postgres_variant_is_feature_gated(self) -> None:
        variant = GENERATOR.INLINE_TEST_VARIANTS["console-app"][0]
        app_dir = Path(GENERATOR.REPO) / "backend" / "app"
        manifest = GENERATOR.load(app_dir)
        app_source = (app_dir / "src").glob("**/*.rs")
        source_text = "\n".join(path.read_text(encoding="utf-8") for path in app_source)

        self.assertEqual("itest-inline-postgres", variant["name"])
        self.assertEqual("test-postgres", variant["feature"])
        self.assertEqual("postgres", variant["resource"])
        self.assertEqual([], manifest["features"]["test-postgres"])
        self.assertNotIn("default", manifest["features"])
        ordinary_tests = re.findall(r"^\s*#\[(?:test|tokio::test)\]", source_text, re.MULTILINE)
        ordinary_gates = re.findall(
            r'^\s*#\[cfg\(not\(feature = "test-postgres"\)\)\]\n\s*#\[(?:test|tokio::test)\]',
            source_text,
            re.MULTILINE,
        )
        sqlx_tests = re.findall(r"^\s*#\[sqlx::test", source_text, re.MULTILINE)
        sqlx_gates = re.findall(
            r'^\s*#\[cfg\(feature = "test-postgres"\)\]\n\s*#\[sqlx::test',
            source_text,
            re.MULTILINE,
        )
        self.assertEqual(164, len(ordinary_tests))
        self.assertEqual(len(ordinary_tests), len(ordinary_gates))
        self.assertEqual(23, len(sqlx_tests))
        self.assertEqual(len(sqlx_tests), len(sqlx_gates))
        self.assertEqual(
            ("dev-auth",),
            GENERATOR.integration_test_features(
                "console-app", "tests/dev_auth_persona_guard_feature.rs"
            ),
        )

    def test_dev_auth_feature_variants_propagate_through_app_and_auth_rest(self) -> None:
        auth_rest_variant = GENERATOR.INLINE_TEST_VARIANTS["console-platform-auth-rest"][0]
        self.assertEqual("itest-dev-auth-postgres", auth_rest_variant["name"])
        self.assertEqual("dev-auth", auth_rest_variant["feature"])
        self.assertEqual("postgres", auth_rest_variant["resource"])
        self.assertEqual(
            ":console-app-lib-dev-auth",
            GENERATOR.integration_test_library_target(
                "console-app", "tests/dev_auth_persona_guard_feature.rs", ":console-app-lib"
            ),
        )
        self.assertEqual(
            ":console-platform-auth-rest-dev-auth",
            GENERATOR.integration_test_library_target(
                "console-platform-auth-rest", "tests/dev_auth_session.rs", ":console-platform-auth-rest"
            ),
        )
        self.assertEqual(
            ("dev-auth",),
            GENERATOR.integration_test_features(
                "console-platform-auth-rest", "tests/group_admin_tenant_context.rs"
            ),
        )
        self.assertEqual(
            ":console-platform-auth-rest-dev-auth",
            GENERATOR.integration_test_library_target(
                "console-platform-auth-rest",
                "tests/group_admin_tenant_context.rs",
                ":console-platform-auth-rest",
            ),
        )

    def test_inline_test_variants_reject_missing_manifest_features(self) -> None:
        with self.assertRaisesRegex(ValueError, "feature is absent"):
            GENERATOR.validate_inline_test_variants(
                {"console-app": {"features": {}}}
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
        for package in ("console-benefit-rest", "console-facilities-rest"):
            self.assertFalse(GENERATOR.requires_postgres(package, "test.unit"))
            labels = GENERATOR.test_labels(
                "backend/crates/{}/rest".format(package.removeprefix("console-").removesuffix("-rest")),
                "test.unit",
                GENERATOR.requires_postgres(package, "test.unit"),
            )
            self.assertIn("resource.none", labels)
            self.assertNotIn("resource.postgres", labels)

    def test_comments_and_unrelated_library_code_cannot_require_postgres(self) -> None:
        self.assertNotIn("PgPool", inspect.getsource(GENERATOR.requires_postgres))
        self.assertFalse(GENERATOR.requires_postgres("console-facilities-rest", "test.unit"))
        with self.assertRaisesRegex(ValueError, "missing reviewed resource metadata"):
            GENERATOR.requires_postgres(
                "console-facilities-rest", "test.integration", "tests/comment_only.rs"
            )

    def test_reviewed_database_integration_target_is_postgres_bound(self) -> None:
        self.assertTrue(
            GENERATOR.requires_postgres(
                "console-benefit-adapter-postgres",
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
                "console-attendance-adapter-postgres",
                "test.integration",
                "tests/self_service.rs",
            )
        )

    def test_equipment_discoveries_have_reviewed_resources(self) -> None:
        self.assertTrue(
            GENERATOR.requires_postgres(
                "console-app", "test.integration", "tests/equipment_3r_api.rs"
            )
        )
        self.assertFalse(GENERATOR.requires_postgres("console-equipment-domain", "test.unit"))

    def test_integration_resource_lookup_requires_a_target_path(self) -> None:
        with self.assertRaises(ValueError):
            GENERATOR.requires_postgres("console-benefit-adapter-postgres", "test.integration")

    def test_unreviewed_discovered_test_fails_generation_preflight(self) -> None:
        discovered = {
            ("console-benefit-rest", "test.unit", None),
            ("console-benefit-rest", "test.integration", "tests/unreviewed.rs"),
        }
        requirements = {"console-benefit-rest": {"unit": "none"}}
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
