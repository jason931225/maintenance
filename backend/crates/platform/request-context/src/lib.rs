//! Per-request tenant context for the multi-tenant FSM.
//!
//! The application connects to Postgres as the non-owner, RLS-enforced `mnt_rt`
//! role. Every tenant-scoped query must arm the `app.current_org` GUC with the
//! org of the *authenticated request*, or RLS returns zero rows (fail-closed).
//!
//! This crate is the single source of that org for the lifetime of one request:
//!
//! * [`CURRENT_ORG`] is a tokio [`task_local!`] holding the request's [`OrgId`].
//!   The shared middleware enters it with [`tokio::task::LocalKey::scope`] around
//!   the downstream handler, so any code running on that task can read it.
//! * [`current_org`] reads it and FAILS CLOSED when unset — it never defaults to
//!   a tenant. Adapter read paths call `with_org_conn(pool, current_org()?, ..)`.
//! * [`resolve_principal`] is the one merged copy of the per-crate
//!   `principal_from_headers` extractors: bearer → verify → claims → org from the
//!   verified `org` claim → branch scope re-resolved from the DB (the safer
//!   policy: a membership revocation takes effect immediately).
//!
//! Note on `tokio::spawn`: a freshly spawned task does NOT inherit the
//! task-local. A handler that spawns work which itself touches tenant-scoped
//! tables must re-enter the scope, e.g. `CURRENT_ORG.scope(org, async { .. })`.

use std::str::FromStr;

use axum::extract::Request;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, StatusCode};
use mnt_kernel_core::{
    AccessScope, AuditRequestContext, BranchScope, ErrorKind, KernelError, OrgId, TraceContext,
    UserId,
};
use mnt_platform_auth::{JwtVerifier, TenantAccessContext};
use mnt_platform_authz::{
    PlatformPrincipal, Principal, Role, SubjectFreshness, effective_branch_scope_for_tenant,
    resolve_branch_scope_in_org, resolve_effective_feature_grants_in_org,
};
use mnt_platform_group::group_admin_member_orgs;
use sqlx::PgPool;
use std::collections::BTreeSet;

tokio::task_local! {
    /// The tenant of the in-flight request. Set once per request by the shared
    /// middleware; read by [`current_org`].
    pub static CURRENT_ORG: OrgId;

    /// Trace and transport metadata captured once at the authenticated HTTP
    /// boundary, then reused by every audit event emitted by that request.
    static CURRENT_AUDIT_CONTEXT: RequestAuditContext;
}

/// Request-correlated metadata suitable for an [`mnt_kernel_core::AuditEvent`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequestAuditContext {
    pub trace: TraceContext,
    pub request: AuditRequestContext,
}

/// Why a request could not be given a tenant context.
#[derive(Debug, thiserror::Error)]
pub enum RequestContextError {
    /// No tenant is bound to the current task — the request never passed through
    /// the org middleware, or read code ran outside the request task (e.g. a bare
    /// `tokio::spawn` that did not re-enter [`CURRENT_ORG`]). Fail closed.
    #[error("no tenant context is bound to the current request")]
    MissingOrg,

    /// The Authorization header was absent or malformed.
    #[error("missing or malformed bearer token")]
    MissingBearer,

    /// The bearer token failed verification.
    #[error("invalid bearer token")]
    InvalidToken,

