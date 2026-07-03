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
//! newly promoting a user into EXECUTIVE/SUPER_ADMIN is restricted to
//! SUPER_ADMIN callers, and a sub-admin may only create non-privileged users in
//! branches it controls. Self-profile edits are open to every authenticated
//! user.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::collections::BTreeSet;
use std::str::FromStr;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use axum::{Json, Router};
use mnt_identity_adapter_postgres::{PgOrgError, PgOrgStore};
use mnt_identity_application::{
    CreateBranchCommand, CreatePolicyAssignmentPreviewReceiptCommand, CreatePolicyRoleCommand,
    CreateRegionCommand, CreateUserCommand, DeactivateBranchCommand, DeactivateRegionCommand,
    DeactivateUserCommand, PolicyAuditEventSummary, PolicyRoleAssignmentSummary,
    PolicyRoleCondition, PolicyRolePermission, PolicyRoleSummary, PolicyVersionSummary,
    ReplacePolicyRoleAssignmentsCommand, UpdateBranchCommand, UpdatePolicyRoleCommand,
    UpdatePolicyRoleStatusCommand, UpdateRegionCommand, UpdateSelfProfileCommand,
    UpdateUserCommand, UserListQuery, UserSummary,
};
use mnt_identity_domain::Team;
use mnt_kernel_core::{
    AuditAction, AuditEvent, BranchId, BranchScope, ErrorKind, KernelError, RegionId, TraceContext,
    UserId,
};
use mnt_platform_auth::{JwtVerifier, PasskeyAuthenticationCredential, PasskeyService};
use mnt_platform_authz::{
    Action, Feature, PermissionLevel, Principal, Role, authorize, permission_for,
};
use mnt_platform_db::{DbError, with_audits, with_org_conn};
use mnt_platform_request_context::{RequestContextError, current_org};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use time::{Duration, OffsetDateTime};
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
pub const POLICY_FEATURES_PATH: &str = "/api/v1/policy/features";
pub const POLICY_ROLES_PATH: &str = "/api/v1/policy/roles";
pub const POLICY_ROLE_PATH_TEMPLATE: &str = "/api/v1/policy/roles/{id}";
pub const POLICY_ROLE_STATUS_PATH_TEMPLATE: &str = "/api/v1/policy/roles/{id}/status";
pub const POLICY_ROLE_STATUS_PREVIEW_PATH_TEMPLATE: &str =
    "/api/v1/policy/roles/{id}/status-preview";
pub const POLICY_ROLE_TEMPLATES_PATH: &str = "/api/v1/policy/role-templates";
pub const POLICY_ASSIGNMENTS_PATH: &str = "/api/v1/policy/assignments";
pub const POLICY_USER_ASSIGNMENTS_PATH_TEMPLATE: &str = "/api/v1/policy/users/{id}/assignments";
pub const POLICY_USER_ASSIGNMENT_PREVIEW_PATH_TEMPLATE: &str =
    "/api/v1/policy/users/{id}/assignment-preview";
pub const POLICY_AUDIT_EVENTS_PATH: &str = "/api/v1/policy/audit-events";
const POLICY_STUDIO_OPERATION_TOTAL: &str = "policy_studio_operation_total";
const POLICY_ASSIGNMENT_PREVIEW_RECEIPT_TTL: Duration = Duration::minutes(10);

fn record_policy_studio_operation(operation: &'static str, outcome: &'static str) {
    metrics::counter!(
        POLICY_STUDIO_OPERATION_TOTAL,
        "operation" => operation,
        "outcome" => outcome,
    )
    .increment(1);
}

fn policy_branch_scope_label(scope: &BranchScope) -> &'static str {
    match scope {
        BranchScope::All => "all",
        BranchScope::Branches(branches) if branches.is_empty() => "none",
        BranchScope::Branches(_) => "branches",
    }
}

fn record_policy_studio_rejection(
    operation: &'static str,
    principal: &Principal,
    error: &RestError,
) {
    let outcome = if error.status == StatusCode::FORBIDDEN {
        "denied"
    } else {
        "invalid"
    };
    record_policy_studio_operation(operation, outcome);
    tracing::warn!(
        event = "policy_studio_operation_rejected",
        operation,
        outcome,
        error_code = error.code,
        actor_user_id = %principal.user_id,
        branch_scope = policy_branch_scope_label(&principal.branch_scope),
        "policy studio operation rejected"
    );
}

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
    POLICY_FEATURES_PATH,
    POLICY_ROLES_PATH,
    POLICY_ROLE_PATH_TEMPLATE,
    POLICY_ROLE_STATUS_PATH_TEMPLATE,
    POLICY_ROLE_STATUS_PREVIEW_PATH_TEMPLATE,
    POLICY_ROLE_TEMPLATES_PATH,
    POLICY_ASSIGNMENTS_PATH,
    POLICY_USER_ASSIGNMENTS_PATH_TEMPLATE,
    POLICY_USER_ASSIGNMENT_PREVIEW_PATH_TEMPLATE,
    POLICY_AUDIT_EVENTS_PATH,
];

#[derive(Clone)]
pub struct IdentityRestState {
    store: PgOrgStore,
    jwt_verifier: Option<JwtVerifier>,
    passkey_step_up: Option<PasskeyService>,
}

impl IdentityRestState {
    #[must_use]
    pub fn new(store: PgOrgStore, jwt_verifier: Option<JwtVerifier>) -> Self {
        Self {
            store,
            jwt_verifier,
            passkey_step_up: None,
        }
    }

