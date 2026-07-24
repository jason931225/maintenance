#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Concurrent consumption retries must replay the committed event, rather than
//! turn a uniqueness race into a generic conflict.

use mnt_inventory_adapter_postgres::PgInventoryStore;
use mnt_inventory_application::{ConsumeInventoryCommand, ConsumeInventorySource};
use mnt_kernel_core::{
    BranchId, BranchScope, ErrorKind, InventoryItemId, OrgId, TraceContext, WorkOrderId,
};
use mnt_platform_request_context::scope_org;
use mnt_platform_test_support::{grant_mnt_rt, seed_org_and_super_admin};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use std::sync::Arc;
use time::OffsetDateTime;
use tokio::sync::Barrier;
use uuid::Uuid;

const ORG: Uuid = Uuid::from_u128(0x1A11_D3A0_0000_0000_0000_0000_0000_0001);
const OTHER_ORG: Uuid = Uuid::from_u128(0x1A11_D3A0_0000_0000_0000_0000_0000_0002);
const IDEMPOTENCY_KEY: &str = "inventory-consume-race-key";

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn concurrent_identical_consumptions_replay_once_and_payload_mismatch_conflicts(
    owner_pool: PgPool,
) {
    grant_mnt_rt(
        &owner_pool,
        &[
            "GRANT SELECT ON work_orders TO mnt_rt",
            "GRANT SELECT, INSERT, UPDATE ON inventory_stock_locations TO mnt_rt",
            "GRANT SELECT, INSERT, UPDATE ON inventory_items TO mnt_rt",
            "GRANT SELECT, INSERT ON inventory_consumption_events TO mnt_rt",
            "GRANT SELECT, INSERT ON audit_events TO mnt_rt",
        ],
    )
    .await;

    let org = OrgId::from_uuid(ORG);
    let actor = seed_org_and_super_admin(&owner_pool, ORG, "inventory-idempotency").await;
    let (branch, item_id, work_order_id) = seed_consumption_fixture(&owner_pool, ORG, actor).await;
    let pool = two_connection_runtime_role_pool(&owner_pool).await;
    let store = PgInventoryStore::new(pool);
    let now = OffsetDateTime::now_utc();
    let command = consume_command(actor, branch, item_id, work_order_id, 300, Some(now), now);

    // Each task obtains a separate transaction/connection from the runtime pool.
    // The barrier makes both callers contend on the same durable idempotency key.
    let barrier = Arc::new(Barrier::new(2));
    let first = {
        let barrier = Arc::clone(&barrier);
        let store = store.clone();
        let command = command.clone();
        tokio::spawn(async move {
            barrier.wait().await;
            scope_org(org, store.consume_item(command)).await
        })
    };
    let second = {
        let barrier = Arc::clone(&barrier);
        let store = store.clone();
        let command = command.clone();
        tokio::spawn(async move {
            barrier.wait().await;
            scope_org(org, store.consume_item(command)).await
        })
    };

    let (first, second) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        tokio::join!(first, second)
    })
    .await
    .expect("same-payload advisory-lock race must finish promptly");
    let first = first.unwrap().unwrap();
    let second = second.unwrap().unwrap();
    assert_eq!(
        first.event.id, second.event.id,
        "both callers replay one event"
    );
    assert_eq!(first.item.quantity_on_hand_milli, 700);
    assert_eq!(second.item.quantity_on_hand_milli, 700);

    let events: i64 =
        sqlx::query_scalar("SELECT count(*) FROM inventory_consumption_events WHERE item_id = $1")
            .bind(*item_id.as_uuid())
            .fetch_one(&owner_pool)
            .await
            .unwrap();
    let stock: i64 =
        sqlx::query_scalar("SELECT quantity_on_hand_milli FROM inventory_items WHERE id = $1")
            .bind(*item_id.as_uuid())
            .fetch_one(&owner_pool)
            .await
            .unwrap();
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE org_id = $1 AND action = 'inventory.consume'",
    )
    .bind(ORG)
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(events, 1, "one consumption event is recorded");
    assert_eq!(stock, 700, "stock is decremented once");
    assert_eq!(audits, 1, "one consumption audit event is recorded");

    let mismatch = scope_org(
        org,
        store.consume_item(ConsumeInventoryCommand {
            quantity_consumed_milli: 200,
            ..command
        }),
    )
    .await
    .expect_err("a reused key with a different payload must conflict");
    assert_eq!(mismatch.kind(), ErrorKind::Conflict);

    let timestamp_mismatch = scope_org(
        org,
        store.consume_item(ConsumeInventoryCommand {
            quantity_consumed_milli: 300,
            occurred_at: Some(now + time::Duration::seconds(1)),
            ..command
        }),
    )
    .await
    .expect_err("a reused key with a different explicit occurrence timestamp must conflict");
    assert_eq!(timestamp_mismatch.kind(), ErrorKind::Conflict);

    let events_after: i64 =
        sqlx::query_scalar("SELECT count(*) FROM inventory_consumption_events WHERE item_id = $1")
            .bind(*item_id.as_uuid())
            .fetch_one(&owner_pool)
            .await
            .unwrap();
    let stock_after: i64 =
        sqlx::query_scalar("SELECT quantity_on_hand_milli FROM inventory_items WHERE id = $1")
            .bind(*item_id.as_uuid())
            .fetch_one(&owner_pool)
            .await
            .unwrap();
    let audits_after: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE org_id = $1 AND action = 'inventory.consume'",
    )
    .bind(ORG)
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(events_after, 1, "a mismatch records no second event");
    assert_eq!(stock_after, 700, "a mismatch leaves stock unchanged");
    assert_eq!(audits_after, 1, "a mismatch records no second audit");

    assert_tenant_and_key_locks_do_not_block(&owner_pool).await;

    let other_org = OrgId::from_uuid(OTHER_ORG);
    let other_actor =
        seed_org_and_super_admin(&owner_pool, OTHER_ORG, "inventory-idempotency-other").await;
    let (other_branch, other_item_id, other_work_order_id) =
        seed_consumption_fixture(&owner_pool, OTHER_ORG, other_actor).await;
    let other = scope_org(
        other_org,
        store.consume_item(consume_command(
            other_actor,
            other_branch,
            other_item_id,
            other_work_order_id,
            300,
            Some(now),
            now,
        )),
    )
    .await
    .expect("the same raw key in another tenant must not replay the first tenant event");
    assert_ne!(other.event.id, first.event.id);
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn concurrent_explicit_timestamp_mismatch_conflicts_without_second_mutation(
    owner_pool: PgPool,
) {
    grant_mnt_rt(
        &owner_pool,
        &[
            "GRANT SELECT ON work_orders TO mnt_rt",
            "GRANT SELECT, INSERT, UPDATE ON inventory_stock_locations TO mnt_rt",
            "GRANT SELECT, INSERT, UPDATE ON inventory_items TO mnt_rt",
            "GRANT SELECT, INSERT ON inventory_consumption_events TO mnt_rt",
            "GRANT SELECT, INSERT ON audit_events TO mnt_rt",
        ],
    )
    .await;

    let org = OrgId::from_uuid(ORG);
    let actor = seed_org_and_super_admin(&owner_pool, ORG, "inventory-timestamp-race").await;
    let (branch, item_id, work_order_id) = seed_consumption_fixture(&owner_pool, ORG, actor).await;
    let store = PgInventoryStore::new(two_connection_runtime_role_pool(&owner_pool).await);
    let now = OffsetDateTime::now_utc();
    let first_command = consume_command(actor, branch, item_id, work_order_id, 300, Some(now), now);
    let second_command = ConsumeInventoryCommand {
        occurred_at: Some(now + time::Duration::seconds(1)),
        ..first_command.clone()
    };
    let barrier = Arc::new(Barrier::new(2));
    let first = {
        let barrier = Arc::clone(&barrier);
        let store = store.clone();
        tokio::spawn(async move {
            barrier.wait().await;
            scope_org(org, store.consume_item(first_command)).await
        })
    };
    let second = {
        let barrier = Arc::clone(&barrier);
        let store = store.clone();
        tokio::spawn(async move {
            barrier.wait().await;
            scope_org(org, store.consume_item(second_command)).await
        })
    };

    let (first, second) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        tokio::join!(first, second)
    })
    .await
    .expect("timestamp-mismatch advisory-lock race must finish promptly");
    let first = first.unwrap();
    let second = second.unwrap();
    let winner = match (first, second) {
        (Ok(winner), Err(error)) | (Err(error), Ok(winner)) => {
            assert_eq!(error.kind(), ErrorKind::Conflict);
            winner
        }
        (left, right) => {
            panic!("expected one success and one timestamp conflict, got {left:?}, {right:?}")
        }
    };
    assert_eq!(winner.item.quantity_on_hand_milli, 700);

    let events: i64 =
        sqlx::query_scalar("SELECT count(*) FROM inventory_consumption_events WHERE item_id = $1")
            .bind(*item_id.as_uuid())
            .fetch_one(&owner_pool)
            .await
            .unwrap();
    let stock: i64 =
        sqlx::query_scalar("SELECT quantity_on_hand_milli FROM inventory_items WHERE id = $1")
            .bind(*item_id.as_uuid())
            .fetch_one(&owner_pool)
            .await
            .unwrap();
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE org_id = $1 AND action = 'inventory.consume'",
    )
    .bind(ORG)
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(events, 1, "timestamp mismatch records no second event");
    assert_eq!(stock, 700, "timestamp mismatch decrements stock once");
    assert_eq!(audits, 1, "timestamp mismatch records one audit");
}

