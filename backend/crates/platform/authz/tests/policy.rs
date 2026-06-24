#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeSet;

use mnt_kernel_core::{BranchId, BranchScope, ErrorKind, OrgId, UserId};
use mnt_platform_authz::{
    Action, BranchColumn, Feature, PermissionLevel, Principal, Role, authorize, permission_for,
    repository_filter, resolve_branch_scope_in_org,
};
use sqlx::PgPool;

const ROLES: [Role; 6] = [
    Role::Member,
    Role::Receptionist,
    Role::Mechanic,
    Role::Admin,
    Role::Executive,
    Role::SuperAdmin,
];

fn expected_matrix() -> [(Feature, [PermissionLevel; 6]); 42] {
    use Feature::{
        AiAssist, AssigneeManage, AuditLogRead, BranchManage, CompletionReview, DailyPlanRequest,
        DailyPlanReview, ElevatedRoleGrant, EquipmentCostLedgerRead, EquipmentCostLedgerWrite,
        EquipmentManage, EvidenceAttach, ExcelDownload, InspectionRoundComplete,
        InspectionScheduleManage, IntegrityFindingTriage, IntegrityFindingsRead,
        KpiExclusionManage, KpiRead, Login, MailAccountManage, MailUse, MasterListImport,
        OpsDashboardRead, OrgWideQueueTriage, PriorityManage, PurchaseExecute,
        PurchaseFinalApprove, PurchaseRequestApprove, PurchaseRequestCreate, PurchaseRequestRead,
        RegionManage, RentalQuoteManage, SalesManage, SubordinateUserCreate, TargetManage,
        UserManage, WorkOrderCreate, WorkOrderEditIntake, WorkOrderReadAll, WorkOrderStart,
        WorkReportSubmit,
    };
    use PermissionLevel::{Allow as A, Deny as D, Limited as L, RequestOnly as R};

    // Column order: [MEMBER, RECEPTIONIST, MECHANIC, ADMIN, EXECUTIVE, SUPER_ADMIN].
    // MEMBER (open-signup default) is default-DENY everywhere but `Login`.
    [
        (Login, [A, A, A, A, A, A]),
        (WorkOrderCreate, [D, A, L, A, L, A]),
        (WorkOrderEditIntake, [D, A, L, A, L, A]),
        (WorkOrderReadAll, [D, A, A, A, A, A]),
        (WorkOrderStart, [D, L, A, A, L, A]),
        (WorkReportSubmit, [D, L, A, A, L, A]),
        (EvidenceAttach, [D, A, A, A, L, A]),
        (PriorityManage, [D, D, D, A, D, A]),
        (AssigneeManage, [D, D, D, A, D, A]),
        (TargetManage, [D, D, R, A, D, A]),
        (CompletionReview, [D, D, D, A, D, A]),
        (DailyPlanRequest, [D, D, A, A, D, A]),
        (DailyPlanReview, [D, D, D, A, D, A]),
        // Org-wide queue triage read: EXECUTIVE + SUPER_ADMIN only (a branch
        // ADMIN stays confined to its branch scope), matching the org-wide tier
        // of resolve_branch_scope_in_org.
        (OrgWideQueueTriage, [D, D, D, D, A, A]),
        (KpiRead, [D, D, D, A, A, A]),
        (KpiExclusionManage, [D, D, D, A, A, A]),
        (UserManage, [D, D, D, A, D, A]),
        (SubordinateUserCreate, [D, D, D, L, D, A]),
        (ElevatedRoleGrant, [D, D, D, D, D, A]),
        (RegionManage, [D, D, D, A, A, A]),
        (BranchManage, [D, D, D, A, A, A]),
        (EquipmentManage, [D, D, D, A, A, A]),
        (MasterListImport, [D, D, D, A, D, A]),
        (RentalQuoteManage, [D, A, D, A, A, A]),
        (EquipmentCostLedgerRead, [D, D, D, A, A, A]),
        (EquipmentCostLedgerWrite, [D, D, D, A, D, A]),
        (PurchaseRequestCreate, [D, A, R, A, D, A]),
        (PurchaseRequestRead, [D, A, L, A, A, A]),
        (PurchaseRequestApprove, [D, D, D, A, D, A]),
        (PurchaseFinalApprove, [D, D, D, D, A, A]),
        (PurchaseExecute, [D, A, D, A, D, A]),
        (InspectionScheduleManage, [D, D, D, A, D, A]),
        (InspectionRoundComplete, [D, D, A, A, D, A]),
        (AuditLogRead, [D, D, D, A, D, A]),
        (ExcelDownload, [D, A, A, A, A, A]),
        (OpsDashboardRead, [D, D, D, A, D, A]),
        (SalesManage, [D, D, D, A, A, A]),
        // The inherited PERMISSIONS.md has 21 explicit table rows; its branch
        // strategy also names AI 조회 as a branch-filtered server API surface.
        // T0.6's brief requires 22 features, so the AI assistant seam is
        // represented here as permission metadata only, not an adapter.
        (AiAssist, [D, A, A, A, A, A]),
        // Integrity findings are labor-law sensitive: EXECUTIVE + SUPER_ADMIN only.
        (IntegrityFindingsRead, [D, D, D, D, A, A]),
        (IntegrityFindingTriage, [D, D, D, D, A, A]),
        // Webmail: configuring the mailbox is ADMIN + SUPER_ADMIN (holds the
        // mail secrets); sending is front-office + leadership (no MECHANIC).
        (MailAccountManage, [D, D, D, A, D, A]),
        (MailUse, [D, A, D, A, A, A]),
    ]
}

