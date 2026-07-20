#!/usr/bin/env python3

from __future__ import annotations

import copy
import importlib.util
import io
import json
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("check-pr473-migration-operational.py")
SPEC = importlib.util.spec_from_file_location("pr473_gate", SCRIPT)
assert SPEC and SPEC.loader
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)


def valid_manifest() -> dict:
    return json.loads(
        (SCRIPT.parents[1] / gate.MANIFEST_PATH).read_text(encoding="utf-8")
    )


def valid_output(name: str) -> str:
    return f"""
running 1 test
test {name} ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 8 filtered out; finished in 0.01s
"""


def valid_metadata() -> dict:
    packages = {}
    for test in valid_manifest()["guarded_tests"]:
        package = packages.setdefault(
            test["package"], {"name": test["package"], "targets": []}
        )
        if not any(target["name"] == test["target"] for target in package["targets"]):
            package["targets"].append(
                {
                    "name": test["target"],
                    "kind": ["test"],
                    "src_path": str(SCRIPT.parents[1] / test["source"]),
                }
            )
    return {"packages": list(packages.values())}


class ManifestTests(unittest.TestCase):
    def test_accepts_canonical_manifest(self) -> None:
        gate.validate_manifest(valid_manifest())

    def test_rejects_wrong_typed_release_authority(self) -> None:
        for key, value in (
            ("release_phase", "contract"),
            ("deployment_authorized", True),
            ("command_only_claim_authorized", True),
        ):
            with self.subTest(key=key):
                manifest = valid_manifest()
                manifest[key] = value
                with self.assertRaises(gate.GateError):
                    gate.validate_manifest(manifest)

    def test_rejects_duplicate_or_missing_guarded_tests(self) -> None:
        duplicate = valid_manifest()
        duplicate["guarded_tests"][-1] = copy.deepcopy(duplicate["guarded_tests"][0])
        with self.assertRaises(gate.GateError):
            gate.validate_manifest(duplicate)

        missing = valid_manifest()
        missing["guarded_tests"].pop()
        with self.assertRaises(gate.GateError):
            gate.validate_manifest(missing)

    def test_rejects_an_unapproved_but_unique_test_tuple(self) -> None:
        manifest = valid_manifest()
        manifest["guarded_tests"][0]["name"] = "invented_unique_test"
        with self.assertRaises(gate.GateError):
            gate.validate_manifest(manifest)

    def test_rejects_noncanonical_json(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "gate.json"
            path.write_text(json.dumps(valid_manifest()), encoding="utf-8")
            with self.assertRaises(gate.GateError):
                gate.load_manifest(path)

    def test_validates_cargo_package_target_and_source_tuple(self) -> None:
        manifest = valid_manifest()
        metadata = valid_metadata()
        gate.validate_cargo_metadata(manifest, metadata, SCRIPT.parents[1])
        metadata["packages"][0]["targets"][0]["src_path"] = "/wrong/source.rs"
        with self.assertRaises(gate.GateError):
            gate.validate_cargo_metadata(manifest, metadata, SCRIPT.parents[1])

    def test_rejects_a_declared_source_symlink_that_escapes_the_repository(self) -> None:
        manifest = valid_manifest()
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory) / "repo"
            outside = Path(directory) / "outside.rs"
            outside.write_text("", encoding="utf-8")
            sources = {}
            for test in manifest["guarded_tests"]:
                source = repo / test["source"]
                if source not in sources:
                    source.parent.mkdir(parents=True, exist_ok=True)
                    if test["domain"] == "ontology":
                        source.symlink_to(outside)
                    else:
                        source.write_text("", encoding="utf-8")
                    sources[source] = True
            packages = {}
            for test in manifest["guarded_tests"]:
                package = packages.setdefault(
                    test["package"], {"name": test["package"], "targets": []}
                )
                if not any(target["name"] == test["target"] for target in package["targets"]):
                    package["targets"].append(
                        {
                            "name": test["target"],
                            "kind": ["test"],
                            "src_path": str(repo / test["source"]),
                        }
                    )
            with self.assertRaisesRegex(gate.GateError, "escapes repository root"):
                gate.validate_cargo_metadata(
                    manifest, {"packages": list(packages.values())}, repo
                )


