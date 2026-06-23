#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! RUNTIME RLS gate for the region/branch CRUD mutations (지역·지점 관리).
//!
//! `update_region`, `deactivate_region` and `deactivate_branch` each run their
//! existence check, referential guard, UPDATE and audit-event INSERT inside ONE
//! `with_audit(current_org()?, ..)` transaction. A *static* gate proves the
//! wrapping is present in source; this test proves it WORKS AT RUNTIME when the
//! mutation executes as the genuine non-owner runtime role `mnt_rt` (NOSUPERUSER,
//! NOBYPASSRLS, FORCE RLS) — the only faithful exercise of the tenant policy.
//!
//! Why `mnt_rt` and not the default `#[sqlx::test]` pool: that pool connects as a
//! BYPASSRLS superuser, which sees every row regardless of `app.current_org` and
//! would green-light a totally broken (or leaking) write. We SEED as the owner
//! (raw inserts, row_security off) and MUTATE as `mnt_rt`.
//!
//! Asserts, with two tenants A (KNL) and B:
//!   * update_region renames A's region under A's armed GUC, and writes a
//!     `region.update` audit row;
//!   * cross-tenant isolation: under A's GUC, B's region is NOT FOUND (404), so a
//!     caller can never edit another org's region as `mnt_rt`;
//!   * deactivate_region SOFT-deletes an empty region (deactivated_at set) and
//!     audits `region.deactivate`, but is REFUSED with a Conflict while the region
//!     still has an active branch (referential guard, no orphaning);
//!   * deactivate_branch soft-deletes an empty branch and audits
//!     `branch.deactivate`, but is REFUSED with a Conflict while the branch still
//!     has an active user OR non-terminal equipment (referential guards);
//!   * FAIL-CLOSED: with no GUC armed, update_region returns not-found, never a
//!     leak/edit.

use mnt_identity_adapter_postgres::{PgOrgError, PgOrgStore};
use mnt_identity_application::{
    DeactivateBranchCommand, DeactivateRegionCommand, UpdateRegionCommand,
};
use mnt_kernel_core::{BranchId, ErrorKind, OrgId, RegionId, TraceContext, UserId};
use mnt_platform_request_context::CURRENT_ORG;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use time::OffsetDateTime;
use uuid::Uuid;

/// A second, non-KNL tenant id, to prove cross-tenant isolation under `mnt_rt`.
const ORG_B: Uuid = Uuid::from_u128(0x2222_2222_2222_2222_2222_2222_2222_2222);

/// A pool whose every connection runs `SET ROLE mnt_rt`, so statements execute as
/// the production runtime role (NOSUPERUSER, NOBYPASSRLS) under FORCE RLS.
async fn runtime_role_pool(owner_pool: &PgPool) -> PgPool {
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
        .unwrap()
}

// ===========================================================================
// Seeding (OWNER pool, row_security off). org_id columns are set explicitly so
// each row lands in the intended tenant.
// ===========================================================================

async fn seed_org(owner_pool: &PgPool, org: Uuid, tag: &str) {
    let mut tx = owner_pool.begin().await.unwrap();
    sqlx::query("SET LOCAL row_security = off")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
    )
    .bind(org)
    .bind(format!("org-{}", tag.to_lowercase()))
    .bind(format!("Org {tag}"))
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
}

async fn seed_region(owner_pool: &PgPool, org: Uuid, name: &str) -> RegionId {
    let mut tx = owner_pool.begin().await.unwrap();
    sqlx::query("SET LOCAL row_security = off")
        .execute(&mut *tx)
        .await
        .unwrap();
    let id: Uuid =
        sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ($1, $2) RETURNING id")
            .bind(name)
            .bind(org)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    tx.commit().await.unwrap();
    RegionId::from_uuid(id)
}

async fn seed_branch(owner_pool: &PgPool, org: Uuid, region: RegionId, name: &str) -> BranchId {
    let mut tx = owner_pool.begin().await.unwrap();
    sqlx::query("SET LOCAL row_security = off")
        .execute(&mut *tx)
        .await
        .unwrap();
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(*region.as_uuid())
    .bind(name)
    .bind(org)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    BranchId::from_uuid(id)
}

