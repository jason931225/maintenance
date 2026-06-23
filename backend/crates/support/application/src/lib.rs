//! Support-ticket application layer: commands, query DTOs, read models, audit
//! event builders, and the notification port.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use mnt_kernel_core::{
    AuditAction, AuditEvent, BranchId, BranchScope, KernelError, SupportTicketCommentId,
    SupportTicketId, Timestamp, TraceContext, UserId,
};
use mnt_support_domain::{TicketCategory, TicketOrigin, TicketPriority, TicketStatus};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Open a ticket as an authenticated staff member. The ticket inherits the
/// requester's branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateInternalTicketCommand {
    pub actor: UserId,
    pub branch_id: BranchId,
    pub category: TicketCategory,
    pub priority: TicketPriority,
    pub title: String,
    pub body: String,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

/// Open a ticket from the unauthenticated customer intake channel. There is no
/// actor and no branch; the customer supplies a name and contact (PII).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateCustomerIntakeCommand {
    pub category: TicketCategory,
    pub priority: TicketPriority,
    pub title: String,
    pub body: String,
    pub requester_name: String,
    /// Customer contact PII (phone/email). Never logged; never audited.
    pub requester_contact: String,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

/// Assign (or reassign) a ticket to a staff member and triage a branch-less
/// customer ticket into a branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssignTicketCommand {
    pub actor: UserId,
    pub ticket_id: SupportTicketId,
    pub assignee_user_id: UserId,
    /// Branch to triage a branch-less customer ticket into. Required when the
    /// ticket has no branch yet; ignored once a ticket already carries a branch.
    pub branch_id: Option<BranchId>,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

/// Drive the status FSM.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransitionTicketCommand {
    pub actor: UserId,
    pub ticket_id: SupportTicketId,
    pub to_status: TicketStatus,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

/// Append a comment. `is_internal_note` marks a staff-only note that the
/// customer-visible read path never returns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AddCommentCommand {
    pub actor: UserId,
    pub ticket_id: SupportTicketId,
    pub body: String,
    pub is_internal_note: bool,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/// Branch-scoped list with optional filters. SUPER_ADMIN/EXECUTIVE resolve to
/// `BranchScope::All` for cross-branch rollups (like reporting).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListTicketsQuery {
    pub branch_scope: BranchScope,
    pub status: Option<TicketStatus>,
    pub priority: Option<TicketPriority>,
    pub category: Option<TicketCategory>,
    pub origin: Option<TicketOrigin>,
    pub assignee_user_id: Option<UserId>,
    /// Include branch-less (untriaged customer) tickets in the result. Only
    /// honoured for `BranchScope::All` principals; branch-scoped staff never see
    /// untriaged cross-org intake.
    pub include_untriaged: bool,
    /// Page size. `None` falls back to the adapter default; the adapter always
    /// clamps to `1..=100` so an unbounded fetch is impossible even when the
    /// client sends no limit.
    pub limit: Option<i64>,
    /// Keyset cursor: return only tickets ordered strictly after this id on the
    /// `(created_at DESC, id)` ordering. `None` starts from the first page.
    /// Mirrors the messenger keyset-pagination pattern.
    pub cursor: Option<SupportTicketId>,
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TicketSummary {
    pub id: SupportTicketId,
    pub branch_id: Option<BranchId>,
    pub origin: TicketOrigin,
    pub category: TicketCategory,
    pub priority: TicketPriority,
    pub status: TicketStatus,
    pub title: String,
    pub requester_user_id: Option<UserId>,
    pub requester_name: Option<String>,
    pub assignee_user_id: Option<UserId>,
    /// Assignee display name, resolved via a same-org LEFT JOIN on `users`.
    /// `None` for an unassigned ticket or a deleted assignee; the web renders
    /// it through `safeLabel` so a missing name never leaks the UUID.
    pub assignee_name: Option<String>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub due_at: Option<Timestamp>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: Timestamp,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: Timestamp,
    #[serde(with = "time::serde::rfc3339::option")]
    pub resolved_at: Option<Timestamp>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub closed_at: Option<Timestamp>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommentView {
    pub id: SupportTicketCommentId,
    pub ticket_id: SupportTicketId,
    pub author_user_id: Option<UserId>,
    /// Author display name, resolved via a same-org LEFT JOIN on `users`. `None`
    /// for a system/customer comment with no author or a deleted author; the web
    /// renders it through `safeLabel` so a missing name never leaks the UUID.
    pub author_name: Option<String>,
    pub body: String,
    pub is_internal_note: bool,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TicketDetail {
    pub ticket: TicketSummary,
    pub comments: Vec<CommentView>,
}

/// One keyset page of tickets plus the unpaged `total` matching the same
/// filters, so the console can show an honest count while still paging via the
/// cursor. `next_cursor` is the id to pass as `cursor` for the next page, or
/// `None` when this is the last page. Mirrors `MessagePage`, with `total` added.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TicketPage {
    pub items: Vec<TicketSummary>,
    pub next_cursor: Option<SupportTicketId>,
    pub total: i64,
}

/// Audience filter for [`TicketDetail`] reads. The customer-visible path drops
/// internal staff notes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CommentAudience {
    /// Staff: all comments, including internal notes.
    Internal,
    /// Customer-visible: internal notes are excluded.
    CustomerVisible,
}

