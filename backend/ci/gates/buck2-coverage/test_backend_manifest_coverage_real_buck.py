import unittest
from pathlib import Path
from unittest import mock

from tools.buck import backend_manifest_coverage as coverage


class BackendManifestCoverageRealBuckTest(unittest.TestCase):
    def test_semantic_proof_rejects_similarly_named_custom_kind(self) -> None:
        repo = Path(coverage.__file__).resolve().parents[2]
        self.assertTrue((repo / ".buckroot").is_file(), repo)
        label = "//backend/ci/gates/buck2-coverage:rust-library-spoof-fixture"

        with mock.patch.object(coverage, "RUST_KIND_PATTERN", "rust_library"):
            self.assertEqual((label,), coverage._buck2_rust_targets(repo, label))
        self.assertEqual((), coverage._buck2_rust_targets(repo, label))


if __name__ == "__main__":
    unittest.main()
