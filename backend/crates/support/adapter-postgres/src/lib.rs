//! Postgres adapter for the support-ticket domain.
//!
//! Every mutation routes through `with_audit`/`with_audits` so an `audit_events`
//! row lands in the SAME transaction as the state change (audit-coverage gate).
//! All reads are branch-scoped; `BranchScope::All` (SUPER_ADMIN/EXECUTIVE) sees
//! cross-branch rollups like reporting.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use mnt_kernel_core::{
    BranchId, BranchScope, ErrorKind, KernelError, SupportTicketCommentId, SupportTicketId, UserId,
};
use mnt_platform_db::{DbError, with_audit, with_audits};
use mnt_support_application::{
    AddCommentCommand, AssignTicketCommand, CommentAudience, CommentView,
    CreateCustomerIntakeCommand, CreateInternalTicketCommand, ListTicketsQuery, TicketDetail,
    TicketNotification, TicketNotificationKind, TicketSummary, TransitionTicketCommand,
    support_audit_event,
};
use mnt_support_domain::{SlaPolicy, TicketCategory, TicketOrigin, TicketPriority, TicketStatus};
use sqlx::{PgPool, Postgres, QueryBuilder, Row, Transaction};
use time::OffsetDateTime;

#[derive(Debug, thiserror::Error)]
pub enum PgSupportError {
    #[error(transparent)]
    Db(#[from] DbError),

    #[error(transparent)]
    Domain(#[from] KernelError),
}

impl PgSupportError {
    #[must_use]
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::Domain(error) => error.kind,
            Self::Db(DbError::Sqlx(sqlx::Error::RowNotFound)) => ErrorKind::NotFound,
            Self::Db(DbError::Sqlx(sqlx::Error::Database(error)))
                if error.code().is_some_and(|code| code == "23505") =>
            {
                ErrorKind::Conflict
            }
            Self::Db(_) => ErrorKind::Internal,
        }
    }
}

impl From<sqlx::Error> for PgSupportError {
    fn from(value: sqlx::Error) -> Self {
        Self::Db(DbError::Sqlx(value))
    }
}

#[derive(Debug, Clone)]
pub struct PgSupportStore {
    pool: PgPool,
    sla: SlaPolicy,
}

impl PgSupportStore {
    #[must_use]
    pub fn new(pool: PgPool) -> Self {
        Self {
            pool,
            sla: SlaPolicy::default(),
        }
    }

    /// Override the default priority→SLA mapping (deployment-configurable).
    #[must_use]
    pub fn with_sla_policy(mut self, sla: SlaPolicy) -> Self {
        self.sla = sla;
        self
    }

    #[must_use]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    // -----------------------------------------------------------------------
    // create_internal_ticket
    // -----------------------------------------------------------------------
    pub async fn create_internal_ticket(
        &self,
        command: CreateInternalTicketCommand,
    ) -> Result<TicketSummary, PgSupportError> {
        let title = require_non_empty(&command.title, "support ticket title is required")?;
        require_max_chars(&title, MAX_TITLE_CHARS, "support ticket title is too long")?;
        let body = require_non_empty(&command.body, "support ticket body is required")?;
        require_max_chars(&body, MAX_BODY_CHARS, "support ticket body is too long")?;
        let ticket_id = SupportTicketId::new();
        let due_at = self.sla.due_at(command.priority, command.occurred_at)?;
        let event = support_audit_event(
            "support.ticket.create_internal",
            Some(command.actor),
            Some(command.branch_id),
            "support_ticket",
            ticket_id,
            command.trace.clone(),
            command.occurred_at,
        )?
        .with_snapshots(
            None,
            Some(serde_json::json!({
                "origin": TicketOrigin::Internal.as_db_str(),
                "category": command.category.as_db_str(),
                "priority": command.priority.as_db_str(),
                "status": TicketStatus::Open.as_db_str(),
                "branch_id": command.branch_id.to_string(),
            })),
        );

        with_audit::<_, TicketSummary, PgSupportError>(&self.pool, event, |tx| {
            Box::pin(async move {
                ensure_active_user_in_branch(tx, command.actor, command.branch_id).await?;
                sqlx::query(
                    r#"
                    INSERT INTO support_tickets (
                        id, branch_id, origin, category, priority, status,
                        title, body, requester_user_id, due_at, created_at, updated_at
                    )
                    VALUES ($1, $2, 'INTERNAL', $3, $4, 'OPEN', $5, $6, $7, $8, $9, $9)
                    "#,
                )
                .bind(*ticket_id.as_uuid())
                .bind(*command.branch_id.as_uuid())
                .bind(command.category.as_db_str())
                .bind(command.priority.as_db_str())
                .bind(&title)
                .bind(&body)
                .bind(*command.actor.as_uuid())
                .bind(due_at)
                .bind(command.occurred_at)
                .execute(tx.as_mut())
                .await?;

                fetch_summary_tx(tx, ticket_id).await
            })
        })
        .await
    }

