#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! BE-AUTO slice 2 E2E — condition/branch node runtime against the REAL engine
//! on a genuine `PgWorkflowRuntimeStore`, driven as the non-owner `mnt_rt` role
//! (NOSUPERUSER, NOBYPASSRLS, FORCE RLS) with `app.current_org` armed.
//!
//! Proves the branch walk: a `condition` node's predicate over the run context
//! selects the outgoing `when` edge; each outcome drives a DIFFERENT path; and
//! the untaken (dead) branch NEVER executes — no node run row is written for it.
//! Cross-org isolation of the produced runs is asserted as `mnt_rt`.

use mnt_kernel_core::{AuditAction, AuditEvent, ErrorKind, OrgId, TraceContext};
use mnt_workflow_domain::{
    NewNodeRun, NewWaitingTask, NodeStatus, NodeStepCommit, OutboxChannel, OutboxEmission,
    RunStatus, RunTransition, TriggerType, WorkflowRuntimePort,
};
use mnt_workflow_runtime::{
    AuditContext, StartRunRequest, TriggeredStart, start_bound_run, start_run,
};
use mnt_workflow_runtime_adapter_postgres::PgWorkflowRuntimeStore;
use serde_json::{Value, json};
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};
use time::OffsetDateTime;
use uuid::Uuid;

const BRANCH_TENANT: Uuid = Uuid::from_u128(0x4d32_11d1_0000_0000_0000_0000_0000_00d1);
const OTHER_TENANT: Uuid = Uuid::from_u128(0x4d32_11d2_0000_0000_0000_0000_0000_00d2);

