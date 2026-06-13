//! REST API for P1 emergency dispatch.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::collections::{BTreeMap, BTreeSet};
use std::str::FromStr;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use mnt_dispatch_adapter_postgres::{PendingFcmPush, PgDispatchError, PgDispatchStore};
use mnt_dispatch_application::{
    ForceAssignP1DispatchCommand, IncidentLocationInput, P1DispatchSummary,
    RespondP1DispatchCommand, StartP1DispatchCommand,
};
use mnt_dispatch_domain::{DispatchResponseKind, DispatchTimerConfig};
use mnt_kernel_core::{
    BranchId, BranchScope, ErrorKind, KernelError, P1DispatchAlertId, P1DispatchId, TraceContext,
    UserId, WorkOrderId,
};
use mnt_platform_auth::{AccessClaims, JwtVerifier};
use mnt_platform_authz::{Action, Feature, Principal, Role, authorize};
use mnt_platform_jobs::{JobQueue, JobQueueError, JobRequest};
use mnt_platform_push::{FcmPushMessage, PushError, PushNotifier};
use serde::{Deserialize, Serialize};

#[derive(Clone)]
pub struct DispatchRestState {
    store: PgDispatchStore,
    jwt_verifier: Option<JwtVerifier>,
    timers: DispatchTimerConfig,
    job_queue: Option<Arc<dyn JobQueue>>,
    push_notifier: Option<Arc<dyn PushNotifier>>,
}

impl DispatchRestState {
    #[must_use]
    pub fn new(
        store: PgDispatchStore,
        jwt_verifier: Option<JwtVerifier>,
        timers: DispatchTimerConfig,
        job_queue: Option<Arc<dyn JobQueue>>,
        push_notifier: Option<Arc<dyn PushNotifier>>,
    ) -> Self {
        Self {
            store,
            jwt_verifier,
            timers,
            job_queue,
            push_notifier,
        }
    }
}

pub fn router(state: DispatchRestState) -> Router {
    Router::new()
        .route(
            "/api/v1/work-orders/{work_order_id}/p1-dispatch",
            post(start_dispatch),
        )
        .route("/api/v1/p1-dispatches/{dispatch_id}", get(get_dispatch))
        .route(
            "/api/v1/p1-dispatches/{dispatch_id}/responses",
            post(respond_dispatch),
        )
        .route(
            "/api/v1/p1-dispatches/{dispatch_id}/force-assign",
            post(force_assign),
        )
        .with_state(state)
}

#[derive(Debug, Deserialize)]
struct StartDispatchRequest {
    incident_location: Option<IncidentLocationInput>,
    include_region: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct RespondDispatchRequest {
    response: DispatchResponseKind,
}

#[derive(Debug, Deserialize)]
struct ForceAssignRequest {
    mechanic_id: UserId,
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

async fn start_dispatch(
    State(state): State<DispatchRestState>,
    headers: HeaderMap,
    Path(work_order_id): Path<WorkOrderId>,
    Json(body): Json<StartDispatchRequest>,
) -> Result<Json<P1DispatchSummary>, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    let branch_id = state
        .store
        .work_order_branch(work_order_id)
        .await
        .map_err(RestError::from_store)?;
    authorize(&principal, Action::new(Feature::WorkOrderCreate), branch_id)
        .map_err(RestError::from_kernel)?;
    let summary = state
        .store
        .start_dispatch(
            StartP1DispatchCommand {
                actor: principal.user_id,
                work_order_id,
                incident_location: body.incident_location,
                include_region: body.include_region.unwrap_or(false),
                trace: current_trace_context(),
                occurred_at: time::OffsetDateTime::now_utc(),
            },
            state.timers,
        )
        .await
        .map_err(RestError::from_store)?;
    schedule_dispatch_jobs(&state, &summary).await?;
    deliver_fcm_pushes(&state, summary.id).await?;
    Ok(Json(summary))
}

async fn respond_dispatch(
    State(state): State<DispatchRestState>,
    headers: HeaderMap,
    Path(dispatch_id): Path<P1DispatchId>,
    Json(body): Json<RespondDispatchRequest>,
) -> Result<Json<P1DispatchSummary>, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    let current = state
        .store
        .dispatch(dispatch_id)
        .await
        .map_err(RestError::from_store)?;
    authorize(
        &principal,
        Action::new(Feature::WorkOrderStart),
        current.branch_id,
    )
    .map_err(RestError::from_kernel)?;
    let summary = state
        .store
        .record_response(
            RespondP1DispatchCommand {
                actor: principal.user_id,
                dispatch_id,
                response: body.response,
                trace: current_trace_context(),
                occurred_at: time::OffsetDateTime::now_utc(),
            },
            state.timers,
        )
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(summary))
}

