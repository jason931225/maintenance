#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Acceptance gate for multi-tenant phase 1: Postgres RLS proves end-to-end
//! tenant isolation on the vertical slice (organizations → regions → branches →
//! users → registry → work_orders).
//!
//! ## Why the test switches role
//! RLS policies are only enforced for roles that are NOT superusers and do NOT
//! carry BYPASSRLS. `sqlx::test` connects as the database owner/superuser, which
//! bypasses RLS entirely — so every tenant-scoped statement runs inside a
//! transaction that first does `SET LOCAL ROLE mnt_app` (the unprivileged
//! runtime role created in migration 0026) and then arms the
//! `app.current_org` GUC. That mirrors production, where the app connects as
//! `mnt_app`. `FORCE ROW LEVEL SECURITY` (migration 0030) additionally subjects
//! the table owner to the policies, closing the owner-bypass hole.
//!
//! ## What it asserts (definition of done)
//!  1. GUC = A  → SELECT returns ONLY org A's rows (B invisible).
//!  2. GUC = B  → SELECT returns ONLY org B's rows (A invisible).
//!  3. GUC unset → ZERO rows (fail-closed).
//!  4. GUC = A, INSERT with org_id = B → rejected by the WITH CHECK policy.

use mnt_kernel_core::OrgId;
use mnt_platform_db::{with_org_conn, DbError};
use sqlx::{PgPool, Row};
use uuid::Uuid;

const ORG_A: Uuid = Uuid::from_u128(0x1111_1111_1111_1111_1111_1111_1111_1111);
const ORG_B: Uuid = Uuid::from_u128(0x2222_2222_2222_2222_2222_2222_2222_2222);

/// Seed one org plus a full slice (region → branch → user → customer → site →
/// equipment → work_order) as the unprivileged `mnt_app` role with the tenant
/// GUC armed, so the rows pass the WITH CHECK policy on the way in.
async fn seed_org(pool: &PgPool, org: Uuid, tag: &str) {
    // organizations is itself RLS-protected: its policy gates on `id`, so arm
    // the GUC to the org we are inserting.
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL ROLE mnt_app").execute(&mut *tx).await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();

    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)")
        .bind(org)
        .bind(format!("org-{}", tag.to_lowercase()))
        .bind(format!("Org {tag}"))
        .execute(&mut *tx)
        .await
        .unwrap();

    let region = Uuid::new_v4();
    sqlx::query("INSERT INTO regions (id, name, org_id) VALUES ($1, $2, $3)")
        .bind(region)
        .bind(format!("Region {tag}"))
        .bind(org)
        .execute(&mut *tx)
        .await
        .unwrap();

    let branch = Uuid::new_v4();
    sqlx::query("INSERT INTO branches (id, region_id, name, org_id) VALUES ($1, $2, $3, $4)")
        .bind(branch)
        .bind(region)
        .bind(format!("Branch {tag}"))
        .bind(org)
        .execute(&mut *tx)
        .await
        .unwrap();

    let user = Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
        .bind(user)
        .bind(format!("User {tag}"))
        .bind(vec!["MECHANIC".to_string()])
        .bind(org)
        .execute(&mut *tx)
        .await
        .unwrap();

    let customer = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO registry_customers (id, branch_id, name, org_id) VALUES ($1, $2, $3, $4)",
    )
    .bind(customer)
    .bind(branch)
    .bind(format!("Customer {tag}"))
    .bind(org)
    .execute(&mut *tx)
    .await
    .unwrap();

    let site = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO registry_sites (id, branch_id, customer_id, name, org_id) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(site)
    .bind(branch)
    .bind(customer)
    .bind(format!("Site {tag}"))
    .bind(org)
    .execute(&mut *tx)
    .await
    .unwrap();

    let equipment = Uuid::new_v4();
    // equipment_no is intentionally IDENTICAL across orgs to prove the unique
    // key is now per-org, not global.
    sqlx::query(
        "INSERT INTO registry_equipment \
            (id, branch_id, customer_id, site_id, equipment_no, manufacturer_code, \
             kind_code, power_code, status, specification, ton_text, source_sheet, \
             source_row, org_id) \
         VALUES ($1, $2, $3, $4, 'ABC01-0001', 'M', 'K', 'P', '임대', 'spec', '1t', 's', 1, $5)",
    )
    .bind(equipment)
    .bind(branch)
    .bind(customer)
    .bind(site)
    .bind(org)
    .execute(&mut *tx)
    .await
    .unwrap();

    let work_order = Uuid::new_v4();
    // request_no is also identical across orgs — same per-org-unique proof.
    sqlx::query(
        "INSERT INTO work_orders \
            (id, request_no, branch_id, equipment_id, customer_id, site_id, \
             requested_by, status, symptom, org_id) \
         VALUES ($1, '20260618-001', $2, $3, $4, $5, $6, 'RECEIVED', 'sym', $7)",
    )
    .bind(work_order)
    .bind(branch)
    .bind(equipment)
    .bind(customer)
    .bind(site)
    .bind(user)
    .bind(org)
    .execute(&mut *tx)
    .await
    .unwrap();

    tx.commit().await.unwrap();
}

