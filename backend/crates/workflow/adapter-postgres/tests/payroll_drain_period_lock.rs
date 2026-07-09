#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! BE-LC period-lock enforcement on the REAL payroll write path
//! (`drain_payroll_job_outbox`), proven as the genuine non-owner `mnt_rt` role
//! under FORCE RLS:
//!
//!   (a) an active `payroll` period lock overlapping the event's draft period
//!       makes the drain SKIP the event fail-closed: no `payroll_draft_runs`
//!       row is created and the event stays PENDING (retryable, never lost);
//!   (b) after unlock the SAME event drains normally: draft created, event
//!       acked DELIVERED.

use mnt_kernel_core::OrgId;
use mnt_platform_request_context::scope_org;
use mnt_workflow_runtime_adapter_postgres::PgWorkflowRuntimeStore;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use uuid::Uuid;

async fn runtime_role_pool(owner_pool: &PgPool) -> PgPool {
    for grant in [
        "GRANT SELECT, UPDATE ON workflow_outbox_events TO mnt_rt",
        "GRANT SELECT, INSERT, UPDATE ON payroll_draft_runs TO mnt_rt",
        "GRANT SELECT, INSERT ON audit_events TO mnt_rt",
        "GRANT SELECT ON organizations TO mnt_rt",
    ] {
        sqlx::query(grant).execute(owner_pool).await.unwrap();
    }
    let options = owner_pool.connect_options().as_ref().clone();
    PgPoolOptions::new()
        .max_connections(4)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("SET ROLE mnt_rt").execute(conn).await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .unwrap()
}

/// Seed org + minimal ACTIVE definition + RUNNING run + one PENDING JOB
/// payroll_draft outbox event for June 2026.
async fn seed_payroll_event(owner_pool: &PgPool, org: Uuid) -> (Uuid, Uuid) {
    sqlx::query(
        "INSERT INTO organizations (id, slug, name) VALUES ($1, 'plock', 'Lock Org') \
         ON CONFLICT (id) DO NOTHING",
    )
    .bind(org)
    .execute(owner_pool)
    .await
    .unwrap();
    let definition_id: Uuid = sqlx::query_scalar(
        "INSERT INTO workflow_definitions \
             (org_id, workflow_key, display_name, object_type, status, latest_version, active_version) \
         VALUES ($1, 'payroll.period_lock', 'Payroll Lock', 'payroll_period', 'ACTIVE', 1, 1) \
         RETURNING id",
    )
    .bind(org)
    .fetch_one(owner_pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO workflow_definition_versions \
             (org_id, definition_id, version, status, definition, required_approval_line, required_payment_line) \
         VALUES ($1, $2, 1, 'PUBLISHED', '{}'::jsonb, TRUE, TRUE)",
    )
    .bind(org)
    .bind(definition_id)
    .execute(owner_pool)
    .await
    .unwrap();
    let run_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO workflow_runs \
             (id, org_id, definition_id, definition_version, status, trigger_type, \
              idempotency_key, correlation_id, input_payload) \
         VALUES ($1, $2, $3, 1, 'RUNNING', 'OBJECT_EVENT', $4, $5, '{}'::jsonb)",
    )
    .bind(run_id)
    .bind(org)
    .bind(definition_id)
    .bind(format!("plock-trigger-{run_id}"))
    .bind(format!("plock-corr-{run_id}"))
    .execute(owner_pool)
    .await
    .unwrap();
    let event_id: Uuid = sqlx::query_scalar(
        "INSERT INTO workflow_outbox_events \
             (org_id, run_id, channel, destination_ref, idempotency_key, status, payload) \
         VALUES ($1, $2, 'JOB', 'payroll', $3, 'PENDING', $4) RETURNING id",
    )
    .bind(org)
    .bind(run_id)
    .bind(format!("plock-payroll-{run_id}"))
    .bind(serde_json::json!({
        "job": "payroll_draft",
        "connector": "payroll",
        "period_start": "2026-06-01",
        "period_end": "2026-06-30",
    }))
    .fetch_one(owner_pool)
    .await
    .unwrap();
    (run_id, event_id)
}

#[sqlx::test(migrations = "../../platform/db/migrations")]
async fn payroll_period_lock_blocks_draft_creation_and_unlock_restores(owner_pool: PgPool) {
    let org = OrgId::knl();
    let org_uuid = *org.as_uuid();
    let (_run_id, event_id) = seed_payroll_event(&owner_pool, org_uuid).await;

    // Active payroll lock overlapping the event's June period.
    let lock_id: Uuid = sqlx::query_scalar(
        "INSERT INTO period_locks (org_id, domain, period_start, period_end, reason) \
         VALUES ($1, 'payroll', DATE '2026-06-01', DATE '2026-06-30', '6월 급여 마감') \
         RETURNING id",
    )
    .bind(org_uuid)
    .fetch_one(&owner_pool)
    .await
    .unwrap();

    let rt_pool = runtime_role_pool(&owner_pool).await;
    let store = PgWorkflowRuntimeStore::new(rt_pool.clone());

    // (a) Locked → drain creates nothing, event stays PENDING (retryable).
    let created = scope_org(org, store.drain_payroll_job_outbox(org, 10))
        .await
        .expect("drain itself must not fail on a locked period");
    assert_eq!(created, 0, "no payroll draft may be created inside a lock");

    let (status, drafts): (String, i64) = {
        let status: String =
            sqlx::query_scalar("SELECT status FROM workflow_outbox_events WHERE id = $1")
                .bind(event_id)
                .fetch_one(&owner_pool)
                .await
                .unwrap();
        let drafts: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM payroll_draft_runs WHERE org_id = $1")
                .bind(org_uuid)
                .fetch_one(&owner_pool)
                .await
                .unwrap();
        (status, drafts)
    };
    assert_eq!(status, "PENDING", "the blocked event must stay retryable");
    assert_eq!(
        drafts, 0,
        "no draft row may land while the period is locked"
    );

    // (b) Unlock → the SAME event drains: draft created, event DELIVERED.
    sqlx::query(
        "UPDATE period_locks SET unlocked_at = now(), unlock_reason = '재개' WHERE id = $1",
    )
    .bind(lock_id)
    .execute(&owner_pool)
    .await
    .unwrap();

    let created = scope_org(org, store.drain_payroll_job_outbox(org, 10))
        .await
        .expect("drain must succeed after unlock");
    assert_eq!(created, 1, "the retried event must now create the draft");

    let status: String =
        sqlx::query_scalar("SELECT status FROM workflow_outbox_events WHERE id = $1")
            .bind(event_id)
            .fetch_one(&owner_pool)
            .await
            .unwrap();
    assert_eq!(status, "DELIVERED");
    let drafts: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM payroll_draft_runs \
         WHERE org_id = $1 AND period_start = DATE '2026-06-01' AND period_end = DATE '2026-06-30'",
    )
    .bind(org_uuid)
    .fetch_one(&owner_pool)
    .await
    .unwrap();
    assert_eq!(drafts, 1, "exactly one June draft after unlock");
}