    /// A claim in an otherwise-valid token did not parse (subject, role, or org).
    #[error("token claim is invalid: {0}")]
    InvalidClaim(&'static str),

    /// JWT verification is not configured for this deployment.
    #[error("jwt verification is not configured")]
    VerifierUnavailable,

    /// Resolving the live branch scope from the database failed.
    #[error("failed to resolve branch scope: {0}")]
    BranchScope(String),

    /// Resolving runtime-effective custom policy grants from the database failed.
    #[error("failed to resolve effective policy: {0}")]
    EffectivePolicy(String),

    /// The verified JWT's hierarchy scope is not valid for this tenant route.
    #[error("access scope is not valid for this route: {0}")]
    AccessScope(KernelError),

    /// A PLATFORM token was presented to a tenant (`/api/*`) route, or a TENANT
    /// token was presented to a `/api/platform/*` route. The two tiers are strictly
    /// separated; crossing them is rejected before any handler runs.
    #[error("token tier is not valid for this route")]
    WrongTokenTier,
}

impl From<RequestContextError> for KernelError {
    /// Adapters surface tenancy failures through their domain error, which
    /// already converts from [`KernelError`]. A missing/invalid request context
    /// at a data-access site is an internal invariant violation (a tenant-scoped
    /// query reached the DB without a bound org), so it maps to an internal
    /// error — the request never produces tenant data on this path.
    fn from(err: RequestContextError) -> Self {
        match err {
            RequestContextError::AccessScope(error) => error,
            err => KernelError::internal(err.to_string()),
        }
    }
}

/// Read the tenant bound to the current request task.
///
/// FAILS CLOSED: returns [`RequestContextError::MissingOrg`] when no org is in
/// scope. It NEVER falls back to a default tenant. Adapter reads wrap their query
/// in `with_org_conn(&self.pool, current_org()?, ..)`.
pub fn current_org() -> Result<OrgId, RequestContextError> {
    CURRENT_ORG
        .try_with(|org| *org)
        .map_err(|_| RequestContextError::MissingOrg)
}

/// Return the audit context bound by [`with_request_context`].
///
/// `None` means the caller is outside an authenticated HTTP request. Mutation
/// handlers must treat that as an invariant failure instead of fabricating an
/// unrelated trace at the persistence boundary.
#[must_use]
pub fn current_audit_context() -> Option<RequestAuditContext> {
    CURRENT_AUDIT_CONTEXT.try_with(Clone::clone).ok()
}

/// Extract the raw bearer token from an Authorization header.
fn bearer_token(headers: &HeaderMap) -> Result<&str, RequestContextError> {
    headers
        .get(http::header::AUTHORIZATION)
        .ok_or(RequestContextError::MissingBearer)?
        .to_str()
        .map_err(|_| RequestContextError::MissingBearer)?
        .strip_prefix("Bearer ")
        .filter(|token| !token.trim().is_empty())
        .ok_or(RequestContextError::MissingBearer)
}

/// Resolve the authenticated [`Principal`] for a request from its headers.
///
/// This is the single merged copy of the formerly-duplicated
/// `principal_from_headers` extractors:
/// 1. parse the bearer token,
/// 2. verify it (the verifier already rejects a token whose `org` claim is not a
///    valid UUID),
/// 3. parse subject and roles,
/// 4. take the tenant from the verified `org` claim,
/// 5. re-resolve the live branch scope from the database rather than trusting the
///    token's `branches` claim, so a membership revocation takes effect at once.
pub async fn resolve_principal(
    verifier: &JwtVerifier,
    pool: &PgPool,
    headers: &HeaderMap,
) -> Result<Principal, RequestContextError> {
    let token = bearer_token(headers)?;
    resolve_principal_from_bearer_token(verifier, pool, token).await
}

/// Resolve a tenant [`Principal`] from an already-extracted bearer token.
///
/// Realtime WebSocket handshakes may carry the token in `Sec-WebSocket-Protocol`
/// rather than `Authorization`, but the security path after extraction must be
/// identical: verify, reject platform tier, parse roles/org/access scope,
/// re-resolve live branch memberships, and narrow by [`AccessScope`].
pub async fn resolve_principal_from_bearer_token(
    verifier: &JwtVerifier,
    pool: &PgPool,
    token: &str,
) -> Result<Principal, RequestContextError> {
    let claims = verifier
        .verify_access_token(token)
        .map_err(|_| RequestContextError::InvalidToken)?;

    // Tier separation: a PLATFORM token must NEVER resolve to a tenant principal.
    // Reject it here so a platform actor can never reach a tenant `/api/*` route
    // (and so its non-tenant `org` sentinel can never arm a real tenant GUC).
    if claims.platform {
        return Err(RequestContextError::WrongTokenTier);
    }

    let user_id = UserId::from_str(&claims.sub)
        .map_err(|_| RequestContextError::InvalidClaim("subject is not a valid user id"))?;
    let org_id = OrgId::from_str(&claims.org)
        .map_err(|_| RequestContextError::InvalidClaim("org is not a valid uuid"))?;
    let access_scope = claims
        .access_scope()
        .map_err(|_| RequestContextError::InvalidClaim("access scope is invalid"))?;
    let roles = claims
        .roles
        .iter()
        .map(|role| {
            Role::from_str(role).map_err(|_| RequestContextError::InvalidClaim("unknown role"))
        })
        .collect::<Result<BTreeSet<_>, _>>()?;

    // Subject authorization freshness snapshot carried by the verified token
    // (Cedar/PBAC activation, ADR-0021). Absent claims default to 0 (the
    // no-material baseline). SLICE-2 only sources this onto the principal; no
    // live authorization decision consults it and the Cedar path stays
    // unreachable. step_up_generation is not sourced for the RoleManage pilot.
    let authz_freshness = SubjectFreshness {
        policy_version: claims.authz_policy_version,
        subject_version: claims.authz_subject_version,
        session_generation: claims.session_generation,
        step_up_generation: None,
    };

    if claims.tenant_context == Some(TenantAccessContext::GroupAdmin) {
        return resolve_group_admin_tenant_context_principal(
            pool,
            user_id,
            org_id,
            access_scope,
            roles,
            claims.group_context_id.as_deref(),
            authz_freshness,
        )
        .await;
    }

    let role_vec = roles.iter().copied().collect::<Vec<_>>();
    let live_branch_scope = resolve_branch_scope_in_org(pool, org_id, user_id, &role_vec)
        .await
        .map_err(|err| RequestContextError::BranchScope(err.to_string()))?;
    let branch_scope = effective_branch_scope_for_tenant(live_branch_scope, access_scope, org_id)
        .map_err(RequestContextError::AccessScope)?;
    let effective_feature_grants =
        resolve_effective_feature_grants_in_org(pool, org_id, user_id, &branch_scope)
            .await
            .map_err(|err| RequestContextError::EffectivePolicy(err.to_string()))?;

    Ok(Principal::new(user_id, org_id, roles, branch_scope)
        .with_access_scope(access_scope)
        .with_effective_feature_grants(effective_feature_grants)
        .with_authz_freshness(authz_freshness))
}

async fn resolve_group_admin_tenant_context_principal(
    pool: &PgPool,
    user_id: UserId,
    org_id: OrgId,
    access_scope: AccessScope,
    roles: BTreeSet<Role>,
    group_context_id: Option<&str>,
    authz_freshness: SubjectFreshness,
) -> Result<Principal, RequestContextError> {
    let expected_roles = BTreeSet::from([Role::Admin]);
    if roles != expected_roles {
        return Err(RequestContextError::InvalidClaim(
            "group-admin tenant context must carry only ADMIN",
        ));
    }
    let group_id = group_context_id
        .ok_or(RequestContextError::InvalidClaim(
            "group-admin tenant context is missing group id",
        ))?
        .parse::<uuid::Uuid>()
        .map_err(|_| RequestContextError::InvalidClaim("group id is not a valid uuid"))?;

    let members = group_admin_member_orgs(pool, group_id, user_id)
        .await
        .map_err(|err| RequestContextError::BranchScope(err.to_string()))?;
    if !members
        .iter()
        .any(|member| member.org_id == org_id && member.status == "ACTIVE")
    {
        return Err(RequestContextError::AccessScope(KernelError::forbidden(
            "group-admin tenant context is no longer authorized for this organization",
        )));
    }

    // The live group resolver proves the actor still administers this
    // subsidiary. Project through the token's scope so future narrower
    // hierarchy scopes cannot widen here, then build a bounded tenant principal:
    // ADMIN permissions, all-branch only for this subsidiary, never SUPER_ADMIN.
    let branch_scope = effective_branch_scope_for_tenant(BranchScope::All, access_scope, org_id)
        .map_err(RequestContextError::AccessScope)?;
    let effective_feature_grants =
        resolve_effective_feature_grants_in_org(pool, org_id, user_id, &branch_scope)
            .await
            .map_err(|err| RequestContextError::EffectivePolicy(err.to_string()))?;

    Ok(
        Principal::new(user_id, org_id, expected_roles, branch_scope)
            .with_access_scope(access_scope)
            .with_effective_feature_grants(effective_feature_grants)
            .with_authz_freshness(authz_freshness),
    )
}

// ---------------------------------------------------------------------------
// Axum middleware
// ---------------------------------------------------------------------------

/// Apply the per-request tenant-context middleware to one authenticated router.
///
/// Called by each domain `router()` (so the behavior is testable per crate and
/// composes in the app). For every route on `router` it resolves the
/// [`Principal`], stores it in the request extensions (handlers can read
/// `Extension<Principal>`), and runs the downstream handler inside the
/// [`CURRENT_ORG`] scope — arming the request's tenant for every adapter
/// read/write.
///
/// Fail-closed: a request that cannot be resolved to a principal is rejected
/// before any handler runs, so no tenant-scoped query can execute without an org.
///
/// Pass the router's own `jwt_verifier` and a clone of its `pool`. Do NOT apply
/// it to pre-auth routes (login/refresh) or the realtime WS upgrade.
pub fn with_request_context<S>(
    router: axum::Router<S>,
    verifier: Option<JwtVerifier>,
    pool: PgPool,
) -> axum::Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    router.layer(axum::middleware::from_fn(
        move |mut request: Request, next: Next| {
            let verifier = verifier.clone();
            let pool = pool.clone();
            async move {
                let Some(verifier) = verifier.as_ref() else {
                    return error_response(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "JWT verification is not configured",
                    );
                };
                let principal = match resolve_principal(verifier, &pool, request.headers()).await {
                    Ok(principal) => principal,
                    Err(err) => return error_response_for(&err),
                };
                let org = principal.org_id;
                let audit_context = request_audit_context(request.headers());
                request.extensions_mut().insert(principal);
                CURRENT_ORG
                    .scope(
                        org,
                        CURRENT_AUDIT_CONTEXT.scope(audit_context, next.run(request)),
                    )
                    .await
            }
        },
    ))
}

