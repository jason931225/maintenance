//! `wf.exec.v1` graph walker + run driver.
//!
//! The strangler completion tail hard-codes its two nodes ([`crate::completion`]);
//! the generalized instance REST (`POST /api/v1/workflow-runs`, task `decide`
//! advance) instead walks the definition's `nodes`/`edges` graph. This module
//! parses a `wf.exec.v1` definition into typed [`NodeSpec`]s and drives a run
//! forward through [`process_node`] until it parks on the first human task or
//! reaches a terminal node — the exact synchronous-until-WAITING semantics the
//! spike's instance surface requires.
//!
//! Linear approval lines (submit → review → approve → finalize → receipt) are the
//! only shape the builder emits today, so the walk follows a single outgoing edge
//! per node. Branching/parallel graphs are a later charter.
//!
//! ## Condition node kind — deferred to BE-AUTO slice 2 (deliberate)
//! A `condition` node is only meaningful with ≥2 outgoing edges selected by a
//! predicate — but this walker's invariants are single-outgoing-edge
//! ([`ExecGraph::next_node_key`] returns THE successor) and terminal-node =
//! no-successor (run → SUCCEEDED). Admitting a `condition` node_type without
//! the branching walk would create a kind that parses but cannot branch — a
//! facade, worse than absence. Branching additionally needs the run's
//! input/context payload threaded through [`drive_from`] (predicates evaluate
//! against it; today each node gets an empty input) and a SKIPPED-marking pass
//! for the untaken branch so the FSM's node bookkeeping stays complete. That
//! is the slice-2 unit of work; the trigger/schedule substrate (slice 1) does
//! not depend on it.

use mnt_kernel_core::{AuditEvent, KernelError, OrgId};
use mnt_workflow_domain::{RunStatus, WorkflowRuntimePort};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::engine::{AuditContext, ProcessNodeRequest, process_node};
use crate::interpreter::{NodeKind, NodeSpec};

/// A parsed `wf.exec.v1` node graph: the typed node specs plus their directed
/// edges. Built once per run drive from the published definition JSON.
#[derive(Debug, Clone)]
pub struct ExecGraph {
    nodes: Vec<NodeSpec>,
    edges: Vec<(String, String)>,
}

