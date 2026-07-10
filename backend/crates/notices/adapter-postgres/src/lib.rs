//! Postgres notice-board adapter.
//!
//! Publishing is the pivot: it issues the canonical NT- code (shared
//! object-code counter, kind = `notification`), snapshots every active org
//! member into `notice_receipts` (one audited bulk insert), and — best-effort,
//! post-commit like the notifications realtime notifier — fans out one
//! `notifications`-table pointer per recipient via the [`NotificationSink`]
//! write port, so a published notice shows up on the comms rail exactly like
//! any other notification.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::sync::Arc;

use mnt_kernel_core::{ErrorKind, KernelError, NoticeId, UserId};
use mnt_notices_application::{
    AcknowledgeNoticeCommand, CreateDraftNoticeCommand, GetNoticeQuery, ListNoticesQuery,
    NoticeProgress, NoticeProgressQuery, NoticeSummary, PublishNoticeCommand, notice_audit_event,
};
use mnt_notices_domain::NewNotice;
use mnt_notifications_application::{EmitNotificationCommand, NotificationSink};
use mnt_notifications_domain::NotificationLink;
use mnt_platform_db::{DbError, issue_code, with_audit, with_org_conn};
use mnt_platform_request_context::current_org;
use sqlx::{PgPool, Row};

#[derive(Debug, thiserror::Error)]
pub enum PgNoticeError {
    #[error(transparent)]
    Db(#[from] DbError),

    #[error(transparent)]
    Domain(#[from] KernelError),
}

impl PgNoticeError {
    #[must_use]
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::Domain(err) => err.kind,
            Self::Db(DbError::Sqlx(sqlx::Error::RowNotFound)) => ErrorKind::NotFound,
            Self::Db(_) => ErrorKind::Internal,
        }
    }
}

impl From<sqlx::Error> for PgNoticeError {
    fn from(value: sqlx::Error) -> Self {
        Self::Db(DbError::Sqlx(value))
    }
}

impl From<PgNoticeError> for KernelError {
    fn from(value: PgNoticeError) -> Self {
        match value {
            PgNoticeError::Domain(err) => err,
            PgNoticeError::Db(err) => KernelError::internal(err.to_string()),
        }
    }
}

#[derive(Clone)]
pub struct PgNoticeStore {
    pool: PgPool,
    notification_sink: Option<Arc<dyn NotificationSink>>,
}

impl std::fmt::Debug for PgNoticeStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PgNoticeStore")
            .field("pool", &self.pool)
            .field("has_notification_sink", &self.notification_sink.is_some())
            .finish()
    }
}

