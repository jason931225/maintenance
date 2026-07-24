#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Contract proof for attendance console persistence.  It exercises the schema
//! as the non-owner runtime role, so tenant isolation and least privilege are
//! not inferred from DDL text alone.

use sqlx::{PgPool, Row};
use uuid::Uuid;

const ORG_A: Uuid = Uuid::from_u128(0x1880_0000_0000_0000_0000_0000_0000_0001);
const ORG_B: Uuid = Uuid::from_u128(0x1880_0000_0000_0000_0000_0000_0000_0002);
const FINGERPRINT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

struct Seeded {
    branch: Uuid,
    employee: Uuid,
    user: Uuid,
}

async fn seed_org(pool: &PgPool, org: Uuid, tag: &str) -> Seeded {
    let region = Uuid::new_v4();
    let branch = Uuid::new_v4();
    let employee = Uuid::new_v4();
    let user = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)")
        .bind(org)
        .bind(format!("attendance-contract-{tag}"))
        .bind(format!("Attendance contract {tag}"))
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO regions (id, name, org_id) VALUES ($1, $2, $3)")
        .bind(region)
        .bind(format!("Region {tag}"))
        .bind(org)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO branches (id, region_id, name, org_id) VALUES ($1, $2, $3, $4)")
        .bind(branch)
        .bind(region)
        .bind(format!("Branch {tag}"))
        .bind(org)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
        .bind(user)
        .bind(format!("User {tag}"))
        .bind(vec!["MECHANIC".to_owned()])
        .bind(org)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO employees (id, org_id, company, name, source_filename, source_sheet, source_row, source_key) \
         VALUES ($1, $2, 'Maintenance', $3, 'attendance-contract', 'employees', 1, $4)",
    )
    .bind(employee)
    .bind(org)
    .bind(format!("Employee {tag}"))
    .bind(format!("attendance-contract-{tag}"))
    .execute(pool)
    .await
    .unwrap();
    Seeded {
        branch,
        employee,
        user,
    }
}

async fn runtime_tx(pool: &PgPool, org: Uuid) -> sqlx::Transaction<'_, sqlx::Postgres> {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL ROLE mnt_rt")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    tx
}

