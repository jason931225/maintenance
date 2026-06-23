//! Branch-scoped authorization policy engine.
//!
//! The policy has two independent gates:
//! 1. feature permission from the inherited role matrix;
//! 2. resource `branch_id` membership from the kernel [`BranchScope`].
//!
//! Both gates default-deny. Repository adapters should use [`repository_filter`]
//! when listing branch-scoped rows so missing scope checks are difficult to
//! express accidentally.

use std::collections::BTreeSet;
use std::str::FromStr;

use mnt_kernel_core::{BranchId, BranchScope, KernelError, OrgId, UserId};
use sqlx::PgPool;

/// Canonical role codes stored in `users.roles`.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
)]
pub enum Role {
    #[serde(rename = "SUPER_ADMIN")]
    SuperAdmin,
    #[serde(rename = "ADMIN")]
    Admin,
    #[serde(rename = "MECHANIC")]
    Mechanic,
    #[serde(rename = "RECEPTIONIST")]
    Receptionist,
    #[serde(rename = "EXECUTIVE")]
    Executive,
    /// Lowest-privilege tier. The default role for an open self-service signup
    /// (#38): a freshly self-registered account can sign in but sees almost
    /// nothing until an admin elevates it. Deliberately the bottom of the matrix
    /// (`matrix_index` 0) with `Login` as its only `Allow` cell.
    #[serde(rename = "MEMBER")]
    Member,
}

impl Role {
    pub const ALL: [Self; 6] = [
        Self::Member,
        Self::Receptionist,
        Self::Mechanic,
        Self::Admin,
        Self::Executive,
        Self::SuperAdmin,
    ];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SuperAdmin => "SUPER_ADMIN",
            Self::Admin => "ADMIN",
            Self::Mechanic => "MECHANIC",
            Self::Receptionist => "RECEPTIONIST",
            Self::Executive => "EXECUTIVE",
            Self::Member => "MEMBER",
        }
    }

    const fn matrix_index(self) -> usize {
        match self {
            Self::Member => 0,
            Self::Receptionist => 1,
            Self::Mechanic => 2,
            Self::Admin => 3,
            Self::Executive => 4,
            Self::SuperAdmin => 5,
        }
    }
}

impl FromStr for Role {
    type Err = KernelError;

    fn from_str(raw: &str) -> Result<Self, Self::Err> {
        match raw {
            "SUPER_ADMIN" => Ok(Self::SuperAdmin),
            "ADMIN" => Ok(Self::Admin),
            "MECHANIC" => Ok(Self::Mechanic),
            "RECEPTIONIST" => Ok(Self::Receptionist),
            "EXECUTIVE" => Ok(Self::Executive),
            "MEMBER" => Ok(Self::Member),
            _ => Err(KernelError::validation(format!("unknown role code: {raw}"))),
        }
    }
}

/// Feature/action rows from the inherited permission matrix.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Feature {
    Login,
    WorkOrderCreate,
    WorkOrderEditIntake,
    WorkOrderReadAll,
    WorkOrderStart,
    WorkReportSubmit,
    EvidenceAttach,
    PriorityManage,
    AssigneeManage,
    TargetManage,
    CompletionReview,
    DailyPlanRequest,
    DailyPlanReview,
    KpiRead,
    KpiExclusionManage,
    UserManage,
    SubordinateUserCreate,
    ElevatedRoleGrant,
    /// Create/rename regions (지역) during org setup.
    RegionManage,
    /// Create/rename branches (지점) during org setup.
    BranchManage,
    /// Create/update/soft-delete equipment master rows (지게차) outside the
    /// bulk master-list import path.
    EquipmentManage,
    MasterListImport,
    RentalQuoteManage,
    EquipmentCostLedgerRead,
    EquipmentCostLedgerWrite,
    PurchaseRequestCreate,
    PurchaseRequestRead,
    PurchaseRequestApprove,
    PurchaseFinalApprove,
    PurchaseExecute,
    InspectionScheduleManage,
    InspectionRoundComplete,
    AuditLogRead,
    ExcelDownload,
    /// Read the per-tenant operational dashboard (work-order funnel, SLA risk,
    /// utilization, equipment/substitution rollups). SUPER_ADMIN / ADMIN only —
    /// it surfaces an org-wide operational picture.
    OpsDashboardRead,
    /// Manage the public sales catalog (#6 지게차 매매): create/update/withdraw
    /// used-forklift listings and triage inbound customer inquiries. ADMIN tier.
    SalesManage,
    /// Permission metadata for the future AI assistant seam. T0.6 requires the
    /// 22-feature matrix; this does not implement an AI adapter or demo mode.
    AiAssist,
    /// Read governance findings from the integrity engine.
    /// EXECUTIVE + SUPER_ADMIN only — labor-law sensitivity; an ADMIN must NOT
    /// read findings about themselves or their subordinates.
    IntegrityFindingsRead,
    /// Triage (OPEN → REVIEWED / DISMISSED / ESCALATED) a governance finding.
    /// Gated identically to read; triage is itself audited via `with_audit`.
    IntegrityFindingTriage,
}

