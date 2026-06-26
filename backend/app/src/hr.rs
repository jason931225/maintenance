use std::collections::BTreeMap;
use std::io::Cursor;

use axum::extract::{DefaultBodyLimit, Multipart, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use calamine::{Data, DataType, Reader, Xlsx};
use mnt_kernel_core::{ErrorKind, KernelError};
use mnt_platform_auth::JwtVerifier;
use mnt_platform_authz::{Action, Feature, Principal, authorize};
use mnt_platform_db::{DbError, with_org_conn};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sqlx::{PgPool, Postgres, QueryBuilder, Row};
use uuid::Uuid;

pub const EMPLOYEES_PATH: &str = "/api/v1/employees";
pub const EMPLOYEES_IMPORT_PATH: &str = "/api/v1/employees/import";
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
    source_filename: String,
    source_sheet: String,
    source_row: i32,
    raw_row: Value,
    source_metadata: Value,
    created_at: time::OffsetDateTime,
    updated_at: time::OffsetDateTime,
}

async fn list_employees(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<EmployeeListQuery>,
) -> Result<Json<EmployeePage>, HrError> {
    authorize_org_feature(&principal, Feature::EmployeeDirectoryRead)?;
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
                "SELECT id, company, name, source_filename, source_sheet, source_row, raw_row, source_metadata, created_at, updated_at FROM employees WHERE TRUE",
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

async fn import_employees(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    multipart: Multipart,
) -> Result<Json<EmployeeImportReport>, HrError> {
    authorize_org_feature(&principal, Feature::EmployeeDirectoryManage)?;
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
                        source_key, raw_row, source_metadata
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    ON CONFLICT (org_id, source_key) DO UPDATE SET
                        company = EXCLUDED.company,
                        name = EXCLUDED.name,
                        source_filename = EXCLUDED.source_filename,
                        source_sheet = EXCLUDED.source_sheet,
                        source_row = EXCLUDED.source_row,
                        raw_row = EXCLUDED.raw_row,
                        source_metadata = EXCLUDED.source_metadata,
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
        parsed.push(ParsedEmployeeRow {
            company: sheet.to_owned(),
            name,
            source_filename: filename.to_owned(),
            source_sheet: sheet.to_owned(),
            source_row,
            source_key,
            raw_row: Value::Object(raw),
            source_metadata: json!({
                "filename": filename,
                "sheet": sheet,
                "row": source_row,
                "source_key_kind": "filename_sheet_row"
            }),
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
    let raw_row: Value = row.try_get("raw_row")?;
    let worksite_name = raw_text(&raw_row, &["근무지"]);
    let worksite = raw_text(&raw_row, &["근무지(주소)", "근무지"]);
    let job = raw_text(&raw_row, &["업무"]);
    let position = raw_text(&raw_row, &["직책"]);
    let hire_date = raw_text(&raw_row, &["입사일"]);
    let exit_date = raw_text(&raw_row, &["퇴사일"]);
    let status = Some(
        if exit_date.is_some() {
            "퇴사"
        } else {
            "재직"
        }
        .to_owned(),
    );

    Ok(EmployeeResponse {
        id: row.try_get("id")?,
        company: row.try_get("company")?,
        name: row.try_get("name")?,
        worksite_name,
        worksite,
        job,
        position,
        hire_date,
        exit_date,
        status,
        source_filename: row.try_get("source_filename")?,
        source_sheet: row.try_get("source_sheet")?,
        source_row: row.try_get("source_row")?,
        raw_row,
        source_metadata: row.try_get("source_metadata")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
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
}