async fn runtime_role_pool(owner_pool: &PgPool) -> PgPool {
    let options = owner_pool.connect_options().as_ref().clone();
    PgPoolOptions::new()
        .max_connections(6)
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

async fn seed_org(owner_pool: &PgPool, org: OrgId, slug: &str) {
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
}

/// gate → decide(amount > 1000) → [true] escalate.exec (human) / [false] auto.approve (terminal)
fn branching_definition() -> Value {
    json!({
        "schema_version": "wf.exec.v1",
        "nodes": [
            {"node_key": "gate", "node_type": "object_gate"},
            {"node_key": "decide", "node_type": "condition",
             "predicate": {"field": "amount", "op": "gt", "value": 1000}},
            {"node_key": "escalate.exec", "node_type": "human_task",
             "assignee_role_key": "executive", "required_policy": "approval_decide"},
            {"node_key": "auto.approve", "node_type": "object_mutation"}
        ],
        "edges": [
            {"from": "gate", "to": "decide"},
            {"from": "decide", "to": "escalate.exec", "when": "true"},
            {"from": "decide", "to": "auto.approve", "when": "false"}
        ]
    })
}

async fn seed_branching_definition(rt_pool: &PgPool, org: OrgId) -> Uuid {
    let mut tx = rt_pool.begin().await.unwrap();
    arm_org(&mut tx, org).await;
    let definition_id: Uuid = sqlx::query_scalar(
        "INSERT INTO workflow_definitions \
             (org_id, workflow_key, display_name, object_type, status, latest_version, active_version) \
         VALUES ($1, 'automation.branching', 'Branching', 'work_order', 'ACTIVE', 1, 1) \
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
         VALUES ($1, $2, 1, 'PUBLISHED', $3, FALSE, FALSE)",
    )
    .bind(*org.as_uuid())
    .bind(definition_id)
    .bind(branching_definition())
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    definition_id
}

fn audit() -> AuditContext {
    // System-initiated fire (no per-request principal), like the trigger/schedule
    // producers — avoids an actor FK to a seeded user.
    AuditContext {
        actor: None,
        trace: TraceContext::generate(),
        occurred_at: OffsetDateTime::now_utc(),
    }
}

fn request(org: OrgId, definition_id: Uuid, key: &str, context: Value) -> StartRunRequest {
    StartRunRequest {
        run_id: Uuid::new_v4(),
        org_id: org,
        definition_id,
        definition_version: 1,
        trigger_type: TriggerType::Manual,
        object_type: Some("work_order".to_owned()),
        object_id: Some(Uuid::new_v4()),
        idempotency_key: key.to_owned(),
        correlation_id: format!("branch-test:{key}"),
        trace_id: None,
        input_payload: json!({}),
        context_payload: context,
        initiated_by: None,
        schedule_id: None,
    }
}

fn node_commit(
    org: OrgId,
    run_id: Uuid,
    node_key: &str,
    node_final_status: NodeStatus,
    run_target: Option<RunStatus>,
    emits_outbox: bool,
) -> NodeStepCommit {
    let node_run_id = Uuid::new_v4();
    let waiting_task = (node_final_status == NodeStatus::Waiting).then(|| NewWaitingTask {
        run_id,
        node_run_id: Some(node_run_id),
        waiting_key: node_key.to_owned(),
        title: "Approve".to_owned(),
        assignee_role_key: Some("approver".to_owned()),
        required_policy: None,
        form_payload: json!({}),
        due_at: None,
    });
    NodeStepCommit {
        new_node: NewNodeRun {
            id: node_run_id,
            run_id,
            node_key: node_key.to_owned(),
            node_type: if waiting_task.is_some() {
                "human_task".to_owned()
            } else {
                "object_gate".to_owned()
            },
            attempt: 1,
            idempotency_key: format!("workflow_runtime:node:{run_id}:{node_key}:1"),
            input_payload: json!({}),
        },
        node_final_status,
        node_output: (node_final_status != NodeStatus::Waiting).then(|| json!({ "ok": true })),
        node_error: None,
        emissions: emits_outbox
            .then(|| OutboxEmission {
                node_run_id: Some(node_run_id),
                channel: OutboxChannel::Job,
                destination_ref: Some("workflow-test".to_owned()),
                idempotency_key: format!("workflow_runtime:outbox:{run_id}:{node_key}:1"),
                payload: json!({ "job": "verify_exactly_once" }),
            })
            .into_iter()
            .collect(),
        waiting_task,
        run_transition: run_target.map(|to| RunTransition {
            run_id,
            from: RunStatus::Running,
            to,
            output_payload: None,
            error_payload: None,
        }),
        audit_events: vec![
            AuditEvent::new(
                None,
                AuditAction::new("workflow_node.commit").unwrap(),
                "workflow_node_run",
                node_run_id.to_string(),
                TraceContext::generate(),
                OffsetDateTime::now_utc(),
            )
            .with_org(org),
        ],
    }
}

async fn assert_commit_shape(
    rt_pool: &PgPool,
    org: OrgId,
    run_id: Uuid,
    expected_run_status: RunStatus,
    expected_nodes: i64,
    expected_waiting_tasks: i64,
    expected_outbox_events: i64,
    expected_node_audits: i64,
) {
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
    let task_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM workflow_waiting_tasks WHERE run_id = $1")
            .bind(run_id)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    let outbox_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM workflow_outbox_events WHERE run_id = $1")
            .bind(run_id)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    let node_audit_count: i64 = sqlx::query_scalar(
        "SELECT count(*) \
         FROM audit_events a \
         JOIN workflow_node_runs n ON n.id::text = a.target_id \
         WHERE n.run_id = $1 AND a.action = 'workflow_node.commit'",
    )
    .bind(run_id)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();

    assert_eq!(status, expected_run_status.as_db_str());
    assert_eq!(node_count, expected_nodes);
    assert_eq!(task_count, expected_waiting_tasks);
    assert_eq!(outbox_count, expected_outbox_events);
    assert_eq!(node_audit_count, expected_node_audits);
}

async fn commit_duplicate(
    store: &PgWorkflowRuntimeStore,
    org: OrgId,
    left: NodeStepCommit,
    right: NodeStepCommit,
) {
    assert_ne!(left.new_node.id, right.new_node.id);
    assert_eq!(
        left.new_node.idempotency_key,
        right.new_node.idempotency_key
    );
    let (left_result, right_result) = tokio::join!(
        store.commit_node_step(org, left),
        store.commit_node_step(org, right)
    );
    left_result.unwrap();
    right_result.unwrap();
}

async fn seed_persisted_node(
    rt_pool: &PgPool,
    org: OrgId,
    run_id: Uuid,
    node_key: &str,
    idempotency_key: &str,
    status: NodeStatus,
) {
    let mut tx = rt_pool.begin().await.unwrap();
    arm_org(&mut tx, org).await;
    sqlx::query(
        "INSERT INTO workflow_node_runs \
             (id, org_id, run_id, node_key, node_type, status, attempt, \
              idempotency_key, input_payload, started_at, finished_at) \
         VALUES ($1, $2, $3, $4, 'object_gate', $5, 1, $6, '{}'::jsonb, \
                 CASE WHEN $5 <> 'PENDING' THEN now() END, \
                 CASE WHEN $5 IN ('SUCCEEDED','FAILED','SKIPPED','CANCELLED') \
                      THEN now() END)",
    )
    .bind(Uuid::new_v4())
    .bind(*org.as_uuid())
    .bind(run_id)
    .bind(node_key)
    .bind(status.as_db_str())
    .bind(idempotency_key)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
}

async fn node_keys(rt_pool: &PgPool, org: OrgId, run_id: Uuid) -> Vec<String> {
    let mut tx = rt_pool.begin().await.unwrap();
    arm_org(&mut tx, org).await;
    let rows = sqlx::query(
        "SELECT node_key FROM workflow_node_runs WHERE run_id = $1 ORDER BY started_at",
    )
    .bind(run_id)
    .fetch_all(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    rows.iter()
        .map(|r| r.get::<String, _>("node_key"))
        .collect()
}

#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn condition_true_branch_parks_and_dead_branch_never_runs(owner_pool: PgPool) {
    let org = OrgId::from_uuid(BRANCH_TENANT);
    seed_org(&owner_pool, org, "org-branch").await;
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let definition_id = seed_branching_definition(&rt_pool, org).await;
    let store = PgWorkflowRuntimeStore::new(rt_pool.clone());

    // amount > 1000 ⇒ TRUE branch ⇒ parks at the executive human task.
    let req = request(
        org,
        definition_id,
        "branch-true-0000000001",
        json!({ "amount": 5000 }),
    );
    let run_id = req.run_id;
    let outcome = start_bound_run(&store, req, &branching_definition(), &audit())
        .await
        .unwrap();
    assert!(matches!(
        outcome,
        TriggeredStart::Started { run_status, .. } if run_status == mnt_workflow_domain::RunStatus::Waiting
    ));

    let keys = node_keys(&rt_pool, org, run_id).await;
    assert!(keys.contains(&"gate".to_owned()));
    assert!(keys.contains(&"decide".to_owned()));
    assert!(keys.contains(&"escalate.exec".to_owned()));
    assert!(
        !keys.contains(&"auto.approve".to_owned()),
        "the dead (false) branch must never execute; node runs = {keys:?}"
    );
}

#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn condition_false_branch_runs_to_terminal_success(owner_pool: PgPool) {
    let org = OrgId::from_uuid(BRANCH_TENANT);
    seed_org(&owner_pool, org, "org-branch").await;
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let definition_id = seed_branching_definition(&rt_pool, org).await;
    let store = PgWorkflowRuntimeStore::new(rt_pool.clone());

    // amount <= 1000 ⇒ FALSE branch ⇒ drives to the terminal object_mutation.
    let req = request(
        org,
        definition_id,
        "branch-false-000000001",
        json!({ "amount": 100 }),
    );
    let replay_identity = req.clone();
    let run_id = req.run_id;
    let outcome = start_bound_run(&store, req, &branching_definition(), &audit())
        .await
        .unwrap();
    assert!(matches!(
        outcome,
        TriggeredStart::Started { run_status, .. } if run_status == mnt_workflow_domain::RunStatus::Succeeded
    ));

    let keys = node_keys(&rt_pool, org, run_id).await;
    assert!(keys.contains(&"gate".to_owned()));
    assert!(keys.contains(&"decide".to_owned()));
    assert!(keys.contains(&"auto.approve".to_owned()));
    assert!(
        !keys.contains(&"escalate.exec".to_owned()),
        "the dead (true) branch must never execute; node runs = {keys:?}"
    );

    let mut divergent_context = replay_identity.clone();
    divergent_context.run_id = Uuid::new_v4();
    divergent_context.context_payload = json!({ "amount": 5000 });
    let err = start_bound_run(&store, divergent_context, &branching_definition(), &audit())
        .await
        .expect_err("same run key must not replay down a different branch");
    assert_eq!(err.kind, ErrorKind::Conflict);

    let mut divergent_object = replay_identity;
    divergent_object.run_id = Uuid::new_v4();
    divergent_object.object_id = Some(Uuid::new_v4());
    let err = start_bound_run(&store, divergent_object, &branching_definition(), &audit())
        .await
        .expect_err("same run key must not be reused for a different object");
    assert_eq!(err.kind, ErrorKind::Conflict);
    assert_eq!(
        node_keys(&rt_pool, org, run_id).await,
        keys,
        "identity-drift retries must not write another branch/node"
    );

    // Cross-org isolation: another tenant sees none of these runs.
    let other = OrgId::from_uuid(OTHER_TENANT);
    seed_org(&owner_pool, other, "org-branch-other").await;
    let mut tx = rt_pool.begin().await.unwrap();
    arm_org(&mut tx, other).await;
    let visible: i64 = sqlx::query_scalar("SELECT count(*) FROM workflow_runs")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(visible, 0, "runs must be RLS-isolated to their own tenant");
}

