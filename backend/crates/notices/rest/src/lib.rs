//! Notice-board (게시판 NT- 공지) REST API.
//!
//! A published notice's title/body/progress is readable by any authenticated
//! org member; drafts and the publish/progress-read mutations are gated
//! behind [`Feature::NoticeManage`] (the HQ/announcement tier). 수령확인
//! (receipt acknowledgment) is recipient-scoped from the authenticated
//! principal, exactly like the notifications mark-read idiom — never from
//! request input.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use mnt_kernel_core::{ErrorKind, KernelError, NoticeId, TraceContext};
use mnt_notices_adapter_postgres::{PgNoticeError, PgNoticeStore};
use mnt_notices_application::{
    AcknowledgeNoticeCommand, CreateDraftNoticeCommand, GetNoticeQuery, ListNoticesQuery,
    NoticeProgressQuery, PublishNoticeCommand,
};
use mnt_platform_auth::JwtVerifier;
use mnt_platform_authz::{Action, Feature, Principal, authorize_org_wide};
use mnt_platform_request_context::RequestContextError;
use serde::{Deserialize, Serialize};

pub const NOTICES_PATH: &str = "/api/v1/notices";
pub const NOTICE_PATH_TEMPLATE: &str = "/api/v1/notices/{id}";
pub const NOTICE_PUBLISH_PATH_TEMPLATE: &str = "/api/v1/notices/{id}/publish";
pub const NOTICE_ACK_PATH_TEMPLATE: &str = "/api/v1/notices/{id}/ack";
pub const NOTICE_PROGRESS_PATH_TEMPLATE: &str = "/api/v1/notices/{id}/progress";

pub const NOTICES_ROUTE_PATHS: &[&str] = &[
    NOTICES_PATH,
    NOTICE_PATH_TEMPLATE,
    NOTICE_PUBLISH_PATH_TEMPLATE,
    NOTICE_ACK_PATH_TEMPLATE,
    NOTICE_PROGRESS_PATH_TEMPLATE,
];

#[derive(Debug, Clone)]
pub struct NoticeRestState {
    store: PgNoticeStore,
    jwt_verifier: Option<JwtVerifier>,
}

impl NoticeRestState {
    #[must_use]
    pub fn new(store: PgNoticeStore, jwt_verifier: Option<JwtVerifier>) -> Self {
        Self {
            store,
            jwt_verifier,
        }
    }
}

pub fn router(state: NoticeRestState) -> Router {
    let verifier = state.jwt_verifier.clone();
    let pool = state.store.pool().clone();
    let router = Router::new()
        .route(NOTICES_PATH, get(list_notices).post(create_draft))
        .route(NOTICE_PATH_TEMPLATE, get(get_notice))
        .route(NOTICE_PUBLISH_PATH_TEMPLATE, post(publish_notice))
        .route(NOTICE_ACK_PATH_TEMPLATE, post(acknowledge_notice))
        .route(NOTICE_PROGRESS_PATH_TEMPLATE, get(notice_progress))
        .with_state(state);
    mnt_platform_request_context::with_request_context(router, verifier, pool)
}

#[derive(Debug, Deserialize)]
struct CreateDraftBody {
    title: String,
    body: String,
}

#[derive(Debug, Deserialize)]
struct ListParams {
    limit: Option<i64>,
}

/// `true` when the principal holds the publish tier (draft visibility +
/// publish/progress). Deny-by-default on the authz check: any error (missing
/// grant, scope failure, …) is treated as "not a manager", not surfaced.
fn is_notice_manager(principal: &Principal) -> bool {
    authorize_org_wide(principal, Action::new(Feature::NoticeManage)).is_ok()
}

fn require_notice_manager(principal: &Principal) -> Result<(), RestError> {
    authorize_org_wide(principal, Action::new(Feature::NoticeManage))
        .map_err(RestError::from_kernel)
}

async fn create_draft(
    State(state): State<NoticeRestState>,
    headers: HeaderMap,
    Json(body): Json<CreateDraftBody>,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    require_notice_manager(&principal)?;
    let summary = state
        .store
        .create_draft(CreateDraftNoticeCommand {
            author: principal.user_id,
            title: body.title,
            body: body.body,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok((StatusCode::CREATED, Json(summary)).into_response())
}

async fn list_notices(
    State(state): State<NoticeRestState>,
    headers: HeaderMap,
    Query(params): Query<ListParams>,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let items = state
        .store
        .list(ListNoticesQuery {
            include_drafts: is_notice_manager(&principal),
            limit: params.limit.unwrap_or(50),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(items).into_response())
}

async fn get_notice(
    State(state): State<NoticeRestState>,
    headers: HeaderMap,
    Path(notice_id): Path<NoticeId>,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let summary = state
        .store
        .get(GetNoticeQuery { notice_id }, is_notice_manager(&principal))
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(summary).into_response())
}

async fn publish_notice(
    State(state): State<NoticeRestState>,
    headers: HeaderMap,
    Path(notice_id): Path<NoticeId>,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    require_notice_manager(&principal)?;
    let summary = state
        .store
        .publish(PublishNoticeCommand {
            notice_id,
            publisher: principal.user_id,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(summary).into_response())
}

async fn acknowledge_notice(
    State(state): State<NoticeRestState>,
    headers: HeaderMap,
    Path(notice_id): Path<NoticeId>,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    state
        .store
        .acknowledge(AcknowledgeNoticeCommand {
            notice_id,
            recipient: principal.user_id,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn notice_progress(
    State(state): State<NoticeRestState>,
    headers: HeaderMap,
    Path(notice_id): Path<NoticeId>,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    require_notice_manager(&principal)?;
    let progress = state
        .store
        .progress(NoticeProgressQuery { notice_id })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(progress).into_response())
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

    fn from_store(err: PgNoticeError) -> Self {
        match err {
            PgNoticeError::Domain(err) => Self::from_kernel(err),
            PgNoticeError::Db(_) => {
                // Never leak sqlx/schema internals (OWASP A05). Log server-side.
                tracing::error!(error = %err, "notice store error");
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

async fn principal_from_headers(
    state: &NoticeRestState,
    headers: &HeaderMap,
) -> Result<Principal, RestError> {
    let verifier = state.jwt_verifier.as_ref().ok_or_else(|| {
        RestError::unavailable("JWT verification is not configured for notices API")
    })?;
    mnt_platform_request_context::resolve_principal(verifier, state.store.pool(), headers)
        .await
        .map_err(rest_error_from_request_context)
}

fn rest_error_from_request_context(err: RequestContextError) -> RestError {
    match err {
        RequestContextError::VerifierUnavailable => {
            RestError::unavailable("JWT verification is not configured for notices API")
        }
        RequestContextError::WrongTokenTier => RestError::from_kernel(KernelError::forbidden(
            "token tier is not valid for this route",
        )),
        RequestContextError::AccessScope(error) => RestError::from_kernel(error),
        RequestContextError::BranchScope(message)
        | RequestContextError::EffectivePolicy(message) => {
            RestError::from_kernel(KernelError::internal(message))
        }
        RequestContextError::MissingOrg => RestError::from_kernel(KernelError::internal(
            "no tenant context is bound to the current request",
        )),
        RequestContextError::MissingBearer => {
            RestError::unauthorized("missing or malformed bearer token")
        }
        RequestContextError::InvalidToken => RestError::unauthorized("invalid bearer token"),
        RequestContextError::InvalidClaim(message) => {
            RestError::unauthorized(format!("token claim is invalid: {message}"))
        }
    }
}
