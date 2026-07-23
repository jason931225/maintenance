#!/usr/bin/env python3
"""Behavior locks for the repository-owned Reindeer bootstrap and closures."""

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class ReindeerBootstrapTests(unittest.TestCase):
    def read(self, relative_path: str) -> str:
        return (ROOT / relative_path).read_text()

    def test_reindeer_bootstrap_is_pinned_and_does_not_fall_back_to_path(self) -> None:
        lock = self.read("third-party/rust/reindeer/upstream.lock")
        bootstrap = self.read("third-party/rust/reindeer/bootstrap.sh")

        self.assertIn("REINDEER_COMMIT=681727ced54a853977ac495e147ac54e1c0db115", lock)
        self.assertIn(
            "REINDEER_ARCHIVE_SHA256=79c09407900ed8d2b70b620af24cb2e2c6b0661d75804326ae1ee77fe908259a",
            lock,
        )
        self.assertIn("REINDEER_TOOLCHAIN=nightly-2026-02-28", lock)
        self.assertIn("--fuzz=0", bootstrap)
        self.assertNotIn("command -v reindeer", bootstrap)

    def test_workspace_dev_closure_is_generated_from_direct_roots(self) -> None:
        config = self.read("third-party/rust/reindeer.toml")
        patch = self.read(
            "third-party/rust/reindeer/patches/0001-workspace-dev-dependency-roots.patch"
        )
        graph = self.read("third-party/rust/BUCK")

        self.assertIn("include_workspace_dev_dependencies = true", config)
        self.assertIn("workspace_dev_dependency_roots", patch)
        self.assertIn("DepKind::Dev", patch)
        self.assertIn("TargetReq::Lib", patch)
        self.assertIn('name = "webauthn-authenticator-rs"', graph)
        self.assertIn('name = "tempfile"', graph)

    def test_openssl_product_closure_is_vendored_and_uses_supported_cfgs(self) -> None:
        auth_manifest = self.read("backend/crates/platform/auth/Cargo.toml")
        openssl_sys = self.read("third-party/rust/fixups/openssl-sys/fixups.toml")
        openssl = self.read("third-party/rust/fixups/openssl/fixups.toml")
        graph = self.read("third-party/rust/BUCK")

        self.assertIn('openssl = { version = "0.10.80", features = ["vendored"] }', auth_manifest)
        self.assertIn("OPENSSL_RUST_USE_NASM = \"0\"", openssl_sys)
        self.assertIn("rustc_link_lib = true", openssl_sys)
        self.assertIn("rustc_link_search = true", openssl_sys)
        self.assertIn('name = "openssl-src-300.6.1+3.6.3.crate"', graph)
        self.assertIn('name = "openssl-src-300"', graph)
        self.assertIn('osslconf="OPENSSL_NO_IDEA"', openssl)
        self.assertIn('osslconf="OPENSSL_NO_SEED"', openssl)
        self.assertNotIn("ossl360", openssl)
        self.assertNotIn("ossl361", openssl)


if __name__ == "__main__":
    unittest.main()
