#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use mnt_financial_adapter_postgres::PgFinancialStore;
use mnt_financial_application::{
    AppendCostLedgerEntryCommand, CostLedgerSource, CreatePurchaseRequestCommand,
    CreateRentalQuoteCommand, ExecutePurchaseCommand, FinancialConfigSnapshot,
    PrepareExpenditureCommand, PurchaseApprovalCommand, PurchaseRestartCommand,
    PurchaseSubmitCommand, RejectPurchaseCommand,
};
use mnt_financial_domain::{DepreciationMethod, PurchaseStatus};
use mnt_kernel_core::{
    BranchId, EquipmentId, EvidenceId, OrgId, TraceContext, UserId, WorkOrderId,
};
use sqlx::PgPool;
use time::macros::datetime;

static REQUEST_NO_SEQUENCE: AtomicUsize = AtomicUsize::new(901);

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn quote_ledger_and_purchase_chain_are_audited_and_feed_residuals(pool: PgPool) {
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
        let seeded = seed_financial_context(&pool).await;
        let store = PgFinancialStore::new(pool.clone());
        let occurred_at = datetime!(2026-06-12 12:00 UTC);
        let config = financial_config();

        let quote = store
            .create_rental_quote(CreateRentalQuoteCommand {
                actor: seeded.receptionist,
                branch_id: seeded.branch_id,
                equipment_id: seeded.negative_residual_equipment,
                config: config.clone(),
                trace: TraceContext::generate(),
                occurred_at,
            })
            .await
            .unwrap();
        assert!(quote.residual_was_floored);
        assert!(quote.monthly_total.amount() > 0);

        let manual_entry = store
            .append_cost_ledger_entry(AppendCostLedgerEntryCommand {
                actor: seeded.admin,
                branch_id: seeded.branch_id,
                equipment_id: seeded.normal_equipment,
                work_order_id: Some(seeded.work_order_id),
                source: CostLedgerSource::ManualAdmin,
                amount_won: 1_500_000,
                memo: "Hydraulic pump repair".to_owned(),
                config: config.clone(),
                trace: TraceContext::generate(),
                occurred_at,
            })
            .await
            .unwrap();
        assert_eq!(manual_entry.residual_after_won, 5_100_000);

        let purchase = store
            .create_purchase_request(CreatePurchaseRequestCommand {
                actor: seeded.mechanic,
                branch_id: seeded.branch_id,
                equipment_id: seeded.normal_equipment,
                work_order_id: Some(seeded.work_order_id),
                statement_evidence_id: seeded.statement_evidence_id,
                vendor_name: "Parts Supplier".to_owned(),
                amount_won: 3_000_000,
                memo: "Pump assembly".to_owned(),
                config: config.clone(),
                trace: TraceContext::generate(),
                occurred_at,
            })
            .await
            .unwrap();
        assert_eq!(purchase.status, PurchaseStatus::StatementAttached);

        let submitted = store
            .submit_purchase_request(PurchaseSubmitCommand {
                actor: seeded.receptionist,
                purchase_request_id: purchase.id,
                trace: TraceContext::generate(),
                occurred_at,
            })
            .await
            .unwrap();
        assert_eq!(submitted.status, PurchaseStatus::RequestSubmitted);

        let rejected = store
            .reject_purchase_request(RejectPurchaseCommand {
                actor: seeded.admin,
                purchase_request_id: purchase.id,
                memo: "Attach corrected quotation".to_owned(),
                trace: TraceContext::generate(),
                occurred_at,
            })
            .await
            .unwrap();
        assert_eq!(rejected.status, PurchaseStatus::Rejected);

        let restarted = store
            .restart_purchase_request(PurchaseRestartCommand {
                actor: seeded.receptionist,
                purchase_request_id: purchase.id,
                statement_evidence_id: seeded.statement_evidence_id,
                amount_won: 3_000_000,
                memo: "Corrected quotation attached".to_owned(),
                trace: TraceContext::generate(),
                occurred_at,
            })
            .await
            .unwrap();
        assert_eq!(restarted.status, PurchaseStatus::StatementAttached);

        store
            .submit_purchase_request(PurchaseSubmitCommand {
                actor: seeded.receptionist,
                purchase_request_id: purchase.id,
                trace: TraceContext::generate(),
                occurred_at,
            })
            .await
            .unwrap();
        store
            .approve_purchase_admin(PurchaseApprovalCommand {
                actor: seeded.admin,
                purchase_request_id: purchase.id,
                trace: TraceContext::generate(),
                occurred_at,
            })
            .await
            .unwrap();
        let executive_pending = store
            .prepare_expenditure(PrepareExpenditureCommand {
                actor: seeded.receptionist,
                purchase_request_id: purchase.id,
                expenditure_no: "EXP-20260612-001".to_owned(),
                trace: TraceContext::generate(),
                occurred_at,
            })
            .await
            .unwrap();
        assert_eq!(executive_pending.status, PurchaseStatus::ExecutivePending);

        store
            .approve_purchase_executive(PurchaseApprovalCommand {
                actor: seeded.executive,
                purchase_request_id: purchase.id,
                trace: TraceContext::generate(),
                occurred_at,
            })
            .await
            .unwrap();

        let executed = store
            .execute_purchase(ExecutePurchaseCommand {
                actor: seeded.receptionist,
                purchase_request_id: purchase.id,
                trace: TraceContext::generate(),
                occurred_at,
            })
            .await
            .unwrap();
        assert_eq!(executed.status, PurchaseStatus::Executed);

        let residual: i64 =
            sqlx::query_scalar("SELECT residual_value FROM registry_equipment WHERE id = $1")
                .bind(*seeded.normal_equipment.as_uuid())
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(residual, 2_100_000);

        let actions: Vec<String> = sqlx::query_scalar(
            "SELECT action FROM audit_events WHERE branch_id = $1 ORDER BY occurred_at, created_at",
        )
        .bind(*seeded.branch_id.as_uuid())
        .fetch_all(&pool)
        .await
        .unwrap();
        assert!(actions.contains(&"financial.quote.create".to_owned()));
        assert!(actions.contains(&"equipment.residual.recompute".to_owned()));
        assert!(actions.contains(&"purchase.execute".to_owned()));
    })
    .await;
}

