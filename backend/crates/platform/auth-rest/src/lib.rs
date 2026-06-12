//! Auth REST API.
//!
//! This layer exposes the passkey ceremony and token-family primitives from
//! `mnt-platform-auth` over HTTP. It does not own ceremony or refresh storage;
//! those remain in the platform auth/provisioning crates.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::str::FromStr;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use mnt_kernel_core::{AuditAction, AuditEvent, BranchId, TraceContext, UserId};
use mnt_platform_auth::{
    AccessClaims, AccessTokenInput, AuthenticationStart, JwtIssuer, JwtSettings, JwtVerifier,
    PasskeyAuthenticationCredential, PasskeyRegistrationCredential, PasskeyRegistrationStart,
    PasskeyService, RefreshTokenIssue, RefreshTokenStore, RefreshTokenUseError, WebauthnSettings,
};
use mnt_platform_db::{DbError, with_audit};
use mnt_platform_provisioning::{BootstrapCredentialStore, ProvisioningError};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use time::{Duration, OffsetDateTime};
use url::Url;
use uuid::Uuid;

const DEFAULT_ACCESS_TOKEN_TTL: Duration = Duration::minutes(15);
pub const PASSKEY_REGISTER_START_PATH: &str = "/api/v1/auth/passkey/register/start";
pub const PASSKEY_REGISTER_FINISH_PATH: &str = "/api/v1/auth/passkey/register/finish";
pub const PASSKEY_LOGIN_START_PATH: &str = "/api/v1/auth/passkey/login/start";
pub const PASSKEY_LOGIN_FINISH_PATH: &str = "/api/v1/auth/passkey/login/finish";
pub const TOKEN_REFRESH_PATH: &str = "/api/v1/auth/token/refresh";
pub const LOGOUT_PATH: &str = "/api/v1/auth/logout";
pub const AUTH_ROUTE_PATHS: &[&str] = &[
    PASSKEY_REGISTER_START_PATH,
    PASSKEY_REGISTER_FINISH_PATH,
    PASSKEY_LOGIN_START_PATH,
    PASSKEY_LOGIN_FINISH_PATH,
    TOKEN_REFRESH_PATH,
    LOGOUT_PATH,
];

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
}

#[derive(Clone)]
pub struct AuthRestState {
    pool: PgPool,
    services: Option<AuthServices>,
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
}

impl AuthRestState {
    #[must_use]
    pub fn disabled(pool: PgPool) -> Self {
        Self {
            pool,
            services: None,
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
            }),
        })
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
        .route(PASSKEY_REGISTER_START_PATH, post(start_registration))
        .route(PASSKEY_REGISTER_FINISH_PATH, post(finish_registration))
        .route(PASSKEY_LOGIN_START_PATH, post(start_login))
        .route(PASSKEY_LOGIN_FINISH_PATH, post(finish_login))
        .route(TOKEN_REFRESH_PATH, post(refresh_token))
        .route(LOGOUT_PATH, post(logout))
        .with_state(state)
}

