//! Inspection REST API.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::collections::BTreeSet;
use std::str::FromStr;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use mnt_inspection_adapter_postgres::{PgInspectionError, PgInspectionStore};
use mnt_inspection_application::{
    CompleteInspectionRoundCommand, CreateInspectionScheduleCommand, ListInspectionSchedulesQuery,
};
use mnt_inspection_domain::{InspectionCycle, InspectionRoundOutcome};
use mnt_kernel_core::{
    BranchId, BranchScope, EquipmentId, ErrorKind, InspectionScheduleId, KernelError, TraceContext,
    UserId,
};
use mnt_platform_auth::{AccessClaims, JwtVerifier};
use mnt_platform_authz::{Action, Feature, Principal, Role, authorize};
use mnt_platform_db::DbError;
use serde::{Deserialize, Serialize};
use time::macros::format_description;
use time::{Date, OffsetDateTime};

pub const INSPECTION_SCHEDULES_PATH: &str = "/api/v1/inspections/schedules";
pub const INSPECTION_ROUNDS_PATH_TEMPLATE: &str =
    "/api/v1/inspections/schedules/{schedule_id}/rounds";
pub const INSPECTION_ROUTE_PATHS: &[&str] =
    &[INSPECTION_SCHEDULES_PATH, INSPECTION_ROUNDS_PATH_TEMPLATE];

#[derive(Debug, Clone)]
pub struct InspectionRestState {
    store: PgInspectionStore,
    jwt_verifier: Option<JwtVerifier>,
}

impl InspectionRestState {
    #[must_use]
    pub fn new(store: PgInspectionStore, jwt_verifier: Option<JwtVerifier>) -> Self {
        Self {
            store,
            jwt_verifier,
        }
    }
}

pub fn router(state: InspectionRestState) -> Router {
    Router::new()
        .route(
            INSPECTION_SCHEDULES_PATH,
            get(list_schedules).post(create_schedule),
        )
        .route(
            "/api/v1/inspections/schedules/{schedule_id}/rounds",
            post(complete_round),
        )
        .with_state(state)
}

#[derive(Debug, Deserialize)]
struct CreateScheduleRequest {
    branch_id: BranchId,
    equipment_id: EquipmentId,
    mechanic_id: UserId,
    cycle: InspectionCycle,
    interval_days: i32,
    due_date: Date,
    note: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CompleteRoundRequest {
    outcome: InspectionRoundOutcome,
    completed_at: Option<OffsetDateTime>,
    findings: String,
    note: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ListSchedulesRequest {
    due_start: String,
    due_end: String,
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

async fn create_schedule(
    State(state): State<InspectionRestState>,
    headers: HeaderMap,
    Json(body): Json<CreateScheduleRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    authorize(
        &principal,
        Action::new(Feature::InspectionScheduleManage),
        body.branch_id,
    )
    .map_err(RestError::from_kernel)?;
    let schedule = state
        .store
        .create_schedule(CreateInspectionScheduleCommand {
            actor: principal.user_id,
            branch_id: body.branch_id,
            equipment_id: body.equipment_id,
            mechanic_id: body.mechanic_id,
            cycle: body.cycle,
            interval_days: body.interval_days,
            due_date: body.due_date,
            note: body.note,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok((StatusCode::CREATED, Json(schedule)))
}

async fn list_schedules(
    State(state): State<InspectionRestState>,
    headers: HeaderMap,
    Query(query): Query<ListSchedulesRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    authorize(
        &principal,
        Action::new(Feature::InspectionScheduleManage),
        representative_branch(&principal.branch_scope)?,
    )
    .map_err(RestError::from_kernel)?;
    let schedules = state
        .store
        .list_due_schedules(ListInspectionSchedulesQuery {
            branch_scope: principal.branch_scope,
            due_start: parse_date(&query.due_start)?,
            due_end: parse_date(&query.due_end)?,
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(schedules))
}

async fn complete_round(
    State(state): State<InspectionRestState>,
    headers: HeaderMap,
    Path(schedule_id): Path<uuid::Uuid>,
    Json(body): Json<CompleteRoundRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    let schedule_id = InspectionScheduleId::from_uuid(schedule_id);
    let branch_id = state
        .store
        .schedule_branch_in_scope(schedule_id, &principal.branch_scope)
        .await
        .map_err(RestError::from_store)?;
    authorize(
        &principal,
        Action::new(Feature::InspectionRoundComplete),
        branch_id,
    )
    .map_err(RestError::from_kernel)?;
    let occurred_at = OffsetDateTime::now_utc();
    let round = state
        .store
        .complete_round(CompleteInspectionRoundCommand {
            actor: principal.user_id,
            schedule_id,
            outcome: body.outcome,
            completed_at: body.completed_at.unwrap_or(occurred_at),
            findings: body.findings,
            note: body.note,
            trace: TraceContext::generate(),
            occurred_at,
        })
        .await
        .map_err(RestError::from_store)?;
    Ok((StatusCode::CREATED, Json(round)))
}

fn parse_date(raw: &str) -> Result<Date, RestError> {
    let format = format_description!("[year]-[month]-[day]");
    Date::parse(raw, &format).map_err(|_| RestError::bad_request("date must use YYYY-MM-DD"))
}

fn representative_branch(branch_scope: &BranchScope) -> Result<BranchId, RestError> {
    match branch_scope {
        BranchScope::All => Ok(BranchId::new()),
        BranchScope::Branches(branches) => branches.iter().next().copied().ok_or_else(|| {
            RestError::from_kernel(KernelError::forbidden(
                "principal has no branch scope for inspection access",
            ))
        }),
    }
}

fn principal_from_headers(
    state: &InspectionRestState,
    headers: &HeaderMap,
) -> Result<Principal, RestError> {
    let verifier = state.jwt_verifier.as_ref().ok_or_else(|| {
        RestError::unavailable("JWT verification is not configured for inspection API")
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

    fn from_store(error: PgInspectionError) -> Self {
        match error {
            PgInspectionError::Domain(error) => Self::from_kernel(error),
            PgInspectionError::Db(error) => Self::from_db(error),
        }
    }

    fn from_db(error: DbError) -> Self {
        match error {
            DbError::Sqlx(sqlx::Error::RowNotFound) => {
                Self::from_kernel(KernelError::not_found("row was not found"))
            }
            DbError::Sqlx(sqlx::Error::Database(error))
                if error.code().is_some_and(|code| code == "23505") =>
            {
                Self::from_kernel(KernelError::conflict(error.message().to_owned()))
            }
            DbError::Sqlx(error) => Self::internal(error.to_string()),
            DbError::Serialize(error) => Self::internal(error.to_string()),
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
