//! Tenant-scoped production-subcontracting pilot REST surface.
//!
//! This slice owns production plan persistence only. Customer demand, inventory,
//! people/staffing, approvals, ontology, and reporting remain external ports;
//! their identifiers and check snapshots are recorded here without copying any
//! source-domain records.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use mnt_kernel_core::{BranchId, ErrorKind, KernelError};
use mnt_platform_auth::JwtVerifier;
use mnt_platform_authz::{Action, Feature, Principal, authorize};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use time::OffsetDateTime;
use uuid::Uuid;

pub const PRODUCTION_PLANS_PATH: &str = "/api/v1/production/plans";
pub const PRODUCTION_PLAN_PATH: &str = "/api/v1/production/plans/{plan_id}";
pub const PRODUCTION_PLAN_RELEASE_PATH: &str = "/api/v1/production/plans/{plan_id}/release";
pub const PRODUCTION_OPERATION_RECORDS_PATH: &str =
    "/api/v1/production/plans/{plan_id}/operations/{operation_id}/records";
pub const PRODUCTION_ROUTE_PATHS: &[&str] = &[
    PRODUCTION_PLANS_PATH,
    PRODUCTION_PLAN_PATH,
    PRODUCTION_PLAN_RELEASE_PATH,
    PRODUCTION_OPERATION_RECORDS_PATH,
];

