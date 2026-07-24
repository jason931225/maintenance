//! CAP-IFM-PILOT facilities boundary. It intentionally does not depend on the
//! legacy equipment-required work-order model.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use mnt_kernel_core::{
    AuditAction, AuditEvent, BranchId, BranchScope, KernelError, OrgId, TraceContext, UserId,
};
use mnt_platform_auth::JwtVerifier;
use mnt_platform_authz::Principal;
use mnt_platform_db::{DbError, with_audit};
use mnt_platform_request_context::{RequestContextError, resolve_principal};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Row, Transaction};
use uuid::Uuid;

pub const FACILITIES_CASES_PATH: &str = "/api/v1/facilities/cases";
pub const FACILITIES_CASE_PATH: &str = "/api/v1/facilities/cases/{case_id}";
pub const FACILITIES_TRIAGE_PATH: &str = "/api/v1/facilities/cases/{case_id}/triage";
pub const FACILITIES_ASSIGN_PATH: &str = "/api/v1/facilities/cases/{case_id}/assign";
pub const FACILITIES_START_PATH: &str = "/api/v1/facilities/cases/{case_id}/start";
pub const FACILITIES_SUBMIT_PATH: &str = "/api/v1/facilities/cases/{case_id}/submit";
pub const FACILITIES_ACCEPT_PATH: &str = "/api/v1/facilities/cases/{case_id}/acceptance";
pub const FACILITIES_OBSERVATIONS_PATH: &str = "/api/v1/facilities/cases/{case_id}/observations";
pub const FACILITIES_ROUTE_PATHS: &[&str] = &[
    FACILITIES_CASES_PATH,
    FACILITIES_CASE_PATH,
    FACILITIES_TRIAGE_PATH,
    FACILITIES_ASSIGN_PATH,
    FACILITIES_START_PATH,
    FACILITIES_SUBMIT_PATH,
    FACILITIES_ACCEPT_PATH,
    FACILITIES_OBSERVATIONS_PATH,
];

