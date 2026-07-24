#!/usr/bin/env python3
"""Fail-closed, shadow-only Buck2 impact-manifest planner.

This deliberately does *not* infer dependencies from paths.  Until the pinned
Buck2 Change Detector is vendored as a declared dependency, every non-empty
diff selects the candidate universe.  That is safe to observe and supplies the
same immutable inputs a future BTD adapter will consume, without pretending a
filesystem heuristic is a dependency graph.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Iterable


SCHEMA_VERSION = "buck-impact-manifest/v1"
MAX_CHANGED_PATHS = 1024
MAX_TARGETS = 10_000
MAX_RECEIPTS = 32
SHA = re.compile(r"^[0-9a-f]{40}$")
CONFIG_PATHS = (".buckconfig", "tools/buck2", "toolchains", "prelude")


class PlannerError(RuntimeError):
    pass


def sha256(value: bytes | str) -> str:
    if isinstance(value, str):
        value = value.encode("utf-8")
    return hashlib.sha256(value).hexdigest()


def bounded_sorted(items: Iterable[str], limit: int) -> tuple[list[str], bool]:
    ordered = sorted(set(items))
    return ordered[:limit], len(ordered) > limit


def normalize_universe(universe: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for item in universe:
        target = item.get("target")
        if not isinstance(target, str) or not target:
            raise PlannerError("Buck target-universe response contains an invalid target")
        labels = item.get("labels", [])
        if not isinstance(labels, list) or not all(isinstance(label, str) for label in labels):
            raise PlannerError(f"Buck target-universe response has invalid labels for {target}")
        result[target] = {"target": target, "labels": sorted(set(labels))}
    return [result[target] for target in sorted(result)]


def target_record(item: dict[str, Any]) -> dict[str, Any]:
    labels = item["labels"]
    return {
        "target": item["target"],
        "owner_labels": [label for label in labels if label.startswith("owner.")],
        "resource_labels": [label for label in labels if label.startswith("resource.")],
        "test_labels": [label for label in labels if label.startswith("test.")],
    }


def build_manifest(
    *,
    base_sha: str,
    candidate_sha: str,
    changed_paths: Iterable[str],
    config_compatible: bool,
    universe: Iterable[dict[str, Any]],
    receipts: list[dict[str, Any]],
    graph_identity: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a deterministic manifest without applying an impact heuristic."""
    changed_paths, changed_truncated = bounded_sorted(changed_paths, MAX_CHANGED_PATHS)
    normalized_universe = normalize_universe(universe)
    if len(normalized_universe) > MAX_TARGETS:
        raise PlannerError(
            f"candidate target universe has {len(normalized_universe)} targets; "
            f"refusing bounded full-universe fallback above {MAX_TARGETS}"
        )
    if base_sha == candidate_sha:
        fallback_reason = "identical_revisions"
        impacted: list[dict[str, Any]] = []
    elif not config_compatible:
        fallback_reason = "incompatible_buck_toolchain_or_cell_configuration"
        impacted = [target_record(item) for item in normalized_universe]
    else:
        fallback_reason = "shadow_adapter_full_universe"
        impacted = [target_record(item) for item in normalized_universe]
    return {
        "schema_version": SCHEMA_VERSION,
        "mode": "shadow_only",
        "base_sha": base_sha,
        "candidate_sha": candidate_sha,
        "changed_paths": changed_paths,
        "candidate_target_universe": [target_record(item) for item in normalized_universe],
        "impacted_targets": impacted,
        "fallback_reason": fallback_reason,
        "selection_engine": {
            "name": "buck2_change_detector_adapter",
            "status": "unavailable_unvendored",
            "behavior": "full_universe_fallback",
        },
        "graph_identity": graph_identity or {},
        # The execution order is itself part of an exact command receipt.  The
        # planner's command sequence is fixed, so preserving it is deterministic
        # without obscuring which command was observed first.
        "receipts": receipts[:MAX_RECEIPTS],
        "truncated": {"changed_paths": changed_truncated, "receipts": len(receipts) > MAX_RECEIPTS},
        "build_report_hook": {
            "schema_version": "buck-build-report-hook/v1",
            "activation": "not_active",
            "required_input_fields": ["base_sha", "candidate_sha", "impacted_targets"],
            "buck_argument_template": ["--build-report", "<report-path>"],
        },
    }


def encode_manifest(manifest: dict[str, Any]) -> str:
    return json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n"