#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn duplicate_node_commits_are_side_effect_free_for_all_drive_shapes(owner_pool: PgPool) {
    let org = OrgId::from_uuid(BRANCH_TENANT);
    seed_org(&owner_pool, org, "org-node-commit-race").await;
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let definition_id = seed_branching_definition(&rt_pool, org).await;
    let store = PgWorkflowRuntimeStore::new(rt_pool.clone());

    // Terminal node with a real transactional-outbox emission.
    let terminal_start = request(org, definition_id, "terminal-commit-0001", json!({}));
    let terminal_run = terminal_start.run_id;
    start_run(&store, terminal_start, &audit()).await.unwrap();
    commit_duplicate(
        &store,
        org,
        node_commit(
            org,
            terminal_run,
            "finish",
            NodeStatus::Succeeded,
            Some(RunStatus::Succeeded),
            true,
        ),
        node_commit(
            org,
            terminal_run,
            "finish",
            NodeStatus::Succeeded,
            Some(RunStatus::Succeeded),
            true,
        ),
    )
    .await;
    assert_commit_shape(
        &rt_pool,
        org,
        terminal_run,
        RunStatus::Succeeded,
        1,
        0,
        1,
        1,
    )
    .await;

    // Human WAITING node: exactly one node, task, transition, and audit.
    let waiting_start = request(org, definition_id, "waiting-commit-00001", json!({}));
    let waiting_run = waiting_start.run_id;
    start_run(&store, waiting_start, &audit()).await.unwrap();
    commit_duplicate(
        &store,
        org,
        node_commit(
            org,
            waiting_run,
            "approve",
            NodeStatus::Waiting,
            Some(RunStatus::Waiting),
            false,
        ),
        node_commit(
            org,
            waiting_run,
            "approve",
            NodeStatus::Waiting,
            Some(RunStatus::Waiting),
            false,
        ),
    )
    .await;
    assert_commit_shape(&rt_pool, org, waiting_run, RunStatus::Waiting, 1, 1, 0, 1).await;

    // Multi-node pass-through: the first duplicate pair leaves RUNNING, then
    // drive continues to a second duplicate pair that closes the run.
    let pass_start = request(org, definition_id, "running-commit-00001", json!({}));
    let pass_run = pass_start.run_id;
    start_run(&store, pass_start, &audit()).await.unwrap();
    commit_duplicate(
        &store,
        org,
        node_commit(org, pass_run, "prepare", NodeStatus::Succeeded, None, false),
        node_commit(org, pass_run, "prepare", NodeStatus::Succeeded, None, false),
    )
    .await;
    assert_commit_shape(&rt_pool, org, pass_run, RunStatus::Running, 1, 0, 0, 1).await;
    commit_duplicate(
        &store,
        org,
        node_commit(
            org,
            pass_run,
            "finish",
            NodeStatus::Succeeded,
            Some(RunStatus::Succeeded),
            false,
        ),
        node_commit(
            org,
            pass_run,
            "finish",
            NodeStatus::Succeeded,
            Some(RunStatus::Succeeded),
            false,
        ),
    )
    .await;
    assert_commit_shape(&rt_pool, org, pass_run, RunStatus::Succeeded, 2, 0, 0, 2).await;
}

