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
//! The run spine's `UNIQUE(org_id, idempotency_key)` turns a concurrent double
//! dispatch/poll into a Conflict, which this module reports as
//! [`TriggeredStart::AlreadyStarted`] — a benign skip, never a duplicate run.
//!
//! ## Authorization
//! A system start carries NO per-request principal: the authority is the
//! audited AUTHORING act (creating/enabling the binding or schedule required
//! the workflow-manage feature), matching how the m2 completion reconciler
//! re-drives with an empty guard set. Every write is still fully audited (actor
//! `None` ⇒ system) through the port's own `with_audit(s)` transactions.

use mnt_kernel_core::{ErrorKind, KernelError};
use mnt_workflow_domain::{RunStatus, WorkflowRuntimePort};
use serde_json::Value;

use crate::engine::{AuditContext, StartRunRequest, start_run};
use crate::graph::{ExecGraph, drive_from};

/// How a system-triggered start landed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TriggeredStart {
    /// A fresh run was created and driven to its first WAITING task or a
    /// terminal node.
    Started {
        run_id: uuid::Uuid,
        run_status: RunStatus,
    },
    /// A run under the same deterministic idempotency key already exists — the
    /// event/fire was already handled (possibly by a concurrent dispatcher).
    AlreadyStarted,
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

    match start_run(port, request, audit).await {
        Ok(run_id) => {
            let outcome = drive_from(
                port,
                org,
                run_id,
                RunStatus::Running,
                &graph,
                &entry,
                Vec::new(),
                audit,
            )
            .await?;
            Ok(TriggeredStart::Started {
                run_id,
                run_status: outcome.run_status,
            })
        }
        // UNIQUE(org_id, idempotency_key): this fire/event was already started.
        Err(err) if err.kind == ErrorKind::Conflict => Ok(TriggeredStart::AlreadyStarted),
        Err(err) => Err(err),
    }
}
