use std::collections::{BTreeMap, BTreeSet};
use std::io::Cursor;

use axum::extract::{DefaultBodyLimit, Multipart, Path, Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use calamine::{Data, DataType, Reader, Xlsx};
use mnt_kernel_core::{
    AuditAction, AuditEvent, BranchScope, ErrorKind, KernelError, OrgId, TraceContext, UserId,
};
use mnt_platform_auth::JwtVerifier;
use mnt_platform_authz::{Action, Feature, Principal, authorize_org_wide};
use mnt_platform_db::{DbError, with_audit, with_audits, with_org_conn};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, QueryBuilder, Row};
use time::OffsetDateTime;
use uuid::Uuid;

pub const EMPLOYEES_PATH: &str = "/api/v1/employees";
pub const EMPLOYEES_IMPORT_PATH: &str = "/api/v1/employees/import";
pub const EMPLOYEES_IMPORT_PREVIEW_PATH: &str = "/api/v1/employees/import/preview";
pub const EMPLOYEES_IMPORT_DRY_RUN_PATH_TEMPLATE: &str =
    "/api/v1/employees/import/{run_id}/dry-run";
pub const EMPLOYEES_IMPORT_APPLY_PATH_TEMPLATE: &str = "/api/v1/employees/import/{run_id}/apply";
pub const EMPLOYEES_EXPORT_CSV_PATH: &str = "/api/v1/employees/export.csv";
pub const EMPLOYEE_LIFECYCLE_EVENTS_PATH_TEMPLATE: &str = "/api/v1/employees/{id}/lifecycle-events";
pub const HR_ORG_CHART_PATH: &str = "/api/v1/hr/org-chart";
pub const HR_LEAVE_BALANCES_PATH: &str = "/api/v1/hr/leave-balances";
pub const HR_ATTENDANCE_SUMMARY_PATH: &str = "/api/v1/hr/attendance-summary";
pub const HR_READINESS_SUMMARY_PATH: &str = "/api/v1/hr/readiness-summary";
pub const HR_ATTENDANCE_IMPORT_PREVIEW_PATH: &str = "/api/v1/hr/attendance-import/preview";
pub const HR_ATTENDANCE_IMPORT_DRY_RUN_PATH_TEMPLATE: &str =
    "/api/v1/hr/attendance-import/{run_id}/dry-run";
pub const HR_ATTENDANCE_IMPORT_APPLY_PATH_TEMPLATE: &str =
    "/api/v1/hr/attendance-import/{run_id}/apply";
pub const HR_ATTENDANCE_IMPORT_SUMMARY_PATH: &str = "/api/v1/hr/attendance-import/summary";
pub const HR_MY_ATTENDANCE_RECORDS_PATH: &str = "/api/v1/hr/attendance-records/me";
pub const HR_ATTENDANCE_RECORDS_PATH: &str = "/api/v1/hr/attendance-records";
const MAX_IMPORT_BYTES: usize = 16 * 1024 * 1024;
const MAX_IMPORT_HEADER_SCAN_ROWS: usize = 25;
const DEFAULT_LIMIT: i64 = 500;
const MAX_LIMIT: i64 = 1000;

#[derive(Debug, Clone)]
pub struct HrState {
    pool: PgPool,
    jwt_verifier: Option<JwtVerifier>,
}

impl HrState {
    #[must_use]
    pub fn new(pool: PgPool, jwt_verifier: Option<JwtVerifier>) -> Self {
        Self { pool, jwt_verifier }
    }
}

pub fn router(state: HrState) -> Router {
    let verifier = state.jwt_verifier.clone();
    let pool = state.pool.clone();
    let router = Router::new()
        .route(EMPLOYEES_PATH, get(list_employees))
        .route(HR_ORG_CHART_PATH, get(get_hr_org_chart))
        .route(HR_LEAVE_BALANCES_PATH, get(list_leave_balances))
        .route(HR_ATTENDANCE_SUMMARY_PATH, get(list_attendance_summary))
        .route(HR_READINESS_SUMMARY_PATH, get(get_hr_readiness_summary))
        .route(
            HR_ATTENDANCE_IMPORT_PREVIEW_PATH,
            post(preview_attendance_import).layer(DefaultBodyLimit::max(MAX_IMPORT_BYTES)),
        )
        .route(
            HR_ATTENDANCE_IMPORT_DRY_RUN_PATH_TEMPLATE,
            post(dry_run_attendance_import),
        )
        .route(
            HR_ATTENDANCE_IMPORT_APPLY_PATH_TEMPLATE,
            post(apply_attendance_import),
        )
        .route(
            HR_ATTENDANCE_IMPORT_SUMMARY_PATH,
            get(list_attendance_import_summary),
        )
        .route(
            HR_MY_ATTENDANCE_RECORDS_PATH,
            get(list_my_attendance_records).post(create_my_attendance_record),
        )
        .route(HR_ATTENDANCE_RECORDS_PATH, get(list_attendance_records))
        .route(
            EMPLOYEES_IMPORT_PATH,
            post(import_employees).layer(DefaultBodyLimit::max(MAX_IMPORT_BYTES)),
        )
        .route(
            EMPLOYEES_IMPORT_PREVIEW_PATH,
            post(preview_employee_import).layer(DefaultBodyLimit::max(MAX_IMPORT_BYTES)),
        )
        .route(
            EMPLOYEES_IMPORT_DRY_RUN_PATH_TEMPLATE,
            post(dry_run_employee_import),
        )
        .route(
            EMPLOYEES_IMPORT_APPLY_PATH_TEMPLATE,
            post(apply_employee_import),
        )
        .route(EMPLOYEES_EXPORT_CSV_PATH, get(export_employees_csv))
        .route(
            EMPLOYEE_LIFECYCLE_EVENTS_PATH_TEMPLATE,
            get(list_employee_lifecycle_events).post(create_employee_lifecycle_event),
        )
        .with_state(state);
    mnt_platform_request_context::with_request_context(router, verifier, pool)
}

#[derive(Debug, Deserialize)]
struct EmployeeListQuery {
    company: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Debug, Serialize)]
struct EmployeePage {
    items: Vec<EmployeeResponse>,
    total: i64,
    limit: i64,
    offset: i64,
}

#[derive(Debug, Serialize)]
struct EmployeeResponse {
    id: Uuid,
    company: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    employee_number: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    org_unit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    worksite_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    worksite: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    job: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    position: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hire_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    leave_accrued: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    leave_used: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    leave_remaining: Option<String>,
    identity_resolution_strategy: String,
    identity_resolution_confidence: String,
    identity_review_required: bool,
    identity_name_only_merge: bool,
    created_at: time::OffsetDateTime,
    updated_at: time::OffsetDateTime,
}

#[derive(Debug, Serialize)]
struct HrOrgChartResponse {
    companies: Vec<HrOrgChartCompany>,
}

#[derive(Debug, Serialize)]
struct HrOrgChartCompany {
    company: String,
    total: i64,
    active: i64,
    units: Vec<HrOrgChartUnit>,
}

#[derive(Debug, Serialize)]
struct HrOrgChartUnit {
    name: String,
    total: i64,
    positions: Vec<HrOrgChartPosition>,
}

#[derive(Debug, Serialize)]
struct HrOrgChartPosition {
    title: String,
    total: i64,
    employees: Vec<HrOrgChartEmployee>,
}

#[derive(Debug, Serialize)]
struct HrOrgChartEmployee {
    id: Uuid,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    employee_number: Option<String>,
    status: String,
}

#[derive(Debug, Serialize)]
struct LeaveBalancePage {
    items: Vec<LeaveBalanceItem>,
    total: i64,
    limit: i64,
    offset: i64,
    summary: LeaveBalanceSummary,
}

#[derive(Debug, Serialize)]
struct LeaveBalanceItem {
    id: Uuid,
    company: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    employee_number: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    org_unit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    position: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    leave_accrued: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    leave_used: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    leave_remaining: Option<String>,
}

#[derive(Debug, Serialize)]
struct LeaveBalanceSummary {
    accrued: String,
    used: String,
    remaining: String,
}

#[derive(Debug, Serialize)]
struct AttendanceSummaryPage {
    items: Vec<AttendanceSummaryItem>,
    total: i64,
    limit: i64,
    offset: i64,
}

#[derive(Debug, Serialize)]
struct AttendanceSummaryItem {
    user_id: Uuid,
    display_name: String,
    arrivals: i64,
    departures: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_event_at: Option<time::OffsetDateTime>,
}
#[derive(Debug, Deserialize)]
struct AttendanceRecordsQuery {
    limit: Option<i64>,
    offset: Option<i64>,
    employee_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
struct CreateEmployeeAttendanceRecordRequest {
    kind: String,
    #[serde(default)]
    idempotency_key: Option<String>,
    #[serde(default)]
    note: Option<String>,
}

#[derive(Debug, Serialize)]
struct EmployeeAttendanceRecordPage {
    items: Vec<EmployeeAttendanceRecordResponse>,
    total: i64,
    limit: i64,
    offset: i64,
}

#[derive(Debug, Clone, Serialize)]
struct EmployeeAttendanceRecordResponse {
    id: Uuid,
    employee_id: Uuid,
    employee_display_name: String,
    kind: String,
    occurred_at: time::OffsetDateTime,
    work_date: String,
    state_after: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    payroll_material_ref_id: Uuid,
    payroll_link_status: String,
    duplicate: bool,
}

#[derive(Debug, Clone)]
struct LinkedEmployee {
    employee_id: Uuid,
    display_name: String,
}

#[derive(Debug, Serialize)]
struct HrReadinessSummary {
    imports: HrImportReadinessSummary,
    payroll: HrPayrollReadinessSummary,
    annual_leave: HrAnnualLeaveReadinessSummary,
    attendance: HrAttendanceReadinessSummary,
}

#[derive(Debug, Serialize)]
struct HrImportReadinessSummary {
    runs: i64,
    applied_runs: i64,
    input_rows: i64,
    candidate_rows: i64,
    preserved_rows: i64,
    ledger_rows: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    latest_import_at: Option<time::OffsetDateTime>,
}

#[derive(Debug, Serialize)]
struct HrPayrollReadinessSummary {
    draft_runs: i64,
    blocked_runs: i64,
    calculation_enabled_runs: i64,
    draft_lines: i64,
    payroll_source_rows: i64,
    attendance_source_rows: i64,
    attendance_event_links: i64,
    attendance_material_refs: i64,
    gross_pay_source_lines: i64,
    net_pay_source_lines: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    latest_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    latest_source_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    latest_period_start: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    latest_period_end: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    latest_updated_at: Option<time::OffsetDateTime>,
}

#[derive(Debug, Serialize)]
struct HrAnnualLeaveReadinessSummary {
    obligations: i64,
    usage_promotion_required: i64,
    payout_review_required: i64,
    needs_review: i64,
    remaining_days: String,
}

#[derive(Debug, Serialize)]
struct HrAttendanceReadinessSummary {
    durable_events: i64,
    self_service_records: i64,
    payroll_material_refs: i64,
}

#[derive(Debug, Deserialize)]
struct CreateEmployeeLifecycleEventRequest {
    event_type: String,
    #[serde(default)]
    to_status: Option<String>,
    #[serde(default)]
    to_company: Option<String>,
    #[serde(default)]
    to_org_unit: Option<String>,
    #[serde(default)]
    to_position: Option<String>,
    effective_date: String,
    comment: String,
    signoffs: EmployeeLifecycleSignoffs,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
struct EmployeeLifecycleSignoffs {
    #[serde(default)]
    privacy_notice_ack: bool,
    #[serde(default)]
    korean_labor_law_ack: bool,
    #[serde(default)]
    payroll_cutoff_ack: bool,
    #[serde(default)]
    retirement_settlement_ack: bool,
}

#[derive(Debug, Serialize)]
struct EmployeeLifecycleEventPage {
    items: Vec<EmployeeLifecycleEventResponse>,
}

#[derive(Debug, Serialize)]
struct EmployeeLifecycleEventResponse {
    id: Uuid,
    employee_id: Uuid,
    event_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    from_status: Option<String>,
    to_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    from_company: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    to_company: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    from_org_unit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    to_org_unit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    from_position: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    to_position: Option<String>,
    effective_date: String,
    comment: String,
    signoffs: EmployeeLifecycleSignoffs,
    created_by: Uuid,
    created_at: time::OffsetDateTime,
}

#[derive(Debug)]
struct EmployeeForLifecycle {
    company: String,
    org_unit: Option<String>,
    position: Option<String>,
    employment_status: String,
}

#[derive(Debug, Deserialize)]
struct HrListQuery {
    limit: Option<i64>,
    offset: Option<i64>,
}

async fn list_employees(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<EmployeeListQuery>,
) -> Result<Json<EmployeePage>, HrError> {
    authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryRead)?;
    record_hr_read("employees");
    let org = principal.org_id;
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let offset = query.offset.unwrap_or(0).max(0);
    let company = query
        .company
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());

    let (items, total) = with_org_conn::<_, _, HrError>(&state.pool, org, move |tx| {
        Box::pin(async move {
            let mut count = QueryBuilder::<Postgres>::new("SELECT count(*) FROM employees WHERE TRUE");
            if let Some(company) = company.as_deref() {
                count.push(" AND company = ");
                count.push_bind(company);
            }
            let total: i64 = count.build_query_scalar().fetch_one(tx.as_mut()).await?;

            let mut rows = QueryBuilder::<Postgres>::new(
                "SELECT id, company, name, employee_number, org_unit, job, position, worksite_name, worksite_address, hire_date, exit_date, employment_status, leave_accrued::TEXT AS leave_accrued, leave_used::TEXT AS leave_used, leave_remaining::TEXT AS leave_remaining, identity_resolution_strategy, identity_resolution_confidence, identity_review_required, identity_name_only_merge, created_at, updated_at FROM employees WHERE TRUE",
            );
            if let Some(company) = company.as_deref() {
                rows.push(" AND company = ");
                rows.push_bind(company);
            }
            rows.push(" ORDER BY company ASC, name ASC, source_sheet ASC, source_row ASC LIMIT ");
            rows.push_bind(limit);
            rows.push(" OFFSET ");
            rows.push_bind(offset);

            let items = rows
                .build()
                .fetch_all(tx.as_mut())
                .await?
                .into_iter()
                .map(employee_from_row)
                .collect::<Result<Vec<_>, _>>()?;
            Ok((items, total))
        })
    })
    .await?;

    Ok(Json(EmployeePage {
        items,
        total,
        limit,
        offset,
    }))
}

async fn get_hr_org_chart(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<HrOrgChartResponse>, HrError> {
    authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryRead)?;
    record_hr_read("org_chart");
    let org = principal.org_id;

    let companies = with_org_conn::<_, _, HrError>(&state.pool, org, move |tx| {
        Box::pin(async move {
            let rows = sqlx::query(
                r#"
                SELECT
                    id,
                    company,
                    name,
                    employee_number,
                    COALESCE(NULLIF(org_unit, ''), '소속 미지정') AS org_unit,
                    COALESCE(NULLIF(position, ''), '직책 미지정') AS position,
                    employment_status
                FROM employees
                ORDER BY company ASC, org_unit ASC, position ASC, name ASC, source_sheet ASC, source_row ASC
                LIMIT 5000
                "#,
            )
            .fetch_all(tx.as_mut())
            .await?;

            let mut companies = Vec::<HrOrgChartCompany>::new();
            for row in rows {
                let company: String = row.try_get("company")?;
                let unit: String = row.try_get("org_unit")?;
                let position: String = row.try_get("position")?;
                let status: String = row.try_get("employment_status")?;

                let company_index = find_or_insert_company(&mut companies, company);
                let company = &mut companies[company_index];
                company.total += 1;
                if status == "ACTIVE" {
                    company.active += 1;
                }

                let unit_index = find_or_insert_unit(&mut company.units, unit);
                let unit = &mut company.units[unit_index];
                unit.total += 1;

                let position_index = find_or_insert_position(&mut unit.positions, position);
                let position = &mut unit.positions[position_index];
                position.total += 1;
                position.employees.push(HrOrgChartEmployee {
                    id: row.try_get("id")?,
                    name: row.try_get("name")?,
                    employee_number: row.try_get("employee_number")?,
                    status,
                });
            }
            Ok(companies)
        })
    })
    .await?;

    Ok(Json(HrOrgChartResponse { companies }))
}

async fn list_leave_balances(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<HrListQuery>,
) -> Result<Json<LeaveBalancePage>, HrError> {
    authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryRead)?;
    record_hr_read("leave_balances");
    let org = principal.org_id;
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let offset = query.offset.unwrap_or(0).max(0);

    let (items, total, summary) = with_org_conn::<_, _, HrError>(&state.pool, org, move |tx| {
        Box::pin(async move {
            let total: i64 = sqlx::query_scalar(
                r#"
                SELECT count(*)
                FROM employees
                WHERE leave_accrued IS NOT NULL
                   OR leave_used IS NOT NULL
                   OR leave_remaining IS NOT NULL
                "#,
            )
            .fetch_one(tx.as_mut())
            .await?;

            let summary_row = sqlx::query(
                r#"
                SELECT
                    COALESCE(SUM(leave_accrued), 0)::TEXT AS accrued,
                    COALESCE(SUM(leave_used), 0)::TEXT AS used,
                    COALESCE(SUM(leave_remaining), 0)::TEXT AS remaining
                FROM employees
                WHERE leave_accrued IS NOT NULL
                   OR leave_used IS NOT NULL
                   OR leave_remaining IS NOT NULL
                "#,
            )
            .fetch_one(tx.as_mut())
            .await?;
            let summary = LeaveBalanceSummary {
                accrued: summary_row.try_get("accrued")?,
                used: summary_row.try_get("used")?,
                remaining: summary_row.try_get("remaining")?,
            };

            let items = sqlx::query(
                r#"
                SELECT
                    id,
                    company,
                    name,
                    employee_number,
                    org_unit,
                    position,
                    leave_accrued::TEXT AS leave_accrued,
                    leave_used::TEXT AS leave_used,
                    leave_remaining::TEXT AS leave_remaining
                FROM employees
                WHERE leave_accrued IS NOT NULL
                   OR leave_used IS NOT NULL
                   OR leave_remaining IS NOT NULL
                ORDER BY company ASC, name ASC, source_sheet ASC, source_row ASC
                LIMIT $1 OFFSET $2
                "#,
            )
            .bind(limit)
            .bind(offset)
            .fetch_all(tx.as_mut())
            .await?
            .into_iter()
            .map(|row| {
                Ok(LeaveBalanceItem {
                    id: row.try_get("id")?,
                    company: row.try_get("company")?,
                    name: row.try_get("name")?,
                    employee_number: row.try_get("employee_number")?,
                    org_unit: row.try_get("org_unit")?,
                    position: row.try_get("position")?,
                    leave_accrued: row.try_get("leave_accrued")?,
                    leave_used: row.try_get("leave_used")?,
                    leave_remaining: row.try_get("leave_remaining")?,
                })
            })
            .collect::<Result<Vec<_>, HrError>>()?;

            Ok((items, total, summary))
        })
    })
    .await?;

    Ok(Json(LeaveBalancePage {
        items,
        total,
        limit,
        offset,
        summary,
    }))
}

async fn list_attendance_summary(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<HrListQuery>,
) -> Result<Json<AttendanceSummaryPage>, HrError> {
    authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryRead)?;
    record_hr_read("attendance_summary");
    let org = principal.org_id;
    let scope = principal.branch_scope.clone();
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let offset = query.offset.unwrap_or(0).max(0);

    let (items, total) = with_org_conn::<_, _, HrError>(&state.pool, org, move |tx| {
        Box::pin(async move {
            let mut total_query = QueryBuilder::<Postgres>::new(
                "SELECT COUNT(*) FROM (SELECT l.user_id FROM site_attendance_events l WHERE ",
            );
            push_attendance_branch_scope(&mut total_query, &scope);
            total_query.push(" GROUP BY l.user_id) counted");
            let total: i64 = total_query
                .build_query_scalar()
                .fetch_one(tx.as_mut())
                .await?;

            let mut rows_query = QueryBuilder::<Postgres>::new(
                r#"
                SELECT
                    l.user_id,
                    COALESCE(u.display_name, '사용자 미확인') AS display_name,
                    COUNT(*) FILTER (WHERE l.kind = 'ARRIVAL') AS arrivals,
                    COUNT(*) FILTER (WHERE l.kind = 'DEPARTURE') AS departures,
                    (ARRAY_AGG(l.kind ORDER BY l.occurred_at DESC))[1] AS last_kind,
                    MAX(l.occurred_at) AS last_event_at
                FROM site_attendance_events l
                LEFT JOIN users u ON u.id = l.user_id
                WHERE
                "#,
            );
            push_attendance_branch_scope(&mut rows_query, &scope);
            rows_query.push(
                " GROUP BY l.user_id, u.display_name ORDER BY last_event_at DESC, l.user_id DESC LIMIT ",
            );
            rows_query.push_bind(limit);
            rows_query.push(" OFFSET ");
            rows_query.push_bind(offset);

            let items = rows_query
                .build()
                .fetch_all(tx.as_mut())
                .await?
                .into_iter()
                .map(|row| {
                    Ok(AttendanceSummaryItem {
                        user_id: row.try_get("user_id")?,
                        display_name: row.try_get("display_name")?,
                        arrivals: row.try_get("arrivals")?,
                        departures: row.try_get("departures")?,
                        last_kind: row.try_get("last_kind")?,
                        last_event_at: row.try_get("last_event_at")?,
                    })
                })
                .collect::<Result<Vec<_>, HrError>>()?;

            Ok((items, total))
        })
    })
    .await?;

    Ok(Json(AttendanceSummaryPage {
        items,
        total,
        limit,
        offset,
    }))
}
async fn list_my_attendance_records(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<AttendanceRecordsQuery>,
) -> Result<Json<EmployeeAttendanceRecordPage>, HrError> {
    record_hr_read("employee_attendance_self");
    let org = principal.org_id;
    let user_id = principal.user_id;
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let offset = query.offset.unwrap_or(0).max(0);

    let page = with_org_conn::<_, _, HrError>(&state.pool, org, move |tx| {
        Box::pin(async move {
            let linked = load_linked_employee_for_user(tx, org, user_id, false).await?;
            list_attendance_records_for_employee(tx, linked.employee_id, limit, offset).await
        })
    })
    .await?;

    Ok(Json(page))
}

async fn list_attendance_records(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<AttendanceRecordsQuery>,
) -> Result<Json<EmployeeAttendanceRecordPage>, HrError> {
    authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryRead)?;
    record_hr_read("employee_attendance_management");
    let org = principal.org_id;
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let offset = query.offset.unwrap_or(0).max(0);
    let employee_id = query.employee_id;

    let page = with_org_conn::<_, _, HrError>(&state.pool, org, move |tx| {
        Box::pin(async move {
            if let Some(employee_id) = employee_id {
                list_attendance_records_for_employee(tx, employee_id, limit, offset).await
            } else {
                list_attendance_records_for_org(tx, limit, offset).await
            }
        })
    })
    .await?;

    Ok(Json(page))
}