impl Feature {
    pub const ALL: [Self; 39] = [
        Self::Login,
        Self::WorkOrderCreate,
        Self::WorkOrderEditIntake,
        Self::WorkOrderReadAll,
        Self::WorkOrderStart,
        Self::WorkReportSubmit,
        Self::EvidenceAttach,
        Self::PriorityManage,
        Self::AssigneeManage,
        Self::TargetManage,
        Self::CompletionReview,
        Self::DailyPlanRequest,
        Self::DailyPlanReview,
        Self::KpiRead,
        Self::KpiExclusionManage,
        Self::UserManage,
        Self::SubordinateUserCreate,
        Self::ElevatedRoleGrant,
        Self::RegionManage,
        Self::BranchManage,
        Self::EquipmentManage,
        Self::MasterListImport,
        Self::RentalQuoteManage,
        Self::EquipmentCostLedgerRead,
        Self::EquipmentCostLedgerWrite,
        Self::PurchaseRequestCreate,
        Self::PurchaseRequestRead,
        Self::PurchaseRequestApprove,
        Self::PurchaseFinalApprove,
        Self::PurchaseExecute,
        Self::InspectionScheduleManage,
        Self::InspectionRoundComplete,
        Self::AuditLogRead,
        Self::ExcelDownload,
        Self::OpsDashboardRead,
        Self::SalesManage,
        Self::AiAssist,
        Self::IntegrityFindingsRead,
        Self::IntegrityFindingTriage,
    ];