// FIX 5 regression: a unit with a genuinely negative current residual must
// persist a quote even when the flooring flag is disabled. The persisted
// effective_residual_value_won is floored to 0 (DB CHECK >= 0) with
// residual_was_floored=true, while current_residual_value_won keeps the real
// negative value for audit.
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn negative_residual_quote_persists_with_flooring_disabled(pool: PgPool) {
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
        let seeded = seed_financial_context(&pool).await;
        let store = PgFinancialStore::new(pool.clone());
        let occurred_at = datetime!(2026-06-12 12:00 UTC);

        let quote = store
            .create_rental_quote(CreateRentalQuoteCommand {
                actor: seeded.receptionist,
                branch_id: seeded.branch_id,
                equipment_id: seeded.negative_residual_equipment,
                config: financial_config_no_floor(),
                trace: TraceContext::generate(),
                occurred_at,
            })
            .await
            .unwrap();

        // The persisted effective residual is floored to 0 and flagged, even
        // though the flooring config flag is false.
        assert!(quote.residual_was_floored);
        assert_eq!(quote.effective_residual_value.amount(), 0);
        assert!(quote.monthly_total.amount() > 0);

        let row: (i64, i64, bool, bool) = sqlx::query_as(
            r#"
            SELECT current_residual_value_won, effective_residual_value_won,
                   residual_was_floored, floor_negative_quote_residual
            FROM financial_rental_quotes
            WHERE id = $1
            "#,
        )
        .bind(*quote.id.as_uuid())
        .fetch_one(&pool)
        .await
        .unwrap();
        // Real negative residual preserved for audit (no >=0 check on this column).
        assert_eq!(row.0, -1_250_000);
        // Persisted effective residual floored to 0 (DB CHECK >= 0).
        assert_eq!(row.1, 0);
        assert!(row.2, "residual_was_floored must be true");
        assert!(!row.3, "flooring config flag was disabled");
    })
    .await;
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn financial_inputs_reject_cross_scope_evidence_and_work_orders(pool: PgPool) {
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
        let seeded = seed_financial_context(&pool).await;
        let other_branch = seed_branch(&pool).await;
        let other_user = seed_user(&pool, "Other Mechanic", "MECHANIC", other_branch).await;
        let other_equipment = seed_equipment(
            &pool,
            other_branch,
            "DEF12-1302",
            "1302",
            8_000_000,
            5_000_000,
        )
        .await;
        let other_work_order =
            seed_work_order(&pool, other_branch, other_user, other_equipment).await;
        let other_statement = seed_statement_evidence(&pool, other_work_order, other_user).await;
        let pending_statement = seed_evidence(
            &pool,
            seeded.work_order_id,
            seeded.mechanic,
            "REQUEST",
            "PENDING",
        )
        .await;
        let wrong_equipment_work_order = seed_work_order(
            &pool,
            seeded.branch_id,
            seeded.receptionist,
            seeded.negative_residual_equipment,
        )
        .await;
        let store = PgFinancialStore::new(pool.clone());
        let occurred_at = datetime!(2026-06-12 12:00 UTC);

        let cross_scope = store
            .create_purchase_request(CreatePurchaseRequestCommand {
                actor: seeded.mechanic,
                branch_id: seeded.branch_id,
                equipment_id: seeded.normal_equipment,
                work_order_id: Some(seeded.work_order_id),
                statement_evidence_id: other_statement,
                vendor_name: "Wrong Scope Vendor".to_owned(),
                amount_won: 500_000,
                memo: "wrong evidence".to_owned(),
                config: financial_config(),
                trace: TraceContext::generate(),
                occurred_at,
            })
            .await
            .unwrap_err();
        assert!(cross_scope.to_string().contains("outside"));

        // The WORM-replica precondition is DEFERRED from create to submit: a
        // legitimate purchase request CREATES against still-replicating (PENDING)
        // REQUEST evidence — the async replica state must not bar create — and
        // only the SUBMIT into the approval pipeline waits on durable WORM
        // verification. (Before #19.18 the create itself 4xx'd with "verified
        // REQUEST", and the web catch{} swallowed the reason.)
        let pending_purchase = store
            .create_purchase_request(CreatePurchaseRequestCommand {
                actor: seeded.mechanic,
                branch_id: seeded.branch_id,
                equipment_id: seeded.normal_equipment,
                work_order_id: Some(seeded.work_order_id),
                statement_evidence_id: pending_statement,
                vendor_name: "Pending Vendor".to_owned(),
                amount_won: 500_000,
                memo: "pending evidence".to_owned(),
                config: financial_config(),
                trace: TraceContext::generate(),
                occurred_at,
            })
            .await
            .expect("create must succeed against PENDING (still-replicating) REQUEST evidence");
        assert_eq!(pending_purchase.status, PurchaseStatus::StatementAttached);

        // Submitting it into the approval pipeline is gated on durable WORM
        // verification, so it is refused with the deferred, surfaced reason while
        // the replica is still PENDING.
        let worm_pending = store
            .submit_purchase_request(PurchaseSubmitCommand {
                actor: seeded.receptionist,
                purchase_request_id: pending_purchase.id,
                trace: TraceContext::generate(),
                occurred_at,
            })
            .await
            .unwrap_err();
        assert!(worm_pending.to_string().contains("WORM-verified"));

        let wrong_work_order = store
            .append_cost_ledger_entry(AppendCostLedgerEntryCommand {
                actor: seeded.admin,
                branch_id: seeded.branch_id,
                equipment_id: seeded.normal_equipment,
                work_order_id: Some(wrong_equipment_work_order),
                source: CostLedgerSource::ManualAdmin,
                amount_won: 750_000,
                memo: "wrong work order".to_owned(),
                config: financial_config(),
                trace: TraceContext::generate(),
                occurred_at,
            })
            .await
            .unwrap_err();
        assert!(wrong_work_order.to_string().contains("work order"));
    })
    .await;
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn concurrent_cost_ledger_recomputes_from_serialized_equipment_lock(pool: PgPool) {
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
        let seeded = seed_financial_context(&pool).await;
        let store = PgFinancialStore::new(pool.clone());
        let occurred_at = datetime!(2026-06-12 12:00 UTC);
        let mut tx = pool.begin().await.unwrap();
        sqlx::query("SELECT id FROM registry_equipment WHERE id = $1 FOR UPDATE")
            .bind(*seeded.normal_equipment.as_uuid())
            .execute(tx.as_mut())
            .await
            .unwrap();
        let admin = seeded.admin;
        let branch_id = seeded.branch_id;
        let equipment_id = seeded.normal_equipment;
        let work_order_id = seeded.work_order_id;

        let first_store = store.clone();
        let first = tokio::spawn({
            let config = financial_config();
            async move {
                mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
                    first_store
                        .append_cost_ledger_entry(AppendCostLedgerEntryCommand {
                            actor: admin,
                            branch_id,
                            equipment_id,
                            work_order_id: Some(work_order_id),
                            source: CostLedgerSource::ManualAdmin,
                            amount_won: 1_000_000,
                            memo: "first concurrent cost".to_owned(),
                            config,
                            trace: TraceContext::generate(),
                            occurred_at,
                        })
                        .await
                })
                .await
            }
        });
        let second_store = store.clone();
        let second = tokio::spawn({
            let config = financial_config();
            async move {
                mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
                    second_store
                        .append_cost_ledger_entry(AppendCostLedgerEntryCommand {
                            actor: admin,
                            branch_id,
                            equipment_id,
                            work_order_id: Some(work_order_id),
                            source: CostLedgerSource::ManualAdmin,
                            amount_won: 2_000_000,
                            memo: "second concurrent cost".to_owned(),
                            config,
                            trace: TraceContext::generate(),
                            occurred_at,
                        })
                        .await
                })
                .await
            }
        });

        tokio::time::sleep(Duration::from_millis(100)).await;
        tx.rollback().await.unwrap();
        first.await.unwrap().unwrap();
        second.await.unwrap().unwrap();

        let residual: i64 =
            sqlx::query_scalar("SELECT residual_value FROM registry_equipment WHERE id = $1")
                .bind(*seeded.normal_equipment.as_uuid())
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(residual, 3_600_000);
        let entries = store
            .cost_ledger_for_equipment(seeded.normal_equipment)
            .await
            .unwrap();
        assert_eq!(entries.len(), 2);
        assert!(
            entries
                .iter()
                .any(|entry| entry.residual_after_won == 3_600_000)
        );
    })
    .await;
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn purchase_execute_rolls_back_if_ledger_update_fails(pool: PgPool) {
    mnt_platform_request_context::scope_org(mnt_kernel_core::OrgId::knl(), async move {
        let seeded = seed_financial_context(&pool).await;
        let store = PgFinancialStore::new(pool.clone());
        let occurred_at = datetime!(2026-06-12 12:00 UTC);
        let purchase = store
            .create_purchase_request(CreatePurchaseRequestCommand {
                actor: seeded.mechanic,
                branch_id: seeded.branch_id,
                equipment_id: seeded.normal_equipment,
                work_order_id: Some(seeded.work_order_id),
                statement_evidence_id: seeded.statement_evidence_id,
                vendor_name: "Rollback Parts".to_owned(),
                amount_won: 1_000_000,
                memo: "rollback fixture".to_owned(),
                config: financial_config(),
                trace: TraceContext::generate(),
                occurred_at,
            })
            .await
            .unwrap();
        store
            .submit_purchase_request(PurchaseSubmitCommand {
                actor: seeded.receptionist,
                purchase_request_id: purchase.id,
                trace: TraceContext::generate(),
                occurred_at,
            })
            .await
            .unwrap();
        store
            .approve_purchase_admin(PurchaseApprovalCommand {
                actor: seeded.admin,
                purchase_request_id: purchase.id,
                trace: TraceContext::generate(),
                occurred_at,
            })
            .await
            .unwrap();
        // Below the executive threshold, prepare_expenditure jumps straight to
        // READY_TO_EXECUTE, which is an approval-equivalent transition guarded by
        // the self-approval SoD rule — so it must NOT be performed by the
        // submitter (the receptionist). The admin (neither requester nor
        // submitter) carries it out.
        let ready = store
            .prepare_expenditure(PrepareExpenditureCommand {
                actor: seeded.admin,
                purchase_request_id: purchase.id,
                expenditure_no: "EXP-ROLLBACK-001".to_owned(),
                trace: TraceContext::generate(),
                occurred_at,
            })
            .await
            .unwrap();
        assert_eq!(ready.status, PurchaseStatus::ReadyToExecute);

        sqlx::query("UPDATE registry_equipment SET vehicle_value = NULL WHERE id = $1")
            .bind(*seeded.normal_equipment.as_uuid())
            .execute(&pool)
            .await
            .unwrap();
        let err = store
            .execute_purchase(ExecutePurchaseCommand {
                actor: seeded.receptionist,
                purchase_request_id: purchase.id,
                trace: TraceContext::generate(),
                occurred_at,
            })
            .await
            .unwrap_err();
        assert!(err.to_string().contains("vehicle value is required"));

        let status: String =
            sqlx::query_scalar("SELECT status FROM financial_purchase_requests WHERE id = $1")
                .bind(*purchase.id.as_uuid())
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(status, "READY_TO_EXECUTE");
        let ledger_rows: i64 = sqlx::query_scalar(
            "SELECT COUNT(*)::BIGINT FROM equipment_cost_ledger WHERE purchase_request_id = $1",
        )
        .bind(*purchase.id.as_uuid())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(ledger_rows, 0);
        let execute_audits: i64 =
            sqlx::query_scalar("SELECT COUNT(*)::BIGINT FROM audit_events WHERE action = 'purchase.execute' AND target_id = $1")
                .bind(purchase.id.to_string())
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(execute_audits, 0);
    })
    .await;
}

