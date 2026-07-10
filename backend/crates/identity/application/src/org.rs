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
    /// Explicit HR employee-directory link. Never inferred by name.
    pub employee_id: Option<uuid::Uuid>,
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
    /// `Some(None)` clears the employee link; `Some(Some(_))` sets it; `None` leaves it.
    pub employee_id: Option<Option<uuid::Uuid>>,
    /// `Some(None)` clears the phone; `Some(Some(_))` sets it; `None` leaves it.
    pub phone: Option<Option<String>>,
    /// `Some(None)` clears the team; `Some(Some(_))` sets it; `None` leaves it.
    pub team: Option<Option<Team>>,
    /// Replacement role set (canonical DB strings) when `Some`.
    pub roles: Option<Vec<String>>,
    /// Replacement branch-membership set when `Some`.
    pub branch_ids: Option<Vec<BranchId>>,
    /// Short-lived impact-preview receipt required for role/scope replacements.
    pub preview_receipt_id: Option<uuid::Uuid>,
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

/// Reactivate a previously archived user. Credentials are not recreated here;
/// a reactivated account without passkeys returns to `PENDING_SETUP`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivateUserCommand {
    pub actor: UserId,
    pub user_id: UserId,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

/// Create one tenant-owned custom role definition. Definitions are persisted,
/// audited, versioned, and become runtime-effective only through ACTIVE
/// custom-role assignments resolved by the platform authz layer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreatePolicyRoleCommand {
    pub actor: UserId,
    pub role_key: String,
    pub display_name: String,
    pub description: Option<String>,
    pub permissions: Vec<PolicyRolePermission>,
    pub conditions: Vec<PolicyRoleCondition>,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

/// Change a tenant-owned custom role definition lifecycle state. Publishing or
/// rolling back a role is a sensitive policy action: the REST layer must require
/// a fresh passkey step-up before constructing this command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdatePolicyRoleStatusCommand {
    pub actor: UserId,
    pub role_id: uuid::Uuid,
    pub status: String,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

/// Update mutable metadata and policy surface for a tenant-owned custom role.
/// The role key is immutable; changing permissions/conditions is a sensitive
/// policy action and must be guarded by REST-layer passkey step-up.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdatePolicyRoleCommand {
    pub actor: UserId,
    pub role_id: uuid::Uuid,
    pub display_name: String,
    pub description: Option<String>,
    pub permissions: Vec<PolicyRolePermission>,
    pub conditions: Vec<PolicyRoleCondition>,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

/// Replace a user's custom-role assignments. ACTIVE custom roles become
/// runtime-effective on the user's next resolved request principal; DRAFT and
/// RETIRED roles remain audit/planning data only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplacePolicyRoleAssignmentsCommand {
    pub actor: UserId,
    pub user_id: UserId,
    pub role_ids: Vec<uuid::Uuid>,
    pub preview_receipt_id: uuid::Uuid,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

/// Persist a short-lived receipt for the exact assignment preview the actor saw.
/// The write path consumes this server-side receipt only if the mutable
/// authorization baseline still matches under the write transaction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreatePolicyAssignmentPreviewReceiptCommand {
    pub actor: UserId,
    pub user_id: UserId,
    pub current_branch_ids: Vec<uuid::Uuid>,
    pub current_system_roles: Vec<String>,
    pub current_role_ids: Vec<uuid::Uuid>,
    pub branch_ids: Vec<uuid::Uuid>,
    pub system_roles: Vec<String>,
    pub role_ids: Vec<uuid::Uuid>,
    pub policy_version: i64,
    pub expires_at: Timestamp,
}

/// Server-side receipt proving an actor reviewed a policy assignment preview
/// for one exact target user and normalized role set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicyAssignmentPreviewReceiptSummary {
    pub id: uuid::Uuid,
    pub expires_at: Timestamp,
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
/// with a credential, so this enum distinguishes pending setup from the
/// fully-active state and the archived/보관 lifecycle state. It is derived (never
/// stored): see `account_status_for`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AccountStatus {
    /// Active AND has at least one enrolled passkey — can sign in.
    Active,
    /// Active but has NO passkey yet — created / OTP-issued, awaiting enrollment.
    PendingSetup,
    /// Archived/보관 — sign-in is blocked regardless of credentials.
    Archived,
}

