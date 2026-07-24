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
    let (branch, item_id, work_order_id) = seed_consumption_fixture(&owner_pool, actor).await;
    let pool = two_connection_runtime_role_pool(&owner_pool).await;
    let store = PgInventoryStore::new(pool);
    let now = OffsetDateTime::now_utc();
    let command = consume_command(actor, branch, item_id, work_order_id, 300, now);

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

    let (first, second) = tokio::join!(first, second);
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
}

fn consume_command(
    actor: mnt_kernel_core::UserId,
    branch: BranchId,
    item_id: InventoryItemId,
    work_order_id: WorkOrderId,
    quantity_consumed_milli: i64,
    now: OffsetDateTime,
) -> ConsumeInventoryCommand {
    ConsumeInventoryCommand {
        actor,
        branch_scope: BranchScope::All,
        item_id,
        source: ConsumeInventorySource::WorkOrder { work_order_id },
        quantity_consumed_milli,
        occurred_at: Some(now),
        memo: Some("concurrent idempotency regression".to_owned()),
        idempotency_key: "inventory-consume-race-key".to_owned(),
        trace: TraceContext::generate(),
        requested_at: now,
    }
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

    sqlx::query(
        "INSERT INTO regions (id, name, org_id) VALUES ($1, 'inventory-idempotency-region', $2)",
    )
    .bind(region_id)
    .bind(ORG)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO branches (id, region_id, name, org_id) VALUES ($1, $2, 'inventory-idempotency-branch', $3)")
        .bind(branch_id)
        .bind(region_id)
        .bind(ORG)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO registry_customers (id, branch_id, name, org_id) VALUES ($1, $2, 'Inventory customer', $3)")
        .bind(customer_id)
        .bind(branch_id)
        .bind(ORG)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO registry_sites (id, branch_id, customer_id, name, org_id) VALUES ($1, $2, $3, 'Inventory site', $4)")
        .bind(site_id)
        .bind(branch_id)
        .bind(customer_id)
        .bind(ORG)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO registry_equipment (id, branch_id, customer_id, site_id, equipment_no, manufacturer_code, kind_code, power_code, status, specification, ton_text, source_sheet, source_row, org_id) VALUES ($1, $2, $3, $4, 'INVRA-0001', 'INV', 'TEST', 'DIESEL', '임대', 'test equipment', '1', 'test', 1, $5)",
    )
    .bind(equipment_id)
    .bind(branch_id)
    .bind(customer_id)
    .bind(site_id)
    .bind(ORG)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO work_orders (id, request_no, branch_id, equipment_id, customer_id, site_id, requested_by, status, symptom, org_id) VALUES ($1, '20260724-001', $2, $3, $4, $5, $6, 'RECEIVED', 'inventory test', $7)",
    )
    .bind(work_order_id)
    .bind(branch_id)
    .bind(equipment_id)
    .bind(customer_id)
    .bind(site_id)
    .bind(*actor.as_uuid())
    .bind(ORG)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO inventory_stock_locations (id, org_id, branch_id, label, status) VALUES ($1, $2, $3, 'Inventory test location', 'ACTIVE')",
    )
    .bind(location_id)
    .bind(ORG)
    .bind(branch_id)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO inventory_items (id, org_id, branch_id, stock_location_id, iv_code, display_name, unit_code, quantity_on_hand_milli, safety_stock_milli, unit_cost_won, status, created_by) VALUES ($1, $2, $3, $4, 'IV-RACE-001', 'Inventory race item', 'EA', 1000, 0, 100, 'ACTIVE', $5)",
    )
    .bind(item_id)
    .bind(ORG)
    .bind(branch_id)
    .bind(location_id)
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
