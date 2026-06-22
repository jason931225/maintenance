//! Sales-catalog REST API (#6).
//!
//! Two channels:
//!   * A PUBLIC, unauthenticated storefront under `/api/v1/storefront/*` that
//!     reads only published/reserved listings and accepts customer inquiries.
//!     It carries no JWT but still needs a tenant context for the store, so it
//!     runs inside `scope_org(OrgId::knl())` rather than the per-request tenant
//!     middleware.
//!   * An authenticated, `SalesManage`-gated admin console under
//!     `/api/v1/sales/*` for the full listing CRUD and the inquiry inbox.
//!
//! Sales is an ORG-LEVEL catalog (no branch scoping), so the admin handlers
//! authorize the feature against a representative branch, mirroring the registry
//! equipment-master writes. The handlers are thin delegators: all SQL and the
//! `with_audit` carve-out live in the Postgres adapter, so this surface carries
//! no audit markers.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::collections::BTreeSet;
use std::str::FromStr;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use mnt_kernel_core::{
    BranchId, BranchScope, CustomerInquiryId, EquipmentId, ErrorKind, KernelError, OrgId,
    SalesListingId, TraceContext, UserId, validate_bounded_text,
};
use mnt_platform_auth::{AccessClaims, JwtVerifier};
use mnt_platform_authz::{Action, Feature, Principal, Role, authorize};
use mnt_sales_adapter_postgres::{PgSalesError, PgSalesStore};
use mnt_sales_application::{
    CatalogQuery, CreateListingCommand, CustomerInquiryPage, DeleteListingCommand,
    InquiryInboxQuery, ListingInput, SalesListingPage, SalesListingView, SubmitInquiryCommand,
    UpdateInquiryStatusCommand, UpdateListingCommand, UpdateListingFields,
};
use mnt_sales_domain::{InquiryStatus, InquiryTopic, ListingKind, ListingStatus, ListingType};
use serde::{Deserialize, Serialize};
use time::{Duration, OffsetDateTime};

// ---------------------------------------------------------------------------
// Route paths (exported for the openapi_drift test)
// ---------------------------------------------------------------------------

pub const STOREFRONT_LISTINGS_PATH: &str = "/api/v1/storefront/listings";
pub const STOREFRONT_LISTING_PATH_TEMPLATE: &str = "/api/v1/storefront/listings/{id}";
pub const STOREFRONT_INQUIRIES_PATH: &str = "/api/v1/storefront/inquiries";
pub const SALES_LISTINGS_PATH: &str = "/api/v1/sales/listings";
pub const SALES_LISTING_PATH_TEMPLATE: &str = "/api/v1/sales/listings/{id}";
pub const SALES_INQUIRIES_PATH: &str = "/api/v1/sales/inquiries";
pub const SALES_INQUIRY_PATH_TEMPLATE: &str = "/api/v1/sales/inquiries/{id}";
pub const SALES_ROUTE_PATHS: &[&str] = &[
    STOREFRONT_LISTINGS_PATH,
    STOREFRONT_LISTING_PATH_TEMPLATE,
    STOREFRONT_INQUIRIES_PATH,
    SALES_LISTINGS_PATH,
    SALES_LISTING_PATH_TEMPLATE,
    SALES_INQUIRIES_PATH,
    SALES_INQUIRY_PATH_TEMPLATE,
];

// Generic bounds for the public inquiry edge. Defense-in-depth so the
// unauthenticated channel fails fast and generically; the store remains the
// source of truth. Counts trimmed Unicode scalars.
const MAX_INQUIRY_NAME_CHARS: usize = 100;
const MAX_INQUIRY_PHONE_CHARS: usize = 40;
const MAX_INQUIRY_LOCATION_CHARS: usize = 120;
const MAX_INQUIRY_MESSAGE_CHARS: usize = 2000;

// Catalog page bounds.
const DEFAULT_CATALOG_LIMIT: i64 = 24;
const MAX_CATALOG_LIMIT: i64 = 100;
const DEFAULT_INBOX_LIMIT: i64 = 50;
const MAX_INBOX_LIMIT: i64 = 100;