async fn create_my_attendance_record(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Json(body): Json<CreateEmployeeAttendanceRecordRequest>,
) -> Result<Json<EmployeeAttendanceRecordResponse>, HrError> {
    let org = principal.org_id;
    let actor = principal.user_id;
    let kind = normalize_attendance_kind(&body.kind)?;
    let idempotency_key = normalize_idempotency_key(body.idempotency_key)?;
    let note = normalize_attendance_note(body.note)?;

    let response = with_audits::<_, _, HrError>(&state.pool, org, move |tx| {
        Box::pin(async move {
            let linked = load_linked_employee_for_user(tx, org, actor, true).await?;

            if let Some(key) = idempotency_key.as_deref()
                && let Some(existing) =
                    load_attendance_record_by_idempotency_key(tx, linked.employee_id, key).await?
            {
                return Ok((existing, Vec::new()));
            }

            let previous_state: Option<String> = sqlx::query_scalar(
                r#"
                SELECT state_after
                FROM employee_attendance_records
                WHERE employee_id = $1
                ORDER BY occurred_at DESC, created_at DESC, id DESC
                LIMIT 1
                "#,
            )
            .bind(linked.employee_id)
            .fetch_optional(tx.as_mut())
            .await?;
            let state_after = next_employee_attendance_state(previous_state.as_deref(), kind)?;

            let record_row = sqlx::query(
                r#"
                INSERT INTO employee_attendance_records (
                    org_id,
                    employee_id,
                    actor_user_id,
                    kind,
                    state_after,
                    note,
                    idempotency_key
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                RETURNING
                    id,
                    employee_id,
                    kind,
                    occurred_at,
                    work_date::TEXT AS work_date,
                    state_after,
                    note
                "#,
            )
            .bind(*org.as_uuid())
            .bind(linked.employee_id)
            .bind(*actor.as_uuid())
            .bind(kind)
            .bind(state_after)
            .bind(note)
            .bind(idempotency_key)
            .fetch_one(tx.as_mut())
            .await?;

            let record_id: Uuid = record_row.try_get("id")?;
            let work_date: String = record_row.try_get("work_date")?;
            let digest = sha256_hex(
                format!(
                    "employee_self_service|{}|{}|{}|{}",
                    org.as_uuid(),
                    linked.employee_id,
                    record_id,
                    kind
                )
                .as_bytes(),
            );

            let ref_id: Uuid = sqlx::query_scalar(
                r#"
                INSERT INTO payroll_attendance_material_refs (
                    org_id,
                    attendance_record_id,
                    employee_id,
                    work_date,
                    source_digest
                )
                VALUES ($1, $2, $3, $4::DATE, $5)
                RETURNING id
                "#,
            )
            .bind(*org.as_uuid())
            .bind(record_id)
            .bind(linked.employee_id)
            .bind(&work_date)
            .bind(digest)
            .fetch_one(tx.as_mut())
            .await?;

            let response = employee_attendance_record_from_parts(
                record_row,
                linked.display_name,
                ref_id,
                false,
            )?;

            let attendance_audit = AuditEvent::new(
                Some(actor),
                AuditAction::new("employee_attendance.record").map_err(HrError::from_kernel)?,
                "employee_attendance_record",
                record_id.to_string(),
                TraceContext::generate(),
                OffsetDateTime::now_utc(),
            )
            .with_org(org)
            .with_snapshots(
                None,
                Some(json!({
                    "employee_id": linked.employee_id,
                    "kind": response.kind,
                    "state_after": response.state_after,
                    "work_date": response.work_date,
                    "payroll_material_ref_id": ref_id,
                })),
            );
            let payroll_audit = AuditEvent::new(
                Some(actor),
                AuditAction::new("payroll_attendance.link").map_err(HrError::from_kernel)?,
                "payroll_attendance_material_ref",
                ref_id.to_string(),
                TraceContext::generate(),
                OffsetDateTime::now_utc(),
            )
            .with_org(org)
            .with_snapshots(
                None,
                Some(json!({
                    "attendance_record_id": record_id,
                    "employee_id": linked.employee_id,
                    "work_date": response.work_date,
                    "source_type": "employee_self_service",
                })),
            );

            Ok((response, vec![attendance_audit, payroll_audit]))
        })
    })
    .await?;

    Ok(Json(response))
}

async fn get_hr_readiness_summary(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<HrReadinessSummary>, HrError> {
    authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryRead)?;
    record_hr_read("readiness_summary");
    let org = principal.org_id;
    let scope = principal.branch_scope.clone();

    let summary = with_org_conn::<_, _, HrError>(&state.pool, org, move |tx| {
        Box::pin(async move {
            let import_row = sqlx::query(
                r#"
                SELECT
                    COUNT(*)::BIGINT AS runs,
                    COUNT(*) FILTER (WHERE status = 'APPLIED')::BIGINT AS applied_runs,
                    COALESCE(SUM(input_rows), 0)::BIGINT AS input_rows,
                    COALESCE(SUM(candidate_rows), 0)::BIGINT AS candidate_rows,
                    COALESCE(SUM(preserved_rows), 0)::BIGINT AS preserved_rows,
                    MAX(COALESCE(applied_at, updated_at, created_at)) AS latest_import_at
                FROM data_import_runs
                WHERE entity_type = 'employee_hr'
                "#,
            )
            .fetch_one(tx.as_mut())
            .await?;

            let ledger_rows: i64 = sqlx::query_scalar(
                r#"
                SELECT COUNT(*)::BIGINT
                FROM data_import_rows r
                JOIN data_import_runs run
                  ON run.id = r.run_id
                 AND run.org_id = r.org_id
                WHERE run.entity_type = 'employee_hr'
                "#,
            )
            .fetch_one(tx.as_mut())
            .await?;

            let payroll_run_row = sqlx::query(
                r#"
                SELECT
                    COUNT(*)::BIGINT AS draft_runs,
                    COUNT(*) FILTER (WHERE status = 'BLOCKED_LEGAL_GATE')::BIGINT AS blocked_runs,
                    COUNT(*) FILTER (WHERE calculation_enabled)::BIGINT AS calculation_enabled_runs,
                    (ARRAY_AGG(status ORDER BY updated_at DESC, id DESC))[1] AS latest_status,
                    (ARRAY_AGG(source_label ORDER BY updated_at DESC, id DESC))[1] AS latest_source_label,
                    (ARRAY_AGG(period_start::TEXT ORDER BY updated_at DESC, id DESC))[1] AS latest_period_start,
                    (ARRAY_AGG(period_end::TEXT ORDER BY updated_at DESC, id DESC))[1] AS latest_period_end,
                    MAX(updated_at) AS latest_updated_at
                FROM payroll_draft_runs
                "#,
            )
            .fetch_one(tx.as_mut())
            .await?;

            let payroll_line_row = sqlx::query(
                r#"
                SELECT
                    COUNT(*)::BIGINT AS draft_lines,
                    COALESCE(SUM(payroll_source_row_count), 0)::BIGINT AS payroll_source_rows,
                    COALESCE(SUM(attendance_source_row_count), 0)::BIGINT AS attendance_source_rows,
                    COALESCE(SUM(attendance_event_count), 0)::BIGINT AS attendance_event_links,
                    COUNT(*) FILTER (WHERE gross_pay_source_present)::BIGINT AS gross_pay_source_lines,
                    COUNT(*) FILTER (WHERE net_pay_source_present)::BIGINT AS net_pay_source_lines
                FROM payroll_draft_lines
                "#,
            )
            .fetch_one(tx.as_mut())
            .await?;

            let leave_row = sqlx::query(
                r#"
                SELECT
                    COUNT(*)::BIGINT AS obligations,
                    COUNT(*) FILTER (WHERE status = 'USAGE_PROMOTION_DRAFT_REQUIRED')::BIGINT AS usage_promotion_required,
                    COUNT(*) FILTER (WHERE status = 'PAYOUT_REVIEW_REQUIRED')::BIGINT AS payout_review_required,
                    COUNT(*) FILTER (WHERE status = 'NEEDS_HR_REVIEW')::BIGINT AS needs_review,
                    COALESCE(SUM(leave_remaining), 0)::TEXT AS remaining_days
                FROM annual_leave_obligations
                "#,
            )
            .fetch_one(tx.as_mut())
            .await?;

            let mut attendance_query =
                QueryBuilder::<Postgres>::new("SELECT COUNT(*)::BIGINT FROM site_attendance_events l WHERE ");
            push_attendance_branch_scope(&mut attendance_query, &scope);
            let durable_events: i64 = attendance_query
                .build_query_scalar()
                .fetch_one(tx.as_mut())
                .await?;
            let self_service_records: i64 = sqlx::query_scalar(
                "SELECT COUNT(*)::BIGINT FROM employee_attendance_records",
            )
            .fetch_one(tx.as_mut())
            .await?;
            let attendance_material_refs: i64 = sqlx::query_scalar(
                "SELECT COUNT(*)::BIGINT FROM payroll_attendance_material_refs",
            )
            .fetch_one(tx.as_mut())
            .await?;


            Ok(HrReadinessSummary {
                imports: HrImportReadinessSummary {
                    runs: import_row.try_get("runs")?,
                    applied_runs: import_row.try_get("applied_runs")?,
                    input_rows: import_row.try_get("input_rows")?,
                    candidate_rows: import_row.try_get("candidate_rows")?,
                    preserved_rows: import_row.try_get("preserved_rows")?,
                    ledger_rows,
                    latest_import_at: import_row.try_get("latest_import_at")?,
                },
                payroll: HrPayrollReadinessSummary {
                    draft_runs: payroll_run_row.try_get("draft_runs")?,
                    blocked_runs: payroll_run_row.try_get("blocked_runs")?,
                    calculation_enabled_runs: payroll_run_row
                        .try_get("calculation_enabled_runs")?,
                    draft_lines: payroll_line_row.try_get("draft_lines")?,
                    payroll_source_rows: payroll_line_row.try_get("payroll_source_rows")?,
                    attendance_source_rows: payroll_line_row
                        .try_get("attendance_source_rows")?,
                    attendance_event_links: payroll_line_row.try_get("attendance_event_links")?,
                    attendance_material_refs,
                    gross_pay_source_lines: payroll_line_row
                        .try_get("gross_pay_source_lines")?,
                    net_pay_source_lines: payroll_line_row.try_get("net_pay_source_lines")?,
                    latest_status: payroll_run_row.try_get("latest_status")?,
                    latest_source_label: payroll_run_row.try_get("latest_source_label")?,
                    latest_period_start: payroll_run_row.try_get("latest_period_start")?,
                    latest_period_end: payroll_run_row.try_get("latest_period_end")?,
                    latest_updated_at: payroll_run_row.try_get("latest_updated_at")?,
                },
                annual_leave: HrAnnualLeaveReadinessSummary {
                    obligations: leave_row.try_get("obligations")?,
                    usage_promotion_required: leave_row
                        .try_get("usage_promotion_required")?,
                    payout_review_required: leave_row.try_get("payout_review_required")?,
                    needs_review: leave_row.try_get("needs_review")?,
                    remaining_days: leave_row.try_get("remaining_days")?,
                },
                attendance: HrAttendanceReadinessSummary {
                    durable_events,
                    self_service_records,
                    payroll_material_refs: attendance_material_refs,
                },
            })
        })
    })
    .await?;

    Ok(Json(summary))
}

async fn preview_attendance_import(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    multipart: Multipart,
) -> Result<Json<AttendanceImportPreviewResponse>, HrError> {
    authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
    let upload = read_attendance_upload(multipart).await?;
    let source_sha256 = sha256_hex(&upload.bytes);
    let parsed = parse_attendance_import_upload(&upload.filename, &upload.bytes)?;
    let org = principal.org_id;
    let org_uuid = *org.as_uuid();
    let actor = principal.user_id;
    let run_id = Uuid::new_v4();
    let input_rows = i32::try_from(parsed.rows.len())
        .map_err(|_| HrError::validation("attendance import row count exceeds i32"))?;
    let candidate_rows = i32::try_from(
        parsed
            .rows
            .iter()
            .filter(|row| row.row_status == ImportRowStatus::Candidate)
            .count(),
    )
    .map_err(|_| HrError::validation("attendance candidate row count exceeds i32"))?;
    let preserved_rows = i32::try_from(
        parsed
            .rows
            .iter()
            .filter(|row| row.row_status != ImportRowStatus::Candidate)
            .count(),
    )
    .map_err(|_| HrError::validation("attendance error row count exceeds i32"))?;
    let filename = upload.filename.clone();
    let source_format = attendance_source_format(&filename)?;
    let columns = attendance_import_columns_from_rows(&parsed.rows);
    let mapping_profile = attendance_import_mapping_profile(&columns);
    let audit_after = json!({
        "run_id": run_id,
        "entity_type": "attendance_direct",
        "source_filename": &filename,
        "source_sha256": &source_sha256,
        "input_rows": input_rows,
        "candidate_rows": candidate_rows,
        "preserved_rows": preserved_rows,
        "sensitive_values_returned": false,
        "payroll_effect": "lineage_only_not_payable"
    });
    let event = AuditEvent::new(
        Some(actor),
        AuditAction::new("attendance_import.preview").map_err(HrError::from_kernel)?,
        "data_import_run",
        run_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org)
    .with_snapshots(None, Some(audit_after));

    let preview = with_audit::<_, _, HrError>(&state.pool, event, |tx| {
        let filename = filename.clone();
        let source_sha256 = source_sha256.clone();
        let parsed = parsed.clone();
        let mapping_profile = mapping_profile.clone();
        Box::pin(async move {
            sqlx::query(
                r#"
                INSERT INTO data_import_runs (
                    id, org_id, entity_type, status, source_filename, source_format,
                    source_sha256, mapping_profile, input_rows, candidate_rows,
                    preserved_rows, created_by
                )
                VALUES ($1, $2, 'attendance_direct', 'PREVIEWED', $3, $4, $5, $6, $7, $8, $9, $10)
                "#,
            )
            .bind(run_id)
            .bind(org_uuid)
            .bind(&filename)
            .bind(source_format)
            .bind(&source_sha256)
            .bind(&mapping_profile)
            .bind(input_rows)
            .bind(candidate_rows)
            .bind(preserved_rows)
            .bind(*actor.as_uuid())
            .execute(tx.as_mut())
            .await?;

            for row in &parsed.rows {
                sqlx::query(
                    r#"
                    INSERT INTO data_import_rows (
                        org_id, run_id, source_sheet, source_row, source_key,
                        row_status, raw_row, canonical_row, validation
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    "#,
                )
                .bind(org_uuid)
                .bind(run_id)
                .bind(&row.source_sheet)
                .bind(row.source_row)
                .bind(&row.source_key)
                .bind(row.row_status.as_str())
                .bind(&row.raw_row)
                .bind(attendance_canonical_row_json(row, &source_sha256))
                .bind(attendance_validation_json(row))
                .execute(tx.as_mut())
                .await?;
            }

            Ok(AttendanceImportPreviewResponse::from_rows(
                run_id,
                filename,
                source_sha256,
                parsed.rows,
            ))
        })
    })
    .await?;

    metrics::counter!("hr_attendance_import_runs_total", "stage" => "preview").increment(1);
    Ok(Json(preview))
}

async fn dry_run_attendance_import(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Path(run_id): Path<Uuid>,
) -> Result<Json<AttendanceImportDryRunSummary>, HrError> {
    authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
    let org = principal.org_id;
    let org_uuid = *org.as_uuid();
    let actor = principal.user_id;

    let event = AuditEvent::new(
        Some(actor),
        AuditAction::new("attendance_import.dry_run").map_err(HrError::from_kernel)?,
        "data_import_run",
        run_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org)
    .with_snapshots(
        None,
        Some(json!({ "run_id": run_id, "entity_type": "attendance_direct" })),
    );

    let summary = with_audit::<_, _, HrError>(&state.pool, event, |tx| {
        Box::pin(async move {
            let run = import_run_for_update(tx, org_uuid, run_id).await?;
            ensure_attendance_import_run(&run, &["PREVIEWED", "DRY_RUN"])?;
            let rows = load_attendance_import_rows(tx, org_uuid, run_id).await?;
            let summary = resolve_attendance_import_rows(tx, org_uuid, run_id, &run, &rows).await?;
            sqlx::query(
                r#"
                UPDATE data_import_runs
                SET status = 'DRY_RUN', dry_run_summary = $3, updated_at = now()
                WHERE org_id = $1 AND id = $2
                "#,
            )
            .bind(org_uuid)
            .bind(run_id)
            .bind(json!(&summary))
            .execute(tx.as_mut())
            .await?;
            Ok(summary)
        })
    })
    .await?;

    metrics::counter!("hr_attendance_import_runs_total", "stage" => "dry_run").increment(1);
    Ok(Json(summary))
}

async fn apply_attendance_import(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Path(run_id): Path<Uuid>,
) -> Result<Json<AttendanceImportApplyReport>, HrError> {
    authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
    let org = principal.org_id;
    let org_uuid = *org.as_uuid();
    let actor = principal.user_id;

    let event = AuditEvent::new(
        Some(actor),
        AuditAction::new("attendance_import.apply").map_err(HrError::from_kernel)?,
        "data_import_run",
        run_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org)
    .with_snapshots(
        None,
        Some(json!({ "run_id": run_id, "entity_type": "attendance_direct" })),
    );

    let report = with_audit::<_, _, HrError>(&state.pool, event, |tx| {
            Box::pin(async move {
                let run = import_run_for_update(tx, org_uuid, run_id).await?;
                ensure_attendance_import_run(&run, &["DRY_RUN"])?;
                let rows = load_attendance_import_rows(tx, org_uuid, run_id).await?;
                let summary = resolve_attendance_import_rows(tx, org_uuid, run_id, &run, &rows).await?;
                if !summary.row_errors.is_empty() {
                    return Err(HrError::validation(
                        "cannot apply attendance import with unresolved or invalid rows",
                    ));
                }

                let mut inserted = 0usize;
                for row in summary.ready_rows_for_apply {
                    let insert_result = sqlx::query(
                        r#"
                        INSERT INTO attendance_direct_import_events (
                            org_id, run_id, import_row_id, employee_id, branch_id,
                            source_sheet, source_row, source_key, source_sha256,
                            employee_number, employee_name, branch_name, work_date,
                            check_in_at, check_out_at, minutes_worked, fact_key
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
                        ON CONFLICT (org_id, fact_key) DO NOTHING
                        "#,
                    )
                    .bind(org_uuid)
                    .bind(run_id)
                    .bind(row.import_row_id)
                    .bind(row.employee_id)
                    .bind(row.branch_id)
                    .bind(&row.source_sheet)
                    .bind(row.source_row)
                    .bind(&row.source_key)
                    .bind(&run.source_sha256)
                    .bind(&row.employee_number)
                    .bind(&row.employee_name)
                    .bind(&row.branch_name)
                    .bind(&row.work_date)
                    .bind(&row.check_in_at)
                    .bind(&row.check_out_at)
                    .bind(row.minutes_worked)
                    .bind(&row.fact_key)
                    .execute(tx.as_mut())
                    .await?;
                    inserted += usize::try_from(insert_result.rows_affected()).unwrap_or_default();
                }

                let report = AttendanceImportApplyReport {
                    run_id,
                    inserted,
                    skipped: summary.ready_rows.saturating_sub(inserted),
                    error_rows: 0,
                };
                sqlx::query(
                    r#"
                    UPDATE data_import_runs
                    SET status = 'APPLIED', apply_summary = $3, applied_by = $4,
                        applied_at = now(), updated_at = now()
                    WHERE org_id = $1 AND id = $2
                    "#,
                )
                .bind(org_uuid)
                .bind(run_id)
                .bind(json!(&report))
                .bind(*actor.as_uuid())
                .execute(tx.as_mut())
                .await?;
                Ok(report)
            })
        })
    .await?;

    metrics::counter!("hr_attendance_import_runs_total", "stage" => "apply").increment(1);
    Ok(Json(report))
}

async fn list_attendance_import_summary(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<HrListQuery>,
) -> Result<Json<AttendanceImportSummaryPage>, HrError> {
    authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryRead)?;
    record_hr_read("attendance_import_summary");
    let org = principal.org_id;
    let org_uuid = *org.as_uuid();
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let offset = query.offset.unwrap_or(0).max(0);

    let (items, total) = with_org_conn::<_, _, HrError>(&state.pool, org, move |tx| {
        Box::pin(async move {
            let total: i64 = sqlx::query_scalar(
                r#"
                SELECT COUNT(*)
                FROM data_import_runs
                WHERE org_id = $1 AND entity_type = 'attendance_direct'
                "#,
            )
            .bind(org_uuid)
            .fetch_one(tx.as_mut())
            .await?;

            let items = sqlx::query(
                r#"
                SELECT
                    id, status, source_filename, source_format, source_sha256,
                    input_rows, candidate_rows, preserved_rows,
                    dry_run_summary, apply_summary, created_at, applied_at
                FROM data_import_runs
                WHERE org_id = $1 AND entity_type = 'attendance_direct'
                ORDER BY created_at DESC, id DESC
                LIMIT $2 OFFSET $3
                "#,
            )
            .bind(org_uuid)
            .bind(limit)
            .bind(offset)
            .fetch_all(tx.as_mut())
            .await?
            .into_iter()
            .map(|row| {
                Ok(AttendanceImportSummaryItem {
                    run_id: row.try_get("id")?,
                    status: row.try_get("status")?,
                    source_filename: row.try_get("source_filename")?,
                    source_format: row.try_get("source_format")?,
                    source_sha256: row.try_get("source_sha256")?,
                    input_rows: row.try_get("input_rows")?,
                    candidate_rows: row.try_get("candidate_rows")?,
                    preserved_rows: row.try_get("preserved_rows")?,
                    dry_run_summary: row.try_get("dry_run_summary")?,
                    apply_summary: row.try_get("apply_summary")?,
                    created_at: row.try_get("created_at")?,
                    applied_at: row.try_get("applied_at")?,
                })
            })
            .collect::<Result<Vec<_>, HrError>>()?;

            Ok((items, total))
        })
    })
    .await?;

    Ok(Json(AttendanceImportSummaryPage {
        items,
        total,
        limit,
        offset,
    }))
}
async fn import_employees(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    multipart: Multipart,
) -> Result<Json<EmployeeImportReport>, HrError> {
    authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
    let upload = read_xlsx_upload(multipart).await?;
    let parsed = parse_employee_workbook(&upload.filename, &upload.bytes)?;
    let org = principal.org_id;
    let org_uuid = *org.as_uuid();

    let report = with_org_conn::<_, _, HrError>(&state.pool, org, move |tx| {
        Box::pin(async move { apply_employee_rows_tx(tx, org_uuid, parsed.rows).await })
    })
    .await?;

    record_hr_import(report.inserted, report.updated);
    Ok(Json(report))
}

async fn preview_employee_import(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    multipart: Multipart,
) -> Result<Json<EmployeeImportPreviewResponse>, HrError> {
    authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
    let upload = read_xlsx_upload(multipart).await?;
    let source_sha256 = sha256_hex(&upload.bytes);
    let parsed = parse_employee_import_workbook(&upload.filename, &upload.bytes)?;
    let org = principal.org_id;
    let org_uuid = *org.as_uuid();
    let actor = principal.user_id;
    let run_id = Uuid::new_v4();
    let mapping_profile = employee_import_mapping_profile(&parsed.columns);
    let input_rows = i32::try_from(parsed.input_rows())
        .map_err(|_| HrError::validation("import row count exceeds i32"))?;
    let candidate_rows = i32::try_from(parsed.candidate_rows())
        .map_err(|_| HrError::validation("candidate row count exceeds i32"))?;
    let preserved_rows = i32::try_from(parsed.preserved_rows())
        .map_err(|_| HrError::validation("preserved row count exceeds i32"))?;
    let audit_after = json!({
        "run_id": run_id,
        "entity_type": "employee_hr",
        "source_filename": &upload.filename,
        "source_sha256": &source_sha256,
        "input_rows": input_rows,
        "candidate_rows": candidate_rows,
        "preserved_rows": preserved_rows,
        "sensitive_values_returned": false
    });
    let event = AuditEvent::new(
        Some(actor),
        AuditAction::new("data_import.preview").map_err(HrError::from_kernel)?,
        "data_import_run",
        run_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org)
    .with_snapshots(None, Some(audit_after));

    let preview = with_audit::<_, _, HrError>(&state.pool, event, |tx| {
        let rows = parsed.rows.clone();
        let columns = parsed.columns.clone();
        let filename = upload.filename.clone();
        let source_sha256 = source_sha256.clone();
        let mapping_profile = mapping_profile.clone();
        Box::pin(async move {
            sqlx::query(
                r#"
                INSERT INTO data_import_runs (
                    id, org_id, entity_type, status, source_filename, source_format,
                    source_sha256, mapping_profile, input_rows, candidate_rows,
                    preserved_rows, created_by
                )
                VALUES ($1, $2, 'employee_hr', 'PREVIEWED', $3, 'xlsx', $4, $5, $6, $7, $8, $9)
                "#,
            )
            .bind(run_id)
            .bind(org_uuid)
            .bind(&filename)
            .bind(&source_sha256)
            .bind(&mapping_profile)
            .bind(input_rows)
            .bind(candidate_rows)
            .bind(preserved_rows)
            .bind(*actor.as_uuid())
            .execute(tx.as_mut())
            .await?;

            for row in &rows {
                sqlx::query(
                    r#"
                    INSERT INTO data_import_rows (
                        org_id, run_id, source_sheet, source_row, source_key,
                        row_status, raw_row, canonical_row, validation
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    "#,
                )
                .bind(org_uuid)
                .bind(run_id)
                .bind(&row.source_sheet)
                .bind(row.source_row)
                .bind(&row.source_key)
                .bind(row.row_status.as_str())
                .bind(&row.raw_row)
                .bind(import_canonical_row_json(row))
                .bind(import_validation_json(row))
                .execute(tx.as_mut())
                .await?;
            }

            Ok(EmployeeImportPreviewResponse::from_rows(
                run_id,
                filename,
                source_sha256,
                columns,
                rows,
            ))
        })
    })
    .await?;

    metrics::counter!("hr_data_import_runs_total", "stage" => "preview").increment(1);
    Ok(Json(preview))
}

async fn dry_run_employee_import(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Path(run_id): Path<Uuid>,
) -> Result<Json<EmployeeImportDryRunSummary>, HrError> {
    authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
    let org = principal.org_id;
    let org_uuid = *org.as_uuid();
    let actor = principal.user_id;

    let event = AuditEvent::new(
        Some(actor),
        AuditAction::new("data_import.dry_run").map_err(HrError::from_kernel)?,
        "data_import_run",
        run_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org)
    .with_snapshots(
        None,
        Some(json!({ "run_id": run_id, "entity_type": "employee_hr" })),
    );

    let summary = with_audit::<_, _, HrError>(&state.pool, event, |tx| {
        Box::pin(async move {
            let run = import_run_for_update(tx, org_uuid, run_id).await?;
            if run.entity_type != "employee_hr" {
                return Err(HrError::validation(
                    "import run entity_type is not employee_hr",
                ));
            }
            if run.status != "PREVIEWED" && run.status != "DRY_RUN" {
                return Err(HrError::from_kernel(KernelError::invalid_transition(
                    format!("cannot dry-run import run in {} status", run.status),
                )));
            }
            let rows = load_candidate_import_rows(tx, org_uuid, run_id).await?;
            let summary =
                compute_employee_import_dry_run(tx, org_uuid, run_id, &run, &rows).await?;
            sqlx::query(
                r#"
                UPDATE data_import_runs
                SET status = 'DRY_RUN', dry_run_summary = $3, updated_at = now()
                WHERE org_id = $1 AND id = $2
                "#,
            )
            .bind(org_uuid)
            .bind(run_id)
            .bind(json!(&summary))
            .execute(tx.as_mut())
            .await?;
            Ok(summary)
        })
    })
    .await?;

    metrics::counter!("hr_data_import_runs_total", "stage" => "dry_run").increment(1);
    Ok(Json(summary))
}

async fn apply_employee_import(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Path(run_id): Path<Uuid>,
) -> Result<Json<EmployeeImportReport>, HrError> {
    authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
    let org = principal.org_id;
    let org_uuid = *org.as_uuid();
    let actor = principal.user_id;

    let event = AuditEvent::new(
        Some(actor),
        AuditAction::new("data_import.apply").map_err(HrError::from_kernel)?,
        "data_import_run",
        run_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org)
    .with_snapshots(
        None,
        Some(json!({ "run_id": run_id, "entity_type": "employee_hr" })),
    );

    let report = with_audit::<_, _, HrError>(&state.pool, event, |tx| {
        Box::pin(async move {
            let run = import_run_for_update(tx, org_uuid, run_id).await?;
            if run.entity_type != "employee_hr" {
                return Err(HrError::validation(
                    "import run entity_type is not employee_hr",
                ));
            }
            if run.status != "DRY_RUN" {
                return Err(HrError::from_kernel(KernelError::invalid_transition(
                    format!("apply requires DRY_RUN status, got {}", run.status),
                )));
            }
            let rows = load_candidate_import_rows(tx, org_uuid, run_id).await?;
            let parsed_rows = rows
                .into_iter()
                .map(StoredEmployeeImportRow::into_parsed)
                .collect::<Result<Vec<_>, _>>()?;
            let report = apply_employee_rows_tx(tx, org_uuid, parsed_rows).await?;
            sqlx::query(
                r#"
                UPDATE data_import_runs
                SET status = 'APPLIED', apply_summary = $3, applied_by = $4,
                    applied_at = now(), updated_at = now()
                WHERE org_id = $1 AND id = $2
                "#,
            )
            .bind(org_uuid)
            .bind(run_id)
            .bind(json!(&report))
            .bind(*actor.as_uuid())
            .execute(tx.as_mut())
            .await?;
            Ok(report)
        })
    })
    .await?;

    record_hr_import(report.inserted, report.updated);
    metrics::counter!("hr_data_import_runs_total", "stage" => "apply").increment(1);
    Ok(Json(report))
}

async fn export_employees_csv(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
) -> Result<Response, HrError> {
    authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryRead)?;
    authorize_hr_org_wide(&principal, Feature::ExcelDownload)?;
    let org = principal.org_id;
    let rows = with_org_conn::<_, _, HrError>(&state.pool, org, move |tx| {
        Box::pin(async move {
            sqlx::query(
                r#"
                SELECT company, name, employee_number, org_unit, worksite_name, job,
                       position, hire_date, exit_date, employment_status,
                       leave_remaining::TEXT AS leave_remaining
                FROM employees
                ORDER BY company ASC, name ASC, source_sheet ASC, source_row ASC
                LIMIT 10000
                "#,
            )
            .fetch_all(tx.as_mut())
            .await
            .map_err(HrError::from)
        })
    })
    .await?;

    let csv = standardized_employees_csv(&rows)?;
    let mut response = csv.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/csv; charset=utf-8"),
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("attachment; filename=\"employees-standard.csv\""),
    );
    Ok(response)
}

async fn list_employee_lifecycle_events(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Path(employee_id): Path<Uuid>,
) -> Result<Json<EmployeeLifecycleEventPage>, HrError> {
    authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryRead)?;
    record_hr_read("lifecycle_events");
    let org = principal.org_id;
    let org_uuid = *org.as_uuid();

    let items = with_org_conn::<_, _, HrError>(&state.pool, org, move |tx| {
        Box::pin(async move {
            // Keep missing employees distinguishable from an employee with no
            // lifecycle events, without returning raw employee/import data.
            let exists: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM employees WHERE org_id = $1 AND id = $2)",
            )
            .bind(org_uuid)
            .bind(employee_id)
            .fetch_one(tx.as_mut())
            .await?;
            if !exists {
                return Err(HrError::from_kernel(KernelError::not_found(
                    "employee not found",
                )));
            }

            sqlx::query(
                r#"
                SELECT
                    id, employee_id, event_type, from_status, to_status,
                    from_company, to_company, from_org_unit, to_org_unit,
                    from_position, to_position, effective_date, comment,
                    signoffs, created_by, created_at
                FROM employee_lifecycle_events
                WHERE org_id = $1 AND employee_id = $2
                ORDER BY created_at DESC, id DESC
                LIMIT 200
                "#,
            )
            .bind(org_uuid)
            .bind(employee_id)
            .fetch_all(tx.as_mut())
            .await?
            .into_iter()
            .map(employee_lifecycle_event_from_row)
            .collect::<Result<Vec<_>, HrError>>()
        })
    })
    .await?;

    Ok(Json(EmployeeLifecycleEventPage { items }))
}

