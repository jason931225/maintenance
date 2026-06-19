#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! THE RUNTIME GATE for the bare-pool READ fix (multi-tenant phase 1).
//!
//! Phase 1 wrapped ~31 previously-bare-pool reads in `with_org_conn(current_org()?, ..)`
//! so `app.current_org` is armed for the RLS-gated query. A *static* gate
//! (`mnt-gate-rls-arming`) proves the wrapping is STRUCTURALLY present in the
//! source. This test proves it WORKS AT RUNTIME: that `current_org()` / the GUC
//! is actually armed when these reads execute as the genuine non-owner runtime
//! role `mnt_rt` (NOSUPERUSER, NOBYPASSRLS, FORCE RLS).
//!
//! The bug class it guards against: a read that runs on the BARE pool (no
//! `with_org_conn`, so `app.current_org` is UNSET) returns ZERO rows under
//! `mnt_rt` — yet the legacy tests passed because `sqlx::test` connects as a
//! BYPASSRLS superuser, which sees every row regardless of the GUC and masks the
//! defect entirely.
//!
//! Strategy (faithful runtime exercise, store/adapter layer):
//!   * SEED as the OWNER (superuser) pool. Raw inserts bypass RLS; the wrapped
//!     writes (`create_work_order`, `create_thread`) run inside
//!     `scope_org(OrgId::knl(), ..)` so they arm the GUC exactly as the org
//!     middleware does in production.
//!   * READ as `mnt_rt` (a second pool whose every connection does `SET ROLE
//!     mnt_rt`, copied verbatim from the auth-chain harness) by calling the SAME
//!     wrapped store read functions the GET handlers call, inside
//!     `scope_org(OrgId::knl(), ..)`. Those functions do `current_org()?` ->
//!     `with_org_conn(..)`, so if the arming chain is intact the rows come back;
//!     if it were bare-pool, RLS would return zero.
//!
//! Surfaces proven (highest value):
//!   (1) WORK-ORDER DETAIL  — `PgWorkOrderStore::work_order(id)` returns the
//!       seeded KNL work order (non-empty) as `mnt_rt`.
//!   (2) MESSENGER THREAD LIST — `PgMessengerStore::list_threads(..)` returns the
//!       seeded KNL thread (non-empty) as `mnt_rt`.
//!   (3) CROSS-TENANT ISOLATION — a second org's work order is NOT visible while
//!       KNL's org is armed (RLS still isolates tenants under the fix).

use mnt_kernel_core::{BranchId, BranchScope, OrgId, TraceContext, UserId};
use mnt_messenger_adapter_postgres::PgMessengerStore;
use mnt_messenger_application::{CreateThreadCommand, ListThreadsQuery};
use mnt_messenger_domain::ThreadKind;
use mnt_workorder_adapter_postgres::PgWorkOrderStore;
use mnt_workorder_application::{CreateWorkOrderCommand, WorkOrderSummary};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use time::OffsetDateTime;
use uuid::Uuid;

/// A second, non-KNL tenant id, to prove cross-tenant isolation under `mnt_rt`.
const ORG_T2: Uuid = Uuid::from_u128(0x2222_2222_2222_2222_2222_2222_2222_2222);

// ===========================================================================
// Runtime-role pool: every connection becomes the genuine non-owner `mnt_rt`.
// Copied verbatim from the auth-chain harness
// (provisioning/tests/rls_auth_chain_as_runtime_role.rs) so RLS is ACTUALLY
// enforced — BYPASSRLS does not apply, FORCE RLS does — exactly as production.
// ===========================================================================
async fn runtime_role_pool(owner_pool: &PgPool) -> PgPool {
    let options = owner_pool.connect_options().as_ref().clone();
    PgPoolOptions::new()
        .max_connections(4)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                // SET ROLE (session-scoped) makes every subsequent statement on
                // this connection run as `mnt_rt`. The connection started as the
                // superuser, so it has the privilege to assume the role.
                sqlx::query("SET ROLE mnt_rt").execute(conn).await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .unwrap()
}

// ===========================================================================
// Seeding (OWNER pool). Raw inserts bypass RLS as superuser; org_id columns are
// set explicitly so each row lands in the intended tenant.
// ===========================================================================

/// Ensure an `organizations` row exists for `org` (FK target for everything).
async fn seed_org(owner_pool: &PgPool, org: Uuid, tag: &str) {
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING")
        .bind(org)
        .bind(format!("org-{}", tag.to_lowercase()))
        .bind(format!("Org {tag}"))
        .execute(owner_pool)
        .await
        .unwrap();
}

