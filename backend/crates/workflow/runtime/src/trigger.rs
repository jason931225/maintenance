//! System-triggered run starts (BE-AUTO slice 1).
//!
//! One shared entry for every NON-human run producer — the domain-event
//! trigger-binding dispatcher and the cron schedule poller — so both start a
//! run exactly the way the REST `POST /api/v1/workflow-runs` path does
//! (`start_run` → synchronous [`drive_from`] until the first WAITING task or a
//! terminal node) without duplicating the walk. Pure over the domain port: no
//! sqlx here. Production event/schedule callers do not pre-resolve mutable
//! definition JSON; the persistence port selects the exact graph atomically
//! with the deterministic run claim.
//!
//! ## Exactly-once
//! The caller supplies a DETERMINISTIC `idempotency_key` (e.g.
//! `trigger:{binding_id}:{object_id}` or `schedule:{schedule_id}:{fire_unix}`).
//! The adapter first takes a transaction-scoped `(org,key)` claim lock, then
//! either loads the full existing run + exact graph or selects the ACTIVE
//! immutable version/graph pair in one statement snapshot and inserts STARTING
//! + its audit in that same transaction. The run spine's
//! `UNIQUE(org_id, idempotency_key)` remains the exact ownership backstop and assigns start ownership to
//! the caller that commits the STARTING row. A concurrent loser may resume the
//! run after a crash window, but remains `AlreadyStarted`. If it wins activation,
//! the insert owner reconciles the exact advanced run; if both drive the same
//! node, the adapter's deterministic node insert makes the losing commit an
//! side-effect-free no-op. The successful run inserter is therefore still the sole
//! `Started` result without duplicate durable run, node, or audit effects.
//! Recovery proceeds only when the persisted definition id, trigger provenance,
//! object, correlation, input, context, and schedule identity all match the
//! retry. The persisted immutable definition version, initiator, and trace are
//! recovery authority even when the mutable active-version pointer or caller
//! changes between attempts.
//!
//! ## Authorization
//! Schedule starts carry no per-request principal: their authority is the
//! audited authoring act. Object-event starts may carry the actor whose mutation
//! raised the event. Either way, conflict recovery obtains actor and trace from
//! the durable run rather than the retry attempt. Every write remains audited
//! through the port's own `with_audit(s)` transactions.

use mnt_kernel_core::{ErrorKind, KernelError, TraceContext};
use mnt_workflow_domain::{
    BoundRunClaim, IdempotentBoundRunPort, NewBoundRun, RunStatus, RunTransition,
    WorkflowRuntimePort, validate_run_transition,
};
use serde_json::Value;

use crate::engine::{
    AuditContext, StartRunRequest, activate_starting_run, insert_starting_run, run_audit_event,
};
use crate::graph::{ExecGraph, drive_from};

/// How a system-triggered start landed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TriggeredStart {
    /// This caller created the fresh run. Ordinarily it also drove to the first
    /// WAITING task or terminal node; under a recovery race, `run_status` is the
    /// exact later status observed after a contender won a post-insert write.
    Started {
        run_id: uuid::Uuid,
        run_status: RunStatus,
    },
    /// A run under the same deterministic idempotency key already exists — the
    /// event/fire was already handled (possibly by a concurrent dispatcher).
    AlreadyStarted,
    /// No durable run and no ACTIVE executable existed at the atomic claim
    /// point. Callers must not manufacture a run/audit or advance a schedule as
    /// though this fire had been consumed.
    Unavailable,
}

/// System-triggered facts whose immutable definition version is selected only
/// inside the persistence claim transaction. The absence of a version or graph
/// here is intentional: pre-resolution would reopen a race with publication,
/// pause/retirement, or a concurrent claimant.
#[derive(Debug, Clone)]
pub struct StartIdempotentBoundRunRequest {
    pub run_id: uuid::Uuid,
    pub org_id: mnt_kernel_core::OrgId,
    pub definition_id: uuid::Uuid,
    pub trigger_type: mnt_workflow_domain::TriggerType,
    pub object_type: Option<String>,
    pub object_id: Option<uuid::Uuid>,
    pub idempotency_key: String,
    pub correlation_id: String,
    pub trace_id: Option<String>,
    pub input_payload: Value,
    pub context_payload: Value,
    pub initiated_by: Option<mnt_kernel_core::UserId>,
    pub schedule_id: Option<uuid::Uuid>,
}

#[derive(Debug, Clone)]
struct RequestedRunIdentity {
    definition_id: uuid::Uuid,
    definition_version: i32,
    trigger_type: mnt_workflow_domain::TriggerType,
    object_type: Option<String>,
    object_id: Option<uuid::Uuid>,
    correlation_id: String,
    input_payload: Value,
    context_payload: Value,
    schedule_id: Option<uuid::Uuid>,
}

/// Start a run for a trigger binding or schedule fire and drive it through its
/// `wf.exec.v1` node graph. Fails with a validation error when the definition
/// carries no executable node graph (e.g. the graph-less strangler completion
/// template, which is driven by its own hard-coded tail instead).
pub async fn start_bound_run<P: WorkflowRuntimePort + ?Sized>(
    port: &P,
    request: StartRunRequest,
    definition: &Value,
    audit: &AuditContext,
) -> Result<TriggeredStart, KernelError> {
    let org = request.org_id;
    let requested_identity = RequestedRunIdentity {
        definition_id: request.definition_id,
        definition_version: request.definition_version,
        trigger_type: request.trigger_type,
        object_type: request.object_type.clone(),
        object_id: request.object_id,
        correlation_id: request.correlation_id.clone(),
        input_payload: request.input_payload.clone(),
        context_payload: request.context_payload.clone(),
        schedule_id: request.schedule_id,
    };
    let idempotency_key = request.idempotency_key.clone();
    // The run context condition nodes evaluate against. Resume validates it
    // against the persisted context before any graph branch can execute.
    let context = request.context_payload.clone();

    match insert_starting_run(port, request, audit).await {
        Ok(run_id) => {
            // Parse the caller graph only after this caller owns the inserted
            // row. A duplicate must reach the conflict branch below first so a
            // mutable/invalid newly-active graph can never gate recovery of the
            // exact immutable graph already bound by the durable run.
            let graph = ExecGraph::parse(definition)?;
            let entry = graph.entry_node_key()?.to_owned();
            let activated_status = match activate_starting_run(port, org, run_id, audit).await {
                Ok(()) => RunStatus::Running,
                // The successful INSERT already established start ownership.
                // Only an observed advance of this exact row can reconcile an
                // activation Conflict; STARTING remains an unexplained failure.
                Err(err) if err.kind == ErrorKind::Conflict => {
                    reconcile_insert_owner_activation(port, org, run_id, &requested_identity, err)
                        .await?
                }
                Err(err) => return Err(err),
            };

            let run_status = if activated_status == RunStatus::Running {
                // A contender may have won STARTING -> RUNNING and then crashed
                // before graph drive. Re-drive here; the node-commit adapter's
                // deterministic insert ownership makes a concurrent same-node
                // drive a side-effect-free no-op for the loser.
                drive_from(
                    port,
                    org,
                    run_id,
                    RunStatus::Running,
                    &graph,
                    &entry,
                    Vec::new(),
                    &context,
                    audit,
                )
                .await?
                .run_status
            } else {
                activated_status
            };

            Ok(TriggeredStart::Started { run_id, run_status })
        }
        // UNIQUE(org_id, idempotency_key): this fire/event already has a run.
        // Inspect it instead of blindly skipping so a crash after INSERT but
        // before/within graph drive can be resumed.
        Err(err) if err.kind == ErrorKind::Conflict => {
            resume_conflicted_run(port, org, idempotency_key, &requested_identity, audit).await
        }
        Err(err) => Err(err),
    }
}