async fn create_employee_lifecycle_event(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Path(employee_id): Path<Uuid>,
    Json(body): Json<CreateEmployeeLifecycleEventRequest>,
) -> Result<Json<EmployeeLifecycleEventResponse>, HrError> {
    authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;

    let org = principal.org_id;
    let org_uuid = *org.as_uuid();
    let actor = principal.user_id;
    let transition = normalize_lifecycle_transition(body)?;

    let event = AuditEvent::new(
        Some(actor),
        AuditAction::new("employee.lifecycle.record").map_err(HrError::from_kernel)?,
        "employee",
        employee_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org)
    .with_snapshots(
        None,
        Some(json!({
            "employee_id": employee_id,
            "event_type": &transition.event_type,
            "to_status": &transition.to_status,
            "effective_date": &transition.effective_date,
            "has_privacy_notice_ack": transition.signoffs.privacy_notice_ack,
            "has_korean_labor_law_ack": transition.signoffs.korean_labor_law_ack,
            "has_payroll_cutoff_ack": transition.signoffs.payroll_cutoff_ack,
            "has_retirement_settlement_ack": transition.signoffs.retirement_settlement_ack
        })),
    );

    let item = with_audit::<_, _, HrError>(&state.pool, event, |tx| {
        Box::pin(async move {
            let current = load_employee_for_lifecycle(tx, org_uuid, employee_id).await?;
            validate_lifecycle_transition(&current, &transition)?;
            let next_company = transition
                .to_company
                .clone()
                .unwrap_or_else(|| current.company.clone());
            let next_org_unit = transition
                .to_org_unit
                .clone()
                .or_else(|| current.org_unit.clone());
            let next_position = transition
                .to_position
                .clone()
                .or_else(|| current.position.clone());
            let lifecycle_id = Uuid::new_v4();

            sqlx::query(
                r#"
                INSERT INTO employee_lifecycle_events (
                    id, org_id, employee_id, event_type, from_status, to_status,
                    from_company, to_company, from_org_unit, to_org_unit,
                    from_position, to_position, effective_date, comment,
                    signoffs, created_by
                )
                VALUES (
                    $1, $2, $3, $4, $5, $6,
                    $7, $8, $9, $10,
                    $11, $12, $13, $14,
                    $15, $16
                )
                "#,
            )
            .bind(lifecycle_id)
            .bind(org_uuid)
            .bind(employee_id)
            .bind(&transition.event_type)
            .bind(&current.employment_status)
            .bind(&transition.to_status)
            .bind(&current.company)
            .bind(&next_company)
            .bind(current.org_unit.as_deref())
            .bind(next_org_unit.as_deref())
            .bind(current.position.as_deref())
            .bind(next_position.as_deref())
            .bind(&transition.effective_date)
            .bind(&transition.comment)
            .bind(json!(&transition.signoffs))
            .bind(*actor.as_uuid())
            .execute(tx.as_mut())
            .await?;

            sqlx::query(
                r#"
                UPDATE employees
                SET
                    company = $3,
                    org_unit = $4,
                    position = $5,
                    employment_status = $6,
                    exit_date = CASE WHEN $6 = 'EXITED' THEN $7 ELSE exit_date END,
                    updated_at = now()
                WHERE org_id = $1 AND id = $2
                "#,
            )
            .bind(org_uuid)
            .bind(employee_id)
            .bind(&next_company)
            .bind(next_org_unit.as_deref())
            .bind(next_position.as_deref())
            .bind(&transition.to_status)
            .bind(&transition.effective_date)
            .execute(tx.as_mut())
            .await?;

            let row = sqlx::query(
                r#"
                SELECT
                    id, employee_id, event_type, from_status, to_status,
                    from_company, to_company, from_org_unit, to_org_unit,
                    from_position, to_position, effective_date, comment,
                    signoffs, created_by, created_at
                FROM employee_lifecycle_events
                WHERE org_id = $1 AND id = $2
                "#,
            )
            .bind(org_uuid)
            .bind(lifecycle_id)
            .fetch_one(tx.as_mut())
            .await?;

            employee_lifecycle_event_from_row(row)
        })
    })
    .await?;

    metrics::counter!("hr_employee_lifecycle_events_total", "event_type" => item.event_type.clone())
        .increment(1);
    Ok(Json(item))
}

#[derive(Debug, Default, Serialize)]
struct EmployeeImportReport {
    input_rows: usize,
    inserted: usize,
    updated: usize,
    companies: Vec<CompanyImportSummary>,
}

#[derive(Debug, Default, Serialize)]
struct CompanyImportSummary {
    company: String,
    input_rows: usize,
    inserted: usize,
    updated: usize,
}

#[derive(Debug, Clone, Serialize)]
struct EmployeeImportColumn {
    source_header: String,
    normalized_header: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<String>,
    classification: String,
    preview_allowed: bool,
}

#[derive(Debug, Serialize)]
struct EmployeeImportPreviewRow {
    source_sheet: String,
    source_row: i32,
    row_status: String,
    values: BTreeMap<String, Value>,
}

#[derive(Debug, Serialize)]
struct EmployeeImportPreviewResponse {
    run_id: Uuid,
    entity_type: String,
    source_filename: String,
    source_sha256: String,
    input_rows: usize,
    candidate_rows: usize,
    preserved_rows: usize,
    columns: Vec<EmployeeImportColumn>,
    sample_rows: Vec<EmployeeImportPreviewRow>,
    mapping_profile: Value,
}

impl EmployeeImportPreviewResponse {
    fn from_rows(
        run_id: Uuid,
        source_filename: String,
        source_sha256: String,
        columns: Vec<EmployeeImportColumn>,
        rows: Vec<ParsedEmployeeImportRow>,
    ) -> Self {
        let sample_rows = rows
            .iter()
            .take(12)
            .map(|row| EmployeeImportPreviewRow {
                source_sheet: row.source_sheet.clone(),
                source_row: row.source_row,
                row_status: row.row_status.as_str().to_owned(),
                values: masked_preview_values(&row.raw_row, &columns),
            })
            .collect::<Vec<_>>();
        let input_rows = rows.len();
        let candidate_rows = rows
            .iter()
            .filter(|row| row.row_status == ImportRowStatus::Candidate)
            .count();
        let preserved_rows = rows
            .iter()
            .filter(|row| row.row_status == ImportRowStatus::Preserved)
            .count();
        let mapping_profile = employee_import_mapping_profile(&columns);

        Self {
            run_id,
            entity_type: "employee_hr".to_owned(),
            source_filename,
            source_sha256,
            input_rows,
            candidate_rows,
            preserved_rows,
            columns,
            sample_rows,
            mapping_profile,
        }
    }
}

#[derive(Debug, Serialize)]
struct EmployeeImportDryRunSummary {
    run_id: Uuid,
    input_rows: usize,
    candidate_rows: usize,
    preserved_rows: usize,
    insert_candidates: usize,
    update_candidates: usize,
    companies: Vec<CompanyImportSummary>,
}

#[derive(Debug, Clone, Serialize)]
struct AttendanceImportColumn {
    source_header: String,
    normalized_header: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<String>,
    classification: String,
    preview_allowed: bool,
}

#[derive(Debug, Serialize)]
struct AttendanceImportPreviewRow {
    source_sheet: String,
    source_row: i32,
    row_status: String,
    values: BTreeMap<String, Value>,
    validation: Value,
}

#[derive(Debug, Serialize)]
struct AttendanceImportPreviewResponse {
    run_id: Uuid,
    entity_type: String,
    source_filename: String,
    source_sha256: String,
    input_rows: usize,
    candidate_rows: usize,
    preserved_rows: usize,
    columns: Vec<AttendanceImportColumn>,
    sample_rows: Vec<AttendanceImportPreviewRow>,
    mapping_profile: Value,
}

impl AttendanceImportPreviewResponse {
    fn from_rows(
        run_id: Uuid,
        source_filename: String,
        source_sha256: String,
        rows: Vec<ParsedAttendanceImportRow>,
    ) -> Self {
        let columns = attendance_import_columns_from_rows(&rows);
        let sample_rows = rows
            .iter()
            .take(12)
            .map(|row| AttendanceImportPreviewRow {
                source_sheet: row.source_sheet.clone(),
                source_row: row.source_row,
                row_status: row.row_status.as_str().to_owned(),
                values: attendance_preview_values(&row.raw_row, &columns),
                validation: attendance_validation_json(row),
            })
            .collect::<Vec<_>>();
        let input_rows = rows.len();
        let candidate_rows = rows
            .iter()
            .filter(|row| row.row_status == ImportRowStatus::Candidate)
            .count();
        let preserved_rows = rows
            .iter()
            .filter(|row| row.row_status != ImportRowStatus::Candidate)
            .count();

        Self {
            run_id,
            entity_type: "attendance_direct".to_owned(),
            source_filename,
            source_sha256,
            input_rows,
            candidate_rows,
            preserved_rows,
            columns: columns.clone(),
            sample_rows,
            mapping_profile: attendance_import_mapping_profile(&columns),
        }
    }
}

#[derive(Debug, Default, Serialize)]
struct AttendanceImportDryRunSummary {
    run_id: Uuid,
    input_rows: usize,
    candidate_rows: usize,
    preserved_rows: usize,
    ready_rows: usize,
    error_rows: usize,
    duplicate_rows: usize,
    missing_employee_rows: usize,
    ambiguous_employee_rows: usize,
    row_errors: Vec<AttendanceImportRowError>,
    #[serde(skip_serializing)]
    ready_rows_for_apply: Vec<ResolvedAttendanceImportRow>,
}

#[derive(Debug, Clone, Serialize)]
struct AttendanceImportRowError {
    source_sheet: String,
    source_row: i32,
    source_key: String,
    code: String,
    message: String,
}

#[derive(Debug, Serialize)]
struct AttendanceImportApplyReport {
    run_id: Uuid,
    inserted: usize,
    skipped: usize,
    error_rows: usize,
}

#[derive(Debug, Serialize)]
struct AttendanceImportSummaryItem {
    run_id: Uuid,
    status: String,
    source_filename: String,
    source_format: String,
    source_sha256: String,
    input_rows: i32,
    candidate_rows: i32,
    preserved_rows: i32,
    dry_run_summary: Value,
    apply_summary: Value,
    created_at: OffsetDateTime,
    #[serde(skip_serializing_if = "Option::is_none")]
    applied_at: Option<OffsetDateTime>,
}

#[derive(Debug, Serialize)]
struct AttendanceImportSummaryPage {
    items: Vec<AttendanceImportSummaryItem>,
    total: i64,
    limit: i64,
    offset: i64,
}

#[derive(Debug)]
struct DataImportRunRecord {
    entity_type: String,
    status: String,
    source_sha256: String,
    input_rows: i32,
    candidate_rows: i32,
    preserved_rows: i32,
}

#[derive(Debug)]
struct StoredEmployeeImportRow {
    company: String,
    name: String,
    source_filename: String,
    source_sheet: String,
    source_row: i32,
    source_key: String,
    raw_row: Value,
    source_metadata: Value,
    canonical: EmployeeCanonicalFields,
}

impl StoredEmployeeImportRow {
    fn into_parsed(self) -> Result<ParsedEmployeeRow, HrError> {
        if self.name.trim().is_empty() {
            return Err(HrError::validation(
                "candidate import row is missing required employee name",
            ));
        }
        Ok(ParsedEmployeeRow {
            company: self.company,
            name: self.name,
            source_filename: self.source_filename,
            source_sheet: self.source_sheet,
            source_row: self.source_row,
            source_key: self.source_key,
            raw_row: self.raw_row,
            source_metadata: self.source_metadata,
            canonical: self.canonical,
        })
    }
}

struct XlsxUpload {
    filename: String,
    bytes: Vec<u8>,
}

