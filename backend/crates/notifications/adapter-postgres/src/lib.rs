//! Postgres notifications adapter.
//!
//! Recipient scoping is enforced here in code (there is no per-person GUC): the
//! caller passes the authenticated principal's `UserId`, and every query
//! filters `recipient_user_id`. RLS narrows to the tenant on top of that. A
//! cross-user read or read-mark therefore returns *nothing* (or NotFound),
//! never another user's row.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::sync::Arc;

use mnt_kernel_core::{ErrorKind, KernelError, NotificationId, UserId};
use mnt_notifications_application::{
    EmitNotificationCommand, EmitNotificationFuture, ListNotificationsQuery,
    MarkAllNotificationsReadCommand, MarkNotificationReadCommand, NotificationCreatedNotification,
    NotificationNotifier, NotificationPage, NotificationSink, NotificationSummary,
    UnreadNotificationCountQuery, notification_audit_event,
};
use mnt_notifications_domain::{NotificationBody, NotificationCategory, NotificationLink};
use mnt_platform_db::{DbError, with_audit, with_org_conn};
use mnt_platform_request_context::current_org;
use sqlx::{PgPool, Postgres, QueryBuilder, Row};

#[derive(Debug, thiserror::Error)]
pub enum PgNotificationError {
    #[error(transparent)]
    Db(#[from] DbError),

    #[error(transparent)]
    Domain(#[from] KernelError),

    /// Internal sentinel: a `dedup_key` INSERT lost the race to a concurrent
    /// emit. Never surfaced to callers — `emit_notification` catches it and
    /// returns the already-committed row.
    #[error("notification dedup conflict")]
    Dedup,
}

impl PgNotificationError {
    #[must_use]
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::Domain(err) => err.kind,
            Self::Db(DbError::Sqlx(sqlx::Error::RowNotFound)) => ErrorKind::NotFound,
            Self::Dedup | Self::Db(_) => ErrorKind::Internal,
        }
    }
}

impl From<sqlx::Error> for PgNotificationError {
    fn from(value: sqlx::Error) -> Self {
        Self::Db(DbError::Sqlx(value))
    }
}

impl From<PgNotificationError> for KernelError {
    fn from(value: PgNotificationError) -> Self {
        match value {
            PgNotificationError::Domain(err) => err,
            PgNotificationError::Dedup => {
                KernelError::internal("notification dedup conflict escaped emit")
            }
            PgNotificationError::Db(err) => KernelError::internal(err.to_string()),
        }
    }
}

#[derive(Clone)]
pub struct PgNotificationStore {
    pool: PgPool,
    notifier: Option<Arc<dyn NotificationNotifier>>,
}

impl std::fmt::Debug for PgNotificationStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PgNotificationStore")
            .field("pool", &self.pool)
            .field("has_notifier", &self.notifier.is_some())
            .finish()
    }
}

