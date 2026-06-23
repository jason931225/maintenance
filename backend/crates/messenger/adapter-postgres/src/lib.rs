//! Postgres messenger adapter.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::sync::Arc;

use mnt_kernel_core::{
    BranchId, BranchScope, ErrorKind, EvidenceId, KernelError, MessageId, ThreadId, UserId,
    WorkOrderId,
};
use mnt_messenger_application::{
    CreateThreadCommand, EnsureWorkOrderThreadCommand, ListThreadsQuery, MarkThreadReadCommand,
    MessageNotifier, MessagePage, MessagePageQuery, MessagePostedNotification, MessageSummary,
    ReadReceiptSummary, SearchMessagesQuery, SendMessageCommand, ThreadSummary,
    messenger_audit_event,
};
use mnt_messenger_domain::{MessageBody, ThreadKind};
use mnt_platform_db::{DbError, with_audit, with_org_conn};
use mnt_platform_request_context::current_org;
use mnt_workorder_application::{
    WorkOrderCreatedEvent, WorkOrderCreatedFuture, WorkOrderCreatedListener,
};
use sqlx::{PgPool, Postgres, QueryBuilder, Row, Transaction};

#[derive(Debug, thiserror::Error)]
pub enum PgMessengerError {
    #[error(transparent)]
    Db(#[from] DbError),

    #[error(transparent)]
    Domain(#[from] KernelError),
}

impl PgMessengerError {
    #[must_use]
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::Domain(err) => err.kind,
            Self::Db(DbError::Sqlx(sqlx::Error::RowNotFound)) => ErrorKind::NotFound,
            Self::Db(DbError::Sqlx(sqlx::Error::Database(err)))
                if err.code().is_some_and(|code| code == "23505") =>
            {
                ErrorKind::Conflict
            }
            Self::Db(_) => ErrorKind::Internal,
        }
    }
}

impl From<sqlx::Error> for PgMessengerError {
    fn from(value: sqlx::Error) -> Self {
        Self::Db(DbError::Sqlx(value))
    }
}

#[derive(Clone)]
pub struct PgMessengerStore {
    pool: PgPool,
    notifier: Option<Arc<dyn MessageNotifier>>,
}

impl std::fmt::Debug for PgMessengerStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PgMessengerStore")
            .field("pool", &self.pool)
            .field("has_notifier", &self.notifier.is_some())
            .finish()
    }
}

