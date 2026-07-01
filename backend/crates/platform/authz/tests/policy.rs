#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeSet;

use mnt_kernel_core::{BranchId, BranchScope, ErrorKind, OrgId, UserId};
use mnt_platform_authz::{
    Action, BranchColumn, EffectiveFeatureGrant, Feature, PermissionLevel, Principal, Role,
    authorize, authorize_org_wide, permission_for, repository_filter, resolve_branch_scope_in_org,
    resolve_effective_feature_grants_in_org,
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

fn expected_matrix() -> [(Feature, [PermissionLevel; 6]); 45] {
    use Feature::{
        AiAssist, AssigneeManage, AuditLogRead, BranchManage, CompletionReview, DailyPlanRequest,
        DailyPlanReview, ElevatedRoleGrant, EmployeeDirectoryManage, EmployeeDirectoryRead,
        EquipmentCostLedgerRead, EquipmentCostLedgerWrite, EquipmentManage, EvidenceAttach,
        ExcelDownload, InspectionRoundComplete, InspectionScheduleManage, IntegrityFindingTriage,
        IntegrityFindingsRead, KpiExclusionManage, KpiRead, Login, MailAccountManage, MailUse,
        MasterListImport, OpsDashboardRead, OrgWideQueueTriage, PriorityManage, PurchaseExecute,
        PurchaseFinalApprove, PurchaseRequestApprove, PurchaseRequestCreate, PurchaseRequestRead,
        RegionManage, RentalQuoteManage, RoleManage, SalesManage, SubordinateUserCreate,
        TargetManage, UserManage, WorkOrderCreate, WorkOrderEditIntake, WorkOrderReadAll,
        WorkOrderStart, WorkReportSubmit,
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
        (RoleManage, [D, D, D, D, D, A]),
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
        (EmployeeDirectoryRead, [D, D, D, A, A, A]),
        (EmployeeDirectoryManage, [D, D, D, A, D, A]),
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
    // admin elevates it. `Login` is its only `Allow` cell across all features.
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
    assert_eq!(Feature::ALL.len(), 45);
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
fn effective_custom_grant_extends_authorize_without_widening_branch_scope() {
    let branch = BranchId::new();
    let other_branch = BranchId::new();
    let actor =
        principal(Role::Member, BranchScope::single(branch)).with_effective_feature_grants(vec![
            EffectiveFeatureGrant::new(
                Feature::WorkOrderCreate,
                PermissionLevel::Allow,
                BranchScope::single(branch),
            ),
        ]);

    authorize(&actor, Action::new(Feature::WorkOrderCreate), branch).unwrap();

    let static_denied =
        authorize(&actor, Action::new(Feature::PriorityManage), branch).unwrap_err();
    assert_eq!(static_denied.kind, ErrorKind::Forbidden);

    let cross_branch =
        authorize(&actor, Action::new(Feature::WorkOrderCreate), other_branch).unwrap_err();
    assert_eq!(cross_branch.kind, ErrorKind::Forbidden);
}

#[test]
fn effective_custom_grant_honors_permission_level_semantics() {
    let branch = BranchId::new();
    let actor =
        principal(Role::Member, BranchScope::single(branch)).with_effective_feature_grants(vec![
            EffectiveFeatureGrant::new(
                Feature::TargetManage,
                PermissionLevel::RequestOnly,
                BranchScope::single(branch),
            ),
        ]);

    authorize(&actor, Action::request(Feature::TargetManage), branch).unwrap();

    let full_action = authorize(&actor, Action::new(Feature::TargetManage), branch).unwrap_err();
    assert_eq!(full_action.kind, ErrorKind::Forbidden);
}

#[test]
fn org_wide_authorize_uses_effective_grants_but_never_widens_branch_grants() {
    let all_branch_actor =
        principal(Role::Member, BranchScope::All).with_effective_feature_grants(vec![
            EffectiveFeatureGrant::new(
                Feature::AuditLogRead,
                PermissionLevel::Allow,
                BranchScope::All,
            ),
        ]);

    authorize_org_wide(&all_branch_actor, Action::new(Feature::AuditLogRead)).unwrap();

    let branch = BranchId::new();
    let branch_only_actor = principal(Role::Member, BranchScope::All)
        .with_effective_feature_grants(vec![EffectiveFeatureGrant::new(
            Feature::AuditLogRead,
            PermissionLevel::Allow,
            BranchScope::single(branch),
        )]);
    let branch_only_err =
        authorize_org_wide(&branch_only_actor, Action::new(Feature::AuditLogRead))
            .expect_err("branch-scoped custom grants must not authorize all-branch reads");
    assert_eq!(branch_only_err.kind, ErrorKind::Forbidden);

    let no_all_scope_actor = principal(Role::Admin, BranchScope::single(branch));
    let no_all_scope_err =
        authorize_org_wide(&no_all_scope_actor, Action::new(Feature::AuditLogRead)).expect_err(
            "built-in permissions still need all-branch scope for branch-omitted org reads",
        );
    assert_eq!(no_all_scope_err.kind, ErrorKind::Forbidden);
}

#[test]
fn org_wide_authorize_rejects_builtin_admin_even_with_all_branch_scope() {
    let admin = principal(Role::Admin, BranchScope::All);
    let admin_err = authorize_org_wide(&admin, Action::new(Feature::KpiRead))
        .expect_err("ADMIN must not gain org-wide reads from an all-branch scope alone");
    assert_eq!(admin_err.kind, ErrorKind::Forbidden);

    let executive = principal(Role::Executive, BranchScope::All);
    authorize_org_wide(&executive, Action::new(Feature::KpiRead))
        .expect("EXECUTIVE remains an org-wide built-in role for KPI reads");

    let super_admin = principal(Role::SuperAdmin, BranchScope::All);
    authorize_org_wide(&super_admin, Action::new(Feature::KpiRead))
        .expect("SUPER_ADMIN remains an org-wide built-in role for KPI reads");

    let custom_all_actor =
        principal(Role::Member, BranchScope::All).with_effective_feature_grants(vec![
            EffectiveFeatureGrant::new(Feature::KpiRead, PermissionLevel::Allow, BranchScope::All),
        ]);
    authorize_org_wide(&custom_all_actor, Action::new(Feature::KpiRead))
        .expect("tenant-owned custom All grants may authorize org-wide reads");
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

#[sqlx::test(migrations = "../db/migrations")]
async fn resolves_active_custom_policy_role_grants_fail_closed(pool: PgPool) {
    let seeded = seed_user_with_two_branches_and_one_membership(&pool, "MEMBER").await;
    let user_id = UserId::from_uuid(seeded.user);
    let member_branch = BranchId::from_uuid(seeded.member_branch);
    let other_branch = BranchId::from_uuid(seeded.other_branch);
    sqlx::query("UPDATE users SET team = '정비' WHERE id = $1")
        .bind(seeded.user)
        .execute(&pool)
        .await
        .unwrap();

    let active_role = seed_policy_role(
        &pool,
        "custom_work_order_creator",
        "ACTIVE",
        &[
            (Feature::WorkOrderCreate, PermissionLevel::Allow),
            (Feature::RoleManage, PermissionLevel::Allow),
        ],
        &[],
    )
    .await;
    let draft_role = seed_policy_role(
        &pool,
        "draft_priority_manager",
        "DRAFT",
        &[(Feature::PriorityManage, PermissionLevel::Allow)],
        &[],
    )
    .await;
    let branch_mismatch_role = seed_policy_role(
        &pool,
        "other_branch_starter",
        "ACTIVE",
        &[(Feature::WorkOrderStart, PermissionLevel::Allow)],
        &[("branch", "equals", vec![other_branch.to_string()])],
    )
    .await;
    let team_match_role = seed_policy_role(
        &pool,
        "maintenance_team_reporter",
        "ACTIVE",
        &[(Feature::WorkReportSubmit, PermissionLevel::Allow)],
        &[(
            "team",
            "in",
            vec!["MAINTENANCE".to_owned(), "예방".to_owned()],
        )],
    )
    .await;
    let team_mismatch_role = seed_policy_role(
        &pool,
        "reception_team_reviewer",
        "ACTIVE",
        &[(Feature::CompletionReview, PermissionLevel::Allow)],
        &[("team", "equals", vec!["RECEPTION".to_owned()])],
    )
    .await;
    let unsupported_condition_role = seed_policy_role(
        &pool,
        "department_evidence",
        "ACTIVE",
        &[(Feature::EvidenceAttach, PermissionLevel::Allow)],
        &[("department", "equals", vec!["field-service".to_owned()])],
    )
    .await;
    let negative_branch_condition_role = seed_policy_role(
        &pool,
        "negative_branch_evidence",
        "ACTIVE",
        &[(Feature::WorkOrderEditIntake, PermissionLevel::Allow)],
        &[("branch", "not_equals", vec![member_branch.to_string()])],
    )
    .await;
    let invalid_branch_condition_role = seed_policy_role(
        &pool,
        "invalid_branch_assignee",
        "ACTIVE",
        &[(Feature::AssigneeManage, PermissionLevel::Allow)],
        &[("branch", "equals", vec!["not-a-branch-uuid".to_owned()])],
    )
    .await;
    assign_policy_roles(
        &pool,
        seeded.user,
        &[
            active_role,
            draft_role,
            branch_mismatch_role,
            team_match_role,
            team_mismatch_role,
            unsupported_condition_role,
            negative_branch_condition_role,
            invalid_branch_condition_role,
        ],
    )
    .await;

    let grants = resolve_effective_feature_grants_in_org(
        &pool,
        OrgId::knl(),
        user_id,
        &BranchScope::single(member_branch),
    )
    .await
    .unwrap();

    assert_eq!(
        grants.len(),
        2,
        "only active ordinary in-scope grants with supported matching conditions apply"
    );
    assert!(
        grants
            .iter()
            .any(|grant| grant.feature == Feature::WorkOrderCreate
                && grant.permission == PermissionLevel::Allow)
    );
    assert!(
        grants
            .iter()
            .any(|grant| grant.feature == Feature::WorkReportSubmit
                && grant.permission == PermissionLevel::Allow)
    );

    let actor = principal(Role::Member, BranchScope::single(member_branch))
        .with_effective_feature_grants(grants);
    authorize(&actor, Action::new(Feature::WorkOrderCreate), member_branch).unwrap();
    authorize(
        &actor,
        Action::new(Feature::WorkReportSubmit),
        member_branch,
    )
    .expect("matching team ABAC condition should become runtime-effective");

    let elevated = authorize(&actor, Action::new(Feature::RoleManage), member_branch).unwrap_err();
    assert_eq!(elevated.kind, ErrorKind::Forbidden);

    let inactive = authorize(&actor, Action::new(Feature::PriorityManage), member_branch)
        .expect_err("draft custom roles must not become effective");
    assert_eq!(inactive.kind, ErrorKind::Forbidden);

    let condition_mismatch = authorize(&actor, Action::new(Feature::WorkOrderStart), member_branch)
        .expect_err("branch condition mismatch must fail closed");
    assert_eq!(condition_mismatch.kind, ErrorKind::Forbidden);

    let team_mismatch = authorize(
        &actor,
        Action::new(Feature::CompletionReview),
        member_branch,
    )
    .expect_err("team condition mismatch must fail closed");
    assert_eq!(team_mismatch.kind, ErrorKind::Forbidden);

    let unsupported = authorize(&actor, Action::new(Feature::EvidenceAttach), member_branch)
        .expect_err("unsupported runtime ABAC conditions must fail closed");
    assert_eq!(unsupported.kind, ErrorKind::Forbidden);

    let negative_operator = authorize(
        &actor,
        Action::new(Feature::WorkOrderEditIntake),
        member_branch,
    )
    .expect_err("negative branch operators must fail closed for runtime grants");
    assert_eq!(negative_operator.kind, ErrorKind::Forbidden);

    let invalid_branch = authorize(&actor, Action::new(Feature::AssigneeManage), member_branch)
        .expect_err("invalid branch condition values must fail closed");
    assert_eq!(invalid_branch.kind, ErrorKind::Forbidden);
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

async fn seed_policy_role(
    pool: &PgPool,
    role_key: &str,
    status: &str,
    permissions: &[(Feature, PermissionLevel)],
    conditions: &[(&str, &str, Vec<String>)],
) -> uuid::Uuid {
    let role_id: uuid::Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO policy_roles (
            org_id, role_key, display_name, status, is_system
        ) VALUES ($1, $2, $3, $4, false)
        RETURNING id
        "#,
    )
    .bind(*OrgId::knl().as_uuid())
    .bind(role_key)
    .bind(format!("Role {role_key}"))
    .bind(status)
    .fetch_one(pool)
    .await
    .unwrap();

    for (feature, permission) in permissions {
        sqlx::query(
            r#"
            INSERT INTO policy_role_permissions (
                org_id, role_id, feature_key, permission_level
            ) VALUES ($1, $2, $3, $4)
            "#,
        )
        .bind(*OrgId::knl().as_uuid())
        .bind(role_id)
        .bind(feature.as_str())
        .bind(permission.as_str())
        .execute(pool)
        .await
        .unwrap();
    }

    for (index, (attribute, operator, values)) in conditions.iter().enumerate() {
        sqlx::query(
            r#"
            INSERT INTO policy_role_conditions (
                org_id, role_id, condition_key, attribute, operator, condition_values
            ) VALUES ($1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(*OrgId::knl().as_uuid())
        .bind(role_id)
        .bind(format!("condition_{index}"))
        .bind(attribute)
        .bind(operator)
        .bind(values)
        .execute(pool)
        .await
        .unwrap();
    }

    role_id
}

async fn assign_policy_roles(pool: &PgPool, user_id: uuid::Uuid, role_ids: &[uuid::Uuid]) {
    for role_id in role_ids {
        sqlx::query(
            r#"
            INSERT INTO user_role_assignments (org_id, user_id, role_id)
            VALUES ($1, $2, $3)
            "#,
        )
        .bind(*OrgId::knl().as_uuid())
        .bind(user_id)
        .bind(role_id)
        .execute(pool)
        .await
        .unwrap();
    }
}
