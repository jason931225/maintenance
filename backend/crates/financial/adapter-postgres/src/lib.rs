//! Postgres financial adapter.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use mnt_financial_application::{
    AppendCostLedgerEntryCommand, CostLedgerEntrySummary, CostLedgerSource,
    CreatePurchaseRequestCommand, CreateRentalQuoteCommand, ExecutePurchaseCommand,
    FinancialConfigSnapshot, PrepareExpenditureCommand, PurchaseApprovalCommand,
    PurchaseRequestSummary, PurchaseRestartCommand, PurchaseSubmitCommand, RejectPurchaseCommand,
    RentalQuoteSummary, financial_audit_event,
};
use mnt_financial_domain::{
    MoneyInput, PurchaseActor, PurchaseStatus, PurchaseTransition, RentalQuoteInput,
    ResidualRecomputeInput, compute_rental_quote, recompute_residual_value,
    validate_purchase_transition,
};
use mnt_kernel_core::{
    AuditEvent, BranchId, EquipmentId, KernelError, OrgId, PurchaseRequestId, QuoteId, UserId,
    WorkOrderId,
};
use mnt_platform_db::{DbError, with_audit, with_audits};
use sqlx::{PgPool, Postgres, Row, Transaction};
use time::{Date, OffsetDateTime};