/// Derive the console account status from the row flag + credential presence.
#[must_use]
pub fn account_status_for(is_active: bool, has_passkey: bool) -> AccountStatus {
    match (is_active, has_passkey) {
        (false, _) => AccountStatus::Archived,
        (true, true) => AccountStatus::Active,
        (true, false) => AccountStatus::PendingSetup,
    }
}

/// Whether a platform account is explicitly linked to an HR employee record.
/// The absence of a link is a first-class state; the system must not silently
/// infer one from display name because Korean names often collide in real data.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EmployeeLinkStatus {
    Linked,
    Unlinked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserSummary {
    pub id: UserId,
    pub display_name: String,
    pub employee_id: Option<uuid::Uuid>,
    pub employee_name: Option<String>,
    pub employee_number: Option<String>,
    pub employee_company: Option<String>,
    pub employee_org_unit: Option<String>,
    pub employee_position: Option<String>,
    pub employee_identity_review_required: Option<bool>,
    pub employee_identity_resolution_confidence: Option<String>,
    pub employee_link_status: EmployeeLinkStatus,
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

/// One permission cell in a custom role definition. Keys are canonical snake-case
/// `Feature` and `PermissionLevel` strings validated at the REST boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicyRolePermission {
    pub feature_key: String,
    pub permission_level: String,
}

/// One ABAC/PBAC condition attached to a custom role definition. Runtime
/// authorization currently consumes branch equals/in as scope narrowers and team
/// equals/in as live user-attribute matches; unsupported conditions fail closed
/// at authorization time while remaining visible for preview/audit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicyRoleCondition {
    pub condition_key: String,
    pub attribute: String,
    pub operator: String,
    pub values: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicyRoleSummary {
    pub id: uuid::Uuid,
    pub role_key: String,
    pub display_name: String,
    pub description: Option<String>,
    pub status: String,
    pub is_system: bool,
    pub permissions: Vec<PolicyRolePermission>,
    pub conditions: Vec<PolicyRoleCondition>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicyRoleAssignmentSummary {
    pub user_id: UserId,
    pub role_id: uuid::Uuid,
    pub role_key: String,
    pub display_name: String,
    pub status: String,
    pub assigned_by: Option<UserId>,
    pub created_at: Timestamp,
}

/// Per-tenant monotonic policy revision used by the future effective-policy
/// resolver cache. A missing DB row means no custom policy write has occurred,
/// so read APIs surface version 0 without mutating on read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicyVersionSummary {
    pub version: i64,
    pub updated_at: Option<Timestamp>,
}

/// Append-only policy audit evidence visible from Policy Studio.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicyAuditEventSummary {
    pub id: uuid::Uuid,
    pub actor: Option<UserId>,
    pub action: String,
    pub target_type: String,
    pub target_id: String,
    pub before_snapshot: Option<serde_json::Value>,
    pub after_snapshot: Option<serde_json::Value>,
    pub trace_id: String,
    pub span_id: String,
    pub occurred_at: Timestamp,
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

/// Build a custom-role policy audit event. Role policy changes are org-global;
/// the permission diff is stored in snapshots by the adapter.
pub fn policy_role_audit_event(
    action: &str,
    actor: Option<UserId>,
    role_id: uuid::Uuid,
    trace: TraceContext,
    occurred_at: Timestamp,
) -> Result<AuditEvent, KernelError> {
    Ok(AuditEvent::new(
        actor,
        AuditAction::new(action)?,
        "policy_role",
        role_id.to_string(),
        trace,
        occurred_at,
    ))
}

/// Build a custom-role assignment audit event. The target is the user whose
/// custom-role assignment set changed.
pub fn policy_role_assignment_audit_event(
    action: &str,
    actor: Option<UserId>,
    user_id: UserId,
    trace: TraceContext,
    occurred_at: Timestamp,
) -> Result<AuditEvent, KernelError> {
    Ok(AuditEvent::new(
        actor,
        AuditAction::new(action)?,
        "policy_role_assignment",
        user_id.to_string(),
        trace,
        occurred_at,
    ))
}

/// Build a policy-audit row for account/person lifecycle and authorization-scope
/// mutations. These `policy.*` rows are the evidence stream consumed by Policy
/// Studio audit chips; general `user.*` rows remain the operational audit trail.
pub fn policy_account_audit_event(
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
