//! Registry REST API.
//!
//! This layer handles JWT authentication, branch-scoped authorization, and
//! HTTP error mapping for equipment registry use cases. State-changing
//! substitute assignment operations remain in the Postgres adapter and route
//! through `with_audit`.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::collections::BTreeSet;
use std::str::FromStr;

use axum::extract::{DefaultBodyLimit, Multipart, Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use mnt_kernel_core::{
    ADDRESS_MAX_CHARS, BranchId, BranchScope, CITY_MAX_CHARS, CONTACT_EMAIL_MAX_CHARS,
    CONTACT_NAME_MAX_CHARS, CONTACT_PHONE_MAX_CHARS, CUSTOMER_SITE_NAME_MAX_CHARS, CustomerId,
    EquipmentId, EquipmentSubstitutionId, ErrorKind, KernelError, OrgId, POSTAL_CODE_MAX_CHARS,
    PROVINCE_MAX_CHARS, SiteId, TraceContext, UserId, validate_bounded_text,
    validate_coordinate_pair,
};
use mnt_platform_auth::{AccessClaims, JwtVerifier};
use mnt_platform_authz::{
    Action, Feature, Principal, Role, authorize, resolve_branch_scope_in_org,
};
use mnt_registry_adapter_postgres::{PgRegistryError, PgRegistryStore};
use mnt_registry_application::{
    CreateCustomerCommand, CreateEquipmentCommand, CreateSiteCommand, CreatedCustomer, CreatedSite,
    DeleteEquipmentCommand, EquipmentByLocationQuery, EquipmentListQuery, EquipmentSortBy,
    RegistryImportReport, SiteLocationGroup, SubstituteAssignment, SubstituteAssignmentCommand,
    SubstituteCandidate, SubstituteReturnCommand, SubstituteSearch, UpdateEquipmentCommand,
    UpdateEquipmentFields, UpdateSiteCommand, UpdateSiteFields,
};
use mnt_registry_domain::{EquipmentNo, EquipmentStatus, MoneyWon, SubstituteMatchKind, Ton};
use serde::{Deserialize, Serialize};
use time::Date;
use time::OffsetDateTime;

pub const EQUIPMENT_PATH: &str = "/api/v1/equipment";
pub const EQUIPMENT_LIST_PATH: &str = "/api/v1/equipment/list";
pub const EQUIPMENT_IMPORT_PATH: &str = "/api/v1/equipment/import";
pub const EQUIPMENT_ID_PATH_TEMPLATE: &str = "/api/v1/equipment/{id}";
pub const EQUIPMENT_SUBSTITUTES_PATH_TEMPLATE: &str = "/api/v1/equipment/{id}/substitutes";
pub const EQUIPMENT_SUBSTITUTIONS_PATH: &str = "/api/v1/equipment-substitutions";
pub const EQUIPMENT_SUBSTITUTION_RETURN_PATH_TEMPLATE: &str =
    "/api/v1/equipment-substitutions/{id}/return";
pub const EQUIPMENT_BY_LOCATION_PATH: &str = "/api/v1/equipment-by-location";
pub const CUSTOMERS_PATH: &str = "/api/v1/customers";
pub const SITES_PATH: &str = "/api/v1/sites";
pub const SITE_ID_PATH_TEMPLATE: &str = "/api/v1/sites/{id}";
pub const REGISTRY_ROUTE_PATHS: &[&str] = &[
    EQUIPMENT_PATH,
    EQUIPMENT_LIST_PATH,
    EQUIPMENT_IMPORT_PATH,
    EQUIPMENT_ID_PATH_TEMPLATE,
    EQUIPMENT_SUBSTITUTES_PATH_TEMPLATE,
    EQUIPMENT_SUBSTITUTIONS_PATH,
    EQUIPMENT_SUBSTITUTION_RETURN_PATH_TEMPLATE,
    EQUIPMENT_BY_LOCATION_PATH,
    CUSTOMERS_PATH,
    SITES_PATH,
    SITE_ID_PATH_TEMPLATE,
];

/// Hard cap on an uploaded master-list workbook. The reference master-list is a
/// few hundred KiB; 16 MiB leaves generous headroom while bounding memory.
const MAX_IMPORT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct RegistryRestState {
    store: PgRegistryStore,
    jwt_verifier: Option<JwtVerifier>,
}

impl RegistryRestState {
    #[must_use]
    pub fn new(store: PgRegistryStore, jwt_verifier: Option<JwtVerifier>) -> Self {
        Self {
            store,
            jwt_verifier,
        }
    }
}

pub fn router(state: RegistryRestState) -> Router {
    let verifier = state.jwt_verifier.clone();
    let pool = state.store.pool().clone();
    let router = Router::new()
        .route(
            EQUIPMENT_SUBSTITUTES_PATH_TEMPLATE,
            get(list_equipment_substitutes),
        )
        .route(
            EQUIPMENT_SUBSTITUTIONS_PATH,
            post(assign_equipment_substitute),
        )
        .route(
            EQUIPMENT_SUBSTITUTION_RETURN_PATH_TEMPLATE,
            post(return_equipment_substitute),
        )
        .route(EQUIPMENT_LIST_PATH, get(list_equipment))
        .route(EQUIPMENT_PATH, post(create_equipment))
        // The import route accepts a workbook upload, so it overrides axum's
        // 2 MiB default body limit up to MAX_IMPORT_BYTES — a tower-level cap
        // that rejects oversized uploads before the handler reads them. The
        // streaming check in `read_xlsx_upload` enforces the same bound on the
        // body itself (chunked transfer with no honest Content-Length).
        .route(
            EQUIPMENT_IMPORT_PATH,
            post(import_master_list).layer(DefaultBodyLimit::max(MAX_IMPORT_BYTES)),
        )
        .route(
            EQUIPMENT_ID_PATH_TEMPLATE,
            axum::routing::patch(update_equipment).delete(delete_equipment),
        )
        .route(EQUIPMENT_BY_LOCATION_PATH, get(equipment_by_location))
        .route(CUSTOMERS_PATH, post(create_customer))
        .route(SITES_PATH, post(create_site))
        .route(SITE_ID_PATH_TEMPLATE, axum::routing::patch(update_site))
        .with_state(state);
    mnt_platform_request_context::with_request_context(router, verifier, pool)
}

#[derive(Debug, Deserialize)]
struct SubstituteQuery {
    all_branches: Option<bool>,
}

#[derive(Debug, Serialize)]
struct SubstituteCandidatePage {
    items: Vec<SubstituteCandidateResponse>,
    total: usize,
}

#[derive(Debug, Serialize)]
struct SubstituteCandidateResponse {
    equipment_id: EquipmentId,
    branch_id: BranchId,
    equipment_no: String,
    management_no: Option<String>,
    model: Option<String>,
    status: EquipmentStatus,
    specification: String,
    ton_text: String,
    ton_milli: Option<i32>,
    power_code: String,
    power_label: Option<String>,
    customer_name: String,
    site_name: String,
    placement_location: Option<String>,
    match_kind: SubstituteMatchKind,
    ton_delta_milli: Option<i32>,
}

async fn list_equipment_substitutes(
    State(state): State<RegistryRestState>,
    headers: HeaderMap,
    Path(equipment_id): Path<EquipmentId>,
    Query(query): Query<SubstituteQuery>,
) -> Result<Json<SubstituteCandidatePage>, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    authorize_read_access(&principal)?;
    let include_all_branches = query.all_branches.unwrap_or(false);
    if include_all_branches && !is_super_admin(&principal) {
        return Err(RestError::forbidden(
            "all_branches substitute search requires SUPER_ADMIN",
        ));
    }

    let items = state
        .store
        .substitute_candidates(SubstituteSearch {
            equipment_id,
            branch_scope: principal.branch_scope,
            include_all_branches,
        })
        .await
        .map_err(RestError::from_store)?
        .into_iter()
        .map(SubstituteCandidateResponse::from)
        .collect::<Vec<_>>();
    let total = items.len();

    Ok(Json(SubstituteCandidatePage { items, total }))
}