impl PgNoticeStore {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self {
            pool,
            notification_sink: None,
        }
    }

    #[must_use]
    pub fn with_notification_sink(mut self, sink: Arc<dyn NotificationSink>) -> Self {
        self.notification_sink = Some(sink);
        self
    }

    #[must_use]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub async fn create_draft(
        &self,
        command: CreateDraftNoticeCommand,
    ) -> Result<NoticeSummary, PgNoticeError> {
        let new_notice = NewNotice::new(&command.title, &command.body)?;
        let org = current_org().map_err(KernelError::from)?;
        let notice_id = NoticeId::new();
        let author_uuid = *command.author.as_uuid();
        let org_uuid = *org.as_uuid();

        let event = notice_audit_event(
            "notice.create_draft",
            Some(command.author),
            notice_id,
            command.trace,
            command.occurred_at,
        )?
        .with_org(org);

        let title = new_notice.title.into_string();
        let body = new_notice.body.into_string();
        let occurred_at = command.occurred_at;

        with_audit::<_, NoticeSummary, PgNoticeError>(&self.pool, event, move |tx| {
            Box::pin(async move {
                let row = sqlx::query(
                    r#"
                    INSERT INTO notices (id, org_id, author_user_id, title, body, created_at, updated_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $6)
                    RETURNING id, code, author_user_id, title, body, status, published_at, created_at
                    "#,
                )
                .bind(notice_id.as_uuid())
                .bind(org_uuid)
                .bind(author_uuid)
                .bind(title)
                .bind(body)
                .bind(occurred_at)
                .fetch_one(tx.as_mut())
                .await?;
                summary_from_row(&row)
            })
        })
        .await
    }

    /// `allow_draft` gates visibility of a still-draft notice — REST resolves
    /// this from the caller's publish-tier feature grant before the query
    /// reaches the store, so a non-manager gets NotFound (not Forbidden) for a
    /// draft, matching the notifications cross-user isolation idiom.
    pub async fn get(
        &self,
        query: GetNoticeQuery,
        allow_draft: bool,
    ) -> Result<NoticeSummary, PgNoticeError> {
        let org = current_org().map_err(KernelError::from)?;
        let notice_uuid = *query.notice_id.as_uuid();

        let row = with_org_conn::<_, _, PgNoticeError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                Ok(sqlx::query(
                    r#"
                    SELECT id, code, author_user_id, title, body, status, published_at, created_at
                    FROM notices
                    WHERE id = $1
                    "#,
                )
                .bind(notice_uuid)
                .fetch_optional(tx.as_mut())
                .await?)
            })
        })
        .await?;

        let row = row.ok_or_else(|| KernelError::not_found("notice not found"))?;
        let summary = summary_from_row(&row)?;
        if summary.status == "draft" && !allow_draft {
            return Err(KernelError::not_found("notice not found").into());
        }
        Ok(summary)
    }

    pub async fn list(&self, query: ListNoticesQuery) -> Result<Vec<NoticeSummary>, PgNoticeError> {
        let org = current_org().map_err(KernelError::from)?;
        let limit = query.limit.clamp(1, 200);
        let include_drafts = query.include_drafts;

        let rows = with_org_conn::<_, _, PgNoticeError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                if include_drafts {
                    Ok(sqlx::query(
                        r#"
                        SELECT id, code, author_user_id, title, body, status, published_at, created_at
                        FROM notices
                        ORDER BY created_at DESC
                        LIMIT $1
                        "#,
                    )
                    .bind(limit)
                    .fetch_all(tx.as_mut())
                    .await?)
                } else {
                    Ok(sqlx::query(
                        r#"
                        SELECT id, code, author_user_id, title, body, status, published_at, created_at
                        FROM notices
                        WHERE status = 'published'
                        ORDER BY created_at DESC
                        LIMIT $1
                        "#,
                    )
                    .bind(limit)
                    .fetch_all(tx.as_mut())
                    .await?)
                }
            })
        })
        .await?;

        rows.iter().map(summary_from_row).collect()
    }

    /// Transition a draft to published: issues the canonical NT- code,
    /// snapshots every active org member into `notice_receipts` (one audited
    /// bulk insert), then — best-effort, post-commit — fans out a
    /// notification to each snapshotted recipient.
    pub async fn publish(
        &self,
        command: PublishNoticeCommand,
    ) -> Result<NoticeSummary, PgNoticeError> {
        let org = current_org().map_err(KernelError::from)?;
        let notice_uuid = *command.notice_id.as_uuid();
        let occurred_at = command.occurred_at;
        let notify_trace = command.trace.clone();

        let publish_event = notice_audit_event(
            "notice.publish",
            Some(command.publisher),
            command.notice_id,
            command.trace.clone(),
            command.occurred_at,
        )?
        .with_org(org);

        let summary = with_audit::<_, NoticeSummary, PgNoticeError>(
            &self.pool,
            publish_event,
            move |tx| {
                Box::pin(async move {
                    let current_status: Option<String> =
                        sqlx::query_scalar("SELECT status FROM notices WHERE id = $1 FOR UPDATE")
                            .bind(notice_uuid)
                            .fetch_optional(tx.as_mut())
                            .await?;
                    match current_status.as_deref() {
                        None => return Err(KernelError::not_found("notice not found").into()),
                        Some("draft") => {}
                        Some(_) => {
                            return Err(KernelError::conflict("notice is already published").into());
                        }
                    }

                    let code = issue_code(tx, org, "notification").await?;

                    let row = sqlx::query(
                        r#"
                        UPDATE notices
                        SET status = 'published', code = $2, published_at = $3, updated_at = $3
                        WHERE id = $1
                        RETURNING id, code, author_user_id, title, body, status, published_at, created_at
                        "#,
                    )
                    .bind(notice_uuid)
                    .bind(code)
                    .bind(occurred_at)
                    .fetch_one(tx.as_mut())
                    .await?;
                    summary_from_row(&row)
                })
            },
        )
        .await?;

        let recipients_event = notice_audit_event(
            "notice.publish_recipients",
            Some(command.publisher),
            command.notice_id,
            command.trace,
            command.occurred_at,
        )?
        .with_org(org);
        let org_uuid = *org.as_uuid();

        let recipient_ids =
            with_audit::<_, Vec<UserId>, PgNoticeError>(&self.pool, recipients_event, move |tx| {
                Box::pin(async move {
                    let rows = sqlx::query(
                        r#"
                        INSERT INTO notice_receipts (org_id, notice_id, recipient_user_id)
                        SELECT $1, $2, id FROM users WHERE org_id = $1 AND is_active = true
                        ON CONFLICT (notice_id, recipient_user_id) DO NOTHING
                        RETURNING recipient_user_id
                        "#,
                    )
                    .bind(org_uuid)
                    .bind(notice_uuid)
                    .fetch_all(tx.as_mut())
                    .await?;
                    rows.iter()
                        .map(|row| Ok(UserId::from_uuid(row.try_get("recipient_user_id")?)))
                        .collect::<Result<Vec<_>, PgNoticeError>>()
                })
            })
            .await?;

        if let Some(sink) = &self.notification_sink {
            let link = NotificationLink::Object {
                kind: "notice".to_owned(),
                id: notice_uuid.to_string(),
            };
            for recipient in recipient_ids {
                let _ = sink
                    .emit(EmitNotificationCommand {
                        actor: Some(command.publisher),
                        recipient,
                        category: "공지".to_owned(),
                        kind: "info".to_owned(),
                        text: summary.title.clone(),
                        link: link.clone(),
                        dedup_key: Some(format!("notice-publish-{notice_uuid}-{recipient}")),
                        trace: notify_trace.clone(),
                        occurred_at,
                    })
                    .await;
            }
        }

        Ok(summary)
    }

    /// Record a recipient's 수령확인. NotFound when the caller was never
    /// snapshotted as a recipient (unpublished notice, or not an org member
    /// at publish time) — mirrors the notifications cross-user isolation
    /// idiom rather than distinguishing "not found" from "not yours".
    pub async fn acknowledge(
        &self,
        command: AcknowledgeNoticeCommand,
    ) -> Result<(), PgNoticeError> {
        let org = current_org().map_err(KernelError::from)?;
        let notice_uuid = *command.notice_id.as_uuid();
        let recipient_uuid = *command.recipient.as_uuid();
        let occurred_at = command.occurred_at;

        let event = notice_audit_event(
            "notice.acknowledge",
            Some(command.recipient),
            command.notice_id,
            command.trace,
            command.occurred_at,
        )?
        .with_org(org);

        with_audit::<_, (), PgNoticeError>(&self.pool, event, move |tx| {
            Box::pin(async move {
                let result = sqlx::query(
                    r#"
                    UPDATE notice_receipts
                    SET acknowledged_at = COALESCE(acknowledged_at, $3)
                    WHERE notice_id = $1 AND recipient_user_id = $2
                    "#,
                )
                .bind(notice_uuid)
                .bind(recipient_uuid)
                .bind(occurred_at)
                .execute(tx.as_mut())
                .await?;
                if result.rows_affected() == 0 {
                    return Err(KernelError::not_found(
                        "notice not found, or you are not a recipient",
                    )
                    .into());
                }
                Ok(())
            })
        })
        .await
    }

    pub async fn progress(
        &self,
        query: NoticeProgressQuery,
    ) -> Result<NoticeProgress, PgNoticeError> {
        let org = current_org().map_err(KernelError::from)?;
        let notice_uuid = *query.notice_id.as_uuid();

        with_org_conn::<_, _, PgNoticeError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let row = sqlx::query(
                    r#"
                    SELECT COUNT(*) AS total,
                           COUNT(*) FILTER (WHERE acknowledged_at IS NOT NULL) AS acknowledged
                    FROM notice_receipts
                    WHERE notice_id = $1
                    "#,
                )
                .bind(notice_uuid)
                .fetch_one(tx.as_mut())
                .await?;
                Ok(NoticeProgress {
                    total: row.try_get("total")?,
                    acknowledged: row.try_get("acknowledged")?,
                })
            })
        })
        .await
    }
}

fn summary_from_row(row: &sqlx::postgres::PgRow) -> Result<NoticeSummary, PgNoticeError> {
    Ok(NoticeSummary {
        id: NoticeId::from_uuid(row.try_get("id")?),
        code: row.try_get("code")?,
        author_user_id: UserId::from_uuid(row.try_get("author_user_id")?),
        title: row.try_get("title")?,
        body: row.try_get("body")?,
        status: row.try_get("status")?,
        published_at: row.try_get("published_at")?,
        created_at: row.try_get("created_at")?,
    })
}
