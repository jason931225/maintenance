#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeSet;

use mnt_kernel_core::{BranchId, BranchScope, ErrorKind, UserId};
use mnt_platform_authz::{
    Action, BranchColumn, Feature, PermissionLevel, Principal, Role, authorize, permission_for,
    repository_filter, resolve_branch_scope,
};
use sqlx::PgPool;

const ROLES: [Role; 5] = [
    Role::Receptionist,
    Role::Mechanic,
    Role::Admin,
    Role::Executive,
    Role::SuperAdmin,
];

fn expected_matrix() -> [(Feature, [PermissionLevel; 5]); 34] {
    use Feature::{
        AiAssist, AssigneeManage, AuditLogRead, BranchManage, CompletionReview, DailyPlanRequest,
        DailyPlanReview, ElevatedRoleGrant, EquipmentCostLedgerRead, EquipmentCostLedgerWrite,
        EvidenceAttach, ExcelDownload, InspectionRoundComplete, InspectionScheduleManage,
        KpiExclusionManage, KpiRead, Login, MasterListImport, PriorityManage, PurchaseExecute,
        PurchaseFinalApprove, PurchaseRequestApprove, PurchaseRequestCreate, PurchaseRequestRead,
        RegionManage, RentalQuoteManage, SubordinateUserCreate, TargetManage, UserManage,
        WorkOrderCreate, WorkOrderEditIntake, WorkOrderReadAll, WorkOrderStart, WorkReportSubmit,
    };
    use PermissionLevel::{Allow as A, Deny as D, Limited as L, RequestOnly as R};

    [
        (Login, [A, A, A, A, A]),
        (WorkOrderCreate, [A, L, A, L, A]),
        (WorkOrderEditIntake, [A, L, A, L, A]),
        (WorkOrderReadAll, [A, A, A, A, A]),
        (WorkOrderStart, [L, A, A, L, A]),
        (WorkReportSubmit, [L, A, A, L, A]),
        (EvidenceAttach, [A, A, A, L, A]),
        (PriorityManage, [D, D, A, D, A]),
        (AssigneeManage, [D, D, A, D, A]),
        (TargetManage, [D, R, A, D, A]),
        (CompletionReview, [D, D, A, D, A]),
        (DailyPlanRequest, [D, A, A, D, A]),
        (DailyPlanReview, [D, D, A, D, A]),
        (KpiRead, [D, D, A, A, A]),
        (KpiExclusionManage, [D, D, A, A, A]),
        (UserManage, [D, D, A, D, A]),
        (SubordinateUserCreate, [D, D, L, D, A]),
        (ElevatedRoleGrant, [D, D, D, D, A]),
        (RegionManage, [D, D, A, A, A]),
        (BranchManage, [D, D, A, A, A]),
        (MasterListImport, [D, D, A, D, A]),
        (RentalQuoteManage, [A, D, A, A, A]),
        (EquipmentCostLedgerRead, [D, D, A, A, A]),
        (EquipmentCostLedgerWrite, [D, D, A, D, A]),
        (PurchaseRequestCreate, [A, R, A, D, A]),
        (PurchaseRequestRead, [A, L, A, A, A]),
        (PurchaseRequestApprove, [D, D, A, D, A]),
        (PurchaseFinalApprove, [D, D, D, A, A]),
        (PurchaseExecute, [A, D, A, D, A]),
        (InspectionScheduleManage, [D, D, A, D, A]),
        (InspectionRoundComplete, [D, A, A, D, A]),
        (AuditLogRead, [D, D, A, D, A]),
        (ExcelDownload, [A, A, A, A, A]),
        // The inherited PERMISSIONS.md has 21 explicit table rows; its branch
        // strategy also names AI 조회 as a branch-filtered server API surface.
        // T0.6's brief requires 22 features, so the AI assistant seam is
        // represented here as permission metadata only, not an adapter.
        (AiAssist, [A, A, A, A, A]),
    ]
}

fn principal(role: Role, scope: BranchScope) -> Principal {
    Principal::new(UserId::new(), BTreeSet::from([role]), scope)
}

#[test]
fn role_enum_uses_canonical_database_codes() {
    assert_eq!(Role::SuperAdmin.as_str(), "SUPER_ADMIN");
    assert_eq!(Role::Admin.as_str(), "ADMIN");
    assert_eq!(Role::Mechanic.as_str(), "MECHANIC");
    assert_eq!(Role::Receptionist.as_str(), "RECEPTIONIST");
    assert_eq!(Role::Executive.as_str(), "EXECUTIVE");

    assert_eq!("SUPER_ADMIN".parse::<Role>().unwrap(), Role::SuperAdmin);
    assert!("OWNER".parse::<Role>().is_err());
}

#[test]
fn permission_matrix_is_exhaustive_and_matches_inherited_table() {
    let matrix = expected_matrix();
    assert_eq!(Feature::ALL.len(), 34);
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
    let scope = resolve_branch_scope(&pool, UserId::from_uuid(user_id.user), &[Role::Admin])
        .await
        .unwrap();

    assert!(scope.allows(BranchId::from_uuid(user_id.member_branch)));
    assert!(!scope.allows(BranchId::from_uuid(user_id.other_branch)));
}

#[sqlx::test(migrations = "../db/migrations")]
async fn resolves_super_admin_to_all_scope_without_memberships(pool: PgPool) {
    let user: uuid::Uuid =
        sqlx::query_scalar("INSERT INTO users (display_name, roles) VALUES ($1, $2) RETURNING id")
            .bind("Global Admin")
            .bind(Vec::from(["SUPER_ADMIN"]))
            .fetch_one(&pool)
            .await
            .unwrap();

    let scope = resolve_branch_scope(&pool, UserId::from_uuid(user), &[Role::SuperAdmin])
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
        sqlx::query_scalar("INSERT INTO regions (name) VALUES ($1) RETURNING id")
            .bind(format!("Region {role}"))
            .fetch_one(pool)
            .await
            .unwrap();

    let member_branch: uuid::Uuid =
        sqlx::query_scalar("INSERT INTO branches (region_id, name) VALUES ($1, $2) RETURNING id")
            .bind(region_id)
            .bind(format!("Member {role}"))
            .fetch_one(pool)
            .await
            .unwrap();

    let other_branch: uuid::Uuid =
        sqlx::query_scalar("INSERT INTO branches (region_id, name) VALUES ($1, $2) RETURNING id")
            .bind(region_id)
            .bind(format!("Other {role}"))
            .fetch_one(pool)
            .await
            .unwrap();

    let user: uuid::Uuid =
        sqlx::query_scalar("INSERT INTO users (display_name, roles) VALUES ($1, $2) RETURNING id")
            .bind(format!("User {role}"))
            .bind(Vec::from([role]))
            .fetch_one(pool)
            .await
            .unwrap();

    sqlx::query("INSERT INTO user_branches (user_id, branch_id) VALUES ($1, $2)")
        .bind(user)
        .bind(member_branch)
        .execute(pool)
        .await
        .unwrap();

    SeededBranches {
        user,
        member_branch,
        other_branch,
    }
}
