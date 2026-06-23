//! REST API for the integrity / anomaly dashboard.
//!
//! Routes:
//!   GET  /api/v1/integrity/findings         — list findings (requires IntegrityFindingsRead)
//!   POST /api/v1/integrity/findings/{id}/triage — triage (requires IntegrityFindingTriage)
//!
//! Both routes require EXECUTIVE or SUPER_ADMIN. An ADMIN must NOT see findings
//! about themselves — enforcement is at the feature-matrix level (ADMIN = Deny).

use std::collections::BTreeSet;
use std::str::FromStr;

use axum::Json;
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use mnt_kernel_core::{BranchId, BranchScope, ErrorKind, KernelError, OrgId, TraceContext, UserId};
use mnt_platform_auth::{AccessClaims, JwtVerifier};
use mnt_platform_authz::{Action, Feature, Principal, Role, authorize};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::domain::{TriageFindingCommand, TriageTarget, validate_triage_memo};
use crate::store::{PgIntegrityError, PgIntegrityStore};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct IntegrityRestState {
    store: PgIntegrityStore,
    jwt_verifier: Option<JwtVerifier>,
}

impl IntegrityRestState {
    #[must_use]
    pub fn new(store: PgIntegrityStore, jwt_verifier: Option<JwtVerifier>) -> Self {
        Self {
            store,
            jwt_verifier,
        }
    }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn router(state: IntegrityRestState) -> Router {
    let verifier = state.jwt_verifier.clone();
    let pool = state.store.pool().clone();
    let router = Router::new()
        .route("/api/v1/integrity/findings", get(list_findings))
        .route(
            "/api/v1/integrity/findings/{id}/triage",
            post(triage_finding),
        )
        .with_state(state);
    mnt_platform_request_context::with_request_context(router, verifier, pool)
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// Query parameters for `GET /api/v1/integrity/findings`.
#[derive(Debug, Deserialize)]
struct FindingsQuery {
    /// Optional status filter: OPEN | REVIEWED | DISMISSED | ESCALATED.
    /// Omit to return all statuses.
    status: Option<String>,
}

async fn list_findings(
    State(state): State<IntegrityRestState>,
    headers: HeaderMap,
    Query(query): Query<FindingsQuery>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    authorize_integrity_read(&principal)?;

    let findings = state
        .store
        .list_findings(query.status.as_deref())
        .await
        .map_err(RestError::from_store)?;

    Ok(Json(findings))
}

/// Request body for `POST /api/v1/integrity/findings/{id}/triage`.
#[derive(Debug, Deserialize)]
struct TriageRequest {
    status: String,
    memo: Option<String>,
}

async fn triage_finding(
    State(state): State<IntegrityRestState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<TriageRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    authorize_integrity_triage(&principal)?;

    let new_status = parse_triage_target(&body.status)?;
    validate_triage_memo(new_status, &body.memo).map_err(RestError::from_kernel)?;

    let command = TriageFindingCommand {
        finding_id: id,
        reviewer: principal.user_id,
        new_status,
        memo: body.memo,
        occurred_at: time::OffsetDateTime::now_utc(),
        trace: TraceContext::generate(),
    };

    let finding = state
        .store
        .triage_finding(command)
        .await
        .map_err(RestError::from_store)?;

    Ok(Json(finding))
}

fn parse_triage_target(raw: &str) -> Result<TriageTarget, RestError> {
    match raw {
        "REVIEWED" => Ok(TriageTarget::Reviewed),
        "DISMISSED" => Ok(TriageTarget::Dismissed),
        "ESCALATED" => Ok(TriageTarget::Escalated),
        other => Err(RestError::from_kernel(KernelError::validation(format!(
            "invalid triage status {other:?}; expected REVIEWED, DISMISSED, or ESCALATED"
        )))),
    }
}

// ---------------------------------------------------------------------------
// Authorization helpers
// ---------------------------------------------------------------------------

/// Authorize for org-wide features (EXECUTIVE / SUPER_ADMIN).
/// Uses `representative_branch`: BranchScope::All → dummy BranchId, which
/// always passes the branch check for those roles.
fn authorize_integrity_read(principal: &Principal) -> Result<(), RestError> {
    let branch = representative_branch(principal)?;
    authorize(
        principal,
        Action::new(Feature::IntegrityFindingsRead),
        branch,
    )
    .map_err(RestError::from_kernel)
}

fn authorize_integrity_triage(principal: &Principal) -> Result<(), RestError> {
    let branch = representative_branch(principal)?;
    authorize(
        principal,
        Action::new(Feature::IntegrityFindingTriage),
        branch,
    )
    .map_err(RestError::from_kernel)
}

fn representative_branch(principal: &Principal) -> Result<BranchId, RestError> {
    match &principal.branch_scope {
        BranchScope::All => Ok(BranchId::new()),
        BranchScope::Branches(branches) => branches.iter().next().copied().ok_or_else(|| {
            RestError::from_kernel(KernelError::forbidden(
                "principal has no branch scope for integrity access",
            ))
        }),
    }
}

// ---------------------------------------------------------------------------
// Principal extraction (same pattern as compliance/financial REST)
// ---------------------------------------------------------------------------

fn principal_from_headers(
    state: &IntegrityRestState,
    headers: &HeaderMap,
) -> Result<Principal, RestError> {
    let verifier = state.jwt_verifier.as_ref().ok_or_else(|| {
        RestError::unavailable("JWT verification is not configured for integrity API")
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

// ---------------------------------------------------------------------------
// Error type (same shape as other REST crates)
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
            status: status_for_kind(error.kind),
            kind: error.kind,
            message: error.message,
        }
    }

    fn from_store(error: PgIntegrityError) -> Self {
        match error {
            PgIntegrityError::Domain(e) => Self::from_kernel(e),
            PgIntegrityError::Db(e) => Self::from_db(e),
        }
    }

    fn from_db(error: mnt_platform_db::DbError) -> Self {
        use mnt_platform_db::DbError;
        match error {
            DbError::Sqlx(sqlx::Error::RowNotFound) => {
                Self::from_kernel(KernelError::not_found("row was not found"))
            }
            DbError::Sqlx(err) => {
                tracing::error!(error = %err, "database error in integrity handler");
                Self {
                    status: StatusCode::INTERNAL_SERVER_ERROR,
                    kind: ErrorKind::Internal,
                    message: "internal server error".into(),
                }
            }
            DbError::Serialize(err) => {
                tracing::error!(error = %err, "serialization error in integrity handler");
                Self {
                    status: StatusCode::INTERNAL_SERVER_ERROR,
                    kind: ErrorKind::Internal,
                    message: "internal server error".into(),
                }
            }
        }
    }

    fn code(&self) -> &'static str {
        match self.kind {
            ErrorKind::Validation => "validation",
            ErrorKind::NotFound => "not_found",
            ErrorKind::Forbidden => "forbidden",
            ErrorKind::Conflict | ErrorKind::InvalidTransition => "conflict",
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

fn status_for_kind(kind: ErrorKind) -> StatusCode {
    match kind {
        ErrorKind::Validation => StatusCode::UNPROCESSABLE_ENTITY,
        ErrorKind::NotFound => StatusCode::NOT_FOUND,
        ErrorKind::Forbidden => StatusCode::FORBIDDEN,
        ErrorKind::Conflict | ErrorKind::InvalidTransition => StatusCode::CONFLICT,
        ErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
    }
}