// ---------------------------------------------------------------------------
// Admin listing field bounds (migration 0043 CHECK constraints). Validated in
// the handler so an over-bound value is rejected with a 422 before the write,
// rather than surfacing as a raw DB CHECK violation (500). Text limits count
// trimmed Unicode scalars, matching the DB `char_length`.
// ---------------------------------------------------------------------------
const MODEL_NAME_MIN_CHARS: usize = 1;
const MODEL_NAME_MAX_CHARS: usize = 200;
const BADGE_MAX_CHARS: usize = 60;
const USAGE_LABEL_MAX_CHARS: usize = 80;
const CONDITION_LABEL_MAX_CHARS: usize = 80;
const AVAILABILITY_MAX_CHARS: usize = 80;
const LOCATION_MAX_CHARS: usize = 120;
const DESCRIPTION_MAX_CHARS: usize = 4000;
const MODEL_YEAR_MIN: i32 = 1980;
const MODEL_YEAR_MAX: i32 = 2100;

// ---------------------------------------------------------------------------
// Rate-limit constants for the unauthenticated public inquiry endpoint.
//
// Same DB-backed fixed-window scheme as the auth/support endpoints (shared
// `auth_rate_limit` table), with an inquiry-specific endpoint key so the
// buckets are isolated.
// ---------------------------------------------------------------------------
const RATE_LIMIT_WINDOW: Duration = Duration::minutes(1);
const RATE_LIMIT_PER_IP: i64 = 5;
const RATE_LIMIT_PER_DEVICE: i64 = 5;
const RATE_LIMIT_GLOBAL: i64 = 60;
const RATE_LIMIT_ENDPOINT: &str = "sales_inquiry";

#[derive(Clone)]
pub struct SalesRestState {
    store: PgSalesStore,
    jwt_verifier: Option<JwtVerifier>,
    /// Number of trusted reverse proxies in front of this service. Drives the
    /// `X-Forwarded-For` client-IP derivation in the inquiry rate limiter: the
    /// real client is the Nth-from-the-right XFF entry. Clamped to at least 1 so
    /// the spoofable left-most entry is never blindly trusted.
    trusted_proxy_count: usize,
}

impl SalesRestState {
    /// Construct with a default of one trusted proxy. Prefer
    /// [`SalesRestState::with_trusted_proxy_count`] when the deployment puts a
    /// known number of proxies in front of the service.
    #[must_use]
    pub fn new(store: PgSalesStore, jwt_verifier: Option<JwtVerifier>) -> Self {
        Self {
            store,
            jwt_verifier,
            trusted_proxy_count: 1,
        }
    }

    /// Set the number of trusted reverse proxies (from `MNT_TRUSTED_PROXY_COUNT`).
    /// A value of 0 is treated as 1.
    #[must_use]
    pub fn with_trusted_proxy_count(mut self, trusted_proxy_count: usize) -> Self {
        self.trusted_proxy_count = trusted_proxy_count.max(1);
        self
    }
}

pub fn router(state: SalesRestState) -> Router {
    let verifier = state.jwt_verifier.clone();
    let pool = state.store.pool().clone();
    // Authenticated admin routes — every handler resolves a Principal and gates
    // on the org-level SalesManage feature.
    let authed = Router::new()
        .route(SALES_LISTINGS_PATH, get(admin_list_listings).post(create))
        .route(
            SALES_LISTING_PATH_TEMPLATE,
            patch(update).delete(delete_listing),
        )
        .route(SALES_INQUIRIES_PATH, get(list_inquiries))
        .route(SALES_INQUIRY_PATH_TEMPLATE, patch(update_inquiry_status))
        .with_state(state.clone());
    let authed = mnt_platform_request_context::with_request_context(authed, verifier, pool);

    // Public storefront routes — no JWT required, but still need a tenant
    // context for the store. The public catalog always belongs to the KNL org.
    let public = Router::new()
        .route(STOREFRONT_LISTINGS_PATH, get(storefront_list_listings))
        .route(
            STOREFRONT_LISTING_PATH_TEMPLATE,
            get(storefront_get_listing),
        )
        .route(STOREFRONT_INQUIRIES_PATH, post(submit_inquiry))
        .with_state(state)
        .layer(axum::middleware::from_fn(
            |req: axum::extract::Request, next: axum::middleware::Next| async move {
                mnt_platform_request_context::scope_org(OrgId::knl(), next.run(req)).await
            },
        ));

    authed.merge(public)
}

