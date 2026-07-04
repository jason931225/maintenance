//! Branch-scoped authorization policy engine.
//!
//! The policy has two independent gates:
//! 1. feature permission from the inherited role matrix;
//! 2. resource `branch_id` membership from the kernel [`BranchScope`].
//!
//! Both gates default-deny. Repository adapters should use [`repository_filter`]
//! when listing branch-scoped rows so missing scope checks are difficult to
//! express accidentally.

use std::collections::{BTreeMap, BTreeSet};
use std::str::FromStr;

use mnt_kernel_core::{
    AccessScope, AccessScopeLevel, BranchId, BranchProjection, BranchScope, KernelError, OrgId,
    UserId,
};
use sqlx::{PgPool, Row};

pub mod cedar_pbac;
pub use cedar_pbac::{
    AuthorizationAuditEvent, AuthorizationContext, AuthorizationDecision,
    AuthorizationMetricLabels, AuthorizationRequest, AuthorizationResource, AuthorizationSubject,
    CedarEvaluation, CoexistenceMapEntry, CompiledBundleCacheKey, DecisionEffect, DecisionEngine,
    DecisionReason, DualEngineMode, RlsScopeProof, RlsScopeProofSource, SubjectFreshness,
    SubjectFreshnessRequirement, evaluate_cedar_pbac_boundary, evaluate_legacy_contract,
    observe_cedar_pbac_decision,
};

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
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
)]
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
    /// Org-wide read of the work-order + daily-plan queues regardless of branch
    /// membership. EXECUTIVE + SUPER_ADMIN only — it widens triage visibility to
    /// every branch in the tenant (RLS still confines it to the caller's org),
    /// matching [`resolve_branch_scope_in_org`]'s org-wide tier. A branch-scoped
    /// ADMIN stays confined to its branches. The future "org-admin" custom role
    /// will hold this capability (see docs/specs/rbac-configurable.md).
    OrgWideQueueTriage,
    KpiRead,
    KpiExclusionManage,
    UserManage,
    SubordinateUserCreate,
    ElevatedRoleGrant,
    /// Define tenant-owned custom role policies. Initially SUPER_ADMIN-only;
    /// custom role assignment/effective-policy publication is held behind the
    /// policy-studio safety gates in docs/specs/rbac-configurable.md.
    RoleManage,
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
    /// Configure the tenant's corporate webmail account (SMTP/IMAP host, port,
    /// credentials). Stores credentials write-only (envelope AEAD); every change
    /// is audited. ADMIN + SUPER_ADMIN only — it holds the mailbox secrets.
    MailAccountManage,
    /// Use the configured webmail: send / reply / forward, and (in later
    /// batches) read inbound threads. RECEPTIONIST + ADMIN + EXECUTIVE +
    /// SUPER_ADMIN; MECHANIC is excluded (work lives in the messenger surface).
    MailUse,
    /// Read the tenant HR employee directory. EXECUTIVE + ADMIN + SUPER_ADMIN only.
    EmployeeDirectoryRead,
    /// Import/manage tenant HR employee rows. ADMIN + SUPER_ADMIN only; employees
    /// are deliberately not auth users.
    EmployeeDirectoryManage,
}