async fn read_xlsx_upload(mut multipart: Multipart) -> Result<XlsxUpload, HrError> {
    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|err| HrError::validation(err.to_string()))?
    {
        if field.name() != Some("file") {
            continue;
        }
        let filename = field
            .file_name()
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| "employees.xlsx".to_owned());
        if !filename.to_ascii_lowercase().ends_with(".xlsx") {
            return Err(HrError::validation(
                "employee import currently accepts .xlsx workbooks only",
            ));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = field
            .chunk()
            .await
            .map_err(|err| HrError::validation(err.to_string()))?
        {
            if bytes.len() + chunk.len() > MAX_IMPORT_BYTES {
                return Err(HrError::validation(
                    "uploaded file exceeds the maximum import size",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty() {
            return Err(HrError::validation("uploaded file is empty"));
        }
        return Ok(XlsxUpload { filename, bytes });
    }
    Err(HrError::validation(
        "multipart upload is missing the 'file' field",
    ))
}

async fn read_attendance_upload(mut multipart: Multipart) -> Result<XlsxUpload, HrError> {
    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|err| HrError::validation(err.to_string()))?
    {
        if field.name() != Some("file") {
            continue;
        }
        let filename = field
            .file_name()
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| "attendance.csv".to_owned());
        let lower = filename.to_ascii_lowercase();
        if !(lower.ends_with(".xlsx") || lower.ends_with(".csv")) {
            return Err(HrError::validation(
                "attendance import accepts .xlsx workbooks or .csv files only",
            ));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = field
            .chunk()
            .await
            .map_err(|err| HrError::validation(err.to_string()))?
        {
            if bytes.len() + chunk.len() > MAX_IMPORT_BYTES {
                return Err(HrError::validation(
                    "uploaded file exceeds the maximum import size",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty() {
            return Err(HrError::validation("uploaded file is empty"));
        }
        return Ok(XlsxUpload { filename, bytes });
    }
    Err(HrError::validation(
        "multipart upload is missing the 'file' field",
    ))
}

#[derive(Debug)]
struct ParsedEmployeeWorkbook {
    rows: Vec<ParsedEmployeeRow>,
}

#[derive(Debug, Clone)]
struct ParsedEmployeeRow {
    company: String,
    name: String,
    source_filename: String,
    source_sheet: String,
    source_row: i32,
    source_key: String,
    raw_row: Value,
    source_metadata: Value,
    canonical: EmployeeCanonicalFields,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct EmployeeCanonicalFields {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    employee_number: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    org_unit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    job: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    position: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    worksite_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    worksite_address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hire_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    exit_date: Option<String>,
    #[serde(default = "default_active_status")]
    employment_status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    leave_accrued: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    leave_used: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    leave_remaining: Option<String>,
}

fn default_active_status() -> String {
    "ACTIVE".to_owned()
}

#[derive(Debug, Clone)]
struct ParsedEmployeeImportWorkbook {
    rows: Vec<ParsedEmployeeImportRow>,
    columns: Vec<EmployeeImportColumn>,
}

impl ParsedEmployeeImportWorkbook {
    fn input_rows(&self) -> usize {
        self.rows.len()
    }

    fn candidate_rows(&self) -> usize {
        self.rows
            .iter()
            .filter(|row| row.row_status == ImportRowStatus::Candidate)
            .count()
    }

    fn preserved_rows(&self) -> usize {
        self.rows
            .iter()
            .filter(|row| row.row_status == ImportRowStatus::Preserved)
            .count()
    }
}

#[derive(Debug, Clone)]
struct ParsedEmployeeImportRow {
    company: String,
    name: Option<String>,
    source_filename: String,
    source_sheet: String,
    source_row: i32,
    source_key: String,
    raw_row: Value,
    source_metadata: Value,
    canonical: Option<EmployeeCanonicalFields>,
    row_status: ImportRowStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImportRowStatus {
    Candidate,
    Preserved,
    Error,
}

impl ImportRowStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Candidate => "CANDIDATE",
            Self::Preserved => "PRESERVED",
            Self::Error => "ERROR",
        }
    }

    fn from_db(value: &str) -> Result<Self, HrError> {
        match value {
            "CANDIDATE" => Ok(Self::Candidate),
            "PRESERVED" => Ok(Self::Preserved),
            "ERROR" => Ok(Self::Error),
            _ => Err(HrError::validation("stored import row has invalid status")),
        }
    }
}

#[derive(Debug, Clone)]
struct ParsedAttendanceImportUpload {
    rows: Vec<ParsedAttendanceImportRow>,
}

#[derive(Debug, Clone)]
struct ParsedAttendanceImportRow {
    source_sheet: String,
    source_row: i32,
    source_key: String,
    raw_row: Value,
    employee_number: Option<String>,
    employee_name: Option<String>,
    branch_name: Option<String>,
    work_date: Option<String>,
    check_in_at: Option<String>,
    check_out_at: Option<String>,
    minutes_worked: Option<i32>,
    row_status: ImportRowStatus,
    validation_errors: Vec<String>,
}

impl ParsedAttendanceImportRow {
    fn duplicate_fingerprint(&self) -> Option<String> {
        Some(format!(
            "employee:{}|name:{}|branch:{}|date:{}|in:{}|out:{}|minutes:{}",
            self.employee_number
                .as_deref()
                .or(self.employee_name.as_deref())?,
            self.employee_name.as_deref().unwrap_or_default(),
            self.branch_name.as_deref()?,
            self.work_date.as_deref()?,
            self.check_in_at.as_deref().unwrap_or_default(),
            self.check_out_at.as_deref().unwrap_or_default(),
            self.minutes_worked
                .map(|value| value.to_string())
                .unwrap_or_default()
        ))
    }
}

#[derive(Debug)]
struct AttendanceImportHeader {
    zero_based_row: usize,
    normalized_headers: Vec<String>,
    columns: Vec<AttendanceImportColumn>,
}

#[derive(Debug)]
struct AttendanceImportFieldDefinition {
    target: &'static str,
    aliases: &'static [&'static str],
    required: bool,
}

const ATTENDANCE_IMPORT_FIELD_DEFINITIONS: &[AttendanceImportFieldDefinition] = &[
    AttendanceImportFieldDefinition {
        target: "employee_number",
        aliases: &[
            "사번",
            "직원번호",
            "임직원번호",
            "employee_number",
            "employeenumber",
        ],
        required: false,
    },
    AttendanceImportFieldDefinition {
        target: "employee_name",
        aliases: &[
            "성명",
            "이름",
            "직원명",
            "사원명",
            "근로자명",
            "employee_name",
            "employeename",
        ],
        required: false,
    },
    AttendanceImportFieldDefinition {
        target: "branch_name",
        aliases: &[
            "지점",
            "지점명",
            "근무지",
            "사업장",
            "branch",
            "branch_name",
            "branchname",
        ],
        required: true,
    },
    AttendanceImportFieldDefinition {
        target: "work_date",
        aliases: &[
            "근무일",
            "일자",
            "날짜",
            "출근일",
            "work_date",
            "workdate",
            "date",
        ],
        required: true,
    },
    AttendanceImportFieldDefinition {
        target: "check_in_at",
        aliases: &[
            "출근",
            "출근시간",
            "시작시간",
            "clock_in",
            "check_in",
            "checkin",
        ],
        required: false,
    },
    AttendanceImportFieldDefinition {
        target: "check_out_at",
        aliases: &[
            "퇴근",
            "퇴근시간",
            "종료시간",
            "clock_out",
            "check_out",
            "checkout",
        ],
        required: false,
    },
    AttendanceImportFieldDefinition {
        target: "minutes_worked",
        aliases: &[
            "근무분",
            "근무시간분",
            "근무시간",
            "minutes_worked",
            "minutesworked",
            "work_minutes",
        ],
        required: false,
    },
];

fn parse_attendance_import_upload(
    filename: &str,
    bytes: &[u8],
) -> Result<ParsedAttendanceImportUpload, HrError> {
    let lower = filename.to_ascii_lowercase();
    let mut rows = if lower.ends_with(".csv") {
        let text = std::str::from_utf8(bytes)
            .map_err(|_| HrError::workbook("attendance CSV must be valid UTF-8"))?;
        parse_attendance_csv(filename, text)?
    } else if lower.ends_with(".xlsx") {
        parse_attendance_xlsx(filename, bytes)?
    } else {
        return Err(HrError::validation(
            "attendance import accepts .xlsx workbooks or .csv files only",
        ));
    };

    mark_duplicate_attendance_rows(&mut rows);
    if rows.is_empty() {
        return Err(HrError::workbook(
            "attendance import did not contain any non-empty data rows",
        ));
    }
    Ok(ParsedAttendanceImportUpload { rows })
}

fn parse_attendance_xlsx(
    filename: &str,
    bytes: &[u8],
) -> Result<Vec<ParsedAttendanceImportRow>, HrError> {
    let mut workbook =
        Xlsx::new(Cursor::new(bytes)).map_err(|err| HrError::workbook(err.to_string()))?;
    let mut rows = Vec::new();
    for sheet in workbook.sheet_names().to_owned() {
        let range = workbook
            .worksheet_range(&sheet)
            .map_err(|err| HrError::workbook(err.to_string()))?;
        let values = range
            .rows()
            .map(|row| row.iter().map(cell_json).collect::<Vec<_>>())
            .collect::<Vec<_>>();
        rows.extend(parse_attendance_tabular_sheet(
            filename, &sheet, &values, false,
        )?);
    }
    Ok(rows)
}

fn parse_attendance_csv(
    filename: &str,
    text: &str,
) -> Result<Vec<ParsedAttendanceImportRow>, HrError> {
    let rows = parse_csv_rows(text)?
        .into_iter()
        .map(|row| row.into_iter().map(Value::String).collect::<Vec<_>>())
        .collect::<Vec<_>>();
    parse_attendance_tabular_sheet(filename, "CSV", &rows, true)
}

fn parse_attendance_tabular_sheet(
    _filename: &str,
    sheet: &str,
    rows: &[Vec<Value>],
    require_header: bool,
) -> Result<Vec<ParsedAttendanceImportRow>, HrError> {
    let Some(header) = detect_attendance_import_header(rows) else {
        return if require_header {
            Err(HrError::workbook(
                "attendance import is missing required headers",
            ))
        } else {
            Ok(Vec::new())
        };
    };

    let mut parsed = Vec::new();
    for (zero_based_idx, row) in rows
        .iter()
        .enumerate()
        .skip(header.zero_based_row.saturating_add(1))
    {
        if !row.iter().any(|cell| json_value_text(cell).is_some()) {
            continue;
        }
        let source_row = i32::try_from(zero_based_idx + 1)
            .map_err(|_| HrError::workbook("source row does not fit i32"))?;
        let raw_row = attendance_raw_row(row, &header.normalized_headers);
        let employee_number =
            raw_text_for_attendance_target(&raw_row, &header.columns, "employee_number");
        let employee_name =
            raw_text_for_attendance_target(&raw_row, &header.columns, "employee_name");
        let branch_name = raw_text_for_attendance_target(&raw_row, &header.columns, "branch_name");
        let work_date_raw = raw_text_for_attendance_target(&raw_row, &header.columns, "work_date");
        let (work_date, invalid_work_date) = match work_date_raw.as_deref() {
            Some(value) => match normalized_work_date(value) {
                Ok(date) => (Some(date), false),
                Err(_) => (None, true),
            },
            None => (None, false),
        };
        let check_in_raw = raw_text_for_attendance_target(&raw_row, &header.columns, "check_in_at");
        let (check_in_at, invalid_check_in_at) = match check_in_raw.as_deref() {
            Some(value) => match normalized_attendance_time(value) {
                Ok(time) => (Some(time), false),
                Err(_) => (None, true),
            },
            None => (None, false),
        };
        let check_out_raw =
            raw_text_for_attendance_target(&raw_row, &header.columns, "check_out_at");
        let (check_out_at, invalid_check_out_at) = match check_out_raw.as_deref() {
            Some(value) => match normalized_attendance_time(value) {
                Ok(time) => (Some(time), false),
                Err(_) => (None, true),
            },
            None => (None, false),
        };
        let minutes_raw =
            raw_text_for_attendance_target(&raw_row, &header.columns, "minutes_worked");
        let (minutes_worked, invalid_minutes) = match minutes_raw.as_deref() {
            Some(value) => match normalized_minutes_worked(value) {
                Ok(minutes) => (Some(minutes), false),
                Err(_) => (None, true),
            },
            None => (None, false),
        };

        let mut validation_errors = Vec::new();
        if employee_number.is_none() && employee_name.is_none() {
            validation_errors.push("missing_employee_identifier".to_owned());
        }
        if branch_name.is_none() {
            validation_errors.push("missing_branch_name".to_owned());
        }
        if work_date.is_none() {
            validation_errors.push("missing_work_date".to_owned());
        }
        if invalid_work_date {
            validation_errors.push("invalid_work_date".to_owned());
        }
        if invalid_minutes {
            validation_errors.push("invalid_minutes_worked".to_owned());
        }
        if invalid_check_in_at {
            validation_errors.push("invalid_check_in_at".to_owned());
        }
        if invalid_check_out_at {
            validation_errors.push("invalid_check_out_at".to_owned());
        }
        if check_in_at.is_none() && check_out_at.is_none() && minutes_worked.is_none() {
            validation_errors.push("missing_attendance_time".to_owned());
        }

        let row_status = if validation_errors.is_empty() {
            ImportRowStatus::Candidate
        } else {
            ImportRowStatus::Error
        };
        parsed.push(ParsedAttendanceImportRow {
            source_sheet: sheet.to_owned(),
            source_row,
            source_key: format!("sheet:{sheet}|row:{source_row}"),
            raw_row,
            employee_number,
            employee_name,
            branch_name,
            work_date,
            check_in_at,
            check_out_at,
            minutes_worked,
            row_status,
            validation_errors,
        });
    }
    Ok(parsed)
}

fn detect_attendance_import_header(rows: &[Vec<Value>]) -> Option<AttendanceImportHeader> {
    for (zero_based_row, row) in rows.iter().enumerate().take(MAX_IMPORT_HEADER_SCAN_ROWS) {
        let normalized_headers = row
            .iter()
            .map(|cell| {
                json_value_text(cell)
                    .map_or_else(String::new, |value| normalize_header_label(&value))
            })
            .collect::<Vec<_>>();
        let targets = normalized_headers
            .iter()
            .filter_map(|header| attendance_import_target_for_header(header))
            .collect::<BTreeSet<_>>();
        let has_employee = targets.contains("employee_number") || targets.contains("employee_name");
        let has_required = ATTENDANCE_IMPORT_FIELD_DEFINITIONS
            .iter()
            .filter(|field| field.required)
            .all(|field| targets.contains(field.target));
        if has_employee && has_required {
            let columns = normalized_headers
                .iter()
                .filter(|header| !header.is_empty())
                .map(|header| attendance_import_column(header, header))
                .collect::<Vec<_>>();
            return Some(AttendanceImportHeader {
                zero_based_row,
                normalized_headers,
                columns,
            });
        }
    }
    None
}

fn attendance_raw_row(row: &[Value], normalized_headers: &[String]) -> Value {
    let mut raw = Map::new();
    for (idx, header_label) in normalized_headers.iter().enumerate() {
        if header_label.is_empty() {
            continue;
        }
        raw.insert(
            header_label.clone(),
            row.get(idx).cloned().unwrap_or(Value::Null),
        );
    }
    Value::Object(raw)
}

fn mark_duplicate_attendance_rows(rows: &mut [ParsedAttendanceImportRow]) {
    let mut counts = BTreeMap::<String, usize>::new();
    for row in rows.iter() {
        if row.row_status == ImportRowStatus::Candidate
            && let Some(key) = row.duplicate_fingerprint()
        {
            *counts.entry(key).or_default() += 1;
        }
    }
    for row in rows.iter_mut() {
        let Some(key) = row.duplicate_fingerprint() else {
            continue;
        };
        if counts.get(&key).copied().unwrap_or_default() > 1 {
            row.row_status = ImportRowStatus::Error;
            row.validation_errors
                .push("duplicate_row_in_file".to_owned());
        }
    }
}

fn parse_csv_rows(text: &str) -> Result<Vec<Vec<String>>, HrError> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut chars = text.chars().peekable();
    let mut in_quotes = false;

    while let Some(ch) = chars.next() {
        match ch {
            '"' if in_quotes && chars.peek() == Some(&'"') => {
                field.push('"');
                chars.next();
            }
            '"' => {
                in_quotes = !in_quotes;
            }
            ',' if !in_quotes => {
                row.push(field.trim().to_owned());
                field.clear();
            }
            '\n' if !in_quotes => {
                row.push(field.trim().to_owned());
                field.clear();
                if row.iter().any(|value| !value.is_empty()) {
                    rows.push(std::mem::take(&mut row));
                } else {
                    row.clear();
                }
            }
            '\r' if !in_quotes => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                row.push(field.trim().to_owned());
                field.clear();
                if row.iter().any(|value| !value.is_empty()) {
                    rows.push(std::mem::take(&mut row));
                } else {
                    row.clear();
                }
            }
            _ => field.push(ch),
        }
    }

    if in_quotes {
        return Err(HrError::workbook(
            "attendance CSV has an unclosed quoted field",
        ));
    }
    row.push(field.trim().to_owned());
    if row.iter().any(|value| !value.is_empty()) {
        rows.push(row);
    }
    Ok(rows)
}

fn normalized_minutes_worked(value: &str) -> Result<i32, HrError> {
    let cleaned = value.replace(',', "").trim().to_owned();
    let minutes = cleaned
        .parse::<i32>()
        .map_err(|_| HrError::validation("minutes_worked must be a whole number"))?;
    if minutes < 0 {
        return Err(HrError::validation("minutes_worked must not be negative"));
    }
    Ok(minutes)
}

fn normalized_work_date(value: &str) -> Result<String, HrError> {
    let cleaned = value.trim().replace(['.', '/'], "-");
    let parts = cleaned.split('-').collect::<Vec<_>>();
    if parts.len() != 3 {
        return Err(HrError::validation("work_date must use YYYY-MM-DD"));
    }
    let year = parts[0]
        .parse::<u16>()
        .map_err(|_| HrError::validation("work_date year must be numeric"))?;
    let month = parts[1]
        .parse::<u8>()
        .map_err(|_| HrError::validation("work_date month must be numeric"))?;
    let day = parts[2]
        .parse::<u8>()
        .map_err(|_| HrError::validation("work_date day must be numeric"))?;
    if !(1900..=2100).contains(&year) || month == 0 || month > 12 {
        return Err(HrError::validation(
            "work_date is outside the supported date range",
        ));
    }
    let max_day = days_in_month(year, month);
    if day == 0 || day > max_day {
        return Err(HrError::validation("work_date day is invalid"));
    }
    Ok(format!("{year:04}-{month:02}-{day:02}"))
}

fn normalized_attendance_time(value: &str) -> Result<String, HrError> {
    let cleaned = value.trim();
    let parts = cleaned.split(':').collect::<Vec<_>>();
    if parts.len() != 2 {
        return Err(HrError::validation("attendance time must use HH:MM"));
    }
    let hour = parts[0]
        .parse::<u8>()
        .map_err(|_| HrError::validation("attendance time hour must be numeric"))?;
    let minute = parts[1]
        .parse::<u8>()
        .map_err(|_| HrError::validation("attendance time minute must be numeric"))?;
    if hour > 23 || minute > 59 {
        return Err(HrError::validation(
            "attendance time is outside the supported range",
        ));
    }
    Ok(format!("{hour:02}:{minute:02}"))
}

fn days_in_month(year: u16, month: u8) -> u8 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn is_leap_year(year: u16) -> bool {
    (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400)
}

fn attendance_source_format(filename: &str) -> Result<&'static str, HrError> {
    let lower = filename.to_ascii_lowercase();
    if lower.ends_with(".xlsx") {
        Ok("xlsx")
    } else if lower.ends_with(".csv") {
        Ok("csv")
    } else {
        Err(HrError::validation(
            "attendance import accepts .xlsx workbooks or .csv files only",
        ))
    }
}

fn parse_employee_workbook(
    filename: &str,
    bytes: &[u8],
) -> Result<ParsedEmployeeWorkbook, HrError> {
    let mut workbook =
        Xlsx::new(Cursor::new(bytes)).map_err(|err| HrError::workbook(err.to_string()))?;
    let mut rows = Vec::new();
    for sheet in workbook.sheet_names().to_owned() {
        let range = workbook
            .worksheet_range(&sheet)
            .map_err(|err| HrError::workbook(err.to_string()))?;
        rows.extend(parse_employee_sheet(filename, &sheet, &range)?);
    }
    Ok(ParsedEmployeeWorkbook { rows })
}

fn parse_employee_sheet(
    filename: &str,
    sheet: &str,
    range: &calamine::Range<Data>,
) -> Result<Vec<ParsedEmployeeRow>, HrError> {
    let Some(header) = detect_employee_import_header(range, sheet)? else {
        return Ok(Vec::new());
    };

    let mut parsed = Vec::new();
    for (zero_based_idx, row) in range
        .rows()
        .enumerate()
        .skip(header.zero_based_row.saturating_add(1))
    {
        let Some(name) = row
            .get(header.name_index)
            .map(cell_text)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let source_row = i32::try_from(zero_based_idx + 1)
            .map_err(|_| HrError::workbook("source row does not fit i32"))?;
        let mut raw = Map::new();
        for (idx, header_label) in header.normalized_headers.iter().enumerate() {
            if header_label.is_empty() {
                continue;
            }
            let value = row.get(idx).map(cell_json).unwrap_or(Value::Null);
            raw.insert(header_label.clone(), value);
        }
        let source_key = format!("filename:{filename}|sheet:{sheet}|row:{source_row}");
        let raw_row = Value::Object(raw);
        let canonical = canonical_employee_fields_for_import(&raw_row, &header.columns);
        let mapped_company = raw_text_for_import_target(&raw_row, &header.columns, "company");
        let company_source = if mapped_company.is_some() {
            "mapped_column"
        } else {
            "sheet_name_default"
        };
        parsed.push(ParsedEmployeeRow {
            company: mapped_company.unwrap_or_else(|| sheet.to_owned()),
            name,
            source_filename: filename.to_owned(),
            source_sheet: sheet.to_owned(),
            source_row,
            source_key,
            raw_row,
            source_metadata: json!({
                "filename": filename,
                "sheet": sheet,
                "row": source_row,
                "source_key_kind": "filename_sheet_row",
                "header_row": header.zero_based_row + 1,
                "company_source": company_source
            }),
            canonical,
        });
    }
    Ok(parsed)
}

fn parse_employee_import_workbook(
    filename: &str,
    bytes: &[u8],
) -> Result<ParsedEmployeeImportWorkbook, HrError> {
    let mut workbook =
        Xlsx::new(Cursor::new(bytes)).map_err(|err| HrError::workbook(err.to_string()))?;
    let mut rows = Vec::new();
    let mut columns = BTreeMap::<String, EmployeeImportColumn>::new();
    for sheet in workbook.sheet_names().to_owned() {
        let range = workbook
            .worksheet_range(&sheet)
            .map_err(|err| HrError::workbook(err.to_string()))?;
        let parsed = parse_employee_import_sheet(filename, &sheet, &range)?;
        for column in parsed.columns {
            columns
                .entry(column.normalized_header.clone())
                .or_insert(column);
        }
        rows.extend(parsed.rows);
    }
    Ok(ParsedEmployeeImportWorkbook {
        rows,
        columns: columns.into_values().collect(),
    })
}

#[derive(Debug)]
struct ParsedEmployeeImportSheet {
    rows: Vec<ParsedEmployeeImportRow>,
    columns: Vec<EmployeeImportColumn>,
}

fn parse_employee_import_sheet(
    filename: &str,
    sheet: &str,
    range: &calamine::Range<Data>,
) -> Result<ParsedEmployeeImportSheet, HrError> {
    let Some(header) = detect_employee_import_header(range, sheet)? else {
        return Ok(ParsedEmployeeImportSheet {
            rows: Vec::new(),
            columns: Vec::new(),
        });
    };

    let mut parsed = Vec::new();
    for (zero_based_idx, row) in range
        .rows()
        .enumerate()
        .skip(header.zero_based_row.saturating_add(1))
    {
        if !row.iter().any(|cell| !cell_text(cell).is_empty()) {
            continue;
        }
        let source_row = i32::try_from(zero_based_idx + 1)
            .map_err(|_| HrError::workbook("source row does not fit i32"))?;
        let mut raw = Map::new();
        for (idx, header_label) in header.normalized_headers.iter().enumerate() {
            if header_label.is_empty() {
                continue;
            }
            let value = row.get(idx).map(cell_json).unwrap_or(Value::Null);
            raw.insert(header_label.clone(), value);
        }
        let raw_row = Value::Object(raw);
        let name = row
            .get(header.name_index)
            .map(cell_text)
            .filter(|value| !value.is_empty());
        let canonical = name
            .as_ref()
            .map(|_| canonical_employee_fields_for_import(&raw_row, &header.columns));
        let mapped_company = raw_text_for_import_target(&raw_row, &header.columns, "company");
        let company_source = if mapped_company.is_some() {
            "mapped_column"
        } else {
            "sheet_name_default"
        };
        let company = mapped_company.unwrap_or_else(|| sheet.to_owned());
        let source_key = format!("filename:{filename}|sheet:{sheet}|row:{source_row}");
        parsed.push(ParsedEmployeeImportRow {
            company,
            name,
            source_filename: filename.to_owned(),
            source_sheet: sheet.to_owned(),
            source_row,
            source_key,
            raw_row,
            source_metadata: json!({
                "filename": filename,
                "sheet": sheet,
                "row": source_row,
                "source_key_kind": "filename_sheet_row",
                "header_row": header.zero_based_row + 1,
                "header_normalization": "trim_remove_whitespace_for_storage_schema_catalog_for_matching",
                "company_source": company_source
            }),
            canonical,
            row_status: if row
                .get(header.name_index)
                .map(cell_text)
                .filter(|value| !value.is_empty())
                .is_some()
            {
                ImportRowStatus::Candidate
            } else {
                ImportRowStatus::Preserved
            },
        });
    }

    Ok(ParsedEmployeeImportSheet {
        rows: parsed,
        columns: header.columns,
    })
}

fn cell_text(cell: &Data) -> String {
    match cell {
        Data::String(value) | Data::DateTimeIso(value) | Data::DurationIso(value) => {
            value.trim().to_owned()
        }
        Data::Int(value) => value.to_string(),
        Data::Float(value) if value.fract() == 0.0 => format!("{value:.0}"),
        Data::Float(value) => value.to_string(),
        Data::Bool(value) => value.to_string(),
        Data::DateTime(value) => value.to_string(),
        Data::Error(value) => value.to_string(),
        Data::Empty => String::new(),
    }
}

fn cell_json(cell: &Data) -> Value {
    if cell.is_empty() {
        return Value::Null;
    }
    match cell {
        Data::Int(value) => json!(value),
        Data::Float(value) => json!(value),
        Data::Bool(value) => json!(value),
        Data::String(_)
        | Data::DateTimeIso(_)
        | Data::DurationIso(_)
        | Data::DateTime(_)
        | Data::Error(_) => {
            json!(cell_text(cell))
        }
        Data::Empty => Value::Null,
    }
}

fn normalize_header_label(raw: &str) -> String {
    raw.chars()
        .filter(|ch| !ch.is_whitespace())
        .collect::<String>()
}

#[derive(Debug)]
struct EmployeeImportHeader {
    zero_based_row: usize,
    normalized_headers: Vec<String>,
    columns: Vec<EmployeeImportColumn>,
    name_index: usize,
}

#[derive(Debug)]
struct EmployeeImportFieldDefinition {
    target: &'static str,
    aliases: &'static [&'static str],
    classification: &'static str,
    required: bool,
}

const EMPLOYEE_IMPORT_FIELD_DEFINITIONS: &[EmployeeImportFieldDefinition] = &[
    EmployeeImportFieldDefinition {
        target: "name",
        aliases: &[
            "성명",
            "이름",
            "직원명",
            "사원명",
            "근로자명",
            "임직원명",
            "name",
            "employee_name",
            "employeename",
            "worker_name",
            "workername",
        ],
        classification: "canonical",
        required: true,
    },
    EmployeeImportFieldDefinition {
        target: "employee_number",
        aliases: &[
            "사번",
            "사원번호",
            "직원번호",
            "사용자ID",
            "user_id",
            "userid",
            "employee_id",
            "employeeid",
            "employee_number",
            "employeenumber",
            "staff_id",
            "staffid",
        ],
        classification: "canonical",
        required: false,
    },
    EmployeeImportFieldDefinition {
        target: "org_unit",
        aliases: &[
            "부서명",
            "부서",
            "소속",
            "소속부서",
            "조직",
            "팀",
            "org_unit",
            "orgunit",
            "department",
            "dept",
            "team",
        ],
        classification: "canonical",
        required: false,
    },
    EmployeeImportFieldDefinition {
        target: "job",
        aliases: &[
            "업무",
            "담당업무",
            "직무",
            "직종",
            "job",
            "work_type",
            "worktype",
        ],
        classification: "canonical",
        required: false,
    },
    EmployeeImportFieldDefinition {
        target: "position",
        aliases: &["직책", "직위", "직급", "직함", "position", "title", "rank"],
        classification: "canonical",
        required: false,
    },
    EmployeeImportFieldDefinition {
        target: "worksite_name",
        aliases: &[
            "근무지",
            "현장",
            "현장명",
            "사업장",
            "근무사업장",
            "worksite",
            "workplace_name",
            "workplacename",
            "site",
        ],
        classification: "canonical",
        required: false,
    },
    EmployeeImportFieldDefinition {
        target: "worksite_address",
        aliases: &[
            "근무지(주소)",
            "근무지주소",
            "근무지주소지",
            "현장주소",
            "사업장주소",
            "주소",
            "worksite_address",
            "worksiteaddress",
            "workplace_address",
            "workplaceaddress",
            "site_address",
            "siteaddress",
        ],
        classification: "location",
        required: false,
    },
    EmployeeImportFieldDefinition {
        target: "hire_date",
        aliases: &[
            "입사일",
            "입사일자",
            "채용일",
            "보험가입일",
            "hire_date",
            "hiredate",
            "start_date",
            "startdate",
        ],
        classification: "canonical",
        required: false,
    },
    EmployeeImportFieldDefinition {
        target: "exit_date",
        aliases: &[
            "퇴사일",
            "퇴사일자",
            "퇴직일",
            "보험상실일",
            "exit_date",
            "exitdate",
            "end_date",
            "enddate",
            "termination_date",
            "terminationdate",
        ],
        classification: "canonical",
        required: false,
    },
    EmployeeImportFieldDefinition {
        target: "leave_accrued",
        aliases: &[
            "발생연차",
            "연차발생",
            "부여연차",
            "발생휴가",
            "leave_accrued",
            "leaveaccrued",
        ],
        classification: "canonical",
        required: false,
    },
    EmployeeImportFieldDefinition {
        target: "leave_used",
        aliases: &[
            "사용연차",
            "연차사용",
            "사용휴가",
            "leave_used",
            "leaveused",
        ],
        classification: "canonical",
        required: false,
    },
    EmployeeImportFieldDefinition {
        target: "leave_remaining",
        aliases: &[
            "잔여연차",
            "남은연차",
            "연차잔여",
            "잔여휴가",
            "leave_balance",
            "leavebalance",
            "leave_remaining",
            "leaveremaining",
        ],
        classification: "canonical",
        required: false,
    },
    EmployeeImportFieldDefinition {
        target: "company",
        aliases: &[
            "회사",
            "법인",
            "소속회사",
            "계열사",
            "조직회사",
            "company",
            "corporation",
            "legal_entity",
            "legalentity",
        ],
        classification: "canonical",
        required: false,
    },
];

