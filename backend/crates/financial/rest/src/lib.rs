//! Financial REST API.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::collections::BTreeSet;
use std::str::FromStr;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use mnt_financial_adapter_postgres::{PgFinancialError, PgFinancialStore};
use mnt_financial_application::{
    AppendCostLedgerEntryCommand, CostLedgerSource, CreatePurchaseRequestCommand,
    CreateRentalQuoteCommand, ExecutePurchaseCommand, FinancialConfigSnapshot,
    PrepareExpenditureCommand, PurchaseApprovalCommand, PurchaseRestartCommand,
    PurchaseSubmitCommand, RejectPurchaseCommand,
};
use mnt_financial_domain::{MoneyInput, RentalQuoteInput, compute_rental_quote};
use mnt_kernel_core::{
    BranchId, BranchScope, EquipmentId, ErrorKind, EvidenceId, KernelError, OrgId,
    PurchaseRequestId, QuoteId, TraceContext, UserId, WorkOrderId,
};
use mnt_platform_auth::{AccessClaims, JwtVerifier};
use mnt_platform_authz::{Action, Feature, Principal, Role, authorize};
use mnt_platform_db::DbError;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone)]
pub struct FinancialRestState {
    store: PgFinancialStore,
    jwt_verifier: Option<JwtVerifier>,
}

impl FinancialRestState {
    #[must_use]
    pub fn new(store: PgFinancialStore, jwt_verifier: Option<JwtVerifier>) -> Self {
        Self {
            store,
            jwt_verifier,
        }
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
            "/api/v1/financial/purchase-requests/{purchase_request_id}",
            get(get_purchase_request),
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
    equipment_id: EquipmentId,
    work_order_id: Option<WorkOrderId>,
    statement_evidence_id: EvidenceId,
    vendor_name: String,
    amount_won: i64,
    memo: String,
    config: FinancialConfigSnapshot,
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
    statement_evidence_id: EvidenceId,
    amount_won: i64,
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
    let principal = principal_from_headers(&state, &headers)?;
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
    let principal = principal_from_headers(&state, &headers)?;
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
    let principal = principal_from_headers(&state, &headers)?;
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
    let principal = principal_from_headers(&state, &headers)?;
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
    let principal = principal_from_headers(&state, &headers)?;
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
    let principal = principal_from_headers(&state, &headers)?;
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
    let principal = principal_from_headers(&state, &headers)?;
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
            vendor_name: body.vendor_name,
            amount_won: body.amount_won,
            memo: body.memo,
            config: body.config,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok((StatusCode::CREATED, Json(purchase)))
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
    let principal = principal_from_headers(state, headers)?;
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

fn principal_from_headers(
    state: &FinancialRestState,
    headers: &HeaderMap,
) -> Result<Principal, RestError> {
    let verifier = state.jwt_verifier.as_ref().ok_or_else(|| {
        RestError::unavailable("JWT verification is not configured for financial API")
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
    let access_scope = claims
        .access_scope()
        .map_err(|_| RestError::unauthorized("token contains an invalid access scope"))?;
    Ok(Principal::new(user_id, org_id, roles, branch_scope).with_access_scope(access_scope))
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
