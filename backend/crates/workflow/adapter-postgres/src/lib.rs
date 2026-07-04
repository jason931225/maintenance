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

use mnt_kernel_core::{AuditAction, AuditEvent, KernelError, OrgId, TraceContext};
use mnt_platform_db::{DbError, with_audit, with_audits, with_org_conn};
use mnt_workflow_domain::{
    NewRun, NodeStepCommit, PortFuture, RunRecord, RunStatus, RunTerminalTimestamp, RunTransition,
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
}
