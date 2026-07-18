//! System-triggered run starts (BE-AUTO slice 1).
//!
//! One shared entry for every NON-human run producer — the domain-event
//! trigger-binding dispatcher and the cron schedule poller — so both start a
//! run exactly the way the REST `POST /api/v1/workflow-runs` path does
//! (`start_run` → synchronous [`drive_from`] until the first WAITING task or a
//! terminal node) without duplicating the walk. Pure over the domain port: no
//! sqlx here; callers resolve the published definition JSON themselves.
//!
//! ## Exactly-once
//! The caller supplies a DETERMINISTIC `idempotency_key` (e.g.
//! `trigger:{binding_id}:{object_id}` or `schedule:{schedule_id}:{fire_unix}`).
//! The run spine's `UNIQUE(org_id, idempotency_key)` assigns start ownership to
//! the caller that commits the STARTING row. A concurrent loser may resume the
//! run after a crash window, but remains `AlreadyStarted`. If it wins activation,
//! the insert owner reconciles the exact advanced run; if both drive the same
//! node, the adapter's deterministic node insert makes the losing commit an
//! side-effect-free no-op. The successful run inserter is therefore still the sole
//! `Started` result without duplicate durable run, node, or audit effects.
//! Recovery proceeds only when the persisted definition, trigger provenance,
//! object, input, context, and schedule identity all match the retry.
//!
//! ## Authorization
//! A system start carries NO per-request principal: the authority is the
//! audited AUTHORING act (creating/enabling the binding or schedule required
//! the workflow-manage feature), matching how the m2 completion reconciler
//! re-drives with an empty guard set. Every write is still fully audited (actor
//! `None` ⇒ system) through the port's own `with_audit(s)` transactions.

use mnt_kernel_core::{ErrorKind, KernelError};
use mnt_workflow_domain::{RunStatus, RunTransition, WorkflowRuntimePort};
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
}

#[derive(Debug, Clone)]
struct RequestedRunIdentity {
    definition_id: uuid::Uuid,
    definition_version: i32,
    trigger_type: mnt_workflow_domain::TriggerType,
    object_type: Option<String>,
    object_id: Option<uuid::Uuid>,
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
    let graph = ExecGraph::parse(definition)?;
    let entry = graph.entry_node_key()?.to_owned();
    let org = request.org_id;
    let requested_identity = RequestedRunIdentity {
        definition_id: request.definition_id,
        definition_version: request.definition_version,
        trigger_type: request.trigger_type,
        object_type: request.object_type.clone(),
        object_id: request.object_id,
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
            resume_conflicted_run(
                port,
                org,
                idempotency_key,
                &requested_identity,
                &graph,
                &entry,
                &context,
                audit,
            )
            .await
        }
        Err(err) => Err(err),
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
    validate_resume_identity(&existing, org, Some(run_id), requested_identity)?;
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
    graph: &ExecGraph,
    entry: &str,
    context: &Value,
    audit: &AuditContext,
) -> Result<TriggeredStart, KernelError> {
    let Some(existing) = port
        .load_run_by_idempotency_key(org, idempotency_key)
        .await?
    else {
        return Err(KernelError::conflict(
            "workflow run idempotency conflict but existing run was not found",
        ));
    };

    validate_resume_identity(&existing, org, None, requested_identity)?;

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
                audit,
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
                    )?;
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
            let _ = drive_existing_running(port, org, existing.id, graph, entry, context, audit)
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
) -> Result<(), KernelError> {
    if existing.org_id != org || expected_run_id.is_some_and(|run_id| existing.id != run_id) {
        return Err(KernelError::conflict(
            "workflow run conflict resolved to a different persisted run",
        ));
    }
    if existing.definition_id != requested_identity.definition_id
        || existing.definition_version != requested_identity.definition_version
    {
        return Err(KernelError::conflict(
            "workflow run idempotency conflict belongs to a different definition version",
        ));
    }
    if existing.trigger_type != requested_identity.trigger_type
        || existing.object_type != requested_identity.object_type
        || existing.object_id != requested_identity.object_id
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
        transitions: Mutex<Vec<RunTransition>>,
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

        fn transition_run<'a>(
            &'a self,
            _org: OrgId,
            transition: RunTransition,
            _audit: mnt_kernel_core::AuditEvent,
        ) -> PortFuture<'a, ()> {
            Box::pin(async move {
                self.transitions.lock().unwrap().push(transition);
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
                    input_payload: run.input_payload,
                    context_payload: run.context_payload,
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
                input_payload: json!({}),
                context_payload: json!({}),
                schedule_id: None,
            },
            transitions: Mutex::new(Vec::new()),
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

    fn interleaving_port(race_point: RacePoint) -> InterleavingPort {
        InterleavingPort {
            org: OrgId::knl(),
            definition_id: Uuid::new_v4(),
            schedule_id: Uuid::new_v4(),
            idempotency_key: "schedule:test:fire".to_owned(),
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
                input_payload: json!({}),
                context_payload: json!({}),
                schedule_id: Some(port.schedule_id),
            });
            state.insert_count = 1;
            state.insert_audit_count = 1;
        }
        port
    }

    fn definition() -> serde_json::Value {
        json!({
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
    fn conflicted_run_rejects_definition_drift() {
        let port = conflict_port(RunStatus::Running);
        let mut request = request(&port);
        request.definition_version += 1;

        let err = block_on_ready(start_bound_run(
            &port,
            request,
            &definition(),
            &audit_context(),
        ))
        .expect_err("existing run must not be resumed with a different definition version");

        assert_eq!(err.kind, ErrorKind::Conflict);
        assert!(port.transitions.lock().unwrap().is_empty());
        assert!(port.commits.lock().unwrap().is_empty());
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

    fn assert_insert_owner_survives_drive_race(
        definition: serde_json::Value,
        expected_run_status: RunStatus,
        expected_node_count: usize,
        expected_waiting_task_count: usize,
    ) {
        let port = interleaving_port(RacePoint::Drive);
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
