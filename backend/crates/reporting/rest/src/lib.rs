//! Reporting REST API.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::collections::BTreeSet;
use std::str::FromStr;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use mnt_kernel_core::{
    BranchId, BranchScope, ErrorKind, KernelError, OrgId, RegionId, TraceContext, UserId,
};
use mnt_platform_auth::{AccessClaims, JwtVerifier};
use mnt_platform_authz::{Action, Feature, Principal, Role, authorize};
use mnt_reporting_adapter_postgres::PgKpiRepository;
use mnt_reporting_application::{
    KpiQuery, KpiQueryError, KpiQueryPort, KpiScope, OpsSummaryPort, OpsSummaryQuery, Period,
    ReportingExportError, ReportingExportPort, ReportingExportQuery, WorkDiaryBody,
    WorkDiaryConfirmCommand, WorkDiaryDraft, WorkDiaryDraftPort, WorkDiaryQuery,
    WorkDiaryUpdateCommand,
};
use serde::{Deserialize, Serialize};
use time::macros::format_description;
use time::{Date, Time};

pub const KPI_PATH: &str = "/api/v1/kpi";
pub const OPS_SUMMARY_PATH: &str = "/api/v1/ops/summary";
pub const DAILY_STATUS_EXPORT_PATH: &str = "/api/v1/exports/daily-status";
pub const WORK_DIARY_EXPORT_PATH: &str = "/api/v1/exports/work-diary";
pub const WORK_DIARY_PATH: &str = "/api/v1/reporting/work-diary";
pub const WORK_DIARY_CONFIRM_PATH: &str = "/api/v1/reporting/work-diary/confirm";
pub const KPI_ROUTE_PATHS: &[&str] = &[
    KPI_PATH,
    OPS_SUMMARY_PATH,
    DAILY_STATUS_EXPORT_PATH,
    WORK_DIARY_EXPORT_PATH,
    WORK_DIARY_PATH,
    WORK_DIARY_CONFIRM_PATH,
];

/// Aging threshold (hours) past which an unresolved work order is "aging".
const OPS_AGING_HOURS: u32 = 24;
/// Lead time (minutes) before a P1 accept-window deadline to flag "at risk".
const OPS_AT_RISK_MINUTES: u32 = 5;
/// Cap on the mechanic-utilization list.
const OPS_TOP_MECHANICS: u32 = 10;

#[derive(Debug, Clone)]
pub struct KpiRestState {
    repository: PgKpiRepository,
    jwt_verifier: Option<JwtVerifier>,
}

impl KpiRestState {
    #[must_use]
    pub fn new(repository: PgKpiRepository, jwt_verifier: Option<JwtVerifier>) -> Self {
        Self {
            repository,
            jwt_verifier,
        }
    }
}

pub fn router(state: KpiRestState) -> Router {
    let verifier = state.jwt_verifier.clone();
    let pool = state.repository.pool().clone();
    let router = Router::new()
        .route(KPI_PATH, get(get_kpis))
        .route(OPS_SUMMARY_PATH, get(get_ops_summary))
        .route(DAILY_STATUS_EXPORT_PATH, get(get_daily_status_export))
        .route(WORK_DIARY_EXPORT_PATH, get(get_work_diary_export))
        .route(WORK_DIARY_PATH, get(get_work_diary).put(update_work_diary))
        .route(WORK_DIARY_CONFIRM_PATH, post(confirm_work_diary))
        .with_state(state);
    mnt_platform_request_context::with_request_context(router, verifier, pool)
}

#[derive(Debug, Deserialize)]
struct KpiRequestQuery {
    period: String,
    scope: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DateRequestQuery {
    date: String,
}

#[derive(Debug, Deserialize)]
struct WorkDiaryUpdateRequest {
    body: WorkDiaryBody,
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

    fn from_query(error: KpiQueryError) -> Self {
        match error {
            KpiQueryError::Kernel(error) => Self::from_kernel(error),
            KpiQueryError::Database(message) => Self::internal(message),
        }
    }