def run(repo: Path, args: list[str], *, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", "-C", str(repo), *args], cwd=cwd, text=True, capture_output=True, check=False)


def require_clean_repository(repo: Path) -> None:
    probe = run(repo, ["rev-parse", "--is-inside-work-tree"])
    if probe.returncode != 0 or probe.stdout.strip() != "true":
        raise PlannerError("repository is unavailable or is not a Git work tree")
    dirty = run(repo, ["status", "--porcelain=v1", "--untracked-files=all"])
    if dirty.returncode != 0:
        raise PlannerError("could not determine repository cleanliness")
    if dirty.stdout:
        raise PlannerError("repository is dirty; immutable impact planning refuses working-tree input")


def require_commit(repo: Path, revision: str, name: str) -> str:
    if not SHA.fullmatch(revision):
        raise PlannerError(f"{name} must be a full 40-character commit SHA")
    result = run(repo, ["rev-parse", "--verify", f"{revision}^{{commit}}"])
    if result.returncode != 0 or result.stdout.strip() != revision:
        raise PlannerError(f"{name} revision is unavailable or not immutable: {revision}")
    return revision


def receipt(
    name: str,
    argv: list[str],
    result: subprocess.CompletedProcess[str],
    *,
    normalized_stdout: str | None = None,
) -> dict[str, Any]:
    value = {
        "name": name,
        "argv": argv,
        "exit_code": result.returncode,
        # `audit cell` contains temporary-worktree absolute paths.  Its receipt
        # must preserve the exact command while hashing its canonical semantics,
        # otherwise equivalent immutable snapshots produce nondeterministic
        # manifests solely because their temporary directory names differ.
        "stdout_sha256": sha256(result.stdout if normalized_stdout is None else normalized_stdout),
        "stderr_sha256": sha256("" if result.returncode == 0 else result.stderr),
        "stderr_policy": "omitted_on_success" if result.returncode == 0 else "retained_on_failure",
    }
    if result.returncode != 0:
        # Planner errors already surface this text; retaining a bounded copy in
        # a receipt keeps asynchronous callers actionable without allowing an
        # unbounded tool error to inflate the manifest.
        value["stderr"] = result.stderr[:4096]
    return value


def canonical_cell_map(worktree: Path, raw_audit_cell: str) -> dict[str, str]:
    """Turn `buck audit cell` paths into a stable cell -> repo-relative map.

    Buck emits absolute paths.  A cell outside the immutable snapshot cannot be
    compared safely as a repository configuration, so reject it rather than
    accidentally accepting a host-specific mapping.
    """
    # macOS may render the same temporary directory as `/tmp` or `/private/tmp`.
    # Resolve existing parents before calculating the repository-relative path.
    root = worktree.resolve()
    cells: dict[str, str] = {}
    for line in raw_audit_cell.splitlines():
        if not line.strip():
            continue
        name, separator, location = line.partition(": ")
        if not separator or not name or not re.fullmatch(r"[A-Za-z0-9_.-]+", name):
            raise PlannerError(f"unparseable Buck audit cell output: {line!r}")
        if name in cells:
            raise PlannerError(f"duplicate cell in Buck audit output: {name}")
        try:
            relative = Path(location).resolve().relative_to(root)
        except ValueError as error:
            raise PlannerError(f"Buck cell {name} is outside immutable worktree: {location}") from error
        cells[name] = relative.as_posix() if relative.parts else "."
    if not cells:
        raise PlannerError("Buck audit cell produced no cells")
    return dict(sorted(cells.items()))


def git_output(repo: Path, args: list[str], receipts: list[dict[str, Any]], name: str) -> str:
    result = run(repo, args)
    receipts.append(receipt(name, ["git", *args], result))
    if result.returncode != 0:
        raise PlannerError(f"{name} failed: {result.stderr.strip() or result.stdout.strip()}")
    return result.stdout


def graph_digest(repo: Path, revision: str, receipts: list[dict[str, Any]]) -> dict[str, str]:
    listing = git_output(repo, ["ls-tree", "-r", revision], receipts, f"graph-inputs-{revision[:12]}")
    graph_lines = []
    config_lines = []
    for line in listing.splitlines():
        try:
            metadata, path = line.split("\t", 1)
        except ValueError:
            continue
        if path == ".buckconfig" or path == "tools/buck2" or path.startswith(("toolchains/", "prelude/")):
            config_lines.append(line)
        if Path(path).name == "BUCK" or path.endswith(".bzl") or path in {".buckconfig", "tools/buck2"}:
            graph_lines.append(line)
    return {
        "revision": revision,
        "configuration_sha256": sha256("\n".join(sorted(config_lines))),
        "target_definition_sha256": sha256("\n".join(sorted(graph_lines))),
    }


def changed_paths(repo: Path, base: str, candidate: str, receipts: list[dict[str, Any]]) -> list[str]:
    output = git_output(repo, ["diff", "--name-only", "-z", base, candidate], receipts, "changed-paths")
    return [path for path in output.split("\0") if path]


def compatible_configuration(repo: Path, base: str, candidate: str, receipts: list[dict[str, Any]]) -> bool:
    result = run(repo, ["diff", "--quiet", base, candidate, "--", *CONFIG_PATHS])
    receipts.append(receipt("configuration-compatibility", ["git", "diff", "--quiet", base, candidate, "--", *CONFIG_PATHS], result))
    if result.returncode not in (0, 1):
        raise PlannerError("could not compare Buck/toolchain/cell configuration")
    return result.returncode == 0


def parse_universe(raw: str) -> list[dict[str, Any]]:
    try:
        decoded = json.loads(raw)
    except json.JSONDecodeError as error:
        raise PlannerError(f"Buck uquery did not produce JSON target metadata: {error}") from error
    entries: list[dict[str, Any]] = []
    if isinstance(decoded, dict):
        for target, attributes in decoded.items():
            labels = attributes.get("labels", []) if isinstance(attributes, dict) else []
            entries.append({"target": target, "labels": labels})
    elif isinstance(decoded, list):
        for item in decoded:
            if isinstance(item, str):
                entries.append({"target": item, "labels": []})
            elif isinstance(item, dict):
                target = item.get("target") or item.get("name")
                entries.append({"target": target, "labels": item.get("labels", [])})
    else:
        raise PlannerError("Buck uquery JSON response must be an object or array")
    return normalize_universe(entries)


def buck_probe(worktree: Path, revision: str, receipts: list[dict[str, Any]]) -> tuple[dict[str, str], list[dict[str, Any]]]:
    buck = worktree / "tools/buck2"
    if not buck.is_file():
        raise PlannerError(f"candidate {revision} does not contain the pinned tools/buck2 manifest")
    env = os.environ.copy()
    env["BUCK_ISOLATION_DIR"] = f"impact-shadow-{revision[:12]}"
    commands = [
        ("buck-audit-cell", [str(buck), "audit", "cell"]),
        ("buck-target-universe", [str(buck), "uquery", "--output-format=json", "--output-attribute=labels", "//..."]),
    ]
    results: list[subprocess.CompletedProcess[str]] = []
    for name, argv in commands:
        result = subprocess.run(argv, cwd=worktree, env=env, text=True, capture_output=True, check=False)
        if result.returncode != 0:
            receipts.append(receipt(name, ["tools/buck2", *argv[1:]], result))
            raise PlannerError(f"{name} failed for {revision}: {result.stderr.strip() or result.stdout.strip()}")
        results.append(result)
    cells = canonical_cell_map(worktree, results[0].stdout)
    receipts.append(
        receipt(
            "buck-audit-cell",
            ["tools/buck2", "audit", "cell"],
            results[0],
            normalized_stdout=encode_manifest(cells),
        )
    )
    receipts.append(receipt("buck-target-universe", ["tools/buck2", *commands[1][1][1:]], results[1]))
    return cells, parse_universe(results[1].stdout)


def plan(repo: Path, base: str, candidate: str) -> dict[str, Any]:
    require_clean_repository(repo)
    base = require_commit(repo, base, "base")
    candidate = require_commit(repo, candidate, "candidate")
    receipts: list[dict[str, Any]] = []
    base_identity = graph_digest(repo, base, receipts)
    candidate_identity = graph_digest(repo, candidate, receipts)
    paths = changed_paths(repo, base, candidate, receipts)
    config_compatible = compatible_configuration(repo, base, candidate, receipts)

    with tempfile.TemporaryDirectory(prefix="buck-impact-shadow-") as temp:
        root = Path(temp)
        worktrees: dict[str, Path] = {}
        try:
            for label, revision in (("base", base), ("candidate", candidate)):
                path = root / label
                result = run(repo, ["worktree", "add", "--detach", str(path), revision])
                receipts.append(receipt(f"worktree-add-{label}", ["git", "worktree", "add", "--detach", "<temporary>", revision], result))
                if result.returncode != 0:
                    raise PlannerError(f"could not materialize immutable {label} worktree: {result.stderr.strip()}")
                worktrees[label] = path
            base_cell, _ = buck_probe(worktrees["base"], base, receipts)
            candidate_cell, universe = buck_probe(worktrees["candidate"], candidate, receipts)
            config_compatible = config_compatible and base_cell == candidate_cell
        finally:
            for label, path in worktrees.items():
                result = run(repo, ["worktree", "remove", "--force", str(path)])
                receipts.append(receipt(f"worktree-remove-{label}", ["git", "worktree", "remove", "--force", "<temporary>"], result))
                if result.returncode != 0 and path.exists():
                    shutil.rmtree(path, ignore_errors=True)
    return build_manifest(
        base_sha=base,
        candidate_sha=candidate,
        changed_paths=paths,
        config_compatible=config_compatible,
        universe=universe,
        receipts=receipts,
        graph_identity={
            "base": {**base_identity, "cell_map": base_cell},
            "candidate": {**candidate_identity, "cell_map": candidate_cell},
        },
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--base", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--output", type=Path, help="write deterministic JSON manifest to this path")
    args = parser.parse_args(argv)
    try:
        manifest = plan(args.repo.resolve(), args.base, args.candidate)
        encoded = encode_manifest(manifest)
        if args.output:
            args.output.write_text(encoded, encoding="utf-8")
        else:
            sys.stdout.write(encoded)
        return 0
    except PlannerError as error:
        print(f"buck-impact-plan: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
