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
        let actor = seed_user(&owner_pool, "Attendance Manager", "ADMIN", branch).await;
        let employee = seed_employee(&owner_pool, branch).await;
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

async fn seed_employee(pool: &PgPool, branch: mnt_kernel_core::BranchId) -> Uuid {
    let employee = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO employees (id, org_id, company, name, source_filename, source_sheet, source_row, source_key, raw_row, source_metadata, home_branch_id) VALUES ($1, $2, 'attendance-test', 'Covered employee', 'attendance.xlsx', 'employees', 1, $3, '{}'::jsonb, '{}'::jsonb, $4)",
    )
    .bind(employee)
    .bind(*OrgId::knl().as_uuid())
    .bind(format!("attendance-cancel-{employee}"))
    .bind(*branch.as_uuid())
    .execute(pool)
    .await
    .unwrap();
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
