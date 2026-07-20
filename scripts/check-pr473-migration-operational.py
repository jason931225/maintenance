#!/usr/bin/env python3
"""Run the PR 473 migration regressions once each, without weakening workspace tests."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

ROLLBACK_FLOOR = "f6ff236b9770c79301a3d07da6afb56be1e27bbf"
MANIFEST_PATH = Path("docs/release/PR-473-EXPAND-CONTRACT.gate.json")
TOP_LEVEL_KEYS = (
    "schema_version",
    "pull_request",
    "rollback_floor",
    "release_phase",
    "deployment_authorized",
    "command_only_claim_authorized",
    "production_authority",
    "guarded_tests",
)
PRODUCTION_AUTHORITY = {
    "production_cardinality": False,
    "old_runtime_drain": False,
    "rollback_floor_raise": False,
}
TEST_KEYS = ("domain", "package", "target", "source", "name")
EXPECTED_TESTS = (
    ("ontology", "mnt-ontology-adapter-postgres", "key_revision_migration_upgrade", "backend/crates/ontology/adapter-postgres/tests/key_revision_migration_upgrade.rs", "migration_0165_upgrades_legacy_sibling_versions_without_tenant_leakage"),
    ("ontology", "mnt-ontology-adapter-postgres", "key_revision_migration_upgrade", "backend/crates/ontology/adapter-postgres/tests/key_revision_migration_upgrade.rs", "migration_0165_keeps_exact_old_binary_writes_audited_and_cas_consistent"),
    ("ontology", "mnt-ontology-adapter-postgres", "key_revision_migration_upgrade", "backend/crates/ontology/adapter-postgres/tests/key_revision_migration_upgrade.rs", "migration_0165_rehearses_populated_expand_with_bounded_lock_and_statement_timeouts"),
    ("leave", "mnt-leave-adapter-postgres", "leave_migration_expand_contract", "backend/crates/leave/adapter-postgres/tests/leave_migration_expand_contract.rs", "migration_0166_rehearses_populated_expand_with_bounded_lock_and_statement_timeouts"),
    ("leave", "mnt-leave-adapter-postgres", "leave_migration_expand_contract", "backend/crates/leave/adapter-postgres/tests/leave_migration_expand_contract.rs", "exact_charge_create_accepts_resolved_and_review_required_shapes"),
    ("leave", "mnt-leave-adapter-postgres", "leave_migration_expand_contract", "backend/crates/leave/adapter-postgres/tests/leave_migration_expand_contract.rs", "exact_charge_create_atomically_rejects_mismatched_reason_and_evidence_shapes"),
    ("leave", "mnt-leave-adapter-postgres", "leave_migration_expand_contract", "backend/crates/leave/adapter-postgres/tests/leave_migration_expand_contract.rs", "immediate_f6ff_employee_import_remains_usable_after_0166"),
    ("leave", "mnt-leave-adapter-postgres", "leave_migration_expand_contract", "backend/crates/leave/adapter-postgres/tests/leave_migration_expand_contract.rs", "staged_f6ff_employee_import_apply_remains_atomic_after_0166"),
    ("leave", "mnt-leave-adapter-postgres", "leave_migration_expand_contract", "backend/crates/leave/adapter-postgres/tests/leave_migration_expand_contract.rs", "staged_f6ff_apply_rejects_missing_duplicate_or_forged_current_tx_audit"),
    ("leave", "mnt-leave-adapter-postgres", "leave_migration_expand_contract", "backend/crates/leave/adapter-postgres/tests/leave_migration_expand_contract.rs", "legacy_leave_mutations_require_exactly_one_same_transaction_audit"),
    ("leave", "mnt-leave-adapter-postgres", "leave_migration_expand_contract", "backend/crates/leave/adapter-postgres/tests/leave_migration_expand_contract.rs", "staged_employee_import_rejects_payload_not_equal_to_immutable_ledger"),
)
ANSI_ESCAPE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


class GateError(ValueError):
    """A fail-closed gate contract violation."""


def canonical_json(value: Any) -> str:
    return json.dumps(value, indent=2, ensure_ascii=False) + "\n"


def load_manifest(path: Path) -> dict[str, Any]:
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as error:
        raise GateError(f"cannot read manifest {path}: {error}") from error
    try:
        manifest = json.loads(raw)
    except json.JSONDecodeError as error:
        raise GateError(f"manifest is not valid JSON: {error}") from error
    if not isinstance(manifest, dict):
        raise GateError("manifest root must be an object")
    if raw != canonical_json(manifest):
        raise GateError("manifest must use canonical two-space JSON with one trailing newline")
    validate_manifest(manifest)
    return manifest


def validate_manifest(manifest: dict[str, Any]) -> None:
    if tuple(manifest) != TOP_LEVEL_KEYS:
        raise GateError(f"manifest keys must be exactly {TOP_LEVEL_KEYS}")
    expected_scalars = {
        "schema_version": 1,
        "pull_request": 473,
        "rollback_floor": ROLLBACK_FLOOR,
        "release_phase": "expand",
        "deployment_authorized": False,
        "command_only_claim_authorized": False,
        "production_authority": PRODUCTION_AUTHORITY,
    }
    for key, expected in expected_scalars.items():
        if manifest[key] != expected or type(manifest[key]) is not type(expected):
            raise GateError(f"manifest {key} must be exactly {expected!r}")

    tests = manifest["guarded_tests"]
    if not isinstance(tests, list) or len(tests) != 11:
        raise GateError("manifest guarded_tests must contain exactly 11 entries")
    tuples: list[tuple[str, str, str, str, str]] = []
    for index, test in enumerate(tests):
        if not isinstance(test, dict) or tuple(test) != TEST_KEYS:
            raise GateError(f"guarded_tests[{index}] keys must be exactly {TEST_KEYS}")
        if any(not isinstance(test[key], str) or not test[key] for key in TEST_KEYS):
            raise GateError(f"guarded_tests[{index}] values must be non-empty strings")
        tuples.append(tuple(test[key] for key in TEST_KEYS))
    if tuple(tuples) != EXPECTED_TESTS:
        raise GateError("manifest guarded_tests must equal the 11 exact expected tuples in canonical order")


def validate_cargo_metadata(
    manifest: dict[str, Any], metadata: dict[str, Any], repo_root: Path
) -> None:
    repo_root = repo_root.resolve()
    packages = metadata.get("packages")
    if not isinstance(packages, list):
        raise GateError("cargo metadata packages must be an array")
    package_map: dict[str, dict[str, Any]] = {}
    for package in packages:
        if isinstance(package, dict) and isinstance(package.get("name"), str):
            if package["name"] in package_map:
                raise GateError(f"cargo metadata duplicates package {package['name']}")
            package_map[package["name"]] = package

    for test in manifest["guarded_tests"]:
        package = package_map.get(test["package"])
        if package is None:
            raise GateError(f"cargo metadata is missing package {test['package']}")
        matches = []
        for target in package.get("targets", []):
            if not isinstance(target, dict):
                continue
            if target.get("name") != test["target"] or "test" not in target.get("kind", []):
                continue
            source = Path(str(target.get("src_path", ""))).resolve()
            expected_source = (repo_root / test["source"]).resolve()
            try:
                expected_source.relative_to(repo_root)
                source.relative_to(repo_root)
            except ValueError as error:
                raise GateError(
                    f"guarded test source escapes repository root: {test['source']}"
                ) from error
            if not expected_source.is_file():
                raise GateError(f"guarded test source is not a regular file: {test['source']}")
            if source == expected_source:
                matches.append(target)
        if len(matches) != 1:
            raise GateError(
                f"cargo metadata must contain exactly one test target tuple "
                f"{test['package']}:{test['target']}:{test['source']} (found {len(matches)})"
            )


def validate_exact_test_output(output: str, test_name: str) -> None:
    clean = ANSI_ESCAPE.sub("", output)
    lines = [line.strip() for line in clean.splitlines()]
    running = [line for line in lines if re.fullmatch(r"running \d+ tests?", line)]
    if running != ["running 1 test"]:
        raise GateError(f"{test_name}: expected exactly one 'running 1 test' line, got {running}")

    result_lines = [
        line
        for line in lines
        if re.fullmatch(r"test .+ \.\.\. (?:ok|FAILED|ignored)", line)
    ]
    expected_result = f"test {test_name} ... ok"
    if result_lines != [expected_result]:
        raise GateError(
            f"{test_name}: expected one exact root result line {expected_result!r}, got {result_lines}"
        )

    summaries = [line for line in lines if line.startswith("test result:")]
    if len(summaries) != 1 or not re.fullmatch(
        r"test result: ok\. 1 passed; 0 failed; 0 ignored; \d+ measured; \d+ filtered out; finished in .+",
        summaries[0] if summaries else "",
    ):
        raise GateError(
            f"{test_name}: expected one summary with 1 passed, 0 failed, 0 ignored; got {summaries}"
        )


def run(
    command: list[str], *, cwd: Path, env: dict[str, str], show_stdout: bool = True
) -> subprocess.CompletedProcess[str]:
    print(f"+ {' '.join(command)}", flush=True)
    completed = subprocess.run(
        command,
        cwd=cwd,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    sys.stdout.write(completed.stderr)
    if show_stdout:
        sys.stdout.write(completed.stdout)
    sys.stdout.flush()
    return completed


def execute(repo_root: Path, cargo: str) -> int:
    manifest = load_manifest(repo_root / MANIFEST_PATH)
    env = dict(os.environ)
    env["SQLX_OFFLINE"] = "true"
    env["CARGO_TERM_COLOR"] = "never"
    env.pop("RUST_TEST_NOCAPTURE", None)
    metadata_command = [
        cargo,
        "metadata",
        "--locked",
        "--format-version",
        "1",
        "--no-deps",
        "--manifest-path",
        "backend/Cargo.toml",
    ]
    metadata_result = run(metadata_command, cwd=repo_root, env=env, show_stdout=False)
    if metadata_result.returncode != 0:
        raise GateError(f"cargo metadata exited {metadata_result.returncode}")
    try:
        metadata = json.loads(metadata_result.stdout)
    except json.JSONDecodeError as error:
        raise GateError(f"cargo metadata did not emit valid JSON: {error}") from error
    validate_cargo_metadata(manifest, metadata, repo_root)

    tests = manifest["guarded_tests"]
    workspace_command = [
        cargo,
        "test",
        "--locked",
        "--manifest-path",
        "backend/Cargo.toml",
        "--workspace",
        "--no-fail-fast",
        "--",
        "--test-threads=1",
        "--exact",
    ]
    for test in tests:
        workspace_command.extend(("--skip", test["name"]))
    failures: list[str] = []
    workspace_result = run(workspace_command, cwd=repo_root, env=env)
    if workspace_result.returncode != 0:
        failures.append(f"workspace tests exited {workspace_result.returncode}")

    for test in tests:
        command = [
            cargo,
            "test",
            "--locked",
            "--manifest-path",
            "backend/Cargo.toml",
            "-p",
            test["package"],
            "--test",
            test["target"],
            "--",
            test["name"],
            "--exact",
            "--test-threads=1",
        ]
        completed = run(command, cwd=repo_root, env=env)
        if completed.returncode != 0:
            failures.append(f"{test['name']}: cargo test exited {completed.returncode}")
            continue
        try:
            validate_exact_test_output(completed.stdout + completed.stderr, test["name"])
        except GateError as error:
            failures.append(str(error))

    if failures:
        print("PR 473 migration operational gate FAILED:", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1
    print("PR 473 migration operational gate passed: workspace plus 11 exact guarded tests")
    return 0


def resolve_repo_root(repo_root: Path | None, backend_dir: Path | None) -> Path:
    if repo_root is not None:
        return repo_root.resolve()
    if backend_dir is not None:
        resolved = backend_dir.resolve()
        return resolved.parent if (resolved / "Cargo.toml").is_file() else resolved
    return Path(__file__).resolve().parents[1]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("backend_dir", nargs="?", type=Path)
    parser.add_argument("--repo-root", type=Path)
    parser.add_argument("--cargo", default="cargo")
    args = parser.parse_args()
    try:
        return execute(resolve_repo_root(args.repo_root, args.backend_dir), args.cargo)
    except GateError as error:
        print(f"PR 473 migration operational gate FAILED: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