fn consume_command(
    actor: mnt_kernel_core::UserId,
    branch: BranchId,
    item_id: InventoryItemId,
    work_order_id: WorkOrderId,
    quantity_consumed_milli: i64,
    occurred_at: Option<OffsetDateTime>,
    now: OffsetDateTime,
) -> ConsumeInventoryCommand {
    ConsumeInventoryCommand {
        actor,
        branch_scope: BranchScope::All,
        item_id,
        source: ConsumeInventorySource::WorkOrder { work_order_id },
        quantity_consumed_milli,
        occurred_at,
        memo: Some("concurrent idempotency regression".to_owned()),
        idempotency_key: IDEMPOTENCY_KEY.to_owned(),
        trace: TraceContext::generate(),
        requested_at: now,
    }
}

async fn assert_tenant_and_key_locks_do_not_block(pool: &PgPool) {
    let mut first = pool.begin().await.unwrap();
    sqlx::query(
        "SELECT pg_advisory_xact_lock(hashtextextended(\
            char_length($1::text)::text || ':' || $1::text || \
            char_length($2::text)::text || ':' || $2::text, \
            0\
        ))",
    )
    .bind(ORG.to_string())
    .bind(IDEMPOTENCY_KEY)
    .execute(&mut *first)
    .await
    .unwrap();

    let mut second = pool.begin().await.unwrap();
    // `pg_try_advisory_xact_lock` is bounded: a distinct raw tenant/key must
    // acquire immediately while the first transaction still holds its lock.
    let acquired: bool = sqlx::query_scalar(
        "SELECT pg_try_advisory_xact_lock(hashtextextended(\
            char_length($1::text)::text || ':' || $1::text || \
            char_length($2::text)::text || ':' || $2::text, \
            0\
        ))",
    )
    .bind(OTHER_ORG.to_string())
    .bind(IDEMPOTENCY_KEY)
    .fetch_one(&mut *second)
    .await
    .unwrap();
    assert!(
        acquired,
        "a distinct tenant/key must not block behind this lock"
    );
    let distinct_key_acquired: bool = sqlx::query_scalar(
        "SELECT pg_try_advisory_xact_lock(hashtextextended(\
            char_length($1::text)::text || ':' || $1::text || \
            char_length($2::text)::text || ':' || $2::text, \
            0\
        ))",
    )
    .bind(ORG.to_string())
    .bind(format!("{IDEMPOTENCY_KEY}-distinct"))
    .fetch_one(&mut *second)
    .await
    .unwrap();
    assert!(
        distinct_key_acquired,
        "a sufficiently distinct key must not block behind this lock"
    );
    second.commit().await.unwrap();
    first.commit().await.unwrap();
}