    // -----------------------------------------------------------------------
    // create_customer_intake (unauthenticated channel)
    // -----------------------------------------------------------------------
    pub async fn create_customer_intake(
        &self,
        command: CreateCustomerIntakeCommand,
    ) -> Result<TicketSummary, PgSupportError> {
        let title = require_non_empty(&command.title, "support ticket title is required")?;
        require_max_chars(&title, MAX_TITLE_CHARS, "support ticket title is too long")?;
        let body = require_non_empty(&command.body, "support ticket body is required")?;
        require_max_chars(&body, MAX_BODY_CHARS, "support ticket body is too long")?;
        let requester_name =
            require_non_empty(&command.requester_name, "requester name is required")?;
        require_max_chars(
            &requester_name,
            MAX_REQUESTER_NAME_CHARS,
            "requester name is too long",
        )?;
        let requester_contact =
            require_non_empty(&command.requester_contact, "requester contact is required")?;
        require_max_chars(
            &requester_contact,
            MAX_REQUESTER_CONTACT_CHARS,
            "requester contact is too long",
        )?;
        let ticket_id = SupportTicketId::new();
        let due_at = self.sla.due_at(command.priority, command.occurred_at)?;
        // No actor, no branch: the audit snapshot deliberately omits the PII
        // contact — it is never copied into audit_events.
        let event = support_audit_event(
            "support.ticket.create_customer",
            None,
            None,
            "support_ticket",
            ticket_id,
            command.trace.clone(),
            command.occurred_at,
        )?
        .with_snapshots(
            None,
            Some(serde_json::json!({
                "origin": TicketOrigin::Customer.as_db_str(),
                "category": command.category.as_db_str(),
                "priority": command.priority.as_db_str(),
                "status": TicketStatus::Open.as_db_str(),
            })),
        );

        with_audit::<_, TicketSummary, PgSupportError>(&self.pool, event, |tx| {
            Box::pin(async move {
                sqlx::query(
                    r#"
                    INSERT INTO support_tickets (
                        id, branch_id, origin, category, priority, status,
                        title, body, requester_name, requester_contact,
                        due_at, created_at, updated_at
                    )
                    VALUES ($1, NULL, 'CUSTOMER', $2, $3, 'OPEN', $4, $5, $6, $7, $8, $9, $9)
                    "#,
                )
                .bind(*ticket_id.as_uuid())
                .bind(command.category.as_db_str())
                .bind(command.priority.as_db_str())
                .bind(&title)
                .bind(&body)
                .bind(&requester_name)
                .bind(&requester_contact)
                .bind(due_at)
                .bind(command.occurred_at)
                .execute(tx.as_mut())
                .await?;

                fetch_summary_tx(tx, ticket_id).await
            })
        })
        .await
    }

    // -----------------------------------------------------------------------
    // assign_ticket
    // -----------------------------------------------------------------------
    pub async fn assign_ticket(
        &self,
        command: AssignTicketCommand,
    ) -> Result<(TicketSummary, Vec<TicketNotification>), PgSupportError> {
        with_audits::<_, (TicketSummary, Vec<TicketNotification>), PgSupportError>(
            &self.pool,
            |tx| {
                Box::pin(async move {
                    let ticket = lock_ticket_tx(tx, command.ticket_id).await?;
                    // Resolve the effective branch: a branch-less customer ticket
                    // must be triaged into a branch on assignment.
                    let effective_branch = match ticket.branch_id {
                        Some(branch) => branch,
                        None => command.branch_id.ok_or_else(|| {
                            KernelError::validation(
                                "branch_id is required to triage an untriaged customer ticket",
                            )
                        })?,
                    };
                    ensure_active_user_in_branch(tx, command.assignee_user_id, effective_branch)
                        .await?;

                    sqlx::query(
                        r#"
                        UPDATE support_tickets
                        SET assignee_user_id = $2,
                            branch_id = $3,
                            updated_at = $4
                        WHERE id = $1
                        "#,
                    )
                    .bind(*command.ticket_id.as_uuid())
                    .bind(*command.assignee_user_id.as_uuid())
                    .bind(*effective_branch.as_uuid())
                    .bind(command.occurred_at)
                    .execute(tx.as_mut())
                    .await?;

                    let summary = fetch_summary_tx(tx, command.ticket_id).await?;
                    let event = support_audit_event(
                        "support.ticket.assign",
                        Some(command.actor),
                        Some(effective_branch),
                        "support_ticket",
                        command.ticket_id,
                        command.trace.clone(),
                        command.occurred_at,
                    )?
                    .with_snapshots(
                        Some(serde_json::json!({
                            "assignee_user_id": ticket.assignee_user_id.map(|id| id.to_string()),
                            "branch_id": ticket.branch_id.map(|id| id.to_string()),
                        })),
                        Some(serde_json::json!({
                            "assignee_user_id": command.assignee_user_id.to_string(),
                            "branch_id": effective_branch.to_string(),
                        })),
                    );
                    let notifications = vec![TicketNotification::new(
                        command.ticket_id,
                        command.assignee_user_id,
                        TicketNotificationKind::Assigned,
                        "A support ticket was assigned to you.",
                    )];
                    Ok(((summary, notifications), vec![event]))
                })
            },
        )
        .await
    }

