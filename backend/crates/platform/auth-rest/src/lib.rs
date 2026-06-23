//! Auth REST API.
//!
//! This layer exposes the passkey ceremony and token-family primitives from
//! `mnt-platform-auth` over HTTP. It does not own ceremony or refresh storage;
//! those remain in the platform auth/provisioning crates.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::collections::BTreeSet;
use std::str::FromStr;
use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use mnt_kernel_core::{
    AuditAction, AuditEvent, BranchId, BranchScope, OrgId, TraceContext, UserId,
};
use mnt_platform_auth::{
    AccessClaims, AccessTokenInput, JwtIssuer, JwtSettings, JwtVerifier,
    PasskeyAuthenticationCredential, PasskeyRegistrationCredential, PasskeyRegistrationStart,
    PasskeyService, RefreshTokenStore, RefreshTokenUseError, WebauthnSettings,
};
use mnt_platform_authz::{
    Action, Feature, Principal, Role, authorize, resolve_branch_scope_in_org,
};
use mnt_platform_db::{DbError, with_audit, with_org_conn};
use mnt_platform_email::{EmailSender, StubEmailSender};
use mnt_platform_provisioning::{BootstrapCredentialStore, ProvisioningError};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use time::{Duration, OffsetDateTime};
use url::Url;
use uuid::Uuid;

const DEFAULT_ACCESS_TOKEN_TTL: Duration = Duration::minutes(15);

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
pub const TOKEN_REFRESH_PATH: &str = "/api/v1/auth/token/refresh";
pub const LOGOUT_PATH: &str = "/api/v1/auth/logout";
pub const AUTH_ROUTE_PATHS: &[&str] = &[
    SIGNUP_PATH,
    PASSKEY_REGISTER_START_PATH,
    PASSKEY_REGISTER_FINISH_PATH,
    PASSKEY_LOGIN_START_PATH,
    PASSKEY_LOGIN_FINISH_PATH,
    OTP_REDEEM_PATH,
    ADMIN_OTP_ISSUE_PATH,
    ADMIN_CREDENTIAL_RESET_PATH,
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
    Router::new()
        .route(SIGNUP_PATH, post(signup))
        .route(PASSKEY_REGISTER_START_PATH, post(start_registration))
        .route(PASSKEY_REGISTER_FINISH_PATH, post(finish_registration))
        .route(PASSKEY_LOGIN_START_PATH, post(start_login))
        .route(PASSKEY_LOGIN_FINISH_PATH, post(finish_login))
        .route(OTP_REDEEM_PATH, post(redeem_otp))
        .route(ADMIN_OTP_ISSUE_PATH, post(issue_admin_otp))
        .route(ADMIN_CREDENTIAL_RESET_PATH, post(admin_credential_reset))
        .route(TOKEN_REFRESH_PATH, post(refresh_token))
        .route(LOGOUT_PATH, post(logout))
        .with_state(state)
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
    expires_at: OffsetDateTime,
}