/// Atomically claim an event/schedule key, then either drive the newly-created
/// exact ACTIVE graph or recover the already-persisted exact graph. Unlike
/// [`start_bound_run`], this production entry has no caller-resolved mutable
/// graph and therefore no resolution/parse window before durable ownership.
pub async fn start_idempotent_bound_run<P: IdempotentBoundRunPort + ?Sized>(
    port: &P,
    request: StartIdempotentBoundRunRequest,
    audit: &AuditContext,
) -> Result<TriggeredStart, KernelError> {
    validate_run_transition(RunStatus::Starting, RunStatus::Running)?;
    if request
        .trace_id
        .as_deref()
        .is_some_and(|trace_id| trace_id != audit.trace.trace_id())
    {
        return Err(KernelError::validation(
            "workflow run trace_id must match the audited start trace",
        ));
    }

    let org = request.org_id;
    let run_id = request.run_id;
    let new_run = NewBoundRun {
        id: run_id,
        org_id: org,
        definition_id: request.definition_id,
        trigger_type: request.trigger_type,
        object_type: request.object_type.clone(),
        object_id: request.object_id,
        idempotency_key: request.idempotency_key.clone(),
        correlation_id: request.correlation_id.clone(),
        trace_id: audit.trace.trace_id().to_owned(),
        input_payload: request.input_payload.clone(),
        context_payload: request.context_payload.clone(),
        initiated_by: request.initiated_by,
        schedule_id: request.schedule_id,
    };
    let start_audit = run_audit_event(
        "workflow_run.start",
        audit,
        run_id,
        org,
        None,
        Some(serde_json::json!({ "status": RunStatus::Starting.as_db_str() })),
    )?;

    let Some(claim) = port
        .claim_bound_run(new_run, start_audit, validate_bound_definition)
        .await?
    else {
        return Ok(TriggeredStart::Unavailable);
    };

    match claim {
        BoundRunClaim::Existing { run, definition } => {
            let requested_identity =
                requested_identity_for_bound_claim(&request, run.definition_version);
            resume_existing_run(port, org, run, definition, &requested_identity, audit).await
        }
        BoundRunClaim::Created { run, definition } => {
            let requested_identity =
                requested_identity_for_bound_claim(&request, run.definition_version);
            validate_resume_identity(&run, org, Some(run_id), &requested_identity, true)?;
            if run.status != RunStatus::Starting {
                return Err(KernelError::conflict(
                    "new workflow bound-run claim did not return STARTING ownership",
                ));
            }

            // No mutable graph exists on this API. This is the exact graph
            // selected in the same transaction that inserted the run.
            let graph = ExecGraph::parse(&definition)?;
            let entry = graph.entry_node_key()?.to_owned();
            let activated_status = match activate_starting_run(port, org, run_id, audit).await {
                Ok(()) => RunStatus::Running,
                Err(err) if err.kind == ErrorKind::Conflict => {
                    reconcile_insert_owner_activation(port, org, run_id, &requested_identity, err)
                        .await?
                }
                Err(err) => return Err(err),
            };
            let run_status = if activated_status == RunStatus::Running {
                drive_from(
                    port,
                    org,
                    run_id,
                    RunStatus::Running,
                    &graph,
                    &entry,
                    Vec::new(),
                    &request.context_payload,
                    audit,
                )
                .await?
                .run_status
            } else {
                activated_status
            };
            Ok(TriggeredStart::Started { run_id, run_status })
        }
    }
}

fn validate_bound_definition(definition: &Value) -> Result<(), KernelError> {
    let schema_version = definition
        .get("schema_version")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            KernelError::validation("workflow executable definition is missing schema_version")
        })?;
    if schema_version != "wf.exec.v1" {
        return Err(KernelError::validation(
            "workflow executable definition schema_version must be wf.exec.v1",
        ));
    }
    let graph = ExecGraph::parse(definition)?;
    let _ = graph.entry_node_key()?;
    Ok(())
}

fn requested_identity_for_bound_claim(
    request: &StartIdempotentBoundRunRequest,
    definition_version: i32,
) -> RequestedRunIdentity {
    RequestedRunIdentity {
        definition_id: request.definition_id,
        definition_version,
        trigger_type: request.trigger_type,
        object_type: request.object_type.clone(),
        object_id: request.object_id,
        correlation_id: request.correlation_id.clone(),
        input_payload: request.input_payload.clone(),
        context_payload: request.context_payload.clone(),
        schedule_id: request.schedule_id,
    }
}

async fn reconcile_insert_owner_activation<P: WorkflowRuntimePort + ?Sized>(
    port: &P,
    org: mnt_kernel_core::OrgId,
    run_id: uuid::Uuid,
    requested_identity: &RequestedRunIdentity,
    conflict: KernelError,
) -> Result<RunStatus, KernelError> {
    let Some(existing) = port.load_run(org, run_id).await? else {
        return Err(conflict);
    };
    validate_resume_identity(&existing, org, Some(run_id), requested_identity, true)?;
    if existing.status == RunStatus::Starting {
        // A Conflict with no observed phase advance is not evidence that a
        // contender took over. Fail closed instead of manufacturing success.
        return Err(conflict);
    }

    Ok(existing.status)
}

