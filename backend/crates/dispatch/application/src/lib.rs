//! Dispatch application layer: commands, DTOs, and audit-event builders.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use mnt_dispatch_domain::{DispatchResponseKind, DispatchStatus};
use mnt_kernel_core::{
    AuditAction, AuditEvent, BranchId, KernelError, P1DispatchId, Timestamp, TraceContext, UserId,
    WorkOrderId,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct IncidentLocationInput {
    pub latitude: f64,
    pub longitude: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StartP1DispatchCommand {
    pub actor: UserId,
    pub work_order_id: WorkOrderId,
    pub incident_location: Option<IncidentLocationInput>,
    pub include_region: bool,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RespondP1DispatchCommand {
    pub actor: UserId,
    pub dispatch_id: P1DispatchId,
    pub response: DispatchResponseKind,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExpireP1DispatchCommand {
    pub dispatch_id: P1DispatchId,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForceAssignP1DispatchCommand {
    pub actor: UserId,
    pub dispatch_id: P1DispatchId,
    pub mechanic_id: UserId,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct P1DispatchSummary {
    pub id: P1DispatchId,
    pub work_order_id: WorkOrderId,
    pub branch_id: BranchId,
    pub status: DispatchStatus,
    pub incident_location: Option<IncidentLocationInput>,
    pub accept_window_started_at: Timestamp,
    pub accept_window_ends_at: Timestamp,
    pub auto_assigned_mechanic_id: Option<UserId>,
    pub manager_force_pending_at: Option<Timestamp>,
    pub target_count: i64,
    pub accepted_count: i64,
    pub declined_count: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct P1DispatchResponseSummary {
    pub dispatch_id: P1DispatchId,
    pub user_id: UserId,
    pub response: DispatchResponseKind,
    pub responded_at: Timestamp,
    pub score_milli: Option<i64>,
    pub gps_ranked: bool,
    pub distance_meters: Option<i64>,
    pub score_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct P1DispatchTargetSummary {
    pub dispatch_id: P1DispatchId,
    pub user_id: UserId,
    pub role: String,
    pub push_token_count: i64,
}

pub fn dispatch_audit_event(
    action: &str,
    actor: Option<UserId>,
    branch_id: BranchId,
    dispatch_id: P1DispatchId,
    trace: TraceContext,
    occurred_at: Timestamp,
) -> Result<AuditEvent, KernelError> {
    Ok(AuditEvent::new(
        actor,
        AuditAction::new(action)?,
        "p1_dispatch",
        dispatch_id.to_string(),
        trace,
        occurred_at,
    )
    .with_branch(branch_id))
}

#[must_use]
pub fn start_after_snapshot(
    work_order_id: WorkOrderId,
    target_count: i64,
    include_region: bool,
) -> serde_json::Value {
    serde_json::json!({
        "work_order_id": work_order_id,
        "status": DispatchStatus::Broadcasting,
        "target_count": target_count,
        "include_region": include_region,
    })
}

#[must_use]
pub fn response_after_snapshot(response: DispatchResponseKind) -> serde_json::Value {
    serde_json::json!({
        "response": response,
    })
}

#[must_use]
pub fn resolution_after_snapshot(
    status: DispatchStatus,
    accepted_count: i64,
    mechanic_id: Option<UserId>,
) -> serde_json::Value {
    serde_json::json!({
        "status": status,
        "accepted_count": accepted_count,
        "assigned_mechanic_id": mechanic_id,
    })
}
