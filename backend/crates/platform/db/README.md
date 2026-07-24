# mnt-platform-db

Postgres schema migrations (SQLx) and the `with_audit` transactional helper.

## Local setup

```sh
# Start Homebrew PostgreSQL 18
brew services start postgresql@18

# Create the development database (first time only)
createdb mnt_dev
```

Migration `0165` and later depend on cluster-global application roles. Before
running the full SQLx or Buck2 database tests against a manually managed
cluster, reconcile those roles with `ops/postgres-reconcile-topology.sh` and
the required environment documented in `ops/README.md`. Alternatively, use the
repository dev stack:

```sh
npm run dev:up
```

The dev stack starts the pinned PostgreSQL 18 image and runs the one-shot
`postgres-topology` reconciler before applying migrations.

Pass an explicit database user to Buck2. A URL such as
`postgres://127.0.0.1/mnt_dev` is not sufficient because the test executes in a
sandbox and must not infer the host-shell user.

```sh
# Homebrew PostgreSQL started above:
DATABASE_URL="postgres://$(id -un)@127.0.0.1:5432/mnt_dev"

# With the repository dev stack's unmodified defaults, use its explicit
# cluster administrator and published PostgreSQL port instead:
# DATABASE_URL="postgres://mnt_cluster_admin:mnt-dev-admin-change-me@127.0.0.1:55432/mnt_dev"

# Run the admitted Buck2 migration identity/runtime sentinel from the repo root.
# Buck2 injects DATABASE_URL into the test executor; an outer shell variable is
# intentionally not treated as evidence.
tools/buck/bootstrap/buck2w test \
  //backend/crates/platform/db:mnt-platform-db-buck2-period-lock-contract \
  -- --env DATABASE_URL="$DATABASE_URL"
```

The selected user must be able to create the temporary databases used by
`#[sqlx::test]`. The reconciled `mnt_app` migration owner intentionally does not
have `CREATEDB`; use the distinct cluster administrator for the full test suite.

## Offline query cache

The `query!` macros are checked at compile time. The committed `.sqlx/`
directory in the workspace root is the offline cache used by CI
(`SQLX_OFFLINE=true`).

**Regenerate after any schema or query change:**

```sh
cd backend
DATABASE_URL="postgres://$(id -un)@127.0.0.1:5432/mnt_dev" \
  cargo sqlx prepare --workspace
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
| `0165_ontology_object_type_key_revisions.sql` | Requires the reconciled cluster-global application-role topology before the migration chain runs. |
| `0168_runtime_public_schema_usage.sql` | Current ordered head of the 168-file append-only chain; grants `mnt_rt` schema `USAGE` while rejecting `CREATE`. |

Buck2 stages these exact production SQL bytes at the manifest-relative
`backend/crates/platform/db/migrations` path through
`with_canonical_sqlx_migrations`; consumers must not remap the directory or
create a nested `migrations/migrations` tree. The admitted platform-DB sentinel
binds every ordered filename and SHA-256 identity, checks SQLx's embedded
checksums, applies the chain, and asserts the 168 successful migration rows.
Migration `0168` also fails closed unless `mnt_rt` can traverse the `public`
schema without being able to create objects in it.

## Append-only invariant

`audit_events` enforces immutability at two independent layers:

1. `REVOKE UPDATE, DELETE ON audit_events FROM PUBLIC` (permission layer).
2. `BEFORE` triggers on `UPDATE` and `DELETE` that raise an exception
   (defense-in-depth — fires even for privileged roles).

The `#[sqlx::test]` suite asserts both layers independently.
