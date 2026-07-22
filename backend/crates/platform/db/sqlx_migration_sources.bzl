"""Canonical Buck staging for the SQLx migration directory.

The ``sqlx-migrations`` filegroup emits a directory whose first member is
``migrations``. Mapping that artifact at the platform-db package directory
preserves the source-tree path exactly; mapping it at the migrations directory
would create an invalid ``migrations/migrations`` layout.
"""

_CANONICAL_SQLX_MIGRATION_TARGET = "//backend/crates/platform/db:sqlx-migrations"
_CANONICAL_SQLX_MIGRATION_DESTINATION = "backend/crates/platform/db"


def with_canonical_sqlx_migrations(mapped_srcs):
    """Return mapped_srcs with the one canonical migration artifact map."""
    result = dict(mapped_srcs)
    if _CANONICAL_SQLX_MIGRATION_TARGET in result:
        fail("canonical SQLx migrations must be added only by this helper")
    result[_CANONICAL_SQLX_MIGRATION_TARGET] = _CANONICAL_SQLX_MIGRATION_DESTINATION
    return result