struct SeededFinancialContext {
    branch_id: BranchId,
    receptionist: UserId,
    mechanic: UserId,
    admin: UserId,
    executive: UserId,
    normal_equipment: EquipmentId,
    negative_residual_equipment: EquipmentId,
    work_order_id: WorkOrderId,
    statement_evidence_id: EvidenceId,
}

async fn seed_financial_context(pool: &PgPool) -> SeededFinancialContext {
    let branch_id = seed_branch(pool).await;
    let receptionist = seed_user(pool, "Financial Receptionist", "RECEPTIONIST", branch_id).await;
    let mechanic = seed_user(pool, "Financial Mechanic", "MECHANIC", branch_id).await;
    let admin = seed_user(pool, "Financial Admin", "ADMIN", branch_id).await;
    let executive = seed_user(pool, "Financial Executive", "EXECUTIVE", branch_id).await;
    let normal_equipment =
        seed_equipment(pool, branch_id, "ABC12-1300", "1300", 12_000_000, 9_000_000).await;
    let negative_residual_equipment = seed_equipment(
        pool,
        branch_id,
        "ABC12-1301",
        "1301",
        20_000_000,
        -1_250_000,
    )
    .await;
    let work_order_id = seed_work_order(pool, branch_id, receptionist, normal_equipment).await;
    let statement_evidence_id = seed_statement_evidence(pool, work_order_id, mechanic).await;

    SeededFinancialContext {
        branch_id,
        receptionist,
        mechanic,
        admin,
        executive,
        normal_equipment,
        negative_residual_equipment,
        work_order_id,
        statement_evidence_id,
    }
}