// ---------------------------------------------------------------------------
// Request / response DTOs
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct CatalogFilter {
    kind: Option<ListingKind>,
    listing_type: Option<ListingType>,
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct InquiryInboxFilter {
    status: Option<InquiryStatus>,
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct SubmitInquiryRequest {
    name: String,
    phone: String,
    topic: InquiryTopic,
    #[serde(default)]
    location: Option<String>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    listing_id: Option<SalesListingId>,
}

#[derive(Debug, Deserialize)]
struct CreateListingRequest {
    kind: ListingKind,
    model_name: String,
    #[serde(default)]
    capacity_milli: Option<i64>,
    #[serde(default)]
    model_year: Option<i32>,
    #[serde(default)]
    usage_hours: Option<i32>,
    #[serde(default)]
    price_won: Option<i64>,
    #[serde(default)]
    badge: Option<String>,
    #[serde(default)]
    usage_label: Option<String>,
    #[serde(default)]
    condition_label: Option<String>,
    #[serde(default)]
    availability: Option<String>,
    #[serde(default)]
    location: Option<String>,
    #[serde(default)]
    description: Option<String>,
    listing_type: ListingType,
    status: ListingStatus,
    sort_weight: i32,
    #[serde(default)]
    equipment_id: Option<EquipmentId>,
}

#[derive(Debug, Deserialize)]
struct UpdateListingRequest {
    #[serde(default)]
    kind: Option<ListingKind>,
    #[serde(default)]
    model_name: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    capacity_milli: Option<Option<i64>>,
    #[serde(default, deserialize_with = "double_option")]
    model_year: Option<Option<i32>>,
    #[serde(default, deserialize_with = "double_option")]
    usage_hours: Option<Option<i32>>,
    #[serde(default, deserialize_with = "double_option")]
    price_won: Option<Option<i64>>,
    #[serde(default, deserialize_with = "double_option")]
    badge: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    usage_label: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    condition_label: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    availability: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    location: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    description: Option<Option<String>>,
    #[serde(default)]
    listing_type: Option<ListingType>,
    #[serde(default)]
    status: Option<ListingStatus>,
    #[serde(default)]
    sort_weight: Option<i32>,
    #[serde(default, deserialize_with = "double_option")]
    equipment_id: Option<Option<EquipmentId>>,
}

#[derive(Debug, Deserialize)]
struct UpdateInquiryStatusRequest {
    status: InquiryStatus,
}

#[derive(Debug, Serialize)]
struct CreateListingResponse {
    id: SalesListingId,
}

/// Inquiry acknowledgement. Deliberately minimal — no internal identifiers, no
/// echo of the PII lead fields.
#[derive(Debug, Serialize)]
struct InquiryAck {
    status: &'static str,
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

/// Distinguish "key absent" (leave unchanged) from "key present but null"
/// (clear the column) for nullable PATCH fields.
fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Deserialize::deserialize(deserializer).map(Some)
}

// ---------------------------------------------------------------------------
// Public storefront handlers (no JWT; scope_org(knl))
// ---------------------------------------------------------------------------

async fn storefront_list_listings(
    State(state): State<SalesRestState>,
    Query(filter): Query<CatalogFilter>,
) -> Result<Json<SalesListingPage>, RestError> {
    let page = state
        .store
        .list_listings(catalog_query(filter, false))
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(page))
}

async fn storefront_get_listing(
    State(state): State<SalesRestState>,
    Path(listing_id): Path<SalesListingId>,
) -> Result<Json<SalesListingView>, RestError> {
    let listing = state
        .store
        .get_listing(listing_id, false)
        .await
        .map_err(RestError::from_store)?
        .ok_or_else(|| RestError::from_kernel(KernelError::not_found("listing was not found")))?;
    Ok(Json(listing))
}

/// POST /api/v1/storefront/inquiries — public lead intake. Generic validation
/// (never echoes the value), server-generated id, and store errors mapped to a
/// stable generic shape. The name/phone/message are PII and are never logged.
async fn submit_inquiry(
    State(state): State<SalesRestState>,
    headers: HeaderMap,
    Json(body): Json<SubmitInquiryRequest>,
) -> Result<impl IntoResponse, RestError> {
    let now = OffsetDateTime::now_utc();
    rate_limit(&state.store, &headers, state.trusted_proxy_count, now).await?;

    // Generic validation: never echo a field value, never leak which field
    // failed beyond a coarse message.
    if body.name.trim().is_empty() || body.phone.trim().is_empty() {
        return Err(RestError::bad_request("request is missing required fields"));
    }
    if body.name.trim().chars().count() > MAX_INQUIRY_NAME_CHARS
        || body.phone.trim().chars().count() > MAX_INQUIRY_PHONE_CHARS
        || body
            .location
            .as_deref()
            .is_some_and(|value| value.trim().chars().count() > MAX_INQUIRY_LOCATION_CHARS)
        || body
            .message
            .as_deref()
            .is_some_and(|value| value.trim().chars().count() > MAX_INQUIRY_MESSAGE_CHARS)
    {
        return Err(RestError::bad_request("request failed validation"));
    }

    // Only link a listing_id that exists AND is publicly visible. A foreign or
    // non-public id is silently dropped (the inquiry is still recorded) rather
    // than rejected — and never reaches the DB to trigger an FK-violation 500.
    let listing_id = match body.listing_id {
        Some(id) => match state.store.get_listing(id, false).await {
            Ok(Some(_)) => Some(id),
            Ok(None) => None,
            // A DB error here is the store's problem to surface; map it to the
            // same stable generic shape the submit path uses below.
            Err(_) => return Err(RestError::internal("internal server error")),
        },
        None => None,
    };

    state
        .store
        .submit_inquiry(SubmitInquiryCommand {
            inquiry_id: CustomerInquiryId::new(),
            name: body.name,
            phone: body.phone,
            topic: body.topic,
            location: body.location,
            message: body.message,
            listing_id,
            trace: TraceContext::generate(),
            occurred_at: now,
        })
        .await
        .map_err(|err| {
            // Intake must not surface internal details (and must not log the PII
            // lead fields); map everything to a stable generic shape. A domain
            // validation error becomes a generic 400; any DB error is a generic
            // 500 (no raw sqlx string, no PII).
            match err {
                PgSalesError::Domain(kernel) if kernel.kind == ErrorKind::Validation => {
                    RestError::bad_request("request failed validation")
                }
                _ => RestError::internal("internal server error"),
            }
        })?;
    Ok((
        StatusCode::ACCEPTED,
        Json(InquiryAck { status: "received" }),
    ))
}

// ---------------------------------------------------------------------------
// Authenticated admin handlers (SalesManage)
// ---------------------------------------------------------------------------

async fn admin_list_listings(
    State(state): State<SalesRestState>,
    headers: HeaderMap,
    Query(filter): Query<CatalogFilter>,
) -> Result<Json<SalesListingPage>, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    authorize_sales_feature(&principal, Feature::SalesManage)?;
    let page = state
        .store
        .list_listings(catalog_query(filter, true))
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(page))
}

