//! Authenticated logistics-pilot routes.  Every write has a distinct
//! capability grant; there is no inherited inventory or dispatch permission.
use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use mnt_kernel_core::{BranchId, BranchScope, ErrorKind, KernelError};
use mnt_logistics_adapter_postgres::{PgLogisticsError, PgLogisticsStore};
use mnt_platform_auth::JwtVerifier;
use mnt_platform_authz::{Action, Feature, Principal, authorize, authorize_org_wide};
use mnt_platform_request_context::RequestContextError;
use serde::Deserialize;
use serde_json::{Value, json};
use time::OffsetDateTime;
use uuid::Uuid;

pub const LOGISTICS_ROUTE_PATHS: &[&str] = &[
    "/api/v1/logistics/asns",
    "/api/v1/logistics/asns/{asn_id}/receipts",
    "/api/v1/logistics/asns/{asn_id}/putaway",
    "/api/v1/logistics/fulfillments",
    "/api/v1/logistics/fulfillments/{fulfillment_id}/pick",
    "/api/v1/logistics/fulfillments/{fulfillment_id}/pack",
];
#[derive(Clone)]
pub struct LogisticsRestState {
    store: PgLogisticsStore,
    jwt: Option<JwtVerifier>,
}
impl LogisticsRestState {
    #[must_use]
    pub fn new(store: PgLogisticsStore, jwt: Option<JwtVerifier>) -> Self {
        Self { store, jwt }
    }
}
pub fn router(state: LogisticsRestState) -> Router {
    let verifier = state.jwt.clone();
    let pool = state.store.pool().clone();
    let r = Router::new()
        .route("/api/v1/logistics/asns", post(create_asn))
        .route("/api/v1/logistics/asns/{asn_id}/receipts", post(receive))
        .route("/api/v1/logistics/asns/{asn_id}/putaway", post(putaway))
        .route("/api/v1/logistics/fulfillments", post(release))
        .route(
            "/api/v1/logistics/fulfillments/{fulfillment_id}/pick",
            post(pick),
        )
        .route(
            "/api/v1/logistics/fulfillments/{fulfillment_id}/pack",
            post(pack),
        )
        .with_state(state);
    mnt_platform_request_context::with_request_context(r, verifier, pool)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AsnBody {
    branch_id: Uuid,
    warehouse_code: String,
    external_reference: String,
    sku: String,
    expected_quantity: i64,
}
async fn create_asn(
    State(s): State<LogisticsRestState>,
    h: HeaderMap,
    Json(b): Json<AsnBody>,
) -> Result<(StatusCode, Json<Value>), RestError> {
    let p = principal(&s, &h).await?;
    allow(
        &p,
        Feature::LogisticsReceive,
        BranchId::from_uuid(b.branch_id),
    )?;
    Ok((
        StatusCode::CREATED,
        Json(
            s.store
                .create_asn(
                    p.user_id,
                    BranchId::from_uuid(b.branch_id),
                    b.warehouse_code,
                    b.external_reference,
                    b.sku,
                    b.expected_quantity,
                )
                .await
                .map_err(RestError::store)?,
        ),
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReceiptBody {
    branch_id: Uuid,
    received_quantity: i64,
}
async fn receive(
    State(s): State<LogisticsRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<ReceiptBody>,
) -> Result<Json<Value>, RestError> {
    let p = principal(&s, &h).await?;
    allow(
        &p,
        Feature::LogisticsReceive,
        BranchId::from_uuid(b.branch_id),
    )?;
    let key = idem_header(&h)?;
    let fingerprint = json!({"asnId":id,"receivedQuantity":b.received_quantity});
    Ok(Json(
        s.store
            .receive(p.user_id, id, b.received_quantity, key, &fingerprint)
            .await
            .map_err(RestError::store)?,
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BranchBody {
    branch_id: Uuid,
}
async fn putaway(
    State(s): State<LogisticsRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<BranchBody>,
) -> Result<Json<Value>, RestError> {
    let p = principal(&s, &h).await?;
    allow(
        &p,
        Feature::LogisticsPutaway,
        BranchId::from_uuid(b.branch_id),
    )?;
    Ok(Json(
        s.store
            .putaway(p.user_id, id)
            .await
            .map_err(RestError::store)?,
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReleaseBody {
    branch_id: Uuid,
    warehouse_code: String,
    sku: String,
    requested_quantity: i64,
    due_at: OffsetDateTime,
}
async fn release(
    State(s): State<LogisticsRestState>,
    h: HeaderMap,
    Json(b): Json<ReleaseBody>,
) -> Result<(StatusCode, Json<Value>), RestError> {
    let p = principal(&s, &h).await?;
    allow(
        &p,
        Feature::LogisticsRelease,
        BranchId::from_uuid(b.branch_id),
    )?;
    Ok((
        StatusCode::CREATED,
        Json(
            s.store
                .release(
                    p.user_id,
                    BranchId::from_uuid(b.branch_id),
                    b.warehouse_code,
                    b.sku,
                    b.requested_quantity,
                    b.due_at,
                )
                .await
                .map_err(RestError::store)?,
        ),
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PickBody {
    branch_id: Uuid,
    picked_quantity: i64,
}
async fn pick(
    State(s): State<LogisticsRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<PickBody>,
) -> Result<Json<Value>, RestError> {
    let p = principal(&s, &h).await?;
    allow(
        &p,
        Feature::LogisticsPickPack,
        BranchId::from_uuid(b.branch_id),
    )?;
    Ok(Json(
        s.store
            .pick_pack(p.user_id, id, Some(b.picked_quantity), false)
            .await
            .map_err(RestError::store)?,
    ))
}
async fn pack(
    State(s): State<LogisticsRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<BranchBody>,
) -> Result<Json<Value>, RestError> {
    let p = principal(&s, &h).await?;
    allow(
        &p,
        Feature::LogisticsPickPack,
        BranchId::from_uuid(b.branch_id),
    )?;
    Ok(Json(
        s.store
            .pick_pack(p.user_id, id, None, true)
            .await
            .map_err(RestError::store)?,
    ))
}
async fn principal(s: &LogisticsRestState, h: &HeaderMap) -> Result<Principal, RestError> {
    let verifier = s.jwt.as_ref().ok_or_else(|| {
        RestError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "JWT verification is not configured",
        )
    })?;
    mnt_platform_request_context::resolve_principal(verifier, s.store.pool(), h)
        .await
        .map_err(|e| match e {
            RequestContextError::MissingBearer
            | RequestContextError::InvalidToken
            | RequestContextError::InvalidClaim(_) => RestError::new(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "missing, malformed, or invalid bearer token",
            ),
            RequestContextError::WrongTokenTier | RequestContextError::AccessScope(_) => {
                RestError::kernel(KernelError::forbidden(
                    "token is not authorized for logistics",
                ))
            }
            RequestContextError::VerifierUnavailable => RestError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "unavailable",
                "JWT verification is not configured",
            ),
            RequestContextError::BranchScope(m) | RequestContextError::EffectivePolicy(m) => {
                RestError::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", m)
            }
            RequestContextError::MissingOrg => RestError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "no tenant context is bound",
            ),
        })
}
fn allow(p: &Principal, f: Feature, b: BranchId) -> Result<(), RestError> {
    let a = Action::new(f);
    match p.branch_scope {
        BranchScope::All => authorize_org_wide(p, a),
        _ => authorize(p, a, b),
    }
    .map_err(RestError::kernel)
}
fn idem_header(h: &HeaderMap) -> Result<String, RestError> {
    h.get("Idempotency-Key")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
        .ok_or_else(|| {
            RestError::kernel(KernelError::validation(
                "Idempotency-Key header is required",
            ))
        })
}
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
    fn kernel(e: KernelError) -> Self {
        match e.kind {
            ErrorKind::Validation => {
                Self::new(StatusCode::UNPROCESSABLE_ENTITY, "validation", e.message)
            }
            ErrorKind::NotFound => Self::new(StatusCode::NOT_FOUND, "not_found", e.message),
            ErrorKind::Forbidden => Self::new(StatusCode::FORBIDDEN, "forbidden", e.message),
            ErrorKind::Conflict | ErrorKind::InvalidTransition => {
                Self::new(StatusCode::CONFLICT, "conflict", e.message)
            }
            ErrorKind::Internal => {
                Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", e.message)
            }
        }
    }
    fn store(e: PgLogisticsError) -> Self {
        match e {
            PgLogisticsError::Domain(k) => Self::kernel(k),
            PgLogisticsError::Db(_) => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "internal server error",
            ),
        }
    }
}
impl IntoResponse for RestError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({"error":{"code":self.code,"message":self.message}})),
        )
            .into_response()
    }
}