/// Run a `SELECT count(*)` (passed as a static, injection-safe literal) as
/// `mnt_app` with the tenant GUC set to `org` (or left unset when `org` is
/// `None`, to exercise the fail-closed path).
async fn count_as_app(pool: &PgPool, org: Option<Uuid>, count_query: &'static str) -> i64 {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL ROLE mnt_app").execute(&mut *tx).await.unwrap();
    if let Some(org) = org {
        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(org.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    let count: i64 = sqlx::query_scalar(count_query)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    count
}

const COUNT_WORK_ORDERS: &str = "SELECT count(*) FROM work_orders";
const COUNT_EQUIPMENT: &str = "SELECT count(*) FROM registry_equipment";

#[sqlx::test(migrations = "./migrations")]
async fn rls_isolates_two_tenants_and_fails_closed(pool: PgPool) {
    seed_org(&pool, ORG_A, "A").await;
    seed_org(&pool, ORG_B, "B").await;

    // (1) GUC = A → only A's single row per table is visible.
    assert_eq!(
        count_as_app(&pool, Some(ORG_A), COUNT_WORK_ORDERS).await,
        1,
        "org A must see exactly its own work_order"
    );
    assert_eq!(
        count_as_app(&pool, Some(ORG_A), COUNT_EQUIPMENT).await,
        1,
        "org A must see exactly its own equipment"
    );

    // (2) GUC = B → only B's single row per table is visible.
    assert_eq!(
        count_as_app(&pool, Some(ORG_B), COUNT_WORK_ORDERS).await,
        1,
        "org B must see exactly its own work_order"
    );
    assert_eq!(
        count_as_app(&pool, Some(ORG_B), COUNT_EQUIPMENT).await,
        1,
        "org B must see exactly its own equipment"
    );

    // (3) GUC unset → ZERO rows everywhere (fail-closed).
    assert_eq!(
        count_as_app(&pool, None, COUNT_WORK_ORDERS).await,
        0,
        "unset GUC must reveal ZERO work_orders (fail-closed)"
    );
    assert_eq!(
        count_as_app(&pool, None, COUNT_EQUIPMENT).await,
        0,
        "unset GUC must reveal ZERO equipment (fail-closed)"
    );

    // (4) GUC = A, INSERT a row tagged org B → rejected by WITH CHECK.
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL ROLE mnt_app").execute(&mut *tx).await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(ORG_A.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let cross_tenant_write = sqlx::query(
        "INSERT INTO regions (name, org_id) VALUES ('smuggled', $1)",
    )
    .bind(ORG_B)
    .execute(&mut *tx)
    .await;
    assert!(
        cross_tenant_write.is_err(),
        "writing a row for org B while scoped to org A must be rejected by the WITH CHECK policy"
    );
    let err = cross_tenant_write.unwrap_err().to_string();
    assert!(
        err.contains("row-level security"),
        "rejection must come from the RLS policy, got: {err}"
    );
    // Transaction is now aborted; roll back to release it.
    let _ = tx.rollback().await;
}

/// Proves the `with_org_conn` propagation helper actually arms
/// `app.current_org` for the connection it hands to the closure. (It runs as the
/// superuser pool role here, so RLS does not *filter* — this asserts the GUC
/// value is set, which is the mechanism `with_audit` relies on.)
#[sqlx::test(migrations = "./migrations")]
async fn with_org_conn_sets_the_current_org_guc(pool: PgPool) {
    let org = OrgId::from_uuid(ORG_A);
    let seen: String = with_org_conn(&pool, org, |tx| {
        Box::pin(async move {
            let row = sqlx::query("SELECT current_setting('app.current_org', true) AS v")
                .fetch_one(tx.as_mut())
                .await
                .map_err(DbError::Sqlx)?;
            Ok::<String, DbError>(row.get::<Option<String>, _>("v").unwrap_or_default())
        })
    })
    .await
    .unwrap();

    assert_eq!(seen, ORG_A.to_string(), "with_org_conn must set app.current_org");
}
