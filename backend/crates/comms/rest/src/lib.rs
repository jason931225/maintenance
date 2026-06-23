//! Webmail REST API.
//!
//! Endpoints (all under `/api/v1/mail`, tenant-scoped, audited):
//!   * `GET  /mail/account`        — the configured mailbox (write-only password)
//!   * `PUT  /mail/account`        — configure/replace the mailbox
//!   * `POST /mail/account/test`   — SMTP test-connection (structured result)
//!   * `POST /mail/send`           — compose & send a new message
//!   * `POST /mail/reply`          — reply (sets In-Reply-To/References)
//!   * `POST /mail/forward`        — forward (sets In-Reply-To/References)
//!
//! AuthZ: `MailAccountManage` gates account config + test; `MailUse` gates send/
//! reply/forward. Every config change and every send is audited in the store.
//!
//! # Graceful missing key
//!
//! The master KEK ([`mnt_comms_credential_cipher`]) is OPTIONAL at boot. When it
//! is absent the router still mounts (so the paths exist for the OpenAPI gate),
//! but every endpoint returns `503 email_not_configured` — the app boots and the
//! rest of the platform is unaffected.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

use std::str::FromStr;
use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use mnt_comms_adapter_postgres::PgMailStore;
use mnt_comms_adapter_smtp::LettreMailSender;
use mnt_comms_application::{
    AccountService, AccountView, ConfigureAccountCommand, MailServiceError, SendKind,
    SendMessageCommand, SendResult, SendService, TestConnectionResult,
};
use mnt_comms_credential_cipher::EnvelopeCredentialCipher;
use mnt_comms_domain::{MailSecurity, MessageAddress};
use mnt_kernel_core::{BranchId, BranchScope, ErrorKind, KernelError, TraceContext, UserId};
use mnt_platform_auth::{AccessClaims, JwtVerifier};
use mnt_platform_authz::{Action, Feature, Principal, Role, authorize};
use secrecy::SecretString;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use time::OffsetDateTime;

pub const MAIL_ACCOUNT_PATH: &str = "/api/v1/mail/account";
pub const MAIL_ACCOUNT_TEST_PATH: &str = "/api/v1/mail/account/test";
pub const MAIL_SEND_PATH: &str = "/api/v1/mail/send";
pub const MAIL_REPLY_PATH: &str = "/api/v1/mail/reply";
pub const MAIL_FORWARD_PATH: &str = "/api/v1/mail/forward";

/// A no-op realtime notifier: outbound persistence never depends on it, and the
/// realtime channel for inbound mail lands in B-mail-5.
#[derive(Debug, Default, Clone)]
struct NoopMailNotifier;

impl mnt_comms_application::MailNotifier for NoopMailNotifier {
    fn notify_posted(
        &self,
        _account_id: mnt_comms_application::EmailAccountId,
    ) -> mnt_comms_application::MailFuture<'_, ()> {
        Box::pin(async {})
    }
}

#[derive(Clone)]
pub struct CommsRestState {
    store: PgMailStore,
    sender: LettreMailSender,
    /// The master-key cipher. `None` when `MNT_MAIL_MASTER_KEY` is absent — the
    /// feature is then unavailable (503) but the app still boots.
    cipher: Option<Arc<EnvelopeCredentialCipher>>,
    jwt_verifier: Option<JwtVerifier>,
}

impl CommsRestState {
    #[must_use]
    pub fn new(
        store: PgMailStore,
        cipher: Option<Arc<EnvelopeCredentialCipher>>,
        jwt_verifier: Option<JwtVerifier>,
    ) -> Self {
        Self {
            store,
            sender: LettreMailSender::new(),
            cipher,
            jwt_verifier,
        }
    }

    fn pool(&self) -> &sqlx::PgPool {
        self.store.pool()
    }
}

pub fn router(state: CommsRestState) -> Router {
    let verifier = state.jwt_verifier.clone();
    let pool = state.pool().clone();
    let router = Router::new()
        .route(MAIL_ACCOUNT_PATH, get(get_account).put(put_account))
        .route(MAIL_ACCOUNT_TEST_PATH, post(test_account))
        .route(MAIL_SEND_PATH, post(send_new))
        .route(MAIL_REPLY_PATH, post(send_reply))
        .route(MAIL_FORWARD_PATH, post(send_forward))
        .with_state(state);
    mnt_platform_request_context::with_request_context(router, verifier, pool)
}

