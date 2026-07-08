//! Workflow-runtime domain.
//!
//! Pure state machines, value objects, and the DB-access port trait only.
//! Persistence, audit writes, SQL, and the async engine live in outer crates.
//!
//! Everything here maps 1:1 onto the ADR-0018 runtime spine (migrations
//! 0077/0078): the status enums are the exact `CHECK (... IN (...))` domains, and
//! the transition tables encode the legal FSM edges the engine may drive. Terminal
//! statuses carry the timestamp column the DB CHECK requires (`completed_at` /
//! `failed_at` for runs, `finished_at` for nodes), so the adapter always writes
//! the matching timestamp and never trips the constraint.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::future::Future;
use std::pin::Pin;

use mnt_kernel_core::{
    AuditEvent, KernelError, OrgId, Timestamp, Transition, TransitionError, UserId,
};

// ---------------------------------------------------------------------------
// Status enums — the exact 0077 CHECK domains.
// ---------------------------------------------------------------------------

macro_rules! spine_enum {
    (
        $(#[$enum_meta:meta])*
        pub enum $name:ident {
            $(
                $(#[$variant_meta:meta])*
                $variant:ident => $wire:literal
            ),+ $(,)?
        }
    ) => {
        $(#[$enum_meta])*
        #[derive(
            Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash,
            serde::Serialize, serde::Deserialize,
        )]
        #[serde(rename_all = "SCREAMING_SNAKE_CASE")]
        pub enum $name {
            $(
                $(#[$variant_meta])*
                $variant,
            )+
        }

        impl $name {
            /// Wire/DB spelling (matches the 0077 `CHECK (... IN (...))` values).
            #[must_use]
            pub const fn as_db_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $wire,)+
                }
            }

            /// Parse from the DB spelling, failing closed on any unknown value.
            pub fn from_db_str(value: &str) -> Result<Self, KernelError> {
                match value {
                    $($wire => Ok(Self::$variant),)+
                    other => Err(KernelError::validation(format!(
                        "unknown {} value {other:?}",
                        stringify!($name)
                    ))),
                }
            }
        }
    };
}

spine_enum! {
    /// `workflow_runs.status` (0077:15-16).
    pub enum RunStatus {
        Starting => "STARTING",
        Running => "RUNNING",
        Waiting => "WAITING",
        Succeeded => "SUCCEEDED",
        Failed => "FAILED",
        Cancelled => "CANCELLED",
        DeadLettered => "DEAD_LETTERED",
    }
}

spine_enum! {
    /// `workflow_node_runs.status` (0077:57-58).
    pub enum NodeStatus {
        Pending => "PENDING",
        Running => "RUNNING",
        Waiting => "WAITING",
        Succeeded => "SUCCEEDED",
        Failed => "FAILED",
        Skipped => "SKIPPED",
        Cancelled => "CANCELLED",
    }
}

spine_enum! {
    /// `workflow_waiting_tasks.status` (0077:86-87).
    pub enum WaitingTaskStatus {
        Open => "OPEN",
        Claimed => "CLAIMED",
        Approved => "APPROVED",
        Rejected => "REJECTED",
        Cancelled => "CANCELLED",
        Expired => "EXPIRED",
    }
}

spine_enum! {
    /// `workflow_outbox_events.status` (0077:136-137).
    pub enum OutboxStatus {
        Pending => "PENDING",
        InProgress => "IN_PROGRESS",
        Delivered => "DELIVERED",
        Failed => "FAILED",
        DeadLettered => "DEAD_LETTERED",
        Cancelled => "CANCELLED",
    }
}

spine_enum! {
    /// `workflow_outbox_events.channel` (0077:132-133).
    pub enum OutboxChannel {
        Notification => "NOTIFICATION",
        Mail => "MAIL",
        Messenger => "MESSENGER",
        Calendar => "CALENDAR",
        Poll => "POLL",
        Audit => "AUDIT",
        ObjectEvent => "OBJECT_EVENT",
        Webhook => "WEBHOOK",
        Job => "JOB",
    }
}

spine_enum! {
    /// `workflow_runs.trigger_type` (0077:17-18).
    pub enum TriggerType {
        Manual => "MANUAL",
        Schedule => "SCHEDULE",
        ObjectEvent => "OBJECT_EVENT",
        ImportEvent => "IMPORT_EVENT",
        MailEvent => "MAIL_EVENT",
        MessengerEvent => "MESSENGER_EVENT",
        CalendarEvent => "CALENDAR_EVENT",
        PollEvent => "POLL_EVENT",
        Api => "API",
    }
}

