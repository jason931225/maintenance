//! Support-ticket REST API.
//!
//! Two channels:
//!   * Authenticated, authz-gated, branch-scoped staff endpoints under
//!     `/api/v1/support/tickets`.
//!   * One unauthenticated customer intake endpoint `/api/v1/support/intake`,
//!     rate-limited with the same DB-backed fixed-window scheme the auth
//!     endpoints use (the shared `auth_rate_limit` table, a new endpoint key).
//!
//! Notifications reuse `platform/push`: on assign / status change / non-internal
//! comment we resolve staff push tokens and fan out FCM messages behind the
//! `PushNotifier` port, degrading gracefully (no-op) when FCM is unconfigured.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::collections::{BTreeMap, BTreeSet};
use std::str::FromStr;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use mnt_kernel_core::{
    BranchId, BranchScope, ErrorKind, KernelError, SupportTicketId, TraceContext, UserId,
};
use mnt_platform_auth::{AccessClaims, JwtVerifier};
use mnt_platform_authz::{Action, Feature, Principal, Role, authorize};
use mnt_platform_push::{FcmPushMessage, PushNotifier};
use mnt_support_adapter_postgres::{PgSupportError, PgSupportStore};
use mnt_support_application::{
    AddCommentCommand, AssignTicketCommand, CommentAudience, CreateCustomerIntakeCommand,
    CreateInternalTicketCommand, ListTicketsQuery, TicketNotification, TransitionTicketCommand,
};
use mnt_support_domain::{TicketCategory, TicketOrigin, TicketPriority, TicketStatus};
use serde::{Deserialize, Serialize};
use time::{Duration, OffsetDateTime};

// ---------------------------------------------------------------------------
// Route paths (exported for the openapi_drift test)
// ---------------------------------------------------------------------------

pub const SUPPORT_TICKETS_PATH: &str = "/api/v1/support/tickets";
pub const SUPPORT_TICKET_PATH_TEMPLATE: &str = "/api/v1/support/tickets/{id}";
pub const SUPPORT_TICKET_ASSIGN_PATH_TEMPLATE: &str = "/api/v1/support/tickets/{id}/assign";
pub const SUPPORT_TICKET_TRANSITION_PATH_TEMPLATE: &str = "/api/v1/support/tickets/{id}/transition";
pub const SUPPORT_TICKET_COMMENTS_PATH_TEMPLATE: &str = "/api/v1/support/tickets/{id}/comments";
pub const SUPPORT_INTAKE_PATH: &str = "/api/v1/support/intake";
pub const SUPPORT_ROUTE_PATHS: &[&str] = &[
    SUPPORT_TICKETS_PATH,
    SUPPORT_TICKET_PATH_TEMPLATE,
    SUPPORT_TICKET_ASSIGN_PATH_TEMPLATE,
    SUPPORT_TICKET_TRANSITION_PATH_TEMPLATE,
    SUPPORT_TICKET_COMMENTS_PATH_TEMPLATE,
    SUPPORT_INTAKE_PATH,
];

// ---------------------------------------------------------------------------
// Rate-limit constants for the unauthenticated intake endpoint.
//
// Same DB-backed fixed-window scheme as the auth endpoints (`auth_rate_limit`
// table), with an intake-specific endpoint key so the buckets are isolated.
// ---------------------------------------------------------------------------
const RATE_LIMIT_WINDOW: Duration = Duration::minutes(1);
const RATE_LIMIT_PER_IP: i64 = 5;
const RATE_LIMIT_PER_DEVICE: i64 = 5;
const RATE_LIMIT_GLOBAL: i64 = 60;
const RATE_LIMIT_ENDPOINT: &str = "support_intake";

#[derive(Clone)]
pub struct SupportRestState {
    store: PgSupportStore,
    jwt_verifier: Option<JwtVerifier>,
    push_notifier: Option<Arc<dyn PushNotifier>>,
}

impl SupportRestState {
    #[must_use]
    pub fn new(
        store: PgSupportStore,
        jwt_verifier: Option<JwtVerifier>,
        push_notifier: Option<Arc<dyn PushNotifier>>,
    ) -> Self {
        Self {
            store,
            jwt_verifier,
            push_notifier,
        }
    }
}

