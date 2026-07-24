use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use mnt_kernel_core::{AuditAction, AuditEvent, ErrorKind, KernelError, TraceContext};
use mnt_platform_auth::{
    JwtVerifier, MobilePasskeyStepUpBinding, MobilePasskeyStepUpEnvelope,
    MobilePasskeyStepUpVerificationError, PasskeyService,
};
use mnt_platform_authz::{Feature, PermissionLevel, Principal, permission_for};
use mnt_platform_db::{DbError, with_audit, with_org_conn};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Row, Transaction};
use std::collections::BTreeSet;
use time::OffsetDateTime;
use uuid::Uuid;

pub const CALENDAR_EVENTS_PATH: &str = "/api/v1/collaboration/calendar/events";
pub const POLLS_PATH: &str = "/api/v1/collaboration/polls";
pub const POLL_VOTE_PATH_TEMPLATE: &str = "/api/v1/collaboration/polls/{id}/vote";
pub const MOBILE_POLL_VOTE_PATH_TEMPLATE: &str = "/api/v1/mobile/collaboration/polls/{id}/vote";
pub const COLLABORATION_ROUTE_PATHS: &[&str] = &[
    CALENDAR_EVENTS_PATH,
    POLLS_PATH,
    POLL_VOTE_PATH_TEMPLATE,
    MOBILE_POLL_VOTE_PATH_TEMPLATE,
];

const COLLABORATION_REQUESTS_TOTAL: &str = "collaboration_requests_total";
const MAX_LIST_LIMIT: i64 = 100;
const DEFAULT_LIST_LIMIT: i64 = 30;
const MAX_POLL_OPTIONS: usize = 20;

#[derive(Clone)]
pub struct CollaborationState {
    pool: PgPool,
    jwt_verifier: Option<JwtVerifier>,
    passkey_step_up: Option<PasskeyService>,
}

impl CollaborationState {
    #[must_use]
    pub fn new(pool: PgPool, jwt_verifier: Option<JwtVerifier>) -> Self {
        Self {
            pool,
            jwt_verifier,
            passkey_step_up: None,
        }
    }

    #[must_use]
    pub fn with_passkey_step_up(mut self, passkey_step_up: Option<PasskeyService>) -> Self {
        self.passkey_step_up = passkey_step_up;
        self
    }
}

pub fn router(state: CollaborationState) -> Router {
    let verifier = state.jwt_verifier.clone();
    let pool = state.pool.clone();
    let router = Router::new()
        .route(
            CALENDAR_EVENTS_PATH,
            get(list_calendar_events).post(create_calendar_event),
        )
        .route(POLLS_PATH, get(list_polls).post(create_poll))
        .route(POLL_VOTE_PATH_TEMPLATE, post(vote_poll))
        .route(MOBILE_POLL_VOTE_PATH_TEMPLATE, post(vote_mobile_poll))
        .with_state(state);
    mnt_platform_request_context::with_request_context(router, verifier, pool)
}

#[derive(Debug, Deserialize)]
struct CalendarEventQuery {
    #[serde(default, with = "time::serde::rfc3339::option")]
    from: Option<OffsetDateTime>,
    #[serde(default, with = "time::serde::rfc3339::option")]
    to: Option<OffsetDateTime>,
    limit: Option<i64>,
}

#[derive(Debug, Serialize)]
struct CalendarEventListResponse {
    items: Vec<CalendarEventResponse>,
}

#[derive(Debug, Deserialize)]
struct CreateCalendarEventRequest {
    scope_type: ScopeType,
    #[serde(default)]
    scope_ref: Option<String>,
    title: String,
    #[serde(default)]
    description: String,
    #[serde(with = "time::serde::rfc3339")]
    starts_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    ends_at: OffsetDateTime,
    #[serde(default)]
    all_day: bool,
    #[serde(default)]
    object_type: Option<String>,
    #[serde(default)]
    object_id: Option<Uuid>,
}

#[derive(Debug, Serialize)]
struct CalendarEventResponse {
    id: Uuid,
    scope_type: ScopeType,
    #[serde(skip_serializing_if = "Option::is_none")]
    scope_ref: Option<String>,
    title: String,
    description: String,
    #[serde(with = "time::serde::rfc3339")]
    starts_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    ends_at: OffsetDateTime,
    all_day: bool,
    status: CalendarEventStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    object_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    object_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    created_by: Option<Uuid>,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    updated_at: OffsetDateTime,
    policy: CollaborationScopePolicy,
}

#[derive(Debug, Deserialize)]
struct PollQuery {
    status: Option<PollStatus>,
    limit: Option<i64>,
}

#[derive(Debug, Serialize)]
struct PollListResponse {
    items: Vec<PollResponse>,
}

#[derive(Debug, Deserialize)]
struct CreatePollRequest {
    target_scope_type: ScopeType,
    #[serde(default)]
    target_scope_ref: Option<String>,
    title: String,
    question: String,
    #[serde(default = "default_poll_status")]
    status: PollStatus,
    #[serde(default = "default_anonymity")]
    anonymity: PollAnonymity,
    #[serde(default)]
    allow_multiple: bool,
    #[serde(default, with = "time::serde::rfc3339::option")]
    closes_at: Option<OffsetDateTime>,
    options: Vec<String>,
    #[serde(default)]
    object_type: Option<String>,
    #[serde(default)]
    object_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
struct VotePollRequest {
    selected_option_ids: Vec<Uuid>,
}

#[derive(Debug, Deserialize)]
struct MobileVotePollRequest {
    selected_option_ids: Vec<Uuid>,
    #[serde(default)]
    step_up: Option<MobilePasskeyStepUpEnvelope>,
}

#[derive(Debug, Serialize)]
struct PollResponse {
    id: Uuid,
    target_scope_type: ScopeType,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_scope_ref: Option<String>,
    title: String,
    question: String,
    status: PollStatus,
    anonymity: PollAnonymity,
    allow_multiple: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(with = "time::serde::rfc3339::option")]
    closes_at: Option<OffsetDateTime>,
    #[serde(skip_serializing_if = "Option::is_none")]
    object_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    object_id: Option<Uuid>,
    options: Vec<PollOptionResponse>,
    vote_count: i64,
    my_vote: PollMyVote,
    #[serde(skip_serializing_if = "Option::is_none")]
    created_by: Option<Uuid>,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    updated_at: OffsetDateTime,
    policy: CollaborationScopePolicy,
}