// ---------------------------------------------------------------------------
// Terminal-timestamp mapping — which column a terminal transition must stamp.
// ---------------------------------------------------------------------------

/// Which `workflow_runs` timestamp a terminal run status must stamp, per the
/// 0077 CHECKs (`completed_at` ⇔ SUCCEEDED/CANCELLED, `failed_at` ⇔
/// FAILED/DEAD_LETTERED). Non-terminal statuses stamp neither.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunTerminalTimestamp {
    /// `workflow_runs.completed_at` (0077:31,39).
    CompletedAt,
    /// `workflow_runs.failed_at` (0077:32,40).
    FailedAt,
}

impl RunStatus {
    /// A run status from which no further transition is legal.
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Cancelled | Self::DeadLettered
        )
    }

    /// The timestamp column a transition INTO this status must set so the 0077
    /// CHECK constraints accept the row. `None` for non-terminal statuses.
    #[must_use]
    pub const fn terminal_timestamp(self) -> Option<RunTerminalTimestamp> {
        match self {
            Self::Succeeded | Self::Cancelled => Some(RunTerminalTimestamp::CompletedAt),
            Self::Failed | Self::DeadLettered => Some(RunTerminalTimestamp::FailedAt),
            Self::Starting | Self::Running | Self::Waiting => None,
        }
    }
}

impl NodeStatus {
    /// A node status from which no further transition is legal. A terminal node
    /// must stamp `finished_at` (0077:64-65,71).
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Skipped | Self::Cancelled
        )
    }

    /// Whether a transition INTO this status must set `workflow_node_runs.finished_at`.
    #[must_use]
    pub const fn sets_finished_at(self) -> bool {
        self.is_terminal()
    }
}

// ---------------------------------------------------------------------------
// FSM transition tables + guards.
// ---------------------------------------------------------------------------

/// Legal `workflow_runs` FSM edges: STARTING→RUNNING→WAITING⇄RUNNING and any of
/// those to a terminal state.
pub const RUN_TRANSITIONS: &[(RunStatus, RunStatus)] = &[
    (RunStatus::Starting, RunStatus::Running),
    (RunStatus::Starting, RunStatus::Cancelled),
    (RunStatus::Starting, RunStatus::Failed),
    (RunStatus::Starting, RunStatus::DeadLettered),
    (RunStatus::Running, RunStatus::Waiting),
    (RunStatus::Running, RunStatus::Succeeded),
    (RunStatus::Running, RunStatus::Failed),
    (RunStatus::Running, RunStatus::Cancelled),
    (RunStatus::Running, RunStatus::DeadLettered),
    (RunStatus::Waiting, RunStatus::Running),
    (RunStatus::Waiting, RunStatus::Succeeded),
    (RunStatus::Waiting, RunStatus::Failed),
    (RunStatus::Waiting, RunStatus::Cancelled),
    (RunStatus::Waiting, RunStatus::DeadLettered),
];

/// Legal `workflow_node_runs` FSM edges: PENDING→RUNNING→WAITING⇄RUNNING and any
/// of those to a terminal state. No edge leaves a terminal node, so a finished
/// node can never be mutated backward.
pub const NODE_TRANSITIONS: &[(NodeStatus, NodeStatus)] = &[
    (NodeStatus::Pending, NodeStatus::Running),
    (NodeStatus::Pending, NodeStatus::Skipped),
    (NodeStatus::Pending, NodeStatus::Cancelled),
    (NodeStatus::Running, NodeStatus::Waiting),
    (NodeStatus::Running, NodeStatus::Succeeded),
    (NodeStatus::Running, NodeStatus::Failed),
    (NodeStatus::Running, NodeStatus::Skipped),
    (NodeStatus::Running, NodeStatus::Cancelled),
    (NodeStatus::Waiting, NodeStatus::Running),
    (NodeStatus::Waiting, NodeStatus::Succeeded),
    (NodeStatus::Waiting, NodeStatus::Failed),
    (NodeStatus::Waiting, NodeStatus::Cancelled),
];

