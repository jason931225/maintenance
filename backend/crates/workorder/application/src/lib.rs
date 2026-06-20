//! Work-order application layer.
//!
//! Commands, ports, and audit-event builders live here. Persistence, SQL,
//! runtime, and HTTP concerns remain in outer crates.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::future::Future;
use std::pin::Pin;

use mnt_kernel_core::{
    AuditAction, AuditEvent, BranchId, CustomerId, DailyPlanId, EquipmentId, KernelError, OrgId,
    SiteId, Timestamp, TraceContext, UserId, VendorId, WorkOrderId,
};
use mnt_workorder_domain::{AssignmentRole, PriorityLevel, WorkOrderStatus, WorkResultType};
use serde::{Deserialize, Serialize};
use time::Date;

// ISO calendar-date (`YYYY-MM-DD`) serde for `Date` fields exposed on the wire.
// The default `time::Date` serde shape is a structured array, which mismatches
// the OpenAPI `Date` contract (`type: string, format: date`) and the ISO strings
// clients send/expect.
time::serde::format_description!(iso_date, Date, "[year]-[month]-[day]");

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

pub type WorkOrderCreatedFuture<'a> =
    Pin<Box<dyn Future<Output = Result<(), KernelError>> + Send + 'a>>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkOrderCreatedEvent {
    pub actor: UserId,
    pub branch_id: BranchId,
    pub work_order_id: WorkOrderId,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

pub trait WorkOrderCreatedListener: Send + Sync {
    fn work_order_created(&self, event: WorkOrderCreatedEvent) -> WorkOrderCreatedFuture<'_>;
}

/// Result type returned by the future oyatie cloud intelligence seam.
pub type AiAssistantResult<T> = Result<T, AiAssistantPortError>;

/// Boxed async result used to keep [`AiAssistantPort`] dyn-compatible without
/// adding an adapter dependency or async-trait macro.
pub type AiAssistantFuture<'a, T> = Pin<Box<dyn Future<Output = AiAssistantResult<T>> + Send + 'a>>;

/// Human-entered symptom text and optional observation time for AI diagnosis.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MaintenanceSymptom {
    pub description: String,
    pub observed_at: Option<Timestamp>,
}

/// Equipment model facts sent to oyatie cloud intelligence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EquipmentModelRef {
    pub manufacturer: Option<String>,
    pub model_name: String,
    pub tonnage: Option<String>,
    pub power_source: Option<String>,
}

/// One procedure step suggested by the future oyatie-backed assistant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcedureStep {
    pub sequence: u16,
    pub instruction: String,
    pub safety_note: Option<String>,
}

/// Checklist returned by the diagnosis seam.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcedureChecklist {
    pub title: String,
    pub steps: Vec<ProcedureStep>,
    pub safety_notices: Vec<String>,
}

/// Work-order facts available to the future report-drafting seam.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkOrderReportContext {
    pub work_order_id: WorkOrderId,
    pub equipment_id: EquipmentId,
    pub symptom: String,
    pub diagnosis: Option<String>,
    pub action_taken: Option<String>,
    pub evidence_notes: Vec<String>,
}

/// Draft text returned by the future oyatie-backed report writer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReportDraft {
    pub summary: String,
    pub diagnosis: String,
    pub action_taken: String,
    pub follow_up: Option<String>,
}

/// Errors exposed by the intelligence seam.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AiAssistantPortError {
    Unavailable(String),
    InvalidRequest(String),
    ContractViolation(String),
}

impl std::fmt::Display for AiAssistantPortError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable(message) => write!(f, "intelligence provider unavailable: {message}"),
            Self::InvalidRequest(message) => write!(f, "invalid intelligence request: {message}"),
            Self::ContractViolation(message) => {
                write!(f, "intelligence provider contract violation: {message}")
            }
        }
    }
}

impl std::error::Error for AiAssistantPortError {}

/// Port for the deferred oyatie cloud intelligence integration.
///
/// The contract intentionally lives in the work-order application layer: the
/// assistant operates on work-order diagnosis and report-drafting use cases,
/// while the real oyatie adapter will live outside this crate. ADR-0010 keeps
/// the feature absent until that adapter exists.
///
/// The future oyatie-cloud adapter is expected to:
/// - treat `symptom.description` and work-order text as untrusted operator
///   input;
/// - return ordered Korean checklist/report text suitable for review, not an
///   automatic state transition;
/// - preserve the caller's work-order/equipment identifiers for audit
///   correlation outside this port.
///
/// ```
/// use mnt_workorder_application::AiAssistantPort;
///
/// fn accepts_oyatie_seam(_port: &dyn AiAssistantPort) {}
/// ```
pub trait AiAssistantPort: Send + Sync {
    fn diagnose<'a>(
        &'a self,
        symptom: MaintenanceSymptom,
        equipment_model: EquipmentModelRef,
    ) -> AiAssistantFuture<'a, ProcedureChecklist>;

    fn draft_report<'a>(
        &'a self,
        context: WorkOrderReportContext,
    ) -> AiAssistantFuture<'a, ReportDraft>;
}

#[cfg(test)]
mod ai_assistant_port_contract_tests {
    use super::*;

    fn accepts_dyn_port(_port: &dyn AiAssistantPort) {}

    #[test]
    fn ai_assistant_port_is_object_safe() {
        let _: fn(&dyn AiAssistantPort) = accepts_dyn_port;
    }

    #[test]
    fn diagnosis_contract_carries_symptom_and_equipment_model() {
        let symptom = MaintenanceSymptom {
            description: "mast raises slowly under load".to_owned(),
            observed_at: None,
        };
        let model = EquipmentModelRef {
            manufacturer: Some("Toyota".to_owned()),
            model_name: "8FG25".to_owned(),
            tonnage: Some("2.5".to_owned()),
            power_source: Some("LPG".to_owned()),
        };
        let checklist = ProcedureChecklist {
            title: "Hydraulic lift inspection".to_owned(),
            steps: vec![ProcedureStep {
                sequence: 1,
                instruction: "Check hydraulic oil level and visible leaks".to_owned(),
                safety_note: Some("Lower forks before inspection".to_owned()),
            }],
            safety_notices: vec!["Use lockout procedure before touching mast".to_owned()],
        };

        assert_eq!(symptom.description, "mast raises slowly under load");
        assert_eq!(model.model_name, "8FG25");
        assert_eq!(checklist.steps[0].sequence, 1);
    }

    #[test]
    fn report_draft_contract_carries_work_order_context() {
        let context = WorkOrderReportContext {
            work_order_id: WorkOrderId::new(),
            equipment_id: EquipmentId::new(),
            symptom: "engine stalls after warm-up".to_owned(),
            diagnosis: Some("fuel delivery interruption".to_owned()),
            action_taken: Some("cleaned fuel filter".to_owned()),
            evidence_notes: vec!["after photo uploaded".to_owned()],
        };
        let draft = ReportDraft {
            summary: "Fuel delivery issue inspected".to_owned(),
            diagnosis: "fuel filter contamination".to_owned(),
            action_taken: "cleaned filter and confirmed idle stability".to_owned(),
            follow_up: Some("replace filter at next planned service".to_owned()),
        };

        assert!(!context.symptom.is_empty());
        assert_eq!(
            draft.action_taken,
            "cleaned filter and confirmed idle stability"
        );
    }
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
    #[serde(with = "iso_date")]
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
    .with_branch(branch_id)
    .with_org(OrgId::knl()))
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
    .with_branch(branch_id)
    .with_org(OrgId::knl()))
}