fn principal(role: Role, scope: BranchScope) -> Principal {
    Principal::new(UserId::new(), OrgId::knl(), BTreeSet::from([role]), scope)
}

#[test]
fn role_enum_uses_canonical_database_codes() {
    assert_eq!(Role::SuperAdmin.as_str(), "SUPER_ADMIN");
    assert_eq!(Role::Admin.as_str(), "ADMIN");
    assert_eq!(Role::Mechanic.as_str(), "MECHANIC");
    assert_eq!(Role::Receptionist.as_str(), "RECEPTIONIST");
    assert_eq!(Role::Executive.as_str(), "EXECUTIVE");
    assert_eq!(Role::Member.as_str(), "MEMBER");

    assert_eq!("SUPER_ADMIN".parse::<Role>().unwrap(), Role::SuperAdmin);
    assert_eq!("MEMBER".parse::<Role>().unwrap(), Role::Member);
    assert!("OWNER".parse::<Role>().is_err());
}

#[test]
fn member_role_is_default_deny_except_login() {
    // The open-signup default tier: it can authenticate but nothing else until an
    // admin elevates it. `Login` is its only `Allow` cell across all 42 features.
    for feature in Feature::ALL {
        let level = permission_for(Role::Member, feature);
        if feature == Feature::Login {
            assert_eq!(
                level,
                PermissionLevel::Allow,
                "MEMBER must be able to log in"
            );
        } else {
            assert_eq!(
                level,
                PermissionLevel::Deny,
                "MEMBER must be denied {feature:?} until elevated"
            );
        }
    }

    // And it cannot pass an authorize() gate for any real feature.
    let branch = BranchId::new();
    let member = principal(Role::Member, BranchScope::single(branch));
    let err = authorize(&member, Action::new(Feature::WorkOrderReadAll), branch).unwrap_err();
    assert_eq!(err.kind, ErrorKind::Forbidden);
}

#[test]
fn permission_matrix_is_exhaustive_and_matches_inherited_table() {
    let matrix = expected_matrix();
    assert_eq!(Feature::ALL.len(), 42);
    assert_eq!(matrix.len(), Feature::ALL.len());

    for feature in Feature::ALL {
        assert!(
            matrix.iter().any(|(candidate, _)| *candidate == feature),
            "missing matrix row for {feature:?}"
        );
    }

    for (feature, permissions) in matrix {
        for (role, expected) in ROLES.into_iter().zip(permissions) {
            assert_eq!(
                permission_for(role, feature),
                expected,
                "unexpected permission for {role:?} on {feature:?}"
            );
        }
    }
}

