#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! BE-AUTO slice 1 E2E — event trigger bindings + cron schedule poller against
//! the REAL runtime engine on a genuine `PgWorkflowRuntimeStore`.
//!
//! ## What this proves
//! 1. an ENABLED `workflow_trigger_bindings` rule fires: dispatching the
//!    registered `work_order.completed` event starts EXACTLY one run of the
//!    bound `wf.exec.v1` definition (trigger_type OBJECT_EVENT, driven to
//!    SUCCEEDED through the graph walk), and RE-dispatching the same event
//!    occurrence adds ZERO runs (deterministic `trigger:{binding}:{object}`
//!    key against the run spine's `UNIQUE(org_id, idempotency_key)`);
//! 2. a DISABLED binding does NOT fire — zero runs;
//! 3. the schedule poller starts a due schedule's run EXACTLY once under
//!    CONCURRENT polling (two `poll_org` passes racing on the same due fire),
//!    stamps the run's `schedule_id` provenance + `SCHEDULE` trigger type, and
//!    advances `next_run_at` into the future exactly once (the guarded
//!    advance); a follow-up poll starts nothing.
//! 4. recovery uses the durable initiator/trace and exact immutable graph even
//!    after a different actor retries or ACTIVE advances/pauses;
//! 5. divergent persisted trigger/input identity fails closed before effects;
//! 6. the `(org,key)` claim lock is reached before any run/ACTIVE read, and a
//!    crash row committed while a retry waits wins over a graph-invalid v2;
//! 7. no existing run plus no ACTIVE executable writes no run/start audit and
//!    does not consume a due schedule fire, while a graph-invalid ACTIVE claim
//!    also writes nothing but remains a FAILED fire that advances once.
//!
//! Cron next-fire correctness and garbage rejection are unit-tested in
//! `mnt_app::workflow_schedules`.
//!
//! ## Runtime fidelity (mandatory)
//! Every runtime write + read runs as the genuine non-owner `mnt_rt` role
//! (NOSUPERUSER, NOBYPASSRLS, FORCE RLS) with `app.current_org` armed — never
//! a BYPASSRLS superuser. Only minting the `organizations`/`users` rows
//! (owner-only surfaces for `mnt_rt`) uses the owner pool; binding/schedule
//! seeds, the dispatch/poll, and every assertion read execute as `mnt_rt`
//! under the armed tenant GUC, exactly as production does.

use std::time::Duration;

use mnt_app::workflow_schedules::poll_org;
use mnt_kernel_core::{OrgId, UserId};
use mnt_workflow_runtime_adapter_postgres::PgWorkflowRuntimeStore;
use mnt_workorder_rest::workflow_triggers::{WORK_ORDER_COMPLETED_EVENT, dispatch_event_bindings};
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};
use time::OffsetDateTime;
use uuid::Uuid;

/// Dedicated TEST tenants (fresh, empty sqlx::test DB — never production).
const BINDING_TENANT: Uuid = Uuid::from_u128(0x4d32_11c5_0000_0000_0000_0000_0000_00c5);
const DISABLED_TENANT: Uuid = Uuid::from_u128(0x4d32_11c6_0000_0000_0000_0000_0000_00c6);
const SCHEDULE_TENANT: Uuid = Uuid::from_u128(0x4d32_11c7_0000_0000_0000_0000_0000_00c7);
const ACTOR_DRIFT_TENANT: Uuid = Uuid::from_u128(0x4d32_11c8_0000_0000_0000_0000_0000_00c8);
const VERSION_DRIFT_TENANT: Uuid = Uuid::from_u128(0x4d32_11c9_0000_0000_0000_0000_0000_00c9);
const IDENTITY_DRIFT_TENANT: Uuid = Uuid::from_u128(0x4d32_11ca_0000_0000_0000_0000_0000_00ca);
const CLAIM_SERIALIZATION_TENANT: Uuid = Uuid::from_u128(0x4d32_11cb_0000_0000_0000_0000_0000_00cb);
const NO_ACTIVE_SCHEDULE_TENANT: Uuid = Uuid::from_u128(0x4d32_11cc_0000_0000_0000_0000_0000_00cc);
const PERSISTED_ACTOR_TRACE: &str = "11111111111111111111111111111111";
const PERSISTED_VERSION_TRACE: &str = "22222222222222222222222222222222";
const PERSISTED_IDENTITY_TRACE: &str = "33333333333333333333333333333333";
const SERIALIZED_CLAIM_TRACE: &str = "44444444444444444444444444444444";

// ===========================================================================
// Runtime-role pool + seeds (pattern copied from m2_real_engine_drive.rs).
// ===========================================================================

async fn runtime_role_pool(owner_pool: &PgPool) -> PgPool {
    let options = owner_pool.connect_options().as_ref().clone();
    PgPoolOptions::new()
        .max_connections(8)
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

async fn arm_org(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, org: OrgId) {
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.as_uuid().to_string())
        .execute(&mut **tx)
        .await
        .unwrap();
}

/// Mint the org + one user via the OWNER pool (`mnt_rt` is SELECT-only there).
/// The user backs the bindings/schedules `created_by` FK.
async fn seed_org_and_author(owner_pool: &PgPool, org: OrgId, slug: &str) -> Uuid {
    sqlx::query(
        "INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3) \
         ON CONFLICT (id) DO NOTHING",
    )
    .bind(*org.as_uuid())
    .bind(slug)
    .bind(format!("Org {slug}"))
    .execute(owner_pool)
    .await
    .unwrap();
    let author_id = Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
        .bind(author_id)
        .bind("automation author")
        .bind(vec!["ADMIN".to_owned()])
        .bind(*org.as_uuid())
        .execute(owner_pool)
        .await
        .unwrap();
    author_id
}