#[derive(Debug, thiserror::Error)]
pub enum PgFinancialError {
    #[error(transparent)]
    Db(#[from] DbError),

    #[error(transparent)]
    Domain(#[from] KernelError),
}

impl From<sqlx::Error> for PgFinancialError {
    fn from(value: sqlx::Error) -> Self {
        Self::Db(DbError::Sqlx(value))
    }
}

#[derive(Debug, Clone)]
pub struct PgFinancialStore {
    pool: PgPool,
}

impl PgFinancialStore {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn create_rental_quote(
        &self,
        command: CreateRentalQuoteCommand,
    ) -> Result<RentalQuoteSummary, PgFinancialError> {
        let quote_id = QuoteId::new();
        let event = financial_audit_event(
            "financial.quote.create",
            command.actor,
            command.branch_id,
            "financial_rental_quote",
            quote_id,
            command.trace,
            command.occurred_at,
        )?;

        with_audit::<_, RentalQuoteSummary, PgFinancialError>(&self.pool, event, |tx| {
            Box::pin(async move {
                let equipment = equipment_economics_tx(tx, command.equipment_id).await?;
                ensure_branch(equipment.branch_id, command.branch_id)?;
                let cumulative_repair_cost =
                    cumulative_cost_tx(tx, command.equipment_id, None).await?;
                let quote = compute_rental_quote(RentalQuoteInput {
                    acquisition_value: MoneyInput::won(equipment.vehicle_value_won),
                    current_residual_value: MoneyInput::won(equipment.residual_value_won),
                    cumulative_repair_cost: MoneyInput::won(cumulative_repair_cost),
                    config: command.config.quote_config(),
                })?;

                insert_quote_tx(
                    tx,
                    quote_id,
                    command.actor,
                    command.branch_id,
                    command.equipment_id,
                    equipment.vehicle_value_won,
                    equipment.residual_value_won,
                    cumulative_repair_cost,
                    &command.config,
                    &quote,
                    command.occurred_at,
                )
                .await?;
                rental_quote_by_id_tx(tx, quote_id).await
            })
        })
        .await
    }

    pub async fn append_cost_ledger_entry(
        &self,
        command: AppendCostLedgerEntryCommand,
    ) -> Result<CostLedgerEntrySummary, PgFinancialError> {
        self.append_cost_ledger_entry_with_purchase(command, None)
            .await
    }

    pub async fn create_purchase_request(
        &self,
        command: CreatePurchaseRequestCommand,
    ) -> Result<PurchaseRequestSummary, PgFinancialError> {
        validate_required(&command.vendor_name, "vendor name")?;
        validate_required(&command.memo, "purchase memo")?;
        if command.amount_won <= 0 {
            return Err(KernelError::validation("purchase amount must be positive").into());
        }

        let purchase_request_id = PurchaseRequestId::new();
        let event = financial_audit_event(
            "purchase.statement.attach",
            command.actor,
            command.branch_id,
            "financial_purchase_request",
            purchase_request_id,
            command.trace,
            command.occurred_at,
        )?;

        with_audit::<_, PurchaseRequestSummary, PgFinancialError>(&self.pool, event, |tx| {
            Box::pin(async move {
                let equipment = equipment_economics_tx(tx, command.equipment_id).await?;
                ensure_branch(equipment.branch_id, command.branch_id)?;
                let statement = ensure_statement_evidence_tx(
                    tx,
                    command.statement_evidence_id,
                    command.branch_id,
                    command.equipment_id,
                    command.work_order_id,
                )
                .await?;
                sqlx::query(
                    r#"
                    INSERT INTO financial_purchase_requests (
                        id, branch_id, equipment_id, work_order_id, statement_evidence_id,
                        vendor_name, amount_won, memo, status, requested_by,
                        depreciation_method, useful_life_months, residual_rate_bps,
                        declining_balance_rate_bps, management_fee_rate_bps,
                        profit_rate_bps, floor_negative_quote_residual,
                        executive_threshold_won, created_at, updated_at, org_id
                    )
                    VALUES (
                        $1, $2, $3, $4, $5,
                        $6, $7, $8, $9, $10,
                        $11, $12, $13, $14, $15, $16, $17, $18, $19, $19, $20
                    )
                    "#,
                )
                .bind(*purchase_request_id.as_uuid())
                .bind(*command.branch_id.as_uuid())
                .bind(*command.equipment_id.as_uuid())
                .bind(*statement.work_order_id.as_uuid())
                .bind(*command.statement_evidence_id.as_uuid())
                .bind(command.vendor_name.trim())
                .bind(command.amount_won)
                .bind(command.memo.trim())
                .bind(PurchaseStatus::StatementAttached.as_db_str())
                .bind(*command.actor.as_uuid())
                .bind(command.config.depreciation_method.as_db_str())
                .bind(
                    i32::try_from(command.config.useful_life_months).map_err(|_| {
                        KernelError::validation("useful life months overflowed i32")
                    })?,
                )
                .bind(command.config.residual_rate_bps)
                .bind(command.config.declining_balance_rate_bps)
                .bind(command.config.management_fee_rate_bps)
                .bind(command.config.profit_rate_bps)
                .bind(command.config.floor_negative_quote_residual)
                .bind(command.config.executive_approval_threshold_won)
                .bind(command.occurred_at)
                .bind(*OrgId::knl().as_uuid())
                .execute(tx.as_mut())
                .await?;
                insert_purchase_history_tx(
                    tx,
                    purchase_request_id,
                    command.actor,
                    "purchase.statement.attach",
                    None,
                    PurchaseStatus::StatementAttached,
                    Some(command.memo.trim()),
                    command.occurred_at,
                )
                .await?;
                purchase_by_id_tx(tx, purchase_request_id).await
            })
        })
        .await
    }

    pub async fn submit_purchase_request(
        &self,
        command: PurchaseSubmitCommand,
    ) -> Result<PurchaseRequestSummary, PgFinancialError> {
        self.transition_purchase(
            command.actor,
            command.purchase_request_id,
            "purchase.submit",
            PurchaseStatus::RequestSubmitted,
            None,
            None,
            command.trace,
            command.occurred_at,
        )
        .await
    }

    pub async fn approve_purchase_admin(
        &self,
        command: PurchaseApprovalCommand,
    ) -> Result<PurchaseRequestSummary, PgFinancialError> {
        self.transition_purchase(
            command.actor,
            command.purchase_request_id,
            "purchase.admin.approve",
            PurchaseStatus::AdminApproved,
            None,
            None,
            command.trace,
            command.occurred_at,
        )
        .await
    }

    pub async fn prepare_expenditure(
        &self,
        command: PrepareExpenditureCommand,
    ) -> Result<PurchaseRequestSummary, PgFinancialError> {
        validate_required(&command.expenditure_no, "expenditure number")?;
        // The target status is derived under the FOR UPDATE lock inside
        // `transition_purchase` (it recomputes ExecutivePending vs ReadyToExecute
        // from the locked row whenever the request set is one of those two), so we
        // pass either as the requested target and let the in-lock recompute win.
        // This avoids a redundant unlocked read of the purchase + threshold here.
        self.transition_purchase(
            command.actor,
            command.purchase_request_id,
            "purchase.expenditure.prepare",
            PurchaseStatus::ReadyToExecute,
            Some(command.expenditure_no),
            None,
            command.trace,
            command.occurred_at,
        )
        .await
    }

    pub async fn approve_purchase_executive(
        &self,
        command: PurchaseApprovalCommand,
    ) -> Result<PurchaseRequestSummary, PgFinancialError> {
        self.transition_purchase(
            command.actor,
            command.purchase_request_id,
            "purchase.executive.approve",
            PurchaseStatus::ReadyToExecute,
            None,
            None,
            command.trace,
            command.occurred_at,
        )
        .await
    }

    pub async fn reject_purchase_request(
        &self,
        command: RejectPurchaseCommand,
    ) -> Result<PurchaseRequestSummary, PgFinancialError> {
        validate_required(&command.memo, "reject memo")?;
        self.transition_purchase(
            command.actor,
            command.purchase_request_id,
            "purchase.reject",
            PurchaseStatus::Rejected,
            None,
            Some(command.memo),
            command.trace,
            command.occurred_at,
        )
        .await
    }

    pub async fn restart_purchase_request(
        &self,
        command: PurchaseRestartCommand,
    ) -> Result<PurchaseRequestSummary, PgFinancialError> {
        validate_required(&command.memo, "restart memo")?;
        if command.amount_won <= 0 {
            return Err(KernelError::validation("purchase amount must be positive").into());
        }
        let event_purchase = self.purchase_request(command.purchase_request_id).await?;
        let event = financial_audit_event(
            "purchase.restart",
            command.actor,
            event_purchase.branch_id,
            "financial_purchase_request",
            command.purchase_request_id,
            command.trace,
            command.occurred_at,
        )?;

        with_audit::<_, PurchaseRequestSummary, PgFinancialError>(&self.pool, event, |tx| {
            Box::pin(async move {
                let row = lock_purchase_tx(tx, command.purchase_request_id).await?;
                let from = row.status;
                validate_purchase_transition(PurchaseTransition {
                    from,
                    to: PurchaseStatus::StatementAttached,
                    actor: purchase_actor_for_user_tx(tx, command.actor).await?,
                    amount_won: command.amount_won,
                    executive_threshold_won: row.executive_threshold_won,
                })?;
                let statement = ensure_statement_evidence_tx(
                    tx,
                    command.statement_evidence_id,
                    row.branch_id,
                    row.equipment_id,
                    row.work_order_id,
                )
                .await?;

                sqlx::query(
                    r#"
                    UPDATE financial_purchase_requests
                    SET status = 'STATEMENT_ATTACHED',
                        statement_evidence_id = $2,
                        amount_won = $3,
                        memo = $4,
                        work_order_id = $6,
                        expenditure_no = NULL,
                        submitted_by = NULL,
                        admin_approved_by = NULL,
                        executive_approved_by = NULL,
                        executed_by = NULL,
                        rejected_by = NULL,
                        rejection_memo = NULL,
                        updated_at = $5
                    WHERE id = $1
                    "#,
                )
                .bind(*command.purchase_request_id.as_uuid())
                .bind(*command.statement_evidence_id.as_uuid())
                .bind(command.amount_won)
                .bind(command.memo.trim())
                .bind(command.occurred_at)
                .bind(*statement.work_order_id.as_uuid())
                .execute(tx.as_mut())
                .await?;
                insert_purchase_history_tx(
                    tx,
                    command.purchase_request_id,
                    command.actor,
                    "purchase.restart",
                    Some(from),
                    PurchaseStatus::StatementAttached,
                    Some(command.memo.trim()),
                    command.occurred_at,
                )
                .await?;
                purchase_by_id_tx(tx, command.purchase_request_id).await
            })
        })
        .await
    }

    pub async fn execute_purchase(
        &self,
        command: ExecutePurchaseCommand,
    ) -> Result<PurchaseRequestSummary, PgFinancialError> {
        with_audits::<_, PurchaseRequestSummary, PgFinancialError>(&self.pool, OrgId::knl(), |tx| {
            Box::pin(async move {
                let row = lock_purchase_tx(tx, command.purchase_request_id).await?;
                validate_purchase_transition(PurchaseTransition {
                    from: row.status,
                    to: PurchaseStatus::Executed,
                    actor: purchase_actor_for_user_tx(tx, command.actor).await?,
                    amount_won: row.amount_won,
                    executive_threshold_won: row.executive_threshold_won,
                })?;

                sqlx::query(
                    r#"
                    UPDATE financial_purchase_requests
                    SET status = 'EXECUTED',
                        executed_by = $2,
                        updated_at = $3
                    WHERE id = $1
                    "#,
                )
                .bind(*command.purchase_request_id.as_uuid())
                .bind(*command.actor.as_uuid())
                .bind(command.occurred_at)
                .execute(tx.as_mut())
                .await?;
                insert_purchase_history_tx(
                    tx,
                    command.purchase_request_id,
                    command.actor,
                    "purchase.execute",
                    Some(row.status),
                    PurchaseStatus::Executed,
                    None,
                    command.occurred_at,
                )
                .await?;

                let ledger_command = AppendCostLedgerEntryCommand {
                    actor: command.actor,
                    branch_id: row.branch_id,
                    equipment_id: row.equipment_id,
                    work_order_id: row.work_order_id,
                    source: CostLedgerSource::PurchaseExecution,
                    amount_won: row.amount_won,
                    memo: format!("purchase execution {}", command.purchase_request_id),
                    config: row.config,
                    trace: command.trace.clone(),
                    occurred_at: command.occurred_at,
                };
                let (_, residual_event) = append_cost_ledger_entry_tx(
                    tx,
                    ledger_command,
                    Some(command.purchase_request_id),
                )
                .await?;
                let purchase = purchase_by_id_tx(tx, command.purchase_request_id).await?;
                let purchase_event = financial_audit_event(
                    "purchase.execute",
                    command.actor,
                    row.branch_id,
                    "financial_purchase_request",
                    command.purchase_request_id,
                    command.trace,
                    command.occurred_at,
                )?;
                Ok((purchase, vec![purchase_event, residual_event]))
            })
        })
        .await
    }

    pub async fn purchase_request(
        &self,
        purchase_request_id: PurchaseRequestId,
    ) -> Result<PurchaseRequestSummary, PgFinancialError> {
        purchase_by_id(&self.pool, purchase_request_id).await
    }

    pub async fn rental_quote(
        &self,
        quote_id: QuoteId,
    ) -> Result<RentalQuoteSummary, PgFinancialError> {
        rental_quote_by_id(&self.pool, quote_id).await
    }

    pub async fn cost_ledger_for_equipment(
        &self,
        equipment_id: EquipmentId,
    ) -> Result<Vec<CostLedgerEntrySummary>, PgFinancialError> {
        cost_ledger_for_equipment(&self.pool, equipment_id).await
    }

    pub async fn equipment_branch(
        &self,
        equipment_id: EquipmentId,
    ) -> Result<BranchId, PgFinancialError> {
        Ok(equipment_economics(&self.pool, equipment_id)
            .await?
            .branch_id)
    }

    async fn append_cost_ledger_entry_with_purchase(
        &self,
        command: AppendCostLedgerEntryCommand,
        purchase_request_id: Option<PurchaseRequestId>,
    ) -> Result<CostLedgerEntrySummary, PgFinancialError> {
        validate_required(&command.memo, "cost ledger memo")?;
        if command.amount_won <= 0 {
            return Err(KernelError::validation("cost ledger amount must be positive").into());
        }

        with_audits::<_, CostLedgerEntrySummary, PgFinancialError>(&self.pool, OrgId::knl(), |tx| {
            Box::pin(async move {
                let (entry, event) =
                    append_cost_ledger_entry_tx(tx, command, purchase_request_id).await?;
                Ok((entry, vec![event]))
            })
        })
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn transition_purchase(
        &self,
        actor: UserId,
        purchase_request_id: PurchaseRequestId,
        action: &'static str,
        requested_to: PurchaseStatus,
        expenditure_no: Option<String>,
        memo: Option<String>,
        trace: mnt_kernel_core::TraceContext,
        occurred_at: OffsetDateTime,
    ) -> Result<PurchaseRequestSummary, PgFinancialError> {
        let purchase = self.purchase_request(purchase_request_id).await?;
        let event = financial_audit_event(
            action,
            actor,
            purchase.branch_id,
            "financial_purchase_request",
            purchase_request_id,
            trace,
            occurred_at,
        )?;

        with_audit::<_, PurchaseRequestSummary, PgFinancialError>(&self.pool, event, |tx| {
            Box::pin(async move {
                let row = lock_purchase_tx(tx, purchase_request_id).await?;
                let to = if row.status == PurchaseStatus::AdminApproved
                    && matches!(
                        requested_to,
                        PurchaseStatus::ReadyToExecute | PurchaseStatus::ExecutivePending
                    ) {
                    if row.amount_won > row.executive_threshold_won {
                        PurchaseStatus::ExecutivePending
                    } else {
                        PurchaseStatus::ReadyToExecute
                    }
                } else {
                    requested_to
                };
                validate_purchase_transition(PurchaseTransition {
                    from: row.status,
                    to,
                    actor: purchase_actor_for_user_tx(tx, actor).await?,
                    amount_won: row.amount_won,
                    executive_threshold_won: row.executive_threshold_won,
                })?;

                let memo_trimmed = memo.as_deref().map(str::trim).filter(|value| !value.is_empty());
                let expenditure_trimmed = expenditure_no
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty());
                sqlx::query(
                    r#"
                    UPDATE financial_purchase_requests
                    SET status = $2,
                        expenditure_no = COALESCE($3, expenditure_no),
                        submitted_by = CASE WHEN $2 = 'REQUEST_SUBMITTED' THEN $4 ELSE submitted_by END,
                        admin_approved_by = CASE WHEN $2 = 'ADMIN_APPROVED' THEN $4 ELSE admin_approved_by END,
                        executive_approved_by = CASE
                            WHEN $2 = 'READY_TO_EXECUTE' AND $5 = 'EXECUTIVE_PENDING' THEN $4
                            ELSE executive_approved_by
                        END,
                        executed_by = CASE WHEN $2 = 'EXECUTED' THEN $4 ELSE executed_by END,
                        rejected_by = CASE WHEN $2 = 'REJECTED' THEN $4 ELSE rejected_by END,
                        rejection_memo = CASE WHEN $2 = 'REJECTED' THEN $6 ELSE rejection_memo END,
                        updated_at = $7
                    WHERE id = $1
                    "#,
                )
                .bind(*purchase_request_id.as_uuid())
                .bind(to.as_db_str())
                .bind(expenditure_trimmed)
                .bind(*actor.as_uuid())
                .bind(row.status.as_db_str())
                .bind(memo_trimmed)
                .bind(occurred_at)
                .execute(tx.as_mut())
                .await?;
                insert_purchase_history_tx(
                    tx,
                    purchase_request_id,
                    actor,
                    action,
                    Some(row.status),
                    to,
                    memo_trimmed,
                    occurred_at,
                )
                .await?;
                purchase_by_id_tx(tx, purchase_request_id).await
            })
        })
        .await
    }
}

#[derive(Debug, Clone, Copy)]
struct EquipmentEconomics {
    branch_id: BranchId,
    vehicle_value_won: i64,
    residual_value_won: i64,
    asset_registered_on: Option<Date>,
}

#[derive(Debug, Clone)]
struct LockedPurchase {
    branch_id: BranchId,
    equipment_id: EquipmentId,
    work_order_id: Option<WorkOrderId>,
    status: PurchaseStatus,
    amount_won: i64,
    executive_threshold_won: i64,
    config: FinancialConfigSnapshot,
}

#[derive(Debug, Clone, Copy)]
struct StatementEvidenceLink {
    work_order_id: WorkOrderId,
}

async fn equipment_economics(
    pool: &PgPool,
    equipment_id: EquipmentId,
) -> Result<EquipmentEconomics, PgFinancialError> {
    let row = sqlx::query(
        r#"
        SELECT branch_id, vehicle_value, residual_value, asset_registered_on
        FROM registry_equipment
        WHERE id = $1
        "#,
    )
    .bind(*equipment_id.as_uuid())
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| KernelError::not_found("equipment was not found"))?;
    equipment_economics_from_row(&row)
}

async fn equipment_economics_tx(
    tx: &mut Transaction<'_, Postgres>,
    equipment_id: EquipmentId,
) -> Result<EquipmentEconomics, PgFinancialError> {
    let row = sqlx::query(
        r#"
        SELECT branch_id, vehicle_value, residual_value, asset_registered_on
        FROM registry_equipment
        WHERE id = $1
        FOR UPDATE
        "#,
    )
    .bind(*equipment_id.as_uuid())
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| KernelError::not_found("equipment was not found"))?;
    equipment_economics_from_row(&row)
}