fn financial_config() -> FinancialConfigSnapshot {
    FinancialConfigSnapshot {
        depreciation_method: DepreciationMethod::StraightLine,
        useful_life_months: 60,
        residual_rate_bps: 1_000,
        declining_balance_rate_bps: 2_000,
        management_fee_rate_bps: 1_000,
        profit_rate_bps: 500,
        floor_negative_quote_residual: true,
        executive_approval_threshold_won: 2_000_000,
    }
}

fn financial_config_no_floor() -> FinancialConfigSnapshot {
    FinancialConfigSnapshot {
        floor_negative_quote_residual: false,
        ..financial_config()
    }
}

async fn seed_branch(pool: &PgPool) -> BranchId {
    let region_id: uuid::Uuid =
        sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ($1, $2) RETURNING id")
            .bind(format!("Financial Region {}", uuid::Uuid::new_v4()))
            .bind(*OrgId::knl().as_uuid())
            .fetch_one(pool)
            .await
            .unwrap();
    let branch_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(region_id)
    .bind(format!("Financial Branch {}", uuid::Uuid::new_v4()))
    .bind(*OrgId::knl().as_uuid())
    .fetch_one(pool)
    .await
    .unwrap();
    BranchId::from_uuid(branch_id)
}

async fn seed_user(pool: &PgPool, name: &str, role: &str, branch_id: BranchId) -> UserId {
    let user_id = UserId::new();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
        .bind(*user_id.as_uuid())
        .bind(name)
        .bind(Vec::from([role]))
        .bind(*OrgId::knl().as_uuid())
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)")
        .bind(*user_id.as_uuid())
        .bind(*branch_id.as_uuid())
        .bind(*OrgId::knl().as_uuid())
        .execute(pool)
        .await
        .unwrap();
    user_id
}