/// Seed an ACTIVE `wf.exec.v1` definition with a minimal single-node graph
/// (one `object_gate` → terminal, so a triggered run drives straight to
/// SUCCEEDED), as `mnt_rt` under the armed tenant GUC.
async fn seed_graph_definition(rt_pool: &PgPool, org: OrgId, key: &str) -> Uuid {
    let mut tx = rt_pool.begin().await.unwrap();
    arm_org(&mut tx, org).await;
    let definition_id: Uuid = sqlx::query_scalar(
        "INSERT INTO workflow_definitions \
             (org_id, workflow_key, display_name, object_type, status, \
              latest_version, active_version) \
         VALUES ($1, $2, 'Automation Target', 'work_order', 'ACTIVE', 1, 1) \
         RETURNING id",
    )
    .bind(*org.as_uuid())
    .bind(key)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO workflow_definition_versions \
             (org_id, definition_id, version, status, definition, \
              required_approval_line, required_payment_line) \
         VALUES ($1, $2, 1, 'PUBLISHED', $3, FALSE, FALSE)",
    )
    .bind(*org.as_uuid())
    .bind(definition_id)
    .bind(serde_json::json!({
        "schema_version": "wf.exec.v1",
        "nodes": [
            {"node_key": "record_event", "node_type": "object_gate"}
        ],
        "edges": []
    }))
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    definition_id
}

/// Seed a trigger binding as `mnt_rt` under the armed tenant GUC.
async fn seed_binding(
    rt_pool: &PgPool,
    org: OrgId,
    definition_id: Uuid,
    author: Uuid,
    enabled: bool,
) -> Uuid {
    let mut tx = rt_pool.begin().await.unwrap();
    arm_org(&mut tx, org).await;
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO workflow_trigger_bindings \
             (org_id, definition_id, trigger_type, event_key, enabled, \
              created_by, updated_by) \
         VALUES ($1, $2, 'OBJECT_EVENT', $3, $4, $5, $5) \
         RETURNING id",
    )
    .bind(*org.as_uuid())
    .bind(definition_id)
    .bind(WORK_ORDER_COMPLETED_EVENT)
    .bind(enabled)
    .bind(author)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    id
}

/// Seed a schedule due at `next_run_at`, as `mnt_rt` under the armed GUC.
async fn seed_schedule(
    rt_pool: &PgPool,
    org: OrgId,
    definition_id: Uuid,
    author: Uuid,
    next_run_at: OffsetDateTime,
) -> Uuid {
    let mut tx = rt_pool.begin().await.unwrap();
    arm_org(&mut tx, org).await;
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO workflow_schedules \
             (org_id, label, cron_expr, timezone, definition_id, enabled, \
              next_run_at, created_by, updated_by) \
         VALUES ($1, '매일 아침 자동 상신', '0 9 * * *', 'Asia/Seoul', $2, TRUE, $3, $4, $4) \
         RETURNING id",
    )
    .bind(*org.as_uuid())
    .bind(definition_id)
    .bind(next_run_at)
    .bind(author)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    id
}

/// Tenant-scoped scalar read as `mnt_rt` under the armed GUC.
async fn count(rt_pool: &PgPool, org: OrgId, query: &'static str) -> i64 {
    let mut tx = rt_pool.begin().await.unwrap();
    arm_org(&mut tx, org).await;
    let n: i64 = sqlx::query_scalar(query).fetch_one(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    n
}

// ===========================================================================
// 1. Enabled binding fires exactly one run per event occurrence.
// ===========================================================================

#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn enabled_binding_fires_exactly_one_run_per_event(owner_pool: PgPool) {
    let org = OrgId::from_uuid(BINDING_TENANT);
    let author = seed_org_and_author(&owner_pool, org, "org-auto-binding").await;
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let definition_id = seed_graph_definition(&rt_pool, org, "automation.on_completion").await;
    let binding_id = seed_binding(&rt_pool, org, definition_id, author, true).await;
    let store = PgWorkflowRuntimeStore::new(rt_pool.clone());
    let work_order = Uuid::new_v4();

    let started = dispatch_event_bindings(
        &store,
        org,
        None,
        WORK_ORDER_COMPLETED_EVENT,
        "work_order",
        work_order,
    )
    .await
    .unwrap();
    assert_eq!(started, 1, "the enabled binding must start exactly one run");

    // The run is real engine output: OBJECT_EVENT provenance, driven through
    // the single-node graph to SUCCEEDED, one node run recorded.
    let mut tx = rt_pool.begin().await.unwrap();
    arm_org(&mut tx, org).await;
    let run = sqlx::query(
        "SELECT status, trigger_type, definition_id, object_type, object_id, \
                idempotency_key, schedule_id \
         FROM workflow_runs",
    )
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert_eq!(run.get::<String, _>("status"), "SUCCEEDED");
    assert_eq!(run.get::<String, _>("trigger_type"), "OBJECT_EVENT");
    assert_eq!(run.get::<Uuid, _>("definition_id"), definition_id);
    assert_eq!(
        run.get::<Option<String>, _>("object_type").as_deref(),
        Some("work_order")
    );
    assert_eq!(run.get::<Option<Uuid>, _>("object_id"), Some(work_order));
    assert_eq!(
        run.get::<String, _>("idempotency_key"),
        format!("trigger:{binding_id}:{work_order}")
    );
    assert_eq!(run.get::<Option<Uuid>, _>("schedule_id"), None);
    tx.commit().await.unwrap();
    assert_eq!(
        count(&rt_pool, org, "SELECT count(*) FROM workflow_node_runs").await,
        1
    );
    assert_eq!(
        count(
            &rt_pool,
            org,
            "SELECT count(*) FROM audit_events WHERE action = 'workflow_run.start'",
        )
        .await,
        1,
        "the fresh run row and its sole start audit commit atomically"
    );

    // Re-publishing the SAME event occurrence (crash-replay / double commit
    // point) is a no-op: zero new runs.
    let started_again = dispatch_event_bindings(
        &store,
        org,
        None,
        WORK_ORDER_COMPLETED_EVENT,
        "work_order",
        work_order,
    )
    .await
    .unwrap();
    assert_eq!(
        started_again, 0,
        "same event occurrence must not double-fire"
    );
    assert_eq!(
        count(&rt_pool, org, "SELECT count(*) FROM workflow_runs").await,
        1
    );
    assert_eq!(
        count(
            &rt_pool,
            org,
            "SELECT count(*) FROM audit_events WHERE action = 'workflow_run.start'",
        )
        .await,
        1,
        "an existing claim must not append a duplicate start audit"
    );

    // A DIFFERENT occurrence (another work order completing) fires again.
    let other = Uuid::new_v4();
    let started_other = dispatch_event_bindings(
        &store,
        org,
        None,
        WORK_ORDER_COMPLETED_EVENT,
        "work_order",
        other,
    )
    .await
    .unwrap();
    assert_eq!(started_other, 1);
    assert_eq!(
        count(&rt_pool, org, "SELECT count(*) FROM workflow_runs").await,
        2
    );
    assert_eq!(
        count(
            &rt_pool,
            org,
            "SELECT count(*) FROM audit_events WHERE action = 'workflow_run.start'",
        )
        .await,
        2
    );
}

