#!/usr/bin/env python3
"""Fail-closed bootstrap for the repository's pinned Buck2 toolchains.

Normal ``run`` and ``doctor`` operations never download. Network access exists
only behind the explicit ``populate --allow-network`` command, and every byte
is verified against ``tools/buck/toolchain-lock.json`` before use.
"""

from __future__ import annotations

import sys

# The official wrapper selects isolated mode before Python starts. This in-script
# guard rejects non-isolated execution only after interpreter startup, so it
# cannot preempt startup hooks such as `sitecustomize` or `usercustomize`.
_NONISOLATED_ERROR = (
    "non-isolated execution is prohibited and non-authoritative; use "
    "tools/buck/bootstrap/buck2w or invoke a trusted python3 -I; this "
    "rejection occurs after interpreter startup"
)
if __name__ == "__main__" and not sys.flags.isolated:
    sys.stderr.write(f"buck2-bootstrap: {_NONISOLATED_ERROR}\n")
    raise SystemExit(6)

import argparse
import contextlib
import dataclasses
import errno
import functools
import hashlib
import http.server
import json
import os
import platform as host_platform
import re
import secrets
import shutil
import stat
import subprocess
import tarfile
import threading
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, BinaryIO, Iterator, Mapping, Sequence


REPO_ROOT = Path(__file__).resolve().parents[3]
LOCK_PATH = REPO_ROOT / "tools" / "buck" / "toolchain-lock.json"
DEFAULT_CACHE = REPO_ROOT / "tools" / "buck" / "bootstrap" / "cache"
SUPPORTED_COMPONENTS = ("buck2", "rust", "python")
SAFE_FILENAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
UPSTREAM_REDIRECT_HOSTS = {
    "github.com": frozenset(
        {
            "github.com",
            "release-assets.githubusercontent.com",
        }
    ),
    "static.rust-lang.org": frozenset({"static.rust-lang.org"}),
}
_DIRECTORY_FLAGS = (
    os.O_RDONLY
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_DIRECTORY", 0)
    | getattr(os, "O_NOFOLLOW", 0)
)
_READ_FLAGS = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)


class ToolchainError(RuntimeError):
    exit_code = 6


class OfflineCacheError(ToolchainError):
    exit_code = 4


class IntegrityError(ToolchainError):
    exit_code = 5


@dataclasses.dataclass(frozen=True)
class VerifiedArtifact:
    component: str
    path: Path
    fd: int
    size: int
    sha256: str

    def open_reader(self) -> BinaryIO:
        duplicate = os.dup(self.fd)
        os.lseek(duplicate, 0, os.SEEK_SET)
        return os.fdopen(duplicate, "rb", closefd=True)


def _safe_basename(value: Any, *, label: str) -> str:
    if not isinstance(value, str) or not SAFE_FILENAME.fullmatch(value):
        raise ToolchainError(f"{label} must be a single safe basename")
    if value in {".", ".."} or "/" in value or "\\" in value or "\x00" in value:
        raise ToolchainError(f"{label} must be a single safe basename")
    return value


def _parse_https_url(
    url: str, *, error_type: type[ToolchainError]
) -> urllib.parse.ParseResult:
    try:
        parsed = urllib.parse.urlparse(url)
        port = parsed.port
    except (TypeError, ValueError) as error:
        raise error_type(f"invalid download URL: {url!r}") from error
    if (
        parsed.scheme.lower() != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or (port is not None and port != 443)
    ):
        raise error_type(f"download URL violates the HTTPS origin policy: {url}")
    return parsed


def _validate_download_url(
    initial_url: str, candidate_url: str, *, mirror: bool
) -> str:
    initial = _parse_https_url(initial_url, error_type=IntegrityError)
    candidate = _parse_https_url(candidate_url, error_type=IntegrityError)
    initial_authority = (initial.hostname.lower(), initial.port or 443)
    candidate_authority = (candidate.hostname.lower(), candidate.port or 443)
    if mirror:
        if candidate_authority != initial_authority:
            raise IntegrityError(
                "approved mirror redirects must remain on the same HTTPS authority"
            )
    else:
        allowed_hosts = UPSTREAM_REDIRECT_HOSTS.get(initial_authority[0])
        if allowed_hosts is None or candidate_authority[0] not in allowed_hosts:
            raise IntegrityError(
                f"download redirected to an unapproved HTTPS host: {candidate_authority[0]}"
            )
    return urllib.parse.urlunparse(candidate)


def _lexical_absolute(path: Path) -> Path:
    return Path(os.path.abspath(os.path.expanduser(os.fspath(path))))


def _open_directory_chain(path: Path, *, create: bool) -> int:
    absolute = _lexical_absolute(path)
    if not absolute.is_absolute():
        raise IntegrityError(f"cache path must be absolute: {path}")
    descriptor = os.open(absolute.anchor, _DIRECTORY_FLAGS)
    try:
        for part in absolute.parts[1:]:
            if part in {"", ".", ".."}:
                raise IntegrityError(f"unsafe cache directory component: {part!r}")
            try:
                metadata = os.stat(part, dir_fd=descriptor, follow_symlinks=False)
            except FileNotFoundError:
                if not create:
                    raise
                try:
                    os.mkdir(part, mode=0o700, dir_fd=descriptor)
                except FileExistsError:
                    pass
                metadata = os.stat(part, dir_fd=descriptor, follow_symlinks=False)
            if stat.S_ISLNK(metadata.st_mode):
                raise IntegrityError(f"cache ancestor is a symlink: {absolute}")
            if not stat.S_ISDIR(metadata.st_mode):
                raise IntegrityError(f"cache ancestor is not a directory: {absolute}")
            try:
                child = os.open(part, _DIRECTORY_FLAGS, dir_fd=descriptor)
            except OSError as error:
                if error.errno in {errno.ELOOP, errno.ENOTDIR}:
                    raise IntegrityError(
                        f"cache ancestor is a symlink or not a directory: {absolute}"
                    ) from error
                raise
            opened = os.fstat(child)
            if not stat.S_ISDIR(opened.st_mode):
                os.close(child)
                raise IntegrityError(f"cache ancestor is not a directory: {absolute}")
            if (metadata.st_dev, metadata.st_ino) != (opened.st_dev, opened.st_ino):
                os.close(child)
                raise IntegrityError(f"cache ancestor changed while opening: {absolute}")
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


@contextlib.contextmanager
def _secure_directory(path: Path, *, create: bool) -> Iterator[int]:
    descriptor = _open_directory_chain(path, create=create)
    try:
        yield descriptor
    finally:
        os.close(descriptor)


def _sha256_fd(fd: int) -> str:
    digest = hashlib.sha256()
    offset = 0
    while True:
        chunk = os.pread(fd, 1024 * 1024, offset)
        if not chunk:
            return digest.hexdigest()
        digest.update(chunk)
        offset += len(chunk)


