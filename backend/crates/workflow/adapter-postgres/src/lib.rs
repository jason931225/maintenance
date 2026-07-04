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

use mnt_kernel_core::{AuditEvent, KernelError, OrgId};
use mnt_platform_db::{DbError, with_audit, with_audits, with_org_conn};
use mnt_workflow_domain::{
    NewRun, NodeStepCommit, PortFuture, RunRecord, RunStatus, RunTerminalTimestamp, RunTransition,
    WorkflowRuntimePort,
};
use sqlx::{PgPool, Row};
use uuid::Uuid;

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

                    // 1. Insert the node run PENDING.
                    sqlx::query(
                        "INSERT INTO workflow_node_runs \
                             (id, org_id, run_id, node_key, node_type, status, attempt, \
                              idempotency_key, input_payload) \
                         VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7, $8)",
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

                    // 3. Transactional-outbox emissions.
                    for emission in emissions {
                        sqlx::query(
                            "INSERT INTO workflow_outbox_events \
                                 (org_id, run_id, node_run_id, channel, destination_ref, \
                                  idempotency_key, status, payload) \
                             VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7)",
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
