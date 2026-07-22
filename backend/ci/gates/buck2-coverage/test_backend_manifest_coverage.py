import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tools.buck import backend_manifest_coverage as coverage

REAL_BUCK2_RUST_TARGETS = coverage._buck2_rust_targets


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
        self.semantic_query = mock.patch.object(
            coverage,
            "_buck2_rust_targets",
            create=True,
            side_effect=lambda _repo, label: (label,),
        )
        self.semantic_query.start()

    def tearDown(self) -> None:
        self.semantic_query.stop()
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

        with mock.patch.object(
            coverage, "_buck2_rust_targets", create=True, return_value=()
        ):
            with self.assertRaisesRegex(
                coverage.CoverageError, "exactly one Rust target"
            ):
                coverage.check(self.repo, self.policy_path, self.registry_path)

    def test_declared_comment_spoof_fails_semantic_buck_proof(self) -> None:
        buck = self.repo / "backend/ci/gates/migration-safety/BUCK"
        buck.write_text('# name = "migration-safety-lib",\n', encoding="utf-8")
        self._write_policy(
            declared_targets={
                "backend/ci/gates/migration-safety/Cargo.toml": {
                    "label": "//backend/ci/gates/migration-safety:migration-safety-lib",
                    "reason": "Attack fixture: comment text is not a Buck target.",
                }
            }
        )

        with mock.patch.object(
            coverage, "_buck2_rust_targets", create=True, return_value=()
        ):
            with self.assertRaisesRegex(
                coverage.CoverageError, "exactly one Rust target"
            ):
                coverage.generate(self.repo, self.policy_path, self.registry_path)

    def test_declared_filegroup_spoof_fails_semantic_buck_proof(self) -> None:
        self._write(
            "backend/ci/gates/migration-safety/BUCK",
            'filegroup(name = "migration-safety-lib", srcs = [])\n',
        )

        with mock.patch.object(
            coverage, "_buck2_rust_targets", create=True, return_value=()
        ):
            with self.assertRaisesRegex(
                coverage.CoverageError, "exactly one Rust target"
            ):
                coverage.generate(self.repo, self.policy_path, self.registry_path)

    def test_semantic_buck_proof_rejects_duplicate_node_output(self) -> None:
        label = "//backend/ci/gates/migration-safety:migration-safety-lib"
        with mock.patch.object(
            coverage,
            "_buck2_rust_targets",
            create=True,
            return_value=(label, label),
        ):
            with self.assertRaisesRegex(
                coverage.CoverageError, "exactly one Rust target"
            ):
                coverage.generate(self.repo, self.policy_path, self.registry_path)

    def test_semantic_buck_proof_uses_kind_query_and_normalizes_root_cell(self) -> None:
        label = "//backend/ci/gates/migration-safety:migration-safety-lib"
        completed = mock.Mock(
            returncode=0,
            stdout=json.dumps([f"root{label}"]),
            stderr="",
        )
        with mock.patch.object(coverage.subprocess, "run", return_value=completed) as run:
            self.assertEqual((label,), REAL_BUCK2_RUST_TARGETS(self.repo, label))

        command = run.call_args.args[0]
        self.assertEqual(
            [str(self.repo / coverage.BUCK2_WRAPPER), "uquery", "--json"],
            command[:3],
        )
        self.assertEqual(
            f'kind("{coverage.RUST_KIND_PATTERN}", {label})', command[3]
        )
        self.assertFalse(run.call_args.kwargs["check"])

    def test_many_declared_targets_use_one_authenticated_batch_query(self) -> None:
        entries = tuple(
            {
                "disposition": "declared",
                "label": f"//backend/crates/pkg-{index}:pkg-{index}",
                "manifest": f"backend/crates/pkg-{index}/Cargo.toml",
                "reason": "fixture",
            }
            for index in range(9)
        )
        labels = tuple(entry["label"] for entry in entries)
        with (
            mock.patch.object(
                coverage, "_buck2_all_backend_rust_targets", return_value=labels
            ) as batch,
            mock.patch.object(coverage, "_buck2_rust_targets") as per_label,
        ):
            coverage._prove_declared_rust_targets(self.repo, entries)
        batch.assert_called_once_with(self.repo)
        per_label.assert_not_called()

    def test_manifest_symlink_outside_repo_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as external_dir:
            external = Path(external_dir) / "Cargo.toml"
            external.write_text('[package]\nname = "outside"\n', encoding="utf-8")
            linked = self.repo / "backend/crates/outside/Cargo.toml"
            linked.parent.mkdir(parents=True)
            linked.symlink_to(external)

            with self.assertRaisesRegex(coverage.CoverageError, "symlink"):
                coverage.build_plan(self.repo, self.policy_path)

    def test_manifest_symlink_ancestor_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as external_dir:
            external = Path(external_dir)
            (external / "Cargo.toml").write_text(
                '[package]\nname = "outside"\n', encoding="utf-8"
            )
            (self.repo / "backend/crates/linked").symlink_to(
                external, target_is_directory=True
            )

            with self.assertRaisesRegex(coverage.CoverageError, "symlink"):
                coverage.build_plan(self.repo, self.policy_path)

    @unittest.skipUnless(hasattr(os, "mkfifo"), "FIFO requires POSIX")
    def test_non_regular_manifest_is_rejected(self) -> None:
        fifo = self.repo / "backend/crates/fifo/Cargo.toml"
        fifo.parent.mkdir(parents=True)
        os.mkfifo(fifo)

        with self.assertRaisesRegex(coverage.CoverageError, "regular file"):
            coverage.build_plan(self.repo, self.policy_path)

    def test_nonportable_manifest_components_are_rejected(self) -> None:
        components = (
            "bad:name",
            "bad name",
            "bad\nname",
            "bad\\name",
            "AUX",
            "trailing.",
            "e\u0301",
        )
        for index, component in enumerate(components):
            with self.subTest(component=repr(component)):
                bad_root = self.repo / "backend/crates" / component
                bad_root.mkdir(parents=True)
                (bad_root / "Cargo.toml").write_text(
                    f'[package]\nname = "bad-{index}"\n', encoding="utf-8"
                )
                try:
                    with self.assertRaisesRegex(
                        coverage.CoverageError, "portable|NFC|component"
                    ):
                        coverage.build_plan(self.repo, self.policy_path)
                finally:
                    shutil.rmtree(bad_root)

    def test_casefold_colliding_manifest_paths_are_rejected(self) -> None:
        with self.assertRaisesRegex(coverage.CoverageError, "casefold"):
            coverage._validate_casefold_uniqueness(
                [
                    coverage.PurePosixPath("backend/crates/gamma/Cargo.toml"),
                    coverage.PurePosixPath("backend/crates/GAMMA/Cargo.toml"),
                ]
            )

    @unittest.skipUnless(os.name == "posix", "permission fixture requires POSIX")
    def test_manifest_discovery_fails_closed_for_unreadable_ancestor(self) -> None:
        unreadable = self.repo / "backend/crates/unreadable-manifest"
        unreadable.mkdir(parents=True)
        (unreadable / "Cargo.toml").write_text(
            '[package]\nname = "unreadable-manifest"\n',
            encoding="utf-8",
        )
        unreadable.chmod(0)
        try:
            with self.assertRaisesRegex(
                coverage.CoverageError, "manifest discovery cannot traverse"
            ):
                coverage.build_plan(self.repo, self.policy_path)
        finally:
            unreadable.chmod(0o700)

    @unittest.skipUnless(os.name == "posix", "permission fixture requires POSIX")
    def test_buck_discovery_fails_closed_for_unreadable_ancestor(self) -> None:
        unreadable = self.repo / "backend/crates/unreadable-buck"
        unreadable.mkdir(parents=True)
        (unreadable / "BUCK").write_text(
            coverage.GENERATED_HEADER + "\n",
            encoding="utf-8",
        )
        unreadable.chmod(0)
        try:
            with self.assertRaisesRegex(
                coverage.CoverageError, "BUCK discovery cannot traverse"
            ):
                coverage._iter_buck_files(self.repo)
        finally:
            unreadable.chmod(0o700)

    def test_policy_must_be_the_canonical_contained_regular_file(self) -> None:
        with tempfile.TemporaryDirectory() as external_dir:
            external_policy = Path(external_dir) / "policy.json"
            external_policy.write_bytes(self.policy_path.read_bytes())
            with self.assertRaisesRegex(coverage.CoverageError, "canonical policy"):
                coverage.build_plan(self.repo, external_policy)

        noncanonical = Path("backend/../backend/ci/gates/buck2-coverage/policy.json")
        with self.assertRaisesRegex(coverage.CoverageError, "canonical policy"):
            coverage.build_plan(self.repo, noncanonical)

    def test_policy_symlink_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as external_dir:
            external_policy = Path(external_dir) / "policy.json"
            external_policy.write_bytes(self.policy_path.read_bytes())
            self.policy_path.unlink()
            self.policy_path.symlink_to(external_policy)

            with self.assertRaisesRegex(coverage.CoverageError, "policy.*symlink"):
                coverage.build_plan(self.repo, self.policy_path)

    def test_registry_must_be_the_canonical_contained_path(self) -> None:
        with tempfile.TemporaryDirectory() as external_dir:
            external_registry = Path(external_dir) / "ownership.generated.json"
            with self.assertRaisesRegex(coverage.CoverageError, "canonical registry"):
                coverage.generate(self.repo, self.policy_path, external_registry)

    def test_registry_symlink_target_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as external_dir:
            sentinel = Path(external_dir) / "sentinel"
            sentinel.write_text("do-not-touch", encoding="utf-8")
            self.registry_path.symlink_to(sentinel)

            with self.assertRaisesRegex(coverage.CoverageError, "registry.*symlink"):
                coverage.generate(self.repo, self.policy_path, self.registry_path)
            self.assertEqual("do-not-touch", sentinel.read_text(encoding="utf-8"))

    def test_predictable_temp_symlink_cannot_clobber_external_file(self) -> None:
        with tempfile.TemporaryDirectory() as external_dir:
            sentinel = Path(external_dir) / "sentinel"
            sentinel.write_text("do-not-touch", encoding="utf-8")
            predictable = self.registry_path.with_name(self.registry_path.name + ".tmp")
            predictable.symlink_to(sentinel)

            coverage.generate(self.repo, self.policy_path, self.registry_path)

            self.assertEqual("do-not-touch", sentinel.read_text(encoding="utf-8"))
            self.assertTrue(predictable.is_symlink())
            self.assertEqual(coverage.build_plan(self.repo, self.policy_path).registry,
                             self.registry_path.read_text(encoding="utf-8"))

    def test_atomic_write_keeps_old_target_when_replace_fails(self) -> None:
        target = self.repo / "backend/crates/alpha/atomic.txt"
        target.write_text("old", encoding="utf-8")
        with mock.patch.object(
            coverage.os, "replace", side_effect=OSError("injected replace failure")
        ):
            with self.assertRaisesRegex(OSError, "injected replace failure"):
                coverage._write_atomic(target, "new", repo=self.repo, purpose="test")

        self.assertEqual("old", target.read_text(encoding="utf-8"))
        self.assertEqual([], list(target.parent.glob(f".{target.name}.*.tmp")))

    def test_atomic_write_cleans_partial_temp_and_keeps_old_target(self) -> None:
        target = self.repo / "backend/crates/alpha/partial.txt"
        target.write_text("old", encoding="utf-8")
        real_write = coverage.os.write
        calls = 0

        def fail_after_partial(descriptor, payload):
            nonlocal calls
            calls += 1
            if calls == 1:
                return real_write(descriptor, payload[:1])
            raise OSError("injected partial write failure")

        with mock.patch.object(coverage.os, "write", side_effect=fail_after_partial):
            with self.assertRaisesRegex(OSError, "injected partial write failure"):
                coverage._write_atomic(target, "new", repo=self.repo, purpose="test")

        self.assertEqual("old", target.read_text(encoding="utf-8"))
        self.assertEqual([], list(target.parent.glob(f".{target.name}.*.tmp")))

    def test_atomic_temp_creation_uses_exclusive_no_follow_flags(self) -> None:
        target = self.repo / "backend/crates/alpha/flags.txt"
        real_open = coverage.os.open
        temporary_flags = []

        def observe_open(path, flags, *args, **kwargs):
            if isinstance(path, str) and path.startswith(f".{target.name}."):
                temporary_flags.append(flags)
            return real_open(path, flags, *args, **kwargs)

        with mock.patch.object(coverage.os, "open", side_effect=observe_open):
            coverage._write_atomic(target, "safe", repo=self.repo, purpose="test")

        self.assertEqual(1, len(temporary_flags))
        self.assertTrue(temporary_flags[0] & os.O_EXCL)
        self.assertTrue(temporary_flags[0] & os.O_CREAT)
        if hasattr(os, "O_NOFOLLOW"):
            self.assertTrue(temporary_flags[0] & os.O_NOFOLLOW)

    def test_atomic_write_rejects_symlink_target_and_output_escape(self) -> None:
        with tempfile.TemporaryDirectory() as external_dir:
            sentinel = Path(external_dir) / "sentinel"
            sentinel.write_text("do-not-touch", encoding="utf-8")
            target = self.repo / "backend/crates/alpha/symlink.txt"
            target.symlink_to(sentinel)
            with self.assertRaisesRegex(coverage.CoverageError, "symlink"):
                coverage._write_atomic(target, "new", repo=self.repo, purpose="test")
            self.assertEqual("do-not-touch", sentinel.read_text(encoding="utf-8"))

            escaped = Path(external_dir) / "escaped.txt"
            with self.assertRaisesRegex(coverage.CoverageError, "escapes"):
                coverage._write_atomic(escaped, "new", repo=self.repo, purpose="test")
            self.assertFalse(escaped.exists())

    def test_stale_header_plus_hand_authored_rule_is_never_pruned(self) -> None:
        coverage.generate(self.repo, self.policy_path, self.registry_path)
        (self.repo / "backend/crates/beta/Cargo.toml").unlink()
        beta_buck = self.repo / "backend/crates/beta/BUCK"
        beta_buck.write_text(
            coverage.GENERATED_HEADER
            + '\n\nrust_library(name = "hand-authored", srcs = ["lib.rs"])\n',
            encoding="utf-8",
        )

        with self.assertRaisesRegex(coverage.CoverageError, "refusing to prune"):
            coverage.generate(self.repo, self.policy_path, self.registry_path)
        self.assertIn("hand-authored", beta_buck.read_text(encoding="utf-8"))

    def test_stale_generated_prune_requires_exact_prior_registry_entry(self) -> None:
        coverage.generate(self.repo, self.policy_path, self.registry_path)
        (self.repo / "backend/crates/beta/Cargo.toml").unlink()
        registry = json.loads(self.registry_path.read_text(encoding="utf-8"))
        registry["entries"] = [
            entry
            for entry in registry["entries"]
            if entry["manifest"] != "backend/crates/beta/Cargo.toml"
        ]
        self.registry_path.write_text(json.dumps(registry), encoding="utf-8")

        with self.assertRaisesRegex(coverage.CoverageError, "prior registry"):
            coverage.generate(self.repo, self.policy_path, self.registry_path)
        self.assertTrue((self.repo / "backend/crates/beta/BUCK").is_file())

    def test_policy_locks_the_only_exemption_to_virtual_backend_workspace(self) -> None:
        self._write_policy(
            exemptions={
                "backend/Cargo.toml": {
                    "reason_code": "workspace-aggregate-manifest",
                    "reason": "The canonical virtual workspace.",
                },
                "backend/crates/alpha/Cargo.toml": {
                    "reason_code": "arbitrary-exemption",
                    "reason": "This attempted exemption must not be accepted.",
                },
            }
        )

        with self.assertRaisesRegex(coverage.CoverageError, "only permitted exemption"):
            coverage.build_plan(self.repo, self.policy_path)

    def test_virtual_workspace_exemption_requires_workspace_and_no_package(self) -> None:
        invalid_manifests = (
            '[package]\nname = "backend"\nversion = "0.1.0"\n',
            '[workspace]\nmembers = []\n[package]\nname = "backend"\nversion = "0.1.0"\n',
        )
        for content in invalid_manifests:
            with self.subTest(content=content):
                self._write("backend/Cargo.toml", content)
                with self.assertRaisesRegex(
                    coverage.CoverageError, "virtual workspace"
                ):
                    coverage.build_plan(self.repo, self.policy_path)

    def test_backend_workspace_exemption_cannot_be_removed(self) -> None:
        self._write_policy(exemptions={})
        with self.assertRaisesRegex(coverage.CoverageError, "only permitted exemption"):
            coverage.build_plan(self.repo, self.policy_path)


if __name__ == "__main__":
    unittest.main()