// ===========================================================================
// 2. Disabled binding does not fire.
// ===========================================================================

#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn disabled_binding_does_not_fire(owner_pool: PgPool) {
    let org = OrgId::from_uuid(DISABLED_TENANT);
    let author = seed_org_and_author(&owner_pool, org, "org-auto-disabled").await;
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let definition_id = seed_graph_definition(&rt_pool, org, "automation.on_completion").await;
    seed_binding(&rt_pool, org, definition_id, author, false).await;
    let store = PgWorkflowRuntimeStore::new(rt_pool.clone());

    let started = dispatch_event_bindings(
        &store,
        org,
        None,
        WORK_ORDER_COMPLETED_EVENT,
        "work_order",
        Uuid::new_v4(),
    )
    .await
    .unwrap();
    assert_eq!(started, 0, "a disabled binding must not fire");
    assert_eq!(
        count(&rt_pool, org, "SELECT count(*) FROM workflow_runs").await,
        0
    );
    assert_eq!(
        count(&rt_pool, org, "SELECT count(*) FROM workflow_node_runs").await,
        0
    );
}

// ===========================================================================
// 3. Schedule poller: exactly once under concurrent poll, guarded advance.
// ===========================================================================

#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn schedule_poller_starts_due_run_exactly_once_under_concurrent_poll(owner_pool: PgPool) {
    let org = OrgId::from_uuid(SCHEDULE_TENANT);
    let author = seed_org_and_author(&owner_pool, org, "org-auto-schedule").await;
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let definition_id = seed_graph_definition(&rt_pool, org, "automation.daily").await;
    let now = OffsetDateTime::now_utc();
    // Due one minute ago, at whole-second precision so the value round-trips
    // Postgres' microsecond timestamptz exactly.
    let due_fire = OffsetDateTime::from_unix_timestamp(now.unix_timestamp() - 60).unwrap();
    let schedule_id = seed_schedule(&rt_pool, org, definition_id, author, due_fire).await;
    let store = PgWorkflowRuntimeStore::new(rt_pool.clone());

    // Two pollers race on the same due fire (the concurrent-poll idempotency
    // claim: deterministic run key + guarded advance).
    let (a, b) = tokio::join!(poll_org(&store, org, now), poll_org(&store, org, now));
    let started = a.unwrap() + b.unwrap();
    assert_eq!(started, 1, "concurrent polls must start exactly one run");
    assert_eq!(
        count(&rt_pool, org, "SELECT count(*) FROM workflow_runs").await,
        1
    );
    assert_eq!(
        count(&rt_pool, org, "SELECT count(*) FROM workflow_node_runs").await,
        1,
        "the losing poll must not duplicate graph drive"
    );
    assert_eq!(
        count(
            &rt_pool,
            org,
            "SELECT count(*) FROM audit_events WHERE action = 'workflow_node.commit'",
        )
        .await,
        1,
        "the losing poll must not duplicate node audit"
    );

    // The run carries schedule provenance and the reserved SCHEDULE trigger.
    let mut tx = rt_pool.begin().await.unwrap();
    arm_org(&mut tx, org).await;
    let run = sqlx::query(
        "SELECT status, trigger_type, schedule_id, idempotency_key, initiated_by \
         FROM workflow_runs",
    )
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert_eq!(run.get::<String, _>("status"), "SUCCEEDED");
    assert_eq!(run.get::<String, _>("trigger_type"), "SCHEDULE");
    assert_eq!(run.get::<Option<Uuid>, _>("schedule_id"), Some(schedule_id));
    assert_eq!(
        run.get::<String, _>("idempotency_key"),
        format!("schedule:{schedule_id}:{}", due_fire.unix_timestamp())
    );
    assert_eq!(
        run.get::<Option<Uuid>, _>("initiated_by"),
        None,
        "system fire has no actor"
    );

    // The schedule advanced exactly once: next_run_at strictly in the future
    // (next 09:00 KST after now), last_run_at = the claimed fire.
    let schedule = sqlx::query(
        "SELECT next_run_at, last_run_at, last_status FROM workflow_schedules WHERE id = $1",
    )
    .bind(schedule_id)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    let next: Option<OffsetDateTime> = schedule.get("next_run_at");
    assert!(
        next.unwrap() > now,
        "next_run_at must advance into the future"
    );
    assert_eq!(
        schedule.get::<Option<OffsetDateTime>, _>("last_run_at"),
        Some(due_fire)
    );
    let last_status: Option<String> = schedule.get("last_status");
    assert!(
        matches!(last_status.as_deref(), Some("STARTED") | Some("SKIPPED")),
        "last_status records the racing pollers' outcome, got {last_status:?}"
    );
    tx.commit().await.unwrap();

    // Nothing is due any more: a follow-up poll starts nothing and adds no rows.
    let again = poll_org(&store, org, OffsetDateTime::now_utc())
        .await
        .unwrap();
    assert_eq!(again, 0);
    assert_eq!(
        count(&rt_pool, org, "SELECT count(*) FROM workflow_runs").await,
        1
    );
    assert_eq!(
        count(&rt_pool, org, "SELECT count(*) FROM workflow_node_runs").await,
        1
    );
    assert_eq!(
        count(
            &rt_pool,
            org,
            "SELECT count(*) FROM audit_events WHERE action = 'workflow_node.commit'",
        )
        .await,
        1
    );
}

