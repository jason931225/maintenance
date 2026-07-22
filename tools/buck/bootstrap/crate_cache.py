#!/usr/bin/env python3
"""Authenticated, lock-exact offline cache for crates.io archives.

The cache is populated only by an explicit command. Every archive is bound to
the exact source and SHA-256 recorded in ``backend/Cargo.lock``. Normal Buck2
runs open and re-verify the complete cache, then serve those already-opened
files through a loopback-only mirror; they never fall back to crates.io.
"""

from __future__ import annotations

import contextlib
from dataclasses import dataclass, field
import hashlib
import http.server
import json
import os
from pathlib import Path
import re
import secrets
import stat
import threading
import tomllib
import urllib.parse
import urllib.request
from typing import Any, BinaryIO, Iterator, Mapping


REGISTRY_SOURCE = "registry+https://github.com/rust-lang/crates.io-index"
ARCHIVE_ORIGIN = "https://static.crates.io"
MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
MAX_LOCK_BYTES = 8 * 1024 * 1024
DOWNLOAD_CHUNK_BYTES = 1024 * 1024
CACHE_SCHEMA_VERSION = 1
INDEX_NAME = "index.json"
HEX_64 = re.compile(r"^[0-9a-f]{64}$")
SAFE_IDENTITY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+~-]*$")
_DIRECTORY_FLAGS = (
    os.O_RDONLY
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_DIRECTORY", 0)
    | getattr(os, "O_NOFOLLOW", 0)
)
_READ_FLAGS = (
    os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
)


class CrateCacheError(RuntimeError):
    """The lock or offline archive cache is incomplete, ambiguous, or unsafe."""


@dataclass(frozen=True)
class LockedCrate:
    name: str
    version: str
    source: str
    checksum: str

    @property
    def filename(self) -> str:
        return f"{self.checksum}.crate"

    @property
    def route(self) -> str:
        name = urllib.parse.quote(self.name, safe="")
        version = urllib.parse.quote(self.version, safe="")
        return f"/crates/{name}/{version}/download"

    @property
    def upstream_url(self) -> str:
        return f"{ARCHIVE_ORIGIN}{self.route}"


@dataclass(frozen=True)
class VerifiedCrate:
    locked: LockedCrate
    path: Path
    fd: int
    size: int

    def read(self, offset: int, amount: int) -> bytes:
        return os.pread(self.fd, amount, offset)


def _reject_duplicate_json_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise CrateCacheError(f"duplicate JSON key in crate cache index: {key}")
        result[key] = value
    return result


def _normalized_absolute(path: Path) -> Path:
    return Path(os.path.abspath(os.fspath(path)))


@contextlib.contextmanager
def _secure_directory(
    path: Path, purpose: str, *, create: bool
) -> Iterator[tuple[Path, int]]:
    """Open every original path component without following symlinks.

    Resolving first would erase evidence that an original-path ancestor was a
    symlink.  Walking from the filesystem anchor with dirfd + O_NOFOLLOW keeps
    the returned descriptor bound to the verified directory even if names are
    concurrently replaced after the walk.
    """

    absolute = _normalized_absolute(path)
    parts = absolute.parts
    if not absolute.is_absolute() or not parts:
        raise CrateCacheError(f"{purpose} path must be absolute: {path}")
    descriptor = os.open(parts[0], _DIRECTORY_FLAGS)
    try:
        current = Path(parts[0])
        for index, component in enumerate(parts[1:], start=1):
            if component in ("", ".", ".."):
                raise CrateCacheError(f"unsafe {purpose} path component: {component!r}")
            current /= component
            try:
                child = os.open(component, _DIRECTORY_FLAGS, dir_fd=descriptor)
            except FileNotFoundError as error:
                if not create:
                    raise CrateCacheError(
                        f"missing {purpose} directory: {current}"
                    ) from error
                try:
                    os.mkdir(component, mode=0o700, dir_fd=descriptor)
                    os.fsync(descriptor)
                except FileExistsError:
                    pass
                try:
                    child = os.open(component, _DIRECTORY_FLAGS, dir_fd=descriptor)
                except OSError as open_error:
                    raise CrateCacheError(
                        f"{purpose} ancestor is not a real directory: {current}"
                    ) from open_error
            except OSError as error:
                location = (
                    purpose
                    if index == len(parts) - 1
                    else f"{purpose} ancestor"
                )
                raise CrateCacheError(
                    f"{location} is not a real directory: {current}"
                ) from error
            os.close(descriptor)
            descriptor = child
        metadata = os.fstat(descriptor)
        if not stat.S_ISDIR(metadata.st_mode):
            raise CrateCacheError(f"{purpose} must be a real directory: {absolute}")
        yield absolute, descriptor
    finally:
        os.close(descriptor)


