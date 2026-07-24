//! Authenticated REST boundary for the Attendance console.  It validates wire
//! input, derives a tenant/branch scope from the signed principal, and delegates
//! all business decisions and database work to the private application layers.
#![cfg_attr(test, allow(clippy::unwrap_used))]

use axum::{
    Json, Router,
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use mnt_attendance_adapter_postgres::{AttendanceStoreError, PgAttendanceStore};
use mnt_attendance_application::{
    AssignSubstitute, CallerScope, CloseMonth, ListSubstitutions, RaiseException, ResolveException,
    week52_tone,
};
use mnt_attendance_domain::{
    AttendanceDateRange, ExceptionKind, ResolutionAction, SubstitutionWindow,
};
use mnt_kernel_core::{BranchScope, ErrorKind, KernelError};
use mnt_platform_auth::JwtVerifier;
use mnt_platform_authz::{Action, Feature, Principal, authorize_org_wide};
use mnt_platform_request_context::{RequestContextError, resolve_principal};
use serde::Deserialize;
use serde_json::{Value, json};
use time::{Date, Duration};
use uuid::Uuid;

pub const ATTENDANCE_EXCEPTIONS_PATH: &str = "/api/v1/attendance/exceptions";
pub const ATTENDANCE_EXCEPTION_RESOLVE_PATH: &str =
    "/api/v1/attendance/exceptions/{exception_id}/resolve";
pub const ATTENDANCE_SUBSTITUTIONS_PATH: &str = "/api/v1/attendance/substitutions";
pub const ATTENDANCE_CLOSES_PATH: &str = "/api/v1/attendance/closes";
pub const ATTENDANCE_CLOSE_PREFLIGHT_PATH: &str = "/api/v1/attendance/closes/preflight";
pub const ATTENDANCE_WEEK52_PATH: &str = "/api/v1/attendance/week52";
pub const ATTENDANCE_ROUTE_PATHS: &[&str] = &[
    ATTENDANCE_EXCEPTIONS_PATH,
    ATTENDANCE_EXCEPTION_RESOLVE_PATH,
    ATTENDANCE_SUBSTITUTIONS_PATH,
    ATTENDANCE_CLOSES_PATH,
    ATTENDANCE_CLOSE_PREFLIGHT_PATH,
    ATTENDANCE_WEEK52_PATH,
];
const READ: Feature = Feature::EmployeeDirectoryRead;
const MANAGE: Feature = Feature::EmployeeDirectoryManage;
const CLOSE: Feature = Feature::PeriodLockManage;

#[derive(Clone)]
pub struct AttendanceRestState {
    store: PgAttendanceStore,
    jwt: Option<JwtVerifier>,
}
impl AttendanceRestState {
    #[must_use]
    pub fn new(store: PgAttendanceStore, jwt: Option<JwtVerifier>) -> Self {
        Self { store, jwt }
    }
}
#[must_use]
pub fn router(state: AttendanceRestState) -> Router {
    let verifier = state.jwt.clone();
    let pool = state.store.pool().clone();
    let r = Router::new()
        .route(
            ATTENDANCE_EXCEPTIONS_PATH,
            get(list_exceptions).post(raise_exception),
        )
        .route(ATTENDANCE_EXCEPTION_RESOLVE_PATH, post(resolve_exception))
        .route(
            ATTENDANCE_SUBSTITUTIONS_PATH,
            get(list_substitutions).post(assign_substitute),
        )
        .route(ATTENDANCE_CLOSE_PREFLIGHT_PATH, post(close_preflight))
        .route(ATTENDANCE_CLOSES_PATH, post(close_month))
        .route(ATTENDANCE_WEEK52_PATH, get(week52))
        .with_state(state);
    mnt_platform_request_context::with_request_context(r, verifier, pool)
}

async fn principal(
    state: &AttendanceRestState,
    headers: &HeaderMap,
) -> Result<Principal, RestError> {
    let verifier = state.jwt.as_ref().ok_or_else(|| {
        RestError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "JWT verification is not configured",
        )
    })?;
    resolve_principal(verifier, state.store.pool(), headers)
        .await
        .map_err(|e| match e {
            RequestContextError::MissingBearer
            | RequestContextError::InvalidToken
            | RequestContextError::InvalidClaim(_) => RestError::new(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "missing or invalid bearer token",
            ),
            RequestContextError::WrongTokenTier | RequestContextError::AccessScope(_) => {
                RestError::kernel(KernelError::forbidden(
                    "token is not authorized for attendance",
                ))
            }
            RequestContextError::VerifierUnavailable => RestError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "unavailable",
                "JWT verification is not configured",
            ),
            _ => RestError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "request principal could not be resolved",
            ),
        })
}
fn require(principal: &Principal, feature: Feature) -> Result<(), RestError> {
    authorize_org_wide(principal, Action::new(feature)).map_err(RestError::kernel)
}
fn scope(principal: &Principal) -> CallerScope {
    match &principal.branch_scope {
        BranchScope::All => CallerScope {
            org_id: *principal.org_id.as_uuid(),
            user_id: *principal.user_id.as_uuid(),
            branch_ids: vec![],
            org_wide: true,
        },
        BranchScope::Branches(branches) => CallerScope {
            org_id: *principal.org_id.as_uuid(),
            user_id: *principal.user_id.as_uuid(),
            branch_ids: branches.iter().map(|id| *id.as_uuid()).collect(),
            org_wide: false,
        },
    }
}
fn parse_date(raw: &str, name: &str) -> Result<Date, RestError> {
    Date::parse(
        raw,
        time::macros::format_description!("[year]-[month]-[day]"),
    )
    .map_err(|_| {
        RestError::kernel(KernelError::validation(format!(
            "{name} must be YYYY-MM-DD"
        )))
    })
}
fn parse_month_range(month: &str) -> Result<AttendanceDateRange, RestError> {
    AttendanceDateRange::selected_month_with_buffer(month).map_err(|e| {
        RestError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation",
            e.to_string(),
        )
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListQuery {
    month: String,
    from_date: Option<String>,
    to_date: Option<String>,
    branch_id: Option<Uuid>,
    limit: Option<i64>,
    offset: Option<i64>,
}
fn list_range(q: &ListQuery) -> Result<AttendanceDateRange, RestError> {
    match (&q.from_date, &q.to_date) {
        (None, None) => parse_month_range(&q.month),
        (Some(from), Some(to)) => {
            AttendanceDateRange::new(parse_date(from, "fromDate")?, parse_date(to, "toDate")?)
                .map_err(|e| {
                    RestError::new(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "validation",
                        e.to_string(),
                    )
                })
        }
        _ => Err(RestError::kernel(KernelError::validation(
            "fromDate and toDate must be provided together",
        ))),
    }
}
async fn list_substitutions(
    State(state): State<AttendanceRestState>,
    headers: HeaderMap,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>, RestError> {
    let p = principal(&state, &headers).await?;
    require(&p, READ)?;
    let query = ListSubstitutions::new(list_range(&q)?, q.branch_id, q.limit, q.offset);
    let (items, total) = state
        .store
        .list_substitutions(&scope(&p), query)
        .await
        .map_err(RestError::store)?;
    Ok(Json(json!({"items":items,"total":total})))
}
async fn list_exceptions(
    State(state): State<AttendanceRestState>,
    headers: HeaderMap,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>, RestError> {
    let p = principal(&state, &headers).await?;
    require(&p, READ)?;
    let items = state
        .store
        .list_exceptions(&scope(&p), list_range(&q)?, q.branch_id)
        .await
        .map_err(RestError::store)?;
    Ok(Json(json!({"items":items})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RaiseBody {
    kind: String,
    employee_id: Uuid,
    branch_id: Option<Uuid>,
    work_date: String,
    detail: String,
    #[serde(default)]
    evidence: Value,
}
async fn raise_exception(
    State(state): State<AttendanceRestState>,
    headers: HeaderMap,
    Json(body): Json<RaiseBody>,
) -> Result<(StatusCode, Json<Value>), RestError> {
    let p = principal(&state, &headers).await?;
    require(&p, MANAGE)?;
    let key = idempotency(&headers)?;
    let command = RaiseException {
        kind: ExceptionKind::parse(&body.kind).map_err(|e| {
            RestError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "validation",
                e.to_string(),
            )
        })?,
        employee_id: body.employee_id,
        branch_id: body.branch_id,
        work_date: parse_date(&body.work_date, "workDate")?,
        detail: body.detail,
        evidence: body.evidence,
        idempotency_key: key,
    };
    let v = state
        .store
        .raise_exception(&scope(&p), command)
        .await
        .map_err(RestError::store)?;
    Ok((StatusCode::CREATED, Json(v)))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResolveBody {
    action: String,
    reason: String,
    linked_work_ref: Option<String>,
    overtime_minutes: Option<i32>,
}
async fn resolve_exception(
    State(state): State<AttendanceRestState>,
    headers: HeaderMap,
    axum::extract::Path(exception_id): axum::extract::Path<Uuid>,
    Json(body): Json<ResolveBody>,
) -> Result<Json<Value>, RestError> {
    let p = principal(&state, &headers).await?;
    require(&p, MANAGE)?;
    let v = state
        .store
        .resolve_exception(
            &scope(&p),
            ResolveException {
                exception_id,
                action: ResolutionAction::parse(&body.action).map_err(|e| {
                    RestError::new(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "validation",
                        e.to_string(),
                    )
                })?,
                reason: body.reason,
                linked_work_ref: body.linked_work_ref,
                overtime_minutes: body.overtime_minutes,
            },
        )
        .await
        .map_err(RestError::store)?;
    Ok(Json(v))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AssignBody {
    site: String,
    branch_id: Option<Uuid>,
    role: String,
    cover_date: String,
    from_minutes: i32,
    to_minutes: i32,
    covered_employee_id: Uuid,
    reason_kind: String,
    reason_detail: Option<String>,
    worker_employee_id: Option<Uuid>,
    worker_name: String,
    worker_type: String,
    worker_rate: Option<String>,
    exception_id: Option<Uuid>,
}
async fn assign_substitute(
    State(state): State<AttendanceRestState>,
    headers: HeaderMap,
    Json(body): Json<AssignBody>,
) -> Result<(StatusCode, Json<Value>), RestError> {
    let p = principal(&state, &headers).await?;
    require(&p, MANAGE)?;
    let command = AssignSubstitute {
        window: SubstitutionWindow::new(
            parse_date(&body.cover_date, "coverDate")?,
            body.from_minutes,
            body.to_minutes,
        )
        .map_err(|e| {
            RestError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "validation",
                e.to_string(),
            )
        })?,
        branch_id: body.branch_id,
        site: body.site,
        role: body.role,
        covered_employee_id: body.covered_employee_id,
        reason_kind: body.reason_kind,
        reason_detail: body.reason_detail,
        worker_employee_id: body.worker_employee_id,
        worker_name: body.worker_name,
        worker_type: body.worker_type,
        worker_rate: body.worker_rate,
        exception_id: body.exception_id,
        idempotency_key: idempotency(&headers)?,
    };
    let v = state
        .store
        .assign_substitute(&scope(&p), command)
        .await
        .map_err(RestError::store)?;
    Ok((StatusCode::CREATED, Json(v)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CloseBody {
    month: String,
    branch_scope: Option<Uuid>,
    attest: Option<bool>,
}
async fn close_preflight(
    State(state): State<AttendanceRestState>,
    headers: HeaderMap,
    Json(body): Json<CloseBody>,
) -> Result<Json<Value>, RestError> {
    let p = principal(&state, &headers).await?;
    require(&p, CLOSE)?;
    let checks = state
        .store
        .close_checks(
            &scope(&p),
            &CloseMonth {
                month: body.month,
                branch_scope: body.branch_scope,
                attest: false,
            },
        )
        .await
        .map_err(RestError::store)?;
    Ok(Json(
        json!({"ready":checks.ready(),"checks":{"openExceptions":checks.open_exceptions,"pendingLeave":checks.pending_leave,"alreadyClosed":checks.already_closed}}),
    ))
}
async fn close_month(
    State(state): State<AttendanceRestState>,
    headers: HeaderMap,
    Json(body): Json<CloseBody>,
) -> Result<(StatusCode, Json<Value>), RestError> {
    let p = principal(&state, &headers).await?;
    require(&p, CLOSE)?;
    let v = state
        .store
        .close_month(
            &scope(&p),
            CloseMonth {
                month: body.month,
                branch_scope: body.branch_scope,
                attest: body.attest.unwrap_or(false),
            },
        )
        .await
        .map_err(RestError::store)?;
    Ok((StatusCode::CREATED, Json(v)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Week52Query {
    week_start: String,
}
async fn week52(
    State(state): State<AttendanceRestState>,
    headers: HeaderMap,
    Query(q): Query<Week52Query>,
) -> Result<Json<Value>, RestError> {
    let p = principal(&state, &headers).await?;
    require(&p, READ)?;
    let week_start = parse_date(&q.week_start, "weekStart")?;
    let items=state.store.week52_inputs(&scope(&p),week_start,q.branch_id).await.map_err(RestError::store)?.into_iter().map(|i|json!({"employeeId":i.employee_id,"weekStart":i.week_start.to_string(),"currentHours":i.current_hours,"projectedHours":i.projected_hours,"tone":week52_tone(&i),"ackedAt":i.acknowledged_at})).collect::<Vec<_>>();
    Ok(Json(
        json!({"weekStart":week_start.to_string(),"through":(week_start+Duration::days(7)).to_string(),"items":items}),
    ))
}
fn idempotency(headers: &HeaderMap) -> Result<String, RestError> {
    headers
        .get("Idempotency-Key")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
        .ok_or_else(|| {
            RestError::kernel(KernelError::validation(
                "Idempotency-Key header is required",
            ))
        })
}

#[derive(Debug)]
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
    fn kernel(error: KernelError) -> Self {
        match error.kind {
            ErrorKind::Validation => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "validation",
                error.message,
            ),
            ErrorKind::Forbidden => Self::new(StatusCode::FORBIDDEN, "forbidden", error.message),
            ErrorKind::NotFound => Self::new(StatusCode::NOT_FOUND, "not_found", error.message),
            ErrorKind::Conflict | ErrorKind::InvalidTransition => {
                Self::new(StatusCode::CONFLICT, "conflict", error.message)
            }
            ErrorKind::Internal => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "internal server error",
            ),
        }
    }
    fn store(error: AttendanceStoreError) -> Self {
        match error {
            AttendanceStoreError::Application(e) => match e {
                mnt_attendance_application::AttendanceApplicationError::ForbiddenBranch => {
                    Self::new(StatusCode::FORBIDDEN, "forbidden", e.to_string())
                }
                _ => Self::new(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "validation",
                    e.to_string(),
                ),
            },
            AttendanceStoreError::NotFound => {
                Self::new(StatusCode::NOT_FOUND, "not_found", "resource was not found")
            }
            AttendanceStoreError::Conflict => Self::new(
                StatusCode::CONFLICT,
                "conflict",
                "conflicting attendance state",
            ),
            AttendanceStoreError::CloseBlocked => Self::new(
                StatusCode::CONFLICT,
                "close_blocked",
                "open exceptions or a prior close block this close",
            ),
            AttendanceStoreError::Database(_) | AttendanceStoreError::Sql(_) => Self::new(
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_range_needs_both_bounds() {
        let q = ListQuery {
            month: "2026-07".to_owned(),
            from_date: Some("2026-07-01".to_owned()),
            to_date: None,
            branch_id: None,
            limit: None,
            offset: None,
        };
        assert!(list_range(&q).is_err());
    }
    #[test]
    fn no_implicit_unbounded_listing() {
        let q = ListQuery {
            month: "2026-07".to_owned(),
            from_date: None,
            to_date: None,
            branch_id: None,
            limit: None,
            offset: None,
        };
        let r = list_range(&q).unwrap();
        assert_eq!(r.to_exclusive.to_string(), "2026-08-08");
    }
}
