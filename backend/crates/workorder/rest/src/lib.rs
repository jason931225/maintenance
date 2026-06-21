//! Work-order REST API.
//!
//! This layer handles JWT authentication, branch-scoped authorization, and
//! HTTP error mapping. State changes are delegated to the Postgres adapter,
//! which writes through `with_audit`.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::collections::{BTreeMap, BTreeSet};
use std::str::FromStr;

use axum::extract::{Path, Query, RawQuery, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post, put};
use axum::{Json, Router};
use mnt_kernel_core::{
    AuditAction, AuditEvent, BranchId, BranchScope, DailyPlanId, DeviceId, ErrorKind, EvidenceId,
    KernelError, OrgId, TraceContext, UserId, WorkOrderId,
};
use mnt_platform_auth::{AccessClaims, JwtVerifier};
use mnt_platform_authz::{Action, BranchColumn, Feature, Principal, Role, authorize};
use mnt_platform_db::{DbError, with_audit, with_org_conn};
use mnt_platform_request_context::current_org;
use mnt_platform_storage::{
    EvidenceService, EvidenceUploadCommand, EvidenceUploadTicket, PresignedUpload, S3ObjectStore,
    StorageError, WormReplicaStatus,
};
use mnt_workorder_adapter_postgres::{PgWorkOrderError, PgWorkOrderStore};
use mnt_workorder_application::{
    AssignmentInput, CreateDailyPlanCommand, CreateOutsourceWorkCommand, CreateWorkOrderCommand,
    DailyPlanItemInput, DailyPlanStatus, RejectWorkOrderCommand, ReviewDailyPlanCommand,
    ReviewTargetChangeCommand, SendDailyPlanForReviewCommand, SubmitReportCommand,
    TargetChangeDecision, TargetChangeRequestCommand, UpdatePriorityCommand,
    WorkOrderApprovalCommand, WorkOrderAssignmentCommand, WorkOrderStartCommand,
};
use mnt_workorder_domain::{
    AssignmentRole, AttachmentStage, PriorityLevel, WorkOrderStatus, WorkResultType,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, QueryBuilder, Row};
use time::format_description::well_known::Rfc3339;

// ISO calendar-date (`YYYY-MM-DD`) serde for `time::Date` request fields. The
// default `time::Date` serde shape is a structured array, which mismatches the
// OpenAPI `Date` contract (`type: string, format: date`) and rejects the ISO
// strings the web/mobile clients send. This module aligns the wire format.
time::serde::format_description!(iso_date, Date, "[year]-[month]-[day]");

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

/// Maximum number of operations accepted in a single `/sync` batch. A larger
/// batch is rejected (422) before any allocation or replay so a single
/// principal cannot monopolize a pooled DB connection with a long sequential
/// replay.
pub const MAX_SYNC_BATCH_OPERATIONS: usize = 200;

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
    let verifier = state.jwt_verifier.clone();
    let pool = state.store.pool().clone();
    let router = Router::new()
        .route("/api/v1/work-orders", get(list_work_orders))
        .route(
            "/api/v1/work-orders/{work_order_id}",
            get(get_work_order_detail),
        )
        .route(
            "/api/v1/work-orders/{work_order_id}/reject",
            post(reject_work_order),
        )
        .route("/api/v1/equipment/lookup", get(lookup_equipment))
        .route("/api/v1/equipment", get(autocomplete_equipment))
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
        .route("/api/daily-work-plans/{plan_id}", get(get_daily_plan))
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
        .with_state(state);
    mnt_platform_request_context::with_request_context(router, verifier, pool)
}

pub fn mobile_router<S>(state: MobileRestState<S>) -> Router
where
    S: S3ObjectStore + Clone + Send + Sync + 'static,
{
    let verifier = state.jwt_verifier.clone();
    let pool = state.pool.clone();
    let router = Router::new()
        .route(SYNC_PATH, post(sync_batch::<S>))
        .route(DEVICES_PATH, post(register_device::<S>))
        .route(EVIDENCE_PRESIGN_PATH, post(presign_evidence::<S>))
        .route(
            "/api/v1/evidence/{evidence_id}/confirm",
            post(confirm_evidence::<S>),
        )
        .with_state(state);
    mnt_platform_request_context::with_request_context(router, verifier, pool)
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
    // The OpenAPI contract types this as an rfc3339 `string`; a bare OffsetDateTime
    // serde impl expects the array form and rejects the ISO instant the web client
    // sends (422). Deserialize it from the rfc3339 string instead.
    #[serde(with = "time::serde::rfc3339")]
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
    #[serde(with = "iso_date")]
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

#[derive(Debug, Default)]
struct WorkOrderListQuery {
    status: Vec<String>,
    priority: Vec<String>,
    assigned_to: Option<String>,
    customer_id: Option<uuid::Uuid>,
    site_id: Option<uuid::Uuid>,
    target_due_from: Option<time::OffsetDateTime>,
    target_due_to: Option<time::OffsetDateTime>,
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Debug)]
struct NormalizedWorkOrderListQuery {
    statuses: Vec<String>,
    priorities: Vec<String>,
    assigned_to: Option<UserId>,
    customer_id: Option<uuid::Uuid>,
    site_id: Option<uuid::Uuid>,
    target_due_from: Option<time::OffsetDateTime>,
    target_due_to: Option<time::OffsetDateTime>,
    limit: i64,
    offset: i64,
}

#[derive(Debug, Deserialize)]
struct EquipmentLookupQuery {
    management_no: String,
}