    // -----------------------------------------------------------------------
    // transition_status
    // -----------------------------------------------------------------------
    pub async fn transition_status(
        &self,
        command: TransitionTicketCommand,
    ) -> Result<(TicketSummary, Vec<TicketNotification>), PgSupportError> {
        with_audits::<_, (TicketSummary, Vec<TicketNotification>), PgSupportError>(
            &self.pool,
            |tx| {
                Box::pin(async move {
                    let ticket = lock_ticket_tx(tx, command.ticket_id).await?;
                    // FSM enforcement lives in the pure domain.
                    let transition = ticket.status.transition_to(command.to_status)?;
                    let resolved_at = resolved_timestamp(
                        ticket.resolved_at,
                        command.to_status,
                        command.occurred_at,
                    );
                    let closed_at =
                        closed_timestamp(ticket.closed_at, command.to_status, command.occurred_at);

                    sqlx::query(
                        r#"
                        UPDATE support_tickets
                        SET status = $2,
                            resolved_at = $3,
                            closed_at = $4,
                            updated_at = $5
                        WHERE id = $1
                        "#,
                    )
                    .bind(*command.ticket_id.as_uuid())
                    .bind(command.to_status.as_db_str())
                    .bind(resolved_at)
                    .bind(closed_at)
                    .bind(command.occurred_at)
                    .execute(tx.as_mut())
                    .await?;

                    let summary = fetch_summary_tx(tx, command.ticket_id).await?;
                    let event = support_audit_event(
                        "support.ticket.transition",
                        Some(command.actor),
                        ticket.branch_id,
                        "support_ticket",
                        command.ticket_id,
                        command.trace.clone(),
                        command.occurred_at,
                    )?
                    .with_snapshots(
                        Some(serde_json::json!({ "status": transition.from.as_db_str() })),
                        Some(serde_json::json!({ "status": transition.to.as_db_str() })),
                    );
                    let notifications =
                        status_change_notifications(&ticket, command.ticket_id, command.to_status);
                    Ok(((summary, notifications), vec![event]))
                })
            },
        )
        .await
    }

    // -----------------------------------------------------------------------
    // add_comment
    // -----------------------------------------------------------------------
    pub async fn add_comment(
        &self,
        command: AddCommentCommand,
    ) -> Result<(CommentView, Vec<TicketNotification>), PgSupportError> {
        let body = require_non_empty(&command.body, "comment body is required")?;
        let comment_id = SupportTicketCommentId::new();

        with_audits::<_, (CommentView, Vec<TicketNotification>), PgSupportError>(&self.pool, |tx| {
            Box::pin(async move {
                let ticket = lock_ticket_tx(tx, command.ticket_id).await?;
                ensure_author_visible_to_ticket(tx, command.actor, &ticket).await?;

                sqlx::query(
                    r#"
                        INSERT INTO support_ticket_comments (
                            id, ticket_id, author_user_id, body, is_internal_note, created_at
                        )
                        VALUES ($1, $2, $3, $4, $5, $6)
                        "#,
                )
                .bind(*comment_id.as_uuid())
                .bind(*command.ticket_id.as_uuid())
                .bind(*command.actor.as_uuid())
                .bind(&body)
                .bind(command.is_internal_note)
                .bind(command.occurred_at)
                .execute(tx.as_mut())
                .await?;

                sqlx::query("UPDATE support_tickets SET updated_at = $2 WHERE id = $1")
                    .bind(*command.ticket_id.as_uuid())
                    .bind(command.occurred_at)
                    .execute(tx.as_mut())
                    .await?;

                let view = fetch_comment_tx(tx, comment_id).await?;
                let event = support_audit_event(
                    "support.ticket.comment",
                    Some(command.actor),
                    ticket.branch_id,
                    "support_ticket_comment",
                    comment_id,
                    command.trace.clone(),
                    command.occurred_at,
                )?
                .with_snapshots(
                    None,
                    Some(serde_json::json!({
                        "ticket_id": command.ticket_id.to_string(),
                        "is_internal_note": command.is_internal_note,
                    })),
                );
                // Internal notes do not notify the requester; non-internal
                // comments notify requester + assignee (excluding the author).
                let notifications = if command.is_internal_note {
                    Vec::new()
                } else {
                    comment_notifications(&ticket, command.ticket_id, command.actor)
                };
                Ok(((view, notifications), vec![event]))
            })
        })
        .await
    }

