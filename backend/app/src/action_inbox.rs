//! Unified my-action-inbox read model (`GET /api/v1/me/action-inbox`).
//!
//! The overview screen's `items[]` needs ONE endpoint returning the caller's
//! actionable items across every source that already owns a person-scoped list.
//! This module is a thin server-side fan-in: it runs ONE bounded, org+principal
//! scoped query per source (no N+1 per item) and maps each into a single unified
//! shape. It never widens visibility — every source is queried through the exact
//! predicate its own list endpoint uses:
//!   * approval/workflow tasks -> `workflow_studio::my_action_inbox_tasks`
//!     (the `?assignee=me` path + `task_visible` gate);
//!   * dispatch offers -> `PgDispatchStore::list_my_pending_offers`
//!     (person-scoped by construction);
//!   * support tickets -> `PgSupportStore::list_tickets` with
//!     `assignee_user_id = me` under the caller's `branch_scope`;
//!   * work orders -> a bounded query gated on an assignment to the caller
//!     (the same assignment that authorises the mobile detail read).
//!
//! Fields the prototype `items[]` shape carries but NO backend source can honestly
//! supply are OMITTED from the response (never fabricated): `entity`, `amount`,
//! `detail[]`, `files[]`, `stats` (analytics/sparkline gap), `mailId`,
//! `doneLabel`/`doneTone`, and canonical object ref codes (the object-code
//! issuance would be an N+1 objects-resolve per row). `site`/`who`/`submitted` are
//! emitted only for the sources that carry them.
//!
//! Attendance exceptions are NOT aggregated: the attendance-exception queue is a
//! backend gap (no exception object exists today), so there is nothing to read.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Extension, Json, Router};
use mnt_dispatch_adapter_postgres::PgDispatchStore;
use mnt_kernel_core::{ErrorKind, KernelError};
use mnt_platform_auth::JwtVerifier;
use mnt_platform_authz::Principal;
use mnt_platform_db::{DbError, with_org_conn};
use mnt_support_adapter_postgres::PgSupportStore;
use mnt_support_application::ListTicketsQuery;
use mnt_support_domain::TicketStatus;
use serde::Serialize;
use sqlx::{PgPool, Row};
use time::{Duration, OffsetDateTime};

use crate::workflow_studio;

pub const ME_ACTION_INBOX_PATH: &str = "/api/v1/me/action-inbox";

/// Hard per-source and total caps so a busy principal can never trigger an
/// unbounded fan-in. Each source is already bounded server-side; this is the
/// belt-and-braces ceiling on the merged result.
const PER_SOURCE_CAP: usize = 100;
const TOTAL_CAP: usize = 200;

#[derive(Clone)]
pub struct ActionInboxState {
    pool: PgPool,
    jwt_verifier: Option<JwtVerifier>,
}

impl ActionInboxState {
    #[must_use]
    pub fn new(pool: PgPool, jwt_verifier: Option<JwtVerifier>) -> Self {
        Self { pool, jwt_verifier }
    }
}

pub fn router(state: ActionInboxState) -> Router {
    let verifier = state.jwt_verifier.clone();
    let pool = state.pool.clone();
    let router = Router::new()
        .route(ME_ACTION_INBOX_PATH, get(list_action_inbox))
        .with_state(state);
    mnt_platform_request_context::with_request_context(router, verifier, pool)
}

/// One unified actionable item. Field names mirror the prototype `items[]` shape
/// (camelCase) so the web can consume it directly; source-partial fields are
/// omitted when absent rather than sent as null noise.
#[derive(Debug, Serialize)]
struct InboxItem {
    /// `"{kind}:{uuid}"` — stable, source-namespaced so ids never collide.
    id: String,
    kind: &'static str,
    urg: &'static str,
    #[serde(rename = "ref")]
    ref_code: String,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    site: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    who: Option<String>,
    #[serde(
        rename = "due",
        with = "time::serde::rfc3339::option",
        skip_serializing_if = "Option::is_none"
    )]
    due: Option<OffsetDateTime>,
    #[serde(rename = "dueTone")]
    due_tone: &'static str,
    #[serde(
        with = "time::serde::rfc3339::option",
        skip_serializing_if = "Option::is_none"
    )]
    submitted: Option<OffsetDateTime>,
    links: Vec<InboxLink>,
    done: bool,
}

#[derive(Debug, Serialize)]
struct InboxLink {
    kind: String,
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
}

#[derive(Debug, Serialize)]
struct ActionInboxResponse {
    items: Vec<InboxItem>,
    total: usize,
}

