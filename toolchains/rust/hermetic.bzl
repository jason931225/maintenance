# The Rust toolchain buck2 compiles with: every binary an artifact, nothing on PATH.
#
# `system_rust_toolchain` hardcodes `compiler = RunInfo(args = ["rustc"])`, so the
# compiler was resolved from PATH at execution time and appeared in no action
# digest. This points every tool at the assembled sysroot instead, which makes
# the compiler part of each action's input tree -- so a different compiler is a
# different action, and the cache misses rather than serving an rlib this rustc
# cannot link (#1083).
#
# rustc finds its own sysroot from its binary path, so no `--sysroot` flag is
# needed and none is passed; adding one would be a second statement of a fact
# the layout already carries.

load("@prelude//rust:rust_toolchain.bzl", "PanicRuntime", "RustToolchainInfo")

def _hermetic_rust_toolchain_impl(ctx):
    sysroot = ctx.attrs.sysroot[DefaultInfo].default_outputs[0]

    def tool(name):
        return RunInfo(args = [sysroot.project("bin/{}".format(name))])

    return [
        DefaultInfo(),
        RustToolchainInfo(
            allow_lints = ctx.attrs.allow_lints,
            clippy_driver = tool("clippy-driver"),
            clippy_toml = ctx.attrs.clippy_toml[DefaultInfo].default_outputs[0] if ctx.attrs.clippy_toml else None,
            compiler = tool("rustc"),
            default_edition = ctx.attrs.default_edition,
            panic_runtime = PanicRuntime("unwind"),
            deny_lints = ctx.attrs.deny_lints,
            doctests = ctx.attrs.doctests,
            nightly_features = ctx.attrs.nightly_features,
            report_unused_deps = ctx.attrs.report_unused_deps,
            rustc_binary_flags = ctx.attrs.rustc_binary_flags,
            rustc_flags = ctx.attrs.rustc_flags,
            rustc_target_triple = ctx.attrs.rustc_target_triple,
            rustc_test_flags = ctx.attrs.rustc_test_flags,
            rustdoc = tool("rustdoc"),
            rustdoc_flags = ctx.attrs.rustdoc_flags,
            warn_lints = ctx.attrs.warn_lints,
        ),
    ]

hermetic_rust_toolchain = rule(
    impl = _hermetic_rust_toolchain_impl,
    attrs = {
        "allow_lints": attrs.list(attrs.string(), default = []),
        "clippy_toml": attrs.option(attrs.dep(providers = [DefaultInfo]), default = None),
        "default_edition": attrs.option(attrs.string(), default = None),
        "deny_lints": attrs.list(attrs.string(), default = []),
        "doctests": attrs.bool(default = False),
        # The prelude defaults this False and the `system_rust_toolchain` call
        # this replaced never passed it. Defaulting True would silently permit
        # unstable features graph-wide and break a rollback to stable.
        "nightly_features": attrs.bool(default = False),
        "report_unused_deps": attrs.bool(default = False),
        "rustc_binary_flags": attrs.list(attrs.arg(), default = []),
        "rustc_flags": attrs.list(attrs.arg(), default = []),
        "rustc_target_triple": attrs.string(),
        "rustc_test_flags": attrs.list(attrs.arg(), default = []),
        "rustdoc_flags": attrs.list(attrs.arg(), default = []),
        # Selected per host: the sysroot for the machine running the action.
        "sysroot": attrs.dep(providers = [DefaultInfo]),
        "warn_lints": attrs.list(attrs.string(), default = []),
    },
    is_toolchain_rule = True,
)
