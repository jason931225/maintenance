#!/usr/bin/env python3
"""Behavior locks for the immutable, shadow-only impact planner."""

from __future__ import annotations

import importlib.util
import json
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
