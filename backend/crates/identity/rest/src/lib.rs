//! Identity / org-setup REST API.
//!
//! Authenticated, authz-gated endpoints for the org-setup flow:
//!   * Users  — `/api/v1/users` (create/list/get/update/deactivate) and the
//!     self-profile pair `/api/v1/users/me`.
//!   * Regions — `/api/v1/regions` (list/create) and `/api/v1/regions/{id}`
//!     (update/deactivate).
//!   * Branches — `/api/v1/branches` (list/create) and `/api/v1/branches/{id}`
//!     (update/deactivate); the list also backs support-ticket triage.
//!
//! Region/branch deactivation is a SOFT delete guarded against orphaning live
//! tenant data: deactivating a region with active branches, or a branch with
//! active users / non-terminal equipment, is refused with a 409.
//!
//! Authorization mirrors the IDOR-hardening in `issue_admin_otp`: creating or
//! promoting a user into EXECUTIVE/SUPER_ADMIN is restricted to SUPER_ADMIN
//! callers, and a sub-admin may only create non-privileged users in branches it
//! controls. Self-profile edits are open to every authenticated user.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::collections::BTreeSet;
use std::str::FromStr;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use mnt_identity_adapter_postgres::{PgOrgError, PgOrgStore};
use mnt_identity_application::{
    CreateBranchCommand, CreateRegionCommand, CreateUserCommand, DeactivateBranchCommand,
    DeactivateRegionCommand, DeactivateUserCommand, UpdateBranchCommand, UpdateRegionCommand,
    UpdateSelfProfileCommand, UpdateUserCommand, UserListQuery,
};
use mnt_identity_domain::Team;
use mnt_kernel_core::{
    AuditAction, AuditEvent, BranchId, BranchScope, ErrorKind, KernelError, OrgId, RegionId,
    TraceContext, UserId,
};
use mnt_platform_auth::{AccessClaims, JwtVerifier};
use mnt_platform_authz::{
    Action, Feature, Principal, Role, authorize, resolve_branch_scope_in_org,
};
use mnt_platform_db::{DbError, with_audits, with_org_conn};
use mnt_platform_request_context::{RequestContextError, current_org};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use time::OffsetDateTime;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Route paths (exported for the openapi_drift test)
// ---------------------------------------------------------------------------

pub const USERS_PATH: &str = "/api/v1/users";
pub const USERS_ME_PATH: &str = "/api/v1/users/me";
pub const USER_PATH_TEMPLATE: &str = "/api/v1/users/{id}";
pub const USER_DEACTIVATE_PATH_TEMPLATE: &str = "/api/v1/users/{id}/deactivate";
pub const REGIONS_PATH: &str = "/api/v1/regions";
pub const REGION_PATH_TEMPLATE: &str = "/api/v1/regions/{id}";
pub const BRANCHES_PATH: &str = "/api/v1/branches";
pub const BRANCH_PATH_TEMPLATE: &str = "/api/v1/branches/{id}";
pub const PASSKEYS_PATH: &str = "/api/v1/passkeys";
pub const PASSKEY_PATH_TEMPLATE: &str = "/api/v1/passkeys/{id}";
pub const IDENTITY_ROUTE_PATHS: &[&str] = &[
    USERS_PATH,
    USERS_ME_PATH,
    USER_PATH_TEMPLATE,
    USER_DEACTIVATE_PATH_TEMPLATE,
    REGIONS_PATH,
    REGION_PATH_TEMPLATE,
    BRANCHES_PATH,
    BRANCH_PATH_TEMPLATE,
    PASSKEYS_PATH,
    PASSKEY_PATH_TEMPLATE,
];

#[derive(Clone)]
pub struct IdentityRestState {
    store: PgOrgStore,
    jwt_verifier: Option<JwtVerifier>,
}

impl IdentityRestState {
    #[must_use]
    pub fn new(store: PgOrgStore, jwt_verifier: Option<JwtVerifier>) -> Self {
        Self {
            store,
            jwt_verifier,
        }
    }