fn detect_employee_import_header(
    range: &calamine::Range<Data>,
    sheet: &str,
) -> Result<Option<EmployeeImportHeader>, HrError> {
    if !range
        .rows()
        .any(|row| row.iter().any(|cell| !cell_text(cell).is_empty()))
    {
        return Ok(None);
    }

    for (zero_based_row, header_cells) in range.rows().enumerate().take(MAX_IMPORT_HEADER_SCAN_ROWS)
    {
        let source_headers = header_cells.iter().map(cell_text).collect::<Vec<_>>();
        let normalized_headers = source_headers
            .iter()
            .map(|header| normalize_header_label(header))
            .collect::<Vec<_>>();
        let column_targets = normalized_headers
            .iter()
            .map(|header| employee_import_target_for_header(header))
            .collect::<Vec<_>>();
        let Some(name_index) = column_targets
            .iter()
            .position(|target| *target == Some("name"))
        else {
            continue;
        };
        let columns = source_headers
            .iter()
            .zip(normalized_headers.iter())
            .filter(|(_, normalized)| !normalized.is_empty())
            .map(|(source, normalized)| employee_import_column(source, normalized))
            .collect::<Vec<_>>();
        return Ok(Some(EmployeeImportHeader {
            zero_based_row,
            normalized_headers,
            columns,
            name_index,
        }));
    }

    Err(HrError::workbook(format!(
        "sheet {sheet} is missing an employee name header"
    )))
}

fn employee_import_column(source_header: &str, normalized_header: &str) -> EmployeeImportColumn {
    let target = employee_import_target_for_header(normalized_header).map(ToOwned::to_owned);
    let classification =
        employee_import_column_classification(normalized_header, target.as_deref());
    EmployeeImportColumn {
        source_header: source_header.trim().to_owned(),
        normalized_header: normalized_header.to_owned(),
        target,
        preview_allowed: classification == "canonical" || classification == "retained",
        classification: classification.to_owned(),
    }
}

fn employee_import_target_for_header(header: &str) -> Option<&'static str> {
    employee_import_field_for_header(header).map(|field| field.target)
}

fn import_header_match_key(header: &str) -> String {
    normalize_header_label(header)
        .chars()
        .filter(|ch| {
            !matches!(
                ch,
                '(' | ')' | '[' | ']' | '{' | '}' | '_' | '-' | '/' | '\\' | '.' | '·' | ':'
            )
        })
        .collect::<String>()
        .to_ascii_lowercase()
}

fn employee_import_column_classification(header: &str, target: Option<&str>) -> &'static str {
    if let Some(field) = target.and_then(employee_import_field_for_target) {
        return field.classification;
    }
    if is_location_header(header) {
        return "location";
    }
    if is_restricted_employee_import_header(header) {
        return "restricted";
    }
    if target.is_some() {
        return "canonical";
    }
    "retained"
}

fn employee_import_field_for_header(
    header: &str,
) -> Option<&'static EmployeeImportFieldDefinition> {
    let key = import_header_match_key(header);
    EMPLOYEE_IMPORT_FIELD_DEFINITIONS.iter().find(|field| {
        field
            .aliases
            .iter()
            .any(|alias| import_header_match_key(alias) == key)
    })
}

fn employee_import_field_for_target(
    target: &str,
) -> Option<&'static EmployeeImportFieldDefinition> {
    EMPLOYEE_IMPORT_FIELD_DEFINITIONS
        .iter()
        .find(|field| field.target == target)
}

fn is_location_header(header: &str) -> bool {
    header.contains("위치") || header.contains("주소")
}

fn is_restricted_employee_import_header(header: &str) -> bool {
    let restricted_fragments = [
        "주민",
        "급여",
        "시급",
        "통상",
        "수당",
        "국민연금",
        "건강보험",
        "고용보험",
        "산재",
        "소득세",
        "은행",
        "계좌",
        "장애",
        "퇴직금",
        "지급일",
        "급여산정",
        "휴대폰",
        "전화",
        "연락처",
        "개인주소",
        "거주주소",
    ];
    restricted_fragments
        .iter()
        .any(|fragment| header.contains(fragment))
}

fn employee_import_mapping_profile(columns: &[EmployeeImportColumn]) -> Value {
    let target_allowlist = EMPLOYEE_IMPORT_FIELD_DEFINITIONS
        .iter()
        .map(|field| field.target)
        .collect::<Vec<_>>();
    let target_catalog = EMPLOYEE_IMPORT_FIELD_DEFINITIONS
        .iter()
        .map(|field| {
            json!({
                "target": field.target,
                "aliases": field.aliases,
                "classification": field.classification,
                "required": field.required
            })
        })
        .collect::<Vec<_>>();
    json!({
        "entity_type": "employee_hr",
        "target_allowlist": target_allowlist,
        "target_catalog": target_catalog,
        "columns": columns,
        "policy": {
            "unknown_columns": "retain_raw_only",
            "restricted_columns": "retain_raw_mask_preview",
            "blank_name_rows": "preserve_raw_only",
            "header_detection": {
                "strategy": "schema_catalog_first_mappable_row",
                "scan_rows": MAX_IMPORT_HEADER_SCAN_ROWS
            },
            "company_resolution": ["mapped_company_column", "sheet_name_default"],
            "server_side_entity_allowlist": ["employee_hr"]
        }
    })
}

fn masked_preview_values(
    raw_row: &Value,
    columns: &[EmployeeImportColumn],
) -> BTreeMap<String, Value> {
    let Some(object) = raw_row.as_object() else {
        return BTreeMap::new();
    };
    columns
        .iter()
        .filter_map(|column| {
            let value = object.get(&column.normalized_header)?;
            let masked = if column.preview_allowed {
                safe_preview_value(value)
            } else if value.is_null() {
                Value::Null
            } else {
                json!("••••")
            };
            Some((column.normalized_header.clone(), masked))
        })
        .collect()
}

fn safe_preview_value(value: &Value) -> Value {
    match value {
        Value::String(value) if value.len() > 80 => {
            json!(format!(
                "{}…",
                neutralize_spreadsheet_formula(&value.chars().take(80).collect::<String>())
            ))
        }
        Value::String(value) => json!(neutralize_spreadsheet_formula(value)),
        Value::Number(_) | Value::Bool(_) | Value::Null => value.clone(),
        Value::Array(_) | Value::Object(_) => json!("복합 값"),
    }
}

fn attendance_import_target_for_header(header: &str) -> Option<&'static str> {
    let key = import_header_match_key(header);
    ATTENDANCE_IMPORT_FIELD_DEFINITIONS
        .iter()
        .find(|field| {
            field
                .aliases
                .iter()
                .any(|alias| import_header_match_key(alias) == key)
        })
        .map(|field| field.target)
}

fn attendance_import_column(
    source_header: &str,
    normalized_header: &str,
) -> AttendanceImportColumn {
    let target = attendance_import_target_for_header(normalized_header).map(ToOwned::to_owned);
    let classification = if target.is_some() {
        "canonical"
    } else if is_restricted_attendance_import_header(normalized_header) {
        "restricted"
    } else {
        "retained"
    };
    AttendanceImportColumn {
        source_header: source_header.trim().to_owned(),
        normalized_header: normalized_header.to_owned(),
        target,
        classification: classification.to_owned(),
        preview_allowed: classification == "canonical",
    }
}

fn is_restricted_attendance_import_header(header: &str) -> bool {
    let restricted_fragments = [
        "주민",
        "급여",
        "시급",
        "수당",
        "보험",
        "소득세",
        "은행",
        "계좌",
        "전화",
        "연락처",
        "휴대폰",
        "주소",
        "개인",
    ];
    restricted_fragments
        .iter()
        .any(|fragment| header.contains(fragment))
}

fn attendance_import_columns_from_rows(
    rows: &[ParsedAttendanceImportRow],
) -> Vec<AttendanceImportColumn> {
    let mut columns = BTreeMap::<String, AttendanceImportColumn>::new();
    for row in rows {
        let Some(object) = row.raw_row.as_object() else {
            continue;
        };
        for key in object.keys() {
            columns
                .entry(key.clone())
                .or_insert_with(|| attendance_import_column(key, key));
        }
    }
    columns.into_values().collect()
}

fn attendance_import_mapping_profile(columns: &[AttendanceImportColumn]) -> Value {
    let target_allowlist = ATTENDANCE_IMPORT_FIELD_DEFINITIONS
        .iter()
        .map(|field| field.target)
        .collect::<Vec<_>>();
    let target_catalog = ATTENDANCE_IMPORT_FIELD_DEFINITIONS
        .iter()
        .map(|field| {
            json!({
                "target": field.target,
                "aliases": field.aliases,
                "required": field.required
            })
        })
        .collect::<Vec<_>>();
    json!({
        "entity_type": "attendance_direct",
        "target_allowlist": target_allowlist,
        "target_catalog": target_catalog,
        "columns": columns,
        "policy": {
            "unknown_columns": "retain_raw_only",
            "restricted_columns": "retain_raw_mask_preview",
            "header_detection": {
                "strategy": "attendance_schema_catalog_first_required_row",
                "scan_rows": MAX_IMPORT_HEADER_SCAN_ROWS
            },
            "employee_resolution": ["employee_number_unique", "employee_name_unique_or_ambiguous_row_error"],
            "server_side_entity_allowlist": ["attendance_direct"],
            "payroll_effect": "lineage_only_not_payable"
        }
    })
}

fn attendance_preview_values(
    raw_row: &Value,
    columns: &[AttendanceImportColumn],
) -> BTreeMap<String, Value> {
    let Some(object) = raw_row.as_object() else {
        return BTreeMap::new();
    };
    columns
        .iter()
        .filter_map(|column| {
            let value = object.get(&column.normalized_header)?;
            let masked = if column.preview_allowed {
                safe_preview_value(value)
            } else if value.is_null() {
                Value::Null
            } else {
                json!("••••")
            };
            Some((column.normalized_header.clone(), masked))
        })
        .collect()
}

fn raw_text_for_attendance_target(
    raw_row: &Value,
    columns: &[AttendanceImportColumn],
    target: &str,
) -> Option<String> {
    let object = raw_row.as_object()?;
    columns
        .iter()
        .filter(|column| column.target.as_deref() == Some(target))
        .find_map(|column| {
            let value = object.get(&column.normalized_header)?;
            json_value_text(value)
        })
}

fn attendance_canonical_row_json(row: &ParsedAttendanceImportRow, source_sha256: &str) -> Value {
    json!({
        "source_sheet": &row.source_sheet,
        "source_row": row.source_row,
        "source_key": &row.source_key,
        "source_sha256": source_sha256,
        "canonical": {
            "employee_number": &row.employee_number,
            "employee_name": &row.employee_name,
            "branch_name": &row.branch_name,
            "work_date": &row.work_date,
            "check_in_at": &row.check_in_at,
            "check_out_at": &row.check_out_at,
            "minutes_worked": row.minutes_worked
        }
    })
}

fn attendance_validation_json(row: &ParsedAttendanceImportRow) -> Value {
    match row.row_status {
        ImportRowStatus::Candidate => json!({ "status": "ok", "errors": [], "warnings": [] }),
        ImportRowStatus::Preserved => json!({
            "status": "preserved",
            "errors": [],
            "warnings": ["row_preserved_raw_only"]
        }),
        ImportRowStatus::Error => json!({
            "status": "error",
            "errors": &row.validation_errors,
            "warnings": []
        }),
    }
}

fn import_canonical_row_json(row: &ParsedEmployeeImportRow) -> Value {
    let Some(name) = row.name.as_ref() else {
        return json!({
            "source_filename": &row.source_filename,
            "source_sheet": &row.source_sheet,
            "source_row": row.source_row,
            "source_key": &row.source_key,
            "raw_only_reason": "missing_name"
        });
    };
    json!({
        "company": &row.company,
        "name": name,
        "source_filename": &row.source_filename,
        "source_sheet": &row.source_sheet,
        "source_row": row.source_row,
        "source_key": &row.source_key,
        "source_metadata": &row.source_metadata,
        "canonical": &row.canonical
    })
}

fn import_validation_json(row: &ParsedEmployeeImportRow) -> Value {
    match row.row_status {
        ImportRowStatus::Candidate => json!({ "status": "ok", "errors": [], "warnings": [] }),
        ImportRowStatus::Preserved => json!({
            "status": "preserved",
            "errors": [],
            "warnings": ["missing_name_preserved_raw_only"]
        }),
        ImportRowStatus::Error => json!({
            "status": "error",
            "errors": ["invalid_employee_import_row"],
            "warnings": []
        }),
    }
}

async fn apply_employee_rows_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    rows: Vec<ParsedEmployeeRow>,
) -> Result<EmployeeImportReport, HrError> {
    let mut report = EmployeeImportReport::default();
    let mut by_company = BTreeMap::<String, CompanyImportSummary>::new();
    for row in rows {
        let company_entry =
            by_company
                .entry(row.company.clone())
                .or_insert_with(|| CompanyImportSummary {
                    company: row.company.clone(),
                    ..CompanyImportSummary::default()
                });
        company_entry.input_rows += 1;
        report.input_rows += 1;
        let identity = employee_identity_resolution_from_metadata(&row.source_metadata);

        let outcome: String = sqlx::query_scalar(
            r#"
            INSERT INTO employees (
                org_id, company, name, source_filename, source_sheet, source_row,
                source_key, raw_row, source_metadata, employee_number, org_unit, job,
                position, worksite_name, worksite_address, hire_date, exit_date,
                employment_status, leave_accrued, leave_used, leave_remaining,
                identity_resolution_strategy, identity_resolution_confidence,
                identity_review_required, identity_name_only_merge
            )
            VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                $14, $15, $16, $17, $18, NULLIF($19::TEXT, '')::NUMERIC,
                NULLIF($20::TEXT, '')::NUMERIC, NULLIF($21::TEXT, '')::NUMERIC,
                $22, $23, $24, $25
            )
            ON CONFLICT (org_id, source_key) DO UPDATE SET
                company = EXCLUDED.company,
                name = EXCLUDED.name,
                source_filename = EXCLUDED.source_filename,
                source_sheet = EXCLUDED.source_sheet,
                source_row = EXCLUDED.source_row,
                raw_row = EXCLUDED.raw_row,
                source_metadata = EXCLUDED.source_metadata,
                employee_number = EXCLUDED.employee_number,
                org_unit = EXCLUDED.org_unit,
                job = EXCLUDED.job,
                position = EXCLUDED.position,
                worksite_name = EXCLUDED.worksite_name,
                worksite_address = EXCLUDED.worksite_address,
                hire_date = EXCLUDED.hire_date,
                exit_date = EXCLUDED.exit_date,
                employment_status = EXCLUDED.employment_status,
                leave_accrued = EXCLUDED.leave_accrued,
                leave_used = EXCLUDED.leave_used,
                leave_remaining = EXCLUDED.leave_remaining,
                identity_resolution_strategy = EXCLUDED.identity_resolution_strategy,
                identity_resolution_confidence = EXCLUDED.identity_resolution_confidence,
                identity_review_required = EXCLUDED.identity_review_required,
                identity_name_only_merge = EXCLUDED.identity_name_only_merge,
                updated_at = now()
            RETURNING CASE WHEN xmax = 0 THEN 'inserted' ELSE 'updated' END
            "#,
        )
        .bind(org_uuid)
        .bind(&row.company)
        .bind(&row.name)
        .bind(&row.source_filename)
        .bind(&row.source_sheet)
        .bind(row.source_row)
        .bind(&row.source_key)
        .bind(&row.raw_row)
        .bind(&row.source_metadata)
        .bind(row.canonical.employee_number.as_deref())
        .bind(row.canonical.org_unit.as_deref())
        .bind(row.canonical.job.as_deref())
        .bind(row.canonical.position.as_deref())
        .bind(row.canonical.worksite_name.as_deref())
        .bind(row.canonical.worksite_address.as_deref())
        .bind(row.canonical.hire_date.as_deref())
        .bind(row.canonical.exit_date.as_deref())
        .bind(row.canonical.employment_status.as_str())
        .bind(row.canonical.leave_accrued.as_deref())
        .bind(row.canonical.leave_used.as_deref())
        .bind(row.canonical.leave_remaining.as_deref())
        .bind(&identity.strategy)
        .bind(&identity.confidence)
        .bind(identity.review_required)
        .bind(identity.name_only_merge)
        .fetch_one(tx.as_mut())
        .await?;

        if outcome == "inserted" {
            company_entry.inserted += 1;
            report.inserted += 1;
        } else {
            company_entry.updated += 1;
            report.updated += 1;
        }
    }
    report.companies = by_company.into_values().collect();
    Ok(report)
}

async fn import_run_for_update(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    run_id: Uuid,
) -> Result<DataImportRunRecord, HrError> {
    let row = sqlx::query(
        r#"
        SELECT entity_type, status, source_sha256, input_rows, candidate_rows, preserved_rows
        FROM data_import_runs
        WHERE org_id = $1 AND id = $2
        FOR UPDATE
        "#,
    )
    .bind(org_uuid)
    .bind(run_id)
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| HrError::from_kernel(KernelError::not_found("import run not found")))?;

    Ok(DataImportRunRecord {
        entity_type: row.try_get("entity_type")?,
        status: row.try_get("status")?,
        source_sha256: row.try_get("source_sha256")?,
        input_rows: row.try_get("input_rows")?,
        candidate_rows: row.try_get("candidate_rows")?,
        preserved_rows: row.try_get("preserved_rows")?,
    })
}

async fn load_candidate_import_rows(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    run_id: Uuid,
) -> Result<Vec<StoredEmployeeImportRow>, HrError> {
    sqlx::query(
        r#"
        SELECT raw_row, canonical_row
        FROM data_import_rows
        WHERE org_id = $1 AND run_id = $2 AND row_status = 'CANDIDATE'
        ORDER BY source_sheet ASC, source_row ASC
        "#,
    )
    .bind(org_uuid)
    .bind(run_id)
    .fetch_all(tx.as_mut())
    .await?
    .into_iter()
    .map(|row| stored_employee_import_row(row.try_get("raw_row")?, row.try_get("canonical_row")?))
    .collect()
}

fn stored_employee_import_row(
    raw_row: Value,
    canonical_row: Value,
) -> Result<StoredEmployeeImportRow, HrError> {
    let source_metadata = canonical_row
        .get("source_metadata")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let canonical = serde_json::from_value::<EmployeeCanonicalFields>(
        canonical_row
            .get("canonical")
            .cloned()
            .unwrap_or_else(|| json!({ "employment_status": "ACTIVE" })),
    )
    .map_err(|err| HrError::validation(format!("stored import canonical row is invalid: {err}")))?;
    Ok(StoredEmployeeImportRow {
        company: required_json_string(&canonical_row, "company")?,
        name: required_json_string(&canonical_row, "name")?,
        source_filename: required_json_string(&canonical_row, "source_filename")?,
        source_sheet: required_json_string(&canonical_row, "source_sheet")?,
        source_row: required_json_i32(&canonical_row, "source_row")?,
        source_key: required_json_string(&canonical_row, "source_key")?,
        raw_row,
        source_metadata,
        canonical,
    })
}

fn required_json_string(value: &Value, key: &'static str) -> Result<String, HrError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| HrError::validation(format!("stored import row is missing {key}")))
}

fn required_json_i32(value: &Value, key: &'static str) -> Result<i32, HrError> {
    let number = value
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| HrError::validation(format!("stored import row is missing {key}")))?;
    i32::try_from(number)
        .map_err(|_| HrError::validation(format!("stored import row {key} does not fit i32")))
}

#[derive(Debug, Clone, Deserialize)]
struct AttendanceCanonicalFields {
    employee_number: Option<String>,
    employee_name: Option<String>,
    branch_name: Option<String>,
    work_date: Option<String>,
    check_in_at: Option<String>,
    check_out_at: Option<String>,
    minutes_worked: Option<i32>,
}

#[derive(Debug)]
struct StoredAttendanceImportRow {
    import_row_id: Uuid,
    source_sheet: String,
    source_row: i32,
    source_key: String,
    row_status: ImportRowStatus,
    canonical: AttendanceCanonicalFields,
    validation_errors: Vec<String>,
}

#[derive(Debug, Clone)]
struct ResolvedAttendanceImportRow {
    import_row_id: Uuid,
    employee_id: Uuid,
    branch_id: Uuid,
    source_sheet: String,
    source_row: i32,
    source_key: String,
    employee_number: Option<String>,
    employee_name: String,
    branch_name: String,
    work_date: String,
    check_in_at: Option<String>,
    check_out_at: Option<String>,
    minutes_worked: Option<i32>,
    fact_key: String,
}

struct AttendanceEmployeeResolution {
    id: Uuid,
    name: String,
    employee_number: Option<String>,
}

enum AttendanceEmployeeLookup {
    Matched(AttendanceEmployeeResolution),
    Missing,
    Ambiguous,
}

struct AttendanceBranchResolution {
    id: Uuid,
    name: String,
}

enum AttendanceBranchLookup {
    Matched(AttendanceBranchResolution),
    Missing,
    Ambiguous,
}

async fn load_attendance_import_rows(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    run_id: Uuid,
) -> Result<Vec<StoredAttendanceImportRow>, HrError> {
    sqlx::query(
        r#"
        SELECT id, source_sheet, source_row, source_key, row_status, canonical_row, validation
        FROM data_import_rows
        WHERE org_id = $1 AND run_id = $2
        ORDER BY source_sheet ASC, source_row ASC
        "#,
    )
    .bind(org_uuid)
    .bind(run_id)
    .fetch_all(tx.as_mut())
    .await?
    .into_iter()
    .map(stored_attendance_import_row)
    .collect()
}