def _safe_leaf(name: str, purpose: str) -> str:
    if not name or name in (".", "..") or Path(name).name != name:
        raise CrateCacheError(f"unsafe {purpose} filename: {name!r}")
    return name


def _open_regular_at(
    directory_fd: int, name: str, purpose: str, display_path: Path
) -> tuple[int, os.stat_result]:
    name = _safe_leaf(name, purpose)
    try:
        before = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    except FileNotFoundError as error:
        raise CrateCacheError(f"missing {purpose}: {display_path}") from error
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        raise CrateCacheError(
            f"{purpose} must be a regular non-symlink: {display_path}"
        )
    try:
        descriptor = os.open(name, _READ_FLAGS, dir_fd=directory_fd)
    except OSError as error:
        raise CrateCacheError(
            f"{purpose} must be a regular non-symlink: {display_path}"
        ) from error
    opened = os.fstat(descriptor)
    if (
        not stat.S_ISREG(opened.st_mode)
        or (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino)
    ):
        os.close(descriptor)
        raise CrateCacheError(f"{purpose} changed while opening: {display_path}")
    return descriptor, opened


def _read_all(descriptor: int, maximum_bytes: int, purpose: str) -> bytes:
    if maximum_bytes <= 0:
        raise CrateCacheError(f"{purpose} byte limit must be positive")
    chunks: list[bytes] = []
    size = 0
    while chunk := os.read(
        descriptor, min(1024 * 1024, maximum_bytes - size + 1)
    ):
        chunks.append(chunk)
        size += len(chunk)
        if size > maximum_bytes:
            raise CrateCacheError(
                f"{purpose} exceeds {maximum_bytes} byte limit"
            )
    return b"".join(chunks)


def _unchanged(
    before: os.stat_result, after: os.stat_result
) -> bool:
    return (
        before.st_dev,
        before.st_ino,
        before.st_size,
        before.st_mtime_ns,
        before.st_ctime_ns,
    ) == (
        after.st_dev,
        after.st_ino,
        after.st_size,
        after.st_mtime_ns,
        after.st_ctime_ns,
    )


def _read_regular_at(
    directory_fd: int,
    name: str,
    purpose: str,
    display_path: Path,
    *,
    maximum_bytes: int,
) -> bytes:
    descriptor, before = _open_regular_at(directory_fd, name, purpose, display_path)
    try:
        raw = _read_all(descriptor, maximum_bytes, purpose)
        after = os.fstat(descriptor)
        if not _unchanged(before, after):
            raise CrateCacheError(f"{purpose} changed while reading: {display_path}")
        return raw
    finally:
        os.close(descriptor)


def _read_regular(path: Path, purpose: str, *, maximum_bytes: int) -> bytes:
    absolute = _normalized_absolute(path)
    with _secure_directory(absolute.parent, f"{purpose} parent", create=False) as (
        parent,
        parent_fd,
    ):
        return _read_regular_at(
            parent_fd,
            absolute.name,
            purpose,
            parent / absolute.name,
            maximum_bytes=maximum_bytes,
        )


