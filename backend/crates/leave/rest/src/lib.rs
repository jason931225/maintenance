//! Leave-request REST API (연차 결재 + §61 촉진).
//!
//! Reads are gated on `employee_directory_read`, mutations on
//! `employee_directory_manage` — the branch HR/manager tier. The tenant (org)
//! is always bound from the authenticated principal; the approval queue and
//! decide path are additionally *branch*-scoped from the principal's resolved
//! [`BranchScope`], so an approver only sees and acts on their own branches.
//! The statutory push validates its target `branch_id` against the actor's
//! scope via [`authorize`] — a branch outside the actor's scope is rejected,
//! never trusted from input.
//!
//! Separation of duties: the decide path forbids a requester from deciding
//! their own request (enforced in the adapter + a DB CHECK), mirroring the
//! workflow-engine initiator guard (#205).
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use mnt_kernel_core::{
    BranchScope, Date, ErrorKind, KernelError, LeaveRequestId, TraceContext, UserId,
};
use mnt_leave_adapter_postgres::{PgLeaveError, PgLeaveStore};
use mnt_leave_application::{
    CreateLeaveRequestCommand, DecideLeaveRequestCommand, LeaveRequestPage, ListLeaveRequestsQuery,
    ListSelfLeaveRequestsQuery, ResolveLeaveChargeCommand, SelfLeaveBalanceView,
    StatutoryPushCommand,
};
use mnt_leave_domain::{
    LeaveDateCharge, LeaveDecision, LeaveStatus, LeaveType, LeaveUnits, NewLeaveRequest,
    NonWorkBasis, PartialDayPeriod, PromotionKind, SourceRevisionRef, WorkObligation,
};
use mnt_platform_auth::JwtVerifier;
use mnt_platform_authz::{Action, Feature, Principal, authorize, authorize_org_wide};
use mnt_platform_request_context::RequestContextError;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const LEAVE_REQUESTS_PATH: &str = "/api/v1/leave/requests";
pub const LEAVE_DECIDE_PATH_TEMPLATE: &str = "/api/v1/leave/requests/{id}/decide";
pub const LEAVE_CHARGE_RESOLUTION_PATH_TEMPLATE: &str =
    "/api/v1/leave/requests/{id}/charge-resolution";
pub const MY_LEAVE_PATH: &str = "/api/v1/me/leave";
pub const LEAVE_BALANCES_PATH: &str = "/api/v1/leave/balances";
pub const LEAVE_PROMOTIONS_PATH: &str = "/api/v1/leave/promotions";
pub const LEAVE_REFUSAL_NOTICES_PATH: &str = "/api/v1/leave/refusal-notices";

pub const LEAVE_ROUTE_PATHS: &[&str] = &[
    LEAVE_REQUESTS_PATH,
    LEAVE_DECIDE_PATH_TEMPLATE,
    LEAVE_CHARGE_RESOLUTION_PATH_TEMPLATE,
    MY_LEAVE_PATH,
    LEAVE_BALANCES_PATH,
    LEAVE_PROMOTIONS_PATH,
    LEAVE_REFUSAL_NOTICES_PATH,
];

#[derive(Clone)]
pub struct LeaveRestState {
    store: PgLeaveStore,
    jwt_verifier: Option<JwtVerifier>,
}

impl std::fmt::Debug for LeaveRestState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LeaveRestState")
            .field("has_jwt_verifier", &self.jwt_verifier.is_some())
            .finish()
    }
}

impl LeaveRestState {
    #[must_use]
    pub fn new(store: PgLeaveStore, jwt_verifier: Option<JwtVerifier>) -> Self {
        Self {
            store,
            jwt_verifier,
        }
    }
}

pub fn router(state: LeaveRestState) -> Router {
    let verifier = state.jwt_verifier.clone();
    let pool = state.store.pool().clone();
    let router = Router::new()
        .route(LEAVE_REQUESTS_PATH, get(list_requests).post(create_request))
        .route(LEAVE_DECIDE_PATH_TEMPLATE, post(decide))
        .route(LEAVE_CHARGE_RESOLUTION_PATH_TEMPLATE, post(resolve_charge))
        .route(MY_LEAVE_PATH, get(get_my_leave))
        .route(LEAVE_BALANCES_PATH, get(list_balances))
        .route(LEAVE_PROMOTIONS_PATH, post(push_promotion))
        .route(LEAVE_REFUSAL_NOTICES_PATH, post(push_refusal))
        .with_state(state);
    mnt_platform_request_context::with_request_context(router, verifier, pool)
}

