//! Postgres adapter for the workflow runtime spine.
//!
//! Implements [`WorkflowRuntimePort`] over migrations 0077/0078 using the platform
//! transactional helpers. Every method arms `app.current_org` before any statement
//! (via `with_audit` / `with_audits` from `event.org_id`/`org`, or `with_org_conn`
//! for reads) so RLS scopes it to the tenant exactly as production `mnt_rt`. This
//! is the ONLY workflow crate that touches the spine tables and `sqlx`. Runtime
//! `sqlx::query()` is used throughout (not the compile-time macros) because the
//! offline query cache cannot be regenerated in this environment.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::collections::BTreeSet;

use mnt_kernel_core::{AuditAction, AuditEvent, KernelError, OrgId, TraceContext};
use mnt_platform_db::{DbError, with_audit, with_audits, with_org_conn};
use mnt_workflow_domain::{
    FinalizeWaitingTaskCommand, FinalizeWaitingTaskContext, FinalizedWaitingTask, NewRun,
    NodeStepCommit, PortFuture, PostFinalizationRejection, PostFinalizationRejectionCommand,
    RunRecord, RunStatus, RunTerminalTimestamp, RunTransition, WaitingTaskStatus,
    WorkflowRuntimePort,
};
use sqlx::{PgPool, Row};
use uuid::Uuid;

/// The per-tenant strangler flag (migration 0095) that routes a tenant through
/// the M2 workflow runtime. Resolved via `org_runtime_flag_enabled`; an absent
/// row resolves to `false` (dark default / fail-closed).
pub const M2_STRANGLER_FLAG: &str = "workflow_runtime_m2_strangler";

/// Audit action stamped when the drainer consumes a JOB payroll outbox event.
/// Matches the `audit_events.action` regex (≥2 dot-separated `[a-z0-9_]` segments).
const DRAIN_AUDIT_ACTION: &str = "workflow_runtime.outbox_drain";
const POST_FINALIZATION_REJECTION: &str = "POST_FINALIZATION_REJECTION";
const FINALIZE_WAITING_KEY: &str = "finalize.author";
const RECEIPT_WAITING_KEY: &str = "receipt.target";

/// Adapter error. `Db` wraps the platform DB error (so `with_audit`'s
/// `E: From<DbError>` bound is satisfied); `Domain` carries a kernel error raised
/// inside a closure (e.g. an unknown status decoded from a row).
#[derive(Debug, thiserror::Error)]
enum PgWorkflowRuntimeError {
    #[error(transparent)]
    Db(#[from] DbError),

    #[error(transparent)]
    Domain(#[from] KernelError),
}

#[derive(Debug, Clone)]
struct ReceiptNodeSpec {
    title: String,
    required_policy: Option<String>,
    assignee_role_key: Option<String>,
}

/// Filter for the waiting-task inbox listings (`GET /api/v1/workflow-tasks`).
#[derive(Debug, Clone)]
pub struct WaitingTaskListFilter {
    /// Group-inbox role filter (`?role_key=`), matched against `assignee_role_key`.
    pub role_key: Option<String>,
    /// Personal-inbox mode (`?assignee=me`): the user's CLAIMED tasks plus claimable OPEN ones.
    pub assignee_me: bool,
    /// Statuses to include (defaults to `[OPEN]` at the REST layer).
    pub statuses: Vec<WaitingTaskStatus>,
}

/// One waiting-task inbox row (approval inbox / group inbox).
#[derive(Debug, Clone)]
pub struct WaitingTaskListItem {
    pub task_id: Uuid,
    pub run_id: Uuid,
    pub waiting_key: String,
    pub title: String,
    pub assignee_role_key: Option<String>,
    pub required_policy: Option<String>,
    pub object_type: Option<String>,
    pub object_id: Option<Uuid>,
    pub status: WaitingTaskStatus,
    pub claimed_by: Option<Uuid>,
    pub due_at: Option<time::OffsetDateTime>,
    pub form_payload: serde_json::Value,
}

/// Filter for the submission box (`GET /api/v1/workflow-runs/mine`).
#[derive(Debug, Clone)]
pub struct RunListFilter {
    pub statuses: Vec<RunStatus>,
    pub object_type: Option<String>,
}

/// One submission-box row (a run the principal initiated).
#[derive(Debug, Clone)]
pub struct RunListItem {
    pub run_id: Uuid,
    pub status: RunStatus,
    pub definition_id: Uuid,
    pub definition_version: i32,
    pub object_type: Option<String>,
    pub object_id: Option<Uuid>,
    pub initiated_by: Option<Uuid>,
    pub started_at: time::OffsetDateTime,
    pub updated_at: time::OffsetDateTime,
}

/// Audited command to claim an OPEN waiting task (`POST .../claim`).
#[derive(Debug, Clone)]
pub struct ClaimWaitingTaskCommand {
    pub task_id: Uuid,
    pub actor: mnt_kernel_core::UserId,
    pub transition_audits: Vec<AuditEvent>,
}

/// Result of a claim: the task now CLAIMED by the actor (or a same-user replay).
#[derive(Debug, Clone)]
pub struct ClaimedWaitingTask {
    pub task_id: Uuid,
    pub run_id: Uuid,
    pub status: WaitingTaskStatus,
    pub claimed_by: Option<Uuid>,
    pub claimed_at: Option<time::OffsetDateTime>,
}

/// The decision a `decide` request carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskDecision {
    Approve,
    Reject,
    Return,
}

impl TaskDecision {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Approve => "approve",
            Self::Reject => "reject",
            Self::Return => "return",
        }
    }
}

/// Audited command to decide a non-finalize waiting task (`POST .../decide`).
#[derive(Debug, Clone)]
pub struct DecideWaitingTaskCommand {
    pub task_id: Uuid,
    pub actor: mnt_kernel_core::UserId,
    pub decision: TaskDecision,
    pub comment: Option<String>,
    pub idempotency_key: String,
    pub transition_audits: Vec<AuditEvent>,
}

/// Result of a decision: the task's terminal decision status, the run's resulting
/// status, and the next parked task (when an approval advanced the line).
#[derive(Debug, Clone)]
pub struct DecidedWaitingTask {
    pub task_id: Uuid,
    pub run_id: Uuid,
    pub status: WaitingTaskStatus,
    pub decision_payload: serde_json::Value,
    pub run_status: RunStatus,
    pub next_task: Option<WaitingTaskListItem>,
}

/// The node following `from_key` along its single outgoing edge, parsed from the
/// `wf.exec.v1` definition JSON. Generalizes [`receipt_node_after_finalize`] for
/// the decision-advance path.
#[derive(Debug, Clone)]
struct NextNode {
    node_key: String,
    node_type: String,
    title: String,
    required_policy: Option<String>,
    assignee_role_key: Option<String>,
}

fn next_node_after(definition: &serde_json::Value, from_key: &str) -> Option<NextNode> {
    let to = definition
        .get("edges")
        .and_then(serde_json::Value::as_array)?
        .iter()
        .find(|edge| edge.get("from").and_then(serde_json::Value::as_str) == Some(from_key))
        .and_then(|edge| edge.get("to").and_then(serde_json::Value::as_str))?;

    let node = definition
        .get("nodes")
        .and_then(serde_json::Value::as_array)?
        .iter()
        .find(|node| node.get("node_key").and_then(serde_json::Value::as_str) == Some(to))?;

    Some(NextNode {
        node_key: to.to_owned(),
        node_type: node
            .get("node_type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("human_task")
            .to_owned(),
        title: node
            .get("title")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(to)
            .to_owned(),
        required_policy: node
            .get("required_policy")
            .and_then(serde_json::Value::as_str)
            .map(ToOwned::to_owned),
        assignee_role_key: node
            .get("assignee_role_key")
            .and_then(serde_json::Value::as_str)
            .map(ToOwned::to_owned),
    })
}

/// Park a human-task node as an OPEN waiting task inside an existing txn: insert the
/// WAITING node run + the OPEN waiting task (both `ON CONFLICT DO NOTHING` so a
/// replay is a no-op), returning `(node_run_id, task_id)`. Mirrors the receipt
/// insert in `finalize_waiting_task`.
async fn park_waiting_node(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: OrgId,
    run_id: Uuid,
    node: &NextNode,
) -> Result<(Uuid, Uuid), PgWorkflowRuntimeError> {
    sqlx::query(
        "INSERT INTO workflow_node_runs \
             (id, org_id, run_id, node_key, node_type, status, attempt, \
              idempotency_key, input_payload, started_at) \
         VALUES ($1, $2, $3, $4, 'human_task', 'WAITING', 1, $5, '{}'::jsonb, now()) \
         ON CONFLICT (org_id, run_id, node_key, attempt) DO NOTHING",
    )
    .bind(Uuid::new_v4())
    .bind(*org.as_uuid())
    .bind(run_id)
    .bind(node.node_key.as_str())
    .bind(format!(
        "workflow_runtime:node:{run_id}:{}:1",
        node.node_key
    ))
    .execute(tx.as_mut())
    .await
    .map_err(PgWorkflowRuntimeError::from)?;

    let node_run_id: Uuid = sqlx::query_scalar(
        "SELECT id FROM workflow_node_runs \
         WHERE run_id = $1 AND node_key = $2 AND attempt = 1",
    )
    .bind(run_id)
    .bind(node.node_key.as_str())
    .fetch_one(tx.as_mut())
    .await
    .map_err(PgWorkflowRuntimeError::from)?;

    let task_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO workflow_waiting_tasks \
             (id, org_id, run_id, node_run_id, waiting_key, title, status, \
              assignee_role_key, required_policy, form_payload) \
         VALUES ($1, $2, $3, $4, $5, $6, 'OPEN', $7, $8, '{}'::jsonb) \
         ON CONFLICT (org_id, run_id, waiting_key) DO NOTHING",
    )
    .bind(task_id)
    .bind(*org.as_uuid())
    .bind(run_id)
    .bind(node_run_id)
    .bind(node.node_key.as_str())
    .bind(node.title.as_str())
    .bind(node.assignee_role_key.as_deref())
    .bind(node.required_policy.as_deref())
    .execute(tx.as_mut())
    .await
    .map_err(PgWorkflowRuntimeError::from)?;

    let persisted_task_id: Uuid = sqlx::query_scalar(
        "SELECT id FROM workflow_waiting_tasks \
         WHERE run_id = $1 AND waiting_key = $2",
    )
    .bind(run_id)
    .bind(node.node_key.as_str())
    .fetch_one(tx.as_mut())
    .await
    .map_err(PgWorkflowRuntimeError::from)?;

    Ok((node_run_id, persisted_task_id))
}