// Regression: recovery must retain the persisted initiator when a different actor retries.
#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn conflicted_event_retry_never_reattributes_the_persisted_initiator(owner_pool: PgPool) {
    let org = OrgId::from_uuid(ACTOR_DRIFT_TENANT);
    let initiating_actor = seed_org_and_author(&owner_pool, org, "org-actor-drift").await;
    let retrying_actor = Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
        .bind(retrying_actor)
        .bind("different retry actor")
        .bind(vec!["ADMIN".to_owned()])
        .bind(*org.as_uuid())
        .execute(&owner_pool)
        .await
        .unwrap();

    let rt_pool = runtime_role_pool(&owner_pool).await;
    let definition_id = seed_graph_definition(&rt_pool, org, "automation.actor_drift").await;
    let binding_id = seed_binding(&rt_pool, org, definition_id, initiating_actor, true).await;
    let object_id = Uuid::new_v4();
    let run_id = Uuid::new_v4();

    let mut tx = rt_pool.begin().await.unwrap();
    arm_org(&mut tx, org).await;
    sqlx::query(
        "INSERT INTO workflow_runs \
             (id, org_id, definition_id, definition_version, status, trigger_type, \
              object_type, object_id, idempotency_key, correlation_id, trace_id, \
              input_payload, context_payload, initiated_by) \
         VALUES ($1, $2, $3, 1, 'STARTING', 'OBJECT_EVENT', \
                 'work_order', $4, $5, $6, $7, $8, '{}'::jsonb, $9)",
    )
    .bind(run_id)
    .bind(*org.as_uuid())
    .bind(definition_id)
    .bind(object_id)
    .bind(format!("trigger:{binding_id}:{object_id}"))
    .bind(format!("trigger:{WORK_ORDER_COMPLETED_EVENT}:{object_id}"))
    .bind(PERSISTED_ACTOR_TRACE)
    .bind(serde_json::json!({
        "event_key": WORK_ORDER_COMPLETED_EVENT,
        "object_type": "work_order",
        "object_id": object_id,
    }))
    .bind(initiating_actor)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();

    let store = PgWorkflowRuntimeStore::new(rt_pool.clone());
    let started = dispatch_event_bindings(
        &store,
        org,
        Some(UserId::from_uuid(retrying_actor)),
        WORK_ORDER_COMPLETED_EVENT,
        "work_order",
        object_id,
    )
    .await
    .unwrap();
    assert_eq!(started, 0, "a recovery is not a new externally-owned start");

    let mut tx = rt_pool.begin().await.unwrap();
    arm_org(&mut tx, org).await;
    let wrong_actor_audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events          WHERE actor = $1 AND action IN ('workflow_run.transition','workflow_node.commit')",
    )
    .bind(retrying_actor)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    let persisted_actor: Option<Uuid> =
        sqlx::query_scalar("SELECT initiated_by FROM workflow_runs WHERE id = $1")
            .bind(run_id)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    let persisted_actor_audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events \
         WHERE actor = $1 AND btrim(trace_id) = $2 \
           AND action IN ('workflow_run.transition','workflow_node.commit')",
    )
    .bind(initiating_actor)
    .bind(PERSISTED_ACTOR_TRACE)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    let node_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM workflow_node_runs WHERE run_id = $1")
            .bind(run_id)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    tx.commit().await.unwrap();

    assert_eq!(persisted_actor, Some(initiating_actor));
    assert_eq!(persisted_actor_audits, 2);
    assert_eq!(node_count, 1);
    assert_eq!(
        wrong_actor_audits, 0,
        "a different caller may not resume actor A's run while stamping A's transition/node as actor B"
    );
}