impl PgNotificationStore {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self {
            pool,
            notifier: None,
        }
    }

    #[must_use]
    pub fn with_notifier(mut self, notifier: Arc<dyn NotificationNotifier>) -> Self {
        self.notifier = Some(notifier);
        self
    }

    #[must_use]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// Emit a recipient-scoped notification. Validates the domain invariants,
    /// inserts one row (audited), and — only for a genuinely new row — fires the
    /// realtime notifier. A `dedup_key` redelivery is a no-op that returns the
    /// existing row without re-auditing or re-notifying.
    pub async fn emit_notification(
        &self,
        command: EmitNotificationCommand,
    ) -> Result<NotificationSummary, PgNotificationError> {
        let category = NotificationCategory::new(command.category)?;
        let body = NotificationBody::new(command.text)?;
        let link = NotificationLink::validated(command.link)?;
        let link_json = serde_json::to_value(&link).map_err(|err| {
            KernelError::internal(format!("notification link is not JSON: {err}"))
        })?;

        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let notification_id = NotificationId::new();
        let recipient_uuid = *command.recipient.as_uuid();
        let dedup_key = command.dedup_key.clone();

        // Fast path for a redelivered event: return the existing row untouched.
        if let Some(key) = &dedup_key
            && let Some(existing) = self.find_by_dedup(org, command.recipient, key).await?
        {
            return Ok(existing);
        }

        let event = notification_audit_event(
            "notification.emit",
            command.actor,
            notification_id,
            command.trace,
            command.occurred_at,
        )?
        .with_org(org);

        let insert = {
            let category = category.into_string();
            let body = body.into_string();
            let link_json = link_json.clone();
            let dedup_key = dedup_key.clone();
            with_audit::<_, Option<NotificationSummary>, PgNotificationError>(
                &self.pool,
                event,
                move |tx| {
                    Box::pin(async move {
                        let row = sqlx::query(
                            r#"
                            INSERT INTO notifications (
                                id, org_id, recipient_user_id, category, body, link, dedup_key
                            )
                            VALUES ($1, $2, $3, $4, $5, $6, $7)
                            ON CONFLICT (org_id, recipient_user_id, dedup_key)
                                WHERE dedup_key IS NOT NULL DO NOTHING
                            RETURNING id, recipient_user_id, category, body, link,
                                      unread, created_at, read_at
                            "#,
                        )
                        .bind(notification_id.as_uuid())
                        .bind(org_uuid)
                        .bind(recipient_uuid)
                        .bind(category)
                        .bind(body)
                        .bind(link_json)
                        .bind(dedup_key)
                        .fetch_optional(tx.as_mut())
                        .await?;
                        // No row => a concurrent emit already committed this
                        // dedup_key. Roll back (no audit) via the sentinel; the
                        // caller reads the committed row back.
                        row.as_ref()
                            .map(summary_from_row)
                            .transpose()?
                            .map_or(Err(PgNotificationError::Dedup), |summary| Ok(Some(summary)))
                    })
                },
            )
            .await
        };

        let summary = match insert {
            Ok(Some(summary)) => summary,
            Ok(None) => unreachable!("insert closure returns Some or the Dedup sentinel"),
            Err(PgNotificationError::Dedup) => {
                // The sentinel is only ever returned on the ON CONFLICT path,
                // which requires a dedup_key; read the winner back.
                return match dedup_key {
                    Some(key) => self
                        .find_by_dedup(org, command.recipient, &key)
                        .await?
                        .ok_or_else(|| {
                            KernelError::internal("dedup conflict but no existing notification")
                                .into()
                        }),
                    None => Err(KernelError::internal("dedup sentinel without a dedup_key").into()),
                };
            }
            Err(other) => return Err(other),
        };

        if let Some(notifier) = &self.notifier {
            notifier
                .notification_created(NotificationCreatedNotification {
                    notification_id: summary.id,
                    recipient_user_id: summary.recipient_user_id,
                })
                .await;
        }
        Ok(summary)
    }

    async fn find_by_dedup(
        &self,
        org: mnt_kernel_core::OrgId,
        recipient: UserId,
        dedup_key: &str,
    ) -> Result<Option<NotificationSummary>, PgNotificationError> {
        let recipient_uuid = *recipient.as_uuid();
        let dedup_key = dedup_key.to_owned();
        let row = with_org_conn::<_, _, PgNotificationError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                Ok(sqlx::query(
                    r#"
                    SELECT id, recipient_user_id, category, body, link,
                           unread, created_at, read_at
                    FROM notifications
                    WHERE recipient_user_id = $1 AND dedup_key = $2
                    "#,
                )
                .bind(recipient_uuid)
                .bind(dedup_key)
                .fetch_optional(tx.as_mut())
                .await?)
            })
        })
        .await?;
        row.as_ref().map(summary_from_row).transpose()
    }

    /// List the caller's notifications, newest first, keyset-paginated.
    pub async fn list(
        &self,
        query: ListNotificationsQuery,
    ) -> Result<NotificationPage, PgNotificationError> {
        let limit = query.limit.clamp(1, 200);
        let recipient_uuid = *query.recipient.as_uuid();
        let org = current_org().map_err(KernelError::from)?;

        let rows = with_org_conn::<_, _, PgNotificationError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let mut builder = QueryBuilder::<Postgres>::new(
                    r#"
                    SELECT id, recipient_user_id, category, body, link,
                           unread, created_at, read_at
                    FROM notifications
                    WHERE recipient_user_id =
                    "#,
                );
                builder.push_bind(recipient_uuid);
                if query.unread_only {
                    builder.push(" AND unread = true");
                }
                if let Some(before_id) = query.before_id {
                    // Keyset: strictly older than the cursor row. A cursor that
                    // is not the caller's own row makes the subquery empty, so
                    // the comparison is NULL and the page is empty (fail-closed).
                    builder.push(" AND (created_at, id) < (SELECT created_at, id FROM notifications WHERE id = ");
                    builder.push_bind(*before_id.as_uuid());
                    builder.push(" AND recipient_user_id = ");
                    builder.push_bind(recipient_uuid);
                    builder.push(")");
                }
                builder.push(" ORDER BY created_at DESC, id DESC LIMIT ");
                builder.push_bind(limit);
                Ok(builder.build().fetch_all(tx.as_mut()).await?)
            })
        })
        .await?;

        let items = rows
            .iter()
            .map(summary_from_row)
            .collect::<Result<Vec<_>, _>>()?;
        let next_cursor = (items.len() as i64 == limit)
            .then(|| items.last().map(|item| item.id))
            .flatten();
        Ok(NotificationPage { items, next_cursor })
    }

    /// Count the caller's unread notifications. The comms-rail badge needs an
    /// exact figure; paging the list and counting breaks past the page clamp.
    /// Recipient-scoped in code exactly like [`list`](Self::list); RLS narrows
    /// to the tenant on top, so another user's (or tenant's) rows never count.
    pub async fn unread_count(
        &self,
        query: UnreadNotificationCountQuery,
    ) -> Result<i64, PgNotificationError> {
        let recipient_uuid = *query.recipient.as_uuid();
        let org = current_org().map_err(KernelError::from)?;

        with_org_conn::<_, _, PgNotificationError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let count: i64 = sqlx::query_scalar(
                    r#"
                    SELECT COUNT(*)
                    FROM notifications
                    WHERE recipient_user_id = $1 AND unread = true
                    "#,
                )
                .bind(recipient_uuid)
                .fetch_one(tx.as_mut())
                .await?;
                Ok(count)
            })
        })
        .await
    }

    /// Mark one of the caller's notifications read. Returns NotFound when the id
    /// is unknown *or* owned by another user — the two are indistinguishable to
    /// the caller, which is the cross-user isolation guarantee.
    pub async fn mark_read(
        &self,
        command: MarkNotificationReadCommand,
    ) -> Result<NotificationSummary, PgNotificationError> {
        let org = current_org().map_err(KernelError::from)?;
        let recipient_uuid = *command.recipient.as_uuid();
        let notification_uuid = *command.notification_id.as_uuid();
        let occurred_at = command.occurred_at;
        let event = notification_audit_event(
            "notification.read",
            Some(command.recipient),
            command.notification_id,
            command.trace,
            command.occurred_at,
        )?
        .with_org(org);

        with_audit::<_, NotificationSummary, PgNotificationError>(&self.pool, event, move |tx| {
            Box::pin(async move {
                let row = sqlx::query(
                    r#"
                    UPDATE notifications
                    SET unread = false, read_at = COALESCE(read_at, $3)
                    WHERE id = $1 AND recipient_user_id = $2
                    RETURNING id, recipient_user_id, category, body, link,
                              unread, created_at, read_at
                    "#,
                )
                .bind(notification_uuid)
                .bind(recipient_uuid)
                .bind(occurred_at)
                .fetch_optional(tx.as_mut())
                .await?;
                match row {
                    Some(row) => summary_from_row(&row),
                    None => Err(KernelError::not_found("notification not found").into()),
                }
            })
        })
        .await
    }

    /// Mark all of the caller's unread notifications read. Returns the count.
    pub async fn mark_all_read(
        &self,
        command: MarkAllNotificationsReadCommand,
    ) -> Result<u64, PgNotificationError> {
        let org = current_org().map_err(KernelError::from)?;
        let recipient_uuid = *command.recipient.as_uuid();
        let occurred_at = command.occurred_at;
        let event = notification_audit_event(
            "notification.read_all",
            Some(command.recipient),
            command.recipient,
            command.trace,
            command.occurred_at,
        )?
        .with_org(org);

        with_audit::<_, u64, PgNotificationError>(&self.pool, event, move |tx| {
            Box::pin(async move {
                let result = sqlx::query(
                    r#"
                    UPDATE notifications
                    SET unread = false, read_at = COALESCE(read_at, $2)
                    WHERE recipient_user_id = $1 AND unread = true
                    "#,
                )
                .bind(recipient_uuid)
                .bind(occurred_at)
                .execute(tx.as_mut())
                .await?;
                Ok(result.rows_affected())
            })
        })
        .await
    }
}

impl NotificationSink for PgNotificationStore {
    fn emit(&self, command: EmitNotificationCommand) -> EmitNotificationFuture<'_> {
        Box::pin(async move {
            self.emit_notification(command)
                .await
                .map_err(KernelError::from)
        })
    }
}

fn summary_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<NotificationSummary, PgNotificationError> {
    let link_json: serde_json::Value = row.try_get("link")?;
    let link: NotificationLink = serde_json::from_value(link_json).map_err(|err| {
        KernelError::internal(format!("stored notification link is invalid: {err}"))
    })?;
    Ok(NotificationSummary {
        id: NotificationId::from_uuid(row.try_get("id")?),
        recipient_user_id: UserId::from_uuid(row.try_get("recipient_user_id")?),
        category: row.try_get("category")?,
        text: row.try_get("body")?,
        link,
        unread: row.try_get("unread")?,
        created_at: row.try_get("created_at")?,
        read_at: row.try_get("read_at")?,
    })
}
