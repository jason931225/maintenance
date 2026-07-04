#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! M2 REAL-ENGINE completion-tail E2E — drives the ACTUAL runtime (not raw SQL).
//!
//! ## What this proves (the AC + review findings)
//! The sibling `m2_flag_on_runtime_drain.rs` (in `platform/db`) models the spine
//! writes with hand-written SQL. This test instead drives the REAL engine end to
//! end — `mnt_workorder_rest::m2_strangler::drive_completion_tail` on a genuine
//! `PgWorkflowRuntimeStore` (which routes every write through the domain
//! `WorkflowRuntimePort` + `mnt_workflow_runtime::{start_run, process_node}`) — so
//! the production code paths, not a test re-implementation, are exercised:
//!   1. one completion tail (`start_run` → `apply_completion` object_mutation →
//!      `emit_payroll` job) creates EXACTLY one `workflow_runs` row that lands
//!      SUCCEEDED (matching production `emit_payroll`, run_target=SUCCEEDED — NOT
//!      WAITING), two `workflow_node_runs`, and one JOB `workflow_outbox_events` row;
//!   2. the adapter drainer stages EXACTLY one `payroll_draft_runs` row in
//!      `BLOCKED_LEGAL_GATE` with `calculation_enabled = FALSE`;
//!   3. RE-DRIVING the same completion (the crash reconciler's re-drive; codex HIGH
//!      2) RESUMES rather than 409-aborts and adds ZERO rows — one run, one draft,
//!      success; and a re-drain adds ZERO drafts.
//!
//! ## Runtime fidelity (mandatory)
//! Every runtime write + read runs as the genuine non-owner `mnt_rt` role
//! (NOSUPERUSER, NOBYPASSRLS, FORCE RLS) with `app.current_org` armed — never a
//! BYPASSRLS superuser, which would mask a broken RLS path. Only minting the
//! `organizations` row (owner-only; `mnt_rt` is SELECT-only there) uses the owner
//! pool; the definition seed, the tail drive, the drain, and every assertion read
//! execute as `mnt_rt` under the armed tenant GUC, exactly as production does.
//!
//! No `work_orders` row is needed: the runtime tail records a run keyed on the work
//! order id but does not itself write `work_orders` (`workflow_runs.object_id` has
//! no FK to it), so a synthetic id exercises the tail without the full WO chain.

use mnt_kernel_core::{OrgId, WorkOrderId};
use mnt_workflow_runtime_adapter_postgres::PgWorkflowRuntimeStore;
use mnt_workorder_rest::m2_strangler::drive_completion_tail;
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};
use uuid::Uuid;

/// A dedicated TEST tenant (never production). The sqlx::test DB is fresh + empty.
const TEST_TENANT: Uuid = Uuid::from_u128(0x4d32_11c3_0000_0000_0000_0000_0000_00c3);

/// Max JOB payroll events the adapter drainer claims per call.
const DRAIN_LIMIT: i64 = 100;

// ===========================================================================
// Runtime-role pool: every connection assumes the genuine non-owner `mnt_rt`, so
// RLS is ACTUALLY enforced (BYPASSRLS does not apply, FORCE RLS does). Copied from
// the sibling flag-off parity gate.
// ===========================================================================
async fn runtime_role_pool(owner_pool: &PgPool) -> PgPool {
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

/// Arm `app.current_org` transaction-locally (the pool is already `mnt_rt` via
/// `after_connect`), exactly as the org middleware / `with_org_conn` do.
async fn arm_org(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, org: OrgId) {
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.as_uuid().to_string())
        .execute(&mut **tx)
        .await
        .unwrap();
}

/// Mint the `organizations` row via the OWNER pool (`mnt_rt` is SELECT-only there).
async fn seed_org(owner_pool: &PgPool, org: OrgId) {
    sqlx::query(
        "INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3) \
         ON CONFLICT (id) DO NOTHING",
    )
    .bind(*org.as_uuid())
    .bind("org-m2-real-engine")
    .bind("Org M2 Real Engine")
    .execute(owner_pool)
    .await
    .unwrap();
}

/// Seed the canonical work-order completion definition (`work_order.completion`,
/// object_type `work_order`, ACTIVE, one PUBLISHED `wf.exec.v1` version) as `mnt_rt`
/// under the armed tenant GUC, returning `(definition_id, version)` for the run to
/// bind to. Matches what `resolve_completion_definition` pins to.
async fn seed_definition(rt_pool: &PgPool, org: OrgId) -> (Uuid, i32) {
    let mut tx = rt_pool.begin().await.unwrap();
    arm_org(&mut tx, org).await;
    let definition_id: Uuid = sqlx::query_scalar(
        "INSERT INTO workflow_definitions \
             (org_id, workflow_key, display_name, object_type, status, \
              latest_version, active_version) \
         VALUES ($1, 'work_order.completion', 'Work Order Completion', 'work_order', \
                 'ACTIVE', 1, 1) \
         RETURNING id",
    )
    .bind(*org.as_uuid())
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO workflow_definition_versions \
             (org_id, definition_id, version, status, definition, \
              required_approval_line, required_payment_line) \
         VALUES ($1, $2, 1, 'PUBLISHED', $3, TRUE, TRUE)",
    )
    .bind(*org.as_uuid())
    .bind(definition_id)
    .bind(serde_json::json!({
        "schema_version": "wf.exec.v1",
        "template": "work_order_completion",
    }))
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    (definition_id, 1)
}