    fn pool(&self) -> &PgPool {
        self.store.pool()
    }
}

pub fn router(state: IdentityRestState) -> Router {
    let verifier = state.jwt_verifier.clone();
    let pool = state.pool().clone();
    let router = Router::new()
        // `/users/me` MUST be registered before `/users/{id}` so the literal
        // segment wins over the path capture.
        .route(USERS_ME_PATH, get(get_me).patch(update_me))
        .route(USERS_PATH, get(list_users).post(create_user))
        .route(USER_PATH_TEMPLATE, get(get_user).patch(update_user))
        .route(USER_DEACTIVATE_PATH_TEMPLATE, post(deactivate_user))
        .route(REGIONS_PATH, get(list_regions).post(create_region))
        .route(
            REGION_PATH_TEMPLATE,
            patch(update_region).delete(deactivate_region),
        )
        .route(BRANCHES_PATH, get(list_branches).post(create_branch))
        .route(
            BRANCH_PATH_TEMPLATE,
            patch(update_branch).delete(deactivate_branch),
        )
        .route(PASSKEYS_PATH, get(list_passkeys))
        .route(PASSKEY_PATH_TEMPLATE, delete(delete_passkey))
        .with_state(state);
    // Per-request tenant context: resolves the Principal and arms `CURRENT_ORG`
    // for every authenticated route on this router, so adapter reads/writes run
    // scoped to the request's tenant.
    mnt_platform_request_context::with_request_context(router, verifier, pool)
}

// ---------------------------------------------------------------------------
// Request / response DTOs
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct CreateUserRequest {
    display_name: String,
    #[serde(default)]
    phone: Option<String>,
    #[serde(default)]
    team: Option<Team>,
    #[serde(default)]
    roles: Vec<String>,
    #[serde(default)]
    branch_ids: Vec<BranchId>,
}

#[derive(Debug, Deserialize)]
struct UpdateUserRequest {
    #[serde(default)]
    display_name: Option<String>,
    /// Present key (even `null`) updates the phone; absent leaves it unchanged.
    #[serde(default, deserialize_with = "deserialize_optional_field")]
    phone: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_optional_field")]
    team: Option<Option<Team>>,
    #[serde(default)]
    roles: Option<Vec<String>>,
    #[serde(default)]
    branch_ids: Option<Vec<BranchId>>,
}

#[derive(Debug, Deserialize)]
struct UpdateSelfRequest {
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_field")]
    phone: Option<Option<String>>,
}

