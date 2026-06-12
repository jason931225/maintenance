//! Work-order REST API.
//!
//! This layer handles JWT authentication, branch-scoped authorization, and
//! HTTP error mapping. State changes are delegated to the Postgres adapter,
//! which writes through `with_audit`.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::collections::BTreeSet;
use std::str::FromStr;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post, put};
use axum::{Json, Router};
use mnt_kernel_core::{
    BranchId, BranchScope, DailyPlanId, ErrorKind, KernelError, TraceContext, UserId, WorkOrderId,
};
use mnt_platform_auth::{AccessClaims, JwtVerifier};
use mnt_platform_authz::{Action, Feature, Principal, Role, authorize};
use mnt_workorder_adapter_postgres::{PgWorkOrderError, PgWorkOrderStore};
use mnt_workorder_application::{
    AssignmentInput, CreateDailyPlanCommand, CreateOutsourceWorkCommand, CreateWorkOrderCommand,
    DailyPlanItemInput, DailyPlanStatus, ReviewDailyPlanCommand, ReviewTargetChangeCommand,
    SendDailyPlanForReviewCommand, SubmitReportCommand, TargetChangeDecision,
    TargetChangeRequestCommand, UpdatePriorityCommand, WorkOrderApprovalCommand,
    WorkOrderAssignmentCommand, WorkOrderStartCommand,
};
use mnt_workorder_domain::{AssignmentRole, PriorityLevel, WorkResultType};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone)]
pub struct WorkOrderRestState {
    store: PgWorkOrderStore,
    jwt_verifier: Option<JwtVerifier>,
}

impl WorkOrderRestState {
    #[must_use]
    pub fn new(store: PgWorkOrderStore, jwt_verifier: Option<JwtVerifier>) -> Self {
        Self {
            store,
            jwt_verifier,
        }
    }
}

pub fn router(state: WorkOrderRestState) -> Router {
    Router::new()
        .route("/api/work-orders", post(create_work_order))
        .route("/api/work-orders/{work_order_id}", get(get_work_order))
        .route(
            "/api/work-orders/{work_order_id}/priority",
            patch(update_priority),
        )
        .route(
            "/api/work-orders/{work_order_id}/assignments",
            put(assign_work_order),
        )
        .route("/api/work-orders/{work_order_id}/start", post(start_work))
        .route(
            "/api/work-orders/{work_order_id}/report",
            post(submit_report),
        )
        .route(
            "/api/work-orders/{work_order_id}/approve",
            post(approve_work_order),
        )
        .route(
            "/api/work-orders/{work_order_id}/target-change-requests",
            post(request_target_change),
        )
        .route(
            "/api/target-change-requests/{request_id}/review",
            post(review_target_change),
        )
        .route("/api/daily-work-plans", post(create_daily_plan))
        .route(
            "/api/daily-work-plans/{plan_id}/request-review",
            post(request_daily_plan_review),
        )
        .route(
            "/api/daily-work-plans/{plan_id}/review",
            post(review_daily_plan),
        )
        .route(
            "/api/daily-work-plans/{plan_id}/confirm",
            post(confirm_daily_plan),
        )
        .route(
            "/api/work-orders/{work_order_id}/outsource-works",
            post(create_outsource_work),
        )
        .with_state(state)
}

#[derive(Debug, Deserialize)]
struct CreateWorkOrderRequest {
    branch_id: BranchId,
    management_no: String,
    symptom: String,
    customer_request: Option<String>,
    target_due_at: Option<time::OffsetDateTime>,
}

#[derive(Debug, Deserialize)]
struct UpdatePriorityRequest {
    priority: PriorityLevel,
}

#[derive(Debug, Deserialize)]
struct AssignmentRequest {
    mechanic_id: UserId,
    role: AssignmentRole,
}

#[derive(Debug, Deserialize)]
struct AssignWorkOrderRequest {
    assignments: Vec<AssignmentRequest>,
    admin_approver_id: Option<UserId>,
    executive_approver_id: Option<UserId>,
}

#[derive(Debug, Deserialize)]
struct SubmitReportRequest {
    result_type: WorkResultType,
    diagnosis: String,
    action_taken: String,
}

#[derive(Debug, Deserialize)]
struct TargetChangeRequestBody {
    requested_target_due_at: time::OffsetDateTime,
    reason: String,
}