impl CommentAudience {
    /// Whether a comment with the given `is_internal_note` flag is visible to
    /// this audience.
    #[must_use]
    pub const fn shows_internal_notes(self) -> bool {
        matches!(self, Self::Internal)
    }
}

// ---------------------------------------------------------------------------
// Notification port
// ---------------------------------------------------------------------------

/// Why a notification is being raised.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TicketNotificationKind {
    /// A ticket was (re)assigned — notify the new assignee.
    Assigned,
    /// The status changed — notify the requester (if internal) and the assignee.
    StatusChanged,
    /// A new customer-visible comment landed — notify requester and assignee.
    Commented,
}

impl TicketNotificationKind {
    #[must_use]
    pub const fn title(self) -> &'static str {
        match self {
            Self::Assigned => "Support ticket assigned",
            Self::StatusChanged => "Support ticket updated",
            Self::Commented => "New support ticket reply",
        }
    }

    #[must_use]
    pub const fn data_kind(self) -> &'static str {
        match self {
            Self::Assigned => "support_ticket_assigned",
            Self::StatusChanged => "support_ticket_status",
            Self::Commented => "support_ticket_comment",
        }
    }
}

/// A single notification to deliver. Recipients are staff users (push tokens
/// resolved by the adapter); external customers are notified through other
/// channels out of scope here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TicketNotification {
    pub ticket_id: SupportTicketId,
    pub recipient: UserId,
    pub kind: TicketNotificationKind,
    pub body: String,
}

impl TicketNotification {
    #[must_use]
    pub fn new(
        ticket_id: SupportTicketId,
        recipient: UserId,
        kind: TicketNotificationKind,
        body: impl Into<String>,
    ) -> Self {
        Self {
            ticket_id,
            recipient,
            kind,
            body: body.into(),
        }
    }
}

// ---------------------------------------------------------------------------
// Audit builder
// ---------------------------------------------------------------------------

/// Build a support audit event. `branch_id` is optional because customer-intake
/// tickets are branch-less until triaged (`with_branch` is only attached when a
/// branch is known). The PII contact is never placed in snapshots by callers.
pub fn support_audit_event(
    action: &str,
    actor: Option<UserId>,
    branch_id: Option<BranchId>,
    target_type: &str,
    target_id: impl ToString,
    trace: TraceContext,
    occurred_at: Timestamp,
) -> Result<AuditEvent, KernelError> {
    let mut event = AuditEvent::new(
        actor,
        AuditAction::new(action)?,
        target_type,
        target_id.to_string(),
        trace,
        occurred_at,
    );
    if let Some(branch_id) = branch_id {
        event = event.with_branch(branch_id);
    }
    Ok(event)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn customer_visible_audience_hides_internal_notes() {
        assert!(!CommentAudience::CustomerVisible.shows_internal_notes());
        assert!(CommentAudience::Internal.shows_internal_notes());
    }

    #[test]
    fn audit_event_without_branch_is_org_global() {
        let event = support_audit_event(
            "support.ticket.create_customer",
            None,
            None,
            "support_ticket",
            SupportTicketId::new(),
            TraceContext::generate(),
            Timestamp::now_utc(),
        )
        .unwrap();
        assert!(event.branch_id.is_none());
        assert!(event.actor.is_none());
    }

    #[test]
    fn audit_event_with_branch_carries_scope() {
        let branch = BranchId::new();
        let event = support_audit_event(
            "support.ticket.create_internal",
            Some(UserId::new()),
            Some(branch),
            "support_ticket",
            SupportTicketId::new(),
            TraceContext::generate(),
            Timestamp::now_utc(),
        )
        .unwrap();
        assert_eq!(event.branch_id, Some(branch));
    }
}