    #[must_use]
    pub fn with_passkey_step_up(mut self, passkey_step_up: Option<PasskeyService>) -> Self {
        self.passkey_step_up = passkey_step_up;
        self
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
        .route(POLICY_FEATURES_PATH, get(list_policy_features))
        .route(
            POLICY_ROLES_PATH,
            get(list_policy_roles).post(create_policy_role),
        )
        .route(POLICY_ROLE_PATH_TEMPLATE, patch(update_policy_role))
        .route(
            POLICY_ROLE_STATUS_PATH_TEMPLATE,
            patch(update_policy_role_status),
        )
        .route(
            POLICY_ROLE_STATUS_PREVIEW_PATH_TEMPLATE,
            post(preview_policy_role_status),
        )
        .route(POLICY_ROLE_TEMPLATES_PATH, get(list_policy_role_templates))
        .route(POLICY_AUDIT_EVENTS_PATH, get(list_policy_audit_events))
        .route(POLICY_ASSIGNMENTS_PATH, get(list_policy_assignments))
        .route(
            POLICY_USER_ASSIGNMENTS_PATH_TEMPLATE,
            put(replace_policy_assignments),
        )
        .route(
            POLICY_USER_ASSIGNMENT_PREVIEW_PATH_TEMPLATE,
            post(preview_policy_assignments),
        )
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
    employee_id: Option<uuid::Uuid>,
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
    /// Present key (even `null`) updates the employee link; absent leaves it unchanged.
    #[serde(default, deserialize_with = "deserialize_optional_field")]
    employee_id: Option<Option<uuid::Uuid>>,
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
    /// Zero-based row offset for offset pagination. Optional, defaults to 0.
    offset: Option<i64>,
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
struct PolicyFeatureResponse {
    feature_key: String,
    elevated: bool,
    default_permissions: Vec<PolicyDefaultPermissionResponse>,
}

#[derive(Debug, Serialize)]
struct PolicyDefaultPermissionResponse {
    role_key: String,
    permission_level: String,
}

#[derive(Debug, Serialize)]
struct PolicyRoleCatalogResponse {
    policy_version: PolicyVersionResponse,
    system_roles: Vec<SystemPolicyRoleResponse>,
    custom_roles: Vec<PolicyRoleResponse>,
}

#[derive(Debug, Serialize)]
struct PolicyVersionResponse {
    version: i64,
    #[serde(with = "time::serde::rfc3339::option")]
    updated_at: Option<OffsetDateTime>,
}

#[derive(Debug, Deserialize)]
struct PolicyAuditEventsQuery {
    limit: Option<i64>,
}

#[derive(Debug, Serialize)]
struct PolicyAuditEventResponse {
    id: Uuid,
    actor: Option<Uuid>,
    action: String,
    target_type: String,
    target_id: String,
    before_snapshot: Option<serde_json::Value>,
    after_snapshot: Option<serde_json::Value>,
    trace_id: String,
    span_id: String,
    #[serde(with = "time::serde::rfc3339")]
    occurred_at: OffsetDateTime,
}

#[derive(Debug, Serialize)]
struct SystemPolicyRoleResponse {
    role_key: String,
    display_name: String,
    status: String,
    is_system: bool,
    permissions: Vec<PolicyPermissionResponse>,
}

#[derive(Debug, Serialize)]
struct PolicyRoleResponse {
    id: Uuid,
    role_key: String,
    display_name: String,
    description: Option<String>,
    status: String,
    is_system: bool,
    permissions: Vec<PolicyPermissionResponse>,
    conditions: Vec<PolicyConditionResponse>,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    updated_at: OffsetDateTime,
}

#[derive(Debug, Serialize)]
struct PolicyRoleStatusPreviewResponse {
    role_id: Uuid,
    role_key: String,
    display_name: String,
    current_status: String,
    requested_status: String,
    permission_count: i64,
    condition_count: i64,
    planned_assignment_count: i64,
    requires_passkey_step_up: bool,
    effective_runtime_change: bool,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct PolicyPermissionResponse {
    feature_key: String,
    permission_level: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct PolicyConditionResponse {
    condition_key: String,
    attribute: String,
    operator: String,
    values: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct CreatePolicyRoleRequest {
    role_key: String,
    display_name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    permissions: Vec<PolicyPermissionResponse>,
    #[serde(default)]
    conditions: Vec<PolicyConditionResponse>,
}

#[derive(Debug, Deserialize)]
struct UpdatePolicyRoleRequest {
    display_name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    permissions: Vec<PolicyPermissionResponse>,
    #[serde(default)]
    conditions: Vec<PolicyConditionResponse>,
    #[serde(default)]
    step_up: Option<PolicyStepUpAssertionRequest>,
}

#[derive(Debug, Deserialize)]
struct PolicyStepUpAssertionRequest {
    ceremony_id: Uuid,
    credential: PasskeyAuthenticationCredential,
}

#[derive(Debug, Deserialize)]
struct UpdatePolicyRoleStatusRequest {
    status: String,
    #[serde(default)]
    step_up: Option<PolicyStepUpAssertionRequest>,
}

#[derive(Debug, Deserialize)]
struct PolicyRoleStatusPreviewRequest {
    status: String,
}

#[derive(Debug, Serialize)]
struct PolicyRoleTemplateResponse {
    template_key: String,
    role_key: String,
    display_name: String,
    category: String,
    description: String,
    permissions: Vec<PolicyPermissionResponse>,
}

#[derive(Debug, Deserialize)]
struct ListPolicyAssignmentsRequest {
    user_id: Option<Uuid>,
}

#[derive(Debug, Serialize)]
struct PolicyRoleAssignmentResponse {
    user_id: Uuid,
    role_id: Uuid,
    role_key: String,
    display_name: String,
    status: String,
    assigned_by: Option<Uuid>,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
}

#[derive(Debug, Deserialize)]
struct ReplacePolicyRoleAssignmentsRequest {
    #[serde(default)]
    role_ids: Vec<Uuid>,
    #[serde(default)]
    preview_acknowledged: bool,
    #[serde(default)]
    preview_receipt_id: Option<Uuid>,
    #[serde(default)]
    step_up: Option<PolicyStepUpAssertionRequest>,
}

#[derive(Debug, Serialize)]
struct PolicyRoleAssignmentDeltaResponse {
    added_role_ids: Vec<Uuid>,
    removed_role_ids: Vec<Uuid>,
    unchanged_role_ids: Vec<Uuid>,
}

#[derive(Debug, Serialize)]
struct PolicyRoleImpactResponse {
    role_id: Uuid,
    role_key: String,
    display_name: String,
    status: String,
    runtime_effective: bool,
    runtime_warnings: Vec<String>,
    conditions: Vec<PolicyConditionResponse>,
}

#[derive(Debug, Serialize)]
struct PolicyFeatureGrantPreviewResponse {
    feature_key: String,
    permission_level: String,
    source_type: String,
    source_key: String,
    source_label: String,
}

#[derive(Debug, Serialize)]
struct PolicyAssignmentPreviewResponse {
    user_id: Uuid,
    preview_receipt_id: Uuid,
    #[serde(with = "time::serde::rfc3339")]
    preview_receipt_expires_at: OffsetDateTime,
    effective: bool,
    system_roles: Vec<String>,
    current_role_ids: Vec<Uuid>,
    requested_role_ids: Vec<Uuid>,
    delta: PolicyRoleAssignmentDeltaResponse,
    custom_roles: Vec<PolicyRoleImpactResponse>,
    feature_grants: Vec<PolicyFeatureGrantPreviewResponse>,
    warnings: Vec<String>,
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
// Policy Studio handlers (G016-P0)
// ---------------------------------------------------------------------------

async fn list_policy_features(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage(&principal, Feature::RoleManage)?;
    let catalog = policy_feature_catalog();
    record_policy_studio_operation("list_features", "success");
    tracing::info!(
        event = "policy_studio_features_listed",
        operation = "list_features",
        outcome = "success",
        actor_user_id = %principal.user_id,
        feature_count = catalog.len(),
        branch_scope = policy_branch_scope_label(&principal.branch_scope),
        "policy studio features listed"
    );
    Ok(Json(catalog))
}

async fn list_policy_roles(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage(&principal, Feature::RoleManage)?;
    let custom_roles = state
        .store
        .list_policy_roles()
        .await
        .map_err(RestError::from_store)?
        .into_iter()
        .filter(|role| policy_role_is_inside_delegated_authority(&principal, role))
        .map(PolicyRoleResponse::from)
        .collect::<Vec<_>>();
    let policy_version = state
        .store
        .get_policy_version()
        .await
        .map_err(RestError::from_store)?;
    let system_roles = system_policy_roles();
    record_policy_studio_operation("list_roles", "success");
    tracing::info!(
        event = "policy_studio_roles_listed",
        operation = "list_roles",
        outcome = "success",
        actor_user_id = %principal.user_id,
        custom_role_count = custom_roles.len(),
        system_role_count = system_roles.len(),
        policy_version = policy_version.version,
        branch_scope = policy_branch_scope_label(&principal.branch_scope),
        "policy studio roles listed"
    );
    Ok(Json(PolicyRoleCatalogResponse {
        policy_version: policy_version.into(),
        system_roles,
        custom_roles,
    }))
}

async fn list_policy_role_templates(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage(&principal, Feature::RoleManage)?;
    let templates = policy_role_templates();
    record_policy_studio_operation("list_templates", "success");
    tracing::info!(
        event = "policy_studio_templates_listed",
        operation = "list_templates",
        outcome = "success",
        actor_user_id = %principal.user_id,
        template_count = templates.len(),
        branch_scope = policy_branch_scope_label(&principal.branch_scope),
        "policy studio role templates listed"
    );
    Ok(Json(templates))
}

async fn list_policy_audit_events(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Query(query): Query<PolicyAuditEventsQuery>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage(&principal, Feature::RoleManage)?;
    let limit = normalize_policy_audit_limit(query.limit)?;
    let events = state
        .store
        .list_policy_audit_events(limit)
        .await
        .map_err(RestError::from_store)?
        .into_iter()
        .map(PolicyAuditEventResponse::from)
        .collect::<Vec<_>>();
    record_policy_studio_operation("list_audit_events", "success");
    tracing::info!(
        event = "policy_studio_audit_events_listed",
        operation = "list_audit_events",
        outcome = "success",
        actor_user_id = %principal.user_id,
        event_count = events.len(),
        branch_scope = policy_branch_scope_label(&principal.branch_scope),
        "policy studio audit events listed"
    );
    Ok(Json(events))
}

async fn create_policy_role(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Json(body): Json<CreatePolicyRoleRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage(&principal, Feature::RoleManage)?;
    let role_key = normalize_policy_role_key(&body.role_key)?;
    let display_name = normalize_policy_display_name(&body.display_name)?;
    let description = normalize_policy_description(body.description.as_deref())?;
    let permissions = validate_policy_permissions(&body.permissions)?;
    let conditions = validate_policy_conditions(&body.conditions)?;
    ensure_policy_conditions_inside_delegated_authority_for_operation(
        "create_role",
        &principal,
        &conditions,
    )?;

    let trace = TraceContext::generate();
    let role = state
        .store
        .create_policy_role(CreatePolicyRoleCommand {
            actor: principal.user_id,
            role_key,
            display_name,
            description,
            permissions,
            conditions,
            trace: trace.clone(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    record_policy_studio_operation("create_role", "success");
    tracing::info!(
        event = "policy_studio_role_created",
        operation = "create_role",
        outcome = "success",
        actor_user_id = %principal.user_id,
        role_id = %role.id,
        permission_count = role.permissions.len(),
        condition_count = role.conditions.len(),
        audit_trace_id = trace.trace_id(),
        audit_span_id = trace.span_id(),
        branch_scope = policy_branch_scope_label(&principal.branch_scope),
        "policy studio role created"
    );
    Ok((StatusCode::CREATED, Json(PolicyRoleResponse::from(role))))
}

async fn update_policy_role(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdatePolicyRoleRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage(&principal, Feature::RoleManage)?;
    let display_name = normalize_policy_display_name(&body.display_name)?;
    let description = normalize_policy_description(body.description.as_deref())?;
    let permissions = validate_policy_permissions(&body.permissions)?;
    let conditions = validate_policy_conditions(&body.conditions)?;
    let role = state
        .store
        .list_policy_roles()
        .await
        .map_err(RestError::from_store)?
        .into_iter()
        .find(|role| role.id == id)
        .ok_or_else(|| RestError::from_kernel(KernelError::not_found("policy role not found")))?;
    if role.is_system {
        return Err(RestError::validation(
            "system policy roles cannot be changed",
        ));
    }
    let requested_role = PolicyRoleSummary {
        id: role.id,
        role_key: role.role_key.clone(),
        display_name: display_name.clone(),
        description: description.clone(),
        status: role.status.clone(),
        is_system: role.is_system,
        permissions: permissions.clone(),
        conditions: conditions.clone(),
        created_at: role.created_at,
        updated_at: role.updated_at,
    };
    ensure_policy_roles_inside_delegated_authority_for_operation(
        "update_role",
        &principal,
        &[role.clone(), requested_role],
    )?;
    verify_policy_step_up(&state, &principal, body.step_up).await?;

    let trace = TraceContext::generate();
    let role = state
        .store
        .update_policy_role(UpdatePolicyRoleCommand {
            actor: principal.user_id,
            role_id: id,
            display_name,
            description,
            permissions,
            conditions,
            trace: trace.clone(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    record_policy_studio_operation("update_role", "success");
    tracing::info!(
        event = "policy_studio_role_updated",
        operation = "update_role",
        outcome = "success",
        actor_user_id = %principal.user_id,
        role_id = %role.id,
        permission_count = role.permissions.len(),
        condition_count = role.conditions.len(),
        audit_trace_id = trace.trace_id(),
        audit_span_id = trace.span_id(),
        branch_scope = policy_branch_scope_label(&principal.branch_scope),
        "policy studio role updated"
    );
    Ok(Json(PolicyRoleResponse::from(role)))
}

async fn preview_policy_role_status(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<PolicyRoleStatusPreviewRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage(&principal, Feature::RoleManage)?;
    let requested_status = normalize_policy_role_status(&body.status)?;
    let role = state
        .store
        .list_policy_roles()
        .await
        .map_err(RestError::from_store)?
        .into_iter()
        .find(|role| role.id == id)
        .ok_or_else(|| RestError::from_kernel(KernelError::not_found("policy role not found")))?;
    ensure_policy_roles_inside_delegated_authority_for_operation(
        "preview_role_status",
        &principal,
        std::slice::from_ref(&role),
    )?;
    validate_policy_role_status_transition(&role.status, &requested_status)?;
    let planned_assignment_count = state
        .store
        .count_policy_role_assignments(id)
        .await
        .map_err(RestError::from_store)?;
    record_policy_studio_operation("preview_role_status", "success");
    tracing::info!(
        event = "policy_studio_role_status_previewed",
        operation = "preview_role_status",
        outcome = "success",
        actor_user_id = %principal.user_id,
        role_id = %role.id,
        current_status = %role.status,
        requested_status = %requested_status,
        planned_assignment_count,
        branch_scope = policy_branch_scope_label(&principal.branch_scope),
        "policy studio role status previewed"
    );
    Ok(Json(build_policy_role_status_preview(
        &role,
        requested_status,
        planned_assignment_count,
    )))
}

async fn update_policy_role_status(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdatePolicyRoleStatusRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage(&principal, Feature::RoleManage)?;
    let status = normalize_policy_role_status(&body.status)?;
    let role = state
        .store
        .list_policy_roles()
        .await
        .map_err(RestError::from_store)?
        .into_iter()
        .find(|role| role.id == id)
        .ok_or_else(|| RestError::from_kernel(KernelError::not_found("policy role not found")))?;
    ensure_policy_roles_inside_delegated_authority_for_operation(
        "update_role_status",
        &principal,
        std::slice::from_ref(&role),
    )?;
    validate_policy_role_status_transition(&role.status, &status)?;
    verify_policy_step_up(&state, &principal, body.step_up).await?;

    let trace = TraceContext::generate();
    let role = state
        .store
        .update_policy_role_status(UpdatePolicyRoleStatusCommand {
            actor: principal.user_id,
            role_id: id,
            status,
            trace: trace.clone(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?;
    record_policy_studio_operation("update_role_status", "success");
    tracing::info!(
        event = "policy_studio_role_status_updated",
        operation = "update_role_status",
        outcome = "success",
        actor_user_id = %principal.user_id,
        role_id = %role.id,
        status = %role.status,
        audit_trace_id = trace.trace_id(),
        audit_span_id = trace.span_id(),
        branch_scope = policy_branch_scope_label(&principal.branch_scope),
        "policy studio role status updated"
    );
    Ok(Json(PolicyRoleResponse::from(role)))
}

async fn list_policy_assignments(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Query(query): Query<ListPolicyAssignmentsRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage(&principal, Feature::RoleManage)?;
    let Some(user_id) = query.user_id.map(UserId::from_uuid) else {
        return Err(RestError::validation("user_id query parameter is required"));
    };
    // Custom-role assignments are user governance data and ACTIVE roles are
    // runtime-effective, so branch-scoped RoleManage holders may only inspect
    // targets visible in their live branch scope.
    state
        .store
        .get_user(user_id, &principal.branch_scope)
        .await
        .map_err(RestError::from_store)?;
    let assignments = state
        .store
        .list_policy_role_assignments(user_id)
        .await
        .map_err(RestError::from_store)?
        .into_iter()
        .map(PolicyRoleAssignmentResponse::from)
        .collect::<Vec<_>>();
    record_policy_studio_operation("list_assignments", "success");
    tracing::info!(
        event = "policy_studio_assignments_listed",
        operation = "list_assignments",
        outcome = "success",
        actor_user_id = %principal.user_id,
        target_user_id = %user_id,
        assignment_count = assignments.len(),
        branch_scope = policy_branch_scope_label(&principal.branch_scope),
        "policy studio assignments listed"
    );
    Ok(Json(assignments))
}

async fn replace_policy_assignments(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<ReplacePolicyRoleAssignmentsRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage(&principal, Feature::RoleManage)?;
    let user_id = UserId::from_uuid(id);
    state
        .store
        .get_user(user_id, &principal.branch_scope)
        .await
        .map_err(RestError::from_store)?;
    let current_assignments = state
        .store
        .list_policy_role_assignments(user_id)
        .await
        .map_err(RestError::from_store)?;
    let custom_roles = state
        .store
        .list_policy_roles()
        .await
        .map_err(RestError::from_store)?;
    let requested_roles = validate_requested_policy_roles(&custom_roles, &body.role_ids)?;
    let authorized_roles = policy_roles_touched_by_assignment_replace(
        &custom_roles,
        &requested_roles,
        &current_assignments,
    )?;
    ensure_policy_roles_inside_delegated_authority_for_operation(
        "replace_assignments",
        &principal,
        &authorized_roles,
    )?;
    ensure_policy_roles_inside_actor_permission_ceiling_for_operation(
        "replace_assignments",
        &principal,
        &authorized_roles,
    )?;
    ensure_assignment_preview_acknowledged(&principal, body.preview_acknowledged)?;
    let preview_receipt_id =
        require_assignment_preview_receipt(&principal, body.preview_receipt_id)?;
    verify_policy_step_up(&state, &principal, body.step_up).await?;
    let trace = TraceContext::generate();
    let assignments = state
        .store
        .replace_policy_role_assignments(ReplacePolicyRoleAssignmentsCommand {
            actor: principal.user_id,
            user_id,
            role_ids: body.role_ids,
            preview_receipt_id,
            trace: trace.clone(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await
        .map_err(RestError::from_store)?
        .into_iter()
        .map(PolicyRoleAssignmentResponse::from)
        .collect::<Vec<_>>();
    record_policy_studio_operation("replace_assignments", "success");
    tracing::info!(
        event = "policy_studio_assignments_replaced",
        operation = "replace_assignments",
        outcome = "success",
        actor_user_id = %principal.user_id,
        target_user_id = %user_id,
        assignment_count = assignments.len(),
        audit_trace_id = trace.trace_id(),
        audit_span_id = trace.span_id(),
        branch_scope = policy_branch_scope_label(&principal.branch_scope),
        "policy studio assignments replaced"
    );
    Ok(Json(assignments))
}

async fn preview_policy_assignments(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<ReplacePolicyRoleAssignmentsRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage(&principal, Feature::RoleManage)?;
    let user_id = UserId::from_uuid(id);
    let user = state
        .store
        .get_user(user_id, &principal.branch_scope)
        .await
        .map_err(RestError::from_store)?;
    let current_assignments = state
        .store
        .list_policy_role_assignments(user_id)
        .await
        .map_err(RestError::from_store)?;
    let policy_version = state
        .store
        .get_policy_version()
        .await
        .map_err(RestError::from_store)?;
    let custom_roles = state
        .store
        .list_policy_roles()
        .await
        .map_err(RestError::from_store)?;
    let requested_roles = validate_requested_policy_roles(&custom_roles, &body.role_ids)?;
    let current_ids = current_assignments
        .iter()
        .map(|assignment| assignment.role_id)
        .collect::<BTreeSet<_>>();
    let requested_ids = requested_roles
        .iter()
        .map(|role| role.id)
        .collect::<BTreeSet<_>>();
    let authorized_roles = policy_roles_touched_by_assignment_replace(
        &custom_roles,
        &requested_roles,
        &current_assignments,
    )?;
    ensure_policy_roles_inside_delegated_authority_for_operation(
        "preview_assignments",
        &principal,
        &authorized_roles,
    )?;
    ensure_policy_roles_inside_actor_permission_ceiling_for_operation(
        "preview_assignments",
        &principal,
        &authorized_roles,
    )?;

    let requested_role_ids = requested_ids.iter().copied().collect::<Vec<_>>();
    let delta = PolicyRoleAssignmentDeltaResponse {
        added_role_ids: requested_ids.difference(&current_ids).copied().collect(),
        removed_role_ids: current_ids.difference(&requested_ids).copied().collect(),
        unchanged_role_ids: requested_ids.intersection(&current_ids).copied().collect(),
    };

    let mut feature_grants = Vec::new();
    for role_code in &user.roles {
        let role = Role::from_str(role_code)
            .map_err(|_| RestError::validation("user has an unknown system role"))?;
        for feature in Feature::ALL {
            let permission = permission_for(role, feature);
            if matches!(permission, PermissionLevel::Deny) {
                continue;
            }
            feature_grants.push(PolicyFeatureGrantPreviewResponse {
                feature_key: feature.as_str().to_owned(),
                permission_level: permission.as_str().to_owned(),
                source_type: "system_role".to_owned(),
                source_key: role.as_str().to_owned(),
                source_label: role.as_str().to_owned(),
            });
        }
    }
    let mut runtime_warning_codes = BTreeSet::new();
    let mut custom_role_impacts = Vec::with_capacity(requested_roles.len());
    for role in &requested_roles {
        let runtime_decision = policy_role_runtime_decision_for_user(role, &user);
        for warning in &runtime_decision.warnings {
            runtime_warning_codes.insert(warning.clone());
        }
        if runtime_decision.effective {
            for permission in runtime_allowed_policy_permissions(role) {
                feature_grants.push(PolicyFeatureGrantPreviewResponse {
                    feature_key: permission.feature_key.clone(),
                    permission_level: permission.permission_level.clone(),
                    source_type: "custom_role".to_owned(),
                    source_key: role.role_key.clone(),
                    source_label: role.display_name.clone(),
                });
            }
        }
        custom_role_impacts.push(PolicyRoleImpactResponse {
            role_id: role.id,
            role_key: role.role_key.clone(),
            display_name: role.display_name.clone(),
            status: role.status.clone(),
            runtime_effective: runtime_decision.effective,
            runtime_warnings: runtime_decision.warnings,
            conditions: role
                .conditions
                .iter()
                .cloned()
                .map(policy_condition_response)
                .collect(),
        });
    }
    feature_grants.sort_by(|left, right| {
        (
            &left.feature_key,
            &left.source_type,
            &left.source_key,
            &left.permission_level,
        )
            .cmp(&(
                &right.feature_key,
                &right.source_type,
                &right.source_key,
                &right.permission_level,
            ))
    });

    let assignment_runtime_effective = custom_role_impacts
        .iter()
        .any(|role| role.runtime_effective);
    let mut warnings = vec!["preview_only_pending_save".to_owned()];
    if assignment_runtime_effective {
        warnings.push("active_assignments_become_runtime_effective_after_save".to_owned());
    }
    warnings.extend(runtime_warning_codes);

    let requested_role_count = requested_roles.len();
    let custom_roles = custom_role_impacts;
    let current_branch_ids = user
        .branch_ids
        .iter()
        .map(|branch_id| *branch_id.as_uuid())
        .collect::<Vec<_>>();
    let current_role_ids = current_ids.iter().copied().collect::<Vec<_>>();
    let preview_receipt = state
        .store
        .create_policy_assignment_preview_receipt(CreatePolicyAssignmentPreviewReceiptCommand {
            actor: principal.user_id,
            user_id,
            current_branch_ids,
            current_role_ids: current_role_ids.clone(),
            role_ids: requested_role_ids.clone(),
            policy_version: policy_version.version,
            expires_at: OffsetDateTime::now_utc() + POLICY_ASSIGNMENT_PREVIEW_RECEIPT_TTL,
        })
        .await
        .map_err(RestError::from_store)?;

    record_policy_studio_operation("preview_assignments", "success");
    tracing::info!(
        event = "policy_studio_assignment_previewed",
        operation = "preview_assignments",
        outcome = "success",
        actor_user_id = %principal.user_id,
        target_user_id = %user_id,
        requested_role_count,
        feature_grant_count = feature_grants.len(),
        branch_scope = policy_branch_scope_label(&principal.branch_scope),
        "policy studio assignment previewed"
    );

    Ok(Json(PolicyAssignmentPreviewResponse {
        user_id: *user_id.as_uuid(),
        preview_receipt_id: preview_receipt.id,
        preview_receipt_expires_at: preview_receipt.expires_at,
        effective: assignment_runtime_effective,
        system_roles: user.roles,
        current_role_ids,
        requested_role_ids,
        delta,
        custom_roles,
        feature_grants,
        warnings,
    }))
}

fn policy_feature_catalog() -> Vec<PolicyFeatureResponse> {
    Feature::ALL
        .into_iter()
        .map(|feature| PolicyFeatureResponse {
            feature_key: feature.as_str().to_owned(),
            elevated: is_elevated_policy_feature(feature),
            default_permissions: Role::ALL
                .into_iter()
                .map(|role| PolicyDefaultPermissionResponse {
                    role_key: role.as_str().to_owned(),
                    permission_level: permission_for(role, feature).as_str().to_owned(),
                })
                .collect(),
        })
        .collect()
}

fn system_policy_roles() -> Vec<SystemPolicyRoleResponse> {
    Role::ALL
        .into_iter()
        .map(|role| SystemPolicyRoleResponse {
            role_key: role.as_str().to_owned(),
            display_name: role.as_str().to_owned(),
            status: "ACTIVE".to_owned(),
            is_system: true,
            permissions: Feature::ALL
                .into_iter()
                .map(|feature| PolicyPermissionResponse {
                    feature_key: feature.as_str().to_owned(),
                    permission_level: permission_for(role, feature).as_str().to_owned(),
                })
                .collect(),
        })
        .collect()
}

fn policy_role_templates() -> Vec<PolicyRoleTemplateResponse> {
    use Feature::{
        AssigneeManage, CompletionReview, DailyPlanRequest, DailyPlanReview,
        EmployeeDirectoryManage, EmployeeDirectoryRead, EquipmentCostLedgerRead, EquipmentManage,
        EvidenceAttach, ExcelDownload, KpiRead, MailUse, OpsDashboardRead, PayrollManage,
        PayrollRead, PurchaseRequestApprove, PurchaseRequestCreate, PurchaseRequestRead,
        RentalQuoteManage, SalesManage, TargetManage, WorkOrderCreate, WorkOrderEditIntake,
        WorkOrderReadAll, WorkOrderStart, WorkReportSubmit,
    };
    use PermissionLevel::{Allow, Limited, RequestOnly};

    vec![
        role_template(
            "branch_operations_manager",
            "branch_operations_manager",
            "지점 운영 관리자",
            "operations",
            "지점 단위 작업 흐름, 일일 계획 검토, 배정 조율을 담당합니다.",
            &[
                (WorkOrderReadAll, Allow),
                (DailyPlanReview, Allow),
                (CompletionReview, Allow),
                (AssigneeManage, Limited),
                (TargetManage, RequestOnly),
                (OpsDashboardRead, Limited),
            ],
        ),
        role_template(
            "dispatch_reception",
            "dispatch_reception",
            "접수·배차 코디네이터",
            "operations",
            "접수, 작업 생성, 고객/현장 연락, 기본 배차 보조를 담당합니다.",
            &[
                (WorkOrderCreate, Allow),
                (WorkOrderEditIntake, Allow),
                (WorkOrderReadAll, Allow),
                (TargetManage, RequestOnly),
                (MailUse, Allow),
            ],
        ),
        role_template(
            "site_operations",
            "site_operations",
            "현장 운영 담당자",
            "field_operations",
            "현장 작업 진행, 작업 보고, 증빙 첨부, 일일 계획 요청을 담당합니다.",
            &[
                (WorkOrderReadAll, Allow),
                (WorkOrderStart, Allow),
                (WorkReportSubmit, Allow),
                (EvidenceAttach, Allow),
                (DailyPlanRequest, RequestOnly),
            ],
        ),
        role_template(
            "security_guard",
            "security_guard",
            "경비 담당자",
            "security_operations",
            "현장 출입·안전 이슈를 접수하고 제한된 작업 현황과 증빙을 기록합니다.",
            &[
                (WorkOrderReadAll, Limited),
                (WorkOrderCreate, RequestOnly),
                (WorkReportSubmit, Limited),
                (EvidenceAttach, Limited),
            ],
        ),
        role_template(
            "cleaning_staff",
            "cleaning_staff",
            "미화 담당자",
            "cleaning_operations",
            "미화 작업 배정을 확인하고 완료 보고와 현장 증빙을 남깁니다.",
            &[
                (WorkOrderReadAll, Limited),
                (WorkOrderStart, Limited),
                (WorkReportSubmit, Allow),
                (EvidenceAttach, Limited),
                (DailyPlanRequest, RequestOnly),
            ],
        ),
        role_template(
            "dispatch_office_staff",
            "dispatch_office_staff",
            "파견사무 담당자",
            "dispatch_office",
            "파견사무 접수, 작업 생성·수정, 현장 연락과 기본 대상 변경 요청을 담당합니다.",
            &[
                (WorkOrderCreate, Allow),
                (WorkOrderEditIntake, Allow),
                (WorkOrderReadAll, Allow),
                (TargetManage, RequestOnly),
                (MailUse, Allow),
            ],
        ),
        role_template(
            "asset_cost_analyst",
            "asset_cost_analyst",
            "자산 비용 분석가",
            "finance",
            "장비 원가, KPI, 구매 조회를 분석하되 승인 권한은 별도로 요청합니다.",
            &[
                (EquipmentCostLedgerRead, Allow),
                (KpiRead, Allow),
                (PurchaseRequestRead, Allow),
                (ExcelDownload, Limited),
            ],
        ),
        role_template(
            "purchasing_requester",
            "purchasing_requester",
            "구매 요청 담당자",
            "finance",
            "구매 요청을 작성하고 진행 상태를 추적합니다.",
            &[(PurchaseRequestCreate, Allow), (PurchaseRequestRead, Allow)],
        ),
        role_template(
            "purchase_reviewer",
            "purchase_reviewer",
            "구매 검토자",
            "finance",
            "구매 요청을 조회하고 제한된 승인 검토를 수행합니다.",
            &[
                (PurchaseRequestRead, Allow),
                (PurchaseRequestApprove, Limited),
            ],
        ),
        role_template(
            "people_ops_manager",
            "people_ops_manager",
            "HR 운영 관리자",
            "people",
            "직원 디렉터리와 조직 기본 정보를 관리합니다. 로그인 사용자 권한 관리는 포함하지 않습니다.",
            &[
                (EmployeeDirectoryRead, Allow),
                (EmployeeDirectoryManage, Allow),
                (ExcelDownload, Limited),
            ],
        ),
        role_template(
            "payroll_manager",
            "payroll_manager",
            "급여담당자",
            "payroll",
            "법인/사업장 급여대장, 근태-급여 연결, 급여 자료 다운로드를 담당합니다.",
            &[
                (EmployeeDirectoryRead, Allow),
                (PayrollRead, Allow),
                (PayrollManage, Allow),
                (ExcelDownload, Allow),
            ],
        ),
        role_template(
            "hq_payroll_manager",
            "hq_payroll_manager",
            "HQ급여담당자",
            "payroll",
            "법적 소속 법인과 별개로 그룹/HQ 급여 업무를 맡은 인원에게 부여합니다.",
            &[
                (EmployeeDirectoryRead, Allow),
                (PayrollRead, Allow),
                (PayrollManage, Allow),
                (ExcelDownload, Allow),
            ],
        ),
        role_template(
            "inspection_coordinator",
            "inspection_coordinator",
            "검사 일정 코디네이터",
            "assets",
            "검사 일정과 라운드 완료를 조율하고 장비 정보 변경은 제한적으로 요청합니다.",
            &[
                (EquipmentManage, Limited),
                (Feature::InspectionScheduleManage, Allow),
                (Feature::InspectionRoundComplete, Limited),
                (WorkOrderReadAll, Allow),
            ],
        ),
        role_template(
            "sales_service_coordinator",
            "sales_service_coordinator",
            "영업·서비스 코디네이터",
            "customer",
            "렌탈 견적, 판매 문의, 회사 메일 기반 고객 응대를 담당합니다.",
            &[
                (RentalQuoteManage, Limited),
                (SalesManage, Limited),
                (MailUse, Allow),
                (WorkOrderReadAll, Limited),
            ],
        ),
    ]
}

fn role_template(
    template_key: &str,
    role_key: &str,
    display_name: &str,
    category: &str,
    description: &str,
    permissions: &[(Feature, PermissionLevel)],
) -> PolicyRoleTemplateResponse {
    PolicyRoleTemplateResponse {
        template_key: template_key.to_owned(),
        role_key: role_key.to_owned(),
        display_name: display_name.to_owned(),
        category: category.to_owned(),
        description: description.to_owned(),
        permissions: permissions
            .iter()
            .map(|(feature, level)| PolicyPermissionResponse {
                feature_key: feature.as_str().to_owned(),
                permission_level: level.as_str().to_owned(),
            })
            .collect(),
    }
}

impl From<PolicyVersionSummary> for PolicyVersionResponse {
    fn from(value: PolicyVersionSummary) -> Self {
        Self {
            version: value.version,
            updated_at: value.updated_at,
        }
    }
}

impl From<PolicyAuditEventSummary> for PolicyAuditEventResponse {
    fn from(value: PolicyAuditEventSummary) -> Self {
        Self {
            id: value.id,
            actor: value.actor.map(|user_id| *user_id.as_uuid()),
            action: value.action,
            target_type: value.target_type,
            target_id: value.target_id,
            before_snapshot: value.before_snapshot,
            after_snapshot: value.after_snapshot,
            trace_id: value.trace_id,
            span_id: value.span_id,
            occurred_at: value.occurred_at,
        }
    }
}

fn build_policy_role_status_preview(
    role: &PolicyRoleSummary,
    requested_status: String,
    planned_assignment_count: i64,
) -> PolicyRoleStatusPreviewResponse {
    let effective_runtime_change = planned_assignment_count > 0
        && role.status != requested_status
        && (role.status == "ACTIVE" || requested_status == "ACTIVE");
    let mut warnings = vec!["passkey_step_up_required".to_owned()];
    if role.status == requested_status {
        warnings.push("no_status_change".to_owned());
    }
    if planned_assignment_count > 0 {
        warnings.push("assigned_users_may_gain_or_lose_runtime_permissions".to_owned());
    }
    if requested_status == "DRAFT" && role.status == "ACTIVE" && planned_assignment_count > 0 {
        warnings.push("rollback_disables_assigned_custom_role_runtime_grants".to_owned());
    }
    if requested_status == "RETIRED" && role.status == "ACTIVE" && planned_assignment_count > 0 {
        warnings.push("retire_disables_assigned_custom_role_runtime_grants".to_owned());
    }
    if requested_status == "ACTIVE" && role.status != requested_status {
        warnings.push("publish_enables_assigned_custom_role_runtime_grants".to_owned());
    }

    PolicyRoleStatusPreviewResponse {
        role_id: role.id,
        role_key: role.role_key.clone(),
        display_name: role.display_name.clone(),
        current_status: role.status.clone(),
        requested_status,
        permission_count: role.permissions.len() as i64,
        condition_count: role.conditions.len() as i64,
        planned_assignment_count,
        requires_passkey_step_up: true,
        effective_runtime_change,
        warnings,
    }
}

impl From<PolicyRoleSummary> for PolicyRoleResponse {
    fn from(value: PolicyRoleSummary) -> Self {
        Self {
            id: value.id,
            role_key: value.role_key,
            display_name: value.display_name,
            description: value.description,
            status: value.status,
            is_system: value.is_system,
            permissions: value
                .permissions
                .into_iter()
                .map(|permission| PolicyPermissionResponse {
                    feature_key: permission.feature_key,
                    permission_level: permission.permission_level,
                })
                .collect(),
            conditions: value
                .conditions
                .into_iter()
                .map(policy_condition_response)
                .collect(),
            created_at: value.created_at,
            updated_at: value.updated_at,
        }
    }
}

fn policy_condition_response(condition: PolicyRoleCondition) -> PolicyConditionResponse {
    PolicyConditionResponse {
        condition_key: condition.condition_key,
        attribute: condition.attribute,
        operator: condition.operator,
        values: condition.values,
    }
}

impl From<PolicyRoleAssignmentSummary> for PolicyRoleAssignmentResponse {
    fn from(value: PolicyRoleAssignmentSummary) -> Self {
        Self {
            user_id: *value.user_id.as_uuid(),
            role_id: value.role_id,
            role_key: value.role_key,
            display_name: value.display_name,
            status: value.status,
            assigned_by: value.assigned_by.map(|user_id| *user_id.as_uuid()),
            created_at: value.created_at,
        }
    }
}

fn normalize_policy_role_key(raw: &str) -> Result<String, RestError> {
    let value = raw.trim();
    if value.len() < 2 || value.len() > 64 {
        return Err(RestError::validation(
            "role key must be between 2 and 64 characters",
        ));
    }
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return Err(RestError::validation("role key is required"));
    };
    if !first.is_ascii_lowercase() {
        return Err(RestError::validation(
            "role key must start with a lowercase ascii letter",
        ));
    }
    if !chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_') {
        return Err(RestError::validation(
            "role key may contain lowercase ascii letters, digits, and underscores only",
        ));
    }
    if Role::ALL
        .into_iter()
        .any(|role| value.eq_ignore_ascii_case(role.as_str()))
    {
        return Err(RestError::validation(
            "custom role key must not shadow a built-in role",
        ));
    }
    Ok(value.to_owned())
}

fn normalize_policy_display_name(raw: &str) -> Result<String, RestError> {
    let value = raw.trim();
    if value.is_empty() || value.chars().count() > 80 {
        return Err(RestError::validation(
            "display name must be between 1 and 80 characters",
        ));
    }
    Ok(value.to_owned())
}

fn normalize_policy_description(raw: Option<&str>) -> Result<Option<String>, RestError> {
    let Some(value) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if value.chars().count() > 512 {
        return Err(RestError::validation(
            "description must be 512 characters or fewer",
        ));
    }
    Ok(Some(value.to_owned()))
}

fn validate_policy_permissions(
    raw: &[PolicyPermissionResponse],
) -> Result<Vec<PolicyRolePermission>, RestError> {
    let mut seen = BTreeSet::new();
    let mut permissions = Vec::new();
    for permission in raw {
        let feature = Feature::from_str(&permission.feature_key)
            .map_err(|_| RestError::validation("unknown feature key"))?;
        if is_elevated_policy_feature(feature) {
            return Err(RestError::forbidden(
                "custom roles cannot grant elevated or scope-widening policy features yet",
            ));
        }
        let level = PermissionLevel::from_str(&permission.permission_level)
            .map_err(|_| RestError::validation("unknown permission level"))?;
        if !seen.insert(feature) {
            return Err(RestError::validation("duplicate feature permission"));
        }
        if matches!(level, PermissionLevel::Deny) {
            continue;
        }
        permissions.push(PolicyRolePermission {
            feature_key: feature.as_str().to_owned(),
            permission_level: level.as_str().to_owned(),
        });
    }
    if permissions.is_empty() {
        return Err(RestError::validation(
            "custom role must grant at least one non-deny feature",
        ));
    }
    Ok(permissions)
}

fn validate_policy_conditions(
    raw: &[PolicyConditionResponse],
) -> Result<Vec<PolicyRoleCondition>, RestError> {
    if raw.len() > 20 {
        return Err(RestError::validation(
            "custom role may define at most 20 policy conditions",
        ));
    }

    let mut seen_keys = BTreeSet::new();
    let mut conditions = Vec::with_capacity(raw.len());
    for condition in raw {
        let condition_key = normalize_policy_condition_key(&condition.condition_key)?;
        if !seen_keys.insert(condition_key.clone()) {
            return Err(RestError::validation("duplicate policy condition key"));
        }
        let attribute = normalize_policy_condition_attribute(&condition.attribute)?;
        let operator = normalize_policy_condition_operator(&condition.operator)?;
        let values = normalize_policy_condition_values(&condition.values)?;
        conditions.push(PolicyRoleCondition {
            condition_key,
            attribute,
            operator,
            values,
        });
    }
    Ok(conditions)
}

fn normalize_policy_condition_key(raw: &str) -> Result<String, RestError> {
    let value = raw.trim();
    if value.len() < 2 || value.len() > 64 {
        return Err(RestError::validation(
            "condition key must be between 2 and 64 characters",
        ));
    }
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return Err(RestError::validation("condition key is required"));
    };
    if !first.is_ascii_lowercase()
        || !chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
    {
        return Err(RestError::validation(
            "condition key may contain lowercase ascii letters, digits, and underscores only",
        ));
    }
    Ok(value.to_owned())
}

fn normalize_policy_condition_attribute(raw: &str) -> Result<String, RestError> {
    let value = raw.trim().to_ascii_lowercase();
    match value.as_str() {
        "group" | "tenant" | "organization" | "org" | "department" | "team" | "position"
        | "employment_status" | "assignment" | "location" | "site" | "branch"
        | "device_posture" | "purpose" | "action" | "resource" | "sensitive_action" => Ok(value),
        _ => Err(RestError::validation("unknown policy condition attribute")),
    }
}

fn normalize_policy_condition_operator(raw: &str) -> Result<String, RestError> {
    let value = raw.trim().to_ascii_lowercase();
    match value.as_str() {
        "equals" | "not_equals" | "in" => Ok(value),
        _ => Err(RestError::validation("unknown policy condition operator")),
    }
}

fn normalize_policy_condition_values(raw: &[String]) -> Result<Vec<String>, RestError> {
    if raw.is_empty() || raw.len() > 20 {
        return Err(RestError::validation(
            "policy condition values must contain 1 to 20 entries",
        ));
    }
    let mut seen = BTreeSet::new();
    let mut values = Vec::with_capacity(raw.len());
    for value in raw {
        let trimmed = value.trim();
        if trimmed.is_empty() || trimmed.chars().count() > 120 {
            return Err(RestError::validation(
                "policy condition values must be non-empty and 120 characters or fewer",
            ));
        }
        if trimmed.chars().any(char::is_control) {
            return Err(RestError::validation(
                "policy condition values must not contain control characters",
            ));
        }
        if !seen.insert(trimmed.to_owned()) {
            return Err(RestError::validation("duplicate policy condition value"));
        }
        values.push(trimmed.to_owned());
    }
    Ok(values)
}

fn validate_requested_policy_roles(
    custom_roles: &[PolicyRoleSummary],
    raw_role_ids: &[Uuid],
) -> Result<Vec<PolicyRoleSummary>, RestError> {
    let requested_ids = raw_role_ids.iter().copied().collect::<BTreeSet<_>>();
    let mut roles = Vec::with_capacity(requested_ids.len());
    for requested_id in requested_ids {
        let Some(role) = custom_roles
            .iter()
            .find(|role| role.id == requested_id && !role.is_system && role.status != "RETIRED")
        else {
            return Err(RestError::validation(
                "preview references an unknown or retired custom role",
            ));
        };
        roles.push(role.clone());
    }
    Ok(roles)
}

fn policy_roles_touched_by_assignment_replace(
    custom_roles: &[PolicyRoleSummary],
    requested_roles: &[PolicyRoleSummary],
    current_assignments: &[PolicyRoleAssignmentSummary],
) -> Result<Vec<PolicyRoleSummary>, RestError> {
    let requested_ids = requested_roles
        .iter()
        .map(|role| role.id)
        .collect::<BTreeSet<_>>();
    let mut roles = requested_roles.to_vec();
    for removed_id in current_assignments
        .iter()
        .map(|assignment| assignment.role_id)
        .collect::<BTreeSet<_>>()
        .difference(&requested_ids)
        .copied()
    {
        let Some(role) = custom_roles
            .iter()
            .find(|role| role.id == removed_id && !role.is_system)
        else {
            return Err(RestError::validation(
                "assignment references an unknown custom role",
            ));
        };
        roles.push(role.clone());
    }
    Ok(roles)
}

fn ensure_policy_roles_inside_delegated_authority_for_operation(
    operation: &'static str,
    principal: &Principal,
    roles: &[PolicyRoleSummary],
) -> Result<(), RestError> {
    for role in roles {
        if let Err(error) =
            ensure_policy_conditions_inside_delegated_authority(principal, &role.conditions)
        {
            record_policy_studio_rejection(operation, principal, &error);
            return Err(error);
        }
    }
    Ok(())
}

fn ensure_policy_roles_inside_actor_permission_ceiling_for_operation(
    operation: &'static str,
    principal: &Principal,
    roles: &[PolicyRoleSummary],
) -> Result<(), RestError> {
    if let Err(error) = ensure_policy_roles_inside_actor_permission_ceiling(principal, roles) {
        record_policy_studio_rejection(operation, principal, &error);
        return Err(error);
    }
    Ok(())
}

fn ensure_policy_roles_inside_actor_permission_ceiling(
    principal: &Principal,
    roles: &[PolicyRoleSummary],
) -> Result<(), RestError> {
    for role in roles {
        let role_scope = policy_role_assignment_branch_scope(principal, role)?;
        for permission in &role.permissions {
            let feature = Feature::from_str(&permission.feature_key)
                .map_err(|_| RestError::validation("unknown feature key"))?;
            let requested = PermissionLevel::from_str(&permission.permission_level)
                .map_err(|_| RestError::validation("unknown permission level"))?;
            if matches!(requested, PermissionLevel::Deny) {
                continue;
            }
            if is_elevated_policy_feature(feature) {
                return Err(RestError::forbidden(
                    "custom roles cannot grant elevated or scope-widening policy features yet",
                ));
            }
            if policy_feature_assignment_requires_elevated_grant(feature)
                && !principal_holds_policy_permission(
                    principal,
                    Feature::ElevatedRoleGrant,
                    PermissionLevel::Allow,
                    &role_scope,
                )
            {
                return Err(RestError::forbidden(
                    "elevated policy role assignments require elevated role grant",
                ));
            }
            if !principal_holds_policy_permission(principal, feature, requested, &role_scope) {
                return Err(RestError::forbidden(
                    "policy role permission exceeds delegated authority",
                ));
            }
        }
    }
    Ok(())
}

fn policy_role_assignment_branch_scope(
    principal: &Principal,
    role: &PolicyRoleSummary,
) -> Result<BranchScope, RestError> {
    let mut scope = principal.branch_scope.clone();
    for condition in role
        .conditions
        .iter()
        .filter(|condition| condition.attribute == "branch")
    {
        if !matches!(condition.operator.as_str(), "equals" | "in") {
            // Unsupported branch operators are not a safe narrowing proof. Keep
            // the current scope rather than assuming the role is branch-limited.
            continue;
        }
        let mut branches = BTreeSet::new();
        for value in &condition.values {
            let branch_uuid = Uuid::parse_str(value).map_err(|_| {
                RestError::validation(
                    "branch condition values must be branch UUIDs for delegated policy management",
                )
            })?;
            branches.insert(BranchId::from_uuid(branch_uuid));
        }
        scope = scope.intersect(&BranchScope::Branches(branches));
    }
    Ok(scope)
}

fn principal_holds_policy_permission(
    principal: &Principal,
    feature: Feature,
    requested: PermissionLevel,
    scope: &BranchScope,
) -> bool {
    principal.roles.iter().any(|role| {
        policy_permission_satisfies(permission_for(*role, feature), requested)
            && branch_scope_contains(&principal.branch_scope, scope)
    }) || principal.effective_feature_grants.iter().any(|grant| {
        grant.feature == feature
            && policy_permission_satisfies(grant.permission, requested)
            && branch_scope_contains(&grant.branch_scope, scope)
    })
}

fn policy_permission_satisfies(held: PermissionLevel, requested: PermissionLevel) -> bool {
    match requested {
        PermissionLevel::Deny => true,
        PermissionLevel::Allow => matches!(held, PermissionLevel::Allow),
        PermissionLevel::Limited => {
            matches!(held, PermissionLevel::Allow | PermissionLevel::Limited)
        }
        PermissionLevel::RequestOnly => {
            matches!(held, PermissionLevel::Allow | PermissionLevel::RequestOnly)
        }
    }
}

fn branch_scope_contains(container: &BranchScope, contained: &BranchScope) -> bool {
    match (container, contained) {
        (BranchScope::All, _) => true,
        (BranchScope::Branches(_), BranchScope::All) => false,
        (BranchScope::Branches(container), BranchScope::Branches(contained)) => {
            contained.is_subset(container)
        }
    }
}

fn policy_feature_assignment_requires_elevated_grant(feature: Feature) -> bool {
    if matches!(feature, Feature::UserManage) {
        return true;
    }
    let super_admin_allows = permission_for(Role::SuperAdmin, feature) == PermissionLevel::Allow;
    let non_super_admin_allows = Role::ALL
        .into_iter()
        .filter(|role| *role != Role::SuperAdmin)
        .any(|role| permission_for(role, feature) == PermissionLevel::Allow);
    super_admin_allows && !non_super_admin_allows
}

fn ensure_policy_conditions_inside_delegated_authority_for_operation(
    operation: &'static str,
    principal: &Principal,
    conditions: &[PolicyRoleCondition],
) -> Result<(), RestError> {
    if let Err(error) = ensure_policy_conditions_inside_delegated_authority(principal, conditions) {
        record_policy_studio_rejection(operation, principal, &error);
        return Err(error);
    }
    Ok(())
}

fn policy_role_is_inside_delegated_authority(
    principal: &Principal,
    role: &PolicyRoleSummary,
) -> bool {
    ensure_policy_conditions_inside_delegated_authority(principal, &role.conditions).is_ok()
}

fn ensure_policy_conditions_inside_delegated_authority(
    principal: &Principal,
    conditions: &[PolicyRoleCondition],
) -> Result<(), RestError> {
    let BranchScope::Branches(allowed_branches) = &principal.branch_scope else {
        return Ok(());
    };
    if allowed_branches.is_empty() {
        return Err(RestError::forbidden(
            "delegated policy managers must have at least one branch in scope",
        ));
    }

    let branch_conditions = conditions
        .iter()
        .filter(|condition| condition.attribute == "branch")
        .collect::<Vec<_>>();
    if branch_conditions.is_empty() {
        return Err(RestError::forbidden(
            "branch-scoped policy managers must include a branch condition",
        ));
    }

    for condition in branch_conditions {
        if condition.operator == "not_equals" {
            return Err(RestError::forbidden(
                "branch-scoped policy managers cannot use negative branch conditions",
            ));
        }
        for value in &condition.values {
            let branch_uuid = Uuid::parse_str(value).map_err(|_| {
                RestError::validation(
                    "branch condition values must be branch UUIDs for delegated policy management",
                )
            })?;
            let branch_id = BranchId::from_uuid(branch_uuid);
            if !allowed_branches.contains(&branch_id) {
                return Err(RestError::forbidden(
                    "policy role branch condition is outside delegated scope",
                ));
            }
        }
    }

    Ok(())
}

fn ensure_assignment_preview_acknowledged(
    principal: &Principal,
    preview_acknowledged: bool,
) -> Result<(), RestError> {
    if preview_acknowledged {
        return Ok(());
    }
    let error = RestError::validation("assignment preview must be acknowledged before saving");
    record_policy_studio_rejection("replace_assignments", principal, &error);
    Err(error)
}

fn require_assignment_preview_receipt(
    principal: &Principal,
    preview_receipt_id: Option<Uuid>,
) -> Result<Uuid, RestError> {
    let Some(preview_receipt_id) = preview_receipt_id else {
        let error = RestError::validation("assignment preview receipt is required before saving");
        record_policy_studio_rejection("replace_assignments", principal, &error);
        return Err(error);
    };
    Ok(preview_receipt_id)
}

async fn verify_policy_step_up(
    state: &IdentityRestState,
    principal: &Principal,
    step_up: Option<PolicyStepUpAssertionRequest>,
) -> Result<(), RestError> {
    let step_up = step_up.ok_or_else(|| {
        RestError::new(
            StatusCode::PRECONDITION_REQUIRED,
            "passkey_step_up_required",
            "policy changes require a fresh passkey step-up",
        )
    })?;
    let verifier = state.passkey_step_up.as_ref().ok_or_else(|| {
        RestError::unavailable("passkey step-up is not configured for identity API")
    })?;
    verifier
        .verify_step_up_for_user(
            state.pool(),
            step_up.ceremony_id,
            step_up.credential,
            *principal.user_id.as_uuid(),
        )
        .await
        .map_err(|_| RestError::unauthorized("passkey step-up failed"))?;
    Ok(())
}

fn normalize_policy_role_status(raw: &str) -> Result<String, RestError> {
    let status = raw.trim().to_ascii_uppercase();
    match status.as_str() {
        "DRAFT" | "ACTIVE" | "RETIRED" => Ok(status),
        _ => Err(RestError::validation(
            "policy role status must be DRAFT, ACTIVE, or RETIRED",
        )),
    }
}

fn validate_policy_role_status_transition(
    current_status: &str,
    requested_status: &str,
) -> Result<(), RestError> {
    if current_status == requested_status {
        return Ok(());
    }
    match (current_status, requested_status) {
        ("DRAFT", "ACTIVE") | ("ACTIVE", "DRAFT") | ("ACTIVE", "RETIRED") => Ok(()),
        _ => Err(RestError::validation(
            "policy role status transition is not allowed",
        )),
    }
}

fn normalize_policy_audit_limit(raw: Option<i64>) -> Result<i64, RestError> {
    let limit = raw.unwrap_or(20);
    if !(1..=100).contains(&limit) {
        return Err(RestError::validation(
            "policy audit limit must be between 1 and 100",
        ));
    }
    Ok(limit)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PolicyRoleRuntimeDecision {
    effective: bool,
    warnings: Vec<String>,
}

fn policy_role_runtime_decision_for_user(
    role: &PolicyRoleSummary,
    user: &UserSummary,
) -> PolicyRoleRuntimeDecision {
    let mut warnings = Vec::new();

    if role.status != "ACTIVE" {
        warnings.push("custom_role_status_not_active".to_owned());
    }

    let live_scope = policy_preview_branch_scope_for_user(user);
    match effective_scope_for_policy_preview_conditions(user, &live_scope, &role.conditions) {
        Ok(role_scope) if role_scope.is_empty() => {
            warnings.push("custom_role_condition_outside_target_branch_scope".to_owned());
        }
        Ok(_) => {}
        Err(reason) => warnings.push(reason.to_owned()),
    }

    if runtime_allowed_policy_permissions(role).is_empty() {
        warnings.push("custom_role_no_runtime_allowed_permissions".to_owned());
    }

    PolicyRoleRuntimeDecision {
        effective: warnings.is_empty(),
        warnings,
    }
}

fn runtime_allowed_policy_permissions(role: &PolicyRoleSummary) -> Vec<&PolicyRolePermission> {
    role.permissions
        .iter()
        .filter(|permission| {
            let Ok(feature) = Feature::from_str(&permission.feature_key) else {
                return false;
            };
            let Ok(level) = PermissionLevel::from_str(&permission.permission_level) else {
                return false;
            };
            level != PermissionLevel::Deny && custom_role_runtime_feature_allowed(feature)
        })
        .collect()
}

fn policy_preview_branch_scope_for_user(user: &UserSummary) -> BranchScope {
    let has_org_wide_system_role = user
        .roles
        .iter()
        .filter_map(|role| Role::from_str(role).ok())
        .any(|role| matches!(role, Role::Executive | Role::SuperAdmin));
    if has_org_wide_system_role {
        return BranchScope::All;
    }

    BranchScope::Branches(user.branch_ids.iter().copied().collect())
}

fn effective_scope_for_policy_preview_conditions(
    user: &UserSummary,
    live_scope: &BranchScope,
    conditions: &[PolicyRoleCondition],
) -> Result<BranchScope, &'static str> {
    let mut scope = live_scope.clone();
    for condition in conditions {
        if !matches!(condition.operator.as_str(), "equals" | "in") {
            return Err("custom_role_condition_unsupported_by_runtime_evaluator");
        }

        match condition.attribute.as_str() {
            "branch" => {
                let mut branches = BTreeSet::new();
                for value in &condition.values {
                    let branch = BranchId::from_str(value)
                        .map_err(|_| "custom_role_condition_invalid_branch_value")?;
                    branches.insert(branch);
                }
                scope = scope.intersect(&BranchScope::Branches(branches));
            }
            "team" => {
                if !team_condition_matches(user.team, &condition.values) {
                    return Err("custom_role_condition_outside_target_attributes");
                }
            }
            _ => return Err("custom_role_condition_unsupported_by_runtime_evaluator"),
        }
    }
    Ok(scope)
}

fn team_condition_matches(team: Option<Team>, values: &[String]) -> bool {
    let Some(team) = team else {
        return false;
    };
    let accepted = team_policy_values(team);
    values.iter().any(|value| {
        let value = value.trim();
        accepted
            .iter()
            .any(|accepted| value == *accepted || value.eq_ignore_ascii_case(accepted))
    })
}

fn team_policy_values(team: Team) -> [&'static str; 2] {
    match team {
        Team::Maintenance => ["MAINTENANCE", Team::Maintenance.as_db_str()],
        Team::Prevention => ["PREVENTION", Team::Prevention.as_db_str()],
        Team::Management => ["MANAGEMENT", Team::Management.as_db_str()],
        Team::Reception => ["RECEPTION", Team::Reception.as_db_str()],
    }
}

fn custom_role_runtime_feature_allowed(feature: Feature) -> bool {
    !matches!(
        feature,
        Feature::RoleManage | Feature::ElevatedRoleGrant | Feature::OrgWideQueueTriage
    )
}

fn is_elevated_policy_feature(feature: Feature) -> bool {
    !custom_role_runtime_feature_allowed(feature)
}

#[cfg(test)]
mod policy_role_template_tests {
    use super::*;

    fn policy_role_for_test(
        role_key: &str,
        permissions: &[(&str, &str)],
        conditions: Vec<PolicyRoleCondition>,
    ) -> PolicyRoleSummary {
        PolicyRoleSummary {
            id: Uuid::new_v4(),
            role_key: role_key.to_owned(),
            display_name: role_key.to_owned(),
            description: None,
            status: "ACTIVE".to_owned(),
            is_system: false,
            permissions: permissions
                .iter()
                .map(|(feature_key, permission_level)| PolicyRolePermission {
                    feature_key: (*feature_key).to_owned(),
                    permission_level: (*permission_level).to_owned(),
                })
                .collect(),
            conditions,
            created_at: OffsetDateTime::now_utc(),
            updated_at: OffsetDateTime::now_utc(),
        }
    }

    fn branch_condition(branch: BranchId) -> PolicyRoleCondition {
        PolicyRoleCondition {
            condition_key: "branch_scope".to_owned(),
            attribute: "branch".to_owned(),
            operator: "equals".to_owned(),
            values: vec![branch.to_string()],
        }
    }

    #[test]
    fn assignment_ceiling_rejects_capability_actor_does_not_hold() {
        let branch = BranchId::new();
        let principal = Principal::new(
            UserId::new(),
            mnt_kernel_core::OrgId::knl(),
            BTreeSet::from([Role::Admin]),
            BranchScope::single(branch),
        );
        let final_approval_role = policy_role_for_test(
            "final_approval_delegate",
            &[("purchase_final_approve", "allow")],
            vec![branch_condition(branch)],
        );

        let error =
            ensure_policy_roles_inside_actor_permission_ceiling(&principal, &[final_approval_role])
                .unwrap_err();

        assert_eq!(error.status, StatusCode::FORBIDDEN);
        assert_eq!(error.code, "forbidden");
        assert_eq!(
            error.message,
            "policy role permission exceeds delegated authority"
        );
    }

    #[test]
    fn assignment_ceiling_requires_custom_grant_scope_to_cover_role_scope() {
        let allowed_branch = BranchId::new();
        let blocked_branch = BranchId::new();
        let principal = Principal::new(
            UserId::new(),
            mnt_kernel_core::OrgId::knl(),
            BTreeSet::from([Role::Member]),
            BranchScope::Branches(BTreeSet::from([allowed_branch, blocked_branch])),
        )
        .with_effective_feature_grants(vec![
            mnt_platform_authz::EffectiveFeatureGrant::new(
                Feature::WorkOrderCreate,
                PermissionLevel::Allow,
                BranchScope::single(allowed_branch),
            ),
        ]);
        let allowed_role = policy_role_for_test(
            "allowed_branch_creator",
            &[("work_order_create", "allow")],
            vec![branch_condition(allowed_branch)],
        );
        let blocked_role = policy_role_for_test(
            "blocked_branch_creator",
            &[("work_order_create", "allow")],
            vec![branch_condition(blocked_branch)],
        );

        ensure_policy_roles_inside_actor_permission_ceiling(&principal, &[allowed_role]).unwrap();
        let error =
            ensure_policy_roles_inside_actor_permission_ceiling(&principal, &[blocked_role])
                .unwrap_err();

        assert_eq!(error.status, StatusCode::FORBIDDEN);
        assert_eq!(
            error.message,
            "policy role permission exceeds delegated authority"
        );
    }

    #[test]
    fn assignment_ceiling_requires_elevated_grant_for_user_management_roles() {
        let branch = BranchId::new();
        let admin = Principal::new(
            UserId::new(),
            mnt_kernel_core::OrgId::knl(),
            BTreeSet::from([Role::Admin]),
            BranchScope::single(branch),
        );
        let super_admin = Principal::new(
            UserId::new(),
            mnt_kernel_core::OrgId::knl(),
            BTreeSet::from([Role::SuperAdmin]),
            BranchScope::single(branch),
        );
        let user_manager = policy_role_for_test(
            "user_manager_delegate",
            &[("user_manage", "allow")],
            vec![branch_condition(branch)],
        );

        let error = ensure_policy_roles_inside_actor_permission_ceiling(
            &admin,
            std::slice::from_ref(&user_manager),
        )
        .unwrap_err();
        assert_eq!(error.status, StatusCode::FORBIDDEN);
        assert_eq!(
            error.message,
            "elevated policy role assignments require elevated role grant"
        );
        ensure_policy_roles_inside_actor_permission_ceiling(&super_admin, &[user_manager]).unwrap();
    }

    #[test]
    fn role_templates_are_unique_non_empty_and_never_grant_elevated_policy_features() {
        let templates = policy_role_templates();
        assert!(
            templates.len() >= 12,
            "expected enterprise starter coverage"
        );

        let mut template_keys = BTreeSet::new();
        let mut role_keys = BTreeSet::new();
        for template in templates {
            assert!(template_keys.insert(template.template_key.clone()));
            assert!(role_keys.insert(template.role_key.clone()));
            assert!(!template.display_name.trim().is_empty());
            assert!(!template.category.trim().is_empty());
            assert!(!template.permissions.is_empty());
            for permission in template.permissions {
                let feature = Feature::from_str(&permission.feature_key).unwrap();
                assert!(
                    !is_elevated_policy_feature(feature),
                    "template {} grants elevated feature {}",
                    template.template_key,
                    permission.feature_key
                );
                assert!(
                    !matches!(feature, Feature::UserManage),
                    "template {} grants admin user-management feature {}",
                    template.template_key,
                    permission.feature_key
                );
                let level = PermissionLevel::from_str(&permission.permission_level).unwrap();
                assert!(!matches!(level, PermissionLevel::Deny));
            }
        }
    }

    #[test]
    fn operational_persona_templates_cover_approved_role_set() {
        let templates = policy_role_templates();

        let find_template = |key: &str| {
            templates
                .iter()
                .find(|template| template.template_key == key)
                .unwrap_or_else(|| panic!("missing role template {key}"))
        };
        let assert_permissions = |template: &PolicyRoleTemplateResponse,
                                  expected: &[(&str, &str)]| {
            let actual: BTreeSet<(&str, &str)> = template
                .permissions
                .iter()
                .map(|permission| {
                    (
                        permission.feature_key.as_str(),
                        permission.permission_level.as_str(),
                    )
                })
                .collect();
            let expected: BTreeSet<(&str, &str)> = expected.iter().copied().collect();
            assert_eq!(actual, expected, "template {}", template.template_key);
        };

        let site = find_template("site_operations");
        assert_eq!(site.role_key, "site_operations");
        assert_eq!(site.display_name, "현장 운영 담당자");
        assert_eq!(site.category, "field_operations");
        assert_permissions(
            site,
            &[
                ("work_order_read_all", "allow"),
                ("work_order_start", "allow"),
                ("work_report_submit", "allow"),
                ("evidence_attach", "allow"),
                ("daily_plan_request", "request_only"),
            ],
        );

        let security = find_template("security_guard");
        assert_eq!(security.role_key, "security_guard");
        assert_eq!(security.display_name, "경비 담당자");
        assert_eq!(security.category, "security_operations");
        assert_permissions(
            security,
            &[
                ("work_order_read_all", "limited"),
                ("work_order_create", "request_only"),
                ("work_report_submit", "limited"),
                ("evidence_attach", "limited"),
            ],
        );

        let cleaning = find_template("cleaning_staff");
        assert_eq!(cleaning.role_key, "cleaning_staff");
        assert_eq!(cleaning.display_name, "미화 담당자");
        assert_eq!(cleaning.category, "cleaning_operations");
        assert_permissions(
            cleaning,
            &[
                ("work_order_read_all", "limited"),
                ("work_order_start", "limited"),
                ("work_report_submit", "allow"),
                ("evidence_attach", "limited"),
                ("daily_plan_request", "request_only"),
            ],
        );

        let dispatch_office = find_template("dispatch_office_staff");
        assert_eq!(dispatch_office.role_key, "dispatch_office_staff");
        assert_eq!(dispatch_office.display_name, "파견사무 담당자");
        assert_eq!(dispatch_office.category, "dispatch_office");
        assert_permissions(
            dispatch_office,
            &[
                ("work_order_create", "allow"),
                ("work_order_edit_intake", "allow"),
                ("work_order_read_all", "allow"),
                ("target_manage", "request_only"),
                ("mail_use", "allow"),
            ],
        );
    }

    #[test]
    fn policy_condition_validation_accepts_scoped_abac_pbac_metadata_only() {
        let conditions = validate_policy_conditions(&[
            PolicyConditionResponse {
                condition_key: "dept_scope".to_owned(),
                attribute: "department".to_owned(),
                operator: "in".to_owned(),
                values: vec!["정비팀".to_owned(), "야간조".to_owned()],
            },
            PolicyConditionResponse {
                condition_key: "purpose_scope".to_owned(),
                attribute: "purpose".to_owned(),
                operator: "equals".to_owned(),
                values: vec!["work_order_approval".to_owned()],
            },
        ])
        .unwrap();
        assert_eq!(conditions.len(), 2);
        assert_eq!(conditions[0].attribute, "department");
        assert_eq!(conditions[0].values, vec!["정비팀", "야간조"]);

        assert!(
            validate_policy_conditions(&[PolicyConditionResponse {
                condition_key: "dept_scope".to_owned(),
                attribute: "machinery".to_owned(),
                operator: "equals".to_owned(),
                values: vec!["굴삭기".to_owned()],
            },])
            .is_err()
        );

        assert!(
            validate_policy_conditions(&[
                PolicyConditionResponse {
                    condition_key: "dept_scope".to_owned(),
                    attribute: "department".to_owned(),
                    operator: "equals".to_owned(),
                    values: vec!["정비팀".to_owned()],
                },
                PolicyConditionResponse {
                    condition_key: "dept_scope".to_owned(),
                    attribute: "team".to_owned(),
                    operator: "equals".to_owned(),
                    values: vec!["A".to_owned()],
                },
            ])
            .is_err()
        );
    }
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
    let elevated_role_changes = elevated_roles_in(&roles);
    authorize_user_write(&principal, &elevated_role_changes, &body.branch_ids)?;

    let summary = state
        .store
        .create_user(CreateUserCommand {
            actor: principal.user_id,
            display_name: body.display_name,
            employee_id: body.employee_id,
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
    if query.offset.is_some_and(|offset| offset < 0) {
        return Err(RestError::from_kernel(KernelError::validation(
            "offset must be non-negative",
        )));
    }
    let page = state
        .store
        .list_users(
            &principal.branch_scope,
            UserListQuery {
                include_inactive: query.include_inactive,
                limit: query.limit,
                offset: query.offset,
            },
        )
        .await
        .map_err(RestError::from_store)?;
    Ok(Json(page))
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
    let target = state
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
        let elevated_role_changes =
            elevated_role_membership_changes(&target.roles, roles.as_ref())?;
        let target_branches = body
            .branch_ids
            .as_deref()
            .unwrap_or(target.branch_ids.as_slice());
        authorize_user_write(&principal, &elevated_role_changes, target_branches)?;
    }

    let summary = state
        .store
        .update_user(UpdateUserCommand {
            actor: principal.user_id,
            user_id: target_id,
            display_name: body.display_name,
            employee_id: body.employee_id,
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

/// Authorize a user create/update for elevated-role membership changes and
/// target branches, mirroring the `issue_admin_otp` IDOR hardening:
///   * Adding OR removing EXECUTIVE/SUPER_ADMIN requires `ElevatedRoleGrant`
///     (SUPER_ADMIN). Preserving an existing elevated role while changing other
///     fields must not block a branch admin from granting ordinary branch
///     permissions such as ADMIN to an existing executive.
///   * Otherwise the caller needs `SubordinateUserCreate` (limited) in EVERY
///     target branch, so a branch-scoped admin cannot mint users elsewhere.
fn authorize_user_write(
    principal: &Principal,
    elevated_role_changes: &BTreeSet<Role>,
    target_branches: &[BranchId],
) -> Result<(), RestError> {
    // Baseline user-management authority.
    authorize_org_manage(principal, Feature::UserManage)?;

    if !elevated_role_changes.is_empty() {
        // Only SUPER_ADMIN holds ElevatedRoleGrant; checked org-globally.
        let branch = representative_branch(&principal.branch_scope)?;
        return authorize(principal, Action::new(Feature::ElevatedRoleGrant), branch)
            .map_err(|_| RestError::forbidden("not allowed to change elevated roles"));
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

fn elevated_roles_in(roles: &BTreeSet<Role>) -> BTreeSet<Role> {
    roles
        .iter()
        .copied()
        .filter(|role| matches!(role, Role::Executive | Role::SuperAdmin))
        .collect()
}

fn elevated_role_membership_changes(
    current_roles: &[String],
    requested_roles: Option<&BTreeSet<Role>>,
) -> Result<BTreeSet<Role>, RestError> {
    let Some(requested_roles) = requested_roles else {
        return Ok(BTreeSet::new());
    };
    let current_roles = parse_roles(current_roles)?;
    Ok(elevated_roles_in(&current_roles)
        .symmetric_difference(&elevated_roles_in(requested_roles))
        .copied()
        .collect())
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
    mnt_platform_request_context::resolve_principal(verifier, state.pool(), headers)
        .await
        .map_err(rest_error_from_request_context)
}

fn rest_error_from_request_context(
    err: mnt_platform_request_context::RequestContextError,
) -> RestError {
    match err {
        mnt_platform_request_context::RequestContextError::VerifierUnavailable => {
            RestError::unavailable("JWT verification is not configured for identity API")
        }
        mnt_platform_request_context::RequestContextError::WrongTokenTier => {
            RestError::from_kernel(KernelError::forbidden(
                "token tier is not valid for this route",
            ))
        }
        mnt_platform_request_context::RequestContextError::AccessScope(error) => {
            RestError::from_kernel(error)
        }
        mnt_platform_request_context::RequestContextError::BranchScope(message)
        | mnt_platform_request_context::RequestContextError::EffectivePolicy(message) => {
            RestError::from_kernel(KernelError::internal(message))
        }
        mnt_platform_request_context::RequestContextError::MissingOrg => RestError::from_kernel(
            KernelError::internal("no tenant context is bound to the current request"),
        ),
        mnt_platform_request_context::RequestContextError::MissingBearer => {
            RestError::unauthorized("missing or malformed bearer token")
        }
        mnt_platform_request_context::RequestContextError::InvalidToken => {
            RestError::unauthorized("invalid bearer token")
        }
        mnt_platform_request_context::RequestContextError::InvalidClaim(message) => {
            RestError::unauthorized(format!("token claim is invalid: {message}"))
        }
    }
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