async fn get_dispatch(
    State(state): State<DispatchRestState>,
    headers: HeaderMap,
    Path(dispatch_id): Path<P1DispatchId>,
) -> Result<Json<P1DispatchSummary>, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    let summary = state
        .store
        .dispatch(dispatch_id)
        .await
        .map_err(RestError::from_store)?;
    authorize(
        &principal,
        Action::new(Feature::WorkOrderReadAll),
        summary.branch_id,
    )
    .map_err(RestError::from_kernel)?;
    Ok(Json(summary))
}

async fn force_assign(
    State(state): State<DispatchRestState>,
    headers: HeaderMap,
    Path(dispatch_id): Path<P1DispatchId>,
    Json(body): Json<ForceAssignRequest>,
) -> Result<Json<P1DispatchSummary>, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    let current = state
        .store
        .dispatch(dispatch_id)
        .await
        .map_err(RestError::from_store)?;
    authorize(
        &principal,
        Action::new(Feature::AssigneeManage),
        current.branch_id,
    )
    .map_err(RestError::from_kernel)?;
    let summary = state
        .store
        .force_assign(ForceAssignP1DispatchCommand {
            actor: principal.user_id,
            dispatch_id,
            mechanic_id: body.mechanic_id,
            trace: current_trace_context(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(summary))
}

async fn schedule_dispatch_jobs(
    state: &DispatchRestState,
    summary: &P1DispatchSummary,
) -> Result<(), RestError> {
    let Some(queue) = state.job_queue.as_ref() else {
        return Ok(());
    };
    let accept =
        JobRequest::dispatch_accept_window_expired(summary.id, summary.accept_window_ends_at)
            .map_err(RestError::from_jobs)?;
    queue
        .schedule_at(accept, summary.accept_window_ends_at)
        .await
        .map_err(RestError::from_jobs)?;
    let no_ack_at = summary
        .accept_window_started_at
        .checked_add(state.timers.alimtalk_no_ack_after)
        .ok_or_else(|| RestError::internal("dispatch Alimtalk timer overflows time"))?;
    let no_ack = JobRequest::dispatch_alimtalk_no_ack(summary.id, no_ack_at)
        .map_err(RestError::from_jobs)?;
    queue
        .schedule_at(no_ack, no_ack_at)
        .await
        .map_err(RestError::from_jobs)?;
    let manual_call_at = summary
        .accept_window_started_at
        .checked_add(state.timers.force_assign_alert_after)
        .ok_or_else(|| RestError::internal("dispatch manual-call timer overflows time"))?;
    let manual_call = JobRequest::dispatch_manual_call_required(summary.id, manual_call_at)
        .map_err(RestError::from_jobs)?;
    queue
        .schedule_at(manual_call, manual_call_at)
        .await
        .map_err(RestError::from_jobs)?;
    Ok(())
}

async fn deliver_fcm_pushes(
    state: &DispatchRestState,
    dispatch_id: P1DispatchId,
) -> Result<(), RestError> {
    let Some(notifier) = state.push_notifier.as_ref() else {
        return Ok(());
    };
    let pushes = state
        .store
        .claim_fcm_pushes(dispatch_id, "FCM_PUSH", time::OffsetDateTime::now_utc())
        .await
        .map_err(RestError::from_store)?;
    for push in pushes {
        send_one_fcm(state, notifier.as_ref(), push).await?;
    }
    Ok(())
}

async fn send_one_fcm(
    state: &DispatchRestState,
    notifier: &dyn PushNotifier,
    push: PendingFcmPush,
) -> Result<(), RestError> {
    let data = BTreeMap::from([
        ("type".to_owned(), "p1_dispatch".to_owned()),
        ("dispatch_id".to_owned(), push.dispatch_id.to_string()),
        ("work_order_id".to_owned(), push.work_order_id.to_string()),
    ]);
    let lease_token = push.lease_token;
    let alert_id = push.alert_id;
    let message = FcmPushMessage {
        token: push.push_token,
        title: "P1 emergency dispatch".to_owned(),
        body: "Immediate response requested".to_owned(),
        data,
        idempotency_key: push.idempotency_key,
    };
    match notifier.send_fcm(message).await {
        Ok(provider_id) => {
            let lease_held = state
                .store
                .mark_alert_sent(
                    alert_id,
                    lease_token,
                    if provider_id.0.is_empty() {
                        None
                    } else {
                        Some(provider_id.0)
                    },
                    TraceContext::generate(),
                    time::OffsetDateTime::now_utc(),
                )
                .await
                .map_err(RestError::from_store)?;
            warn_if_lease_lost(lease_held, alert_id);
        }
        Err(err) => {
            let lease_held = state
                .store
                .mark_alert_failed(
                    alert_id,
                    lease_token,
                    provider_failure_reason(err),
                    TraceContext::generate(),
                    time::OffsetDateTime::now_utc(),
                )
                .await
                .map_err(RestError::from_store)?;
            warn_if_lease_lost(lease_held, alert_id);
        }
    }
    Ok(())
}

/// Consume the lost-lease signal from a `mark_alert_*` transition. `false` means
/// the lease was reclaimed elsewhere (e.g. after a crash) and the transition was
/// a no-op; surface it so the designed double-handling guard is observable.
fn warn_if_lease_lost(lease_held: bool, alert_id: P1DispatchAlertId) {
    if !lease_held {
        tracing::warn!(
            %alert_id,
            "alert lease lost before status mark; transition was a no-op (reclaimed elsewhere)"
        );
    }
}

fn provider_failure_reason(err: PushError) -> String {
    let message = err.to_string();
    if message.len() > 512 {
        message.chars().take(512).collect()
    } else {
        message
    }
}

fn principal_from_headers(
    state: &DispatchRestState,
    headers: &HeaderMap,
) -> Result<Principal, RestError> {
    let verifier = state
        .jwt_verifier
        .as_ref()
        .ok_or_else(|| RestError::unavailable("JWT verification is not configured"))?;
    let token = bearer_token(headers)?;
    let claims = verifier
        .verify_access_token(token)
        .map_err(|_| RestError::unauthorized("invalid bearer token"))?;
    principal_from_claims(claims)
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

fn current_trace_context() -> TraceContext {
    TraceContext::generate()
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
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "service_unavailable",
            message,
        )
    }

    fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", message)
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

    fn from_store(error: PgDispatchError) -> Self {
        match error {
            // Domain errors carry safe, caller-facing messages.
            PgDispatchError::Domain(kernel) => Self::from_kernel(kernel),
            // Db errors must never surface raw sqlx strings / 23505 constraint
            // names to the client (schema disclosure, OWASP A05). Classify by
            // kind, log the raw error server-side, return stable generic messages.
            db_error => {
                let kind = db_error.kind();
                tracing::error!(error = %db_error, "dispatch database error");
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

    fn from_jobs(error: JobQueueError) -> Self {
        // Job-queue failures are internal; log the detail, return a stable message.
        tracing::error!(error = %error, "job queue error");
        Self::internal("internal server error")
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