#[sqlx::test(migrations = "./migrations")]
async fn attendance_console_contract_is_tenant_scoped_immutable_and_idempotent(pool: PgPool) {
    let a = seed_org(&pool, ORG_A, "a").await;
    let b = seed_org(&pool, ORG_B, "b").await;

    for table in [
        "attendance_exceptions",
        "attendance_exception_resolutions",
        "attendance_substitutions",
        "attendance_month_closes",
        "attendance_close_amendments",
        "attendance_week52_acks",
    ] {
        let row = sqlx::query(
            "SELECT c.relrowsecurity, c.relforcerowsecurity, has_table_privilege('mnt_rt', c.oid, 'SELECT,INSERT') AS can_read_write \
             FROM pg_class c WHERE c.oid = $1::regclass",
        )
        .bind(table)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(
            row.get::<bool, _>("relrowsecurity"),
            "{table} must enable RLS"
        );
        assert!(
            row.get::<bool, _>("relforcerowsecurity"),
            "{table} must force RLS"
        );
        assert!(
            row.get::<bool, _>("can_read_write"),
            "{table} needs runtime SELECT/INSERT"
        );
    }

    let mut tx = runtime_tx(&pool, ORG_A).await;
    let exception_id: Uuid = sqlx::query_scalar(
        "INSERT INTO attendance_exceptions \
         (org_id, code, kind, employee_id, branch_id, work_date, detail, created_by, idempotency_key, request_fingerprint) \
         VALUES ($1, 'AT-1', 'LATE', $2, $3, DATE '2026-07-01', 'late arrival', $4, 'exception-create-0001', $5) RETURNING id",
    )
    .bind(ORG_A).bind(a.employee).bind(a.branch).bind(a.user).bind(FINGERPRINT)
    .fetch_one(&mut *tx).await.unwrap();
    let duplicate = sqlx::query(
        "INSERT INTO attendance_exceptions \
         (org_id, code, kind, employee_id, branch_id, work_date, detail, created_by, idempotency_key, request_fingerprint) \
         VALUES ($1, 'AT-2', 'LATE', $2, $3, DATE '2026-07-01', 'duplicate', $4, 'exception-create-0001', $5)",
    )
    .bind(ORG_A).bind(a.employee).bind(a.branch).bind(a.user).bind(FINGERPRINT)
    .execute(&mut *tx).await;
    assert!(
        duplicate.is_err(),
        "exception create key must be unique per org"
    );
    tx.commit().await.unwrap();

    let mut tx = runtime_tx(&pool, ORG_B).await;
    let invisible: i64 =
        sqlx::query_scalar("SELECT count(*) FROM attendance_exceptions WHERE id = $1")
            .bind(exception_id)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(invisible, 0, "FORCE RLS must hide another org's exception");
    let cross_org = sqlx::query(
        "INSERT INTO attendance_exceptions \
         (org_id, code, kind, employee_id, branch_id, work_date, detail, created_by, idempotency_key, request_fingerprint) \
         VALUES ($1, 'AT-cross', 'LATE', $2, $3, DATE '2026-07-01', 'cross-org', $4, 'exception-create-cross', $5)",
    )
    .bind(ORG_A).bind(b.employee).bind(b.branch).bind(b.user).bind(FINGERPRINT)
    .execute(&mut *tx).await;
    assert!(
        cross_org.is_err(),
        "RLS WITH CHECK must reject a cross-org write"
    );
    tx.rollback().await.unwrap();

    let immutable =
        sqlx::query("UPDATE attendance_exceptions SET org_id = $1 WHERE id = $2 AND org_id = $3")
            .bind(ORG_B)
            .bind(exception_id)
            .bind(ORG_A)
            .execute(&pool)
            .await;
    assert!(immutable.is_err(), "exception org_id must be immutable");

    let mut tx = runtime_tx(&pool, ORG_A).await;
    let resolution = sqlx::query(
        "INSERT INTO attendance_exception_resolutions (org_id, exception_id, action, reason, actor_user_id) \
         VALUES ($1, $2, 'CONFIRM', 'reviewed', $3)",
    )
    .bind(ORG_A)
    .bind(exception_id)
    .bind(a.user)
    .execute(&mut *tx)
    .await;
    assert!(resolution.is_ok(), "a resolution is an append-only fact");
    tx.commit().await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(ORG_A.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let resolution_rewrite = sqlx::query(
        "UPDATE attendance_exception_resolutions SET reason = 'rewritten' WHERE exception_id = $1",
    )
    .bind(exception_id)
    .execute(&mut *tx)
    .await;
    assert!(
        resolution_rewrite.is_err(),
        "resolution must be append-only"
    );
    tx.rollback().await.unwrap();

    let mut tx = runtime_tx(&pool, ORG_A).await;
    let substitution = sqlx::query(
        "INSERT INTO attendance_substitutions \
         (org_id, site, branch_id, role, cover_date, from_minutes, to_minutes, covered_employee_id, reason_kind, worker_name, worker_type, created_by, idempotency_key, request_fingerprint) \
         VALUES ($1, 'A site', $2, 'mechanic', DATE '2026-07-01', 540, 1020, $3, 'NO_SHOW', 'Cover worker', 'part_time', $4, 'substitution-create-1', $5)",
    )
    .bind(ORG_A).bind(a.branch).bind(a.employee).bind(a.user).bind(FINGERPRINT)
    .execute(&mut *tx).await;
    assert!(
        substitution.is_ok(),
        "runtime role may create a substitution"
    );
    let substitution_duplicate = sqlx::query(
        "INSERT INTO attendance_substitutions \
         (org_id, site, branch_id, role, cover_date, from_minutes, to_minutes, covered_employee_id, reason_kind, worker_name, worker_type, created_by, idempotency_key, request_fingerprint) \
         VALUES ($1, 'A site', $2, 'mechanic', DATE '2026-07-01', 540, 1020, $3, 'NO_SHOW', 'Cover worker', 'part_time', $4, 'substitution-create-1', $5)",
    )
    .bind(ORG_A).bind(a.branch).bind(a.employee).bind(a.user).bind(FINGERPRINT)
    .execute(&mut *tx).await;
    assert!(
        substitution_duplicate.is_err(),
        "substitution create key must be unique per org"
    );
    tx.rollback().await.unwrap();

    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(ORG_A.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let lock_id: Uuid = sqlx::query_scalar(
        "INSERT INTO period_locks (org_id, domain, period_start, period_end, reason) \
         VALUES ($1, 'payroll', DATE '2026-07-01', DATE '2026-07-31', 'attendance close') RETURNING id",
    )
    .bind(ORG_A).fetch_one(&mut *tx).await.unwrap();
    let close_id: Uuid = sqlx::query_scalar(
        "INSERT INTO attendance_month_closes (org_id, month, checks, attested_by, period_lock_id) \
         VALUES ($1, DATE '2026-07-01', '{}'::jsonb, $2, $3) RETURNING id",
    )
    .bind(ORG_A)
    .bind(a.user)
    .bind(lock_id)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    let amendment = sqlx::query(
        "INSERT INTO attendance_close_amendments \
         (org_id, close_id, reason, detail, actor_user_id, idempotency_key, request_fingerprint) \
         VALUES ($1, $2, 'correction', 'retroactive correction', $3, 'amendment-create-1', $4)",
    )
    .bind(ORG_A)
    .bind(close_id)
    .bind(a.user)
    .bind(FINGERPRINT)
    .execute(&mut *tx)
    .await;
    assert!(
        amendment.is_ok(),
        "a close amendment is an append-only create"
    );
    let amendment_duplicate = sqlx::query(
        "INSERT INTO attendance_close_amendments \
         (org_id, close_id, reason, detail, actor_user_id, idempotency_key, request_fingerprint) \
         VALUES ($1, $2, 'correction', 'same retry', $3, 'amendment-create-1', $4)",
    )
    .bind(ORG_A)
    .bind(close_id)
    .bind(a.user)
    .bind(FINGERPRINT)
    .execute(&mut *tx)
    .await;
    assert!(
        amendment_duplicate.is_err(),
        "amendment create key must be unique per org"
    );
    tx.commit().await.unwrap();

    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(ORG_A.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let invalid_org_close = sqlx::query(
        "INSERT INTO attendance_month_closes (org_id, month, checks, attested_by) \
         VALUES ($1, DATE '2026-07-01', '{}'::jsonb, $2)",
    )
    .bind(ORG_A)
    .bind(a.user)
    .execute(&mut *tx)
    .await;
    assert!(
        invalid_org_close.is_err(),
        "organization close must require its period lock"
    );
    tx.rollback().await.unwrap();
}
