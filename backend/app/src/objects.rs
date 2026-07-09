//! Generic object layer: cross-object links (BE-OBJ slice 1, stage 2) and the
//! object resolve endpoint (stage 3).
//!
//! `object_links` is the generic, org-scoped, audited edge store the design's
//! "related objects" / pin-A-to-B panels need. Links connect two known object
//! kinds (validated against the seeded `object_types` registry) and are
//! removable; every create/delete is audited via `with_audit`. Tenant isolation
//! is enforced by FORCE RLS on `object_links` keyed on `app.current_org`; the
//! `with_org_conn` / `with_audit` wrappers arm that GUC, so a cross-org read
//! returns nothing and a cross-org delete is a 404 (deny-by-omission).

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get};
use axum::{Extension, Json, Router};
use mnt_kernel_core::{AuditAction, AuditEvent, ErrorKind, KernelError, TraceContext};
use mnt_platform_auth::JwtVerifier;
use mnt_platform_authz::{Feature, PermissionLevel, Principal, permission_for};
use mnt_platform_db::{DbError, with_audit, with_audits, with_org_conn};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use time::OffsetDateTime;
use uuid::Uuid;

pub const OBJECT_LINKS_PATH: &str = "/api/v1/object-links";
pub const OBJECT_LINK_BY_ID_PATH_TEMPLATE: &str = "/api/v1/object-links/{id}";

pub const OBJECT_ROUTE_PATHS: &[&str] = &[OBJECT_LINKS_PATH, OBJECT_LINK_BY_ID_PATH_TEMPLATE];

const ID_MAX: usize = 200;

#[derive(Debug, Clone)]
pub struct ObjectState {
    pool: PgPool,
    jwt_verifier: Option<JwtVerifier>,
}

impl ObjectState {
    #[must_use]
    pub fn new(pool: PgPool, jwt_verifier: Option<JwtVerifier>) -> Self {
        Self { pool, jwt_verifier }
    }
}

pub fn router(state: ObjectState) -> Router {
    let verifier = state.jwt_verifier.clone();
    let pool = state.pool.clone();
    let router = Router::new()
        .route(
            OBJECT_LINKS_PATH,
            get(list_object_links).post(create_object_link),
        )
        .route(OBJECT_LINK_BY_ID_PATH_TEMPLATE, delete(delete_object_link))
        .with_state(state);
    mnt_platform_request_context::with_request_context(router, verifier, pool)
}

// ---------------------------------------------------------------------------
// Wire shapes.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct CreateObjectLinkRequest {
    src_kind: String,
    src_id: String,
    dst_kind: String,
    dst_id: String,
    link_type: String,
}

#[derive(Debug, Deserialize)]
struct ListObjectLinksQuery {
    kind: String,
    id: String,
}

#[derive(Debug, Serialize)]
struct ObjectLinkResponse {
    id: Uuid,
    src_kind: String,
    src_id: String,
    dst_kind: String,
    dst_id: String,
    link_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    created_by: Option<Uuid>,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
}

/// Links touching one object, in both directions: `outgoing` are edges where
/// the object is the source, `incoming` where it is the destination.
#[derive(Debug, Serialize)]
struct ObjectLinksListResponse {
    outgoing: Vec<ObjectLinkResponse>,
    incoming: Vec<ObjectLinkResponse>,
}

#[derive(Debug)]
struct NormalizedLink {
    src_kind: String,
    src_id: String,
    dst_kind: String,
    dst_id: String,
    link_type: String,
}

// ---------------------------------------------------------------------------
// Handlers.
// ---------------------------------------------------------------------------