impl From<SubstituteCandidate> for SubstituteCandidateResponse {
    fn from(value: SubstituteCandidate) -> Self {
        Self {
            equipment_id: value.equipment_id,
            branch_id: value.branch_id,
            equipment_no: value.equipment_no.to_string(),
            management_no: value.management_no,
            model: value.model,
            status: value.status,
            specification: value.specification,
            ton_text: value.ton.as_text().to_owned(),
            ton_milli: value.ton.milli_tons(),
            power_code: value.power_code,
            power_label: value.power_label,
            customer_name: value.customer_name,
            site_name: value.site_name,
            placement_location: value.placement_location,
            match_kind: value.match_kind,
            ton_delta_milli: value.ton_delta_milli,
        }
    }
}

// ---------------------------------------------------------------------------
// Equipment-by-location — dispatch-map aggregation (read, all read-access roles)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
struct EquipmentByLocationPage {
    items: Vec<SiteLocationResponse>,
    total: usize,
}

#[derive(Debug, Serialize)]
struct SiteLocationResponse {
    site_id: SiteId,
    site_name: String,
    customer_id: CustomerId,
    customer_name: String,
    branch_id: BranchId,
    address: Option<String>,
    postal_code: Option<String>,
    province: Option<String>,
    city: Option<String>,
    latitude: Option<f64>,
    longitude: Option<f64>,
    geofence_radius_m: Option<f64>,
    contact_name: Option<String>,
    contact_phone: Option<String>,
    contact_email: Option<String>,
    equipment_count: i64,
    rented_count: i64,
    spare_count: i64,
    substitution_active_count: i64,
}

impl From<SiteLocationGroup> for SiteLocationResponse {
    fn from(value: SiteLocationGroup) -> Self {
        Self {
            site_id: value.site_id,
            site_name: value.site_name,
            customer_id: value.customer_id,
            customer_name: value.customer_name,
            branch_id: value.branch_id,
            address: value.address,
            postal_code: value.postal_code,
            province: value.province,
            city: value.city,
            latitude: value.latitude,
            longitude: value.longitude,
            geofence_radius_m: value.geofence_radius_m,
            contact_name: value.contact_name,
            contact_phone: value.contact_phone,
            contact_email: value.contact_email,
            equipment_count: value.equipment_count,
            rented_count: value.rented_count,
            spare_count: value.spare_count,
            substitution_active_count: value.substitution_active_count,
        }
    }
}

/// GET /api/v1/equipment-by-location — every site visible to the principal with
/// its equipment counts and admin-entered coordinates, for the dispatch map.
/// Read access (WorkOrderReadAll, all roles); branch-scoped like the substitute
/// search so a non-SUPER_ADMIN only sees their own branches.
async fn equipment_by_location(
    State(state): State<RegistryRestState>,
    headers: HeaderMap,
) -> Result<Json<EquipmentByLocationPage>, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    authorize_read_access(&principal)?;

    let items = state
        .store
        .equipment_by_location(EquipmentByLocationQuery {
            branch_scope: principal.branch_scope,
        })
        .await
        .map_err(RestError::from_store)?
        .into_iter()
        .map(SiteLocationResponse::from)
        .collect::<Vec<_>>();
    let total = items.len();

    Ok(Json(EquipmentByLocationPage { items, total }))
}

// ---------------------------------------------------------------------------
// Equipment list — paginated browse (read-access, branch-scoped)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct EquipmentListQueryParams {
    q: Option<String>,
    status: Option<EquipmentStatus>,
    branch_id: Option<BranchId>,
    customer_id: Option<CustomerId>,
    site_id: Option<SiteId>,
    model: Option<String>,
    maker: Option<String>,
    sort: Option<EquipmentSortBy>,
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Debug, Serialize)]
struct EquipmentListResponse {
    items: Vec<EquipmentListItemResponse>,
    total: i64,
    limit: i64,
    offset: i64,
}

