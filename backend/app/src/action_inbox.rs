//! Unified my-action-inbox read model (`GET /api/v1/me/action-inbox`).
//!
//! The overview screen's `items[]` needs ONE endpoint returning the caller's
//! actionable items across every source that already owns a person-scoped list.
//! This module is a thin server-side fan-in: it requests one bounded keyset page
//! per source (the workflow policy filter may consume bounded 200-row candidate
//! chunks) and maps them through a deterministic k-way merge. It never widens
//! visibility — every source is queried through the exact
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

use axum::extract::{Query, State};
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
use mnt_support_domain::TicketStatus;
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use time::{Duration, OffsetDateTime};

use crate::workflow_studio;

pub const ME_ACTION_INBOX_PATH: &str = "/api/v1/me/action-inbox";

const DEFAULT_PAGE_LIMIT: usize = 100;
const MAX_PAGE_LIMIT: usize = 200;

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
    /// Snapshot membership boundary. Internal only; never exposed on the wire.
    #[serde(skip)]
    created_at: OffsetDateTime,
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
    total_is_exact: bool,
    next_cursor: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct ActionInboxQuery {
    limit: Option<usize>,
    cursor: Option<String>,
}

#[derive(Debug, Clone)]
struct GlobalCursor {
    as_of: OffsetDateTime,
    due: Option<OffsetDateTime>,
    id: String,
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

async fn list_action_inbox(
    State(state): State<ActionInboxState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<ActionInboxQuery>,
) -> Result<Json<ActionInboxResponse>, InboxError> {
    let now = OffsetDateTime::now_utc();
    let cursor = query.cursor.as_deref().map(parse_cursor).transpose()?;
    let as_of = cursor.as_ref().map_or(now, |cursor| cursor.as_of);
    let limit = query
        .limit
        .unwrap_or(DEFAULT_PAGE_LIMIT)
        .clamp(1, MAX_PAGE_LIMIT);
    let mut items: Vec<InboxItem> = Vec::new();
    let after = cursor
        .as_ref()
        .map(|cursor| (cursor.due, cursor.id.clone()));
    let source_limit = i64::try_from(limit).unwrap_or(MAX_PAGE_LIMIT as i64);
    let mut total = 0usize;
    let mut total_is_exact = true;
    let mut source_has_more = false;

    // --- approval / workflow tasks (assignee=me path + task_visible gate) -----
    let (tasks, workflow_has_more) = workflow_studio::my_action_inbox_tasks_page(
        &state.pool,
        &principal,
        as_of,
        after.clone(),
        limit,
    )
    .await
    .map_err(|_| InboxError::internal("failed to load workflow tasks"))?;
    source_has_more |= workflow_has_more;
    let (workflow_total, workflow_total_exact) =
        workflow_studio::my_action_inbox_task_count(&state.pool, &principal, as_of)
            .await
            .map_err(|_| InboxError::internal("failed to count workflow tasks"))?;
    total += workflow_total;
    total_is_exact &= workflow_total_exact;
    for task in tasks {
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
            created_at: task.created_at,
        });
    }

    // --- dispatch offers (person-scoped by construction) ----------------------
    let (offers, dispatch_total, dispatch_has_more) = PgDispatchStore::new(state.pool.clone())
        .list_my_pending_offers_action_page(
            principal.user_id,
            as_of,
            as_of,
            after.clone(),
            source_limit,
        )
        .await
        .map_err(|_| InboxError::internal("failed to load dispatch offers"))?;
    total += usize::try_from(dispatch_total).unwrap_or(0);
    source_has_more |= dispatch_has_more;
    for offer in offers {
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
            created_at: offer.accept_window_started_at,
        });
    }

    // --- support tickets assigned to me (same scope as the list endpoint) -----
    let (support_items, support_total, support_has_more) = PgSupportStore::new(state.pool.clone())
        .list_assigned_action_inbox_page(
            principal.branch_scope.clone(),
            principal.user_id,
            as_of,
            after.clone(),
            source_limit,
        )
        .await
        .map_err(|_| InboxError::internal("failed to load support tickets"))?;
    total += usize::try_from(support_total).unwrap_or(0);
    source_has_more |= support_has_more;
    for ticket in support_items {
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
            created_at: ticket.created_at,
        });
    }

    // --- work orders assigned to me -------------------------------------------
    // Bounded, org-scoped (RLS via with_org_conn) query gated on an assignment to
    // the caller — the assignment IS the access boundary (same predicate the
    // mobile detail read authorises on), strictly narrower than a branch scope, so
    // it cannot widen visibility. Terminal statuses drop out.
    let org = principal.org_id;
    let user_uuid = *principal.user_id.as_uuid();
    let work_after = after.clone();
    let work_rows =
        with_org_conn::<_, (Vec<WorkOrderRow>, i64, bool), DbError>(&state.pool, org, move |tx| {
            Box::pin(async move {
                let total: i64 = sqlx::query_scalar(
                    r#"
                SELECT COUNT(*)
                FROM work_orders w
                WHERE w.status NOT IN ('FINAL_COMPLETED', 'REJECTED', 'CANCELLED')
                  AND w.created_at <= $2
                  AND EXISTS (
                      SELECT 1 FROM work_order_assignments a
                      WHERE a.work_order_id = w.id AND a.mechanic_id = $1
                  )
                "#,
                )
                .bind(user_uuid)
                .bind(as_of)
                .fetch_one(tx.as_mut())
                .await?;
                let (after_due, after_id) =
                    work_after.map_or((None, None), |(due, id)| (due, Some(id)));
                let rows = sqlx::query(
                    r#"
                SELECT w.id, w.request_no, w.target_due_at, w.created_at,
                       s.name AS site_name
                FROM work_orders w
                JOIN registry_sites s ON s.id = w.site_id
                WHERE w.status NOT IN ('FINAL_COMPLETED', 'REJECTED', 'CANCELLED')
                  AND w.created_at <= $2
                  AND EXISTS (
                      SELECT 1 FROM work_order_assignments a
                      WHERE a.work_order_id = w.id AND a.mechanic_id = $1
                  )
                  AND ($4::text IS NULL
                       OR ($3::timestamptz IS NULL AND w.target_due_at IS NULL
                           AND ('work:' || w.id::text) > $4)
                       OR ($3::timestamptz IS NOT NULL
                           AND (w.target_due_at > $3 OR w.target_due_at IS NULL
                                OR (w.target_due_at = $3
                                    AND ('work:' || w.id::text) > $4))))
                ORDER BY w.target_due_at ASC NULLS LAST, ('work:' || w.id::text) ASC
                LIMIT $5
                "#,
                )
                .bind(user_uuid)
                .bind(as_of)
                .bind(after_due)
                .bind(after_id.as_deref())
                .bind(source_limit + 1)
                .fetch_all(tx.as_mut())
                .await?;
                let has_more = i64::try_from(rows.len()).unwrap_or(0) > source_limit;
                let items = rows
                    .iter()
                    .take(usize::try_from(source_limit).unwrap_or(rows.len()))
                    .map(|row| {
                        Ok(WorkOrderRow {
                            id: row.try_get("id")?,
                            request_no: row.try_get("request_no")?,
                            target_due_at: row.try_get("target_due_at")?,
                            created_at: row.try_get("created_at")?,
                            site_name: row.try_get("site_name")?,
                        })
                    })
                    .collect::<Result<Vec<_>, DbError>>()?;
                Ok((items, total, has_more))
            })
        })
        .await;
    let (work_rows, work_total, work_has_more) = work_rows?;
    total += usize::try_from(work_total).unwrap_or(0);
    source_has_more |= work_has_more;
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
            created_at: row.created_at,
        });
    }

    // Freeze membership at the first page's timestamp so inserts between page
    // requests never duplicate or displace rows in the caller's traversal.
    let (items, _, mut next_cursor) = paginate_items(items, as_of, cursor.as_ref(), limit);
    if next_cursor.is_none() && source_has_more {
        next_cursor = items.last().map(|item| encode_cursor(as_of, item));
    }
    if !source_has_more && items.len() < limit {
        next_cursor = None;
    }

    Ok(Json(ActionInboxResponse {
        items,
        total,
        total_is_exact,
        next_cursor,
    }))
}

