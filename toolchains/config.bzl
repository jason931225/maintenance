def required_toolchain_config(key, display_name):
    value = read_root_config("toolchain", key, "")
    if not value:
        fail("missing required root configuration {}; use tools/buck/bootstrap/buck2w".format(display_name))
    return value


def authenticated_loopback_artifact_url(key, display_name, filename):
    """Accept only a wrapper-owned exact loopback route for one artifact."""
    value = required_toolchain_config(key, display_name)
    prefix = "http://127.0.0.1:"
    authority_and_path = value[len(prefix):] if value.startswith(prefix) else ""
    parts = authority_and_path.split("/")
    port = parts[0] if len(parts) == 2 else ""
    non_digits = port
    for digit in ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]:
        non_digits = non_digits.replace(digit, "")
    invalid_port = (
        not port or
        non_digits or
        port.startswith("0") or
        len(port) > 5 or
        (len(port) == 5 and port > "65535")
    )
    if invalid_port or len(parts) != 2 or parts[1] != filename:
        fail("{} must be the exact authenticated loopback route from tools/buck/bootstrap/buck2w".format(display_name))
    return value


def authenticated_crate_archive_base_url(expected_lock_sha256):
    """Return only the wrapper's lock-bound loopback crate mirror."""
    value = required_toolchain_config(
        "crate_archive_base_url",
        "toolchain.crate_archive_base_url",
    )
    prefix = "http://127.0.0.1:"
    port = value[len(prefix):] if value.startswith(prefix) else ""
    non_digits = port
    for digit in ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]:
        non_digits = non_digits.replace(digit, "")
    invalid_port = (
        not port or
        non_digits or
        port.startswith("0") or
        len(port) > 5 or
        (len(port) == 5 and port > "65535")
    )
    if invalid_port:
        fail("toolchain.crate_archive_base_url must be the authenticated loopback mirror from tools/buck/bootstrap/buck2w")
    lock_sha256 = required_toolchain_config(
        "crate_lock_sha256",
        "toolchain.crate_lock_sha256",
    )
    if lock_sha256 != expected_lock_sha256:
        fail("toolchain.crate_lock_sha256 does not match backend/Cargo.lock")
    return value
