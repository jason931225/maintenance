//! Inspection application layer.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use mnt_inspection_domain::{InspectionCycle, InspectionRoundOutcome, InspectionScheduleStatus};
use mnt_kernel_core::{
    AuditAction, AuditEvent, BranchId, BranchScope, EquipmentId, InspectionRoundId,
    InspectionScheduleId, KernelError, Timestamp, TraceContext, UserId,
};
use serde::{Deserialize, Serialize};
use time::Date;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateInspectionScheduleCommand {
    pub actor: UserId,
    pub branch_id: BranchId,
    pub equipment_id: EquipmentId,
    pub mechanic_id: UserId,
    pub cycle: InspectionCycle,
    pub interval_days: i32,
    pub due_date: Date,
    pub note: Option<String>,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompleteInspectionRoundCommand {
    pub actor: UserId,
    pub schedule_id: InspectionScheduleId,
    pub outcome: InspectionRoundOutcome,
    pub completed_at: Timestamp,
    pub findings: String,
    pub note: Option<String>,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListInspectionSchedulesQuery {
    pub branch_scope: BranchScope,
    pub due_start: Date,
    pub due_end: Date,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InspectionScheduleSummary {
    pub id: InspectionScheduleId,
    pub branch_id: BranchId,
    pub equipment_id: EquipmentId,
    pub mechanic_id: UserId,
    pub cycle: InspectionCycle,
    pub interval_days: i32,
    pub due_date: Date,
    pub status: InspectionScheduleStatus,
    pub completed_at: Option<Timestamp>,
    pub note: Option<String>,
    pub site_name: String,
    pub management_no: Option<String>,
    pub model: Option<String>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InspectionRoundSummary {
    pub id: InspectionRoundId,
    pub schedule_id: InspectionScheduleId,
    pub branch_id: BranchId,
    pub equipment_id: EquipmentId,
    pub mechanic_id: UserId,
    pub completed_by: UserId,
    pub outcome: InspectionRoundOutcome,
    pub findings: String,
    pub note: Option<String>,
    pub completed_at: Timestamp,
}

pub fn inspection_audit_event(
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