#[derive(Debug, Deserialize)]
struct ReviewTargetChangeRequestBody {
    decision: TargetChangeDecision,
    memo: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DailyPlanItemRequest {
    work_order_id: Option<WorkOrderId>,
    description: String,
}

#[derive(Debug, Deserialize)]
struct CreateDailyPlanRequest {
    branch_id: BranchId,
    mechanic_id: UserId,
    plan_date: time::Date,
    items: Vec<DailyPlanItemRequest>,
}

#[derive(Debug, Deserialize)]
struct ReviewDailyPlanRequestBody {
    decision: DailyPlanStatus,
    memo: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CreateOutsourceWorkRequest {
    vendor_name: String,
    vendor_contact: Option<String>,
    reason: String,
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
    kind: ErrorKind,
    message: String,
}

impl RestError {
    fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            kind: ErrorKind::Forbidden,
            message: message.into(),
        }
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            kind: ErrorKind::Internal,
            message: message.into(),
        }
    }

    fn from_kernel(error: KernelError) -> Self {
        Self {
            status: status_for_error_kind(error.kind),
            kind: error.kind,
            message: error.message,
        }
    }

    fn from_store(error: PgWorkOrderError) -> Self {
        let kind = error.kind();
        Self {
            status: status_for_error_kind(kind),
            kind,
            message: error.to_string(),
        }
    }
}

impl IntoResponse for RestError {
    fn into_response(self) -> Response {
        let code = match self.kind {
            ErrorKind::Validation => "validation",
            ErrorKind::NotFound => "not_found",
            ErrorKind::Forbidden => "forbidden",
            ErrorKind::Conflict => "conflict",
            ErrorKind::InvalidTransition => "invalid_transition",
            ErrorKind::Internal => "internal",
        };
        (
            self.status,
            Json(ErrorBody {
                error: ErrorPayload {
                    code,
                    message: self.message,
                },
            }),
        )
            .into_response()
    }
}

