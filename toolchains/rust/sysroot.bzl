# Overlay rust-std into rustc's tree to make a usable sysroot.
#
# The two dist tarballs are deliberately separate upstream: `rustc` carries the
# compiler and its own rustlib, `rust-std` carries the standard library for one
# target triple. rustc finds std under <sysroot>/lib/rustlib/<triple>, so a
# sysroot is the union of the two. Assembling it as a build ARTIFACT -- rather
# than installing it somewhere and pointing a flag at a path -- is what puts the
# compiler and the library inside the action's input tree, and therefore inside
# the action digest. That is the whole point: a different compiler is then a
# different action, so the cache misses instead of serving an unlinkable rlib.

def _rust_sysroot_impl(ctx):
    out = ctx.actions.declare_output("sysroot", dir = True)

    # `cp -a`, not buck2's copied_dir: the rustc tree contains symlinks that
    # dangle until the tree is whole (lib/rustlib/<triple>/bin/gcc-ld/ld.lld
    # points at rust-lld), and copied_dir dereferences them, so it fails on a
    # tarball that is perfectly valid. -a preserves links as links.
    script = ctx.actions.write(
        "assemble.sh",
        [
            "#!/usr/bin/env bash",
            "set -euo pipefail",
            'out="$1"; shift',
            'rustc_dir="$1"; shift',
            'rm -rf "$out"; mkdir -p "$out"',
            'cp -a "$rustc_dir"/. "$out"/',
            'mkdir -p "$out/lib/rustlib"',
            '# Each remaining argument is a rust-std tree for one target triple.',
            'for std in "$@"; do cp -a "$std"/lib/rustlib/. "$out"/lib/rustlib/; done',
        ],
        is_executable = True,
    )

    ctx.actions.run(
        cmd_args(
            script,
            out.as_output(),
            ctx.attrs.rustc[DefaultInfo].default_outputs[0],
            [std[DefaultInfo].default_outputs[0] for std in ctx.attrs.stds],
        ),
        category = "rust_sysroot",
        identifier = ctx.attrs.triple,
        # Assembling ~1 GB of symlinks is cheaper locally than shipping the
        # result to a remote executor and back; the INPUTS are still content-
        # addressed, which is what the digest cares about.
        local_only = True,
    )
    return [DefaultInfo(default_output = out)]

rust_sysroot = rule(
    impl = _rust_sysroot_impl,
    attrs = {
        "rustc": attrs.dep(providers = [DefaultInfo]),
        "stds": attrs.list(attrs.dep(providers = [DefaultInfo])),
        "triple": attrs.string(),
    },
)
