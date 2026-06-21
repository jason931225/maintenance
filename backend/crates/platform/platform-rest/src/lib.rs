//! PLATFORM tier REST API — tenant onboarding and lifecycle.
//!
//! These routes live under `/platform/*` and are mounted behind the PLATFORM
//! extractor ([`mnt_platform_request_context::with_platform_context`]), NOT the
//! tenant org middleware. A TENANT token is rejected here (403) and a PLATFORM
//! token is rejected on the tenant `/api/*` routes — the two tiers are strictly
//! separated, so a tenant admin can never reach a platform endpoint.
//!
//! Every write is cross-tenant and audited to the TARGET org (so the action
//! shows in both the platform and the tenant's audit trail).
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch};
use axum::{Extension, Json, Router};
use mnt_platform_auth::JwtVerifier;
use mnt_platform_authz::{PlatformFeature, PlatformPrincipal};
use mnt_platform_provisioning::{
    OrganizationSummary, PlatformProvisioner, ProvisioningError, TenantHealth, TenantOnboarding,
};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

pub const PLATFORM_ORGS_PATH: &str = "/platform/orgs";
pub const PLATFORM_ORG_PATH_TEMPLATE: &str = "/platform/orgs/{id}";
pub const PLATFORM_OPS_PATH: &str = "/platform/ops";

#[derive(Clone)]
pub struct PlatformRestState {
    pool: PgPool,
    jwt_verifier: Option<JwtVerifier>,
    provisioner: PlatformProvisioner,
}

impl PlatformRestState {
    #[must_use]
    pub fn new(
        pool: PgPool,
        jwt_verifier: Option<JwtVerifier>,
        provisioner: PlatformProvisioner,
    ) -> Self {
        Self {
            pool,
            jwt_verifier,
            provisioner,
        }
    }
}