    // -----------------------------------------------------------------------
    // list_tickets (branch-scoped + filters)
    // -----------------------------------------------------------------------
    pub async fn list_tickets(
        &self,
        query: ListTicketsQuery,
    ) -> Result<Vec<TicketSummary>, PgSupportError> {
        // Always clamp to a hard server-side cap so an unbounded fetch is
        // impossible, even when the client sends no limit.
        let limit = normalized_limit(query.limit);
        // Resolve the keyset cursor up front; an unknown cursor is a not-found.
        let cursor = match query.cursor {
            Some(cursor_id) => Some(ticket_cursor(&self.pool, cursor_id).await?),
            None => None,
        };

        let mut builder = QueryBuilder::<Postgres>::new(
            r#"
            SELECT
                id, branch_id, origin, category, priority, status, title,
                requester_user_id, requester_name, assignee_user_id, due_at,
                created_at, updated_at, resolved_at, closed_at
            FROM support_tickets
            WHERE (
            "#,
        );
        // Branch scoping: cross-branch principals may additionally opt into the
        // untriaged (branch_id IS NULL) intake queue.
        push_branch_scope(&mut builder, &query.branch_scope, query.include_untriaged);
        builder.push(")");

        if let Some(status) = query.status {
            builder.push(" AND status = ");
            builder.push_bind(status.as_db_str());
        }
        if let Some(priority) = query.priority {
            builder.push(" AND priority = ");
            builder.push_bind(priority.as_db_str());
        }
        if let Some(category) = query.category {
            builder.push(" AND category = ");
            builder.push_bind(category.as_db_str());
        }
        if let Some(origin) = query.origin {
            builder.push(" AND origin = ");
            builder.push_bind(origin.as_db_str());
        }
        if let Some(assignee) = query.assignee_user_id {
            builder.push(" AND assignee_user_id = ");
            builder.push_bind(*assignee.as_uuid());
        }
        // Keyset: strictly after the cursor on the (created_at DESC, id) order.
        if let Some((created_at, id)) = cursor {
            builder.push(" AND (created_at, id) < (");
            builder.push_bind(created_at);
            builder.push(", ");
            builder.push_bind(id);
            builder.push(")");
        }
        builder.push(" ORDER BY created_at DESC, id DESC LIMIT ");
        builder.push_bind(limit);

        let rows = builder.build().fetch_all(&self.pool).await?;
        rows.iter().map(summary_from_row).collect()
    }

    // -----------------------------------------------------------------------
    // get_ticket (+ comments, audience-filtered)
    // -----------------------------------------------------------------------
    pub async fn get_ticket(
        &self,
        ticket_id: SupportTicketId,
        branch_scope: &BranchScope,
        audience: CommentAudience,
    ) -> Result<TicketDetail, PgSupportError> {
        let mut builder = QueryBuilder::<Postgres>::new(
            r#"
            SELECT
                id, branch_id, origin, category, priority, status, title,
                requester_user_id, requester_name, assignee_user_id, due_at,
                created_at, updated_at, resolved_at, closed_at
            FROM support_tickets
            WHERE id =
            "#,
        );
        builder.push_bind(*ticket_id.as_uuid());
        builder.push(" AND (");
        // A branch-less customer ticket is only visible to cross-branch staff.
        push_branch_scope(&mut builder, branch_scope, true);
        builder.push(")");
        let row = builder
            .build()
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| KernelError::not_found("support ticket was not found"))?;
        let ticket = summary_from_row(&row)?;

        let comments = self.list_comments(ticket_id, audience).await?;
        Ok(TicketDetail { ticket, comments })
    }

