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
    AuditAction, AuditEvent, BranchId, BranchScope, DailyPlanId, DeviceId, ErrorKind, EvidenceId,
    KernelError, TraceContext, UserId, WorkOrderId,
};
use mnt_platform_auth::{AccessClaims, JwtVerifier};
use mnt_platform_authz::{Action, Feature, Principal, Role, authorize};
use mnt_platform_db::{DbError, with_audit};
use mnt_platform_storage::{
    EvidenceService, EvidenceUploadCommand, EvidenceUploadTicket, PresignedUpload, S3ObjectStore,
    StorageError, WormReplicaStatus,
};
use mnt_workorder_adapter_postgres::{PgWorkOrderError, PgWorkOrderStore};
use mnt_workorder_application::{
    AssignmentInput, CreateDailyPlanCommand, CreateOutsourceWorkCommand, CreateWorkOrderCommand,
    DailyPlanItemInput, DailyPlanStatus, ReviewDailyPlanCommand, ReviewTargetChangeCommand,
    SendDailyPlanForReviewCommand, SubmitReportCommand, TargetChangeDecision,
    TargetChangeRequestCommand, UpdatePriorityCommand, WorkOrderApprovalCommand,
    WorkOrderAssignmentCommand, WorkOrderStartCommand,
};
use mnt_workorder_domain::{AssignmentRole, AttachmentStage, PriorityLevel, WorkResultType};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};

pub const SYNC_PATH: &str = "/api/v1/sync";
pub const EVIDENCE_PRESIGN_PATH: &str = "/api/v1/evidence/presign";
pub const EVIDENCE_CONFIRM_PATH_TEMPLATE: &str = "/api/v1/evidence/{evidenceId}/confirm";
pub const DEVICES_PATH: &str = "/api/v1/devices";
pub const MOBILE_ROUTE_PATHS: &[&str] = &[
    SYNC_PATH,
    EVIDENCE_PRESIGN_PATH,
    EVIDENCE_CONFIRM_PATH_TEMPLATE,
    DEVICES_PATH,
];

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

#[derive(Debug, Clone)]
pub struct MobileRestState<S> {
    pool: PgPool,
    store: PgWorkOrderStore,
    jwt_verifier: Option<JwtVerifier>,
    evidence_service: Option<EvidenceService<S>>,
}