impl PgMessengerStore {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self {
            pool,
            notifier: None,
        }
    }

    #[must_use]
    pub fn with_notifier(mut self, notifier: Arc<dyn MessageNotifier>) -> Self {
        self.notifier = Some(notifier);
        self
    }

    #[must_use]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub async fn create_thread(
        &self,
        command: CreateThreadCommand,
    ) -> Result<ThreadSummary, PgMessengerError> {
        ensure_branch_scope(&command.branch_scope, command.branch_id)?;
        validate_thread_shape(&command)?;
        let member_ids = normalized_members(command.actor, &command.member_ids)?;
        let thread_id = ThreadId::new();
        let branch_id = command.branch_id;
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let event = messenger_audit_event(
            "message_thread.create",
            command.actor,
            branch_id,
            "message_thread",
            thread_id,
            command.trace,
            command.occurred_at,
        )?
        .with_org(org);

        with_audit::<_, ThreadSummary, PgMessengerError>(&self.pool, event, |tx| {
            Box::pin(async move {
                if let Some(work_order_id) = command.work_order_id {
                    ensure_work_order_branch_tx(tx, work_order_id, branch_id).await?;
                }
                insert_thread_tx(
                    tx,
                    NewThread {
                        id: thread_id,
                        kind: command.kind,
                        branch_id,
                        work_order_id: command.work_order_id,
                        title: command.title.as_deref().map(str::trim),
                        actor: command.actor,
                        occurred_at: command.occurred_at,
                    },
                    &member_ids,
                    org_uuid,
                )
                .await?;
                fetch_thread_summary_tx(tx, thread_id).await
            })
        })
        .await
    }

    pub async fn ensure_work_order_thread(
        &self,
        command: EnsureWorkOrderThreadCommand,
    ) -> Result<ThreadSummary, PgMessengerError> {
        if let Some(existing) =
            fetch_work_order_thread_pool(&self.pool, command.work_order_id).await?
        {
            return Ok(existing);
        }

        let request_no = work_order_request_no(&self.pool, command.work_order_id).await?;
        ensure_work_order_branch_pool(&self.pool, command.work_order_id, command.branch_id).await?;
        let thread_id = ThreadId::new();
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let event = messenger_audit_event(
            "message_thread.create",
            command.actor,
            command.branch_id,
            "message_thread",
            thread_id,
            command.trace,
            command.occurred_at,
        )?
        .with_org(org);
        let title = format!("WO {request_no}");

        let result = with_audit::<_, ThreadSummary, PgMessengerError>(&self.pool, event, |tx| {
            Box::pin(async move {
                insert_thread_tx(
                    tx,
                    NewThread {
                        id: thread_id,
                        kind: ThreadKind::WorkOrder,
                        branch_id: command.branch_id,
                        work_order_id: Some(command.work_order_id),
                        title: Some(&title),
                        actor: command.actor,
                        occurred_at: command.occurred_at,
                    },
                    &[command.actor],
                    org_uuid,
                )
                .await?;
                fetch_thread_summary_tx(tx, thread_id).await
            })
        })
        .await;

        match result {
            Ok(summary) => Ok(summary),
            Err(err) if err.kind() == ErrorKind::Conflict => {
                fetch_work_order_thread_pool(&self.pool, command.work_order_id)
                    .await?
                    .ok_or_else(|| {
                        KernelError::conflict("work-order messenger thread create raced").into()
                    })
            }
            Err(err) => Err(err),
        }
    }

    pub async fn send_message(
        &self,
        command: SendMessageCommand,
    ) -> Result<MessageSummary, PgMessengerError> {
        let body = MessageBody::new(command.body)?;
        let access = require_thread_access(
            &self.pool,
            command.thread_id,
            command.actor,
            &command.branch_scope,
        )
        .await?;
        let message_id = MessageId::new();
        let attachment_ids = command.attachment_evidence_ids;
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let event = messenger_audit_event(
            "message.send",
            command.actor,
            access.branch_id,
            "message",
            message_id,
            command.trace,
            command.occurred_at,
        )?
        .with_org(org)
        .with_snapshots(
            None,
            Some(serde_json::json!({
                "thread_id": command.thread_id,
                "sender_id": command.actor,
                "attachment_count": attachment_ids.len(),
            })),
        );

        let summary = with_audit::<_, MessageSummary, PgMessengerError>(&self.pool, event, |tx| {
            Box::pin(async move {
                sqlx::query(
                    r#"
                        INSERT INTO messenger_messages (
                            id, thread_id, branch_id, sender_id, body, sent_at, created_at, org_id
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $6, $7)
                        "#,
                )
                .bind(*message_id.as_uuid())
                .bind(*command.thread_id.as_uuid())
                .bind(*access.branch_id.as_uuid())
                .bind(*command.actor.as_uuid())
                .bind(body.as_str())
                .bind(command.occurred_at)
                .bind(org_uuid)
                .execute(tx.as_mut())
                .await?;

                for (index, evidence_id) in attachment_ids.iter().enumerate() {
                    let sort_order = i16::try_from(index + 1)
                        .map_err(|_| KernelError::validation("too many message attachments"))?;
                    sqlx::query(
                        r#"
                            INSERT INTO messenger_message_attachments (
                                message_id, evidence_id, sort_order, org_id
                            )
                            VALUES ($1, $2, $3, $4)
                            "#,
                    )
                    .bind(*message_id.as_uuid())
                    .bind(*evidence_id.as_uuid())
                    .bind(sort_order)
                    .bind(org_uuid)
                    .execute(tx.as_mut())
                    .await?;
                }

                sqlx::query("UPDATE messenger_threads SET updated_at = $2 WHERE id = $1")
                    .bind(*command.thread_id.as_uuid())
                    .bind(command.occurred_at)
                    .execute(tx.as_mut())
                    .await?;

                fetch_message_summary_tx(tx, message_id).await
            })
        })
        .await?;

        if let Some(notifier) = &self.notifier {
            notifier
                .message_posted(MessagePostedNotification {
                    message_id: summary.id,
                    thread_id: summary.thread_id,
                    branch_id: summary.branch_id,
                })
                .await;
        }

        Ok(summary)
    }

    /// Coalesce read receipts at the thread/user level and audit one
    /// `message.read` event per explicit read command rather than per message.
    /// That preserves who acknowledged which latest message while avoiding an
    /// audit row explosion for long catch-up pages.
    pub async fn mark_thread_read(
        &self,
        command: MarkThreadReadCommand,
    ) -> Result<ReadReceiptSummary, PgMessengerError> {
        let access = require_thread_access(
            &self.pool,
            command.thread_id,
            command.actor,
            &command.branch_scope,
        )
        .await?;
        ensure_message_in_thread_pool(&self.pool, command.last_read_message_id, command.thread_id)
            .await?;
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let event = messenger_audit_event(
            "message.read",
            command.actor,
            access.branch_id,
            "message_thread",
            command.thread_id,
            command.trace,
            command.occurred_at,
        )?
        .with_org(org)
        .with_snapshots(
            None,
            Some(serde_json::json!({
                "last_read_message_id": command.last_read_message_id,
            })),
        );

        with_audit::<_, ReadReceiptSummary, PgMessengerError>(&self.pool, event, |tx| {
            Box::pin(async move {
                sqlx::query(
                    r#"
                    INSERT INTO messenger_read_receipts (
                        thread_id, user_id, last_read_message_id, read_at, updated_at, org_id
                    )
                    VALUES ($1, $2, $3, $4, $4, $5)
                    ON CONFLICT (thread_id, user_id) DO UPDATE
                    SET last_read_message_id = EXCLUDED.last_read_message_id,
                        read_at = EXCLUDED.read_at,
                        updated_at = EXCLUDED.updated_at
                    "#,
                )
                .bind(*command.thread_id.as_uuid())
                .bind(*command.actor.as_uuid())
                .bind(*command.last_read_message_id.as_uuid())
                .bind(command.occurred_at)
                .bind(org_uuid)
                .execute(tx.as_mut())
                .await?;
                fetch_read_receipt_tx(tx, command.thread_id, command.actor).await
            })
        })
        .await
    }

    pub async fn list_threads(
        &self,
        query: ListThreadsQuery,
    ) -> Result<Vec<ThreadSummary>, PgMessengerError> {
        let limit = normalized_limit(query.limit);
        let mut builder = QueryBuilder::<Postgres>::new(
            r#"
            SELECT t.id, t.kind, t.branch_id, t.work_order_id, t.title,
                   t.created_at, t.updated_at,
                   lm.id AS last_message_id,
                   lm.sent_at AS last_message_at,
                   COUNT(tm_all.user_id)::BIGINT AS member_count
            FROM messenger_threads t
            JOIN messenger_thread_members tm_actor
              ON tm_actor.thread_id = t.id
             AND tm_actor.user_id =
            "#,
        );
        builder.push_bind(*query.actor.as_uuid());
        builder.push(
            r#"
            LEFT JOIN LATERAL (
                SELECT id, sent_at
                FROM messenger_messages
                WHERE thread_id = t.id
                ORDER BY sent_at DESC, id DESC
                LIMIT 1
            ) lm ON true
            LEFT JOIN messenger_thread_members tm_all ON tm_all.thread_id = t.id
            WHERE true
            "#,
        );
        push_scope_filter(&mut builder, "t.branch_id", &query.branch_scope)?;
        builder.push(
            r#"
            GROUP BY t.id, lm.id, lm.sent_at
            ORDER BY COALESCE(lm.sent_at, t.updated_at) DESC, t.id DESC
            LIMIT
            "#,
        );
        builder.push_bind(limit);

        let org = current_org().map_err(KernelError::from)?;
        let rows = with_org_conn::<_, _, PgMessengerError>(&self.pool, org, move |tx| {
            Box::pin(async move { Ok(builder.build().fetch_all(tx.as_mut()).await?) })
        })
        .await?;
        rows.iter().map(thread_summary_from_row).collect()
    }

    pub async fn message_page(
        &self,
        query: MessagePageQuery,
    ) -> Result<MessagePage, PgMessengerError> {
        require_thread_access(
            &self.pool,
            query.thread_id,
            query.actor,
            &query.branch_scope,
        )
        .await?;
        let limit = normalized_limit(query.limit);
        let page_limit = limit + 1;
        let before = match query.before_message_id {
            Some(message_id) => {
                Some(message_cursor(&self.pool, message_id, query.thread_id).await?)
            }
            None => None,
        };

        let mut builder = message_select_builder();
        builder.push(" WHERE m.thread_id = ");
        builder.push_bind(*query.thread_id.as_uuid());
        if let Some((sent_at, id)) = before {
            builder.push(" AND (m.sent_at, m.id) < (");
            builder.push_bind(sent_at);
            builder.push(", ");
            builder.push_bind(id);
            builder.push(")");
        }
        builder
            .push(" GROUP BY m.id, sender.display_name ORDER BY m.sent_at DESC, m.id DESC LIMIT ");
        builder.push_bind(page_limit);

        let org = current_org().map_err(KernelError::from)?;
        let rows = with_org_conn::<_, _, PgMessengerError>(&self.pool, org, move |tx| {
            Box::pin(async move { Ok(builder.build().fetch_all(tx.as_mut()).await?) })
        })
        .await?;
        let mut items: Vec<MessageSummary> = rows
            .iter()
            .map(message_summary_from_row)
            .collect::<Result<_, _>>()?;
        let has_more = i64::try_from(items.len()).unwrap_or(0) > limit;
        if has_more {
            let _ = items.pop();
        }
        let next_cursor = if has_more {
            items.last().map(|message| message.id)
        } else {
            None
        };

        Ok(MessagePage { items, next_cursor })
    }

    /// Search primarily uses the `search_vector` GIN index. PostgreSQL's
    /// built-in `simple` configuration has limited Korean tokenization without
    /// a mecab-style dictionary, so this T3.1 slice also applies an `ILIKE`
    /// substring fallback for Korean terms. That keeps polling search useful
    /// without pretending the FTS stack is linguistically complete.
    pub async fn search_messages(
        &self,
        query: SearchMessagesQuery,
    ) -> Result<Vec<MessageSummary>, PgMessengerError> {
        let search = query.query.trim();
        if search.is_empty() {
            return Err(KernelError::validation("search query is required").into());
        }
        let limit = normalized_limit(query.limit);
        let mut builder = message_select_builder();
        builder.push(
            r#"
            JOIN messenger_thread_members tm_actor
              ON tm_actor.thread_id = m.thread_id
             AND tm_actor.user_id =
            "#,
        );
        builder.push_bind(*query.actor.as_uuid());
        builder.push(" WHERE (m.search_vector @@ plainto_tsquery('simple', ");
        builder.push_bind(search);
        builder.push(") OR m.body ILIKE ");
        builder.push_bind(format!("%{search}%"));
        builder.push(")");
        push_scope_filter(&mut builder, "m.branch_id", &query.branch_scope)?;
        builder
            .push(" GROUP BY m.id, sender.display_name ORDER BY m.sent_at DESC, m.id DESC LIMIT ");
        builder.push_bind(limit);

        let org = current_org().map_err(KernelError::from)?;
        let rows = with_org_conn::<_, _, PgMessengerError>(&self.pool, org, move |tx| {
            Box::pin(async move { Ok(builder.build().fetch_all(tx.as_mut()).await?) })
        })
        .await?;
        rows.iter().map(message_summary_from_row).collect()
    }
}