def _validate_locked_identity(identity: Any, *, label: str) -> None:
    if not isinstance(identity, Mapping):
        raise ToolchainError(f"{label} identity must be an object")
    digest = identity.get("sha256")
    size = identity.get("size")
    if not isinstance(digest, str) or not SHA256.fullmatch(digest):
        raise ToolchainError(f"invalid {label} SHA-256")
    if type(size) is not int or size <= 0:
        raise ToolchainError(f"invalid {label} size")


def _verified_file_identity(
    fd: int, expected: Mapping[str, Any], *, label: str
) -> os.stat_result:
    before = os.fstat(fd)
    if not stat.S_ISREG(before.st_mode):
        raise IntegrityError(f"{label} is not a regular file")
    expected_size = expected.get("size")
    if type(expected_size) is not int or expected_size <= 0:
        raise ToolchainError(f"{label} has no valid locked size")
    if before.st_size != expected_size:
        raise IntegrityError(
            f"{label} failed size verification: expected {expected_size}, got {before.st_size}"
        )
    expected_digest = expected.get("sha256")
    if not isinstance(expected_digest, str) or not SHA256.fullmatch(expected_digest):
        raise ToolchainError(f"{label} has no valid locked SHA-256")
    actual_digest = _sha256_fd(fd)
    after = os.fstat(fd)
    if (
        (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino)
        or before.st_size != after.st_size
        or before.st_mtime_ns != after.st_mtime_ns
        or before.st_ctime_ns != after.st_ctime_ns
    ):
        raise IntegrityError(f"{label} changed during identity verification")
    if actual_digest != expected_digest:
        raise IntegrityError(f"{label} failed SHA-256 verification")
    return after


@contextlib.contextmanager
def _open_regular_at(
    parent_fd: int, filename: str, *, component: str
) -> Iterator[tuple[int, os.stat_result]]:
    try:
        metadata = os.stat(filename, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        raise
    if stat.S_ISLNK(metadata.st_mode):
        raise IntegrityError(f"cached {component} archive is a symlink")
    if not stat.S_ISREG(metadata.st_mode):
        raise IntegrityError(f"cached {component} archive is not a regular file")
    try:
        descriptor = os.open(filename, _READ_FLAGS, dir_fd=parent_fd)
    except OSError as error:
        if error.errno in {errno.ELOOP, errno.ENOTDIR}:
            raise IntegrityError(f"cached {component} archive is a symlink") from error
        raise
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode):
            raise IntegrityError(f"cached {component} archive is not a regular file")
        if (metadata.st_dev, metadata.st_ino) != (opened.st_dev, opened.st_ino):
            raise IntegrityError(f"cached {component} archive changed while opening")
        yield descriptor, opened
    finally:
        os.close(descriptor)


def load_lock(path: Path = LOCK_PATH) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ToolchainError(f"cannot read toolchain lock {path}: {error}") from error

    if value.get("schema_version") != 1:
        raise ToolchainError("unsupported toolchain lock schema")
    if value.get("buck2", {}).get("prelude_source") != "bundled":
        raise ToolchainError("Buck2 prelude must remain bundled with the pinned binary")
    if value.get("rust", {}).get("version") != "1.96.0":
        raise ToolchainError("Rust toolchain lock must remain at 1.96.0")

    platforms = value.get("platforms", {})
    expected = {
        "macos-aarch64",
        "macos-x86_64",
        "linux-aarch64",
        "linux-x86_64",
    }
    if set(platforms) != expected:
        raise ToolchainError("toolchain lock must cover macOS/Linux on aarch64/x86_64")
    for platform_name, entry in platforms.items():
        for component in SUPPORTED_COMPONENTS:
            component_entry = entry.get(component, {})
            if not SHA256.fullmatch(component_entry.get("sha256", "")):
                raise ToolchainError(
                    f"invalid {component} digest for platform {platform_name}"
                )
            filename = _safe_basename(
                component_entry.get("filename"),
                label=f"{component} filename for platform {platform_name}",
            )
            url = component_entry.get("url", "")
            try:
                parsed = _parse_https_url(url, error_type=ToolchainError)
            except ToolchainError as error:
                raise ToolchainError(
                    f"invalid {component} origin for platform {platform_name}"
                ) from error
            if parsed.hostname.lower() not in UPSTREAM_REDIRECT_HOSTS:
                raise ToolchainError(
                    f"unapproved {component} origin for platform {platform_name}"
                )
            if parsed.query or urllib.parse.unquote(Path(parsed.path).name) != filename:
                raise ToolchainError(
                    f"{component} URL filename does not match its safe basename for {platform_name}"
                )
            if component == "buck2":
                _validate_locked_identity(
                    {
                        "sha256": component_entry.get("binary_sha256"),
                        "size": component_entry.get("binary_size"),
                    },
                    label=f"Buck2 binary for platform {platform_name}",
                )
            elif component == "rust":
                executables = component_entry.get("executables")
                expected_tools = {"rustc", "rustdoc", "clippy-driver"}
                if not isinstance(executables, dict) or set(executables) != expected_tools:
                    raise ToolchainError(
                        "Rust executable identity matrix is incomplete for platform "
                        f"{platform_name}"
                    )
                for executable, identity in executables.items():
                    _validate_locked_identity(
                        identity,
                        label=f"Rust {executable} for platform {platform_name}",
                    )
    return value


def normalize_platform(value: str | None = None) -> str:
    if value:
        normalized = value.lower().replace("darwin", "macos").replace("arm64", "aarch64")
        normalized = normalized.replace("amd64", "x86_64")
        if normalized in {
            "macos-aarch64",
            "macos-x86_64",
            "linux-aarch64",
            "linux-x86_64",
        }:
            return normalized
        raise ToolchainError(f"unsupported platform override: {value}")

    os_name = host_platform.system().lower()
    if os_name == "darwin":
        os_name = "macos"
    machine = host_platform.machine().lower()
    machine = {"arm64": "aarch64", "amd64": "x86_64"}.get(machine, machine)
    return normalize_platform(f"{os_name}-{machine}")


def cache_path(
    cache_dir: Path,
    platform_name: str,
    component: str,
    component_entry: Mapping[str, Any],
) -> Path:
    if component not in SUPPORTED_COMPONENTS:
        raise ToolchainError(f"unsupported cache component: {component}")
    filename = _safe_basename(component_entry.get("filename"), label="cache filename")
    cache_root = _lexical_absolute(cache_dir)
    candidate = cache_root / platform_name / component / filename
    if os.path.commonpath((os.fspath(cache_root), os.fspath(candidate))) != os.fspath(
        cache_root
    ):
        raise IntegrityError("cache destination escaped the selected cache root")
    return candidate