impl From<sqlx::Error> for PgWorkflowRuntimeError {
    fn from(value: sqlx::Error) -> Self {
        Self::Db(DbError::Sqlx(value))
    }
}

impl From<PgWorkflowRuntimeError> for KernelError {
    fn from(err: PgWorkflowRuntimeError) -> Self {
        match err {
            PgWorkflowRuntimeError::Domain(kernel) => kernel,
            PgWorkflowRuntimeError::Db(db) => db_error_to_kernel(db),
        }
    }
}

fn db_error_to_kernel(db: DbError) -> KernelError {
    match &db {
        DbError::Sqlx(sqlx::Error::RowNotFound) => {
            return KernelError::not_found("workflow runtime row not found");
        }
        DbError::Sqlx(sqlx::Error::Database(database))
            if database.code().is_some_and(|code| code == "23505") =>
        {
            return KernelError::conflict("workflow runtime idempotency/unique conflict");
        }
        _ => {}
    }
    KernelError::internal(format!("workflow runtime db error: {db}"))
}

fn receipt_node_after_finalize(definition: &serde_json::Value) -> Option<ReceiptNodeSpec> {
    let has_finalize_to_receipt_edge = definition
        .get("edges")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|edges| {
            edges.iter().any(|edge| {
                edge.get("from").and_then(serde_json::Value::as_str) == Some(FINALIZE_WAITING_KEY)
                    && edge.get("to").and_then(serde_json::Value::as_str)
                        == Some(RECEIPT_WAITING_KEY)
            })
        });
    if !has_finalize_to_receipt_edge {
        return None;
    }

    let receipt_node = definition
        .get("nodes")
        .and_then(serde_json::Value::as_array)?
        .iter()
        .find(|node| {
            node.get("node_key").and_then(serde_json::Value::as_str) == Some(RECEIPT_WAITING_KEY)
        })?;

    Some(ReceiptNodeSpec {
        title: receipt_node
            .get("title")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("Receipt confirmation")
            .to_owned(),
        required_policy: receipt_node
            .get("required_policy")
            .and_then(serde_json::Value::as_str)
            .map(ToOwned::to_owned),
        assignee_role_key: receipt_node
            .get("assignee_role_key")
            .and_then(serde_json::Value::as_str)
            .map(ToOwned::to_owned),
    })
}

/// Postgres-backed workflow runtime store.
#[derive(Clone)]
pub struct PgWorkflowRuntimeStore {
    pool: PgPool,
}

impl std::fmt::Debug for PgWorkflowRuntimeStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PgWorkflowRuntimeStore")
            .field("pool", &self.pool)
            .finish()
    }
}

