load("@prelude//:prelude.bzl", "native")
load("@prelude//toolchains:python.bzl", "python_bootstrap_toolchain", "python_toolchain")


def cached_python_toolchain(
        name: str,
        archive_url: str,
        archive_sha256: str,
        visibility: list[str]):
    """Create a Python toolchain from the bootstrap's loopback-only mirror."""
    native.http_archive(
        name = "cpython_archive",
        urls = [archive_url],
        sha256 = archive_sha256,
        type = "tar.gz",
        strip_prefix = "python",
        sub_targets = {
            "include": ["include/python3.13"],
            "lib": ["lib"],
            "python": ["bin/python"],
        },
    )
    native.command_alias(
        name = "cpython",
        exe = ":cpython_archive[python]",
        resources = [":cpython_archive"],
        visibility = visibility,
    )
    python_bootstrap_toolchain(
        name = "{}_bootstrap".format(name),
        interpreter = ":cpython",
        visibility = visibility,
    )
    native.genrule(
        name = "libpython_symbols",
        out = "linker_args",
        cmd = '$(exe_target prelude//python/tools:gather_libpython_symbols) "$OUT"',
    )
    python_toolchain(
        name = name,
        interpreter = ":cpython",
        extension_linker_flags = [
            "-L$(location :cpython_archive[lib])",
            "@$(location :libpython_symbols)",
        ],
        visibility = visibility,
    )