// Regression: a crash-bound run must resume its immutable historical graph after activation moves.
#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn schedule_retry_after_active_version_flip_recovers_bound_version_one(owner_pool: PgPool) {
    let org = OrgId::from_uuid(VERSION_DRIFT_TENANT);
    let author = seed_org_and_author(&owner_pool, org, "org-version-drift").await;
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let definition_id = seed_graph_definition(&rt_pool, org, "automation.version_drift").await;
    let now = OffsetDateTime::now_utc();
    let due_fire = OffsetDateTime::from_unix_timestamp(now.unix_timestamp() - 60).unwrap();
    let schedule_id = seed_schedule(&rt_pool, org, definition_id, author, due_fire).await;
    let run_id = Uuid::new_v4();

    let mut tx = rt_pool.begin().await.unwrap();
    arm_org(&mut tx, org).await;
    sqlx::query(
        "INSERT INTO workflow_runs \
             (id, org_id, definition_id, definition_version, status, trigger_type, \
              idempotency_key, correlation_id, trace_id, input_payload, \
              context_payload, schedule_id) \
         VALUES ($1, $2, $3, 1, 'STARTING', 'SCHEDULE', $4, $4, $5, $6, '{}'::jsonb, $7)",
    )
    .bind(run_id)
    .bind(*org.as_uuid())
    .bind(definition_id)
    .bind(format!(
        "schedule:{schedule_id}:{}",
        due_fire.unix_timestamp()
    ))
    .bind(PERSISTED_VERSION_TRACE)
    .bind(serde_json::json!({
        "schedule_id": schedule_id,
        "schedule_label": "매일 아침 자동 상신",
        "fired_at": due_fire.unix_timestamp(),
    }))
    .bind(schedule_id)
    .execute(&mut *tx)
    .await
    .unwrap();

    // Version rows are immutable, but publication may advance the mutable active pointer
    // while this v1 run is live. The recovery caller must still execute v1.
    sqlx::query(
        "INSERT INTO workflow_definition_versions \
             (org_id, definition_id, version, status, definition, \
              required_approval_line, required_payment_line) \
         VALUES ($1, $2, 2, 'PUBLISHED', $3, FALSE, FALSE)",
    )
    .bind(*org.as_uuid())
    .bind(definition_id)
    .bind(serde_json::json!({
        "schema_version": "wf.exec.v1",
        "nodes": [{"node_key": "version_two", "node_type": "object_gate"}],
        "edges": []
    }))
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE workflow_definitions \
         SET latest_version = 2, active_version = 2, status = 'PAUSED' \
         WHERE id = $1",
    )
    .bind(definition_id)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();

    let store = PgWorkflowRuntimeStore::new(rt_pool.clone());
    assert_eq!(poll_org(&store, org, now).await.unwrap(), 0);

    let mut tx = rt_pool.begin().await.unwrap();
    arm_org(&mut tx, org).await;
    let status: String = sqlx::query_scalar("SELECT status FROM workflow_runs WHERE id = $1")
        .bind(run_id)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    let node_keys: Vec<String> = sqlx::query_scalar(
        "SELECT node_key FROM workflow_node_runs WHERE run_id = $1 ORDER BY node_key",
    )
    .bind(run_id)
    .fetch_all(&mut *tx)
    .await
    .unwrap();
    let last_status: Option<String> =
        sqlx::query_scalar("SELECT last_status FROM workflow_schedules WHERE id = $1")
            .bind(schedule_id)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    let recovery_audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events \
         WHERE btrim(trace_id) = $1 \
           AND action IN ('workflow_run.transition','workflow_node.commit')",
    )
    .bind(PERSISTED_VERSION_TRACE)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();

    assert_eq!(
        status, "SUCCEEDED",
        "the persisted v1 run must not strand in STARTING"
    );
    assert_eq!(
        node_keys,
        vec!["record_event".to_owned()],
        "recovery must drive immutable v1, not active v2"
    );
    assert_eq!(recovery_audits, 2);
    assert_eq!(last_status.as_deref(), Some("SKIPPED"));
}

