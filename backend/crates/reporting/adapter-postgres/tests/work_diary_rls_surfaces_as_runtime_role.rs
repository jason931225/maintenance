#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! RUNTIME RLS gate for work-diary update/confirm.
//!
//! `work_diary_draft_can_be_generated_edited_confirmed_and_exported` (in
//! excel_exports.rs) drives the same update/confirm path but on the plain
//! `#[sqlx::test]` pool — a BYPASSRLS superuser that ignores `app.current_org`
//! entirely, so it cannot tell an armed GUC from an unarmed one. This test
//! proves the same path AS the genuine non-owner runtime role `mnt_rt`
//! (NOSUPERUSER, NOBYPASSRLS, FORCE RLS): SEED as the owner, GENERATE/UPDATE/
//! CONFIRM as `mnt_rt` under the armed GUC.

use mnt_kernel_core::{BranchId, BranchScope, OrgId, TraceContext, UserId};
use mnt_platform_test_support::runtime_role_pool;
use mnt_reporting_adapter_postgres::PgReportingRepository;
use mnt_reporting_application::{
    WorkDiaryConfirmCommand, WorkDiaryDraftPort, WorkDiaryQuery, WorkDiaryUpdateCommand,
};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime, macros::date};

const DIARY_DATE: time::Date = date!(2026 - 06 - 12);

async fn seed_branch(pool: &PgPool) -> BranchId {
    let region_id: uuid::Uuid =
        sqlx::query_scalar("INSERT INTO regions (name, org_id) VALUES ($1, $2) RETURNING id")
            .bind(format!("Region {}", uuid::Uuid::new_v4()))
            .bind(*OrgId::knl().as_uuid())
            .fetch_one(pool)
            .await
            .unwrap();
    let branch_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(region_id)
    .bind(format!("Branch {}", uuid::Uuid::new_v4()))
    .bind(*OrgId::knl().as_uuid())
    .fetch_one(pool)
    .await
    .unwrap();
    BranchId::from_uuid(branch_id)
}

async fn seed_user(pool: &PgPool, branch: BranchId) -> UserId {
    let id = UserId::new();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
        .bind(*id.as_uuid())
        .bind(format!("Admin {}", uuid::Uuid::new_v4()))
        .bind(Vec::from(["ADMIN"]))
        .bind(*OrgId::knl().as_uuid())
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)")
        .bind(*id.as_uuid())
        .bind(*branch.as_uuid())
        .bind(*OrgId::knl().as_uuid())
        .execute(pool)
        .await
        .unwrap();
    id
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn work_diary_update_and_confirm_succeed_as_runtime_role(owner_pool: PgPool) {
    mnt_platform_request_context::scope_org(OrgId::knl(), async move {
        let branch = seed_branch(&owner_pool).await;
        let actor = seed_user(&owner_pool, branch).await;

        let rt_pool = runtime_role_pool(&owner_pool).await;
        let repo = PgReportingRepository::new(rt_pool);
        let branch_scope = BranchScope::single(branch);

        let generated = repo
            .get_or_generate_work_diary(WorkDiaryQuery {
                actor,
                date: DIARY_DATE,
                branch_scope: branch_scope.clone(),
                trace: TraceContext::generate(),
                occurred_at: OffsetDateTime::now_utc(),
            })
            .await
            .expect("generate must succeed as mnt_rt under the armed GUC");
        assert_eq!(generated.status.as_str(), "DRAFT");

        let updated = repo
            .update_work_diary(WorkDiaryUpdateCommand {
                actor,
                date: DIARY_DATE,
                branch_scope: branch_scope.clone(),
                body: generated.body,
                trace: TraceContext::generate(),
                occurred_at: OffsetDateTime::now_utc() + Duration::seconds(1),
            })
            .await
            .expect("update must succeed as mnt_rt under the armed GUC — an unarmed GUC would RLS-deny the UPDATE and this would fail closed as `work diary draft was not editable`");
        assert_eq!(updated.status.as_str(), "DRAFT");

        let confirmed = repo
            .confirm_work_diary(WorkDiaryConfirmCommand {
                actor,
                date: DIARY_DATE,
                branch_scope,
                trace: TraceContext::generate(),
                occurred_at: OffsetDateTime::now_utc() + Duration::seconds(2),
            })
            .await
            .expect("confirm must succeed as mnt_rt under the armed GUC — an unarmed GUC would RLS-deny the UPDATE and this would fail closed as `work diary is already confirmed`/not-found");
        assert_eq!(confirmed.status.as_str(), "CONFIRMED");
    })
    .await;
}