async fn two_connection_runtime_role_pool(owner_pool: &PgPool) -> PgPool {
    let options = owner_pool.connect_options().as_ref().clone();
    PgPoolOptions::new()
        .max_connections(2)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("SET ROLE mnt_rt").execute(conn).await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .expect("connect two mnt_rt-role test connections")
}

async fn seed_consumption_fixture(
    pool: &PgPool,
    org: Uuid,
    actor: mnt_kernel_core::UserId,
) -> (BranchId, InventoryItemId, WorkOrderId) {
    let region_id = Uuid::new_v4();
    let branch_id = Uuid::new_v4();
    let customer_id = Uuid::new_v4();
    let site_id = Uuid::new_v4();
    let equipment_id = Uuid::new_v4();
    let work_order_id = Uuid::new_v4();
    let location_id = Uuid::new_v4();
    let item_id = Uuid::new_v4();
    let suffix = if org == ORG { "one" } else { "two" };
    let equipment_no = if org == ORG {
        "INVRA-0001"
    } else {
        "INVRA-0002"
    };
    let request_no = if org == ORG {
        "20260724-001"
    } else {
        "20260724-002"
    };
    let iv_code = if org == ORG {
        "IV-RACE-001"
    } else {
        "IV-RACE-002"
    };

    sqlx::query("INSERT INTO regions (id, name, org_id) VALUES ($1, $2, $3)")
        .bind(region_id)
        .bind(format!("inventory-idempotency-region-{suffix}"))
        .bind(org)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO branches (id, region_id, name, org_id) VALUES ($1, $2, $3, $4)")
        .bind(branch_id)
        .bind(region_id)
        .bind(format!("inventory-idempotency-branch-{suffix}"))
        .bind(org)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO registry_customers (id, branch_id, name, org_id) VALUES ($1, $2, 'Inventory customer', $3)")
        .bind(customer_id)
        .bind(branch_id)
        .bind(org)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO registry_sites (id, branch_id, customer_id, name, org_id) VALUES ($1, $2, $3, 'Inventory site', $4)")
        .bind(site_id)
        .bind(branch_id)
        .bind(customer_id)
        .bind(org)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO registry_equipment (id, branch_id, customer_id, site_id, equipment_no, manufacturer_code, kind_code, power_code, status, specification, ton_text, source_sheet, source_row, org_id) VALUES ($1, $2, $3, $4, $5, 'INV', 'TEST', 'DIESEL', '임대', 'test equipment', '1', 'test', 1, $6)",
    )
    .bind(equipment_id)
    .bind(branch_id)
    .bind(customer_id)
    .bind(site_id)
    .bind(equipment_no)
    .bind(org)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO work_orders (id, request_no, branch_id, equipment_id, customer_id, site_id, requested_by, status, symptom, org_id) VALUES ($1, $2, $3, $4, $5, $6, $7, 'RECEIVED', 'inventory test', $8)",
    )
    .bind(work_order_id)
    .bind(request_no)
    .bind(branch_id)
    .bind(equipment_id)
    .bind(customer_id)
    .bind(site_id)
    .bind(*actor.as_uuid())
    .bind(org)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO inventory_stock_locations (id, org_id, branch_id, label, status) VALUES ($1, $2, $3, 'Inventory test location', 'ACTIVE')",
    )
    .bind(location_id)
    .bind(org)
    .bind(branch_id)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO inventory_items (id, org_id, branch_id, stock_location_id, iv_code, display_name, unit_code, quantity_on_hand_milli, safety_stock_milli, unit_cost_won, status, created_by) VALUES ($1, $2, $3, $4, $5, 'Inventory race item', 'EA', 1000, 0, 100, 'ACTIVE', $6)",
    )
    .bind(item_id)
    .bind(org)
    .bind(branch_id)
    .bind(location_id)
    .bind(iv_code)
    .bind(*actor.as_uuid())
    .execute(pool)
    .await
    .unwrap();

    (
        BranchId::from_uuid(branch_id),
        InventoryItemId::from_uuid(item_id),
        WorkOrderId::from_uuid(work_order_id),
    )
}
