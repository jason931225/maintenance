//! Messenger application contracts.
//!
//! Adapters implement these use-case shapes. Realtime is represented only as a
//! post-commit notification port carrying IDs, per ADR-0007.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::future::Future;
use std::pin::Pin;

use mnt_kernel_core::{
    AuditAction, AuditEvent, BranchId, BranchScope, EvidenceId, KernelError, MessageId, ThreadId,
    Timestamp, TraceContext, UserId, WorkOrderId,
};
use mnt_messenger_domain::ThreadKind;
use serde::{Deserialize, Serialize};

pub type MessageNotifyFuture<'a> = Pin<Box<dyn Future<Output = ()> + Send + 'a>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessagePostedNotification {
    pub message_id: MessageId,
    pub thread_id: ThreadId,
    pub branch_id: BranchId,
}

pub trait MessageNotifier: Send + Sync {
    fn message_posted(&self, notification: MessagePostedNotification) -> MessageNotifyFuture<'_>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateThreadCommand {
    pub actor: UserId,
    pub branch_scope: BranchScope,
    pub branch_id: BranchId,
    pub kind: ThreadKind,
    pub title: Option<String>,
    pub work_order_id: Option<WorkOrderId>,
    pub member_ids: Vec<UserId>,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnsureWorkOrderThreadCommand {
    pub actor: UserId,
    pub branch_id: BranchId,
    pub work_order_id: WorkOrderId,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SendMessageCommand {
    pub actor: UserId,
    pub branch_scope: BranchScope,
    pub thread_id: ThreadId,
    pub body: String,
    pub attachment_evidence_ids: Vec<EvidenceId>,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MarkThreadReadCommand {
    pub actor: UserId,
    pub branch_scope: BranchScope,
    pub thread_id: ThreadId,
    pub last_read_message_id: MessageId,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListThreadsQuery {
    pub actor: UserId,
    pub branch_scope: BranchScope,
    pub limit: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessagePageQuery {
    pub actor: UserId,
    pub branch_scope: BranchScope,
    pub thread_id: ThreadId,
    pub before_message_id: Option<MessageId>,
    pub limit: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchMessagesQuery {
    pub actor: UserId,
    pub branch_scope: BranchScope,
    pub query: String,
    pub limit: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadSummary {
    pub id: ThreadId,
    pub kind: ThreadKind,
    pub branch_id: BranchId,
    pub title: Option<String>,
    pub work_order_id: Option<WorkOrderId>,
    pub last_message_id: Option<MessageId>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub last_message_at: Option<Timestamp>,
    pub member_count: i64,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: Timestamp,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageSummary {
    pub id: MessageId,
    pub thread_id: ThreadId,
    pub branch_id: BranchId,
    pub sender_id: UserId,
    pub body: String,
    pub attachment_evidence_ids: Vec<EvidenceId>,
    #[serde(with = "time::serde::rfc3339")]
    pub sent_at: Timestamp,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessagePage {
    pub items: Vec<MessageSummary>,
    pub next_cursor: Option<MessageId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadReceiptSummary {
    pub thread_id: ThreadId,
    pub user_id: UserId,
    pub last_read_message_id: MessageId,
    pub read_at: Timestamp,
    pub updated_at: Timestamp,
}

pub fn messenger_audit_event(
    action: &str,
    actor: UserId,
    branch_id: BranchId,
    target_type: &str,
    target_id: impl ToString,
    trace: TraceContext,
    occurred_at: Timestamp,
) -> Result<AuditEvent, KernelError> {
    Ok(AuditEvent::new(
        Some(actor),
        AuditAction::new(action)?,
        target_type,
        target_id.to_string(),
        trace,
        occurred_at,
    )
    .with_branch(branch_id))
}
