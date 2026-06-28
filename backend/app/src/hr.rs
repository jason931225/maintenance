use std::collections::BTreeMap;
use std::io::Cursor;

use axum::extract::{DefaultBodyLimit, Multipart, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use calamine::{Data, DataType, Reader, Xlsx};
use mnt_kernel_core::{BranchScope, ErrorKind, KernelError};
use mnt_platform_auth::JwtVerifier;
use mnt_platform_authz::{Action, Feature, Principal, authorize, authorize_org_wide};
use mnt_platform_db::{DbError, with_org_conn};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sqlx::{PgPool, Postgres, QueryBuilder, Row};
use uuid::Uuid;

pub const EMPLOYEES_PATH: &str = "/api/v1/employees";
pub const EMPLOYEES_IMPORT_PATH: &str = "/api/v1/employees/import";
pub const HR_ORG_CHART_PATH: &str = "/api/v1/hr/org-chart";
pub const HR_LEAVE_BALANCES_PATH: &str = "/api/v1/hr/leave-balances";
pub const HR_ATTENDANCE_SUMMARY_PATH: &str = "/api/v1/hr/attendance-summary";
const MAX_IMPORT_BYTES: usize = 16 * 1024 * 1024;
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
                "SELECT id, company, name, employee_number, org_unit, job, position, worksite_name, worksite_address, hire_date, exit_date, employment_status, leave_accrued::TEXT AS leave_accrued, leave_used::TEXT AS leave_used, leave_remaining::TEXT AS leave_remaining, created_at, updated_at FROM employees WHERE TRUE",
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
        Box::pin(async move {
            let mut report = EmployeeImportReport::default();
            let mut by_company = BTreeMap::<String, CompanyImportSummary>::new();
            for row in parsed.rows {
                let company_entry =
                    by_company
                        .entry(row.company.clone())
                        .or_insert_with(|| CompanyImportSummary {
                            company: row.company.clone(),
                            ..CompanyImportSummary::default()
                        });
                company_entry.input_rows += 1;
                report.input_rows += 1;

                let outcome: String = sqlx::query_scalar(
                    r#"
                    INSERT INTO employees (
                        org_id, company, name, source_filename, source_sheet, source_row,
                        source_key, raw_row, source_metadata, employee_number, org_unit, job,
                        position, worksite_name, worksite_address, hire_date, exit_date,
                        employment_status, leave_accrued, leave_used, leave_remaining
                    )
                    VALUES (
                        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                        $14, $15, $16, $17, $18, NULLIF($19::TEXT, '')::NUMERIC,
                        NULLIF($20::TEXT, '')::NUMERIC, NULLIF($21::TEXT, '')::NUMERIC
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
        })
    })
    .await?;

    record_hr_import(report.inserted, report.updated);
    Ok(Json(report))
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

#[derive(Debug)]
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

#[derive(Debug, Default)]
struct EmployeeCanonicalFields {
    employee_number: Option<String>,
    org_unit: Option<String>,
    job: Option<String>,
    position: Option<String>,
    worksite_name: Option<String>,
    worksite_address: Option<String>,
    hire_date: Option<String>,
    exit_date: Option<String>,
    employment_status: String,
    leave_accrued: Option<String>,
    leave_used: Option<String>,
    leave_remaining: Option<String>,
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
    let Some(headers) = range.rows().next() else {
        return Ok(Vec::new());
    };
    let headers = headers.iter().map(cell_text).collect::<Vec<_>>();
    let name_index = headers
        .iter()
        .position(|header| header == "성명")
        .ok_or_else(|| HrError::workbook(format!("sheet {sheet} is missing 성명 header")))?;

    let mut parsed = Vec::new();
    for (zero_based_idx, row) in range.rows().enumerate().skip(1) {
        let Some(name) = row
            .get(name_index)
            .map(cell_text)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let source_row = i32::try_from(zero_based_idx + 1)
            .map_err(|_| HrError::workbook("source row does not fit i32"))?;
        let mut raw = Map::new();
        for (idx, header) in headers.iter().enumerate() {
            if header.is_empty() {
                continue;
            }
            let value = row.get(idx).map(cell_json).unwrap_or(Value::Null);
            raw.insert(header.clone(), value);
        }
        let source_key = format!("filename:{filename}|sheet:{sheet}|row:{source_row}");
        let raw_row = Value::Object(raw);
        let canonical = canonical_employee_fields(&raw_row);
        parsed.push(ParsedEmployeeRow {
            company: sheet.to_owned(),
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
                "source_key_kind": "filename_sheet_row"
            }),
            canonical,
        });
    }
    Ok(parsed)
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
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn canonical_employee_fields(raw_row: &Value) -> EmployeeCanonicalFields {
    let exit_date = raw_text(raw_row, &["퇴사일", "보험상실일"]);
    EmployeeCanonicalFields {
        employee_number: raw_text(raw_row, &["사번"]),
        org_unit: raw_text(raw_row, &["부서명", "소속"]),
        job: raw_text(raw_row, &["업무"]),
        position: raw_text(raw_row, &["직책", "직위"]),
        worksite_name: raw_text(raw_row, &["근무지"]),
        worksite_address: raw_text(raw_row, &["근무지(주소)"]),
        hire_date: raw_text(raw_row, &["입사일", "보험가입일"]),
        exit_date: exit_date.clone(),
        employment_status: if exit_date.is_some() {
            "EXITED"
        } else {
            "ACTIVE"
        }
        .to_owned(),
        leave_accrued: raw_decimal_text(raw_row, &["발생연차"]),
        leave_used: raw_decimal_text(raw_row, &["사용연차"]),
        leave_remaining: raw_decimal_text(raw_row, &["잔여연차"]),
    }
}

fn raw_decimal_text(raw_row: &Value, headers: &[&str]) -> Option<String> {
    let raw = raw_text(raw_row, headers)?;
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

fn raw_text(raw_row: &Value, headers: &[&str]) -> Option<String> {
    let object = raw_row.as_object()?;
    headers.iter().find_map(|header| {
        let value = object.get(*header)?;
        let text = match value {
            Value::String(value) => value.trim().to_owned(),
            Value::Number(value) => value.to_string(),
            Value::Bool(value) => value.to_string(),
            Value::Null | Value::Array(_) | Value::Object(_) => String::new(),
        };
        (!text.is_empty()).then_some(text)
    })
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
        range.set_value((0, 0), Data::String("이름".to_owned()));

        let err = match parse_employee_sheet("payroll.xlsx", "A회사", &range) {
            Ok(rows) => return Err(format!("expected missing-name-header error, got {rows:?}")),
            Err(err) => err,
        };

        assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(err.code, "workbook");
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
        Ok(())
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