impl Feature {
    pub const ALL: [Self; 45] = [
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
        Self::OrgWideQueueTriage,
        Self::KpiRead,
        Self::KpiExclusionManage,
        Self::UserManage,
        Self::SubordinateUserCreate,
        Self::ElevatedRoleGrant,
        Self::RoleManage,
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
        Self::MailAccountManage,
        Self::MailUse,
        Self::EmployeeDirectoryRead,
        Self::EmployeeDirectoryManage,
    ];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Login => "login",
            Self::WorkOrderCreate => "work_order_create",
            Self::WorkOrderEditIntake => "work_order_edit_intake",
            Self::WorkOrderReadAll => "work_order_read_all",
            Self::WorkOrderStart => "work_order_start",
            Self::WorkReportSubmit => "work_report_submit",
            Self::EvidenceAttach => "evidence_attach",
            Self::PriorityManage => "priority_manage",
            Self::AssigneeManage => "assignee_manage",
            Self::TargetManage => "target_manage",
            Self::CompletionReview => "completion_review",
            Self::DailyPlanRequest => "daily_plan_request",
            Self::DailyPlanReview => "daily_plan_review",
            Self::OrgWideQueueTriage => "org_wide_queue_triage",
            Self::KpiRead => "kpi_read",
            Self::KpiExclusionManage => "kpi_exclusion_manage",
            Self::UserManage => "user_manage",
            Self::SubordinateUserCreate => "subordinate_user_create",
            Self::ElevatedRoleGrant => "elevated_role_grant",
            Self::RoleManage => "role_manage",
            Self::RegionManage => "region_manage",
            Self::BranchManage => "branch_manage",
            Self::EquipmentManage => "equipment_manage",
            Self::MasterListImport => "master_list_import",
            Self::RentalQuoteManage => "rental_quote_manage",
            Self::EquipmentCostLedgerRead => "equipment_cost_ledger_read",
            Self::EquipmentCostLedgerWrite => "equipment_cost_ledger_write",
            Self::PurchaseRequestCreate => "purchase_request_create",
            Self::PurchaseRequestRead => "purchase_request_read",
            Self::PurchaseRequestApprove => "purchase_request_approve",
            Self::PurchaseFinalApprove => "purchase_final_approve",
            Self::PurchaseExecute => "purchase_execute",
            Self::InspectionScheduleManage => "inspection_schedule_manage",
            Self::InspectionRoundComplete => "inspection_round_complete",
            Self::AuditLogRead => "audit_log_read",
            Self::ExcelDownload => "excel_download",
            Self::OpsDashboardRead => "ops_dashboard_read",
            Self::SalesManage => "sales_manage",
            Self::AiAssist => "ai_assist",
            Self::IntegrityFindingsRead => "integrity_findings_read",
            Self::IntegrityFindingTriage => "integrity_finding_triage",
            Self::MailAccountManage => "mail_account_manage",
            Self::MailUse => "mail_use",
            Self::EmployeeDirectoryRead => "employee_directory_read",
            Self::EmployeeDirectoryManage => "employee_directory_manage",
        }
    }

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
            // Org-wide queue read: EXECUTIVE + SUPER_ADMIN only, matching the
            // org-wide tier of `resolve_branch_scope_in_org`. A branch ADMIN is
            // deliberately NOT here — it stays confined to its branch scope.
            Self::OrgWideQueueTriage => [D, D, D, D, A, A],
            Self::KpiRead => [D, D, D, A, A, A],
            Self::KpiExclusionManage => [D, D, D, A, A, A],
            Self::UserManage => [D, D, D, A, D, A],
            Self::SubordinateUserCreate => [D, D, D, L, D, A],
            Self::ElevatedRoleGrant => [D, D, D, D, D, A],
            Self::RoleManage => [D, D, D, D, D, A],
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
            // Configuring the mailbox holds the tenant's mail secrets: ADMIN +
            // SUPER_ADMIN only.
            Self::MailAccountManage => [D, D, D, A, D, A],
            // Sending/replying/forwarding mail: front-office + leadership.
            // MECHANIC is excluded (their workflow is the messenger surface).
            Self::MailUse => [D, A, D, A, A, A],
            Self::EmployeeDirectoryRead => [D, D, D, A, A, A],
            Self::EmployeeDirectoryManage => [D, D, D, A, D, A],
        }
    }
}

impl FromStr for Feature {
    type Err = KernelError;