fn paginate_items(
    mut items: Vec<InboxItem>,
    as_of: OffsetDateTime,
    cursor: Option<&GlobalCursor>,
    limit: usize,
) -> (Vec<InboxItem>, usize, Option<String>) {
    items.retain(|item| item.created_at <= as_of);
    items.sort_by(compare_items);
    let total = items.len();
    if let Some(cursor) = cursor {
        items.retain(|item| item_after_cursor(item, cursor));
    }
    let has_more = items.len() > limit;
    items.truncate(limit);
    let next_cursor = has_more
        .then(|| items.last().map(|item| encode_cursor(as_of, item)))
        .flatten();
    (items, total, next_cursor)
}

fn compare_items(a: &InboxItem, b: &InboxItem) -> std::cmp::Ordering {
    match (a.due, b.due) {
        (Some(x), Some(y)) => x.cmp(&y),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    }
    .then_with(|| a.id.cmp(&b.id))
}

fn item_after_cursor(item: &InboxItem, cursor: &GlobalCursor) -> bool {
    match (item.due, cursor.due) {
        (Some(x), Some(y)) => x.cmp(&y),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    }
    .then_with(|| item.id.cmp(&cursor.id))
    .is_gt()
}

fn encode_cursor(as_of: OffsetDateTime, item: &InboxItem) -> String {
    let due = item.due.map_or_else(
        || "n".to_owned(),
        |due| due.unix_timestamp_nanos().to_string(),
    );
    format!("{}~{due}~{}", as_of.unix_timestamp_nanos(), item.id)
}

