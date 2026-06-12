//! Work-order application layer.
//!
//! Commands, ports, and audit-event builders live here. Persistence, SQL,
//! runtime, and HTTP concerns remain in outer crates.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use mnt_kernel_core::{
    AuditAction, AuditEvent, BranchId, CustomerId, DailyPlanId, EquipmentId, KernelError, SiteId,
    Timestamp, TraceContext, UserId, VendorId, WorkOrderId,
};
use mnt_workorder_domain::{AssignmentRole, PriorityLevel, WorkOrderStatus, WorkResultType};
use serde::{Deserialize, Serialize};
use time::Date;

macro_rules! application_enum {
    (
        $(#[$enum_meta:meta])*
        pub enum $name:ident {
            $(
                $(#[$variant_meta:meta])*
                $variant:ident => $wire:literal
            ),+ $(,)?
        }
    ) => {
        $(#[$enum_meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(rename_all = "SCREAMING_SNAKE_CASE")]
        pub enum $name {
            $(
                $(#[$variant_meta])*
                $variant,
            )+
        }

        impl $name {
            #[must_use]
            pub const fn as_db_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $wire,)+
                }
            }

            pub fn from_db_str(value: &str) -> Result<Self, KernelError> {
                match value {
                    $($wire => Ok(Self::$variant),)+
                    other => Err(KernelError::validation(format!(
                        "unknown {} value {other:?}",
                        stringify!($name)
                    ))),
                }
            }
        }
    };
}

application_enum! {
    pub enum TargetChangeStatus {
        Requested => "REQUESTED",
        Approved => "APPROVED",
        Rejected => "REJECTED",
    }
}

application_enum! {
    pub enum TargetChangeDecision {
        Approved => "APPROVED",
        Rejected => "REJECTED",
    }
}

impl From<TargetChangeDecision> for TargetChangeStatus {
    fn from(value: TargetChangeDecision) -> Self {
        match value {
            TargetChangeDecision::Approved => Self::Approved,
            TargetChangeDecision::Rejected => Self::Rejected,
        }
    }
}

application_enum! {
    pub enum DailyPlanStatus {
        Draft => "DRAFT",
        Requested => "REQUESTED",
        Approved => "APPROVED",
        Rejected => "REJECTED",
        FinalConfirmed => "FINAL_CONFIRMED",
    }
}

application_enum! {
    pub enum OutsourceWorkStatus {
        Requested => "REQUESTED",
        Assigned => "ASSIGNED",
        InProgress => "IN_PROGRESS",
        ResultSubmitted => "RESULT_SUBMITTED",
        Completed => "COMPLETED",
        Cancelled => "CANCELLED",
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateWorkOrderCommand {
    pub actor: UserId,
    pub branch_id: BranchId,
    pub management_no: String,
    pub symptom: String,
    pub customer_request: Option<String>,
    pub target_due_at: Option<Timestamp>,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdatePriorityCommand {
    pub actor: UserId,
    pub work_order_id: WorkOrderId,
    pub priority: PriorityLevel,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssignmentInput {
    pub mechanic_id: UserId,
    pub role: AssignmentRole,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkOrderAssignmentCommand {
    pub actor: UserId,
    pub work_order_id: WorkOrderId,
    pub assignments: Vec<AssignmentInput>,
    pub admin_approver_id: Option<UserId>,
    pub executive_approver_id: Option<UserId>,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkOrderStartCommand {
    pub actor: UserId,
    pub work_order_id: WorkOrderId,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubmitReportCommand {
    pub actor: UserId,
    pub work_order_id: WorkOrderId,
    pub result_type: WorkResultType,
    pub diagnosis: String,
    pub action_taken: String,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkOrderApprovalCommand {
    pub actor: UserId,
    pub work_order_id: WorkOrderId,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RejectWorkOrderCommand {
    pub actor: UserId,
    pub work_order_id: WorkOrderId,
    pub memo: String,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TargetChangeRequestCommand {
    pub actor: UserId,
    pub work_order_id: WorkOrderId,
    pub requested_target_due_at: Timestamp,
    pub reason: String,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewTargetChangeCommand {
    pub actor: UserId,
    pub request_id: uuid::Uuid,
    pub decision: TargetChangeDecision,
    pub memo: Option<String>,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DailyPlanItemInput {
    pub work_order_id: Option<WorkOrderId>,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateDailyPlanCommand {
    pub actor: UserId,
    pub branch_id: BranchId,
    pub mechanic_id: UserId,
    pub plan_date: Date,
    pub items: Vec<DailyPlanItemInput>,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SendDailyPlanForReviewCommand {
    pub actor: UserId,
    pub plan_id: DailyPlanId,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewDailyPlanCommand {
    pub actor: UserId,
    pub plan_id: DailyPlanId,
    pub decision: DailyPlanStatus,
    pub memo: Option<String>,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateOutsourceWorkCommand {
    pub actor: UserId,
    pub work_order_id: WorkOrderId,
    pub vendor_name: String,
    pub vendor_contact: Option<String>,
    pub reason: String,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkOrderSummary {
    pub id: WorkOrderId,
    pub request_no: String,
    pub branch_id: BranchId,
    pub equipment_id: EquipmentId,
    pub customer_id: CustomerId,
    pub site_id: SiteId,
    pub status: WorkOrderStatus,
    pub priority: PriorityLevel,
    pub result_type: WorkResultType,
    pub evidence_verified: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TargetChangeRequestSummary {
    pub id: uuid::Uuid,
    pub work_order_id: WorkOrderId,
    pub branch_id: BranchId,
    pub requested_target_due_at: Timestamp,
    pub status: TargetChangeStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DailyPlanSummary {
    pub id: DailyPlanId,
    pub branch_id: BranchId,
    pub mechanic_id: UserId,
    pub plan_date: Date,
    pub status: DailyPlanStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutsourceWorkSummary {
    pub id: uuid::Uuid,
    pub work_order_id: WorkOrderId,
    pub vendor_id: VendorId,
    pub vendor_name: String,
    pub status: OutsourceWorkStatus,
}

pub fn work_order_audit_event(
    action: &str,
    actor: UserId,
    branch_id: BranchId,
    work_order_id: WorkOrderId,
    trace: TraceContext,
    occurred_at: Timestamp,
) -> Result<AuditEvent, KernelError> {
    Ok(AuditEvent::new(
        Some(actor),
        AuditAction::new(action)?,
        "work_order",
        work_order_id.to_string(),
        trace,
        occurred_at,
    )
    .with_branch(branch_id))
}

pub fn daily_plan_audit_event(
    action: &str,
    actor: UserId,
    branch_id: BranchId,
    plan_id: DailyPlanId,
    trace: TraceContext,
    occurred_at: Timestamp,
) -> Result<AuditEvent, KernelError> {
    Ok(AuditEvent::new(
        Some(actor),
        AuditAction::new(action)?,
        "daily_work_plan",
        plan_id.to_string(),
        trace,
        occurred_at,
    )
    .with_branch(branch_id))
}
