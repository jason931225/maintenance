//! Branch-scoped authorization policy engine.
//!
//! The policy has two independent gates:
//! 1. feature permission from the inherited five-role matrix;
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
}

impl Role {
    pub const ALL: [Self; 5] = [
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
        }
    }

    const fn matrix_index(self) -> usize {
        match self {
            Self::Receptionist => 0,
            Self::Mechanic => 1,
            Self::Admin => 2,
            Self::Executive => 3,
            Self::SuperAdmin => 4,
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
    /// Permission metadata for the future AI assistant seam. T0.6 requires the
    /// 22-feature matrix; this does not implement an AI adapter or demo mode.
    AiAssist,
}

impl Feature {
    pub const ALL: [Self; 35] = [
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
        Self::AiAssist,
    ];

    const fn matrix_row(self) -> [PermissionLevel; 5] {
        use PermissionLevel::{Allow as A, Deny as D, Limited as L, RequestOnly as R};

        match self {
            Self::Login => [A, A, A, A, A],
            Self::WorkOrderCreate => [A, L, A, L, A],
            Self::WorkOrderEditIntake => [A, L, A, L, A],
            Self::WorkOrderReadAll => [A, A, A, A, A],
            Self::WorkOrderStart => [L, A, A, L, A],
            Self::WorkReportSubmit => [L, A, A, L, A],
            Self::EvidenceAttach => [A, A, A, L, A],
            Self::PriorityManage => [D, D, A, D, A],
            Self::AssigneeManage => [D, D, A, D, A],
            Self::TargetManage => [D, R, A, D, A],
            Self::CompletionReview => [D, D, A, D, A],
            Self::DailyPlanRequest => [D, A, A, D, A],
            Self::DailyPlanReview => [D, D, A, D, A],
            Self::KpiRead => [D, D, A, A, A],
            Self::KpiExclusionManage => [D, D, A, A, A],
            Self::UserManage => [D, D, A, D, A],
            Self::SubordinateUserCreate => [D, D, L, D, A],
            Self::ElevatedRoleGrant => [D, D, D, D, A],
            Self::RegionManage => [D, D, A, A, A],
            Self::BranchManage => [D, D, A, A, A],
            Self::EquipmentManage => [D, D, A, A, A],
            Self::MasterListImport => [D, D, A, D, A],
            Self::RentalQuoteManage => [A, D, A, A, A],
            Self::EquipmentCostLedgerRead => [D, D, A, A, A],
            Self::EquipmentCostLedgerWrite => [D, D, A, D, A],
            Self::PurchaseRequestCreate => [A, R, A, D, A],
            Self::PurchaseRequestRead => [A, L, A, A, A],
            Self::PurchaseRequestApprove => [D, D, A, D, A],
            Self::PurchaseFinalApprove => [D, D, D, A, A],
            Self::PurchaseExecute => [A, D, A, D, A],
            Self::InspectionScheduleManage => [D, D, A, D, A],
            Self::InspectionRoundComplete => [D, A, A, D, A],
            Self::AuditLogRead => [D, D, A, D, A],
            Self::ExcelDownload => [A, A, A, A, A],
            Self::AiAssist => [A, A, A, A, A],
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
// The platform tier is a DISTINCT concept from the five per-tenant [`Role`]s. It
// is deliberately NOT a sixth `Role`: adding one would ripple through the
// 35-feature × 5-role matrix and, worse, would let a platform actor be treated
// as a tenant member. Instead a platform principal is its own type with its own
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

/// Resolve branch scope from `user_branches`.
///
/// `SUPER_ADMIN` and `EXECUTIVE` resolve to [`BranchScope::All`] for global
/// read/rollup surfaces; write authority is still constrained by the matrix.
pub async fn resolve_branch_scope(
    pool: &PgPool,
    user_id: UserId,
    roles: &[Role],
) -> Result<BranchScope, KernelError> {
    if roles
        .iter()
        .any(|role| matches!(role, Role::SuperAdmin | Role::Executive))
    {
        return Ok(BranchScope::All);
    }

    let rows: Vec<uuid::Uuid> = sqlx::query_scalar(
        "SELECT branch_id FROM user_branches WHERE user_id = $1 ORDER BY branch_id",
    )
    .bind(*user_id.as_uuid())
    .fetch_all(pool)
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
