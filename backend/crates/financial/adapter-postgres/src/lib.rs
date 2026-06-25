//! Postgres financial adapter.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use mnt_financial_application::{
    AppendCostLedgerEntryCommand, AssetLifecycleCostSummary, CostLedgerEntrySummary,
    CostLedgerSource, CreatePurchaseRequestCommand, CreateRentalQuoteCommand,
    ExecutePurchaseCommand, FinancialConfigSnapshot, PrepareExpenditureCommand,
    PurchaseApprovalCommand, PurchaseRequestSummary, PurchaseRestartCommand, PurchaseSubmitCommand,
    RejectPurchaseCommand, RentalQuoteSummary, financial_audit_event,
};
use mnt_financial_domain::{
    AcquisitionAnchor, MoneyInput, PurchaseActor, PurchaseStatus, PurchaseTransition,
    RentalQuoteInput, ResidualRecomputeInput, compute_rental_quote, cost_per_hour_won,
    cost_per_month_won, gross_margin_won, recompute_residual_value, tco_won,
    validate_purchase_transition,
};
use mnt_kernel_core::{
    AuditEvent, BranchId, EquipmentId, KernelError, PurchaseRequestId, QuoteId, UserId, WorkOrderId,
};
use mnt_platform_db::{DbError, with_audit, with_audits, with_org_conn};
use mnt_platform_request_context::current_org;
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

    #[must_use]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub async fn create_rental_quote(
        &self,
        command: CreateRentalQuoteCommand,
    ) -> Result<RentalQuoteSummary, PgFinancialError> {
        let quote_id = QuoteId::new();
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let event = financial_audit_event(
            "financial.quote.create",
            command.actor,
            command.branch_id,
            "financial_rental_quote",
            quote_id,
            command.trace,
            command.occurred_at,
        )?
        .with_org(org);

        with_audit::<_, RentalQuoteSummary, PgFinancialError>(&self.pool, event, |tx| {
            Box::pin(async move {
                let equipment = equipment_economics_tx(tx, command.equipment_id).await?;
                ensure_branch(equipment.branch_id, command.branch_id)?;
                let vehicle_value_won = equipment.require_vehicle_value()?;
                let cumulative_repair_cost =
                    cumulative_cost_tx(tx, command.equipment_id, None).await?;
                let quote = compute_rental_quote(RentalQuoteInput {
                    acquisition_value: MoneyInput::won(vehicle_value_won),
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
                    vehicle_value_won,
                    equipment.residual_value_won,
                    cumulative_repair_cost,
                    &command.config,
                    &quote,
                    command.occurred_at,
                    org_uuid,
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
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let event = financial_audit_event(
            "purchase.statement.attach",
            command.actor,
            command.branch_id,
            "financial_purchase_request",
            purchase_request_id,
            command.trace,
            command.occurred_at,
        )?
        .with_org(org);

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
                .bind(org_uuid)
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
                    org_uuid,
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
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let event = financial_audit_event(
            "purchase.restart",
            command.actor,
            event_purchase.branch_id,
            "financial_purchase_request",
            command.purchase_request_id,
            command.trace,
            command.occurred_at,
        )?
        .with_org(org);

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
                    org_uuid,
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
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        with_audits::<_, PurchaseRequestSummary, PgFinancialError>(&self.pool, org, |tx| {
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
                    org_uuid,
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
                    org_uuid,
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

    pub async fn lifecycle_cost_for_equipment(
        &self,
        equipment_id: EquipmentId,
    ) -> Result<AssetLifecycleCostSummary, PgFinancialError> {
        lifecycle_cost_for_equipment(&self.pool, equipment_id).await
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

        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        with_audits::<_, CostLedgerEntrySummary, PgFinancialError>(&self.pool, org, |tx| {
            Box::pin(async move {
                let (entry, event) =
                    append_cost_ledger_entry_tx(tx, command, purchase_request_id, org_uuid).await?;
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
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let event = financial_audit_event(
            action,
            actor,
            purchase.branch_id,
            "financial_purchase_request",
            purchase_request_id,
            trace,
            occurred_at,
        )?
        .with_org(org);

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

                // ── Deferred WORM compliance gate (SUBMIT only) ───────────────
                // A purchase may be CREATED against still-replicating evidence,
                // but it must not enter the approval pipeline until the linked
                // 거래명세표 is durably preserved (worm_replica_status VERIFIED).
                // Guarded strictly on the submit target so the check never leaks
                // into approve/execute/reject, which share this method.
                if to == PurchaseStatus::RequestSubmitted {
                    ensure_statement_evidence_verified_tx(tx, row.statement_evidence_id).await?;
                }

                // ── Segregation-of-duties: self-approval block ────────────────
                // Only applies on genuine approval transitions (admin or executive
                // sign-off). Submission and execution are exempt from this guard.
                if matches!(
                    to,
                    PurchaseStatus::AdminApproved | PurchaseStatus::ReadyToExecute
                ) {
                    check_self_approval_tx(
                        tx,
                        actor,
                        purchase_request_id,
                        org_uuid,
                        action,
                    )
                    .await?;
                }

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
                    org_uuid,
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
    /// Depreciation acquisition base. `None` for a bare asset that carries no
    /// `vehicle_value`; read paths that only need `branch_id` (e.g. the
    /// lifecycle-cost endpoint's branch lookup) tolerate this, while the
    /// depreciation/quote write paths demand it via
    /// [`EquipmentEconomics::require_vehicle_value`].
    vehicle_value_won: Option<i64>,
    residual_value_won: i64,
    asset_registered_on: Option<Date>,
}

impl EquipmentEconomics {
    /// The depreciation acquisition base, required by the quote/residual write
    /// paths. A bare asset with no `vehicle_value` cannot be depreciated, so this
    /// is a validation error there — but it is NEVER reached by the read paths
    /// that only need `branch_id`.
    fn require_vehicle_value(&self) -> Result<i64, PgFinancialError> {
        self.vehicle_value_won
            .ok_or_else(|| KernelError::validation("equipment vehicle value is required").into())
    }
}

#[derive(Debug, Clone)]
struct LockedPurchase {
    branch_id: BranchId,
    equipment_id: EquipmentId,
    work_order_id: Option<WorkOrderId>,
    statement_evidence_id: mnt_kernel_core::EvidenceId,
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
    let org = current_org().map_err(KernelError::from)?;
    let row = with_org_conn::<_, _, PgFinancialError>(pool, org, move |tx| {
        Box::pin(async move {
            Ok(sqlx::query(
                r#"
        SELECT branch_id, vehicle_value, residual_value, asset_registered_on
        FROM registry_equipment
        WHERE id = $1
        "#,
            )
            .bind(*equipment_id.as_uuid())
            .fetch_optional(tx.as_mut())
            .await?)
        })
    })
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
        // Kept OPTIONAL on purpose: a bare acquisition-only asset (vehicle_value
        // NULL) must still resolve its branch for the lifecycle-cost read. Only
        // the depreciation/quote write paths demand it (require_vehicle_value).
        vehicle_value_won,
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
    org_uuid: uuid::Uuid,
) -> Result<(CostLedgerEntrySummary, AuditEvent), PgFinancialError> {
    let locked = equipment_economics_tx(tx, command.equipment_id).await?;
    ensure_branch(locked.branch_id, command.branch_id)?;
    if let Some(work_order_id) = command.work_order_id {
        ensure_work_order_matches_tx(tx, work_order_id, command.branch_id, command.equipment_id)
            .await?;
    }

    let vehicle_value_won = locked.require_vehicle_value()?;
    let previous_cost = cumulative_cost_tx(tx, command.equipment_id, None).await?;
    let cumulative_cost = previous_cost.saturating_add(command.amount_won);
    let months_elapsed = months_elapsed(locked.asset_registered_on, command.occurred_at.date());
    let residual_after = recompute_residual_value(ResidualRecomputeInput {
        acquisition_value: MoneyInput::won(vehicle_value_won),
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
    .bind(org_uuid)
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

/// Scope-check the statement evidence linked to a purchase request WITHOUT
/// requiring the WORM replica to be verified.
///
/// This is the create/restart-time check. It still enforces that the evidence is
/// REQUEST-stage 거래명세표 belonging to the same branch/equipment/work-order as
/// the purchase — the financial-scope invariants — but it deliberately does NOT
/// require `worm_replica_status == 'VERIFIED'`. The WORM-replica state is set
/// asynchronously by the replication worker (`replicate_once`), with no retry
/// driver, so a still-replicating (PENDING/FAILED) replica must not permanently
/// bar a legitimate purchase request from being *created*. The durable-WORM
/// precondition is instead enforced at SUBMIT (see
/// [`ensure_statement_evidence_verified_tx`]), the first state that promotes the
/// request into the approval pipeline. No money or ledger entry moves until
/// `execute_purchase`, so a StatementAttached row referencing not-yet-verified
/// evidence carries no financial-integrity risk.
async fn ensure_statement_evidence_tx(
    tx: &mut Transaction<'_, Postgres>,
    evidence_id: mnt_kernel_core::EvidenceId,
    branch_id: BranchId,
    equipment_id: EquipmentId,
    expected_work_order_id: Option<WorkOrderId>,
) -> Result<StatementEvidenceLink, PgFinancialError> {
    let row = sqlx::query(
        r#"
        SELECT e.work_order_id, e.stage,
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
    if stage != "REQUEST" {
        return Err(
            KernelError::validation("statement evidence must be REQUEST-stage evidence").into(),
        );
    }

    Ok(StatementEvidenceLink { work_order_id })
}

/// Assert the linked statement evidence's WORM replica is durably VERIFIED.
///
/// The deferred compliance gate enforced at SUBMIT: a purchase request may be
/// created against still-replicating evidence, but it may not enter the approval
/// pipeline until the 거래명세표 is durably preserved under COMPLIANCE retention
/// (`worm_replica_status == 'VERIFIED'`). Surfaces a clear caller-facing reason so
/// the operator learns the request is waiting on WORM verification rather than
/// seeing a silent failure.
async fn ensure_statement_evidence_verified_tx(
    tx: &mut Transaction<'_, Postgres>,
    evidence_id: mnt_kernel_core::EvidenceId,
) -> Result<(), PgFinancialError> {
    let status: Option<String> =
        sqlx::query_scalar("SELECT worm_replica_status FROM evidence_media WHERE id = $1")
            .bind(*evidence_id.as_uuid())
            .fetch_optional(tx.as_mut())
            .await?;
    let status =
        status.ok_or_else(|| KernelError::not_found("statement evidence was not found"))?;
    if status != "VERIFIED" {
        return Err(KernelError::validation(
            "거래명세표가 아직 보존 검증 중입니다. 잠시 후 다시 상신하세요. \
             (statement evidence is still being WORM-verified)",
        )
        .into());
    }
    Ok(())
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
    org_uuid: uuid::Uuid,
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
    .bind(org_uuid)
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
        .bind(org_uuid)
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
    // Both reads (the quote and its lines) run in ONE tenant-scoped transaction
    // so they are consistent and both narrowed to the request's org by RLS.
    let org = current_org().map_err(KernelError::from)?;
    let (row, lines) = with_org_conn::<_, _, PgFinancialError>(pool, org, move |tx| {
        Box::pin(async move {
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
            .fetch_optional(tx.as_mut())
            .await?
            .ok_or_else(|| KernelError::not_found("rental quote was not found"))?;
            let lines = quote_lines_tx(tx, quote_id).await?;
            Ok((row, lines))
        })
    })
    .await?;
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

async fn lock_purchase_tx(
    tx: &mut Transaction<'_, Postgres>,
    purchase_request_id: PurchaseRequestId,
) -> Result<LockedPurchase, PgFinancialError> {
    let row = sqlx::query(
        r#"
        SELECT branch_id, equipment_id, work_order_id, statement_evidence_id,
               status, amount_won,
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
        statement_evidence_id: mnt_kernel_core::EvidenceId::from_uuid(
            row.try_get("statement_evidence_id")?,
        ),
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
    let org = current_org().map_err(KernelError::from)?;
    let row = with_org_conn::<_, _, PgFinancialError>(pool, org, move |tx| {
        Box::pin(async move {
            Ok(sqlx::query(purchase_select_sql())
                .bind(*purchase_request_id.as_uuid())
                .fetch_optional(tx.as_mut())
                .await?)
        })
    })
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
    org_uuid: uuid::Uuid,
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
    .bind(org_uuid)
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
    let org = current_org().map_err(KernelError::from)?;
    let rows = with_org_conn::<_, _, PgFinancialError>(pool, org, move |tx| {
        Box::pin(async move {
            Ok(sqlx::query(
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
            .fetch_all(tx.as_mut())
            .await?)
        })
    })
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

/// Per-asset lifecycle / TCO rollup.
///
/// Every SELECT runs inside ONE `with_org_conn` closure so `app.current_org` is
/// armed once and the `org_isolation` RLS policy narrows every tenant table in
/// the same transaction — no cross-tenant leak. `current_org()` fails closed
/// (unset GUC -> `MissingOrg`), and the bare pool is never used as an executor
/// (only `tx.as_mut()`), so the rls-arming gate is satisfied.
///
/// Tenancy notes per table: `registry_equipment`, `equipment_cost_ledger`, and
/// `sales_listings` are RLS-FORCED on `org_id` and filter themselves. The
/// `outsource_works` table has NO `org_id`/RLS of its own; it is reached only
/// through `work_orders` (RLS-FORCED), so joining outsource -> work_orders ->
/// this asset keeps the outsource read tenant-scoped. Outsource cost is surfaced
/// read-only and is NEVER summed into `tco_won` (double-count guard).
async fn lifecycle_cost_for_equipment(
    pool: &PgPool,
    equipment_id: EquipmentId,
) -> Result<AssetLifecycleCostSummary, PgFinancialError> {
    let org = current_org().map_err(KernelError::from)?;
    let equipment_uuid = *equipment_id.as_uuid();
    let (master, source_totals, outsource, sale, timeline) =
        with_org_conn::<_, _, PgFinancialError>(pool, org, move |tx| {
            Box::pin(async move {
                // Equipment master: acquisition fact + depreciation base + hours
                // + status + equipment_no. RLS limits this to the armed tenant.
                let master = sqlx::query(
                    r#"
        SELECT equipment_no, status, acquisition_cost_won, acquisition_date,
               vehicle_value, residual_value, hours
        FROM registry_equipment
        WHERE id = $1
        "#,
                )
                .bind(equipment_uuid)
                .fetch_optional(tx.as_mut())
                .await?;

                // Σ maintenance split by source, plus a single total + entry
                // count, off the per-asset cost spine.
                let source_totals = sqlx::query(
                    r#"
        SELECT source, COALESCE(SUM(amount_won), 0)::BIGINT AS total_won, COUNT(*)::BIGINT AS entry_count
        FROM equipment_cost_ledger
        WHERE equipment_id = $1
        GROUP BY source
        "#,
                )
                .bind(equipment_uuid)
                .fetch_all(tx.as_mut())
                .await?;

                // Outsource cost is reached ONLY through work_orders (which is
                // RLS-FORCED), so the join inherits tenant isolation even though
                // outsource_works itself has no org_id.
                let outsource: Option<i64> = sqlx::query_scalar(
                    r#"
        SELECT COALESCE(SUM(ow.cost_won), 0)::BIGINT
        FROM outsource_works ow
        JOIN work_orders wo ON wo.id = ow.work_order_id
        WHERE wo.equipment_id = $1
          AND ow.cost_won IS NOT NULL
        "#,
                )
                .bind(equipment_uuid)
                .fetch_one(tx.as_mut())
                .await?;

                // Latest realized sale price for a SOLD listing on this asset.
                let sale = sqlx::query(
                    r#"
        SELECT price_won, updated_at
        FROM sales_listings
        WHERE equipment_id = $1 AND status = 'SOLD'
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
        "#,
                )
                .bind(equipment_uuid)
                .fetch_optional(tx.as_mut())
                .await?;

                let timeline = sqlx::query(
                    r#"
        SELECT id, branch_id, equipment_id, work_order_id, purchase_request_id,
               source, amount_won, memo, residual_before_won, residual_after_won,
               entry_at
        FROM equipment_cost_ledger
        WHERE equipment_id = $1
        ORDER BY entry_at DESC, id DESC
        "#,
                )
                .bind(equipment_uuid)
                .fetch_all(tx.as_mut())
                .await?;

                Ok((master, source_totals, outsource, sale, timeline))
            })
        })
        .await?;

    let master = master.ok_or_else(|| KernelError::not_found("equipment was not found"))?;
    let equipment_no: String = master.try_get("equipment_no")?;
    let status: String = master.try_get("status")?;
    let acquisition_cost_won: Option<i64> = master.try_get("acquisition_cost_won")?;
    let acquisition_date: Option<Date> = master.try_get("acquisition_date")?;
    let vehicle_value_won: Option<i64> = master.try_get("vehicle_value")?;
    let residual_value_won: Option<i64> = master.try_get("residual_value")?;
    let hours: Option<i64> = master.try_get("hours")?;

    // Split Σ maintenance by source. Slice 0 surfaces only the existing sources;
    // `maintenance_total_won` is the sum across ALL ledger rows so a future
    // source still rolls into the total without code changes here.
    let mut manual_total_won = 0_i64;
    let mut purchase_total_won = 0_i64;
    let mut maintenance_total_won = 0_i64;
    let mut entry_count = 0_i64;
    for row in &source_totals {
        let source: String = row.try_get("source")?;
        let total_won: i64 = row.try_get("total_won")?;
        let count: i64 = row.try_get("entry_count")?;
        maintenance_total_won = maintenance_total_won.saturating_add(total_won);
        entry_count = entry_count.saturating_add(count);
        match CostLedgerSource::from_db_str(&source)? {
            CostLedgerSource::ManualAdmin => manual_total_won = total_won,
            CostLedgerSource::PurchaseExecution => purchase_total_won = total_won,
        }
    }

    let outsource_unlinked_won = match outsource {
        Some(value) if value > 0 => Some(value),
        _ => None,
    };

    let (sale_price_won, sold_at) = match sale {
        Some(row) => {
            let price: Option<i64> = row.try_get("price_won")?;
            let updated_at: OffsetDateTime = row.try_get("updated_at")?;
            (price, Some(updated_at.date()))
        }
        None => (None, None),
    };

    let anchor = AcquisitionAnchor::resolve(acquisition_cost_won, vehicle_value_won);
    let tco_total = tco_won(anchor, maintenance_total_won);
    let gross_margin = gross_margin_won(sale_price_won, tco_total);
    let months_since_acquisition = acquisition_date.map(months_between);
    let cost_per_month = cost_per_month_won(maintenance_total_won, months_since_acquisition);
    let cost_per_hour = cost_per_hour_won(maintenance_total_won, hours);

    let timeline = timeline
        .iter()
        .map(cost_ledger_from_row)
        .collect::<Result<Vec<_>, _>>()?;

    Ok(AssetLifecycleCostSummary {
        equipment_id,
        equipment_no,
        status,
        acquisition_cost_won,
        acquisition_date,
        acquisition_source: anchor.basis,
        maintenance_total_won,
        manual_total_won,
        purchase_total_won,
        entry_count,
        outsource_unlinked_won,
        residual_value_won: residual_value_won.unwrap_or(0),
        sale_price_won,
        sold_at,
        gross_margin_won: gross_margin,
        tco_won: tco_total,
        cost_per_month_won: cost_per_month,
        cost_per_hour_won: cost_per_hour,
        timeline,
    })
}

/// Whole calendar months elapsed from `acquisition` to today (UTC), floored at
/// the day granularity. A future acquisition date yields a negative span, which
/// the per-month math treats as "unknown" (returns `None`) rather than a
/// quotient.
fn months_between(acquisition: Date) -> i64 {
    let today = OffsetDateTime::now_utc().date();
    let mut months = (i64::from(today.year()) - i64::from(acquisition.year())) * 12
        + (i64::from(u8::from(today.month())) - i64::from(u8::from(acquisition.month())));
    if today.day() < acquisition.day() {
        months -= 1;
    }
    months
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

/// Segregation-of-duties: self-approval guard.
///
/// Blocks an approver from approving a purchase request they themselves
/// originated (requested_by) or submitted (submitted_by). The only exceptions
/// are the org 대표/CEO (`is_org_lead = true`) and SUPER_ADMIN — because no
/// higher approver exists in the chain for these roles.
///
/// Even when the exception is allowed, a governance finding is written to
/// `governance_findings` so the self-approval is recorded and visible to
/// EXECUTIVE / SUPER_ADMIN on the integrity dashboard. Allowed ≠ invisible.
async fn check_self_approval_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    actor: UserId,
    purchase_request_id: PurchaseRequestId,
    org_uuid: uuid::Uuid,
    action: &str,
) -> Result<(), PgFinancialError> {
    // Fetch requested_by and submitted_by for this purchase.
    let row = sqlx::query(
        r#"
        SELECT requested_by, submitted_by
        FROM financial_purchase_requests
        WHERE id = $1
        "#,
    )
    .bind(*purchase_request_id.as_uuid())
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| KernelError::not_found("purchase request was not found"))?;

    let requested_by: uuid::Uuid = row.try_get("requested_by")?;
    let submitted_by: Option<uuid::Uuid> = row.try_get("submitted_by")?;
    let actor_uuid = *actor.as_uuid();

    let is_self_approval =
        actor_uuid == requested_by || submitted_by.is_some_and(|s| s == actor_uuid);

    if !is_self_approval {
        return Ok(());
    }

    // Actor is self-approving. Check if they are the 대표 or SUPER_ADMIN.
    let user_row = sqlx::query(
        r#"
        SELECT roles, is_org_lead
        FROM users
        WHERE id = $1
        "#,
    )
    .bind(actor_uuid)
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| KernelError::not_found("approving user was not found"))?;

    let roles: Vec<String> = user_row.try_get("roles")?;
    let is_org_lead: bool = user_row.try_get("is_org_lead")?;
    let is_super_admin = roles.iter().any(|r| r == "SUPER_ADMIN");

    let is_exempt = is_org_lead || is_super_admin;

    if !is_exempt {
        // Hard block: 422 Validation error.
        return Err(KernelError::validation("본인이 상신/요청한 건은 결재할 수 없습니다").into());
    }

    // Allowed exception: 대표 or SUPER_ADMIN self-approving.
    // Write a governance finding so this is audited and visible on the
    // integrity dashboard. The finding is idempotent (ON CONFLICT DO UPDATE).
    let finding_id = uuid::Uuid::new_v4();
    let detector_id = "anomaly.self_approval";
    let entity_type = "financial_purchase_request";
    let entity_id = purchase_request_id.as_uuid().to_string();
    let exemption_reason = if is_super_admin {
        "super_admin_exempt"
    } else {
        "org_lead_exempt"
    };
    let evidence = serde_json::json!({
        "action": action,
        "requested_by": requested_by.to_string(),
        "submitted_by": submitted_by.map(|u| u.to_string()),
        "approver": actor_uuid.to_string(),
        "exemption_reason": exemption_reason,
    });
    let now = OffsetDateTime::now_utc();

    sqlx::query(
        r#"
        INSERT INTO governance_findings
            (id, org_id, detector_id, entity_type, entity_id,
             subject_user_id, score, severity, evidence, status, detected_at, created_at, updated_at)
        VALUES
            ($1, $2, $3, $4, $5, $6, 1.0, 'HIGH', $7, 'OPEN', $8, $8, $8)
        ON CONFLICT (org_id, detector_id, entity_type, entity_id) DO UPDATE
            SET score = EXCLUDED.score,
                severity = EXCLUDED.severity,
                evidence = EXCLUDED.evidence,
                status = 'OPEN',
                detected_at = EXCLUDED.detected_at,
                updated_at = EXCLUDED.updated_at
        "#,
    )
    .bind(finding_id)
    .bind(org_uuid)
    .bind(detector_id)
    .bind(entity_type)
    .bind(entity_id)
    .bind(actor_uuid)
    .bind(sqlx::types::Json(&evidence))
    .bind(now)
    .execute(tx.as_mut())
    .await?;

    Ok(())
}
