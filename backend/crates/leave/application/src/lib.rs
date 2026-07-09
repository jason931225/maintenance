//! Leave-request application contracts.
//!
//! Command/query shapes for the branch-scoped approval queue, the decide
//! mutation (with the leave-ledger write-back on approve), the balance roster,
//! and the §61 statutory push. Every scoping field that identifies the actor or
//! the tenant is bound by the REST layer from the authenticated principal, never
//! from request input. Branch scope is passed through from the resolved
//! [`BranchScope`](BranchScope) so the queue only ever
//! narrows to the caller's branches.
//!
//! The statutory push is a producer of two side effects it does not own: it
//! delivers a receipt-gated document into the target's 개인 수신함 (via the inbox
//! crate's `InboxDocSink`) and — once the 연차촉진 submittable definition exists —
//! starts an engine AP- run. Those integrations live in the REST/adapter layer;
//! this crate only defines the command shapes and views.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use mnt_kernel_core::{
    AuditAction, AuditEvent, BranchScope, Date, KernelError, LeavePromotionId, LeaveRequestId,
    Timestamp, TraceContext, UserId,
};
use mnt_leave_domain::{LeaveDecision, LeaveStatus, LeaveType, NewLeaveRequest, PromotionKind};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Create (crate-level write port — no public REST route)
// ---------------------------------------------------------------------------

/// Create a pending leave request. Not a public REST endpoint: requests are
/// produced by the 기안/engine compose flow (submittable-templates, gap #1) or a
/// roster import, which call this port with the mapping they own. `branch_id`
/// and `requester_user_id` come from the producer's trusted context; the
/// `subject_employee_id` is the employee whose balance an approval will move.
#[derive(Debug, Clone)]
pub struct CreateLeaveRequestCommand {
    pub branch_id: Uuid,
    pub requester_user_id: UserId,
    pub subject_employee_id: Uuid,
    pub request: NewLeaveRequest,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

// ---------------------------------------------------------------------------
// Queue read
// ---------------------------------------------------------------------------

/// List the branch-scoped approval queue. Pending-first, newest-first.
#[derive(Debug, Clone)]
pub struct ListLeaveRequestsQuery {
    /// Resolved from the principal; passed opaquely to the data layer which
    /// narrows the query to these branches (deny-by-omission on empty scope).
    pub branch_scope: BranchScope,
    /// When set, only requests in this status; otherwise all four.
    pub status: Option<LeaveStatus>,
    pub limit: i64,
}

// ---------------------------------------------------------------------------
// Decide
// ---------------------------------------------------------------------------

/// Decide a pending leave request. The `decider` is bound from the principal;
/// the adapter enforces SoD (the decider must not be the request's requester)
/// and that only a `pending` request can be decided. On `approve`, the leave
/// ledger write-back (used += days, remaining -= days on the subject employee)
/// happens in the SAME audited transaction as the status change.
#[derive(Debug, Clone)]
pub struct DecideLeaveRequestCommand {
    pub request_id: LeaveRequestId,
    pub decider: UserId,
    pub branch_scope: BranchScope,
    pub decision: LeaveDecision,
    pub comment: Option<String>,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

// ---------------------------------------------------------------------------
// Statutory push (촉진 / 노무수령거부)
// ---------------------------------------------------------------------------

/// Serve a §61 statutory push to a target employee. The adapter records the
/// push, delivers the receipt-gated notice into the target's 개인 수신함, and
/// (when a submittable definition exists) starts the engine AP- run. `round`
/// applies to a promotion (1|2); a refusal follows round 2. `target_user_id` is
/// the inbox recipient (the target employee's linked account).
#[derive(Debug, Clone)]
pub struct StatutoryPushCommand {
    pub actor: UserId,
    pub branch_id: Uuid,
    pub target_user_id: UserId,
    pub target_employee_id: Uuid,
    pub target_name: String,
    pub kind: PromotionKind,
    pub round: i16,
    /// Unused annual-leave days that motivate the push, surfaced in the notice.
    pub unused_days: f64,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/// One row of the approval queue (결재함 leave variant).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeaveRequestView {
    pub id: LeaveRequestId,
    pub branch_id: Uuid,
    pub requester_user_id: UserId,
    pub subject_employee_id: Uuid,
    pub leave_type: LeaveType,
    pub days: f64,
    #[serde(with = "date_fmt")]
    pub start_date: Date,
    #[serde(with = "date_fmt")]
    pub end_date: Date,
    pub reason: String,
    pub status: LeaveStatus,
    pub decided_by: Option<UserId>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub decided_at: Option<Timestamp>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision_comment: Option<String>,
    /// The engine AP- run started for a statutory push, when one exists.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ap_run_id: Option<Uuid>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeaveRequestPage {
    pub items: Vec<LeaveRequestView>,
}

/// Closed set for the balance roster's urgency/promotion bucket.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LeaveBalanceTone {
    /// Normal balance.
    Ok,
    /// Mostly unused balance that should be promoted for statutory use.
    Promote,
    /// Nearly exhausted balance.
    Low,
}

/// One employee's balance row (직원별 연차 현황). `left` is derived here so the
/// client never recomputes it. `tone` mirrors the prototype's ok/promote/low
/// bucketing so the bar color and the 촉진 flag come from the backend.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeaveBalanceView {
    pub employee_id: Uuid,
    pub name: String,
    pub team: Option<String>,
    pub grant: f64,
    pub used: f64,
    pub left: f64,
    /// `low` (mostly used), `promote` (mostly unused → 촉진 대상), or `ok`.
    pub tone: LeaveBalanceTone,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeaveBalancePage {
    pub items: Vec<LeaveBalanceView>,
}

/// Closed set for the engine-submission state attached to a statutory push.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApSubmission {
    /// The engine AP- run was started.
    Submitted,
    /// The push is recorded but waiting for the engine submittable definition.
    PendingEngineDefinition,
}