def load_locked_crates(lock_path: Path) -> tuple[bytes, tuple[LockedCrate, ...]]:
    raw = _read_regular(lock_path, "Cargo lock", maximum_bytes=MAX_LOCK_BYTES)
    try:
        document = tomllib.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, tomllib.TOMLDecodeError) as error:
        raise CrateCacheError(f"invalid Cargo lock: {error}") from error
    if document.get("version") != 4:
        raise CrateCacheError("backend/Cargo.lock must use lock format version 4")

    crates: list[LockedCrate] = []
    seen: set[tuple[str, str, str]] = set()
    for value in document.get("package", []):
        if not isinstance(value, dict):
            raise CrateCacheError("Cargo.lock package entries must be tables")
        source = value.get("source")
        if source is None:
            continue
        name = value.get("name")
        version = value.get("version")
        checksum = value.get("checksum")
        if source != REGISTRY_SOURCE:
            raise CrateCacheError(
                f"unapproved Cargo.lock source for {name} {version}: {source!r}"
            )
        if not isinstance(name, str) or SAFE_IDENTITY.fullmatch(name) is None:
            raise CrateCacheError(f"unsafe registry crate name: {name!r}")
        if not isinstance(version, str) or SAFE_IDENTITY.fullmatch(version) is None:
            raise CrateCacheError(f"unsafe registry crate version for {name}: {version!r}")
        if not isinstance(checksum, str) or HEX_64.fullmatch(checksum) is None:
            raise CrateCacheError(f"registry crate {name} {version} lacks exact SHA-256")
        identity = (name, version, source)
        if identity in seen:
            raise CrateCacheError(f"duplicate locked registry identity: {identity}")
        seen.add(identity)
        crates.append(LockedCrate(name, version, source, checksum))
    if not crates:
        raise CrateCacheError("Cargo.lock contains no crates.io packages")
    return raw, tuple(sorted(crates, key=lambda crate: (crate.name, crate.version)))


def _index(lock_raw: bytes, crates: tuple[LockedCrate, ...]) -> dict[str, Any]:
    return {
        "artifact_kind": "AUTHENTICATED_CARGO_LOCK_CRATE_ARCHIVE_CACHE",
        "schema_version": CACHE_SCHEMA_VERSION,
        "lockfile": "backend/Cargo.lock",
        "lock_sha256": hashlib.sha256(lock_raw).hexdigest(),
        "registry_source": REGISTRY_SOURCE,
        "archive_origin": ARCHIVE_ORIGIN,
        "package_count": len(crates),
        "packages": [
            {
                "checksum": crate.checksum,
                "filename": crate.filename,
                "name": crate.name,
                "source": crate.source,
                "upstream_url": crate.upstream_url,
                "version": crate.version,
            }
            for crate in crates
        ],
    }


def render_index(lock_raw: bytes, crates: tuple[LockedCrate, ...]) -> bytes:
    return (json.dumps(_index(lock_raw, crates), indent=2, sort_keys=True) + "\n").encode()


def _sha256_regular_at(
    directory_fd: int, name: str, purpose: str, display_path: Path
) -> str:
    digest = hashlib.sha256()
    descriptor, before = _open_regular_at(directory_fd, name, purpose, display_path)
    try:
        while chunk := os.read(descriptor, 1024 * 1024):
            digest.update(chunk)
        after = os.fstat(descriptor)
        if not _unchanged(before, after):
            raise CrateCacheError(f"{purpose} changed while hashing: {display_path}")
        return digest.hexdigest()
    finally:
        os.close(descriptor)