#[derive(Clone)]
pub struct FacilitiesRestState {
    pool: PgPool,
    jwt_verifier: Option<JwtVerifier>,
}
impl FacilitiesRestState {
    #[must_use]
    pub fn new(pool: PgPool, jwt_verifier: Option<JwtVerifier>) -> Self {
        Self { pool, jwt_verifier }
    }
}
pub fn router(state: FacilitiesRestState) -> Router {
    let verifier = state.jwt_verifier.clone();
    let pool = state.pool.clone();
    mnt_platform_request_context::with_request_context(
        Router::new()
            .route(FACILITIES_CASES_PATH, get(list_cases).post(create_due_case))
            .route(FACILITIES_CASE_PATH, get(get_case))
            .route(FACILITIES_TRIAGE_PATH, post(triage))
            .route(FACILITIES_ASSIGN_PATH, post(assign))
            .route(FACILITIES_START_PATH, post(start))
            .route(FACILITIES_SUBMIT_PATH, post(submit))
            .route(FACILITIES_ACCEPT_PATH, post(acceptance))
            .route(FACILITIES_OBSERVATIONS_PATH, post(observe)),
        verifier,
        pool,
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CaseView {
    id: Uuid,
    status: String,
    assignee_id: Option<Uuid>,
    response_due_at: time::OffsetDateTime,
    completion_due_at: time::OffsetDateTime,
    acceptance_due_at: time::OffsetDateTime,
    energy_delta_kwh: Option<String>,
    total_cost_krw: i64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DueCaseBody {
    obligation_id: Uuid,
    idempotency_key: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TriageBody {
    scheduled_for: time::OffsetDateTime,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AssignBody {
    assignee_id: Uuid,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SubmitBody {
    safety_checklist_evidence_id: Uuid,
    service_report_evidence_id: Uuid,
    photo_evidence_id: Option<Uuid>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AcceptanceBody {
    decision: String,
    reason: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ObservationBody {
    pre_kwh: Option<String>,
    post_kwh: Option<String>,
    observed_at: time::OffsetDateTime,
    cost_krw: Option<i64>,
}

async fn principal(s: &FacilitiesRestState, h: &HeaderMap) -> Result<Principal, RestError> {
    let v = s.jwt_verifier.as_ref().ok_or_else(|| {
        RestError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "JWT verification is not configured",
        )
    })?;
    resolve_principal(v, &s.pool, h).await.map_err(|e| match e {
        RequestContextError::MissingBearer
        | RequestContextError::InvalidToken
        | RequestContextError::InvalidClaim(_) => {
            (RestError::new(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "invalid bearer token",
            ))
        }
        _ => RestError::new(
            StatusCode::FORBIDDEN,
            "forbidden",
            "tenant context is not authorized",
        ),
    })
}
async fn require_grant(
    pool: &PgPool,
    p: &Principal,
    key: &str,
    branch: Option<Uuid>,
) -> Result<(), RestError> {
    let ok: bool=sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM user_role_assignments ura JOIN policy_roles r ON r.id=ura.role_id AND r.org_id=ura.org_id JOIN policy_role_permissions p ON p.role_id=r.id AND p.org_id=r.org_id WHERE ura.org_id=$1 AND ura.user_id=$2 AND r.status='ACTIVE' AND NOT r.is_system AND p.feature_key=$3 AND p.permission_level='allow')").bind(*p.org_id.as_uuid()).bind(*p.user_id.as_uuid()).bind(key).fetch_one(pool).await.map_err(RestError::db)?;
    if !ok {
        return Err(RestError::new(
            StatusCode::FORBIDDEN,
            "forbidden",
            "required facilities feature grant is absent",
        ));
    }
    if let Some(b) = branch {
        if !p.branch_scope.allows(BranchId::from_uuid(b)) {
            return Err(RestError::new(
                StatusCode::NOT_FOUND,
                "not_found",
                "facilities case was not found",
            ));
        }
    }
    Ok(())
}
fn hash<T: Serialize>(v: &T) -> String {
    let bytes = serde_json::to_vec(v).unwrap_or_default();
    hex::encode(Sha256::digest(bytes))
}
fn event(
    p: &Principal,
    action: &str,
    id: Uuid,
    branch: Uuid,
    before: Option<serde_json::Value>,
    after: Option<serde_json::Value>,
) -> Result<AuditEvent, RestError> {
    Ok(AuditEvent::new(
        Some(p.user_id),
        AuditAction::new(action).map_err(RestError::kernel)?,
        "facilities_case",
        id.to_string(),
        TraceContext::generate(),
        time::OffsetDateTime::now_utc(),
    )
    .with_org(p.org_id)
    .with_branch(BranchId::from_uuid(branch))
    .with_snapshots(before, after))
}

async fn create_due_case(
    State(s): State<FacilitiesRestState>,
    h: HeaderMap,
    Json(b): Json<DueCaseBody>,
) -> Result<Json<CaseView>, RestError> {
    let p = principal(&s, &h).await?;
    require_grant(&s.pool, &p, "facility_manage", None).await?;
    if b.idempotency_key.len() < 16 {
        return Err(RestError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation",
            "idempotency_key must be at least 16 characters",
        ));
    }
    let req_hash = hash(&b);
    let row=sqlx::query("SELECT o.branch_id,o.site_id,o.next_due_at,o.response_due_seconds,o.completion_due_seconds,o.acceptance_due_seconds FROM facilities_obligations o WHERE o.id=$1 AND o.org_id=$2 AND o.active").bind(b.obligation_id).bind(*p.org_id.as_uuid()).fetch_optional(&s.pool).await.map_err(RestError::db)?.ok_or_else(||RestError::new(StatusCode::NOT_FOUND,"not_found","active HVAC obligation was not found"))?;
    let branch: Uuid = row.try_get("branch_id").map_err(RestError::db)?;
    require_grant(&s.pool, &p, "facility_manage", Some(branch)).await?;
    let existing=sqlx::query("SELECT id,request_hash FROM facilities_cases WHERE org_id=$1 AND obligation_id=$2 AND idempotency_key=$3").bind(*p.org_id.as_uuid()).bind(b.obligation_id).bind(&b.idempotency_key).fetch_optional(&s.pool).await.map_err(RestError::db)?;
    if let Some(x) = existing {
        let existing_hash: String = x.try_get("request_hash").map_err(RestError::db)?;
        if existing_hash != req_hash {
            return Err(RestError::new(
                StatusCode::CONFLICT,
                "idempotency_conflict",
                "idempotency key was used with a different request",
            ));
        }
        let id: Uuid = x.try_get("id").map_err(RestError::db)?;
        return get_case_view(&s.pool, &p, id).await.map(Json);
    }
    let now = time::OffsetDateTime::now_utc();
    let due: time::OffsetDateTime = row.try_get("next_due_at").map_err(RestError::db)?;
    let case = Uuid::new_v4();
    let site: Uuid = row.try_get("site_id").map_err(RestError::db)?;
    let rd: i32 = row.try_get("response_due_seconds").map_err(RestError::db)?;
    let cd: i32 = row
        .try_get("completion_due_seconds")
        .map_err(RestError::db)?;
    let ad: i32 = row
        .try_get("acceptance_due_seconds")
        .map_err(RestError::db)?;
    let e = event(
        &p,
        "facilities.case.create",
        case,
        branch,
        None,
        Some(serde_json::json!({"status":"DUE"})),
    )?;
    with_audit::<_,(),RestError>(&s.pool,e,|tx|Box::pin(async move {sqlx::query("INSERT INTO facilities_cases(id,org_id,branch_id,site_id,obligation_id,status,response_due_at,completion_due_at,acceptance_due_at,request_hash,idempotency_key) VALUES($1,$2,$3,$4,$5,'DUE',$6,$7,$8,$9,$10)").bind(case).bind(*p.org_id.as_uuid()).bind(branch).bind(site).bind(b.obligation_id).bind(due+time::Duration::seconds(i64::from(rd))).bind(due+time::Duration::seconds(i64::from(cd))).bind(due+time::Duration::seconds(i64::from(ad))).bind(req_hash).bind(b.idempotency_key).execute(tx.as_mut()).await.map_err(RestError::db)?; history(tx,&p,case,None,"DUE").await?; Ok(())})).await?;
    let _ = now;
    get_case_view(&s.pool, &p, case).await.map(Json)
}

async fn list_cases(
    State(s): State<FacilitiesRestState>,
    h: HeaderMap,
) -> Result<Json<Vec<CaseView>>, RestError> {
    let p = principal(&s, &h).await?;
    require_grant(&s.pool, &p, "facility_observe", None).await?;
    let ids = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM facilities_cases WHERE org_id=$1 ORDER BY created_at DESC LIMIT 100",
    )
    .bind(*p.org_id.as_uuid())
    .fetch_all(&s.pool)
    .await
    .map_err(RestError::db)?;
    let mut out = Vec::new();
    for id in ids {
        if let Ok(v) = get_case_view(&s.pool, &p, id).await {
            out.push(v)
        }
    }
    Ok(Json(out))
}
async fn get_case(
    State(s): State<FacilitiesRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<CaseView>, RestError> {
    let p = principal(&s, &h).await?;
    require_grant(&s.pool, &p, "facility_observe", None).await?;
    get_case_view(&s.pool, &p, id).await.map(Json)
}
async fn get_case_view(pool: &PgPool, p: &Principal, id: Uuid) -> Result<CaseView, RestError> {
    let r=sqlx::query("SELECT c.id,c.status,c.assignee_id,c.response_due_at,c.completion_due_at,c.acceptance_due_at,c.branch_id, (SELECT post.kwh-pre.kwh FROM facilities_energy_observations pre JOIN facilities_energy_observations post ON post.case_id=pre.case_id AND post.phase='POST' WHERE pre.case_id=c.id AND pre.phase='PRE')::text energy_delta_kwh, COALESCE((SELECT sum(amount_krw) FROM facilities_cost_observations WHERE case_id=c.id),0) total_cost_krw FROM facilities_cases c WHERE c.id=$1 AND c.org_id=$2").bind(id).bind(*p.org_id.as_uuid()).fetch_optional(pool).await.map_err(RestError::db)?.ok_or_else(||RestError::new(StatusCode::NOT_FOUND,"not_found","facilities case was not found"))?;
    let b: Uuid = r.try_get("branch_id").map_err(RestError::db)?;
    if !p.branch_scope.allows(BranchId::from_uuid(b)) {
        return Err(RestError::new(
            StatusCode::NOT_FOUND,
            "not_found",
            "facilities case was not found",
        ));
    }
    Ok(CaseView {
        id: r.try_get("id").map_err(RestError::db)?,
        status: r.try_get("status").map_err(RestError::db)?,
        assignee_id: r.try_get("assignee_id").map_err(RestError::db)?,
        response_due_at: r.try_get("response_due_at").map_err(RestError::db)?,
        completion_due_at: r.try_get("completion_due_at").map_err(RestError::db)?,
        acceptance_due_at: r.try_get("acceptance_due_at").map_err(RestError::db)?,
        energy_delta_kwh: r.try_get("energy_delta_kwh").map_err(RestError::db)?,
        total_cost_krw: r.try_get("total_cost_krw").map_err(RestError::db)?,
    })
}

async fn transition(
    s: &FacilitiesRestState,
    h: &HeaderMap,
    id: Uuid,
    grant: &str,
    to: &str,
    assignee: Option<Uuid>,
    scheduled: Option<time::OffsetDateTime>,
    require_assignee: bool,
) -> Result<Json<CaseView>, RestError> {
    let p = principal(s, h).await?;
    let r = sqlx::query(
        "SELECT status,branch_id,assignee_id FROM facilities_cases WHERE id=$1 AND org_id=$2",
    )
    .bind(id)
    .bind(*p.org_id.as_uuid())
    .fetch_optional(&s.pool)
    .await
    .map_err(RestError::db)?
    .ok_or_else(|| {
        RestError::new(
            StatusCode::NOT_FOUND,
            "not_found",
            "facilities case was not found",
        )
    })?;
    let branch: Uuid = r.try_get("branch_id").map_err(RestError::db)?;
    require_grant(&s.pool, &p, grant, Some(branch)).await?;
    let from: String = r.try_get("status").map_err(RestError::db)?;
    let current: Option<Uuid> = r.try_get("assignee_id").map_err(RestError::db)?;
    if require_assignee && current != Some(*p.user_id.as_uuid()) {
        return Err(RestError::new(
            StatusCode::FORBIDDEN,
            "not_assignee",
            "only the assigned technician may perform this transition",
        ));
    }
    if !legal(&from, to) {
        return Err(RestError::new(
            StatusCode::CONFLICT,
            "illegal_transition",
            "facilities case transition is not legal",
        ));
    }
    let e = event(
        &p,
        "facilities.case.transition",
        id,
        branch,
        Some(serde_json::json!({"status":from})),
        Some(serde_json::json!({"status":to})),
    )?;
    with_audit::<_,(),RestError>(&s.pool,e,|tx|Box::pin(async move {sqlx::query("UPDATE facilities_cases SET status=$1, assignee_id=COALESCE($2,assignee_id), scheduled_for=COALESCE($3,scheduled_for), safety_acknowledged_at=CASE WHEN $1='IN_PROGRESS' THEN now() ELSE safety_acknowledged_at END, updated_at=now() WHERE id=$4 AND org_id=$5").bind(to).bind(assignee).bind(scheduled).bind(id).bind(*p.org_id.as_uuid()).execute(tx.as_mut()).await.map_err(RestError::db)?;history(tx,&p,id,Some(&from),to).await?;Ok(())})).await?;
    get_case_view(&s.pool, &p, id).await.map(Json)
}
fn legal(from: &str, to: &str) -> bool {
    matches!(
        (from, to),
        ("DUE", "TRIAGED")
            | ("TRIAGED", "SCHEDULED")
            | ("SCHEDULED", "ASSIGNED")
            | ("ASSIGNED", "IN_PROGRESS")
            | ("IN_PROGRESS", "SUBMITTED")
            | ("SUBMITTED", "AWAITING_ACCEPTANCE")
            | ("SUBMITTED", "REWORK_REQUIRED")
            | ("REWORK_REQUIRED", "IN_PROGRESS")
            | ("AWAITING_ACCEPTANCE", "CLOSED")
    )
}
async fn triage(
    State(s): State<FacilitiesRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<TriageBody>,
) -> Result<Json<CaseView>, RestError> {
    transition(
        &s,
        &h,
        id,
        "facility_dispatch",
        "TRIAGED",
        None,
        Some(b.scheduled_for),
        false,
    )
    .await?;
    transition(
        &s,
        &h,
        id,
        "facility_dispatch",
        "SCHEDULED",
        None,
        Some(b.scheduled_for),
        false,
    )
    .await
}
async fn assign(
    State(s): State<FacilitiesRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<AssignBody>,
) -> Result<Json<CaseView>, RestError> {
    transition(
        &s,
        &h,
        id,
        "facility_dispatch",
        "ASSIGNED",
        Some(b.assignee_id),
        None,
        false,
    )
    .await
}
async fn start(
    State(s): State<FacilitiesRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<CaseView>, RestError> {
    transition(
        &s,
        &h,
        id,
        "facility_execute",
        "IN_PROGRESS",
        None,
        None,
        true,
    )
    .await
}
async fn submit(
    State(s): State<FacilitiesRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<SubmitBody>,
) -> Result<Json<CaseView>, RestError> {
    let p = principal(&s, &h).await?;
    for (kind, evidence) in [
        ("SAFETY_CHECKLIST", b.safety_checklist_evidence_id),
        ("SERVICE_REPORT", b.service_report_evidence_id),
    ] {
        let ok:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM docs_evidence_objects WHERE id=$1 AND org_id=$2 AND admissibility_status='ADMISSIBLE')").bind(evidence).bind(*p.org_id.as_uuid()).fetch_one(&s.pool).await.map_err(RestError::db)?;
        if !ok {
            return Err(RestError::new(
                StatusCode::PRECONDITION_FAILED,
                "evidence_not_confirmed",
                "required evidence must be a real confirmed evidence object",
            ));
        }
        sqlx::query("INSERT INTO facilities_execution_evidence_links(org_id,case_id,evidence_id,evidence_kind,linked_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT (org_id,case_id,evidence_kind) DO NOTHING").bind(*p.org_id.as_uuid()).bind(id).bind(evidence).bind(kind).bind(*p.user_id.as_uuid()).execute(&s.pool).await.map_err(RestError::db)?;
    }
    let v = transition(
        &s,
        &h,
        id,
        "facility_execute",
        "SUBMITTED",
        None,
        None,
        true,
    )
    .await?;
    transition(
        &s,
        &h,
        id,
        "facility_execute",
        "AWAITING_ACCEPTANCE",
        None,
        None,
        true,
    )
    .await
    .or(Ok(v))
}
async fn acceptance(
    State(s): State<FacilitiesRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<AcceptanceBody>,
) -> Result<Json<CaseView>, RestError> {
    let to = match b.decision.as_str() {
        "ACCEPTED" => "CLOSED",
        "REJECTED" => "REWORK_REQUIRED",
        _ => {
            return Err(RestError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "validation",
                "decision must be ACCEPTED or REJECTED",
            ));
        }
    };
    let p = principal(&s, &h).await?;
    sqlx::query("INSERT INTO facilities_acceptances(org_id,case_id,decision,reason,actor_id) VALUES($1,$2,$3,$4,$5)").bind(*p.org_id.as_uuid()).bind(id).bind(&b.decision).bind(b.reason).bind(*p.user_id.as_uuid()).execute(&s.pool).await.map_err(RestError::db)?;
    transition(&s, &h, id, "facility_accept", to, None, None, false).await
}
async fn observe(
    State(s): State<FacilitiesRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<ObservationBody>,
) -> Result<Json<CaseView>, RestError> {
    let p = principal(&s, &h).await?;
    require_grant(&s.pool, &p, "facility_observe", None).await?;
    for (phase, value) in [("PRE", b.pre_kwh), ("POST", b.post_kwh)] {
        if let Some(kwh) = value {
            sqlx::query("INSERT INTO facilities_energy_observations(org_id,case_id,phase,source,observed_at,kwh,recorded_by) VALUES($1,$2,$3,'MANUAL',$4,$5,$6) ON CONFLICT (org_id,case_id,phase) DO NOTHING").bind(*p.org_id.as_uuid()).bind(id).bind(phase).bind(b.observed_at).bind(kwh).bind(*p.user_id.as_uuid()).execute(&s.pool).await.map_err(RestError::db)?;
        }
    }
    if let Some(cost) = b.cost_krw {
        sqlx::query("INSERT INTO facilities_cost_observations(org_id,case_id,source,observed_at,currency,amount_krw,recorded_by) VALUES($1,$2,'MANUAL',$3,'KRW',$4,$5)").bind(*p.org_id.as_uuid()).bind(id).bind(b.observed_at).bind(cost).bind(*p.user_id.as_uuid()).execute(&s.pool).await.map_err(RestError::db)?;
    }
    get_case_view(&s.pool, &p, id).await.map(Json)
}
async fn history(
    tx: &mut Transaction<'_, Postgres>,
    p: &Principal,
    id: Uuid,
    from: Option<&str>,
    to: &str,
) -> Result<(), RestError> {
    sqlx::query("INSERT INTO facilities_case_history(org_id,case_id,from_status,to_status,actor_id,receipt) VALUES($1,$2,$3,$4,$5,jsonb_build_object('actorId',$5,'transition',concat(coalesce($3,''),'->',$4)))").bind(*p.org_id.as_uuid()).bind(id).bind(from).bind(to).bind(*p.user_id.as_uuid()).execute(tx.as_mut()).await.map_err(RestError::db)?;
    Ok(())
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
    fn db(e: sqlx::Error) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "database", e.to_string())
    }
    fn kernel(e: KernelError) -> Self {
        Self::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation",
            e.to_string(),
        )
    }
}
impl From<DbError> for RestError {
    fn from(e: DbError) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "database", e.to_string())
    }
}
impl IntoResponse for RestError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(serde_json::json!({"code":self.code,"message":self.message})),
        )
            .into_response()
    }
}