impl PgWorkflowRuntimeStore {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    #[must_use]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// STEP 4 — resolve the per-tenant strangler flag by calling the SQL resolver
    /// `org_runtime_flag_enabled(flag_key)` (migration 0095) under an armed
    /// `mnt_rt` connection (`with_org_conn` sets `app.current_org` so the
    /// SECURITY INVOKER resolver reads only this tenant's row). An absent flag row
    /// resolves to `false` — the dark default that keeps un-enrolled tenants on
    /// the legacy path.
    pub async fn strangler_flag_enabled(
        &self,
        org: OrgId,
        flag_key: &str,
    ) -> Result<bool, KernelError> {
        let flag_key = flag_key.to_owned();
        with_org_conn::<_, bool, PgWorkflowRuntimeError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let enabled: bool = sqlx::query_scalar("SELECT org_runtime_flag_enabled($1)")
                    .bind(flag_key)
                    .fetch_one(tx.as_mut())
                    .await
                    .map_err(PgWorkflowRuntimeError::from)?;
                Ok(enabled)
            })
        })
        .await
        .map_err(KernelError::from)
    }

    /// Load a run by its tenant-scoped natural `idempotency_key`
    /// (`UNIQUE(org_id, idempotency_key)`, 0077:34), read as `mnt_rt` under the
    /// armed `app.current_org` (via `with_org_conn`). Used by the completion-tail
    /// strangler to RESUME an existing (partial) run on the deterministic
    /// completion-key conflict instead of aborting: the caller derives the same
    /// `run_completion_key`, and this returns the run already recorded under it so
    /// the tail continues idempotently. `None` when no run exists for that key.
    pub async fn load_run_by_idempotency_key(
        &self,
        org: OrgId,
        idempotency_key: String,
    ) -> Result<Option<RunRecord>, KernelError> {
        with_org_conn::<_, Option<RunRecord>, PgWorkflowRuntimeError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let row = sqlx::query(
                    "SELECT id, org_id, status, definition_id, definition_version, \
                            object_type, object_id \
                     FROM workflow_runs WHERE idempotency_key = $1",
                )
                .bind(idempotency_key)
                .fetch_optional(tx.as_mut())
                .await
                .map_err(PgWorkflowRuntimeError::from)?;

                let Some(row) = row else {
                    return Ok(None);
                };
                let status_str: String = row.try_get("status")?;
                let id: Uuid = row.try_get("id")?;
                let org_uuid: Uuid = row.try_get("org_id")?;
                let definition_id: Uuid = row.try_get("definition_id")?;
                let definition_version: i32 = row.try_get("definition_version")?;
                let object_type: Option<String> = row.try_get("object_type")?;
                let object_id: Option<Uuid> = row.try_get("object_id")?;
                Ok(Some(RunRecord {
                    id,
                    org_id: OrgId::from_uuid(org_uuid),
                    status: RunStatus::from_db_str(&status_str)?,
                    definition_id,
                    definition_version,
                    object_type,
                    object_id,
                }))
            })
        })
        .await
        .map_err(KernelError::from)
    }

    /// STEP 5 — drain up to `limit` PENDING/FAILED JOB payroll outbox events for
    /// `org` in ONE `with_audits` transaction (design §F). For each event claimed
    /// with `FOR UPDATE SKIP LOCKED` (matching the partial index
    /// `idx_workflow_outbox_events_pending`) this idempotently stages the
    /// `payroll_draft_runs` row — keyed on the deterministic per-run natural key
    /// `workflow_runtime_m2:run:{run_id}` with `ON CONFLICT DO NOTHING`, landing
    /// `BLOCKED_LEGAL_GATE` with `calculation_enabled = FALSE` (the column
    /// default) so nothing calculates without the legal gate — marks the event
    /// `DELIVERED` (0078 requires `delivered_at`), and lands one
    /// `workflow_runtime.outbox_drain` audit row. All three writes share the one
    /// txn, so a failure rolls every one back and leaves the event PENDING for a
    /// later retry; a replay claims nothing (the event is DELIVERED) and the
    /// draft's natural key collides, so it is an exactly-once no-op. Returns the
    /// number of payroll drafts actually created.
    // mnt-gate: state-changing-handler
    pub async fn drain_payroll_job_outbox(
        &self,
        org: OrgId,
        limit: i64,
    ) -> Result<u64, KernelError> {
        with_audits::<_, u64, PgWorkflowRuntimeError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                // Claim due JOB payroll events. The lease is the row lock itself
                // (FOR UPDATE SKIP LOCKED); a competing drainer skips a held row.
                let claimed = sqlx::query(
                    "SELECT id, run_id \
                     FROM workflow_outbox_events \
                     WHERE channel = 'JOB' \
                       AND payload->>'job' = 'payroll_draft' \
                       AND status IN ('PENDING', 'FAILED') \
                       AND coalesce(next_attempt_at, created_at) <= now() \
                     ORDER BY created_at \
                     FOR UPDATE SKIP LOCKED \
                     LIMIT $1",
                )
                .bind(limit)
                .fetch_all(tx.as_mut())
                .await
                .map_err(PgWorkflowRuntimeError::from)?;

                let mut created: u64 = 0;
                let mut audit_events: Vec<AuditEvent> = Vec::with_capacity(claimed.len());

                for row in &claimed {
                    let event_id: Uuid = row.try_get("id")?;
                    let run_id: Uuid = row.try_get("run_id")?;

                    // (a) Idempotent draft create keyed on the reused payroll
                    // natural key. period_start/end + connector/job come from the
                    // event payload; a replay of the same run collides on
                    // UNIQUE(org_id, period_start, period_end, source_label).
                    let inserted: Vec<Uuid> = sqlx::query_scalar(
                        "INSERT INTO payroll_draft_runs \
                             (org_id, period_start, period_end, source_label, status, \
                              source_summary) \
                         SELECT o.org_id, \
                                (o.payload->>'period_start')::date, \
                                (o.payload->>'period_end')::date, \
                                'workflow_runtime_m2:run:' || o.run_id::text, \
                                'BLOCKED_LEGAL_GATE', \
                                jsonb_build_object( \
                                    'outbox_event_id', o.id, \
                                    'run_id', o.run_id, \
                                    'connector', o.payload->>'connector', \
                                    'job', o.payload->>'job') \
                         FROM workflow_outbox_events o \
                         WHERE o.id = $1 \
                         ON CONFLICT (org_id, period_start, period_end, source_label) \
                             DO NOTHING \
                         RETURNING id",
                    )
                    .bind(event_id)
                    .fetch_all(tx.as_mut())
                    .await
                    .map_err(PgWorkflowRuntimeError::from)?;
                    let drafts_created = inserted.len() as u64;
                    created += drafts_created;

                    // (b) Ack the event DELIVERED in the SAME txn.
                    sqlx::query(
                        "UPDATE workflow_outbox_events \
                         SET status = 'DELIVERED', delivered_at = now(), \
                             attempt_count = attempt_count + 1, updated_at = now() \
                         WHERE id = $1",
                    )
                    .bind(event_id)
                    .execute(tx.as_mut())
                    .await
                    .map_err(PgWorkflowRuntimeError::from)?;

                    // (c) One audit row per consumed event, in the SAME txn.
                    let action = AuditAction::new(DRAIN_AUDIT_ACTION)
                        .map_err(PgWorkflowRuntimeError::from)?;
                    let event = AuditEvent::new(
                        None,
                        action,
                        "workflow_outbox_event",
                        event_id.to_string(),
                        TraceContext::generate(),
                        time::OffsetDateTime::now_utc(),
                    )
                    .with_org(org)
                    .with_snapshots(
                        Some(serde_json::json!({ "status": "PENDING" })),
                        Some(serde_json::json!({
                            "status": "DELIVERED",
                            "payroll_drafts_created": drafts_created,
                            "source_label": format!("workflow_runtime_m2:run:{run_id}"),
                        })),
                    );
                    audit_events.push(event);
                }

                Ok((created, audit_events))
            })
        })
        .await
        .map_err(KernelError::from)
    }

    /// List waiting-task inbox rows for the group (`role_key`) or personal
    /// (`assignee=me`) inbox. A plain tenant-scoped read: the REST layer applies the
    /// per-row policy guard and OMITS forbidden rows (deny-by-omission), so this
    /// returns every candidate matching the query filter.
    pub async fn list_waiting_tasks(
        &self,
        org: OrgId,
        me: mnt_kernel_core::UserId,
        filter: WaitingTaskListFilter,
    ) -> Result<Vec<WaitingTaskListItem>, KernelError> {
        let statuses: Vec<String> = filter
            .statuses
            .iter()
            .map(|status| status.as_db_str().to_owned())
            .collect();
        with_org_conn::<_, Vec<WaitingTaskListItem>, PgWorkflowRuntimeError>(
            &self.pool,
            org,
            move |tx| {
                Box::pin(async move {
                    let rows = sqlx::query(
                        "SELECT t.id AS task_id, t.run_id, t.waiting_key, t.title, \
                                t.assignee_role_key, t.required_policy, t.status, \
                                t.claimed_by, t.due_at, t.form_payload, \
                                r.object_type, r.object_id \
                         FROM workflow_waiting_tasks t \
                         JOIN workflow_runs r ON r.id = t.run_id AND r.org_id = t.org_id \
                         WHERE t.status = ANY($1) \
                           AND ($2::text IS NULL OR t.assignee_role_key = $2) \
                           AND (NOT $3 OR t.claimed_by = $4 OR t.assignee_user_id = $4 \
                                OR t.status = 'OPEN') \
                         ORDER BY t.created_at DESC \
                         LIMIT 200",
                    )
                    .bind(&statuses)
                    .bind(filter.role_key.as_deref())
                    .bind(filter.assignee_me)
                    .bind(*me.as_uuid())
                    .fetch_all(tx.as_mut())
                    .await
                    .map_err(PgWorkflowRuntimeError::from)?;

                    let mut items = Vec::with_capacity(rows.len());
                    for row in &rows {
                        let status: String = row.try_get("status")?;
                        items.push(WaitingTaskListItem {
                            task_id: row.try_get("task_id")?,
                            run_id: row.try_get("run_id")?,
                            waiting_key: row.try_get("waiting_key")?,
                            title: row.try_get("title")?,
                            assignee_role_key: row.try_get("assignee_role_key")?,
                            required_policy: row.try_get("required_policy")?,
                            object_type: row.try_get("object_type")?,
                            object_id: row.try_get("object_id")?,
                            status: WaitingTaskStatus::from_db_str(&status)?,
                            claimed_by: row.try_get("claimed_by")?,
                            due_at: row.try_get("due_at")?,
                            form_payload: row.try_get("form_payload")?,
                        });
                    }
                    Ok(items)
                })
            },
        )
        .await
        .map_err(KernelError::from)
    }

    /// List the submission-box runs a principal initiated (`initiated_by = me`).
    /// Final-approved-but-not-finalized runs are still WAITING (non-terminal) and so
    /// are naturally included — no terminal filter is applied.
    pub async fn list_runs_for_initiator(
        &self,
        org: OrgId,
        me: mnt_kernel_core::UserId,
        filter: RunListFilter,
    ) -> Result<Vec<RunListItem>, KernelError> {
        let statuses: Vec<String> = filter
            .statuses
            .iter()
            .map(|status| status.as_db_str().to_owned())
            .collect();
        with_org_conn::<_, Vec<RunListItem>, PgWorkflowRuntimeError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let rows = sqlx::query(
                    "SELECT r.id AS run_id, r.status, r.definition_id, r.definition_version, \
                            r.object_type, r.object_id, r.initiated_by, r.started_at, r.updated_at \
                     FROM workflow_runs r \
                     WHERE r.initiated_by = $1 \
                       AND (cardinality($2::text[]) = 0 OR r.status = ANY($2)) \
                       AND ($3::text IS NULL OR r.object_type = $3) \
                     ORDER BY r.updated_at DESC \
                     LIMIT 200",
                )
                .bind(*me.as_uuid())
                .bind(&statuses)
                .bind(filter.object_type.as_deref())
                .fetch_all(tx.as_mut())
                .await
                .map_err(PgWorkflowRuntimeError::from)?;

                let mut items = Vec::with_capacity(rows.len());
                for row in &rows {
                    let status: String = row.try_get("status")?;
                    items.push(RunListItem {
                        run_id: row.try_get("run_id")?,
                        status: RunStatus::from_db_str(&status)?,
                        definition_id: row.try_get("definition_id")?,
                        definition_version: row.try_get("definition_version")?,
                        object_type: row.try_get("object_type")?,
                        object_id: row.try_get("object_id")?,
                        initiated_by: row.try_get("initiated_by")?,
                        started_at: row.try_get("started_at")?,
                        updated_at: row.try_get("updated_at")?,
                    });
                }
                Ok(items)
            })
        })
        .await
        .map_err(KernelError::from)
    }

    /// Claim an OPEN waiting task (OPEN → CLAIMED). A same-user replay on an
    /// already-CLAIMED task is a 200 no-op; a task claimed by another user, or in any
    /// terminal/cancelled/expired state, is a 409. Audits `workflow_task.claim`.
    // mnt-gate: state-changing-handler
    pub async fn claim_waiting_task(
        &self,
        org: OrgId,
        command: ClaimWaitingTaskCommand,
    ) -> Result<ClaimedWaitingTask, KernelError> {
        with_audits::<_, ClaimedWaitingTask, PgWorkflowRuntimeError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let row = sqlx::query(
                    "SELECT id AS task_id, run_id, status, claimed_by, claimed_at \
                     FROM workflow_waiting_tasks WHERE id = $1 FOR UPDATE",
                )
                .bind(command.task_id)
                .fetch_optional(tx.as_mut())
                .await
                .map_err(PgWorkflowRuntimeError::from)?;

                let Some(row) = row else {
                    return Err(PgWorkflowRuntimeError::from(KernelError::not_found(
                        "workflow task not found",
                    )));
                };
                let run_id: Uuid = row.try_get("run_id")?;
                let status_str: String = row.try_get("status")?;
                let status = WaitingTaskStatus::from_db_str(&status_str)?;
                let claimed_by: Option<Uuid> = row.try_get("claimed_by")?;
                let claimed_at: Option<time::OffsetDateTime> = row.try_get("claimed_at")?;

                // Same-user replay: already CLAIMED by this actor is an idempotent 200.
                if status == WaitingTaskStatus::Claimed
                    && claimed_by == Some(*command.actor.as_uuid())
                {
                    return Ok((
                        ClaimedWaitingTask {
                            task_id: command.task_id,
                            run_id,
                            status,
                            claimed_by,
                            claimed_at,
                        },
                        Vec::new(),
                    ));
                }
                if status != WaitingTaskStatus::Open {
                    return Err(PgWorkflowRuntimeError::from(KernelError::conflict(
                        "workflow task is not open to claim",
                    )));
                }

                sqlx::query(
                    "UPDATE workflow_waiting_tasks \
                     SET status = 'CLAIMED', claimed_by = $2, claimed_at = now(), updated_at = now() \
                     WHERE id = $1 AND status = 'OPEN'",
                )
                .bind(command.task_id)
                .bind(*command.actor.as_uuid())
                .execute(tx.as_mut())
                .await
                .map_err(PgWorkflowRuntimeError::from)?;

                let new_claimed_at: Option<time::OffsetDateTime> = sqlx::query_scalar(
                    "SELECT claimed_at FROM workflow_waiting_tasks WHERE id = $1",
                )
                .bind(command.task_id)
                .fetch_one(tx.as_mut())
                .await
                .map_err(PgWorkflowRuntimeError::from)?;

                let mut audits = command.transition_audits;
                audits.push(
                    AuditEvent::new(
                        Some(command.actor),
                        AuditAction::new("workflow_task.claim")
                            .map_err(PgWorkflowRuntimeError::from)?,
                        "workflow_waiting_task",
                        command.task_id.to_string(),
                        TraceContext::generate(),
                        time::OffsetDateTime::now_utc(),
                    )
                    .with_org(org)
                    .with_snapshots(
                        Some(serde_json::json!({ "status": "OPEN" })),
                        Some(serde_json::json!({ "status": "CLAIMED" })),
                    ),
                );

                Ok((
                    ClaimedWaitingTask {
                        task_id: command.task_id,
                        run_id,
                        status: WaitingTaskStatus::Claimed,
                        claimed_by: Some(*command.actor.as_uuid()),
                        claimed_at: new_claimed_at,
                    },
                    audits,
                ))
            })
        })
        .await
        .map_err(KernelError::from)
    }

    /// Decide a non-finalize waiting task: `approve` advances the run to the next
    /// node (a human task parks WAITING; no successor closes the run SUCCEEDED);
    /// `reject`/`return` land the task REJECTED and cancel the run (no terminal
    /// reopen — a resubmission is a new run). Idempotent by `idempotency_key`. Audits
    /// `workflow_task.decide` plus the node/run transitions. Finalize/receipt tasks
    /// are 422 here (they go through the finalize endpoint).
    // mnt-gate: state-changing-handler
    pub async fn decide_waiting_task(
        &self,
        org: OrgId,
        command: DecideWaitingTaskCommand,
    ) -> Result<DecidedWaitingTask, KernelError> {
        with_audits::<_, DecidedWaitingTask, PgWorkflowRuntimeError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let row = sqlx::query(
                    "SELECT t.id AS task_id, t.run_id, t.node_run_id, t.waiting_key, \
                            t.status AS task_status, t.claimed_by, t.completed_by, \
                            t.decision_payload, r.status AS run_status \
                     FROM workflow_waiting_tasks t \
                     JOIN workflow_runs r ON r.id = t.run_id AND r.org_id = t.org_id \
                     WHERE t.id = $1 FOR UPDATE OF t, r",
                )
                .bind(command.task_id)
                .fetch_optional(tx.as_mut())
                .await
                .map_err(PgWorkflowRuntimeError::from)?;

                let Some(row) = row else {
                    return Err(PgWorkflowRuntimeError::from(KernelError::not_found(
                        "workflow task not found",
                    )));
                };
                let run_id: Uuid = row.try_get("run_id")?;
                let node_run_id: Option<Uuid> = row.try_get("node_run_id")?;
                let waiting_key: String = row.try_get("waiting_key")?;
                let task_status_str: String = row.try_get("task_status")?;
                let run_status_str: String = row.try_get("run_status")?;
                let task_status = WaitingTaskStatus::from_db_str(&task_status_str)?;
                let run_status = RunStatus::from_db_str(&run_status_str)?;
                let claimed_by: Option<Uuid> = row.try_get("claimed_by")?;
                let completed_by: Option<Uuid> = row.try_get("completed_by")?;
                let existing_decision: Option<serde_json::Value> =
                    row.try_get("decision_payload")?;

                if waiting_key == FINALIZE_WAITING_KEY || waiting_key == RECEIPT_WAITING_KEY {
                    return Err(PgWorkflowRuntimeError::from(KernelError::validation(
                        "workflow task is a finalization/receipt task, not a decision task",
                    )));
                }

                // Idempotent replay: a completed decision with the same key returns
                // its recorded result (no next_task re-derivation needed).
                if matches!(
                    task_status,
                    WaitingTaskStatus::Approved | WaitingTaskStatus::Rejected
                ) && existing_decision
                    .as_ref()
                    .and_then(|value| value.get("idempotency_key"))
                    .and_then(serde_json::Value::as_str)
                    == Some(command.idempotency_key.as_str())
                {
                    let _ = completed_by;
                    return Ok((
                        DecidedWaitingTask {
                            task_id: command.task_id,
                            run_id,
                            status: task_status,
                            decision_payload: existing_decision
                                .unwrap_or_else(|| serde_json::json!({})),
                            run_status,
                            next_task: None,
                        },
                        Vec::new(),
                    ));
                }

                if !matches!(
                    task_status,
                    WaitingTaskStatus::Open | WaitingTaskStatus::Claimed
                ) {
                    return Err(PgWorkflowRuntimeError::from(KernelError::conflict(
                        "workflow task is not open for a decision",
                    )));
                }
                if let Some(claimed_by) = claimed_by
                    && claimed_by != *command.actor.as_uuid()
                {
                    return Err(PgWorkflowRuntimeError::from(KernelError::conflict(
                        "workflow task is claimed by another user",
                    )));
                }
                if run_status != RunStatus::Waiting {
                    return Err(PgWorkflowRuntimeError::from(KernelError::conflict(
                        "workflow run is not waiting for a decision",
                    )));
                }

                let approved = command.decision == TaskDecision::Approve;
                let new_task_status = if approved {
                    WaitingTaskStatus::Approved
                } else {
                    WaitingTaskStatus::Rejected
                };
                let decision_payload = serde_json::json!({
                    "decision": command.decision.as_str(),
                    "comment": command.comment,
                    "idempotency_key": command.idempotency_key,
                });

                sqlx::query(
                    "UPDATE workflow_waiting_tasks \
                     SET status = $2, completed_by = $3, completed_at = now(), \
                         decision_payload = $4, updated_at = now() \
                     WHERE id = $1 AND status IN ('OPEN', 'CLAIMED')",
                )
                .bind(command.task_id)
                .bind(new_task_status.as_db_str())
                .bind(*command.actor.as_uuid())
                .bind(decision_payload.clone())
                .execute(tx.as_mut())
                .await
                .map_err(PgWorkflowRuntimeError::from)?;

                if let Some(node_run_id) = node_run_id {
                    sqlx::query(
                        "UPDATE workflow_node_runs \
                         SET status = 'SUCCEEDED', finished_at = now(), updated_at = now(), \
                             output_payload = $2 \
                         WHERE id = $1 AND status = 'WAITING'",
                    )
                    .bind(node_run_id)
                    .bind(serde_json::json!({ "decision": command.decision.as_str() }))
                    .execute(tx.as_mut())
                    .await
                    .map_err(PgWorkflowRuntimeError::from)?;
                }

                let mut audit_events = command.transition_audits;
                audit_events.push(
                    AuditEvent::new(
                        Some(command.actor),
                        AuditAction::new("workflow_task.decide")
                            .map_err(PgWorkflowRuntimeError::from)?,
                        "workflow_waiting_task",
                        command.task_id.to_string(),
                        TraceContext::generate(),
                        time::OffsetDateTime::now_utc(),
                    )
                    .with_org(org)
                    .with_snapshots(
                        Some(serde_json::json!({ "status": task_status.as_db_str() })),
                        Some(serde_json::json!({
                            "status": new_task_status.as_db_str(),
                            "decision": command.decision.as_str(),
                        })),
                    ),
                );
                if let Some(node_run_id) = node_run_id {
                    audit_events.push(
                        AuditEvent::new(
                            Some(command.actor),
                            AuditAction::new("workflow_node.commit")
                                .map_err(PgWorkflowRuntimeError::from)?,
                            "workflow_node_run",
                            node_run_id.to_string(),
                            TraceContext::generate(),
                            time::OffsetDateTime::now_utc(),
                        )
                        .with_org(org)
                        .with_snapshots(
                            Some(serde_json::json!({ "status": "WAITING" })),
                            Some(serde_json::json!({ "status": "SUCCEEDED" })),
                        ),
                    );
                }

                // reject/return: cancel the run (terminal; no reopen). approve:
                // advance to the next node.
                if !approved {
                    sqlx::query(run_transition_sql(RunStatus::Cancelled))
                        .bind(run_id)
                        .bind(RunStatus::Cancelled.as_db_str())
                        .bind(RunStatus::Waiting.as_db_str())
                        .bind(serde_json::json!({ "decision": command.decision.as_str() }))
                        .bind(Option::<serde_json::Value>::None)
                        .execute(tx.as_mut())
                        .await
                        .map_err(PgWorkflowRuntimeError::from)?;
                    audit_events.push(run_transition_audit(
                        command.actor,
                        org,
                        run_id,
                        "WAITING",
                        RunStatus::Cancelled.as_db_str(),
                    )?);
                    return Ok((
                        DecidedWaitingTask {
                            task_id: command.task_id,
                            run_id,
                            status: new_task_status,
                            decision_payload,
                            run_status: RunStatus::Cancelled,
                            next_task: None,
                        },
                        audit_events,
                    ));
                }

                // approve: resolve the next node from the published graph.
                let definition: serde_json::Value = sqlx::query_scalar(
                    "SELECT v.definition \
                     FROM workflow_runs r \
                     JOIN workflow_definition_versions v \
                       ON v.definition_id = r.definition_id \
                      AND v.version = r.definition_version \
                      AND v.org_id = r.org_id \
                     WHERE r.id = $1",
                )
                .bind(run_id)
                .fetch_one(tx.as_mut())
                .await
                .map_err(PgWorkflowRuntimeError::from)?;

                let (run_final, next_task) = match next_node_after(&definition, &waiting_key) {
                    None => {
                        // Terminal: no successor closes the run SUCCEEDED.
                        sqlx::query(run_transition_sql(RunStatus::Succeeded))
                            .bind(run_id)
                            .bind(RunStatus::Succeeded.as_db_str())
                            .bind(RunStatus::Waiting.as_db_str())
                            .bind(serde_json::json!({ "decision": "approve" }))
                            .bind(Option::<serde_json::Value>::None)
                            .execute(tx.as_mut())
                            .await
                            .map_err(PgWorkflowRuntimeError::from)?;
                        audit_events.push(run_transition_audit(
                            command.actor,
                            org,
                            run_id,
                            "WAITING",
                            RunStatus::Succeeded.as_db_str(),
                        )?);
                        (RunStatus::Succeeded, None)
                    }
                    Some(next) if is_human_node(&next.node_type) => {
                        // Park the next approval step; the run stays WAITING.
                        let (_next_node_run, next_task_id) =
                            park_waiting_node(tx, org, run_id, &next).await?;
                        audit_events.push(
                            AuditEvent::new(
                                Some(command.actor),
                                AuditAction::new("workflow_node.commit")
                                    .map_err(PgWorkflowRuntimeError::from)?,
                                "workflow_node_run",
                                next.node_key.clone(),
                                TraceContext::generate(),
                                time::OffsetDateTime::now_utc(),
                            )
                            .with_org(org)
                            .with_snapshots(
                                Some(serde_json::json!({ "status": "PENDING" })),
                                Some(serde_json::json!({ "status": "WAITING" })),
                            ),
                        );
                        (
                            RunStatus::Waiting,
                            Some(WaitingTaskListItem {
                                task_id: next_task_id,
                                run_id,
                                waiting_key: next.node_key.clone(),
                                title: next.title.clone(),
                                assignee_role_key: next.assignee_role_key.clone(),
                                required_policy: next.required_policy.clone(),
                                object_type: None,
                                object_id: None,
                                status: WaitingTaskStatus::Open,
                                claimed_by: None,
                                due_at: None,
                                form_payload: serde_json::json!({}),
                            }),
                        )
                    }
                    Some(_) => {
                        // ponytail: approval lines are human chains end-to-end in the
                        // builder's templates; a non-human successor after a decision
                        // node is not emitted today. Fail closed rather than silently
                        // stranding the run — add gate/job advance here if a template
                        // ever needs it.
                        return Err(PgWorkflowRuntimeError::from(KernelError::validation(
                            "decision advance to a non-human node is unsupported",
                        )));
                    }
                };

                Ok((
                    DecidedWaitingTask {
                        task_id: command.task_id,
                        run_id,
                        status: new_task_status,
                        decision_payload,
                        run_status: run_final,
                        next_task,
                    },
                    audit_events,
                ))
            })
        })
        .await
        .map_err(KernelError::from)
    }
}