    async fn list_comments(
        &self,
        ticket_id: SupportTicketId,
        audience: CommentAudience,
    ) -> Result<Vec<CommentView>, PgSupportError> {
        let mut builder = QueryBuilder::<Postgres>::new(
            r#"
            SELECT id, ticket_id, author_user_id, body, is_internal_note, created_at
            FROM support_ticket_comments
            WHERE ticket_id =
            "#,
        );
        builder.push_bind(*ticket_id.as_uuid());
        if !audience.shows_internal_notes() {
            // Customer-visible path never returns internal staff notes.
            builder.push(" AND is_internal_note = FALSE");
        }
        builder.push(" ORDER BY created_at, id");
        let rows = builder.build().fetch_all(&self.pool).await?;
        rows.iter().map(comment_from_row).collect()
    }

    /// Atomically increment (or insert) the fixed-window rate-limit counter for
    /// one bucket and return the new attempt count. Shares the `auth_rate_limit`
    /// table and the same UPSERT semantics the auth endpoints use; the
    /// `endpoint` key (e.g. `support_intake`) isolates the support buckets.
    ///
    /// This is a coarse counter, not an audited state change — it deliberately
    /// lives in the adapter (not a REST handler surface) so it is exempt from the
    /// audit-coverage gate, exactly as the auth crate's identical counter is.
    pub async fn increment_rate_bucket(
        &self,
        client_key: &str,
        endpoint: &str,
        window_start: OffsetDateTime,
    ) -> Result<i64, PgSupportError> {
        let attempts: i32 = sqlx::query_scalar(
            r#"
            INSERT INTO auth_rate_limit (client_key, endpoint, window_start, attempts)
            VALUES ($1, $2, $3, 1)
            ON CONFLICT (client_key, endpoint, window_start)
            DO UPDATE SET attempts = auth_rate_limit.attempts + 1
            RETURNING attempts
            "#,
        )
        .bind(client_key)
        .bind(endpoint)
        .bind(window_start)
        .fetch_one(&self.pool)
        .await?;
        Ok(i64::from(attempts))
    }

    /// Active push tokens for a staff recipient, for notification fan-out.
    pub async fn active_push_tokens(&self, user_id: UserId) -> Result<Vec<String>, PgSupportError> {
        let tokens: Vec<String> = sqlx::query_scalar(
            r#"
            SELECT push_token
            FROM registered_devices
            WHERE user_id = $1
              AND push_token IS NOT NULL
              AND btrim(push_token) <> ''
            "#,
        )
        .bind(*user_id.as_uuid())
        .fetch_all(&self.pool)
        .await?;
        Ok(tokens)
    }

    /// Resolve the branch of a ticket within scope, for REST authorization.
    pub async fn ticket_branch_in_scope(
        &self,
        ticket_id: SupportTicketId,
        branch_scope: &BranchScope,
    ) -> Result<Option<BranchId>, PgSupportError> {
        let mut builder =
            QueryBuilder::<Postgres>::new("SELECT branch_id FROM support_tickets WHERE id = ");
        builder.push_bind(*ticket_id.as_uuid());
        builder.push(" AND (");
        push_branch_scope(&mut builder, branch_scope, true);
        builder.push(")");
        let row = builder
            .build()
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| KernelError::not_found("support ticket was not found"))?;
        let branch_id: Option<uuid::Uuid> = row.try_get("branch_id")?;
        Ok(branch_id.map(BranchId::from_uuid))
    }
}

// ---------------------------------------------------------------------------
// Locked-row model + tx helpers
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct LockedTicket {
    branch_id: Option<BranchId>,
    origin: TicketOrigin,
    status: TicketStatus,
    requester_user_id: Option<UserId>,
    assignee_user_id: Option<UserId>,
    resolved_at: Option<OffsetDateTime>,
    closed_at: Option<OffsetDateTime>,
}