fn equipment_economics_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<EquipmentEconomics, PgFinancialError> {
    let vehicle_value_won: Option<i64> = row.try_get("vehicle_value")?;
    let residual_value_won: Option<i64> = row.try_get("residual_value")?;
    Ok(EquipmentEconomics {
        branch_id: BranchId::from_uuid(row.try_get("branch_id")?),
        vehicle_value_won: vehicle_value_won
            .ok_or_else(|| KernelError::validation("equipment vehicle value is required"))?,
        residual_value_won: residual_value_won.unwrap_or(0),
        asset_registered_on: row.try_get("asset_registered_on")?,
    })
}

async fn cumulative_cost_tx(
    tx: &mut Transaction<'_, Postgres>,
    equipment_id: EquipmentId,
    excluding_purchase: Option<PurchaseRequestId>,
) -> Result<i64, PgFinancialError> {
    let total: Option<i64> = sqlx::query_scalar(
        r#"
        SELECT COALESCE(SUM(amount_won), 0)::BIGINT
        FROM equipment_cost_ledger
        WHERE equipment_id = $1
          AND ($2::UUID IS NULL OR purchase_request_id IS DISTINCT FROM $2)
        "#,
    )
    .bind(*equipment_id.as_uuid())
    .bind(excluding_purchase.map(|id| *id.as_uuid()))
    .fetch_one(tx.as_mut())
    .await?;
    Ok(total.unwrap_or(0))
}