fn request_audit_context(headers: &HeaderMap) -> RequestAuditContext {
    RequestAuditContext {
        trace: trace_context(headers),
        request: AuditRequestContext {
            // This is request metadata for audit investigation, never trusted
            // as an authorization or network-boundary assertion.
            ip: header_text(headers, "x-forwarded-for")
                .and_then(|forwarded| forwarded.split(',').next().map(str::trim))
                .filter(|value| !value.is_empty())
                .map(str::to_owned),
            user_agent: header_text(headers, http::header::USER_AGENT.as_str()).map(str::to_owned),
            auth_method: Some("bearer".to_owned()),
            device: header_text(headers, "x-device-id").map(str::to_owned),
        },
    }
}

fn header_text<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(name)?
        .to_str()
        .ok()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn trace_context(headers: &HeaderMap) -> TraceContext {
    header_text(headers, "traceparent")
        .and_then(parse_traceparent)
        .unwrap_or_else(TraceContext::generate)
}

fn parse_traceparent(value: &str) -> Option<TraceContext> {
    let mut fields = value.split('-');
    let version = fields.next()?;
    let trace_id = fields.next()?;
    let span_id = fields.next()?;
    let flags = fields.next()?;
    if fields.next().is_some()
        || version == "ff"
        || !is_lower_hex(version, 2)
        || !is_lower_hex(flags, 2)
        || trace_id.bytes().all(|byte| byte == b'0')
        || span_id.bytes().all(|byte| byte == b'0')
    {
        return None;
    }
    TraceContext::new(trace_id, span_id).ok()
}

