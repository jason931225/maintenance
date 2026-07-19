#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

//! Populated 0165 -> 0166 expand/contract regression.
//!
//! A database migration can reach production before every old application
//! replica has drained, and rollback can deliberately put that old binary back.
//! The pre-0166 binary names `leave_requests.days` for reads and inserts, so
//! 0166 must preserve that surface while the new binary reads `legacy_days` and
//! writes exact charges only through `leave_api`.

use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};
use uuid::Uuid;

const MIGRATION_0166: &str =
    include_str!("../../../platform/db/migrations/0166_leave_exact_charge_and_home_branch.sql");
const MIGRATOR_PASSWORD: &str = "leave-migration-owner-a166";

const ORG: Uuid = Uuid::from_u128(0xa166_a166_a166_a166_a166_a166_a166_a166);
const REGION: Uuid = Uuid::from_u128(0x1166_1166_1166_1166_1166_1166_1166_1166);
const BRANCH: Uuid = Uuid::from_u128(0xb166_b166_b166_b166_b166_b166_b166_b166);
const USER: Uuid = Uuid::from_u128(0xc166_c166_c166_c166_c166_c166_c166_c166);
const DECIDER: Uuid = Uuid::from_u128(0xc266_c266_c266_c266_c266_c266_c266_c266);
const EMPLOYEE: Uuid = Uuid::from_u128(0xd166_d166_d166_d166_d166_d166_d166_d166);
const PREEXISTING_REQUEST: Uuid = Uuid::from_u128(0xe166_e166_e166_e166_e166_e166_e166_e166);
const ROLLBACK_REQUEST: Uuid = Uuid::from_u128(0xf166_f166_f166_f166_f166_f166_f166_f166);

async fn restore_pre_0166_schema(pool: &PgPool) {
    sqlx::raw_sql(
        r#"
        DROP SCHEMA leave_api CASCADE;
        DROP TABLE leave_balance_import_receipts CASCADE;
        DROP TABLE leave_charge_resolutions CASCADE;
        DROP FUNCTION leave_charge_resolutions_immutable();
        DROP FUNCTION leave_requests_intent_routing_immutable() CASCADE;
        DROP FUNCTION leave_requests_charge_pointer_consistent() CASCADE;

        DROP INDEX employees_org_home_branch_idx;
        ALTER TABLE employees
            DROP CONSTRAINT employees_home_branch_same_org_fk,
            DROP CONSTRAINT employees_id_org_id_unique,
            DROP COLUMN home_branch_id,
            ALTER COLUMN leave_accrued TYPE NUMERIC(10,2),
            ALTER COLUMN leave_used TYPE NUMERIC(10,2),
            ALTER COLUMN leave_remaining TYPE NUMERIC(10,2);

        ALTER TABLE leave_requests
            DROP CONSTRAINT IF EXISTS leave_requests_current_charge_resolution_fk,
            DROP CONSTRAINT leave_requests_submission_pair,
            DROP CONSTRAINT leave_requests_status_charge_state,
            DROP CONSTRAINT leave_requests_charge_review_reason_values,
            DROP CONSTRAINT leave_requests_partial_day_shape,
            DROP CONSTRAINT leave_requests_charge_shape,
            DROP CONSTRAINT leave_requests_org_id_id_unique,
            DROP COLUMN current_charge_resolution_id,
            DROP COLUMN charge_version,
            DROP COLUMN request_version,
            DROP COLUMN charge_units,
            DROP COLUMN submission_initial_charge_version,
            DROP COLUMN submission_digest,
            DROP COLUMN submission_key,
            DROP COLUMN charge_review_reasons,
            DROP COLUMN charge_state,
            DROP COLUMN partial_day_period,
            DROP COLUMN legacy_days,
            ALTER COLUMN days TYPE NUMERIC(4,1),
            ALTER COLUMN days SET NOT NULL;

        ALTER ROLE mnt_app LOGIN INHERIT NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE
            NOREPLICATION PASSWORD 'leave-migration-owner-a166';
        ALTER ROLE mnt_leave_definer NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT
            NOCREATEDB NOCREATEROLE NOREPLICATION;
        ALTER ROLE mnt_leave_cmd LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT
            NOCREATEDB NOCREATEROLE NOREPLICATION;
        REVOKE mnt_leave_definer FROM mnt_rt, mnt_leave_cmd;
        REVOKE mnt_rt, mnt_leave_cmd FROM mnt_app, mnt_leave_definer;
        GRANT mnt_leave_definer TO mnt_app
            WITH ADMIN FALSE, INHERIT TRUE, SET TRUE;

        DO $db_owner$
        BEGIN
            EXECUTE format('ALTER DATABASE %I OWNER TO mnt_app', current_database());
        END
        $db_owner$;

        ALTER TABLE organizations OWNER TO mnt_app;
        ALTER TABLE users OWNER TO mnt_app;
        ALTER TABLE user_branches OWNER TO mnt_app;
        ALTER TABLE regions OWNER TO mnt_app;
        ALTER TABLE branches OWNER TO mnt_app;
        ALTER TABLE employees OWNER TO mnt_app;
        ALTER TABLE leave_requests OWNER TO mnt_app;
        ALTER TABLE data_import_runs OWNER TO mnt_app;
        ALTER TABLE data_import_rows OWNER TO mnt_app;
        ALTER TABLE audit_events OWNER TO mnt_app;
        ALTER TABLE policy_roles OWNER TO mnt_app;
        ALTER TABLE policy_role_permissions OWNER TO mnt_app;
        ALTER TABLE policy_role_conditions OWNER TO mnt_app;
        ALTER TABLE user_role_assignments OWNER TO mnt_app;

        REVOKE ALL ON leave_requests FROM PUBLIC, mnt_rt, mnt_leave_cmd, mnt_leave_definer;
        GRANT SELECT, INSERT, UPDATE ON leave_requests TO mnt_rt;
        "#,
    )
    .execute(pool)
    .await
    .expect("the migrated fixture must be reducible to the populated pre-0166 shape");
}

