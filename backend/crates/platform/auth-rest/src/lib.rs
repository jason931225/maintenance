//! Auth REST API.
//!
//! This layer exposes the passkey ceremony and token-family primitives from
//! `mnt-platform-auth` over HTTP. It does not own ceremony or refresh storage;
//! those remain in the platform auth/provisioning crates.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::collections::BTreeSet;
use std::str::FromStr;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use mnt_kernel_core::{
    AuditAction, AuditEvent, BranchId, BranchScope, ErrorKind, KernelError, OrgId, TraceContext,
    UserId,
};
use mnt_platform_auth::{
    AccessClaims, AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier,
    PasskeyAuthenticationCredential, PasskeyRegistrationCredential, PasskeyRegistrationStart,
    PasskeyService, RefreshTokenStore, RefreshTokenUseError, WebauthnSettings,
};
use mnt_platform_authz::{
    Action, Feature, Principal, Role, authorize, resolve_branch_scope_in_org,
    resolve_effective_feature_grants_in_org,
};
use mnt_platform_db::{
    DbError, read_subject_authz_freshness, with_audit, with_audits, with_org_conn,
};
use mnt_platform_email::{EmailSender, StubEmailSender};
use mnt_platform_group::GroupMemberOrg;
use mnt_platform_provisioning::{BootstrapCredentialStore, ProvisioningError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use time::{Duration, OffsetDateTime};
use url::Url;
use uuid::Uuid;

const DEFAULT_ACCESS_TOKEN_TTL: Duration = Duration::minutes(15);
const GROUP_ADMIN_TENANT_CONTEXT_TTL: Duration = Duration::minutes(15);
const GROUP_ADMIN_GROUP_ROLE: &str = "GROUP_ADMIN";
const GROUP_ADMIN_TENANT_ACTING_ROLE: &str = "GROUP_ADMIN_DELEGATED_ADMIN";

/// Request header a WEB client sets to opt into the cookie transport for the
/// refresh token. Mobile (iOS/Android) clients never send it and keep the
/// body-based refresh token. The value must equal [`AUTH_TRANSPORT_COOKIE`].
const AUTH_TRANSPORT_HEADER: &str = "x-auth-transport";
/// The single recognized value of [`AUTH_TRANSPORT_HEADER`].
const AUTH_TRANSPORT_COOKIE: &str = "cookie";
/// Name of the HttpOnly refresh-token cookie used by the web transport.
const REFRESH_COOKIE_NAME: &str = "mnt_refresh";
/// Path scope of the refresh cookie. Restricting it to the auth namespace means
/// the browser never attaches the refresh token to ordinary API calls — only to
/// the refresh/logout endpoints that need it.
const REFRESH_COOKIE_PATH: &str = "/api/v1/auth";

pub const SIGNUP_PATH: &str = "/api/v1/auth/signup";
pub const PASSKEY_REGISTER_START_PATH: &str = "/api/v1/auth/passkey/register/start";
pub const PASSKEY_REGISTER_FINISH_PATH: &str = "/api/v1/auth/passkey/register/finish";
pub const PASSKEY_LOGIN_START_PATH: &str = "/api/v1/auth/passkey/login/start";
pub const PASSKEY_LOGIN_FINISH_PATH: &str = "/api/v1/auth/passkey/login/finish";
pub const OTP_REDEEM_PATH: &str = "/api/v1/auth/otp/redeem";
pub const ADMIN_OTP_ISSUE_PATH: &str = "/api/v1/auth/admin/otp/issue";
pub const ADMIN_CREDENTIAL_RESET_PATH: &str = "/api/v1/auth/admin/credential-reset";
pub const AUTH_PASSKEYS_PATH: &str = "/api/v1/auth/passkeys";
pub const AUTH_PASSKEY_PATH_TEMPLATE: &str = "/api/v1/auth/passkeys/{id}";
pub const PASSKEY_ENROLL_HANDOFF_PATH: &str = "/api/v1/auth/passkey/enroll-handoff";
pub const DEVICE_LOGIN_START_PATH: &str = "/api/v1/auth/device-login/start";
pub const DEVICE_LOGIN_POLL_PATH: &str = "/api/v1/auth/device-login/poll";
pub const DEVICE_LOGIN_APPROVE_PATH: &str = "/api/v1/auth/device-login/approve";
pub const DEVICE_LOGIN_APPROVE_SESSION_PATH: &str = "/api/v1/auth/device-login/approve-session";
pub const PRIVACY_CONSENT_STATUS_PATH: &str = "/api/v1/auth/privacy-consent/status";
pub const PRIVACY_CONSENT_ACCEPT_PATH: &str = "/api/v1/auth/privacy-consent/accept";
pub const TOKEN_REFRESH_PATH: &str = "/api/v1/auth/token/refresh";
pub const LOGOUT_PATH: &str = "/api/v1/auth/logout";
pub const GROUP_ADMIN_GROUPS_PATH: &str = "/api/v1/group-admin/groups";
pub const GROUP_ADMIN_TENANT_CONTEXT_PATH: &str = "/api/v1/group-admin/tenant-context";
pub const GROUP_ADMIN_TENANT_CONTEXT_EXIT_PATH: &str = "/api/v1/group-admin/tenant-context/exit";
/// Local-dev-only role-switch endpoint. The const itself only exists when the
/// `dev-auth` feature is compiled in — see the `dev_auth` module docs.
#[cfg(feature = "dev-auth")]
pub const DEV_AUTH_SESSION_PATH: &str = "/api/v1/dev-auth/session";
pub const AUTH_ROUTE_PATHS: &[&str] = &[
    SIGNUP_PATH,
    PASSKEY_REGISTER_START_PATH,
    PASSKEY_REGISTER_FINISH_PATH,
    PASSKEY_LOGIN_START_PATH,
    PASSKEY_LOGIN_FINISH_PATH,
    OTP_REDEEM_PATH,
    ADMIN_OTP_ISSUE_PATH,
    ADMIN_CREDENTIAL_RESET_PATH,
    AUTH_PASSKEYS_PATH,
    AUTH_PASSKEY_PATH_TEMPLATE,
    PASSKEY_ENROLL_HANDOFF_PATH,
    DEVICE_LOGIN_START_PATH,
    DEVICE_LOGIN_POLL_PATH,
    DEVICE_LOGIN_APPROVE_PATH,
    DEVICE_LOGIN_APPROVE_SESSION_PATH,
    PRIVACY_CONSENT_STATUS_PATH,
    PRIVACY_CONSENT_ACCEPT_PATH,
    TOKEN_REFRESH_PATH,
    LOGOUT_PATH,
];

/// Default lifetime for an open-signup OTP. A self-service code is a bearer
/// secret delivered by email; 1h comfortably spans an enroll-now session while
/// keeping the leaked-code window short.
const DEFAULT_SIGNUP_OTP_TTL: Duration = Duration::hours(1);

/// Default admin-issued OTP lifetime when the issuer omits a TTL. Tightened to
/// 4h (from 24h): a bootstrap OTP is a bearer secret relayed out-of-band, so a
/// shorter default shrinks the window in which a leaked code is redeemable while
/// still comfortably spanning a single onboarding session. An issuer who needs
/// longer can pass an explicit `ttl_seconds`, clamped to [`MAX_OTP_TTL`].
const DEFAULT_OTP_TTL: Duration = Duration::hours(4);
/// Upper bound on a caller-specified OTP TTL; rejects absurd values. Tightened to
/// 24h (from 30d): no legitimate first sign-in needs a code that outlives a day.
const MAX_OTP_TTL: Duration = Duration::hours(24);

/// Lifetime of a cross-device passkey-enrollment HANDOFF code. Deliberately SHORT
/// (5 min, distinct from the 4h admin OTP): the handoff is minted by the user for
/// themselves and scanned onto a second device within seconds, so a tight window
/// keeps the leaked-code blast radius minimal for this credential-handoff path.
const ENROLL_HANDOFF_TTL: Duration = Duration::minutes(5);

/// Lifetime of a desktop-login QR handoff. The QR approve token and desktop poll
/// token are separate bearer secrets; both expire quickly like enrollment QR.
const DEVICE_LOGIN_HANDOFF_TTL: Duration = Duration::minutes(5);

/// Required first-login privacy/terms notice version. This is an engineering
/// control, not a substitute for counsel-approved policy text: bump it whenever
/// the required collection/use notice or service terms materially change so users
/// must accept the new version before initial passkey enrollment.
const REQUIRED_PRIVACY_TERMS_VERSION: &str = "kr-pipa-v1-2026-06-25";

/// Fixed-window length for the DB-backed unauthenticated-endpoint rate limiter.
const RATE_LIMIT_WINDOW: Duration = Duration::minutes(1);
/// Per-client-IP cap per window on unauthenticated auth endpoints.
const RATE_LIMIT_PER_IP: i64 = 10;
/// Per-device cap per window (device id is optional and client-controlled).
const RATE_LIMIT_PER_DEVICE: i64 = 10;
/// Global per-endpoint cap per window — defense-in-depth against distributed
/// guessing across many IPs/devices.
const RATE_LIMIT_GLOBAL: i64 = 100;

#[derive(Debug, Clone)]
pub struct AuthRestConfig {
    pub rp_id: String,
    pub rp_origin: String,
    pub rp_name: String,
    pub ceremony_ttl: Duration,
    pub jwt_issuer: String,
    pub jwt_audience: String,
    pub jwt_private_key_pem: String,
    pub jwt_public_key_pem: String,
    pub refresh_token_ttl: Duration,
    /// Absolute lifetime cap on a refresh-token family, measured from the
    /// family's creation. Past this ceiling a rotation is rejected and the family
    /// revoked, forcing a fresh primary authentication (NIST 800-63B AAL2).
    /// Sourced from `MNT_REFRESH_FAMILY_ABSOLUTE_TTL_SECS` (default 24h).
    pub refresh_family_absolute_ttl: Duration,
    /// Number of trusted reverse proxies in front of this service. The client IP
    /// used for rate limiting is the Nth-from-the-right `X-Forwarded-For` entry
    /// (the rightmost entry is appended by the closest proxy). Assumes the ingress
    /// proxy sets/strips XFF so the left-most entries cannot be spoofed past it.
    pub trusted_proxy_count: usize,
    /// Whether the web refresh cookie carries the `Secure` attribute (`true` in
    /// production over HTTPS). Disabled (`MNT_COOKIE_SECURE=false`) only for local
    /// http dev where the browser would otherwise drop a `Secure` cookie on
    /// `http://localhost`.
    pub cookie_secure: bool,
}

#[derive(Clone)]
pub struct AuthRestState {
    pool: PgPool,
    services: Option<AuthServices>,
    trusted_proxy_count: usize,
}

impl std::fmt::Debug for AuthRestState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthRestState")
            .field("services_configured", &self.services.is_some())
            .finish_non_exhaustive()
    }
}

#[derive(Clone)]
struct AuthServices {
    passkeys: PasskeyService,
    jwt_issuer: JwtIssuer,
    jwt_verifier: JwtVerifier,
    refresh_tokens: RefreshTokenStore,
    bootstrap_credentials: BootstrapCredentialStore,
    /// The console's public origin (the WebAuthn RP origin, e.g.
    /// `https://console.knllogistic.com`). Used to build the cross-device
    /// passkey-enrollment handoff URL the frontend renders as a QR; the phone
    /// opens it to redeem the handoff and enroll a passkey. Always a validated,
    /// scheme+host origin with no path/query (parsed once at config time).
    rp_origin: Url,
    refresh_token_ttl: Duration,
    refresh_family_absolute_ttl: Duration,
    cookie_secure: bool,
    /// Outbound OTP email sender for open self-service signup (#38). Always
    /// present: a real SMTP sender when `MNT_EMAIL_*` is configured, otherwise a
    /// `StubEmailSender` that logs the OTP (so dev/e2e read it from the logs).
    email_sender: Arc<dyn EmailSender>,
}

impl AuthRestState {
    #[must_use]
    pub fn disabled(pool: PgPool) -> Self {
        Self {
            pool,
            services: None,
            // Conservative default; never reached for rate limiting (no routes
            // are served when auth is disabled), but keeps the field well-defined.
            trusted_proxy_count: 1,
        }
    }

    pub fn new(pool: PgPool, config: AuthRestConfig) -> Result<Self, AuthRestConfigError> {
        let rp_origin = Url::parse(&config.rp_origin)?;
        // Keep a copy of the validated origin to build the cross-device enrollment
        // handoff URL; `WebauthnSettings` takes ownership of the other clone below.
        let handoff_origin = rp_origin.clone();
        let passkeys = PasskeyService::new(WebauthnSettings {
            rp_id: config.rp_id,
            rp_origin,
            rp_name: config.rp_name,
            extra_allowed_origins: Vec::new(),
            ceremony_ttl: config.ceremony_ttl,
        })?;
        let jwt_settings = JwtSettings {
            issuer: config.jwt_issuer,
            audience: config.jwt_audience,
            access_token_ttl: DEFAULT_ACCESS_TOKEN_TTL,
        };
        let jwt_issuer = JwtIssuer::from_es256_pem(
            jwt_settings.clone(),
            config.jwt_private_key_pem.as_bytes(),
            config.jwt_public_key_pem.as_bytes(),
        )?;
        let jwt_verifier =
            JwtVerifier::from_es256_public_pem(jwt_settings, config.jwt_public_key_pem.as_bytes())?;

        Ok(Self {
            pool,
            services: Some(AuthServices {
                passkeys,
                jwt_issuer,
                jwt_verifier,
                refresh_tokens: RefreshTokenStore,
                bootstrap_credentials: BootstrapCredentialStore,
                rp_origin: handoff_origin,
                refresh_token_ttl: config.refresh_token_ttl,
                refresh_family_absolute_ttl: config.refresh_family_absolute_ttl,
                cookie_secure: config.cookie_secure,
                // Stub by default; the composition root swaps in the live SMTP
                // sender via `with_email_sender` when `MNT_EMAIL_*` is configured.
                email_sender: Arc::new(StubEmailSender),
            }),
            trusted_proxy_count: config.trusted_proxy_count.max(1),
        })
    }

    /// Install the outbound OTP email sender used by the open-signup endpoint.
    /// The composition root calls this with the app's `Arc<dyn EmailSender>`
    /// (live SMTP or the logging stub). A no-op when auth services are disabled.
    #[must_use]
    pub fn with_email_sender(mut self, email_sender: Arc<dyn EmailSender>) -> Self {
        if let Some(services) = self.services.as_mut() {
            services.email_sender = email_sender;
        }
        self
    }
}