impl WorkOrderCreatedListener for PgMessengerStore {
    fn work_order_created(&self, event: WorkOrderCreatedEvent) -> WorkOrderCreatedFuture<'_> {
        Box::pin(async move {
            self.ensure_work_order_thread(EnsureWorkOrderThreadCommand {
                actor: event.actor,
                branch_id: event.branch_id,
                work_order_id: event.work_order_id,
                trace: event.trace,
                occurred_at: event.occurred_at,
            })
            .await
            .map(|_| ())
            .map_err(kernel_error_from_messenger_error)
        })
    }
}

#[derive(Debug, Clone, Copy)]
struct ThreadAccess {
    branch_id: BranchId,
}

#[derive(Debug, Clone, Copy)]
struct NewThread<'a> {
    id: ThreadId,
    kind: ThreadKind,
    branch_id: BranchId,
    work_order_id: Option<WorkOrderId>,
    title: Option<&'a str>,
    actor: UserId,
    occurred_at: time::OffsetDateTime,
}

fn validate_thread_shape(command: &CreateThreadCommand) -> Result<(), PgMessengerError> {
    match command.kind {
        ThreadKind::WorkOrder if command.work_order_id.is_none() => Err(KernelError::validation(
            "work-order messenger thread requires work_order_id",
        )
        .into()),
        ThreadKind::WorkOrder => Ok(()),
        ThreadKind::Team | ThreadKind::Dm | ThreadKind::Group
            if command.work_order_id.is_some() =>
        {
            Err(KernelError::validation(
                "only work-order messenger threads may carry work_order_id",
            )
            .into())
        }
        ThreadKind::Dm if normalized_members(command.actor, &command.member_ids)?.len() != 2 => {
            Err(KernelError::validation("DM thread requires exactly two members").into())
        }
        ThreadKind::Group if normalized_members(command.actor, &command.member_ids)?.len() < 3 => {
            Err(KernelError::validation("group thread requires at least three members").into())
        }
        _ => Ok(()),
    }
}