#[derive(Debug, Serialize, Deserialize)]
struct PollOptionResponse {
    id: Uuid,
    label: String,
    position: i32,
    vote_count: i64,
}

#[derive(Debug, Serialize)]
struct PollMyVote {
    submitted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    selected_option_ids: Option<Vec<Uuid>>,
}

#[derive(Debug, Serialize)]
struct CollaborationScopePolicy {
    enforcement: &'static str,
    scope_type: ScopeType,
    #[serde(skip_serializing_if = "Option::is_none")]
    scope_ref: Option<String>,
    visibility: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum ScopeType {
    Tenant,
    Org,
    Department,
    Team,
    Personal,
}

impl ScopeType {
    const fn as_db(self) -> &'static str {
        match self {
            Self::Tenant => "TENANT",
            Self::Org => "ORG",
            Self::Department => "DEPARTMENT",
            Self::Team => "TEAM",
            Self::Personal => "PERSONAL",
        }
    }

    fn from_db(raw: &str) -> Result<Self, CollaborationError> {
        match raw {
            "TENANT" => Ok(Self::Tenant),
            "ORG" => Ok(Self::Org),
            "DEPARTMENT" => Ok(Self::Department),
            "TEAM" => Ok(Self::Team),
            "PERSONAL" => Ok(Self::Personal),
            _ => Err(CollaborationError::validation(format!(
                "unknown collaboration scope type: {raw}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum CalendarEventStatus {
    Active,
    Cancelled,
}

impl CalendarEventStatus {
    fn from_db(raw: &str) -> Result<Self, CollaborationError> {
        match raw {
            "ACTIVE" => Ok(Self::Active),
            "CANCELLED" => Ok(Self::Cancelled),
            _ => Err(CollaborationError::validation(format!(
                "unknown calendar event status: {raw}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum PollStatus {
    Draft,
    Open,
    Closed,
    Archived,
}

impl PollStatus {
    const fn as_db(self) -> &'static str {
        match self {
            Self::Draft => "DRAFT",
            Self::Open => "OPEN",
            Self::Closed => "CLOSED",
            Self::Archived => "ARCHIVED",
        }
    }

    fn from_db(raw: &str) -> Result<Self, CollaborationError> {
        match raw {
            "DRAFT" => Ok(Self::Draft),
            "OPEN" => Ok(Self::Open),
            "CLOSED" => Ok(Self::Closed),
            "ARCHIVED" => Ok(Self::Archived),
            _ => Err(CollaborationError::validation(format!(
                "unknown poll status: {raw}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum PollAnonymity {
    Named,
    Anonymous,
}

impl PollAnonymity {
    const fn as_db(self) -> &'static str {
        match self {
            Self::Named => "NAMED",
            Self::Anonymous => "ANONYMOUS",
        }
    }

    fn from_db(raw: &str) -> Result<Self, CollaborationError> {
        match raw {
            "NAMED" => Ok(Self::Named),
            "ANONYMOUS" => Ok(Self::Anonymous),
            _ => Err(CollaborationError::validation(format!(
                "unknown poll anonymity: {raw}"
            ))),
        }
    }
}

fn default_poll_status() -> PollStatus {
    PollStatus::Open
}

fn default_anonymity() -> PollAnonymity {
    PollAnonymity::Named
}

async fn list_calendar_events(
    State(state): State<CollaborationState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<CalendarEventQuery>,
) -> Result<Json<CalendarEventListResponse>, CollaborationError> {
    let limit = normalize_limit(query.limit);
    let as_of = OffsetDateTime::now_utc();
    let from = query
        .from
        .unwrap_or_else(|| as_of - time::Duration::days(1));
    let to = query.to.unwrap_or_else(|| as_of + time::Duration::days(14));
    if to < from {
        return Err(CollaborationError::validation(
            "calendar query end must be after start",
        ));
    }
    let snapshot =
        collect_calendar_events(&state.pool, &principal, from, to, limit, as_of, false).await?;
    record_collaboration_request("calendar_list", "success");
    Ok(Json(CalendarEventListResponse {
        items: snapshot.items,
    }))
}

struct CalendarEventSnapshot {
    items: Vec<CalendarEventResponse>,
    total: usize,
    as_of: OffsetDateTime,
}

async fn collect_calendar_events(
    pool: &PgPool,
    principal: &Principal,
    from: OffsetDateTime,
    to: OffsetDateTime,
    limit: i64,
    as_of: OffsetDateTime,
    half_open_range: bool,
) -> Result<CalendarEventSnapshot, CollaborationError> {
    authorize_collaboration_member(principal)?;
    let org = principal.org_id;
    let user_ref = principal.user_id.as_uuid().to_string();
    let user_id = *principal.user_id.as_uuid();
    let rows = with_org_conn::<_, _, CollaborationError>(pool, org, move |tx| {
        Box::pin(async move {
            Ok(sqlx::query(
                r#"
                SELECT id, scope_type, scope_ref, title, description, starts_at, ends_at,
                       all_day, status, object_type, object_id, created_by, created_at, updated_at,
                       COUNT(*) OVER() AS snapshot_total
                FROM collaboration_calendar_events
                WHERE status = 'ACTIVE'
                  AND (
                      ($7 AND starts_at < $1 AND ends_at > $2)
                      OR (NOT $7 AND starts_at <= $1 AND ends_at >= $2)
                  )
                  AND (
                      scope_type <> 'PERSONAL'
                      OR scope_ref = $3
                      OR created_by = $4
                  )
                  AND created_at <= $5
                  AND updated_at <= $5
                ORDER BY starts_at ASC, created_at DESC
                LIMIT $6
                "#,
            )
            .bind(to)
            .bind(from)
            .bind(user_ref)
            .bind(user_id)
            .bind(as_of)
            .bind(limit)
            .bind(half_open_range)
            .fetch_all(tx.as_mut())
            .await?)
        })
    })
    .await?;
    let total = rows
        .first()
        .map(|row| row.try_get::<i64, _>("snapshot_total"))
        .transpose()?
        .unwrap_or(0);
    let total = usize::try_from(total)
        .map_err(|_| CollaborationError::internal("calendar count exceeded supported range"))?;
    let items = rows
        .into_iter()
        .map(calendar_event_from_row)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(CalendarEventSnapshot {
        items,
        total,
        as_of,
    })
}

/// Native calendar-owner adapter for the workbench aggregate. It reuses the
/// authenticated collaboration visibility predicate, applies the aggregate's
/// exact half-open range and one request ceiling, and never persists a second
/// calendar projection.
pub(crate) async fn read_workbench_calendar(
    pool: &PgPool,
    principal: &Principal,
    range: crate::workbench::WorkbenchRange,
    limit: usize,
    as_of: OffsetDateTime,
) -> Result<crate::workbench::CalendarPage, crate::workbench::SourceFailure> {
    let limit = i64::try_from(limit).map_err(|_| crate::workbench::SourceFailure::Unavailable {
        code: "calendar_limit_invalid",
    })?;
    let snapshot =
        collect_calendar_events(pool, principal, range.from, range.to, limit, as_of, true)
            .await
            .map_err(|error| {
                if error.status == StatusCode::FORBIDDEN {
                    crate::workbench::SourceFailure::Denied {
                        code: "calendar_access_denied",
                    }
                } else {
                    crate::workbench::SourceFailure::Unavailable {
                        code: "calendar_unavailable",
                    }
                }
            })?;
    let items = snapshot
        .items
        .into_iter()
        .map(|item| crate::workbench::CalendarItem {
            id: item.id,
            title: item.title,
            starts_at: item.starts_at,
            ends_at: item.ends_at,
            target: crate::workbench::WorkbenchTarget {
                module: "overview".to_owned(),
                id: item.id.to_string(),
            },
        })
        .collect();
    Ok(crate::workbench::CalendarPage {
        as_of: snapshot.as_of,
        total: snapshot.total,
        items,
    })
}

async fn create_calendar_event(
    State(state): State<CollaborationState>,
    Extension(principal): Extension<Principal>,
    Json(body): Json<CreateCalendarEventRequest>,
) -> Result<Json<CalendarEventResponse>, CollaborationError> {
    authorize_collaboration_member(&principal)?;
    let normalized = normalize_calendar_event(body, principal.user_id.as_uuid())?;
    let event_id = Uuid::new_v4();
    let org = principal.org_id;
    let actor = principal.user_id;
    let trace = TraceContext::generate();
    let now = OffsetDateTime::now_utc();
    let audit_after = json!({
        "id": event_id,
        "scope_type": normalized.scope_type.as_db(),
        "scope_ref": normalized.scope_ref,
        "title": normalized.title,
        "object_type": normalized.object_type,
        "object_id": normalized.object_id,
    });
    let audit_event = AuditEvent::new(
        Some(actor),
        AuditAction::new("collaboration.calendar_event.create")?,
        "collaboration_calendar_event",
        event_id.to_string(),
        trace,
        now,
    )
    .with_org(org)
    .with_snapshots(None, Some(audit_after.clone()));
    let response = with_audit::<_, _, CollaborationError>(&state.pool, audit_event, move |tx| {
        Box::pin(async move {
            let row = sqlx::query(
                r#"
                INSERT INTO collaboration_calendar_events (
                    id, org_id, scope_type, scope_ref, title, description, starts_at, ends_at,
                    all_day, object_type, object_id, created_by, updated_by
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
                RETURNING id, scope_type, scope_ref, title, description, starts_at, ends_at,
                          all_day, status, object_type, object_id, created_by, created_at, updated_at
                "#,
            )
            .bind(event_id)
            .bind(*org.as_uuid())
            .bind(normalized.scope_type.as_db())
            .bind(&normalized.scope_ref)
            .bind(&normalized.title)
            .bind(&normalized.description)
            .bind(normalized.starts_at)
            .bind(normalized.ends_at)
            .bind(normalized.all_day)
            .bind(&normalized.object_type)
            .bind(normalized.object_id)
            .bind(*actor.as_uuid())
            .fetch_one(tx.as_mut())
            .await?;

            insert_calendar_lifecycle_event(
                tx,
                CalendarLifecycleEvent {
                    org,
                    event_id,
                    action: "collaboration.calendar_event.create",
                    actor: Some(actor),
                    summary: "일정 생성",
                    before_snap: None,
                    after_snap: Some(audit_after),
                },
            )
            .await?;

            calendar_event_from_row(row)
        })
    })
    .await?;
    record_collaboration_request("calendar_create", "success");
    Ok(Json(response))
}

async fn list_polls(
    State(state): State<CollaborationState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<PollQuery>,
) -> Result<Json<PollListResponse>, CollaborationError> {
    authorize_collaboration_member(&principal)?;
    let status = query.status.unwrap_or(PollStatus::Open);
    let limit = normalize_limit(query.limit);
    let org = principal.org_id;
    let user_ref = principal.user_id.as_uuid().to_string();
    let user_id = *principal.user_id.as_uuid();
    let items = with_org_conn::<_, _, CollaborationError>(&state.pool, org, move |tx| {
        Box::pin(async move {
            let rows = sqlx::query(
                r#"
                SELECT p.id, p.target_scope_type, p.target_scope_ref, p.title, p.question,
                       p.status, p.anonymity, p.allow_multiple, p.closes_at,
                       p.object_type, p.object_id, p.created_by, p.created_at, p.updated_at,
                       COALESCE((
                           SELECT jsonb_agg(
                               jsonb_build_object(
                                   'id', o.id,
                                   'label', o.label,
                                   'position', o.position,
                                   'vote_count', COALESCE((
                                       SELECT COUNT(*)
                                       FROM collaboration_poll_votes v
                                       WHERE v.poll_id = p.id
                                         AND v.org_id = p.org_id
                                         AND o.id = ANY(v.selected_option_ids)
                                   ), 0)
                               )
                               ORDER BY o.position
                           )
                           FROM collaboration_poll_options o
                           WHERE o.poll_id = p.id
                             AND o.org_id = p.org_id
                       ), '[]'::jsonb) AS options,
                       COALESCE((
                           SELECT COUNT(*)
                           FROM collaboration_poll_votes v
                           WHERE v.poll_id = p.id
                             AND v.org_id = p.org_id
                       ), 0) AS vote_count,
                       (
                           SELECT v.selected_option_ids
                           FROM collaboration_poll_votes v
                           WHERE v.poll_id = p.id
                             AND v.org_id = p.org_id
                             AND v.voter_id = $3
                       ) AS my_selected_option_ids
                FROM collaboration_polls p
                WHERE p.status = $1
                  AND (
                      p.target_scope_type <> 'PERSONAL'
                      OR p.target_scope_ref = $2
                      OR p.created_by = $3
                  )
                ORDER BY p.created_at DESC
                LIMIT $4
                "#,
            )
            .bind(status.as_db())
            .bind(user_ref)
            .bind(user_id)
            .bind(limit)
            .fetch_all(tx.as_mut())
            .await?;
            rows.into_iter().map(poll_from_row).collect()
        })
    })
    .await?;
    record_collaboration_request("poll_list", "success");
    Ok(Json(PollListResponse { items }))
}

async fn create_poll(
    State(state): State<CollaborationState>,
    Extension(principal): Extension<Principal>,
    Json(body): Json<CreatePollRequest>,
) -> Result<Json<PollResponse>, CollaborationError> {
    authorize_collaboration_member(&principal)?;
    let normalized = normalize_poll(body, principal.user_id.as_uuid())?;
    let poll_id = Uuid::new_v4();
    let org = principal.org_id;
    let actor = principal.user_id;
    let trace = TraceContext::generate();
    let now = OffsetDateTime::now_utc();
    let audit_after = json!({
        "id": poll_id,
        "target_scope_type": normalized.target_scope_type.as_db(),
        "target_scope_ref": normalized.target_scope_ref,
        "status": normalized.status.as_db(),
        "anonymity": normalized.anonymity.as_db(),
        "allow_multiple": normalized.allow_multiple,
        "object_type": normalized.object_type,
        "object_id": normalized.object_id,
    });
    let audit_event = AuditEvent::new(
        Some(actor),
        AuditAction::new("collaboration.poll.create")?,
        "collaboration_poll",
        poll_id.to_string(),
        trace,
        now,
    )
    .with_org(org)
    .with_snapshots(None, Some(audit_after.clone()));
    let response = with_audit::<_, _, CollaborationError>(&state.pool, audit_event, move |tx| {
        Box::pin(async move {
            sqlx::query(
                r#"
                INSERT INTO collaboration_polls (
                    id, org_id, target_scope_type, target_scope_ref, title, question,
                    status, anonymity, allow_multiple, closes_at, object_type, object_id,
                    created_by, updated_by
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
                "#,
            )
            .bind(poll_id)
            .bind(*org.as_uuid())
            .bind(normalized.target_scope_type.as_db())
            .bind(&normalized.target_scope_ref)
            .bind(&normalized.title)
            .bind(&normalized.question)
            .bind(normalized.status.as_db())
            .bind(normalized.anonymity.as_db())
            .bind(normalized.allow_multiple)
            .bind(normalized.closes_at)
            .bind(&normalized.object_type)
            .bind(normalized.object_id)
            .bind(*actor.as_uuid())
            .execute(tx.as_mut())
            .await?;

            for (position, label) in normalized.options.iter().enumerate() {
                sqlx::query(
                    r#"
                    INSERT INTO collaboration_poll_options (org_id, poll_id, label, position)
                    VALUES ($1, $2, $3, $4)
                    "#,
                )
                .bind(*org.as_uuid())
                .bind(poll_id)
                .bind(label)
                .bind(
                    i32::try_from(position)
                        .map_err(|_| CollaborationError::validation("too many poll options"))?,
                )
                .execute(tx.as_mut())
                .await?;
            }

            insert_poll_lifecycle_event(
                tx,
                PollLifecycleEvent {
                    org,
                    poll_id,
                    action: "collaboration.poll.create",
                    actor: Some(actor),
                    summary: "폴 생성",
                    before_snap: None,
                    after_snap: Some(audit_after),
                },
            )
            .await?;

            load_poll_response(tx, poll_id, *actor.as_uuid()).await
        })
    })
    .await?;
    record_collaboration_request("poll_create", "success");
    Ok(Json(response))
}

async fn vote_poll(
    State(state): State<CollaborationState>,
    Extension(principal): Extension<Principal>,
    Path(poll_id): Path<Uuid>,
    Json(body): Json<VotePollRequest>,
) -> Result<Json<PollResponse>, CollaborationError> {
    authorize_collaboration_member(&principal)?;
    let selected = normalize_selected_options(body.selected_option_ids)?;
    let response = submit_poll_vote(&state, &principal, poll_id, selected).await?;
    record_collaboration_request("poll_vote", "success");
    Ok(Json(response))
}

async fn vote_mobile_poll(
    State(state): State<CollaborationState>,
    Extension(principal): Extension<Principal>,
    Path(poll_id): Path<Uuid>,
    Json(body): Json<MobileVotePollRequest>,
) -> Result<Json<PollResponse>, CollaborationError> {
    authorize_collaboration_member(&principal)?;
    let selected = normalize_selected_options(body.selected_option_ids)?;
    verify_mobile_poll_step_up(
        &state,
        &principal,
        poll_id,
        body.step_up.ok_or_else(|| {
            CollaborationError::precondition_required(
                "passkey_step_up_required",
                "mobile poll vote requires a fresh passkey step-up",
            )
        })?,
    )
    .await?;
    let response = submit_poll_vote(&state, &principal, poll_id, selected).await?;
    record_collaboration_request("poll_vote", "success");
    Ok(Json(response))
}

async fn submit_poll_vote(
    state: &CollaborationState,
    principal: &Principal,
    poll_id: Uuid,
    selected: Vec<Uuid>,
) -> Result<PollResponse, CollaborationError> {
    let org = principal.org_id;
    let actor = principal.user_id;
    let trace = TraceContext::generate();
    let now = OffsetDateTime::now_utc();
    let audit_after = json!({
        "id": poll_id,
        "selected_count": selected.len(),
    });
    let audit_event = AuditEvent::new(
        Some(actor),
        AuditAction::new("collaboration.poll.vote")?,
        "collaboration_poll",
        poll_id.to_string(),
        trace,
        now,
    )
    .with_org(org)
    .with_snapshots(None, Some(audit_after.clone()));
    with_audit::<_, _, CollaborationError>(&state.pool, audit_event, move |tx| {
        Box::pin(async move {
            let poll = load_poll_vote_policy(tx, poll_id).await?;
            if poll.status != PollStatus::Open {
                return Err(CollaborationError::validation("poll is not open"));
            }
            if poll
                .closes_at
                .is_some_and(|closes_at| closes_at < OffsetDateTime::now_utc())
            {
                return Err(CollaborationError::validation("poll is closed"));
            }
            if !poll.allow_multiple && selected.len() != 1 {
                return Err(CollaborationError::validation(
                    "poll accepts exactly one option",
                ));
            }
            ensure_options_belong_to_poll(tx, poll_id, &selected).await?;
            sqlx::query(
                r#"
                INSERT INTO collaboration_poll_votes (
                    org_id, poll_id, voter_id, selected_option_ids
                )
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (poll_id, voter_id) DO UPDATE SET
                    selected_option_ids = EXCLUDED.selected_option_ids,
                    updated_at = now()
                "#,
            )
            .bind(*org.as_uuid())
            .bind(poll_id)
            .bind(*actor.as_uuid())
            .bind(&selected)
            .execute(tx.as_mut())
            .await?;

            insert_poll_lifecycle_event(
                tx,
                PollLifecycleEvent {
                    org,
                    poll_id,
                    action: "collaboration.poll.vote",
                    actor: Some(actor),
                    summary: "투표 제출",
                    before_snap: None,
                    after_snap: Some(audit_after),
                },
            )
            .await?;

            load_poll_response(tx, poll_id, *actor.as_uuid()).await
        })
    })
    .await
}

async fn verify_mobile_poll_step_up(
    state: &CollaborationState,
    principal: &Principal,
    poll_id: Uuid,
    step_up: MobilePasskeyStepUpEnvelope,
) -> Result<(), CollaborationError> {
    step_up
        .binding
        .validate()
        .map_err(|err| CollaborationError::validation(err.to_string()))?;
    let expected_binding =
        MobilePasskeyStepUpBinding::poll_vote(poll_id, step_up.binding.replay_attempt);
    let verifier = state.passkey_step_up.as_ref().ok_or_else(|| {
        CollaborationError::unavailable("passkey step-up is not configured for collaboration API")
    })?;
    verifier
        .verify_mobile_step_up_for_user(
            &state.pool,
            step_up,
            *principal.user_id.as_uuid(),
            &expected_binding,
        )
        .await
        .map_err(collaboration_error_from_mobile_step_up)
}

fn collaboration_error_from_mobile_step_up(
    error: MobilePasskeyStepUpVerificationError,
) -> CollaborationError {
    match error {
        MobilePasskeyStepUpVerificationError::BindingMismatch => {
            CollaborationError::unauthorized_with_code(
                "passkey_step_up_binding_mismatch",
                "passkey step-up binding does not match the requested action",
            )
        }
        MobilePasskeyStepUpVerificationError::Auth(err) => {
            CollaborationError::unauthorized_with_code("passkey_step_up_failed", err.to_string())
        }
    }
}

#[derive(Debug)]
struct NormalizedCalendarEvent {
    scope_type: ScopeType,
    scope_ref: Option<String>,
    title: String,
    description: String,
    starts_at: OffsetDateTime,
    ends_at: OffsetDateTime,
    all_day: bool,
    object_type: Option<String>,
    object_id: Option<Uuid>,
}

#[derive(Debug)]
struct NormalizedPoll {
    target_scope_type: ScopeType,
    target_scope_ref: Option<String>,
    title: String,
    question: String,
    status: PollStatus,
    anonymity: PollAnonymity,
    allow_multiple: bool,
    closes_at: Option<OffsetDateTime>,
    options: Vec<String>,
    object_type: Option<String>,
    object_id: Option<Uuid>,
}

#[derive(Debug)]
struct PollVotePolicy {
    status: PollStatus,
    allow_multiple: bool,
    closes_at: Option<OffsetDateTime>,
}

fn normalize_calendar_event(
    body: CreateCalendarEventRequest,
    actor_id: &Uuid,
) -> Result<NormalizedCalendarEvent, CollaborationError> {
    if body.ends_at < body.starts_at {
        return Err(CollaborationError::validation(
            "calendar event end must be after start",
        ));
    }
    let (object_type, object_id) = normalize_object_link(body.object_type, body.object_id)?;
    Ok(NormalizedCalendarEvent {
        scope_type: body.scope_type,
        scope_ref: normalize_scope_ref(body.scope_type, body.scope_ref, actor_id)?,
        title: normalize_required_text(&body.title, "title", 160)?,
        description: normalize_optional_text(&body.description, 2000)?,
        starts_at: body.starts_at,
        ends_at: body.ends_at,
        all_day: body.all_day,
        object_type,
        object_id,
    })
}

fn normalize_poll(
    body: CreatePollRequest,
    actor_id: &Uuid,
) -> Result<NormalizedPoll, CollaborationError> {
    let (object_type, object_id) = normalize_object_link(body.object_type, body.object_id)?;
    let mut options = Vec::new();
    let mut seen = BTreeSet::new();
    for option in body.options {
        let label = normalize_required_text(&option, "poll option", 240)?;
        if !seen.insert(label.to_lowercase()) {
            return Err(CollaborationError::validation(
                "poll options must be unique",
            ));
        }
        options.push(label);
    }
    if options.len() < 2 {
        return Err(CollaborationError::validation(
            "poll requires at least two options",
        ));
    }
    if options.len() > MAX_POLL_OPTIONS {
        return Err(CollaborationError::validation("poll has too many options"));
    }
    Ok(NormalizedPoll {
        target_scope_type: body.target_scope_type,
        target_scope_ref: normalize_scope_ref(
            body.target_scope_type,
            body.target_scope_ref,
            actor_id,
        )?,
        title: normalize_required_text(&body.title, "title", 160)?,
        question: normalize_required_text(&body.question, "question", 1000)?,
        status: body.status,
        anonymity: body.anonymity,
        allow_multiple: body.allow_multiple,
        closes_at: body.closes_at,
        options,
        object_type,
        object_id,
    })
}

fn normalize_scope_ref(
    scope_type: ScopeType,
    scope_ref: Option<String>,
    actor_id: &Uuid,
) -> Result<Option<String>, CollaborationError> {
    if scope_type == ScopeType::Personal {
        return Ok(Some(actor_id.to_string()));
    }
    let normalized = scope_ref
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    if normalized
        .as_ref()
        .is_some_and(|value| value.chars().count() > 160)
    {
        return Err(CollaborationError::validation(
            "scope_ref must be 160 characters or less",
        ));
    }
    Ok(normalized)
}

fn normalize_object_link(
    object_type: Option<String>,
    object_id: Option<Uuid>,
) -> Result<(Option<String>, Option<Uuid>), CollaborationError> {
    match (
        object_type
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty()),
        object_id,
    ) {
        (None, None) => Ok((None, None)),
        (Some(kind), Some(id)) if is_safe_object_type(&kind) => Ok((Some(kind), Some(id))),
        (Some(_), Some(_)) => Err(CollaborationError::validation("invalid object_type")),
        _ => Err(CollaborationError::validation(
            "object_type and object_id must be supplied together",
        )),
    }
}

fn normalize_required_text(
    raw: &str,
    field: &'static str,
    max_chars: usize,
) -> Result<String, CollaborationError> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(CollaborationError::validation(format!(
            "{field} is required"
        )));
    }
    if value.chars().count() > max_chars {
        return Err(CollaborationError::validation(format!(
            "{field} must be {max_chars} characters or less"
        )));
    }
    Ok(value.to_owned())
}

fn normalize_optional_text(raw: &str, max_chars: usize) -> Result<String, CollaborationError> {
    let value = raw.trim();
    if value.chars().count() > max_chars {
        return Err(CollaborationError::validation(format!(
            "description must be {max_chars} characters or less"
        )));
    }
    Ok(value.to_owned())
}

fn normalize_selected_options(mut selected: Vec<Uuid>) -> Result<Vec<Uuid>, CollaborationError> {
    selected.sort_unstable();
    selected.dedup();
    if selected.is_empty() {
        return Err(CollaborationError::validation(
            "selected_option_ids is required",
        ));
    }
    if selected.len() > MAX_POLL_OPTIONS {
        return Err(CollaborationError::validation(
            "selected_option_ids has too many entries",
        ));
    }
    Ok(selected)
}

fn is_safe_object_type(raw: &str) -> bool {
    let mut chars = raw.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_lowercase()
        && raw.len() <= 64
        && chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_')
}

fn normalize_limit(limit: Option<i64>) -> i64 {
    limit.unwrap_or(DEFAULT_LIST_LIMIT).clamp(1, MAX_LIST_LIMIT)
}

fn calendar_event_from_row(
    row: sqlx::postgres::PgRow,
) -> Result<CalendarEventResponse, CollaborationError> {
    let scope_raw: String = row.try_get("scope_type")?;
    let status_raw: String = row.try_get("status")?;
    let scope_type = ScopeType::from_db(&scope_raw)?;
    let scope_ref: Option<String> = row.try_get("scope_ref")?;
    Ok(CalendarEventResponse {
        id: row.try_get("id")?,
        scope_type,
        scope_ref: scope_ref.clone(),
        title: row.try_get("title")?,
        description: row.try_get("description")?,
        starts_at: row.try_get("starts_at")?,
        ends_at: row.try_get("ends_at")?,
        all_day: row.try_get("all_day")?,
        status: CalendarEventStatus::from_db(&status_raw)?,
        object_type: row.try_get("object_type")?,
        object_id: row.try_get("object_id")?,
        created_by: row.try_get("created_by")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        policy: scope_policy(scope_type, scope_ref),
    })
}

fn poll_from_row(row: sqlx::postgres::PgRow) -> Result<PollResponse, CollaborationError> {
    let scope_raw: String = row.try_get("target_scope_type")?;
    let status_raw: String = row.try_get("status")?;
    let anonymity_raw: String = row.try_get("anonymity")?;
    let scope_type = ScopeType::from_db(&scope_raw)?;
    let scope_ref: Option<String> = row.try_get("target_scope_ref")?;
    let options_json: Value = row.try_get("options")?;
    let options: Vec<PollOptionResponse> = serde_json::from_value(options_json).map_err(|err| {
        CollaborationError::validation(format!("invalid poll option payload: {err}"))
    })?;
    let my_selected_option_ids: Option<Vec<Uuid>> = row.try_get("my_selected_option_ids")?;
    Ok(PollResponse {
        id: row.try_get("id")?,
        target_scope_type: scope_type,
        target_scope_ref: scope_ref.clone(),
        title: row.try_get("title")?,
        question: row.try_get("question")?,
        status: PollStatus::from_db(&status_raw)?,
        anonymity: PollAnonymity::from_db(&anonymity_raw)?,
        allow_multiple: row.try_get("allow_multiple")?,
        closes_at: row.try_get("closes_at")?,
        object_type: row.try_get("object_type")?,
        object_id: row.try_get("object_id")?,
        options,
        vote_count: row.try_get("vote_count")?,
        my_vote: PollMyVote {
            submitted: my_selected_option_ids.is_some(),
            selected_option_ids: my_selected_option_ids,
        },
        created_by: row.try_get("created_by")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        policy: scope_policy(scope_type, scope_ref),
    })
}

async fn load_poll_response(
    tx: &mut Transaction<'_, Postgres>,
    poll_id: Uuid,
    voter_id: Uuid,
) -> Result<PollResponse, CollaborationError> {
    let row = sqlx::query(
        r#"
        SELECT p.id, p.target_scope_type, p.target_scope_ref, p.title, p.question,
               p.status, p.anonymity, p.allow_multiple, p.closes_at,
               p.object_type, p.object_id, p.created_by, p.created_at, p.updated_at,
               COALESCE((
                   SELECT jsonb_agg(
                       jsonb_build_object(
                           'id', o.id,
                           'label', o.label,
                           'position', o.position,
                           'vote_count', COALESCE((
                               SELECT COUNT(*)
                               FROM collaboration_poll_votes v
                               WHERE v.poll_id = p.id
                                 AND v.org_id = p.org_id
                                 AND o.id = ANY(v.selected_option_ids)
                           ), 0)
                       )
                       ORDER BY o.position
                   )
                   FROM collaboration_poll_options o
                   WHERE o.poll_id = p.id
                     AND o.org_id = p.org_id
               ), '[]'::jsonb) AS options,
               COALESCE((
                   SELECT COUNT(*)
                   FROM collaboration_poll_votes v
                   WHERE v.poll_id = p.id
                     AND v.org_id = p.org_id
               ), 0) AS vote_count,
               (
                   SELECT v.selected_option_ids
                   FROM collaboration_poll_votes v
                   WHERE v.poll_id = p.id
                     AND v.org_id = p.org_id
                     AND v.voter_id = $2
               ) AS my_selected_option_ids
        FROM collaboration_polls p
        WHERE p.id = $1
        "#,
    )
    .bind(poll_id)
    .bind(voter_id)
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| CollaborationError::not_found("poll not found"))?;
    poll_from_row(row)
}

async fn load_poll_vote_policy(
    tx: &mut Transaction<'_, Postgres>,
    poll_id: Uuid,
) -> Result<PollVotePolicy, CollaborationError> {
    let row = sqlx::query(
        r#"
        SELECT status, allow_multiple, closes_at
        FROM collaboration_polls
        WHERE id = $1
        "#,
    )
    .bind(poll_id)
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| CollaborationError::not_found("poll not found"))?;
    let status_raw: String = row.try_get("status")?;
    Ok(PollVotePolicy {
        status: PollStatus::from_db(&status_raw)?,
        allow_multiple: row.try_get("allow_multiple")?,
        closes_at: row.try_get("closes_at")?,
    })
}

async fn ensure_options_belong_to_poll(
    tx: &mut Transaction<'_, Postgres>,
    poll_id: Uuid,
    selected: &[Uuid],
) -> Result<(), CollaborationError> {
    let count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM collaboration_poll_options
        WHERE poll_id = $1
          AND id = ANY($2)
        "#,
    )
    .bind(poll_id)
    .bind(selected)
    .fetch_one(tx.as_mut())
    .await?;
    if usize::try_from(count).unwrap_or(0) != selected.len() {
        return Err(CollaborationError::validation(
            "selected options must belong to the poll",
        ));
    }
    Ok(())
}

struct CalendarLifecycleEvent {
    org: mnt_kernel_core::OrgId,
    event_id: Uuid,
    action: &'static str,
    actor: Option<mnt_kernel_core::UserId>,
    summary: &'static str,
    before_snap: Option<Value>,
    after_snap: Option<Value>,
}

async fn insert_calendar_lifecycle_event(
    tx: &mut Transaction<'_, Postgres>,
    event: CalendarLifecycleEvent,
) -> Result<(), CollaborationError> {
    sqlx::query(
        r#"
        INSERT INTO collaboration_calendar_event_events (
            org_id, event_id, action, actor_id, summary, before_snap, after_snap
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        "#,
    )
    .bind(*event.org.as_uuid())
    .bind(event.event_id)
    .bind(event.action)
    .bind(event.actor.map(|user| *user.as_uuid()))
    .bind(event.summary)
    .bind(event.before_snap)
    .bind(event.after_snap)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

struct PollLifecycleEvent {
    org: mnt_kernel_core::OrgId,
    poll_id: Uuid,
    action: &'static str,
    actor: Option<mnt_kernel_core::UserId>,
    summary: &'static str,
    before_snap: Option<Value>,
    after_snap: Option<Value>,
}

async fn insert_poll_lifecycle_event(
    tx: &mut Transaction<'_, Postgres>,
    event: PollLifecycleEvent,
) -> Result<(), CollaborationError> {
    sqlx::query(
        r#"
        INSERT INTO collaboration_poll_events (
            org_id, poll_id, action, actor_id, summary, before_snap, after_snap
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        "#,
    )
    .bind(*event.org.as_uuid())
    .bind(event.poll_id)
    .bind(event.action)
    .bind(event.actor.map(|user| *user.as_uuid()))
    .bind(event.summary)
    .bind(event.before_snap)
    .bind(event.after_snap)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

fn scope_policy(scope_type: ScopeType, scope_ref: Option<String>) -> CollaborationScopePolicy {
    CollaborationScopePolicy {
        enforcement: "server",
        scope_type,
        scope_ref,
        visibility: match scope_type {
            ScopeType::Personal => "creator_only",
            ScopeType::Tenant | ScopeType::Org => "org_members",
            ScopeType::Department => "department_target",
            ScopeType::Team => "team_target",
        },
    }
}

fn authorize_collaboration_member(principal: &Principal) -> Result<(), CollaborationError> {
    let allowed_by_role = principal
        .roles
        .iter()
        .any(|role| permission_for(*role, Feature::Login) == PermissionLevel::Allow);
    let allowed_by_custom_grant = principal
        .effective_feature_grants
        .iter()
        .any(|grant| grant.feature == Feature::Login && grant.permission == PermissionLevel::Allow);
    if allowed_by_role || allowed_by_custom_grant {
        return Ok(());
    }
    Err(CollaborationError::from_kernel(KernelError::forbidden(
        "collaboration requires an authenticated tenant member",
    )))
}

fn record_collaboration_request(surface: &'static str, outcome: &'static str) {
    metrics::counter!(COLLABORATION_REQUESTS_TOTAL, "surface" => surface, "outcome" => outcome)
        .increment(1);
}

#[derive(Debug)]
struct CollaborationError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl CollaborationError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    fn from_kernel(error: KernelError) -> Self {
        let status = match error.kind {
            ErrorKind::Validation => StatusCode::UNPROCESSABLE_ENTITY,
            ErrorKind::NotFound => StatusCode::NOT_FOUND,
            ErrorKind::Forbidden => StatusCode::FORBIDDEN,
            ErrorKind::Conflict | ErrorKind::InvalidTransition => StatusCode::CONFLICT,
            ErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        };
        Self {
            status,
            code: error_code(error.kind),
            message: error.message,
        }
    }

    fn validation(message: impl Into<String>) -> Self {
        Self::from_kernel(KernelError::validation(message.into()))
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self::from_kernel(KernelError::not_found(message.into()))
    }

    fn precondition_required(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::PRECONDITION_REQUIRED, code, message)
    }

    fn unauthorized_with_code(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, code, message)
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "service_unavailable",
            message,
        )
    }

    fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", message)
    }
}

impl From<KernelError> for CollaborationError {
    fn from(error: KernelError) -> Self {
        Self::from_kernel(error)
    }
}

impl From<DbError> for CollaborationError {
    fn from(value: DbError) -> Self {
        tracing::error!(error = %value, "collaboration database operation failed");
        Self::internal("collaboration request failed")
    }
}

impl From<sqlx::Error> for CollaborationError {
    fn from(value: sqlx::Error) -> Self {
        Self::from(DbError::Sqlx(value))
    }
}

impl IntoResponse for CollaborationError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({ "error": { "code": self.code, "message": self.message } })),
        )
            .into_response()
    }
}

fn error_code(kind: ErrorKind) -> &'static str {
    match kind {
        ErrorKind::Validation => "validation",
        ErrorKind::NotFound => "not_found",
        ErrorKind::Forbidden => "forbidden",
        ErrorKind::Conflict => "conflict",
        ErrorKind::InvalidTransition => "invalid_transition",
        ErrorKind::Internal => "internal",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(feature = "test-postgres"))]

    #[test]
    fn personal_scope_is_pinned_to_actor() -> Result<(), String> {
        let actor = Uuid::parse_str("00000000-0000-4000-8000-000000000001")
            .map_err(|err| err.to_string())?;
        let scope = normalize_scope_ref(ScopeType::Personal, Some("attacker".to_owned()), &actor)
            .map_err(|err| err.message)?;
        assert_eq!(scope, Some(actor.to_string()));
        Ok(())
    }

    #[cfg(not(feature = "test-postgres"))]

    #[test]
    fn poll_options_are_unique_and_object_link_is_paired() -> Result<(), String> {
        let actor = Uuid::parse_str("00000000-0000-4000-8000-000000000001")
            .map_err(|err| err.to_string())?;
        let starts = OffsetDateTime::now_utc();
        let poll = CreatePollRequest {
            target_scope_type: ScopeType::Org,
            target_scope_ref: None,
            title: "중복".to_owned(),
            question: "선택".to_owned(),
            status: PollStatus::Open,
            anonymity: PollAnonymity::Named,
            allow_multiple: false,
            closes_at: Some(starts),
            options: vec!["A".to_owned(), " a ".to_owned()],
            object_type: Some("work_order".to_owned()),
            object_id: None,
        };

        let err = match normalize_poll(poll, &actor) {
            Ok(_) => return Err("duplicate poll options should fail validation".to_owned()),
            Err(err) => err,
        };

        assert_eq!(err.code, "validation");
        Ok(())
    }
}