#[derive(Debug, Deserialize)]
struct ListUsersRequest {
    #[serde(default)]
    include_inactive: bool,
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct CreateRegionRequest {
    name: String,
}

#[derive(Debug, Deserialize)]
struct CreateBranchRequest {
    region_id: RegionId,
    name: String,
}

#[derive(Debug, Deserialize)]
struct UpdateRegionRequest {
    #[serde(default)]
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UpdateBranchRequest {
    #[serde(default)]
    region_id: Option<RegionId>,
    #[serde(default)]
    name: Option<String>,
}

/// A passkey credential summary for the self-service management surface.
///
/// Deliberately carries NO secret material: never the `passkey_json` blob, the
/// public key, or the raw `credential_id`. Only the opaque row id (for the delete
/// route) and the registration / last-use timestamps are exposed.
#[derive(Debug, Serialize)]
struct PasskeySummary {
    id: Uuid,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    last_used_at: Option<OffsetDateTime>,
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

/// Deserialize a field so that a present-but-null JSON value maps to
/// `Some(None)` (clear), an absent field to `None` (leave unchanged), and a
/// present value to `Some(Some(value))` (set).
fn deserialize_optional_field<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Some(Option::<T>::deserialize(deserializer)?))
}

// ---------------------------------------------------------------------------
// User handlers
// ---------------------------------------------------------------------------

async fn create_user(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Json(body): Json<CreateUserRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let roles = parse_roles(&body.roles)?;
    authorize_user_write(&principal, &roles, &body.branch_ids)?;

    let summary = state
        .store
        .create_user(CreateUserCommand {
            actor: principal.user_id,
            display_name: body.display_name,
            phone: body.phone,
            team: body.team,
            roles: role_db_strings(&roles),
            branch_ids: body.branch_ids,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok((StatusCode::CREATED, Json(summary)))
}

async fn list_users(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Query(query): Query<ListUsersRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage(&principal, Feature::UserManage)?;
    let users = state
        .store
        .list_users(
            &principal.branch_scope,
            UserListQuery {
                include_inactive: query.include_inactive,
                limit: query.limit,
            },
        )
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(users))
}

async fn get_user(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Path(id): Path<uuid::Uuid>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage(&principal, Feature::UserManage)?;
    let summary = state
        .store
        .get_user(UserId::from_uuid(id), &principal.branch_scope)
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(summary))
}

async fn update_user(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Path(id): Path<uuid::Uuid>,
    Json(body): Json<UpdateUserRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let target_id = UserId::from_uuid(id);

    // Baseline: caller may manage users in their scope, and may only see/touch a
    // target within that scope (prevents cross-branch enumeration / IDOR).
    authorize_org_manage(&principal, Feature::UserManage)?;
    state
        .store
        .get_user(target_id, &principal.branch_scope)
        .await
        .map_err(RestError::from_store)?;

    // Role/branch escalation guard: the *new* role set and the *new* branch set
    // must both be within the caller's authority. Run whenever EITHER is being
    // changed — a request that sets only `branch_ids` (roles absent) must still
    // prove branch authority over every target branch, or a branch-scoped admin
    // could move a visible user into branches they do not control.
    let roles = match &body.roles {
        Some(raw) => Some(parse_roles(raw)?),
        None => None,
    };
    if roles.is_some() || body.branch_ids.is_some() {
        let effective_roles = roles.clone().unwrap_or_default();
        let target_branches = body.branch_ids.clone().unwrap_or_default();
        authorize_user_write(&principal, &effective_roles, &target_branches)?;
    }

    let summary = state
        .store
        .update_user(UpdateUserCommand {
            actor: principal.user_id,
            user_id: target_id,
            display_name: body.display_name,
            phone: body.phone,
            team: body.team,
            roles: roles.as_ref().map(role_db_strings),
            branch_ids: body.branch_ids,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(summary))
}

async fn deactivate_user(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Path(id): Path<uuid::Uuid>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let target_id = UserId::from_uuid(id);
    if target_id == principal.user_id {
        return Err(RestError::bad_request("cannot deactivate your own account"));
    }
    authorize_org_manage(&principal, Feature::UserManage)?;
    // Target must be within the caller's scope (IDOR).
    state
        .store
        .get_user(target_id, &principal.branch_scope)
        .await
        .map_err(RestError::from_store)?;
    let summary = state
        .store
        .deactivate_user(DeactivateUserCommand {
            actor: principal.user_id,
            user_id: target_id,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(summary))
}

// ---------------------------------------------------------------------------
// Self-profile handlers (any authenticated user)
// ---------------------------------------------------------------------------

async fn get_me(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    // A user can always read their own record regardless of branch scope.
    let summary = state
        .store
        .get_user(principal.user_id, &BranchScope::All)
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(summary))
}

async fn update_me(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Json(body): Json<UpdateSelfRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let summary = state
        .store
        .update_self_profile(UpdateSelfProfileCommand {
            user_id: principal.user_id,
            display_name: body.display_name,
            phone: body.phone,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(summary))
}

// ---------------------------------------------------------------------------
// Region handlers
// ---------------------------------------------------------------------------

async fn list_regions(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    // Any authenticated user may read the org tree (needed to populate pickers).
    authorize_org_manage(&principal, Feature::Login)?;
    let regions = state
        .store
        .list_regions()
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(regions))
}

async fn create_region(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Json(body): Json<CreateRegionRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage(&principal, Feature::RegionManage)?;
    let summary = state
        .store
        .create_region(CreateRegionCommand {
            actor: principal.user_id,
            name: body.name,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok((StatusCode::CREATED, Json(summary)))
}

/// Rename a region. Mirrors `update_branch`: same `RegionManage` authority as
/// `create_region`, org-armed + audited in the adapter, 404 on an unknown id.
async fn update_region(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Path(id): Path<uuid::Uuid>,
    Json(body): Json<UpdateRegionRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage(&principal, Feature::RegionManage)?;
    let summary = state
        .store
        .update_region(UpdateRegionCommand {
            actor: principal.user_id,
            region_id: RegionId::from_uuid(id),
            name: body.name,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(summary))
}

/// Soft-delete (deactivate) a region. The adapter refuses with a 409 while the
/// region still owns active branches (referential guard), so live tenant data is
/// never orphaned. 404 on an unknown id; audited.
async fn deactivate_region(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Path(id): Path<uuid::Uuid>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage(&principal, Feature::RegionManage)?;
    let summary = state
        .store
        .deactivate_region(DeactivateRegionCommand {
            actor: principal.user_id,
            region_id: RegionId::from_uuid(id),
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(summary))
}

// ---------------------------------------------------------------------------
// Branch handlers
// ---------------------------------------------------------------------------

async fn list_branches(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    // Any authenticated user may read the branch list (org pickers + support
    // triage). Branch-scoped data on the branches themselves is not sensitive.
    authorize_org_manage(&principal, Feature::Login)?;
    let branches = state
        .store
        .list_branches()
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(branches))
}

async fn create_branch(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Json(body): Json<CreateBranchRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage(&principal, Feature::BranchManage)?;
    let summary = state
        .store
        .create_branch(CreateBranchCommand {
            actor: principal.user_id,
            region_id: body.region_id,
            name: body.name,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok((StatusCode::CREATED, Json(summary)))
}

async fn update_branch(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Path(id): Path<uuid::Uuid>,
    Json(body): Json<UpdateBranchRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage(&principal, Feature::BranchManage)?;
    let summary = state
        .store
        .update_branch(UpdateBranchCommand {
            actor: principal.user_id,
            branch_id: BranchId::from_uuid(id),
            region_id: body.region_id,
            name: body.name,
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(summary))
}

/// Soft-delete (deactivate) a branch. The adapter refuses with a 409 while the
/// branch still has active users or non-terminal equipment (referential guard),
/// so live operational data is never orphaned. 404 on an unknown id; audited.
async fn deactivate_branch(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Path(id): Path<uuid::Uuid>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage(&principal, Feature::BranchManage)?;
    let summary = state
        .store
        .deactivate_branch(DeactivateBranchCommand {
            actor: principal.user_id,
            branch_id: BranchId::from_uuid(id),
            trace: TraceContext::generate(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(summary))
}

// ---------------------------------------------------------------------------
// Passkey self-management handlers (any authenticated user, OWN credentials)
// ---------------------------------------------------------------------------

/// List the AUTHENTICATED user's OWN passkey credentials.
///
/// Scoped to BOTH the caller (`principal.user_id`) AND the request's tenant: the
/// read runs inside `with_org_conn(.., current_org()?, ..)`, which arms the
/// `app.current_org` GUC so the FORCE-RLS `auth_webauthn_credentials` rows for
/// this org become visible to the non-owner `mnt_rt` role. The `WHERE user_id`
/// filter then narrows to the caller's own credentials. No secret material
/// (passkey_json / public key / credential_id) ever leaves this handler.
async fn list_passkeys(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    // Self-service surface: every authenticated user may manage its own passkeys.
    authorize_org_manage(&principal, Feature::Login)?;
    let org = current_org()?;
    let user_id = *principal.user_id.as_uuid();

    let summaries =
        with_org_conn::<_, Vec<PasskeySummary>, RestError>(state.pool(), org, move |tx| {
            Box::pin(async move {
                let rows = sqlx::query(
                    r#"
                SELECT id, created_at, last_used_at
                FROM auth_webauthn_credentials
                WHERE user_id = $1
                ORDER BY created_at
                "#,
                )
                .bind(user_id)
                .fetch_all(tx.as_mut())
                .await
                .map_err(DbError::Sqlx)?;

                rows.into_iter()
                    .map(|row| {
                        Ok(PasskeySummary {
                            id: row.try_get("id").map_err(DbError::Sqlx)?,
                            created_at: row.try_get("created_at").map_err(DbError::Sqlx)?,
                            last_used_at: row.try_get("last_used_at").map_err(DbError::Sqlx)?,
                        })
                    })
                    .collect::<Result<Vec<_>, RestError>>()
            })
        })
        .await?;

    Ok(Json(summaries))
}

/// Revoke ONE of the authenticated user's OWN passkey credentials.
///
/// IDOR guard: the DELETE is constrained to `id = $1 AND user_id = $2`, so a user
/// can never delete another user's credential even within the same org; a
/// credential that is not the caller's own matches zero rows and yields 404.
///
/// Lockout guard: refuses to delete the caller's LAST remaining passkey. A user
/// whose only login method is a single passkey would otherwise lock themselves
/// out; deleting it returns 409 with a clear message. (A fresh sign-in OTP can
/// only be minted by an admin, so the floor is enforced here rather than relying
/// on a self-service recovery path.)
///
/// The whole operation runs in ONE tenant-armed transaction via `with_audits`:
/// the count check, the ownership-scoped DELETE, and the audit row commit (or roll
/// back) atomically together.
async fn delete_passkey(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage(&principal, Feature::Login)?;
    let org = current_org()?;
    let actor = principal.user_id;
    let user_id = *actor.as_uuid();
    let now = OffsetDateTime::now_utc();

    with_audits::<_, (), RestError>(state.pool(), org, move |tx| {
        Box::pin(async move {
            // Count the caller's own credentials INSIDE the tenant-armed tx so the
            // last-passkey floor is computed against the same RLS-scoped view the
            // DELETE acts on.
            let total: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM auth_webauthn_credentials WHERE user_id = $1",
            )
            .bind(user_id)
            .fetch_one(tx.as_mut())
            .await
            .map_err(DbError::Sqlx)?;

            // Ownership-scoped delete (IDOR guard): only the caller's OWN row by id
            // can be removed. A non-matching id (unknown, or another user's) returns
            // zero rows -> 404.
            let credential_id: Option<String> = sqlx::query_scalar(
                r#"
                SELECT credential_id
                FROM auth_webauthn_credentials
                WHERE id = $1 AND user_id = $2
                "#,
            )
            .bind(id)
            .bind(user_id)
            .fetch_optional(tx.as_mut())
            .await
            .map_err(DbError::Sqlx)?;

            let Some(credential_id) = credential_id else {
                return Err(RestError::new(
                    StatusCode::NOT_FOUND,
                    "not_found",
                    "passkey not found",
                ));
            };

            // Lockout floor: never remove the caller's only login method.
            if total <= 1 {
                return Err(RestError::new(
                    StatusCode::CONFLICT,
                    "conflict",
                    "cannot delete your last passkey; register another first",
                ));
            }

            sqlx::query("DELETE FROM auth_webauthn_credentials WHERE id = $1 AND user_id = $2")
                .bind(id)
                .bind(user_id)
                .execute(tx.as_mut())
                .await
                .map_err(DbError::Sqlx)?;

            let event = AuditEvent::new(
                Some(actor),
                AuditAction::new("auth.passkey.revoke")
                    .map_err(|err| RestError::internal(err.to_string()))?,
                "auth_webauthn_credential",
                id.to_string(),
                TraceContext::generate(),
                now,
            )
            .with_org(org)
            .with_snapshots(
                Some(serde_json::json!({
                    "credential_id": credential_id,
                    "user_id": user_id,
                })),
                None,
            );

            Ok(((), vec![event]))
        })
    })
    .await?;

    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Authz helpers
// ---------------------------------------------------------------------------

/// Authorize an org-management feature against a representative in-scope branch.
/// Cross-branch principals authorize against a fresh branch id (allowed by
/// `BranchScope::All`); branch-scoped principals authorize against one of their
/// own branches, which they always allow — the feature matrix then decides.
fn authorize_org_manage(principal: &Principal, feature: Feature) -> Result<(), RestError> {
    let branch = representative_branch(&principal.branch_scope)?;
    authorize(principal, Action::new(feature), branch).map_err(RestError::from_kernel)
}

/// Authorize a user create/update for a given target role set and target
/// branches, mirroring the `issue_admin_otp` IDOR hardening:
///   * Granting EXECUTIVE/SUPER_ADMIN requires `ElevatedRoleGrant` (SUPER_ADMIN).
///   * Otherwise the caller needs `SubordinateUserCreate` (limited) in EVERY
///     target branch, so a branch-scoped admin cannot mint users elsewhere.
fn authorize_user_write(
    principal: &Principal,
    roles: &BTreeSet<Role>,
    target_branches: &[BranchId],
) -> Result<(), RestError> {
    // Baseline user-management authority.
    authorize_org_manage(principal, Feature::UserManage)?;

    let grants_privileged = roles
        .iter()
        .any(|role| matches!(role, Role::Executive | Role::SuperAdmin));
    if grants_privileged {
        // Only SUPER_ADMIN holds ElevatedRoleGrant; checked org-globally.
        let branch = representative_branch(&principal.branch_scope)?;
        return authorize(principal, Action::new(Feature::ElevatedRoleGrant), branch)
            .map_err(|_| RestError::forbidden("not allowed to grant elevated roles"));
    }

    // Non-privileged user: cross-branch principals are already covered by the
    // UserManage check above; branch-scoped principals must additionally hold
    // SubordinateUserCreate in every branch the new user will belong to.
    if matches!(principal.branch_scope, BranchScope::All) {
        return Ok(());
    }
    for branch_id in target_branches {
        authorize(
            principal,
            Action::limited(Feature::SubordinateUserCreate),
            *branch_id,
        )
        .map_err(|_| RestError::forbidden("not allowed to create users in that branch"))?;
    }
    Ok(())
}

fn representative_branch(branch_scope: &BranchScope) -> Result<BranchId, RestError> {
    match branch_scope {
        BranchScope::All => Ok(BranchId::new()),
        BranchScope::Branches(branches) => branches.iter().next().copied().ok_or_else(|| {
            RestError::from_kernel(KernelError::forbidden(
                "principal has no branch scope for org management",
            ))
        }),
    }
}

/// Parse and validate role strings against the authz matrix. Empty role sets are
/// permitted (a user with no roles still exists and can sign in via Login only
/// once roles are added).
fn parse_roles(raw: &[String]) -> Result<BTreeSet<Role>, RestError> {
    raw.iter()
        .map(|role| {
            Role::from_str(role)
                .map_err(|_| RestError::validation(format!("unknown role {role:?}")))
        })
        .collect()
}

fn role_db_strings(roles: &BTreeSet<Role>) -> Vec<String> {
    roles.iter().map(|role| role.as_str().to_owned()).collect()
}

// ---------------------------------------------------------------------------
// Principal extraction
// ---------------------------------------------------------------------------

async fn principal_from_headers(
    state: &IdentityRestState,
    headers: &HeaderMap,
) -> Result<Principal, RestError> {
    let verifier = state.jwt_verifier.as_ref().ok_or_else(|| {
        RestError::unavailable("JWT verification is not configured for identity API")
    })?;
    let token = bearer_token(headers)?;
    let claims = verifier
        .verify_access_token(token)
        .map_err(|_| RestError::unauthorized("invalid bearer token"))?;
    principal_from_claims(state.pool(), claims).await
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

async fn principal_from_claims(
    pool: &PgPool,
    claims: AccessClaims,
) -> Result<Principal, RestError> {
    let user_id = UserId::from_str(&claims.sub)
        .map_err(|_| RestError::unauthorized("token subject is not a valid user id"))?;
    let roles = claims
        .roles
        .iter()
        .map(|role| {
            Role::from_str(role)
                .map_err(|_| RestError::unauthorized("token contains an unknown role"))
        })
        .collect::<Result<BTreeSet<_>, _>>()?;
    let role_vec = roles.iter().copied().collect::<Vec<_>>();
    let org_id = OrgId::from_str(&claims.org)
        .map_err(|_| RestError::unauthorized("token contains an invalid org id"))?;
    // Re-resolve the live branch scope from the database rather than trusting the
    // token's `branches` claim, so a membership revocation takes effect at once.
    // Arm the verified-token org explicitly: this path resolves the principal and
    // may run before the per-request tenant middleware has set CURRENT_ORG.
    let branch_scope = resolve_branch_scope_in_org(pool, org_id, user_id, &role_vec)
        .await
        .map_err(|err| RestError::internal(err.to_string()))?;

    Ok(Principal::new(user_id, org_id, roles, branch_scope))
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

    fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, "forbidden", message)
    }

    fn validation(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNPROCESSABLE_ENTITY, "validation", message)
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

    fn from_kernel(error: KernelError) -> Self {
        match error.kind {
            ErrorKind::Validation => Self::validation(error.message),
            ErrorKind::Forbidden => Self::forbidden(error.message),
            ErrorKind::NotFound => Self::new(StatusCode::NOT_FOUND, "not_found", error.message),
            ErrorKind::Conflict | ErrorKind::InvalidTransition => {
                Self::new(StatusCode::CONFLICT, "conflict", error.message)
            }
            ErrorKind::Internal => Self::internal(error.message),
        }
    }

    fn from_store(error: PgOrgError) -> Self {
        match error {
            // Domain errors carry safe, caller-facing messages.
            PgOrgError::Domain(kernel) => Self::from_kernel(kernel),
            // Db errors must never leak raw sqlx strings / constraint names
            // (schema disclosure, OWASP A05). Log server-side; return generic.
            db_error => {
                let kind = db_error.kind();
                tracing::error!(error = %db_error, "identity database error");
                match kind {
                    ErrorKind::NotFound => {
                        Self::new(StatusCode::NOT_FOUND, "not_found", "resource not found")
                    }
                    ErrorKind::Conflict | ErrorKind::InvalidTransition => {
                        Self::new(StatusCode::CONFLICT, "conflict", "resource already exists")
                    }
                    ErrorKind::Validation => {
                        Self::validation("request references an unknown region or branch")
                    }
                    _ => Self::internal("internal server error"),
                }
            }
        }
    }
}

/// A bare `DbError` surfaced from a `with_org_conn`/`with_audits` closure (the
/// passkey self-management reads/writes) is an internal failure: it must never
/// leak a raw sqlx string / constraint name to the caller (schema disclosure,
/// OWASP A05). Log server-side and return a generic 500.
impl From<DbError> for RestError {
    fn from(error: DbError) -> Self {
        tracing::error!(error = %error, "identity passkey database error");
        Self::internal("internal server error")
    }
}

/// A missing/invalid request context at a tenant-scoped data-access site is an
/// internal invariant violation (the request reached a tenant read without an
/// armed org). It never produces tenant data, so it maps to a generic 500.
impl From<RequestContextError> for RestError {
    fn from(error: RequestContextError) -> Self {
        tracing::error!(error = %error, "identity request context error");
        Self::internal("internal server error")
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