fn is_human_node(node_type: &str) -> bool {
    matches!(node_type, "human_task" | "waiting_task")
}

fn run_transition_audit(
    actor: mnt_kernel_core::UserId,
    org: OrgId,
    run_id: Uuid,
    from: &str,
    to: &str,
) -> Result<AuditEvent, PgWorkflowRuntimeError> {
    Ok(AuditEvent::new(
        Some(actor),
        AuditAction::new("workflow_run.transition").map_err(PgWorkflowRuntimeError::from)?,
        "workflow_run",
        run_id.to_string(),
        TraceContext::generate(),
        time::OffsetDateTime::now_utc(),
    )
    .with_org(org)
    .with_snapshots(
        Some(serde_json::json!({ "status": from })),
        Some(serde_json::json!({ "status": to })),
    ))
}

/// The UPDATE for a run transition, selected by which terminal timestamp column
/// the target status must stamp (per the 0077 CHECKs). Each arm is a static
/// literal; only bound parameters carry data. Bind order is uniform:
/// `$1` run_id, `$2` new status, `$3` expected current status, `$4` output, `$5` error.
fn run_transition_sql(to: RunStatus) -> &'static str {
    match to.terminal_timestamp() {
        None => {
            "UPDATE workflow_runs \
             SET status = $2, updated_at = now(), \
                 output_payload = COALESCE($4, output_payload), \
                 error_payload = COALESCE($5, error_payload) \
             WHERE id = $1 AND status = $3"
        }
        Some(RunTerminalTimestamp::CompletedAt) => {
            "UPDATE workflow_runs \
             SET status = $2, updated_at = now(), completed_at = now(), \
                 output_payload = COALESCE($4, output_payload), \
                 error_payload = COALESCE($5, error_payload) \
             WHERE id = $1 AND status = $3"
        }
        Some(RunTerminalTimestamp::FailedAt) => {
            "UPDATE workflow_runs \
             SET status = $2, updated_at = now(), failed_at = now(), \
                 output_payload = COALESCE($4, output_payload), \
                 error_payload = COALESCE($5, error_payload) \
             WHERE id = $1 AND status = $3"
        }
    }
}