async fn seed_equipment(
    pool: &PgPool,
    branch_id: BranchId,
    equipment_no: &str,
    management_no: &str,
    vehicle_value: i64,
    residual_value: i64,
) -> EquipmentId {
    let customer_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO registry_customers (branch_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(*branch_id.as_uuid())
    .bind(format!("Customer {management_no}"))
    .bind(*OrgId::knl().as_uuid())
    .fetch_one(pool)
    .await
    .unwrap();
    let site_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO registry_sites (branch_id, customer_id, name, org_id) VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(*branch_id.as_uuid())
    .bind(customer_id)
    .bind(format!("Site {management_no}"))
    .bind(*OrgId::knl().as_uuid())
    .fetch_one(pool)
    .await
    .unwrap();
    let equipment_id: uuid::Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO registry_equipment (
            branch_id, customer_id, site_id, equipment_no, management_no,
            manufacturer_code, kind_code, power_code, status,
            specification, ton_text, vehicle_value, residual_value,
            asset_registered_on, source_sheet, source_row, org_id
        )
        VALUES ($1, $2, $3, $4, $5, 'A', 'B', 'C', '임대',
                '좌식', '2.5T', $6, $7, DATE '2023-12-12', 'financial-test', 1, $8)
        RETURNING id
        "#,
    )
    .bind(*branch_id.as_uuid())
    .bind(customer_id)
    .bind(site_id)
    .bind(equipment_no)
    .bind(management_no)
    .bind(vehicle_value)
    .bind(residual_value)
    .bind(*OrgId::knl().as_uuid())
    .fetch_one(pool)
    .await
    .unwrap();
    EquipmentId::from_uuid(equipment_id)
}