fn stored_attendance_import_row(
    row: sqlx::postgres::PgRow,
) -> Result<StoredAttendanceImportRow, HrError> {
    let canonical_row: Value = row.try_get("canonical_row")?;
    let validation: Value = row.try_get("validation")?;
    let canonical = serde_json::from_value::<AttendanceCanonicalFields>(
        canonical_row
            .get("canonical")
            .cloned()
            .unwrap_or_else(|| json!({})),
    )
    .map_err(|err| {
        HrError::validation(format!(
            "stored attendance import canonical row is invalid: {err}"
        ))
    })?;
    let row_status_raw: String = row.try_get("row_status")?;
    let validation_errors = validation
        .get("errors")
        .and_then(Value::as_array)
        .map(|errors| {
            errors
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(StoredAttendanceImportRow {
        import_row_id: row.try_get("id")?,
        source_sheet: row.try_get("source_sheet")?,
        source_row: row.try_get("source_row")?,
        source_key: row.try_get("source_key")?,
        row_status: ImportRowStatus::from_db(&row_status_raw)?,
        canonical,
        validation_errors,
    })
}

fn ensure_attendance_import_run(
    run: &DataImportRunRecord,
    allowed_statuses: &[&str],
) -> Result<(), HrError> {
    if run.entity_type != "attendance_direct" {
        return Err(HrError::from_kernel(KernelError::conflict(
            "import run is not an attendance_direct run",
        )));
    }
    if !allowed_statuses.iter().any(|status| *status == run.status) {
        return Err(HrError::from_kernel(KernelError::conflict(format!(
            "attendance import run status {} is not allowed for this transition",
            run.status
        ))));
    }
    Ok(())
}

async fn resolve_attendance_import_rows(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    run_id: Uuid,
    run: &DataImportRunRecord,
    rows: &[StoredAttendanceImportRow],
) -> Result<AttendanceImportDryRunSummary, HrError> {
    let source_keys = rows
        .iter()
        .map(|row| row.source_key.clone())
        .collect::<Vec<_>>();
    let existing_keys = if source_keys.is_empty() {
        BTreeSet::new()
    } else {
        sqlx::query_scalar::<_, String>(
            r#"
            SELECT source_key
            FROM attendance_direct_import_events
            WHERE org_id = $1 AND source_sha256 = $2 AND source_key = ANY($3)
            "#,
        )
        .bind(org_uuid)
        .bind(&run.source_sha256)
        .bind(&source_keys)
        .fetch_all(tx.as_mut())
        .await?
        .into_iter()
        .collect::<BTreeSet<_>>()
    };

    let mut summary = AttendanceImportDryRunSummary {
        run_id,
        input_rows: usize::try_from(run.input_rows).unwrap_or_default(),
        candidate_rows: usize::try_from(run.candidate_rows).unwrap_or_default(),
        preserved_rows: usize::try_from(run.preserved_rows).unwrap_or_default(),
        ..AttendanceImportDryRunSummary::default()
    };

    let mut resolved_fact_keys = BTreeSet::<String>::new();

    for row in rows {
        if row.row_status != ImportRowStatus::Candidate {
            summary.error_rows += 1;
            if row.validation_errors.is_empty() {
                summary.row_errors.push(attendance_row_error(
                    row,
                    "invalid_row",
                    "attendance import row is not a candidate",
                ));
            } else {
                for code in &row.validation_errors {
                    summary
                        .row_errors
                        .push(attendance_row_error(row, code, code));
                }
            }
            continue;
        }

        if existing_keys.contains(&row.source_key) {
            summary.error_rows += 1;
            summary.duplicate_rows += 1;
            summary.row_errors.push(attendance_row_error(
                row,
                "duplicate_import_row",
                "attendance import row source key was already applied",
            ));
            continue;
        }

        let employee = match resolve_attendance_employee(tx, org_uuid, row).await? {
            AttendanceEmployeeLookup::Matched(employee) => employee,
            AttendanceEmployeeLookup::Missing => {
                summary.error_rows += 1;
                summary.missing_employee_rows += 1;
                summary.row_errors.push(attendance_row_error(
                    row,
                    "missing_employee",
                    "no employee matched the attendance row identifier",
                ));
                continue;
            }
            AttendanceEmployeeLookup::Ambiguous => {
                summary.error_rows += 1;
                summary.ambiguous_employee_rows += 1;
                summary.row_errors.push(attendance_row_error(
                    row,
                    "ambiguous_employee",
                    "attendance row identifier matched multiple employees",
                ));
                continue;
            }
        };
        let branch = match resolve_attendance_branch(tx, org_uuid, row).await? {
            AttendanceBranchLookup::Matched(branch) => branch,
            AttendanceBranchLookup::Missing => {
                summary.error_rows += 1;
                summary.row_errors.push(attendance_row_error(
                    row,
                    "missing_branch",
                    "no branch matched the attendance row branch name",
                ));
                continue;
            }
            AttendanceBranchLookup::Ambiguous => {
                summary.error_rows += 1;
                summary.row_errors.push(attendance_row_error(
                    row,
                    "ambiguous_branch",
                    "attendance row branch name matched multiple branches",
                ));
                continue;
            }
        };

        let employee_number = row
            .canonical
            .employee_number
            .clone()
            .or(employee.employee_number.clone());
        let Some(work_date) = row.canonical.work_date.clone() else {
            summary.error_rows += 1;
            summary.row_errors.push(attendance_row_error(
                row,
                "missing_work_date",
                "work_date is required",
            ));
            continue;
        };

        let fact_key = attendance_fact_key(
            employee.id,
            branch.id,
            &work_date,
            row.canonical.check_in_at.as_deref(),
            row.canonical.check_out_at.as_deref(),
            row.canonical.minutes_worked,
        );
        if !resolved_fact_keys.insert(fact_key.clone()) {
            summary.error_rows += 1;
            summary.duplicate_rows += 1;
            summary.row_errors.push(attendance_row_error(
                row,
                "duplicate_attendance_fact_in_file",
                "attendance fact is duplicated within this import run",
            ));
            continue;
        }
        if attendance_fact_exists(tx, org_uuid, &fact_key).await? {
            summary.error_rows += 1;
            summary.duplicate_rows += 1;
            summary.row_errors.push(attendance_row_error(
                row,
                "duplicate_attendance_fact",
                "attendance fact was already imported",
            ));
            continue;
        }

        summary
            .ready_rows_for_apply
            .push(ResolvedAttendanceImportRow {
                import_row_id: row.import_row_id,
                employee_id: employee.id,
                branch_id: branch.id,
                source_sheet: row.source_sheet.clone(),
                source_row: row.source_row,
                source_key: row.source_key.clone(),
                employee_number,
                employee_name: employee.name,
                branch_name: branch.name,
                work_date,
                check_in_at: row.canonical.check_in_at.clone(),
                check_out_at: row.canonical.check_out_at.clone(),
                minutes_worked: row.canonical.minutes_worked,
                fact_key,
            });
    }

    summary.ready_rows = summary.ready_rows_for_apply.len();
    Ok(summary)
}

async fn resolve_attendance_employee(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    row: &StoredAttendanceImportRow,
) -> Result<AttendanceEmployeeLookup, HrError> {
    let records = if let Some(employee_number) = row.canonical.employee_number.as_deref() {
        sqlx::query(
            r#"
            SELECT id, name, employee_number
            FROM employees
            WHERE org_id = $1 AND employee_number = $2
            ORDER BY id
            LIMIT 2
            "#,
        )
        .bind(org_uuid)
        .bind(employee_number)
        .fetch_all(tx.as_mut())
        .await?
    } else if let Some(employee_name) = row.canonical.employee_name.as_deref() {
        sqlx::query(
            r#"
            SELECT id, name, employee_number
            FROM employees
            WHERE org_id = $1 AND name = $2
            ORDER BY id
            LIMIT 2
            "#,
        )
        .bind(org_uuid)
        .bind(employee_name)
        .fetch_all(tx.as_mut())
        .await?
    } else {
        return Ok(AttendanceEmployeeLookup::Missing);
    };

    if records.is_empty() {
        return Ok(AttendanceEmployeeLookup::Missing);
    }
    if records.len() > 1 {
        return Ok(AttendanceEmployeeLookup::Ambiguous);
    }
    let Some(row) = records.into_iter().next() else {
        return Ok(AttendanceEmployeeLookup::Missing);
    };
    Ok(AttendanceEmployeeLookup::Matched(
        AttendanceEmployeeResolution {
            id: row.try_get("id")?,
            name: row.try_get("name")?,
            employee_number: row.try_get("employee_number")?,
        },
    ))
}

async fn resolve_attendance_branch(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    row: &StoredAttendanceImportRow,
) -> Result<AttendanceBranchLookup, HrError> {
    let Some(branch_name) = row.canonical.branch_name.as_deref() else {
        return Ok(AttendanceBranchLookup::Missing);
    };
    let records = sqlx::query(
        r#"
        SELECT id, name
        FROM branches
        WHERE org_id = $1 AND name = $2
        ORDER BY id
        LIMIT 2
        "#,
    )
    .bind(org_uuid)
    .bind(branch_name)
    .fetch_all(tx.as_mut())
    .await?;

    if records.is_empty() {
        return Ok(AttendanceBranchLookup::Missing);
    }
    if records.len() > 1 {
        return Ok(AttendanceBranchLookup::Ambiguous);
    }
    let Some(row) = records.into_iter().next() else {
        return Ok(AttendanceBranchLookup::Missing);
    };
    Ok(AttendanceBranchLookup::Matched(
        AttendanceBranchResolution {
            id: row.try_get("id")?,
            name: row.try_get("name")?,
        },
    ))
}

async fn attendance_fact_exists(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    fact_key: &str,
) -> Result<bool, HrError> {
    let exists: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM attendance_direct_import_events
            WHERE org_id = $1 AND fact_key = $2
        )
        "#,
    )
    .bind(org_uuid)
    .bind(fact_key)
    .fetch_one(tx.as_mut())
    .await?;
    Ok(exists)
}

fn attendance_fact_key(
    employee_id: Uuid,
    branch_id: Uuid,
    work_date: &str,
    check_in_at: Option<&str>,
    check_out_at: Option<&str>,
    minutes_worked: Option<i32>,
) -> String {
    format!(
        "employee:{employee_id}|branch:{branch_id}|date:{work_date}|in:{}|out:{}|minutes:{}",
        check_in_at.unwrap_or_default(),
        check_out_at.unwrap_or_default(),
        minutes_worked
            .map(|value| value.to_string())
            .unwrap_or_default()
    )
}

fn attendance_row_error(
    row: &StoredAttendanceImportRow,
    code: impl Into<String>,
    message: impl Into<String>,
) -> AttendanceImportRowError {
    AttendanceImportRowError {
        source_sheet: row.source_sheet.clone(),
        source_row: row.source_row,
        source_key: row.source_key.clone(),
        code: code.into(),
        message: message.into(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct EmployeeIdentityResolution {
    strategy: String,
    confidence: String,
    review_required: bool,
    name_only_merge: bool,
}

fn employee_identity_resolution_from_metadata(metadata: &Value) -> EmployeeIdentityResolution {
    let identity = metadata
        .get("identity_resolution")
        .and_then(Value::as_object);
    let strategy = identity
        .and_then(|value| value.get("strategy"))
        .and_then(Value::as_str)
        .filter(|value| {
            matches!(
                *value,
                "employee_number"
                    | "legal_identifier_hash"
                    | "birth_hire_fingerprint"
                    | "source_row_fingerprint"
            )
        })
        .unwrap_or("source_row_fingerprint")
        .to_owned();
    let confidence = match strategy.as_str() {
        "employee_number" | "legal_identifier_hash" => "high",
        "birth_hire_fingerprint" => "medium",
        _ => "low",
    }
    .to_owned();
    let explicit_review_clearance = identity
        .and_then(|value| value.get("manual_review_required"))
        .and_then(Value::as_bool)
        == Some(false);
    let review_required = !(explicit_review_clearance
        && matches!(
            strategy.as_str(),
            "employee_number" | "legal_identifier_hash"
        ));

    EmployeeIdentityResolution {
        strategy,
        confidence,
        review_required,
        // Name-only merging is not a supported identity strategy. Even if stale
        // or malicious import metadata claims otherwise, keep the public record
        // non-mergeable until HR performs an explicit reviewed resolution.
        name_only_merge: false,
    }
}

async fn compute_employee_import_dry_run(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    run_id: Uuid,
    run: &DataImportRunRecord,
    rows: &[StoredEmployeeImportRow],
) -> Result<EmployeeImportDryRunSummary, HrError> {
    let source_keys = rows
        .iter()
        .map(|row| row.source_key.clone())
        .collect::<Vec<_>>();
    let existing = if source_keys.is_empty() {
        Vec::new()
    } else {
        sqlx::query_scalar::<_, String>(
            "SELECT source_key FROM employees WHERE org_id = $1 AND source_key = ANY($2)",
        )
        .bind(org_uuid)
        .bind(&source_keys)
        .fetch_all(tx.as_mut())
        .await?
    };
    let existing = existing
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>();
    let mut by_company = BTreeMap::<String, CompanyImportSummary>::new();
    let mut insert_candidates = 0usize;
    let mut update_candidates = 0usize;
    for row in rows {
        let entry = by_company
            .entry(row.company.clone())
            .or_insert_with(|| CompanyImportSummary {
                company: row.company.clone(),
                ..CompanyImportSummary::default()
            });
        entry.input_rows += 1;
        if existing.contains(&row.source_key) {
            entry.updated += 1;
            update_candidates += 1;
        } else {
            entry.inserted += 1;
            insert_candidates += 1;
        }
    }
    Ok(EmployeeImportDryRunSummary {
        run_id,
        input_rows: usize::try_from(run.input_rows).unwrap_or_default(),
        candidate_rows: usize::try_from(run.candidate_rows).unwrap_or_default(),
        preserved_rows: usize::try_from(run.preserved_rows).unwrap_or_default(),
        insert_candidates,
        update_candidates,
        companies: by_company.into_values().collect(),
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

#[derive(Debug)]
struct NormalizedEmployeeLifecycleTransition {
    event_type: String,
    to_status: String,
    to_company: Option<String>,
    to_org_unit: Option<String>,
    to_position: Option<String>,
    effective_date: String,
    comment: String,
    signoffs: EmployeeLifecycleSignoffs,
}

fn normalize_lifecycle_transition(
    body: CreateEmployeeLifecycleEventRequest,
) -> Result<NormalizedEmployeeLifecycleTransition, HrError> {
    let event_type = normalize_enum_text(body.event_type);
    if !matches!(
        event_type.as_str(),
        "ONBOARD" | "OFFBOARD" | "TERMINATE" | "TRANSFER"
    ) {
        return Err(HrError::validation(
            "event_type must be ONBOARD, OFFBOARD, TERMINATE, or TRANSFER",
        ));
    }

    let to_status = body
        .to_status
        .map(normalize_enum_text)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default_lifecycle_status(&event_type).to_owned());
    if !matches!(to_status.as_str(), "ACTIVE" | "EXITED" | "UNKNOWN") {
        return Err(HrError::validation(
            "to_status must be ACTIVE, EXITED, or UNKNOWN",
        ));
    }

    let effective_date = body.effective_date.trim().to_owned();
    if effective_date.is_empty() {
        return Err(HrError::validation("effective_date is required"));
    }
    let comment = body.comment.trim().to_owned();
    if comment.is_empty() {
        return Err(HrError::validation("comment is required"));
    }

    Ok(NormalizedEmployeeLifecycleTransition {
        event_type,
        to_status,
        to_company: normalize_optional_text(body.to_company),
        to_org_unit: normalize_optional_text(body.to_org_unit),
        to_position: normalize_optional_text(body.to_position),
        effective_date,
        comment,
        signoffs: body.signoffs,
    })
}

fn default_lifecycle_status(event_type: &str) -> &'static str {
    match event_type {
        "OFFBOARD" | "TERMINATE" => "EXITED",
        "ONBOARD" | "TRANSFER" => "ACTIVE",
        _ => "UNKNOWN",
    }
}

fn validate_lifecycle_transition(
    current: &EmployeeForLifecycle,
    transition: &NormalizedEmployeeLifecycleTransition,
) -> Result<(), HrError> {
    if !transition.signoffs.privacy_notice_ack {
        return Err(HrError::validation(
            "privacy_notice_ack is required for employee lifecycle events",
        ));
    }
    if !transition.signoffs.korean_labor_law_ack {
        return Err(HrError::validation(
            "korean_labor_law_ack is required for employee lifecycle events",
        ));
    }

    let current_status = normalize_enum_text(current.employment_status.clone());
    match transition.event_type.as_str() {
        "ONBOARD" => {
            if transition.to_status != "ACTIVE" {
                return Err(HrError::from_kernel(KernelError::invalid_transition(
                    "ONBOARD must result in ACTIVE status",
                )));
            }
        }
        "OFFBOARD" | "TERMINATE" => {
            if current_status == "EXITED" {
                return Err(HrError::from_kernel(KernelError::invalid_transition(
                    "employee is already EXITED",
                )));
            }
            if transition.to_status != "EXITED" {
                return Err(HrError::from_kernel(KernelError::invalid_transition(
                    "OFFBOARD and TERMINATE must result in EXITED status",
                )));
            }
            if !transition.signoffs.payroll_cutoff_ack {
                return Err(HrError::validation(
                    "payroll_cutoff_ack is required before offboarding or termination",
                ));
            }
            if !transition.signoffs.retirement_settlement_ack {
                return Err(HrError::validation(
                    "retirement_settlement_ack is required before offboarding or termination",
                ));
            }
        }
        "TRANSFER" => {
            if transition.to_status != "ACTIVE" {
                return Err(HrError::from_kernel(KernelError::invalid_transition(
                    "TRANSFER must keep the employee ACTIVE",
                )));
            }
            let cross_company = transition
                .to_company
                .as_ref()
                .is_some_and(|next| next != &current.company);
            if cross_company
                && (!transition.signoffs.payroll_cutoff_ack
                    || !transition.signoffs.retirement_settlement_ack)
            {
                return Err(HrError::validation(
                    "cross-company transfer requires payroll cutoff and retirement-settlement signoffs",
                ));
            }
        }
        _ => {}
    }
    Ok(())
}

async fn load_employee_for_lifecycle(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    employee_id: Uuid,
) -> Result<EmployeeForLifecycle, HrError> {
    let row = sqlx::query(
        r#"
        SELECT company, org_unit, position, employment_status
        FROM employees
        WHERE org_id = $1 AND id = $2
        FOR UPDATE
        "#,
    )
    .bind(org_uuid)
    .bind(employee_id)
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| HrError::from_kernel(KernelError::not_found("employee not found")))?;

    Ok(EmployeeForLifecycle {
        company: row.try_get("company")?,
        org_unit: row.try_get("org_unit")?,
        position: row.try_get("position")?,
        employment_status: row.try_get("employment_status")?,
    })
}
async fn load_linked_employee_for_user(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: OrgId,
    user_id: UserId,
    lock_user: bool,
) -> Result<LinkedEmployee, HrError> {
    let sql = if lock_user {
        r#"
        SELECT u.employee_id, e.name AS employee_name
        FROM users u
        LEFT JOIN employees e
          ON e.id = u.employee_id
         AND e.org_id = u.org_id
        WHERE u.id = $1
          AND u.org_id = $2
        FOR UPDATE OF u
        "#
    } else {
        r#"
        SELECT u.employee_id, e.name AS employee_name
        FROM users u
        LEFT JOIN employees e
          ON e.id = u.employee_id
         AND e.org_id = u.org_id
        WHERE u.id = $1
          AND u.org_id = $2
        "#
    };

    let row = sqlx::query(sql)
        .bind(*user_id.as_uuid())
        .bind(*org.as_uuid())
        .fetch_optional(tx.as_mut())
        .await?
        .ok_or_else(|| {
            HrError::from_kernel(KernelError::forbidden("linked employee account required"))
        })?;

    let employee_id = row
        .try_get::<Option<Uuid>, _>("employee_id")?
        .ok_or_else(|| {
            HrError::from_kernel(KernelError::forbidden("linked employee account required"))
        })?;
    let display_name = row
        .try_get::<Option<String>, _>("employee_name")?
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            HrError::from_kernel(KernelError::forbidden("linked employee record required"))
        })?;

    Ok(LinkedEmployee {
        employee_id,
        display_name,
    })
}

async fn list_attendance_records_for_employee(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    employee_id: Uuid,
    limit: i64,
    offset: i64,
) -> Result<EmployeeAttendanceRecordPage, HrError> {
    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT FROM employee_attendance_records WHERE employee_id = $1",
    )
    .bind(employee_id)
    .fetch_one(tx.as_mut())
    .await?;

    let rows = sqlx::query(
        r#"
        SELECT
            r.id,
            r.employee_id,
            e.name AS employee_display_name,
            r.kind,
            r.occurred_at,
            r.work_date::TEXT AS work_date,
            r.state_after,
            r.note,
            pmr.id AS payroll_material_ref_id
        FROM employee_attendance_records r
        JOIN employees e
          ON e.id = r.employee_id
         AND e.org_id = r.org_id
        JOIN payroll_attendance_material_refs pmr
          ON pmr.attendance_record_id = r.id
         AND pmr.org_id = r.org_id
        WHERE r.employee_id = $1
        ORDER BY r.occurred_at DESC, r.created_at DESC, r.id DESC
        LIMIT $2 OFFSET $3
        "#,
    )
    .bind(employee_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(tx.as_mut())
    .await?;

    let items = rows
        .into_iter()
        .map(|row| employee_attendance_record_from_joined_row(row, false))
        .collect::<Result<Vec<_>, _>>()?;

    Ok(EmployeeAttendanceRecordPage {
        items,
        total,
        limit,
        offset,
    })
}

async fn list_attendance_records_for_org(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    limit: i64,
    offset: i64,
) -> Result<EmployeeAttendanceRecordPage, HrError> {
    let total: i64 = sqlx::query_scalar("SELECT COUNT(*)::BIGINT FROM employee_attendance_records")
        .fetch_one(tx.as_mut())
        .await?;

    let rows = sqlx::query(
        r#"
        SELECT
            r.id,
            r.employee_id,
            e.name AS employee_display_name,
            r.kind,
            r.occurred_at,
            r.work_date::TEXT AS work_date,
            r.state_after,
            r.note,
            pmr.id AS payroll_material_ref_id
        FROM employee_attendance_records r
        JOIN employees e
          ON e.id = r.employee_id
         AND e.org_id = r.org_id
        JOIN payroll_attendance_material_refs pmr
          ON pmr.attendance_record_id = r.id
         AND pmr.org_id = r.org_id
        ORDER BY r.occurred_at DESC, r.created_at DESC, r.id DESC
        LIMIT $1 OFFSET $2
        "#,
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(tx.as_mut())
    .await?;

    let items = rows
        .into_iter()
        .map(|row| employee_attendance_record_from_joined_row(row, false))
        .collect::<Result<Vec<_>, _>>()?;

    Ok(EmployeeAttendanceRecordPage {
        items,
        total,
        limit,
        offset,
    })
}

async fn load_attendance_record_by_idempotency_key(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    employee_id: Uuid,
    idempotency_key: &str,
) -> Result<Option<EmployeeAttendanceRecordResponse>, HrError> {
    let row = sqlx::query(
        r#"
        SELECT
            r.id,
            r.employee_id,
            e.name AS employee_display_name,
            r.kind,
            r.occurred_at,
            r.work_date::TEXT AS work_date,
            r.state_after,
            r.note,
            pmr.id AS payroll_material_ref_id
        FROM employee_attendance_records r
        JOIN employees e
          ON e.id = r.employee_id
         AND e.org_id = r.org_id
        JOIN payroll_attendance_material_refs pmr
          ON pmr.attendance_record_id = r.id
         AND pmr.org_id = r.org_id
        WHERE r.employee_id = $1
          AND r.idempotency_key = $2
        "#,
    )
    .bind(employee_id)
    .bind(idempotency_key)
    .fetch_optional(tx.as_mut())
    .await?;

    row.map(|row| employee_attendance_record_from_joined_row(row, true))
        .transpose()
}

fn employee_attendance_record_from_joined_row(
    row: sqlx::postgres::PgRow,
    duplicate: bool,
) -> Result<EmployeeAttendanceRecordResponse, HrError> {
    Ok(EmployeeAttendanceRecordResponse {
        id: row.try_get("id")?,
        employee_id: row.try_get("employee_id")?,
        employee_display_name: row.try_get("employee_display_name")?,
        kind: row.try_get("kind")?,
        occurred_at: row.try_get("occurred_at")?,
        work_date: row.try_get("work_date")?,
        state_after: row.try_get("state_after")?,
        note: row.try_get("note")?,
        payroll_material_ref_id: row.try_get("payroll_material_ref_id")?,
        payroll_link_status: "LINKED".to_owned(),
        duplicate,
    })
}

fn employee_attendance_record_from_parts(
    row: sqlx::postgres::PgRow,
    employee_display_name: String,
    payroll_material_ref_id: Uuid,
    duplicate: bool,
) -> Result<EmployeeAttendanceRecordResponse, HrError> {
    Ok(EmployeeAttendanceRecordResponse {
        id: row.try_get("id")?,
        employee_id: row.try_get("employee_id")?,
        employee_display_name,
        kind: row.try_get("kind")?,
        occurred_at: row.try_get("occurred_at")?,
        work_date: row.try_get("work_date")?,
        state_after: row.try_get("state_after")?,
        note: row.try_get("note")?,
        payroll_material_ref_id,
        payroll_link_status: "LINKED".to_owned(),
        duplicate,
    })
}

fn normalize_attendance_kind(raw: &str) -> Result<&'static str, HrError> {
    match raw.trim().to_ascii_uppercase().as_str() {
        "CLOCK_IN" => Ok("CLOCK_IN"),
        "OUT_FOR_WORK" => Ok("OUT_FOR_WORK"),
        "BUSINESS_TRIP" => Ok("BUSINESS_TRIP"),
        "RETURNED" => Ok("RETURNED"),
        "CLOCK_OUT" => Ok("CLOCK_OUT"),
        _ => Err(HrError::validation("unsupported attendance record kind")),
    }
}

fn normalize_idempotency_key(value: Option<String>) -> Result<Option<String>, HrError> {
    match normalize_optional_text(value) {
        Some(value) if value.chars().count() > 128 => Err(HrError::validation(
            "idempotency key must be 128 characters or fewer",
        )),
        value => Ok(value),
    }
}

fn normalize_attendance_note(value: Option<String>) -> Result<Option<String>, HrError> {
    match normalize_optional_text(value) {
        Some(value) if value.chars().count() > 500 => Err(HrError::validation(
            "attendance note must be 500 characters or fewer",
        )),
        value => Ok(value),
    }
}

fn next_employee_attendance_state(
    previous_state: Option<&str>,
    kind: &str,
) -> Result<&'static str, HrError> {
    match (previous_state.unwrap_or("OFF_DUTY"), kind) {
        ("OFF_DUTY", "CLOCK_IN") => Ok("CLOCKED_IN"),
        ("CLOCKED_IN", "OUT_FOR_WORK") => Ok("OUT_FOR_WORK"),
        ("CLOCKED_IN", "BUSINESS_TRIP") => Ok("BUSINESS_TRIP"),
        ("CLOCKED_IN", "CLOCK_OUT") => Ok("OFF_DUTY"),
        ("OUT_FOR_WORK", "RETURNED") | ("BUSINESS_TRIP", "RETURNED") => Ok("CLOCKED_IN"),
        ("OUT_FOR_WORK", "CLOCK_OUT") | ("BUSINESS_TRIP", "CLOCK_OUT") => Ok("OFF_DUTY"),
        (_, _) => Err(HrError::from_kernel(KernelError::invalid_transition(
            "invalid employee attendance transition",
        ))),
    }
}