    const fn matrix_row(self) -> [PermissionLevel; 6] {
        use PermissionLevel::{Allow as A, Deny as D, Limited as L, RequestOnly as R};

        // Column order matches `Role::matrix_index`:
        // [MEMBER, RECEPTIONIST, MECHANIC, ADMIN, EXECUTIVE, SUPER_ADMIN].
        // MEMBER (the open-signup default) is default-DENY everywhere except
        // `Login`: a self-registered account can authenticate but sees nothing
        // actionable until an admin grants it a real role.
        match self {
            Self::Login => [A, A, A, A, A, A],
            Self::WorkOrderCreate => [D, A, L, A, L, A],
            Self::WorkOrderEditIntake => [D, A, L, A, L, A],
            Self::WorkOrderReadAll => [D, A, A, A, A, A],
            Self::WorkOrderStart => [D, L, A, A, L, A],
            Self::WorkReportSubmit => [D, L, A, A, L, A],
            Self::EvidenceAttach => [D, A, A, A, L, A],
            Self::PriorityManage => [D, D, D, A, D, A],
            Self::AssigneeManage => [D, D, D, A, D, A],
            Self::TargetManage => [D, D, R, A, D, A],
            Self::CompletionReview => [D, D, D, A, D, A],
            Self::DailyPlanRequest => [D, D, A, A, D, A],
            Self::DailyPlanReview => [D, D, D, A, D, A],
            Self::KpiRead => [D, D, D, A, A, A],
            Self::KpiExclusionManage => [D, D, D, A, A, A],
            Self::UserManage => [D, D, D, A, D, A],
            Self::SubordinateUserCreate => [D, D, D, L, D, A],
            Self::ElevatedRoleGrant => [D, D, D, D, D, A],
            Self::RegionManage => [D, D, D, A, A, A],
            Self::BranchManage => [D, D, D, A, A, A],
            Self::EquipmentManage => [D, D, D, A, A, A],
            Self::MasterListImport => [D, D, D, A, D, A],
            Self::RentalQuoteManage => [D, A, D, A, A, A],
            Self::EquipmentCostLedgerRead => [D, D, D, A, A, A],
            Self::EquipmentCostLedgerWrite => [D, D, D, A, D, A],
            Self::PurchaseRequestCreate => [D, A, R, A, D, A],
            Self::PurchaseRequestRead => [D, A, L, A, A, A],
            Self::PurchaseRequestApprove => [D, D, D, A, D, A],
            Self::PurchaseFinalApprove => [D, D, D, D, A, A],
            Self::PurchaseExecute => [D, A, D, A, D, A],
            Self::InspectionScheduleManage => [D, D, D, A, D, A],
            Self::InspectionRoundComplete => [D, D, A, A, D, A],
            Self::AuditLogRead => [D, D, D, A, D, A],
            Self::ExcelDownload => [D, A, A, A, A, A],
            Self::OpsDashboardRead => [D, D, D, A, D, A],
            Self::SalesManage => [D, D, D, A, A, A],
            Self::AiAssist => [D, A, A, A, A, A],
            // Integrity findings are labor-law sensitive: ADMIN must not read
            // findings about themselves. EXECUTIVE + SUPER_ADMIN only.
            Self::IntegrityFindingsRead => [D, D, D, D, A, A],
            Self::IntegrityFindingTriage => [D, D, D, D, A, A],
        }
    }
}

/// Permission-cell semantics from the inherited Korean matrix.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionLevel {
    Deny,
    RequestOnly,
    Limited,
    Allow,
}

impl PermissionLevel {
    const fn satisfies(self, required: Self) -> bool {
        match required {
            Self::Deny => true,
            Self::Allow => matches!(self, Self::Allow),
            Self::Limited => matches!(self, Self::Allow | Self::Limited),
            Self::RequestOnly => matches!(self, Self::Allow | Self::RequestOnly),
        }
    }
}

/// A requested authorization operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Action {
    feature: Feature,
    required: PermissionLevel,
}

impl Action {
    /// Full/direct use of a feature (`가능` cells only).
    #[must_use]
    pub const fn new(feature: Feature) -> Self {
        Self {
            feature,
            required: PermissionLevel::Allow,
        }
    }

    /// Limited feature use (`제한` or `가능` cells).
    #[must_use]
    pub const fn limited(feature: Feature) -> Self {
        Self {
            feature,
            required: PermissionLevel::Limited,
        }
    }

    /// Request-only feature use (`요청 가능` or `가능` cells).
    #[must_use]
    pub const fn request(feature: Feature) -> Self {
        Self {
            feature,
            required: PermissionLevel::RequestOnly,
        }
    }

    #[must_use]
    pub const fn feature(self) -> Feature {
        self.feature
    }

    #[must_use]
    pub const fn required_permission(self) -> PermissionLevel {
        self.required
    }
}

/// Authenticated principal plus its already-resolved branch scope.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Principal {
    pub user_id: UserId,
    /// The tenant this principal belongs to, taken from the verified token's
    /// `org` claim. Used to arm `app.current_org` for RLS on this request.
    pub org_id: OrgId,
    pub roles: BTreeSet<Role>,
    pub branch_scope: BranchScope,
}

impl Principal {
    #[must_use]
    pub const fn new(
        user_id: UserId,
        org_id: OrgId,
        roles: BTreeSet<Role>,
        branch_scope: BranchScope,
    ) -> Self {
        Self {
            user_id,
            org_id,
            roles,
            branch_scope,
        }
    }
}