async fn seed_work_order(
    pool: &PgPool,
    branch_id: BranchId,
    requested_by: UserId,
    equipment_id: EquipmentId,
) -> WorkOrderId {
    let row: (uuid::Uuid, uuid::Uuid) =
        sqlx::query_as("SELECT customer_id, site_id FROM registry_equipment WHERE id = $1")
            .bind(*equipment_id.as_uuid())
            .fetch_one(pool)
            .await
            .unwrap();
    let work_order_id = WorkOrderId::new();
    sqlx::query(
        r#"
        INSERT INTO work_orders (
            id, request_no, branch_id, equipment_id, customer_id, site_id,
            requested_by, status, symptom, org_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'RECEIVED', 'financial fixture', $8)
        "#,
    )
    .bind(*work_order_id.as_uuid())
    .bind(format!(
        "20260612-{:03}",
        REQUEST_NO_SEQUENCE.fetch_add(1, Ordering::SeqCst)
    ))
    .bind(*branch_id.as_uuid())
    .bind(*equipment_id.as_uuid())
    .bind(row.0)
    .bind(row.1)
    .bind(*requested_by.as_uuid())
    .bind(*OrgId::knl().as_uuid())
    .execute(pool)
    .await
    .unwrap();
    work_order_id
}

async fn seed_statement_evidence(
    pool: &PgPool,
    work_order_id: WorkOrderId,
    uploaded_by: UserId,
) -> EvidenceId {
    seed_evidence(pool, work_order_id, uploaded_by, "REQUEST", "VERIFIED").await
}