async fn append_cost_ledger_entry_tx(
    tx: &mut Transaction<'_, Postgres>,
    command: AppendCostLedgerEntryCommand,
    purchase_request_id: Option<PurchaseRequestId>,
) -> Result<(CostLedgerEntrySummary, AuditEvent), PgFinancialError> {
    let locked = equipment_economics_tx(tx, command.equipment_id).await?;
    ensure_branch(locked.branch_id, command.branch_id)?;
    if let Some(work_order_id) = command.work_order_id {
        ensure_work_order_matches_tx(tx, work_order_id, command.branch_id, command.equipment_id)
            .await?;
    }

    let previous_cost = cumulative_cost_tx(tx, command.equipment_id, None).await?;
    let cumulative_cost = previous_cost.saturating_add(command.amount_won);
    let months_elapsed = months_elapsed(locked.asset_registered_on, command.occurred_at.date());
    let residual_after = recompute_residual_value(ResidualRecomputeInput {
        acquisition_value: MoneyInput::won(locked.vehicle_value_won),
        months_elapsed,
        cumulative_cost: MoneyInput::won(cumulative_cost),
        config: command.config.quote_config(),
    })?
    .amount();

    let entry_id = uuid::Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO equipment_cost_ledger (
            id, branch_id, equipment_id, work_order_id, purchase_request_id,
            source, amount_won, memo, residual_before_won, residual_after_won,
            entry_at, created_by, org_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        "#,
    )
    .bind(entry_id)
    .bind(*command.branch_id.as_uuid())
    .bind(*command.equipment_id.as_uuid())
    .bind(command.work_order_id.map(|id| *id.as_uuid()))
    .bind(purchase_request_id.map(|id| *id.as_uuid()))
    .bind(command.source.as_db_str())
    .bind(command.amount_won)
    .bind(command.memo.trim())
    .bind(locked.residual_value_won)
    .bind(residual_after)
    .bind(command.occurred_at)
    .bind(*command.actor.as_uuid())
    .bind(*OrgId::knl().as_uuid())
    .execute(tx.as_mut())
    .await?;

    sqlx::query("UPDATE registry_equipment SET residual_value = $2, updated_at = $3 WHERE id = $1")
        .bind(*command.equipment_id.as_uuid())
        .bind(residual_after)
        .bind(command.occurred_at)
        .execute(tx.as_mut())
        .await?;

    let before = serde_json::json!({
        "residual_value_won": locked.residual_value_won,
        "cumulative_cost_won": previous_cost,
    });
    let after = serde_json::json!({
        "residual_value_won": residual_after,
        "cumulative_cost_won": cumulative_cost,
        "months_elapsed": months_elapsed,
    });
    let event = financial_audit_event(
        "equipment.residual.recompute",
        command.actor,
        command.branch_id,
        "registry_equipment",
        command.equipment_id,
        command.trace,
        command.occurred_at,
    )?
    .with_snapshots(Some(before), Some(after));
    let entry = cost_ledger_entry_by_id_tx(tx, entry_id).await?;
    Ok((entry, event))
}