async fn lock_ticket_tx(
    tx: &mut Transaction<'_, Postgres>,
    ticket_id: SupportTicketId,
) -> Result<LockedTicket, PgSupportError> {
    let row = sqlx::query(
        r#"
        SELECT branch_id, origin, status, requester_user_id, assignee_user_id,
               resolved_at, closed_at
        FROM support_tickets
        WHERE id = $1
        FOR UPDATE
        "#,
    )
    .bind(*ticket_id.as_uuid())
    .fetch_one(tx.as_mut())
    .await?;

    let origin_raw: String = row.try_get("origin")?;
    let status_raw: String = row.try_get("status")?;
    Ok(LockedTicket {
        branch_id: row
            .try_get::<Option<uuid::Uuid>, _>("branch_id")?
            .map(BranchId::from_uuid),
        origin: TicketOrigin::from_db_str(&origin_raw)?,
        status: TicketStatus::from_db_str(&status_raw)?,
        requester_user_id: row
            .try_get::<Option<uuid::Uuid>, _>("requester_user_id")?
            .map(UserId::from_uuid),
        assignee_user_id: row
            .try_get::<Option<uuid::Uuid>, _>("assignee_user_id")?
            .map(UserId::from_uuid),
        resolved_at: row.try_get("resolved_at")?,
        closed_at: row.try_get("closed_at")?,
    })
}

async fn ensure_active_user_in_branch(
    tx: &mut Transaction<'_, Postgres>,
    user_id: UserId,
    branch_id: BranchId,
) -> Result<(), PgSupportError> {
    let valid: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM users u
            JOIN user_branches ub ON ub.user_id = u.id
            WHERE u.id = $1
              AND ub.branch_id = $2
              AND u.is_active = TRUE
        )
        "#,
    )
    .bind(*user_id.as_uuid())
    .bind(*branch_id.as_uuid())
    .fetch_one(tx.as_mut())
    .await?;
    if valid {
        Ok(())
    } else {
        Err(
            KernelError::validation("support ticket user must be an active member of the branch")
                .into(),
        )
    }
}

/// A comment author must be an active staff user able to act on the ticket:
/// either a cross-branch admin, or a member of the ticket's branch. Branch-less
/// customer tickets accept any active staff user (triage stage).
async fn ensure_author_visible_to_ticket(
    tx: &mut Transaction<'_, Postgres>,
    author: UserId,
    ticket: &LockedTicket,
) -> Result<(), PgSupportError> {
    match ticket.branch_id {
        Some(branch) => ensure_active_user_in_branch(tx, author, branch).await,
        None => {
            let active: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM users WHERE id = $1 AND is_active = TRUE)",
            )
            .bind(*author.as_uuid())
            .fetch_one(tx.as_mut())
            .await?;
            if active {
                Ok(())
            } else {
                Err(KernelError::validation("comment author must be an active user").into())
            }
        }
    }
}

async fn fetch_summary_tx(
    tx: &mut Transaction<'_, Postgres>,
    ticket_id: SupportTicketId,
) -> Result<TicketSummary, PgSupportError> {
    let row = sqlx::query(
        r#"
        SELECT
            id, branch_id, origin, category, priority, status, title,
            requester_user_id, requester_name, assignee_user_id, due_at,
            created_at, updated_at, resolved_at, closed_at
        FROM support_tickets
        WHERE id = $1
        "#,
    )
    .bind(*ticket_id.as_uuid())
    .fetch_one(tx.as_mut())
    .await?;
    summary_from_row(&row)
}

async fn fetch_comment_tx(
    tx: &mut Transaction<'_, Postgres>,
    comment_id: SupportTicketCommentId,
) -> Result<CommentView, PgSupportError> {
    let row = sqlx::query(
        r#"
        SELECT id, ticket_id, author_user_id, body, is_internal_note, created_at
        FROM support_ticket_comments
        WHERE id = $1
        "#,
    )
    .bind(*comment_id.as_uuid())
    .fetch_one(tx.as_mut())
    .await?;
    comment_from_row(&row)
}

/// Resolve the `(created_at, id)` keyset coordinates for a cursor ticket so
/// `list_tickets` can page strictly after it. Mirrors messenger's
/// `message_cursor`. An unknown cursor is a not-found.
async fn ticket_cursor(
    pool: &PgPool,
    ticket_id: SupportTicketId,
) -> Result<(OffsetDateTime, uuid::Uuid), PgSupportError> {
    let row = sqlx::query("SELECT created_at, id FROM support_tickets WHERE id = $1")
        .bind(*ticket_id.as_uuid())
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| KernelError::not_found("support ticket cursor was not found"))?;
    Ok((row.try_get("created_at")?, row.try_get("id")?))
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/// Max-length bounds (in characters) for unauthenticated-intake and internal
/// ticket free-text fields, enforced server-side so the public intake channel
/// cannot store unbounded blobs.
pub const MAX_TITLE_CHARS: usize = 200;
pub const MAX_BODY_CHARS: usize = 8000;
pub const MAX_REQUESTER_NAME_CHARS: usize = 200;
pub const MAX_REQUESTER_CONTACT_CHARS: usize = 200;