// Deterministic TOCTOU regression: the retry is observed waiting on the exact
// claim lock before a durable v1 crash row is committed and ACTIVE is replaced
// by a graph-invalid v2. On lock release it must read v1 first and never parse v2.
#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn atomic_claim_serializes_before_reads_and_recovers_crashed_exact_graph(owner_pool: PgPool) {
    let org = OrgId::from_uuid(CLAIM_SERIALIZATION_TENANT);
    let actor = seed_org_and_author(&owner_pool, org, "org-claim-serialization").await;
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let definition_id = seed_graph_definition(&rt_pool, org, "automation.claim_serialized").await;
    let binding_id = seed_binding(&rt_pool, org, definition_id, actor, true).await;
    let object_id = Uuid::new_v4();
    let idempotency_key = format!("trigger:{binding_id}:{object_id}");
    let lock_key = format!("{org}:{idempotency_key}");

    let mut lock_tx = rt_pool.begin().await.unwrap();
    arm_org(&mut lock_tx, org).await;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(&lock_key)
        .execute(&mut *lock_tx)
        .await
        .unwrap();

    let store = PgWorkflowRuntimeStore::new(rt_pool.clone());
    let retry_store = store.clone();
    let retry = tokio::spawn(async move {
        dispatch_event_bindings(
            &retry_store,
            org,
            Some(UserId::from_uuid(actor)),
            WORK_ORDER_COMPLETED_EVENT,
            "work_order",
            object_id,
        )
        .await
    });

    // Do not infer the race from a sleep: prove the retry has reached and is
    // blocked on the exact bigint advisory key before mutating database state.
    let mut observed_waiter = false;
    for _ in 0..200 {
        let waiting: i64 = sqlx::query_scalar(
            "WITH key AS (SELECT hashtextextended($1, 0)::bigint AS value) \
             SELECT count(*) FROM pg_locks, key \
             WHERE locktype = 'advisory' AND NOT granted \
               AND database = (SELECT oid FROM pg_database WHERE datname = current_database()) \
               AND classid = (((key.value >> 32) & 4294967295)::oid) \
               AND objid = ((key.value & 4294967295)::oid)",
        )
        .bind(&lock_key)
        .fetch_one(&owner_pool)
        .await
        .unwrap();
        if waiting == 1 {
            observed_waiter = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(
        observed_waiter,
        "retry must block before any existing/ACTIVE read on the exact claim key"
    );

    let run_id = Uuid::new_v4();
    let mut seed_tx = rt_pool.begin().await.unwrap();
    arm_org(&mut seed_tx, org).await;
    sqlx::query(
        "INSERT INTO workflow_runs \
             (id, org_id, definition_id, definition_version, status, trigger_type, \
              object_type, object_id, idempotency_key, correlation_id, trace_id, \
              input_payload, context_payload, initiated_by) \
         VALUES ($1, $2, $3, 1, 'STARTING', 'OBJECT_EVENT', 'work_order', $4, \
                 $5, $6, $7, $8, '{}'::jsonb, $9)",
    )
    .bind(run_id)
    .bind(*org.as_uuid())
    .bind(definition_id)
    .bind(object_id)
    .bind(&idempotency_key)
    .bind(format!("trigger:{WORK_ORDER_COMPLETED_EVENT}:{object_id}"))
    .bind(SERIALIZED_CLAIM_TRACE)
    .bind(serde_json::json!({
        "event_key": WORK_ORDER_COMPLETED_EVENT,
        "object_type": "work_order",
        "object_id": object_id,
    }))
    .bind(actor)
    .execute(&mut *seed_tx)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO workflow_definition_versions \
             (org_id, definition_id, version, status, definition, \
              required_approval_line, required_payment_line) \
         VALUES ($1, $2, 2, 'PUBLISHED', $3, FALSE, FALSE)",
    )
    .bind(*org.as_uuid())
    .bind(definition_id)
    .bind(serde_json::json!({
        "schema_version": "wf.exec.v1",
        "nodes": "graph-invalid-version-two",
        "edges": []
    }))
    .execute(&mut *seed_tx)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE workflow_definitions \
         SET latest_version = 2, active_version = 2, status = 'PAUSED' WHERE id = $1",
    )
    .bind(definition_id)
    .execute(&mut *seed_tx)
    .await
    .unwrap();
    seed_tx.commit().await.unwrap();

    lock_tx.commit().await.unwrap();
    assert_eq!(retry.await.unwrap().unwrap(), 0);

    let mut tx = rt_pool.begin().await.unwrap();
    arm_org(&mut tx, org).await;
    let status: String = sqlx::query_scalar("SELECT status FROM workflow_runs WHERE id = $1")
        .bind(run_id)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    let node_keys: Vec<String> = sqlx::query_scalar(
        "SELECT node_key FROM workflow_node_runs WHERE run_id = $1 ORDER BY node_key",
    )
    .bind(run_id)
    .fetch_all(&mut *tx)
    .await
    .unwrap();
    let recovery_audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events \
         WHERE btrim(trace_id) = $1 \
           AND action IN ('workflow_run.transition','workflow_node.commit')",
    )
    .bind(SERIALIZED_CLAIM_TRACE)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();

    assert_eq!(status, "SUCCEEDED");
    assert_eq!(node_keys, vec!["record_event".to_owned()]);
    assert_eq!(recovery_audits, 2);
}

#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn unavailable_schedule_stays_due_but_invalid_active_fails_and_advances(owner_pool: PgPool) {
    let org = OrgId::from_uuid(NO_ACTIVE_SCHEDULE_TENANT);
    let author = seed_org_and_author(&owner_pool, org, "org-no-active-schedule").await;
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let definition_id = seed_graph_definition(&rt_pool, org, "automation.no_active").await;
    let invalid_definition_id =
        seed_graph_definition(&rt_pool, org, "automation.invalid_active").await;
    let now = OffsetDateTime::now_utc();
    let due_fire = OffsetDateTime::from_unix_timestamp(now.unix_timestamp() - 60).unwrap();
    let schedule_id = seed_schedule(&rt_pool, org, definition_id, author, due_fire).await;
    let invalid_schedule_id =
        seed_schedule(&rt_pool, org, invalid_definition_id, author, due_fire).await;
    let mut tx = rt_pool.begin().await.unwrap();
    arm_org(&mut tx, org).await;
    sqlx::query("UPDATE workflow_definitions SET status = 'PAUSED' WHERE id = $1")
        .bind(definition_id)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO workflow_definition_versions \
             (org_id, definition_id, version, status, definition, \
              required_approval_line, required_payment_line) \
         VALUES ($1, $2, 2, 'PUBLISHED', $3, FALSE, FALSE)",
    )
    .bind(*org.as_uuid())
    .bind(invalid_definition_id)
    .bind(serde_json::json!({
        "schema_version": "wf.exec.v1",
        "nodes": "invalid-active-graph",
        "edges": []
    }))
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE workflow_definitions \
         SET latest_version = 2, active_version = 2 WHERE id = $1",
    )
    .bind(invalid_definition_id)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();

    let store = PgWorkflowRuntimeStore::new(rt_pool.clone());
    assert_eq!(poll_org(&store, org, now).await.unwrap(), 0);

    let mut tx = rt_pool.begin().await.unwrap();
    arm_org(&mut tx, org).await;
    let unavailable_schedule = sqlx::query(
        "SELECT next_run_at, last_run_at, last_status FROM workflow_schedules WHERE id = $1",
    )
    .bind(schedule_id)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    let invalid_schedule = sqlx::query(
        "SELECT next_run_at, last_run_at, last_status FROM workflow_schedules WHERE id = $1",
    )
    .bind(invalid_schedule_id)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    let run_count: i64 = sqlx::query_scalar("SELECT count(*) FROM workflow_runs")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    let start_audits: i64 =
        sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE action = 'workflow_run.start'")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    tx.commit().await.unwrap();

    assert_eq!(
        unavailable_schedule.get::<Option<OffsetDateTime>, _>("next_run_at"),
        Some(due_fire)
    );
    assert_eq!(
        unavailable_schedule.get::<Option<OffsetDateTime>, _>("last_run_at"),
        None
    );
    assert_eq!(
        unavailable_schedule.get::<Option<String>, _>("last_status"),
        None
    );
    assert!(
        invalid_schedule
            .get::<Option<OffsetDateTime>, _>("next_run_at")
            .unwrap()
            > now
    );
    assert_eq!(
        invalid_schedule.get::<Option<OffsetDateTime>, _>("last_run_at"),
        Some(due_fire)
    );
    assert_eq!(
        invalid_schedule
            .get::<Option<String>, _>("last_status")
            .as_deref(),
        Some("FAILED")
    );
    assert_eq!(run_count, 0);
    assert_eq!(start_audits, 0);
}