#[derive(Debug, thiserror::Error)]
pub enum AuthRestConfigError {
    #[error("invalid WebAuthn RP origin: {0}")]
    Url(#[from] url::ParseError),

    #[error("auth service configuration error: {0}")]
    Auth(#[from] mnt_platform_auth::AuthError),
}

pub fn router(state: AuthRestState) -> Router {
    let router = Router::new()
        .route(SIGNUP_PATH, post(signup))
        .route(PASSKEY_REGISTER_START_PATH, post(start_registration))
        .route(PASSKEY_REGISTER_FINISH_PATH, post(finish_registration))
        .route(PASSKEY_LOGIN_START_PATH, post(start_login))
        .route(PASSKEY_LOGIN_FINISH_PATH, post(finish_login))
        .route(OTP_REDEEM_PATH, post(redeem_otp))
        .route(ADMIN_OTP_ISSUE_PATH, post(issue_admin_otp))
        .route(ADMIN_CREDENTIAL_RESET_PATH, post(admin_credential_reset))
        .route(AUTH_PASSKEYS_PATH, get(list_self_passkeys))
        .route(AUTH_PASSKEY_PATH_TEMPLATE, delete(delete_self_passkey))
        .route(PASSKEY_ENROLL_HANDOFF_PATH, post(enroll_handoff))
        .route(DEVICE_LOGIN_START_PATH, post(start_device_login))
        .route(DEVICE_LOGIN_POLL_PATH, post(poll_device_login))
        .route(DEVICE_LOGIN_APPROVE_PATH, post(approve_device_login))
        .route(
            DEVICE_LOGIN_APPROVE_SESSION_PATH,
            post(approve_device_login_session),
        )
        .route(PRIVACY_CONSENT_STATUS_PATH, post(privacy_consent_status))
        .route(PRIVACY_CONSENT_ACCEPT_PATH, post(accept_privacy_consent))
        .route(TOKEN_REFRESH_PATH, post(refresh_token))
        .route(LOGOUT_PATH, post(logout))
        .route(GROUP_ADMIN_GROUPS_PATH, get(list_group_admin_groups))
        .route(
            GROUP_ADMIN_TENANT_CONTEXT_PATH,
            post(start_group_admin_tenant_context),
        )
        .route(
            GROUP_ADMIN_TENANT_CONTEXT_EXIT_PATH,
            post(exit_group_admin_tenant_context),
        );
    #[cfg(feature = "dev-auth")]
    let router = router.route(DEV_AUTH_SESSION_PATH, post(dev_auth_session));
    router.with_state(state)
}

#[derive(Debug, Deserialize)]
struct RegisterStartRequest {
    username: Option<String>,
    display_name: Option<String>,
    /// Fresh step-up assertion of an EXISTING passkey, REQUIRED when the
    /// authenticated user already has one or more passkeys (self-service
    /// add-device). Omitted only for initial enrollment (the user has zero
    /// passkeys). The ceremony id comes from a preceding `passkey/login/start`.
    step_up: Option<StepUpAssertion>,
}

/// A step-up proof: a discoverable authentication ceremony id plus the asserted
/// credential. Verified with user verification (UV) required before a new
/// credential is issued, so a stolen session alone cannot add a passkey.
#[derive(Debug, Deserialize)]
struct StepUpAssertion {
    ceremony_id: Uuid,
    credential: PasskeyAuthenticationCredential,
}

#[derive(Debug, Serialize)]
struct RegisterStartResponse {
    ceremony_id: Uuid,
    challenge: serde_json::Value,
    #[serde(with = "time::serde::rfc3339")]
    expires_at: OffsetDateTime,
}

#[derive(Debug, Deserialize)]
struct RegisterFinishRequest {
    ceremony_id: Uuid,
    credential: PasskeyRegistrationCredential,
}

#[derive(Debug, Serialize)]
struct RegisterFinishResponse {
    passkey_id: Uuid,
    user_id: Uuid,
    credential_id: String,
}

#[derive(Debug, Serialize)]
struct LoginStartResponse {
    ceremony_id: Uuid,
    challenge: serde_json::Value,
    #[serde(with = "time::serde::rfc3339")]
    expires_at: OffsetDateTime,
}

#[derive(Debug, Deserialize)]
struct LoginFinishRequest {
    ceremony_id: Uuid,
    credential: PasskeyAuthenticationCredential,
}

/// Open self-service signup (#38). The body carries only the email address; the
/// server creates a new low-privilege MEMBER account, mints a one-time code, and
/// emails it. The caller then redeems that code via `/auth/otp/redeem` and
/// enrolls a passkey — the same flow a pre-provisioned user follows.
#[derive(Debug, Deserialize)]
struct SignupRequest {
    email: String,
}

/// Signup acknowledgement. Deliberately reveals NOTHING about whether the email
/// was newly registered — a one-time code is "sent" (logged by the stub in
/// dev/e2e) and the client always proceeds to the OTP step. No token is minted
/// here; sign-in happens only after the code is redeemed.
#[derive(Debug, Serialize)]
struct SignupResponse {
    /// Always `true`. Present so the response body is non-empty and the contract
    /// is stable if richer status is added later.
    accepted: bool,
}

/// First sign-in via a one-time admin-issued (or cold-start) OTP. The body
/// carries only the OTP; the user is resolved from the consumed credential.
#[derive(Debug, Deserialize)]
struct OtpRedeemRequest {
    otp: String,
}

/// OTP first sign-in result: a normal session token pair plus a flag telling the
/// frontend to force passkey enrollment in initial settings.
///
/// `refresh_token` is `null` in the cookie transport (web): the token is set as
/// an HttpOnly cookie instead and must never reach web JS. It is `Some` in the
/// body transport (mobile).
#[derive(Debug, Serialize)]
struct OtpRedeemResponse {
    access_token: String,
    refresh_token: Option<String>,
    token_type: &'static str,
    #[serde(with = "time::serde::rfc3339")]
    refresh_expires_at: OffsetDateTime,
    requires_passkey_setup: bool,
}

/// Admin request to issue a one-time sign-in OTP for a pre-provisioned,
/// zero-credential user. `ttl_seconds` is optional and defaults to 24h.
#[derive(Debug, Deserialize)]
struct AdminIssueOtpRequest {
    user_id: Uuid,
    branch_id: Uuid,
    ttl_seconds: Option<i64>,
}

/// The issued one-time OTP (returned once, never stored in plaintext) and its
/// expiry. The caller relays this to the new user out-of-band.
#[derive(Debug, Serialize)]
struct AdminIssueOtpResponse {
    user_id: Uuid,
    otp: String,
    #[serde(with = "time::serde::rfc3339")]
    expires_at: OffsetDateTime,
}

/// Admin request to reset a user's credentials for account recovery: revokes ALL
/// the target's passkeys and mints a fresh single-use sign-in OTP. The body
/// carries only the target user id; the target lives in the caller's own tenant.
#[derive(Debug, Deserialize)]
struct AdminCredentialResetRequest {
    user_id: Uuid,
}

/// The fresh one-time OTP minted by a credential reset (returned once, never
/// stored in plaintext) and its expiry. The admin relays this to the locked-out
/// user out-of-band so they can sign in and re-enroll a passkey.
#[derive(Debug, Serialize)]
struct AdminCredentialResetResponse {
    user_id: Uuid,
    otp: String,
    #[serde(with = "time::serde::rfc3339")]
    expires_at: OffsetDateTime,
}

/// Cross-device self passkey-enrollment handoff request. The body carries NO
/// user/org — those come from the caller's verified access token, so a caller can
/// only ever mint a handoff for ITSELF. `step_up` is required ONLY when the caller
/// is already enrolled (add-device): exactly like `register/start`, an
/// already-enrolled user must assert an existing passkey (UV) before a fresh
/// enrollment credential is issued, so a stolen bearer token alone cannot mint a
/// device-enrollment handoff. A mid-onboarding user (zero passkeys) omits it.
#[derive(Debug, Deserialize, Default)]
struct EnrollHandoffRequest {
    step_up: Option<StepUpAssertion>,
}

/// The minted single-use, short-TTL passkey-enrollment handoff code (returned
/// once, never stored in plaintext) plus the ready-to-encode enrollment URL the
/// frontend renders as a QR. The phone opens `enroll_url`, redeems the `otp` via
/// the ordinary first-sign-in path, and enrolls a platform passkey on the phone.
#[derive(Debug, Serialize)]
struct EnrollHandoffResponse {
    otp: String,
    #[serde(with = "time::serde::rfc3339")]
    expires_at: OffsetDateTime,
    enroll_url: String,
    /// Desktop poll token paired to this phone-enrollment QR. Present so the PC
    /// can finish its own session after the phone registers/authenticates.
    poll_token: String,
}

/// Desktop-initiated, phone-approved login handoff. The poll token stays only in
/// the desktop browser; the approve URL carries a distinct token for the phone.
#[derive(Debug, Serialize)]
struct DeviceLoginStartResponse {
    poll_token: String,
    approve_url: String,
    #[serde(with = "time::serde::rfc3339")]
    expires_at: OffsetDateTime,
}

#[derive(Debug, Deserialize)]
struct DeviceLoginPollRequest {
    poll_token: String,
}

/// Poll response for the desktop. Pending/expired responses carry no tokens; an
/// approved response carries a normal token pair and sets the web refresh cookie
/// when the caller uses cookie transport.
#[derive(Debug, Serialize)]
struct DeviceLoginPollResponse {
    status: &'static str,
    access_token: Option<String>,
    refresh_token: Option<String>,
    token_type: Option<&'static str>,
    #[serde(with = "time::serde::rfc3339::option")]
    refresh_expires_at: Option<OffsetDateTime>,
    requires_passkey_setup: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct DeviceLoginApproveRequest {
    approve_token: String,
    ceremony_id: Uuid,
    credential: PasskeyAuthenticationCredential,
}

#[derive(Debug, Deserialize)]
struct DeviceLoginApproveSessionRequest {
    approve_token: String,
}

/// Passkey credential summary for the authenticated user's self-management
/// surface. Carries no secret material: never the raw credential id, public key,
/// or serialized passkey blob.
#[derive(Debug, Serialize)]
struct PasskeySummary {
    id: Uuid,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    last_used_at: Option<OffsetDateTime>,
}

/// Required first-login privacy/terms acceptance. The booleans are deliberately
/// explicit and separate so the client cannot send one bundled "agree all" flag
/// for legally distinct items.
#[derive(Debug, Deserialize)]
struct PrivacyConsentAcceptRequest {
    policy_version: String,
    privacy_collection: bool,
    terms_of_service: bool,
}

#[derive(Debug, Serialize)]
struct PrivacyConsentStatusResponse {
    policy_version: &'static str,
    accepted: bool,
    #[serde(with = "time::serde::rfc3339::option")]
    accepted_at: Option<OffsetDateTime>,
}

/// A minted access/refresh pair. `refresh_token` is `null` in the cookie
/// transport (web) — the refresh token rides in the HttpOnly `mnt_refresh`
/// cookie instead — and `Some` in the body transport (mobile). The access token
/// is ALWAYS in the body: it stays a short-lived in-memory bearer token, never a
/// cookie. `requires_passkey_setup` is true only for an OTP-created session whose
/// user still has zero passkeys, so a refresh cannot bypass initial enrollment.
#[derive(Debug, Serialize)]
struct TokenPairResponse {
    access_token: String,
    refresh_token: Option<String>,
    token_type: &'static str,
    #[serde(with = "time::serde::rfc3339")]
    refresh_expires_at: OffsetDateTime,
    requires_passkey_setup: bool,
}

#[derive(Debug, Serialize)]
struct GroupAdminMemberOrgResponse {
    id: Uuid,
    slug: String,
    name: String,
    status: String,
}

#[derive(Debug, Serialize)]
struct GroupAdminGroupResponse {
    id: Uuid,
    slug: String,
    name: String,
    status: String,
    members: Vec<GroupAdminMemberOrgResponse>,
}

#[derive(Debug, Serialize)]
struct GroupAdminGroupsResponse {
    groups: Vec<GroupAdminGroupResponse>,
}

#[derive(Debug, Deserialize)]
struct GroupAdminTenantContextStartRequest {
    org_id: Uuid,
}

#[derive(Debug, Serialize)]
struct GroupAdminTenantContextStartResponse {
    access_token: String,
    token_type: &'static str,
    acting_org_id: Uuid,
    acting_org_name: String,
    acting_role: &'static str,
    #[serde(with = "time::serde::rfc3339")]
    expires_at: OffsetDateTime,
}

#[derive(Debug, Deserialize)]
struct GroupAdminTenantContextExitRequest {
    org_id: Uuid,
}

#[derive(Debug, Serialize)]
struct GroupAdminTenantContextExitResponse {
    ended: bool,
}

/// The refresh-token body is OPTIONAL: web (cookie transport) sends the token in
/// the `mnt_refresh` cookie and an empty/absent body, while mobile sends it here.
#[derive(Debug, Deserialize, Default)]
struct RefreshTokenRequest {
    refresh_token: Option<String>,
}

/// Logout accepts the refresh token from the `mnt_refresh` cookie (web) or from
/// this body (mobile); the field is therefore optional.
#[derive(Debug, Deserialize, Default)]
struct LogoutRequest {
    refresh_token: Option<String>,
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

#[derive(Debug)]
struct RestError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl RestError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "bad_request",
            message: message.into(),
        }
    }

    fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "unauthorized",
            message: message.into(),
        }
    }

    fn conflict(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            code: "conflict",
            message: message.into(),
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            code: "not_found",
            message: message.into(),
        }
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "service_unavailable",
            message: message.into(),
        }
    }

    fn bad_gateway(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            code: "bad_gateway",
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

    fn too_many_requests() -> Self {
        Self {
            status: StatusCode::TOO_MANY_REQUESTS,
            code: "too_many_requests",
            message: "too many requests; please retry later".to_owned(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "internal",
            message: message.into(),
        }
    }

    fn from_kernel(error: KernelError) -> Self {
        match error.kind {
            ErrorKind::Validation => RestError::bad_request(error.message),
            ErrorKind::NotFound => RestError::not_found(error.message),
            ErrorKind::Forbidden => RestError::forbidden(error.message),
            ErrorKind::Conflict | ErrorKind::InvalidTransition => {
                RestError::conflict(error.message)
            }
            ErrorKind::Internal => RestError::internal(error.message),
        }
    }

    fn from_refresh(error: RefreshTokenUseError) -> Self {
        match error {
            RefreshTokenUseError::InvalidToken
            | RefreshTokenUseError::Expired
            | RefreshTokenUseError::FamilyRevoked
            | RefreshTokenUseError::ReuseDetected => Self::unauthorized(error.to_string()),
            RefreshTokenUseError::Storage => Self::internal(error.to_string()),
        }
    }

    fn from_provisioning(error: ProvisioningError) -> Self {
        match error {
            // Generic, non-revealing message for any OTP-redeem rejection so the
            // client cannot distinguish unknown vs expired vs already-used.
            ProvisioningError::InvalidBootstrapCredential => {
                Self::unauthorized("invalid or expired one-time code")
            }
            ProvisioningError::UserAlreadyHasPasskey
            | ProvisioningError::ActiveBootstrapCredentialExists => {
                Self::conflict(error.to_string())
            }
            ProvisioningError::NotFound(_) => Self::not_found(error.to_string()),
            ProvisioningError::Conflict(_) => Self::conflict(error.to_string()),
            ProvisioningError::Sqlx(_)
            | ProvisioningError::Db(_)
            | ProvisioningError::Json(_)
            | ProvisioningError::Auth(_)
            | ProvisioningError::Kernel(_)
            | ProvisioningError::InvalidRoster(_)
            | ProvisioningError::UnknownBranch { .. } => Self::internal(error.to_string()),
        }
    }
}

impl From<DbError> for RestError {
    fn from(value: DbError) -> Self {
        Self::internal(value.to_string())
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

/// Start passkey registration for the AUTHENTICATED session user.
///
/// Registration is always an authenticated action now (initial-settings passkey
/// enrollment after an OTP first sign-in, or adding a device later). The
/// usernameless first sign-in goes through `/auth/otp/redeem`, not here, so this
/// path no longer accepts a bootstrap token.
///
/// Anti-silent-add step-up: when the caller ALREADY has one or more passkeys,
/// adding another requires a fresh step-up assertion (`step_up`) of an existing
/// passkey with user verification, so a stolen bearer token alone cannot enroll a
/// new credential. Initial enrollment (zero existing passkeys) needs no step-up —
/// there is no credential to assert, and the open bootstrap code still gates the
/// finish.
async fn start_registration(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    Json(body): Json<RegisterStartRequest>,
) -> Result<Json<RegisterStartResponse>, RestError> {
    let services = state.services()?;
    let (user_id, org_id) = authenticated_user_context(services, &headers)?;
    let user = load_user_auth_context_in_org(&state.pool, org_id, user_id).await?;

    // Step-up gate: an already-enrolled user MUST assert an existing passkey (UV)
    // before a new credential challenge is issued. A user with zero passkeys is
    // doing initial enrollment and is exempt.
    let existing_passkeys = services
        .passkeys
        .count_user_passkeys(&state.pool, org_id, user_id)
        .await
        .map_err(|err| RestError::internal(err.to_string()))?;
    if existing_passkeys == 0 {
        ensure_required_privacy_consent(&state.pool, org_id, user_id).await?;
    } else {
        let step_up = body.step_up.ok_or_else(|| {
            RestError::unauthorized(
                "adding a passkey requires a step-up assertion of an existing passkey",
            )
        })?;
        services
            .passkeys
            .verify_step_up_for_user(
                &state.pool,
                step_up.ceremony_id,
                step_up.credential,
                user_id,
            )
            .await
            .map_err(|err| RestError::unauthorized(err.to_string()))?;
    }

    let ceremony = services
        .passkeys
        .start_registration(
            &state.pool,
            org_id,
            PasskeyRegistrationStart {
                user_id,
                username: body.username.unwrap_or(user.username),
                display_name: body.display_name.unwrap_or(user.display_name),
            },
        )
        .await
        .map_err(|err| RestError::internal(err.to_string()))?;

    Ok(Json(RegisterStartResponse {
        ceremony_id: ceremony.ceremony_id,
        challenge: serde_json::to_value(ceremony.challenge)
            .map_err(|err| RestError::internal(err.to_string()))?,
        expires_at: ceremony.expires_at,
    }))
}

/// Finish passkey registration for the AUTHENTICATED session user.
async fn finish_registration(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    Json(body): Json<RegisterFinishRequest>,
) -> Result<(StatusCode, Json<RegisterFinishResponse>), RestError> {
    let services = state.services()?;
    let (user_id, org_id) = authenticated_user_context(services, &headers)?;
    ensure_registration_ceremony_owner(&state.pool, body.ceremony_id, user_id).await?;
    let existing_passkeys = services
        .passkeys
        .count_user_passkeys(&state.pool, org_id, user_id)
        .await
        .map_err(|err| RestError::internal(err.to_string()))?;
    if existing_passkeys == 0 {
        ensure_required_privacy_consent(&state.pool, org_id, user_id).await?;
    }
    let now = OffsetDateTime::now_utc();

    // Insert the passkey AND consume the user's open one-time code in ONE transaction,
    // so a successful enrollment — and only that — burns the code atomically. A redeem
    // never consumes the code, so a failed/cancelled enrollment leaves it usable; the
    // user can retry until a passkey actually sticks.
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|err| RestError::internal(err.to_string()))?;
    let passkey = services
        .passkeys
        .finish_registration_in_tx(&mut tx, org_id, body.ceremony_id, body.credential, now)
        .await
        .map_err(|err| RestError::internal(err.to_string()))?;
    services
        .bootstrap_credentials
        .consume_open_credentials_tx(&mut tx, org_id, user_id, now)
        .await
        .map_err(|err| RestError::internal(err.to_string()))?;
    tx.commit()
        .await
        .map_err(|err| RestError::internal(err.to_string()))?;

    Ok((
        StatusCode::CREATED,
        Json(RegisterFinishResponse {
            passkey_id: passkey.id,
            user_id: passkey.user_id,
            credential_id: passkey.credential_id,
        }),
    ))
}

async fn start_login(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
) -> Result<Json<LoginStartResponse>, RestError> {
    let services = state.services()?;
    rate_limit(
        &state.pool,
        &headers,
        state.trusted_proxy_count,
        RateLimitEndpoint::LoginStart,
        OffsetDateTime::now_utc(),
    )
    .await?;
    // Usernameless discoverable authentication: the challenge has an empty
    // allowCredentials and the user is resolved at finish from the asserted
    // credential. No user_id is taken from the client.
    let ceremony = services
        .passkeys
        .start_authentication(&state.pool)
        .await
        .map_err(|err| RestError::unauthorized(err.to_string()))?;

    Ok(Json(LoginStartResponse {
        ceremony_id: ceremony.ceremony_id,
        challenge: serde_json::to_value(ceremony.challenge)
            .map_err(|err| RestError::internal(err.to_string()))?,
        expires_at: ceremony.expires_at,
    }))
}

async fn finish_login(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    Json(body): Json<LoginFinishRequest>,
) -> Result<Response, RestError> {
    let services = state.services()?;
    let outcome = services
        .passkeys
        .finish_authentication(&state.pool, body.ceremony_id, body.credential)
        .await
        .map_err(|err| RestError::unauthorized(err.to_string()))?;
    // Passkey login is a pre-auth route (no tenant middleware): arm the GUC with
    // the org resolved from the asserted credential so the `users` read + session
    // mint run under the credential's tenant.
    let user = load_user_auth_context_in_org(&state.pool, outcome.org_id, outcome.user_id).await?;
    let tokens = issue_token_pair(&state.pool, services, &user).await?;
    record_auth_audit(
        &state.pool,
        outcome.org_id,
        outcome.user_id,
        "auth.login",
        serde_json::json!({
            "passkey_id": outcome.passkey_id,
            "refresh_family_id": tokens.family_id,
        }),
    )
    .await?;
    Ok(token_pair_response(
        tokens,
        &headers,
        services.cookie_secure,
    ))
}

/// Open self-service signup (#38): create a new low-privilege MEMBER account and
/// email it a one-time sign-in code.
///
/// UNAUTHENTICATED and rate-limited (`Signup` bucket). Creates a fresh user in
/// the default (KNL) org with the single lowest-privilege `MEMBER` role, mints a
/// first-sign-in OTP via the same bootstrap machinery the admin path uses, and
/// delivers it over email (the stub sender logs it in dev/e2e). The response
/// reveals nothing — it always reports `accepted` and never a token — so it is
/// not an account-existence oracle. The caller then redeems the emailed code via
/// `/auth/otp/redeem` and enrolls a passkey, reusing the existing flow unchanged.
async fn signup(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    Json(body): Json<SignupRequest>,
) -> Result<Response, RestError> {
    let services = state.services()?;
    let now = OffsetDateTime::now_utc();
    rate_limit(
        &state.pool,
        &headers,
        state.trusted_proxy_count,
        RateLimitEndpoint::Signup,
        now,
    )
    .await?;

    let email = body.email.trim();
    let display_name = signup_display_name(email)?;
    let ttl = DEFAULT_SIGNUP_OTP_TTL;

    let issue = services
        .bootstrap_credentials
        .signup_open_member(&state.pool, &display_name, now, ttl)
        .await
        .map_err(RestError::from_provisioning)?;

    // Deliver the code out-of-band. The stub sender logs it (dev/e2e read it from
    // the backend log); a real SMTP sender relays it. A delivery failure is a 502
    // — the account + code exist, but we could not hand the code to the user.
    services
        .email_sender
        .send_otp(email, issue.token.as_str(), duration_to_std(ttl))
        .await
        .map_err(|err| {
            RestError::bad_gateway(format!("could not send the verification email: {err}"))
        })?;

    Ok((
        StatusCode::ACCEPTED,
        Json(SignupResponse { accepted: true }),
    )
        .into_response())
}

/// Derive a human display name from the signup email: validate it has exactly one
/// `@` with a non-empty local part and a dotted domain, then use the local part
/// as the label. Keeps the (no-email-column) `users` row readable while the email
/// itself is only used to deliver the OTP.
fn signup_display_name(email: &str) -> Result<String, RestError> {
    let (local, domain) = email
        .split_once('@')
        .ok_or_else(|| RestError::bad_request("a valid email address is required"))?;
    let local_ok = !local.is_empty() && local.len() <= 64;
    let domain_ok = domain.len() >= 3
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.');
    if !local_ok || !domain_ok || email.len() > 320 {
        return Err(RestError::bad_request("a valid email address is required"));
    }
    Ok(local.to_owned())
}

/// Convert a `time::Duration` to a `std::time::Duration` for the email port,
/// clamping any (impossible here) negative value to zero.
fn duration_to_std(ttl: Duration) -> std::time::Duration {
    std::time::Duration::from_secs(ttl.whole_seconds().max(0) as u64)
}

/// Redeem a one-time OTP as a FIRST SIGN-IN.
///
/// Unauthenticated and rate-limited. On success the OTP is consumed atomically
/// and a normal session token pair is minted for the OTP's pre-provisioned user;
/// `requires_passkey_setup` tells the frontend to force passkey enrollment in
/// initial settings. A wrong/expired/used OTP returns a single generic 401.
async fn redeem_otp(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    Json(body): Json<OtpRedeemRequest>,
) -> Result<Response, RestError> {
    let services = state.services()?;
    let now = OffsetDateTime::now_utc();
    rate_limit(
        &state.pool,
        &headers,
        state.trusted_proxy_count,
        RateLimitEndpoint::OtpRedeem,
        now,
    )
    .await?;

    let redemption = match services
        .bootstrap_credentials
        .redeem_otp(&state.pool, body.otp.trim(), now)
        .await
    {
        Ok(redemption) => redemption,
        Err(err) => {
            // Audit the failed attempt WITHOUT the OTP value or any PII.
            record_anonymous_auth_audit(
                &state.pool,
                "auth.otp.redeem_failed",
                serde_json::json!({ "outcome": "rejected" }),
            )
            .await
            .ok();
            return Err(RestError::from_provisioning(err));
        }
    };

    // OTP redeem is a pre-auth route (no tenant middleware): arm the GUC with the
    // org resolved from the redeemed credential so the `users` read + session mint
    // run under the credential's tenant.
    let user =
        load_user_auth_context_in_org(&state.pool, redemption.org_id, redemption.user_id).await?;
    let tokens = issue_token_pair(&state.pool, services, &user).await?;
    record_auth_audit(
        &state.pool,
        redemption.org_id,
        redemption.user_id,
        "auth.otp.signin",
        serde_json::json!({
            "refresh_family_id": tokens.family_id,
            "requires_passkey_setup": redemption.requires_passkey_setup,
        }),
    )
    .await?;

    // Dual transport: web (cookie) gets an HttpOnly Set-Cookie and a null body
    // refresh token; mobile (body) gets the refresh token in the JSON body. The
    // access token and passkey-setup flag are always in the body.
    if wants_cookie_transport(&headers) {
        let max_age = (tokens.refresh_expires_at - now).whole_seconds();
        let cookie = refresh_set_cookie(&tokens.refresh_token, max_age, services.cookie_secure);
        let response = Json(OtpRedeemResponse {
            access_token: tokens.access_token,
            refresh_token: None,
            token_type: "Bearer",
            refresh_expires_at: tokens.refresh_expires_at,
            requires_passkey_setup: redemption.requires_passkey_setup,
        })
        .into_response();
        Ok(with_refresh_cookie(response, cookie))
    } else {
        Ok(Json(OtpRedeemResponse {
            access_token: tokens.access_token,
            refresh_token: Some(tokens.refresh_token),
            token_type: "Bearer",
            refresh_expires_at: tokens.refresh_expires_at,
            requires_passkey_setup: redemption.requires_passkey_setup,
        })
        .into_response())
    }
}

/// Issue a one-time sign-in OTP for a pre-provisioned zero-credential user.
///
/// AUTHZ-gated: only ADMIN / SUPER_ADMIN (branch-scoped) may call it, via the
/// `SubordinateUserCreate` feature. The issuance is audited inside
/// `issue_for_zero_credential_user`. The returned OTP is shown once.
///
/// The branch set a privileged admin credential action (issue-OTP /
/// credential-reset) must authorize the caller against, given the TARGET user's
/// resolved branch scope.
///
/// * `Branches(non-empty)` → `Some(branches)`: a branch-scoped target. The caller
///   must be authorized for `SubordinateUserCreate` against EVERY one of them
///   (the per-branch IDOR check, done by the caller).
/// * `All` → `None`: an org-wide target (a `SUPER_ADMIN` / `EXECUTIVE`, for whom
///   [`resolve_branch_scope_in_org`] returns `All`). There is no concrete branch
///   to check. Such a target is always privileged, so by the privileged-target
///   guard only a `SUPER_ADMIN` — who is authorized org-wide for this feature —
///   can ever reach here; `caller_is_super_admin` is re-asserted as defense in
///   depth so a future refactor of that guard cannot open a hole.
/// * an empty branch set / any other scope → 403 (nothing issuable).
///
/// Shared by `issue_admin_otp` and `admin_credential_reset` so the two cannot
/// drift: both previously matched only `Branches(non-empty)` and so 403'd on an
/// `All`-scope (privileged) target — the "코드를 발급하지 못했습니다" OTP-issuance
/// failure from issue #18. An org-wide target now resolves to `None` (authorized,
/// no per-branch basis) instead of a hard 403.
fn authorizable_target_branches(
    target_scope: BranchScope,
    caller_is_super_admin: bool,
) -> Result<Option<BTreeSet<BranchId>>, RestError> {
    match target_scope {
        BranchScope::Branches(branches) if !branches.is_empty() => Ok(Some(branches)),
        BranchScope::All if caller_is_super_admin => Ok(None),
        _ => Err(RestError::forbidden(
            "target user has no issuable branch scope",
        )),
    }
}

/// IDOR hardening: authorization is bound to the TARGET user's real branch/role
/// resolved from the database, NOT to the client-supplied `body.branch_id`. The
/// caller must be authorized for `SubordinateUserCreate` against EVERY branch the
/// target belongs to, and a non-SUPER_ADMIN caller can never mint a code for an
/// EXECUTIVE or SUPER_ADMIN target. This stops a branch-A admin from minting a
/// sign-in OTP for a privileged user or for a user who lives in branch B. An
/// org-wide (privileged) target is issuable only by a SUPER_ADMIN — see
/// [`authorizable_target_branches`].
async fn issue_admin_otp(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    Json(body): Json<AdminIssueOtpRequest>,
) -> Result<Json<AdminIssueOtpResponse>, RestError> {
    let services = state.services()?;
    let principal = principal_from_headers(&state.pool, services, &headers).await?;

    // Resolve the TARGET's real roles. A missing or inactive target is a 403 here
    // (the caller is authenticated; it is the requested target that is invalid),
    // not the 401 the sign-in paths use. The target lives in the caller's tenant
    // (an admin can only manage users in its own org), so arm the GUC with the
    // caller's verified org for this RLS-gated read.
    let target = load_user_auth_context_in_org(&state.pool, principal.org_id, body.user_id)
        .await
        .map_err(forbidden_if_unauthorized)?;
    let target_roles = parse_roles(&target.roles)?;

    let caller_is_super_admin = principal.roles.contains(&Role::SuperAdmin);

    // A non-SUPER_ADMIN caller may never issue a code for a privileged target.
    let target_is_privileged = target_roles
        .iter()
        .any(|role| matches!(role, Role::Executive | Role::SuperAdmin));
    if target_is_privileged && !caller_is_super_admin {
        return Err(RestError::forbidden(
            "not allowed to issue sign-in codes for a privileged user",
        ));
    }

    // Resolve the target's REAL branch scope and require the caller to be
    // authorized against every one of the target's branches. A target with All
    // scope (SUPER_ADMIN/EXECUTIVE) or no branches cannot be issued for here.
    let target_scope =
        resolve_branch_scope_in_org(&state.pool, principal.org_id, target.user_id, &target_roles)
            .await
            .map_err(|err| RestError::internal(err.to_string()))?;
    let target_branches = authorizable_target_branches(target_scope, caller_is_super_admin)?;

    // A branch-scoped target authorizes per-branch: `body.branch_id` is still
    // accepted for API stability but no longer grants access (it must be one of the
    // target's real branches), and the caller must be authorized for
    // `SubordinateUserCreate` against EVERY one of them. An org-wide target
    // (`None`) is authorized above (SUPER_ADMIN, org-wide) — no per-branch basis.
    if let Some(branches) = &target_branches {
        let requested_branch = BranchId::from_uuid(body.branch_id);
        if !branches.contains(&requested_branch) {
            return Err(RestError::forbidden(
                "branch_id does not belong to the target user",
            ));
        }
        for branch_id in branches {
            authorize(
                &principal,
                Action::limited(Feature::SubordinateUserCreate),
                *branch_id,
            )
            .map_err(|_| RestError::forbidden("not allowed to issue sign-in codes"))?;
        }
    }

    let ttl = resolve_otp_ttl(body.ttl_seconds)?;
    let now = OffsetDateTime::now_utc();
    let issue = services
        .bootstrap_credentials
        .issue_for_zero_credential_user(&state.pool, body.user_id, principal.org_id, now, ttl)
        .await
        .map_err(RestError::from_provisioning)?;

    Ok(Json(AdminIssueOtpResponse {
        user_id: issue.user_id,
        otp: issue.token.as_str().to_owned(),
        expires_at: issue.expires_at,
    }))
}

/// Reset a locked-out user's credentials: revoke ALL their passkeys AND mint a
/// fresh single-use sign-in OTP, atomically and audited, so a user who lost their
/// only passkey can re-enroll.
///
/// This is the admin-only account-recovery escape hatch. The normal admin-OTP
/// path refuses a user who already has a passkey (409 `UserAlreadyHasPasskey`) and
/// self-revoke refuses the last passkey, so neither can recover a locked-out user;
/// this path deliberately overrides both — but ONLY for an admin, gated by the
/// EXACT same authz/IDOR rules as `issue_admin_otp`:
///   * Authz: ADMIN / SUPER_ADMIN via the `SubordinateUserCreate` feature against
///     EVERY one of the target's real branches.
///   * IDOR / cross-org: the target is read via `load_user_auth_context_in_org`
///     armed with the CALLER's verified-token org, so a user in another tenant is
///     invisible (a generic 403, no enumeration). A non-SUPER_ADMIN caller can
///     never reset an EXECUTIVE / SUPER_ADMIN target.
///
/// On success the returned OTP is shown once. Generic errors only (no user
/// enumeration). After the reset the user's old passkeys fail login and the new
/// OTP redeems.
async fn admin_credential_reset(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    Json(body): Json<AdminCredentialResetRequest>,
) -> Result<Json<AdminCredentialResetResponse>, RestError> {
    let services = state.services()?;
    let principal = principal_from_headers(&state.pool, services, &headers).await?;

    // Resolve the TARGET's real roles inside the CALLER's tenant (IDOR / cross-org
    // guard): a user in another org is not visible under the caller's org GUC and
    // surfaces as the same generic 403 as a missing/inactive target.
    let target = load_user_auth_context_in_org(&state.pool, principal.org_id, body.user_id)
        .await
        .map_err(forbidden_if_unauthorized)?;
    let target_roles = parse_roles(&target.roles)?;

    let caller_is_super_admin = principal.roles.contains(&Role::SuperAdmin);

    // A non-SUPER_ADMIN caller may never reset a privileged target.
    let target_is_privileged = target_roles
        .iter()
        .any(|role| matches!(role, Role::Executive | Role::SuperAdmin));
    if target_is_privileged && !caller_is_super_admin {
        return Err(RestError::forbidden(
            "not allowed to reset credentials for a privileged user",
        ));
    }

    // Require the caller to be authorized against EVERY one of the target's real
    // branches, exactly like `issue_admin_otp`.
    let target_scope =
        resolve_branch_scope_in_org(&state.pool, principal.org_id, target.user_id, &target_roles)
            .await
            .map_err(|err| RestError::internal(err.to_string()))?;
    let target_branches = authorizable_target_branches(target_scope, caller_is_super_admin)?;

    // Branch-scoped target → authorize the caller against EVERY one of the target's
    // real branches. Org-wide target (`None`) is authorized above (SUPER_ADMIN).
    if let Some(branches) = &target_branches {
        for branch_id in branches {
            authorize(
                &principal,
                Action::limited(Feature::SubordinateUserCreate),
                *branch_id,
            )
            .map_err(|_| RestError::forbidden("not allowed to reset credentials"))?;
        }
    }

    let now = OffsetDateTime::now_utc();
    let issue = services
        .bootstrap_credentials
        .reset_credentials_for_user(
            &state.pool,
            body.user_id,
            principal.org_id,
            now,
            DEFAULT_OTP_TTL,
        )
        .await
        .map_err(RestError::from_provisioning)?;

    Ok(Json(AdminCredentialResetResponse {
        user_id: issue.user_id,
        otp: issue.token.as_str().to_owned(),
        expires_at: issue.expires_at,
    }))
}

/// List the AUTHENTICATED user's OWN passkey credentials through the auth
/// namespace. Unlike `/api/v1/passkeys`, this route is not behind the tenant
/// middleware, so it also works for PLATFORM accounts whose token is deliberately
/// rejected from tenant APIs.
async fn list_self_passkeys(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
) -> Result<Json<Vec<PasskeySummary>>, RestError> {
    let services = state.services()?;
    let (user_id, org_id) = authenticated_user_context(services, &headers)?;

    let summaries =
        with_org_conn::<_, Vec<PasskeySummary>, RestError>(&state.pool, org_id, move |tx| {
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

/// Revoke ONE of the authenticated user's OWN passkey credentials through the
/// auth namespace. Self-only and IDOR-hardened: the delete is constrained by both
/// credential id and caller id. The last-passkey floor prevents self-lockout.
async fn delete_self_passkey(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse, RestError> {
    let services = state.services()?;
    let (user_id, org_id) = authenticated_user_context(services, &headers)?;
    let actor = UserId::from_uuid(user_id);
    let now = OffsetDateTime::now_utc();

    with_audits::<_, (), RestError>(&state.pool, org_id, move |tx| {
        Box::pin(async move {
            let total: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM auth_webauthn_credentials WHERE user_id = $1",
            )
            .bind(user_id)
            .fetch_one(tx.as_mut())
            .await
            .map_err(DbError::Sqlx)?;

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
                return Err(RestError::not_found("passkey not found"));
            };

            if total <= 1 {
                return Err(RestError::conflict(
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
            .with_org(org_id)
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

/// Mint a cross-device passkey-enrollment handoff for the AUTHENTICATED user.
///
/// SELF-ONLY: the target user id and org come from the caller's VERIFIED access
/// token (`authenticated_user_context`), NEVER from the request body, so a caller
/// can only ever mint a handoff for itself — there is no path to hand off another
/// user's enrollment.
///
/// Scoped to passkey enrollment: the returned code is a fresh single-use,
/// short-TTL (5 min) bootstrap credential for THIS user, redeemed on a second
/// device (a phone scanning the QR) through the ordinary first-sign-in path. The
/// phone lands on its own onboarding page and enrolls a platform passkey there —
/// no Bluetooth / caBLE hybrid tunnel.
///
/// Step-up gate (mirrors `start_registration` exactly): when the caller is ALREADY
/// enrolled (has >=1 passkey, i.e. this is add-a-device), a fresh `step_up`
/// assertion of an existing passkey (UV required) is mandatory before a handoff is
/// minted, so a stolen bearer token alone cannot mint a device-enrollment code. A
/// mid-onboarding caller (zero passkeys) is exempt — there is nothing to assert,
/// and the redeem on the phone still gates the actual enrollment.
///
/// Audited inside `issue_self_enroll_handoff` as
/// `auth.passkey.enroll_handoff_issued`; the code value is never logged.
async fn enroll_handoff(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    Json(body): Json<EnrollHandoffRequest>,
) -> Result<Json<EnrollHandoffResponse>, RestError> {
    let services = state.services()?;
    // SELF-ONLY: user + org are taken from the verified token, never the body.
    let (user_id, org_id) = authenticated_user_context(services, &headers)?;

    // Step-up gate: an already-enrolled user MUST assert an existing passkey (UV)
    // before a fresh enrollment handoff is minted; a user with zero passkeys is
    // mid-onboarding and exempt — identical to `start_registration`.
    let existing_passkeys = services
        .passkeys
        .count_user_passkeys(&state.pool, org_id, user_id)
        .await
        .map_err(|err| RestError::internal(err.to_string()))?;
    if existing_passkeys == 0 {
        ensure_required_privacy_consent(&state.pool, org_id, user_id).await?;
    } else {
        let step_up = body.step_up.ok_or_else(|| {
            RestError::unauthorized(
                "minting an enrollment handoff requires a step-up assertion of an existing passkey",
            )
        })?;
        services
            .passkeys
            .verify_step_up_for_user(
                &state.pool,
                step_up.ceremony_id,
                step_up.credential,
                user_id,
            )
            .await
            .map_err(|err| RestError::unauthorized(err.to_string()))?;
    }

    let now = OffsetDateTime::now_utc();
    let issue = services
        .bootstrap_credentials
        .issue_self_enroll_handoff(&state.pool, user_id, org_id, now, ENROLL_HANDOFF_TTL)
        .await
        .map_err(RestError::from_provisioning)?;
    let handoff_id = Uuid::new_v4();
    let poll_token = generate_device_login_token("mnt_dlp_");
    let approve_token = generate_device_login_token("mnt_dla_");

    sqlx::query(
        r#"
        INSERT INTO auth_device_login_handoffs (
            id,
            poll_token_hash,
            approve_token_hash,
            issued_at,
            expires_at,
            target_user_id,
            target_org_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        "#,
    )
    .bind(handoff_id)
    .bind(hash_device_login_token(&poll_token))
    .bind(hash_device_login_token(&approve_token))
    .bind(now)
    .bind(issue.expires_at.min(now + DEVICE_LOGIN_HANDOFF_TTL))
    .bind(user_id)
    .bind(*org_id.as_uuid())
    // rls-arming: ok auth_device_login_handoffs is a global pre-auth table.
    .execute(&state.pool)
    .await
    .map_err(|err| RestError::internal(err.to_string()))?;

    Ok(Json(EnrollHandoffResponse {
        enroll_url: build_enroll_url(
            &services.rp_origin,
            issue.token.as_str(),
            Some(&approve_token),
        ),
        otp: issue.token.as_str().to_owned(),
        expires_at: issue.expires_at,
        poll_token,
    }))
}

/// Start a desktop-login handoff that a phone passkey can approve.
///
/// This is NOT enrollment and does not mint a phone session. The desktop keeps a
/// poll token returned in the JSON body; the QR URL carries a distinct approve
/// token. The phone proves possession of an existing passkey against the approve
/// token, then the desktop poll token can be consumed exactly once for a normal
/// session.
async fn start_device_login(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
) -> Result<Json<DeviceLoginStartResponse>, RestError> {
    let services = state.services()?;
    let now = OffsetDateTime::now_utc();
    rate_limit(
        &state.pool,
        &headers,
        state.trusted_proxy_count,
        RateLimitEndpoint::DeviceLoginStart,
        now,
    )
    .await?;

    let handoff_id = Uuid::new_v4();
    let poll_token = generate_device_login_token("mnt_dlp_");
    let approve_token = generate_device_login_token("mnt_dla_");
    let expires_at = now + DEVICE_LOGIN_HANDOFF_TTL;

    sqlx::query(
        r#"
        INSERT INTO auth_device_login_handoffs (
            id, poll_token_hash, approve_token_hash, issued_at, expires_at
        ) VALUES ($1, $2, $3, $4, $5)
        "#,
    )
    .bind(handoff_id)
    .bind(hash_device_login_token(&poll_token))
    .bind(hash_device_login_token(&approve_token))
    .bind(now)
    .bind(expires_at)
    // rls-arming: ok auth_device_login_handoffs is a global pre-auth table.
    .execute(&state.pool)
    .await
    .map_err(|err| RestError::internal(err.to_string()))?;

    record_anonymous_auth_audit(
        &state.pool,
        "auth.device_login.start",
        serde_json::json!({
            "handoff_id": handoff_id,
            "expires_at": expires_at,
        }),
    )
    .await?;

    Ok(Json(DeviceLoginStartResponse {
        poll_token,
        approve_url: build_device_login_approve_url(&services.rp_origin, &approve_token),
        expires_at,
    }))
}

async fn poll_device_login(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    Json(body): Json<DeviceLoginPollRequest>,
) -> Result<Response, RestError> {
    let services = state.services()?;
    let now = OffsetDateTime::now_utc();
    rate_limit(
        &state.pool,
        &headers,
        state.trusted_proxy_count,
        RateLimitEndpoint::DeviceLoginPoll,
        now,
    )
    .await?;

    let poll_token = normalize_device_login_token(&body.poll_token, "mnt_dlp_")?;
    let poll_hash = hash_device_login_token(&poll_token);

    let status = sqlx::query(
        r#"
        SELECT id, expires_at, approved_at, consumed_at
        FROM auth_device_login_handoffs
        WHERE poll_token_hash = $1
        "#,
    )
    .bind(&poll_hash)
    // rls-arming: ok auth_device_login_handoffs is a global pre-auth table.
    .fetch_optional(&state.pool)
    .await
    .map_err(|err| RestError::internal(err.to_string()))?;

    let Some(status) = status else {
        return Err(RestError::unauthorized("invalid or expired login handoff"));
    };
    let expires_at: OffsetDateTime = status.try_get("expires_at").map_err(DbError::Sqlx)?;
    let approved_at: Option<OffsetDateTime> =
        status.try_get("approved_at").map_err(DbError::Sqlx)?;
    let consumed_at: Option<OffsetDateTime> =
        status.try_get("consumed_at").map_err(DbError::Sqlx)?;

    if consumed_at.is_some() {
        return Err(RestError::unauthorized("invalid or expired login handoff"));
    }
    if expires_at <= now {
        return Ok(Json(device_login_status("expired")).into_response());
    }
    if approved_at.is_none() {
        return Ok(Json(device_login_status("pending")).into_response());
    }

    let approved = sqlx::query(
        r#"
        UPDATE auth_device_login_handoffs
        SET consumed_at = $2
        WHERE poll_token_hash = $1
          AND consumed_at IS NULL
          AND approved_at IS NOT NULL
          AND expires_at > $2
        RETURNING id, approved_user_id, approved_org_id, approved_passkey_id
        "#,
    )
    .bind(&poll_hash)
    .bind(now)
    // rls-arming: ok auth_device_login_handoffs is a global pre-auth table.
    .fetch_optional(&state.pool)
    .await
    .map_err(|err| RestError::internal(err.to_string()))?;

    let Some(approved) = approved else {
        return Err(RestError::unauthorized("invalid or expired login handoff"));
    };
    let handoff_id: Uuid = approved.try_get("id").map_err(DbError::Sqlx)?;
    let user_id: Uuid = approved
        .try_get::<Option<Uuid>, _>("approved_user_id")
        .map_err(DbError::Sqlx)?
        .ok_or_else(|| RestError::internal("approved login handoff missing user"))?;
    let org_uuid: Uuid = approved
        .try_get::<Option<Uuid>, _>("approved_org_id")
        .map_err(DbError::Sqlx)?
        .ok_or_else(|| RestError::internal("approved login handoff missing org"))?;
    let passkey_id: Option<Uuid> = approved
        .try_get("approved_passkey_id")
        .map_err(DbError::Sqlx)?;

    let org_id = OrgId::from_uuid(org_uuid);
    let user = load_user_auth_context_in_org(&state.pool, org_id, user_id).await?;
    let tokens = issue_token_pair(&state.pool, services, &user).await?;
    record_auth_audit(
        &state.pool,
        org_id,
        user_id,
        "auth.device_login.consume",
        serde_json::json!({
            "handoff_id": handoff_id,
            "passkey_id": passkey_id,
            "refresh_family_id": tokens.family_id,
        }),
    )
    .await?;

    Ok(device_login_token_response(
        tokens,
        &headers,
        services.cookie_secure,
    ))
}

async fn approve_device_login(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    Json(body): Json<DeviceLoginApproveRequest>,
) -> Result<StatusCode, RestError> {
    let services = state.services()?;
    let now = OffsetDateTime::now_utc();
    rate_limit(
        &state.pool,
        &headers,
        state.trusted_proxy_count,
        RateLimitEndpoint::DeviceLoginApprove,
        now,
    )
    .await?;

    let approve_token = normalize_device_login_token(&body.approve_token, "mnt_dla_")?;
    let approve_hash = hash_device_login_token(&approve_token);

    let pending_id: Option<Uuid> = sqlx::query_scalar(
        r#"
        SELECT id
        FROM auth_device_login_handoffs
        WHERE approve_token_hash = $1
          AND approved_at IS NULL
          AND consumed_at IS NULL
          AND expires_at > $2
        "#,
    )
    .bind(&approve_hash)
    .bind(now)
    // rls-arming: ok auth_device_login_handoffs is a global pre-auth table.
    .fetch_optional(&state.pool)
    .await
    .map_err(|err| RestError::internal(err.to_string()))?;
    let Some(handoff_id) = pending_id else {
        return Err(RestError::unauthorized("invalid or expired login handoff"));
    };

    let outcome = services
        .passkeys
        .finish_authentication(&state.pool, body.ceremony_id, body.credential)
        .await
        .map_err(|err| RestError::unauthorized(err.to_string()))?;

    let updated = sqlx::query(
        r#"
        UPDATE auth_device_login_handoffs
        SET approved_at = $2,
            approved_user_id = $3,
            approved_org_id = $4,
            approved_passkey_id = $5
        WHERE approve_token_hash = $1
          AND approved_at IS NULL
          AND consumed_at IS NULL
          AND expires_at > $2
          AND (target_user_id IS NULL OR target_user_id = $3)
          AND (target_org_id IS NULL OR target_org_id = $4)
        RETURNING id
        "#,
    )
    .bind(&approve_hash)
    .bind(now)
    .bind(outcome.user_id)
    .bind(*outcome.org_id.as_uuid())
    .bind(outcome.passkey_id)
    // rls-arming: ok auth_device_login_handoffs is a global pre-auth table.
    .fetch_optional(&state.pool)
    .await
    .map_err(|err| RestError::internal(err.to_string()))?;

    if updated.is_none() {
        return Err(RestError::unauthorized("invalid or expired login handoff"));
    }

    record_auth_audit(
        &state.pool,
        outcome.org_id,
        outcome.user_id,
        "auth.device_login.approve",
        serde_json::json!({
            "handoff_id": handoff_id,
            "passkey_id": outcome.passkey_id,
        }),
    )
    .await?;

    Ok(StatusCode::NO_CONTENT)
}

async fn approve_device_login_session(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    Json(body): Json<DeviceLoginApproveSessionRequest>,
) -> Result<StatusCode, RestError> {
    let services = state.services()?;
    let now = OffsetDateTime::now_utc();
    rate_limit(
        &state.pool,
        &headers,
        state.trusted_proxy_count,
        RateLimitEndpoint::DeviceLoginApprove,
        now,
    )
    .await?;
    let (user_id, org_id) = authenticated_user_context(services, &headers)?;

    let approve_token = normalize_device_login_token(&body.approve_token, "mnt_dla_")?;
    let approve_hash = hash_device_login_token(&approve_token);
    let existing_passkeys = services
        .passkeys
        .count_user_passkeys(&state.pool, org_id, user_id)
        .await
        .map_err(|err| RestError::internal(err.to_string()))?;
    if existing_passkeys == 0 {
        return Err(RestError::forbidden(
            "desktop login approval requires an enrolled passkey",
        ));
    }
    let latest_passkey_id = latest_user_passkey_id(&state.pool, org_id, user_id).await?;

    let approved = sqlx::query(
        r#"
        UPDATE auth_device_login_handoffs
        SET approved_at = $2,
            approved_user_id = $3,
            approved_org_id = $4,
            approved_passkey_id = $5
        WHERE approve_token_hash = $1
          AND approved_at IS NULL
          AND consumed_at IS NULL
          AND expires_at > $2
          AND target_user_id = $3
          AND target_org_id = $4
        RETURNING id, approved_passkey_id
        "#,
    )
    .bind(&approve_hash)
    .bind(now)
    .bind(user_id)
    .bind(*org_id.as_uuid())
    .bind(latest_passkey_id)
    // rls-arming: ok auth_device_login_handoffs is a global pre-auth table.
    .fetch_optional(&state.pool)
    .await
    .map_err(|err| RestError::internal(err.to_string()))?;

    let Some(approved) = approved else {
        return Err(RestError::unauthorized("invalid or expired login handoff"));
    };
    let handoff_id: Uuid = approved.try_get("id").map_err(DbError::Sqlx)?;
    let passkey_id: Option<Uuid> = approved
        .try_get("approved_passkey_id")
        .map_err(DbError::Sqlx)?;

    record_auth_audit(
        &state.pool,
        org_id,
        user_id,
        "auth.device_login.approve_session",
        serde_json::json!({
            "handoff_id": handoff_id,
            "passkey_id": passkey_id,
        }),
    )
    .await?;

    Ok(StatusCode::NO_CONTENT)
}

/// Read whether the authenticated user has accepted the current required
/// first-login privacy/terms notice. Served as POST instead of GET to stay within
/// the auth router's existing verb/import surface and avoid changing generated
/// client assumptions for an authenticated pre-shell call.
async fn privacy_consent_status(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
) -> Result<Json<PrivacyConsentStatusResponse>, RestError> {
    let services = state.services()?;
    let (user_id, org_id) = authenticated_user_context(services, &headers)?;
    let accepted_at = required_privacy_consent_accepted_at(&state.pool, org_id, user_id).await?;
    Ok(Json(PrivacyConsentStatusResponse {
        policy_version: REQUIRED_PRIVACY_TERMS_VERSION,
        accepted: accepted_at.is_some(),
        accepted_at,
    }))
}

/// Persist required first-login privacy/terms acceptance as an append-only,
/// tenant-scoped audit event. No marketing/location consent is collected here:
/// those remain separate optional flows.
async fn accept_privacy_consent(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    Json(body): Json<PrivacyConsentAcceptRequest>,
) -> Result<Json<PrivacyConsentStatusResponse>, RestError> {
    let services = state.services()?;
    let (user_id, org_id) = authenticated_user_context(services, &headers)?;
    if body.policy_version != REQUIRED_PRIVACY_TERMS_VERSION {
        return Err(RestError::bad_request(
            "unsupported privacy consent version",
        ));
    }
    if !body.privacy_collection || !body.terms_of_service {
        return Err(RestError::bad_request(
            "required privacy and terms agreements must be accepted separately",
        ));
    }

    let now = OffsetDateTime::now_utc();
    let event = AuditEvent::new(
        Some(UserId::from_uuid(user_id)),
        AuditAction::new("privacy.required_accept")
            .map_err(|err| RestError::internal(err.to_string()))?,
        "privacy_terms",
        REQUIRED_PRIVACY_TERMS_VERSION,
        TraceContext::generate(),
        now,
    )
    .with_org(org_id)
    .with_snapshots(
        None,
        Some(serde_json::json!({
            "policy_version": REQUIRED_PRIVACY_TERMS_VERSION,
            "privacy_collection": true,
            "terms_of_service": true,
            "optional_marketing": "not_requested",
            "gps_location": "separate_consent_flow",
        })),
    );

    with_audit::<_, (), RestError>(&state.pool, event, |_tx| Box::pin(async move { Ok(()) }))
        .await?;

    Ok(Json(PrivacyConsentStatusResponse {
        policy_version: REQUIRED_PRIVACY_TERMS_VERSION,
        accepted: true,
        accepted_at: Some(now),
    }))
}

/// Build the QR-encoded enrollment URL `{rp_origin}/login#otp=<handoff>` from the
/// validated console origin and the freshly minted handoff code. The OTP is an
/// auth secret, so keep it out of query strings that are commonly logged by
/// servers and proxies; the fragment stays client-side and is cleared by the UI.
fn build_enroll_url(rp_origin: &Url, otp: &str, approve_token: Option<&str>) -> String {
    let mut url = rp_origin.clone();
    url.set_path("/login");
    url.set_query(None);
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    serializer.append_pair("otp", otp);
    if let Some(approve_token) = approve_token {
        serializer.append_pair("desktop_approve", approve_token);
    }
    let fragment = serializer.finish();
    url.set_fragment(Some(&fragment));
    url.to_string()
}

/// Build the QR-encoded approval URL `{rp_origin}/login#desktop_approve=<token>`.
/// The approve token is a short-lived bearer secret, so it stays in the fragment
/// and is never enough to poll/receive the desktop token pair.
fn build_device_login_approve_url(rp_origin: &Url, approve_token: &str) -> String {
    let mut url = rp_origin.clone();
    url.set_path("/login");
    url.set_query(None);
    let fragment = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("desktop_approve", approve_token)
        .finish();
    url.set_fragment(Some(&fragment));
    url.to_string()
}

/// Remap the `401` that `load_user_auth_context_in_org` returns for a
/// missing/inactive user into a `403` for the admin issue-OTP path, where the CALLER is
/// authenticated and it is the requested TARGET that is invalid. Other statuses
/// (e.g. internal DB errors) pass through unchanged.
fn forbidden_if_unauthorized(err: RestError) -> RestError {
    if err.status == StatusCode::UNAUTHORIZED {
        RestError::forbidden("target user is not eligible for a sign-in code")
    } else {
        err
    }
}

/// Parse a target's stored role strings into [`Role`]s, rejecting unknown codes.
fn parse_roles(roles: &[String]) -> Result<Vec<Role>, RestError> {
    roles
        .iter()
        .map(|role| {
            Role::from_str(role).map_err(|_| RestError::internal("target has an unknown role"))
        })
        .collect()
}

async fn refresh_token(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    Json(body): Json<RefreshTokenRequest>,
) -> Result<Response, RestError> {
    let services = state.services()?;
    let now = OffsetDateTime::now_utc();
    rate_limit(
        &state.pool,
        &headers,
        state.trusted_proxy_count,
        RateLimitEndpoint::Refresh,
        now,
    )
    .await?;
    // Dual transport: web reads the rotating token from the `mnt_refresh` cookie;
    // mobile sends it in the JSON body. The cookie takes precedence so a web
    // client never has to (and never should) echo the token in the body.
    let cookie_mode = wants_cookie_transport(&headers);
    let refresh = refresh_cookie_value(&headers)
        .or(body.refresh_token)
        .ok_or_else(|| RestError::unauthorized("missing refresh token"))?;
    let issue = services
        .refresh_tokens
        .rotate(
            &state.pool,
            &refresh,
            now,
            services.refresh_token_ttl,
            services.refresh_family_absolute_ttl,
        )
        .await
        .map_err(RestError::from_refresh)?;
    // Refresh is a pre-auth route (no tenant middleware): arm the GUC with the org
    // the rotated token belongs to so the `users` read runs under that tenant.
    let user = load_user_auth_context_in_org(&state.pool, issue.org_id, issue.user_id).await?;
    let requires_passkey_setup = services
        .passkeys
        .count_user_passkeys(&state.pool, issue.org_id, issue.user_id)
        .await
        .map_err(|err| RestError::internal(err.to_string()))?
        == 0;
    let access_token = issue_access_token(services, &user)?;
    if cookie_mode {
        let max_age = (issue.expires_at - now).whole_seconds();
        let cookie = refresh_set_cookie(issue.token.as_str(), max_age, services.cookie_secure);
        let response = Json(TokenPairResponse {
            access_token,
            refresh_token: None,
            token_type: "Bearer",
            refresh_expires_at: issue.expires_at,
            requires_passkey_setup,
        })
        .into_response();
        Ok(with_refresh_cookie(response, cookie))
    } else {
        Ok(Json(TokenPairResponse {
            access_token,
            refresh_token: Some(issue.token.as_str().to_owned()),
            token_type: "Bearer",
            refresh_expires_at: issue.expires_at,
            requires_passkey_setup,
        })
        .into_response())
    }
}

async fn logout(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    Json(body): Json<LogoutRequest>,
) -> Result<Response, RestError> {
    let services = state.services()?;
    let cookie_mode = wants_cookie_transport(&headers);
    // Read the token from the cookie (web) or the body (mobile). A logout with no
    // token is a no-op success: the session is already gone client-side, and we
    // still clear the cookie for the web client below.
    let refresh = refresh_cookie_value(&headers).or(body.refresh_token);
    if let Some(refresh) = refresh.as_deref() {
        services
            .refresh_tokens
            .revoke_family_for_logout(&state.pool, refresh, OffsetDateTime::now_utc())
            .await
            .map_err(RestError::from_refresh)?;
    }
    // Always clear the cookie for the web transport so a stale token cannot linger
    // in the browser after the family is revoked.
    if cookie_mode {
        let response = StatusCode::NO_CONTENT.into_response();
        Ok(with_refresh_cookie(
            response,
            refresh_clear_cookie(services.cookie_secure),
        ))
    } else {
        Ok(StatusCode::NO_CONTENT.into_response())
    }
}

/// GET /api/v1/group-admin/groups — list the ACTIVE groups/subsidiaries this
/// actor may manage. The JWT group_roles claim is NOT trusted here; the live
/// owner-only resolver is consulted on every call and only GROUP_ADMIN grants
/// qualify.
async fn list_group_admin_groups(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
) -> Result<Json<GroupAdminGroupsResponse>, RestError> {
    let services = state.services()?;
    let actor = authenticated_group_actor(services, &headers)?;
    let groups = load_group_admin_groups(&state.pool, actor).await?;
    Ok(Json(GroupAdminGroupsResponse { groups }))
}

/// POST /api/v1/group-admin/tenant-context — mint a short-lived bounded tenant
/// token for one resolver-authorized subsidiary. This is the tenant-side analog
/// of the platform tenant-context endpoint, but it is strictly GROUP_ADMIN-only,
/// does not rely on the user's home tenant, and never mints an ordinary
/// SUPER_ADMIN session.
async fn start_group_admin_tenant_context(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    Json(body): Json<GroupAdminTenantContextStartRequest>,
) -> Result<Json<GroupAdminTenantContextStartResponse>, RestError> {
    let services = state.services()?;
    let actor = authenticated_group_actor(services, &headers)?;
    let (group_id, target) =
        resolve_group_admin_target_org(&state.pool, actor, OrgId::from_uuid(body.org_id)).await?;

    // Source REAL subject freshness for the token's OWN (target subsidiary org,
    // actor) so a promoted Cedar guard — which re-reads exactly that (org, user)
    // at guard time — does not falsely deny this delegated token as stale/missing.
    // The read arms the target org's RLS GUC internally; the actor typically has
    // no `users` row in the subsidiary, so subject/session read as the absent 0
    // baseline while the subsidiary's `policy_version` is real.
    let freshness = read_subject_authz_freshness(&state.pool, target.org_id, actor)
        .await
        .map_err(|err| {
            tracing::error!(error = %err, "failed to read subject freshness for group-admin tenant-context");
            RestError::internal("internal server error")
        })?;

    let now = OffsetDateTime::now_utc();
    let expires_at = now + GROUP_ADMIN_TENANT_CONTEXT_TTL;
    let access_token = services
        .jwt_issuer
        .issue_group_admin_tenant_context_access_token(
            AccessTokenInput {
                subject: actor,
                org_id: target.org_id,
                roles: vec!["ADMIN".to_owned()],
                branches: Vec::new(),
                platform: false,
                view_as: false,
                read_only: false,
                display_name: None,
                feature_grants: Vec::new(),
                // Real subject freshness for (target subsidiary, actor): a promoted
                // Cedar guard re-reads the same (org, user), so a fresh token is not
                // falsely denied as stale/missing.
                authz_subject_version: freshness.subject_version,
                authz_policy_version: freshness.policy_version,
                session_generation: freshness.session_generation,
                issued_at: now,
            },
            group_id,
            GROUP_ADMIN_TENANT_CONTEXT_TTL,
        )
        .map_err(|err| RestError::internal(err.to_string()))?;

    record_group_tenant_context_audit(
        &state.pool,
        actor,
        target.org_id,
        group_id,
        "group.tenant_context.start",
        now,
    )
    .await?;

    Ok(Json(GroupAdminTenantContextStartResponse {
        access_token,
        token_type: "Bearer",
        acting_org_id: *target.org_id.as_uuid(),
        acting_org_name: target.name,
        acting_role: GROUP_ADMIN_TENANT_ACTING_ROLE,
        expires_at,
    }))
}

/// POST /api/v1/group-admin/tenant-context/exit — audit the end of a group
/// admin's writable tenant context. The original group-admin session token must
/// be used; a missing/expired source session still lets the client exit locally,
/// but the audit endpoint fails closed.
async fn exit_group_admin_tenant_context(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    Json(body): Json<GroupAdminTenantContextExitRequest>,
) -> Result<Json<GroupAdminTenantContextExitResponse>, RestError> {
    let services = state.services()?;
    let actor = authenticated_group_actor(services, &headers)?;
    let (group_id, target) =
        resolve_group_admin_target_org(&state.pool, actor, OrgId::from_uuid(body.org_id)).await?;

    record_group_tenant_context_audit(
        &state.pool,
        actor,
        target.org_id,
        group_id,
        "group.tenant_context.stop",
        OffsetDateTime::now_utc(),
    )
    .await?;

    Ok(Json(GroupAdminTenantContextExitResponse { ended: true }))
}

// ---------------------------------------------------------------------------
// dev-auth: local role-switch endpoint (feature-gated, NOT in default/release
// builds — see `mnt-gate-dev-auth-absence` and `Cargo.toml`'s `[features]`).
//
// # Why not `platform-rest`'s `view_as.rs`
//
// `view_as.rs` already mints real signed tokens through the same
// `mnt_platform_auth` issuance this endpoint uses, so its underlying primitive
// IS reused (see below) — but its HANDLER is the wrong shape for dev-auth, and
// deliberately not reused, for two independent reasons:
//
// 1. **Entry point vs. escalation.** `start_view_as` runs behind the PLATFORM
//    extractor: only an already-authenticated platform operator can reach it.
//    dev-auth must be the FIRST thing a developer calls with zero prior
//    session — an unauthenticated bootstrap like `otp/redeem`, not an
//    escalation of an existing one. Routing dev-auth through the platform
//    tier would mean either minting a fake platform token to satisfy that
//    extractor (defeats its entire "only platform tier can start" guarantee)
//    or weakening the extractor itself — both unacceptable.
// 2. **Read-only vs. read-write.** Every `view_as` token is permanently
//    mutation-blocked by `with_view_as_read_only_gate`, a BLANKET method gate
//    applied unconditionally to the tenant router (not itself feature-gated).
//    The role-switcher's whole point is exercising real CRUD as any role, so a
//    dev-auth session must carry `view_as = false`. Reusing `view_as`'s claim
//    shape would make every role-switch session permanently read-only.
//
// What IS reused: the one JWT issuance path every session-minting endpoint in
// this file already shares (`issue_token_pair` / `AccessTokenInput`, same
// signing keys, same `AccessClaims`) — no parallel signer, no new claim shape.
// The other reused piece is the `mnt-platform-provisioning` crate's user
// upsert pattern (`DevPrincipalProvisioner`, modeled on `apply_roster_tx`),
// because unlike `view_as` (which targets a REAL existing tenant role) a
// role-switch persona may not exist yet, and branch scope is re-resolved from
// a REAL `user_branches` row on every subsequent request.
// ---------------------------------------------------------------------------

/// POST /api/v1/dev-auth/session request body.
#[cfg(feature = "dev-auth")]
#[derive(Debug, Deserialize)]
struct DevAuthSessionRequest {
    org_id: Uuid,
    /// Canonical role code, e.g. `ADMIN` / `MECHANIC`.
    role: String,
    #[serde(default)]
    branch_ids: Vec<Uuid>,
    /// UI-gating hint only (exactly like the ordinary session's `feature_grants`
    /// claim) — backend authorization always re-resolves custom policy from the
    /// database per request and never trusts this claim.
    #[serde(default)]
    feature_grants: Vec<String>,
    #[serde(default)]
    display_name: Option<String>,
}

#[cfg(feature = "dev-auth")]
const DEV_AUTH_MAX_BRANCHES: usize = 32;
#[cfg(feature = "dev-auth")]
const DEV_AUTH_MAX_FEATURE_GRANTS: usize = 32;
#[cfg(feature = "dev-auth")]
const DEV_AUTH_MAX_FEATURE_GRANT_LEN: usize = 100;
#[cfg(feature = "dev-auth")]
const DEV_AUTH_MAX_DISPLAY_NAME_LEN: usize = 200;

/// Mint a local role-switch session for any role/org/branch/feature-grant
/// combo. Unauthenticated by design (like `otp/redeem`/`signup`): it IS the
/// entry point, gated instead by not existing in a release build. Fails closed
/// on every input; never reachable unless the crate/binary was built with
/// `--features dev-auth`.
#[cfg(feature = "dev-auth")]
async fn dev_auth_session(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    Json(body): Json<DevAuthSessionRequest>,
) -> Result<Response, RestError> {
    let services = state.services()?;

    let org_id = OrgId::from_uuid(body.org_id);
    if org_id == OrgId::platform() {
        return Err(RestError::bad_request(
            "dev-auth cannot mint a platform-tier session",
        ));
    }
    let role =
        Role::from_str(&body.role).map_err(|_| RestError::bad_request("unknown role code"))?;
    if body.branch_ids.len() > DEV_AUTH_MAX_BRANCHES {
        return Err(RestError::bad_request("too many branch_ids"));
    }
    if body.feature_grants.len() > DEV_AUTH_MAX_FEATURE_GRANTS
        || body
            .feature_grants
            .iter()
            .any(|grant| grant.is_empty() || grant.len() > DEV_AUTH_MAX_FEATURE_GRANT_LEN)
    {
        return Err(RestError::bad_request("invalid feature_grants"));
    }
    let display_name = body
        .display_name
        .unwrap_or_else(|| format!("dev:{}", role.as_str()));
    let display_name = display_name.trim();
    if display_name.is_empty() || display_name.len() > DEV_AUTH_MAX_DISPLAY_NAME_LEN {
        return Err(RestError::bad_request(
            "display_name must be 1-200 characters",
        ));
    }

    let branch_ids: Vec<BranchId> = body
        .branch_ids
        .iter()
        .copied()
        .map(BranchId::from_uuid)
        .collect();
    let now = OffsetDateTime::now_utc();
    let principal = mnt_platform_provisioning::DevPrincipalProvisioner
        .upsert(
            &state.pool,
            mnt_platform_provisioning::DevPrincipalRequest {
                org_id,
                display_name: display_name.to_owned(),
                role: role.as_str().to_owned(),
                branch_ids: branch_ids.clone(),
            },
            now,
        )
        .await
        .map_err(RestError::from_provisioning)?;

    let user = UserAuthContext {
        user_id: UserId::from_uuid(principal.user_id),
        org_id,
        display_name: display_name.to_owned(),
        username: display_name.to_owned(),
        roles: vec![role.as_str().to_owned()],
        branches: branch_ids,
        group_roles: Vec::new(),
        feature_grants: body.feature_grants.clone(),
        // dev-auth builds the context without a DB read, so leave the safe 0
        // baseline. This is a dev-only build path and freshness is not consulted
        // by any decision in SLICE-2 anyway.
        authz_subject_version: 0,
        authz_policy_version: 0,
        session_generation: 0,
    };
    let tokens = issue_token_pair(&state.pool, services, &user).await?;

    // Loud by design: a dev-auth mint is a security-relevant event even in a
    // local/dev-only build, so it must never be silent.
    tracing::warn!(
        org_id = %body.org_id,
        role = role.as_str(),
        user_id = %principal.user_id,
        "dev-auth: minted a local role-switch session (dev-auth build only)"
    );
    record_auth_audit(
        &state.pool,
        org_id,
        *user.user_id.as_uuid(),
        "dev_auth.session.mint",
        serde_json::json!({
            "role": role.as_str(),
            "branch_ids": body.branch_ids,
        }),
    )
    .await?;

    Ok(token_pair_response(
        tokens,
        &headers,
        services.cookie_secure,
    ))
}

impl AuthRestState {
    fn services(&self) -> Result<&AuthServices, RestError> {
        self.services.as_ref().ok_or_else(|| {
            RestError::unavailable("auth REST is mounted but auth services are not configured")
        })
    }
}

#[derive(Debug)]
struct UserAuthContext {
    user_id: UserId,
    org_id: OrgId,
    display_name: String,
    username: String,
    roles: Vec<String>,
    branches: Vec<BranchId>,
    /// Live group roles resolved from owner-only grants at login/refresh time.
    /// Clients use these only for UI gating; group-admin endpoints re-resolve
    /// the grant from the database before every cross-tenant action.
    group_roles: Vec<String>,
    /// Runtime-effective custom-role feature keys resolved at login/refresh time
    /// for UI gating hints. Backend request authorization ignores the JWT hint
    /// and re-resolves custom policy from the database on every request.
    feature_grants: Vec<String>,
    /// Subject authorization freshness snapshot resolved from the DB at
    /// login/refresh time (Cedar/PBAC activation, ADR-0021), stamped into the
    /// access token so a later Cedar slice can deny a stale subject. SLICE-2 only
    /// sources these; no authorization decision consults them yet. Mint paths
    /// that do not resolve them (dev-auth) leave the safe `0` baseline.
    authz_subject_version: u64,
    authz_policy_version: u64,
    session_generation: u64,
}

#[derive(Debug)]
struct IssuedTokenPair {
    access_token: String,
    refresh_token: String,
    refresh_expires_at: OffsetDateTime,
    family_id: Uuid,
}

impl IssuedTokenPair {
    /// Body-transport (mobile) response: the refresh token rides in the JSON body.
    fn into_response(self) -> TokenPairResponse {
        TokenPairResponse {
            access_token: self.access_token,
            refresh_token: Some(self.refresh_token),
            token_type: "Bearer",
            refresh_expires_at: self.refresh_expires_at,
            requires_passkey_setup: false,
        }
    }
}

async fn issue_token_pair(
    pool: &PgPool,
    services: &AuthServices,
    user: &UserAuthContext,
) -> Result<IssuedTokenPair, RestError> {
    let now = OffsetDateTime::now_utc();
    let access_input = AccessTokenInput {
        subject: user.user_id,
        org_id: user.org_id,
        roles: user.roles.clone(),
        branches: user.branches.clone(),
        platform: user.org_id == OrgId::platform(),
        // A normal login/refresh token is never an impersonation token.
        view_as: false,
        read_only: false,
        // DISPLAY-ONLY identity for the topbar; never used for authz.
        display_name: Some(user.display_name.clone()),
        feature_grants: user.feature_grants.clone(),
        // Subject authorization freshness snapshot (Cedar/PBAC, ADR-0021),
        // resolved from the DB when the context was loaded. SLICE-2: sourced onto
        // the token, not yet consulted by any decision.
        authz_subject_version: user.authz_subject_version,
        authz_policy_version: user.authz_policy_version,
        session_generation: user.session_generation,
        issued_at: now,
    };
    let access_token = if user.group_roles.is_empty() {
        services.jwt_issuer.issue_access_token(access_input)
    } else {
        services
            .jwt_issuer
            .issue_access_token_with_group_roles(access_input, user.group_roles.clone())
    }
    .map_err(|err| RestError::internal(err.to_string()))?;
    let refresh = services
        .refresh_tokens
        .issue_family(
            pool,
            *user.user_id.as_uuid(),
            user.org_id,
            now,
            services.refresh_token_ttl,
        )
        .await
        .map_err(|err| RestError::internal(err.to_string()))?;

    Ok(IssuedTokenPair {
        access_token,
        refresh_token: refresh.token.as_str().to_owned(),
        refresh_expires_at: refresh.expires_at,
        family_id: refresh.family_id,
    })
}

/// Mint a fresh access JWT for `user`. Shared by the refresh path, which pairs it
/// with either a rotated cookie (web) or a body refresh token (mobile).
fn issue_access_token(
    services: &AuthServices,
    user: &UserAuthContext,
) -> Result<String, RestError> {
    let input = AccessTokenInput {
        subject: user.user_id,
        org_id: user.org_id,
        roles: user.roles.clone(),
        branches: user.branches.clone(),
        // A user homed in the platform sentinel org is the PLATFORM admin:
        // mint a platform token so it can reach `/platform/*` (and is rejected
        // on tenant `/api/*`). Every real tenant user gets `false`.
        platform: user.org_id == OrgId::platform(),
        // The ordinary refresh path never mints an impersonation token.
        view_as: false,
        read_only: false,
        // DISPLAY-ONLY identity for the topbar; re-loaded from the user on
        // every refresh so a renamed user's token reflects it. Never authz.
        display_name: Some(user.display_name.clone()),
        feature_grants: user.feature_grants.clone(),
        // Subject authorization freshness snapshot (Cedar/PBAC, ADR-0021),
        // re-resolved from the DB on every refresh so a rotated token carries the
        // current values. SLICE-2: sourced, not yet consulted.
        authz_subject_version: user.authz_subject_version,
        authz_policy_version: user.authz_policy_version,
        session_generation: user.session_generation,
        issued_at: OffsetDateTime::now_utc(),
    };
    if user.group_roles.is_empty() {
        services.jwt_issuer.issue_access_token(input)
    } else {
        services
            .jwt_issuer
            .issue_access_token_with_group_roles(input, user.group_roles.clone())
    }
    .map_err(|err| RestError::internal(err.to_string()))
}

/// Load a user's auth context when the caller already holds the request's tenant
/// (e.g. from the verified JWT `org` claim, before the org middleware arms the
/// GUC). `users` and `user_branches` are FORCE RLS, so as the non-owner `mnt_rt`
/// role these reads return ZERO rows unless the GUC is armed; this variant arms
/// it from `org` for the read transaction. A user whose row is not visible under
/// `org` (wrong tenant, or no such user) is an unauthorized request.
async fn load_user_auth_context_in_org(
    pool: &PgPool,
    org: OrgId,
    user_id: Uuid,
) -> Result<UserAuthContext, RestError> {
    let mut context = with_org_conn::<_, UserAuthContext, RestError>(pool, org, move |tx| {
        Box::pin(async move { load_user_auth_context_tx(tx, user_id).await })
    })
    .await?;
    context.feature_grants = resolve_feature_grant_keys_for_user(pool, &context).await?;
    Ok(context)
}

async fn resolve_feature_grant_keys_for_user(
    pool: &PgPool,
    context: &UserAuthContext,
) -> Result<Vec<String>, RestError> {
    if context.org_id == OrgId::platform() {
        return Ok(Vec::new());
    }

    let roles = context
        .roles
        .iter()
        .map(|role| Role::from_str(role).map_err(|err| RestError::internal(err.to_string())))
        .collect::<Result<Vec<_>, _>>()?;
    let branch_scope = resolve_branch_scope_in_org(pool, context.org_id, context.user_id, &roles)
        .await
        .map_err(|err| RestError::internal(err.to_string()))?;
    let grants = resolve_effective_feature_grants_in_org(
        pool,
        context.org_id,
        context.user_id,
        &branch_scope,
    )
    .await
    .map_err(|err| RestError::internal(err.to_string()))?;
    let mut feature_keys = grants
        .into_iter()
        .map(|grant| grant.feature.as_str().to_owned())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    feature_keys.sort();
    Ok(feature_keys)
}

/// Load a user's auth context inside an EXISTING tenant-scoped transaction (the
/// `app.current_org` GUC must already be armed by the caller). Shared core of
/// [`load_user_auth_context_in_org`].
async fn load_user_auth_context_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: Uuid,
) -> Result<UserAuthContext, RestError> {
    let row = sqlx::query(
        r#"
        SELECT display_name, phone, roles, is_active, org_id
        FROM users
        WHERE id = $1
        "#,
    )
    .bind(user_id)
    .fetch_optional(tx.as_mut())
    .await
    .map_err(|err| RestError::internal(err.to_string()))?
    .ok_or_else(|| RestError::unauthorized("user not found"))?;

    let display_name: String = row
        .try_get("display_name")
        .map_err(|err| RestError::internal(err.to_string()))?;
    // The user's tenant. `users.org_id` is NOT NULL post-migration 0029, so a
    // successful login always carries a real org into the access token.
    let org_uuid: Uuid = row
        .try_get("org_id")
        .map_err(|err| RestError::internal(err.to_string()))?;
    let org_id = OrgId::from_uuid(org_uuid);
    let phone: Option<String> = row
        .try_get("phone")
        .map_err(|err| RestError::internal(err.to_string()))?;
    let roles: Vec<String> = row
        .try_get("roles")
        .map_err(|err| RestError::internal(err.to_string()))?;
    let is_active: bool = row
        .try_get("is_active")
        .map_err(|err| RestError::internal(err.to_string()))?;
    if !is_active {
        return Err(RestError::unauthorized("user is inactive"));
    }
    if roles.is_empty() {
        return Err(RestError::unauthorized("user has no roles"));
    }

    let branch_rows = sqlx::query(
        r#"
        SELECT branch_id
        FROM user_branches
        WHERE user_id = $1
        ORDER BY branch_id
        "#,
    )
    .bind(user_id)
    .fetch_all(tx.as_mut())
    .await
    .map_err(|err| RestError::internal(err.to_string()))?;
    let branches = branch_rows
        .into_iter()
        .map(|row| {
            row.try_get::<Uuid, _>("branch_id")
                .map(BranchId::from_uuid)
                .map_err(|err| RestError::internal(err.to_string()))
        })
        .collect::<Result<Vec<_>, _>>()?;

    let group_role_rows = sqlx::query(
        r#"
        SELECT DISTINCT group_role
        FROM group_role_grants_for_user($1)
        ORDER BY group_role
        "#,
    )
    .bind(user_id)
    .fetch_all(tx.as_mut())
    .await
    .map_err(|err| RestError::internal(err.to_string()))?;
    let group_roles = group_role_rows
        .into_iter()
        .map(|row| {
            row.try_get::<String, _>("group_role")
                .map_err(|err| RestError::internal(err.to_string()))
        })
        .collect::<Result<Vec<_>, _>>()?;

    // Snapshot the subject authorization freshness for the access token
    // (Cedar/PBAC activation, ADR-0021). The `app.current_org` GUC is already
    // armed by the caller, so these RLS-scoped reads only ever see this tenant's
    // rows. An absent row is the "no bump yet" baseline and reads as 0, matching
    // the token default. SLICE-2 sources these onto the token; no authorization
    // decision consults them yet.
    let subject_versions_row = sqlx::query(
        r#"
        SELECT version, session_generation
        FROM subject_authz_versions
        WHERE user_id = $1
        "#,
    )
    .bind(user_id)
    .fetch_optional(tx.as_mut())
    .await
    .map_err(|err| RestError::internal(err.to_string()))?;
    let (authz_subject_version, session_generation) = match subject_versions_row {
        Some(row) => {
            let version: i64 = row
                .try_get("version")
                .map_err(|err| RestError::internal(err.to_string()))?;
            let session_generation: i64 = row
                .try_get("session_generation")
                .map_err(|err| RestError::internal(err.to_string()))?;
            (
                u64::try_from(version).unwrap_or(0),
                u64::try_from(session_generation).unwrap_or(0),
            )
        }
        None => (0, 0),
    };
    let policy_version: Option<i64> = sqlx::query_scalar(
        r#"
        SELECT version
        FROM policy_versions
        WHERE org_id = $1
        "#,
    )
    .bind(*org_id.as_uuid())
    .fetch_optional(tx.as_mut())
    .await
    .map_err(|err| RestError::internal(err.to_string()))?;
    let authz_policy_version = policy_version
        .map(|version| u64::try_from(version).unwrap_or(0))
        .unwrap_or(0);

    Ok(UserAuthContext {
        user_id: UserId::from_uuid(user_id),
        org_id,
        display_name,
        username: phone.unwrap_or_else(|| user_id.to_string()),
        roles,
        branches,
        group_roles,
        feature_grants: Vec::new(),
        authz_subject_version,
        authz_policy_version,
        session_generation,
    })
}

async fn ensure_registration_ceremony_owner(
    pool: &PgPool,
    ceremony_id: Uuid,
    user_id: Uuid,
) -> Result<(), RestError> {
    let owner: Option<Uuid> = sqlx::query_scalar(
        r#"
        SELECT user_id
        FROM auth_webauthn_ceremonies
        WHERE id = $1
          AND ceremony_kind = 'registration'
          AND consumed_at IS NULL
          AND expires_at > now()
        "#,
    )
    .bind(ceremony_id)
    // rls-arming: ok auth_webauthn_ceremonies is a global pre-auth table (no org_id, no RLS)
    .fetch_optional(pool)
    .await
    .map_err(|err| RestError::internal(err.to_string()))?
    .flatten();

    match owner {
        Some(owner) if owner == user_id => Ok(()),
        Some(_) => Err(RestError::unauthorized(
            "registration ceremony belongs to a different user",
        )),
        None => Err(RestError::unauthorized(
            "registration ceremony not found or expired",
        )),
    }
}

/// Verify the bearer token and return BOTH the authenticated user id AND the
/// tenant from the verified `org` claim.
///
/// The passkey registration/start paths are pre-auth-middleware (no
/// `app.current_org` is armed by the router), but the caller IS authenticated:
/// the verified token carries the tenant. Using the JWT's org — never a `users`
/// read under RLS — breaks the chicken-and-egg and stamps every passkey write
/// with the correct tenant.
fn authenticated_user_context(
    services: &AuthServices,
    headers: &HeaderMap,
) -> Result<(Uuid, OrgId), RestError> {
    let token = bearer_token(headers)?;
    let claims = services
        .jwt_verifier
        .verify_access_token(token)
        .map_err(|_| RestError::unauthorized("invalid bearer token"))?;
    let org_id = OrgId::from_str(&claims.org)
        .map_err(|_| RestError::unauthorized("token org claim is not a valid uuid"))?;
    let user_id = user_id_from_claims(claims)?;
    Ok((user_id, org_id))
}

fn user_id_from_claims(claims: AccessClaims) -> Result<Uuid, RestError> {
    Uuid::from_str(&claims.sub).map_err(|_| RestError::unauthorized("token subject is invalid"))
}

async fn ensure_required_privacy_consent(
    pool: &PgPool,
    org_id: OrgId,
    user_id: Uuid,
) -> Result<(), RestError> {
    required_privacy_consent_accepted_at(pool, org_id, user_id)
        .await?
        .map(|_| ())
        .ok_or_else(|| RestError::forbidden("required privacy consent has not been accepted"))
}

async fn required_privacy_consent_accepted_at(
    pool: &PgPool,
    org_id: OrgId,
    user_id: Uuid,
) -> Result<Option<OffsetDateTime>, RestError> {
    let org_uuid = *org_id.as_uuid();
    with_org_conn(pool, org_id, |tx| {
        Box::pin(async move {
            sqlx::query_scalar::<_, OffsetDateTime>(
                r#"
                SELECT occurred_at
                FROM audit_events
                WHERE org_id = $1
                  AND actor = $2
                  AND action = 'privacy.required_accept'
                  AND target_type = 'privacy_terms'
                  AND target_id = $3
                ORDER BY occurred_at DESC
                LIMIT 1
                "#,
            )
            .bind(org_uuid)
            .bind(user_id)
            .bind(REQUIRED_PRIVACY_TERMS_VERSION)
            .fetch_optional(tx.as_mut())
            .await
            .map_err(|err| RestError::internal(err.to_string()))
        })
    })
    .await
}

async fn latest_user_passkey_id(
    pool: &PgPool,
    org_id: OrgId,
    user_id: Uuid,
) -> Result<Option<Uuid>, RestError> {
    with_org_conn(pool, org_id, move |tx| {
        Box::pin(async move {
            sqlx::query_scalar::<_, Uuid>(
                r#"
                SELECT id
                FROM auth_webauthn_credentials
                WHERE user_id = $1
                ORDER BY created_at DESC
                LIMIT 1
                "#,
            )
            .bind(user_id)
            .fetch_optional(tx.as_mut())
            .await
            .map_err(|err| RestError::internal(err.to_string()))
        })
    })
    .await
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

async fn record_auth_audit(
    pool: &PgPool,
    org_id: OrgId,
    user_id: Uuid,
    action: &str,
    after: serde_json::Value,
) -> Result<(), RestError> {
    let event = AuditEvent::new(
        Some(UserId::from_uuid(user_id)),
        AuditAction::new(action).map_err(|err| RestError::internal(err.to_string()))?,
        "users",
        user_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org_id)
    .with_snapshots(None, Some(after));

    with_audit::<_, (), RestError>(pool, event, |_tx| Box::pin(async move { Ok(()) })).await
}

/// Audit a failed unauthenticated attempt with no actor and no PII (no OTP value,
/// no client IP) so the `pii-no-logs` gate and audit policy both hold.
async fn record_anonymous_auth_audit(
    pool: &PgPool,
    action: &str,
    after: serde_json::Value,
) -> Result<(), RestError> {
    let event = AuditEvent::new(
        None,
        AuditAction::new(action).map_err(|err| RestError::internal(err.to_string()))?,
        "auth_bootstrap_credential",
        "redeem",
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_snapshots(None, Some(after));

    with_audit::<_, (), RestError>(pool, event, |_tx| Box::pin(async move { Ok(()) })).await
}

/// Resolve the admin-supplied OTP TTL, defaulting to 24h and rejecting
/// non-positive or absurdly large values.
fn resolve_otp_ttl(ttl_seconds: Option<i64>) -> Result<Duration, RestError> {
    let Some(secs) = ttl_seconds else {
        return Ok(DEFAULT_OTP_TTL);
    };
    if secs <= 0 {
        return Err(RestError::bad_request("ttl_seconds must be positive"));
    }
    let ttl = Duration::seconds(secs);
    if ttl > MAX_OTP_TTL {
        return Err(RestError::bad_request(
            "ttl_seconds exceeds the maximum allowed lifetime",
        ));
    }
    Ok(ttl)
}

// ---------------------------------------------------------------------------
// Authorization principal (for the admin issue-OTP endpoint).
// ---------------------------------------------------------------------------

async fn principal_from_headers(
    pool: &PgPool,
    services: &AuthServices,
    headers: &HeaderMap,
) -> Result<Principal, RestError> {
    mnt_platform_request_context::resolve_principal(&services.jwt_verifier, pool, headers)
        .await
        .map_err(rest_error_from_request_context)
}

fn rest_error_from_request_context(
    err: mnt_platform_request_context::RequestContextError,
) -> RestError {
    match err {
        mnt_platform_request_context::RequestContextError::VerifierUnavailable => {
            RestError::unavailable("JWT verification is not configured for auth API")
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

fn authenticated_group_actor(
    services: &AuthServices,
    headers: &HeaderMap,
) -> Result<UserId, RestError> {
    let token = bearer_token(headers)?;
    let claims = services
        .jwt_verifier
        .verify_access_token(token)
        .map_err(|_| RestError::unauthorized("invalid bearer token"))?;
    if claims.platform {
        return Err(RestError::forbidden(
            "platform tokens cannot use tenant group-admin endpoints",
        ));
    }
    if claims.view_as {
        return Err(RestError::forbidden(
            "read-only view-as tokens cannot manage group subsidiaries",
        ));
    }
    if claims.tenant_context.is_some() {
        return Err(RestError::forbidden(
            "delegated tenant-context tokens cannot manage group subsidiaries",
        ));
    }
    if !has_group_admin_role_hint(&claims.group_roles) {
        return Err(RestError::forbidden("group admin role required"));
    }
    Ok(UserId::from_uuid(user_id_from_claims(claims)?))
}

fn has_group_admin_role_hint(group_roles: &[String]) -> bool {
    group_roles
        .iter()
        .any(|role| role.as_str() == GROUP_ADMIN_GROUP_ROLE)
}

#[derive(Debug)]
struct GroupIdentity {
    id: Uuid,
    slug: String,
    name: String,
    status: String,
}

async fn load_group_admin_groups(
    pool: &PgPool,
    actor: UserId,
) -> Result<Vec<GroupAdminGroupResponse>, RestError> {
    let group_ids = group_admin_group_ids(pool, actor).await?;
    if group_ids.is_empty() {
        return Err(RestError::forbidden("group admin role required"));
    }

    let group_rows = sqlx::query(
        r#"
        SELECT id, slug, name, status
        FROM groups
        WHERE id = ANY($1)
          AND status = 'ACTIVE'
        ORDER BY name ASC, slug ASC, id ASC
        "#,
    )
    .bind(&group_ids)
    // rls-arming: ok global identity metadata; mnt_rt has SELECT on safe columns only
    .fetch_all(pool)
    .await
    .map_err(|err| RestError::internal(err.to_string()))?;

    let groups = group_rows
        .into_iter()
        .map(|row| {
            Ok::<_, RestError>(GroupIdentity {
                id: row
                    .try_get("id")
                    .map_err(|err| RestError::internal(err.to_string()))?,
                slug: row
                    .try_get("slug")
                    .map_err(|err| RestError::internal(err.to_string()))?,
                name: row
                    .try_get("name")
                    .map_err(|err| RestError::internal(err.to_string()))?,
                status: row
                    .try_get("status")
                    .map_err(|err| RestError::internal(err.to_string()))?,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;

    let mut responses = Vec::with_capacity(groups.len());
    for group in groups {
        let members = mnt_platform_group::group_member_orgs(pool, group.id, actor).await?;
        responses.push(GroupAdminGroupResponse {
            id: group.id,
            slug: group.slug,
            name: group.name,
            status: group.status,
            members: members
                .into_iter()
                .map(GroupAdminMemberOrgResponse::from)
                .collect(),
        });
    }

    Ok(responses)
}

async fn group_admin_group_ids(pool: &PgPool, actor: UserId) -> Result<Vec<Uuid>, RestError> {
    sqlx::query_scalar(
        r#"
        SELECT DISTINCT grants.group_id
        FROM group_role_grants_for_user($1) AS grants
            JOIN groups g ON g.id = grants.group_id
        WHERE grants.group_role = $2
          AND g.status = 'ACTIVE'
        ORDER BY grants.group_id
        "#,
    )
    .bind(*actor.as_uuid())
    .bind(GROUP_ADMIN_GROUP_ROLE)
    // rls-arming: ok identity-only SECURITY DEFINER grants resolver + safe groups metadata
    .fetch_all(pool)
    .await
    .map_err(|err| RestError::internal(err.to_string()))
}

async fn resolve_group_admin_target_org(
    pool: &PgPool,
    actor: UserId,
    target_org: OrgId,
) -> Result<(Uuid, GroupMemberOrg), RestError> {
    let group_ids = group_admin_group_ids(pool, actor).await?;
    if group_ids.is_empty() {
        return Err(RestError::forbidden("group admin role required"));
    }

    for group_id in group_ids {
        let members = mnt_platform_group::group_member_orgs(pool, group_id, actor).await?;
        if let Some(member) = members
            .into_iter()
            .find(|member| member.org_id == target_org)
        {
            return Ok((group_id, member));
        }
    }

    Err(RestError::forbidden(
        "target organization is not a subsidiary managed by this group admin",
    ))
}

async fn record_group_tenant_context_audit(
    pool: &PgPool,
    actor: UserId,
    target_org: OrgId,
    group_id: Uuid,
    action: &str,
    occurred_at: OffsetDateTime,
) -> Result<(), RestError> {
    let event = AuditEvent::new(
        Some(actor),
        AuditAction::new(action).map_err(|err| RestError::internal(err.to_string()))?,
        "organization",
        target_org.to_string(),
        TraceContext::generate(),
        occurred_at,
    )
    .with_org(target_org)
    .with_snapshots(
        None,
        Some(serde_json::json!({
            "group_id": group_id,
            "acting_org_id": target_org.to_string(),
            "acting_role": GROUP_ADMIN_TENANT_ACTING_ROLE,
            "read_only": false,
        })),
    );

    with_audit::<_, (), RestError>(pool, event, |_tx| Box::pin(async move { Ok(()) })).await
}

impl From<GroupMemberOrg> for GroupAdminMemberOrgResponse {
    fn from(value: GroupMemberOrg) -> Self {
        Self {
            id: *value.org_id.as_uuid(),
            slug: value.slug,
            name: value.name,
            status: value.status,
        }
    }
}

// ---------------------------------------------------------------------------
// DB-backed cross-instance rate limiter.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
enum RateLimitEndpoint {
    Signup,
    OtpRedeem,
    LoginStart,
    DeviceLoginStart,
    DeviceLoginPoll,
    DeviceLoginApprove,
    Refresh,
}

impl RateLimitEndpoint {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Signup => "signup",
            Self::OtpRedeem => "otp_redeem",
            Self::LoginStart => "login_start",
            Self::DeviceLoginStart => "device_login_start",
            Self::DeviceLoginPoll => "device_login_poll",
            Self::DeviceLoginApprove => "device_login_approve",
            Self::Refresh => "refresh",
        }
    }

    const fn limits(self) -> (i64, i64, i64) {
        match self {
            // Polling is expected while a desktop waits for a phone approval; use
            // a wider bucket than credential submission while keeping a bound.
            Self::DeviceLoginPoll => (60, 60, 1_000),
            // Refresh requires possession of an opaque rotating token; legitimate
            // browser hard navigations/reloads can perform many boot refreshes in
            // one minute because the access token is memory-only. Keep refresh
            // bounded, but do not reuse the much tighter credential-submission cap.
            Self::Refresh => (60, 60, 1_000),
            _ => (RATE_LIMIT_PER_IP, RATE_LIMIT_PER_DEVICE, RATE_LIMIT_GLOBAL),
        }
    }
}

/// Enforce per-IP, per-device, and global fixed-window caps on an unauthenticated
/// auth endpoint, returning `429` when any bucket is exceeded.
///
/// The deployment is multi-instance, so the counters live in Postgres
/// (`auth_rate_limit`) and every instance increments the same row. The device id
/// is an OPTIONAL, client-controlled `X-Device-Id` header: when absent or
/// malformed the per-device bucket is skipped, so the per-IP and global caps
/// always still apply. Because a device id can be rotated freely, the per-IP cap
/// is the real adversarial bound; the per-device cap only adds granularity for
/// legitimate shared-IP situations.
async fn rate_limit(
    pool: &PgPool,
    headers: &HeaderMap,
    trusted_proxy_count: usize,
    endpoint: RateLimitEndpoint,
    now: OffsetDateTime,
) -> Result<(), RestError> {
    let window_start = floor_to_window(now);
    let endpoint_str = endpoint.as_str();

    let mut buckets: Vec<(String, i64)> = Vec::with_capacity(3);
    let (per_ip_cap, per_device_cap, global_cap) = endpoint.limits();
    if let Some(ip) = client_ip(headers, trusted_proxy_count) {
        buckets.push((format!("ip:{ip}"), per_ip_cap));
    }
    if let Some(device) = client_device_id(headers) {
        buckets.push((format!("dev:{device}"), per_device_cap));
    }
    buckets.push(("global".to_owned(), global_cap));

    for (client_key, cap) in buckets {
        let attempts = increment_rate_bucket(pool, &client_key, endpoint_str, window_start).await?;
        if attempts > cap {
            return Err(RestError::too_many_requests());
        }
    }
    Ok(())
}

/// Atomically increment (or insert) the fixed-window counter for one bucket and
/// return the new attempt count. The UPSERT makes the increment correct across
/// concurrent requests and across app instances.
async fn increment_rate_bucket(
    pool: &PgPool,
    client_key: &str,
    endpoint: &str,
    window_start: OffsetDateTime,
) -> Result<i64, RestError> {
    let attempts: i32 = sqlx::query_scalar(
        r#"
        INSERT INTO auth_rate_limit (client_key, endpoint, window_start, attempts)
        VALUES ($1, $2, $3, 1)
        ON CONFLICT (client_key, endpoint, window_start)
        DO UPDATE SET attempts = auth_rate_limit.attempts + 1
        RETURNING attempts
        "#,
    )
    .bind(client_key)
    .bind(endpoint)
    .bind(window_start)
    // rls-arming: ok auth_rate_limit is a global table (no org_id, no RLS)
    .fetch_one(pool)
    .await
    .map_err(|err| RestError::internal(err.to_string()))?;
    Ok(i64::from(attempts))
}

/// Floor a timestamp to the start of its fixed rate-limit window.
fn floor_to_window(now: OffsetDateTime) -> OffsetDateTime {
    let window_secs = RATE_LIMIT_WINDOW.whole_seconds().max(1);
    let unix = now.unix_timestamp();
    let floored = unix - unix.rem_euclid(window_secs);
    OffsetDateTime::from_unix_timestamp(floored).unwrap_or(now)
}

/// Derive the rate-limit client IP from `X-Forwarded-For`.
///
/// XFF is appended left-to-right, so the RIGHTMOST entry is the address the
/// closest trusted proxy observed and the leftmost entries are attacker-spoofable
/// (a client can prepend arbitrary values). With `trusted_proxy_count` proxies in
/// front of this service, the real client is the Nth-from-the-right entry: index
/// `len - trusted_proxy_count`. Anything left of that is untrusted and ignored.
///
/// This assumes the ingress proxy sets/strips XFF so the chain to the right of
/// the client entry is genuine. The value is used only as an opaque rate-limit
/// key and is never logged.
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
    // Nth-from-the-right; clamp so a shorter-than-expected chain still yields the
    // left-most (oldest) entry we have rather than underflowing.
    let hops = trusted_proxy_count.max(1);
    let index = entries.len().saturating_sub(hops);
    entries.get(index).map(|ip| (*ip).to_owned())
}

/// Read the optional, client-controlled `X-Device-Id` header. Bounded length and
/// a restricted charset reject malformed/oversized values; on rejection the
/// caller falls back to per-IP limiting alone.
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
// Dual-transport refresh token: web=HttpOnly cookie, mobile=JSON body.
// ---------------------------------------------------------------------------

/// True when the caller opted into the cookie transport via
/// `X-Auth-Transport: cookie` (the web client). Mobile clients omit the header
/// and keep the body-based refresh token, so they take the `false` branch.
fn wants_cookie_transport(headers: &HeaderMap) -> bool {
    headers
        .get(AUTH_TRANSPORT_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .is_some_and(|value| value.eq_ignore_ascii_case(AUTH_TRANSPORT_COOKIE))
}

/// Read the refresh token from the `mnt_refresh` cookie, parsing the raw `Cookie`
/// header (`a=b; c=d`). Returns `None` when the header or the cookie is absent or
/// the value is empty. Used by the web transport; mobile reads it from the body.
fn refresh_cookie_value(headers: &HeaderMap) -> Option<String> {
    let cookie_header = headers.get(header::COOKIE)?.to_str().ok()?;
    cookie_header
        .split(';')
        .filter_map(|pair| pair.split_once('='))
        .find_map(|(name, value)| {
            (name.trim() == REFRESH_COOKIE_NAME).then(|| value.trim().to_owned())
        })
        .filter(|value| !value.is_empty())
}

/// Build a `Set-Cookie` header that stores the refresh token for the web
/// transport.
///
/// CSRF safety (confirmed): `SameSite=Strict` stops the browser from attaching
/// this cookie to any cross-site request, so a forged request from another origin
/// carries no refresh token. The `Path=/api/v1/auth` scope keeps it off every
/// other API call, and the access token travels in the `Authorization` header
/// (NOT a cookie), so a state-changing API call can never be driven by an
/// ambient cookie alone. `HttpOnly` keeps the token out of JS (XSS exfiltration),
/// and `Secure` (prod) forbids plaintext transmission. Together these make the
/// cookie transport CSRF-safe without a separate CSRF token.
fn refresh_set_cookie(token: &str, max_age_secs: i64, secure: bool) -> Option<HeaderValue> {
    let max_age = max_age_secs.max(0);
    let mut cookie = format!(
        "{REFRESH_COOKIE_NAME}={token}; HttpOnly; SameSite=Strict; Path={REFRESH_COOKIE_PATH}; Max-Age={max_age}"
    );
    if secure {
        cookie.push_str("; Secure");
    }
    HeaderValue::from_str(&cookie).ok()
}

/// Build a `Set-Cookie` header that CLEARS the refresh cookie (logout): same
/// name/path/attributes with `Max-Age=0` so the browser drops it immediately.
fn refresh_clear_cookie(secure: bool) -> Option<HeaderValue> {
    refresh_set_cookie("", 0, secure)
}

/// Turn a minted token pair into a transport-appropriate response.
///
/// Cookie transport (web): emit the refresh token as an HttpOnly `Set-Cookie`
/// and NULL the body `refresh_token` so it never reaches web JS. Body transport
/// (mobile): leave the refresh token in the JSON body and set no cookie. The
/// access token stays in the body in both cases.
fn token_pair_response(
    tokens: IssuedTokenPair,
    headers: &HeaderMap,
    cookie_secure: bool,
) -> Response {
    if wants_cookie_transport(headers) {
        let max_age = (tokens.refresh_expires_at - OffsetDateTime::now_utc()).whole_seconds();
        let body = TokenPairResponse {
            access_token: tokens.access_token,
            refresh_token: None,
            token_type: "Bearer",
            refresh_expires_at: tokens.refresh_expires_at,
            requires_passkey_setup: false,
        };
        with_refresh_cookie(
            Json(body).into_response(),
            refresh_set_cookie(&tokens.refresh_token, max_age, cookie_secure),
        )
    } else {
        Json(tokens.into_response()).into_response()
    }
}

fn device_login_status(status: &'static str) -> DeviceLoginPollResponse {
    DeviceLoginPollResponse {
        status,
        access_token: None,
        refresh_token: None,
        token_type: None,
        refresh_expires_at: None,
        requires_passkey_setup: None,
    }
}

fn device_login_token_response(
    tokens: IssuedTokenPair,
    headers: &HeaderMap,
    cookie_secure: bool,
) -> Response {
    if wants_cookie_transport(headers) {
        let max_age = (tokens.refresh_expires_at - OffsetDateTime::now_utc()).whole_seconds();
        let body = DeviceLoginPollResponse {
            status: "approved",
            access_token: Some(tokens.access_token),
            refresh_token: None,
            token_type: Some("Bearer"),
            refresh_expires_at: Some(tokens.refresh_expires_at),
            requires_passkey_setup: Some(false),
        };
        with_refresh_cookie(
            Json(body).into_response(),
            refresh_set_cookie(&tokens.refresh_token, max_age, cookie_secure),
        )
    } else {
        let body = DeviceLoginPollResponse {
            status: "approved",
            access_token: Some(tokens.access_token),
            refresh_token: Some(tokens.refresh_token),
            token_type: Some("Bearer"),
            refresh_expires_at: Some(tokens.refresh_expires_at),
            requires_passkey_setup: Some(false),
        };
        Json(body).into_response()
    }
}

fn normalize_device_login_token(raw: &str, prefix: &str) -> Result<String, RestError> {
    let token = raw.trim();
    let suffix = token
        .strip_prefix(prefix)
        .ok_or_else(|| RestError::unauthorized("invalid or expired login handoff"))?;
    if suffix.len() != 64 || !suffix.chars().all(|char| char.is_ascii_hexdigit()) {
        return Err(RestError::unauthorized("invalid or expired login handoff"));
    }
    Ok(token.to_owned())
}

fn generate_device_login_token(prefix: &str) -> String {
    let mut bytes = [0u8; 32];
    bytes[..16].copy_from_slice(Uuid::new_v4().as_bytes());
    bytes[16..].copy_from_slice(Uuid::new_v4().as_bytes());
    format!("{prefix}{}", hex_encode(&bytes))
}

fn hash_device_login_token(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

/// Append a `Set-Cookie` header to a response when one was built.
fn with_refresh_cookie(mut response: Response, cookie: Option<HeaderValue>) -> Response {
    if let Some(cookie) = cookie {
        response.headers_mut().append(header::SET_COOKIE, cookie);
    }
    response
}

#[cfg(test)]
mod tests {
    use super::{
        RATE_LIMIT_PER_IP, RATE_LIMIT_WINDOW, RateLimitEndpoint, authorizable_target_branches,
        build_enroll_url, client_ip, has_group_admin_role_hint, load_group_admin_groups,
        rate_limit, resolve_group_admin_target_org,
    };
    use axum::http::HeaderMap;
    use axum::http::StatusCode;
    use mnt_kernel_core::{BranchId, BranchScope, OrgId, UserId};
    use sqlx::PgPool;
    use sqlx::postgres::PgPoolOptions;
    use std::collections::BTreeSet;
    use time::OffsetDateTime;
    use url::{Url, form_urlencoded};
    use uuid::Uuid;

    #[test]
    fn build_enroll_url_keeps_otp_out_of_query_string() -> Result<(), url::ParseError> {
        let origin = Url::parse("https://console.knllogistic.com/app?ignored=1")?;
        let otp = "A&c#%_!9";

        let enroll_url = build_enroll_url(&origin, otp, None);
        let parsed = Url::parse(&enroll_url)?;
        let decoded = parsed.fragment().and_then(|fragment| {
            form_urlencoded::parse(fragment.as_bytes())
                .find(|(key, _)| key == "otp")
                .map(|(_, value)| value.into_owned())
        });

        assert_eq!(parsed.path(), "/login");
        assert!(parsed.query().is_none());
        assert_eq!(decoded.as_deref(), Some(otp));
        assert!(!enroll_url.contains("?otp="));
        Ok(())
    }

    #[test]
    fn authorizable_branches_all_scope_issuable_only_by_super_admin() {
        // The issue-#18 fix: an org-wide (SUPER_ADMIN / EXECUTIVE) target resolves
        // to `All`. A SUPER_ADMIN caller may issue/reset for it with no per-branch
        // basis (`None`); a non-SUPER_ADMIN caller can never reach a valid action
        // (the privileged-target guard already blocks them earlier, and this is the
        // defense-in-depth re-assertion).
        assert!(matches!(
            authorizable_target_branches(BranchScope::All, true),
            Ok(None)
        ));
        assert!(authorizable_target_branches(BranchScope::All, false).is_err());
    }

    #[test]
    fn authorizable_branches_branch_scoped_target() {
        // A branch-scoped target returns its concrete branches for the per-branch
        // authz loop (regardless of caller role — the loop enforces caller scope).
        let branch = BranchId::from_uuid(Uuid::nil());
        assert!(matches!(
            authorizable_target_branches(BranchScope::single(branch), false),
            Ok(Some(branches)) if branches == BTreeSet::from([branch])
        ));
        // An empty branch set is not issuable (matches the pre-fix behaviour for a
        // genuinely unscoped target).
        assert!(
            authorizable_target_branches(BranchScope::Branches(BTreeSet::new()), true).is_err()
        );
    }

    #[test]
    fn group_admin_control_endpoints_require_signed_group_admin_hint() {
        assert!(has_group_admin_role_hint(&["GROUP_ADMIN".to_owned()]));
        assert!(!has_group_admin_role_hint(&[]));
        assert!(!has_group_admin_role_hint(&["GROUP_VIEWER".to_owned()]));
    }

    fn headers_with_xff(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", value.parse().unwrap());
        headers
    }

    #[test]
    fn client_ip_uses_nth_from_right_with_one_trusted_proxy() {
        // With one trusted proxy, the rightmost entry is the proxy's view of the
        // client, and any prepended (spoofed) entries to the left are ignored.
        let headers = headers_with_xff("9.9.9.9, 8.8.8.8, 203.0.113.7");
        assert_eq!(client_ip(&headers, 1).as_deref(), Some("203.0.113.7"));
    }

    #[test]
    fn client_ip_honors_higher_trusted_proxy_count() {
        // Spec: the client IP is the Nth-from-the-right entry (rightmost is the
        // closest proxy). Chain [client, edge-proxy, app-proxy]: with 2 trusted
        // proxies the 2nd-from-right (the edge proxy's observed source) is taken,
        // and the spoofable left-most entry is ignored.
        let headers = headers_with_xff("1.2.3.4, 203.0.113.7, 10.0.0.2");
        assert_eq!(client_ip(&headers, 2).as_deref(), Some("203.0.113.7"));
        assert_ne!(client_ip(&headers, 2).as_deref(), Some("1.2.3.4"));
    }

    #[test]
    fn client_ip_ignores_left_most_spoofed_entry() {
        // A single-hop deployment must NOT trust the attacker-controlled left-most
        // entry; it takes the rightmost real entry instead.
        let headers = headers_with_xff("1.2.3.4, 203.0.113.7");
        assert_ne!(client_ip(&headers, 1).as_deref(), Some("1.2.3.4"));
        assert_eq!(client_ip(&headers, 1).as_deref(), Some("203.0.113.7"));
    }

    #[test]
    fn client_ip_clamps_when_chain_shorter_than_expected() {
        // A misconfigured/short chain yields the left-most available entry rather
        // than underflowing or panicking.
        let headers = headers_with_xff("203.0.113.7");
        assert_eq!(client_ip(&headers, 3).as_deref(), Some("203.0.113.7"));
    }

    #[test]
    fn client_ip_none_without_header() {
        assert_eq!(client_ip(&HeaderMap::new(), 1), None);
        assert_eq!(client_ip(&headers_with_xff("  ,  "), 1), None);
    }

    /// `rate_limit` takes `now` as an explicit parameter (matching the
    /// audit-chain `seal_org_once` precedent), so its window/cap/reset
    /// behavior can be driven with a synthetic clock instead of racing real
    /// wall-clock minute boundaries across a burst of DB round-trips — the
    /// root cause of the flaky HTTP-level `otp_redeem_rate_limit_*` test.
    #[sqlx::test(migrations = "../db/migrations")]
    async fn rate_limit_trips_at_cap_and_resets_after_window(pool: PgPool) {
        let headers = headers_with_xff("203.0.113.50");
        let window1 = OffsetDateTime::from_unix_timestamp(1_700_000_000).unwrap();

        for attempt in 0..RATE_LIMIT_PER_IP {
            rate_limit(&pool, &headers, 1, RateLimitEndpoint::OtpRedeem, window1)
                .await
                .unwrap_or_else(|_| panic!("attempt {attempt} within the cap must not trip 429"));
        }

        let tripped = rate_limit(&pool, &headers, 1, RateLimitEndpoint::OtpRedeem, window1)
            .await
            .expect_err("the request past the cap in the same window must trip 429");
        assert_eq!(tripped.status, StatusCode::TOO_MANY_REQUESTS);

        // Advancing past the fixed window resets the bucket.
        let window2 = window1 + RATE_LIMIT_WINDOW;
        rate_limit(&pool, &headers, 1, RateLimitEndpoint::OtpRedeem, window2)
            .await
            .expect("a new window must reset the per-IP bucket");
    }

    const ORG_A: Uuid = Uuid::from_u128(0xA013_A013_A013_A013_A013_A013_A013_A013);
    const ORG_B: Uuid = Uuid::from_u128(0xB013_B013_B013_B013_B013_B013_B013_B013);
    const GROUP: Uuid = Uuid::from_u128(0x9013_9013_9013_9013_9013_9013_9013_9013);
    const GROUP_ADMIN: Uuid = Uuid::from_u128(0x1013_1013_1013_1013_1013_1013_1013_1013);
    const GROUP_VIEWER: Uuid = Uuid::from_u128(0x2013_2013_2013_2013_2013_2013_2013_2013);

    async fn runtime_role_pool(owner_pool: &PgPool) -> PgPool {
        let options = owner_pool.connect_options().as_ref().clone();
        PgPoolOptions::new()
            .max_connections(2)
            .after_connect(|conn, _meta| {
                Box::pin(async move {
                    sqlx::query("SET ROLE mnt_rt").execute(conn).await?;
                    Ok(())
                })
            })
            .connect_with(options)
            .await
            .unwrap()
    }

    async fn seed_group_admin_fixture(pool: &PgPool) {
        let mut tx = pool.begin().await.unwrap();
        sqlx::query("SET LOCAL row_security = off")
            .execute(&mut *tx)
            .await
            .unwrap();

        sqlx::query(
            "INSERT INTO organizations (id, slug, name) VALUES \
                ($1, 'g013-a', 'G013 A'), ($2, 'g013-b', 'G013 B')",
        )
        .bind(ORG_A)
        .bind(ORG_B)
        .execute(&mut *tx)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO users (id, display_name, roles, org_id) VALUES \
                ($1, 'Group Admin', ARRAY['MEMBER'], $3), \
                ($2, 'Group Viewer', ARRAY['MEMBER'], $4)",
        )
        .bind(GROUP_ADMIN)
        .bind(GROUP_VIEWER)
        .bind(ORG_A)
        .bind(ORG_B)
        .execute(&mut *tx)
        .await
        .unwrap();

        sqlx::query("INSERT INTO groups (id, slug, name) VALUES ($1, 'g013', 'G013')")
            .bind(GROUP)
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("INSERT INTO group_memberships (group_id, org_id) VALUES ($1, $2), ($1, $3)")
            .bind(GROUP)
            .bind(ORG_A)
            .bind(ORG_B)
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO group_role_grants (group_id, user_id, group_role, granted_by) VALUES \
                ($1, $2, 'GROUP_ADMIN', NULL), \
                ($1, $3, 'GROUP_VIEWER', NULL)",
        )
        .bind(GROUP)
        .bind(GROUP_ADMIN)
        .bind(GROUP_VIEWER)
        .execute(&mut *tx)
        .await
        .unwrap();

        tx.commit().await.unwrap();
    }

    #[sqlx::test(migrations = "../db/migrations")]
    async fn group_admin_helpers_allow_cross_tenant_subsidiary_but_filter_viewer(
        owner_pool: PgPool,
    ) {
        seed_group_admin_fixture(&owner_pool).await;
        let rt_pool = runtime_role_pool(&owner_pool).await;

        let groups = load_group_admin_groups(&rt_pool, UserId::from_uuid(GROUP_ADMIN))
            .await
            .unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].id, GROUP);
        let member_ids = groups[0]
            .members
            .iter()
            .map(|member| member.id)
            .collect::<Vec<_>>();
        assert_eq!(member_ids, vec![ORG_A, ORG_B]);

        let (_group_id, target) = resolve_group_admin_target_org(
            &rt_pool,
            UserId::from_uuid(GROUP_ADMIN),
            OrgId::from_uuid(ORG_B),
        )
        .await
        .unwrap();
        assert_eq!(
            target.org_id,
            OrgId::from_uuid(ORG_B),
            "a group admin homed in org A can manage subsidiary org B",
        );

        let viewer_error = resolve_group_admin_target_org(
            &rt_pool,
            UserId::from_uuid(GROUP_VIEWER),
            OrgId::from_uuid(ORG_A),
        )
        .await
        .expect_err("GROUP_VIEWER must not manage subsidiaries");
        assert_eq!(viewer_error.status, StatusCode::FORBIDDEN);
    }
}