impl WorkflowRuntimePort for PgWorkflowRuntimeStore {
    // mnt-gate: state-changing-handler
    fn insert_run<'a>(&'a self, run: NewRun, audit: AuditEvent) -> PortFuture<'a, ()> {
        Box::pin(async move {
            with_audit::<_, (), PgWorkflowRuntimeError>(&self.pool, audit, move |tx| {
                Box::pin(async move {
                    sqlx::query(
                        "INSERT INTO workflow_runs \
                             (id, org_id, definition_id, definition_version, status, \
                              trigger_type, object_type, object_id, idempotency_key, \
                              correlation_id, trace_id, input_payload, context_payload, \
                              initiated_by) \
                         VALUES ($1, $2, $3, $4, 'STARTING', $5, $6, $7, $8, $9, $10, \
                                 $11, $12, $13)",
                    )
                    .bind(run.id)
                    .bind(*run.org_id.as_uuid())
                    .bind(run.definition_id)
                    .bind(run.definition_version)
                    .bind(run.trigger_type.as_db_str())
                    .bind(run.object_type)
                    .bind(run.object_id)
                    .bind(run.idempotency_key)
                    .bind(run.correlation_id)
                    .bind(run.trace_id)
                    .bind(run.input_payload)
                    .bind(run.context_payload)
                    .bind(run.initiated_by.map(|user| *user.as_uuid()))
                    .execute(tx.as_mut())
                    .await
                    .map_err(PgWorkflowRuntimeError::from)?;
                    Ok(())
                })
            })
            .await
            .map_err(KernelError::from)
        })
    }

    fn load_run<'a>(&'a self, org: OrgId, run_id: Uuid) -> PortFuture<'a, Option<RunRecord>> {
        Box::pin(async move {
            with_org_conn::<_, Option<RunRecord>, PgWorkflowRuntimeError>(
                &self.pool,
                org,
                move |tx| {
                    Box::pin(async move {
                        let row = sqlx::query(
                            "SELECT id, org_id, status, definition_id, definition_version, \
                                    object_type, object_id \
                             FROM workflow_runs WHERE id = $1",
                        )
                        .bind(run_id)
                        .fetch_optional(tx.as_mut())
                        .await
                        .map_err(PgWorkflowRuntimeError::from)?;

                        let Some(row) = row else {
                            return Ok(None);
                        };
                        let status_str: String = row.try_get("status")?;
                        let id: Uuid = row.try_get("id")?;
                        let org_uuid: Uuid = row.try_get("org_id")?;
                        let definition_id: Uuid = row.try_get("definition_id")?;
                        let definition_version: i32 = row.try_get("definition_version")?;
                        let object_type: Option<String> = row.try_get("object_type")?;
                        let object_id: Option<Uuid> = row.try_get("object_id")?;
                        Ok(Some(RunRecord {
                            id,
                            org_id: OrgId::from_uuid(org_uuid),
                            status: RunStatus::from_db_str(&status_str)?,
                            definition_id,
                            definition_version,
                            object_type,
                            object_id,
                        }))
                    })
                },
            )
            .await
            .map_err(KernelError::from)
        })
    }

    // mnt-gate: state-changing-handler
    fn transition_run<'a>(
        &'a self,
        org: OrgId,
        transition: RunTransition,
        audit: AuditEvent,
    ) -> PortFuture<'a, ()> {
        Box::pin(async move {
            with_audit::<_, (), PgWorkflowRuntimeError>(&self.pool, audit, move |tx| {
                Box::pin(async move {
                    let _ = org; // org is armed by with_audit from the event; kept for symmetry.
                    sqlx::query(run_transition_sql(transition.to))
                        .bind(transition.run_id)
                        .bind(transition.to.as_db_str())
                        .bind(transition.from.as_db_str())
                        .bind(transition.output_payload)
                        .bind(transition.error_payload)
                        .execute(tx.as_mut())
                        .await
                        .map_err(PgWorkflowRuntimeError::from)?;
                    Ok(())
                })
            })
            .await
            .map_err(KernelError::from)
        })
    }

    // mnt-gate: state-changing-handler
    fn commit_node_step<'a>(&'a self, org: OrgId, commit: NodeStepCommit) -> PortFuture<'a, ()> {
        Box::pin(async move {
            with_audits::<_, (), PgWorkflowRuntimeError>(&self.pool, org, move |tx| {
                Box::pin(async move {
                    let NodeStepCommit {
                        new_node,
                        node_final_status,
                        node_output,
                        node_error,
                        emissions,
                        waiting_task,
                        run_transition,
                        audit_events,
                    } = commit;
                    let org_uuid = *org.as_uuid();

                    // 1. Insert the node run PENDING. ON CONFLICT DO NOTHING on the
                    //    reused UNIQUE(org_id, idempotency_key) (0077:69) so a RESUMED
                    //    completion tail (a reconciler re-drive after a crash) does not
                    //    23505-abort on a node it already recorded — the node key is
                    //    deterministic (node:{run_id}:{node_key}:{attempt}), so a re-run
                    //    of the same node is a no-op and the subsequent status UPDATEs
                    //    (guarded on the fresh node id) simply match zero rows.
                    sqlx::query(
                        "INSERT INTO workflow_node_runs \
                             (id, org_id, run_id, node_key, node_type, status, attempt, \
                              idempotency_key, input_payload) \
                         VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7, $8) \
                         ON CONFLICT (org_id, idempotency_key) DO NOTHING",
                    )
                    .bind(new_node.id)
                    .bind(org_uuid)
                    .bind(new_node.run_id)
                    .bind(new_node.node_key)
                    .bind(new_node.node_type)
                    .bind(new_node.attempt)
                    .bind(new_node.idempotency_key)
                    .bind(new_node.input_payload)
                    .execute(tx.as_mut())
                    .await
                    .map_err(PgWorkflowRuntimeError::from)?;

                    // 2. Node PENDING -> RUNNING.
                    sqlx::query(
                        "UPDATE workflow_node_runs \
                         SET status = 'RUNNING', started_at = now(), updated_at = now() \
                         WHERE id = $1 AND status = 'PENDING'",
                    )
                    .bind(new_node.id)
                    .execute(tx.as_mut())
                    .await
                    .map_err(PgWorkflowRuntimeError::from)?;

                    // 3. Transactional-outbox emissions. ON CONFLICT DO NOTHING on the
                    //    reused UNIQUE(org_id, idempotency_key) (0077:149) so re-running
                    //    a node whose emission was already enqueued (a resumed tail)
                    //    never duplicates the outbox row nor 23505-aborts.
                    for emission in emissions {
                        sqlx::query(
                            "INSERT INTO workflow_outbox_events \
                                 (org_id, run_id, node_run_id, channel, destination_ref, \
                                  idempotency_key, status, payload) \
                             VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7) \
                             ON CONFLICT (org_id, idempotency_key) DO NOTHING",
                        )
                        .bind(org_uuid)
                        .bind(new_node.run_id)
                        .bind(emission.node_run_id)
                        .bind(emission.channel.as_db_str())
                        .bind(emission.destination_ref)
                        .bind(emission.idempotency_key)
                        .bind(emission.payload)
                        .execute(tx.as_mut())
                        .await
                        .map_err(PgWorkflowRuntimeError::from)?;
                    }

                    // 4. Optional waiting task (run parks on it).
                    if let Some(task) = waiting_task {
                        sqlx::query(
                            "INSERT INTO workflow_waiting_tasks \
                                 (org_id, run_id, node_run_id, waiting_key, title, status, \
                                  assignee_role_key, required_policy, form_payload, due_at) \
                             VALUES ($1, $2, $3, $4, $5, 'OPEN', $6, $7, $8, $9)",
                        )
                        .bind(org_uuid)
                        .bind(task.run_id)
                        .bind(task.node_run_id)
                        .bind(task.waiting_key)
                        .bind(task.title)
                        .bind(task.assignee_role_key)
                        .bind(task.required_policy)
                        .bind(task.form_payload)
                        .bind(task.due_at)
                        .execute(tx.as_mut())
                        .await
                        .map_err(PgWorkflowRuntimeError::from)?;
                    }

                    // 5. Node RUNNING -> final. Terminal statuses stamp finished_at.
                    let node_sql = if node_final_status.sets_finished_at() {
                        "UPDATE workflow_node_runs \
                         SET status = $2, updated_at = now(), finished_at = now(), \
                             output_payload = $3, error_payload = $4 \
                         WHERE id = $1 AND status = 'RUNNING'"
                    } else {
                        "UPDATE workflow_node_runs \
                         SET status = $2, updated_at = now(), \
                             output_payload = $3, error_payload = $4 \
                         WHERE id = $1 AND status = 'RUNNING'"
                    };
                    sqlx::query(node_sql)
                        .bind(new_node.id)
                        .bind(node_final_status.as_db_str())
                        .bind(node_output)
                        .bind(node_error)
                        .execute(tx.as_mut())
                        .await
                        .map_err(PgWorkflowRuntimeError::from)?;

                    // 6. Optional run transition (e.g. RUNNING -> WAITING on a gate).
                    if let Some(transition) = run_transition {
                        sqlx::query(run_transition_sql(transition.to))
                            .bind(transition.run_id)
                            .bind(transition.to.as_db_str())
                            .bind(transition.from.as_db_str())
                            .bind(transition.output_payload)
                            .bind(transition.error_payload)
                            .execute(tx.as_mut())
                            .await
                            .map_err(PgWorkflowRuntimeError::from)?;
                    }

                    Ok(((), audit_events))
                })
            })
            .await
            .map_err(KernelError::from)
        })
    }

    fn load_finalize_waiting_task<'a>(
        &'a self,
        org: OrgId,
        task_id: Uuid,
    ) -> PortFuture<'a, Option<FinalizeWaitingTaskContext>> {
        Box::pin(async move {
            with_org_conn::<_, Option<FinalizeWaitingTaskContext>, PgWorkflowRuntimeError>(
                &self.pool,
                org,
                move |tx| {
                    Box::pin(async move {
                        let row = sqlx::query(
                            "SELECT \
                                t.id AS task_id, t.run_id, t.node_run_id, t.waiting_key, \
                                t.status AS task_status, t.required_policy, \
                                r.status AS run_status, r.object_type, r.object_id, r.initiated_by \
                             FROM workflow_waiting_tasks t \
                             JOIN workflow_runs r ON r.id = t.run_id AND r.org_id = t.org_id \
                             WHERE t.id = $1",
                        )
                        .bind(task_id)
                        .fetch_optional(tx.as_mut())
                        .await
                        .map_err(PgWorkflowRuntimeError::from)?;

                        let Some(row) = row else {
                            return Ok(None);
                        };
                        let task_status: String = row.try_get("task_status")?;
                        let run_status: String = row.try_get("run_status")?;
                        let initiated_by: Option<Uuid> = row.try_get("initiated_by")?;
                        let initiated_by = initiated_by.ok_or_else(|| {
                            KernelError::validation("finalize task run has no initiator")
                        })?;

                        Ok(Some(FinalizeWaitingTaskContext {
                            task_id: row.try_get("task_id")?,
                            run_id: row.try_get("run_id")?,
                            node_run_id: row.try_get("node_run_id")?,
                            waiting_key: row.try_get("waiting_key")?,
                            task_status: WaitingTaskStatus::from_db_str(&task_status)?,
                            run_status: RunStatus::from_db_str(&run_status)?,
                            required_policy: row.try_get("required_policy")?,
                            object_type: row.try_get("object_type")?,
                            object_id: row.try_get("object_id")?,
                            initiated_by: mnt_kernel_core::UserId::from_uuid(initiated_by),
                        }))
                    })
                },
            )
            .await
            .map_err(KernelError::from)
        })
    }

    // mnt-gate: state-changing-handler
    fn finalize_waiting_task<'a>(
        &'a self,
        org: OrgId,
        command: FinalizeWaitingTaskCommand,
    ) -> PortFuture<'a, FinalizedWaitingTask> {
        Box::pin(async move {
            with_audits::<_, FinalizedWaitingTask, PgWorkflowRuntimeError>(
                &self.pool,
                org,
                move |tx| {
                    Box::pin(async move {
                        let row = sqlx::query(
                            "SELECT \
                                t.id AS task_id, t.run_id, t.node_run_id, t.waiting_key, \
                                t.status AS task_status, t.claimed_by, t.completed_by, t.decision_payload, \
                                r.status AS run_status \
                             FROM workflow_waiting_tasks t \
                             JOIN workflow_runs r ON r.id = t.run_id AND r.org_id = t.org_id \
                             WHERE t.id = $1 \
                             FOR UPDATE OF t, r",
                        )
                        .bind(command.task_id)
                        .fetch_optional(tx.as_mut())
                        .await
                        .map_err(PgWorkflowRuntimeError::from)?;

                        let Some(row) = row else {
                            return Err(PgWorkflowRuntimeError::from(KernelError::not_found(
                                "workflow task not found",
                            )));
                        };
                        let task_status_str: String = row.try_get("task_status")?;
                        let run_status_str: String = row.try_get("run_status")?;
                        let task_status = WaitingTaskStatus::from_db_str(&task_status_str)?;
                        let run_status = RunStatus::from_db_str(&run_status_str)?;
                        let waiting_key: String = row.try_get("waiting_key")?;
                        let node_run_id: Option<Uuid> = row.try_get("node_run_id")?;
                        let claimed_by: Option<Uuid> = row.try_get("claimed_by")?;
                        let completed_by: Option<Uuid> = row.try_get("completed_by")?;
                        let existing_decision: Option<serde_json::Value> =
                            row.try_get("decision_payload")?;

                        if waiting_key != FINALIZE_WAITING_KEY {
                            return Err(PgWorkflowRuntimeError::from(KernelError::validation(
                                "workflow task is not a finalization task",
                            )));
                        }

                        if task_status == WaitingTaskStatus::Approved
                            && existing_decision
                                .as_ref()
                                .and_then(|value| value.get("idempotency_key"))
                                .and_then(serde_json::Value::as_str)
                                == Some(command.idempotency_key.as_str())
                        {
                            return Ok((
                                FinalizedWaitingTask {
                                    task_id: command.task_id,
                                    run_id: row.try_get("run_id")?,
                                    status: WaitingTaskStatus::Approved,
                                    completed_by: completed_by.map(mnt_kernel_core::UserId::from_uuid),
                                    decision_payload: existing_decision
                                        .unwrap_or_else(|| serde_json::json!({})),
                                    run_status,
                                },
                                Vec::new(),
                            ));
                        }

                        if !matches!(
                            task_status,
                            WaitingTaskStatus::Open | WaitingTaskStatus::Claimed
                        ) {
                            return Err(PgWorkflowRuntimeError::from(KernelError::conflict(
                                "workflow task is not open for finalization",
                            )));
                        }
                        if let Some(claimed_by) = claimed_by
                            && claimed_by != *command.actor.as_uuid()
                        {
                            return Err(PgWorkflowRuntimeError::from(KernelError::conflict(
                                "workflow task is claimed by another user",
                            )));
                        }
                        if run_status != RunStatus::Waiting {
                            return Err(PgWorkflowRuntimeError::from(KernelError::conflict(
                                "workflow run is not waiting for finalization",
                            )));
                        }

                        let run_id: Uuid = row.try_get("run_id")?;
                        let receipt_spec = {
                            let definition: serde_json::Value = sqlx::query_scalar(
                                "SELECT v.definition \
                                 FROM workflow_runs r \
                                 JOIN workflow_definition_versions v \
                                   ON v.definition_id = r.definition_id \
                                  AND v.version = r.definition_version \
                                  AND v.org_id = r.org_id \
                                 WHERE r.id = $1",
                            )
                            .bind(run_id)
                            .fetch_one(tx.as_mut())
                            .await
                            .map_err(PgWorkflowRuntimeError::from)?;
                            receipt_node_after_finalize(&definition)
                        };
                        let decision_payload = serde_json::json!({
                            "mode": command.mode,
                            "delegated_reason": command.delegated_reason,
                            "idempotency_key": command.idempotency_key,
                            "awaiting_receipt": receipt_spec.is_some(),
                        });

                        sqlx::query(
                            "UPDATE workflow_waiting_tasks \
                             SET status = 'APPROVED', completed_by = $2, completed_at = now(), \
                                 decision_payload = $3, updated_at = now() \
                             WHERE id = $1 AND status IN ('OPEN', 'CLAIMED')",
                        )
                        .bind(command.task_id)
                        .bind(*command.actor.as_uuid())
                        .bind(decision_payload.clone())
                        .execute(tx.as_mut())
                        .await
                        .map_err(PgWorkflowRuntimeError::from)?;

                        if let Some(node_run_id) = node_run_id {
                            sqlx::query(
                                "UPDATE workflow_node_runs \
                                 SET status = 'SUCCEEDED', finished_at = now(), updated_at = now(), \
                                     output_payload = $2 \
                                 WHERE id = $1 AND status = 'WAITING'",
                            )
                            .bind(node_run_id)
                            .bind(serde_json::json!({
                                "finalized": true,
                                "awaiting_receipt": receipt_spec.is_some()
                            }))
                            .execute(tx.as_mut())
                            .await
                            .map_err(PgWorkflowRuntimeError::from)?;
                        }

                        let final_run_status = if let Some(receipt) = &receipt_spec {
                            let receipt_node_run_id = Uuid::new_v4();
                            sqlx::query(
                                "INSERT INTO workflow_node_runs \
                                     (id, org_id, run_id, node_key, node_type, status, attempt, \
                                      idempotency_key, input_payload, started_at) \
                                 VALUES ($1, $2, $3, $4, 'human_task', 'WAITING', 1, $5, \
                                         '{}'::jsonb, now()) \
                                 ON CONFLICT (org_id, run_id, node_key, attempt) DO NOTHING",
                            )
                            .bind(receipt_node_run_id)
                            .bind(*org.as_uuid())
                            .bind(run_id)
                            .bind(RECEIPT_WAITING_KEY)
                            .bind(format!(
                                "workflow_runtime:node:{run_id}:{RECEIPT_WAITING_KEY}:1"
                            ))
                            .execute(tx.as_mut())
                            .await
                            .map_err(PgWorkflowRuntimeError::from)?;

                            let persisted_receipt_node_run_id: Uuid = sqlx::query_scalar(
                                "SELECT id FROM workflow_node_runs \
                                 WHERE run_id = $1 AND node_key = $2 AND attempt = 1",
                            )
                            .bind(run_id)
                            .bind(RECEIPT_WAITING_KEY)
                            .fetch_one(tx.as_mut())
                            .await
                            .map_err(PgWorkflowRuntimeError::from)?;

                            sqlx::query(
                                "INSERT INTO workflow_waiting_tasks \
                                     (id, org_id, run_id, node_run_id, waiting_key, title, status, \
                                      assignee_role_key, required_policy, form_payload) \
                                 VALUES ($1, $2, $3, $4, $5, $6, 'OPEN', $7, $8, '{}'::jsonb) \
                                 ON CONFLICT (org_id, run_id, waiting_key) DO NOTHING",
                            )
                            .bind(Uuid::new_v4())
                            .bind(*org.as_uuid())
                            .bind(run_id)
                            .bind(persisted_receipt_node_run_id)
                            .bind(RECEIPT_WAITING_KEY)
                            .bind(receipt.title.as_str())
                            .bind(receipt.assignee_role_key.as_deref())
                            .bind(receipt.required_policy.as_deref())
                            .execute(tx.as_mut())
                            .await
                            .map_err(PgWorkflowRuntimeError::from)?;

                            RunStatus::Waiting
                        } else {
                            sqlx::query(run_transition_sql(RunStatus::Succeeded))
                                .bind(run_id)
                                .bind(RunStatus::Succeeded.as_db_str())
                                .bind(RunStatus::Waiting.as_db_str())
                                .bind(serde_json::json!({ "finalized": true }))
                                .bind(Option::<serde_json::Value>::None)
                                .execute(tx.as_mut())
                                .await
                                .map_err(PgWorkflowRuntimeError::from)?;
                            RunStatus::Succeeded
                        };

                        let mut audit_events = command.transition_audits;
                        audit_events.push(
                            AuditEvent::new(
                                Some(command.actor),
                                AuditAction::new("workflow_task.finalize")
                                    .map_err(PgWorkflowRuntimeError::from)?,
                                "workflow_waiting_task",
                                command.task_id.to_string(),
                                TraceContext::generate(),
                                time::OffsetDateTime::now_utc(),
                            )
                            .with_org(org)
                            .with_snapshots(
                                Some(serde_json::json!({ "status": task_status.as_db_str() })),
                                Some(serde_json::json!({
                                    "status": WaitingTaskStatus::Approved.as_db_str(),
                                    "mode": decision_payload["mode"],
                                    "delegated_reason": decision_payload["delegated_reason"],
                                })),
                            ),
                        );
                        if let Some(node_run_id) = node_run_id {
                            audit_events.push(
                                AuditEvent::new(
                                    Some(command.actor),
                                    AuditAction::new("workflow_node.commit")
                                        .map_err(PgWorkflowRuntimeError::from)?,
                                    "workflow_node_run",
                                    node_run_id.to_string(),
                                    TraceContext::generate(),
                                    time::OffsetDateTime::now_utc(),
                                )
                                .with_org(org)
                                .with_snapshots(
                                    Some(serde_json::json!({ "status": "WAITING" })),
                                    Some(serde_json::json!({ "status": "SUCCEEDED" })),
                                ),
                            );
                        }
                        if receipt_spec.is_some() {
                            audit_events.push(
                                AuditEvent::new(
                                    Some(command.actor),
                                    AuditAction::new("workflow_node.commit")
                                        .map_err(PgWorkflowRuntimeError::from)?,
                                    "workflow_node_run",
                                    RECEIPT_WAITING_KEY.to_owned(),
                                    TraceContext::generate(),
                                    time::OffsetDateTime::now_utc(),
                                )
                                .with_org(org)
                                .with_snapshots(
                                    Some(serde_json::json!({ "status": "PENDING" })),
                                    Some(serde_json::json!({ "status": "WAITING" })),
                                ),
                            );
                        } else {
                            audit_events.push(
                                AuditEvent::new(
                                    Some(command.actor),
                                    AuditAction::new("workflow_run.transition")
                                        .map_err(PgWorkflowRuntimeError::from)?,
                                    "workflow_run",
                                    run_id.to_string(),
                                    TraceContext::generate(),
                                    time::OffsetDateTime::now_utc(),
                                )
                                .with_org(org)
                                .with_snapshots(
                                    Some(serde_json::json!({ "status": "WAITING" })),
                                    Some(serde_json::json!({ "status": "SUCCEEDED" })),
                                ),
                            );
                        }

                        Ok((
                            FinalizedWaitingTask {
                                task_id: command.task_id,
                                run_id,
                                status: WaitingTaskStatus::Approved,
                                completed_by: Some(command.actor),
                                decision_payload,
                                run_status: final_run_status,
                            },
                            audit_events,
                        ))
                    })
                },
            )
            .await
            .map_err(KernelError::from)
        })
    }

    // mnt-gate: state-changing-handler
    fn create_post_finalization_rejection<'a>(
        &'a self,
        org: OrgId,
        command: PostFinalizationRejectionCommand,
    ) -> PortFuture<'a, PostFinalizationRejection> {
        Box::pin(async move {
            with_audits::<_, PostFinalizationRejection, PgWorkflowRuntimeError>(
                &self.pool,
                org,
                move |tx| {
                    Box::pin(async move {
                        let existing = sqlx::query(
                            "SELECT c.id, c.original_run_id, c.reason, c.created_by, r.status AS run_status \
                             FROM workflow_compensating_documents c \
                             JOIN workflow_runs r ON r.id = c.original_run_id AND r.org_id = c.org_id \
                             WHERE c.idempotency_key = $1",
                        )
                        .bind(command.idempotency_key.as_str())
                        .fetch_optional(tx.as_mut())
                        .await
                        .map_err(PgWorkflowRuntimeError::from)?;
                        if let Some(row) = existing {
                            let run_status: String = row.try_get("run_status")?;
                            return Ok((
                                PostFinalizationRejection {
                                    id: row.try_get("id")?,
                                    original_run_id: row.try_get("original_run_id")?,
                                    reason: row.try_get("reason")?,
                                    created_by: mnt_kernel_core::UserId::from_uuid(
                                        row.try_get("created_by")?,
                                    ),
                                    run_status: RunStatus::from_db_str(&run_status)?,
                                },
                                Vec::new(),
                            ));
                        }

                        let run = sqlx::query(
                            "SELECT status, definition_id, definition_version, object_type, object_id, initiated_by \
                             FROM workflow_runs \
                             WHERE id = $1 \
                             FOR UPDATE",
                        )
                        .bind(command.original_run_id)
                        .fetch_optional(tx.as_mut())
                        .await
                        .map_err(PgWorkflowRuntimeError::from)?;
                        let Some(run) = run else {
                            return Err(PgWorkflowRuntimeError::from(KernelError::not_found(
                                "workflow run not found",
                            )));
                        };
                        let run_status: String = run.try_get("status")?;
                        let run_status = RunStatus::from_db_str(&run_status)?;
                        if run_status != RunStatus::Succeeded {
                            return Err(PgWorkflowRuntimeError::from(KernelError::conflict(
                                "workflow run is not finalized",
                            )));
                        }

                        let mut recipient_ids = BTreeSet::<Uuid>::new();
                        if let Some(initiated_by) = run.try_get::<Option<Uuid>, _>("initiated_by")?
                        {
                            recipient_ids.insert(initiated_by);
                        }
                        let recipient_rows = sqlx::query(
                            "SELECT DISTINCT COALESCE(completed_by, claimed_by, assignee_user_id) AS user_id \
                             FROM workflow_waiting_tasks \
                             WHERE run_id = $1 \
                               AND COALESCE(completed_by, claimed_by, assignee_user_id) IS NOT NULL",
                        )
                        .bind(command.original_run_id)
                        .fetch_all(tx.as_mut())
                        .await
                        .map_err(PgWorkflowRuntimeError::from)?;
                        for row in recipient_rows {
                            recipient_ids.insert(row.try_get("user_id")?);
                        }
                        let recipients = recipient_ids
                            .into_iter()
                            .map(|id| id.to_string())
                            .collect::<Vec<_>>();
                        let recipient_count = recipients.len();

                        let compensation_id = Uuid::new_v4();
                        let payload = serde_json::json!({
                            "original_run_id": command.original_run_id,
                            "definition_id": run.try_get::<Uuid, _>("definition_id")?,
                            "definition_version": run.try_get::<i32, _>("definition_version")?,
                            "object_type": run.try_get::<Option<String>, _>("object_type")?,
                            "object_id": run.try_get::<Option<Uuid>, _>("object_id")?,
                        });
                        sqlx::query(
                            "INSERT INTO workflow_compensating_documents \
                                 (id, org_id, original_run_id, compensation_type, reason, \
                                  idempotency_key, payload, created_by) \
                             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
                        )
                        .bind(compensation_id)
                        .bind(*org.as_uuid())
                        .bind(command.original_run_id)
                        .bind(POST_FINALIZATION_REJECTION)
                        .bind(command.reason.as_str())
                        .bind(command.idempotency_key.as_str())
                        .bind(payload)
                        .bind(*command.actor.as_uuid())
                        .execute(tx.as_mut())
                        .await
                        .map_err(PgWorkflowRuntimeError::from)?;

                        sqlx::query(
                            "INSERT INTO workflow_outbox_events \
                                 (org_id, run_id, channel, destination_ref, idempotency_key, \
                                  status, payload) \
                             VALUES ($1, $2, 'NOTIFICATION', 'approval_line', $3, 'PENDING', $4) \
                             ON CONFLICT (org_id, idempotency_key) DO NOTHING",
                        )
                        .bind(*org.as_uuid())
                        .bind(command.original_run_id)
                        .bind(format!(
                            "workflow_compensation:post_finalization_rejection:{compensation_id}:notify_line"
                        ))
                        .bind(serde_json::json!({
                            "event": "post_finalization_rejection",
                            "compensation_id": compensation_id,
                            "original_run_id": command.original_run_id,
                            "reason": command.reason,
                            "recipients": recipients,
                            "recipient_count": recipient_count,
                        }))
                        .execute(tx.as_mut())
                        .await
                        .map_err(PgWorkflowRuntimeError::from)?;

                        let mut audit_events = command.transition_audits;
                        audit_events.push(
                            AuditEvent::new(
                                Some(command.actor),
                                AuditAction::new(
                                    "workflow_compensation.create_post_finalization_rejection",
                                )
                                .map_err(PgWorkflowRuntimeError::from)?,
                                "workflow_compensating_document",
                                compensation_id.to_string(),
                                TraceContext::generate(),
                                time::OffsetDateTime::now_utc(),
                            )
                            .with_org(org)
                            .with_snapshots(
                                None,
                                Some(serde_json::json!({
                                    "status": "CREATED",
                                    "compensation_id": compensation_id,
                                    "compensation_type": POST_FINALIZATION_REJECTION,
                                    "original_run_id": command.original_run_id,
                                })),
                            ),
                        );

                        Ok((
                            PostFinalizationRejection {
                                id: compensation_id,
                                original_run_id: command.original_run_id,
                                reason: command.reason,
                                created_by: command.actor,
                                run_status,
                            },
                            audit_events,
                        ))
                    })
                },
            )
            .await
            .map_err(KernelError::from)
        })
    }
}