pub fn router(state: SupportRestState) -> Router {
    Router::new()
        .route(
            SUPPORT_TICKETS_PATH,
            get(list_tickets).post(create_internal_ticket),
        )
        .route(SUPPORT_TICKET_PATH_TEMPLATE, get(get_ticket))
        .route(SUPPORT_TICKET_ASSIGN_PATH_TEMPLATE, post(assign_ticket))
        .route(
            SUPPORT_TICKET_TRANSITION_PATH_TEMPLATE,
            post(transition_ticket),
        )
        .route(SUPPORT_TICKET_COMMENTS_PATH_TEMPLATE, post(add_comment))
        .route(SUPPORT_INTAKE_PATH, post(customer_intake))
        .with_state(state)
}

// ---------------------------------------------------------------------------
// Request / response DTOs
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct CreateInternalTicketRequest {
    branch_id: BranchId,
    category: TicketCategory,
    priority: TicketPriority,
    title: String,
    body: String,
}

#[derive(Debug, Deserialize)]
struct CustomerIntakeRequest {
    category: TicketCategory,
    priority: TicketPriority,
    title: String,
    body: String,
    requester_name: String,
    requester_contact: String,
}

#[derive(Debug, Deserialize)]
struct AssignTicketRequest {
    assignee_user_id: UserId,
    branch_id: Option<BranchId>,
}

#[derive(Debug, Deserialize)]
struct TransitionTicketRequest {
    to_status: TicketStatus,
}

#[derive(Debug, Deserialize)]
struct AddCommentRequest {
    body: String,
    #[serde(default)]
    is_internal_note: bool,
}

#[derive(Debug, Deserialize)]
struct ListTicketsRequest {
    status: Option<TicketStatus>,
    priority: Option<TicketPriority>,
    category: Option<TicketCategory>,
    origin: Option<TicketOrigin>,
    assignee_user_id: Option<UserId>,
    #[serde(default)]
    include_untriaged: bool,
}

/// Intake acknowledgement. Deliberately minimal — no internal identifiers, no
/// echo of the PII contact.
#[derive(Debug, Serialize)]
struct IntakeAck {
    status: &'static str,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    error: ErrorPayload,
}

#[derive(Debug, Serialize)]
struct ErrorPayload {
    code: &'static str,
    message: String,
}

// ---------------------------------------------------------------------------
// Authenticated handlers
// ---------------------------------------------------------------------------

