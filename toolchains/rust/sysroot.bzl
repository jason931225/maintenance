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

    # `cp -a` preserves modes and any links rather than dereferencing them.
    #
    # An earlier revision justified this by claiming the rustc tree contains
    # symlinks that dangle until the tree is whole. Review measured it: there
    # are ZERO symlinks in either host's extracted rustc archive or in either
    # assembled sysroot, and gcc-ld/ld.lld is a regular file. The reason was
    # wrong even though the command is fine, so it is corrected rather than
    # left to mislead whoever edits this next.
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
            '# Remaining args are rust-std trees (merge their rustlib) and',
            '# component trees like clippy/rustfmt (merge their whole tree).',
            'for tree in "$@"; do',
            '  if [ -d "$tree/lib/rustlib" ] && [ ! -d "$tree/bin" ]; then',
            '    cp -a "$tree"/lib/rustlib/. "$out"/lib/rustlib/',
            '  else',
            '    cp -a "$tree"/. "$out"/',
            '  fi',
            'done',
        ],
        is_executable = True,
    )

    ctx.actions.run(
        cmd_args(
            script,
            out.as_output(),
            ctx.attrs.rustc[DefaultInfo].default_outputs[0],
            [dep[DefaultInfo].default_outputs[0] for dep in ctx.attrs.stds + ctx.attrs.components],
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
        # clippy-driver and rustfmt live in their own archives. Overlaid so the
        # sysroot's bin/ is the complete toolchain and nothing falls back to PATH.
        "components": attrs.list(attrs.dep(providers = [DefaultInfo]), default = []),
        "stds": attrs.list(attrs.dep(providers = [DefaultInfo])),
        "triple": attrs.string(),
    },
)