fn employee_lifecycle_event_from_row(
    row: sqlx::postgres::PgRow,
) -> Result<EmployeeLifecycleEventResponse, HrError> {
    let signoffs: Value = row.try_get("signoffs")?;
    let signoffs = serde_json::from_value::<EmployeeLifecycleSignoffs>(signoffs)
        .map_err(|err| HrError::validation(format!("invalid lifecycle signoffs: {err}")))?;
    Ok(EmployeeLifecycleEventResponse {
        id: row.try_get("id")?,
        employee_id: row.try_get("employee_id")?,
        event_type: row.try_get("event_type")?,
        from_status: row.try_get("from_status")?,
        to_status: row.try_get("to_status")?,
        from_company: row.try_get("from_company")?,
        to_company: row.try_get("to_company")?,
        from_org_unit: row.try_get("from_org_unit")?,
        to_org_unit: row.try_get("to_org_unit")?,
        from_position: row.try_get("from_position")?,
        to_position: row.try_get("to_position")?,
        effective_date: row.try_get("effective_date")?,
        comment: row.try_get("comment")?,
        signoffs,
        created_by: row.try_get("created_by")?,
        created_at: row.try_get("created_at")?,
    })
}

fn normalize_enum_text(value: String) -> String {
    value.trim().to_ascii_uppercase()
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn employee_from_row(row: sqlx::postgres::PgRow) -> Result<EmployeeResponse, HrError> {
    Ok(EmployeeResponse {
        id: row.try_get("id")?,
        company: row.try_get("company")?,
        name: row.try_get("name")?,
        employee_number: row.try_get("employee_number")?,
        org_unit: row.try_get("org_unit")?,
        worksite_name: row.try_get("worksite_name")?,
        worksite: row.try_get("worksite_address")?,
        job: row.try_get("job")?,
        position: row.try_get("position")?,
        hire_date: row.try_get("hire_date")?,
        exit_date: row.try_get("exit_date")?,
        status: row.try_get("employment_status")?,
        leave_accrued: row.try_get("leave_accrued")?,
        leave_used: row.try_get("leave_used")?,
        leave_remaining: row.try_get("leave_remaining")?,
        identity_resolution_strategy: row.try_get("identity_resolution_strategy")?,
        identity_resolution_confidence: row.try_get("identity_resolution_confidence")?,
        identity_review_required: row.try_get("identity_review_required")?,
        identity_name_only_merge: row.try_get("identity_name_only_merge")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn standardized_employees_csv(rows: &[sqlx::postgres::PgRow]) -> Result<String, HrError> {
    let mut csv =
        "company,name,employee_number,org_unit,worksite_name,job,position,hire_date,exit_date,status,leave_remaining\r\n"
            .to_owned();
    for row in rows {
        let cells = [
            optional_row_text(row, "company")?,
            optional_row_text(row, "name")?,
            optional_row_text(row, "employee_number")?,
            optional_row_text(row, "org_unit")?,
            optional_row_text(row, "worksite_name")?,
            optional_row_text(row, "job")?,
            optional_row_text(row, "position")?,
            optional_row_text(row, "hire_date")?,
            optional_row_text(row, "exit_date")?,
            optional_row_text(row, "employment_status")?,
            optional_row_text(row, "leave_remaining")?,
        ];
        csv.push_str(
            &cells
                .iter()
                .map(|cell| csv_field(cell))
                .collect::<Vec<_>>()
                .join(","),
        );
        csv.push_str("\r\n");
    }
    Ok(csv)
}

fn optional_row_text(row: &sqlx::postgres::PgRow, key: &str) -> Result<String, HrError> {
    Ok(row.try_get::<Option<String>, _>(key)?.unwrap_or_default())
}

fn csv_field(value: &str) -> String {
    let safe = neutralize_spreadsheet_formula(value);
    if safe.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", safe.replace('"', "\"\""))
    } else {
        safe
    }
}

fn neutralize_spreadsheet_formula(value: &str) -> String {
    if matches!(value.chars().next(), Some('=' | '+' | '-' | '@')) {
        format!("'{value}")
    } else {
        value.to_owned()
    }
}

#[cfg(test)]
fn canonical_employee_fields(raw_row: &Value) -> EmployeeCanonicalFields {
    let exit_date = raw_text(raw_row, target_header_aliases("exit_date"));
    EmployeeCanonicalFields {
        employee_number: raw_text(raw_row, target_header_aliases("employee_number")),
        org_unit: raw_text(raw_row, target_header_aliases("org_unit")),
        job: raw_text(raw_row, target_header_aliases("job")),
        position: raw_text(raw_row, target_header_aliases("position")),
        worksite_name: raw_text(raw_row, target_header_aliases("worksite_name")),
        worksite_address: raw_text(raw_row, target_header_aliases("worksite_address")),
        hire_date: raw_text(raw_row, target_header_aliases("hire_date")),
        exit_date: exit_date.clone(),
        employment_status: if exit_date.is_some() {
            "EXITED"
        } else {
            "ACTIVE"
        }
        .to_owned(),
        leave_accrued: raw_decimal_text(raw_row, target_header_aliases("leave_accrued")),
        leave_used: raw_decimal_text(raw_row, target_header_aliases("leave_used")),
        leave_remaining: raw_decimal_text(raw_row, target_header_aliases("leave_remaining")),
    }
}

fn canonical_employee_fields_for_import(
    raw_row: &Value,
    columns: &[EmployeeImportColumn],
) -> EmployeeCanonicalFields {
    let exit_date = raw_text_for_import_target(raw_row, columns, "exit_date");
    EmployeeCanonicalFields {
        employee_number: raw_text_for_import_target(raw_row, columns, "employee_number"),
        org_unit: raw_text_for_import_target(raw_row, columns, "org_unit"),
        job: raw_text_for_import_target(raw_row, columns, "job"),
        position: raw_text_for_import_target(raw_row, columns, "position"),
        worksite_name: raw_text_for_import_target(raw_row, columns, "worksite_name"),
        worksite_address: raw_text_for_import_target(raw_row, columns, "worksite_address"),
        hire_date: raw_text_for_import_target(raw_row, columns, "hire_date"),
        exit_date: exit_date.clone(),
        employment_status: if exit_date.is_some() {
            "EXITED"
        } else {
            "ACTIVE"
        }
        .to_owned(),
        leave_accrued: raw_decimal_text_for_import_target(raw_row, columns, "leave_accrued"),
        leave_used: raw_decimal_text_for_import_target(raw_row, columns, "leave_used"),
        leave_remaining: raw_decimal_text_for_import_target(raw_row, columns, "leave_remaining"),
    }
}

#[cfg(test)]
fn raw_decimal_text(raw_row: &Value, headers: &[&str]) -> Option<String> {
    let raw = raw_text(raw_row, headers)?;
    normalized_decimal_text(&raw)
}

fn raw_decimal_text_for_import_target(
    raw_row: &Value,
    columns: &[EmployeeImportColumn],
    target: &str,
) -> Option<String> {
    let raw = raw_text_for_import_target(raw_row, columns, target)?;
    normalized_decimal_text(&raw)
}

fn normalized_decimal_text(raw: &str) -> Option<String> {
    let cleaned = raw.replace(',', "").trim().to_owned();
    let value = cleaned.parse::<f64>().ok()?;
    if !value.is_finite() {
        return None;
    }
    let mut formatted = format!("{value:.2}");
    while formatted.contains('.') && formatted.ends_with('0') {
        formatted.pop();
    }
    if formatted.ends_with('.') {
        formatted.pop();
    }
    Some(formatted)
}

fn raw_text_for_import_target(
    raw_row: &Value,
    columns: &[EmployeeImportColumn],
    target: &str,
) -> Option<String> {
    let object = raw_row.as_object()?;
    columns
        .iter()
        .filter(|column| column.target.as_deref() == Some(target))
        .find_map(|column| {
            let value = object.get(&column.normalized_header)?;
            json_value_text(value)
        })
        .or_else(|| raw_text(raw_row, target_header_aliases(target)))
}

fn raw_text(raw_row: &Value, headers: &[&str]) -> Option<String> {
    let object = raw_row.as_object()?;
    headers.iter().find_map(|header| {
        let value = object.get(*header)?;
        json_value_text(value)
    })
}

fn json_value_text(value: &Value) -> Option<String> {
    let text = match value {
        Value::String(value) => value.trim().to_owned(),
        Value::Number(value) => value.to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Null | Value::Array(_) | Value::Object(_) => String::new(),
    };
    (!text.is_empty()).then_some(text)
}

fn target_header_aliases(target: &str) -> &'static [&'static str] {
    employee_import_field_for_target(target)
        .map(|field| field.aliases)
        .unwrap_or(&[])
}

fn find_or_insert_company(companies: &mut Vec<HrOrgChartCompany>, name: String) -> usize {
    if let Some(index) = companies.iter().position(|company| company.company == name) {
        return index;
    }
    companies.push(HrOrgChartCompany {
        company: name,
        total: 0,
        active: 0,
        units: vec![],
    });
    companies.len() - 1
}

fn find_or_insert_unit(units: &mut Vec<HrOrgChartUnit>, name: String) -> usize {
    if let Some(index) = units.iter().position(|unit| unit.name == name) {
        return index;
    }
    units.push(HrOrgChartUnit {
        name,
        total: 0,
        positions: vec![],
    });
    units.len() - 1
}

fn find_or_insert_position(positions: &mut Vec<HrOrgChartPosition>, title: String) -> usize {
    if let Some(index) = positions
        .iter()
        .position(|position| position.title == title)
    {
        return index;
    }
    positions.push(HrOrgChartPosition {
        title,
        total: 0,
        employees: vec![],
    });
    positions.len() - 1
}

fn push_attendance_branch_scope(builder: &mut QueryBuilder<Postgres>, scope: &BranchScope) {
    match scope {
        BranchScope::All => {
            builder.push(" TRUE ");
        }
        BranchScope::Branches(branches) if branches.is_empty() => {
            builder.push(" FALSE ");
        }
        BranchScope::Branches(branches) => {
            let ids = branches
                .iter()
                .map(|branch| *branch.as_uuid())
                .collect::<Vec<_>>();
            builder.push(" l.branch_id = ANY(");
            builder.push_bind(ids);
            builder.push(") ");
        }
    };
}

fn record_hr_read(surface: &'static str) {
    metrics::counter!("hr_core_requests_total", "surface" => surface).increment(1);
}

fn record_hr_import(inserted: usize, updated: usize) {
    metrics::counter!("hr_employee_import_rows_total", "outcome" => "inserted")
        .increment(inserted as u64);
    metrics::counter!("hr_employee_import_rows_total", "outcome" => "updated")
        .increment(updated as u64);
}

fn authorize_hr_org_wide(principal: &Principal, feature: Feature) -> Result<(), HrError> {
    authorize_org_wide(principal, Action::new(feature)).map_err(HrError::from_kernel)
}

#[derive(Debug)]
struct HrError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl HrError {
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

    fn validation(message: impl Into<String>) -> Self {
        Self::from_kernel(KernelError::validation(message.into()))
    }

    fn workbook(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            code: "workbook",
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

impl From<KernelError> for HrError {
    fn from(error: KernelError) -> Self {
        Self::from_kernel(error)
    }
}

impl From<DbError> for HrError {
    fn from(value: DbError) -> Self {
        tracing::error!(error = %value, "employee directory database operation failed");
        Self::internal("employee directory request failed")
    }
}

impl From<sqlx::Error> for HrError {
    fn from(value: sqlx::Error) -> Self {
        HrError::from(DbError::Sqlx(value))
    }
}

impl IntoResponse for HrError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({ "error": { "code": self.code, "message": self.message } })),
        )
            .into_response()
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use calamine::Range;

    #[test]
    fn parses_each_sheet_as_company_and_preserves_extra_columns() -> Result<(), String> {
        let mut range = Range::new((0, 0), (2, 2));
        range.set_value((0, 0), Data::String("성명".to_owned()));
        range.set_value((0, 1), Data::String("급여".to_owned()));
        range.set_value((0, 2), Data::String("비고".to_owned()));
        range.set_value((1, 0), Data::String("홍길동".to_owned()));
        range.set_value((1, 1), Data::Int(123));
        range.set_value((1, 2), Data::String("민감".to_owned()));
        range.set_value((2, 1), Data::String("성명 없음".to_owned()));

        let rows = parse_employee_sheet("payroll.xlsx", "A회사", &range)
            .map_err(|err| format!("expected employee sheet to parse, got {err:?}"))?;

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].company, "A회사");
        assert_eq!(rows[0].name, "홍길동");
        assert_eq!(
            rows[0].source_key,
            "filename:payroll.xlsx|sheet:A회사|row:2"
        );
        assert_eq!(rows[0].raw_row["급여"], json!(123));
        assert_eq!(rows[0].raw_row["비고"], json!("민감"));
        Ok(())
    }

    #[test]
    fn missing_name_header_is_a_workbook_error() -> Result<(), String> {
        let mut range = Range::new((0, 0), (0, 0));
        range.set_value((0, 0), Data::String("급여".to_owned()));

        let err = match parse_employee_sheet("payroll.xlsx", "A회사", &range) {
            Ok(rows) => return Err(format!("expected missing-name-header error, got {rows:?}")),
            Err(err) => err,
        };

        assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(err.code, "workbook");
        Ok(())
    }

    #[test]
    fn attendance_import_csv_parses_valid_rows_and_masks_preview_values() -> Result<(), String> {
        let csv = "\
사번,성명,지점,근무일,출근시간,퇴근시간,근무분,급여메모
E-001,=홍길동,본사,2026-07-01,09:00,18:00,540,=cmd|' /C calc'!A0
";
        let parsed = parse_attendance_import_upload("attendance.csv", csv.as_bytes())
            .map_err(|err| format!("expected attendance CSV to parse, got {err:?}"))?;

        assert_eq!(parsed.rows.len(), 1);
        assert_eq!(parsed.rows[0].row_status, ImportRowStatus::Candidate);
        assert_eq!(parsed.rows[0].employee_number.as_deref(), Some("E-001"));
        assert_eq!(parsed.rows[0].employee_name.as_deref(), Some("=홍길동"));
        assert_eq!(parsed.rows[0].branch_name.as_deref(), Some("본사"));
        assert_eq!(parsed.rows[0].minutes_worked, Some(540));
        assert_eq!(parsed.rows[0].work_date.as_deref(), Some("2026-07-01"));
        assert_eq!(parsed.rows[0].source_key, "sheet:CSV|row:2");

        let response = AttendanceImportPreviewResponse::from_rows(
            Uuid::nil(),
            "attendance.csv".to_owned(),
            "0".repeat(64),
            parsed.rows,
        );
        let values = &response.sample_rows[0].values;
        assert_eq!(values.get("성명"), Some(&json!("'=홍길동")));
        assert_eq!(values.get("급여메모"), Some(&json!("••••")));
        assert_eq!(
            response.mapping_profile["policy"]["payroll_effect"],
            json!("lineage_only_not_payable")
        );
        Ok(())
    }

    #[test]
    fn attendance_import_marks_missing_employee_and_duplicate_rows() -> Result<(), String> {
        let missing_employee_csv = "\
사번,성명,지점,근무일,출근시간
,,본사,2026-07-01,09:00
";
        let parsed =
            parse_attendance_import_upload("attendance.csv", missing_employee_csv.as_bytes())
                .map_err(|err| format!("expected row-level validation, got {err:?}"))?;

        assert_eq!(parsed.rows.len(), 1);
        assert_eq!(parsed.rows[0].row_status, ImportRowStatus::Error);
        assert!(
            parsed.rows[0]
                .validation_errors
                .contains(&"missing_employee_identifier".to_owned())
        );

        let duplicate_csv = "\
사번,성명,지점,근무일,출근시간,퇴근시간
E-001,홍길동,본사,2026-07-01,09:00,18:00
E-001,홍길동,본사,2026-07-01,09:00,18:00
";
        let duplicate = parse_attendance_import_upload("attendance.csv", duplicate_csv.as_bytes())
            .map_err(|err| format!("expected duplicate row validation, got {err:?}"))?;

        assert_eq!(duplicate.rows.len(), 2);
        assert!(
            duplicate
                .rows
                .iter()
                .all(|row| row.row_status == ImportRowStatus::Error)
        );
        assert!(duplicate.rows.iter().all(|row| {
            row.validation_errors
                .contains(&"duplicate_row_in_file".to_owned())
        }));
        Ok(())
    }

    #[test]
    fn attendance_import_rejects_invalid_work_date() -> Result<(), String> {
        let csv = "\
사번,성명,지점,근무일,출근시간
E-001,홍길동,본사,45500,09:00
";
        let parsed = parse_attendance_import_upload("attendance.csv", csv.as_bytes())
            .map_err(|err| format!("expected row-level work-date validation, got {err:?}"))?;

        assert_eq!(parsed.rows.len(), 1);
        assert_eq!(parsed.rows[0].row_status, ImportRowStatus::Error);
        assert!(
            parsed.rows[0]
                .validation_errors
                .contains(&"invalid_work_date".to_owned())
        );
        Ok(())
    }

    #[test]
    fn attendance_import_rejects_invalid_attendance_time() -> Result<(), String> {
        let csv = "\
사번,성명,지점,근무일,출근시간
E-001,홍길동,본사,2026-07-01,25:99
";
        let parsed = parse_attendance_import_upload("attendance.csv", csv.as_bytes())
            .map_err(|err| format!("expected row-level time validation, got {err:?}"))?;

        assert_eq!(parsed.rows.len(), 1);
        assert_eq!(parsed.rows[0].row_status, ImportRowStatus::Error);
        assert!(
            parsed.rows[0]
                .validation_errors
                .contains(&"invalid_check_in_at".to_owned())
        );
        Ok(())
    }
    #[sqlx::test(migrations = "../crates/platform/db/migrations")]
    async fn attendance_import_resolves_dedups_and_enforces_runtime_guards(
        pool: sqlx::PgPool,
    ) -> Result<(), String> {
        let org_id = Uuid::new_v4();
        let branch_id = Uuid::new_v4();
        let region_id = Uuid::new_v4();
        let employee_id = Uuid::new_v4();
        let run_id = Uuid::new_v4();
        let ready_row_id = Uuid::new_v4();
        let duplicate_row_id = Uuid::new_v4();
        let user_id = Uuid::new_v4();
        let mailbox_domain_id = Uuid::new_v4();
        let mailbox_id = Uuid::new_v4();
        let mailbox_alias_id = Uuid::new_v4();
        let mailbox_message_id = Uuid::new_v4();
        let mailbox_delivery_id = Uuid::new_v4();
        let source_sha256 = "a".repeat(64);

        sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)")
            .bind(org_id)
            .bind(format!("attendance-{}", &org_id.to_string()[..8]))
            .bind("Attendance Import Test")
            .execute(&pool)
            .await
            .map_err(|err| format!("seed organization failed: {err}"))?;
        sqlx::query("INSERT INTO regions (id, name, org_id) VALUES ($1, $2, $3)")
            .bind(region_id)
            .bind(format!("Attendance Region {}", &region_id.to_string()[..8]))
            .bind(org_id)
            .execute(&pool)
            .await
            .map_err(|err| format!("seed region failed: {err}"))?;
        sqlx::query("INSERT INTO branches (id, region_id, name, org_id) VALUES ($1, $2, $3, $4)")
            .bind(branch_id)
            .bind(region_id)
            .bind("본사")
            .bind(org_id)
            .execute(&pool)
            .await
            .map_err(|err| format!("seed branch failed: {err}"))?;
        sqlx::query(
            "INSERT INTO users (id, display_name, roles, is_active, org_id) VALUES ($1, $2, ARRAY['ADMIN']::TEXT[], true, $3)",
        )
        .bind(user_id)
        .bind("Mailbox Force Remove Owner")
        .bind(org_id)
        .execute(&pool)
        .await
        .map_err(|err| format!("seed mailbox owner user failed: {err}"))?;
        let mailbox_domain = format!("attendance-{}.example.test", &org_id.to_string()[..8]);
        sqlx::query(
            r#"
            INSERT INTO mailbox_domains (
                id, org_id, domain, created_by
            )
            VALUES ($1, $2, $3, $4)
            "#,
        )
        .bind(mailbox_domain_id)
        .bind(org_id)
        .bind(&mailbox_domain)
        .bind(user_id)
        .execute(&pool)
        .await
        .map_err(|err| format!("seed mailbox domain failed: {err}"))?;
        sqlx::query(
            r#"
            INSERT INTO mailboxes (
                id, org_id, domain_id, local_part, display_name, mailbox_kind, created_by
            )
            VALUES ($1, $2, $3, 'ops', 'Ops Mailbox', 'SHARED', $4)
            "#,
        )
        .bind(mailbox_id)
        .bind(org_id)
        .bind(mailbox_domain_id)
        .bind(user_id)
        .execute(&pool)
        .await
        .map_err(|err| format!("seed mailbox failed: {err}"))?;
        sqlx::query(
            r#"
            INSERT INTO mailbox_aliases (
                id, org_id, domain_id, target_mailbox_id, local_part, created_by
            )
            VALUES ($1, $2, $3, $4, 'alias', $5)
            "#,
        )
        .bind(mailbox_alias_id)
        .bind(org_id)
        .bind(mailbox_domain_id)
        .bind(mailbox_id)
        .bind(user_id)
        .execute(&pool)
        .await
        .map_err(|err| format!("seed mailbox alias failed: {err}"))?;
        sqlx::query(
            r#"
            INSERT INTO mailbox_messages (
                id, org_id, mailbox_id, domain_id, direction,
                raw_object_key, raw_size_bytes, received_at
            )
            VALUES ($1, $2, $3, $4, 'IN', 'raw-object-12345678', 0, now())
            "#,
        )
        .bind(mailbox_message_id)
        .bind(org_id)
        .bind(mailbox_id)
        .bind(mailbox_domain_id)
        .execute(&pool)
        .await
        .map_err(|err| format!("seed mailbox message failed: {err}"))?;
        sqlx::query(
            r#"
            INSERT INTO mailbox_deliveries (
                id, org_id, mailbox_message_id, direction, status,
                recipient_domain, recipient_local_part, queue_key,
                accepted_at, completed_at
            )
            VALUES ($1, $2, $3, 'IN', 'STORED', $4, 'ops', $5, now(), now())
            "#,
        )
        .bind(mailbox_delivery_id)
        .bind(org_id)
        .bind(mailbox_message_id)
        .bind(&mailbox_domain)
        .bind(format!("queue-{}", mailbox_delivery_id))
        .execute(&pool)
        .await
        .map_err(|err| format!("seed mailbox delivery failed: {err}"))?;
        sqlx::query(
            r#"
            INSERT INTO employees (
                id, org_id, company, name, employee_number, source_filename,
                source_sheet, source_row, source_key, raw_row, source_metadata
            )
            VALUES ($1, $2, '테스트', '홍길동', NULL, 'employees.xlsx', '직원', 2, 'employee-row-2', '{}', '{}')
            "#,
        )
        .bind(employee_id)
        .bind(org_id)
        .execute(&pool)
        .await
        .map_err(|err| format!("seed employee failed: {err}"))?;
        sqlx::query(
            r#"
            INSERT INTO employee_lifecycle_events (
                org_id, employee_id, event_type, to_status, effective_date, comment, created_by
            )
            VALUES ($1, $2, 'ONBOARD', 'ACTIVE', '2026-07-01', 'force-remove test lifecycle event', $3)
            "#,
        )
        .bind(org_id)
        .bind(employee_id)
        .bind(user_id)
        .execute(&pool)
        .await
        .map_err(|err| format!("seed lifecycle event failed: {err}"))?;
        sqlx::query(
            r#"
            INSERT INTO data_import_runs (
                id, org_id, entity_type, status, source_filename, source_format,
                source_sha256, mapping_profile, input_rows, candidate_rows, preserved_rows
            )
            VALUES ($1, $2, 'attendance_direct', 'DRY_RUN', 'attendance.csv', 'csv', $3, '{}', 2, 2, 0)
            "#,
        )
        .bind(run_id)
        .bind(org_id)
        .bind(&source_sha256)
        .execute(&pool)
        .await
        .map_err(|err| format!("seed import run failed: {err}"))?;

        let ready_canonical = json!({
            "source_sheet": "CSV",
            "source_row": 2,
            "source_key": "sheet:CSV|row:2",
            "source_sha256": source_sha256,
            "canonical": {
                "employee_number": null,
                "employee_name": "홍길동",
                "branch_name": "본사",
                "work_date": "2026-07-01",
                "check_in_at": "09:00",
                "check_out_at": "18:00",
                "minutes_worked": 540
            }
        });
        let duplicate_canonical = json!({
            "source_sheet": "CSV",
            "source_row": 3,
            "source_key": "sheet:CSV|row:3",
            "source_sha256": source_sha256,
            "canonical": {
                "employee_number": null,
                "employee_name": "홍길동",
                "branch_name": "본사",
                "work_date": "2026-07-02",
                "check_in_at": "09:00",
                "check_out_at": "18:00",
                "minutes_worked": 540
            }
        });
        for (row_id, source_row, source_key, canonical) in [
            (ready_row_id, 2, "sheet:CSV|row:2", ready_canonical),
            (duplicate_row_id, 3, "sheet:CSV|row:3", duplicate_canonical),
        ] {
            sqlx::query(
                r#"
                INSERT INTO data_import_rows (
                    id, org_id, run_id, source_sheet, source_row, source_key,
                    row_status, raw_row, canonical_row, validation
                )
                VALUES ($1, $2, $3, 'CSV', $4, $5, 'CANDIDATE', '{}', $6, '{"status":"ok","errors":[],"warnings":[]}')
                "#,
            )
            .bind(row_id)
            .bind(org_id)
            .bind(run_id)
            .bind(source_row)
            .bind(source_key)
            .bind(canonical)
            .execute(&pool)
            .await
            .map_err(|err| format!("seed import row {source_key} failed: {err}"))?;
        }
        let existing_fact_key = attendance_fact_key(
            employee_id,
            branch_id,
            "2026-07-02",
            Some("09:00"),
            Some("18:00"),
            Some(540),
        );
        sqlx::query(
            r#"
            INSERT INTO attendance_direct_import_events (
                org_id, run_id, import_row_id, employee_id, branch_id,
                source_sheet, source_row, source_key, source_sha256, fact_key,
                employee_number, employee_name, branch_name, work_date,
                check_in_at, check_out_at, minutes_worked
            )
            VALUES ($1, $2, $3, $4, $5, 'CSV', 99, 'sheet:CSV|row:99', $6, $7,
                    NULL, '홍길동', '본사', '2026-07-02', '09:00', '18:00', 540)
            "#,
        )
        .bind(org_id)
        .bind(run_id)
        .bind(duplicate_row_id)
        .bind(employee_id)
        .bind(branch_id)
        .bind(&source_sha256)
        .bind(&existing_fact_key)
        .execute(&pool)
        .await
        .map_err(|err| format!("seed existing attendance event failed: {err}"))?;

        let mut tx = pool
            .begin()
            .await
            .map_err(|err| format!("begin dry-run transaction failed: {err}"))?;
        let run = import_run_for_update(&mut tx, org_id, run_id)
            .await
            .map_err(|err| format!("load import run failed: {err:?}"))?;
        ensure_attendance_import_run(&run, &["DRY_RUN"])
            .map_err(|err| format!("status gate failed: {err:?}"))?;
        let rows = load_attendance_import_rows(&mut tx, org_id, run_id)
            .await
            .map_err(|err| format!("load import rows failed: {err:?}"))?;
        let summary = resolve_attendance_import_rows(&mut tx, org_id, run_id, &run, &rows)
            .await
            .map_err(|err| format!("resolve import rows failed: {err:?}"))?;
        tx.rollback()
            .await
            .map_err(|err| format!("rollback dry-run transaction failed: {err}"))?;

        assert_eq!(summary.ready_rows, 1);
        assert_eq!(summary.duplicate_rows, 1);
        assert_eq!(summary.error_rows, 1);
        assert_eq!(summary.ready_rows_for_apply[0].employee_id, employee_id);
        assert_eq!(summary.ready_rows_for_apply[0].employee_number, None);
        assert!(
            summary
                .row_errors
                .iter()
                .any(|error| error.code == "duplicate_attendance_fact")
        );

        let update_result = sqlx::query(
            "UPDATE attendance_direct_import_events SET employee_name = '위조' WHERE org_id = $1 AND run_id = $2",
        )
        .bind(org_id)
        .bind(run_id)
        .execute(&pool)
        .await;
        assert!(
            update_result.is_err(),
            "append-only attendance import events must reject UPDATE"
        );

        let mut rls_tx = pool
            .begin()
            .await
            .map_err(|err| format!("begin rls transaction failed: {err}"))?;
        sqlx::query("SET LOCAL ROLE mnt_rt")
            .execute(rls_tx.as_mut())
            .await
            .map_err(|err| format!("set runtime role failed: {err}"))?;
        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(org_id.to_string())
            .execute(rls_tx.as_mut())
            .await
            .map_err(|err| format!("set current org failed: {err}"))?;
        let visible_rows: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM attendance_direct_import_events")
                .fetch_one(rls_tx.as_mut())
                .await
                .map_err(|err| format!("runtime select failed: {err}"))?;
        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(Uuid::new_v4().to_string())
            .execute(rls_tx.as_mut())
            .await
            .map_err(|err| format!("set other org failed: {err}"))?;
        let hidden_rows: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM attendance_direct_import_events")
                .fetch_one(rls_tx.as_mut())
                .await
                .map_err(|err| format!("runtime isolation select failed: {err}"))?;
        rls_tx
            .rollback()
            .await
            .map_err(|err| format!("rollback rls transaction failed: {err}"))?;

        assert_eq!(visible_rows, 1);
        assert_eq!(hidden_rows, 0);
        sqlx::query("UPDATE organizations SET status = 'ARCHIVED' WHERE id = $1")
            .bind(org_id)
            .execute(&pool)
            .await
            .map_err(|err| format!("archive organization failed: {err}"))?;
        let force_remove_result: String =
            sqlx::query_scalar("SELECT platform_force_remove_organization($1)")
                .bind(org_id)
                .fetch_one(&pool)
                .await
                .map_err(|err| format!("force-remove organization failed: {err}"))?;
        assert_eq!(force_remove_result, "removed");
        let remaining_import_rows: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM data_import_rows WHERE org_id = $1")
                .bind(org_id)
                .fetch_one(&pool)
                .await
                .map_err(|err| format!("count remaining import rows failed: {err}"))?;
        let remaining_events: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM attendance_direct_import_events WHERE org_id = $1",
        )
        .bind(org_id)
        .fetch_one(&pool)
        .await
        .map_err(|err| format!("count remaining attendance events failed: {err}"))?;
        let remaining_mailbox_rows: i64 = sqlx::query_scalar(
            r#"
            SELECT
                (SELECT COUNT(*) FROM mailbox_deliveries WHERE org_id = $1)
              + (SELECT COUNT(*) FROM mailbox_messages WHERE org_id = $1)
              + (SELECT COUNT(*) FROM mailbox_aliases WHERE org_id = $1)
              + (SELECT COUNT(*) FROM mailboxes WHERE org_id = $1)
              + (SELECT COUNT(*) FROM mailbox_domains WHERE org_id = $1)
            "#,
        )
        .bind(org_id)
        .fetch_one(&pool)
        .await
        .map_err(|err| format!("count remaining mailbox rows failed: {err}"))?;
        let remaining_lifecycle_events: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM employee_lifecycle_events WHERE org_id = $1")
                .bind(org_id)
                .fetch_one(&pool)
                .await
                .map_err(|err| format!("count remaining lifecycle events failed: {err}"))?;
        assert_eq!(remaining_import_rows, 0);
        assert_eq!(remaining_events, 0);
        assert_eq!(remaining_mailbox_rows, 0);
        assert_eq!(remaining_lifecycle_events, 0);
        Ok(())
    }

    #[test]
    fn attendance_import_keeps_invalid_minutes_as_row_error() -> Result<(), String> {
        let csv = "\
사번,성명,지점,근무일,근무분
E-001,홍길동,본사,2026-07-01,abc
";
        let parsed = parse_attendance_import_upload("attendance.csv", csv.as_bytes())
            .map_err(|err| format!("expected row-level minutes validation, got {err:?}"))?;

        assert_eq!(parsed.rows.len(), 1);
        assert_eq!(parsed.rows[0].row_status, ImportRowStatus::Error);
        assert!(
            parsed.rows[0]
                .validation_errors
                .contains(&"invalid_minutes_worked".to_owned())
        );
        Ok(())
    }

    #[test]
    fn attendance_import_rejects_unclosed_csv_quote() -> Result<(), String> {
        let err = match parse_csv_rows("\"unterminated") {
            Ok(rows) => return Err(format!("unclosed quote unexpectedly parsed as {rows:?}")),
            Err(err) => err,
        };
        assert_eq!(err.code, "workbook");
        Ok(())
    }

    #[test]
    fn governed_import_detects_schema_header_below_title_rows() -> Result<(), String> {
        let mut range = Range::new((0, 0), (2, 2));
        range.set_value((0, 0), Data::String("2026년 임직원 명부".to_owned()));
        range.set_value((1, 0), Data::String("직원번호".to_owned()));
        range.set_value((1, 1), Data::String("이름".to_owned()));
        range.set_value((1, 2), Data::String("법인".to_owned()));
        range.set_value((2, 0), Data::String("ALT-010".to_owned()));
        range.set_value((2, 1), Data::String("김표준".to_owned()));
        range.set_value((2, 2), Data::String("운영법인".to_owned()));

        let parsed = parse_employee_import_sheet("employees.xlsx", "원천", &range)
            .map_err(|err| format!("expected governed import sheet to parse, got {err:?}"))?;

        assert_eq!(parsed.rows.len(), 1);
        assert_eq!(parsed.rows[0].source_row, 3);
        assert_eq!(parsed.rows[0].company, "운영법인");
        assert_eq!(parsed.rows[0].source_metadata["header_row"], json!(2));
        assert_eq!(
            parsed.rows[0].source_metadata["company_source"],
            json!("mapped_column")
        );
        assert!(
            parsed
                .columns
                .iter()
                .any(|column| column.source_header == "직원번호"
                    && column.target.as_deref() == Some("employee_number")),
            "schema catalog must map moved/shuffled employee number columns",
        );
        Ok(())
    }

    #[test]
    fn canonical_employee_fields_extract_hr_safe_columns() {
        let raw = json!({
            "사번": "A-001",
            "부서명": "물류팀",
            "업무": "정비",
            "직책": "대리",
            "근무지": "인천센터",
            "근무지(주소)": "인천광역시",
            "입사일": "2024-01-02",
            "발생연차": "15.00",
            "사용연차": "7.50",
            "잔여연차": "7.50"
        });

        let canonical = canonical_employee_fields(&raw);

        assert_eq!(canonical.employee_number.as_deref(), Some("A-001"));
        assert_eq!(canonical.org_unit.as_deref(), Some("물류팀"));
        assert_eq!(canonical.position.as_deref(), Some("대리"));
        assert_eq!(canonical.worksite_name.as_deref(), Some("인천센터"));
        assert_eq!(canonical.employment_status, "ACTIVE");
        assert_eq!(canonical.leave_accrued.as_deref(), Some("15"));
        assert_eq!(canonical.leave_used.as_deref(), Some("7.5"));
        assert_eq!(canonical.leave_remaining.as_deref(), Some("7.5"));
    }

    #[test]
    fn canonical_employee_fields_marks_exited_people_without_deleting_raw_data() {
        let raw = json!({
            "성명": "이퇴사",
            "퇴사일": "2026-01-31",
            "퇴직금 중간정산일": "2025-12-31"
        });

        let canonical = canonical_employee_fields(&raw);

        assert_eq!(canonical.exit_date.as_deref(), Some("2026-01-31"));
        assert_eq!(canonical.employment_status, "EXITED");
        assert_eq!(raw["퇴직금 중간정산일"], json!("2025-12-31"));
    }

    #[test]
    fn governed_import_preview_preserves_blank_name_rows_and_masks_sensitive_columns()
    -> Result<(), String> {
        let mut range = Range::new((0, 0), (2, 4));
        range.set_value((0, 0), Data::String("성명".to_owned()));
        range.set_value((0, 1), Data::String("근무지\n(주소)".to_owned()));
        range.set_value((0, 2), Data::String("계좌번호".to_owned()));
        range.set_value((0, 3), Data::String("퇴직금 중간정산일".to_owned()));
        range.set_value((0, 4), Data::String("메모".to_owned()));
        range.set_value((1, 0), Data::String("홍길동".to_owned()));
        range.set_value((1, 1), Data::String("서울".to_owned()));
        range.set_value((1, 2), Data::String("123-456".to_owned()));
        range.set_value((1, 3), Data::String("2025-12-31".to_owned()));
        range.set_value((1, 4), Data::String("현장 배치".to_owned()));
        range.set_value((2, 2), Data::String("빈 이름 원천 행".to_owned()));

        let parsed = parse_employee_import_sheet("employees.xlsx", "코스", &range)
            .map_err(|err| format!("expected governed import sheet to parse, got {err:?}"))?;

        assert_eq!(parsed.rows.len(), 2);
        assert_eq!(parsed.rows[0].row_status, ImportRowStatus::Candidate);
        assert_eq!(parsed.rows[1].row_status, ImportRowStatus::Preserved);
        assert_eq!(parsed.rows[0].raw_row["근무지(주소)"], json!("서울"));
        assert_eq!(parsed.rows[1].raw_row["계좌번호"], json!("빈 이름 원천 행"));

        let preview = masked_preview_values(&parsed.rows[0].raw_row, &parsed.columns);
        assert_eq!(preview["근무지(주소)"], json!("••••"));
        assert_eq!(preview["계좌번호"], json!("••••"));
        assert_eq!(preview["퇴직금중간정산일"], json!("••••"));
        assert_eq!(preview["메모"], json!("현장 배치"));
        Ok(())
    }

    #[test]
    fn governed_import_maps_shuffled_alias_headers_without_column_position_assumptions()
    -> Result<(), String> {
        let mut range = Range::new((0, 0), (2, 5));
        range.set_value((0, 0), Data::String("메모".to_owned()));
        range.set_value((0, 1), Data::String("직원번호".to_owned()));
        range.set_value((0, 2), Data::String("남은 연차".to_owned()));
        range.set_value((0, 3), Data::String("근무지 주소".to_owned()));
        range.set_value((0, 4), Data::String("이름".to_owned()));
        range.set_value((0, 5), Data::String("계열사".to_owned()));
        range.set_value((1, 0), Data::String("현장 배치".to_owned()));
        range.set_value((1, 1), Data::String("ALT-001".to_owned()));
        range.set_value((1, 2), Data::Float(7.5));
        range.set_value((1, 3), Data::String("서울".to_owned()));
        range.set_value((1, 4), Data::String("홍길동".to_owned()));
        range.set_value((1, 5), Data::String("코스".to_owned()));
        range.set_value((2, 0), Data::String("raw-only keep".to_owned()));

        let parsed = parse_employee_import_sheet("employees.xlsx", "원천시트", &range)
            .map_err(|err| format!("expected alias import sheet to parse, got {err:?}"))?;

        assert_eq!(parsed.rows.len(), 2);
        assert_eq!(parsed.rows[0].row_status, ImportRowStatus::Candidate);
        assert_eq!(parsed.rows[1].row_status, ImportRowStatus::Preserved);
        assert_eq!(parsed.rows[0].company, "코스");
        assert_eq!(parsed.rows[0].name.as_deref(), Some("홍길동"));
        let canonical = parsed.rows[0]
            .canonical
            .as_ref()
            .ok_or_else(|| "candidate row missing canonical fields".to_owned())?;
        assert_eq!(canonical.employee_number.as_deref(), Some("ALT-001"));
        assert_eq!(canonical.leave_remaining.as_deref(), Some("7.5"));
        assert_eq!(canonical.worksite_address.as_deref(), Some("서울"));

        let preview = masked_preview_values(&parsed.rows[0].raw_row, &parsed.columns);
        assert_eq!(preview["근무지주소"], json!("••••"));
        assert_eq!(preview["남은연차"], json!(7.5));
        assert_eq!(preview["메모"], json!("현장 배치"));
        assert!(
            parsed
                .columns
                .iter()
                .any(|column| column.source_header == "직원번호"
                    && column.target.as_deref() == Some("employee_number")),
            "직원번호 must map to the canonical employee_number target",
        );
        assert!(
            parsed
                .columns
                .iter()
                .any(|column| column.source_header == "이름"
                    && column.target.as_deref() == Some("name")),
            "이름 must map to the canonical name target",
        );
        Ok(())
    }

    #[test]
    fn standardized_csv_neutralizes_spreadsheet_formulas() {
        assert_eq!(csv_field("=cmd|' /C calc'!A0"), "'=cmd|' /C calc'!A0");
        assert_eq!(csv_field("hello, world"), "\"hello, world\"");
    }

    #[test]
    fn employee_response_serializes_canonical_fields_without_import_provenance()
    -> Result<(), String> {
        let body = serde_json::to_value(EmployeeResponse {
            id: Uuid::nil(),
            company: "코스".to_owned(),
            name: "홍길동".to_owned(),
            employee_number: Some("A-001".to_owned()),
            org_unit: Some("물류팀".to_owned()),
            worksite_name: None,
            worksite: None,
            job: None,
            position: Some("대리".to_owned()),
            hire_date: Some("2024-01-02".to_owned()),
            exit_date: None,
            status: Some("ACTIVE".to_owned()),
            leave_accrued: None,
            leave_used: None,
            leave_remaining: None,
            identity_resolution_strategy: "employee_number".to_owned(),
            identity_resolution_confidence: "high".to_owned(),
            identity_review_required: false,
            identity_name_only_merge: false,
            created_at: time::OffsetDateTime::UNIX_EPOCH,
            updated_at: time::OffsetDateTime::UNIX_EPOCH,
        })
        .map_err(|err| format!("employee response serialization failed: {err}"))?;

        for forbidden in [
            "raw_row",
            "source_metadata",
            "source_filename",
            "source_sheet",
            "source_row",
        ] {
            assert!(
                body.get(forbidden).is_none(),
                "public employee response must not expose {forbidden}",
            );
        }
        assert_eq!(
            body["identity_resolution_strategy"],
            json!("employee_number")
        );
        assert_eq!(body["identity_resolution_confidence"], json!("high"));
        assert_eq!(body["identity_review_required"], json!(false));
        assert_eq!(body["identity_name_only_merge"], json!(false));
        Ok(())
    }

    #[test]
    fn employee_identity_resolution_rejects_name_only_and_untrusted_confidence() {
        let metadata = json!({
            "identity_resolution": {
                "strategy": "source_row_fingerprint",
                "confidence": "high",
                "manual_review_required": true,
                "name_only_merge": true
            }
        });

        let identity = employee_identity_resolution_from_metadata(&metadata);

        assert_eq!(identity.strategy, "source_row_fingerprint");
        assert_eq!(identity.confidence, "low");
        assert!(identity.review_required);
        assert!(!identity.name_only_merge);
    }

    #[test]
    fn employee_identity_resolution_accepts_high_confidence_trusted_strategies() {
        let metadata = json!({
            "identity_resolution": {
                "strategy": "legal_identifier_hash",
                "manual_review_required": false
            }
        });

        let identity = employee_identity_resolution_from_metadata(&metadata);

        assert_eq!(identity.strategy, "legal_identifier_hash");
        assert_eq!(identity.confidence, "high");
        assert!(!identity.review_required);
        assert!(!identity.name_only_merge);
    }

    #[test]
    fn employee_identity_resolution_keeps_weak_strategies_review_required() {
        let metadata = json!({
            "identity_resolution": {
                "strategy": "birth_hire_fingerprint",
                "manual_review_required": false
            }
        });

        let identity = employee_identity_resolution_from_metadata(&metadata);

        assert_eq!(identity.strategy, "birth_hire_fingerprint");
        assert_eq!(identity.confidence, "medium");
        assert!(identity.review_required);
        assert!(!identity.name_only_merge);
    }

    #[test]
    fn org_wide_hr_authorization_rejects_branch_scoped_principals() -> Result<(), String> {
        use mnt_kernel_core::{BranchId, OrgId, UserId};
        use mnt_platform_authz::Role;
        use std::collections::BTreeSet;

        let principal = Principal::new(
            UserId::new(),
            OrgId::new(),
            BTreeSet::from([Role::Admin]),
            BranchScope::single(BranchId::new()),
        );

        let err = match authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryRead) {
            Ok(()) => {
                return Err(
                    "branch-scoped HR read authorized an org-wide employee surface".to_owned(),
                );
            }
            Err(err) => err,
        };
        assert_eq!(err.status, StatusCode::FORBIDDEN);
        Ok(())
    }

    #[test]
    fn org_wide_hr_authorization_uses_core_org_wide_gate() -> Result<(), String> {
        use mnt_kernel_core::{OrgId, UserId};
        use mnt_platform_authz::Role;
        use std::collections::BTreeSet;

        let admin = Principal::new(
            UserId::new(),
            OrgId::new(),
            BTreeSet::from([Role::Admin]),
            BranchScope::All,
        );

        let admin_err = match authorize_hr_org_wide(&admin, Feature::EmployeeDirectoryRead) {
            Ok(()) => {
                return Err(
                    "synthetic all-branch ADMIN authorized an org-wide employee surface".to_owned(),
                );
            }
            Err(err) => err,
        };
        assert_eq!(admin_err.status, StatusCode::FORBIDDEN);

        let executive = Principal::new(
            UserId::new(),
            OrgId::new(),
            BTreeSet::from([Role::Executive]),
            BranchScope::All,
        );

        authorize_hr_org_wide(&executive, Feature::EmployeeDirectoryRead)
            .map_err(|err| format!("org-wide executive HR read was rejected: {}", err.message))?;
        Ok(())
    }
    #[test]
    fn employee_attendance_state_machine_accepts_mobile_pc_workday_flow() -> Result<(), String> {
        assert_eq!(
            next_employee_attendance_state(None, "CLOCK_IN").map_err(|err| err.message.clone())?,
            "CLOCKED_IN"
        );
        assert_eq!(
            next_employee_attendance_state(Some("CLOCKED_IN"), "OUT_FOR_WORK")
                .map_err(|err| err.message.clone())?,
            "OUT_FOR_WORK"
        );
        assert_eq!(
            next_employee_attendance_state(Some("OUT_FOR_WORK"), "RETURNED")
                .map_err(|err| err.message.clone())?,
            "CLOCKED_IN"
        );
        assert_eq!(
            next_employee_attendance_state(Some("CLOCKED_IN"), "BUSINESS_TRIP")
                .map_err(|err| err.message.clone())?,
            "BUSINESS_TRIP"
        );
        assert_eq!(
            next_employee_attendance_state(Some("BUSINESS_TRIP"), "CLOCK_OUT")
                .map_err(|err| err.message.clone())?,
            "OFF_DUTY"
        );
        Ok(())
    }

    #[test]
    fn employee_attendance_state_machine_rejects_invalid_duplicate_punches() -> Result<(), String> {
        let err = match next_employee_attendance_state(None, "CLOCK_OUT") {
            Ok(state) => return Err(format!("clock-out before clock-in returned {state}")),
            Err(err) => err,
        };
        assert_eq!(err.status, StatusCode::CONFLICT);
        assert_eq!(err.code, "invalid_transition");

        let err = match next_employee_attendance_state(Some("CLOCKED_IN"), "CLOCK_IN") {
            Ok(state) => return Err(format!("duplicate clock-in returned {state}")),
            Err(err) => err,
        };
        assert_eq!(err.status, StatusCode::CONFLICT);
        assert_eq!(err.code, "invalid_transition");
        Ok(())
    }

    #[test]
    fn attendance_input_normalization_bounds_mobile_retry_fields() {
        let kind = normalize_attendance_kind(" business_trip ")
            .map_err(|err| err.message)
            .unwrap_or("invalid");
        assert_eq!(kind, "BUSINESS_TRIP");

        let idempotency_key = normalize_idempotency_key(Some(" retry-1 ".to_owned()))
            .map_err(|err| err.message)
            .unwrap_or_default();
        assert_eq!(idempotency_key.as_deref(), Some("retry-1"));
        assert!(
            normalize_attendance_note(Some("x".repeat(501))).is_err(),
            "long attendance notes must be rejected before persistence"
        );
    }
}
