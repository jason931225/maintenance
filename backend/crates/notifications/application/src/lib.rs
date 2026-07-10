//! Notifications application contracts.
//!
//! Adapters implement these use-case shapes. Two ports live here:
//!   * [`NotificationSink`] — the WRITE port other domains call to emit a
//!     notification. Producers depend on this trait, never on the Postgres
//!     adapter, so the dependency arrow points inward.
//!   * [`NotificationNotifier`] — the post-commit realtime port carrying only
//!     IDs, per ADR-0007. The Postgres/realtime layer implements it; the store
//!     calls it after the row is durably committed.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::future::Future;
use std::pin::Pin;

use mnt_kernel_core::{
    AuditAction, AuditEvent, KernelError, NotificationId, Timestamp, TraceContext, UserId,
};
use mnt_notifications_domain::NotificationLink;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Realtime notifier port (post-commit, IDs only)
// ---------------------------------------------------------------------------

pub type NotificationNotifyFuture<'a> = Pin<Box<dyn Future<Output = ()> + Send + 'a>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotificationCreatedNotification {
    pub notification_id: NotificationId,
    pub recipient_user_id: UserId,
}

pub trait NotificationNotifier: Send + Sync {
    fn notification_created(
        &self,
        notification: NotificationCreatedNotification,
    ) -> NotificationNotifyFuture<'_>;
}

// ---------------------------------------------------------------------------
// Write port other domains call to emit notifications
// ---------------------------------------------------------------------------

pub type EmitNotificationFuture<'a> =
    Pin<Box<dyn Future<Output = Result<NotificationSummary, KernelError>> + Send + 'a>>;

/// The write port. A producer (e.g. the workflow compensation drain) holds an
/// `Arc<dyn NotificationSink>` and calls [`NotificationSink::emit`] to create a
/// recipient-scoped notification row. `emit` is idempotent-friendly: producers
/// that need at-most-once delivery pass a stable `dedup_key`.
pub trait NotificationSink: Send + Sync {
    fn emit(&self, command: EmitNotificationCommand) -> EmitNotificationFuture<'_>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmitNotificationCommand {
    /// The user whose action caused the notification, recorded on the audit
    /// event. `None` for system-emitted notifications (e.g. a scheduled job).
    pub actor: Option<UserId>,
    pub recipient: UserId,
    pub category: String,
    pub text: String,
    pub link: NotificationLink,
    /// Optional stable key for at-most-once emission. When set, a second emit
    /// with the same `(recipient, dedup_key)` is a no-op returning the existing
    /// row, so an at-least-once outbox drain never doubles a notification.
    pub dedup_key: Option<String>,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

// ---------------------------------------------------------------------------
// Recipient-scoped read/mutation shapes
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListNotificationsQuery {
    /// Bound from the authenticated principal, never from request input.
    pub recipient: UserId,
    pub unread_only: bool,
    /// Keyset cursor: return rows strictly older than this notification.
    pub before_id: Option<NotificationId>,
    pub limit: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnreadNotificationCountQuery {
    /// Bound from the authenticated principal, never from request input.
    pub recipient: UserId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkNotificationReadCommand {
    pub recipient: UserId,
    pub notification_id: NotificationId,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkAllNotificationsReadCommand {
    pub recipient: UserId,
    pub trace: TraceContext,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotificationSummary {
    pub id: NotificationId,
    pub recipient_user_id: UserId,
    pub category: String,
    /// Recipient-facing text (the `notifs.text` field in the logic inventory;
    /// stored in the `body` column).
    pub text: String,
    pub link: NotificationLink,
    pub unread: bool,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: Timestamp,
    #[serde(with = "time::serde::rfc3339::option")]
    pub read_at: Option<Timestamp>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotificationPage {
    pub items: Vec<NotificationSummary>,
    /// Cursor for the next page (oldest id on this page); `None` at the end.
    pub next_cursor: Option<NotificationId>,
}

/// Build the audit event for a recipient self-action or a producer emission.
/// `target_id` is the notification id (or the recipient id for the batch
/// read-all action, which has no single target).
pub fn notification_audit_event(
    action: &str,
    actor: Option<UserId>,
    target_id: impl ToString,
    trace: TraceContext,
    occurred_at: Timestamp,
) -> Result<AuditEvent, KernelError> {
    Ok(AuditEvent::new(
        actor,
        AuditAction::new(action)?,
        "notification",
        target_id.to_string(),
        trace,
        occurred_at,
    ))
}