impl<S> MobileRestState<S> {
    #[must_use]
    pub fn new(
        pool: PgPool,
        store: PgWorkOrderStore,
        jwt_verifier: Option<JwtVerifier>,
        evidence_service: Option<EvidenceService<S>>,
    ) -> Self {
        Self {
            pool,
            store,
            jwt_verifier,
            evidence_service,
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

pub fn mobile_router<S>(state: MobileRestState<S>) -> Router
where
    S: S3ObjectStore + Clone + Send + Sync + 'static,
{
    Router::new()
        .route(SYNC_PATH, post(sync_batch::<S>))
        .route(DEVICES_PATH, post(register_device::<S>))
        .route(EVIDENCE_PRESIGN_PATH, post(presign_evidence::<S>))
        .route(
            "/api/v1/evidence/{evidence_id}/confirm",
            post(confirm_evidence::<S>),
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

#[derive(Debug, Deserialize)]
struct SyncBatchRequest {
    sync_id: String,
    operations: Vec<SyncOperationRequest>,
}

#[derive(Debug, Clone, Deserialize)]
struct SyncOperationRequest {
    request_id: String,
    operation: SyncOperationKind,
    created_at: time::OffsetDateTime,
    payload: serde_json::Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum SyncOperationKind {
    WorkOrderStart,
    WorkOrderReport,
}

impl SyncOperationKind {
    const fn as_db_str(self) -> &'static str {
        match self {
            Self::WorkOrderStart => "WORK_ORDER_START",
            Self::WorkOrderReport => "WORK_ORDER_REPORT",
        }
    }
}

#[derive(Debug, Deserialize)]
struct SyncWorkOrderStartPayload {
    work_order_id: WorkOrderId,
}

#[derive(Debug, Deserialize)]
struct SyncWorkOrderReportPayload {
    work_order_id: WorkOrderId,
    result_type: WorkResultType,
    diagnosis: String,
    action_taken: String,
}

#[derive(Debug, Serialize)]
struct SyncBatchResponse {
    sync_id: String,
    results: Vec<SyncOperationResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SyncOperationResult {
    request_id: String,
    operation: SyncOperationKind,
    status: SyncOperationStatus,
    http_status: u16,
    result: Option<serde_json::Value>,
    error: Option<SyncErrorPayload>,
    replayed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum SyncOperationStatus {
    Applied,
    Failed,
}

impl SyncOperationStatus {
    const fn as_db_str(self) -> &'static str {
        match self {
            Self::Applied => "APPLIED",
            Self::Failed => "FAILED",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SyncErrorPayload {
    code: String,
    message: String,
}

#[derive(Debug, Deserialize)]
struct DeviceRegistrationRequest {
    platform: DevicePlatform,
    push_token: Option<String>,
    app_version: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum DevicePlatform {
    Ios,
    Android,
}

impl DevicePlatform {
    const fn as_db_str(self) -> &'static str {
        match self {
            Self::Ios => "IOS",
            Self::Android => "ANDROID",
        }
    }

    fn from_db_str(value: &str) -> Result<Self, KernelError> {
        match value {
            "IOS" => Ok(Self::Ios),
            "ANDROID" => Ok(Self::Android),
            other => Err(KernelError::validation(format!(
                "unknown device platform {other:?}"
            ))),
        }
    }
}

#[derive(Debug, Serialize)]
struct DeviceRegistrationResponse {
    id: DeviceId,
    user_id: UserId,
    device_hash: String,
    platform: DevicePlatform,
    push_token: Option<String>,
    app_version: String,
    last_registered_at: time::OffsetDateTime,
}

#[derive(Debug, Deserialize)]
struct EvidencePresignRequest {
    work_order_id: WorkOrderId,
    stage: AttachmentStage,
    content_type: String,
    size_bytes: i64,
    checksum_sha256: Option<String>,
}

#[derive(Debug, Serialize)]
struct EvidencePresignResponse {
    id: EvidenceId,
    work_order_id: WorkOrderId,
    stage: AttachmentStage,
    upload: PresignedUpload,
}

#[derive(Debug, Serialize)]
struct EvidenceConfirmResponse {
    id: EvidenceId,
    work_order_id: WorkOrderId,
    stage: AttachmentStage,
    worm_replica_status: WormReplicaStatus,
    retry_count: i32,
    verified_at: Option<time::OffsetDateTime>,
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
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            kind: ErrorKind::Validation,
            message: message.into(),
        }
    }

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

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
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

    fn from_storage(error: StorageError) -> Self {
        match error {
            StorageError::Domain(error) => Self::from_kernel(error),
            StorageError::Db(error) => Self::from_db(error),
            StorageError::S3(message)
            | StorageError::Presign(message)
            | StorageError::Verification(message) => Self::internal(message),
        }
    }

    fn from_db(error: DbError) -> Self {
        match error {
            DbError::Sqlx(sqlx::Error::RowNotFound) => {
                Self::from_kernel(KernelError::not_found("row was not found"))
            }
            DbError::Sqlx(sqlx::Error::Database(err))
                if err.code().is_some_and(|code| code == "23505") =>
            {
                Self::from_kernel(KernelError::conflict(err.message().to_owned()))
            }
            DbError::Sqlx(err) => Self::internal(err.to_string()),
            DbError::Serialize(err) => Self::internal(err.to_string()),
        }
    }

    fn code(&self) -> &'static str {
        match self.kind {
            ErrorKind::Validation => "validation",
            ErrorKind::NotFound => "not_found",
            ErrorKind::Forbidden => "forbidden",
            ErrorKind::Conflict => "conflict",
            ErrorKind::InvalidTransition => "invalid_transition",
            ErrorKind::Internal => "internal",
        }
    }
}

impl IntoResponse for RestError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorBody {
                error: ErrorPayload {
                    code: self.code(),
                    message: self.message,
                },
            }),
        )
            .into_response()
    }
}

impl From<DbError> for RestError {
    fn from(value: DbError) -> Self {
        Self::from_db(value)
    }
}

impl From<sqlx::Error> for RestError {
    fn from(value: sqlx::Error) -> Self {
        Self::from_db(DbError::Sqlx(value))
    }
}

impl From<serde_json::Error> for RestError {
    fn from(value: serde_json::Error) -> Self {
        Self::internal(value.to_string())
    }
}

async fn sync_batch<S>(
    State(state): State<MobileRestState<S>>,
    headers: HeaderMap,
    Json(body): Json<SyncBatchRequest>,
) -> Result<Json<SyncBatchResponse>, RestError>
where
    S: S3ObjectStore + Clone + Send + Sync + 'static,
{
    let principal = mobile_principal_from_headers(&state, &headers)?;
    let device_hash = device_hash_from_headers(&headers)?;
    let sync_id = normalize_non_empty(body.sync_id, "sync_id")?;
    if body.operations.is_empty() {
        return Err(RestError::from_kernel(KernelError::validation(
            "sync operations must not be empty",
        )));
    }

    let mut results = Vec::with_capacity(body.operations.len());
    for operation in body.operations {
        results.push(
            replay_sync_operation(&state, &principal, &device_hash, &sync_id, operation).await?,
        );
    }

    Ok(Json(SyncBatchResponse { sync_id, results }))
}

async fn replay_sync_operation<S>(
    state: &MobileRestState<S>,
    principal: &Principal,
    device_hash: &str,
    sync_id: &str,
    operation: SyncOperationRequest,
) -> Result<SyncOperationResult, RestError>
where
    S: S3ObjectStore + Clone + Send + Sync + 'static,
{
    let request_id = normalize_non_empty(operation.request_id.clone(), "request_id")?;
    match claim_sync_request(
        &state.pool,
        principal.user_id,
        device_hash,
        sync_id,
        &request_id,
        operation.operation,
        operation.created_at,
    )
    .await?
    {
        SyncClaim::Cached(mut cached) => {
            cached.replayed = true;
            Ok(cached)
        }
        SyncClaim::InProgress => Ok(SyncOperationResult {
            request_id,
            operation: operation.operation,
            status: SyncOperationStatus::Failed,
            http_status: StatusCode::CONFLICT.as_u16(),
            result: None,
            error: Some(SyncErrorPayload {
                code: "conflict".to_owned(),
                message: "sync operation is already in progress".to_owned(),
            }),
            replayed: true,
        }),
        SyncClaim::Claimed(sync_request_id) => {
            let outcome = execute_sync_operation(state, principal, operation).await;
            complete_sync_request(&state.pool, sync_request_id, principal.user_id, outcome).await
        }
    }
}

async fn execute_sync_operation<S>(
    state: &MobileRestState<S>,
    principal: &Principal,
    operation: SyncOperationRequest,
) -> PendingSyncOutcome
where
    S: S3ObjectStore + Clone + Send + Sync + 'static,
{
    let request_id = operation.request_id;
    match operation.operation {
        SyncOperationKind::WorkOrderStart => {
            let parsed = serde_json::from_value::<SyncWorkOrderStartPayload>(operation.payload)
                .map_err(|err| RestError::bad_request(format!("invalid start payload: {err}")));
            let payload = match parsed {
                Ok(payload) => payload,
                Err(error) => {
                    return PendingSyncOutcome::failure(
                        request_id,
                        operation.operation,
                        None,
                        error,
                    );
                }
            };
            let result = async {
                let work_order = state
                    .store
                    .work_order(payload.work_order_id)
                    .await
                    .map_err(RestError::from_store)?;
                authorize(
                    principal,
                    Action::new(Feature::WorkOrderStart),
                    work_order.branch_id,
                )
                .map_err(RestError::from_kernel)?;
                let summary = state
                    .store
                    .start_work(WorkOrderStartCommand {
                        actor: principal.user_id,
                        work_order_id: payload.work_order_id,
                        trace: TraceContext::generate(),
                        occurred_at: time::OffsetDateTime::now_utc(),
                    })
                    .await
                    .map_err(RestError::from_store)?;
                Ok(summary)
            }
            .await;
            match result {
                Ok(summary) => PendingSyncOutcome::success(
                    request_id,
                    operation.operation,
                    Some(summary.id),
                    Some(summary.branch_id),
                    serde_json::to_value(summary).map_err(RestError::from),
                ),
                Err(error) => PendingSyncOutcome::failure(
                    request_id,
                    operation.operation,
                    Some(payload.work_order_id),
                    error,
                ),
            }
        }
        SyncOperationKind::WorkOrderReport => {
            let parsed = serde_json::from_value::<SyncWorkOrderReportPayload>(operation.payload)
                .map_err(|err| RestError::bad_request(format!("invalid report payload: {err}")));
            let payload = match parsed {
                Ok(payload) => payload,
                Err(error) => {
                    return PendingSyncOutcome::failure(
                        request_id,
                        operation.operation,
                        None,
                        error,
                    );
                }
            };
            let work_order_id = payload.work_order_id;
            let result_type = payload.result_type;
            let diagnosis = payload.diagnosis;
            let action_taken = payload.action_taken;
            let result = async {
                let work_order = state
                    .store
                    .work_order(work_order_id)
                    .await
                    .map_err(RestError::from_store)?;
                authorize(
                    principal,
                    Action::new(Feature::WorkReportSubmit),
                    work_order.branch_id,
                )
                .map_err(RestError::from_kernel)?;
                let summary = state
                    .store
                    .submit_report(SubmitReportCommand {
                        actor: principal.user_id,
                        work_order_id,
                        result_type,
                        diagnosis,
                        action_taken,
                        trace: TraceContext::generate(),
                        occurred_at: time::OffsetDateTime::now_utc(),
                    })
                    .await
                    .map_err(RestError::from_store)?;
                Ok(summary)
            }
            .await;
            match result {
                Ok(summary) => PendingSyncOutcome::success(
                    request_id,
                    operation.operation,
                    Some(summary.id),
                    Some(summary.branch_id),
                    serde_json::to_value(summary).map_err(RestError::from),
                ),
                Err(error) => PendingSyncOutcome::failure(
                    request_id,
                    operation.operation,
                    Some(work_order_id),
                    error,
                ),
            }
        }
    }
}

enum SyncClaim {
    Claimed(uuid::Uuid),
    Cached(SyncOperationResult),
    InProgress,
}

struct PendingSyncOutcome {
    result: SyncOperationResult,
    work_order_id: Option<WorkOrderId>,
    branch_id: Option<BranchId>,
}

impl PendingSyncOutcome {
    fn success(
        request_id: String,
        operation: SyncOperationKind,
        work_order_id: Option<WorkOrderId>,
        branch_id: Option<BranchId>,
        value: Result<serde_json::Value, RestError>,
    ) -> Self {
        match value {
            Ok(result) => Self {
                result: SyncOperationResult {
                    request_id,
                    operation,
                    status: SyncOperationStatus::Applied,
                    http_status: StatusCode::OK.as_u16(),
                    result: Some(result),
                    error: None,
                    replayed: false,
                },
                work_order_id,
                branch_id,
            },
            Err(error) => Self::failure(request_id, operation, work_order_id, error),
        }
    }

    fn failure(
        request_id: String,
        operation: SyncOperationKind,
        work_order_id: Option<WorkOrderId>,
        error: RestError,
    ) -> Self {
        Self {
            branch_id: None,
            work_order_id,
            result: SyncOperationResult {
                request_id,
                operation,
                status: SyncOperationStatus::Failed,
                http_status: error.status.as_u16(),
                result: None,
                error: Some(SyncErrorPayload {
                    code: error.code().to_owned(),
                    message: error.message,
                }),
                replayed: false,
            },
        }
    }
}

async fn claim_sync_request(
    pool: &PgPool,
    actor: UserId,
    device_hash: &str,
    sync_id: &str,
    request_id: &str,
    operation: SyncOperationKind,
    client_created_at: time::OffsetDateTime,
) -> Result<SyncClaim, RestError> {
    let event: AuditEvent = AuditEvent::new(
        Some(actor),
        AuditAction::new("offline_sync.receive").map_err(RestError::from_kernel)?,
        "offline_sync_request",
        request_id,
        TraceContext::generate(),
        time::OffsetDateTime::now_utc(),
    )
    .with_snapshots(
        None,
        Some(serde_json::json!({
            "request_id": request_id,
            "sync_id": sync_id,
            "operation": operation.as_db_str(),
        })),
    );

    with_audit::<_, SyncClaim, RestError>(pool, event, |tx| {
        let device_hash = device_hash.to_owned();
        let sync_id = sync_id.to_owned();
        let request_id = request_id.to_owned();
        Box::pin(async move {
            let inserted: Option<uuid::Uuid> = sqlx::query_scalar(
                r#"
                INSERT INTO offline_sync_requests (
                    user_id, device_hash, request_id, sync_id, operation_type,
                    client_created_at, status
                )
                VALUES ($1, $2, $3, $4, $5, $6, 'IN_PROGRESS')
                ON CONFLICT (device_hash, request_id) DO NOTHING
                RETURNING id
                "#,
            )
            .bind(*actor.as_uuid())
            .bind(&device_hash)
            .bind(&request_id)
            .bind(&sync_id)
            .bind(operation.as_db_str())
            .bind(client_created_at)
            .fetch_optional(tx.as_mut())
            .await?;

            if let Some(id) = inserted {
                return Ok(SyncClaim::Claimed(id));
            }

            let row = sqlx::query(
                r#"
                SELECT response_body
                FROM offline_sync_requests
                WHERE device_hash = $1 AND request_id = $2
                "#,
            )
            .bind(&device_hash)
            .bind(&request_id)
            .fetch_one(tx.as_mut())
            .await?;
            let response: Option<serde_json::Value> = row.try_get("response_body")?;
            match response {
                Some(value) => Ok(SyncClaim::Cached(serde_json::from_value(value)?)),
                None => Ok(SyncClaim::InProgress),
            }
        })
    })
    .await
}

async fn complete_sync_request(
    pool: &PgPool,
    sync_request_id: uuid::Uuid,
    actor: UserId,
    outcome: PendingSyncOutcome,
) -> Result<SyncOperationResult, RestError> {
    let response_body = serde_json::to_value(&outcome.result)?;
    let event: AuditEvent = AuditEvent::new(
        Some(actor),
        AuditAction::new("offline_sync.complete").map_err(RestError::from_kernel)?,
        "offline_sync_request",
        sync_request_id.to_string(),
        TraceContext::generate(),
        time::OffsetDateTime::now_utc(),
    )
    .with_snapshots(None, Some(response_body.clone()));
    let result = outcome.result.clone();

    with_audit::<_, (), RestError>(pool, event, |tx| {
        Box::pin(async move {
            sqlx::query(
                r#"
                UPDATE offline_sync_requests
                SET status = $2,
                    http_status = $3,
                    response_body = $4,
                    branch_id = $5,
                    work_order_id = $6,
                    completed_at = now()
                WHERE id = $1
                "#,
            )
            .bind(sync_request_id)
            .bind(outcome.result.status.as_db_str())
            .bind(i32::from(outcome.result.http_status))
            .bind(response_body)
            .bind(outcome.branch_id.map(|id| *id.as_uuid()))
            .bind(
                outcome
                    .branch_id
                    .and_then(|_| outcome.work_order_id.map(|id| *id.as_uuid())),
            )
            .execute(tx.as_mut())
            .await?;
            Ok(())
        })
    })
    .await?;
    Ok(result)
}

async fn register_device<S>(
    State(state): State<MobileRestState<S>>,
    headers: HeaderMap,
    Json(body): Json<DeviceRegistrationRequest>,
) -> Result<Json<DeviceRegistrationResponse>, RestError>
where
    S: S3ObjectStore + Clone + Send + Sync + 'static,
{
    let principal = mobile_principal_from_headers(&state, &headers)?;
    let device_hash = device_hash_from_headers(&headers)?;
    let app_version = normalize_non_empty(body.app_version, "app_version")?;
    let now = time::OffsetDateTime::now_utc();
    let event: AuditEvent = AuditEvent::new(
        Some(principal.user_id),
        AuditAction::new("device.register").map_err(RestError::from_kernel)?,
        "registered_device",
        device_hash.clone(),
        TraceContext::generate(),
        now,
    )
    .with_branch(audit_branch_for_principal(&principal)?)
    .with_snapshots(
        None,
        Some(serde_json::json!({
            "platform": body.platform,
            "app_version": app_version,
            "push_token_present": body.push_token.as_ref().is_some_and(|token| !token.trim().is_empty()),
        })),
    );

    let response =
        with_audit::<_, DeviceRegistrationResponse, RestError>(&state.pool, event, |tx| {
            Box::pin(async move {
                let row = sqlx::query(
                    r#"
                    INSERT INTO registered_devices (
                        user_id, device_hash, platform, push_token, app_version,
                        last_registered_at, created_at, updated_at
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $6, $6)
                    ON CONFLICT (user_id, device_hash) DO UPDATE
                    SET platform = EXCLUDED.platform,
                        push_token = EXCLUDED.push_token,
                        app_version = EXCLUDED.app_version,
                        last_registered_at = EXCLUDED.last_registered_at,
                        updated_at = EXCLUDED.updated_at
                    RETURNING id, user_id, device_hash, platform, push_token,
                              app_version, last_registered_at
                    "#,
                )
                .bind(*principal.user_id.as_uuid())
                .bind(&device_hash)
                .bind(body.platform.as_db_str())
                .bind(body.push_token.as_deref().map(str::trim))
                .bind(&app_version)
                .bind(now)
                .fetch_one(tx.as_mut())
                .await?;
                device_registration_from_row(&row)
            })
        })
        .await?;

    Ok(Json(response))
}

async fn presign_evidence<S>(
    State(state): State<MobileRestState<S>>,
    headers: HeaderMap,
    Json(body): Json<EvidencePresignRequest>,
) -> Result<Json<EvidencePresignResponse>, RestError>
where
    S: S3ObjectStore + Clone + Send + Sync + 'static,
{
    let principal = mobile_principal_from_headers(&state, &headers)?;
    let work_order = state
        .store
        .work_order(body.work_order_id)
        .await
        .map_err(RestError::from_store)?;
    authorize_evidence_access(&state, &principal, body.work_order_id, work_order.branch_id).await?;
    let service = state.evidence_service.as_ref().ok_or_else(|| {
        RestError::unavailable("evidence storage is not configured for mobile API")
    })?;
    let ticket = service
        .issue_presigned_upload(EvidenceUploadCommand {
            actor: principal.user_id,
            work_order_id: body.work_order_id,
            stage: body.stage,
            content_type: body.content_type,
            size_bytes: body.size_bytes,
            checksum_sha256: body.checksum_sha256,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_storage)?;
    record_evidence_presign_audit(&state.pool, &principal, work_order.branch_id, &ticket).await?;

    Ok(Json(EvidencePresignResponse {
        id: ticket.media.id,
        work_order_id: ticket.media.work_order_id,
        stage: ticket.media.stage,
        upload: ticket.upload,
    }))
}

async fn confirm_evidence<S>(
    State(state): State<MobileRestState<S>>,
    headers: HeaderMap,
    Path(evidence_id): Path<uuid::Uuid>,
) -> Result<Json<EvidenceConfirmResponse>, RestError>
where
    S: S3ObjectStore + Clone + Send + Sync + 'static,
{
    let principal = mobile_principal_from_headers(&state, &headers)?;
    let media_id = EvidenceId::from_uuid(evidence_id);
    let service = state.evidence_service.as_ref().ok_or_else(|| {
        RestError::unavailable("evidence storage is not configured for mobile API")
    })?;
    let media = service
        .evidence_media(media_id)
        .await
        .map_err(RestError::from_storage)?;
    let work_order = state
        .store
        .work_order(media.work_order_id)
        .await
        .map_err(RestError::from_store)?;
    authorize_evidence_access(
        &state,
        &principal,
        media.work_order_id,
        work_order.branch_id,
    )
    .await?;
    let confirmed = service
        .confirm_upload(
            media_id,
            principal.user_id,
            TraceContext::generate(),
            time::OffsetDateTime::now_utc(),
        )
        .await
        .map_err(RestError::from_storage)?;
    let outcome = service
        .replicate_once(
            media_id,
            TraceContext::generate(),
            time::OffsetDateTime::now_utc(),
        )
        .await
        .map_err(RestError::from_storage)?;
    let media = service.evidence_media(media_id).await.unwrap_or(confirmed);

    Ok(Json(EvidenceConfirmResponse {
        id: media.id,
        work_order_id: media.work_order_id,
        stage: media.stage,
        worm_replica_status: outcome.status,
        retry_count: outcome.retry_count,
        verified_at: media.verified_at,
    }))
}

async fn authorize_evidence_access<S>(
    state: &MobileRestState<S>,
    principal: &Principal,
    work_order_id: WorkOrderId,
    branch_id: BranchId,
) -> Result<(), RestError>
where
    S: S3ObjectStore + Clone + Send + Sync + 'static,
{
    authorize(principal, Action::new(Feature::EvidenceAttach), branch_id)
        .map_err(RestError::from_kernel)?;
    if is_admin_like(principal)
        || is_assigned_to_work_order(&state.pool, work_order_id, principal.user_id).await?
    {
        Ok(())
    } else {
        Err(RestError::from_kernel(KernelError::forbidden(
            "evidence upload requires an assigned mechanic or admin role",
        )))
    }
}

async fn is_assigned_to_work_order(
    pool: &PgPool,
    work_order_id: WorkOrderId,
    user_id: UserId,
) -> Result<bool, RestError> {
    let count: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM work_order_assignments
        WHERE work_order_id = $1 AND mechanic_id = $2
        "#,
    )
    .bind(*work_order_id.as_uuid())
    .bind(*user_id.as_uuid())
    .fetch_one(pool)
    .await?;
    Ok(count > 0)
}

fn is_admin_like(principal: &Principal) -> bool {
    principal
        .roles
        .iter()
        .any(|role| matches!(role, Role::Admin | Role::SuperAdmin))
}

async fn record_evidence_presign_audit(
    pool: &PgPool,
    principal: &Principal,
    branch_id: BranchId,
    ticket: &EvidenceUploadTicket,
) -> Result<(), RestError> {
    let event: AuditEvent = AuditEvent::new(
        Some(principal.user_id),
        AuditAction::new("evidence.presign").map_err(RestError::from_kernel)?,
        "evidence_media",
        ticket.media.id.to_string(),
        TraceContext::generate(),
        time::OffsetDateTime::now_utc(),
    )
    .with_branch(branch_id)
    .with_snapshots(
        None,
        Some(serde_json::json!({
            "work_order_id": ticket.media.work_order_id,
            "stage": ticket.media.stage,
            "s3_key": ticket.media.s3_key,
        })),
    );
    with_audit::<_, (), RestError>(pool, event, |_tx| Box::pin(async move { Ok(()) })).await
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

fn mobile_principal_from_headers<S>(
    state: &MobileRestState<S>,
    headers: &HeaderMap,
) -> Result<Principal, RestError> {
    let verifier = state.jwt_verifier.as_ref().ok_or_else(|| {
        RestError::unavailable("JWT verification is not configured for mobile API")
    })?;
    let token = bearer_token(headers)?;
    let claims = verifier
        .verify_access_token(token)
        .map_err(|_| RestError::unauthorized("invalid bearer token"))?;
    principal_from_claims(claims)
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

fn device_hash_from_headers(headers: &HeaderMap) -> Result<String, RestError> {
    let raw = headers
        .get("x-device-id")
        .ok_or_else(|| RestError::bad_request("missing X-Device-Id header"))?
        .to_str()
        .map_err(|_| RestError::bad_request("invalid X-Device-Id header"))?;
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(RestError::bad_request(
            "X-Device-Id header must not be empty",
        ));
    }
    Ok(hex::encode(Sha256::digest(raw.as_bytes())))
}

fn normalize_non_empty(value: String, field: &'static str) -> Result<String, RestError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        Err(RestError::from_kernel(KernelError::validation(format!(
            "{field} must not be empty"
        ))))
    } else {
        Ok(trimmed.to_owned())
    }
}

fn audit_branch_for_principal(principal: &Principal) -> Result<BranchId, RestError> {
    match &principal.branch_scope {
        BranchScope::All => Ok(BranchId::new()),
        BranchScope::Branches(branches) => branches.iter().next().copied().ok_or_else(|| {
            RestError::from_kernel(KernelError::forbidden("principal has no branch scope"))
        }),
    }
}

fn device_registration_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<DeviceRegistrationResponse, RestError> {
    let platform: String = row.try_get("platform")?;
    Ok(DeviceRegistrationResponse {
        id: DeviceId::from_uuid(row.try_get("id")?),
        user_id: UserId::from_uuid(row.try_get("user_id")?),
        device_hash: row.try_get("device_hash")?,
        platform: DevicePlatform::from_db_str(&platform).map_err(RestError::from_kernel)?,
        push_token: row.try_get("push_token")?,
        app_version: row.try_get("app_version")?,
        last_registered_at: row.try_get("last_registered_at")?,
    })
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
