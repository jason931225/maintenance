from __future__ import annotations

import copy
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import unittest
import urllib.request
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any
from unittest import mock

from tools.buck.bootstrap import bootstrap


REPO_ROOT = Path(__file__).resolve().parents[4]
LOCK_PATH = REPO_ROOT / "tools" / "buck" / "toolchain-lock.json"
TOOLCHAINS_BUCK = REPO_ROOT / "toolchains" / "BUCK"
BOOTSTRAP = REPO_ROOT / "tools" / "buck" / "bootstrap" / "bootstrap.py"
BUCK_WRAPPER = REPO_ROOT / "tools" / "buck" / "bootstrap" / "buck2w"
BUCKCONFIG = REPO_ROOT / ".buckconfig"


class HermeticToolchainContractTests(unittest.TestCase):
    class _FakeResponse(io.BytesIO):
        def __init__(self, payload: bytes, final_url: str):
            super().__init__(payload)
            self._final_url = final_url

        def geturl(self) -> str:
            return self._final_url

    class _FakeOpener:
        def __init__(self, response: io.BytesIO):
            self.response = response

        def open(self, _request: object, *, timeout: int) -> io.BytesIO:
            if timeout != 60:
                raise AssertionError(f"unexpected timeout: {timeout}")
            return self.response

    @staticmethod
    def _fixture_lock() -> dict[str, Any]:
        return copy.deepcopy(bootstrap.load_lock())

    @staticmethod
    def _write_fixture_cache(
        lock: dict[str, Any],
        cache_dir: Path,
        platform_name: str,
        payloads: dict[str, bytes] | None = None,
    ) -> dict[str, bytes]:
        payloads = payloads or {
            "buck2": b"fixture-buck2-archive",
            "rust": b"fixture-rust-archive",
            "python": b"fixture-python-archive",
        }
        platform_entry = lock["platforms"][platform_name]
        for component, payload in payloads.items():
            component_entry = platform_entry[component]
            component_entry["sha256"] = hashlib.sha256(payload).hexdigest()
            path = bootstrap.cache_path(
                cache_dir, platform_name, component, component_entry
            )
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(payload)
        return payloads

    @staticmethod
    def _write_executable(path: Path, source: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(source, encoding="utf-8")
        path.chmod(0o755)

    @classmethod
    def _buck_fixture_payload(cls, lock: dict[str, Any]) -> bytes:
        version = lock["buck2"]["version"]
        payload = (
            "#!/bin/sh\n"
            "if [ \"${1:-}\" = \"--version\" ]; then\n"
            f"  printf '%s\\n' 'buck2 {version}'\n"
            "  exit 0\n"
            "fi\n"
            "exit 0\n"
        ).encode()
        identity = {
            "binary_sha256": hashlib.sha256(payload).hexdigest(),
            "binary_size": len(payload),
        }
        for platform_entry in lock["platforms"].values():
            platform_entry["buck2"].update(identity)
        return payload

    @classmethod
    def _create_rust_fixture_archive(
        cls, archive: Path, lock: dict[str, Any]
    ) -> bytes:
        version = lock["rust"]["version"]
        commit = lock["rust"]["commit"]
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "rust-fixture"
            installer = root / "install.sh"
            cls._write_executable(
                installer,
                "#!/bin/sh\n"
                "set -eu\n"
                "prefix=''\n"
                "for arg in \"$@\"; do\n"
                "  case \"$arg\" in --prefix=*) prefix=${arg#--prefix=} ;; esac\n"
                "done\n"
                "test -n \"$prefix\"\n"
                "mkdir -p \"$prefix/bin\"\n"
                "cat >\"$prefix/bin/rustc\" <<'EOF'\n"
                "#!/bin/sh\n"
                "if [ \"${1:-}\" = \"-Vv\" ]; then\n"
                f"  printf '%s\\n' 'release: {version}' 'commit-hash: {commit}'\n"
                "fi\n"
                "EOF\n"
                "cat >\"$prefix/bin/rustdoc\" <<'EOF'\n"
                "#!/bin/sh\nexit 0\n"
                "EOF\n"
                "cat >\"$prefix/bin/clippy-driver\" <<'EOF'\n"
                "#!/bin/sh\nexit 0\n"
                "EOF\n"
                "chmod 755 \"$prefix/bin/rustc\" \"$prefix/bin/rustdoc\" "
                "\"$prefix/bin/clippy-driver\"\n",
            )
            with tarfile.open(archive, "w:xz") as rust_archive:
                rust_archive.add(root, arcname=root.name)
        rustc = (
            "#!/bin/sh\n"
            "if [ \"${1:-}\" = \"-Vv\" ]; then\n"
            f"  printf '%s\\n' 'release: {version}' 'commit-hash: {commit}'\n"
            "fi\n"
        ).encode()
        fixture_tools = {
            "rustc": rustc,
            "rustdoc": b"#!/bin/sh\nexit 0\n",
            "clippy-driver": b"#!/bin/sh\nexit 0\n",
        }
        identities = {
            name: {
                "sha256": hashlib.sha256(payload).hexdigest(),
                "size": len(payload),
            }
            for name, payload in fixture_tools.items()
        }
        for platform_entry in lock["platforms"].values():
            platform_entry["rust"]["executables"] = copy.deepcopy(identities)
        return archive.read_bytes()

    @staticmethod
    def _pad_shell_executable(source: bytes, size: int) -> bytes:
        if not source.endswith(b"\n"):
            source += b"\n"
        if len(source) > size:
            raise AssertionError(f"fixture executable exceeds {size} bytes")
        return source + (b"#" * (size - len(source)))

    @staticmethod
    def _zstd_compress(payload: bytes) -> bytes:
        try:
            from compression import zstd
        except ModuleNotFoundError:
            decoder = shutil.which("zstd")
            if decoder is None:
                raise unittest.SkipTest("zstd compression is unavailable for fixtures")
            return subprocess.run(
                [decoder, "-q", "-c"],
                input=payload,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=True,
            ).stdout
        return zstd.compress(payload)

    @classmethod
    def _create_materializable_fixture(
        cls, root: Path, platform_name: str = "linux-x86_64"
    ) -> tuple[dict[str, Any], Path, dict[str, str]]:
        cache_dir = root / "cache"
        lock = cls._fixture_lock()
        rust_fixture = root / "rust-fixture.tar.xz"
        payloads = {
            "buck2": cls._zstd_compress(cls._buck_fixture_payload(lock)),
            "rust": cls._create_rust_fixture_archive(rust_fixture, lock),
            "python": b"fixture-python-archive",
        }
        cls._write_fixture_cache(lock, cache_dir, platform_name, payloads)
        fake_bin = root / "fake-bin"
        cls._write_executable(fake_bin / "zstd", "#!/bin/sh\n/bin/cat\n")
        for name in ("clang", "clang++", "llvm-ar"):
            cls._write_executable(fake_bin / name, "#!/bin/sh\nexit 0\n")
        env = {
            "PATH": os.pathsep.join((str(fake_bin), "/bin", "/usr/bin")),
        }
        return lock, cache_dir, env

    @staticmethod
    def _capture_thread_call(
        result: dict[str, object], call: Callable[[], object]
    ) -> None:
        try:
            result["value"] = call()
        except BaseException as error:  # Propagate worker failures through assertions.
            result["error"] = error

    @staticmethod
    def _entrypoint_test_environment(
        root: Path, *, path: str, pythonpath: Path, marker: Path
    ) -> dict[str, str]:
        python_bin = root / "python-bin"
        python_bin.mkdir(parents=True, exist_ok=True)
        (python_bin / "python3").symlink_to(Path(sys.executable).resolve())
        environment = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith("BUCK2_")
        }
        environment.update(
            {
                "PATH": os.pathsep.join((str(python_bin), path)),
                "PYTHONPATH": str(pythonpath),
                "BUCK2_IMPORT_MARKER": str(marker),
            }
        )
        return environment

    def _assert_official_entrypoint_ignores_startup_hook(
        self, hook_module: str
    ) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            fixture_repo = root / "repo"
            fixture_bootstrap = fixture_repo / "tools" / "buck" / "bootstrap"
            fixture_bootstrap.mkdir(parents=True)
            shutil.copy2(BOOTSTRAP, fixture_bootstrap / "bootstrap.py")
            shutil.copy2(BUCK_WRAPPER, fixture_bootstrap / "buck2w")
            lock_path = fixture_repo / "tools" / "buck" / "toolchain-lock.json"
            shutil.copy2(LOCK_PATH, lock_path)
            attacker = root / "attacker"
            attacker.mkdir()
            marker = root / f"{hook_module}-executed"
            (attacker / f"{hook_module}.py").write_text(
                "import os\n"
                "with open(os.environ['BUCK2_IMPORT_MARKER'], 'w', "
                "encoding='utf-8') as stream:\n"
                f"    stream.write('{hook_module} executed')\n",
                encoding="utf-8",
            )
            environment = self._entrypoint_test_environment(
                root,
                path=os.pathsep.join(("/usr/bin", "/bin")),
                pythonpath=attacker,
                marker=marker,
            )

            result = subprocess.run(
                [
                    str(fixture_bootstrap / "buck2w"),
                    "query",
                    "//:python-startup-hook-isolation",
                ],
                cwd=fixture_repo,
                text=True,
                capture_output=True,
                check=False,
                env=environment,
            )

            self.assertEqual(result.returncode, 4, result.stderr)
            self.assertFalse(
                marker.exists(),
                f"the official Buck2 entrypoint executed {hook_module} from "
                "caller PYTHONPATH before offline-cache validation",
            )

    def test_official_entrypoint_ignores_pythonpath_sitecustomize(self) -> None:
        self._assert_official_entrypoint_ignores_startup_hook("sitecustomize")

    def test_official_entrypoint_ignores_pythonpath_usercustomize(self) -> None:
        self._assert_official_entrypoint_ignores_startup_hook("usercustomize")

    def test_official_entrypoint_ignores_pythonpath_secrets(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            fixture_repo = root / "repo"
            fixture_bootstrap = fixture_repo / "tools" / "buck" / "bootstrap"
            fixture_bootstrap.mkdir(parents=True)
            shutil.copy2(BOOTSTRAP, fixture_bootstrap / "bootstrap.py")
            shutil.copy2(BUCK_WRAPPER, fixture_bootstrap / "buck2w")
            lock_path = fixture_repo / "tools" / "buck" / "toolchain-lock.json"
            shutil.copy2(LOCK_PATH, lock_path)
            attacker = root / "attacker"
            attacker.mkdir()
            marker = root / "secrets-imported"
            (attacker / "secrets.py").write_text(
                "import os\n"
                "with open(os.environ['BUCK2_IMPORT_MARKER'], 'w', encoding='utf-8') "
                "as stream:\n"
                "    stream.write('caller PYTHONPATH secrets executed')\n",
                encoding="utf-8",
            )
            environment = self._entrypoint_test_environment(
                root,
                path=os.pathsep.join(("/usr/bin", "/bin")),
                pythonpath=attacker,
                marker=marker,
            )

            result = subprocess.run(
                [
                    str(fixture_bootstrap / "buck2w"),
                    "query",
                    "//:python-import-isolation",
                ],
                cwd=fixture_repo,
                text=True,
                capture_output=True,
                check=False,
                env=environment,
            )

            self.assertEqual(result.returncode, 4, result.stderr)
            self.assertFalse(
                marker.exists(),
                "the official Buck2 entrypoint executed PYTHONPATH secrets.py before "
                "offline-cache validation",
            )

    def test_official_entrypoint_ignores_pythonpath_compression_zstd(self) -> None:
        platform_name = bootstrap.normalize_platform(None)
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            fixture_repo = root / "repo"
            fixture_bootstrap = fixture_repo / "tools" / "buck" / "bootstrap"
            fixture_bootstrap.mkdir(parents=True)
            lock, cache_dir, fixture_env = self._create_materializable_fixture(
                fixture_bootstrap, platform_name
            )
            self.assertEqual(cache_dir, fixture_bootstrap / "cache")
            shutil.copy2(BOOTSTRAP, fixture_bootstrap / "bootstrap.py")
            shutil.copy2(BUCK_WRAPPER, fixture_bootstrap / "buck2w")
            lock_path = fixture_repo / "tools" / "buck" / "toolchain-lock.json"
            lock_path.write_text(json.dumps(lock), encoding="utf-8")

            attacker = root / "attacker"
            compression = attacker / "compression"
            compression.mkdir(parents=True)
            (compression / "__init__.py").write_text("", encoding="utf-8")
            marker = root / "compression-zstd-imported"
            (compression / "zstd.py").write_text(
                "import os\n"
                "with open(os.environ['BUCK2_IMPORT_MARKER'], 'w', encoding='utf-8') "
                "as stream:\n"
                "    stream.write('caller PYTHONPATH compression.zstd executed')\n"
                "raise ModuleNotFoundError('force the bootstrap fallback decoder')\n",
                encoding="utf-8",
            )
            environment = self._entrypoint_test_environment(
                root,
                path=fixture_env["PATH"],
                pythonpath=attacker,
                marker=marker,
            )

            result = subprocess.run(
                [
                    str(fixture_bootstrap / "buck2w"),
                    "query",
                    "//:python-import-isolation",
                ],
                cwd=fixture_repo,
                text=True,
                capture_output=True,
                check=False,
                env=environment,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(
                marker.exists(),
                "the official Buck2 entrypoint executed PYTHONPATH "
                "compression.zstd during authenticated materialization",
            )

    def test_nonisolated_direct_bootstrap_rejects_before_bootstrap_owned_imports(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            attacker = root / "attacker"
            attacker.mkdir()
            marker = root / "direct-secrets-imported"
            (attacker / "secrets.py").write_text(
                "import os\n"
                "with open(os.environ['BUCK2_IMPORT_MARKER'], 'w', encoding='utf-8') "
                "as stream:\n"
                "    stream.write('non-isolated direct import executed')\n",
                encoding="utf-8",
            )
            environment = self._entrypoint_test_environment(
                root,
                path=os.pathsep.join(("/usr/bin", "/bin")),
                pythonpath=attacker,
                marker=marker,
            )

            result = subprocess.run(
                [sys.executable, str(BOOTSTRAP), "doctor", "--skip-cache"],
                cwd=REPO_ROOT,
                text=True,
                capture_output=True,
                check=False,
                env=environment,
            )

            self.assertEqual(result.returncode, 6, result.stderr)
            self.assertIn("isolated", result.stderr.lower())
            self.assertFalse(
                marker.exists(),
                "non-isolated direct bootstrap executed a bootstrap-owned "
                "PYTHONPATH import after interpreter startup",
            )

            imported_main = subprocess.run(
                [
                    sys.executable,
                    "-c",
                    "from tools.buck.bootstrap import bootstrap; "
                    "raise SystemExit(bootstrap.main(['doctor', '--skip-cache']))",
                ],
                cwd=REPO_ROOT,
                text=True,
                capture_output=True,
                check=False,
                env={
                    key: value
                    for key, value in environment.items()
                    if key not in {"PYTHONPATH", "BUCK2_IMPORT_MARKER"}
                },
            )
            self.assertEqual(imported_main.returncode, 6, imported_main.stderr)
            self.assertIn("isolated", imported_main.stderr.lower())

    def test_nonisolated_direct_bootstrap_cannot_preempt_startup_hooks(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            attacker = root / "attacker"
            attacker.mkdir()
            site_marker = root / "sitecustomize-executed"
            user_marker = root / "usercustomize-executed"
            (attacker / "sitecustomize.py").write_text(
                "import os\n"
                "with open(os.environ['BUCK2_SITE_MARKER'], 'w', "
                "encoding='utf-8') as stream:\n"
                "    stream.write('sitecustomize executed before bootstrap')\n",
                encoding="utf-8",
            )
            (attacker / "usercustomize.py").write_text(
                "import os\n"
                "with open(os.environ['BUCK2_USER_MARKER'], 'w', "
                "encoding='utf-8') as stream:\n"
                "    stream.write('usercustomize executed before bootstrap')\n",
                encoding="utf-8",
            )
            environment = self._entrypoint_test_environment(
                root,
                path=os.pathsep.join(("/usr/bin", "/bin")),
                pythonpath=attacker,
                marker=root / "unused-marker",
            )
            environment.update(
                {
                    "BUCK2_SITE_MARKER": str(site_marker),
                    "BUCK2_USER_MARKER": str(user_marker),
                }
            )

            result = subprocess.run(
                [sys.executable, str(BOOTSTRAP), "doctor", "--skip-cache"],
                cwd=REPO_ROOT,
                text=True,
                capture_output=True,
                check=False,
                env=environment,
            )

            self.assertEqual(result.returncode, 6, result.stderr)
            self.assertIn("non-authoritative", result.stderr)
            self.assertIn("after interpreter startup", result.stderr)
            self.assertTrue(site_marker.exists())
            self.assertTrue(user_marker.exists())

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

    def test_lock_pins_every_materialized_executable_digest_and_size(self) -> None:
        lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
        for platform_name, platform_entry in lock["platforms"].items():
            with self.subTest(platform=platform_name, executable="buck2"):
                buck_entry = platform_entry["buck2"]
                self.assertRegex(
                    str(buck_entry.get("binary_sha256", "")), r"^[0-9a-f]{64}$"
                )
                self.assertIsInstance(buck_entry.get("binary_size"), int)
                self.assertGreater(buck_entry.get("binary_size", 0), 0)

            rust_executables = platform_entry["rust"].get("executables", {})
            expected_rust_executables = {"rustc", "rustdoc", "clippy-driver"}
            with self.subTest(platform=platform_name, executable="rust-matrix"):
                self.assertEqual(
                    set(rust_executables),
                    expected_rust_executables,
                    f"{platform_name} must authenticate every materialized Rust executable",
                )
            if set(rust_executables) != expected_rust_executables:
                continue
            for executable in ("rustc", "rustdoc", "clippy-driver"):
                with self.subTest(platform=platform_name, executable=executable):
                    identity = rust_executables.get(executable, {})
                    self.assertRegex(
                        str(identity.get("sha256", "")), r"^[0-9a-f]{64}$"
                    )
                    self.assertIsInstance(identity.get("size"), int)
                    self.assertGreater(identity.get("size", 0), 0)

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

    def test_lock_rejects_unsafe_archive_filenames(self) -> None:
        unsafe_names = (
            "",
            ".",
            "..",
            "../escaped.tar.xz",
            "nested/archive.tar.xz",
            r"nested\archive.tar.xz",
            "/absolute/archive.tar.xz",
            "nul\x00archive.tar.xz",
        )
        for unsafe_name in unsafe_names:
            with self.subTest(filename=unsafe_name), tempfile.TemporaryDirectory() as temp_dir:
                lock = self._fixture_lock()
                lock["platforms"]["linux-x86_64"]["rust"]["filename"] = unsafe_name
                lock_path = Path(temp_dir) / "toolchain-lock.json"
                lock_path.write_text(json.dumps(lock), encoding="utf-8")

                with self.assertRaisesRegex(
                    bootstrap.ToolchainError, "safe basename"
                ):
                    bootstrap.load_lock(lock_path)

    def test_lock_rejects_url_filename_mismatch_and_insecure_url_shapes(self) -> None:
        invalid_urls = (
            "https://static.rust-lang.org/dist/different.tar.xz",
            "http://static.rust-lang.org/dist/rust.tar.xz",
            "https://user:secret@static.rust-lang.org/dist/rust.tar.xz",
            "https://static.rust-lang.org/dist/rust.tar.xz#fragment",
        )
        for invalid_url in invalid_urls:
            with self.subTest(url=invalid_url), tempfile.TemporaryDirectory() as temp_dir:
                lock = self._fixture_lock()
                component = lock["platforms"]["linux-x86_64"]["rust"]
                component["filename"] = "rust.tar.xz"
                component["url"] = invalid_url
                lock_path = Path(temp_dir) / "toolchain-lock.json"
                lock_path.write_text(json.dumps(lock), encoding="utf-8")

                with self.assertRaises(bootstrap.ToolchainError):
                    bootstrap.load_lock(lock_path)

    def test_symlink_and_non_regular_archives_are_rejected(self) -> None:
        platform_name = "linux-x86_64"
        with tempfile.TemporaryDirectory() as temp_dir:
            cache_dir = Path(temp_dir).resolve()
            lock = self._fixture_lock()
            self._write_fixture_cache(lock, cache_dir, platform_name)
            rust_entry = lock["platforms"][platform_name]["rust"]
            rust_archive = bootstrap.cache_path(
                cache_dir, platform_name, "rust", rust_entry
            )
            target = cache_dir / "matching-rust-target"
            target.write_bytes(rust_archive.read_bytes())
            rust_archive.unlink()
            rust_archive.symlink_to(target)

            with self.assertRaisesRegex(bootstrap.IntegrityError, "symlink"):
                with bootstrap.verified_cached_artifacts(
                    lock, cache_dir, platform_name
                ):
                    self.fail("matching-hash archive symlink was accepted")

            rust_archive.unlink()
            rust_archive.mkdir()
            with self.assertRaisesRegex(
                bootstrap.IntegrityError, "not a regular file"
            ):
                with bootstrap.verified_cached_artifacts(
                    lock, cache_dir, platform_name
                ):
                    self.fail("non-regular archive was accepted")

    def test_symlinked_or_non_directory_cache_ancestor_is_rejected(self) -> None:
        platform_name = "linux-x86_64"
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            outside = root / "outside"
            outside.mkdir()
            lock = self._fixture_lock()
            self._write_fixture_cache(lock, outside, platform_name)
            cache_link = root / "cache-link"
            cache_link.symlink_to(outside, target_is_directory=True)

            with self.assertRaisesRegex(bootstrap.IntegrityError, "symlink"):
                with bootstrap.verified_cached_artifacts(
                    lock, cache_link, platform_name
                ):
                    self.fail("symlinked cache root was accepted")

            non_directory_cache = root / "not-a-directory"
            non_directory_cache.write_text("not a directory", encoding="utf-8")
            with self.assertRaisesRegex(
                bootstrap.IntegrityError, "not a directory"
            ):
                with bootstrap.verified_cached_artifacts(
                    lock, non_directory_cache, platform_name
                ):
                    self.fail("non-directory cache root was accepted")

    def test_redirect_policy_allows_required_origins_and_rejects_downgrades(self) -> None:
        github = (
            "https://github.com/facebook/buck2/releases/download/v1/buck2.zst"
        )
        bootstrap._validate_download_url(github, github, mirror=False)
        bootstrap._validate_download_url(
            github,
            "https://release-assets.githubusercontent.com/"
            "github-production-release-asset/buck2.zst",
            mirror=False,
        )
        mirror = "https://artifacts.example.test/toolchains/buck2.zst"
        bootstrap._validate_download_url(mirror, mirror, mirror=True)

        rejected = (
            (github, "http://github.com/buck2.zst", False),
            (github, "https://evil.example/buck2.zst", False),
            (github, "https://user:secret@github.com/buck2.zst", False),
            (github, "https://github.com/buck2.zst#fragment", False),
            (mirror, "https://cdn.example.test/buck2.zst", True),
        )
        for initial_url, final_url, mirror_mode in rejected:
            with self.subTest(final_url=final_url, mirror=mirror_mode):
                with self.assertRaises(bootstrap.IntegrityError):
                    bootstrap._validate_download_url(
                        initial_url, final_url, mirror=mirror_mode
                    )

    def test_download_rejects_symlinked_parent_without_clobbering_outside(self) -> None:
        payload = b"verified payload"
        source_url = "https://static.rust-lang.org/dist/artifact.tar.xz"
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            outside = root / "outside"
            outside.mkdir()
            component_dir = root / "cache" / "linux-x86_64" / "rust"
            component_dir.parent.mkdir(parents=True)
            component_dir.symlink_to(outside, target_is_directory=True)
            destination = component_dir / "artifact.tar.xz"
            opener = self._FakeOpener(self._FakeResponse(payload, source_url))

            with self.assertRaisesRegex(bootstrap.IntegrityError, "symlink"):
                bootstrap._download_verified(
                    source_url,
                    destination,
                    hashlib.sha256(payload).hexdigest(),
                    mirror=False,
                    opener=opener,
                )

            self.assertEqual(list(outside.iterdir()), [])

    def test_download_validates_final_url_before_atomic_publish(self) -> None:
        payload = b"verified payload"
        digest = hashlib.sha256(payload).hexdigest()
        source_url = (
            "https://github.com/facebook/buck2/releases/download/v1/artifact.zst"
        )
        rejected_final_urls = (
            "http://github.com/artifact.zst",
            "https://evil.example/artifact.zst",
        )
        for final_url in rejected_final_urls:
            with self.subTest(final_url=final_url), tempfile.TemporaryDirectory() as temp_dir:
                destination = Path(temp_dir).resolve() / "cache" / "artifact.zst"
                opener = self._FakeOpener(self._FakeResponse(payload, final_url))
                with self.assertRaises(bootstrap.IntegrityError):
                    bootstrap._download_verified(
                        source_url,
                        destination,
                        digest,
                        mirror=False,
                        opener=opener,
                    )
                self.assertFalse(destination.exists())
                self.assertEqual(list(destination.parent.glob("*.partial-*")), [])

        with tempfile.TemporaryDirectory() as temp_dir:
            destination = Path(temp_dir).resolve() / "cache" / "artifact.zst"
            allowed_final_url = (
                "https://release-assets.githubusercontent.com/"
                "github-production-release-asset/artifact.zst"
            )
            opener = self._FakeOpener(
                self._FakeResponse(payload, allowed_final_url)
            )
            bootstrap._download_verified(
                source_url,
                destination,
                digest,
                mirror=False,
                opener=opener,
            )
            self.assertEqual(destination.read_bytes(), payload)
            self.assertFalse(destination.is_symlink())

    def test_download_uses_exclusive_random_staging_and_cleans_interruption(self) -> None:
        payload = b"verified payload"
        digest = hashlib.sha256(payload).hexdigest()
        source_url = "https://static.rust-lang.org/dist/artifact.tar.xz"
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            destination = root / "cache" / "artifact.tar.xz"
            destination.parent.mkdir(parents=True)
            outside = root / "outside"
            outside.write_bytes(b"sentinel")
            predictable = destination.with_name(
                f".{destination.name}.partial-{os.getpid()}"
            )
            predictable.symlink_to(outside)
            opener = self._FakeOpener(self._FakeResponse(payload, source_url))

            bootstrap._download_verified(
                source_url,
                destination,
                digest,
                mirror=False,
                opener=opener,
            )

            self.assertEqual(destination.read_bytes(), payload)
            self.assertEqual(outside.read_bytes(), b"sentinel")

        class InterruptedResponse(self._FakeResponse):
            def __init__(self) -> None:
                super().__init__(b"", source_url)
                self.calls = 0

            def read(self, _size: int = -1) -> bytes:
                self.calls += 1
                if self.calls == 1:
                    return b"partial"
                raise KeyboardInterrupt

        with tempfile.TemporaryDirectory() as temp_dir:
            destination = Path(temp_dir).resolve() / "cache" / "artifact.tar.xz"
            opener = self._FakeOpener(InterruptedResponse())
            with self.assertRaises(KeyboardInterrupt):
                bootstrap._download_verified(
                    source_url,
                    destination,
                    digest,
                    mirror=False,
                    opener=opener,
                )
            self.assertFalse(destination.exists())
            self.assertEqual(list(destination.parent.iterdir()), [])

    def test_derived_symlink_version_spoofs_fail_without_execution(self) -> None:
        platform_name = "linux-x86_64"
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            cache_dir = root / "cache"
            lock = self._fixture_lock()
            payloads = self._write_fixture_cache(lock, cache_dir, platform_name)
            marker = root / "spoof-executed"
            spoof = root / "version-spoof"
            self._write_executable(
                spoof,
                "#!/bin/sh\n"
                f"printf executed > {marker}\n"
                "case \"${1:-}\" in\n"
                f"  --version) printf '%s\\n' 'buck2 {lock['buck2']['version']}' ;;\n"
                "  -Vv) "
                f"printf '%s\\n' 'release: {lock['rust']['version']}' "
                f"'commit-hash: {lock['rust']['commit']}' ;;\n"
                "esac\n",
            )
            platform_entry = lock["platforms"][platform_name]
            buck_archive = bootstrap.cache_path(
                cache_dir, platform_name, "buck2", platform_entry["buck2"]
            )
            rust_archive = bootstrap.cache_path(
                cache_dir, platform_name, "rust", platform_entry["rust"]
            )
            buck_legacy = buck_archive.parent / "bin" / "buck2"
            buck_legacy.parent.mkdir()
            buck_legacy.symlink_to(spoof)
            rust_legacy = rust_archive.parent / "install" / "bin"
            rust_legacy.mkdir(parents=True)
            for name in ("rustc", "rustdoc", "clippy-driver"):
                (rust_legacy / name).symlink_to(spoof)

            with bootstrap.verified_cached_artifacts(
                lock, cache_dir, platform_name
            ) as artifacts:
                with self.assertRaisesRegex(bootstrap.IntegrityError, "symlink"):
                    bootstrap.materialize_buck2(
                        lock,
                        platform_name,
                        artifacts["buck2"],
                        {"PATH": os.environ.get("PATH", "")},
                    )
                with self.assertRaisesRegex(bootstrap.IntegrityError, "symlink"):
                    bootstrap.materialize_rust(
                        lock, platform_name, artifacts["rust"]
                    )

            self.assertFalse(marker.exists())
            self.assertEqual(payloads["buck2"], buck_archive.read_bytes())

    def test_decompressed_binary_identity_matrix_ignores_path_decoder(self) -> None:
        platform_name = "linux-x86_64"
        for corruption in (
            "different-content-same-size",
            "smaller-than-authenticated",
            "larger-than-authenticated",
        ):
            with self.subTest(
                corruption=corruption
            ), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir).resolve()
                cache_dir = root / "cache"
                lock = self._fixture_lock()
                expected_binary = self._pad_shell_executable(
                    self._buck_fixture_payload(lock), 1024
                )
                buck_entry = lock["platforms"][platform_name]["buck2"]
                buck_entry["binary_sha256"] = hashlib.sha256(
                    expected_binary
                ).hexdigest()
                buck_entry["binary_size"] = len(expected_binary)

                marker = root / f"{corruption}-executed"
                malicious_source = (
                    "#!/bin/sh\n"
                    f"printf executed > {marker}\n"
                    "if [ \"${1:-}\" = \"--version\" ]; then\n"
                    f"  printf '%s\\n' 'buck2 {lock['buck2']['version']}'\n"
                    "  exit 0\n"
                    "fi\n"
                    "exit 0\n"
                ).encode()
                if corruption == "different-content-same-size":
                    decoder_output = self._pad_shell_executable(
                        malicious_source, len(expected_binary)
                    )
                    self.assertEqual(len(decoder_output), len(expected_binary))
                elif corruption == "smaller-than-authenticated":
                    decoder_output = malicious_source
                    self.assertLess(len(decoder_output), len(expected_binary))
                else:
                    decoder_output = self._pad_shell_executable(
                        malicious_source, len(expected_binary) + 128
                    )
                    self.assertGreater(len(decoder_output), len(expected_binary))
                self.assertNotEqual(
                    hashlib.sha256(decoder_output).digest(),
                    hashlib.sha256(expected_binary).digest(),
                )
                self._write_fixture_cache(
                    lock,
                    cache_dir,
                    platform_name,
                    {
                        "buck2": self._zstd_compress(decoder_output),
                        "rust": b"fixture-rust",
                        "python": b"fixture-python",
                    },
                )

                fake_bin = root / "fake-bin"
                (fake_bin / "decoder-output").parent.mkdir(parents=True)
                (fake_bin / "decoder-output").write_bytes(decoder_output)
                decoder_marker = root / f"{corruption}-decoder-executed"
                self._write_executable(
                    fake_bin / "zstd",
                    "#!/bin/sh\n"
                    f"printf executed > {decoder_marker}\n"
                    "exec /bin/cat \"${0%/*}/decoder-output\"\n",
                )

                rejected: bootstrap.ToolchainError | None = None
                with bootstrap.verified_cached_artifacts(
                    lock, cache_dir, platform_name
                ) as artifacts:
                    try:
                        bootstrap.materialize_buck2(
                            lock,
                            platform_name,
                            artifacts["buck2"],
                            {"PATH": str(fake_bin)},
                        )
                    except bootstrap.ToolchainError as error:
                        rejected = error

                self.assertFalse(
                    marker.exists(),
                    "PATH-resolved decoder output was executed before its authenticated "
                    f"content, digest, and size were checked ({corruption})",
                )
                self.assertFalse(
                    decoder_marker.exists(),
                    "an arbitrary caller-PATH decoder executed before staged-file authentication",
                )
                self.assertIsInstance(
                    rejected,
                    bootstrap.IntegrityError,
                    "substituted decoder output must fail closed on binary identity",
                )
                buck_bin = bootstrap.cache_path(
                    cache_dir, platform_name, "buck2", buck_entry
                ).parent / "bin"
                self.assertEqual(
                    list(buck_bin.glob(".buck2-stage-*")), [],
                    "rejected decoder output left a staging executable behind",
                )
                self.assertEqual(
                    list(buck_bin.glob("buck2-generation-*")), [],
                    "rejected decoder output was published as a generation",
                )

    def test_buck_materialization_consumes_verified_fd_after_path_replacement(self) -> None:
        platform_name = "linux-x86_64"
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            cache_dir = root / "cache"
            lock = self._fixture_lock()
            valid_payload = self._buck_fixture_payload(lock)
            payloads = {
                "buck2": self._zstd_compress(valid_payload),
                "rust": b"fixture-rust",
                "python": b"fixture-python",
            }
            self._write_fixture_cache(lock, cache_dir, platform_name, payloads)
            fake_bin = root / "fake-bin"
            self._write_executable(fake_bin / "zstd", "#!/bin/sh\n/bin/cat\n")
            platform_entry = lock["platforms"][platform_name]
            archive_path = bootstrap.cache_path(
                cache_dir, platform_name, "buck2", platform_entry["buck2"]
            )
            marker = root / "replacement-executed"
            replacement = root / "replacement.zst"
            self._write_executable(
                replacement,
                "#!/bin/sh\n"
                f"printf executed > {marker}\n"
                f"printf '%s\\n' 'buck2 {lock['buck2']['version']}'\n",
            )

            with bootstrap.verified_cached_artifacts(
                lock, cache_dir, platform_name
            ) as artifacts:
                os.replace(replacement, archive_path)
                binary = bootstrap.materialize_buck2(
                    lock,
                    platform_name,
                    artifacts["buck2"],
                    {"PATH": str(fake_bin)},
                )
                version = subprocess.run(
                    [binary, "--version"],
                    text=True,
                    capture_output=True,
                    check=True,
                ).stdout.strip()

            self.assertEqual(version, f"buck2 {lock['buck2']['version']}")
            self.assertFalse(marker.exists())

    def test_authenticated_buck_stage_replacement_fails_before_execution(self) -> None:
        platform_name = "linux-x86_64"
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            cache_dir = root / "cache"
            lock = self._fixture_lock()
            valid_payload = self._buck_fixture_payload(lock)
            self._write_fixture_cache(
                lock,
                cache_dir,
                platform_name,
                {
                    "buck2": self._zstd_compress(valid_payload),
                    "rust": b"fixture-rust",
                    "python": b"fixture-python",
                },
            )
            decoder = shutil.which("zstd")
            if decoder is None:
                self.skipTest("zstd is unavailable for the pre-repair RED path")
            marker = root / "replacement-stage-executed"
            replacement = root / "replacement-buck2"
            self._write_executable(
                replacement,
                "#!/bin/sh\n"
                f"printf executed > {marker}\n"
                f"printf '%s\\n' 'buck2 {lock['buck2']['version']}'\n",
            )
            original_run_checked = bootstrap._run_checked
            replacement_attempted = False

            def replace_before_run(
                command: Sequence[str],
                *,
                cwd: Path | None = None,
                verified_executable_fd: int | None = None,
                pass_fds: Sequence[int] = (),
                **verified_options: Any,
            ) -> str:
                nonlocal replacement_attempted
                if command and Path(command[0]).name.startswith(".buck2-stage-"):
                    os.replace(replacement, Path(command[0]))
                    replacement_attempted = True
                options: dict[str, Any] = {**verified_options, "cwd": cwd}
                if verified_executable_fd is not None:
                    options["verified_executable_fd"] = verified_executable_fd
                if pass_fds:
                    options["pass_fds"] = pass_fds
                return original_run_checked(command, **options)

            with bootstrap.verified_cached_artifacts(
                lock, cache_dir, platform_name
            ) as artifacts, mock.patch.object(
                bootstrap, "_run_checked", side_effect=replace_before_run
            ):
                with self.assertRaises(bootstrap.IntegrityError):
                    bootstrap.materialize_buck2(
                        lock,
                        platform_name,
                        artifacts["buck2"],
                        {"PATH": str(Path(decoder).parent)},
                    )

            self.assertTrue(replacement_attempted)
            self.assertFalse(
                marker.exists(),
                "a pathname replacement executed after the opened stage was authenticated",
            )

    def test_rust_materialization_consumes_verified_fd_after_path_replacement(self) -> None:
        platform_name = "linux-x86_64"
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            cache_dir = root / "cache"
            lock = self._fixture_lock()
            rust_fixture = root / "rust-fixture.tar.xz"
            rust_payload = self._create_rust_fixture_archive(rust_fixture, lock)
            payloads = {
                "buck2": b"fixture-buck2",
                "rust": rust_payload,
                "python": b"fixture-python",
            }
            self._write_fixture_cache(lock, cache_dir, platform_name, payloads)
            platform_entry = lock["platforms"][platform_name]
            archive_path = bootstrap.cache_path(
                cache_dir, platform_name, "rust", platform_entry["rust"]
            )

            with bootstrap.verified_cached_artifacts(
                lock, cache_dir, platform_name
            ) as artifacts:
                malicious = root / "malicious-rust.tar.xz"
                malicious.write_bytes(b"malicious replacement")
                os.replace(malicious, archive_path)
                tools = bootstrap.materialize_rust(
                    lock, platform_name, artifacts["rust"]
                )
                verbose = subprocess.run(
                    [tools["rustc"], "-Vv"],
                    text=True,
                    capture_output=True,
                    check=True,
                ).stdout

            self.assertIn(f"release: {lock['rust']['version']}", verbose)
            self.assertIn(f"commit-hash: {lock['rust']['commit']}", verbose)

    def test_authenticated_rustc_replacement_fails_before_version_execution(self) -> None:
        platform_name = "linux-x86_64"
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            cache_dir = root / "cache"
            lock = self._fixture_lock()
            rust_fixture = root / "rust-fixture.tar.xz"
            self._write_fixture_cache(
                lock,
                cache_dir,
                platform_name,
                {
                    "buck2": b"fixture-buck2",
                    "rust": self._create_rust_fixture_archive(rust_fixture, lock),
                    "python": b"fixture-python",
                },
            )
            marker = root / "replacement-rustc-executed"
            replacement = root / "replacement-rustc"
            self._write_executable(
                replacement,
                "#!/bin/sh\n"
                f"printf executed > {marker}\n"
                f"printf '%s\\n' 'release: {lock['rust']['version']}' "
                f"'commit-hash: {lock['rust']['commit']}'\n",
            )
            original_run_checked = bootstrap._run_checked
            replacement_attempted = False

            def replace_before_run(
                command: Sequence[str],
                *,
                cwd: Path | None = None,
                verified_executable_fd: int | None = None,
                pass_fds: Sequence[int] = (),
                **verified_options: Any,
            ) -> str:
                nonlocal replacement_attempted
                if (
                    command
                    and Path(command[0]).name == "rustc"
                    and "-Vv" in command
                    and not replacement_attempted
                ):
                    os.replace(replacement, Path(command[0]))
                    replacement_attempted = True
                options: dict[str, Any] = {**verified_options, "cwd": cwd}
                if verified_executable_fd is not None:
                    options["verified_executable_fd"] = verified_executable_fd
                if pass_fds:
                    options["pass_fds"] = pass_fds
                return original_run_checked(command, **options)

            with bootstrap.verified_cached_artifacts(
                lock, cache_dir, platform_name
            ) as artifacts, mock.patch.object(
                bootstrap, "_run_checked", side_effect=replace_before_run
            ):
                with self.assertRaises(bootstrap.IntegrityError):
                    bootstrap.materialize_rust(
                        lock, platform_name, artifacts["rust"]
                    )

            self.assertTrue(replacement_attempted)
            self.assertFalse(
                marker.exists(),
                "a pathname replacement executed after rustc's opened file was authenticated",
            )

    def test_path_shell_cannot_substitute_unauthenticated_rust_executables(self) -> None:
        platform_name = "linux-x86_64"
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            cache_dir = root / "cache"
            lock = self._fixture_lock()
            rust_fixture = root / "rust-fixture.tar.xz"
            with tempfile.TemporaryDirectory() as source_dir:
                fixture_root = Path(source_dir) / "rust-fixture"
                self._write_executable(
                    fixture_root / "install.sh", "#!/bin/sh\nexit 99\n"
                )
                with tarfile.open(rust_fixture, "w:xz") as rust_archive:
                    rust_archive.add(fixture_root, arcname=fixture_root.name)

            rust_entry = lock["platforms"][platform_name]["rust"]
            expected_tools = {
                "rustc": b"authenticated-rustc-fixture",
                "rustdoc": b"authenticated-rustdoc-fixture",
                "clippy-driver": b"authenticated-clippy-fixture",
            }
            rust_entry["executables"] = {
                name: {
                    "sha256": hashlib.sha256(payload).hexdigest(),
                    "size": len(payload),
                }
                for name, payload in expected_tools.items()
            }
            self._write_fixture_cache(
                lock,
                cache_dir,
                platform_name,
                {
                    "buck2": b"fixture-buck2",
                    "rust": rust_fixture.read_bytes(),
                    "python": b"fixture-python",
                },
            )

            markers = {
                name: root / f"malicious-{name}-executed"
                for name in ("rustc", "rustdoc", "clippy-driver")
            }
            fake_bin = root / "fake-bin"
            self._write_executable(
                fake_bin / "sh",
                "#!/bin/sh\n"
                "set -eu\n"
                "prefix=''\n"
                "for arg in \"$@\"; do\n"
                "  case \"$arg\" in --prefix=*) prefix=${arg#--prefix=} ;; esac\n"
                "done\n"
                "test -n \"$prefix\"\n"
                "mkdir -p \"$prefix/bin\"\n"
                "cat >\"$prefix/bin/rustc\" <<'EOF'\n"
                "#!/bin/sh\n"
                "if [ \"${1:-}\" = \"-Vv\" ]; then\n"
                f"  printf '%s\\n' 'release: {lock['rust']['version']}' "
                f"'commit-hash: {lock['rust']['commit']}'\n"
                "else\n"
                f"  printf executed > {markers['rustc']}\n"
                "fi\n"
                "EOF\n"
                "cat >\"$prefix/bin/rustdoc\" <<'EOF'\n"
                "#!/bin/sh\n"
                f"printf executed > {markers['rustdoc']}\n"
                "EOF\n"
                "cat >\"$prefix/bin/clippy-driver\" <<'EOF'\n"
                "#!/bin/sh\n"
                f"printf executed > {markers['clippy-driver']}\n"
                "EOF\n"
                "chmod 755 \"$prefix/bin/rustc\" \"$prefix/bin/rustdoc\" "
                "\"$prefix/bin/clippy-driver\"\n",
            )

            rejected: bootstrap.ToolchainError | None = None
            returned_tools: dict[str, Path] | None = None
            path = os.pathsep.join((str(fake_bin), "/bin", "/usr/bin"))
            with mock.patch.dict(os.environ, {"PATH": path}, clear=False):
                with bootstrap.verified_cached_artifacts(
                    lock, cache_dir, platform_name
                ) as artifacts:
                    try:
                        returned_tools = bootstrap.materialize_rust(
                            lock, platform_name, artifacts["rust"]
                        )
                    except bootstrap.ToolchainError as error:
                        rejected = error
                if returned_tools is not None:
                    for tool in returned_tools.values():
                        subprocess.run([tool], check=False)

            self.assertEqual(
                [name for name, marker in markers.items() if marker.exists()],
                [],
                "a PATH-substituted shell installed Rust tools that were accepted and run",
            )
            self.assertIsNotNone(
                rejected,
                "the authenticated installer exits 99, so a PATH shell substitution "
                "must never produce an accepted Rust toolchain",
            )

    def test_rustc_verbose_identity_requires_exact_unique_fields(self) -> None:
        with self.assertRaisesRegex(bootstrap.IntegrityError, "duplicate.*release"):
            bootstrap._parse_unique_rustc_fields(
                "release: 1.96.0\nrelease: 1.96.0\n"
            )

        platform_name = "linux-x86_64"
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            cache_dir = root / "cache"
            lock = self._fixture_lock()
            rust_fixture = root / "rust-suffix-spoof.tar.xz"
            version = lock["rust"]["version"]
            commit = lock["rust"]["commit"]
            rustc = (
                "#!/bin/sh\n"
                "if [ \"${1:-}\" = \"-Vv\" ]; then\n"
                f"  printf '%s\\n' 'release: {version}-evil' "
                f"'commit-hash: {commit}-evil'\n"
                "fi\n"
            ).encode()
            rustdoc = b"#!/bin/sh\nexit 0\n"
            clippy = b"#!/bin/sh\nexit 0\n"
            with tempfile.TemporaryDirectory() as source_dir:
                fixture_root = Path(source_dir) / "rust-fixture"
                self._write_executable(
                    fixture_root / "install.sh",
                    "#!/bin/sh\n"
                    "set -eu\n"
                    "prefix=''\n"
                    "for arg in \"$@\"; do\n"
                    "  case \"$arg\" in --prefix=*) prefix=${arg#--prefix=} ;; esac\n"
                    "done\n"
                    "test -n \"$prefix\"\n"
                    "mkdir -p \"$prefix/bin\"\n"
                    "cat >\"$prefix/bin/rustc\" <<'EOF'\n"
                    f"{rustc.decode()}"
                    "EOF\n"
                    "cat >\"$prefix/bin/rustdoc\" <<'EOF'\n"
                    f"{rustdoc.decode()}"
                    "EOF\n"
                    "cat >\"$prefix/bin/clippy-driver\" <<'EOF'\n"
                    f"{clippy.decode()}"
                    "EOF\n"
                    "chmod 755 \"$prefix/bin/rustc\" \"$prefix/bin/rustdoc\" "
                    "\"$prefix/bin/clippy-driver\"\n",
                )
                with tarfile.open(rust_fixture, "w:xz") as rust_archive:
                    rust_archive.add(fixture_root, arcname=fixture_root.name)

            rust_entry = lock["platforms"][platform_name]["rust"]
            rust_entry["executables"] = {
                "rustc": {
                    "sha256": hashlib.sha256(rustc).hexdigest(),
                    "size": len(rustc),
                },
                "rustdoc": {
                    "sha256": hashlib.sha256(rustdoc).hexdigest(),
                    "size": len(rustdoc),
                },
                "clippy-driver": {
                    "sha256": hashlib.sha256(clippy).hexdigest(),
                    "size": len(clippy),
                },
            }
            self._write_fixture_cache(
                lock,
                cache_dir,
                platform_name,
                {
                    "buck2": b"fixture-buck2",
                    "rust": rust_fixture.read_bytes(),
                    "python": b"fixture-python",
                },
            )

            with bootstrap.verified_cached_artifacts(
                lock, cache_dir, platform_name
            ) as artifacts:
                with self.assertRaisesRegex(
                    bootstrap.IntegrityError, "does not match the repository lock"
                ):
                    bootstrap.materialize_rust(
                        lock, platform_name, artifacts["rust"]
                    )

    def test_python_mirror_serves_verified_fd_after_path_replacement(self) -> None:
        platform_name = "linux-x86_64"
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            cache_dir = root / "cache"
            lock = self._fixture_lock()
            payloads = self._write_fixture_cache(lock, cache_dir, platform_name)
            python_entry = lock["platforms"][platform_name]["python"]
            archive_path = bootstrap.cache_path(
                cache_dir, platform_name, "python", python_entry
            )

            with bootstrap.verified_cached_artifacts(
                lock, cache_dir, platform_name
            ) as artifacts:
                malicious = root / "malicious-python.tar.gz"
                malicious.write_bytes(b"malicious replacement")
                os.replace(malicious, archive_path)
                with bootstrap.local_mirror(artifacts["python"]) as url:
                    with urllib.request.urlopen(url, timeout=5) as response:
                        served = response.read()

            self.assertEqual(served, payloads["python"])

    def test_regular_version_spoof_outputs_are_recreated_without_execution(self) -> None:
        platform_name = "linux-x86_64"
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            cache_dir = root / "cache"
            lock = self._fixture_lock()
            rust_fixture = root / "rust-fixture.tar.xz"
            payloads = {
                "buck2": self._zstd_compress(self._buck_fixture_payload(lock)),
                "rust": self._create_rust_fixture_archive(rust_fixture, lock),
                "python": b"fixture-python",
            }
            self._write_fixture_cache(lock, cache_dir, platform_name, payloads)
            fake_bin = root / "fake-bin"
            self._write_executable(fake_bin / "zstd", "#!/bin/sh\n/bin/cat\n")
            marker = root / "legacy-spoof-executed"
            spoof_source = (
                "#!/bin/sh\n"
                f"printf executed > {marker}\n"
                "case \"${1:-}\" in\n"
                f"  --version) printf '%s\\n' 'buck2 {lock['buck2']['version']}' ;;\n"
                "  -Vv) "
                f"printf '%s\\n' 'release: {lock['rust']['version']}' "
                f"'commit-hash: {lock['rust']['commit']}' ;;\n"
                "esac\n"
            )
            platform_entry = lock["platforms"][platform_name]
            buck_archive = bootstrap.cache_path(
                cache_dir, platform_name, "buck2", platform_entry["buck2"]
            )
            rust_archive = bootstrap.cache_path(
                cache_dir, platform_name, "rust", platform_entry["rust"]
            )
            self._write_executable(buck_archive.parent / "bin" / "buck2", spoof_source)
            for name in ("rustc", "rustdoc", "clippy-driver"):
                self._write_executable(
                    rust_archive.parent / "install" / "bin" / name,
                    spoof_source,
                )

            with bootstrap.verified_cached_artifacts(
                lock, cache_dir, platform_name
            ) as artifacts:
                buck = bootstrap.materialize_buck2(
                    lock,
                    platform_name,
                    artifacts["buck2"],
                    {"PATH": str(fake_bin)},
                )
                rust = bootstrap.materialize_rust(
                    lock, platform_name, artifacts["rust"]
                )

            self.assertFalse(marker.exists())
            self.assertIn("buck2-generation-", buck.name)
            self.assertIn("rust-generation-", str(rust["rustc"]))

    def test_non_regular_legacy_derived_paths_fail_before_tool_execution(self) -> None:
        platform_name = "linux-x86_64"
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            cache_dir = root / "cache"
            lock = self._fixture_lock()
            self._write_fixture_cache(lock, cache_dir, platform_name)
            platform_entry = lock["platforms"][platform_name]
            buck_archive = bootstrap.cache_path(
                cache_dir, platform_name, "buck2", platform_entry["buck2"]
            )
            (buck_archive.parent / "bin" / "buck2").mkdir(parents=True)

            with bootstrap.verified_cached_artifacts(
                lock, cache_dir, platform_name
            ) as artifacts:
                with self.assertRaisesRegex(
                    bootstrap.IntegrityError, "not a regular file"
                ):
                    bootstrap.materialize_buck2(
                        lock,
                        platform_name,
                        artifacts["buck2"],
                        {"PATH": "/nonexistent"},
                    )

            rust_archive = bootstrap.cache_path(
                cache_dir, platform_name, "rust", platform_entry["rust"]
            )
            rust_legacy = rust_archive.parent / "install"
            rust_legacy.write_text("not a directory", encoding="utf-8")
            with bootstrap.verified_cached_artifacts(
                lock, cache_dir, platform_name
            ) as artifacts:
                with self.assertRaisesRegex(
                    bootstrap.IntegrityError, "not a directory"
                ):
                    bootstrap.materialize_rust(
                        lock, platform_name, artifacts["rust"]
                    )

    def test_failed_rust_materialization_cleans_exclusive_staging(self) -> None:
        platform_name = "linux-x86_64"
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            cache_dir = root / "cache"
            lock = self._fixture_lock()
            invalid_archive = root / "invalid-rust.tar.xz"
            with tempfile.TemporaryDirectory() as source_dir:
                installer = Path(source_dir) / "rust-fixture" / "install.sh"
                self._write_executable(installer, "#!/bin/sh\nexit 23\n")
                with tarfile.open(invalid_archive, "w:xz") as rust_archive:
                    rust_archive.add(installer.parent, arcname="rust-fixture")
            payloads = {
                "buck2": b"fixture-buck2",
                "rust": invalid_archive.read_bytes(),
                "python": b"fixture-python",
            }
            self._write_fixture_cache(lock, cache_dir, platform_name, payloads)
            rust_entry = lock["platforms"][platform_name]["rust"]
            rust_component = bootstrap.cache_path(
                cache_dir, platform_name, "rust", rust_entry
            ).parent

            with bootstrap.verified_cached_artifacts(
                lock, cache_dir, platform_name
            ) as artifacts:
                with self.assertRaises(bootstrap.ToolchainError):
                    bootstrap.materialize_rust(
                        lock, platform_name, artifacts["rust"]
                    )

            leftovers = [
                path.name
                for path in rust_component.iterdir()
                if path.name.startswith(
                    (".rust-stage-", ".rust-extract-", "rust-generation-")
                )
            ]
            self.assertEqual(leftovers, [])

    def test_concurrent_buck_cleanup_preserves_another_live_stage(self) -> None:
        platform_name = "linux-x86_64"
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            lock, cache_dir, env = self._create_materializable_fixture(root)
            buck_entry = lock["platforms"][platform_name]["buck2"]
            buck_component = bootstrap.cache_path(
                cache_dir, platform_name, "buck2", buck_entry
            ).parent
            bin_dir = buck_component / "bin"

            first_stage_ready = threading.Event()
            release_first = threading.Event()
            first_stages: list[Path] = []
            first_result: dict[str, object] = {}
            second_result: dict[str, object] = {}
            original_decompress = bootstrap._decompress_buck2

            def block_first_decompress(*args: Any) -> None:
                original_decompress(*args)
                if threading.current_thread().name == "buck-first":
                    first_stages[:] = sorted(bin_dir.glob(".buck2-stage-*"))
                    first_stage_ready.set()
                    if not release_first.wait(timeout=10):
                        raise AssertionError("timed out releasing the first Buck2 stage")

            with bootstrap.verified_cached_artifacts(
                lock, cache_dir, platform_name
            ) as artifacts, mock.patch.object(
                bootstrap, "_decompress_buck2", side_effect=block_first_decompress
            ):
                invoke = lambda: bootstrap.materialize_buck2(
                    lock, platform_name, artifacts["buck2"], env
                )
                first = threading.Thread(
                    name="buck-first",
                    target=self._capture_thread_call,
                    args=(first_result, invoke),
                )
                second = threading.Thread(
                    name="buck-second",
                    target=self._capture_thread_call,
                    args=(second_result, invoke),
                )
                first.start()
                try:
                    self.assertTrue(
                        first_stage_ready.wait(timeout=10),
                        "first Buck2 invocation did not reach controlled staging barrier",
                    )
                    self.assertEqual(len(first_stages), 1)
                    self.assertTrue(first_stages[0].exists())
                    second.start()
                    second.join(timeout=10)
                    self.assertFalse(
                        second.is_alive(),
                        "second Buck2 materialization did not complete while the first stage was live",
                    )
                    self.assertNotIn(
                        "error", second_result, repr(second_result.get("error"))
                    )
                    self.assertTrue(
                        first_stages[0].exists(),
                        "one Buck2 invocation deleted another invocation's live stage",
                    )
                finally:
                    release_first.set()
                    first.join(timeout=10)
                    if second.is_alive():
                        second.join(timeout=10)

            self.assertFalse(first.is_alive(), "first Buck2 invocation did not finish")
            self.assertFalse(second.is_alive(), "second Buck2 invocation did not finish")
            self.assertNotIn("error", first_result, repr(first_result.get("error")))

    def test_concurrent_rust_cleanup_preserves_another_live_stage_and_extract(self) -> None:
        platform_name = "linux-x86_64"
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            lock, cache_dir, _env = self._create_materializable_fixture(root)
            rust_entry = lock["platforms"][platform_name]["rust"]
            rust_component = bootstrap.cache_path(
                cache_dir, platform_name, "rust", rust_entry
            ).parent

            first_installer_ready = threading.Event()
            release_first = threading.Event()
            first_transients: list[Path] = []
            first_result: dict[str, object] = {}
            second_result: dict[str, object] = {}
            original_run_checked = bootstrap._run_checked

            def block_first_installer(
                command: Sequence[str],
                *,
                cwd: Path | None = None,
                verified_executable_fd: int | None = None,
                pass_fds: Sequence[int] = (),
                **verified_options: Any,
            ) -> str:
                if (
                    threading.current_thread().name == "rust-first"
                    and command
                    and command[0] == "sh"
                ):
                    first_transients[:] = sorted(
                        path
                        for path in rust_component.iterdir()
                        if path.name.startswith((".rust-stage-", ".rust-extract-"))
                    )
                    first_installer_ready.set()
                    if not release_first.wait(timeout=10):
                        raise AssertionError("timed out releasing the first Rust stage")
                options: dict[str, Any] = {**verified_options, "cwd": cwd}
                if verified_executable_fd is not None:
                    options["verified_executable_fd"] = verified_executable_fd
                if pass_fds:
                    options["pass_fds"] = pass_fds
                return original_run_checked(command, **options)

            with bootstrap.verified_cached_artifacts(
                lock, cache_dir, platform_name
            ) as artifacts, mock.patch.object(
                bootstrap, "_run_checked", side_effect=block_first_installer
            ):
                invoke = lambda: bootstrap.materialize_rust(
                    lock, platform_name, artifacts["rust"]
                )
                first = threading.Thread(
                    name="rust-first",
                    target=self._capture_thread_call,
                    args=(first_result, invoke),
                )
                second = threading.Thread(
                    name="rust-second",
                    target=self._capture_thread_call,
                    args=(second_result, invoke),
                )
                first.start()
                try:
                    self.assertTrue(
                        first_installer_ready.wait(timeout=10),
                        "first Rust invocation did not reach controlled installer barrier",
                    )
                    self.assertEqual(
                        {path.name.split("-", 3)[1] for path in first_transients},
                        {"stage", "extract"},
                    )
                    self.assertTrue(all(path.exists() for path in first_transients))
                    second.start()
                    second.join(timeout=10)
                    self.assertFalse(
                        second.is_alive(),
                        "second Rust materialization did not complete while first transients were live",
                    )
                    self.assertNotIn(
                        "error", second_result, repr(second_result.get("error"))
                    )
                    self.assertTrue(
                        all(path.exists() for path in first_transients),
                        "one Rust invocation deleted another invocation's live stage or extract tree",
                    )
                finally:
                    release_first.set()
                    first.join(timeout=10)
                    if second.is_alive():
                        second.join(timeout=10)

            self.assertFalse(first.is_alive(), "first Rust invocation did not finish")
            self.assertFalse(second.is_alive(), "second Rust invocation did not finish")
            self.assertNotIn("error", first_result, repr(first_result.get("error")))

    def test_concurrent_run_preserves_live_buck_and_rust_generations(self) -> None:
        platform_name = "linux-x86_64"
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            lock, cache_dir, env = self._create_materializable_fixture(root)
            first_running = threading.Event()
            second_running = threading.Event()
            release_first = threading.Event()
            first_live_paths: list[Path] = []
            first_result: dict[str, object] = {}
            second_result: dict[str, object] = {}
            real_run = subprocess.run

            def controlled_run(command: Any, *args: Any, **kwargs: Any) -> Any:
                is_buck_generation = (
                    isinstance(command, (list, tuple))
                    and bool(command)
                    and "buck2-generation-" in Path(str(command[0])).name
                    and "--version" not in command
                )
                if not is_buck_generation:
                    return real_run(command, *args, **kwargs)

                if threading.current_thread().name == "run-first":
                    first_live_paths.append(Path(str(command[0])))
                    for argument in command:
                        text = str(argument)
                        if text.startswith(
                            (
                                "toolchain.rustc=",
                                "toolchain.rustdoc=",
                                "toolchain.clippy_driver=",
                            )
                        ):
                            first_live_paths.append(Path(text.split("=", 1)[1]))
                    first_running.set()
                    if not release_first.wait(timeout=10):
                        raise AssertionError("timed out releasing the first Buck2 run")
                elif threading.current_thread().name == "run-second":
                    second_running.set()
                return subprocess.CompletedProcess(command, 0)

            invoke = lambda: bootstrap.run_buck(
                lock, cache_dir, platform_name, ["query", "//:fixture"], env
            )
            first = threading.Thread(
                name="run-first",
                target=self._capture_thread_call,
                args=(first_result, invoke),
            )
            second = threading.Thread(
                name="run-second",
                target=self._capture_thread_call,
                args=(second_result, invoke),
            )
            with mock.patch.object(
                bootstrap.subprocess, "run", side_effect=controlled_run
            ):
                first.start()
                live_during_overlap: list[bool] = []
                try:
                    self.assertTrue(
                        first_running.wait(timeout=10),
                        "first invocation did not reach the controlled Buck2 run barrier",
                    )
                    self.assertEqual(len(first_live_paths), 4)
                    self.assertTrue(all(path.exists() for path in first_live_paths))
                    second.start()
                    self.assertTrue(
                        second_running.wait(timeout=10),
                        "second Buck2 run did not overlap the first live generation",
                    )
                    live_during_overlap = [path.exists() for path in first_live_paths]
                    self.assertEqual(
                        live_during_overlap,
                        [True, True, True, True],
                        "a concurrent invocation deleted another live buck2-generation-* "
                        "or rust-generation-* executable before its Buck2 process exited",
                    )
                finally:
                    release_first.set()
                    first.join(timeout=10)
                    if second.ident is not None:
                        second.join(timeout=10)

            self.assertFalse(first.is_alive(), "first Buck2 run did not finish")
            self.assertFalse(second.is_alive(), "second Buck2 run did not finish")
            self.assertEqual(first_result.get("value"), 0, repr(first_result))
            self.assertEqual(second_result.get("value"), 0, repr(second_result))
            self.assertEqual(
                [path.exists() for path in first_live_paths],
                [False, False, False, False],
                "the first invocation's exact cleanup callbacks left owned generations behind",
            )

    def test_compiler_override_matrix_fails_closed(self) -> None:
        lock = bootstrap.load_lock()
        platform_entry = lock["platforms"]["linux-x86_64"]
        with tempfile.TemporaryDirectory() as temp_dir:
            bin_dir = Path(temp_dir).resolve()
            tools: dict[str, str] = {}
            for environment_name, filename in (
                ("BUCK2_CC", "gcc"),
                ("BUCK2_CXX", "g++"),
                ("BUCK2_AR", "gcc-ar"),
                ("BUCK2_LD", "gcc"),
            ):
                executable = bin_dir / filename
                self._write_executable(
                    executable,
                    "#!/bin/sh\nprintf '%s\\n' 'gcc (GCC) 15.1.0'\n",
                )
                tools[environment_name] = str(executable)

            with self.assertRaisesRegex(bootstrap.ToolchainError, "set together"):
                bootstrap.resolve_cxx_tools(
                    "linux-x86_64",
                    platform_entry,
                    {"PATH": str(bin_dir), "BUCK2_CC": tools["BUCK2_CC"]},
                )

            for standalone_type in ("clang", "bogus", ""):
                with self.subTest(standalone_type=standalone_type):
                    with self.assertRaises(bootstrap.ToolchainError):
                        bootstrap.resolve_cxx_tools(
                            "linux-x86_64",
                            platform_entry,
                            {
                                "PATH": str(bin_dir),
                                "BUCK2_CXX_COMPILER_TYPE": standalone_type,
                            },
                        )

            resolved = bootstrap.resolve_cxx_tools(
                "linux-x86_64",
                platform_entry,
                {**tools, "PATH": str(bin_dir), "BUCK2_CXX_COMPILER_TYPE": "gcc"},
            )
            self.assertEqual(resolved["compiler_type"], "gcc")

            inferred = bootstrap.resolve_cxx_tools(
                "linux-x86_64",
                platform_entry,
                {**tools, "PATH": str(bin_dir)},
            )
            self.assertEqual(inferred["compiler_type"], "gcc")

    def test_generic_compiler_overrides_require_type_and_reject_contradiction(self) -> None:
        lock = bootstrap.load_lock()
        platform_entry = lock["platforms"]["linux-x86_64"]
        with tempfile.TemporaryDirectory() as temp_dir:
            bin_dir = Path(temp_dir).resolve()
            tools: dict[str, str] = {}
            for environment_name, filename in (
                ("BUCK2_CC", "cc"),
                ("BUCK2_CXX", "c++"),
                ("BUCK2_AR", "ar"),
                ("BUCK2_LD", "ld"),
            ):
                executable = bin_dir / filename
                self._write_executable(
                    executable,
                    "#!/bin/sh\nprintf '%s\\n' 'gcc (GCC) 15.1.0'\n",
                )
                tools[environment_name] = str(executable)
            base_env = {**tools, "PATH": str(bin_dir)}

            with self.assertRaisesRegex(
                bootstrap.ToolchainError, "requires an explicit.*COMPILER_TYPE"
            ):
                bootstrap.resolve_cxx_tools(
                    "linux-x86_64", platform_entry, base_env
                )

            with self.assertRaisesRegex(
                bootstrap.ToolchainError, "does not match.*clang"
            ):
                bootstrap.resolve_cxx_tools(
                    "linux-x86_64",
                    platform_entry,
                    {**base_env, "BUCK2_CXX_COMPILER_TYPE": "clang"},
                )

            resolved = bootstrap.resolve_cxx_tools(
                "linux-x86_64",
                platform_entry,
                {**base_env, "BUCK2_CXX_COMPILER_TYPE": "gcc"},
            )
            self.assertEqual(resolved["compiler_type"], "gcc")

    def test_linux_fixture_falls_back_to_a_complete_gcc_toolchain(self) -> None:
        lock = bootstrap.load_lock()
        with tempfile.TemporaryDirectory() as temp_dir:
            bin_dir = Path(temp_dir).resolve()
            for name in ("gcc", "g++", "gcc-ar"):
                self._write_executable(bin_dir / name, "#!/bin/sh\nexit 0\n")

            resolved = bootstrap.resolve_cxx_tools(
                "linux-x86_64",
                lock["platforms"]["linux-x86_64"],
                {"PATH": str(bin_dir)},
            )

        self.assertEqual(resolved["compiler_type"], "gcc")
        self.assertEqual(Path(resolved["archiver"]).name, "gcc-ar")

    def test_each_component_tamper_path_is_rejected_independently(self) -> None:
        platform_name = "linux-x86_64"
        for tampered_component in bootstrap.SUPPORTED_COMPONENTS:
            with self.subTest(
                component=tampered_component
            ), tempfile.TemporaryDirectory() as temp_dir:
                cache_dir = Path(temp_dir).resolve()
                lock = self._fixture_lock()
                self._write_fixture_cache(lock, cache_dir, platform_name)
                entry = lock["platforms"][platform_name][tampered_component]
                path = bootstrap.cache_path(
                    cache_dir, platform_name, tampered_component, entry
                )
                path.write_bytes(b"tampered")

                with self.assertRaisesRegex(
                    bootstrap.IntegrityError,
                    rf"cached {tampered_component} failed SHA-256 verification",
                ):
                    with bootstrap.verified_cached_artifacts(
                        lock, cache_dir, platform_name
                    ):
                        self.fail("tampered component was accepted")

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
            cache_dir = Path(temp_dir).resolve()
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
                with bootstrap.verified_cached_artifacts(
                    lock, cache_dir, platform_name
                ):
                    self.fail("tampered cache was accepted")

    def test_population_requires_explicit_network_gate(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            result = subprocess.run(
                [
                    sys.executable,
                    "-I",
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
            cache_dir = Path(temp_dir).resolve()
            result = subprocess.run(
                [
                    sys.executable,
                    "-I",
                    str(BOOTSTRAP),
                    "run",
                    "--cache-dir",
                    str(cache_dir),
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
