//! Financial REST API.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use mnt_financial_adapter_postgres::{PgFinancialError, PgFinancialStore};
use mnt_financial_application::{
    AppendCostLedgerEntryCommand, ConfirmPurchaseAttachmentUploadCommand, CostLedgerSource,
    CreatePurchaseRequestCommand, CreateRentalQuoteCommand, ExecutePurchaseCommand,
    FinancialConfigSnapshot, PrepareExpenditureCommand, PreparePurchaseAttachmentUploadCommand,
    PurchaseApprovalCommand, PurchaseRequestLineInput, PurchaseRestartCommand,
    PurchaseSubmitCommand, PurchaseType, RejectPurchaseCommand,
};
use mnt_financial_domain::{MoneyInput, RentalQuoteInput, compute_rental_quote};
use mnt_kernel_core::{
    BranchId, EquipmentId, ErrorKind, EvidenceId, KernelError, PurchaseRequestId, QuoteId,
    TraceContext, WorkOrderId,
};
use mnt_platform_auth::JwtVerifier;
use mnt_platform_authz::{Action, Feature, Principal, authorize};
use mnt_platform_db::DbError;
use mnt_platform_storage::{
    PresignGetRequest, PresignPutRequest, PresignedUpload, S3ObjectStore, SeaweedS3Storage,
};
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct FinancialRestState {
    store: PgFinancialStore,
    jwt_verifier: Option<JwtVerifier>,
    purchase_attachment_storage: Option<(SeaweedS3Storage, String)>,
}

impl FinancialRestState {
    #[must_use]
    pub fn new(store: PgFinancialStore, jwt_verifier: Option<JwtVerifier>) -> Self {
        Self {
            store,
            jwt_verifier,
            purchase_attachment_storage: None,
        }
    }

    #[must_use]
    pub fn with_purchase_attachment_storage(
        mut self,
        storage: Option<(SeaweedS3Storage, String)>,
    ) -> Self {
        self.purchase_attachment_storage = storage;
        self
    }
}

pub fn router(state: FinancialRestState) -> Router {
    let verifier = state.jwt_verifier.clone();
    let pool = state.store.pool().clone();
    let router = Router::new()
        .route(
            "/api/v1/financial/rental-quotes/compute",
            post(compute_quote),
        )
        .route("/api/v1/financial/rental-quotes", post(create_rental_quote))
        .route(
            "/api/v1/financial/rental-quotes/{quote_id}",
            get(get_rental_quote),
        )
        .route(
            "/api/v1/financial/equipment/{equipment_id}/cost-ledger",
            get(list_cost_ledger),
        )
        .route(
            "/api/v1/financial/equipment/{equipment_id}/lifecycle-cost",
            get(get_lifecycle_cost),
        )
        .route(
            "/api/v1/financial/equipment/{equipment_id}/cost-ledger/manual",
            post(append_manual_cost_ledger),
        )
        .route(
            "/api/v1/financial/purchase-requests",
            post(create_purchase_request),
        )
        .route(
            "/api/v1/financial/purchase-requests/preferences",
            get(get_purchase_preferences).put(save_purchase_preferences),
        )
        .route(
            "/api/v1/financial/purchase-requests/attachments/presign",
            post(presign_purchase_attachment),
        )
        .route(
            "/api/v1/financial/purchase-requests/attachments/{attachment_id}/confirm",
            post(confirm_purchase_attachment),
        )
        .route(
            "/api/v1/financial/purchase-requests/{purchase_request_id}",
            get(get_purchase_request),
        )
        .route(
            "/api/v1/financial/purchase-requests/{purchase_request_id}/attachments/{attachment_id}/download",
            get(download_purchase_attachment),
        )
        .route(
            "/api/v1/financial/purchase-requests/{purchase_request_id}/submit",
            post(submit_purchase_request),
        )
        .route(
            "/api/v1/financial/purchase-requests/{purchase_request_id}/approve-admin",
            post(approve_purchase_admin),
        )
        .route(
            "/api/v1/financial/purchase-requests/{purchase_request_id}/prepare-expenditure",
            post(prepare_expenditure),
        )
        .route(
            "/api/v1/financial/purchase-requests/{purchase_request_id}/approve-executive",
            post(approve_purchase_executive),
        )
        .route(
            "/api/v1/financial/purchase-requests/{purchase_request_id}/reject",
            post(reject_purchase_request),
        )
        .route(
            "/api/v1/financial/purchase-requests/{purchase_request_id}/restart",
            post(restart_purchase_request),
        )
        .route(
            "/api/v1/financial/purchase-requests/{purchase_request_id}/execute",
            post(execute_purchase),
        )
        .with_state(state);
    mnt_platform_request_context::with_request_context(router, verifier, pool)
}