fn normalized_members(actor: UserId, members: &[UserId]) -> Result<Vec<UserId>, PgMessengerError> {
    let mut members = members.to_vec();
    members.push(actor);
    members.sort();
    members.dedup();
    if members.is_empty() {
        return Err(KernelError::validation("messenger thread requires members").into());
    }
    Ok(members)
}

fn ensure_branch_scope(scope: &BranchScope, branch_id: BranchId) -> Result<(), PgMessengerError> {
    if scope.allows(branch_id) {
        Ok(())
    } else {
        Err(KernelError::forbidden("messenger branch is outside principal scope").into())
    }
}

fn normalized_limit(limit: i64) -> i64 {
    limit.clamp(1, 100)
}

async fn insert_thread_tx(
    tx: &mut Transaction<'_, Postgres>,
    thread: NewThread<'_>,
    member_ids: &[UserId],
    org_uuid: uuid::Uuid,
) -> Result<(), PgMessengerError> {
    sqlx::query(
        r#"
        INSERT INTO messenger_threads (
            id, kind, branch_id, work_order_id, title, created_by, created_at, updated_at, org_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8)
        "#,
    )
    .bind(*thread.id.as_uuid())
    .bind(thread.kind.as_db_str())
    .bind(*thread.branch_id.as_uuid())
    .bind(thread.work_order_id.map(|id| *id.as_uuid()))
    .bind(thread.title)
    .bind(*thread.actor.as_uuid())
    .bind(thread.occurred_at)
    .bind(org_uuid)
    .execute(tx.as_mut())
    .await?;

    for member_id in member_ids {
        let role = if *member_id == thread.actor {
            "OWNER"
        } else {
            "MEMBER"
        };
        sqlx::query(
            r#"
            INSERT INTO messenger_thread_members (thread_id, user_id, role, joined_at, org_id)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (thread_id, user_id) DO NOTHING
            "#,
        )
        .bind(*thread.id.as_uuid())
        .bind(*member_id.as_uuid())
        .bind(role)
        .bind(thread.occurred_at)
        .bind(org_uuid)
        .execute(tx.as_mut())
        .await?;
    }

    Ok(())
}