#[test]
fn org_wide_queue_triage_is_executive_and_super_admin_only() {
    // codex G001 HIGH-1: org-wide work-order/daily-plan queue visibility is gated
    // on the OrgWideQueueTriage capability, NOT a role string. It must mirror the
    // org-wide tier of `resolve_branch_scope_in_org` — EXECUTIVE + SUPER_ADMIN —
    // so a branch-scoped ADMIN is confined to its branches and does NOT see the
    // org-wide queue. `work_order_list_scope` widens to `BranchScope::All` exactly
    // when a principal holds this capability at `Allow`.
    let holds =
        |role: Role| permission_for(role, Feature::OrgWideQueueTriage) == PermissionLevel::Allow;
    assert!(
        holds(Role::Executive),
        "EXECUTIVE must hold OrgWideQueueTriage"
    );
    assert!(
        holds(Role::SuperAdmin),
        "SUPER_ADMIN must hold OrgWideQueueTriage"
    );
    assert!(
        !holds(Role::Admin),
        "a branch-scoped ADMIN must NOT hold OrgWideQueueTriage (no org-wide widen)"
    );
    assert!(!holds(Role::Receptionist), "RECEPTIONIST must NOT hold it");
    assert!(!holds(Role::Mechanic), "MECHANIC must NOT hold it");
    assert!(!holds(Role::Member), "MEMBER must NOT hold it");
}

#[test]
fn daily_plan_list_gate_requires_daily_plan_or_org_wide_triage() {
    // codex G001 HIGH-2: the daily-plan LIST is a MECHANIC-requests / ADMIN-reviews
    // flow, gated on DailyPlanRequest OR DailyPlanReview — NOT the broad
    // WorkOrderReadAll (which RECEPTIONIST also passes). An org-wide queue triager
    // (EXECUTIVE / SUPER_ADMIN, via OrgWideQueueTriage) may ALSO read it for
    // org-wide oversight, mirroring their work-order-queue visibility. RECEPTIONIST
    // (none of these) stays denied. Mirrors `authorize_daily_plan_list` in
    // workorder/rest: a role passes iff it holds ANY of the three at `Allow`.
    let can_list = |role: Role| {
        permission_for(role, Feature::DailyPlanRequest) == PermissionLevel::Allow
            || permission_for(role, Feature::DailyPlanReview) == PermissionLevel::Allow
            || permission_for(role, Feature::OrgWideQueueTriage) == PermissionLevel::Allow
    };
    assert!(
        can_list(Role::Mechanic),
        "MECHANIC (request) must list daily plans"
    );
    assert!(
        can_list(Role::Admin),
        "ADMIN (review) must list daily plans"
    );
    assert!(
        can_list(Role::SuperAdmin),
        "SUPER_ADMIN must list daily plans"
    );
    assert!(
        can_list(Role::Executive),
        "EXECUTIVE (org-wide triager) may list daily plans for oversight"
    );
    assert!(
        !can_list(Role::Receptionist),
        "RECEPTIONIST has no daily-plan or triage capability and must be denied the list"
    );
    assert!(!can_list(Role::Member), "MEMBER must be denied the list");
}

#[test]
fn default_authorize_requires_full_allowance_and_matching_branch_scope() {
    let branch = BranchId::new();
    let actor = principal(Role::Admin, BranchScope::single(branch));

    authorize(&actor, Action::new(Feature::PriorityManage), branch).unwrap();

    let other_branch = BranchId::new();
    let err = authorize(&actor, Action::new(Feature::PriorityManage), other_branch).unwrap_err();
    assert_eq!(err.kind, ErrorKind::Forbidden);
}

#[test]
fn request_only_permission_can_use_request_action_but_not_full_action() {
    let branch = BranchId::new();
    let actor = principal(Role::Mechanic, BranchScope::single(branch));

    authorize(&actor, Action::request(Feature::TargetManage), branch).unwrap();

    let err = authorize(&actor, Action::new(Feature::TargetManage), branch).unwrap_err();
    assert_eq!(err.kind, ErrorKind::Forbidden);
}

#[test]
fn cross_branch_reads_and_writes_are_denied_by_default() {
    let branch = BranchId::new();
    let other_branch = BranchId::new();
    let actor = principal(Role::Admin, BranchScope::single(branch));

    let read_err = authorize(&actor, Action::new(Feature::WorkOrderReadAll), other_branch)
        .expect_err("read outside the actor scope must fail");
    assert_eq!(read_err.kind, ErrorKind::Forbidden);

    let write_err = authorize(&actor, Action::new(Feature::AssigneeManage), other_branch)
        .expect_err("write outside the actor scope must fail");
    assert_eq!(write_err.kind, ErrorKind::Forbidden);
}

#[test]
fn super_admin_spans_branches() {
    let actor = principal(Role::SuperAdmin, BranchScope::All);

    authorize(
        &actor,
        Action::new(Feature::ElevatedRoleGrant),
        BranchId::new(),
    )
    .unwrap();
}