/// Seed an ACTIVE user assigned to `branch` (via user_branches). The actor of a
/// mutation must also be a real user (audit_events.actor FKs to users).
async fn seed_active_user(owner_pool: &PgPool, org: Uuid, branch: Option<BranchId>) -> UserId {
    let mut tx = owner_pool.begin().await.unwrap();
    sqlx::query("SET LOCAL row_security = off")
        .execute(&mut *tx)
        .await
        .unwrap();
    let user_id: Uuid = sqlx::query_scalar(
        "INSERT INTO users (display_name, roles, org_id, is_active) VALUES ($1, $2, $3, true) RETURNING id",
    )
    .bind(format!("User {}", Uuid::new_v4()))
    .bind(vec!["MECHANIC".to_string()])
    .bind(org)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    if let Some(branch) = branch {
        sqlx::query("INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)")
            .bind(user_id)
            .bind(*branch.as_uuid())
            .bind(org)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();
    UserId::from_uuid(user_id)
}

/// A unique `equipment_no` matching the `^[A-Z]{3}[A-Z0-9]{2}-[0-9]{4}$` check.
fn unique_equipment_no() -> String {
    let n = Uuid::new_v4().as_u128() % 10_000;
    format!("ABC12-{n:04}")
}

/// Seed a NON-TERMINAL ('임대') piece of equipment in `branch` so the branch
/// referential guard sees live equipment.
async fn seed_equipment(owner_pool: &PgPool, org: Uuid, branch: BranchId) {
    let mut tx = owner_pool.begin().await.unwrap();
    sqlx::query("SET LOCAL row_security = off")
        .execute(&mut *tx)
        .await
        .unwrap();
    let customer_id: Uuid = sqlx::query_scalar(
        "INSERT INTO registry_customers (branch_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(*branch.as_uuid())
    .bind(format!("Customer {}", Uuid::new_v4()))
    .bind(org)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    let site_id: Uuid = sqlx::query_scalar(
        "INSERT INTO registry_sites (branch_id, customer_id, name, org_id) VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(*branch.as_uuid())
    .bind(customer_id)
    .bind(format!("Site {}", Uuid::new_v4()))
    .bind(org)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        r#"
        INSERT INTO registry_equipment (
            branch_id, customer_id, site_id, equipment_no, management_no,
            manufacturer_code, kind_code, power_code, status,
            specification, ton_text, source_sheet, source_row, org_id
        )
        VALUES ($1, $2, $3, $4, $5, 'A', 'B', 'C', '임대',
                '좌식', '2.5T', 'region-branch-rls-test', 1, $6)
        "#,
    )
    .bind(*branch.as_uuid())
    .bind(customer_id)
    .bind(site_id)
    .bind(unique_equipment_no())
    .bind(format!("MG-{}", Uuid::new_v4()))
    .bind(org)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
}

/// Count `audit_events` rows for an action+target, read as OWNER (row_security
/// off) so the assertion is independent of the armed GUC.
async fn audit_count(owner_pool: &PgPool, action: &str, target_id: &str) -> i64 {
    let mut tx = owner_pool.begin().await.unwrap();
    sqlx::query("SET LOCAL row_security = off")
        .execute(&mut *tx)
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE action = $1 AND target_id = $2",
    )
    .bind(action)
    .bind(target_id)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    count
}

// ===========================================================================
// update_region: works as mnt_rt under the armed GUC + writes an audit row.
// ===========================================================================
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn update_region_renames_and_audits_as_runtime_role(owner_pool: PgPool) {
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let org = OrgId::knl();
    let org_uuid = *org.as_uuid();
    seed_org(&owner_pool, org_uuid, "A").await;
    let region = seed_region(&owner_pool, org_uuid, "수도권").await;
    let actor = seed_active_user(&owner_pool, org_uuid, None).await;

    let store = PgOrgStore::new(rt_pool.clone());
    let summary = CURRENT_ORG
        .scope(
            org,
            store.update_region(UpdateRegionCommand {
                actor,
                region_id: region,
                name: Some("충청권".to_string()),
                trace: TraceContext::generate(),
                occurred_at: OffsetDateTime::now_utc(),
            }),
        )
        .await
        .expect("update_region must succeed as mnt_rt under the armed GUC");

    assert_eq!(summary.name, "충청권");
    assert!(summary.deactivated_at.is_none());
    assert_eq!(
        audit_count(&owner_pool, "region.update", &region.to_string()).await,
        1,
        "the rename must be audited in the same tx"
    );
}

// ===========================================================================
// Cross-tenant isolation: under org-A's GUC, B's region is NOT FOUND (no edit).
// ===========================================================================
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn update_region_cannot_touch_another_orgs_region_as_runtime_role(owner_pool: PgPool) {
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let org_a = OrgId::knl();
    let org_b = OrgId::from_uuid(ORG_B);
    seed_org(&owner_pool, *org_a.as_uuid(), "A").await;
    seed_org(&owner_pool, *org_b.as_uuid(), "B").await;
    let actor_a = seed_active_user(&owner_pool, *org_a.as_uuid(), None).await;
    let region_b = seed_region(&owner_pool, *org_b.as_uuid(), "B권역").await;

    let store = PgOrgStore::new(rt_pool.clone());
    let result = CURRENT_ORG
        .scope(
            org_a,
            store.update_region(UpdateRegionCommand {
                actor: actor_a,
                region_id: region_b,
                name: Some("탈취시도".to_string()),
                trace: TraceContext::generate(),
                occurred_at: OffsetDateTime::now_utc(),
            }),
        )
        .await;

    match result {
        Err(PgOrgError::Domain(err)) => assert_eq!(
            err.kind,
            ErrorKind::NotFound,
            "B's region must be INVISIBLE (404) under org-A's GUC, never editable"
        ),
        other => panic!("expected cross-tenant not-found, got {other:?}"),
    }
}

// ===========================================================================
// deactivate_region: soft-deletes an EMPTY region; refuses while a branch lives.
// ===========================================================================
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn deactivate_region_soft_deletes_and_guards_active_branch_as_runtime_role(
    owner_pool: PgPool,
) {
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let org = OrgId::knl();
    let org_uuid = *org.as_uuid();
    seed_org(&owner_pool, org_uuid, "A").await;
    let actor = seed_active_user(&owner_pool, org_uuid, None).await;

    // (a) A region that still owns an active branch CANNOT be deactivated (409).
    let busy_region = seed_region(&owner_pool, org_uuid, "권역-사용중").await;
    let _branch = seed_branch(&owner_pool, org_uuid, busy_region, "강남지점").await;
    let store = PgOrgStore::new(rt_pool.clone());
    let blocked = CURRENT_ORG
        .scope(
            org,
            store.deactivate_region(DeactivateRegionCommand {
                actor,
                region_id: busy_region,
                trace: TraceContext::generate(),
                occurred_at: OffsetDateTime::now_utc(),
            }),
        )
        .await;
    match blocked {
        Err(PgOrgError::Domain(err)) => assert_eq!(
            err.kind,
            ErrorKind::Conflict,
            "a region with an active branch must be refused (409), never orphan it"
        ),
        other => panic!("expected referential-guard conflict, got {other:?}"),
    }
    // The refused deactivation wrote NO audit row and left the region active.
    assert_eq!(
        audit_count(&owner_pool, "region.deactivate", &busy_region.to_string()).await,
        0
    );

    // (b) An EMPTY region soft-deletes (deactivated_at set) and is audited.
    let empty_region = seed_region(&owner_pool, org_uuid, "권역-빈것").await;
    let summary = CURRENT_ORG
        .scope(
            org,
            store.deactivate_region(DeactivateRegionCommand {
                actor,
                region_id: empty_region,
                trace: TraceContext::generate(),
                occurred_at: OffsetDateTime::now_utc(),
            }),
        )
        .await
        .expect("deactivating an empty region must succeed as mnt_rt");
    assert!(
        summary.deactivated_at.is_some(),
        "soft-delete sets deactivated_at"
    );
    assert_eq!(
        audit_count(&owner_pool, "region.deactivate", &empty_region.to_string()).await,
        1
    );

    // It no longer appears in the active-only listing.
    let regions = CURRENT_ORG
        .scope(org, store.list_regions())
        .await
        .expect("list_regions as mnt_rt");
    assert!(
        !regions.iter().any(|r| r.id == empty_region),
        "a deactivated region is hidden from the org tree"
    );
}

// ===========================================================================
// deactivate_branch: soft-deletes an EMPTY branch; refuses while a user OR a
// piece of equipment still references it.
// ===========================================================================
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn deactivate_branch_soft_deletes_and_guards_references_as_runtime_role(owner_pool: PgPool) {
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let org = OrgId::knl();
    let org_uuid = *org.as_uuid();
    seed_org(&owner_pool, org_uuid, "A").await;
    let region = seed_region(&owner_pool, org_uuid, "수도권").await;
    let actor = seed_active_user(&owner_pool, org_uuid, None).await;
    let store = PgOrgStore::new(rt_pool.clone());

    // (a) A branch with an ACTIVE assigned user CANNOT be deactivated (409).
    let user_branch = seed_branch(&owner_pool, org_uuid, region, "지점-사용자").await;
    let _user = seed_active_user(&owner_pool, org_uuid, Some(user_branch)).await;
    let blocked_user = CURRENT_ORG
        .scope(
            org,
            store.deactivate_branch(DeactivateBranchCommand {
                actor,
                branch_id: user_branch,
                trace: TraceContext::generate(),
                occurred_at: OffsetDateTime::now_utc(),
            }),
        )
        .await;
    assert!(
        matches!(blocked_user, Err(PgOrgError::Domain(ref e)) if e.kind == ErrorKind::Conflict),
        "a branch with an active user must be refused (409), got {blocked_user:?}"
    );

    // (b) A branch with NON-TERMINAL equipment CANNOT be deactivated (409).
    let equip_branch = seed_branch(&owner_pool, org_uuid, region, "지점-장비").await;
    seed_equipment(&owner_pool, org_uuid, equip_branch).await;
    let blocked_equip = CURRENT_ORG
        .scope(
            org,
            store.deactivate_branch(DeactivateBranchCommand {
                actor,
                branch_id: equip_branch,
                trace: TraceContext::generate(),
                occurred_at: OffsetDateTime::now_utc(),
            }),
        )
        .await;
    assert!(
        matches!(blocked_equip, Err(PgOrgError::Domain(ref e)) if e.kind == ErrorKind::Conflict),
        "a branch with live equipment must be refused (409), got {blocked_equip:?}"
    );

    // (c) An EMPTY branch soft-deletes and is audited.
    let empty_branch = seed_branch(&owner_pool, org_uuid, region, "지점-빈것").await;
    let summary = CURRENT_ORG
        .scope(
            org,
            store.deactivate_branch(DeactivateBranchCommand {
                actor,
                branch_id: empty_branch,
                trace: TraceContext::generate(),
                occurred_at: OffsetDateTime::now_utc(),
            }),
        )
        .await
        .expect("deactivating an empty branch must succeed as mnt_rt");
    assert!(summary.deactivated_at.is_some());
    assert_eq!(
        audit_count(&owner_pool, "branch.deactivate", &empty_branch.to_string()).await,
        1
    );

    // It no longer appears in the active-only branch listing.
    let branches = CURRENT_ORG
        .scope(org, store.list_branches())
        .await
        .expect("list_branches as mnt_rt");
    assert!(!branches.iter().any(|b| b.id == empty_branch));
}

// ===========================================================================
// FAIL-CLOSED: with NO GUC armed, update_region returns not-found, never edits.
// ===========================================================================
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn update_region_fails_closed_without_org_as_runtime_role(owner_pool: PgPool) {
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let org = OrgId::knl();
    let org_uuid = *org.as_uuid();
    seed_org(&owner_pool, org_uuid, "A").await;
    let region = seed_region(&owner_pool, org_uuid, "수도권").await;
    let actor = seed_active_user(&owner_pool, org_uuid, None).await;

    // No CURRENT_ORG scope: current_org() is unset, so the mutation must fail
    // closed rather than edit the row.
    let store = PgOrgStore::new(rt_pool.clone());
    let result = store
        .update_region(UpdateRegionCommand {
            actor,
            region_id: region,
            name: Some("무단변경".to_string()),
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await;
    assert!(
        result.is_err(),
        "with no org armed the region update must fail closed, never edit the row"
    );
}
