#!/usr/bin/env python3
"""Execution locks: every registered generated-face gate runs in its snapshot."""

import importlib.util
import json
import shutil
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).parent
SPEC = importlib.util.spec_from_file_location("run_generated_face_gates", ROOT / "run_generated_face_gates.py")
assert SPEC and SPEC.loader
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


class GeneratedFaceGateRunnerTests(unittest.TestCase):
    def make_tree(self, drift_second: bool = False) -> tuple[Path, Path, Path]:
        temp = Path(tempfile.mkdtemp(prefix="generated-face-gates-"))
        baseline = temp / "base"
        snapshot = temp / "snapshot"
        for root in (baseline, snapshot):
            (root / "src").mkdir(parents=True)
            (root / "out").mkdir()
            (root / "tools").mkdir()
            (root / "src/input.txt").write_text("input\n")
            (root / "out/one.txt").write_text("one\n")
            (root / "out/two.txt").write_text("two\n")
        for name, output in (("one", "one.txt"), ("two", "two.txt")):
            for root in (baseline, snapshot):
                script = root / f"tools/{name}.sh"
                replacement = "printf changed > out/two.txt" if drift_second and name == "two" else ":"
                script.write_text(f"#!/usr/bin/env bash\nprintf {name} >> gate-calls\n{replacement}\n")
                script.chmod(0o755)
        registry = {
            "schema_version": 2,
            "faces": [
                {
                    "id": name,
                    "source_roots": ["src/input.txt"],
                    "output_patterns": [f"out/{output}"],
                    "writer": {"kind": "repo-exec", "executable": f"tools/{name}.sh", "target": f"//tools:{name}"},
                    "drift_gate": {"tier": "cheap", "kind": "writer-snapshot"},
                }
                for name, output in (("one", "one.txt"), ("two", "two.txt"))
            ],
        }
        registry_path = baseline / "registry.json"
        registry_path.write_text(json.dumps(registry))
        return temp, baseline, snapshot

    def test_runs_every_registered_gate(self) -> None:
        temp, baseline, snapshot = self.make_tree()
        try:
            self.assertEqual(0, RUNNER.run(baseline / "registry.json", baseline, snapshot))
            self.assertEqual("onetwo", (snapshot / "gate-calls").read_text())
        finally:
            shutil.rmtree(temp)

    def test_fails_closed_on_registered_face_drift(self) -> None:
        temp, baseline, snapshot = self.make_tree(drift_second=True)
        try:
            self.assertEqual(1, RUNNER.run(baseline / "registry.json", baseline, snapshot))
            self.assertEqual("onetwo", (snapshot / "gate-calls").read_text())
        finally:
            shutil.rmtree(temp)


if __name__ == "__main__":
    unittest.main()
