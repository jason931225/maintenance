use std::collections::BTreeMap;
use std::io::Cursor;

use axum::extract::{DefaultBodyLimit, Multipart, Path, Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use calamine::{Data, DataType, Reader, Xlsx};
use mnt_kernel_core::{AuditAction, AuditEvent, BranchScope, ErrorKind, KernelError, TraceContext};
use mnt_platform_auth::JwtVerifier;
use mnt_platform_authz::{Action, Feature, Principal, authorize, authorize_org_wide};
use mnt_platform_db::{DbError, with_audit, with_org_conn};
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
    authorize_org_feature(&principal, Feature::EmployeeDirectoryRead)?;
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

#[derive(Debug)]
struct DataImportRunRecord {
    entity_type: String,
    status: String,
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
}

impl ImportRowStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Candidate => "CANDIDATE",
            Self::Preserved => "PRESERVED",
        }
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
            json!(format!("{}…", value.chars().take(80).collect::<String>()))
        }
        Value::String(_) | Value::Number(_) | Value::Bool(_) | Value::Null => value.clone(),
        Value::Array(_) | Value::Object(_) => json!("복합 값"),
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
        SELECT entity_type, status, input_rows, candidate_rows, preserved_rows
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

fn authorize_org_feature(principal: &Principal, feature: Feature) -> Result<(), HrError> {
    let representative = match &principal.branch_scope {
        mnt_kernel_core::BranchScope::All => mnt_kernel_core::BranchId::new(),
        mnt_kernel_core::BranchScope::Branches(branches) => {
            branches.iter().next().copied().ok_or_else(|| {
                HrError::from_kernel(KernelError::forbidden("principal has no branch scope"))
            })?
        }
    };
    authorize(principal, Action::new(feature), representative).map_err(HrError::from_kernel)
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
    fn org_wide_hr_authorization_allows_org_wide_admins() -> Result<(), String> {
        use mnt_kernel_core::{OrgId, UserId};
        use mnt_platform_authz::Role;
        use std::collections::BTreeSet;

        let principal = Principal::new(
            UserId::new(),
            OrgId::new(),
            BTreeSet::from([Role::Admin]),
            BranchScope::All,
        );

        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryRead)
            .map_err(|err| format!("org-wide admin HR read was rejected: {}", err.message))?;
        Ok(())
    }
}
