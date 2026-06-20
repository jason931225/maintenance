//! Financial application layer.
//!
//! Commands, summaries, and audit-event builders live here. Persistence and
//! HTTP concerns remain in outer crates.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use mnt_financial_domain::{
    DepreciationMethod, FinancialConfig, MoneyInput, PurchaseStatus, QuoteLine,
};
use mnt_kernel_core::{
    AuditAction, AuditEvent, BranchId, EquipmentId, EvidenceId, KernelError, PurchaseRequestId,
    QuoteId, Timestamp, TraceContext, UserId, WorkOrderId,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FinancialConfigSnapshot {
    pub depreciation_method: DepreciationMethod,
    pub useful_life_months: u32,
    pub residual_rate_bps: i32,
    pub declining_balance_rate_bps: i32,
    pub management_fee_rate_bps: i32,
    pub profit_rate_bps: i32,
    pub floor_negative_quote_residual: bool,
    pub executive_approval_threshold_won: i64,
}

impl FinancialConfigSnapshot {
    #[must_use]
    pub fn quote_config(&self) -> FinancialConfig {
        FinancialConfig {
            depreciation_method: self.depreciation_method,
            useful_life_months: self.useful_life_months,
            residual_rate_bps: self.residual_rate_bps,
            declining_balance_rate_bps: self.declining_balance_rate_bps,
            management_fee_rate_bps: self.management_fee_rate_bps,
            profit_rate_bps: self.profit_rate_bps,
            floor_negative_quote_residual: self.floor_negative_quote_residual,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateRentalQuoteCommand {
    pub actor: UserId,
    pub branch_id: BranchId,
    pub equipment_id: EquipmentId,
    pub config: FinancialConfigSnapshot,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CostLedgerSource {
    ManualAdmin,
    PurchaseExecution,
}

impl CostLedgerSource {
    #[must_use]
    pub const fn as_db_str(self) -> &'static str {
        match self {
            Self::ManualAdmin => "MANUAL_ADMIN",
            Self::PurchaseExecution => "PURCHASE_EXECUTION",
        }
    }

    pub fn from_db_str(value: &str) -> Result<Self, KernelError> {
        match value {
            "MANUAL_ADMIN" => Ok(Self::ManualAdmin),
            "PURCHASE_EXECUTION" => Ok(Self::PurchaseExecution),
            other => Err(KernelError::validation(format!(
                "unknown cost ledger source {other:?}"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppendCostLedgerEntryCommand {
    pub actor: UserId,
    pub branch_id: BranchId,
    pub equipment_id: EquipmentId,
    pub work_order_id: Option<WorkOrderId>,
    pub source: CostLedgerSource,
    pub amount_won: i64,
    pub memo: String,
    pub config: FinancialConfigSnapshot,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreatePurchaseRequestCommand {
    pub actor: UserId,
    pub branch_id: BranchId,
    pub equipment_id: EquipmentId,
    pub work_order_id: Option<WorkOrderId>,
    pub statement_evidence_id: EvidenceId,
    pub vendor_name: String,
    pub amount_won: i64,
    pub memo: String,
    pub config: FinancialConfigSnapshot,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PurchaseSubmitCommand {
    pub actor: UserId,
    pub purchase_request_id: PurchaseRequestId,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PurchaseApprovalCommand {
    pub actor: UserId,
    pub purchase_request_id: PurchaseRequestId,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrepareExpenditureCommand {
    pub actor: UserId,
    pub purchase_request_id: PurchaseRequestId,
    pub expenditure_no: String,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RejectPurchaseCommand {
    pub actor: UserId,
    pub purchase_request_id: PurchaseRequestId,
    pub memo: String,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PurchaseRestartCommand {
    pub actor: UserId,
    pub purchase_request_id: PurchaseRequestId,
    pub statement_evidence_id: EvidenceId,
    pub amount_won: i64,
    pub memo: String,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecutePurchaseCommand {
    pub actor: UserId,
    pub purchase_request_id: PurchaseRequestId,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RentalQuoteSummary {
    pub id: QuoteId,
    pub branch_id: BranchId,
    pub equipment_id: EquipmentId,
    pub acquisition_value: MoneyInput,
    pub current_residual_value: MoneyInput,
    pub effective_residual_value: MoneyInput,
    pub residual_was_floored: bool,
    pub cumulative_repair_cost: MoneyInput,
    pub monthly_total: MoneyInput,
    pub lines: Vec<QuoteLine>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CostLedgerEntrySummary {
    pub id: uuid::Uuid,
    pub branch_id: BranchId,
    pub equipment_id: EquipmentId,
    pub work_order_id: Option<WorkOrderId>,
    pub purchase_request_id: Option<PurchaseRequestId>,
    pub source: CostLedgerSource,
    pub amount_won: i64,
    pub memo: String,
    pub residual_before_won: i64,
    pub residual_after_won: i64,
    #[serde(with = "time::serde::rfc3339")]
    pub entry_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PurchaseRequestSummary {
    pub id: PurchaseRequestId,
    pub branch_id: BranchId,
    pub equipment_id: EquipmentId,
    pub work_order_id: Option<WorkOrderId>,
    pub statement_evidence_id: EvidenceId,
    pub vendor_name: String,
    pub amount_won: i64,
    pub status: PurchaseStatus,
    pub expenditure_no: Option<String>,
    pub rejection_memo: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: Timestamp,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: Timestamp,
}

pub fn financial_audit_event(
    action: &str,
    actor: UserId,
    branch_id: BranchId,
    target_type: &str,
    target_id: impl ToString,
    trace: TraceContext,
    occurred_at: Timestamp,
) -> Result<AuditEvent, KernelError> {
    Ok(AuditEvent::new(
        Some(actor),
        AuditAction::new(action)?,
        target_type,
        target_id.to_string(),
        trace,
        occurred_at,
    )
    .with_branch(branch_id))
}
