from __future__ import annotations

import copy
import hashlib
import io
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest
import urllib.request
from pathlib import Path

from tools.buck.bootstrap import bootstrap


REPO_ROOT = Path(__file__).resolve().parents[4]
LOCK_PATH = REPO_ROOT / "tools" / "buck" / "toolchain-lock.json"
TOOLCHAINS_BUCK = REPO_ROOT / "toolchains" / "BUCK"
BOOTSTRAP = REPO_ROOT / "tools" / "buck" / "bootstrap" / "bootstrap.py"
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
    def _fixture_lock() -> dict[str, object]:
        return copy.deepcopy(bootstrap.load_lock())

    @staticmethod
    def _write_fixture_cache(
        lock: dict[str, object],
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
    def _buck_fixture_payload(cls, lock: dict[str, object]) -> bytes:
        version = lock["buck2"]["version"]
        return (
            "#!/bin/sh\n"
            "if [ \"${1:-}\" = \"--version\" ]; then\n"
            f"  printf '%s\\n' 'buck2 {version}'\n"
            "  exit 0\n"
            "fi\n"
            "exit 0\n"
        ).encode()

    @classmethod
    def _create_rust_fixture_archive(
        cls, archive: Path, lock: dict[str, object]
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
        return archive.read_bytes()

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

    def test_buck_materialization_consumes_verified_fd_after_path_replacement(self) -> None:
        platform_name = "linux-x86_64"
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            cache_dir = root / "cache"
            lock = self._fixture_lock()
            valid_payload = self._buck_fixture_payload(lock)
            payloads = {
                "buck2": valid_payload,
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
                "buck2": self._buck_fixture_payload(lock),
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
                self._write_executable(executable, "#!/bin/sh\nexit 0\n")
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
