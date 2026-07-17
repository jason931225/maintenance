"""Hostile tests for the independently recomputed current-lock receipt."""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import unittest

import current_lock_rust_graph as graph


LIVE_REPO = Path(os.environ["MAINTENANCE_REPO_ROOT"]).resolve(strict=True)


class CurrentLockRustGraphValidatorTests(unittest.TestCase):
    _MUTABLE_PATHS = (
        graph.BUCK_PATH,
        graph.LOCK_PATH,
        graph.RECEIPT_PATH,
        Path("backend/duplicate-app/Cargo.toml"),
        Path("backend/fixups/openssl-sys/fixups.toml"),
        Path("backend/vendor/calamine-0.35.0-quickxml41/BUCK"),
        Path("tools/buck/toolchain-lock.json"),
        graph.SQLX_MIGRATION_HELPER_PATH,
        graph.SQLX_MIGRATION_IDENTITY_SOURCE_PATH,
        graph.SQLX_MIGRATION_SENTINEL_SOURCE_PATH,
        graph.SQLX_MIGRATION_PLATFORM_DB_BUCK_PATH,
        graph.SQLX_MIGRATIONS_PATH / "0001_create_users.sql",
        graph.SQLX_MIGRATIONS_PATH / "0002_create_users.sql",
        graph.SQLX_MIGRATIONS_PATH / "0003_create_audit_events.sql",
        graph.SQLX_MIGRATIONS_PATH / "0026_create_organizations.sql",
        graph.SQLX_MIGRATIONS_PATH / "0042_create_site_attendance.sql",
    )

    def setUp(self) -> None:
        existing = getattr(type(self), "_shared_temporary", None)
        if existing is not None:
            self.repo = type(self)._shared_repo
            return
        self.temporary = tempfile.TemporaryDirectory()
        self.repo = Path(self.temporary.name) / "repo"
        self.repo.mkdir()
        (self.repo / ".buckroot").touch()
        for manifest in (LIVE_REPO / "backend").rglob("Cargo.toml"):
            self._copy(manifest.relative_to(LIVE_REPO))
        for vendor in (
            "calamine-0.35.0-quickxml41",
            "quick-xml-0.41.0-compat",
            "umya-spreadsheet-3.0.0-quickxml41",
        ):
            source = LIVE_REPO / "backend/vendor" / vendor
            destination = self.repo / "backend/vendor" / vendor
            shutil.copytree(source, destination, dirs_exist_ok=True)
        shutil.copytree(
            LIVE_REPO / graph.SQLX_MIGRATIONS_PATH,
            self.repo / graph.SQLX_MIGRATIONS_PATH,
        )
        for relative in (
            graph.LOCK_PATH,
            graph.BUCK_PATH,
            graph.RECEIPT_PATH,
            Path("tools/buck/toolchain-lock.json"),
            Path("toolchains/BUCK"),
            Path("toolchains/config.bzl"),
            Path("backend/fixups/openssl-sys/fixups.toml"),
            Path("backend/fixups/openssl/fixups.toml"),
            Path("backend/vendor/calamine-0.35.0-quickxml41/BUCK"),
            Path("backend/vendor/quick-xml-0.41.0-compat/BUCK"),
            Path("backend/vendor/umya-spreadsheet-3.0.0-quickxml41/BUCK"),
            graph.SQLX_MIGRATION_HELPER_PATH,
            graph.SQLX_MIGRATION_IDENTITY_SOURCE_PATH,
            graph.SQLX_MIGRATION_SENTINEL_SOURCE_PATH,
            *graph.SQLX_MIGRATION_CONSUMERS,
        ):
            self._copy(relative)
        type(self)._shared_temporary = self.temporary
        type(self)._shared_repo = self.repo

    def tearDown(self) -> None:
        for relative in self._MUTABLE_PATHS:
            destination = self.repo / relative
            if destination.is_dir() and not destination.is_symlink():
                shutil.rmtree(destination)
            else:
                destination.unlink(missing_ok=True)
            source = LIVE_REPO / relative
            if source.is_file():
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, destination)
        duplicate_directory = self.repo / "backend/duplicate-app"
        if duplicate_directory.is_dir():
            duplicate_directory.rmdir()

    @classmethod
    def tearDownClass(cls) -> None:
        temporary = getattr(cls, "_shared_temporary", None)
        if temporary is not None:
            temporary.cleanup()
            del cls._shared_temporary
            del cls._shared_repo

    def _copy(self, relative: Path) -> None:
        source = LIVE_REPO / relative
        destination = self.repo / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)

    def _replace_once(self, relative: Path, old: str, new: str) -> None:
        path = self.repo / relative
        text = path.read_text(encoding="utf-8")
        self.assertIn(old, text)
        path.write_text(text.replace(old, new, 1), encoding="utf-8")

    def test_live_receipt_is_recomputed_not_trusted(self) -> None:
        graph.check_receipt(LIVE_REPO)

    def test_rejects_mirror_route_tamper(self) -> None:
        self._replace_once(graph.BUCK_PATH, "/download\"],", "/download?evil\"],")
        with self.assertRaisesRegex(graph.GraphError, "exactly match Cargo.lock"):
            graph.build_receipt(self.repo)

    def test_rejects_raw_semver_build_metadata_mirror_route(self) -> None:
        self._replace_once(
            graph.BUCK_PATH,
            "/crates/wasip2/1.0.3%2Bwasi-0.2.9/download",
            "/crates/wasip2/1.0.3+wasi-0.2.9/download",
        )
        with self.assertRaisesRegex(graph.GraphError, "exactly match Cargo.lock"):
            graph.build_receipt(self.repo)

    def test_rejects_archive_checksum_tamper(self) -> None:
        path = self.repo / graph.BUCK_PATH
        text = path.read_text(encoding="utf-8")
        tampered, count = re.subn(
            r'(?m)^    sha256 = "[0-9a-f]{64}",$',
            '    sha256 = "' + ("0" * 64) + '",',
            text,
            count=1,
        )
        self.assertEqual(1, count)
        path.write_text(tampered, encoding="utf-8")
        with self.assertRaisesRegex(graph.GraphError, "exactly match Cargo.lock"):
            graph.build_receipt(self.repo)

    def test_rejects_incomplete_all_registry_archive_aggregate(self) -> None:
        path = self.repo / graph.BUCK_PATH
        text = path.read_text(encoding="utf-8")
        aggregate_start = text.index(
            f'    name = "{graph.ALL_REGISTRY_ARCHIVES_TARGET}",'
        )
        member_start = text.index('        ":', aggregate_start)
        member_end = text.index("\n", member_start) + 1
        path.write_text(text[:member_start] + text[member_end:], encoding="utf-8")
        with self.assertRaisesRegex(graph.GraphError, "aggregate must contain every archive"):
            graph.build_receipt(self.repo)

    def test_rejects_private_registry_rust_library(self) -> None:
        path = self.repo / graph.BUCK_PATH
        text = path.read_text(encoding="utf-8")
        rust_library = text.index("cargo.rust_library(")
        visibility = text.index('    visibility = ["PUBLIC"],', rust_library)
        path.write_text(
            text[:visibility]
            + "    visibility = [],"
            + text[visibility + len('    visibility = ["PUBLIC"],') :],
            encoding="utf-8",
        )
        with self.assertRaisesRegex(graph.GraphError, "must be public"):
            graph.build_receipt(self.repo)

    def test_rejects_lock_checksum_tamper(self) -> None:
        lock = self.repo / graph.LOCK_PATH
        text = lock.read_text(encoding="utf-8")
        tampered, count = re.subn(
            r'(?m)^checksum = "[0-9a-f]{64}"$',
            'checksum = "' + ("0" * 64) + '"',
            text,
            count=1,
        )
        self.assertEqual(1, count)
        lock.write_text(tampered, encoding="utf-8")
        with self.assertRaises(graph.GraphError):
            graph.build_receipt(self.repo)

    def test_rejects_lock_source_tamper(self) -> None:
        self._replace_once(
            graph.LOCK_PATH,
            graph.REGISTRY_SOURCE,
            "registry+https://evil.example/index",
        )
        with self.assertRaisesRegex(graph.GraphError, "unrecognized locked source"):
            graph.build_receipt(self.repo)

    def test_rejects_duplicate_local_manifest_identity(self) -> None:
        source = self.repo / "backend/app/Cargo.toml"
        duplicate = self.repo / "backend/duplicate-app/Cargo.toml"
        duplicate.parent.mkdir()
        shutil.copy2(source, duplicate)
        with self.assertRaisesRegex(graph.GraphError, "resolves to 2 manifests"):
            graph.build_receipt(self.repo)

    def test_rejects_receipt_tamper(self) -> None:
        (self.repo / graph.RECEIPT_PATH).write_text("{}\n", encoding="utf-8")
        with self.assertRaisesRegex(graph.GraphError, "is stale"):
            graph.check_receipt(self.repo)

    def test_rejects_lock_boundary_tamper(self) -> None:
        path = self.repo / graph.BUCK_PATH
        text = path.read_text(encoding="utf-8")
        tampered, count = re.subn(
            r'authenticated_crate_archive_base_url\("[0-9a-f]{64}"\)',
            'authenticated_crate_archive_base_url("' + ("0" * 64) + '")',
            text,
            count=1,
        )
        self.assertEqual(1, count)
        path.write_text(tampered, encoding="utf-8")
        with self.assertRaisesRegex(graph.GraphError, "exact Cargo.lock SHA-256"):
            graph.build_receipt(self.repo)

    def test_rejects_vendor_target_tamper(self) -> None:
        vendor = Path("backend/vendor/calamine-0.35.0-quickxml41/BUCK")
        self._replace_once(vendor, 'crate_root = "src/lib.rs"', 'crate_root = "src/evil.rs"')
        with self.assertRaisesRegex(graph.GraphError, "lacks contained crate root"):
            graph.build_receipt(self.repo)

    def test_rejects_root_alias_away_from_package_owned_vendor_patch(self) -> None:
        self._replace_once(
            graph.BUCK_PATH,
            'actual = "//backend/vendor/calamine-0.35.0-quickxml41:calamine-0.35"',
            'actual = ":calamine-0.35"',
        )
        with self.assertRaisesRegex(graph.GraphError, "current-lock alias calamine"):
            graph.build_receipt(self.repo)

    def test_rejects_duplicate_root_vendor_patch_owner(self) -> None:
        path = self.repo / graph.BUCK_PATH
        text = path.read_text(encoding="utf-8")
        duplicate = '''cargo.rust_library(
    name = "duplicate-calamine-owner",
    env = {
        "CARGO_MANIFEST_DIR": "vendor/calamine-0.35.0-quickxml41",
    },
    visibility = ["PUBLIC"],
)

'''
        path.write_text(text + duplicate, encoding="utf-8")
        with self.assertRaisesRegex(graph.GraphError, "duplicate vendor patch owner"):
            graph.build_receipt(self.repo)

    def test_rejects_unstaged_vendor_literal_include_resource(self) -> None:
        vendor = Path("backend/vendor/calamine-0.35.0-quickxml41/BUCK")
        self._replace_once(vendor, '        "Changelog.md",\n', "")
        with self.assertRaisesRegex(
            graph.GraphError, "vendor literal include resource must be staged exactly once"
        ):
            graph.build_receipt(self.repo)

    def test_rejects_cedar_buildscript_output_redirection(self) -> None:
        self._replace_once(
            graph.BUCK_PATH,
            '"OUT_DIR": "$(location :cedar-policy-core-4-build-script-run[out_dir])"',
            '"OUT_DIR": "$(location :evil-build-script-run[out_dir])"',
        )
        with self.assertRaisesRegex(
            graph.GraphError, "does not consume exact buildscript outputs"
        ):
            graph.build_receipt(self.repo)

    def test_rejects_cedar_buildscript_runner_redirection(self) -> None:
        self._replace_once(
            graph.BUCK_PATH,
            'buildscript_rule = ":cedar-policy-core-4-build-script-build"',
            'buildscript_rule = ":evil-build-script-build"',
        )
        with self.assertRaisesRegex(graph.GraphError, "buildscript runner is not exact"):
            graph.build_receipt(self.repo)

    def test_rejects_cedar_build_dependency_omission(self) -> None:
        self._replace_once(graph.BUCK_PATH, 'deps = [":lalrpop-0.22"]', "deps = []")
        with self.assertRaisesRegex(graph.GraphError, "lacks dependency lalrpop-0.22"):
            graph.build_receipt(self.repo)

    def test_rejects_required_buildscript_receipt_tamper(self) -> None:
        receipt = self.repo / graph.RECEIPT_PATH
        document = json.loads(receipt.read_text(encoding="utf-8"))
        document["required_buildscripts"][0]["runner_target"] = "//backend:evil"
        receipt.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        with self.assertRaisesRegex(graph.GraphError, "is stale"):
            graph.check_receipt(self.repo)

    def test_rejects_openssl_native_dependency_redirection(self) -> None:
        self._replace_once(
            graph.BUCK_PATH,
            '"toolchains//:openssl-static",',
            '"toolchains//:ambient-host-openssl",',
        )
        with self.assertRaisesRegex(graph.GraphError, "OpenSSL native dependency"):
            graph.build_receipt(self.repo)

    def test_rejects_openssl_buildscript_host_discovery(self) -> None:
        self._replace_once(
            Path("backend/fixups/openssl-sys/fixups.toml"),
            "run = false",
            "run = true",
        )
        with self.assertRaisesRegex(graph.GraphError, "OpenSSL fixup"):
            graph.build_receipt(self.repo)

    def test_rejects_openssl_static_member_identity_tamper(self) -> None:
        path = self.repo / "tools/buck/toolchain-lock.json"
        document = json.loads(path.read_text(encoding="utf-8"))
        document["platforms"]["macos-aarch64"]["openssl"]["static_libraries"][
            "ssl"
        ]["sha256"] = "0" * 64
        path.write_text(json.dumps(document), encoding="utf-8")
        with self.assertRaisesRegex(graph.GraphError, "OpenSSL static library"):
            graph.build_receipt(self.repo)

    def test_rejects_openssl_contract_symlink(self) -> None:
        path = self.repo / "backend/fixups/openssl-sys/fixups.toml"
        path.unlink()
        path.symlink_to(LIVE_REPO / "backend/fixups/openssl-sys/fixups.toml")
        with self.assertRaisesRegex(graph.GraphError, "regular non-symlink"):
            graph.build_receipt(self.repo)

    def test_rejects_required_native_dependency_receipt_tamper(self) -> None:
        receipt = self.repo / graph.RECEIPT_PATH
        document = json.loads(receipt.read_text(encoding="utf-8"))
        self.assertIn("required_native_dependencies", document)
        document["required_native_dependencies"][0]["label"] = "//toolchains:evil"
        receipt.write_text(
            json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        with self.assertRaisesRegex(graph.GraphError, "is stale"):
            graph.check_receipt(self.repo)

    def test_rejects_missing_canonical_sqlx_migration(self) -> None:
        (self.repo / graph.SQLX_MIGRATIONS_PATH / "0026_create_organizations.sql").unlink()
        with self.assertRaisesRegex(graph.GraphError, "exactly contiguous"):
            graph.build_receipt(self.repo)

    def test_rejects_duplicate_canonical_sqlx_migration_version(self) -> None:
        source = self.repo / graph.SQLX_MIGRATIONS_PATH / "0002_create_users.sql"
        source.rename(
            self.repo / graph.SQLX_MIGRATIONS_PATH / "0001_create_users.sql"
        )
        with self.assertRaisesRegex(graph.GraphError, "exactly contiguous"):
            graph.build_receipt(self.repo)

    def test_rejects_reordered_canonical_sqlx_migration_identities(self) -> None:
        first = self.repo / graph.SQLX_MIGRATIONS_PATH / "0002_create_users.sql"
        second = self.repo / graph.SQLX_MIGRATIONS_PATH / "0003_create_audit_events.sql"
        temporary = first.with_suffix(".swap")
        first.rename(temporary)
        second.rename(first)
        temporary.rename(second)
        with self.assertRaisesRegex(graph.GraphError, "is stale"):
            graph.check_receipt(self.repo)

    def test_rejects_canonical_sqlx_migration_content_tamper(self) -> None:
        migration = (
            self.repo
            / graph.SQLX_MIGRATIONS_PATH
            / "0042_create_site_attendance.sql"
        )
        migration.write_bytes(migration.read_bytes() + b"\n-- hostile tamper\n")
        with self.assertRaisesRegex(graph.GraphError, "is stale"):
            graph.check_receipt(self.repo)

    def test_rejects_canonical_sqlx_migration_symlink(self) -> None:
        migration = (
            self.repo
            / graph.SQLX_MIGRATIONS_PATH
            / "0042_create_site_attendance.sql"
        )
        migration.unlink()
        migration.symlink_to(
            LIVE_REPO
            / graph.SQLX_MIGRATIONS_PATH
            / "0042_create_site_attendance.sql"
        )
        with self.assertRaisesRegex(graph.GraphError, "regular non-symlink"):
            graph.build_receipt(self.repo)

    def test_rejects_double_nested_canonical_sqlx_migration_mapping(self) -> None:
        self._replace_once(
            graph.SQLX_MIGRATION_HELPER_PATH,
            '"backend/crates/platform/db"',
            '"backend/crates/platform/db/migrations"',
        )
        with self.assertRaisesRegex(graph.GraphError, "double nesting|not exact"):
            graph.build_receipt(self.repo)

    def test_rejects_canonical_sqlx_helper_duplicate_guard_removal(self) -> None:
        self._replace_once(
            graph.SQLX_MIGRATION_HELPER_PATH,
            "    if _CANONICAL_SQLX_MIGRATION_TARGET in result:\n"
            '        fail("canonical SQLx migrations must be added only by this helper")\n',
            "",
        )
        with self.assertRaisesRegex(graph.GraphError, "path transform is not exact"):
            graph.build_receipt(self.repo)

    def test_rejects_platform_db_contract_source_overlap_with_migrations(self) -> None:
        self._replace_once(
            graph.SQLX_MIGRATION_PLATFORM_DB_BUCK_PATH,
            '"backend/buck2_contract_tests/platform_db/period_lock_domain.rs"',
            '"backend/crates/platform/db/buck2_contract_tests/period_lock_domain.rs"',
        )
        with self.assertRaisesRegex(graph.GraphError, "must remain disjoint"):
            graph.build_receipt(self.repo)

    def test_rejects_bare_sqlx_migration_sentinel_literal(self) -> None:
        self._replace_once(
            graph.SQLX_MIGRATION_SENTINEL_SOURCE_PATH,
            'sqlx::migrate!("./migrations")',
            'sqlx::migrate!("migrations")',
        )
        with self.assertRaisesRegex(graph.GraphError, "exact manifest-relative"):
            graph.build_receipt(self.repo)

    def test_rejects_stale_generated_canonical_sqlx_identity_source(self) -> None:
        identity = self.repo / graph.SQLX_MIGRATION_IDENTITY_SOURCE_PATH
        identity.write_bytes(identity.read_bytes() + b"// hostile tamper\n")
        with self.assertRaisesRegex(graph.GraphError, "is stale"):
            graph.check_receipt(self.repo)


if __name__ == "__main__":
    unittest.main()
