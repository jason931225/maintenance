//! Notice-board application contracts.
//!
//! Adapters implement these use-case shapes. A notice moves draft ->
//! published; publishing is the only mutation an author's draft-write port
//! doesn't cover — it is gated separately (publish-tier authz) at the REST
//! layer and fans out one notification per snapshotted recipient.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use mnt_kernel_core::{
    AuditAction, AuditEvent, KernelError, NoticeId, Timestamp, TraceContext, UserId,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateDraftNoticeCommand {
    pub author: UserId,
    pub title: String,
    pub body: String,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishNoticeCommand {
    pub notice_id: NoticeId,
    pub publisher: UserId,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GetNoticeQuery {
    pub notice_id: NoticeId,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ListNoticesQuery {
    /// Drafts are visible only to publish-tier callers; REST resolves this
    /// from the principal's feature grant before the query reaches the store.
    pub include_drafts: bool,
    pub limit: i64,
}

/// 수령확인 (receipt acknowledgment): a recipient confirms they have seen a
/// published notice. Owner-scoped like notifications — the recipient is
/// always bound from the authenticated principal, never from request input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcknowledgeNoticeCommand {
    pub notice_id: NoticeId,
    pub recipient: UserId,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NoticeProgressQuery {
    pub notice_id: NoticeId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoticeSummary {
    pub id: NoticeId,
    pub code: Option<String>,
    pub author_user_id: UserId,
    pub title: String,
    pub body: String,
    pub status: String,
    #[serde(with = "time::serde::rfc3339::option")]
    pub published_at: Option<Timestamp>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: Timestamp,
}

/// 수령확인 progress (done/total), matching the console board's generic
/// progress-bar contract (see `docs/design/oyatie-console` TODO 2026-07-08).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoticeProgress {
    pub total: i64,
    pub acknowledged: i64,
}

/// Build the audit event for a notice mutation.
pub fn notice_audit_event(
    action: &str,
    actor: Option<UserId>,
    target_id: impl ToString,
    trace: TraceContext,
    occurred_at: Timestamp,
) -> Result<AuditEvent, KernelError> {
    Ok(AuditEvent::new(
        actor,
        AuditAction::new(action)?,
        "notice",
        target_id.to_string(),
        trace,
        occurred_at,
    ))
}