/// Build the `/platform/*` router behind the PLATFORM extractor.
pub fn router(state: PlatformRestState) -> Router {
    let verifier = state.jwt_verifier.clone();
    let router = Router::new()
        .route(PLATFORM_ORGS_PATH, get(list_orgs).post(create_org))
        .route(PLATFORM_ORG_PATH_TEMPLATE, patch(update_org))
        .route(PLATFORM_OPS_PATH, get(ops_dashboard))
        .with_state(state);
    // PLATFORM extractor: resolves the PlatformPrincipal and REJECTS any tenant
    // token. Deliberately NOT the tenant org middleware — the platform tier is
    // not tenant-scoped, and each handler arms the TARGET org per action.
    mnt_platform_request_context::with_platform_context(router, verifier)
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct CreateOrgRequest {
    slug: String,
    name: String,
}

#[derive(Debug, Serialize)]
struct OrgResponse {
    id: Uuid,
    slug: String,
    name: String,
    status: String,
    // `time::OffsetDateTime` derives a numeric-array Serialize by default; the
    // console reads these as rfc3339 strings (`new Date(created_at)`), so emit
    // rfc3339 like every other tenant DTO (e.g. financial `created_at`).
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    updated_at: OffsetDateTime,
}

impl From<OrganizationSummary> for OrgResponse {
    fn from(o: OrganizationSummary) -> Self {
        Self {
            id: o.id,
            slug: o.slug,
            name: o.name,
            status: o.status,
            created_at: o.created_at,
            updated_at: o.updated_at,
        }
    }
}

#[derive(Debug, Serialize)]
struct OnboardingResponse {
    // The console's `OnboardOrgResponse` reads `{ org, otp }`; keep those exact
    // field names so the one-time OTP and the new org actually surface in the UI.
    org: OrgResponse,
    admin_user_id: Uuid,
    /// The ONE-TIME OTP for the new tenant's first SUPER_ADMIN. Returned exactly
    /// once, to be delivered out-of-band; never logged or stored in cleartext.
    otp: String,
    #[serde(with = "time::serde::rfc3339")]
    admin_otp_expires_at: OffsetDateTime,
}

impl From<TenantOnboarding> for OnboardingResponse {
    fn from(o: TenantOnboarding) -> Self {
        Self {
            org: o.organization.into(),
            admin_user_id: o.admin_user_id,
            otp: o.admin_otp.as_str().to_owned(),
            admin_otp_expires_at: o.admin_otp_expires_at,
        }
    }
}

#[derive(Debug, Deserialize)]
struct UpdateOrgRequest {
    /// New tenant status: ACTIVE | SUSPENDED | ARCHIVED.
    status: String,
}

#[derive(Debug, Serialize)]
struct TenantHealthResponse {
    id: Uuid,
    slug: String,
    name: String,
    status: String,
    user_count: i64,
    active_user_count: i64,
    active_work_orders: i64,
    open_work_orders: i64,
    #[serde(with = "time::serde::rfc3339::option")]
    last_activity_at: Option<OffsetDateTime>,
}

impl From<TenantHealth> for TenantHealthResponse {
    fn from(h: TenantHealth) -> Self {
        Self {
            id: h.id,
            slug: h.slug,
            name: h.name,
            status: h.status,
            user_count: h.user_count,
            active_user_count: h.active_user_count,
            active_work_orders: h.active_work_orders,
            open_work_orders: h.open_work_orders,
            last_activity_at: h.last_activity_at,
        }
    }
}

#[derive(Debug, Serialize)]
struct PlatformOpsResponse {
    tenants: Vec<TenantHealthResponse>,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// POST /platform/orgs — onboard a NEW tenant (the only place org rows are
/// created by the app), seed its first SUPER_ADMIN, and return a one-time OTP.
async fn create_org(
    State(state): State<PlatformRestState>,
    Extension(principal): Extension<PlatformPrincipal>,
    Json(body): Json<CreateOrgRequest>,
) -> Result<Response, PlatformError> {
    principal
        .authorize(PlatformFeature::TenantCreate)
        .map_err(|_| PlatformError::forbidden("platform principal cannot create tenants"))?;

    let onboarding = state
        .provisioner
        .onboard_tenant(
            &state.pool,
            Some(principal.user_id),
            &body.slug,
            &body.name,
            OffsetDateTime::now_utc(),
        )
        .await
        .map_err(PlatformError::from_provisioning)?;

    Ok((
        StatusCode::CREATED,
        Json(OnboardingResponse::from(onboarding)),
    )
        .into_response())
}

/// GET /platform/orgs — list all tenants (cross-tenant, audited read).
async fn list_orgs(
    State(state): State<PlatformRestState>,
    Extension(principal): Extension<PlatformPrincipal>,
) -> Result<Response, PlatformError> {
    principal
        .authorize(PlatformFeature::TenantList)
        .map_err(|_| PlatformError::forbidden("platform principal cannot list tenants"))?;

    let orgs = state
        .provisioner
        .list_tenants(
            &state.pool,
            Some(principal.user_id),
            OffsetDateTime::now_utc(),
        )
        .await
        .map_err(PlatformError::from_provisioning)?;

    // The console's `listPlatformOrgs` reads a bare array, so return the orgs
    // directly rather than wrapping them in an envelope.
    let items: Vec<OrgResponse> = orgs.into_iter().map(OrgResponse::from).collect();
    Ok(Json(items).into_response())
}

/// GET /platform/ops — cross-tenant ops health rollup (audited platform read).
///
/// Aggregates per-tenant health/usage numbers for EVERY tenant via the
/// SECURITY DEFINER `platform_org_health()` function — the only sanctioned
/// cross-tenant path. The read is audited (`platform.tenant.health`); a tenant
/// token is rejected with 403 by the platform extractor before this runs.
async fn ops_dashboard(
    State(state): State<PlatformRestState>,
    Extension(principal): Extension<PlatformPrincipal>,
) -> Result<Response, PlatformError> {
    principal
        .authorize(PlatformFeature::TenantHealthRead)
        .map_err(|_| PlatformError::forbidden("platform principal cannot read tenant health"))?;

    let health = state
        .provisioner
        .list_tenant_health(
            &state.pool,
            Some(principal.user_id),
            OffsetDateTime::now_utc(),
        )
        .await
        .map_err(PlatformError::from_provisioning)?;

    let tenants = health.into_iter().map(TenantHealthResponse::from).collect();
    Ok(Json(PlatformOpsResponse { tenants }).into_response())
}

/// PATCH /platform/orgs/{id} — suspend / reactivate a tenant (audited).
async fn update_org(
    State(state): State<PlatformRestState>,
    Extension(principal): Extension<PlatformPrincipal>,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateOrgRequest>,
) -> Result<Response, PlatformError> {
    principal
        .authorize(PlatformFeature::TenantSuspend)
        .map_err(|_| PlatformError::forbidden("platform principal cannot change tenant status"))?;

    let org = state
        .provisioner
        .set_tenant_status(
            &state.pool,
            Some(principal.user_id),
            id,
            &body.status,
            OffsetDateTime::now_utc(),
        )
        .await
        .map_err(PlatformError::from_provisioning)?;

    Ok(Json(OrgResponse::from(org)).into_response())
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct PlatformError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl PlatformError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, "forbidden", message)
    }

    fn validation(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNPROCESSABLE_ENTITY, "validation", message)
    }

    fn from_provisioning(err: ProvisioningError) -> Self {
        match err {
            // Caller-facing input problems map to 422; everything else is logged
            // and collapsed to a generic 500 so no DB/constraint detail leaks.
            ProvisioningError::InvalidRoster(message) => Self::validation(message),
            ProvisioningError::ActiveBootstrapCredentialExists => Self::new(
                StatusCode::CONFLICT,
                "conflict",
                "tenant admin already has an active bootstrap credential",
            ),
            other => {
                tracing::error!(error = %other, "platform provisioning error");
                Self::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal",
                    "internal server error",
                )
            }
        }
    }
}

impl IntoResponse for PlatformError {
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

#[derive(Debug, Serialize)]
struct ErrorBody {
    error: ErrorPayload,
}

#[derive(Debug, Serialize)]
struct ErrorPayload {
    code: &'static str,
    message: String,
}
