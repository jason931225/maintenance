#!/usr/bin/env python3
"""Fail-closed bootstrap for the repository's pinned Buck2 toolchains.

Normal ``run`` and ``doctor`` operations never download. Network access exists
only behind the explicit ``populate --allow-network`` command, and every byte
is verified against ``tools/buck/toolchain-lock.json`` before use.
"""

from __future__ import annotations

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
import sys
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

    digest = re.compile(r"^[0-9a-f]{64}$")
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
            if not digest.fullmatch(component_entry.get("sha256", "")):
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


def _run_checked(command: Sequence[str], *, cwd: Path | None = None) -> str:
    result = subprocess.run(
        command,
        cwd=cwd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip()
        raise ToolchainError(f"command failed ({command[0]}): {detail}")
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


def _cleanup_generated_entries(
    parent_fd: int, *, file_prefixes: Sequence[str], directory_prefixes: Sequence[str]
) -> None:
    for name in os.listdir(parent_fd):
        if any(name.startswith(prefix) for prefix in file_prefixes):
            metadata = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
                raise IntegrityError(f"generated file path is not a regular file: {name}")
            os.unlink(name, dir_fd=parent_fd)
        elif any(name.startswith(prefix) for prefix in directory_prefixes):
            _remove_tree_at(parent_fd, name)


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


def _decompress_buck2(
    zstd: str, archive: VerifiedArtifact, output: BinaryIO
) -> None:
    with archive.open_reader() as input_stream:
        result = subprocess.run(
            [zstd, "-d", "-c"],
            stdin=input_stream,
            stdout=output,
            stderr=subprocess.PIPE,
            check=False,
        )
    if result.returncode != 0:
        detail = result.stderr.decode(errors="replace").strip()
        raise ToolchainError(f"command failed ({zstd}): {detail}")


def materialize_buck2(
    lock: Mapping[str, Any],
    platform_name: str,
    archive: VerifiedArtifact,
    env: Mapping[str, str],
) -> Path:
    component_dir = archive.path.parent
    bin_dir = component_dir / "bin"
    with _secure_directory(bin_dir, create=True) as bin_fd:
        _reject_or_remove_legacy_buck2(bin_fd)
        zstd = shutil.which("zstd", path=env.get("PATH")) or shutil.which(
            "unzstd", path=env.get("PATH")
        )
        if not zstd:
            raise ToolchainError(
                "zstd is required to materialize the pinned Buck2 binary"
            )
        _cleanup_generated_entries(
            bin_fd,
            file_prefixes=(".buck2-stage-", "buck2-generation-"),
            directory_prefixes=(),
        )
        stage_name = f".buck2-stage-{secrets.token_hex(16)}"
        final_name = f"buck2-generation-{archive.sha256[:16]}-{secrets.token_hex(16)}"
        stage_flags = (
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0)
        )
        stage_fd = os.open(stage_name, stage_flags, 0o500, dir_fd=bin_fd)
        published = False
        try:
            with os.fdopen(stage_fd, "wb", closefd=True) as output:
                _decompress_buck2(zstd, archive, output)
                output.flush()
                os.fsync(output.fileno())
                os.fchmod(output.fileno(), 0o500)
            stage_metadata = os.stat(
                stage_name, dir_fd=bin_fd, follow_symlinks=False
            )
            if not stat.S_ISREG(stage_metadata.st_mode):
                raise IntegrityError("fresh Buck2 staging output is not a regular file")
            staged_binary = bin_dir / stage_name
            version = _run_checked([str(staged_binary), "--version"])
            expected_version = f"buck2 {lock['buck2']['version']}"
            if version != expected_version:
                raise IntegrityError(
                    f"pinned Buck2 version mismatch for {platform_name}: {version}"
                )
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
            if (stage_metadata.st_dev, stage_metadata.st_ino) != (
                final_metadata.st_dev,
                final_metadata.st_ino,
            ):
                os.unlink(final_name, dir_fd=bin_fd)
                raise IntegrityError("fresh Buck2 generation was not published atomically")
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
    version = _run_checked([str(binary), "--version"])
    expected_version = f"buck2 {lock['buck2']['version']}"
    if version != expected_version:
        raise IntegrityError(
            f"pinned Buck2 version mismatch for {platform_name}: {version}"
        )
    return binary


def _verify_rust_install(lock: Mapping[str, Any], install: Path) -> dict[str, Path]:
    tools = {
        "rustc": install / "bin" / "rustc",
        "rustdoc": install / "bin" / "rustdoc",
        "clippy_driver": install / "bin" / "clippy-driver",
    }
    with _secure_directory(install / "bin", create=False) as bin_fd:
        missing: list[str] = []
        for name, path in tools.items():
            filename = path.name
            try:
                metadata = os.stat(
                    filename, dir_fd=bin_fd, follow_symlinks=False
                )
            except FileNotFoundError:
                missing.append(name)
                continue
            if stat.S_ISLNK(metadata.st_mode):
                raise IntegrityError(f"materialized Rust tool is a symlink: {name}")
            if not stat.S_ISREG(metadata.st_mode):
                raise IntegrityError(
                    f"materialized Rust tool is not a regular file: {name}"
                )
            descriptor = os.open(filename, _READ_FLAGS, dir_fd=bin_fd)
            try:
                opened = os.fstat(descriptor)
                if (metadata.st_dev, metadata.st_ino) != (
                    opened.st_dev,
                    opened.st_ino,
                ):
                    raise IntegrityError(
                        f"materialized Rust tool changed while opening: {name}"
                    )
                if opened.st_mode & 0o111 == 0:
                    raise IntegrityError(
                        f"materialized Rust tool is not executable: {name}"
                    )
            finally:
                os.close(descriptor)
        if missing:
            raise IntegrityError(
                f"materialized Rust toolchain lacks: {', '.join(missing)}"
            )
    verbose = _run_checked([str(tools["rustc"]), "-Vv"])
    expected_version = f"release: {lock['rust']['version']}"
    expected_commit = f"commit-hash: {lock['rust']['commit']}"
    if expected_version not in verbose or expected_commit not in verbose:
        raise IntegrityError("materialized Rust compiler does not match the repository lock")
    return tools


def materialize_rust(
    lock: Mapping[str, Any], platform_name: str, archive: VerifiedArtifact
) -> dict[str, Path]:
    component_dir = archive.path.parent
    with _secure_directory(component_dir, create=False) as component_fd:
        _reject_or_remove_legacy_rust(component_fd)
        _cleanup_generated_entries(
            component_fd,
            file_prefixes=(),
            directory_prefixes=(
                ".rust-stage-",
                ".rust-extract-",
                "rust-generation-",
            ),
        )
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
            _verify_rust_install(lock, stage)
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
    return _verify_rust_install(lock, install)


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
        compiler_type = env.get("BUCK2_CXX_COMPILER_TYPE")
        if not compiler_type_present:
            compiler_type = (
                "gcc"
                if "gcc" in resolved["cc"].name or "g++" in resolved["cxx"].name
                else "clang"
            )
        if compiler_type not in {"clang", "gcc"}:
            raise ToolchainError("BUCK2_CXX_COMPILER_TYPE must be clang or gcc")
        return {
            **{name: str(path) for name, path in resolved.items() if path is not None},
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
        buck2 = materialize_buck2(lock, platform_name, cached["buck2"], env)
        rust_tools = materialize_rust(lock, platform_name, cached["rust"])
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
            materialize_buck2(lock, platform_name, cached["buck2"], env)
            materialize_rust(lock, platform_name, cached["rust"])
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