// ---------------------------------------------------------------------------
// Platform tier — the SaaS-vendor identity ABOVE all tenants.
// ---------------------------------------------------------------------------
//
// The platform tier is a DISTINCT concept from the per-tenant [`Role`]s. It is
// deliberately NOT just another `Role`: a platform actor must never be treated
// as a tenant member, regardless of how many tenant roles exist. Instead a
// platform principal is its own type with its own
// small capability set, and it can NEVER hold a tenant `Role` or be authorized
// for a tenant [`Feature`] (there is no bridge from [`PlatformFeature`] to
// [`Feature`], and [`PlatformPrincipal`] carries no `BranchScope`).

/// Cross-tenant capabilities held only by the platform (SaaS-vendor) tier.
///
/// Every platform action is cross-tenant and must be explicit + audited; a
/// tenant admin can never reach these (the platform extractor rejects a tenant
/// token, and tenant middleware rejects a platform token).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlatformFeature {
    /// Create (onboard) a new tenant organization + seed its first admin.
    TenantCreate,
    /// List all tenants (cross-tenant read).
    TenantList,
    /// Suspend / reactivate a tenant (status change).
    TenantSuspend,
    /// Read a tenant's health/status.
    TenantHealthRead,
    /// Read the platform-tier audit trail.
    PlatformAuditRead,
}

impl PlatformFeature {
    pub const ALL: [Self; 5] = [
        Self::TenantCreate,
        Self::TenantList,
        Self::TenantSuspend,
        Self::TenantHealthRead,
        Self::PlatformAuditRead,
    ];
}

/// An authenticated PLATFORM principal — the SaaS-vendor tier above all tenants.
///
/// It holds NO tenant [`Role`] and NO [`BranchScope`]: a platform principal can
/// never create a work order or touch tenant-scoped data through the tenant
/// matrix. Its authority is the full [`PlatformFeature`] set (the platform token
/// is a single trust level today; finer-grained platform RBAC can subset this
/// later without touching the tenant matrix).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PlatformPrincipal {
    pub user_id: UserId,
}

impl PlatformPrincipal {
    #[must_use]
    pub const fn new(user_id: UserId) -> Self {
        Self { user_id }
    }

    /// Default-deny authorization for one platform capability. Today every
    /// platform principal holds the full set, so this returns `Ok` for any
    /// [`PlatformFeature`]; it exists so call sites are explicit about the
    /// capability they require and so subsetting later is a one-line change.
    pub fn authorize(&self, _feature: PlatformFeature) -> Result<(), KernelError> {
        Ok(())
    }
}

/// Return one role's matrix cell for one feature.
#[must_use]
pub fn permission_for(role: Role, feature: Feature) -> PermissionLevel {
    feature.matrix_row()[role.matrix_index()]
}

/// Authorize a principal for a feature against a concrete resource branch.
///
/// This intentionally checks both role permission and branch membership for
/// every call. Listing APIs should also use [`repository_filter`] so the data
/// access path is constrained before rows are materialized.
pub fn authorize(
    principal: &Principal,
    action: Action,
    resource_branch: BranchId,
) -> Result<(), KernelError> {
    if !principal.branch_scope.allows(resource_branch) {
        return Err(KernelError::forbidden(
            "resource branch is outside principal scope",
        ));
    }

    let has_feature_permission = principal.roles.iter().any(|role| {
        permission_for(*role, action.feature()).satisfies(action.required_permission())
    });

    if !has_feature_permission {
        return Err(KernelError::forbidden("role is not allowed to use feature"));
    }

    Ok(())
}