impl ExecGraph {
    /// Parse a `wf.exec.v1` definition value. Fails (validation) when the graph has
    /// no `nodes` array — e.g. the strangler completion template, which carries no
    /// node graph and is driven by its own hard-coded tail instead.
    pub fn parse(definition: &Value) -> Result<Self, KernelError> {
        let raw_nodes = definition
            .get("nodes")
            .and_then(Value::as_array)
            .filter(|nodes| !nodes.is_empty())
            .ok_or_else(|| {
                KernelError::validation("workflow definition has no executable node graph")
            })?;

        let mut nodes = Vec::with_capacity(raw_nodes.len());
        for node in raw_nodes {
            nodes.push(parse_node(node)?);
        }

        let edges = definition
            .get("edges")
            .and_then(Value::as_array)
            .map(|edges| {
                edges
                    .iter()
                    .filter_map(|edge| {
                        let from = edge.get("from").and_then(Value::as_str)?;
                        let to = edge.get("to").and_then(Value::as_str)?;
                        Some((from.to_owned(), to.to_owned()))
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok(Self { nodes, edges })
    }

    /// The graph's entry node key: the single node that is no edge's target. Fails
    /// closed when zero or more than one candidate exists (an ill-formed graph).
    pub fn entry_node_key(&self) -> Result<&str, KernelError> {
        let mut entries = self
            .nodes
            .iter()
            .map(|node| node.node_key.as_str())
            .filter(|key| !self.edges.iter().any(|(_, to)| to == key));
        let first = entries
            .next()
            .ok_or_else(|| KernelError::validation("workflow graph has no entry node"))?;
        if entries.next().is_some() {
            return Err(KernelError::validation(
                "workflow graph has more than one entry node",
            ));
        }
        Ok(first)
    }

    /// The node spec for `key`, if present.
    #[must_use]
    pub fn node_spec(&self, key: &str) -> Option<&NodeSpec> {
        self.nodes.iter().find(|node| node.node_key == key)
    }

    /// The single node following `from` along its outgoing edge, if any.
    #[must_use]
    pub fn next_node_key(&self, from: &str) -> Option<&str> {
        self.edges
            .iter()
            .find(|(edge_from, _)| edge_from == from)
            .map(|(_, to)| to.as_str())
    }
}

fn parse_node(node: &Value) -> Result<NodeSpec, KernelError> {
    let node_key = node
        .get("node_key")
        .and_then(Value::as_str)
        .ok_or_else(|| KernelError::validation("workflow node missing node_key"))?
        .to_owned();
    let node_type = node
        .get("node_type")
        .and_then(Value::as_str)
        .ok_or_else(|| KernelError::validation("workflow node missing node_type"))?
        .to_owned();

    let kind = match node_type.as_str() {
        "object_gate" => NodeKind::ObjectGate,
        "object_mutation" => NodeKind::ObjectMutation,
        "human_task" | "waiting_task" => NodeKind::HumanTask {
            title: node
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or(node_key.as_str())
                .to_owned(),
            required_policy: node
                .get("required_policy")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            assignee_role_key: node
                .get("assignee_role_key")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
        },
        "job" => NodeKind::Job {
            connector: node
                .get("connector")
                .and_then(Value::as_str)
                .ok_or_else(|| KernelError::validation("workflow job node missing connector"))?
                .to_owned(),
            job: node
                .get("job")
                .and_then(Value::as_str)
                .ok_or_else(|| KernelError::validation("workflow job node missing job"))?
                .to_owned(),
            emits_status: node
                .get("emits_status")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
        },
        other => {
            return Err(KernelError::validation(format!(
                "unsupported workflow node_type {other:?}"
            )));
        }
    };

    Ok(NodeSpec {
        node_key,
        node_type,
        kind,
    })
}

/// Where a [`drive_from`] walk stopped.
#[derive(Debug, Clone)]
pub struct DriveOutcome {
    /// The run status after the walk (WAITING when parked on a human task,
    /// SUCCEEDED when it reached a terminal node).
    pub run_status: RunStatus,
    /// The node/waiting key the run parked on, when it parked on a human task.
    pub parked_task_key: Option<String>,
}

/// Drive a RUNNING/WAITING run forward from `start_key`: process each node through
/// the FSM engine, following the single outgoing edge, until it parks on a human
/// task (run → WAITING) or reaches a node with no successor (run → SUCCEEDED).
///
/// `first_node_guard_audits` carries the per-request Cedar/PBAC shadow the caller
/// produced for the *entry* transition (design §D); it rides only the first node's
/// atomic `with_audits` commit. Pass-through gate/mutation/job nodes advance the run
/// without an extra guard here (jobs are worker-driven system nodes).
#[allow(clippy::too_many_arguments)]
pub async fn drive_from<P: WorkflowRuntimePort + ?Sized>(
    port: &P,
    org: OrgId,
    run_id: Uuid,
    mut current_status: RunStatus,
    graph: &ExecGraph,
    start_key: &str,
    first_node_guard_audits: Vec<AuditEvent>,
    audit: &AuditContext,
) -> Result<DriveOutcome, KernelError> {
    let mut node_key = start_key.to_owned();
    let mut guard_audits = first_node_guard_audits;

    loop {
        let spec = graph
            .node_spec(&node_key)
            .ok_or_else(|| {
                KernelError::validation(format!("workflow graph has no node {node_key:?}"))
            })?
            .clone();
        let is_human = matches!(spec.kind, NodeKind::HumanTask { .. });
        let next = graph.next_node_key(&node_key).map(ToOwned::to_owned);

        let run_target = if is_human {
            RunStatus::Waiting
        } else if next.is_some() {
            RunStatus::Running
        } else {
            RunStatus::Succeeded
        };

        process_node(
            port,
            ProcessNodeRequest {
                org_id: org,
                run_id,
                node_run_id: Uuid::new_v4(),
                current_run_status: current_status,
                run_target,
                spec,
                attempt: 1,
                input_payload: json!({}),
                guard_audits: std::mem::take(&mut guard_audits),
            },
            audit,
        )
        .await?;
        current_status = run_target;

        if is_human {
            return Ok(DriveOutcome {
                run_status: RunStatus::Waiting,
                parked_task_key: Some(node_key),
            });
        }

        match next {
            Some(next_key) => node_key = next_key,
            None => {
                return Ok(DriveOutcome {
                    run_status: RunStatus::Succeeded,
                    parked_task_key: None,
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approval_graph() -> Value {
        json!({
            "schema_version": "wf.exec.v1",
            "nodes": [
                {"node_key": "submit", "node_type": "object_gate"},
                {"node_key": "review.hr", "node_type": "human_task",
                 "assignee_role_key": "hr_reviewer", "required_policy": "approval_review"},
                {"node_key": "approve.manager", "node_type": "human_task",
                 "assignee_role_key": "manager_approver", "required_policy": "approval_decide"}
            ],
            "edges": [
                {"from": "submit", "to": "review.hr"},
                {"from": "review.hr", "to": "approve.manager"}
            ]
        })
    }

    #[test]
    fn entry_node_is_the_untargeted_node() {
        let graph = ExecGraph::parse(&approval_graph()).unwrap();
        assert_eq!(graph.entry_node_key().unwrap(), "submit");
    }

    #[test]
    fn next_node_follows_the_single_edge() {
        let graph = ExecGraph::parse(&approval_graph()).unwrap();
        assert_eq!(graph.next_node_key("submit"), Some("review.hr"));
        assert_eq!(graph.next_node_key("review.hr"), Some("approve.manager"));
        assert_eq!(graph.next_node_key("approve.manager"), None);
    }

    #[test]
    fn human_node_parses_role_and_policy() {
        let graph = ExecGraph::parse(&approval_graph()).unwrap();
        let spec = graph.node_spec("review.hr").unwrap();
        match &spec.kind {
            NodeKind::HumanTask {
                assignee_role_key,
                required_policy,
                ..
            } => {
                assert_eq!(assignee_role_key.as_deref(), Some("hr_reviewer"));
                assert_eq!(required_policy.as_deref(), Some("approval_review"));
            }
            other => panic!("expected human task, got {other:?}"),
        }
    }

    #[test]
    fn no_node_graph_fails_closed() {
        let completion =
            json!({"schema_version": "wf.exec.v1", "template": "work_order_completion"});
        assert!(ExecGraph::parse(&completion).is_err());
    }
}