#[derive(Debug, Serialize)]
struct EquipmentListItemResponse {
    equipment_id: EquipmentId,
    branch_id: BranchId,
    equipment_no: String,
    management_no: Option<String>,
    status: EquipmentStatus,
    model: Option<String>,
    maker: Option<String>,
    specification: String,
    ton_text: String,
    customer_name: String,
    site_name: String,
    vin: Option<String>,
    updated_at: OffsetDateTime,
}

/// GET /api/v1/equipment/list — paginated, filterable, branch-scoped equipment
/// list. Read access (WorkOrderReadAll, all authenticated roles). Non-SUPER_ADMIN
/// principals see only rows in their own branch(es) — the same scope guard used
/// by the substitute-search and dispatch-map endpoints. The `q` parameter is
/// normalized like the 호기-lookup: strips a leading '#' and a trailing '호기'
/// suffix then matches leading-zero-insensitively, so the floor-typed '10호기'
/// and the stored '010' resolve to the same row.
async fn list_equipment(
    State(state): State<RegistryRestState>,
    headers: HeaderMap,
    Query(params): Query<EquipmentListQueryParams>,
) -> Result<Json<EquipmentListResponse>, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    authorize_read_access(&principal)?;

    let page = state
        .store
        .list_equipment(EquipmentListQuery {
            branch_scope: principal.branch_scope,
            q: params.q,
            status: params.status,
            branch_id: params.branch_id,
            customer_id: params.customer_id,
            site_id: params.site_id,
            model: params.model,
            maker: params.maker,
            sort: params.sort.unwrap_or_default(),
            limit: params.limit.unwrap_or(50),
            offset: params.offset.unwrap_or(0),
        })
        .await
        .map_err(RestError::from_store)?;

    Ok(Json(EquipmentListResponse {
        items: page
            .items
            .into_iter()
            .map(|item| EquipmentListItemResponse {
                equipment_id: item.equipment_id,
                branch_id: item.branch_id,
                equipment_no: item.equipment_no,
                management_no: item.management_no,
                status: item.status,
                model: item.model,
                maker: item.maker,
                specification: item.specification,
                ton_text: item.ton_text,
                customer_name: item.customer_name,
                site_name: item.site_name,
                vin: item.vin,
                updated_at: item.updated_at,
            })
            .collect(),
        total: page.total,
        limit: page.limit,
        offset: page.offset,
    }))
}

// ---------------------------------------------------------------------------
// Customer / site direct creation — audited writes (EquipmentManage)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct CreateCustomerRequest {
    name: String,
}

#[derive(Debug, Serialize)]
struct CreatedCustomerResponse {
    id: CustomerId,
    branch_id: BranchId,
    name: String,
}

impl From<CreatedCustomer> for CreatedCustomerResponse {
    fn from(value: CreatedCustomer) -> Self {
        Self {
            id: value.id,
            branch_id: value.branch_id,
            name: value.name,
        }
    }
}