fn is_lower_hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn error_response(status: StatusCode, message: &str) -> Response {
    (status, message.to_owned()).into_response()
}

fn error_response_for(err: &RequestContextError) -> Response {
    let status = match err {
        RequestContextError::VerifierUnavailable => StatusCode::SERVICE_UNAVAILABLE,
        RequestContextError::BranchScope(_) | RequestContextError::EffectivePolicy(_) => {
            StatusCode::INTERNAL_SERVER_ERROR
        }
        RequestContextError::AccessScope(error) if error.kind == ErrorKind::Forbidden => {
            StatusCode::FORBIDDEN
        }
        RequestContextError::AccessScope(_) => StatusCode::INTERNAL_SERVER_ERROR,
        // A valid token presented to the wrong tier is an authorization failure,
        // not an authentication one: the caller IS authenticated, just not for
        // this route. 403 keeps it distinct from "no/!invalid token" (401).
        RequestContextError::WrongTokenTier => StatusCode::FORBIDDEN,
        _ => StatusCode::UNAUTHORIZED,
    };
    error_response(status, &err.to_string())
}

// ---------------------------------------------------------------------------
// Platform tier extractor + middleware
// ---------------------------------------------------------------------------

/// Resolve the authenticated [`PlatformPrincipal`] for a request from its
/// headers.
///
/// Mirrors [`resolve_principal`] but for the SaaS-vendor PLATFORM tier:
/// 1. parse + verify the bearer token,
/// 2. REQUIRE `platform = true` — a tenant token is rejected here, so a tenant
///    admin can never reach `/api/platform/*`,
/// 3. parse the subject.
///
/// It deliberately resolves NO tenant org and NO branch scope: a platform
/// principal is not tenant-scoped, and platform handlers arm the specific
/// TARGET org themselves per action.
pub async fn resolve_platform_principal(
    verifier: &JwtVerifier,
    headers: &HeaderMap,
) -> Result<PlatformPrincipal, RequestContextError> {
    let token = bearer_token(headers)?;
    let claims = verifier
        .verify_access_token(token)
        .map_err(|_| RequestContextError::InvalidToken)?;

    // Tier separation: ONLY a platform token may reach a `/api/platform/*` route.
    if !claims.platform {
        return Err(RequestContextError::WrongTokenTier);
    }

    let user_id = UserId::from_str(&claims.sub)
        .map_err(|_| RequestContextError::InvalidClaim("subject is not a valid user id"))?;
    Ok(PlatformPrincipal::new(user_id))
}