async fn create(
    State(state): State<SalesRestState>,
    headers: HeaderMap,
    Json(body): Json<CreateListingRequest>,
) -> Result<(StatusCode, Json<CreateListingResponse>), RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    authorize_sales_feature(&principal, Feature::SalesManage)?;

    validate_create_listing(&body)?;

    let listing_id = SalesListingId::new();
    let input = ListingInput {
        kind: body.kind,
        model_name: body.model_name,
        capacity_milli: body.capacity_milli,
        model_year: body.model_year,
        usage_hours: body.usage_hours,
        price_won: body.price_won,
        badge: body.badge,
        usage_label: body.usage_label,
        condition_label: body.condition_label,
        availability: body.availability,
        location: body.location,
        description: body.description,
        listing_type: body.listing_type,
        status: body.status,
        sort_weight: body.sort_weight,
        equipment_id: body.equipment_id,
    };
    state
        .store
        .create_listing(CreateListingCommand {
            actor: principal.user_id,
            listing_id,
            input,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok((
        StatusCode::CREATED,
        Json(CreateListingResponse { id: listing_id }),
    ))
}

async fn update(
    State(state): State<SalesRestState>,
    headers: HeaderMap,
    Path(listing_id): Path<SalesListingId>,
    Json(body): Json<UpdateListingRequest>,
) -> Result<StatusCode, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    authorize_sales_feature(&principal, Feature::SalesManage)?;

    validate_update_listing(&body)?;

    let fields = UpdateListingFields {
        kind: body.kind,
        model_name: body.model_name,
        capacity_milli: body.capacity_milli,
        model_year: body.model_year,
        usage_hours: body.usage_hours,
        price_won: body.price_won,
        badge: body.badge,
        usage_label: body.usage_label,
        condition_label: body.condition_label,
        availability: body.availability,
        location: body.location,
        description: body.description,
        listing_type: body.listing_type,
        status: body.status,
        sort_weight: body.sort_weight,
        equipment_id: body.equipment_id,
    };
    if fields.is_empty() {
        return Err(RestError::from_kernel(KernelError::validation(
            "no listing fields to update",
        )));
    }
    state
        .store
        .update_listing(UpdateListingCommand {
            actor: principal.user_id,
            listing_id,
            fields,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_listing(
    State(state): State<SalesRestState>,
    headers: HeaderMap,
    Path(listing_id): Path<SalesListingId>,
) -> Result<StatusCode, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    authorize_sales_feature(&principal, Feature::SalesManage)?;

    state
        .store
        .delete_listing(DeleteListingCommand {
            actor: principal.user_id,
            listing_id,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_inquiries(
    State(state): State<SalesRestState>,
    headers: HeaderMap,
    Query(filter): Query<InquiryInboxFilter>,
) -> Result<Json<CustomerInquiryPage>, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    authorize_sales_feature(&principal, Feature::SalesManage)?;
    let page = state
        .store
        .list_inquiries(inbox_query(filter))
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(page))
}

async fn update_inquiry_status(
    State(state): State<SalesRestState>,
    headers: HeaderMap,
    Path(inquiry_id): Path<CustomerInquiryId>,
    Json(body): Json<UpdateInquiryStatusRequest>,
) -> Result<StatusCode, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    authorize_sales_feature(&principal, Feature::SalesManage)?;

    state
        .store
        .update_inquiry_status(UpdateInquiryStatusCommand {
            actor: principal.user_id,
            inquiry_id,
            status: body.status,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Query normalization
// ---------------------------------------------------------------------------

fn catalog_query(filter: CatalogFilter, include_non_public: bool) -> CatalogQuery {
    CatalogQuery {
        kind: filter.kind,
        listing_type: filter.listing_type,
        include_non_public,
        limit: filter
            .limit
            .unwrap_or(DEFAULT_CATALOG_LIMIT)
            .clamp(1, MAX_CATALOG_LIMIT),
        offset: filter.offset.unwrap_or(0).max(0),
    }
}

fn inbox_query(filter: InquiryInboxFilter) -> InquiryInboxQuery {
    InquiryInboxQuery {
        status: filter.status,
        limit: filter
            .limit
            .unwrap_or(DEFAULT_INBOX_LIMIT)
            .clamp(1, MAX_INBOX_LIMIT),
        offset: filter.offset.unwrap_or(0).max(0),
    }
}

// ---------------------------------------------------------------------------
// Admin listing validation (migration 0043 bounds → 422 before the write)
// ---------------------------------------------------------------------------

/// Bound an optional integer to `[min, max]`, returning a 422 when out of range
/// so a present value never surfaces as a raw DB CHECK violation (500). Absent
/// values pass.
fn validate_int_range(
    value: Option<i64>,
    min: i64,
    max: i64,
    field: &str,
) -> Result<(), RestError> {
    if let Some(v) = value
        && !(min..=max).contains(&v)
    {
        return Err(RestError::from_kernel(KernelError::validation(format!(
            "{field} must be between {min} and {max}"
        ))));
    }
    Ok(())
}

/// Validate the create-listing body against the migration 0043 CHECKs, mapping
/// any out-of-bounds value to a 422 before the write.
fn validate_create_listing(body: &CreateListingRequest) -> Result<(), RestError> {
    let model_name = body.model_name.trim();
    if model_name.chars().count() < MODEL_NAME_MIN_CHARS {
        return Err(RestError::from_kernel(KernelError::validation(
            "model_name is required",
        )));
    }
    validate_bounded_text(model_name, MODEL_NAME_MAX_CHARS, "model_name")
        .map_err(RestError::from_kernel)?;
    validate_listing_text_bounds(
        body.badge.as_deref(),
        body.usage_label.as_deref(),
        body.condition_label.as_deref(),
        body.availability.as_deref(),
        body.location.as_deref(),
        body.description.as_deref(),
    )?;
    validate_int_range(body.price_won, 0, i64::MAX, "price_won")?;
    validate_int_range(body.capacity_milli, 1, i64::MAX, "capacity_milli")?;
    validate_int_range(
        body.model_year.map(i64::from),
        i64::from(MODEL_YEAR_MIN),
        i64::from(MODEL_YEAR_MAX),
        "model_year",
    )?;
    validate_int_range(body.usage_hours.map(i64::from), 0, i64::MAX, "usage_hours")?;
    Ok(())
}

/// Validate the present (`Some` / `Some(Some(_))`) fields on an update body
/// against the same migration 0043 CHECKs. Absent or explicit-null clears are
/// not bound (an explicit null clears a nullable column).
fn validate_update_listing(body: &UpdateListingRequest) -> Result<(), RestError> {
    if let Some(model_name) = &body.model_name {
        let trimmed = model_name.trim();
        if trimmed.chars().count() < MODEL_NAME_MIN_CHARS {
            return Err(RestError::from_kernel(KernelError::validation(
                "model_name is required",
            )));
        }
        validate_bounded_text(trimmed, MODEL_NAME_MAX_CHARS, "model_name")
            .map_err(RestError::from_kernel)?;
    }
    for (change, max, field) in [
        (&body.badge, BADGE_MAX_CHARS, "badge"),
        (&body.usage_label, USAGE_LABEL_MAX_CHARS, "usage_label"),
        (
            &body.condition_label,
            CONDITION_LABEL_MAX_CHARS,
            "condition_label",
        ),
        (&body.availability, AVAILABILITY_MAX_CHARS, "availability"),
        (&body.location, LOCATION_MAX_CHARS, "location"),
        (&body.description, DESCRIPTION_MAX_CHARS, "description"),
    ] {
        if let Some(Some(text)) = change {
            validate_bounded_text(text, max, field).map_err(RestError::from_kernel)?;
        }
    }
    if let Some(Some(price)) = body.price_won {
        validate_int_range(Some(price), 0, i64::MAX, "price_won")?;
    }
    if let Some(Some(capacity)) = body.capacity_milli {
        validate_int_range(Some(capacity), 1, i64::MAX, "capacity_milli")?;
    }
    if let Some(Some(year)) = body.model_year {
        validate_int_range(
            Some(i64::from(year)),
            i64::from(MODEL_YEAR_MIN),
            i64::from(MODEL_YEAR_MAX),
            "model_year",
        )?;
    }
    if let Some(Some(hours)) = body.usage_hours {
        validate_int_range(Some(i64::from(hours)), 0, i64::MAX, "usage_hours")?;
    }
    Ok(())
}

/// Bound the optional listing text fields shared by create/update against the
/// migration 0043 `char_length` CHECKs. Trims before counting Unicode scalars.
fn validate_listing_text_bounds(
    badge: Option<&str>,
    usage_label: Option<&str>,
    condition_label: Option<&str>,
    availability: Option<&str>,
    location: Option<&str>,
    description: Option<&str>,
) -> Result<(), RestError> {
    for (value, max, field) in [
        (badge, BADGE_MAX_CHARS, "badge"),
        (usage_label, USAGE_LABEL_MAX_CHARS, "usage_label"),
        (
            condition_label,
            CONDITION_LABEL_MAX_CHARS,
            "condition_label",
        ),
        (availability, AVAILABILITY_MAX_CHARS, "availability"),
        (location, LOCATION_MAX_CHARS, "location"),
        (description, DESCRIPTION_MAX_CHARS, "description"),
    ] {
        if let Some(text) = value {
            validate_bounded_text(text, max, field).map_err(RestError::from_kernel)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Rate limiter (same DB-backed fixed-window scheme as the auth/support edges)
//
// The window/bucket logic lives here; the actual counter UPSERT is delegated to
// the adapter (`PgSalesStore::increment_rate_bucket`) so the rate-limit SQL
// stays off this REST handler's audit surface, exactly as the support crate
// does.
// ---------------------------------------------------------------------------

async fn rate_limit(
    store: &PgSalesStore,
    headers: &HeaderMap,
    trusted_proxy_count: usize,
    now: OffsetDateTime,
) -> Result<(), RestError> {
    let window_start = floor_to_window(now);

    let mut buckets: Vec<(String, i64)> = Vec::with_capacity(3);
    if let Some(ip) = client_ip(headers, trusted_proxy_count) {
        buckets.push((format!("ip:{ip}"), RATE_LIMIT_PER_IP));
    }
    if let Some(device) = client_device_id(headers) {
        buckets.push((format!("dev:{device}"), RATE_LIMIT_PER_DEVICE));
    }
    buckets.push(("global".to_owned(), RATE_LIMIT_GLOBAL));

    for (client_key, cap) in buckets {
        let attempts = store
            .increment_rate_bucket(&client_key, RATE_LIMIT_ENDPOINT, window_start)
            .await
            .map_err(RestError::from_store)?;
        if attempts > cap {
            return Err(RestError::too_many_requests());
        }
    }
    Ok(())
}

fn floor_to_window(now: OffsetDateTime) -> OffsetDateTime {
    let window_secs = RATE_LIMIT_WINDOW.whole_seconds().max(1);
    let unix = now.unix_timestamp();
    let floored = unix - unix.rem_euclid(window_secs);
    OffsetDateTime::from_unix_timestamp(floored).unwrap_or(now)
}

/// Derive the rate-limit client IP from the proxy-set `X-Forwarded-For`.
///
/// XFF is appended left-to-right, so the RIGHTMOST entry is what the closest
/// trusted proxy observed and the left-most entries are attacker-spoofable. With
/// `trusted_proxy_count` proxies in front of this service the real client is the
/// Nth-from-the-right entry (index `len - trusted_proxy_count`); a shorter chain
/// clamps to the left-most available entry rather than underflowing. Used only as
/// an opaque rate-limit key; never logged. Mirrors the support/auth-rest fix.
fn client_ip(headers: &HeaderMap, trusted_proxy_count: usize) -> Option<String> {
    let forwarded = headers.get("x-forwarded-for")?.to_str().ok()?;
    let entries: Vec<&str> = forwarded
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .collect();
    if entries.is_empty() {
        return None;
    }
    let hops = trusted_proxy_count.max(1);
    let index = entries.len().saturating_sub(hops);
    entries.get(index).map(|ip| (*ip).to_owned())
}

/// Optional, client-controlled `X-Device-Id`; bounded length + restricted
/// charset. On rejection the caller falls back to per-IP limiting alone.
fn client_device_id(headers: &HeaderMap) -> Option<String> {
    let value = headers.get("x-device-id")?.to_str().ok()?.trim();
    if value.is_empty()
        || value.len() > 128
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return None;
    }
    Some(value.to_owned())
}

// ---------------------------------------------------------------------------
// Authz helpers
// ---------------------------------------------------------------------------

/// Authorize a deliberately **org-level** sales feature against a representative
/// branch: cross-branch principals authorize against a fresh id (allowed by
/// `BranchScope::All`); branch-scoped principals authorize against one of their
/// own branches. Because `authorize()` checks `branch_scope.allows` first, the
/// branch arg is a tautology for a branch-scoped caller — the feature matrix cell
/// is what actually decides.
///
/// This is correct because the sales catalog is org-level by design (no branch
/// scoping); a `SalesManage` holder manages the whole catalog. Mirrors the
/// registry equipment-master representative-branch shortcut.
fn authorize_sales_feature(principal: &Principal, feature: Feature) -> Result<(), RestError> {
    let branch = match &principal.branch_scope {
        BranchScope::All => BranchId::new(),
        BranchScope::Branches(branches) => branches.iter().next().copied().ok_or_else(|| {
            RestError::from_kernel(KernelError::forbidden(
                "principal has no branch scope for sales management",
            ))
        })?,
    };
    authorize(principal, Action::new(feature), branch).map_err(RestError::from_kernel)
}

fn principal_from_headers(
    state: &SalesRestState,
    headers: &HeaderMap,
) -> Result<Principal, RestError> {
    let verifier = state.jwt_verifier.as_ref().ok_or_else(|| {
        RestError::unavailable("JWT verification is not configured for sales API")
    })?;
    let token = bearer_token(headers)?;
    let claims = verifier
        .verify_access_token(token)
        .map_err(|_| RestError::unauthorized("invalid bearer token"))?;
    principal_from_claims(claims)
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

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

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

    fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "bad_request", message)
    }

    fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", message)
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "service_unavailable",
            message,
        )
    }

    fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", message)
    }

    fn too_many_requests() -> Self {
        Self::new(
            StatusCode::TOO_MANY_REQUESTS,
            "too_many_requests",
            "rate limit exceeded; retry later",
        )
    }

    fn from_kernel(error: KernelError) -> Self {
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
            ErrorKind::Internal => Self::internal(error.message),
        }
    }

    fn from_store(error: PgSalesError) -> Self {
        match error {
            // Domain errors carry safe, caller-facing messages.
            PgSalesError::Domain(kernel) => Self::from_kernel(kernel),
            // Db errors must never leak raw sqlx strings / constraint names
            // (schema disclosure, OWASP A05). Return a generic 500.
            PgSalesError::Db(_) => Self::internal("sales request failed"),
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