async fn require_thread_access(
    pool: &PgPool,
    thread_id: ThreadId,
    actor: UserId,
    branch_scope: &BranchScope,
) -> Result<ThreadAccess, PgMessengerError> {
    let org = current_org().map_err(KernelError::from)?;
    let row = with_org_conn::<_, _, PgMessengerError>(pool, org, move |tx| {
        Box::pin(async move {
            Ok(sqlx::query(
                r#"
        SELECT t.branch_id,
               EXISTS (
                   SELECT 1
                   FROM messenger_thread_members tm
                   WHERE tm.thread_id = t.id
                     AND tm.user_id = $2
               ) AS is_member
        FROM messenger_threads t
        WHERE t.id = $1
        "#,
            )
            .bind(*thread_id.as_uuid())
            .bind(*actor.as_uuid())
            .fetch_optional(tx.as_mut())
            .await?)
        })
    })
    .await?
    .ok_or_else(|| KernelError::not_found("messenger thread was not found"))?;

    let branch_id = BranchId::from_uuid(row.try_get("branch_id")?);
    ensure_branch_scope(branch_scope, branch_id)?;
    let is_member: bool = row
        .try_get::<Option<bool>, _>("is_member")?
        .unwrap_or(false);
    if !is_member {
        return Err(KernelError::forbidden("actor is not a messenger thread member").into());
    }
    Ok(ThreadAccess { branch_id })
}