#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn conflicted_event_with_true_input_identity_drift_fails_closed(owner_pool: PgPool) {
    let org = OrgId::from_uuid(IDENTITY_DRIFT_TENANT);
    let actor = seed_org_and_author(&owner_pool, org, "org-identity-drift").await;
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let definition_id = seed_graph_definition(&rt_pool, org, "automation.identity_drift").await;
    let binding_id = seed_binding(&rt_pool, org, definition_id, actor, true).await;
    let object_id = Uuid::new_v4();
    let run_id = Uuid::new_v4();

    let mut tx = rt_pool.begin().await.unwrap();
    arm_org(&mut tx, org).await;
    sqlx::query(
        "INSERT INTO workflow_runs \
             (id, org_id, definition_id, definition_version, status, trigger_type, \
              object_type, object_id, idempotency_key, correlation_id, trace_id, \
              input_payload, context_payload, initiated_by) \
         VALUES ($1, $2, $3, 1, 'STARTING', 'OBJECT_EVENT', 'work_order', $4, \
                 $5, $6, $7, $8, '{}'::jsonb, $9)",
    )
    .bind(run_id)
    .bind(*org.as_uuid())
    .bind(definition_id)
    .bind(object_id)
    .bind(format!("trigger:{binding_id}:{object_id}"))
    .bind(format!("trigger:{WORK_ORDER_COMPLETED_EVENT}:{object_id}"))
    .bind(PERSISTED_IDENTITY_TRACE)
    .bind(serde_json::json!({
        "event_key": "work_order.created",
        "object_type": "work_order",
        "object_id": object_id,
    }))
    .bind(actor)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();

    let store = PgWorkflowRuntimeStore::new(rt_pool.clone());
    assert_eq!(
        dispatch_event_bindings(
            &store,
            org,
            Some(UserId::from_uuid(actor)),
            WORK_ORDER_COMPLETED_EVENT,
            "work_order",
            object_id,
        )
        .await
        .unwrap(),
        0
    );

    let mut tx = rt_pool.begin().await.unwrap();
    arm_org(&mut tx, org).await;
    let status: String = sqlx::query_scalar("SELECT status FROM workflow_runs WHERE id = $1")
        .bind(run_id)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    let node_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM workflow_node_runs WHERE run_id = $1")
            .bind(run_id)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    let recovery_audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events \
         WHERE target_id = $1 \
           AND action IN ('workflow_run.transition','workflow_node.commit')",
    )
    .bind(run_id.to_string())
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();

    assert_eq!(status, "STARTING");
    assert_eq!(node_count, 0);
    assert_eq!(recovery_audits, 0);
}