#[derive(Debug, Deserialize)]
struct EquipmentAutocompleteQuery {
    q: String,
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct RejectWorkOrderRequest {
    memo: String,
}

#[derive(Debug, Serialize)]
struct WorkOrderListPage {
    items: Vec<WorkOrderListItem>,
    limit: i64,
    offset: i64,
    total: i64,
}

#[derive(Debug, Serialize)]
struct WorkOrderListItem {
    id: WorkOrderId,
    request_no: String,
    branch_id: BranchId,
    status: String,
    priority: String,
    result_type: String,
    target_due_at: Option<time::OffsetDateTime>,
    created_at: time::OffsetDateTime,
    updated_at: time::OffsetDateTime,
    equipment: EquipmentSummary,
    customer: NamedEntity,
    site: NamedEntity,
    // Site's registered representative contact (#13), so the dispatch board can
    // show who to call on site. None when the site has no contact registered.
    site_contact: Option<SiteContact>,
    assignments: Vec<AssignmentSummary>,
}

#[derive(Debug, Serialize)]
struct WorkOrderDetail {
    id: WorkOrderId,
    request_no: String,
    branch_id: BranchId,
    status: String,
    priority: String,
    result_type: String,
    symptom: String,
    customer_request: Option<String>,
    target_due_at: Option<time::OffsetDateTime>,
    delay_reason: Option<String>,
    delay_note: Option<String>,
    diagnosis: Option<String>,
    action_taken: Option<String>,
    report_submitted_by: Option<UserId>,
    report_submitted_at: Option<time::OffsetDateTime>,
    kpi_excluded: bool,
    evidence_verified: bool,
    created_at: time::OffsetDateTime,
    updated_at: time::OffsetDateTime,
    equipment: EquipmentSummary,
    customer: NamedEntity,
    site: NamedEntity,
    // The site's registered representative contact (대표 담당자 연락처, #13), so the
    // dispatched mechanic/admin can see who to call on site. None when the site
    // has no contact registered.
    site_contact: Option<SiteContact>,
    assignments: Vec<AssignmentSummary>,
    approval_line: Vec<ApprovalStepSummary>,
    status_history: Vec<StatusHistorySummary>,
    evidence: Vec<EvidenceSummary>,
}

#[derive(Debug, Clone, Serialize)]
struct EquipmentSummary {
    id: uuid::Uuid,
    equipment_no: String,
    management_no: Option<String>,
    model: Option<String>,
    status: String,
    specification: String,
    ton_text: String,
}

#[derive(Debug, Clone, Serialize)]
struct NamedEntity {
    id: uuid::Uuid,
    name: String,
}

#[derive(Debug, Clone, Serialize)]
struct SiteContact {
    name: Option<String>,
    phone: Option<String>,
    email: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct AssignmentSummary {
    id: uuid::Uuid,
    mechanic_id: UserId,
    mechanic_name: String,
    role: String,
    assigned_at: time::OffsetDateTime,
}

#[derive(Debug, Serialize)]
struct ApprovalStepSummary {
    id: uuid::Uuid,
    step_order: i16,
    role: String,
    approver_id: Option<UserId>,
    status: String,
    requested_at: Option<time::OffsetDateTime>,
    approved_at: Option<time::OffsetDateTime>,
    approved_by_id: Option<UserId>,
}

#[derive(Debug, Serialize)]
struct StatusHistorySummary {
    id: uuid::Uuid,
    actor: Option<UserId>,
    action: String,
    from_status: Option<String>,
    to_status: String,
    occurred_at: time::OffsetDateTime,
}

#[derive(Debug, Serialize)]
struct EvidenceSummary {
    id: EvidenceId,
    stage: String,
    content_type: String,
    size_bytes: i64,
    uploaded_by: UserId,
    worm_replica_status: String,
    retry_count: i32,
    verified_at: Option<time::OffsetDateTime>,
    created_at: time::OffsetDateTime,
}

#[derive(Debug, Serialize)]
struct EquipmentAutocompletePage {
    items: Vec<EquipmentLookupResponse>,
    limit: i64,
}

#[derive(Debug, Serialize)]
struct EquipmentLookupResponse {
    id: uuid::Uuid,
    branch_id: BranchId,
    equipment_no: String,
    management_no: Option<String>,
    model: Option<String>,
    status: String,
    specification: String,
    ton_text: String,
    maker: Option<String>,
    vin: Option<String>,
    vehicle_registration_no: Option<String>,
    customer: NamedEntity,
    site: NamedEntity,
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
        match error {
            PgWorkOrderError::Domain(error) => Self::from_kernel(error),
            PgWorkOrderError::Db(error) => Self::from_db(error),
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
                // Log the constraint name server-side; never leak it (schema
                // disclosure, OWASP A05). Clients get a stable generic message.
                tracing::error!(error = %err, "database unique-constraint violation");
                Self::from_kernel(KernelError::conflict("resource already exists"))
            }
            DbError::Sqlx(err) => {
                tracing::error!(error = %err, "database error");
                Self::internal("internal server error")
            }
            DbError::Serialize(err) => {
                tracing::error!(error = %err, "serialization error");
                Self::internal("internal server error")
            }
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
    // Cap the batch before allocating / replaying: one authenticated principal
    // must not be able to monopolize a pooled DB connection with an oversized
    // sequential replay.
    if body.operations.len() > MAX_SYNC_BATCH_OPERATIONS {
        return Err(RestError::from_kernel(KernelError::validation(format!(
            "sync batch exceeds the maximum of {MAX_SYNC_BATCH_OPERATIONS} operations"
        ))));
    }

    // FIX 1: a request_id must be unique within a single batch — a client that
    // reuses one for two distinct operations would otherwise have one silently
    // dropped by the idempotency cache.
    let mut seen_request_ids = BTreeSet::new();
    let mut results = Vec::with_capacity(body.operations.len());
    for operation in body.operations {
        let request_id = normalize_non_empty(operation.request_id.clone(), "request_id")?;
        if !seen_request_ids.insert(request_id.clone()) {
            results.push(SyncOperationResult {
                request_id,
                operation: operation.operation,
                status: SyncOperationStatus::Failed,
                http_status: StatusCode::CONFLICT.as_u16(),
                result: None,
                error: Some(SyncErrorPayload {
                    code: "conflict".to_owned(),
                    message: "duplicate request_id within sync batch".to_owned(),
                }),
                replayed: false,
            });
            continue;
        }
        results.push(
            replay_sync_operation(
                &state,
                &principal,
                &device_hash,
                &sync_id,
                request_id,
                operation,
            )
            .await?,
        );
    }