#[test]
fn executive_is_read_only_even_with_all_branch_scope() {
    let actor = principal(Role::Executive, BranchScope::All);
    let branch = BranchId::new();

    authorize(&actor, Action::new(Feature::KpiRead), branch).unwrap();

    let err = authorize(&actor, Action::new(Feature::PriorityManage), branch).unwrap_err();
    assert_eq!(err.kind, ErrorKind::Forbidden);
}

#[test]
fn empty_scope_denies_even_allowed_features() {
    let actor = principal(Role::Receptionist, BranchScope::none());

    let err = authorize(
        &actor,
        Action::new(Feature::WorkOrderReadAll),
        BranchId::new(),
    )
    .expect_err("empty explicit scope should deny by default");
    assert_eq!(err.kind, ErrorKind::Forbidden);
}

#[test]
fn repository_filter_helper_is_default_deny_and_uses_binds() {
    let column = BranchColumn::new("work_orders.branch_id").unwrap();

    let all = repository_filter(&BranchScope::All, column).unwrap();
    assert_eq!(all.sql(), "TRUE");
    assert!(all.branch_ids().is_empty());

    let none = repository_filter(&BranchScope::none(), column).unwrap();
    assert_eq!(none.sql(), "FALSE");
    assert!(none.branch_ids().is_empty());

    let branch = BranchId::new();
    let scoped = repository_filter(&BranchScope::single(branch), column).unwrap();
    assert_eq!(scoped.sql(), "work_orders.branch_id = ANY($1)");
    assert_eq!(scoped.branch_ids(), &[*branch.as_uuid()]);
}

#[test]
fn repository_filter_rejects_unsafe_column_names() {
    let err = BranchColumn::new("branch_id; DROP TABLE audit_events").unwrap_err();
    assert_eq!(err.kind, ErrorKind::Validation);
}

#[sqlx::test(migrations = "../db/migrations")]
async fn resolves_user_branch_scope_from_memberships(pool: PgPool) {
    let user_id = seed_user_with_two_branches_and_one_membership(&pool, "ADMIN").await;
    let scope = resolve_branch_scope_in_org(
        &pool,
        OrgId::knl(),
        UserId::from_uuid(user_id.user),
        &[Role::Admin],
    )
    .await
    .unwrap();

    assert!(scope.allows(BranchId::from_uuid(user_id.member_branch)));
    assert!(!scope.allows(BranchId::from_uuid(user_id.other_branch)));
}

#[sqlx::test(migrations = "../db/migrations")]
async fn resolves_super_admin_to_all_scope_without_memberships(pool: PgPool) {
    let user: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO users (display_name, roles, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind("Global Admin")
    .bind(Vec::from(["SUPER_ADMIN"]))
    .bind(*OrgId::knl().as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();

    let scope = resolve_branch_scope_in_org(
        &pool,
        OrgId::knl(),
        UserId::from_uuid(user),
        &[Role::SuperAdmin],
    )
    .await
    .unwrap();

    assert_eq!(scope, BranchScope::All);
}

struct SeededBranches {
    user: uuid::Uuid,
    member_branch: uuid::Uuid,
    other_branch: uuid::Uuid,
}

async fn seed_user_with_two_branches_and_one_membership(
    pool: &PgPool,
    role: &str,
) -> SeededBranches {
    let region_id: uuid::Uuid =
        sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ($1, $2) RETURNING id")
            .bind(format!("Region {role}"))
            .bind(*OrgId::knl().as_uuid())
            .fetch_one(pool)
            .await
            .unwrap();

    let member_branch: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(region_id)
    .bind(format!("Member {role}"))
    .bind(*OrgId::knl().as_uuid())
    .fetch_one(pool)
    .await
    .unwrap();

    let other_branch: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(region_id)
    .bind(format!("Other {role}"))
    .bind(*OrgId::knl().as_uuid())
    .fetch_one(pool)
    .await
    .unwrap();

    let user: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO users (display_name, roles, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(format!("User {role}"))
    .bind(Vec::from([role]))
    .bind(*OrgId::knl().as_uuid())
    .fetch_one(pool)
    .await
    .unwrap();

    sqlx::query("INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)")
        .bind(user)
        .bind(member_branch)
        .bind(*OrgId::knl().as_uuid())
        .execute(pool)
        .await
        .unwrap();

    SeededBranches {
        user,
        member_branch,
        other_branch,
    }
}