@contextlib.contextmanager
def verified_cached_artifacts(
    lock: Mapping[str, Any], cache_dir: Path, platform_name: str
) -> Iterator[dict[str, VerifiedArtifact]]:
    platform_entry = lock["platforms"][platform_name]
    cache_root = _lexical_absolute(cache_dir)
    verified: dict[str, VerifiedArtifact] = {}
    with contextlib.ExitStack() as stack:
        missing: list[str] = []
        for component in SUPPORTED_COMPONENTS:
            component_entry = platform_entry[component]
            component_dir = cache_root / platform_name / component
            try:
                parent_fd = stack.enter_context(
                    _secure_directory(component_dir, create=False)
                )
            except FileNotFoundError:
                missing.append(component)
                continue
            filename = _safe_basename(
                component_entry.get("filename"), label=f"{component} filename"
            )
            try:
                descriptor, opened = stack.enter_context(
                    _open_regular_at(parent_fd, filename, component=component)
                )
            except FileNotFoundError:
                missing.append(component)
                continue
            expected = component_entry["sha256"]
            actual = _sha256_fd(descriptor)
            after_hash = os.fstat(descriptor)
            if (
                opened.st_size != after_hash.st_size
                or opened.st_mtime_ns != after_hash.st_mtime_ns
                or opened.st_ctime_ns != after_hash.st_ctime_ns
            ):
                raise IntegrityError(
                    f"cached {component} changed during SHA-256 verification for {platform_name}"
                )
            if actual != expected:
                raise IntegrityError(
                    f"cached {component} failed SHA-256 verification for {platform_name}"
                )
            verified[component] = VerifiedArtifact(
                component=component,
                path=component_dir / filename,
                fd=descriptor,
                size=opened.st_size,
                sha256=actual,
            )
        if missing:
            joined = ", ".join(missing)
            raise OfflineCacheError(
                "offline cache incomplete for "
                f"{platform_name}: missing {joined}; run bootstrap populate explicitly"
            )
        yield verified


class _RestrictedRedirectHandler(urllib.request.HTTPRedirectHandler):
    def __init__(self, initial_url: str, *, mirror: bool):
        super().__init__()
        self.initial_url = initial_url
        self.mirror = mirror

    def redirect_request(
        self,
        request: urllib.request.Request,
        file_pointer: Any,
        code: int,
        message: str,
        headers: Any,
        new_url: str,
    ) -> urllib.request.Request | None:
        resolved = urllib.parse.urljoin(request.full_url, new_url)
        _validate_download_url(self.initial_url, resolved, mirror=self.mirror)
        return super().redirect_request(
            request, file_pointer, code, message, headers, resolved
        )


def _build_mirror_url(mirror_base: str, filename: str) -> str:
    parsed = _parse_https_url(mirror_base, error_type=ToolchainError)
    if parsed.query:
        raise ToolchainError("approved mirror base must not contain a query string")
    safe_filename = _safe_basename(filename, label="mirror filename")
    return f"{mirror_base.rstrip('/')}/{urllib.parse.quote(safe_filename, safe='')}"


def _existing_regular_digest(
    destination: Path, *, component: str
) -> str | None:
    try:
        with _secure_directory(destination.parent, create=True) as parent_fd:
            try:
                with _open_regular_at(
                    parent_fd, destination.name, component=component
                ) as (descriptor, before):
                    digest = _sha256_fd(descriptor)
                    after = os.fstat(descriptor)
                    if (
                        before.st_size != after.st_size
                        or before.st_mtime_ns != after.st_mtime_ns
                        or before.st_ctime_ns != after.st_ctime_ns
                    ):
                        raise IntegrityError(
                            f"cached {component} changed during verification"
                        )
                    return digest
            except FileNotFoundError:
                return None
    except FileNotFoundError:
        return None


def _download_verified(
    url: str,
    destination: Path,
    expected_sha256: str,
    *,
    mirror: bool = False,
    opener: Any | None = None,
) -> None:
    _validate_download_url(url, url, mirror=mirror)
    filename = _safe_basename(destination.name, label="download filename")
    destination = _lexical_absolute(destination)
    digest = hashlib.sha256()
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "maintenance-buck2-bootstrap/1"},
    )
    if opener is None:
        opener = urllib.request.build_opener(
            _RestrictedRedirectHandler(url, mirror=mirror)
        )
    with _secure_directory(destination.parent, create=True) as parent_fd:
        try:
            existing = os.stat(filename, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            existing = None
        if existing is not None:
            if stat.S_ISLNK(existing.st_mode):
                raise IntegrityError(f"download destination is a symlink: {destination}")
            if not stat.S_ISREG(existing.st_mode):
                raise IntegrityError(
                    f"download destination is not a regular file: {destination}"
                )

        temporary_name = (
            f".{filename}.partial-{os.getpid()}-{secrets.token_hex(16)}"
        )
        write_flags = (
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0)
        )
        temporary_fd = os.open(
            temporary_name, write_flags, 0o600, dir_fd=parent_fd
        )
        temporary_metadata: os.stat_result | None = None
        published = False
        try:
            with os.fdopen(temporary_fd, "wb", closefd=True) as output, opener.open(
                request, timeout=60
            ) as response:
                final_url = response.geturl()
                _validate_download_url(url, final_url, mirror=mirror)
                for chunk in iter(lambda: response.read(1024 * 1024), b""):
                    digest.update(chunk)
                    output.write(chunk)
                output.flush()
                os.fsync(output.fileno())
                temporary_metadata = os.fstat(output.fileno())
            if digest.hexdigest() != expected_sha256:
                raise IntegrityError(
                    f"downloaded artifact failed SHA-256 verification: {filename}"
                )
            if existing is not None:
                try:
                    current = os.stat(
                        filename, dir_fd=parent_fd, follow_symlinks=False
                    )
                except FileNotFoundError as error:
                    raise IntegrityError(
                        f"download destination changed before publish: {destination}"
                    ) from error
                if stat.S_ISLNK(current.st_mode) or not stat.S_ISREG(current.st_mode):
                    raise IntegrityError(
                        f"download destination changed before publish: {destination}"
                    )
                os.unlink(filename, dir_fd=parent_fd)
            try:
                os.link(
                    temporary_name,
                    filename,
                    src_dir_fd=parent_fd,
                    dst_dir_fd=parent_fd,
                    follow_symlinks=False,
                )
            except FileExistsError as error:
                raise IntegrityError(
                    f"download destination changed before publish: {destination}"
                ) from error
            published_metadata = os.stat(
                filename, dir_fd=parent_fd, follow_symlinks=False
            )
            if temporary_metadata is None or (
                published_metadata.st_dev,
                published_metadata.st_ino,
            ) != (temporary_metadata.st_dev, temporary_metadata.st_ino):
                os.unlink(filename, dir_fd=parent_fd)
                raise IntegrityError(
                    f"download destination did not publish atomically: {destination}"
                )
            published = True
            os.fsync(parent_fd)
        finally:
            try:
                os.unlink(temporary_name, dir_fd=parent_fd)
            except FileNotFoundError:
                pass
            if not published:
                try:
                    current = os.stat(filename, dir_fd=parent_fd, follow_symlinks=False)
                except FileNotFoundError:
                    current = None
                if (
                    current is not None
                    and temporary_metadata is not None
                    and (current.st_dev, current.st_ino)
                    == (temporary_metadata.st_dev, temporary_metadata.st_ino)
                ):
                    os.unlink(filename, dir_fd=parent_fd)