/// Resolve branch scope from `user_branches` under an explicitly-armed tenant.
///
/// `SUPER_ADMIN` and `EXECUTIVE` resolve to [`BranchScope::All`] for global
/// read/rollup surfaces; write authority is still constrained by the matrix.
///
/// `user_branches` is FORCE RLS, so a bare-pool read returns ZERO branches when
/// `app.current_org` is unset — silently narrowing a non-super admin's scope to
/// nothing. This opens a transaction, arms the GUC to `org` (the caller's
/// verified-token tenant), then runs the query, so RLS narrows to exactly that
/// org's memberships. Callers that run BEFORE the per-request tenant middleware
/// (the principal-resolution paths) pass the org from the verified token.
pub async fn resolve_branch_scope_in_org(
    pool: &PgPool,
    org: OrgId,
    user_id: UserId,
    roles: &[Role],
) -> Result<BranchScope, KernelError> {
    if roles
        .iter()
        .any(|role| matches!(role, Role::SuperAdmin | Role::Executive))
    {
        return Ok(BranchScope::All);
    }

    let mut tx = pool
        .begin()
        .await
        .map_err(|err| KernelError::internal(format!("failed to resolve branch scope: {err}")))?;
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.as_uuid().to_string())
        .execute(tx.as_mut())
        .await
        .map_err(|err| KernelError::internal(format!("failed to resolve branch scope: {err}")))?;
    let rows: Vec<uuid::Uuid> = sqlx::query_scalar(
        "SELECT branch_id FROM user_branches WHERE user_id = $1 ORDER BY branch_id",
    )
    .bind(*user_id.as_uuid())
    .fetch_all(tx.as_mut())
    .await
    .map_err(|err| KernelError::internal(format!("failed to resolve branch scope: {err}")))?;
    tx.commit()
        .await
        .map_err(|err| KernelError::internal(format!("failed to resolve branch scope: {err}")))?;

    Ok(BranchScope::Branches(
        rows.into_iter().map(BranchId::from_uuid).collect(),
    ))
}

/// A validated SQL identifier for a branch column, e.g. `work_orders.branch_id`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BranchColumn(&'static str);

impl BranchColumn {
    pub fn new(raw: &'static str) -> Result<Self, KernelError> {
        if is_safe_column(raw) {
            Ok(Self(raw))
        } else {
            Err(KernelError::validation(format!(
                "unsafe branch column identifier: {raw}"
            )))
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        self.0
    }
}

/// A SQL predicate plus branch IDs to bind as `$1`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SqlPredicate {
    sql: String,
    branch_ids: Vec<uuid::Uuid>,
}

impl SqlPredicate {
    #[must_use]
    pub fn sql(&self) -> &str {
        &self.sql
    }

    #[must_use]
    pub fn branch_ids(&self) -> &[uuid::Uuid] {
        &self.branch_ids
    }
}

/// Produce the default branch predicate for repository list/detail queries.
///
/// For explicit empty scope, this returns `FALSE`, not an empty `ANY` clause,
/// making the default deny behavior visible in generated SQL.
pub fn repository_filter(
    scope: &BranchScope,
    column: BranchColumn,
) -> Result<SqlPredicate, KernelError> {
    match scope {
        BranchScope::All => Ok(SqlPredicate {
            sql: "TRUE".to_owned(),
            branch_ids: Vec::new(),
        }),
        BranchScope::Branches(branches) if branches.is_empty() => Ok(SqlPredicate {
            sql: "FALSE".to_owned(),
            branch_ids: Vec::new(),
        }),
        BranchScope::Branches(branches) => Ok(SqlPredicate {
            sql: format!("{} = ANY($1)", column.as_str()),
            branch_ids: branches.iter().map(|branch| *branch.as_uuid()).collect(),
        }),
    }
}

fn is_safe_column(raw: &str) -> bool {
    let mut segments = raw.split('.');
    let first = segments.next();
    let second = segments.next();
    let too_many = segments.next().is_some();

    match (first, second, too_many) {
        (Some(column), None, false) => is_safe_ident(column),
        (Some(table), Some(column), false) => is_safe_ident(table) && is_safe_ident(column),
        _ => false,
    }
}

fn is_safe_ident(raw: &str) -> bool {
    let mut chars = raw.chars();
    let Some(first) = chars.next() else {
        return false;
    };

    matches!(first, 'a'..='z' | '_') && chars.all(|ch| matches!(ch, 'a'..='z' | '0'..='9' | '_'))
}