    fn from_str(raw: &str) -> Result<Self, Self::Err> {
        match raw {
            "login" => Ok(Self::Login),
            "work_order_create" => Ok(Self::WorkOrderCreate),
            "work_order_edit_intake" => Ok(Self::WorkOrderEditIntake),
            "work_order_read_all" => Ok(Self::WorkOrderReadAll),
            "work_order_start" => Ok(Self::WorkOrderStart),
            "work_report_submit" => Ok(Self::WorkReportSubmit),
            "evidence_attach" => Ok(Self::EvidenceAttach),
            "priority_manage" => Ok(Self::PriorityManage),
            "assignee_manage" => Ok(Self::AssigneeManage),
            "target_manage" => Ok(Self::TargetManage),
            "completion_review" => Ok(Self::CompletionReview),
            "daily_plan_request" => Ok(Self::DailyPlanRequest),
            "daily_plan_review" => Ok(Self::DailyPlanReview),
            "org_wide_queue_triage" => Ok(Self::OrgWideQueueTriage),
            "kpi_read" => Ok(Self::KpiRead),
            "kpi_exclusion_manage" => Ok(Self::KpiExclusionManage),
            "user_manage" => Ok(Self::UserManage),
            "subordinate_user_create" => Ok(Self::SubordinateUserCreate),
            "elevated_role_grant" => Ok(Self::ElevatedRoleGrant),
            "role_manage" => Ok(Self::RoleManage),
            "region_manage" => Ok(Self::RegionManage),
            "branch_manage" => Ok(Self::BranchManage),
            "equipment_manage" => Ok(Self::EquipmentManage),
            "master_list_import" => Ok(Self::MasterListImport),
            "rental_quote_manage" => Ok(Self::RentalQuoteManage),
            "equipment_cost_ledger_read" => Ok(Self::EquipmentCostLedgerRead),
            "equipment_cost_ledger_write" => Ok(Self::EquipmentCostLedgerWrite),
            "purchase_request_create" => Ok(Self::PurchaseRequestCreate),
            "purchase_request_read" => Ok(Self::PurchaseRequestRead),
            "purchase_request_approve" => Ok(Self::PurchaseRequestApprove),
            "purchase_final_approve" => Ok(Self::PurchaseFinalApprove),
            "purchase_execute" => Ok(Self::PurchaseExecute),
            "inspection_schedule_manage" => Ok(Self::InspectionScheduleManage),
            "inspection_round_complete" => Ok(Self::InspectionRoundComplete),
            "audit_log_read" => Ok(Self::AuditLogRead),
            "excel_download" => Ok(Self::ExcelDownload),
            "ops_dashboard_read" => Ok(Self::OpsDashboardRead),
            "sales_manage" => Ok(Self::SalesManage),
            "ai_assist" => Ok(Self::AiAssist),
            "integrity_findings_read" => Ok(Self::IntegrityFindingsRead),
            "integrity_finding_triage" => Ok(Self::IntegrityFindingTriage),
            "mail_account_manage" => Ok(Self::MailAccountManage),
            "mail_use" => Ok(Self::MailUse),
            "employee_directory_read" => Ok(Self::EmployeeDirectoryRead),
            "employee_directory_manage" => Ok(Self::EmployeeDirectoryManage),
            _ => Err(KernelError::validation(format!(
                "unknown feature key: {raw}"
            ))),
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
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Deny => "deny",
            Self::RequestOnly => "request_only",
            Self::Limited => "limited",
            Self::Allow => "allow",
        }
    }

    const fn satisfies(self, required: Self) -> bool {
        match required {
            Self::Deny => true,
            Self::Allow => matches!(self, Self::Allow),
            Self::Limited => matches!(self, Self::Allow | Self::Limited),
            Self::RequestOnly => matches!(self, Self::Allow | Self::RequestOnly),
        }
    }
}

impl FromStr for PermissionLevel {
    type Err = KernelError;

