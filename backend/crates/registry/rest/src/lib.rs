//! Registry REST API.
//!
//! This layer handles JWT authentication, branch-scoped authorization, and
//! HTTP error mapping for equipment registry use cases. State-changing
//! substitute assignment operations remain in the Postgres adapter and route
//! through `with_audit`.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::collections::BTreeSet;
use std::str::FromStr;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use mnt_kernel_core::{BranchId, BranchScope, EquipmentId, ErrorKind, KernelError, UserId};
use mnt_platform_auth::{AccessClaims, JwtVerifier};
use mnt_platform_authz::{Action, Feature, Principal, Role, authorize};
use mnt_registry_adapter_postgres::{PgRegistryError, PgRegistryStore};
use mnt_registry_application::{SubstituteCandidate, SubstituteSearch};
use mnt_registry_domain::{EquipmentStatus, SubstituteMatchKind};
use serde::{Deserialize, Serialize};

pub const EQUIPMENT_SUBSTITUTES_PATH_TEMPLATE: &str = "/api/v1/equipment/{id}/substitutes";
pub const REGISTRY_ROUTE_PATHS: &[&str] = &[EQUIPMENT_SUBSTITUTES_PATH_TEMPLATE];

#[derive(Debug, Clone)]
pub struct RegistryRestState {
    store: PgRegistryStore,
    jwt_verifier: Option<JwtVerifier>,
}

impl RegistryRestState {
    #[must_use]
    pub fn new(store: PgRegistryStore, jwt_verifier: Option<JwtVerifier>) -> Self {
        Self {
            store,
            jwt_verifier,
        }
    }
}

pub fn router(state: RegistryRestState) -> Router {
    Router::new()
        .route(
            EQUIPMENT_SUBSTITUTES_PATH_TEMPLATE,
            get(list_equipment_substitutes),
        )
        .with_state(state)
}

#[derive(Debug, Deserialize)]
struct SubstituteQuery {
    all_branches: Option<bool>,
}

#[derive(Debug, Serialize)]
struct SubstituteCandidatePage {
    items: Vec<SubstituteCandidateResponse>,
    total: usize,
}

#[derive(Debug, Serialize)]
struct SubstituteCandidateResponse {
    equipment_id: EquipmentId,
    branch_id: BranchId,
    equipment_no: String,
    management_no: Option<String>,
    model: Option<String>,
    status: EquipmentStatus,
    specification: String,
    ton_text: String,
    ton_milli: Option<i32>,
    power_code: String,
    power_label: Option<String>,
    customer_name: String,
    site_name: String,
    placement_location: Option<String>,
    match_kind: SubstituteMatchKind,
    ton_delta_milli: Option<i32>,
}

async fn list_equipment_substitutes(
    State(state): State<RegistryRestState>,
    headers: HeaderMap,
    Path(equipment_id): Path<EquipmentId>,
    Query(query): Query<SubstituteQuery>,
) -> Result<Json<SubstituteCandidatePage>, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    authorize_read_access(&principal)?;
    let include_all_branches = query.all_branches.unwrap_or(false);
    if include_all_branches && !is_super_admin(&principal) {
        return Err(RestError::forbidden(
            "all_branches substitute search requires SUPER_ADMIN",
        ));
    }

    let items = state
        .store
        .substitute_candidates(SubstituteSearch {
            equipment_id,
            branch_scope: principal.branch_scope,
            include_all_branches,
        })
        .await
        .map_err(RestError::from_store)?
        .into_iter()
        .map(SubstituteCandidateResponse::from)
        .collect::<Vec<_>>();
    let total = items.len();

    Ok(Json(SubstituteCandidatePage { items, total }))
}

impl From<SubstituteCandidate> for SubstituteCandidateResponse {
    fn from(value: SubstituteCandidate) -> Self {
        Self {
            equipment_id: value.equipment_id,
            branch_id: value.branch_id,
            equipment_no: value.equipment_no.to_string(),
            management_no: value.management_no,
            model: value.model,
            status: value.status,
            specification: value.specification,
            ton_text: value.ton.as_text().to_owned(),
            ton_milli: value.ton.milli_tons(),
            power_code: value.power_code,
            power_label: value.power_label,
            customer_name: value.customer_name,
            site_name: value.site_name,
            placement_location: value.placement_location,
            match_kind: value.match_kind,
            ton_delta_milli: value.ton_delta_milli,
        }
    }
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

fn is_super_admin(principal: &Principal) -> bool {
    principal.roles.contains(&Role::SuperAdmin)
}

fn principal_from_headers(
    state: &RegistryRestState,
    headers: &HeaderMap,
) -> Result<Principal, RestError> {
    let verifier = state.jwt_verifier.as_ref().ok_or_else(|| {
        RestError::unavailable("JWT verification is not configured for registry API")
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

#[derive(Debug)]
struct RestError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl RestError {
    fn from_store(error: PgRegistryError) -> Self {
        match error {
            PgRegistryError::Domain(error) => Self::from_kernel(error),
            PgRegistryError::Db(_) | PgRegistryError::Workbook(_) => {
                Self::internal("registry request failed")
            }
        }
    }

    fn from_kernel(error: KernelError) -> Self {
        let status = match error.kind {
            ErrorKind::Validation => StatusCode::UNPROCESSABLE_ENTITY,
            ErrorKind::NotFound => StatusCode::NOT_FOUND,
            ErrorKind::Forbidden => StatusCode::FORBIDDEN,
            ErrorKind::Conflict | ErrorKind::InvalidTransition => StatusCode::CONFLICT,
            ErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        };
        Self {
            status,
            code: error_code(error.kind),
            message: error.message,
        }
    }

    fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "unauthorized",
            message: message.into(),
        }
    }

    fn forbidden(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            code: "forbidden",
            message: message.into(),
        }
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "unavailable",
            message: message.into(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "internal",
            message: message.into(),
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

#[derive(Debug, Serialize)]
struct ErrorBody {
    error: ErrorPayload,
}

#[derive(Debug, Serialize)]
struct ErrorPayload {
    code: &'static str,
    message: String,
}

fn error_code(kind: ErrorKind) -> &'static str {
    match kind {
        ErrorKind::Validation => "validation",
        ErrorKind::NotFound => "not_found",
        ErrorKind::Forbidden => "forbidden",
        ErrorKind::Conflict => "conflict",
        ErrorKind::InvalidTransition => "invalid_transition",
        ErrorKind::Internal => "internal",
    }
}