/// Validate a `workflow_runs` status transition against the FSM table.
pub fn validate_run_transition(
    from: RunStatus,
    to: RunStatus,
) -> Result<Transition<RunStatus>, KernelError> {
    if RUN_TRANSITIONS.iter().any(|&(f, t)| f == from && t == to) {
        Ok(Transition { from, to })
    } else {
        Err(TransitionError { from, to }.into())
    }
}

/// Validate a `workflow_node_runs` status transition against the FSM table.
pub fn validate_node_transition(
    from: NodeStatus,
    to: NodeStatus,
) -> Result<Transition<NodeStatus>, KernelError> {
    if NODE_TRANSITIONS.iter().any(|&(f, t)| f == from && t == to) {
        Ok(Transition { from, to })
    } else {
        Err(TransitionError { from, to }.into())
    }
}

// ---------------------------------------------------------------------------
// Port trait + data-transfer structs.
// ---------------------------------------------------------------------------
//
// The port is the single seam through which the runtime engine touches the DB.
// It lives in the domain layer (like `CompletionEvidenceInterlock`) so both the
// application-style engine crate (`mnt-workflow-runtime`) and the Postgres
// adapter can depend on it without an illegal adapter→adapter edge, and so the
// engine stays free of sqlx/tokio. Every method is tenant-scoped: the adapter
// arms `app.current_org` (via `with_audit`/`with_audits`/`with_org_conn`) before
// any statement, and audited mutations write their `AuditEvent`(s) in the same
// transaction.

/// Boxed, `Send` future returned by every port method. Uses only `std` types so
/// the domain layer never depends on an async runtime.
pub type PortFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, KernelError>> + Send + 'a>>;

/// Row to INSERT into `workflow_runs` (status STARTING). The id is pre-generated
/// by the caller so deterministic idempotency/natural keys can be derived before
/// the row exists.
#[derive(Debug, Clone)]
pub struct NewRun {
    pub id: uuid::Uuid,
    pub org_id: OrgId,
    pub definition_id: uuid::Uuid,
    pub definition_version: i32,
    pub trigger_type: TriggerType,
    pub object_type: Option<String>,
    pub object_id: Option<uuid::Uuid>,
    pub idempotency_key: String,
    pub correlation_id: String,
    pub trace_id: Option<String>,
    pub input_payload: serde_json::Value,
    pub context_payload: serde_json::Value,
    pub initiated_by: Option<UserId>,
}

/// The subset of `workflow_runs` the engine needs to make advance decisions.
#[derive(Debug, Clone)]
pub struct RunRecord {
    pub id: uuid::Uuid,
    pub org_id: OrgId,
    pub status: RunStatus,
    pub definition_id: uuid::Uuid,
    pub definition_version: i32,
    pub object_type: Option<String>,
    pub object_id: Option<uuid::Uuid>,
}

/// A `workflow_runs` status change. The adapter stamps the terminal timestamp
/// implied by [`RunStatus::terminal_timestamp`] and guards on `from` for
/// optimistic concurrency.
#[derive(Debug, Clone)]
pub struct RunTransition {
    pub run_id: uuid::Uuid,
    pub from: RunStatus,
    pub to: RunStatus,
    pub output_payload: Option<serde_json::Value>,
    pub error_payload: Option<serde_json::Value>,
}

/// Row to INSERT into `workflow_node_runs` (status PENDING). The id is
/// pre-generated so the node's outbox emissions can key on it.
#[derive(Debug, Clone)]
pub struct NewNodeRun {
    pub id: uuid::Uuid,
    pub run_id: uuid::Uuid,
    pub node_key: String,
    pub node_type: String,
    pub attempt: i32,
    pub idempotency_key: String,
    pub input_payload: serde_json::Value,
}

/// Row to INSERT into `workflow_outbox_events` (status PENDING) — the
/// transactional-outbox side effect a node enqueues.
#[derive(Debug, Clone)]
pub struct OutboxEmission {
    pub node_run_id: Option<uuid::Uuid>,
    pub channel: OutboxChannel,
    pub destination_ref: Option<String>,
    pub idempotency_key: String,
    pub payload: serde_json::Value,
}

