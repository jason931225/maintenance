//! Leave-request REST API (연차 결재 + §61 촉진).
//!
//! Reads are gated on `employee_directory_read`, mutations on
//! `employee_directory_manage` — the branch HR/manager tier. The tenant (org)
//! is always bound from the authenticated principal; the approval queue and
//! decide path are additionally *branch*-scoped from the principal's resolved
//! [`BranchScope`], so an approver only sees and acts on their own branches.
//! The statutory push validates its target `branch_id` against the actor's
//! scope via [`authorize`] — a branch outside the actor's scope is rejected,
//! never trusted from input.
//!
//! Separation of duties: the decide path forbids a requester from deciding
//! their own request (enforced in the adapter + a DB CHECK), mirroring the
//! workflow-engine initiator guard (#205).
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use mnt_kernel_core::{BranchScope, ErrorKind, KernelError, LeaveRequestId, TraceContext, UserId};
use mnt_leave_adapter_postgres::{PgLeaveError, PgLeaveStore};
use mnt_leave_application::{
    DecideLeaveRequestCommand, ListLeaveRequestsQuery, StatutoryPushCommand,
};
use mnt_leave_domain::{LeaveDecision, LeaveStatus, PromotionKind};
use mnt_platform_auth::JwtVerifier;
use mnt_platform_authz::{Action, Feature, Principal, authorize, authorize_org_wide};
use mnt_platform_request_context::RequestContextError;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const LEAVE_REQUESTS_PATH: &str = "/api/v1/leave/requests";
pub const LEAVE_DECIDE_PATH_TEMPLATE: &str = "/api/v1/leave/requests/{id}/decide";
pub const LEAVE_BALANCES_PATH: &str = "/api/v1/leave/balances";
pub const LEAVE_PROMOTIONS_PATH: &str = "/api/v1/leave/promotions";
pub const LEAVE_REFUSAL_NOTICES_PATH: &str = "/api/v1/leave/refusal-notices";

pub const LEAVE_ROUTE_PATHS: &[&str] = &[
    LEAVE_REQUESTS_PATH,
    LEAVE_DECIDE_PATH_TEMPLATE,
    LEAVE_BALANCES_PATH,
    LEAVE_PROMOTIONS_PATH,
    LEAVE_REFUSAL_NOTICES_PATH,
];

#[derive(Clone)]
pub struct LeaveRestState {
    store: PgLeaveStore,
    jwt_verifier: Option<JwtVerifier>,
}

impl std::fmt::Debug for LeaveRestState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LeaveRestState")
            .field("has_jwt_verifier", &self.jwt_verifier.is_some())
            .finish()
    }
}

impl LeaveRestState {
    #[must_use]
    pub fn new(store: PgLeaveStore, jwt_verifier: Option<JwtVerifier>) -> Self {
        Self {
            store,
            jwt_verifier,
        }
    }
}

pub fn router(state: LeaveRestState) -> Router {
    let verifier = state.jwt_verifier.clone();
    let pool = state.store.pool().clone();
    let router = Router::new()
        .route(LEAVE_REQUESTS_PATH, get(list_requests))
        .route(LEAVE_DECIDE_PATH_TEMPLATE, post(decide))
        .route(LEAVE_BALANCES_PATH, get(list_balances))
        .route(LEAVE_PROMOTIONS_PATH, post(push_promotion))
        .route(LEAVE_REFUSAL_NOTICES_PATH, post(push_refusal))
        .with_state(state);
    mnt_platform_request_context::with_request_context(router, verifier, pool)
}

#[derive(Debug, Deserialize)]
struct ListParams {
    status: Option<String>,
    limit: Option<i64>,
}