#[derive(Debug, Deserialize)]
struct RegisterStartRequest {
    bootstrap_token: Option<String>,
    username: Option<String>,
    display_name: Option<String>,
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

#[derive(Debug, Deserialize)]
struct LoginStartRequest {
    user_id: Uuid,
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

#[derive(Debug, Serialize)]
struct TokenPairResponse {
    access_token: String,
    refresh_token: String,
    token_type: &'static str,
    refresh_expires_at: OffsetDateTime,
}

#[derive(Debug, Deserialize)]
struct RefreshTokenRequest {
    refresh_token: String,
}

#[derive(Debug, Deserialize)]
struct LogoutRequest {
    refresh_token: String,
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
            ProvisioningError::InvalidBootstrapCredential
            | ProvisioningError::BootstrapCredentialExpired
            | ProvisioningError::BootstrapCredentialUsed
            | ProvisioningError::BootstrapCredentialRevoked => {
                Self::unauthorized(error.to_string())
            }
            ProvisioningError::BootstrapRegistrationAlreadyStarted
            | ProvisioningError::UserAlreadyHasPasskey
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

async fn start_registration(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    Json(body): Json<RegisterStartRequest>,
) -> Result<Json<RegisterStartResponse>, RestError> {
    let services = state.services()?;
    let ceremony = if let Some(token) = body.bootstrap_token {
        let username = required_field(body.username, "username")?;
        let display_name = required_field(body.display_name, "display_name")?;
        services
            .bootstrap_credentials
            .start_passkey_registration(
                &state.pool,
                &services.passkeys,
                &token,
                username,
                display_name,
            )
            .await
            .map_err(RestError::from_provisioning)?
    } else {
        let user_id = authenticated_user_id(services, &headers)?;
        let user = load_user_auth_context(&state.pool, user_id).await?;
        services
            .passkeys
            .start_registration(
                &state.pool,
                PasskeyRegistrationStart {
                    user_id,
                    username: body.username.unwrap_or(user.username),
                    display_name: body.display_name.unwrap_or(user.display_name),
                },
            )
            .await
            .map_err(|err| RestError::internal(err.to_string()))?
    };

    Ok(Json(RegisterStartResponse {
        ceremony_id: ceremony.ceremony_id,
        challenge: serde_json::to_value(ceremony.challenge)
            .map_err(|err| RestError::internal(err.to_string()))?,
        expires_at: ceremony.expires_at,
    }))
}

async fn finish_registration(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    Json(body): Json<RegisterFinishRequest>,
) -> Result<(StatusCode, Json<RegisterFinishResponse>), RestError> {
    let services = state.services()?;
    let passkey = if bootstrap_ceremony_exists(&state.pool, body.ceremony_id).await? {
        services
            .bootstrap_credentials
            .finish_passkey_registration(
                &state.pool,
                &services.passkeys,
                body.ceremony_id,
                body.credential,
            )
            .await
            .map_err(RestError::from_provisioning)?
    } else {
        let user_id = authenticated_user_id(services, &headers)?;
        ensure_registration_ceremony_owner(&state.pool, body.ceremony_id, user_id).await?;
        services
            .passkeys
            .finish_registration(&state.pool, body.ceremony_id, body.credential)
            .await
            .map_err(|err| RestError::internal(err.to_string()))?
    };

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
    Json(body): Json<LoginStartRequest>,
) -> Result<Json<LoginStartResponse>, RestError> {
    let services = state.services()?;
    let ceremony = services
        .passkeys
        .start_authentication(
            &state.pool,
            AuthenticationStart {
                user_id: body.user_id,
            },
        )
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
    Json(body): Json<LoginFinishRequest>,
) -> Result<Json<TokenPairResponse>, RestError> {
    let services = state.services()?;
    let outcome = services
        .passkeys
        .finish_authentication(&state.pool, body.ceremony_id, body.credential)
        .await
        .map_err(|err| RestError::unauthorized(err.to_string()))?;
    let user = load_user_auth_context(&state.pool, outcome.user_id).await?;
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
    Ok(Json(tokens.into_response()))
}

async fn refresh_token(
    State(state): State<AuthRestState>,
    Json(body): Json<RefreshTokenRequest>,
) -> Result<Json<TokenPairResponse>, RestError> {
    let services = state.services()?;
    let now = OffsetDateTime::now_utc();
    let issue = services
        .refresh_tokens
        .rotate(
            &state.pool,
            &body.refresh_token,
            now,
            services.refresh_token_ttl,
        )
        .await
        .map_err(RestError::from_refresh)?;
    let user = load_user_auth_context(&state.pool, issue.user_id).await?;
    Ok(Json(access_response_for_issue(services, &user, issue)?))
}

async fn logout(
    State(state): State<AuthRestState>,
    Json(body): Json<LogoutRequest>,
) -> Result<StatusCode, RestError> {
    let services = state.services()?;
    services
        .refresh_tokens
        .revoke_family_for_logout(&state.pool, &body.refresh_token, OffsetDateTime::now_utc())
        .await
        .map_err(RestError::from_refresh)?;
    Ok(StatusCode::NO_CONTENT)
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
    fn into_response(self) -> TokenPairResponse {
        TokenPairResponse {
            access_token: self.access_token,
            refresh_token: self.refresh_token,
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
            roles: user.roles.clone(),
            branches: user.branches.clone(),
            issued_at: now,
        })
        .map_err(|err| RestError::internal(err.to_string()))?;
    let refresh = services
        .refresh_tokens
        .issue_family(
            pool,
            *user.user_id.as_uuid(),
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

fn access_response_for_issue(
    services: &AuthServices,
    user: &UserAuthContext,
    issue: RefreshTokenIssue,
) -> Result<TokenPairResponse, RestError> {
    let access_token = services
        .jwt_issuer
        .issue_access_token(AccessTokenInput {
            subject: user.user_id,
            roles: user.roles.clone(),
            branches: user.branches.clone(),
            issued_at: OffsetDateTime::now_utc(),
        })
        .map_err(|err| RestError::internal(err.to_string()))?;

    Ok(TokenPairResponse {
        access_token,
        refresh_token: issue.token.as_str().to_owned(),
        token_type: "Bearer",
        refresh_expires_at: issue.expires_at,
    })
}

async fn load_user_auth_context(
    pool: &PgPool,
    user_id: Uuid,
) -> Result<UserAuthContext, RestError> {
    let row = sqlx::query(
        r#"
        SELECT display_name, phone, roles, is_active
        FROM users
        WHERE id = $1
        "#,
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(|err| RestError::internal(err.to_string()))?
    .ok_or_else(|| RestError::unauthorized("user not found"))?;

    let display_name: String = row
        .try_get("display_name")
        .map_err(|err| RestError::internal(err.to_string()))?;
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
    .fetch_all(pool)
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
        display_name,
        username: phone.unwrap_or_else(|| user_id.to_string()),
        roles,
        branches,
    })
}

async fn bootstrap_ceremony_exists(pool: &PgPool, ceremony_id: Uuid) -> Result<bool, RestError> {
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM auth_bootstrap_credentials WHERE registration_ceremony_id = $1",
    )
    .bind(ceremony_id)
    .fetch_one(pool)
    .await
    .map_err(|err| RestError::internal(err.to_string()))?;
    Ok(count > 0)
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

fn authenticated_user_id(services: &AuthServices, headers: &HeaderMap) -> Result<Uuid, RestError> {
    let token = bearer_token(headers)?;
    let claims = services
        .jwt_verifier
        .verify_access_token(token)
        .map_err(|_| RestError::unauthorized("invalid bearer token"))?;
    user_id_from_claims(claims)
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

fn required_field(value: Option<String>, field: &'static str) -> Result<String, RestError> {
    value
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| RestError::bad_request(format!("{field} is required")))
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
