def required_toolchain_config(key, display_name):
    value = read_root_config("toolchain", key, "")
    if not value:
        fail("missing required root configuration {}; use tools/buck/bootstrap/buck2w".format(display_name))
    return value
