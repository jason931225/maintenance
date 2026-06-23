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

/// Rename a region.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateRegionCommand {
    pub actor: UserId,
    pub region_id: RegionId,
    pub name: Option<String>,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

/// Soft-delete (deactivate) a region. Refused while the region still has active
/// branches (referential guard) — the adapter returns a `Conflict`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeactivateRegionCommand {
    pub actor: UserId,
    pub region_id: RegionId,
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

/// Soft-delete (deactivate) a branch. Refused while the branch still has active
/// users or non-terminal equipment (referential guard) — the adapter returns a
/// `Conflict`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeactivateBranchCommand {
    pub actor: UserId,
    pub branch_id: BranchId,
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
    /// Zero-based row offset into the scope-ordered roster for offset
    /// pagination. `None` starts at the first page.
    pub offset: Option<i64>,
}

/// One page of users plus the unpaged `total` for the caller's branch scope, so
/// the console can show an honest count and page beyond the per-request cap.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserPage {
    pub items: Vec<UserSummary>,
    pub limit: i64,
    pub offset: i64,
    pub total: i64,
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

/// Derived account-setup state for the console roster.
///
/// `is_active` alone is insufficient: a freshly-created user (admin issued an OTP
/// but the user has not yet enrolled a passkey) is `is_active = true` yet cannot
/// actually sign in. The console must show "활성" ONLY once the account is set up
/// with a credential, so this enum distinguishes the pending-setup state from the
/// fully-active one. It is derived (never stored): see `account_status_for`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AccountStatus {
    /// Active AND has at least one enrolled passkey — can sign in.
    Active,
    /// Active but has NO passkey yet — created / OTP-issued, awaiting enrollment.
    PendingSetup,
    /// Soft-deactivated — sign-in is blocked regardless of credentials.
    Deactivated,
}

/// Derive the console account status from the row flag + credential presence.
#[must_use]
pub fn account_status_for(is_active: bool, has_passkey: bool) -> AccountStatus {
    match (is_active, has_passkey) {
        (false, _) => AccountStatus::Deactivated,
        (true, true) => AccountStatus::Active,
        (true, false) => AccountStatus::PendingSetup,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserSummary {
    pub id: UserId,
    pub display_name: String,
    pub phone: Option<String>,
    pub team: Option<Team>,
    pub roles: Vec<String>,
    pub branch_ids: Vec<BranchId>,
    pub is_active: bool,
    /// Whether the user has at least one enrolled passkey credential. A user can
    /// only actually sign in once this is true; until then they are pending setup.
    pub has_passkey: bool,
    /// Derived setup state (`is_active` + `has_passkey`) for the console badge.
    pub account_status: AccountStatus,
    pub created_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegionSummary {
    pub id: RegionId,
    pub name: String,
    /// `Some` when the region has been soft-deleted (deactivated); `None` for an
    /// active region. Active-only listings filter these out.
    pub deactivated_at: Option<Timestamp>,
    pub created_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BranchSummary {
    pub id: BranchId,
    pub region_id: RegionId,
    pub name: String,
    /// `Some` when the branch has been soft-deleted (deactivated); `None` for an
    /// active branch. Active-only listings filter these out.
    pub deactivated_at: Option<Timestamp>,
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