/// Apply the PLATFORM extractor middleware to a `/api/platform/*` router.
///
/// Resolves the [`PlatformPrincipal`] (rejecting any tenant token) and stores it
/// in the request extensions for handlers to read as `Extension<PlatformPrincipal>`.
/// It does NOT enter the [`CURRENT_ORG`] tenant scope: the platform tier is not
/// tenant-scoped, and each platform write arms the TARGET org explicitly.
///
/// Fail-closed: a request that cannot be resolved to a platform principal is
/// rejected before any handler runs.
pub fn with_platform_context<S>(
    router: axum::Router<S>,
    verifier: Option<JwtVerifier>,
) -> axum::Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    router.layer(axum::middleware::from_fn(
        move |mut request: Request, next: Next| {
            let verifier = verifier.clone();
            async move {
                let Some(verifier) = verifier.as_ref() else {
                    return error_response(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "JWT verification is not configured",
                    );
                };
                let principal = match resolve_platform_principal(verifier, request.headers()).await
                {
                    Ok(principal) => principal,
                    Err(err) => return error_response_for(&err),
                };
                request.extensions_mut().insert(principal);
                next.run(request).await
            }
        },
    ))
}

/// Wrap a handler body in the tenant scope, for tests / non-router callers that
/// need to execute adapter code with a known tenant bound.
pub async fn scope_org<F, T>(org: OrgId, fut: F) -> T
where
    F: std::future::Future<Output = T>,
{
    CURRENT_ORG.scope(org, fut).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use mnt_platform_authz::{Action, Feature, authorize_org_wide};

    #[tokio::test]
    async fn nested_audit_context_scope_restores_outer_then_clears() {
        let outer = RequestAuditContext {
            trace: TraceContext::new("11111111111111111111111111111111", "1111111111111111")
                .unwrap(),
            request: AuditRequestContext {
                device: Some("outer-device".to_owned()),
                ..AuditRequestContext::default()
            },
        };
        let inner = RequestAuditContext {
            trace: TraceContext::new("22222222222222222222222222222222", "2222222222222222")
                .unwrap(),
            request: AuditRequestContext {
                device: Some("inner-device".to_owned()),
                ..AuditRequestContext::default()
            },
        };

        assert_eq!(current_audit_context(), None);
        CURRENT_AUDIT_CONTEXT
            .scope(outer.clone(), async {
                assert_eq!(current_audit_context(), Some(outer.clone()));
                CURRENT_AUDIT_CONTEXT
                    .scope(inner.clone(), async {
                        assert_eq!(current_audit_context(), Some(inner));
                    })
                    .await;
                assert_eq!(current_audit_context(), Some(outer));
            })
            .await;
        assert_eq!(current_audit_context(), None);
    }

    #[test]
    fn delegated_group_admin_principal_does_not_gain_executive_queue_triage() -> Result<(), String>
    {
        let principal = Principal::new(
            UserId::new(),
            OrgId::new(),
            BTreeSet::from([Role::Admin]),
            BranchScope::All,
        );

        let err = match authorize_org_wide(&principal, Action::new(Feature::OrgWideQueueTriage)) {
            Ok(()) => {
                return Err(
                    "delegated group-admin tenant context gained executive queue triage".to_owned(),
                );
            }
            Err(err) => err,
        };
        assert_eq!(err.kind, ErrorKind::Forbidden);
        Ok(())
    }
}
