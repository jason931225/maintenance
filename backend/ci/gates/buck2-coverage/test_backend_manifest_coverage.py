import json
import tempfile
import unittest
from pathlib import Path

from tools.buck import backend_manifest_coverage as coverage


class BackendManifestCoverageTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.repo = Path(self.tempdir.name)
        self.policy_path = (
            self.repo / "backend/ci/gates/buck2-coverage/policy.json"
        )
        self.registry_path = (
            self.repo
            / "backend/ci/gates/buck2-coverage/ownership.generated.json"
        )

        self._write("backend/Cargo.toml", "[workspace]\n")
        self._write(
            "backend/crates/alpha/Cargo.toml",
            '[package]\nname = "alpha"\nversion = "0.1.0"\n',
        )
        self._write(
            "backend/crates/beta/Cargo.toml",
            '[package]\nname = "beta"\nversion = "0.1.0"\n',
        )
        self._write(
            "backend/ci/gates/migration-safety/Cargo.toml",
            '[package]\nname = "migration-safety"\nversion = "0.1.0"\n',
        )
        self._write(
            "backend/ci/gates/migration-safety/BUCK",
            'rust_library(\n    name = "migration-safety-lib",\n)\n',
        )
        self._write_policy()

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def _write(self, relative_path: str, content: str) -> None:
        path = self.repo / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def _write_policy(
        self,
        *,
        generated_target_name="cargo-manifest-ownership",
        exemptions=None,
        declared_targets=None,
    ) -> None:
        policy = {
            "schema_version": 1,
            "generated_target_name": generated_target_name,
            "exemptions": exemptions
            if exemptions is not None
            else {
                "backend/Cargo.toml": {
                    "reason_code": "workspace-aggregate-manifest",
                    "reason": (
                        "This manifest only aggregates workspace members and does "
                        "not define a Rust build unit."
                    ),
                }
            },
            "declared_targets": declared_targets
            if declared_targets is not None
            else {
                "backend/ci/gates/migration-safety/Cargo.toml": {
                    "label": "//backend/ci/gates/migration-safety:migration-safety-lib",
                    "reason": (
                        "The package already has a real, tested Buck2 Rust target "
                        "that must remain hand-maintained."
                    ),
                }
            },
        }
        self._write(
            self.policy_path.relative_to(self.repo).as_posix(),
            json.dumps(policy, indent=2) + "\n",
        )

    def test_generate_then_check_is_deterministic(self) -> None:
        coverage.generate(self.repo, self.policy_path, self.registry_path)

        self.assertEqual(
            [],
            coverage.check(self.repo, self.policy_path, self.registry_path),
        )
        first_registry = self.registry_path.read_bytes()
        first_alpha = (self.repo / "backend/crates/alpha/BUCK").read_bytes()

        coverage.generate(self.repo, self.policy_path, self.registry_path)

        self.assertEqual(first_registry, self.registry_path.read_bytes())
        self.assertEqual(
            first_alpha,
            (self.repo / "backend/crates/alpha/BUCK").read_bytes(),
        )

    def test_generated_target_name_controls_both_label_and_buck_rule(self) -> None:
        self._write_policy(generated_target_name="manifest-owner")

        plan = coverage.generate(self.repo, self.policy_path, self.registry_path)

        alpha_entry = next(
            entry
            for entry in plan.entries
            if entry["manifest"] == "backend/crates/alpha/Cargo.toml"
        )
        self.assertEqual("//backend/crates/alpha:manifest-owner", alpha_entry["label"])
        self.assertIn(
            'name = "manifest-owner"',
            (self.repo / "backend/crates/alpha/BUCK").read_text(),
        )

    def test_check_fails_closed_for_new_unowned_manifest(self) -> None:
        coverage.generate(self.repo, self.policy_path, self.registry_path)
        self._write(
            "backend/crates/gamma/Cargo.toml",
            '[package]\nname = "gamma"\nversion = "0.1.0"\n',
        )

        issues = coverage.check(self.repo, self.policy_path, self.registry_path)

        self.assertTrue(
            any("backend/crates/gamma/BUCK is missing" in issue for issue in issues),
            issues,
        )
        self.assertTrue(any("ownership.generated.json drift" in issue for issue in issues))

    def test_check_rejects_hand_edited_generated_buck(self) -> None:
        coverage.generate(self.repo, self.policy_path, self.registry_path)
        alpha_buck = self.repo / "backend/crates/alpha/BUCK"
        alpha_buck.write_text(alpha_buck.read_text() + "# hand edit\n")

        issues = coverage.check(self.repo, self.policy_path, self.registry_path)

        self.assertIn("backend/crates/alpha/BUCK generated content drift", issues)

    def test_generate_refuses_to_overwrite_unmanaged_buck(self) -> None:
        self._write("backend/crates/alpha/BUCK", "# real hand-maintained targets\n")

        with self.assertRaisesRegex(
            coverage.CoverageError,
            "refusing to overwrite unmanaged backend/crates/alpha/BUCK",
        ):
            coverage.generate(self.repo, self.policy_path, self.registry_path)

    def test_stale_generated_buck_is_rejected_and_removed_by_generate(self) -> None:
        coverage.generate(self.repo, self.policy_path, self.registry_path)
        (self.repo / "backend/crates/beta/Cargo.toml").unlink()

        issues = coverage.check(self.repo, self.policy_path, self.registry_path)

        self.assertIn("backend/crates/beta/BUCK is stale generated metadata", issues)
        coverage.generate(self.repo, self.policy_path, self.registry_path)
        self.assertFalse((self.repo / "backend/crates/beta/BUCK").exists())

    def test_policy_requires_stable_reason_for_each_exemption(self) -> None:
        self._write_policy(
            exemptions={
                "backend/Cargo.toml": {
                    "reason_code": "workspace-aggregate-manifest",
                    "reason": "",
                }
            }
        )

        with self.assertRaisesRegex(coverage.CoverageError, "non-empty reason"):
            coverage.build_plan(self.repo, self.policy_path)

    def test_declared_target_must_belong_to_manifest_package(self) -> None:
        self._write_policy(
            declared_targets={
                "backend/ci/gates/migration-safety/Cargo.toml": {
                    "label": "//backend/crates/alpha:alpha",
                    "reason": "This intentionally invalid fixture points at the wrong package.",
                }
            }
        )

        with self.assertRaisesRegex(coverage.CoverageError, "must be owned by package"):
            coverage.build_plan(self.repo, self.policy_path)

    def test_check_rejects_missing_declared_target(self) -> None:
        coverage.generate(self.repo, self.policy_path, self.registry_path)
        (self.repo / "backend/ci/gates/migration-safety/BUCK").write_text(
            'rust_library(\n    name = "different-target",\n)\n'
        )

        issues = coverage.check(self.repo, self.policy_path, self.registry_path)

        self.assertIn(
            "//backend/ci/gates/migration-safety:migration-safety-lib is not "
            "declared in backend/ci/gates/migration-safety/BUCK",
            issues,
        )


if __name__ == "__main__":
    unittest.main()
