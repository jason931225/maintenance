#!/usr/bin/env python3
"""Property-style behavior locks for generated-face authority metadata."""

import copy
import importlib.util
import json
import unittest
from pathlib import Path


ROOT = Path(__file__).parent
VALIDATOR_PATH = ROOT / "validate_generated_faces.py"
SPEC = importlib.util.spec_from_file_location("validate_generated_faces", VALIDATOR_PATH)
assert SPEC is not None and SPEC.loader is not None
VALIDATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VALIDATOR)
REGISTRY = json.loads((ROOT / "generated_face_registry.json").read_text(encoding="utf-8"))


class GeneratedFaceRegistryTests(unittest.TestCase):
    def test_repository_registry_is_valid(self) -> None:
        VALIDATOR.validate_registry(copy.deepcopy(REGISTRY))

    def test_rejects_overlapping_writable_output_roots(self) -> None:
        registry = copy.deepcopy(REGISTRY)
        registry["faces"][1]["output_roots"] = ["clients"]
        with self.assertRaisesRegex(ValueError, "overlapping writable output roots"):
            VALIDATOR.validate_registry(registry)

    def test_rejects_duplicate_owner_for_same_output(self) -> None:
        registry = copy.deepcopy(REGISTRY)
        duplicate = copy.deepcopy(registry["faces"][0])
        duplicate["id"] = "another-writer"
        registry["faces"].append(duplicate)
        with self.assertRaisesRegex(ValueError, "overlapping writable output roots"):
            VALIDATOR.validate_registry(registry)

    def test_rejects_unsafe_or_underspecified_entries(self) -> None:
        for field, bad_value in (
            ("source_roots", ["../outside"]),
            ("output_roots", []),
            ("drift_gate", ""),
        ):
            registry = copy.deepcopy(REGISTRY)
            registry["faces"][0][field] = bad_value
            with self.assertRaises(ValueError, msg=field):
                VALIDATOR.validate_registry(registry)

    def test_rejects_writer_without_a_buck_target(self) -> None:
        registry = copy.deepcopy(REGISTRY)
        registry["faces"][0]["writer"]["target"] = "tools/buck"
        with self.assertRaisesRegex(ValueError, "Buck target"):
            VALIDATOR.validate_registry(registry)


if __name__ == "__main__":
    unittest.main()