#[derive(Debug, Deserialize)]
struct ListParams {
    status: Option<String>,
    limit: Option<i64>,
}

#[derive(Debug, Serialize)]
struct MyLeaveOverview {
    balance: SelfLeaveBalanceView,
    requests: LeaveRequestPage,
}

async fn get_my_leave(
    State(state): State<LeaveRestState>,
    headers: HeaderMap,
    Query(params): Query<ListParams>,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    // Deliberately no employee-directory feature gate. Both reads bind the
    // caller's user id to the linked employee on the server.
    let balance = state
        .store
        .get_self_balance(principal.user_id)
        .await
        .map_err(RestError::from_store)?;
    let requests = state
        .store
        .list_self_requests(ListSelfLeaveRequestsQuery {
            requester: principal.user_id,
            limit: params.limit.unwrap_or(100),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(MyLeaveOverview { balance, requests }).into_response())
}

async fn list_requests(
    State(state): State<LeaveRestState>,
    headers: HeaderMap,
    Query(params): Query<ListParams>,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    require_read(&principal)?;
    let status = match params.status.as_deref() {
        Some(s) => Some(LeaveStatus::parse(s).map_err(RestError::from_kernel)?),
        None => None,
    };
    let page = state
        .store
        .list_requests(ListLeaveRequestsQuery {
            branch_scope: principal.branch_scope.clone(),
            status,
            limit: params.limit.unwrap_or(100),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(page).into_response())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateRequestBody {
    /// `annual` (full-day intent) or `half_day` (policy-resolved partial-day intent).
    leave_type: String,
    /// Required exactly for `half_day`; absent for `annual`.
    #[serde(default)]
    partial_day_period: Option<String>,
    /// `YYYY-MM-DD`. Half-day intent must target a single date.
    start_date: String,
    end_date: String,
    reason: String,
}

fn parse_iso_date(value: &str, field: &'static str) -> Result<Date, RestError> {
    Date::parse(value, &time::format_description::well_known::Iso8601::DATE).map_err(|_| {
        RestError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation",
            format!("{field} must be a YYYY-MM-DD date"),
        )
    })
}

/// Self-service 연차/반차 신청 (POST /api/v1/leave/requests). The caller files a
/// request for THEMSELVES: `subject_employee_id` and the routing `branch_id` are
/// resolved server-side from the caller's own account (`users.employee_id` +
/// `employees.home_branch_id`), never from input, so a caller can only ever file for their
/// own employee record. No directory feature is required — filing your own leave
/// is a base employee capability; the gate is the employee link itself (an
/// unlinked or inactive account is 403, deny-by-omission). The created request is `pending`
/// and moves no ledger until a *separate* approver decides it (SoD).
async fn create_request(
    State(state): State<LeaveRestState>,
    headers: HeaderMap,
    Json(body): Json<CreateRequestBody>,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let (subject_employee_id, _) = state
        .store
        .resolve_self_filing_context(principal.user_id)
        .await
        .map_err(RestError::from_store)?;

    let leave_type = LeaveType::parse(&body.leave_type).map_err(RestError::from_kernel)?;
    let start_date = parse_iso_date(&body.start_date, "start_date")?;
    let end_date = parse_iso_date(&body.end_date, "end_date")?;
    let partial_day_period = body
        .partial_day_period
        .as_deref()
        .map(PartialDayPeriod::parse)
        .transpose()
        .map_err(RestError::from_kernel)?;
    let request = NewLeaveRequest::new(
        leave_type,
        start_date,
        end_date,
        &body.reason,
        partial_day_period,
    )
    .map_err(RestError::from_kernel)?;

    let view = state
        .store
        .create_request(CreateLeaveRequestCommand {
            requester_user_id: principal.user_id,
            subject_employee_id,
            request,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok((StatusCode::CREATED, Json(view)).into_response())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DecideRequest {
    /// Mutable request/workflow CAS token from `LeaveRequestView.request_version`.
    /// This is not the immutable charge-evidence revision.
    expected_version: i64,
    decision: String,
    #[serde(default)]
    comment: Option<String>,
}

async fn decide(
    State(state): State<LeaveRestState>,
    headers: HeaderMap,
    Path(id): Path<LeaveRequestId>,
    Json(body): Json<DecideRequest>,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    // Role gate: the branch HR/manager tier. Which requests they can touch is
    // confined by branch_scope in the store; SoD is enforced there too.
    require_manage(&principal)?;
    let decision = LeaveDecision::parse(&body.decision).map_err(RestError::from_kernel)?;
    let comment = mnt_leave_domain::validate_decision_comment(decision, body.comment.as_deref())
        .map_err(RestError::from_kernel)?;
    let expected_version = validate_expected_request_version(body.expected_version)?;
    let view = state
        .store
        .decide(DecideLeaveRequestCommand {
            request_id: id,
            decider: principal.user_id,
            branch_scope: principal.branch_scope.clone(),
            expected_version,
            decision,
            comment,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(view).into_response())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ResolveChargeRequest {
    /// Mutable request/workflow CAS token from `LeaveRequestView.request_version`.
    /// A successful resolution separately creates a new `charge_version`.
    expected_version: i64,
    date_charges: Vec<DateChargeRequest>,
    calendar_revision_ref: SourceRevisionRequest,
    policy_revision_ref: SourceRevisionRequest,
    #[serde(default)]
    supporting_source_refs: Vec<SourceRevisionRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DateChargeRequest {
    date: String,
    obligation: WorkObligationRequest,
    /// Exact fixed-scale day units. Totals and digests are never accepted.
    charge_units: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum WorkObligationRequest {
    Scheduled { minutes: u32 },
    NotScheduled { basis: String },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceRevisionRequest {
    kind: String,
    reference: String,
    revision: String,
}

async fn resolve_charge(
    State(state): State<LeaveRestState>,
    headers: HeaderMap,
    Path(id): Path<LeaveRequestId>,
    Json(body): Json<ResolveChargeRequest>,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    require_manage(&principal)?;
    let expected_version = validate_expected_request_version(body.expected_version)?;
    let date_charges = body
        .date_charges
        .into_iter()
        .map(|charge| {
            Ok(LeaveDateCharge {
                date: parse_iso_date(&charge.date, "date_charges[].date")?,
                obligation: match charge.obligation {
                    WorkObligationRequest::Scheduled { minutes } => {
                        WorkObligation::Scheduled { minutes }
                    }
                    WorkObligationRequest::NotScheduled { basis } => WorkObligation::NotScheduled {
                        basis: parse_non_work_basis(&basis)?,
                    },
                },
                units: parse_leave_units(&charge.charge_units)?,
            })
        })
        .collect::<Result<Vec<_>, RestError>>()?;
    let calendar_revision_ref = source_revision(body.calendar_revision_ref)?;
    let policy_revision_ref = source_revision(body.policy_revision_ref)?;
    let supporting_source_refs = body
        .supporting_source_refs
        .into_iter()
        .map(source_revision)
        .collect::<Result<Vec<_>, _>>()?;
    let view = state
        .store
        .resolve_charge(ResolveLeaveChargeCommand {
            request_id: id,
            resolver: principal.user_id,
            branch_scope: principal.branch_scope.clone(),
            expected_version,
            date_charges,
            calendar_revision_ref,
            policy_revision_ref,
            supporting_source_refs,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(view).into_response())
}

fn source_revision(body: SourceRevisionRequest) -> Result<SourceRevisionRef, RestError> {
    SourceRevisionRef::new(&body.kind, &body.reference, &body.revision)
        .map_err(RestError::from_kernel)
}

fn validate_expected_request_version(value: i64) -> Result<i64, RestError> {
    if value <= 0 {
        return Err(RestError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation",
            "expected_version must be a positive request_version",
        ));
    }
    Ok(value)
}

fn parse_non_work_basis(value: &str) -> Result<NonWorkBasis, RestError> {
    match value {
        "rest_day" => Ok(NonWorkBasis::RestDay),
        "public_holiday" => Ok(NonWorkBasis::PublicHoliday),
        "substitute_holiday" => Ok(NonWorkBasis::SubstituteHoliday),
        "contractual_day_off" => Ok(NonWorkBasis::ContractualDayOff),
        "other" => Ok(NonWorkBasis::Other),
        _ => Err(RestError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation",
            "non-work basis must be rest_day|public_holiday|substitute_holiday|contractual_day_off|other",
        )),
    }
}

fn parse_leave_units(value: &str) -> Result<LeaveUnits, RestError> {
    let value = value.trim();
    if value.is_empty() || value.starts_with('-') || value.starts_with('+') {
        return Err(RestError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation",
            "charge_units must be a non-negative decimal string with at most six fractional digits",
        ));
    }
    let mut parts = value.split('.');
    let whole = parts.next().unwrap_or_default();
    let fraction = parts.next().unwrap_or_default();
    if parts.next().is_some()
        || whole.is_empty()
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || fraction.len() > 6
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(RestError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation",
            "charge_units must be a non-negative decimal string with at most six fractional digits",
        ));
    }
    let whole = whole.parse::<i64>().map_err(|_| {
        RestError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation",
            "charge_units is outside the supported range",
        )
    })?;
    let fraction = format!("{fraction:0<6}").parse::<i64>().map_err(|_| {
        RestError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation",
            "charge_units is invalid",
        )
    })?;
    let micros = whole
        .checked_mul(1_000_000)
        .and_then(|whole| whole.checked_add(fraction))
        .ok_or_else(|| {
            RestError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "validation",
                "charge_units is outside the supported range",
            )
        })?;
    LeaveUnits::from_micros(micros).map_err(RestError::from_kernel)
}

async fn list_balances(
    State(state): State<LeaveRestState>,
    headers: HeaderMap,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    require_read(&principal)?;
    let page = state
        .store
        .list_balances(principal.branch_scope.clone())
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(page).into_response())
}

#[derive(Debug, Deserialize)]
struct PromotionRequest {
    /// The branch the push is served under — validated against the actor's
    /// scope, never trusted blindly.
    branch_id: Uuid,
    target_user_id: Uuid,
    target_employee_id: Uuid,
    target_name: String,
    round: i16,
    #[serde(default)]
    unused_days: f64,
}

async fn push_promotion(
    State(state): State<LeaveRestState>,
    headers: HeaderMap,
    Json(body): Json<PromotionRequest>,
) -> Result<Response, RestError> {
    statutory_push(&state, &headers, PromotionKind::Promotion, body).await
}

#[derive(Debug, Deserialize)]
struct RefusalRequest {
    branch_id: Uuid,
    target_user_id: Uuid,
    target_employee_id: Uuid,
    target_name: String,
    #[serde(default)]
    unused_days: f64,
}

async fn push_refusal(
    State(state): State<LeaveRestState>,
    headers: HeaderMap,
    Json(body): Json<RefusalRequest>,
) -> Result<Response, RestError> {
    let promotion = PromotionRequest {
        branch_id: body.branch_id,
        target_user_id: body.target_user_id,
        target_employee_id: body.target_employee_id,
        target_name: body.target_name,
        // A refusal follows a completed round 2; the domain normalizes this.
        round: 2,
        unused_days: body.unused_days,
    };
    statutory_push(&state, &headers, PromotionKind::Refusal, promotion).await
}

async fn statutory_push(
    state: &LeaveRestState,
    headers: &HeaderMap,
    kind: PromotionKind,
    body: PromotionRequest,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(state, headers).await?;
    // Authorize the manage feature AGAINST the target branch: this both role-
    // gates the actor and confirms `branch_id` is within their scope, so a
    // branch outside the actor's scope is rejected rather than trusted.
    authorize(
        &principal,
        Action::new(Feature::EmployeeDirectoryManage),
        mnt_kernel_core::BranchId::from_uuid(body.branch_id),
    )
    .map_err(RestError::from_kernel)?;
    state
        .store
        .verify_statutory_push_target(
            body.branch_id,
            UserId::from_uuid(body.target_user_id),
            body.target_employee_id,
        )
        .await
        .map_err(RestError::from_store)?;
    let view = state
        .store
        .statutory_push(StatutoryPushCommand {
            actor: principal.user_id,
            branch_id: body.branch_id,
            target_user_id: UserId::from_uuid(body.target_user_id),
            target_employee_id: body.target_employee_id,
            target_name: body.target_name,
            kind,
            round: body.round,
            unused_days: body.unused_days,
            trace: TraceContext::generate(),
            occurred_at: time::OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(view).into_response())
}

// ---------------------------------------------------------------------------
// Authorization helpers
// ---------------------------------------------------------------------------

/// Require the read tier (`employee_directory_read`). Role permission is
/// branch-independent, so an org-wide scope is checked org-wide and a
/// branch-scoped principal is checked against any one of its branches; the
/// branch confinement of returned rows happens in the store.
fn require_read(principal: &Principal) -> Result<(), RestError> {
    require_feature(principal, Feature::EmployeeDirectoryRead)
}

fn require_manage(principal: &Principal) -> Result<(), RestError> {
    require_feature(principal, Feature::EmployeeDirectoryManage)
}

fn require_feature(principal: &Principal, feature: Feature) -> Result<(), RestError> {
    let action = Action::new(feature);
    let result = match &principal.branch_scope {
        BranchScope::All => authorize_org_wide(principal, action),
        BranchScope::Branches(branches) => match branches.iter().next() {
            Some(branch) => authorize(principal, action, *branch),
            None => Err(KernelError::forbidden("principal has no branch scope")),
        },
    };
    result.map_err(RestError::from_kernel)
}

// ---------------------------------------------------------------------------
// Errors + principal resolution (mirrors the inbox REST surface)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
struct ErrorBody {
    error: ErrorPayload,
}

#[derive(Debug, Serialize)]
struct ErrorPayload {
    code: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    reasons: Vec<String>,
}

#[derive(Debug)]
struct RestError {
    status: StatusCode,
    code: &'static str,
    message: String,
    reasons: Vec<String>,
}

impl RestError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            reasons: Vec::new(),
        }
    }

    fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", message)
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, "unavailable", message)
    }

    fn from_kernel(err: KernelError) -> Self {
        match err.kind {
            ErrorKind::Validation => {
                Self::new(StatusCode::UNPROCESSABLE_ENTITY, "validation", err.message)
            }
            ErrorKind::NotFound => Self::new(StatusCode::NOT_FOUND, "not_found", err.message),
            ErrorKind::Forbidden => Self::new(StatusCode::FORBIDDEN, "forbidden", err.message),
            ErrorKind::Conflict | ErrorKind::InvalidTransition => {
                Self::new(StatusCode::CONFLICT, "conflict", err.message)
            }
            ErrorKind::Internal => {
                Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", err.message)
            }
        }
    }

    fn from_store(err: PgLeaveError) -> Self {
        match err {
            PgLeaveError::Domain(err) => Self::from_kernel(err),
            PgLeaveError::MissingHomeBranch => Self::new(
                StatusCode::CONFLICT,
                "leave_home_branch_review_required",
                "an active linked employee needs an explicit home branch before filing leave",
            ),
            PgLeaveError::ChargeReviewRequired(reasons) => {
                let mut error = Self::new(
                    StatusCode::CONFLICT,
                    "leave_calendar_review_required",
                    "leave charge evidence must be resolved before approval",
                );
                error.reasons = reasons
                    .into_iter()
                    .map(|reason| reason.as_str().to_owned())
                    .collect();
                error
            }
            PgLeaveError::ConcurrentModification => Self::new(
                StatusCode::CONFLICT,
                "leave_concurrent_modification",
                "leave request_version changed since it was read; reload before retrying",
            ),
            PgLeaveError::CommandUnavailable => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "leave_command_unavailable",
                "leave command database is not configured or unavailable",
            ),
            PgLeaveError::Db(_) => {
                // Never leak sqlx/schema internals (OWASP A05). Log server-side.
                tracing::error!(error = %err, "leave store error");
                Self::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal",
                    "internal server error",
                )
            }
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
                    reasons: self.reasons,
                },
            }),
        )
            .into_response()
    }
}