/// Tenant-scoped `SELECT count(*)` as `mnt_rt` under the armed GUC.
async fn count(rt_pool: &PgPool, org: OrgId, count_query: &'static str) -> i64 {
    let mut tx = rt_pool.begin().await.unwrap();
    arm_org(&mut tx, org).await;
    let n: i64 = sqlx::query_scalar(count_query)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    n
}

/// The single run's status, read as `mnt_rt` (exactly one run exists for the tenant).
async fn single_run_status(rt_pool: &PgPool, org: OrgId) -> String {
    let mut tx = rt_pool.begin().await.unwrap();
    arm_org(&mut tx, org).await;
    let status: String = sqlx::query_scalar("SELECT status FROM workflow_runs")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    status
}

/// The single staged draft's `(status, calculation_enabled)`, read as `mnt_rt`.
async fn single_draft(rt_pool: &PgPool, org: OrgId) -> (String, bool) {
    let mut tx = rt_pool.begin().await.unwrap();
    arm_org(&mut tx, org).await;
    let row = sqlx::query("SELECT status, calculation_enabled FROM payroll_draft_runs")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    let out = (
        row.get::<String, _>("status"),
        row.get::<bool, _>("calculation_enabled"),
    );
    tx.commit().await.unwrap();
    out
}

#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn real_engine_completion_tail_drives_one_succeeded_run_and_one_blocked_draft(
    owner_pool: PgPool,
) {
    let org = OrgId::from_uuid(TEST_TENANT);
    seed_org(&owner_pool, org).await;
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let (definition_id, version) = seed_definition(&rt_pool, org).await;
    let store = PgWorkflowRuntimeStore::new(rt_pool.clone());
    let work_order_id = WorkOrderId::new();

    // --- Drive the tail through the REAL engine (system drive: no actor/shadow). --
    drive_completion_tail(
        &store,
        org,
        work_order_id,
        None,
        definition_id,
        version,
        Vec::new(),
    )
    .await
    .expect("completion tail must drive to success through the real engine");

    // Exactly one run (SUCCEEDED), two node runs, one JOB outbox event.
    assert_eq!(
        count(&rt_pool, org, "SELECT count(*) FROM workflow_runs").await,
        1,
        "the tail must create exactly ONE workflow_runs row"
    );
    assert_eq!(
        single_run_status(&rt_pool, org).await,
        "SUCCEEDED",
        "the run must land SUCCEEDED (production emit_payroll sets run_target=SUCCEEDED, not WAITING)"
    );
    assert_eq!(
        count(&rt_pool, org, "SELECT count(*) FROM workflow_node_runs").await,
        2,
        "the tail must record exactly TWO node runs (apply_completion + emit_payroll)"
    );
    assert_eq!(
        count(
            &rt_pool,
            org,
            "SELECT count(*) FROM workflow_outbox_events WHERE channel = 'JOB'"
        )
        .await,
        1,
        "emit_payroll must enqueue exactly ONE JOB outbox event"
    );
    assert_eq!(
        count(&rt_pool, org, "SELECT count(*) FROM payroll_draft_runs").await,
        0,
        "no payroll draft exists before the outbox is drained"
    );

    // --- Drain: exactly ONE BLOCKED_LEGAL_GATE draft, calculation disabled. -------
    let created = store
        .drain_payroll_job_outbox(org, DRAIN_LIMIT)
        .await
        .unwrap();
    assert_eq!(
        created, 1,
        "the first drain must stage exactly ONE payroll draft"
    );
    let (status, calculation_enabled) = single_draft(&rt_pool, org).await;
    assert_eq!(
        status, "BLOCKED_LEGAL_GATE",
        "the drained draft must land status BLOCKED_LEGAL_GATE"
    );
    assert!(
        !calculation_enabled,
        "a BLOCKED_LEGAL_GATE draft must keep calculation disabled (fails closed)"
    );

    // --- RE-DRIVE (crash reconciler; codex HIGH 2): resume, add ZERO rows. --------
    // Driving the SAME completion again must LOAD the terminal run and no-op rather
    // than 409-abort on the deterministic run_completion_key.
    drive_completion_tail(
        &store,
        org,
        work_order_id,
        None,
        definition_id,
        version,
        Vec::new(),
    )
    .await
    .expect("re-driving a completed tail must resume to success, not conflict");
    assert_eq!(
        count(&rt_pool, org, "SELECT count(*) FROM workflow_runs").await,
        1,
        "re-driving the same completion must NOT create a second run"
    );
    assert_eq!(
        single_run_status(&rt_pool, org).await,
        "SUCCEEDED",
        "the run stays SUCCEEDED after the idempotent re-drive"
    );
    assert_eq!(
        count(&rt_pool, org, "SELECT count(*) FROM workflow_node_runs").await,
        2,
        "the re-drive must add ZERO node runs"
    );
    assert_eq!(
        count(
            &rt_pool,
            org,
            "SELECT count(*) FROM workflow_outbox_events WHERE channel = 'JOB'"
        )
        .await,
        1,
        "the re-drive must NOT duplicate the JOB outbox event"
    );

    // --- RE-DRAIN: the event is DELIVERED, so ZERO additional drafts. -------------
    assert_eq!(
        store
            .drain_payroll_job_outbox(org, DRAIN_LIMIT)
            .await
            .unwrap(),
        0,
        "re-draining must create ZERO additional payroll drafts (event already DELIVERED)"
    );
    assert_eq!(
        count(&rt_pool, org, "SELECT count(*) FROM payroll_draft_runs").await,
        1,
        "exactly ONE payroll_draft_runs row survives the re-drive + re-drain"
    );
}
