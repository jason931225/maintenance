//! Org-setup application layer: commands, query DTOs, read models, and audit
//! event builders for users, regions, and branches.
//!
//! Roles travel as canonical DB role strings (`SUPER_ADMIN`, `ADMIN`, …). The
//! REST boundary parses and authorizes them against the `mnt-platform-authz`
//! matrix; this layer stays free of that platform dependency to satisfy the
//! layer-boundary gate.

use mnt_identity_domain::Team;
use mnt_kernel_core::{
    AuditAction, AuditEvent, BranchId, KernelError, RegionId, Timestamp, TraceContext, UserId,
};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Create a user and (optionally) attach branch memberships in one transaction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateUserCommand {
    /// Acting administrator (audited).
    pub actor: UserId,
    pub display_name: String,
    pub phone: Option<String>,
    pub team: Option<Team>,
    /// Canonical DB role strings, already validated at the REST boundary.
    pub roles: Vec<String>,
    /// Branch memberships to insert into `user_branches`.
    pub branch_ids: Vec<BranchId>,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

/// Partial update of a user's profile, roles, and/or branch memberships. A
/// `None` field is left unchanged; `Some` replaces it wholesale.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateUserCommand {
    pub actor: UserId,
    pub user_id: UserId,
    pub display_name: Option<String>,
    /// `Some(None)` clears the phone; `Some(Some(_))` sets it; `None` leaves it.
    pub phone: Option<Option<String>>,
    /// `Some(None)` clears the team; `Some(Some(_))` sets it; `None` leaves it.
    pub team: Option<Option<Team>>,
    /// Replacement role set (canonical DB strings) when `Some`.
    pub roles: Option<Vec<String>>,
    /// Replacement branch-membership set when `Some`.
    pub branch_ids: Option<Vec<BranchId>>,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

/// Self-service profile edit available to every authenticated user. Limited to
/// non-privileged fields (no role/branch escalation).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateSelfProfileCommand {
    pub user_id: UserId,
    pub display_name: Option<String>,
    /// `Some(None)` clears the phone; `Some(Some(_))` sets it; `None` leaves it.
    pub phone: Option<Option<String>>,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

/// Deactivate (soft-disable) a user. Sign-in is gated on `is_active`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeactivateUserCommand {
    pub actor: UserId,
    pub user_id: UserId,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

/// Create a region.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateRegionCommand {
    pub actor: UserId,
    pub name: String,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

/// Create a branch inside a region.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateBranchCommand {
    pub actor: UserId,
    pub region_id: RegionId,
    pub name: String,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

/// Rename a branch and/or move it to a different region.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateBranchCommand {
    pub actor: UserId,
    pub branch_id: BranchId,
    pub region_id: Option<RegionId>,
    pub name: Option<String>,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/// Branch-scoped user listing. The adapter resolves the caller's scope and only
/// returns users that share at least one in-scope branch (or all users for a
/// cross-branch caller).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserListQuery {
    pub include_inactive: bool,
    /// Page size; the adapter clamps to `1..=200` and defaults a missing value.
    pub limit: Option<i64>,
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserSummary {
    pub id: UserId,
    pub display_name: String,
    pub phone: Option<String>,
    pub team: Option<Team>,
    pub roles: Vec<String>,
    pub branch_ids: Vec<BranchId>,
    pub is_active: bool,
    pub created_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegionSummary {
    pub id: RegionId,
    pub name: String,
    pub created_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BranchSummary {
    pub id: BranchId,
    pub region_id: RegionId,
    pub name: String,
    pub created_at: Timestamp,
}

// ---------------------------------------------------------------------------
// Audit builders
// ---------------------------------------------------------------------------

/// Build a user-management audit event. User management is org-global (a user
/// can span branches), so no `branch_id` is attached; the role/branch changes
/// live in the snapshots.
pub fn user_audit_event(
    action: &str,
    actor: Option<UserId>,
    user_id: UserId,
    trace: TraceContext,
    occurred_at: Timestamp,
) -> Result<AuditEvent, KernelError> {
    Ok(AuditEvent::new(
        actor,
        AuditAction::new(action)?,
        "user",
        user_id.to_string(),
        trace,
        occurred_at,
    ))
}

/// Build a region-management audit event (org-global).
pub fn region_audit_event(
    action: &str,
    actor: Option<UserId>,
    region_id: RegionId,
    trace: TraceContext,
    occurred_at: Timestamp,
) -> Result<AuditEvent, KernelError> {
    Ok(AuditEvent::new(
        actor,
        AuditAction::new(action)?,
        "region",
        region_id.to_string(),
        trace,
        occurred_at,
    ))
}

/// Build a branch-management audit event, scoped to the branch.
pub fn branch_audit_event(
    action: &str,
    actor: Option<UserId>,
    branch_id: BranchId,
    trace: TraceContext,
    occurred_at: Timestamp,
) -> Result<AuditEvent, KernelError> {
    Ok(AuditEvent::new(
        actor,
        AuditAction::new(action)?,
        "branch",
        branch_id.to_string(),
        trace,
        occurred_at,
    )
    .with_branch(branch_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_audit_event_is_org_global() {
        let event = user_audit_event(
            "user.create",
            Some(UserId::new()),
            UserId::new(),
            TraceContext::generate(),
            Timestamp::now_utc(),
        )
        .unwrap();
        assert!(event.branch_id.is_none());
        assert_eq!(event.target_type, "user");
    }

    #[test]
    fn branch_audit_event_carries_branch_scope() {
        let branch = BranchId::new();
        let event = branch_audit_event(
            "branch.create",
            Some(UserId::new()),
            branch,
            TraceContext::generate(),
            Timestamp::now_utc(),
        )
        .unwrap();
        assert_eq!(event.branch_id, Some(branch));
    }
}