def _write_atomic_at(directory_fd: int, name: str, payload: bytes) -> None:
    name = _safe_leaf(name, "crate cache write")
    temporary = f".{name}.{secrets.token_hex(16)}.tmp"
    flags = (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    descriptor = os.open(temporary, flags, 0o600, dir_fd=directory_fd)
    try:
        view = memoryview(payload)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise CrateCacheError(f"short crate cache write: {name}")
            view = view[written:]
        os.fchmod(descriptor, 0o444)
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = -1
        os.replace(
            temporary,
            name,
            src_dir_fd=directory_fd,
            dst_dir_fd=directory_fd,
        )
        os.fsync(directory_fd)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            os.unlink(temporary, dir_fd=directory_fd)
        except FileNotFoundError:
            pass


def _validate_archive_url(crate: LockedCrate, url: str) -> None:
    """Require the one normalized URL derived from the locked identity."""
    try:
        parsed = urllib.parse.urlsplit(url)
        port = parsed.port
    except ValueError as error:
        raise CrateCacheError(f"unapproved crate archive URL: {url}") from error
    if (
        url != crate.upstream_url
        or parsed.scheme != "https"
        or parsed.netloc != "static.crates.io"
        or parsed.hostname != "static.crates.io"
        or parsed.username is not None
        or parsed.password is not None
        or port is not None
        or parsed.path != crate.route
        or parsed.query
        or parsed.fragment
    ):
        raise CrateCacheError(f"unapproved crate archive URL: {url}")


class _ExactArchiveRedirectHandler(urllib.request.HTTPRedirectHandler):
    def __init__(self, crate: LockedCrate) -> None:
        super().__init__()
        self.crate = crate

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: BinaryIO,
        code: int,
        msg: str,
        headers: Mapping[str, str],
        newurl: str,
    ) -> urllib.request.Request | None:
        _validate_archive_url(self.crate, newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _read_bounded(
    response: Any,
    *,
    maximum_bytes: int = MAX_ARCHIVE_BYTES,
    chunk_bytes: int = DOWNLOAD_CHUNK_BYTES,
) -> bytes:
    if maximum_bytes <= 0 or chunk_bytes <= 0:
        raise CrateCacheError("crate archive read bounds must be positive")
    declared_raw = response.headers.get("Content-Length")
    declared: int | None = None
    if declared_raw is not None:
        try:
            declared = int(declared_raw, 10)
        except ValueError as error:
            raise CrateCacheError("crate archive has invalid declared size") from error
        if declared < 0 or declared > maximum_bytes:
            raise CrateCacheError(
                f"crate archive declared size exceeds {maximum_bytes} bytes"
            )
    content_encoding = response.headers.get("Content-Encoding")
    if content_encoding not in (None, "identity"):
        raise CrateCacheError("crate archive response must not use content encoding")

    payload = bytearray()
    while True:
        chunk = response.read(min(chunk_bytes, maximum_bytes - len(payload) + 1))
        if not chunk:
            break
        payload.extend(chunk)
        if len(payload) > maximum_bytes:
            raise CrateCacheError(
                f"crate archive stream exceeds {maximum_bytes} bytes"
            )
    if declared is not None and declared != len(payload):
        raise CrateCacheError("crate archive body size does not match Content-Length")
    return bytes(payload)


def _download(crate: LockedCrate) -> bytes:
    _validate_archive_url(crate, crate.upstream_url)
    opener = urllib.request.build_opener(_ExactArchiveRedirectHandler(crate))
    request = urllib.request.Request(
        crate.upstream_url,
        headers={"User-Agent": "maintenance-buck2-authenticated-crate-populator/1"},
    )
    try:
        with opener.open(request, timeout=60) as response:
            _validate_archive_url(crate, response.geturl())
            payload = _read_bounded(response)
    except OSError as error:
        raise CrateCacheError(
            f"failed to download {crate.name} {crate.version}: {error}"
        ) from error
    return payload


def populate(
    lock_path: Path,
    cache_dir: Path,
    *,
    source_dir: Path | None,
    allow_network: bool,
) -> dict[str, Any]:
    lock_raw, crates = load_locked_crates(lock_path)
    with contextlib.ExitStack() as directories:
        cache_dir, cache_fd = directories.enter_context(
            _secure_directory(cache_dir, "crate cache", create=True)
        )
        source_fd: int | None = None
        source_names: set[str] = set()
        if source_dir is not None:
            source_dir, source_fd = directories.enter_context(
                _secure_directory(source_dir, "crate source", create=False)
            )
            source_names = set(os.listdir(source_fd))

        expected_files = {INDEX_NAME, *(crate.filename for crate in crates)}
        actual_names = set(os.listdir(cache_fd))
        unexpected = sorted(actual_names - expected_files)
        if unexpected:
            raise CrateCacheError(f"crate cache contains unexpected files: {unexpected}")

        for crate in crates:
            destination = cache_dir / crate.filename
            if crate.filename in actual_names:
                if (
                    _sha256_regular_at(
                        cache_fd,
                        crate.filename,
                        "cached crate",
                        destination,
                    )
                    != crate.checksum
                ):
                    raise CrateCacheError(
                        f"cached crate checksum mismatch: {crate.name} {crate.version}"
                    )
                continue
            payload: bytes | None = None
            source_name = f"{crate.name}-{crate.version}.crate"
            if source_fd is not None and source_name in source_names:
                assert source_dir is not None
                payload = _read_regular_at(
                    source_fd,
                    source_name,
                    "crate population source",
                    source_dir / source_name,
                    maximum_bytes=MAX_ARCHIVE_BYTES,
                )
            if payload is None:
                if not allow_network:
                    raise CrateCacheError(
                        f"source archive missing for {crate.name} {crate.version}; "
                        "network fallback was not explicitly authorized"
                    )
                payload = _download(crate)
            actual = hashlib.sha256(payload).hexdigest()
            if actual != crate.checksum:
                raise CrateCacheError(
                    f"crate population checksum mismatch for {crate.name} {crate.version}"
                )
            _write_atomic_at(cache_fd, crate.filename, payload)
            actual_names.add(crate.filename)

        _write_atomic_at(cache_fd, INDEX_NAME, render_index(lock_raw, crates))
        with _verified_cache_at(lock_raw, crates, cache_dir, cache_fd) as artifacts:
            return {
                "cache_dir": str(cache_dir),
                "lock_sha256": hashlib.sha256(lock_raw).hexdigest(),
                "package_count": len(artifacts),
                "verified": True,
            }


@contextlib.contextmanager
def _verified_cache_at(
    lock_raw: bytes,
    crates: tuple[LockedCrate, ...],
    cache_dir: Path,
    cache_fd: int,
) -> Iterator[tuple[VerifiedCrate, ...]]:
    with contextlib.ExitStack() as opened:
        expected_index = render_index(lock_raw, crates)
        index_raw = _read_regular_at(
            cache_fd,
            INDEX_NAME,
            "crate cache index",
            cache_dir / INDEX_NAME,
            maximum_bytes=len(expected_index),
        )
        if index_raw != expected_index:
            try:
                json.loads(index_raw, object_pairs_hook=_reject_duplicate_json_keys)
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise CrateCacheError(f"invalid crate cache index: {error}") from error
            raise CrateCacheError("crate cache index does not exactly match Cargo.lock")

        expected_files = {INDEX_NAME, *(crate.filename for crate in crates)}
        actual_files = set(os.listdir(cache_fd))
        if actual_files != expected_files:
            missing = sorted(expected_files - actual_files)
            extra = sorted(actual_files - expected_files)
            raise CrateCacheError(
                f"crate cache file set mismatch; missing={missing}, extra={extra}"
            )

        artifacts: list[VerifiedCrate] = []
        for crate in crates:
            path = cache_dir / crate.filename
            descriptor, before = _open_regular_at(
                cache_fd, crate.filename, "cached crate", path
            )
            opened.callback(os.close, descriptor)
            digest = hashlib.sha256()
            offset = 0
            while True:
                chunk = os.pread(descriptor, 1024 * 1024, offset)
                if not chunk:
                    break
                digest.update(chunk)
                offset += len(chunk)
            after = os.fstat(descriptor)
            if not _unchanged(before, after):
                raise CrateCacheError(f"cached crate changed while reading: {path}")
            if after.st_mode & 0o222:
                raise CrateCacheError(f"cached crate must be read-only: {path}")
            if digest.hexdigest() != crate.checksum:
                raise CrateCacheError(
                    f"cached crate checksum mismatch: {crate.name} {crate.version}"
                )
            artifacts.append(VerifiedCrate(crate, path, descriptor, after.st_size))
        yield tuple(artifacts)


@contextlib.contextmanager
def verified_cache(
    lock_path: Path, cache_dir: Path
) -> Iterator[tuple[VerifiedCrate, ...]]:
    lock_raw, crates = load_locked_crates(lock_path)
    with _secure_directory(cache_dir, "crate cache", create=False) as (
        cache_dir,
        cache_fd,
    ):
        with _verified_cache_at(lock_raw, crates, cache_dir, cache_fd) as artifacts:
            yield artifacts


class _CrateMirrorHandler(http.server.BaseHTTPRequestHandler):
    routes: dict[str, VerifiedCrate]
    session: "MirrorSession"

    def log_message(self, _format: str, *args: object) -> None:
        del args

    def do_HEAD(self) -> None:
        self._serve(include_body=False)

    def do_GET(self) -> None:
        self._serve(include_body=True)

    def _exact_origin_request_target(self) -> str | None:
        """Recover the exact request-target bytes before stdlib normalization.

        ``BaseHTTPRequestHandler`` rewrites request-targets beginning with two
        or more slashes before assigning ``self.path``.  The mirror contract is
        stricter: one canonical origin-form byte string per locked route.  Read
        the original request line, require an unambiguous HTTP/1.x grammar, and
        compare it byte-for-byte with the parsed path.  Percent escapes are not
        decoded or normalized here.
        """

        if self.request_version not in ("HTTP/1.0", "HTTP/1.1"):
            return None
        if not self.raw_requestline.endswith(b"\r\n"):
            return None
        line = self.raw_requestline[:-2]
        try:
            prefix = self.command.encode("ascii") + b" "
            suffix = b" " + self.request_version.encode("ascii")
            parsed_path = self.path.encode("ascii")
        except UnicodeEncodeError:
            return None
        if not line.startswith(prefix) or not line.endswith(suffix):
            return None
        target = line[len(prefix) : len(line) - len(suffix)]
        if (
            not target
            or b" " in target
            or b"\t" in target
            or not target.startswith(b"/")
            or target.startswith(b"//")
            or b"\\" in target
            or b"?" in target
            or b"#" in target
            or target != parsed_path
        ):
            return None
        try:
            return target.decode("ascii")
        except UnicodeDecodeError:
            return None

    def _serve(self, *, include_body: bool) -> None:
        request_target = self._exact_origin_request_target()
        if request_target is None:
            self.send_error(400)
            return
        artifact = self.routes.get(request_target)
        if artifact is None:
            self.send_error(404)
            return
        if include_body:
            self.session.record_get(request_target)
        self.send_response(200)
        self.send_header("Content-Type", "application/x-tar")
        self.send_header("Content-Length", str(artifact.size))
        self.end_headers()
        if not include_body:
            return
        offset = 0
        while offset < artifact.size:
            chunk = artifact.read(offset, min(1024 * 1024, artifact.size - offset))
            if not chunk:
                raise CrateCacheError("verified crate archive changed while serving")
            self.wfile.write(chunk)
            offset += len(chunk)


class _CrateMirrorServer(http.server.ThreadingHTTPServer):
    # Buck2 may materialize every current-lock archive concurrently.  The
    # stdlib default backlog is five, which needlessly turns a loopback-only
    # source into timeout/retry churn.  macOS caps listen(2) at 128, so request
    # the full bounded kernel queue while the accept loop dispatches the short
    # authenticated HEAD/GET requests.
    request_queue_size = 128


@dataclass
class MirrorSession:
    base_url: str
    expected_routes: frozenset[str]
    _get_routes: list[str] = field(default_factory=list, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def record_get(self, route: str) -> None:
        with self._lock:
            self._get_routes.append(route)

    def evidence(self) -> dict[str, Any]:
        with self._lock:
            requests = tuple(self._get_routes)
        unique = set(requests)
        missing = sorted(self.expected_routes - unique)
        unexpected = sorted(unique - self.expected_routes)
        return {
            "complete": not missing and not unexpected,
            "expected_route_count": len(self.expected_routes),
            "get_request_count": len(requests),
            "get_routes": sorted(unique),
            "missing_routes": missing,
            "unique_get_route_count": len(unique),
            "unexpected_get_routes": unexpected,
        }


@contextlib.contextmanager
def local_mirror(artifacts: tuple[VerifiedCrate, ...]) -> Iterator[MirrorSession]:
    routes = {artifact.locked.route: artifact for artifact in artifacts}
    if len(routes) != len(artifacts):
        raise CrateCacheError("duplicate crate mirror routes")
    session = MirrorSession("", frozenset(routes))
    handler = type(
        "BoundCrateMirrorHandler",
        (_CrateMirrorHandler,),
        {"routes": routes, "session": session},
    )
    server = _CrateMirrorServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host, port = server.server_address
        if host != "127.0.0.1":
            raise CrateCacheError("crate mirror did not bind loopback")
        session.base_url = f"http://127.0.0.1:{port}"
        yield session
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
