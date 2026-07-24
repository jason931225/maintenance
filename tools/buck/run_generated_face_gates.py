#!/usr/bin/env python3
"""Run every structured generated-face drift gate in an isolated snapshot."""
from __future__ import annotations

import argparse
import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
SPEC = importlib.util.spec_from_file_location("generated_face_validator", HERE / "validate_generated_faces.py")
assert SPEC and SPEC.loader
VALIDATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VALIDATOR)


def same_face(baseline: Path, snapshot: Path, pattern: str) -> bool:
    root = pattern[:-3] if pattern.endswith("/**") else pattern[:-7] if pattern.endswith("/**/BUCK") else pattern
    left, right = baseline / root, snapshot / root
    if pattern.endswith("/**/BUCK"):
        left_files = {file.relative_to(left) for file in left.rglob("BUCK")}
        right_files = {file.relative_to(right) for file in right.rglob("BUCK")}
        return left_files == right_files and all(
            (left / relative).read_bytes() == (right / relative).read_bytes()
            for relative in left_files
        )
    if pattern.endswith("/**"):
        return shutil.which("diff") is not None and subprocess.run(
            ["diff", "-qr", str(left), str(right)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False
        ).returncode == 0
    return left.read_bytes() == right.read_bytes()


def run(registry_path: Path, baseline: Path, snapshot: Path) -> int:
    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    # Targets were resolved when validating the candidate. Gate execution only
    # invokes the allowlisted executable paths from the immutable snapshot.
    VALIDATOR.validate_registry(registry, baseline, target_resolver=lambda _root, _target: True)
    for face in registry["faces"]:
        executable = snapshot / face["writer"]["executable"]
        result = subprocess.run([str(executable)], cwd=snapshot, check=False)
        if result.returncode:
            print(f"generated-face-gate: {face['id']} writer failed", file=sys.stderr)
            return result.returncode
        for pattern in face["output_patterns"]:
            if not same_face(baseline, snapshot, pattern):
                print(f"generated-face-gate: {face['id']} drift at {pattern}", file=sys.stderr)
                return 1
        print(f"generated-face-gate: {face['id']} ({face['drift_gate']['tier']}) PASS")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--registry", required=True, type=Path)
    parser.add_argument("--baseline", required=True, type=Path)
    parser.add_argument("--snapshot", required=True, type=Path)
    args = parser.parse_args()
    return run(args.registry, args.baseline, args.snapshot)


if __name__ == "__main__":
    raise SystemExit(main())