#[derive(Debug, Deserialize)]
struct ComputeQuoteRequest {
    branch_id: BranchId,
    acquisition_value_won: i64,
    current_residual_value_won: i64,
    cumulative_repair_cost_won: i64,
    config: FinancialConfigSnapshot,
}

#[derive(Debug, Deserialize)]
struct CreateRentalQuoteRequest {
    branch_id: BranchId,
    equipment_id: EquipmentId,
    config: FinancialConfigSnapshot,
}

#[derive(Debug, Deserialize)]
struct AppendManualCostLedgerRequest {
    branch_id: BranchId,
    work_order_id: Option<WorkOrderId>,
    amount_won: i64,
    memo: String,
    config: FinancialConfigSnapshot,
}

#[derive(Debug, Deserialize)]
struct CreatePurchaseRequest {
    branch_id: BranchId,
    equipment_id: Option<EquipmentId>,
    work_order_id: Option<WorkOrderId>,
    statement_evidence_id: Option<EvidenceId>,
    purchase_type: PurchaseType,
    vendor_name: String,
    amount_won: Option<i64>,
    lines: Vec<PurchaseRequestLineInput>,
    quote_attachment_ids: Vec<uuid::Uuid>,
    memo: String,
    config: FinancialConfigSnapshot,
}

#[derive(Debug, Deserialize)]
struct PurchaseAttachmentPresignRequest {
    branch_id: BranchId,
    file_name: String,
    content_type: String,
    size_bytes: i64,
    checksum_sha256: Option<String>,
    role: Option<String>,
}

#[derive(Debug, Serialize)]
struct PurchaseAttachmentPresignResponse {
    attachment_id: uuid::Uuid,
    upload: PresignedUpload,
    file_name: String,
    content_type: String,
    size_bytes: i64,
    role: String,
    upload_state: String,
}

#[derive(Debug, Serialize)]
struct PurchaseAttachmentDownloadResponse {
    url: String,
}