async fn list_requests(
    State(state): State<LeaveRestState>,
    headers: HeaderMap,
    Query(params): Query<ListParams>,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    require_read(&principal)?;
    let status = match params.status.as_deref() {
        Some(s) => Some(LeaveStatus::parse(s).map_err(RestError::from_kernel)?),
        None => None,
    };
    let page = state
        .store
        .list_requests(ListLeaveRequestsQuery {
            branch_scope: principal.branch_scope.clone(),
            status,
            limit: params.limit.unwrap_or(100),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(page).into_response())
}

#[derive(Debug, Deserialize)]
struct DecideRequest {
    decision: String,
    #[serde(default)]
    comment: Option<String>,
}

async fn decide(
    State(state): State<LeaveRestState>,
    headers: HeaderMap,
    Path(id): Path<LeaveRequestId>,
    Json(body): Json<DecideRequest>,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    // Role gate: the branch HR/manager tier. Which requests they can touch is
    // confined by branch_scope in the store; SoD is enforced there too.
    require_manage(&principal)?;
    let decision = LeaveDecision::parse(&body.decision).map_err(RestError::from_kernel)?;
    let comment = mnt_leave_domain::validate_decision_comment(decision, body.comment.as_deref())
        .map_err(RestError::from_kernel)?;
    let view = state
        .store
        .decide(DecideLeaveRequestCommand {
            request_id: id,
            decider: principal.user_id,
            branch_scope: principal.branch_scope.clone(),
            decision,
            comment,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(view).into_response())
}

async fn list_balances(
    State(state): State<LeaveRestState>,
    headers: HeaderMap,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    require_read(&principal)?;
    let page = state
        .store
        .list_balances()
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(page).into_response())
}

#[derive(Debug, Deserialize)]
struct PromotionRequest {
    /// The branch the push is served under — validated against the actor's
    /// scope, never trusted blindly.
    branch_id: Uuid,
    target_user_id: Uuid,
    target_employee_id: Uuid,
    target_name: String,
    round: i16,
    #[serde(default)]
    unused_days: f64,
}

async fn push_promotion(
    State(state): State<LeaveRestState>,
    headers: HeaderMap,
    Json(body): Json<PromotionRequest>,
) -> Result<Response, RestError> {
    statutory_push(&state, &headers, PromotionKind::Promotion, body).await
}

#[derive(Debug, Deserialize)]
struct RefusalRequest {
    branch_id: Uuid,
    target_user_id: Uuid,
    target_employee_id: Uuid,
    target_name: String,
    #[serde(default)]
    unused_days: f64,
}

async fn push_refusal(
    State(state): State<LeaveRestState>,
    headers: HeaderMap,
    Json(body): Json<RefusalRequest>,
) -> Result<Response, RestError> {
    let promotion = PromotionRequest {
        branch_id: body.branch_id,
        target_user_id: body.target_user_id,
        target_employee_id: body.target_employee_id,
        target_name: body.target_name,
        // A refusal follows a completed round 2; the domain normalizes this.
        round: 2,
        unused_days: body.unused_days,
    };
    statutory_push(&state, &headers, PromotionKind::Refusal, promotion).await
}

async fn statutory_push(
    state: &LeaveRestState,
    headers: &HeaderMap,
    kind: PromotionKind,
    body: PromotionRequest,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(state, headers).await?;
    // Authorize the manage feature AGAINST the target branch: this both role-
    // gates the actor and confirms `branch_id` is within their scope, so a
    // branch outside the actor's scope is rejected rather than trusted.
    authorize(
        &principal,
        Action::new(Feature::EmployeeDirectoryManage),
        mnt_kernel_core::BranchId::from_uuid(body.branch_id),
    )
    .map_err(RestError::from_kernel)?;
    let view = state
        .store
        .statutory_push(StatutoryPushCommand {
            actor: principal.user_id,
            branch_id: body.branch_id,
            target_user_id: UserId::from_uuid(body.target_user_id),
            target_employee_id: body.target_employee_id,
            target_name: body.target_name,
            kind,
            round: body.round,
            unused_days: body.unused_days,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(view).into_response())
}

// ---------------------------------------------------------------------------
// Authorization helpers
// ---------------------------------------------------------------------------

/// Require the read tier (`employee_directory_read`). Role permission is
/// branch-independent, so an org-wide scope is checked org-wide and a
/// branch-scoped principal is checked against any one of its branches; the
/// branch confinement of returned rows happens in the store.
fn require_read(principal: &Principal) -> Result<(), RestError> {
    require_feature(principal, Feature::EmployeeDirectoryRead)
}

fn require_manage(principal: &Principal) -> Result<(), RestError> {
    require_feature(principal, Feature::EmployeeDirectoryManage)
}

fn require_feature(principal: &Principal, feature: Feature) -> Result<(), RestError> {
    let action = Action::new(feature);
    let result = match &principal.branch_scope {
        BranchScope::All => authorize_org_wide(principal, action),
        BranchScope::Branches(branches) => match branches.iter().next() {
            Some(branch) => authorize(principal, action, *branch),
            None => Err(KernelError::forbidden("principal has no branch scope")),
        },
    };
    result.map_err(RestError::from_kernel)
}

// ---------------------------------------------------------------------------
// Errors + principal resolution (mirrors the inbox REST surface)
// ---------------------------------------------------------------------------

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

    fn from_store(err: PgLeaveError) -> Self {
        match err {
            PgLeaveError::Domain(err) => Self::from_kernel(err),
            PgLeaveError::Db(_) => {
                // Never leak sqlx/schema internals (OWASP A05). Log server-side.
                tracing::error!(error = %err, "leave store error");
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
    state: &LeaveRestState,
    headers: &HeaderMap,
) -> Result<Principal, RestError> {
    let verifier = state.jwt_verifier.as_ref().ok_or_else(|| {
        RestError::unavailable("JWT verification is not configured for the leave API")
    })?;
    mnt_platform_request_context::resolve_principal(verifier, state.store.pool(), headers)
        .await
        .map_err(rest_error_from_request_context)
}

fn rest_error_from_request_context(err: RequestContextError) -> RestError {
    match err {
        RequestContextError::VerifierUnavailable => {
            RestError::unavailable("JWT verification is not configured for the leave API")
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

#[cfg(test)]
mod tests {
    use super::*;
    use mnt_kernel_core::{BranchId, OrgId};
    use mnt_platform_authz::Role;
    use std::collections::BTreeSet;

    fn principal(role: Role, branch: BranchId) -> Principal {
        Principal::new(
            UserId::new(),
            OrgId::knl(),
            BTreeSet::from([role]),
            BranchScope::Branches(BTreeSet::from([branch])),
        )
    }

    #[test]
    fn member_is_denied_read_and_manage() {
        let p = principal(Role::Member, BranchId::new());
        assert_eq!(
            require_read(&p).unwrap_err().status,
            StatusCode::FORBIDDEN,
            "a MEMBER cannot read the leave queue"
        );
        assert_eq!(
            require_manage(&p).unwrap_err().status,
            StatusCode::FORBIDDEN,
            "a MEMBER cannot decide leave"
        );
    }

    #[test]
    fn branch_admin_can_read_and_manage_its_branch() {
        let branch = BranchId::new();
        let p = principal(Role::Admin, branch);
        assert!(require_read(&p).is_ok());
        assert!(require_manage(&p).is_ok());
        // In-scope branch push authorization passes...
        assert!(authorize(&p, Action::new(Feature::EmployeeDirectoryManage), branch,).is_ok());
        // ...but a branch OUTSIDE the actor's scope is rejected, so a pushed
        // `branch_id` can never escape the actor's authority.
        assert!(
            authorize(
                &p,
                Action::new(Feature::EmployeeDirectoryManage),
                BranchId::new(),
            )
            .is_err(),
            "an out-of-scope branch_id must be rejected"
        );
    }
}
