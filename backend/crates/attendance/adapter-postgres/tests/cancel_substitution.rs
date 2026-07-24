#![allow(clippy::expect_used, clippy::panic, clippy::unwrap_used)]
//! Regression for migration 0188's only permitted substitution transition.
//!
//! The test seeds an `ASSIGNED` row through the migration-owned schema and
//! drives the production `PgAttendanceStore` using the low-privilege runtime
//! role. It proves the adapter updates the migration's real `cancel_reason`
//! column while preserving the one-way `ASSIGNED -> CANCELLED` transition.

use mnt_attendance_adapter_postgres::PgAttendanceStore;
use mnt_attendance_application::{CallerScope, CancelSubstitution};
use mnt_kernel_core::OrgId;
use mnt_platform_request_context::scope_org;
use mnt_platform_test_support::{runtime_role_pool, seed_branch, seed_user};
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn assigned_substitution_cancels_through_runtime_adapter_using_migration_0188_columns(
    owner_pool: PgPool,
) {
    scope_org(OrgId::knl(), async move {
        let branch = seed_branch(&owner_pool, "attendance-cancel", "operations").await;
        let actor = seed_user(&owner_pool, "Attendance Manager", "SUPER_ADMIN", branch).await;
        let employee = seed_employee(&owner_pool, branch, actor).await;
        let substitution_id =
            seed_assigned_substitution(&owner_pool, branch, actor, employee).await;

        let store = PgAttendanceStore::new(runtime_role_pool(&owner_pool).await);
        let caller = CallerScope {
            org_id: *OrgId::knl().as_uuid(),
            user_id: *actor.as_uuid(),
            branch_ids: vec![*branch.as_uuid()],
            org_wide: false,
        };
        let cancelled = store
            .cancel_substitution(
                &caller,
                CancelSubstitution {
                    substitution_id,
                    reason: "approved staffing change".to_owned(),
                },
            )
            .await
            .expect("runtime adapter must permit migration 0188 ASSIGNED -> CANCELLED");

        assert_eq!(cancelled.id, substitution_id);
        assert_eq!(cancelled.status, "CANCELLED");
        let persisted: (String, Option<String>) = sqlx::query_as(
            "SELECT status, cancel_reason FROM attendance_substitutions WHERE id=$1",
        )
        .bind(substitution_id)
        .fetch_one(&owner_pool)
        .await
        .unwrap();
        assert_eq!(persisted.0, "CANCELLED");
        assert_eq!(persisted.1.as_deref(), Some("approved staffing change"));
    })
    .await;
}

async fn seed_employee(
    pool: &PgPool,
    branch: mnt_kernel_core::BranchId,
    actor: mnt_kernel_core::UserId,
) -> Uuid {
    let employee = Uuid::new_v4();
    let employee_number = format!("ATT-{employee}");
    let idempotency_key = format!("attendance-cancel-{employee}");
    let mut command = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL ROLE mnt_leave_cmd")
        .execute(&mut *command)
        .await
        .unwrap();
    sqlx::query(
        "SELECT * FROM leave_api.create_employee(\
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0::numeric,$12,$13,$14,$15,$16)",
    )
    .bind(*OrgId::knl().as_uuid())
    .bind(employee)
    .bind(employee_number)
    .bind("Covered employee")
    .bind("attendance-test")
    .bind("FULL_TIME")
    .bind(Option::<String>::None)
    .bind("Operations")
    .bind("Forklift operator")
    .bind("Seoul depot")
    .bind(*branch.as_uuid())
    .bind(idempotency_key)
    .bind("a".repeat(64))
    .bind(*actor.as_uuid())
    .bind("0123456789abcdef0123456789abcdef")
    .bind("0123456789abcdef")
    .fetch_one(&mut *command)
    .await
    .unwrap();
    command.commit().await.unwrap();
    employee
}

async fn seed_assigned_substitution(
    pool: &PgPool,
    branch: mnt_kernel_core::BranchId,
    actor: mnt_kernel_core::UserId,
    covered_employee_id: Uuid,
) -> Uuid {
    let substitution_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO attendance_substitutions (id, org_id, site, branch_id, role, cover_date, from_minutes, to_minutes, covered_employee_id, reason_kind, worker_name, worker_type, status, idempotency_key, request_fingerprint, created_by) VALUES ($1, $2, 'Seoul depot', $3, 'Forklift operator', CURRENT_DATE, 480, 960, $4, 'APPROVED_LEAVE', 'Contractor Kim', 'CONTRACTOR', 'ASSIGNED', $5, $6, $7)",
    )
    .bind(substitution_id)
    .bind(*OrgId::knl().as_uuid())
    .bind(*branch.as_uuid())
    .bind(covered_employee_id)
    .bind(format!("attendance-cancel-{substitution_id}"))
    .bind("a".repeat(64))
    .bind(*actor.as_uuid())
    .execute(pool)
    .await
    .unwrap();
    substitution_id
}