def populate(
    lock: Mapping[str, Any],
    cache_dir: Path,
    platform_name: str,
    components: Sequence[str],
    mirror_base: str | None,
) -> None:
    entry = lock["platforms"][platform_name]
    for component in components:
        artifact = entry[component]
        destination = cache_path(cache_dir, platform_name, component, artifact)
        existing_digest = _existing_regular_digest(
            destination, component=component
        )
        if existing_digest == artifact["sha256"]:
            print(f"cache hit: {component} ({platform_name})")
            continue
        url = artifact["url"]
        if mirror_base:
            url = _build_mirror_url(mirror_base, artifact["filename"])
        print(f"populating {component} ({platform_name})", file=sys.stderr)
        _download_verified(
            url,
            destination,
            artifact["sha256"],
            mirror=mirror_base is not None,
        )


def _trusted_host_shell() -> str:
    for candidate in (Path("/bin/sh"), Path("/usr/bin/sh")):
        try:
            resolved = Path(os.path.realpath(candidate))
            metadata = resolved.stat()
        except FileNotFoundError:
            continue
        if resolved.is_absolute() and stat.S_ISREG(metadata.st_mode) and os.access(
            resolved, os.X_OK
        ):
            return str(resolved)
    raise ToolchainError("no trusted absolute host shell is available")


def _trusted_zstd_decoder() -> str:
    for candidate in (
        Path("/usr/bin/zstd"),
        Path("/bin/zstd"),
        Path("/usr/local/bin/zstd"),
        Path("/opt/homebrew/bin/zstd"),
        Path("/usr/bin/unzstd"),
        Path("/bin/unzstd"),
        Path("/usr/local/bin/unzstd"),
        Path("/opt/homebrew/bin/unzstd"),
    ):
        try:
            resolved = Path(os.path.realpath(candidate))
            metadata = resolved.stat()
        except FileNotFoundError:
            continue
        if (
            resolved.is_absolute()
            and stat.S_ISREG(metadata.st_mode)
            and metadata.st_mode & 0o022 == 0
            and os.access(resolved, os.X_OK)
        ):
            return str(resolved)
    raise ToolchainError(
        "no trusted absolute zstd decoder is available and this Python lacks compression.zstd"
    )


def _assert_opened_executable_path(path: Path, fd: int, *, label: str) -> None:
    if not path.is_absolute():
        raise IntegrityError(f"{label} execution path is not absolute")
    try:
        path_metadata = path.lstat()
    except FileNotFoundError as error:
        raise IntegrityError(f"{label} path disappeared before execution") from error
    opened_metadata = os.fstat(fd)
    if stat.S_ISLNK(path_metadata.st_mode) or not stat.S_ISREG(path_metadata.st_mode):
        raise IntegrityError(f"{label} execution path is not a regular file")
    if not stat.S_ISREG(opened_metadata.st_mode):
        raise IntegrityError(f"{label} opened file is not regular")
    if opened_metadata.st_mode & 0o111 == 0:
        raise IntegrityError(f"{label} opened file is not executable")
    if (path_metadata.st_dev, path_metadata.st_ino) != (
        opened_metadata.st_dev,
        opened_metadata.st_ino,
    ):
        raise IntegrityError(f"{label} path changed after authentication")