#[sqlx::test(migrations = "../crates/platform/db/migrations")]
async fn incomplete_or_drifted_persisted_node_never_manufactures_commit_success(
    owner_pool: PgPool,
) {
    let org = OrgId::from_uuid(BRANCH_TENANT);
    seed_org(&owner_pool, org, "org-node-commit-fail-closed").await;
    let rt_pool = runtime_role_pool(&owner_pool).await;
    let definition_id = seed_branching_definition(&rt_pool, org).await;
    let store = PgWorkflowRuntimeStore::new(rt_pool.clone());

    for (run_key, status) in [
        ("incomplete-pending-01", NodeStatus::Pending),
        ("incomplete-running-01", NodeStatus::Running),
    ] {
        let start = request(org, definition_id, run_key, json!({}));
        let run_id = start.run_id;
        start_run(&store, start, &audit()).await.unwrap();
        let idempotency_key = format!("workflow_runtime:node:{run_id}:incomplete:1");
        seed_persisted_node(
            &rt_pool,
            org,
            run_id,
            "incomplete",
            &idempotency_key,
            status,
        )
        .await;

        let err = store
            .commit_node_step(
                org,
                node_commit(org, run_id, "incomplete", NodeStatus::Succeeded, None, true),
            )
            .await
            .expect_err("PENDING/RUNNING is not proof of a completed node transaction");
        assert_eq!(err.kind, ErrorKind::Conflict);
        assert_commit_shape(&rt_pool, org, run_id, RunStatus::Running, 1, 0, 0, 0).await;
    }

    let drift_start = request(org, definition_id, "identity-drift-000001", json!({}));
    let drift_run = drift_start.run_id;
    start_run(&store, drift_start, &audit()).await.unwrap();
    let expected_key = format!("workflow_runtime:node:{drift_run}:expected:1");
    seed_persisted_node(
        &rt_pool,
        org,
        drift_run,
        "different",
        &expected_key,
        NodeStatus::Succeeded,
    )
    .await;
    let err = store
        .commit_node_step(
            org,
            node_commit(
                org,
                drift_run,
                "expected",
                NodeStatus::Succeeded,
                None,
                true,
            ),
        )
        .await
        .expect_err("same node idempotency key with different identity must fail closed");
    assert_eq!(err.kind, ErrorKind::Conflict);
    assert_commit_shape(&rt_pool, org, drift_run, RunStatus::Running, 1, 0, 0, 0).await;
}