/// Seed a region + branch in `org`, returning the branch id.
async fn seed_branch(owner_pool: &PgPool, org: Uuid) -> BranchId {
    let region_id: Uuid =
        sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ($1, $2) RETURNING id")
            .bind(format!("Region {}", Uuid::new_v4()))
            .bind(org)
            .fetch_one(owner_pool)
            .await
            .unwrap();
    let branch_id: Uuid = sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(region_id)
    .bind(format!("Branch {}", Uuid::new_v4()))
    .bind(org)
    .fetch_one(owner_pool)
    .await
    .unwrap();
    BranchId::from_uuid(branch_id)
}

/// Seed a user with `role` in `org`, attached to `branch_id`.
async fn seed_user(owner_pool: &PgPool, org: Uuid, role: &str, branch_id: BranchId) -> UserId {
    let user_id = UserId::new();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
        .bind(*user_id.as_uuid())
        .bind(format!("User {}", Uuid::new_v4()))
        .bind(Vec::from([role]))
        .bind(org)
        .execute(owner_pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)")
        .bind(*user_id.as_uuid())
        .bind(*branch_id.as_uuid())
        .bind(org)
        .execute(owner_pool)
        .await
        .unwrap();
    user_id
}

/// A unique `equipment_no` matching the `^[A-Z]{3}[A-Z0-9]{2}-[0-9]{4}$` check
/// constraint (0007_create_registry.sql). The 4-digit suffix is derived from a
/// fresh UUID so concurrent `sqlx::test` databases never collide.
fn unique_equipment_no() -> String {
    let n = Uuid::new_v4().as_u128() % 10_000;
    format!("ABC12-{n:04}")
}