#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn active_corruption_fails_and_advances_while_rolled_back_version_remains_executable(
    owner_pool: PgPool,
) {
    let org = OrgId::from_uuid(Uuid::from_u128(0x4d32_11cd_0000_0000_0000_0000_0000_00cd));
    let author = seed_org_and_author(&owner_pool, org, "org-active-corruption").await;
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let paused = seed_graph_definition(&rt_pool, org, "active_corruption.paused").await;
    let missing_pointer =
        seed_graph_definition(&rt_pool, org, "active_corruption.missing_pointer").await;
    let missing_version =
        seed_graph_definition(&rt_pool, org, "active_corruption.missing_version").await;
    let wrong_schema = seed_graph_definition(&rt_pool, org, "active_corruption.wrong_schema").await;
    let missing_schema =
        seed_graph_definition(&rt_pool, org, "active_corruption.missing_schema").await;
    let rolled_back = seed_graph_definition(&rt_pool, org, "active_corruption.rolled_back").await;
    let now = OffsetDateTime::now_utc();
    let due = OffsetDateTime::from_unix_timestamp(now.unix_timestamp() - 60).unwrap();
    let paused_schedule = seed_schedule(&rt_pool, org, paused, author, due).await;
    let missing_pointer_schedule = seed_schedule(&rt_pool, org, missing_pointer, author, due).await;
    let missing_version_schedule = seed_schedule(&rt_pool, org, missing_version, author, due).await;
    let wrong_schema_schedule = seed_schedule(&rt_pool, org, wrong_schema, author, due).await;
    let missing_schema_schedule = seed_schedule(&rt_pool, org, missing_schema, author, due).await;
    let rolled_back_schedule = seed_schedule(&rt_pool, org, rolled_back, author, due).await;

    let mut tx = rt_pool.begin().await.unwrap();
    arm_org(&mut tx, org).await;
    sqlx::query("UPDATE workflow_definitions SET status = 'PAUSED' WHERE id = $1")
        .bind(paused)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE workflow_definitions SET status = 'ACTIVE', active_version = NULL WHERE id = $1",
    )
    .bind(missing_pointer)
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE workflow_definitions \
         SET status = 'ACTIVE', latest_version = 2, active_version = 2 WHERE id = $1",
    )
    .bind(missing_version)
    .execute(&mut *tx)
    .await
    .unwrap();
    for (definition_id, graph, status) in [
        (
            wrong_schema,
            serde_json::json!({
                "schema_version": "wf.exec.v2",
                "nodes": [{"node_key": "wrong_schema", "node_type": "object_gate"}],
                "edges": []
            }),
            "PUBLISHED",
        ),
        (
            missing_schema,
            serde_json::json!({
                "nodes": [{"node_key": "missing_schema", "node_type": "object_gate"}],
                "edges": []
            }),
            "PUBLISHED",
        ),
        (
            rolled_back,
            serde_json::json!({
                "schema_version": "wf.exec.v1",
                "nodes": [{"node_key": "rolled_back_gate", "node_type": "object_gate"}],
                "edges": []
            }),
            "ROLLED_BACK",
        ),
    ] {
        sqlx::query(
            "INSERT INTO workflow_definition_versions \
                 (org_id, definition_id, version, status, definition, \
                  required_approval_line, required_payment_line) \
             VALUES ($1, $2, 2, $3, $4, FALSE, FALSE)",
        )
        .bind(*org.as_uuid())
        .bind(definition_id)
        .bind(status)
        .bind(graph)
        .execute(&mut *tx)
        .await
        .unwrap();
        sqlx::query(
            "UPDATE workflow_definitions \
             SET status = 'ACTIVE', latest_version = 2, active_version = 2 WHERE id = $1",
        )
        .bind(definition_id)
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();

    let store = PgWorkflowRuntimeStore::new(rt_pool.clone());
    assert_eq!(
        poll_org(&store, org, now).await.unwrap(),
        1,
        "only the rollback-produced active graph is executable"
    );

    let mut tx = rt_pool.begin().await.unwrap();
    arm_org(&mut tx, org).await;
    // Inline queries avoid sharing one mutable transaction across async closures.
    let paused_state: (
        Option<OffsetDateTime>,
        Option<OffsetDateTime>,
        Option<String>,
    ) = sqlx::query_as(
        "SELECT next_run_at, last_run_at, last_status FROM workflow_schedules WHERE id = $1",
    )
    .bind(paused_schedule)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    let missing_version_state: (
        Option<OffsetDateTime>,
        Option<OffsetDateTime>,
        Option<String>,
    ) = sqlx::query_as(
        "SELECT next_run_at, last_run_at, last_status FROM workflow_schedules WHERE id = $1",
    )
    .bind(missing_version_schedule)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    let missing_pointer_state: (
        Option<OffsetDateTime>,
        Option<OffsetDateTime>,
        Option<String>,
    ) = sqlx::query_as(
        "SELECT next_run_at, last_run_at, last_status FROM workflow_schedules WHERE id = $1",
    )
    .bind(missing_pointer_schedule)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    let wrong_schema_state: (
        Option<OffsetDateTime>,
        Option<OffsetDateTime>,
        Option<String>,
    ) = sqlx::query_as(
        "SELECT next_run_at, last_run_at, last_status FROM workflow_schedules WHERE id = $1",
    )
    .bind(wrong_schema_schedule)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    let missing_schema_state: (
        Option<OffsetDateTime>,
        Option<OffsetDateTime>,
        Option<String>,
    ) = sqlx::query_as(
        "SELECT next_run_at, last_run_at, last_status FROM workflow_schedules WHERE id = $1",
    )
    .bind(missing_schema_schedule)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    let rollback_node: String = sqlx::query_scalar(
        "SELECT n.node_key FROM workflow_node_runs n \
         JOIN workflow_runs r ON r.id = n.run_id \
         WHERE r.schedule_id = $1",
    )
    .bind(rolled_back_schedule)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();

    assert_eq!(paused_state, (Some(due), None, None));
    for (label, state) in [
        ("ACTIVE missing pointer", missing_pointer_state),
        ("ACTIVE missing pointed version", missing_version_state),
        ("ACTIVE wrong schema", wrong_schema_state),
        ("ACTIVE missing schema", missing_schema_state),
    ] {
        assert_eq!(
            state.2.as_deref(),
            Some("FAILED"),
            "{label} is corrupt ACTIVE state and must advance FAILED, not hot-loop as Unavailable"
        );
        assert_eq!(
            state.1,
            Some(due),
            "{label} must record the consumed failed fire"
        );
        assert!(state.0.is_some_and(|next| next > now));
    }
    assert_eq!(rollback_node, "rolled_back_gate");
}
