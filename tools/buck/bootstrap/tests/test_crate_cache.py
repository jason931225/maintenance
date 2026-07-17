from __future__ import annotations

import concurrent.futures
import hashlib
import io
import os
from pathlib import Path
import socket
import tempfile
import unittest
import urllib.parse
import urllib.request
from unittest import mock

from tools.buck.bootstrap import crate_cache


class AuthenticatedCrateCacheTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        # macOS exposes /var as a symlink to /private/var.  Fixtures use the
        # canonical temp root so the tests do not accidentally opt into an
        # original-path ancestor symlink that the production contract rejects.
        self.root = Path(self.temporary.name).resolve(strict=True)
        self.lock = self.root / "Cargo.lock"
        self.cache = self.root / "cache"
        self.source = self.root / "source"
        self.source.mkdir()
        self.payload = b"exact locked crate bytes"
        self.checksum = hashlib.sha256(self.payload).hexdigest()
        (self.source / "fixture-1.2.3.crate").write_bytes(self.payload)
        self._write_lock()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _write_lock(
        self,
        *,
        source: str = crate_cache.REGISTRY_SOURCE,
        checksum: str | None = None,
    ) -> None:
        checksum = checksum or self.checksum
        self.lock.write_text(
            "\n".join(
                [
                    "version = 4",
                    "",
                    "[[package]]",
                    'name = "fixture"',
                    'version = "1.2.3"',
                    f'source = "{source}"',
                    f'checksum = "{checksum}"',
                    "",
                    "[[package]]",
                    'name = "local"',
                    'version = "0.1.0"',
                    "",
                ]
            ),
            encoding="utf-8",
        )

    def _raw_http(self, base_url: str, request: bytes) -> bytes:
        parsed = urllib.parse.urlsplit(base_url)
        assert parsed.hostname is not None
        assert parsed.port is not None
        with socket.create_connection((parsed.hostname, parsed.port), timeout=2) as client:
            client.settimeout(2)
            client.sendall(request)
            client.shutdown(socket.SHUT_WR)
            response = bytearray()
            while True:
                chunk = client.recv(65536)
                if not chunk:
                    break
                response.extend(chunk)
        return bytes(response)

    @staticmethod
    def _request(line: bytes, *, line_ending: bytes = b"\r\n") -> bytes:
        return (
            line
            + line_ending
            + b"Host: 127.0.0.1\r\nConnection: close\r\n\r\n"
        )

    def test_populate_verify_and_loopback_serve_exact_archive(self) -> None:
        result = crate_cache.populate(
            self.lock,
            self.cache,
            source_dir=self.source,
            allow_network=False,
        )
        self.assertEqual(1, result["package_count"])
        self.assertTrue(result["verified"])

        with crate_cache.verified_cache(self.lock, self.cache) as artifacts:
            self.assertEqual(1, len(artifacts))
            with crate_cache.local_mirror(artifacts) as mirror:
                self.assertTrue(mirror.base_url.startswith("http://127.0.0.1:"))
                with urllib.request.urlopen(
                    mirror.base_url + artifacts[0].locked.route, timeout=2
                ) as response:
                    self.assertEqual(self.payload, response.read())
            self.assertEqual(
                {
                    "complete": True,
                    "expected_route_count": 1,
                    "get_request_count": 1,
                    "get_routes": ["/crates/fixture/1.2.3/download"],
                    "missing_routes": [],
                    "unique_get_route_count": 1,
                    "unexpected_get_routes": [],
                },
                mirror.evidence(),
            )

    def test_mirror_serves_only_one_exact_origin_form_target_per_locked_route(self) -> None:
        locked = crate_cache.LockedCrate(
            "fixture",
            "1.2.3+metadata",
            crate_cache.REGISTRY_SOURCE,
            self.checksum,
        )
        archive = self.source / "fixture-1.2.3.crate"
        descriptor = os.open(archive, os.O_RDONLY)
        self.addCleanup(os.close, descriptor)
        artifact = crate_cache.VerifiedCrate(
            locked=locked,
            path=archive,
            fd=descriptor,
            size=len(self.payload),
        )

        canonical = locked.route
        self.assertEqual(
            "/crates/fixture/1.2.3%2Bmetadata/download",
            canonical,
        )
        with crate_cache.local_mirror((artifact,)) as mirror:
            canonical_head = self._raw_http(
                mirror.base_url,
                self._request(f"HEAD {canonical} HTTP/1.1".encode()),
            )
            self.assertTrue(canonical_head.startswith(b"HTTP/1.0 200"))
            self.assertNotIn(self.payload, canonical_head)

            canonical_get = self._raw_http(
                mirror.base_url,
                self._request(f"GET {canonical} HTTP/1.1".encode()),
            )
            self.assertTrue(canonical_get.startswith(b"HTTP/1.0 200"))
            self.assertIn(self.payload, canonical_get)

            canonical_bytes = canonical.encode()
            raw_plus = canonical.replace("%2B", "+").encode()
            lower_escape = canonical.replace("%2B", "%2b").encode()
            double_escape = canonical.replace("%2B", "%252B").encode()
            hostile_targets = {
                "double-leading-slash": b"/" + canonical_bytes,
                "triple-leading-slash": b"//" + canonical_bytes,
                "absolute-form": (mirror.base_url + canonical).encode(),
                "backslash-origin-form": (
                    b"/crates\\fixture/1.2.3%2Bmetadata/download"
                ),
                "encoded-leading-slash-upper": (
                    b"/%2Fcrates/fixture/1.2.3%2Bmetadata/download"
                ),
                "encoded-leading-slash-lower": (
                    b"/%2fcrates/fixture/1.2.3%2Bmetadata/download"
                ),
                "raw-plus": raw_plus,
                "lowercase-plus-escape": lower_escape,
                "double-encoded-plus": double_escape,
                "query": canonical_bytes + b"?redirect=evil",
                "raw-fragment": canonical_bytes + b"#fragment",
                "traversal": (
                    b"/crates/fixture/../1.2.3%2Bmetadata/download"
                ),
                "encoded-traversal-upper": (
                    b"/crates/fixture/%2E%2E/1.2.3%2Bmetadata/download"
                ),
                "double-encoded-traversal": (
                    b"/crates/fixture/%252E%252E/1.2.3%2Bmetadata/download"
                ),
                "bare-percent": b"/crates/fixture/1.2.3%/download",
                "non-hex-percent": b"/crates/fixture/1.2.3%GG/download",
                "overlong-slash": b"/crates/fixture/1.2.3%C0%AF/download",
                "double-encoded-slash": (
                    b"/crates/fixture/1.2.3%252Fmetadata/download"
                ),
                "invalid-utf8": b"/crates/fixture/1.2.3\xff/download",
                "encoded-invalid-utf8": b"/crates/fixture/1.2.3%FF/download",
            }
            for method in (b"GET", b"HEAD"):
                for name, target in hostile_targets.items():
                    with self.subTest(method=method.decode(), target=name):
                        response = self._raw_http(
                            mirror.base_url,
                            self._request(method + b" " + target + b" HTTP/1.1"),
                        )
                        self.assertFalse(
                            response.startswith(b"HTTP/1.0 200"), response[:80]
                        )
                        self.assertNotIn(self.payload, response)

            malformed_lines = {
                "http-0.9": lambda method: method + b" " + canonical_bytes,
                "multiple-space-after-method": lambda method: (
                    method + b"  " + canonical_bytes + b" HTTP/1.1"
                ),
                "multiple-space-before-version": lambda method: (
                    method + b" " + canonical_bytes + b"  HTTP/1.1"
                ),
                "tab-separators": lambda method: (
                    method + b"\t" + canonical_bytes + b"\tHTTP/1.1"
                ),
            }
            for method in (b"GET", b"HEAD"):
                for name, line_factory in malformed_lines.items():
                    with self.subTest(method=method.decode(), request_line=name):
                        line = line_factory(method)
                        request = (
                            line + b"\r\n\r\n"
                            if name == "http-0.9"
                            else self._request(line)
                        )
                        response = self._raw_http(mirror.base_url, request)
                        self.assertFalse(
                            response.startswith(b"HTTP/1.0 200"), response[:80]
                        )
                        self.assertNotIn(self.payload, response)
                with self.subTest(method=method.decode(), request_line="bare-lf"):
                    response = self._raw_http(
                        mirror.base_url,
                        self._request(
                            method + b" " + canonical_bytes + b" HTTP/1.1",
                            line_ending=b"\n",
                        ),
                    )
                    self.assertFalse(
                        response.startswith(b"HTTP/1.0 200"), response[:80]
                    )
                    self.assertNotIn(self.payload, response)

        self.assertEqual(
            {
                "complete": True,
                "expected_route_count": 1,
                "get_request_count": 1,
                "get_routes": [canonical],
                "missing_routes": [],
                "unique_get_route_count": 1,
                "unexpected_get_routes": [],
            },
            mirror.evidence(),
        )

    def test_mirror_concurrently_serves_all_current_lock_sized_routes(self) -> None:
        route_count = 583
        archive = self.source / "fixture-1.2.3.crate"
        descriptor = os.open(archive, os.O_RDONLY)
        self.addCleanup(os.close, descriptor)
        artifacts = tuple(
            crate_cache.VerifiedCrate(
                locked=crate_cache.LockedCrate(
                    f"fixture-{index:04d}",
                    f"1.2.3+metadata.{index:04d}",
                    crate_cache.REGISTRY_SOURCE,
                    self.checksum,
                ),
                path=archive,
                fd=descriptor,
                size=len(self.payload),
            )
            for index in range(route_count)
        )

        def fetch_pair(base_url: str, route: str) -> str:
            head = self._raw_http(
                base_url,
                self._request(f"HEAD {route} HTTP/1.1".encode()),
            )
            if not head.startswith(b"HTTP/1.0 200") or self.payload in head:
                raise AssertionError(f"HEAD failed for {route}: {head[:80]!r}")
            get = self._raw_http(
                base_url,
                self._request(f"GET {route} HTTP/1.1".encode()),
            )
            if not get.startswith(b"HTTP/1.0 200") or self.payload not in get:
                raise AssertionError(f"GET failed for {route}: {get[:80]!r}")
            return route

        with crate_cache.local_mirror(artifacts) as mirror:
            with concurrent.futures.ThreadPoolExecutor(max_workers=128) as pool:
                served = tuple(
                    pool.map(
                        lambda artifact: fetch_pair(
                            mirror.base_url, artifact.locked.route
                        ),
                        artifacts,
                    )
                )

        expected_routes = sorted(artifact.locked.route for artifact in artifacts)
        self.assertCountEqual(expected_routes, served)
        self.assertEqual(
            {
                "complete": True,
                "expected_route_count": route_count,
                "get_request_count": route_count,
                "get_routes": expected_routes,
                "missing_routes": [],
                "unique_get_route_count": route_count,
                "unexpected_get_routes": [],
            },
            mirror.evidence(),
        )

    def test_archive_url_rejects_userinfo_port_query_and_route_drift(self) -> None:
        crate = crate_cache.LockedCrate(
            "fixture", "1.2.3", crate_cache.REGISTRY_SOURCE, self.checksum
        )
        crate_cache._validate_archive_url(crate, crate.upstream_url)
        hostile = (
            "https://static.crates.io@evil.example/crates/fixture/1.2.3/download",
            "https://user@static.crates.io/crates/fixture/1.2.3/download",
            "https://static.crates.io:443/crates/fixture/1.2.3/download",
            "https://static.crates.io/crates/fixture/1.2.3/download?redirect=evil",
            "https://static.crates.io/crates/other/1.2.3/download",
        )
        for url in hostile:
            with self.subTest(url=url):
                with self.assertRaisesRegex(
                    crate_cache.CrateCacheError, "unapproved crate archive URL"
                ):
                    crate_cache._validate_archive_url(crate, url)

    def test_download_stream_rejects_declared_and_actual_oversize(self) -> None:
        class Response(io.BytesIO):
            def __init__(self, payload: bytes, content_length: str | None) -> None:
                super().__init__(payload)
                self.headers = {}
                if content_length is not None:
                    self.headers["Content-Length"] = content_length

        with self.assertRaisesRegex(crate_cache.CrateCacheError, "declared size"):
            crate_cache._read_bounded(
                Response(b"small", str(crate_cache.MAX_ARCHIVE_BYTES + 1))
            )
        with self.assertRaisesRegex(crate_cache.CrateCacheError, "stream exceeds"):
            crate_cache._read_bounded(
                Response(b"x" * 17, None), maximum_bytes=16, chunk_bytes=4
            )

    def test_redirect_handler_rejects_external_origin(self) -> None:
        crate = crate_cache.LockedCrate(
            "fixture", "1.2.3", crate_cache.REGISTRY_SOURCE, self.checksum
        )
        handler = crate_cache._ExactArchiveRedirectHandler(crate)
        with self.assertRaisesRegex(
            crate_cache.CrateCacheError, "unapproved crate archive URL"
        ):
            handler.redirect_request(
                urllib.request.Request(crate.upstream_url),
                None,
                302,
                "Found",
                {},
                "https://evil.example/archive.crate",
            )

    def test_population_rejects_missing_archive_without_network_gate(self) -> None:
        (self.source / "fixture-1.2.3.crate").unlink()

        with self.assertRaisesRegex(
            crate_cache.CrateCacheError, "network fallback was not explicitly authorized"
        ):
            crate_cache.populate(
                self.lock,
                self.cache,
                source_dir=self.source,
                allow_network=False,
            )

    def test_population_rejects_source_archive_checksum_drift(self) -> None:
        (self.source / "fixture-1.2.3.crate").write_bytes(b"tampered")

        with self.assertRaisesRegex(crate_cache.CrateCacheError, "checksum mismatch"):
            crate_cache.populate(
                self.lock,
                self.cache,
                source_dir=self.source,
                allow_network=False,
            )

    def test_lock_rejects_unapproved_registry_source(self) -> None:
        self._write_lock(source="git+https://example.invalid/repository")

        with self.assertRaisesRegex(crate_cache.CrateCacheError, "unapproved Cargo.lock source"):
            crate_cache.load_locked_crates(self.lock)

    def test_lock_read_rejects_original_path_ancestor_symlink(self) -> None:
        alias = self.root / "linked-root"
        alias.symlink_to(self.root, target_is_directory=True)

        with self.assertRaisesRegex(
            crate_cache.CrateCacheError, "ancestor|real directory"
        ):
            crate_cache.load_locked_crates(alias / "Cargo.lock")

    def test_lock_read_rejects_oversized_regular_file(self) -> None:
        self.lock.write_bytes(b"x" * (crate_cache.MAX_LOCK_BYTES + 1))

        with self.assertRaisesRegex(crate_cache.CrateCacheError, "exceeds.*byte limit"):
            crate_cache.load_locked_crates(self.lock)

    def test_lock_leaf_swap_to_symlink_is_rejected_before_read(self) -> None:
        replacement = self.root / "replacement.lock"
        replacement.write_bytes(self.lock.read_bytes())
        real_stat = os.stat
        swapped = False

        def swap_after_metadata(
            path: os.PathLike[str] | str,
            *args: object,
            **kwargs: object,
        ) -> os.stat_result:
            nonlocal swapped
            metadata = real_stat(path, *args, **kwargs)
            if path == self.lock.name and kwargs.get("dir_fd") is not None and not swapped:
                self.lock.unlink()
                self.lock.symlink_to(replacement)
                swapped = True
            return metadata

        with mock.patch.object(crate_cache.os, "stat", side_effect=swap_after_metadata):
            with self.assertRaisesRegex(
                crate_cache.CrateCacheError, "regular non-symlink|changed while opening"
            ):
                crate_cache.load_locked_crates(self.lock)
        self.assertTrue(swapped)

    def test_cache_directory_rejects_original_path_ancestor_symlink(self) -> None:
        real_cache_parent = self.root / "real-cache-parent"
        real_cache_parent.mkdir()
        linked_cache_parent = self.root / "linked-cache-parent"
        linked_cache_parent.symlink_to(real_cache_parent, target_is_directory=True)

        with self.assertRaisesRegex(
            crate_cache.CrateCacheError, "ancestor|real directory"
        ):
            crate_cache.populate(
                self.lock,
                linked_cache_parent / "cache",
                source_dir=self.source,
                allow_network=False,
            )

    def test_cache_rejects_lock_checksum_drift(self) -> None:
        crate_cache.populate(
            self.lock,
            self.cache,
            source_dir=self.source,
            allow_network=False,
        )
        self._write_lock(checksum="0" * 64)

        with self.assertRaisesRegex(
            crate_cache.CrateCacheError, "index does not exactly match Cargo.lock"
        ):
            with crate_cache.verified_cache(self.lock, self.cache):
                pass

    def test_cache_rejects_archive_tamper_and_extra_files(self) -> None:
        crate_cache.populate(
            self.lock,
            self.cache,
            source_dir=self.source,
            allow_network=False,
        )
        archive = self.cache / f"{self.checksum}.crate"
        archive.chmod(0o644)
        archive.write_bytes(b"tampered")
        with self.assertRaisesRegex(
            crate_cache.CrateCacheError, "read-only|checksum mismatch"
        ):
            with crate_cache.verified_cache(self.lock, self.cache):
                pass

        archive.write_bytes(self.payload)
        (self.cache / "unexpected").write_text("x", encoding="utf-8")
        with self.assertRaisesRegex(crate_cache.CrateCacheError, "file set mismatch"):
            with crate_cache.verified_cache(self.lock, self.cache):
                pass

    def test_cache_rejects_oversized_index_before_unbounded_read(self) -> None:
        crate_cache.populate(
            self.lock,
            self.cache,
            source_dir=self.source,
            allow_network=False,
        )
        index = self.cache / crate_cache.INDEX_NAME
        index.chmod(0o644)
        index.write_bytes(index.read_bytes() + b"x")

        with self.assertRaisesRegex(crate_cache.CrateCacheError, "exceeds.*byte limit"):
            with crate_cache.verified_cache(self.lock, self.cache):
                pass

    def test_atomic_write_durably_orders_read_only_mode_before_publish(self) -> None:
        target_dir = self.root / "atomic"
        target_dir.mkdir()
        with crate_cache._secure_directory(
            target_dir, "atomic fixture", create=False
        ) as (_, directory_fd):
            events: list[str] = []
            real_fchmod = os.fchmod
            real_fsync = os.fsync
            real_replace = os.replace

            def record_fchmod(descriptor: int, mode: int) -> None:
                events.append("fchmod")
                real_fchmod(descriptor, mode)

            def record_fsync(descriptor: int) -> None:
                events.append("fsync-dir" if descriptor == directory_fd else "fsync-file")
                real_fsync(descriptor)

            def record_replace(*args: object, **kwargs: object) -> None:
                events.append("replace")
                real_replace(*args, **kwargs)

            with (
                mock.patch.object(crate_cache.os, "fchmod", side_effect=record_fchmod),
                mock.patch.object(crate_cache.os, "fsync", side_effect=record_fsync),
                mock.patch.object(crate_cache.os, "replace", side_effect=record_replace),
            ):
                crate_cache._write_atomic_at(directory_fd, "fixture", b"payload")

        self.assertEqual(events, ["fchmod", "fsync-file", "replace", "fsync-dir"])
        self.assertEqual((target_dir / "fixture").stat().st_mode & 0o777, 0o444)

    def test_verified_descriptors_survive_cache_directory_name_replacement(self) -> None:
        crate_cache.populate(
            self.lock,
            self.cache,
            source_dir=self.source,
            allow_network=False,
        )

        with crate_cache.verified_cache(self.lock, self.cache) as artifacts:
            moved = self.root / "verified-cache-moved"
            self.cache.rename(moved)
            self.cache.mkdir()
            (self.cache / f"{self.checksum}.crate").write_bytes(b"attacker bytes")
            with crate_cache.local_mirror(artifacts) as mirror:
                with urllib.request.urlopen(
                    mirror.base_url + artifacts[0].locked.route, timeout=2
                ) as response:
                    self.assertEqual(self.payload, response.read())


if __name__ == "__main__":
    unittest.main()