    fn from_export(error: ReportingExportError) -> Self {
        match error {
            ReportingExportError::Kernel(error) => Self::from_kernel(error),
            ReportingExportError::Database(message) | ReportingExportError::Workbook(message) => {
                Self::internal(message)
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

async fn get_kpis(
    State(state): State<KpiRestState>,
    headers: HeaderMap,
    Query(params): Query<KpiRequestQuery>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    let period = parse_period(&params.period)?;
    let scope = parse_scope(params.scope.as_deref())?;
    authorize(
        &principal,
        Action::new(Feature::KpiRead),
        authorization_branch(&principal, scope)?,
    )
    .map_err(RestError::from_kernel)?;

    let report = state
        .repository
        .query_kpis(KpiQuery {
            period,
            scope,
            branch_scope: principal.branch_scope,
        })
        .await
        .map_err(RestError::from_query)?;

    Ok(Json(report))
}

/// GET /api/v1/ops/summary — per-tenant operational rollup (SUPER_ADMIN/ADMIN).
///
/// Org-scoped under RLS: every aggregate is computed inside
/// `with_org_conn(current_org())`, so a second tenant's rows are never counted.
async fn get_ops_summary(
    State(state): State<KpiRestState>,
    headers: HeaderMap,
) -> Result<Json<mnt_reporting_application::OpsSummary>, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    authorize(
        &principal,
        Action::new(Feature::OpsDashboardRead),
        representative_branch(&principal.branch_scope)?,
    )
    .map_err(RestError::from_kernel)?;

    let summary = state
        .repository
        .ops_summary(OpsSummaryQuery {
            aging_hours: OPS_AGING_HOURS,
            at_risk_minutes: OPS_AT_RISK_MINUTES,
            top_mechanics: OPS_TOP_MECHANICS,
        })
        .await
        .map_err(RestError::from_query)?;

    Ok(Json(summary))
}

async fn get_daily_status_export(
    State(state): State<KpiRestState>,
    headers: HeaderMap,
    Query(params): Query<DateRequestQuery>,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    let date = parse_date(&params.date)?;
    authorize_reporting_feature(&principal, Feature::ExcelDownload)?;
    let workbook = state
        .repository
        .export_daily_status(export_query(&principal, date))
        .await
        .map_err(RestError::from_export)?;
    workbook_response(workbook.file_name, workbook.content_type, workbook.bytes)
}

async fn get_work_diary_export(
    State(state): State<KpiRestState>,
    headers: HeaderMap,
    Query(params): Query<DateRequestQuery>,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    let date = parse_date(&params.date)?;
    authorize_reporting_feature(&principal, Feature::ExcelDownload)?;
    let workbook = state
        .repository
        .export_work_diary(export_query(&principal, date))
        .await
        .map_err(RestError::from_export)?;
    workbook_response(workbook.file_name, workbook.content_type, workbook.bytes)
}

async fn get_work_diary(
    State(state): State<KpiRestState>,
    headers: HeaderMap,
    Query(params): Query<DateRequestQuery>,
) -> Result<Json<WorkDiaryDraft>, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    let date = parse_date(&params.date)?;
    authorize_reporting_feature(&principal, Feature::DailyPlanReview)?;
    let draft = state
        .repository
        .get_or_generate_work_diary(WorkDiaryQuery {
            actor: principal.user_id,
            date,
            branch_scope: principal.branch_scope,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_export)?;
    Ok(Json(draft))
}

async fn update_work_diary(
    State(state): State<KpiRestState>,
    headers: HeaderMap,
    Query(params): Query<DateRequestQuery>,
    Json(body): Json<WorkDiaryUpdateRequest>,
) -> Result<Json<WorkDiaryDraft>, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    let date = parse_date(&params.date)?;
    authorize_reporting_feature(&principal, Feature::DailyPlanReview)?;
    let draft = state
        .repository
        .update_work_diary(WorkDiaryUpdateCommand {
            actor: principal.user_id,
            date,
            branch_scope: principal.branch_scope,
            body: body.body,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_export)?;
    Ok(Json(draft))
}

async fn confirm_work_diary(
    State(state): State<KpiRestState>,
    headers: HeaderMap,
    Query(params): Query<DateRequestQuery>,
) -> Result<Json<WorkDiaryDraft>, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    let date = parse_date(&params.date)?;
    authorize_reporting_feature(&principal, Feature::DailyPlanReview)?;
    let draft = state
        .repository
        .confirm_work_diary(WorkDiaryConfirmCommand {
            actor: principal.user_id,
            date,
            branch_scope: principal.branch_scope,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_export)?;
    Ok(Json(draft))
}

fn export_query(principal: &Principal, date: Date) -> ReportingExportQuery {
    ReportingExportQuery {
        actor: principal.user_id,
        date,
        branch_scope: principal.branch_scope.clone(),
        trace: TraceContext::generate(),
        occurred_at: time::OffsetDateTime::now_utc(),
    }
}

fn workbook_response(
    file_name: String,
    content_type: &'static str,
    bytes: Vec<u8>,
) -> Result<Response, RestError> {
    let mut response = bytes.into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    let disposition = format!("attachment; filename=\"{file_name}\"");
    let value = HeaderValue::from_str(&disposition)
        .map_err(|_| RestError::internal("export filename could not be encoded as a header"))?;
    response
        .headers_mut()
        .insert(header::CONTENT_DISPOSITION, value);
    Ok(response)
}

fn authorize_reporting_feature(principal: &Principal, feature: Feature) -> Result<(), RestError> {
    authorize(
        principal,
        Action::new(feature),
        representative_branch(&principal.branch_scope)?,
    )
    .map_err(RestError::from_kernel)
}

fn parse_period(raw: &str) -> Result<Period, RestError> {
    let (start_raw, end_raw) = raw
        .split_once("..")
        .ok_or_else(|| RestError::bad_request("period must use YYYY-MM-DD..YYYY-MM-DD"))?;
    let format = format_description!("[year]-[month]-[day]");
    let start_date = Date::parse(start_raw, &format)
        .map_err(|_| RestError::bad_request("period start must use YYYY-MM-DD"))?;
    let end_date = Date::parse(end_raw, &format)
        .map_err(|_| RestError::bad_request("period end must use YYYY-MM-DD"))?;
    let period = Period {
        start: start_date.with_time(Time::MIDNIGHT).assume_utc(),
        end: end_date.with_time(Time::MIDNIGHT).assume_utc(),
    };
    if period.start >= period.end {
        return Err(RestError::bad_request(
            "period start must be before period end",
        ));
    }
    Ok(period)
}

fn parse_date(raw: &str) -> Result<Date, RestError> {
    let format = format_description!("[year]-[month]-[day]");
    Date::parse(raw, &format).map_err(|_| RestError::bad_request("date must use YYYY-MM-DD"))
}

fn parse_scope(raw: Option<&str>) -> Result<KpiScope, RestError> {
    let Some(raw) = raw.filter(|value| !value.trim().is_empty()) else {
        return Ok(KpiScope::Company);
    };
    if raw == "company" {
        return Ok(KpiScope::Company);
    }
    let (kind, id) = raw.split_once(':').ok_or_else(|| {
        RestError::bad_request(
            "scope must be company, region:<id>, branch:<id>, or technician:<id>",
        )
    })?;
    let id =
        uuid::Uuid::parse_str(id).map_err(|_| RestError::bad_request("scope id must be a UUID"))?;
    match kind {
        "region" => Ok(KpiScope::Region(RegionId::from_uuid(id))),
        "branch" => Ok(KpiScope::Branch(BranchId::from_uuid(id))),
        "technician" => Ok(KpiScope::Technician(UserId::from_uuid(id))),
        _ => Err(RestError::bad_request(
            "scope must be company, region:<id>, branch:<id>, or technician:<id>",
        )),
    }
}

fn authorization_branch(principal: &Principal, scope: KpiScope) -> Result<BranchId, RestError> {
    match scope {
        KpiScope::Branch(branch_id) => Ok(branch_id),
        KpiScope::Company | KpiScope::Region(_) | KpiScope::Technician(_) => {
            representative_branch(&principal.branch_scope)
        }
    }
}

fn representative_branch(branch_scope: &BranchScope) -> Result<BranchId, RestError> {
    match branch_scope {
        BranchScope::All => Ok(BranchId::new()),
        BranchScope::Branches(branches) => branches.iter().next().copied().ok_or_else(|| {
            RestError::from_kernel(KernelError::forbidden(
                "principal has no branch scope for KPI access",
            ))
        }),
    }
}

fn principal_from_headers(
    state: &KpiRestState,
    headers: &HeaderMap,
) -> Result<Principal, RestError> {
    let verifier = state
        .jwt_verifier
        .as_ref()
        .ok_or_else(|| RestError::unavailable("JWT verification is not configured for KPI API"))?;
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

fn status_for_error_kind(kind: ErrorKind) -> StatusCode {
    match kind {
        ErrorKind::Validation => StatusCode::UNPROCESSABLE_ENTITY,
        ErrorKind::NotFound => StatusCode::NOT_FOUND,
        ErrorKind::Forbidden => StatusCode::FORBIDDEN,
        ErrorKind::Conflict => StatusCode::CONFLICT,
        ErrorKind::InvalidTransition => StatusCode::CONFLICT,
        ErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
    }
}
