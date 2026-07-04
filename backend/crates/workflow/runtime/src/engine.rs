//! FSM-driven advance logic.
//!
//! Walks a run/node through the domain transition tables ([`validate_run_transition`],
//! [`validate_node_transition`]) and commits each step through the
//! [`WorkflowRuntimePort`]. Sync-in-request advance up to the first WAITING/terminal
//! node; the port arms `app.current_org` and writes audit rows in the same
//! transaction as each mutation.

use mnt_kernel_core::{AuditAction, AuditEvent, KernelError, OrgId, Timestamp, TraceContext, UserId};
use mnt_workflow_domain::{
    NewNodeRun, NewRun, NodeStatus, NodeStepCommit, RunStatus, RunTransition, TriggerType,
    WorkflowRuntimePort, validate_node_transition, validate_run_transition,
};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::idempotency::node_attempt_key;
use crate::interpreter::{NodeOutcome, NodeSpec, interpret_node};

/// Per-request audit metadata threaded onto every emitted [`AuditEvent`].
#[derive(Debug, Clone)]
pub struct AuditContext {
    /// `None` for a system-initiated advance (background worker).
    pub actor: Option<UserId>,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

/// Inputs to start (and immediately activate) a new run. `run_id` is pre-generated
/// so the run/node/outbox idempotency keys can be derived before the row exists.
#[derive(Debug, Clone)]
pub struct StartRunRequest {
    pub run_id: Uuid,
    pub org_id: OrgId,
    pub definition_id: Uuid,
    pub definition_version: i32,
    pub trigger_type: TriggerType,
    pub object_type: Option<String>,
    pub object_id: Option<Uuid>,
    pub idempotency_key: String,
    pub correlation_id: String,
    pub trace_id: Option<String>,
    pub input_payload: Value,
    pub context_payload: Value,
    pub initiated_by: Option<UserId>,
}

/// Inputs to process one node atomically.
#[derive(Debug, Clone)]
pub struct ProcessNodeRequest {
    pub org_id: OrgId,
    pub run_id: Uuid,
    /// Pre-generated node id so emission keys can reference it.
    pub node_run_id: Uuid,
    /// The run's current status, used to validate the run transition below.
    pub current_run_status: RunStatus,
    /// Where the run should sit after this node (RUNNING to keep advancing, WAITING
    /// to park, or a terminal status). Equal to `current_run_status` ⇒ no run
    /// transition is written.
    pub run_target: RunStatus,
    pub spec: NodeSpec,
    pub attempt: i32,
    pub input_payload: Value,
}

/// The statuses the run/node landed after a processed node.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NodeStepOutcome {
    pub node_final_status: NodeStatus,
    pub run_status: RunStatus,
}

/// Start a run: INSERT `workflow_runs` STARTING, then advance STARTING→RUNNING.
/// Both writes are audited by the port. Returns the run id.
pub async fn start_run<P: WorkflowRuntimePort + ?Sized>(
    port: &P,
    request: StartRunRequest,
    audit: &AuditContext,
) -> Result<Uuid, KernelError> {
    // A run is born STARTING and immediately advances to RUNNING; validate the
    // edge up front so an illegal FSM table never reaches the DB.
    validate_run_transition(RunStatus::Starting, RunStatus::Running)?;

    let run_id = request.run_id;
    let org = request.org_id;
    let new_run = NewRun {
        id: run_id,
        org_id: org,
        definition_id: request.definition_id,
        definition_version: request.definition_version,
        trigger_type: request.trigger_type,
        object_type: request.object_type,
        object_id: request.object_id,
        idempotency_key: request.idempotency_key,
        correlation_id: request.correlation_id,
        trace_id: request.trace_id,
        input_payload: request.input_payload,
        context_payload: request.context_payload,
        initiated_by: request.initiated_by,
    };

    let insert_audit = run_audit_event(
        "workflow_run.start",
        audit,
        run_id,
        org,
        None,
        Some(json!({ "status": RunStatus::Starting.as_db_str() })),
    )?;
    port.insert_run(new_run, insert_audit).await?;

    let transition = RunTransition {
        run_id,
        from: RunStatus::Starting,
        to: RunStatus::Running,
        output_payload: None,
        error_payload: None,
    };
    let transition_audit = run_audit_event(
        "workflow_run.transition",
        audit,
        run_id,
        org,
        Some(json!({ "status": RunStatus::Starting.as_db_str() })),
        Some(json!({ "status": RunStatus::Running.as_db_str() })),
    )?;
    port.transition_run(org, transition, transition_audit).await?;

    Ok(run_id)
}