async fn ensure_work_order_matches_tx(
    tx: &mut Transaction<'_, Postgres>,
    work_order_id: WorkOrderId,
    branch_id: BranchId,
    equipment_id: EquipmentId,
) -> Result<(), PgFinancialError> {
    let row = sqlx::query(
        r#"
        SELECT branch_id, equipment_id
        FROM work_orders
        WHERE id = $1
        "#,
    )
    .bind(*work_order_id.as_uuid())
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| KernelError::not_found("work order was not found"))?;
    let actual_branch = BranchId::from_uuid(row.try_get("branch_id")?);
    let actual_equipment = EquipmentId::from_uuid(row.try_get("equipment_id")?);
    if actual_branch != branch_id || actual_equipment != equipment_id {
        return Err(
            KernelError::forbidden("work order is outside the equipment financial scope").into(),
        );
    }
    Ok(())
}

async fn ensure_statement_evidence_tx(
    tx: &mut Transaction<'_, Postgres>,
    evidence_id: mnt_kernel_core::EvidenceId,
    branch_id: BranchId,
    equipment_id: EquipmentId,
    expected_work_order_id: Option<WorkOrderId>,
) -> Result<StatementEvidenceLink, PgFinancialError> {
    let row = sqlx::query(
        r#"
        SELECT e.work_order_id, e.stage, e.worm_replica_status,
               w.branch_id, w.equipment_id
        FROM evidence_media e
        JOIN work_orders w ON w.id = e.work_order_id
        WHERE e.id = $1
        "#,
    )
    .bind(*evidence_id.as_uuid())
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| KernelError::not_found("statement evidence was not found"))?;

    let work_order_id = WorkOrderId::from_uuid(row.try_get("work_order_id")?);
    let actual_branch = BranchId::from_uuid(row.try_get("branch_id")?);
    let actual_equipment = EquipmentId::from_uuid(row.try_get("equipment_id")?);
    if actual_branch != branch_id || actual_equipment != equipment_id {
        return Err(KernelError::forbidden(
            "statement evidence is outside the equipment financial scope",
        )
        .into());
    }
    if expected_work_order_id.is_some_and(|expected| expected != work_order_id) {
        return Err(
            KernelError::forbidden("statement evidence belongs to a different work order").into(),
        );
    }

    let stage: String = row.try_get("stage")?;
    let worm_replica_status: String = row.try_get("worm_replica_status")?;
    if stage != "REQUEST" || worm_replica_status != "VERIFIED" {
        return Err(KernelError::validation(
            "statement evidence must be verified REQUEST evidence",
        )
        .into());
    }

    Ok(StatementEvidenceLink { work_order_id })
}