    Ok(Json(SyncBatchResponse { sync_id, results }))
}

/// FIX 1: build the canonical, order-stable sha256 hash that binds an
/// idempotency record to its operation content. `serde_json` sorts object keys
/// (no `preserve_order` feature), so re-serializing the envelope is canonical.
fn sync_payload_hash(
    user_id: UserId,
    sync_id: &str,
    operation: SyncOperationKind,
    client_created_at: time::OffsetDateTime,
    payload: &serde_json::Value,
) -> Result<(String, serde_json::Value), RestError> {
    let created_at = client_created_at
        .format(&Rfc3339)
        .map_err(|err| RestError::internal(format!("invalid client_created_at: {err}")))?;
    let envelope = serde_json::json!({
        "user_id": user_id.to_string(),
        "sync_id": sync_id,
        "operation_type": operation.as_db_str(),
        "client_created_at": created_at,
        "payload": payload,
    });
    let canonical = serde_json::to_vec(&envelope)?;
    let hash = hex::encode(Sha256::digest(&canonical));
    Ok((hash, envelope))
}

async fn replay_sync_operation<S>(
    state: &MobileRestState<S>,
    principal: &Principal,
    device_hash: &str,
    sync_id: &str,
    request_id: String,
    operation: SyncOperationRequest,
) -> Result<SyncOperationResult, RestError>
where
    S: S3ObjectStore + Clone + Send + Sync + 'static,
{
    let (payload_hash, payload_envelope) = sync_payload_hash(
        principal.user_id,
        sync_id,
        operation.operation,
        operation.created_at,
        &operation.payload,
    )?;
    match claim_sync_request(
        &state.pool,
        principal.user_id,
        device_hash,
        sync_id,
        &request_id,
        operation.operation,
        operation.created_at,
        &payload_hash,
        &payload_envelope,
    )
    .await?
    {
        SyncClaim::Cached(mut cached) => {
            cached.replayed = true;
            Ok(cached)
        }
        SyncClaim::PayloadMismatch => Ok(SyncOperationResult {
            request_id,
            operation: operation.operation,
            status: SyncOperationStatus::Failed,
            http_status: StatusCode::CONFLICT.as_u16(),
            result: None,
            error: Some(SyncErrorPayload {
                code: "conflict".to_owned(),
                message: "request_id reused with different operation content".to_owned(),
            }),
            replayed: true,
        }),
        SyncClaim::Claimed(sync_request_id) => {
            let outcome = execute_sync_operation(state, principal, operation).await;
            complete_sync_request(&state.pool, sync_request_id, principal.user_id, outcome).await
        }
        // FIX 2: a previously-claimed-but-never-completed row (worker crash
        // between the mutation commit and the completion mark). Re-run the
        // operation; `execute_sync_operation` is idempotent — if the mutation
        // already applied it re-derives the response from the current
        // work-order state instead of double-mutating — then finalize the row.
        SyncClaim::Stale(sync_request_id) => {
            let outcome = execute_sync_operation(state, principal, operation).await;
            let mut result =
                complete_sync_request(&state.pool, sync_request_id, principal.user_id, outcome)
                    .await?;
            result.replayed = true;
            Ok(result)
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
                let summary = match state
                    .store
                    .start_work(WorkOrderStartCommand {
                        actor: principal.user_id,
                        work_order_id: payload.work_order_id,
                        trace: TraceContext::generate(),
                        occurred_at: time::OffsetDateTime::now_utc(),
                    })
                    .await
                {
                    Ok(summary) => summary,
                    // FIX 2 reconciliation: if the start already applied (a crash
                    // re-runs this), the transition guard rejects the re-run; the
                    // current state IS the result, so re-derive it idempotently.
                    Err(err) => {
                        let current = state
                            .store
                            .work_order(payload.work_order_id)
                            .await
                            .map_err(RestError::from_store)?;
                        if current.status == WorkOrderStatus::InProgress {
                            current
                        } else {
                            return Err(RestError::from_store(err));
                        }
                    }
                };
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
                let summary = match state
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
                {
                    Ok(summary) => summary,
                    // FIX 2 reconciliation: if the report already applied (a
                    // crash re-runs this), re-derive the current state instead of
                    // double-mutating.
                    Err(err) => {
                        let current = state
                            .store
                            .work_order(work_order_id)
                            .await
                            .map_err(RestError::from_store)?;
                        if current.status == WorkOrderStatus::ReportSubmitted {
                            current
                        } else {
                            return Err(RestError::from_store(err));
                        }
                    }
                };
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
    /// Fresh claim — run the operation, then complete the row.
    Claimed(uuid::Uuid),
    /// Already completed with a matching payload — return the cached response.
    Cached(SyncOperationResult),
    /// Claimed but never completed (worker crash). Reconcile against the target
    /// work-order state and finalize the row (FIX 2).
    Stale(uuid::Uuid),
    /// Same (device_hash, request_id) replayed with a DIFFERENT payload (FIX 1).
    PayloadMismatch,
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

#[allow(clippy::too_many_arguments)]
async fn claim_sync_request(
    pool: &PgPool,
    actor: UserId,
    device_hash: &str,
    sync_id: &str,
    request_id: &str,
    operation: SyncOperationKind,
    client_created_at: time::OffsetDateTime,
    payload_hash: &str,
    payload_envelope: &serde_json::Value,
) -> Result<SyncClaim, RestError> {
    let org = current_org().map_err(|err| RestError::from_kernel(err.into()))?;
    let org_uuid = *org.as_uuid();
    let event: AuditEvent = AuditEvent::new(
        Some(actor),
        AuditAction::new("offline_sync.receive").map_err(RestError::from_kernel)?,
        "offline_sync_request",
        request_id,
        TraceContext::generate(),
        time::OffsetDateTime::now_utc(),
    )
    .with_org(org)
    .with_snapshots(
        None,
        Some(serde_json::json!({
            "request_id": request_id,
            "sync_id": sync_id,
            "operation": operation.as_db_str(),
            "payload_hash": payload_hash,
        })),
    );

    with_audit::<_, SyncClaim, RestError>(pool, event, |tx| {
        let device_hash = device_hash.to_owned();
        let sync_id = sync_id.to_owned();
        let request_id = request_id.to_owned();
        let payload_hash = payload_hash.to_owned();
        let payload_envelope = payload_envelope.clone();
        Box::pin(async move {
            // Lock the existing row (if any) so a concurrent claim of the same
            // (device_hash, request_id) is serialized.
            let existing = sqlx::query(
                r#"
                SELECT id, status, payload_hash, response_body
                FROM offline_sync_requests
                WHERE device_hash = $1 AND request_id = $2
                FOR UPDATE
                "#,
            )
            .bind(&device_hash)
            .bind(&request_id)
            .fetch_optional(tx.as_mut())
            .await?;

            if let Some(row) = existing {
                let existing_hash: Option<String> = row.try_get("payload_hash")?;
                // FIX 1: same idempotency key, different content → reject.
                if existing_hash.as_deref() != Some(payload_hash.as_str()) {
                    return Ok(SyncClaim::PayloadMismatch);
                }
                let status: String = row.try_get("status")?;
                let response: Option<serde_json::Value> = row.try_get("response_body")?;
                let id: uuid::Uuid = row.try_get("id")?;
                return match (status.as_str(), response) {
                    // Completed with a matching payload → cached idempotent reply.
                    (_, Some(value)) => Ok(SyncClaim::Cached(serde_json::from_value(value)?)),
                    // Claimed but never completed → reconcile (FIX 2).
                    ("IN_PROGRESS", None) => Ok(SyncClaim::Stale(id)),
                    // APPLIED/FAILED with no body should not happen; treat as
                    // reconcilable rather than returning an empty response.
                    (_, None) => Ok(SyncClaim::Stale(id)),
                };
            }

            let id: uuid::Uuid = sqlx::query_scalar(
                r#"
                INSERT INTO offline_sync_requests (
                    user_id, device_hash, request_id, sync_id, operation_type,
                    client_created_at, status, payload_hash, request_payload, org_id
                )
                VALUES ($1, $2, $3, $4, $5, $6, 'IN_PROGRESS', $7, $8, $9)
                RETURNING id
                "#,
            )
            .bind(*actor.as_uuid())
            .bind(&device_hash)
            .bind(&request_id)
            .bind(&sync_id)
            .bind(operation.as_db_str())
            .bind(client_created_at)
            .bind(&payload_hash)
            .bind(&payload_envelope)
            .bind(org_uuid)
            .fetch_one(tx.as_mut())
            .await?;
            Ok(SyncClaim::Claimed(id))
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
    let org_uuid = *principal.org_id.as_uuid();
    let event: AuditEvent = AuditEvent::new(
        Some(principal.user_id),
        AuditAction::new("device.register").map_err(RestError::from_kernel)?,
        "registered_device",
        device_hash.clone(),
        TraceContext::generate(),
        now,
    )
    .with_org(principal.org_id)
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
                        last_registered_at, created_at, updated_at, org_id
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $6, $6, $7)
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
                .bind(org_uuid)
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
    // FIX 3: reject AFTER/REPORT completion evidence for terminal work orders at
    // the REST boundary, before issuing a presigned upload URL. The storage
    // adapter re-checks under a row lock and the DB trigger is the final barrier.
    if matches!(body.stage, AttachmentStage::After | AttachmentStage::Report)
        && is_terminal_work_order_status(work_order.status)
    {
        return Err(RestError::from_kernel(KernelError::conflict(format!(
            "cannot attach {} evidence to a work order in terminal status {}",
            body.stage.as_db_str(),
            work_order.status.as_db_str()
        ))));
    }
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
    let org = current_org()
        .map_err(KernelError::from)
        .map_err(RestError::from_kernel)?;
    let work_order_uuid = *work_order_id.as_uuid();
    let user_uuid = *user_id.as_uuid();
    let count: i64 = with_org_conn::<_, _, RestError>(pool, org, move |tx| {
        Box::pin(async move {
            Ok(sqlx::query_scalar(
                r#"
        SELECT COUNT(*)
        FROM work_order_assignments
        WHERE work_order_id = $1 AND mechanic_id = $2
        "#,
            )
            .bind(work_order_uuid)
            .bind(user_uuid)
            .fetch_one(tx.as_mut())
            .await?)
        })
    })
    .await?;
    Ok(count > 0)
}

fn is_admin_like(principal: &Principal) -> bool {
    principal
        .roles
        .iter()
        .any(|role| matches!(role, Role::Admin | Role::SuperAdmin))
}

/// Work orders in these statuses are closed: their completion evidence set is
/// frozen and must not accept further AFTER/REPORT attachments (FIX 3).
fn is_terminal_work_order_status(status: WorkOrderStatus) -> bool {
    matches!(
        status,
        WorkOrderStatus::FinalCompleted | WorkOrderStatus::Archived | WorkOrderStatus::Cancelled
    )
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

async fn list_work_orders(
    State(state): State<WorkOrderRestState>,
    headers: HeaderMap,
    RawQuery(raw_query): RawQuery,
) -> Result<Json<WorkOrderListPage>, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    authorize_read_access(&principal)?;
    let query = parse_work_order_list_query(raw_query.as_deref(), principal.user_id)?;
    let pool = state.store.pool();

    let org = current_org()
        .map_err(KernelError::from)
        .map_err(RestError::from_kernel)?;

    let total = {
        let mut builder =
            QueryBuilder::<Postgres>::new("SELECT COUNT(*) FROM work_orders w WHERE ");
        push_work_order_filters(&mut builder, &principal.branch_scope, &query)?;
        with_org_conn::<_, _, RestError>(pool, org, move |tx| {
            Box::pin(async move {
                Ok(builder
                    .build_query_scalar::<i64>()
                    .fetch_one(tx.as_mut())
                    .await?)
            })
        })
        .await?
    };

    let mut list_builder = QueryBuilder::<Postgres>::new(
        r#"
        SELECT
            w.id, w.request_no, w.branch_id, w.status, w.priority, w.result_type,
            w.target_due_at, w.created_at, w.updated_at,
            e.id AS equipment_id, e.equipment_no, e.management_no, e.model,
            e.status AS equipment_status, e.specification, e.ton_text,
            c.id AS customer_id, c.name AS customer_name,
            s.id AS site_id, s.name AS site_name,
            s.contact_name AS site_contact_name,
            s.contact_phone AS site_contact_phone,
            s.contact_email AS site_contact_email
        FROM work_orders w
        JOIN registry_equipment e ON e.id = w.equipment_id
        JOIN registry_customers c ON c.id = w.customer_id
        JOIN registry_sites s ON s.id = w.site_id
        WHERE
        "#,
    );
    push_work_order_filters(&mut list_builder, &principal.branch_scope, &query)?;
    list_builder.push(
        r#"
        ORDER BY
            CASE w.priority
                WHEN 'P1' THEN 1
                WHEN 'P2' THEN 2
                WHEN 'P3' THEN 3
                WHEN 'OUTSOURCE' THEN 4
                ELSE 5
            END,
            w.target_due_at ASC NULLS LAST,
            w.created_at ASC,
            w.id ASC
        LIMIT
        "#,
    );
    list_builder.push_bind(query.limit);
    list_builder.push(" OFFSET ");
    list_builder.push_bind(query.offset);
    let rows = with_org_conn::<_, _, RestError>(pool, org, move |tx| {
        Box::pin(async move { Ok(list_builder.build().fetch_all(tx.as_mut()).await?) })
    })
    .await?;
    let work_order_ids = rows
        .iter()
        .map(|row| row.try_get("id"))
        .collect::<Result<Vec<uuid::Uuid>, _>>()?;
    let assignments = fetch_assignment_map(pool, &work_order_ids).await?;
    let items = rows
        .iter()
        .map(|row| work_order_list_item_from_row(row, &assignments))
        .collect::<Result<Vec<_>, _>>()?;

    Ok(Json(WorkOrderListPage {
        items,
        limit: query.limit,
        offset: query.offset,
        total,
    }))
}

async fn get_work_order_detail(
    State(state): State<WorkOrderRestState>,
    headers: HeaderMap,
    Path(work_order_id): Path<uuid::Uuid>,
) -> Result<Json<WorkOrderDetail>, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    authorize_read_access(&principal)?;
    let pool = state.store.pool();
    let org = current_org()
        .map_err(KernelError::from)
        .map_err(RestError::from_kernel)?;
    let mut builder = QueryBuilder::<Postgres>::new(
        r#"
        SELECT
            w.id, w.request_no, w.branch_id, w.status, w.priority, w.result_type,
            w.symptom, w.customer_request, w.target_due_at, w.delay_reason, w.delay_note,
            w.diagnosis, w.action_taken, w.report_submitted_by, w.report_submitted_at,
            w.kpi_excluded, w.created_at, w.updated_at,
            EXISTS (
                SELECT 1
                FROM evidence_media verified
                WHERE verified.work_order_id = w.id
                  AND verified.stage IN ('AFTER', 'REPORT')
                  AND verified.worm_replica_status = 'VERIFIED'
            ) AND NOT EXISTS (
                SELECT 1
                FROM evidence_media unverified
                WHERE unverified.work_order_id = w.id
                  AND unverified.stage IN ('AFTER', 'REPORT')
                  AND unverified.worm_replica_status <> 'VERIFIED'
            ) AS evidence_verified,
            e.id AS equipment_id, e.equipment_no, e.management_no, e.model,
            e.status AS equipment_status, e.specification, e.ton_text,
            c.id AS customer_id, c.name AS customer_name,
            s.id AS site_id, s.name AS site_name,
            s.contact_name AS site_contact_name,
            s.contact_phone AS site_contact_phone,
            s.contact_email AS site_contact_email
        FROM work_orders w
        JOIN registry_equipment e ON e.id = w.equipment_id
        JOIN registry_customers c ON c.id = w.customer_id
        JOIN registry_sites s ON s.id = w.site_id
        WHERE w.id =
        "#,
    );
    builder.push_bind(work_order_id);
    builder.push(" AND ");
    push_branch_scope_filter(
        &mut builder,
        &principal.branch_scope,
        BranchColumn::new("w.branch_id").map_err(RestError::from_kernel)?,
    );
    let row = with_org_conn::<_, _, RestError>(pool, org, move |tx| {
        Box::pin(async move { Ok(builder.build().fetch_optional(tx.as_mut()).await?) })
    })
    .await?
    .ok_or_else(|| RestError::from_kernel(KernelError::not_found("work order was not found")))?;
    let work_order_id = WorkOrderId::from_uuid(work_order_id);
    let assignments = fetch_assignment_map(pool, &[*work_order_id.as_uuid()])
        .await?
        .remove(work_order_id.as_uuid())
        .unwrap_or_default();
    let approval_line = fetch_approval_line(pool, work_order_id).await?;
    let status_history = fetch_status_history(pool, work_order_id).await?;
    let evidence = fetch_evidence_summaries(pool, work_order_id).await?;

    Ok(Json(work_order_detail_from_row(
        &row,
        assignments,
        approval_line,
        status_history,
        evidence,
    )?))
}

async fn lookup_equipment(
    State(state): State<WorkOrderRestState>,
    headers: HeaderMap,
    Query(query): Query<EquipmentLookupQuery>,
) -> Result<Json<EquipmentLookupResponse>, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    authorize_read_access(&principal)?;
    let management_no = normalize_management_no(&query.management_no)?;
    let mut builder = QueryBuilder::<Postgres>::new(
        r#"
        SELECT
            e.id, e.branch_id, e.equipment_no, e.management_no, e.model, e.status,
            e.specification, e.ton_text, e.maker, e.vin, e.vehicle_registration_no,
            c.id AS customer_id, c.name AS customer_name,
            s.id AS site_id, s.name AS site_name
        FROM registry_equipment e
        JOIN registry_customers c ON c.id = e.customer_id
        JOIN registry_sites s ON s.id = e.site_id
        WHERE
"#,
    );
    push_branch_scope_filter(
        &mut builder,
        &principal.branch_scope,
        BranchColumn::new("e.branch_id").map_err(RestError::from_kernel)?,
    );
    builder.push(" AND e.management_no = ");
    builder.push_bind(management_no);
    builder.push(" ORDER BY e.updated_at DESC LIMIT 1");
    let row = builder
        .build()
        .fetch_optional(state.store.pool())
        .await?
        .ok_or_else(|| RestError::from_kernel(KernelError::not_found("equipment was not found")))?;
    Ok(Json(equipment_lookup_from_row(&row)?))
}

async fn autocomplete_equipment(
    State(state): State<WorkOrderRestState>,
    headers: HeaderMap,
    Query(query): Query<EquipmentAutocompleteQuery>,
) -> Result<Json<EquipmentAutocompletePage>, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    authorize_read_access(&principal)?;
    let raw_query = normalize_management_no(&query.q)?;
    let limit = normalize_limit(query.limit, 10, 20)?;
    let prefix = format!("{raw_query}%");
    let mut builder = QueryBuilder::<Postgres>::new(
        r#"
        SELECT
            e.id, e.branch_id, e.equipment_no, e.management_no, e.model, e.status,
            e.specification, e.ton_text, e.maker, e.vin, e.vehicle_registration_no,
            c.id AS customer_id, c.name AS customer_name,
            s.id AS site_id, s.name AS site_name
        FROM registry_equipment e
        JOIN registry_customers c ON c.id = e.customer_id
        JOIN registry_sites s ON s.id = e.site_id
        WHERE
"#,
    );
    push_branch_scope_filter(
        &mut builder,
        &principal.branch_scope,
        BranchColumn::new("e.branch_id").map_err(RestError::from_kernel)?,
    );
    builder.push(" AND (e.management_no ILIKE ");
    builder.push_bind(prefix.clone());
    builder.push(" OR e.equipment_no ILIKE ");
    builder.push_bind(prefix.clone());
    builder.push(" OR e.model ILIKE ");
    builder.push_bind(prefix);
    builder.push(") ORDER BY e.management_no ASC NULLS LAST, e.updated_at DESC LIMIT ");
    builder.push_bind(limit);
    let rows = builder.build().fetch_all(state.store.pool()).await?;
    let items = rows
        .iter()
        .map(equipment_lookup_from_row)
        .collect::<Result<Vec<_>, _>>()?;

    Ok(Json(EquipmentAutocompletePage { items, limit }))
}

async fn reject_work_order(
    State(state): State<WorkOrderRestState>,
    headers: HeaderMap,
    Path(work_order_id): Path<uuid::Uuid>,
    Json(body): Json<RejectWorkOrderRequest>,
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
        .reject_work_order(RejectWorkOrderCommand {
            actor: principal.user_id,
            work_order_id,
            memo: body.memo,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(summary))
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

async fn get_daily_plan(
    State(state): State<WorkOrderRestState>,
    headers: HeaderMap,
    Path(plan_id): Path<uuid::Uuid>,
) -> Result<impl IntoResponse, RestError> {
    let plan_id = DailyPlanId::from_uuid(plan_id);
    let principal = principal_from_headers(&state, &headers)?;
    let plan = state
        .store
        .daily_plan(plan_id)
        .await
        .map_err(RestError::from_store)?;
    // Both the creating mechanic and the reviewing admin hold DailyPlanRequest
    // (Mechanic/Admin = Allow), so it scopes the read to the plan's branch
    // without granting it to roles that have no business in the plan flow.
    authorize(
        &principal,
        Action::new(Feature::DailyPlanRequest),
        plan.branch_id,
    )
    .map_err(RestError::from_kernel)?;
    Ok(Json(plan))
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

fn authorize_read_access(principal: &Principal) -> Result<(), RestError> {
    let resource_branch = match &principal.branch_scope {
        BranchScope::All => BranchId::new(),
        BranchScope::Branches(branches) => branches.iter().next().copied().ok_or_else(|| {
            RestError::from_kernel(KernelError::forbidden("principal has no branch scope"))
        })?,
    };
    authorize(
        principal,
        Action::new(Feature::WorkOrderReadAll),
        resource_branch,
    )
    .map_err(RestError::from_kernel)
}

fn parse_work_order_list_query(
    raw_query: Option<&str>,
    actor: UserId,
) -> Result<NormalizedWorkOrderListQuery, RestError> {
    let mut query = WorkOrderListQuery::default();
    if let Some(raw_query) = raw_query {
        for pair in raw_query.split('&').filter(|pair| !pair.is_empty()) {
            let (raw_key, raw_value) = pair.split_once('=').unwrap_or((pair, ""));
            let key = decode_query_component(raw_key)?;
            let value = decode_query_component(raw_value)?;
            match key.as_str() {
                "status" | "status[]" => query.status.push(value),
                "priority" | "priority[]" => query.priority.push(value),
                "assigned_to" => query.assigned_to = non_empty_query_value(value),
                "customer_id" => query.customer_id = parse_uuid_query_value("customer_id", value)?,
                "site_id" => query.site_id = parse_uuid_query_value("site_id", value)?,
                "target_due_from" => {
                    query.target_due_from = parse_datetime_query_value("target_due_from", value)?;
                }
                "target_due_to" => {
                    query.target_due_to = parse_datetime_query_value("target_due_to", value)?;
                }
                "limit" => query.limit = parse_i64_query_value("limit", value)?,
                "offset" => query.offset = parse_i64_query_value("offset", value)?,
                _ => {}
            }
        }
    }
    Ok(NormalizedWorkOrderListQuery {
        statuses: normalize_status_filters(query.status)?,
        priorities: normalize_priority_filters(query.priority)?,
        assigned_to: normalize_assigned_to(query.assigned_to, actor)?,
        customer_id: query.customer_id,
        site_id: query.site_id,
        target_due_from: query.target_due_from,
        target_due_to: query.target_due_to,
        limit: normalize_limit(query.limit, 50, 100)?,
        offset: normalize_offset(query.offset)?,
    })
}

fn normalize_status_filters(raw: Vec<String>) -> Result<Vec<String>, RestError> {
    let mut statuses = Vec::new();
    for value in expand_query_values(raw) {
        let normalized = value.to_ascii_uppercase();
        let status = WorkOrderStatus::from_db_str(&normalized).map_err(RestError::from_kernel)?;
        statuses.push(status.as_db_str().to_owned());
    }
    Ok(statuses)
}

fn normalize_priority_filters(raw: Vec<String>) -> Result<Vec<String>, RestError> {
    let mut priorities = Vec::new();
    for value in expand_query_values(raw) {
        let normalized = value.to_ascii_uppercase();
        let priority = PriorityLevel::from_db_str(&normalized).map_err(RestError::from_kernel)?;
        priorities.push(priority.as_db_str().to_owned());
    }
    Ok(priorities)
}

fn expand_query_values(raw: Vec<String>) -> Vec<String> {
    raw.into_iter()
        .flat_map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|part| !part.is_empty())
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .collect()
}

fn non_empty_query_value(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

fn parse_uuid_query_value(name: &str, value: String) -> Result<Option<uuid::Uuid>, RestError> {
    let Some(value) = non_empty_query_value(value) else {
        return Ok(None);
    };
    uuid::Uuid::parse_str(&value).map(Some).map_err(|_| {
        RestError::from_kernel(KernelError::validation(format!("{name} must be a UUID")))
    })
}

fn parse_datetime_query_value(
    name: &str,
    value: String,
) -> Result<Option<time::OffsetDateTime>, RestError> {
    let Some(value) = non_empty_query_value(value) else {
        return Ok(None);
    };
    time::OffsetDateTime::parse(&value, &Rfc3339)
        .map(Some)
        .map_err(|_| {
            RestError::from_kernel(KernelError::validation(format!(
                "{name} must be an RFC 3339 timestamp"
            )))
        })
}

fn parse_i64_query_value(name: &str, value: String) -> Result<Option<i64>, RestError> {
    let Some(value) = non_empty_query_value(value) else {
        return Ok(None);
    };
    value.parse::<i64>().map(Some).map_err(|_| {
        RestError::from_kernel(KernelError::validation(format!(
            "{name} must be an integer"
        )))
    })
}

fn decode_query_component(input: &str) -> Result<String, RestError> {
    let bytes = input.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                decoded.push(b' ');
                index += 1;
            }
            b'%' => {
                if index + 2 >= bytes.len() {
                    return Err(RestError::from_kernel(KernelError::validation(
                        "query contains an incomplete percent-escape",
                    )));
                }
                let high = hex_value(bytes[index + 1]).ok_or_else(|| {
                    RestError::from_kernel(KernelError::validation(
                        "query contains an invalid percent-escape",
                    ))
                })?;
                let low = hex_value(bytes[index + 2]).ok_or_else(|| {
                    RestError::from_kernel(KernelError::validation(
                        "query contains an invalid percent-escape",
                    ))
                })?;
                decoded.push((high << 4) | low);
                index += 3;
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(decoded).map_err(|_| {
        RestError::from_kernel(KernelError::validation("query contains invalid UTF-8 data"))
    })
}

const fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn normalize_assigned_to(raw: Option<String>, actor: UserId) -> Result<Option<UserId>, RestError> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.eq_ignore_ascii_case("me") {
        return Ok(Some(actor));
    }
    UserId::from_str(trimmed).map(Some).map_err(|_| {
        RestError::from_kernel(KernelError::validation(
            "assigned_to must be me or a user id",
        ))
    })
}

fn normalize_management_no(raw: &str) -> Result<String, RestError> {
    let normalized = raw.trim().trim_start_matches('#').trim();
    if normalized.is_empty() {
        return Err(RestError::from_kernel(KernelError::validation(
            "management_no must not be empty",
        )));
    }
    Ok(normalized.to_owned())
}

fn normalize_limit(raw: Option<i64>, default: i64, max: i64) -> Result<i64, RestError> {
    let limit = raw.unwrap_or(default);
    if !(1..=max).contains(&limit) {
        return Err(RestError::from_kernel(KernelError::validation(format!(
            "limit must be between 1 and {max}"
        ))));
    }
    Ok(limit)
}

fn normalize_offset(raw: Option<i64>) -> Result<i64, RestError> {
    let offset = raw.unwrap_or(0);
    if offset < 0 {
        return Err(RestError::from_kernel(KernelError::validation(
            "offset must be non-negative",
        )));
    }
    Ok(offset)
}

fn push_work_order_filters(
    builder: &mut QueryBuilder<Postgres>,
    branch_scope: &BranchScope,
    query: &NormalizedWorkOrderListQuery,
) -> Result<(), RestError> {
    push_branch_scope_filter(
        builder,
        branch_scope,
        BranchColumn::new("w.branch_id").map_err(RestError::from_kernel)?,
    );
    if !query.statuses.is_empty() {
        builder.push(" AND w.status = ANY(");
        builder.push_bind(query.statuses.clone());
        builder.push(")");
    }
    if !query.priorities.is_empty() {
        builder.push(" AND w.priority = ANY(");
        builder.push_bind(query.priorities.clone());
        builder.push(")");
    }
    if let Some(assigned_to) = query.assigned_to {
        builder.push(
            r#"
            AND EXISTS (
                SELECT 1
                FROM work_order_assignments filtered_assignments
                WHERE filtered_assignments.work_order_id = w.id
                  AND filtered_assignments.mechanic_id =
            "#,
        );
        builder.push_bind(*assigned_to.as_uuid());
        builder.push(")");
    }
    if let Some(customer_id) = query.customer_id {
        builder.push(" AND w.customer_id = ");
        builder.push_bind(customer_id);
    }
    if let Some(site_id) = query.site_id {
        builder.push(" AND w.site_id = ");
        builder.push_bind(site_id);
    }
    if let Some(from) = query.target_due_from {
        builder.push(" AND w.target_due_at >= ");
        builder.push_bind(from);
    }
    if let Some(to) = query.target_due_to {
        builder.push(" AND w.target_due_at <= ");
        builder.push_bind(to);
    }
    Ok(())
}

fn push_branch_scope_filter(
    builder: &mut QueryBuilder<Postgres>,
    scope: &BranchScope,
    column: BranchColumn,
) {
    match scope {
        BranchScope::All => {
            builder.push("TRUE");
        }
        BranchScope::Branches(branches) if branches.is_empty() => {
            builder.push("FALSE");
        }
        BranchScope::Branches(branches) => {
            let branch_ids = branches
                .iter()
                .map(|branch| *branch.as_uuid())
                .collect::<Vec<_>>();
            builder.push(column.as_str());
            builder.push(" = ANY(");
            builder.push_bind(branch_ids);
            builder.push(")");
        }
    }
}

async fn fetch_assignment_map(
    pool: &PgPool,
    work_order_ids: &[uuid::Uuid],
) -> Result<BTreeMap<uuid::Uuid, Vec<AssignmentSummary>>, RestError> {
    if work_order_ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    let org = current_org()
        .map_err(KernelError::from)
        .map_err(RestError::from_kernel)?;
    let ids = work_order_ids.to_vec();
    let rows = with_org_conn::<_, _, RestError>(pool, org, move |tx| {
        Box::pin(async move {
            Ok(sqlx::query(
                r#"
        SELECT
            a.work_order_id, a.id, a.mechanic_id, u.display_name AS mechanic_name,
            a.role, a.assigned_at
        FROM work_order_assignments a
        JOIN users u ON u.id = a.mechanic_id
        WHERE a.work_order_id = ANY($1)
        ORDER BY a.work_order_id,
                 CASE a.role WHEN 'PRIMARY' THEN 1 ELSE 2 END,
                 a.assigned_at,
                 a.id
        "#,
            )
            .bind(ids)
            .fetch_all(tx.as_mut())
            .await?)
        })
    })
    .await?;
    let mut assignments = BTreeMap::<uuid::Uuid, Vec<AssignmentSummary>>::new();
    for row in rows {
        let work_order_id = row.try_get("work_order_id")?;
        assignments
            .entry(work_order_id)
            .or_default()
            .push(assignment_from_row(&row)?);
    }
    Ok(assignments)
}

async fn fetch_approval_line(
    pool: &PgPool,
    work_order_id: WorkOrderId,
) -> Result<Vec<ApprovalStepSummary>, RestError> {
    let org = current_org()
        .map_err(KernelError::from)
        .map_err(RestError::from_kernel)?;
    let wo_uuid = *work_order_id.as_uuid();
    let rows = with_org_conn::<_, _, RestError>(pool, org, move |tx| {
        Box::pin(async move {
            Ok(sqlx::query(
                r#"
        SELECT
            id, step_order, role, approver_id, status, requested_at,
            approved_at, approved_by_id
        FROM work_order_approval_steps
        WHERE work_order_id = $1
        ORDER BY step_order
        "#,
            )
            .bind(wo_uuid)
            .fetch_all(tx.as_mut())
            .await?)
        })
    })
    .await?;
    rows.iter().map(approval_step_from_row).collect()
}

async fn fetch_status_history(
    pool: &PgPool,
    work_order_id: WorkOrderId,
) -> Result<Vec<StatusHistorySummary>, RestError> {
    let org = current_org()
        .map_err(KernelError::from)
        .map_err(RestError::from_kernel)?;
    let wo_uuid = *work_order_id.as_uuid();
    let rows = with_org_conn::<_, _, RestError>(pool, org, move |tx| {
        Box::pin(async move {
            Ok(sqlx::query(
                r#"
        SELECT id, actor, action, from_status, to_status, occurred_at
        FROM work_order_status_history
        WHERE work_order_id = $1
        ORDER BY occurred_at, id
        "#,
            )
            .bind(wo_uuid)
            .fetch_all(tx.as_mut())
            .await?)
        })
    })
    .await?;
    rows.iter().map(status_history_from_row).collect()
}

async fn fetch_evidence_summaries(
    pool: &PgPool,
    work_order_id: WorkOrderId,
) -> Result<Vec<EvidenceSummary>, RestError> {
    let org = current_org()
        .map_err(KernelError::from)
        .map_err(RestError::from_kernel)?;
    let wo_uuid = *work_order_id.as_uuid();
    let rows = with_org_conn::<_, _, RestError>(pool, org, move |tx| {
        Box::pin(async move {
            Ok(sqlx::query(
                r#"
        SELECT
            id, stage, content_type, size_bytes, uploaded_by,
            worm_replica_status, retry_count, verified_at, created_at
        FROM evidence_media
        WHERE work_order_id = $1
        ORDER BY created_at, id
        "#,
            )
            .bind(wo_uuid)
            .fetch_all(tx.as_mut())
            .await?)
        })
    })
    .await?;
    rows.iter().map(evidence_from_row).collect()
}

fn work_order_list_item_from_row(
    row: &sqlx::postgres::PgRow,
    assignments: &BTreeMap<uuid::Uuid, Vec<AssignmentSummary>>,
) -> Result<WorkOrderListItem, RestError> {
    let id: uuid::Uuid = row.try_get("id")?;
    Ok(WorkOrderListItem {
        id: WorkOrderId::from_uuid(id),
        request_no: row.try_get("request_no")?,
        branch_id: BranchId::from_uuid(row.try_get("branch_id")?),
        status: row.try_get("status")?,
        priority: row.try_get("priority")?,
        result_type: row.try_get("result_type")?,
        target_due_at: row.try_get("target_due_at")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        equipment: equipment_summary_from_row(row)?,
        customer: NamedEntity {
            id: row.try_get("customer_id")?,
            name: row.try_get("customer_name")?,
        },
        site: NamedEntity {
            id: row.try_get("site_id")?,
            name: row.try_get("site_name")?,
        },
        site_contact: site_contact_from_row(row)?,
        assignments: assignments.get(&id).cloned().unwrap_or_default(),
    })
}

fn work_order_detail_from_row(
    row: &sqlx::postgres::PgRow,
    assignments: Vec<AssignmentSummary>,
    approval_line: Vec<ApprovalStepSummary>,
    status_history: Vec<StatusHistorySummary>,
    evidence: Vec<EvidenceSummary>,
) -> Result<WorkOrderDetail, RestError> {
    Ok(WorkOrderDetail {
        id: WorkOrderId::from_uuid(row.try_get("id")?),
        request_no: row.try_get("request_no")?,
        branch_id: BranchId::from_uuid(row.try_get("branch_id")?),
        status: row.try_get("status")?,
        priority: row.try_get("priority")?,
        result_type: row.try_get("result_type")?,
        symptom: row.try_get("symptom")?,
        customer_request: row.try_get("customer_request")?,
        target_due_at: row.try_get("target_due_at")?,
        delay_reason: row.try_get("delay_reason")?,
        delay_note: row.try_get("delay_note")?,
        diagnosis: row.try_get("diagnosis")?,
        action_taken: row.try_get("action_taken")?,
        report_submitted_by: row
            .try_get::<Option<uuid::Uuid>, _>("report_submitted_by")?
            .map(UserId::from_uuid),
        report_submitted_at: row.try_get("report_submitted_at")?,
        kpi_excluded: row.try_get("kpi_excluded")?,
        evidence_verified: row.try_get("evidence_verified")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        equipment: equipment_summary_from_row(row)?,
        customer: NamedEntity {
            id: row.try_get("customer_id")?,
            name: row.try_get("customer_name")?,
        },
        site: NamedEntity {
            id: row.try_get("site_id")?,
            name: row.try_get("site_name")?,
        },
        site_contact: site_contact_from_row(row)?,
        assignments,
        approval_line,
        status_history,
        evidence,
    })
}

/// Build the site's representative contact from the detail row. Returns None when
/// the site has no contact registered (all three columns NULL) so the response
/// omits an empty object.
fn site_contact_from_row(row: &sqlx::postgres::PgRow) -> Result<Option<SiteContact>, RestError> {
    let name: Option<String> = row.try_get("site_contact_name")?;
    let phone: Option<String> = row.try_get("site_contact_phone")?;
    let email: Option<String> = row.try_get("site_contact_email")?;
    if name.is_none() && phone.is_none() && email.is_none() {
        Ok(None)
    } else {
        Ok(Some(SiteContact { name, phone, email }))
    }
}

fn equipment_summary_from_row(row: &sqlx::postgres::PgRow) -> Result<EquipmentSummary, RestError> {
    Ok(EquipmentSummary {
        id: row.try_get("equipment_id")?,
        equipment_no: row.try_get("equipment_no")?,
        management_no: row.try_get("management_no")?,
        model: row.try_get("model")?,
        status: row.try_get("equipment_status")?,
        specification: row.try_get("specification")?,
        ton_text: row.try_get("ton_text")?,
    })
}

fn equipment_lookup_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<EquipmentLookupResponse, RestError> {
    Ok(EquipmentLookupResponse {
        id: row.try_get("id")?,
        branch_id: BranchId::from_uuid(row.try_get("branch_id")?),
        equipment_no: row.try_get("equipment_no")?,
        management_no: row.try_get("management_no")?,
        model: row.try_get("model")?,
        status: row.try_get("status")?,
        specification: row.try_get("specification")?,
        ton_text: row.try_get("ton_text")?,
        maker: row.try_get("maker")?,
        vin: row.try_get("vin")?,
        vehicle_registration_no: row.try_get("vehicle_registration_no")?,
        customer: NamedEntity {
            id: row.try_get("customer_id")?,
            name: row.try_get("customer_name")?,
        },
        site: NamedEntity {
            id: row.try_get("site_id")?,
            name: row.try_get("site_name")?,
        },
    })
}

fn assignment_from_row(row: &sqlx::postgres::PgRow) -> Result<AssignmentSummary, RestError> {
    Ok(AssignmentSummary {
        id: row.try_get("id")?,
        mechanic_id: UserId::from_uuid(row.try_get("mechanic_id")?),
        mechanic_name: row.try_get("mechanic_name")?,
        role: row.try_get("role")?,
        assigned_at: row.try_get("assigned_at")?,
    })
}

fn approval_step_from_row(row: &sqlx::postgres::PgRow) -> Result<ApprovalStepSummary, RestError> {
    Ok(ApprovalStepSummary {
        id: row.try_get("id")?,
        step_order: row.try_get("step_order")?,
        role: row.try_get("role")?,
        approver_id: row
            .try_get::<Option<uuid::Uuid>, _>("approver_id")?
            .map(UserId::from_uuid),
        status: row.try_get("status")?,
        requested_at: row.try_get("requested_at")?,
        approved_at: row.try_get("approved_at")?,
        approved_by_id: row
            .try_get::<Option<uuid::Uuid>, _>("approved_by_id")?
            .map(UserId::from_uuid),
    })
}

fn status_history_from_row(row: &sqlx::postgres::PgRow) -> Result<StatusHistorySummary, RestError> {
    Ok(StatusHistorySummary {
        id: row.try_get("id")?,
        actor: row
            .try_get::<Option<uuid::Uuid>, _>("actor")?
            .map(UserId::from_uuid),
        action: row.try_get("action")?,
        from_status: row.try_get("from_status")?,
        to_status: row.try_get("to_status")?,
        occurred_at: row.try_get("occurred_at")?,
    })
}

fn evidence_from_row(row: &sqlx::postgres::PgRow) -> Result<EvidenceSummary, RestError> {
    Ok(EvidenceSummary {
        id: EvidenceId::from_uuid(row.try_get("id")?),
        stage: row.try_get("stage")?,
        content_type: row.try_get("content_type")?,
        size_bytes: row.try_get("size_bytes")?,
        uploaded_by: UserId::from_uuid(row.try_get("uploaded_by")?),
        worm_replica_status: row.try_get("worm_replica_status")?,
        retry_count: row.try_get("retry_count")?,
        verified_at: row.try_get("verified_at")?,
        created_at: row.try_get("created_at")?,
    })
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

    let org_id = OrgId::from_str(&claims.org)
        .map_err(|_| RestError::unauthorized("token contains an invalid org id"))?;
    Ok(Principal::new(user_id, org_id, roles, branch_scope))
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