async fn login_role_pool(owner_pool: &PgPool, role: &str, password: &str) -> PgPool {
    let options = owner_pool
        .connect_options()
        .as_ref()
        .clone()
        .username(role)
        .password(password);
    PgPoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap()
}

async fn runtime_role_pool(owner_pool: &PgPool) -> PgPool {
    let options = owner_pool.connect_options().as_ref().clone();
    PgPoolOptions::new()
        .max_connections(1)
        .after_connect(|connection, _metadata| {
            Box::pin(async move {
                sqlx::query("SET ROLE mnt_rt").execute(connection).await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .unwrap()
}

async fn command_role_pool(owner_pool: &PgPool) -> PgPool {
    let options = owner_pool.connect_options().as_ref().clone();
    PgPoolOptions::new()
        .max_connections(1)
        .after_connect(|connection, _metadata| {
            Box::pin(async move {
                sqlx::query("SET ROLE mnt_leave_cmd")
                    .execute(connection)
                    .await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .unwrap()
}

async fn definer_role_pool(owner_pool: &PgPool) -> PgPool {
    let options = owner_pool.connect_options().as_ref().clone();
    PgPoolOptions::new()
        .max_connections(1)
        .after_connect(|connection, _metadata| {
            Box::pin(async move {
                sqlx::query("SET ROLE mnt_leave_definer")
                    .execute(connection)
                    .await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .unwrap()
}

async fn seed_pre_0166_data(pool: &PgPool) {
    sqlx::query(
        "INSERT INTO organizations (id, slug, name) VALUES ($1, 'leave-a166', 'Leave A166')",
    )
    .bind(ORG)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO regions (id, name, org_id) VALUES ($1, 'Region A166', $2)")
        .bind(REGION)
        .bind(ORG)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO branches (id, region_id, name, org_id) VALUES ($1, $2, 'Branch A166', $3)",
    )
    .bind(BRANCH)
    .bind(REGION)
    .bind(ORG)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, org_id, is_active) \
         VALUES ($1, 'User A166', ARRAY['ADMIN']::text[], $2, true)",
    )
    .bind(USER)
    .bind(ORG)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, org_id, is_active) \
         VALUES ($1, 'Decider A166', ARRAY['ADMIN']::text[], $2, true)",
    )
    .bind(DECIDER)
    .bind(ORG)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)")
        .bind(DECIDER)
        .bind(BRANCH)
        .bind(ORG)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO employees \
         (id, org_id, company, name, source_filename, source_sheet, source_row, source_key, \
          hire_date, employment_status, leave_accrued, leave_used, leave_remaining) \
         VALUES ($1, $2, 'A166', 'Employee A166', 'a166.xlsx', 'Sheet1', 1, 'a166-employee', \
                 DATE '2020-01-01', 'ACTIVE', 15, 2, 13)",
    )
    .bind(EMPLOYEE)
    .bind(ORG)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("UPDATE users SET employee_id = $2 WHERE id = $1 AND org_id = $3")
        .bind(USER)
        .bind(EMPLOYEE)
        .bind(ORG)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO leave_requests \
         (id, org_id, branch_id, requester_user_id, subject_employee_id, leave_type, days, \
          start_date, end_date, reason, status) \
         VALUES ($1, $2, $3, $4, $5, 'annual', 2.5, DATE '2026-08-03', \
                 DATE '2026-08-05', 'pre-0166 populated request', 'pending')",
    )
    .bind(PREEXISTING_REQUEST)
    .bind(ORG)
    .bind(BRANCH)
    .bind(USER)
    .bind(EMPLOYEE)
    .execute(pool)
    .await
    .unwrap();
}

fn database_error_code(error: &sqlx::Error) -> Option<String> {
    error
        .as_database_error()?
        .code()
        .map(|code| code.into_owned())
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn populated_upgrade_preserves_pre_0166_read_and_insert_contract(owner_pool: PgPool) {
    restore_pre_0166_schema(&owner_pool).await;
    seed_pre_0166_data(&owner_pool).await;

    let migrator = login_role_pool(&owner_pool, "mnt_app", MIGRATOR_PASSWORD).await;
    sqlx::raw_sql(MIGRATION_0166)
        .execute(&migrator)
        .await
        .expect("the exact shipped 0166 migration must upgrade populated pre-0166 data");

    let preexisting = sqlx::query(
        "SELECT days::text AS days, legacy_days::text AS legacy_days, charge_state \
         FROM leave_requests WHERE id = $1",
    )
    .bind(PREEXISTING_REQUEST)
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(preexisting.get::<String, _>("days"), "2.500000");
    assert_eq!(preexisting.get::<String, _>("legacy_days"), "2.500000");
    assert_eq!(
        preexisting.get::<String, _>("charge_state"),
        "review_required"
    );

    let runtime = runtime_role_pool(&owner_pool).await;
    sqlx::query("SELECT set_config('app.current_org', $1, false)")
        .bind(ORG.to_string())
        .execute(&runtime)
        .await
        .unwrap();

    let protected_employee_insert = sqlx::query(
        "INSERT INTO employees \
         (org_id, company, name, source_filename, source_sheet, source_row, source_key, \
          hire_date, employment_status, leave_accrued, leave_used, leave_remaining) \
         VALUES ($1, 'forged', 'forged', 'forged.xlsx', 'Sheet1', 9, 'forged-a166', \
                 DATE '2024-01-01', 'ACTIVE', 15, 0, 15)",
    )
    .bind(ORG)
    .execute(&runtime)
    .await
    .expect_err("runtime employee INSERT must not seed protected leave balances");
    assert_eq!(
        database_error_code(&protected_employee_insert).as_deref(),
        Some("42501")
    );

    // This is the SQL shape issued by the pre-0166 binary after an application
    // rollback: it knows only `days`, not any exact-charge columns.
    sqlx::query(
        "INSERT INTO leave_requests \
         (id, org_id, branch_id, requester_user_id, subject_employee_id, leave_type, days, \
          start_date, end_date, reason, status) \
         VALUES ($1, $2, $3, $4, $5, 'half_day', 0.5, DATE '2026-09-01', \
                 DATE '2026-09-01', 'old binary rollback request', 'pending')",
    )
    .bind(ROLLBACK_REQUEST)
    .bind(ORG)
    .bind(BRANCH)
    .bind(USER)
    .bind(EMPLOYEE)
    .execute(&runtime)
    .await
    .expect("the pre-0166 INSERT contract must remain usable after 0166");

    let rollback_row = sqlx::query(
        "SELECT days::text AS days, legacy_days::text AS legacy_days, charge_state, \
                charge_review_reasons, charge_units::text AS charge_units \
         FROM leave_requests WHERE id = $1",
    )
    .bind(ROLLBACK_REQUEST)
    .fetch_one(&runtime)
    .await
    .unwrap();
    assert_eq!(rollback_row.get::<String, _>("days"), "0.500000");
    assert_eq!(rollback_row.get::<String, _>("legacy_days"), "0.500000");
    assert_eq!(
        rollback_row.get::<String, _>("charge_state"),
        "review_required"
    );
    assert_eq!(
        rollback_row.get::<Vec<String>, _>("charge_review_reasons"),
        vec!["missing_calendar"]
    );
    assert!(
        rollback_row
            .get::<Option<String>, _>("charge_units")
            .is_none()
    );

    // Exact base-adapter decision SQL: the old binary has no request-version
    // parameter, and writes the audit receipt in this same transaction.
    let mut legacy_decide = runtime.begin().await.unwrap();
    let old_shape = sqlx::query(
        "UPDATE leave_requests \
         SET status = 'returned', decided_by = $2, decided_at = now(), \
             decision_comment = 'needs correction' \
         WHERE id = $1 AND status = 'pending' \
         RETURNING days::float8 AS days, status, request_version",
    )
    .bind(ROLLBACK_REQUEST)
    .bind(DECIDER)
    .fetch_one(&mut *legacy_decide)
    .await
    .expect("the base adapter's decision update must survive the expand migration");
    assert_eq!(old_shape.get::<f64, _>("days"), 0.5);
    assert_eq!(old_shape.get::<String, _>("status"), "returned");
    assert_eq!(old_shape.get::<i64, _>("request_version"), 2);
    sqlx::query(
        "INSERT INTO audit_events \
         (actor, action, target_type, target_id, branch_id, before_snap, after_snap, \
          trace_id, span_id, occurred_at, org_id) \
         VALUES ($1, 'leave_request.decide', 'leave_request', $2, $3, \
                 '{\"status\":\"pending\"}'::jsonb, '{\"status\":\"returned\"}'::jsonb, \
                 '11111111111111111111111111111111', '2222222222222222', now(), $4)",
    )
    .bind(DECIDER)
    .bind(ROLLBACK_REQUEST.to_string())
    .bind(BRANCH)
    .bind(ORG)
    .execute(&mut *legacy_decide)
    .await
    .expect("the base adapter's atomic audit receipt must survive the expand migration");
    legacy_decide.commit().await.unwrap();

    let second_decision_error = sqlx::query(
        "UPDATE leave_requests SET status = 'rejected', decided_by = $2, decided_at = now(), \
         decision_comment = 'second writer' WHERE id = $1",
    )
    .bind(ROLLBACK_REQUEST)
    .bind(DECIDER)
    .execute(&runtime)
    .await
    .expect_err("a legacy second writer must not re-decide a terminal request");
    assert_eq!(
        database_error_code(&second_decision_error).as_deref(),
        Some("42501")
    );

    let legacy_approval_request = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO leave_requests \
         (id,org_id,branch_id,requester_user_id,subject_employee_id,leave_type,days, \
          start_date,end_date,reason,status) \
         VALUES ($1,$2,$3,$4,$5,'annual',1,DATE '2026-09-03',DATE '2026-09-03', \
                 'old binary approval','pending')",
    )
    .bind(legacy_approval_request)
    .bind(ORG)
    .bind(BRANCH)
    .bind(USER)
    .bind(EMPLOYEE)
    .execute(&runtime)
    .await
    .unwrap();
    let mut legacy_approval = runtime.begin().await.unwrap();
    sqlx::query(
        "UPDATE leave_requests SET status='approved',decided_by=$2,decided_at=now() \
         WHERE id=$1 AND status='pending'",
    )
    .bind(legacy_approval_request)
    .bind(DECIDER)
    .execute(&mut *legacy_approval)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE employees SET leave_used=COALESCE(leave_used,0)+1, \
         leave_remaining=COALESCE(leave_remaining,0)-1,updated_at=now() \
         WHERE id=$1 AND COALESCE(leave_remaining,0)>=1",
    )
    .bind(EMPLOYEE)
    .execute(&mut *legacy_approval)
    .await
    .expect("the rollback binary's exact same-transaction approval ledger write must survive");
    sqlx::query(
        "INSERT INTO audit_events \
         (actor,action,target_type,target_id,branch_id,before_snap,after_snap, \
          trace_id,span_id,occurred_at,org_id) \
         VALUES ($1,'leave_request.decide','leave_request',$2,$3, \
                 '{\"status\":\"pending\"}'::jsonb,'{\"status\":\"approved\"}'::jsonb, \
                 '12121212121212121212121212121212','3434343434343434',now(),$4)",
    )
    .bind(DECIDER)
    .bind(legacy_approval_request.to_string())
    .bind(BRANCH)
    .bind(ORG)
    .execute(&mut *legacy_approval)
    .await
    .unwrap();
    legacy_approval.commit().await.unwrap();
    let legacy_ledger: (String, String) =
        sqlx::query_as("SELECT leave_used::text,leave_remaining::text FROM employees WHERE id=$1")
            .bind(EMPLOYEE)
            .fetch_one(&owner_pool)
            .await
            .unwrap();
    assert_eq!(
        legacy_ledger,
        ("3.000000".to_owned(), "12.000000".to_owned())
    );

    let forged_ledger = sqlx::query(
        "UPDATE employees SET leave_used=leave_used+1,leave_remaining=leave_remaining-1 \
         WHERE id=$1",
    )
    .bind(EMPLOYEE)
    .execute(&runtime)
    .await
    .expect_err("runtime cannot mutate the protected ledger without a same-transaction approval");
    assert_eq!(
        database_error_code(&forged_ledger).as_deref(),
        Some("42501")
    );

    let forged_charge_error = sqlx::query(
        "INSERT INTO leave_requests \
         (org_id, branch_id, requester_user_id, subject_employee_id, leave_type, days, \
          start_date, end_date, reason, status, charge_state, charge_review_reasons, charge_units) \
         VALUES ($1, $2, $3, $4, 'annual', 1, DATE '2026-09-02', DATE '2026-09-02', \
                 'forged exact charge', 'pending', 'resolved', ARRAY[]::text[], 1)",
    )
    .bind(ORG)
    .bind(BRANCH)
    .bind(USER)
    .bind(EMPLOYEE)
    .execute(&runtime)
    .await
    .expect_err("legacy INSERT compatibility must not expose exact-charge authority");
    assert_eq!(
        database_error_code(&forged_charge_error).as_deref(),
        Some("42501")
    );

    // Versionless v1 command requests are first-writer-wins under the row lock;
    // modern callers still receive an exact stale-version conflict.
    let v1_request = Uuid::new_v4();
    let modern_request = Uuid::new_v4();
    for (id, reason) in [
        (v1_request, "v1 versionless decision"),
        (modern_request, "modern stale decision"),
    ] {
        sqlx::query(
            "INSERT INTO leave_requests \
             (id, org_id, branch_id, requester_user_id, subject_employee_id, leave_type, days, \
              start_date, end_date, reason, status) \
             VALUES ($1, $2, $3, $4, $5, 'annual', 1, DATE '2026-10-01', \
                     DATE '2026-10-01', $6, 'pending')",
        )
        .bind(id)
        .bind(ORG)
        .bind(BRANCH)
        .bind(USER)
        .bind(EMPLOYEE)
        .bind(reason)
        .execute(&runtime)
        .await
        .unwrap();
    }

    let command = command_role_pool(&owner_pool).await;
    sqlx::query("SELECT set_config('app.current_org', $1, false)")
        .bind(ORG.to_string())
        .execute(&command)
        .await
        .unwrap();
    let v1_outcome: String = sqlx::query_scalar(
        "SELECT outcome FROM leave_api.decide_request( \
             $1, $2, $3, NULL, 'reject', 'v1 reject', \
             '33333333333333333333333333333333', '4444444444444444')",
    )
    .bind(ORG)
    .bind(v1_request)
    .bind(DECIDER)
    .fetch_one(&command)
    .await
    .expect("a missing v1 expected_version must use locked first-writer-wins semantics");
    assert_eq!(v1_outcome, "decided");

    let repeated_v1 = sqlx::query(
        "SELECT * FROM leave_api.decide_request( \
             $1, $2, $3, NULL, 'reject', 'repeated', \
             '55555555555555555555555555555555', '6666666666666666')",
    )
    .bind(ORG)
    .bind(v1_request)
    .bind(DECIDER)
    .fetch_one(&command)
    .await
    .expect_err("a second versionless writer must lose after the first terminal transition");
    assert_eq!(database_error_code(&repeated_v1).as_deref(), Some("P0001"));

    let stale_modern = sqlx::query(
        "SELECT * FROM leave_api.decide_request( \
             $1, $2, $3, 99, 'reject', 'stale', \
             '77777777777777777777777777777777', '8888888888888888')",
    )
    .bind(ORG)
    .bind(modern_request)
    .bind(DECIDER)
    .fetch_one(&command)
    .await
    .expect_err("a modern stale expected_version must still fail exact CAS");
    assert_eq!(database_error_code(&stale_modern).as_deref(), Some("40001"));

    // A resolved create uses an intermediate valid review-required row, then
    // installs its immutable evidence pointer in the same transaction. Approval
    // increments request CAS only; the pointed charge evidence version remains 1.
    let definer = definer_role_pool(&owner_pool).await;
    sqlx::query("SELECT set_config('app.current_org', $1, false)")
        .bind(ORG.to_string())
        .execute(&definer)
        .await
        .unwrap();
    sqlx::query("UPDATE employees SET home_branch_id = $2 WHERE id = $1 AND org_id = $3")
        .bind(EMPLOYEE)
        .bind(BRANCH)
        .bind(ORG)
        .execute(&definer)
        .await
        .unwrap();

    let resolved_request = Uuid::new_v4();
    let submission_key = Uuid::new_v4();
    let created = sqlx::query(
        r#"
        SELECT request_id, request_version, charge_version, charge_units::text AS charge_units
        FROM leave_api.create_request(
            $1, $2, $3, 'annual', DATE '2026-11-03', DATE '2026-11-03',
            'resolved create', NULL, ARRAY[]::text[], $4,
            '[{"date":"2026-11-03","obligation":{"kind":"scheduled","minutes":480},"units":"1"}]'::jsonb,
            '{"kind":"calendar","reference":"calendar-a166","revision":"1"}'::jsonb,
            '{"kind":"policy","reference":"policy-a166","revision":"1"}'::jsonb,
            '[]'::jsonb,
            $5, '99999999999999999999999999999999', 'aaaaaaaaaaaaaaaa'
        )
        "#,
    )
    .bind(ORG)
    .bind(resolved_request)
    .bind(USER)
    .bind(BRANCH)
    .bind(submission_key)
    .fetch_one(&command)
    .await
    .expect("resolved create must satisfy every immediate row CHECK and install its pointer");
    assert_eq!(created.get::<Uuid, _>("request_id"), resolved_request);
    assert_eq!(created.get::<i64, _>("request_version"), 1);
    assert_eq!(created.get::<i64, _>("charge_version"), 1);
    assert_eq!(created.get::<String, _>("charge_units"), "1.000000");

    // Simulate a committed response that the client never received. Retrying
    // the same canonical payload under the same stable key returns the first
    // request even after mutable routing/evidence context changes, and appends
    // neither a second request nor a second audit event.
    sqlx::query("UPDATE employees SET home_branch_id=NULL WHERE org_id=$1 AND id=$2")
        .bind(ORG)
        .bind(EMPLOYEE)
        .execute(&definer)
        .await
        .unwrap();
    let retry_request = Uuid::new_v4();
    let changed_evidence_branch = Uuid::new_v4();
    let retried_request_id: Uuid = sqlx::query_scalar(
        r#"
        SELECT request_id FROM leave_api.create_request(
            $1, $2, $3, 'annual', DATE '2026-11-03', DATE '2026-11-03',
            'resolved create', NULL, ARRAY[]::text[], $4,
            '{"calendar_state":"changed_after_commit"}'::jsonb,
            '{"revision":"replaced"}'::jsonb,
            '{"revision":"retired"}'::jsonb,
            '[{"source":"changed"}]'::jsonb,
            $5, 'dddddddddddddddddddddddddddddddd', 'eeeeeeeeeeeeeeee'
        )
        "#,
    )
    .bind(ORG)
    .bind(retry_request)
    .bind(USER)
    .bind(changed_evidence_branch)
    .bind(submission_key)
    .fetch_one(&command)
    .await
    .expect("a response-loss retry must return the originally committed request");
    assert_eq!(retried_request_id, resolved_request);

    let idempotency_evidence: (i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM leave_requests \
           WHERE org_id=$1 AND requester_user_id=$2 AND submission_key=$3), \
          (SELECT count(*) FROM audit_events \
           WHERE org_id=$1 AND action='leave_request.create' AND target_id=$4)",
    )
    .bind(ORG)
    .bind(USER)
    .bind(submission_key)
    .bind(resolved_request.to_string())
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(idempotency_evidence, (1, 1));

    let idempotency_conflict = sqlx::query(
        r#"
        SELECT * FROM leave_api.create_request(
            $1, $2, $3, 'annual', DATE '2026-11-03', DATE '2026-11-03',
            'changed payload', NULL, ARRAY[]::text[], $4,
            '[{"date":"2026-11-03","obligation":{"kind":"scheduled","minutes":480},"units":"1"}]'::jsonb,
            '{"kind":"calendar","reference":"calendar-a166","revision":"1"}'::jsonb,
            '{"kind":"policy","reference":"policy-a166","revision":"1"}'::jsonb,
            '[]'::jsonb,
            $5, 'ffffffffffffffffffffffffffffffff', '1111111111111111'
        )
        "#,
    )
    .bind(ORG)
    .bind(Uuid::new_v4())
    .bind(USER)
    .bind(BRANCH)
    .bind(submission_key)
    .fetch_one(&command)
    .await
    .expect_err("the same submission key must reject a different canonical payload");
    assert_eq!(
        database_error_code(&idempotency_conflict).as_deref(),
        Some("22023")
    );

    let pointer = sqlx::query(
        "SELECT lr.days::text AS days, lr.charge_state, lr.request_version, lr.charge_version, \
                r.charge_version AS resolution_version, \
                (lr.current_charge_resolution_id = r.id) AS exact_pointer \
         FROM leave_requests lr \
         JOIN leave_charge_resolutions r ON r.org_id = lr.org_id \
          AND r.request_id = lr.id AND r.id = lr.current_charge_resolution_id \
         WHERE lr.org_id = $1 AND lr.id = $2",
    )
    .bind(ORG)
    .bind(resolved_request)
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(pointer.get::<String, _>("days"), "1.000000");
    assert_eq!(pointer.get::<String, _>("charge_state"), "resolved");
    assert_eq!(pointer.get::<i64, _>("request_version"), 1);
    assert_eq!(pointer.get::<i64, _>("charge_version"), 1);
    assert_eq!(pointer.get::<i64, _>("resolution_version"), 1);
    assert!(pointer.get::<bool, _>("exact_pointer"));

    let approval = sqlx::query(
        "SELECT request_version, charge_version, outcome \
         FROM leave_api.decide_request( \
             $1, $2, $3, 1, 'approve', NULL, \
             'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'cccccccccccccccc')",
    )
    .bind(ORG)
    .bind(resolved_request)
    .bind(DECIDER)
    .fetch_one(&command)
    .await
    .expect("normal approval must preserve the immutable charge evidence pointer/version");
    assert_eq!(approval.get::<i64, _>("request_version"), 2);
    assert_eq!(approval.get::<i64, _>("charge_version"), 1);
    assert_eq!(approval.get::<String, _>("outcome"), "decided");

    let approved_pointer = sqlx::query(
        "SELECT lr.request_version, lr.charge_version, r.charge_version AS resolution_version \
         FROM leave_requests lr JOIN leave_charge_resolutions r \
          ON r.org_id = lr.org_id AND r.id = lr.current_charge_resolution_id \
         WHERE lr.org_id = $1 AND lr.id = $2",
    )
    .bind(ORG)
    .bind(resolved_request)
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(approved_pointer.get::<i64, _>("request_version"), 2);
    assert_eq!(approved_pointer.get::<i64, _>("charge_version"), 1);
    assert_eq!(approved_pointer.get::<i64, _>("resolution_version"), 1);

    // The SECURITY DEFINER import boundary independently re-evaluates the
    // effective org-wide PBAC grant. An EXECUTIVE custom allow is accepted
    // only while its role is active and every condition preserves All scope.
    let custom_actor = Uuid::new_v4();
    let custom_role = Uuid::new_v4();
    let custom_condition = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users (id,display_name,roles,team,is_active,org_id) \
         VALUES ($1,'Custom importer',ARRAY['EXECUTIVE']::text[],'정비',true,$2)",
    )
    .bind(custom_actor)
    .bind(ORG)
    .execute(&owner_pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO policy_roles (id,org_id,role_key,display_name,status,is_system) \
         VALUES ($1,$2,'leave_importer_a166','Leave importer A166','ACTIVE',false)",
    )
    .bind(custom_role)
    .bind(ORG)
    .execute(&owner_pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO policy_role_permissions \
         (org_id,role_id,feature_key,permission_level) \
         VALUES ($1,$2,'employee_directory_manage','allow')",
    )
    .bind(ORG)
    .bind(custom_role)
    .execute(&owner_pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO user_role_assignments (org_id,user_id,role_id) VALUES ($1,$2,$3)")
        .bind(ORG)
        .bind(custom_actor)
        .bind(custom_role)
        .execute(&owner_pool)
        .await
        .unwrap();
    sqlx::query("SELECT leave_api.assert_employee_importer($1,$2)")
        .bind(ORG)
        .bind(custom_actor)
        .execute(&definer)
        .await
        .expect("an active condition-free org-wide custom allow must be effective");

    sqlx::query(
        "INSERT INTO policy_role_conditions \
         (id,org_id,role_id,condition_key,attribute,operator,condition_values) \
         VALUES ($1,$2,$3,'team_match','team','equals',ARRAY['MAINTENANCE']::text[])",
    )
    .bind(custom_condition)
    .bind(ORG)
    .bind(custom_role)
    .execute(&owner_pool)
    .await
    .unwrap();
    sqlx::query("SELECT leave_api.assert_employee_importer($1,$2)")
        .bind(ORG)
        .bind(custom_actor)
        .execute(&definer)
        .await
        .expect("a matching team condition preserves the executive's All scope");

    sqlx::query(
        "UPDATE policy_role_conditions SET condition_values=ARRAY['PREVENTION']::text[] \
         WHERE id=$1",
    )
    .bind(custom_condition)
    .execute(&owner_pool)
    .await
    .unwrap();
    let mismatched_team = sqlx::query("SELECT leave_api.assert_employee_importer($1,$2)")
        .bind(ORG)
        .bind(custom_actor)
        .execute(&definer)
        .await
        .expect_err("a mismatched team condition must fail closed");
    assert_eq!(
        database_error_code(&mismatched_team).as_deref(),
        Some("42501")
    );

    sqlx::query(
        "UPDATE policy_role_conditions \
         SET attribute='branch',operator='equals',condition_values=ARRAY[$2::text] \
         WHERE id=$1",
    )
    .bind(custom_condition)
    .bind(BRANCH)
    .execute(&owner_pool)
    .await
    .unwrap();
    let narrowed_scope = sqlx::query("SELECT leave_api.assert_employee_importer($1,$2)")
        .bind(ORG)
        .bind(custom_actor)
        .execute(&definer)
        .await
        .expect_err("a branch condition narrows All and cannot authorize org-wide import");
    assert_eq!(
        database_error_code(&narrowed_scope).as_deref(),
        Some("42501")
    );

    sqlx::query("DELETE FROM policy_role_conditions WHERE id=$1")
        .bind(custom_condition)
        .execute(&owner_pool)
        .await
        .unwrap();
    sqlx::query("UPDATE policy_roles SET status='DRAFT' WHERE id=$1")
        .bind(custom_role)
        .execute(&owner_pool)
        .await
        .unwrap();
    let draft_role = sqlx::query("SELECT leave_api.assert_employee_importer($1,$2)")
        .bind(ORG)
        .bind(custom_actor)
        .execute(&definer)
        .await
        .expect_err("a DRAFT custom role must not grant import authority");
    assert_eq!(database_error_code(&draft_role).as_deref(), Some("42501"));
}