#[allow(clippy::too_many_arguments)]
async fn insert_quote_tx(
    tx: &mut Transaction<'_, Postgres>,
    quote_id: QuoteId,
    actor: UserId,
    branch_id: BranchId,
    equipment_id: EquipmentId,
    acquisition_value_won: i64,
    residual_value_won: i64,
    cumulative_repair_cost_won: i64,
    config: &FinancialConfigSnapshot,
    quote: &mnt_financial_domain::ComputedRentalQuote,
    occurred_at: OffsetDateTime,
) -> Result<(), PgFinancialError> {
    sqlx::query(
        r#"
        INSERT INTO financial_rental_quotes (
            id, branch_id, equipment_id, created_by,
            acquisition_value_won, current_residual_value_won,
            effective_residual_value_won, residual_was_floored,
            cumulative_repair_cost_won, depreciation_method,
            useful_life_months, residual_rate_bps, declining_balance_rate_bps,
            management_fee_rate_bps, profit_rate_bps, floor_negative_quote_residual,
            monthly_total_won, created_at, updated_at, org_id
        )
        VALUES (
            $1, $2, $3, $4,
            $5, $6, $7, $8,
            $9, $10, $11, $12, $13,
            $14, $15, $16,
            $17, $18, $18, $19
        )
        "#,
    )
    .bind(*quote_id.as_uuid())
    .bind(*branch_id.as_uuid())
    .bind(*equipment_id.as_uuid())
    .bind(*actor.as_uuid())
    .bind(acquisition_value_won)
    .bind(residual_value_won)
    .bind(quote.effective_residual_value.amount())
    .bind(quote.residual_was_floored)
    .bind(cumulative_repair_cost_won)
    .bind(config.depreciation_method.as_db_str())
    .bind(
        i32::try_from(config.useful_life_months)
            .map_err(|_| KernelError::validation("useful life months overflowed i32"))?,
    )
    .bind(config.residual_rate_bps)
    .bind(config.declining_balance_rate_bps)
    .bind(config.management_fee_rate_bps)
    .bind(config.profit_rate_bps)
    .bind(config.floor_negative_quote_residual)
    .bind(quote.monthly_total.amount())
    .bind(occurred_at)
    .bind(*OrgId::knl().as_uuid())
    .execute(tx.as_mut())
    .await?;

    for (index, line) in quote.lines.iter().enumerate() {
        let line_order = i16::try_from(index + 1)
            .map_err(|_| KernelError::validation("quote line order overflowed i16"))?;
        sqlx::query(
            r#"
            INSERT INTO financial_rental_quote_lines (
                quote_id, line_order, code, label, amount_won, org_id
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(*quote_id.as_uuid())
        .bind(line_order)
        .bind(&line.code)
        .bind(&line.label)
        .bind(line.amount.amount())
        .bind(*OrgId::knl().as_uuid())
        .execute(tx.as_mut())
        .await?;
    }
    Ok(())
}

async fn rental_quote_by_id_tx(
    tx: &mut Transaction<'_, Postgres>,
    quote_id: QuoteId,
) -> Result<RentalQuoteSummary, PgFinancialError> {
    let row = sqlx::query(
        r#"
        SELECT id, branch_id, equipment_id, acquisition_value_won,
               current_residual_value_won, effective_residual_value_won,
               residual_was_floored, cumulative_repair_cost_won,
               monthly_total_won, created_at
        FROM financial_rental_quotes
        WHERE id = $1
        "#,
    )
    .bind(*quote_id.as_uuid())
    .fetch_one(tx.as_mut())
    .await?;
    let lines = quote_lines_tx(tx, quote_id).await?;
    rental_quote_from_row(&row, lines)
}

async fn rental_quote_by_id(
    pool: &PgPool,
    quote_id: QuoteId,
) -> Result<RentalQuoteSummary, PgFinancialError> {
    let row = sqlx::query(
        r#"
        SELECT id, branch_id, equipment_id, acquisition_value_won,
               current_residual_value_won, effective_residual_value_won,
               residual_was_floored, cumulative_repair_cost_won,
               monthly_total_won, created_at
        FROM financial_rental_quotes
        WHERE id = $1
        "#,
    )
    .bind(*quote_id.as_uuid())
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| KernelError::not_found("rental quote was not found"))?;
    let lines = quote_lines(pool, quote_id).await?;
    rental_quote_from_row(&row, lines)
}

fn rental_quote_from_row(
    row: &sqlx::postgres::PgRow,
    lines: Vec<mnt_financial_domain::QuoteLine>,
) -> Result<RentalQuoteSummary, PgFinancialError> {
    Ok(RentalQuoteSummary {
        id: QuoteId::from_uuid(row.try_get("id")?),
        branch_id: BranchId::from_uuid(row.try_get("branch_id")?),
        equipment_id: EquipmentId::from_uuid(row.try_get("equipment_id")?),
        acquisition_value: MoneyInput::won(row.try_get("acquisition_value_won")?),
        current_residual_value: MoneyInput::won(row.try_get("current_residual_value_won")?),
        effective_residual_value: MoneyInput::won(row.try_get("effective_residual_value_won")?),
        residual_was_floored: row.try_get("residual_was_floored")?,
        cumulative_repair_cost: MoneyInput::won(row.try_get("cumulative_repair_cost_won")?),
        monthly_total: MoneyInput::won(row.try_get("monthly_total_won")?),
        lines,
        created_at: row.try_get("created_at")?,
    })
}

async fn quote_lines_tx(
    tx: &mut Transaction<'_, Postgres>,
    quote_id: QuoteId,
) -> Result<Vec<mnt_financial_domain::QuoteLine>, PgFinancialError> {
    let rows = sqlx::query(
        r#"
        SELECT code, label, amount_won
        FROM financial_rental_quote_lines
        WHERE quote_id = $1
        ORDER BY line_order
        "#,
    )
    .bind(*quote_id.as_uuid())
    .fetch_all(tx.as_mut())
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(mnt_financial_domain::QuoteLine {
                code: row.try_get("code")?,
                label: row.try_get("label")?,
                amount: MoneyInput::won(row.try_get("amount_won")?),
            })
        })
        .collect()
}

