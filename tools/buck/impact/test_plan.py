#!/usr/bin/env python3
"""Behavior locks for the immutable, shadow-only impact planner."""

from __future__ import annotations

import importlib.util
import json
import hashlib
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
PLAN = ROOT / "tools/buck/impact/plan.py"


def load_plan_module():
    spec = importlib.util.spec_from_file_location("impact_plan", PLAN)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ImpactPlannerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_plan_module()

    def test_identical_revisions_need_no_targets(self) -> None:
        manifest = self.module.build_manifest(
            base_sha="a" * 40,
            candidate_sha="a" * 40,
            changed_paths=[],
            config_compatible=True,
            universe=[{"target": "root//backend:unit", "labels": ["owner.backend", "resource.none"]}],
            receipts=[],
        )
        self.assertEqual([], manifest["impacted_targets"])
        self.assertEqual("identical_revisions", manifest["fallback_reason"])

    def test_unknown_path_falls_back_to_sorted_full_universe(self) -> None:
        manifest = self.module.build_manifest(
            base_sha="a" * 40,
            candidate_sha="b" * 40,
            changed_paths=["unowned-file.txt"],
            config_compatible=True,
            universe=[
                {"target": "root//z:target", "labels": ["resource.none", "owner.z"]},
                {"target": "root//a:target", "labels": ["owner.a", "resource.postgres"]},
            ],
            receipts=[],
        )
        self.assertEqual("shadow_adapter_full_universe", manifest["fallback_reason"])
        self.assertEqual(["root//a:target", "root//z:target"], [item["target"] for item in manifest["impacted_targets"]])
        self.assertEqual(["owner.a"], manifest["impacted_targets"][0]["owner_labels"])
        self.assertEqual(["resource.postgres"], manifest["impacted_targets"][0]["resource_labels"])

    def test_configuration_change_is_never_a_selective_plan(self) -> None:
        manifest = self.module.build_manifest(
            base_sha="a" * 40,
            candidate_sha="b" * 40,
            changed_paths=[".buckconfig"],
            config_compatible=False,
            universe=[{"target": "root//backend:unit", "labels": []}],
            receipts=[],
        )
        self.assertEqual("incompatible_buck_toolchain_or_cell_configuration", manifest["fallback_reason"])
        self.assertEqual(["root//backend:unit"], [item["target"] for item in manifest["impacted_targets"]])

    def test_distinct_worktree_paths_with_identical_cell_maps_are_compatible(self) -> None:
        first = self.module.canonical_cell_map(
            Path("/tmp/base-worktree"),
            "root: /tmp/base-worktree\nprelude: /tmp/base-worktree/prelude\ntoolchains: /tmp/base-worktree/toolchains\n",
        )
        second = self.module.canonical_cell_map(
            Path("/tmp/candidate-worktree"),
            "root: /tmp/candidate-worktree\nprelude: /tmp/candidate-worktree/prelude\ntoolchains: /tmp/candidate-worktree/toolchains\n",
        )
        manifest = self.module.build_manifest(
            base_sha="a" * 40,
            candidate_sha="b" * 40,
            changed_paths=["backend/BUCK"],
            config_compatible=first == second,
            universe=[{"target": "root//backend:unit", "labels": []}],
            receipts=[],
        )
        self.assertEqual(first, second)
        self.assertEqual("shadow_adapter_full_universe", manifest["fallback_reason"])

    def test_changed_cell_mapping_is_incompatible(self) -> None:
        base = self.module.canonical_cell_map(
            Path("/tmp/base-worktree"), "root: /tmp/base-worktree\nprelude: /tmp/base-worktree/prelude\n"
        )
        candidate = self.module.canonical_cell_map(
            Path("/tmp/candidate-worktree"),
            "root: /tmp/candidate-worktree\nprelude: /tmp/candidate-worktree/alternate-prelude\n",
        )
        manifest = self.module.build_manifest(
            base_sha="a" * 40,
            candidate_sha="b" * 40,
            changed_paths=[".buckconfig"],
            config_compatible=base == candidate,
            universe=[{"target": "root//backend:unit", "labels": []}],
            receipts=[],
        )
        self.assertNotEqual(base, candidate)
        self.assertEqual("incompatible_buck_toolchain_or_cell_configuration", manifest["fallback_reason"])

    def test_two_identical_sha_plans_are_byte_identical(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory) / "repo"
            (repo / "tools").mkdir(parents=True)
            (repo / ".buckconfig").write_text("[cells]\n  root = .\n", encoding="utf-8")
            buck = repo / "tools/buck2"
            buck.write_text(
                "#!/usr/bin/env bash\n"
                "set -euo pipefail\n"
                "case \"$1\" in\n"
                "  audit) printf 'root: %s\\nprelude: %s/prelude\\n' \"$PWD\" \"$PWD\" ;;\n"
                "  uquery) printf '%s\\n' '{\"root//backend:unit\":{\"labels\":[\"owner.backend\",\"resource.none\"]}}' ;;\n"
                "  *) exit 2 ;;\n"
                "esac\n",
                encoding="utf-8",
            )
            buck.chmod(0o755)
            for command in (
                ["git", "init", "-q", str(repo)],
                ["git", "-C", str(repo), "config", "user.email", "test@example.invalid"],
                ["git", "-C", str(repo), "config", "user.name", "Impact Test"],
                ["git", "-C", str(repo), "add", "."],
                ["git", "-C", str(repo), "commit", "-qm", "fixture"],
            ):
                subprocess.run(command, check=True)
            sha = subprocess.run(
                ["git", "-C", str(repo), "rev-parse", "HEAD"], text=True, capture_output=True, check=True
            ).stdout.strip()
            first, second = Path(directory) / "first.json", Path(directory) / "second.json"
            for output in (first, second):
                subprocess.run(
                    ["python3", str(PLAN), "--repo", str(repo), "--base", sha, "--candidate", sha, "--output", str(output)],
                    text=True,
                    capture_output=True,
                    check=True,
                )
            first_bytes, second_bytes = first.read_bytes(), second.read_bytes()
            self.assertEqual(first_bytes, second_bytes)
            self.assertEqual(hashlib.sha256(first_bytes).hexdigest(), hashlib.sha256(second_bytes).hexdigest())

    def test_manifest_json_is_bounded_and_stably_serialized(self) -> None:
        manifest = self.module.build_manifest(
            base_sha="a" * 40,
            candidate_sha="b" * 40,
            changed_paths=[f"path-{index:04d}" for index in range(2000, -1, -1)],
            config_compatible=True,
            universe=[{"target": "root//b:t", "labels": []}, {"target": "root//a:t", "labels": []}],
            receipts=[],
        )
        encoded_once = self.module.encode_manifest(manifest)
        encoded_twice = self.module.encode_manifest(manifest)
        self.assertEqual(encoded_once, encoded_twice)
        decoded = json.loads(encoded_once)
        self.assertEqual(1024, len(decoded["changed_paths"]))
        self.assertTrue(decoded["truncated"]["changed_paths"])
        self.assertEqual(sorted(decoded["changed_paths"]), decoded["changed_paths"])

    def test_non_sha_revision_is_rejected_before_git_or_buck_access(self) -> None:
        with self.assertRaisesRegex(self.module.PlannerError, "full 40-character commit SHA"):
            self.module.require_commit(Path("/does/not/need/to/exist"), "main", "base")


if __name__ == "__main__":
    unittest.main()
