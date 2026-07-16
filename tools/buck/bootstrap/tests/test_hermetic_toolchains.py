from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from tools.buck.bootstrap import bootstrap


REPO_ROOT = Path(__file__).resolve().parents[4]
LOCK_PATH = REPO_ROOT / "tools" / "buck" / "toolchain-lock.json"
TOOLCHAINS_BUCK = REPO_ROOT / "toolchains" / "BUCK"
BOOTSTRAP = REPO_ROOT / "tools" / "buck" / "bootstrap" / "bootstrap.py"
BUCKCONFIG = REPO_ROOT / ".buckconfig"


class HermeticToolchainContractTests(unittest.TestCase):
    def test_lock_pins_buck2_bundled_prelude_rust_and_python_for_mac_and_linux(self) -> None:
        lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))

        self.assertEqual(lock["schema_version"], 1)
        self.assertRegex(lock["buck2"]["release"], r"^20\d{2}-\d{2}-\d{2}$")
        self.assertRegex(lock["buck2"]["prelude_commit"], r"^[0-9a-f]{40}$")
        self.assertEqual(
            lock["buck2"]["version"],
            f"2026-06-14-{lock['buck2']['commit']}",
        )
        self.assertEqual(lock["rust"]["version"], "1.96.0")
        self.assertRegex(lock["rust"]["commit"], r"^[0-9a-f]{40}$")

        expected_platforms = {
            "macos-aarch64",
            "macos-x86_64",
            "linux-aarch64",
            "linux-x86_64",
        }
        self.assertEqual(set(lock["platforms"]), expected_platforms)
        for platform in expected_platforms:
            entry = lock["platforms"][platform]
            for component in ("buck2", "rust", "python"):
                self.assertRegex(entry[component]["sha256"], r"^[0-9a-f]{64}$")
                self.assertTrue(entry[component]["url"].startswith("https://"))

        buckconfig = BUCKCONFIG.read_text(encoding="utf-8")
        self.assertIn("prelude = bundled", buckconfig)
        self.assertIn("authority_lock = tools/buck/toolchain-lock.json", buckconfig)

    def test_toolchains_remove_host_paths_and_direct_remote_python(self) -> None:
        source = TOOLCHAINS_BUCK.read_text(encoding="utf-8")

        self.assertNotIn("/usr/bin/", source)
        self.assertNotIn("remote_python_toolchain", source)
        for key in (
            "toolchain.cc",
            "toolchain.cxx",
            "toolchain.archiver",
            "toolchain.linker",
            "toolchain.rustc",
            "toolchain.rustdoc",
            "toolchain.clippy_driver",
            "toolchain.python_archive_url",
        ):
            self.assertIn(key, source)

    def test_linux_fixture_resolves_a_complete_clang_toolchain(self) -> None:
        lock = bootstrap.load_lock()
        with tempfile.TemporaryDirectory() as temp_dir:
            bin_dir = Path(temp_dir)
            for name in ("clang", "clang++", "llvm-ar"):
                executable = bin_dir / name
                executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
                executable.chmod(0o755)

            resolved = bootstrap.resolve_cxx_tools(
                "linux-x86_64",
                lock["platforms"]["linux-x86_64"],
                {"PATH": str(bin_dir)},
            )

        self.assertEqual(resolved["compiler_type"], "clang")
        for key in ("cc", "cxx", "archiver", "linker"):
            self.assertTrue(Path(resolved[key]).is_absolute())
            self.assertNotIn("/usr/bin/", resolved[key])

    def test_tampered_cache_is_rejected_by_integrity_check(self) -> None:
        lock = bootstrap.load_lock()
        platform_name = "linux-x86_64"
        with tempfile.TemporaryDirectory() as temp_dir:
            cache_dir = Path(temp_dir)
            platform_entry = lock["platforms"][platform_name]
            for component in bootstrap.SUPPORTED_COMPONENTS:
                path = bootstrap.cache_path(
                    cache_dir,
                    platform_name,
                    component,
                    platform_entry[component],
                )
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"tampered")

            with self.assertRaisesRegex(
                bootstrap.IntegrityError, "failed SHA-256 verification"
            ):
                bootstrap.verify_cached_artifacts(lock, cache_dir, platform_name)

    def test_population_requires_explicit_network_gate(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            result = subprocess.run(
                [
                    sys.executable,
                    str(BOOTSTRAP),
                    "populate",
                    "--cache-dir",
                    temp_dir,
                    "--platform",
                    "linux-x86_64",
                    "--component",
                    "python",
                ],
                cwd=REPO_ROOT,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(list(Path(temp_dir).rglob("*")), [])

        self.assertEqual(result.returncode, 4, result.stderr)
        self.assertIn("explicit --allow-network gate", result.stderr)

    def test_config_is_inserted_at_the_buck_leaf_command(self) -> None:
        binary = Path("/cache/buck2")
        config = ["-c", "toolchain.rustc=/cache/rustc"]
        self.assertEqual(
            bootstrap._compose_buck_command(binary, ["build", "//:target"], config),
            ["/cache/buck2", "build", *config, "//:target"],
        )
        self.assertEqual(
            bootstrap._compose_buck_command(
                binary, ["audit", "providers", "toolchains//:rust"], config
            ),
            ["/cache/buck2", "audit", "providers", *config, "toolchains//:rust"],
        )

    def test_cold_offline_run_fails_before_any_network_attempt(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            result = subprocess.run(
                [
                    sys.executable,
                    str(BOOTSTRAP),
                    "run",
                    "--cache-dir",
                    temp_dir,
                    "--platform",
                    "linux-x86_64",
                    "--",
                    "query",
                    "toolchains//:python",
                ],
                cwd=REPO_ROOT,
                text=True,
                capture_output=True,
                check=False,
                env={"PATH": "/nonexistent"},
            )

        self.assertEqual(result.returncode, 4, result.stderr)
        self.assertIn("offline cache incomplete", result.stderr)
        self.assertNotIn("http", result.stderr.lower())


if __name__ == "__main__":
    unittest.main()