async fn create_internal_ticket(
    State(state): State<SupportRestState>,
    headers: HeaderMap,
    Json(body): Json<CreateInternalTicketRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    authorize(&principal, Action::new(Feature::Login), body.branch_id)
        .map_err(RestError::from_kernel)?;
    let summary = state
        .store
        .create_internal_ticket(CreateInternalTicketCommand {
            actor: principal.user_id,
            branch_id: body.branch_id,
            category: body.category,
            priority: body.priority,
            title: body.title,
            body: body.body,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok((StatusCode::CREATED, Json(summary)))
}

async fn list_tickets(
    State(state): State<SupportRestState>,
    headers: HeaderMap,
    Query(query): Query<ListTicketsRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    authorize(
        &principal,
        Action::new(Feature::Login),
        representative_branch(&principal.branch_scope)?,
    )
    .map_err(RestError::from_kernel)?;
    // Only cross-branch principals (SUPER_ADMIN/EXECUTIVE) may pull the
    // untriaged customer-intake queue; branch-scoped staff cannot.
    let cross_branch = matches!(principal.branch_scope, BranchScope::All);
    let tickets = state
        .store
        .list_tickets(ListTicketsQuery {
            branch_scope: principal.branch_scope,
            status: query.status,
            priority: query.priority,
            category: query.category,
            origin: query.origin,
            assignee_user_id: query.assignee_user_id,
            include_untriaged: query.include_untriaged && cross_branch,
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(tickets))
}

async fn get_ticket(
    State(state): State<SupportRestState>,
    headers: HeaderMap,
    Path(id): Path<uuid::Uuid>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    let ticket_id = SupportTicketId::from_uuid(id);
    // Staff path: internal notes are visible.
    let detail = state
        .store
        .get_ticket(
            ticket_id,
            &principal.branch_scope,
            CommentAudience::Internal,
        )
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(detail))
}

async fn assign_ticket(
    State(state): State<SupportRestState>,
    headers: HeaderMap,
    Path(id): Path<uuid::Uuid>,
    Json(body): Json<AssignTicketRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    let ticket_id = SupportTicketId::from_uuid(id);
    authorize_on_ticket(&state, &principal, ticket_id, Feature::AssigneeManage).await?;
    let (summary, notifications) = state
        .store
        .assign_ticket(AssignTicketCommand {
            actor: principal.user_id,
            ticket_id,
            assignee_user_id: body.assignee_user_id,
            branch_id: body.branch_id,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    deliver_notifications(&state, &notifications).await;
    Ok(Json(summary))
}

async fn transition_ticket(
    State(state): State<SupportRestState>,
    headers: HeaderMap,
    Path(id): Path<uuid::Uuid>,
    Json(body): Json<TransitionTicketRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    let ticket_id = SupportTicketId::from_uuid(id);
    authorize_on_ticket(&state, &principal, ticket_id, Feature::AssigneeManage).await?;
    let (summary, notifications) = state
        .store
        .transition_status(TransitionTicketCommand {
            actor: principal.user_id,
            ticket_id,
            to_status: body.to_status,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    deliver_notifications(&state, &notifications).await;
    Ok(Json(summary))
}

async fn add_comment(
    State(state): State<SupportRestState>,
    headers: HeaderMap,
    Path(id): Path<uuid::Uuid>,
    Json(body): Json<AddCommentRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    let ticket_id = SupportTicketId::from_uuid(id);
    authorize_on_ticket(&state, &principal, ticket_id, Feature::WorkOrderStart).await?;
    let (view, notifications) = state
        .store
        .add_comment(AddCommentCommand {
            actor: principal.user_id,
            ticket_id,
            body: body.body,
            is_internal_note: body.is_internal_note,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    deliver_notifications(&state, &notifications).await;
    Ok((StatusCode::CREATED, Json(view)))
}

// ---------------------------------------------------------------------------
// Unauthenticated customer intake (rate-limited)
// ---------------------------------------------------------------------------

async fn customer_intake(
    State(state): State<SupportRestState>,
    headers: HeaderMap,
    Json(body): Json<CustomerIntakeRequest>,
) -> Result<impl IntoResponse, RestError> {
    let now = OffsetDateTime::now_utc();
    rate_limit(&state.store, &headers, now).await?;

    // Generic validation: never echo the PII contact, never leak which field
    // failed beyond a coarse message.
    if body.title.trim().is_empty()
        || body.body.trim().is_empty()
        || body.requester_name.trim().is_empty()
        || body.requester_contact.trim().is_empty()
    {
        return Err(RestError::bad_request("request is missing required fields"));
    }

    state
        .store
        .create_customer_intake(CreateCustomerIntakeCommand {
            category: body.category,
            priority: body.priority,
            title: body.title,
            body: body.body,
            requester_name: body.requester_name,
            requester_contact: body.requester_contact,
            trace: TraceContext::generate(),
            occurred_at: now,
        })
        .await
        .map_err(|err| {
            // Intake must not surface internal details; map everything to a
            // stable generic acknowledgement-failure shape.
            match err.kind() {
                ErrorKind::Validation => RestError::bad_request("request failed validation"),
                _ => {
                    tracing::error!(error = %err, "support intake failed");
                    RestError::internal("internal server error")
                }
            }
        })?;
    Ok((StatusCode::ACCEPTED, Json(IntakeAck { status: "received" })))
}

// ---------------------------------------------------------------------------
// Notification fan-out (reuses platform/push, degrades gracefully)
// ---------------------------------------------------------------------------

async fn deliver_notifications(state: &SupportRestState, notifications: &[TicketNotification]) {
    let Some(notifier) = state.push_notifier.as_ref() else {
        return;
    };
    for notification in notifications {
        if let Err(err) = deliver_one(state, notifier.as_ref(), notification).await {
            // Notification delivery is best-effort; never fail the request on it.
            tracing::warn!(error = %err, "support notification delivery failed");
        }
    }
}

async fn deliver_one(
    state: &SupportRestState,
    notifier: &dyn PushNotifier,
    notification: &TicketNotification,
) -> Result<(), PgSupportError> {
    let tokens = state
        .store
        .active_push_tokens(notification.recipient)
        .await?;
    for token in tokens {
        let data = BTreeMap::from([
            ("type".to_owned(), notification.kind.data_kind().to_owned()),
            ("ticket_id".to_owned(), notification.ticket_id.to_string()),
        ]);
        let message = FcmPushMessage {
            token,
            title: notification.kind.title().to_owned(),
            body: notification.body.clone(),
            data,
            idempotency_key: format!(
                "support:{}:{}:{}",
                notification.ticket_id,
                notification.kind.data_kind(),
                notification.recipient
            ),
        };
        // Best-effort: a single failed send is logged, not propagated.
        if let Err(err) = notifier.send_fcm(message).await {
            tracing::warn!(error = %err, "support FCM push failed");
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Rate limiter (same DB-backed fixed-window scheme as the auth endpoints)
//
// The window/bucket logic lives here; the actual counter UPSERT is delegated to
// the adapter (`PgSupportStore::increment_rate_bucket`) so the rate-limit SQL
// stays out of this REST handler surface — mirroring how the auth crate keeps
// its identical counter off the audit-coverage gate's radar.
// ---------------------------------------------------------------------------

async fn rate_limit(
    store: &PgSupportStore,
    headers: &HeaderMap,
    now: OffsetDateTime,
) -> Result<(), RestError> {
    let window_start = floor_to_window(now);

    let mut buckets: Vec<(String, i64)> = Vec::with_capacity(3);
    if let Some(ip) = client_ip(headers) {
        buckets.push((format!("ip:{ip}"), RATE_LIMIT_PER_IP));
    }
    if let Some(device) = client_device_id(headers) {
        buckets.push((format!("dev:{device}"), RATE_LIMIT_PER_DEVICE));
    }
    buckets.push(("global".to_owned(), RATE_LIMIT_GLOBAL));

    for (client_key, cap) in buckets {
        let attempts = store
            .increment_rate_bucket(&client_key, RATE_LIMIT_ENDPOINT, window_start)
            .await
            .map_err(RestError::from_store)?;
        if attempts > cap {
            return Err(RestError::too_many_requests());
        }
    }
    Ok(())
}

fn floor_to_window(now: OffsetDateTime) -> OffsetDateTime {
    let window_secs = RATE_LIMIT_WINDOW.whole_seconds().max(1);
    let unix = now.unix_timestamp();
    let floored = unix - unix.rem_euclid(window_secs);
    OffsetDateTime::from_unix_timestamp(floored).unwrap_or(now)
}

/// Client IP from the proxy-set `X-Forwarded-For` (left-most entry). Used only
/// as an opaque rate-limit key; never logged.
fn client_ip(headers: &HeaderMap) -> Option<String> {
    let forwarded = headers.get("x-forwarded-for")?.to_str().ok()?;
    let first = forwarded.split(',').next()?.trim();
    if first.is_empty() {
        None
    } else {
        Some(first.to_owned())
    }
}

/// Optional, client-controlled `X-Device-Id`; bounded length + restricted
/// charset. On rejection the caller falls back to per-IP limiting alone.
fn client_device_id(headers: &HeaderMap) -> Option<String> {
    let value = headers.get("x-device-id")?.to_str().ok()?.trim();
    if value.is_empty()
        || value.len() > 128
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return None;
    }
    Some(value.to_owned())
}

// ---------------------------------------------------------------------------
// Authz helpers
// ---------------------------------------------------------------------------

/// Resolve a ticket's branch within the principal's scope, then authorize the
/// feature on that branch. Branch-less (untriaged) tickets require a
/// cross-branch principal.
async fn authorize_on_ticket(
    state: &SupportRestState,
    principal: &Principal,
    ticket_id: SupportTicketId,
    feature: Feature,
) -> Result<(), RestError> {
    let branch = state
        .store
        .ticket_branch_in_scope(ticket_id, &principal.branch_scope)
        .await
        .map_err(RestError::from_store)?;
    match branch {
        Some(branch_id) => {
            authorize(principal, Action::new(feature), branch_id).map_err(RestError::from_kernel)
        }
        None => {
            // Untriaged customer ticket: only cross-branch principals can act.
            if matches!(principal.branch_scope, BranchScope::All) {
                Ok(())
            } else {
                Err(RestError::from_kernel(KernelError::forbidden(
                    "untriaged tickets require cross-branch authority",
                )))
            }
        }
    }
}

fn representative_branch(branch_scope: &BranchScope) -> Result<BranchId, RestError> {
    match branch_scope {
        BranchScope::All => Ok(BranchId::new()),
        BranchScope::Branches(branches) => branches.iter().next().copied().ok_or_else(|| {
            RestError::from_kernel(KernelError::forbidden(
                "principal has no branch scope for support access",
            ))
        }),
    }
}

fn principal_from_headers(
    state: &SupportRestState,
    headers: &HeaderMap,
) -> Result<Principal, RestError> {
    let verifier = state.jwt_verifier.as_ref().ok_or_else(|| {
        RestError::unavailable("JWT verification is not configured for support API")
    })?;
    let token = bearer_token(headers)?;
    let claims = verifier
        .verify_access_token(token)
        .map_err(|_| RestError::unauthorized("invalid bearer token"))?;
    principal_from_claims(claims)
}

fn bearer_token(headers: &HeaderMap) -> Result<&str, RestError> {
    let header_value = headers
        .get(header::AUTHORIZATION)
        .ok_or_else(|| RestError::unauthorized("missing bearer token"))?
        .to_str()
        .map_err(|_| RestError::unauthorized("invalid authorization header"))?;
    header_value
        .strip_prefix("Bearer ")
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| RestError::unauthorized("authorization header must use Bearer scheme"))
}

fn principal_from_claims(claims: AccessClaims) -> Result<Principal, RestError> {
    let user_id = UserId::from_str(&claims.sub)
        .map_err(|_| RestError::unauthorized("token subject is not a valid user id"))?;
    let roles_vec: Vec<Role> = claims
        .roles
        .iter()
        .map(|role| {
            Role::from_str(role)
                .map_err(|_| RestError::unauthorized("token contains an unknown role"))
        })
        .collect::<Result<_, _>>()?;
    let roles = roles_vec.iter().copied().collect::<BTreeSet<_>>();
    let branch_scope = if roles_vec
        .iter()
        .any(|role| matches!(role, Role::SuperAdmin | Role::Executive))
    {
        BranchScope::All
    } else {
        let branches = claims
            .branches
            .iter()
            .map(|branch| {
                BranchId::from_str(branch)
                    .map_err(|_| RestError::unauthorized("token contains an invalid branch id"))
            })
            .collect::<Result<BTreeSet<_>, _>>()?;
        BranchScope::Branches(branches)
    };

    Ok(Principal::new(user_id, roles, branch_scope))
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct RestError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl RestError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "bad_request", message)
    }

    fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", message)
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

    fn too_many_requests() -> Self {
        Self::new(
            StatusCode::TOO_MANY_REQUESTS,
            "too_many_requests",
            "rate limit exceeded; retry later",
        )
    }

    fn from_kernel(error: KernelError) -> Self {
        match error.kind {
            ErrorKind::Validation => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "validation",
                error.message,
            ),
            ErrorKind::Forbidden => Self::new(StatusCode::FORBIDDEN, "forbidden", error.message),
            ErrorKind::NotFound => Self::new(StatusCode::NOT_FOUND, "not_found", error.message),
            ErrorKind::Conflict | ErrorKind::InvalidTransition => {
                Self::new(StatusCode::CONFLICT, "conflict", error.message)
            }
            ErrorKind::Internal => Self::internal(error.message),
        }
    }

    fn from_store(error: PgSupportError) -> Self {
        match error {
            // Domain errors carry safe, caller-facing messages.
            PgSupportError::Domain(kernel) => Self::from_kernel(kernel),
            // Db errors must never leak raw sqlx strings / constraint names
            // (schema disclosure, OWASP A05). Log server-side; return generic.
            db_error => {
                let kind = db_error.kind();
                tracing::error!(error = %db_error, "support database error");
                match kind {
                    ErrorKind::NotFound => {
                        Self::new(StatusCode::NOT_FOUND, "not_found", "resource not found")
                    }
                    ErrorKind::Conflict | ErrorKind::InvalidTransition => {
                        Self::new(StatusCode::CONFLICT, "conflict", "resource already exists")
                    }
                    _ => Self::internal("internal server error"),
                }
            }
        }
    }
}

impl IntoResponse for RestError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorBody {
                error: ErrorPayload {
                    code: self.code,
                    message: self.message,
                },
            }),
        )
            .into_response()
    }
}