/// POST /api/v1/customers — create a customer (고객) directly in the caller's org
/// on the default HQ branch. Admin-gated (EquipmentManage), the same feature as
/// the site PATCH. The name is trimmed, required, and bounded; a same-name
/// customer already on the branch is a 409 conflict (an explicit create is a
/// distinct intent from the importer's idempotent upsert, so it is surfaced, not
/// silently merged). Returns the created customer so the console can show it.
async fn create_customer(
    State(state): State<RegistryRestState>,
    headers: HeaderMap,
    Json(body): Json<CreateCustomerRequest>,
) -> Result<(StatusCode, Json<CreatedCustomerResponse>), RestError> {
    let principal = principal_from_headers_db(&state, &headers).await?;
    authorize_equipment_feature(&principal, Feature::EquipmentManage)?;

    let name = require_bounded_name(body.name, "name")?;
    let customer = state
        .store
        .create_customer(CreateCustomerCommand {
            actor: principal.user_id,
            branch_id: principal_create_branch(&principal),
            name,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok((StatusCode::CREATED, Json(customer.into())))
}

#[derive(Debug, Deserialize)]
struct CreateSiteRequest {
    customer_id: CustomerId,
    name: String,
    #[serde(default)]
    address: Option<String>,
    #[serde(default)]
    province: Option<String>,
    #[serde(default)]
    city: Option<String>,
    #[serde(default)]
    postal_code: Option<String>,
    #[serde(default)]
    latitude: Option<f64>,
    #[serde(default)]
    longitude: Option<f64>,
    #[serde(default)]
    geofence_radius_m: Option<f64>,
    #[serde(default)]
    contact_name: Option<String>,
    #[serde(default)]
    contact_phone: Option<String>,
    #[serde(default)]
    contact_email: Option<String>,
}

#[derive(Debug, Serialize)]
struct CreatedSiteResponse {
    id: SiteId,
    customer_id: CustomerId,
    branch_id: BranchId,
    name: String,
    address: Option<String>,
    province: Option<String>,
    city: Option<String>,
    postal_code: Option<String>,
    latitude: Option<f64>,
    longitude: Option<f64>,
    geofence_radius_m: Option<f64>,
    contact_name: Option<String>,
    contact_phone: Option<String>,
    contact_email: Option<String>,
}

impl From<CreatedSite> for CreatedSiteResponse {
    fn from(value: CreatedSite) -> Self {
        Self {
            id: value.id,
            customer_id: value.customer_id,
            branch_id: value.branch_id,
            name: value.name,
            address: value.address,
            province: value.province,
            city: value.city,
            postal_code: value.postal_code,
            latitude: value.latitude,
            longitude: value.longitude,
            geofence_radius_m: value.geofence_radius_m,
            contact_name: value.contact_name,
            contact_phone: value.contact_phone,
            contact_email: value.contact_email,
        }
    }
}

/// POST /api/v1/sites — create a site (현장) under an existing customer in the
/// caller's org. Admin-gated (EquipmentManage). The customer must belong to the
/// caller's org: an unknown or foreign-org `customer_id` is a 404 (RLS hides
/// another tenant's customer, so it is never revealed). Name is required and
/// bounded; optional address/coordinate/contact fields are validated to the same
/// WGS84 ranges and length bounds as the site PATCH (a one-sided coordinate or an
/// over-long value is a 422 before the write). A duplicate site name under the
/// same customer is a 409. Returns the created site so it appears in the list/map
/// immediately.
async fn create_site(
    State(state): State<RegistryRestState>,
    headers: HeaderMap,
    Json(body): Json<CreateSiteRequest>,
) -> Result<(StatusCode, Json<CreatedSiteResponse>), RestError> {
    let principal = principal_from_headers_db(&state, &headers).await?;
    authorize_equipment_feature(&principal, Feature::EquipmentManage)?;

    let name = require_bounded_name(body.name, "name")?;
    // Coordinates: both or neither, each in WGS84 range (mirrors the PATCH path
    // and the registry_sites_lat_lon_paired CHECK).
    validate_coordinate_pair(body.latitude, body.longitude).map_err(RestError::from_kernel)?;
    validate_create_site_geofence_radius(body.geofence_radius_m)?;
    // Bound the optional address/region/contact text to the same limits as the
    // registry_sites CHECKs, so an over-long value is a 422 not a raw DB error.
    for (value, max, field) in [
        (body.address.as_deref(), ADDRESS_MAX_CHARS, "address"),
        (body.province.as_deref(), PROVINCE_MAX_CHARS, "province"),
        (body.city.as_deref(), CITY_MAX_CHARS, "city"),
        (
            body.postal_code.as_deref(),
            POSTAL_CODE_MAX_CHARS,
            "postal_code",
        ),
        (
            body.contact_name.as_deref(),
            CONTACT_NAME_MAX_CHARS,
            "contact_name",
        ),
        (
            body.contact_phone.as_deref(),
            CONTACT_PHONE_MAX_CHARS,
            "contact_phone",
        ),
        (
            body.contact_email.as_deref(),
            CONTACT_EMAIL_MAX_CHARS,
            "contact_email",
        ),
    ] {
        if let Some(text) = value {
            validate_bounded_text(text, max, field).map_err(RestError::from_kernel)?;
        }
    }

    let site = state
        .store
        .create_site(CreateSiteCommand {
            actor: principal.user_id,
            customer_id: body.customer_id,
            name,
            address: normalize_optional(body.address),
            province: normalize_optional(body.province),
            city: normalize_optional(body.city),
            postal_code: normalize_optional(body.postal_code),
            latitude: body.latitude,
            longitude: body.longitude,
            geofence_radius_m: body.geofence_radius_m,
            contact_name: normalize_optional(body.contact_name),
            contact_phone: normalize_optional(body.contact_phone),
            contact_email: normalize_optional(body.contact_email),
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok((StatusCode::CREATED, Json(site.into())))
}

/// The branch a direct create should land on for this principal. A branch-scoped
/// admin creates on its own (first) branch, so the new row is immediately visible
/// to that admin's branch-scoped registry reads (the by-location list). An
/// org-wide principal (SUPER_ADMIN/EXECUTIVE, `BranchScope::All`) has no single
/// branch and sees every branch anyway, so it returns `None` — the adapter then
/// lands the row on the org's default HQ branch.
fn principal_create_branch(principal: &Principal) -> Option<BranchId> {
    match &principal.branch_scope {
        BranchScope::All => None,
        BranchScope::Branches(branches) => branches.iter().next().copied(),
    }
}

/// Bound a required customer/site name: trim, reject empty (mirrors the
/// `name <> ''` CHECK), and cap the length (mirrors the migration-0047 CHECK and
/// the `CUSTOMER_SITE_NAME_MAX_CHARS` domain bound) so an over-long name is a 422.
fn require_bounded_name(value: String, field: &str) -> Result<String, RestError> {
    let trimmed = require_nonempty(value, field)?;
    validate_bounded_text(&trimmed, CUSTOMER_SITE_NAME_MAX_CHARS, field)
        .map_err(RestError::from_kernel)?;
    Ok(trimmed)
}

/// Trim an optional free-text field, collapsing an empty/whitespace-only string to
/// `None` so the row stores NULL rather than "" (matching the PATCH path, which
/// treats a blank field as "no value").
fn normalize_optional(value: Option<String>) -> Option<String> {
    value.and_then(|text| {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_owned())
        }
    })
}

/// Bound the optional geofence radius on a site create to the same range as the
/// `registry_sites_geofence_radius_positive` CHECK (migration 0041): a present
/// value must be finite, > 0, and ≤ 100 000 m. Absent needs no check.
fn validate_create_site_geofence_radius(radius: Option<f64>) -> Result<(), RestError> {
    if let Some(radius) = radius
        && (!radius.is_finite() || radius <= 0.0 || radius > 100_000.0)
    {
        return Err(RestError::from_kernel(KernelError::validation(
            "geofence_radius_m must be greater than 0 and at most 100000 metres",
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Site coordinate/address update — audited write (EquipmentManage)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct UpdateSiteRequest {
    #[serde(default, deserialize_with = "double_option")]
    address: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    province: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    city: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    postal_code: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    latitude: Option<Option<f64>>,
    #[serde(default, deserialize_with = "double_option")]
    longitude: Option<Option<f64>>,
    #[serde(default, deserialize_with = "double_option")]
    geofence_radius_m: Option<Option<f64>>,
    #[serde(default, deserialize_with = "double_option")]
    contact_name: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    contact_phone: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    contact_email: Option<Option<String>>,
}

/// PATCH /api/v1/sites/{id} — the ONLY coordinate entry point. Admin-gated
/// (EquipmentManage); the lat/lon ranges and pairing are validated in the
/// kernel before the audited write opens a transaction, so a bad value is a 422
/// rather than a DB error. No geocoding service: coordinates exist only because
/// an admin typed them here.
async fn update_site(
    State(state): State<RegistryRestState>,
    headers: HeaderMap,
    Path(site_id): Path<SiteId>,
    Json(body): Json<UpdateSiteRequest>,
) -> Result<StatusCode, RestError> {
    let principal = principal_from_headers_db(&state, &headers).await?;
    authorize_equipment_feature(&principal, Feature::EquipmentManage)?;

    // Validate the supplied coordinate edits in the domain. A present-but-null
    // pair (clearing both) is allowed; a one-sided present value is rejected to
    // mirror the registry_sites_lat_lon_paired CHECK.
    validate_site_coordinates(&body)?;
    validate_site_contact(&body)?;
    validate_site_address_fields(&body)?;
    validate_site_geofence_radius(&body)?;

    let fields = UpdateSiteFields {
        address: body.address,
        province: body.province,
        city: body.city,
        postal_code: body.postal_code,
        latitude: body.latitude,
        longitude: body.longitude,
        geofence_radius_m: body.geofence_radius_m,
        contact_name: body.contact_name,
        contact_phone: body.contact_phone,
        contact_email: body.contact_email,
    };
    if fields.is_empty() {
        return Err(RestError::from_kernel(KernelError::validation(
            "no site fields to update",
        )));
    }
    state
        .store
        .update_site(UpdateSiteCommand {
            actor: principal.user_id,
            site_id,
            fields,
            branch_scope: principal.branch_scope.clone(),
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(StatusCode::NO_CONTENT)
}

/// Validate the coordinate edits on a site PATCH. Only validates when at least
/// one coordinate field is present in the request; when neither key is supplied
/// the existing stored pair is untouched and needs no check here.
fn validate_site_coordinates(body: &UpdateSiteRequest) -> Result<(), RestError> {
    match (&body.latitude, &body.longitude) {
        // Neither coordinate field present — nothing to validate.
        (None, None) => Ok(()),
        // Both present: must be jointly set or jointly cleared, and in range.
        (Some(lat), Some(lon)) => {
            validate_coordinate_pair(*lat, *lon).map_err(RestError::from_kernel)
        }
        // Exactly one coordinate key present: a half-update would leave the row
        // with one coordinate set and the other stale, breaking the pairing
        // invariant. Reject it explicitly.
        _ => Err(RestError::from_kernel(KernelError::validation(
            "latitude and longitude must be updated together",
        ))),
    }
}

/// Bound the optional representative-contact text fields on a site PATCH to the
/// same limits as the `registry_sites` contact CHECKs (migration 0040), so an
/// over-long value is rejected with a 422 rather than surfacing as a raw DB CHECK
/// error. Only present (`Some(Some(_))`) values are checked; absent or
/// explicit-null fields need no bound.
fn validate_site_contact(body: &UpdateSiteRequest) -> Result<(), RestError> {
    for (change, max, field) in [
        (&body.contact_name, CONTACT_NAME_MAX_CHARS, "contact_name"),
        (
            &body.contact_phone,
            CONTACT_PHONE_MAX_CHARS,
            "contact_phone",
        ),
        (
            &body.contact_email,
            CONTACT_EMAIL_MAX_CHARS,
            "contact_email",
        ),
    ] {
        if let Some(Some(text)) = change {
            validate_bounded_text(text, max, field).map_err(RestError::from_kernel)?;
        }
    }
    Ok(())
}

/// Bound the optional address/region fields on a site PATCH to the same lengths
/// as the migration 0039 CHECKs, returning a 422 before the write rather than
/// surfacing an over-long value as a raw 500 DB CHECK error. Absent and
/// explicit-null fields need no bound.
fn validate_site_address_fields(body: &UpdateSiteRequest) -> Result<(), RestError> {
    for (change, max, field) in [
        (&body.address, ADDRESS_MAX_CHARS, "address"),
        (&body.province, PROVINCE_MAX_CHARS, "province"),
        (&body.city, CITY_MAX_CHARS, "city"),
        (&body.postal_code, POSTAL_CODE_MAX_CHARS, "postal_code"),
    ] {
        if let Some(Some(text)) = change {
            validate_bounded_text(text, max, field).map_err(RestError::from_kernel)?;
        }
    }
    Ok(())
}

/// Bound the optional per-site geofence radius on a site PATCH to the same range
/// as the `registry_sites_geofence_radius_positive` CHECK (migration 0041): a
/// present value must be finite, > 0, and ≤ 100 000 m. An explicit-null (clear →
/// fall back to the system default) or an absent field needs no check.
fn validate_site_geofence_radius(body: &UpdateSiteRequest) -> Result<(), RestError> {
    if let Some(Some(radius)) = body.geofence_radius_m
        && (!radius.is_finite() || radius <= 0.0 || radius > 100_000.0)
    {
        return Err(RestError::from_kernel(KernelError::validation(
            "geofence_radius_m must be greater than 0 and at most 100000 metres",
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Substitute (대차) assignment / return — audited equipment-lifecycle writes
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct AssignSubstituteRequest {
    source_equipment_id: EquipmentId,
    substitute_equipment_id: EquipmentId,
    #[serde(default)]
    assigned_to: Option<UserId>,
    assignment_location: String,
}

#[derive(Debug, Deserialize)]
struct ReturnSubstituteRequest {
    #[serde(default)]
    return_note: Option<String>,
}

#[derive(Debug, Serialize)]
struct SubstituteAssignmentResponse {
    id: EquipmentSubstitutionId,
    branch_id: BranchId,
    source_equipment_id: EquipmentId,
    substitute_equipment_id: EquipmentId,
    assigned_by: UserId,
    assigned_to: Option<UserId>,
    assignment_location: String,
    assigned_at: OffsetDateTime,
    returned_by: Option<UserId>,
    returned_at: Option<OffsetDateTime>,
    return_note: Option<String>,
}

impl From<SubstituteAssignment> for SubstituteAssignmentResponse {
    fn from(value: SubstituteAssignment) -> Self {
        Self {
            id: value.id,
            branch_id: value.branch_id,
            source_equipment_id: value.source_equipment_id,
            substitute_equipment_id: value.substitute_equipment_id,
            assigned_by: value.assigned_by,
            assigned_to: value.assigned_to,
            assignment_location: value.assignment_location,
            assigned_at: value.assigned_at,
            returned_by: value.returned_by,
            returned_at: value.returned_at,
            return_note: value.return_note,
        }
    }
}

async fn assign_equipment_substitute(
    State(state): State<RegistryRestState>,
    headers: HeaderMap,
    Json(body): Json<AssignSubstituteRequest>,
) -> Result<(StatusCode, Json<SubstituteAssignmentResponse>), RestError> {
    let principal = principal_from_headers_db(&state, &headers).await?;
    authorize_equipment_feature(&principal, Feature::EquipmentManage)?;

    let command = SubstituteAssignmentCommand {
        actor: principal.user_id,
        source_equipment_id: body.source_equipment_id,
        substitute_equipment_id: body.substitute_equipment_id,
        assigned_to: body.assigned_to,
        assignment_location: require_nonempty(body.assignment_location, "assignment_location")?,
        trace: TraceContext::generate(),
        assigned_at: OffsetDateTime::now_utc(),
    };
    let assignment = state
        .store
        .assign_substitute(command)
        .await
        .map_err(RestError::from_store)?;
    Ok((StatusCode::CREATED, Json(assignment.into())))
}

async fn return_equipment_substitute(
    State(state): State<RegistryRestState>,
    headers: HeaderMap,
    Path(substitution_id): Path<EquipmentSubstitutionId>,
    Json(body): Json<ReturnSubstituteRequest>,
) -> Result<Json<SubstituteAssignmentResponse>, RestError> {
    let principal = principal_from_headers_db(&state, &headers).await?;
    authorize_equipment_feature(&principal, Feature::EquipmentManage)?;

    let command = SubstituteReturnCommand {
        actor: principal.user_id,
        substitution_id,
        trace: TraceContext::generate(),
        returned_at: OffsetDateTime::now_utc(),
        return_note: body.return_note,
    };
    let assignment = state
        .store
        .return_substitute(command)
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(assignment.into()))
}

// ---------------------------------------------------------------------------
// Equipment master import (admin-gated multipart upload)
// ---------------------------------------------------------------------------

async fn import_master_list(
    State(state): State<RegistryRestState>,
    headers: HeaderMap,
    multipart: Multipart,
) -> Result<Json<RegistryImportReport>, RestError> {
    let principal = principal_from_headers_db(&state, &headers).await?;
    authorize_equipment_feature(&principal, Feature::MasterListImport)?;

    let upload = read_xlsx_upload(multipart).await?;
    let report = state
        .store
        .import_master_list_bytes(principal.user_id, &upload.filename, &upload.bytes)
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(report))
}

struct XlsxUpload {
    filename: String,
    bytes: Vec<u8>,
}

async fn read_xlsx_upload(mut multipart: Multipart) -> Result<XlsxUpload, RestError> {
    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|err| RestError::from_kernel(KernelError::validation(err.to_string())))?
    {
        if field.name() != Some("file") {
            continue;
        }
        let filename = field
            .file_name()
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| "master-list.xlsx".to_owned());
        // Stream the field chunk-by-chunk and abort the moment the running total
        // exceeds MAX_IMPORT_BYTES. `Field::bytes()` would buffer the entire
        // upload into memory *before* any size check, so a malicious or
        // misconfigured client could exhaust the worker's heap before the cap
        // fired — the check has to bound the read incrementally, not after.
        let mut bytes: Vec<u8> = Vec::new();
        while let Some(chunk) = field
            .chunk()
            .await
            .map_err(|err| RestError::from_kernel(KernelError::validation(err.to_string())))?
        {
            if bytes.len() + chunk.len() > MAX_IMPORT_BYTES {
                return Err(RestError::from_kernel(KernelError::validation(
                    "uploaded file exceeds the maximum import size",
                )));
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty() {
            return Err(RestError::from_kernel(KernelError::validation(
                "uploaded file is empty",
            )));
        }
        return Ok(XlsxUpload { filename, bytes });
    }
    Err(RestError::from_kernel(KernelError::validation(
        "multipart upload is missing the 'file' field",
    )))
}

// ---------------------------------------------------------------------------
// Equipment CRUD (admin-gated)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct CreateEquipmentRequest {
    equipment_no: String,
    customer_name: String,
    site_name: String,
    status: EquipmentStatus,
    specification: String,
    ton_text: String,
    #[serde(default)]
    management_no: Option<String>,
    #[serde(default)]
    power_label: Option<String>,
    #[serde(default)]
    manager_name: Option<String>,
    #[serde(default)]
    placement_location: Option<String>,
    #[serde(default)]
    placement_no: Option<String>,
    #[serde(default)]
    operation_shift: Option<String>,
    #[serde(default)]
    maker: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    vin: Option<String>,
    #[serde(default)]
    year: Option<Date>,
    #[serde(default)]
    hours: Option<i64>,
    #[serde(default)]
    vehicle_registration_no: Option<String>,
    #[serde(default)]
    insured: Option<bool>,
    #[serde(default)]
    insurer: Option<String>,
    #[serde(default)]
    policy_holder: Option<String>,
    #[serde(default)]
    insured_party: Option<String>,
    #[serde(default)]
    asset_owner: Option<String>,
    #[serde(default)]
    asset_registered_on: Option<Date>,
    #[serde(default)]
    rental_started_on: Option<Date>,
    #[serde(default)]
    rental_fee: Option<i64>,
    #[serde(default)]
    vehicle_value: Option<i64>,
    #[serde(default)]
    residual_value: Option<i64>,
    #[serde(default)]
    note: Option<String>,
}

#[derive(Debug, Serialize)]
struct CreateEquipmentResponse {
    id: EquipmentId,
}

async fn create_equipment(
    State(state): State<RegistryRestState>,
    headers: HeaderMap,
    Json(body): Json<CreateEquipmentRequest>,
) -> Result<(StatusCode, Json<CreateEquipmentResponse>), RestError> {
    let principal = principal_from_headers_db(&state, &headers).await?;
    authorize_equipment_feature(&principal, Feature::EquipmentManage)?;

    let equipment_no = EquipmentNo::parse(body.equipment_no).map_err(RestError::from_kernel)?;
    let command = CreateEquipmentCommand {
        actor: principal.user_id,
        equipment_no,
        customer_name: require_nonempty(body.customer_name, "customer_name")?,
        site_name: require_nonempty(body.site_name, "site_name")?,
        status: body.status,
        specification: require_nonempty(body.specification, "specification")?,
        ton: Ton::parse(&body.ton_text),
        management_no: body.management_no,
        power_label: body.power_label,
        manager_name: body.manager_name,
        placement_location: body.placement_location,
        placement_no: body.placement_no,
        operation_shift: body.operation_shift,
        maker: body.maker,
        model: body.model,
        vin: body.vin,
        year: body.year,
        hours: body.hours,
        vehicle_registration_no: body.vehicle_registration_no,
        insured: body.insured,
        insurer: body.insurer,
        policy_holder: body.policy_holder,
        insured_party: body.insured_party,
        asset_owner: body.asset_owner,
        asset_registered_on: body.asset_registered_on,
        rental_started_on: body.rental_started_on,
        rental_fee: body.rental_fee.map(MoneyWon::new),
        vehicle_value: body.vehicle_value.map(MoneyWon::new),
        residual_value: body.residual_value.map(MoneyWon::new),
        note: body.note,
        trace: TraceContext::generate(),
        occurred_at: OffsetDateTime::now_utc(),
    };
    let id = state
        .store
        .create_equipment(command)
        .await
        .map_err(RestError::from_store)?;
    Ok((StatusCode::CREATED, Json(CreateEquipmentResponse { id })))
}

#[derive(Debug, Deserialize)]
struct UpdateEquipmentRequest {
    #[serde(default)]
    customer_name: Option<String>,
    #[serde(default)]
    site_name: Option<String>,
    #[serde(default)]
    status: Option<EquipmentStatus>,
    #[serde(default)]
    specification: Option<String>,
    #[serde(default)]
    ton_text: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    management_no: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    power_label: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    manager_name: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    placement_location: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    placement_no: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    operation_shift: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    maker: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    model: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    vin: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    year: Option<Option<Date>>,
    #[serde(default, deserialize_with = "double_option")]
    hours: Option<Option<i64>>,
    #[serde(default, deserialize_with = "double_option")]
    vehicle_registration_no: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    insured: Option<Option<bool>>,
    #[serde(default, deserialize_with = "double_option")]
    insurer: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    policy_holder: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    insured_party: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    asset_owner: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    asset_registered_on: Option<Option<Date>>,
    #[serde(default, deserialize_with = "double_option")]
    rental_started_on: Option<Option<Date>>,
    #[serde(default, deserialize_with = "double_option")]
    rental_fee: Option<Option<i64>>,
    #[serde(default, deserialize_with = "double_option")]
    vehicle_value: Option<Option<i64>>,
    #[serde(default, deserialize_with = "double_option")]
    residual_value: Option<Option<i64>>,
    #[serde(default, deserialize_with = "double_option")]
    acquisition_cost_won: Option<Option<i64>>,
    #[serde(default, deserialize_with = "double_option_iso_date")]
    acquisition_date: Option<Option<Date>>,
    #[serde(default, deserialize_with = "double_option")]
    note: Option<Option<String>>,
}

/// Distinguish "key absent" (leave unchanged) from "key present but null"
/// (clear the column) for nullable PATCH fields.
fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Deserialize::deserialize(deserializer).map(Some)
}

/// `double_option` for an ISO-8601 calendar date (`"YYYY-MM-DD"`): "key absent"
/// leaves the column unchanged, an explicit `null` clears it, and a date string
/// sets it. Uses the `format: date` wire contract (an honest string), matching
/// the regenerated OpenAPI/typed client.
fn double_option_iso_date<'de, D>(deserializer: D) -> Result<Option<Option<Date>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw: Option<String> = Deserialize::deserialize(deserializer)?;
    match raw {
        Some(value) => Date::parse(&value, &time::format_description::well_known::Iso8601::DATE)
            .map(|date| Some(Some(date)))
            .map_err(serde::de::Error::custom),
        None => Ok(Some(None)),
    }
}

async fn update_equipment(
    State(state): State<RegistryRestState>,
    headers: HeaderMap,
    Path(equipment_id): Path<EquipmentId>,
    Json(body): Json<UpdateEquipmentRequest>,
) -> Result<StatusCode, RestError> {
    let principal = principal_from_headers_db(&state, &headers).await?;
    authorize_equipment_feature(&principal, Feature::EquipmentManage)?;

    let fields = UpdateEquipmentFields {
        customer_name: body.customer_name,
        site_name: body.site_name,
        status: body.status,
        specification: body.specification,
        ton: body.ton_text.as_deref().map(Ton::parse),
        management_no: body.management_no,
        power_label: body.power_label,
        manager_name: body.manager_name,
        placement_location: body.placement_location,
        placement_no: body.placement_no,
        operation_shift: body.operation_shift,
        maker: body.maker,
        model: body.model,
        vin: body.vin,
        year: body.year,
        hours: body.hours,
        vehicle_registration_no: body.vehicle_registration_no,
        insured: body.insured,
        insurer: body.insurer,
        policy_holder: body.policy_holder,
        insured_party: body.insured_party,
        asset_owner: body.asset_owner,
        asset_registered_on: body.asset_registered_on,
        rental_started_on: body.rental_started_on,
        rental_fee: body.rental_fee.map(|value| value.map(MoneyWon::new)),
        vehicle_value: body.vehicle_value.map(|value| value.map(MoneyWon::new)),
        residual_value: body.residual_value.map(|value| value.map(MoneyWon::new)),
        acquisition_cost_won: body
            .acquisition_cost_won
            .map(|value| value.map(MoneyWon::new)),
        acquisition_date: body.acquisition_date,
        note: body.note,
    };
    if fields.is_empty() {
        return Err(RestError::from_kernel(KernelError::validation(
            "no equipment fields to update",
        )));
    }
    state
        .store
        .update_equipment(UpdateEquipmentCommand {
            actor: principal.user_id,
            equipment_id,
            fields,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_equipment(
    State(state): State<RegistryRestState>,
    headers: HeaderMap,
    Path(equipment_id): Path<EquipmentId>,
) -> Result<StatusCode, RestError> {
    let principal = principal_from_headers_db(&state, &headers).await?;
    authorize_equipment_feature(&principal, Feature::EquipmentManage)?;

    state
        .store
        .soft_delete_equipment(DeleteEquipmentCommand {
            actor: principal.user_id,
            equipment_id,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(StatusCode::NO_CONTENT)
}

fn require_nonempty(value: String, field: &str) -> Result<String, RestError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        Err(RestError::from_kernel(KernelError::validation(format!(
            "{field} must not be empty"
        ))))
    } else {
        Ok(trimmed.to_owned())
    }
}

/// Authorize a deliberately **org-global** equipment-master feature against a
/// representative branch: cross-branch principals authorize against a fresh id
/// (allowed by `BranchScope::All`); branch-scoped principals authorize against
/// one of their own branches. Because `authorize()` checks `branch_scope.allows`
/// first, the branch arg is a tautology for a branch-scoped caller — the feature
/// matrix cell is what actually decides.
///
/// This is correct ONLY because equipment management is org-global by design:
/// the whole fleet is created on the single HQ branch (`ensure_default_hq_branch`)
/// and any `EquipmentManage` holder (Admin/Executive/SuperAdmin — denied for
/// Receptionist/Mechanic) manages all of it. The read path (substitute search)
/// is branch-scoped; the write path intentionally is not. If equipment ever
/// becomes genuinely multi-branch, this representative-branch shortcut must be
/// replaced with a check against each row's real `branch_id` (tracked: app-wide
/// scoping follow-up) or a branch-scoped role could silently gain global reach.
fn authorize_equipment_feature(principal: &Principal, feature: Feature) -> Result<(), RestError> {
    let branch = match &principal.branch_scope {
        BranchScope::All => BranchId::new(),
        BranchScope::Branches(branches) => branches.iter().next().copied().ok_or_else(|| {
            RestError::from_kernel(KernelError::forbidden(
                "principal has no branch scope for equipment management",
            ))
        })?,
    };
    authorize(principal, Action::new(feature), branch).map_err(RestError::from_kernel)
}

async fn principal_from_headers_db(
    state: &RegistryRestState,
    headers: &HeaderMap,
) -> Result<Principal, RestError> {
    let verifier = state.jwt_verifier.as_ref().ok_or_else(|| {
        RestError::unavailable("JWT verification is not configured for registry API")
    })?;
    let token = bearer_token(headers)?;
    let claims = verifier
        .verify_access_token(token)
        .map_err(|_| RestError::unauthorized("invalid bearer token"))?;
    let user_id = UserId::from_str(&claims.sub)
        .map_err(|_| RestError::unauthorized("token subject is not a valid user id"))?;
    let role_vec: Vec<Role> = claims
        .roles
        .iter()
        .map(|role| {
            Role::from_str(role)
                .map_err(|_| RestError::unauthorized("token contains an unknown role"))
        })
        .collect::<Result<_, _>>()?;
    let org_id = OrgId::from_str(&claims.org)
        .map_err(|_| RestError::unauthorized("token contains an invalid org id"))?;
    // Arm the verified-token org explicitly: this path resolves the principal and
    // may run before the per-request tenant middleware has set CURRENT_ORG.
    let branch_scope = resolve_branch_scope_in_org(state.store.pool(), org_id, user_id, &role_vec)
        .await
        .map_err(RestError::from_kernel)?;
    let roles = role_vec.iter().copied().collect::<BTreeSet<_>>();
    let access_scope = claims
        .access_scope()
        .map_err(|_| RestError::unauthorized("token contains an invalid access scope"))?;
    Ok(Principal::new(user_id, org_id, roles, branch_scope).with_access_scope(access_scope))
}

fn authorize_read_access(principal: &Principal) -> Result<(), RestError> {
    let resource_branch = match &principal.branch_scope {
        BranchScope::All => BranchId::new(),
        BranchScope::Branches(branches) => branches.iter().next().copied().ok_or_else(|| {
            RestError::from_kernel(KernelError::forbidden("principal has no branch scope"))
        })?,
    };
    authorize(
        principal,
        Action::new(Feature::WorkOrderReadAll),
        resource_branch,
    )
    .map_err(RestError::from_kernel)
}

fn is_super_admin(principal: &Principal) -> bool {
    principal.roles.contains(&Role::SuperAdmin)
}

fn principal_from_headers(
    state: &RegistryRestState,
    headers: &HeaderMap,
) -> Result<Principal, RestError> {
    let verifier = state.jwt_verifier.as_ref().ok_or_else(|| {
        RestError::unavailable("JWT verification is not configured for registry API")
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
    let access_scope = claims
        .access_scope()
        .map_err(|_| RestError::unauthorized("token contains an invalid access scope"))?;
    Ok(Principal::new(user_id, org_id, roles, branch_scope).with_access_scope(access_scope))
}

#[derive(Debug)]
struct RestError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl RestError {
    fn from_store(error: PgRegistryError) -> Self {
        match error {
            PgRegistryError::Domain(error) => Self::from_kernel(error),
            // A DB or workbook failure becomes an opaque 500 for the client, but
            // the cause MUST be in the logs: in production the import 500 carried
            // no root cause (only tower_http's generic "response failed"), which
            // hid an RLS WITH CHECK rejection for ~two uploads. Log the error
            // Display server-side (the cause, e.g. the Postgres error code/table)
            // before mapping. The message is the DB/IO error text, never raw PII
            // (the pii-no-logs gate also scans this), so no secret/PII leaks.
            PgRegistryError::Db(err) => {
                tracing::error!(error = %err, "registry database operation failed");
                Self::internal("registry request failed")
            }
            PgRegistryError::Workbook(err) => {
                tracing::error!(error = %err, "registry workbook import failed");
                Self::internal("registry request failed")
            }
        }
    }

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

    fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "unauthorized",
            message: message.into(),
        }
    }

    fn forbidden(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            code: "forbidden",
            message: message.into(),
        }
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "unavailable",
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

impl IntoResponse for RestError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorBody {
                error: ErrorPayload {
                    code: self.code,
                    message: self.message,
                },
            }),
        )
            .into_response()
    }
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
