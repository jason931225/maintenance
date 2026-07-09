//! Integration-test-only helpers shared by REST-crate test suites.
//!
//! `#[sqlx::test]` hands tests a pool connected as the migration/owner role,
//! which has BYPASSRLS. Building the router straight off that pool means the
//! request path never actually exercises row-level security, so a broken
//! policy can pass green. Route requests through [`runtime_role_pool`]
//! instead; keep seeding on the original owner pool.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;

/// A pool cloned from `owner_pool`'s connection settings, with every
/// connection switched to the low-privilege `mnt_rt` role via `SET ROLE`.
/// Build routers/stores from this pool so RLS applies to test requests.
pub async fn runtime_role_pool(owner_pool: &PgPool) -> PgPool {
    let options = owner_pool.connect_options().as_ref().clone();
    PgPoolOptions::new()
        .max_connections(4)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("SET ROLE mnt_rt").execute(conn).await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .expect("connect mnt_rt-role test pool")
}
