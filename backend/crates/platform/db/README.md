# mnt-platform-db

Postgres schema migrations (SQLx) and the `with_audit` transactional helper.

## Local setup

```sh
# Start Homebrew PostgreSQL 16
brew services start postgresql@16

# Create the development database (first time only)
createdb mnt_dev

# Run the admitted Buck2 migration identity/runtime sentinel from the repo root.
# Buck2 injects DATABASE_URL into the test executor; an outer shell variable is
# intentionally not treated as evidence.
tools/buck/bootstrap/buck2w test \
  //backend/crates/platform/db:mnt-platform-db-buck2-period-lock-contract \
  -- --env DATABASE_URL=postgres://localhost/mnt_dev
```

## Offline query cache

The `query!` macros are checked at compile time. The committed `.sqlx/`
directory in the workspace root is the offline cache used by CI
(`SQLX_OFFLINE=true`).

**Regenerate after any schema or query change:**

```sh
DATABASE_URL=postgres://localhost/mnt_dev cargo sqlx prepare --workspace
```

Then commit the updated `.sqlx/` directory. CI will fail with a clear error
if the cache is stale. This Cargo subcommand is a source-generation maintenance
operation only; it is not backend build/test completion evidence. Buck2 is the
sole Rust query/build/test authority.

## Migrations

| File | Contents |
|------|----------|
| `0001_create_regions_branches.sql` | Starts the canonical chain with `regions` and `branches`. |
| `0026_create_organizations.sql` | Introduces the canonical organization relation used by tenant-scoped tests. |
| `0164_bind_consume_four_eyes.sql` | Current ordered head of the 164-file append-only chain. |

Buck2 stages these exact production SQL bytes at the manifest-relative
`backend/crates/platform/db/migrations` path through
`with_canonical_sqlx_migrations`; consumers must not remap the directory or
create a nested `migrations/migrations` tree. The admitted platform-DB sentinel
binds every ordered filename and SHA-256 identity, checks SQLx's embedded
checksums, applies the chain, and asserts the 164 successful migration rows.

## Append-only invariant

`audit_events` enforces immutability at two independent layers:

1. `REVOKE UPDATE, DELETE ON audit_events FROM PUBLIC` (permission layer).
2. `BEFORE` triggers on `UPDATE` and `DELETE` that raise an exception
   (defense-in-depth — fires even for privileged roles).

The `#[sqlx::test]` suite asserts both layers independently.