class ExactResultTests(unittest.TestCase):
    name = "migration_0165_upgrades_legacy_sibling_versions_without_tenant_leakage"

    def test_accepts_one_exact_root_pass(self) -> None:
        gate.validate_exact_test_output(valid_output(self.name), self.name)

    def assert_rejected(self, output: str) -> None:
        with self.assertRaises(gate.GateError):
            gate.validate_exact_test_output(output, self.name)

    def test_rejects_zero_running_tests(self) -> None:
        self.assert_rejected(valid_output(self.name).replace("running 1 test", "running 0 tests"))

    def test_rejects_ignored_test(self) -> None:
        self.assert_rejected(
            valid_output(self.name)
            .replace("... ok", "... ignored")
            .replace("1 passed; 0 failed; 0 ignored", "0 passed; 0 failed; 1 ignored")
        )

    def test_rejects_failed_test(self) -> None:
        self.assert_rejected(
            valid_output(self.name)
            .replace("... ok", "... FAILED")
            .replace("test result: ok. 1 passed; 0 failed", "test result: FAILED. 0 passed; 1 failed")
        )

    def test_rejects_duplicate_result(self) -> None:
        output = valid_output(self.name).replace(
            f"test {self.name} ... ok", f"test {self.name} ... ok\ntest {self.name} ... ok"
        )
        self.assert_rejected(output)

    def test_rejects_nested_result_name(self) -> None:
        self.assert_rejected(valid_output(self.name).replace(self.name, f"nested::{self.name}", 1))

    def test_rejects_suffix_spoofed_result_name(self) -> None:
        self.assert_rejected(valid_output(self.name).replace(self.name, f"{self.name}_evil", 1))


class CommandLineTests(unittest.TestCase):
    def test_backend_directory_resolves_to_repository_root(self) -> None:
        backend = SCRIPT.parents[1] / "backend"
        self.assertEqual(gate.resolve_repo_root(None, backend), SCRIPT.parents[1])


class ExecutionTests(unittest.TestCase):
    def test_runs_workspace_with_all_skips_then_each_exact_test_once(self) -> None:
        tests = valid_manifest()["guarded_tests"]

        def fake_run(command, **_kwargs):
            if command[1] == "metadata":
                return subprocess.CompletedProcess(command, 0, json.dumps(valid_metadata()), "")
            if "--workspace" in command:
                return subprocess.CompletedProcess(command, 0, "workspace ok\n", "")
            name = command[command.index("--") + 1]
            return subprocess.CompletedProcess(command, 0, valid_output(name), "")

        with patch.dict(gate.os.environ, {"RUST_TEST_NOCAPTURE": "1"}, clear=False):
            with patch.object(gate, "run", side_effect=fake_run) as run_mock:
                with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                    self.assertEqual(gate.execute(SCRIPT.parents[1], "cargo"), 0)

        self.assertEqual(run_mock.call_count, 13)
        for call in run_mock.call_args_list:
            self.assertIn("--locked", call.args[0])
            self.assertEqual(call.kwargs["env"]["CARGO_TERM_COLOR"], "never")
            self.assertNotIn("RUST_TEST_NOCAPTURE", call.kwargs["env"])
        workspace = run_mock.call_args_list[1].args[0]
        self.assertIn("--exact", workspace[workspace.index("--") + 1 :])
        self.assertEqual(workspace.count("--skip"), 11)
        self.assertEqual(
            [workspace[index + 1] for index, value in enumerate(workspace) if value == "--skip"],
            [test["name"] for test in tests],
        )
        exact_names = [call.args[0][call.args[0].index("--") + 1] for call in run_mock.call_args_list[2:]]
        self.assertEqual(exact_names, [test["name"] for test in tests])
        for call, test in zip(run_mock.call_args_list[2:], tests, strict=True):
            command = call.args[0]
            self.assertEqual(
                command[command.index("--") + 1 :],
                [test["name"], "--exact", "--test-threads=1"],
            )

    def test_aggregates_workspace_and_exact_result_failures(self) -> None:
        exact_count = 0

        def fake_run(command, **_kwargs):
            nonlocal exact_count
            if command[1] == "metadata":
                return subprocess.CompletedProcess(command, 0, json.dumps(valid_metadata()), "")
            if "--workspace" in command:
                return subprocess.CompletedProcess(command, 9, "workspace failed\n", "")
            exact_count += 1
            name = command[command.index("--") + 1]
            output = valid_output(name)
            if exact_count == 1:
                output = output.replace("running 1 test", "running 0 tests")
            return subprocess.CompletedProcess(command, 0, output, "")

        with patch.object(gate, "run", side_effect=fake_run):
            stderr = io.StringIO()
            with redirect_stdout(io.StringIO()), redirect_stderr(stderr):
                self.assertEqual(gate.execute(SCRIPT.parents[1], "cargo"), 1)
        self.assertEqual(exact_count, 11)
        self.assertIn("workspace tests exited 9", stderr.getvalue())
        self.assertIn("expected exactly one 'running 1 test'", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