async fn create_object_link(
    State(state): State<ObjectState>,
    Extension(principal): Extension<Principal>,
    Json(body): Json<CreateObjectLinkRequest>,
) -> Result<Json<ObjectLinkResponse>, ObjectError> {
    authorize_object_member(&principal)?;
    let link = normalize_link(body)?;
    let link_id = Uuid::new_v4();
    let org = principal.org_id;
    let actor = principal.user_id;
    let now = OffsetDateTime::now_utc();
    let audit_after = json!({
        "id": link_id,
        "src_kind": link.src_kind,
        "src_id": link.src_id,
        "dst_kind": link.dst_kind,
        "dst_id": link.dst_id,
        "link_type": link.link_type,
    });
    let audit_event = AuditEvent::new(
        Some(actor),
        AuditAction::new("object_link.create")?,
        "object_link",
        link_id.to_string(),
        TraceContext::generate(),
        now,
    )
    .with_org(org)
    .with_snapshots(None, Some(audit_after));

    let response = with_audit::<_, _, ObjectError>(&state.pool, audit_event, move |tx| {
        Box::pin(async move {
            // Both kinds must be known (clean 422 rather than a raw FK 500).
            ensure_kinds_exist(tx, &link.src_kind, &link.dst_kind).await?;
            let insert = sqlx::query(
                r#"
                INSERT INTO object_links (
                    id, org_id, src_kind, src_id, dst_kind, dst_id, link_type, created_by
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                RETURNING id, src_kind, src_id, dst_kind, dst_id, link_type,
                          created_by, created_at
                "#,
            )
            .bind(link_id)
            .bind(*org.as_uuid())
            .bind(&link.src_kind)
            .bind(&link.src_id)
            .bind(&link.dst_kind)
            .bind(&link.dst_id)
            .bind(&link.link_type)
            .bind(*actor.as_uuid())
            .fetch_one(tx.as_mut())
            .await;
            match insert {
                Ok(row) => object_link_from_row(&row),
                Err(err) if is_unique_violation(&err) => Err(ObjectError::conflict(
                    "an identical object link already exists",
                )),
                Err(err) => Err(ObjectError::from(err)),
            }
        })
    })
    .await?;
    Ok(Json(response))
}

async fn delete_object_link(
    State(state): State<ObjectState>,
    Extension(principal): Extension<Principal>,
    Path(link_id): Path<Uuid>,
) -> Result<StatusCode, ObjectError> {
    authorize_object_member(&principal)?;
    let org = principal.org_id;
    let actor = principal.user_id;
    let now = OffsetDateTime::now_utc();

    // The audit before-snapshot cannot be known until the row is loaded inside
    // the tx, so use with_audits (event computed in-transaction).
    with_audits::<_, (), ObjectError>(&state.pool, org, move |tx| {
        Box::pin(async move {
            // Load first (under armed RLS): unknown id OR another tenant's link
            // are indistinguishable — both 404, the deny-by-omission guarantee.
            let existing = sqlx::query(
                r#"
                SELECT id, src_kind, src_id, dst_kind, dst_id, link_type,
                       created_by, created_at
                FROM object_links
                WHERE id = $1
                "#,
            )
            .bind(link_id)
            .fetch_optional(tx.as_mut())
            .await?;
            let Some(row) = existing else {
                return Err(ObjectError::not_found("object link not found"));
            };
            let before = object_link_from_row(&row)?;
            sqlx::query("DELETE FROM object_links WHERE id = $1")
                .bind(link_id)
                .execute(tx.as_mut())
                .await?;
            let event = AuditEvent::new(
                Some(actor),
                AuditAction::new("object_link.delete")?,
                "object_link",
                link_id.to_string(),
                TraceContext::generate(),
                now,
            )
            .with_org(org)
            .with_snapshots(audit_delete_snapshot(&before), None);
            Ok(((), vec![event]))
        })
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_object_links(
    State(state): State<ObjectState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<ListObjectLinksQuery>,
) -> Result<Json<ObjectLinksListResponse>, ObjectError> {
    authorize_object_member(&principal)?;
    let kind = normalize_kind(&query.kind, "kind")?;
    let id = normalize_object_id(&query.id, "id")?;
    let org = principal.org_id;

    let response = with_org_conn::<_, _, ObjectError>(&state.pool, org, move |tx| {
        Box::pin(async move {
            let outgoing_rows = sqlx::query(
                r#"
                SELECT id, src_kind, src_id, dst_kind, dst_id, link_type,
                       created_by, created_at
                FROM object_links
                WHERE src_kind = $1 AND src_id = $2
                ORDER BY created_at DESC, id DESC
                "#,
            )
            .bind(&kind)
            .bind(&id)
            .fetch_all(tx.as_mut())
            .await?;
            let incoming_rows = sqlx::query(
                r#"
                SELECT id, src_kind, src_id, dst_kind, dst_id, link_type,
                       created_by, created_at
                FROM object_links
                WHERE dst_kind = $1 AND dst_id = $2
                ORDER BY created_at DESC, id DESC
                "#,
            )
            .bind(&kind)
            .bind(&id)
            .fetch_all(tx.as_mut())
            .await?;
            let outgoing = outgoing_rows
                .iter()
                .map(object_link_from_row)
                .collect::<Result<Vec<_>, _>>()?;
            let incoming = incoming_rows
                .iter()
                .map(object_link_from_row)
                .collect::<Result<Vec<_>, _>>()?;
            Ok(ObjectLinksListResponse { outgoing, incoming })
        })
    })
    .await?;
    Ok(Json(response))
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/// Confirm both link endpoints reference a seeded kind, inside the write tx so
/// the check and the insert are atomic. Runs on `tx.as_mut()` (armed), never a
/// bare pool.
async fn ensure_kinds_exist(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    src_kind: &str,
    dst_kind: &str,
) -> Result<(), ObjectError> {
    let found: i64 =
        sqlx::query_scalar("SELECT COUNT(DISTINCT kind) FROM object_types WHERE kind = ANY($1)")
            .bind(vec![src_kind.to_owned(), dst_kind.to_owned()])
            .fetch_one(tx.as_mut())
            .await?;
    // Distinct kinds requested: 1 if src==dst (rejected earlier), else 2.
    let expected = if src_kind == dst_kind { 1 } else { 2 };
    if found == expected {
        Ok(())
    } else {
        Err(ObjectError::validation(
            "src_kind and dst_kind must be known object kinds",
        ))
    }
}

fn normalize_link(body: CreateObjectLinkRequest) -> Result<NormalizedLink, ObjectError> {
    let src_kind = normalize_kind(&body.src_kind, "src_kind")?;
    let dst_kind = normalize_kind(&body.dst_kind, "dst_kind")?;
    let src_id = normalize_object_id(&body.src_id, "src_id")?;
    let dst_id = normalize_object_id(&body.dst_id, "dst_id")?;
    let link_type = normalize_kind(&body.link_type, "link_type")?;
    if src_kind == dst_kind && src_id == dst_id {
        return Err(ObjectError::validation(
            "an object cannot be linked to itself",
        ));
    }
    Ok(NormalizedLink {
        src_kind,
        src_id,
        dst_kind,
        dst_id,
        link_type,
    })
}

/// Slug validation matching the DB CHECK (`^[a-z][a-z0-9_]{1,63}$`): a leading
/// lowercase letter then 1..63 more of lowercase/digit/underscore.
fn normalize_kind(raw: &str, field: &'static str) -> Result<String, ObjectError> {
    let value = raw.trim().to_ascii_lowercase();
    let mut chars = value.chars();
    let leads = chars.next().is_some_and(|ch| ch.is_ascii_lowercase());
    let rest_ok = chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_');
    if leads && rest_ok && (2..=64).contains(&value.len()) {
        Ok(value)
    } else {
        Err(ObjectError::validation(format!(
            "{field} is not a valid kind"
        )))
    }
}

fn normalize_object_id(raw: &str, field: &'static str) -> Result<String, ObjectError> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(ObjectError::validation(format!("{field} is required")));
    }
    if value.chars().count() > ID_MAX {
        return Err(ObjectError::validation(format!(
            "{field} must be {ID_MAX} characters or less"
        )));
    }
    Ok(value.to_owned())
}

fn object_link_from_row(row: &sqlx::postgres::PgRow) -> Result<ObjectLinkResponse, ObjectError> {
    Ok(ObjectLinkResponse {
        id: row.try_get("id")?,
        src_kind: row.try_get("src_kind")?,
        src_id: row.try_get("src_id")?,
        dst_kind: row.try_get("dst_kind")?,
        dst_id: row.try_get("dst_id")?,
        link_type: row.try_get("link_type")?,
        created_by: row.try_get("created_by")?,
        created_at: row.try_get("created_at")?,
    })
}

fn audit_delete_snapshot(before: &ObjectLinkResponse) -> Option<Value> {
    Some(json!({
        "id": before.id,
        "src_kind": before.src_kind,
        "src_id": before.src_id,
        "dst_kind": before.dst_kind,
        "dst_id": before.dst_id,
        "link_type": before.link_type,
    }))
}

fn is_unique_violation(err: &sqlx::Error) -> bool {
    err.as_database_error().and_then(|db| db.code()).as_deref() == Some("23505")
}

fn authorize_object_member(principal: &Principal) -> Result<(), ObjectError> {
    let allowed_by_role = principal
        .roles
        .iter()
        .any(|role| permission_for(*role, Feature::Login) == PermissionLevel::Allow);
    let allowed_by_custom_grant = principal
        .effective_feature_grants
        .iter()
        .any(|grant| grant.feature == Feature::Login && grant.permission == PermissionLevel::Allow);
    if allowed_by_role || allowed_by_custom_grant {
        return Ok(());
    }
    Err(ObjectError::from_kernel(KernelError::forbidden(
        "object links require an authenticated tenant member",
    )))
}

// ---------------------------------------------------------------------------
// Error type (mirrors the collaboration module's shape).
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct ObjectError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl ObjectError {
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

    fn not_found(message: impl Into<String>) -> Self {
        Self::from_kernel(KernelError::not_found(message.into()))
    }

    fn conflict(message: impl Into<String>) -> Self {
        Self::from_kernel(KernelError::conflict(message.into()))
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "internal",
            message: message.into(),
        }
    }
}

impl From<KernelError> for ObjectError {
    fn from(error: KernelError) -> Self {
        Self::from_kernel(error)
    }
}

impl From<DbError> for ObjectError {
    fn from(value: DbError) -> Self {
        tracing::error!(error = %value, "object-layer database operation failed");
        Self::internal("object-layer request failed")
    }
}

impl From<sqlx::Error> for ObjectError {
    fn from(value: sqlx::Error) -> Self {
        Self::from(DbError::Sqlx(value))
    }
}

impl IntoResponse for ObjectError {
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

    #[test]
    fn rejects_self_link_and_bad_kinds() {
        let self_link = CreateObjectLinkRequest {
            src_kind: "work_order".into(),
            src_id: "wo-1".into(),
            dst_kind: "work_order".into(),
            dst_id: "wo-1".into(),
            link_type: "relates_to".into(),
        };
        assert!(normalize_link(self_link).is_err());

        assert!(normalize_kind("Work Order", "src_kind").is_err());
        assert!(normalize_kind("1bad", "src_kind").is_err());
        assert!(normalize_kind("work_order", "src_kind").is_ok());
        assert!(normalize_object_id("  ", "id").is_err());
    }
}