async fn quote_lines(
    pool: &PgPool,
    quote_id: QuoteId,
) -> Result<Vec<mnt_financial_domain::QuoteLine>, PgFinancialError> {
    let rows = sqlx::query(
        r#"
        SELECT code, label, amount_won
        FROM financial_rental_quote_lines
        WHERE quote_id = $1
        ORDER BY line_order
        "#,
    )
    .bind(*quote_id.as_uuid())
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(mnt_financial_domain::QuoteLine {
                code: row.try_get("code")?,
                label: row.try_get("label")?,
                amount: MoneyInput::won(row.try_get("amount_won")?),
            })
        })
        .collect()
}

async fn lock_purchase_tx(
    tx: &mut Transaction<'_, Postgres>,
    purchase_request_id: PurchaseRequestId,
) -> Result<LockedPurchase, PgFinancialError> {
    let row = sqlx::query(
        r#"
        SELECT branch_id, equipment_id, work_order_id, status, amount_won,
               executive_threshold_won, depreciation_method, useful_life_months,
               residual_rate_bps, declining_balance_rate_bps,
               management_fee_rate_bps, profit_rate_bps,
               floor_negative_quote_residual
        FROM financial_purchase_requests
        WHERE id = $1
        FOR UPDATE
        "#,
    )
    .bind(*purchase_request_id.as_uuid())
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| KernelError::not_found("purchase request was not found"))?;
    let status: String = row.try_get("status")?;
    let method: String = row.try_get("depreciation_method")?;
    let work_order_id: Option<uuid::Uuid> = row.try_get("work_order_id")?;
    let useful_life_months: i32 = row.try_get("useful_life_months")?;
    let executive_threshold_won = row.try_get("executive_threshold_won")?;
    Ok(LockedPurchase {
        branch_id: BranchId::from_uuid(row.try_get("branch_id")?),
        equipment_id: EquipmentId::from_uuid(row.try_get("equipment_id")?),
        work_order_id: work_order_id.map(WorkOrderId::from_uuid),
        status: PurchaseStatus::from_db_str(&status)?,
        amount_won: row.try_get("amount_won")?,
        executive_threshold_won,
        config: FinancialConfigSnapshot {
            depreciation_method: mnt_financial_domain::DepreciationMethod::from_db_str(&method)?,
            useful_life_months: u32::try_from(useful_life_months)
                .map_err(|_| KernelError::validation("stored useful life months is negative"))?,
            residual_rate_bps: row.try_get("residual_rate_bps")?,
            declining_balance_rate_bps: row.try_get("declining_balance_rate_bps")?,
            management_fee_rate_bps: row.try_get("management_fee_rate_bps")?,
            profit_rate_bps: row.try_get("profit_rate_bps")?,
            floor_negative_quote_residual: row.try_get("floor_negative_quote_residual")?,
            executive_approval_threshold_won: executive_threshold_won,
        },
    })
}

async fn purchase_by_id(
    pool: &PgPool,
    purchase_request_id: PurchaseRequestId,
) -> Result<PurchaseRequestSummary, PgFinancialError> {
    let row = sqlx::query(purchase_select_sql())
        .bind(*purchase_request_id.as_uuid())
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| KernelError::not_found("purchase request was not found"))?;
    purchase_from_row(&row)
}

async fn purchase_by_id_tx(
    tx: &mut Transaction<'_, Postgres>,
    purchase_request_id: PurchaseRequestId,
) -> Result<PurchaseRequestSummary, PgFinancialError> {
    let row = sqlx::query(purchase_select_sql())
        .bind(*purchase_request_id.as_uuid())
        .fetch_one(tx.as_mut())
        .await?;
    purchase_from_row(&row)
}

fn purchase_select_sql() -> &'static str {
    r#"
    SELECT id, branch_id, equipment_id, work_order_id, statement_evidence_id,
           vendor_name, amount_won, status, expenditure_no, rejection_memo,
           created_at, updated_at
    FROM financial_purchase_requests
    WHERE id = $1
    "#
}