fn require_non_empty(value: &str, message: &'static str) -> Result<String, PgSupportError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        Err(KernelError::validation(message).into())
    } else {
        Ok(trimmed.to_owned())
    }
}

/// Reject a field that exceeds `max` characters (Unicode scalar values, not
/// bytes). Used after [`require_non_empty`] so empty/whitespace is caught first.
fn require_max_chars(value: &str, max: usize, message: &'static str) -> Result<(), PgSupportError> {
    if value.chars().count() > max {
        Err(KernelError::validation(message).into())
    } else {
        Ok(())
    }
}

/// Default page size for [`PgSupportStore::list_tickets`] when the caller sends
/// no limit. The clamp in [`normalized_limit`] guarantees a hard server-side cap
/// regardless of the requested value.
const DEFAULT_LIST_LIMIT: i64 = 50;

/// Clamp a requested page size to `1..=100`, mirroring the messenger adapter, so
/// `list_tickets` can never issue an unbounded fetch.
fn normalized_limit(limit: Option<i64>) -> i64 {
    limit.unwrap_or(DEFAULT_LIST_LIMIT).clamp(1, 100)
}

/// Set `resolved_at` the first time a ticket enters RESOLVED; otherwise preserve
/// the existing value.
fn resolved_timestamp(
    existing: Option<OffsetDateTime>,
    to: TicketStatus,
    now: OffsetDateTime,
) -> Option<OffsetDateTime> {
    match to {
        TicketStatus::Resolved => existing.or(Some(now)),
        _ => existing,
    }
}

/// Set `closed_at` when a ticket enters CLOSED; otherwise preserve.
fn closed_timestamp(
    existing: Option<OffsetDateTime>,
    to: TicketStatus,
    now: OffsetDateTime,
) -> Option<OffsetDateTime> {
    match to {
        TicketStatus::Closed => existing.or(Some(now)),
        _ => existing,
    }
}

/// Status-change notifications: the assignee always, plus the internal requester
/// (customer requesters are not staff push recipients). The acting user is not
/// notified twice — but the actor isn't known here, so dedup is by recipient set.
fn status_change_notifications(
    ticket: &LockedTicket,
    ticket_id: SupportTicketId,
    to: TicketStatus,
) -> Vec<TicketNotification> {
    let mut recipients: Vec<UserId> = Vec::new();
    if let Some(assignee) = ticket.assignee_user_id {
        recipients.push(assignee);
    }
    if ticket.origin == TicketOrigin::Internal
        && let Some(requester) = ticket.requester_user_id
        && !recipients.contains(&requester)
    {
        recipients.push(requester);
    }
    recipients
        .into_iter()
        .map(|recipient| {
            TicketNotification::new(
                ticket_id,
                recipient,
                TicketNotificationKind::StatusChanged,
                format!("Support ticket status changed to {}.", to.as_db_str()),
            )
        })
        .collect()
}

/// Comment notifications for a non-internal comment: requester (if internal) and
/// assignee, excluding the comment author.
fn comment_notifications(
    ticket: &LockedTicket,
    ticket_id: SupportTicketId,
    author: UserId,
) -> Vec<TicketNotification> {
    let mut recipients: Vec<UserId> = Vec::new();
    if let Some(assignee) = ticket.assignee_user_id
        && assignee != author
    {
        recipients.push(assignee);
    }
    if ticket.origin == TicketOrigin::Internal
        && let Some(requester) = ticket.requester_user_id
        && requester != author
        && !recipients.contains(&requester)
    {
        recipients.push(requester);
    }
    recipients
        .into_iter()
        .map(|recipient| {
            TicketNotification::new(
                ticket_id,
                recipient,
                TicketNotificationKind::Commented,
                "A new reply was added to a support ticket.",
            )
        })
        .collect()
}

