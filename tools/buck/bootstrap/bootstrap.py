#!/usr/bin/env python3
"""Fail-closed bootstrap for the repository's pinned Buck2 toolchains.

Normal ``run`` and ``doctor`` operations never download. Network access exists
only behind the explicit ``populate --allow-network`` command, and every byte
is verified against ``tools/buck/toolchain-lock.json`` before use.
"""

from __future__ import annotations

import argparse
import contextlib
import functools
import hashlib
import http.server
import json
import os
import platform as host_platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Iterator, Mapping, Sequence


REPO_ROOT = Path(__file__).resolve().parents[3]
LOCK_PATH = REPO_ROOT / "tools" / "buck" / "toolchain-lock.json"
DEFAULT_CACHE = REPO_ROOT / "tools" / "buck" / "bootstrap" / "cache"
SUPPORTED_COMPONENTS = ("buck2", "rust", "python")


class ToolchainError(RuntimeError):
    exit_code = 6


class OfflineCacheError(ToolchainError):
    exit_code = 4


class IntegrityError(ToolchainError):
    exit_code = 5


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


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
            if not component_entry.get("url", "").startswith("https://"):
                raise ToolchainError(
                    f"invalid {component} origin for platform {platform_name}"
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
    return cache_dir / platform_name / component / component_entry["filename"]


def verify_cached_artifacts(
    lock: Mapping[str, Any], cache_dir: Path, platform_name: str
) -> dict[str, Path]:
    platform_entry = lock["platforms"][platform_name]
    paths = {
        component: cache_path(
            cache_dir, platform_name, component, platform_entry[component]
        )
        for component in SUPPORTED_COMPONENTS
    }
    missing = [component for component, path in paths.items() if not path.is_file()]
    if missing:
        joined = ", ".join(missing)
        raise OfflineCacheError(
            "offline cache incomplete for "
            f"{platform_name}: missing {joined}; run bootstrap populate explicitly"
        )

    for component, path in paths.items():
        expected = platform_entry[component]["sha256"]
        actual = sha256_file(path)
        if actual != expected:
            raise IntegrityError(
                f"cached {component} failed SHA-256 verification for {platform_name}"
            )
    return paths


def _download_verified(url: str, destination: Path, expected_sha256: str) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.partial-{os.getpid()}")
    digest = hashlib.sha256()
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "maintenance-buck2-bootstrap/1"},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response, temporary.open(
            "wb"
        ) as output:
            for chunk in iter(lambda: response.read(1024 * 1024), b""):
                digest.update(chunk)
                output.write(chunk)
        if digest.hexdigest() != expected_sha256:
            raise IntegrityError(
                f"downloaded artifact failed SHA-256 verification: {destination.name}"
            )
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


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
        if destination.is_file() and sha256_file(destination) == artifact["sha256"]:
            print(f"cache hit: {component} ({platform_name})")
            continue
        url = artifact["url"]
        if mirror_base:
            url = f"{mirror_base.rstrip('/')}/{urllib.parse.quote(artifact['filename'])}"
        print(f"populating {component} ({platform_name})", file=sys.stderr)
        _download_verified(url, destination, artifact["sha256"])


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


def materialize_buck2(
    lock: Mapping[str, Any],
    platform_name: str,
    archive: Path,
    env: Mapping[str, str],
) -> Path:
    binary = archive.parent / "bin" / "buck2"
    if not binary.is_file():
        zstd = shutil.which("zstd", path=env.get("PATH")) or shutil.which(
            "unzstd", path=env.get("PATH")
        )
        if not zstd:
            raise ToolchainError("zstd is required to materialize the pinned Buck2 binary")
        binary.parent.mkdir(parents=True, exist_ok=True)
        temporary = binary.with_name(f".buck2.partial-{os.getpid()}")
        try:
            _run_checked([zstd, "-d", "-f", str(archive), "-o", str(temporary)])
            temporary.chmod(0o755)
            os.replace(temporary, binary)
        finally:
            temporary.unlink(missing_ok=True)

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
    missing = [name for name, path in tools.items() if not path.is_file()]
    if missing:
        raise IntegrityError(f"materialized Rust toolchain lacks: {', '.join(missing)}")
    verbose = _run_checked([str(tools["rustc"]), "-Vv"])
    expected_version = f"release: {lock['rust']['version']}"
    expected_commit = f"commit-hash: {lock['rust']['commit']}"
    if expected_version not in verbose or expected_commit not in verbose:
        raise IntegrityError("materialized Rust compiler does not match the repository lock")
    return tools


def materialize_rust(
    lock: Mapping[str, Any], platform_name: str, archive: Path
) -> dict[str, Path]:
    install = archive.parent / "install"
    if install.is_dir():
        return _verify_rust_install(lock, install)

    staging = archive.parent / f".install.partial-{os.getpid()}"
    if staging.exists():
        shutil.rmtree(staging)
    with tempfile.TemporaryDirectory(prefix="rust-dist-", dir=archive.parent) as temp:
        extract_root = Path(temp)
        with tarfile.open(archive, "r:xz") as rust_archive:
            rust_archive.extractall(extract_root, filter="data")
        installers = list(extract_root.glob("*/install.sh"))
        if len(installers) != 1:
            raise IntegrityError("Rust distribution must contain exactly one installer")
        staging.mkdir(parents=True)
        try:
            _run_checked(
                [
                    "sh",
                    str(installers[0]),
                    f"--prefix={staging}",
                    "--disable-ldconfig",
                ],
                cwd=installers[0].parent,
            )
            os.replace(staging, install)
        finally:
            if staging.exists():
                shutil.rmtree(staging)
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
    override_names = {
        "cc": env.get("BUCK2_CC"),
        "cxx": env.get("BUCK2_CXX"),
        "archiver": env.get("BUCK2_AR"),
        "linker": env.get("BUCK2_LD"),
    }
    if any(override_names.values()):
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
        if not compiler_type:
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


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *args: object) -> None:
        del args


@contextlib.contextmanager
def local_mirror(archive: Path) -> Iterator[str]:
    handler = functools.partial(_QuietHandler, directory=str(archive.parent))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        port = server.server_address[1]
        filename = urllib.parse.quote(archive.name)
        yield f"http://127.0.0.1:{port}/{filename}"
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
    cached = verify_cached_artifacts(lock, cache_dir, platform_name)
    platform_entry = lock["platforms"][platform_name]
    buck2 = materialize_buck2(lock, platform_name, cached["buck2"], env)
    rust_tools = materialize_rust(lock, platform_name, cached["rust"])
    cxx_tools = resolve_cxx_tools(platform_name, platform_entry, env)
    if not buck_args:
        raise ToolchainError("no Buck2 command was provided")

    child_env = dict(env)
    child_env["PATH"] = f"{rust_tools['rustc'].parent}{os.pathsep}{env.get('PATH', '')}"
    child_env["RUSTUP_TOOLCHAIN"] = lock["rust"]["version"]
    with local_mirror(cached["python"]) as python_url:
        command = _compose_buck_command(
            buck2,
            buck_args,
            _buck_config_args(rust_tools, cxx_tools, platform_entry, python_url),
        )
        return subprocess.run(command, cwd=REPO_ROOT, env=child_env, check=False).returncode


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
        cached = verify_cached_artifacts(lock, cache_dir, platform_name)
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
                args.cache_dir.resolve(),
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
                        args.cache_dir.resolve(),
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
            args.cache_dir.resolve(),
            platform_name,
            buck_args,
            env,
        )
    except ToolchainError as error:
        print(f"buck2-bootstrap: {error}", file=sys.stderr)
        return error.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