async fn create_work_order(
    State(state): State<WorkOrderRestState>,
    headers: HeaderMap,
    Json(body): Json<CreateWorkOrderRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    authorize(
        &principal,
        Action::limited(Feature::WorkOrderCreate),
        body.branch_id,
    )
    .map_err(RestError::from_kernel)?;
    let actor = principal.user_id;
    let summary = state
        .store
        .create_work_order(CreateWorkOrderCommand {
            actor,
            branch_id: body.branch_id,
            management_no: body.management_no,
            symptom: body.symptom,
            customer_request: body.customer_request,
            target_due_at: body.target_due_at,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok((StatusCode::CREATED, Json(summary)))
}

async fn get_work_order(
    State(state): State<WorkOrderRestState>,
    headers: HeaderMap,
    Path(work_order_id): Path<uuid::Uuid>,
) -> Result<impl IntoResponse, RestError> {
    let work_order_id = WorkOrderId::from_uuid(work_order_id);
    let principal = principal_from_headers(&state, &headers)?;
    let summary = state
        .store
        .work_order(work_order_id)
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

async fn update_priority(
    State(state): State<WorkOrderRestState>,
    headers: HeaderMap,
    Path(work_order_id): Path<uuid::Uuid>,
    Json(body): Json<UpdatePriorityRequest>,
) -> Result<impl IntoResponse, RestError> {
    let work_order_id = WorkOrderId::from_uuid(work_order_id);
    let principal = authorize_for_work_order(
        &state,
        &headers,
        work_order_id,
        Action::new(Feature::PriorityManage),
    )
    .await?;
    let summary = state
        .store
        .update_priority(UpdatePriorityCommand {
            actor: principal.user_id,
            work_order_id,
            priority: body.priority,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(summary))
}

async fn assign_work_order(
    State(state): State<WorkOrderRestState>,
    headers: HeaderMap,
    Path(work_order_id): Path<uuid::Uuid>,
    Json(body): Json<AssignWorkOrderRequest>,
) -> Result<impl IntoResponse, RestError> {
    let work_order_id = WorkOrderId::from_uuid(work_order_id);
    let principal = authorize_for_work_order(
        &state,
        &headers,
        work_order_id,
        Action::new(Feature::AssigneeManage),
    )
    .await?;
    let assignments = body
        .assignments
        .into_iter()
        .map(|assignment| AssignmentInput {
            mechanic_id: assignment.mechanic_id,
            role: assignment.role,
        })
        .collect();
    let summary = state
        .store
        .assign_work_order(WorkOrderAssignmentCommand {
            actor: principal.user_id,
            work_order_id,
            assignments,
            admin_approver_id: body.admin_approver_id,
            executive_approver_id: body.executive_approver_id,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(summary))
}

async fn start_work(
    State(state): State<WorkOrderRestState>,
    headers: HeaderMap,
    Path(work_order_id): Path<uuid::Uuid>,
) -> Result<impl IntoResponse, RestError> {
    let work_order_id = WorkOrderId::from_uuid(work_order_id);
    let principal = authorize_for_work_order(
        &state,
        &headers,
        work_order_id,
        Action::new(Feature::WorkOrderStart),
    )
    .await?;
    let summary = state
        .store
        .start_work(WorkOrderStartCommand {
            actor: principal.user_id,
            work_order_id,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(summary))
}

async fn submit_report(
    State(state): State<WorkOrderRestState>,
    headers: HeaderMap,
    Path(work_order_id): Path<uuid::Uuid>,
    Json(body): Json<SubmitReportRequest>,
) -> Result<impl IntoResponse, RestError> {
    let work_order_id = WorkOrderId::from_uuid(work_order_id);
    let principal = authorize_for_work_order(
        &state,
        &headers,
        work_order_id,
        Action::new(Feature::WorkReportSubmit),
    )
    .await?;
    let summary = state
        .store
        .submit_report(SubmitReportCommand {
            actor: principal.user_id,
            work_order_id,
            result_type: body.result_type,
            diagnosis: body.diagnosis,
            action_taken: body.action_taken,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(summary))
}

async fn approve_work_order(
    State(state): State<WorkOrderRestState>,
    headers: HeaderMap,
    Path(work_order_id): Path<uuid::Uuid>,
) -> Result<impl IntoResponse, RestError> {
    let work_order_id = WorkOrderId::from_uuid(work_order_id);
    let principal = authorize_for_work_order(
        &state,
        &headers,
        work_order_id,
        Action::new(Feature::CompletionReview),
    )
    .await?;
    let summary = state
        .store
        .approve_work_order(WorkOrderApprovalCommand {
            actor: principal.user_id,
            work_order_id,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(summary))
}

async fn request_target_change(
    State(state): State<WorkOrderRestState>,
    headers: HeaderMap,
    Path(work_order_id): Path<uuid::Uuid>,
    Json(body): Json<TargetChangeRequestBody>,
) -> Result<impl IntoResponse, RestError> {
    let work_order_id = WorkOrderId::from_uuid(work_order_id);
    let principal = authorize_for_work_order(
        &state,
        &headers,
        work_order_id,
        Action::request(Feature::TargetManage),
    )
    .await?;
    let summary = state
        .store
        .request_target_change(TargetChangeRequestCommand {
            actor: principal.user_id,
            work_order_id,
            requested_target_due_at: body.requested_target_due_at,
            reason: body.reason,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok((StatusCode::CREATED, Json(summary)))
}

async fn review_target_change(
    State(state): State<WorkOrderRestState>,
    headers: HeaderMap,
    Path(request_id): Path<uuid::Uuid>,
    Json(body): Json<ReviewTargetChangeRequestBody>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    let target = state
        .store
        .target_change_request(request_id)
        .await
        .map_err(RestError::from_store)?;
    authorize(
        &principal,
        Action::new(Feature::TargetManage),
        target.branch_id,
    )
    .map_err(RestError::from_kernel)?;
    let summary = state
        .store
        .review_target_change(ReviewTargetChangeCommand {
            actor: principal.user_id,
            request_id,
            decision: body.decision,
            memo: body.memo,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(summary))
}

async fn create_daily_plan(
    State(state): State<WorkOrderRestState>,
    headers: HeaderMap,
    Json(body): Json<CreateDailyPlanRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    authorize(
        &principal,
        Action::new(Feature::DailyPlanRequest),
        body.branch_id,
    )
    .map_err(RestError::from_kernel)?;
    let items = body
        .items
        .into_iter()
        .map(|item| DailyPlanItemInput {
            work_order_id: item.work_order_id,
            description: item.description,
        })
        .collect();
    let summary = state
        .store
        .create_daily_plan(CreateDailyPlanCommand {
            actor: principal.user_id,
            branch_id: body.branch_id,
            mechanic_id: body.mechanic_id,
            plan_date: body.plan_date,
            items,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok((StatusCode::CREATED, Json(summary)))
}

async fn request_daily_plan_review(
    State(state): State<WorkOrderRestState>,
    headers: HeaderMap,
    Path(plan_id): Path<uuid::Uuid>,
) -> Result<impl IntoResponse, RestError> {
    transition_daily_plan_endpoint(
        state,
        headers,
        DailyPlanId::from_uuid(plan_id),
        Action::new(Feature::DailyPlanRequest),
        DailyPlanEndpointAction::RequestReview,
    )
    .await
}

async fn review_daily_plan(
    State(state): State<WorkOrderRestState>,
    headers: HeaderMap,
    Path(plan_id): Path<uuid::Uuid>,
    Json(body): Json<ReviewDailyPlanRequestBody>,
) -> Result<impl IntoResponse, RestError> {
    let plan_id = DailyPlanId::from_uuid(plan_id);
    let principal = principal_from_headers(&state, &headers)?;
    let plan = state
        .store
        .daily_plan(plan_id)
        .await
        .map_err(RestError::from_store)?;
    authorize(
        &principal,
        Action::new(Feature::DailyPlanReview),
        plan.branch_id,
    )
    .map_err(RestError::from_kernel)?;
    let summary = state
        .store
        .review_daily_plan(ReviewDailyPlanCommand {
            actor: principal.user_id,
            plan_id,
            decision: body.decision,
            memo: body.memo,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(summary))
}

async fn confirm_daily_plan(
    State(state): State<WorkOrderRestState>,
    headers: HeaderMap,
    Path(plan_id): Path<uuid::Uuid>,
) -> Result<impl IntoResponse, RestError> {
    transition_daily_plan_endpoint(
        state,
        headers,
        DailyPlanId::from_uuid(plan_id),
        Action::new(Feature::DailyPlanRequest),
        DailyPlanEndpointAction::Confirm,
    )
    .await
}

async fn create_outsource_work(
    State(state): State<WorkOrderRestState>,
    headers: HeaderMap,
    Path(work_order_id): Path<uuid::Uuid>,
    Json(body): Json<CreateOutsourceWorkRequest>,
) -> Result<impl IntoResponse, RestError> {
    let work_order_id = WorkOrderId::from_uuid(work_order_id);
    let principal = authorize_for_work_order(
        &state,
        &headers,
        work_order_id,
        Action::new(Feature::PriorityManage),
    )
    .await?;
    let summary = state
        .store
        .create_outsource_work(CreateOutsourceWorkCommand {
            actor: principal.user_id,
            work_order_id,
            vendor_name: body.vendor_name,
            vendor_contact: body.vendor_contact,
            reason: body.reason,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok((StatusCode::CREATED, Json(summary)))
}

enum DailyPlanEndpointAction {
    RequestReview,
    Confirm,
}

async fn transition_daily_plan_endpoint(
    state: WorkOrderRestState,
    headers: HeaderMap,
    plan_id: DailyPlanId,
    action: Action,
    endpoint_action: DailyPlanEndpointAction,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    let plan = state
        .store
        .daily_plan(plan_id)
        .await
        .map_err(RestError::from_store)?;
    authorize(&principal, action, plan.branch_id).map_err(RestError::from_kernel)?;
    let command = SendDailyPlanForReviewCommand {
        actor: principal.user_id,
        plan_id,
        trace: TraceContext::generate(),
        occurred_at: time::OffsetDateTime::now_utc(),
    };
    let summary = match endpoint_action {
        DailyPlanEndpointAction::RequestReview => {
            state.store.request_daily_plan_review(command).await
        }
        DailyPlanEndpointAction::Confirm => state.store.confirm_daily_plan(command).await,
    }
    .map_err(RestError::from_store)?;
    Ok(Json(summary).into_response())
}

async fn authorize_for_work_order(
    state: &WorkOrderRestState,
    headers: &HeaderMap,
    work_order_id: WorkOrderId,
    action: Action,
) -> Result<Principal, RestError> {
    let principal = principal_from_headers(state, headers)?;
    let summary = state
        .store
        .work_order(work_order_id)
        .await
        .map_err(RestError::from_store)?;
    authorize(&principal, action, summary.branch_id).map_err(RestError::from_kernel)?;
    Ok(principal)
}

fn principal_from_headers(
    state: &WorkOrderRestState,
    headers: &HeaderMap,
) -> Result<Principal, RestError> {
    let verifier = state.jwt_verifier.as_ref().ok_or_else(|| {
        RestError::unavailable("JWT verification is not configured for work-order API")
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

fn status_for_error_kind(kind: ErrorKind) -> StatusCode {
    match kind {
        ErrorKind::Validation => StatusCode::UNPROCESSABLE_ENTITY,
        ErrorKind::NotFound => StatusCode::NOT_FOUND,
        ErrorKind::Forbidden => StatusCode::FORBIDDEN,
        ErrorKind::Conflict | ErrorKind::InvalidTransition => StatusCode::CONFLICT,
        ErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
    }
}
