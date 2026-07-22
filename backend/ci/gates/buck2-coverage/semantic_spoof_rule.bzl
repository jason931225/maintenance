def _impl(_ctx):
    return [DefaultInfo()]


rust_library_spoof = rule(
    impl = _impl,
    attrs = {},
)
