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
//!   * work orders -> `ActionInboxWorkOrderPort`, whose adapter owns the
//!     assignment-gated person scope (the same boundary as mobile detail).
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
use mnt_support_adapter_postgres::PgSupportStore;
use mnt_support_domain::TicketStatus;
use mnt_workorder_adapter_postgres::PgWorkOrderStore;
use mnt_workorder_application::{ActionInboxPosition, ActionInboxWorkOrderPort};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
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
    created_at: OffsetDateTime,
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
    let cursor = query
        .cursor
        .as_deref()
        .map(|raw| parse_cursor(raw, now))
        .transpose()?;
    let as_of = cursor.as_ref().map_or(now, |cursor| cursor.as_of);
    let limit = query
        .limit
        .unwrap_or(DEFAULT_PAGE_LIMIT)
        .clamp(1, MAX_PAGE_LIMIT);
    let mut items: Vec<InboxItem> = Vec::new();
    let after = cursor
        .as_ref()
        .map(|cursor| (cursor.created_at, cursor.id.clone()));
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
    .map_err(|error| {
        tracing::error!(source = "workflow", error = %error, "action-inbox source read failed");
        InboxError::internal("failed to load action inbox")
    })?;
    source_has_more |= workflow_has_more;
    let (workflow_total, workflow_total_exact) = workflow_studio::my_action_inbox_task_count(
        &state.pool,
        &principal,
        as_of,
    )
    .await
    .map_err(|error| {
        tracing::error!(source = "workflow", error = %error, "action-inbox source read failed");
        InboxError::internal("failed to load action inbox")
    })?;
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
            now,
            as_of,
            after.clone(),
            source_limit,
        )
        .await
        .map_err(|error| {
            tracing::error!(source = "dispatch", error = %error, "action-inbox source read failed");
            InboxError::internal("failed to load action inbox")
        })?;
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
            created_at: offer.created_at,
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
        .map_err(|error| {
            tracing::error!(source = "support", error = %error, "action-inbox source read failed");
            InboxError::internal("failed to load action inbox")
        })?;
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
    // The application port owns the person scope and persistence predicate.
    let work_page = PgWorkOrderStore::new(state.pool.clone())
        .list_assigned_action_inbox_page(
            principal.org_id,
            principal.branch_scope.clone(),
            principal.user_id,
            as_of,
            after
                .clone()
                .map(|(created_at, id)| ActionInboxPosition { created_at, id }),
            source_limit,
        )
        .await
        .map_err(|error| {
            tracing::error!(source = "workorder", error = %error, "action-inbox source read failed");
            InboxError::internal("failed to load action inbox")
        })?;
    total += usize::try_from(work_page.total).unwrap_or(0);
    source_has_more |= work_page.has_more;
    for row in work_page.items {
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

    // `as_of` freezes only admission of newly-created rows. Membership remains
    // live: resolved, reassigned, or expired items may disappear between pages.
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
    a.created_at
        .cmp(&b.created_at)
        .then_with(|| a.id.cmp(&b.id))
}

fn item_after_cursor(item: &InboxItem, cursor: &GlobalCursor) -> bool {
    item.created_at
        .cmp(&cursor.created_at)
        .then_with(|| item.id.cmp(&cursor.id))
        .is_gt()
}

fn encode_cursor(as_of: OffsetDateTime, item: &InboxItem) -> String {
    format!(
        "{}~{}~{}",
        as_of.unix_timestamp_nanos(),
        item.created_at.unix_timestamp_nanos(),
        item.id
    )
}

fn parse_cursor(raw: &str, now: OffsetDateTime) -> Result<GlobalCursor, InboxError> {
    let mut parts = raw.splitn(3, '~');
    let as_of = parts
        .next()
        .and_then(|value| value.parse::<i128>().ok())
        .and_then(|value| OffsetDateTime::from_unix_timestamp_nanos(value).ok());
    let created_at = parts
        .next()
        .and_then(|value| value.parse::<i128>().ok())
        .and_then(|value| OffsetDateTime::from_unix_timestamp_nanos(value).ok());
    let id = parts.next().filter(|value| !value.is_empty());
    match (as_of, created_at, id) {
        (Some(as_of), Some(created_at), Some(id))
            if as_of <= now && created_at <= as_of && valid_namespaced_id(id) =>
        {
            Ok(GlobalCursor {
                as_of,
                created_at,
                id: id.to_owned(),
            })
        }
        _ => Err(InboxError::validation("invalid action-inbox cursor")),
    }
}

fn valid_namespaced_id(value: &str) -> bool {
    let Some((kind, id)) = value.split_once(':') else {
        return false;
    };
    matches!(kind, "approval" | "dispatch" | "support" | "work")
        && uuid::Uuid::parse_str(id).is_ok()
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

        let cursor = parse_cursor(next.as_deref().unwrap(), as_of + Duration::seconds(1)).unwrap();
        let items = (0..451)
            .map(|index| item(index, as_of - Duration::seconds(i64::from(index))))
            .collect();
        let (second, total, next) = paginate_items(items, as_of, Some(&cursor), 200);
        assert_eq!(total, 451);
        assert_eq!(second.len(), 200);
        assert!(second.iter().all(|item| !first_ids.contains(&item.id)));

        let cursor = parse_cursor(next.as_deref().unwrap(), as_of + Duration::seconds(1)).unwrap();
        let items = (0..451)
            .map(|index| item(index, as_of - Duration::seconds(i64::from(index))))
            .collect();
        let (third, total, next) = paginate_items(items, as_of, Some(&cursor), 200);
        assert_eq!(total, 451);
        assert_eq!(third.len(), 51);
        assert!(next.is_none());
    }

    #[test]
    fn cursor_admission_boundary_excludes_concurrent_inserts() {
        let as_of = OffsetDateTime::from_unix_timestamp(1_800_000_000).unwrap();
        let initial = vec![item(1, as_of - Duration::seconds(2)), item(2, as_of)];
        let (first, total, next) = paginate_items(initial, as_of, None, 1);
        assert_eq!(total, 2);
        assert_eq!(first.len(), 1);

        let cursor = parse_cursor(next.as_deref().unwrap(), as_of + Duration::seconds(1)).unwrap();
        let after_insert = vec![
            item(1, as_of - Duration::seconds(2)),
            item(2, as_of),
            item(3, as_of + Duration::seconds(1)),
        ];
        let (second, total, next) = paginate_items(after_insert, as_of, Some(&cursor), 1);
        assert_eq!(total, 2);
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].id, format!("work:{}", uuid::Uuid::from_u128(2)));
        assert!(next.is_none());
    }

    fn item(index: u16, created_at: OffsetDateTime) -> InboxItem {
        InboxItem {
            id: format!("work:{}", uuid::Uuid::from_u128(u128::from(index))),
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