def _run_checked(
    command: Sequence[str],
    *,
    cwd: Path | None = None,
    verified_executable_fd: int | None = None,
    verified_executable_identity: Mapping[str, Any] | None = None,
    verified_executable_label: str | None = None,
    pass_fds: Sequence[int] = (),
) -> str:
    resolved_command = list(command)
    child_env: Mapping[str, str] | None = None
    if verified_executable_fd is not None:
        if not resolved_command or verified_executable_identity is None:
            raise ToolchainError("verified executable execution requires a command and identity")
        label = verified_executable_label or "authenticated executable"
        _verified_file_identity(
            verified_executable_fd,
            verified_executable_identity,
            label=label,
        )
        _assert_opened_executable_path(
            Path(resolved_command[0]), verified_executable_fd, label=label
        )
    if resolved_command and resolved_command[0] == "sh":
        resolved_command[0] = _trusted_host_shell()
        child_env = {
            "PATH": os.pathsep.join(("/usr/bin", "/bin")),
            "LANG": "C",
            "LC_ALL": "C",
        }
    result = subprocess.run(
        resolved_command,
        cwd=cwd,
        env=child_env,
        pass_fds=tuple(pass_fds),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip()
        raise ToolchainError(f"command failed ({resolved_command[0]}): {detail}")
    return result.stdout.strip()


def _remove_tree_at(parent_fd: int, name: str) -> None:
    metadata = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if stat.S_ISLNK(metadata.st_mode):
        raise IntegrityError(f"derived directory is a symlink: {name}")
    if not stat.S_ISDIR(metadata.st_mode):
        raise IntegrityError(f"derived path is not a directory: {name}")
    if not shutil.rmtree.avoids_symlink_attacks:
        raise ToolchainError("secure directory cleanup is unavailable on this platform")
    shutil.rmtree(name, dir_fd=parent_fd)


def _reject_or_remove_legacy_buck2(bin_fd: int) -> None:
    try:
        metadata = os.stat("buck2", dir_fd=bin_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    if stat.S_ISLNK(metadata.st_mode):
        raise IntegrityError("legacy derived Buck2 binary is a symlink")
    if not stat.S_ISREG(metadata.st_mode):
        raise IntegrityError("legacy derived Buck2 binary is not a regular file")
    os.unlink("buck2", dir_fd=bin_fd)


def _reject_or_remove_legacy_rust(component_fd: int) -> None:
    try:
        install_metadata = os.stat(
            "install", dir_fd=component_fd, follow_symlinks=False
        )
    except FileNotFoundError:
        return
    if stat.S_ISLNK(install_metadata.st_mode):
        raise IntegrityError("legacy derived Rust install is a symlink")
    if not stat.S_ISDIR(install_metadata.st_mode):
        raise IntegrityError("legacy derived Rust install is not a directory")
    install_fd = os.open("install", _DIRECTORY_FLAGS, dir_fd=component_fd)
    try:
        try:
            bin_metadata = os.stat("bin", dir_fd=install_fd, follow_symlinks=False)
        except FileNotFoundError:
            bin_metadata = None
        if bin_metadata is not None:
            if stat.S_ISLNK(bin_metadata.st_mode):
                raise IntegrityError("legacy derived Rust bin directory is a symlink")
            if not stat.S_ISDIR(bin_metadata.st_mode):
                raise IntegrityError(
                    "legacy derived Rust bin path is not a directory"
                )
            bin_fd = os.open("bin", _DIRECTORY_FLAGS, dir_fd=install_fd)
            try:
                for name in ("rustc", "rustdoc", "clippy-driver"):
                    try:
                        tool = os.stat(name, dir_fd=bin_fd, follow_symlinks=False)
                    except FileNotFoundError:
                        continue
                    if stat.S_ISLNK(tool.st_mode):
                        raise IntegrityError(
                            f"legacy derived Rust tool is a symlink: {name}"
                        )
                    if not stat.S_ISREG(tool.st_mode):
                        raise IntegrityError(
                            f"legacy derived Rust tool is not a regular file: {name}"
                        )
            finally:
                os.close(bin_fd)
    finally:
        os.close(install_fd)
    _remove_tree_at(component_fd, "install")


def _decompress_buck2(archive: VerifiedArtifact, output: BinaryIO) -> None:
    try:
        from compression import zstd
    except ModuleNotFoundError:
        decoder = _trusted_zstd_decoder()
        with archive.open_reader() as input_stream:
            result = subprocess.run(
                [decoder, "-d", "-c"],
                stdin=input_stream,
                stdout=output,
                stderr=subprocess.PIPE,
                env={
                    "PATH": os.pathsep.join(("/usr/bin", "/bin")),
                    "LANG": "C",
                    "LC_ALL": "C",
                },
                check=False,
            )
        if result.returncode != 0:
            detail = result.stderr.decode(errors="replace").strip()
            raise ToolchainError(f"command failed ({decoder}): {detail}")
        return

    try:
        with archive.open_reader() as input_stream, zstd.open(
            input_stream, "rb"
        ) as decompressed:
            shutil.copyfileobj(decompressed, output, length=1024 * 1024)
    except (OSError, zstd.ZstdError) as error:
        raise ToolchainError(f"cannot decompress pinned Buck2 archive: {error}") from error


@contextlib.contextmanager
def _open_verified_executable(
    path: Path, expected: Mapping[str, Any], *, label: str
) -> Iterator[int]:
    name = _safe_basename(path.name, label=label)
    with _secure_directory(path.parent, create=False) as parent_fd:
        metadata = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise IntegrityError(f"{label} is not a regular file")
        descriptor = os.open(name, _READ_FLAGS, dir_fd=parent_fd)
        try:
            opened = os.fstat(descriptor)
            if (metadata.st_dev, metadata.st_ino) != (
                opened.st_dev,
                opened.st_ino,
            ):
                raise IntegrityError(f"{label} changed while opening")
            if opened.st_mode & 0o111 == 0:
                raise IntegrityError(f"{label} is not executable")
            _verified_file_identity(descriptor, expected, label=label)
            yield descriptor
        finally:
            os.close(descriptor)


def materialize_buck2(
    lock: Mapping[str, Any],
    platform_name: str,
    archive: VerifiedArtifact,
    env: Mapping[str, str],
) -> Path:
    del env  # Caller PATH must never select executable decompression code.
    component_dir = archive.path.parent
    bin_dir = component_dir / "bin"
    buck_entry = lock["platforms"][platform_name]["buck2"]
    binary_identity = {
        "sha256": buck_entry["binary_sha256"],
        "size": buck_entry["binary_size"],
    }
    with _secure_directory(bin_dir, create=True) as bin_fd:
        _reject_or_remove_legacy_buck2(bin_fd)
        stage_name = f".buck2-stage-{secrets.token_hex(16)}"
        final_name = f"buck2-generation-{archive.sha256[:16]}-{secrets.token_hex(16)}"
        stage_flags = (
            os.O_RDWR
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0)
        )
        stage_fd = os.open(stage_name, stage_flags, 0o600, dir_fd=bin_fd)
        published = False
        try:
            with os.fdopen(stage_fd, "w+b", closefd=True) as output:
                _decompress_buck2(archive, output)
                output.flush()
                os.fsync(output.fileno())
                stage_label = f"staged Buck2 binary for {platform_name}"
                _verified_file_identity(
                    output.fileno(), binary_identity, label=stage_label
                )
                os.fchmod(output.fileno(), 0o500)
                staged_binary = bin_dir / stage_name
                version = _run_checked(
                    [str(staged_binary), "--version"],
                    verified_executable_fd=output.fileno(),
                    verified_executable_identity=binary_identity,
                    verified_executable_label=stage_label,
                )
                expected_version = f"buck2 {lock['buck2']['version']}"
                if version != expected_version:
                    raise IntegrityError(
                        f"pinned Buck2 version mismatch for {platform_name}: {version}"
                    )
                verified_stage_metadata = os.fstat(output.fileno())
                try:
                    os.link(
                        stage_name,
                        final_name,
                        src_dir_fd=bin_fd,
                        dst_dir_fd=bin_fd,
                        follow_symlinks=False,
                    )
                except FileExistsError as error:
                    raise IntegrityError("fresh Buck2 generation name collided") from error
                final_metadata = os.stat(
                    final_name, dir_fd=bin_fd, follow_symlinks=False
                )
                if (verified_stage_metadata.st_dev, verified_stage_metadata.st_ino) != (
                    final_metadata.st_dev,
                    final_metadata.st_ino,
                ):
                    os.unlink(final_name, dir_fd=bin_fd)
                    raise IntegrityError(
                        "fresh Buck2 generation was not published from the authenticated stage"
                    )
                published = True
                os.fsync(bin_fd)
        finally:
            try:
                os.unlink(stage_name, dir_fd=bin_fd)
            except FileNotFoundError:
                pass
            if not published:
                try:
                    os.unlink(final_name, dir_fd=bin_fd)
                except FileNotFoundError:
                    pass

    binary = bin_dir / final_name
    final_label = f"published Buck2 binary for {platform_name}"
    with _open_verified_executable(
        binary, binary_identity, label=final_label
    ) as binary_fd:
        version = _run_checked(
            [str(binary), "--version"],
            verified_executable_fd=binary_fd,
            verified_executable_identity=binary_identity,
            verified_executable_label=final_label,
        )
    expected_version = f"buck2 {lock['buck2']['version']}"
    if version != expected_version:
        raise IntegrityError(
            f"pinned Buck2 version mismatch for {platform_name}: {version}"
        )
    return binary


def _parse_unique_rustc_fields(verbose: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    for line in verbose.splitlines():
        key, separator, value = line.partition(":")
        if not separator:
            continue
        key = key.strip()
        if not key:
            continue
        if key in fields:
            raise IntegrityError(f"duplicate Rust compiler identity field: {key}")
        fields[key] = value.strip()
    return fields


def _verify_rust_install(
    lock: Mapping[str, Any], platform_name: str, install: Path
) -> dict[str, Path]:
    tools = {
        "rustc": install / "bin" / "rustc",
        "rustdoc": install / "bin" / "rustdoc",
        "clippy_driver": install / "bin" / "clippy-driver",
    }
    expected_executables = lock["platforms"][platform_name]["rust"]["executables"]
    with contextlib.ExitStack() as opened_tools:
        descriptors: dict[str, int] = {}
        missing: list[str] = []
        for name, path in tools.items():
            filename = path.name
            label = f"materialized Rust tool {filename} for {platform_name}"
            try:
                descriptors[name] = opened_tools.enter_context(
                    _open_verified_executable(
                        path, expected_executables[filename], label=label
                    )
                )
            except FileNotFoundError:
                missing.append(name)
        if missing:
            raise IntegrityError(
                f"materialized Rust toolchain lacks: {', '.join(missing)}"
            )

        rustc_path = tools["rustc"]
        rustc_identity = expected_executables[rustc_path.name]
        rustc_label = f"materialized Rust tool rustc for {platform_name}"
        verbose = _run_checked(
            [str(rustc_path), "-Vv"],
            verified_executable_fd=descriptors["rustc"],
            verified_executable_identity=rustc_identity,
            verified_executable_label=rustc_label,
        )
        fields = _parse_unique_rustc_fields(verbose)
        if (
            fields.get("release") != lock["rust"]["version"]
            or fields.get("commit-hash") != lock["rust"]["commit"]
        ):
            raise IntegrityError(
                "materialized Rust compiler does not match the repository lock"
            )
    return tools


def materialize_rust(
    lock: Mapping[str, Any], platform_name: str, archive: VerifiedArtifact
) -> dict[str, Path]:
    component_dir = archive.path.parent
    with _secure_directory(component_dir, create=False) as component_fd:
        _reject_or_remove_legacy_rust(component_fd)
        stage_name = f".rust-stage-{secrets.token_hex(16)}"
        extract_name = f".rust-extract-{secrets.token_hex(16)}"
        final_name = (
            f"rust-generation-{archive.sha256[:16]}-{secrets.token_hex(16)}"
        )
        os.mkdir(stage_name, mode=0o700, dir_fd=component_fd)
        os.mkdir(extract_name, mode=0o700, dir_fd=component_fd)
        stage = component_dir / stage_name
        extract_root = component_dir / extract_name
        published = False
        try:
            with archive.open_reader() as archive_reader, tarfile.open(
                fileobj=archive_reader, mode="r:xz"
            ) as rust_archive:
                rust_archive.extractall(extract_root, filter="data")
            installers = list(extract_root.glob("*/install.sh"))
            if len(installers) != 1:
                raise IntegrityError("Rust distribution must contain exactly one installer")
            installer_metadata = installers[0].lstat()
            if stat.S_ISLNK(installer_metadata.st_mode) or not stat.S_ISREG(
                installer_metadata.st_mode
            ):
                raise IntegrityError("Rust distribution installer is not a regular file")
            _run_checked(
                [
                    "sh",
                    str(installers[0]),
                    f"--prefix={stage}",
                    "--disable-ldconfig",
                ],
                cwd=installers[0].parent,
            )
            _verify_rust_install(lock, platform_name, stage)
            try:
                os.rename(
                    stage_name,
                    final_name,
                    src_dir_fd=component_fd,
                    dst_dir_fd=component_fd,
                )
            except FileExistsError as error:
                raise IntegrityError("fresh Rust generation name collided") from error
            published = True
            os.fsync(component_fd)
        finally:
            try:
                _remove_tree_at(component_fd, extract_name)
            except FileNotFoundError:
                pass
            if not published:
                try:
                    _remove_tree_at(component_fd, stage_name)
                except FileNotFoundError:
                    pass

    install = component_dir / final_name
    return _verify_rust_install(lock, platform_name, install)


def _remove_owned_buck2_generation(binary: Path) -> None:
    name = _safe_basename(binary.name, label="owned Buck2 generation")
    if not name.startswith("buck2-generation-"):
        raise IntegrityError(f"refusing to remove unowned Buck2 path: {binary}")
    with _secure_directory(binary.parent, create=False) as bin_fd:
        metadata = os.stat(name, dir_fd=bin_fd, follow_symlinks=False)
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise IntegrityError(f"owned Buck2 generation is not a regular file: {name}")
        os.unlink(name, dir_fd=bin_fd)
        os.fsync(bin_fd)


def _remove_owned_rust_generation(tools: Mapping[str, Path]) -> None:
    generation = tools["rustc"].parent.parent
    if any(path.parent.parent != generation for path in tools.values()):
        raise IntegrityError("materialized Rust tools do not share one owned generation")
    name = _safe_basename(generation.name, label="owned Rust generation")
    if not name.startswith("rust-generation-"):
        raise IntegrityError(f"refusing to remove unowned Rust path: {generation}")
    with _secure_directory(generation.parent, create=False) as component_fd:
        _remove_tree_at(component_fd, name)
        os.fsync(component_fd)


@contextlib.contextmanager
def _materialized_toolchains(
    lock: Mapping[str, Any],
    platform_name: str,
    cached: Mapping[str, VerifiedArtifact],
    env: Mapping[str, str],
) -> Iterator[tuple[Path, dict[str, Path], int, dict[str, int]]]:
    with contextlib.ExitStack() as cleanup:
        buck2 = materialize_buck2(lock, platform_name, cached["buck2"], env)
        cleanup.callback(_remove_owned_buck2_generation, buck2)
        rust_tools = materialize_rust(lock, platform_name, cached["rust"])
        cleanup.callback(_remove_owned_rust_generation, rust_tools)

        buck_entry = lock["platforms"][platform_name]["buck2"]
        buck_identity = {
            "sha256": buck_entry["binary_sha256"],
            "size": buck_entry["binary_size"],
        }
        buck_fd = cleanup.enter_context(
            _open_verified_executable(
                buck2,
                buck_identity,
                label=f"live Buck2 generation for {platform_name}",
            )
        )
        rust_identities = lock["platforms"][platform_name]["rust"]["executables"]
        rust_fds = {
            name: cleanup.enter_context(
                _open_verified_executable(
                    path,
                    rust_identities[path.name],
                    label=f"live Rust tool {path.name} for {platform_name}",
                )
            )
            for name, path in rust_tools.items()
        }
        yield buck2, rust_tools, buck_fd, rust_fds


def _resolve_from_path(name: str, env: Mapping[str, str]) -> Path | None:
    candidate = Path(name).expanduser()
    if candidate.is_absolute():
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate.absolute()
        return None
    resolved = shutil.which(name, path=env.get("PATH"))
    return Path(resolved).absolute() if resolved else None


def _resolve_with_xcrun(name: str, env: Mapping[str, str]) -> Path | None:
    xcrun = shutil.which("xcrun", path=env.get("PATH"))
    if not xcrun:
        return None
    result = subprocess.run(
        [xcrun, "--find", name],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if result.returncode != 0:
        return None
    candidate = Path(result.stdout.strip())
    return candidate.absolute() if candidate.is_file() else None


def _infer_override_compiler_type(cc: Path, cxx: Path) -> str:
    cc_name = cc.name.lower()
    cxx_name = cxx.name.lower()
    if "clang" in cc_name and "clang" in cxx_name:
        return "clang"
    if "gcc" in cc_name and ("g++" in cxx_name or "gcc" in cxx_name):
        return "gcc"
    raise ToolchainError(
        "compiler override with ambiguous names requires an explicit "
        "BUCK2_CXX_COMPILER_TYPE"
    )


def _probe_compiler_family(path: Path) -> str:
    output = _run_checked([str(path), "--version"]).lower()
    is_clang = "clang" in output
    is_gcc = (
        "gcc" in output
        or "g++" in output
        or "free software foundation" in output
    )
    if is_clang == is_gcc:
        raise ToolchainError(f"cannot determine compiler family from {path} --version")
    return "clang" if is_clang else "gcc"


def resolve_cxx_tools(
    platform_name: str,
    platform_entry: Mapping[str, Any],
    env: Mapping[str, str],
) -> dict[str, str]:
    override_keys = {
        "cc": "BUCK2_CC",
        "cxx": "BUCK2_CXX",
        "archiver": "BUCK2_AR",
        "linker": "BUCK2_LD",
    }
    path_override_present = any(key in env for key in override_keys.values())
    compiler_type_present = "BUCK2_CXX_COMPILER_TYPE" in env
    if compiler_type_present and not path_override_present:
        raise ToolchainError(
            "BUCK2_CXX_COMPILER_TYPE requires BUCK2_CC, BUCK2_CXX, BUCK2_AR, and BUCK2_LD"
        )
    if path_override_present:
        override_names = {
            name: env.get(environment_name)
            for name, environment_name in override_keys.items()
        }
        if not all(override_names.values()):
            raise ToolchainError(
                "BUCK2_CC, BUCK2_CXX, BUCK2_AR, and BUCK2_LD must be set together"
            )
        resolved = {
            name: _resolve_from_path(value or "", env)
            for name, value in override_names.items()
        }
        missing = [name for name, path in resolved.items() if path is None]
        if missing:
            raise ToolchainError(
                f"configured C/C++ tools are not executable: {', '.join(missing)}"
            )
        resolved_tools = {
            name: path for name, path in resolved.items() if path is not None
        }
        compiler_type = env.get("BUCK2_CXX_COMPILER_TYPE")
        if not compiler_type_present:
            compiler_type = _infer_override_compiler_type(
                resolved_tools["cc"], resolved_tools["cxx"]
            )
        if compiler_type not in {"clang", "gcc"}:
            raise ToolchainError("BUCK2_CXX_COMPILER_TYPE must be clang or gcc")
        actual_families = {
            _probe_compiler_family(resolved_tools["cc"]),
            _probe_compiler_family(resolved_tools["cxx"]),
        }
        if actual_families != {compiler_type}:
            actual = ", ".join(sorted(actual_families))
            raise ToolchainError(
                f"configured C/C++ compiler family {actual} does not match "
                f"BUCK2_CXX_COMPILER_TYPE={compiler_type}"
            )
        return {
            **{name: str(path) for name, path in resolved_tools.items()},
            "compiler_type": compiler_type,
        }

    resolver = (
        _resolve_with_xcrun
        if platform_name.startswith("macos-")
        else _resolve_from_path
    )
    cxx = platform_entry["cxx"]
    profiles = [
        (
            "clang",
            cxx["cc_candidates"][0],
            cxx["cxx_candidates"][0],
            cxx["archiver_candidates"],
            cxx["linker_candidates"][0],
        )
    ]
    if platform_name.startswith("linux-"):
        profiles.append(("gcc", "gcc", "g++", ["gcc-ar", "ar"], "gcc"))

    for compiler_type, cc_name, cxx_name, archiver_names, linker_name in profiles:
        cc = resolver(cc_name, env)
        cxx_path = resolver(cxx_name, env)
        linker = resolver(linker_name, env)
        archiver = next(
            (path for name in archiver_names if (path := resolver(name, env))),
            None,
        )
        if cc and cxx_path and archiver and linker:
            return {
                "cc": str(cc),
                "cxx": str(cxx_path),
                "archiver": str(archiver),
                "linker": str(linker),
                "compiler_type": compiler_type,
            }
    raise ToolchainError(
        f"no complete configured C/C++ toolchain found for {platform_name}"
    )


class _VerifiedArchiveHandler(http.server.BaseHTTPRequestHandler):
    def __init__(
        self,
        *args: Any,
        artifact: VerifiedArtifact,
        route: str,
        **kwargs: Any,
    ) -> None:
        self.artifact = artifact
        self.route = route
        super().__init__(*args, **kwargs)

    def log_message(self, _format: str, *args: object) -> None:
        del args

    def do_HEAD(self) -> None:
        self._serve(include_body=False)

    def do_GET(self) -> None:
        self._serve(include_body=True)

    def _serve(self, *, include_body: bool) -> None:
        if self.path != self.route:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(self.artifact.size))
        self.end_headers()
        if not include_body:
            return
        offset = 0
        while offset < self.artifact.size:
            chunk = os.pread(
                self.artifact.fd,
                min(1024 * 1024, self.artifact.size - offset),
                offset,
            )
            if not chunk:
                raise IntegrityError("verified Python archive changed while serving")
            self.wfile.write(chunk)
            offset += len(chunk)


@contextlib.contextmanager
def local_mirror(archive: VerifiedArtifact) -> Iterator[str]:
    route = f"/{urllib.parse.quote(archive.path.name, safe='')}"
    handler = functools.partial(
        _VerifiedArchiveHandler, artifact=archive, route=route
    )
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        port = server.server_address[1]
        yield f"http://127.0.0.1:{port}{route}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def _buck_config_args(
    rust_tools: Mapping[str, Path],
    cxx_tools: Mapping[str, str],
    platform_entry: Mapping[str, Any],
    python_url: str,
) -> list[str]:
    values = {
        "toolchain.rustc": rust_tools["rustc"],
        "toolchain.rustdoc": rust_tools["rustdoc"],
        "toolchain.clippy_driver": rust_tools["clippy_driver"],
        "toolchain.rust_target_triple": platform_entry["target_triple"],
        "toolchain.cc": cxx_tools["cc"],
        "toolchain.cxx": cxx_tools["cxx"],
        "toolchain.archiver": cxx_tools["archiver"],
        "toolchain.linker": cxx_tools["linker"],
        "toolchain.compiler_type": cxx_tools["compiler_type"],
        "toolchain.python_archive_url": python_url,
        "toolchain.python_archive_sha256": platform_entry["python"]["sha256"],
    }
    result: list[str] = []
    for key, value in values.items():
        result.extend(["-c", f"{key}={value}"])
    return result


def _compose_buck_command(
    binary: Path, buck_args: Sequence[str], config_args: Sequence[str]
) -> list[str]:
    # `audit` is a command family; Buckconfig options belong to its leaf
    # subcommand (for example `audit providers -c ...`), not to `audit` itself.
    insertion_index = 2 if buck_args[0] == "audit" and len(buck_args) > 1 else 1
    return [
        str(binary),
        *buck_args[:insertion_index],
        *config_args,
        *buck_args[insertion_index:],
    ]


def run_buck(
    lock: Mapping[str, Any],
    cache_dir: Path,
    platform_name: str,
    buck_args: Sequence[str],
    env: Mapping[str, str],
) -> int:
    platform_entry = lock["platforms"][platform_name]
    if not buck_args:
        raise ToolchainError("no Buck2 command was provided")
    with verified_cached_artifacts(lock, cache_dir, platform_name) as cached:
        with _materialized_toolchains(
            lock, platform_name, cached, env
        ) as (buck2, rust_tools, buck_fd, rust_fds):
            cxx_tools = resolve_cxx_tools(platform_name, platform_entry, env)
            child_env = dict(env)
            child_env["PATH"] = (
                f"{rust_tools['rustc'].parent}{os.pathsep}{env.get('PATH', '')}"
            )
            child_env["RUSTUP_TOOLCHAIN"] = lock["rust"]["version"]
            with local_mirror(cached["python"]) as python_url:
                command = _compose_buck_command(
                    buck2,
                    buck_args,
                    _buck_config_args(
                        rust_tools, cxx_tools, platform_entry, python_url
                    ),
                )
                buck_entry = platform_entry["buck2"]
                buck_identity = {
                    "sha256": buck_entry["binary_sha256"],
                    "size": buck_entry["binary_size"],
                }
                buck_label = f"live Buck2 generation for {platform_name}"
                _verified_file_identity(buck_fd, buck_identity, label=buck_label)
                _assert_opened_executable_path(buck2, buck_fd, label=buck_label)
                rust_identities = platform_entry["rust"]["executables"]
                for name, path in rust_tools.items():
                    label = f"live Rust tool {path.name} for {platform_name}"
                    _verified_file_identity(
                        rust_fds[name], rust_identities[path.name], label=label
                    )
                    _assert_opened_executable_path(path, rust_fds[name], label=label)
                return subprocess.run(
                    command, cwd=REPO_ROOT, env=child_env, check=False
                ).returncode


def doctor(
    lock: Mapping[str, Any],
    cache_dir: Path,
    platform_name: str,
    env: Mapping[str, str],
    skip_cache: bool,
) -> dict[str, Any]:
    platform_entry = lock["platforms"][platform_name]
    cxx_tools = resolve_cxx_tools(platform_name, platform_entry, env)
    result: dict[str, Any] = {
        "platform": platform_name,
        "buck2_release": lock["buck2"]["release"],
        "prelude_commit": lock["buck2"]["prelude_commit"],
        "rust_version": lock["rust"]["version"],
        "compiler_type": cxx_tools["compiler_type"],
        "compiler_paths_absolute": all(
            Path(cxx_tools[name]).is_absolute()
            for name in ("cc", "cxx", "archiver", "linker")
        ),
        "cache_verified": False,
    }
    if not skip_cache:
        with verified_cached_artifacts(lock, cache_dir, platform_name) as cached:
            with _materialized_toolchains(lock, platform_name, cached, env):
                result["cache_verified"] = True
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    run_parser = subparsers.add_parser("run", help="run pinned Buck2 offline")
    run_parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE)
    run_parser.add_argument("--platform")
    run_parser.add_argument("buck_args", nargs=argparse.REMAINDER)

    populate_parser = subparsers.add_parser(
        "populate", help="explicitly populate the integrity-checked cache"
    )
    populate_parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE)
    populate_parser.add_argument("--platform")
    populate_parser.add_argument(
        "--component",
        action="append",
        choices=SUPPORTED_COMPONENTS,
        dest="components",
    )
    populate_parser.add_argument("--mirror-base")
    populate_parser.add_argument("--allow-network", action="store_true")

    doctor_parser = subparsers.add_parser("doctor", help="validate locked inputs")
    doctor_parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE)
    doctor_parser.add_argument("--platform")
    doctor_parser.add_argument("--skip-cache", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    # Importing this module is supported only for contract tests. Refuse to turn
    # such a non-isolated import into an operational bootstrap entrypoint.
    if not sys.flags.isolated:
        print(f"buck2-bootstrap: {_NONISOLATED_ERROR}", file=sys.stderr)
        return 6
    args = build_parser().parse_args(argv)
    try:
        lock = load_lock()
        platform_name = normalize_platform(args.platform)
        env = dict(os.environ)
        if args.command == "populate":
            if not args.allow_network:
                raise OfflineCacheError(
                    "cache population requires the explicit --allow-network gate"
                )
            populate(
                lock,
                _lexical_absolute(args.cache_dir),
                platform_name,
                args.components or SUPPORTED_COMPONENTS,
                args.mirror_base,
            )
            return 0
        if args.command == "doctor":
            print(
                json.dumps(
                    doctor(
                        lock,
                        _lexical_absolute(args.cache_dir),
                        platform_name,
                        env,
                        args.skip_cache,
                    ),
                    sort_keys=True,
                )
            )
            return 0
        buck_args = list(args.buck_args)
        if buck_args and buck_args[0] == "--":
            buck_args.pop(0)
        return run_buck(
            lock,
            _lexical_absolute(args.cache_dir),
            platform_name,
            buck_args,
            env,
        )
    except ToolchainError as error:
        print(f"buck2-bootstrap: {error}", file=sys.stderr)
        return error.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