async fn ensure_work_order_branch_pool(
    pool: &PgPool,
    work_order_id: WorkOrderId,
    branch_id: BranchId,
) -> Result<(), PgMessengerError> {
    let org = current_org().map_err(KernelError::from)?;
    let actual: uuid::Uuid = with_org_conn::<_, _, PgMessengerError>(pool, org, move |tx| {
        Box::pin(async move {
            Ok(
                sqlx::query_scalar("SELECT branch_id FROM work_orders WHERE id = $1")
                    .bind(*work_order_id.as_uuid())
                    .fetch_optional(tx.as_mut())
                    .await?,
            )
        })
    })
    .await?
    .ok_or_else(|| KernelError::not_found("work order was not found"))?;
    if actual == *branch_id.as_uuid() {
        Ok(())
    } else {
        Err(KernelError::forbidden("work order belongs to a different branch").into())
    }
}

async fn ensure_work_order_branch_tx(
    tx: &mut Transaction<'_, Postgres>,
    work_order_id: WorkOrderId,
    branch_id: BranchId,
) -> Result<(), PgMessengerError> {
    let actual: uuid::Uuid = sqlx::query_scalar("SELECT branch_id FROM work_orders WHERE id = $1")
        .bind(*work_order_id.as_uuid())
        .fetch_optional(tx.as_mut())
        .await?
        .ok_or_else(|| KernelError::not_found("work order was not found"))?;
    if actual == *branch_id.as_uuid() {
        Ok(())
    } else {
        Err(KernelError::forbidden("work order belongs to a different branch").into())
    }
}

async fn work_order_request_no(
    pool: &PgPool,
    work_order_id: WorkOrderId,
) -> Result<String, PgMessengerError> {
    let org = current_org().map_err(KernelError::from)?;
    with_org_conn::<_, _, PgMessengerError>(pool, org, move |tx| {
        Box::pin(async move {
            sqlx::query_scalar("SELECT request_no FROM work_orders WHERE id = $1")
                .bind(*work_order_id.as_uuid())
                .fetch_optional(tx.as_mut())
                .await?
                .ok_or_else(|| KernelError::not_found("work order was not found").into())
        })
    })
    .await
}

async fn fetch_work_order_thread_pool(
    pool: &PgPool,
    work_order_id: WorkOrderId,
) -> Result<Option<ThreadSummary>, PgMessengerError> {
    let mut builder = thread_summary_builder();
    builder.push(" WHERE t.work_order_id = ");
    builder.push_bind(*work_order_id.as_uuid());
    builder.push(" GROUP BY t.id, lm.id, lm.sent_at");
    let org = current_org().map_err(KernelError::from)?;
    let row = with_org_conn::<_, _, PgMessengerError>(pool, org, move |tx| {
        Box::pin(async move { Ok(builder.build().fetch_optional(tx.as_mut()).await?) })
    })
    .await?;
    row.as_ref().map(thread_summary_from_row).transpose()
}