async fn principal_from_headers(
    state: &LeaveRestState,
    headers: &HeaderMap,
) -> Result<Principal, RestError> {
    let verifier = state.jwt_verifier.as_ref().ok_or_else(|| {
        RestError::unavailable("JWT verification is not configured for the leave API")
    })?;
    mnt_platform_request_context::resolve_principal(verifier, state.store.pool(), headers)
        .await
        .map_err(rest_error_from_request_context)
}

fn rest_error_from_request_context(err: RequestContextError) -> RestError {
    match err {
        RequestContextError::VerifierUnavailable => {
            RestError::unavailable("JWT verification is not configured for the leave API")
        }
        RequestContextError::WrongTokenTier => RestError::from_kernel(KernelError::forbidden(
            "token tier is not valid for this route",
        )),
        RequestContextError::AccessScope(error) => RestError::from_kernel(error),
        RequestContextError::BranchScope(message)
        | RequestContextError::EffectivePolicy(message) => {
            RestError::from_kernel(KernelError::internal(message))
        }
        RequestContextError::MissingOrg => RestError::from_kernel(KernelError::internal(
            "no tenant context is bound to the current request",
        )),
        RequestContextError::MissingBearer => {
            RestError::unauthorized("missing or malformed bearer token")
        }
        RequestContextError::InvalidToken => RestError::unauthorized("invalid bearer token"),
        RequestContextError::InvalidClaim(message) => {
            RestError::unauthorized(format!("token claim is invalid: {message}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mnt_kernel_core::{BranchId, OrgId};
    use mnt_platform_authz::Role;
    use std::collections::BTreeSet;

    fn principal(role: Role, branch: BranchId) -> Principal {
        Principal::new(
            UserId::new(),
            OrgId::knl(),
            BTreeSet::from([role]),
            BranchScope::Branches(BTreeSet::from([branch])),
        )
    }

    #[test]
    fn member_is_denied_read_and_manage() {
        let p = principal(Role::Member, BranchId::new());
        assert_eq!(
            require_read(&p).unwrap_err().status,
            StatusCode::FORBIDDEN,
            "a MEMBER cannot read the leave queue"
        );
        assert_eq!(
            require_manage(&p).unwrap_err().status,
            StatusCode::FORBIDDEN,
            "a MEMBER cannot decide leave"
        );
    }

    #[test]
    fn exact_leave_units_parser_never_uses_floating_point() {
        assert_eq!(parse_leave_units("0").unwrap().micros(), 0);
        assert_eq!(parse_leave_units("0.4").unwrap().micros(), 400_000);
        assert_eq!(parse_leave_units("0.500000").unwrap().micros(), 500_000);
        assert_eq!(parse_leave_units("1.000001").unwrap().micros(), 1_000_001);
        assert!(parse_leave_units("0.0000001").is_err());
        assert!(parse_leave_units("-0.5").is_err());
        assert!(parse_leave_units("NaN").is_err());
    }

    #[test]
    fn missing_leave_command_capability_maps_to_stable_503() {
        let error = RestError::from_store(PgLeaveError::CommandUnavailable);
        assert_eq!(error.status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(error.code, "leave_command_unavailable");
    }

    #[test]
    fn expected_version_is_the_positive_request_cas_token() {
        for invalid in [i64::MIN, -1, 0] {
            let error = validate_expected_request_version(invalid).unwrap_err();
            assert_eq!(error.status, StatusCode::UNPROCESSABLE_ENTITY);
            assert_eq!(error.code, "validation");
            assert!(error.message.contains("positive request_version"));
        }
        assert_eq!(validate_expected_request_version(1).unwrap(), 1);
        assert_eq!(validate_expected_request_version(7).unwrap(), 7);
    }

    #[test]
    fn decide_body_accepts_request_cas_and_rejects_charge_version() {
        let body: DecideRequest = serde_json::from_value(serde_json::json!({
            "expected_version": 7,
            "decision": "approve"
        }))
        .unwrap();
        assert_eq!(body.expected_version, 7);

        let error = serde_json::from_value::<DecideRequest>(serde_json::json!({
            "expected_version": 7,
            "charge_version": 3,
            "decision": "approve"
        }))
        .unwrap_err();
        assert!(error.to_string().contains("unknown field `charge_version`"));
    }

    #[test]
    fn branch_admin_can_read_and_manage_its_branch() {
        let branch = BranchId::new();
        let p = principal(Role::Admin, branch);
        assert!(require_read(&p).is_ok());
        assert!(require_manage(&p).is_ok());
        // In-scope branch push authorization passes...
        assert!(authorize(&p, Action::new(Feature::EmployeeDirectoryManage), branch,).is_ok());
        // ...but a branch OUTSIDE the actor's scope is rejected, so a pushed
        // `branch_id` can never escape the actor's authority.
        assert!(
            authorize(
                &p,
                Action::new(Feature::EmployeeDirectoryManage),
                BranchId::new(),
            )
            .is_err(),
            "an out-of-scope branch_id must be rejected"
        );
    }
}