#[derive(Debug, Deserialize)]
struct SavePurchasePreferencesRequest {
    schema_version: i32,
    preferences: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct PrepareExpenditureRequest {
    expenditure_no: String,
}

#[derive(Debug, Deserialize)]
struct RejectPurchaseRequest {
    memo: String,
}

#[derive(Debug, Deserialize)]
struct RestartPurchaseRequest {
    statement_evidence_id: Option<EvidenceId>,
    amount_won: Option<i64>,
    lines: Vec<PurchaseRequestLineInput>,
    quote_attachment_ids: Vec<uuid::Uuid>,
    memo: String,
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

async fn compute_quote(
    State(state): State<FinancialRestState>,
    headers: HeaderMap,
    Json(body): Json<ComputeQuoteRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize(
        &principal,
        Action::new(Feature::RentalQuoteManage),
        body.branch_id,
    )
    .map_err(RestError::from_kernel)?;
    let quote = compute_rental_quote(RentalQuoteInput {
        acquisition_value: MoneyInput::won(body.acquisition_value_won),
        current_residual_value: MoneyInput::won(body.current_residual_value_won),
        cumulative_repair_cost: MoneyInput::won(body.cumulative_repair_cost_won),
        config: body.config.quote_config(),
    })
    .map_err(RestError::from_kernel)?;
    Ok(Json(quote))
}

async fn create_rental_quote(
    State(state): State<FinancialRestState>,
    headers: HeaderMap,
    Json(body): Json<CreateRentalQuoteRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize(
        &principal,
        Action::new(Feature::RentalQuoteManage),
        body.branch_id,
    )
    .map_err(RestError::from_kernel)?;
    let quote = state
        .store
        .create_rental_quote(CreateRentalQuoteCommand {
            actor: principal.user_id,
            branch_id: body.branch_id,
            equipment_id: body.equipment_id,
            config: body.config,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok((StatusCode::CREATED, Json(quote)))
}

async fn get_rental_quote(
    State(state): State<FinancialRestState>,
    headers: HeaderMap,
    Path(quote_id): Path<uuid::Uuid>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let quote = state
        .store
        .rental_quote(QuoteId::from_uuid(quote_id))
        .await
        .map_err(RestError::from_store)?;
    authorize(
        &principal,
        Action::new(Feature::RentalQuoteManage),
        quote.branch_id,
    )
    .map_err(RestError::from_kernel)?;
    Ok(Json(quote))
}

async fn list_cost_ledger(
    State(state): State<FinancialRestState>,
    headers: HeaderMap,
    Path(equipment_id): Path<uuid::Uuid>,
) -> Result<impl IntoResponse, RestError> {
    let equipment_id = EquipmentId::from_uuid(equipment_id);
    let principal = principal_from_headers(&state, &headers).await?;
    let branch_id = state
        .store
        .equipment_branch(equipment_id)
        .await
        .map_err(RestError::from_store)?;
    authorize(
        &principal,
        Action::new(Feature::EquipmentCostLedgerRead),
        branch_id,
    )
    .map_err(RestError::from_kernel)?;
    let entries = state
        .store
        .cost_ledger_for_equipment(equipment_id)
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(entries))
}

async fn get_lifecycle_cost(
    State(state): State<FinancialRestState>,
    headers: HeaderMap,
    Path(equipment_id): Path<uuid::Uuid>,
) -> Result<impl IntoResponse, RestError> {
    let equipment_id = EquipmentId::from_uuid(equipment_id);
    let principal = principal_from_headers(&state, &headers).await?;
    let branch_id = state
        .store
        .equipment_branch(equipment_id)
        .await
        .map_err(RestError::from_store)?;
    authorize(
        &principal,
        Action::new(Feature::EquipmentCostLedgerRead),
        branch_id,
    )
    .map_err(RestError::from_kernel)?;
    let summary = state
        .store
        .lifecycle_cost_for_equipment(equipment_id)
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(summary))
}

async fn append_manual_cost_ledger(
    State(state): State<FinancialRestState>,
    headers: HeaderMap,
    Path(equipment_id): Path<uuid::Uuid>,
    Json(body): Json<AppendManualCostLedgerRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize(
        &principal,
        Action::new(Feature::EquipmentCostLedgerWrite),
        body.branch_id,
    )
    .map_err(RestError::from_kernel)?;
    let entry = state
        .store
        .append_cost_ledger_entry(AppendCostLedgerEntryCommand {
            actor: principal.user_id,
            branch_id: body.branch_id,
            equipment_id: EquipmentId::from_uuid(equipment_id),
            work_order_id: body.work_order_id,
            source: CostLedgerSource::ManualAdmin,
            amount_won: body.amount_won,
            memo: body.memo,
            config: body.config,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok((StatusCode::CREATED, Json(entry)))
}

async fn create_purchase_request(
    State(state): State<FinancialRestState>,
    headers: HeaderMap,
    Json(body): Json<CreatePurchaseRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize(
        &principal,
        Action::request(Feature::PurchaseRequestCreate),
        body.branch_id,
    )
    .map_err(RestError::from_kernel)?;
    let purchase = state
        .store
        .create_purchase_request(CreatePurchaseRequestCommand {
            actor: principal.user_id,
            branch_id: body.branch_id,
            equipment_id: body.equipment_id,
            work_order_id: body.work_order_id,
            statement_evidence_id: body.statement_evidence_id,
            purchase_type: body.purchase_type,
            vendor_name: body.vendor_name,
            amount_won: body.amount_won,
            lines: body.lines,
            quote_attachment_ids: body.quote_attachment_ids,
            memo: body.memo,
            config: body.config,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok((StatusCode::CREATED, Json(purchase)))
}

async fn get_purchase_preferences(
    State(state): State<FinancialRestState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let preferences = state
        .store
        .purchase_feature_preferences(principal.user_id, "purchase_requests")
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(preferences))
}

async fn save_purchase_preferences(
    State(state): State<FinancialRestState>,
    headers: HeaderMap,
    Json(body): Json<SavePurchasePreferencesRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let preferences = state
        .store
        .save_purchase_feature_preferences(
            principal.user_id,
            "purchase_requests",
            body.schema_version,
            body.preferences,
        )
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(preferences))
}

async fn presign_purchase_attachment(
    State(state): State<FinancialRestState>,
    headers: HeaderMap,
    Json(body): Json<PurchaseAttachmentPresignRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize(
        &principal,
        Action::request(Feature::PurchaseRequestCreate),
        body.branch_id,
    )
    .map_err(RestError::from_kernel)?;
    validate_purchase_attachment_content_type(&body.content_type)
        .map_err(RestError::from_kernel)?;

    let (object_store, bucket) = state
        .purchase_attachment_storage
        .as_ref()
        .ok_or_else(|| RestError::unavailable("purchase attachment storage is not configured"))?;
    let org =
        mnt_platform_request_context::current_org().map_err(rest_error_from_request_context)?;
    let storage_key = purchase_attachment_s3_key(org, &body.file_name);
    let role = body
        .role
        .unwrap_or_else(|| "QUOTE".to_owned())
        .to_uppercase();
    let upload = object_store
        .presign_put(PresignPutRequest {
            bucket: bucket.clone(),
            key: storage_key.clone(),
            content_type: body.content_type.clone(),
            size_bytes: body.size_bytes,
            checksum_sha256: body.checksum_sha256.clone(),
            expires_in: Duration::from_secs(15 * 60),
        })
        .await
        .map_err(|err| {
            RestError::unavailable(format!("purchase attachment storage unavailable: {err}"))
        })?;

    let record = state
        .store
        .prepare_purchase_attachment_upload(PreparePurchaseAttachmentUploadCommand {
            actor: principal.user_id,
            branch_id: body.branch_id,
            file_name: body.file_name,
            content_type: body.content_type,
            size_bytes: body.size_bytes,
            checksum_sha256: body.checksum_sha256,
            role,
            s3_bucket: bucket.clone(),
            s3_key: storage_key,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;

    Ok((
        StatusCode::CREATED,
        Json(PurchaseAttachmentPresignResponse {
            attachment_id: record.id,
            upload,
            file_name: record.file_name,
            content_type: record.content_type,
            size_bytes: record.size_bytes,
            role: record.role,
            upload_state: record.upload_state,
        }),
    ))
}

async fn confirm_purchase_attachment(
    State(state): State<FinancialRestState>,
    headers: HeaderMap,
    Path(attachment_id): Path<uuid::Uuid>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let record = state
        .store
        .confirm_purchase_attachment_upload(ConfirmPurchaseAttachmentUploadCommand {
            actor: principal.user_id,
            attachment_id,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    authorize(
        &principal,
        Action::request(Feature::PurchaseRequestCreate),
        record.branch_id,
    )
    .map_err(RestError::from_kernel)?;
    Ok(Json(record))
}

async fn download_purchase_attachment(
    State(state): State<FinancialRestState>,
    headers: HeaderMap,
    Path((purchase_request_id, attachment_id)): Path<(uuid::Uuid, uuid::Uuid)>,
) -> Result<impl IntoResponse, RestError> {
    let purchase_request_id = PurchaseRequestId::from_uuid(purchase_request_id);
    let _ = authorize_for_purchase_read(&state, &headers, purchase_request_id).await?;
    let attachment = state
        .store
        .purchase_attachment_download(purchase_request_id, attachment_id)
        .await
        .map_err(RestError::from_store)?;
    let (object_store, _) = state
        .purchase_attachment_storage
        .as_ref()
        .ok_or_else(|| RestError::unavailable("purchase attachment storage is not configured"))?;
    let url = object_store
        .presign_get(PresignGetRequest {
            bucket: attachment.s3_bucket,
            key: attachment.s3_key,
            expires_in: Duration::from_secs(10 * 60),
        })
        .await
        .map_err(|err| {
            RestError::unavailable(format!("purchase attachment storage unavailable: {err}"))
        })?;
    Ok(Json(PurchaseAttachmentDownloadResponse { url }))
}

async fn get_purchase_request(
    State(state): State<FinancialRestState>,
    headers: HeaderMap,
    Path(purchase_request_id): Path<uuid::Uuid>,
) -> Result<impl IntoResponse, RestError> {
    let purchase_request_id = PurchaseRequestId::from_uuid(purchase_request_id);
    let (purchase, _) = authorize_for_purchase(
        &state,
        &headers,
        purchase_request_id,
        Action::limited(Feature::PurchaseRequestRead),
    )
    .await?;
    Ok(Json(purchase))
}

async fn submit_purchase_request(
    State(state): State<FinancialRestState>,
    headers: HeaderMap,
    Path(purchase_request_id): Path<uuid::Uuid>,
) -> Result<impl IntoResponse, RestError> {
    let purchase_request_id = PurchaseRequestId::from_uuid(purchase_request_id);
    let (_, principal) = authorize_for_purchase(
        &state,
        &headers,
        purchase_request_id,
        Action::new(Feature::PurchaseRequestCreate),
    )
    .await?;
    let purchase = state
        .store
        .submit_purchase_request(PurchaseSubmitCommand {
            actor: principal.user_id,
            purchase_request_id,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(purchase))
}

async fn approve_purchase_admin(
    State(state): State<FinancialRestState>,
    headers: HeaderMap,
    Path(purchase_request_id): Path<uuid::Uuid>,
) -> Result<impl IntoResponse, RestError> {
    let purchase_request_id = PurchaseRequestId::from_uuid(purchase_request_id);
    let (_, principal) = authorize_for_purchase(
        &state,
        &headers,
        purchase_request_id,
        Action::new(Feature::PurchaseRequestApprove),
    )
    .await?;
    let purchase = state
        .store
        .approve_purchase_admin(PurchaseApprovalCommand {
            actor: principal.user_id,
            purchase_request_id,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(purchase))
}

async fn prepare_expenditure(
    State(state): State<FinancialRestState>,
    headers: HeaderMap,
    Path(purchase_request_id): Path<uuid::Uuid>,
    Json(body): Json<PrepareExpenditureRequest>,
) -> Result<impl IntoResponse, RestError> {
    let purchase_request_id = PurchaseRequestId::from_uuid(purchase_request_id);
    let (_, principal) = authorize_for_purchase(
        &state,
        &headers,
        purchase_request_id,
        Action::new(Feature::PurchaseRequestCreate),
    )
    .await?;
    let purchase = state
        .store
        .prepare_expenditure(PrepareExpenditureCommand {
            actor: principal.user_id,
            purchase_request_id,
            expenditure_no: body.expenditure_no,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(purchase))
}

async fn approve_purchase_executive(
    State(state): State<FinancialRestState>,
    headers: HeaderMap,
    Path(purchase_request_id): Path<uuid::Uuid>,
) -> Result<impl IntoResponse, RestError> {
    let purchase_request_id = PurchaseRequestId::from_uuid(purchase_request_id);
    let (_, principal) = authorize_for_purchase(
        &state,
        &headers,
        purchase_request_id,
        Action::new(Feature::PurchaseFinalApprove),
    )
    .await?;
    let purchase = state
        .store
        .approve_purchase_executive(PurchaseApprovalCommand {
            actor: principal.user_id,
            purchase_request_id,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(purchase))
}

async fn reject_purchase_request(
    State(state): State<FinancialRestState>,
    headers: HeaderMap,
    Path(purchase_request_id): Path<uuid::Uuid>,
    Json(body): Json<RejectPurchaseRequest>,
) -> Result<impl IntoResponse, RestError> {
    let purchase_request_id = PurchaseRequestId::from_uuid(purchase_request_id);
    let (purchase, principal) =
        authorize_for_purchase_read(&state, &headers, purchase_request_id).await?;
    authorize_any(
        &principal,
        purchase.branch_id,
        &[
            Action::new(Feature::PurchaseRequestApprove),
            Action::new(Feature::PurchaseFinalApprove),
        ],
    )?;
    let purchase = state
        .store
        .reject_purchase_request(RejectPurchaseCommand {
            actor: principal.user_id,
            purchase_request_id,
            memo: body.memo,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(purchase))
}

async fn restart_purchase_request(
    State(state): State<FinancialRestState>,
    headers: HeaderMap,
    Path(purchase_request_id): Path<uuid::Uuid>,
    Json(body): Json<RestartPurchaseRequest>,
) -> Result<impl IntoResponse, RestError> {
    let purchase_request_id = PurchaseRequestId::from_uuid(purchase_request_id);
    let (_, principal) = authorize_for_purchase(
        &state,
        &headers,
        purchase_request_id,
        Action::new(Feature::PurchaseRequestCreate),
    )
    .await?;
    let purchase = state
        .store
        .restart_purchase_request(PurchaseRestartCommand {
            actor: principal.user_id,
            purchase_request_id,
            statement_evidence_id: body.statement_evidence_id,
            amount_won: body.amount_won,
            lines: body.lines,
            quote_attachment_ids: body.quote_attachment_ids,
            memo: body.memo,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(purchase))
}

async fn execute_purchase(
    State(state): State<FinancialRestState>,
    headers: HeaderMap,
    Path(purchase_request_id): Path<uuid::Uuid>,
) -> Result<impl IntoResponse, RestError> {
    let purchase_request_id = PurchaseRequestId::from_uuid(purchase_request_id);
    let (_, principal) = authorize_for_purchase(
        &state,
        &headers,
        purchase_request_id,
        Action::new(Feature::PurchaseExecute),
    )
    .await?;
    let purchase = state
        .store
        .execute_purchase(ExecutePurchaseCommand {
            actor: principal.user_id,
            purchase_request_id,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(purchase))
}

fn purchase_attachment_s3_key(org: mnt_kernel_core::OrgId, file_name: &str) -> String {
    let safe_name: String = file_name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let safe_name = safe_name.trim_matches('_');
    let file_name = if safe_name.is_empty() {
        "quote"
    } else {
        safe_name
    };
    format!(
        "orgs/{}/purchase-requests/quotes/{}-{}",
        org.as_uuid(),
        uuid::Uuid::new_v4(),
        file_name
    )
}

fn validate_purchase_attachment_content_type(content_type: &str) -> Result<(), KernelError> {
    let content_type = content_type
        .split(';')
        .next()
        .unwrap_or(content_type)
        .trim()
        .to_ascii_lowercase();
    const ALLOWED: &[&str] = &[
        "application/pdf",
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/heic",
    ];
    if ALLOWED.iter().any(|allowed| *allowed == content_type) {
        Ok(())
    } else {
        Err(KernelError::validation(
            "purchase quote attachments must be PDF or image files",
        ))
    }
}

async fn authorize_for_purchase(
    state: &FinancialRestState,
    headers: &HeaderMap,
    purchase_request_id: PurchaseRequestId,
    action: Action,
) -> Result<(mnt_financial_application::PurchaseRequestSummary, Principal), RestError> {
    let (purchase, principal) =
        authorize_for_purchase_read(state, headers, purchase_request_id).await?;
    authorize(&principal, action, purchase.branch_id).map_err(RestError::from_kernel)?;
    Ok((purchase, principal))
}

async fn authorize_for_purchase_read(
    state: &FinancialRestState,
    headers: &HeaderMap,
    purchase_request_id: PurchaseRequestId,
) -> Result<(mnt_financial_application::PurchaseRequestSummary, Principal), RestError> {
    let principal = principal_from_headers(state, headers).await?;
    let purchase = state
        .store
        .purchase_request(purchase_request_id)
        .await
        .map_err(RestError::from_store)?;
    authorize(
        &principal,
        Action::limited(Feature::PurchaseRequestRead),
        purchase.branch_id,
    )
    .map_err(RestError::from_kernel)?;
    Ok((purchase, principal))
}

fn authorize_any(
    principal: &Principal,
    branch_id: BranchId,
    actions: &[Action],
) -> Result<(), RestError> {
    if actions
        .iter()
        .any(|action| authorize(principal, *action, branch_id).is_ok())
    {
        Ok(())
    } else {
        Err(RestError::from_kernel(KernelError::forbidden(
            "role is not allowed to use feature",
        )))
    }
}

async fn principal_from_headers(
    state: &FinancialRestState,
    headers: &HeaderMap,
) -> Result<Principal, RestError> {
    let verifier = state.jwt_verifier.as_ref().ok_or_else(|| {
        RestError::unavailable("JWT verification is not configured for financial API")
    })?;
    mnt_platform_request_context::resolve_principal(verifier, state.store.pool(), headers)
        .await
        .map_err(rest_error_from_request_context)
}

fn rest_error_from_request_context(
    err: mnt_platform_request_context::RequestContextError,
) -> RestError {
    match err {
        mnt_platform_request_context::RequestContextError::VerifierUnavailable => {
            RestError::unavailable("JWT verification is not configured for financial API")
        }
        mnt_platform_request_context::RequestContextError::WrongTokenTier => {
            RestError::from_kernel(KernelError::forbidden(
                "token tier is not valid for this route",
            ))
        }
        mnt_platform_request_context::RequestContextError::AccessScope(error) => {
            RestError::from_kernel(error)
        }
        mnt_platform_request_context::RequestContextError::BranchScope(message)
        | mnt_platform_request_context::RequestContextError::EffectivePolicy(message) => {
            RestError::internal(message)
        }
        mnt_platform_request_context::RequestContextError::MissingOrg => {
            RestError::internal("no tenant context is bound to the current request")
        }
        mnt_platform_request_context::RequestContextError::MissingBearer => {
            RestError::unauthorized("missing or malformed bearer token")
        }
        mnt_platform_request_context::RequestContextError::InvalidToken => {
            RestError::unauthorized("invalid bearer token")
        }
        mnt_platform_request_context::RequestContextError::InvalidClaim(message) => {
            RestError::unauthorized(format!("token claim is invalid: {message}"))
        }
    }
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

    fn from_store(error: PgFinancialError) -> Self {
        match error {
            PgFinancialError::Domain(error) => Self::from_kernel(error),
            PgFinancialError::Db(error) => Self::from_db(error),
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

fn status_for_error_kind(kind: ErrorKind) -> StatusCode {
    match kind {
        ErrorKind::Validation => StatusCode::UNPROCESSABLE_ENTITY,
        ErrorKind::NotFound => StatusCode::NOT_FOUND,
        ErrorKind::Forbidden => StatusCode::FORBIDDEN,
        ErrorKind::Conflict | ErrorKind::InvalidTransition => StatusCode::CONFLICT,
        ErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
    }
}