    fn from_str(raw: &str) -> Result<Self, Self::Err> {
        match raw {
            "deny" => Ok(Self::Deny),
            "request_only" => Ok(Self::RequestOnly),
            "limited" => Ok(Self::Limited),
            "allow" => Ok(Self::Allow),
            _ => Err(KernelError::validation(format!(
                "unknown permission level: {raw}"
            ))),
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
    pub access_scope: AccessScope,
    pub roles: BTreeSet<Role>,
    pub branch_scope: BranchScope,
    /// Runtime-effective grants resolved from active tenant-owned custom roles.
    ///
    /// These are additive to the built-in role matrix and never widen
    /// [`Self::branch_scope`]. Resolver failures fail closed before a request
    /// principal is built; unsupported ABAC/PBAC conditions are omitted rather
    /// than guessed.
    pub effective_feature_grants: Vec<EffectiveFeatureGrant>,
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
            access_scope: AccessScope::legacy_org(org_id),
            roles,
            branch_scope,
            effective_feature_grants: Vec::new(),
        }
    }

    #[must_use]
    pub const fn with_access_scope(mut self, access_scope: AccessScope) -> Self {
        self.access_scope = access_scope;
        self
    }

    #[must_use]
    pub fn with_effective_feature_grants(mut self, grants: Vec<EffectiveFeatureGrant>) -> Self {
        self.effective_feature_grants = grants;
        self
    }
}

/// One runtime-effective custom-role grant after tenant/RLS, status, feature,
/// permission, and supported condition checks have all succeeded.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct EffectiveFeatureGrant {
    pub feature: Feature,
    pub permission: PermissionLevel,
    pub branch_scope: BranchScope,
}