fn purchase_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<PurchaseRequestSummary, PgFinancialError> {
    let status: String = row.try_get("status")?;
    let work_order_id: Option<uuid::Uuid> = row.try_get("work_order_id")?;
    Ok(PurchaseRequestSummary {
        id: PurchaseRequestId::from_uuid(row.try_get("id")?),
        branch_id: BranchId::from_uuid(row.try_get("branch_id")?),
        equipment_id: EquipmentId::from_uuid(row.try_get("equipment_id")?),
        work_order_id: work_order_id.map(WorkOrderId::from_uuid),
        statement_evidence_id: mnt_kernel_core::EvidenceId::from_uuid(
            row.try_get("statement_evidence_id")?,
        ),
        vendor_name: row.try_get("vendor_name")?,
        amount_won: row.try_get("amount_won")?,
        status: PurchaseStatus::from_db_str(&status)?,
        expenditure_no: row.try_get("expenditure_no")?,
        rejection_memo: row.try_get("rejection_memo")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

#[allow(clippy::too_many_arguments)]
async fn insert_purchase_history_tx(
    tx: &mut Transaction<'_, Postgres>,
    purchase_request_id: PurchaseRequestId,
    actor: UserId,
    action: &str,
    from_status: Option<PurchaseStatus>,
    to_status: PurchaseStatus,
    memo: Option<&str>,
    occurred_at: OffsetDateTime,
) -> Result<(), PgFinancialError> {
    sqlx::query(
        r#"
        INSERT INTO financial_purchase_history (
            purchase_request_id, actor, action, from_status, to_status, memo, occurred_at, org_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        "#,
    )
    .bind(*purchase_request_id.as_uuid())
    .bind(*actor.as_uuid())
    .bind(action)
    .bind(from_status.map(PurchaseStatus::as_db_str))
    .bind(to_status.as_db_str())
    .bind(memo)
    .bind(occurred_at)
    .bind(*OrgId::knl().as_uuid())
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

async fn cost_ledger_entry_by_id_tx(
    tx: &mut Transaction<'_, Postgres>,
    entry_id: uuid::Uuid,
) -> Result<CostLedgerEntrySummary, PgFinancialError> {
    let row = sqlx::query(
        r#"
        SELECT id, branch_id, equipment_id, work_order_id, purchase_request_id,
               source, amount_won, memo, residual_before_won, residual_after_won,
               entry_at
        FROM equipment_cost_ledger
        WHERE id = $1
        "#,
    )
    .bind(entry_id)
    .fetch_one(tx.as_mut())
    .await?;
    cost_ledger_from_row(&row)
}

async fn cost_ledger_for_equipment(
    pool: &PgPool,
    equipment_id: EquipmentId,
) -> Result<Vec<CostLedgerEntrySummary>, PgFinancialError> {
    let rows = sqlx::query(
        r#"
        SELECT id, branch_id, equipment_id, work_order_id, purchase_request_id,
               source, amount_won, memo, residual_before_won, residual_after_won,
               entry_at
        FROM equipment_cost_ledger
        WHERE equipment_id = $1
        ORDER BY entry_at DESC, id DESC
        "#,
    )
    .bind(*equipment_id.as_uuid())
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| cost_ledger_from_row(&row))
        .collect()
}

fn cost_ledger_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<CostLedgerEntrySummary, PgFinancialError> {
    let source: String = row.try_get("source")?;
    let work_order_id: Option<uuid::Uuid> = row.try_get("work_order_id")?;
    let purchase_request_id: Option<uuid::Uuid> = row.try_get("purchase_request_id")?;
    Ok(CostLedgerEntrySummary {
        id: row.try_get("id")?,
        branch_id: BranchId::from_uuid(row.try_get("branch_id")?),
        equipment_id: EquipmentId::from_uuid(row.try_get("equipment_id")?),
        work_order_id: work_order_id.map(WorkOrderId::from_uuid),
        purchase_request_id: purchase_request_id.map(PurchaseRequestId::from_uuid),
        source: CostLedgerSource::from_db_str(&source)?,
        amount_won: row.try_get("amount_won")?,
        memo: row.try_get("memo")?,
        residual_before_won: row.try_get("residual_before_won")?,
        residual_after_won: row.try_get("residual_after_won")?,
        entry_at: row.try_get("entry_at")?,
    })
}

async fn purchase_actor_for_user_tx(
    tx: &mut Transaction<'_, Postgres>,
    user_id: UserId,
) -> Result<PurchaseActor, PgFinancialError> {
    let roles: Vec<String> = sqlx::query_scalar("SELECT roles FROM users WHERE id = $1")
        .bind(*user_id.as_uuid())
        .fetch_optional(tx.as_mut())
        .await?
        .ok_or_else(|| KernelError::not_found("user was not found"))?;

    if roles.iter().any(|role| role == "SUPER_ADMIN") {
        Ok(PurchaseActor::SuperAdmin)
    } else if roles.iter().any(|role| role == "EXECUTIVE") {
        Ok(PurchaseActor::Executive)
    } else if roles.iter().any(|role| role == "ADMIN") {
        Ok(PurchaseActor::Admin)
    } else if roles.iter().any(|role| role == "RECEPTIONIST") {
        Ok(PurchaseActor::Receptionist)
    } else if roles.iter().any(|role| role == "MECHANIC") {
        Ok(PurchaseActor::Mechanic)
    } else {
        Err(KernelError::forbidden("user has no purchase workflow role").into())
    }
}

fn ensure_branch(actual: BranchId, expected: BranchId) -> Result<(), PgFinancialError> {
    if actual == expected {
        Ok(())
    } else {
        Err(KernelError::forbidden("equipment is outside branch scope").into())
    }
}

fn validate_required(value: &str, field: &str) -> Result<(), PgFinancialError> {
    if value.trim().is_empty() {
        Err(KernelError::validation(format!("{field} is required")).into())
    } else {
        Ok(())
    }
}

fn months_elapsed(from: Option<Date>, to: Date) -> u32 {
    let Some(from) = from else {
        return 0;
    };
    let month_delta = (to.year() - from.year()) * 12
        + (i32::from(u8::from(to.month())) - i32::from(u8::from(from.month())));
    let adjusted = if to.day() < from.day() {
        month_delta - 1
    } else {
        month_delta
    };
    u32::try_from(adjusted.max(0)).unwrap_or(0)
}