/// Seed a customer + site + one piece of equipment in `org`/`branch_id` with the
/// given `management_no` (the work-order create resolves equipment by it).
async fn seed_equipment(owner_pool: &PgPool, org: Uuid, branch_id: BranchId, management_no: &str) {
    let customer_id: Uuid = sqlx::query_scalar(
        "INSERT INTO registry_customers (branch_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(*branch_id.as_uuid())
    .bind(format!("Customer {}", Uuid::new_v4()))
    .bind(org)
    .fetch_one(owner_pool)
    .await
    .unwrap();
    let site_id: Uuid = sqlx::query_scalar(
        "INSERT INTO registry_sites (branch_id, customer_id, name, org_id) VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(*branch_id.as_uuid())
    .bind(customer_id)
    .bind(format!("Site {}", Uuid::new_v4()))
    .bind(org)
    .fetch_one(owner_pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        INSERT INTO registry_equipment (
            branch_id, customer_id, site_id, equipment_no, management_no,
            manufacturer_code, kind_code, power_code, status,
            specification, ton_text, model, source_sheet, source_row, org_id
        )
        VALUES ($1, $2, $3, $4, $5,
                'A', 'B', 'C', '임대', '좌식', '2.5', 'GTS25DE', 'test', 1, $6)
        "#,
    )
    .bind(*branch_id.as_uuid())
    .bind(customer_id)
    .bind(site_id)
    .bind(unique_equipment_no())
    .bind(management_no)
    .bind(org)
    .execute(owner_pool)
    .await
    .unwrap();
}

/// Seed a complete work order in `org` and return its summary. The CREATE is a
/// wrapped write, so it runs inside `scope_org(org, ..)` to arm the GUC exactly
/// as the org middleware would. Returns the created work order (its id is the
/// detail-read key).
async fn seed_work_order(owner_pool: &PgPool, org: OrgId) -> (BranchId, WorkOrderSummary) {
    let org_uuid = *org.as_uuid();
    seed_org(owner_pool, org_uuid, "seed").await;
    let branch_id = seed_branch(owner_pool, org_uuid).await;
    let receptionist = seed_user(owner_pool, org_uuid, "RECEPTIONIST", branch_id).await;
    let management_no = "290";
    seed_equipment(owner_pool, org_uuid, branch_id, management_no).await;

    // The CREATE handler arms the GUC; mirror that with scope_org on the owner pool.
    let summary = mnt_platform_request_context::scope_org(org, async {
        let store = PgWorkOrderStore::new(owner_pool.clone());
        store
            .create_work_order(CreateWorkOrderCommand {
                actor: receptionist,
                branch_id,
                management_no: management_no.to_owned(),
                symptom: "Hydraulic oil leak".to_owned(),
                customer_request: None,
                target_due_at: None,
                trace: TraceContext::generate(),
                occurred_at: OffsetDateTime::now_utc(),
            })
            .await
            .expect("seed: create_work_order must succeed under armed owner pool")
    })
    .await;

    (branch_id, summary)
}

// ===========================================================================
// (1) WORK-ORDER DETAIL must return the seeded KNL work order AS `mnt_rt`.
// This is the headline read the GET /api/work-orders/{id} detail path performs
// (`current_org()?` -> `with_org_conn`). Before the fix it returned zero rows.
// ===========================================================================
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn work_order_detail_returns_tenant_row_as_runtime_role(owner_pool: PgPool) {
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let knl = OrgId::knl();
    let (_branch, seeded) = seed_work_order(&owner_pool, knl).await;

    // Read through the REAL wrapped store function, with the org armed exactly as
    // the middleware arms it, but as the genuine non-owner `mnt_rt` role.
    let found = mnt_platform_request_context::scope_org(knl, async {
        let store = PgWorkOrderStore::new(rt_pool.clone());
        store.work_order(seeded.id).await
    })
    .await
    .expect("work-order detail must return the seeded KNL row as mnt_rt (GUC armed)");

    assert_eq!(
        found.id, seeded.id,
        "the wrapped detail read must surface the seeded work order as mnt_rt"
    );
}

// ===========================================================================
// (2) MESSENGER THREAD LIST must return the seeded KNL thread AS `mnt_rt`.
// `list_threads` is a multi-row wrapped read; before the fix the bare-pool list
// returned zero rows under `mnt_rt`.
// ===========================================================================
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn messenger_thread_list_returns_tenant_rows_as_runtime_role(owner_pool: PgPool) {
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let knl = OrgId::knl();
    let knl_uuid = *knl.as_uuid();

    seed_org(&owner_pool, knl_uuid, "knl").await;
    let branch = seed_branch(&owner_pool, knl_uuid).await;
    let sender = seed_user(&owner_pool, knl_uuid, "MECHANIC", branch).await;
    let recipient = seed_user(&owner_pool, knl_uuid, "ADMIN", branch).await;

    // Create the thread (a wrapped write) under the armed owner pool.
    mnt_platform_request_context::scope_org(knl, async {
        let store = PgMessengerStore::new(owner_pool.clone());
        store
            .create_thread(CreateThreadCommand {
                actor: sender,
                branch_scope: BranchScope::single(branch),
                branch_id: branch,
                kind: ThreadKind::Team,
                title: Some("정비팀".to_owned()),
                work_order_id: None,
                member_ids: vec![sender, recipient],
                trace: TraceContext::generate(),
                occurred_at: OffsetDateTime::now_utc(),
            })
            .await
            .expect("seed: create_thread must succeed under armed owner pool");
    })
    .await;

    // List threads through the REAL wrapped read as `mnt_rt`.
    let threads = mnt_platform_request_context::scope_org(knl, async {
        let store = PgMessengerStore::new(rt_pool.clone());
        store
            .list_threads(ListThreadsQuery {
                actor: sender,
                branch_scope: BranchScope::single(branch),
                limit: 50,
            })
            .await
    })
    .await
    .expect("messenger thread list must succeed as mnt_rt (GUC armed)");

    assert!(
        !threads.is_empty(),
        "the wrapped thread list must surface the seeded KNL thread as mnt_rt"
    );
}

// ===========================================================================
// (3) CROSS-TENANT ISOLATION: a SECOND org's work order must NOT be visible
// while KNL's org is armed. Proves the fix arms the RIGHT tenant (not a blanket
// "see everything") — RLS still isolates tenants under `mnt_rt`.
// ===========================================================================
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn cross_tenant_work_order_is_invisible_as_runtime_role(owner_pool: PgPool) {
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let knl = OrgId::knl();
    let org2 = OrgId::from_uuid(ORG_T2);

    // Seed one work order in each tenant.
    let (_knl_branch, knl_wo) = seed_work_order(&owner_pool, knl).await;
    let (_t2_branch, t2_wo) = seed_work_order(&owner_pool, org2).await;

    // Under KNL's armed GUC, KNL's work order is visible...
    let knl_visible = mnt_platform_request_context::scope_org(knl, async {
        let store = PgWorkOrderStore::new(rt_pool.clone());
        store.work_order(knl_wo.id).await
    })
    .await;
    assert!(
        knl_visible.is_ok(),
        "KNL work order must be visible under KNL's armed GUC as mnt_rt"
    );

    // ...but the OTHER tenant's work order is NOT (RLS returns not-found).
    let t2_under_knl = mnt_platform_request_context::scope_org(knl, async {
        let store = PgWorkOrderStore::new(rt_pool.clone());
        store.work_order(t2_wo.id).await
    })
    .await;
    assert!(
        t2_under_knl.is_err(),
        "a second tenant's work order must be INVISIBLE under KNL's GUC as mnt_rt \
         (cross-tenant isolation must hold)"
    );
}