/// Urgency bucket + due tone derived from the due timestamp.
///
// ponytail: fixed 24h "today" window heuristic (overdue -> now, due within a day
// -> today, else wait). Swap for a per-source SLA policy if the product defines
// differentiated SLAs; the shape does not change.
fn urgency(due: Option<OffsetDateTime>, now: OffsetDateTime) -> (&'static str, &'static str) {
    match due {
        None => ("wait", "neutral"),
        Some(d) if d <= now => ("now", "danger"),
        Some(d) if d <= now + Duration::hours(24) => ("today", "warn"),
        Some(_) => ("wait", "neutral"),
    }
}

fn urg_rank(urg: &str) -> u8 {
    match urg {
        "now" => 0,
        "today" => 1,
        _ => 2,
    }
}

async fn list_action_inbox(
    State(state): State<ActionInboxState>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<ActionInboxResponse>, InboxError> {
    let now = OffsetDateTime::now_utc();
    let mut items: Vec<InboxItem> = Vec::new();

    // --- approval / workflow tasks (assignee=me path + task_visible gate) -----
    let tasks = workflow_studio::my_action_inbox_tasks(&state.pool, &principal)
        .await
        .map_err(|_| InboxError::internal("failed to load workflow tasks"))?;
    for task in tasks.into_iter().take(PER_SOURCE_CAP) {
        let (urg, due_tone) = urgency(task.due_at, now);
        // ref: object reference when the run is bound to an object, else the run
        // id. NOT a canonical AP- code (that would need an objects-resolve per row).
        let ref_code = task
            .object_id
            .map(|id| id.to_string())
            .unwrap_or_else(|| task.run_id.to_string());
        let mut links = Vec::new();
        if let (Some(object_type), Some(object_id)) = (task.object_type.clone(), task.object_id) {
            links.push(InboxLink {
                kind: canonical_action_link_kind(&object_type).to_owned(),
                id: object_id.to_string(),
                label: None,
            });
        } else {
            links.push(InboxLink {
                kind: "approval_run".to_owned(),
                id: task.run_id.to_string(),
                label: None,
            });
        }
        items.push(InboxItem {
            id: format!("approval:{}", task.task_id),
            kind: "approval",
            urg,
            ref_code,
            title: task.title,
            site: None,
            who: None,
            due: task.due_at,
            due_tone,
            submitted: None,
            links,
            done: false,
        });
    }

    // --- dispatch offers (person-scoped by construction) ----------------------
    let offers = PgDispatchStore::new(state.pool.clone())
        .list_my_pending_offers(principal.user_id, now)
        .await
        .map_err(|_| InboxError::internal("failed to load dispatch offers"))?;
    for offer in offers.into_iter().take(PER_SOURCE_CAP) {
        let due = Some(offer.accept_window_ends_at);
        let (urg, due_tone) = urgency(due, now);
        items.push(InboxItem {
            id: format!("dispatch:{}", offer.dispatch_id),
            kind: "dispatch",
            urg,
            ref_code: offer.request_no.clone(),
            title: offer.request_no,
            site: None,
            who: Some("미배정".to_owned()),
            due,
            due_tone,
            submitted: Some(offer.accept_window_started_at),
            links: vec![InboxLink {
                kind: "work_order".to_owned(),
                id: offer.work_order_id.to_string(),
                label: None,
            }],
            done: false,
        });
    }

    // --- support tickets assigned to me (same scope as the list endpoint) -----
    let tickets = PgSupportStore::new(state.pool.clone())
        .list_tickets(ListTicketsQuery {
            branch_scope: principal.branch_scope.clone(),
            status: None,
            priority: None,
            category: None,
            origin: None,
            assignee_user_id: Some(principal.user_id),
            // Never surface untriaged cross-org intake through the personal inbox.
            include_untriaged: false,
            limit: Some(PER_SOURCE_CAP as i64),
            cursor: None,
        })
        .await
        .map_err(|_| InboxError::internal("failed to load support tickets"))?;
    for ticket in tickets.items {
        // Only non-terminal tickets are "actionable"; resolved/closed drop out.
        if matches!(ticket.status, TicketStatus::Resolved | TicketStatus::Closed) {
            continue;
        }
        let (urg, due_tone) = urgency(ticket.due_at, now);
        items.push(InboxItem {
            id: format!("support:{}", ticket.id),
            kind: "support",
            urg,
            // ref: ticket id — support tickets carry no human CS- code today.
            ref_code: ticket.id.to_string(),
            title: ticket.title,
            site: None,
            who: ticket.assignee_name,
            due: ticket.due_at,
            due_tone,
            submitted: Some(ticket.created_at),
            links: vec![InboxLink {
                kind: "support_ticket".to_owned(),
                id: ticket.id.to_string(),
                label: None,
            }],
            done: false,
        });
    }

    // --- work orders assigned to me -------------------------------------------
    // Bounded, org-scoped (RLS via with_org_conn) query gated on an assignment to
    // the caller — the assignment IS the access boundary (same predicate the
    // mobile detail read authorises on), strictly narrower than a branch scope, so
    // it cannot widen visibility. Terminal statuses drop out.
    let org = principal.org_id;
    let user_uuid = *principal.user_id.as_uuid();
    let work_rows = with_org_conn::<_, Vec<WorkOrderRow>, DbError>(&state.pool, org, move |tx| {
        Box::pin(async move {
            let rows = sqlx::query(
                r#"
                SELECT w.id, w.request_no, w.target_due_at, w.created_at,
                       s.name AS site_name
                FROM work_orders w
                JOIN registry_sites s ON s.id = w.site_id
                WHERE w.status NOT IN ('FINAL_COMPLETED', 'REJECTED', 'CANCELLED')
                  AND EXISTS (
                      SELECT 1 FROM work_order_assignments a
                      WHERE a.work_order_id = w.id AND a.mechanic_id = $1
                  )
                ORDER BY w.target_due_at ASC NULLS LAST, w.created_at ASC, w.id ASC
                LIMIT $2
                "#,
            )
            .bind(user_uuid)
            .bind(PER_SOURCE_CAP as i64)
            .fetch_all(tx.as_mut())
            .await?;
            rows.iter()
                .map(|row| {
                    Ok(WorkOrderRow {
                        id: row.try_get("id")?,
                        request_no: row.try_get("request_no")?,
                        target_due_at: row.try_get("target_due_at")?,
                        created_at: row.try_get("created_at")?,
                        site_name: row.try_get("site_name")?,
                    })
                })
                .collect::<Result<Vec<_>, DbError>>()
        })
    })
    .await?;
    for row in work_rows {
        let (urg, due_tone) = urgency(row.target_due_at, now);
        items.push(InboxItem {
            id: format!("work:{}", row.id),
            kind: "work",
            urg,
            ref_code: row.request_no.clone(),
            title: row.request_no,
            site: Some(row.site_name),
            who: None,
            due: row.target_due_at,
            due_tone,
            submitted: Some(row.created_at),
            links: vec![InboxLink {
                kind: "work_order".to_owned(),
                id: row.id.to_string(),
                label: None,
            }],
            done: false,
        });
    }

    // Merge order: urgency bucket, then soonest due, then stable by id.
    items.sort_by(|a, b| {
        urg_rank(a.urg)
            .cmp(&urg_rank(b.urg))
            .then_with(|| match (a.due, b.due) {
                (Some(x), Some(y)) => x.cmp(&y),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            })
            .then_with(|| a.id.cmp(&b.id))
    });
    items.truncate(TOTAL_CAP);

    let total = items.len();
    Ok(Json(ActionInboxResponse { items, total }))
}

/// `approval_run` is the ontology/object-registry name used by the approval
/// surface. Older workflow rows may still carry `workflow_run`; normalize that
/// alias at this boundary so clients never need two names for one object kind.
fn canonical_action_link_kind(kind: &str) -> &str {
    if kind == "workflow_run" {
        "approval_run"
    } else {
        kind
    }
}

struct WorkOrderRow {
    id: uuid::Uuid,
    request_no: String,
    target_due_at: Option<OffsetDateTime>,
    created_at: OffsetDateTime,
    site_name: String,
}

#[derive(Debug)]
struct InboxError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl InboxError {
    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "internal",
            message: message.into(),
        }
    }
}

impl From<KernelError> for InboxError {
    fn from(error: KernelError) -> Self {
        let status = match error.kind {
            ErrorKind::Validation => StatusCode::UNPROCESSABLE_ENTITY,
            ErrorKind::Forbidden => StatusCode::FORBIDDEN,
            ErrorKind::NotFound => StatusCode::NOT_FOUND,
            ErrorKind::Conflict | ErrorKind::InvalidTransition => StatusCode::CONFLICT,
            ErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        };
        Self {
            status,
            code: "error",
            message: error.message,
        }
    }
}

impl From<DbError> for InboxError {
    fn from(error: DbError) -> Self {
        tracing::error!(error = %error, "action-inbox database error");
        Self::internal("internal server error")
    }
}

impl IntoResponse for InboxError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(serde_json::json!({
                "error": { "code": self.code, "message": self.message }
            })),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::canonical_action_link_kind;

    #[test]
    fn normalizes_the_legacy_workflow_run_alias() {
        assert_eq!(canonical_action_link_kind("workflow_run"), "approval_run");
        assert_eq!(canonical_action_link_kind("approval_run"), "approval_run");
        assert_eq!(canonical_action_link_kind("work_order"), "work_order");
    }
}