/// The result of a statutory push. `inbox_doc_id` is the receipt-gated document
/// delivered to the target (always present — the concrete legal delivery).
/// `ap_run_id` is the engine submission; `None` until the 연차촉진 submittable
/// definition exists (gap #1), in which case `ap_submission` explains the state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StatutoryPushView {
    pub id: LeavePromotionId,
    pub kind: PromotionKind,
    pub round: i16,
    pub target_user_id: UserId,
    pub inbox_doc_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ap_run_id: Option<Uuid>,
    /// `submitted` when an engine run was started, else `pending_engine_definition`.
    pub ap_submission: ApSubmission,
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/// Build a leave-request audit event (`leave_request.*`). The adapter attaches
/// org + before/after snapshots.
pub fn leave_request_audit_event(
    action: &str,
    actor: Option<UserId>,
    target_id: LeaveRequestId,
    trace: TraceContext,
    occurred_at: Timestamp,
) -> Result<AuditEvent, KernelError> {
    Ok(AuditEvent::new(
        actor,
        AuditAction::new(action)?,
        "leave_request",
        target_id.to_string(),
        trace,
        occurred_at,
    ))
}

/// Build a statutory-push audit event (`leave_promotion.*`).
pub fn leave_promotion_audit_event(
    action: &str,
    actor: Option<UserId>,
    target_id: LeavePromotionId,
    trace: TraceContext,
    occurred_at: Timestamp,
) -> Result<AuditEvent, KernelError> {
    Ok(AuditEvent::new(
        actor,
        AuditAction::new(action)?,
        "leave_promotion",
        target_id.to_string(),
        trace,
        occurred_at,
    ))
}

/// `time::Date` wire format (`YYYY-MM-DD`), shared by the request views.
mod date_fmt {
    use mnt_kernel_core::Date;
    use serde::{self, Deserialize, Deserializer, Serializer};
    use time::format_description::well_known::Iso8601;

    pub fn serialize<S: Serializer>(date: &Date, ser: S) -> Result<S::Ok, S::Error> {
        let s = date
            .format(&Iso8601::DATE)
            .map_err(serde::ser::Error::custom)?;
        ser.serialize_str(&s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(de: D) -> Result<Date, D::Error> {
        let s = String::deserialize(de)?;
        Date::parse(&s, &Iso8601::DATE).map_err(serde::de::Error::custom)
    }
}