/// Row to INSERT into `workflow_waiting_tasks` (status OPEN) — a human/gate step
/// the run parks on.
#[derive(Debug, Clone)]
pub struct NewWaitingTask {
    pub run_id: uuid::Uuid,
    pub node_run_id: Option<uuid::Uuid>,
    pub waiting_key: String,
    pub title: String,
    pub assignee_role_key: Option<String>,
    pub required_policy: Option<String>,
    pub form_payload: serde_json::Value,
    pub due_at: Option<Timestamp>,
}

/// One atomic node-processing step. The adapter runs the whole thing inside a
/// single `with_audits` transaction so the node walk (PENDING→RUNNING→final), any
/// outbox emissions, an optional waiting task, an optional run transition, and the
/// audit rows all commit together or not at all.
#[derive(Debug, Clone)]
pub struct NodeStepCommit {
    pub new_node: NewNodeRun,
    /// Terminal/parked status the node lands after RUNNING (SUCCEEDED / WAITING /
    /// FAILED / SKIPPED / CANCELLED). Validated by the engine before commit.
    pub node_final_status: NodeStatus,
    pub node_output: Option<serde_json::Value>,
    pub node_error: Option<serde_json::Value>,
    pub emissions: Vec<OutboxEmission>,
    pub waiting_task: Option<NewWaitingTask>,
    pub run_transition: Option<RunTransition>,
    pub audit_events: Vec<AuditEvent>,
}

/// Server-loaded facts for a waiting task that is being finalized.
#[derive(Debug, Clone)]
pub struct FinalizeWaitingTaskContext {
    pub task_id: uuid::Uuid,
    pub run_id: uuid::Uuid,
    pub node_run_id: Option<uuid::Uuid>,
    pub waiting_key: String,
    pub task_status: WaitingTaskStatus,
    pub run_status: RunStatus,
    pub required_policy: Option<String>,
    pub object_type: Option<String>,
    pub object_id: Option<uuid::Uuid>,
    pub initiated_by: UserId,
}

/// Audited command to complete a finalization waiting task.
#[derive(Debug, Clone)]
pub struct FinalizeWaitingTaskCommand {
    pub task_id: uuid::Uuid,
    pub actor: UserId,
    pub idempotency_key: String,
    pub mode: String,
    pub delegated_reason: Option<String>,
    pub transition_audits: Vec<AuditEvent>,
}

/// Persisted result returned by the finalization completion port.
#[derive(Debug, Clone)]
pub struct FinalizedWaitingTask {
    pub task_id: uuid::Uuid,
    pub run_id: uuid::Uuid,
    pub status: WaitingTaskStatus,
    pub completed_by: Option<UserId>,
    pub decision_payload: serde_json::Value,
    pub run_status: RunStatus,
}

/// Audited command to create a compensating post-finalization rejection document.
#[derive(Debug, Clone)]
pub struct PostFinalizationRejectionCommand {
    pub original_run_id: uuid::Uuid,
    pub actor: UserId,
    pub reason: String,
    pub idempotency_key: String,
    pub transition_audits: Vec<AuditEvent>,
}

/// Persisted compensating document linked to the finalized original run.
#[derive(Debug, Clone)]
pub struct PostFinalizationRejection {
    pub id: uuid::Uuid,
    pub original_run_id: uuid::Uuid,
    pub reason: String,
    pub created_by: UserId,
    pub run_status: RunStatus,
}