impl EffectiveFeatureGrant {
    #[must_use]
    pub fn new(feature: Feature, permission: PermissionLevel, branch_scope: BranchScope) -> Self {
        Self {
            feature,
            permission,
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
    /// Hard-remove (delete) an empty/test tenant org + its onboarding shell.
    /// Strictly more destructive than [`Self::TenantSuspend`]; a tenant's own
    /// admin can never reach it (the platform extractor rejects a tenant token).
    TenantRemove,
    /// Read a tenant's health/status.
    TenantHealthRead,
    /// Mint an audited tenant-admin context so a platform operator can manage a
    /// specific tenant through the ordinary tenant-scoped UI/API.
    TenantManage,
    /// Manage platform group identities and subsidiary membership.
    GroupManage,
    /// Read the platform-tier audit trail.
    PlatformAuditRead,
}

impl PlatformFeature {
    pub const ALL: [Self; 8] = [
        Self::TenantCreate,
        Self::TenantList,
        Self::TenantSuspend,
        Self::TenantRemove,
        Self::TenantHealthRead,
        Self::TenantManage,
        Self::GroupManage,
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

/// Authorize a principal for an org-wide feature read/action with no concrete
/// resource branch in the request. This is the single source of truth for
/// branch-omitted org-wide routes: callers must already have `BranchScope::All`,
/// built-in org-wide authority is limited to `SUPER_ADMIN`/`EXECUTIVE`, and
/// custom-role grants must themselves be org-wide (`BranchScope::All`) to pass
/// this gate. Branch-narrow custom grants may still authorize concrete branch
/// requests through [`authorize`], but never widen into an all-branch read.
pub fn authorize_org_wide(principal: &Principal, action: Action) -> Result<(), KernelError> {
    if principal.branch_scope != BranchScope::All {
        return Err(KernelError::forbidden(
            "org-wide access requires all-branch scope",
        ));
    }

    let has_builtin_org_wide_permission = principal.roles.iter().any(|role| {
        matches!(role, Role::SuperAdmin | Role::Executive)
            && permission_for(*role, action.feature()).satisfies(action.required_permission())
    });
    let has_custom_org_wide_permission = principal.effective_feature_grants.iter().any(|grant| {
        grant.feature == action.feature()
            && grant.permission.satisfies(action.required_permission())
            && grant.branch_scope == BranchScope::All
    });

    if !(has_builtin_org_wide_permission || has_custom_org_wide_permission) {
        return Err(KernelError::forbidden("role is not allowed to use feature"));
    }

    Ok(())
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
    }) || principal.effective_feature_grants.iter().any(|grant| {
        grant.feature == action.feature()
            && grant.permission.satisfies(action.required_permission())
            && grant.branch_scope.allows(resource_branch)
    });

    if !has_feature_permission {
        return Err(KernelError::forbidden("role is not allowed to use feature"));
    }

    Ok(())
}

#[derive(Debug)]
struct RuntimePolicyPermissionRow {
    role_id: uuid::Uuid,
    feature_key: String,
    permission_level: String,
}

#[derive(Debug)]
struct RuntimePolicyConditionRow {
    role_id: uuid::Uuid,
    attribute: String,
    operator: String,
    condition_values: Vec<String>,
}

/// Resolve runtime-effective tenant custom-role grants under an explicitly
/// armed org.
///
/// Safety boundary:
/// * only assignments to `ACTIVE`, non-system roles are effective;
/// * feature/permission strings are parse-or-deny;
/// * elevated/scope-widening features stay system-role-only for this slice;
/// * branch conditions may only narrow the already-live branch scope;
/// * team conditions must match the target user's live team attribute;
/// * unsupported ABAC/PBAC conditions fail closed for runtime authorization
///   while remaining persisted/visible in Policy Studio previews.
pub async fn resolve_effective_feature_grants_in_org(
    pool: &PgPool,
    org: OrgId,
    user_id: UserId,
    live_branch_scope: &BranchScope,
) -> Result<Vec<EffectiveFeatureGrant>, KernelError> {
    let mut tx = pool.begin().await.map_err(map_effective_policy_error)?;
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.as_uuid().to_string())
        .execute(tx.as_mut())
        .await
        .map_err(map_effective_policy_error)?;

    let user_team: Option<String> =
        sqlx::query_scalar("SELECT team FROM users WHERE org_id = $1 AND id = $2")
            .bind(*org.as_uuid())
            .bind(*user_id.as_uuid())
            .fetch_optional(tx.as_mut())
            .await
            .map_err(map_effective_policy_error)?
            .flatten();

    let permission_rows = sqlx::query(
        r#"
        SELECT pr.id AS role_id, prp.feature_key, prp.permission_level
        FROM user_role_assignments AS ura
        JOIN policy_roles AS pr
          ON pr.org_id = ura.org_id
         AND pr.id = ura.role_id
        JOIN policy_role_permissions AS prp
          ON prp.org_id = pr.org_id
         AND prp.role_id = pr.id
        WHERE ura.org_id = $1
          AND ura.user_id = $2
          AND pr.status = 'ACTIVE'
          AND pr.is_system = false
        ORDER BY pr.role_key, prp.feature_key
        "#,
    )
    .bind(*org.as_uuid())
    .bind(*user_id.as_uuid())
    .fetch_all(tx.as_mut())
    .await
    .map_err(map_effective_policy_error)?
    .into_iter()
    .map(|row| {
        Ok(RuntimePolicyPermissionRow {
            role_id: row.try_get("role_id")?,
            feature_key: row.try_get("feature_key")?,
            permission_level: row.try_get("permission_level")?,
        })
    })
    .collect::<Result<Vec<_>, sqlx::Error>>()
    .map_err(map_effective_policy_error)?;

    let role_ids = permission_rows
        .iter()
        .map(|row| row.role_id)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();

    let condition_rows = if role_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query(
            r#"
            SELECT role_id, attribute, operator, condition_values
            FROM policy_role_conditions
            WHERE org_id = $1
              AND role_id = ANY($2)
            ORDER BY role_id, condition_key
            "#,
        )
        .bind(*org.as_uuid())
        .bind(&role_ids)
        .fetch_all(tx.as_mut())
        .await
        .map_err(map_effective_policy_error)?
        .into_iter()
        .map(|row| {
            Ok(RuntimePolicyConditionRow {
                role_id: row.try_get("role_id")?,
                attribute: row.try_get("attribute")?,
                operator: row.try_get("operator")?,
                condition_values: row.try_get("condition_values")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(map_effective_policy_error)?
    };

    tx.commit().await.map_err(map_effective_policy_error)?;

    let mut conditions_by_role: BTreeMap<uuid::Uuid, Vec<RuntimePolicyConditionRow>> =
        BTreeMap::new();
    for condition in condition_rows {
        conditions_by_role
            .entry(condition.role_id)
            .or_default()
            .push(condition);
    }

    let mut effective_scopes_by_role = BTreeMap::new();
    for role_id in role_ids {
        let Some(scope) = effective_scope_for_custom_role_conditions(
            live_branch_scope,
            user_team.as_deref(),
            conditions_by_role
                .get(&role_id)
                .map_or(&[][..], Vec::as_slice),
        ) else {
            continue;
        };
        if !scope.is_empty() {
            effective_scopes_by_role.insert(role_id, scope);
        }
    }

    let grants = permission_rows
        .into_iter()
        .filter_map(|row| {
            let scope = effective_scopes_by_role.get(&row.role_id)?;
            let feature = Feature::from_str(&row.feature_key).ok()?;
            let permission = PermissionLevel::from_str(&row.permission_level).ok()?;
            if permission == PermissionLevel::Deny || !custom_role_runtime_feature_allowed(feature)
            {
                return None;
            }
            Some(EffectiveFeatureGrant::new(
                feature,
                permission,
                scope.clone(),
            ))
        })
        .collect();

    Ok(grants)
}

fn custom_role_runtime_feature_allowed(feature: Feature) -> bool {
    !matches!(
        feature,
        Feature::RoleManage | Feature::ElevatedRoleGrant | Feature::OrgWideQueueTriage
    )
}

fn effective_scope_for_custom_role_conditions(
    live_branch_scope: &BranchScope,
    user_team: Option<&str>,
    conditions: &[RuntimePolicyConditionRow],
) -> Option<BranchScope> {
    let mut scope = live_branch_scope.clone();
    for condition in conditions {
        if !matches!(condition.operator.as_str(), "equals" | "in") {
            return None;
        }

        match condition.attribute.as_str() {
            "branch" => {
                let mut branches = BTreeSet::new();
                for value in &condition.condition_values {
                    let Ok(branch) = BranchId::from_str(value) else {
                        return None;
                    };
                    branches.insert(branch);
                }
                scope = scope.intersect(&BranchScope::Branches(branches));
            }
            "team" => {
                if !team_condition_matches(user_team, &condition.condition_values) {
                    return None;
                }
            }
            _ => return None,
        }
    }
    Some(scope)
}

fn team_condition_matches(user_team: Option<&str>, values: &[String]) -> bool {
    let Some(user_team) = user_team.map(str::trim).filter(|team| !team.is_empty()) else {
        return false;
    };
    let Some(accepted) = team_policy_values(user_team) else {
        return false;
    };
    values.iter().any(|value| {
        let value = value.trim();
        accepted
            .iter()
            .any(|accepted| value == *accepted || value.eq_ignore_ascii_case(accepted))
    })
}

fn team_policy_values(user_team: &str) -> Option<[&'static str; 2]> {
    match user_team {
        "정비" => Some(["MAINTENANCE", "정비"]),
        "예방" => Some(["PREVENTION", "예방"]),
        "관리" => Some(["MANAGEMENT", "관리"]),
        "접수" => Some(["RECEPTION", "접수"]),
        _ => None,
    }
}

fn map_effective_policy_error(err: sqlx::Error) -> KernelError {
    KernelError::internal(format!("failed to resolve effective policy: {err}"))
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

/// Apply a claim-level hierarchy scope to a live DB membership scope for one
/// ordinary tenant route.
///
/// The live scope is authoritative for membership revocation. The access scope
/// may only narrow that set; it never widens. A `Group` access scope is rejected
/// here because group-wide reads must use the consolidated group helper, which
/// first resolves authorized member orgs and then performs N separately armed
/// per-org reads. Region/worksite projections are not wired yet, so they fail
/// closed until a DB-backed hierarchy resolver supplies a matching projection.
pub fn effective_branch_scope_for_tenant(
    live_scope: BranchScope,
    access_scope: AccessScope,
    org_id: OrgId,
) -> Result<BranchScope, KernelError> {
    let projected_scope = match access_scope.level {
        AccessScopeLevel::Group => {
            return Err(KernelError::forbidden(
                "group access scope must use a group fan-out resolver",
            ));
        }
        AccessScopeLevel::Org => access_scope.branch_scope_for_org(org_id, None),
        AccessScopeLevel::Branch => {
            let branch_id = BranchId::from_uuid(*access_scope.node_id.as_uuid());
            let projection = BranchProjection::single(access_scope.node_id, org_id, branch_id);
            access_scope.branch_scope_for_org(org_id, Some(&projection))
        }
        AccessScopeLevel::Region | AccessScopeLevel::Worksite => {
            access_scope.branch_scope_for_org(org_id, None)
        }
    };

    Ok(live_scope.intersect(&projected_scope))
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

#[cfg(test)]
mod tests {
    use super::*;
    use mnt_kernel_core::{ErrorKind, ScopeNodeId};

    #[test]
    fn effective_scope_preserves_legacy_org_live_scope() -> Result<(), KernelError> {
        let org = OrgId::new();
        let branch = BranchId::new();
        let live_scope = BranchScope::single(branch);

        let effective =
            effective_branch_scope_for_tenant(live_scope, AccessScope::legacy_org(org), org)?;

        assert_eq!(effective, BranchScope::single(branch));
        Ok(())
    }

    #[test]
    fn effective_scope_fails_closed_on_org_mismatch() -> Result<(), KernelError> {
        let effective = effective_branch_scope_for_tenant(
            BranchScope::All,
            AccessScope::legacy_org(OrgId::new()),
            OrgId::new(),
        )?;

        assert_eq!(effective, BranchScope::none());
        Ok(())
    }

    #[test]
    fn effective_scope_branch_claim_narrows_live_all() -> Result<(), KernelError> {
        let org = OrgId::new();
        let branch = BranchId::new();
        let scope = AccessScope::new(
            AccessScopeLevel::Branch,
            ScopeNodeId::from_uuid(*branch.as_uuid()),
        );

        let effective = effective_branch_scope_for_tenant(BranchScope::All, scope, org)?;

        assert_eq!(effective, BranchScope::single(branch));
        Ok(())
    }

    #[test]
    fn effective_scope_branch_claim_intersects_live_memberships() -> Result<(), KernelError> {
        let org = OrgId::new();
        let branch = BranchId::new();
        let other = BranchId::new();
        let scope = AccessScope::new(
            AccessScopeLevel::Branch,
            ScopeNodeId::from_uuid(*branch.as_uuid()),
        );

        let allowed = effective_branch_scope_for_tenant(BranchScope::single(branch), scope, org)?;
        let denied = effective_branch_scope_for_tenant(BranchScope::single(other), scope, org)?;

        assert_eq!(allowed, BranchScope::single(branch));
        assert_eq!(denied, BranchScope::none());
        Ok(())
    }

    #[test]
    fn effective_scope_rejects_group_on_ordinary_tenant_routes() {
        let err_kind = effective_branch_scope_for_tenant(
            BranchScope::All,
            AccessScope::new(
                AccessScopeLevel::Group,
                ScopeNodeId::from_uuid(uuid::Uuid::new_v4()),
            ),
            OrgId::new(),
        )
        .err()
        .map(|err| err.kind);

        assert_eq!(err_kind, Some(ErrorKind::Forbidden));
    }

    #[test]
    fn effective_scope_sub_org_levels_without_projection_fail_closed() -> Result<(), KernelError> {
        for level in [AccessScopeLevel::Region, AccessScopeLevel::Worksite] {
            let effective = effective_branch_scope_for_tenant(
                BranchScope::All,
                AccessScope::new(level, ScopeNodeId::from_uuid(uuid::Uuid::new_v4())),
                OrgId::new(),
            )?;

            assert_eq!(effective, BranchScope::none());
        }
        Ok(())
    }
}