/// Branch-scope predicate. Untriaged (`branch_id IS NULL`) visibility is a
/// CROSS-BRANCH privilege: only a `BranchScope::All` principal ever sees
/// branch-less customer intake, and only when `include_untriaged` is set.
/// Branch-scoped principals never match NULL-branch rows regardless of the flag,
/// so the invariant is enforced here at the data layer, not just in REST.
fn push_branch_scope(
    builder: &mut QueryBuilder<Postgres>,
    branch_scope: &BranchScope,
    include_untriaged: bool,
) {
    match branch_scope {
        BranchScope::All => {
            if include_untriaged {
                // Every ticket, including untriaged intake.
                builder.push("TRUE");
            } else {
                // Cross-branch rollup, but exclude the untriaged queue.
                builder.push("branch_id IS NOT NULL");
            }
        }
        BranchScope::Branches(branches) if branches.is_empty() => {
            builder.push("FALSE");
        }
        BranchScope::Branches(branches) => {
            let branch_ids = branches
                .iter()
                .map(|branch_id| *branch_id.as_uuid())
                .collect::<Vec<_>>();
            builder.push("branch_id = ANY(");
            builder.push_bind(branch_ids);
            builder.push(")");
        }
    }
}

fn summary_from_row(row: &sqlx::postgres::PgRow) -> Result<TicketSummary, PgSupportError> {
    let origin_raw: String = row.try_get("origin")?;
    let category_raw: String = row.try_get("category")?;
    let priority_raw: String = row.try_get("priority")?;
    let status_raw: String = row.try_get("status")?;
    Ok(TicketSummary {
        id: SupportTicketId::from_uuid(row.try_get("id")?),
        branch_id: row
            .try_get::<Option<uuid::Uuid>, _>("branch_id")?
            .map(BranchId::from_uuid),
        origin: TicketOrigin::from_db_str(&origin_raw)?,
        category: TicketCategory::from_db_str(&category_raw)?,
        priority: TicketPriority::from_db_str(&priority_raw)?,
        status: TicketStatus::from_db_str(&status_raw)?,
        title: row.try_get("title")?,
        requester_user_id: row
            .try_get::<Option<uuid::Uuid>, _>("requester_user_id")?
            .map(UserId::from_uuid),
        requester_name: row.try_get("requester_name")?,
        assignee_user_id: row
            .try_get::<Option<uuid::Uuid>, _>("assignee_user_id")?
            .map(UserId::from_uuid),
        due_at: row.try_get("due_at")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        resolved_at: row.try_get("resolved_at")?,
        closed_at: row.try_get("closed_at")?,
    })
}

fn comment_from_row(row: &sqlx::postgres::PgRow) -> Result<CommentView, PgSupportError> {
    Ok(CommentView {
        id: SupportTicketCommentId::from_uuid(row.try_get("id")?),
        ticket_id: SupportTicketId::from_uuid(row.try_get("ticket_id")?),
        author_user_id: row
            .try_get::<Option<uuid::Uuid>, _>("author_user_id")?
            .map(UserId::from_uuid),
        body: row.try_get("body")?,
        is_internal_note: row.try_get("is_internal_note")?,
        created_at: row.try_get("created_at")?,
    })
}

#[cfg(test)]
mod tests {
    use super::{ErrorKind, MAX_BODY_CHARS, MAX_TITLE_CHARS, normalized_limit, require_max_chars};

    #[test]
    fn require_max_chars_accepts_at_the_boundary() {
        let at_limit = "x".repeat(MAX_TITLE_CHARS);
        assert!(require_max_chars(&at_limit, MAX_TITLE_CHARS, "too long").is_ok());
    }

    #[test]
    fn require_max_chars_rejects_over_the_boundary_with_validation() {
        let too_long = "x".repeat(MAX_TITLE_CHARS + 1);
        let err = require_max_chars(&too_long, MAX_TITLE_CHARS, "too long")
            .expect_err("over-limit value must be rejected");
        assert_eq!(err.kind(), ErrorKind::Validation);
    }

    #[test]
    fn require_max_chars_counts_unicode_scalars_not_bytes() {
        // Each Korean syllable is 3 bytes but 1 char; a string of MAX chars must
        // pass even though its byte length far exceeds the char limit.
        let korean = "가".repeat(MAX_BODY_CHARS);
        assert!(korean.len() > MAX_BODY_CHARS);
        assert!(require_max_chars(&korean, MAX_BODY_CHARS, "too long").is_ok());
        let over = "가".repeat(MAX_BODY_CHARS + 1);
        assert!(require_max_chars(&over, MAX_BODY_CHARS, "too long").is_err());
    }

    #[test]
    fn normalized_limit_clamps_and_defaults() {
        assert_eq!(normalized_limit(None), 50);
        assert_eq!(normalized_limit(Some(0)), 1);
        assert_eq!(normalized_limit(Some(-10)), 1);
        assert_eq!(normalized_limit(Some(50)), 50);
        assert_eq!(normalized_limit(Some(100)), 100);
        assert_eq!(normalized_limit(Some(1_000)), 100);
    }
}