/// All DB access the workflow runtime engine performs. Implemented once, by the
/// Postgres adapter. Object-safe (only `&self` + lifetime generics) so the engine
/// can hold it as `&dyn WorkflowRuntimePort`.
pub trait WorkflowRuntimePort: Send + Sync {
    /// INSERT one `workflow_runs` row (status STARTING) + its audit row.
    fn insert_run<'a>(&'a self, run: NewRun, audit: AuditEvent) -> PortFuture<'a, ()>;

    /// Read the run's advance-relevant fields, tenant-scoped. `None` if absent.
    fn load_run<'a>(&'a self, org: OrgId, run_id: uuid::Uuid) -> PortFuture<'a, Option<RunRecord>>;

    /// Apply a `workflow_runs` status transition + its audit row.
    fn transition_run<'a>(
        &'a self,
        org: OrgId,
        transition: RunTransition,
        audit: AuditEvent,
    ) -> PortFuture<'a, ()>;

    /// Run one atomic [`NodeStepCommit`] (node walk + emissions + waiting task +
    /// run transition + audit rows) in a single transaction.
    fn commit_node_step<'a>(&'a self, org: OrgId, commit: NodeStepCommit) -> PortFuture<'a, ()>;

    /// Load server facts needed to authorize and validate a finalize request.
    fn load_finalize_waiting_task<'a>(
        &'a self,
        org: OrgId,
        task_id: uuid::Uuid,
    ) -> PortFuture<'a, Option<FinalizeWaitingTaskContext>>;

    /// Complete a finalization waiting task and close the run when no receipt step
    /// remains in this slice. Implementations must audit the task mutation and any
    /// node/run transitions in the same transaction.
    fn finalize_waiting_task<'a>(
        &'a self,
        org: OrgId,
        command: FinalizeWaitingTaskCommand,
    ) -> PortFuture<'a, FinalizedWaitingTask>;

    /// Create a compensating rejection document for an already-finalized run.
    /// Implementations must not mutate the original terminal run.
    fn create_post_finalization_rejection<'a>(
        &'a self,
        org: OrgId,
        command: PostFinalizationRejectionCommand,
    ) -> PortFuture<'a, PostFinalizationRejection>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_status_roundtrips_db_spelling() {
        for status in [
            RunStatus::Starting,
            RunStatus::Running,
            RunStatus::Waiting,
            RunStatus::Succeeded,
            RunStatus::Failed,
            RunStatus::Cancelled,
            RunStatus::DeadLettered,
        ] {
            assert_eq!(RunStatus::from_db_str(status.as_db_str()).unwrap(), status);
        }
    }

    #[test]
    fn terminal_run_statuses_map_to_the_check_column() {
        assert_eq!(
            RunStatus::Succeeded.terminal_timestamp(),
            Some(RunTerminalTimestamp::CompletedAt)
        );
        assert_eq!(
            RunStatus::Cancelled.terminal_timestamp(),
            Some(RunTerminalTimestamp::CompletedAt)
        );
        assert_eq!(
            RunStatus::Failed.terminal_timestamp(),
            Some(RunTerminalTimestamp::FailedAt)
        );
        assert_eq!(
            RunStatus::DeadLettered.terminal_timestamp(),
            Some(RunTerminalTimestamp::FailedAt)
        );
        assert_eq!(RunStatus::Running.terminal_timestamp(), None);
    }

    #[test]
    fn legal_run_edges_pass_and_illegal_ones_fail() {
        assert!(validate_run_transition(RunStatus::Starting, RunStatus::Running).is_ok());
        assert!(validate_run_transition(RunStatus::Running, RunStatus::Waiting).is_ok());
        assert!(validate_run_transition(RunStatus::Waiting, RunStatus::Running).is_ok());
        // No edge leaves a terminal state, and STARTING may not skip to WAITING.
        assert!(validate_run_transition(RunStatus::Succeeded, RunStatus::Running).is_err());
        assert!(validate_run_transition(RunStatus::Starting, RunStatus::Waiting).is_err());
    }

    #[test]
    fn finalized_runs_are_terminal_and_non_reopenable() {
        assert!(validate_run_transition(RunStatus::Waiting, RunStatus::Succeeded).is_ok());
        for reopen_target in [
            RunStatus::Starting,
            RunStatus::Running,
            RunStatus::Waiting,
            RunStatus::Failed,
            RunStatus::Cancelled,
            RunStatus::DeadLettered,
        ] {
            assert!(
                validate_run_transition(RunStatus::Succeeded, reopen_target).is_err(),
                "SUCCEEDED must not reopen to {reopen_target:?}"
            );
        }
    }

    #[test]
    fn node_terminal_states_have_no_outgoing_edges() {
        for terminal in [
            NodeStatus::Succeeded,
            NodeStatus::Failed,
            NodeStatus::Skipped,
            NodeStatus::Cancelled,
        ] {
            assert!(terminal.is_terminal());
            assert!(
                !NODE_TRANSITIONS.iter().any(|&(f, _)| f == terminal),
                "terminal node {terminal:?} must not be a transition source"
            );
        }
        assert!(validate_node_transition(NodeStatus::Pending, NodeStatus::Running).is_ok());
        assert!(validate_node_transition(NodeStatus::Running, NodeStatus::Succeeded).is_ok());
        assert!(validate_node_transition(NodeStatus::Succeeded, NodeStatus::Running).is_err());
    }
}