/// A minted access/refresh pair. `refresh_token` is `null` in the cookie
/// transport (web) — the refresh token rides in the HttpOnly `mnt_refresh`
/// cookie instead — and `Some` in the body transport (mobile). The access token
/// is ALWAYS in the body: it stays a short-lived in-memory bearer token, never a
/// cookie.
#[derive(Debug, Serialize)]
struct TokenPairResponse {
    access_token: String,
    refresh_token: Option<String>,
    token_type: &'static str,
    refresh_expires_at: OffsetDateTime,
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
    if existing_passkeys > 0 {
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
        .consume_open_credentials_tx(&mut tx, user_id, now)
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
    let access_token = issue_access_token(services, &user)?;
    if cookie_mode {
        let max_age = (issue.expires_at - now).whole_seconds();
        let cookie = refresh_set_cookie(issue.token.as_str(), max_age, services.cookie_secure);
        let response = Json(TokenPairResponse {
            access_token,
            refresh_token: None,
            token_type: "Bearer",
            refresh_expires_at: issue.expires_at,
        })
        .into_response();
        Ok(with_refresh_cookie(response, cookie))
    } else {
        Ok(Json(TokenPairResponse {
            access_token,
            refresh_token: Some(issue.token.as_str().to_owned()),
            token_type: "Bearer",
            refresh_expires_at: issue.expires_at,
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
        }
    }
}

async fn issue_token_pair(
    pool: &PgPool,
    services: &AuthServices,
    user: &UserAuthContext,
) -> Result<IssuedTokenPair, RestError> {
    let now = OffsetDateTime::now_utc();
    let access_token = services
        .jwt_issuer
        .issue_access_token(AccessTokenInput {
            subject: user.user_id,
            org_id: user.org_id,
            roles: user.roles.clone(),
            branches: user.branches.clone(),
            platform: user.org_id == OrgId::platform(),
            issued_at: now,
        })
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
    services
        .jwt_issuer
        .issue_access_token(AccessTokenInput {
            subject: user.user_id,
            org_id: user.org_id,
            roles: user.roles.clone(),
            branches: user.branches.clone(),
            // A user homed in the platform sentinel org is the PLATFORM admin:
            // mint a platform token so it can reach `/platform/*` (and is rejected
            // on tenant `/api/*`). Every real tenant user gets `false`.
            platform: user.org_id == OrgId::platform(),
            issued_at: OffsetDateTime::now_utc(),
        })
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
    with_org_conn::<_, UserAuthContext, RestError>(pool, org, move |tx| {
        Box::pin(async move { load_user_auth_context_tx(tx, user_id).await })
    })
    .await
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

    Ok(UserAuthContext {
        user_id: UserId::from_uuid(user_id),
        org_id,
        display_name,
        username: phone.unwrap_or_else(|| user_id.to_string()),
        roles,
        branches,
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
    let token = bearer_token(headers)?;
    let claims = services
        .jwt_verifier
        .verify_access_token(token)
        .map_err(|_| RestError::unauthorized("invalid bearer token"))?;
    let user_id = UserId::from_str(&claims.sub)
        .map_err(|_| RestError::unauthorized("token subject is invalid"))?;
    let roles = claims
        .roles
        .iter()
        .map(|role| {
            Role::from_str(role).map_err(|_| RestError::unauthorized("token contains unknown role"))
        })
        .collect::<Result<std::collections::BTreeSet<_>, _>>()?;
    let role_vec = roles.iter().copied().collect::<Vec<_>>();
    let org_id = OrgId::from_str(&claims.org)
        .map_err(|_| RestError::unauthorized("token org claim is not a valid uuid"))?;
    // Resolve the live branch scope from the database rather than trusting the
    // token's branch claim, matching the authz model's branch-membership gate.
    // This auth-rest route runs BEFORE the tenant middleware, so arm the GUC with
    // the verified-token org: `user_branches` is FORCE RLS and would otherwise
    // return zero branches for a non-super admin under `mnt_rt`.
    let branch_scope = resolve_branch_scope_in_org(pool, org_id, user_id, &role_vec)
        .await
        .map_err(|err| RestError::internal(err.to_string()))?;
    Ok(Principal::new(user_id, org_id, roles, branch_scope))
}

// ---------------------------------------------------------------------------
// DB-backed cross-instance rate limiter.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
enum RateLimitEndpoint {
    Signup,
    OtpRedeem,
    LoginStart,
    Refresh,
}

impl RateLimitEndpoint {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Signup => "signup",
            Self::OtpRedeem => "otp_redeem",
            Self::LoginStart => "login_start",
            Self::Refresh => "refresh",
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
    if let Some(ip) = client_ip(headers, trusted_proxy_count) {
        buckets.push((format!("ip:{ip}"), RATE_LIMIT_PER_IP));
    }
    if let Some(device) = client_device_id(headers) {
        buckets.push((format!("dev:{device}"), RATE_LIMIT_PER_DEVICE));
    }
    buckets.push(("global".to_owned(), RATE_LIMIT_GLOBAL));

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
        };
        with_refresh_cookie(
            Json(body).into_response(),
            refresh_set_cookie(&tokens.refresh_token, max_age, cookie_secure),
        )
    } else {
        Json(tokens.into_response()).into_response()
    }
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
    use super::{authorizable_target_branches, client_ip};
    use axum::http::HeaderMap;
    use mnt_kernel_core::{BranchId, BranchScope};
    use std::collections::BTreeSet;
    use uuid::Uuid;

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
}