/// Boundaries deliberately kept as ports: callers provide only stable refs and
/// evaluated check outcomes; no customer/people/inventory/etc. table is joined.
pub trait CustomerDemandPort {
    fn demand_exists(&self, _demand_id: Uuid) -> bool;
}
pub trait CapacityMaterialStaffingPort {
    fn checks_current(&self, _branch_id: BranchId, _snapshot: &CheckSnapshot) -> bool;
}
pub trait ApprovalOntologyReportingPort {
    fn approval_and_lineage_allowed(&self, _approval_ref: Option<Uuid>) -> bool;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckSnapshot {
    pub capacity_ok: bool,
    pub material_ok: bool,
    pub staffing_ok: bool,
    pub capacity_reference: String,
    pub material_reference: String,
    pub staffing_reference: String,
}

impl CheckSnapshot {
    fn valid(&self) -> bool {
        self.capacity_ok
            && self.material_ok
            && self.staffing_ok
            && [
                &self.capacity_reference,
                &self.material_reference,
                &self.staffing_reference,
            ]
            .iter()
            .all(|value| !value.trim().is_empty() && value.len() <= 160)
    }
}

#[derive(Clone)]
pub struct ProductionRestState {
    pool: PgPool,
    jwt_verifier: Option<JwtVerifier>,
}
impl ProductionRestState {
    #[must_use]
    pub fn new(pool: PgPool, jwt_verifier: Option<JwtVerifier>) -> Self {
        Self { pool, jwt_verifier }
    }
}

pub fn router(state: ProductionRestState) -> Router {
    let verifier = state.jwt_verifier.clone();
    let pool = state.pool.clone();
    let router = Router::new()
        .route(PRODUCTION_PLANS_PATH, get(list_plans).post(create_plan))
        .route(PRODUCTION_PLAN_PATH, get(get_plan))
        .route(PRODUCTION_PLAN_RELEASE_PATH, post(release_plan))
        .route(PRODUCTION_OPERATION_RECORDS_PATH, post(record_operation))
        .with_state(state);
    mnt_platform_request_context::with_request_context(router, verifier, pool)
}

#[derive(Deserialize)]
struct ListQuery {
    branch_id: BranchId,
    #[serde(default = "default_limit")]
    limit: i64,
    #[serde(default)]
    offset: i64,
}
const fn default_limit() -> i64 {
    25
}
#[derive(Deserialize)]
struct CreatePlan {
    branch_id: BranchId,
    customer_demand_id: Uuid,
    product_code: String,
    quantity: i64,
    due_at: OffsetDateTime,
    checks: CheckSnapshot,
    idempotency_key: String,
    approval_ref: Option<Uuid>,
    ontology_type: String,
}
#[derive(Deserialize)]
struct ReleasePlan {
    expected_version: i32,
    idempotency_key: String,
}
#[derive(Deserialize)]
struct RecordOperation {
    expected_version: i32,
    idempotency_key: String,
    output_quantity: i64,
    scrap_quantity: i64,
    downtime_minutes: i32,
    quality_evidence_ref: String,
    quality_passed: bool,
    note: String,
}

#[derive(Serialize)]
struct PlanSummary {
    id: Uuid,
    branch_id: Uuid,
    customer_demand_id: Uuid,
    product_code: String,
    quantity: i64,
    status: String,
    version: i32,
    first_operation_id: Uuid,
    created_at: OffsetDateTime,
    due_at: OffsetDateTime,
}
#[derive(Serialize)]
struct PlanDetail {
    #[serde(flatten)]
    plan: PlanSummary,
    checks: serde_json::Value,
    events: Vec<LifecycleEvent>,
    operation: OperationDetail,
}
#[derive(Serialize)]
struct LifecycleEvent {
    id: Uuid,
    event_type: String,
    actor_id: Uuid,
    payload: serde_json::Value,
    occurred_at: OffsetDateTime,
}
#[derive(Serialize)]
struct OperationDetail {
    id: Uuid,
    sequence: i32,
    status: String,
    output_quantity: i64,
    scrap_quantity: i64,
    downtime_minutes: i32,
    quality_evidence_ref: Option<String>,
    quality_passed: Option<bool>,
    version: i32,
}

async fn list_plans(
    State(state): State<ProductionRestState>,
    headers: HeaderMap,
    Query(query): Query<ListQuery>,
) -> Result<Json<Vec<PlanSummary>>, RestError> {
    if !(1..=100).contains(&query.limit) || query.offset < 0 {
        return Err(RestError::validation(
            "limit must be 1..100 and offset must be non-negative",
        ));
    }
    let principal = principal(&state, &headers).await?;
    authorize(
        &principal,
        Action::limited(Feature::WorkOrderReadAll),
        query.branch_id,
    )
    .map_err(RestError::kernel)?;
    let org = mnt_platform_request_context::current_org()
        .map_err(|_| RestError::internal("tenant context is missing"))?;
    let mut tx = state.pool.begin().await.map_err(RestError::db)?;
    arm_tenant(&mut tx, *org.as_uuid()).await?;
    let rows = sqlx::query("SELECT id, branch_id, customer_demand_id, product_code, quantity, status, version, first_operation_id, created_at, due_at FROM production_plans WHERE branch_id=$1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3")
        .bind(*query.branch_id.as_uuid()).bind(query.limit).bind(query.offset).fetch_all(&mut *tx).await.map_err(RestError::db)?;
    tx.commit().await.map_err(RestError::db)?;
    Ok(Json(
        rows.into_iter()
            .map(plan_summary)
            .collect::<Result<_, _>>()?,
    ))
}

async fn create_plan(
    State(state): State<ProductionRestState>,
    headers: HeaderMap,
    Json(request): Json<CreatePlan>,
) -> Result<(StatusCode, Json<PlanSummary>), RestError> {
    validate_create(&request)?;
    let principal = principal(&state, &headers).await?;
    authorize(
        &principal,
        Action::limited(Feature::DailyPlanRequest),
        request.branch_id,
    )
    .map_err(RestError::kernel)?;
    let org = mnt_platform_request_context::current_org()
        .map_err(|_| RestError::internal("tenant context is missing"))?;
    let mut tx = state.pool.begin().await.map_err(RestError::db)?;
    arm_tenant(&mut tx, *org.as_uuid()).await?;
    let existing = sqlx::query("SELECT id, branch_id, customer_demand_id, product_code, quantity, status, version, first_operation_id, created_at, due_at FROM production_plans WHERE org_id=$1 AND idempotency_key=$2")
        .bind(*org.as_uuid()).bind(request.idempotency_key.trim()).fetch_optional(&mut *tx).await.map_err(RestError::db)?;
    if let Some(row) = existing {
        tx.commit().await.map_err(RestError::db)?;
        return Ok((StatusCode::OK, Json(plan_summary(row)?)));
    }
    let plan_id = Uuid::new_v4();
    let operation_id = Uuid::new_v4();
    let now = OffsetDateTime::now_utc();
    let checks = serde_json::to_value(&request.checks)
        .map_err(|_| RestError::internal("could not encode check snapshot"))?;
    sqlx::query("INSERT INTO production_plans (id, org_id, branch_id, customer_demand_id, product_code, quantity, due_at, checks, idempotency_key, approval_ref, ontology_type, first_operation_id, created_by, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)")
        .bind(plan_id).bind(*org.as_uuid()).bind(*request.branch_id.as_uuid()).bind(request.customer_demand_id).bind(request.product_code.trim()).bind(request.quantity).bind(request.due_at).bind(checks.clone()).bind(request.idempotency_key.trim()).bind(request.approval_ref).bind(request.ontology_type.trim()).bind(operation_id).bind(*principal.user_id.as_uuid()).bind(now).execute(&mut *tx).await.map_err(RestError::db)?;
    sqlx::query("INSERT INTO production_operations (id, org_id, plan_id, sequence, status) VALUES ($1,$2,$3,1,'PENDING')").bind(operation_id).bind(*org.as_uuid()).bind(plan_id).execute(&mut *tx).await.map_err(RestError::db)?;
    event(&mut tx, *org.as_uuid(), plan_id, principal.user_id.as_uuid(), "PLAN_CREATED", serde_json::json!({"checks": checks, "customer_demand_id": request.customer_demand_id, "ontology_type": request.ontology_type})).await?;
    tx.commit().await.map_err(RestError::db)?;
    let plan = plan_for_auth(&state.pool, plan_id).await?;
    Ok((StatusCode::CREATED, Json(plan_summary_from_plan(&plan))))
}

async fn release_plan(
    State(state): State<ProductionRestState>,
    headers: HeaderMap,
    Path(plan_id): Path<Uuid>,
    Json(request): Json<ReleasePlan>,
) -> Result<Json<PlanSummary>, RestError> {
    valid_key(&request.idempotency_key)?;
    let principal = principal(&state, &headers).await?;
    let plan = plan_for_auth(&state.pool, plan_id).await?;
    authorize(
        &principal,
        Action::limited(Feature::DailyPlanReview),
        BranchId::from_uuid(plan.branch_id),
    )
    .map_err(RestError::kernel)?;
    let org = mnt_platform_request_context::current_org()
        .map_err(|_| RestError::internal("tenant context is missing"))?;
    let mut tx = state.pool.begin().await.map_err(RestError::db)?;
    arm_tenant(&mut tx, *org.as_uuid()).await?;
    let duplicate =
        sqlx::query("SELECT 1 FROM production_plan_events WHERE plan_id=$1 AND idempotency_key=$2")
            .bind(plan_id)
            .bind(request.idempotency_key.trim())
            .fetch_optional(&mut *tx)
            .await
            .map_err(RestError::db)?;
    if duplicate.is_none() {
        let updated = sqlx::query("UPDATE production_plans SET status='RELEASED', version=version+1, updated_at=now(), released_at=now(), released_by=$1 WHERE id=$2 AND status='DRAFT' AND version=$3").bind(*principal.user_id.as_uuid()).bind(plan_id).bind(request.expected_version).execute(&mut *tx).await.map_err(RestError::db)?;
        if updated.rows_affected() != 1 {
            return Err(RestError::conflict(
                "plan release conflicts with current lifecycle or version",
            ));
        }
        sqlx::query("UPDATE production_operations SET status='RELEASED', version=version+1 WHERE id=$1 AND status='PENDING'").bind(plan.first_operation_id).execute(&mut *tx).await.map_err(RestError::db)?;
        event_with_key(
            &mut tx,
            *org.as_uuid(),
            plan_id,
            principal.user_id.as_uuid(),
            "PLAN_RELEASED",
            serde_json::json!({"version": request.expected_version + 1}),
            request.idempotency_key.trim(),
        )
        .await?;
    }
    tx.commit().await.map_err(RestError::db)?;
    let plan = plan_for_auth(&state.pool, plan_id).await?;
    Ok(Json(plan_summary_from_plan(&plan)))
}

async fn record_operation(
    State(state): State<ProductionRestState>,
    headers: HeaderMap,
    Path((plan_id, operation_id)): Path<(Uuid, Uuid)>,
    Json(request): Json<RecordOperation>,
) -> Result<Json<OperationDetail>, RestError> {
    valid_key(&request.idempotency_key)?;
    if request.output_quantity < 0
        || request.scrap_quantity < 0
        || request.downtime_minutes < 0
        || request.note.len() > 500
        || request.quality_evidence_ref.trim().is_empty()
    {
        return Err(RestError::validation(
            "operation quantities must be non-negative and quality evidence is required",
        ));
    }
    let principal = principal(&state, &headers).await?;
    let plan = plan_for_auth(&state.pool, plan_id).await?;
    authorize(
        &principal,
        Action::limited(Feature::WorkReportSubmit),
        BranchId::from_uuid(plan.branch_id),
    )
    .map_err(RestError::kernel)?;
    let org = mnt_platform_request_context::current_org()
        .map_err(|_| RestError::internal("tenant context is missing"))?;
    let mut tx = state.pool.begin().await.map_err(RestError::db)?;
    arm_tenant(&mut tx, *org.as_uuid()).await?;
    let duplicate =
        sqlx::query("SELECT 1 FROM production_plan_events WHERE plan_id=$1 AND idempotency_key=$2")
            .bind(plan_id)
            .bind(request.idempotency_key.trim())
            .fetch_optional(&mut *tx)
            .await
            .map_err(RestError::db)?;
    if duplicate.is_none() {
        let updated = sqlx::query("UPDATE production_operations SET output_quantity=output_quantity+$1, scrap_quantity=scrap_quantity+$2, downtime_minutes=downtime_minutes+$3, quality_evidence_ref=$4, quality_passed=$5, status='RECORDED', version=version+1 WHERE id=$6 AND plan_id=$7 AND status='RELEASED' AND version=$8").bind(request.output_quantity).bind(request.scrap_quantity).bind(request.downtime_minutes).bind(request.quality_evidence_ref.trim()).bind(request.quality_passed).bind(operation_id).bind(plan_id).bind(request.expected_version).execute(&mut *tx).await.map_err(RestError::db)?;
        if updated.rows_affected() != 1 {
            return Err(RestError::conflict(
                "operation record conflicts with current lifecycle or version",
            ));
        }
        event_with_key(&mut tx, *org.as_uuid(), plan_id, principal.user_id.as_uuid(), "OPERATION_RECORDED", serde_json::json!({"operation_id": operation_id, "output_quantity": request.output_quantity, "scrap_quantity": request.scrap_quantity, "downtime_minutes": request.downtime_minutes, "quality_evidence_ref": request.quality_evidence_ref, "quality_passed": request.quality_passed, "note": request.note}), request.idempotency_key.trim()).await?;
    }
    tx.commit().await.map_err(RestError::db)?;
    operation_detail(&state.pool, operation_id).await.map(Json)
}

async fn get_plan(
    State(state): State<ProductionRestState>,
    headers: HeaderMap,
    Path(plan_id): Path<Uuid>,
) -> Result<Json<PlanDetail>, RestError> {
    let principal = principal(&state, &headers).await?;
    let plan = plan_for_auth(&state.pool, plan_id).await?;
    authorize(
        &principal,
        Action::limited(Feature::WorkOrderReadAll),
        BranchId::from_uuid(plan.branch_id),
    )
    .map_err(RestError::kernel)?;
    let org = mnt_platform_request_context::current_org()
        .map_err(|_| RestError::internal("tenant context is missing"))?;
    let mut tx = state.pool.begin().await.map_err(RestError::db)?;
    arm_tenant(&mut tx, *org.as_uuid()).await?;
    let events = sqlx::query("SELECT id,event_type,actor_id,payload,occurred_at FROM production_plan_events WHERE plan_id=$1 ORDER BY occurred_at,id").bind(plan_id).fetch_all(&mut *tx).await.map_err(RestError::db)?.into_iter().map(|row| Ok(LifecycleEvent{id:row.try_get("id")?,event_type:row.try_get("event_type")?,actor_id:row.try_get("actor_id")?,payload:row.try_get("payload")?,occurred_at:row.try_get("occurred_at")?})).collect::<Result<Vec<_>,sqlx::Error>>().map_err(RestError::db)?;
    tx.commit().await.map_err(RestError::db)?;
    Ok(Json(PlanDetail {
        plan: PlanSummary {
            id: plan.id,
            branch_id: plan.branch_id,
            customer_demand_id: plan.customer_demand_id,
            product_code: plan.product_code,
            quantity: plan.quantity,
            status: plan.status,
            version: plan.version,
            first_operation_id: plan.first_operation_id,
            created_at: plan.created_at,
            due_at: plan.due_at,
        },
        checks: plan.checks,
        events,
        operation: operation_detail(&state.pool, plan.first_operation_id).await?,
    }))
}

struct PlanRow {
    id: Uuid,
    branch_id: Uuid,
    customer_demand_id: Uuid,
    product_code: String,
    quantity: i64,
    status: String,
    version: i32,
    first_operation_id: Uuid,
    created_at: OffsetDateTime,
    due_at: OffsetDateTime,
    checks: serde_json::Value,
}
async fn plan_for_auth(pool: &PgPool, id: Uuid) -> Result<PlanRow, RestError> {
    let org = mnt_platform_request_context::current_org()
        .map_err(|_| RestError::internal("tenant context is missing"))?;
    let mut tx = pool.begin().await.map_err(RestError::db)?;
    arm_tenant(&mut tx, *org.as_uuid()).await?;
    let r=sqlx::query("SELECT id,branch_id,customer_demand_id,product_code,quantity,status,version,first_operation_id,created_at,due_at,checks FROM production_plans WHERE id=$1").bind(id).fetch_optional(&mut *tx).await.map_err(RestError::db)?.ok_or_else(||RestError::not_found("production plan not found"))?;
    tx.commit().await.map_err(RestError::db)?;
    Ok(PlanRow {
        id: r.try_get("id").map_err(RestError::db)?,
        branch_id: r.try_get("branch_id").map_err(RestError::db)?,
        customer_demand_id: r.try_get("customer_demand_id").map_err(RestError::db)?,
        product_code: r.try_get("product_code").map_err(RestError::db)?,
        quantity: r.try_get("quantity").map_err(RestError::db)?,
        status: r.try_get("status").map_err(RestError::db)?,
        version: r.try_get("version").map_err(RestError::db)?,
        first_operation_id: r.try_get("first_operation_id").map_err(RestError::db)?,
        created_at: r.try_get("created_at").map_err(RestError::db)?,
        due_at: r.try_get("due_at").map_err(RestError::db)?,
        checks: r.try_get("checks").map_err(RestError::db)?,
    })
}
async fn operation_detail(pool: &PgPool, id: Uuid) -> Result<OperationDetail, RestError> {
    let org = mnt_platform_request_context::current_org()
        .map_err(|_| RestError::internal("tenant context is missing"))?;
    let mut tx = pool.begin().await.map_err(RestError::db)?;
    arm_tenant(&mut tx, *org.as_uuid()).await?;
    let r=sqlx::query("SELECT id,sequence,status,output_quantity,scrap_quantity,downtime_minutes,quality_evidence_ref,quality_passed,version FROM production_operations WHERE id=$1").bind(id).fetch_one(&mut *tx).await.map_err(RestError::db)?;
    tx.commit().await.map_err(RestError::db)?;
    Ok(OperationDetail {
        id: r.try_get("id").map_err(RestError::db)?,
        sequence: r.try_get("sequence").map_err(RestError::db)?,
        status: r.try_get("status").map_err(RestError::db)?,
        output_quantity: r.try_get("output_quantity").map_err(RestError::db)?,
        scrap_quantity: r.try_get("scrap_quantity").map_err(RestError::db)?,
        downtime_minutes: r.try_get("downtime_minutes").map_err(RestError::db)?,
        quality_evidence_ref: r.try_get("quality_evidence_ref").map_err(RestError::db)?,
        quality_passed: r.try_get("quality_passed").map_err(RestError::db)?,
        version: r.try_get("version").map_err(RestError::db)?,
    })
}
fn plan_summary(r: sqlx::postgres::PgRow) -> Result<PlanSummary, RestError> {
    Ok(PlanSummary {
        id: r.try_get("id").map_err(RestError::db)?,
        branch_id: r.try_get("branch_id").map_err(RestError::db)?,
        customer_demand_id: r.try_get("customer_demand_id").map_err(RestError::db)?,
        product_code: r.try_get("product_code").map_err(RestError::db)?,
        quantity: r.try_get("quantity").map_err(RestError::db)?,
        status: r.try_get("status").map_err(RestError::db)?,
        version: r.try_get("version").map_err(RestError::db)?,
        first_operation_id: r.try_get("first_operation_id").map_err(RestError::db)?,
        created_at: r.try_get("created_at").map_err(RestError::db)?,
        due_at: r.try_get("due_at").map_err(RestError::db)?,
    })
}
fn plan_summary_from_plan(plan: &PlanRow) -> PlanSummary {
    PlanSummary {
        id: plan.id,
        branch_id: plan.branch_id,
        customer_demand_id: plan.customer_demand_id,
        product_code: plan.product_code.clone(),
        quantity: plan.quantity,
        status: plan.status.clone(),
        version: plan.version,
        first_operation_id: plan.first_operation_id,
        created_at: plan.created_at,
        due_at: plan.due_at,
    }
}
async fn event(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: Uuid,
    plan: Uuid,
    actor: &Uuid,
    kind: &str,
    payload: serde_json::Value,
) -> Result<(), RestError> {
    event_with_key(
        tx,
        org,
        plan,
        actor,
        kind,
        payload,
        &Uuid::new_v4().to_string(),
    )
    .await
}
async fn event_with_key(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: Uuid,
    plan: Uuid,
    actor: &Uuid,
    kind: &str,
    payload: serde_json::Value,
    key: &str,
) -> Result<(), RestError> {
    sqlx::query("INSERT INTO production_plan_events (id,org_id,plan_id,event_type,actor_id,payload,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7)").bind(Uuid::new_v4()).bind(org).bind(plan).bind(kind).bind(actor).bind(payload).bind(key).execute(&mut **tx).await.map_err(RestError::db)?;
    Ok(())
}
async fn arm_tenant(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: Uuid,
) -> Result<(), RestError> {
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.to_string())
        .execute(&mut **tx)
        .await
        .map_err(RestError::db)?;
    Ok(())
}
fn validate_create(r: &CreatePlan) -> Result<(), RestError> {
    valid_key(&r.idempotency_key)?;
    if r.product_code.trim().is_empty()
        || r.product_code.len() > 80
        || r.quantity <= 0
        || !r.checks.valid()
        || r.ontology_type.trim().is_empty()
    {
        return Err(RestError::validation(
            "product, positive quantity, complete checks, and ontology type are required",
        ));
    }
    Ok(())
}
fn valid_key(k: &str) -> Result<(), RestError> {
    if k.trim().is_empty() || k.len() > 128 {
        Err(RestError::validation(
            "idempotency_key is required and must be at most 128 characters",
        ))
    } else {
        Ok(())
    }
}
async fn principal(
    state: &ProductionRestState,
    headers: &HeaderMap,
) -> Result<Principal, RestError> {
    let verifier = state
        .jwt_verifier
        .as_ref()
        .ok_or_else(|| RestError::internal("JWT verification is not configured"))?;
    mnt_platform_request_context::resolve_principal(verifier, &state.pool, headers)
        .await
        .map_err(|_| RestError::unauthorized("missing, invalid, or unauthorized bearer token"))
}
#[derive(Debug)]
struct RestError {
    status: StatusCode,
    kind: ErrorKind,
    message: String,
}
impl RestError {
    fn validation(m: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            kind: ErrorKind::Validation,
            message: m.into(),
        }
    }
    fn unauthorized(m: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            kind: ErrorKind::Forbidden,
            message: m.into(),
        }
    }
    fn internal(m: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            kind: ErrorKind::Internal,
            message: m.into(),
        }
    }
    fn not_found(m: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            kind: ErrorKind::NotFound,
            message: m.into(),
        }
    }
    fn conflict(m: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            kind: ErrorKind::Conflict,
            message: m.into(),
        }
    }
    fn kernel(e: KernelError) -> Self {
        Self {
            status: match e.kind {
                ErrorKind::Forbidden => StatusCode::FORBIDDEN,
                ErrorKind::NotFound => StatusCode::NOT_FOUND,
                ErrorKind::Conflict => StatusCode::CONFLICT,
                ErrorKind::Validation => StatusCode::UNPROCESSABLE_ENTITY,
                _ => StatusCode::INTERNAL_SERVER_ERROR,
            },
            kind: e.kind,
            message: e.message,
        }
    }
    fn db(e: sqlx::Error) -> Self {
        if matches!(e, sqlx::Error::RowNotFound) {
            Self::not_found("production record not found")
        } else {
            Self::internal("production persistence failed")
        }
    }
}
impl IntoResponse for RestError {
    fn into_response(self) -> Response {
        (self.status,Json(serde_json::json!({"error":{"code":format!("{:?}",self.kind).to_lowercase(),"message":self.message}}))).into_response()
    }
}