async fn seed_evidence(
    pool: &PgPool,
    work_order_id: WorkOrderId,
    uploaded_by: UserId,
    stage: &str,
    worm_replica_status: &str,
) -> EvidenceId {
    let evidence_id = EvidenceId::new();
    sqlx::query(
        r#"
        INSERT INTO evidence_media (
            id, work_order_id, stage, s3_key, content_type, size_bytes,
            uploaded_by, worm_replica_status, retry_count, org_id
        )
        VALUES ($1, $2, $3, $4, 'application/pdf', 2048, $5, $6, 0, $7)
        "#,
    )
    .bind(*evidence_id.as_uuid())
    .bind(*work_order_id.as_uuid())
    .bind(stage)
    .bind(format!(
        "work-orders/{work_order_id}/REQUEST/{evidence_id}.pdf"
    ))
    .bind(*uploaded_by.as_uuid())
    .bind(worm_replica_status)
    .bind(*OrgId::knl().as_uuid())
    .execute(pool)
    .await
    .unwrap();
    evidence_id
}

/// Seed a user with the given role AND `is_org_lead = true` (대표/CEO).
async fn seed_org_lead_user(pool: &PgPool, role: &str, branch_id: BranchId) -> UserId {
    let user_id = UserId::new();
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, org_id, is_org_lead)
         VALUES ($1, $2, $3, $4, true)",
    )
    .bind(*user_id.as_uuid())
    .bind("Org Lead")
    .bind(Vec::from([role]))
    .bind(*OrgId::knl().as_uuid())
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)")
        .bind(*user_id.as_uuid())
        .bind(*branch_id.as_uuid())
        .bind(*OrgId::knl().as_uuid())
        .execute(pool)
        .await
        .unwrap();
    user_id
}

// ===========================================================================
// Self-approval guard tests (Slice A, task #34)
// ===========================================================================