fn parse_cursor(raw: &str) -> Result<GlobalCursor, InboxError> {
    let mut parts = raw.splitn(3, '~');
    let as_of = parts
        .next()
        .and_then(|value| value.parse::<i128>().ok())
        .and_then(|value| OffsetDateTime::from_unix_timestamp_nanos(value).ok());
    let due = match parts.next() {
        Some("n") => Some(None),
        Some(value) => value
            .parse::<i128>()
            .ok()
            .and_then(|value| OffsetDateTime::from_unix_timestamp_nanos(value).ok())
            .map(Some),
        None => None,
    };
    let id = parts.next().filter(|value| !value.is_empty());
    match (as_of, due, id) {
        (Some(as_of), Some(due), Some(id)) => Ok(GlobalCursor {
            as_of,
            due,
            id: id.to_owned(),
        }),
        _ => Err(InboxError::validation("invalid action-inbox cursor")),
    }
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
    fn validation(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            code: "validation",
            message: message.into(),
        }
    }

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
    use time::{Duration, OffsetDateTime};

    use super::{InboxItem, canonical_action_link_kind, paginate_items, parse_cursor};

    #[test]
    fn normalizes_the_legacy_workflow_run_alias() {
        assert_eq!(canonical_action_link_kind("workflow_run"), "approval_run");
        assert_eq!(canonical_action_link_kind("approval_run"), "approval_run");
        assert_eq!(canonical_action_link_kind("work_order"), "work_order");
    }

    #[test]
    fn keyset_pages_every_item_past_the_old_total_cap_without_duplicates() {
        let as_of = OffsetDateTime::from_unix_timestamp(1_800_000_000).unwrap();
        let items = (0..451)
            .map(|index| item(index, as_of - Duration::seconds(i64::from(index))))
            .collect();

        let (first, total, next) = paginate_items(items, as_of, None, 200);
        assert_eq!(total, 451);
        assert_eq!(first.len(), 200);
        let first_ids = first.iter().map(|item| item.id.clone()).collect::<Vec<_>>();

        let cursor = parse_cursor(next.as_deref().unwrap()).unwrap();
        let items = (0..451)
            .map(|index| item(index, as_of - Duration::seconds(i64::from(index))))
            .collect();
        let (second, total, next) = paginate_items(items, as_of, Some(&cursor), 200);
        assert_eq!(total, 451);
        assert_eq!(second.len(), 200);
        assert!(second.iter().all(|item| !first_ids.contains(&item.id)));

        let cursor = parse_cursor(next.as_deref().unwrap()).unwrap();
        let items = (0..451)
            .map(|index| item(index, as_of - Duration::seconds(i64::from(index))))
            .collect();
        let (third, total, next) = paginate_items(items, as_of, Some(&cursor), 200);
        assert_eq!(total, 451);
        assert_eq!(third.len(), 51);
        assert!(next.is_none());
    }

    #[test]
    fn cursor_snapshot_excludes_concurrent_inserts_but_keeps_total_stable() {
        let as_of = OffsetDateTime::from_unix_timestamp(1_800_000_000).unwrap();
        let initial = vec![item(1, as_of - Duration::seconds(2)), item(2, as_of)];
        let (first, total, next) = paginate_items(initial, as_of, None, 1);
        assert_eq!(total, 2);
        assert_eq!(first.len(), 1);

        let cursor = parse_cursor(next.as_deref().unwrap()).unwrap();
        let after_insert = vec![
            item(1, as_of - Duration::seconds(2)),
            item(2, as_of),
            item(3, as_of + Duration::seconds(1)),
        ];
        let (second, total, next) = paginate_items(after_insert, as_of, Some(&cursor), 1);
        assert_eq!(total, 2);
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].id, "work:0002");
        assert!(next.is_none());
    }

    fn item(index: u16, created_at: OffsetDateTime) -> InboxItem {
        InboxItem {
            id: format!("work:{index:04}"),
            kind: "work",
            urg: "wait",
            ref_code: format!("WO-{index:04}"),
            title: format!("Work {index}"),
            site: None,
            who: None,
            due: Some(OffsetDateTime::UNIX_EPOCH + Duration::seconds(i64::from(index))),
            due_tone: "neutral",
            submitted: Some(created_at),
            links: Vec::new(),
            done: false,
            created_at,
        }
    }
}