async fn fetch_thread_summary_tx(
    tx: &mut Transaction<'_, Postgres>,
    thread_id: ThreadId,
) -> Result<ThreadSummary, PgMessengerError> {
    let mut builder = thread_summary_builder();
    builder.push(" WHERE t.id = ");
    builder.push_bind(*thread_id.as_uuid());
    builder.push(" GROUP BY t.id, lm.id, lm.sent_at");
    let row = builder.build().fetch_one(tx.as_mut()).await?;
    thread_summary_from_row(&row)
}

fn thread_summary_builder() -> QueryBuilder<Postgres> {
    QueryBuilder::<Postgres>::new(
        r#"
        SELECT t.id, t.kind, t.branch_id, t.work_order_id, t.title,
               t.created_at, t.updated_at,
               lm.id AS last_message_id,
               lm.sent_at AS last_message_at,
               COUNT(tm_all.user_id)::BIGINT AS member_count
        FROM messenger_threads t
        LEFT JOIN LATERAL (
            SELECT id, sent_at
            FROM messenger_messages
            WHERE thread_id = t.id
            ORDER BY sent_at DESC, id DESC
            LIMIT 1
        ) lm ON true
        LEFT JOIN messenger_thread_members tm_all ON tm_all.thread_id = t.id
        "#,
    )
}