/// Process one node atomically: interpret it, validate the node walk
/// (PENDING→RUNNING→final) and the run transition against the FSM tables, then
/// commit the whole step (node + emissions + optional waiting task + optional run
/// transition + audit) in a single port transaction.
pub async fn process_node<P: WorkflowRuntimePort + ?Sized>(
    port: &P,
    request: ProcessNodeRequest,
    audit: &AuditContext,
) -> Result<NodeStepOutcome, KernelError> {
    let outcome = interpret_node(
        &request.spec,
        request.run_id,
        request.node_run_id,
        &request.input_payload,
    );
    let node_final_status = outcome.node_status();

    // Node walk: PENDING → RUNNING → final. Reject an illegal landing state.
    validate_node_transition(NodeStatus::Pending, NodeStatus::Running)?;
    validate_node_transition(NodeStatus::Running, node_final_status)?;

    // Run transition (skip when the run stays put).
    let run_transition = if request.run_target == request.current_run_status {
        None
    } else {
        validate_run_transition(request.current_run_status, request.run_target)?;
        Some(RunTransition {
            run_id: request.run_id,
            from: request.current_run_status,
            to: request.run_target,
            output_payload: None,
            error_payload: None,
        })
    };

    let (node_output, node_error, emissions, waiting_task) = match outcome {
        NodeOutcome::Succeeded { output, emissions } => (Some(output), None, emissions, None),
        NodeOutcome::Waiting { task } => (None, None, Vec::new(), Some(task)),
        NodeOutcome::Failed { error } => (None, Some(error), Vec::new(), None),
    };

    let new_node = NewNodeRun {
        id: request.node_run_id,
        run_id: request.run_id,
        node_key: request.spec.node_key.clone(),
        node_type: request.spec.node_type.clone(),
        attempt: request.attempt,
        idempotency_key: node_attempt_key(request.run_id, &request.spec.node_key, request.attempt),
        input_payload: request.input_payload,
    };

    let node_audit = node_audit_event(
        "workflow_node.commit",
        audit,
        request.node_run_id,
        request.org_id,
        node_final_status,
    )?;

    let commit = NodeStepCommit {
        new_node,
        node_final_status,
        node_output,
        node_error,
        emissions,
        waiting_task,
        run_transition,
        audit_events: vec![node_audit],
    };
    port.commit_node_step(request.org_id, commit).await?;

    Ok(NodeStepOutcome {
        node_final_status,
        run_status: request.run_target,
    })
}

fn run_audit_event(
    action: &str,
    audit: &AuditContext,
    run_id: Uuid,
    org: OrgId,
    before: Option<Value>,
    after: Option<Value>,
) -> Result<AuditEvent, KernelError> {
    Ok(AuditEvent::new(
        audit.actor,
        AuditAction::new(action)?,
        "workflow_run",
        run_id.to_string(),
        audit.trace.clone(),
        audit.occurred_at,
    )
    .with_org(org)
    .with_snapshots(before, after))
}

fn node_audit_event(
    action: &str,
    audit: &AuditContext,
    node_run_id: Uuid,
    org: OrgId,
    final_status: NodeStatus,
) -> Result<AuditEvent, KernelError> {
    Ok(AuditEvent::new(
        audit.actor,
        AuditAction::new(action)?,
        "workflow_node_run",
        node_run_id.to_string(),
        audit.trace.clone(),
        audit.occurred_at,
    )
    .with_org(org)
    .with_snapshots(
        Some(json!({ "status": NodeStatus::Pending.as_db_str() })),
        Some(json!({ "status": final_status.as_db_str() })),
    ))
}
