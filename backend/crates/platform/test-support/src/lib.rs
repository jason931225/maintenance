//! Integration-test-only helpers shared by REST-crate test suites.
//!
//! `#[sqlx::test]` hands tests a pool connected as the migration/owner role,
//! which has BYPASSRLS. Building the router straight off that pool means the
//! request path never actually exercises row-level security, so a broken
//! policy can pass green. Route requests through [`runtime_role_pool`]
//! instead; keep seeding on the original owner pool.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use mnt_kernel_core::{BranchId, OrgId, UserId};
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

/// Seed a region + branch under `OrgId::knl()`. `region_name`/`branch_name`
/// are used as label prefixes; a random UUID suffix keeps names unique
/// across concurrent test runs.
pub async fn seed_branch(pool: &PgPool, region_name: &str, branch_name: &str) -> BranchId {
    let region_id: uuid::Uuid =
        sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ($1, $2) RETURNING id")
            .bind(format!("{region_name}-{}", uuid::Uuid::new_v4()))
            .bind(*OrgId::knl().as_uuid())
            .fetch_one(pool)
            .await
            .unwrap();
    let branch_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(region_id)
    .bind(format!("{branch_name}-{}", uuid::Uuid::new_v4()))
    .bind(*OrgId::knl().as_uuid())
    .fetch_one(pool)
    .await
    .unwrap();
    BranchId::from_uuid(branch_id)
}

/// Seed a user with `role`, assigned to `branch`, under `OrgId::knl()`.
pub async fn seed_user(pool: &PgPool, name: &str, role: &str, branch: BranchId) -> UserId {
    let id = UserId::new();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
        .bind(*id.as_uuid())
        .bind(name)
        .bind(Vec::from([role]))
        .bind(*OrgId::knl().as_uuid())
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)")
        .bind(*id.as_uuid())
        .bind(*branch.as_uuid())
        .bind(*OrgId::knl().as_uuid())
        .execute(pool)
        .await
        .unwrap();
    id
}