fn thread_summary_from_row(row: &sqlx::postgres::PgRow) -> Result<ThreadSummary, PgMessengerError> {
    let kind: String = row.try_get("kind")?;
    Ok(ThreadSummary {
        id: ThreadId::from_uuid(row.try_get("id")?),
        kind: ThreadKind::from_db_str(&kind)?,
        branch_id: BranchId::from_uuid(row.try_get("branch_id")?),
        title: row.try_get("title")?,
        work_order_id: row
            .try_get::<Option<uuid::Uuid>, _>("work_order_id")?
            .map(WorkOrderId::from_uuid),
        last_message_id: row
            .try_get::<Option<uuid::Uuid>, _>("last_message_id")?
            .map(MessageId::from_uuid),
        last_message_at: row.try_get("last_message_at")?,
        member_count: row.try_get("member_count")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn message_select_builder() -> QueryBuilder<Postgres> {
    QueryBuilder::<Postgres>::new(
        r#"
        SELECT m.id, m.thread_id, m.branch_id, m.sender_id, m.body,
               m.sent_at, m.created_at, sender.display_name AS sender_name,
               COALESCE(
                   array_agg(a.evidence_id ORDER BY a.sort_order)
                       FILTER (WHERE a.evidence_id IS NOT NULL),
                   ARRAY[]::uuid[]
               ) AS attachment_evidence_ids
        FROM messenger_messages m
        LEFT JOIN messenger_message_attachments a ON a.message_id = m.id
        -- Same-org JOIN: `users` is RLS-scoped to app.current_org just like
        -- messenger_messages, so this can only resolve a sender in the caller's
        -- tenant. A cross-tenant or hard-deleted sender simply yields NULL.
        LEFT JOIN users sender ON sender.id = m.sender_id
        "#,
    )
}

async fn fetch_message_summary_tx(
    tx: &mut Transaction<'_, Postgres>,
    message_id: MessageId,
) -> Result<MessageSummary, PgMessengerError> {
    let mut builder = message_select_builder();
    builder.push(" WHERE m.id = ");
    builder.push_bind(*message_id.as_uuid());
    builder.push(" GROUP BY m.id, sender.display_name");
    let row = builder.build().fetch_one(tx.as_mut()).await?;
    message_summary_from_row(&row)
}

fn message_summary_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<MessageSummary, PgMessengerError> {
    let attachment_ids: Vec<uuid::Uuid> = row.try_get("attachment_evidence_ids")?;
    Ok(MessageSummary {
        id: MessageId::from_uuid(row.try_get("id")?),
        thread_id: ThreadId::from_uuid(row.try_get("thread_id")?),
        branch_id: BranchId::from_uuid(row.try_get("branch_id")?),
        sender_id: UserId::from_uuid(row.try_get("sender_id")?),
        sender_name: row.try_get("sender_name")?,
        body: row.try_get("body")?,
        attachment_evidence_ids: attachment_ids
            .into_iter()
            .map(EvidenceId::from_uuid)
            .collect(),
        sent_at: row.try_get("sent_at")?,
        created_at: row.try_get("created_at")?,
    })
}

async fn ensure_message_in_thread_pool(
    pool: &PgPool,
    message_id: MessageId,
    thread_id: ThreadId,
) -> Result<(), PgMessengerError> {
    let org = current_org().map_err(KernelError::from)?;
    let exists: bool = with_org_conn::<_, _, PgMessengerError>(pool, org, move |tx| {
        Box::pin(async move {
            Ok(sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM messenger_messages WHERE id = $1 AND thread_id = $2)",
            )
            .bind(*message_id.as_uuid())
            .bind(*thread_id.as_uuid())
            .fetch_one(tx.as_mut())
            .await?)
        })
    })
    .await?;
    if exists {
        Ok(())
    } else {
        Err(KernelError::not_found("message was not found in thread").into())
    }
}

async fn message_cursor(
    pool: &PgPool,
    message_id: MessageId,
    thread_id: ThreadId,
) -> Result<(time::OffsetDateTime, uuid::Uuid), PgMessengerError> {
    let org = current_org().map_err(KernelError::from)?;
    let row = with_org_conn::<_, _, PgMessengerError>(pool, org, move |tx| {
        Box::pin(async move {
            Ok(sqlx::query(
                "SELECT sent_at, id FROM messenger_messages WHERE id = $1 AND thread_id = $2",
            )
            .bind(*message_id.as_uuid())
            .bind(*thread_id.as_uuid())
            .fetch_optional(tx.as_mut())
            .await?)
        })
    })
    .await?
    .ok_or_else(|| KernelError::not_found("message cursor was not found"))?;
    Ok((row.try_get("sent_at")?, row.try_get("id")?))
}

async fn fetch_read_receipt_tx(
    tx: &mut Transaction<'_, Postgres>,
    thread_id: ThreadId,
    user_id: UserId,
) -> Result<ReadReceiptSummary, PgMessengerError> {
    let row = sqlx::query(
        r#"
        SELECT thread_id, user_id, last_read_message_id, read_at, updated_at
        FROM messenger_read_receipts
        WHERE thread_id = $1 AND user_id = $2
        "#,
    )
    .bind(*thread_id.as_uuid())
    .bind(*user_id.as_uuid())
    .fetch_one(tx.as_mut())
    .await?;
    Ok(ReadReceiptSummary {
        thread_id: ThreadId::from_uuid(row.try_get("thread_id")?),
        user_id: UserId::from_uuid(row.try_get("user_id")?),
        last_read_message_id: MessageId::from_uuid(row.try_get("last_read_message_id")?),
        read_at: row.try_get("read_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn push_scope_filter(
    builder: &mut QueryBuilder<Postgres>,
    column: &str,
    scope: &BranchScope,
) -> Result<(), PgMessengerError> {
    match scope {
        BranchScope::All => Ok(()),
        BranchScope::Branches(branches) if branches.is_empty() => {
            builder.push(" AND false");
            Ok(())
        }
        BranchScope::Branches(branches) => {
            let branch_ids: Vec<uuid::Uuid> =
                branches.iter().map(|branch| *branch.as_uuid()).collect();
            builder.push(" AND ");
            builder.push(column);
            builder.push(" = ANY(");
            builder.push_bind(branch_ids);
            builder.push(")");
            Ok(())
        }
    }
}

fn kernel_error_from_messenger_error(err: PgMessengerError) -> KernelError {
    match err {
        PgMessengerError::Domain(err) => err,
        PgMessengerError::Db(err) => KernelError::new(
            ErrorKind::Internal,
            format!("messenger store failed: {err}"),
        ),
    }
}