/// (a) A normal ADMIN who submitted/requested a 기안 must NOT be able to
///     approve it. The guard must return a 422-equivalent validation error:
///     "본인이 상신/요청한 건은 결재할 수 없습니다".
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn self_approval_blocked_for_normal_admin(pool: PgPool) {
    mnt_platform_request_context::scope_org(OrgId::knl(), async move {
        let seeded = seed_financial_context(&pool).await;
        let store = PgFinancialStore::new(pool.clone());
        let occurred_at = time::macros::datetime!(2026-06-23 09:00 UTC);
        let config = financial_config();

        // Create the purchase as the mechanic (they are requested_by).
        let purchase = store
            .create_purchase_request(CreatePurchaseRequestCommand {
                actor: seeded.admin, // admin creates → admin is requested_by
                branch_id: seeded.branch_id,
                equipment_id: seeded.normal_equipment,
                work_order_id: None,
                statement_evidence_id: seeded.statement_evidence_id,
                vendor_name: "Self Test Vendor".to_owned(),
                amount_won: 500_000,
                memo: "Self-approval test".to_owned(),
                config: config.clone(),
                trace: TraceContext::generate(),
                occurred_at,
            })
            .await
            .unwrap();

        // Submit (moves to REQUEST_SUBMITTED).
        store
            .submit_purchase_request(PurchaseSubmitCommand {
                actor: seeded.receptionist,
                purchase_request_id: purchase.id,
                trace: TraceContext::generate(),
                occurred_at,
            })
            .await
            .unwrap();

        // The SAME admin who created the request tries to approve it.
        // Must be rejected with a validation error.
        let result = store
            .approve_purchase_admin(PurchaseApprovalCommand {
                actor: seeded.admin,
                purchase_request_id: purchase.id,
                trace: TraceContext::generate(),
                occurred_at,
            })
            .await;

        let err = result.expect_err("self-approval must be blocked");
        // KernelError::Validation maps to PgFinancialError::Domain.
        use mnt_financial_adapter_postgres::PgFinancialError;
        use mnt_kernel_core::ErrorKind;
        match err {
            PgFinancialError::Domain(e) => {
                assert_eq!(e.kind, ErrorKind::Validation);
                assert!(
                    e.message
                        .contains("본인이 상신/요청한 건은 결재할 수 없습니다"),
                    "expected Korean self-approval error, got: {}",
                    e.message
                );
            }
            other => panic!("expected Domain(Validation), got: {other:?}"),
        }
    })
    .await;
}

/// (b) The org 대표/CEO (is_org_lead = true) is ALLOWED to self-approve their
///     own 기안. Additionally, an `anomaly.self_approval` governance finding
///     must be written to `governance_findings` recording the exception.
#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn org_lead_self_approval_allowed_and_writes_finding(pool: PgPool) {
    mnt_platform_request_context::scope_org(OrgId::knl(), async move {
        let seeded = seed_financial_context(&pool).await;

        // Seed the 대표 as an ADMIN with is_org_lead = true.
        let org_lead = seed_org_lead_user(&pool, "ADMIN", seeded.branch_id).await;

        let store = PgFinancialStore::new(pool.clone());
        let occurred_at = time::macros::datetime!(2026-06-23 10:00 UTC);
        let config = financial_config();

        // Org lead creates the purchase request (they are requested_by).
        let purchase = store
            .create_purchase_request(CreatePurchaseRequestCommand {
                actor: org_lead,
                branch_id: seeded.branch_id,
                equipment_id: seeded.normal_equipment,
                work_order_id: None,
                statement_evidence_id: seeded.statement_evidence_id,
                vendor_name: "Lead Vendor".to_owned(),
                amount_won: 300_000,
                memo: "Org lead purchase".to_owned(),
                config: config.clone(),
                trace: TraceContext::generate(),
                occurred_at,
            })
            .await
            .unwrap();

        // Submit.
        store
            .submit_purchase_request(PurchaseSubmitCommand {
                actor: seeded.receptionist,
                purchase_request_id: purchase.id,
                trace: TraceContext::generate(),
                occurred_at,
            })
            .await
            .unwrap();

        // Org lead self-approves — must succeed (exception case).
        let approved = store
            .approve_purchase_admin(PurchaseApprovalCommand {
                actor: org_lead,
                purchase_request_id: purchase.id,
                trace: TraceContext::generate(),
                occurred_at,
            })
            .await
            .expect("org lead self-approval must be allowed");

        use mnt_financial_domain::PurchaseStatus;
        assert_eq!(
            approved.status,
            PurchaseStatus::AdminApproved,
            "purchase must advance to ADMIN_APPROVED"
        );

        // A governance finding must have been written.
        let finding_count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM governance_findings \
             WHERE detector_id = 'anomaly.self_approval' \
               AND entity_id = $1",
        )
        .bind(purchase.id.as_uuid().to_string())
        .fetch_one(&pool)
        .await
        .unwrap();

        assert_eq!(
            finding_count, 1,
            "org lead self-approval must write exactly one governance finding"
        );
    })
    .await;
}