#[allow(clippy::too_many_arguments)]
async fn resume_conflicted_run<P: WorkflowRuntimePort + ?Sized>(
    port: &P,
    org: mnt_kernel_core::OrgId,
    idempotency_key: String,
    requested_identity: &RequestedRunIdentity,
    retry_audit: &AuditContext,
) -> Result<TriggeredStart, KernelError> {
    let Some(existing) = port
        .load_run_by_idempotency_key(org, idempotency_key)
        .await?
    else {
        return Err(KernelError::conflict(
            "workflow run idempotency conflict but existing run was not found",
        ));
    };

    // The mutable active pointer may have advanced since this idempotency key
    // durably bound a run. Definition id and every trigger identity fact must
    // still match, but the persisted version is authoritative for recovery.
    validate_resume_identity(&existing, org, None, requested_identity, false)?;
    let definition = port
        .load_exec_definition_version(org, existing.definition_id, existing.definition_version)
        .await?
        .ok_or_else(|| {
            KernelError::conflict(
                "persisted workflow run definition version is unavailable or not executable",
            )
        })?;
    resume_existing_run(
        port,
        org,
        existing,
        definition,
        requested_identity,
        retry_audit,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn resume_existing_run<P: WorkflowRuntimePort + ?Sized>(
    port: &P,
    org: mnt_kernel_core::OrgId,
    existing: mnt_workflow_domain::RunRecord,
    definition: Value,
    requested_identity: &RequestedRunIdentity,
    retry_audit: &AuditContext,
) -> Result<TriggeredStart, KernelError> {
    validate_resume_identity(&existing, org, None, requested_identity, false)?;
    let graph = ExecGraph::parse(&definition)?;
    let entry = graph.entry_node_key()?.to_owned();
    let recovery_audit = persisted_recovery_audit(&existing, retry_audit)?;

    let resumed_status = match existing.status {
        RunStatus::Starting => {
            let transition = RunTransition {
                run_id: existing.id,
                from: RunStatus::Starting,
                to: RunStatus::Running,
                output_payload: None,
                error_payload: None,
            };
            let transition_audit = run_audit_event(
                "workflow_run.transition",
                &recovery_audit,
                existing.id,
                org,
                Some(serde_json::json!({ "status": RunStatus::Starting.as_db_str() })),
                Some(serde_json::json!({ "status": RunStatus::Running.as_db_str() })),
            )?;
            match port.transition_run(org, transition, transition_audit).await {
                Ok(()) => RunStatus::Running,
                Err(err) if err.kind == ErrorKind::Conflict => {
                    let Some(advanced) = port.load_run(org, existing.id).await? else {
                        return Err(err);
                    };
                    validate_resume_identity(
                        &advanced,
                        org,
                        Some(existing.id),
                        requested_identity,
                        false,
                    )?;
                    validate_recovery_authority_stable(&existing, &advanced)?;
                    if advanced.status == RunStatus::Starting {
                        // A write reported Conflict but the exact row did not
                        // advance. Do not manufacture a successful recovery.
                        return Err(err);
                    }
                    advanced.status
                }
                Err(err) => return Err(err),
            }
        }
        status => status,
    };

    match resumed_status {
        RunStatus::Starting => Err(KernelError::conflict(
            "workflow run remained STARTING after resume transition",
        )),
        RunStatus::Running => {
            let _ = drive_existing_running(
                port,
                org,
                existing.id,
                &graph,
                &entry,
                &existing.context_payload,
                &recovery_audit,
            )
            .await?;
            Ok(TriggeredStart::AlreadyStarted)
        }
        RunStatus::Waiting => Ok(TriggeredStart::AlreadyStarted),
        RunStatus::Succeeded
        | RunStatus::Failed
        | RunStatus::Cancelled
        | RunStatus::DeadLettered => Ok(TriggeredStart::AlreadyStarted),
    }
}

fn validate_resume_identity(
    existing: &mnt_workflow_domain::RunRecord,
    org: mnt_kernel_core::OrgId,
    expected_run_id: Option<uuid::Uuid>,
    requested_identity: &RequestedRunIdentity,
    require_requested_version: bool,
) -> Result<(), KernelError> {
    if existing.org_id != org || expected_run_id.is_some_and(|run_id| existing.id != run_id) {
        return Err(KernelError::conflict(
            "workflow run conflict resolved to a different persisted run",
        ));
    }
    if existing.definition_id != requested_identity.definition_id
        || (require_requested_version
            && existing.definition_version != requested_identity.definition_version)
    {
        return Err(KernelError::conflict(
            "workflow run idempotency conflict belongs to a different definition version",
        ));
    }
    if existing.trigger_type != requested_identity.trigger_type
        || existing.object_type != requested_identity.object_type
        || existing.object_id != requested_identity.object_id
        || existing.correlation_id != requested_identity.correlation_id
        || existing.input_payload != requested_identity.input_payload
        || existing.context_payload != requested_identity.context_payload
        || existing.schedule_id != requested_identity.schedule_id
    {
        return Err(KernelError::conflict(
            "workflow run idempotency conflict carries divergent trigger/object/input context",
        ));
    }
    Ok(())
}

fn persisted_recovery_audit(
    existing: &mnt_workflow_domain::RunRecord,
    retry_audit: &AuditContext,
) -> Result<AuditContext, KernelError> {
    if existing.correlation_id.trim().len() < 8 {
        return Err(KernelError::conflict(
            "persisted workflow run has malformed correlation provenance",
        ));
    }
    let trace_id = existing.trace_id.as_deref().ok_or_else(|| {
        KernelError::conflict("persisted workflow run has no recovery trace provenance")
    })?;
    // A retry is a new span within the run's durable trace. Derive the span
    // solely from the persisted run id so no retry-caller trace fact leaks into
    // transition, node, outbox, waiting-task, or audit effects.
    let run_hex = existing.id.simple().to_string();
    let trace = TraceContext::new(trace_id, &run_hex[..16]).map_err(|_| {
        KernelError::conflict("persisted workflow run has malformed recovery trace provenance")
    })?;
    Ok(AuditContext {
        actor: existing.initiated_by,
        trace,
        occurred_at: retry_audit.occurred_at,
    })
}

fn validate_recovery_authority_stable(
    first: &mnt_workflow_domain::RunRecord,
    reloaded: &mnt_workflow_domain::RunRecord,
) -> Result<(), KernelError> {
    if first.definition_id != reloaded.definition_id
        || first.definition_version != reloaded.definition_version
        || first.correlation_id != reloaded.correlation_id
        || first.trace_id != reloaded.trace_id
        || first.initiated_by != reloaded.initiated_by
    {
        return Err(KernelError::conflict(
            "workflow run recovery authority changed while reconciling a conflict",
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn drive_existing_running<P: WorkflowRuntimePort + ?Sized>(
    port: &P,
    org: mnt_kernel_core::OrgId,
    run_id: uuid::Uuid,
    graph: &ExecGraph,
    entry: &str,
    context: &Value,
    audit: &AuditContext,
) -> Result<TriggeredStart, KernelError> {
    let outcome = drive_from(
        port,
        org,
        run_id,
        RunStatus::Running,
        graph,
        entry,
        Vec::new(),
        context,
        audit,
    )
    .await?;
    Ok(TriggeredStart::Started {
        run_id,
        run_status: outcome.run_status,
    })
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::Mutex;
    use std::task::{Context, Poll, Waker};

    use mnt_kernel_core::{ErrorKind, OrgId, TraceContext, UserId};
    use mnt_workflow_domain::{
        FinalizeWaitingTaskCommand, FinalizeWaitingTaskContext, FinalizedWaitingTask, NewRun,
        NodeStepCommit, PortFuture, PostFinalizationRejection, PostFinalizationRejectionCommand,
        RunRecord, TriggerType,
    };
    use serde_json::json;
    use time::OffsetDateTime;
    use uuid::Uuid;

    use super::*;

    struct ConflictPort {
        org: OrgId,
        idempotency_key: String,
        existing: RunRecord,
        persisted_definition: Value,
        transitions: Mutex<Vec<RunTransition>>,
        transition_audits: Mutex<Vec<mnt_kernel_core::AuditEvent>>,
        commits: Mutex<Vec<NodeStepCommit>>,
    }

    #[derive(Default)]
    struct InterleavingState {
        run: Option<RunRecord>,
        insert_count: usize,
        transition_call_count: usize,
        transition_commit_count: usize,
        node_call_count: usize,
        node_commit_count: usize,
        insert_audit_count: usize,
        transition_audit_count: usize,
        node_audit_count: usize,
        waiting_task_count: usize,
        committed_node_keys: HashSet<String>,
        release_creator_operation: bool,
        creator_waker: Option<Waker>,
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum RacePoint {
        None,
        Activation,
        ResumeTransitionRecovery,
        Drive,
        UnexplainedActivationConflict,
        UnexplainedDriveConflict,
    }

    /// Deterministically stages each production race without clocks or sleeps:
    ///
    /// 1. the creator commits the STARTING row and parks at the configured write;
    /// 2. a contender loses the insert, resumes the row, and wins that write;
    /// 3. the creator resumes and observes either the activation conflict or
    ///    the production node-commit no-op for a duplicate attempt.
    struct InterleavingPort {
        org: OrgId,
        definition_id: Uuid,
        schedule_id: Uuid,
        idempotency_key: String,
        persisted_definition: Value,
        race_point: RacePoint,
        state: Mutex<InterleavingState>,
    }

    impl WorkflowRuntimePort for ConflictPort {
        fn insert_run<'a>(
            &'a self,
            _run: NewRun,
            _audit: mnt_kernel_core::AuditEvent,
        ) -> PortFuture<'a, ()> {
            Box::pin(async { Err(KernelError::conflict("duplicate idempotency key")) })
        }

        fn load_run<'a>(&'a self, _org: OrgId, run_id: Uuid) -> PortFuture<'a, Option<RunRecord>> {
            Box::pin(async move { Ok((run_id == self.existing.id).then(|| self.existing.clone())) })
        }

        fn load_run_by_idempotency_key<'a>(
            &'a self,
            org: OrgId,
            idempotency_key: String,
        ) -> PortFuture<'a, Option<RunRecord>> {
            Box::pin(async move {
                Ok((org == self.org && idempotency_key == self.idempotency_key)
                    .then(|| self.existing.clone()))
            })
        }

        fn load_exec_definition_version<'a>(
            &'a self,
            org: OrgId,
            definition_id: Uuid,
            definition_version: i32,
        ) -> PortFuture<'a, Option<Value>> {
            Box::pin(async move {
                Ok((org == self.existing.org_id
                    && definition_id == self.existing.definition_id
                    && definition_version == self.existing.definition_version)
                    .then(|| self.persisted_definition.clone()))
            })
        }

        fn transition_run<'a>(
            &'a self,
            _org: OrgId,
            transition: RunTransition,
            audit: mnt_kernel_core::AuditEvent,
        ) -> PortFuture<'a, ()> {
            Box::pin(async move {
                self.transitions.lock().unwrap().push(transition);
                self.transition_audits.lock().unwrap().push(audit);
                Ok(())
            })
        }

        fn commit_node_step<'a>(
            &'a self,
            _org: OrgId,
            commit: NodeStepCommit,
        ) -> PortFuture<'a, ()> {
            Box::pin(async move {
                self.commits.lock().unwrap().push(commit);
                Ok(())
            })
        }

        fn load_finalize_waiting_task<'a>(
            &'a self,
            _org: OrgId,
            _task_id: Uuid,
        ) -> PortFuture<'a, Option<FinalizeWaitingTaskContext>> {
            Box::pin(async { Ok(None) })
        }

        fn finalize_waiting_task<'a>(
            &'a self,
            _org: OrgId,
            _command: FinalizeWaitingTaskCommand,
        ) -> PortFuture<'a, FinalizedWaitingTask> {
            Box::pin(async { Err(KernelError::internal("not implemented in test port")) })
        }

        fn create_post_finalization_rejection<'a>(
            &'a self,
            _org: OrgId,
            _command: PostFinalizationRejectionCommand,
        ) -> PortFuture<'a, PostFinalizationRejection> {
            Box::pin(async { Err(KernelError::internal("not implemented in test port")) })
        }
    }

    impl WorkflowRuntimePort for InterleavingPort {
        fn insert_run<'a>(
            &'a self,
            run: NewRun,
            _audit: mnt_kernel_core::AuditEvent,
        ) -> PortFuture<'a, ()> {
            Box::pin(async move {
                let mut state = self.state.lock().unwrap();
                if state.run.is_some() {
                    return Err(KernelError::conflict("duplicate idempotency key"));
                }
                state.run = Some(RunRecord {
                    id: run.id,
                    org_id: run.org_id,
                    status: RunStatus::Starting,
                    definition_id: run.definition_id,
                    definition_version: run.definition_version,
                    trigger_type: run.trigger_type,
                    object_type: run.object_type,
                    object_id: run.object_id,
                    correlation_id: run.correlation_id,
                    trace_id: run.trace_id,
                    input_payload: run.input_payload,
                    context_payload: run.context_payload,
                    initiated_by: run.initiated_by,
                    schedule_id: run.schedule_id,
                });
                state.insert_count += 1;
                state.insert_audit_count += 1;
                Ok(())
            })
        }

        fn load_run<'a>(&'a self, org: OrgId, run_id: Uuid) -> PortFuture<'a, Option<RunRecord>> {
            Box::pin(async move {
                let state = self.state.lock().unwrap();
                Ok(state
                    .run
                    .as_ref()
                    .filter(|run| run.org_id == org && run.id == run_id)
                    .cloned())
            })
        }

        fn load_run_by_idempotency_key<'a>(
            &'a self,
            org: OrgId,
            idempotency_key: String,
        ) -> PortFuture<'a, Option<RunRecord>> {
            Box::pin(async move {
                let state = self.state.lock().unwrap();
                Ok((org == self.org && idempotency_key == self.idempotency_key)
                    .then(|| state.run.clone())
                    .flatten())
            })
        }

        fn load_exec_definition_version<'a>(
            &'a self,
            org: OrgId,
            definition_id: Uuid,
            definition_version: i32,
        ) -> PortFuture<'a, Option<Value>> {
            Box::pin(async move {
                Ok((org == self.org
                    && definition_id == self.definition_id
                    && definition_version == 1)
                    .then(|| self.persisted_definition.clone()))
            })
        }

        fn transition_run<'a>(
            &'a self,
            _org: OrgId,
            transition: RunTransition,
            _audit: mnt_kernel_core::AuditEvent,
        ) -> PortFuture<'a, ()> {
            let call = {
                let mut state = self.state.lock().unwrap();
                let call = state.transition_call_count;
                state.transition_call_count += 1;
                call
            };

            if self.race_point == RacePoint::UnexplainedActivationConflict {
                return Box::pin(async {
                    Err(KernelError::conflict(
                        "workflow run transition reported conflict without phase advance",
                    ))
                });
            }

            let stages_transition_race = matches!(
                self.race_point,
                RacePoint::Activation | RacePoint::ResumeTransitionRecovery
            );
            if stages_transition_race && call == 0 {
                Box::pin(std::future::poll_fn(move |context| {
                    let mut state = self.state.lock().unwrap();
                    let current = state.run.as_ref().map(|run| run.status);
                    if !state.release_creator_operation {
                        state.creator_waker = Some(context.waker().clone());
                        return Poll::Pending;
                    }
                    if current != Some(transition.from) {
                        return Poll::Ready(Err(KernelError::conflict(
                            "workflow run transition lost status race",
                        )));
                    }
                    let run = state.run.as_mut().unwrap();
                    run.status = transition.to;
                    state.transition_commit_count += 1;
                    state.transition_audit_count += 1;
                    Poll::Ready(Ok(()))
                }))
            } else {
                Box::pin(async move {
                    let wake = {
                        let mut state = self.state.lock().unwrap();
                        let current = state.run.as_ref().map(|run| run.status);
                        if current != Some(transition.from) {
                            return Err(KernelError::conflict(
                                "workflow run transition lost status race",
                            ));
                        }
                        let run = state.run.as_mut().unwrap();
                        run.status = transition.to;
                        state.transition_commit_count += 1;
                        state.transition_audit_count += 1;
                        if stages_transition_race {
                            state.release_creator_operation = true;
                            state.creator_waker.take()
                        } else {
                            None
                        }
                    };
                    if let Some(waker) = wake {
                        waker.wake();
                    }
                    Ok(())
                })
            }
        }

        fn commit_node_step<'a>(
            &'a self,
            _org: OrgId,
            commit: NodeStepCommit,
        ) -> PortFuture<'a, ()> {
            let call = {
                let mut state = self.state.lock().unwrap();
                let call = state.node_call_count;
                state.node_call_count += 1;
                call
            };

            if self.race_point == RacePoint::UnexplainedDriveConflict {
                return Box::pin(async {
                    Err(KernelError::conflict(
                        "workflow node commit reported conflict without phase advance",
                    ))
                });
            }

            let commit_once = move |state: &mut InterleavingState| {
                // Production fidelity: the deterministic node INSERT owns all
                // side effects. A same-attempt loser observes the committed row
                // and returns success without replaying run/audit mutations.
                if !state
                    .committed_node_keys
                    .insert(commit.new_node.idempotency_key.clone())
                {
                    return Ok(());
                }
                if let Some(transition) = &commit.run_transition {
                    let current = state.run.as_ref().map(|run| run.status);
                    if current != Some(transition.from) {
                        return Err(KernelError::conflict(
                            "workflow run transition lost status race",
                        ));
                    }
                    state.run.as_mut().unwrap().status = transition.to;
                }
                state.node_commit_count += 1;
                state.node_audit_count += commit.audit_events.len();
                state.waiting_task_count += usize::from(commit.waiting_task.is_some());
                Ok(())
            };

            if self.race_point == RacePoint::Drive && call == 0 {
                Box::pin(std::future::poll_fn(move |context| {
                    let mut state = self.state.lock().unwrap();
                    if !state.release_creator_operation {
                        state.creator_waker = Some(context.waker().clone());
                        return Poll::Pending;
                    }
                    Poll::Ready(commit_once(&mut state))
                }))
            } else {
                Box::pin(async move {
                    let wake = {
                        let mut state = self.state.lock().unwrap();
                        commit_once(&mut state)?;
                        if self.race_point == RacePoint::Drive {
                            state.release_creator_operation = true;
                            state.creator_waker.take()
                        } else {
                            None
                        }
                    };
                    if let Some(waker) = wake {
                        waker.wake();
                    }
                    Ok(())
                })
            }
        }

        fn load_finalize_waiting_task<'a>(
            &'a self,
            _org: OrgId,
            _task_id: Uuid,
        ) -> PortFuture<'a, Option<FinalizeWaitingTaskContext>> {
            Box::pin(async { Ok(None) })
        }

        fn finalize_waiting_task<'a>(
            &'a self,
            _org: OrgId,
            _command: FinalizeWaitingTaskCommand,
        ) -> PortFuture<'a, FinalizedWaitingTask> {
            Box::pin(async { Err(KernelError::internal("not implemented in test port")) })
        }

        fn create_post_finalization_rejection<'a>(
            &'a self,
            _org: OrgId,
            _command: PostFinalizationRejectionCommand,
        ) -> PortFuture<'a, PostFinalizationRejection> {
            Box::pin(async { Err(KernelError::internal("not implemented in test port")) })
        }
    }

    impl IdempotentBoundRunPort for InterleavingPort {
        fn claim_bound_run<'a>(
            &'a self,
            run: NewBoundRun,
            _start_audit: mnt_kernel_core::AuditEvent,
            validate_definition: fn(&Value) -> Result<(), KernelError>,
        ) -> PortFuture<'a, Option<BoundRunClaim>> {
            Box::pin(async move {
                validate_definition(&self.persisted_definition)?;
                let mut state = self.state.lock().unwrap();
                if let Some(existing) = state.run.clone() {
                    return Ok(Some(BoundRunClaim::Existing {
                        run: existing,
                        definition: self.persisted_definition.clone(),
                    }));
                }
                let created = RunRecord {
                    id: run.id,
                    org_id: run.org_id,
                    status: RunStatus::Starting,
                    definition_id: run.definition_id,
                    definition_version: 1,
                    trigger_type: run.trigger_type,
                    object_type: run.object_type,
                    object_id: run.object_id,
                    correlation_id: run.correlation_id,
                    trace_id: Some(run.trace_id),
                    input_payload: run.input_payload,
                    context_payload: run.context_payload,
                    initiated_by: run.initiated_by,
                    schedule_id: run.schedule_id,
                };
                state.run = Some(created.clone());
                state.insert_count += 1;
                state.insert_audit_count += 1;
                Ok(Some(BoundRunClaim::Created {
                    run: created,
                    definition: self.persisted_definition.clone(),
                }))
            })
        }
    }

    fn conflict_port(status: RunStatus) -> ConflictPort {
        let org = OrgId::knl();
        let run_id = Uuid::new_v4();
        ConflictPort {
            org,
            idempotency_key: "trigger:test-binding:test-object".to_owned(),
            existing: RunRecord {
                id: run_id,
                org_id: org,
                status,
                definition_id: Uuid::new_v4(),
                definition_version: 1,
                trigger_type: TriggerType::ObjectEvent,
                object_type: Some("work_order".to_owned()),
                object_id: Some(Uuid::new_v4()),
                correlation_id: "trigger:test-object".to_owned(),
                trace_id: Some(TraceContext::generate().trace_id().to_owned()),
                input_payload: json!({}),
                context_payload: json!({}),
                initiated_by: None,
                schedule_id: None,
            },
            persisted_definition: json!({
                "schema_version": "wf.exec.v1",
                "nodes": [
                    { "node_key": "persisted_version_one", "node_type": "object_gate" }
                ],
                "edges": []
            }),
            transitions: Mutex::new(Vec::new()),
            transition_audits: Mutex::new(Vec::new()),
            commits: Mutex::new(Vec::new()),
        }
    }

    fn request(port: &ConflictPort) -> StartRunRequest {
        StartRunRequest {
            run_id: Uuid::new_v4(),
            org_id: port.org,
            definition_id: port.existing.definition_id,
            definition_version: port.existing.definition_version,
            trigger_type: TriggerType::ObjectEvent,
            object_type: port.existing.object_type.clone(),
            object_id: port.existing.object_id,
            idempotency_key: port.idempotency_key.clone(),
            correlation_id: "trigger:test-object".to_owned(),
            trace_id: None,
            input_payload: json!({}),
            context_payload: json!({}),
            initiated_by: None,
            schedule_id: None,
        }
    }

    fn interleaving_request(port: &InterleavingPort, run_id: Uuid) -> StartRunRequest {
        StartRunRequest {
            run_id,
            org_id: port.org,
            definition_id: port.definition_id,
            definition_version: 1,
            trigger_type: TriggerType::Schedule,
            object_type: None,
            object_id: None,
            idempotency_key: port.idempotency_key.clone(),
            correlation_id: "schedule:test-fire".to_owned(),
            trace_id: None,
            input_payload: json!({}),
            context_payload: json!({}),
            initiated_by: None,
            schedule_id: Some(port.schedule_id),
        }
    }

    fn idempotent_interleaving_request(
        port: &InterleavingPort,
        run_id: Uuid,
    ) -> StartIdempotentBoundRunRequest {
        StartIdempotentBoundRunRequest {
            run_id,
            org_id: port.org,
            definition_id: port.definition_id,
            trigger_type: TriggerType::Schedule,
            object_type: None,
            object_id: None,
            idempotency_key: port.idempotency_key.clone(),
            correlation_id: "schedule:test-fire".to_owned(),
            trace_id: None,
            input_payload: json!({}),
            context_payload: json!({}),
            initiated_by: None,
            schedule_id: Some(port.schedule_id),
        }
    }

    fn interleaving_port(race_point: RacePoint) -> InterleavingPort {
        InterleavingPort {
            org: OrgId::knl(),
            definition_id: Uuid::new_v4(),
            schedule_id: Uuid::new_v4(),
            idempotency_key: "schedule:test:fire".to_owned(),
            persisted_definition: definition(),
            race_point,
            state: Mutex::new(InterleavingState::default()),
        }
    }

    fn interleaving_port_with_starting_run() -> InterleavingPort {
        let port = interleaving_port(RacePoint::ResumeTransitionRecovery);
        let run_id = Uuid::new_v4();
        {
            let mut state = port.state.lock().unwrap();
            state.run = Some(RunRecord {
                id: run_id,
                org_id: port.org,
                status: RunStatus::Starting,
                definition_id: port.definition_id,
                definition_version: 1,
                trigger_type: TriggerType::Schedule,
                object_type: None,
                object_id: None,
                correlation_id: "schedule:test-fire".to_owned(),
                trace_id: Some(TraceContext::generate().trace_id().to_owned()),
                input_payload: json!({}),
                context_payload: json!({}),
                initiated_by: None,
                schedule_id: Some(port.schedule_id),
            });
            state.insert_count = 1;
            state.insert_audit_count = 1;
        }
        port
    }

    fn definition() -> serde_json::Value {
        json!({
            "schema_version": "wf.exec.v1",
            "nodes": [
                { "node_key": "gate", "node_type": "object_gate" }
            ],
            "edges": []
        })
    }

    fn waiting_definition() -> serde_json::Value {
        json!({
            "nodes": [
                {
                    "node_key": "approve",
                    "node_type": "human_task",
                    "title": "Approve",
                    "assignee_role_key": "approver"
                }
            ],
            "edges": []
        })
    }

    fn pass_through_definition() -> serde_json::Value {
        json!({
            "nodes": [
                { "node_key": "prepare", "node_type": "object_gate" },
                { "node_key": "finish", "node_type": "object_gate" }
            ],
            "edges": [
                { "from": "prepare", "to": "finish" }
            ]
        })
    }

    fn audit_context() -> AuditContext {
        AuditContext {
            actor: Some(UserId::new()),
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        }
    }

    fn block_on_ready<T>(future: impl Future<Output = T>) -> T {
        let mut context = Context::from_waker(Waker::noop());
        let mut future = Box::pin(future);
        match Pin::new(&mut future).poll(&mut context) {
            Poll::Ready(value) => value,
            Poll::Pending => panic!("test future unexpectedly pending"),
        }
    }

    #[test]
    fn conflicted_waiting_run_is_already_started_without_redrive() {
        let port = conflict_port(RunStatus::Waiting);

        let result = block_on_ready(start_bound_run(
            &port,
            request(&port),
            &definition(),
            &audit_context(),
        ))
        .unwrap();

        assert_eq!(result, TriggeredStart::AlreadyStarted);
        assert!(port.transitions.lock().unwrap().is_empty());
        assert!(port.commits.lock().unwrap().is_empty());
    }

    #[test]
    fn conflicted_starting_run_transitions_and_resumes_drive() {
        let port = conflict_port(RunStatus::Starting);

        let result = block_on_ready(start_bound_run(
            &port,
            request(&port),
            &definition(),
            &audit_context(),
        ))
        .unwrap();

        assert_eq!(result, TriggeredStart::AlreadyStarted);
        let transitions = port.transitions.lock().unwrap();
        assert_eq!(transitions.len(), 1);
        assert_eq!(transitions[0].from, RunStatus::Starting);
        assert_eq!(transitions[0].to, RunStatus::Running);
        let commits = port.commits.lock().unwrap();
        let run_transition = commits[0]
            .run_transition
            .as_ref()
            .expect("resumed drive closes the one-node graph");
        assert_eq!(run_transition.from, RunStatus::Running);
        assert_eq!(run_transition.to, RunStatus::Succeeded);
    }

    #[test]
    fn conflicted_run_recovers_persisted_version_after_active_version_drift() {
        let port = conflict_port(RunStatus::Running);
        let mut request = request(&port);
        request.definition_version += 1;
        let active_version_two = json!({
            "schema_version": "wf.exec.v1",
            "nodes": [
                { "node_key": "active_version_two", "node_type": "object_gate" }
            ],
            "edges": []
        });

        let result = block_on_ready(start_bound_run(
            &port,
            request,
            &active_version_two,
            &audit_context(),
        ))
        .expect("an idempotent retry must recover the persisted immutable version");

        assert_eq!(result, TriggeredStart::AlreadyStarted);
        assert!(port.transitions.lock().unwrap().is_empty());
        let commits = port.commits.lock().unwrap();
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].new_node.node_key, "persisted_version_one");
    }

    #[test]
    fn invalid_mutable_graph_cannot_gate_conflict_recovery() {
        let port = conflict_port(RunStatus::Running);
        let invalid_new_active = json!({
            "schema_version": "wf.exec.v1",
            "nodes": "not-an-executable-node-list",
            "edges": []
        });

        let result = block_on_ready(start_bound_run(
            &port,
            request(&port),
            &invalid_new_active,
            &audit_context(),
        ))
        .expect("the durable conflict must be resolved before parsing a mutable caller graph");

        assert_eq!(result, TriggeredStart::AlreadyStarted);
        let commits = port.commits.lock().unwrap();
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].new_node.node_key, "persisted_version_one");
    }

    #[test]
    fn bound_definition_requires_v1_executable_schema() {
        for definition in [
            json!({
                "nodes": [{ "node_key": "missing_schema", "node_type": "object_gate" }],
                "edges": []
            }),
            json!({
                "schema_version": "wf.exec.v2",
                "nodes": [{ "node_key": "wrong_schema", "node_type": "object_gate" }],
                "edges": []
            }),
        ] {
            assert!(
                validate_bound_definition(&definition).is_err(),
                "missing or incompatible executable schema must fail closed"
            );
        }
    }

    #[test]
    fn atomic_claim_crash_after_starting_recovers_on_next_claim() {
        let port = interleaving_port(RacePoint::None);
        let creator_audit = audit_context();
        let creator_request = idempotent_interleaving_request(&port, Uuid::new_v4());
        let claimed_run = NewBoundRun {
            id: creator_request.run_id,
            org_id: creator_request.org_id,
            definition_id: creator_request.definition_id,
            trigger_type: creator_request.trigger_type,
            object_type: creator_request.object_type.clone(),
            object_id: creator_request.object_id,
            idempotency_key: creator_request.idempotency_key.clone(),
            correlation_id: creator_request.correlation_id.clone(),
            trace_id: creator_audit.trace.trace_id().to_owned(),
            input_payload: creator_request.input_payload.clone(),
            context_payload: creator_request.context_payload.clone(),
            initiated_by: creator_request.initiated_by,
            schedule_id: creator_request.schedule_id,
        };
        let start_audit = run_audit_event(
            "workflow_run.start",
            &creator_audit,
            creator_request.run_id,
            creator_request.org_id,
            None,
            Some(json!({ "status": RunStatus::Starting.as_db_str() })),
        )
        .unwrap();

        let claim = block_on_ready(port.claim_bound_run(
            claimed_run,
            start_audit,
            validate_bound_definition,
        ))
        .unwrap()
        .expect("ACTIVE definition should be claimed");
        assert!(matches!(claim, BoundRunClaim::Created { .. }));
        // Simulate a process crash immediately after the atomic claim commit:
        // no activation or node drive occurred.
        assert_eq!(
            port.state.lock().unwrap().run.as_ref().unwrap().status,
            RunStatus::Starting
        );

        let retry = block_on_ready(start_idempotent_bound_run(
            &port,
            idempotent_interleaving_request(&port, Uuid::new_v4()),
            &audit_context(),
        ))
        .expect("the next atomic claimant must recover the durable STARTING run");
        assert_eq!(retry, TriggeredStart::AlreadyStarted);

        let state = port.state.lock().unwrap();
        assert_eq!(state.run.as_ref().unwrap().status, RunStatus::Succeeded);
        assert_eq!(state.insert_count, 1);
        assert_eq!(state.transition_commit_count, 1);
        assert_eq!(state.node_commit_count, 1);
        assert_eq!(state.insert_audit_count, 1);
        assert_eq!(state.transition_audit_count, 1);
        assert_eq!(state.node_audit_count, 1);
    }

    #[test]
    fn conflicted_run_recovery_uses_persisted_actor_and_trace_not_retry_caller() {
        let mut port = conflict_port(RunStatus::Starting);
        let persisted_actor = UserId::new();
        let persisted_trace = TraceContext::generate();
        port.existing.initiated_by = Some(persisted_actor);
        port.existing.trace_id = Some(persisted_trace.trace_id().to_owned());
        let retry_actor = UserId::new();
        assert_ne!(persisted_actor, retry_actor);
        let retry_trace = TraceContext::generate();
        assert_ne!(persisted_trace, retry_trace);
        let audit = AuditContext {
            actor: Some(retry_actor),
            trace: retry_trace,
            occurred_at: OffsetDateTime::now_utc(),
        };

        let mut retry_request = request(&port);
        retry_request.initiated_by = Some(retry_actor);
        let result =
            block_on_ready(start_bound_run(&port, retry_request, &definition(), &audit)).unwrap();

        assert_eq!(result, TriggeredStart::AlreadyStarted);
        let transition_audits = port.transition_audits.lock().unwrap();
        assert_eq!(transition_audits.len(), 1);
        assert_eq!(transition_audits[0].actor, Some(persisted_actor));
        assert_eq!(
            transition_audits[0].trace.trace_id(),
            persisted_trace.trace_id()
        );
        let commits = port.commits.lock().unwrap();
        assert_eq!(commits.len(), 1);
        assert!(
            commits[0]
                .audit_events
                .iter()
                .all(|event| event.actor == Some(persisted_actor)
                    && event.trace.trace_id() == persisted_trace.trace_id())
        );
    }

    #[test]
    fn conflicted_run_rejects_divergent_branch_context() {
        let port = conflict_port(RunStatus::Running);
        let mut request = request(&port);
        request.context_payload = json!({ "amount": 5000 });

        let err = block_on_ready(start_bound_run(
            &port,
            request,
            &definition(),
            &audit_context(),
        ))
        .expect_err("same run key must not resume with divergent branch facts");

        assert_eq!(err.kind, ErrorKind::Conflict);
        assert!(port.transitions.lock().unwrap().is_empty());
        assert!(port.commits.lock().unwrap().is_empty());
    }

    #[test]
    fn conflicted_run_rejects_definition_id_drift() {
        let port = conflict_port(RunStatus::Running);
        let mut request = request(&port);
        request.definition_id = Uuid::new_v4();

        let err = block_on_ready(start_bound_run(
            &port,
            request,
            &definition(),
            &audit_context(),
        ))
        .expect_err("same run key must not recover under another definition id");

        assert_eq!(err.kind, ErrorKind::Conflict);
        assert!(port.transitions.lock().unwrap().is_empty());
        assert!(port.commits.lock().unwrap().is_empty());
    }

    #[test]
    fn conflicted_run_rejects_correlation_identity_drift() {
        let port = conflict_port(RunStatus::Running);
        let mut request = request(&port);
        request.correlation_id = "trigger:different-event".to_owned();

        let err = block_on_ready(start_bound_run(
            &port,
            request,
            &definition(),
            &audit_context(),
        ))
        .expect_err("same run key must not recover with another correlation identity");

        assert_eq!(err.kind, ErrorKind::Conflict);
        assert!(port.transitions.lock().unwrap().is_empty());
        assert!(port.commits.lock().unwrap().is_empty());
    }

    #[test]
    fn conflicted_run_with_missing_or_malformed_trace_fails_closed() {
        for trace_id in [None, Some("not-a-valid-trace".to_owned())] {
            let mut port = conflict_port(RunStatus::Starting);
            port.existing.trace_id = trace_id;

            let err = block_on_ready(start_bound_run(
                &port,
                request(&port),
                &definition(),
                &audit_context(),
            ))
            .expect_err("recovery must not invent missing or malformed trace provenance");

            assert_eq!(err.kind, ErrorKind::Conflict);
            assert!(port.transitions.lock().unwrap().is_empty());
            assert!(port.commits.lock().unwrap().is_empty());
        }
    }

    #[test]
    fn conflicted_run_rejects_divergent_object_identity() {
        let port = conflict_port(RunStatus::Running);
        let mut request = request(&port);
        request.object_id = Some(Uuid::new_v4());

        let err = block_on_ready(start_bound_run(
            &port,
            request,
            &definition(),
            &audit_context(),
        ))
        .expect_err("same run key must not resume for another object");

        assert_eq!(err.kind, ErrorKind::Conflict);
        assert!(port.transitions.lock().unwrap().is_empty());
        assert!(port.commits.lock().unwrap().is_empty());
    }

    #[test]
    fn terminal_replays_are_already_started_without_writes() {
        for status in [
            RunStatus::Succeeded,
            RunStatus::Failed,
            RunStatus::Cancelled,
            RunStatus::DeadLettered,
        ] {
            let port = conflict_port(status);

            let result = block_on_ready(start_bound_run(
                &port,
                request(&port),
                &definition(),
                &audit_context(),
            ))
            .unwrap();

            assert_eq!(result, TriggeredStart::AlreadyStarted);
            assert!(port.transitions.lock().unwrap().is_empty());
            assert!(port.commits.lock().unwrap().is_empty());
        }
    }

    #[test]
    fn post_insert_conflict_without_phase_advance_fails_closed() {
        let port = interleaving_port(RacePoint::UnexplainedActivationConflict);
        let run_id = Uuid::new_v4();

        let error = block_on_ready(start_bound_run(
            &port,
            interleaving_request(&port, run_id),
            &definition(),
            &audit_context(),
        ))
        .expect_err("STARTING is not evidence that a contender advanced the owned run");

        assert_eq!(error.kind, ErrorKind::Conflict);
        let state = port.state.lock().unwrap();
        let run = state.run.as_ref().unwrap();
        assert_eq!(run.id, run_id);
        assert_eq!(run.status, RunStatus::Starting);
        assert_eq!(state.insert_count, 1);
        assert_eq!(state.transition_call_count, 1);
        assert_eq!(state.transition_commit_count, 0);
        assert_eq!(state.node_call_count, 0);
        assert_eq!(state.node_commit_count, 0);
        assert_eq!(state.insert_audit_count, 1);
        assert_eq!(state.transition_audit_count, 0);
        assert_eq!(state.node_audit_count, 0);
    }

    #[test]
    fn post_activation_drive_conflict_without_commit_evidence_fails_closed() {
        let port = interleaving_port(RacePoint::UnexplainedDriveConflict);
        let run_id = Uuid::new_v4();

        let error = block_on_ready(start_bound_run(
            &port,
            interleaving_request(&port, run_id),
            &definition(),
            &audit_context(),
        ))
        .expect_err("RUNNING alone is not evidence that a contender committed the entry node");

        assert_eq!(error.kind, ErrorKind::Conflict);
        let state = port.state.lock().unwrap();
        let run = state.run.as_ref().unwrap();
        assert_eq!(run.id, run_id);
        assert_eq!(run.status, RunStatus::Running);
        assert_eq!(state.insert_count, 1);
        assert_eq!(state.transition_call_count, 1);
        assert_eq!(state.transition_commit_count, 1);
        assert_eq!(state.node_call_count, 1);
        assert_eq!(state.node_commit_count, 0);
        assert_eq!(state.insert_audit_count, 1);
        assert_eq!(state.transition_audit_count, 1);
        assert_eq!(state.node_audit_count, 0);
    }

    #[test]
    fn transition_loser_recovers_running_run_when_winner_stops_before_drive() {
        let port = interleaving_port_with_starting_run();
        let definition = definition();
        let retry_audit = audit_context();
        let existing_run_id = port.state.lock().unwrap().run.as_ref().unwrap().id;
        let mut retry = Box::pin(start_bound_run(
            &port,
            interleaving_request(&port, Uuid::new_v4()),
            &definition,
            &retry_audit,
        ));

        // Retry loaded STARTING and is now parked on its transition. A distinct
        // recovery worker wins STARTING -> RUNNING and then stops before drive.
        let mut context = Context::from_waker(Waker::noop());
        assert!(matches!(retry.as_mut().poll(&mut context), Poll::Pending));
        let winner_audit = audit_context();
        let winner_transition = RunTransition {
            run_id: existing_run_id,
            from: RunStatus::Starting,
            to: RunStatus::Running,
            output_payload: None,
            error_payload: None,
        };
        let winner_transition_audit = run_audit_event(
            "workflow_run.transition",
            &winner_audit,
            existing_run_id,
            port.org,
            Some(json!({ "status": RunStatus::Starting.as_db_str() })),
            Some(json!({ "status": RunStatus::Running.as_db_str() })),
        )
        .unwrap();
        block_on_ready(port.transition_run(port.org, winner_transition, winner_transition_audit))
            .unwrap();

        // The losing retry must reload the exact advanced row and finish drive,
        // not report a skipped success that leaves RUNNING stranded.
        let result = match retry.as_mut().poll(&mut context) {
            Poll::Ready(result) => result,
            Poll::Pending => panic!("retry must resume after the winner transitions the run"),
        }
        .unwrap();
        assert_eq!(result, TriggeredStart::AlreadyStarted);

        let state = port.state.lock().unwrap();
        let run = state.run.as_ref().unwrap();
        assert_eq!(run.id, existing_run_id);
        assert_eq!(run.status, RunStatus::Succeeded);
        assert_eq!(state.insert_count, 1);
        assert_eq!(state.transition_call_count, 2);
        assert_eq!(state.transition_commit_count, 1);
        assert_eq!(state.node_call_count, 1);
        assert_eq!(state.node_commit_count, 1);
        assert_eq!(state.insert_audit_count, 1);
        assert_eq!(state.transition_audit_count, 1);
        assert_eq!(state.node_audit_count, 1);
    }

    #[test]
    fn successful_inserter_keeps_started_ownership_when_contender_wins_transition() {
        let port = interleaving_port(RacePoint::Activation);
        let creator_run_id = Uuid::new_v4();
        let contender_run_id = Uuid::new_v4();
        let definition = definition();
        let creator_audit = audit_context();
        let contender_audit = audit_context();
        let mut creator = Box::pin(start_bound_run(
            &port,
            interleaving_request(&port, creator_run_id),
            &definition,
            &creator_audit,
        ));

        let mut context = Context::from_waker(Waker::noop());
        assert!(matches!(creator.as_mut().poll(&mut context), Poll::Pending));

        let contender = block_on_ready(start_bound_run(
            &port,
            interleaving_request(&port, contender_run_id),
            &definition,
            &contender_audit,
        ))
        .unwrap();
        assert_eq!(contender, TriggeredStart::AlreadyStarted);

        let creator = match creator.as_mut().poll(&mut context) {
            Poll::Ready(result) => result,
            Poll::Pending => panic!("creator must resume after the contender transitions the run"),
        };
        assert_eq!(
            creator,
            Ok(TriggeredStart::Started {
                run_id: creator_run_id,
                run_status: RunStatus::Succeeded,
            })
        );

        let state = port.state.lock().unwrap();
        let run = state.run.as_ref().unwrap();
        assert_eq!(run.id, creator_run_id);
        assert_eq!(run.status, RunStatus::Succeeded);
        assert_eq!(state.insert_count, 1);
        assert_eq!(state.transition_call_count, 2);
        assert_eq!(state.transition_commit_count, 1);
        assert_eq!(state.node_call_count, 1);
        assert_eq!(state.node_commit_count, 1);
        assert_eq!(state.insert_audit_count, 1);
        assert_eq!(state.transition_audit_count, 1);
        assert_eq!(state.node_audit_count, 1);
    }

    #[test]
    fn atomic_claim_creator_keeps_started_when_retry_wins_activation() {
        let port = interleaving_port(RacePoint::Activation);
        let creator_run_id = Uuid::new_v4();
        let creator_audit = audit_context();
        let mut creator = Box::pin(start_idempotent_bound_run(
            &port,
            idempotent_interleaving_request(&port, creator_run_id),
            &creator_audit,
        ));
        let mut context = Context::from_waker(Waker::noop());
        assert!(matches!(creator.as_mut().poll(&mut context), Poll::Pending));

        let retry_audit = audit_context();
        let retry = block_on_ready(start_idempotent_bound_run(
            &port,
            idempotent_interleaving_request(&port, Uuid::new_v4()),
            &retry_audit,
        ))
        .unwrap();
        assert_eq!(retry, TriggeredStart::AlreadyStarted);

        let creator = match creator.as_mut().poll(&mut context) {
            Poll::Ready(result) => result.unwrap(),
            Poll::Pending => panic!("atomic creator must resume after retry activation"),
        };
        assert_eq!(
            creator,
            TriggeredStart::Started {
                run_id: creator_run_id,
                run_status: RunStatus::Succeeded,
            }
        );
        let state = port.state.lock().unwrap();
        assert_eq!(state.insert_count, 1);
        assert_eq!(state.transition_commit_count, 1);
        assert_eq!(state.node_commit_count, 1);
        assert_eq!(state.insert_audit_count, 1);
        assert_eq!(state.transition_audit_count, 1);
        assert_eq!(state.node_audit_count, 1);
    }

    #[test]
    fn atomic_claim_creator_keeps_started_when_retry_wins_drive() {
        let port = interleaving_port(RacePoint::Drive);
        let creator_run_id = Uuid::new_v4();
        let creator_audit = audit_context();
        let mut creator = Box::pin(start_idempotent_bound_run(
            &port,
            idempotent_interleaving_request(&port, creator_run_id),
            &creator_audit,
        ));
        let mut context = Context::from_waker(Waker::noop());
        assert!(matches!(creator.as_mut().poll(&mut context), Poll::Pending));

        let retry_audit = audit_context();
        let retry = block_on_ready(start_idempotent_bound_run(
            &port,
            idempotent_interleaving_request(&port, Uuid::new_v4()),
            &retry_audit,
        ))
        .unwrap();
        assert_eq!(retry, TriggeredStart::AlreadyStarted);

        let creator = match creator.as_mut().poll(&mut context) {
            Poll::Ready(result) => result.unwrap(),
            Poll::Pending => panic!("atomic creator must resume after retry drive"),
        };
        assert_eq!(
            creator,
            TriggeredStart::Started {
                run_id: creator_run_id,
                run_status: RunStatus::Succeeded,
            }
        );
        let state = port.state.lock().unwrap();
        assert_eq!(state.insert_count, 1);
        assert_eq!(state.transition_commit_count, 1);
        assert_eq!(state.node_call_count, 2);
        assert_eq!(state.node_commit_count, 1);
        assert_eq!(state.insert_audit_count, 1);
        assert_eq!(state.transition_audit_count, 1);
        assert_eq!(state.node_audit_count, 1);
    }

    fn assert_insert_owner_survives_drive_race(
        definition: serde_json::Value,
        expected_run_status: RunStatus,
        expected_node_count: usize,
        expected_waiting_task_count: usize,
    ) {
        let mut port = interleaving_port(RacePoint::Drive);
        // A conflict recovery must load the exact immutable graph bound to the
        // durable run. Keep the deterministic test adapter faithful to the
        // creator's version for each graph shape under test.
        port.persisted_definition = definition.clone();
        let creator_run_id = Uuid::new_v4();
        let contender_run_id = Uuid::new_v4();
        let creator_audit = audit_context();
        let contender_audit = audit_context();
        let mut creator = Box::pin(start_bound_run(
            &port,
            interleaving_request(&port, creator_run_id),
            &definition,
            &creator_audit,
        ));

        let mut context = Context::from_waker(Waker::noop());
        assert!(matches!(creator.as_mut().poll(&mut context), Poll::Pending));

        let contender = block_on_ready(start_bound_run(
            &port,
            interleaving_request(&port, contender_run_id),
            &definition,
            &contender_audit,
        ))
        .unwrap();
        assert_eq!(contender, TriggeredStart::AlreadyStarted);

        let creator = match creator.as_mut().poll(&mut context) {
            Poll::Ready(result) => result,
            Poll::Pending => panic!("creator must resume after the contender drives the run"),
        };
        assert_eq!(
            creator,
            Ok(TriggeredStart::Started {
                run_id: creator_run_id,
                run_status: expected_run_status,
            })
        );

        let state = port.state.lock().unwrap();
        let run = state.run.as_ref().unwrap();
        assert_eq!(run.id, creator_run_id);
        assert_eq!(run.status, expected_run_status);
        assert_eq!(state.insert_count, 1);
        assert_eq!(state.transition_call_count, 1);
        assert_eq!(state.transition_commit_count, 1);
        assert_eq!(state.node_call_count, expected_node_count * 2);
        assert_eq!(state.node_commit_count, expected_node_count);
        assert_eq!(state.committed_node_keys.len(), expected_node_count);
        assert_eq!(state.insert_audit_count, 1);
        assert_eq!(state.transition_audit_count, 1);
        assert_eq!(state.node_audit_count, expected_node_count);
        assert_eq!(state.waiting_task_count, expected_waiting_task_count);
    }

    #[test]
    fn successful_inserter_keeps_started_ownership_when_contender_wins_terminal_drive() {
        assert_insert_owner_survives_drive_race(definition(), RunStatus::Succeeded, 1, 0);
    }

    #[test]
    fn duplicate_waiting_drive_commits_one_node_task_and_audit() {
        assert_insert_owner_survives_drive_race(waiting_definition(), RunStatus::Waiting, 1, 1);
    }

    #[test]
    fn duplicate_running_pass_through_commits_each_node_and_audit_once() {
        assert_insert_owner_survives_drive_race(
            pass_through_definition(),
            RunStatus::Succeeded,
            2,
            0,
        );
    }
}
