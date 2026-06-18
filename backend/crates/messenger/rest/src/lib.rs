//! Messenger REST API.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::collections::BTreeSet;
use std::str::FromStr;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use axum::{Json, Router};
use mnt_kernel_core::{
    BranchId, BranchScope, ErrorKind, EvidenceId, KernelError, MessageId, OrgId, ThreadId,
    TraceContext, UserId, WorkOrderId,
};
use mnt_messenger_adapter_postgres::{PgMessengerError, PgMessengerStore};
use mnt_messenger_application::{
    CreateThreadCommand, ListThreadsQuery, MarkThreadReadCommand, MessagePageQuery,
    SearchMessagesQuery, SendMessageCommand,
};
use mnt_messenger_domain::ThreadKind;
use mnt_platform_auth::{AccessClaims, JwtVerifier};
use mnt_platform_authz::{Principal, Role};
use serde::{Deserialize, Serialize};

pub const MESSENGER_ROUTE_PATHS: &[&str] = &[
    "/api/messenger/threads",
    "/api/messenger/threads/{threadId}/messages",
    "/api/messenger/threads/{threadId}/read-receipt",
    "/api/messenger/search",
];

#[derive(Debug, Clone)]
pub struct MessengerRestState {
    store: PgMessengerStore,
    jwt_verifier: Option<JwtVerifier>,
}

impl MessengerRestState {
    #[must_use]
    pub fn new(store: PgMessengerStore, jwt_verifier: Option<JwtVerifier>) -> Self {
        Self {
            store,
            jwt_verifier,
        }
    }
}

pub fn router(state: MessengerRestState) -> Router {
    let verifier = state.jwt_verifier.clone();
    let pool = state.store.pool().clone();
    let router = Router::new()
        .route(
            "/api/messenger/threads",
            get(list_threads).post(create_thread),
        )
        .route(
            "/api/messenger/threads/{thread_id}/messages",
            get(message_page).post(send_message),
        )
        .route(
            "/api/messenger/threads/{thread_id}/read-receipt",
            put(mark_thread_read),
        )
        .route("/api/messenger/search", get(search_messages))
        .with_state(state);
    mnt_platform_request_context::with_request_context(router, verifier, pool)
}

#[derive(Debug, Deserialize)]
struct CreateThreadRequest {
    branch_id: BranchId,
    kind: ThreadKind,
    title: Option<String>,
    work_order_id: Option<WorkOrderId>,
    member_ids: Vec<UserId>,
}

#[derive(Debug, Deserialize)]
struct SendMessageRequest {
    body: String,
    #[serde(default)]
    attachment_evidence_ids: Vec<EvidenceId>,
}

#[derive(Debug, Deserialize)]
struct ReadReceiptRequest {
    last_read_message_id: MessageId,
}

#[derive(Debug, Deserialize)]
struct LimitQuery {
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct MessagePageParams {
    before_message_id: Option<MessageId>,
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct SearchParams {
    q: String,
    limit: Option<i64>,
}

#[derive(Debug, Serialize)]
struct Items<T> {
    items: Vec<T>,
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

async fn create_thread(
    State(state): State<MessengerRestState>,
    headers: HeaderMap,
    Json(body): Json<CreateThreadRequest>,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    let summary = state
        .store
        .create_thread(CreateThreadCommand {
            actor: principal.user_id,
            branch_scope: principal.branch_scope,
            branch_id: body.branch_id,
            kind: body.kind,
            title: body.title,
            work_order_id: body.work_order_id,
            member_ids: body.member_ids,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok((StatusCode::CREATED, Json(summary)).into_response())
}

async fn list_threads(
    State(state): State<MessengerRestState>,
    headers: HeaderMap,
    Query(query): Query<LimitQuery>,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    let items = state
        .store
        .list_threads(ListThreadsQuery {
            actor: principal.user_id,
            branch_scope: principal.branch_scope,
            limit: query.limit.unwrap_or(50),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(Items { items }).into_response())
}

async fn send_message(
    State(state): State<MessengerRestState>,
    headers: HeaderMap,
    Path(thread_id): Path<ThreadId>,
    Json(body): Json<SendMessageRequest>,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    let message = state
        .store
        .send_message(SendMessageCommand {
            actor: principal.user_id,
            branch_scope: principal.branch_scope,
            thread_id,
            body: body.body,
            attachment_evidence_ids: body.attachment_evidence_ids,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok((StatusCode::CREATED, Json(message)).into_response())
}

async fn message_page(
    State(state): State<MessengerRestState>,
    headers: HeaderMap,
    Path(thread_id): Path<ThreadId>,
    Query(query): Query<MessagePageParams>,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    let page = state
        .store
        .message_page(MessagePageQuery {
            actor: principal.user_id,
            branch_scope: principal.branch_scope,
            thread_id,
            before_message_id: query.before_message_id,
            limit: query.limit.unwrap_or(50),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(page).into_response())
}

async fn mark_thread_read(
    State(state): State<MessengerRestState>,
    headers: HeaderMap,
    Path(thread_id): Path<ThreadId>,
    Json(body): Json<ReadReceiptRequest>,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    let receipt = state
        .store
        .mark_thread_read(MarkThreadReadCommand {
            actor: principal.user_id,
            branch_scope: principal.branch_scope,
            thread_id,
            last_read_message_id: body.last_read_message_id,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(receipt).into_response())
}

async fn search_messages(
    State(state): State<MessengerRestState>,
    headers: HeaderMap,
    Query(query): Query<SearchParams>,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    let items = state
        .store
        .search_messages(SearchMessagesQuery {
            actor: principal.user_id,
            branch_scope: principal.branch_scope,
            query: query.q,
            limit: query.limit.unwrap_or(50),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(Items { items }).into_response())
}

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

    fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", message)
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, "unavailable", message)
    }

    fn from_kernel(err: KernelError) -> Self {
        match err.kind {
            ErrorKind::Validation => {
                Self::new(StatusCode::UNPROCESSABLE_ENTITY, "validation", err.message)
            }
            ErrorKind::NotFound => Self::new(StatusCode::NOT_FOUND, "not_found", err.message),
            ErrorKind::Forbidden => Self::new(StatusCode::FORBIDDEN, "forbidden", err.message),
            ErrorKind::Conflict | ErrorKind::InvalidTransition => {
                Self::new(StatusCode::CONFLICT, "conflict", err.message)
            }
            ErrorKind::Internal => {
                Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", err.message)
            }
        }
    }

    fn from_store(err: PgMessengerError) -> Self {
        match err {
            PgMessengerError::Domain(err) => Self::from_kernel(err),
            PgMessengerError::Db(err) => {
                // Log the raw error server-side; never leak sqlx/schema internals
                // (schema disclosure, OWASP A05). Clients get a stable message.
                tracing::error!(error = %err, "database error");
                Self::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal",
                    "internal server error",
                )
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

fn principal_from_headers(
    state: &MessengerRestState,
    headers: &HeaderMap,
) -> Result<Principal, RestError> {
    let verifier = state.jwt_verifier.as_ref().ok_or_else(|| {
        RestError::unavailable("JWT verification is not configured for messenger API")
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

    let org_id = OrgId::from_str(&claims.org)
        .map_err(|_| RestError::unauthorized("token contains an invalid org id"))?;
    Ok(Principal::new(user_id, org_id, roles, branch_scope))
}