// ---------------------------------------------------------------------------
// Wire DTOs
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct ConfigureAccountRequest {
    display_name: String,
    email_address: String,
    #[serde(default)]
    from_name: Option<String>,
    imap_host: String,
    imap_port: u16,
    imap_security: MailSecurity,
    imap_username: String,
    /// Write-only: present = (re)seal; absent/null = keep the stored secret.
    #[serde(default)]
    imap_password: Option<String>,
    smtp_host: String,
    smtp_port: u16,
    smtp_security: MailSecurity,
    smtp_username: String,
    #[serde(default)]
    smtp_password: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AddressDto {
    address: String,
    #[serde(default)]
    name: Option<String>,
}

impl AddressDto {
    fn into_domain(self) -> Result<MessageAddress, RestError> {
        MessageAddress::new(self.address)
            .map(|a| a.with_name(self.name))
            .map_err(RestError::from_kernel)
    }
}

#[derive(Debug, Deserialize)]
struct SendRequest {
    to: Vec<AddressDto>,
    #[serde(default)]
    cc: Vec<AddressDto>,
    #[serde(default)]
    bcc: Vec<AddressDto>,
    subject: String,
    body_text: String,
    #[serde(default)]
    attachments: Vec<AttachmentDto>,
    /// Required for reply/forward: the Message-ID being responded to.
    #[serde(default)]
    in_reply_to: Option<String>,
    #[serde(default)]
    references: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct AttachmentDto {
    filename: String,
    content_type: String,
    /// Standard-base64 content.
    content_base64: String,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async fn get_account(
    State(state): State<CommsRestState>,
    headers: HeaderMap,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    authorize_feature(&principal, Feature::MailAccountManage)?;
    let cipher = state.cipher_ref()?;
    let service = AccountService::new(state.store.clone(), state.sender.clone(), cipher);
    let view: Option<AccountView> = service
        .get_account()
        .await
        .map_err(RestError::from_service)?;
    match view {
        Some(view) => Ok(Json(view).into_response()),
        None => Ok(StatusCode::NO_CONTENT.into_response()),
    }
}

async fn put_account(
    State(state): State<CommsRestState>,
    headers: HeaderMap,
    Json(body): Json<ConfigureAccountRequest>,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    authorize_feature(&principal, Feature::MailAccountManage)?;
    let cipher = state.cipher_ref()?;
    let service = AccountService::new(state.store.clone(), state.sender.clone(), cipher);

    let command = ConfigureAccountCommand {
        actor: principal.user_id,
        org_id: principal.org_id,
        display_name: body.display_name,
        email_address: body.email_address,
        from_name: body.from_name,
        imap_host: body.imap_host,
        imap_port: body.imap_port,
        imap_security: body.imap_security,
        imap_username: body.imap_username,
        // A present-but-empty/whitespace password means "keep the existing
        // secret", NOT "seal an empty password": `{"smtp_password":""}` must not
        // re-seal a blank credential. Only an explicit non-empty value re-seals.
        imap_password: keep_existing_if_blank(body.imap_password),
        smtp_host: body.smtp_host,
        smtp_port: body.smtp_port,
        smtp_security: body.smtp_security,
        smtp_username: body.smtp_username,
        smtp_password: keep_existing_if_blank(body.smtp_password),
        trace: TraceContext::generate(),
        occurred_at: OffsetDateTime::now_utc(),
    };
    let view = service
        .configure(command)
        .await
        .map_err(RestError::from_service)?;
    Ok(Json(view).into_response())
}

async fn test_account(
    State(state): State<CommsRestState>,
    headers: HeaderMap,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    authorize_feature(&principal, Feature::MailAccountManage)?;
    let cipher = state.cipher_ref()?;
    let service = AccountService::new(state.store.clone(), state.sender.clone(), cipher);
    let result: TestConnectionResult = service
        .test_connection(principal.user_id, OffsetDateTime::now_utc())
        .await
        .map_err(RestError::from_service)?;
    Ok(Json(result).into_response())
}

async fn send_new(
    State(state): State<CommsRestState>,
    headers: HeaderMap,
    Json(body): Json<SendRequest>,
) -> Result<Response, RestError> {
    send_impl(state, headers, body, SendKind::New).await
}

async fn send_reply(
    State(state): State<CommsRestState>,
    headers: HeaderMap,
    Json(body): Json<SendRequest>,
) -> Result<Response, RestError> {
    send_impl(state, headers, body, SendKind::Reply).await
}

async fn send_forward(
    State(state): State<CommsRestState>,
    headers: HeaderMap,
    Json(body): Json<SendRequest>,
) -> Result<Response, RestError> {
    send_impl(state, headers, body, SendKind::Forward).await
}

async fn send_impl(
    state: CommsRestState,
    headers: HeaderMap,
    body: SendRequest,
    kind: SendKind,
) -> Result<Response, RestError> {
    let principal = principal_from_headers(&state, &headers)?;
    authorize_feature(&principal, Feature::MailUse)?;
    let cipher = state.cipher_ref()?;
    let service = SendService::new(
        state.store.clone(),
        state.sender.clone(),
        cipher,
        NoopMailNotifier,
    );

    let to = body
        .to
        .into_iter()
        .map(AddressDto::into_domain)
        .collect::<Result<Vec<_>, _>>()?;
    let cc = body
        .cc
        .into_iter()
        .map(AddressDto::into_domain)
        .collect::<Result<Vec<_>, _>>()?;
    let bcc = body
        .bcc
        .into_iter()
        .map(AddressDto::into_domain)
        .collect::<Result<Vec<_>, _>>()?;

    let attachments = body
        .attachments
        .into_iter()
        .map(decode_attachment)
        .collect::<Result<Vec<_>, _>>()?;

    let command = SendMessageCommand {
        actor: principal.user_id,
        kind,
        to,
        cc,
        bcc,
        subject: body.subject,
        body_text: body.body_text,
        attachments,
        in_reply_to: body.in_reply_to,
        references: body.references,
        trace: TraceContext::generate(),
        occurred_at: OffsetDateTime::now_utc(),
    };
    let result: SendResult = service
        .send(command)
        .await
        .map_err(RestError::from_service)?;
    Ok((StatusCode::CREATED, Json(result)).into_response())
}

/// Collapse a present-but-blank password to `None` so the write-only contract
/// treats `""`/whitespace as "keep the existing secret" rather than re-sealing an
/// empty credential. A non-empty value is passed through verbatim (NOT trimmed —
/// a password may legitimately contain leading/trailing spaces).
fn keep_existing_if_blank(value: Option<String>) -> Option<SecretString> {
    value
        .filter(|password| !password.trim().is_empty())
        .map(SecretString::from)
}

fn decode_attachment(
    dto: AttachmentDto,
) -> Result<mnt_comms_application::OutboundAttachment, RestError> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(dto.content_base64.trim())
        .map_err(|_| RestError::bad_request("attachment content is not valid base64"))?;
    Ok(mnt_comms_application::OutboundAttachment {
        filename: dto.filename,
        content_type: dto.content_type,
        bytes,
    })
}

// ---------------------------------------------------------------------------
// AuthZ + auth extraction
// ---------------------------------------------------------------------------

impl CommsRestState {
    /// Borrow the cipher or fail with a 503 when the master key is unconfigured.
    fn cipher_ref(&self) -> Result<&EnvelopeCredentialCipher, RestError> {
        self.cipher
            .as_deref()
            .ok_or_else(RestError::email_not_configured)
    }
}

fn authorize_feature(principal: &Principal, feature: Feature) -> Result<(), RestError> {
    authorize(
        principal,
        Action::new(feature),
        representative_branch(&principal.branch_scope)?,
    )
    .map_err(RestError::from_kernel)
}

/// Mail is an org-global feature (no per-branch resource); pick any in-scope
/// branch to satisfy the branch-scope check (SUPER_ADMIN/EXECUTIVE span all).
fn representative_branch(branch_scope: &BranchScope) -> Result<BranchId, RestError> {
    match branch_scope {
        BranchScope::All => Ok(BranchId::new()),
        BranchScope::Branches(branches) => branches.iter().next().copied().ok_or_else(|| {
            RestError::from_kernel(KernelError::forbidden(
                "principal has no branch scope for mail access",
            ))
        }),
    }
}

fn principal_from_headers(
    state: &CommsRestState,
    headers: &HeaderMap,
) -> Result<Principal, RestError> {
    let verifier = state.jwt_verifier.as_ref().ok_or_else(|| {
        RestError::unavailable("JWT verification is not configured for the mail API")
    })?;
    let token = bearer_token(headers)?;
    let claims = verifier
        .verify_access_token(token)
        .map_err(|_| RestError::unauthorized("invalid bearer token"))?;
    principal_from_claims(claims)
}

fn bearer_token(headers: &HeaderMap) -> Result<&str, RestError> {
    headers
        .get(header::AUTHORIZATION)
        .ok_or_else(|| RestError::unauthorized("missing bearer token"))?
        .to_str()
        .map_err(|_| RestError::unauthorized("invalid authorization header"))?
        .strip_prefix("Bearer ")
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| RestError::unauthorized("authorization header must use Bearer scheme"))
}

fn principal_from_claims(claims: AccessClaims) -> Result<Principal, RestError> {
    let user_id = UserId::from_str(&claims.sub)
        .map_err(|_| RestError::unauthorized("token subject is not a valid user id"))?;
    let org_id = mnt_kernel_core::OrgId::from_str(&claims.org)
        .map_err(|_| RestError::unauthorized("token org is not a valid id"))?;
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
    Ok(Principal::new(user_id, org_id, roles, branch_scope))
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

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

    /// The outbound rate limit was hit (per-org + per-user). A 429 with a fixed,
    /// non-secret message; the bucket code rides in the message.
    fn too_many_requests(code: &'static str) -> Self {
        Self::new(
            StatusCode::TOO_MANY_REQUESTS,
            "too_many_requests",
            format!("outbound mail rate limit exceeded ({code}); retry later"),
        )
    }

    fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", message)
    }

    /// The graceful missing-key surface: the master key is absent, so the email
    /// feature is unavailable. A clear, non-secret 503.
    fn email_not_configured() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "email_not_configured",
            "email is not configured on this server",
        )
    }

    fn from_kernel(error: KernelError) -> Self {
        match error.kind {
            ErrorKind::Validation => Self::validation(error.message),
            ErrorKind::Forbidden => Self::forbidden(error.message),
            ErrorKind::NotFound => Self::new(StatusCode::NOT_FOUND, "not_found", error.message),
            ErrorKind::Conflict | ErrorKind::InvalidTransition => {
                Self::new(StatusCode::CONFLICT, "conflict", error.message)
            }
            ErrorKind::Internal => Self::internal("internal server error"),
        }
    }

    fn from_service(error: MailServiceError) -> Self {
        match error {
            MailServiceError::Domain(kernel) => Self::from_kernel(kernel),
            MailServiceError::NotConfigured => {
                Self::validation("no mailbox is configured for this tenant")
            }
            // Transport failures carry a fixed, non-secret code; surface it as a
            // 422 so the caller can correct host/credentials without us leaking
            // the raw transport string.
            MailServiceError::Transport { code } => {
                Self::new(StatusCode::UNPROCESSABLE_ENTITY, "mail_transport", code)
            }
            // The per-org + per-user outbound rate limit tripped before any SMTP
            // call. A 429 so clients back off.
            MailServiceError::RateLimited { code } => Self::too_many_requests(code),
            // Store/cipher errors are server-internal: log nothing secret, return
            // a generic 500.
            other => {
                tracing::error!(kind = ?other.kind(), "mail service error");
                Self::internal("internal server error")
            }
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

#[cfg(test)]
mod tests {
    use super::keep_existing_if_blank;
    use secrecy::ExposeSecret;

    #[test]
    fn blank_password_keeps_existing_secret() {
        // L1: a present-but-empty/whitespace password must collapse to None so the
        // write-only contract treats `{"smtp_password":""}` as "keep the existing
        // secret", NOT "re-seal an empty credential".
        assert!(keep_existing_if_blank(None).is_none());
        assert!(keep_existing_if_blank(Some(String::new())).is_none());
        assert!(keep_existing_if_blank(Some("   ".to_owned())).is_none());
        assert!(keep_existing_if_blank(Some("\t\n ".to_owned())).is_none());
    }

    #[test]
    fn non_empty_password_is_passed_through_verbatim() {
        // A real password re-seals — and is NOT trimmed (a password may carry
        // significant leading/trailing whitespace).
        let sealed = keep_existing_if_blank(Some(" s3cret ".to_owned()))
            .expect("a non-blank password must seal");
        assert_eq!(sealed.expose_secret(), " s3cret ");
        let plain = keep_existing_if_blank(Some("hunter2".to_owned())).unwrap();
        assert_eq!(plain.expose_secret(), "hunter2");
    }
}
