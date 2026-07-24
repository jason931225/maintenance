#!/usr/bin/env python3
"""Fail-closed validation for generated-face ownership metadata.

The registry is authority metadata, not a dependency graph. It says which one
writer may change each generated output surface and which command/gate proves
that surface is current. Keeping this data small and structural makes it safe
to consume from local preflight, merge-train planners, and remote CI.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import PurePosixPath

ID = re.compile(r"^[a-z0-9][a-z0-9-]*$")
REQUIRED_FACE_KEYS = {"id", "source_roots", "output_roots", "writer", "drift_gate"}
REQUIRED_WRITER_KEYS = {"command", "target"}


def fail(message: str) -> None:
    raise ValueError("generated-face-registry: " + message)


def normalized_root(value: object, field: str) -> str:
    if not isinstance(value, str) or not value:
        fail(f"{field} entries must be non-empty strings")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or value.endswith("/"):
        fail(f"{field} has unsafe root {value!r}")
    normalized = str(path)
    if normalized in {".", ""}:
        fail(f"{field} cannot be repository root")
    return normalized


def roots_overlap(left: str, right: str) -> bool:
    return left == right or left.startswith(right + "/") or right.startswith(left + "/")


def validate_registry(registry: object) -> None:
    if not isinstance(registry, dict) or set(registry) != {"schema_version", "faces"}:
        fail("top-level keys must be exactly schema_version and faces")
    if registry["schema_version"] != 1:
        fail("unsupported schema_version")
    faces = registry["faces"]
    if not isinstance(faces, list) or not faces:
        fail("faces must be a non-empty list")

    seen_ids: set[str] = set()
    claimed_outputs: list[tuple[str, str]] = []
    for face in faces:
        if not isinstance(face, dict) or set(face) != REQUIRED_FACE_KEYS:
            fail("each face must have exactly " + ", ".join(sorted(REQUIRED_FACE_KEYS)))
        face_id = face["id"]
        if not isinstance(face_id, str) or not ID.fullmatch(face_id) or face_id in seen_ids:
            fail(f"face id must be unique lowercase kebab-case: {face_id!r}")
        seen_ids.add(face_id)
        for field in ("source_roots", "output_roots"):
            values = face[field]
            if not isinstance(values, list) or not values:
                fail(f"{face_id}: {field} must be non-empty")
            normalized = [normalized_root(value, f"{face_id}.{field}") for value in values]
            if len(normalized) != len(set(normalized)):
                fail(f"{face_id}: duplicate {field}")
            face[field] = normalized
        writer = face["writer"]
        if not isinstance(writer, dict) or set(writer) != REQUIRED_WRITER_KEYS:
            fail(f"{face_id}: writer must contain exactly command and target")
        if not isinstance(writer["command"], str) or not writer["command"].strip():
            fail(f"{face_id}: writer.command must be non-empty")
        if not isinstance(writer["target"], str) or not writer["target"].startswith("//"):
            fail(f"{face_id}: writer.target must be a Buck target label")
        if not isinstance(face["drift_gate"], str) or not face["drift_gate"].strip():
            fail(f"{face_id}: drift_gate must be non-empty")
        for output in face["output_roots"]:
            for existing_id, existing_output in claimed_outputs:
                if roots_overlap(output, existing_output):
                    fail(
                        f"overlapping writable output roots: {face_id}:{output} and "
                        f"{existing_id}:{existing_output}"
                    )
            claimed_outputs.append((face_id, output))


def main(argv: list[str]) -> int:
    path = argv[1] if len(argv) == 2 else "tools/buck/generated_face_registry.json"
    try:
        with open(path, encoding="utf-8") as handle:
            registry = json.load(handle)
        validate_registry(registry)
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(error, file=sys.stderr)
        return 1
    print("generated-face-registry: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
